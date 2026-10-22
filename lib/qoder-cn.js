/**
 * Qoder CN 原生接入层：认证、设置委派、单任务会话执行。
 *
 * 这一层只做三件事：
 * 1. 找出本机 Qoder CN 的原生登录状态（App 版 + CLI 版），并选一个 SDK 能用的认证方式；
 * 2. 把 Qoder CN 自己的 settings.json（MCP 服务器等）按需委派给子会话；
 * 3. 用官方 @qodercn-ai/qodercn-agent-sdk 跑一个一次性任务，把结果收敛成 DSH 的
 *    `{ output, stopReason, diagnostic }` 形状。
 *
 * 认证原则：优先官方只读复用（`type: 'qodercli'`），任何情况下都不改写 Qoder CN 自己的
 * 登录文件。App 版登录态只用于展示与诊断，不能在缺少 CLI 登录时被伪造出来——device token
 * 不能冒充 personal access token，这条边界由 Qoder 服务端决定，不由本插件决定。
 *
 * @module dsh-qoder-cn-subagent/qoder-cn
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Qoder CN 的配置根目录名。 */
export const QODER_CN_HOME_NAME = '.qoder-cn'

/** Qoder CN App 写入的登录快照（明文 JSON，仅含账号信息，不含令牌）。 */
const APP_STATUS_FILE = '.qoder-app-status.json'

/** Qoder CN 用户级设置（MCP 服务器、插件开关）。 */
const SETTINGS_FILE = 'settings.json'

/** CLI 凭据库：存在即表示 CLI 侧有登录态。 */
const CLI_CREDENTIAL_FILE = '.auth/user'

/** CLI 机器标识：CLI 凭据解密需要它；缺失时说明本机从未登录过 CLI。 */
const CLI_MACHINE_ID_FILE = '.auth/machine_id'

/** Qoder CN 的默认模型 ID；留空交给上游默认。 */
export const DEFAULT_MODEL = undefined

/** SDK 的 result.subtype → DSH 的 stopReason。 */
const STOP_REASON_BY_SUBTYPE = {
  success: 'completed',
  error_max_turns: 'error',
  error_max_budget_usd: 'error',
  error_during_execution: 'error',
}

/**
 * 解析 Qoder CN 的配置根目录。
 *
 * 显式配置优先，其次 `QODERCN_CONFIG_DIR`，最后是 `~/.qoder-cn`。用 Qoder 自己的
 * 环境变量而不是自造的变量，是为了让插件和 App/CLI 落在同一个目录上。
 *
 * @param explicit - 插件配置里写死的目录。
 * @param env - 进程环境。
 * @returns 绝对路径形式的配置根目录。
 */
export function resolveQoderHome(explicit, env = process.env) {
  if (typeof explicit === 'string' && explicit.length > 0) return explicit
  const fromEnv = env.QODERCN_CONFIG_DIR
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv
  return join(homedir(), QODER_CN_HOME_NAME)
}

/**
 * 读取 Qoder CN App 的登录快照。
 *
 * 这是 App 主动写出的状态文件，不含任何令牌，因此可以安全地用于诊断展示。
 *
 * @param qoderHome - Qoder CN 配置根目录。
 * @returns 账号快照，文件缺失或损坏时为 undefined。
 */
export function readAppStatus(qoderHome) {
  const path = join(qoderHome, APP_STATUS_FILE)
  if (!existsSync(path)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : undefined
  }
  catch {
    return undefined
  }
}

/**
 * 读取 Qoder CN 用户级设置。
 * @param qoderHome - Qoder CN 配置根目录。
 * @returns 设置对象；文件缺失或损坏时为 undefined。
 */
export function readQoderSettings(qoderHome) {
  const path = join(qoderHome, SETTINGS_FILE)
  if (!existsSync(path)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : undefined
  }
  catch {
    return undefined
  }
}

/**
 * 判断 CLI 侧是否有可复用的登录态。
 *
 * 只看文件是否存在：真正的可用性由 SDK 在首次请求时判定，插件不替它猜。凭据文件是加密的，
 * 而且解密需要 Qoder 自己的 wasm 模块；在这里解密既无必要，也会让插件依赖上游的内部格式。
 *
 * @param qoderHome - Qoder CN 配置根目录。
 * @returns CLI 登录态的文件级摘要。
 */
