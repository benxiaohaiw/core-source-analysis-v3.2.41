import {
  CompilerOptions,
  CodegenResult,
  CompilerError,
  NodeTransform,
  ParserOptions,
  RootNode
} from '@vue/compiler-core'
import { SourceMapConsumer, SourceMapGenerator, RawSourceMap } from 'source-map'
import {
  transformAssetUrl,
  AssetURLOptions,
  createAssetUrlTransformWithOptions,
  AssetURLTagConfig,
  normalizeOptions
} from './templateTransformAssetUrl'
import {
  transformSrcset,
  createSrcsetTransformWithOptions
} from './templateTransformSrcset'
import { generateCodeFrame, isObject } from '@vue/shared'
import * as CompilerDOM from '@vue/compiler-dom'
import * as CompilerSSR from '@vue/compiler-ssr'
import consolidate from '@vue/consolidate'
import { warnOnce } from './warn'
import { genCssVarsFromList } from './cssVars'

export interface TemplateCompiler {
  compile(template: string, options: CompilerOptions): CodegenResult
  parse(template: string, options: ParserOptions): RootNode
}

export interface SFCTemplateCompileResults {
  code: string
  ast?: RootNode
  preamble?: string
  source: string
  tips: string[]
  errors: (string | CompilerError)[]
  map?: RawSourceMap
}

export interface SFCTemplateCompileOptions {
  source: string
  filename: string
  id: string
  scoped?: boolean
  slotted?: boolean
  isProd?: boolean
  ssr?: boolean
  ssrCssVars?: string[]
  inMap?: RawSourceMap
  compiler?: TemplateCompiler
  compilerOptions?: CompilerOptions
  preprocessLang?: string
  preprocessOptions?: any
  /**
   * In some cases, compiler-sfc may not be inside the project root (e.g. when
   * linked or globally installed). In such cases a custom `require` can be
   * passed to correctly resolve the preprocessors.
   */
  preprocessCustomRequire?: (id: string) => any
  /**
   * Configure what tags/attributes to transform into asset url imports,
   * or disable the transform altogether with `false`.
   */
  transformAssetUrls?: AssetURLOptions | AssetURLTagConfig | boolean
}

interface PreProcessor {
  render(
    source: string,
    options: any,
    cb: (err: Error | null, res: string) => void
  ): void
}

function preprocess(
  { source, filename, preprocessOptions }: SFCTemplateCompileOptions,
  preprocessor: PreProcessor
): string {
  // Consolidate exposes a callback based API, but the callback is in fact
  // called synchronously for most templating engines. In our case, we have to
  // expose a synchronous API so that it is usable in Jest transforms (which
  // have to be sync because they are applied via Node.js require hooks)
  let res: string = ''
  let err: Error | null = null

  preprocessor.render(
    source,
    { filename, ...preprocessOptions },
    (_err, _res) => {
      if (_err) err = _err
      res = _res
    }
  )

  if (err) throw err
  return res
}

