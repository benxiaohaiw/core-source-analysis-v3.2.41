import { CodegenOptions } from './options'
import {
  RootNode,
  TemplateChildNode,
  TextNode,
  CommentNode,
  ExpressionNode,
  NodeTypes,
  JSChildNode,
  CallExpression,
  ArrayExpression,
  ObjectExpression,
  Position,
  InterpolationNode,
  CompoundExpressionNode,
  SimpleExpressionNode,
  FunctionExpression,
  ConditionalExpression,
  CacheExpression,
  locStub,
  SSRCodegenNode,
  TemplateLiteral,
  IfStatement,
  AssignmentExpression,
  ReturnStatement,
  VNodeCall,
  SequenceExpression
} from './ast'
import { SourceMapGenerator, RawSourceMap } from 'source-map'
import {
  advancePositionWithMutation,
  assert,
  getVNodeBlockHelper,
  getVNodeHelper,
  isSimpleIdentifier,
  toValidAssetId
} from './utils'
import { isString, isArray, isSymbol } from '@vue/shared'
import {
  helperNameMap,
  TO_DISPLAY_STRING,
  CREATE_VNODE,
  RESOLVE_COMPONENT,
  RESOLVE_DIRECTIVE,
  SET_BLOCK_TRACKING,
  CREATE_COMMENT,
  CREATE_TEXT,
  PUSH_SCOPE_ID,
  POP_SCOPE_ID,
  WITH_DIRECTIVES,
  CREATE_ELEMENT_VNODE,
  OPEN_BLOCK,
  CREATE_STATIC,
  WITH_CTX,
  RESOLVE_FILTER
} from './runtimeHelpers'
import { ImportItem } from './transform'

const PURE_ANNOTATION = `/*#__PURE__*/`

const aliasHelper = (s: symbol) => `${helperNameMap[s]}: _${helperNameMap[s]}`

type CodegenNode = TemplateChildNode | JSChildNode | SSRCodegenNode

export interface CodegenResult {
  code: string
  preamble: string
  ast: RootNode
  map?: RawSourceMap
}

export interface CodegenContext
  extends Omit<Required<CodegenOptions>, 'bindingMetadata' | 'inline'> {
  source: string
  code: string
  line: number
  column: number
  offset: number
  indentLevel: number
  pure: boolean
  map?: SourceMapGenerator
  helper(key: symbol): string
  push(code: string, node?: CodegenNode): void
  indent(): void
  deindent(withoutNewLine?: boolean): void
  newline(): void
}

// 创建codegen上下文
function createCodegenContext(
  ast: RootNode,
  {
    mode = 'function',
    prefixIdentifiers = mode === 'module',
    sourceMap = false,
    filename = `template.vue.html`,
    scopeId = null,
    optimizeImports = false,
    runtimeGlobalName = `Vue`,
    runtimeModuleName = `vue`,
    ssrRuntimeModuleName = 'vue/server-renderer',
    ssr = false,
    isTS = false,
    inSSR = false
  }: CodegenOptions
): CodegenContext {
  const context: CodegenContext = {
    mode,
    prefixIdentifiers,
    sourceMap,
    filename,
    scopeId,
    optimizeImports,
    runtimeGlobalName,
    runtimeModuleName,
    ssrRuntimeModuleName,
    ssr,
    isTS,
    inSSR,
    source: ast.loc.source,
    code: ``, // 最终生成的代码
    column: 1,
    line: 1,
    offset: 0,
    indentLevel: 0,
    pure: false,
    map: undefined,
    helper(key) {
      return `_${helperNameMap[key]}`
    },
    push(code, node) {
      context.code += code
      if (!__BROWSER__ && context.map) {
        if (node) {
          let name
          if (node.type === NodeTypes.SIMPLE_EXPRESSION && !node.isStatic) {
            const content = node.content.replace(/^_ctx\./, '')
            if (content !== node.content && isSimpleIdentifier(content)) {
              name = content
            }
          }
          addMapping(node.loc.start, name)
        }
        advancePositionWithMutation(context, code)
        if (node && node.loc !== locStub) {
          addMapping(node.loc.end)
        }
      }
    },
    indent() {
      newline(++context.indentLevel)
    },
    deindent(withoutNewLine = false) {
      if (withoutNewLine) {
        --context.indentLevel
      } else {
        newline(--context.indentLevel)
      }
    },
    newline() {
      newline(context.indentLevel)
    }
  }

  function newline(n: number) {
    context.push('\n' + `  `.repeat(n))
  }

  function addMapping(loc: Position, name?: string) {
    context.map!.addMapping({
      name,
      source: context.filename,
      original: {
        line: loc.line,
        column: loc.column - 1 // source-map column is 0 based
      },
      generated: {
        line: context.line,
        column: context.column - 1
      }
    })
  }

  if (!__BROWSER__ && sourceMap) {
    // lazy require source-map implementation, only in non-browser builds
    context.map = new SourceMapGenerator()
    context.map!.setSourceContent(filename, context.source)
  }

  return context
}

