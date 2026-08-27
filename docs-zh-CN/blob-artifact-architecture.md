# Blob 与 artifact 存储架构

本文档描述 coding-agent 如何在 session JSONL 之外存储大型/二进制负载、如何持久化被截断的工具输出，以及内部 URL（`artifact://`、`agent://`）如何解析回所存储的数据。

## 为什么存在两套存储系统

运行时针对不同形态的数据使用两种不同的持久化机制：

- **内容寻址的 blob**（`blob:sha256:<hash>`）：全局存储，用于将大型图片 base64 负载和 provider 的 image data URL 从持久化的 session 条目中外置出来。
- **会话范围的 artifact**（`<sessionFile-without-.jsonl>/` 下的文件）：每个会话的文本文件，用于保存完整工具输出和子代理输出。

二者有意分开：

- blob 存储通过内容哈希优化去重和稳定引用；
- artifact 存储通过本地 ID 优化仅追加的会话工具调用以及人工/工具检索。

## 存储边界与磁盘布局

### Blob 存储边界（全局）

`SessionManager` 构造 `BlobStore(getBlobsDir())`，因此 blob 文件位于共享的全局 blob 目录中，而非会话文件夹内。

Blob 文件命名：

- 文件路径：`<blobsDir>/<sha256-hex>`
- 规范文件没有扩展名；当提供有效的扩展名（图片 MIME 类型）时，会在同一目录下硬链接或复制一个带类型的 sidecar `<sha256-hex>.<ext>`，以便操作系统打开器能够按类型识别
- 条目中存储的引用字符串：`blob:sha256:<sha256-hex>`，其中的哈希必须恰好是 64 个小写十六进制字符

由此带来的影响：

- 跨会话的相同二进制内容会解析到同一哈希/路径；
- 写入在内容层面是幂等的；
- blob 的生命周期可以超过任何单个会话文件。

## Artifact 边界（会话本地）

`ArtifactManager` 根据会话文件路径派生 artifact 目录：

- 会话文件：`.../<timestamp>_<sessionId>.jsonl`
- artifact 目录：`.../<timestamp>_<sessionId>/`（去掉 `.jsonl`）

不同类型的 artifact 共用此目录：

- 被截断的工具输出文件：`<numericId>.<toolType>.log`（对应 `artifact://`）
- 子代理输出文件：`<outputId>.md`（对应 `agent://`）
- 子代理会话 JSONL sidecar：当任务执行接收到 artifacts 目录时为 `<outputId>.jsonl`

子代理可以采用父级的 `ArtifactManager`；在这种情况下，父代理与子代理树共享同一个 artifact 目录和数值型 artifact ID 空间。

## ID 与名称分配方案

### Blob ID：内容哈希

`BlobStore.put()` / `putSync()` 对传入的字节计算 SHA-256，并返回：

- `hash`：十六进制摘要，
- `path`：`<blobsDir>/<hash>`，
- `displayPath`：当提供扩展名时为 `<blobsDir>/<hash>.<ext>`，否则为规范路径，
- `ref`：`blob:sha256:<hash>`。

不使用会话本地的计数器。

### Artifact ID：会话本地单调递增整数

`ArtifactManager` 懒创建目录，并在首次基于目录的分配时扫描已有的 `*.log` 文件以找出最大数值 ID，设置 `nextId = max + 1`。并发的首次分配共享同一初始化 promise，因此不会重置计数器或分发出重复 ID。

分配行为：

- 文件格式：`{id}.{sanitizedToolType}.log`
- 工具类型将 `[A-Za-z0-9_-]` 之外的字符折叠为 `_`，裁剪首尾下划线，长度上限 64 字符，回退为 `tool`
- ID 是顺序字符串（`"0"`、`"1"`、……）
- 由于扫描发生在分配之前，恢复不会覆盖已有 artifact

如果 artifact 目录不存在，初始化会创建该目录，分配从 `0` 开始。

没有持久化的会话若未采用某个 manager，可以将 `saveArtifact(...)` 的内容以数值 ID 形式保存在内存中，但 `artifact://` 的解析通过已注册的 artifact 目录以文件为后端。

