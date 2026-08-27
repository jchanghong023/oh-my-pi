# Eval 工具 Python 后端

本文档介绍 `packages/coding-agent` 中的 Python 执行栈。
内容涵盖工具行为、运行器生命周期、环境处理、执行语义、输出渲染、支持的魔术命令以及运行期故障模式。

## 范围与关键文件

- 工具面：`src/tools/eval.ts`
- 会话/按调用内核编排：`src/eval/py/executor.ts`
- 子进程内核客户端：`src/eval/py/kernel.ts`
- Python 包装器 / NDJSON 服务端：`src/eval/py/runner.py`
- 每个内核都会加载的预置辅助代码：`src/eval/py/prelude.py`
- 宿主侧子代理辅助桥接：`src/eval/agent-bridge.ts`
- MIME 包渲染器（文本 + 结构化输出）：`src/eval/py/display.ts`
- 用户触发的 Python 运行的交互模式渲染器：`src/modes/components/eval-execution.ts`
- 运行时/环境过滤与 Python 解析：`src/eval/py/runtime.ts`

## eval 的 Python 后端是什么

`eval` 工具在一次调用中执行一个 Python 代码单元，运行在通过 stdin/stdout 使用 NDJSON 通信的常驻 `python` 子进程中。无需 Jupyter 网关，也无需额外的 pip 依赖。打包的运行器使用 Python 3.10 语法（`str | None`），因此实际要求是 Python 3.10+。富 `display()` 输出（PIL、pandas、plotly、matplotlib 图形）之所以可用，是因为包装器实现了 MIME 包分派。

当前工具输入：

```ts
{
  language: "py";
  code: string;
  title?: string;
  timeout?: number; // seconds; default 30, 0 disables, otherwise clamped to 1..3600
  reset?: boolean;  // wipe the Python kernel before this call
}
```

会话作用域的线协议 schema 仅声明已启用的运行时。静态实现同样支持 `"js"`、`"rb"` 和 `"jl"`；Python 与 JavaScript 默认开启，而 Ruby 与 Julia 需显式启用。工具的 `concurrency = "exclusive"` 针对一个会话，因此调用不会并发。同一种语言运行时的多次调用之间状态会保留。

## 内核生命周期

每个 Python 内核是一个独立的子进程：`<resolved-python> -u <runner.py>`。运行器随宿主页二进制一同打包（通过 Bun 文本导入加载），按脚本哈希写入操作系统临时目录下名为 `omp-python-runner` 的缓存中一次，后续启动复用同一文件。

内核启动顺序：

1. 可用性检查（`checkPythonKernelAvailability`）—— 验证 Python 解释器能够解析并运行。
2. 以经过过滤的环境和 `cwd` 启动 `python -u runner.py`。
3. 发送初始化请求，执行 `os.chdir(cwd)`，注入环境变量，并将 `cwd` 加入 `sys.path`。
4. 执行 `PYTHON_PRELUDE`（幂等 —— 每个进程只初始化一次）。

内核关闭：

- 通过 stdin 发送 `{"type": "exit"}`。
- 在 `SHUTDOWN_GRACE_MS` 预算内等待进程退出。
- 如果进程在该时间内未退出，则升级为 `SIGTERM`，最终使用 `SIGKILL`。

## 线协议（NDJSON，宿主 ↔ 运行器）

每行一个 JSON 对象，UTF-8 编码，以 `\n` 结尾。

宿主 → 运行器：

```jsonc
{"id": "<reqId>", "code": "<source>", "silent": false, "storeHistory": true, "cwd": "<optional>", "env": {"KEY": "VAL"}}
{"type": "exit"}
```

运行器 → 宿主：

```jsonc
{"type": "started",  "id": "<reqId>"}
{"type": "stdout",   "id": "<reqId>", "data": "..."}
{"type": "stderr",   "id": "<reqId>", "data": "..."}
{"type": "display",  "id": "<reqId>", "bundle": {<mime>: <value>}}
{"type": "result",   "id": "<reqId>", "bundle": {<mime>: <value>}}
{"type": "error",    "id": "<reqId>", "ename": "...", "evalue": "...", "traceback": ["..."]}
{"type": "done",     "id": "<reqId>", "status": "ok"|"error", "executionCount": N, "cancelled": false}
```

预置代码发出的状态事件（例如 `_emit_status("find", count=…)`）以 `application/x-omp-status` 形式随显示包一起传递，从而现有 TUI 状态渲染器可以继续工作。

## 魔术命令

运行器的源转换器在解析之前将 IPython 风格的魔术命令重写为普通的 Python 调用。支持的集合：

