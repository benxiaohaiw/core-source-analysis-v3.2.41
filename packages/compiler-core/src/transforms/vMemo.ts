import { NodeTransform } from '../transform'
import { findDir, makeBlock } from '../utils'
import {
  createCallExpression,
  createFunctionExpression,
  ElementTypes,
  MemoExpression,
  NodeTypes,
  PlainElementNode
} from '../ast'
import { WITH_MEMO } from '../runtimeHelpers'

const seen = new WeakSet() // 见过的集合

export const transformMemo: NodeTransform = (node, context) => {
  // 只处理节点类型为元素
  if (node.type === NodeTypes.ELEMENT) {
    // 查找节点属性为mome的指令
    const dir = findDir(node, 'memo')
    if (!dir || seen.has(node)) {
      return
    }
    seen.add(node) // 缓存

    // https://vuejs.org/api/built-in-directives.html#v-memo

    // 返回一个退出函数
    return () => {
      const codegenNode =
        node.codegenNode ||
        (context.currentNode as PlainElementNode).codegenNode
      
      if (codegenNode && codegenNode.type === NodeTypes.VNODE_CALL) {
        // 非组件子树应该变成块
        // non-component sub tree should be turned into a block
        if (node.tagType !== ElementTypes.COMPONENT) {
          // 节点的标签类型不是组件的那么需要给这个节点标记为block
          makeBlock(codegenNode, context)
        }
        // 创建一个WITH_MEMO的调用表达式节点
        // withMemo(exp, fn -> 返回的结果就是指令当前所在标记的vnode)
        node.codegenNode = createCallExpression(context.helper(WITH_MEMO), [
          dir.exp!, // 调用的参数
          // returns
          createFunctionExpression(undefined, codegenNode), // 创建函数表达式节点
          `_cache`,
          String(context.cached++)
        ]) as MemoExpression
      }
    }
  }
}
