# Native Rust 任务执行与取消（`pi-natives`）

本文档描述 `crates/pi-natives` 如何调度原生工作，以及取消如何从 JS 选项（`timeoutMs`、`AbortSignal`）流入到 Rust 执行过程。

## 实现文件

- `crates/pi-natives/src/task.rs`
- `crates/pi-natives/src/grep.rs`
- `crates/pi-natives/src/glob.rs`
- `crates/pi-natives/src/fd.rs`
- `crates/pi-natives/src/ast.rs`
- `crates/pi-natives/src/workspace.rs`
- `crates/pi-natives/src/shell.rs`
- `crates/pi-natives/src/pty.rs`
- `crates/pi-natives/src/html.rs`
- `crates/pi-natives/src/sixel.rs`
- `crates/pi-natives/src/clipboard.rs`
- `crates/pi-natives/src/text.rs`
- `crates/pi-natives/src/ps.rs`

## 核心原语（`task.rs`）

`task.rs` 定义了：

1. `task::blocking(tag, cancel_token, work)`
   - 包装 `napi::AsyncTask` / `Task`。
   - `compute()` 在 libuv 工作线程上运行。
   - 为导出函数返回 JS 的 `Promise<T>`。
   - 通过 `profile_region(tag)` 记录一份性能剖析采样。

2. `task::future(env, tag, work)`
   - 包装 `env.spawn_future(...)`。
   - 在 Tokio 的运行时上运行异步工作。
   - 返回 `PromiseRaw<'env, T>`。
   - 通过 `profile_region(tag)` 记录一份性能剖析采样。

3. `CancelToken` / `AbortToken` / `AbortReason`
   - `CancelToken::new(timeout_ms, signal)` 包装共享的 `pi_shell::cancel::CancelToken`，并可选择性地桥接一个 JS `AbortSignal`。
   - `CancelToken::heartbeat()` 用于阻塞循环的协作式取消。
   - `CancelToken::wait()` 异步等待信号或超时。
   - `CancelToken::abort_token()` 在共享标志已存在时返回一个由该标志支撑的 abort 句柄；没有标志时句柄是无效的。`emplace_abort_token()` 惰性安装标志并返回一个可用的句柄。`CancelToken::new` 使用后者将 JS `AbortSignal` 桥接到 `AbortReason::Signal`。
   - `CancelToken::aborted()` 提供非阻塞的信号/截止时间检查，`into_core()` 将 token 转移给 `pi-shell`。
   - `AbortToken::abort(reason)` 允许外部代码请求 abort。Reason 取值为 `Unknown`、`Timeout`、`Signal` 与 `User`。

## `blocking` 与 `future`：执行模型与选择

### 使用 `task::blocking`

在工作是 CPU 密集型或本质上是同步/阻塞时使用：

- 正则/文件扫描（`grep`、`glob`、`fuzzyFind`）
- ast-grep 搜索/编辑工作线程工作
- HTML 转换
- 剪贴板图像读取

行为：

- 工作闭包接收一个克隆的 `CancelToken`。
- 取消仅在代码检查 `ct.heartbeat()?` 的位置被观察到。
- 闭包返回 `Err(...)` 会使 JS Promise 被 reject。

### 使用 `task::future`

在工作必须 `await` 异步操作时使用：

- shell 会话编排（`Shell.run`、`executeShell`）
- PTY 外层 Promise（`PtySession.start`），在进入 `spawn_blocking` 之前
- 必须桥接完成与取消的异步任务编排

行为：

- Future 代码可以针对 `ct.wait()` 与正常完成进行竞速。
- 在取消路径上，异步实现通常会取消其下层机制，并可能在宽限超时之后强制中止。

## JS API ↔ Rust 导出映射（与任务/取消相关）

