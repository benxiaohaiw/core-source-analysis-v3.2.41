import { NodeTransform } from '../transform'
import { findDir } from '../utils'
import { ElementNode, ForNode, IfNode, NodeTypes } from '../ast'
import { SET_BLOCK_TRACKING } from '../runtimeHelpers'

const seen = new WeakSet()

// https://vuejs.org/api/built-in-directives.html#v-once
// 仅渲染元素和组件一次（这个在下面可以得知是把vnode给缓存起来了），并跳过以后的更新（如何体现）。
// 这个就在于runtime-core/src/vnode.ts中的setBlockTracking函数，它内部会使isBlockTreeEnabled+=value
// 而在于+++运行时中有关创建虚拟节点函数+++里面都会有这个判断就是isBlockTreeEnabled > 0为true才会进行收集当前所创建
// 号的vnode进入之前openBlock对应的dynamicChildren里面
// 那么这样就表示说明禁止收集到当前的vnode
// 那么也就是在之后更新中会去比对dynamicChildren，而dynamicChildren里面是没有这个vnode
// 所以也就表示vue3不管他了 - 也就是代表跳过它的更新 - 因为没有收集到
// 所以更新比对时也没有它，所以就处理不了它啦 ~
export const transformOnce: NodeTransform = (node, context) => {
  if (node.type === NodeTypes.ELEMENT && findDir(node, 'once', true)) {
    if (seen.has(node) || context.inVOnce) {
      return
    }
    seen.add(node) // 见过的set中存储这个节点
    // inVOnce -> 在v-once中
    context.inVOnce = true // 标记上下文中的inVOnce为true
    // 添加SET_BLOCK_TRACKING助手的名字
    context.helper(SET_BLOCK_TRACKING) // +++增加这个运行时助手+++
    // 返回一个退出函数
    return () => {
      context.inVOnce = false // 取消标记
      // 拿到此时的上下文中的当前node
      const cur = context.currentNode as ElementNode | IfNode | ForNode
      if (cur.codegenNode) { // 若节点已经有了codegen节点
        // 那么执行cache函数重新赋值

        // +++
        // true的意思
        // 告诉这个缓存表达式当前缓存的是vnode
        // 那么这样在codegen.ts中的genCacheExpression里面就会知道当前缓存的是vnode，那么会额外增加运行时函数SET_BLOCK_TRACKING（在上面已经添加啦）
        // 生成的就是如下这样的
        // _cache[下标] || (setBlockTracking(-1), _cache[下标] = vnode, setBlockTracking(1), _cache[下标])
        // +++
        cur.codegenNode = context.cache(cur.codegenNode, true /* isVNode */) // 返回一个缓存表达式（JS_CACHE_EXPRESSION）节点 - 节点中的value保存这个原先的cur.codegenNode
        // 它想要的是缓存该节点，下次render函数执行直接是从_cache缓存中获取即可啦
      }
    }
  }
}
