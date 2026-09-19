# bash

> 在会话工作空间中执行 shell 命令，可选用 PTY 或后台任务处理。

## 源码
- 入口：`packages/coding-agent/src/tools/bash.ts`
- 面向模型的提示词：`packages/coding-agent/src/prompts/tools/bash.md`
- 关键协作者：
  - `packages/coding-agent/src/tools/bash-interactive.ts` — PTY/TUI 执行路径。
  - `packages/coding-agent/src/tools/bash-interceptor.ts` — 拦截更适合用工具完成的 shell 模式。
  - `packages/coding-agent/src/tools/bash-skill-urls.ts` — 将内部 URL 展开为路径。
  - `packages/coding-agent/src/tools/bash-pty-selection.ts` — `canUseInteractiveBashPty()` 决定某次调用是否可以使用本地 PTY 叠加界面。
  - `packages/coding-agent/src/tools/gh-cache-invalidation.ts` — 对会修改状态的 `gh issue`/`gh pr` 子命令丢弃 `github-cache` 行。
  - `packages/coding-agent/src/exec/bash-executor.ts` — 非 PTY 的 shell 执行。
  - `packages/coding-agent/src/session/streaming-output.ts` — 尾部缓冲、截断、产物溢出。
  - `packages/coding-agent/src/tools/tool-timeouts.ts` — 超时裁剪边界。
  - `packages/coding-agent/src/config/settings-schema.ts` — 默认拦截器规则。
  - `docs/bash-tool-runtime.md` — 更深入的执行器/运行时说明；作为 shell 会话内部机制的配套文档。

## 输入

| 字段 | 类型 | 必填 | 描述 |
| --- | --- | --- | --- |
| `command` | `string` | 是 | 要执行的 shell 命令文本。仅当省略 `cwd` 时，前置的 `cd <path> && ...` 才会被改写为 `cwd`。 |
| `env` | `Record<string, string>` | 否 | 额外的环境变量。键必须匹配 `^[A-Za-z_][A-Za-z0-9_]*$`，否则工具会抛出错误。值会经过内部 URL 展开，并作为环境值传递，而不是 shell 文本。 |
| `timeout` | `number` | 否 | 超时秒数。默认 `300`。`0` 禁用截止时间。该设置为正时，正值受 `tools.maxTimeout` 上限约束，随后被裁剪到 Bash 范围 `1..3600`。 |
| `cwd` | `string` | 否 | 工作目录，通过 `resolveToCwd` 相对于 `session.cwd` 解析。必须存在且为目录。 |
| `pty` | `boolean` | 否 | 请求 PTY 模式。默认 `false`。仅当 `pty: true`、`PI_NO_PTY !== "1"` 且工具上下文有 UI 时才使用 PTY。 |
| `async` | `boolean` | 否 | 后台执行请求。仅当会话的 `async.enabled` 为 true 时才存在。它会立即返回作业 id 而不等待；它不改变有效截止时间，包括由 `timeout: 0` 产生的已禁用截止时间。 |

## 输出
该工具返回单个 `text` 内容块以及可选的 `details`。

- 成功，前台：
  - `content[0].text`：命令输出；当命令没有产生任何输出时为 `(no output)`。
  - `details.timeoutSeconds`：经过全局/按工具裁剪后的有效正超时；当 `timeout: 0` 时为 `details.timeoutDisabled: true`。
  - `details.requestedTimeoutSeconds`：当请求的正超时与有效超时不同时存在。
  - `details.wallTimeMs`：已完成的本地/客户端终端运行所经过的墙钟毫秒数。
  - `details.terminalId`：当执行经由客户端终端桥接路由时存在。
  - `details.exitCode`：当命令以非零退出码完成时存在。
  - `details.timedOut: true`：在本地/PTY 超时结果中存在。
  - `details.meta.truncation`：当输出在内存中被截断时存在；当完整输出溢出到产物时包含 `artifactId`。
  - 非零退出和本地/PTY 超时会返回标记为 `isError` 的工具结果；确定的非零输出以 `Command exited with code <n>` 结尾。
