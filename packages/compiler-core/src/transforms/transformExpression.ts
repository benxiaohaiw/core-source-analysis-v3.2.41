// - Parse expressions in templates into compound expressions so that each
//   identifier gets more accurate source-map locations.
//
// - Prefix identifiers with `_ctx.` or `$xxx` (for known binding types) so that
//   they are accessed from the right source
//
// - This transform is only applied in non-browser builds because it relies on
//   an additional JavaScript parser. In the browser, there is no source-map
//   support and the code is wrapped in `with (this) { ... }`.
import { NodeTransform, TransformContext } from '../transform'
import {
  NodeTypes,
  createSimpleExpression,
  ExpressionNode,
  SimpleExpressionNode,
  CompoundExpressionNode,
  createCompoundExpression,
  ConstantTypes
} from '../ast'
import {
  isInDestructureAssignment,
  isStaticProperty,
  isStaticPropertyKey,
  walkIdentifiers
} from '../babelUtils'
import { advancePositionWithClone, isSimpleIdentifier } from '../utils'
import {
  isGloballyWhitelisted,
  makeMap,
  hasOwn,
  isString,
  genPropsAccessExp
} from '@vue/shared'
import { createCompilerError, ErrorCodes } from '../errors'
import {
  Node,
  Identifier,
  AssignmentExpression,
  UpdateExpression
} from '@babel/types'
import { validateBrowserExpression } from '../validateExpression'
import { parse } from '@babel/parser'
import { IS_REF, UNREF } from '../runtimeHelpers'
import { BindingTypes } from '../options'

const isLiteralWhitelisted = /*#__PURE__*/ makeMap('true,false,null,this') // 是分词白名单

// 转换表达式
export const transformExpression: NodeTransform = (node, context) => {
  // 节点类型为插值类型节点
  if (node.type === NodeTypes.INTERPOLATION) {
    node.content = processExpression(
      node.content as SimpleExpressionNode,
      context
    )
  } else if (node.type === NodeTypes.ELEMENT) { // 元素类型节点
    // 在元素上处理指令
    // handle directives on element
    for (let i = 0; i < node.props.length; i++) {
      const dir = node.props[i]
      // 不处理 v-on 和 v-for，因为它们是特殊处理的
      // do not process for v-on & v-for since they are special handled
      if (dir.type === NodeTypes.DIRECTIVE && dir.name !== 'for') {
        const exp = dir.exp
        const arg = dir.arg
        // 如果这是v-on:arg，就不要处理exp -我们需要特殊处理来包装内联语句。
        // do not process exp if this is v-on:arg - we need special handling
        // for wrapping inline statements.
        if (
          exp &&
          exp.type === NodeTypes.SIMPLE_EXPRESSION &&
          !(dir.name === 'on' && arg)
        ) {
          dir.exp = processExpression(
            exp,
            context,
            // 插槽参数必须作为函数参数处理
            // slot args must be processed as function params
            dir.name === 'slot'
          )
        }
        if (arg && arg.type === NodeTypes.SIMPLE_EXPRESSION && !arg.isStatic) { // v-xxx:[]这种格式的
          dir.arg = processExpression(arg, context)
        }
      }
    }
  }
}

interface PrefixMeta {
  prefix?: string
  isConstant: boolean
  start: number
  end: number
  scopeIds?: Set<string>
}

