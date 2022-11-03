import {
  TextModes,
  ParserOptions,
  ElementNode,
  Namespaces,
  NodeTypes,
  isBuiltInType
} from '@vue/compiler-core'
import { makeMap, isVoidTag, isHTMLTag, isSVGTag } from '@vue/shared'
import { TRANSITION, TRANSITION_GROUP } from './runtimeHelpers'
import { decodeHtml } from './decodeHtml'
import { decodeHtmlBrowser } from './decodeHtmlBrowser'

const isRawTextContainer = /*#__PURE__*/ makeMap(
  'style,iframe,script,noscript',
  true
)

// dom命名空间
export const enum DOMNamespaces {
  HTML = Namespaces.HTML,
  SVG,
  MATH_ML
}

export const parserOptions: ParserOptions = {
  // 是否为空标签
  isVoidTag,
  // 是否为原生标签
  isNativeTag: tag => isHTMLTag(tag) || isSVGTag(tag),
  isPreTag: tag => tag === 'pre',
  decodeEntities: __BROWSER__ ? decodeHtmlBrowser : decodeHtml,

  // 是否为内置组件标签
  isBuiltInComponent: (tag: string): symbol | undefined => {
    if (isBuiltInType(tag, `Transition`)) {
      return TRANSITION
    } else if (isBuiltInType(tag, `TransitionGroup`)) {
      return TRANSITION_GROUP
    }
  },

  // 获取标签的命名空间
  // https://html.spec.whatwg.org/multipage/parsing.html#tree-construction-dispatcher
  getNamespace(tag: string, parent: ElementNode | undefined): DOMNamespaces {
    let ns = parent ? parent.ns : DOMNamespaces.HTML // 默认为DOMNamespaces.HTML命名空间

    if (parent && ns === DOMNamespaces.MATH_ML) {
      if (parent.tag === 'annotation-xml') {
        if (tag === 'svg') {
          return DOMNamespaces.SVG
        }
        if (
          parent.props.some(
            a =>
              a.type === NodeTypes.ATTRIBUTE &&
              a.name === 'encoding' &&
              a.value != null &&
              (a.value.content === 'text/html' ||
                a.value.content === 'application/xhtml+xml')
          )
        ) {
          ns = DOMNamespaces.HTML
        }
      } else if (
        /^m(?:[ions]|text)$/.test(parent.tag) &&
        tag !== 'mglyph' &&
        tag !== 'malignmark'
      ) {
        ns = DOMNamespaces.HTML
      }
    } else if (parent && ns === DOMNamespaces.SVG) {
      if (
        parent.tag === 'foreignObject' ||
        parent.tag === 'desc' ||
        parent.tag === 'title'
      ) {
        ns = DOMNamespaces.HTML
      }
    }

    if (ns === DOMNamespaces.HTML) {
      if (tag === 'svg') {
        return DOMNamespaces.SVG
      }
      if (tag === 'math') {
        return DOMNamespaces.MATH_ML
      }
    }
    return ns // 正常情况大部分都是返回的DOMNamespaces.HTML
  },

  // 获取文本模式
  // https://html.spec.whatwg.org/multipage/parsing.html#parsing-html-fragments
  getTextMode({ tag, ns }: ElementNode): TextModes {
    if (ns === DOMNamespaces.HTML) {
      if (tag === 'textarea' || tag === 'title') {
        return TextModes.RCDATA
      }
      // style,iframe,script,noscript标签
      if (isRawTextContainer(tag)) {
        return TextModes.RAWTEXT
      }
    }
    // 其它的返回TextModes.DATA
    return TextModes.DATA
  }
}
