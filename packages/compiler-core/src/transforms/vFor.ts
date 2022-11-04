import {
  createStructuralDirectiveTransform,
  TransformContext
} from '../transform'
import {
  NodeTypes,
  ExpressionNode,
  createSimpleExpression,
  SourceLocation,
  SimpleExpressionNode,
  createCallExpression,
  createFunctionExpression,
  createObjectExpression,
  createObjectProperty,
  ForCodegenNode,
  RenderSlotCall,
  SlotOutletNode,
  ElementNode,
  DirectiveNode,
  ForNode,
  PlainElementNode,
  createVNodeCall,
  VNodeCall,
  ForRenderListExpression,
  BlockCodegenNode,
  ForIteratorExpression,
  ConstantTypes,
  createBlockStatement,
  createCompoundExpression
} from '../ast'
import { createCompilerError, ErrorCodes } from '../errors'
import {
  getInnerRange,
  findProp,
  isTemplateNode,
  isSlotOutlet,
  injectProp,
  getVNodeBlockHelper,
  getVNodeHelper,
  findDir
} from '../utils'
import {
  RENDER_LIST,
  OPEN_BLOCK,
  FRAGMENT,
  IS_MEMO_SAME
} from '../runtimeHelpers'
import { processExpression } from './transformExpression'
import { validateBrowserExpression } from '../validateExpression'
import { PatchFlags, PatchFlagNames } from '@vue/shared'

