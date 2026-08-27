# grep

> 使用正则表达式在文件、目录、glob 和内部 URL 中进行 grep 搜索。

## Source
- 入口：`packages/coding-agent/src/tools/grep.ts`
- 面向模型的提示词：`packages/coding-agent/src/prompts/tools/grep.md`
- 主要协作者：
  - `packages/coding-agent/src/tools/match-line-format.ts` — 面向模型的 anchor 格式化。
  - `packages/coding-agent/src/tools/path-utils.ts` — 路径规范化、glob 拆分、内部 URL 解析。
  - `packages/coding-agent/src/tools/file-recorder.ts` — 分组输出的文件排序。
  - `packages/coding-agent/src/tools/grouped-file-output.ts` — 按文件分组的文本布局。
  - `packages/coding-agent/src/session/streaming-output.ts` — 行截断和最终字节截断。
  - `packages/coding-agent/src/config/settings-schema.ts` — 默认上下文行数。
  - `packages/natives/native/index.d.ts` — 暴露给 TS 的原生 `grep()` 类型。
  - `crates/pi-natives/src/grep.rs` — 原生正则/文件搜索实现。
  - `docs/natives-text-search-pipeline.md` — 原生搜索流水线概览。

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `pattern` | `string` | Yes | 正则表达式模式。`grep.ts` 会拒绝仅包含空白字符的输入，但会原样保留模式内容。原生匹配器优先尝试 Rust 正则引擎，然后回退到 PCRE2 以支持诸如前瞻/后顾（lookaround）和反向引用等特性，最后对格式错误的花括号/圆括号进行有针对性的字面量恢复。仅当模式包含字面量换行符或两字符序列 `\n` 时才启用多行模式。 |
| `path` | `string` | No | 文件、目录、glob、归档成员、内部 URL、已获取的 URL，或单文件行选择器（例如 `src/foo.ts:50-100`）。使用 `;` 分隔多个根路径。省略或为空时默认为 `.`。已存在且包含分号的路径将保持原样；内部 URL 不能包含 glob 字符。 |
| `case` | `boolean` | No | 大小写敏感搜索。默认为 `true`。传递给原生的 `ignoreCase`，或在虚拟资源上作为 JS `RegExp` 标志使用。 |
| `gitignore` | `boolean` | No | 在目录扫描期间遵循 `.gitignore`。默认为 `true`。 |
| `skip` | `number \| null` | No | 多文件结果的文件分页偏移量。默认为 `0`；有限值会向下取整，负数或非有限值会失败。单文件搜索忽略此参数。 |

`grep` 默认启用（`grep.enabled = true`），属于可发现但非必需的工具。上下文默认值可通过 `grep.contextBefore` 和 `grep.contextAfter` 进行配置。

## Outputs
该工具在 `content[0].text` 中返回单个文本块，并附带结构化的 `details`。

- 匹配行通过 `formatMatchLine()` 格式化为 `*LINE:content`（匹配行）和 ` LINE:content`（上下文行），在 hashline 模式下位于 `[PATH#TAG]` 头部下。
  - Hashline 模式：`[src/login.ts#1F2A]`、`*5:content`、` 9:content`。
  - 普通模式：`*5|content`、` 9|content`。
- 目录和多文件结果通过 `formatGroupedFiles()` 进行分组，呈现为多层、带有前缀折叠的目录树：每个嵌套层对应一个 `#`，目录头部以 `/` 结尾，文件头部在可编辑的 hashline anchor 可用时携带 `#TAG` 后缀。
- `details` 可能包含：
  - `scopePath` — 格式化后的搜索范围。
  - `matchCount`、`fileCount`、`files`、`fileMatches` — 已返回页的计数。
  - `fileLimitReached` — 当前 20 个文件的页之外仍有更多匹配文件。
  - `perFileLimitReached` — 热点文件已被截断至每文件匹配上限。
  - `linesTruncated` — 一条或多条匹配行被截断为 `512` 个字符并附加 `…`。
  - `truncated` 和 `meta.truncation` — 最终文本输出被 `truncateHead()` 从头部截断。
  - `displayContent` — 仅 TUI 渲染的文本，使用 `│` 装订线代替模型 anchor。
  - `missingPaths` — 因基础路径不存在而被跳过的多路径条目。