// 生成
export function generate(
  ast: RootNode,
  options: CodegenOptions & {
    onContextCreated?: (context: CodegenContext) => void
  } = {}
): CodegenResult {
  // 创建codegen上下文
  const context = createCodegenContext(ast, options) // 其中context.code是保存代码的变量

  // 执行上下文已创建钩子函数
  if (options.onContextCreated) options.onContextCreated(context)
  
  const {
    mode, // 模式
    push, // push函数
    prefixIdentifiers,
    indent,
    deindent,
    newline,
    scopeId,
    ssr
  } = context

  // 是否有助手
  const hasHelpers = ast.helpers.length > 0
  // 是否使用with块 - with() {}
  const useWithBlock = !prefixIdentifiers && mode !== 'module'
  // 是否生成作用域id
  const genScopeId = !__BROWSER__ && scopeId != null && mode === 'module'
  // 是否是setup内联 - <script setup>
  const isSetupInlined = !__BROWSER__ && !!options.inline

  // 前言
  // 在setup()内联模式下，在子上下文中生成前言并分别返回。
  // preambles
  // in setup() inline mode, the preamble is generated in a sub context
  // and returned separately.
  const preambleContext = isSetupInlined // 是setup内联模式
    ? createCodegenContext(ast, options) // 再次创建一个上下文 - 作为子上下文
    : context // 否则直接使用上面的上下文
  
  if (!__BROWSER__ && mode === 'module') { // 这个是在node.js下
    // +++
    // 生成模块前言
    // +++
    genModulePreamble(ast, preambleContext, genScopeId, isSetupInlined)
  } else { // 这个是在浏览器端
    // 生成函数前言
    genFunctionPreamble(ast, preambleContext)
  }

  // 进入render函数
  // enter render function
  const functionName = ssr ? `ssrRender` : `render` // 函数名render
  // 准备render函数的参数
  const args = ssr ? ['_ctx', '_push', '_parent', '_attrs'] : ['_ctx', '_cache']

  if (!__BROWSER__ && options.bindingMetadata && !options.inline) { // node端 且有绑定的元数据 且 不是内联模式
    // 绑定优化参数
    // binding optimization args
    args.push('$props', '$setup', '$data', '$options')
  }
  // 根据参数生成签名
  const signature =
    !__BROWSER__ && options.isTS
      ? args.map(arg => `${arg}: any`).join(',')
      : args.join(', ')

      // 是setup内联
  if (isSetupInlined) {
    push(`(${signature}) => {`) // (_ctx, _cache) => {
  } else {
    push(`function ${functionName}(${signature}) {`) // function render(_ctx, _cache)
  }
  indent() // 缩进

  // 需要使用with块
  if (useWithBlock) {
    push(`with (_ctx) {`) // with (_ctx) {
    indent() // 缩进
    // 函数模式的const声明应该在块内部，而且它们应该重命名，以避免与用户属性冲突
    // function mode const declarations should be inside with block
    // also they should be renamed to avoid collision with user properties

    if (hasHelpers) { // 是否有助手
      push(`const { ${ast.helpers.map(aliasHelper).join(', ')} } = _Vue`) // 函数模式下让所需要的助手从_Vue中解构赋值
      // 如：const { toDisplayString: _toDisplayString, createElementVNode: _createElementVNode, Fragment: _Fragment, openBlock: _openBlock, createElementBlock: _createElementBlock } = _Vue
      push(`\n`) // \n换行
      newline() // 新的一行
    }
  }


  // const xxx = resolveComponent(...)
  // 生成资源resolve语句
  // generate asset resolution statements
  if (ast.components.length) {
    genAssets(ast.components, 'component', context) // 生成component资源
    if (ast.directives.length || ast.temps > 0) {
      newline() /// 是否新的一行
    }
  }
  // const xxx = resolveDirective(...)
  // 生成指令resolve语句
  if (ast.directives.length) {
    genAssets(ast.directives, 'directive', context)
    if (ast.temps > 0) {
      newline()
    }
  }

  // 是否开启兼容 - 生成filter
  if (__COMPAT__ && ast.filters && ast.filters.length) {
    newline()
    genAssets(ast.filters, 'filter', context)
    newline()
  }

  // 缓存
  if (ast.temps > 0) {
    push(`let `)
    for (let i = 0; i < ast.temps; i++) {
      push(`${i > 0 ? `, ` : ``}_temp${i}`)
    }
  }


  if (ast.components.length || ast.directives.length || ast.temps) {
    push(`\n`)
    newline()
  }

  // 生成 VNode 树表达式
  // generate the VNode tree expression
  if (!ssr) {
    push(`return `) // return 
  }
  if (ast.codegenNode) { // 有codegenNode那么生成这个节点

    // +++
    genNode(ast.codegenNode, context) // VNode 树表达式的生成从这里开始
    // +++
    
  } else {
    push(`null`) // 没有直接null
  }

  // with的结尾}
  if (useWithBlock) {
    deindent()
    push(`}`)
  }

  deindent()
  push(`}`) // 推一个}

  return {
    ast,
    code: context.code,
    preamble: isSetupInlined ? preambleContext.code : ``,
    // SourceMapGenerator does have toJSON() method but it's not in the types
    map: context.map ? (context.map as any).toJSON() : undefined
  }
}

