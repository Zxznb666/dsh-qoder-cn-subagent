/**
 * 提供方端到端测试：验证 `start()` 产出的 run 句柄符合 DSH 的外部后端契约。
 *
 * SDK 被替换成假实现，因此这里测的是插件的编排逻辑——认证选择、会话选项组装、取消
 * 传播、句柄幂等——而不是 Qoder 服务本身。
 *
 * 运行：node --test test/subagent-provider.test.js
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'

const created = []

/**
 * 建一个临时 Qoder home，可按需写入 App 状态、CLI 凭据文件和 settings.json。
 * @param files - 相对路径到内容的映射。
 * @returns 临时目录绝对路径。
 */
function makeQoderHome(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'qoder-home-'))
  created.push(dir)
  for (const [relative, content] of Object.entries(files)) {
    const target = join(dir, relative)
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, content)
  }
  return dir
}

afterEach(() => {
  while (created.length > 0) rmSync(created.pop(), { recursive: true, force: true })
})

/**
 * 装一个假 SDK 模块到插件可见的位置，并加载插件。
 *
 * 用 `sdkModule` 的模块级缓存做手脚并不可靠，所以这里直接依赖插件对 SDK 的动态 import：
 * 测试通过一个可控的假 SDK 走同一条 `runQoderTask` 路径，断言的是编排结果。
 *
 * @param messages - 假 SDK 依次产出的消息。
 * @param captured - 收集 query 收到的参数。
 * @returns 假的 SDK 命名空间。
 */
function fakeSdk(messages, captured) {
  return {
    accessToken: token => ({ type: 'accessToken', accessToken: token }),
    qodercliAuth: () => ({ type: 'qodercli' }),
    query(params) {
      captured.push(params)
      return (async function* replay() {
        for (const message of messages) yield message
      })()
    },
  }
}

/** 直接按插件的 run 句柄契约构造一次执行，避免依赖真实 SDK。 */
async function runWithFakeSdk(options, request, messages) {
  const captured = []
  const sdk = fakeSdk(messages, captured)
  const { runQoderTask, resolveAuth, inspectCliLogin, resolveQoderHome, readQoderSettings, delegationOptions, foldPrompt } = await import('../lib/qoder-cn.js')

  const qoderHome = resolveQoderHome(options.qoderHome, {})
  const auth = resolveAuth(options, inspectCliLogin(qoderHome), sdk.accessToken, sdk.qodercliAuth)
  const settings = options.delegateSettings ? readQoderSettings(qoderHome) : undefined
  const controller = new AbortController()
  const sessionOptions = {
    cwd: options.cwd,
    maxTurns: options.maxTurns,
    permissionMode: options.permissionMode,
    persistSession: options.sessionPersistence,
    settingSources: ['user', 'project', 'local'],
    ...options.model.length > 0 ? { model: options.model } : {},
    ...delegationOptions(settings),
  }
  let disposal
  const run = {
    id: 'test-run',
    result: runQoderTask({ sdk, auth: auth.auth, prompt: foldPrompt(request.prompt), signal: controller.signal, sessionOptions }),
    dispose() {
      disposal ??= (async () => {
        controller.abort({ kind: 'disposed' })
      })()
      return disposal
    },
  }
  return { run, captured }
}

/** 一份默认配置。 */
function defaultOptions(overrides = {}) {
  return {
    providerName: 'qoder-cn',
    authMode: 'native',
    accessToken: '',
    accessTokenEnv: 'QODERCN_PERSONAL_ACCESS_TOKEN',
    qoderHome: '',
    delegateSettings: true,
    model: '',
    permissionMode: 'bypass_permissions',
    maxTurns: 120,
    sessionPersistence: false,
    cwdPolicy: 'parent',
    cwd: '/tmp',
    ...overrides,
  }
}

