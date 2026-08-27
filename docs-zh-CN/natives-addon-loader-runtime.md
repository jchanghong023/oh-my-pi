# Natives Addon Loader 运行时

本文档介绍 `packages/natives/native/loader-state.js`，它运行在 ESM 入口与已校验的 `pi_natives.*.node` 插件之间。

## 入口与急切/惰性加载

- `native/index.js` 在模块求值时调用 `loadNative()`，并对外暴露生成的根级 API。
- `native/desktop.js` 和 `native/clipboard.js` 导入了加载器，但仅在各自的公共包装器内部调用它。
- 纯加载器辅助函数会导出以供聚焦测试使用，在调用 `loadNative()` 或 `initLoaderContext()` 之前不会执行检测或文件系统探测。

成功调用不会被 JS 记忆化。重复调用依赖运行时的 `require(...)` 模块缓存，而加载后的设置是幂等的或尽力而为的。

## 加载器上下文

`initLoaderContext()` 派生以下字段：

- `platformTag`：`${platform}-${process.arch}`；
- 包版本以及哨兵名称 `__piNativesV<version_with_underscores>`；
- 包内 `nativeDir` 以及 `process.execPath` 所在目录；
- `nativesDir`，通常为 `~/.omp/natives`；仅当 `$XDG_DATA_HOME/omp` 存在时才使用 `$XDG_DATA_HOME/omp/natives`；
- `versionedDir`：`<nativesDir>/<packageVersion>`；
- 旧式已编译二进制目录：Windows 上为 `%LOCALAPPDATA%/omp`（或 `~/AppData/Local/omp`），其他平台为 `~/.local/bin`；
- 工作区/安装/编译模式、可选的叶子目录、Windows 暂存策略、CPU 变体、文件名以及有序候选项。

当存在已填充的嵌入式清单、设置了 `PI_COMPILED`、或 `import.meta.url` 包含 Bun 嵌入式标记（`$bunfs`、`~BUN` 或 `%7EBUN`）时，编译模式为真。位于 `node_modules` 路径之外的非编译 `nativeDir` 属于工作区加载。Windows 路径分类不区分大小写；其他平台使用区分大小写的路径匹配。

## 平台与变体

支持的发布标签包括：

- `linux-x64`
- `linux-arm64`
- `darwin-x64`
- `darwin-arm64`
- `win32-x64`

不支持的标签仅在探测完候选项之后才会被报告。

对于 x64，`PI_NATIVE_VARIANT=modern|baseline` 优先。无效值会被忽略。否则当私有继承的 `__PI_NATIVE_VARIANT_CACHE` 结果有效时优先使用；只有在此之后加载器才会检测 AVX2：

- Linux 读取 `/proc/cpuinfo`。
- macOS 依次尝试 `/usr/sbin/sysctl` 与 `sysctl`，查询 `machdep.cpu.leaf7_features` 与 `machdep.cpu.features`。
- Windows 调用非交互式 PowerShell 检测 `System.Runtime.Intrinsics.X86.Avx2`。

检测在可用时优先使用 `Bun.spawnSync`，再回退到 `node:child_process`。检测到的结果会写入私有缓存环境项，以便后续 worker/子进程继承相同的决策。非 x64 不会使用或填充变体。

`getAddonFilenames()` 返回：

| 运行时选择         | 有序文件名                                                                                |
| ------------------ | ----------------------------------------------------------------------------------------- |
| modern x64         | `pi_natives.<tag>-modern.node`、`pi_natives.<tag>-baseline.node`、`pi_natives.<tag>.node` |
| baseline x64       | `pi_natives.<tag>-baseline.node`、`pi_natives.<tag>.node`                                 |
| 非 x64 / 无变体    | `pi_natives.<tag>.node`                                                                   |

## 候选项排序

`resolveLoaderCandidates()` 对路径去重并保留首次出现的顺序。

### 已安装、非编译包

1. `@oh-my-pi/pi-natives-<tag>` 中每一个被选中的文件名。
2. 对每个文件名，依次使用包内 `nativeDir`，再使用可执行文件所在目录。

平台叶子目录优先于陈旧的核心产物。工作区加载会刻意跳过叶子目录解析。

### Windows `node_modules` 暂存

当平台为 Windows、运行时为非编译、且 `nativeDir` 包含 `node_modules` 段时：

