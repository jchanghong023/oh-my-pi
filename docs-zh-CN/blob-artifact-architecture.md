# Blob 与 artifact 存储架构

本文档描述 coding-agent 如何在会话 JSONL 之外存储大型/二进制负载、被截断的工具输出如何持久化，以及内部 URL（`artifact://`、`agent://`）如何解析回已存储的数据。

## 为什么存在两套存储系统

运行时针对不同形态的数据使用两种不同的持久化机制：

- **内容寻址的 blob**（`blob:sha256:<hash>`）：全局存储，用于将大型图片 base64 负载和 provider 的图片 data URL 从持久化的会话条目中外置出来。
- **会话范围的 artifact**（`<sessionFile-without-.jsonl>/` 下的文件）：每会话一份的文本文件，用于完整工具输出和子 agent 输出。

二者是有意分开的：

- blob 存储通过内容哈希优化去重和稳定引用；
- artifact 存储优化仅追加式的会话工具流程，以及借助本地 ID 完成的人工/工具检索。

## 存储边界与磁盘布局

### Blob 存储边界（全局）

`SessionManager` 构造 `BlobStore(getBlobsDir())`，因此 blob 文件位于共享的全局 blob 目录中，而不是会话文件夹内。

Blob 文件命名：

- 文件路径：`<blobsDir>/<sha256-hex>`
- 规范文件没有扩展名；当提供了有效扩展名（图片 MIME 类型）时，会在它旁边硬链接或复制一个带类型的 sidecar `<sha256-hex>.<ext>`，以便操作系统的打开器能够进行类型识别
- 条目中存储的引用字符串：`blob:sha256:<sha256-hex>`，其中的哈希必须恰好是 64 个小写十六进制字符

由此带来的影响：

- 跨会话的相同二进制内容会解析到同一哈希/路径；
- 写入在内容层面是幂等的；
- blob 的生命周期可以超过任何单个会话文件。

## Artifact 边界（会话本地）

`ArtifactManager` 从会话文件路径派生 artifact 目录：

- 会话文件：`.../<timestamp>_<sessionId>.jsonl`
- artifact 目录：`.../<timestamp>_<sessionId>/`（去掉 `.jsonl`）

各类 artifact 共用此目录：

- 被截断的工具输出文件：`<numericId>.<toolType>.log`（对应 `artifact://`）
- 子 agent 输出文件：`<outputId>.md`（对应 `agent://`）
- 子 agent 会话 JSONL sidecar：当任务执行接收到 artifacts 目录时为 `<outputId>.jsonl`

子 agent 可以采用父级的 `ArtifactManager`；在这种情况下，父级与子 agent 树共享同一个 artifact 目录和数值型 artifact ID 空间。

## ID 与名称分配方案

### Blob ID：内容哈希

`BlobStore.put()` / `putSync()` 对传入的字节计算 SHA-256，并返回：

- `hash`：十六进制摘要；
- `path`：`<blobsDir>/<hash>`；
- `displayPath`：提供扩展名时为 `<blobsDir>/<hash>.<ext>`，否则为规范路径；
- `ref`：`blob:sha256:<hash>`。

不使用会话本地计数器。

### Artifact ID：会话本地单调递增整数

`ArtifactManager` 懒创建目录，并在首次基于目录的分配时扫描已有的 `*.log` 文件以找出最大数值 ID，设置 `nextId = max + 1`。并发的首次分配共享同一个初始化 promise，因此不会重置计数器或分发出重复 ID。

分配行为：

- 文件格式：`{id}.{sanitizedToolType}.log`
- 工具类型会把 `[A-Za-z0-9_-]` 之外的字符折叠为 `_`，裁剪首尾下划线，长度上限 64 字符，回退为 `tool`
- ID 是顺序字符串（`"0"`、`"1"`、……）
- 由于扫描发生在分配之前，恢复不会覆盖已有 artifact

如果 artifact 目录不存在，初始化会创建它，分配从 `0` 开始。

未采用 manager 的非持久化会话可以把 `saveArtifact(...)` 的内容以数值 ID 存在内存中，但 `artifact://` 的解析通过已注册的 artifact 目录以文件为后端。

### Agent 输出 ID（`agent://`）

`AgentOutputManager` 根据请求的名称分配 ID：首次按字面使用，仅在重复时追加后缀（`-2`、`-3`、……）。嵌套输出使用以点号限定的父级前缀（例如 `Parent.Child`）。初始化会同时扫描 `.md` 输出和 `.jsonl` 子会话文件，因此恢复时两者都不会被覆盖；保留的 advisor transcript stem 永远不会被原样分配。