export const transformFor = createStructuralDirectiveTransform(
  'for',
  (node, dir, context) => {
    const { helper, removeHelper } = context
    return processFor(node, dir, context, forNode => {
      // 现在创建循环render函数表达式，并在遍历所有孩子后在退出时添加迭代器iterator
      // create the loop render function expression now, and add the
      // iterator on exit after all children have been traversed
      // 创建调用renderList调用表达式
      const renderExp = createCallExpression(helper(RENDER_LIST), [ // ++++++++++++++++++++++++++++++++++++++
        forNode.source // 参数[0, 1, 2]
      ]) as ForRenderListExpression
      const isTemplate = isTemplateNode(node) // 当前节点是否模板节点
      const memo = findDir(node, 'memo') // 查找memo指令
      const keyProp = findProp(node, `key`) // 查找key属性
      // key="idx" | :key="idx"
      const keyExp =
        keyProp &&
        (keyProp.type === NodeTypes.ATTRIBUTE // 是普通属性
          ? createSimpleExpression(keyProp.value!.content, true) // 直接创建一个简单表达式
          : keyProp.exp!) // 不是普通属性而是指令 - 直接取表达式
      // 创建关于key的对象{key}
      const keyProperty = keyProp ? createObjectProperty(`key`, keyExp!) : null

      if (!__BROWSER__ && isTemplate) {
        // #2085 / #5288 process :key and v-memo expressions need to be
        // processed on `<template v-for>`. In this case the node is discarded
        // and never traversed so its binding expressions won't be processed
        // by the normal transforms.
        if (memo) {
          memo.exp = processExpression(
            memo.exp! as SimpleExpressionNode,
            context
          )
        }
        if (keyProperty && keyProp!.type !== NodeTypes.ATTRIBUTE) {
          keyProperty.value = processExpression(
            keyProperty.value as SimpleExpressionNode,
            context
          )
        }
      }

      // ++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++
      // ++++++++++++++++++++++++++++++++++++
      const isStableFragment =
        forNode.source.type === NodeTypes.SIMPLE_EXPRESSION &&
        forNode.source.constType > ConstantTypes.NOT_CONSTANT // ConstantTypes.NOT_CONSTANT > ConstantTypes.NOT_CONSTANT
      // 不是标准fragment
      // ++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++
      
      // +++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++
      const fragmentFlag = isStableFragment // 是否为标准fragment // ++++++++++++++++++++++
        ? PatchFlags.STABLE_FRAGMENT
        : keyProp // 是否有key属性
        ? PatchFlags.KEYED_FRAGMENT // 那就是带有key的fragment // ++++++++++++++++++++++++=
        : PatchFlags.UNKEYED_FRAGMENT // 不带key的fragment // +++++++++++++++++++++++++++++++++++++++++++++++++
      // ++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++

      // ++++++++++++++++++
      // 准备codegen node为创建虚拟节点调用节点
      forNode.codegenNode = createVNodeCall(
        context,
        helper(FRAGMENT), // 一个fragment
        undefined,
        renderExp, // 孩子为renderList() // ++++++
        fragmentFlag +
          (__DEV__ ? ` /* ${PatchFlagNames[fragmentFlag]} */` : ``),
        undefined,
        undefined,
        // ***
        // 是块
        // 大多都是是块且不是组件且不禁用收集
        // 但是这里唯一不一样的是是否禁用收集需要依据isStableFragment的取反值 - isStableFragment那么不禁用收集 不是isStableFragment那么禁用收集 +++++++++++++++++++++++++++++++++
        // ***
        true /* isBlock */, // ++++++++++++++++++++++++++++++++++++++++
        !isStableFragment /* disableTracking */, // ++++++++++++++++++++++++++++++++++++++
        // 标记不是组件
        // 标记不是组件
        false /* isComponent */, // +++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++
        node.loc
      ) as ForCodegenNode

      /* 
      <script setup>
        import { ref } from 'vue'

        const nums = ref([0, 1, 2])
      </script>

      <template>
        <ul>
          <li v-for="(item, index) in nums" :key="item">{{ item }}</li>
        </ul>
        <ul>
          <li v-for="(item, index) in [0, 1, 2]" :key="item">{{ item }}</li>
        </ul>
      </template>
      */

// -++++++++++++++++++++++++++++++++++++++++++++++++
/* Analyzed bindings: {
  "ref": "setup-const",
  "nums": "setup-ref"
} */
// import { renderList as _renderList, Fragment as _Fragment, openBlock as _openBlock, createElementBlock as _createElementBlock, toDisplayString as _toDisplayString, createElementVNode as _createElementVNode } from "vue"

// import { ref } from 'vue'


// const __sfc__ = {
//   __name: 'App',
//   setup(__props) {

// const nums = ref([0, 1, 2])

// return (_ctx, _cache) => {
//   return (_openBlock(), _createElementBlock(_Fragment, null, [ // 注意是_createElementBlock
//     _createElementVNode("ul", null, [
  
         // 注意是带有参数true的，同时也注意是_createElementBlock，孩子正好是renderList函数执行的结果 - 它两个参数，第二个参数为函数，它的返回值正是childBlock
//       (_openBlock(true), _createElementBlock(_Fragment, null, _renderList(nums.value, (item, index) => {

           // 注意是createElementBlock - 这个是因为fragment为keyedFragment那么所以childBlock的isBlock为true啦 再者同时因为不是组件所以就是createElementBlock

//         return (_openBlock(), _createElementBlock("li", { key: item }, _toDisplayString(item), 1 /* TEXT */))
//       }), 128 /* KEYED_FRAGMENT */))
//     ]),
//     _createElementVNode("ul", null, [
//       (_openBlock(), _createElementBlock(_Fragment, null, _renderList([0, 1, 2], (item, index) => {
  
           // 注意是createElementVNode - 这个是因为fragment为stableFragment那么所以childBlock的isBlock为false啦 再者同时因为不是组件所以就是createElementVNode

//         return _createElementVNode("li", { key: item }, _toDisplayString(item), 1 /* TEXT */)
//       }), 64 /* STABLE_FRAGMENT */))
//     ])
//   ], 64 /* STABLE_FRAGMENT */))
// }
// }

// }
// __sfc__.__file = "App.vue"
// export default __sfc__
// +++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++





      // 返回退出函数
      return () => {
        // 既然已经遍历了所有孩子，就完成代码生成
        // finish the codegen now that all children have been traversed
        let childBlock: BlockCodegenNode
        const { children } = forNode // 拿到forNode对应的原先节点
        // ++++++
        // children: isTemplateNode(node) ? node.children : [node]
        // ++++++++++++++++++++++++++++++++

        // check <template v-for> key placement
        if ((__DEV__ || !__BROWSER__) && isTemplate) {
          node.children.some(c => {
            if (c.type === NodeTypes.ELEMENT) {
              const key = findProp(c, 'key')
              if (key) {
                context.onError(
                  createCompilerError(
                    ErrorCodes.X_V_FOR_TEMPLATE_KEY_PLACEMENT,
                    key.loc
                  )
                )
                return true
              }
            }
          })
        }

        // ++++++++++
        const needFragmentWrapper =
          children.length !== 1 || children[0].type !== NodeTypes.ELEMENT // ++++++++++++++++++++++++++++++++++++++++++++++++++
        // ++++++
        // 是否需要是块的fragment进行包裹
        // <li v-for="() in []"> -> 不需要
        // ++++++
        
        // ++++++++++++++++++++++
        // 按照上面的例子 - 这里就是null了
        // // 主要是判断节点类型为元素 且 标签类型为插槽
        const slotOutlet = isSlotOutlet(node) // 是否为插槽出口
          ? node
          : isTemplate &&
            node.children.length === 1 &&
            isSlotOutlet(node.children[0])
          ? (node.children[0] as SlotOutletNode) // api-extractor somehow fails to infer this
          : null
        // +++++++

        // 准备childBlock // +++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++

        if (slotOutlet) { // ++++++++++++++++++++++++++++++++++
          // <slot v-for="..."> or <template v-for="..."><slot/></template>
          childBlock = slotOutlet.codegenNode as RenderSlotCall
          if (isTemplate && keyProperty) {
            // <template v-for="..." :key="..."><slot/></template>
            // we need to inject the key to the renderSlot() call.
            // the props for renderSlot is passed as the 3rd argument.
            injectProp(childBlock, keyProperty, context) // 注入key属性
          }
        } else if (needFragmentWrapper) { // +++++++++++++++++++++++++++++++++=
          // <template v-for="..."> with text or multi-elements
          // should generate a fragment block for each loop
          childBlock = createVNodeCall(
            context,
            helper(FRAGMENT),
            keyProperty ? createObjectExpression([keyProperty]) : undefined,
            node.children, // +++++++++
            PatchFlags.STABLE_FRAGMENT + // 标准fragment
              (__DEV__
                ? ` /* ${PatchFlagNames[PatchFlags.STABLE_FRAGMENT]} */`
                : ``),
            undefined,
            undefined,
            // +++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++
            true, // 是块 // ++++++
            undefined, // disableTracking // 不禁用收集
            // 标记不是组件
            false /* isComponent */
            // +++++++++++++++++++++++++++++++++++++++++
          )
        } else {
          // 正常元素v-for
          // 直接使用子节点的codegenNode，但将其标记为块。
          // Normal element v-for. Directly use the child's codegenNode
          // but mark it as a block.
          childBlock = (children[0] as PlainElementNode)
            .codegenNode as VNodeCall // li对应的codegenNode++++++++++==
          if (isTemplate && keyProperty) {
            injectProp(childBlock, keyProperty, context) // 注入key属性 // +++++++++++++++++++++++++++++++++++++++++++++++++++++
          }

          // +++++++++++++++++
          // 下面是处理助手的逻辑
          // +++++++++++++++++++++++++++++++++++++
          if (childBlock.isBlock !== !isStableFragment) {
            if (childBlock.isBlock) {
              // switch from block to vnode
              removeHelper(OPEN_BLOCK)
              removeHelper(
                getVNodeBlockHelper(context.inSSR, childBlock.isComponent)
              )
            } else {
              // switch from vnode to block
              removeHelper(
                getVNodeHelper(context.inSSR, childBlock.isComponent)
              )
            }
          }

          // ++++++++++++++++++childBlock是否是块的直接关系就是上面的isStableFragment的取反值!isStableFragment // ++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++
          childBlock.isBlock = !isStableFragment // +++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++
          if (childBlock.isBlock) { // +++++++++++
            helper(OPEN_BLOCK) // +++++++++++++
            helper(getVNodeBlockHelper(context.inSSR, childBlock.isComponent))
          } else { // ++++++++++++++++++
            helper(getVNodeHelper(context.inSSR, childBlock.isComponent))
          }
          // ++++++++++++++++++
        
        }

        // childBlock准备完毕 // ++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++

        // https://vuejs.org/api/built-in-directives.html#v-memo
        // Usage with v-for
        // ++++++++++++++
        if (memo) { // +++++++++++ // 是否有memo
          // ++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++

          // 创建函数表达式节点
          const loop = createFunctionExpression(
            createForLoopParams(forNode.parseResult, [
              createSimpleExpression(`_cached`) // +++++++++++++++++++++++++++++++
            ])
          )
          // ++++++++++++++++++++++++++++++++++
          // 创建块语句
          loop.body = createBlockStatement([
            createCompoundExpression([`const _memo = (`, memo.exp!, `)`]),
            createCompoundExpression([
              `if (_cached`,
              ...(keyExp ? [` && _cached.key === `, keyExp] : []),
              ` && ${context.helperString(
                IS_MEMO_SAME
              )}(_cached, _memo)) return _cached`
            ]),
            createCompoundExpression([`const _item = `, childBlock as any]), // ++++++++++++++++++++++++++++++++++++++++++
            createSimpleExpression(`_item.memo = _memo`),
            createSimpleExpression(`return _item`)
          ])
          // ++++++++++++++++++++++++++++++++++
          // ++++++
          // renderList的参数推入二、三、四参数++++++++++++++++++++++++++++++++++++++++++++++++++++++
          renderExp.arguments.push(
            loop as ForIteratorExpression,
            createSimpleExpression(`_cache`), // _cache
            createSimpleExpression(String(context.cached++))
          )
        } else { // +++++++++++++++++++++
          // 没有memo // 正常的
          // ++++++++++++++++++++++++++++++++++++++++++++++++++++++
          // ++++++
          // renderList的参数推入第二个参数为一个函数
          renderExp.arguments.push(
            // 第二个参数
            createFunctionExpression( // 创建函数表达式 // +++++++++++++++++
              createForLoopParams(forNode.parseResult), // 根据解析结果创建for循环参数 - 就是表达式节点组成数组 [val, idx, ___]
              // ++++++// 返回的正是childBlock
              childBlock, // returns
              true /* force newline */
            ) as ForIteratorExpression
          )
        }
        // +++++++++++++++++++++*****************************+++++++++++++++++++++++
      }
    })
  }
)

