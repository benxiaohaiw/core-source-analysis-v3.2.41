import { TransformOptions } from './options'
import {
  RootNode,
  NodeTypes,
  ParentNode,
  TemplateChildNode,
  ElementNode,
  DirectiveNode,
  Property,
  ExpressionNode,
  createSimpleExpression,
  JSChildNode,
  SimpleExpressionNode,
  ElementTypes,
  CacheExpression,
  createCacheExpression,
  TemplateLiteral,
  createVNodeCall,
  ConstantTypes,
  ArrayExpression
} from './ast'
import {
  isString,
  isArray,
  NOOP,
  PatchFlags,
  PatchFlagNames,
  EMPTY_OBJ,
  capitalize,
  camelize
} from '@vue/shared'
import { defaultOnError, defaultOnWarn } from './errors'
import {
  TO_DISPLAY_STRING,
  FRAGMENT,
  helperNameMap,
  CREATE_COMMENT
} from './runtimeHelpers'
import { isVSlot, makeBlock } from './utils'
import { hoistStatic, isSingleElementRoot } from './transforms/hoistStatic'
import { CompilerCompatOptions } from './compat/compatConfig'

// There are two types of transforms:
//
// - NodeTransform:
//   Transforms that operate directly on a ChildNode. NodeTransforms may mutate,
//   replace or remove the node being processed.
export type NodeTransform = (
  node: RootNode | TemplateChildNode,
  context: TransformContext
) => void | (() => void) | (() => void)[]

// - DirectiveTransform:
//   Transforms that handles a single directive attribute on an element.
//   It translates the raw directive into actual props for the VNode.
export type DirectiveTransform = (
  dir: DirectiveNode,
  node: ElementNode,
  context: TransformContext,
  // a platform specific compiler can import the base transform and augment
  // it by passing in this optional argument.
  augmentor?: (ret: DirectiveTransformResult) => DirectiveTransformResult
) => DirectiveTransformResult

export interface DirectiveTransformResult {
  props: Property[]
  needRuntime?: boolean | symbol
  ssrTagParts?: TemplateLiteral['elements']
}

// A structural directive transform is technically also a NodeTransform;
// Only v-if and v-for fall into this category.
export type StructuralDirectiveTransform = (
  node: ElementNode,
  dir: DirectiveNode,
  context: TransformContext
) => void | (() => void)

export interface ImportItem {
  exp: string | ExpressionNode
  path: string
}

export interface TransformContext
  extends Required<
      Omit<TransformOptions, 'filename' | keyof CompilerCompatOptions>
    >,
    CompilerCompatOptions {
  selfName: string | null
  root: RootNode
  helpers: Map<symbol, number>
  components: Set<string>
  directives: Set<string>
  hoists: (JSChildNode | null)[]
  imports: ImportItem[]
  temps: number
  cached: number
  identifiers: { [name: string]: number | undefined }
  scopes: {
    vFor: number
    vSlot: number
    vPre: number
    vOnce: number
  }
  parent: ParentNode | null
  childIndex: number
  currentNode: RootNode | TemplateChildNode | null
  inVOnce: boolean
  helper<T extends symbol>(name: T): T
  removeHelper<T extends symbol>(name: T): void
  helperString(name: symbol): string
  replaceNode(node: TemplateChildNode): void
  removeNode(node?: TemplateChildNode): void
  onNodeRemoved(): void
  addIdentifiers(exp: ExpressionNode | string): void
  removeIdentifiers(exp: ExpressionNode | string): void
  hoist(exp: string | JSChildNode | ArrayExpression): SimpleExpressionNode
  cache<T extends JSChildNode>(exp: T, isVNode?: boolean): CacheExpression | T
  constantCache: Map<TemplateChildNode, ConstantTypes>

  // 2.x Compat only
  filters?: Set<string>
}