- 无匹配结果的文本为 `No matches found`（当 `skip` 指向最后一页之后时为 `No more results (...)`），可选地后跟跳过的缺失路径、不可读归档或超大文件的说明。

## Flow
1. `GrepTool.execute()` 在 `packages/coding-agent/src/tools/grep.ts` 中验证和规范化输入：
   - 拒绝仅包含空白字符的模式，但原样保留模式内容；
   - 将省略或为空的 `path` 默认为 `.`，并拆分以分号分隔的根路径，同时保留已包含分隔符的路径；
   - 将 `skip` 规范化为非负整数；
   - 从每个根路径中剥离任何行范围选择器；
   - 从会话设置中读取 `grep.contextBefore` 和 `grep.contextAfter`（默认分别为 `1` 和 `3`）；
   - 仅当 `pattern` 包含 `\n` 或实际换行符时才启用多行模式。
2. 在共享范围解析期间，每个 `path` 根再次通过 `normalizePathLikeInput()` 进行规范化；对于已通过分隔符展开完成规范化的条目，此操作为空操作。
3. 诸如 `bundle.zip:src/foo.ts` 的归档成员路径在原生 grep 之前被物化为临时的 UTF-8 暂存文件。属于二进制或非 UTF-8 的归档成员将被报告为已跳过/不可读。
4. 内部 URL 在文件系统范围解析之前解析：
   - 内部 URL 拒绝 glob 元字符（`*`、`?`、`[`、`{`）；
   - 具有 `sourcePath` 的资源通过其后备文件进行搜索；
   - 没有 `sourcePath` 的资源使用 JavaScript `RegExp` 在内存中搜索；
   - `omp://` 通过 URL 完成展开为每个内嵌的文档文件；
   - 不可变源会被跟踪，以便输出可以按文件抑制可编辑的 hashline 编号输出。
5. 对于多路径调用，`partitionExistingPaths()` 仅跳过 ENOENT 条目。如果每个文件系统条目都缺失且没有剩余的虚拟内部资源，该工具会报错。
6. 路径解析分支：
   - 单个条目：`parseSearchPath()` 拆分 `basePath` 和可选的 glob；
   - 多个条目：`resolveExplicitSearchPaths()`（通过 `resolveToolSearchScope()`）计算公共基础目录、花括号联合 glob、精确文件列表或每条目目标列表。当公共祖先本身不是请求的范围时，或当普通文件条目将被降级为目录遍历的 glob 联合时（`fanOutFileTargets`），目标会扇出。
7. 行范围选择器在路径/归档/内部解析之后进行验证。它们仅允许用于单文件、归档成员或虚拟资源；glob/目录行范围选择器会报错。
8. `grep.ts` 对已解析的基础路径执行 stat 操作以决定是按文件还是目录处理。
9. 它使用以下参数从 `@oh-my-pi/pi-natives` 调用原生 `grep()`：
   - `pattern`、`ignoreCase`、`multiline`、`gitignore`；
   - `hidden: true`；
   - `cache: false`；
   - 从设置中读取的 `contextBefore` / `contextAfter`；
   - `maxColumns: DEFAULT_MAX_COLUMN`（`512`）；
   - `maxCount: INTERNAL_TOTAL_CAP`（`2000`）；
   - `maxCountPerFile`：每文件匹配上限加一；
   - `mode: content`；
   - 组合的 abort `signal` 和 `timeoutMs: SEARCH_GREP_TIMEOUT_MS`（`30_000`）。
10. 原生执行在 `crates/pi-natives/src/grep.rs` 中完成：
    - `build_matcher()` 对非量词花括号进行转义，并优先尝试 Rust 正则引擎；
    - 对于 Rust 正则不支持的模式（包括前瞻/后顾和反向引用），回退到 PCRE2；
    - 组平衡错误时回退为字面量圆括号；如果两个引擎仍然拒绝该模式，则按字面量搜索原始模式。
11. Grep 调度因已解析的路径集合而异：
    - 精确的显式文件或扇出的多目标：JS 循环遍历目标，自己合并 `grep()` 结果，并通过绝对路径 + 行号对重叠目标进行去重；
    - 单文件/目录基础：一次 `grep()` 调用处理原生扫描。
