# Bash 工具运行时

本文档描述代理工具调用所使用的 **`bash` 工具**运行时路径，从命令规范化到执行、截断/产物（artifact）以及渲染。

本文同时指明在交互式 TUI、打印模式、RPC 模式以及用户发起的 bang（`!`）shell 执行中行为出现分歧之处。

## 范围与运行时面

coding-agent 中存在两种不同的 bash 执行面：

1. **工具调用面**（`toolName: "bash"`）：用于模型调用 bash 工具时。
   - 入口点：`BashTool.execute()`。
   - 参数包括 `command`、可选的 `env`、`timeout`、`cwd`、`pty`，以及当 `async.enabled` 为 true 时的 `async`。
2. **用户 bang 命令面**（交互式输入的 `!cmd` 或 RPC 的 `bash` 命令）：会话级辅助路径。
   - 入口点：`AgentSession.executeBash()`。

两者最终都会调用 `src/exec/bash-executor.ts` 中的 `executeBash()` 进行非 PTY 执行，但只有工具调用路径会执行规范化/拦截、可选的托管后台任务处理以及工具渲染器逻辑。

在设置中将 `bash.enabled: false` 可将面向模型的 `bash` 工具从当前工具注册表中移除。此设置不会禁用用户发起的 bang 命令或 RPC 的 `bash` 请求。

## 端到端工具调用流水线

## 1) 输入处理与参数合并

`BashTool.execute()` 目前按以下方式处理输入：

- 对可选的 `env` 名称进行 shell 变量语法校验；
- 当未提供 `cwd` 时，将开头的单行 `cd <path> && ...` 提取为 `cwd`，除非该路径需要 shell 展开；
- 当 `async.enabled` 为 false 时，拒绝 `async: true`；
- `timeout` 默认为 300 秒；`0` 表示显式禁用命令截止时间。

不存在结构化的 `head` 或 `tail` 参数。执行前，命令和 env 值中的内部 URL 会被展开为底层文件系统路径；作为 `cwd` 的内部 URL 也会被解析。展开过程可能会为可写的 `local://` 路径创建父目录。配置好的 direnv/devenv 预检随后会合并项目环境变更，其中显式传入的 `env` 值优先。

### 审批策略

bash 工具具有 `exec` 审批层级。`bash.patterns` 规则可以显式地 `allow`、`deny` 或 `prompt`：deny/prompt 规则会匹配完整命令或经过分词的复合命令片段，而 allow 规则必须匹配整条命令，且不得允许 shell 控制语法。一组固定的高危破坏性及远程获取并执行模式会始终强制触发 exec 审批，即便用户的 allow 规则已匹配。拦截与审批是相互独立的机制：拦截将误用引导至专用工具；审批则决定执行是否可以继续。

这些规则仅约束 **`bash` 工具**。它们不会限制通过其他工具启动的 shell——尤其是 `eval`，它可以通过子进程（`subprocess.run(["bash", "-c", ...])`、`Bun.$` 等）派生 shell。因此，当相同命令通过 `eval` 发起时，`bash.patterns` 的 `deny` 规则不会起作用。要在两个面上同时加固对破坏性命令的防护，请将 `bash.patterns` 与 `tools.approval.eval` 策略（`prompt` 或 `deny`）配对使用；参见 [工具审批模式](./approval-mode.md)。

## 2) 可选拦截（阻塞命令路径）

若 `bashInterceptor.enabled` 为 true，`BashTool` 会从设置中加载规则（`getBashInterceptorRules()`），并对命令运行 `checkBashInterception()`——当原始命令与经过 cwd 规范化的形式（提取出开头的 `cd … &&` 之后）不同时，会同时检查这两种形式。规则语法保持不变：每条规则首先检查完整输入，然后是按未加引号/未转义的 `&&`、`||`、`;`、`|`、`|&`、`&` 或换行符分隔的扁平命令片段，最后是去掉开头的 `NAME=value` 赋值后的那些片段。通过 `|` 或 `|&` 接收管道 stdin 的片段会从片段候选中排除（包括跨空行/注释续行的情形），因为消费 stdin 的阶段无法被基于路径的专用工具所替代。

