import {
  DirectiveTransform,
  createObjectProperty,
  createSimpleExpression,
  TO_DISPLAY_STRING,
  createCallExpression,
  getConstantType
} from '@vue/compiler-core'
import { createDOMCompilerError, DOMErrorCodes } from '../errors'

export const transformVText: DirectiveTransform = (dir, node, context) => {
  const { exp, loc } = dir
  // 指令没有表达式报错
  if (!exp) {
    context.onError(
      createDOMCompilerError(DOMErrorCodes.X_V_TEXT_NO_EXPRESSION, loc)
    )
  }
  //使用该指令但是有孩子也是要报错的
  if (node.children.length) {
    context.onError(
      createDOMCompilerError(DOMErrorCodes.X_V_TEXT_WITH_CHILDREN, loc)
    )
    node.children.length = 0
  }

  // 在transformElements.ts中处理的
  return {
    props: [
      createObjectProperty( // 创建对象表达式
        createSimpleExpression(`textContent`, true), // 创建简单表达式且是静态的
        exp // 是否有表达式
          ? getConstantType(exp, context) > 0 // 获取表达式的常量类型 > 0
            ? exp // 直接表达式 - 静态的话直接把其作为值即可啦 ~
            : createCallExpression( // 创建调用TO_DISPLAY_STRING表达式 - 目的就是为了动态的获取exp的值
                context.helperString(TO_DISPLAY_STRING), // callee
                [exp], // 其调用表达式的参数为exp
                loc
              )
          : createSimpleExpression('', true) // 没有表达式就是空串且是静态的
      )
    ]
  }
}
