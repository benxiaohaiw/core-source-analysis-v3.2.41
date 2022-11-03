import { DirectiveTransform } from '@vue/compiler-core'
import { createDOMCompilerError, DOMErrorCodes } from '../errors'
import { V_SHOW } from '../runtimeHelpers'

export const transformShow: DirectiveTransform = (dir, node, context) => {
  const { exp, loc } = dir
  // 没有表达式报错
  if (!exp) {
    context.onError(
      createDOMCompilerError(DOMErrorCodes.X_V_SHOW_NO_EXPRESSION, loc)
    )
  }

  return {
    props: [], // 没有属性
    needRuntime: context.helper(V_SHOW) // +++需要V_SHOW运行时指令+++
  }
}
