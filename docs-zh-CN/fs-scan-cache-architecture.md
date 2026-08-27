# 文件系统扫描缓存架构契约

本文档定义了由 `crates/pi-walker` 实现的共享 Rust 文件系统扫描缓存，该缓存供暴露给 `packages/coding-agent` 的原生发现 API 使用。

## 所有权与数据模型

缓存位于 `crates/pi-walker/src/cache.rs`。它存储来自目录遍历的自有 `CollectedEntry` 列表，而非最终的 glob、模糊匹配、grep 或 AST 结果。`crates/pi-walker/src/lib.rs` 中的 `WalkRequest` 在该收集层之上应用静态过滤器、排序、限制以及可选的空结果重校验。

当前原生消费者：

- `crates/pi-natives/src/glob.rs` — 通过 `GlobOptions.cache` 选择性启用
- `crates/pi-natives/src/fd.rs`（`fuzzyFind`）— 通过 `FuzzyFindOptions.cache` 选择性启用
- `crates/pi-natives/src/ast.rs`（`astGrep` / `astEdit` 发现）— 对目录操作数始终启用缓存

`crates/pi-natives/src/grep.rs` 使用 `WalkRequest` 进行候选发现，但显式设置 `.cache(false)`；当前的公共 `GrepOptions` 没有缓存字段。

公共失效绑定仍是 `packages/natives/native/index.d.ts` / `index.js` 中的 `invalidateFsScanCache(path?)`。coding-agent 的变更辅助函数位于 `packages/coding-agent/src/tools/fs-cache-invalidation.ts`。

## 缓存键分区

每个缓存键由以下内容组成：

- 规范化后的根目录
- 完整的有效 `WalkOptions` 值，仅清除其中的 `cache` 位

因此，所有影响遍历的选项都会对条目进行分区：隐藏与忽略策略、`.git` 与 `node_modules` 剪除、符号链接策略、元数据详情、目录内顺序、根目录发出、min/max 深度、contents-first 遍历、目录错误策略以及同文件系统策略。任何在这些字段上有所不同的调用都不会共享同一次扫描。特别是，`follow_links` **是** 当前键的一部分。

高层 `WalkRequest` 的过滤器、排序、结果限制、空重检查策略以及大小提示策略不直接存储在键中。在收集之前，大小提示策略和最大文件大小过滤可以将有效元数据详情提升为 `Full`，从而对底层扫描进行分区。

## 收集行为

`pi-walker` 将相对根目录解析为相对于当前工作目录的形式，要求目录必须存在，并在可能时对其进行规范化。`WalkOptions` 控制遍历；消费者显式选择其策略，而不是继承每个 walker 的默认值。

收集到的条目包含规范化后的正斜杠相对路径和文件类型。`WalkDetail::Full` 还会请求 mtime 和常规文件大小。取消通过调用方提供的心跳信号传递。

与遍历相关的并行工作使用共享的 Rayon 池：

- `PI_WALK_WORKERS` 默认为 `4`
- `0` 自动检测可用并行度
- `1` 强制串行工作
- 辅助操作仅在 256 项或更多项时进行并行化

## 时效性与淘汰

全局可由环境变量覆盖的策略：

- `FS_SCAN_CACHE_TTL_MS` — 默认 `1000`
- `FS_SCAN_EMPTY_RECHECK_MS` — 默认 `200`
- `FS_SCAN_CACHE_MAX_ENTRIES` — 默认 `16`

启用缓存时：

- TTL 为 `0` 时绕过缓存，返回新的扫描并设置 `cache_age_ms = 0`。
- 小于 TTL 的命中会克隆存储的条目并报告其年龄。
- 已过期的条目会被移除并替换为新的扫描。
- 插入后，超过配置上限的条目按创建时间从最旧开始淘汰。

禁用缓存时，收集会进行全新扫描，既不会读取也不会填充共享缓存。它不会淘汰同一键的现有缓存条目。

## 空结果重校验

`WalkRequest` 拥有重检查策略。`EmptyRecheck::Configured` 在以下情况下重试一次：

1. 第一次收集是具有非零年龄的缓存命中，
2. 经请求的高层过滤后结果为空，并且
3. 缓存年龄至少为 `FS_SCAN_EMPTY_RECHECK_MS`（配置阈值为 `0` 时禁用此模式）。

重试不经过缓存，也不会替换或淘汰现有的缓存条目。`EmptyRecheck::Never` 禁用该行为；`AfterMillis(n)` 提供请求特定的年龄阈值。

当前效果：

- `glob` 将其编译后的 glob 和 node 模块策略集成到 `WalkFilter` 中，因此空的过滤后匹配集可以触发重校验。
- AST 发现集成了仅文件、可选 glob 和 node 模块过滤，因此空的候选集可以触发重校验。
- `fuzzyFind` 使用默认的全条目过滤器进行收集，然后进行打分。因此重校验覆盖的是底层遍历为空的情况，而非所有条目打分都为零的非空遍历。
- `grep` 不进行缓存，因此不应用基于缓存年龄的重检查。

## 消费者策略

- `glob`：`hidden=false`，`gitignore=true`，`cache=false`；跳过 `.git`；除非模式提及 `node_modules`，否则跳过；永不跟随符号链接；使用路径顺序和模式限定的深度；仅对 mtime 排序使用完整详情。
- `fuzzyFind`：`hidden=false`，`gitignore=true`，`cache=false`；跳过 `.git` 和 `node_modules`；始终跟随符号链接；使用最小详情和路径顺序。
- `astGrep` / `astEdit` 目录发现：`hidden=true`，`gitignore=true`，始终启用缓存；跳过 `.git`；除非提供的 glob 提及 `node_modules`，否则排除；永不跟随符号链接；使用最小详情和路径顺序。
- `grep`：候选遍历跳过 `.git`，永不跟随符号链接，使用最小详情，且不进行缓存。

TUI 的 `@` 提及自动补全选择启用缓存的 `fuzzyFind`。coding-agent 的 grep 工具不会填充此缓存。

## 失效

`invalidateFsScanCache(path?)`：

- 不带路径时，清除所有条目
- 带路径时，移除所有其缓存根目录是目标路径前缀的条目

相对路径相对于当前工作目录解析。失效会规范化目标路径；当目标不存在时，它会尝试规范化父目录并重新附加文件名。这支持创建、删除和重命名的失效。

coding-agent 辅助函数：

- `invalidateFsScanAfterWrite(path)`
- `invalidateFsScanAfterDelete(path)`
- `invalidateFsScanAfterRename(oldPath, newPath)` — 在两侧不同时同时失效两侧

当前的 write、hashline、patch 和 replace 变更路径在成功变更后调用这些辅助函数。任何新的文件系统变更路径都必须如此。

## 添加缓存消费者

1. 选择稳定的遍历选项并复用 `WalkRequest`；任何有效的 `WalkOptions` 差异都会创建一个分区。
2. 当空结果重校验应当观察到稳定候选过滤时，将其放入 `WalkFilter`。收集后打分无法触发请求的重检查。
3. 对真正需要全新结果的请求使用 `.cache(false)`；它绕过共享状态而非清除它。
4. 审慎选择 `EmptyRecheck`。不要添加每次调用的 TTL 控制；TTL 和默认的重检查年龄是全局的。
5. 在每次成功的写入、删除或移动后进行失效；重命名时同时失效两侧。

## 边界

- `DashMap` 缓存是进程本地的，不会被持久化。
- 条目是完整的自有扫描结果，而非最终工具结果。
- 缓存命中会克隆存储的条目向量。
- 仅在相同的规范化根目录和完整的有效遍历选项之间共享。