function genFunctionPreamble(ast: RootNode, context: CodegenContext) {
  const {
    ssr,
    prefixIdentifiers,
    push,
    newline,
    runtimeModuleName,
    runtimeGlobalName,
    ssrRuntimeModuleName
  } = context

  // Vue
  const VueBinding =
    !__BROWSER__ && ssr
      ? `require(${JSON.stringify(runtimeModuleName)})`
      : runtimeGlobalName // Vue
  // Generate const declaration for helpers
  // In prefix mode, we place the const declaration at top so it's done
  // only once; But if we not prefixing, we place the declaration inside the
  // with block so it doesn't incur the `in` check cost for every helper access.
  // 有助手
  if (ast.helpers.length > 0) {
    if (!__BROWSER__ && prefixIdentifiers) {
      push(
        `const { ${ast.helpers.map(aliasHelper).join(', ')} } = ${VueBinding}\n`
      )
    } else {
      // with模式
      // "with" mode.
      // save Vue in a separate variable to avoid collision
      // const _Vue = Vue
      push(`const _Vue = ${VueBinding}\n`)
      // in "with" mode, helpers are declared inside the with block to avoid
      // has check cost, but hoists are lifted out of the function - we need
      // to provide the helper here.
      // +++
      // 是否有需要提升的
      if (ast.hoists.length) {
        const staticHelpers = [ // 默认的静态助手
          CREATE_VNODE, // 创建虚拟节点
          CREATE_ELEMENT_VNODE, // 创建元素虚拟节点
          CREATE_COMMENT, // 创建注释
          CREATE_TEXT, // 创建文本
          CREATE_STATIC // 创建文本
        ]
          .filter(helper => ast.helpers.includes(helper)) // 过滤出静态助手在当前是需要的
          .map(aliasHelper)
          .join(', ') // 整合成字符串
        push(`const { ${staticHelpers} } = _Vue\n`) // 再次的解构赋值
      }
    }
  }
  // generate variables for ssr helpers
  if (!__BROWSER__ && ast.ssrHelpers && ast.ssrHelpers.length) {
    // ssr guarantees prefixIdentifier: true
    push(
      `const { ${ast.ssrHelpers
        .map(aliasHelper)
        .join(', ')} } = require("${ssrRuntimeModuleName}")\n`
    )
  }
  genHoists(ast.hoists, context) // 生成提升
  newline() // 新的一行
  push(`return `) // return 
}

