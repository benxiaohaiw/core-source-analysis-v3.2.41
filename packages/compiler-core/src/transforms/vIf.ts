import {
  createStructuralDirectiveTransform,
  TransformContext,
  traverseNode
} from '../transform'
import {
  NodeTypes,
  ElementTypes,
  ElementNode,
  DirectiveNode,
  IfBranchNode,
  SimpleExpressionNode,
  createCallExpression,
  createConditionalExpression,
  createSimpleExpression,
  createObjectProperty,
  createObjectExpression,
  IfConditionalExpression,
  BlockCodegenNode,
  IfNode,
  createVNodeCall,
  AttributeNode,
  locStub,
  CacheExpression,
  ConstantTypes,
  MemoExpression
} from '../ast'
import { createCompilerError, ErrorCodes } from '../errors'
import { processExpression } from './transformExpression'
import { validateBrowserExpression } from '../validateExpression'
import { FRAGMENT, CREATE_COMMENT } from '../runtimeHelpers'
import {
  injectProp,
  findDir,
  findProp,
  isBuiltInType,
  makeBlock
} from '../utils'
import { PatchFlags, PatchFlagNames } from '@vue/shared'
import { getMemoedVNodeCall } from '..'

export const transformIf = createStructuralDirectiveTransform(
  /^(if|else|else-if)$/,
  (node, dir, context) => {
    // 执行处理if函数
    return processIf(node, dir, context, (ifNode, branch, isRoot) => { // if类型节点 当前if分支类型节点 是否是v-if
      // #1587: We need to dynamically increment the key based on the current
      // node's sibling nodes, since chained v-if/else branches are
      // rendered at the same depth
      const siblings = context.parent!.children
      let i = siblings.indexOf(ifNode)
      let key = 0
      while (i-- >= 0) {
        const sibling = siblings[i]
        if (sibling && sibling.type === NodeTypes.IF) {
          key += sibling.branches.length
        }
      }

      // 退出回调
      // 当所有的孩子已经被转换的时候完成这个codegenNode
      // Exit callback. Complete the codegenNode when all children have been
      // transformed.
      return () => {

        /* 
        注意：创建codegen node是在退出函数中去做的
        那么中间一定会继续traverseChildren，所以这样就能够保证children对应的codegen node的生成
        */

        if (isRoot) {
          // ifNode相当于是一个有关的根节点
          // 产生codegenNode // +++
          ifNode.codegenNode = createCodegenNodeForBranch( // 为if分支类型节点创建codegenNode
            branch,
            key,
            context
          ) as IfConditionalExpression // 产生一个条件表达式
        } else {
          // 将此分支的 codegen 节点附加到 v-if 根。
          // attach this branch's codegen node to the v-if root.
          const parentCondition = getParentCondition(ifNode.codegenNode!) // 获取父亲条件表达式
          // 替换父条件表达式的备用结果
          // 有可能是一个结果 或者为 再一个条件表达式
          parentCondition.alternate = createCodegenNodeForBranch(
            branch,
            key + ifNode.branches.length - 1,
            context
          )
        }
        /* 
        最终形成这样的代码
        条件1?结果1:条件2?结果2:结果3
        */
      }
    })
  }
)

