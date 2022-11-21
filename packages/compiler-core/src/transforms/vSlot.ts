import {
  ElementNode,
  ObjectExpression,
  createObjectExpression,
  NodeTypes,
  createObjectProperty,
  createSimpleExpression,
  createFunctionExpression,
  DirectiveNode,
  ElementTypes,
  ExpressionNode,
  Property,
  TemplateChildNode,
  SourceLocation,
  createConditionalExpression,
  ConditionalExpression,
  SimpleExpressionNode,
  FunctionExpression,
  CallExpression,
  createCallExpression,
  createArrayExpression,
  SlotsExpression
} from '../ast'
import { TransformContext, NodeTransform } from '../transform'
import { createCompilerError, ErrorCodes } from '../errors'
import {
  findDir,
  isTemplateNode,
  assert,
  isVSlot,
  hasScopeRef,
  isStaticExp
} from '../utils'
import { CREATE_SLOTS, RENDER_LIST, WITH_CTX } from '../runtimeHelpers'
import { parseForExpression, createForLoopParams } from './vFor'
import { SlotFlags, slotFlagsText } from '@vue/shared'

const defaultFallback = createSimpleExpression(`undefined`, false)

/* 
一个NodeTransform:
1. 跟踪作用域槽的作用域标识符，以免它们被transformExpression作为前缀。这只应用于带有{prefixIdentifiers: true}的非浏览器版本。
2. 跟踪v-slot深度，以便我们知道一个插槽位于另一个插槽中。
注意，退出回调是在相同节点上的buildSlots()之前执行的，因此只有嵌套槽看到正数。
*/
// A NodeTransform that:
// 1. Tracks scope identifiers for scoped slots so that they don't get prefixed
//    by transformExpression. This is only applied in non-browser builds with
//    { prefixIdentifiers: true }.
// 2. Track v-slot depths so that we know a slot is inside another slot.
//    Note the exit callback is executed before buildSlots() on the same node,
//    so only nested slots see positive numbers.
export const trackSlotScopes: NodeTransform = (node, context) => { // 收集插槽作用域
  if (
    node.type === NodeTypes.ELEMENT &&
    (node.tagType === ElementTypes.COMPONENT ||
      node.tagType === ElementTypes.TEMPLATE)
  ) {
    // 这里我们只检查非空的v-slot，因为我们只关心引入作用域变量的插槽。
    // We are only checking non-empty v-slot here
    // since we only care about slots that introduce scope variables.
    const vSlot = findDir(node, 'slot')
    if (vSlot) {
      const slotProps = vSlot.exp // 插槽表达式
      if (!__BROWSER__ && context.prefixIdentifiers) {
        slotProps && context.addIdentifiers(slotProps) // 增加到context.identifiers中
      }
      context.scopes.vSlot++ // 计数
      // 返回退出函数
      return () => {
        if (!__BROWSER__ && context.prefixIdentifiers) {
          slotProps && context.removeIdentifiers(slotProps) // 移除
        }
        context.scopes.vSlot-- // 减数
      }
    }
  }
}

/* 
注意：vue.global.js（浏览器端使用的）中并没有prefixIdentifiers这个参数
而在@vue/compiler-sfc中是配置了这个参数为true的
*/

// 使用 v-for 跟踪作用域插槽的作用域标识符的 NodeTransform。
// A NodeTransform that tracks scope identifiers for scoped slots with v-for.
// 此转换仅适用于具有 { prefixIdentifiers: true } 的非浏览器构建
// This transform is only applied in non-browser builds with { prefixIdentifiers: true }
export const trackVForSlotScopes: NodeTransform = (node, context) => { // 收集vfor插槽作用域
  let vFor
  if (
    isTemplateNode(node) &&
    node.props.some(isVSlot) &&
    (vFor = findDir(node, 'for')) // 是template节点 且 使用v-slot 且 使用v-for
  ) {
    const result = (vFor.parseResult = parseForExpression( // 解析for表达式
      vFor.exp as SimpleExpressionNode,
      context
    ))
    if (result) {
      const { value, key, index } = result
      const { addIdentifiers, removeIdentifiers } = context
      // 增加到context.identifiers中
      value && addIdentifiers(value)
      key && addIdentifiers(key)
      index && addIdentifiers(index)

      // 返回退出函数
      return () => {
        // 删除
        value && removeIdentifiers(value)
        key && removeIdentifiers(key)
        index && removeIdentifiers(index)
      }
    }
  }
}