### 代理输出 ID（`agent://`）

`AgentOutputManager` 根据请求的名称分配 ID：首次按字面使用，仅当重复时才追加后缀（`-2`、`-3`、……）。嵌套输出使用以点号限定的父级前缀（例如 `Parent.Child`）。初始化时同时扫描 `.md` 输出和 `.jsonl` 子会话文件，因此恢复时既不会覆盖前者也不会覆盖后者；保留的 advisor transcript stem 永远不会被原样分配。

## 持久化数据流

### 1）会话条目持久化改写路径

在写入会话条目之前——增量追加（`#appendToSessionFile`）或全文件改写（`#rewriteSynchronously` / `#rewriteAtomically`）——`SessionManager` 通过 `#lineFor()` 将其序列化，期间会经由截断管道运行 `prepareEntryForPersistence()`。

关键行为：

1. **大字符串截断**：超大字符串会被裁剪并追加 `"[Session persistence truncated large content]"`；签名字段（`thinkingSignature`、`thoughtSignature`、`textSignature`）则被清空而非截断。
2. **瞬态字段剥离**：从持久化条目中移除 `partialJson` 和 `jsonlEvents`。
3. **图片外置为 blob**：
   - 当 `content` 数组中图片块的 `data` 尚不是 blob ref，且 base64 长度至少达到阈值（`BLOB_EXTERNALIZE_THRESHOLD = 1024`）时，将其外置；
   - 当 provider 风格的 `image_url` data URL 以 `data:image/` 开头并包含 `;base64,` 时，将其外置；
   - 图片块的 `data` 以解码后的二进制字节存储；
   - provider data URL 以原始 UTF-8 data URL 字符串存储；
   - 持久化的值被替换为 `blob:sha256:<hash>`。

这使得会话 JSONL 保持紧凑，同时仍可恢复数据。

### 2）会话加载再水化路径

在打开会话（`setSessionFile`）时，迁移完成后，`SessionManager` 运行 `resolveBlobRefsInEntries()`。

对于使用 `blob:sha256:<hash>` 的消息/自定义消息图片块，以及使用 blob ref 的已持久化 provider `image_url` 字段：

- 从 blob 存储读取 blob 字节；
- 将图片块字节重新转换为 base64；
- 将 provider `image_url` blob 重新转换为原始字符串；
- 改写内存中供运行时消费使用的条目字段。

如果某个 blob 缺失：

- 图片块解析过程会记录警告，并在内存中保留原始 `blob:sha256:` ref 字符串；
- provider `image_url` 解析过程会记录警告，并保留原始 ref 字符串；
- 加载过程继续进行。

### 3）工具输出溢出/截断路径

`OutputSink` 为 bash/python/ssh 及相关执行器中的流式输出提供支持。

行为：

1. 每个数据块都通过 `sanitizeWithOptionalSixelPassthrough(..., sanitizeText)` 清洗，并累加到内存计数中。
2. 可选的实时 `onChunk` 接收按列宽限制前的清洗片段，若配置了节流则会进行节流。
3. 每行的列宽上限可以从面向 LLM 的缓冲区中丢弃长行的字节；发生这种情况时，会启动 artifact 镜像，使磁盘上的文件保留完整的清洗流。
4. 当内存中的尾部缓冲区超过溢出阈值（`DEFAULT_MAX_BYTES`，50KB）时，sink 将输出标记为已截断，并在有可用 artifact 路径时启动 artifact 镜像。
5. 如果打开了文件 sink，会先写入当前缓冲区，再写入所有已排队及后续的清洗片段。
6. 内存缓冲区会被裁剪为尾部窗口，或在配置了头部保留时裁剪为头部 + 省略标记 + 尾部。
7. `dump()` 返回的摘要仅在文件 sink 创建成功时包含 `artifactId`。

实际效果：

- UI/工具返回显示有界输出；
- 完整的清洗输出保留在 artifact 文件中，并在文件后端 artifact 镜像成功时通过 `artifact://<id>` 引用。

