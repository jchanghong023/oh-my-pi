# glob

> 通过 glob 查找文件系统路径；当需要按内容匹配而非按路径匹配时，请使用 `grep`。

## 源码
- 入口：`packages/coding-agent/src/tools/glob.ts`
- 面向模型的提示词：`packages/coding-agent/src/prompts/tools/glob.md`
- 关键协作者：
  - `packages/coding-agent/src/tools/path-utils.ts` — 规范化输入；拆分基础路径与 glob。
  - `packages/coding-agent/src/tools/list-limit.ts` — 应用结果数量上限。
  - `packages/coding-agent/src/session/streaming-output.ts` — 在字节上限处截断文本输出。
  - `packages/coding-agent/src/tools/tool-result.ts` — 构建 `content` 与 `details.meta`。
  - `packages/coding-agent/src/tools/output-meta.ts` — 编码 limit / 截断元数据。
  - `packages/coding-agent/src/tools/tool-errors.ts` — 映射面向用户的工具错误。
  - `packages/coding-agent/src/tools/index.ts` — 注册内置本地实现。

## 输入

| 字段 | 类型 | 必填 | 描述 |
| --- | --- | --- | --- |
| `path` | `string` | 否 | Glob、文件、目录或由路径支持的内部 URL——也可以是其中若干项组成的分号分隔列表（`"src/**/*.ts; test/**/*.ts"`）；省略或为空时默认为 `.`。空条目会被拒绝。分号分隔的列表无条件拆分；被逗号或空白意外连接的条目仅在通过存在性校验后才展开；包含分隔符的既有路径保持字面值。每个目标都成为各自的遍历根，多目标扫描会并发运行。仅 `memory://` 支持内部 URL 的 glob 模式；`ssh://` 会被拒绝，因为它没有本地后备路径。 |
| `hidden` | `boolean` | 否 | 包含隐藏文件。默认为 `true`。 |
| `gitignore` | `boolean` | 否 | 在本地原生 glob 期间遵循 `.gitignore`。默认为 `true`；设为 `false` 可包含被 gitignore 排除的文件。 |
| `limit` | `number` | 否 | 返回路径的最大数量。默认为 `200`；有限的正数输入会先向下取整，然后被限制到 `1..200`。 |

`glob` 默认启用（`glob.enabled = true`），是必备工具。

## 输出
该工具返回单个文本块以及结构化的 `details`。

- 成功文本：匹配路径被分组为多级、前缀折叠的目录树（`formatGroupedPaths()`）：每一层嵌套对应一个 `#`，单子目录链折叠为一个标题（`# a/b/c/`），文件以裸名形式列在最深的所属标题之下；根层级的匹配项不带头部标题列出。目录匹配项带有尾部 `/`。精确文件输入会把该文件路径作为一行返回。
- 空结果文本：`No files found matching pattern`，其后可选地跟随超时或路径缺失提示。
- 多路径部分缺失：在结果块之后、或空结果行之后追加 `Skipped missing paths: ...`。
- `details` 可能包含：
  - `scopePath`：被搜索根或合并根的显示形式。
  - `fileCount`：结果数量限制之后返回的路径数。
  - `files`：以数组形式返回的路径。
  - `truncated`：是否发生了结果数量截断或字节截断。
  - `resultLimitReached`：达到了结果上限。
  - `missingPaths`：多路径调用中被跳过的缺失输入。
  - `truncation` / `meta.limits`：供渲染器使用的结构化截断与上限元数据。
- 流式：当运行时提供 `onUpdate` 时，本地实现在 glob 期间发出增量的、以换行分隔的文本快照，节流为 200 ms。最终输出是分组的；流式快照不是。

## 流程

