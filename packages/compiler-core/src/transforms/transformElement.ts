import { NodeTransform, TransformContext } from '../transform'
import {
  NodeTypes,
  ElementTypes,
  CallExpression,
  ObjectExpression,
  ElementNode,
  DirectiveNode,
  ExpressionNode,
  ArrayExpression,
  createCallExpression,
  createArrayExpression,
  createObjectProperty,
  createSimpleExpression,
  createObjectExpression,
  Property,
  ComponentNode,
  VNodeCall,
  TemplateTextChildNode,
  DirectiveArguments,
  createVNodeCall,
  ConstantTypes
} from '../ast'
import {
  PatchFlags,
  PatchFlagNames,
  isSymbol,
  isOn,
  isObject,
  isReservedProp,
  capitalize,
  camelize,
  isBuiltInDirective
} from '@vue/shared'
import { createCompilerError, ErrorCodes } from '../errors'
import {
  RESOLVE_DIRECTIVE,
  RESOLVE_COMPONENT,
  RESOLVE_DYNAMIC_COMPONENT,
  MERGE_PROPS,
  NORMALIZE_CLASS,
  NORMALIZE_STYLE,
  NORMALIZE_PROPS,
  TO_HANDLERS,
  TELEPORT,
  KEEP_ALIVE,
  SUSPENSE,
  UNREF,
  GUARD_REACTIVE_PROPS
} from '../runtimeHelpers'
import {
  getInnerRange,
  toValidAssetId,
  findProp,
  isCoreComponent,
  isStaticArgOf,
  findDir,
  isStaticExp
} from '../utils'
import { buildSlots } from './vSlot'
import { getConstantType } from './hoistStatic'
import { BindingTypes } from '../options'
import {
  checkCompatEnabled,
  CompilerDeprecationTypes,
  isCompatEnabled
} from '../compat/compatConfig'

// some directive transforms (e.g. v-model) may return a symbol for runtime
// import, which should be used instead of a resolveDirective call.
const directiveImportMap = new WeakMap<DirectiveNode, symbol>()

