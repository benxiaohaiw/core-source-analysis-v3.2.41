import { ErrorHandlingOptions, ParserOptions } from './options'
import { NO, isArray, makeMap, extend } from '@vue/shared'
import {
  ErrorCodes,
  createCompilerError,
  defaultOnError,
  defaultOnWarn
} from './errors'
import {
  assert,
  advancePositionWithMutation,
  advancePositionWithClone,
  isCoreComponent,
  isStaticArgOf
} from './utils'
import {
  Namespaces,
  AttributeNode,
  CommentNode,
  DirectiveNode,
  ElementNode,
  ElementTypes,
  ExpressionNode,
  NodeTypes,
  Position,
  RootNode,
  SourceLocation,
  TextNode,
  TemplateChildNode,
  InterpolationNode,
  createRoot,
  ConstantTypes
} from './ast'
import {
  checkCompatEnabled,
  CompilerCompatOptions,
  CompilerDeprecationTypes,
  isCompatEnabled,
  warnDeprecation
} from './compat/compatConfig'

type OptionalOptions =
  | 'whitespace'
  | 'isNativeTag'
  | 'isBuiltInComponent'
  | keyof CompilerCompatOptions
type MergedParserOptions = Omit<Required<ParserOptions>, OptionalOptions> &
  Pick<ParserOptions, OptionalOptions>
type AttributeValue =
  | {
      content: string
      isQuoted: boolean
      loc: SourceLocation
    }
  | undefined

// The default decoder only provides escapes for characters reserved as part of
// the template syntax, and is only used if the custom renderer did not provide
// a platform-specific decoder.
const decodeRE = /&(gt|lt|amp|apos|quot);/g
const decodeMap: Record<string, string> = {
  gt: '>',
  lt: '<',
  amp: '&',
  apos: "'",
  quot: '"'
}

// ---
// 默认解析选项
// ---
export const defaultParserOptions: MergedParserOptions = {
  delimiters: [`{{`, `}}`], // 分隔符
  getNamespace: () => Namespaces.HTML, // 都是返回Namespaces.HTML
  getTextMode: () => TextModes.DATA, // 都是返回TextModes.DATA
  isVoidTag: NO,
  isPreTag: NO,
  isCustomElement: NO,
  decodeEntities: (rawText: string): string =>
    rawText.replace(decodeRE, (_, p1) => decodeMap[p1]),
  onError: defaultOnError,
  onWarn: defaultOnWarn,
  comments: __DEV__
}

// 文本模式
export const enum TextModes {
  //          | Elements | Entities | End sign              | Inside of
  DATA, //    | ✔        | ✔        | End tags of ancestors |
  RCDATA, //  | ✘        | ✔        | End tag of the parent | <textarea>
  RAWTEXT, // | ✘        | ✘        | End tag of the parent | <style>,<script>
  CDATA,
  ATTRIBUTE_VALUE
}

export interface ParserContext {
  options: MergedParserOptions
  readonly originalSource: string
  source: string
  offset: number
  line: number
  column: number
  inPre: boolean // HTML <pre> tag, preserve whitespaces
  inVPre: boolean // v-pre, do not process directives and interpolations
  onWarn: NonNullable<ErrorHandlingOptions['onWarn']>
}

/* 

baseParse
  parseChildren -> while !isEnd
    parseElement - // 消费<p>张佳宁</p>整个的字符串，所以就不需要担心isEnd的问题
      parseTag - startTag
        parseAttribute
      parseChildren
        parseElement | parseText
      parseTag - closeTag
上述为基本流程基本流程
*/

// 对模板字符串进行解析 - 生成对应的ast语法树
export function baseParse(
  content: string,
  options: ParserOptions = {}
): RootNode {
  // 创建解析上下文
  const context = createParserContext(content, options) // 应用默认的解析参数选项
  const start = getCursor(context)
  // 创建root根节点
  // 此方法在ast.ts中
  return createRoot( // 使用root根节点进行包裹一下
    // 解析孩子
    parseChildren(context, TextModes.DATA, []), // 返回一个节点数组
    getSelection(context, start)
  )
}

// 创建解析上下文
function createParserContext(
  content: string,
  rawOptions: ParserOptions
): ParserContext {
  const options = extend({}, defaultParserOptions) // 应用默认解析参数

  let key: keyof ParserOptions
  for (key in rawOptions) {
    // @ts-ignore
    options[key] =
      rawOptions[key] === undefined
        ? defaultParserOptions[key]
        : rawOptions[key]
  }
  return {
    options, // 包含默认解析参数
    column: 1,
    line: 1,
    offset: 0,
    originalSource: content, // 原始源代码
    source: content, // 源代码
    inPre: false,
    inVPre: false,
    onWarn: options.onWarn
  }
}

