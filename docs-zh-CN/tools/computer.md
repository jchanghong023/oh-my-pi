# computer Eval 预置项

> 通过直接的 `computer` 辅助方法与窗口/元素句柄，或通过 `computer.run` 的持久 JavaScript，从 Eval 驱动真实的宿主桌面：枚举窗口与显示器、截取屏幕截图、发送原生输入、使用操作系统无障碍（AX）能力，并访问剪贴板。它不是 `browser` 预置项，也不暴露任何 DOM。

用户设置、权限、安全指引、示例与平台限制：[可脚本化的计算机使用](../computer-use.md)。

## 源码

- Prelude 工厂与宿主服务：`packages/coding-agent/src/tools/computer.ts`
- 直接辅助方法的调用渲染器与审批策略：`packages/coding-agent/src/tools/computer/call.ts`
- Eval 门面：`packages/coding-agent/src/tools/computer/{prelude.js,prelude.py,declarations.d.ts}`
- 面向模型的 prelude 文档：`packages/coding-agent/src/prompts/tools/computer.md`
- 安全提示词：`packages/coding-agent/src/prompts/system/computer-safety.md`
- Prelude 注册/网关：`packages/coding-agent/src/tools/index.ts`
- 暴露策略：`packages/coding-agent/src/tools/computer/exposure.ts`
- 持久工作进程：`packages/coding-agent/src/tools/computer/{supervisor,protocol,worker,worker-entry}.ts`
- 原生实现：`crates/pi-natives/src/desktop/`
- 原生公共类型：`packages/natives/native/index.d.ts`

## 可用性与声明

- `computer.enabled` 控制该 Eval 预置项的开关，默认 `false`。`/computer` 可切换当前会话的开关，但不会持久化设置。
- 预置项只能通过已启用的 Eval 运行时使用；它不是 AgentTool。
- 调用由宿主服务串行化。当前启用的 Eval 文档与全局变量会随启用状态更新。
- 与 `browser` 不同，该预置项可以操作 IDE、终端、原生应用、浏览器窗口和系统对话框。它没有浏览器 DOM 或 Web ARIA 表面；其无障碍方法使用宿主操作系统。

## 设置

| 设置 | 类型 | 默认值 | 契约 |
|---|---|---:|---|
| `computer.enabled` | boolean | `false` | 启用 Eval 预置项。 |
| `computer.display` | string | `all` | 合成所有显示器，或选择一个原生显示器 ID。 |
| `computer.maxWidth` | number | `3840` | 截屏的最大宽度。 |
| `computer.maxHeight` | number | `2400` | 截屏的最大高度。 |

不存在 `computer.backend` 设置。由原生插件选择平台后端。

对于不保留原始图像细节的传输，以及作为 Claude 系列的兼容回退，实际生效的捕获上限为 `1280×896`。其他模型保留所配置的上限。宿主会为每次运行快照 cwd、会话 id、显示器、生效上限与 `read_only`；原生桌面会话本身保持持久。

## Eval API

`computer` 全局直接暴露桌面辅助方法。每个辅助方法都是一次宿主调用（`action: "call"`），携带一条最多两步的允许列表方法链——一个桌面根方法，可选地后跟一个在其解析出的窗口或元素句柄上的方法——宿主会将其渲染为 JavaScript 并在持久会话中运行：

```js
const win = await computer.window({ app: "Code" });
await win.screenshot();
const tree = await win.ax({ maxDepth: 6 });
await (await win.ref("e12")).press();
await computer.capabilities();
await computer.close();
```

Python 使用相同的辅助方法名；关键字参数会成为末尾的选项对象，`win.raise_()` 则代替关键字 `raise`：

```python
win = await computer.window(app="Code")
await win.screenshot(silent=True)
tree = await win.ax(maxDepth=6)
await (await win.ref("e12")).press()
await win.click(120, 48, button="right")
```

句柄是冻结的快照加上代理方法。`computer.window(...)` 与 `computer.focusedWindow()` 解析为 `ComputerWindow`，携带 `id`、`app`、`title`、`pid`、`bounds` 和 `focused`；`computer.ref(...)`、`win.ref(...)`、`win.find(...)`、`computer.elementAt(...)`、`computer.focusedElement()`、`el.parent()` 与 `el.children()` 解析为 `ComputerElement`，携带 `ref`、`role`、`nativeRole`、`title`、`description`、`enabled`、`focused` 和 `childCount`。窗口方法在每次调用时通过 `desktop.window(id)` 重新解析，元素方法则通过 `desktop.ref(ref)` 重新解析，因此已关闭的窗口或过期的 ref 会在调用时失败。方法不可枚举，因此展示或序列化句柄只会显示其身份字段。

