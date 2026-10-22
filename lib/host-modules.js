/**
 * 宿主架构解析：从 DSH 自己的入口拿 `@deepseek-ai/*` 共享包。
 *
 * profile 里的插件和宿主不在同一个 node_modules 树里：DSH 以「安装级包表」的方式提供
 * `@deepseek-ai/*`（cordis、schemastery 等），插件直接 `import '@deepseek-ai/schemastery'`
 * 在 profile 目录下是解析不到的。正确的做法是从宿主进程入口 `createRequire`，这样拿到
 * 的就是宿主正在用的那一份实例——对 cordis 这类靠实例身份做判定的框架尤其重要，
 * 装两份会出现「服务注册了却取不到」的诡异现象。
 *
 * @module dsh-qoder-cn-subagent/host-modules
 */
import { createRequire } from 'node:module'

/**
 * 找一个能解析宿主包的锚点。
 *
 * `process.argv[1]` 是 DSH 的启动入口，正常情况下能解析到宿主 node_modules；某些嵌入式
 * 启动形态下它指向别处，所以按顺序试几个候选，最后退回当前模块本身。
 *
 * @returns 用于 `createRequire` 的绝对路径。
 */
function anchorPath() {
  const argvEntry = process.argv[1]
  if (typeof argvEntry === 'string' && argvEntry.length > 0) return argvEntry
  return import.meta.url
}

/**
 * 从宿主解析一个包。
 *
 * @param specifier - 包名。
 * @returns 该包的默认导出；解析不到时返回 undefined，而不是抛出。
 */
function resolveFromHost(specifier) {
  for (const anchor of [anchorPath(), import.meta.url]) {
    try {
      const require = createRequire(anchor)
      return require(specifier)
    }
    catch {
      continue
    }
  }
  return undefined
}

/**
 * 取 schemastery 的默认工厂。
 *
 * 两种导出形态都接受：ESM 的 `default`，以及 CJS 命名空间自身带 `object` 的情况。
 *
 * @returns schemastery 工厂，解析不到时为 undefined。
 */
function requireSchemaFactory() {
  const loaded = resolveFromHost('@deepseek-ai/schemastery')
  if (loaded === undefined) return undefined
  const factory = loaded.default ?? loaded.Schema ?? loaded
  return typeof factory?.object === 'function' ? factory : undefined
}

/** 宿主的 schemastery 工厂；缺失时插件仍可加载，只是不声明配置 schema。 */
export const Schema = requireSchemaFactory()