- 成功，后台启动（`async: true` 或自动后台）：
  - `content[0].text`：可选的预览尾部和提示，随后是 `Backgrounded as job <id>; result will be delivered automatically.`
  - `details.async`：`{ state: "running", jobId, type: "bash" }`。
- 后台进度 / 完成：
  - 通过 `onUpdate` / 异步作业管理器投递，而非初始返回值。
  - 运行中更新包含尾部文本，并且只有在作业被视为已转入后台之后才包含 `details.async.state: "running"`。
  - 完成/失败更新携带最终文本和 `details.async.state: "completed" | "failed"`。非零退出或超时会被记录为失败的后台作业。
- 失败：
  - 取消、缺少退出状态、校验失败、被拦截的命令，以及客户端终端桥接超时都会抛出 `ToolError` / `ToolAbortError`。

模型看到输出之前，stdout 与 stderr 已合并。确定的非零退出码会以 `Command exited with code <n>` 追加到返回的错误结果文本中。

## 命令策略与专用工具路由

有两个彼此独立的设置可以阻止 Bash 子进程启动。它们的用途不同，并在工具调用生命周期的不同阶段生效。

| 设置 | 用途 | 规则语法 | 匹配时的结果 |
| --- | --- | --- | --- |
| `bash.patterns` | 按命令设定的执行策略 | 带 `*` 通配符的字面文本 | 允许该调用、请求人工批准或拒绝该调用。 |
| `bashInterceptor.patterns` | 优先使用专用工具而非 Bash | JavaScript 正则表达式、可选标志、工具名和消息 | 返回一个 Bash 工具错误，告知模型改为调用指定的专用工具。 |

### `bash.patterns`：权限策略

`bash.patterns` 适用于那些无论是否存在其他工具能完成工作，都必须被允许、需人工确认或被拒绝的命令。规则按顺序排列；第一条匹配的规则生效。每条规则包含一个 `match` glob 和一个取值为 `allow`、`prompt` 或 `deny` 的 `approval`。

```yaml
bash:
  patterns:
    - match: "git *"
      approval: allow
    - match: "curl *"
      approval: prompt
    - match: "rm -rf *"
      approval: deny
```

- `deny` 会在 `BashTool.execute()` 运行之前阻止该调用，在 `yolo` 模式下也是如此。
- `prompt` 显示一条批准请求。只有被接受的请求才会进入 `BashTool.execute()`。
- `allow` 可以降低简单命令的审批层级，但无法批准复合命令。例如，`match: "git *"` 不会批准 `git status && rm -rf build`。
- `deny` 和 `prompt` 会检查完整命令以及每个 shell 命令片段。因此，像 `match: "rm -rf *"` 这样的规则可以捕获 `cd /tmp && rm -rf build`。

将该设置用于安全与用户控制。对于没有合适替代工具的命令，例如破坏性删除、网络访问、部署脚本或项目专用脚本，它仍然有用。

### `bashInterceptor.patterns`：专用工具路由

`bashInterceptor` 是一个需显式启用的路由层（`bashInterceptor.enabled` 默认为 `false`）。它面向那些技术上属于合法 Bash、但用可用的专用工具表达更合适的命令。每个 pattern 都是一个正则表达式，并包含该替代工具的名称以及展示给模型的说明。

```yaml
bashInterceptor:
  enabled: true
  patterns:
    - pattern: '^\s*(cat|head|tail)\s+'
      tool: read
      message: "Use the read tool instead; it handles binary files and provides better context."
    - pattern: '^\s*(grep|rg)\s+'
      tool: grep
      message: "Use the grep tool instead; it respects .gitignore and returns structured results."
```

拦截器规则仅在其 `tool` 在当前会话中可用时才适用。如果 `read` 被禁用，针对 `read` 的 `cat` 规则不会阻止该 Bash 调用。这使拦截器成为一种尽力而为的能力偏好，而非执行安全边界。

内置默认规则会将常见操作路由到对应工具，例如把 `cat` 路由到 `read`、`rg` 路由到 `grep`、原地 `sed` 路由到 `edit`、shell 重定向路由到 `write`、非托管服务/后台进程路由到 `hub`。完整列表参见 `packages/coding-agent/src/config/settings-schema.ts` 中的 `DEFAULT_BASH_INTERCEPTOR_RULES`。

