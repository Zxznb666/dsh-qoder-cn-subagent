# DSH Qoder CN Subagent

把 **Qoder CN** 注册为 DeepSeek Harness 的子智能体后端：复用 Qoder CN 自己的登录与设置，一次委派一个任务。

装好之后，DSH 的模型除了 `subagent`（本地子智能体）之外，还会多一个 `qoder_subagent` 工具。调用它，任务会交给本机 Qoder CN 的 agent 循环去跑——它有自己的会话、自己的工具集、自己的账号计费——跑完只把最终答复交回父会话。

## 它做什么

- **一个后端，一条委派路径**：`qoder-cn` 是 DSH `subagents` 服务上的一个外部提供方。父 agent 用 `qoder_subagent` 把活派出去，拿到的是结果而不是它完整的工具流水。
- **原生登录**：认证走 Qoder CN 官方 SDK 的 `qodercli` 只读复用，插件不复制、不改写、不迁移 Qoder 的登录文件。
- **原生设置**：默认把 `~/.qoder-cn/settings.json` 里的 MCP 服务器转交给子会话，所以你在 Qoder CN 里配好的 MCP 在委派里照样可用。
- **一次一个任务**：外部后端不提供继续输入。子会话跑完即结束，父会话收到的是最终答复。

## 认证边界（重要）

这里有一条由 Qoder 服务端划定的边界，插件无法绕过，所以直接说明：

| 登录来源 | 位置 | 能否驱动子智能体 |
|---|---|---|
| Qoder CN **CLI** 登录 | `~/.qoder-cn/.auth/user` | **能**（官方 SDK 的唯一受支持路径） |
| Qoder CN **IDE/App** 登录 | App 的 `state.vscdb` | **不能** |

IDE 里登录不等于 CLI 里登录。App 保存的是 device token（并且加密存放在 App 自己的库里），而 Qoder CN 的推理接口只接受 CLI 凭据库签发的凭据——拿 App 的 device token 去请求，上游会直接以 `access_token_invalid` 拒绝。这不是插件偷懒，而是上游的账号模型：两者是不同的凭据类型，不是同一把钥匙的不同副本。

所以启用前，在本机执行一次：

```sh
qoderclicn login
```

登录一次之后，子智能体的每次委派都自动沿用这份登录态，账号切换也会自动跟随。

插件启动时会打印状态，未登录时给出明确警告：

```
[qoder-cn-subagent] provider "qoder-cn" registered without a Qoder CN CLI sign-in
qoder home: /Users/you/.qoder-cn
app sign-in: yes (your-name)
cli sign-in: no
auth mode: native
settings delegation: on

The subagent runs through the Qoder CN CLI credential store, which is separate from the App sign-in.
Run `qoderclicn login` once (or set accessToken / accessTokenEnv) before delegating.
```

## 安装

插件本身不发 npm，按本地包安装：

```sh
# 1) 取回源码
git clone https://github.com/Zxznb666/dsh-qoder-cn-subagent.git
cd dsh-qoder-cn-subagent

# 2) 装好官方 SDK（插件已声明依赖，这一步是可选的预装）
npm install

# 3) 装进你要用的 profile（file: 需要绝对路径）
dsh plugin --profile <profile> add "file:$(pwd)"
```

> **Desktop 用户注意**：官方 Electron 版把 `desktop` profile 交给 App 独占管理，独立 CLI 的 `--profile desktop` 会被拒绝，`dsh plugin --profile desktop ...` 同样不可用。想在 Desktop 里用，走 App 的插件入口安装本地包；Web / TUI / headless 用上面的命令即可。

装完后 `--dump-config` 能看到这两行，说明 bundle 层已生效：

```
# == dsh-qoder-cn-subagent
- id: subagent-qoder-cn
  name: dsh-qoder-cn-subagent
- id: tool-subagent-qoder-cn
  name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: qoder-cn
    toolName: qoder_subagent
    maxDepth: provider-managed
```

`maxDepth: provider-managed` 不是可选项。外部后端没有 `depthLimit` 能力，父级无法替它执行递归预算，DSH 会因此在启动时直接拒绝这条配置——如实转交比假装能限制更安全。

### 如果 pnpm 拦下了 SDK 的 postinstall

官方 SDK 的 `postinstall` 负责下载 Qoder worker runtime（约 60 MB）。pnpm 默认会拦下未批准的构建脚本：

```
Error: ERR_PNPM_IGNORED_BUILDS
  × adding a new package
  ╰─▶ Ignored build scripts: @qodercn-ai/qodercn-agent-sdk@1.0.55
```

在 profile 的 `pnpm-workspace.yaml` 里放行，然后补跑一次：

```yaml
allowBuilds:
  '@qodercn-ai/qodercn-agent-sdk': true
```

