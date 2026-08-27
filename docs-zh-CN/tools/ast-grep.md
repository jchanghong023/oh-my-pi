# ast_grep

> 通过原生 ast-grep 在受支持的源文件上进行结构化代码搜索。

## 源码
- 入口: `packages/coding-agent/src/tools/ast-grep.ts`
- 面向模型的提示词: `packages/coding-agent/src/prompts/tools/ast-grep.md`
- 关键协作模块:
  - `crates/pi-natives/src/ast.rs` — 原生扫描、解析、匹配引擎
  - `crates/pi-ast/src/language/mod.rs` — 原生包装器使用的语言别名与扩展名推断。
  - `packages/coding-agent/src/tools/path-utils.ts` — 路径/通配符解析与多路径解析
  - `packages/coding-agent/src/tools/render-utils.ts` — 解析错误去重与显示上限
  - `packages/coding-agent/src/tools/match-line-format.ts` — hashline 匹配渲染
  - `packages/coding-agent/src/utils/file-display-mode.ts` — hashline 与行号输出模式
  - `packages/natives/native/index.d.ts` — JS 可见的原生绑定契约

## 输入

| 字段 | 类型 | 是否必填 | 说明 |
| --- | --- | --- | --- |
| `pat` | `string` | 是 | 单条 AST 模式。包装器会去除其首尾空白并拒绝空字符串。 |
| `path` | `string` | 否 | 要搜索的文件、目录、通配符、内部 URL 或已抓取的网页 URL。使用 `;` 分隔多个根路径。省略或留空时默认为 `.`(工作区根目录)。内部 URL 的通配符将被拒绝。 |
| `skip` | `number` | 否 | 匹配偏移量。默认为 `0`,然后取 `Math.floor(...)`;负数与非有限值会失败。 |

向模型公开的模式语法与语言支持:
- `$NAME` — 捕获一个 AST 节点。
- `$_` — 匹配一个 AST 节点但不绑定。
- `$$$NAME` — 捕获零个或多个 AST 节点;ast-grep 在下一个可满足节点处惰性停止。
- `$$$` — 匹配零个或多个 AST 节点但不绑定。
- 元变量名必须大写,且必须代表整个 AST 节点,而非部分标记或字符串片段。
- 重复使用同一元变量要求每次出现处的代码完全相同。
- 模式必须能够解析为推断目标语言下的一个有效 AST 节点。
- 支持的标准语言来自 `crates/pi-ast/src/language/mod.rs` 中的 `SupportLang::all_langs()`:`astro`、`bash`、`c`、`cmake`、`cpp`、`csharp`、`dart`、`clojure`、`css`、`diff`、`dockerfile`、`emacs-lisp`、`elixir`、`erlang`、`fortran`、`go`、`graphql`、`haskell`、`hcl`、`html`、`ini`、`java`、`javascript`、`json`、`just`、`julia`、`kotlin`、`lua`、`make`、`markdown`、`nix`、`objc`、`ocaml`、`odin`、`php`、`powershell`、`protobuf`、`python`、`r`、`regex`、`ruby`、`rust`、`scala`、`solidity`、`sql`、`starlark`、`svelte`、`swift`、`toml`、`tlaplus`、`tsx`、`typescript`、`verilog`、`vue`、`xml`、`yaml`、`zig`。

`ast_grep` 默认处于禁用状态(`astGrep.enabled = false`),启用后为可发现工具。

## 输出
- 单次工具结果。
- 面向模型的 `content` 为一段文本块:
  - 目录/多文件搜索时按文件分组,
  - 匹配行在 hashline 模式下以 `[PATH#HASH]` 下的 `*LINE:text` 渲染,否则以 `*LINE|text` 渲染,
  - 多行匹配的续行以一个前导空格渲染,
  - 当 ast-grep 捕获到元变量时,每个匹配可附带一行 `meta: NAME=value, …`。
- 若未找到匹配,文本为 `No matches found` 或 `No matches found. Parse issues mean the query may be mis-scoped; narrow paths before concluding absence.` 并附上格式化后的解析问题。
- 若包装器对可见结果进行了截断,文本将以 `Result limit reached; narrow paths or increase limit.` 结尾。
- `details` 包含计数与元数据,不包含完整的匹配负载:
  - `matchCount`、`fileCount`、`filesSearched`、`limitReached`
  - 可选 `parseErrors`、`parseErrorsTotal`、`scopePath`、`searchPath`、`cwd`、`files`、`fileMatches`、`displayContent`、`meta`
- 原生范围(`byteStart`、`byteEnd`、`startLine`、`startColumn`、`endLine`、`endColumn`)仅存在于原生结果内部;包装器不会直接将其输出给模型。

## 流程
1. `AstGrepTool.execute()` 对 `pat` 进行去除空白与校验,规范化 `skip`,将分号分隔的 `path` 转换为根路径(默认为 `.`),然后将范围解析委托给 `resolveToolSearchScope()`。
2. 内部 URL 通过共享路由器解析;缺少 `sourcePath` 的条目与内部 URL 通配符将失败。可读的外部 URL 会被物化为不可变的本地文件以供搜索。
3. 对于多个路径输入,`partitionExistingPaths()` 仅在至少仍保留一个有效根时丢弃缺失的根;若全部根均缺失则调用失败。
4. `parseSearchPathPreferringLiteral()` 将单个路径拆分为 `basePath` 及可选的 `glob`。`resolveExplicitSearchPaths()` 将多个输入折叠到一个公共基路径加上一个 brace-union 通配符,或在公共祖先本身不是所请求路径之一时拆分为单独的 `targets`。
5. 包装器对解析后的基路径进行 stat,以决定输出是否按目录结果分组。
6. 执行分派到以下二者之一:
   - 对单个解析后基路径发起一次原生 `astGrep(...)` 调用,或
   - `runMultiTargetAstGrep(...)`,对每个目标各调用一次原生绑定,将路径重新映射回公共根后全局排序,再应用 `skip` 与包装器限制。
