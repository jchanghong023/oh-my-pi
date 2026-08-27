# 原生模块架构

`@oh-my-pi/pi-natives` 将 JavaScript ESM 加载器与 Rust Node-API 插件结合在一起：

1. **包/加载器层** 负责选择、加载并校验正确的 `.node` 插件，然后暴露生成的具名 ESM 导出。
2. **Rust N-API 层** 实现这些导出，并提供由 napi-rs 生成的 TypeScript 声明文件。

## 权威文件

- `packages/natives/package.json`
- `packages/natives/native/index.js` 和 `index.d.ts`
- `packages/natives/native/loader-state.js` 和 `loader-state.d.ts`
- `packages/natives/native/desktop.js` 和 `desktop.d.ts`
- `packages/natives/native/clipboard.js` 和 `clipboard.d.ts`
- `packages/natives/native/embedded-addon.js`
- `packages/natives/scripts/build-bindings.ts`
- `packages/natives/scripts/embed-native.ts`
- `packages/natives/scripts/gen-enums.ts`
- `packages/natives/scripts/gen-npm-packages.ts`
- `scripts/bazel-natives.ts`
- `crates/pi-natives/src/lib.rs` 及其模块

## 包的入口点

该包导出三个入口点：

| 导入                              | 运行时                 | 类型文件                  | 加载行为                                                                                   |
| --------------------------------- | --------------------- | ----------------------- | --------------------------------------------------------------------------------------- |
| `@oh-my-pi/pi-natives`            | `native/index.js`     | `native/index.d.ts`     | 立即加载插件，然后绑定所有生成的类、函数和枚举对象。                                                  |
| `@oh-my-pi/pi-natives/desktop`    | `native/desktop.js`   | `native/desktop.d.ts`   | 暴露 `createDesktopSession(options)`，并将插件加载延迟到该函数被调用时。                            |
| `@oh-my-pi/pi-natives/clipboard`  | `native/clipboard.js` | `native/clipboard.d.ts` | 暴露惰性的 `copyToClipboard` 和 `readImageFromClipboard` 包装函数。                              |

不存在 `packages/natives/src` 这一包装层。根消费者直接调用生成的 N-API 导出。惰性子路径的存在是为了让工作进程可以在相关操作初始化之前导入其 JS 包装而无需加载体积较大的插件。

当前根能力包括：

- 搜索、通配符匹配、工作区扫描、AST 匹配与编辑、代码摘要、语法高亮、文本布局、Token 计数以及结构化差异；
- shell、PTY、进程、文件锁、隔离以及工作配置原语；
- 桌面捕获、输入与无障碍、剪贴板、音频采集与播放、实时 WebRTC、设备检测、SIXEL、snapcompact 渲染以及向量排序。

## 加载器与分发

`native/index.js` 调用 `loader-state.js` 中的 `loadNative()`。平台标签为 `${process.platform}-${process.arch}`。受支持的标签有：

- `linux-x64`
- `linux-arm64`
- `darwin-x64`
- `darwin-arm64`
- `win32-x64`

x64 构建具有 `modern`（x86-64-v3/AVX2）和 `baseline`（x86-64-v2）两个变体。可通过 `PI_NATIVE_VARIANT=modern|baseline` 覆盖自动检测。自动检测在 Linux 上读取 `/proc/cpuinfo`，在 macOS 上调用 `sysctl`，或在 Windows 上通过 PowerShell 查询 `System.Runtime.Intrinsics.X86.Avx2`。其结果会通过私有的 `__PI_NATIVE_VARIANT_CACHE` 环境变量被后续的工作进程和子进程继承。非 x64 构建使用不带后缀的文件名。

文件名回退顺序为：

- modern x64：`-modern.node`，然后是 `-baseline.node`，最后是不带后缀的 `.node`；
- baseline x64：`-baseline.node`，然后是不带后缀的 `.node`；
- 非 x64：仅使用不带后缀的 `.node`。

发布的核心包包含加载器 JS、声明文件及元数据，但不包含任何 `.node` 文件。发布过程中会生成 `@oh-my-pi/pi-natives-<platform>-<arch>` 可选依赖的叶子包，并以相同版本注入到核心清单中。`gen-npm-packages.ts` 中的 `LEAF_TARGETS` 是权威的发布目标列表。

