# 原生文本/搜索流水线

本文档将 `@oh-my-pi/pi-natives` 的文本/搜索/代码接口面，从生成的 JS/TS 导出映射到底层 Rust N-API 模块，再映射回 JS 结果对象。

术语定义遵循 `docs/natives-architecture.md`：

- **Generated binding（生成的绑定）**：`packages/natives/native/index.d.ts` 中的公共 API。
- **Rust module layer（Rust 模块层）**：`crates/pi-natives/src/*` 中的 N-API 导出。
- **Shared scan cache（共享扫描缓存）**：发现流程使用的、可选的 `pi-walker` 目录条目缓存。

## 实现文件

- `packages/natives/native/index.d.ts`
- `crates/pi-natives/src/grep.rs`
- `crates/pi-natives/src/glob.rs`
- `crates/pi-natives/src/glob_util.rs`
- `crates/pi-natives/src/iofs.rs`
- `crates/pi-walker/src/lib.rs`
- `crates/pi-walker/src/cache.rs`
- `crates/pi-natives/src/ast.rs`
- `crates/pi-natives/src/text.rs`
- `crates/pi-natives/src/highlight.rs`
- `crates/pi-natives/src/tokens.rs`

## JS API ↔ Rust 导出映射

| JS API                                                                          | Rust export (`#[napi]`, snake_case -> camelCase) | Rust module    |
| ------------------------------------------------------------------------------- | ------------------------------------------------ | -------------- |
| `grep(options, onMatch?)`                                                       | `grep`                                           | `grep.rs`      |
| `search(content, options)`                                                      | `search`                                         | `grep.rs`      |
| `hasMatch(content, pattern, ignoreCase?, multiline?)`                           | `hasMatch`                                       | `grep.rs`      |
| `fuzzyFind(options)`                                                            | `fuzzyFind`                                      | `fd.rs`        |
| `glob(options, onMatch?)`                                                       | `glob`                                           | `glob.rs`      |
| `invalidateFsScanCache(path?)`                                                  | `invalidateFsScanCache`                          | `iofs.rs`      |
| `astGrep(options)`                                                              | `astGrep`                                        | `ast.rs`       |
| `astMatch(options)`                                                             | `astMatch`                                       | `ast.rs`       |
| `astEdit(options)`                                                              | `astEdit`                                        | `ast.rs`       |
| `wrapTextWithAnsi(text, width, tabWidth)`                                       | `wrapTextWithAnsi`                               | `text.rs`      |
| `truncateToWidth(text, maxWidth, ellipsis, pad, tabWidth)`                      | `truncateToWidth`                                | `text.rs`      |
| `sliceWithWidth(line, startCol, length, strict, tabWidth)`                      | `sliceWithWidth`                                 | `text.rs`      |
| `extractSegments(line, beforeEnd, afterStart, afterLen, strictAfter, tabWidth)` | `extractSegments`                                | `text.rs`      |
| `visibleWidth(text, tabWidth)`                                                  | `visibleWidth`                                   | `text.rs`      |
| `setHangulCompatJamoWidthOverride(value)`                                       | `setHangulCompatJamoWidthOverride`               | `text.rs`      |
| `highlightCode(code, lang, colors)`                                             | `highlightCode`                                  | `highlight.rs` |
| `supportsLanguage(lang)`                                                        | `supportsLanguage`                               | `highlight.rs` |
| `getSupportedLanguages()`                                                       | `getSupportedLanguages`                          | `highlight.rs` |
| `countTokens(input, encoding?)`                                                 | `countTokens`                                    | `tokens.rs`    |

## 按子系统划分的流水线概览

## 1) 正则搜索（`grep`、`search`、`hasMatch`）

### 输入/选项流程

1. 调用方直接调用生成的原生导出；这里没有把 `search` 改名为 `searchContent` 的包级 TS 包装。
2. `grep.rs` 中的 Rust 选项结构体反序列化驼峰命名字段，包括 `ignoreCase`、`maxCount`、`maxCountPerFile`、`contextBefore`、`contextAfter`、`maxColumns` 和 `timeoutMs`。
3. `grep` 根据 `timeoutMs` 与 `AbortSignal` 创建 `CancelToken`，并在 `task::blocking("grep", ...)` 中执行。文件系统版 grep 不暴露也不使用共享 walker 缓存。
4. `search` 和 `hasMatch` 在给定的字符串/`Uint8Array` 内容上运行，不会扫描文件系统。