function parseChildren(
  context: ParserContext,
  mode: TextModes, // 模式（一开始为TextModes.DATA）
  ancestors: ElementNode[] // 祖先元素节点数组
): TemplateChildNode[] {
  // 找出最后一个祖先元素节点
  const parent = last(ancestors)
  const ns = parent ? parent.ns : Namespaces.HTML // 一开始就是Namespaces.HTML
  const nodes: TemplateChildNode[] = [] // 节点数组

  // 提前注意每个parseXxx函数消费多少的字符串
  // 剩余字符串不是以</开头的那么返回!source
  // （在baseParse以及parseElement中进行parseChildren的，而祖先节点数组是在baseParse一开始就创建的空数组传入的，贯穿整个解析阶段）
  // 其中它的push是在parseElement中的parseTag之后推入的，而又在parseChildren之后（结果作为element的children值）它会弹出的最后一个祖先元素

  // 是</开头的那么倒叙遍历祖先元素对比当前开头的标签名是否与祖先标签一样 且 </p>最后的字符串是> - 返回true
  while (!isEnd(context, mode, ancestors)) {
    __TEST__ && assert(context.source.length > 0)
    const s = context.source
    let node: TemplateChildNode | TemplateChildNode[] | undefined = undefined

    // ---
    if (mode === TextModes.DATA || mode === TextModes.RCDATA) {
      if (!context.inVPre && startsWith(s, context.options.delimiters[0])) { // 当前的字符串是以{{开头的
        // '{{'
        node = parseInterpolation(context, mode) // 那么进行解析插值 ---
        // 消费{{msg}}它的长度，那么剩下的字符串就变为了</div>
      } else if (mode === TextModes.DATA && s[0] === '<') {
        // https://html.spec.whatwg.org/multipage/parsing.html#tag-open-state
        if (s.length === 1) {
          emitError(context, ErrorCodes.EOF_BEFORE_TAG_NAME, 1)
        } else if (s[1] === '!') {
          // https://html.spec.whatwg.org/multipage/parsing.html#markup-declaration-open-state
          if (startsWith(s, '<!--')) {
            node = parseComment(context)
          } else if (startsWith(s, '<!DOCTYPE')) {
            // Ignore DOCTYPE by a limitation.
            node = parseBogusComment(context)
          } else if (startsWith(s, '<![CDATA[')) {
            if (ns !== Namespaces.HTML) {
              node = parseCDATA(context, ancestors)
            } else {
              emitError(context, ErrorCodes.CDATA_IN_HTML_CONTENT)
              node = parseBogusComment(context)
            }
          } else {
            emitError(context, ErrorCodes.INCORRECTLY_OPENED_COMMENT)
            node = parseBogusComment(context)
          }
        } else if (s[1] === '/') {
          // https://html.spec.whatwg.org/multipage/parsing.html#end-tag-open-state
          if (s.length === 2) { // '</'
            emitError(context, ErrorCodes.EOF_BEFORE_TAG_NAME, 2)
          } else if (s[2] === '>') { // '</>'
            emitError(context, ErrorCodes.MISSING_END_TAG_NAME, 2)
            advanceBy(context, 3)
            continue
          } else if (/[a-z]/i.test(s[2])) { // '</d'
            emitError(context, ErrorCodes.X_INVALID_END_TAG)
            parseTag(context, TagType.End, parent)
            continue
          } else {
            emitError(
              context,
              ErrorCodes.INVALID_FIRST_CHARACTER_OF_TAG_NAME,
              2
            )
            node = parseBogusComment(context)
          }
        } else if (/[a-z]/i.test(s[1])) {
          // 解析元素
          node = parseElement(context, ancestors) // 消费<p>张佳宁</p>整个的字符串

          // 2.x <template> with no directive compat
          if (
            __COMPAT__ &&
            isCompatEnabled(
              CompilerDeprecationTypes.COMPILER_NATIVE_TEMPLATE,
              context
            ) &&
            node &&
            node.tag === 'template' &&
            !node.props.some(
              p =>
                p.type === NodeTypes.DIRECTIVE &&
                isSpecialTemplateDirective(p.name)
            )
          ) {
            __DEV__ &&
              warnDeprecation(
                CompilerDeprecationTypes.COMPILER_NATIVE_TEMPLATE,
                context,
                node.loc
              )
            node = node.children
          }
        } else if (s[1] === '?') {
          emitError(
            context,
            ErrorCodes.UNEXPECTED_QUESTION_MARK_INSTEAD_OF_TAG_NAME,
            1
          )
          node = parseBogusComment(context)
        } else {
          emitError(context, ErrorCodes.INVALID_FIRST_CHARACTER_OF_TAG_NAME, 1)
        }
      }
    }

    // ---
    if (!node) {
      // 解析文本
      node = parseText(context, mode) // 消费张佳宁长度
    }

    if (isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        pushNode(nodes, node[i]) // 向nodes数组推节点
      }
    } else {
      pushNode(nodes, node) // 向nodes数组推节点
    }

    // while循环体末尾
  }

  // 像v2一样的空白处理策略
  // Whitespace handling strategy like v2
  let removedWhitespace = false
  // TextModes.DATA
  if (mode !== TextModes.RAWTEXT && mode !== TextModes.RCDATA) {
    const shouldCondense = context.options.whitespace !== 'preserve'
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i]
      if (node.type === NodeTypes.TEXT) {
        if (!context.inPre) {
          if (!/[^\t\r\n\f ]/.test(node.content)) {
            const prev = nodes[i - 1]
            const next = nodes[i + 1]
            // Remove if:
            // - the whitespace is the first or last node, or:
            // - (condense mode) the whitespace is adjacent to a comment, or:
            // - (condense mode) the whitespace is between two elements AND contains newline
            if (
              !prev ||
              !next ||
              (shouldCondense &&
                (prev.type === NodeTypes.COMMENT ||
                  next.type === NodeTypes.COMMENT ||
                  (prev.type === NodeTypes.ELEMENT &&
                    next.type === NodeTypes.ELEMENT &&
                    /[\r\n]/.test(node.content))))
            ) {
              removedWhitespace = true
              nodes[i] = null as any
            } else {
              // Otherwise, the whitespace is condensed into a single space
              node.content = ' '
            }
          } else if (shouldCondense) {
            // in condense mode, consecutive whitespaces in text are condensed
            // down to a single space.
            node.content = node.content.replace(/[\t\r\n\f ]+/g, ' ')
          }
        } else {
          // #6410 normalize windows newlines in <pre>:
          // in SSR, browsers normalize server-rendered \r\n into a single \n
          // in the DOM
          node.content = node.content.replace(/\r\n/g, '\n')
        }
      }
      // Remove comment nodes if desired by configuration.
      else if (node.type === NodeTypes.COMMENT && !context.options.comments) {
        removedWhitespace = true
        nodes[i] = null as any
      }
    }
    if (context.inPre && parent && context.options.isPreTag(parent.tag)) {
      // remove leading newline per html spec
      // https://html.spec.whatwg.org/multipage/grouping-content.html#the-pre-element
      const first = nodes[0]
      if (first && first.type === NodeTypes.TEXT) {
        first.content = first.content.replace(/^\r?\n/, '')
      }
    }
  }

  // 返回nodes数组
  return removedWhitespace ? nodes.filter(Boolean) : nodes
}