export function inspectCliLogin(qoderHome) {
  const credential = join(qoderHome, CLI_CREDENTIAL_FILE)
  const machineId = join(qoderHome, CLI_MACHINE_ID_FILE)
  return {
    credentialFile: credential,
    hasCredential: existsSync(credential),
    hasMachineId: existsSync(machineId),
  }
}

/**
 * 选出本次委派使用的认证方式。
 *
 * `native` 显式要求复用 CLI 登录；`auto` 在 CLI 已登录时复用，否则仍交给 SDK 的
 * `qodercli` 认证（让它给出准确的上游错误，而不是让插件编一个错误）；`token` 直接用
 * 调用方给的 personal access token（或它的环境变量引用）。
 *
 * @param options - 配置解析结果。
 * @param cliLogin - CLI 登录态文件摘要。
 * @param tokenFactory - SDK 的 `accessToken` 辅助函数。
 * @param nativeFactory - SDK 的 `qodercliAuth` 辅助函数。
 * @returns 可直接放进 `query({ options: { auth } })` 的认证对象与来源标记。
 */
export function resolveAuth(options, cliLogin, tokenFactory, nativeFactory) {
  if (options.authMode === 'token') {
    const token = options.accessToken
    if (typeof token !== 'string' || token.length === 0) {
      throw new Error(
        'dsh-qoder-cn-subagent: authMode "token" requires accessToken (a Qoder CN personal access token) or accessTokenEnv pointing at one',
      )
    }
    return { auth: tokenFactory(token), source: 'token' }
  }
  return {
    auth: nativeFactory(),
    source: cliLogin.hasCredential ? 'qodercli' : 'qodercli-unverified',
  }
}

/**
 * 把 Qoder CN 的设置收敛成 SDK 能接受的形态。
 *
 * Qoder 的 `mcpServers` 与 SDK 同构，可以直接透传；`enabledPlugins` 属于 IDE 的插件
 * 体系，SDK 侧没有对应概念，因此显式丢弃而不是假装支持。
 *
 * @param settings - Qoder CN 设置对象。
 * @returns SDK 会话选项片段。
 */
export function delegationOptions(settings) {
  if (settings === undefined) return {}
  const servers = settings.mcpServers
  if (servers === null || typeof servers !== 'object' || Array.isArray(servers)) return {}
  const enabled = Object.entries(servers)
    .filter(([, entry]) => entry !== null && typeof entry === 'object' && entry.disabled !== true)
  if (enabled.length === 0) return {}
  return { mcpServers: Object.fromEntries(enabled) }
}

/**
 * 把 DSH 的提示块折成一段文本。
 *
 * Qoder 的 SDK 既接受纯文本 prompt，也接受结构化流；一次性委派用纯文本最简单也最稳。
 * 非文本块不丢弃，而是折成带标记的说明，避免模型对输入残缺毫无察觉。
 *
 * @param blocks - DSH 请求里的提示块数组。
 * @returns 提示文本。
 */
export function foldPrompt(blocks) {
  const parts = []
  for (const block of blocks ?? []) {
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    else if (block?.type === 'image') parts.push('[image attachment omitted: this backend forwards text only]')
    else if (typeof block?.type === 'string') parts.push(`[${block.type} attachment omitted: this backend forwards text only]`)
  }
  return parts.join('\n\n').trim()
}

/**
 * 从一条 assistant 消息里取出文本块。
 * @param message - SDK 的 assistant 消息。
 * @returns 文本块数组，形状与 DSH 的输出块一致。
 */
function assistantTextBlocks(message) {
  const content = message?.message?.content
  if (!Array.isArray(content)) return []
  const blocks = []
  for (const item of content) {
    if (item?.type === 'text' && typeof item.text === 'string' && item.text.length > 0) {
      blocks.push({ type: 'text', text: item.text })
    }
  }
  return blocks
}

/**
 * 跑一个一次性 Qoder CN 任务。
 *
 * 收尾文案优先用结果消息自带的 `result` 字段：那是 Qoder 自己认定的最终答复。只有在
 * 没有该字段时才回退到最后一条 assistant 文本，因为中间的 assistant 消息通常是工具调用
 * 前的说明，把它们全拼起来会让父 agent 收到重复内容。
 *
 * @param params - SDK 模块、认证对象、提示、会话选项与取消信号。
 * @returns 收敛后的激活结果与诊断文本。
 */