### 执行分支

- **内存分支**
  - `search` -> 在给定内容字节上执行 `search_sync`/search 辅助函数。
  - `hasMatch` 针对给定内容编译并检查模式，返回布尔值。
  - 不进行文件系统扫描，不使用 walker 缓存。
- **单文件分支**
  - `grep` 解析路径，检查元数据是否为文件，然后在该文件中搜索。
- **目录分支**
  - 候选项发现使用 `pi-walker`，但不使用扫描缓存。
  - Walker 策略应用隐藏文件/gitignore 设置，并跳过可跳过的目录错误。
  - 条目过滤：仅文件 + 可选的 glob 过滤（`glob_util`）+ 可选的类型过滤映射（`js`、`ts`、`rust` 等）。

### 搜索/收集语义

- 匹配器选择：优先尝试 Rust 正则引擎，对于环视/反向引用等特性回退到 PCRE2。`OMP_PCRE2_JIT=0`/`false` 禁用 PCRE2 JIT，`1` 启用；未设置时除 macOS 外默认启用 JIT。
- 上下文解析：
  - `contextBefore/contextAfter` 覆盖旧的 `context`。
  - 非内容模式不收集上下文。
- 输出模式：
  - `content` -> 每个命中一个 `GrepMatch`。
  - `count` 和 `filesWithMatches` 映射为计数类条目（`lineNumber=0`，`line=""`，设置 `matchCount`）。
  - `offset` 和 `maxCount` 在对已排序的文件结果进行聚合时应用；`maxCountPerFile` 可额外防止单个热点文件耗尽内容模式配额。
  - 目录搜索使用并行的文件系统遍历/搜索，然后聚合每个文件的结果以保持全局 offset/limit 语义。较小且有序的回调流可提前停止；较大的流使用有界的有序窗口。

### 结果回到 JS 的整形

- Rust 的 `SearchResult`/`GrepResult` 字段通过 N-API 对象转换映射到 TS 接口。
- 计数器在跨 N-API 边界时按需进行截断处理。
- `GrepResult.limitReached` 是可选的，仅在为 true 时输出；`skippedOversized` 报告被 4 MiB 限制跳过的文件。
- 流式回调接收每个整形后的内容或计数类 `GrepMatch` 条目。

### 失败行为

- `search` 在正则/搜索失败时返回 `SearchResult.error`，而不是抛出异常。
- `grep` 在出现无效路径或超时/中止取消等硬错误时执行 reject。被两个正则引擎同时拒绝的模式会回退为字面量搜索，而不是产生正则错误。
- `hasMatch` 成功时返回布尔值；匹配器构造使用同样的容错回退。
- 多文件扫描中的不可读/非常规文件会被跳过；超大文件计入 `skippedOversized`。

### 格式错误的正则处理

`grep.rs` 在正则编译之前对大括号进行清理：

- 当无法构成 `{N}`、`{N,}`、`{N,M}` 时，类重复计数的非法大括号会被转义（`{`/`}` -> `\{`/`\}`）。
- 这可以避免常见的字面量模板片段（例如 `${platform}`）被当作格式错误的重复计数而失败。
- 对于未闭合/未开起的组导致的编译失败，会进行一次有针对性的重试，对未转义的圆括号进行转义，同时保留正则的其余部分。
- 如果两个引擎仍然拒绝该模式，则将整个原始模式转义为字面量进行搜索。

## 2) 文件发现（`glob`）与模糊路径搜索（`fuzzyFind`）

`glob` 和 `fuzzyFind` 共享可选的 `pi-walker` 扫描缓存；匹配逻辑不同。两个 API 的缓存使用默认都是 `false`。

### `glob` 流程

1. 调用方直接传入 `GlobOptions`。在生成的类型中 `pattern` 和 `path` 是必需的。
2. Rust 解析搜索路径，并通过 `glob_util::compile_glob` 编译 pattern。
3. 条目来源：
   - `cache=true` -> 共享 walker 缓存 + 可选的 stale-empty 重扫。
   - `cache=false` -> 全新扫描，既不读取也不更新缓存。
4. 过滤：
   - 始终跳过 `.git`；
   - 除非显式请求（`includeNodeModules`）或 pattern 中出现 `node_modules`，否则跳过 `node_modules`；
   - 应用 glob 匹配；
   - 应用文件类型过滤；符号链接的 `file`/`dir` 过滤器解析目标元数据。
