# Natives 绑定契约（JavaScript/TypeScript 端）

本文定义了 `@oh-my-pi/pi-natives` 调用方与其 N-API 插件之间的公共 JS/TS 边界。权威的公共根表面是 `packages/natives/native/index.d.ts` 以及 `native/index.js` 中显式导出的 ESM 模块；不在其中的 Rust 内部实现不属于包 API。

## 契约层

1. `crates/pi-natives/src/**/*.rs` 定义 `#[napi]` 函数、类、对象和枚举。
2. `bun --cwd=packages/natives run build:bindings` 运行 napi-rs，安装宿主插件和生成的 `native/index.d.ts`，然后运行 `gen-enums.ts`。
3. `gen-enums.ts` 读取声明文件，将 napi-rs 的 `const enum` 声明改写为运行时可用的声明，并使用显式的类/函数导出和字面量枚举对象替换 `native/index.js` 中标记的代码块。
4. `native/index.js` 加载插件并绑定该生成的根表面。

不存在 `NativeBindings` 声明合并生命周期或 `packages/natives/src/<module>` 包装器约定。加载器仅对安装/编译后加载的发布版本哨兵进行校验，而不是对每个公共符号都做校验。

## 公共入口

`packages/natives/package.json` 导出：

| 入口                              | 公共值                                                                                                                              |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `@oh-my-pi/pi-natives`            | 来自 `native/index.js` / `index.d.ts` 的根类、函数和枚举对象。导入是急切的（eager）。                                              |
| `@oh-my-pi/pi-natives/desktop`    | `createDesktopSession(options): DesktopSession`；插件加载延迟到调用时。                                                            |
| `@oh-my-pi/pi-natives/clipboard`  | `copyToClipboard(text)` 和 `readImageFromClipboard()` 以及 `ClipboardImage` 类型；插件加载延迟到调用时。                           |

包使用者不得导入未导出的 `native/*` 实现路径。

## 按所有者划分的当前根表面

| 类别                | 代表性的公共导出                                                                                                                                          | Rust 所有者                                                           | 调用风格              |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | --------------------- |
| 搜索和工作区        | `grep`、`search`、`hasMatch`、`fuzzyFind`、`glob`、`invalidateFsScanCache`、`listWorkspace`                                                                | `grep.rs`、`fd.rs`、`glob.rs`、`iofs.rs`、`workspace.rs`              | 同步/Promise 混合     |
| AST 与代码结构      | `astGrep`、`astMatch`、`astEdit`、`blockRangeAt`、`enclosingBlockBoundaries`、`summarizeCode`                                                              | `ast.rs`、`block.rs`、`summary.rs`                                    | 同步/Promise 混合     |
| Diff 与向量         | `diffLines`、`diffWords`、`diffLineRuns`、`structuredPatchHunks`、`cosineSimilarityPairs`、`mmrRerankIndices`、`vectorIndexTopK`                          | `diff.rs`、`vectors.rs`                                               | 同步                 |
| Shell 与 PTY        | `executeShell`、`Shell`、`PtySession`                                                                                                                     | `shell.rs`、`pty.rs`                                                  | 类/Promise            |
| 进程与文件          | `Process`、`FileLock`                                                                                                                                     | `ps.rs`、`file_lock/mod.rs`                                           | 类/混合               |
| 桌面与剪贴板        | `DesktopSession`、`copyToClipboard`、`readImageFromClipboard`                                                                                             | `desktop/mod.rs`、`clipboard.rs`                                      | 类、同步、Promise     |
| 音频与实时媒体      | `AudioCapture`、`AudioPlayback`、`LiveWebRtcPeer`                                                                                                         | `audio.rs`、`live.rs`                                                 | 类/混合               |
| 文本与高亮          | `wrapTextWithAnsi`、`truncateToWidth`、`sliceWithWidth`、`extractSegments`、`visibleWidth`、`setHangulCompatJamoWidthOverride`、`highlightCode`、语言查询   | `text.rs`、`highlight.rs`                                             | 同步                 |
| 转换与渲染          | `htmlToMarkdown`、`encodeSixel`、`renderSnapcompactPng`、`snapcompactSupportedChars`                                                                       | `html.rs`、`sixel.rs`、`snapcompact.rs`                               | 同步/Promise 混合     |
| Tokens 与系统       | `countTokens`、macOS 外观/电源相关导出、`getWorkProfile`、`deviceCheckGenerateToken`                                                                       | `tokens.rs`、`appearance.rs`、`power.rs`、`prof.rs`、`devicecheck.rs` | 混合                 |
| 隔离                | `isoBackend`、`isoProbe`、`isoResolve`、`isoIsUnavailableError`、`isoStart`、`isoStop`、`isoDiff`                                                          | `iso.rs`                                                              | 同步/Promise 混合     |
| 按键                | `parseKey`、`matchesKey`、Kitty/legacy 辅助函数                                                                                                            | `keys.rs`                                                             | 同步                 |