为兼容已有的自定义正则，拦截器始终先检查完整的原始命令。随后检查由未被引用且未转义的 `&&`、`||`、`;`、`|`、`&` 或换行符分隔的原始扁平命令片段。它还会检查去除前导环境变量赋值后的片段：

```bash
git add file && git commit -m "message"
GIT_AUTHOR_NAME=Dev git commit -m "message"
```

因此，像 `^\s*git\s+commit\b` 这样的锚定规则在两个示例中都能匹配 `git commit` 命令。通过未引用的 `|` 或 `|&` 消费另一条命令 stdout 的阶段（例如 `printf 'x\n' | grep x` 中的 `grep x`）**不会**被视为拦截候选：它读取的是管道 stdin，而基于路径的专用工具无法提供这种输入，因此只有独立命令或管道第一阶段的命令会被匹配。管道之后仅含空白或注释的续行会保持该上下文。被引用、转义和注释的文本不会被视为命令。Heredoc、参数展开、命令替换、反引号、分组以及格式错误的引用只保留完整命令检查；拦截器有意不试图成为完整的 shell 解析器。

### 交互与选择指南

审批策略在执行之前就已确定。匹配的 `bash.patterns` `deny` 永远不会到达拦截器。匹配的 `prompt` 只有在用户接受批准请求之后才会到达拦截器。如果被接受的调用随后匹配了某条拦截器规则，该 Bash 调用仍然不会运行；模型会收到路由错误，并应改为调用专用工具。

除非有意要这种两步行为，否则避免在两处配置同一操作。例如，为 `cat *` 配置 `prompt` 规则并启用 `cat` 到 `read` 的拦截器时，会先请求用户批准 Bash，随后拒绝 Bash 并要求模型使用 `read`。

根据期望的结果选择设置：

- 当问题在于**命令是否可以执行**时，使用 `bash.patterns`。
- 当问题在于**应由哪个工具执行该操作**时，使用 `bashInterceptor.patterns`。

1. `packages/coding-agent/src/tools/bash.ts` 中的 `BashTool.execute()` 读取 `command`、校验 `env`，并将 `timeout` 默认为 `300`。
2. 如果 `cwd` 缺失，它会将前置的 `cd <path> && ...` 改写为结构化的 `cwd` 字段，并从 `command` 中剥去该前缀。
3. 如果在 `async.enabled` 关闭时请求了 `async: true`，它会在任何执行之前抛出 `ToolError`。
4. 如果 `bashInterceptor.enabled` 开启，`checkBashInterception()` 会同时针对原始命令和被剥去 `cd` 的命令运行。对每种形式，配置的正则仍先检查完整输入，然后检查由未引用/未转义的 `&&`、`||`、`;`、`|`、`|&`、`&` 或换行符分隔的各条扁平命令（不含从 `|` 或 `|&` 消费管道 stdin 的阶段，包括跨空白与注释续行的情况），最后检查这些片段去除前导 `NAME=value` 赋值后的版本。匹配到的已启用规则会在 URL 展开或执行之前抛出。
5. `expandInternalUrls()` 会重写 `command` 内部、每个 `env` 值以及看起来像协议形式的 `cwd` 值中受支持的内部 URL。命令中的替换会做 shell 转义；`env` 和 `cwd` 的替换使用原始文件系统/字符串值，因为它们不会被插值到 shell 文本中。
6. `resolveToCwd()` 相对于 `session.cwd` 解析 `cwd`；`fs.stat()` 验证目标存在且是目录。
7. `timeout: 0` 禁用截止时间。否则 `clampTimeout("bash", requestedTimeoutSec, tools.maxTimeout)` 会先应用正的全局上限（若已配置），然后应用 `TOOL_TIMEOUTS.bash`（`min: 1`、`max: 3600`）。发生裁剪时，`#buildCompletedResult()` / `#buildBackgroundStartResult()` 会追加一行提示。
8. 执行路径分流：
   1. `async: true` -> `#startManagedBashJob()` 注册一个会话异步作业并立即返回。
   2. 非 PTY 且启用了 `bash.autoBackground.enabled`、异步作业管理器未达到其运行作业上限、且没有可用的客户端终端桥接（两者同时满足时桥接优先）-> 启动受管作业，最多等待 `min(thresholdMs, timeoutMs - 1000)`，然后要么返回已完成结果，要么把该次运行转为后台作业。
   3. 非 PTY 的客户端终端桥接，当会话声明具备终端能力且 `pty` 为 false 时 -> 创建一个远程终端，流式输出/轮询当前输出，并在完成后释放该终端。
   4. 否则执行前台运行。