## 持久化数据流

### 1）会话条目持久化改写路径

在会话条目被写入之前——无论是增量追加（`#appendToSessionFile`）还是全文件改写（`#rewriteSynchronously` / `#rewriteAtomically`）——`SessionManager` 都会通过 `#lineFor()` 将其序列化，该过程会经由截断管道运行 `prepareEntryForPersistence()`。

关键行为：

1. **大字符串截断**：超大字符串会被裁剪并追加 `"[Session persistence truncated large content]"` 后缀；签名字段（`thinkingSignature`、`thoughtSignature`、`textSignature`）则被清空而非截断。
2. **瞬态字段剥离**：`partialJson` 和 `jsonlEvents` 会从持久化条目中移除。
3. **图片外置为 blob**：
   - 当 `content` 数组中图片块的 `data` 尚不是 blob ref、且 base64 长度至少达到阈值（`BLOB_EXTERNALIZE_THRESHOLD = 1024`）时，对其外置；
   - 当 provider 风格的 `image_url` data URL 以 `data:image/` 开头且包含 `;base64,` 时，对其外置；
   - 图片块的 `data` 以解码后的二进制字节存储；
   - provider data URL 以原始 UTF-8 data URL 字符串存储；
   - 持久化的值被替换为 `blob:sha256:<hash>`。

这使会话 JSONL 保持紧凑，同时保留可恢复性。

### 2）会话加载再水化路径

打开会话（`setSessionFile`）时，在迁移完成后，`SessionManager` 会运行 `resolveBlobRefsInEntries()`。

对于携带 `blob:sha256:<hash>` 的消息/自定义消息图片块，以及携带 blob ref 的已持久化 provider `image_url` 字段：

- 从 blob 存储读取 blob 字节；
- 将图片块字节转换回 base64；
- 将 provider `image_url` blob 转换回原始字符串；
- 改写内存中的条目字段，供运行时消费者使用。

如果某个 blob 缺失：

- 图片块解析会记录警告，并在内存中保留原始 `blob:sha256:` ref 字符串；
- provider `image_url` 解析会记录警告，并保留原始 ref 字符串；
- 加载继续进行。

### 3）工具输出溢出/截断路径

`OutputSink` 为 bash/python/ssh 及相关执行器中的流式输出提供支持。

行为：

1. 每个数据块都会经 `sanitizeWithOptionalSixelPassthrough(..., sanitizeText)` 清洗，并累加到内存计数中。
2. 可选的实时 `onChunk` 接收列宽上限处理之前的清洗后数据块，并在配置了节流时进行节流。
3. 每行列宽上限可能从面向 LLM 的缓冲区中的长行丢弃字节；发生这种情况时，会启动 artifact 镜像，使磁盘上的文件保留完整的清洗后流。
4. 当内存中的尾部缓冲区即将超过溢出阈值（`DEFAULT_MAX_BYTES`，50KB）时，sink 会把输出标记为已截断，并在有可用 artifact 路径时启动 artifact 镜像。
5. 如果打开了文件 sink，它会先写入当前缓冲区，然后写入所有已排队及后续的清洗后数据块。
6. 内存缓冲区会被裁剪为尾部窗口；配置了头部保留时，则裁剪为头部 + 省略标记 + 尾部。
7. `dump()` 完成捕获收尾，并且仅在未观察到任何 artifact I/O 失败时才返回 `artifactId`。`artifactError` 记录第一个失败的操作（`open`、`write`、`flush` 或 `end`），而不持久化原始的文件系统错误文本。

实际效果：

- UI/工具返回展示有界输出；
- 完整的清洗后输出保留在 artifact 文件中，并在文件后端的 artifact 镜像成功时以 `artifact://<id>` 引用。

如果 artifact I/O 失败，sink 会停止后续捕获尝试，保留已有的有界内联输出，并且仍会关闭自己的 writer。工具的执行结果保持不变；其输出元数据和终端警告会说明完整输出未被完整保存，而不会把不完整的 artifact 宣传为完整的恢复来源。`dump()` 与 `dispose()` 共享完成状态，因此并发的收尾操作无法在异步写入或关闭失败落定之前先行宣布成功。流式 sink 不启用磁盘上限，也不重试失败的捕获。

