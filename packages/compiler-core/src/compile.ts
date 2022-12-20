import { CompilerOptions } from './options'
import { baseParse } from './parse'
import { transform, NodeTransform, DirectiveTransform } from './transform'
import { generate, CodegenResult } from './codegen'
import { RootNode } from './ast'
import { isString, extend } from '@vue/shared'
import { transformIf } from './transforms/vIf'
import { transformFor } from './transforms/vFor'
import { transformExpression } from './transforms/transformExpression'
import { transformSlotOutlet } from './transforms/transformSlotOutlet'
import { transformElement } from './transforms/transformElement'
import { transformOn } from './transforms/vOn'
import { transformBind } from './transforms/vBind'
import { trackSlotScopes, trackVForSlotScopes } from './transforms/vSlot'
import { transformText } from './transforms/transformText'
import { transformOnce } from './transforms/vOnce'
import { transformModel } from './transforms/vModel'
import { transformFilter } from './compat/transformFilter'
import { defaultOnError, createCompilerError, ErrorCodes } from './errors'
import { transformMemo } from './transforms/vMemo'

export type TransformPreset = [
  NodeTransform[],
  Record<string, DirectiveTransform>
]

// 过去基础转换预设
export function getBaseTransformPreset(
  prefixIdentifiers?: boolean
): TransformPreset {
  return [
    // 顺序
    [
      transformOnce,
      transformIf,
      transformMemo,
      transformFor,
      ...(__COMPAT__ ? [transformFilter] : []),
      ...(!__BROWSER__ && prefixIdentifiers
        ? [
            // order is important // 顺序是重要的 // +++
            trackVForSlotScopes,
            transformExpression
          ]
        : __BROWSER__ && __DEV__
        ? [transformExpression]
        : []),
      transformSlotOutlet,
      transformElement,
      trackSlotScopes,
      transformText
    ],
    {
      on: transformOn,
      bind: transformBind,
      model: transformModel
    }
  ]
}

// we name it `baseCompile` so that higher order compilers like
// @vue/compiler-dom can export `compile` while re-exporting everything else.
export function baseCompile(
  template: string | RootNode,
  options: CompilerOptions = {}
): CodegenResult {
  const onError = options.onError || defaultOnError
  const isModuleMode = options.mode === 'module' // 是否是模块模式
  /* istanbul ignore if */
  if (__BROWSER__) {
    if (options.prefixIdentifiers === true) {
      onError(createCompilerError(ErrorCodes.X_PREFIX_ID_NOT_SUPPORTED))
    } else if (isModuleMode) { // 模块模式在浏览器端是不支持的，直接进行报错
      onError(createCompilerError(ErrorCodes.X_MODULE_MODE_NOT_SUPPORTED))
    }
  }

  const prefixIdentifiers =
    !__BROWSER__ && (options.prefixIdentifiers === true || isModuleMode)
  if (!prefixIdentifiers && options.cacheHandlers) {
    onError(createCompilerError(ErrorCodes.X_CACHE_HANDLER_NOT_SUPPORTED))
  }
  if (options.scopeId && !isModuleMode) {
    onError(createCompilerError(ErrorCodes.X_SCOPE_ID_NOT_SUPPORTED))
  }

  // 对其模板字符串进行解析生成对应的ast语法树
  const ast = isString(template) ? baseParse(template, options) : template
  // ---
  // 准备相应的节点转换函数数组、指令转换函数对象
  // ---
  const [nodeTransforms, directiveTransforms] =
    getBaseTransformPreset(prefixIdentifiers) // 也就是生成默认的一些函数罢了
  
  
  // directiveTransforms是被用在transformElement.ts、transformText.ts中的

  /* 
  只考虑@vue/compiler-sfc的情况下且不兼容那么默认的顺序

  节点
  [
    once
    if // +++
    memo
    for // +++
    trackVForSlotScopes
    transformExpression
    transformSlotOutlet
    transformElement // +++
    trackSlotScopes
    transformText
    transformStyle
    __DEV__ && transformTransition

  ]
  
  指令
  {
    @vue/compiler-core
    v-on
    v-bind
    v-model
    @vue-compiler-dom
    cloak
    html
    text
    model - override compiler-core
    on - override compiler-core
    show
  }
  */

  if (!__BROWSER__ && options.isTS) {
    const { expressionPlugins } = options
    if (!expressionPlugins || !expressionPlugins.includes('typescript')) {
      options.expressionPlugins = [...(expressionPlugins || []), 'typescript']
    }
  }

  // 转换阶段的处理逻辑都被分散处理
  // 所以重要的就是在各个转换函数中对某一项进行对应的特殊处理

  // 迭代ast语法树对每个节点进行转换，产生对应的codegenNode
  transform(
    ast,
    extend({}, options, {
      prefixIdentifiers,
      // 节点转换函数数组
      nodeTransforms: [
        ...nodeTransforms,
        ...(options.nodeTransforms || []) // user transforms
      ],
      // 指令转换函数对象
      directiveTransforms: extend(
        {},
        directiveTransforms,
        options.directiveTransforms || {} // user transforms
      )
    })
  )

  // 迭代ast语法树上每个节点的codegenNode，根据它生成对应的字符串
  return generate(
    ast,
    extend({}, options, {
      prefixIdentifiers
    })
  )
}
/* 
packages/compiler-dom/src/index.ts

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

/* 
此函数具体功能：
是否为模块模式 - options.mode === 'module'
prefixIdentifiers - true
// 1. 解析
得到ast语法树 - baseParse(template, options) // packages/compiler-core/src/parse.ts
得到默认的参数 - const [nodeTransforms, directiveTransforms] = getBaseTransformPreset(prefixIdentifiers)
  // getBaseTransformPreset函数直接返回
  return [
    // 顺序
    [
      transformOnce,
      transformIf,
      transformMemo,
      transformFor,
      ...(__COMPAT__ ? [transformFilter] : []),
      ...(!__BROWSER__ && prefixIdentifiers
        ? [
            // order is important // 顺序是重要的 // +++
            trackVForSlotScopes,
            transformExpression
          ]
        : __BROWSER__ && __DEV__
        ? [transformExpression]
        : []),
      transformSlotOutlet,
      transformElement,
      trackSlotScopes,
      transformText
    ],
    {
      on: transformOn,
      bind: transformBind,
      model: transformModel
    }
  ]
不是在浏览器端 且 options.isTS
  options.expressionPlugins = [...(expressionPlugins || []), 'typescript']

// 2. 转换
transform(
  ast,
  extend({}, options, {
    prefixIdentifiers,
    nodeTransforms: [
      ...nodeTransforms,
      ...(options.nodeTransforms || []) // user transforms
    ],
    directiveTransforms: extend(
      {},
      directiveTransforms,
      options.directiveTransforms || {} // user transforms
    )
  })
) // packages/compiler-core/src/transform.ts

// extend函数其实就是@vue/shared下的Object.assign函数

// 3. 生成
return generate(
  ast,
  extend({}, options, {
    prefixIdentifiers
  })
) // packages/compiler-core/src/codegen.ts
*/