// 转换元素 - 为这个元素的 codegen 生成一个 JavaScript AST
// generate a JavaScript AST for this element's codegen
export const transformElement: NodeTransform = (node, context) => {
  // 在处理和合并所有子表达式之后，执行exit操作。
  // perform the work on exit, after all child expressions have been
  // processed and merged.


  // 一上来就是返回一个退出函数
  return function postTransformElement() {
    node = context.currentNode!

    if (
      !(
        node.type === NodeTypes.ELEMENT &&
        (node.tagType === ElementTypes.ELEMENT ||
          node.tagType === ElementTypes.COMPONENT)
      )
    ) {
      return
    }
    // 节点类型首先为元素
    // 再者标签类型为元素或组件

    const { tag, props } = node
    // 节点标签类型是否为组件
    const isComponent = node.tagType === ElementTypes.COMPONENT

    // 转换的目标是创建实现VNodeCall接口的codegenNode。
    // The goal of the transform is to create a codegenNode implementing the
    // VNodeCall interface.
    // 虚拟节点标签
    let vnodeTag = isComponent
      ? resolveComponentType(node as ComponentNode, context) // 解析组件类型
      : `"${tag}"`

    // 是否为动态组件
    const isDynamicComponent =
      isObject(vnodeTag) && vnodeTag.callee === RESOLVE_DYNAMIC_COMPONENT // 返回的是一个RESOLVE_DYNAMIC_COMPONENT调用表达式节点

    let vnodeProps: VNodeCall['props']
    let vnodeChildren: VNodeCall['children']
    let vnodePatchFlag: VNodeCall['patchFlag']
    let patchFlag: number = 0
    let vnodeDynamicProps: VNodeCall['dynamicProps']
    let dynamicPropNames: string[] | undefined
    let vnodeDirectives: VNodeCall['directives']

    // 是否应该使用block
    let shouldUseBlock =
      // dynamic component may resolve to plain elements
      isDynamicComponent || // 是动态组件
      vnodeTag === TELEPORT || // TELEPORT
      vnodeTag === SUSPENSE || // SUSPENSE
      (!isComponent && // 不是组件且标签是svg或foreignObject
        // <svg> and <foreignObject> must be forced into blocks so that block
        // updates inside get proper isSVG flag at runtime. (#639, #643)
        // This is technically web-specific, but splitting the logic out of core
        // leads to too much unnecessary complexity.
        (tag === 'svg' || tag === 'foreignObject'))

    // props
    if (props.length > 0) {
      const propsBuildResult = buildProps( // 构建属性
        node,
        context,
        undefined,
        isComponent,
        isDynamicComponent
      )
      vnodeProps = propsBuildResult.props // 属性
      patchFlag = propsBuildResult.patchFlag // 比对标记
      dynamicPropNames = propsBuildResult.dynamicPropNames // 动态属性名
      // +++
      // 构建属性时产出的指令
      // +++
      const directives = propsBuildResult.directives // 指令
      
      // +++
      // 这里可以说是构建运行时指令执行时的参数逻辑所在地
      // +++

      // +++
      // input就需要有vModelText运行时指令 // +++
      
      vnodeDirectives =
        directives && directives.length // +++有指令的话统一在这里进行构建指令的参数+++
          ? (createArrayExpression( // 创建数组表达式
              directives.map(dir => buildDirectiveArgs(dir, context)) // 构建指令参数
              // +++
              // 构建运行时指令所需要执行时的参数
              // +++
            ) as DirectiveArguments)
          : undefined

      if (propsBuildResult.shouldUseBlock) { // 根据属性构建结果映射是否应该使用block
        shouldUseBlock = true
      }
    }

    // children
    if (node.children.length > 0) {
      if (vnodeTag === KEEP_ALIVE) { // KEEP_ALIVE

        // Although a built-in component, we compile KeepAlive with raw children
        // instead of slot functions so that it can be used inside Transition
        // or other Transition-wrapping HOCs.
        // To ensure correct updates with block optimizations, we need to:
        // 1. Force keep-alive into a block. This avoids its children being
        //    collected by a parent block.

        shouldUseBlock = true // 标记

        // 强制keep-alive总是更新，因为它使用原生的孩子
        // 2. Force keep-alive to always be updated, since it uses raw children.

        // ***
        patchFlag |= PatchFlags.DYNAMIC_SLOTS // 比对标记再加上动态插槽
        
        if (__DEV__ && node.children.length > 1) {
          context.onError(
            createCompilerError(ErrorCodes.X_KEEP_ALIVE_INVALID_CHILDREN, {
              start: node.children[0].loc.start,
              end: node.children[node.children.length - 1].loc.end,
              source: ''
            })
          )
        }
      }

      // +++
      // 我们写的组件都是要作为插槽构建的
      // +++
      // 是否应该作为插槽构建
      const shouldBuildAsSlots =
        isComponent && // 是否为组件
        // Teleport 不是真正的组件，并且具有专用的运行时处理
        // Teleport is not a real component and has dedicated runtime handling
        vnodeTag !== TELEPORT &&
        // 上面解释过。
        // explained above.
        vnodeTag !== KEEP_ALIVE

      // 是否应该作为插槽构建
      if (shouldBuildAsSlots) {
        // 插槽 是否有动态插槽
        // vSlot.ts中的buildSlots函数
        const { slots, hasDynamicSlots } = buildSlots(node, context) // 构建插槽 // +++
        // 构建插槽 // +++
        // <template #header="xxx"></template>
        // -> { header: function (xxx) { return  } } - 这个对象直接作为创建组件vnode调用表达式的children参数 // +++

        // +++
        // 虚拟节点的孩子直接是这个slots - 他有可能是对象 或者 是一个createSlots【运行时函数】【调用（参数一个是对象，一个是数组）表达式节点】
        vnodeChildren = slots
        
        // +++
        // ++++++++
        // +++那么直接是虚拟节点孩子 - 那么直接是生成render函数中对应Foo组件createVnode函数的children参数（可能得到是一个对象或者是createSlots函数执行的返回值）+++
        // ++++++

        if (hasDynamicSlots) {
          // 比对标记
          patchFlag |= PatchFlags.DYNAMIC_SLOTS // 标记动态插槽
        }
      } else if (node.children.length === 1 && vnodeTag !== TELEPORT) { // 只有一个孩子 且 虚拟节点标签不是TELEPORT
        const child = node.children[0]
        const type = child.type
        // 检查动态文本孩子
        // check for dynamic text children
        const hasDynamicTextChild =
          type === NodeTypes.INTERPOLATION || // 插值
          type === NodeTypes.COMPOUND_EXPRESSION // 混合表达式
        if (
          hasDynamicTextChild &&
          getConstantType(child, context) === ConstantTypes.NOT_CONSTANT // 不是常量
        ) {
          patchFlag |= PatchFlags.TEXT // 比对标记文本
        }
        // 如果只有一个孩子是文本节点则直接通过
        // pass directly if the only child is a text node
        // 纯 / 插值 / 表达式
        // (plain / interpolation / expression)
        if (hasDynamicTextChild || type === NodeTypes.TEXT) { // 有动态文本孩子 或 文本类型节点
          vnodeChildren = child as TemplateTextChildNode
        } else {
          vnodeChildren = node.children
        }
      } else {
        vnodeChildren = node.children
      }
    }

    // 有比对标记 且 动态属性名
    // patchFlag & dynamicPropNames
    if (patchFlag !== 0) {
      if (__DEV__) {
        if (patchFlag < 0) {
          // 特殊标志（否定和互斥）
          // special flags (negative and mutually exclusive)
          vnodePatchFlag = patchFlag + ` /* ${PatchFlagNames[patchFlag]} */`
        } else {
          // 按位标志
          // bitwise flags
          const flagNames = Object.keys(PatchFlagNames)
            .map(Number)
            .filter(n => n > 0 && patchFlag & n)
            .map(n => PatchFlagNames[n])
            .join(`, `)
          vnodePatchFlag = patchFlag + ` /* ${flagNames} */`
        }
      } else {
        vnodePatchFlag = String(patchFlag) // 字符串化
      }
      if (dynamicPropNames && dynamicPropNames.length) {
        vnodeDynamicProps = stringifyDynamicPropNames(dynamicPropNames) // 字符串化动态属性名
      }
    }

    // 创建虚拟节点调用节点
    node.codegenNode = createVNodeCall(
      context,
      vnodeTag,
      vnodeProps,
      vnodeChildren,
      vnodePatchFlag,
      vnodeDynamicProps,
      vnodeDirectives,
      // ++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++
      /* 
      isBlock - 决定是否openBlock、确定是哪一个createXxx运行时函数
      disableTracking - 决定openBlock函数的参数是true还是不传
      isComponent - 决定是哪一个createXxx运行时函数

      不管是哪一个createXxx运行时函数，最终生成的vnode调用表达式字符串中传入的参数都是tag, props, children, patchFlag, dynamicProps - 可以在codegen.ts中的genVNodeCall中去查看
      */
      // ++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++
      !!shouldUseBlock, // 是否block - 依据shouldUseBlock // ++++++++++++++++++++++++++++
      false /* disableTracking */, // ++++++++++++++++++++++++++++++++++++++++
      isComponent, // +++++++++++++++++++++++++++++++++++++++++++
      // +++++++++++++++++++++++++++++++++++++
      node.loc
    )
  }
}

