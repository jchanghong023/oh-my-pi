# read

> 通过一个 `path` 字符串读取文件、目录、归档、SQLite 数据库、内部资源、图片、文档和 URL。

## 源码

- 入口：`packages/coding-agent/src/tools/read.ts`
- 面向模型的提示词：`packages/coding-agent/src/prompts/tools/read.md`
- 关键协作者：
   - `packages/coding-agent/src/tools/path-utils.ts` — 从尾部选择器中拆分 `path`；优先使用字面文件名；规范化本地路径，并恢复意外出现的分隔符路径列表。
   - `packages/utils/src/ar`(`@oh-my-pi/pi-utils/ar`) — 统一归档注册表：检测 `archive.ext:inner/path`、索引归档、列出/读取条目。
   - `packages/coding-agent/src/tools/sqlite-reader.ts` — 检测 SQLite 目标、解析选择器、渲染表。
   - `packages/coding-agent/src/tools/fetch.ts` — URL 解析、抓取/渲染流水线、URL 缓存/产物。
   - `packages/coding-agent/src/internal-urls/router.ts` — 内置的内部资源注册表，包括 `ssh://` 和 `xd://`;MCP 可能声明额外的 scheme。
   - `packages/coding-agent/src/edit/notebook.ts` — 将 `.ipynb` 转换为可编辑的 `# %% [...] cell:N` 文本。
   - `packages/coding-agent/src/utils/cpuprofile.ts` / `sample-profile.ts` — 汇总可识别的 profiler 报告。
   - `packages/coding-agent/src/utils/file-display-mode.ts` — 决定使用 hashline、行号还是原始显示。
   - `packages/coding-agent/src/workspace-tree.ts` — 渲染目录树。
   - `packages/coding-agent/src/edit/file-snapshot-store.ts` — 存储已读取的行，供后续 hashline 编辑验证/恢复使用。
   - `packages/coding-agent/src/tools/index.ts` — 注册 `read: s => new ReadTool(s)`。

## 输入

| 字段   | 类型     | 必填     | 说明                                                                                                     |
| ------ | -------- | -------- | -------------------------------------------------------------------------------------------------------- |
| `path` | `string` | 是       | 文件系统路径、内部 URL 或 web URL。可以以尾部选择器结尾，例如 `:50-100` 或 `:raw`。 |

### 选择器语法

对于普通的类文件读取，`packages/coding-agent/src/tools/path-utils.ts` 中的 `splitPathAndSel()` 仅在末尾后缀匹配下列形式之一时才识别它：

| 后缀                          | 含义                                                                                                                                           |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `:raw`                        | 原始/逐字模式。禁用结构化摘要和行前缀。                                                                                                        |
| `:img`                        | 将本地 `.svg`/`.svgz` 文件栅格化，并作为图片块返回以供视觉输入。仅支持本地 SVG/SVGZ 文件。                                                       |
| `:conflicts`                  | 扫描本地文件中的未解决 Git 合并冲突区域，将其登记到会话冲突历史，并渲染紧凑的 `#N Lx-Ly` 索引。                                                    |
| `:N` / `:LN` / `:N-` / `:N..` | 从以 1 为起始编号的第 `N` 行开始，不限结束行。                                                                                                    |
| `:A-B` / `:LA-LB` / `:A..B`   | 包含两端的、以 1 为起始编号的行范围(`..` 是宽容别名，会规范化为 `-`)。                                                                            |
| `:A+C` / `:LA+LC`             | 从 `A` 开始的 `C` 行；工具会将其转换为结束行 `A + C - 1`。                                                                                       |
| `:R1,R2,...`                  | 多个范围，读取前先排序并合并(例如 `:5-16,960-973`)。                                                                                            |
| `:range:raw` 或 `:raw:range`  | 行选择相同，但输出为原始格式。                                                                                                                  |

`parseLineRangeChunk()` 中的校验：

- 行号以 1 为起始编号；`:0` 会抛出错误。
- `+` 的计数必须 `>= 1`。
- `-` 的结束值必须 `>= start`。

选择器解析会有意放过无法识别的尾部 `:...`；归档路径和 SQLite 路径消费各自的冒号语法。

