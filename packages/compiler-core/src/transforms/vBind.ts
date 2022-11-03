import { DirectiveTransform } from '../transform'
import {
  createObjectProperty,
  createSimpleExpression,
  ExpressionNode,
  NodeTypes
} from '../ast'
import { createCompilerError, ErrorCodes } from '../errors'
import { camelize } from '@vue/shared'
import { CAMELIZE } from '../runtimeHelpers'

// 不带参数的v-bind直接在./transformElements.ts中处理。因为它会影响整个props对象的代码生成。这里的转换只适用于带有args的v-bind。
// v-bind without arg is handled directly in ./transformElements.ts due to it affecting
// codegen for the entire props object. This transform here is only for v-bind
// *with* args.
export const transformBind: DirectiveTransform = (dir, _node, context) => {
  const { exp, modifiers, loc } = dir
  const arg = dir.arg! // 参数

  if (arg.type !== NodeTypes.SIMPLE_EXPRESSION) { // 参数类型不是简单表达式
    arg.children.unshift(`(`)
    arg.children.push(`) || ""`)
  } else if (!arg.isStatic) { // 是简单表达式 且 不是静态的
    arg.content = `${arg.content} || ""`
  }

  // .sync 被替换为 v-model:arg
  // .sync is replaced by v-model:arg
  if (modifiers.includes('camel')) { // 修饰符是否有骆驼
    if (arg.type === NodeTypes.SIMPLE_EXPRESSION) {
      if (arg.isStatic) {
        arg.content = camelize(arg.content)
      } else {
        arg.content = `${context.helperString(CAMELIZE)}(${arg.content})`
      }
    } else {
      arg.children.unshift(`${context.helperString(CAMELIZE)}(`)
      arg.children.push(`)`)
    }
  }

  if (!context.inSSR) {
    if (modifiers.includes('prop')) {
      injectPrefix(arg, '.') // 注入前缀
    }
    if (modifiers.includes('attr')) {
      injectPrefix(arg, '^') // 注入前缀
    }
  }

  if (
    !exp ||
    (exp.type === NodeTypes.SIMPLE_EXPRESSION && !exp.content.trim())
  ) {
    context.onError(createCompilerError(ErrorCodes.X_V_BIND_NO_EXPRESSION, loc))
    return {
      props: [createObjectProperty(arg, createSimpleExpression('', true, loc))]
    }
  }

  return {
    // :foo="fooo" -> foo为arg，fooo为exp
    props: [createObjectProperty(arg, exp)/** 创建对象属性表达式 */]
  }
}

// 注入前缀
const injectPrefix = (arg: ExpressionNode, prefix: string) => {
  if (arg.type === NodeTypes.SIMPLE_EXPRESSION) {
    if (arg.isStatic) {
      arg.content = prefix + arg.content // . | ^
    } else {
      arg.content = `\`${prefix}\${${arg.content}}\`` // 不是静态的
    }
  } else {
    arg.children.unshift(`'${prefix}' + (`)
    arg.children.push(`)`)
  }
}