// 解析组件类型
export function resolveComponentType(
  node: ComponentNode,
  context: TransformContext,
  ssr = false
) {
  let { tag } = node // 取出当前节点的标签
  

  // 动态组件
  // 1. dynamic component
  // 是显示的动态 - <Component :is>
  const isExplicitDynamic = isComponentTag(tag) // tag === 'component' || tag === 'Component'
  const isProp = findProp(node, 'is') // 查找这个is属性
  if (isProp) {
    if (
      isExplicitDynamic ||
      (__COMPAT__ &&
        isCompatEnabled( // 兼容是否开启
          CompilerDeprecationTypes.COMPILER_IS_ON_ELEMENT,
          context
        ))
    ) {
      const exp =
        isProp.type === NodeTypes.ATTRIBUTE // 普通属性
          ? isProp.value && createSimpleExpression(isProp.value.content, true) // 创建简单表达式节点
          // 指令属性直接取出exp即可
          : isProp.exp
      if (exp) {
        // 创建RESOLVE_DYNAMIC_COMPONENT调用表达式节点
        return createCallExpression(context.helper(RESOLVE_DYNAMIC_COMPONENT), [
          exp
        ])
      }
    } else if (
      // 是普通属性 且 值是以vue:开头的
      isProp.type === NodeTypes.ATTRIBUTE &&
      isProp.value!.content.startsWith('vue:')
    ) {
      // <button is="vue:xxx">
      // if not <component>, only is value that starts with "vue:" will be
      // treated as component by the parse phase and reach here, unless it's
      // compat mode where all is values are considered components
      tag = isProp.value!.content.slice(4)
    }
  }

  // v-is 已废弃的
  // 1.5 v-is (TODO: Deprecate)
  const isDir = !isExplicitDynamic && findDir(node, 'is')
  if (isDir && isDir.exp) {
    return createCallExpression(context.helper(RESOLVE_DYNAMIC_COMPONENT), [
      isDir.exp
    ])
  }

  // 诸如内置组件 (Teleport, Transition, KeepAlive, Suspense...)
  // 2. built-in components (Teleport, Transition, KeepAlive, Suspense...)
  const builtIn = isCoreComponent(tag) || context.isBuiltInComponent(tag)
  if (builtIn) {
    // 内置只是在SSR期间的跌落/有特殊处理，所以我们不需要导入它们的运行时等等物
    // built-ins are simply fallthroughs / have special handling during ssr
    // so we don't need to import their runtime equivalents

    if (!ssr) context.helper(builtIn) // 搞一个对应的助手
    return builtIn
    // 这里直接返回
  }

  // 用户组件（来自setup绑定）
  // 3. user component (from setup bindings)
  // 这在浏览器构建中被跳过，因为浏览器构建不执行绑定分析。
  // this is skipped in browser build since browser builds do not perform
  // binding analysis.
  if (!__BROWSER__) {
    const fromSetup = resolveSetupReference(tag, context) // 解析setup引用
    if (fromSetup) { // 是来自setup的直接返回
      return fromSetup // 返回
    }
    const dotIndex = tag.indexOf('.') // 标签名中是否有.
    if (dotIndex > 0) {
      const ns = resolveSetupReference(tag.slice(0, dotIndex), context) // 解析setup引用
      if (ns) {
        return ns + tag.slice(dotIndex)
      }
    }
  }

  // 自身引用组件（从文件名推断）
  // 4. Self referencing component (inferred from filename)
  if (
    !__BROWSER__ &&
    context.selfName && // 自身文件名
    capitalize(camelize(tag)) === context.selfName // 驼峰化 -> 大写化
  ) {
    context.helper(RESOLVE_COMPONENT) // 添加助手

    // codegen.ts has special check for __self postfix when generating
    // component imports, which will pass additional `maybeSelfReference` flag
    // to `resolveComponent`.
    context.components.add(tag + `__self`) // 给上下文组件中添加
    return toValidAssetId(tag, `component`) // 转为有效的资源id
  }

  // 用户组件（解析）
  // 5. user component (resolve)
  context.helper(RESOLVE_COMPONENT) // 添加助手
  context.components.add(tag) // 增加到上下文中
  return toValidAssetId(tag, `component`) // 转为有效的资源id
}

