# write

> 创建或覆盖文件、可写内部资源、归档条目、SQLite 行，或合并冲突解决方案。

## 源码
- 入口：`packages/coding-agent/src/tools/write.ts`
- 面向模型的提示词：`packages/coding-agent/src/prompts/tools/write.md`
- 关键协作模块：
  - `packages/utils/src/ar`（`@oh-my-pi/pi-utils/ar`）— 统一归档注册表：`parseArchivePathCandidates()` 解析归档选择器，`readArchiveEntries()`/`writeArchive()` 以原子方式重写容器。
  - `packages/coding-agent/src/tools/sqlite-reader.ts` — 检测 SQLite 路径并执行行插入/更新/删除。
  - `packages/coding-agent/src/tools/conflict-detect.ts` — 解析 `conflict://` URI，注册/校验区域，并展开 side token。
  - `packages/coding-agent/src/internal-urls/router.ts` / `packages/coding-agent/src/tools/xdev.ts` — 可写内部资源与 `xd://` 工具设备分派。
  - `packages/coding-agent/src/lsp/index.ts` — 写入时格式化与诊断透写。
  - `packages/coding-agent/src/tools/auto-generated-guard.ts` — 阻止覆盖生成的文件。
  - `packages/coding-agent/src/tools/fs-cache-invalidation.ts` — 写入后使共享 FS 扫描缓存失效。
  - `packages/coding-agent/src/tools/plan-mode-guard.ts` — 解析路径并执行计划模式写入策略。

## 输入
| 字段 | 类型 | 必填 | 描述 |
| --- | --- | --- | --- |
| `path` | `string` | 是 | 目标路径。纯路径写入文件。可写内部 URL 会委托给其处理器。`xd://<device>` 使用 `content` 中的 JSON 分派一个已挂载的工具。`archive.ext:inner/path` 为 `.zip` 及 ZIP 格式别名（`.jar`、`.war`、`.ear`、`.apk`、…）、`.tar`、`.tar.gz`/`.tgz`、`.tar.zst`/`.tzst` 或 `.asar` 写入一个归档条目。`db.sqlite:table` 插入一行；`db.sqlite:table:key` 更新/删除一行。`conflict://<id>` 解决一个已注册的冲突，`conflict://*` 执行批量解决。被复制的 `[path#TAG]` 包装会被接受并移除。 |
| `content` | `string` | 是 | 完整替换的文件/归档/内部资源内容、冲突替换内容，或 SQLite 行负载。SQLite 的非删除写入必须能解析为 JSON5 对象；为空或仅含空白字符的内容会删除带键的行。对于 `xd://`，这是已挂载工具的 JSON 参数对象。 |

完整示例：

```text
path: "src/generated/config.json"
content: "{\n  \"enabled\": true\n}\n"
```

```text
path: "fixtures/archive.zip:templates/email.txt"
content: "hello\n"
```

```text
path: "data/app.sqlite:users:42"
content: "{name: 'Ada', active: true}"
```

## 输出
单次调用结果。

- 成功时始终返回至少一个文本块，但 `xd://` 分派会保留已挂载工具自身的内容/错误结果。
  - 普通文件写入：`Successfully wrote <chars> bytes to <relative-path>`（计数为 `cleanContent.length`，而非编码后的字节长度）。
  - 内部 URL 写入：`Successfully wrote <chars> bytes to <url>`。
  - 归档写入：`Successfully wrote <chars> bytes to <relative-archive-path>:<entry-path>`。
  - SQLite 写入：`Inserted row into <table>`、`Updated row '<key>' in <table>`、`No row updated ...`、`Deleted row ...`、`No row deleted ...` 之一。
  - 冲突解决：冲突专用的成功文本，在适用时附带新的 hashline 快照头。批量解决可能在某些文件成功、其他文件失败后返回 `isError: true`。
- 执行期间，`onUpdate` 可能发出 `Writing <chars> bytes to <path>...`；`xd://` 转发已挂载工具的更新。
- 如果 hashline 前缀是从 `read` 输出中复制并先行剥离的，第一个文本块会得到一条额外说明。
- 在 hashline 显示模式下，普通文件写入（包括 ACP 桥写入）和冲突解决会前置一个新的 `[<relative-path>#TAG]` 头，使下一次 `edit` 无需额外 `read` 即可拥有当前快照标签。批量冲突解决会追加一个 `Snapshots:` 块，为每个成功写入的文件列出一个头。
- 当 LSP 的写入时诊断（diagnostics-on-write）被启用时，普通文件写入还可能返回 `details.diagnostics` 以及 `details.meta.diagnostics`；当新写入的 shebang 文件被 chmod 为可执行时，返回 `details.madeExecutable`。
- 普通/归档/冲突结果在由文件支撑时设置 `details.resolvedPath`。SQLite 写入还通过 `sourcePath(...)` 将 `details.meta.source` 设置为数据库文件。内部 URL 写入返回空的 `details`；设备分派设置 `details.xdev`。

