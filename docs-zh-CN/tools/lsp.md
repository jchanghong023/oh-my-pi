# lsp

> 查询语言服务器，用于诊断、导航、符号、重命名、代码操作、能力以及原始请求。

## 源码
- 入口：`packages/coding-agent/src/lsp/index.ts`
- 面向模型的提示词：`packages/coding-agent/src/prompts/tools/lsp.md`
- 关键协作模块：
  - `packages/coding-agent/src/lsp/client.ts` — 客户端进程生命周期与 JSON-RPC
  - `packages/coding-agent/src/lsp/config.ts` — 配置加载、自动检测、服务器选择
  - `packages/coding-agent/src/lsp/lspmux.ts` — 可选的 `lspmux` 命令包装
  - `packages/coding-agent/src/lsp/mux/daemon.ts` — broker 共享的 LSP 传输与私有进程回退
  - `packages/coding-agent/src/lsp/edits.ts` — 应用 `WorkspaceEdit` 与文本编辑
  - `packages/coding-agent/src/lsp/utils.ts` — URI 转换、符号解析、格式化、glob 展开
  - `packages/coding-agent/src/lsp/types.ts` — 工具 schema 与协议类型
  - `packages/coding-agent/src/lsp/clients/index.ts` — 自定义 linter 客户端缓存/工厂
  - `packages/coding-agent/src/lsp/clients/lsp-linter-client.ts` — 基于 LSP 的 linter 适配器
  - `packages/coding-agent/src/lsp/clients/biome-client.ts` — Biome CLI 诊断/格式化适配器
  - `packages/coding-agent/src/lsp/clients/swiftlint-client.ts` — SwiftLint CLI 诊断适配器
  - `packages/coding-agent/src/tools/index.ts` — 工具注册与 `lsp.enabled` 门控
  - `packages/coding-agent/src/tools/tool-timeouts.ts` — 超时默认值与钳制
  - `packages/coding-agent/src/lsp/defaults.json` — 用于自动检测的内置服务器定义

## 输入

| 字段 | 类型 | 是否必填 | 说明 |
| --- | --- | --- | --- |
| `action` | string enum | 是 | `diagnostics`、`definition`、`references`、`hover`、`symbols`、`rename`、`rename_file`、`code_actions`、`type_definition`、`implementation`、`status`、`reload`、`capabilities`、`request` 之一。 |
| `file` | string | 否 | 文件路径；对 `diagnostics` 也可以是 glob；工作区形式使用 `"*"`；对 `rename_file` 则是源路径。 |
| `line` | number | 否 | 基于位置的操作所使用的 1 起始行号。在单文件操作路径上默认为 `1`。 |
| `symbol` | string | 否 | 用于解析 `line` 上列位置的子串。支持 `name#N` 出现位置选择器；`N` 从 1 开始计数，默认 `1`。在面向具备项目感知的服务器执行 `definition`/`references`/`rename` 时，若给出 `line` 则此项必填。 |
| `query` | string | 否 | 工作区符号查询、代码操作的选择器/过滤器，或 `action=request` 时的 LSP 方法名。 |
| `new_name` | string | 否 | `rename` 与 `rename_file` 必填。 |
| `apply` | boolean | 否 | 对 `rename`/`rename_file`，除非显式为 `false`，否则执行应用。对 `code_actions`，除非显式为 `true`，否则列出清单。 |
| `timeout` | number | 否 | 秒，默认 `20`；`clampTimeout("lsp", ...)` 先应用正的 `tools.maxTimeout` 上限，再应用该工具的 `5..300` 范围（因此 5 秒下限仍会压过更低的全局限额）。 |
| `payload` | string | 否 | 用于 `action=request` 的 JSON 字符串；覆盖自动构建的参数。 |

## 输出
- 单次发送的 `AgentToolResult`；`content` 始终是一个文本块：`[{ type: "text", text: string }]`。
- `details` 为 `LspToolDetails`：`action`、`success`、可选的 `serverName`、可选的原始 `request`。
- 诸如 `No definition found` 这样的空导航/符号查询结果还会额外标记 `useless: true`，以便压缩时可以将其省略；干净的诊断结果会保留为验证证据。
- 没有流式更新、artifact URI 或后台任务。内联 TUI 渲染器会合并调用与结果，添加感知 action 的格式化，并支持折叠/展开视图。
- 该工具是可发现的，而非被预先加载。只读操作（`diagnostics`、导航、hover、symbols、`status`、`capabilities`）请求读审批；`rename`、`rename_file`、`code_actions`、`reload` 和 `request` 无论 `apply` 取值如何都请求写审批。
- 许多校验失败会作为普通文本结果返回，并带有 `details.success: false`；中止则改为抛出 `ToolAbortError`。