// target-agnostic transform used for both Client and SSR
export function processFor(
  node: ElementNode,
  dir: DirectiveNode,
  context: TransformContext,
  processCodegen?: (forNode: ForNode) => (() => void) | undefined
) {
  if (!dir.exp) {
    context.onError(
      createCompilerError(ErrorCodes.X_V_FOR_NO_EXPRESSION, dir.loc)
    )
    return
  }

  // v-for="(val, idx) in [0, 1, 2]"

  // 解析for表达式
  const parseResult = parseForExpression(
    // can only be simple expression because vFor transform is applied
    // before expression transform.
    dir.exp as SimpleExpressionNode, // 指令的表达式"(val, idx) in [0, 1, 2]"
    context
  )

  if (!parseResult) {
    context.onError(
      createCompilerError(ErrorCodes.X_V_FOR_MALFORMED_EXPRESSION, dir.loc)
    )
    return
  }

  const { addIdentifiers, removeIdentifiers, scopes } = context
  const { source, value, key, index } = parseResult
  // [0, 1, 2] val idx undefined

  // 准备for类型节点
  const forNode: ForNode = {
    type: NodeTypes.FOR,
    loc: dir.loc,
    source,
    valueAlias: value,
    keyAlias: key,
    objectIndexAlias: index,
    parseResult,
    // +++++++++++++++++++++++++++++++++
    children: isTemplateNode(node) ? node.children : [node] // ++++++++++++
  }

  // 替换此节点
  context.replaceNode(forNode)

  // bookkeeping
  scopes.vFor++
  if (!__BROWSER__ && context.prefixIdentifiers) {
    // ***
    // 作用域管理
    // 注入标识符到上下文中
    // scope management
    // inject identifiers to context
    value && addIdentifiers(value) // 增加到context的identifiers对象中以val为key，值为计数结果
    key && addIdentifiers(key) // 以idx为key，值为计数结果
    index && addIdentifiers(index)
    // ***
    // 为的就是在处理:key="val"时能够在context的identifiers对象中找到作用域下的它
  }

  // 执行钩子函数
  const onExit = processCodegen && processCodegen(forNode) // 传入for类型节点

  // 返回退出函数
  return () => {
    scopes.vFor--
    if (!__BROWSER__ && context.prefixIdentifiers) {
      // 删除标识符
      value && removeIdentifiers(value)
      key && removeIdentifiers(key)
      index && removeIdentifiers(index)
    }
    // 执行退出函数
    if (onExit) onExit()
  }
}

