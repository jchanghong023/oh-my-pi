# Notebook 文件运行时内部实现

本文档介绍 `coding-agent` 中当前对 `.ipynb` 文件的处理方式及其与基于内核的 Python 运行时之间的关系。

关键区别在于：**notebook 支持是文件转换与编辑，而非 notebook 执行**。`.ipynb` 文件通过 `read` 和编辑管道以带单元格标记的可编辑文本形式呈现；并没有专门针对 notebook 的工具去启动 Python 内核或与之通信。

## 实现文件

- [`src/edit/notebook.ts`](../packages/coding-agent/src/edit/notebook.ts)
- [`src/edit/read-file.ts`](../packages/coding-agent/src/edit/read-file.ts)
- [`src/tools/read.ts`](../packages/coding-agent/src/tools/read.ts)
- [`src/tools/eval.ts`](../packages/coding-agent/src/tools/eval.ts)
- [`src/eval/py/executor.ts`](../packages/coding-agent/src/eval/py/executor.ts)
- [`src/eval/py/kernel.ts`](../packages/coding-agent/src/eval/py/kernel.ts)
- [`src/session/streaming-output.ts`](../packages/coding-agent/src/session/streaming-output.ts)

## 1) 运行时边界：编辑与执行

## `.ipynb` 文件转换（`src/edit/notebook.ts`）

- `read` 将 `.ipynb` 文件视为 notebook，除非选择器为 `:raw`。
- 默认的 notebook 视图是带标记的可编辑文本：
  - `# %% [code] cell:N`
  - `# %% [markdown] cell:N`
  - `# %% [raw] cell:N`
- 行选择器和多范围选择器都作用于这段虚拟文本。
- 编辑管道通过 `serializeEditedNotebookText(...)` 将虚拟文本往返转换回 notebook JSON。
- 当某个标记引用已存在但未使用的 `cell:N` 时，保留原有 notebook 元数据；新单元格会获得全新的空元数据。
- 如果传入序列化器的 notebook 不存在，则从一个空的 nbformat 4.5 notebook 开始。
- 独立的 `write` 工具不具备 notebook 感知能力：它会用提供的字节直接覆盖文件。仅在传入合法 notebook JSON 时使用它，不要传入虚拟标记表示。

此路径中不存在内核生命周期：

- 没有内核会话 ID
- 不执行代码
- 没有来自 Python 的流式分块
- 没有富文本展示捕获
- 没有来自执行的输出工件管道

## 基于内核的执行路径（`src/tools/eval.ts` + `src/eval/py/*`）

当智能体需要以持久状态和富文本展示运行单元格风格的 Python 代码时，应通过针对每个单元格的 **`eval` 工具** 调用（指定 `language: "py"`）来完成，而不是通过 notebook 文件处理。

Python 子进程生命周期、重置/取消行为、分块流式输出、富文本展示以及输出工件截断逻辑，都位于该路径中。

## 2) Notebook 单元格处理语义

## 源文本规范化

Notebook JSON 的 `source` 通过合并源数组转换为虚拟文本。当虚拟文本被序列化回时，单元格源会按保留换行符的方式拆分：

- 以 `\n` 结尾的每一行都作为独立的源条目保留换行
- 末尾不带换行的最后一行在存储时不强制追加换行
- 空内容会变成空的 `source` 数组

这与 notebook JSON 的约定一致，可以避免后续编辑时发生意外的行拼接。

### 类标记源文本的转义

在渲染时，本身看起来像单元格标记的源行会通过额外添加一个 `%` 进行转义（`# %% ...` 变为 `# %%% ...`），并在解析时反向取消转义。已经被转义的类标记行也会按同样方式增加和减少一个 `%`。这样可以防止单元格内部的字面标记文本在往返编辑过程中被误解析为新单元格。

## 标记解析与单元格保留

- 非空表示必须以标记开头；第一个标记之前的文本（包括空行）会被拒绝。空文本会被序列化为一个没有单元格的 notebook。
- 标记必须匹配 `# %% [code|markdown|raw]`，并可附带可选的 `cell:N`。
- 如果 `cell:N` 指向一个未使用的已存在单元格，则会克隆该单元格，更新其 `cell_type` 和 `source`，并保留其他无关字段。
- 已存在 code 单元格的 `execution_count` 和 `outputs` 会被保留而非清空；缺失字段会被初始化为 `null` 和 `[]`。
- Markdown/raw 单元格会移除 `execution_count` 和 `outputs`。
- 如果没有有效的未使用原始索引，则会创建一个带有空元数据的新单元格。
- Notebook 级别的元数据、格式字段以及无关的顶层字段得以保留，因为序列化会克隆原文档，仅替换其中的 `cells`。

## 错误面

以下情况会抛出硬错误：

