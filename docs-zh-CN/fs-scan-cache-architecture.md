# 文件系统扫描缓存架构契约

本文档定义由 `crates/pi-walker` 实现的共享 Rust 文件系统扫描缓存，该缓存由暴露给 `packages/coding-agent` 的 native 发现 API 使用。

## 所有权与数据模型

缓存位于 `crates/pi-walker/src/cache.rs`。它存储目录遍历得到的自有 `CollectedEntry` 列表，而非最终的 glob、模糊、grep 或 AST 结果。`crates/pi-walker/src/lib.rs` 中的 `WalkRequest` 在该收集层之上应用静态过滤器、排序、限制以及可选的空结果重校验。

当前 native 消费者：

- `crates/pi-natives/src/glob.rs` — 通过 `GlobOptions.cache` 选择性启用
- `crates/pi-natives/src/fd.rs`（`fuzzyFind`）— 通过 `FuzzyFindOptions.cache` 选择性启用
- `crates/pi-natives/src/ast.rs`（`astGrep` / `astEdit` 发现）— 对目录操作数始终启用缓存

`crates/pi-natives/src/grep.rs` 使用 `WalkRequest` 进行候选发现，但显式设置 `.cache(false)`；当前的公开 `GrepOptions` 没有缓存字段。

将 walker 结果桥接到 JavaScript 的 N-API DTO 层位于 `crates/pi-natives/src/iofs.rs`；如其文件头所述，"`pi-walker` 拥有遍历与缓存策略"，`iofs.rs` 仅保留面向 JS 的形状与转换。公开的失效绑定仍是 `invalidateFsScanCache(path?)` — 声明于 `iofs.rs`（转发到 `pi_walker::invalidate_path_string` / `pi_walker::invalidate_all`），并导出于 `packages/natives/native/index.d.ts` / `index.js`。coding-agent 的变更辅助函数位于 `packages/coding-agent/src/tools/fs-cache-invalidation.ts`。

## 缓存键分区

每个缓存键由以下内容构成：

- 规范化后的根目录
- 完整的有效 `WalkOptions` 值，仅清除其中的 `cache` 位

因此，所有影响遍历的选项都会对条目进行分区：隐藏与忽略策略、`.git` 与 `node_modules` 剪除、符号链接策略、元数据详情、目录内顺序、根目录是否发出、min/max 深度、contents-first 遍历、目录错误策略以及同文件系统策略。在这些字段上任一不同的调用都不会共享同一次扫描。特别是，`follow_links` **确实** 是当前键的一部分。

高层的 `WalkRequest` 过滤器、排序、结果限制、空重检查策略以及大小提示策略不会直接存入键中。在收集之前，大小提示策略和最大文件大小过滤可以将有效元数据详情提升为 `Full`，进而对底层扫描进行分区。

## 收集行为

`pi-walker` 相对当前 cwd 解析相对根目录，要求目录必须已存在，并在可能时将其规范化。`WalkOptions` 控制遍历；消费者显式选择自己的策略，而不是继承 walker 的每一项默认值。

收集到的条目包含规范化为正斜杠形式的相对路径和文件类型。`WalkDetail::Full` 还会额外请求 mtime 和常规文件大小。取消通过调用方提供的心跳传递。

与遍历相关的并行工作使用共享的 Rayon 池：

- `PI_WALK_WORKERS` 默认为 `4`
- `0` 自动检测可用并行度
- `1` 强制串行执行
- 辅助操作仅在达到 256 项或更多时才并行化

## 时效性与淘汰

全局可被环境变量覆盖的策略：

- `FS_SCAN_CACHE_TTL_MS` — 默认 `1000`
- `FS_SCAN_EMPTY_RECHECK_MS` — 默认 `200`
- `FS_SCAN_CACHE_MAX_ENTRIES` — 默认 `16`
- `FS_SCAN_CACHE_MAX_BYTES` — 默认 `67108864`（64 MiB 的保留向量与路径字符串分配）

启用缓存时：

- TTL、条目上限或字节上限为 `0` 时绕过缓存，返回全新扫描且 `cache_age_ms = 0`。
- 未超过 TTL 的命中会在缓存锁之外克隆存储的条目并报告其年龄。复制前后都会检查取消状态。
- 每次查找或插入都会移除所有已过期条目。空闲进程最多保留所配置的有效负载预算，直至下一次缓存操作；不存在后台过期线程。
- 插入时会淘汰最旧的条目，直至同时满足两个上限。字节预算计入向量容量与字符串容量；不计入分配器开销、有界映射元数据以及调用方自有的结果。
- 超大扫描或年龄已超过 TTL 的扫描会直接返回，不会另存一份副本。并发扫描不会用较旧的结果替换较新的扫描。