1. `versionedDir` 中每一个被选中的文件名。
2. 叶子包候选项。
3. 包内与可执行文件候选项。

在探测之前，`maybeStageNodeModulesAddon()` 会将每个可用的文件名从 `leafPackageDir ?? nativeDir` 拷贝到缺失的缓存目标。已存在的缓存文件会被保留。这使得已加载的 DLL 句柄与更新时必须替换的包管理器副本保持隔离。目录或拷贝失败会被记录，常规探测继续进行。

### 编译运行时

1. 对每个文件名，依次使用 `versionedDir`，再使用旧式用户数据目录。
2. 对每个文件名，依次使用包内 `nativeDir`，再使用可执行文件所在目录。

成功选中的嵌入式候选项会被前置。编译模式下禁用 Windows 暂存。

## 嵌入式清单与解压

在普通源码/已发布核心状态下，`embedded-addon.js` 会被重置为 `embeddedAddon = null`。`scripts/embed-native.ts` 可生成匹配的清单，其中包含：

- `platformTag` 与包 `version`；
- gzip 压缩的 tar 归档引用；
- 带有 `variant`、仅含基名的 `filename` 与 `size` 的 `files[]`。

仅在编译模式下，当平台与版本匹配且存在可选文件时才会执行解压。选择规则如下：

- 非 x64：先选 `default`，再选首个文件；
- modern x64：先选 `modern`，再选 `baseline`；
- baseline x64：仅选 `baseline`。

加载器会创建 `versionedDir`。如果每个需要解压的清单文件都已是具有声明大小的常规文件，则直接复用。否则会对 gzip 流解压并解析 tar 归档，仅接受清单允许列表中仅含基名的常规文件项，校验大小，并通过临时文件加重命名的方式写入。缺失、截断、不安全、类型错误和大小错误的条目均为错误。缺少归档的旧清单仍可提供逐文件的 `filePath` 元数据。

解压错误会被累积；加载器会继续尝试常规候选项。

## 候选项校验与加载后设置

对每个候选项：

1. 在启用时输出启动标记。
2. `require(candidate)`。
3. 除非处于工作区开发模式，否则 require 预期的包版本哨兵函数。
4. 如果插件提供，则调用 `__ompInstallTokioRuntime()`。
5. 尽力移除早于当前版本的有效语义版本缓存目录。
6. 返回绑定。

哨兵错误用于区分当前进程中仍驻留的旧插件与磁盘上的陈旧文件。若加载到的导出携带较旧的哨兵，但候选项字节中包含预期的当前哨兵，则诊断信息提示重启；否则提示重新安装。加载器不会校验全部公共导出。

Rust 模块初始化会安装崩溃诊断，但不会在动态加载锁下生成运行时线程。可选的加载后钩子会安装有界 Windows Tokio 与 Rayon 线程池。该钩子是尽力而为的；旧版插件或钩子失败会回退到 napi-rs 行为。设置 `PI_DEBUG_STARTUP` 后，会向 stderr 同步输出 `[startup]` 标记，包括钩子的成功或失败。

缓存清理忽略读取/删除失败，仅移除其解析后的语义版本早于当前包的目录。它会保留当前/未来版本、预发布/非 semver 名称以及常规文件。

## 失败诊断

如果没有任何候选项成功：

- 不支持的标签会抛出 `Unsupported platform: <tag>`，并附带受支持列表与 issue 指引；
- 受支持的标签会抛出 `Failed to load pi_natives native addon for <tag>`（含 x64 变体），随后列出每个候选项/准备阶段的错误以及模式特定的帮助信息。

编译模式的帮助信息会列出预期的缓存路径，建议删除版本化目录，并打印用于下载 release 的 `curl` 命令。已安装包的帮助信息则建议重新安装、本地主机构建（`bun --cwd=packages/natives run build`），以及显式的 `scripts/bazel-natives.ts <target> --dest packages/natives/native` 构建。

## 生命周期

```text
entrypoint evaluates or lazy wrapper is invoked
  -> initialize loader context
  -> extract matching embedded archive, if any
  -> otherwise stage Windows node_modules addon, if applicable
  -> require candidates in deterministic order
       -> validate sentinel outside workspace development
       -> install optional post-load runtime
       -> best-effort clean older version caches
       -> return bindings
  -> no success: throw unsupported-platform or aggregated load error
```