| JS-facing API                                                 | Rust export                 | Scheduler                                                      | Cancellation hookup                                                                                                                  |
| ------------------------------------------------------------- | --------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `grep(options, onMatch?)`                                     | `grep`                      | `task::blocking("grep", ct, ...)`                              | `CancelToken::new(options.timeoutMs, options.signal)` + heartbeat checks                                                             |
| `glob(options, onMatch?)`                                     | `glob`                      | `task::blocking("glob", ct, ...)`                              | `CancelToken::new(...)` + heartbeat checks                                                                                           |
| `fuzzyFind(options)`                                          | `fuzzy_find`                | `task::blocking("fuzzy_find", ct, ...)`                        | `CancelToken::new(...)` + heartbeat checks                                                                                           |
| `astGrep(options)` / `astMatch(options)` / `astEdit(options)` | ast exports                 | blocking worker path                                           | timeout/signal fields are accepted by options and checked cooperatively in worker loops                                              |
| `listWorkspace(options)`                                      | `list_workspace`            | `task::blocking("listWorkspace", ct, ...)`                     | `CancelToken::new(options.timeoutMs, options.signal)` + heartbeat checks                                                             |
| `Shell#run(options, onChunk?)`                                | `Shell::run`                | `task::future(env, "shell.run", ...)`                          | JS `CancelToken` is converted into `pi_shell::cancel::CancelToken`; shell races it against command completion and descendant cleanup |
| `executeShell(options, onChunk?)`                             | `execute_shell`             | `task::future(env, "shell.execute", ...)`                      | same cancellation race and 2s graceful window                                                                                        |
| `Process#terminate(options?)`                                 | `Process::terminate`        | `task::future(env, "process.terminate", ...)`                  | optional signal cancels termination waits; grace and hard-kill timeouts are process policy rather than `CancelToken` deadlines       |
| `Process#waitForExit(options?)`                               | `Process::wait_for_exit`    | `task::future(env, "process.wait_for_exit", ...)`              | optional signal is bridged through `CancelToken`; `timeoutMs` is the wait operation's typed `false` timeout                          |
| `PtySession#start(...)` / `startArgv(...)`                    | PTY methods                 | `task::future(env, "pty.start", ...)` + inner `spawn_blocking` | `CancelToken` checked in sync PTY loop via `heartbeat()`                                                                             |
| `htmlToMarkdown(html, options?)`                              | `html_to_markdown`          | `task::blocking("html_to_markdown", (), ...)`                  | none (`()` token)                                                                                                                    |
| `encodeSixel(...)`                                            | `encode_sixel`              | synchronous native function                                    | none                                                                                                                                 |
| `readImageFromClipboard()`                                    | `read_image_from_clipboard` | `task::blocking("clipboard.read_image", (), ...)`              | none (`()` token)                                                                                                                    |

`text.rs`、`tokens.rs`、`keys.rs`、大部分同步的 `ps.rs` 函数、SIXEL 编码以及同步的工具类导出都不使用 `task::blocking`/`task::future` 取消。异步的 `Process.terminate()` 与 `Process.waitForExit()` 方法会使用。

## 取消生命周期与状态转换

### `CancelToken` 生命周期

```text
Created
  ├─ no signal + no timeout  -> passive token
  ├─ signal registered        -> AbortSignal callback can set AbortReason::Signal
  └─ deadline set             -> timeout check becomes active

Running
  ├─ heartbeat()/wait() sees signal   -> AbortReason::Signal
  ├─ heartbeat()/wait() sees deadline -> AbortReason::Timeout
  └─ no abort                         -> continue

Aborted
  └─ shared flag wakes waiters; a later abort call can replace the stored reason, while a deadline is evaluated independently
```

### 启动前与执行中的取消

- **启动前 / 第一次取消检查之前**：
  - 在 `ct.wait()` 上进行竞速的 `task::future` 使用者，进入 `select!` 后即可立刻解析取消。
  - `task::blocking` 使用者只有在闭包代码到达 `heartbeat()` 时才会观察到取消。

- **执行过程中**：
  - `blocking`：下一次 `heartbeat()` 返回 `Err("Aborted: ...")`。
  - `future`：`ct.wait()` 分支在 `select!` 中胜出，然后代码会取消其下层的异步机制。
  - shell：取消会触发一个 Tokio 取消 token，发送下层终止波，等待命令任务最多 2 秒，必要时中止该任务。
  - PTY：`heartbeat` 失败或 `kill()` 会终止 PTY 子进程/目标进程并短暂排空输出。

## 长运行循环的 heartbeat 期望

`heartbeat()` 必须在具有无界或大型工作集的循环中以可预测的节奏运行。

观察到的模式包括：