1. `GlobTool.execute()` 将可选的分号分隔 `path` 字符串转换为根（默认 `.`）。除非注入了自定义操作，它会用 `expandDelimitedPathEntries(..., parseFindPattern)` 展开这些根：包含分隔符的既有路径保持完整，分号分隔的列表无条件拆分，逗号拆分在至少一个部分能解析时才被接受，空白拆分仅在每个部分都能解析时进行。
2. 该工具用 `normalizePathLikeInput()` 与 `/\\/g -> "/"` 规范化每个条目。规范化后为空的条目会以 `` `path` must contain non-empty globs or paths `` 失败。
3. 对于多路径本地调用，`partitionExistingPaths(..., parseFindPattern)`（`packages/coding-agent/src/tools/path-utils.ts`）对每个基础路径执行 stat。缺失条目会被跳过；若全部缺失，该工具抛出 `Path not found: ...`。单个缺失路径仍会硬失败。
4. 对于多条目调用，该工具调用 `resolveExplicitFindPatterns()`；它把每个条目解析成各自的 `(basePath, globPattern, hasGlob)` 目标，因此每条路径都作为自己的根被遍历（折叠到共享祖先会扫描无关的兄弟目录）。单条目调用直接用 `parseFindPattern()` 解析。
5. `parseFindPattern()` 确定 `(basePath, globPattern, hasGlob)`：
   - 没有 glob 字符（`*`、`?`、`[`、`{`）=> 以隐式 `**/*` 搜索该路径。
   - glob 位于第一段 => 从 `.` 开始搜索；除非模式已经以 `**/` 开头，否则为它加上 `**/` 前缀。
   - glob 位于路径中更靠后的位置 => 在第一个含 glob 的段处拆分。
6. `resolveToCwd()` 把基础路径转换为会话 cwd 下的绝对路径。解析结果为 `/` 时会被拒绝，并给出 `Searching from root directory '/' is not allowed`。
7. `limit` 默认为 `DEFAULT_LIMIT`（`200`），必须为正且有限，会先向下取整，然后被限制到 `MAX_LIMIT`（`200`）。`hidden` 与 `gitignore` 均默认为 `true`。内部超时为 `5` 秒（`5000` ms），通过 `AbortSignal.timeout(...)` 构建。
8. 执行随后分叉：
   - **自定义操作分支**：如果 `GlobToolOptions.operations.glob` 存在，该工具用 `operations.exists()` 检查存在性；在可用时通过 `operations.stat()` 对精确文件输入短路；然后调用 `operations.glob(globPattern, searchPath, { ignore: ["**/node_modules/**", "**/.git/**"], limit })`。
   - **内置本地分支**：该工具对每个目标的 `searchPath` 执行 stat。精确文件输入立即返回。目录输入以 `hidden`、`maxResults: effectiveLimit`、`sortByMtime: true`、`gitignore: useGitignore`、`recursive: false`（递归来自 `parseFindPattern()` 添加的 `**/` 前缀）以及合并后的中止信号调用 `natives.glob()`；多目标调用会并发运行各自的 glob。
9. 在本地分支中，可选的 `onMatch` 回调会把每个匹配项转换为相对于 cwd 的显示路径，并发出节流的进度更新。
10. 原生 glob 返回后，JS 合并各目标的结果，对重复的显示路径去重，并在格式化路径之前按 `mtime` 降序对合并后的列表排序。
11. `buildResult()` 应用 `applyListLimit()` 把数组再次限制到 `effectiveLimit`，用 `formatGroupedPaths()`（来自 `@oh-my-pi/pi-utils`）格式化路径，追加提示信息，然后以 `maxLines: Number.MAX_SAFE_INTEGER` 运行 `truncateHead()`。实践中这会保留 50 KB 的字节上限，同时禁用默认的 3000 行上限。
12. `toolResult()` 打包文本与 `details`，并为渲染器记录结果上限 / 截断元数据。

## 模式 / 变体
- **精确文件路径**：如果解析后的输入不含 glob，且解析出的路径 stat 为文件，输出就是那一个路径。
- **目录路径**：如果解析后的输入不含 glob 且 stat 为目录，该工具以隐式 `**/*` 搜索它。
- **单个 glob 路径**：一个由 `parseFindPattern()` 解析的输入。
- **多路径搜索**：多个输入由 `resolveExplicitFindPatterns()` 解析为逐条目目标，每个目标作为自己的根并发遍历，随后合并。
- **带缺失输入的部分多路径搜索**：本地多路径调用会跳过缺失的基础路径，并以 `missingPaths` / `Skipped missing paths: ...` 呈现它们。
- **内部 URL 输入**：支持精确的、由路径支持的 URL。`memory://` 还额外支持针对其后备树的 glob 模式。其他内部 URL glob 以及每一个 `ssh://` 输入都会被拒绝。
- **自定义委托搜索**：使用注入的 `GlobOperations`，而不是本地 fs + 原生 glob。