function pushNode(nodes: TemplateChildNode[], node: TemplateChildNode): void {
  if (node.type === NodeTypes.TEXT) {
    const prev = last(nodes)
    // Merge if both this and the previous node are text and those are
    // consecutive. This happens for cases like "a < b".
    if (
      prev &&
      prev.type === NodeTypes.TEXT &&
      prev.loc.end.offset === node.loc.start.offset
    ) {
      prev.content += node.content
      prev.loc.end = node.loc.end
      prev.loc.source += node.loc.source
      return
    }
  }

  nodes.push(node)
}

function parseCDATA(
  context: ParserContext,
  ancestors: ElementNode[]
): TemplateChildNode[] {
  __TEST__ &&
    assert(last(ancestors) == null || last(ancestors)!.ns !== Namespaces.HTML)
  __TEST__ && assert(startsWith(context.source, '<![CDATA['))

  advanceBy(context, 9)
  const nodes = parseChildren(context, TextModes.CDATA, ancestors)
  if (context.source.length === 0) {
    emitError(context, ErrorCodes.EOF_IN_CDATA)
  } else {
    __TEST__ && assert(startsWith(context.source, ']]>'))
    advanceBy(context, 3)
  }

  return nodes
}

function parseComment(context: ParserContext): CommentNode {
  __TEST__ && assert(startsWith(context.source, '<!--'))

  const start = getCursor(context)
  let content: string

  // Regular comment.
  const match = /--(\!)?>/.exec(context.source)
  if (!match) {
    content = context.source.slice(4)
    advanceBy(context, context.source.length)
    emitError(context, ErrorCodes.EOF_IN_COMMENT)
  } else {
    if (match.index <= 3) {
      emitError(context, ErrorCodes.ABRUPT_CLOSING_OF_EMPTY_COMMENT)
    }
    if (match[1]) {
      emitError(context, ErrorCodes.INCORRECTLY_CLOSED_COMMENT)
    }
    content = context.source.slice(4, match.index)

    // Advancing with reporting nested comments.
    const s = context.source.slice(0, match.index)
    let prevIndex = 1,
      nestedIndex = 0
    while ((nestedIndex = s.indexOf('<!--', prevIndex)) !== -1) {
      advanceBy(context, nestedIndex - prevIndex + 1)
      if (nestedIndex + 4 < s.length) {
        emitError(context, ErrorCodes.NESTED_COMMENT)
      }
      prevIndex = nestedIndex + 1
    }
    advanceBy(context, match.index + match[0].length - prevIndex + 1)
  }

  return {
    type: NodeTypes.COMMENT,
    content,
    loc: getSelection(context, start)
  }
}

function parseBogusComment(context: ParserContext): CommentNode | undefined {
  __TEST__ && assert(/^<(?:[\!\?]|\/[^a-z>])/i.test(context.source))

  const start = getCursor(context)
  const contentStart = context.source[1] === '?' ? 1 : 2
  let content: string

  const closeIndex = context.source.indexOf('>')
  if (closeIndex === -1) {
    content = context.source.slice(contentStart)
    advanceBy(context, context.source.length)
  } else {
    content = context.source.slice(contentStart, closeIndex)
    advanceBy(context, closeIndex + 1)
  }

  return {
    type: NodeTypes.COMMENT,
    content,
    loc: getSelection(context, start)
  }
}