URL 选择器在 `packages/coding-agent/src/tools/fetch.ts` 中单独解析，但对 `:raw`、`:N`、`:A-B`、`:A+C`、`:5-10,20-30` 以及 `:range:raw` / `:raw:range` 使用同一个行范围解析器。由于 URL 端口也使用 `:`，请在 host/port URL 的选择器之前加上尾部斜杠，例如 `https://example.com/:80`。
字面文件系统路径优先于选择器解释，因此以类似选择器文本结尾的现存 POSIX 文件名会按字面读取。

## 输出

- 单次返回的 `AgentToolResult`，由 `packages/coding-agent/src/tools/tool-result.ts` 中的 `toolResult()` 构建。
- `content` 通常是一个文本块。图片读取可能返回 `[text, image]`。
- `details` 取决于具体路径。`ReadToolDetails` 可能包含：
   - `kind: "file" | "url"`(URL 路径使用 `kind: "url"`；文件读取通常省略 `kind`)
   - `isDirectory`
   - `resolvedPath`
   - `suffixResolution`
   - URL 字段：`url`、`finalUrl`、`contentType`、`method`、`notes`
   - `truncation`(`ReadTruncationStats`：仅含计数器与标志；没有重复的 `content` 字段)
   - `displayContent`(无前缀文本 + 起始行，用于 TUI 渲染)
   - `summary`(`lines`、`elidedSpans`、`elidedLines`)，用于结构化摘要
   - `conflictCount`，用于 `<path>:conflicts`
   - `displayReadTargets`，当工具为 TUI 显示恢复了意外出现的分隔符路径列表时
   - `meta`，来自 `packages/coding-agent/src/tools/output-meta.ts`
- `details.meta.source` 会被设置为后备路径、URL 或内部 URL。
- `details.meta.truncation` 携带显示范围、总行数/字节数、下一个偏移量，以及可选的 `artifactId`(用于缓存的 URL 输出)。
- 读取结果正文位于 `content`;`details.displayContent` 仍是无前缀的 TUI 表示。此前读取 `details.truncation.content` 的扩展必须改用这些字段。包含该额外字段的旧会话记录仍可加载和渲染，无需迁移。
- 目录/归档列表和 SQLite 表列表在触发列表限制时，还会设置 `details.meta.limits`。

## 流程

1. `ReadTool.execute()` 接受 `{ path }`。`file://...` 输入先用 `expandPath()` 展开。`conflict://<N>[/ours|theirs|base|both]` 在普通 URL 之前处理；`conflict://*` 只写。
2. 它尝试通过 `packages/coding-agent/src/tools/fetch.ts` 中的 `parseReadUrlTarget()` 进行 web URL 处理。
   - 普通 URL 读取调用 `executeReadUrl()`。
   - 带行选择器的 URL 读取会按需抓取/渲染到 URL 缓存，然后在本地对渲染出的文本分页。
3. 它检查内部 URL 路由器，包括内置 scheme 和 MCP 声明的 scheme。
   - 由实际文件支撑的 `local://` 资源会被提升到本地文件路径，使图片、转换、选择器和快照的行为与文件系统读取一致。
   - `agent://` 的查询提取(`/path` 或 `?q=`)绕过分页，直接返回提取出的内容。
   - `artifact://` 使用有界的、以文件为后备的读取器，而不是加载完整产物。
   - 其他内部资源由 `#buildInMemoryTextResult()` 在内存中分页。
4. 在把类似选择器的冒号当作归档、SQLite、PDF 图片或行选择器语法之前，它优先采用现存的字面文件系统路径。
5. 接下来它用 `#resolveArchiveReadPath()` 尝试归档解析。
   - `parseArchivePathCandidates()` 在 `:sub/path` 之前识别 `.tar`、`.tar.gz`、`.tgz`、`.zip`、`.jar`、`.war`、`.ear` 和 `.apk`。
   - 成功时，`#readArchive()` 要么列出目录，要么把某个条目解码为 UTF-8 文本。
6. 它用 `#resolveSqliteReadPath()` 尝试 SQLite 解析。
   - `parseSqlitePathCandidates()` 在任何 `:table`、`:key` 或 `?query` 后缀之前扫描 `.sqlite`、`.sqlite3`、`.db`、`.db3`。
   - `#readSqlite()` 依据 `parseSqliteSelector()` 分派。