// 解析setup引用
function resolveSetupReference(name: string, context: TransformContext) {
  // 上下文中的构建元数据
  const bindings = context.bindingMetadata
  if (!bindings || bindings.__isScriptSetup === false) {
    return
  }

  const camelName = camelize(name) // 驼峰化
  const PascalName = capitalize(camelName) // 大写化
  const checkType = (type: BindingTypes) => {
    if (bindings[name] === type) {
      return name
    }
    if (bindings[camelName] === type) {
      return camelName
    }
    if (bindings[PascalName] === type) {
      return PascalName
    }
  }

  // 来自常量
  const fromConst =
    checkType(BindingTypes.SETUP_CONST) ||
    checkType(BindingTypes.SETUP_REACTIVE_CONST)
  if (fromConst) {
    return context.inline
      ? // in inline mode, const setup bindings (e.g. imports) can be used as-is
        // 在内联模式中常量setup绑定例如导入可以被使用as-is
        fromConst
      : `$setup[${JSON.stringify(fromConst)}]`
  }

  // 来自可能ref
  const fromMaybeRef =
    checkType(BindingTypes.SETUP_LET) ||
    checkType(BindingTypes.SETUP_REF) ||
    checkType(BindingTypes.SETUP_MAYBE_REF)
  if (fromMaybeRef) {
    return context.inline
      ? // setup scope bindings that may be refs need to be unrefed
        // setup作用域绑定对于ref需要unref
        `${context.helperString(UNREF)}(${fromMaybeRef})` // 拿到unref助手
      : `$setup[${JSON.stringify(fromMaybeRef)}]`
  }
}

export type PropsExpression = ObjectExpression | CallExpression | ExpressionNode