// 重要：因为这个函数只使用Node.js的依赖项，所以它应该总是使用前导的!__BROWSER__检查，这样它就可以从浏览器构建中进行树摇。
// Important: since this function uses Node.js only dependencies, it should
// always be used with a leading !__BROWSER__ check so that it can be
// tree-shaken from the browser build.
export function processExpression(
  node: SimpleExpressionNode,
  context: TransformContext,
  // 像v-slot道具和v-for别名这样的表达式应该被解析为函数参数
  // some expressions like v-slot props & v-for aliases should be parsed as
  // function params
  asParams = false,
  // v-on 处理程序值可能包含多个语句
  // v-on handler values may contain multiple statements
  asRawStatements = false,
  localVars: Record<string, number> = Object.create(context.identifiers) // 此时上下文中的标识符
): ExpressionNode {
  if (__BROWSER__) {
    if (__DEV__) {
      // simple in-browser validation (same logic in 2.x)
      validateBrowserExpression(node, context, asParams, asRawStatements)
    }
    return node
  }

  if (!context.prefixIdentifiers || !node.content.trim()) {
    return node
  }

  // +++
  const { inline, bindingMetadata } = context

  // +++
  // 重写标识符
  const rewriteIdentifier = (raw: string, parent?: Node, id?: Identifier) => {
    const type = hasOwn(bindingMetadata, raw) && bindingMetadata[raw]
    // 是否有内联
    if (inline) {
      // x = y
      const isAssignmentLVal =
        parent && parent.type === 'AssignmentExpression' && parent.left === id
      // x++
      const isUpdateArg =
        parent && parent.type === 'UpdateExpression' && parent.argument === id
      // ({ x } = y)
      const isDestructureAssignment =
        parent && isInDestructureAssignment(parent, parentStack)

      if (
        type === BindingTypes.SETUP_CONST ||
        type === BindingTypes.SETUP_REACTIVE_CONST ||
        localVars[raw]
      ) {
        return raw
        
        // ***
        // 处理setup中的ref变量 - 这里额外加了个.value
        // ***

        // +++
      } else if (type === BindingTypes.SETUP_REF) { // ***setup中的ref***
        
        // +++
        // v-model的msg的.value就是在这里面加的
        // +++
        return `${raw}.value` // ***给其加上个.value***
        // +++

      } else if (type === BindingTypes.SETUP_MAYBE_REF) { // setup中可能ref
        // const binding that may or may not be ref
        // if it's not a ref, then assignments don't make sense -
        // so we ignore the non-ref assignment case and generate code
        // that assumes the value to be a ref for more efficiency
        return isAssignmentLVal || isUpdateArg || isDestructureAssignment
          ? `${raw}.value`
          : `${context.helperString(UNREF)}(${raw})`
      } else if (type === BindingTypes.SETUP_LET) { // setup中的变量
        if (isAssignmentLVal) {
          // let binding.
          // this is a bit more tricky as we need to cover the case where
          // let is a local non-ref value, and we need to replicate the
          // right hand side value.
          // x = y --> isRef(x) ? x.value = y : x = y
          const { right: rVal, operator } = parent as AssignmentExpression
          const rExp = rawExp.slice(rVal.start! - 1, rVal.end! - 1)
          const rExpString = stringifyExpression(
            processExpression(
              createSimpleExpression(rExp, false),
              context,
              false,
              false,
              knownIds
            )
          )
          return `${context.helperString(IS_REF)}(${raw})${
            context.isTS ? ` //@ts-ignore\n` : ``
          } ? ${raw}.value ${operator} ${rExpString} : ${raw}`
        } else if (isUpdateArg) {
          // make id replace parent in the code range so the raw update operator
          // is removed
          id!.start = parent!.start
          id!.end = parent!.end
          const { prefix: isPrefix, operator } = parent as UpdateExpression
          const prefix = isPrefix ? operator : ``
          const postfix = isPrefix ? `` : operator
          // let binding.
          // x++ --> isRef(a) ? a.value++ : a++
          return `${context.helperString(IS_REF)}(${raw})${
            context.isTS ? ` //@ts-ignore\n` : ``
          } ? ${prefix}${raw}.value${postfix} : ${prefix}${raw}${postfix}`
        } else if (isDestructureAssignment) {
          // TODO
          // let binding in a destructure assignment - it's very tricky to
          // handle both possible cases here without altering the original
          // structure of the code, so we just assume it's not a ref here
          // for now
          return raw
        } else {
          return `${context.helperString(UNREF)}(${raw})`
        }
      } else if (type === BindingTypes.PROPS) { // 属性
        // use __props which is generated by compileScript so in ts mode
        // it gets correct type
        return genPropsAccessExp(raw)
      } else if (type === BindingTypes.PROPS_ALIASED) { // 属性别名
        // prop with a different local alias (from defineProps() destructure)
        return genPropsAccessExp(bindingMetadata.__propsAliases![raw])
      }
    } else {
      if (type && type.startsWith('setup')) {
        // 在非内联模式下设置绑定
        // setup bindings in non-inline mode
        return `$setup.${raw}`
      } else if (type === BindingTypes.PROPS_ALIASED) {
        return `$props['${bindingMetadata.__propsAliases![raw]}']`
      } else if (type) {
        return `$${type}.${raw}`
      }
    }

    // 回退到 ctx
    // fallback to ctx
    return `_ctx.${raw}`
  }

  // 如果表达式是一个简单的标识符，则为快速路径。
  // fast path if expression is a simple identifier.
  const rawExp = node.content
  // parens（函数调用）和点（成员访问）上的保释常量
  // bail constant on parens (function invocation) and dot (member access)
  const bailConstant = rawExp.indexOf(`(`) > -1 || rawExp.indexOf('.') > 0

  // !/^\d|[^\$\w]/.test(name)
  if (isSimpleIdentifier(rawExp)) { // 是否为简单标识符
    // 是否为作用域变量引用
    const isScopeVarReference = context.identifiers[rawExp]
    // 是否合法的全局
    /* 
    const GLOBALS_WHITE_LISTED =
    'Infinity,undefined,NaN,isFinite,isNaN,parseFloat,parseInt,decodeURI,' +
    'decodeURIComponent,encodeURI,encodeURIComponent,Math,Number,Date,Array,' +
    'Object,Boolean,String,RegExp,Map,Set,JSON,Intl,BigInt'

    export const isGloballyWhitelisted = makeMap(GLOBALS_WHITE_LISTED)

    */
    const isAllowedGlobal = isGloballyWhitelisted(rawExp)
    // 是否为分词true,false,null,this
    const isLiteral = isLiteralWhitelisted(rawExp)
    if (!asParams && !isScopeVarReference && !isAllowedGlobal && !isLiteral) {
      // 在比对时可以跳过从setup中暴露的Const绑定，但不能提升到模块作用域
      // const bindings exposed from setup can be skipped for patching but
      // cannot be hoisted to module scope
      if (bindingMetadata[node.content] === BindingTypes.SETUP_CONST) { // 是否为setup中常量
        node.constType = ConstantTypes.CAN_SKIP_PATCH // 设置节点常量类型为可以跳过比对
      }
      // 对其内容做一个重写表达式
      node.content = rewriteIdentifier(rawExp)
    } else if (!isScopeVarReference) { // 不是作用域变量引用
      if (isLiteral) { // 是分词
        node.constType = ConstantTypes.CAN_STRINGIFY // 可以字符串化
      } else {
        node.constType = ConstantTypes.CAN_HOIST // 可提升
      }
    }
    return node // 直接返回此节点
  }

  let ast: any
  /* 
  Exp需要被不同的解析:
  1. 多个内联语句(v-on，带有';')：作为原始的exp进行解析，但确保用空格填充一致的范围
  2. 表达式：用括号括起来(例如对象表达式)
  3. 函数参数(v-for, v-slot)：放在函数参数的位置
  */
  // exp needs to be parsed differently:
  // 1. Multiple inline statements (v-on, with presence of `;`): parse as raw
  //    exp, but make sure to pad with spaces for consistent ranges
  // 2. Expressions: wrap with parens (for e.g. object expressions)
  // 3. Function arguments (v-for, v-slot): place in a function argument position
  const source = asRawStatements // 是否作为原生语句
    ? ` ${rawExp} `
    : `(${rawExp})${asParams ? `=>{}` : ``}` // 是否作为参数
  try {

    // 使用@babel/parser下的parse函数
    ast = parse(source, {
      plugins: context.expressionPlugins
    }).program
  } catch (e: any) {
    context.onError(
      createCompilerError(
        ErrorCodes.X_INVALID_EXPRESSION,
        node.loc,
        undefined,
        e.message
      )
    )
    return node
  }

  type QualifiedId = Identifier & PrefixMeta
  const ids: QualifiedId[] = []
  const parentStack: Node[] = []
  const knownIds: Record<string, number> = Object.create(context.identifiers)
  // 上下文中所知道的标识符

  // 迭代标识符
  walkIdentifiers(
    ast, // 解析的ast语法树
    (node, parent, _, isReferenced, isLocal) => { // isLocal的判断标准是knownIds中有没有此node.name
      if (isStaticPropertyKey(node, parent!)) {
        return
      }
      // v2 wrapped filter call
      if (__COMPAT__ && node.name.startsWith('_filter_')) {
        return
      }

      const needPrefix = isReferenced && canPrefix(node)
      if (needPrefix && !isLocal) { // 是前缀 且 不是本地的
        if (isStaticProperty(parent!) && parent.shorthand) {
          // 像 { foo } 这样的属性简写，我们需要添加key，因为我们重写这个值
          // property shorthand like { foo }, we need to add the key since
          // we rewrite the value
          ;(node as QualifiedId).prefix = `${node.name}: `
        }
        node.name = rewriteIdentifier(node.name, parent, node) // 重写标识符
        ids.push(node as QualifiedId) // 记录缓存

        // ***
        /* 
        setup
          const isShow = ref(true)
        template
          {{isShow ? 'show' : 'none'}} -> rewriteIdentifier -> isShow.value ? 'show' : 'none'
        */
       // ***

      } else {
        // The identifier is considered constant unless it's pointing to a
        // local scope variable (a v-for alias, or a v-slot prop)
        if (!(needPrefix && isLocal) && !bailConstant) {
          ;(node as QualifiedId).isConstant = true
        }
        // also generate sub-expressions for other identifiers for better
        // source map support. (except for property keys which are static)
        ids.push(node as QualifiedId)
      }
    },
    true, // invoke on ALL identifiers
    parentStack,
    knownIds
  )

  // 我们将复合表达式分解为一个字符串数组和子表达式(用于有前缀的标识符)。在代码生成中，如果ExpressionNode具有.children的属性，它将被用来代替'.content'。
  // We break up the compound expression into an array of strings and sub
  // expressions (for identifiers that have been prefixed). In codegen, if
  // an ExpressionNode has the `.children` property, it will be used instead of
  // `.content`.
  const children: CompoundExpressionNode['children'] = []
  ids.sort((a, b) => a.start - b.start)
  ids.forEach((id, i) => {
    // range is offset by -1 due to the wrapping parens when parsed
    const start = id.start - 1
    const end = id.end - 1
    const last = ids[i - 1]
    const leadingText = rawExp.slice(last ? last.end - 1 : 0, start)
    if (leadingText.length || id.prefix) {
      children.push(leadingText + (id.prefix || ``))
    }
    const source = rawExp.slice(start, end)
    children.push(
      // 推入一个简单表达式
      createSimpleExpression(
        id.name, // 它的名字 - isShow.value
        false,
        {
          source,
          start: advancePositionWithClone(node.loc.start, source, start),
          end: advancePositionWithClone(node.loc.start, source, end)
        },
        id.isConstant ? ConstantTypes.CAN_STRINGIFY : ConstantTypes.NOT_CONSTANT
      )
    )
    if (i === ids.length - 1 && end < rawExp.length) {
      children.push(rawExp.slice(end))
    }
  })

  let ret
  if (children.length) {
    // 创建复合表达式
    ret = createCompoundExpression(children, node.loc)
  } else {
    ret = node
    ret.constType = bailConstant
      ? ConstantTypes.NOT_CONSTANT
      : ConstantTypes.CAN_STRINGIFY
  }
  ret.identifiers = Object.keys(knownIds)
  return ret
}

function canPrefix(id: Identifier) {
  // skip whitelisted globals
  if (isGloballyWhitelisted(id.name)) {
    return false
  }
  // special case for webpack compilation
  if (id.name === 'require') {
    return false
  }
  return true
}

export function stringifyExpression(exp: ExpressionNode | string): string {
  if (isString(exp)) {
    return exp
  } else if (exp.type === NodeTypes.SIMPLE_EXPRESSION) {
    return exp.content
  } else {
    return (exp.children as (ExpressionNode | string)[])
      .map(stringifyExpression)
      .join('')
  }
}