## 流程
1. `WriteTool.execute()` 解包被复制的 `[path#TAG]` 参数，并从内部 URL 上剥离有效的 read 选择器，使写入与读取指向同一资源。可写 URL 上的畸形/范围选择器会被拒绝。
2. 在 hashline 显示模式下，它会从 `content` 中剥离粘贴进来的 `[PATH#HASH]` 头和 `LINE:` 前缀。
3. 它校验形似 URI 的目标。未知 scheme 与常见的 `xd://` 拼写错误会直接失败，而不会变成本地文件名；若要刻意创建一个形似 URI 的 POSIX 文件名，请加上 `./` 前缀。
4. 如果 `path` 是一个内部 URL 且其处理器暴露了 `write`，工具会委托给它。`xd://` 校验 JSON 并将其分派给已挂载的工具，同时保留其结果与审批层级；`local://` 则落到会话本地文件系统路径。
5. 接下来处理 `conflict://...`。诸如 `conflict://<id>/ours` 这类作用域读取是只读的；可写的冲突 URI 省略作用域。已注册的磁盘标记会在替换前重新校验。
6. 它调用 `#resolveArchiveWritePath()`。候选归档文件按最长优先检查；当都不存在时，使用最短的候选归档路径来创建新容器。
7. 归档写入调用 `enforcePlanModeWrite(..., { op: exists ? "update" : "create" })`，然后调用 `#writeArchiveEntry()`。
   - 父目录会被递归创建。
   - 现有条目通过 `readArchiveEntries()` 加载，目标在条目映射中被替换，随后 `writeArchive()` 序列化出一个完整的替换版本。
   - 替换内容先写入同级的临时路径，再重命名覆盖目标。现有归档符号链接会先被解析，以便更新目标而不是替换该符号链接。
   - ZIP 格式别名保持 ZIP。`.tar.gz`/`.tgz` 选用 tar gzip 压缩，`.tar.zst`/`.tzst` 选用 zstd；`.asar` 容器通过同一边界重写。只读格式（`.7z`、`.rar`、…）会被拒绝。
   - `invalidateFsScanAfterWrite()` 在归档文件路径上运行。
8. 如果不是归档，它会尝试 SQLite 候选。已存在的非 SQLite 文件会抑制 SQLite 解释。
9. SQLite 写入调用 `enforcePlanModeWrite(..., { op: "update" })`，然后调用 `#writeSqliteRow()`。
   - 数据库必须已存在。
   - 它以 `{ create: false, strict: true }` 和 `PRAGMA busy_timeout = 3000` 打开 Bun SQLite。
   - 仅含空白字符且带行键的 `content` 会删除一行。
   - 非空 `content` 用 `Bun.JSON5.parse()` 解析，必须是对象，并被路由到插入/更新辅助函数。
   - 扫描缓存会失效，连接在 `finally` 中关闭。
10. 否则，它把 `path` 当作普通文件系统文件处理。
   - 它会拒绝高置信度的误分派读取目标：缺失的形似选择器文件名且内容为空，或缺失的分号连接的选择器路径列表。已存在的字面路径优先；非空内容是单个刻意形似选择器文件名的逃生通道。
   - 计划模式策略与路径解析在变更之前运行。已存在的文件需通过生成文件守卫。
   - 可用时优先尝试 ACP 桥 `writeTextFile`；否则由会话透写写入内容。LSP 设置可能会对写入进行格式化、同步和诊断。
   - 开头为 shebang 时可能会添加可执行位。文件系统扫描缓存会失效。
11. 工具返回文本，外加可选的诊断、可执行、已解析路径或设备分派元数据。

## 模式 / 变体
### 普通文件路径
- 目标是任何既不能解析为归档选择器、也不能解析为已存在或新建 SQLite 选择器的路径。
- 已存在的文件会被覆盖。
- `write.ts` 在此路径上不调用 `fs.mkdir()`；显式的父目录创建只存在于归档分支中，但 `Bun.write()` 自身会为普通文件写入创建缺失的父目录。