// 创建转换上下文
export function createTransformContext(
  root: RootNode,
  {
    filename = '',
    prefixIdentifiers = false,
    hoistStatic = false,
    cacheHandlers = false,
    nodeTransforms = [],
    directiveTransforms = {},
    transformHoist = null,
    isBuiltInComponent = NOOP,
    isCustomElement = NOOP,
    expressionPlugins = [],
    scopeId = null,
    slotted = true,
    ssr = false,
    inSSR = false,
    ssrCssVars = ``,
    bindingMetadata = EMPTY_OBJ,
    inline = false,
    isTS = false,
    onError = defaultOnError,
    onWarn = defaultOnWarn,
    compatConfig
  }: TransformOptions
): TransformContext {
  const nameMatch = filename.replace(/\?.*$/, '').match(/([^/\\]+)\.\w+$/)
  const context: TransformContext = {
    // options
    selfName: nameMatch && capitalize(camelize(nameMatch[1])),
    prefixIdentifiers,
    hoistStatic,
    cacheHandlers,
    nodeTransforms,
    directiveTransforms,
    transformHoist,
    isBuiltInComponent,
    isCustomElement,
    expressionPlugins,
    scopeId,
    slotted,
    ssr,
    inSSR,
    ssrCssVars,
    bindingMetadata,
    inline,
    isTS,
    onError,
    onWarn,
    compatConfig,

    // 状态
    // state
    root,
    helpers: new Map(),
    components: new Set(),
    directives: new Set(),
    hoists: [],
    imports: [],
    constantCache: new Map(),
    temps: 0,
    cached: 0,
    identifiers: Object.create(null),
    scopes: {
      vFor: 0,
      vSlot: 0,
      vPre: 0,
      vOnce: 0
    },
    parent: null,
    currentNode: root, // 一开始当前所在节点指向root
    childIndex: 0,
    inVOnce: false,

    // 一些函数
    // methods
    helper(name) { // 仅仅是把名字存入一个map中key为name，值为计数
      const count = context.helpers.get(name) || 0
      context.helpers.set(name, count + 1)
      return name // 返回名字
    },
    removeHelper(name) {
      const count = context.helpers.get(name)
      if (count) {
        const currentCount = count - 1
        if (!currentCount) {
          context.helpers.delete(name)
        } else {
          context.helpers.set(name, currentCount)
        }
      }
    },
    helperString(name) {
      return `_${helperNameMap[context.helper(name)]}`
    },
    replaceNode(node) {
      /* istanbul ignore if */
      if (__DEV__) {
        if (!context.currentNode) {
          throw new Error(`Node being replaced is already removed.`)
        }
        if (!context.parent) {
          throw new Error(`Cannot replace root node.`)
        }
      }
      context.parent!.children[context.childIndex] = context.currentNode = node
    },
    removeNode(node) {
      if (__DEV__ && !context.parent) {
        throw new Error(`Cannot remove root node.`)
      }
      const list = context.parent!.children
      const removalIndex = node
        ? list.indexOf(node)
        : context.currentNode
        ? context.childIndex
        : -1
      /* istanbul ignore if */
      if (__DEV__ && removalIndex < 0) {
        throw new Error(`node being removed is not a child of current parent`)
      }
      if (!node || node === context.currentNode) {
        // current node removed
        context.currentNode = null
        context.onNodeRemoved()
      } else {
        // sibling node removed
        if (context.childIndex > removalIndex) {
          context.childIndex--
          context.onNodeRemoved()
        }
      }
      context.parent!.children.splice(removalIndex, 1)
    },
    onNodeRemoved: () => {},
    addIdentifiers(exp) {
      // identifier tracking only happens in non-browser builds.
      if (!__BROWSER__) {
        if (isString(exp)) {
          addId(exp)
        } else if (exp.identifiers) {
          exp.identifiers.forEach(addId)
        } else if (exp.type === NodeTypes.SIMPLE_EXPRESSION) {
          addId(exp.content)
        }
      }
    },
    removeIdentifiers(exp) {
      if (!__BROWSER__) {
        if (isString(exp)) {
          removeId(exp)
        } else if (exp.identifiers) {
          exp.identifiers.forEach(removeId)
        } else if (exp.type === NodeTypes.SIMPLE_EXPRESSION) {
          removeId(exp.content)
        }
      }
    },
    // 提升
    hoist(exp) {
      if (isString(exp)) exp = createSimpleExpression(exp)
      // 直接向这个上下文中的hoisted中推入当前这个表达式
      context.hoists.push(exp)
      // 撞见简单表达式 - 生成一个标识符
      const identifier = createSimpleExpression(
        `_hoisted_${context.hoists.length}`,
        false,
        exp.loc,
        ConstantTypes.CAN_HOIST
      )
      // 给标识符添加hoisted属性值为当前的exp
      identifier.hoisted = exp
      return identifier // 返回这个标识符
    },
    // 缓存 - 返回一个js缓存表达式节点
    cache(exp, isVNode = false) {
      // 创建缓存表达式节点
      return createCacheExpression(context.cached++, exp, isVNode)
    }
  }

  if (__COMPAT__) {
    context.filters = new Set()
  }

  function addId(id: string) {
    const { identifiers } = context
    if (identifiers[id] === undefined) {
      identifiers[id] = 0
    }
    identifiers[id]!++
  }

  function removeId(id: string) {
    context.identifiers[id]!--
  }

  return context
}