7. 否则，它把输入当作本地文件系统路径。
   - `resolveReadPath()` 展开 `~`，相对于会话 cwd 解析，把裸 `/` 视为会话 cwd，并重试 macOS 截图/NFD/弯引号变体。
   - 如果路径不存在，`findUniqueWorkspaceSuffix()` 会尝试工作区范围内的唯一后缀匹配(远程挂载会跳过)。与生效的 `local://` 计划基名匹配的 cwd 根文件名可能恢复该计划。作为最后一道带保护的恢复手段，被错误分隔开的现存路径列表会被逐段读取；调用方仍应为每个路径发起一次 `read`。
8. 目录经由 `#readDirectory()` 处理。
9. 非目录按内容类型分支：
   - 图片元数据 / 内联图片
   - 汇总后的 macOS `sample` 或 V8 `.cpuprofile` 报告
   - 可编辑的 notebook 文本
   - 经 markit 转换的文档
   - 二进制文件提示，除非显式使用了 `:raw`
   - 可解析代码/散文的结构化摘要
   - 流式文本/行范围读取
10. 本地文本读取由 `streamLinesFromFile()` 流式完成，而不是加载整个文件。单个有界的非原始文本范围会在受限侧添加 `1` 行前导和 `3` 行尾随上下文；原始读取和多范围读取保持精确。
11. 符合条件的本地读取(可用于 hashline)会把文件快照记录到会话快照存储中，供后续 hashline 编辑验证/恢复使用。超过快照字节上限的文件不会被快照。
12. 如果发生了后缀解析，第一个文本块会被加上前缀 `[Path '...' not found; resolved to '...' via suffix match]`。

## 模式 / 变体

### 本地文本文件

- 无选择器：如果摘要功能已启用且文件符合条件，`#trySummarize()` 会调用 `summarizeCode()`。
   - 默认值：`read.summarize.enabled = true`；散文(`.md` 变体和 `.txt`)保持不摘要，除非 `read.summarize.prose = true`；低于 `read.summarize.minTotalLines = 100` 的文件保持逐字输出。
   - 硬性保护：文件大小 `<= 2 MiB`(`MAX_SUMMARY_BYTES`)，行数 `<= 20_000`(`MAX_SUMMARY_LINES`)。
   - 摘要输出保留选中的声明，并把省略的区间替换为 `…` 或包含 `{ … }` 的合并花括号对行。当至少有一个区间被省略时，文本内容以类似 `[…NNln elided; re-read needed ranges, e.g. <path>:5-16,40-80]` 的页脚结尾，其中使用来自实际省略的具体范围。
   - 当被省略的块位于配对的花括号行之间时，`#renderSummary()` 可能把它们合并为一行带锚点的行，而不是分别输出开括号行和闭括号行。
- 显式选择器或摘要未命中：流式文本读取。
   - 默认开放式上限为 `read.defaultLimit = 300`，会被限制在 `[1, DEFAULT_MAX_LINES]`。
   - 单个有界的非原始文本范围会在受限侧添加 `RANGE_LEADING_CONTEXT_LINES = 1` / `RANGE_TRAILING_CONTEXT_LINES = 3`。原始读取和多范围读取保持精确；目录列表选择器会切片渲染后的条目，不带上下文。
   - 非原始输出使用 `resolveFileDisplayMode()`:
      - 当编辑模式为 hashline、读取不是原始、源可变且 edit 工具存在时，输出带 hashline 编号
      - 否则在 `readLineNumbers === true` 时输出可选的行号
      - 原始模式会抑制这两种
- hashline 模式下的前缀格式是先有 `[PATH#TAG]` 头部，后跟 `LINE:TEXT`，例如 `[src/foo.ts#0A1B]` 和 `41:def alpha():`，来自会话快照存储外加 `formatNumberedLine()` / `formatHashlineHeader()`。
- `edit`/hashline 路径稍后会消费该头部以及裸行号；四字符十六进制标签是整个规范化文件基于内容得出的哈希，可通过记录它的会话快照存储解析。不可变源和 `:raw` 会有意抑制 hashline 头部。

### 目录列表

- `#readDirectory()` 调用 `buildDirectoryTree()`，参数为：
   - `maxDepth = 2`
   - `perDirLimit = 12`
   - `rootLimit = null`
   - `lineCap = limit`(存在行选择器时)，否则在此层不限
