# Natives Shell、PTY、Process 与 Key 内部机制

本文档介绍 `@oh-my-pi/pi-natives` 中的 execution/process/terminal 原语：`shell`、`pty`、`ps` 和 `keys`，使用的架构术语来自 `docs/natives-architecture.md`。

## 实现文件

- `crates/pi-natives/src/shell.rs`
- `crates/pi-shell/src/shell.rs`
- `crates/pi-shell/src/cancel.rs`
- `crates/pi-shell/src/windows.rs`（仅 Windows 上的 PATH 补全）
- `crates/pi-shell/src/process.rs`
- `crates/pi-natives/src/pty.rs`
- `crates/pi-natives/src/ps.rs`
- `crates/pi-natives/src/keys.rs`
- `crates/pi-natives/src/task.rs`
- `packages/natives/native/index.d.ts`

## 分层职责

- **包入口**（`packages/natives/native/index.js`）：加载 `.node` 插件并导出生成的 N-API 绑定。
- **Rust N-API 模块层**（`crates/pi-natives/src/*`）：面向 JS 的 shell/PTY/process/key 导出与回调桥接。
- **运行时核心**（`crates/pi-shell/src/*`）：brush shell 执行、取消清理、minimizer 集成、命令修正以及跨平台进程引用。
- **消费方**（`packages/coding-agent`、`packages/tui`）：更高级别的会话策略、输出 artifact/minimizer 处理、渲染策略以及 UI 按键处理。

## Shell 子系统（`shell`）

### API 模型

Shell 执行模式：

1. **一次性**调用 `executeShell(options, onChunk?)`。
2. **持久会话**通过 `new Shell(options?)` 创建，然后反复调用 `shell.run(...)`。

两者都将合并后的 stdout/stderr 文本通过线程安全的回调流式输出，并返回 `{ exitCode?, cancelled, timedOut, minimized?, workingDir? }`。

持久化 `Shell` 还暴露 `liveBackgroundJobCount()`，它会在静默回收已结束作业后，返回存活的 `&`/`nohup` 子进程数量。这让宿主可以保留每个调用的 shell，而后台子进程保持存活；丢弃 shell 会将其终止。

`ShellOptions` 支持 `sessionEnv`、`snapshotPath` 和可选的输出 `minimizer`。`ShellExecuteOptions` 额外支持 command、cwd、命令作用域 `env`、timeout/signal 以及 minimizer。`ShellRunOptions` 支持 command、cwd、命令作用域 env、timeout 和 signal。

### 会话创建与环境模型

Rust 通过以下方式创建 `brush_core::Shell`：

- 禁用继承的环境（`do_not_inherit_env: true`），随后从宿主环境显式重建环境，
- 跳过 profile 与 rc 加载，
- 启用 bash 模式内建命令，禁用 `exec` 和 `suspend`，
- 注册原生 `sleep`、`timeout` 和 `nohup` 内建命令，
- 对 shell 敏感变量（`PS1`、`PWD`、`SHLVL`、bash 函数导出等）设置跳过列表，
- 保留一个非导出的 `env="$env"` 兜底，以便 PowerShell 风格的 `$env:NAME` 在 brush 参数展开中得以保留，除非用户覆盖了 `env`。

会话环境行为：

- `ShellOptions.sessionEnv` / 一次性 `sessionEnv` 在会话创建时应用。
- `ShellRunOptions.env` / 一次性 `env` 是命令作用域（`EnvironmentScope::Command`），命令结束后弹出。
- 在 Windows 上 `PATH` 以大小写不敏感方式去重合并。
- 仅 Windows 的路径补全（`pi-shell/src/windows.rs`）在发现 Git-for-Windows 路径且尚未包含时将其追加。
- 若存在 `snapshotPath`，会在会话创建时被 source，并将 stdout/stderr/stdin 接到 null 文件。

### 运行时生命周期与状态转换

持久化 shell（`Shell.run`）使用如下状态机：

