import {
  NodeTypes,
  ElementNode,
  SourceLocation,
  CompilerError,
  TextModes,
  BindingMetadata
} from '@vue/compiler-core'
import * as CompilerDOM from '@vue/compiler-dom'
import { RawSourceMap, SourceMapGenerator } from 'source-map'
import { TemplateCompiler } from './compileTemplate'
import { parseCssVars } from './cssVars'
import { createCache } from './cache'
import { hmrShouldReload, ImportBinding } from './compileScript'

export const DEFAULT_FILENAME = 'anonymous.vue'

export interface SFCParseOptions {
  filename?: string
  sourceMap?: boolean
  sourceRoot?: string
  pad?: boolean | 'line' | 'space'
  ignoreEmpty?: boolean
  compiler?: TemplateCompiler
}

export interface SFCBlock {
  type: string
  content: string
  attrs: Record<string, string | true>
  loc: SourceLocation
  map?: RawSourceMap
  lang?: string
  src?: string
}

export interface SFCTemplateBlock extends SFCBlock {
  type: 'template'
  ast: ElementNode
}

export interface SFCScriptBlock extends SFCBlock {
  type: 'script'
  setup?: string | boolean
  bindings?: BindingMetadata
  imports?: Record<string, ImportBinding>
  /**
   * import('\@babel/types').Statement
   */
  scriptAst?: any[]
  /**
   * import('\@babel/types').Statement
   */
  scriptSetupAst?: any[]
}

export interface SFCStyleBlock extends SFCBlock {
  type: 'style'
  scoped?: boolean
  module?: string | boolean
}

export interface SFCDescriptor {
  filename: string
  source: string
  template: SFCTemplateBlock | null
  script: SFCScriptBlock | null
  scriptSetup: SFCScriptBlock | null
  styles: SFCStyleBlock[]
  customBlocks: SFCBlock[]
  cssVars: string[]
  /**
   * whether the SFC uses :slotted() modifier.
   * this is used as a compiler optimization hint.
   */
  slotted: boolean

  /**
   * compare with an existing descriptor to determine whether HMR should perform
   * a reload vs. re-render.
   *
   * Note: this comparison assumes the prev/next script are already identical,
   * and only checks the special case where <script setup lang="ts"> unused import
   * pruning result changes due to template changes.
   */
  shouldForceReload: (prevImports: Record<string, ImportBinding>) => boolean
}

export interface SFCParseResult {
  descriptor: SFCDescriptor
  errors: (CompilerError | SyntaxError)[]
}

const sourceToSFC = createCache<SFCParseResult>()