export function transform(root: RootNode, options: TransformOptions) {
  // 创建转换上下文
  const context = createTransformContext(root, options)

  // 开始迭代ast语法树上的各个节点
  traverseNode(root, context)

  // 参数中是否有静态提升
  if (options.hoistStatic) {
    // 开启静态提升则进行静态提升转换
    hoistStatic(root, context) // 开始静态提升
  }

  // ---
  if (!options.ssr) {
    // 创建根的codegenNode
    createRootCodegen(root, context)
  }
  
  // 完成最终元数据信息
  // finalize meta information
  root.helpers = [...context.helpers.keys()] // 助手名字
  root.components = [...context.components] // 组件
  root.directives = [...context.directives] // 指令
  root.imports = context.imports // 导入的
  root.hoists = context.hoists // 挂载提升的数据
  root.temps = context.temps // 
  root.cached = context.cached // 缓存

  if (__COMPAT__) {
    root.filters = [...context.filters!]
  }
}

// 创建根上的codegenNode
function createRootCodegen(root: RootNode, context: TransformContext) {
  const { helper } = context
  const { children } = root
  // 判断root的孩子的数量
  if (children.length === 1) {
    // 取出这个子节点
    const child = children[0]
    // 如果单个孩子是一个元素，则将其变成一个块。
    // if the single child is an element, turn it into a block.
    if (isSingleElementRoot(root, child) && child.codegenNode) {
      // 单元素根永远不会被提升，所以codegenNode永远不会是SimpleExpressionNode
      // single element root is never hoisted so codegenNode will never be
      // SimpleExpressionNode
      const codegenNode = child.codegenNode
      if (codegenNode.type === NodeTypes.VNODE_CALL) {
        makeBlock(codegenNode, context) // 标记块 // ++++++++++++++++++++++++++++++++
      }
      // 挂载到root上
      root.codegenNode = codegenNode
    } else {
      // - 单个 <slot/>、IfNode、ForNode：已经是block的。
      // - 单个文本节点总是比对
      // 根代码生成通过 genNode()
      // - single <slot/>, IfNode, ForNode: already blocks.
      // - single text node: always patched.
      // root codegen falls through via genNode()
      root.codegenNode = child
    }
  } else if (children.length > 1) {
    // root 有多个节点 - 返回一个fragment块。
    // root has multiple nodes - return a fragment block.
    let patchFlag = PatchFlags.STABLE_FRAGMENT // 标准组件 // ++++++++++++++++++++++++++++++++++++++++++++++++++++++
    let patchFlagText = PatchFlagNames[PatchFlags.STABLE_FRAGMENT] // [64] -> STABLE_FRAGMENT
    // 检查fragment是否实际上包含一个有效的孩子，其余的都是注释
    // check if the fragment actually contains a single valid child with
    // the rest being comments
    if (
      __DEV__ &&
      children.filter(c => c.type !== NodeTypes.COMMENT).length === 1
    ) {
      patchFlag |= PatchFlags.DEV_ROOT_FRAGMENT
      patchFlagText += `, ${PatchFlagNames[PatchFlags.DEV_ROOT_FRAGMENT]}`
    }
    // 一个fragment虚拟节点调用，该节点是block的
    root.codegenNode = createVNodeCall(
      context,
      helper(FRAGMENT),
      undefined,
      root.children,
      patchFlag + (__DEV__ ? ` /* ${patchFlagText} */` : ``), // 64 /* STABLE_FRAGMENT */ // ++++++++++++++++++
      undefined,
      undefined,
      // +++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++
      true, // 标记为是块
      undefined, // disableTracking
      false /* isComponent */
      // +++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++
    )
  } else {
    //没有孩子 = noop
    // 那么codegen将返回null
    // no children = noop. codegen will return null.
  }
}