示例：

```text
path: "tmp/output.txt"
content: "hello\n"
```

### 归档条目写入
- 选择器语法：`archive.ext:inner/path`。
- 支持的扩展名：`.zip` 与 ZIP 格式别名（`.jar`、`.war`、`.ear`、`.apk` 以及其他 zip 家族扩展名）、`.tar`、`.tar.gz`/`.tgz`、`.tar.zst`/`.tzst` 和 `.asar`。
- 内部路径会规范化为 `/`，去除空段和 `.` 段，拒绝 `..`，并拒绝以 `/` 结尾的目录目标。
- 在替换单个条目之后，通过临时文件和重命名重写整个归档。
- 如有需要，创建归档文件的父目录。

示例：

```text
path: "build/assets.tar.gz:css/app.css"
content: "body { color: black; }\n"
```

### SQLite 表插入
- 选择器语法：`db.sqlite:table`。
- `content` 必须能解析为 JSON5 对象。
- 允许空对象，它会变成 `INSERT INTO <table> DEFAULT VALUES`。
- SQLite 写入会拒绝查询参数。

示例：

```text
path: "data/app.db:users"
content: "{name: 'Ada', active: true}"
```

### SQLite 行更新 / 删除
- 选择器语法：`db.sqlite:table:key`。
- 非空 `content` 更新该行。
- 为空或仅含空白字符的 `content` 删除该行。
- 行查找在存在单列主键时使用该主键；否则回退到 `rowid`。基于键的写入会拒绝复合主键和 `WITHOUT ROWID` 表。

更新示例：

```text
path: "data/app.sqlite:users:42"
content: "{email: 'ada@example.com'}"
```

删除示例：

```text
path: "data/app.sqlite:users:42"
content: ""
```

### 可写内部资源与工具设备
- 带有 `write` 钩子的已注册内部处理器拥有其资源语义（例如 `vault://`）。`local://` 则会被解析进会话本地产物沙箱，并遵循普通文件路径。
- `xd://` 列出/分派挂载在 `write` 之后的工具设备。先读取 `xd://<name>` 获取其生成的输入文档，然后传入一个 JSON 对象作为 `content`。设备自身的 schema、更新、结果块、错误标志、渲染器元数据和审批层级都会被保留。
- 未知的形似 URI 的 scheme 会被拒绝，以防止静默创建本地文件。仅当该文件名是刻意的时才使用 `./scheme://...`。

### 合并冲突解决
- 首先读取 `<file>:conflicts`；这会注册会话稳定的 id。`conflict://<N>` 只替换该已记录的标记块，并拒绝过时/缺失的区域。
- 恰好等于 `@ours`、`@theirs`、`@base` 或 `@both` 的一行会展开为已记录的一侧（`@both` 是先 ours 后 theirs）。`@base` 需要 diff3 base。其他内容按字面处理。
- 带普通内容的 `conflict://*` 会对每个已注册冲突应用相同的替换/token 展开。诸如 `1: @ours\n2: @theirs` 的按 id 指令内容只解决所列 id；每个非空指令行必须使用一个 side token，且 id 不得重复。
- 批量处理按文件全有或全无，且自底向上应用。其他文件仍可成功；跨文件的部分成功返回 `isError: true`，而全部失败的一趟会抛出异常。成功的 id 会失效，失败文件的 id 仍保持注册以便重试。
- `/ours`、`/theirs`、`/base` 和 `/both` URI 作用域是只读的。


## 副作用
- 文件系统
  - 创建或覆盖普通文件。
  - 写入条目时，通过同级临时文件和重命名以原子方式重写整个归档文件。
  - 显式创建归档文件的父目录；普通文件后端也支持缺失的父目录。
  - 修改现有 SQLite 数据库；从不创建新的 SQLite 数据库。
  - 为 `conflict://...` 写入解决文件中的冲突标记。
  - 成功的普通文件写入后，可能将 shebang 文件 chmod 为可执行。
- 子进程 / 原生绑定
  - 通过 `bun:sqlite` 使用 Bun SQLite 绑定。
  - 使用 `packages/utils/src/ar` 中的统一归档工具：tar 序列化，以及对压缩 tar 的 gzip/zstd 封装、对 ZIP 的由 `node:zlib` 支撑的 DEFLATE 封装，还有一个 ASAR 编码器。
  - 可能通过 `packages/coding-agent/src/lsp/index.ts` 与已配置的 LSP 服务器通信。