5. 在按 `maxResults` 截断之前，可选地按 mtime 降序排序（`sortByMtime`）。

### `fuzzyFind` 流程

1. Rust 实现位于 `fd.rs`；生成的导出为 `fuzzyFind`。
2. 与 `glob` 共享 `pi-walker` 扫描源、相同的选择性缓存以及 stale-empty 重检策略。
3. 评分：
   - exact / starts-with / contains / 基于子序列的模糊评分；
   - 分隔符/标点归一化后的评分路径；
   - 目录加分与确定性平局打破（先 `score desc`，再 `path asc`）。
4. 模糊结果中会排除符号链接条目。

### 失败行为

- 非法的 glob pattern 会从 `glob_util::compile_glob` 返回错误。
- 对于目录发现流程，搜索根必须解析为已存在的目录。
- 取消/超时通过调用方提供的 walker 心跳和结果处理检查，作为中止错误向上传播。

### 格式错误的 glob 处理

`glob_util::build_glob_pattern` 是容错的：

- 将 `\` 规范化为 `/`，
- 当 `recursive=true` 时，为简单递归 pattern 自动添加 `**/` 前缀，
- 在编译前自动闭合未配平的 `{...` 分组。

## 3) AST 搜索/匹配/编辑（`astGrep`、`astMatch`、`astEdit`）

`ast.rs` 暴露了语法感知的代码搜索与改写操作。

- `astGrep(options)` 返回带字节/行/列坐标的匹配，以及可选的元变量绑定。
- `astMatch(options)` 对内存中的 `source` 字符串（而不是文件）运行相同的 pattern；`lang` 是必需的（没有路径可推断），结果保留 matches、`totalMatches`、`limitReached` 和 parse errors，但省略文件计数字段。
- `astEdit(options)` 返回替换改动、每个文件的计数、已搜索/已触及的文件计数、parse errors，以及是否已应用编辑。
- 在生成的文档中，编辑选项的 `dryRun` 默认为 true。
- 选项包括语言覆盖、path/glob/selector、严格度、限制、parse error 策略、`signal` 和 `timeoutMs`。
- 对于 `astGrep` 和 `astEdit`，当 `path` 是目录时使用共享缓存进行候选项发现，并按配置进行 stale-empty 重检；当 `path` 直接指向文件时，则返回该文件，不进行遍历或访问缓存。`astMatch` 始终在内存中执行。

这些导出是供工具直接使用的原生 API，不会被 `packages/natives` 中的 TS 包装所中介。

## 4) 共享扫描/缓存生命周期（`pi-walker`）

`pi-walker` 负责遍历和缓存策略。`crates/pi-natives/src/iofs.rs` 仅包含面向 JavaScript 的 DTO 转换、错误映射以及失效导出。

缓存按规范化相对条目（`path`、`fileType`、可选的 `mtime` 与常规文件的 `size`）存储，键由规范化后的搜索根加上生效的遍历级 `WalkOptions` 组成：隐藏/gitignore 与目录剪枝策略、链接跟随、元数据细节、遍历顺序/深度、根目录输出、目录错误处理、文件系统边界以及缓存模式。`WalkFilter` 谓词、排序与结果限制在收集之后运行，并不独立划分缓存，因此具有不同 glob、文件类型、size 阈值或限制值的请求可以共享同一条目。需要额外元数据的过滤或排序仍可能提升生效的细节策略，从而选择不同的键。

配置从环境中读取一次：

- `FS_SCAN_CACHE_TTL_MS`：缓存 TTL，默认 `1000`。
- `FS_SCAN_EMPTY_RECHECK_MS`：缓存为空的重检年龄阈值，默认 `200`。
- `FS_SCAN_CACHE_MAX_ENTRIES`：缓存映射中的最大条目数，默认 `16`。
- `PI_WALK_WORKERS`：walker 的 Rayon 线程池大小，默认 `4`。

### 缓存状态转换

1. **禁用 / 未命中 / 已过期**
   - 禁用的请求在不读取或不更新缓存的情况下直接收集新数据；
   - 启用的未命中以及达到或超过 TTL 的条目收集新数据并填充缓存。
2. **命中**
   - 早于 TTL 的条目返回缓存的条目与缓存年龄。
3. **Stale-empty 重检**
   - 当调用方启用配置的重检时，达到或超过阈值的空缓存查询会再扫描一次。
4. **失效**
   - `invalidateFsScanCache()` 清除所有键；
   - `invalidateFsScanCache(path)` 移除包含该路径的缓存根。

缓存优先考虑低延迟的重复扫描，而非即时一致性。显式失效是在写入、编辑、重命名或删除之后保持正确性的钩子。

## 5) ANSI 文本工具（`text`）

这些是纯内存工具。

### 边界与职责

- `text.rs` 负责终端单元格的语义：
  - ANSI 转义序列解析，
  - 感知字素簇的宽度与切片，
  - wrap/truncate/slice 行为，
  - 在宽度敏感 API 上显式提供 tab 宽度参数。
- `grep.rs` 中的行截断（`maxColumns`）是独立的：
  - 对匹配行进行简单的字符边界截断并附加 `...`，
  - 不保留 ANSI 状态，也不感知终端单元格宽度。

### 关键行为

- `wrapTextWithAnsi`：按可见宽度换行，在换行之间保持活动 SGR 代码。
- `truncateToWidth`：按可见单元截断，附带省略策略（`Unicode`、`Ascii`、`Omit`）以及可选的右侧填充。
- `sliceWithWidth`：按列切片，可选择是否严格执行宽度。
- `extractSegments`：围绕覆盖区域提取 before/after 段，并为 `after` 段恢复 ANSI 状态。
- `setHangulCompatJamoWidthOverride(value)` 控制 U+3131–U+318E 的宽度修正，以兼容客户端终端：`0` 使用平台回退，`1` 强制一个单元格，`2` 强制两个，`3` 遵循 Unicode 宽度。
- `visibleWidth`：使用调用方提供的 tab 宽度计算可见的终端单元格数。

### 失败行为

文本函数通常返回确定性的转换结果；错误仅限于 N-API 参数/字符串转换边界处。

## 6) 语法高亮（`highlight`）

`highlight.rs` 是纯转换模块；它不使用文件系统扫描缓存。

### 流程

1. 调用方传入 `code`、可选的 `lang` 以及 ANSI 调色板。
2. Rust 通过 token/name 查找、扩展名查找、别名表回退，然后回退为纯文本语法来解析语法。
3. 使用 syntect 的 `ParseState` 与作用域栈逐行解析。
4. 作用域映射到语义颜色类别，并注入/重置 ANSI 颜色码。

### 失败行为

- 单行解析失败不会导致整个调用失败：该行会以未高亮的形式追加，处理继续。
- 未知/不支持的语言回退为纯文本语法。

## 7) Token 计数（`tokens`）

`countTokens(input, encoding?)` 是一个内存工具。

- `input` 可以是单个字符串或字符串数组。
- 数组返回聚合后的总计数，并在 Rust 中并行编码。
- 默认编码是 `O200kBase`；同时提供 `Cl100kBase`。
- 该实现使用普通分词，不处理特殊 token。

## 纯工具与依赖文件系统的流程

| Flow                         | Filesystem access | Shared cache              | Notes                                                                |
| ---------------------------- | ----------------- | ------------------------- | -------------------------------------------------------------------- |
| `search` / `hasMatch`        | No                | No                        | regex on provided bytes/string only                                  |
| `text` module functions      | No                | No                        | ANSI/width utilities only                                            |
| `highlight` module functions | No                | No                        | syntax + ANSI coloring only                                          |
| `countTokens`                | No                | No                        | tokenization only                                                    |
| `astMatch`                   | No                | No                        | in-memory syntax-aware match (no disk)                               |
| `astGrep` / `astEdit`        | Yes               | Yes (directory discovery) | directory paths use cached traversal; a direct file path bypasses it |
| `glob`                       | Yes               | Optional                  | directory scans + glob filtering                                     |
| `fuzzyFind`                  | Yes               | Optional                  | directory scans + fuzzy scoring                                      |
| `grep` (file/dir path)       | Yes               | No                        | walker discovery + regex search, optional filters/callback           |

## 端到端生命周期总结

1. 调用方使用类型化选项调用生成的原生导出。
2. Rust 验证/规范化选项，并构建匹配器/搜索配置。
3. 对于文件系统流程，先扫描条目（按需进行缓存命中/未命中/重扫），再进行过滤/打分/搜索。
4. 工作循环会定期调用取消心跳；超时/中止可以终止执行。
5. Rust 将输出整形为 N-API 对象（`lineNumber`、`matchCount`、`limitReached` 等）。
6. 生成的绑定返回类型化的 JS 对象，以及 `grep`/`glob` 的可选逐匹配回调。