捕获警告同样能在后台任务投递、`hub jobs`/`wait` 恢复、取消以及 transcript 重建之后保留。捕获失败归属于单个任务，而不是汇总报告。超大快照可以持久化完整的带注记报告（包括健康任务的结果），并将其宣传为“完整报告”，而非完整的原始命令日志。每条来源捕获警告会在面向模型的文本中出现一次，并在它自己的实时或重建终端行上出现一次。单个不完整的捕获仍然不会被重新溢出，也不会被宣传为完整的原始输出。

transcript 重建还会从历史的按任务字段中读取捕获错误。当没有任何任务指认来源时，历史汇总警告会被保留；当某一行已经带有相同失败时，则不会重复。

## URL 访问模型

### `blob:` 引用

`blob:sha256:<hash>` 是会话条目负载内部的持久化引用，不是由路由器处理的内部 URL scheme。`SessionManager` 会在加载时解析它。格式错误的后缀会在任何路径拼接之前被 `parseBlobRef()` 拒绝并记录日志，保持原样不变，而不会从 blob 目录读取。

### `artifact://<id>`

由 `ArtifactProtocolHandler` 基于已注册的活跃会话 artifact 目录处理：

- 需要数值型 ID
- 优先使用调用会话固定的 artifact 目录，其次才是其他已注册会话，因为数值 ID 是会话本地的
- 搜索文件名前缀 `<id>.`
- 内联解析时返回原始的 `text/plain`
- 缺失时报告可用的数值型 artifact ID
- 拒绝内联物化超过 8 MiB 的完整 artifact；搜索/复制工作流请使用有界的 `read` 选择器或所报告的后端路径

仅使用路径的消费者可以在任意大小下解析后端文件，而无需加载其字节。

失败行为：

- 如果没有已注册的 artifact 目录：抛出 `No session - artifacts unavailable`；
- 如果已注册目录存在但磁盘上均不存在：抛出 `No artifacts directory found`；
- 如果 ID 不是数值型：抛出 `artifact:// ID must be numeric, got: <id>`。

### `agent://<id>`

由 `AgentProtocolHandler` 基于已注册的活跃会话 artifact 目录以及 `<artifactsDir>/<id>.md` 处理：

- `agent://<id>` 返回 markdown 文本
- `agent://Parent/Child` 首先尝试嵌套输出 `Parent.Child.md`
- 仅当没有嵌套输出匹配时，斜杠路径才回退为从基础输出做 JSON 抽取
- `?q=` 总是执行 JSON 抽取
- 路径抽取与查询抽取不能组合使用
- 抽取要求是合法 JSON，并返回 `application/json`

失败行为：

- 如果没有已注册的 artifact 目录：抛出 `No session - agent outputs unavailable`；
- 如果已注册目录存在但磁盘上均不存在：抛出 `No artifacts directory found`；
- 输出缺失时抛出 `Not found: <id>`，并在目录列举成功时附上可用的 `.md` 输出 ID。

Read 工具集成：

- `read` 对非抽取的内部 URL 读取支持行范围选择器和原始选择器
- 当 `agent://` URL 包含路径或查询抽取语法时，行选择器会被拒绝；抽取直接返回结果，不进行分页

## Resume、fork 与 move 语义

### Resume

- `ArtifactManager` 在首次分配时一次性扫描已有的 `{id}.*.log` 文件并继续编号。
- `AgentOutputManager` 扫描已有的 `.md` 和子级 `.jsonl` ID，并继续为名称追加后缀。
- `SessionManager` 在加载时把 blob ref 再水化为 base64/data URL。

### Fork

`SessionManager.fork()` 创建带有新会话 ID 和 `parentSession` 链接的新会话文件，然后返回旧/新文件路径。Artifact 的复制由 `AgentSession.fork()` 处理：

- 先刷新当前会话；
- 尝试把旧 artifact 目录递归复制到新 artifact 目录；
- 旧目录缺失是被容忍的；
- 非 ENOENT 的复制错误会作为警告记录，fork 仍会完成。

Fork 之后的 ID 影响：

- 如果复制成功，新会话的 artifact 计数器会在新的 `ArtifactManager` 首次扫描时从已复制的最大 ID 之后继续；
- 如果复制失败或被跳过，新会话的 artifact ID 从 `0` 开始。

Fork 之后的 blob 影响：

- blob 是全局且内容寻址的，因此不需要复制 blob 目录。

### 移动到新的 cwd

`SessionManager.moveTo()` 把会话文件和 artifact 目录一并重命名到新的默认会话目录，并在后续步骤失败时执行回滚逻辑。这会在重新定位会话作用域的同时保留 artifact 身份。

