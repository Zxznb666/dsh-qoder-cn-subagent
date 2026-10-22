/**
 * Qoder CN 子智能体后端：把 Qoder CN 注册为 DSH `subagents` 的一个提供方。
 *
 * DSH 的 subagent seam 有两类后端：本地（`prepareContinuable`，子级是同一个 cordis
 * 上下文里的 Agent）和外部（`start`，子级在别的进程里跑一次）。Qoder CN 属于后者：
 * 它有自己的会话、工具循环和账号，DSH 只负责把任务交出去、把结果收回来。
 *
 * 因此这个提供方：
 * - 不声明 `agentOptions` / `agentPreset` / `outputSchema` / `depthLimit`：这些是父级
 *   强制的启动能力，外部后端兑现不了，声明支持再静默忽略比直接拒绝更糟；
 * - 每次 `start()` 只跑一个任务，不提供后续输入（没有 `prepareContinuable` 即叶节点）；
 * - `result` 一旦发布就不再 reject，符合 seam 的结算契约。
 *
 * @module dsh-qoder-cn-subagent
 */
import { randomUUID } from 'node:crypto'
import { Schema } from './host-modules.js'
import {
  describeStatus,
  delegationOptions,
  foldPrompt,
  inspectCliLogin,
  readAppStatus,
  readQoderSettings,
  resolveAuth,
  resolveQoderHome,
  runQoderTask,
} from './qoder-cn.js'

export const name = 'qoder-cn-subagent'

/** 需要 `subagents`；官方 SDK 按需动态导入，缺包时只在委派那一刻失败。 */
export const inject = ['subagents']

/** 外部后端能力：一个都不支持。 */
const EXTERNAL_CAPABILITIES = Object.freeze({
  agentOptions: false,
  agentPreset: false,
  outputSchema: false,
  depthLimit: false,
})

export const Config = Schema?.object({
  providerName: Schema.string().default('qoder-cn')
    .description('Provider name the delegation tool selects.'),
  authMode: Schema.union(['native', 'auto', 'token']).default('native')
    .description('native reuses the Qoder CN CLI sign-in; token uses accessToken/accessTokenEnv.'),
  accessToken: Schema.string().default('')
    .description('Qoder CN personal access token. Prefer accessTokenEnv so no secret enters the config file.'),
  accessTokenEnv: Schema.string().default('QODERCN_PERSONAL_ACCESS_TOKEN')
    .description('Environment variable holding the personal access token when authMode is auto or token.'),
  qoderHome: Schema.string().default('')
    .description('Override the Qoder CN config root. Empty means $QODERCN_CONFIG_DIR or ~/.qoder-cn.'),
  delegateSettings: Schema.boolean().default(true)
    .description('Forward the MCP servers from Qoder CN settings.json into the child session.'),
  model: Schema.string().default('')
    .description('Qoder CN model id for the child session. Empty uses the Qoder CN default.'),
  permissionMode: Schema.union(['default', 'accept_edits', 'bypass_permissions', 'dont_ask', 'auto'])
    .default('bypass_permissions')
    .description('Qoder CN permission mode for the child; bypass_permissions lets it act without prompting.'),
  maxTurns: Schema.natural().default(120)
    .description('Turn cap for one delegated task.'),
  sessionPersistence: Schema.boolean().default(false)
    .description('Keep the Qoder CN session on disk so `qoderclicn --list-sessions` can inspect it.'),
  cwdPolicy: Schema.union(['parent', 'fixed']).default('parent')
    .description('parent runs the child in the delegation cwd; fixed uses cwd.'),
  cwd: Schema.string().default('')
    .description('Fixed working directory used when cwdPolicy is fixed.'),
})

/**
 * 官方 SDK 的懒加载缓存。
 *
 * 延后到委派时才导入：插件在没装 SDK、或 SDK 版本与当前运行时对不上时仍能正常挂载，
 * 失败被限制在一次委派里，而不是拖垮整个 DSH 启动。
 */
let sdkModule

/**
 * 导入 `@qodercn-ai/qodercn-agent-sdk`。
 * @returns SDK 模块命名空间。
 */
