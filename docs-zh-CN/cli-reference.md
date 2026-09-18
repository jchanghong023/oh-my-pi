# CLI 参考

`omp` 的调用形式为：

```sh
omp [command] [flags] [messages...]
```

当第一个非 flag 参数**不是**已注册的子命令时，`omp`
会路由到默认的 [`launch`](#launch默认命令) 命令，并把参数当作初始提示词。因此
`omp "fix the build"` 会以该消息启动一个会话，而 `omp models`
则运行 `models` 子命令。

运行时帮助也可通过以下方式获取：

- `omp --help` 列出面向用户的子命令和常用的 launch flags。
- `omp <command> --help` 打印该命令的公共 flags 和示例。

本页是共享 **launch 界面**（即 `omp` / `omp launch` 接受的 flags）
与所有顶层**子命令**的统一参考。各子命令专属的 flags（例如 `omp auth-broker --json`）
由各命令自身的 `--help` 提供说明。

## Launch（默认命令）

`omp` 和 `omp launch` 用于启动编码会话。位置参数会成为初始消息：

```sh
# 交互式会话
omp

# 带初始提示词的交互式会话
omp "List all .ts files in src/"

# 将文件/图片附加到初始消息（加 @ 前缀）
omp @prompt.md @image.png "What color is the sky?"

# 非交互式：处理提示词后退出（headless / print 模式）
omp -p "List all .ts files in src/"

# 继续上一次的会话
omp --continue "What did we discuss?"
```

参数处理方式：

- `@<path>` 将文件或图片附加到初始消息。
- 非 TTY 的 stdin 会自动作为初始提示词读取；不要添加 `-` 标记。
- `--` 结束 flag 解析；其后的所有内容都是字面消息文本，即使看起来像 flag。

### Launch flags

#### 会话与工作区

| Flag | 描述 |
| --- | --- |
| `--cwd <dir>` | 启动时所在的目录（覆盖启动 cwd）。 |
| `--add-dir <dir>` | 在工作目录之外添加一个工作区目录（可重复）。 |
| `--allow-home` | 允许在 `~` 中启动而不自动切换到临时目录。 |
| `--profile <name>` | 为 auth、会话、设置和缓存使用一个隔离的 profile。 |
| `--alias <name>` | 为所选 profile 创建一个 shell 快捷方式后退出。 |
| `--config <file>` | 为本次运行额外加载一个 `config.yml` 风格的覆盖配置（可重复）。 |
| `--session-dir <dir>` | 会话存储与查找所在的目录。 |
| `--no-session` | 不保存会话（临时）。 |

#### 会话历史

| Flag | 描述 |
| --- | --- |
| `--continue`, `-c` | 继续上一次的会话。 |
| `--resume [id]`, `-r`, `--session [id]` | 按 ID 前缀或路径恢复会话；未提供值时打开选择器。 |
| `--fork <session>` | 将已保存的会话（按 ID 前缀或路径）fork 为一个新会话。参见 [session operations](./session-operations-export-share-fork-resume.md)。 |
| `--from-claude` | 将 Claude Code 会话导入 OMP。 |
| `--from-codex` | 将 Codex 会话导入 OMP。 |
| `--export <session>` | 将会话文件导出为 HTML 并退出。 |
| `--no-title` | 禁用标题自动生成（等价于 `PI_NO_TITLE` [环境变量](./environment-variables.md)）。 |

#### 模型选择

| Flag | 描述 |
| --- | --- |
| `--model <id-or-role>` | 要使用的模型或已配置的角色（角色：`slow` 或 `@slow`；模型模糊匹配：`opus`、`gpt-5.2` 或 `openai/gpt-5.2`）。 |
| `--smol <id>` | 用于轻量任务的 smol/fast 模型（或 `PI_SMOL_MODEL`）。 |
| `--slow <id>` | 用于深入分析的 slow/reasoning 模型（或 `PI_SLOW_MODEL`）。 |
| `--plan <id>` | 用于架构规划的 plan 模型（或 `PI_PLAN_MODEL`）。 |
| `--models <a,b,c>` | 用于 `Ctrl+P` 循环切换的逗号分隔模型模式。 |
| `--provider <name>` | 要使用的 provider（遗留方式；推荐使用 `--model`）。 |
| `--api-key <key>` | API key（默认取自环境变量）。 |
| `--provider-session-id <id>` | 复用指定的 provider 侧会话 id，以保证连续性与缓存作用域。 |
| `--prompt-cache-key <key>` | 覆盖本次会话的 provider 提示词缓存键。 |
| `--service-tier <tier>` | 本次会话使用的 OpenAI service tier（`none` 表示省略 `service_tier`）。 |

模型解析详见 [providers](./providers.md) 与 [models](./models.md)。

#### 思考与推理

| Flag | 描述 |
| --- | --- |
| `--thinking <level>` | 设置思考级别：`off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max` 或 `auto`。 |
| `--hide-thinking` | 在 TUI 输出中隐藏思考块（仅影响显示；不会禁用模型思考）。 |
| `--print-thoughts` | 在 print 模式的文本输出中包含思考块。 |
| `--external-thinking` | 使用私有草稿区，同时禁用受支持的 GPT/Claude/Gemini 推理。风险自负：provider 已将这种请求形态标记为滥用。 |

#### Prewalk 与计划模式

| Flag | 描述 |
| --- | --- |
| `--prewalk` | 在计划的 todo 列表存在后，于首次 edit/write 时切换到 fast/cheap 模型（默认关闭；参见 `prewalk.enabled`）。 |
| `--no-prewalk` | 即使已设置 `prewalk.enabled` 也禁用 prewalk。 |
| `--prewalk-into <id>` | prewalk 的目标模型（默认为 `smol` 角色）。 |
| `--plan-yolo` | 启动时强制进入只读计划模式，在模型的首次 resolve 调用时自动批准该计划，然后切换到 `--plan-yolo-into` 加以实现。 |
| `--plan-yolo-into <id>` | plan-yolo 执行阶段的目标模型（默认为 `smol` 角色）。 |

#### 工具、审批与运行时

| Flag | 描述 |
| --- | --- |
| `--tools <a,b,c>` | 要启用的工具的逗号分隔列表（默认：全部）。 |
| `--no-tools` | 禁用所有内建工具。 |
| `--no-lsp` | 禁用 LSP 工具、格式化与诊断。 |
| `--no-pty` | 禁用基于 PTY 的交互式 bash 执行。 |
| `--approval-mode <mode>` | 覆盖本次会话的 `tools.approvalMode`（`always-ask`、`write` 或 `yolo`）。参见 [approval mode](./approval-mode.md)。 |
| `--auto-approve`, `--yolo` | 自动批准所有工具调用（跳过审批提示）。 |
| `--advisor` | 启用 advisor 运行时（被动审查每一轮并注入备注）。参见 [advisor / watchdog](./advisor-watchdog.md)。 |
| `--max-time <duration>` | 在该时长后停止会话（例如 `600`、`10m`、`1h`）。 |

#### 扩展、hooks、skills 与 rules

| Flag | 描述 |
| --- | --- |
| `--extension <path>`, `-e <path>` | 加载一个扩展（可重复）。参见 [extensions](./extensions.md)。 |
| `--hook <path>` | 加载一个 hook/extension 文件（可重复）。参见 [hooks](./hooks.md)。 |
| `--trusted-extension <abs-path>` | 从绝对路径加载一个受信任的扩展（可重复；不能与 `--extension`/`-e`/`--hook` 组合使用）。 |
| `--plugin-dir <dir>` | 将一个本地插件目录加入发现范围（可重复）。 |
| `--no-extensions` | 禁用扩展发现（显式指定的 `-e` 路径仍然有效）。 |
| `--skills <globs>` | 用于过滤 [skills](./skills.md) 的逗号分隔 glob 模式（例如 `git-*,docker`）。 |
| `--no-skills` | 禁用 skills 的发现与加载。 |
| `--no-rules` | 禁用 rules 的发现与加载。参见 [context files](./context-files.md)。 |

#### 系统提示词

| Flag | 描述 |
| --- | --- |
| `--system-prompt <text\|file>` | 系统提示词（默认：编码助手提示词）。参见 [system prompt customization](./system-prompt-customization.md)。 |
| `--append-system-prompt <text\|file>` | 向系统提示词追加文本或文件内容。 |

#### 输出模式

| Flag | 描述 |
| --- | --- |
| `--mode <mode>` | 输出/传输模式：`text`（默认）、`json`、`rpc`、`acp` 或 `rpc-ui`。参见 [输出模式](#输出模式--mode)。 |

#### 信息

| Flag | 描述 |
| --- | --- |
| `--help`, `-h` | 显示 `omp` 或某个子命令的帮助并退出。 |
| `--version`, `-v` | 打印已安装的版本并退出。 |

### Headless / print 模式

`--print` / `-p` 以非交互方式运行 `omp`：处理提示词，将结果流式输出到 stdout，
然后退出而不进入 TUI。这是脚本化与自动化的入口点。

```sh
# 打印答案并退出
omp -p "Summarize the changes in the last commit"

# 在打印文本中包含模型的思考块
omp -p --print-thoughts "Explain your reasoning for this refactor"

# 为流水线生成机器可读的输出
omp -p --mode json "List every TODO in src/" > todos.json

# 通过 stdin 传入提示词
echo "review this diff" | omp -p
```

headless 运行的相关 flags：

- `--print-thoughts` — 在打印的文本输出中包含思考块。
- `--mode json` — 输出结构化事件，而非渲染后的文本。
- `--no-title` — 跳过标题自动生成（也可用 `PI_NO_TITLE`）。
- `--max-time <duration>` — 限制运行时长。

[advisor / watchdog](./advisor-watchdog.md#headless-runs) 文档描述了在启用
advisor 运行时的情况下 print 模式的处理（disposal）语义。

### 输出模式（`--mode`）

| 模式 | 描述 |
| --- | --- |
| `text` | 默认。渲染后的文本输出（交互时为 TUI，`--print` 下为纯文本）。 |
| `json` | 结构化 JSON 事件流，供 headless/机器消费。 |
| `rpc` | 基于 stdio 的 JSON-RPC 服务器。参见 [RPC](./rpc.md)。 |
| `rpc-ui` | 启用了 UI 扩展事件的 RPC 传输。 |
| `acp` | 基于 stdio 的 Agent Client Protocol 服务器。等价于 [`acp`](#子命令) 子命令；参见 [approval mode → ACP sessions](./approval-mode.md#acp-sessions)。 |

## 子命令

运行 `omp <command> --help` 可查看各命令自身的 flags 和示例。

| Command | 用途 | 另请参见 |
| --- | --- | --- |
| `launch` | 启动编码会话（默认命令）。 | [Launch flags](#launch-flags) |
| `acp` | 将 Oh My Pi 作为基于 stdio 的 ACP (Agent Client Protocol) 服务器运行。 | [approval mode](./approval-mode.md#acp-sessions) |
| `auth-broker` | 管理 omp auth-broker（凭据保险库）。 | [auth broker / gateway](./auth-broker-gateway.md) |
| `auth-gateway` | 运行由已配置 broker 支撑的 auth-gateway 正向代理。 | [auth broker / gateway](./auth-broker-gateway.md) |
| `agents` | 管理内置的 task agent。 | [task agent discovery](./task-agent-discovery.md) |
| `bench` | 对模型进行基准测试：在 chat、prefill、generation 与提示词缓存工作负载下，以 p50/p95 对比 TTFT/prefill 与 decode 吞吐量，并在实时仪表板中呈现（`--prefill-bytes` 用于设定合成 prefill 输入的大小）。 | |
| `browser-relay` | 运行 Eval 的 browser API 用来驱动你自己 Chrome 标签页的本地 CDP 中继。 | [computer use](./computer-use.md) |
| `cleanse` | 使用加权的并行子 agent 检测并修复项目诊断问题。 | |
| `commit` | 生成 commit message 并更新 changelog。 | |
| `completions` | 打印 shell 补全脚本（bash、zsh 或 fish）。 | |
| `compress` | 将文本文件改写为密集的 prompt register，并报告它丢弃了哪些内容。 | |
| `config` | 管理配置设置。 | [config usage](./config-usage.md)、[settings](./settings.md) |
| `docs` | 管理持久化的外部 Markdown 文档索引。 | [wiki 工具](./tools/wiki.md) |
| `dry-balance` | 在随机会话 id 上以 dry-run 方式执行 OAuth 账户平衡。 | |
| `gc` | 运行存储垃圾回收。 | |
| `grep` | 从 CLI 测试 grep 工具。（[`grep` 工具](./tools/grep.md) 是一个独立的 agent 工具。） | |
| `gallery` | 跨 streaming、in-progress、success、failure 状态预览工具渲染器。 | |
| `git` | 交互式全屏 git UI：split diff 查看器、staging 侧栏与 commit composer。 | |
| `grievances` | 查看、清理或推送已报告的工具问题（auto-QA grievances）。 | |
| `if-bench` | 对指令遵循与工作记忆进行基准测试：一条带缓存的 glyph 数组操作线程，附带一条贯穿提示词的猫叫声指令。 | |
| `images`, `img` | 检查、诊断、探测并清除图片发布后端。 | |
| `install` | 安装或链接一个扩展包（`plugin install` / `plugin link` 的别名）。 | [extensions](./extensions.md) |
| `join` | 加入一个共享 collab 会话（等同于 `/join`）。 | [collab](./collab.md) |
| `models` | 列出、搜索并刷新可用模型。 | [models](./models.md) |
| `plugin` | 管理插件（install、uninstall、list 等）。 | [extensions](./extensions.md)、[marketplace](./marketplace.md) |
| `ps` | 列出并控制由守护进程监管的后台进程（logs、stop、kill、restart）。 | |
| `say` | 用本地 TTS 引擎合成文本并通过扬声器播放。 | [tts tool](./tools/tts.md) |
| `share` | 通过加密链接分享已保存的会话（与 `/share` 斜杠命令相同）。 | [session operations](./session-operations-export-share-fork-resume.md) |
| `setup` | 运行 onboarding 设置，或为可选功能安装依赖。 | |
| `shell` | 交互式 shell 控制台。 | |
| `read` | 显示 read 工具针对某个路径、URL 或内部 URI 将返回的内容。（[`read` 工具](./tools/read.md) 是一个独立的 agent 工具。） | |
| `render` | 通过生产级 transcript 管线绘制会话的完整线程（含重绘计时）。 | |
| `ssh` | 管理 SSH 主机配置。 | |
| `stats` | 查看使用统计。 | |
| `update` | 检查并安装更新；`--canary`/`--stable` 用于切换发布渠道。 | |
| `usage` | 显示每个已认证账户的 provider 使用限额；`usage clients` 按客户端细分 token 消耗（配合 `--days`），`usage invalidate` 丢弃缓存的报告。 | |
| `tiny-models` | 下载微型本地模型（会话标题 + 记忆）。 | [local models](./local-models.md) |
| `token` | 获取某个 provider 的 API key 或 OAuth token。 | [secrets](./secrets.md) |
| `ttsr` | 检查并测试 Time-Traveling Stream Rules (TTSR)。（涵盖 CLI 命令；[TTSR 功能](./ttsr-injection-lifecycle.md) 另有单独文档。） | |
| `worktree`, `wt` | 列出或清除由 agent 管理的 git worktree（`~/.omp/wt`）。 | |
| `search`, `q` | 从 CLI 测试 web search provider。 | [web_search tool](./tools/web_search.md) |

> `install`、`join`、`browser-relay`、`auth-gateway` 和 `tiny-models` 也可以
> 通过相关机制访问（`plugin` 命令、`/join` 斜杠命令等）。上表按各项在
> `packages/coding-agent/src/cli-commands.ts` 中的注册形式列出。