| Magic                             | Effect                                                                                                                                                      |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `%pip <args>`                     | `python -m pip <args>` with live streaming output. Newly installed packages are evicted from `sys.modules` so the next `import` picks up the fresh install. |
| `%cd <path>`                      | `os.chdir(path)` (with `~` expansion); emits status event.                                                                                                  |
| `%pwd`                            | Returns `os.getcwd()`.                                                                                                                                      |
| `%ls [path]`                      | Returns `sorted(os.listdir(path))`.                                                                                                                         |
| `%env [KEY[=VAL]]`                | List, read, or set env vars (matches prelude `env()` semantics).                                                                                            |
| `%set_env KEY VALUE`              | Set `os.environ[KEY]`.                                                                                                                                      |
| `%time <expr>` / `%timeit <expr>` | Time the expression; emits status event with elapsed ms.                                                                                                    |
| `%who` / `%whos`                  | List user-namespace names.                                                                                                                                  |
| `%reset`                          | Clear user globals and re-inject prelude.                                                                                                                   |
| `%load <path>`                    | Read a file into a fresh cell and execute.                                                                                                                  |
| `%run <path>`                     | `runpy.run_path` and merge globals back.                                                                                                                    |
| `%%bash` / `%%sh`                 | Run the cell body via `bash`/`sh`.                                                                                                                          |
| `%%capture [name]`                | Run body with stdout/stderr captured into `name`.                                                                                                           |
| `%%timeit`                        | Time the cell body.                                                                                                                                         |
| `%%writefile <path>`              | Write body to file.                                                                                                                                         |
| `!cmd` / `var = !cmd`             | Run command via subprocess shell; returns an SList-style result with `.n` / `.s` helpers.                                                                   |
| `var = %name args`                | Assignment forms work for line magics and `!cmd`.                                                                                                           |

未知的魔术命令会在代码单元内抛出 `NameError: UsageError: ...`。

## 会话持久化语义

`python.kernelMode` 控制常驻内核的复用方式：

- `session`（默认）
  - 按命名空间化的 eval 会话 id 加上规范化后的 cwd 与解释器作为键，复用内核会话。
  - 多个所有者可以共享该键下的同一个常驻内核。
  - 通过该工具的调用是排他的，因此工具调用不会重叠。
  - 已死的常驻子进程会在执行前被替换。
  - 如果子进程在执行期间死亡，会进行替换并重试该调用一次。
- `per-call`
  - 每次调用都会启动一个新的子进程。
  - 调用结束后关闭该子进程。
  - 调用之间不保留状态。

### eval 调用之间的状态

每次工具调用包含一个代码单元。Python 调用按顺序执行，因为该工具是排他的；在 `session` 模式下，后续调用会复用所选的常驻内核。

如果某个代码单元失败，在错误发生之前完成的定义和变更可能会保留在内核内存中。`reset: true` 只会在该调用之前重置所选的语言运行时；其他语言运行时不受影响。

## 环境过滤与运行时解析

在启动运行器之前会对环境进行过滤：

- 白名单包含 `PATH`、`HOME`、区域设置变量、`VIRTUAL_ENV`、`PYTHONPATH` 等核心变量。
- 允许前缀：`LC_`、`XDG_`、`PI_`
- 黑名单移除常见的 API 密钥（OpenAI/Anthropic/Gemini 等）

运行时选择顺序（当 `python.interpreter` 设置显式指定了可执行文件时，整套流程会被跳过）：

1. 活动/已定位的 venv（`VIRTUAL_ENV`，接着 `CONDA_PREFIX`，接着 `<cwd>/.venv`，`<cwd>/venv`）
2. `~/.omp/python-env` 下的托管 venv
3. PATH 中的 `python` 或 `python3`

当选择 venv 时，其 bin/Scripts 路径会被前置到 `PATH` 中。

运行器还会接收 `PYTHONUNBUFFERED=1` 与 `PYTHONIOENCODING=utf-8`，以便流式输出能够及时到达宿主。

## 工具可用性与模式选择

后端设置 `eval.py` / `eval.js` 默认为 `true`；`eval.rb` / `eval.jl` 默认为 `false`。可选的布尔环境变量 `PI_PY`、`PI_JS`、`PI_RB` 与 `PI_JL` 各自独立地覆盖对应的设置。

该工具的会话作用域 schema 仅列出已启用的运行时。如果 Python 预检失败而另一个运行时处于启用状态，则 `eval` 对该运行时仍然可用，`py` 调用会报告一个 Python 后端不可用的错误，并列出其他可用的运行时。

Python 预置辅助函数包含 `agent(prompt, *, agent="task", label=None, schema=None, schema_mode=None, isolated=None, apply=None, merge=None, handle=False)`。它会同步调用宿主桥接，并在提供 `schema` 时返回最终文本或已解析的数据。`schema_mode` 选择宽松或严格的结构化输出处理；`isolated`/`apply`/`merge` 标志控制任务工作树行为。当 `handle=True` 时，它返回一个 DAG 节点字典（`{"text", "output", "handle", "id", "agent"}`），其中 `handle` 是可恢复的 `agent://<id>` URI；当存在已解析的输出时，也会存放在 `"data"` 键下。

## 执行流程与取消/超时