// 构建属性
export function buildProps(
  node: ElementNode,
  context: TransformContext,
  props: ElementNode['props'] = node.props,
  isComponent: boolean,
  isDynamicComponent: boolean,
  ssr = false
): {
  props: PropsExpression | undefined
  directives: DirectiveNode[]
  patchFlag: number
  dynamicPropNames: string[]
  shouldUseBlock: boolean
} {
  const { tag, loc: elementLoc, children } = node
  let properties: ObjectExpression['properties'] = [] // 属性
  const mergeArgs: PropsExpression[] = [] // 合并参数
  const runtimeDirectives: DirectiveNode[] = [] // 运行时指令
  const hasChildren = children.length > 0 // 是否有孩子
  let shouldUseBlock = false // 应该使用块

  // 比对标记分析
  // patchFlag analysis
  let patchFlag = 0 // 比对标记
  let hasRef = false // 是否有ref
  let hasClassBinding = false // 是否有类绑定
  let hasStyleBinding = false // 是否有style绑定
  let hasHydrationEventBinding = false // 是否有混合事件绑定
  let hasDynamicKeys = false // 是否有动态的key
  let hasVnodeHook = false // 是否有虚拟节点钩子
  const dynamicPropNames: string[] = [] // 动态属性名

  // 推入合并参数
  const pushMergeArg = (arg?: PropsExpression) => {
    if (properties.length) {
      // 合并参数中推入对象表达式节点
      mergeArgs.push(
        // dedupe: 重复数据删除
        createObjectExpression(dedupeProperties(properties), elementLoc)
      )
      properties = [] // 置空
    }
    if (arg) mergeArgs.push(arg) // 也是推入
  }

  // 分析比对标记
  const analyzePatchFlag = ({ key, value }: Property) => {

    // :foo="foo"那么这个foo一定是静态的
    // :[xxx]="x" -> xxx是动态的

    // +++ // 注意是key
    // key是否为静态表达式，而不是value（注意啦！）
    // +++

    if (isStaticExp(key)) {
      const name = key.content
      // /^on[^a-z]/.test(name)
      const isEventHandler = isOn(name) // 是事件处理者
      if (
        isEventHandler &&
        (!isComponent || isDynamicComponent) &&
        // 省略click处理程序的标志，因为混合作用提供了click专用快速路径。
        // omit the flag for click handlers because hydration gives click
        // dedicated fast path.
        name.toLowerCase() !== 'onclick' &&
        // 省略 v-model 处理程序
        // omit v-model handlers
        name !== 'onUpdate:modelValue' &&
        // 省略onVnodeXXX钩子函数
        // omit onVnodeXXX hooks
        !isReservedProp(name)
      ) {
        hasHydrationEventBinding = true // 有混合事件绑定
      }

      if (isEventHandler && isReservedProp(name)) {
        hasVnodeHook = true // 有Vnode钩子函数
      }

      if (
        value.type === NodeTypes.JS_CACHE_EXPRESSION || // js缓存表达式类型的节点
        ((value.type === NodeTypes.SIMPLE_EXPRESSION ||
          value.type === NodeTypes.COMPOUND_EXPRESSION) &&
          getConstantType(value, context) > 0)
      ) {
        
        // +++
        // +++
        // 如果 prop 是缓存的处理程序或具有常量值，则跳过
        // skip if the prop is a cached handler or has constant value
        return
        // +++ // 例如vModel中处理后的onUpdate:modelValue -> 它走到这里就是一个缓存表达式节点
        // 所以在这里就直接返回了return
        // +++
      
      }

      if (name === 'ref') {
        hasRef = true // 有ref
      } else if (name === 'class') {
        hasClassBinding = true // 有类绑定
      } else if (name === 'style') {
        hasStyleBinding = true // 有style绑定
      } else if (name !== 'key' && !dynamicPropNames.includes(name)) {
        dynamicPropNames.push(name) // 收集除了key之外的动态属性名
        // :foo="foo"
      }

      // 将组件的动态类和样式绑定视为动态props
      // treat the dynamic class and style binding of the component as dynamic props
      if (
        isComponent &&
        (name === 'class' || name === 'style') &&
        !dynamicPropNames.includes(name)
      ) {
        dynamicPropNames.push(name) // 组件也是推入
      }
    } else {

      // +++
      // 那说明有动态key
      hasDynamicKeys = true

      // +++
    }
  }

  // 遍历属性
  for (let i = 0; i < props.length; i++) {
    // 静态属性
    // static attribute
    const prop = props[i]
    if (prop.type === NodeTypes.ATTRIBUTE) {
      const { loc, name, value } = prop
      let isStatic = true
      // ref属性
      if (name === 'ref') {
        hasRef = true // 标记有ref
        if (context.scopes.vFor > 0) { // 上下文作用域是否有v-for指令
          properties.push(
            createObjectProperty( // 创建对象属性
              createSimpleExpression('ref_for', true), // ref_for
              createSimpleExpression('true')
            )
          )
        }
        // 在内联模式下，没有setupState对象，因此我们不能使用字符串key来设置ref。相反，我们需要转换它来传递实际的ref。
        // in inline mode there is no setupState object, so we can't use string
        // keys to set the ref. Instead, we need to transform it to pass the
        // actual ref instead.
        if (
          !__BROWSER__ &&
          value &&
          context.inline &&
          context.bindingMetadata[value.content] // 绑定元数据中取
        ) {
          isStatic = false // 不是静态的
          properties.push(
            createObjectProperty(
              createSimpleExpression('ref_key', true), // ref_key
              createSimpleExpression(value.content, true, value.loc)
            )
          )
        }
      }
      // 跳过在<component>上的is或is="vue:xxx"
      // skip is on <component>, or is="vue:xxx"
      if (
        name === 'is' && // is属性
        (isComponentTag(tag) || // 是组件标签
          (value && value.content.startsWith('vue:')) || // 值是以vue:开始的
          (__COMPAT__ && // 是否兼容
            isCompatEnabled(
              CompilerDeprecationTypes.COMPILER_IS_ON_ELEMENT,
              context
            )))
      ) {
        // 跳过
        continue
      }
      properties.push(
        createObjectProperty( // 创建对象属性
          createSimpleExpression( // 创建简单表达式
            name,
            true,
            getInnerRange(loc, 0, name.length)
          ),
          createSimpleExpression(
            value ? value.content : '',
            isStatic,
            value ? value.loc : loc
          )
        )
      )
    } else {
      // 指令
      // directives
      const { name, arg, exp, loc } = prop
      const isVBind = name === 'bind' // 是bind指令
      const isVOn = name === 'on' // 是on指令

      // 跳过v-slot - 它是通过它的专用转换来去处理的
      // skip v-slot - it is handled by its dedicated transform.
      if (name === 'slot') {
        if (!isComponent) { // v-slot用在不是组件上直接报错
          context.onError(
            createCompilerError(ErrorCodes.X_V_SLOT_MISPLACED, loc)
          )
        }
        continue
      }
      // 跳过v-once/v-memo
      // skip v-once/v-memo - they are handled by dedicated transforms.
      if (name === 'once' || name === 'memo') {
        continue
      }
      // 跳过在<component>上的v-is 和 :is
      // skip v-is and :is on <component>
      if (
        name === 'is' ||
        (isVBind &&
          isStaticArgOf(arg, 'is') &&
          (isComponentTag(tag) ||
            (__COMPAT__ &&
              isCompatEnabled(
                CompilerDeprecationTypes.COMPILER_IS_ON_ELEMENT,
                context
              ))))
      ) {
        continue
      }
      // 在ssr编译中跳过v-on
      // skip v-on in SSR compilation
      if (isVOn && ssr) {
        continue
      }

      if (
        // 应将具有动态key的元素强制放入块中
        // #938: elements with dynamic keys should be forced into blocks
        (isVBind && isStaticArgOf(arg, 'key')) || // :key
        // 内联before-update钩子需要强制块，以便在子元素之前调用它
        // inline before-update hooks need to force block so that it is invoked
        // before children
        (isVOn && hasChildren && isStaticArgOf(arg, 'vue:before-update')) // @before-update且有孩子且参数为vue:before-update
      ) {
        // 标记应该使用block
        shouldUseBlock = true
      }

      // :ref 且 context.scopes中有使用v-for
      if (isVBind && isStaticArgOf(arg, 'ref') && context.scopes.vFor > 0) {
        properties.push(
          createObjectProperty(
            createSimpleExpression('ref_for', true),
            createSimpleExpression('true')
          )
        )
      }

      // +++
      // 不带参数的 v-bind 和 v-on 的特殊情况
      // +++
      // special case for v-bind and v-on with no argument
      if (!arg && (isVBind || isVOn)) {
        // 有动态的keys
        hasDynamicKeys = true
        if (exp) {
          /* 
          https://vuejs.org/api/built-in-directives.html#v-bind
          <!-- binding an object of attributes -->
          <div v-bind="{ id: someProp, 'other-attr': otherProp }"></div>
          */

          if (isVBind) {
            // 必须尽早合并以进行兼容构建检查
            // have to merge early for compat build check
            pushMergeArg() // 推入合并参数
            if (__COMPAT__) {
              // 2.x v-bind object order compat
              if (__DEV__) {
                const hasOverridableKeys = mergeArgs.some(arg => {
                  if (arg.type === NodeTypes.JS_OBJECT_EXPRESSION) {
                    return arg.properties.some(({ key }) => {
                      if (
                        key.type !== NodeTypes.SIMPLE_EXPRESSION ||
                        !key.isStatic
                      ) {
                        return true
                      }
                      return (
                        key.content !== 'class' &&
                        key.content !== 'style' &&
                        !isOn(key.content)
                      )
                    })
                  } else {
                    // dynamic expression
                    return true
                  }
                })
                if (hasOverridableKeys) {
                  checkCompatEnabled(
                    CompilerDeprecationTypes.COMPILER_V_BIND_OBJECT_ORDER,
                    context,
                    loc
                  )
                }
              }

              if (
                isCompatEnabled(
                  CompilerDeprecationTypes.COMPILER_V_BIND_OBJECT_ORDER,
                  context
                )
              ) {
                mergeArgs.unshift(exp)
                continue
              }
            }

            mergeArgs.push(exp) // 合并参数中推入这个exp
          } else {
            /* 
            https://vuejs.org/api/built-in-directives.html#v-on
            <!-- object syntax -->
            <button v-on="{ mousedown: doThis, mouseup: doThat }"></button>
            */

            // v-on="obj" -> toHandlers(obj)
            pushMergeArg({
              type: NodeTypes.JS_CALL_EXPRESSION, // js调用表达式节点
              loc,
              callee: context.helper(TO_HANDLERS),
              arguments: isComponent ? [exp] : [exp, `true`]
            })
          }
        } else {
          context.onError(
            createCompilerError(
              isVBind
                ? ErrorCodes.X_V_BIND_NO_EXPRESSION
                : ErrorCodes.X_V_ON_NO_EXPRESSION,
              loc
            )
          )
        }
        continue
      }

      // 取出上下文中指令转换对象
      const directiveTransform = context.directiveTransforms[name] // 依据指令的名字取出对应的指令转换函数
      if (directiveTransform) {
        // 有内置指令转换
        // has built-in directive transform.

        
        // ***---+++
        const { props, needRuntime } = directiveTransform(prop, node, context) // 执行对应的转换函数
        // ***---+++


        !ssr && props.forEach(analyzePatchFlag) // +++分析比对标记+++

        // @[xxx]
        if (isVOn && arg && !isStaticExp(arg)) {
          pushMergeArg(createObjectExpression(props, elementLoc))
        } else {
          // 其它的
          properties.push(...props)
        }
        // 是否需要运行时
        if (needRuntime) {
          // 运行时指令推入这个prop
          runtimeDirectives.push(prop)

          // @vue/compiler-dom下的vModel返回的就是一个symbol
          // +++
          // 是symbol类型
          // +++
          
          if (isSymbol(needRuntime)) {
            // +++
            directiveImportMap.set(prop, needRuntime) // 指令导入图以prop为key，needRuntime为值
            // +++
          }
        }
      } else if (!isBuiltInDirective(name)) { // 不是内置指令
        // 没有内置转换，这是一个用户自定义指令。
        // no built-in transform, this is a user custom directive.
        runtimeDirectives.push(prop) // 那就运行时指令中推入这个指令
        // custom dirs may use beforeUpdate so they need to force blocks
        // to ensure before-update gets called before children update
        // 自定义dirs可能会使用beforeUpdate，因此它们需要强制块来确保在子更新之前调用before-update
        // 有孩子也要标记为块
        if (hasChildren) {
          shouldUseBlock = true
        }
      }
    }
  }

  let propsExpression: PropsExpression | undefined = undefined

  // +++
  // 有v-bind="object" or v-on="object"，用 mergeProps 包装
  // has v-bind="object" or v-on="object", wrap with mergeProps
  // +++
  if (mergeArgs.length) {
    // 关闭任何尚未合并的道具
    // close up any not-yet-merged props
    pushMergeArg()
    if (mergeArgs.length > 1) {
      propsExpression = createCallExpression( // 创建MERGE_PROPS调用表达式节点
        context.helper(MERGE_PROPS), // callee
        mergeArgs, // 合并参数作为参数
        elementLoc
      )
    } else {
      // 单一的 v-bind 没有别的 - 不需要 mergeProps 调用
      // single v-bind with nothing else - no need for a mergeProps call
      propsExpression = mergeArgs[0]
    }
  } else if (properties.length) {
    propsExpression = createObjectExpression( // 对象表达式
      // dedupe: 重复数据删除
      dedupeProperties(properties),
      elementLoc
    )
  }

  // 比对标记分析
  // patchFlag analysis
  if (hasDynamicKeys) {
    patchFlag |= PatchFlags.FULL_PROPS // 全属性比对标记
  } else {
    // 类绑定
    if (hasClassBinding && !isComponent) {
      patchFlag |= PatchFlags.CLASS // 比对class
    }
    // 样式绑定
    if (hasStyleBinding && !isComponent) {
      patchFlag |= PatchFlags.STYLE // 比对style
    }

    // +++
    // |或就是相当于增加这样的标记
    // +++
    
    // +++
    // 动态属性名
    // +++
    if (dynamicPropNames.length) {
      patchFlag |= PatchFlags.PROPS // 属性
    }
    if (hasHydrationEventBinding) {
      patchFlag |= PatchFlags.HYDRATE_EVENTS // 比对混合事件
    }
  }
  if (
    !shouldUseBlock && // !false
    (patchFlag === 0 /** true */ || patchFlag === PatchFlags.HYDRATE_EVENTS) &&
    (hasRef || hasVnodeHook || runtimeDirectives.length > 0 /** input等元素节点是需要运行时指令的，这里为true */)
  ) {
    // +++
    patchFlag |= PatchFlags.NEED_PATCH // NEED_PATCH的比对标记 // +++
    // +++
  }

  // 预序列化属性，ssr是跳过的
  // pre-normalize props, SSR is skipped for now
  if (!context.inSSR && propsExpression) {
    switch (propsExpression.type) {
      case NodeTypes.JS_OBJECT_EXPRESSION:
        // 意味着没有v-bind
        // 但仍然需要处理动态key绑定
        // means that there is no v-bind,
        // but still need to deal with dynamic key binding
        let classKeyIndex = -1
        let styleKeyIndex = -1
        let hasDynamicKey = false


        // 找类属性、样式属性的下标
        for (let i = 0; i < propsExpression.properties.length; i++) {
          const key = propsExpression.properties[i].key
          if (isStaticExp(key)) {
            if (key.content === 'class') {
              classKeyIndex = i
            } else if (key.content === 'style') {
              styleKeyIndex = i
            }
          } else if (!key.isHandlerKey) { // key没有isHandlerKey属性
            hasDynamicKey = true // 标记有动态key
          }
        }

        const classProp = propsExpression.properties[classKeyIndex]
        const styleProp = propsExpression.properties[styleKeyIndex]

        // 没有动态的key
        // no dynamic key
        if (!hasDynamicKey) {
          if (classProp && !isStaticExp(classProp.value)) {
            classProp.value = createCallExpression( // 创建NORMALIZE_CLASS调用表达式
              context.helper(NORMALIZE_CLASS),
              [classProp.value]
            )
          }
          if (
            styleProp &&
            // the static style is compiled into an object,
            // so use `hasStyleBinding` to ensure that it is a dynamic style binding
            (hasStyleBinding ||
              (styleProp.value.type === NodeTypes.SIMPLE_EXPRESSION &&
                styleProp.value.content.trim()[0] === `[`) ||
              // v-bind:style and style both exist,
              // v-bind:style with static literal object
              styleProp.value.type === NodeTypes.JS_ARRAY_EXPRESSION)
          ) {
            styleProp.value = createCallExpression( // 创建NORMALIZE_STYLE调用表达式
              context.helper(NORMALIZE_STYLE),
              [styleProp.value]
            )
          }
        } else {
          // dynamic key binding, wrap with `normalizeProps`
          propsExpression = createCallExpression( // 创建NORMALIZE_PROPS调用表达式
            context.helper(NORMALIZE_PROPS),
            [propsExpression]
          )
        }
        break
      case NodeTypes.JS_CALL_EXPRESSION:
        // mergeProps 调用，什么都不做
        // mergeProps call, do nothing
        break
      default:
        // 单个v-bind
        // single v-bind
        propsExpression = createCallExpression( // 创建NORMALIZE_PROPS调用表达式
          context.helper(NORMALIZE_PROPS),
          [
            createCallExpression(context.helper(GUARD_REACTIVE_PROPS), [ // 创建GUARD_REACTIVE_PROPS调用表达式
              propsExpression
            ])
          ]
        )
        break
    }
  }

  // 构建属性返回的肯定是和属性有关的 - 诸如属性、指令、比对标记、动态属性名、使用block
  return {
    props: propsExpression, // 属性
    directives: runtimeDirectives, // 指令
    patchFlag, // 比对标记
    dynamicPropNames, // 动态属性名
    shouldUseBlock // 是否应该使用block
  }
}