请参考 `native/index.d.ts` 以获取精确的选项/结果字段和签名。当前值得注意的签名包括 `renderSnapcompactPng(...): Promise<string>`、`readImageFromClipboard(): Promise<ClipboardImage | undefined | null>` 以及类型化数组形式的向量输入/结果。

## 同步、Promise 与回调规则

调用风格是公共契约的一部分：

- CPU 密集型/阻塞型 API 通常通过 napi-rs 任务返回 Promise，包括 `grep`、`glob`、`fuzzyFind`、AST 搜索/编辑、snapcompact 渲染以及 HTML 转换。
- 由 Tokio 支持的操作（如 shell、PTY、隔离生命周期、设备检查、桌面操作以及实时媒体）在已声明的情况下使用 Promise。
- 内存中的转换和直接探测通常保持同步：`search`、`hasMatch`、块边界、文本/布局辅助、diff、向量排序、高亮、按键解析以及隔离的 probe/resolve 辅助。
- 有状态资源是类。它们的构造函数和各个方法可以具有不同的同步/异步行为；应使用声明文件而不是假设整个类都是异步的。

在同步和返回 Promise 之间切换公共函数是破坏性变更。例如，`renderSnapcompactPng` 必须使用 `await`，即使其相邻的 snapcompact 字符探测是同步的。

由 napi-rs 的 `ThreadsafeFunction` 生成的回调参数使用 error-first 形式，如 `(error: Error | null, value) => void`。流式回调不会取代所属的 Promise/结果。它们的精确时序和可选项按各导出来声明。

## 对象、枚举与二进制数据

`#[napi(object)]` 结构体成为 TS 接口，例如搜索结果、AST 负载、shell/PTY 结果、桌面选项/结果、音频/实时事件以及隔离记录。运行时转换由 napi-rs 负责；TypeScript 的可选性并不能为非类型化调用方提供语义校验。

当前生成的运行时枚举对象为：

- `AstMatchStrictness`
- `Ellipsis`
- `Encoding`
- `FileType`
- `GrepOutputMode`
- `IsoBackendKind`
- `IsoChangeKind`
- `KeyEventType`
- `MacOSAppearance`
- `ProcessStatus`

数值型和字符串型枚举声明约束了 TypeScript 调用方，但本身并不能证明任意非类型化值在语义上是合法的。二进制 API 在已声明的情况下使用类型化数组（`Uint8Array`、`Float32Array`、`Float64Array`、`Uint32Array`）；在缺少显式转换的情况下，不要用普通数组替换它们。

## 导入与错误行为

- 导入根入口时，如果没有兼容的插件候选项可加载，则会抛出错误。懒加载的 desktop/clipboard 子路径会将该失败延迟到其包装函数被调用时。
- 安装版和编译版候选项若缺少预期的版本哨兵，在加载时会被拒绝。工作区开发版候选项会跳过哨兵校验。
- 残留的旧版本插件可能产生特定于重启的不匹配；磁盘上残留的过期文件会触发重新安装诊断。
- 加载器不会检查完整的导出集合。因此，同一版本的不完整构建可以加载，并在稍后暴露出值为 `undefined` 的成员。
- N-API 转换错误会在 Rust 业务逻辑运行之前抛出或 reject。原生任务和异步失败会 reject 其返回的 Promise。

## 绑定变更清单

1. 添加或修改所属 Rust 的 `#[napi]` 项；在 `crates/pi-natives/src/lib.rs` 中注册新模块。
2. 当导出类型表面发生变化时，运行 `bun --cwd=packages/natives run build:bindings`。这是声明/本地插件路径；常规的 `build` 脚本是 Bazel 发行版插件路径。
3. 确认 `native/index.d.ts` 中包含期望的 JS 名称、类型、可选性、回调形式以及同步/Promise 返回。
4. 确认 `native/index.js` 中标记的代码块包含了该类/函数以及任何枚举运行时对象。
5. 仅在需要延迟加载时添加懒加载子路径包装器，并相应地添加 `package.json#exports` 中匹配的 runtime/types 条目。
6. 当原生路径成为规范路径时，更新所有直接使用者并移除过时的实现。
7. 运行一个聚焦的场景，在新构建的插件上导入并调用被修改的导出。