// 对template block进行编译
export function compileTemplate(
  options: SFCTemplateCompileOptions
): SFCTemplateCompileResults {
  const { preprocessLang, preprocessCustomRequire } = options

  if (
    (__ESM_BROWSER__ || __GLOBAL__) &&
    preprocessLang &&
    !preprocessCustomRequire
  ) {
    throw new Error(
      `[@vue/compiler-sfc] Template preprocessing in the browser build must ` +
        `provide the \`preprocessCustomRequire\` option to return the in-browser ` +
        `version of the preprocessor in the shape of { render(): string }.`
    )
  }

  // 语言的预处理器
  const preprocessor = preprocessLang
    ? preprocessCustomRequire
      ? preprocessCustomRequire(preprocessLang)
      : __ESM_BROWSER__
      ? undefined
      : consolidate[preprocessLang as keyof typeof consolidate]
    : false
  if (preprocessor) {
    try {
      return doCompileTemplate({
        ...options,
        source: preprocess(options, preprocessor)
      })
    } catch (e: any) {
      return {
        code: `export default function render() {}`,
        source: options.source,
        tips: [],
        errors: [e]
      }
    }
  } else if (preprocessLang) {
    return {
      code: `export default function render() {}`,
      source: options.source,
      tips: [
        `Component ${options.filename} uses lang ${preprocessLang} for template. Please install the language preprocessor.`
      ],
      errors: [
        `Component ${options.filename} uses lang ${preprocessLang} for template, however it is not installed.`
      ]
    }
  } else {
    // template中不使用预处理器的化默认都是这个逻辑
    return doCompileTemplate(options)
  }
}
/* 
compileTemplate函数主要功能：
它的参数options是由packages/plugin-vue/src/template.ts中的resolveTemplateCompilerOptions函数返回的options对象传递过来的
在options对象中preprocessLang, preprocessCustomRequire俩属性是重要的
其中preprocessLang就是经过packages/compiler-sfc/src/parse.ts中parse函数处理后返回的descriptor对象中template属性对应的block对象中的lang属性
而preprocessCustomRequire是【用户】传递过来的。
preprocessLang有值 // 这一步是得到【预处理器对象preprocessor】
? preprocessCustomRequire有值
  ? preprocessCustomRequire(preprocessLang) // 执行用户的函数
  : __ESM_BROWSER__
    ? undefined
    : consolidate[preprocessLang as keyof typeof consolidate]
: false

实际上就是多了一步对source的preprocess函数的处理 // +++
preprocess函数的主要逻辑：
  preprocessor.render函数的调用执行得到最终的res source，然后返回

那么我们当前得到的这个source就是经过处理转变之后的source了

随后整合进新的options对象中传递并执行doCompileTemplate函数 // ===

doCompileTemplate函数主要逻辑：
首先对其参数说明：
执行到这里compiler没有传递这个参数，那么所以这里使用的便是默认值啦 ~ 也就是CompilerDOM对象 // @vue/compiler-dom
compilerOptions、transformAssetUrls就是上文所说的经过resolveTemplateCompilerOptions函数处理的

由于默认情况下transformAssetUrls其实就是一个含有base属性的对象
所以这里的逻辑就是首先下面这个
  const assetOptions = normalizeOptions(transformAssetUrls) // 序列化参数
  nodeTransforms = [ // +++
    // packages/compiler-sfc/src/templateTransformAssetUrl.ts
    createAssetUrlTransformWithOptions(assetOptions), // 创建带有options的资源url转换函数
    // 主要作用：一个'@vue/compiler-core'插件，将相对资源url转换为导入import或绝对url。
    // 大概逻辑是过滤出节点类型为元素element的，然后对其属性props进行遍历过滤是attribute类型等条件的，然后根据具体的条件要么是直接
    // 重写相对url为绝对url或者是把当前这个属性改为【指令】类型的属性然后其arg为根据属性名创建的简单表达式其exp也是一个简单表达式，但是会把这个表达式以及对应的path组合为一个对象push进context.imports中 // +++
    
    // packages/compiler-sfc/src/templateTransformSrcset.ts
    createSrcsetTransformWithOptions(assetOptions) // 创建带有options的srcset转换函数
    // 主要作用：节点类型为元素element 且 节点标签为img或source 且 有属性
    // 且只针对属性名为srcset 且类型为attribute
    // 之后就是主要是把这个属性改为【指令类型】属性，指令类型属性的arg和exp做相应处理（具体看对应文件详细逻辑） // +++
  ]

const shortId = id.replace(/^data-v-/, '') // （dev下是当前文件路径相对于root的相对路径字符串然后对其做了一个hash获取前8为字符，pro下是相对路径拼接souce字符串然后做hash交给id属性） // +++
const longId = `data-v-${shortId}`

// 【特别注意下面的这个options对象，它是传入@vue/compiler-dom下的compile函数中的options对象参数】 // +++
// 此函数在packages/compiler-dom/src/index.ts下 // +++
// 使用编译器的编译函数对source进行编译，生成对应的代码字符串
let { code, ast, preamble, map } = compiler.compile(source, { // @vue/compiler-dom下的compile函数
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

...

// 直接返回代码字符串
// preamble: 前言
return { code, ast, preamble, source, errors, tips, map } // +++
*/