## 流程
1. `packages/coding-agent/src/tools/index.ts` 注册 `lsp: LspTool.createIf`。只有当 `session.enableLsp !== false` 与 `lsp.enabled`（默认 `true`）同时允许时，该工具才会存在。带 `lspReadOnly` 的会话会拒绝 `LSP_READONLY_ACTIONS` 之外的每一个 action；受限会话默认将两者设为禁用 LSP，且若显式重新启用则为只读。
2. `packages/coding-agent/src/lsp/index.ts` 中的 `LspTool.execute()` 用 `clampTimeout("lsp", ...)` 钳制 `timeout`（包括可选的全局限额 `tools.maxTimeout`），构建 `AbortSignal.timeout(...)`，并将其与调用方的信号合并。
3. `getConfig()` 按 cwd 加载并缓存 `LspConfig`，并在后续调用中复用该缓存配置。工作区 `reload` 是显式的例外：它先清除并重建该 cwd 的配置缓存，然后重新加载新选中的服务器。
4. `packages/coding-agent/src/lsp/config.ts` 中的配置加载会把 `defaults.json` 与来自项目、项目配置目录、用户配置目录、插件根目录/市场元数据以及 home 的 JSON/YAML 覆盖合并；若没有任何覆盖，则从根标记加上可执行文件发现来自动检测服务器。文件名、优先级与服务器字段见 [LSP 配置](../lsp-config.md)。
5. 服务器路由使用 `config.ts` 中的 `getServersForFile()` / `getServerForFile()`：先按扩展名或 basename 匹配，再排序使 primary 服务器位于 linter 之前。`index.ts` 还会用 `getLspServersForFile()` / `getLspServerForFile()` 把自定义 linter 客户端从导航/重构路径中过滤掉。
6. `getOrCreateClient()` 按 `command:cwd` 缓存一个客户端。启用 `lsp.shared`（SDK 会话中默认 `true`）时，它先向 broker 管理的项目 mux 请求共享传输；失败则回退到私有的 `ptree.spawn()`。外部 `lspmux` 包装优先于 broker 共享。随后客户端启动其消息读取器、发送 `initialize`、存储能力，并发送 `initialized`。
7. `client.ts` 中的消息读取器解析 LSP 帧、完成待处理请求、缓存 `publishDiagnostics`、跟踪 `$/progress` token 以判断项目加载是否完成、应答 `workspace/configuration`，并通过 `applyWorkspaceEdit()` 应用 `workspace/applyEdit` 请求。
8. 文件范围的操作会在请求前调用 `ensureFileOpen()`。列解析使用 `utils.ts` 中的 `resolveSymbolColumn()`：读取目标文件，省略 `symbol` 时取第一个非空白字符，否则在目标行上查找精确匹配或大小写不敏感匹配，并遵循 `#N` 出现位置选择器。
9. action 在 `LspTool.execute()` 中通过专门的分支分派：仅工作区分支（`status`、部分 `diagnostics`、工作区 `symbols`、工作区 `reload`、`capabilities`、`request`）先于单文件 switch 运行；其余所有单文件 action 共享一次客户端查找与 `switch(action)`。
10. 请求经由 `client.ts` 中的 `sendRequest()` 发出：它分配递增的 JSON-RPC id、安装中止与超时处理、在中止时发送 `$/cancelRequest`，并在超时或进程退出时拒绝。
11. 返回编辑的 action 要么用 `formatWorkspaceEdit()` 预览，要么用 `edits.ts` 中的 `applyWorkspaceEdit()` 应用；`rename_file` 还会执行文件系统重命名，然后发送 `workspace/didRenameFiles`。
12. 单文件 action 块内的非中止失败会被转换为 `LSP error: ...`；许多前置条件失败会直接返回显式文本而不抛出。

