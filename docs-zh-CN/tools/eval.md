# eval

> 在持久化的语言运行时中执行一个 Python、JavaScript、Ruby 或 Julia 单元。一次工具调用即一个单元；状态在后续调用之间保持。

> **注意：** 不要通过 `bash` 调用 `python -c`、`ruby -e`、`julia -e`、`bun -e` 或 `node -e` 来执行临时代码。`eval` 提供保留状态、结构化的 `display()` 捕获、工具/子代理桥接、流式输出、取消以及由 artifact 支持的截断功能。

## Source
- 入口与动态 schema：`packages/coding-agent/src/tools/eval.ts`
- 后端启用：`packages/coding-agent/src/tools/eval-backends.ts`
- 模型侧提示词：`packages/coding-agent/src/prompts/tools/eval.md`
- 共享契约：`packages/coding-agent/src/eval/backend.ts`、`types.ts`、`executor-base.ts`、`kernel-base.ts`
- 宿主桥接：`packages/coding-agent/src/eval/agent-bridge.ts`、`completion-bridge.ts`、`concurrency-bridge.ts`、`budget-bridge.ts`
- JavaScript：`packages/coding-agent/src/eval/js/`
- Python：`packages/coding-agent/src/eval/py/`
- Ruby：`packages/coding-agent/src/eval/rb/`
- Julia：`packages/coding-agent/src/eval/jl/`
- 输出/截断：`packages/coding-agent/src/session/streaming-output.ts`
- Python 内部细节：`docs/python-repl.md`

## Inputs

params 对象即一个单元。`cells` 数组、表头解析器、语言探测、隐式回退一律不存在。增量步骤通过独立的工具调用运行；每种语言各自保持状态。

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `language` | `"py" \| "js" \| "rb" \| "jl"` | Yes | 显式的后端标记。通常线上 schema 仅包含已启用的运行时；见下文全部禁用的边界情况。 |
| `code` | `string` | Yes | 单元主体，按原样执行。 |
| `title` | `string` | No | 简短的转录标签。 |
| `timeout` | `number` | No | 运行时工作的超时时间（秒）。默认 30；`0` 禁用单元超时。非零值受工具超时策略和 `tools.maxTimeout` 限制。 |
| `reset` | `boolean` | No | 执行前重建该语言的保留运行时。其他语言的运行时不受影响。默认 `false`。 |

跨三次调用的示例：

```json
{"language":"py","title":"imports","code":"import json\nfrom pathlib import Path"}
```

```json
{"language":"py","title":"load config","code":"data = json.loads(read('package.json'))\ndisplay(data)"}
```

```json
{"language":"py","title":"reuse state","code":"display(sorted(data['dependencies']))"}
```

## Backend availability

`resolveEvalBackends(...)` 将设置与环境覆盖合并：

| Token | Runtime | Setting/default | Environment override | Additional prerequisite |
| --- | --- | --- | --- | --- |
| `py` | 保留的 IPython 风格 Python 内核 | `eval.py=true` | `PI_PY` | 可用的已配置 Python 解释器/内核 |
| `js` | 保留的 Bun worker VM | `eval.js=true` | `PI_JS` | 内置 JS 运行时 |
| `rb` | 保留的 Ruby 内核 | `eval.rb=false` | `PI_RB` | 可用的 `ruby.interpreter` 或已发现的 Ruby |
| `jl` | 保留的 Julia 内核 | `eval.jl=false` | `PI_JL` | 可用的 `julia.interpreter` 或已发现的 Julia |

Ruby 与 Julia 为可选启用。当至少有一个运行时启用时，已禁用的运行时将从会话作用域的线上 schema 与模型提示词中移除。若**四个全部**禁用，当前的 `parameters` 回退会返回完整的静态联合类型，尽管每次执行都会被 `resolveBackend(...)` 拒绝；这与附近源码注释中“已禁用的后端不会到达模型”的说法相矛盾。请求不可用的运行时将抛出 `ToolError`；该工具绝不会替换为另一种语言。

## Outputs

`execute()` 返回一个文本内容块以及任意图像块。`onUpdate` 在运行期间流式输出当前单元的输出和详情。

- 文本为 stdout/stderr，加上对模型可见的 JSON `display()` 值和图像维度说明。
- 仅图像成功时报告 `(displayed N image(s); no text output)`；无可见输出的单元报告 `(no output)`。
- 后端非零退出码会追加 `Command exited with code N`，将单元标记为 `error`，并设置 `details.isError`。
- 取消操作返回已捕获的输出或 `Command aborted`，并设置 `details.isError=true`。

`EvalToolDetails`：

- `cells`：一个元素的 `EvalCellResult[]`，包含 `index`、`title?`、`code`、后端 `language`、`output`、`status`、`durationMs?`、`exitCode?`、`statusEvents?` 和 `hasMarkdown?`。
- `language`：实际使用的后端；`languages`：去重后的后端列表。这些字段保留了历史的多单元兼容形态，但当前一次调用只对应一个后端。
- `jsonOutputs`：通过结构化 display 捕获的值。
- `images`：在有图像到达时出现在实时更新中；最终图像作为内容块返回。
- `statusEvents`：去重后的 helper/tool 状态事件。
- `notice`：可选的后端通知。
- `meta`：由 `toolResult(...)` 提供的输出截断/artifact 元数据。
- `isError`：在后端失败或取消时设置。