/* 
这里对nodeTransforms以及directiveTransforms做特殊说明
nodeTransforms: [
  // packages/compiler-core/src/compile.ts
    transformOnce,
    transformIf,
    transformMemo,
    transformFor,
    ...(__COMPAT__ ? [transformFilter] : []),
    ...(!__BROWSER__ && prefixIdentifiers
      ? [
          // order is important // 顺序是重要的 // +++
          trackVForSlotScopes,
          transformExpression
        ]
      : __BROWSER__ && __DEV__
      ? [transformExpression]
      : []),
    transformSlotOutlet,
    transformElement,
    trackSlotScopes,
    transformText
  // packages/compiler-dom/src/index.ts
    // packages/compiler-dom/src/transforms
    ignoreSideEffectTags,
    transformStyle,
    ...(__DEV__ ? [transformTransition] : []),

    templateTransformAssetUrl, // packages/compiler-sfc/src/templateTransformAssetUrl.ts
    templateTransformSrcset, // packages/compiler-sfc/src/templateTransformSrcset.ts
]

directiveTransforms: {
  // packages/compiler-core/src/compile.ts
    on: transformOn,
    bind: transformBind,
    model: transformModel
  // packages/compiler-dom/src/index.ts
    cloak: noopDirectiveTransform, // packages/compiler-core/src/transforms/noopDirectiveTransform.ts

    // packages/compiler-dom/src/transforms
    html: transformVHtml,
    text: transformVText,
    // 重写compiler-core
    model: transformModel, // override compiler-core
    on: transformOn, // override compiler-core
    show: transformShow
}
*/


/* 
OPEN_BLOCK
  root
    单
      open 单
    多
      open fragment
        多
  v-for
    open fragment
      // ++++++++++++++++++
      fragment的孩子就是renderList函数执行的结果 - 而renderList函数传入的函数它所返回的孩子是否open具体情况还需要在+++ vFor.ts +++中退出函数中查看具体对应的逻辑
      childBlock is block还需看具体看退出函数中所写的逻辑 这里不太好说 所以具体可以详细了解 ~
      // +++++++++++
  v-if
    open 元素
  v-memo - 在节点标签类型不是组件类型时才open
  动态组件 || teleport || suspense || 不是组件但是为svg或foreignObject
    open
  元素属性:key或<div @beforeUpdate>xxx</div>有孩子的使用这个内联钩子还有有孩子的使用用户自定义指令<div v-zzz>xxx</div>
    open
  <keep-alive>xxx</keep-alive>
    open
*/

// 参数是在codegen.ts中的genVNodeCall函数中根据vnode调用表达式节点的disableTracking为true生成字符串true，false不生成任何东西
// openBlock() // 该函数是有参数的 -> disableTracking
// false是不禁用收集
// true是禁用收集
// 它会影响运行时createBaseVNode函数内收集vnode到块树的逻辑以及setupBlock函数内的逻辑

// openBlock的作用 - 在runtime-core/src/vnode.ts中具体查看