## 模式 / 变体
### 路由与工作区范围
- `file: "*"` 仅对 `diagnostics`、`symbols` 和 `reload` 具有特殊含义。
- `status` 忽略 `file`。
- 省略 `file` 或使用 `"*"` 的 `capabilities` 会检查所有非自定义 LSP 服务器；给出具体文件时则限定到与之匹配的非自定义服务器。
- 省略 `file` 或使用 `"*"` 的 `request` 会选择第一个可用的非自定义 LSP 服务器；给出具体文件时则选择该文件的 primary 非 linter 服务器。
- `rename_file` 会把 `workspace/willRenameFiles` 与 `workspace/didRenameFiles` 发送给 `getLspServers(config)` 中所有 `fileTypes` 与源路径、目标路径或任一被枚举出的重命名对相匹配的非自定义 LSP 服务器——而不只是一个文件范围的服务器。
- 诊断是唯一既查询普通 LSP 服务器又查询自定义 linter 客户端（`BiomeClient`、`SwiftLintClient` 或 `LspLinterClient`）的工具 action。

### `diagnostics`
**输入**
- 必填：`file`，除非使用带 `file: "*"` 的工作区模式。
- 可选：`timeout`。

**执行**
- `file: "*"`：`runWorkspaceDiagnostics()` 按 Rust → TypeScript → Go 工作区/模块 → Python 的顺序选择第一个匹配的项目类型。它运行 Rust 的 `cargo check --message-format=short`、TypeScript 的 `npx tsc --noEmit`、Python 的 `pyright` 或 Go 的 `go build`：`go.mod` 使用 `./...`，而 `go.work` 会先读取 `go work edit -json`，再构建每一个 `Use[].DiskPath/...` 模式（回退到 `./...`）。未知项目会返回一条受支持标记的提示信息，而不会启动检查器。
- 具体文件或 glob：`resolveDiagnosticTargets()` 把非 glob 视作单个目标，否则将 `Bun.Glob` 展开到 `MAX_GLOB_DIAGNOSTIC_TARGETS` 为止。
- 对每个文件，所有匹配的服务器都会运行：自定义客户端调用 `lint(file)`；真正的 LSP 服务器可选地等待项目加载，捕获 `diagnosticsVersion`，执行 `refreshFile()`，然后 `waitForDiagnostics()` 以获取新的 `publishDiagnostics`（以最新一次发布为准；版本完全匹配则立即接受）。
- 结果按 range+message 去重，并按严重程度排序。

**输出文本**
- 单目标且无问题：`OK`。
- 单目标且有问题：`<summary>:\n<grouped diagnostics>`。
- 批量/glob 目标：每个文件一节，且当 glob 超出文件上限时先给出一条截断警告。
- 工作区模式：`Workspace diagnostics (<detected description>):\n<command output>`。

### `definition`
**输入**
- 必填：`file`。
- 可选：`line`、`symbol`、`timeout`。

**执行**
- 发送带 `{ textDocument, position }` 的 `textDocument/definition`。
- 接受 `Location`、`Location[]`、`LocationLink` 或 `LocationLink[]`；`normalizeLocationResult()` 会把 `LocationLink` 转换为 `targetSelectionRange ?? targetRange`。
- 在具备项目感知的服务器上，若给出 `line` 则必须有 `symbol`（该 action 禁用了「首个非空白列」的回退）。
- 在请求前等待项目加载。

**输出文本**
- `No definition found`，或 `Found N definition(s):` 后跟 `file:line:col`，以及每个位置上方/下方各一行上下文。

### `type_definition`
使用与 `definition` 相同的位置规范化与输出形态，但发送 `textDocument/typeDefinition` 并报告 `type definition(s)`。与 `definition` 不同，给出 `line` 时实现并不要求显式的 `symbol`；缺少它时会解析首个非空白列。

### `implementation`
使用与 `definition` 相同的位置规范化与输出形态，但发送 `textDocument/implementation` 并报告 `implementation(s)`。与 `definition` 不同，给出 `line` 时实现并不要求显式的 `symbol`；缺少它时会解析首个非空白列。

### `references`
**输入**
- 必填：`file`。
- 可选：`line`、`symbol`、`timeout`。

**执行**
- 发送带 `includeDeclaration: true` 的 `textDocument/references`。
- 在具备项目感知的服务器上，若给出 `line` 则必须有 `symbol`（该 action 禁用了「首个非空白列」的回退）。
- 对具备项目感知的服务器，当唯一的命中就是被查询的声明时，最多重试 `REFERENCES_RETRY_COUNT` 次；重试之间会等待项目加载并休眠 `REFERENCES_RETRY_DELAY_MS`。
- 前 `REFERENCE_CONTEXT_LIMIT` 条引用会带上上下文；其余仅给出位置。

