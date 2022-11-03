import { NodeTransform, TransformContext } from '../transform'
import {
  NodeTypes,
  CallExpression,
  createCallExpression,
  ExpressionNode,
  SlotOutletNode,
  createFunctionExpression
} from '../ast'
import { isSlotOutlet, isStaticArgOf, isStaticExp } from '../utils'
import { buildProps, PropsExpression } from './transformElement'
import { createCompilerError, ErrorCodes } from '../errors'
import { RENDER_SLOT } from '../runtimeHelpers'
import { camelize } from '@vue/shared/'

// 转换插槽出口
export const transformSlotOutlet: NodeTransform = (node, context) => {
  // 节点类型为元素 且 标签类型为插槽
  /* 
  https://vuejs.org/api/built-in-special-elements.html#slot
  处理 <slot/>
  */
  if (isSlotOutlet(node)) {
    // 节点的孩子 - <slot><h2>张佳宁</h2></slot> -> children: <h2>张佳宁</h2>
    const { children, loc } = node
    // 插槽名字 插槽属性
    const { slotName, slotProps } = processSlotOutlet(node, context) // 处理插槽出口

    // 准备插槽参数
    const slotArgs: CallExpression['arguments'] = [
      // true -> _ctx.$slots
      context.prefixIdentifiers ? `_ctx.$slots` : `$slots`, // 这个是组件对应上下文中$slots它里面对应传给组件时的对应的插槽名和函数
      // 这样在renderSlots函数运行时里面就可以根据插槽名到传过来的插槽中找应该对应的vnode
      // 没有则使用这里代表默认要去显示vnode就可以啦
      // 这个renderSlots是在需要执行组件render函数时执行的，而render函数执行时会传入上下文，所以就能够获取相应的参数啦 ~
      slotName, // 当前所代表的插槽名字
      '{}', // 要给这个插槽传入的属性
      'undefined', // 默认显示的
      'true'
    ]
    let expectedLen = 2

    if (slotProps) {
      slotArgs[2] = slotProps
      expectedLen = 3
    }

    if (children.length) {
      // 创建函数表达式 - 返回的就是这个children
      slotArgs[3] = createFunctionExpression([], children, false, false, loc) // <h2>张佳宁</h2>
      expectedLen = 4
    }

    if (context.scopeId && !context.slotted) {
      expectedLen = 5
    }
    slotArgs.splice(expectedLen) // remove unused arguments
    // 移除没有使用的参数

    // +++
    // RENDER_SLOT
    node.codegenNode = createCallExpression( // 创建调用+++RENDER_SLOT+++表达式
      // +++
      context.helper(RENDER_SLOT), // +++
      slotArgs, // 调用表达式的参数
      loc
    )
  }
}

interface SlotOutletProcessResult {
  slotName: string | ExpressionNode
  slotProps: PropsExpression | undefined
}

export function processSlotOutlet(
  node: SlotOutletNode,
  context: TransformContext
): SlotOutletProcessResult {
  // 插槽名字 - 默认为default
  let slotName: string | ExpressionNode = `"default"`
  // 插槽属性
  let slotProps: PropsExpression | undefined = undefined

  const nonNameProps = []
  for (let i = 0; i < node.props.length; i++) {
    const p = node.props[i]
    if (p.type === NodeTypes.ATTRIBUTE) { // 属性
      if (p.value) {
        if (p.name === 'name') { // 名字属性
          slotName = JSON.stringify(p.value.content) // 插槽的名字
        } else {
          p.name = camelize(p.name)
          nonNameProps.push(p) // 不知道名字的属性
        }
      }
    } else { // 指令
      if (p.name === 'bind' && isStaticArgOf(p.arg, 'name')) { // 形如:name="xxx"
        if (p.exp) slotName = p.exp // 一个表达式 xxx
      } else {
        if (p.name === 'bind' && p.arg && isStaticExp(p.arg)) { // :xxx="yyy"
          p.arg.content = camelize(p.arg.content) // 对参数骆驼化
        }
        nonNameProps.push(p) // 不知道名字的属性
      }
    }
  }

  if (nonNameProps.length > 0) {
    const { props, directives } = buildProps( // 构建属性
      node,
      context,
      nonNameProps,
      false,
      false
    )
    slotProps = props // 重写赋值属性

    if (directives.length) {
      context.onError(
        createCompilerError(
          ErrorCodes.X_V_SLOT_UNEXPECTED_DIRECTIVE_ON_SLOT_OUTLET,
          directives[0].loc
        )
      )
    }
  }

  return {
    slotName, // 插槽名字
    slotProps // 插槽属性
  }
}