9. 没有客户端终端的前台非 PTY 会调用 `packages/coding-agent/src/exec/bash-executor.ts` 中的 `executeBash()`；该路径自行执行 direnv/devenv 预检。
10. 前台 PTY 与客户端终端路径会在派发之前于 `BashTool` 中运行相同的 direnv 预检。在 `bash.direnv: "auto"`（默认值）下，被允许的 `.envrc` 可以将环境变更合并到命令中；`"off"` 会禁用此行为。`bash.direnvLoadTimeoutMs` 默认为 `30_000`，正的命令超时也会限制预检。
11. 当 `session.allocateOutputArtifact` 可用时，本地非 PTY 与 PTY 路径会先分配一个输出产物。产物路径/id 会被传入 sink，因此大量输出可以溢出到磁盘。
12. `executeBash()` 加载 shell 设置、可选的 shell 快照以及 shell 精简器设置，然后通过持久化的原生 `Shell` 会话或一次性的 `executeShell()` 运行。`docs/bash-tool-runtime.md` 详细介绍了该路径。
13. `runInteractiveBashPty()` 创建 `PtySession`，叠加一个由 xterm 支撑的控制台 UI，将用户按键输入转发到 PTY，通过 `OutputSink` 捕获输出，并在关闭/释放时终止该 PTY。
14. 客户端终端桥接模式调用 `session.getClientBridge().createTerminal(...)`，发出 `terminalId` 更新，轮询输出直到退出/超时/中止，将信号退出映射为 `137`，并在 `finally` 中释放句柄。
15. 完成时，`#buildCompletedResult()` 会在需要时格式化为 `(no output)`，附加来自输出摘要的截断元数据，追加墙钟时间/超时/退出提示，并在返回前重新检查未完成状态。
16. 本地/PTY 超时结果会变为带 `details.timedOut` 的 `isError` 结果；客户端终端超时以及取消/缺少退出状态的路径会在有已捕获输出时连同输出一起抛出。

## 模式 / 变体
1. 前台非 PTY 本地
   - 没有可用客户端终端桥接时的默认路径。
   - 使用 `executeBash()`。
   - 通过 `streamTailUpdates()` 和 `TailBuffer(DEFAULT_MAX_BYTES)` 仅流式输出尾部更新。
2. 前台非 PTY 客户端终端
   - 当 `session.getClientBridge()?.capabilities.terminal` 为 true、`createTerminal` 存在且 `pty` 为 false 时使用。
   - 通过带 `details.terminalId` 的轮询更新流式输出当前终端输出。
   - 施加相同的超时与中止行为，然后释放终端句柄。
3. 前台 PTY
   - 需要 `pty: true`、UI 上下文以及 `PI_NO_PTY !== "1"`。
   - 使用 `runInteractiveBashPty()` 和 `PtySession` 叠加界面。
   - 支持交互式输入；`Esc` 可以从叠加界面终止会话。
4. 显式后台作业
   - 需要 `async: true` 和 `async.enabled`。
   - 在 `session.asyncJobManager` 中注册作业并立即返回 `{ state: "running", jobId }`。`timeout: 0` 会使该作业不带工具施加的截止时间。
5. 自动转入后台的非 PTY 作业
   - 需要启用 `bash.autoBackground.enabled`，没有 PTY/客户端终端桥接，且异步作业管理器未达到其运行作业上限。
   - 像前台受管作业一样启动，当超出等待窗口时将其转入后台；在达到上限时，Bash 回退为直接前台执行。
6. 被拦截的命令
   - 不创建子进程。
   - 返回 `ToolError`，指引模型使用 `read`、`grep`、`glob`、`edit` 或 `write`。