**输出文本**
- `No references found`，或 `Found N reference(s):`，先列出带上下文的条目，被截断时再给出 `... M additional reference(s) shown without context`。

### `hover`
**输入**
- 必填：`file`。
- 可选：`line`、`symbol`、`timeout`。

**执行**
- 发送 `textDocument/hover`。
- `extractHoverText()` 会把字符串、标记内容、marked-string 对象或数组展平为纯文本。

**输出文本**
- `No hover information`，或提取出的 hover 文本。

### `symbols`
**输入**
- 工作区模式：必填 `file: "*"`，以及必填 `query`。当前省略 `file` 会在工作区符号分派之前返回 `Error: file parameter required...`。
- 文档模式：必填 `file`。
- 可选：`timeout`。

**执行**
- 工作区模式向每个非自定义 LSP 服务器发送 `workspace/symbol`，用 `filterWorkspaceSymbols()` 后置过滤匹配项，用 `dedupeWorkspaceSymbols()` 去重，然后截断到 `WORKSPACE_SYMBOL_LIMIT`。
- 文档模式向 primary 服务器发送 `textDocument/documentSymbol`。若第一项带有 `selectionRange`，则格式化分层的 `DocumentSymbol`；否则格式化扁平的 `SymbolInformation`。

**输出文本**
- 工作区模式：`Found N symbol(s) matching "query":` 加上格式化后的 `name @ file:line:col`，超出上限时附带一行省略说明。
- 文档模式：`Symbols in <file>:` 加上分层或扁平的符号行。

### `rename`
**输入**
- 必填：`file`、`new_name`。
- 可选：`line`、`symbol`、`apply`、`timeout`。

**执行**
- 在具备项目感知的服务器上，若给出 `line` 则必须有 `symbol`，随后等待项目加载、发送 `textDocument/rename`、接收 `WorkspaceEdit`。
- `apply !== false` 会立即用 `applyWorkspaceEdit()` 应用编辑。
- `apply === false` 用 `formatWorkspaceEdit()` 渲染预览。

**输出文本**
- `Rename returned no edits`，或 `Applied rename:` 加上已应用的变更行，或 `Rename preview:` 加上汇总后的编辑。

### `rename_file`
**输入**
- 必填：`file` 源路径、`new_name` 目标路径。
- 可选：`apply`、`timeout`。

**执行**
- 解析源与目标的绝对路径，拒绝相同路径、源缺失、目标已存在、重命名集合为空，或目录中包含超过 `MAX_RENAME_PAIRS` 个文件的情况。
- `enumerateRenamePairs()` 对单个文件返回一个 `{oldUri,newUri}` 对，对目录树则遍历其中每个常规文件。
- 向所有 `fileTypes` 匹配受影响路径的非自定义 LSP 服务器发送带 `{ files: pairs }` 的 `workspace/willRenameFiles`；收集返回的 `WorkspaceEdit` 与服务器备注。
- 预览模式（`apply === false`）只格式化这些编辑。
- 应用模式按 URI 合并返回的文本编辑（在重叠处具备项目感知的服务器的编辑胜出；来自其他服务器的重叠编辑会被丢弃并附一条备注），对每个 URI 都基于同一份快照应用一次，创建目标父目录并在磁盘上重命名源路径，对每个已重命名的打开文件发送 `textDocument/didClose`，删除这些 `openFiles` 条目，然后发送 `workspace/didRenameFiles`。

**输出文本**
- 预览：`Rename preview: <file-count label> → <dest>` 加上各服务器的编辑汇总与可选的服务器备注。
- 应用：`Renamed <file-count label> → <dest>` 加上已应用的编辑汇总、文件系统重命名行，以及可选的服务器备注。

### `code_actions`
**输入**
- 必填：`file`。
- 可选：`line`、`symbol`、`query`、`apply`、`timeout`。

**执行**
- 从 `client.diagnostics` 读取该打开 URI 的缓存诊断，并针对解析位置上的零宽 range 发送 `textDocument/codeAction`。
- 当 `apply !== true` 时，`query` 会作为 `context.only: [query]` 传入；这是服务器侧的 kind 过滤。
- 当 `apply === true` 且 `query` 非空时，它是客户端侧的选择器：可以是零起始的数字索引，也可以是 action 标题的大小写不敏感子串。
- 当 `apply === true` 但省略 `query` 时，当前实现会落入列表模式，不应用任何 action。
- 应用 `CodeAction` 使用 `applyCodeAction()`：可选地 `codeAction/resolve`，然后 `applyWorkspaceEdit(edit)`，再可选地 `workspace/executeCommand`。
- 应用裸 `Command` 只运行 `workspace/executeCommand`。