- **Idle/Uninitialized**：`session: None`。
- **Running**：首次 `run()` 延迟创建会话，存储 abort token，执行命令。
- **Completed + keepalive**：若执行控制流正常，则清除 abort 状态并复用会话。
- **Completed + teardown**：若控制流与 loop/script/shell-exit 相关，则丢弃会话。
- **Cancelled/Timed out**：触发 Tokio 取消令牌，基线快照之后启动的子孙进程接收终止波次，给予 2 秒的优雅等待时间，任务可能被 abort；若能获取锁则丢弃持久会话。
- **Error**：丢弃会话。

一次性 shell（`executeShell`）始终为每次调用创建并丢弃一个新会话。

### 流式输出/输出与 minimizer 行为

- stdout/stderr 被路由到共享管道并并发读取。
- 读取器以增量方式解码 UTF-8；非法字节序列发出 `U+FFFD` 替换块。
- 命令以 `ProcessGroupPolicy::NewProcessGroup` 运行。
- 前台命令结束后，读取器会持续排空，直到 EOF、250ms 空闲输出或最长 2s；随后读取器关闭给予 250ms 超时。
- 可选的 minimizer 配置可以捕获并改写输出。当发生 minimization 时，结果包含 `minimized`，包括 filter 名称、替换/原始文本以及字节数。
- 成功结果可以包含 `workingDir`，反映执行后 shell 的 cwd。
- 由消费方负责持久化或展示 minimizer artifact；原生结果只携带数据。

### 取消、超时与 abort

- `CancelToken` 由 `timeoutMs` 和可选的 `AbortSignal` 构造，然后转换为共享的 `pi_shell::cancel::CancelToken`。
- 在取消/超时时，触发 shell 取消令牌，运行子孙进程清理，然后任务获得 2 秒的优雅等待窗口，之后强制 abort。
- 使用结构化的结果标志：
  - timeout -> 省略 `exitCode`，`timedOut: true`。
  - abort signal / `Shell.abort()` -> 省略 `exitCode`，`cancelled: true`。

`Shell.abort()` 行为：

- 通过存储的 `AbortToken` abort 该 `Shell` 实例的当前运行命令，
- 即使没有命令在运行也能成功 resolve。

### 失败行为

常见的暴露错误包括：

- 会话初始化失败（`Failed to initialize shell`），
- cwd 错误（`Failed to set cwd`），
- 环境 set/pop 失败，
- snapshot source 失败（`Failed to source snapshot`），
- 管道创建/clone 失败，
- 执行失败（`Shell execution failed: ...`），
- 任务包装器失败（`Shell execution task failed: ...`）。

## PTY 子系统（`pty`）

### API 模型

`new PtySession()` 暴露：

- `start(options, onChunk?, onStart?) -> Promise<{ exitCode?, cancelled, timedOut }>` 通过 shell 运行命令字符串。
- `startArgv(options, onChunk?, onStart?)` 直接运行应用及其参数向量，不经过 shell 解析。
- `write(data)`
- `resize(cols, rows)`
- `kill()`

两个 start 方法都会在 spawn 之后调用 `onStart(error, pid)`（仅当平台子进程 PID 不可用时，实现才会传 `0`）。`PtyStartOptions` 支持 `command`、可选的 `cwd`、`env`、`timeoutMs`、`signal`、`cols`、`rows` 和 `shell`；默认 shell 是 `sh`。`PtyArgvStartOptions` 则要求提供 `application` 和 `args`，且不包含 `shell`。

### 运行时生命周期与状态转换

`PtySession` 状态机：

- **Idle**：`core: None`。
- **Reserved**：`start()` 在异步工作开始前同步安装控制通道（`core: Some`），使 `write/resize/kill` 立即可用。
- **Running**：阻塞式 PTY 循环处理子进程状态、读取事件、取消心跳以及控制消息。
- **Terminal closed / drain**：子进程退出或取消启动一个短暂的读取排空窗口。
- **Finalized**：在 start 任务完成（成功或失败）后，`core` 总是被重置为 `None`。

并发保护：

- 在已运行时再次启动会返回 `PTY session already running`。

### Spawn/attach/write/read/terminate 模式

- PTY 通过 `portable_pty::native_pty_system().openpty(...)` 打开。
- 在 Windows 上，`openpty()` 在辅助线程上运行，并有 5s 启动超时；超时会以 `PTY creation timed out (5s). ConPTY may be unavailable on this system.` 拒绝。
- `start()` 通过配置的 shell 运行命令：
  - `cmd.exe`/`cmd` 使用 `/c`，
  - `powershell`/`pwsh` 使用 `-Command`，
  - 其他 shell 使用 `-lc`。