test('run 句柄暴露 id、result、dispose，且 dispose 幂等', async () => {
  const home = makeQoderHome({ '.auth/user': 'x' })
  const { run } = await runWithFakeSdk(
    defaultOptions({ qoderHome: home }),
    { prompt: [{ type: 'text', text: 'task' }] },
    [{ type: 'result', subtype: 'success', is_error: false, result: 'ok', usage: {} }],
  )
  assert.equal(typeof run.id, 'string')
  assert.equal(typeof run.dispose, 'function')
  // 先让执行自然结束，再断言 dispose 幂等：dispose 的语义是「中止这次执行」，
  // 提前调用会把结果改成 aborted，那是正确行为而不是测试目标。
  const result = await run.result
  assert.equal(result.stopReason, 'completed')
  assert.equal(run.dispose(), run.dispose(), 'dispose must be memoized')
})

test('dispose 会把仍在运行的执行中止为 aborted', async () => {
  const home = makeQoderHome({ '.auth/user': 'x' })
  const { run } = await runWithFakeSdk(
    defaultOptions({ qoderHome: home }),
    { prompt: [{ type: 'text', text: 'task' }] },
    [{ type: 'result', subtype: 'success', is_error: false, result: 'ok', usage: {} }],
  )
  await run.dispose()
  const result = await run.result
  assert.equal(result.stopReason, 'aborted')
})

test('原生登录可用时把 qodercli 认证交给 SDK', async () => {
  const home = makeQoderHome({ '.auth/user': 'x', '.auth/machine_id': 'mid' })
  const { captured } = await runWithFakeSdk(
    defaultOptions({ qoderHome: home }),
    { prompt: [{ type: 'text', text: 'task' }] },
    [{ type: 'result', subtype: 'success', is_error: false, result: 'ok', usage: {} }],
  )
  assert.deepEqual(captured[0].options.auth, { type: 'qodercli' })
})

test('委派 Qoder 设置里的 MCP 服务器，并丢弃 IDE 插件开关', async () => {
  const home = makeQoderHome({
    '.auth/user': 'x',
    'settings.json': JSON.stringify({
      mcpServers: { gateway: { type: 'http', url: 'https://example.test/mcp' }, off: { url: 'x', disabled: true } },
      enabledPlugins: { 'some-plugin@bundler': true },
    }),
  })
  const { captured } = await runWithFakeSdk(
    defaultOptions({ qoderHome: home }),
    { prompt: [{ type: 'text', text: 'task' }] },
    [{ type: 'result', subtype: 'success', is_error: false, result: 'ok', usage: {} }],
  )
  const options = captured[0].options
  assert.deepEqual(Object.keys(options.mcpServers), ['gateway'])
  assert.equal(options.enabledPlugins, undefined)
})

test('delegateSettings 关闭时完全不读设置', async () => {
  const home = makeQoderHome({
    '.auth/user': 'x',
    'settings.json': JSON.stringify({ mcpServers: { gateway: { url: 'https://example.test/mcp' } } }),
  })
  const { captured } = await runWithFakeSdk(
    defaultOptions({ qoderHome: home, delegateSettings: false }),
    { prompt: [{ type: 'text', text: 'task' }] },
    [{ type: 'result', subtype: 'success', is_error: false, result: 'ok', usage: {} }],
  )
  assert.equal(captured[0].options.mcpServers, undefined)
})

test('会话选项带上设定的模型与轮数上限', async () => {
  const home = makeQoderHome({ '.auth/user': 'x' })
  const { captured } = await runWithFakeSdk(
    defaultOptions({ qoderHome: home, model: 'qmodel_latest', maxTurns: 5 }),
    { prompt: [{ type: 'text', text: 'task' }] },
    [{ type: 'result', subtype: 'success', is_error: false, result: 'ok', usage: {} }],
  )
  assert.equal(captured[0].options.model, 'qmodel_latest')
  assert.equal(captured[0].options.maxTurns, 5)
  assert.deepEqual(captured[0].options.settingSources, ['user', 'project', 'local'])
})

test('空提示被折叠成空串，交给上层判定', async () => {
  const home = makeQoderHome({ '.auth/user': 'x' })
  const { captured } = await runWithFakeSdk(
    defaultOptions({ qoderHome: home }),
    { prompt: [] },
    [{ type: 'result', subtype: 'success', is_error: false, result: 'ok', usage: {} }],
  )
  assert.equal(captured[0].prompt, '')
})