```sh
cd ~/.dsh/profiles/<profile>
pnpm rebuild @qodercn-ai/qodercn-agent-sdk
```

## 配置

全部字段都有可用默认值，不配也能跑。

| 字段 | 默认 | 说明 |
|---|---|---|
| `providerName` | `qoder-cn` | 提供方注册名，委派工具的 `provider` 指向它 |
| `authMode` | `native` | `native` 只读复用 CLI 登录；`token` 用 `accessToken`/`accessTokenEnv`；`auto` 有令牌走令牌、否则走 CLI |
| `accessToken` | 空 | Qoder CN personal access token。**不要**填 App 的 device token |
| `accessTokenEnv` | `QODERCN_PERSONAL_ACCESS_TOKEN` | 令牌所在环境变量，避免密钥进配置文件 |
| `qoderHome` | 空 | Qoder CN 配置根目录。空表示 `$QODERCN_CONFIG_DIR` 或 `~/.qoder-cn` |
| `delegateSettings` | `true` | 把 `settings.json` 的 MCP 服务器转交给子会话 |
| `model` | 空 | 子会话使用的 Qoder CN 模型 id；空表示上游默认 |
| `permissionMode` | `bypass_permissions` | 子会话的权限模式。子智能体无人值守，需要免提示才能动手 |
| `maxTurns` | `120` | 单次委派的轮数上限 |
| `sessionPersistence` | `false` | 是否把子会话留在磁盘，方便 `qoderclicn --list-sessions` 事后查看 |
| `cwdPolicy` | `parent` | `parent` 用委派时的工作目录；`fixed` 用 `cwd` |
| `cwd` | 空 | `cwdPolicy: fixed` 时使用的工作目录 |

在 profile 的 `cordis.patch.yml` 里覆盖：

```yaml
- id: subagent-qoder-cn
  name: dsh-qoder-cn-subagent
  config:
    authMode: auto
    model: qmodel_latest
    maxTurns: 60
    sessionPersistence: true
```

## 它刻意不做的事

- **不声明做不到的能力**。`agentOptions` / `agentPreset` / `outputSchema` / `depthLimit` 全为 false：Qoder CN 在另一个进程里跑，父级强制的这些启动能力它接不住。声明支持再静默忽略，会让调用方以为限制生效了。
- **不转发图片**。当前只走文本提示；遇到图片块会显式标注「已丢弃」，而不是让模型对着残缺输入瞎猜。
- **不碰 Qoder 的登录文件**。插件只读 `settings.json` 与 App 的状态快照；`authMode: token` 也只把令牌用在本次 SDK 调用上。
- **不复制 IDE 的插件开关**。`enabledPlugins` 属于 IDE 的插件体系，SDK 侧没有对应概念，直接丢弃而不是假装支持。

## 故障排查

| 现象 | 原因 | 处理 |
|---|---|---|
| `No qodercli login found` | CLI 侧没有登录态 | `qoderclicn login` 一次 |
| `The provided access token was rejected` | 填了 App 的 device token，或令牌已过期 | 改用 CLI 登录，或换一个真的 personal access token |
| 启动时报 `cannot enforce maxDepth` | patch 里漏了 `maxDepth: provider-managed` | 补上该项 |
| `Ignored build scripts` | pnpm 拦下了 SDK postinstall | 见上文 `allowBuilds` |
| 委派一直无响应后报超时 | Qoder worker runtime 缺失或损坏 | 重跑 `pnpm rebuild @qodercn-ai/qodercn-agent-sdk` |

## 结构

```
lib/
  index.js          # 提供方注册与配置 schema
  qoder-cn.js       # 认证选择、设置委派、提示折叠、结果收敛
  host-modules.js   # 从宿主入口解析 @deepseek-ai/* 共享包
test/
  qoder-cn.test.js           # 认证/设置/提示/结果映射
  subagent-provider.test.js  # run 句柄契约与取消语义
cordis.patch.yml    # bundle 层：注册后端 + 委派工具
```

关于 `host-modules.js`：profile 里的插件和 DSH 宿主不在同一个 node_modules 树中，宿主以安装级包表提供 `@deepseek-ai/*`。直接 `import '@deepseek-ai/schemastery'` 在 profile 里解析不到，必须从宿主入口 `createRequire`——而且必须这么做，因为 cordis 靠实例身份判定服务，装第二份会出现「注册了却取不到」的问题。

## 验证

```sh
node --test test/qoder-cn.test.js test/subagent-provider.test.js
```

测试不触网：SDK 被替换成可控的假实现，断言的是「Qoder 返回什么 → DSH 收到什么」的映射，以及取消、幂等、错误收敛这些契约行为。

## 许可

MIT