// 做编译模板逻辑
function doCompileTemplate({
  filename,
  id,
  scoped,
  slotted,
  inMap,
  source,
  ssr = false,
  ssrCssVars,
  isProd = false,
  compiler = ssr ? (CompilerSSR as TemplateCompiler) : CompilerDOM, // 也是@vue/compiler-dom
  compilerOptions = {},
  transformAssetUrls
}: SFCTemplateCompileOptions): SFCTemplateCompileResults {
  const errors: CompilerError[] = []
  const warnings: CompilerError[] = []

  let nodeTransforms: NodeTransform[] = []
  if (isObject(transformAssetUrls)) {
    const assetOptions = normalizeOptions(transformAssetUrls)
    nodeTransforms = [
      createAssetUrlTransformWithOptions(assetOptions),
      createSrcsetTransformWithOptions(assetOptions)
    ]
  } else if (transformAssetUrls !== false) {
    nodeTransforms = [transformAssetUrl, transformSrcset]
  }

  if (ssr && !ssrCssVars) {
    warnOnce(
      `compileTemplate is called with \`ssr: true\` but no ` +
        `corresponding \`cssVars\` option.\`.`
    )
  }
  if (!id) {
    warnOnce(`compileTemplate now requires the \`id\` option.\`.`)
    id = ''
  }

  const shortId = id.replace(/^data-v-/, '')
  const longId = `data-v-${shortId}`

  // 使用编译器的编译函数对source进行编译，生成对应的代码字符串
  let { code, ast, preamble, map } = compiler.compile(source, { // @vue/compiler-dom下的compile函数
    mode: 'module', // 模式为module
    prefixIdentifiers: true,
    hoistStatic: true, // 静态提升
    cacheHandlers: true,
    ssrCssVars:
      ssr && ssrCssVars && ssrCssVars.length
        ? genCssVarsFromList(ssrCssVars, shortId, isProd, true)
        : '',
    scopeId: scoped ? longId : undefined,
    slotted,
    sourceMap: true,
    // vite/packages/plugin-vue/src/template.ts中也没有什么值得注意的编译参数选项
    ...compilerOptions,
    // vite/packages/plugin-vue/src/template.ts也没有再添加节点转换函数数组了，所以这里面的默认的就够用了
    nodeTransforms: nodeTransforms.concat(compilerOptions.nodeTransforms || []), // 节点转换函数数组
    filename,
    onError: e => errors.push(e),
    onWarn: w => warnings.push(w)
  })

  // inMap should be the map produced by ./parse.ts which is a simple line-only
  // mapping. If it is present, we need to adjust the final map and errors to
  // reflect the original line numbers.
  if (inMap) {
    if (map) {
      map = mapLines(inMap, map)
    }
    if (errors.length) {
      patchErrors(errors, source, inMap)
    }
  }

  const tips = warnings.map(w => {
    let msg = w.message
    if (w.loc) {
      msg += `\n${generateCodeFrame(
        source,
        w.loc.start.offset,
        w.loc.end.offset
      )}`
    }
    return msg
  })

  // 直接返回代码字符串
  // preamble: 前言
  return { code, ast, preamble, source, errors, tips, map }
}
/* 
@vitejs/plugin-vue是如何应用当前@vue/compiler-sfc包的？

在packages/plugin-vue/src/index.ts中的vuePlugin函数所返回的对象中的buildStart函数会执行options.compiler = options.compiler || resolveCompiler(options.root)
而packages/plugin-vue/src/compiler.ts下的resolveCompiler函数内部实际上就是从根路径root下require引入vue/compiler-sfc然后返回整个compiler对象
那么根据插件的流程来讲resolveId实际上就是返回.vue文件的真实路径 -> load也是直接加载.vue文件的内容 -> transform 因为id是真实路径那么在解析query时并没有vue参数，所以接下来来到
packages/plugin-vue/src/main.ts下的transformMain函数中：
  createDescriptor（packages/plugin-vue/src/utils/descriptorCache.ts）
    会根据之前resolve后的compiler对象的parse函数处理这个source
      packages/compiler-sfc/src/parse.ts下的parse函数（详细逻辑见此文件【packages/compiler-sfc/src/parse.ts】）
    得到descriptor对象然后给该对象添加id属性（dev下是当前文件路径相对于root的相对路径字符串然后对其做了一个hash获取前8为字符，pro下是相对路径拼接souce字符串然后做hash交给id属性） // +++
    按照文件路径=>descriptor对象键值对存入cache map中
    然后把这个descriptor对象返回出去
  genScriptCode
  genTemplateCode（packages/plugin-vue/src/main.ts）
    !descriptor.template.lang && !descriptor.template.src -> transformTemplateInMain（packages/plugin-vue/src/template.ts）
      compile函数执行得到一个result对象
        options.compiler.compileTemplate函数的执行得到一个result对象，【此函数就是这里的compileTemplate函数】，格外注意它的参数是由resolveTemplateCompilerOptions函数执行后得到的options
          resolveTemplateCompilerOptions函数返回的options对象格式如下：
            return {
                // 关于options的传递：packages/plugin-vue/src/index.ts中vuePlugin函数中准备的options对象，其中汇入了由用户传入的rawOptions对象（这点要注意），之后经过configResolved
                // configureServer、buildStart一系列的钩子对options对象做处理那么之后在transform钩子中执行了transformMain函数并传入了此options对象
                // 之后再传入genTemplateCode，那么之后就到达了最终的resolveTemplateCompilerOptions函数
                // 那么其中需要进行注意的是在一开始准备options对象时就汇入了用户传入的参数对象了，这点需要注意！！！
              ...options.template, // 在packages/plugin-vue/src/index.ts中vuePlugin函数中参数Options的ts类型知道template是用户传过来的参数
              id, // +++
              filename,
              scoped: hasScoped,
              slotted: descriptor.slotted,
              isProd: options.isProduction,
              inMap: block.src ? undefined : block.map,
              ssr,
              ssrCssVars: cssVars,
              transformAssetUrls, // +++ 注意一下
                // transformAssetUrls参数在dev下默认是下面这个assetUrlOptions对象
                const devBase = options.devServer.config.base
                assetUrlOptions = {
                  base:
                    (options.devServer.config.server?.origin ?? '') +
                    devBase +
                    slash(path.relative(options.root, path.dirname(filename)))
                }
              preprocessLang: block.lang,
              preprocessOptions,
              compilerOptions: {
                ...options.template?.compilerOptions, // 和上面的options.template一个意思，就是用户传过来的参数对象中template参数
                scopeId: hasScoped ? `data-v-${id}` : undefined,
                bindingMetadata: resolvedScript ? resolvedScript.bindings : undefined,
                expressionPlugins,
                sourceMap: options.sourceMap
              }
            }
        【compileTemplate函数具体逻辑看上面详细描述！！！】
        返回result对象
      返回一个result对象
  ...

*/