### 代码单元超时

`timeout` 以秒为单位，默认为 30。`0` 表示禁用代码单元超时；非零值会被夹紧到 `1..3600` 秒之间，并受正值的 `tools.maxTimeout` 上限约束，然后传给 `IdleTimeout`。在宿主侧 `agent()` / `parallel()` / `completion()` 桥接调用进行期间，超时会被暂停：这些调用通过 `withBridgeTimeoutPause` 发出引用计数的 pause/resume 事件，控制流返回时将启动一个新的超时窗口。

pause/resume 事件是唯一能够暂停该预算的机制。计算、`stdout`/`stderr`、`log()`/`phase()` 以及普通的工具调用都会计入其中。该工具通过 `AbortSignal.any(...)` 将调用方、会话以及看门狗的中止信号合并使用；后端不会另外启动一个相互竞争的截止时间。

### 内核执行取消

发生中止/超时时：

- 宿主向运行器子进程发送 `kill("SIGINT")`。
- 运行器在执行期注册的信号处理函数会在用户代码内抛出 `KeyboardInterrupt`。
- 结果会包含 `cancelled=true`；内核超时会被注释为 `eval cell timed out after <n>s; kernel interrupted but remains running. Reset the kernel via { reset: true } if state appears corrupted.`
- 在两次请求之间，运行器将 SIGINT 设为 `SIG_IGN`，以避免误发的取消信号把内核整个关掉。

如果在中断后 5 秒内运行器未发出 `done`（`INTERRUPT_ESCALATION_MS` —— 例如卡在持有 GIL 的 C 代码中），宿主会关闭该子进程（依次升级 `exit` → `SIGTERM` → `SIGKILL`），将该代码单元标记为内核被杀，并在下一次调用时重建内核。

### stdin 行为

不支持交互式 stdin。运行器不会转发 `input()` 提示；调用 `input()` 的用户代码会一直阻塞，直至被取消。

## 输出捕获与渲染

### 捕获的输出类别

来自运行器帧：

- `stdout` / `stderr` → 纯文本块
- `display` / `result` → 富显示处理（MIME 包）
- `error` → 回溯文本
- `display` 内的 `application/x-omp-status` MIME → 结构化状态事件

显示 MIME 优先级：

1. `text/markdown`
2. `text/plain`
3. `text/html`（转换为基本 markdown）

另外作为结构化输出捕获：

- `application/json` → JSON 树数据
- `image/png` / `image/jpeg` → 图像负载
- `application/x-omp-status` → 状态事件

### Matplotlib

运行器将 `MPLBACKEND=Agg` 设为默认环境变量，以便图形在离屏渲染。每个代码单元结束后，遍历 `pyplot.get_fignums()`；每张图形被保存为 PNG，作为 `image/png` 显示发出，并关闭。

### 存储与截断

输出通过 `OutputSink` 进行流式传输，并可持久化到产物存储中。工具结果可以包含截断元数据以及用于恢复完整输出的 `artifact://<id>`。

### 渲染器行为

- 工具渲染器（`eval-render.ts`，从 `eval.ts` 重新导出）：
  - 显示带有逐代码单元状态的代码块
  - 折叠预览默认为 10 行
  - 支持对工具结果中保留的所有输出进行展开
- 交互渲染器（`eval-execution.ts`）：
  - 用于 TUI 中用户触发的 Python 执行
  - 折叠预览默认为 20 行
  - 为安全起见，将非常长的单行夹紧到 4000 字符
  - 显示取消/错误/截断提示

## 运行期故障排查

- **Python 后端不可用** —— 检查 `eval.py`、`PI_PY`，并确认 `python`/`python3` 在 PATH 中。如果启用了其他后端，请使用其声明的语言标识。
- **PATH 中没有 Python** —— 安装系统 Python 3.10+，或在 `~/.omp/python-env` 放置一个兼容的 venv。`omp setup python --check` 会报告解析到的解释器。
- **执行挂起并最终超时** —— 对于合理的工作请增大 `timeout`，或将其设为 `0` 以禁用看门狗。对于卡住的原生代码，取消会先发送 `SIGINT`，再进行升级；如果不得不杀死内核，会话模式会在下一次请求时重建该内核。
- **Python 代码中出现 stdin/input 提示** —— 不支持 `input()`；请以编程方式传入数据。
- **工作目录错误** —— Python 运行在会话 cwd 中。请在常驻内核内使用 `%cd` 或 `os.chdir()` 来更改它。

## 相关的环境变量

- `PI_PY` / `PI_JS` / `PI_RB` / `PI_JL` —— 逐后端的暴露开关覆盖
- `PI_PYTHON_SKIP_CHECK=1` —— 跳过 Python 预检/预热
- `PI_PYTHON_INTEGRATION=1` —— 启用会真正派生 Python 的受控集成测试
- `PI_PYTHON_IPC_TRACE=1` —— 记录与运行器子进程交换的 NDJSON 帧