## 副作用
- 文件系统
  - 对解析后的基础路径执行 stat；在本地多路径模式下会预先对每个候选基础路径执行 stat。
  - 不写入文件。
- 子进程 / 原生绑定
  - 内置本地模式调用原生 `@oh-my-pi/pi-natives` glob 实现。
- 会话状态（转录、记忆、作业、检查点、注册表）
  - 在提供 `onUpdate` 时发出结构化进度更新。
  - 向工具结果添加截断 / 上限元数据。
- 后台工作 / 取消
  - 通过调用方中止信号加上内部超时，本地 glob 可以被取消。

## 限制与上限
- 默认结果上限：`200`（`packages/coding-agent/src/tools/glob.ts` 中的 `DEFAULT_LIMIT`）。
- 最大结果上限：`200`（`MAX_LIMIT`）；更大的输入会被限制到该值。
- 本地 glob 超时：固定为 `5000` ms。
- 输出字节上限：`50 * 1024` 字节（`packages/coding-agent/src/session/streaming-output.ts` 中的 `DEFAULT_MAX_BYTES`）。
- `truncateHead()` 中默认的通用行数上限为 `3000`，但 `glob` 把 `maxLines` 覆盖为 `Number.MAX_SAFE_INTEGER`，因此实际生效的输出截断上限是字节大小——而非行数。
- 流式更新节流：两次 `onUpdate` 发出之间相隔 `200` ms。
- 排序顺序：在内置本地分支中按最新 `mtime` 优先，提示词中也如此承诺。尽管原生 glob 收到 `sortByMtime: true`，该工具仍会在 JS 中重新排序，这样原生代码仍然可以在 `maxResults` 处提前停止。

## 错误
- `GlobTool.execute()` 抛出的面向用户的 `ToolError` 包括：
  - `` `path` must contain non-empty globs or paths ``
  - `Path not found: ...`
  - `Searching from root directory '/' is not allowed`
  - `Limit must be a positive number`
  - `Path is not a directory: ...`
  - 超时结果文本为 `glob timed out after <seconds>s; returning <N> partial matches — narrow the pattern instead of retrying blindly`，它会作为成功的、已截断的部分结果返回，而不是错误。
  - 对 SSH 输入为 `find cannot operate on a remote ssh:// path: ...`。
  - 除 `memory://` 模式外，`Glob patterns are not supported for internal URLs: ...`。
  - 对仅虚拟的资源为 `Cannot find internal URL without a backing file: ...`。
- 如果调用方中止，本地分支会把 `AbortError` 转换为 `ToolAbortError`。
- 非 `ENOENT` 的 stat 失败与其他意外错误会被重新抛出。
- 空匹配不是错误；它们返回无文件的文本结果。

## 备注
- 文件名 / 路径发现应使用 `glob`。当选择标准是文件内容或正则匹配时应使用 `grep`；`grep` 接受 `pattern` 并返回带锚点的内容匹配，而 `glob` 只返回匹配的路径（`packages/coding-agent/src/prompts/tools/glob.md`、`packages/coding-agent/src/prompts/tools/grep.md`）。
- 裸的顶层 glob 会被递归化。`*.ts` 被解析为基础 `.` 加上 glob `**/*.ts`；`src/*.ts` 仍以 `src` 为根，并带有非递归的 `*.ts` 段；`src/**/*.ts` 保留显式递归。
- `.gitignore` 在内置本地分支中默认启用。使用 `gitignore: false` 可对原生遍历禁用它。
- `hidden` 默认为 `true`；隐藏文件排除是选择退出，而非选择加入。
- 多路径的缺失输入容忍在两个分支中都适用，但只有内置本地分支会呈现 `missingPaths` / `Skipped missing paths: ...`。自定义操作分支仅对单输入调用硬失败缺失的 `searchPath`；在多输入调用中，缺失的目标会静默地不贡献任何结果。
- 自定义 `GlobOperations.glob()` 钩子会收到 `ignore` 与 `limit`，但不会收到 `hidden` 标志或显式的 `.gitignore` 开关。远程委托方若想与本地分支保持一致，必须自行处理这一点。
- 内置本地 glob 不会强制 `fileType: File`；它可能从原生 glob 返回文件和目录。目录输出也可能来自精确路径直通，或来自返回目录的自定义委托。