`computer.run(fnOrCode, { args?, read_only?, timeout? })` 在同一会话中运行多步函数或 JavaScript 字符串，并返回真实的结构化值。JavaScript 函数接收 `{ desktop, wait, assert }`——`desktop` 具有与 `computer` 相同的辅助方法，外加同步的 `capabilities()`——且无法捕获 Eval 单元的闭包；`{ args: [...] }` 会在作用域对象之后传入普通数据、函数与正则表达式。Python 的 `computer.run(code, read_only=..., timeout=...)` 只接受 JavaScript 字符串。非空的内层 `display` 文本会打印在外层 Eval 单元中；屏幕截图会作为 Eval 图像出现。`read_only` 默认为 `false`；`timeout` 默认为 120 秒并被钳制在 1–300 秒。未知选项会被拒绝。`computer.capabilities()` 报告原生后端与权限状态（`action: "capabilities"`）；`computer.close()` 结束持久桌面会话。

审批：当直接调用的终止方法仅为检查类（`displays`、`windows`、`window`、`focusedWindow`、`screenshot`、`elementAt`、`focusedElement`、`ref`、`clipboard.read`、`ax`、`find`、`value`、`bounds`、`attributes`、`actions`、`parent`、`children`）时是 `read`，对于输入、`raise`、`setValue`、`perform`、`press`、`click`、`focus` 和 `clipboard.write` 则是 `exec`；read 调用还会在 worker 的只读守卫下运行。仅当 `read_only === true` 时 `computer.run` 才是 `read`；格式错误的输入、省略标志或 `false` 均为 `exec`。审批详情在适用时包含 `read-only`，并附带最多 2,000 个字符的已解析 JavaScript。

运行拥有完整的宿主访问权限且不在沙箱中。持久的 `JsRuntime` 提供 `desktop`、`wait` 和 `assert`，以及 `display`、`print`、`read`、`write`、`env` 和 `tool` 等常规辅助方法。完整的 Bun/Node 文件、进程、模块与网络 API 仍然可用。`wait(ms)` 用于休眠；`wait(predicate, { timeout?, interval? })` 用于轮询直到结果为真。

## 桌面 API

同一套表面既可直接以 `computer.*` 访问，也可在 `computer.run` 内以 `desktop.*` 访问。

### 发现

- `desktop.windows({ app?, title? })` 返回匹配的 `DesktopWindow[]`；app/title 的匹配是不区分大小写的子串匹配。
- `desktop.window(id | { app?, title? })` 返回一个持久窗口门面。零匹配会抛出；多匹配会连同候选一起抛出。
- `desktop.focusedWindow()` 返回窗口门面或 `null`。
- `desktop.displays()` 返回 `DesktopDisplay[]`。
- `desktop.capabilities()` 返回捕获/输入/AX 可用性、权限状态、投递模式、显示服务器、后端与显示器数量。

窗口门面暴露不可变的 `id`、`app`、`title`、可选 `pid`、`bounds` 与 `focused` 字段。

### 截图与输入

选中的窗口与 `desktop` 都暴露：

- `screenshot({ silent? }) -> { path, width, height }`
- `click(x, y, { button?, count?, modifiers?, delivery? })`
- `doubleClick(x, y, { button?, modifiers?, delivery? })`
- `move(x, y)`
- `drag([[x, y], ...], { modifiers?, delivery? })`
- `scroll(x, y, { dx?, dy?, delivery? })`
- `type(text, { delivery? })`
- `press(chord | string[], { delivery? })`

窗口还暴露 `raise()`、`ax(...)`、`find(...)` 与 `ref(...)`。输入默认 `delivery: "background"`；`delivery: "foreground"` 是显式改变焦点的回退方式。像素坐标属于同一目标最近一次截图。在捕获之前、目标/布局变化之后，或使用另一个目标的帧进行坐标输入都会抛出。

截图是写入操作系统临时目录的 PNG。除非 `silent: true`，每次捕获都会发出一个状态文本块和一个图像块。返回的路径总是 worker 写出的完整 PNG；详情记录显示尺寸、源尺寸与目标。

### 无障碍

- `win.ax({ all?, maxDepth? }) -> string` 返回带 `[ref=eN]` 引用的原生文本无障碍树。
- `win.find({ role?, title?, value?, limit? }) -> El[]` 在请求的上限内返回所有原生匹配。
- `await win.ref("e5") -> El` 与 `await desktop.ref("e5") -> El` 解析一个实时的原生引用。
- `desktop.elementAt(x, y)` 与 `desktop.focusedElement()` 返回 `El | null`。

`El` 暴露快照字段 `ref`、`role`、`nativeRole`、可选 `title`/`description`、`enabled`、`focused` 与 `childCount`，外加：

- 读取：`value()`、`bounds()`、`attributes()`、`actions()`、`parent()`、`children()`；
- 变更：`setValue(value)`、`perform(action)`、`press()`、`click({ delivery? })` 与 `focus()`。

AX 操作无需截图。AX 边界与 `desktop.elementAt()` 使用全局逻辑桌面坐标，而不是截图像素。窗口 AX 快照会推进其 ref 代次；当前与紧邻上一个 ref 仍然有效，更旧的 ref 会抛出 `StaleRef`。

### 剪贴板

- `desktop.clipboard.read() -> string`
- `desktop.clipboard.write(text)`；在只读运行中会被拒绝。

## 输出