- `buildDirectoryTree()` 按新旧程度对同级项排序，显示文件大小和相对时间，并在树被截断时可能标记 `limits.resultLimit`。
- 空目录渲染为 `(empty directory)`。

### 归档

- 支持的归档容器(`packages/utils/src/ar/registry.ts` 中的扩展名表):tar 家族 `.tar`、`.tar.gz`/`.tgz`、`.tar.bz2`/`.tbz2`/`.tbz`、`.tar.xz`/`.txz`、`.tar.zst`/`.tzst`、`.tar.z`;ZIP 家族 `.zip`、`.jar`、`.war`、`.ear`、`.apk`、`.whl`、`.ipa`、`.xpi`、`.vsix`、`.nupkg`、`.cbz`；独立格式 `.rar`/`.cbr`、`.7z`、`.iso`、`.cab`、`.cpio`、`.rpm`、`.ar`/`.a`/`.lib`、`.deb`、`.lzh`/`.lha`、`.arj`、`.asar`；单流 `.gz`、`.bz2`、`.xz`、`.zst`、`.z`、`.lzma`。
- 语法：`archive.ext`、`archive.ext:path/inside`、`archive.ext:path/inside:50-60`。
- `openArchive()` 通过 `@oh-my-pi/pi-utils/ar` 注册表(`packages/utils/src/ar/open.ts`)分派；限制位于 `packages/utils/src/ar/limits.ts`：内存中的归档上限为 256 MiB，索引读取上限为 64 MiB，单个成员解压上限为 64 MiB。
- 归档路径会规范化 `/`，丢弃 `.` 段，并拒绝 `..`。
- 目录读取列出直接子项；文件显示 `name`，当大小 > 0 时附加 ` (size)`。
- `#readArchiveDirectory()` 中目录列表的默认上限为 `500` 个条目。
- 文件条目按 UTF-8 解码。非 UTF-8 条目返回 `[Cannot read binary archive entry '...' (...)]`，而不是字节。
- 文本归档条目复用常规的内存分页/锚定路径。

### Profiler 报告

- 可识别的 macOS `sample` 调用树文件(`*.sample.txt`)和 V8 `.cpuprofile` JSON 在有效且至多 `32 MiB` 时，会渲染为瓶颈摘要，而不是原始转储。
- 行选择器对渲染出的摘要分页。`:raw` 绕过 profile 渲染，读取原始文件。
- 仅仅具有上述名称/扩展名但不能解析为预期报告的文件，会落到普通文本处理。

### SQLite 数据库

- 数据库检测同时要求扩展名匹配和有效的 SQLite 文件头(`isSqliteFile()`)。
- 来自 `parseSqliteSelector()` 的选择器形式：

#### `db.sqlite`

- `kind: "list"`
- 列出非 `sqlite_%` 表及其行数。
- `#readSqlite()` 通过 `applyListLimit()` 把渲染出的列表限制为 `500` 张表。

#### `db.sqlite:table`

- `kind: "schema"`
- 返回 `sqlite_master.sql` 以及样本行。
- 样本大小为 `DEFAULT_SCHEMA_SAMPLE_LIMIT = 5`。

#### `db.sqlite:table:key`

- `kind: "row"`
- 当表恰好有一个主键列时按主键解析；否则回退到 `rowid` 查找。
- 行查找不允许带查询参数。

#### `db.sqlite:table?limit=...&offset=...&order=...&where=...`

- `kind: "query"`
- 默认值：`limit = 20`,`offset = 0`。
- `limit` 的上限为 `500`。
- `order` 接受 `column` 或 `column:asc|desc`，且必须指定一个存在的列。
- 只有在 `validateWhereClause()` 拒绝注释、分号以及 `LIMIT`、`OFFSET`、`UNION`、`ATTACH`、`PRAGMA` 等控制关键字之后，才会接受 `where`。
- 未知查询参数会抛出错误。

#### `db.sqlite?q=SELECT ...`

- `kind: "raw"`
- 不能与表选择器或任何其他查询参数组合使用。
- 空的 `q` 会抛出错误。
- `executeReadQuery()` 准备 SQL，拒绝绑定参数，并从 `statement.iterate()` 收集行，上限为 `MAX_RAW_QUERY_ROWS = 1000`；它不校验 SQL 是否以 `SELECT` 开头。