// sfc的解析函数
export function parse(
  source: string,
  {
    sourceMap = true,
    filename = DEFAULT_FILENAME,
    sourceRoot = '',
    pad = false,
    ignoreEmpty = true,
    compiler = CompilerDOM // @vue/compiler-dom
  }: SFCParseOptions = {}
): SFCParseResult {
  const sourceKey =
    source + sourceMap + filename + sourceRoot + pad + compiler.parse
  const cache = sourceToSFC.get(sourceKey)
  // 先看缓存
  if (cache) {
    return cache
  }

  // 准备一个描述符对象
  const descriptor: SFCDescriptor = {
    filename,
    source,
    template: null,
    script: null,
    scriptSetup: null,
    styles: [],
    customBlocks: [],
    cssVars: [],
    slotted: false,
    shouldForceReload: prevImports => hmrShouldReload(prevImports, descriptor)
  }

  const errors: (CompilerError | SyntaxError)[] = []

  // 使用编译器进行parse，这直接会生成对应的ast语法树
  const ast = compiler.parse(source, {
    // SFC 解析级别没有组件
    // there are no components at SFC parsing level
    isNativeTag: () => true, // 一律返回true
    // preserve all whitespaces
    isPreTag: () => true,
    // 获取文本模式
    getTextMode: ({ tag, props }, parent) => {
      // 除<template>外的所有顶级元素都被解析为raw text容器
      // all top level elements except <template> are parsed as raw text
      // containers
      if (
        (!parent && tag !== 'template') ||
        // <template lang="xxx">也应被视为raw text
        // <template lang="xxx"> should also be treated as raw text
        (tag === 'template' &&
          props.some(
            p =>
              p.type === NodeTypes.ATTRIBUTE &&
              p.name === 'lang' &&
              p.value &&
              p.value.content &&
              p.value.content !== 'html'
          ))
      ) {
        return TextModes.RAWTEXT
      } else {
        // 其它的都是TextModes.DATA
        return TextModes.DATA
      }
    },
    onError: e => {
      errors.push(e)
    }
  })

  // 这个ast语法树返回的一个root节点
  // 对ast语法树的孩子直接进行遍历
  ast.children.forEach(node => {
    if (node.type !== NodeTypes.ELEMENT) {
      return
    }
    // 我们只想保留不为空的节点（当标签不是template时）
    // we only want to keep the nodes that are not empty (when the tag is not a template)
    if (
      ignoreEmpty &&
      node.tag !== 'template' &&
      isEmpty(node) &&
      !hasSrc(node)
    ) {
      return
    }
    switch (node.tag) {
      case 'template':
        if (!descriptor.template) {
          // 创建template块对象
          const templateBlock = (descriptor.template = createBlock(
            node,
            source,
            false
          ) as SFCTemplateBlock)
          // 对应的ast保存当前node
          templateBlock.ast = node

          // warn against 2.x <template functional>
          if (templateBlock.attrs.functional) {
            const err = new SyntaxError(
              `<template functional> is no longer supported in Vue 3, since ` +
                `functional components no longer have significant performance ` +
                `difference from stateful ones. Just use a normal <template> ` +
                `instead.`
            ) as CompilerError
            err.loc = node.props.find(p => p.name === 'functional')!.loc
            errors.push(err)
          }
        } else {
          errors.push(createDuplicateBlockError(node))
        }
        break
      case 'script':
        // 创建script块
        const scriptBlock = createBlock(node, source, pad) as SFCScriptBlock
        // 是否为setup
        const isSetup = !!scriptBlock.attrs.setup
        if (isSetup && !descriptor.scriptSetup) {
          descriptor.scriptSetup = scriptBlock
          break
        }
        if (!isSetup && !descriptor.script) {
          descriptor.script = scriptBlock
          break
        }
        errors.push(createDuplicateBlockError(node, isSetup))
        break
      case 'style':
        // 创建样式块
        const styleBlock = createBlock(node, source, pad) as SFCStyleBlock
        if (styleBlock.attrs.vars) {
          errors.push(
            new SyntaxError(
              `<style vars> has been replaced by a new proposal: ` +
                `https://github.com/vuejs/rfcs/pull/231`
            )
          )
        }
        descriptor.styles.push(styleBlock)
        break
      default:
        descriptor.customBlocks.push(createBlock(node, source, pad))
        break
    }
  })

  if (descriptor.scriptSetup) {
    if (descriptor.scriptSetup.src) {
      errors.push(
        new SyntaxError(
          `<script setup> cannot use the "src" attribute because ` +
            `its syntax will be ambiguous outside of the component.`
        )
      )
      descriptor.scriptSetup = null
    }
    if (descriptor.script && descriptor.script.src) {
      errors.push(
        new SyntaxError(
          `<script> cannot use the "src" attribute when <script setup> is ` +
            `also present because they must be processed together.`
        )
      )
      descriptor.script = null
    }
  }

  if (sourceMap) {
    const genMap = (block: SFCBlock | null) => {
      if (block && !block.src) {
        block.map = generateSourceMap(
          filename,
          source,
          block.content,
          sourceRoot,
          !pad || block.type === 'template' ? block.loc.start.line - 1 : 0
        )
      }
    }
    genMap(descriptor.template)
    genMap(descriptor.script)
    descriptor.styles.forEach(genMap)
    descriptor.customBlocks.forEach(genMap)
  }

  // 解析css变量
  // parse CSS vars
  descriptor.cssVars = parseCssVars(descriptor)

  // 检查这个sfc是否使用了:slotted
  // 也就是style标签内容中是否出现/(?:::v-|:)slotted\(/这个正则对象
  // check if the SFC uses :slotted
  const slottedRE = /(?:::v-|:)slotted\(/
  descriptor.slotted = descriptor.styles.some(
    s => s.scoped && slottedRE.test(s.content)
  )

  // 作为一个结果对象返回
  const result = {
    descriptor,
    errors
  }
  // 缓存结果
  sourceToSFC.set(sourceKey, result)
  return result // 返回结果对象
}
/* 
parse函数的大致流程：
根据source + sourceMap + filename + sourceRoot + pad + compiler.parse准备sourceKey
然后在sourceToSFC map中获取cache，有则直接返回
准备descriptor对象
const descriptor: SFCDescriptor = {
  filename,
  source,
  template: null,
  script: null,
  scriptSetup: null,
  styles: [],
  customBlocks: [],
  cssVars: [],
  slotted: false,
  shouldForceReload: prevImports => hmrShouldReload(prevImports, descriptor)
}
使用compiler.parse解析source，其中需要注意的是传递的options参数对象，能够得到ast语法树。【options对象需要注意，尤其是getTextMode函数导致的【文本模式】而影响的【解析逻辑】】
{
  // SFC 解析级别没有组件
  // there are no components at SFC parsing level
  isNativeTag: () => true, // 一律返回true // +++
  // preserve all whitespaces
  isPreTag: () => true, // 返回true // +++
  // 获取文本模式
  getTextMode: ({ tag, props }, parent) => {
    // 除<template>外的所有顶级元素都被解析为raw text容器 // +++
    // all top level elements except <template> are parsed as raw text
    // containers
    if (
      (!parent && tag !== 'template') || // 顶级元素且标签不是template
      // <template lang="xxx">也应被视为raw text
      // <template lang="xxx"> should also be treated as raw text
      (tag === 'template' &&
        props.some(
          p =>
            p.type === NodeTypes.ATTRIBUTE &&
            p.name === 'lang' &&
            p.value &&
            p.value.content &&
            p.value.content !== 'html'
        ))
    ) {
      return TextModes.RAWTEXT // 文本模式为RAWTEXT
    } else {
      // 其它的都是TextModes.DATA
      return TextModes.DATA // 文本模式为DATA
    }
  },
}
遍历ast语法树（注意只遍历最顶级的一层），对每一个node的tag进行createBlock，该函数实际上就是准备block对象{type: node.tag, content, attrs对象（包含特殊的属性）, 还有特殊的属性单独放在此block对象中: lang、src、scoped、module、setup}
switch node.tag
  script
  template
  style
  default - custom
解析css变量
descriptor.cssVars = parseCssVars(descriptor)
检查描述符对象中style blocks中每一个block是否scoped且块的内容中::v-slotted或:slotted字样，若有就需要给描述符对象添加slotted属性值为true
准备result对象{descriptor, errors}
根据sourceToSFC=>result键值对存入sourceToSFC map中
返回这个result对象
*/

function createDuplicateBlockError(
  node: ElementNode,
  isScriptSetup = false
): CompilerError {
  const err = new SyntaxError(
    `Single file component can contain only one <${node.tag}${
      isScriptSetup ? ` setup` : ``
    }> element`
  ) as CompilerError
  err.loc = node.loc
  return err
}

// 创建对应的块对象
function createBlock(
  node: ElementNode,
  source: string,
  pad: SFCParseOptions['pad']
): SFCBlock {
  const type = node.tag
  let { start, end } = node.loc
  let content = ''
  if (node.children.length) {
    start = node.children[0].loc.start
    end = node.children[node.children.length - 1].loc.end
    content = source.slice(start.offset, end.offset) // content为source的提取字符串
  } else {
    const offset = node.loc.source.indexOf(`</`)
    if (offset > -1) {
      start = {
        line: start.line,
        column: start.column + offset,
        offset: start.offset + offset
      }
    }
    end = { ...start }
  }
  const loc = {
    source: content,
    start,
    end
  }
  const attrs: Record<string, string | true> = {} // 看他的这个类型标识
  // 准备sfc block对象
  const block: SFCBlock = {
    type,
    content,
    loc,
    attrs
  }
  if (pad) {
    block.content = padContent(source, block, pad) + block.content
  }
  // 对此节点的属性进行遍历
  // 
  node.props.forEach(p => {
    if (p.type === NodeTypes.ATTRIBUTE) {
      attrs[p.name] = p.value ? p.value.content || true : true
      if (p.name === 'lang') {
        block.lang = p.value && p.value.content
      } else if (p.name === 'src') {
        block.src = p.value && p.value.content
      } else if (type === 'style') {
        if (p.name === 'scoped') {
          ;(block as SFCStyleBlock).scoped = true
        } else if (p.name === 'module') {
          ;(block as SFCStyleBlock).module = attrs[p.name]
        }
      } else if (type === 'script' && p.name === 'setup') { // 针对setup
        // 给块对象上添加setup属性
        ;(block as SFCScriptBlock).setup = attrs.setup
      }
    }
  })
  // 返回block对象
  return block
}

const splitRE = /\r?\n/g
const emptyRE = /^(?:\/\/)?\s*$/
const replaceRE = /./g

function generateSourceMap(
  filename: string,
  source: string,
  generated: string,
  sourceRoot: string,
  lineOffset: number
): RawSourceMap {
  const map = new SourceMapGenerator({
    file: filename.replace(/\\/g, '/'),
    sourceRoot: sourceRoot.replace(/\\/g, '/')
  })
  map.setSourceContent(filename, source)
  generated.split(splitRE).forEach((line, index) => {
    if (!emptyRE.test(line)) {
      const originalLine = index + 1 + lineOffset
      const generatedLine = index + 1
      for (let i = 0; i < line.length; i++) {
        if (!/\s/.test(line[i])) {
          map.addMapping({
            source: filename,
            original: {
              line: originalLine,
              column: i
            },
            generated: {
              line: generatedLine,
              column: i
            }
          })
        }
      }
    }
  })
  return JSON.parse(map.toString())
}

function padContent(
  content: string,
  block: SFCBlock,
  pad: SFCParseOptions['pad']
): string {
  content = content.slice(0, block.loc.start.offset)
  if (pad === 'space') {
    return content.replace(replaceRE, ' ')
  } else {
    const offset = content.split(splitRE).length
    const padChar = block.type === 'script' && !block.lang ? '//\n' : '\n'
    return Array(offset).join(padChar)
  }
}

function hasSrc(node: ElementNode) {
  return node.props.some(p => {
    if (p.type !== NodeTypes.ATTRIBUTE) {
      return false
    }
    return p.name === 'src'
  })
}

/**
 * Returns true if the node has no children
 * once the empty text nodes (trimmed content) have been filtered out.
 */
function isEmpty(node: ElementNode) {
  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i]
    if (child.type !== NodeTypes.TEXT || child.content.trim() !== '') {
      return false
    }
  }
  return true
}