- `startArgv()` 将每个参数直接传递给 `portable_pty::CommandBuilder`。
- 默认尺寸为 `120x40`；在 start 和 resize 时对尺寸进行限制（`cols 20..400`，`rows 5..200`）。
- `write()` 将原始字节发送到 PTY stdin。
- `resize()` 发送控制消息并再次限制尺寸。
- `kill()` 发送控制消息，将本次运行标记为 cancelled 并终止 PTY 进程目标。

输出路径：

- 专用读取线程读取主端流，
- 增量 UTF-8 解码对非法字节发出 `U+FFFD`，
- 数据块通过 N-API 线程安全回调转发。

终止路径：

- `terminate_pty_processes` 在可用时定位 PTY 进程组，并在可用时定位子进程 pid。
- 它发送平台 `TERM_SIGNAL`，调用 `child.kill()`，然后发送平台 `KILL_SIGNAL`。
- 在 Windows 上，丢弃主端之前会先关闭 ConPTY 输入；主端的 drop 被卸载到后台线程，并等待最多 2s 以避免死锁。

### 取消与超时语义

- `timeoutMs` 和 `AbortSignal` 喂给 `CancelToken`。
- 循环以最大 16ms 的等待节奏周期性地调用 `ct.heartbeat()`。
- 超时分类基于心跳错误字符串是否包含 `Timeout`。
- 取消/kill 启动 300ms 的取消后排空窗口；正常子进程退出启动 300ms 的退出后排空窗口。
- 最终读取排空在非 Windows 上为 50ms，在 Windows 上为 500ms。

### 失败行为

错误场景包括：

- PTY 分配/打开失败，
- Windows PTY 启动超时，
- PTY spawn 失败，
- writer/reader 获取失败，
- 子进程 status/wait 失败，
- 锁中毒，
- 控制通道断开（`PTY session is no longer available`）。

未运行时的控制调用失败：

- `write/resize/kill` 返回 `PTY session is not running`。

## 进程子系统（`ps`）

### API 模型

当前 JS 表面是 `Process` 类：

- `Process.fromPid(pid) -> Process | null`
- `Process.fromPath(path) -> Process[]`
- getters：`pid`、`ppid`
- methods：`args()`、`killTree(signal?)`、`terminate(options?)`、`waitForExit(options?)`、`groupId()`、`children()`、`status()`

`ProcessTerminateOptions` 支持 `{ group?, gracefulMs?, timeoutMs?, signal? }`。`ProcessWaitOptions` 支持 `{ timeoutMs?, signal? }`。

### 行为

- `killTree(signal?)` 向进程及其子孙进程发送所请求的信号，先子进程后父进程；在 Windows 上忽略 signal 参数，并通过 `TerminateProcess` 终止进程。
- `terminate(options?)` 是异步的。默认使用 1000ms 优雅阶段和 5000ms 硬终止后等待。传入 `gracefulMs < 0` 跳过优雅阶段。支持时 `group: true` 还会定位进程组；abort 其 signal 会 reject promise。
- `waitForExit(options?)` 在进程退出时 resolve `true`，超时时 resolve `false`；abort 其 signal 会 reject promise。

平台特定实现位于 `pi_shell::process`；`crates/pi-natives/src/ps.rs` 是 N-API shim 以及供 PTY 终止使用的 re-export。

## 按键解析子系统（`keys`）

### API 模型

暴露的辅助函数：

- `parseKey(data, kittyProtocolActive)`
- `matchesKey(data, keyId, kittyProtocolActive)`
- `parseKittySequence(data)`
- `matchesKittySequence(data, expectedCodepoint, expectedModifier)`
- `matchesLegacySequence(data, keyName)`

### 解析模型

解析器结合了：

- 直接单字节映射（`enter`、`tab`、`ctrl+<letter>`、可打印 ASCII），
- O(1) 旧式转义序列查找（PHF map），
- xterm `modifyOtherKeys` 解析，
- Kitty 协议解析（`CSI u`、`CSI ~`、`CSI 1;...<letter>`），
- 标准化为 key ID（`ctrl+c`、`shift+tab`、`pageUp`、`f5` 等）。

