# ast_edit

> 通过原生 ast-grep 对源文件进行结构化重写的预览与应用。

## Source
- Entry: `packages/coding-agent/src/tools/ast-edit.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/ast-edit.md`
- Key collaborators:
  - `crates/pi-natives/src/ast.rs` — 原生重写规划与文件变更
  - `crates/pi-ast/src/language/mod.rs` — 原生包装器使用的语言别名与扩展名推断
  - `packages/coding-agent/src/tools/path-utils.ts` — 路径/glob 解析与多路径解析
  - `packages/coding-agent/src/tools/resolve.ts` — 预览/应用队列
  - `packages/coding-agent/src/tools/render-utils.ts` — 解析错误去重与显示上限
  - `packages/coding-agent/src/utils/file-display-mode.ts` — hashline 与行号 diff 引用
  - `packages/hashline/src/format.ts` — 预览锚点使用的稳定 hashline 头格式
  - `packages/natives/native/index.d.ts` — JS 可见的原生绑定契约

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `ops` | `{ pat: string; out: string }[]` | Yes | 一条或多条重写规则。`pat` 必须非空。重复的 `pat` 值在原生执行前会失败。空的 `out` 会删除匹配的节点。 |
| `paths` | `string[]` | Yes | 一个或多个文件、目录、glob，或由路径支撑的内部 URL。至少需要一个非空条目。内部 URL 的 glob 会被拒绝；已抓取的外部 URL 为只读，不可被重写。 |

