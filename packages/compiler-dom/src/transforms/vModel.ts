import {
  transformModel as baseTransform,
  DirectiveTransform,
  ElementTypes,
  findProp,
  NodeTypes,
  hasDynamicKeyVBind
} from '@vue/compiler-core'
import { createDOMCompilerError, DOMErrorCodes } from '../errors'
import {
  V_MODEL_CHECKBOX,
  V_MODEL_RADIO,
  V_MODEL_SELECT,
  V_MODEL_TEXT,
  V_MODEL_DYNAMIC
} from '../runtimeHelpers'

export const transformModel: DirectiveTransform = (dir, node, context) => {
  const baseResult = baseTransform(dir, node, context)
  // 基础转换有错误或+++ 在组件上的v-model +++（只需要props）
  // base transform has errors OR component v-model (only need props)
  if (!baseResult.props.length || node.tagType === ElementTypes.COMPONENT) { // 没有属性 或者 +++节点标签类型是组件元素类型+++
    
    // +++
    // 这里直接返回 +++
    return baseResult
    // +++

  }

  if (dir.arg) {
    context.onError(
      createDOMCompilerError(
        DOMErrorCodes.X_V_MODEL_ARG_ON_ELEMENT,
        dir.arg.loc
      )
    )
  }

  function checkDuplicatedValue() {
    const value = findProp(node, 'value')
    if (value) {
      context.onError(
        createDOMCompilerError(
          DOMErrorCodes.X_V_MODEL_UNNECESSARY_VALUE,
          value.loc
        )
      )
    }
  }

  // +++
  // 下面针对的是元素input等 +++ 注意：不是组件，组件它在上面一步就已经return了，这一点要注意 +++
  // +++

  const { tag } = node
  const isCustomElement = context.isCustomElement(tag)
  if (
    tag === 'input' ||
    tag === 'textarea' ||
    tag === 'select' ||
    isCustomElement
  ) {

    // +++
    let directiveToUse = V_MODEL_TEXT // export const V_MODEL_TEXT = Symbol(__DEV__ ? `vModelText` : ``) -> ../runtimeHelpers.ts
    // +++

    let isInvalidType = false // 默认不是无效的类型
    if (tag === 'input' || isCustomElement) {
      const type = findProp(node, `type`)
      if (type) {
        if (type.type === NodeTypes.DIRECTIVE) {
          // :type="foo"
          directiveToUse = V_MODEL_DYNAMIC
        } else if (type.value) {
          switch (type.value.content) {
            case 'radio':
              directiveToUse = V_MODEL_RADIO
              break
            case 'checkbox':
              directiveToUse = V_MODEL_CHECKBOX
              break
            case 'file':
              isInvalidType = true
              context.onError(
                createDOMCompilerError(
                  DOMErrorCodes.X_V_MODEL_ON_FILE_INPUT_ELEMENT,
                  dir.loc
                )
              )
              break
            default:
              // text type
              __DEV__ && checkDuplicatedValue()
              break
          }
        }
      } else if (hasDynamicKeyVBind(node)) {
        // element has bindings with dynamic keys, which can possibly contain
        // "type".
        directiveToUse = V_MODEL_DYNAMIC
      } else {
        // text type
        __DEV__ && checkDuplicatedValue()
      }
    } else if (tag === 'select') {
      directiveToUse = V_MODEL_SELECT
    } else {
      // textarea
      __DEV__ && checkDuplicatedValue()
    }
    // 通过needRuntime返回helper symbol来注入运行时指令，导入将替换resolveDirective调用。
    // inject runtime directive
    // by returning the helper symbol via needRuntime
    // the import will replaced a resolveDirective call.
    if (!isInvalidType) { // 不是无效的类型
      
      // +++
      // 增加需要运行时V_MODEL_TEXT
      baseResult.needRuntime = context.helper(directiveToUse) // +++这是一个Symbol值+++
      // +++

    }
  } else {
    context.onError(
      createDOMCompilerError(
        DOMErrorCodes.X_V_MODEL_ON_INVALID_ELEMENT,
        dir.loc
      )
    )
  }

  // +++
  // 元素标签上使用v-model是不需要modelValue属性的，所下面进行过滤
  // +++

  // 原生vmodel不需要' modelValue 'props，因为它们也作为' binding.value '传递给运行时。删除它可以减少代码的大小。
  // native vmodel doesn't need the `modelValue` props since they are also
  // passed to the runtime as `binding.value`. removing it reduces code size.
  baseResult.props = baseResult.props.filter(
    p =>
      !(
        p.key.type === NodeTypes.SIMPLE_EXPRESSION &&
        p.key.content === 'modelValue'
      )
  ) // 过滤掉modelValue这个属性

  return baseResult
}