渲染器将调用与结果内联合并，按声明的 language 进行语法高亮，并对 markdown 与 JSON 树进行专门渲染，同时显示超时/截断元数据。`session.allocateOutputArtifact?.("eval")` 为溢出的输出提供支持；`meta` 中的 `artifact://...` 可访问完整捕获内容。

## Execution flow

1. `EvalTool` 根据已启用的语言构建会话特定的 schema。它是 essential、strict，`approval="exec"`，在单个代理会话内 `concurrency="exclusive"`。
2. `execute()` 将 `py/js/rb/jl` 映射到 `python/js/ruby/julia`，解析可用性，并将单一输入包装为渲染器兼容的内部单元列表。
3. 它从 `session.getEvalSessionId?.()` 或 `defaultEvalSessionId(session)` 获取保留的 executor id，分配输出 sink/artifact，并通过 `trackEvalExecution?.(...)` 注册本次运行。
4. 超时默认为 30 秒。`0` 不创建看门狗；否则 `IdleTimeout` 与工具及会话中止信号组合。
5. `agent()`、`parallel()` 和 `completion()` 会发出 pause/resume 状态操作：在这些宿主桥接中花费的时间不消耗单元的运行时工作预算。计算、输出、状态 helper 和普通的 `tool.*` 调用则会消耗预算。
6. 选定的后端接收 cwd、保留的会话 id、会话文件、内核所有者、reset 标志、回调以及取消信号。
7. 输出块流入支持 artifact 的 `OutputSink` 和实时尾部。丰富的 display 被分离为 JSON、图像、markdown 和状态通道。
8. 成功、非零退出和取消被组装为上文的结果形态。即使执行失败，输出 sink 也会被终结。

## Runtime behavior

### JavaScript (`js`)

- 由 `js:${sessionId}` 键控的持久 worker VM；`reset` 会重建 VM，并对共享该 session id 的并发用户具有破坏性。
- 运行在 Bun 之下，暴露宿主全局对象，包括 `Bun`、`Buffer`、`fetch`、`process`、`require`、`createRequire`、`fs` 和 Web Crypto。
- 顶层 `await` 和裸 `return` 通过异步包装生效。
- 静态顶层 import 与动态 import 通过本地模块加载器被重写。本地文件系统 import 在单元之间进行缓存破坏；bare 包和 scheme/URL import 保持正常缓存一致性。
- 被 `await` 的区间可以与共享该 executor 的另一会话交错执行；同步代码仍会阻塞 worker 事件循环。

### Python (`py`)

- 保留的内核由 `python:${sessionId}`、归一化的 cwd 和解释器键控。`python.kernelMode="per-call"` 则为每次调用创建并关闭一个新内核。
- 运行器使用一个持久的 asyncio 事件循环，因此顶层 `await` 有效；在该上下文中 `asyncio.run(...)` 无效。
- MIME 帧支持 status、PNG、JSON、markdown、纯文本以及 HTML 到 markdown 的转换。
- 交互式 stdin 将被拒绝，并报错 `Kernel requested stdin; interactive input is not supported.`。
- 同步块使用默认执行器，并复制 ContextVars；Python 字节码仍会争抢 GIL。

### Ruby (`rb`)

- 保留的内核由 `ruby:${sessionId}`、归一化的 cwd 和解释器键控。
- 单元在持久化的 `TOPLEVEL_BINDING` 中求值；局部变量、方法和常量都会保留。尾部值在不是 nil、赋值或定义时，会像 IRB 一样展示。
- 富显示支持 OMP MIME 约定以及与 IRuby 兼容的 MIME hook，使用共享的内核 display 管线。
- `reset` 会替换保留的 Ruby 内核。

### Julia (`jl`)

- 保留的内核由 `julia:${sessionId}`、归一化的 cwd 和解释器键控。
- 单元在持久化的 `Main` 中求值；带有值的尾部表达式会被展示，除非被语句形式抑制。
- Julia 的 display 栈被桥接到相同的 MIME/status 管线。
- `reset` 会替换保留的 Julia 内核。

## Prelude helpers

所有已启用的运行时在语言允许的情况下暴露等价的 helper：

- `display(value)`、`print(...)`
- `read(path, offset?, limit?)`、`write(path, content)`、`env(...)`、`output(...)`
- `tool.<name>(args)` 用于一次普通的会话工具调用
- `completion(...)`、`agent(...)`、`parallel(...)`、`pipeline(...)`
- `log(message)`、`phase(title)`、`budget`

JS 的文件系统/桥接 helper 是异步的；Python、Ruby 和 Julia 的 helper 是同步的。`read()` 将非 `local://` 协议委托给已注册的 read 工具，通过注入的根解析 `local://`，并相对于 cwd 读取常规路径。`write()` 接受常规路径和 `local://` 路径，但拒绝其他协议 URL。