共享的 AST 模式语法与语言目录：参见 [`ast_grep`](./ast-grep.md#inputs)。

- `ast_edit` 使用相同的 `$NAME`、`$_`、`$$$NAME` 与 `$$$` 元变量语义。
- 工具提示补充了重写专属的约束：
  - 元变量名称必须大写，且必须代表完整的 AST 节点；
  - `pat` 中的捕获会替换到 `out` 中；
  - 每条重写都是 1:1 的结构替换；除非该位置处的语法本身允许展开，否则单个捕获不能展开为多个兄弟节点。

`ast_edit` 默认由 `astEdit.enabled` 启用。它是可被发现的工具，但不属于核心工具集。

## Outputs
- `ast_edit` 自身的一次性预览结果。非空提议以 `Staged as a proposal — files NOT modified yet...` 开头，并指明 resolve/reject 设备路径。
- 面向模型的 `content` 是单个文本块，展示提议的编辑，按文件分组（适用于目录/多文件运行）。
  - 每次变更渲染为两行。hashline 模式下，在 `[PATH#TAG]` 头下使用 `-LINE:before` / `+LINE:after`；普通模式下使用 `-LINE:COLUMN before` / `+LINE:COLUMN after`。
  - 每个 `before` / `after` 片段仅显示第一行，在包装器中截断为 120 字符。
  - 在适用时，会追加 `Limit reached; narrow paths.` 与格式化后的解析问题。
- 若没有匹配的重写，文本为 `No replacements made`，如有解析问题则附带格式化后的解析问题。
- `details` 包含聚合的预览元数据：
  - `totalReplacements`、`filesTouched`、`filesSearched`、`applied`、`limitReached`
  - 可选字段 `parseErrors`、`parseErrorsTotal`、`scopePath`、`files`、`fileReplacements`、`displayContent`、`searchPath`、`cwd`、`meta`
- 工具总是先进行预览（直接结果中为 `applied: false`）。实际的文件写入仅在之后通过向 `xd://resolve` 写入纯文本完成；正文即为原因。
- 当预览产生替换时，`ast_edit` 同时会排队一个待处理的 resolve 动作。成功应用会通过一次独立的 resolve 调度结果（在 `write` 调用上）返回，而不是再返回一个 `ast_edit` 结果。

## Flow
1. `AstEditTool.execute()` 在 `packages/coding-agent/src/tools/ast-edit.ts` 中校验每个 op：
   - 空的 `pat` 失败，
   - 至少需要一个 op，
   - 重复的 `pat` 值失败，
   - ops 被转换为 `Record<pattern, replacement>`。
2. 包装器通过 `$envpos(..., 1000)` 读取 `PI_MAX_AST_FILES`，并将其作为预览和应用通用的原生 `maxFiles` 上限。
3. 路径规范化、内部 URL 处理、缺失路径分区以及多路径解析，遵循与 `ast_grep` 相同的 `path-utils.ts` 流程。
4. 作用域的 `isDirectory` 标志（由 `resolveToolSearchScope` 中的 stat 设置）决定是否渲染分组的目录输出。
5. `runAstEditOnce(...)` 始终在第一遍以 `dryRun: true` 与 `failOnParseError: false` 调用原生 `astEdit(...)`。
6. `crates/pi-natives/src/ast.rs` 中的原生 `ast_edit`：
   - 规范化重写映射并按模式字符串排序规则；
   - 解析严格性（默认 `smart`）；
   - 通过文件或感知 gitignore 的目录扫描收集候选文件；
   - 在未内部提供 `lang` 时，为每个候选文件独立推断语言；
   - 为每种已发现语言编译每条重写；某条规则若无法以某种语言解析，则跳过该语言对应的文件并报告解析问题；
   - 解析每个文件，跳过带有语法错误树的文件，收集每次匹配的 `replace_by(...)` 编辑，强制替换与文件上限，并返回文本形式的 before/after 切片及源码区间。
7. TS 包装器对解析错误去重并设置上限，按文件分组变更，渲染预览 diff 行。
8. 如果预览找到了替换且 `applied` 为 false，`queueResolveHandler(...)` 会注册一个非强制的待处理 resolve 调用器。在其待处理期间，会话会暴露一个 `SoftToolRequirement`（`toolName: "write"`，带有指向 `xd://resolve` 或 `xd://reject` 的 `satisfies` 谓词），其中携带 resolve 提醒；只有当模型在该轮拒绝时，智能体运行时才会注入提醒并强制使用 `write`。
9. 在 `write xd://resolve` 调度时，排队的回调会以 `dryRun: false` 重新运行同一组重写，重新计算计数，若实时结果不再与预览一致（`stalePreview`）则返回错误结果。当前实现会在重跑后比较替换总数与按文件计数；若新一次运行已经写入了不同的计数，则结果会被标记为错误。
10. 在非过期的应用上，回调返回 `Applied N replacements in M files.`（在 hashline 模式下，其后跟随从应用后内容重新记录的全新 `[path#tag]` 快照头）；在丢弃时（`write xd://reject`），调度返回一条丢弃消息而不会修改文件。

## Modes / Variants
- 单文件：对一个文件进行预览或应用。
- 目录 + 可选 glob：原生扫描遍历目录，然后按编译后的 glob 进行过滤。
- 多个显式路径/glob：包装器将其合并为一个合成作用域，或在路径仅在根处相会时按目标分别运行原生调用。
- 内部 URL 输入：仅在路由器将其解析为后备文件路径时受支持。
- 预览模式：始终是直接的 `ast_edit` 工具结果。
- 应用模式：仅在预览之后通过排队的 resolve 回调（向 `xd://resolve` 或 `xd://reject` 的 `write`）可达。
- Hashline 输出模式与普通 line/column 模式：由 `resolveFileDisplayMode()` 控制。

## Side Effects
- 文件系统
  - 预览会读取文件并扫描目录。
  - 应用阶段在内存中暂存所有被改动的文件，校验完整一遍后再写入暂存文件；后续的计算/重叠失败无法对先前的文件进行部分修改。
- 会话状态（transcript、memory、jobs、checkpoints、registries）
  - 通过 `queueResolveHandler(...)` 注册一个非强制的待处理 resolve 调用器。
  - 在待处理期间暴露一个 `SoftToolRequirement`（带有 resolve 提醒）；智能体运行时仅在不合规时强制 `write`——不发送引导消息，也不针对每次预览强制工具选择。
- 用户可见的提示/交互式 UI
  - 直接的 `ast_edit` 结果即为预览。
  - 后续的应用/丢弃通过向 `xd://resolve` 与 `xd://reject` 的写入来暴露。
- 后台工作/取消
  - 原生预览/应用工作通过 `task::blocking(...)` 在阻塞 worker 上运行。
  - 取消与可选的原生超时通过 `CancelToken::heartbeat()` 协作完成。

## Limits & Caps
- 包装器暴露的文件上限：`PI_MAX_AST_FILES`，默认 `1000`，位于 `packages/coding-agent/src/tools/ast-edit.ts`。
- 原生 `maxFiles` 与 `maxReplacements` 在 `crates/pi-natives/src/ast.rs` 中被提供时都会被钳制为至少 `1`。
- 包装器从不设置 `maxReplacements`；因此原生行为在一次运行中默认实际无界的替换数。
- 解析问题在 `packages/coding-agent/src/tools/render-utils.ts` 中通过 `capParseErrors(...)` 去重并封顶为 `PARSE_ERRORS_LIMIT = 20` 条；`details.parseErrors` 携带封顶后的列表，`details.parseErrorsTotal` 携带封顶前的去重计数。
- 目录扫描在 `crates/pi-natives/src/ast.rs` 中使用 `include_hidden: true`、`use_gitignore: true`，并跳过 `node_modules`，除非 glob 文本中显式提到 `node_modules`。
- 不存在单独的 glob 展开数量上限。候选数量等于解析后的路径/glob 在 gitignore 过滤后展开得到的数量，之后原生 `maxFiles` 会在达到配置的已改动文件数后停止变更。
- 预览文本在 `packages/coding-agent/src/tools/ast-edit.ts` 中将渲染的每个 `before` 与 `after` 第一行截断为 120 字符。

## Errors
- TS 包装器在以下情况抛出 `ToolError`：空模式、重复的重写模式、空的路径条目、不支持的内部 URL glob、没有 `sourcePath` 的内部 URL，以及缺失的路径。
- 原生代码针对以下情况返回硬错误：
  - 无法为候选文件推断受支持的语言（在包装器的尽力而为模式下作为解析问题上报）；
  - 内部/原生调用中显式指定了不受支持的 `lang`；
  - glob 编译失败或搜索根不可读；
  - 计算得到的编辑相互重叠（`Overlapping replacements detected; refine pattern to avoid ambiguous edits`）；
  - 编辑区间越界或替换文本非 UTF-8；
  - 应用期间的写入失败；
  - 取消或超时。
- 在 `failOnParseError: false` 下（包装器始终使用该设置），模式编译失败与文件解析失败会变成 `parseErrors`，而不是中止整个运行。
- 若每条重写模式都无法编译，原生 `ast_edit` 会返回一次成功的零替换结果，并填充 `parseErrors`。
- 包含 tree-sitter 错误节点的文件会被跳过而不进行重写；它们不会得到部分编辑。
- 在成功预览之后，若预览变得过期，应用仍可能失败。resolve 回调会比较替换总数与按文件计数，并在不匹配时返回错误结果，而不是对不一致的预览静默报告成功。

## Notes
- `ast_edit` 不向模型暴露原生 `lang`、`strictness`、`selector`、`maxReplacements`、`failOnParseError` 或 `timeoutMs` 字段。运行时将调用形态固定为先预览、smart 严格性、尽力而为解析模式。
- 支持混合语言作用域：原生层为每个候选文件推断语言，并为每种已发现语言编译每条规则。只能针对部分语言解析的模式会重写这些文件，并对不兼容的语言报告解析问题。
- 幂等性未在语法上强制保证。像 `foo($A) -> foo($A)` 这样的重写因输出等于输入而预览出零变更；而若某条重写不断匹配自身的输出，则在重复调用时仍可能产生替换。
- 重写按文件累加，然后在重叠检查之后从文件尾部向前应用。互不重叠的匹配可以共存；重叠的匹配会中止运行。
- 原生重写规则顺序按模式字符串排序，而不是按原始 `ops` 数组顺序，因为 `normalize_rewrite_map(...)` 会对 `(pattern, rewrite)` 对进行排序。
- 预览/应用的一致性通过应用重跑后的总数与按文件计数来校验，而不是通过对每个替换载荷进行逐字节 diff。