修饰键处理：

- 按键匹配时只比较 shift/alt/ctrl/super 位，
- 比较前屏蔽掉 lock 位。

布局行为：

- 基础布局兜底被刻意收紧，使重映射的布局不会为 ASCII 字母/符号产生错误匹配。

### 失败行为

- 无法识别或非法的序列会从 parse 函数返回 `null`。
- 解析失败或不匹配时，match 函数返回 `false`。
- 不会对格式错误的按键输入抛出错误。

## JS API ↔ Rust 导出映射

### Shell + PTY + Process

| JS API                                       | Rust N-API export                  | Notes                                            |
| -------------------------------------------- | ---------------------------------- | ------------------------------------------------ |
| `executeShell(options, onChunk?)`            | `executeShell` (`execute_shell`)   | One-shot shell execution                         |
| `new Shell(options?)`                        | `Shell` class                      | Persistent shell session                         |
| `shell.run(options, onChunk?)`               | `Shell::run`                       | Reuses session on keepalive control flow         |
| `shell.abort()`                              | `Shell::abort`                     | Aborts active run for that shell instance        |
| `shell.liveBackgroundJobCount()`             | `Shell::live_background_job_count` | Reaps jobs, then counts live background children |
| `new PtySession()`                           | `PtySession` class                 | Stateful PTY session                             |
| `pty.start(options, onChunk?, onStart?)`     | `PtySession::start`                | Shell-command PTY run                            |
| `pty.startArgv(options, onChunk?, onStart?)` | `PtySession::start_argv`           | Direct executable/argv PTY run                   |
| `pty.write(data)`                            | `PtySession::write`                | Raw stdin passthrough                            |
| `pty.resize(cols, rows)`                     | `PtySession::resize`               | Clamped terminal dimensions                      |
| `pty.kill()`                                 | `PtySession::kill`                 | Terminates active PTY child/targets              |
| `Process.fromPid(pid)`                       | `Process::from_pid`                | Stable process reference lookup                  |
| `Process.fromPath(path)`                     | `Process::from_path`               | Executable-path process lookup                   |
| `process.killTree(signal?)`                  | `Process::kill_tree`               | Children-first process tree termination          |
| `process.terminate(options?)`                | `Process::terminate`               | Graceful then hard process termination           |
| `process.waitForExit(options?)`              | `Process::wait_for_exit`           | Async exit wait                                  |
| `process.children()`                         | `Process::children`                | Direct children as `Process[]`                   |
| `process.status()`                           | `Process::status`                  | `running` / `exited`                             |

### Keys

| JS API                                         | Rust N-API export                                   | Notes                           |
| ---------------------------------------------- | --------------------------------------------------- | ------------------------------- |
| `matchesKittySequence(data, cp, mod)`          | `matchesKittySequence` (`matches_kitty_sequence`)   | Kitty codepoint+modifier match  |
| `parseKey(data, kittyProtocolActive)`          | `parseKey` (`parse_key`)                            | Normalized key-id parser        |
| `matchesLegacySequence(data, keyName)`         | `matchesLegacySequence` (`matches_legacy_sequence`) | Exact legacy sequence map check |
| `parseKittySequence(data)`                     | `parseKittySequence` (`parse_kitty_sequence`)       | Structured Kitty parse result   |
| `matchesKey(data, keyId, kittyProtocolActive)` | `matchesKey` (`matches_key`)                        | High-level key matcher          |

## 弃用会话清理与收尾说明

- **Shell 持久化会话**：若一次 run 被取消/超时/出错/控制流非 keepalive，Rust 会丢弃内部会话状态。成功的常规 run 保留会话以供复用。
- **PTY 会话**：`core` 在 `start()` 结束后总是被清除，包括失败路径。
- 包装器**未暴露由 JS finalizer 驱动的显式 kill 契约**；清理主要绑定到 run 完成/取消路径。调用方应使用 `timeoutMs`、`AbortSignal`、`shell.abort()` 或 `pty.kill()` 实现确定性的 teardown。