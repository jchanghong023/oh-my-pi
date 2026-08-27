# Oh My Pi 完整命令与快捷键教程

这不是命令索引，而是一份面向实际使用的操作指南。每个主题都会说明命令或快捷键解决什么问题、执行后会发生什么，以及应该在什么场景使用。

## 如何阅读命令格式

### 如何阅读 OMP 命令格式

`omp` 是单个二进制命令；除了 `--help` / `--version` / `help` / `--license` / `--smoke-test` / 内部 worker 选择器（`__omp_worker_*`）这些会提前返回的入口外，**首个非选项位置参数**就是子命令名；任何无法匹配的 argv 默认转发给内置的 `launch` 子命令。本节解释这套约定，不展开某个具体命令。

> 阅读命令清单：`omp --help` 打印根帮助；`omp <子命令> --help` 打印单个子命令的帮助（含 `USAGE` 行、参数与选项描述、示例）。子命令本身可能仍接受 `--help` / `-h`，解析器见 `packages/utils/src/cli.ts`，调度器见 `packages/coding-agent/src/cli-commands.ts` 与 `packages/coding-agent/src/cli.ts` 的 `runCli`。

#### 命令骨架

```text
omp [全局选项] <子命令> [子命令参数 ...]
omp [全局选项]                # 无子命令 ⇒ 等价于 omp launch
```

- 二进制名是 `omp`（即 `APP_NAME`）。`--version` / `-v` 始终打印 `<bin>/<version>`，与子命令无关（见 `cli.ts` 的 `runCli` 与 `utils/cli.ts` 的 `run`）。
- 第一段位置参数若命中 `cli-commands.ts` 中 `commands` 表里的 `name` 或 `aliases`，就作为子命令名分发；命中后 argv[0] 之前的“启动期全局选项”（`--cwd`、`--model`、`--approval-mode` 等，见 `LAUNCH_FLAG_COMMANDS` / `STRING_VALUE_FLAGS` / `OPTIONAL_VALUE_FLAGS` / `VALUELESS_FLAGS`）会被保留并转发给 `launch` 族子命令；其它子命令会把这些全局选项剥离掉，避免严格解析器把它们当成错别字报错（`stripLaunchGlobalFlags`，issue #8891）。
- 第一段不是子命令、也不是 `--help` / `-h` / `--version` / `-v` / `help`，且向后扫不到子命令时，整条 argv 会被改写成 `omp launch ...`，由 `launch` 子命令处理（`resolveCliArgv`）。
- 一些看着像管理动词、但**没有**作为顶层子命令注册的词（`marketplace`、`extensions`、`list`、`remove`、`uninstall`、`discover`、`upgrade`、`enable`、`disable`），会在 `reservedTopLevelWordMessage` 里返回一条提示；命中条件是该词出现在首位且后面跟着合乎语法的插件子动作（如 `omp marketplace add …`）或 `name@marketplace` 形式的插件 ID。提示是为了防止裸 `omp list` 被静默当成 prompt 转发给模型（issue #1496 / #2935 / #4845）。
- 极少数以 `__omp_worker_` 开头的 argv 是给工作线程 / 子进程入口用的隐藏 selector，由 `runWorkerEntrypoint` 独占消费；不要手写。

#### 位置参数

- **位置参数**（不带 `-` 前缀、或就是单独的 `-`）会被 `parseArgs` 收集到 `Args.messages`（`cli/args.ts`），作为给模型的初始消息。
- `--` 之后的全部 token 一律按字面量塞进 `messages`，不再尝试解析为选项（POSIX end-of-options，`args.ts:161–168, 293–297`）。需要传“看起来像选项”的字面文本时，务必在它前面加 `--`。
- 以 `@` 开头的 token（`@file`）被解析为 `Args.fileArgs`：把单/双引号包裹的路径剥壳后整体保留，引号内才允许的 `space` 不会触发分词。例如 `omp @prompt.md @image.png "What color is the sky?"`。
- 单独的 `-` 作为“stdin 标记”保留在 `messages` 中，不会被当作未知选项。
- 任何既不是子命令、也不是 `--help` / `--version`、也不能匹配到 `commands` 命名空间的位置参数（如 `omp hello world`）都会落到 `launch` 之后被解析；`launch` 自己在内部仍以 `strict = false` 跑（`commands/launch.ts:18`），于是多余的位置参数会变成消息，而不是错误。
- 重复位置参数会被全部累加到 `messages`，由 `launch` 串成一个多段消息。

#### 选项的形式

所有选项都是 GNU 风格，由 `parseArgs` 的 `for` 循环统一派发。

- **长选项**：`--name`。例如 `--model opus`。
- **短选项**（仅部分内置支持）：`-h`、`-v`、`-c`、`-p`、`-r`、`-e`。例如 `-p "summary"`，等价于 `--print "summary"`。
- **`--flag=value` 写法**：`args.ts:179–185` 会把 `=` 后的内容当作下一个 token 注入，让“需要值的选项”通过 `args[++i]` 读到；用 `--flag=value` 时值里**允许**以 `-` 开头（`flagConsumesValue` 判定内联值不再消耗后续 token）。布尔选项如果用了 `=` 形式（例如一个不存在的布尔 `--foo=bar`），后端的“未消费值丢弃”兜底会把它从 argv 中删掉，避免误当消息（issue #2459）。
- **布尔选项**（无需值的“长”开关）：所有 `VALUELESS_FLAGS` 里的名字（`--help`、`--version`、`--no-session`、`--auto-approve` / `--yolo`、`--print`、`--hide-thinking` 等，见 `flag-tables.ts:293–318`）。裸写即可，后面的非 `-` token 仍归下一段。
- **必取值的选项**（`STRING_VALUE_FLAGS`，如 `--model`、`--cwd`、`--provider`、`--system-prompt`、`--api-key`、`--max-time`、`--service-tier`、`--export`）会“吞掉”紧随其后的一个 token，即便那个 token 本身看着像选项（`--system-prompt --profile foo` 会把字面字符串 `--profile` 当成 system prompt，`args.ts:206–218`）。这是为了在脚本里临时传字面 flag 文本时不必额外加 `--`。
- **可选值选项**（`OPTIONAL_FLAGS`：`--resume` / `-r` / `--session`）：紧跟的非 `-` token 当作值；遇到空串或形如 `-x` 的下一个 flag 就保留为 `undefined`（`setResume` 看到 `undefined` 就只设 `true`，走“打开 picker”分支）。
- **可重复的选项**：`--config`、`--add-dir`、`--hook`、`--extension`（`-e`）、`--trusted-extension`、`--plugin-dir` 都是“数组型”；每次出现追加一个元素，例如 `omp -e ext1.ts -e ext2.ts ...`。
- **逗号分隔值**：`--tools`、`--skills`、`--models`、`--system-prompt` 不行，逗号列表由 `STRING_SETTERS` 在内部 `split(',')` 后去空白。`--thinking` 接受 `low | medium | high | xhigh` 等枚举（`cli/thinking-levels.ts`），非法值不会抛错，只会以 `logger.warn` 记录。

#### `--` 终止选项解析

- `args.ts:293–297` 把 `--` 设为 `sawSeparator = true`，之后**所有** token 不再分词/解析选项，原样进入 `messages`。这是向模型传“恰好以 `-` 开头”的字面文本的唯一安全做法。
- 例：`omp -- --help` 会把字符串 `--help` 当作一条消息，而不是再触发帮助打印。
- 例：`omp --print -- summarize this PR` 会把 `--print` 之前的选项解析掉，`--` 之后整体作为消息。

#### 重复参数与覆盖

- 同一选项多次出现时：
  - 数组型（`--config`、`--add-dir`、`-e`、`--hook`、`--trusted-extension`）按出现顺序累加，**不**覆盖。
  - 标量字符串型（`--model`、`--provider`、`--cwd`、`--system-prompt`、`--api-key`）后写覆盖先写；只有数组型才保留多次结果。
  - 互斥布尔（`--prewalk` / `--no-prewalk`、`--auto-approve` / `--yolo`）是各设各的位，最终生效哪一个由后续业务逻辑决定；不要混用。
- `--trusted-extension` 与 `--extension` / `-e` / `--hook` 互斥：同时出现会抛 `CliUsageError`（`args.ts:320–322`）。`--trusted-extension` 还要求值是**绝对路径**且非空，否则同样抛错（`args.ts:323–330`）。

#### 默认行为：未识别时回到 `launch`

- `resolveCliArgv` 的最后兜底是 `return { argv: ["launch", ...argv] }`。这就是为什么 `omp hello world` 不会报“未知命令”，而是被当作一次带提示的会话：消息 `"hello world"` 交给 `launch` 处理。
- 想强制把首词当 prompt 而不是子命令？把它写成一个以 `@` 开头或带引号的位置参数，或在前面放一个明显的全局选项触发“提升子命令”逻辑失败后再回到 `launch`。

#### 用 `--help` 判断

- `omp --help` / `omp -h` / `omp help` 走 `run()` 的根帮助分支，加载所有命令的静态元数据并由 `cli.ts` 的 `showHelp` 渲染（含 `omp help-extra` 提供的额外段落）。这是确认子命令清单、别名、可选项的最快方式。
- `omp <子命令> --help` 走 `run()` 的“按需加载”分支：只 `import` 那一个命令模块，渲染其 `USAGE` 行 / `args` / `flags` / `examples`。输出包含三段：
  - `USAGE`：`omp <子命令> [位置参数]`（来自 `args.ts` 的 `Args.string({ required, multiple })`）。
  - `FLAGS`：由 `Flags.string` / `Flags.boolean` 自动生成的选项表，标出 `char`（短别名）、`description`、`options`（枚举）、`multiple`（可重复）。
  - `EXAMPLES`：来自 `examples: []`。
- 命令未识别但带 `--help`：会在 stderr 写 `Unknown command: <id>` 并以非零退出码返回——这是判断“`x` 到底是不是子命令”的可靠手段。
- 想知道某个选项的合法值集合：看 `flags.<name>.options`；想知道默认值：默认通过“未传时 setter 不执行”实现（标量字段保持 `undefined`），具体业务默认值在 `main` 启动路径里填。
- 想知道错误原因：解析阶段的 `CliUsageError` 会被 `reportCliUsageError` 转成干净的 `error: <msg>` 加 `USAGE` 行（`utils/cli.ts` 的 `run`），不会泄漏内部堆栈。

#### 隐藏 / 内部命令

下列命令在帮助中默认不显示（或被标记 `hidden: true`），不建议手工调用，仅由其他工具/补全脚本触发：

- `__complete`：动态补全后端，由 `completions` 生成的 shell 脚本在用户按 Tab 时调用。手工 `omp __complete models` 会把当前模型目录打印到 stdout（每行 `value<TAB>description`）。
- 各种 `__omp_worker_*` 选择器：进程内 worker 入口，仅由 `runWorkerEntrypoint` 在 `runCli` 早期阶段识别。
- `__complete help.hidden = true`，其它“带 `hidden` 元数据”的子命令也不在根帮助里列出，但理论上可直接调用。

## 启动交互与协议接入

### `launch` —— 默认入口

`omp` 不带任何子命令时，等价于执行 `omp launch`，启动 OMP 的会话运行时。所有会话的旗标、会话、模型、扩展、能力开关都从这里进入。它和 `acp` 共用同一份旗标解析（`LAUNCH_FLAG_COMMANDS = { launch, acp }`），区别仅在 `launch` 默认按 `mode: text` 走交互式 TUI（除非用户显式覆盖 `mode` 或用 `--print`）。

- 内部命令：`launch` 在 `cli-commands.ts` 里注册为顶级子命令，`hidden: true`，**不建议手工键入 `omp launch`**，日常直接 `omp …` 即可。
- 真正进入 TUI 的判定：`!parsedArgs.print && !autoPrint && parsedArgs.mode === undefined`，缺一即进入协议/批处理分支。
- 接受的子动作：无；`launch` 是叶子命令。任何未识别的子动作位置参数会落到 `messages` 里被当成提示词发出去（参见 `#4845`、`#2935`、`#1496` 修复史），因此 `omp launch marketplace add xyz` 不会调到插件管理。
- 共享旗标：完整集合见下面「共享全局选项」一节。

语法：

```text
omp [launch] [options] [messages...]
omp [launch] [options] @file1 @file2 "prompt text"
omp [launch] --print [options] "prompt"
omp [launch] --continue [options] "follow-up"
omp [launch] --resume [session-id-or-path] [options] [messages...]
omp [launch] --export path/to/session.jsonl
```

- **功能**：启动一次 OMP 会话。
- **效果**：
  - 不带消息：进入 TUI，等待用户输入。
  - 带 `messages…` 作为首轮提示词；`@<path>` 形式的 token 会被识别为附件，进入 `fileArgs`，正文和附件一起下发。
  - 携带 `--print`（`-p`）时进入非交互模式：处理提示词、写输出、退出。
  - 携带 `--continue` / `--resume` 时从既有会话延续。
- **何时使用**：日常默认入口；做脚本化批处理时配合 `--print`；做会话复盘用 `--continue` / `--resume`；做 HTML 导出用 `--export`。

参数：

- **位置参数 `messages…`**（`Args.string({ multiple: true })`）：首轮提示词文本；以 `@` 开头的 token 视为文件路径。
- **共享全局选项**：`mode`、`profile`、`alias`、`cwd`、`config`、`add-dir`、`model`、`smol`、`slow`、`plan`、`provider`、`api-key`、`system-prompt`、`append-system-prompt`、`allow-home`、`print` / `-p`、`continue` / `-c`、`resume` / `-r` / `--session`、`from-claude`、`from-codex`、`session-dir`、`no-session`、`models`、`tools`、`no-tools`、`no-lsp`、`no-pty`、`thinking`、`service-tier`、`hide-thinking`、`advisor`、`external-thinking`、`prewalk`、`no-prewalk`、`prewalk-into`、`plan-yolo`、`plan-yolo-into`、`hook`、`extension` / `-e`、`no-extensions`、`no-skills`、`skills`、`no-rules`、`no-title`、`export`、`print-thoughts`、`max-time`、`auto-approve` / `yolo`、`approval-mode`。详见「共享全局选项」一节。

示例：

```bash
# 交互式
omp

# 交互式并预填提示词
omp "List all .ts files in src/"

# 把 Markdown 提示词和图片一起下发
omp @prompt.md @image.png "What color is the sky?"

# 非交互：处理后退出
omp -p "List all .ts files in src/"

# 延续最近一次会话
omp --continue "What did we discuss?"

# 模糊匹配模型
omp --model opus "Help me refactor this code"

# Ctrl+P 模型循环白名单
omp --models claude-sonnet,claude-haiku,gpt-4o

# 导出会话为 HTML
omp --export ~/.omp/agent/sessions/--path--/session.jsonl
```

注意：

- `launch` 是隐藏内部命令，对外只需记 `omp`。
- 任何误用 `omp <未注册词> …` 的场景（例如 `omp marketplace add xyz`）会被 `resolveCliArgv` 改写为 `omp launch …`，把整段 argv 当成 prompt 静默下发——这是已知反模式，遇到时优先用真正的子命令（`omp plugin …`）或显式 `omp launch …` 表达「这就是我要发的内容」。
- `--trusted-extension` 不能与 `--extension` / `-e` / `--hook` 同时使用，路径必须是绝对路径且非空。

### `acp` —— Agent Client Protocol 服务器

`omp acp` 是 `launch` 的薄包装：除了 `mode: "acp"`，其余旗标和 `launch` 完全相同。`acp` 通过 stdio 与外部 ACP 客户端（如编辑器扩展、IDE Agent 面板）对端通信，遵循 Agent Client Protocol。

- 内部命令：在 `cli-commands.ts` 中与 `launch` 平级注册，无别名，`hidden: false`。
- 与 `launch` 的差异：
  1. 缺省 `mode = "acp"`。`runAcpMode` 走 ACP 协议分支（`main.ts:1790-1804`），不渲染 TUI。
  2. 多一个内部旗标 `--acp-terminal-auth`（由 `prepareAcpTerminalAuthArgs` 处理），用于让 ACP 进程临时回到交互式 TUI 完成 OAuth 登录；出现该旗标时 `mode` 强制变为默认（`text` 交互式），而不是 `acp`。
  3. 任何 `mode` 选项里 `acp` 这个值只有 `acp` 命令下会被显式注入；用户也可以在 `launch` 下用 `--mode acp` 进入同一条分支，但通常不必要。
- 何时使用：把 OMP 嵌入 IDE / 编辑器 / 任何 ACP 兼容前端时；CI 中需要用结构化协议通道而不是 stdout 文本时。
- **不建议手工调用**：正常运行 `omp acp` 会让 OMP 立刻在 stdio 上等待 ACP 帧，不会有可读输出。除非你正在开发 ACP 客户端或调试协议握手，否则不要直接执行。

语法：

```text
omp acp [options] [messages...]
omp acp --acp-terminal-auth [options]
```

- **功能**：把 OMP 作为 ACP 服务器通过 stdio 暴露。
- **效果**：
  - 正常调用：进入 ACP 协议循环，读取 NDJSON 帧、回报会话能力、响应 `session/load`、`session/prompt` 等方法。
  - 带 `--acp-terminal-auth`：保持交互式 TUI，让用户完成 OAuth；登录完成后由 ACP 端重新 spawn。
- **何时使用**：编辑器/IDE 集成；自定义协议客户端。
- **不要**：把它当普通命令运行——不会有可见 stdout 输出。

参数：

- **共享全局选项**：与 `launch` 完全相同（`acp` 不再额外注册 `args`/`flags` 元数据）。`mode` 在 `acp` 下若显式传 `--mode acp` 是冗余的；`--mode text|json|rpc|rpc-ui` 会改变行为。
- **`--acp-terminal-auth`**（仅 `acp` 内部使用，源码 `modes/acp/terminal-auth.ts`）：当外部 ACP 客户端需要走本地 OAuth 但当前没有可用 token 时，把 `omp acp` 重新 spawn 为交互式 TUI 完成认证。出现该旗标时 `mode` 不再被强制为 `acp`，而回到默认（`text` 交互式）；同时 `--mode` 及其值会被从 argv 中剥离以避免污染。

示例：

```bash
# 由 ACP 客户端内部 spawn——不要在终端手敲
omp acp

# ACP 客户端第一次接入、缺少凭证时由客户端用以下形式重试
omp acp --acp-terminal-auth
```

注意：

- `omp acp` 的 stdio 完全被协议占用，运行后不会回到 shell 提示符；想中断请用 Ctrl+C 或由父进程发 SIGTERM。
- 与 `omp --mode acp` 等价，但保留 `omp acp` 是为了让编辑器在 spawn argv 里写得更清晰。
- `acp` 没有专属的「acp-only」旗标——它只是把 `mode` 钉死为 `acp` 并把会话托管给 `runAcpMode`。

### 共享全局选项（`launch` / `acp` 共用）

两个命令共用 `LAUNCH_FLAG_COMMANDS` 列出的旗标表，源码单一来源在 `cli-commands.ts` 加上 `cli/flag-tables.ts` 的 `STRING_SETTERS` / `OPTIONAL_FLAGS` / `VALUELESS_FLAGS`。下列按用途分组；每条注明**值/默认/互斥/风险**（在源码存在的前提下）。

#### 会话来源与位置

- **`messages…`**（位置参数，多次）
  - 效果：首轮提示词。`@<path>` 形式的 token 进入 `fileArgs`，按文件附件处理。
  - 注意：`-` 单独的连字符保留为「stdin 标记」，也被当成 message；`--` 之后所有 token 一律按字面 message，不再尝试解析旗标。
- **`--cwd <dir>`**（字符串）
  - 效果：覆盖本次启动的工作目录（不会改变 shell 当前目录）。
  - 风险：所给目录必须存在；不存在会以退出码非零失败。
- **`--add-dir <dir>`**（字符串，可重复）
  - 效果：把额外工作区目录加入本次会话的可见范围；可重复叠加。
- **`--config <path>`**（字符串，可重复）
  - 效果：额外加载一个 `config.yml`-风格覆盖层；多次叠加。
- **`--profile <name>`**（字符串）
  - 效果：使用隔离的 profile（独立 auth / sessions / settings / caches）。`--profile` 走前置 bootstrap，通常在 `parseArgs` 之前就被剥离。
- **`--alias <shell-name>`**（字符串）
  - 效果：给当前 `--profile` 生成一个 shell 快捷方式后退出，不会真正启动会话。
  - 典型用法：`omp --profile work --alias omp-work`，然后 `omp-work` 直接进 work profile。
- **`--allow-home`**（布尔）
  - 效果：允许直接在 `$HOME` 启动而不自动切到临时目录。**风险**：在 `~` 下运行容易把临时文件 / 缓存 / `.omp/` 写到 home 根，慎用。
- **`--no-session`**（布尔）
  - 效果：本次会话不落盘，结束即丢弃。
- **`--session-dir <dir>`**（字符串，默认 `$PI_CODING_AGENT_SESSION_DIR` 或默认会话目录）
  - 效果：自定义会话存储与查找路径。

#### 模型与推理

- **`--model <id>`**（字符串）
  - 效果：当前模型。模糊匹配接受 `"opus"`、`"gpt-5.2"`、`"openai/gpt-5.2"` 写法。
- **`--smol <id>`** / **`--slow <id>`** / **`--plan <id>`**（字符串；环境回退 `PI_SMOL_MODEL` / `PI_SLOW_MODEL` / `PI_PLAN_MODEL`）
  - 效果：分别钉死轻量 / 深度 / 计划阶段的模型；`--plan` 可被同名扩展旗标覆盖（`EXTENSION_SHADOWABLE_STRING_FLAGS`）。
- **`--provider <name>`**（字符串，遗留）
  - 效果：直接选择 provider。**首选 `--model`**，只在切换 provider 但模型名相同时才用。
- **`--api-key <key>`**（字符串）
  - 效果：覆盖环境变量提供的 API key；**风险**：命令行会出现在进程列表和 shell history，请改用环境变量。
- **`--provider-session-id <id>`**（字符串）
  - 效果：覆盖发送给 provider 的会话标识；本地会话文件仍使用自己的会话 ID。适合嵌入、代理或调试场景中复用 provider 侧会话上下文。
  - 风险：手工复用同一 ID 可能让 provider 将原本独立的请求视为同一会话；普通交互无需设置。
- **`--prompt-cache-key <key>`**（字符串）
  - 效果：显式指定 provider 侧 prompt cache key，使缓存身份与请求会话链分离。完整 fork 默认可以继承原会话的 cache key；传入此参数时以显式值为准。
  - 何时使用：只有在调用方明确管理 provider prompt cache、需要跨本地会话复用缓存时使用；普通用户应保留自动行为。
- **`--thinking <level>`**（枚举，源码 `CLI_THINKING_LEVELS`）
  - 效果：设置思考强度，例如 `low|medium|high|…`。
  - 风险：非法值只会打 warning，不会启动失败。
- **`--service-tier <tier>`**（枚举，OpenAI service tier 集）
  - 效果：OpenAI 专用，传 `none` 省略 `service_tier`。
  - 风险：非 OpenAI provider 会忽略；非法值会抛 `CliUsageError` 直接退出 2。
- **`--hide-thinking`**（布尔）
  - 效果：TUI 不显示思考块。**仅显示层面**，不会关闭模型思考，仍消耗 token。
- **`--advisor`**（布尔）
  - 效果：开启 advisor runtime，每轮被动审查并注入备注。
- **`--external-thinking`**（布尔）
  - 效果：使用私有 scratchpad 同时关闭 GPT/Claude/Gemini 推理通道。
  - **风险**：源码标注「providers have flagged this request shape as abuse」，可能触发限流或封号，慎用。
- **`--prewalk`** / **`--no-prewalk`** / **`--prewalk-into <id>`**（布尔 / 字符串）
  - 效果：plan 完成后第一次 edit/write 时切到轻量模型。`--prewalk-into` 改目标，默认 `smol` 角色。
  - 默认：关闭；`prewalk.enabled` 在 settings 中为真时自动开，`--no-prewalk` 强制关闭。
- **`--plan-yolo`** / **`--plan-yolo-into <id>`**（布尔 / 字符串）
  - 效果：开头强制只读 plan 模式，模型第一次 resolve 时自动批准，然后切到 `--plan-yolo-into` 指定的模型实现。
  - **风险**：第一次 resolve 后不再询问，谨慎选择触发时机。
- **`--models <a,b,c>`**（字符串，逗号分隔）
  - 效果：限制 TUI 内 Ctrl+P 循环切换的白名单。

#### 运行模式

- **`--mode <text|json|rpc|acp|rpc-ui>`**（枚举）
  - 效果：决定输出通道。`text` 走 TUI；`json` 输出 JSONL；`rpc` / `rpc-ui` 走内部 RPC 协议；`acp` 走 ACP 协议。
  - 互斥逻辑：`mode` 与 `--print` 同时给定时，`--print` 仅在 `mode` 未设时启用单次模式。
- **`--print` / `-p`**（布尔）
  - 效果：非交互模式：处理提示词、写 stdout、退出。`mode` 仍为 `text`，仅跳过 TUI。
- **`--max-time <duration>`**（字符串，支持 `600` / `10m` / `1h`）
  - 效果：到时强制结束会话。非法格式会抛 `CliUsageError`。
- **`--print-thoughts`**（布尔）
  - 效果：`--print` 输出里包含思考块。

#### 会话延续与恢复

- **`--continue` / `-c`**（布尔）
  - 效果：延续最近一次会话（最近一次成功保存的会话）。
  - **互斥**：`--resume` 显式给值时不走 `--continue`。
- **`--resume <id|path>`** / **`-r <id|path>`** / **`--session <id|path>`**（可选值字符串）
  - 效果：恢复指定会话。三种写法等价；接受会话 ID 前缀、`session.jsonl` 路径，或省略值进入选择器。
  - 不带值（`omp --resume`）：打开选择器，列出可恢复会话。
  - 风险：路径必须真实存在；ID 前缀歧义时报错而不是猜。
- **`--from-claude`** / **`--from-codex`**（布尔）
  - 效果：从 Claude Code / Codex 会话文件导入并以 OMP 继续。
  - 互斥：与 `--continue` / `--resume` 不要同时使用。

#### 工具 / 能力开关

- **`--tools <name1,name2,…>`**（字符串，逗号分隔）
  - 效果：白名单开启的工具集合；默认全部。
- **`--no-tools`**（布尔）
  - 效果：完全关闭内置工具（含只读工具）；与 `--tools` 互斥。
- **`--no-lsp`**（布尔）
  - 效果：禁用 LSP 工具、formatting、diagnostics。
- **`--no-pty`**（布尔）
  - 效果：禁用基于 PTY 的交互式 bash。
- **`--hide-thinking`**（布尔）：见「模型与推理」。
- **`--no-title`**（布尔）
  - 效果：关闭自动生成会话标题。
- **`--approval-mode <always-ask|write|yolo>`**（枚举）
  - 效果：覆盖 `tools.approvalMode`；非法值只警告。
- **`--auto-approve` / `--yolo`**（布尔）
  - 效果：跳过工具调用审批对话框。**风险**：模型可任意写文件 / 跑命令 / 发网络请求；只在受控环境使用。
- **`--system-prompt <text>`**（字符串）
  - 效果：完全替换默认系统提示。
- **`--append-system-prompt <text>`**（字符串）
  - 效果：把文本（或文件内容）追加到系统提示末尾。

#### 扩展 / 钩子 / 规则 / 技能

- **`--hook <path>`**（字符串，可重复）
  - 效果：加载钩子文件（多次叠加）。
- **`--extension <path>` / `-e <path>`**（字符串，可重复）
  - 效果：加载扩展文件。
- **`--trusted-extension <abs-path>`**（字符串，可重复）
  - 效果：与 `--extension` 等价，但跳过安全提示并赋予更高权限。
  - 约束：必须绝对路径、非空；**不能**与 `--extension` / `-e` / `--hook` 同用。
- **`--no-extensions`**（布尔）
  - 效果：关闭扩展发现；显式 `-e` 仍生效。
- **`--no-skills`** / **`--skills <glob,…>`**（布尔 / 字符串，逗号分隔 glob）
  - 效果：技能发现的总开关 + glob 白名单。
- **`--no-rules`**（布尔）
  - 效果：关闭规则发现加载。

#### 导出

- **`--export <session.jsonl>`**（字符串）
  - 效果：把指定会话文件渲染为 HTML 后退出；不进入 TUI 也不向模型发请求。

#### 帮助 / 版本

- **`--help` / `-h`**：打印帮助文本。
- **`--version` / `-v`**：打印版本。

#### 旗标通用语法

- 长选项两种写法：`--flag value` 或 `--flag=value`（`=value` 在 `parseArgs` 入口处会被拆成两个 argv 再走正常分支，因此行为等价）。
- 布尔旗标只需存在；重复 `--no-tools --no-tools` 与单次等价。
- 字符串旗标的下一个 token 即使以 `-` 开头也会被吞掉（`--system-prompt --profile work` 把 `--profile` 当字面提示词），唯一例外是 profile bootstrap 留下的内部哨兵 `--omp-profile-boundary`。
- 扩展旗标优先级高于同名内置旗标（`--plan` 在某些扩展下会变成布尔），所以扩展加载后同一个 token 含义可能改变。

### 实际差异与选用建议