// 生成模块前言
function genModulePreamble(
  ast: RootNode,
  context: CodegenContext,
  genScopeId: boolean,
  inline?: boolean
) {
  const {
    push,
    newline,
    optimizeImports,
    runtimeModuleName,
    ssrRuntimeModuleName
  } = context

  // 需要生成作用域id且有需要提升的
  if (genScopeId && ast.hoists.length) {
    ast.helpers.push(PUSH_SCOPE_ID, POP_SCOPE_ID) // 再加PUSH_SCOPE_ID, POP_SCOPE_ID助手
  }

  // 为助手生成import语句
  // generate import statements for helpers
  if (ast.helpers.length) {
    if (optimizeImports) { // 是否有优化的导入
      // when bundled with webpack with code-split, calling an import binding
      // as a function leads to it being wrapped with `Object(a.b)` or `(0,a.b)`,
      // incurring both payload size increase and potential perf overhead.
      // therefore we assign the imports to variables (which is a constant ~50b
      // cost per-component instead of scaling with template size)
      push(
        `import { ${ast.helpers
          .map(s => helperNameMap[s])
          .join(', ')} } from ${JSON.stringify(runtimeModuleName)}\n`
      ) // import { xxx } from 'Vue'
      push(
        `\n// Binding optimization for webpack code-split\nconst ${ast.helpers
          .map(s => `_${helperNameMap[s]} = ${helperNameMap[s]}`)
          .join(', ')}\n`
      ) // const _xxx = xxx, 
    } else { // 没有优化的导入
      push(
        `import { ${ast.helpers
          .map(s => `${helperNameMap[s]} as _${helperNameMap[s]}`)
          .join(', ')} } from ${JSON.stringify(runtimeModuleName /** Vue */)}\n`
      ) // 直接形成 import { xxx as _xxx } from 'Vue'
      // 这样的格式
    }
  }

  if (ast.ssrHelpers && ast.ssrHelpers.length) {
    push(
      `import { ${ast.ssrHelpers
        .map(s => `${helperNameMap[s]} as _${helperNameMap[s]}`)
        .join(', ')} } from "${ssrRuntimeModuleName}"\n`
    )
  }

  // 导入的
  if (ast.imports.length) {
    // 生成导入的
    genImports(ast.imports, context)
    newline() // 新的一行
  }

  // 生成提升的
  genHoists(ast.hoists, context)
  newline() // 新的一行

  // 不是内联也即是不是 <script setup>
  if (!inline) {
    push(`export `) // 推一个export 
  }
}

// 生成资源
function genAssets(
  assets: string[],
  type: 'component' | 'directive' | 'filter',
  { helper, push, newline, isTS }: CodegenContext
) {
  // 获取resolver
  const resolver = helper(
    __COMPAT__ && type === 'filter'
      ? RESOLVE_FILTER
      : type === 'component'
      ? RESOLVE_COMPONENT
      : RESOLVE_DIRECTIVE
  )
  // 遍历资源
  for (let i = 0; i < assets.length; i++) {
    let id = assets[i] // 拿到资源id
    // 从 SFC 文件名推断的潜在组件隐式自引用
    // potential component implicit self-reference inferred from SFC filename
    const maybeSelfReference = id.endsWith('__self') // 是否是自身
    if (maybeSelfReference) {
      id = id.slice(0, -6) // 额外处理id
    }
    push(
      // 转为有效的资源id
      `const ${toValidAssetId(id, type)} = ${resolver}(${JSON.stringify(id)}${
        maybeSelfReference ? `, true` : ``
      })${isTS ? `!` : ``}`
    )
    if (i < assets.length - 1) {
      newline()
    }
  }
}