export type SlotFnBuilder = (
  slotProps: ExpressionNode | undefined,
  slotChildren: TemplateChildNode[],
  loc: SourceLocation
) => FunctionExpression

// 构建客户端插槽函数 // +++
const buildClientSlotFn: SlotFnBuilder = (props, children, loc) =>
  createFunctionExpression( // 创建函数表达式
    props, // 参数为props
    // +++
    children, // returns为children // ++++++
    false /* newline */,
    // 是否为插槽 // +++
    true /* isSlot */, // +++标记是插槽+++这样就能在生成函数表达式时额外添加_withCtx()包裹所要生成的函数表达式啦 ~
    children.length ? children[0].loc : loc
  )

// +++
// 不是DirectiveTransform，而是在transformElement期间调用v-slot处理来为组件构建插槽对象。 // +++
// +++
// Instead of being a DirectiveTransform, v-slot processing is called during
// transformElement to build the slots object for a component.
export function buildSlots(
  node: ElementNode,
  context: TransformContext,
  buildSlotFn: SlotFnBuilder = buildClientSlotFn // 默认是构建客户端插槽函数 // +++
): {
  slots: SlotsExpression
  hasDynamicSlots: boolean
} {
  // +++
  context.helper(WITH_CTX) // 添加WITH_CTX助手
  // +++
  // withCtx它是一个函数
  // 我们会看到插槽名字对应的函数会去使用withCtx包裹一下
  // 这个当前上下文中添加这个助手
  // 同时在执行buildSlotFn返回的函数表达式时会标记函数是插槽
  // 那么这样就能够在codegen.ts中的genFunctionExpression函数执行时根据表达式节点isSlot是否为true
  // +++那么它就好额外添加一个_withCtx()来去包裹这个函数表达式的+++

  const { children, loc } = node // 取出节点的孩子
  const slotsProperties: Property[] = [] // 插槽属性
  const dynamicSlots: (ConditionalExpression | CallExpression)[] = [] // 动态插槽

  // 如果槽位于v-for或另一个v-slot内，强制它为动态的，因为它可能使用作用域变量。
  // If the slot is inside a v-for or another v-slot, force it to be dynamic
  // since it likely uses a scope variable.
  let hasDynamicSlots = context.scopes.vSlot > 0 || context.scopes.vFor > 0 // 是否有动态插槽
  // 使用' prefixIdentifiers: true '，这可以进一步优化，使它只有在插槽实际使用作用域变量时才动态。
  // with `prefixIdentifiers: true`, this can be further optimized to make
  // it dynamic only when the slot actually uses the scope variables.
  if (!__BROWSER__ && !context.ssr && context.prefixIdentifiers) {
    hasDynamicSlots = hasScopeRef(node, context.identifiers) // 有作用域引用
  }

  // 在组件本身上使用 slotProps 检查插槽。
  // 1. Check for slot with slotProps on component itself.
  //    <Comp v-slot="{ prop }"/>
  const onComponentSlot = findDir(node, 'slot', true) // 查找组件节点自身是否使用了v-slot指令
  if (onComponentSlot) {
    const { arg, exp } = onComponentSlot
    if (arg && !isStaticExp(arg)) { // #[xxx]="yyy"
      hasDynamicSlots = true // 有动态插槽
    }
    slotsProperties.push(
      // 创建对象属性
      createObjectProperty(
        arg || createSimpleExpression('default', true), // 创建简单表达式
        buildSlotFn(exp, children, loc) // 构建插槽函数
      )
      // {
      //   key: 对应的插槽名字
      //   value: 一个返回vnode的函数
      // }
    )
  }

  // 遍历孩子并检查模板槽
  // 2. Iterate through children and check for template slots
  //    <template v-slot:foo="{ prop }">
  let hasTemplateSlots = false // 有模板槽
  let hasNamedDefaultSlot = false // 有命名默认槽
  const implicitDefaultChildren: TemplateChildNode[] = [] // 显示默认孩子
  const seenSlotNames = new Set<string>() // 见过的插槽名字
  let conditionalBranchIndex = 0 // 条件分支下标

  // 遍历孩子
  for (let i = 0; i < children.length; i++) {
    const slotElement = children[i] // 插槽元素
    let slotDir

    if (
      !isTemplateNode(slotElement) || // 不是template节点
      !(slotDir = findDir(slotElement, 'slot', true)) // 或者没有使用slot指令
    ) {
      // 不是一个<template v-slot>则跳过
      // not a <template v-slot>, skip.
      if (slotElement.type !== NodeTypes.COMMENT) {
        implicitDefaultChildren.push(slotElement) // 推入显示的默认孩子
      }
      continue
    }

    // 父节点有使用slot指令
    if (onComponentSlot) {
      // 已经有在组件上的插槽 - 这是不正确的用法
      // already has on-component slot - this is incorrect usage.
      context.onError(
        createCompilerError(ErrorCodes.X_V_SLOT_MIXED_SLOT_USAGE, slotDir.loc)
      )
      break
    }

    hasTemplateSlots = true // 标记有模板插槽
    const { children: slotChildren, loc: slotLoc } = slotElement
    // 上方逻辑已经判断过当前的slotElement是一个template节点 - 那么这里直接取出该节点的children作为slotChildren

    /* 
    <Foo>
      <template #header="{ xxx }">
        <p>{{xxx}}</p>
      </template>
    </Foo>
    */

    const {
      arg: slotName = createSimpleExpression(`default`, true), // 没有参数那就创建default简单表达式 - 这个true表示isStatic
      exp: slotProps,
      loc: dirLoc
    } = slotDir

    // 检查name是否为动态的
    // check if name is dynamic.
    let staticSlotName: string | undefined
    if (isStaticExp(slotName)) { // 是否为静态的表达式
      // 其type为SIMPLE_EXPRESSION 且 其isStatic为true

      staticSlotName = slotName ? slotName.content : `default` // 没有则为default
    } else {
      hasDynamicSlots = true // 有动态插槽
    }

    // 构建插槽函数
    const slotFunction = buildSlotFn(slotProps, slotChildren, slotLoc) // 一个返回vnode的函数 - buildSlotFn上方的参数或者默认值buildClientSlotFn
    // 构建插槽函数
    /* 
    比如：<template #header="xxx">123</template>
    function (xxx) { return  }

    // 这里使用的children依然是slotChildren也就是template的children，也是略过template节点的啦 ~

    // #223
    // ++++++
    // 如果
    <template #header="xxx">
      <h2>张佳宁</h2>
      <h2>刘诗诗</h2>
    </template>

    {
      header: _withCtx((xxx) => [..., ...])
    }
    genFunctionExpression -> genNodeListAsArray中可以看到这里的children是数组的话那么所返回的就直接是一个数组
    // 而这里是不存在什么又包裹一层fragment的 - 所以这里需要进行注意的！！！

    // packages/compiler-core/src/transforms/transformSlotOutlet.ts
    // 而在插槽的出口也就是<slot name="header"/>对应的运行时函数renderSlot(_ctx.$slots, 'header')执行时
    // 内部会先openBlock()之后再createBlock(Fragment, ..., )它的children参数就是这里的函数执行后所返回的结果数组 // +++
    // 所以你可以说这里在插槽出口处是会使用fragment进行包裹的 // 要注意！！！

    // ++++++
    */

    // 检查这个插槽是否是有条件的（v-if/v-for）
    // check if this slot is conditional (v-if/v-for)
    let vIf: DirectiveNode | undefined
    let vElse: DirectiveNode | undefined
    let vFor: DirectiveNode | undefined
    if ((vIf = findDir(slotElement, 'if'))) { // 查找if指令
      hasDynamicSlots = true // 有动态插槽
      dynamicSlots.push(
        createConditionalExpression( // 创建条件表达式
          vIf.exp!, // test
          // 结果
          buildDynamicSlot(slotName, slotFunction, conditionalBranchIndex++), // 构建动态插槽
          // 备用选项
          defaultFallback
        )
      )
    } else if (
      (vElse = findDir(slotElement, /^else(-if)?$/, true /* allowEmpty */)) // 查找else | else-if指令
    ) {
      // 找到相邻的 v-if
      // find adjacent v-if
      let j = i
      let prev
      while (j--) {
        prev = children[j]
        if (prev.type !== NodeTypes.COMMENT) {
          break
        }
      }
      if (prev && isTemplateNode(prev) && findDir(prev, 'if')) {
        
        // +++
        // 删除此节点
        // remove node
        children.splice(i, 1)
        // +++

        i--
        __TEST__ && assert(dynamicSlots.length > 0)
        // 将此插槽附加到以前的条件
        // attach this slot to previous conditional
        let conditional = dynamicSlots[
          dynamicSlots.length - 1
        ] as ConditionalExpression

        while (
          conditional.alternate.type === NodeTypes.JS_CONDITIONAL_EXPRESSION
        ) {
          conditional = conditional.alternate // 找到备用选项
        }
        // 替换备用选项
        conditional.alternate = vElse.exp // else-if
          ? createConditionalExpression( // 创建条件表达式
              vElse.exp, // test
              // 结果
              buildDynamicSlot( // 构建动态插槽
                slotName,
                slotFunction,
                conditionalBranchIndex++
              ),
              // 备用选项
              defaultFallback
            )
          // else
          : buildDynamicSlot(slotName, slotFunction, conditionalBranchIndex++) // 构建动态插槽
      } else {
        context.onError(
          createCompilerError(ErrorCodes.X_V_ELSE_NO_ADJACENT_IF, vElse.loc)
        )
      }
    } else if ((vFor = findDir(slotElement, 'for'))) { // 查找for指令
      hasDynamicSlots = true // 有动态插槽
      const parseResult =
        vFor.parseResult || // 先看它有没有解析结果
        parseForExpression(vFor.exp as SimpleExpressionNode, context) // 解析for表达式
      if (parseResult) {
        // 作为一个数组渲染动态插槽并将其添加到createSlot()参数中。运行时知道如何适当地处理它。
        // Render the dynamic slots as an array and add it to the createSlot()
        // args. The runtime knows how to handle it appropriately.
        dynamicSlots.push(
          createCallExpression(context.helper(RENDER_LIST), [ // +++创建RENDER_LIST调用表达式+++
            parseResult.source, // 参数
            // 创建函数表达式
            createFunctionExpression(
              createForLoopParams(parseResult), // 创建for循环参数
              // returns
              buildDynamicSlot(slotName, slotFunction), // 构建动态参数
              true /* force newline */
            )
          ])
        )
      } else {
        context.onError(
          createCompilerError(ErrorCodes.X_V_FOR_MALFORMED_EXPRESSION, vFor.loc)
        )
      }
    } else {
      // 检查重复的静态名字
      // check duplicate static names
      if (staticSlotName) {
        if (seenSlotNames.has(staticSlotName)) {
          context.onError(
            createCompilerError(
              ErrorCodes.X_V_SLOT_DUPLICATE_SLOT_NAMES,
              dirLoc
            )
          )
          continue
        }
        seenSlotNames.add(staticSlotName)
        if (staticSlotName === 'default') {
          hasNamedDefaultSlot = true // 有命名默认插槽
        }
      }
      // 插槽属性
      slotsProperties.push(createObjectProperty(slotName, slotFunction)) // 创建对象属性
      // slotName是一个简单表达式 但是其有一个属性为isStatic表示是否为静态的 // +++
      // 那么在genObjectExpression -> genExpressionAsPropertyKey生成的对象的key是{ [xxx]: function (xxx) {} }这样的，要注意！！！

      /* 
      比如：
      {
        header: function (xxx) { return  }
      }
      */
    }
  }

  // 节点没有使用v-slot指令
  if (!onComponentSlot) {
    // 构建默认插槽属性
    const buildDefaultSlotProperty = (
      props: ExpressionNode | undefined,
      children: TemplateChildNode[]
    ) => {
      // 构建插槽函数
      const fn = buildSlotFn(props, children, loc)
      if (__COMPAT__ && context.compatConfig) {
        fn.isNonScopedSlot = true
      }
      // 创建对象属性{default: fn -> 一个返回vnode的函数}
      return createObjectProperty(`default`, fn)
    }

    // 也没有template插槽
    if (!hasTemplateSlots) {
      // 显示的默认插槽（在组件上）
      // implicit default slot (on component)
      slotsProperties.push(buildDefaultSlotProperty(undefined, children))
    } else if ( // 有template插槽
      implicitDefaultChildren.length && // 也要显示默认孩子
      // #3766
      // with whitespace: 'preserve', whitespaces between slots will end up in
      // implicitDefaultChildren. Ignore if all implicit children are whitespaces.
      implicitDefaultChildren.some(node => isNonWhitespaceContent(node)) // 显示默认孩子不是空格内容
    ) {
      // 显示默认插槽（带有命名插槽混合）
      // implicit default slot (mixed with named slots)
      if (hasNamedDefaultSlot) { // 有命名默认插槽
        context.onError(
          createCompilerError(
            ErrorCodes.X_V_SLOT_EXTRANEOUS_DEFAULT_SLOT_CHILDREN,
            implicitDefaultChildren[0].loc
          )
        )
      } else {
        slotsProperties.push(
          buildDefaultSlotProperty(undefined, implicitDefaultChildren) // 构建默认插槽属性
          // 孩子为显示默认插槽
        )
      }
    }
  }

  // 根据情况挑选插槽标记
  const slotFlag = hasDynamicSlots
    ? SlotFlags.DYNAMIC // 动态
    : hasForwardedSlots(node.children) // 是否有转发插槽
    ? SlotFlags.FORWARDED // 转发
    : SlotFlags.STABLE // 标准的插槽

  // 创建对象表达式
  let slots = createObjectExpression(
    slotsProperties.concat(
      createObjectProperty( // 创建对象属性
        `_`,
        // 2 = 已编译但动态 = 可以跳过规范化，但必须运行 diff
        // 1 = 已编译和静态 = 可以跳过规范化和优化后的差异
        // 2 = compiled but dynamic = can skip normalization, but must run diff
        // 1 = compiled and static = can skip normalization AND diff as optimized
        createSimpleExpression(
          slotFlag + (__DEV__ ? ` /* ${slotFlagsText[slotFlag]} */` : ``),
          false
        )
      )
    ),
    loc
  ) as SlotsExpression

  // 有动态插槽
  if (dynamicSlots.length) {
    // CREATE_SLOTS函数调用
    slots = createCallExpression(context.helper(CREATE_SLOTS), [ // 创建CREATE_SLOTS调用表达式
      slots, // 参数1 - 对象形式
      createArrayExpression(dynamicSlots) // 参数2 - 数组形式
    ]) as SlotsExpression
  }

  return { // 在transformElement.ts中退出函数中使用的

    // +++
    // dynamicSlots有值的话这个slots就是一个createSlots(slotsProperties对象, dynamicSlots数组)函数调用表达式节点
    // 没有值的话slots就是一个对象{name: fn -> 返回vnode函数}表达式节点
    // +++
    
    // ++++++
    // +++
    slots, // +++#[xxx]这种也是属于slots（slotsProperties）里面的+++（要注意）其实最终就是{ [xxx]: function (xxx) {} }这种表示，但是它会标记hasDynamicSlots为true
    // 此外而对于具有if系列、for这样的则是属于dynamicSlots，它也会标记hasDynamicSlots为true
    // +++
    // ++++++

    hasDynamicSlots
  }
}