- **想跑交互式 TUI**：`omp`（等价 `omp launch`），不传 `--print`、`--mode`。
- **想跑一次性提示词**：`omp -p "…"` 或 `omp --print "…"`。
- **想继续上次的会话**：`omp --continue "…"`；明确指定会话：`omp --resume <id-or-path>`。
- **想让 OMP 充当 IDE/编辑器的 Agent 后端**：`omp acp`（由 ACP 客户端内部 spawn，不建议手敲）。
- **想 ACP 客户端首次接入时让用户登录**：`omp acp --acp-terminal-auth`。
- **想给某组工作建独立 profile 并生成 shell 快捷方式**：`omp --profile work --alias omp-work`，以后 `omp-work` 直接进 work profile。
- **想批处理且结构化输出**：`omp --mode json`（JSONL）或 `omp --mode rpc`（内部 RPC）。

风险与坑：

- `omp acp` 会霸占 stdio 直至父进程终止，**不要在普通 shell 提示符下直接跑**。
- `omp --auto-approve` / `--yolo` 等价于授权模型任意执行工具调用，仅限隔离环境。
- `--api-key` 会进 argv 历史，**优先用环境变量**。
- `--external-thinking` 在源码中被标注为「providers have flagged this request shape as abuse」，可能触发限流。
- `--allow-home` 让 OMP 直接在 `$HOME` 下运行，可能污染 home 根目录。
- `omp <未注册顶级词> …` 会被改写为 `omp launch …` 并把整段 argv 当成 prompt 下发（`#4845`、`#2935`、`#1496`）；如需表达「把这段文本当 prompt」，请显式 `omp launch …`。

## 初始设置、认证与模型

### 场景导语

首次安装完 omp、给新机器配环境，或者要在多台机器之间共享凭据时，会集中碰到这一组命令。`setup` 跑首次配置向导并安装可选依赖（Python、语音），`config` 读取与修改 `~/.omp/config.yml` 中受 schema 约束的设置项，`models` 列出/搜索/刷新所有 provider 的可用模型，`auth-broker` 与 `auth-gateway` 在多机场景下集中托管 OAuth 刷新令牌，`tiny-models` 为本地标题生成与记忆任务下载可选的离线 ONNX 模型，`token` 把任意 provider 的 API key 或 OAuth 访问令牌打印到 stdout 供脚本使用。

### `omp setup`

启动交互式首次配置向导，或安装/检查 Python、语音两个可选子组件对应的依赖。

**语法**

```text
omp setup [component] [--check | -c] [--json]
```

**功能**

- 不带 `component`：要求 stdin/stdout 都是 TTY，调用根命令的 `forceSetupWizard` 路径重新拉起首次配置向导；非 TTY 直接报错退出。来源：`packages/coding-agent/src/commands/setup.ts`。
- 带 `component`：执行对应子组件的检查或安装；目前 `COMPONENTS` 只接受 `python` 和 `speech` 两个值，其它值在命令入口被 oclif-style 参数解析拒绝。

**何时使用**

- 第一次在机器上运行 omp，想走一遍引导（选默认模型、主题、是否启用语音等）。
- 想给当前项目开启 `%python` 工具箱、下载 STT/TTS 离线模型。
- 用脚本做健康探针（CI 镜像、容器构建后的烟雾测试）。

**参数**

- `component`（位置参数，可选）：`python` 或 `speech`。
  - `python` —— 让 omp 调用 `checkPythonSetup` 检查本机/项目的 Python 解释器是否可用，是否在 omp 管理的虚拟环境里。`--check` 模式下只检测，不安装子包；检测到未配置时直接返回非零退出。
  - `speech` —— 驱动 STT/TTS 一组 `SpeechComponent`，对每个组件执行 `isReady` / `status` / `ensure`；缺哪个模型就下载哪个，会用归一化的进度事件显示下载百分比。来源：`packages/coding-agent/src/cli/setup-cli.ts`。
- `-c, --check`：只读探针。`python` 打印解释器路径与是否在托管环境中；`speech` 打印每个组件就绪状态。不修改磁盘。
- `--json`：以 JSON 输出探针结果。`python` 在不可用时以非零状态退出（用于脚本判断）。`setup --check/--json` 必须带 `component`，否则抛 `CliUsageError`。

**示例**

```bash
# 重新拉起首次配置向导
omp setup

# 检查 Python 子组件是否就绪（不下载任何东西）
omp setup python --check

# 以 JSON 输出 Python 检测结果，便于脚本判别
omp setup python --json

# 准备语音子组件：缺少的 STT/TTS 模型会被下载
omp setup speech
```

**注意**

- `omp setup` 没有任何子组件参数时是向导模式，必须在交互式终端运行；通过 SSH/CI 用管道调用会立刻报错。
- 源码曾保留过自动安装 Python 子包的逻辑，但已删除；现在只做检测。需要 pandas/matplotlib 等可选库时，请直接用 pip 或 ipython 的 `%pip` 魔术命令。

### `omp config`

以 schema 为唯一事实源，对 `~/.omp/config.yml`（XDG 模式下对应 `config.yml`）中的受支持设置项执行查改。

**语法**

```text
omp config [action] [key] [value ...] [--json]
omp config init-xdg
```

**功能**

- 通过 `parseConfigArgs` 解析位置参数：第一个非 flag 位置参数是 `action`；第二个是 `key`；其余都是 `value`（用空格拼回）来源：`packages/coding-agent/src/commands/config.ts`、`packages/coding-agent/src/cli/config-cli.ts`。
- `action` 默认 `list`。可选值由 `ConfigAction` 联合固定：`list`、`get`、`set`、`reset`、`path`、`init-xdg`。
- `list` 按设置所在 tab（`config` 优先，其余按字典序）分组打印，每行显示 `key = value (type)`；带 `--json` 输出所有 key 的对象，其中被分类为 `credential` 且当前非空的值会被替换为 `{ redacted: true }` 而不是占位字符串。
- `get <key>` 打印单个值；带 `--json` 时输出 `{ key, value, type, description }`；未设置时打印 `(not set)`。`get` 不会主动脱敏——它是单值显式请求，由调用方自己负责不要把它粘到共享日志。
- `set <key> <value>` 调用 `parseAndSetValue` 走 schema 驱动的类型解析（见下表），然后 `settings.flush()` 写回磁盘。`--json` 输出 `{ key, value }`。
- `reset <key>` 把 `key` 还原为 schema 中的 `default` 并落盘。
- `path` 打印 `getAgentDir()`，即配置根目录。
- `init-xdg` 把当前配置迁移到 XDG Base Directory 布局（`$XDG_CONFIG_HOME/oh-my-pi/` 之类）。

**何时使用**

- 想在不打开 TUI 设置面板的情况下批量改 `theme`、`defaultThinkingLevel`、`compaction.enabled` 等。
- 在文档/脚本里给出"如何开启某项"的命令时。
- 需要把一个值回退到 schema 默认（用 `reset` 而不是手抄默认值）。

**参数**

- `action`（位置参数，可选）：见上方六个值。
- `key`（位置参数，依赖 action）：`get/set/reset` 必填；`list/path/init-xdg` 不接受。
- `value`（位置参数，依赖 action）：`set` 必填；`reset` 不接受；类型由 schema 决定：
  - `boolean`：接受 `true/false、yes/no、on/off、1/0`。
  - `number`：用 `Number()` 解析；非有限值报错。
  - `enum`：值必须落在 `getEnumValues(path)` 给出的清单内。
  - `array` / `record`：必须是合法 JSON；`providers.maxInFlightRequests` 会再走 `validateProviderMaxInFlightRequests`。
  - 其余视为 `string`。
- `--json`：所有 action 都支持；`list/get/set/reset` 的输出格式因 action 而异，`init-xdg/path` 不会因该 flag 改变行为。

**示例**

```bash
# 看所有可写设置
omp config list

# 切换主题并 JSON 化
omp config set theme catppuccin-mocha
omp config set theme catppuccin-mocha --json

# 关掉自动压缩
omp config set compaction.enabled false

# 重置输入模式为默认
omp config reset steeringMode

# 知道设置存在哪里
omp config path
```

**注意**

- 设置 key 必须是 `SETTINGS_SCHEMA` 中实际存在的 key；写错会打印 "Unknown setting"。
- 凭据类设置（如 `auth.broker.token`）只在 `list` 时被自动脱敏，`set` 仍是普通字符串落盘——CLI 默认不会把它额外加密，由 `secrets.md` 中描述的混淆机制处理。
- `init-xdg` 是迁移动作：执行前先备份原配置。

### `omp models`

列出/搜索/刷新由 provider registry 暴露的全部模型。内置 provider 加上扩展注册的 provider 都通过 `ModelRegistry` 暴露。

**语法**

```text
omp models [action | provider] [pattern] [--json] [-e <path> ...] [--no-extensions] [--config <overlay> ...]
```

**功能**

- `resolveModelsArgs` 把第一个非 flag 位置参数解析为 action 或 provider 过滤；已知 action 关键字有 `ls`、`list`、`find`、`refresh`，其它任何字符串（如 `openai-codex`）都会被当作 `ls` 的 provider/子串过滤，`omp models <provider>` 是 `ls` 的快捷方式。
- 第二个位置参数只对 `find` 有意义（搜索子串），对 `ls` 视作额外的过滤词。
- `ls`（默认）/ `find`：调用 `modelRegistry.refresh("online-if-uncached")` 拉取目录；缓存新鲜时直接复用，不打网络。
- `refresh`：强制走 `online` 路径，忽略 24 小时目录缓存。文档明确推荐用它代替 `rm -rf ~/.omp/models.db`，让新上线的 provider 模型立刻可见。来源：`packages/coding-agent/src/cli/models-cli.ts`。
- 输出：默认走 `renderProviderModels`，按 provider 分组，每个 provider 一张方框表，列包括 selector、context、max、reasoning、thinking 等级、输入模态、cost；`--json` 输出 `{ models: [...] }` 结构。
- 通过 `-e <path>` 显式加载扩展、配合 `--no-extensions` 关闭自动发现（issue #905）；通过 `--config <file>` 临时叠加 `config.yml` 风格的覆盖层。

**何时使用**

- 启动会话前确认某个 provider 当前支持哪些 model id（避免把废弃 id 写进脚本）。
- 新加的 provider 模型在 `ls` 里看不到时，用 `refresh` 强制刷新。
- 在 CI 中以 `--json` 形式抓取模型清单做白名单校验。

**参数**

- `action`（位置参数，可选）：`ls`（默认）/ `list` 同义，`find`，`refresh`。
- `pattern`（位置参数，可选）：`find` 必填，作为子串匹配 provider/id/name；`ls` 模式下是可选的额外过滤。
- `--json`：输出机器可读结构。
- `-e, --extension <path>`（可重复）：先于列表渲染加载的扩展文件，显式给出的路径在 `--no-extensions` 下仍生效。
- `--no-extensions`：禁用自动扩展发现；只加载 `-e` 显式给出的文件。
- `--config <file>`（可重复）：临时叠加 `config.yml` 风格覆盖，仅本次 `omp models` 进程生效。

**示例**

```bash
# 列出所有可用模型
omp models

# 只看 Anthropic 的模型
omp models anthropic

# 搜索名字/selector 包含 "minimax" 的模型
omp models find minimax

# 强制重拉目录
omp models refresh

# 给 CI 用的机器可读输出
omp models --json

# 只加载指定扩展，跳过自动发现
omp models --no-extensions -e ./local-ext.cjs
```

**注意**

- 隐藏/内部命令：内置的 `__complete`（shell 补全）走相同路由，但不在普通用户文档中列出。
- 第一次 `ls`/`find` 走 `online-if-uncached` 命中网络；如果 broker 模式未配置但网络不可达，会得到空目录；此时 `refresh` 也不会变出模型。

### `omp auth-broker`

管理 omp 凭据库（broker）——既是本地 SQLite 凭据库的"读 / 写 / 共享"通道，也是远端 broker 主机的运维入口。

**语法**

```text
omp auth-broker <serve|token|login|logout|import|migrate|status|list>
                [--json]
                [--bind <host:port> | -b <host:port>]
                [--regenerate]
                [--via <user@host>]
                [--provider <id>]
                [--include-disabled]
                [--include-env]
                [--include-oauth]
                [--from-local]
                [--dry-run]
                [<provider> | <file|dir>]
```

**功能**

子动作由 `AuthBrokerAction` 联合固定：

- `serve`：以 `DEFAULT_AUTH_BROKER_BIND`（默认 `127.0.0.1:8765`）为绑定地址，构造 broker；首次启动自动生成 `<config-dir>/auth-broker.token`（权限 0600，父目录 0700），并加载本地 SQLite 存储；安装 OAuth 刷新钩子，把 `refreshBrokerOAuthCredential` 接到 `AuthStorage` 的 `refreshOAuthCredential`。子进程会注册 SIGINT/SIGTERM 优雅关闭钩子并永久阻塞。来源：`packages/coding-agent/src/cli/auth-broker-cli.ts`。
- `token`：打印当前 bearer 令牌；`--regenerate` 用 `crypto.randomBytes(32).toString("base64url")` 生成新令牌写回令牌文件。
- `login [<provider>]`：在本地完成对应 provider 的 OAuth 流程。不传 `provider` 时进入交互式编号选择；`--via=user@host` 时通过 `ssh -L <callback-port>:127.0.0.1:<callback-port>` 把 OAuth 回调隧道到本机浏览器，但凭据仍写到 broker 主机。
- `logout [<provider>]`：删除该 provider 下的所有凭据行；不传 `provider` 时从已存储 provider 列表中交互选择。
- `import <file|dir>`：把 CLIProxyAPI 风格的 JSON 凭据导入到 broker 的 SQLite 存储；按 JSON 内 `type` 字段映射 provider id（`claude → anthropic`、`codex → openai-codex`、`gemini → google-gemini-cli`、`antigravity → google-antigravity`、`gemini-cli → google-gemini-cli`），文件名为 `claude-foo@bar.json` 时也参与判定。`--provider <id>` 覆盖映射；`--include-disabled` 保留 `disabled: true` 的行；`--dry-run` 只打印计划；配置了 broker URL 时改走 `client.uploadCredential()` 上传到远端。
- `migrate --from-local [--include-env] [--include-oauth] [--dry-run]`：把本地 SQLite +（可选）env API key 上传到已配置的远端 broker；`--include-oauth` 同时上传本地 OAuth（默认跳过）；`--include-env` 捕获 env 中的 API key（默认跳过）。broker 端已有同样身份（按 `credentialIdentity` 比对）则跳过，实现幂等。
- `status`：对已配置远端 broker 跑 `/v1/healthz`；没配置时报 "No auth-broker configured"。
- `list`：枚举所有已注册 OAuth provider（内置 + 扩展注册），`--json` 给出机器可读数组。

**何时使用**

- 第一次搭建 broker 主机：跑 `serve` 启动 daemon，用 `token` 拿令牌给客户端用。
- 笔记本本地登录某个 provider：`omp auth-broker login anthropic`；远程 broker 想登录：在笔记本上跑 `omp auth-broker login anthropic --via=broker-host`。
- 把 CLIProxyAPI 的 JSON 目录导入 broker：`omp auth-broker import ~/.cliproxy/auth`。
- 把单台机器上已有的本地凭据一次性同步到 broker：`omp auth-broker migrate --from-local --include-env`。
- 怀疑凭据过期或被人偷走时：`omp auth-broker token --regenerate` 轮换令牌。

**参数**

- `action`（位置参数，可选）：见上方列表。不传时打印命令帮助（不进入向导）。
- `source`（位置参数，依赖 action）：`login`/`logout` 是 provider id；`import` 是文件或目录路径；`~` 会展开。
- `--json`：所有动作的机器可读输出。
- `-b, --bind <host:port>`：仅 `serve` 生效，覆盖默认绑定。
- `--regenerate`：仅 `token` 生效，轮换令牌。
- `--via <user@host>`：仅 `login` 生效，必须同时传 `<provider>`。
- `--provider <id>`：`import` 时强制覆盖 provider 映射；`login`/`logout` 时也可通过它传 provider（与位置参数互斥）。
- `--include-disabled`：`import` 保留 `disabled: true` 的凭据。
- `--from-local`：`migrate` 必填，指定从本地 SQLite + env 迁移。
- `--include-env`：`migrate` 同时捕获 env 中的 API key。
- `--include-oauth`：`migrate` 同时上传本地 OAuth（默认跳过）。
- `--dry-run`：`import` / `login --via` / `migrate` 只打印计划不执行；`import` 还会跑一份 JSON plan 输出。

**示例**

```bash
# 启动 broker（默认绑定 127.0.0.1:8765）
omp auth-broker serve

# 改端口
omp auth-broker serve --bind=127.0.0.1:9000

# 看/轮换令牌
omp auth-broker token
omp auth-broker token --regenerate

# 本地登录 Anthropic
omp auth-broker login anthropic

# 远程 broker 上登录
omp auth-broker login anthropic --via=user@broker

# 登出
omp auth-broker logout anthropic

# 导入 CLIProxyAPI 的目录（强制 provider 映射）
omp auth-broker import ~/.cliproxy/auth
omp auth-broker import ./claude-foo.json --provider anthropic

# 迁移本地凭据到 broker
omp auth-broker migrate --from-local --include-env
omp auth-broker migrate --from-local --include-env --dry-run

# 健康检查
omp auth-broker status
omp auth-broker status --json
```

**注意**

- 隐藏/内部命令：`serve` 在文档化"运行时服务"语境下属于内部命令，普通用户应通过 systemd / launchd / 容器 supervisor 管理；不推荐手动前台 `serve` 之后用 Ctrl-C 反复重启。
- `migrate` 必须先在环境里或 `config.yml` 配好 `OMP_AUTH_BROKER_URL` / `auth.broker.url`，否则直接报错。
- OAuth callback 端口表是硬编码在 `CALLBACK_PORTS` 中的：`anthropic:54545`、`openai-codex:1455`、`google-gemini-cli:8085`、`google-antigravity:51121`、`gitlab-duo:8080`、`devin:59653`、`gitlab-duo-agent:8080`、`zai-coding-plan:54548`。`--via` 远程登录只能用于这些 provider 之一。
- 完整端点、用法、`OMP_AUTH_BROKER_*` 环境变量解析顺序见 `docs-zh-CN/auth-broker-gateway.md`。

### `omp auth-gateway`

跑一个 OpenAI / Anthropic / Responses / pi-native 兼容的正向代理，让容器化的 omp、macOS 用量小组件等不可信客户端无需直接拿到访问令牌。

**语法**

```text
omp auth-gateway <serve|token|status|check>
                 [--json]
                 [--bind <host:port> | -b <host:port>]
                 [--regenerate]
                 [--no-auth]
                 [--strict]
```

**功能**

- `serve`：要求已配置 broker（`OMP_AUTH_BROKER_URL` 或 `config.yml` 的 `auth.broker.url`），通过 `AuthBrokerClient.fetchSnapshot()` 拿一份脱敏 snapshot，包装成 `RemoteAuthCredentialStore`，然后以 `DEFAULT_AUTH_GATEWAY_BIND`（默认 `127.0.0.1:4000`）绑定 HTTP。每 15 分钟后台重建一次模型目录（`unref()`，不延长进程寿命），让运行期发现的新 provider 立刻可路由。`--bind` 改地址；`--no-auth` 跳过 bearer 校验（仅限 loopback）。来源：`packages/coding-agent/src/cli/auth-gateway-cli.ts`。
- `token`：打印 / 轮换 gateway 自己的 bearer 令牌（`<config-dir>/auth-gateway.token`，0600）。
- `status`：把本地 token 与 broker 连通性合并报告，输出 `ready / not ready / FAILED` 与对应 token 文件路径。`--json` 给机器可读视图。
- `check`：通过 broker 拉来的 `RemoteAuthCredentialStore` 探测每个凭据。默认仅走 provider 的 usage 探针；`--strict` 同时对每个凭据跑一次真实 chat-completion 请求（最坏会消耗少量配额）。`--json` 给出每条凭据的 `ok / reason / completion` 详情。

**何时使用**

- 在多机环境里给容器/小工具统一提供 OpenAI/Anthropic 兼容端点，无需分发访问令牌。
- 排查 "broker 里明明有凭据，但客户端始终 401" 这类问题：`omp auth-gateway check --strict` 能定位到具体哪个凭据坏了。
- 定期给 `serve` 做健康巡检：`status` 返回 `ready` + credential count 即可。

**参数**

- `action`（位置参数，可选）：`serve` / `token` / `status` / `check`。不传时打印帮助。
- `--json`：`token` / `status` / `check` 支持机器可读输出。
- `-b, --bind <host:port>`：仅 `serve` 生效。
- `--regenerate`：仅 `token` 生效，轮换 gateway 自身的令牌。
- `--no-auth`：仅 `serve` 生效，禁用入站 bearer 校验；只在绑定 loopback 时使用。
- `--strict`：仅 `check` 生效，额外触发每个凭据的 chat-completion 探针。

**示例**

```bash
# 启动 gateway（默认 127.0.0.1:4000，需要先配 broker）
omp auth-gateway serve

# 改端口
omp auth-gateway serve --bind=127.0.0.1:4000

# 拿 / 轮换 gateway bearer 令牌
omp auth-gateway token
omp auth-gateway token --regenerate

# 信任 loopback，不强校验 bearer
omp auth-gateway serve --no-auth

# 健康自检
omp auth-gateway status
omp auth-gateway check
omp auth-gateway check --strict
omp auth-gateway check --json
```

**注意**

- 隐藏/内部命令：`serve` 是常驻服务，应由 systemd / launchd / k8s 监管；不推荐手工前台跑。
- gateway 没有专属环境变量——它本身是 broker 客户端，broker 的 `OMP_AUTH_BROKER_URL` / `OMP_AUTH_BROKER_TOKEN` 必须先就位。
- `--strict` 会真实发请求消耗配额；排查失败原因时再开，不要在巡检脚本里每分钟跑。
- gateway 进程不接受 `models.yml` 中的 `apiKey` 覆盖（`ignoreLocalModelConfig: true`），broker 解析的凭据始终是事实源。

### `omp tiny-models`

下载并管理本地 ONNX 形态的轻量模型，供 session 标题生成、Mnemopi 记忆任务、本地 auto thinking 分类器等使用（`online` 路径不需要本地模型）。

**语法**

```text
omp tiny-models [download] [<model> | all] [--json]
omp tiny-models list [--json]
```

**功能**

- `download`（默认）：调用 `resolveModels` 把 `<model>` 解析成 `TinyLocalModelKey[]`，逐个走 `tinyTitleClient.downloadModel()`。`all` 会跳过 `unsupportedReason` 标记的项（避免在不支持的运行时下批量失败）。
  - 不传 `<model>`：下载默认 `DEFAULT_TINY_TITLE_LOCAL_MODEL_KEY`（`lfm2-700m`），与 session 标题默认（`ONLINE_TINY_TITLE_MODEL_KEY = "online"`）是分开的两件事。
  - TTY 模式显示 `[████░░] 60% 80MB/135MB filename` 进度条；非 TTY 一行打印 `Downloading …`；`--json` 抑制所有进度，结束后输出 `{ results: [...] }`。
- `list`：枚举当前编译进二进制的全部本地模型（标题 + 记忆），并把默认的 `lfm2-700m` 标 `default`。`--json` 输出 `{ models: [...] }`。
- 失败时 `downloadErrorSummary` 抽取 `PI_TINY_/CUDA/cuDNN/cudnn/onnxruntime-node` 等提示性行，帮助定位 onnxruntime 相关问题。
- 来源：`packages/coding-agent/src/commands/tiny-models.ts`、`packages/coding-agent/src/cli/tiny-models-cli.ts`、`packages/coding-agent/src/tiny/models.ts`。

**何时使用**

- 想完全离线生成 session 标题，避免每条新会话都打远端 smol 路径。
- Mnemopi 本地记忆后端、auto thinking 分类器想用本地模型时，先 `tiny-models list` 看清单，再 `tiny-models download <key>` 拉。
- 一次性预热：CI 镜像里 `tiny-models download all` 把所有可用的本地模型准备好。

**参数**

- `action`（位置参数，可选）：`download`（默认）/ `list`。
- `model`（位置参数，依赖 action）：单 key 时校验是否在 `TINY_LOCAL_MODELS` 中（涵盖 title 与 memory 两个集合）；`all` 表示预取所有当前运行时可用的模型；`list` 不接受。
- `--json`：所有 action 支持；进度抑制并改为结构化输出。

**示例**

```bash
# 拉默认标题模型（lfm2-700m）
omp tiny-models

# 列出全部本地模型
omp tiny-models list

# 拉一个特定的记忆模型
omp tiny-models download lfm2-1.2b

# 一次性预热所有可用本地模型
omp tiny-models download all

# 脚本里只关心是否成功
omp tiny-models download all --json
```

**注意**

- 实际可下载的 key 受 `TINY_LOCAL_MODELS` 控制，当前包含 `lfm2-350m`、`qwen3-0.6b`、`gemma-270m`、`qwen2.5-0.5b`、`lfm2-700m`（标题）与 `llama3.2:3b`、`gemma-3-1b`、`qwen2.5-1.5b`、`lfm2-1.2b`（记忆）。`qwen3-1.7b` 在源中带 `unsupportedReason`（onnxruntime-node 不支持其 RotaryEmbedding 路径），`all` 模式会主动跳过它。
- 下载失败时，提示里如果出现 `libcudnn` / `onnxruntime-node` 等关键字，多半是运行时依赖问题，与模型本身无关。
- 隐藏/内部命令：这一族 `tinyTitleClient.downloadModel` 协议属于 `tiny/title-protocol` 内部通道，不推荐绕过 CLI 直接调用。

### `omp token`

把任意 provider 的 API key 或 OAuth 访问令牌打印到 stdout，供其它工具注入到环境变量、HTTP 头、CI secret 中。

**语法**

```text
omp token <provider> [--raw] [--force-refresh] [-a <N>] [-l] [--json]
```

**功能**

- 不带 `--list` / `--account`：通过 `ModelRegistry.getApiKeyForProvider` 解析当前 provider 的凭据。
  - 默认情况下，若该凭据是 JSON 字符串且包含顶层 `token` 字段，会自动解出 `token` 字段；这是为了兼顾 Copilot 这种把 `access_token` 包在 JSON 内的 provider。
  - `--raw` 跳过这个解 JSON 步骤，原样输出存储的字符串。
  - `--force-refresh` 强制刷新 OAuth 凭据，不看它是否接近过期；过期/无效时再试一次常常能恢复。
  - 对 `perplexity` provider 走专用 `getAvailableAuthMethods` 路径，优先返回 OAuth access token。
- `--list` / `-l`：列出该 provider 存储的所有 OAuth 账户（`1. email (org)` 形式）。
- `--account N` / `-a N`：在 `--list` 输出去选择第 N 个账户的访问令牌；`--list` / `--account` 与默认路径互斥。
- 没有找到凭据时：在 stderr 打印红色错误、列出当前已配置的 provider、`process.exitCode = 1`。

**何时使用**

- 在 shell 脚本里把凭据塞进 `Authorization: Bearer`：例如 `export BEARER=$(omp token anthropic)`。
- 给 `curl` 这种外部工具用原始 JSON：`omp token github-copilot --raw`。
- 多个 Anthropic 账号共存时，列出后挑指定的那一个：`omp token anthropic --list` → `omp token anthropic --account 2`。
- OAuth 即将过期时强制续约：`omp token google-gemini-cli --force-refresh`。

**参数**

- `provider`（位置参数，必填）：`PROVIDER_REGISTRY` 中的 id，例 `anthropic`、`openai`、`openai-codex`、`github-copilot`、`google-gemini-cli`、`perplexity` 等。大小写不敏感。
- `--raw`：保留凭据原始字符串，不解顶层 JSON。
- `--force-refresh`：OAuth 路径下强制刷新，忽略 `expiresAt`。
- `-a, --account <N>`：1-based 选择第 N 个 OAuth 账户。
- `-l, --list`：列出 provider 的所有 OAuth 账户。
- `--json`：当前 `token` 子命令未直接消费 `--json`（以 stdout 文本为主），脚本里直接 capture stdout 即可。

**示例**

```bash
# 拿 Anthropic 的 API key
omp token anthropic

# 拿 GitHub Copilot 的原始 JSON 凭据
omp token github-copilot --raw

# 强制刷新 Gemini CLI 的 OAuth 访问令牌
omp token google-gemini-cli --force-refresh

# 列出 Anthropic 的所有 OAuth 账号
omp token anthropic --list

# 拿第 2 个 Anthropic OAuth 账号的访问令牌
omp token anthropic --account 2
```

**注意**

- 隐藏/内部命令：`--list` / `--account` 只对 OAuth 类型的凭据有效；纯 API key 走 `ModelRegistry` 默认路径，行为退化成"取唯一凭据"。
- 把输出再回填到 shell 历史可能泄漏令牌；建议通过 `omp token ... | read -s TOKEN` 或类似机制接收，或使用 `OMP_AUTH_BROKER_TOKEN` 这种机制避免在 shell 历史中留下凭据。
- 对凭据的存储位置（本地 SQLite / 远端 broker）透明；broker 模式下走 `RemoteAuthCredentialStore`，会自动处理 refresh 后再返回。

## Agent、会话协作与工作树

本主题涉及 agent 配置导出、共享协作会话接入、由 daemon-broker 监管的后台进程、以及 agent 在隔离任务中产生的 git worktree 清理。除 `wt`（`worktree` 的别名）外，这四个命令没有其它内置别名。

## 概览