12. 虚拟内部资源在 JS 中使用 `RegExp` 搜索；归档暂存路径和虚拟路径在渲染之前被重新映射回面向用户的选择器。
13. JS 输出整形随后进行：
    - 将多文件输出限制为每页 20 个文件（`DEFAULT_FILE_LIMIT`），使用 `skip` 作为下一个文件偏移量；
    - 将每文件匹配限制为多文件范围 20 个、单文件范围 200 个；
    - 对所选每文件匹配进行轮询调度，以避免单个文件独占整页；
    - 通过 `formatMatchLine()` 为模型格式化行，并通过 `formatCodeFrameLine()` 为 TUI 格式化行；
    - 在 hashline 模式下，通过 `recordFileSnapshot()` 为每个已渲染文件记录整文件快照以生成 `#TAG` anchor（归档、虚拟和不可变路径会被跳过）。
14. 最终文本通过 `truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER })` 进行处理，因此有效上限来自 `streaming-output.ts` 的默认字节上限，而不是默认行上限。
15. `toolResult()` 附加文本以及限制/截断元数据。

## Modes / Variants
1. **单文件路径**
   - `grep()` 搜索单个文件。
   - 输出为匹配/上下文行的扁平列表。
   - 可见上限是原生匹配和 JS 每文件截断之后的前 `200` 个匹配。
2. **单目录路径或单 glob 形式路径**
   - `parseSearchPath()` 可能将输入拆分为 `path` + `glob`。
   - 一次原生 `grep()` 调用使用 `gitignore` 和 `hidden:true` 扫描目录树。
   - 结果被分组到 20 个文件的页中；使用 `skip` 与限制消息中显示的下一个文件偏移量配合。
   - JS 对所选文件的匹配进行轮询调度。
3. **多个显式路径/glob**
   - `resolveExplicitSearchPaths()` 将它们折叠为公共基础以及花括号联合 glob、显式文件列表，或当公共祖先本身不是请求的范围时（或者当普通文件条目将被降级为目录遍历时）按目标搜索。
   - 缺失的条目以非致命方式跳过，除非所有条目都缺失。
4. **归档成员路径**
   - 仅支持 UTF-8 文本条目。成员被提取到临时暂存文件以进行原生 grep，然后显示为 `archive.ext:member`。
5. **内部 URL 路径**
   - 由文件系统支持的资源搜索其解析后的 `sourcePath`。
   - 没有 `sourcePath` 的虚拟资源在内存中搜索其解析后的内容。
   - `omp://` 展开为所有内嵌的文档文件，因此可作为文档搜索根使用。
   - 内部 URL 不支持 glob。
   - 不可变和虚拟源会抑制可编辑的 hashline anchor。

## Side Effects
- 文件系统
  - 对已解析的搜索根和输入路径执行 stat。
  - 通过原生 `grep()` 读取匹配的文件。
  - 通过 `recordFileSnapshot()` 将整文件快照记录到会话文件快照存储中，以供 hashline anchor 使用。
- 会话状态（记录、内存、作业、检查点、注册表）
  - 读取会话设置以获取上下文默认值。
  - 使用 `session.internalRouter` 解析内部 URL。
  - 在工具的 `details.meta` 中填充截断/限制元数据。
- 后台工作 / 取消
  - 在 JS 层通过 `untilAborted(signal, ...)` 包装。
  - `grep.ts` 将 abort `signal` 和 `timeoutMs: SEARCH_GREP_TIMEOUT_MS`（`30_000`）传递给原生 `grep()`，因此原生扫描可取消且有超时限制。

