import { DirectiveTransform } from '../transform'
import {
  createSimpleExpression,
  createObjectProperty,
  createCompoundExpression,
  NodeTypes,
  Property,
  ElementTypes,
  ExpressionNode,
  ConstantTypes
} from '../ast'
import { createCompilerError, ErrorCodes } from '../errors'
import {
  isMemberExpression,
  isSimpleIdentifier,
  hasScopeRef,
  isStaticExp
} from '../utils'
import { IS_REF } from '../runtimeHelpers'
import { BindingTypes } from '../options'

// 转换model
export const transformModel: DirectiveTransform = (dir, node, context) => {
  const { exp, arg } = dir
  if (!exp) {
    context.onError(
      createCompilerError(ErrorCodes.X_V_MODEL_NO_EXPRESSION, dir.loc)
    )
    return createTransformProps()
  }

  // v-model="xxx"

  const rawExp = exp.loc.source
  // xxx
  const expString =
    exp.type === NodeTypes.SIMPLE_EXPRESSION ? exp.content : rawExp

  // im SFC <script setup> inline mode, the exp may have been transformed into
  // _unref(exp)
  const bindingType = context.bindingMetadata[rawExp] // sfc传入的绑定元数据中去查找rawExp
  // 可能ref
  const maybeRef =
    !__BROWSER__ &&
    context.inline &&
    bindingType &&
    bindingType !== BindingTypes.SETUP_CONST

  if (
    !expString.trim() || // 为空
    (!isMemberExpression(expString, context) && !maybeRef) // 或 不是成员表达式且不是可能ref
    // 报错
  ) {
    context.onError(
      createCompilerError(ErrorCodes.X_V_MODEL_MALFORMED_EXPRESSION, exp.loc)
    )
    return createTransformProps()
  }

  if (
    !__BROWSER__ &&
    context.prefixIdentifiers && // true
    isSimpleIdentifier(expString) && // 是简单的标识符
    context.identifiers[expString] // 在上下文中的标识符中取
    // 报错
  ) {
    context.onError(
      createCompilerError(ErrorCodes.X_V_MODEL_ON_SCOPE_VARIABLE, exp.loc)
    )
    return createTransformProps()
  }

  // 有参数那么就参数名 没有就是modelValue且是静态的
  const propName = arg ? arg : createSimpleExpression('modelValue', true) // 默认是modelValue且是静态的

  // 准备事件名字
  const eventName = arg
    ? isStaticExp(arg) // 有arg且是静态的
      ? `onUpdate:${arg.content}` // 直接拼接
      : createCompoundExpression(['"onUpdate:" + ', arg]) // 动态的则创建混合表达式 - 是为了在运行时能够拿到最终表示的值
    : `onUpdate:modelValue` // 没有arg直接onUpdate:modelValue

  // +++
  // 事件名字： onUpdate:modelValue
  // +++

  // 赋值表达式
  let assignmentExp: ExpressionNode
  // 准备事件参数
  const eventArg = context.isTS ? `($event: any)` : `$event` // 事件参数
  // 如果是可能的ref
  if (maybeRef) {
    if (bindingType === BindingTypes.SETUP_REF) { // 是ref
      // v-model被使用在已知的ref
      // v-model used on known ref.
      // 赋值表达式 - $event => ((xxx).value = $event)
      assignmentExp = createCompoundExpression([ // 创建混合表达式
        `${eventArg} => ((`,
        createSimpleExpression(rawExp, false, exp.loc), // 不是静态的
        `).value = $event)`
      ])
    } else {
      // v-model被使用在一个潜在的ref绑定在<script setup>内联模式中。
      // 这个赋值需要检查这个绑定是否实际上是一个ref。
      // v-model used on a potentially ref binding in <script setup> inline mode.
      // the assignment needs to check whether the binding is actually a ref.
      const altAssignment =
        // 是否为setup中的变量
        bindingType === BindingTypes.SETUP_LET ? `${rawExp} = $event` : `null`
      assignmentExp = createCompoundExpression([ // 创建复合表达式
        `${eventArg} => (${context.helperString(IS_REF)}(${rawExp}) ? (`,
        createSimpleExpression(rawExp, false, exp.loc), // 不是静态的
        `).value = $event : ${altAssignment})`
      ]) // $event => (isRef(xxx) ? (xxx).value = $event : xxx=$event | null)
    }
  } else {
    // 不是可能的ref
    assignmentExp = createCompoundExpression([
      `${eventArg} => ((`,
      exp,
      `) = $event)`
    ]) // 直接xxx = $event
    // 不需要在.value啦
  }

  // 准备属性数组
  const props = [
    // v-model="foo"

    // modelValue: foo
    createObjectProperty(propName, dir.exp!), // 创建对象属性
    // "onUpdate:modelValue": $event => (foo = $event)
    createObjectProperty(eventName, assignmentExp) // 创建对象属性
  ]

  // 缓存 v-model 处理程序（如果适用）（当它不引用任何范围变量时）
  // cache v-model handler if applicable (when it doesn't refer any scope vars)
  if (
    !__BROWSER__ &&
    context.prefixIdentifiers && // sfc true
    !context.inVOnce && // true
    context.cacheHandlers && // sfc true
    !hasScopeRef(exp, context.identifiers) // 没有引用上下文中的标识符
  ) {
    props[1].value = context.cache(props[1].value) // 创建缓存表达式节点
  }

  // 修饰符的处理
  // modelModifiers: { foo: true, "bar-baz": true }
  if (dir.modifiers.length && node.tagType === ElementTypes.COMPONENT) { // 有修饰符 且 当前节点标签类型为组件元素类型

    // 整合成foo: true, "bar-baz": true这种形式的字符串
    const modifiers = dir.modifiers
      .map(m => (isSimpleIdentifier(m) ? m : JSON.stringify(m)) + `: true`)
      .join(`, `)
    
    const modifiersKey = arg
      ? isStaticExp(arg) // 有参数且是静态的
        ? `${arg.content}Modifiers`
        // 动态的
        : createCompoundExpression([arg, ' + "Modifiers"']) // 创建混合表达式
      // 没有参数直接modelModifiers作为key
      : `modelModifiers`
    
    // modelModifiers

    props.push(
      createObjectProperty( // 创建对象属性
        modifiersKey, // 修饰符key
        createSimpleExpression( // 创建简单表达式
          `{ ${modifiers} }`, // 放在这里就形成{ foo: true, "bar-baz": true }
          false, // 不是静态的
          dir.loc,
          ConstantTypes.CAN_HOIST // 常量类型可以提升
        )
      )
    )
  }

  // 创建转换属性对象
  return createTransformProps(props) // { props }
}

// 创建转换属性
function createTransformProps(props: Property[] = []) {
  return { props }
}