// 解析元素
function parseElement(
  context: ParserContext,
  ancestors: ElementNode[]
): ElementNode | undefined {
  __TEST__ && assert(/^<[a-z]/i.test(context.source))

  // Start tag.
  const wasInPre = context.inPre
  const wasInVPre = context.inVPre
  const parent = last(ancestors) // 查找祖先元素数组中最后一个祖先元素
  // 先进行解析标签
  // 以开始标签类型进行解析
  const element = parseTag(context, TagType.Start, parent) // TagType.Start代表开始标签类型
  const isPreBoundary = context.inPre && !wasInPre
  const isVPreBoundary = context.inVPre && !wasInVPre

  // 元素是自结束的 或 它的标签是空标签
  if (element.isSelfClosing || context.options.isVoidTag(element.tag)) {
    // #4030 self-closing <pre> tag
    if (isPreBoundary) {
      context.inPre = false
    }
    if (isVPreBoundary) {
      context.inVPre = false
    }
    return element // 直接返回元素
  }

  // 向祖先数组中推入元素节点
  // Children.
  ancestors.push(element)
  // 获取文本模式
  const mode = context.options.getTextMode(element, parent) // 默认参数中是TextModes.DATA
  // 解析孩子
  // 张佳宁</p>
  const children = parseChildren(context, mode, ancestors)

  // ---
  // 弹出最后一个祖先元素
  ancestors.pop()

  // 2.x inline-template compat
  if (__COMPAT__) {
    const inlineTemplateProp = element.props.find(
      p => p.type === NodeTypes.ATTRIBUTE && p.name === 'inline-template'
    ) as AttributeNode
    if (
      inlineTemplateProp &&
      checkCompatEnabled(
        CompilerDeprecationTypes.COMPILER_INLINE_TEMPLATE,
        context,
        inlineTemplateProp.loc
      )
    ) {
      const loc = getSelection(context, element.loc.end)
      inlineTemplateProp.value = {
        type: NodeTypes.TEXT,
        content: loc.source,
        loc
      }
    }
  }

  // 添加children属性
  element.children = children

  // 开始消费结束标签</p>
  // 结束标签
  // End tag.
  if (startsWithEndTagOpen(context.source, element.tag)) {
    // 以结束标签类型进行解析标签
    // </div>
    parseTag(context, TagType.End, parent) // 消费结束标签</p>
  } else {
    emitError(context, ErrorCodes.X_MISSING_END_TAG, 0, element.loc.start)
    if (context.source.length === 0 && element.tag.toLowerCase() === 'script') {
      const first = children[0]
      if (first && startsWith(first.loc.source, '<!--')) {
        emitError(context, ErrorCodes.EOF_IN_SCRIPT_HTML_COMMENT_LIKE_TEXT)
      }
    }
  }

  element.loc = getSelection(context, element.loc.start)

  if (isPreBoundary) {
    context.inPre = false
  }
  if (isVPreBoundary) {
    context.inVPre = false
  }
  // 返回元素
  return element
}

const enum TagType {
  Start,
  End
}

const isSpecialTemplateDirective = /*#__PURE__*/ makeMap(
  `if,else,else-if,for,slot`
)

/**
 * Parse a tag (E.g. `<div id=a>`) with that type (start tag or end tag).
 */
function parseTag(
  context: ParserContext,
  type: TagType.Start,
  parent: ElementNode | undefined
): ElementNode
function parseTag(
  context: ParserContext,
  type: TagType.End,
  parent: ElementNode | undefined
): void
function parseTag(
  context: ParserContext,
  type: TagType,
  parent: ElementNode | undefined
): ElementNode | undefined {
  __TEST__ && assert(/^<\/?[a-z]/i.test(context.source))
  __TEST__ &&
    assert(
      type === (startsWith(context.source, '</') ? TagType.End : TagType.Start)
    )

  // Tag open.
  const start = getCursor(context)
  // 以<div开始
  // 或以</div开始
  const match = /^<\/?([a-z][^\t\r\n\f />]*)/i.exec(context.source)!
  // 获取div
  const tag = match[1]
  const ns = context.options.getNamespace(tag, parent) // 获取命名空间
  // 在默认参数中返回的永远是Namespaces.HTML

  // 消费context中大的source属性
  // 前进<div步长
  advanceBy(context, match[0].length)

  // 前进空格
  // /^[\t\r\n\f ]+/
  // 前进match[0]匹配字符串的长度
  advanceSpaces(context) // 消费空格 - 开去保证解析属性时是以属性名作为开头的

  // 保存当前状态以防我们需要使用 v-pre 重新解析属性
  // save current state in case we need to re-parse attributes with v-pre
  const cursor = getCursor(context)
  // 保存此时的源代码
  const currentSource = context.source

  // 检查<pre>标签
  // check <pre> tag
  if (context.options.isPreTag(tag)) {
    context.inPre = true
  }

  // 在解析属性之前以及消费了属性名之前的空格啦 ~
  // 解析属性
  // Attributes.
  let props = parseAttributes(context, type) // 开始标签类型

  // check v-pre
  if (
    type === TagType.Start &&
    !context.inVPre &&
    props.some(p => p.type === NodeTypes.DIRECTIVE && p.name === 'pre')
  ) {
    context.inVPre = true
    // reset context
    extend(context, cursor)
    context.source = currentSource
    // re-parse attrs and filter out v-pre itself
    props = parseAttributes(context, type).filter(p => p.name !== 'v-pre')
  }

  // Tag close.
  let isSelfClosing = false
  if (context.source.length === 0) {
    emitError(context, ErrorCodes.EOF_IN_TAG)
  } else {
    // 是否是自结束标签 - <input />
    // <div>
    isSelfClosing = startsWith(context.source, '/>')
    if (type === TagType.End && isSelfClosing) {
      emitError(context, ErrorCodes.END_TAG_WITH_TRAILING_SOLIDUS)
    }
    // 再次前进2或1长度
    advanceBy(context, isSelfClosing ? 2 : 1)
  }

  if (type === TagType.End) {
    return // 解析结束标签类型时这里直接return
  }

  // 2.x deprecation checks
  if (
    __COMPAT__ &&
    __DEV__ &&
    isCompatEnabled(
      CompilerDeprecationTypes.COMPILER_V_IF_V_FOR_PRECEDENCE,
      context
    )
  ) {
    let hasIf = false
    let hasFor = false
    for (let i = 0; i < props.length; i++) {
      const p = props[i]
      if (p.type === NodeTypes.DIRECTIVE) {
        if (p.name === 'if') {
          hasIf = true
        } else if (p.name === 'for') {
          hasFor = true
        }
      }
      if (hasIf && hasFor) {
        warnDeprecation(
          CompilerDeprecationTypes.COMPILER_V_IF_V_FOR_PRECEDENCE,
          context,
          getSelection(context, start)
        )
        break
      }
    }
  }

  // 准备标签类型默认是元素
  let tagType = ElementTypes.ELEMENT
  // 准备
  if (!context.inVPre) {
    if (tag === 'slot') {
      tagType = ElementTypes.SLOT // 插槽标签类型
    } else if (tag === 'template') {
      if (
        props.some(
          p =>
            p.type === NodeTypes.DIRECTIVE && isSpecialTemplateDirective(p.name)
        )
      ) {
        tagType = ElementTypes.TEMPLATE // template标签类型
      }
    } else if (isComponent(tag, props, context)) {
      tagType = ElementTypes.COMPONENT // 组件标签类型
    }
  }

  return {
    type: NodeTypes.ELEMENT, // 节点类型为元素
    ns,
    tag,
    tagType, // 标签类型
    props,
    isSelfClosing,
    children: [],
    loc: getSelection(context, start),
    codegenNode: undefined // to be created during transform phase
    // 转换阶段期间进行创建codegenNode
  }
}