export function traverseChildren(
  parent: ParentNode,
  context: TransformContext
) {
  let i = 0
  const nodeRemoved = () => {
    i--
  }
  // 遍历孩子
  for (; i < parent.children.length; i++) {
    const child = parent.children[i]
    if (isString(child)) continue // 孩子是字符串则跳过
    context.parent = parent // 设置上下文中此时的parent
    context.childIndex = i // 孩子下标
    context.onNodeRemoved = nodeRemoved // 响应节点移除
    traverseNode(child, context) // 迭代节点
  }
}

/* 
注意：vue.global.js（浏览器端使用的）中并没有prefixIdentifiers这个参数
而在@vue/compiler-sfc中是配置了这个参数为true的
*/

/* 
只考虑@vue/compiler-sfc的情况下且不兼容那么默认的顺序

节点
[
  once
  if
  memo
  for
  trackVForSlotScopes
  transformExpression
  transformSlotOutlet
  transformElement
  trackSlotScopes
  transformText

  @vue-compiler-dom
  transformStyle
  __DEV__ && transformTransition

]

指令
{
  @vue/compiler-core
  v-on
  v-bind
  v-model

  @vue-compiler-dom
  cloak
  html
  text
  model - override compiler-core
  on - override compiler-core
  show
}
*/

/* 
1.对节点一一应用节点转换函数
2.根据节点类型做出相应策略，比如容器类型的需要继续迭代孩子
3.对节点倒序一一应用执行转换函数时所返回的函数
*/
export function traverseNode(
  node: RootNode | TemplateChildNode,
  context: TransformContext
) {
  // 设置上下文中当前节点的指向为参数node
  context.currentNode = node
  // apply transform plugins
  const { nodeTransforms } = context
  const exitFns = []
  // 遍历节点转换函数数组
  for (let i = 0; i < nodeTransforms.length; i++) {
    // 对此节点执行函数
    const onExit = nodeTransforms[i](node, context)
    // 返回的函数一一推入数组中
    if (onExit) {
      if (isArray(onExit)) {
        exitFns.push(...onExit)
      } else {
        exitFns.push(onExit)
      }
    }
    // 此时当前节点没有 - 说明节点是被移除了
    if (!context.currentNode) {
      // node was removed
      // ---
      return // 直接返回
    } else {
      // 节点可能被替换 - 那么把这个域中的node执行更换为当前节点的指向
      // node may have been replaced
      node = context.currentNode
      // 例如vIf.ts中的处理把具有v-if的节点替换为了if类型的节点
      // 所以对于后面的转换函数来讲就需要面对的是这个替换后的节点啦
      // 所以这里就需要进行一个替换赋值操作的
    }
  }

  // 转换函数与退出函数的调用顺序
  /* 
  fn1
  fn2
  fn3

  额外操作
  
  exitFn3
  exitFn2
  exitFn1
  */

  switch (node.type) {
    case NodeTypes.COMMENT:
      if (!context.ssr) {
        // 注释符号的注入导入，它是用' createVNode '创建注释节点所需要的。
        // inject import for the Comment symbol, which is needed for creating
        // comment nodes with `createVNode`
        context.helper(CREATE_COMMENT) // 添加CREATE_COMMENT助手名字
      }
      break
    case NodeTypes.INTERPOLATION: // 插值节点
      // 不需要遍历，但是我们需要注入 toString 助手
      // no need to traverse, but we need to inject toString helper
      if (!context.ssr) {
        context.helper(TO_DISPLAY_STRING) // 添加TO_DISPLAY_STRING助手的名字
      }
      break

    // 对于容器类型，进一步向下遍历
    // for container types, further traverse downwards
    case NodeTypes.IF:
      // if类型节点直接遍历它的分支数组
      for (let i = 0; i < node.branches.length; i++) { // 对于if节点直接遍历它的分支属性
        // 迭代每一个的分支节点
        traverseNode(node.branches[i], context)
      }
      break
    case NodeTypes.IF_BRANCH: // 对于分支节点那么策略为迭代它的孩子 - 因为它的孩子节点对应着替换前的节点 - 它是主要需要处理的
    case NodeTypes.FOR:
    case NodeTypes.ELEMENT:
    case NodeTypes.ROOT:
      traverseChildren(node, context) // 迭代孩子
      break
  }

  // 还是把node的指向再次赋值给context.currentNode
  // exit transforms
  context.currentNode = node // 当前节点的指向为域中的node
  let i = exitFns.length
  // 倒序执行函数
  while (i--) {
    exitFns[i]()
  }
}