- `glob` 与 `fuzzyFind` 将 heartbeat 回调传入 `pi-walker` 的遍历过程，并同时检查结果处理循环。
- `grep` 在执行昂贵搜索之前与过程中进行检查，并将 token 透传给其 scan/search 工作线程。
- `run_pty_sync` 在每个循环 tick 上检查，最大等待节奏为 16ms。
- `listWorkspace` 在遍历过程中进行检查。

实践准则：对于外部规模输入的循环，缺少 heartbeat 的间隔不应超过一个较短的限定时长。

## 失败行为与错误向 JS 的传播

### 阻塞任务

错误路径：

1. 闭包返回 `Err(napi::Error)`（包括 `heartbeat()` 触发的 abort）。
2. `Task::compute()` 返回 `Err`。
3. `AsyncTask` reject JS Promise。

典型的错误字符串：

- `Aborted: Timeout`
- `Aborted: Signal`
- 领域错误（`Failed to decode image: ...`、`Conversion error: ...` 等）

### Future 任务

错误路径：

1. 异步体返回 `Err(napi::Error)`，或 join 失败被映射为（`... task failed: {err}`）。
2. 由 `task::future` 启动的 Promise 被 reject。
3. Shell 与 PTY 命令 API 在取消路径胜出时，将取消建模为结构化结果而非 reject：`exitCode` 省略，`cancelled` 或 `timedOut` 被置位。

### 取消报告的拆分

- **将 abort 视为错误**：使用 `heartbeat()?` 的阻塞型导出。
- **将 abort 视为类型化结果**：在结果结构体中建模取消的 shell/PTY 命令 API。

每个 API 选择一种模型，并显式地在文档中记录。

## 常见陷阱

1. **阻塞循环中缺少 heartbeat**
   - 现象：直到循环结束之前，timeout/signal 似乎被忽略。
   - 修复：在循环顶部以及每个开销较大的单步操作前增加 `ct.heartbeat()?`。

2. **长时间不可取消的段落**
   - 现象：在单次大调用（解码、排序、压缩、解析器调用等）期间，取消延迟出现尖峰。
   - 修复：将工作拆分成带 heartbeat 边界的块；若无法拆分，则在文档中说明延迟。

3. **阻塞式异步执行器**
   - 现象：当下同步的代码直接在 future 中运行时，异步 API 会停滞。
   - 修复：将 CPU/同步代码块迁移到 `task::blocking` 或 `tokio::task::spawn_blocking`。

4. **取消语义不一致**
   - 现象：一个 API 在取消时 reject，另一个则以标志位 resolve，导致调用方困惑。
   - 修复：按领域标准化，并保持文档同步。

5. **在嵌套异步任务中忘记取消桥接**
   - 现象：外层 token 已被取消，但内部的 reader/子进程任务仍在继续运行。
   - 修复：将取消桥接到内层 token/signal，并强制执行宽限超时 + 强制 abort 兜底。

## 新增可取消导出的检查清单

1. 正确分类工作：
   - CPU-bound 或同步阻塞 -> `task::blocking`。
   - 异步 I/O / `await` 编排 -> `task::future`。

2. 在需要时暴露取消输入：
   - 在 `#[napi(object)]` options 中包含 `timeoutMs` 与 `signal`，
   - 创建 `let ct = task::CancelToken::new(timeout_ms, signal);`。

3. 在所有层次中连接取消：
   - 阻塞循环：以稳定间隔调用 `ct.heartbeat()?`，
   - 异步编排：与 `ct.wait()` 竞速，并取消子任务/子 token。

4. 决定取消契约：
   - 以 abort 错误 reject Promise，或
   - resolve 为类型化的 `{ cancelled, timedOut, ... }`，
   - 同一 API 族保持该契约一致。

5. 带上下文地传播失败：
   - 通过 `Error::from_reason(format!("...: {err}"))` 映射错误，
   - 包含阶段相关的前缀（`spawn`、`decode`、`wait` 等）。

6. 处理启动前与执行中取消：
   - 取消检查/await 必须发生在开销较大的主体之前，并在长执行过程中持续进行。

7. 验证不存在执行器误用：
   - 在异步 future 内不直接运行长时间同步工作，除非通过 `spawn_blocking`/阻塞任务包装。