// Dedupe props in an object literal.
// Literal duplicated attributes would have been warned during the parse phase,
// however, it's possible to encounter duplicated `onXXX` handlers with different
// modifiers. We also need to merge static and dynamic class / style attributes.
// - onXXX handlers / style: merge into array
// - class: merge into single expression with concatenation
function dedupeProperties(properties: Property[]): Property[] {
  const knownProps: Map<string, Property> = new Map()
  const deduped: Property[] = []
  for (let i = 0; i < properties.length; i++) {
    const prop = properties[i]
    // dynamic keys are always allowed
    if (prop.key.type === NodeTypes.COMPOUND_EXPRESSION || !prop.key.isStatic) {
      deduped.push(prop)
      continue
    }
    const name = prop.key.content
    const existing = knownProps.get(name)
    if (existing) {
      if (name === 'style' || name === 'class' || isOn(name)) {
        mergeAsArray(existing, prop)
      }
      // unexpected duplicate, should have emitted error during parse
    } else {
      knownProps.set(name, prop)
      deduped.push(prop)
    }
  }
  return deduped
}

function mergeAsArray(existing: Property, incoming: Property) {
  if (existing.value.type === NodeTypes.JS_ARRAY_EXPRESSION) {
    existing.value.elements.push(incoming.value)
  } else {
    existing.value = createArrayExpression(
      [existing.value, incoming.value],
      existing.loc
    )
  }
}