当目标 artifact 目录已经存在时——例如会话回到它之前所在的项目，而其旧 artifact 路径一直有子 agent 或 eval 子进程在写入——两个目录会改为合并：条目跨目录移动，两侧都存在的目录递归合并，名称在目标处已被占用的条目留在源目录（artifact ID 按 `<id>.` 前缀解析，因此任何一方都不会被覆盖或重命名）。合并式移动不会通过把目录重命名回去来回滚；只有会话文件的重命名会回滚。

## 失败处理与回退路径

| 场景 | 行为 |
| --- | --- |
| 图片块再水化时 blob 文件缺失 | 发出警告，并在内存中保留 `blob:sha256:` ref 字符串 |
| provider `image_url` 再水化时 blob 文件缺失 | 发出警告，并在内存中保留 `blob:sha256:` ref 字符串 |
| 通过 `BlobStore.get` 读取 blob 遇到 ENOENT | 返回 `null` |
| artifact 目录缺失（`ArtifactManager.listFiles`） | 返回空列表（分配可以从头开始） |
| 没有已注册的 artifact 目录（`artifact://`） | 抛出 `No session - artifacts unavailable` |
| 没有已注册的 artifact 目录（`agent://`） | 抛出 `No session - agent outputs unavailable` |
| 已注册的 artifact 目录在磁盘上不存在 | 显式抛出 `No artifacts directory found` |
| 未找到 artifact ID | 抛出异常并附上可用 ID 列表 |
| 完整 `artifact://` 解析超过 8 MiB | 拒绝内联物化；有界选择器/仅路径工作流仍然可用 |
| OutputSink artifact writer 初始化失败 | 仅继续使用有界的内存输出 |
| 非持久化的 `saveArtifact` | 将文本存储在 `SessionManager` 的内存映射中；并非文件后端的 URL 数据 |
| 移动目标处 artifact 目录已存在 | 目录被合并；名称或 artifact ID 已被占用的条目留在源目录，并以警告级别记录日志 |

## 二进制 blob 外置与文本输出 artifact 的区别

- **Blob 外置**用于持久化会话条目内容中的图片负载以及 provider 的图片 data URL；它把 JSONL 中的内联负载字符串替换为稳定的内容引用。
- **Artifact** 是用于执行输出和子 agent 输出的纯文本文件；文件后端的 artifact 可通过会话本地 ID 经内部 URL 寻址。

两套系统只是间接相交：它们都能减少会话 JSONL 的膨胀，但身份、生命周期和检索路径各不相同。

## 实现文件

- [`src/session/blob-store.ts`](../packages/coding-agent/src/session/blob-store.ts) — blob 引用格式、哈希、put/get、外置/解析辅助函数。
- [`src/session/artifacts.ts`](../packages/coding-agent/src/session/artifacts.ts) — 会话 artifact 目录模型与数值型 artifact ID/路径分配。
- [`src/session/streaming-output.ts`](../packages/coding-agent/src/session/streaming-output.ts) — `OutputSink` 的截断/溢出到文件行为与摘要元数据。
- [`src/session/session-manager.ts`](../packages/coding-agent/src/session/session-manager.ts) — `BlobStore`/`ArtifactManager` 的构造、持久化转换与 blob 再水化的调用点、会话 fork/move 交互。
- [`src/session/session-persistence.ts`](../packages/coding-agent/src/session/session-persistence.ts) — `prepareEntryForPersistence()`：大字符串截断、瞬态字段剥离以及同步的图片 blob 外置。
- [`src/session/session-loader.ts`](../packages/coding-agent/src/session/session-loader.ts) — `resolveBlobRefsInEntries()`：加载时把 blob ref 再水化为 base64 / data URL。
- [`src/session/agent-session.ts`](../packages/coding-agent/src/session/agent-session.ts) — 交互式 fork 期间的 artifact 目录复制。
- [`src/internal-urls/artifact-protocol.ts`](../packages/coding-agent/src/internal-urls/artifact-protocol.ts) — `artifact://` 解析器。
- [`src/internal-urls/agent-protocol.ts`](../packages/coding-agent/src/internal-urls/agent-protocol.ts) — `agent://` 解析器与 JSON 抽取。
- [`src/internal-urls/router.ts`](../packages/coding-agent/src/internal-urls/router.ts) — 内部 URL 路由器的装配。
- [`src/task/output-manager.ts`](../packages/coding-agent/src/task/output-manager.ts) — `agent://` 的会话范围 agent 输出 ID 分配。
- [`src/task/executor.ts`](../packages/coding-agent/src/task/executor.ts) — 子 agent 输出 artifact 写入（`<id>.md`）以及会话 JSONL sidecar。