## Limits & Caps
- 文件分页限制：每页 `20` 个文件（`packages/coding-agent/src/tools/grep.ts` 中的 `DEFAULT_FILE_LIMIT`）。
- 每文件匹配上限：多文件范围 `20`（`MULTI_FILE_PER_FILE_MATCHES`），单文件范围 `200`（`SINGLE_FILE_MATCHES`）。
- 原生/JS 预选上限：`2000` 个匹配（`INTERNAL_TOTAL_CAP`）。
- 行截断：每行 `512` 个字符（`packages/coding-agent/src/session/streaming-output.ts` 中的 `DEFAULT_MAX_COLUMN`）。原生 grep 会标记被截断的行；JS 上报 `linesTruncated`。
- 最终文本截断：`truncateHead()` 默认字节上限为 `50 * 1024` 字节（`packages/coding-agent/src/session/streaming-output.ts` 中的 `DEFAULT_MAX_BYTES`）。`grep.ts` 将 `maxLines` 覆盖为 `Number.MAX_SAFE_INTEGER`，因此普通 grep 输出受字节限制，而非行数限制。
- 上下文默认值：`packages/coding-agent/src/config/settings-schema.ts` 中 `grep.contextBefore = 1`，`grep.contextAfter = 3`。
- 分页：`skip` 是多文件范围的文件分页偏移量。当还有更多文件时，结果文本会显示 `Use skip=<N> for the next page`。
- 原生目录扫描缓存：在 `grep.rs` 中可用，但本工具始终设置 `cache: false`。
- 原生 grep 时钟预算：每次调用 `30_000ms`（`packages/coding-agent/src/tools/grep.ts` 中的 `SEARCH_GREP_TIMEOUT_MS`）；达到此限制会抛出 `Grep timed out after 30s; ...`。
- 原生每文件大小上限：`4 * 1024 * 1024` 字节（`crates/pi-natives/src/grep.rs` 中的 `MAX_FILE_BYTES`，在 `grep.ts` 中镜像为 `NATIVE_GREP_MAX_FILE_BYTES`）。超大文件系统文件被跳过并以部分覆盖形式呈现（显式文件给出名称，目录扫描给出数量）。超大虚拟资源以行为边界分块进行搜索（行模式）；多行虚拟搜索回退到 JavaScript 正则。

## Errors
- 当修剪后的 `pattern` 为空时：`Pattern must not be empty`。
- 对于负数或非有限的 `skip`：`Skip must be a non-negative number`。
- 当规范化的根为空时：`` `path` must contain non-empty paths or globs ``。
- 对于内部 URL + glob 元字符：`Glob patterns are not supported for internal URLs: ...`。
- 行范围选择器错误包括 `Line-range selector requires a single file, not a glob: ...`、`Line-range selector requires a single file: ... is a directory` 以及 `Path not found for line-range selector: ...`。
- 当所有归档选择器均不可读、属于二进制或非 UTF-8 时：`Cannot search archive member(s): ...`。
- 当文件系统支持的已解析基础路径缺失，或每个多根文件系统条目都缺失时（当不可读的归档成员造成影响时附带归档提示）：`Path not found: ...; list each target in the semicolon-delimited \`path\``。
- 虚拟资源的 JavaScript 正则编译可能报告 `Invalid regex: ...`。文件系统支持的原生搜索通常从 Rust 正则回退到 PCRE2，最后回退到字面量模式，而不是拒绝正则语法。
- 多文件原生扫描在 `grep.rs` 内部跳过每文件的打开/搜索失败；扫描会继续处理剩余文件。
- 当原生 grep 达到 `SEARCH_GREP_TIMEOUT_MS` 时：``Grep timed out after 30s; narrow paths or pattern, or scope with `glob` first``。

## Notes
- 文件系统支持的搜索优先使用 Rust 正则，当模式需要前瞻或反向引用等特性时回退到 PCRE2。虚拟内存资源使用 JavaScript `RegExp`。
- 原生 `build_matcher()` 会自动转义不能作为有效量词的花括号。诸如 `a{2,4}` 的有效量词保持为正则语法。
- 如果 Rust 正则和 PCRE2 都拒绝组语法，原生编译会在转义未转义的圆括号之后重试，最后将原始模式按字面量处理。
- 内部 URL 在路径存在性检查之前解析。有后备资源的 URL 变为普通文件系统路径；虚拟资源保留在内存中，并且不会生成可编辑的 hashline anchor。
- `hidden:true` 在 `grep.ts` 中硬编码；没有面向模型的标志可排除点文件。
- `gitignore:false` 仅影响原生目录遍历。它不会禁用工具自身的路径规范化或显式文件处理。
- 当 `path` 解析为多个精确文件时，每个目标在 JS 分组之前都使用 `2000` 内部上限。
- Hashline 模式中的 section tag 是来自会话快照存储的四位十六进制不透明快照 tag；`grep` 在可能的情况下记录整文件快照，并在头部下方打印裸行号。