禁用缓存时，收集总是全新扫描，既不读取也不填充共享缓存，也不会淘汰同一键的现有缓存条目。

## 空结果重校验

`WalkRequest` 拥有重检查策略。`EmptyRecheck::Configured` 在以下情况下重试一次：

1. 第一次收集是年龄非零的缓存命中，
2. 经请求的高层过滤器处理后结果为空，并且
3. 缓存年龄至少为 `FS_SCAN_EMPTY_RECHECK_MS`（配置阈值为 `0` 时禁用此模式）。

重试不经过缓存，也不会替换或淘汰现有的缓存条目。`EmptyRecheck::Never` 会禁用该行为；`AfterMillis(n)` 提供请求特定的年龄阈值。

当前效果：

- `glob` 将其编译后的 glob 与 node 模块策略集成到 `WalkFilter` 中，因此空的过滤后匹配集可以触发重校验。
- AST 发现集成了仅文件、可选 glob 与 node 模块过滤，因此空的候选集可以触发重校验。
- `fuzzyFind` 使用默认的全条目过滤器进行收集，之后再打分。因此重校验覆盖的是底层遍历为空的情况，而不是条目全部得零分的非空遍历。
- `grep` 不使用缓存，因此不适用基于缓存年龄的重检查。

## 消费者策略

- `glob`：`hidden=false`、`gitignore=true`、`cache=false`；跳过 `.git`；除非模式中提及 `node_modules`，否则跳过；永不跟随符号链接；使用路径顺序和模式限定的深度；仅对 mtime 排序使用完整详情。
- `fuzzyFind`：`hidden=false`、`gitignore=true`、`cache=false`；跳过 `.git` 和 `node_modules`；始终跟随符号链接；使用最小详情和路径顺序。
- `astGrep` / `astEdit` 目录发现：`hidden=true`、`gitignore=true`，缓存始终启用；跳过 `.git`；除非提供的 glob 提及 `node_modules`，否则排除；永不跟随符号链接；使用最小详情和路径顺序。
- `grep`：候选遍历跳过 `.git`，永不跟随符号链接，使用最小详情，且不使用缓存。

TUI 的 `@` 提及自动补全选择启用缓存的 `fuzzyFind`。coding-agent 的 grep 工具不会填充此缓存。

## 失效

`invalidateFsScanCache(path?)`：

- 不带路径时，清除所有条目
- 带路径时，移除所有缓存根目录为目标路径前缀的条目

失效还会阻止已在进行中的扫描重新填充缓存。针对特定路径的失效会保守地阻止其他并发扫描被准入，同时保留现有的无关条目。

相对路径相对当前 cwd 解析。失效会对目标进行规范化；当目标已不存在时，会尝试规范化其父目录并重新附加文件名。这支持创建、删除和重命名的失效。

coding-agent 辅助函数：

- `invalidateFsScanAfterWrite(path)`
- `invalidateFsScanAfterDelete(path)`
- `invalidateFsScanAfterRename(oldPath, newPath)` — 两侧不同时同时失效两侧

当前的 write、hashline、patch、replace、auto-repair、sloppy-edit 和 ACP-bridge 变更路径都会在成功变更后调用这些辅助函数。任何新的文件系统变更路径都必须同样如此。

## 添加缓存消费者

1. 选择稳定的遍历选项并复用 `WalkRequest`；有效 `WalkOptions` 的任何差异都会创建一个分区。
2. 当空结果重校验需要观察到稳定的候选过滤时，将其放入 `WalkFilter`。收集后的打分无法触发请求的重检查。
3. 对真正需要全新结果的请求使用 `.cache(false)`；它是绕过共享状态，而不是清除共享状态。
4. 审慎选择 `EmptyRecheck`。不要添加每次调用的 TTL 控制；TTL 和默认重检查年龄都是全局的。
5. 在每次成功的写入、删除或移动之后进行失效；重命名时同时失效两侧。

## 边界

- 缓存是进程本地的，不会被持久化。互斥锁保证准入、淘汰、过期与失效的原子性；引用计数的有效负载允许在该锁之外进行复制。
- 条目是完整的自有扫描结果，而非最终工具结果。
- 缓存命中会克隆存储的条目向量。
- 仅在相同的规范化根目录和完整的有效遍历选项之间共享。

## 测量预算

运行 `FS_SCAN_CACHE_TTL_MS=60000 cargo run -p pi-walker --example scan-cache-bench -- /path/to/tree`，以测量 16 个遍历选项分区上的扫描分配字节数、自有向量复制以及缓存命中情况。设置 `FS_SCAN_CACHE_MAX_BYTES` 以比较不同预算。该示例不会改动所提供的目录树；进行耗时比较时请使用优化的 Cargo profile。
