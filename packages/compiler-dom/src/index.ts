import {
  baseCompile,
  baseParse,
  CompilerOptions,
  CodegenResult,
  ParserOptions,
  RootNode,
  noopDirectiveTransform,
  NodeTransform,
  DirectiveTransform
} from '@vue/compiler-core'
import { parserOptions } from './parserOptions'
import { transformStyle } from './transforms/transformStyle'
import { transformVHtml } from './transforms/vHtml'
import { transformVText } from './transforms/vText'
import { transformModel } from './transforms/vModel'
import { transformOn } from './transforms/vOn'
import { transformShow } from './transforms/vShow'
import { transformTransition } from './transforms/Transition'
import { stringifyStatic } from './transforms/stringifyStatic'
import { ignoreSideEffectTags } from './transforms/ignoreSideEffectTags'
import { extend } from '@vue/shared'

export { parserOptions }

// 节点转换函数数组
export const DOMNodeTransforms: NodeTransform[] = [
  transformStyle,
  ...(__DEV__ ? [transformTransition] : [])
]

// 指令转换函数对象
export const DOMDirectiveTransforms: Record<string, DirectiveTransform> = {
  cloak: noopDirectiveTransform,
  html: transformVHtml,
  text: transformVText,
  model: transformModel, // override compiler-core
  on: transformOn, // override compiler-core
  show: transformShow
}