`display()` 根据后端捕获 JSON 兼容结构、图像、markdown 或文本。Ruby 和 Julia 还会自动展示符合条件的尾部表达式。

### `completion()`

一次无状态、无工具的 one-shot 模型调用：

- JS：`await completion(prompt, { model?, system?, schema? })`
- Python/Ruby/Julia：使用带 `model`、`system` 和 `schema` 关键字参数的形式
- `model`：`"smol"`、`"default"` 或 `"slow"` 档位；默认为当前激活/默认档位。
- `schema`：用于合成 `respond` 工具的 JSON Schema；成功的结构化调用返回解析后的数据。
- 未解析的档位、缺少凭据、错误/中止停止、空输出以及无效的结构化输出都会在单元内抛出。

### `agent()`

通过 `runStructuredSubagent(...)` 运行一个子代理：

- JS 支持首选的 `await agent(prompt, { agent?, label?, schema?, schemaMode?, isolated?, apply?, merge?, handle? })`；旧式位置参数槽位仍然实现。
- Python/Ruby/Julia 使用关键字参数（JS 之外使用 `schema_mode`）。
- `agent` 默认为当前的 spawn policy；所选代理的 frontmatter 模型和设置始终生效（不接受每次调用的模型覆盖 — `model` 不被接受）。`schema` 会覆盖代理/会话 schema；`schemaMode`/`schema_mode` 选择 `permissive` 或 `strict`。
- `isolated` 请求隔离。`apply` 控制是否合并捕获的变更；`merge=false` 选择 patch 模式，而常规设置控制 branch 模式。
- `handle=true` 返回 `{ text, output, handle, id, agent }`，可选的解析后 `data`，以及隔离元数据，而不仅仅是 output/data。
- Eval 子代理是一次性的（`keepAlive=false`），完成后会被注销/释放，并且**不共享调用方的 eval executor**（`shareEvalSession=false`）。因此它们对代码的修改不会出现在调用方的保留 VM/内核中。
- spawn policy、已发现代理的可用性、`task.maxRecursionDepth` 闸门（默认 `2`；负值禁用上限）、硬性轮次预算、子代理失败、严格 schema 失败以及隔离-应用失败都会被强制作为单元错误抛出。

`parallel(thunks)` 在有界池中运行零参 callable，并保留输入顺序。`pipeline(items, ...stages)` 将每个阶段应用为带屏障的波次。池宽度从 `task.maxConcurrency` 实时读取；`0` 表示一次性运行所有项。最低索引的失败会被向上传播。

## Side effects and cancellation

- Prelude helper 可能读/写文件并调用任意已注册的工具；JS 暴露具有网络能力的 `fetch`。
- Python、Ruby 和 Julia 使用保留的子进程内核，通过本地 IPC 帧协议通信。JavaScript 使用 worker VM。
- 保留的运行时在 reset、所有者清理或进程退出之前会在调用之间保持存活。
- 必要时取消具有破坏性：JS 终止其 worker；被管理的内核被中断，并可能升级为关闭。reset 同样会对共享该后端会话的并发工作造成破坏。
- eval 驱动的 `agent()` 可以运行工具和隔离工作区，但其子代会被释放，而不会为 hub 跟进而保留。

## Limits and errors

- 默认超时：30 秒；`0` 禁用。非零超时通过 `clampTimeout("eval", ..., tools.maxTimeout)` 进行裁剪。
- 输出 sink 默认窗口：50 KiB（`DEFAULT_MAX_BYTES`）；实时尾部：100 KiB；截断 helper 上限为 3000 行。
- 包含在模型可见文本中的每个 JSON display 值上限为 8000 字符；完整的结构化值保留在 `jsonOutputs` 中。
- 转录预览默认为 10 行。
- eval 子代理的生成遵循 `task.maxRecursionDepth`（默认 `2`；负值允许无限深度）。helper 扇出使用 `task.maxConcurrency`（默认 8，`0` 表示无界）。
- 畸形参数为 schema 错误；不可用/已禁用的后端以及缺失的会话为 `ToolError`。
- 运行时异常会以非零退出的后端输出形式呈现。交互式 stdin 为错误。输出截断不会导致调用失败。
- 已死的被管理保留内核可被替换，并由其 executor 重试一次。

## Notes

- 一次调用即一个单元。利用持久化分别调用，仅重跑失败的步骤。
- 状态按语言隔离；reset Python 不会 reset JS、Ruby 或 Julia。
- 当前 schema 标记仅有 `py`、`js`、`rb` 和 `jl`；较长的语言名称是渲染器/审批格式化的别名，不是线上值。
- 原先的多单元 `cells` 载荷、`*** Cell` 解析器、探测回退以及受限的 `eval.lark` 语法均已移除。
- 父代理和普通任务子代理可共享继承的 eval executor id；由 eval 自身的 `agent()` 创建的子代理显式不共享。