function isComponent(
  tag: string,
  props: (AttributeNode | DirectiveNode)[],
  context: ParserContext
) {
  const options = context.options
  if (options.isCustomElement(tag)) {
    return false
  }
  if (
    tag === 'component' ||
    /^[A-Z]/.test(tag) ||
    isCoreComponent(tag) ||
    (options.isBuiltInComponent && options.isBuiltInComponent(tag)) ||
    (options.isNativeTag && !options.isNativeTag(tag))
  ) {
    return true
  }
  // at this point the tag should be a native tag, but check for potential "is"
  // casting
  for (let i = 0; i < props.length; i++) {
    const p = props[i]
    if (p.type === NodeTypes.ATTRIBUTE) {
      if (p.name === 'is' && p.value) {
        if (p.value.content.startsWith('vue:')) {
          return true
        } else if (
          __COMPAT__ &&
          checkCompatEnabled(
            CompilerDeprecationTypes.COMPILER_IS_ON_ELEMENT,
            context,
            p.loc
          )
        ) {
          return true
        }
      }
    } else {
      // directive
      // v-is (TODO Deprecate)
      if (p.name === 'is') {
        return true
      } else if (
        // :is on plain element - only treat as component in compat mode
        p.name === 'bind' &&
        isStaticArgOf(p.arg, 'is') &&
        __COMPAT__ &&
        checkCompatEnabled(
          CompilerDeprecationTypes.COMPILER_IS_ON_ELEMENT,
          context,
          p.loc
        )
      ) {
        return true
      }
    }
  }
}

// 解析属性
function parseAttributes(
  context: ParserContext,
  type: TagType
): (AttributeNode | DirectiveNode)[] {
  const props = []
  const attributeNames = new Set<string>()
  while ( // 只要source有值 且 不是以>开头 且 不是以/>开头的
    context.source.length > 0 &&
    !startsWith(context.source, '>') &&
    !startsWith(context.source, '/>')
  ) {
    // 是否以/开头的
    if (startsWith(context.source, '/')) {
      emitError(context, ErrorCodes.UNEXPECTED_SOLIDUS_IN_TAG)
      advanceBy(context, 1)
      advanceSpaces(context)
      continue
    }
    if (type === TagType.End) {
      emitError(context, ErrorCodes.END_TAG_WITH_ATTRIBUTES)
    }

    // 解析属性
    const attr = parseAttribute(context, attributeNames)

    // Trim whitespace between class
    // https://github.com/vuejs/core/issues/4251
    if (
      attr.type === NodeTypes.ATTRIBUTE &&
      attr.value &&
      attr.name === 'class' // 是class属性
    ) {
      // 处理一下它匹配到的内容
      attr.value.content = attr.value.content.replace(/\s+/g, ' ').trim()
    }

    if (type === TagType.Start) { // 开始标签类型那么就推入props中
      props.push(attr) // 推入props数组中
    }

    // 属性之间丢失了空格 - 进行报错 - 例如class="foo"style=""这样的就报错
    if (/^[^\t\r\n\f />]/.test(context.source)) {
      emitError(context, ErrorCodes.MISSING_WHITESPACE_BETWEEN_ATTRIBUTES)
    }

    // 前进空格
    // 也就是前进/^[\t\r\n\f ]+/匹配到的match[0]长度
    advanceSpaces(context)
  }
  return props // 返回props数组
}