如果文件 sink 创建失败（I/O 错误、路径缺失等），sink 仅回退到内存截断；完整输出不会持久化。

## URL 访问模型

### `blob:` 引用

`blob:sha256:<hash>` 是会话条目负载内部的持久化引用，并非由路由处理的内部 URL scheme。`SessionManager` 在加载时对其进行解析。格式错误的后缀会被 `parseBlobRef()` 在任何路径拼接之前拒绝、记录日志，并保持不变，而不是从 blob 目录读取。

### `artifact://<id>`

由 `ArtifactProtocolHandler` 在已注册的活跃会话 artifact 目录上处理：

- 需要数值型 ID
- 优先使用调用会话所固定的 artifact 目录，而不是其他已注册会话，因为数值 ID 是会话本地的
- 搜索文件名前缀 `<id>.`
- 内联解析时返回原始的 `text/plain`
- 缺失时报告可用的数值型 artifact ID
- 拒绝内联物化超过 8 MiB 的完整 artifact；如需搜索/复制工作流，请使用有界的 `read` 选择器或所报告的后端路径

仅使用路径的消费者可以在任意大小下解析后端文件，无需加载其字节。

失败行为：

- 如果没有已注册的 artifact 目录：抛出 `No session - artifacts unavailable`；
- 如果已注册目录存在但磁盘上均不可见：抛出 `No artifacts directory found`；
- 如果 ID 不是数值型：抛出 `artifact:// ID must be numeric, got: <id>`。

### `agent://<id>`

由 `AgentProtocolHandler` 在已注册的活跃会话 artifact 目录以及 `<artifactsDir>/<id>.md` 上处理：

- `agent://<id>` 返回 markdown 文本
- `agent://Parent/Child` 首先尝试嵌套输出 `Parent.Child.md`
- 仅当没有嵌套输出匹配时，斜杠路径才会回退到基础输出的 JSON 抽取
- `?q=` 总是执行 JSON 抽取
- 路径抽取与查询抽取不能组合使用
- 抽取要求合法 JSON，并返回 `application/json`

失败行为：

- 如果没有已注册的 artifact 目录：抛出 `No session - agent outputs unavailable`；
- 如果已注册目录存在但磁盘上均不可见：抛出 `No artifacts directory found`；
- 输出缺失时，在目录列表成功的情况下抛出 `Not found: <id>` 并附上可用的 `.md` 输出 ID。

Read 工具集成：

- `read` 对非抽取的内部 URL 读取支持行范围和原始选择器
- 当 `agent://` URL 包含路径或查询抽取语法时，行选择器被拒绝；抽取直接返回，不进行分页

## Resume、fork 与 move 语义

### Resume

- `ArtifactManager` 在首次分配时一次性扫描已有的 `{id}.*.log` 文件并继续编号。
- `AgentOutputManager` 扫描已有的 `.md` 和子级 `.jsonl` ID，并继续为名称追加后缀。
- `SessionManager` 在加载时将 blob ref 再水化为 base64/data URL。

### Fork

`SessionManager.fork()` 创建一个新的会话文件，分配新的 session ID 并写入 `parentSession` 链接，然后返回旧/新文件路径。Artifact 的复制由 `AgentSession.fork()` 处理：

- 先刷新当前会话；
- 尝试将旧 artifact 目录递归复制到新 artifact 目录；
- 旧目录缺失是被允许的；
- 非 ENOENT 的复制错误会以警告形式记录，fork 仍会完成。

Fork 之后的 ID 影响：

- 如果复制成功，新会话中的 artifact 计数器在新的 `ArtifactManager` 首次扫描时从已复制的最大 ID 之后继续；
- 如果复制失败或被跳过，新会话的 artifact ID 从 `0` 开始。

Fork 之后的 blob 影响：

- blob 是全局且内容寻址的，因此无需复制 blob 目录。

### 移动到新的 cwd

`SessionManager.moveTo()` 将会话文件和 artifact 目录一并重命名到新的默认会话目录，并在后续步骤失败时提供回滚逻辑。这在重新定位会话作用域的同时保留了 artifact 标识。

## 失败处理与回退路径