// target-agnostic transform used for both Client and SSR
export function processIf(
  node: ElementNode,
  dir: DirectiveNode,
  context: TransformContext,
  processCodegen?: (
    node: IfNode,
    branch: IfBranchNode,
    isRoot: boolean
  ) => (() => void) | undefined
) {
  if (
    dir.name !== 'else' && // 指令不是else
    (!dir.exp || !(dir.exp as SimpleExpressionNode).content.trim()) // 且是v-if或v-if=""
  ) {
    const loc = dir.exp ? dir.exp.loc : node.loc
    context.onError(
      createCompilerError(ErrorCodes.X_V_IF_NO_EXPRESSION, dir.loc) // 产生错误
    )
    dir.exp = createSimpleExpression(`true`, false, loc)
  }

  if (!__BROWSER__ && context.prefixIdentifiers && dir.exp) {
    // dir.exp只能是简单表达式，因为在表达式转换之前应用了vIf转换。
    // dir.exp can only be simple expression because vIf transform is applied
    // before expression transform.
    // 处理表达式
    dir.exp = processExpression(dir.exp as SimpleExpressionNode, context)
  }

  if (__DEV__ && __BROWSER__ && dir.exp) {
    validateBrowserExpression(dir.exp as SimpleExpressionNode, context)
  }

  if (dir.name === 'if') { // 处理v-if
    // 创建if分支类型的节点
    const branch = createIfBranch(node, dir)
    const ifNode: IfNode = {
      type: NodeTypes.IF, // if节点类型
      loc: node.loc,
      branches: [branch] // 分支
    }
    // 替换节点 - 对应操作context.parent!.children[context.childIndex] = context.currentNode = node
    context.replaceNode(ifNode)
    if (processCodegen) {
      // 执行传入的函数
      return processCodegen(ifNode, branch, true)
    }
  } else { // v-else-if | v-else啦
    // 定位相邻的 v-if
    // locate the adjacent v-if
    const siblings = context.parent!.children // 拿到当前节点的父节点的所有孩子节点
    const comments = []
    let i = siblings.indexOf(node) // 在孩子节点中查找当前节点所处的下标
    // 倒序枚举当前节点的上方兄弟节点
    while (i-- >= -1) {
      // 取出上方兄弟节点
      const sibling = siblings[i]
      if (__DEV__ && sibling && sibling.type === NodeTypes.COMMENT) {
        context.removeNode(sibling)
        comments.unshift(sibling)
        continue
      }

      if (
        sibling &&
        sibling.type === NodeTypes.TEXT &&
        !sibling.content.trim().length
      ) {
        context.removeNode(sibling)
        continue
      }

      // 上方兄弟节点类型是if类型节点 - 因为是上方的兄弟节点，所以说在处理当前节点之前，上方的兄弟节点已经被处理过了的
      if (sibling && sibling.type === NodeTypes.IF) {
        // 检查 v-else 后面是否跟着 v-else-if
        // Check if v-else was followed by v-else-if
        if (
          dir.name === 'else-if' && // 当前指令是v-else-if
          sibling.branches[sibling.branches.length - 1].condition === undefined // 且上方紧挨着的兄弟if节点的branches最后一个分支的condition
          // 是否是undefined，若是那么就说明紧挨着的这个if节点是一个v-else
          // 而它的后面是不能在跟继续条件的，所以就报错啦 ~
        ) {
          context.onError(
            createCompilerError(ErrorCodes.X_V_ELSE_NO_ADJACENT_IF, node.loc)
          )
        }

        /* 
        v-if - 只有这个节点是被替换为if类型节点
        // 而下面的这些在处理的时候全部都被删除了，所以它们处理时找到的前面的紧挨着的又是if类型节点那么就只能是v-if替换的那个if类型节点（它相当于根）
        // 换种角度考虑条件分支最终是只能执行一个分支的，所以这里也就只能保留一个节点
        // 而其他的分支节点都是被移动到了根if节点的branches中保存着了
        v-else-if
        v-else-if
        v-else
        */

        // 将节点移动到 if 节点的分支
        // move the node to the if node's branches
        // 在children中删除此节点
        context.removeNode()
        // 根据这个节点创建if分支类型节点
        const branch = createIfBranch(node, dir)
        if (
          __DEV__ &&
          comments.length &&
          // #3619 ignore comments if the v-if is direct child of <transition>
          !(
            context.parent &&
            context.parent.type === NodeTypes.ELEMENT &&
            isBuiltInType(context.parent.tag, 'transition')
          )
        ) {
          branch.children = [...comments, ...branch.children]
        }

        // 检查用户是否在不同的分支上强制使用相同的key
        // check if user is forcing same key on different branches
        if (__DEV__ || !__BROWSER__) {
          const key = branch.userKey
          if (key) {
            sibling.branches.forEach(({ userKey }) => {
              if (isSameKey(userKey, key)) { // 是否是相同的key
                context.onError(
                  createCompilerError(
                    ErrorCodes.X_V_IF_SAME_KEY,
                    branch.userKey!.loc
                  )
                )
              }
            })
          }
        }

        // 给紧挨着的上的兄弟if类型节点中的分支数组中推入这个if分支类型节点
        sibling.branches.push(branch)
        // 也是执行回调函数
        const onExit = processCodegen && processCodegen(sibling, branch, false)
        // 因为该分支被删除了，所以它将不会被遍历。一定要从这里穿过。
        // since the branch was removed, it will not be traversed.
        // make sure to traverse here.
        traverseNode(branch, context) // 迭代if分支类型节点
        // call on exit
        if (onExit) onExit() // 调用返回的退出函数
        // 确保在遍历之后重置currentNode，以表示该节点已被删除。
        // make sure to reset currentNode after traversal to indicate this
        // node has been removed.
        context.currentNode = null // 让当前节点置为null
      } else {
        // 报错
        // 这里的报错能够表示必须是紧挨着的
        /* 
        v-if
        v-else

        这样的就直接报这个错误了
        v-if
        xxx
        v-else
        */
        context.onError(
          // 错误的意思就是没有邻近的紧挨着的if
          createCompilerError(ErrorCodes.X_V_ELSE_NO_ADJACENT_IF, node.loc)
        )
      }
      break
    }
  }
}

