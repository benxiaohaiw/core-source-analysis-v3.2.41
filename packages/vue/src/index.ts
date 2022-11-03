// This entry is the "full-build" that includes both the runtime
// and the compiler, and supports on-the-fly compilation of the template option.
import { initDev } from './dev'
import { compile, CompilerOptions, CompilerError } from '@vue/compiler-dom'
import { registerRuntimeCompiler, RenderFunction, warn } from '@vue/runtime-dom'
import * as runtimeDom from '@vue/runtime-dom'
import { isString, NOOP, generateCodeFrame, extend } from '@vue/shared'
import { InternalRenderFunction } from 'packages/runtime-core/src/component'

if (__DEV__) {
  initDev()
}

const compileCache: Record<string, RenderFunction> = Object.create(null)

// compileToFunction函数主要分为三个阶段
// 1.parse（template string转为ast语法树）
// 2.transform（迭代ast语法树对每个节点进行转换，转换后的信息称为codegenNode，使其挂载到节点的codegenNode属性上）
// 3.generate（迭代ast语法树上每个节点的codegenNode，根据它生成对应的字符串）
function compileToFunction(
  template: string | HTMLElement,
  options?: CompilerOptions
): RenderFunction {
  if (!isString(template)) {
    // 说明传入的参数template是一个真实dom节点元素
    if (template.nodeType) {
      template = template.innerHTML // 这里直接取出这个真实节点元素的innerHTML属性值作为template字符串
    } else {
      __DEV__ && warn(`invalid template option: `, template)
      return NOOP
    }
  }

  // 这里先看下缓存中有没有对应的以template作为key的键值对
  // 有的话就直接从缓存中取编译后的结果就可以啦
  const key = template
  const cached = compileCache[key]
  if (cached) {
    return cached
  }

  // 同时template参数是支持id选择器的
  if (template[0] === '#') {
    const el = document.querySelector(template) // 使用api直接找出id对应的dom节点
    if (__DEV__ && !el) {
      warn(`Template element not found or is empty: ${template}`)
    }
    // __UNSAFE__
    // Reason: potential execution of JS expressions in in-DOM template.
    // The user must make sure the in-DOM template is trusted. If it's rendered
    // by the server, the template should not contain any user data.
    template = el ? el.innerHTML : `` // 有的话也是直接取出它的innerHTML属性就可以啦 ~
  }

  // 对参数做一个整合
  const opts = extend(
    {
      hoistStatic: true, // 开启静态提升
      // 错误和警告函数
      onError: __DEV__ ? onError : undefined,
      onWarn: __DEV__ ? e => onError(e, true) : NOOP
    } as CompilerOptions,
    options
  )

  // 选项中没有自定义元素且customElements不是undefined
  // 那么就给选项中添加isCustomElement函数
  if (!opts.isCustomElement && typeof customElements !== 'undefined') {
    opts.isCustomElement = tag => !!customElements.get(tag)
  }

  // 使用@vue/compiler-dom下的compile方法直接对模板字符串做编译
  const { code } = compile(template, opts)

  function onError(err: CompilerError, asWarning = false) {
    const message = asWarning
      ? err.message
      : `Template compilation error: ${err.message}`
    const codeFrame =
      err.loc &&
      generateCodeFrame(
        template as string,
        err.loc.start.offset,
        err.loc.end.offset
      )
    warn(codeFrame ? `${message}\n${codeFrame}` : message)
  }

  // The wildcard import results in a huge object with every export
  // with keys that cannot be mangled, and can be quite heavy size-wise.
  // In the global build we know `Vue` is available globally so we can avoid
  // the wildcard object.
  const render = (
    __GLOBAL__ ? new Function(code)() : new Function('Vue', code)(runtimeDom)
  ) as RenderFunction
  // 把编译的后的字符串直接作为Function实例对象的body，生成一个Function类实例对象
  // 同时把该函数命名为render函数

  /// 作为运行时函数标记这个函数
  // mark the function as runtime compiled
  ;(render as InternalRenderFunction)._rc = true

  // 存入缓存中然后返回此render函数
  return (compileCache[key] = render)
}

registerRuntimeCompiler(compileToFunction)

// https://unpkg.com/vue@3.2.41/dist/vue.global.js
// 它中导出的compile函数就是这个compileToFunction函数
export { compileToFunction as compile }
export * from '@vue/runtime-dom'