// 构建动态插槽
function buildDynamicSlot(
  name: ExpressionNode,
  fn: FunctionExpression,
  index?: number
): ObjectExpression {
  const props = [
    createObjectProperty(`name`, name), // 创建对象属性 {name}
    createObjectProperty(`fn`, fn) // {fn}
  ]
  if (index != null) {
    props.push(
      createObjectProperty(`key`, createSimpleExpression(String(index), true)) // {key}
    )
  }
  return createObjectExpression(props) // 创建对象表达式
  // [{name}, {fn}, {key}]
}

function hasForwardedSlots(children: TemplateChildNode[]): boolean {
  for (let i = 0; i < children.length; i++) {
    const child = children[i]
    switch (child.type) {
      case NodeTypes.ELEMENT:
        if (
          child.tagType === ElementTypes.SLOT ||
          hasForwardedSlots(child.children)
        ) {
          return true
        }
        break
      case NodeTypes.IF:
        if (hasForwardedSlots(child.branches)) return true
        break
      case NodeTypes.IF_BRANCH:
      case NodeTypes.FOR:
        if (hasForwardedSlots(child.children)) return true
        break
      default:
        break
    }
  }
  return false
}

function isNonWhitespaceContent(node: TemplateChildNode): boolean {
  if (node.type !== NodeTypes.TEXT && node.type !== NodeTypes.TEXT_CALL)
    return true
  return node.type === NodeTypes.TEXT
    ? !!node.content.trim()
    : isNonWhitespaceContent(node.content)
}