// 解析属性
function parseAttribute(
  context: ParserContext,
  nameSet: Set<string>
): AttributeNode | DirectiveNode {
  __TEST__ && assert(/^[^\t\r\n\f />]/.test(context.source))

  // Name.
  const start = getCursor(context)
  // class="foo"
  const match = /^[^\t\r\n\f />][^\t\r\n\f />=]*/.exec(context.source)!
  const name = match[0] // 只拿到class

  if (nameSet.has(name)) {
    // 重复的属性 - 报错
    emitError(context, ErrorCodes.DUPLICATE_ATTRIBUTE)
  }
  // 添加nameSet中
  nameSet.add(name)

  if (name[0] === '=') {
    emitError(context, ErrorCodes.UNEXPECTED_EQUALS_SIGN_BEFORE_ATTRIBUTE_NAME)
  }
  {
    const pattern = /["'<]/g
    let m: RegExpExecArray | null
    while ((m = pattern.exec(name))) {
      emitError(
        context,
        ErrorCodes.UNEXPECTED_CHARACTER_IN_ATTRIBUTE_NAME,
        m.index
      )
    }
  }

  // 前进class长度
  advanceBy(context, name.length)

  // Value
  let value: AttributeValue = undefined

  // ="foo"
  if (/^[\t\r\n\f ]*=/.test(context.source)) {
    // 再次前进空格
    advanceSpaces(context)
    // 前进=长度
    advanceBy(context, 1)
    // 再次前进空格
    advanceSpaces(context)
    // 开始解析属性值
    value = parseAttributeValue(context) // { content: "foo" }
    if (!value) {
      emitError(context, ErrorCodes.MISSING_ATTRIBUTE_VALUE) // 原因是写了=号之后没有匹配到值，那么就要报错的
    }
  }
  const loc = getSelection(context, start)

  // 检测当前上下文中不是在v-pre中
  // ---
  // 进一步验证属性名字是否以v-xxx或:或.或@或#开头的指令
  // 那么就在这里直接返回指令节点类型而不是下面的属性节点类型啦 ~
  // ---
  if (!context.inVPre && /^(v-[A-Za-z0-9-]|:|\.|@|#)/.test(name)) {
    // 指令的匹配
    const match =
      /(?:^v-([a-z0-9-]+))?(?:(?::|^\.|^@|^#)(\[[^\]]+\]|[^\.]+))?(.+)?$/i.exec(
        name
      )!

    // 看下名字是否以.开始的
    let isPropShorthand = startsWith(name, '.') // 是属性短名字
    // 分析指令名字
    let dirName =
      match[1] ||
      (isPropShorthand || startsWith(name, ':') // 是:开始的
        ? 'bind' // bind
        : startsWith(name, '@') // 是@开始的
        ? 'on' // on
        : 'slot') // slot
    let arg: ExpressionNode | undefined

    /* 
    https://vuejs.org/guide/reusability/custom-directives.html#hook-arguments
    <div v-example:foo.bar="baz">
    {
      arg: 'foo',
      modifiers: { bar: true },
      value: // value of `baz`,
      oldValue: // value of `baz` from previous update
    }

    Similar to built-in directives, custom directive arguments can be dynamic. For example:
    <div v-example:[arg]="value"></div>

    Here the directive argument will be reactively updated based on arg property in our component state.
    */

    // 准备参数
    if (match[2]) {
      const isSlot = dirName === 'slot'
      const startOffset = name.lastIndexOf(match[2])
      const loc = getSelection(
        context,
        getNewPosition(context, start, startOffset),
        getNewPosition(
          context,
          start,
          startOffset + match[2].length + ((isSlot && match[3]) || '').length
        )
      )
      let content = match[2]
      let isStatic = true // 一开始是静态的

      // 参数是否是动态参数 -> [xxx]
      if (content.startsWith('[')) {
        isStatic = false

        if (!content.endsWith(']')) {
          emitError(
            context,
            ErrorCodes.X_MISSING_DYNAMIC_DIRECTIVE_ARGUMENT_END
          )
          content = content.slice(1)
        } else {
          content = content.slice(1, content.length - 1)
        }
      } else if (isSlot) {
        // #1241 special case for v-slot: vuetify relies extensively on slot
        // names containing dots. v-slot doesn't have any modifiers and Vue 2.x
        // supports such usage so we are keeping it consistent with 2.x.
        content += match[3] || ''
      }

      // 准备参数
      arg = {
        type: NodeTypes.SIMPLE_EXPRESSION, // 简单表达式类型节点
        content, // 内容
        isStatic, // 参数是动态参数的话那么就不是静态的
        constType: isStatic
          ? ConstantTypes.CAN_STRINGIFY // 是静态的就为可字符串化
          : ConstantTypes.NOT_CONSTANT, // 不是静态的则不是常量的类型
        loc
      }
    }

    // 进一步处理value且value是带有引号的
    if (value && value.isQuoted) {
      const valueLoc = value.loc
      valueLoc.start.offset++
      valueLoc.start.column++
      valueLoc.end = advancePositionWithClone(valueLoc.start, value.content)
      valueLoc.source = valueLoc.source.slice(1, -1)
    }

    // 处理修饰符 - 以.分割产生一个数组
    const modifiers = match[3] ? match[3].slice(1).split('.') : []
    // 是属性短名字则修饰符中额外推入一个'prop'修饰符
    if (isPropShorthand) modifiers.push('prop')

    // 2.x compat v-bind:foo.sync -> v-model:foo
    if (__COMPAT__ && dirName === 'bind' && arg) {
      if (
        modifiers.includes('sync') &&
        checkCompatEnabled(
          CompilerDeprecationTypes.COMPILER_V_BIND_SYNC,
          context,
          loc,
          arg.loc.source
        )
      ) {
        dirName = 'model'
        modifiers.splice(modifiers.indexOf('sync'), 1)
      }

      if (__DEV__ && modifiers.includes('prop')) {
        checkCompatEnabled(
          CompilerDeprecationTypes.COMPILER_V_BIND_PROP,
          context,
          loc
        )
      }
    }

    return {
      type: NodeTypes.DIRECTIVE, // 指令节点类型
      name: dirName, // 指令名字
      exp: value && { // 表达式
        type: NodeTypes.SIMPLE_EXPRESSION, // 简单表达式类型节点
        content: value.content, // 内容
        isStatic: false, // 不是静态的
        // 默认情况下视为非常量。这可以通过' transformExpression '潜在地设置为其他值，使其符合提升的条件。
        // Treat as non-constant by default. This can be potentially set to
        // other values by `transformExpression` to make it eligible for hoisting.
        constType: ConstantTypes.NOT_CONSTANT, // 先默认是不是常量类型
        loc: value.loc
      },
      arg, // 参数
      modifiers, // 修饰符
      loc
    }
  }

  // 缺少指令名称或非法指令名称
  // missing directive name or illegal directive name
  if (!context.inVPre && startsWith(name, 'v-')) { // 上下文中不是在v-pre中且名字是以v-开始
    emitError(context, ErrorCodes.X_MISSING_DIRECTIVE_NAME)
  }

  return {
    type: NodeTypes.ATTRIBUTE, // 属性类型
    name, // 属性名字class
    // autoComplete这种它的value就是undefined
    value: value && { // 属性值
      type: NodeTypes.TEXT, // 文本类型
      content: value.content, // 值内容foo
      loc: value.loc
    },
    loc
  }
}

function parseAttributeValue(context: ParserContext): AttributeValue {
  const start = getCursor(context)
  let content: string

  const quote = context.source[0] // " 还是 '

  const isQuoted = quote === `"` || quote === `'` // 是否带引号的
  if (isQuoted) {
    // Quoted value.
    advanceBy(context, 1) // 前进一个" 或 '

    const endIndex = context.source.indexOf(quote) // 查找下一个第一个的"或'
    if (endIndex === -1) {
      content = parseTextData(
        context,
        context.source.length,
        TextModes.ATTRIBUTE_VALUE
      )
    } else {
      // 解析文本数据
      content = parseTextData(context, endIndex, TextModes.ATTRIBUTE_VALUE) // foo
      advanceBy(context, 1) // 再次前进一个长度
    }
  } else { // 不带引号的
    // Unquoted
    const match = /^[^\t\r\n\f >]+/.exec(context.source)
    if (!match) {
      return undefined // 返回undefined
    }
    const unexpectedChars = /["'<=`]/g
    let m: RegExpExecArray | null
    while ((m = unexpectedChars.exec(match[0]))) {
      emitError(
        context,
        ErrorCodes.UNEXPECTED_CHARACTER_IN_UNQUOTED_ATTRIBUTE_VALUE,
        m.index
      )
    }
    content = parseTextData(context, match[0].length, TextModes.ATTRIBUTE_VALUE)
  }

  // 返回
  return { content, isQuoted, loc: getSelection(context, start) }
}

// 解析插值 - {{}}
function parseInterpolation(
  context: ParserContext,
  mode: TextModes
): InterpolationNode | undefined {
  const [open, close] = context.options.delimiters // {{ }}
  __TEST__ && assert(startsWith(context.source, open))

  // 查找结束}}所在的下标
  const closeIndex = context.source.indexOf(close, open.length)
  // 没有那么直接报丢失错误
  if (closeIndex === -1) {
    emitError(context, ErrorCodes.X_MISSING_INTERPOLATION_END)
    return undefined
  }

  const start = getCursor(context)
  // 前进{{的长度
  advanceBy(context, open.length)
  const innerStart = getCursor(context)
  const innerEnd = getCursor(context)
  // 结束下标 - 开始的长度表示中间内容的长度
  const rawContentLength = closeIndex - open.length
  // 提取msg}}中的msg
  const rawContent = context.source.slice(0, rawContentLength)
  // 解析文本数据
  const preTrimContent = parseTextData(context, rawContentLength, mode)
  // 去除空格
  const content = preTrimContent.trim()
  // 查找它的下标
  const startOffset = preTrimContent.indexOf(content)
  if (startOffset > 0) {

    // 前进
    advancePositionWithMutation(innerStart, rawContent, startOffset)
  }
  const endOffset =
    rawContentLength - (preTrimContent.length - content.length - startOffset)
  advancePositionWithMutation(innerEnd, rawContent, endOffset)

  // 前进
  advanceBy(context, close.length)

  return {
    type: NodeTypes.INTERPOLATION, // 节点类型为插值类型
    content: { // 其内容
      type: NodeTypes.SIMPLE_EXPRESSION, // 节点类型为简单表达式类型
      isStatic: false, // 不是静态的
      // 默认情况下将 `isConstant` 设置为 false 并将在 transformExpression 中决定
      // Set `isConstant` to false by default and will decide in transformExpression
      constType: ConstantTypes.NOT_CONSTANT, // 常量类型默认设置不是常量
      // 它的最终类型将在transform阶段中的transformExpression中决定
      content, // 其内容
      loc: getSelection(context, innerStart, innerEnd)
    },
    loc: getSelection(context, start)
  }
}

// 解析文本
function parseText(context: ParserContext, mode: TextModes): TextNode {
  __TEST__ && assert(context.source.length > 0)

  const endTokens =
    mode === TextModes.CDATA ? [']]>'] : ['<', context.options.delimiters[0]] // 后者['<', '{{']
    // 因为模式为TextModes.DATA

  // 找到结束下标
  let endIndex = context.source.length
  for (let i = 0; i < endTokens.length; i++) {
    const index = context.source.indexOf(endTokens[i], 1)
    if (index !== -1 && endIndex > index) {
      endIndex = index
    }
  }

  __TEST__ && assert(endIndex > 0)

  const start = getCursor(context)
  // 还是解析文本数据
  const content = parseTextData(context, endIndex, mode)

  return {
    type: NodeTypes.TEXT, // 节点类型为文本类型
    content, // 张佳宁
    loc: getSelection(context, start)
  }
}

/**
 * Get text data with a given length from the current location.
 * This translates HTML entities in the text data.
 */
function parseTextData(
  context: ParserContext,
  length: number,
  mode: TextModes // TextModes.ATTRIBUTE_VALUE
): string {
  const rawText = context.source.slice(0, length)
  advanceBy(context, length) // 前进
  if (
    mode === TextModes.RAWTEXT ||
    mode === TextModes.CDATA ||
    !rawText.includes('&')
  ) {
    return rawText // 那么直接返回原生文本
  } else {
    // DATA or RCDATA containing "&"". Entity decoding required.
    return context.options.decodeEntities(
      rawText,
      mode === TextModes.ATTRIBUTE_VALUE
    )
  }
}

function getCursor(context: ParserContext): Position {
  const { column, line, offset } = context
  return { column, line, offset }
}

function getSelection(
  context: ParserContext,
  start: Position,
  end?: Position
): SourceLocation {
  end = end || getCursor(context)
  return {
    start,
    end,
    source: context.originalSource.slice(start.offset, end.offset)
  }
}

function last<T>(xs: T[]): T | undefined {
  return xs[xs.length - 1]
}

function startsWith(source: string, searchString: string): boolean {
  return source.startsWith(searchString)
}

// 按照指定的数字进行前进
function advanceBy(context: ParserContext, numberOfCharacters: number): void {
  const { source } = context
  __TEST__ && assert(numberOfCharacters <= source.length)
  advancePositionWithMutation(context, source, numberOfCharacters)
  context.source = source.slice(numberOfCharacters)
}

// 前进空格
// 前进/^[\t\r\n\f ]+/匹配到的match[0]的长度
function advanceSpaces(context: ParserContext): void {
  const match = /^[\t\r\n\f ]+/.exec(context.source)
  if (match) {
    advanceBy(context, match[0].length)
  }
}

function getNewPosition(
  context: ParserContext,
  start: Position,
  numberOfCharacters: number
): Position {
  return advancePositionWithClone(
    start,
    context.originalSource.slice(start.offset, numberOfCharacters),
    numberOfCharacters
  )
}

function emitError(
  context: ParserContext,
  code: ErrorCodes,
  offset?: number,
  loc: Position = getCursor(context)
): void {
  if (offset) {
    loc.offset += offset
    loc.column += offset
  }
  context.options.onError(
    createCompilerError(code, {
      start: loc,
      end: loc,
      source: ''
    })
  )
}

/* 
div -> parseE1
  div -> parseC1 -> parseE2 -> parseT2 -> parseA2 -> parseC2 -> parseText2 -> parseT2
  h2 -> parseC1 -> parseE3 -> parseT3 -> parseA3 -> parseC3 -> parseText3 -> parseT3

div -> parseE1
  p -> parseC1 -> parseE2 -> parseT2 -> parseA2 -> parseC2 -> parseText2 -> parseT2
div -> parseE3
h2 -> parseE4

*/
function isEnd(
  context: ParserContext,
  mode: TextModes,
  ancestors: ElementNode[]
): boolean {
  const s = context.source // 拿出代码字符串

  switch (mode) {
    case TextModes.DATA: // TextModes.DATA
      if (startsWith(s, '</')) { // 查看代码字符串是否以</开头的
        // TODO: probably bad performance
        for (let i = ancestors.length - 1; i >= 0; --i) { // 遍历祖先元素节点数组
          if (startsWithEndTagOpen(s, ancestors[i].tag)) { // 细节看这个方法
            return true
          }
        }
      }
      break

    case TextModes.RCDATA:
    case TextModes.RAWTEXT: {
      const parent = last(ancestors)
      if (parent && startsWithEndTagOpen(s, parent.tag)) {
        return true
      }
      break
    }

    case TextModes.CDATA:
      if (startsWith(s, ']]>')) {
        return true
      }
      break
  }

  // s -> 'xxx'
  // !s -> false
  return !s
}

function startsWithEndTagOpen(source: string, tag: string): boolean {
  return (
    startsWith(source, '</') && // </
    source.slice(2, 2 + tag.length).toLowerCase() === tag.toLowerCase() && // </div> -> 剩余标签div === 祖先元素标签div
    /[\t\r\n\f />]/.test(source[2 + tag.length] || '>') // </div> -> >
  )
}