// 对模板字符串进行编译
export function compile(
  template: string,
  options: CompilerOptions = {}
): CodegenResult {
  return baseCompile(
    template, // 模板字符串
    extend({}, parserOptions, options, {
      // 节点转换函数数组
      nodeTransforms: [
        // ignore <script> and <tag>
        // this is not put inside DOMNodeTransforms because that list is used
        // by compiler-ssr to generate vnode fallback branches
        ignoreSideEffectTags,
        ...DOMNodeTransforms,
        ...(options.nodeTransforms || [])
      ],
      // 指令转换函数对象
      directiveTransforms: extend(
        {},
        DOMDirectiveTransforms,
        options.directiveTransforms || {}
      ),
      // 转换提升
      // 此优化仅在 Node.js 中执行。
      // 浏览器端是没有此优化的
      // 在compiler-core/src/transform.ts中进行的（也就是在转换阶段处理的）
      // 此函数是在compiler-core/src/transforms/hoistStatic.ts里面使用的
      // 详细的细节可以到compiler-dom/src/transforms/stringifyStatic.ts以及compiler-core/src/transforms/hoistStatic.ts下查看说明
      transformHoist: __BROWSER__ ? null : stringifyStatic
    })
  )
}
/* 
在packages/compiler-sfc/src/compileTemplate.ts文件下执行的该函数 // +++
compiler.compile(source, { // @vue/compiler-dom下的compile函数
  mode: 'module', // 模式为module - 模块
  prefixIdentifiers: true, // 开启前缀标识符
  hoistStatic: true, // 开启静态提升
  cacheHandlers: true, // 开启缓存处理
  ssrCssVars:
    ssr && ssrCssVars && ssrCssVars.length
      ? genCssVarsFromList(ssrCssVars, shortId, isProd, true)
      : '',
  scopeId: scoped ? longId : undefined, // 作用域id
  slotted,
  sourceMap: true,
  // vite/packages/plugin-vue/src/template.ts中也没有什么值得注意的编译参数选项
  ...compilerOptions, // 参照resolveTemplateCompilerOptions函数返回的对象中组合的参数对象 // +++

  // vite/packages/plugin-vue/src/template.ts也没有再添加节点转换函数数组了，所以这里面的默认的就够用了
  nodeTransforms: nodeTransforms.concat(compilerOptions.nodeTransforms || []), // 节点转换函数数组
  // 【拼接】compilerOptions.nodeTransforms（其来源于用户传入的options.template.compilerOptions.nodeTransforms属性）

  // 另外还需要注意这里的nodeTransforms变量，就是上面所述的这个 // +++

  filename, // 文件名 // +++
  onError: e => errors.push(e),
  onWarn: w => warnings.push(w)
})

该函数的主要功能：
return baseCompile( // packages/compiler-core/src/compile.ts下的baseCompile函数 +++
  template, // 模板字符串
  // packages/shared/src/index.ts下的export const extend = Object.assign

  extend({}, parserOptions, options, {
    // 节点转换函数数组
    nodeTransforms: [
      // ignore <script> and <tag>
      // this is not put inside DOMNodeTransforms because that list is used
      // by compiler-ssr to generate vnode fallback branches
      ignoreSideEffectTags, // 忽略副作用标签 // 它不会放在DOMNodeTransforms中，因为compiler-ssr使用该list来生成vnode回退分支
      ...DOMNodeTransforms,
      ...(options.nodeTransforms || [])
    ],
    // 指令转换函数对象
    directiveTransforms: extend(
      {},
      DOMDirectiveTransforms,
      options.directiveTransforms || {}
    ),
    // 转换提升
    // 此优化仅在 Node.js 中执行。
    // 浏览器端是没有此优化的
    // 在compiler-core/src/transform.ts中进行的（也就是在转换阶段处理的）
    // 此函数是在compiler-core/src/transforms/hoistStatic.ts里面使用的
    // 详细的细节可以到compiler-dom/src/transforms/stringifyStatic.ts以及compiler-core/src/transforms/hoistStatic.ts下查看说明
    transformHoist: __BROWSER__ ? null : stringifyStatic
  })
)

// 这里对最终的options对象做叙述 // +++
{
  // 注意这里面的getTextMode函数，它会影响parse解析逻辑的走向 // +++
  ...parserOptions, // packages/compiler-dom/src/parserOptions.ts

  ...options, // 上面的参数options对象 // +++

  // 节点转换函数数组
  nodeTransforms: [
    // 忽略<script> 和 <tag>
    // ignore <script> and <tag>
    // this is not put inside DOMNodeTransforms because that list is used
    // by compiler-ssr to generate vnode fallback branches
    ignoreSideEffectTags, // 忽略副作用标签 // 它不会放在DOMNodeTransforms中，因为compiler-ssr使用该list来生成vnode回退分支
    ...DOMNodeTransforms,
    ...(options.nodeTransforms || [])
  ],
  // 指令转换函数对象
  directiveTransforms: extend(
    {},
    DOMDirectiveTransforms,
    options.directiveTransforms || {}
  ),
  // 转换提升
  // 此优化仅在 Node.js 中执行。
  // 浏览器端是没有此优化的
  // 在compiler-core/src/transform.ts中进行的（也就是在转换阶段处理的）
  // 此函数是在compiler-core/src/transforms/hoistStatic.ts里面使用的 // ===
  // 详细的细节可以到compiler-dom/src/transforms/stringifyStatic.ts以及compiler-core/src/transforms/hoistStatic.ts下查看说明
  transformHoist: __BROWSER__ ? null : stringifyStatic
}

// ===

// 针对nodeTransforms以及directiveTransforms做特殊说明：
nodeTransforms: [
  // packages/compiler-dom/src/transforms
  ignoreSideEffectTags,
  transformStyle,
  ...(__DEV__ ? [transformTransition] : []),

  templateTransformAssetUrl, // packages/compiler-sfc/src/templateTransformAssetUrl.ts
  templateTransformSrcset, // packages/compiler-sfc/src/templateTransformSrcset.ts
],
directiveTransforms: {
  cloak: noopDirectiveTransform, // packages/compiler-core/src/transforms/noopDirectiveTransform.ts

  // packages/compiler-dom/src/transforms
  html: transformVHtml,
  text: transformVText,
  // 重写compiler-core
  model: transformModel, // override compiler-core
  on: transformOn, // override compiler-core
  show: transformShow
},
transformHoist: __BROWSER__ ? null : stringifyStatic // // packages/compiler-dom/src/transforms
*/

export function parse(template: string, options: ParserOptions = {}): RootNode {
  return baseParse(template, extend({}, parserOptions, options))
}

export * from './runtimeHelpers'
export { transformStyle } from './transforms/transformStyle'
export { createDOMCompilerError, DOMErrorCodes } from './errors'
export * from '@vue/compiler-core'