### 候选项所有权与顺序

对于正常安装的包，平台叶子包会先于核心包的 `native/` 目录以及 `process.execPath` 目录被探测。工作区开发模式会跳过叶子包解析，以保证本地制品优先。

编译模式通过已填充的嵌入式清单、`PI_COMPILED` 或 `import.meta.url` 中的 Bun 嵌入标记来检测。它会先于包/可执行文件位置探测版本化缓存以及旧版用户数据目录。`getNativesDir()` 仅在 `$XDG_DATA_HOME/omp` 已存在时为 `$XDG_DATA_HOME/omp/natives`，否则为 `~/.omp/natives`。

已填充的清单会引用 `embedded-addons.<tag>.tar.gz`。解压过程仅允许清单中列出的、仅有基名的常规文件，以原子方式写入 `<getNativesDir()>/<version>`，并校验文件大小。在 Windows 上的 `node_modules` 安装中，加载器会在该版本化目录中暂存一个叶子包/核心包插件，以避免在更新过程中正在运行的进程锁定了 Bun 必须替换的副本。

插件成功加载后，加载器会尽力移除其有效语义版本早于当前包的缓存目录。当前版本、未来版本以及非 semver 的目录会保留。

## 加载校验与运行时初始化

每个已安装或已编译的候选项都必须暴露由 `package.json#version` 计算出的版本哨兵，例如 `__piNativesV17_2_5`。工作区加载会跳过此检查。加载器不会校验完整的符号列表。

在 `require(...)` 与哨兵校验之后，若存在 `__ompInstallTokioRuntime()`，加载器会调用它。Rust 刻意避免在动态加载器锁被持有时，于 `#[module_init]` 期间创建工作线程。加载后的钩子会安装有界 Windows Tokio/Rayon 线程池；没有该钩子的旧插件则使用 napi-rs 的默认设置。钩子失败时仅尽力处理，且仅在启用了启动标记时才会出现。

设置 `PI_DEBUG_STARTUP` 会在插件加载、解压以及运行时安装阶段向 stderr 输出同步的 `[startup]` 标记。

## Rust 模块归属

`crates/pi-natives/src/lib.rs` 注册了当前的模块：

- 平台/运行时：`appearance`、`clipboard`、`crash_handler`、`desktop`、`devicecheck`、`file_lock`、`iofs`、`power`、`prof`、`ps`、`pty`、`shell`；
- 媒体/实时：`audio`、`live`、`sixel`、`snapcompact`；
- 代码/数据：`ast`、`block`、`diff`、`fd`、`glob`、`glob_util`、`grep`、`highlight`、`html`、`keys`、`summary`、`text`、`tokens`、`vectors`、`workspace`；
- 隔离/任务支持：`iso`、`task`，crate 私有的 `utils`，以及仅用于测试的 `testing`；
- 从 `pi_ast::language` 重新导出的语言元数据。

Rust 的 `#[napi]` 函数、类、对象和枚举会生成声明表面。默认的 snake_case Rust 名称会变为 camelCase 的 JavaScript 名称。

## 职责边界

- **包/脚本** 负责二进制选择、CPU 变体、可选叶子包解析、嵌入式解压、Windows 暂存、声明文件以及显式的 ESM 导出。
- **`pi-natives` 及支持 crate** 负责算法、原生资源、平台行为、取消机制以及 N-API 转换。
- **消费者** 负责更上层的工具策略、渲染、制品以及原语中未编码的面向用户的回退。

有关支持 crate 的对应关系，请参阅 [`native-crates.md`](./native-crates.md)。有关加载器精确诊断信息，请参阅 [`natives-addon-loader-runtime.md`](./natives-addon-loader-runtime.md)。

## 运行时流程

1. 消费者导入热加载的根入口或惰性子路径。
2. `loadNative()` 计算模式、平台、变体、文件名以及有序的候选项。
3. 嵌入式解压或 Windows 暂存可能将缓存候选项置于最前。
4. 按顺序 `require` 候选项，并对已安装/已编译的加载进行哨兵校验。
5. 可选的加载后运行时钩子运行，然后尽力清理过期的缓存版本。
6. 根入口绑定生成的具名导出；惰性子路径通过包装函数调用所选绑定。
7. 调用方调用 N-API 函数/类；napi-rs 执行参数与结果的转换。