async function loadSdk() {
  sdkModule ??= await import('@qodercn-ai/qodercn-agent-sdk')
  return sdkModule
}

/** Qoder CN 外部运行后端。 */
class QoderCnProvider {
  name
  capabilities = EXTERNAL_CAPABILITIES
  /** Qoder CN 从零开始，不继承父级对话。 */
  inheritsParentContext = false

  /**
   * @param providerName - 注册名。
   * @param config - 已校验的插件配置。
   */
  constructor(providerName, config) {
    this.name = providerName
    this.config = config
  }

  /**
   * 启动一次外部执行。
   *
   * @param request - DSH 的委派请求：`prompt` 块、绝对 `cwd`、`parent`、`label`。
   * @returns seam 契约要求的 run 句柄 `{ id, result, dispose }`。
   */
  async start(request) {
    const sdk = await loadSdk()
    const config = this.config
    const qoderHome = resolveQoderHome(config.qoderHome)
    const prompt = foldPrompt(request.prompt)
    if (prompt.length === 0) {
      throw new Error('dsh-qoder-cn-subagent: the delegation carried no text prompt')
    }

    const { auth } = resolveAuth(
      this.#authConfig(config),
      inspectCliLogin(qoderHome),
      sdk.accessToken,
      sdk.qodercliAuth,
    )
    const settings = config.delegateSettings ? readQoderSettings(qoderHome) : undefined
    const sessionOptions = {
      cwd: config.cwdPolicy === 'fixed' && config.cwd.length > 0 ? config.cwd : request.cwd,
      maxTurns: config.maxTurns,
      permissionMode: config.permissionMode,
      persistSession: config.sessionPersistence,
      // user 让 Qoder 自己的 settings.json 生效，project/local 让仓库内约定也生效；
      // 这与在终端里直接跑 qoderclicn 看到的设置来源一致。
      settingSources: ['user', 'project', 'local'],
      ...config.model.length > 0 ? { model: config.model } : {},
      ...delegationOptions(settings),
    }

    const controller = new AbortController()
    let disposal

    return {
      id: `qoder-cn-${randomUUID()}`,
      result: runQoderTask({ sdk, auth, prompt, signal: controller.signal, sessionOptions }),
      dispose() {
        disposal ??= (async () => {
          controller.abort({ kind: 'disposed' })
        })()
        return disposal
      },
    }
  }

  /**
   * 把插件配置折成认证层需要的形状。
   *
   * `auto` 在拿到 token 时走 token，否则复用 CLI 登录；`native` 忽略 token，强制只读
   * 复用 CLI，方便排查「到底是哪份登录在起作用」。
   *
   * @param config - 插件配置。
   * @returns `resolveAuth` 读得懂的认证意图。
   */
  #authConfig(config) {
    if (config.authMode === 'native') return { authMode: 'native' }
    const token = config.accessToken.length > 0
      ? config.accessToken
      : process.env[config.accessTokenEnv]
    if (config.authMode === 'auto') {
      return token !== undefined && token.length > 0
        ? { authMode: 'token', accessToken: token }
        : { authMode: 'native' }
    }
    return { authMode: 'token', accessToken: token }
  }
}

/**
 * 挂载插件：注册提供方，并把本机接入状态写进日志。
 *
 * @param ctx - cordis 上下文。
 * @param config - 已校验的配置。
 */
export function apply(ctx, config) {
  // registerProvider 内部已经是 effect 作用域，自带 HMR 安全的注销。
  ctx.subagents.registerProvider(new QoderCnProvider(config.providerName, config))

  const qoderHome = resolveQoderHome(config.qoderHome)
  const cliLogin = inspectCliLogin(qoderHome)
  const appStatus = readAppStatus(qoderHome)
  const status = describeStatus({
    options: { authMode: config.authMode, delegateSettings: config.delegateSettings, qoderHome },
    cliLogin,
    appStatus,
  })
  if (cliLogin.hasCredential) {
    ctx.logger.info(`[qoder-cn-subagent] provider "${config.providerName}" ready\n${status}`)
  }
  else {
    ctx.logger.warn(`[qoder-cn-subagent] provider "${config.providerName}" registered without a Qoder CN CLI sign-in\n${status}`)
  }
}