| 场景                                                      | 行为                                                                                   |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 图片块再水化时 blob 文件缺失                              | 发出警告，并在内存中保留 `blob:sha256:` ref 字符串                                      |
| provider `image_url` 再水化时 blob 文件缺失               | 发出警告，并在内存中保留 `blob:sha256:` ref 字符串                                      |
| 通过 `BlobStore.get` 读取 blob 时遇到 ENOENT              | 返回 `null`                                                                           |
| artifact 目录缺失（`ArtifactManager.listFiles`）          | 返回空列表（分配可以从头开始）                                                         |
| 没有已注册的 artifact 目录（`artifact://`）               | 抛出 `No session - artifacts unavailable`                                              |
| 没有已注册的 artifact 目录（`agent://`）                  | 抛出 `No session - agent outputs unavailable`                                          |
| 已注册的 artifact 目录在磁盘上不可见                      | 显式抛出 `No artifacts directory found`                                                |
| 未找到 artifact ID                                        | 抛出异常并附上可用的 ID 列表                                                           |
| 完整 `artifact://` 解析超过 8 MiB                         | 拒绝内联物化；有界选择器/仅路径工作流仍可用                                            |
| OutputSink artifact writer 初始化失败                      | 继续仅使用有界的内存输出                                                               |
| 非持久化的 `saveArtifact`                                 | 将文本存储在 `SessionManager` 的内存映射中；不作为文件后端的 URL 数据                  |

## 二进制 blob 外置与文本输出 artifact 的区别

- **Blob 外置**用于持久化会话条目内容中的图片负载以及 provider 的 image data URL；它将 JSONL 中的内联负载字符串替换为稳定的内容引用。
- **Artifact**是用于执行输出和子代理输出的纯文本文件；文件后端的 artifact 可通过会话本地 ID 由内部 URL 寻址。

两套系统只是间接相交：它们都减少了会话 JSONL 的体积，但身份、生命周期和检索路径各不相同。

## 实现文件

- [`src/session/blob-store.ts`](../packages/coding-agent/src/session/blob-store.ts) — blob 引用格式、哈希、put/get、外置/解析辅助函数。
- [`src/session/artifacts.ts`](../packages/coding-agent/src/session/artifacts.ts) — 会话 artifact 目录模型以及数值型 artifact ID/路径分配。
- [`src/session/streaming-output.ts`](../packages/coding-agent/src/session/streaming-output.ts) — `OutputSink` 的截断/溢出到文件行为及摘要元数据。
- [`src/session/session-manager.ts`](../packages/coding-agent/src/session/session-manager.ts) — `BlobStore`/`ArtifactManager` 的构造、持久化转换与 blob 再水化的调用点、会话 fork/move 交互。
- [`src/session/session-persistence.ts`](../packages/coding-agent/src/session/session-persistence.ts) — `prepareEntryForPersistence()`：大字符串截断、瞬态字段剥离以及同步的图片 blob 外置。
- [`src/session/session-loader.ts`](../packages/coding-agent/src/session/session-loader.ts) — `resolveBlobRefsInEntries()`：在加载时将 blob ref 再水化为 base64 / data URL。
- [`src/session/agent-session.ts`](../packages/coding-agent/src/session/agent-session.ts) — 交互式 fork 期间的 artifact 目录复制。
- [`src/internal-urls/artifact-protocol.ts`](../packages/coding-agent/src/internal-urls/artifact-protocol.ts) — `artifact://` 解析器。
- [`src/internal-urls/agent-protocol.ts`](../packages/coding-agent/src/internal-urls/agent-protocol.ts) — `agent://` 解析器与 JSON 抽取。
- [`src/internal-urls/router.ts`](../packages/coding-agent/src/internal-urls/router.ts) — 内部 URL 路由连接。
- [`src/task/output-manager.ts`](../packages/coding-agent/src/task/output-manager.ts) — `agent://` 的会话范围代理输出 ID 分配。
- [`src/task/executor.ts`](../packages/coding-agent/src/task/executor.ts) — 子代理输出 artifact 写入（`<id>.md`）及会话 JSONL sidecar。