// 生成提升
function genHoists(hoists: (JSChildNode | null)[], context: CodegenContext) {
  if (!hoists.length) { // 没有要提升的就return
    return
  }
  // 标记上下文是pure的
  context.pure = true
  const { push, newline, helper, scopeId, mode } = context
  // 需要生成作用域id
  const genScopeId = !__BROWSER__ && scopeId != null && mode !== 'function'
  newline() // 新的一行

  // 生成内联的 withScopeId 助手
  // generate inlined withScopeId helper
  if (genScopeId) {
    push(
      `const _withScopeId = n => (${helper(
        PUSH_SCOPE_ID
      )}("${scopeId}"),n=n(),${helper(POP_SCOPE_ID)}(),n)`
    )
    newline()
  }

  // 遍历需要提升的
  for (let i = 0; i < hoists.length; i++) {
    const exp = hoists[i]
    if (exp) {
      const needScopeIdWrapper = genScopeId && exp.type === NodeTypes.VNODE_CALL // 是否需要作用域id的包裹
      // 生成提升的字符串
      push(
        `const _hoisted_${i + 1} = ${
          needScopeIdWrapper ? `${PURE_ANNOTATION} _withScopeId(() => ` : ``
        }`
      )
      genNode(exp, context) // 生成表达式节点对应的字符串
      if (needScopeIdWrapper) {
        push(`)`)
      }
      newline()
    }
  }

  // 再次标记为false
  context.pure = false
}

// 生成导入
function genImports(importsOptions: ImportItem[], context: CodegenContext) {
  // 没有直接返回
  if (!importsOptions.length) {
    return
  }
  // 遍历生成每条导入语句
  // 如import xxx from 'x'
  importsOptions.forEach(imports => {
    context.push(`import `)
    genNode(imports.exp, context) // 生成表达式节点
    context.push(` from '${imports.path}'`)
    context.newline()
  })
}

function isText(n: string | CodegenNode) {
  return (
    isString(n) ||
    n.type === NodeTypes.SIMPLE_EXPRESSION ||
    n.type === NodeTypes.TEXT ||
    n.type === NodeTypes.INTERPOLATION ||
    n.type === NodeTypes.COMPOUND_EXPRESSION
  )
}

function genNodeListAsArray(
  nodes: (string | CodegenNode | TemplateChildNode[])[],
  context: CodegenContext
) {
  const multilines =
    nodes.length > 3 ||
    ((!__BROWSER__ || __DEV__) && nodes.some(n => isArray(n) || !isText(n)))
  context.push(`[`)
  multilines && context.indent()
  genNodeList(nodes, context, multilines)
  multilines && context.deindent()
  context.push(`]`)
}

function genNodeList(
  nodes: (string | symbol | CodegenNode | TemplateChildNode[])[],
  context: CodegenContext,
  multilines: boolean = false,
  comma: boolean = true
) {
  const { push, newline } = context
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]
    if (isString(node)) {
      push(node)
    } else if (isArray(node)) {
      genNodeListAsArray(node, context)
    } else {
      genNode(node, context)
    }
    if (i < nodes.length - 1) {
      if (multilines) {
        comma && push(',')
        newline()
      } else {
        comma && push(', ')
      }
    }
  }
}

// 生成节点
function genNode(node: CodegenNode | symbol | string, context: CodegenContext) {
  if (isString(node)) {
    context.push(node) // 字符串直接推入
    return
  }
  if (isSymbol(node)) {
    context.push(context.helper(node)) // 是symbol类型直接获取它的字符串
    return
  }
  // 其它类型
  switch (node.type) {
    case NodeTypes.ELEMENT:
    case NodeTypes.IF:
    case NodeTypes.FOR:
      __DEV__ &&
        assert(
          node.codegenNode != null,
          `Codegen node is missing for element/if/for node. ` +
            `Apply appropriate transforms first.`
        )
      genNode(node.codegenNode!, context)
      break
    case NodeTypes.TEXT:
      genText(node, context) // 文本
      break
    case NodeTypes.SIMPLE_EXPRESSION:
      genExpression(node, context) // 简单表达式
      break
    case NodeTypes.INTERPOLATION:
      genInterpolation(node, context) // 插值
      break
    case NodeTypes.TEXT_CALL: // 生成文本调用 - 最终是函数调用表达式
      genNode(node.codegenNode, context)
      break
    case NodeTypes.COMPOUND_EXPRESSION:
      genCompoundExpression(node, context) // 混合表达式
      break
    case NodeTypes.COMMENT:
      genComment(node, context) // 注释
      break
    case NodeTypes.VNODE_CALL:
      genVNodeCall(node, context) // 生成虚拟节点调用 // +++
      break

    case NodeTypes.JS_CALL_EXPRESSION:
      genCallExpression(node, context) // 函数调用表达式
      break
    case NodeTypes.JS_OBJECT_EXPRESSION:
      genObjectExpression(node, context) // 对象表达式 +++
      break
    case NodeTypes.JS_ARRAY_EXPRESSION:
      genArrayExpression(node, context) // 数组表达式 +++
      break
    case NodeTypes.JS_FUNCTION_EXPRESSION:
      genFunctionExpression(node, context) // 函数表达式 +++
      break
    case NodeTypes.JS_CONDITIONAL_EXPRESSION:
      genConditionalExpression(node, context) // 条件表达式 +++
      break
    case NodeTypes.JS_CACHE_EXPRESSION:
      genCacheExpression(node, context) // 缓存表达式
      break
    case NodeTypes.JS_BLOCK_STATEMENT:
      genNodeList(node.body, context, true, false) // 块语句
      break

    // ssr部分
    // SSR only types
    case NodeTypes.JS_TEMPLATE_LITERAL:
      !__BROWSER__ && genTemplateLiteral(node, context)
      break
    case NodeTypes.JS_IF_STATEMENT:
      !__BROWSER__ && genIfStatement(node, context)
      break
    case NodeTypes.JS_ASSIGNMENT_EXPRESSION:
      !__BROWSER__ && genAssignmentExpression(node, context)
      break
    case NodeTypes.JS_SEQUENCE_EXPRESSION:
      !__BROWSER__ && genSequenceExpression(node, context)
      break
    case NodeTypes.JS_RETURN_STATEMENT:
      !__BROWSER__ && genReturnStatement(node, context)
      break

    /* istanbul ignore next */
    case NodeTypes.IF_BRANCH:
      // noop // 不
      break
    default:
      if (__DEV__) {
        assert(false, `unhandled codegen node type: ${(node as any).type}`)
        // make sure we exhaust all possible types
        const exhaustiveCheck: never = node
        return exhaustiveCheck
      }
  }
}