| 命令 | 别名 | 主要场景 | 是否修改工作区/协作状态 |
| --- | --- | --- | --- |
| `omp agents` | 无 | 导出内置 agent 定义到磁盘，便于检视、定制或纳入版本控制 | 是（写文件到用户/项目目录） |
| `omp join` | 无 | 拿到 host 通过 `/collab` 分享的链接后，从 CLI 一键启动 TUI 并立刻加入协作会话 | 是（启动 TUI 进程并接入远端房间） |
| `omp ps` | 无 | 列出/查看/日志/停止/杀死/重启由 daemon-broker 监管的后台进程 | 是（`stop`/`kill`/`restart` 会影响进程） |
| `omp worktree` | `wt` | 列出或清理 `~/.omp/wt` 下的 agent 工作树 | 是（`clear` 会删除目录） |

## `omp agents`

管理内置（bundled）task agent 定义。当前仅暴露一个子动作 `unpack`，作用是把内置 agent 序列化到磁盘，便于人工审阅、二次编辑或提交到仓库。`runAgentsCommand` 内仅实现了 `unpack` 分支；不带子动作直接执行 `omp agents` 会渲染帮助文本。

### 语法

```text
omp agents [action] [flags]
```

可选的 `action` 只有一个：

- `unpack`：将内置 agent 全部写到目标目录（每个 agent 一个 `<name>.md` 文件，包含 YAML frontmatter 与系统提示正文）。无子动作时打印帮助。

### 标志

| 标志 | 简写 | 行为 | 风险/互斥 |
| --- | --- | --- | --- |
| `--force` | `-f` | 覆盖已存在的同名 agent 文件；缺省时遇到同名文件会跳过（计入 `skipped`） | 会静默覆盖任何手工修改；建议先备份 |
| `--json` | 无 | 以 JSON 形式输出 `{ targetDir, total, written, skipped }` 结果 | 适合脚本流水线 |
| `--dir <path>` | 无 | 指定自定义输出目录（相对路径会基于 `getProjectDir()` 解析为绝对路径） | 覆盖 `--user`/`--project` 的默认选择 |
| `--user` | 无 | 写入 `~/.omp/agent/agents`（默认行为，即使不传） | 与 `--project` 互斥；同传会抛 `Choose either --user or --project, not both.` |
| `--project` | 无 | 写入当前项目的 `./.omp/agents` | 与 `--user` 互斥；同传会抛错；适合随项目提交 |

子动作仅 `unpack`；不传时不会触发任何写入，仅显示 `omp agents` 的帮助说明。

### 示例

```bash
# 把所有内置 agent 导出到用户级目录（默认）
omp agents unpack

# 导出到项目目录，方便纳入版本控制
omp agents unpack --project

# 强制覆盖已有文件
omp agents unpack --project --force

# 输出到临时目录并以 JSON 形式给出写入结果
omp agents unpack --dir ./tmp/agents --json
```

### 注意

- 写入内容是 YAML frontmatter（`name`、`description`、`tools`、`spawns`、`model`、`thinkingLevel`、`output`、`blocking`）+ 系统提示正文；可用文本编辑器直接修改后由 `omp` 重新加载。
- 默认目录遵循 `getAgentDir()`（即 `~/.omp/agent`，profile-scoped）；`--project` 模式写入项目根下的 `./.omp/agents`，适合把定制版 agent 跟随仓库分发。
- `--user` 与 `--project` 同时传入会被 `resolveTargetDir` 直接拒绝（抛错退出），不会写盘。

## `omp join`

从命令行加入一个共享的 collab 会话。语义上等价于在 TUI 内手动执行 `/join <link>`：本命令只是把 link 注入到根命令参数并启动交互式 TUI，**自身不会**完成任何加密握手。链接由 host 通过 `/collab` 产生，包含 `relay` URL、房间 id 与 `#` 后的密钥（密钥仅存在于 URL 片段，relay 看不到明文）。

### 语法

```text
omp join <link>
```

参数：

- `<link>`（必填，位置参数）：host 通过 `/colcollab` 分享的 collab 链接，形如 `relay.example.sh/abc123#key`（带写权限时密钥后还会附 write token）。

### 前置条件与错误

- **必须**在交互式终端内运行：`process.stdin.isTTY` 与 `process.stdout.isTTY` 缺一即打印 `<APP> join requires an interactive terminal` 并以退出码 1 返回。
- 缺 link 或 link 仅含空白时，打印 `Usage: <APP> join <link>` 并以退出码 1 返回；该检查在 TTY 检查之前。
- 不接受任何 flag；任何额外参数会被解析器报错。

### 执行效果

`Join.run()` 调用 `parseArgs([])` 构造一份空白 root 配置，将 `parsed.join = link` 注入，然后 `runRootCommand` 启动 TUI。TUI 在初始化阶段读取 `ctx.join` 并把链接交给 `CollabGuestLink`：

- 解码 URL，得到 `wss://relay/...`、房间 id 与 AES-GCM 密钥；
- 通过 `CollabSocket` 建立 WebSocket（指数退避重连，断线后 30s per-chunk 超时）；
- 收到 `welcome` 帧后落地 host 的会话快照（`/resume` 流程），再应用 `snapshot-chunk` 与后续 live 帧（事件、`session-entry`、`state`、`ui-request` 等）；
- 状态行显示 `⇄ collab guest:<n>`，Agent Hub 表格与 transcript viewer 切换到 host 镜像模式。

### 适用场景

- 同事发来一个 `/collab` 链接，不想（或不能）进入交互式 prompt 后再敲 `/join`；
- 在脚本/远程终端里快速跳入某个 host 的会话（前提是目标环境提供 TTY）；
- 受邀进入只读观察模式（链接中不附 write token 时，guest 输入框会被禁用，本地 slash/`!`/python 命令被 status 拒绝为 host-only）。

### 示例

```bash
omp join "relay.example.sh/abc123#key"
```

### 注意

- 链接中的 `#key`（含可选的 write token）相当于共享 secret；转发链接即授权他人以对应权限加入房间，谨慎投递。
- guest 端在 collab 会话中**不会**保留本机修改副本：本地 prompt 走 `ctx.collabGuest.sendPrompt` 转发到 host，本地的 `/dump`、`/export`、`/copy`、`/leave`、`/collab`、`/exit`/`/quit` 之外的 slash 命令会被 TUI 提示 host-only。
- 退出 collab 后会恢复到链接之前的本地会话（如果有）。

## `omp ps`

查看并控制由 daemon-broker 监管的后台进程。`omp` 在 `launch`/服务化场景下会把长寿命进程登记到项目级或机器全局的 broker，`omp ps` 是从外部 CLI 触达这个 broker 的官方入口。

### 语法

```text
omp ps [action] [name] [flags]
```

子动作：

- `list`（默认）：列出当前项目 scope 下的所有进程；带 `--all` 时合并其它项目与机器全局 scope。
- `info <name>`：打印单个进程的元数据（command、cwd、uptime、restarts、pty/persist/detached/owner 等），`--json` 时输出完整 JSON。
- `logs <name>`：读取日志尾部（默认 100 行，最大 1000）；`--follow` 进入持续 tail 模式，进程进入终态后自动退出。
- `stop <name>`：请求 broker 优雅停止（默认 5 秒宽限期，可由 `--timeout` 覆盖），超时后 broker 强杀。
- `kill <name>`：立即发送终止信号（使用 broker 内置的 `KILL_GRACE_MS`，不读 `--timeout`），适用于 stop 失败后兜底。
- `restart <name>`：请求 broker 重新拉起进程（沿用其注册时的 spec）。

### 参数

- `action`（可选位置参数，枚举）：不传时默认 `list`。
- `name`（可选位置参数）：除 `list` 外的所有动作都需要；缺省时打印 `<action> requires a process name. Run \`omp ps\` to list processes.`，退出码 1。

### 标志

| 标志 | 简写 | 作用动作 | 说明 |
| --- | --- | --- | --- |
| `--all` | `-a` | `list` | 同时扫描其它项目目录与机器全局 service scope（如 `browser-relay`）；不带时只显示当前项目 scope，并在末尾提示 `Use --all to include other projects and global services.` |
| `--json` | `-j` | `list`/`info`/`logs`/`stop`/`kill`/`restart` | 全部以 JSON 输出，便于脚本消费 |
| `--plain` | 无 | `list` | 强制静态表格输出，跳过交互式 monitor（`runPsTop`）；与 TTY 不可用或想直接 pipe 一起使用 |
| `--dir <path>` | 无 | 除 `list`（隐式作用于当前项目）外所有 | 把目标项目目录指向另一处，broker 客户端按该目录连接；与 `--global` 互斥思路（后者覆盖到全局 scope） |
| `--global <service>` | 无 | 所有命名动作 | 切到机器全局 service scope（典型例子：`omp ps info relay --global browser-relay`） |
| `--follow` | `-f` | `logs` | 持续输出新日志，每 30s 滚动一次 1000 行尾窗；进程进入终态自动退出 |
| `--head` | 无 | `logs` | 从日志开头读取（默认从尾部回看） |
| `--lines <n>` | `-n` | `logs` | 读取行数，整数；超出 `[1, 1000]` 会被夹到该区间 |
| `--grep <regex>` | 无 | `logs` | 把 regex 过滤交给 broker，命中行才在 client 渲染 |
| `--timeout <seconds>` | 无 | `stop` | 优雅停止的宽限期（秒），缺省 5；`kill` 不读此值 |

### 静态列表与交互式 monitor

`list` 在 TTY 下默认进入 `runPsTop` 交互式 monitor（红/绿指示终端态进程），带 `--plain` 或 `--json`、或 stdin/stdout 任意一端不是 TTY 时退回静态表格 `printTable`，表格按终端宽度做截断。

### 适用场景

- 看到 `launch` 工具在跑某个 dev server，需要查看它是否仍存活、是否反复重启；
- 某个项目常驻进程泄漏后想从外部停掉并立即重启，不必进 TUI；
- 调试 `browser-relay` 等机器级服务（`omp ps info relay --global browser-relay`）；
- 收集脚本需要结构化输出（`--json`）。

### 示例

```bash
# 当前项目下所有 broker 进程（交互式 monitor）
omp ps

# 含其他项目 + 机器全局 scope 的静态表
omp ps --all --plain

# 持续 tail 某个进程的日志
omp ps logs web --follow

# 优雅停止一个进程（5 秒宽限）
omp ps stop web

# 兜底强杀
omp ps kill web

# 重启 + 机器全局服务信息
omp ps restart web
omp ps info relay --global browser-relay
```

### 注意

- `stop`/`kill`/`restart` 通过 daemon-broker 转发，broker 在 reload/persist 模式下会保留策略；这些动作**会**对受监管进程产生实际副作用（停止信号、SIGKILL 或重新 spawn）。
- 退出码：`--json` 模式下部分失败会置 `process.exitCode = 1` 并在 JSON 末尾统计 `failed` 字段；非 JSON 模式同理。
- `list` 不需要 `name`；其它子动作缺 `name` 会被明确拒绝并给出提示，不会退回到 `list`。

## `omp worktree`（别名 `wt`）

枚举并清理 agent 在隔离任务中产生的 git worktree。所有 worktree 都集中在 `~/.omp/wt`（可被 `worktree.base` 配置或 `OMP_WORKTREE_DIR` 环境变量改写），两类来源：

- `pr-checkout`：`tools/gh.ts` 通过 `git worktree add` 拉取的 PR checkout，目录里包含一个指向父仓库 `<parent-repo>/.git/worktrees/<name>/` 的 `.git` 文件；
- `task-isolation`：`task/worktree.ts` 创建的隔离沙箱，含 `m` 或 `merged` 挂载子目录，或通过 `ISOLATION_OWNER_FILE` 所有权标记识别。沙箱的 owner 仍存活时打 `live`，否则 `orphan`（计入 `clear` 默认清理目标）。

### 语法

```text
omp worktree [action] [flags]
omp wt [action] [flags]
```

子动作：

- `list`（默认）：扫描 `getWorktreesDir()`，按 `live` / `orphaned` 标签打印每条记录，并统计 `live · orphaned · total`；
- `clear`：删除可回收的条目；不带 `--all` 时**仅**删除 `orphaned`（`orphanReason` 不为空）的条目，避免误删仍在使用的 PR checkout。

### 标志

| 标志 | 简写 | 作用动作 | 说明 |
| --- | --- | --- | --- |
| `--all` | 无 | `clear` | 一并删除**仍存活**的 PR-checkout worktree（包括 task-isolation 沙箱）；不带时只清 `orphaned` |
| `--dry-run` | `-n` | `clear` | 仅打印将被删除的路径与数量，不落盘；与 `--json` 组合输出 `{ wouldRemove: [...] }` |
| `--json` | `-j` | `list`/`clear` | `list` 输出原始 entries 数组；`clear` 输出 `{ removed, failed, results }` |

### 状态变化与适用场景

- `list` 是只读扫描，会先 `Settings.init({ cwd: getProjectDir() })`，确保 `worktree.base` 在 `getWorktreesDir()` 解析前生效——否则会和 agent 写入的实际 base 错位。
- `clear` 对每条目标执行下列其中之一：
  - 活 PR-checkout：先调用 `git.worktree.tryRemove(parentRepo, target, { force: true })`；git 拒绝时回退到 `fs.rm` 强删，再在父仓库上 `worktree prune` 清理 `.git/worktrees/<name>/` 注册；
  - 其它情况（orphan、stray、empty、task-isolation）：`fs.rm` 强删，必要时同样 prune 父仓库。
- 删除失败不会被中断；每条 result 都计入 JSON/控制台输出，失败总数 > 0 时退出码置 1。
- 进程仍在跑的 task-isolation 沙箱（owner 存活）会被标 `live`，**`clear` 默认不删**；只有 `--all` 才会触碰它们——`--all` 风险：可能让正在跑任务的子 agent 失去工作树。

### 示例

```bash
# 看一眼当前 worktree 状态
omp worktree
omp wt list --json

# 仅清理 crash/stray 留下的孤儿
omp worktree clear
omp worktree clear --dry-run

# 连活的 PR-checkout/沙箱也一起删（风险：可能影响运行中的子 agent）
omp worktree clear --all
```

### 注意

- 命令**始终**扫描并优先使用 `worktree.base` / `OMP_WORKTREE_DIR` 覆盖的目录；不会落到 `~/.omp/wt` 默认目录去清理别处产生的 worktree。
- 内部 `--dry-run` 不依赖 git，仅根据 `scanWorktrees` 的分类结果告诉你哪些路径会被删；删之前先跑一次。
- `clear` 的 `--all` 不是“默认行为”——`worktree` 风险决策在用户；该子动作配合 `--all` 等于授权清场，请确认没有 `live` 任务正在使用这些 worktree。
- 内部命令：直接调用 `cli/worktree-cli.ts` 的 `listWorktrees` / `clearWorktrees` 不应替代 CLI 入口；该模块只暴露给 `omp worktree` 命令与测试，由 `Settings.init` 负责 base 解析的一致性。

## 何时用哪条命令

- 想“另存一份”内置 agent 定义来改/审阅/提交 → `omp agents unpack [--project|--dir] [--force]`。
- 收到同事发来的 `/collab` 链接，希望一键进入 TUI 加入会话 → `omp join "<link>"`。
- 想知道某个长寿命进程还活着吗、想看/追日志、想停/杀/重启它 → `omp ps`（`list`/`info`/`logs`/`stop`/`kill`/`restart`）。
- 看到 `~/.omp/wt` 越攒越多、或怀疑残留 worktree 占空间 → `omp worktree list` 看一下，`omp worktree clear`（必要时 `--all`）清掉。

## 文件、代码搜索与 Git 操作

### `omp read` — 预览 read 工具会返回的内容

当你只想知道“某个路径、URL 或内部 URI 如果被模型读入会看到什么”，而不想真正打开交互界面时，用 `omp read`。它在 shell 端直接调用 `ReadTool`（与 Agent 在 `read` 工具调用里执行的是同一份代码），把内容块原样打到 stdout，文本块逐字打印、图像块以 `[image content: <mime>, <N> bytes base64-decoded]` 这样的占位行替代，因此是只读、不会写入仓库。命令不会修改任何文件、不会写入日志、不会启动会话，只是离线调用一个工具；首次运行仍会读取 `Settings` 并按路径 URI 决定是否触发 MCP 发现（`mcp://` 总是会，非内建协议且未注册处理器时也会）。整条命令完成后会 `process.exit(1)` 反映工具执行失败的情况。

```bash
omp read <path|url|uri>
```

**功能/效果**

- 用与 Agent `read` 工具完全一致的实现读取一个目标，并把模型将看到的内容块原样输出。
- 文本块写到 stdout（自动补一个换行），图像块写成 `[image content: <mime>, <N> bytes base64-decoded]` 这一行占位。
- 对 MCP 资源 URI（`mcp://…`）会自动发现并加载 MCP 工具集，然后按 `mcp://` handler 返回内容。
- 失败时把错误（带样式）写到 stderr 并以非零码退出；成功静默退出 0。

**何时使用**

- 在没有 TTY 的脚本/管道里验证某个文件、URL、`omp://`、`issue://`、`pr://`、`history://` 等内部 URI 现在的内容。
- 在把一个路径喂给 Agent 前先确认它会被读成什么（避免把“想读 README 实际命中了 200 行二进制”这种失误带到 prompt 里）。
- 与真正的 `read` 工具保持一致的语义：包括选择器、行范围、原始字节、SQLite 行、归档成员等。

**参数**

- `<path>` 必填位置参数。接受以下形式：
  - 普通文件/目录路径：相对于 `getProjectDir()` 的 cwd。
  - 选择器后缀 `:start-end`（例如 `src/foo.ts:50-100`）和 `:raw`（不解码/不摘要）。
  - 多选择器组合：`:50-200,400-450`。
  - HTTP(S) URL。
  - 内部 URI：`omp://`、`issue://<N>`、`pr://<N>`、`history://<id>`、`mcp://…` 等。
  - 归档成员：`path/to/archive.zip:dir/file.ts`、`.tar.gz:src/a.ts`、`.asar:lib/b.js`。
  - SQLite 行：`db.sqlite:users`（表列表）、`db.sqlite:users:42`（按主键）。

**示例**

```bash
# 普通文件 + 行范围
omp read src/server.ts
omp read src/server.ts:50-120
omp read src/server.ts:raw

# URL / 内部 URI
omp read https://example.com
omp read omp://
omp read issue://123
omp read pr://456?comments=0

# 归档成员
omp read path/to/app.zip:src/index.ts

# SQLite 行
omp read ~/.omp/agent/sessions/scratch.db:users:42
```

**注意**

- 输出内容就是模型会看到的；图像、PDF 那种内容不会被渲染到终端，而是以占位行替代——这是有意的，不要靠 `omp read` 做预览。
- 该命令在无参数时立刻 stderr 打印 `error: path is required` 并退出 1。
- 由于会触发 MCP 资源发现以解析 `mcp://` 形式的输入，首次针对 `mcp://` 路径的调用会等待 MCP 服务连接完成。

---

### `omp grep` — 直接在 shell 里跑原生 grep 工具

`omp grep` 是把 `omp` 内置的 `grep` 工具（基于 `pi-natives` 的 ripgrep 封装）作为独立命令跑出来，等价于 Agent 内部 `grep` 工具，但没有模型环绕：直接打印匹配结果和统计。它不修改任何文件、不写入会话，只是把 grep 工具的输出以彩色人读格式打到 stdout，因此可以接 `rg`-style 工作流或 shell 脚本。匹配上限 20、上下文 2 行是默认值（与 Agent 工具保持一致），文件默认包含隐藏文件（`hidden: true`）、并尊重 `.gitignore`。

```bash
omp grep [pattern] [path] [options]
omp g <pattern>                # 没有 -g/--glob 短别名冲突时 <pattern> 是必填位置参数
```

**功能/效果**

- 调用 `pi-natives` 的 `grep` 实现，对 `<path>`（默认 `.`）执行正则匹配。
- 默认按内容（`Content` 模式）输出：每条匹配 `<path>:<line>:<text>`，前后各 2 行上下文（`--context` 可调）。
- 加 `-c`/`--count` 切到 `Count` 模式：每文件打印 `<path>: <N> matches`。
- 加 `-f`/`--files` 切到 `FilesWithMatches` 模式：只列命中的文件路径。
- 命中上限、文件数、总匹配数会先以绿色一行汇总打到 stdout，达到上限时打一行黄色 `Limit reached: true`。
- `--no-gitignore` 显式覆盖默认尊重 `.gitignore` 的行为。

**何时使用**

- 离线 grep：管道化、CI 日志、临时搜索；想用与 Agent 工具完全一致的 ripgrep 后端而不是手边 `rg`。
- 调查“某条信息出现在哪个文件/哪一行”：先用 `--files` 锁定范围，再用 `--count` 数每文件的命中数。
- 配合 `--glob` 限定文件类型或目录，省去 `find … -exec grep …`。

**参数**

- `<pattern>` 位置参数：正则表达式（`pi-natives` 的 `grep` 解析语义）。省略会被拒绝并打印 `Error: Pattern is required`。
- `<path>` 位置参数：搜索的根路径，默认 `.`。支持 `~` 展开（走 `expandPath` + `path.resolve`）。
- `-g, --glob <pattern>`：按文件名 glob 过滤（`*.ts`、`**/*.test.ts` 等）。
- `-l, --limit <n>`：最大匹配数，默认 `20`。
- `-C, --context <n>`：上下文行数，默认 `2`；仅 `Content` 模式生效。
- `-f, --files`：切换到 `FilesWithMatches` 模式（与 `-c` 互斥，后者优先级更高）。
- `-c, --count`：切换到 `Count` 模式（最高优先级，覆盖 `-f`）。
- `--no-gitignore`：包含 `.gitignore` 排除的文件；隐含默认 `gitignore: true`。
- 环境变量 `PI_WALK_WORKERS=N`：文件系统遍历的并行度，默认 4，`0` 表示自动。

**示例**

```bash
# 在 src/ 下找所有 import 语句
omp grep "import " src/

# 只看命中文件名
omp grep "TODO" . --files

# 限制文件类型 + 命中数
omp grep "function" --glob "*.ts" -l 50

# 不看 .gitignore 排除的 vendor 目录
omp grep "secret" vendor/ --no-gitignore
```

**注意**

- `pi-natives` 的 grep 使用 ripgrep 风格的正则；POSIX `grep` 不支持的语法（PCRE 回溯、`\K` 等）在这里不一定可用。
- `hidden: true` 是默认值，因此点文件（`.env`、`.gitignore`）也会被搜到。
- 匹配上限 20 偏保守；脚本里想拿“全量”记得显式 `-l 10000` 或更大。

---

### `omp search`（别名 `q`）— 直接测一次联网搜索

当你没在交互里、但想验证某个 web search provider、确认某条新闻/版本号当前的真伪、或者为 Agent 准备一条 `web_search` 结果做 prompt 时，用 `omp search`（短别名 `q`）。它直接走与 Agent `web_search` 工具同一条路径（`runSearchQuery` + `renderSearchResult`），按指定 provider 拉取结果并以人读表格打到 stdout。它**会**走真实网络，可能产生外部 HTTP 调用与凭据读取（`Settings` + `applyProviderGlobalsFromSettings`），但**不会**写入工程文件。

```bash
omp search [options] <query>
omp q     [options] <query>
```

**功能/效果**

- 调一次 `web/search` 的查询管线，按 `--provider` 选 provider、按 `--recency` 限定时间窗口、按 `--limit` 限制条数。
- 默认按 expanded 视图（带答案摘要、来源列表）打印到 stdout，宽度自适应（不小于 60，缺省为 100 列）。
- `--compact` 切到压缩视图：答案摘要限制最多 6 行。
- 查询语法支持 `site:`/`-site:`、`after:`/`before: YYYY-MM-DD`、`inurl:`、`intitle:`、`filetype:`、`"exact phrase"`、`-term`、`OR`；当 provider 原生支持时映射到原生 filter，否则作为宽松后置过滤（匹配不到时**放宽而非失败**）。
- provider 内部失败（凭据缺失、限流、上游错误）会把 `details.error` 透传到结果里并把进程退出码设为 1。

**何时使用**

- 验证某个 provider 当前是否可用（例如换号之后：`omp q "…" --provider=brave`）。
- 调试查询语法在某个 provider 上的实际效果（`site:` 是否生效、`--recency=week` 是否覆盖当天新闻）。
- 把搜索结果手工贴到 prompt：在 CI/管道里 `omp q --compact …` 输出纯文本。

**参数**

- `<query>` 位置参数（`multiple: true`）：把所有 token 用空格连成一个查询字符串。
- `--provider <name>`：选 provider，可选值由 `SEARCH_PROVIDER_OPTIONS` 派生，当前包括
  `auto`、`perplexity`、`gemini`、`anthropic`、`codex`（OpenAI）、`xai`、`zai`、`exa`、`tinyfish`、`jina`、`kagi`、`tavily`、`firecrawl`、`brave`、`kimi`、`parallel`、`synthetic`、`searxng`、`startpage`、`duckduckgo`、`ecosia`、`google`、`mojeek`、`public`（全部并发去重）。
  缺省时按 settings 的 `providers.webSearchOrder` 走，链上没配就退回 `auto`。
- `--recency <value>`：`day`/`week`/`month`/`year`，仅当 provider 支持时生效。
- `-l, --limit <n>`：最大结果条数。
- `--compact`：压缩输出（仅顶层 6 行答案）。

**示例**

```bash
# 默认 auto provider，问个常识
omp q "color of the sky"

# 显式 provider + 时间窗
omp q --provider=brave --recency=week "latest TypeScript 5.7 changes"

# 高级查询语法：限定 arxiv、排除 reddit
omp q 'transformer scaling site:arxiv.org after:2024 -site:reddit.com'

# Exa 限定 + 压缩输出（用于管道）
omp q --provider=exa --compact "rust async runtime benchmark 2026"
```

**注意**

- `auto` 模式实际落到 `setSearchProviderOrder` 决定的优先链上，第一条失败的 provider 会按链往下退化。
- `codex` 走 ChatGPT OAuth（`/login openai-codex`），`gemini` 走 `google-gemini-cli`/`google-antigravity` OAuth，`anthropic` 走 Anthropic OAuth 或 `ANTHROPIC_API_KEY`；其余大多数 provider 需要对应的环境变量（如 `BRAVE_API_KEY`、`TAVILY_API_KEY`）。
- 网络失败/限流时，命令**不**抛错，而是把失败写到结果的 `details.error`，进程退出码设为 1，便于脚本里通过 `$?` 区分。

---

### `omp images`（别名 `img`）— 检查与维护图片发布后端

`omp images` 不是“插入图片”的命令，而是给“图片/二进制附件发布后端”（`blob-broker` 守护进程 + 各种 `ProviderFileCache`）做运维的诊断与清理入口。它把 daemon 状态、provider 文件缓存、磁盘占用、连通性做成四个子动作（`status`/`doctor`/`probe`/`purge`），全部只读（`status`/`doctor`/`probe`）或带 dry-run 的写入（`purge`）。其中 `purge` 是唯一**会真正删除文件/缓存**的动作；其他三个纯只读。

```bash
omp images [action] [options]
omp img   [action] [options]
```

**功能/效果**

- 默认无子动作时等价于 `status`：列出每个 provider 的缓存条目数、磁盘占用、daemon 是否可达，并按人类可读表格输出。
- `doctor`：跑一组预检（config、磁盘、auth-storage），把每条结果标 `ok`/`warn`/`error`。
- `probe`：对每个配置的 provider 发一次主动健康探测，可配超时（秒），用于验证凭据/网络是否真的能上传。
- `purge`：默认 dry-run 列出“会删除什么”；加 `--apply` 才真删；`--all` 会清空所有缓存，否则只清过期的。
- `--json` 让任意动作都输出单行 JSON（而不是人类可读报告），便于脚本处理；非零退出码反映 daemon/网络错误。

**何时使用**

- 偶发“图片上传失败 / 截图发布卡住”：先 `omp images status` 看 daemon 是否可达，再 `omp images doctor` 看 config/磁盘/凭据，再 `omp images probe --timeout 15` 验真。
- 缓存里堆了几 GB 的过期图片：`omp images purge`（dry-run）→ 检查 → `omp images purge --apply`。
- CI/上线脚本里自动化诊断：`omp images doctor --json` 然后 `jq`。
- 文档里提到的“清空图片缓存”流程：实际是 `omp images purge --all --apply`，不传 `--all` 只清过期。

**参数**

- `<action>` 位置参数，可选值由 `IMAGES_ACTIONS` 固定为 `status`（默认）、`doctor`、`probe`、`purge`。
- `--json`：把所有结果以单行 JSON 文档输出到 stdout。
- `--apply`：仅 `purge` 有效；缺省是 dry-run（只列将删除的项）。**这是默认的“只读 ↔ 写入”开关。**
- `--all`：仅 `purge` 有效；删除所有缓存条目而非仅过期的。
- `--dir <path>`：要诊断的工程目录，默认 `process.cwd()`。在 monorepo 顶层跑子项目时显式指定。
- `--timeout <n>`：仅 `probe` 有效，单位秒，必须是正整数；非法值会立即返回 `exitCode: 2` 并报 `--timeout must be a positive integer`。

**示例**

```bash
# 默认：状态
omp images
omp images status --json | jq

# 诊断配置 + 磁盘 + 凭据
omp images doctor

# 主动探测 provider 连通性，15s 超时
omp images probe --timeout 15

# 清过期（dry-run 先看清单）
omp images purge

# 真清：清过期
omp images purge --apply

# 清全部缓存
omp images purge --all --apply
```

**注意**