**输出文本**
- 列表模式：`N code action(s):` 加上 `index: [kind] title` 行。
- 应用模式成功：`Applied "title":` 加上 `Workspace edit:` 和/或 `Executed command(s):` 小节。
- 应用模式未命中：`No code action matches "query". Available actions:`。
- 应用模式但无编辑/命令：`Action "title" has no workspace edit or command to apply`。

### `status`
**输入**
- 无。

**执行**
- 从缓存的 `LspConfig` 读取已配置的服务器，并与 `getActiveClients()` 交叉引用，从而把每个服务器标记为 `(configured, not started)` 或带上其实时客户端状态。
- 调用 `detectLspmux()`，并在安装了 `lspmux` 时追加状态文本。

**输出文本**
- `Language servers: <name (configured, not started) | name (<status>)>` 加上一条说明性备注行；或 `No language servers configured for this project`，其后可选地跟随 `lspmux: active (multiplexing enabled)` 或 `lspmux: installed but server not running`。

### `reload`
**输入**
- 工作区模式：`file: "*"` 或省略 `file`。
- 单文件模式：必填 `file`。
- 可选：`timeout`。

**执行**
- 工作区模式先使按 cwd 的配置缓存失效，从磁盘重新加载配置，然后重新加载每一个新配置的非自定义 LSP 服务器。
- 单文件模式保留缓存配置，并重新加载该文件的 primary 服务器。
- 两种模式都会在启动服务器前清除匹配的近期初始化失败。对 rust-analyzer 服务器，`reloadServer()` 先尝试 `rust-analyzer/reloadWorkspace` 请求（只有 rust-analyzer 实现了它；把它发给 Roslyn 等其他服务器可能导致其崩溃，因此以服务器二进制/名称为门槛）。之后每个服务器都回退到 `workspace/didChangeConfiguration` 通知，携带活动客户端已配置的设置。若该通知失败，reload 会拆除该客户端，使下一次请求冷启动它。对共享 mux 的客户端，拆除会先发送 mux restart 通知，从而替换掉共享服务器——而不只是本会话的链接。

**输出文本**
- 每个服务器一行：`Reloaded <server>`、`Restarted <server>` 或 `Failed to reload <server>: ...`。

### `capabilities`
**输入**
- 可选：`file`、`timeout`。

**执行**
- 给出具体 `file` 时，检查该文件匹配的非自定义服务器。
- 省略 `file` 或使用 `"*"` 时，检查每个已配置的非自定义服务器。
- 按需启动服务器，并把 `client.serverCapabilities ?? {}` 以格式化 JSON 转储出来。

**输出文本**
- 每个服务器：`<server>:` 后跟缩进的 `capabilities: { ... }`，或 `<server>: failed to start (...)`。

### `request`
**输入**
- 必填：`query` 方法名。
- 可选：`file`、`line`、`symbol`、`payload`、`timeout`。

**执行**
- 选择一个非自定义服务器：文件范围的 primary 服务器，否则取第一个已配置的非自定义服务器。
- 参数构建优先级：
  1. 若存在 `payload`，解析 JSON 并原样使用。
  2. 否则若 `file` 具体且给出了 `line`，用 `resolveSymbolColumn()` 构建 `{ textDocument: { uri }, position: { line: line - 1, character } }`。
  3. 否则若 `file` 具体，构建 `{ textDocument: { uri } }`。
  4. 否则使用 `{}`。
- `file` 具体时会先打开该文件。

**输出文本**
- 成功：`<server> ← <method>:\n<formatted result>`，其中非字符串结果会 `JSON.stringify(..., null, 2)`，空值变为 `null`。
- 失败：`LSP error from <server> on <method>: ...` 后跟 `  params: <preview>`，回显请求参数（截断到 400 字符）。

## 副作用
- 文件系统
  - 读取配置文件、目标文件与根标记。
  - `rename` 与 `code_actions` 可能通过 `applyWorkspaceEdit()` 编辑/创建/删除/重命名文件。
  - 在应用模式下，`rename_file` 总会重命名磁盘上的源路径。
  - 服务器发起的 `workspace/applyEdit` 请求同样会通过 `applyWorkspaceEdit()` 改动文件。