- 读取时 notebook 缺失
- JSON 无效
- 缺失或非数组的 `cells`
- 无效的单元格对象或单元格类型
- 无效的可编辑表示（例如第一个单元格标记之前存在文本）

这些错误会通过具备 notebook 感知能力的调用方（如 `read` 和编辑管道）以普通工具错误的形式呈现。独立的 `write` 路径不会解析 notebook JSON。

## 3) 内核会话语义（实际存在的位置）

内核语义在 `executePython` / `PythonKernel` 中实现，作用于 `eval` 工具的 Python 后端。

## 模式

`PythonKernelMode`：

- `session`（默认）
  - 内核按 `(session id, cwd, interpreter)` 进行缓存
  - 同一键的多个所有者可以共享一个被保留的内核
  - 执行由工具的排他并发和后端执行路径串行化
  - 失效的内核会在执行前被替换
- `per-call`
  - 为该请求创建一个子进程
  - 执行代码
  - 始终在 `finally` 中关闭子进程

## 重置行为

每次 eval 调用都有一个可选的 `reset` 标志。`reset: true` 会在该调用执行前重置所选的 Python 会话，但不会重置其他已启用的语言运行时。

## 内核死亡 / 重启 / 重试

在 session 模式下：

- 如果被保留的子进程在执行前不再存活，会被替换
- 如果执行因为子进程消亡而失败，内核会被替换并重试一次代码
- 同一会话键的并发重置会进行合并：已经进行的重置会被等待，而不是再启动一次；排在该重置之后的任务会在新启动的内核上继续执行

## 4) 环境/会话变量注入

内核启动和每次执行时的环境补丁可以接收：

- `PI_SESSION_FILE`
- `PI_ARTIFACTS_DIR`
- `PI_TOOL_BRIDGE_URL`
- `PI_TOOL_BRIDGE_TOKEN`
- `PI_TOOL_BRIDGE_SESSION`
- `PI_EVAL_LOCAL_ROOTS`

运行时会初始化进程状态，使代码在所请求的 cwd 中执行，受管环境项会反映在 `os.environ` 中，cwd 在 `sys.path` 上可用。

## 5) 流式分块与展示处理（基于内核的路径）

Python 后端使用 NDJSON 子进程运行器。宿主按每次执行处理帧：

- `stdout` / `stderr` -> 文本分块传入 `onChunk`
- `display` / `result` -> MIME 集合渲染
- `error` -> traceback 文本以及结构化错误元数据
- `done` -> 最终状态、执行计数、取消状态

展示文本的 MIME 优先级：

1. `text/markdown`
2. `text/plain`
3. 转换后的 `text/html`

被单独捕获的结构化输出包括：

- `application/json` -> JSON 展示输出
- `image/png` / `image/jpeg` -> 图像输出
- `application/x-omp-status` -> 状态事件

取消/超时：

- 中止/超时会向运行器发送 `SIGINT`
- 如果运行器在中断宽限窗口内仍未结束，关闭流程会升级，并在下次调用时重建内核
- 超时输出会附带一条超时提示

## 6) 截断与工件行为

`src/session/streaming-output.ts` 中的 `OutputSink` 被内核执行路径使用：

- 对每个分块进行清理
- 跟踪总的和输出的行数与字节数
- 可以选择将完整输出溢出到工件文件
- 当输出超过配置阈值时，保留一个 UTF-8 安全的内存尾部缓冲

`eval` 会将这些元数据转换为结果截断提示和 TUI 警告。

Notebook 文件转换 **不** 使用 `OutputSink`；因为它不执行代码，所以没有流式/工件截断管道。

## 7) 渲染器假设与格式化

## Notebook 的读/编辑表示

Notebook 文件以文本形式渲染给模型。可见单元格标记是可编辑表示的一部分，而不是在序列化时被忽略的注释。

## Python 渲染器（用于实际执行输出）

基于内核的执行渲染器期望：

- 每个单元格的状态转换（`pending` / `running` / `complete` / `error`）
- 可选的结构化状态事件
- 可选的 JSON 输出树
- 图像输出
- 截断警告 + 可选的 `artifact://<id>` 指针

此渲染器行为与 notebook JSON 编辑无关，只是两者复用了同一套 TUI 原语。

## 8) 实际工作流

如果某个工作流既需要 notebook 修改又需要执行：

1. 以默认的可编辑视图读取 `.ipynb` 文件，并通过编辑管道修改该视图
2. 将某个目标单元格的源码复制到一个 `language: "py"` 的 `eval` 调用中
3. 对后续单元格重复此步骤；session 模式下的 Python 状态在调用之间保持
4. 后续源码改动通过编辑管道进行；整文件 `write` 必须包含 notebook JSON

当前实现没有提供同时修改 `.ipynb` 并通过内核上下文执行 notebook 单元格的单一工具。