// 创建if分支类型节点
function createIfBranch(node: ElementNode, dir: DirectiveNode): IfBranchNode {
  // 是在<template>上的v-if
  const isTemplateIf = node.tagType === ElementTypes.TEMPLATE // 节点的标签类型是否为template，如果是且有if系列指令那么就说明是template上的if // +++
  return {
    type: NodeTypes.IF_BRANCH, // if分支节点类型
    loc: node.loc,
    // 条件
    condition: dir.name === 'else' ? undefined : dir.exp,
    // 孩子
    // 它的孩子取决于这个条件isTemplateIf && !findDir(node, 'for')，条件成立则直接使用它的children，不成立则使用该node节点本身 // +++
    children: isTemplateIf && !findDir(node, 'for') ? node.children : [node], // 是模板if且节点没有for指令则直接节点的孩子否则直接[node]
    // 查找当前节点是否有key属性
    userKey: findProp(node, `key`),
    isTemplateIf // 是模板上的if
    // 是否为template上的if // +++
  }
}

// 为分支创建codegenNode
function createCodegenNodeForBranch(
  branch: IfBranchNode,
  keyIndex: number,
  context: TransformContext
): IfConditionalExpression | BlockCodegenNode | MemoExpression {
  // v-if | v-else-if
  if (branch.condition) { // 有条件的
    // 创建条件表达式
    // 条件?结果:备用结果
    return createConditionalExpression(
      branch.condition, // 条件
      createChildrenCodegenNode(branch, keyIndex, context), // 条件成功的结果
      // make sure to pass in asBlock: true so that the comment node call
      // closes the current block.
      // 备用结果是一个注释 - createComment运行时 // +++
      createCallExpression(context.helper(CREATE_COMMENT), [ // 创建注释 - 作为条件失败的备用结果
        __DEV__ ? '"v-if"' : '""',
        'true'
      ])
    ) as IfConditionalExpression
  } else {
    // v-else
    return createChildrenCodegenNode(branch, keyIndex, context) // 结果
  }
}