拦截行为：

- 仅在以下条件同时满足时阻塞命令：
  - 正则规则匹配，并且
  - 建议的工具存在于 `ctx.toolNames` 中。
- 非法正则规则会被静默跳过。
- 阻塞时，`BashTool` 抛出 `ToolError`，消息为：
  - `Blocked: ...`
  - 包含原始命令。
- heredoc、参数展开、命令替换、反引号、分组以及格式错误的引号不会产生额外的片段；它们仅保留完整输入检查。拦截是尽力而为地路由到专用工具，而非 shell 安全策略。

默认规则模式（在代码中定义）针对常见的误用：

- 文件读取器（`cat`、`head`、`tail`，……）
- 搜索工具（`grep`、`rg`，……）
- 文件查找器（`find`、`fd`，……）
- 原地编辑器（`sed -i`、`perl -i`、`awk -i inplace`）
- shell 重定向写入（`echo ... > file`、heredoc 重定向）

### 注意事项

`InterceptionResult` 包含 `suggestedTool`，但 `BashTool` 目前仅展示消息文本（`details` 中没有结构化的建议工具字段）。

## 3) CWD 校验与超时解析

`cwd` 会相对于会话 cwd 进行解析（`resolveToCwd`），然后通过 `stat` 校验：

- 路径不存在 -> `ToolError("Working directory does not exist: ...")`
- 不是目录 -> `ToolError("Working directory is not a directory: ...")`

默认超时为 300 秒。`timeout: 0` 禁用截止时间。其他值会被限制在 `[1, 3600]` 秒之间，并受 `tools.maxTimeout` 上限的约束；当限制生效且与请求值不同时，会记录一条限制通知以及请求值和解析后的值。

## 4) 产物分配

执行前，工具会为截断输出存储分配一个产物路径/id（尽力而为）。

- 产物分配失败不会中止执行（继续执行但不会产生产物溢出文件），
- 产物 id/路径会传入执行路径，以便在截断时持久化完整输出。

## 5) PTY 与非 PTY 执行选择

PTY 资格由 `canUseInteractiveBashPty(pty, ctx)`（`src/tools/bash-pty-selection.ts`）决定；仅当以下条件全部满足时，本地 PTY 覆盖层才会运行：

- 工具输入 `pty === true`
- `PI_NO_PTY !== "1"`
- 工具上下文具有 UI（`ctx.hasUI === true` 且 `ctx.ui` 已设置）

若请求了 `pty` 但不可用，则调用回退到非 PTY，并追加一条 `pty requested but unavailable …` 通知。

在本地 PTY/非 PTY 选择之前，前台（`async: false`）调用可以路由到托管后台任务（自动后台化；见下文），或者当会话的客户端声明具备终端能力（`clientBridge.capabilities.terminal` + `createTerminal`，且 `pty` 为 false）时，路由到 **客户端桥接编辑器终端**，由其远程执行命令（流式传输 `terminalId` 更新、超时时终止、将信号终止映射为退出码 `137`）。否则使用非交互式的 `executeBash()`。

这意味着打印模式和非 UI 的 RPC/工具上下文始终使用非 PTY。

## 非交互式执行引擎（`executeBash`）

## Shell 会话复用模型

`executeBash()` 会按以下键将原生 `Shell` 实例缓存到进程全局的 map 中：

- shell 路径，
- 已配置的命令前缀，
- 快照路径，
- 序列化后的 shell 环境，
- 可选的代理会话 key，
- minimizer 配置。

会话级 bang 命令执行会传入 `sessionKey: this.sessionId`。

