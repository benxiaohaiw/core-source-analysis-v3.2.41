import { DirectiveTransform, DirectiveTransformResult } from '../transform'
import {
  createCompoundExpression,
  createObjectProperty,
  createSimpleExpression,
  DirectiveNode,
  ElementTypes,
  ExpressionNode,
  NodeTypes,
  SimpleExpressionNode
} from '../ast'
import { camelize, toHandlerKey } from '@vue/shared'
import { createCompilerError, ErrorCodes } from '../errors'
import { processExpression } from './transformExpression'
import { validateBrowserExpression } from '../validateExpression'
import { hasScopeRef, isMemberExpression } from '../utils'
import { TO_HANDLER_KEY } from '../runtimeHelpers'

const fnExpRE =
  /^\s*([\w$_]+|(async\s*)?\([^)]*?\))\s*=>|^\s*(async\s+)?function(?:\s+[\w$]+)?\s*\(/

export interface VOnDirectiveNode extends DirectiveNode {
  // v-on without arg is handled directly in ./transformElements.ts due to it affecting
  // codegen for the entire props object. This transform here is only for v-on
  // *with* args.
  arg: ExpressionNode
  // exp is guaranteed to be a simple expression here because v-on w/ arg is
  // skipped by transformExpression as a special case.
  exp: SimpleExpressionNode | undefined
}

export const transformOn: DirectiveTransform = (
  dir,
  node,
  context,
  augmentor
) => {
  const { loc, modifiers, arg } = dir as VOnDirectiveNode
  // 没有指令表达式且没有修饰符
  if (!dir.exp && !modifiers.length) {
    context.onError(createCompilerError(ErrorCodes.X_V_ON_NO_EXPRESSION, loc))
  }
  let eventName: ExpressionNode
  if (arg.type === NodeTypes.SIMPLE_EXPRESSION) { // 是个简单表达式
    // 是否为静态参数
    if (arg.isStatic) {
      let rawName = arg.content // 参数的内容
      // TODO deprecate @vnodeXXX usage
      if (rawName.startsWith('vue:')) {
        rawName = `vnode-${rawName.slice(4)}`
      }
      // 生成事件字符串
      const eventString =
        node.tagType === ElementTypes.COMPONENT || // 节点标签类型是组件
        rawName.startsWith('vnode') || // 原生名字以vnode开始
        !/[A-Z]/.test(rawName) // 不是以大写字母开始的
            // 对于组件和vnode生命周期事件监听器，自动转换为骆驼化。
          ? // for component and vnode lifecycle event listeners, auto convert
            // it to camelCase. See issue #2249
            toHandlerKey(camelize(rawName)) // toHandlerKey函数执行
            // 为含有大写字母的普通元素侦听器保留大小写，因为这些侦听器可能是自定义元素的自定义事件
          : // preserve case for plain element listeners that have uppercase
            // letters, as these may be custom elements' custom events
            `on:${rawName}` // 'on:xxx'
      
      eventName = createSimpleExpression(eventString, true, arg.loc) // 创建简单表达式节点
    } else { // 动态参数
      // #2388
      eventName = createCompoundExpression([ // 创建复合表达式节点
        `${context.helperString(TO_HANDLER_KEY)}(`, // 助手
        arg, // 参数
        `)`
      ])
      // @[xxx]="x" -> eventName: 'toHandlerKey(xxx)'
    }
  } else {
    // 已经是复合表达式了。
    // already a compound expression.
    eventName = arg
    eventName.children.unshift(`${context.helperString(TO_HANDLER_KEY)}(`)
    eventName.children.push(`)`)
  }

  // 处理handler
  // handler processing
  // 指令的表达式
  let exp: ExpressionNode | undefined = dir.exp as
    | SimpleExpressionNode
    | undefined
  if (exp && !exp.content.trim()) { // exp为空
    exp = undefined
  }
  // @vue/compiler-sfc -> context.cacheHandlers: true
  let shouldCache: boolean = context.cacheHandlers && !exp && !context.inVOnce // v-once: 仅渲染元素和组件一次，并跳过以后的更新。
  // 是否应该缓存
  if (exp) {
    // exp是否为成员表达式
    const isMemberExp = isMemberExpression(exp.content, context) // 标识符也是成员表达式
    // 是否为内联语句
    // /^\s*([\w$_]+|(async\s*)?\([^)]*?\))\s*=>|^\s*(async\s+)?function(?:\s+[\w$]+)?\s*\(/ -> fnExpRE: 函数表达式正则
    
    // 注意： 成员表达式不是内联语句
    const isInlineStatement = !(isMemberExp || fnExpRE.test(exp.content)) // 函数表达式正则
    // 是否有多行语句
    const hasMultipleStatements = exp.content.includes(`;`) // 是否包含;

    // 处理表达式，因为它已被跳过
    // process the expression since it's been skipped
    if (!__BROWSER__ && context.prefixIdentifiers) {
      isInlineStatement && context.addIdentifiers(`$event`) // 增加标识符
      // 处理表达式
      exp = dir.exp = processExpression(
        exp,
        context,
        false,
        hasMultipleStatements
      )
      isInlineStatement && context.removeIdentifiers(`$event`) // 删除标识符

      // 使用作用域分析，如果函数没有引用作用域变量，则它是可提升的。
      // with scope analysis, the function is hoistable if it has no reference
      // to scope variables.
      shouldCache =
        context.cacheHandlers && // @vue/compiler-sfc -> context.cacheHandlers: true
        // 不需要在 v-once 中缓存
        // unnecessary to cache inside v-once
        !context.inVOnce &&
        // 运行时常量不需要缓存(这是由compileScript在SFC<script setup>中分析)
        // runtime constants don't need to be cached
        // (this is analyzed by compileScript in SFC <script setup>)
        !(exp.type === NodeTypes.SIMPLE_EXPRESSION && exp.constType > 0) && // handleClick -> true && false
        // 如果这是一个传递给组件的成员exp处理程序，请保释——我们需要使用原始函数来保留稀有度，
        // 例如:<transition>依赖于检查cb。长度确定过渡端处理。内联函数是可以的，因为它的一致性即使在缓存时也会被保留。

        // #1541 bail if this is a member exp handler passed to a component -
        // we need to use the original function to preserve arity,
        // e.g. <transition> relies on checking cb.length to determine
        // transition end handling. Inline function is ok since its arity
        // is preserved even when cached.
        !(isMemberExp && node.tagType === ElementTypes.COMPONENT) && // <Foo @xxx="yyy" /> -> false <button @click="xxx"></button> -> true
        // 保释，如果函数引用闭包变量(v-for, v-slot)，它必须以新鲜的方式传递，以避免过时的值。

        // bail if the function references closure variables (v-for, v-slot)
        // it must be passed fresh to avoid stale values.
        !hasScopeRef(exp, context.identifiers) // 在当前上下文标识符中没有作用域引用
      // If the expression is optimizable and is a member expression pointing
      // to a function, turn it into invocation (and wrap in an arrow function
      // below) so that it always accesses the latest value when called - thus
      // avoiding the need to be patched.
      // 如果表达式是可优化的，并且是指向函数的成员表达式，则将其转换为调用(并在下面封装一个箭头函数)，以便在调用时始终访问最新值——从而避免需要比对。

      /* 
      <button @click="xxx"></button>
      最终是应该缓存
      */

      // 应该缓存 且 是成员表达式
      if (shouldCache && isMemberExp) {
        if (exp.type === NodeTypes.SIMPLE_EXPRESSION) { // 表达式类型为简单表达式
          // 变为 xxx && xxx(...args)
          exp.content = `${exp.content} && ${exp.content}(...args)`
        } else {
          exp.children = [...exp.children, ` && `, ...exp.children, `(...args)`]
        }
      }
    }

    if (__DEV__ && __BROWSER__) {
      validateBrowserExpression(
        exp as SimpleExpressionNode,
        context,
        false,
        hasMultipleStatements
      )
    }

    // 注意： 成员表达式不是内联语句
    if (isInlineStatement || (shouldCache && isMemberExp)) {
      // 将内联语句包装在函数表达式中
      // wrap inline statement in a function expression
      exp = createCompoundExpression([ // 创建复合表达式
        `${
          isInlineStatement
            ? !__BROWSER__ && context.isTS
              ? `($event: any)`
              : `$event`
            : `${
                !__BROWSER__ && context.isTS ? `\n//@ts-ignore\n` : ``
              }(...args)`
        } => ${hasMultipleStatements ? `{` : `(`}`,
        exp,
        hasMultipleStatements ? `}` : `)`
      ]) // 生成一个箭头函数把内联语句包装进去
      /* 
      <button @click="xxx"></button>
      (...args) => (xxx && xxx(...args))
      */
    }
  }

  // 准备结果
  let ret: DirectiveTransformResult = {
    // 属性
    props: [
      createObjectProperty( // 创建对象属性
        eventName, // key
        exp || createSimpleExpression(`() => {}`, false, loc) // value
        // 没有表达式就是一个空的箭头函数
      )
    ]
  }

  // 应用扩展编译器增强器
  // apply extended compiler augmentor
  if (augmentor) {
    ret = augmentor(ret) // 执行函数参数传入的增强器函数
  }

  // 应该缓存
  if (shouldCache) {
    // 缓存处理程序，这样传递的总是相同的处理程序。这避免了用户在组件上使用内联处理程序时不必要的重新呈现。
    // cache handlers so that it's always the same handler being passed down.
    // this avoids unnecessary re-renders when users use inline handlers on
    // components.
    ret.props[0].value = context.cache(ret.props[0].value) // 返回缓存表达式节点 - 该节点的value为原先exp

    // +++
    // 变为缓存表达式节点
    // +++
  }

  // 为属性序列化检查作为handler标记key
  // mark the key as handler for props normalization check
  ret.props.forEach(p => (p.key.isHandlerKey = true)) // 给key加属性说isHandlerKey
  return ret
}
