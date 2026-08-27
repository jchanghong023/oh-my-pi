# CLI 参考

`omp` 的调用形式为：

```sh
omp [command] [flags] [messages...]
```

当第一个非 flag 参数**不是**已注册的子命令时，`omp`
会路由到默认的 [`launch`](#launch-the-default-command) 命令，并把
该参数作为初始 prompt。因此 `omp "fix the build"` 会以该消息启动一个会话，
而 `omp models` 则运行 `models` 子命令。

运行时帮助也可通过以下方式获取：

- `omp --help` 列出面向用户的子命令和常用的 launch flags。
- `omp <command> --help` 打印该命令的公共 flags 和示例。

本页是共享的 **launch 界面**（即 `omp` / `omp launch` 接受的 flags）
以及每个顶层 **子命令** 的统一参考。各子命令特有的 flags（例如 `omp auth-broker --json`）
由各命令自身的 `--help` 提供说明。

## Launch（默认命令）

`omp` 和 `omp launch` 用于启动一个编码会话。位置参数会成为初始消息：

```sh
# 交互式会话
omp

# 带初始 prompt 的交互式会话
omp "List all .ts files in src/"

# 将文件/图片附加到初始消息（使用 @ 前缀）
omp @prompt.md @image.png "What color is the sky?"

# 非交互式：处理 prompt 后退出（headless / print 模式）
omp -p "List all .ts files in src/"

# 继续上一次的会话
omp --continue "What did we discuss?"
```

参数处理方式：

- `@<path>` 将文件或图片附加到初始消息。
- 非 TTY 的 stdin 会自动作为初始 prompt 读取，无需添加 `-` 标记。
- `--` 结束 flag 解析；其后的所有内容都将作为字面消息文本，即使看起来像 flag。

### Launch flags

#### 会话与工作区

| Flag | 描述 |
| --- | --- |
| `--cwd <dir>` | 启动时所在的目录（覆盖启动 cwd）。 |
| `--add-dir <dir>` | 在工作目录之外额外添加一个工作区目录（可重复）。 |
| `--allow-home` | 允许在 `~` 目录启动而不会自动切换到临时目录。 |
| `--profile <name>` | 使用一个隔离的 profile 来管理 auth、sessions、settings 和 caches。 |
| `--alias <name>` | 为所选 profile 创建一个 shell 快捷方式后退出。 |
| `--config <file>` | 本次运行额外加载一个 `config.yml` 样式的覆盖配置（可重复）。 |
| `--session-dir <dir>` | 用于会话存储和查找的目录。 |
| `--no-session` | 不保存会话（临时）。 |

#### 会话历史

| Flag | 描述 |
| --- | --- |
| `--continue`, `-c` | 继续上一次的会话。 |
| `--resume [id]`, `-r`, `--session [id]` | 按 ID 前缀或路径恢复会话；未提供值时打开选择器。 |
| `--fork <session>` | 将已保存的会话（按 ID 前缀或路径）派生为一个新会话。参见 [session operations](./session-operations-export-share-fork-resume.md)。 |
| `--from-claude` | 将 Claude Code 会话导入到 OMP。 |
| `--from-codex` | 将 Codex 会话导入到 OMP。 |
| `--export <session>` | 将一个会话文件导出为 HTML 后退出。 |
| `--no-title` | 禁用标题自动生成（等价于 `PI_NO_TITLE` [环境变量](./environment-variables.md)）。 |

#### 模型选择

| Flag | 描述 |
| --- | --- |
| `--model <id-or-role>` | 要使用的模型或已配置的角色（角色：`slow` 或 `@slow`；模型模糊匹配：`opus`、`gpt-5.2` 或 `openai/gpt-5.2`）。 |
| `--smol <id>` | 用于轻量任务的 smol/fast 模型（或 `PI_SMOL_MODEL`）。 |
| `--slow <id>` | 用于深入分析的 slow/reasoning 模型（或 `PI_SLOW_MODEL`）。 |
| `--plan <id>` | 用于架构规划的 plan 模型（或 `PI_PLAN_MODEL`）。 |
| `--models <a,b,c>` | 用于 `Ctrl+P` 切换的逗号分隔模型列表。 |
| `--provider <name>` | 要使用的 provider（遗留选项；推荐使用 `--model`）。 |
| `--api-key <key>` | API key（默认从环境变量读取）。 |
| `--provider-session-id <id>` | 复用 provider 端指定的 session id，以保证连续性和缓存作用域。 |
| `--prompt-cache-key <key>` | 覆盖本次会话的 provider prompt-cache key。 |
| `--service-tier <tier>` | 本次会话的 OpenAI service tier（`none` 表示省略 `service_tier`）。 |

有关模型解析方式，请参见 [providers](./providers.md) 和 [models](./models.md)。

#### 思考与推理

| Flag | 描述 |
| --- | --- |
| `--thinking <level>` | 设置思考级别：`off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max` 或 `auto`。 |
| `--hide-thinking` | 在 TUI 输出中隐藏思考块（仅影响显示，不会禁用模型本身的思考）。 |
| `--print-thoughts` | 在 print 模式的文本输出中包含思考块。 |
| `--external-thinking` | 使用私有草稿区，同时禁用受支持的 GPT/Claude/Gemini 推理。请自行承担风险：provider 已将该请求形式标记为滥用。 |

#### Prewalk 与 plan 模式

| Flag | 描述 |
| --- | --- |
| `--prewalk` | 在 plan 的 todo 列表存在后，于首次 edit/write 时切换到 fast/cheap 模型（默认关闭；参见 `prewalk.enabled`）。 |
| `--no-prewalk` | 即使 `prewalk.enabled` 已设置，也禁用 prewalk。 |
| `--prewalk-into <id>` | prewalk 的目标模型（默认为 `smol` 角色）。 |
| `--plan-yolo` | 启动时强制进入只读 plan 模式，在模型首次 resolve 调用时自动批准该 plan，然后切换到 `--plan-yolo-into` 去实施。 |
| `--plan-yolo-into <id>` | plan-yolo 执行阶段的目标模型（默认为 `smol` 角色）。 |

#### 工具、审批与运行时

| Flag | 描述 |
| --- | --- |
| `--tools <a,b,c>` | 逗号分隔的启用工具列表（默认：全部）。 |
| `--no-tools` | 禁用所有内建工具。 |
| `--no-lsp` | 禁用 LSP 工具、格式化和诊断。 |
| `--no-pty` | 禁用基于 PTY 的交互式 bash 执行。 |
| `--approval-mode <mode>` | 覆盖本次会话的 `tools.approvalMode`（`always-ask`、`write` 或 `yolo`）。参见 [approval mode](./approval-mode.md)。 |
| `--auto-approve`, `--yolo` | 自动批准所有工具调用（跳过审批提示）。 |
| `--advisor` | 启用 advisor 运行时（对每一轮进行被动审查并注入备注）。参见 [advisor / watchdog](./advisor-watchdog.md)。 |
| `--max-time <duration>` | 在指定时长后停止会话（例如 `600`、`10m`、`1h`）。 |

#### 扩展、hooks、skills 与 rules

| Flag | 描述 |
| --- | --- |
| `--extension <path>`, `-e <path>` | 加载一个扩展（可重复）。参见 [extensions](./extensions.md)。 |
| `--hook <path>` | 加载一个 hook/extension 文件（可重复）。参见 [hooks](./hooks.md)。 |
| `--trusted-extension <abs-path>` | 从绝对路径加载一个受信任的扩展（可重复；不能与 `--extension`/`-e`/`--hook` 同时使用）。 |
| `--plugin-dir <dir>` | 将一个本地插件目录加入发现列表（可重复）。 |
| `--no-extensions` | 禁用扩展发现（显式给出的 `-e` 路径仍然有效）。 |
| `--skills <globs>` | 用于过滤 [skills](./skills.md) 的逗号分隔 glob 模式（例如 `git-*,docker`）。 |
| `--no-skills` | 禁用 skills 的发现与加载。 |
| `--no-rules` | 禁用 rules 的发现与加载。参见 [context files](./context-files.md)。 |

#### 系统 prompt

| Flag | 描述 |
| --- | --- |
| `--system-prompt <text\|file>` | 系统 prompt（默认：编码助手 prompt）。参见 [system prompt customization](./system-prompt-customization.md)。 |
| `--append-system-prompt <text\|file>` | 向系统 prompt 追加文本或文件内容。 |

#### 输出模式

| Flag | 描述 |
| --- | --- |
| `--mode <mode>` | 输出/传输模式：`text`（默认）、`json`、`rpc`、`acp` 或 `rpc-ui`。参见 [output modes](#output-modes---mode)。 |

#### 信息

| Flag | 描述 |
| --- | --- |
| `--help`, `-h` | 显示 `omp` 或某个子命令的帮助并退出。 |
| `--version`, `-v` | 打印已安装的版本并退出。 |

### Headless / print 模式

`--print` / `-p` 以非交互方式运行 `omp`：处理 prompt，将结果流式输出到 stdout，
然后退出而不进入 TUI。这是脚本化与自动化的入口点。

```sh
# 打印答案并退出
omp -p "Summarize the changes in the last commit"

# 在打印文本中包含模型的思考块
omp -p --print-thoughts "Explain your reasoning for this refactor"

# 为流水线生成机器可读的输出
omp -p --mode json "List every TODO in src/" > todos.json

# 通过 stdin 传入 prompt
echo "review this diff" | omp -p
```

headless 运行的相关 flags：

- `--print-thoughts` — 在打印的文本输出中包含思考块。
- `--mode json` — 输出结构化事件，而非渲染后的文本。
- `--no-title` — 跳过标题自动生成（也可用 `PI_NO_TITLE`）。
- `--max-time <duration>` — 设置运行时长上限。

[advisor / watchdog](./advisor-watchdog.md#headless-runs) 文档描述了在启用
advisor 运行时的情况下 print 模式的处理（disposal）语义。

### 输出模式（`--mode`）

| 模式 | 描述 |
| --- | --- |
| `text` | 默认。渲染后的文本输出（交互时为 TUI，在 `--print` 下为纯文本）。 |
| `json` | 结构化 JSON 事件流，用于 headless/机器消费。 |
| `rpc` | 基于 stdio 的 JSON-RPC 服务。参见 [RPC](./rpc.md)。 |
| `rpc-ui` | 启用了 UI 扩展事件的 RPC 传输。 |
| `acp` | 基于 stdio 的 Agent Client Protocol 服务。等价于 [`acp`](#subcommands) 子命令；参见 [approval mode → ACP sessions](./approval-mode.md#acp-sessions)。 |

## 子命令

运行 `omp <command> --help` 可查看各命令自身的 flags 和示例。

| Command | 用途 | 另请参见 |
| --- | --- | --- |
| `launch` | 启动一个编码会话（默认命令）。 | [Launch flags](#launch-flags) |
| `acp` | 将 Oh My Pi 作为 ACP (Agent Client Protocol) 服务运行于 stdio 之上。 | [approval mode](./approval-mode.md#acp-sessions) |
| `auth-broker` | 管理 omp auth-broker（凭据保险库）。 | [auth broker / gateway](./auth-broker-gateway.md) |
| `auth-gateway` | 基于已配置的 broker 运行一个 auth-gateway 正向代理。 | [auth broker / gateway](./auth-broker-gateway.md) |
| `agents` | 管理打包的 task agents。 | [task agent discovery](./task-agent-discovery.md) |
| `bench` | 使用相同 prompt 对模型进行基准测试：首 token 耗时与生成吞吐（tokens/s）。 | |
| `browser-relay` | 运行本地 CDP 中继，使 browser 工具可以驱动你自己的 Chrome 标签页。 | [computer use](./computer-use.md) |
| `cleanse` | 使用加权的并行子代理检测并修复项目中的诊断问题。 | |
| `commit` | 生成 commit message 并更新 changelogs。 | |
| `completions` | 打印 shell 补全脚本（bash、zsh 或 fish）。 | |
| `compress` | 将文本文件改写为密集的 prompt register，并报告被丢弃的内容。 | |
| `config` | 管理配置项。 | [config usage](./config-usage.md)、[settings](./settings.md) |
| `dry-balance` | 在随机 session ids 上 dry-run OAuth 账户平衡。 | |
| `gc` | 运行存储垃圾回收。 | |
| `grep` | 从 CLI 测试 grep 工具。（[`grep` 工具](./tools/grep.md) 是一个独立的 agent 工具。） | |
| `gallery` | 跨 streaming、in-progress、success 和 failure 状态预览工具渲染器。 | |
| `grievances` | 查看、清理或上报已报告的工具问题（auto-QA grievances）。 | |
| `if-bench` | 基准测试指令遵循与工作记忆：单个带缓存的 thread，依次执行 glyph 数组动作，并以一个贯穿 prompt 的猫叫声指令作为额外要求。 | |
| `install` | 安装或链接一个扩展包（`plugin install` / `plugin link` 的别名）。 | [extensions](./extensions.md) |
| `join` | 加入一个共享的 collab 会话（与 `/join` 相同）。 | [collab](./collab.md) |
| `models` | 列出、搜索并刷新可用模型。 | [models](./models.md) |
| `plugin` | 管理插件（install、uninstall、list 等）。 | [extensions](./extensions.md)、[marketplace](./marketplace.md) |
| `ps` | 列出并控制由守护进程监管的后台进程（logs、stop、kill、restart）。 | |
| `say` | 使用本地 TTS 引擎合成文本并通过扬声器播放。 | [tts tool](./tools/tts.md) |
| `share` | 通过加密链接分享已保存的会话（与 `/share` 斜杠命令相同）。 | [session operations](./session-operations-export-share-fork-resume.md) |
| `setup` | 运行 onboarding 设置或安装可选功能所需的依赖。 | |
| `shell` | 交互式 shell 控制台。 | |
| `read` | 显示 read 工具将针对某个路径、URL 或内部 URI 返回的内容。（[`read` 工具](./tools/read.md) 是一个独立的 agent 工具。） | |
| `ssh` | 管理 SSH 主机配置。 | |
| `stats` | 查看使用统计。 | |
| `update` | 检查并安装更新。 | |
| `usage` | 显示每个已认证账户的 provider 使用上限。 | |
| `tiny-models` | 下载小型本地模型（会话标题 + 记忆）。 | [local models](./local-models.md) |
| `token` | 获取 provider 的 API key 或 OAuth token。 | [secrets](./secrets.md) |
| `ttsr` | 检查并测试 Time-Traveling Stream Rules (TTSR)。（涵盖 CLI 命令；[TTSR 功能](./ttsr-injection-lifecycle.md) 有单独文档。） | |
| `worktree`, `wt` | 列出或清理由 agent 管理的 git worktrees（`~/.omp/wt`）。 | |
| `search`, `q` | 从 CLI 测试 web search providers。 | [web_search tool](./tools/web_search.md) |

> `install`、`join`、`browser-relay`、`auth-gateway` 和 `tiny-models` 也可
> 通过相关机制访问（如 `plugin` 命令、`/join` 斜杠命令等）。上表按照它们在
> `packages/coding-agent/src/cli-commands.ts` 中的注册形式列出。