- 会话状态
  - 通过 `invalidateFsScanAfterWrite()` 使共享文件系统扫描缓存条目失效。
  - 在变更目标之前执行计划模式写入限制。
  - 为普通文件和冲突解决更新文件变更/快照状态；已解决的冲突 id 会失效。
  - `xd://` 分派一个已挂载的工具，因此可能具有该工具记录在案的副作用。
- 后台工作 / 取消
  - 在 `WriteTool` 中将该工具标记为 `concurrency = "exclusive"`。
  - 写入主体被 `untilAborted` 包裹；LSP 透写可以在超时之后安排延迟的诊断获取。

## 限制与上限
- 普通/内部文件内容除了内存处理之外没有工具级字节上限。归档重写继承归档工具的上限：tar/tgz 输入 `256 MiB`，每个现有成员 `64 MiB`，且 ZIP 输出必须能容纳非 ZIP64 的 32 位条目/计数/偏移限制。
- 生成文件检测在 `packages/coding-agent/src/tools/auto-generated-guard.ts` 中最多从现有文件读取 `CHECK_BYTE_COUNT = 1024` 字节和 `HEADER_LINE_LIMIT = 40` 行头部。
- SQLite 写入设置 `PRAGMA busy_timeout = 3000`。
- LSP 透写在 `runLspWritethrough()` 中使用 `5_000` ms 的操作超时，并可能在 `scheduleDeferredDiagnosticsFetch()` 中用 `AbortSignal.timeout(25_000)` 安排一次延迟的诊断获取。
- shebang 可执行处理取决于宿主文件系统的 chmod 支持。

## 错误
- 无效的归档子路径会抛出 `ToolError`，消息例如：
  - `Archive write path must target a file inside the archive`
  - `Archive write path must target a file, not a directory`
  - `Archive path cannot contain '..'`
- SQLite 路径解析在遇到不支持的形式时抛出：
  - `SQLite write paths do not support query parameters`
  - `SQLite write path must target a table`
  - `SQLite row writes require a non-empty row key`
- 缺失的 SQLite 数据库表现为 `SQLite database '<path>' not found`。
- SQLite 内容错误包括无效 JSON5、非对象负载、未知列、非标量值、空更新对象、复合主键，以及 `WITHOUT ROWID` 键查找。
- 已存在的普通文件在看起来像是生成文件时，可能被 `assertEditableFile()` 拒绝。
- 形似 URI 的未知目标以及畸形/缺失的 `xd://` 设备会失败，而不是写入本地文件；已挂载的设备会暴露自身的 schema/工具错误。
- 对缺失的形似选择器目标的空写入，以及分号连接的选择器列表，会因疑似读/写误分派而被拒绝。
- 冲突作用域写入是只读的；无效/过时的 id、畸形的批量指令、缺失的 `@base` 以及过时的标记位置都会暴露为 `ToolError`。
- 归档读/写失败和意外的 SQLite 异常会被包装在 `ToolError(error.message)` 中。
- 如果没有匹配的 LSP 服务器，或 LSP 格式化/诊断超时，文件写入仍会完成；诊断可能被省略。

## 备注
- 归档路径检测在 SQLite 检测之前运行。匹配归档选择器的路径绝不会被当作 SQLite。
- 当带 `.sqlite` / `.db` 后缀的已存在文件缺少 SQLite magic bytes 时，SQLite 检测会放弃；该路径回退为普通文件写入。
- 归档重写使用统一的 `readArchiveEntries()` / `writeArchive()` 边界以及临时文件重命名。字符串成员按 UTF-8 编码。
- 提示词禁止两种常见反模式：对应当使用 `edit` 的常规编辑使用 `write`，以及在未被明确要求时创建 `*.md` / `README` 文件。它还禁止在未被要求时使用 emoji。
- 普通文件和内部 URL 写入把 `cleanContent.length` 报告为「bytes」，这在 JS 中是 UTF-16 码元，而非磁盘上的字节度量。
- 仅当会话的文件显示模式启用了 `hashLines` 时，`stripWriteContent()` 才会移除 hashline 前缀；否则内容按原样写入。

- 该工具具有 `strict = true`、`loadMode = "essential"` 和排他并发。其渲染器默认展示 12 行流式预览和 6 行完成预览；`xd://` 结果把渲染委托给已挂载的设备。
