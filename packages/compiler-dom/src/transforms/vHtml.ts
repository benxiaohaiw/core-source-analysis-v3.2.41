import {
  DirectiveTransform,
  createObjectProperty,
  createSimpleExpression
} from '@vue/compiler-core'
import { createDOMCompilerError, DOMErrorCodes } from '../errors'

export const transformVHtml: DirectiveTransform = (dir, node, context) => {
  const { exp, loc } = dir
  // 指令没有表达式报错
  if (!exp) {
    context.onError(
      createDOMCompilerError(DOMErrorCodes.X_V_HTML_NO_EXPRESSION, loc)
    )
  }
  // 使用v-html指令的节点有孩子也是报错的
  if (node.children.length) {
    context.onError(
      createDOMCompilerError(DOMErrorCodes.X_V_HTML_WITH_CHILDREN, loc)
    )
    node.children.length = 0
  }

  // 在transformElements.ts中处理的
  return {
    props: [
      createObjectProperty( // 创建对象属性
        createSimpleExpression(`innerHTML`, true, loc), // 创建简单表达式 - 是静态的
        exp || createSimpleExpression('', true) // 值为表达式 或 ''也是静态的
      )
    ]
  }
}