- `packages/coding-agent/src/tools/sqlite-reader.ts` 中的渲染上限：
   - ASCII 表宽 `120`(`MAX_RENDER_WIDTH`)
   - 每列宽度 `40`(`MAX_COLUMN_WIDTH`)
- `#readSqlite()` 以 `{ readonly: true, strict: true }` 打开 Bun SQLite，并设置 `PRAGMA busy_timeout = 3000`。

### 文档

- `packages/coding-agent/src/tools/read.ts` 中的 `CONVERTIBLE_EXTENSIONS` 涵盖 `.pdf`、`.doc`、`.docx`、`.ppt`、`.pptx`、`.xls`、`.xlsx`、`.rtf`、`.epub`。
- `convertFileWithMarkit()` 把文件转换为文本/markdown；行范围和 `:raw` 选择器随后作用于转换后的输出(`file.pdf:50-100`、`:5-16,40-80`)。
- 对于 PDF，内嵌图片会以可浏览的句柄形式呈现。markit 为每张内嵌图片生成一个 `<!-- image: <id> (page N, WxHpt) -->` 区域；`read.ts` 会把它改写为 `read <pdf>:<id>.png` 提示(以内联代码形式，因此路径中的空格/括号不会破坏 markdown)。读取该句柄(`doc.pdf:p11-img0.png`)会抽取图片——给 markit 传入落在会话产物缓存中的 `imageDir`(`<artifacts>/pdf-assets/<key>/`，以大小+mtime 为键，每个文件只转换一次)——并通过常规的图片加载路径返回。`doc.pdf:` 列出可抽取的成员；未知成员会报错并给出可用列表。请求的成员会与抽取出的基名匹配，因此 `..`/分隔符无法逃出缓存。
- 转换失败会返回类似 `[Cannot read .pdf file: ...]` 的文本块。

### Jupyter notebook

- 除非请求了 `:raw`,`.ipynb` 会经过 `readEditableNotebookText()`。
- 输出是带有如下标记的可编辑纯文本：

```text
# %% [code] cell:0
...
```

- 原始模式绕过该转换，回退到文件文本读取。

### 图片

- 图片检测基于元数据(`readImageMetadata()`)。
- 接受的最大图片大小为 `20 MiB`(`MAX_IMAGE_INPUT_BYTES`，再导出为 `MAX_IMAGE_SIZE`)。更大的文件会抛出错误。
- `read <image>?q=<question>` 会为解析出的视觉模型加载图片，并把其回答作为一个文本块返回。
- 没有 `?q=` 时，具备图片能力的当前生效模型会收到一条文本说明加一个内联图片块。
- 没有 `?q=` 时，仅支持文本的当前生效模型会收到元数据(MIME、字节数、尺寸、通道数、alpha)以及 `?q=<question>` 提示。
- `images.questionTimeoutMs` 限制每次委派的图片提问；`0` 禁用超时。
- 不支持/无法解码的图片格式会抛出 `ToolError`。

### 内部 URL