function genText(
  node: TextNode | SimpleExpressionNode,
  context: CodegenContext
) {
  context.push(JSON.stringify(node.content), node)
}

function genExpression(node: SimpleExpressionNode, context: CodegenContext) {
  const { content, isStatic } = node
  context.push(isStatic ? JSON.stringify(content) : content, node)
}

// 生成插值
function genInterpolation(node: InterpolationNode, context: CodegenContext) {
  const { push, helper, pure } = context
  if (pure) push(PURE_ANNOTATION)
  push(`${helper(TO_DISPLAY_STRING)}(`) // 需要toDisplayString(...)
  genNode(node.content, context)
  push(`)`)
}

function genCompoundExpression(
  node: CompoundExpressionNode,
  context: CodegenContext
) {
  for (let i = 0; i < node.children!.length; i++) {
    const child = node.children![i]
    if (isString(child)) {
      context.push(child)
    } else {
      genNode(child, context)
    }
  }
}

function genExpressionAsPropertyKey(
  node: ExpressionNode,
  context: CodegenContext
) {
  const { push } = context
  if (node.type === NodeTypes.COMPOUND_EXPRESSION) {
    push(`[`)
    genCompoundExpression(node, context)
    push(`]`)
  } else if (node.isStatic) {
    // only quote keys if necessary
    const text = isSimpleIdentifier(node.content)
      ? node.content
      : JSON.stringify(node.content)
    push(text, node)
  } else {
    push(`[${node.content}]`, node)
  }
}

function genComment(node: CommentNode, context: CodegenContext) {
  const { push, helper, pure } = context
  if (pure) {
    push(PURE_ANNOTATION)
  }
  push(`${helper(CREATE_COMMENT)}(${JSON.stringify(node.content)})`, node)
}