const forAliasRE = /([\s\S]*?)\s+(?:in|of)\s+([\s\S]*)/
// This regex doesn't cover the case if key or index aliases have destructuring,
// but those do not make sense in the first place, so this works in practice.
const forIteratorRE = /,([^,\}\]]*)(?:,([^,\}\]]*))?$/
const stripParensRE = /^\(|\)$/g

export interface ForParseResult {
  source: ExpressionNode
  value: ExpressionNode | undefined
  key: ExpressionNode | undefined
  index: ExpressionNode | undefined
}

// 解析for表达式
export function parseForExpression(
  input: SimpleExpressionNode,
  context: TransformContext
): ForParseResult | undefined {
  const loc = input.loc
  const exp = input.content // "(val, idx) in [0, 1, 2]"
  const inMatch = exp.match(forAliasRE)
  if (!inMatch) return

  const [, LHS, RHS] = inMatch
  // (val, idx) [0, 1, 2]

  // 准备解析结果对象
  const result: ForParseResult = {
    // [0, 1, 2]
    source: createAliasExpression( // 创建别名表达式
      loc,
      RHS.trim(),
      exp.indexOf(RHS, LHS.length)
    ),
    value: undefined,
    key: undefined,
    index: undefined
  }
  if (!__BROWSER__ && context.prefixIdentifiers) {
    result.source = processExpression(
      result.source as SimpleExpressionNode,
      context
    )
  }
  if (__DEV__ && __BROWSER__) {
    validateBrowserExpression(result.source as SimpleExpressionNode, context)
  }

  let valueContent = LHS.trim().replace(stripParensRE, '').trim() // 处理括号
  // 变为val, idx
  const trimmedOffset = LHS.indexOf(valueContent)

  const iteratorMatch = valueContent.match(forIteratorRE)
  if (iteratorMatch) {
    valueContent = valueContent.replace(forIteratorRE, '').trim() // val

    const keyContent = iteratorMatch[1].trim() // idx
    let keyOffset: number | undefined
    if (keyContent) {
      keyOffset = exp.indexOf(keyContent, trimmedOffset + valueContent.length)
      // 创建别名表达式节点
      result.key = createAliasExpression(loc, keyContent, keyOffset)
      if (!__BROWSER__ && context.prefixIdentifiers) {
        result.key = processExpression(result.key, context, true)
      }
      if (__DEV__ && __BROWSER__) {
        validateBrowserExpression(
          result.key as SimpleExpressionNode,
          context,
          true
        )
      }
    }

    /* 
    https://vuejs.org/api/built-in-directives.html#v-for

    <div v-for="(item, index) in items"></div>
    <div v-for="(value, key) in object"></div>
    <div v-for="(value, name, index) in object"></div>
    */

    if (iteratorMatch[2]) {
      const indexContent = iteratorMatch[2].trim()

      if (indexContent) {
        // 创建别名表达式节点
        result.index = createAliasExpression(
          loc,
          indexContent,
          exp.indexOf(
            indexContent,
            result.key
              ? keyOffset! + keyContent.length
              : trimmedOffset + valueContent.length
          )
        )
        if (!__BROWSER__ && context.prefixIdentifiers) {
          result.index = processExpression(result.index, context, true)
        }
        if (__DEV__ && __BROWSER__) {
          validateBrowserExpression(
            result.index as SimpleExpressionNode,
            context,
            true
          )
        }
      }
    }
  }

  if (valueContent) {
    // 创建别名表达式节点
    result.value = createAliasExpression(loc, valueContent, trimmedOffset)
    if (!__BROWSER__ && context.prefixIdentifiers) {
      result.value = processExpression(result.value, context, true)
    }
    if (__DEV__ && __BROWSER__) {
      validateBrowserExpression(
        result.value as SimpleExpressionNode,
        context,
        true
      )
    }
  }

  return result
}

// 创建别名表达式
function createAliasExpression(
  range: SourceLocation,
  content: string,
  offset: number
): SimpleExpressionNode {
  // 创建简单表达式节点
  return createSimpleExpression( // 节点类型为简单表达式类型
    content,
    false,
    getInnerRange(range, offset, content.length)
  )
}

// 创建for循环参数
export function createForLoopParams(
  { value, key, index }: ForParseResult,
  memoArgs: ExpressionNode[] = []
): ExpressionNode[] {
  // 创建参数列表
  return createParamsList([value, key, index, ...memoArgs])
}

// 创建参数列表 - 其实就是表达式节点组成的数组
function createParamsList(
  args: (ExpressionNode | undefined)[]
): ExpressionNode[] {
  let i = args.length
  while (i--) {
    if (args[i]) break
  }
  return args
    .slice(0, i + 1)
    .map((arg, i) => arg || createSimpleExpression(`_`.repeat(i + 1), false))
}
