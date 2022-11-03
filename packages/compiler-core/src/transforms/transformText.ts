import { NodeTransform } from '../transform'
import {
  NodeTypes,
  CompoundExpressionNode,
  createCallExpression,
  CallExpression,
  ElementTypes,
  ConstantTypes,
  createCompoundExpression
} from '../ast'
import { isText } from '../utils'
import { CREATE_TEXT } from '../runtimeHelpers'
import { PatchFlags, PatchFlagNames } from '@vue/shared'
import { getConstantType } from './hoistStatic'

// 将相邻的文本节点和表达式合并为一个表达式
// 例如：<div>abc {{ d }} {{ e }}</div> 应该有一个表达式节点作为子节点。
// Merge adjacent text nodes and expressions into a single expression
// e.g. <div>abc {{ d }} {{ e }}</div> should have a single expression node as child.
export const transformText: NodeTransform = (node, context) => { // 转换文本
  if (
    node.type === NodeTypes.ROOT ||
    node.type === NodeTypes.ELEMENT ||
    node.type === NodeTypes.FOR ||
    node.type === NodeTypes.IF_BRANCH
    // 节点的类型是ROOT | ELEMENT | FOR | IF_BRANCH
  ) {
    // 在节点退出时执行这个转换，以便所有表达式已经被处理。
    // perform the transform on node exit so that all expressions have already
    // been processed.
    // 返回退出函数
    return () => {
      const children = node.children // 取出节点的孩子
      // 当前容器
      let currentContainer: CompoundExpressionNode | undefined = undefined
      let hasText = false // 是否有文本

      /* 
      下面这个循环的意思为
      text
      text // 这两个合为一个复合表达式节点
      element
      text
      text // 这两个合为一个复合表达式节点
      */
      // 遍历孩子
      for (let i = 0; i < children.length; i++) {
        const child = children[i]
        // 孩子是否为文本
        // node.type === NodeTypes.INTERPOLATION || node.type === NodeTypes.TEXT
        if (isText(child)) {
          hasText = true // 标记有文本
          // 遍历当前孩子之后的兄弟节点
          for (let j = i + 1; j < children.length; j++) {
            const next = children[j]
            // 后面的兄弟节点是否为文本
            if (isText(next)) {
              if (!currentContainer) { // 没有当前容器
                currentContainer = children[i] = createCompoundExpression( // 创建复合表达式节点
                  [child],
                  child.loc
                )
              }
              // 将相邻文本节点合并到当前节点
              // merge adjacent text node into current
              currentContainer.children.push(` + `, next) // [child, ' + ', next]

              // +++
              children.splice(j, 1) // 删除这个节点
              // +++
              
              j--
            } else { // 不是文本则置空当前容器并break
              // 说明结构是这样的
              /* 
              text
              {{}}
              element // 遇到它直接退出
              */
              currentContainer = undefined
              break
            }
          }
        }
      }

      if (
        !hasText || // 没有文本
        // 如果这是一个带有单个文本子元素的普通元素，请保持原样，因为运行时通过直接设置元素的textContent为其提供了专用的快速路径。对于根组件，它总是被序列化的。
        // if this is a plain element with a single text child, leave it
        // as-is since the runtime has dedicated fast path for this by directly
        // setting textContent of the element.
        // for component root it's always normalized anyway.
        (children.length === 1 && // 只有一个孩子 或
          (node.type === NodeTypes.ROOT || // root类型 或
            (node.type === NodeTypes.ELEMENT && // 元素类型 且
              node.tagType === ElementTypes.ELEMENT && // 标签类型也是元素类型
              // #3756
              // custom directives can potentially add DOM elements arbitrarily,
              // we need to avoid setting textContent of the element at runtime
              // to avoid accidentally overwriting the DOM elements added
              // by the user through custom directives.
              // 自定义指令可能会随意添加DOM元素，我们需要避免在运行时设置元素的textContent，以避免意外覆盖用户通过自定义指令添加的DOM元素。
              !node.props.find( // 且节点中没有使用自定义指令
                p =>
                  p.type === NodeTypes.DIRECTIVE &&
                  !context.directiveTransforms[p.name]
              ) &&
              // in compat mode, <template> tags with no special directives
              // will be rendered as a fragment so its children must be
              // converted into vnodes.
              !(__COMPAT__ && node.tag === 'template')))) // 且不是兼容模式或节点标签不是template
      ) {
        // 直接返回 - 不处理
        return
      }

      // 将文本节点预转换为createTextVNode(文本)调用，以避免运行时序列化。
      // pre-convert text nodes into createTextVNode(text) calls to avoid
      // runtime normalization.
      for (let i = 0; i < children.length; i++) { // 还是遍历孩子 - 注意此时的孩子会和上面一开始的不一样（有的被替换为混合表达式节点 有的被删除）
        const child = children[i]
        // node.type === NodeTypes.INTERPOLATION || node.type === NodeTypes.TEXT || child.type === NodeTypes.COMPOUND_EXPRESSION
        if (isText(child) || child.type === NodeTypes.COMPOUND_EXPRESSION) {
          const callArgs: CallExpression['arguments'] = []
          // createTextVNode默认为单个空格，因此如果它是单个空格，代码可以是空调用，以节省字节。
          // createTextVNode defaults to single whitespace, so if it is a
          // single space the code could be an empty call to save bytes.
          if (child.type !== NodeTypes.TEXT || child.content !== ' ') { // 节点类型不是文本 或 内容不是' '
            callArgs.push(child) // 调用参数推入这个子节点
          }

          // 用标志标记动态文本，以便在块内比对
          // mark dynamic text with flag so it gets patched inside a block
          if (
            !context.ssr && // 不是ssr
            getConstantType(child, context) === ConstantTypes.NOT_CONSTANT // 且常量类型是 不是常量
          ) {
            // 文本比对标记
            callArgs.push(
              PatchFlags.TEXT +
                (__DEV__ ? ` /* ${PatchFlagNames[PatchFlags.TEXT]} */` : ``)
            )
          }
          // 替换节点为文本调用节点
          children[i] = {
            type: NodeTypes.TEXT_CALL,
            content: child, // 原先的孩子节点
            loc: child.loc,
            // 它的codegenNode是一个调用表达式节点
            codegenNode: createCallExpression( // 创建CREATE_TEXT调用表达式节点
              context.helper(CREATE_TEXT), // callee - 调用者 - CREATE_TEXT
              callArgs // 参数
            )
          }
        }
      }
    }
  }
}