// +++
// 构建指令参数 - 这一步是在上面的退出函数中做的
// +++
export function buildDirectiveArgs(
  dir: DirectiveNode,
  context: TransformContext
): ArrayExpression {
  // 指令参数
  const dirArgs: ArrayExpression['elements'] = []
  // 运行时
  const runtime = directiveImportMap.get(dir) // 指令对应的运行时

  // +++
  if (runtime) {

    // +++
    // 带有运行时的内置指令
    // built-in directive with runtime
    dirArgs.push(context.helperString(runtime)) // +++ 运行时指令的参数就是在这里准备的 +++
    // +++
    // 运行时作为指令的第一个参数

    // +++
  } else {
    // 用户指令
    // user directive.
    // 看看我们是否有通过 <script setup> 暴露的指令
    // see if we have directives exposed via <script setup>
    const fromSetup =
      !__BROWSER__ && resolveSetupReference('v-' + dir.name, context) // 解析setup引用
    if (fromSetup) { // 来自setup
      dirArgs.push(fromSetup)
    } else {
      // 注入解析指令的语句
      // inject statement for resolving directive
      context.helper(RESOLVE_DIRECTIVE) // 添加RESOLVE_DIRECTIVE助手
      context.directives.add(dir.name) // 增加到上下文
      dirArgs.push(toValidAssetId(dir.name, `directive`)) // 转为有效的资源id
    }
  }

  const { loc } = dir
  
  // +++
  // 同时这里指令参数中还推入指令的表达式
  if (dir.exp) dirArgs.push(dir.exp) // exp
  // +++
  // +++

  // +++
  // 下面也是对指令参数的其它额外的处理
  // +++

  if (dir.arg) { // 有参数
    if (!dir.exp) { // 没有exp
      dirArgs.push(`void 0`)
    }
    dirArgs.push(dir.arg) // 推入参数
  }
  // 是否有指令修饰符
  if (Object.keys(dir.modifiers).length) {
    if (!dir.arg) { // 没参数
      if (!dir.exp) { // 没有表达式
        dirArgs.push(`void 0`)
      }
      dirArgs.push(`void 0`)
    }
    // 创建一个true表达式
    const trueExpression = createSimpleExpression(`true`, false, loc)
    dirArgs.push(
      // 创建对象表达式
      createObjectExpression(
        dir.modifiers.map(modifier =>
          createObjectProperty(modifier, trueExpression) // 创建对象属性
        ),
        loc
      )
    )
  }
  // +++
  // 创建+++数组表达式+++节点
  // +++
  return createArrayExpression(dirArgs, dir.loc)
}

function stringifyDynamicPropNames(props: string[]): string {
  let propsNamesString = `[`
  for (let i = 0, l = props.length; i < l; i++) {
    propsNamesString += JSON.stringify(props[i])
    if (i < l - 1) propsNamesString += ', '
  }
  return propsNamesString + `]`
}

// 是Component标签
function isComponentTag(tag: string) {
  return tag === 'component' || tag === 'Component'
}