工具调用执行在可用时传入 `sessionKey: this.session.getSessionId?.()`。在两种面上，会话 key 都按会话隔离 shell 复用；没有 key 时，复用退化为基于 shell 配置/快照/env。

并发调用绝不会共享同一个 `Shell`：原生会话一次只运行一条命令，且 `Shell.abort()` 会终止该会话上所有正在进行的运行。`executeBash()` 在 `shellSessionsInUse` 中跟踪正在进行中的 key；在 key 处于忙状态时，重叠的调用会跳过缓存并通过一次性 `executeShell()` 运行（与隔离会话相同的隔离级别）。只有拥有该调用的调用方在其 `finally` 中释放 in-use 标志或删除缓存的会话。

## 内置 `jq` 兼容性

除非 `PI_DISABLE_UUTILS_BUILTINS` 为真值，否则非 PTY 原生 shell 会注册一个由 vendored [jaq](https://github.com/01mf02/jaq) 支持的内置 `jq` 命令，而不是系统的 `jq`。设置该标志会禁用进程内的 uutils 命令集并回退到系统二进制。当通过 null 或缺失的中间值进行链式访问索引时，内置的 jaq 会报错：`.a.b` 作用于 `{}` 时退出码为 5，而 jq 返回 `null`。

当父级可能为 null 或缺失时，请使用 `[.a.b?][0]` 守护该访问。`?` 抑制 jaq 的遍历错误（jq 从不抛出此错误），而 `[…][0]` 将被抑制的空输出映射为 `null`，同时保留合法的 `false` 或 `null` 值：

```jq
{"c": [.a.b?][0]}
```

避免使用朴素的 `.a.b? // null`：`//` 会将合法的 `false`（以及 `null`）视为不存在，因此会悄无声息地将布尔数据改写为回退值。它在解析上也存在差异——`{"c": .a.b? // null}` 会被 jaq 接受，但在 jq 中是语法错误（值需要用括号包裹：`{"c": (.a.b? // null)}`）。

## Shell 配置、direnv 与快照行为

每次调用时，执行器会加载设置中的 shell 配置（`shell`、`env`、可选的 `prefix`）并运行 `applyDirenvPreflight()`。

除非 `bash.direnv` 为 `"off"`，预检会尝试在 `bash.direnvLoadTimeoutMs` 内加载 cwd 的 direnv/devenv 变更，并且额外受命令超时的正向上限约束。由 direnv 提供的变量会合并到显式调用方 `env` 之下；被 direnv 移除的安全变量会以前缀 `unset -v ...` 的形式加在前面。ACP 终端和 PTY 路由会在其后端之前运行相同的预检；非 PTY 执行器在内部运行该预检。

若所选 shell 包含 `bash`，它会尝试 `getOrCreateSnapshot()`：

- 快照会从用户 rc 中捕获别名/函数/选项；
- 快照创建是尽力而为的；
- 失败时回退为无快照。

若配置了 `prefix`，它会在 direnv unset 前缀之后包裹命令。

随后，每条命令的子进程环境由 `buildNonInteractiveEnv()`（`src/exec/non-interactive-env.ts`）构建，它会将非交互式加固默认项叠加在调用方和 direnv 覆盖项的**下面**：

- 禁用分页器（`PAGER=cat`、`GIT_PAGER=cat`，…… 以及 `LESS=FRX`），
- 禁用编辑器提示（`GIT_EDITOR=true`、`EDITOR=true`、`VISUAL=true`），
- 简化终端/凭据提示（`TERM=dumb`、`GIT_TERMINAL_PROMPT=0`、`SSH_ASKPASS=/usr/bin/false`、`NO_COLOR=1`，以及当未设置 `PI_BASH_NO_CI`/`CLAUDE_BASH_NO_CI` 时的 `CI=true`），
- 用于非交互行为的包管理器/工具链自动化标志（npm/pnpm/yarn/pip/cargo/terraform/gh，……），
- 在 Windows 上，若缺失则添加 UTF-8 区域设置/代码页默认值。

## 流式传输与取消

`Shell.run()` 会将分块流式传输到 `OutputSink` 以及可选的 `onChunk` 回调。

取消：

- abort 信号触发 `shellSession.abort(...)`，
- 原生结果中的超时会映射为 `cancelled: true` + 注释文本，
- 显式取消同样返回 `cancelled: true` + 注释。

执行器内部不会因超时/取消抛出异常；它返回结构化的 `BashResult`，由调用方映射错误语义。

## 交互式 PTY 路径（`runInteractiveBashPty`）

当启用 PTY 时，工具运行 `runInteractiveBashPty()`，它会打开一个覆盖层控制台组件并驱动一个原生 `PtySession`。

行为要点：

- xterm-headless 虚拟终端在覆盖层中渲染视口，
- 键盘输入被规范化（包括 Kitty 序列以及应用光标模式处理），
- 运行中按下 `esc` 终止 PTY 会话，
- 终端尺寸变更会传播到 PTY（`session.resize(cols, rows)`）。

与非 PTY 引擎不同，交互式 PTY 路径**不会**应用非交互式加固。它继承用户的环境，并设置真实的 `TERM=xterm-256color`（在 Rust 端作为覆盖应用），使得编辑器、分页器和 TUI 表现得如同普通终端。

PTY 输出会被规范化（`CRLF`/`CR` 转为 `LF`、`sanitizeText`）并写入 `OutputSink`，包括产物溢出支持。

在 PTY 启动/运行时出错时，sink 接收 `PTY error: ...` 行，命令以未定义的退出码结束。

## 输出处理：流式传输、截断、产物溢出

PTY 和非 PTY 路径均使用 `OutputSink`。

## OutputSink 语义

bash 执行器使用设置中的 `headBytes` 和 `maxColumns`（`resolveOutputSinkHeadBytes` / `resolveOutputMaxColumns`）构建 sink。

- 维护一个 UTF-8 安全的滚动 **tail** 窗口（`spillThreshold`、`DEFAULT_MAX_BYTES`，目前为 50KB）；溢出时裁剪到 tail（保持 UTF-8 边界安全）并标记 `truncated`，
- 当 `headBytes > 0`（`tools.artifactHeadBytes`，默认 20KB）时，还会保留一个 **head** 窗口并省略中间部分，在 `dump()` 中将省略标记拼接在 head 和 tail 之间，
- 单行列宽上限：当 `maxColumns > 0`（`tools.outputMaxColumns`，默认 768 字节）时，过宽的行在写入时按省略号截断，并丢弃该行剩余内容，
- 跟踪已见的总字节数/行数，
- 当输出溢出、单行列宽上限丢弃了字节，或产物文件已经处于活动状态时，将**原始未截断的**流镜像到产物文件中，
- 在 tail 溢出、中间省略、列宽上限丢弃或文件溢出时标记 `truncated`。

`dump()` 返回：

- `output`（可能带注释前缀），
- `truncated`，
- `totalLines/totalBytes`，
- `outputLines/outputBytes`，
- 当中间被省略时的 `elidedBytes/elidedLines`，
- 当单行上限触发时的 `columnDroppedBytes/columnTruncatedLines`，
- 当产物文件处于活动状态时的 `artifactId`。

### 长输出注意事项

运行时截断在 `OutputSink` 中基于字节阈值（默认 50KB tail 窗口，加上可选的用于中间省略的 head 窗口）。该代码路径并不强制实施硬性行数上限。

### Shell 输出 minimizer

非 PTY 执行还会将 shell-minimizer 设置传入原生 `Shell` 会话。当 minimizer 重写冗长输出时，执行器会使用重写后的文本替换 sink 的可见文本，并在可能的情况下将原始捕获保存为单独的 `bash-original` 产物，通过 `[raw output: artifact://<id>]` 页脚引用。

## 实时工具更新与异步任务

对于非 PTY 前台执行，`BashTool` 使用单独的 `TailBuffer` 进行部分更新，并在命令运行期间发出 `onUpdate` 快照。

对于 PTY 执行，实时渲染由自定义 UI 覆盖层处理，而非 `onUpdate` 文本分块。

当 `async.enabled` 为 true 且调用传入 `async: true` 时，`BashTool` 立即启动一个托管的 bash 任务，返回带有 job id 的运行中结果，并通过会话任务管理器存储完成结果。在 `bash.autoBackground.thresholdMs` 之后也可以使用自动后台化机制进入该路径；该机制对 PTY 和客户端桥接终端路由会跳过，并在任务管理器达到容量上限时回退到前台执行。排队的 steering 消息可以提前将仍在运行的自动后台候选任务转入后台。

## 结果整形、元数据与错误映射

执行完成后：

1. 取消或缺失退出状态会抛出工具错误。客户端桥接终端路由也会在结构化结果整形之前对超时抛出 `ToolError`。
2. 本地非 PTY 和交互式 PTY 超时返回带 `details.timedOut = true` 的错误结果，以便渲染器将其与普通失败区分开。
3. 空输出变为 `(no output)`。
4. 最终的内联字节上限保护绕过 `OutputSink` 的路由；它会复用可用的 sink 产物，或保存一个 `bash-original` 产物。
5. 截断元数据从 sink 摘要附加。
6. 非零退出返回带 `details.exitCode` 的错误结果；零退出返回成功。

结果详情还可以包括解析后/请求的超时、`timeoutDisabled`、客户端 `terminalId`、wall time、异步任务状态以及截断元数据。截断信息包括方向/原因、总行/字节数和显示行/字节数、显示范围，以及持久化成功时的 `artifactId`。

内置的工具包装会自动追加面向模型的恢复通知，例如 `Read artifact://<id> for full output`。

## 渲染路径

## 工具调用渲染器（`bashToolRenderer`）

`bashToolRenderer` 用于工具调用消息（`toolCall` / `toolResult`）：

- 折叠模式显示按可视行截断的预览，
- 展开模式显示当前可用的所有输出文本，
- 警告行包含截断原因以及截断时的 `artifact://<id>`，
- 超时值（来自 args）显示在页脚元数据行中。

### 注意事项：完整产物展开

`BashRenderContext` 包含 `isFullOutput`，但当前的渲染器上下文构建器并未为 bash 工具结果设置它。展开视图仍然使用结果内容中已有的文本（tail/截断输出），除非其他调用方提供完整的产物内容。

## 用户 bang 命令组件（`BashExecutionComponent`）

`BashExecutionComponent` 用于交互式模式中的用户 `!` 命令（非模型工具调用）：

- 实时流式传输分块，
- 折叠预览保留最近 20 个逻辑行，
- 单行字符数上限为 4000，
- 当元数据存在时显示截断 + 产物警告，
- 分别标记 cancelled/error/exit 状态。

该组件由 `CommandController.handleBashCommand()` 连接，并由 `AgentSession.executeBash()` 提供数据。

## 模式特定的行为差异

| 面                          | 入口路径                                            | PTY 资格                                              | 实时输出 UX                                                            | 错误呈现                                |
| ---------------------------- | ----------------------------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------- |
| 交互式工具调用              | `BashTool.execute`                                    | 是，当 `pty=true` 且存在 UI 且 `PI_NO_PTY!=1`         | PTY 覆盖层（交互式）或流式 tail 更新                                  | 工具错误变为 `toolResult.isError`        |
| 打印模式工具调用            | `BashTool.execute`                                    | 否（无 UI 上下文）                                    | 无 TUI 覆盖层；输出出现在事件流/最终助手文本流中                      | 相同的工具错误映射                      |
| RPC 工具调用（代理工具链）  | `BashTool.execute`                                    | 通常无 UI -> 非 PTY                                  | 结构化工具事件/结果                                                    | 相同的工具错误映射                      |
| 交互式 bang 命令（`!`）     | `AgentSession.executeBash` + `BashExecutionComponent` | 否（直接使用执行器）                                  | 专用的 bash 执行组件                                                  | 控制器捕获异常并显示 UI 错误            |
| RPC `bash` 命令             | `rpc-mode` -> `session.executeBash`                   | 否                                                    | 直接返回 `BashResult`                                                 | 消费者处理返回的字段                    |

## 运维注意事项

- 拦截器仅在上下文中当前存在建议工具时阻塞命令。
- 若产物分配失败，仍然会进行截断，但无法提供 `artifact://` 反向引用。
- Shell 会话缓存在该模块中没有显式的逐出机制；生命周期与进程一致。
- 超时整形是特定于后端的：本地非 PTY 和交互式 PTY 超时返回带 `details.timedOut` 的错误结果；客户端桥接终端的创建/执行超时路径会抛出 `ToolError`。非超时的取消会在这些工具调用路由中抛出。

## 实现文件

- [`src/tools/bash.ts`](../packages/coding-agent/src/tools/bash.ts) — 工具入口、输入处理/拦截、异步及 PTY/非 PTY 选择、结果/错误映射、bash 工具渲染器。
- [`src/tools/bash-pty-selection.ts`](../packages/coding-agent/src/tools/bash-pty-selection.ts) — `canUseInteractiveBashPty` 谓词，用于选择本地 PTY 覆盖层。
- [`src/tools/bash-interceptor.ts`](../packages/coding-agent/src/tools/bash-interceptor.ts) — 拦截器规则匹配和阻塞命令消息。
- [`src/tools/bash-skill-urls.ts`](../packages/coding-agent/src/tools/bash-skill-urls.ts) — 命令、env 值以及 cwd 的内部 URL 展开。
- [`src/exec/bash-executor.ts`](../packages/coding-agent/src/exec/bash-executor.ts) — 非 PTY 执行器、shell 会话复用、取消布线、输出 sink 集成。
- [`src/exec/non-interactive-env.ts`](../packages/coding-agent/src/exec/non-interactive-env.ts) — 非交互式子进程环境默认值（`buildNonInteractiveEnv`），由非 PTY 执行器使用。
- [`src/exec/direnv.ts`](../packages/coding-agent/src/exec/direnv.ts) — 由执行器预检使用的 direnv/devenv 环境加载。
- [`src/tools/bash-interactive.ts`](../packages/coding-agent/src/tools/bash-interactive.ts) — PTY 运行时、覆盖层 UI、输入规范化以及交互式 `TERM` 设置。
- [`src/session/streaming-output.ts`](../packages/coding-agent/src/session/streaming-output.ts) — `OutputSink`、`TailBuffer`、截断/产物溢出以及摘要元数据。
- [`src/tools/output-meta.ts`](../packages/coding-agent/src/tools/output-meta.ts) — 截断元数据结构 + 通知注入包装。
- [`src/session/agent-session.ts`](../packages/coding-agent/src/session/agent-session.ts) — 会话级 `executeBash`、消息记录、abort 生命周期。
- [`src/modes/components/bash-execution.ts`](../packages/coding-agent/src/modes/components/bash-execution.ts) — 交互式 `!` 命令执行组件。
- [`src/modes/controllers/command-controller.ts`](../packages/coding-agent/src/modes/controllers/command-controller.ts) — 交互式 `!` 命令 UI 流/更新完成的连线。
- [`src/modes/rpc/rpc-mode.ts`](../packages/coding-agent/src/modes/rpc/rpc-mode.ts) — RPC `bash` 和 `abort_bash` 命令面。
- [`src/internal-urls/artifact-protocol.ts`](../packages/coding-agent/src/internal-urls/artifact-protocol.ts) — `artifact://<id>` 解析。