## 副作用
- 文件系统
  - 用 `fs.stat()` 校验 `cwd`。
  - 可能为完整的本地输出（`bash`）和精简器保留的原始输出（`bash-original`）分配并写入产物文件。
  - `expandInternalUrls(..., { ensureLocalParentDirs: true })` 会在执行前为 `local://` 路径创建父目录。
- 子进程 / 原生绑定 / 客户端终端
  - 非 PTY 本地执行通过 `@oh-my-pi/pi-natives`（`Shell.run()` 或 `executeShell()`）使用原生 shell 执行。
  - PTY 使用原生 `PtySession.start()`。
  - 客户端终端模式将进程执行委托给已连接的客户端终端能力。
- 会话状态
  - 读取会话设置中的 async、自动后台、拦截器、direnv、全局超时上限、工具可用性和 shell 配置。
  - 为显式/自动后台运行在 `session.asyncJobManager` 中注册作业。
  - 使用 `session.getSessionId()` 隔离 shell 复用与异步会话键。
  - 使用 `session.allocateOutputArtifact()` 处理溢出文件。
  - 当命令包含会修改状态的 `gh issue`/`gh pr` 子命令时，在执行前使 `github-cache` 行失效，以便后续 `issue://`/`pr://` 读取看到变更后的状态（`invalidateGithubCacheForBashCommand`）。
- 用户可见提示 / 交互式 UI
  - PTY 模式打开标题为 `Console` 的 TUI 叠加界面，并将输入转发到 PTY。
  - 后台启动消息会说明结果在完成时自动投递，以及在此之前 `hub` 工具可以等待它。
- 后台工作 / 取消
  - 异步与自动后台作业会在工具初次返回之后继续运行，直到完成、被取消或到达其截止时间（除非 `timeout: 0` 已禁用它）。
  - 取消会中止原生运行；关闭 PTY 叠加界面也会终止该 PTY。

## 限制与上限
- 默认超时：`300s`（`packages/coding-agent/src/tools/tool-timeouts.ts` 中的 `TOOL_TIMEOUTS.bash.default`）。
- `timeout: 0` 禁用命令截止时间。
- 正超时裁剪：`tools.maxTimeout` 是可选的全局限额（`0` 表示没有全局上限），随后是 Bash 的 `1..3600s` 范围。
- 自动后台默认阈值：`60_000ms`（`packages/coding-agent/src/tools/bash.ts` 中的 `DEFAULT_AUTO_BACKGROUND_THRESHOLD_MS`），当存在截止时间时进一步限制为 `timeoutMs - 1000`；截止时间被禁用时该阈值不设上限。
- 带截止时间的非 PTY 执行器会在 `max(1_000, timeoutMs)` 处设置宿主侧定时器，并将相同的正超时传给原生运行；`timeout: 0` 不传截止时间。超时的持久化 shell 会话会被隔离（`packages/coding-agent/src/exec/bash-executor.ts`）。
- 内存中输出尾部上限：`50 * 1024` 字节（`packages/coding-agent/src/session/streaming-output.ts` 中的 `DEFAULT_MAX_BYTES`）。一旦超过，sink 只在内存中保留尾部窗口。
- `executeBash()` 中的流式回调节流：启用流式时，`onChunk` 调用之间间隔 `50ms`。
- TUI 折叠预览：在 agent UI 中内联渲染时为 `10` 个可视行（`BASH_DEFAULT_PREVIEW_LINES`）；这是渲染器上限，而非工具输出上限。

## 错误
- 输入校验：
  - 无效的 env 键 -> `ToolError("Invalid bash env name: <key>")`。
  - 在禁用时请求 async -> `ToolError("Async bash execution is disabled...")`。
  - 缺少异步作业管理器 -> `ToolError("Background job manager unavailable for this session.")`。
  - 缺少/错误的 `cwd` -> `ToolError("Working directory does not exist: ...")` 或 `ToolError("Working directory is not a directory: ...")`。
- 拦截器：
  - 匹配到命令 -> 抛出带 `Blocked: <rule.message>` 和原始命令的 `ToolError`。
  - 无效的拦截器正则会被 `compileRules()` 静默跳过。