- 网络 / IPC
  - 当 `lsp.shared=true`（默认值）时，SDK 会话会尝试通过本地 Unix socket 或 Windows 命名管道连接 broker 管理的按项目 LSP mux。若 mux 无法连接或启动，客户端会静默回退到私有子进程。
  - 私有服务器与外部多路复用的服务器都通过本地 stdio JSON-RPC 通信；该工具本身不发起远程网络请求。
- 子进程 / 原生绑定
  - 私有回退用 `ptree.spawn()` 启动语言服务器；共享模式则请 broker 为每个项目维护一个服务器。
  - 工作区诊断会启动 `cargo`、`npx`、`go` 或 `pyright`。
  - `BiomeClient` 与 `SwiftLintClient` 会启动 CLI 工具。
  - 可选的外部 `lspmux` 检测会启动 `lspmux status`；受支持的服务器可以通过 `lspmux client` 包装。
- 会话状态（转录、记忆、任务、检查点、注册表）
  - 在 `configCache` 中按 cwd 缓存配置；工作区 `reload` 会使该条目失效。
  - 按 `command:cwd` 缓存 LSP 客户端，包含 `pendingRequests`、`diagnostics`、`openFiles`、`serverCapabilities` 与项目加载状态。该传输可能代表的是一条共享 mux 链接，而非自己拥有的进程。
  - 按 `serverName:cwd` 缓存自定义 linter 客户端。
  - 更新客户端的 `lastActivity`；可选的空闲超时清理由工作区 `idleTimeoutMs` 或 `setIdleTimeout()` 驱动。
- 后台工作 / 取消
  - 每个请求都有可中止的超时信号。
  - 中止进行中的 LSP 请求会发送 `$/cancelRequest`。
  - 后台消息读取器会为每个存活的客户端持续存在，直到进程退出/关闭。

## 限制与上限
- 工具超时钳制：默认 `20`、最小 `5`、最大 `300` 秒 — `packages/coding-agent/src/tools/tool-timeouts.ts` 中的 `TOOL_TIMEOUTS.lsp`。
- `sendRequest()` 内部的 LSP 请求默认超时：`30_000ms` — `packages/coding-agent/src/lsp/client.ts` 中的 `DEFAULT_REQUEST_TIMEOUT_MS`。
- 预热初始化的默认超时：`5_000ms` — `packages/coding-agent/src/lsp/client.ts` 中的 `WARMUP_TIMEOUT_MS`。
- 项目加载等待的回退值：`15_000ms` — `packages/coding-agent/src/lsp/client.ts` 中的 `PROJECT_LOAD_TIMEOUT_MS`。
- 启用时的空闲客户端清扫间隔：`60_000ms` — `packages/coding-agent/src/lsp/client.ts` 中的 `IDLE_CHECK_INTERVAL_MS`。
- 初始化失败退避：`3 * 60 * 1000ms` — `INIT_FAILURE_BACKOFF_MS`；匹配的单文件或工作区 `reload` 会清除该负缓存，使重试立即进行。
- 诊断消息输出上限：前 `50` 条消息 — `packages/coding-agent/src/lsp/index.ts` 中的 `DIAGNOSTIC_MESSAGE_LIMIT`。
- 单文件诊断等待：`3_000ms` — `SINGLE_DIAGNOSTICS_WAIT_TIMEOUT_MS`。
- 批量/glob 诊断每个文件的等待：`400ms` — `BATCH_DIAGNOSTICS_WAIT_TIMEOUT_MS`。
- glob 诊断目标上限：前 `20` 个匹配 — `MAX_GLOB_DIAGNOSTIC_TARGETS`。
- 工作区符号上限：前 `200` 个条目 — `WORKSPACE_SYMBOL_LIMIT`。
- 引用上下文上限：前 `50` 条引用包含源码上下文 — `REFERENCE_CONTEXT_LIMIT`。
- 引用重试次数：重试 `2` 次，退避 `250ms` — `REFERENCES_RETRY_COUNT`、`REFERENCES_RETRY_DELAY_MS`。
- 目录重命名上限：`1_000` 个文件对 — `MAX_RENAME_PAIRS`。
- `detectLspmux()` 状态缓存 TTL：`5 * 60 * 1000ms`；存活检查超时：`1_000ms` — `packages/coding-agent/src/lsp/lspmux.ts` 中的 `STATE_CACHE_TTL_MS`、`LIVENESS_TIMEOUT_MS`。
- 工作区诊断输出上限：来自子进程的前 `50` 行。

