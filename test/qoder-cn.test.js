/**
 * 后端契约测试：验证外部提供方的 run 句柄形状、结果收敛与取消语义。
 *
 * 这些测试不触网：SDK 用一个可控的假实现替换，因此能断言「Qoder 返回什么」到
 * 「DSH 收到什么」之间的映射，而不依赖账号、配额或网络。
 *
 * 运行：node --test test/
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  delegationOptions,
  describeStatus,
  foldPrompt,
  inspectCliLogin,
  resolveAuth,
  resolveQoderHome,
  runQoderTask,
} from '../lib/qoder-cn.js'

/**
 * 造一个只回放固定消息序列的假 SDK。
 * @param messages - 依次产出的消息。
 * @param onQuery - 收到 query 调用时的回调，便于断言选项。
 * @returns 假 SDK 命名空间。
 */
function fakeSdk(messages, onQuery) {
  return {
    accessToken: token => ({ type: 'accessToken', accessToken: token }),
    qodercliAuth: () => ({ type: 'qodercli' }),
    query(params) {
      onQuery?.(params)
      return (async function* replay() {
        for (const message of messages) yield message
      })()
    },
  }
}

/** 一条成功的结果消息。 */
const successResult = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'the answer',
  usage: { output_tokens: 12 },
}

test('runQoderTask 把结果消息的 result 作为最终答复', async () => {
  const sdk = fakeSdk([
    { type: 'assistant', message: { content: [{ type: 'text', text: 'working on it' }] } },
    successResult,
  ])
  const result = await runQoderTask({
    sdk,
    auth: sdk.qodercliAuth(),
    prompt: 'do the thing',
    signal: new AbortController().signal,
    sessionOptions: {},
  })
  assert.deepEqual(result.output, [{ type: 'text', text: 'the answer' }])
  assert.equal(result.stopReason, 'completed')
  assert.equal(result.diagnostic, undefined)
})

test('runQoderTask 在缺少 result 字段时回退到最后一条 assistant 文本', async () => {
  const sdk = fakeSdk([
    { type: 'assistant', message: { content: [{ type: 'text', text: 'first' }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'second' }] } },
    { type: 'result', subtype: 'success', is_error: false, usage: {} },
  ])
  const result = await runQoderTask({
    sdk,
    auth: sdk.qodercliAuth(),
    prompt: 'x',
    signal: new AbortController().signal,
    sessionOptions: {},
  })
  assert.deepEqual(result.output, [{ type: 'text', text: 'second' }])
  assert.equal(result.stopReason, 'completed')
})

test('runQoderTask 把上游错误收敛成 error 并保留原因', async () => {
  const sdk = fakeSdk([
    {
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      errors: ['No qodercli login found. Run "qodercli login" first.'],
      usage: {},
    },
  ])
  const result = await runQoderTask({
    sdk,
    auth: sdk.qodercliAuth(),
    prompt: 'x',
    signal: new AbortController().signal,
    sessionOptions: {},
  })
  assert.equal(result.stopReason, 'error')
  assert.match(result.diagnostic, /No qodercli login found/)
  assert.match(result.diagnostic, /qoderclicn login/)
})

test('runQoderTask 在 maxTurns 用尽时报告 error 而不是成功', async () => {
  const sdk = fakeSdk([
    { type: 'result', subtype: 'error_max_turns', is_error: true, errors: [], usage: {} },
  ])
  const result = await runQoderTask({
    sdk,
    auth: sdk.qodercliAuth(),
    prompt: 'x',
    signal: new AbortController().signal,
    sessionOptions: {},
  })
  assert.equal(result.stopReason, 'error')
})

test('runQoderTask 在取消后报告 aborted 且不再抛错', async () => {
  const controller = new AbortController()
  const sdk = {
    accessToken: token => ({ type: 'accessToken', accessToken: token }),
    qodercliAuth: () => ({ type: 'qodercli' }),
    query() {
      return (async function* hang() {
        yield { type: 'assistant', message: { content: [{ type: 'text', text: 'partial' }] } }
        controller.abort({ kind: 'disposed' })
        await new Promise(resolve => setTimeout(resolve, 0))
        throw new Error('aborted by caller')
      })()
    },
  }
  const result = await runQoderTask({
    sdk,
    auth: sdk.qodercliAuth(),
    prompt: 'x',
    signal: controller.signal,
    sessionOptions: {},
  })
  assert.equal(result.stopReason, 'aborted')
  assert.deepEqual(result.output, [{ type: 'text', text: 'partial' }])
})

test('resolveAuth 在 native 模式复用 CLI 登录', () => {
  const { auth, source } = resolveAuth(
    { authMode: 'native' },
    { hasCredential: true },
    token => ({ type: 'accessToken', accessToken: token }),
    () => ({ type: 'qodercli' }),
  )
  assert.deepEqual(auth, { type: 'qodercli' })
  assert.equal(source, 'qodercli')
})

test('resolveAuth 在 token 模式缺少令牌时立刻报错', () => {
  assert.throws(
    () => resolveAuth(
      { authMode: 'token', accessToken: '' },
      { hasCredential: false },
      token => ({ type: 'accessToken', accessToken: token }),
      () => ({ type: 'qodercli' }),
    ),
    /requires accessToken/,
  )
})

test('delegationOptions 只转发启用的 MCP 服务器', () => {
  assert.deepEqual(delegationOptions(undefined), {})
  assert.deepEqual(
    delegationOptions({ mcpServers: { on: { url: 'u' }, off: { url: 'v', disabled: true } } }),
    { mcpServers: { on: { url: 'u' } } },
  )
  assert.deepEqual(delegationOptions({ mcpServers: {} }), {})
  assert.deepEqual(delegationOptions({ enabledPlugins: { p: true } }), {})
})

test('foldPrompt 保留文本并显式标注被丢弃的非文本块', () => {
  assert.equal(foldPrompt([{ type: 'text', text: 'a' }]), 'a')
  assert.match(foldPrompt([{ type: 'text', text: 'a' }, { type: 'image' }]), /image attachment omitted/)
  assert.equal(foldPrompt([]), '')
})

test('resolveQoderHome 尊重显式配置与官方环境变量', () => {
  assert.equal(resolveQoderHome('/explicit', { QODERCN_CONFIG_DIR: '/env' }), '/explicit')
  assert.equal(resolveQoderHome('', { QODERCN_CONFIG_DIR: '/env' }), '/env')
  assert.match(resolveQoderHome('', {}), /\.qoder-cn$/)
})

test('inspectCliLogin 在缺失目录上报告未登录而不是抛错', () => {
  const status = inspectCliLogin('/nonexistent-qoder-home-for-test')
  assert.equal(status.hasCredential, false)
  assert.equal(status.hasMachineId, false)
})

test('describeStatus 在未登录时给出可执行的下一步', () => {
  const text = describeStatus({
    options: { authMode: 'native', delegateSettings: true, qoderHome: '/home/.qoder-cn' },
    cliLogin: { hasCredential: false, hasMachineId: false },
    appStatus: { logged_in: true, name: 'someone' },
  })
  assert.match(text, /cli sign-in: no/)
  assert.match(text, /app sign-in: yes \(someone\)/)
  assert.match(text, /qoderclicn login/)
})