// 生成vnode调用
function genVNodeCall(node: VNodeCall, context: CodegenContext) {
  const { push, helper, pure } = context
  const {
    tag,
    props,
    children,
    patchFlag,
    dynamicProps,
    directives,
    isBlock,
    disableTracking, // ++++++++++++++++++++++++++++
    isComponent // +++++++++++++++++
  } = node
  if (directives) { // 是否有指令 - withDirectives
    push(helper(WITH_DIRECTIVES) + `(`)
  }

  // 是否为块 - openBlock
  if (isBlock) {
    // +++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++
    // ++++++++++++++++++++++++++++++++++
    push(`(${helper(OPEN_BLOCK)}(${disableTracking ? `true` : ``}), `) // vnode调用节点的disableTracking决定是否产出参数true还是没有 // ++++++++++++++++++++
    // true代表禁用收集，false代表收集
    // 这个参数会影响openBlock函数内的执行逻辑以及createBaseVNode和setupBlock中的运行时逻辑的
    // +++++++++++++++++++++++++++++++++++++++++++++++++++++++++++
  }

  // pure注解
  if (pure) {
    push(PURE_ANNOTATION)
  }

  // ++++++++++++++++++++++++++++++++++++++++
  // vnode的调用表达式节点中isComponent属性仅仅是用来确定到底是哪一个createXxx运行时函数的
  // 它并没有其它的用处，就是这样！
  // +++++++++++++++++++++++++++++++++++++++++++++++++++++

  /* 
  isComponent和isBlock来去确定是到底是哪一个产生vnode的createXxx运行时函数的
  isComponent: true isBlock: true -> createBlock
  isComponent: true isBlock: false -> createVNode
  isComponent: false isBlock: true -> createElementBlock
  isComponent: false isBlock: false -> createElementVNode
  */

  // 调用助手
  // ++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++
  const callHelper: symbol = isBlock
    ? getVNodeBlockHelper(context.inSSR, isComponent) // ssr || isComponent ? CREATE_BLOCK : CREATE_ELEMENT_BLOCK
    : getVNodeHelper(context.inSSR, isComponent) // ssr || isComponent ? CREATE_VNODE : CREATE_ELEMENT_VNODE
  // +++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++
  
  // +++++++++++++++++++++++++++++++++++
  // 块的带block - 不带块的Vnode
  // createBlock createVnode
  // createElemnetBlock craeteElementVnode
  // ++++++++++++++++++++++++++++++++++++++++++++++


  // ++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++
  /* 
  isBlock - 决定是否openBlock、确定是哪一个createXxx运行时函数
  disableTracking - 决定openBlock函数的参数是true还是不传
  isComponent - 决定是哪一个createXxx运行时函数

  不管是哪一个createXxx运行时函数，最终生成的vnode调用表达式字符串中传入的参数都是tag, props, children, patchFlag, dynamicProps - 可以在codegen.ts中的genVNodeCall中去查看
  */
  // ++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++

  
  push(helper(callHelper) + `(`, node)
  // 生成节点列表
  genNodeList(
    // 生成可null的参数 - 意思没有使用null
    genNullableArgs([tag, props, children, patchFlag, dynamicProps]), // 标签、属性、孩子、比对标记、动态属性名 // ++++++++++++++++++++++
    // 生成创建vnode的运行时createXxx函数的参数，分别是tag, props, children, patchFlag, dynamicProps // +++++++++++++++++++++++++++++++++++++++++++++++++++++++
    context
  )
  push(`)`) // )
  if (isBlock) { // 是否是块
    push(`)`)
  }
  // 是否有指令
  if (directives) {
    // +++
    // +++
    push(`, `) // ,[[vModelText, msg.value] /** 第一个指令v-model */, [] /** 第二个指令 */]) +++
    genNode(directives, context) // 是一个数组表达式 - 可以在transformElements.ts中退出函数中看到 - 而每一项又是一个数组表达式（这个在构建指令参数函数中可看到）
    // +++
    push(`)`)
  }
}

function genNullableArgs(args: any[]): CallExpression['arguments'] {
  let i = args.length
  while (i--) {
    if (args[i] != null) break
  }
  return args.slice(0, i + 1).map(arg => arg || `null`)
}

// JavaScript
function genCallExpression(node: CallExpression, context: CodegenContext) {
  const { push, helper, pure } = context
  const callee = isString(node.callee) ? node.callee : helper(node.callee)
  if (pure) {
    push(PURE_ANNOTATION)
  }
  push(callee + `(`, node)
  genNodeList(node.arguments, context)
  push(`)`)
}

function genObjectExpression(node: ObjectExpression, context: CodegenContext) {
  const { push, indent, deindent, newline } = context
  const { properties } = node
  if (!properties.length) {
    push(`{}`, node)
    return
  }
  const multilines =
    properties.length > 1 ||
    ((!__BROWSER__ || __DEV__) &&
      properties.some(p => p.value.type !== NodeTypes.SIMPLE_EXPRESSION))
  push(multilines ? `{` : `{ `)
  multilines && indent()
  for (let i = 0; i < properties.length; i++) {
    const { key, value } = properties[i]
    // key
    genExpressionAsPropertyKey(key, context)
    push(`: `)
    // value
    genNode(value, context)
    if (i < properties.length - 1) {
      // will only reach this if it's multilines
      push(`,`)
      newline()
    }
  }
  multilines && deindent()
  push(multilines ? `}` : ` }`)
}

function genArrayExpression(node: ArrayExpression, context: CodegenContext) {
  genNodeListAsArray(node.elements as CodegenNode[], context)
}

