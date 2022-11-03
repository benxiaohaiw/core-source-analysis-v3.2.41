// API
export { parse } from './parse' // sfc的解析函数
// 整体步骤
// 1.parse（生成对应的ast语法树 -> 根据ast语法树创建对应的块信息对象）
// 2.compile（根据每个块信息对象进行编译 -> 产生相应的code字符串）
export { compileTemplate } from './compileTemplate' // sfc中对于template的编译 api
export { compileStyle, compileStyleAsync } from './compileStyle'
export { compileScript } from './compileScript'
export { rewriteDefault } from './rewriteDefault'
export {
  shouldTransform as shouldTransformRef,
  transform as transformRef,
  transformAST as transformRefAST
} from '@vue/reactivity-transform'

// Utilities
export { parse as babelParse } from '@babel/parser'
import MagicString from 'magic-string'
export { MagicString }
// technically internal but we want it in @vue/repl, cast it as any to avoid
// relying on estree types
import { walk as _walk } from 'estree-walker'
export const walk = _walk as any
export {
  generateCodeFrame,
  walkIdentifiers,
  extractIdentifiers,
  isInDestructureAssignment,
  isStaticProperty
} from '@vue/compiler-core'

// Types
export {
  SFCParseOptions,
  SFCParseResult,
  SFCDescriptor,
  SFCBlock,
  SFCTemplateBlock,
  SFCScriptBlock,
  SFCStyleBlock
} from './parse'
export {
  TemplateCompiler,
  SFCTemplateCompileOptions,
  SFCTemplateCompileResults
} from './compileTemplate'
export {
  SFCStyleCompileOptions,
  SFCAsyncStyleCompileOptions,
  SFCStyleCompileResults
} from './compileStyle'
export { SFCScriptCompileOptions } from './compileScript'
export { AssetURLOptions, AssetURLTagConfig } from './templateTransformAssetUrl'
export {
  CompilerOptions,
  CompilerError,
  BindingMetadata
} from '@vue/compiler-core'