- `purge` 默认是 dry-run；要真正写盘/清缓存必须显式 `--apply`。
- 这条命令不依赖 `omp images` 名称来自“有图要插入”——它只跟发布后端的二进制缓存与 daemon 状态有关，与 read 工具或 Agent 的图片附件路径无关。
- `--timeout` 只影响 `probe`；`status`/`doctor`/`purge` 走本地文件系统 + daemon IPC，没有网络超时。
- 该命令属于“专用工具/诊断”，普通用户基本用不到；面向用户的多模态入口仍是 `omp read <图片路径>` 与 Agent 内部的附件机制。

---

### `omp render` — 把一个会话线程按生产渲染管线回放一次

`omp render` 是给 transcript 调试、性能基准、前端预览用的“离线回放”工具：把一个会话文件喂给**与生产完全一致**的 `InteractiveMode` + `TUI`（只是终端换成字节计数的 `SinkTerminal`、渲染调度换成同步 `DrainScheduler`），按给定宽高把所有 transcript 行原样打到 stdout。它**只读**会话内容：先把源文件拷到临时目录再打开，避免抢单写锁或在活会话上追加 `session_exit` 条目（`suppressBreadcrumb: true`）；因此可以放心在另一个 `omp` 还在跑同一会话时调用。

```bash
omp render [session] [options]
```

**功能/效果**

- 选择目标会话：位置参数为 `.jsonl` 路径 / 包含 `/` 的路径 / 会话 ID 前缀；不传则取当前工程最近的会话（`findMostRecentSession`）。
- 打开会话、构造 `AgentSession`、跑一次 `renderInitialMessages({ clearTerminalHistory: true })` ——这正是 `/tree` 导航、`Esc-Esc`、`/resume`、主题切换后用户感受到“屏幕冻一下”那次重绘的同一条代码路径。
- 把组装好的 transcript 行（默认带 ANSI 样式）打到 stdout，每行用 `Bun.stripANSI` 视 `--plain` 决定是否去色。
- 退出码：成功 0；非法参数（`--repaint <= 0`）抛 `CliUsageError`；目标会话解析失败抛带消息的 `Error`。
- 结束时会 `mode?.stop() + session?.dispose()`，并 `tempDir.removeSync()` 清理工作副本；Bun 事件循环尾部仍可能停几秒（与 `main.ts` 的退出模式一致）。

**何时使用**

- 调试“为什么大 session 的 `/tree` 切换卡”：用 `omp render <id> -t --repaint 5` 拿到平均/最小时长、字节数。
- 在 PR/CI 里断言渲染行为变化：`omp render <id> --plain > out.txt` 然后 diff。
- 把一个会话“导成文本/导成 HTML”（先 `> thread.ansi`，再交给外部转换器）。
- 离线浏览：当前没有可交互 TTY 时用 `omp render <id>` 直接看。

**参数**

- `<session>` 位置参数，可选。
  - `.jsonl` 路径或含 `/`/`\`：直接 `path.resolve`。
  - 其它：当作会话 ID 前缀（`resolveResumableSession`）。
  - 缺省：`findMostRecentSession(SessionManager.getDefaultSessionDir(cwd))`。
- `-w, --width <n>`：渲染列数，默认取 `process.stdout.columns`，非 TTY 时 120。
- `--height <n>`：视口行数，默认 `process.stdout.rows`，非 TTY 时 40。
- `-t, --timing`：把阶段耗时（`open`/`replay`/`paint`）+ 字节数打到 stderr。
- `--repaint <n>`：额外跑 N 次清屏重绘（`requestRender(true, { clearScrollback: true })`），只打印统计不打印 transcript（除非同时未传 `--quiet`）。必须正整数，否则 `CliUsageError`。
- `--plain`：去掉 ANSI 样式。
- `-q, --quiet`：完全抑制 transcript 输出，仅留 `--timing`/`--repaint` 报告（基准模式）。

**示例**

```bash
# 默认渲染当前工程最近一次会话
omp render

# 指定会话 id 前缀，去色
omp render 01a0285c --plain

# 基准：5 次重绘 + 计时 + 不输出 transcript
omp render ~/.omp/agent/sessions/--work-pi--/big.jsonl -q -t --repaint 5