function genFunctionExpression(
  node: FunctionExpression,
  context: CodegenContext
) {
  const { push, indent, deindent } = context
  const { params, returns, body, newline, isSlot } = node
  
  // +++
  // 是插槽则需要_withCtx()进行包裹一下
  // +++
  if (isSlot) {
    // 使用所有者上下文包装插槽函数
    // wrap slot functions with owner context
    push(`_${helperNameMap[WITH_CTX]}(`)
  }

  push(`(`, node)
  if (isArray(params)) {
    genNodeList(params, context)
  } else if (params) {
    genNode(params, context)
  }
  push(`) => `)
  if (newline || body) {
    push(`{`)
    indent()
  }
  if (returns) {
    if (newline) {
      push(`return `)
    }
    if (isArray(returns)) {
      genNodeListAsArray(returns, context)
    } else {
      genNode(returns, context)
    }
  } else if (body) {
    genNode(body, context)
  }
  if (newline || body) {
    deindent()
    push(`}`)
  }
  if (isSlot) {
    if (__COMPAT__ && node.isNonScopedSlot) {
      push(`, undefined, true`)
    }
    push(`)`)
  }
}

function genConditionalExpression(
  node: ConditionalExpression,
  context: CodegenContext
) {
  const { test, consequent, alternate, newline: needNewline } = node
  const { push, indent, deindent, newline } = context
  if (test.type === NodeTypes.SIMPLE_EXPRESSION) {
    const needsParens = !isSimpleIdentifier(test.content)
    needsParens && push(`(`)
    genExpression(test, context)
    needsParens && push(`)`)
  } else {
    push(`(`)
    genNode(test, context)
    push(`)`)
  }
  needNewline && indent()
  context.indentLevel++
  needNewline || push(` `)
  push(`? `)
  genNode(consequent, context)
  context.indentLevel--
  needNewline && newline()
  needNewline || push(` `)
  push(`: `)
  const isNested = alternate.type === NodeTypes.JS_CONDITIONAL_EXPRESSION
  if (!isNested) {
    context.indentLevel++
  }
  genNode(alternate, context) // 对备用选项继续生成节点 - 那可能再又是个条件表达式（递归生成）
  if (!isNested) {
    context.indentLevel--
  }
  needNewline && deindent(true /* without newline */)
}

// 生成缓存表达式
function genCacheExpression(node: CacheExpression, context: CodegenContext) {
  const { push, helper, indent, deindent, newline } = context
  push(`_cache[${node.index}] || (`)
  // 表示缓存的是否为vnode
  if (node.isVNode) {
    indent()
    push(`${helper(SET_BLOCK_TRACKING)}(-1),`) // SET_BLOCK_TRACKING运行时助手
    newline()
  }
  push(`_cache[${node.index}] = `)
  genNode(node.value, context)
  if (node.isVNode) {
    push(`,`)
    newline()
    push(`${helper(SET_BLOCK_TRACKING)}(1),`)
    newline()
    push(`_cache[${node.index}]`)
    deindent()
  }
  push(`)`)
}

function genTemplateLiteral(node: TemplateLiteral, context: CodegenContext) {
  const { push, indent, deindent } = context
  push('`')
  const l = node.elements.length
  const multilines = l > 3
  for (let i = 0; i < l; i++) {
    const e = node.elements[i]
    if (isString(e)) {
      push(e.replace(/(`|\$|\\)/g, '\\$1'))
    } else {
      push('${')
      if (multilines) indent()
      genNode(e, context)
      if (multilines) deindent()
      push('}')
    }
  }
  push('`')
}

function genIfStatement(node: IfStatement, context: CodegenContext) {
  const { push, indent, deindent } = context
  const { test, consequent, alternate } = node
  push(`if (`)
  genNode(test, context)
  push(`) {`)
  indent()
  genNode(consequent, context)
  deindent()
  push(`}`)
  if (alternate) {
    push(` else `)
    if (alternate.type === NodeTypes.JS_IF_STATEMENT) {
      genIfStatement(alternate, context)
    } else {
      push(`{`)
      indent()
      genNode(alternate, context)
      deindent()
      push(`}`)
    }
  }
}

function genAssignmentExpression(
  node: AssignmentExpression,
  context: CodegenContext
) {
  genNode(node.left, context)
  context.push(` = `)
  genNode(node.right, context)
}

function genSequenceExpression(
  node: SequenceExpression,
  context: CodegenContext
) {
  context.push(`(`)
  genNodeList(node.expressions, context)
  context.push(`)`)
}

function genReturnStatement(
  { returns }: ReturnStatement,
  context: CodegenContext
) {
  context.push(`return `)
  if (isArray(returns)) {
    genNodeListAsArray(returns, context)
  } else {
    genNode(returns, context)
  }
}