function mapLines(oldMap: RawSourceMap, newMap: RawSourceMap): RawSourceMap {
  if (!oldMap) return newMap
  if (!newMap) return oldMap

  const oldMapConsumer = new SourceMapConsumer(oldMap)
  const newMapConsumer = new SourceMapConsumer(newMap)
  const mergedMapGenerator = new SourceMapGenerator()

  newMapConsumer.eachMapping(m => {
    if (m.originalLine == null) {
      return
    }

    const origPosInOldMap = oldMapConsumer.originalPositionFor({
      line: m.originalLine,
      column: m.originalColumn
    })

    if (origPosInOldMap.source == null) {
      return
    }

    mergedMapGenerator.addMapping({
      generated: {
        line: m.generatedLine,
        column: m.generatedColumn
      },
      original: {
        line: origPosInOldMap.line, // map line
        // use current column, since the oldMap produced by @vue/compiler-sfc
        // does not
        column: m.originalColumn
      },
      source: origPosInOldMap.source,
      name: origPosInOldMap.name
    })
  })

  // source-map's type definition is incomplete
  const generator = mergedMapGenerator as any
  ;(oldMapConsumer as any).sources.forEach((sourceFile: string) => {
    generator._sources.add(sourceFile)
    const sourceContent = oldMapConsumer.sourceContentFor(sourceFile)
    if (sourceContent != null) {
      mergedMapGenerator.setSourceContent(sourceFile, sourceContent)
    }
  })

  generator._sourceRoot = oldMap.sourceRoot
  generator._file = oldMap.file
  return generator.toJSON()
}

function patchErrors(
  errors: CompilerError[],
  source: string,
  inMap: RawSourceMap
) {
  const originalSource = inMap.sourcesContent![0]
  const offset = originalSource.indexOf(source)
  const lineOffset = originalSource.slice(0, offset).split(/\r?\n/).length - 1
  errors.forEach(err => {
    if (err.loc) {
      err.loc.start.line += lineOffset
      err.loc.start.offset += offset
      if (err.loc.end !== err.loc.start) {
        err.loc.end.line += lineOffset
        err.loc.end.offset += offset
      }
    }
  })
}