# 固定宽度导出为 ANSI
omp render -w 200 > thread.ansi
```

**注意**

- 这是**纯只读 + 纯离线**：源文件不被修改；临时副本自动清理；daemon 客户端、agent session 都会 dispose。
- 没有会话或 ID 不匹配时会抛带消息的 `Error`（`No sessions found for <cwd>` / `Session "<id>" not found.`），不退出码而是非捕获的异常。
- `--repaint` 是诊断“全量重绘”那一帧的耗时，不是“测试渲染逻辑”——它要求会话已经被成功 replay 过一次。
- 显式标记为“专用/诊断”命令；新用户基本不需要直接调，交互里看 transcript 就够。

---

### `omp git` — 全屏交互式 Git 仓库 TUI

`omp git` 打开一个全屏的 Git 工作台：中间是带 minimap 的差异查看器（支持 hunk / inline / split / file 四种视图），右边是文件管理 + 提交表单（脏状态时）或 HEAD 提交详情（clean 时）。它会读仓库状态、写 staging 区（在你按 `s`/`u` 时），并在你提交时跑 `git commit` —— 因此**会改变仓库状态**（stage/unstage、commit、可选 push）。仅在 stdin/stdout 都被 TTY 接管时启动；非 TTY 直接 `exit 1` 并报 `omp git is interactive and requires a TTY`。

```bash
omp git [revision] [-C <dir>]
```

**功能/效果**

- 在当前工程（可用 `-C` 切到其它目录）打开 Git TUI：自动定位 repo 根、加载 `Settings`、按用户配置初始化主题/符号集/色盲模式（与交互模式完全一致）。
- 顶部栏展示当前文件路径与编码；工具栏展示 scope chip、视图切换按钮、空格/换行/whitespace 切换；右侧 sidebar 在脏状态显示 staging 表单 + 提交输入框，clean 状态显示 HEAD 提交的作者头像/邮件/作者信息。
- Diff 区支持 hunk-aware 操作：`s` stage hunk、`u` unstage、`x` discard hunk、`alt+↓/↑` 跳 hunk（文件边界处滚到相邻文件）、`]`/`[` 切文件、`c` 跳到提交表单。
- 提交表单为空时按 Enter 会调 `generateGitCommit`（与 `omp commit` 同源）生成 conventional 兼容消息；填了字段就按你填的提交。
- 视图切换：`v` 循环切换、`1`–`4` 直接选；`b` 循环 whitespace（exact → ignore whitespace → ignore formatting/import-only）；`r` 刷新（每 2s 也会自动 refresh，状态 TTL 6s）。
- 退出会话按 `q` 或关闭按钮；变更未保存会先确认。

**何时使用**

- 不想用 `git add -p` / `magit` 但想可视化检视 + 选择性 stage 整个工作区。
- 在 commit 之前先看一遍 hunk diff 并给每个文件决定 stage / discard。
- 想要一个生成 conventional commit 消息的“半自动”表单（提交表单留空就 LLM 生成）。

**参数**

- `<revision>` 位置参数，可选：把视图锁定到某一个 commit（任何 `git rev-parse` 能识别的值，例如 `HEAD~2`、完整 SHA、分支名、tag）。
- `-C, --dir <path>`：把工作目录切到 `<path>`，避免先 `cd` 再 `omp git`。

**示例**

```bash
# 当前目录
omp git

# 看某个 commit 的 diff（只读视图）
omp git HEAD~2

# 在其它工程跑
omp git -C ~/projects/app
```

**键位（与 `cli/git-tui/index.ts` 注释一致）**

- 全局：`q` 退出；`tab` 切 focus（diff ↔ sidebar）；`r` 刷新；`c` 跳到提交表单。
- 视图：`v` 循环视图；`1`–`4` 直接选 hunk / inline / split / file；`b` whitespace 循环；`w` wrap。
- 文件/hunk：`j`/`k`/`h`/`l`/`g`/`G` vim 风格；`alt+↓`/`alt+↑` 跳 hunk；`]`/`[` 切文件；`s` stage；`u` unstage；`x` discard hunk。
- Sidebar：`←`/`→` 折叠/展开目录；`enter` 打开文件；`space` stage/unstage 选中行（目录上则整目录）。

**注意**

- 这条命令**会修改仓库状态**（stage/unstage/commit）；不打算写就只看 diff，**不要**随便按 `s` 或提交。
- 需要真 TTY：管道、远程 ssh、CI 都不会启动。
- 用 LLM 生成 commit 消息时会按 `Settings` 走 provider/model；`omp commit` 的 `--push`/`--dry-run` 等开关在这条命令里没有，提交后想 push 还得手动。
- 不在“专用工具”范围，但仍然属于“Git 操作”主题：日常用 `omp commit` 跑批处理，用 `omp git` 做交互式检视与分阶段提交。

---

### `omp commit` — 自动生成 conventional commit 并可选推送

`omp commit` 是面向“批量处理”的提交命令：分析当前工程下所有已 stage（或自动 `git add -A`）的变更，让 LLM 按 `CommitType` 枚举（`feat`/`fix`/`refactor`/`perf`/`docs`/`test`/`build`/`ci`/`chore`/`style`/`revert`/`deps`/`security`/`config`/`ux`/`release`/`hotfix`/`infra`/`init`/`merge`/`hack`/`wip`）生成符合 conventional commit 规范的消息，**会**自动同步 `CHANGELOG.md` 的 Unreleased 段（Keep a Changelog 七类），**会**创建 commit，**可**选 push。它和 `omp git` 的提交表单是同一套生成逻辑，但 `omp commit` 走 Agent 路径，能拆 commit、按依赖排序、changelog 按子目录分别落点。

```bash
omp commit [options]
```

**功能/效果**

- 无 stage 时自动 `git add -A`（避免“全选”失误的话先手动 `git add <path>`）。
- 调 `runAgenticCommit`：
  - 解析主模型 + 小模型（settings/CLI 扩展）；
  - 检测 changelog 边界（`detectChangelogBoundaries`，按 `CHANGELOG.md` 路径分组的子目录）；
  - 把 staged 文件 + diff + 上下文文件 + numstat 全部喂给 commit agent；
  - agent 可能给出 1 个提案、`SplitCommitPlan`（拆 commit）、或 `changelogProposal`；也可能 fallback 到 `generateFallbackProposal`（这种情况返回 `usedFallback: true`）。
  - 拆 commit 时按 `assignLockFilesToPlan` + `computeDependencyOrder` 做拓扑排序，锁文件集中放、其它按依赖关系排。
  - 每条 commit 前检查 `pre-commit`/`commit-msg` 钩子失败：捕获 stderr 缩进打出来，再抛 `CommitAbortedError`（CLI 退出 1，不会喷堆栈）。
- 完成后可选 `--push`：`pushOrAbort` 包了一层错误格式化，被拒绝（无 upstream / rejected）一样走 `abortOnGitFailure`。
- `--legacy` 走“确定性管线”（不再经 agent session，直接 `generateGitCommit` + 格式化），适合做 CI 可重复输入或在主模型不可用时退化。
- 退出码：0 正常；1 用于 `usedFallback`（说明 commit agent 没真正完成决策，回到了机械 fallback）或 `CommitAbortedError`（hook 拒绝、push 拒绝、生成校验失败）。
- 该命令在底层会创建 `AgentSession`，打开 keep-alive socket 到 provider；CLI 用 `postmortem.quit` 强制退出，避免 Bun fetch 闲置连接和 OAuth 定时器把事件循环卡住（#1041）。

**何时使用**

- 一次提交多个独立变更、想拆 commit 并按依赖顺序排序。
- 想自动把变更归类到 `CHANGELOG.md` 的合适分类（Added/Changed/Fixed/...）和子目录文件。
- 想让模型写好 conventional commit 标题和正文、自己只决定是否 `--dry-run`/`--push`/`--no-changelog`。
- CI 或脚本里要稳定可重复：用 `--legacy --dry-run` 验证消息生成。

**参数**

- `--push`：commit 完成后 `git push`（自动捕获并格式化推送错误）。
- `--dry-run`, `--dry-run`：只打印将要生成的 commit 消息（含校验错误警告），不写盘。
- `--no-changelog`：跳过 changelog 生成（不创建/不更新 `CHANGELOG.md`）。其它逻辑不变。
- `--legacy`：改走“确定性管线”而非 agent session；输出稳定、便于在 CI 中回归。
- `-c, --context <text>`：附加给模型的上下文（会拼进 prompt），用于补充“这个改动要解释的语义”这类信息。值必须存在且不以 `-` 开头，否则 `Error: --context requires a value`。
- `-m, --model <id>`：覆盖主模型选择（`resolvePrimaryModel` 会先看这个，再退回 settings）。

**示例**

```bash
# 标准流程：自动 stage → 生成 commit + changelog → commit
omp commit

# 先看消息是否满意
omp commit --dry-run

# 提交并推送
omp commit --push

# 跳过 CHANGELOG（一次性修复、纯重构等）
omp commit --no-changelog

# CI 流水线里要稳定输出
omp commit --legacy --dry-run

# 给模型加上下文
omp commit --context "把 Settings.commit 拆出二级键" --push

# 临时切到不同模型
omp commit --model anthropic/claude-sonnet-4-5
```

**注意**

- 这是当前主题里**最容易改仓库状态**的命令：会 stage 未暂存文件、可能创建多条 commit、改 `CHANGELOG.md`、可选 push。脚本里跑前建议先 `git status`。
- 无任何变更时优雅退出并打 `No changes to commit.`（stderr），不会进生成流程。
- `--dry-run` 只打印消息；如果消息校验失败（不满足 conventional commit 规范）会写一条 `Warning: generated message requires manual correction` 到 stderr；非 `--dry-run` 时会直接抛错。
- 返回 `usedFallback: true` 时退出码 1：意味着 agent 没真正做决策，走的是机械 fallback，调用方应该把它当作“降级”而不是“成功”。
- 该命令读 `Settings`（含 `commit.*` 那一组），并在“长变更”时按 `commitSettings.changelogMaxDiffChars` 截断喂给 changelog 生成。
- 属于“Git 操作”主线；不打算让 Agent 改动的纯查看用 `omp git` 或裸 `git`。

---

### 只读 ↔ 写入速查

| 命令 | 子动作 | 默认行为 | 写入风险 |
|------|--------|----------|----------|
| `omp read` | — | 打印 read 工具输出 | 无（只读） |
| `omp grep` | `-c`/`-f`/默认 | 打印匹配/计数/文件 | 无（只读） |
| `omp search` / `q` | `auto`/各 provider | 拉取并打印网络结果 | 无（只发网络请求） |
| `omp images` | `status`/`doctor`/`probe` | 输出诊断报告 | `status`/`doctor`/`probe` 只读；`purge` 默认 dry-run，加 `--apply` 才删 |
| `omp render` | — | 离线回放 transcript | 无（只读 + 临时副本） |
| `omp git` | — | 打开全屏 TUI | **会** stage/unstage/commit；非 TTY 直接退出 |
| `omp commit` | agentic（默认）/legacy | 生成 + 写 commit + 改 CHANGELOG | **会** 自动 stage、可能拆多 commit、改 `CHANGELOG.md`、`--push` 时 `git push`；`--dry-run` 仍会读 git 状态但不改 |

> `omp read` / `omp grep` / `omp search` / `omp render` 是安全的“看一眼”入口；`omp images` 多数子动作只读，`purge` 必须 `--apply`；`omp git` 与 `omp commit` 是这套主题里唯二真正写仓库的命令，使用前先用 `--dry-run` 或裸 `git status` 把状态对齐。

## Shell、SSH 与语音输出

### `omp shell` — 交互式本地 shell 控制台

当你想用与 Oh My Pi 内部工具一致的 brush-core 引擎（而不是手边开一个 `bash`）来跑多条命令、保留变量与别名时用这个子命令。它是一个 REPL，所有写入的 shell 变量、函数在行与行之间持续存在；按 `.exit` 或 `exit` 退出，按 `Ctrl+C` 中断正在执行的命令（再按一次直接退出控制台）。第一次进入会自动尝试从用户 shell（`bash`/`zsh`）导出别名、函数、选项到一个权限 `0700` 的快照文件并 source 到会话里，从而保留你日常交互里的别名；`--no-snapshot` 会跳过这一来源。常用于手测 brush 解析、调试 minimizer 行为，或在不离开 TTY 的前提下试运行一段命令再贴到 Agent 中。

```bash
omp shell [--cwd <path>] [--timeout <ms>] [--no-snapshot]
```

**功能/效果**

- 进入 Oh My Pi 内置 brush-core shell 的 REPL，逐行执行命令并把输出流式回显。
- 会话内 `cd`、导出的变量、函数、别名在行间持续存在（持久 shell 会话）。
- 启动时默认按 `utils/shell-snapshot.ts` 走一次快照：bash 读 `~/.bashrc`、zsh 读 `~/.zshrc`、其他 shell（含 `fish`、`/bin/sh`）不跳过而是退化为 `sh` 快照并尝试 `source` `~/.profile`；Windows 与快照失败路径直接进入不带用户别名的会话。
- 每条命令执行后根据结果打印 `Command timed out.` / `Command cancelled.` / `Exit code: N`，便于快速判断失败原因。

**何时使用**

- 调试 brush-core 解析或在 Agent 工具外复现一次 `exec` 调用前的本地状态。
- 想用 brush 而非系统 `bash` 跑一段带别名/函数的命令。
- 不在交互 TTY 中（例如管道、CI、远程 `omp`）调用会立即退出并报 `Error: shell console requires an interactive TTY.`，需要提前确认 `process.stdin.isTTY` 为真。

**参数**

- `--cwd <path>`, `-C <path>`：把命令的工作目录切换为 `path`（绝对路径或相对路径都会被 `path.resolve` 处理）。省略时取 `getProjectDir()`，即当前工程根。注意：会话内部的 `cd` 仍会影响后续行；但如果你没在 REPL 里 `cd`，`cwd` 参数就是每条命令的默认目录。
- `--timeout <ms>`, `-t <ms>`：单条命令的硬超时（毫秒）。超时会触发 `Command timed out.` 并返回 `timedOut: true`，适合给潜在挂起命令（例如 `sleep` 无限、`find /`）加保险。非法整数会被忽略。
- `--no-snapshot`：跳过生成/读取用户 shell 快照。当你的 `.bashrc` 极重、会拖慢进入，或你只想跑一个干净 brush 会话时使用。

**REPL 内置命令**

- `.help`：打印控制台自身帮助（含上述三个选项及 `Special Commands` 列表）。
- `.exit` / `exit` / `quit`：退出控制台。
- `Ctrl+C`：若正在跑命令则中止当前命令（调用 `shellSession.abort()`），否则直接关闭 readline 并退出。

**示例**

```bash
# 默认进入工程根目录、加载用户别名
omp shell
> ls -la
> pwd
> .exit

# 把工作目录改到其它工程并加 5 秒超时
omp shell --cwd ~/work/other-repo --timeout 5000
> cargo build  # 超过 5s 会被中止并提示 "Command timed out."

# 干净会话，跳过用户 shell 快照
omp shell --no-snapshot
```

**注意**

- 真正执行命令的是 brush-core（`@oh-my-pi/pi-natives` 的 `Shell`），不是宿主的 `bash`，因此部分 shell 行为（例如复杂的 `[[ ... ]]` 条件、trap、`PROMPT_COMMAND` 钩子）可能与系统 `bash` 不同。
- 快照由 `utils/shell-snapshot.ts` 的 `getShellConfigFile`（行 92-97）+ `getOrCreateSnapshot`（行 215-323）共同决定：`shell.includes("zsh")` 走 zsh 路径并 `source` `~/.zshrc`，`shell.includes("bash")` 走 bash 路径并 `source` `~/.bashrc`，否则把 `shellName` 设为 `"sh"`（行 246）并尝试 `source` `~/.profile`——不会跳过快照。
- `Ctrl+C` 在空闲时直接 `process.exit(0)`，会绕过 `finally` 中的 `process.off`；生产脚本中如需可恢复退出，建议改用 `.exit`。
- 此命令不参与 agent 工作流，纯本地人机交互；与 `/exec` 等 Agent 工具不共享会话。

---

### `omp ssh` — SSH 主机配置管理

把命名好的 SSH 主机持久化到 JSON 配置里，供 Oh My Pi 的 `ssh://` 传输、SFTP、文件浏览、远端命令执行等能力按名字查用。它**不直接发起 SSH 连接**——只增删查 `ssh.json`。适合先在工作机上为一批远端节点起好别名，再让 Agent 或交互式工具按 `name` 复用，避免每次重写 `user@host:port`。配置分两层：`project` 写在当前工程根下的 `.omp/ssh.json`（随仓库共享，常用于临时/沙箱环境），`user` 写在 `~/.omp/agent/ssh.json`（跨工程复用，私钥路径和描述保留在本地）。`list` 会同时打印两层；`add` / `remove` 默认只写 `project`，可用 `--scope` 切到 `user`。

```bash
omp ssh <action> [targets...] [--scope project|user] [--json] [--host <addr>] [--user <u>] [--port <p>] [--key <path>] [--desc <text>] [--compat]
```

**子动作（位置参数 `action`）**

- `add <name>`：新增一台主机。`name` 是必填位置参数（只允许字母、数字、`_`、`.`、`-`，最长 100 字符）。至少需要 `--host <address>`；其他字段可选，写入顺序不影响。
- `remove <name>`：删除一台主机。`name` 必填；若指定层不存在该主机，输出 `Error: Host "<name>" not found in <file>` 并以非零退出码结束。
- `list`（默认）：同时读取并显示 `project` 与 `user` 两层。`--json` 时直接输出 `{ "project": {...}, "user": {...} }` 的 JSON。空时打印 `No SSH hosts configured` 并提示用 `omp ssh add <name> --host <address>` 添加。

> `action` 在 oclif 风格的位置参数中可选；省略时按 `"list"` 处理。

**参数**

- `[targets...]`：位置参数（可变）。对 `add` / `remove` 而言是主机名（取 `args[0]`）；对 `list` 会被忽略。同一调用可写多个但当前实现只读第一个。
- `--json`：仅 `list` 生效。表格输出改为 JSON，便于脚本解析。
- `--host <address>`：`add` 必填，保存为 `host` 字段。
- `--user <u>`：可选用户名；写入 `username` 字段。
- `--port <p>`：可选端口；`add` 时会做 1–65535 整数校验，写入 `port`（数字类型）。
- `--key <path>`：私钥路径，写入 `keyPath`。
- `--desc <text>`：人类可读描述，写入 `description`，仅在 `list` 文本输出时展示。
- `--compat`：启用兼容模式（写入 `compat: true`），给对老 OpenSSH / 限制行为奇怪的远端用。是否影响后续实际连接由消费方（`connection-manager`）决定。
- `--scope <scope>`：取 `project`（默认）或 `user`。`add` / `remove` 据此选择写哪一份 `ssh.json`；`list` 永远同时读两层，不受 `--scope` 影响。
- 互斥/默认：`--scope` 缺省 = `project`；`--port` 必须为整数（`Number.parseInt`），否则报错但**不会**回写；`--host` 缺失时直接报 `Error: --host is required`，不会落盘。
- 风险：`add` 写入的 JSON 文件会先以 `0600` 落临时文件再 `rename` 覆盖，安全；`remove` 同样原子。但 `add` 在主机名重复时会抛 `Host "<name>" already exists in <file>`，不会覆盖既有条目（要更新条目请直接编辑 `ssh.json`，CLI 没有 `update` 子动作）。

**示例**

```bash
# 添加一台工程级主机
omp ssh add prod-api --host 10.0.0.5 --user deploy --port 22 --key ~/.ssh/id_ed25519 --desc "staging API"

# 添加到用户层（跨工程复用）
omp ssh add lab-bastion --host bastion.lab.example --user ubuntu --port 2222 --scope user

# 启用兼容模式（旧 OpenSSH 服务器）
omp ssh add legacy --host legacy.example --compat

# 删除
omp ssh remove prod-api --scope project

# 列出所有主机（人读）
omp ssh list

# 列出 JSON（脚本消费）
omp ssh list --json
```

**注意**

- 此命令只管配置，不做连通性测试；写完想验证可交给 Agent 使用 `ssh://<name>/...` 或 `sftp://<name>/...` 触发实际连接。
- 端口非法、`--host` 缺失、主机名重复等错误会以 `process.exitCode = 1` 标记失败但**不立即终止进程**（区别于 `say` 的 `process.exit(1)`），适合在脚本里串联调用。
- 配置里写的 `host` 不限于域名，也可以是 IP；私钥路径不会被校验是否存在，由真正连的时候再报错。
- `list` 输出是只读快照，不会重排或合并同名主机；若 `project` 和 `user` 同时存在同名主机，消费方（`discovery/ssh.ts`）按扫描顺序决定胜出者。

---

### `omp say` — 本地 TTS 合成与播放

把任意文本（来自参数或文件）丢给本地 TTS worker 合成语音，**默认直接通过扬声器播放**，或用 `--out` 写成一个 WAV 文件。背后是 Kokoro-82M（q8 量化，~100 MB weights）跑在共享的 transformers.js/onnxruntime worker 上，模型首次使用时会下载到 worker 缓存并实时显示下载进度。所有可合成内容会先被 `SpeakableStream` 切成句子级片段逐段推送，避免触发单次调用约 510 phoneme 的截断；用 `--out` 时再把这些流式片段拼成一份完整的 WAV。文字或文件与 `--file` 互斥，缺一不可。

```bash
omp say [text] [--voice <id>] [--model <key>] [--file <path>] [--out <path>]
```

**功能/效果**

- 接收文本（参数或文件），送入本地 TTS worker 流式合成。
- 默认行为：边合成边通过 `StreamingAudioPlayer` 推扬声器；结束后打印 `spoke (<voice>, <model>, <Ns, N segments)`。
- 指定 `--out` 时不播放，把所有片段拼成一个 24 kHz 的单声道 PCM WAV 写盘；完成后打印 `saved <out> (<voice>, <model>, <Ns, Nbytes bytes)`。
- 整个进程结束后通过 `shutdownTtsClient()` 收尾，关闭 TTS worker。

**何时使用**

- 把 Agent 输出、日志、笔记等文本转成语音预览，验证本地 TTS 选型。
- 为一段长 Markdown / 笔记生成 WAV 文件用于后续播放（例如嵌入文档、做播客）。
- 调试 Kokoro voices 的口音/性别/语速差异。
- 不适用：在没有音频输出的 CI/容器里请用 `--out` 把 WAV 写出来再复制出去；模型未下载时，第一次跑会先下 ~100 MB 权重。

**参数**

- `[text]`：位置参数。要朗读的文本；与 `--file` 互斥（同时给会以 `error: pass either text or --file, not both` 退出码 1）。
- `--voice <id>`, `-v`（位置参数定义里没有 `char`，按 oclif 默认即无短别名）：voice id 必须是 `TTS_LOCAL_VOICE_VALUES` 之一，否则启动时会因 picker 校验失败。可用取值见下表，默认 `af_heart`（来自 `settings.tts.localVoice`）。
- `--model <key>`：本地模型 key。当前注册表中只有 `kokoro`（来自 `settings.tts.localModel`，默认亦 `kokoro`）。给出未知 key 会在 worker 启动时报错并提示 `Run \`omp setup speech\` to install it.`。
- `--file <path>`, `-f <path>`：从文件读文本而不是从参数拿。`Bun.file(path).text()` 同步读入；文件不存在或不可读会抛错并退出码 1。
- `--out <path>`, `-o <path>`：把合成结果写成 WAV 到该路径，而不是播放。`Bun.write(path, wav)` 写盘，路径父目录需可写。
- 默认/互斥/风险：
  - 三者必有其一：`text`（位置参数）或 `--file`；都缺则朗读空串并报 `error: nothing speakable in the input` 后退出码 1。
  - 同时给 `text` 与 `--file`：直接拒绝并退出码 1。
  - 文本可被 `SpeakableStream` 切成 0 段时同样退出码 1。
  - 没有任何 `--voice` 也会回退到设置 `tts.localVoice`，未配置时取 `af_heart`（Kokoro grade A 旗舰）。
  - 风险：第一次跑会下载模型（带 `downloading <file>: N%` 行内进度），期间会反复重写同一 stderr 行；写文件时若 `<path>` 已存在会被覆盖。

**可用 voice id（`--voice`，Kokoro-82M 当前目录）**

| id | 描述 |
| --- | --- |
| `af_heart`（默认） | Heart（美式女声，Kokoro grade A） |
| `af_bella` | Bella（美式女声） |
| `af_nicole` | Nicole（美式女声） |
| `af_aoede` | Aoede（美式女声） |
| `af_kore` | Kore（美式女声） |
| `af_sarah` | Sarah（美式女声） |
| `am_michael` | Michael（美式男声） |
| `am_fenrir` | Fenrir（美式男声） |
| `am_puck` | Puck（美式男声） |
| `bf_emma` | Emma（英式女声） |
| `bm_george` | George（英式男声） |
| `bm_fable` | Fable（英式男声） |

**示例**

```bash
# 直接播放一段文本
omp say "hello world"

# 用英式男声读 notes.md
omp say --file notes.md --voice bm_fable

# 写一个 WAV 文件（不播放）
omp say "hello world" --out /tmp/hello.wav

# 显式指定模型与声音
omp say --model kokoro --voice af_aoede --out ./greeting.wav "Welcome back."
```

**注意**

- 输出格式固定为单声道 24 kHz PCM WAV（来自 `encodeWav(pcm, sampleRate)`，sampleRate 来自 TTS worker 的实际流式 chunk）。其他采样率需自行重采样。
- 进程失败路径（`error: pass either text or --file, not both`、`nothing speakable in the input`、模型未安装等）一律以 `process.exit(1)` 终止，会绕过正常 REPL 收尾。
- `omp setup speech` 负责下载/校验模型与依赖；没装就跑 `omp say` 会在 stderr 给出对应提示并退出码 1。
- 实际播放走默认系统音频设备（`StreamingAudioPlayer`），无 `--quiet` 之类的静音开关；要静默就改用 `--out`。
- 流式播放的 segment 数与单段字符数取决于 `SpeakableStream` 的句子切分规则，长段落不会被一次性塞进 ~510 phoneme 上限。

## 分享、展示、补全与浏览器中继

### 分享、展示、补全与浏览器中继

本节覆盖 `omp share`、`omp gallery`、`omp completions`、`omp __complete`（内部入口）、`omp browser-relay`（含子动作 `serve`/`install`）。其中 `__complete` 仅由自动生成的 shell 补全脚本回调，不建议手工调用。

---

### `omp share <session>`

把已经保存的会话打包成加密链接并上传，命令行版 `/share`。不启动 agent、不进入交互界面，只在当前进程内完成密封、上传并打印链接。

**语法**

```bash
omp share <session> [--gist]
```

**功能 / 效果 / 何时使用**
- 把会话序列化为快照，按 `[12B IV][AES-256-GCM 密文+tag]` 布局密封（与 collab 帧同布局）。
- 根据 `share.store` 选择上传目标：
  - `blob`（默认）：`POST <share.serverUrl>` 拿到 `id`，链接为 `<serverUrl>/<id>#<base64url key>`。服务端 1 MB 硬上限；超额会先丢图片、再按 `[32768, 8192, 2048, 512]` 渐进式截断长字符串、再丢最旧条目，直到密文可上传。
  - `gist`（`--gist` 强制）：先调用 `gh gist create --public=false` 推送 `session.ompshare.txt`（需要已认证的 `gh`），失败时回落到 share server。链接仍以 share server 为基底，gist URL 单独打印。
- 链接中的 `#key` 仅存于浏览器 fragment，**不会离开本地**，查看器在客户端解密。
- 当 `share.redactSecrets` 与 `secrets.enabled` 同时为 true 时，会基于**会话自身项目目录**的 `secrets.yml` 构建混淆器对快照做字段级重写再密封（典型场景：工具输出读到了 `.env`）。
- 何时使用：想让别人（不登录 omp）查看一次只读会话；CI 复现某次崩溃；归档关键对话。

**参数**
- `<session>`（位置参数，**必填**）
  - 会话 id 前缀（例如 `a1b2c3d4`），或会话 `.jsonl` 文件路径。
  - 判定规则：不包含 `/` `\`、不以 `.jsonl` 结尾时按前缀在当前目录解析；其余按路径打开。
  - 解析不到会向 stderr 写 `Session "<arg>" not found.` 并 `process.exitCode = 1`。
- `--gist`（布尔，默认 `false`）
  - 强制走 secret gist 上传。`share.store` 的设置仍影响 `omp /share`；本命令下 `--gist` 显式覆盖它。

**相关设置（在 `settings-schema.ts` 的 `Collab` 分组下）**
- `share.serverUrl`（string，默认 `DEFAULT_SHARE_URL`）— 上传 / 查看基底 URL。
- `share.store`（enum `blob | gist`，默认 `blob`）— 默认后端；`--gist` 覆盖。
- `share.redactSecrets`（boolean，默认 `true`）— 是否对快照做密钥混淆；必须同时打开 `secrets.enabled` 才生效。
- `secrets.enabled`（boolean）— 全局密钥重写开关。

**示例**

```bash
omp share a1b2c3d4
# Share URL: https://share.example/abc…xyz#BASE64URLKEY

omp share ./sessions/2026-08-27.jsonl --gist
# Share URL: https://share.example/<id>#<key>
# Gist:     https://gist.github.com/<user>/<hexid>
# Note: large content was trimmed to fit the share size limit.  # 若被截断
```

**注意**
- 超过 1 MB 的会话**不会**失败，但 `share.url` 输出会附 `Note: large content was trimmed to fit the share size limit.`，查看端会看到被截断的图片占位符与 `[…truncated for share]` 字符串。
- 链接一旦发出就**无法作废**（fragment key 离开本地后任何拿到链接的人都能解密），分享前请确认内容没有你不希望公开的痕迹；混淆只覆盖已知字段，不透明的 `providerPayload` / `redactedThinking` / 扩展 `details|data|outputSchema` 会被直接丢弃而非重写。
- 解决的是 `Session "<arg>" not found.` 时，先用 `omp ps` / `omp --help` 子命令确认 id 前缀。

---

### `omp gallery`

渲染器预览工具。把每个内置工具的渲染组件依次驱动到 `streaming` / `progress`（即 `in progress`）/ `success`（即 `done`）/ `error`（即 `failed`）四个生命周期，按用户主题与符号预设打印 ANSI。主要用于回归视觉与为新工具写渲染器时取样。

**语法**

```bash
omp gallery [--tool <name>] [--state <tok>…] [--width <n>] [--expanded] [--plain] \
            [--screenshot] [--out <path>] [--font <family>] [--font-size <pt>]
```

**功能 / 效果 / 何时使用**
- 迭代渲染器注册表 + 夹具（fixture）工具集合，按字母序打印每个工具的章节，章节内依次打印所选生命周期。
- 不连任何服务，不写文件（除 `--screenshot` 路径）；不修改 `Settings`，但会读取 `symbolPreset` / `colorBlindMode` / `theme.dark` / `theme.light` 来贴合当前外观。
- 何时使用：调主题；做渲染器 PR 时截图对比；查某个工具在四种状态下的实际输出。
- `--screenshot`：把渲染好的真彩色 ANSI 在子进程里喂给 `vhs`（虚拟终端 + ttyd + ffmpeg）输出 PNG。**`vhs` 缺失会硬失败**，无降级路径。

**参数**
- `-t, --tool <name>` — 只渲染该工具；名称需在渲染器注册表或夹具集合里，否则打印 `Unknown tool '<name>'. Known tools: …` 并返回。
- `-s, --state <tok>`（可重复）— 限定生命周期。接受的 token（大小写不敏感）来自 `GALLERY_STATE_ALIASES`：
  - 内部态：`streaming`、`progress`、`success`、`error`
  - 标签别名：`streaming args`、`in progress`、`done`、`failed`
  - 解析失败向 stderr 写 `Invalid --state '...'. Valid values: ...` 并以 `process.exitCode = 1` 退出。
- `-w, --width <n>` — 渲染宽度（列数）；未指定时取当前终端宽度并夹紧。
- `-e, --expanded`（默认 `false`）— 渲染展开态（更高的输出面板）。
- `--plain`（默认 `false`）— 用 `Bun.stripANSI` 去掉颜色与样式，适合 `> file` 重定向。
- `--screenshot`（默认 `false`）— 改用 `vhs` 输出 PNG；同进程强制 `COLORTERM=truecolor` 让 SGR 颜色准确。
- `-o, --out <path>` — 截图输出路径；多张图时按 `<name>-01.png` / `<name>-02.png` 自动后缀；省略时落到临时目录，stdout 打印绝对路径列表（一行一个）。
- `--font <family>` — 截图字体（默认 `JetBrainsMono Nerd Font`），必须本地已安装；推荐 Nerd Font 以正常渲染 PUA 图标。
- `--font-size <pt>` — 截图字号（默认 18）。

**示例**

```bash
omp gallery                                  # 全部工具 × 四种状态，ANSI 到 stdout
omp gallery -t bash -s streaming -s success  # 仅 bash 工具的 streaming + success
omp gallery --plain > gallery.txt            # 纯文本预览
omp gallery --screenshot -o ./shots/gallery  # 真彩 PNG；多张图自动分文件
```

**注意**
- ANSI 输出包含真彩色转义，重定向到文件时记得带 `--plain`。
- 截图路径**仅在 `vhs` 已安装**时可用；缺它会直接报错而不是输出 ANSI。
- 列表中看不到的"工具"（如 `report_tool_issue` 与自定义扩展工具）来自 `galleryFixtures`，所以 gallery 也覆盖通用 fallback 与 custom-tool 分支。

---

### `omp completions <bash|zsh|fish>`

打印当前 CLI 表面（命令、别名、flag、合法值）的补全脚本。脚本**只从命令类的 `static description / args / flags` 声明式元数据生成**（见 `cli/completion-gen.ts`），所以脚本永远不会和实际 CLI 漂移：给某个命令加一个 flag 后重跑 `completions` 就有了。

**语法**

```bash
omp completions <bash|zsh|fish>
```

**功能 / 效果 / 何时使用**
- 用 `oclif` 风格的命令注册表 + `buildSpec` 走一遍元数据，生成对应 shell 的自包含补全脚本，直接写到 stdout。
- 静态候选项（如 `Args.string({ options: [...] })` 的枚举、内置工具名 `BUILTIN_TOOL_NAMES`）会**烘焙**进脚本本身，零运行时开销。
- 动态候选项（见 `__complete` 章节：`--model` / `--smol` / `--slow` / `--plan` 走模型目录，`--resume` / `--fork` / `--session` 走磁盘会话）通过回调 `<bin> __complete <kind>` 实现。
- 何时使用：刚装好 omp 想让 shell 补全生效；升级到包含新 flag 的版本后想刷新补全；CI 里把脚本烤进容器镜像。

**参数**
- `<shell>`（位置参数，**必填**，enum `bash | zsh | fish`）
  - 与值不符时向 stderr 写 `Usage: omp completions <bash|zsh|fish>` 并 `process.exitCode = 1`，**不抛异常**。
  - 解析逻辑在 `completions.ts` 的 `isShell()`（仅白名单这三个字面量）。

**安装建议（来自 `static examples`）**

```bash
# zsh — 启动时 eval，或写入 $fpath 下的某 _omp
eval "$(omp completions zsh)"

# bash
eval "$(omp completions bash)"

# fish — 写一次即可
omp completions fish > ~/.config/fish/completions/omp.fish
```

**注意**
- **不要**为 `__complete` 单独运行 `completions`：它就是脚本里的回调端点，输出格式是 `value\tdescription`（bash 忽略 `\t` 后的描述）。
- 烘焙的脚本每次重生成都会反映最新 flag 表；想避免脚本陈旧，把它放进 dotfiles 仓库或镜像构建里。
- `cli-commands.ts` 顶层默认命令为 `launch`，所以脚本里 `omp <TAB>` 看到的 flag 表是 `launch` 的（`--model`、`--resume` 等），而不是补全命令自身的。

---

### `omp __complete <kind> [-- <prefix>]`（内部补全入口）

`completions` 生成的 bash / zsh / fish 脚本在需要**动态候选项**时回调本命令，给出 `value\tdescription` 行序列。它在 `command-help.ts` 里 `hidden: true`，故意从 `--help` 中隐藏——`completions` 之外手动调用既慢又脆。

**语法**

```bash
omp __complete <kind> [-- <prefix>]
```

**功能 / 效果 / 何时使用**
- `kind= models`：扫描内置 provider × 模型目录，输出 `<provider>/<id>\t<provider>` 与裸 `<id>\t<provider>` 两种候选（小写子串匹配），按字母序排序。前缀对两个候选都生效。
- `kind= sessions`：调用 `SessionManager.list(process.cwd())`，按会话 id 前缀过滤，输出 `<id>\t<title|首条消息前 72 字符>`，用空格替换控制字符以保持 tab 分隔协议不被破坏。
- 没有输出（`lines.length === 0`）时**不写任何东西**（连换行都没有），shell 把它视作"无候选"。
- `this.argv` 会被先过滤掉 `--` 分隔符；`<prefix>` 取最后一个剩余 token，缺省视为空。
- `static strict = false`：允许任意位置参数，避免被 oclif 拒掉。

**参数**
- `<kind>`（位置参数）
  - 仅识别 `models` 与 `sessions`；其他值静默 no-op。
- `-- <prefix>`（位置参数）
  - 第二个剩余 token；缺省视为空串，即"列出全部"。
- `--` 之前的 `omp __complete` 之外**不接受任何 flag**（`strict = false` 也只放宽了位置参数）。

**何时使用**
- **通常不要直接用**。这条命令是 `completions` 生成的脚本的内部回调；写文档、做截图、或排查"为什么某个值不出现在补全里"时偶尔会直接跑。
- 排查"按 TAB 没有候选"：分别 `omp __complete models -- ""` 与 `omp __complete sessions -- ""`，确认数据源是否能枚举到目标。

**示例**

```bash
# 列出 provider/id 与裸 id，按子串匹配 "claude"
omp __complete models -- claude

# 列出 id 以 "a1b2" 开头的会话
omp __complete sessions -- a1b2
```

**注意**
- 候选项走白名单 `BUILTIN_TOOL_NAMES`（用于 `--tools`）来自 `pi-utils`/内置名常量；模型与会话则走运行时枚举。手工调用不替代补全：bash 用第一列做 `compgen` 候选，zsh 把 `\t` 后部分作为描述，fish 走 `-x -a` 子命令替换。
- 同一会话目录以外的会话不会被列出：实现里 cwd 固定为 `process.cwd()`。
- 会话标题里的制表 / 换行被替换成空格，避免破坏 `value\tdescription` 协议——脚本侧用 `cut -f1` 拿值，描述只能写在第二列。

---

### `omp browser-relay [serve|install]`

本地 CDP 中继，让 `omp` 的 browser 工具驱动**用户自己的 Chrome 标签页**而不是起一个无头浏览器。默认由 agent 在需要时自动拉起；手动运行本命令主要做两件事：把扩展写到磁盘（首次），或者用 `--token` / `--no-group` 等非默认参数拉起服务。

**语法**

```bash
omp browser-relay [serve|install] [flags]
```

**子动作**
- `serve`（默认，可省略）— 监听 `ws://127.0.0.1:<port>/ext`，等扩展连入；进程一直跑到收到 `SIGINT` / `SIGTERM`。
- `install` — 把 `manifest.json` / `background.js` / `options.html` / `options.js` / `LICENSE` / `THIRD-PARTY-NOTICES.txt` 写到 `--dir` 目录（默认 `~/.omp/browser-relay/extension`），并打印在 Chrome 里启用扩展的三步指引与启用配置的命令。**不**启动服务进程。

**功能 / 效果 / 何时使用**
- 服务侧把浏览器工具的 CDP 调用桥接到扩展（manifest v3 浏览器扩展），扩展再连回用户的真实 Chrome。
- 端口冲突时不会盲目失败：会 `probeRelayServer` 探测占用方是不是另一个 omp relay，是则打印 `omp browser relay already running on ...; nothing to do.` 并正常返回；否则报错并 `exit(1)`。
- 何时启用：想让 agent 操作你已经登录的网页（OAuth 后台、已登录的内部工具），或想看 agent 在自己浏览器里的实际操作；又想避免起无头 Chrome。
- 是否需要手工 `serve`：通常**不需要**——`browser.relay=true` 时 agent 在第一次需要浏览器工具时自起。仅在需要 `token` 鉴权或禁用 tab 分组（`--no-group`）时才手动起。

**参数**
- `<action>`（位置参数，可选，enum `serve | install`）
  - 缺省时走 `serve` 分支。
- `-p, --port <n>`（integer，默认 9224）— 监听端口，源自 `DEFAULT_RELAY_URL = "http://127.0.0.1:9224"`。改端口后**必须**同时设置 `browser.relayUrl` 指过来，否则 agent 仍连默认 9224。
- `--token <s>` — 扩展连入时必须出示此 token；不传则任何能访问本机端口的进程都可连。服务在打印扩展端点 URL 时会把 token 显示为 `?token=***`。
- `--dir <path>`（仅 `install` 生效）— 扩展落盘目录；缺省 `~/.omp/browser-relay/extension`（由 `getBrowserRelayDir()` 派生）。
- `--no-group`（boolean，默认 `false`）— 关闭把 agent 操作的标签页归入名为 `omp` 的 Chrome 标签组。
- `-v, --verbose`（boolean，默认 `false`）— 把中继流量摘要（连接、断开、tab 选中）以 `[relay] <message> <json>` 形式写到 stderr。

**相关设置（`settings-schema.ts` 的 `Grep & Browser` 分组）**
- `browser.relay`（boolean，默认 `false`）— 总开关。CLI 上 `omp config set browser.relay true`。
- `browser.relayUrl`（string，默认空）— 自定义端点；缺省走 `http://127.0.0.1:9224`。`PI_BROWSER_RELAY=0` / `PI_BROWSER_RELAY=1` 临时覆盖。
- `browser.cdpUrl`（string）— 通用 HTTP CDP 探测端点；当 `browser.relay` 打开时**被中继覆盖**。

**示例**

```bash
# 1) 一次性：把扩展写到磁盘 + 打印 Chrome 启用步骤
omp browser-relay install

# 2) 浏览器工具第一次需要中继时，agent 会自动起一个；
#    想加 token 鉴权时手动起
omp browser-relay -p 9333 --token s3cret

# 3) 不想让 agent 把操作的标签页收进 "omp" 分组
omp browser-relay --no-group
```

**注意**
- 扩展连入后控制台会打印 `Extension connected. The omp browser tool can now drive your tabs.`；断开则提示 `Extension disconnected; waiting for it to reconnect...`，连接状态每 500 ms 轮询。
- 端口被**非** omp 进程占用时直接 `exit(1)`，不会顶掉现有服务。
- 扩展徽标在连接到中继后显示 `on`；装好后仍连不上时，多半是 Chrome 没启用开发者模式，或 `browser.relay` 没打开。
- 真实想用 `--token` 鉴权时记得同步在扩展 Options 页面里填同一个 token，否则扩展不会发起连接。

## 插件与扩展管理

### 插件与扩展管理（`omp plugin …`）

Oh My Pi 的所有插件相关动作都汇集在 `omp plugin` 命令树下，覆盖从 npm 包、本地开发目录到 marketplace catalog 的完整生命周期。下面按动作讲解实际行为，参数取自 `packages/coding-agent/src/commands/plugin.ts` 与 `packages/coding-agent/src/cli/plugin-cli.ts`。

通用位置参数 `targets` 是若干个包名、路径或插件 ID；通用选项有 `--json`（输出 JSON）、`--force`（覆盖式安装）、`--dry-run`（仅显示将要做的操作）、`-l/--local`（读项目级 `omp` 配置而非用户级）、`--scope user|project`（marketplace 插件的作用域）。带 `[features]` 语法（如 `pkg[search,web]`）是 marketplace 安装支持的特性选择；npm 与本地路径安装时该语法被忽略。

#### 概览：动作与风险等级

| 子动作 | 作用 | 是否会下载 | 是否会改配置/锁文件 | 是否会删除内容 |
| --- | --- | --- | --- | --- |
| `install` | 安装插件 | 视源而定（npm/远程 git/本地链接） | 是（`omp-plugins.lock.json`、安装作用域 registry） | 可能（`--force` 时覆盖旧版本） |
| `uninstall` | 移除插件 | 否 | 是 | 是（删除 `node_modules` 软链、`installed_plugins.json` 条目） |
| `list` | 列出已安装 | 否 | 否 | 否 |
| `link` | 软链本地目录用于开发 | 否 | 是（写入 plugins 节点模块） | 否 |
| `doctor` | 健康检查 | 否 | `--fix` 时改写 | `--fix` 时删除/重建损坏项 |
| `features` | 启用/停用某插件的特性 | 否 | 是（`omp-plugins.lock.json`） | 否 |
| `config` | 读写插件设置 | 否 | 是（设置存储） | `delete` 子动作会清除键 |
| `enable` / `disable` | 启用或停用已安装的插件 | 否 | 是（registry + lock） | 否 |
| `marketplace` | 管理 marketplace 源 | 视子动作而定 | 是 | `remove` 会删除缓存目录 |
| `discover` | 浏览 marketplace 可用插件 | 仅按需取 catalog | 否 | 否 |
| `upgrade` | 升级 marketplace 插件 | 是 | 是 | 用新版本替换旧版本 |

---

### `omp plugin install <source>…`

```text
omp plugin install <source>[features] ...
omp plugin install name@marketplace [--scope user|project] [--force] [--dry-run] [--json]
omp plugin install ./path/to/local/plugin [--dry-run]
```

- **功能**：从 npm、git 仓库（`github:user/repo`、`https://…`、`ssh://…`、`git@…`）或本地目录安装一个或多个插件。Marketplace 安装使用 `name@marketplace` 形式；本地路径以 `.`、`..`、`./`、`../`、`/`、`~/` 或 Windows 盘符开头，会被改走 `link` 等价流程。
- **效果**：执行实际下载（npm 包或 git 克隆），把插件目录链接到当前作用域的 `node_modules/<pkg>`，并写入 `omp-plugins.lock.json`；marketplace 安装还会更新 `installed_plugins.json`。
- **何时使用**：发现新插件需要立即使用；项目初始化时一次性把团队约定的依赖装上。
- **参数**：
  - `targets`：每个元素是上述任一源形式；可一次传入多个。`pkg[feat1,feat2]` 限定要启用的特性，`pkg[*]` 启用所有，`pkg[]` 一个都不启用。
  - `--scope user|project`：仅对 `name@marketplace` 生效；其他源会打印警告并忽略。默认 `user`。
  - `--force`：覆盖已存在的同名插件而不询问（仅 npm 与 marketplace 路径有效）。
  - `--dry-run`：仅打印将要做的动作而不执行（`./` 本地路径时只描述 `link`）。
  - `--json`：以 JSON 形式输出结果对象。
- **示例**：
  - `omp plugin install @oh-my-pi/exa`（npm 默认包）
  - `omp plugin install @oh-my-pi/exa[search]`（带特性选择）
  - `omp plugin install code-review@claude-plugins-official --scope project`（marketplace，仅当前项目）
  - `omp plugin install github:user/repo#v1.0`（GitHub 标签引用）
  - `omp plugin install ./plugins/my-plugin --dry-run`（先看是否会 link）
- **注意**：会写入磁盘且可能联网；卸载前请用 `omp plugin list` 确认名字，否则 `bun uninstall` 对未注册包返回成功却什么都没删的边界情况仍然存在（仅 npm 路径有保护，marketplace 路径走 `MarketplaceManager`）。

### `omp plugin uninstall <name>…`

```text
omp plugin uninstall <name>[@marketplace] ... [--scope user|project] [--dry-run] [--json]
```

- **功能**：移除已安装的插件，自动判断 npm 包或 marketplace 插件（`name@marketplace`）。marketplace 插件会从对应作用域的 `installed_plugins.json` 与运行时锁文件中清除，npm 插件会从用户/项目的 `node_modules` 中删除。
- **效果**：删除软链与缓存条目；不会删除原始 npm 缓存或 marketplace catalog 缓存。
- **何时使用**：切换插件；排查问题需要回到干净状态；`omp plugin list` 出现冗余条目时清理。
- **参数**：
  - `targets`：一个或多个插件名/ID。仅写裸名时，如果该名在某个 marketplace 下唯一，会自动补全成 `name@marketplace`；同时匹配多个 marketplace 时会报错要求你显式加上 `@marketplace`。
  - `--scope user|project`：仅对 marketplace 路径生效；指定作用域不存在时报错。
  - `--dry-run`：先校验再做实际删除。
  - `--json`：输出 `{ uninstalled: name }` 或 dry-run 对象。
- **示例**：
  - `omp plugin uninstall @oh-my-pi/exa`（npm 包）
  - `omp plugin uninstall code-review@claude-plugins-official --scope project`
  - `omp plugin uninstall code-review`（裸名在单一 marketplace 下被自动解析）
- **注意**：不可逆；删除前可结合 `omp plugin list --json` 做快照；`--scope` 对 npm 路径无效，CLI 不会强制但行为是按用户/项目分别尝试。

### `omp plugin list [--json]`

```text
omp plugin list [--json]
```

- **功能**：合并列出 npm 链接/本地开发插件和 marketplace 插件，并显示启用的特性与可用特性。
- **效果**：仅读取；无写入。文本模式下按 `npm Plugins:` 与 `Marketplace Plugins:` 分块，`Marketplace Plugins` 行带 `(scope)` 后缀与 `[shadowed]` 标记。
- **何时使用**：想确认装了什么；脚本中配合 `jq` 解析；升级或清理前的盘点。
- **参数**：
  - `--json`：输出 `{ npm, marketplace }` 两个数组，便于脚本处理。
- **示例**：
  - `omp plugin list`
  - `omp plugin list --json | jq '.marketplace[].id'`
- **注意**：marketplace 插件条目会带 `(scope)`，受项目作用域覆盖 user 作用域的解析规则约束。

### `omp plugin link <path>`

```text
omp plugin link <path> [--json]
```

- **功能**：把本地插件目录符号链接进 `node_modules` 树，编辑源文件后下次启动立即生效，无需重装。
- **效果**：在当前作用域的 `node_modules` 下创建软链；不会移动或复制源文件。
- **何时使用**：开发新插件或修改第三方插件源码；想用 `git pull` 同步上游而不重新 `install`。
- **参数**：
  - `targets`：只取第一项作为路径（多写会被忽略）。
  - `--json`：输出链接结果。
- **示例**：`omp plugin link ~/work/omp-plugin-foo`
- **注意**：`omp plugin install <./path>` 走的是同一个 `manager.link()`，可以二选一；该动作不会修改 marketplace 缓存或 registry。

### `omp plugin doctor [--fix] [--json]`

```text
omp plugin doctor [--fix] [--json]
```

- **功能**：对所有已安装插件做健康检查（manifest 完整性、依赖、注册表一致性等）。
- **效果**：默认只读；带 `--fix` 时尝试自动重建/修补。检查后打印 `Summary: N ok, M warnings, K errors`；有未修复错误时退出码为 1。
- **何时使用**：安装/升级后做一次自检；TUI 报插件加载失败但 `list` 看起来正常时定位问题。
- **参数**：
  - `--fix`：自动修复可处理的问题，会改写磁盘。
  - `--json`：输出每个检查项的对象数组（含 `status: ok|warning|error` 与 `fixed: true`）。
- **示例**：
  - `omp plugin doctor`
  - `omp plugin doctor --fix`（自动修复）
  - `omp plugin doctor --json | jq '.[] | select(.status=="error")'`
- **注意**：`--fix` 属于会改写文件、可能删除损坏缓存的动作；正式执行前可先看普通输出评估。

### `omp plugin features <plugin> [--enable a,b] [--disable c] [--set d,e] [--json]`

```text
omp plugin features <plugin> [--enable <list>] [--disable <list>] [--set <list>] [--json]
```

- **功能**：查看某 npm 插件的可用特性及其启用状态，并可启用/停用/覆盖特性集合。
- **效果**：写入 `omp-plugins.lock.json` 中该插件的 `enabledFeatures` 数组；不触发代码安装/卸载。
- **何时使用**：插件带有可选特性（搜索、网页工具等），想按需开关；遇到插件提示某特性未启用时来这里开。
- **参数**：
  - `targets`：第一项为插件名（必须是 npm 链接/marketplace 中已安装的插件）。
  - `--enable <list>`：逗号分隔，把这些特性加入已启用集合。
  - `--disable <list>`：逗号分隔，从已启用集合中移除。
  - `--set <list>`：用逗号分隔列表整体替换当前已启用集合（互斥语义，覆盖 `--enable/--disable`）。
  - `--json`：输出当前状态。
- **示例**：
  - `omp plugin features my-plugin`（查看）
  - `omp plugin features my-plugin --enable search,web`
  - `omp plugin features my-plugin --set ""`（关闭所有可选特性）
- **注意**：特性名必须出现在 `manifest.features` 里，否则只是加进列表但运行时不会激活对应代码路径。

### `omp plugin config <list|get|set|delete|validate> <plugin> [key] [value]`

```text
omp plugin config list   <plugin> [--json]
omp plugin config get    <plugin> <key> [--json]
omp plugin config set    <plugin> <key> <value> [--json]
omp plugin config delete <plugin> <key> [--json]
omp plugin config validate [--json]
```

- **功能**：读写单个插件的 `manifest.settings` 中声明的键值；按 schema 自动做类型解析（数字/布尔/JSON）与校验；`validate` 会扫所有插件。
- **效果**：调用 `manager.setPluginSetting` / `deletePluginSetting` 持久化；secret 字段在 `list/get` 输出中显示为 `********`。
- **何时使用**：插件需要 API Key、路径或开关；CI 中注入默认值；插件报错配置不合法时跑 `validate`。
- **参数**：
  - `targets`：依次是子动作、插件名、键、可选值。
  - `--local`：从 `handleConfig` 签名上保留用于读项目级配置（实际读路径取决于 `PluginManager` 的实现，当前主要用于 list/get 时的回退源）。
  - `--json`：所有子动作的输出都可以 JSON 化。
- **示例**：
  - `omp plugin config list my-plugin`
  - `omp plugin config get my-plugin apiKey`
  - `omp plugin config set my-plugin apiKey sk-xxx`（按 schema 校验后再写入）
  - `omp plugin config delete my-plugin apiKey`
  - `omp plugin config validate`（扫所有插件，发现非法值会列出 `plugin.key: error`）
- **注意**：`set` 会按 schema 校验；类型不匹配或违反 `min/max/enum` 会退出码 1 并打印原因。`delete` 不可逆。

### `omp plugin enable <name>…` / `omp plugin disable <name>…`

```text
omp plugin enable  <name>[@marketplace] ... [--scope user|project] [--json]
omp plugin disable <name>[@marketplace] ... [--scope user|project] [--json]
```

- **功能**：在不卸载的前提下，让某插件在本次及后续运行中加载或跳过；先看是不是 marketplace 插件（`name@marketplace`），再回退到 npm 路径。
- **效果**：marketplace 路径写 `installed_plugins.json` + lock，npm 路径写 `manager.setEnabled`；当前会话不自动重新加载已初始化的能力。
- **何时使用**：临时关闭某个有副作用的插件；排查冲突；让某 marketplace 插件仅在 project 作用域生效。
- **参数**：
  - `targets`：插件名或 `name@marketplace`。
  - `--scope user|project`：仅对 marketplace 路径有效。
  - `--json`：输出 `{ enabled|disabled: name }`。
- **示例**：
  - `omp plugin disable code-review@claude-plugins-official`（临时停用）
  - `omp plugin enable code-review@claude-plugins-official --scope project`
- **注意**：被禁用的 marketplace 插件仍占据 `node_modules` 软链，只是不会进入加载列表；TUI 中改动后需 `/reload-plugins` 才会反映，ACP/RPC 处理器会自动刷新 skills/slash commands，但每个会话里已初始化的能力集不会重建。

### `omp plugin marketplace <add|remove|update|list> …`

```text
omp plugin marketplace add <source>
omp plugin marketplace remove <name> | rm <name>
omp plugin marketplace update [name]
omp plugin marketplace list
```

- **功能**：管理 marketplace 源（Git 仓库、本地目录或直链 catalog）。
- **效果**：
  - `add <source>`：从源抓取 catalog，缓存到 `marketplaces/<name>/`，把条目写入 `~/.omp/marketplaces.json`。源支持 `owner/repo`（GitHub shorthand）、`https://…`（路径以 `.json` 结尾视为直接 catalog，否则视为 git 仓库）、`ssh://` / `git@…`、本地 `./path` / `~/path` / `/path`。
  - `remove <name>`：从注册表删除条目并删除 `marketplaces/<name>/` 缓存目录；不会卸载已安装的插件。
  - `update [name]`：不指定名字时刷新所有 marketplace 的 catalog；指定名字时只刷新该 marketplace。
  - `list`：打印已配置 marketplace 的名字和源 URI。
- **何时使用**：接入新 marketplace；调整 catalog 来源；同步上游 catalog。
- **参数**：
  - `targets`：
    - `add`：取第一项作为源字符串。
    - `remove` / `rm`（`rm` 是别名）：取第一项作为 marketplace 名。
    - `update`：可选 marketplace 名；省略则全部。
- **示例**：
  - `omp plugin marketplace add anthropics/claude-plugins-official`
  - `omp plugin marketplace add ./my-marketplace`
  - `omp plugin marketplace update`（拉取所有最新 catalog）
  - `omp plugin marketplace remove anthropics-claude-plugins-official`
- **注意**：`add` 和 `update` 都会从远端下载或克隆仓库；catalog 改名时会拒绝更新并要求先 `remove` 再 `add`。`remove` 会删除本地缓存，但不会触碰 `installed_plugins.json` 中已通过该 marketplace 安装的插件。

### `omp plugin discover [marketplace]`

```text
omp plugin discover [marketplace]
```

- **功能**：列出某个 marketplace（省略则列出所有）catalog 中尚未安装或全部的插件。
- **效果**：仅读取缓存的 catalog；不下载新的内容（除非先 `marketplace update`）。
- **何时使用**：想看看某 marketplace 里有什么；新装一个 marketplace 后浏览可选插件。
- **参数**：
  - `targets`：可选 marketplace 名，省略时聚合所有 marketplace。
- **示例**：
  - `omp plugin discover claude-plugins-official`
  - `omp plugin discover`（看全部）
- **注意**：输出是纯文本列表（带版本与描述）；配合 `omp plugin install <name>@<marketplace>` 完成安装。

### `omp plugin upgrade [<name>@<marketplace>] [--scope user|project]`

```text
omp plugin upgrade [<id>] [--scope user|project]
```

- **功能**：根据已缓存的 marketplace catalog 把已安装插件升级到更新版本（semver 严格大于，或非 semver 不相等视为有变化）。
- **效果**：替换 `cache/plugins/<marketplace>___<plugin>___<version>/` 目录并更新软链与锁文件；单插件失败会被跳过。
- **何时使用**：跑过 `marketplace update` 之后想应用新版本；定期维护。
- **参数**：
  - `targets`：可选 `name@marketplace`；省略时升级所有声明了 `version` 的插件。
  - `--scope user|project`：省略名字时该选项会被忽略并打印警告；指定名字时只升级对应作用域的安装。
- **示例**：
  - `omp plugin upgrade`（升级全部）
  - `omp plugin upgrade code-review@claude-plugins-official --scope project`
- **注意**：升级会重写文件且会下载新版本；catalog 中未声明 `version` 的插件会被跳过。

## 安装、升级、清理与使用统计

### 安装、升级、清理与使用统计

本节覆盖 `omp` 自身与扩展的生命周期管理命令：`install`、`update`、`gc`、`compress`、`cleanse`、`stats`、`usage`。它们都基于 `packages/coding-agent/src/cli-commands.ts` 注册的命令映射与对应 `packages/coding-agent/src/commands/*.ts` 的实现。

阅读前提示：所有命令都通过顶层的 `omp` 调用；参数顺序固定为 `omp <command> [flags] [args]`；长短选项均可，短别名来自 `Flags.<type>({ char, … })`；以下示例均假定 `omp` 已在 `PATH` 中。

### `omp install`

别名 `plugin install` / `plugin link` 的统一入口，本地路径走 `link`（符号链接并实时监听变更），其他目标走 `install`（从 npm 或 marketplace 拉取）。

语法

```text
omp install <target> [...]
omp install <target> [--json] [--force] [--dry-run] [--scope user|project]
```

功能

- 把本地目录、npm 包或 `name@marketplace` 形式的引用加入插件集合；存在 `targets` 时按出现顺序处理，先把所有本地路径链接，再一次性安装所有远程 spec。
- 当 `target` 是相对/绝对路径、以 `~` 开头、包含 Windows 盘符前缀，或在当前工作目录下作为目录存在时，识别为本地路径并调用 `plugin link`；其余一律调用 `plugin install`。
- 不带任何参数时打印 `Usage: omp install <path | npm-spec | name@marketplace> [...]` 并以退出码 `1` 退出，不会做任何写操作。

效果

- `plugin link` 在 `plugin set` 中创建指向本地目录的符号链接，启动 `omp` 时会监控该目录的修改，编辑文件无需重新执行命令（与 `extension-authoring` 文档描述一致）。
- `plugin install` 解析 npm spec（如 `my-pkg@1.2.3`）或 `name@marketplace`，下载并写入插件目录；远程安装会跟随 `omp.rename` 等迁移指针。

适用时机

- 开发本地扩展、想立即看到效果：使用 `omp install ./my-extension`。
- 试用或固化远程扩展：使用 `omp install my-pkg@1.2.3`、`omp install name@marketplace`。

参数

- `targets <string…>` 必填、变长。描述："Local path, npm spec, or marketplace ref (e.g. ./my-ext, my-pkg@1.2.3, name@marketplace)"。可一次传入多个，混合本地和远程亦可，按用户给定顺序处理。
- `--json` 输出 JSON 形式的执行结果（透传给底层 `plugin` 命令）。
- `--force` 强制安装，会覆盖本地同名目标或已存在版本，是破坏性选项。
- `--dry-run` 仅展示将执行的动作，不实际写入磁盘；适合先核对再放行。
- `--scope <user|project>` 安装作用域，仅对 marketplace 安装生效；`user`（默认）写入用户级插件目录，`project` 写入项目级 `.omp/` 目录以便提交到版本控制。

注意

- 不存在隐式 “全部安装” 行为；省略参数会被显式拒绝。
- 路径解析依赖 `process.cwd()`，在仓库根目录外执行会按相对路径搜索目录；需要绝对链接时使用 `./` 或 `/` 前缀。

示例

```text
omp install ./my-extension
omp install my-pkg@1.2.3
omp install pkg-a pkg-b --dry-run --json
omp install can1357/oh-my-pi@extensions --scope project
```

### `omp update`

检查并安装 `omp` 自身的更新，并可同时切换发布通道（`stable` / `canary`）以及更新已安装的插件。

语法

```text
omp update [-f] [-c] [-l] [--canary] [--stable]
```

功能

- 默认从 npm 仓库（`@oh-my-pi/pi-coding-agent`）或 GitHub Releases 拉取最新发布，匹配到当前安装方式（Homebrew / mise / Nix / bun / npm / 独立二进制）后执行对应升级流程；通过 `omp --version` 校验后打印结果。
- 当解析到的 `omp` 二进制位于 `PATH` 优先项时，升级路径完全自动；Nix 安装会主动拒绝并提示更新 flake 入口。
- `--canary` 切换到 canary 通道并升级；`--stable` 切回 stable 通道；切换通道会被持久化到设置。
- `--plugins` 透传为 `plugin upgrade`，只更新已安装插件而不动 `omp` 自身。

效果

- 升/降级二进制、覆盖符号链接、迁移 `omp.rename` 旧名称包；版本校验失败时回滚到原二进制并以非零码退出。
- 当 release 是 binary-only 时（`shouldForceBinaryUpdate`），bun/npm 全局脚本启动器会被脚本 `takeover` 或就地替换；会提示 “This install is no longer managed by bun/npm”。

适用时机

- 日常检查新功能与修复：直接 `omp update`。
- 想先看是否有新版而不升级：加 `--check`。
- 验证最新预发布：加 `--canary`。
- 仅想刷新插件（与 `omp` 自身无关）：加 `--plugins`。

参数

- `-f, --force` 强制重装当前版本。`compareUpdateVersions` 在不是通道切换时返回 `<=0` 会判定 “已最新”，加 `--force` 才能绕开；属于破坏性操作，会重写现有安装。
- `-c, --check` 只检测不安装；命中后 `return`，跳过所有写操作。
- `-l, --plugins` 仅更新已安装插件。等价于 `omp plugin upgrade`；不触发 `omp` 自身升级。
- `--canary` 切到 canary 通道并升级。仅 bun/npm/独立二进制安装支持；Homebrew / mise / Nix 会打印警告并退出。
- `--stable` 切回 stable 通道。
- `--canary` 与 `--stable` 互斥；同时给出会被 `CliUsageError` 拒绝。

注意

- GitHub Release 元数据调用可能因限流失败；可通过 `GITHUB_TOKEN` 或 `GH_TOKEN` 环境变量携带凭据再重跑。
- `PI_UPDATE_REPOSITORY` 可临时改变解析的发布仓库（fork 自检用）；不推荐日常使用。
- 在 Nix 下该命令是只读提示，不会改写 store；需要通过 flake 更新。
- `omp update --plugins` 不会运行 `omp` 自身的升级流程。

示例

```text
omp update
omp update --check
GITHUB_TOKEN=ghp_xxx omp update --canary
omp update --plugins
omp update --stable
```

### `omp gc`

对本地 agent 数据目录做存储级垃圾回收：清理未引用的 blob、归档冷会话、检查 SQLite WAL 默认开启 dry-run，所有操作需要 `--apply` 才会真正落盘。

语法

```text
omp gc [--apply] [--json] [--agent-dir <path>]
       [--blobs] [--archive] [--wal]
       [--cold-archive-after-days <n>]
       [--retain-newest-global <n>] [--retain-newest-per-cwd <n>]
```

功能

- 不带 `--apply` 时是 dry-run：打印会回收多少对象、预计释放多少字节，不修改任何文件。
- 默认会跑全部三类子动作（blobs / archive / wal），其开关来自设置 `gc.blobs`、`gc.archive`、`gc.wal`（全部 `true`）；任一显式 `--blobs` / `--archive` / `--wal` 出现后，本次只跑显式列出的子动作，覆盖设置。
- `blobs`：扫描 agent 数据目录下形如 `<sha256>[.<ext>]` 的 blob 文件，删除未被任何会话 JSONL 引用（正则 `blob:sha256:<hex>`）的条目。
- `archive`：将 `pending/interrupted/unknown` 之外、且年龄超过 `--cold-archive-after-days` 的冷会话（`.jsonl`）gzip 到 `archive/sessions/`，同步在 `history` 与 `stats` SQLite 中删除对应行并重建 FTS。
- `wal`：对 `history.db` 与 `model.db` 跑 SQLite WAL checkpoint（`PASSIVE` 或 `TRUNCATE`，取决于 `--apply`）。
- 内部以文件锁 `gc.lock` 互斥；锁过期或来自已退出进程时会被自动打破并接管。

效果

- dry-run：返回每个子动作的 `wouldDelete` / `wouldArchive` / `wouldCheckpoint` 等计数；磁盘无修改。
- apply：执行真实删除、归档、checkpoint；任何子动作抛错都会被聚合到返回值的 `errors[]` 并在退出前以 `GC completed with N error(s)` 形式写入 stderr，同时 `process.exitCode = 1`。

适用时机

- 想确认能回收多少空间：先 `omp gc --json` 评估。
- 磁盘紧张或计划归档：执行 `omp gc --apply`。
- 仅想清理 blob：使用 `--blobs` 配合 `--apply`。
- 想把旧会话移到 archive 目录：使用 `--archive --apply --cold-archive-after-days 30`（`30` 为默认）。
- 想释放 WAL 体积：使用 `--wal --apply`。

参数

- `--apply` 真正落盘。默认 dry-run；省略 `--apply` 时所有改动只计算、不写。
- `--json` 以 JSON 形式输出结果（`GcResult`），方便脚本解析。
- `--agent-dir <path>` 显式指定 agent 数据目录；缺省时调用 `getAgentDir()` 解析。
- `--blobs` / `--archive` / `--wal` 显式启用某一类子动作；只要出现其一，本次就只跑列出的子动作并忽略设置项。
- `--cold-archive-after-days <n>` 会话归档的最低年龄（天），默认 `30`（来自 `gc.coldArchiveAfterDays` 设置）。负数或非整数会被规范化为 `0`。
- `--retain-newest-global <n>` 全局始终保留的最新会话数，默认 `20`（`gc.retainNewestGlobal`）。
- `--retain-newest-per-cwd <n>` 按工作目录始终保留的最新会话数，默认 `10`（`gc.retainNewestPerCwd`）；保留规则是 “and” 关系：必须同时满足两个保留数才不被归档。
- 所有数值类参数都会被 `Math.max(0, Math.floor(value))` 规整；传负数等同于 `0`。

注意

- 默认是 dry-run，最容易踩的坑就是忘记加 `--apply`，发现什么都没发生。
- 归档是 gzip 不可逆过程：会话内容仍可读，但 JSONL 文件变成 `.jsonl.gz`；如果脚本直接遍历 `*.jsonl` 需要适配。
- `history` 与 `stats` 库的对应行会随归档被删除；如需长期审计请在归档前导出。
- 并发运行 `omp gc` 会被文件锁挡住；旧的锁文件若被遗留，工具会按 `pid` 存活与否决定是否破锁。
- 数值参数与设置项同时存在时，命令行值优先。

示例

```text
omp gc --json
omp gc --apply
omp gc --blobs --apply
omp gc --archive --apply --cold-archive-after-days 14 --retain-newest-per-cwd 5
omp gc --wal --apply
omp gc --agent-dir /tmp/agent-data --apply
```

### `omp compress`

把文本文件改写为 “密集型 prompt 风格”，每轮生成候选 + 审核 + 修订；批准后写出，可原地覆写或写到指定文件。

语法

```text
omp compress <file|glob> [...] [-o <out>] [-i] [-r <rounds>] [-n <agents>] [-m <model>]
```

功能

- 对每个输入文件/glob 走 “起草 → 审核 → 修订” 循环；当前 `DEFAULT_MAX_ROUNDS = 3`，到上限仍未通过审核就跳过该文件，退出码非零。
- 单个文件且不指定 `--out` / `--in-place` 时，批准结果直接打印到 stdout（`emitToStdout`）。
- 多个文件必须 `--in-place`，否则抛出 `${count} files matched; pass --in-place to rewrite them (--out takes a single file)`。
- glob 解析使用 `Bun.Glob(...).scanSync({ dot: true })`，可命中 `.omp/commands` 等点目录；glob 未匹配到任何文件会抛错 `No files matched "<pattern>"`，不会静默返回空集合。

效果

- 默认从当前 `process.cwd()` 解析文件，项目目录仅用于设置查找（不会改变压缩行为）。
- `--in-place` 用 `fs.writeFile` 覆写源文件，`--out <path>` 把单文件批准结果写到指定路径；二选一，同时给出会被 `CliUsageError` 拒绝。
- 并行上限 `--agents` 同时压缩的文件数（默认 `4`），不是单文件内部多轮并发。

适用时机

- 写完一份很长的 prompt/system 指令、想瘦身为同样语义但更省 token 的版本。
- 给一整套 prompt 做批量 “密度化”，例如 `omp compress 'prompts/**/*.md' -i`。
- 想用更激进的模型一次到位：`-m opus` 并把 `-r` 调大。

参数

- `files <string…>` 必填、变长。每个条目要么是字面路径（相对/绝对均可），要么是含 `*?[]{}` 的 glob 模式；字面路径若不存在或不是文件会立即抛 `Not a file: <path>`。
- `-o, --out <path>` 把批准文本写到指定文件；只能与单文件场景一起用（多文件时抛错），与 `--in-place` 互斥。
- `-i, --in-place` 覆写每个源文件；与 `--out` 互斥。
- `-r, --rounds <n>` 单个文件最大草稿轮数，默认 `3`；必须正整数，传 `0` 或负数会抛 `--rounds must be a positive integer`。
- `-n, --agents <n>` 并行处理的文件数，默认 `4`；同样必须正整数。
- `-m, --model <selector>` 压缩用的模型选择器（透传给模型注册表），缺省时使用当前 session 配置的默认模型。

注意

- 压缩不可逆；`--in-place` 之前最好用版本控制或备份。
- glob 模式区分大小写；想命中 `PROMPTS/` 这种大写目录需用对应大小写。
- 长文件会消耗较多 token；先用 `-n` 控并发、配合 `-r` 避免无限循环。
- 这是面向 prompt 的工具，不适合压缩二进制/已是表格的 CSV。

示例

```text
omp compress prompts/tools/read.md
omp compress notes.md -o notes.compressed.md
omp compress 'src/prompts/**/*.md' -i
omp compress a.md b.md c.md -i -n 8
omp compress spec.md -r 5 -m opus
```

### `omp cleanse`

调度并行子 agent 自动检测并修复项目里常见的诊断（lint / typecheck / 未使用 import 等）；可附请求让发现 agent 决定要跑的命令，也可附带测试。

语法

```text
omp cleanse [<request>] [-n <agents>] [-m <model>] [-t] [-a]
```

功能

- 在 `getProjectDir()` 作用域内发现可执行检查器（`runCleanse` → `checkers.ts`）；不带 `<request>` 时进入交互式 picker，让用户选择要跑的检查器。
- 把每个检查器拆为文件不相交的批，交由最多 `--agents` 个子 agent 并行处理；每个子 agent 跑 `run_fix_check` 模式（`fix` 而非 `verify_only`），并通过状态板输出进度。
- 修复完成后会重跑同一检查器进行 verify；不通过则再次派发（受 `--agents` 上限约束）。
- `--all` 跳过 picker，一次性跑所有发现的检查器。
- `--tests` 在每个检查器最后再跑一遍项目配置的测试套件（`includeTests`），把失败也作为待修项。
- `<request>` 是个自由文本描述（例如 `"ts errors"`），交给发现 agent 决定要执行的命令；不会与 picker 互斥，但提供后会以请求优先。

效果

- 会在工作区直接修改源文件以修复问题；属于破坏性写操作，应在版本控制或隔离 worktree 中执行。
- 每次 agent 启动、进度、完成都会写到 `CleanseStatusBoard`；在 CLI 下会渲染到 stdout/TUI，在 TUI 模式下显示为覆盖层。
- SIGINT/SIGTERM 触发 `AbortController`，当前正在执行的 agent 会被取消、已批准修改保留；返回 `CleanseCommandResult` 后通过 `postmortem.quit(result.exitCode)` 透传退出码。
- 包含发现/选择/修复/验证的完整阶段，耗时较长；`-n` 调大不会让单文件修复变快，但能让多个 checker 并行。

适用时机

- 跑完一次大改动后想自动消化 lint / 类型错误：直接 `omp cleanse`。
- 只关心某一类问题、想让 agent 自定义命令：`omp cleanse "ts errors"`。
- CI 风格全量跑：加 `--all` 并配合 `-t`。
- 想控制算力/费用：调小 `-n` 或换 `-m @smol`。

参数

- `request <string>` 可选。自由文本描述交给发现 agent，例如 `"ts errors"`；不传时进入交互式 picker，要求选检查器。
- `-n, --agents <n>` 文件不相交子 agent 的最大并发数，默认 `32`；必须正整数，传 `0` 或负数会被 `CliUsageError` 拒绝。
- `-m, --model <selector>` 子 agent 的模型选择器，默认 `@smol`；注意默认是 “小模型” 以省成本，复杂项目可换 `opus` 或 `anthropic/claude-opus-4-6`。
- `-t, --tests` 同时运行项目配置的测试套件，作为额外修复目标；会让单次运行显著变慢。
- `-a, --all` 跳过 picker，跑所有发现到的检查器；适合无头/CI 环境。

注意

- 工作对象是源文件，不只读；运行前请确保工作树是干净或在 worktree 中。
- 一次只跑一个 `<request>`；多目标请分开执行。
- 子 agent 修复失败时不会自动还原；建议配合 `git status` 与版本控制 review。
- “`--all`” 会把所有发现的检查器都跑一遍，可能包含耗时的端到端测试；CI 场景可用 `-t` 显式启用。
- 不应手工把 `omp cleanse` 接到生产部署脚本里：它是带写操作的开发期工具。

示例

```text
omp cleanse
omp cleanse --all
omp cleanse "ts errors"
omp cleanse -n 8
omp cleanse -m opus
omp cleanse -t
omp cleanse --agents 12 --model anthropic/claude-opus-4-6
```

### `omp stats`

把 session 文件中的 token / 成本 / 模型使用统计同步到本地数据库，并提供 JSON、控制台摘要、内嵌 Web 仪表盘三种查看方式。

语法

```text
omp stats [-p <port>] [--host <host>] [-j] [-s]
```

功能

- 入口固定先调用 `syncAllSessions`，把新写入的 JSONL 增量同步进 stats DB；同步结束后打印 `Synced <n> new entries from <m> files (<total> total)`。
- `-j, --json` 直接调用 `getDashboardStats()` 并 `JSON.stringify` 到 stdout；写完后 `return`，不开端口。
- `-s, --summary` 把 Overall / By Model / By Folder 三个分块以纯文本打到 stdout；同样不开端口。
- 默认模式（无 `-j` / `-s`）启动内嵌 HTTP 仪表盘，绑定 `--host:port`（默认 `127.0.0.1:3847`），自动调用 `openPath(url)` 用系统默认浏览器打开，进程保持前台运行直到 `Ctrl+C` 触发 `closeDb()` 后 `exit(0)`。
- 三种模式互斥：先判断 `--json`，再判断 `--summary`，最后才起服务；同时给 `-j -s` 时 `-j` 生效。

效果

- 都会触发一次增量同步（写 stats DB）；开 Web 时 `process.on("SIGINT", …)` 监听退出，`Ctrl+C` 才能干净关闭。
- 端口冲突时（`EADDRINUSE`）直接抛错退出；可换 `-p`。
- 摘要输出包括：总请求数 / 错误数 / 错误率 / 总 token / 输入输出比 / 缓存命中率 / 缓存节省 / 总费用 / 高级请求数 / 平均时长 / 平均 TTFT / 平均 tokens/s / Top 10 模型 / Top 10 目录。

适用时机

- 想看仪表盘：`omp stats` 后浏览器自动打开。
- 想接进脚本 / dashboard：用 `omp stats --json`。
- 只想看汇总：`omp stats --summary`。
- 想给团队成员看：把 `host` 改成 `0.0.0.0`（注意只读 stats DB，开放前请评估安全风险）。

参数

- `-p, --port <n>` 仪表盘监听端口，默认 `3847`；冲突时启动失败。
- `--host <host>` 监听地址，默认 `127.0.0.1`；改为 `0.0.0.0` 可对外暴露，仍只读本地数据。
- `-j, --json` 输出 stats JSON；命中后 `return`，不会启动服务。
- `-s, --summary` 控制台打印汇总；同样不会启动服务。

注意

- 启动 Web 模式后必须用 `Ctrl+C` 退出；直接关闭终端会让端口被占用。
- `process.on("SIGINT", …)` 已在内部注册，自定义信号处理可能干扰关闭流程。
- 不带参数时 `openPath` 会尝试调系统默认浏览器；纯服务器/无 GUI 环境会失败但服务仍正常监听。

示例

```text
omp stats
omp stats --summary
omp stats --json > stats.json
omp stats --port 9000 --host 0.0.0.0
```

### `omp usage`

查看已认证账号的提供方用量上限、限速历史、按客户端的 token 消耗；支持缓存失效。

语法

```text
omp usage [invalidate|clients] [-j] [-p <provider>] [-r] [--history] [-d <days>]
```

功能

- 无 `action`：对每个能查到 usage 的 provider 拉取实时报告，结合本地存储的账号与已禁用 tombstone，按 provider → account → limit 渲染条形图、重置时间、再登录倒计时。`--history` 时改为渲染每小时一次的限速历史（火柴人图）。
- `invalidate`：调用 `authStorage.invalidateUsageCache(provider?)` 清空缓存；带 `-p` 时只清一个 provider，不带则清全部。立刻打印 `Invalidated cached usage reports ...`。
- `clients`：列出每个客户端（hostname + 安装短 id）的 token 消耗汇总。优先从 auth broker（`OMP_AUTH_BROKER_URL` 配置）拉 fleet-wide 数据；本机为 broker 时回退到本地 agent DB。
- `--history` 切换到历史快照视图（每条历史记录是过去每小时一次的限速快照），通过 `listUsageHistory({ sinceMs, provider })` 读取。
- `--json` 在三种主路径上都生效：实时报告/历史/`clients` 各自生成结构化 JSON（实时报告会丢弃每个 provider 原始的 `raw` 字段以减小体积）。
- `--provider` 过滤指定 provider（不区分大小写）；同时影响 `accounts`、`reports`、`disabled tombstones`、历史视图。
- `--redact` 构建 “最短可区分子串” 遮罩映射，把所有展示的 email / accountId / projectId / orgId / orgName 替换成不可逆标签；适合截屏分享。
- `--days` 与 `--history` 或 `clients` 配合使用，控制时间窗长度，默认 `7` 天；非正数会被忽略回到 `7`。

效果

- 实时报告路径会先 `revalidateCredentials()` 再渲染，保证刚刚登录/轮换的凭据不会因为一小时缓存而显示为重复账号。
- 没有报告且没有账号时打印 `No credentials found ...` 或 `No usage data ...`；存在账号但全是非 usage provider 时会显式说明，避免误判为 “未登录”。
- `invalidate` 仅清缓存，不重新拉取；下次访问会再次请求上游。
- `clients` 路径若 broker 与本地都无数据，打印 `No per-client usage recorded yet ...` 并以退出码 `1` 退出（提示设置 broker）。

适用时机

- 跑长时间任务前看是否快到限速：`omp usage`。
- 想看趋势图：`omp usage --history --days 30`。
- 想看哪台机器/哪个安装烧了最多 token：`omp usage clients --days 30`。
- 误以为限速数据陈旧，强制刷新：`omp usage invalidate`，再重跑 `omp usage`。
- 只想看 Anthropic：`omp usage --provider anthropic`。
- 截屏分享前：`omp usage --redact`。

参数

- `action <invalidate|clients>` 可选子动作。`invalidate` 清缓存；`clients` 渲染客户端维度用量；不传则默认渲染实时/历史（取决于 `--history`）。
- `-j, --json` 输出 JSON；与 `--redact` 组合时，标识字段会在 JSON 里也被替换。
- `-p, --provider <id>` 仅显示指定 provider（不区分大小写），例如 `anthropic`、`openai`。
- `-r, --redact` 对 email / accountId / projectId / orgId / orgName 等做最短可区分子串遮罩；适合分享截图。
- `--history` 渲染历史快照（小时粒度）而不是实时报告；隐含了 “时间序列” 视图而非 “当前值” 视图。
- `-d, --days <n>` 历史窗口或 `clients` 窗口的天数，默认 `7`；与 `--history` 或 `clients` 配合生效，传 `0` / 负数会被忽略。

注意

- `invalidate` 不是强制重新拉取命令；它只清缓存，刷新要靠重新跑 `omp usage`。
- `clients` 依赖 broker 配置或本机 agent DB；若两者都为空需先设置 `OMP_AUTH_BROKER_URL` 或在 broker 主机上跑。
- `--redact` 使用 “最短可区分子串” 算法，只遮罩标识；窗口用量本身仍可见。
- 实时报告依赖 provider 当前的 usage endpoint；网络受限或被限流时会报错。
- 这是一个只读命令，但展示的用量可能与实际账单向略有时延（小时快照节奏）。

示例

```text
omp usage
omp usage --provider anthropic
omp usage --redact
omp usage --json
omp usage --history --days 30
omp usage clients --days 30
omp usage invalidate
omp usage invalidate --provider anthropic
```

### 七条命令的破坏性与并发性速查

| 命令 | 默认是否写盘 | 并发模型 | 与其他命令的关联 |
| --- | --- | --- | --- |
| `install` | 是（除非 `--dry-run`） | 串行：先批量 `link`，再一次性 `install` | 通过 `plugin install` / `plugin link` 工作；与 `update --plugins` 互不冲突 |
| `update` | 是 | 自动检测安装方式单线推进 | `update --plugins` 内部转 `plugin upgrade`，绕过自身升级 |
| `gc` | 否（默认 dry-run） | 内部文件锁互斥，blobs/archive/wal 可独立开关 | 归档后会改 stats / history DB；建议先 `gc --json` 再 `--apply` |
| `compress` | 视模式而定 | 多文件按 `--agents` 并行，单文件多轮串行 | 与 `cleanse` 不共享状态；`--in-place` 是覆写操作 |
| `cleanse` | 是 | 文件不相交批并行，最大 `--agents` | 会修改源文件；与 `compress` 没有依赖 |
| `stats` | 同步阶段写 stats DB；其他只读 | 单进程，前台保持运行 | 增量同步依赖 session JSONL；`Ctrl+C` 才会退出 |
| `usage` | 否（只读） | 同步访问 auth storage | `invalidate` 是唯一会修改本地缓存的子动作 |

### 何时该用哪一条

- 写好新 prompt 想瘦身：`compress`。
- 跑完改动想自动消化 lint / typecheck：`cleanse`。
- 怀疑本地存储占空间：先 `gc --json`，再 `gc --apply`。
- 想看本地数据库里的成本和模型分布：`stats`。
- 想知道 Anthropic / OpenAI 当前还剩多少配额：`usage`，或加 `--history` 看趋势。
- 想让某个本地插件生效：`install`。
- 升级 `omp` 自身或切通道：`update`。

## 诊断、基准与专用工具

### `omp bench`

针对模型的性能基准测试命令。它会按指定的工作负载（chat / prefill / generation / mix 或独立的 prompt-cache）对给定模型发起若干次流式请求，汇总每条请求的首 token 时间（TTFT）、整体耗时、输出吞吐、token 使用量以及（启用 `--cache` 时）缓存命中观测，作为 p50 / p95 等分布统计输出。**面向调试与模型选型**；普通用户在做日常开发时不需要它，仅当你想量化某个模型在 prefill、decode 或 prompt-cache 路径上的实际表现时才使用。运行会真实消耗 token 与可能的额度，请在低频调试时使用。

```bash
omp bench <models...> [flags]
```

- **功能**：在受控条件下对 1 个或多个模型跑相同的工作负载并对比。
- **效果**：完成时打印一张模型对比表（每模型一列，列出请求数、错误数、平均 TTFT、p50/p95 首 token、平均时长、平均 tokens/sec、prompt/completion token、缓存观测）。`--json` 输出机器可读版本。
- **何时使用**：评估新模型；比较不同模型的 prefill / decode 性能；验证 prompt cache 是否真在生效。

**位置参数**：
- `models` *(必填，重复)*：模型选择器，可写 `provider/model`（如 `openai/gpt-5.2`），也支持模糊 id（如 `opus`）。至少一个，建议 2+ 才有对比意义。

**选项**：
- `--runs <n>`：每模型请求数。默认值随 `--profile` 变化（`mix=9`、`chat=10`、`prefill=5`、`generation=5`）。
- `--max-tokens <n>`：单次请求的输出 token 上限。默认按 profile 选取（chat 512、prefill 64、generation 2048、cache 64）。
- `--prompt <text>`：自定义 prompt 文本。**仅当 `--profile chat` 或 `--profile generation` 时可用**。
- `--profile <name>`：工作负载。可选 `mix`（默认，轮转 chat/prefill/generation）、`chat`（平衡请求）、`prefill`（大输入、cache-busted，测输入处理）、`generation`（长强制输出，测持续 decode）。
- `--prefill-bytes <n>`：prefill 挑战的合成输入大小（字节）。默认 32768。
- `--service-tier <tier>`：按模型族应用服务等级；`none` 省略 tier。值取自 `tier.*` 配置。
- `--json`：以 JSON 形式输出汇总。
- `--par <n>`：并发请求数。默认 4。
- `--cache`：运行独立的 cold / warm prompt-cache 对（用于测量 prompt cache 行为）。**当前不支持 `openai-codex-responses`**。
- `--cache-prefix-file <path>`：`--cache` 模式下的稳定 prompt 前缀文件。
- `--cache-prefix-bytes <n>`：稳定前缀字节预算。默认 8192。
- `--cache-pairs <n>`：每模型的 cold / warm 对数。默认 1。
- `--cache-concurrency <n>`：并发的 cache 对数（每对内部仍顺序）。默认 1。

**示例**：
```bash
# 对比两个模型，混合挑战
omp bench anthropic/claude-opus-4-5 openai/gpt-5.2

# 用 3 次平均
omp bench opus gpt-5.2 --runs 3

# 隔离 prefill：64 KiB cache-busted 输入
omp bench opus sonnet --profile prefill --prefill-bytes 65536

# 隔离持续 decode 吞吐
omp bench opus sonnet --profile generation

# 强制 priority 服务等级
omp bench openai-codex/gpt-5.5:low --runs 10 --service-tier priority

# 测一组 cold / warm prompt cache
omp bench openai/gpt-5.6 --cache --json
```

**注意**：`--cache` 模式与 `openai-codex-responses` 不兼容；并发通过 `--par` 提高，但过高的并发在受限速率下会引发更多错误。每次运行都会真的产生请求与计费。

### `omp if-bench`

指令遵循与工作记忆的实验性基准。它为每个模型开启**一条**缓存化的会话线程：第 N 轮发起 N 条字形数组操作（操作的是模型自己上一轮报告的数组），同时一个会变化位置的 `nya{1,N}` 指令会在 prompt 的开头、中间和结尾轮转。模型的得分是它在丢失数组或丢失猫叫之前达到的深度，因此两种失败模式可从单次回复中分离出来。**这是实验性/诊断性命令**，目的是在指令遵循与持续工作记忆两个维度上区分模型；普通用户不需要它，仅在选型或回归排查时使用。

```bash
omp if-bench <models...> [flags]
```

- **功能**：用一个统一的“字形数组 + 移动 cat-sound 指令”压力测试，对比模型的工作记忆深度。
- **效果**：渲染实时进度面板（live board）与汇总 scoreboard；记录每个 turn 的失败类型（数组丢失 vs 猫叫丢失）。`--json` 输出每轮可机读转写。
- **何时使用**：评估模型在长上下文 + 多重动态指令下的稳定性；做指令遵循回归对比。

**位置参数**：
- `models` *(必填，重复)*：与 `omp bench` 相同的模型选择器语法。`provider/model` 或模糊 id（如 `opus`）。

**选项**：
- `--turns <n>`：每模型最大 turn 数；第 N 轮执行 N 个动作。默认 24。
- `--length <n>`：字符数组长度，**偶数**，范围 8–26。默认 24。
- `--max-tokens <n>`：每轮最大输出 token。默认 32768。
- `--nya-max <n>`：`nya{1,N}` 指令里允许的最长猫叫。默认 8。
- `--par <n>`：并发跑的模型数。默认 4。
- `--json`：输出 JSON 形式的每轮转写。

**示例**：
```bash
# 三个模型在增量数组机上对比
omp if-bench opus sonnet gpt-5.2

# 走得更深、串行跑
omp if-bench opus --turns 40 --par 1

# 更短的数组、更紧的猫叫
omp if-bench sonnet --length 12 --nya-max 2

# 机读每轮转写
omp if-bench opus --json
```

**注意**：基准围绕“数组报告与转移”这一人造模式设计；得分反映的是特定工作记忆维度，**不等同于真实编码能力**。`--turns` 越大，token 消耗越多。

### `omp dry-balance`

OAuth 账户负载均衡的**离线演练**。它针对某个 provider 解析出全部可用 OAuth 账户，用一批随机 session id 触发“按 session 选账户”的解析路径若干次（默认 100 次），统计每个账户被命中的次数与失败原因。配合 `--bench` 时会切换为对**每个 OAuth 账户**发起一次实时基准请求，输出 TTFT、TPS 与失败原因，**用于衡量每个账户的真实可达性**。**面向诊断/调试**，普通用户不需要它；只有怀疑均衡不均、某个账户被过度使用、或准备新增/重排账户时再使用。

```bash
omp dry-balance [model] [flags]
```

- **功能**：模拟 / 测量按 session 的 OAuth 账户选择行为。
- **效果**：默认以人读表格输出 `success`（按账户分布）与 `failure`（按原因分布）。`--bench` 时附加 `bench` 段（请求数、平均 TTFT、平均 TPS、失败原因）。`--json` 输出机器可读版本。
- **何时使用**：怀疑某个账户被多 session 并发抢占；想量化账户之间延迟差异；验证新账户加入后轮换是否生效。

**位置参数**：
- `model` *(可选)*：模型选择器（`provider/model` 或模糊 id）。缺省时使用配置的默认模型。

**选项**：
- `--model <selector>`：与位置参数同义；显式覆盖 `omp` 的 `--model` 写法。
- `--count <n>`：随机 session id 数量。默认 100。
- `--concurrency <n>`：并发解析上限。默认 32。
- `--json`：以 JSON 形式输出汇总。
- `--bench`：**切换模式**——为每个 OAuth 账户各发一次真实基准请求，**不再做随机 session 模拟**。此时 `--count` 与 `--concurrency` 被忽略。

**示例**：
```bash
# 默认模型的 100 个随机 session 演练
omp dry-balance

# 指定模型
omp dry-balance anthropic/claude-sonnet-4-5

# 大样本、限速并发
omp dry-balance --model openai-codex/gpt-5-codex --count 1000 --concurrency 64

# 并行测每个 OAuth 账户
omp dry-balance --bench

# 机读
omp dry-balance --json
```

**注意**：`--bench` 模式会消耗 token；它对每个账户各发一次请求，是真实流量。失败时 exit code 为 1。

### `omp grievances`

自动 QA 子系统记录的工具问题（“grievances”）的查看、清理与手动推送命令。Agent 运行时若检测到工具行为异常，会写入本地 sqlite 数据库；这些条目可定期上传给维护者。普通用户**通常不需要此命令**；它面向需要排查工具行为或希望手动控制上报节奏的维护者 / 高级用户。

```bash
omp grievances [action] [flags]
```

- **功能**：列出 / 清理 / 推送自动 QA 报告。
- **效果**：`list`（默认）按时间倒序打印最近 N 条报告（带模型、版本、工具名、报告内容）；`clean` 删除指定条目并返回数量；`push` 把所有未上传条目发到配置的端点。
- **何时使用**：发现某个工具反复异常想确认是否被记录；想清空数据库；想立刻把记录发到后端而不是等下次定时。

**位置参数**：
- `action` *(可选)*：默认 `list`；可选 `list`、`clean`、`push`。

**选项**：
- `-n, --limit <n>`：仅 `list`。展示最近 N 条。默认 20。
- `-t, --tool <name>`：`list` 与 `clean`。按工具名过滤 / 限定删除范围。
- `-j, --json`：以 JSON 形式输出。
- `--id <n>`：仅 `clean`。按 id 删除单条。
- `--all`：仅 `clean`。删除全部；并重置自增计数器，下一条从 1 重新开始。

**示例**：
```bash
# 列出最近报告
omp grievances

# 只看 find 工具的
omp grievances list --tool find

# 删除单条
omp grievances clean --id 209

# 删除某工具的全部
omp grievances clean --tool find

# 清空数据库
omp grievances clean --all

# 立刻推送
omp grievances push
```

**注意**：`--id`、`--tool`、`--all` **互斥**，同时指定多个会报错并 exit 1。`push` 需要配置上报端点（默认 `qa.omp.sh/v1/grievances`），未配置时跳过并提示设置 `dev.autoqaPush.endpoint` 或 `PI_AUTO_QA_PUSH_URL`。未检测到数据库时返回空结果而非报错。

### `omp ttsr`

Time-Traveling Stream Rules（TTSR）的检视与试运行命令。TTSR 是把正则 / AST 条件套在流式模型输出（文本、思考或工具调用）上的规则系统，`ttsr` 让你在不打模型的情况下直接验证规则是否会触发。**面向规则作者**，普通用户不需要；只有你在编写 `.omp/rules/*.md` 或调试“为什么这条规则没生效”时再使用。

```bash
omp ttsr [action] [snippet] [flags]
```

- **功能**：列出 / 试运行 / 扫描 TTSR 规则。
- **效果**：`list` 打印当前项目（与用户配置）注册的全部 TTSR 规则（条件、scope、globs、来源 provider）；`test` 把一段文本/文件通过真实的 TTSR 匹配管线，输出哪些规则触发与每个被求值规则的命中状态；`scan` 对目录中的文件批量跑规则，发现真实文件上的命中。
- **何时使用**：写新规则时验证正则/AST 是否生效；排查规则未触发的根因；对代码库做一次性扫描。

**位置参数**：
- `action` *(可选)*：默认 `list`；可选 `test`、`list`、`scan`。
- `snippet` *(可选)*：对 `test` 是内联文本片段；对 `scan` 是要扫描的目录。`test` 时若该值解析为已存在的文件路径，会被当作 `--file` 用，`--file` 始终优先。

**选项**：
- `--file <path>`：仅 `test`。从文件读取片段；用 `-` 显式表示 stdin。
- `-r, --rule <path>`：仅 `test` / `scan`。指定**单条**规则文件做隔离测试，跳过项目级规则加载，便于反复迭代某条规则。
- `--source <text|thinking|tool>`：仅 `test`。匹配源；省略且 `--file` 指向源代码扩展名时推断为 `tool`（默认 tool name 为 `edit`），否则推断为 `text`。
- `--tool <name>`：仅 `test`，`--source tool` 时使用。默认 `edit`。
- `-p, --path <path>`：仅 `test`。用于 scope/glob 匹配与 AST 语言推断的候选文件路径。
- `-v, --verbose`：展示**每个**被求值的规则（命中与未命中），不只命中。
- `--json`：以 JSON 输出。
- `--no-gitignore`：仅 `scan`。包含被 `.gitignore` 排除的文件。
- `--max-bytes <n>`：仅 `scan`。单文件大小上限（字节）；`0` 禁用。默认 5 MiB。

**示例**：
```bash
# 列出当前项目全部 TTSR 规则
omp ttsr list

# 用内联片段测试
omp ttsr test 'const x: any = 1'

# 测试整文件（自动按路径解析）
omp ttsr test src/foo.ts

# 显式指定文件与匹配源
omp ttsr test --file src/foo.ts --source text

# 隔离测某条规则
omp ttsr test --rule .omp/rules/no-any.md --source tool --path src/foo.ts 'const x: any = 1'

# 从 stdin 喂入
echo 'Box::leak(&mut v)' | omp ttsr test --file - --path src/lib.rs

# 显式指定 tool 名
omp ttsr test --source tool --tool write --path src/foo.ts 'const x: any = 1'

# 对目录批量扫描
omp ttsr scan src/

# 用某条规则扫目录
omp ttsr scan -r .omp/rules/no-any.md src/
```

**注意**：TTSR 规则的匹配源有严格语义——若 `--file` 指向非源代码扩展名（不在内置源代码扩展名集合内）且未显式给 `--source`，会推断为 `text`；此时 `tool:` 范围的规则**永远**不会命中。`--verbose` 输出会显著增大，请按需开启。`--no-gitignore` 扫描可能非常慢。规则未注册或规则未带 `condition` / `astCondition` 时输出黄色提示并 exit 1；隔离模式下若未触发任何规则，exit code 也会被置为 1。**此命令是规则作者的内部工具，普通用户应避免手工调用**。

## 交互界面的全部快捷键

### 交互界面快捷键总览

本文列出 **默认** 状态下的全部交互界面快捷键。事实源是 `packages/tui/src/keybindings.ts`（通用编辑/选择/输入）和 `packages/coding-agent/src/config/keybindings.ts`（应用级）。所有键位在 `agentDir/keybindings.yml`（或旧版 `keybindings.json`）中被用户改写后行为即随用户配置改变；TUI 的冲突检测（`KeybindingsManager.#rebuild`）会按用户重新声明的归属生效，未改写时按下表工作。

修饰键名称按 `keyHintPlatform()` 渲染：macOS 上 `alt` 显示为 `Option`，`super` 显示为 `Cmd`；其它平台保持 `Alt` / `Super`。非 macOS 终端中 `App.clipboard.pasteImage` 的默认键平台差异见下文。

---

#### 1. 输入编辑（主编辑器，行内字符级）

在主编辑器聚焦、未触发自动补全下拉时这些键位生效；它们来自 `TUI_KEYBINDINGS` 的 `tui.editor.*` 系列。`tui.editor.*` 与 `app.*` 的处理顺序：在 `custom-editor.ts` 中由 `#actionMatchKeyUnion` 先匹配应用级 action，再走 `#customMatchKeys` 扩展钩子；未命中后回退到行内编辑逻辑（`#handleInputChunk`）。

| 按键 | 绑定 ID | 行为 | 何时使用 |
| --- | --- | --- | --- |
| `Left` / `Ctrl+B` | `tui.editor.cursorLeft` | 光标左移一格 | 在输入框内精细定位 |
| `Right` / `Ctrl+F` | `tui.editor.cursorRight` | 光标右移一格 | 同上 |
| `Up` | `tui.editor.cursorUp` | 光标上移一行（多行输入时） | 编辑多行内容 |
| `Down` | `tui.editor.cursorDown` | 光标下移一行 | 同上 |
| `Alt+Left` / `Ctrl+Left` / `Alt+B` | `tui.editor.cursorWordLeft` | 光标左移一个词 | 跨词跳转 |
| `Alt+Right` / `Ctrl+Right` / `Alt+F` | `tui.editor.cursorWordRight` | 光标右移一个词 | 同上 |
| `Home` / `Ctrl+A` | `tui.editor.cursorLineStart` | 跳到行首 | 行首/行尾跳跃 |
| `End` / `Ctrl+E` | `tui.editor.cursorLineEnd` | 跳到行尾 | 同上 |
| `Ctrl+]` | `tui.editor.jumpForward` | 跳跃到当前行下一个指定字符 | Vi 风格跳转 |
| `Ctrl+Alt+]` | `tui.editor.jumpBackward` | 跳跃到当前行上一个指定字符 | 同上 |
| `PageUp` | `tui.editor.pageUp` | 上滚一页 | 长多行编辑 |
| `PageDown` | `tui.editor.pageDown` | 下滚一页 | 同上 |
| `Backspace` | `tui.editor.deleteCharBackward` | 删除光标前一个字符 | 日常修字 |
| `Delete` / `Ctrl+D` | `tui.editor.deleteCharForward` | 删除光标后一个字符 | 注意：编辑器为空时光标在末尾的 `Ctrl+D` 仍映射到删除字符；退出应用是 `app.exit` 行为（见下文），由 `custom-editor` 中更外层的 `app.exit` 检查接住 |
| `Ctrl+W` / `Alt+Backspace` / `Ctrl+Backspace` / `Super+Alt+Backspace` | `tui.editor.deleteWordBackward` | 向后删一个词 | macOS 上常用 `Option+Backspace` |
| `Alt+Delete` / `Alt+D` / `Super+Alt+Delete` / `Super+Alt+D` | `tui.editor.deleteWordForward` | 向前删一个词 | 双向修词 |
| `Ctrl+U` | `tui.editor.deleteToLineStart` | 删到行首 | 整段清空重写 |
| `Ctrl+K` | `tui.editor.deleteToLineEnd` | 删到行尾 | 同上 |
| `Ctrl+Y` | `tui.editor.yank` | 粘贴最近一次删除/剪贴的内容（kill ring） | 恢复误删 |
| `Alt+Y` | `tui.editor.yankPop` | 在 kill ring 中轮换粘贴 | 连续恢复 |
| `Ctrl+-` / `Ctrl+_` | `tui.editor.undo` | 撤销编辑 | 编辑回滚 |
| `Ctrl+.` | `tui.editor.spellingSuggestions` | 调出拼写替换建议 | 触发自动补全的拼写分支 |

- `Ctrl+Backspace` 同时属于 `tui.editor.deleteWordBackward`。`app.session.deleteNoninvasive`（默认 `Ctrl+Backspace`）在 keybindings registry 中**仅声明，运行时未接线**——会话选择器内按下 `Ctrl+Backspace` 不会触发任何 session 动作，编辑器聚焦时仍按 `tui.editor.deleteWordBackward`（向后删一个词）处理。
- `tui.editor.deleteCharForward` 的 `Ctrl+D` 别名只起删除字符作用；真正的退出应用是 `app.exit`（默认 `Ctrl+D`）的独立绑定，由 `custom-editor.ts` 的 `onExit` 处理（保存草稿后退出）。`app.session.delete`（默认 `Ctrl+D`）同样**仅在 registry 声明、未接线**，会话选择器内按 `Ctrl+D` 走的是 `app.exit`。
---

#### 2. 输入编辑（自动补全/拼写建议下拉）

下表动作都在 `editor.ts` 的 `#handleInputChunk` 中检查：进入 `assist` 状态后，`tui.select.*` 键控制列表选择，`tui.input.submit` / `Tab` 接受，`tui.select.cancel` 关闭。

| 按键 | 绑定 ID | 行为 |
| --- | --- | --- |
| `Up` / `Down` | `tui.select.up` / `tui.select.down` | 在下拉项中上下移动；到达首/尾时回绕（`select-list.ts`） |
| `PageUp` / `PageDown` | `tui.select.pageUp` / `tui.select.pageDown` | 一次翻一页（可视行） |
| `Enter` | `tui.input.submit` | 接受当前选中项（不发送消息，下拉里直接落地） |
| `Tab` | `tui.input.tab` | 强制接受当前选中项；路径补全也走它 |
| `Shift+Enter` / `Ctrl+J` | `tui.input.newLine` | 插入换行而不接受补全 |
| `Escape` / `Ctrl+C` | `tui.select.cancel` | 关闭自动补全；其余场景由 `app.interrupt` 接管 |

注意：自动补全的 “关闭” 与 “中断当前操作” 共用 `Escape`；当工作流正在执行时，编辑器会通过 `tui.editor.undo` 之前的分支把 `Escape` 路由到 `app.interrupt`（见 §6）。

---

#### 3. 导航/选择（列表、选择器、设置表）

选择器组件（`select-list.ts` / `settings-list.ts` / `cancellable-loader.ts`）统一监听 `tui.select.*`。触发条件：当前焦点处于列表型组件（模型选择器、会话选择器、主题选择器、Slash 命令面板、设置表、加载取消等）。

| 按键 | 绑定 ID | 行为 |
| --- | --- | --- |
| `Up` | `tui.select.up` | 选中上一项（到达顶部回绕到底） |
| `Down` | `tui.select.down` | 选中下一项（到达底部回绕到顶） |
| `PageUp` | `tui.select.pageUp` | 向上翻一页；在设置表里同时切换分组（`settings-list.ts`） |
| `PageDown` | `tui.select.pageDown` | 向下翻一页；设置表里切换分组 |
| `Enter` | `tui.select.confirm` | 确认当前选中项（裸 `\n` 也被识别为确认） |
| `Escape` / `Ctrl+C` | `tui.select.cancel` | 取消并关闭选择器 |

注意：选择器激活时，主编辑器的 `app.*` 键位被上层 UI 拦截（`ui.hasOverlay()` 判断）；只有选择器本身的导航键和 `app.tools.expand` 的全局监听（`input-controller.ts` 中标注为 “无论焦点都生效”）保留。

---

#### 4. 消息提交与会话流转

下列键在主编辑器内通过 `setCustomKeyHandler` 或 `setActionKeys` 注入（`input-controller.ts`），仅当编辑器聚焦、且无其它浮层占用键盘时触发。

| 按键 | 绑定 ID | 行为 | 触发前提 |
| --- | --- | --- | --- |
| `Enter` | `tui.input.submit` | 发送当前消息（主编辑器） | 编辑器聚焦、未在下拉 |
| `Shift+Enter` / `Ctrl+J` | `tui.input.newLine` | 插入换行而非发送 | 多行编辑 |
| `Ctrl+Q` / `Ctrl+Enter` | `app.message.followUp` | 跟队/追发消息（不打断主任务） | 主任务运行中或队列中已有消息 |
| `Alt+Up` / `Shift+Up` | `app.message.dequeue` | 弹出队列里上一条待发消息进行编辑 | 有排队的 follow-up 消息（macOS Terminal.app 拦截 `Alt+Up`，源码里把 `shift+up` 列在 `defaultKeys` 第二位作为兜底；同理 Windows 终端无法交付 `Ctrl+Enter`，`ctrl+q` 列在第一位以保证默认可用） |
| `Alt+R` | `app.retry` | 重试最近一次失败的助手回合 | 上一次回合失败时可用 |
| `Ctrl+C` | `app.clear` | 第一次按：清空编辑器/取消自动补全/中断当前流；500 ms 内第二次按：退出应用 | 编辑器非空时清空，空时计数；`isShuttingDown` 状态下再按一次 `process.exit(130)` |
| `Ctrl+D` | `app.exit` | 保存当前草稿并退出应用 | 编辑器内任何时候 |
| `Ctrl+Z` | `app.suspend` | 暂停到后台（POSIX 平台发 `SIGSTOP` 到前台进程组，Windows 直接 no-op） | 非 Windows |

注意：

- `Ctrl+Q` 之所以成为 `app.message.followUp` 的默认首位：Windows Terminal 无法发出与 `Enter` 不同的 `Ctrl+Enter` 事件（仓库内 issue #1903）。源码注释中明确写明这一点，并指出把 `ctrl+q` 放在 `defaultKeys` 数组首位以避免在 Windows Terminal 上失效。
- `app.message.followUp` 与 `app.clear` 都在 `setCustomKeyHandler` 注册顺序中位于 `app.clear` 之后；源码中的 fallback 逻辑（`getFallbackKey` / `userBindingClaimsKey`）会在用户把 `ctrl+q` 改写到别的动作上时，自动从 `app.message.followUp` 候选里移除 `ctrl+q`，避免被“偷走”。
- 双击 `Ctrl+C` 退出：第一次触发 `clearEditor()`，500 ms 内第二次进入 `shutdown()` 流程并保存草稿（`handleCtrlC` 实现）。`isShuttingDown` 状态下再按则硬退出 `process.exit(130)`（issue #2600）。

---

#### 5. 模型 / 思考 / 计划

| 按键 | 绑定 ID | 行为 |
| --- | --- | --- |
| `Alt+,` | `app.thinking.cycle` | 在 `off` / `low` / `medium` / `high` 等思考档位间循环 |
| `Alt+P` | `app.thinking.toggle` | 切换推理块（thinking block）的可见性（不改变档位，仅显隐） |
| `Ctrl+P` | `app.model.cycleForward` | 角色模型向前循环（slow → default → smol …） |
| `Shift+Ctrl+P` | `app.model.cycleBackward` | 角色模型向后循环 |
| `Alt+M` | `app.model.select` | 打开模型选择器，设定角色默认 |
| `Ctrl+T` | `app.model.selectTemporary` | 打开模型选择器，临时改本会话默认；状态栏会提示 `Session-only model` |
| `Shift+Tab` | `app.plan.toggle` | 切换 Plan 模式（接受计划 → 写入 `plan.md` → 切到实现） |

注意：

- `app.model.cycleForward`（默认 `Ctrl+P`）在编辑器聚焦时被实际接线，循环切换角色模型。`app.session.togglePath` 同样以 `Ctrl+P` 为默认键，但**仅在 keybindings registry 声明，运行时没有 handler/controller 消费**——会话选择器内按 `Ctrl+P` 不会切换路径列，编辑器聚焦时按 `Ctrl+P` 走 `app.model.cycleForward`。
- `app.thinking.cycle` 改变 LLM 请求的推理档位；`app.thinking.toggle` 仅影响 UI 上是否折叠推理块（见 `toggleThinkingBlockVisibility`），二者独立。
#### 6. 工具执行 / 视图折叠

| 按键 | 绑定 ID | 行为 | 触发前提 |
| --- | --- | --- | --- |
| `Ctrl+O` | `app.tools.expand` | 切换工具输出折叠/展开 | 全局监听，浮层下也能触发；当 `app.tools.toggleVisibility` 已隐藏工具活动时会提示先打开 |
| `Ctrl+Shift+O` | `app.tools.toggleVisibility` | 整体显示/隐藏工具活动（影响持久化设置 `display.hideToolActivity`） | 编辑器聚焦 |
| `Ctrl+G` | `app.editor.external` | 打开外部 `$EDITOR` 编辑当前草稿 | 编辑器非空时可用 |

注意：

- `app.tools.expand` 通过 `ui.addInputListener` 注册为全局监听（不受浮层焦点影响），但当焦点在 TreeSelector 等覆盖层且恰好是 `Ctrl+O` 时会被显式放行（`input-controller.ts` 第 313 行）。
- `app.editor.external` 触发的外部编辑器由 `openExternalEditor()` 处理；不同平台的 `$VISUAL` / `$EDITOR` 解析策略以源码为准。

---

#### 7. 模式 / 视图切换

| 按键 | 绑定 ID | 行为 |
| --- | --- | --- |
| `Ctrl+L` | `app.live.toggle` | 启停实时语音模式（`/live`） |
| 按住 `Space` | （手势）| 在 `stt.enabled` 为真时进行语音转文字推讲（push-to-talk） |
| `Alt+A` | `app.agents.hub` | 打开 Agent Hub（agent 列表面板） |
| `Ctrl+S` | `app.session.observe` | 同样打开 Agent Hub（与 `Alt+A` 等价，便于肌肉记忆） |
| 双击 `←`（空编辑器）| （手势）| 在编辑器空内容时连按 `Left` 打开 Agent Hub |
| `Ctrl+R` | `app.history.search` | 编辑器聚焦时打开历史搜索面板 |
| `Ctrl+P` | `app.session.togglePath` | 当前**仅有默认键定义，运行时未接线**——按 `Ctrl+P` 在编辑器内会走 `app.model.cycleForward`（循环角色模型），会话选择器内也不会切换路径列 |
| `Ctrl+D` | `app.session.delete` | 当前**仅有默认键定义，运行时未接线**——按 `Ctrl+D` 在任何上下文都走 `app.exit`（保存草稿后退出），会话选择器内不会执行删除动作 |
| `Ctrl+Backspace` | `app.session.deleteNoninvasive` | 当前**仅有默认键定义，运行时未接线**——按 `Ctrl+Backspace` 在编辑器内走 `tui.editor.deleteWordBackward`（向后删一个词），会话选择器内也不会触发非侵入式删除 |
| `Ctrl+Left` / `Alt+Left` | `app.tree.foldOrUp` | 当前**仅有默认键定义，运行时未接线**——这些键在编辑器内走 `tui.editor.cursorWordLeft`（光标左移一个词），树视图内也不会执行折叠/上移 |
| `Ctrl+Right` / `Alt+Right` | `app.tree.unfoldOrDown` | 当前**仅有默认键定义，运行时未接线**——这些键在编辑器内走 `tui.editor.cursorWordRight`（光标右移一个词），树视图内也不会执行展开/下移 |
| `Ctrl+S` | `app.session.toggleSort` | 当前**仅有默认键定义，运行时未接线**——`Ctrl+S` 已由 `app.session.observe` 占用为 “打开/关闭 Agent Hub”，本 ID 在会话选择器内不会触发排序切换 |
| `Ctrl+R` | `app.session.rename` | 当前**仅有默认键定义，运行时未接线**——`Ctrl+R` 已由 `app.history.search` 占用为 “打开历史搜索面板”，本 ID 在会话选择器内不会触发重命名 |

注意：

- `Alt+A` 与 `Ctrl+S` 都映射到“打开 Agent Hub”，由 `selector-controller.ts` 把两组键合并到 `hubKeys` 集合，避免在 hub 内再次按下时关闭——同一组键在 hub 关闭态按下打开、在 hub 内按下关闭（实现见 `agent-hub.ts` / `selector-controller.ts`）。
- 上表 §7 中以 “当前**仅有默认键定义，运行时未接线**” 标注的 7 个绑定（`app.session.togglePath` / `app.session.toggleSort` / `app.session.rename` / `app.session.delete` / `app.session.deleteNoninvasive` / `app.tree.foldOrUp` / `app.tree.unfoldOrDown`）仅在 `packages/coding-agent/src/config/keybindings.ts` 的 `KEYBINDINGS` 表与 `AppKeybindings` 接口中声明；源码搜索未发现任何 `setActionKeys` / `setCustomKeyHandler` / controller 消费这些 ID，因此无论是否在 `keybindings.yml` 中重新映射，当前都不能启用对应的 session/tree 行为。按下它们的默认键时，实际生效的是上文已接线的同键动作（`app.model.cycleForward` / `app.exit` / `tui.editor.deleteWordBackward` / `tui.editor.cursorWordLeft` / `tui.editor.cursorWordRight` / `app.session.observe` / `app.history.search` 等）。`KEYBINDING_NAME_MIGRATIONS` 把旧名 `toggleSessionNamedFilter` 迁到 `app.session.togglePath`，但迁移本身也不消费运行时输入。
- `app.session.new` / `app.session.tree` / `app.session.fork` / `app.session.resume` 的 `defaultKeys` 均为空数组 `[]`：这些动作只能通过 `Ctrl+C` 双击（清空开始新会话）、或调用 `/tree` / `/fork` / `/resume` slash 命令触发；用户可以在 `keybindings.yml` 中显式绑定快捷键启用。
- `app.stt.toggle` 的 `defaultKeys` 也是空数组；语音转文字默认靠“按住 Space”的手势触发（`stt.enabled` 开启时）。

---

#### 8. 剪贴板与图像

| 按键 | 绑定 ID | 行为 | 平台差异 |
| --- | --- | --- | --- |
| 平台相关（见下） | `app.clipboard.pasteImage` | 从剪贴板粘贴图片或文本（编辑器聚焦时） | Win：`Ctrl+V` / `Alt+V`；macOS：`Ctrl+V` / `Super+V`（`Cmd+V`）；其它：`Ctrl+V` |
| `Ctrl+Shift+V` / `Alt+Shift+V` | `app.clipboard.pasteTextRaw` | 以原始文本形式粘贴（不做合并/转换） | 全平台 |
| `Alt+Shift+L` | `app.clipboard.copyLine` | 复制当前行到剪贴板 | 全平台 |
| `Alt+Shift+C` | `app.clipboard.copyPrompt` | 复制整个提示（包含图片路径引用）到剪贴板 | 全平台 |
| `Ctrl+C` | `tui.input.copy` | 在选择器中复制当前选中项；编辑器内沿用 `app.clear` 行为 | 全平台 |

注意：

- `getDefaultPasteImageKeys(platform)` 决定了 `app.clipboard.pasteImage` 的默认键集合，源码中以三元运算符分别给出 win32 / darwin / 其它三类实现。同一 key 在不同平台只在该平台的 `defaultKeys` 中出现。
- 粘贴图片功能依赖终端对图像协议（iTerm2 / Kitty / Sixel 等）的支持；不支持时按文本处理。

---

#### 9. 中断、退出与系统控制

| 按键 | 绑定 ID | 行为 |
| --- | --- | --- |
| `Escape` | `app.interrupt` | 中断当前正在执行的 LLM/工具回合；也用于关闭自动补全和覆盖层（与 `tui.select.cancel` 同源） |
| `Ctrl+C` | `app.clear` | 第一次清空编辑器/中断回合；500 ms 内再按一次退出 |
| `Ctrl+D` | `app.exit` | 保存草稿后退出 |
| `Ctrl+Z` | `app.suspend` | 暂停到后台（POSIX） |
| `Alt+L` | `app.display.reset` | 重新探测终端背景/前景颜色并重绘（适用于中途切换浅/深色主题） |

注意：

- `app.interrupt` 的 `Escape` 在编辑器、自动补全、覆盖层、Agent Hub 内都被复用——`keybinding-matchers.ts` 提供的 `matchesAppInterrupt` 是统一入口，部分孤立的组件测试若未注册 app keybindings 则回退到原生 Escape 匹配。
- `Ctrl+Z` 在 Windows 上源码显式 no-op（`process.kill(_, 'SIGSTOP')` 在 win32 抛 `TypeError`），状态栏会显示 “Suspend (Ctrl+Z) is not supported on this platform”。

---

#### 10. 自定义、冲突与优先级

- **存储位置**：`agentDir/keybindings.yml`（优先）或 `keybindings.yaml`，旧版 `keybindings.json` 首次加载时按 `KEYBINDING_NAME_MIGRATIONS` 改写到 yml（`migrateKeybindingsConfigFile`）。
- **绑定名迁移**：`KEYBINDING_NAME_MIGRATIONS`（`packages/coding-agent/src/config/keybindings.ts:243-309`）把旧名（如 `cycleThinkingLevel`）映射到带命名空间的新名（`app.thinking.cycle`）。旧名仍可写在配置里，加载时自动迁移。
- **冲突检测**：`TUI_KEYBINDINGS` / `KEYBINDINGS` 在 `KeybindingsManager.#rebuild` 中聚合所有“用户声明”的按键到 `userClaims` 映射；当同一 `KeyId` 被两个以上用户重声明时记入 `#conflicts`，可通过 `getConflicts()` 取出。**默认键**之间本身存在共用（例如 `Ctrl+C` 同时是 `tui.select.cancel` 与 `app.clear`），但只对“用户重声明”产生的冲突报警。
- **fallback 移除**：`getFallbackKey` 集中处理两例自动 fallback：
  - `app.message.followUp` → 若用户把 `ctrl+q` 改写到别处（且 `app.message.followUp` 自身未自定义），自动从 `app.message.followUp` 候选中移除 `ctrl+q`（`removeKey` 配合 `userBindingClaimsKey`）。
  - `app.message.dequeue` → macOS 上若用户把 `shift+up` 改写到别处，自动从候选中移除 `shift+up`。
- **优先级**：
  1. 应用级 action（`#actionMatchKeyUnion`）优先于扩展自定义键（`#customMatchKeys`），因为前者先注册（`#rebuildCustomMatchKeys` 中“以先注册为准”）。
  2. `app.clear` 的二次按下走 `process.exit(130)` 硬退出，跳过所有 UI 状态（详见 §4）。
  3. `app.tools.expand` 通过全局 `addInputListener` 注册，编辑器/选择器内都触发；但当焦点在 TreeSelector 且按键是裸 `Ctrl+O` 时被显式放行（避免与树节点的折叠冲突）。
- **修饰键归一化**：`canonicalKeyId` 把 `Ctrl+]` 形式的修饰符按 `ctrl → shift → alt → super` 排序，并会把大写字母隐式加 `shift`；键位比较在 `KeybindingsManager` 中全部基于归一化后的 canonical id。

---

#### 11. 不建议手工触发的内部 / 隐藏动作

以下绑定 `defaultKeys` 为空（`[]`），仅供用户自行在 `keybindings.yml` 绑定，或由扩展 `setCustomKeyHandler` 使用，不应在没有 source 验证的情况下盲按：

- `app.session.new` — 新会话（等同双击 `Ctrl+C` 后再发送）
- `app.session.tree` — 打开会话树选择器（等同 `/tree`）
- `app.session.fork` — 从某条用户消息分叉（等同 `/fork`）
- `app.session.resume` — 恢复其它会话（等同 `/resume`）
- `app.stt.toggle` — 切换语音转文字（默认靠“按住 Space”手势，绑定此 ID 可换手势）

另外，`KEYBINDING_NAME_MIGRATIONS` 中的旧名称（`interrupt` / `cursorUp` / `selectUp` …）只在配置文件里兼容使用，不应该出现在键位提示或文档中。

## 按场景选择命令

### 首次安装与日常会话

进入 OMP 的最短路径：先跑一次 `omp setup` 把缺省 provider、键位、可选依赖（语音、tiny models 等）准备好，然后直接敲 `omp` 启动 TUI。每条命令的细节由其他主题展开，这里只回答**该按什么顺序走**。

- **第一次跑**：
  1. `omp setup` — 走 onboarding：选定默认 provider、写入凭据、勾选可选功能依赖。
  2. `omp models` — 列出当前账号下可用的模型；用作 fuzzy 匹配的现场参考（`opus` / `gpt-5.2` / `openai/gpt-5.2`）。
  3. `omp usage` — 在消耗大量 token 之前先看一眼每个认证账户的 provider 上限。
  4. `omp` — 进入 TUI；首轮 prompt 写在位置参数里即可。
- **脚本化问答**：`omp -p "…"`（或 `omp --print`）。非交互跑完就退出；适合做一次性抽取。
- **结构化批处理**：`omp --mode json` 走 JSONL 事件流；`omp --mode rpc` 走内部 RPC 协议，方便前端嵌入。
- **多账号 / 多场景隔离**：用 `--profile <name>` 启动独立 profile（auth、sessions、settings、caches 各自隔离），再 `omp --profile <name> --alias <shell>` 生成 shell 快捷方式，以后 `omp-<shell>` 直接进对应 profile。

什么时候**不要**用 `omp setup` 之外的命令：

- 只想看一眼当前能跑哪些模型 → 直接 `omp models`，不必进 TUI。
- 想看历史 token 消耗 → `omp stats`（本主题在「升级、清理与使用统计」中再展开）。

> 共享旗标与会话续接的细节（`--print`、`--mode`、`--profile`、`--alias` 等）见「启动交互与协议接入」与「初始设置、认证与模型」。

### 续接、恢复与导出会话

OMP 会自动把每次会话落到 `~/.omp/agent/sessions/...`（profile-scoped），下面的命令负责**取出或重塑**这些记录，而**不**改写模型行为；参数细节留给「Agent、会话协作与工作树」和「启动交互与协议接入」。

- **继续上一次**：`omp --continue "继续上次的话题"`（`--continue` 与 `-c` 等价），最常用、最短。
- **按 id/路径恢复**：`omp --resume <session-id-prefix|path>`（`-r`、`--session` 同义）。不传值时 `omp --resume` 直接打开选择器，从最近会话里挑。
- **派生新分支**：`omp --fork <session>` —— 把历史会话复制成一份独立的新会话，可继续改写而不污染原记录。
- **导入外部会话**：`omp --from-claude` / `omp --from-codex` —— 直接接续 Claude Code 或 Codex 的历史。**不要**与 `--continue`/`--resume` 同时使用，会撞车。
- **离线阅读**：`omp --export <session.jsonl>` —— 渲染成 HTML 后退出；不进 TUI、不消耗模型。
- **分享给协作者**：`omp share <session-id>`，等价 TUI 内的 `/share`，生成加密链接。配合 `omp join "<link>"` 让对方一键进入 TUI 协作。

决策要点：

- 只是想接着聊 → `--continue`。
- 知道 id 的一部分 → `--resume`。
- 想留主线不变、自己改新方向 → `--fork`。
- 想脱离 OMP 阅读 → `--export`。
- 想让对方直接进 TUI → `share` + `join` 组合。

### 并行 agent 与诊断清理

OMP 在大型任务里会用**加权并行子代理**自动派工；如果想**手动**调动这些能力、或者在跑完后**回收**残局，下面三条命令是入口。

- **检视 / 定制内置 agent**：`omp agents unpack [--project|--dir] [--force]`。把内置 task agent 导出为带 YAML frontmatter 的 Markdown，便于审计、修改或随项目提交（`--project` 写 `./.omp/agents`）。`--user` 与 `--project` 互斥。
- **自动诊断 + 修复**：`omp cleanse` —— 使用加权的并行子代理扫项目，自动发现并修复诊断问题。跑前先看一眼会话树里它派出了哪些子代理。
- **清理 worktree 残骸**：`omp worktree list` 看 `~/.omp/wt` 当前状态；`omp worktree clear` 默认只清 `orphaned`，`--all` 才会碰 `live` 的 PR-checkout 与 task-isolation 沙箱（**会**影响运行中的子 agent）。`wt` 是别名。

什么时候**不**用这套：

- 只想看后台进程 → `omp ps`（见「远程 / 隔离开发环境」里的「常驻进程监管」段）。
- 只想看哪些会话还活着 → `omp share` 出来的链接不涉及 worktree。

> 子代理、Agent Hub、并发模型的开关细节见「Agent、会话协作与工作树」。

### 远程 / 隔离开发环境

在远程主机、容器或一次性沙箱里跑 OMP 时，下面这些命令把**连接**、**权限**、**持久化**拆开，让你能按需放行或收紧。

- **管理远端连接**：`omp ssh` —— 增删改查 SSH 主机配置，让 OMP 知道哪些远端可用。
- **本地交互式 shell**：`omp shell` —— 直接进入一个隔离的交互式 shell 控制台，方便在 TUI 外做轻量运维。
- **跑 onboarding / 装依赖**：`omp setup` —— 在远端首次运行时把缺省 provider、可选功能依赖一次性装好。
- **运行态安全收紧**：
  - `--allow-home` —— 允许在 `$HOME` 启动而不被自动重定向到临时目录（**风险**：会污染 home 根目录，慎用）。
  - `--no-tools` / `--tools <a,b,c,…>` —— 关掉所有内建工具，或只保留白名单内的工具。
  - `--no-lsp` —— 禁掉 LSP 工具与诊断。
  - `--no-pty` —— 禁掉基于 PTY 的 bash。
  - `--approval-mode <always-ask|write|yolo>` —— 覆盖本次会话的工具审批级别（`yolo` 等价 `--auto-approve`/`--yolo`，只对受控环境使用）。
- **profile 隔离 + 路径叠加**：
  - `--profile <name>` —— 隔离 auth / sessions / settings / caches。
  - `--add-dir <dir>` —— 把额外工作区目录加入可见范围（可重复）。
  - `--session-dir <dir>` —— 自定义会话存储位置。
  - `--no-session` —— 临时会话，结束即丢。
- **常驻进程监管**：`omp ps`（详见「Agent、会话协作与工作树」）—— 列、看日志（`logs --follow`）、优雅停（`stop`）、兜底杀（`kill`）、重启（`restart`）。`--all`/`--global browser-relay` 一并看到机器级服务。

决策要点：

- 远端缺依赖 → `omp setup` + `omp ssh`。
- 想让 agent 在容器里工作但写不到 home → `--no-session --add-dir /work`。
- 想禁止 agent 跑任何外部命令 → `--no-tools` 或 `--approval-mode yolo` 的反向收紧。
- 怀疑长寿命进程泄漏 → `omp ps`，按需 `stop`/`kill`/`restart`。

> launch 旗标、profile bootstrap、approval-mode 详尽列表见「启动交互与协议接入」与 [approval mode](../approval-mode.md)。

### 代码搜索、阅读与提交流程

日常「看代码 → 改代码 → 写消息」三步在 OMP 里都有专门的命令入口。这一组命令**只**解决"取信息"和"把结果落盘到 git"，不会改变模型推理路径。

- **代码搜索**：`omp grep` —— CLI 形态调用 `grep` agent 工具（与 TUI 内 `grep` 工具是同一实现），适合在 shell 里快速复现 agent 的搜索结果。
- **预览文件 / URL**：`omp read <path|url|internal-uri>` —— 直接打印 read 工具将要返回的内容，便于在写 prompt 前先确认附件或路径。
- **交互式 git**：`omp git` —— 全屏 git UI：split diff 视图、staging 侧栏、commit composer；适合在 TUI 旁路直接审阅、stage、写提交。
- **自动生成 commit**：`omp commit` —— 让模型生成 commit message 并同步更新 changelog；适合把繁琐的「写 message + 维护 CHANGELOG」交给 agent。
- **查外部资料**：`omp search`（别名 `q`）—— CLI 形态跑 web search providers，结果与 TUI 内 `web_search` 工具一致。

典型串联：

```text
omp grep "TODO"           # 找到 TODO 列表
omp read src/foo.ts       # 预览要改的文件
omp git                   # 在交互 UI 里 stage + 写 message
# 或者：
omp commit                # 让 agent 生成 message + 更新 CHANGELOG
```

> 不建议手工调用的等效内部命令：直接 `import` `cli/grep-cli.ts` 或 `cli/read-cli.ts` 不会经过 TUI 一样的错误恢复与文件附件合并逻辑；始终走 `omp grep` / `omp read`。

### 插件与扩展

想要给 OMP 加新工具、新 skill、新 hook 的时候，按下面顺序判断走哪条入口；同一时间**只**用一条主干。

- **想找现成插件**：`omp plugin` —— 一站式管理（install / uninstall / list 等）。marketplace 的 `add` / `remove` / `list` / `update` 子动作也由 `omp plugin` 统一收口；裸跑 `omp marketplace add xyz` 会被 CLI 改写为 `omp launch …` 把整段 argv 当 prompt 下发（`#4845`），不是合法管理路径。
- **一次性装单个扩展**：`omp install <pkg>` —— `omp plugin install` / `omp plugin link` 的薄别名，适合在 shell 里直接装 npm tarball 或本地目录。
- **首次安装可选依赖**：`omp setup` —— 装本地 TTS、tiny models、auth-broker 等可选 feature；插件依赖若用到这些，先跑 `omp setup` 更稳。
- **本次启动临时加载**：
  - `-e <path>` / `--extension <path>` —— 加载一个扩展文件（可重复）。
  - `--hook <path>` —— 加载一个 hook/extension 文件（可重复）。
  - `--trusted-extension <abs-path>` —— 绝对路径加载并跳过安全提示（**不能**与 `-e` / `--hook` 同用）。
  - `--plugin-dir <dir>` —— 把本地插件目录加入发现列表。
  - `--no-extensions` / `--no-skills` / `--no-rules` —— 关闭对应类别的自动发现。
- **给某次会话加白名单**：`--skills <glob,…>` —— 逗号分隔的 glob，例如 `--skills git-*,docker`。

决策要点：

- 长期使用的工具集合 → `omp plugin install …`，写入 `~/.omp/agent/...`。
- 仅在这一次会话里试一下 → `--extension` / `--trusted-extension`。
- 想给某个项目定制一套 agents → `omp agents unpack --project`（见「并行 agent 与诊断清理」）。
- 怀疑扩展出问题 → 加 `--no-extensions` 临时关掉发现。

> 插件发现顺序、hook 优先级、trusted vs untrusted 差异见 [extensions](../extensions.md) 与 [extension loading](../extension-loading.md)。

### 升级、清理与使用统计

OMP 长期使用后，本地缓存、会话存档、worktree 都会越攒越多。下面这组命令把**升级**、**回收**、**观察**三件事拆开，按需执行。

- **升级本体**：`omp update` —— 检查并安装新版本。**先**跑 `omp update` 再继续其它维护，是稳的次序。
- **存储垃圾回收**：`omp gc` —— 清理过期的会话存档、临时文件、模型缓存；按 profile scope 执行。
- **诊断 + 修复**：`omp cleanse` —— 重新派并行子代理扫项目（见「并行 agent 与诊断清理」）。
- **worktree 清理**：`omp worktree clear` —— 清 `~/.omp/wt` 的孤儿条目；`--all` 才会触碰 live。
- **使用上限**：`omp usage` —— 每个已认证账户的 provider 限额；想避免突然 429 的时候看一眼。
- **使用统计**：`omp stats` —— 历史 token / 时间维度统计，按 provider / model 聚合。
- **本地小模型**：`omp tiny-models` —— 下载会话标题 + 记忆用的本地小模型（依赖前置 `omp setup`）；隐私敏感场景可借此完全离线。

典型节奏：

```text
omp update           # 1. 升到最新版
omp stats            # 2. 看一下最近消耗
omp usage            # 3. 确认没踩上限
omp worktree clear   # 4. 回收 worktree 残骸
omp gc               # 5. 回收存储
```

> `omp stats` / `omp usage` 的输出 schema 与 provider 配额刷新逻辑见「诊断、基准与专用工具」与 [models](../models.md)。

### 协议接入：把 OMP 嵌入编辑器或脚本

普通用户跳过这组；它面向**前端编辑器**、**CI 流水线**、**多账户转发**这些场景。

- **编辑器 / IDE 集成**：`omp acp` —— 把 OMP 作为 Agent Client Protocol 服务器跑在 stdio 上，由外部 ACP 客户端 spawn 与通信。**不建议**手敲 `omp acp`：stdio 会被协议帧占满，没有可读输出。`--acp-terminal-auth` 用于首次接入时让用户回到交互式 TUI 完成 OAuth。
- **脚本化协议**：`omp --mode rpc` / `omp --mode rpc-ui` / `omp --mode json` / `omp --mode text` —— 选不同输出/传输通道；`rpc-ui` 在 RPC 之上额外带 UI 扩展事件。
- **凭据集中管理**：
  - `omp auth-broker` —— 管理凭据保险库（启动本地 SQLite + 监听、迁移、状态查询等子动作）。
  - `omp auth-gateway` —— 基于 broker 跑一个正向代理；其它进程通过 gateway 取 token，不直接读 broker。
- **浏览器自动化中继**：`omp browser-relay` —— 跑本地 CDP 中继，让 browser 工具能驱动**你自己**的 Chrome 标签页；不直接 `omp browser-relay` 也会用到的状态查看走 `omp ps info relay --global browser-relay`。
- **shell 补全**：`omp completions <bash|zsh|fish>` —— 打印对应 shell 的补全脚本，写到 `$PREFIX/share` 或 `~/.zsh/completions` 等位置。

决策要点：

- 只想让模型回答一次就退出 → `omp -p` 或 `omp --print`。
- 想让前端持续跟 OMP 对话 → `omp --mode rpc`（或专门的 `omp acp`）。
- 多台机器共用一套凭据 → 选一台跑 `omp auth-broker serve`，其它机器 `omp auth-gateway`。
- 想用本机 Chrome 而不是无头浏览器 → 先 `omp browser-relay` 起中继，再让 agent 用 browser 工具。

> 各协议的握手细节、ACP session 与 approval mode 的交互见 [approval mode](../approval-mode.md)、[rpc](../rpc.md)、[auth broker / gateway](../auth-broker-gateway.md)。

### 协作分享与展示

「**给别人看**」这一类需求集中在两个动作上：加密分享会话，以及在 TUI 外预览工具渲染。

- **生成可分享链接**：`omp share <session-id>` —— 与 TUI 内 `/share` 斜杠命令等价；产出带密钥的加密链接。对方用 `omp join "<link>"` 进入 TUI 加入会话。
- **让对方从 CLI 加入**：`omp join "<link>"` —— 必须有 TTY，**没有**任何 flag。
- **离线 HTML 导出**：`omp --export <session.jsonl>` —— 适合发邮件、归档；不要分享链接时再用。
- **预览工具渲染**：`omp gallery` —— 跨 streaming、in-progress、success、failure 四种状态预览工具渲染器；做前端调试时最有用。
- **整段 transcript 渲染**：`omp render <session>` —— 把一次会话整段走一遍生产 transcript 管线，并打印 repaint 计时；调试渲染性能时用。
- **shell 补全**：`omp completions <bash|zsh|fish>` —— 让团队成员都能用 Tab 触发子命令与 launch 旗标。

什么时候**不要**用这套：

- 想看自己本地所有会话 → `omp --resume`（不带值进选择器）更快。
- 想直接给同事文件 → `--export` 比 `share` 更稳（无密钥、离线）。

> share 链接的密钥在 URL `#` 片段里，relay 看不到明文；转发即授权，转发前请确认对方身份。

### 诊断、基准与专用工具

这组命令面向**排查问题**、**度量模型**、**压测 prompt**。普通用户日常不碰，做工程化、QA、性能调优时才用。

- **模型基准**：`omp bench` —— 同 prompt 下测不同模型的首 token 耗时与生成吞吐（tokens/s）。
- **指令遵循 / 工作记忆基准**：`omp if-bench` —— 单线程、缓存友好，依次执行 glyph 数组动作并强制要求贯穿 prompt 的「猫叫声」指令；适合做模型行为回归。
- **OAuth 账户平衡**：`omp dry-balance` —— 在随机 session id 上 dry-run OAuth 账户平衡逻辑；只在排查多账户调度问题时用。
- **auto-QA 投诉**：`omp grievances` —— 查看、清理或上报已记录的工具问题（由自动 QA 累积）。
- **TTSR 检查**：`omp ttsr` —— 检查并测试 Time-Traveling Stream Rules；调试 streaming 输出语义时用。
- **图片发布后端**：`omp images`（别名 `img`）—— inspect / diagnose / probe / purge 图片发布后端。
- **TTS 播放**：`omp say <text>` —— 用本地 TTS 引擎合成并播放文字。
- **CLI 自检**：`omp grep` / `omp read` —— 同 TUI 内的 grep / read 工具，但通过 CLI 入口触发，方便在 shell 里快速复用（见「代码搜索、阅读与提交流程」）。
- **隐藏内部命令**：`omp __complete`（hidden: true）—— 仅为 shell 补全脚本服务，**不建议**手工调用。

什么时候**不要**用：

- 想要常规「我今天用了多少 token」→ `omp stats` / `omp usage`，不是这组。
- 怀疑 agent 工具有 bug → 改用 `omp grievances` 查 auto-QA 记录，或直接打开 GitHub issue。

> 这些工具的输出 schema 与典型误用案例见「诊断、基准与专用工具」主题。

### 选命令的通用判断框架

把上面 9 个场景合到一起，可以提炼成几条**第一判断**：

1. **想跑会话** → `omp`（默认入口）。脚本化 `omp -p` / `omp --mode json`。编辑器嵌入 `omp acp`。
2. **想续/复/派会话** → `--continue`（最常用）/ `--resume`（按 id 选）/ `--fork`（开新分支）/ `--from-claude|--from-codex`（跨工具导入）/ `share` + `join`（协作者接入）。
3. **想取信息** → `omp grep`（代码）/ `omp read`（文件/URL/内部 URI）/ `omp search`（联网）/ `omp models`（可用模型）/ `omp usage`（账户上限）。
4. **想加能力** → `omp plugin`（长期）/ `omp install`（一次性）/ `-e` / `--trusted-extension`（本次）/ `omp setup`（缺依赖）。
5. **想看进程** → `omp ps`（受监管进程）/ `omp worktree list`（隔离 worktree）/ `omp grievances`（auto-QA 投诉）。
6. **想收尾** → `omp update`（升级）/ `omp gc`（回收存储）/ `omp worktree clear`（清 worktree）/ `omp stats`（统计）。
7. **想诊断 / 基准** → `omp bench` / `omp if-bench`（模型）/ `omp dry-balance`（OAuth 调度）/ `omp ttsr`（streaming）/ `omp images`（图片后端）。
8. **想展示 / 离线化** → `omp --export`（HTML）/ `omp gallery`（工具渲染预览）/ `omp render`（整段 transcript）/ `omp completions`（shell 补全）。

任何一条**第一判断**模糊时，优先回到本主题的 9 个场景找对应章节；命令的旗标、参数、互斥关系统一在「启动交互与协议接入」「Agent、会话协作与工作树」「文件、代码搜索与 Git 操作」「插件与扩展管理」「安装、升级、清理与使用统计」「诊断、基准与专用工具」中详述。