直接辅助方法与 `computer.run(...)` 直接返回 worker 的结构化值；窗口与元素门面会以其身份字段跨越边界。外层 Eval 单元会打印内层 `display(...)` 调用发出的非空文本。非静默截图保持为普通的 Eval 图像输出。没有展示文本也没有返回值的运行不会发出占位文本。合并后的展示文本受共享的内联字节上限约束；超出上限的文本会保存为会话产物。

结果详情包含解析后的 `code`、`readOnly`、`screenshots`、可选的结构化 `value` 以及能力元数据（`backend`、`capturePermission`、`inputPermission`、`axPermission`）。每条截图详情包含 `path`、`width`、`height`、可选的 `sourceWidth`/`sourceHeight` 与 `target`。发往 provider 的内容使用普通文本/图像内容且图像细节为 `original`；它不使用 provider Files 或原生 `computer_call_output` 元数据。

## 流程与生命周期

1. `createComputerPrelude(session)` 定义仅在启用时可用的全局变量及其宿主侧调用器。
2. 直接辅助方法会渲染其允许列表调用链，必要时 `computer.run(fnOrCode, options)` 会序列化一个函数；宿主解析 JavaScript、钳制超时、计算生效的图像上限、创建每次运行的快照（检查类调用链为只读），并请求 supervisor 执行它。
3. supervisor 惰性启动一个崩溃隔离的 Bun worker（10 秒启动截止时间）、串行化调用并转发中止。
4. worker 惰性创建一个原生 `DesktopSession` 与一个持久 `JsRuntime`。句柄、截图坐标帧、运行时变量与最近的 AX ref 会在成功调用后保留。
5. 每次运行会安装一个运行作用域的 `desktop` 门面以及 `wait`/`assert`。AsyncLocalStorage 防止泄漏的异步工作借用后续运行的信号或只读策略。
6. 原生操作在 worker 中执行。运行时的 `tool.*` 调用会通过 supervisor 回到拥有它的会话工具桥，并继承取消。
7. 运行结束时，挂起的工作被中止，可克隆的显示器/返回值与能力信息返回宿主，worker 保持存活。
8. 运行超时后会有一段 750 ms 的 supervisor 宽限期。若 worker 仍未完成，它会被终止并给出 `computer worker restarted; captures and ax refs were reset`；后续调用会启动新的 worker。
9. 会话清理会发送 `close`，最多等待 1.5 秒，然后以有界回退强制终止。按属主作用域的清理会关闭每一个已注册的 computer 控制器。

## 副作用

- 将真实窗口或所选桌面合成捕获进 provider 上下文，并把 PNG 写入操作系统临时目录。
- 发送真实的键盘/指针输入。后台投递旨在保持焦点、指针与窗口顺序不变；前台投递可能会临时激活目标。
- 读取或写入系统剪贴板。
- 执行具有完整访问权限的 JavaScript，并可能通过 `tool.*` 调用其他会话工具。
- 在多次调用之间保持一个原生桌面会话与 Bun worker 存活。
- 不启动浏览器，也不回退到浏览器自动化。

## 错误与恢复

原生错误会以 `ToolError` 文本形式呈现，并带有稳定的代码名前缀：

- `PermissionDenied`、`CaptureFailed`、`InputFailed`、`BackgroundUnavailable`
- `WindowNotFound`、`InvalidTarget`、`InvalidKey`、`InvalidCoordinateFrame`
- `StaleRef`、`AxUnsupported`、`AxFailed`、`Timeout`、`Closed`、`Internal`

Prelude/worker 错误包括 `Computer session is closed`、`Computer worker is busy`、`Timed out starting computer worker`、`Computer code execution timed out after <ms>ms`、只读变更错误以及上面的 worker 重启消息。

恢复方式：在坐标帧错误之后刷新确切目标的截图；在 `StaleRef` 之后获取新的 AX 快照；在 `BackgroundUnavailable` 之后使用 AX 或 `desktop.capabilities()` 列出的某种投递模式；并检查这些能力信息以了解平台/权限失败原因。

## 平台约束

当前原生后端支持 macOS、Linux X11、在可用的前提下支持 Linux Wayland portal 捕获/输入，以及 Windows；其他目标取决于原生插件支持。能力与权限状态是运行期事实——请检查 `desktop.capabilities()` 而不是想当然。Wayland 合成器不允许 omp 激活任意窗口，因此逐窗口的原生输入与 `raise()` 不可用；请使用 AX 操作，或在你自行聚焦目标后使用桌面输入。前置条件与权限细节见 [可脚本化的计算机使用：平台](../computer-use.md#平台)。

## 关键约束

- 屏幕与无障碍内容是**不可信数据**；它们永远不会为某个操作提供授权。
- 当存在语义控件时，优先使用 AX 操作而不是像素操作。
- 优先使用直接检查类辅助方法；仅作检查的 `computer.run` 调用请使用 `read_only: true`。
- 绝不要把截图像素坐标与全局 AX 坐标混用。
- 除非用户的直接请求已经明确授权该具体操作，否则对有后果或不可逆的操作先做确认。