// 创建孩子的codegen node
function createChildrenCodegenNode(
  branch: IfBranchNode,
  keyIndex: number,
  context: TransformContext
): BlockCodegenNode | MemoExpression {
  const { helper } = context
  // 创建对象属性 - {key}
  const keyProperty = createObjectProperty(
    `key`,
    createSimpleExpression(
      `${keyIndex}`,
      false,
      locStub,
      ConstantTypes.CAN_HOIST
    )
  )
  const { children } = branch // 分支节点对应的原先节点
  const firstChild = children[0]

  // ---
  // 当前这个逻辑是在退出函数中做的
  // 所以中间已经对孩子处理过了
  // ---

  // 是否需要fragment包裹
  const needFragmentWrapper =
    children.length !== 1 || firstChild.type !== NodeTypes.ELEMENT // 孩子长度不为1 或 第一个孩子节点类型不是元素节点类型

  /* 
  <template v-if="xxx">
    <h2>111</h2>
    <h3>222</h3>
  </template>
  则需要fragment进行包裹
  那么他在createIfBranch函数中的children就是template节点的children，所以这里的fragment的创建vnode函数调用表达式的children就是template节点的children
  // 这个fragment是块，不是组件，且不禁用收集同时是一个标准fragment，那么所以最终就是openBlock(), createElementBlock(...)
  // 所以就是说直接在产生vnode时没有template的vnode
  */
  if (needFragmentWrapper) {
    if (children.length === 1 && firstChild.type === NodeTypes.FOR) { // vFor.ts中会去替换节点的
      // 当 child 是 ForNode 时优化嵌套fragments
      // optimize away nested fragments when child is a ForNode
      const vnodeCall = firstChild.codegenNode!
      injectProp(vnodeCall, keyProperty, context) // 注入key属性
      return vnodeCall
    } else {
      let patchFlag = PatchFlags.STABLE_FRAGMENT
      let patchFlagText = PatchFlagNames[PatchFlags.STABLE_FRAGMENT]
      // check if the fragment actually contains a single valid child with
      // the rest being comments
      if (
        __DEV__ &&
        !branch.isTemplateIf &&
        children.filter(c => c.type !== NodeTypes.COMMENT).length === 1
      ) {
        patchFlag |= PatchFlags.DEV_ROOT_FRAGMENT
        patchFlagText += `, ${PatchFlagNames[PatchFlags.DEV_ROOT_FRAGMENT]}`
      }

      // fragment
      return createVNodeCall(
        context,
        helper(FRAGMENT),
        createObjectExpression([keyProperty]), // 属性有一个key属性
        children, // children
        patchFlag + (__DEV__ ? ` /* ${patchFlagText} */` : ``), // 标准fragment
        undefined,
        undefined,
        true, // 是块
        false,
        false /* isComponent */,
        branch.loc
      )
    }
  } else {
    // 读取原先节点的生成的codegen node
    const ret = (firstChild as ElementNode).codegenNode as
      | BlockCodegenNode
      | MemoExpression
    // 大概率会得到还是ret
    const vnodeCall = getMemoedVNodeCall(ret)
    // 改变createVNode为createBlock
    // Change createVNode to createBlock.
    if (vnodeCall.type === NodeTypes.VNODE_CALL) { // 查看节点类型是不是VNODE_CALL
      // 把其标记为块
      makeBlock(vnodeCall, context)
    }
    // 给这个vnodeCall注入分支key属性
    // inject branch key
    injectProp(vnodeCall, keyProperty, context)
    return ret
  }
}

function isSameKey(
  a: AttributeNode | DirectiveNode | undefined,
  b: AttributeNode | DirectiveNode
): boolean {
  if (!a || a.type !== b.type) {
    return false
  }
  if (a.type === NodeTypes.ATTRIBUTE) {
    if (a.value!.content !== (b as AttributeNode).value!.content) {
      return false
    }
  } else {
    // directive
    const exp = a.exp!
    const branchExp = (b as DirectiveNode).exp!
    if (exp.type !== branchExp.type) {
      return false
    }
    if (
      exp.type !== NodeTypes.SIMPLE_EXPRESSION ||
      exp.isStatic !== (branchExp as SimpleExpressionNode).isStatic ||
      exp.content !== (branchExp as SimpleExpressionNode).content
    ) {
      return false
    }
  }
  return true
}

// 获取父条件表达式
function getParentCondition(
  node: IfConditionalExpression | CacheExpression
): IfConditionalExpression {
  while (true) {
    if (node.type === NodeTypes.JS_CONDITIONAL_EXPRESSION) {
      if (node.alternate.type === NodeTypes.JS_CONDITIONAL_EXPRESSION) { // 会是注释的调用表达式
        node = node.alternate // 若还是那么需要替换为这个条件表达式
      } else {
        return node // 所以直接返回父条件表达式
      }
    } else if (node.type === NodeTypes.JS_CACHE_EXPRESSION) {
      node = node.value as IfConditionalExpression
    }
  }
}