7. `crates/pi-natives/src/ast.rs` 中的原生 `ast_grep`:
   - 规范化并去重模式,
   - 解析一个 `MatchStrictness`(默认为 `smart`),
   - 通过文件或感知 gitignore 的目录扫描收集候选文件,
   - 除非提供了 `lang`,否则按扩展名推断每个候选的语言,
   - 对出现的每种语言分别编译模式,
   - 读取每个文件,将语法错误树报告为解析问题,运行 `find_all`,并可选择捕获元变量绑定。
8. 原生结果按路径和源位置排序,然后通过 `offset`/`limit` 分页。
9. TS 包装器对解析错误字符串进行规范化与去重,按格式化后的路径对匹配分组,渲染锚点行,追加限制/解析通知,并返回 `toolResult(...).text(...).done()`。

## 模式 / 变体
- 单文件: 原生路径即该文件;输出为渲染后的匹配行扁平列表。
- 目录 + 可选通配符: 原生扫描遍历目录,然后通过已编译的通配符进行过滤。
- 多个显式路径/通配符: 包装器将其并入一个合成范围,或在路径仅在根处相遇时按目标逐次发起原生调用。
- 内部 URL 输入: 当路由器将其解析为后备文件路径时受支持。可读的外部 URL 会被物化为不可变的临时文件。
- Hashline 输出模式与纯行号模式: 由 `resolveFileDisplayMode()` 控制;hashline 模式需要 edit 工具与 hashline 编辑模式,每文件锚点还额外要求一次成功的全文件快照(`recordFileSnapshot()`)——超出容量或不可读的文件回退为纯输出。

## 副作用
- 文件系统
  - TS 包装器对输入路径执行 stat。
  - 原生代码通过 `fs_cache` 读取匹配文件并扫描目录。
- 会话状态(对话记录、内存、任务、检查点、注册表)
  - 除常规工具对话记录/结果元数据外,无其他变更。
- 后台工作 / 取消
  - 原生工作通过 `task::blocking(...)` 在阻塞工作线程上运行。
  - 取消与可选的原生超时通过 `CancelToken::heartbeat()` 协作处理。

## 限制与上限
- 包装器可见的结果上限: `packages/coding-agent/src/tools/ast-grep.ts` 中的 `DEFAULT_AST_LIMIT = 50`。
  - 单目标调用依赖于 `crates/pi-natives/src/ast.rs` 中原生默认上限 50。
  - 多目标调用每个目标获取 `skip + 50 + 1` 条匹配,再经全局排序后重新分页。
- 原生 `limit` 至少被钳制为 `1`;省略的 `offset` 在 `crates/pi-natives/src/ast.rs` 中默认为 `0`。
- 解析问题在 `packages/coding-agent/src/tools/render-utils.ts` 中最多渲染 `PARSE_ERRORS_LIMIT = 20` 行;`capParseErrors()` 还将 `details.parseErrors` 上限设为这 20 条唯一条目,`details.parseErrorsTotal` 保存去重后、未截断前的总数。
- 目录扫描在 `crates/pi-natives/src/ast.rs` 中使用 `include_hidden: true`、`use_gitignore: true`,并在通配符文本未显式提及 `node_modules` 时跳过 `node_modules`。
- 包装器或原生 `ast_grep` 不施加硬性文件数量上限;候选数量即解析后路径/通配符经 gitignore 过滤后所展开的数量。
- 多路径联合会在 `resolveExplicitSearchPaths()` 中于解析前对相同路径输入进行去重。

## 错误
- TS 包装器在以下情况抛出 `ToolError`:空模式、无效的 `skip`、空路径条目、不支持的内部 URL 通配符、缺少 `sourcePath` 的内部 URL,以及缺失的路径。受支持的外部读取 URL 会在搜索前物化,而不是被拒绝。
- 原生代码对以下情况返回硬错误:
  - 搜索根不可读或通配符编译失败,
  - 取消(`Aborted: Signal`)或超时(`Aborted: Timeout`)。
- 文件级解析失败与各语言的模式编译失败为非致命:它们累积在 `parseErrors` 中,与成功匹配一起呈现;对应语言无可编译模式的文件将被跳过。
- `no matches` 不是错误,即使已记录了解析问题。

## 备注
- `pat` 总是被 TS 工具包装为单元素 `patterns` 数组;模型无法通过 `ast_grep` 发送多个模式,即便原生绑定支持。
- `ast_grep` 可搜索混合语言树,因为原生编译按每种已发现语言分别进行,但提示词仍要求模型尽可能保持单语言调用,以减少解析噪声。
- 模式编译针对候选集合中出现的每种语言分别进行。同一模式下,某些语言可能成功,其他语言在同一次运行中产生逐文件的解析错误。
- 含有 tree-sitter 错误节点的文件仍会被搜索;语法警告为附加信息,而非跳过条件。
- 关于通配符语义,`*.ts` 仅匹配直接子项,而 `**/*.ts` 递归匹配;这一点在 `crates/pi-natives/src/ast.rs` 的原生测试中有覆盖。
- 输出锚点供后续工具使用,但确切锚点格式取决于会话编辑模式(`hashline` 与行号模式)。