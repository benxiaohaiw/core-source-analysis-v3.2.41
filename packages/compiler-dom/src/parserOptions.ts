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

// 是否为原生文本容器 // +++
const isRawTextContainer = /*#__PURE__*/ makeMap( // 制作map
  'style,iframe,script,noscript',
  true // 期望小写字母
)

// dom命名空间
export const enum DOMNamespaces {
  HTML = Namespaces.HTML,
  SVG,
  MATH_ML
}
// dom命名空间分为：HTML、SVG、MATH_ML // +++

/* 
packages/shared/src/makeMap.ts
export function makeMap(
  str: string,
  expectsLowerCase?: boolean // expectsLowerCase: 是否期望小写字母
): (key: string) => boolean {
  const map: Record<string, boolean> = Object.create(null)
  const list: Array<string> = str.split(',')
  for (let i = 0; i < list.length; i++) {
    map[list[i]] = true
  }
  return expectsLowerCase ? val => !!map[val.toLowerCase()] : val => !!map[val]
}
*/

// packages/shared/src/domTagConfig.ts
// // https://developer.mozilla.org/en-US/docs/Web/HTML/Element
// const HTML_TAGS =
//   'html,body,base,head,link,meta,style,title,address,article,aside,footer,' +
//   'header,h1,h2,h3,h4,h5,h6,nav,section,div,dd,dl,dt,figcaption,' +
//   'figure,picture,hr,img,li,main,ol,p,pre,ul,a,b,abbr,bdi,bdo,br,cite,code,' +
//   'data,dfn,em,i,kbd,mark,q,rp,rt,ruby,s,samp,small,span,strong,sub,sup,' +
//   'time,u,var,wbr,area,audio,map,track,video,embed,object,param,source,' +
//   'canvas,script,noscript,del,ins,caption,col,colgroup,table,thead,tbody,td,' +
//   'th,tr,button,datalist,fieldset,form,input,label,legend,meter,optgroup,' +
//   'option,output,progress,select,textarea,details,dialog,menu,' +
//   'summary,template,blockquote,iframe,tfoot'

// // https://developer.mozilla.org/en-US/docs/Web/SVG/Element
// const SVG_TAGS =
//   'svg,animate,animateMotion,animateTransform,circle,clipPath,color-profile,' +
//   'defs,desc,discard,ellipse,feBlend,feColorMatrix,feComponentTransfer,' +
//   'feComposite,feConvolveMatrix,feDiffuseLighting,feDisplacementMap,' +
//   'feDistanceLight,feDropShadow,feFlood,feFuncA,feFuncB,feFuncG,feFuncR,' +
//   'feGaussianBlur,feImage,feMerge,feMergeNode,feMorphology,feOffset,' +
//   'fePointLight,feSpecularLighting,feSpotLight,feTile,feTurbulence,filter,' +
//   'foreignObject,g,hatch,hatchpath,image,line,linearGradient,marker,mask,' +
//   'mesh,meshgradient,meshpatch,meshrow,metadata,mpath,path,pattern,' +
//   'polygon,polyline,radialGradient,rect,set,solidcolor,stop,switch,symbol,' +
//   'text,textPath,title,tspan,unknown,use,view'

// const VOID_TAGS =
//   'area,base,br,col,embed,hr,img,input,link,meta,param,source,track,wbr'

// /**
//  * Compiler only.
//  * Do NOT use in runtime code paths unless behind `__DEV__` flag.
//  */
// export const isHTMLTag = /*#__PURE__*/ makeMap(HTML_TAGS)
// /**
//  * Compiler only.
//  * Do NOT use in runtime code paths unless behind `__DEV__` flag.
//  */
// export const isSVGTag = /*#__PURE__*/ makeMap(SVG_TAGS)
// /**
//  * Compiler only.
//  * Do NOT use in runtime code paths unless behind `__DEV__` flag.
//  */
// export const isVoidTag = /*#__PURE__*/ makeMap(VOID_TAGS)

/* 
packages/compiler-core/src/utils.ts
export const isBuiltInType = (tag: string, expected: string): boolean =>
  tag === expected || tag === hyphenate(expected)
*/

// packages/shared/src/index.ts
// const cacheStringFunction = <T extends (str: string) => string>(fn: T): T => {
//   const cache: Record<string, string> = Object.create(null)
//   return ((str: string) => {
//     const hit = cache[str]
//     return hit || (cache[str] = fn(str))
//   }) as T
// }
// const hyphenateRE = /\B([A-Z])/g
// /**
//  * @private
//  */
// export const hyphenate = cacheStringFunction((str: string) =>
//   str.replace(hyphenateRE, '-$1').toLowerCase()
// )

// 解析参数
export const parserOptions: ParserOptions = {
  // 是否为空标签
  isVoidTag,
  // 是否为原生标签
  isNativeTag: tag => isHTMLTag(tag) || isSVGTag(tag),
  isPreTag: tag => tag === 'pre',
  decodeEntities: __BROWSER__ ? decodeHtmlBrowser : decodeHtml /** packages/compiler-dom/src/decodeHtml.ts */,

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
        return TextModes.RCDATA // textarea或title是RCDATA文本模式
      }
      // style,iframe,script,noscript标签
      if (isRawTextContainer(tag)) {
        return TextModes.RAWTEXT // 这些是原生文本模式
      }
    }
    // 其它的返回TextModes.DATA
    return TextModes.DATA // DATA文本模式
  }
  // 【特别注意这个获取文本模式函数，它将影响parse解析阶段的逻辑】 // +++
}