export async function runQoderTask(params) {
  const { sdk, auth, prompt, signal, sessionOptions } = params
  const abortController = new AbortController()
  const forwardAbort = () => abortController.abort(signal.reason)
  signal.addEventListener('abort', forwardAbort, { once: true })

  let lastText = []
  let finalText
  let errorText
  let interrupted = false
  let resultSubtype
  let usage

  try {
    const iterator = sdk.query({
      prompt,
      options: {
        auth,
        abortController,
        ...sessionOptions,
      },
    })
    for await (const message of iterator) {
      if (message?.type === 'assistant') {
        const blocks = assistantTextBlocks(message)
        if (blocks.length > 0) lastText = blocks
      }
      else if (message?.type === 'result') {
        resultSubtype = message.subtype
        usage = message.usage
        if (typeof message.result === 'string' && message.result.trim().length > 0) {
          finalText = message.result.trim()
        }
        if (message.is_error === true) {
          const errors = Array.isArray(message.errors) ? message.errors : []
          errorText = errors.filter(item => typeof item === 'string' && item.length > 0).join('; ')
            || `Qoder CN reported ${String(message.subtype ?? 'an error')}`
        }
      }
    }
  }
  catch (error) {
    if (signal.aborted) interrupted = true
    else errorText = error instanceof Error ? error.message : String(error)
  }
  finally {
    signal.removeEventListener('abort', forwardAbort)
  }

  const output = finalText !== undefined ? [{ type: 'text', text: finalText }] : lastText

  if (interrupted || signal.aborted) {
    return { output, stopReason: 'aborted', diagnostic: undefined }
  }
  if (errorText !== undefined) {
    return {
      output,
      stopReason: 'error',
      diagnostic: enrichDiagnostic(errorText, resultSubtype, usage),
    }
  }
  return {
    output,
    stopReason: STOP_REASON_BY_SUBTYPE[resultSubtype] ?? 'completed',
  }
}

/**
 * 给上游错误补上可操作的上下文。
 *
 * Qoder 在未登录、令牌被拒、配额耗尽时有各自的错误文案，但它们不告诉用户该做什么。
 * 这里只补一句动作，不掩盖原始原因。
 *
 * @param message - 上游错误文本。
 * @param subtype - 结果消息的 subtype。
 * @param usage - 结果消息的用量。
 * @returns 带动作建议的诊断文本。
 */
function enrichDiagnostic(message, subtype, usage) {
  const lines = [message]
  if (/login/i.test(message) && /(no |not |damaged|expired)/i.test(message)) {
    lines.push('Run `qoderclicn login` once in a terminal, then retry the delegation. Qoder CN App sign-in alone is not read by the CLI credential store.')
  }
  if (/token was rejected|access_token_invalid/i.test(message)) {
    lines.push('The credential in use was rejected upstream. Re-run `qoderclicn login`, or set a fresh personal access token via accessToken/accessTokenEnv.')
  }
  if (/QUOTA/i.test(message)) {
    lines.push('The Qoder CN account is out of quota for this model.')
  }
  if (subtype !== undefined) lines.push(`result subtype: ${String(subtype)}`)
  if (usage !== undefined && subtype !== 'success') {
    const total = typeof usage.output_tokens === 'number' ? usage.output_tokens : undefined
    if (total !== undefined) lines.push(`output tokens: ${total}`)
  }
  return lines.join('\n')
}

/**
 * 探测本机 Qoder CN 的接入状态，用于诊断命令与启动日志。
 *
 * @param params - 配置解析结果与 CLI 登录态摘要。
 * @returns 供人阅读的状态摘要。
 */
export function describeStatus(params) {
  const { options, cliLogin, appStatus } = params
  const appLoggedIn = appStatus?.logged_in === true
  const summary = []
  summary.push(`qoder home: ${options.qoderHome}`)
  summary.push(`app sign-in: ${appLoggedIn ? `yes (${String(appStatus?.name ?? 'unknown')})` : 'no'}`)
  summary.push(`cli sign-in: ${cliLogin.hasCredential ? 'yes' : 'no'}`)
  summary.push(`auth mode: ${options.authMode}`)
  summary.push(`settings delegation: ${options.delegateSettings ? 'on' : 'off'}`)
  if (!cliLogin.hasCredential) {
    summary.push('')
    summary.push('The subagent runs through the Qoder CN CLI credential store, which is separate from the App sign-in.')
    summary.push('Run `qoderclicn login` once (or set accessToken / accessTokenEnv) before delegating.')
  }
  return summary.join('\n')
}