## 错误
- 缺失或无效的输入通常以文本返回，并带有 `details.success: false`，而不是抛出：
  - 缺少 `file`/`query`/`new_name`
  - `payload` 中的 JSON 无效
  - 没有匹配的服务器
  - 无效的 `rename_file` 源/目标条件
- `resolveSymbolColumn()` 对文件缺失、符号缺失以及越界的 `#N` 选择器抛出显式错误；它们会以 `LSP error: ...` 或请求特定的错误文本呈现。
- `sendRequest()` 在超时时以 `LSP request <method> timed out after <ms>ms` 拒绝。
- 客户端进程退出会以 `getOrCreateClient()` 中组装的退出码/stderr 错误拒绝所有待处理请求。
- 主 `try` 内的单文件 action 失败会变为 `LSP error: <message>`。
- `request` 有自己的错误外壳：`LSP error from <server> on <method>: <message>`。
- 某些服务器失败被有意弱化处理：
  - 一个服务器失败时诊断仍会继续
  - `rename_file` 会抑制 `workspace/willRenameFiles` 的 “method not found” 错误，并把其他服务器错误记录为备注
  - `code_actions` 会忽略 `codeAction/resolve` 的失败，并在可能时应用未解析的 action
- 调用方中止不会被转换为文本：`ToolAbortError` 会被重新抛出。没有调用方中止的墙钟工具超时则抛出 `ToolError`：`LSP <action> timed out after <N>s on <server>. ...`。

## 备注
- `status` 报告来自 `LspConfig` 的已配置服务器，并通过 `getActiveClients()` 给每一个打标签：`(configured, not started)` 表示该二进制能在 PATH 上解析，但尚无请求启动它；存活的客户端会报告其状态。
- `getLspServerForFile()` 排除 `createClient` 适配器与仅作 linter 的服务器；导航/重构 action 从不针对 Biome/SwiftLint 自定义客户端。
- `getServersForFile()` 既匹配文件扩展名，也匹配 `fileTypes` 中的精确 basename；配置可以瞄准诸如 `Dockerfile` 这样的名字（若存在）。
- `symbol` 匹配先精确、再大小写不敏感，最后仅回退到指定行上的第 N 次出现；它从不扫描其他行。
- 对具备项目感知的服务器上的 `definition`、`references` 与 `rename`，在传入 `line` 时省略 `symbol` 会以 `ToolError` 拒绝，而不是静默回退到首个非空白列。
- `code_actions` 以两种不同方式使用 `query`：列表模式下作为服务器侧的 `context.only` 过滤，而当 `apply: true` 与非空 `query` 同时出现时作为客户端侧的标题/索引选择器。尽管模型提示词要求提供选择器，但当 `apply: true` 省略 `query` 时，当前实现会列出 action 而不是应用某一个。
- `rename` 与 `rename_file` 默认执行应用。预览需要 `apply: false`。
- 带 `file: "*"` 的 `request` 与省略 `file` 的处理相同：它不会构建工作区专属参数。
- `reload` 在杀掉客户端后不会立即重建它；下一次请求会触发重新初始化。
- `workspace/applyEdit` 可以应用由服务器在直接工具 action 结果路径之外发起的编辑。
- `detectLspmux()` 可用 `PI_DISABLE_LSPMUX=1` 禁用；`DEFAULT_SUPPORTED_SERVERS` 中只有 `rust-analyzer`。
- 启动时的 LSP 发现（`sdk.ts` 中的 `discoverStartupLspServers(cwd)`）在 `enableLsp && options.hasUI` 时运行；后台预热还额外要求 `!settings.get("lsp.lazy")`。`lsp.lazy` 默认为 `true`，因此默认情况下被发现的服务器会以状态 `"available"` 呈现（欢迎界面中的灰点），并在首次使用时（lsp 工具调用，或对匹配文件类型的 edit/write）通过 `getOrCreateClient()` 冷启动。Print/RPC/ACP/script 会话完全跳过发现与预热。参见 `docs/sdk.md` § 启动性能。
- `configCache` 是进程级的，不会自动失效。请用工作区 `reload`（省略 `file` 或 `file: "*"`）重新读取配置、根标记与插件配置；具体文件的重载只重新加载该服务器，并保留缓存中的配置。