- `read` 把内部 scheme 和 MCP 声明的 scheme 委派给 `InternalUrlRouter`；内置注册表目前包括 `agent://`、`artifact://`、`history://`、`issue://`、`local://`、`mcp://`、`memory://`、`omp://`、`pr://`、`rule://`、`security://`、`skill://`、`ssh://`、`vault://` 和 `xd://`。
   - `security://` 保留给 OMP 拥有、生产方中立、只读的安全分析存储。
   - `xd://` 列出已挂载的工具设备；`xd://<name>` 返回该设备的输入文档。向同一 URI 写入 JSON 会通过 `write` 分派该设备。
   - `ssh://host/<path>` 读取远程 UTF-8 文件或目录；裸 `ssh://` 列出已配置的主机。远程路径限制为 1 MiB，且需要 POSIX 远程 shell。路径中的字面 `:`、`?` 或 `#` 需要百分号编码。
   - 启用 `compaction.experimentalContextManagement` 时，`history://current/full` 会暴露调用方完整的当前分支。它包括原始文本、工具输出、条目 ID 和压缩边界。使用共享的行/原始选择器，例如 `history://current/full:raw:1-200`；查询、片段、额外路径和尾部斜杠都会被拒绝。它需要匹配的活跃会话所有者，且永远不会回退到注册表或磁盘查找。裸 `history://current` 仍然指向一个名为 `current` 的普通代理。参见[实验性上下文窗口](../compaction.md#实验性笔记支撑的上下文窗口)。
- `#handleInternalUrl()` 的行为：
   - 用 `parseInternalUrl()` 解析 URL，因此 host 段内的冒号是合法的
   - 对 `agent://`，把非根路径提取或 `?q=` 提取视为特殊的无分页模式
   - 把 `artifact://` 路由到有界的产物文件读取器和大输出工作流提示
   - 否则在内存中对解析出的文本分页
   - 把 `immutable` 透传给 `resolveFileDisplayMode()`，从而对产物、技能、记忆和代理输出等不可变资源抑制锚点
   - 对 `skill://` 设置 `ignoreResultLimits: true`，因此完整的技能文本只由显式选择器分页，而不受常规默认行数上限约束
- `conflict://` 与路由器分开处理。`<path>:conflicts` 登记块；`conflict://<N>` 读取一个已登记的标记块，`/ours`、`/theirs`、`/base` 或 `/both` 选择某一侧。`conflict://*` 只写。
- `issue://<N>` / `pr://<N>`(以及长形式 `issue://<owner>/<repo>/<N>` / `pr://<owner>/<repo>/<N>`)经由 `github` 工具写入的同一个 SQLite 缓存路由；`?comments=0` 选择无评论渲染。裸 `issue://` / `pr://`(以及带仓库限定的变体)使用 `?state=`、`?limit=`、`?author=` 和 `?label=` 浏览实时列表。PR diff 使用 `pr://<N>/diff`、`/diff/<i>` 和 `/diff/all`。每种带仓库限定的形式还接受 GitHub Enterprise 主机前缀(`pr://ghe.example.com/<owner>/<repo>/<N>`)，而不含点的主机(`pr://ghe/<owner>/<repo>/<N>`)在编号形式中会被识别。短形式会从会话检出解析主机，因此企业仓库无需前缀。
- `memory://` 接受两种语法。`memory://root[/path]` 读取项目记忆根下以文件为后备的记忆产物(`memory://root` 解析为紧凑的启动摘要 `memory_summary.md`；更深的路径指向 `MEMORY.md` 和 `skills/<name>/SKILL.md` 等文件，且 `memory://root/...` 支持供 `glob` 使用的 glob 模式)。`memory://<memory-id>` 按 id 查找活跃的 Mnemopi 记忆行——工作记忆或情景记忆——并返回完整存储内容(而非截断的召回预览)，前面带一个 YAML frontmatter 头，包含 `id`、`bank`、`store`、`memory_type`、`source`、`timestamp`/`created_at`、`importance`、`veracity`、`session_id` 和 `metadata`。id 语法针对调用会话解析：它需要该会话处于 `memory.backend = mnemopi`，并且只搜索其自身作用域内的 bank，因此由另一个活跃会话持有的行不可达；使用 `hindsight` 时它会返回一个纠正性指引(hindsight 记忆不可按 id 寻址)，未知 id 会报错并指向 `recall` 以获取可用 id。这是 `memory_edit update` 的读取对应方：在覆盖截断的预览之前先读取完整行。
- `artifact://<id>` 把会话产物解析为纯文本。带选择器分页的读取会以任意大小从后备文件流式读取，但不带边界的 `:raw` 在超过 `50 KiB`(`MAX_ARTIFACT_RAW_INLINE_BYTES`)时被阻止，并给出指向有界范围(`artifact://<id>:1-3000`、`artifact://<id>:raw:1-3000`)和后备文件路径的工作流提示。裸读取/非原始读取会流式读取一个有界的默认页，而不是物化整个产物。其他消费者在协议层面的整资源解析被硬性限制在 8 MiB(`packages/coding-agent/src/internal-urls/artifact-protocol.ts` 中的 `MAX_INLINE_ARTIFACT_BYTES`)；更大的产物会拒绝整资源读取，并给出相同的选择器和后备路径提示。仅路径消费者(搜索/grep、bash URL 展开)跳过内容物化，可处理任意大小的产物。

### Web URL

- `parseReadUrlTarget()` 接受 `http://`、`https://` 或 `www.` 目标。
- 普通 URL 读取调用 `packages/coding-agent/src/tools/fetch.ts` 中的 `executeReadUrl()`。
- `:raw` 表示原始 HTML/正文回退路径；普通 URL 读取优先使用渲染后的/阅读器友好的输出。
- `:N`、`:A-B`、`:A+C` 以及逗号分隔的多范围在缓存输出可用时不会重新抓取。它们对先前或当前 URL 渲染的缓存输出分页。
- `renderUrl()` 中的 URL 渲染流水线：
   1. 规范化 scheme(裸 `www.` 会补上 `https://`)
   2. 除非为原始模式，尝试已知站点的特殊处理器
   3. 用 `loadPage()` 抓取
   4. 如果内容是图片/PDF/DOCX 等，尝试二进制抓取 + markit/图片处理
   5. 直接处理 JSON,feed 经由 feed 解析器，纯文本直接处理
   6. 对 HTML 和非原始模式，依次尝试 markdown 替代品、`URL.md`、内容协商、feed 替代品、HTML 转文本渲染器、抽取出的链接文档，然后是 `llms.txt`
   7. 回退到原始正文 text/html
- URL 输出会包裹一个小头部：

```text
URL: ...
Content-Type: ...
Method: ...
Notes: ...

---
```

- `method` 记录胜出的路径(`json`、`feed`、`text`、`alternate-markdown`、`md-suffix`、`content-negotiation`、`image`、`markit`、`llms.txt`、`raw`、`raw-html` 等)。
- 当抓取的资源是受支持的图片且经过缩放后仍然可用时,URL 读取可能返回一个内联图片块。

## 副作用

- 文件系统
   - 打开并流式读取本地文件。
   - 在索引前把 tar/tgz 归档完整读入内存(256 MiB 上限);ZIP 归档通过带范围的中心目录读取来索引。
   - 可能从会话产物目录读取 URL 缓存产物文件。
   - 当 URL 输出被截断，或行范围分页需要持久化的缓存正文时，写入 URL 输出产物。
- 网络
   - URL 模式会执行 HTTP 抓取、二进制重新抓取和替代端点探测。
- 子进程 / 原生绑定
   - 对 `.db`/`.sqlite*` 使用 Bun SQLite。
   - 通过统一的 `@oh-my-pi/pi-utils/ar` 注册表读取归档;ZIP 在 `packages/utils/src/ar/zip.ts` 中基于 `node:zlib` 的 DEFLATE 编解码器构建。
   - URL HTML 渲染可以委派给 `packages/coding-agent/src/tools/fetch.ts` 中的站点处理器和 HTML 转文本后端。
- 会话状态
   - 把本地文本读取的整文件快照记录到 `session.fileSnapshotStore`，供后续陈旧锚点恢复使用。
   - 对内部 URL，把会话的 `cwd`、`settings` 和 `localProtocolOptions` 传入进程全局的 `InternalUrlRouter.instance().resolve()`。
   - 对缓存/截断的 URL 输出使用 `session.allocateOutputArtifact()`。
- 后台工作 / 取消
   - 只有确定性的磁盘读取是不可中止的：普通文件的行/范围读取(`streamLinesFromFile`、多范围)和目录列表(`#readDirectory`)调用时传入 `undefined` 而不是 `AbortSignal`，因此在读取中途打断不会在本可瞬间完成的读取上冒出误导性的 "Operation aborted"。其他所有分支都会保留信号，其辅助函数会调用 `throwIfAborted(signal)` 以便及时停止:URL/内部 URL 读取(网络)、归档、sqlite、文档转换、图片解码、结构化摘要、冲突扫描以及后缀 glob 路径解析。

## 限制与上限

- 来自 `packages/coding-agent/src/session/streaming-output.ts` 的共享文本截断默认值：
   - `DEFAULT_MAX_LINES = 3000`
   - `DEFAULT_MAX_BYTES = 50 * 1024`
- 本地文本开放式默认行数上限：`read.defaultLimit`(默认 `300`)，限制在 `[1, DEFAULT_MAX_LINES]`。
- 单个有界的非原始文本范围会在受限侧添加 `1` 行前导和 `3` 行尾随上下文。原始读取和多范围读取保持精确。
- 文件流式块大小：`8 * 1024` 字节(`READ_CHUNK_SIZE`)。
- 行读取的本地流式字节预算：`max(DEFAULT_MAX_BYTES, maxLinesToCollect * 512)`。
- 结构化摘要仅在文件大小 `<= 2 MiB` 且行数 `<= 20_000` 时运行。
- Profile 摘要仅对至多 `32 MiB` 的可识别报告运行；`:raw` 会绕过它们。
- 图片输入上限：`20 MiB`。
- 本地目录的目录树上限：深度 `2`，每目录子项 `12`。
- 归档目录默认列表上限：`500` 个条目；归档成员上限 `64 MiB`，tar/tgz 容器上限 `256 MiB`。
- SQLite:
   - 默认行查询上限 `20`
   - schema 样本上限 `5`
   - 最大查询上限 `500`
   - 原始 `?q=` 行上限 `1000`(`MAX_RAW_QUERY_ROWS`)
   - 表列表上限 `500`
   - 渲染宽度 `120`，列宽 `40`
   - busy timeout 为 `3000` ms
- 展示给模型的 URL 读取结果在 `executeReadUrl()` 中被截断为 `300` 行和 `50 KiB`；完整缓存输出可以作为产物附加。
- 内联抓取的 URL 图片：
   - 源字节上限 `20 MiB`
   - 缩放后内联输出上限 `300 KiB`
- 唯一后缀自动解析的 glob 超时：`5000` ms。
- 文件快照存储保存 `256` 个路径，每个路径最多 `4` 个版本(`packages/hashline/src/snapshots.ts` 中的 `DEFAULT_MAX_PATHS` / `DEFAULT_MAX_VERSIONS_PER_PATH`)；超过 `4 MiB`(`SNAPSHOT_MAX_BYTES`)的文件不会被快照。
- 当产物超过 `50 KiB` 时，不带边界的 `artifact://<id>:raw` 读取会被拒绝；请使用有界的 `:raw:N-M` 范围。

## 错误

- 校验失败和运行失败会以 `ToolError` 形式浮现。
- 选择器错误包括：
   - `Line selector 0 is invalid; lines are 1-indexed. Use :1.`
   - 无效的 `A+B` / `A-B` 形状
   - `agent://.../path:50` 的 `Cannot combine query extraction with line selectors`
   - 在目录/归档目录列表上使用多范围
- `conflict://*` 读取会被拒绝；未知/陈旧的冲突 id 需要重新读取 `<path>:conflicts`。
- 缺失的本地/归档/sqlite 路径会先尝试唯一后缀解析；如果没有唯一匹配或带保护的恢复手段，它们会报错。
- 越界行读取不会抛出异常。它们会返回带建议的说明性文本，例如 `Use :1 ...` 或 `Use :<last line> ...`。
- 疑似二进制的本地文件会返回提示，除非请求了 `:raw`。
- 二进制归档条目不会抛出异常；它们返回文本提示。
- 文档转换失败返回文本提示。
- 图片过大/不支持/无效的情况会抛出异常。
- SQLite 解析器会尽早拒绝不支持的参数组合;DB/运行时错误会被捕获，并重新抛出为 `ToolError(message)`。
- 当 HTTP 抓取成功但 `response.ok === false` 时,URL 抓取失败不会抛出异常；它返回一次失败的 URL 读取，`method: "failed"`，并附带说明性备注。
- 大型无边界原始产物读取会返回工作流提示，而不是把产物加载到内存中。

## 备注

- 原始读取和不可变内部资源会抑制 hashline 锚点，因为不存在可供后续 `edit` 消费的可编辑后备目标。
- `splitPathAndSel()` 会有意把未知的尾部 `:...` 当作路径的一部分，以便 `archive.zip:inner/file` 和 `db.sqlite:table:key` 仍然可用。
- `resolveReadPath()` 包含针对截图时间戳、NFD Unicode 规范化和弯撇号的 macOS 专用文件名回退。
- 裸 `/` 解析为会话 cwd，而不是文件系统根目录。
- URL 缓存键是会话作用域的，并按请求的 URL + 原始/渲染模式规范化；请求的 URL 和最终重定向后的 URL 都会被缓存。
- URL 行范围读取会请求 `ensureArtifact: true, preferCached: true`，因此后续的分页读取可以从产物存储重新打开同一份渲染正文。
- 除「不允许绑定参数」之外，原始 SQLite `q=` 执行没有关键字限制;read 工具依赖外围契约来保持其只读。
- 文件快照存储不是读取加速缓存。它用于在文件于读取后发生变化时验证和恢复 hashline 编辑。