// 创建结构化指令转换函数
export function createStructuralDirectiveTransform(
  name: string | RegExp,
  fn: StructuralDirectiveTransform
): NodeTransform {
  const matches = isString(name)
    ? (n: string) => n === name
    : (n: string) => name.test(n)

  // 直接返回的就是这个函数 - 作为第一层直接调用的
  return (node, context) => {
    // 节点类型是否是元素
    if (node.type === NodeTypes.ELEMENT) {
      const { props } = node
      // structural directive transforms are not concerned with slots
      // as they are handled separately in vSlot.ts
      if (node.tagType === ElementTypes.TEMPLATE && props.some(isVSlot)) { // 当前节点大的标签类型为template且属性有v-slot那么直接返回
        return
      }
      // 退出函数数组
      const exitFns = []
      // 遍历此节点的属性
      for (let i = 0; i < props.length; i++) {
        const prop = props[i]
        // 筛选出属性中是指令类型的节点且要和matches匹配到
        if (prop.type === NodeTypes.DIRECTIVE && matches(prop.name)) {
          // 结构指令被删除以避免无限递归，我们在*应用之前删除它们，以便在移动节点的情况下可以进一步遍历自身
          // structural directives are removed to avoid infinite recursion
          // also we remove them *before* applying so that it can further
          // traverse itself in case it moves the node around



          // ******
          // 这一步很关键 - 需要进行删除 - 因为后续操作会进行递归 - 所以这里处理了之后就需要进行删除 - 否则无限递归
          // ---***
          props.splice(i, 1) // 重点 - 删除此节点中对应的这个指令属性 - 以避免后面会发生递归 ---***
          // ---***
          // ***



          i--
          const onExit = fn(node, prop, context) // 执行传入的参数函数fn
          // 返回的是一个函数
          if (onExit) exitFns.push(onExit) // 推入到这个数组中去
        }
      }
      return exitFns // 返回一个退出函数组成的数组
    }
  }
}