- 内部 URL 展开：
  - 不受支持的 scheme、未知 skill、路径穿越、缺少 router 支持或 router 解析失败，都会从 `packages/coding-agent/src/tools/bash-skill-urls.ts` 抛出 `ToolError`。
- 执行：
  - 非零退出 -> 返回标记为 `isError` 的工具结果，带 `details.exitCode`，且文本以 `Command exited with code <n>` 结尾。
  - 缺少退出码 -> 抛出带 `Command failed: missing exit status` 的 `ToolError`。
  - 超时 -> 本地/PTY 执行返回带 `details.timedOut: true` 的 `isError` 结果以及一条超时提示；客户端终端桥接会在终止终端并尝试最后一次读取输出后抛出 `ToolError`。受管后台执行会将这两种形式都记录为失败作业。
  - 用户中止 -> 当调用方信号被中止时抛出 `ToolAbortError`。
- 产物分配/产物保存失败会在 `saveBashOriginalArtifact()` 和 `OutputSink.#createFileSink()` 中被吞掉；执行会在没有该产物的情况下继续。

## 备注
- `BashTool` 上设置了 `strict = true`；`concurrency` 按调用解析：`pty: true` 为 `"exclusive"`（它会接管终端 UI），其他一切都为 `"shared"`，因此同一条助手消息中的多个非 pty bash 调用会并行运行。当并行调用重叠在同一个 shell 会话键上时，第一个调用拥有持久化的 `Shell`；其余调用在隔离的一次性 shell 中运行（参见 `bash-executor.ts` 中的 `shellSessionsInUse`）。
- `command` 中的 URL 展开会对替换内容做 shell 转义；`env` 和 `cwd` 的展开使用 `noEscape: true`，因为它们会成为环境值 / 文件系统路径，而不是 shell 文本。
- `checkBashInterception()` 仅在匹配规则的 `tool` 名称出现在 `ctx.toolNames` 中时才阻止；缺失的工具会使其对应规则失效。
- 拦截器配置语法保持不变。它处理常见的扁平命令列表，而非完整的 shell 解析：heredoc、参数展开、命令替换、反引号、分组和格式错误的引用只会接受既有的整体输入检查。这是朝向专用工具的尽力而为路由，而不是安全边界。
- `bash.direnv` 默认为 `"auto"` 并遵循 direnv 的允许列表；未被允许的 `.envrc` 不会被执行。将其设为 `"off"` 可绕过预检。`bash.direnvLoadTimeoutMs` 控制冷加载预算。
- 默认拦截器规则来自 `packages/coding-agent/src/config/settings-schema.ts` 中的 `DEFAULT_BASH_INTERCEPTOR_RULES`：
  - `cat|head|tail|less|more` -> `read`
  - `grep|rg|ripgrep|ag|ack` -> `grep`
  - `find|fd|locate` 带 name/type/glob 标志 -> `glob`
  - `sed -i`、`perl -i`、`awk -i inplace` -> `edit`
  - `echo|printf|cat <<` 带重定向 -> `write`
- PTY 模式在非 UI 上下文以及 `PI_NO_PTY=1` 时会被忽略（由 `canUseInteractiveBashPty()` 把关）；工具会回退到非 PTY 执行，并追加一条 `pty requested but unavailable in this environment; ran without a terminal` 提示。
- 非 PTY 运行通过 `buildNonInteractiveEnv()` 将 `NON_INTERACTIVE_ENV` 与 `env` 合并；PTY 运行则继承用户环境，并在自定义 `env` 值之前前置 `TERM=xterm-256color`。
- 当 shell 精简器在 `executeBash()` 内部重写输出时，可见输出会被替换为精简后的文本，并且如果 `onMinimizedSave` 持久化了原始文本，可能会追加一个 `[raw output: artifact://<id>]` 页脚。
- TUI 渲染器会解析不完整的 JSON，以便在流式预览早期恢复 `env` 赋值；该行为仅供显示。
- 关于并非工具专有的执行器内部机制 — shell 会话复用键、快照、前缀处理以及原生超时行为 — 参见 `docs/bash-tool-runtime.md`。
