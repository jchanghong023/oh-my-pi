# 将热路径移植到 `pi-natives`

这是将经过实测的 JS/TS 热路径迁移到 `crates/pi-natives` 并通过 `@oh-my-pi/pi-natives` 暴露的贡献者路径。

## 判断是否需要移植

当原生代码能够消除已证实的 CPU、阻塞 I/O、内存分配或平台集成开销，且边界可以保持面向数据时，进行移植。当工作严重依赖 JS 对象身份、动态导入、回调到应用状态，或原生转换成本会抵消收益时，保留在 JS 中。

从一个行为兼容的 JS 基线和有代表性的输入开始。一个存在但更慢或行为不同的原生导出并不是一次成功的移植。

## 当前包与构建拆分

本包没有 `packages/natives/src/<module>` 包装层。其入口点为：

- 急切加载的根：`native/index.js` 以及生成的 `native/index.d.ts`；
- 惰性加载的桌面包装：`native/desktop.js` / `desktop.d.ts`；
- 惰性加载的剪贴板包装：`native/clipboard.js` / `clipboard.d.ts`。

两个命令用途不同：

- `bun --cwd=packages/natives run build:bindings` 为宿主运行 napi-rs，安装本地变体 addon 和生成的声明，并重新生成显式的 ESM/enum 导出。当 Rust 公共类型表面发生变化时使用此命令。
- `bun --cwd=packages/natives run build` 调用 `scripts/bazel-natives.ts host --dest native`。宿主目标默认通过本地 cargo/napi-rs 后端构建（`OMP_NATIVE_BUILD_BACKEND=bazel` 选择 bazel），但不会重新生成声明。

发布构建使用 Bazel 目标，并将 `.node` 文件发布到平台 leaf 包中。核心发布重写会移除 addon 并注入由 `gen-npm-packages.ts` 中 `LEAF_TARGETS` 生成的同版本可选依赖。

## 设计 N-API 边界

1. 将实现放在所属的 `crates/pi-natives/src/<module>.rs` 中；在 `lib.rs` 中注册新模块。
2. 在可行的情况下，将计算保留在普通 Rust 函数中，然后暴露一个轻量的 `#[napi]` 边界。
3. 优先使用拥有所有权的 N-API 兼容值：`String`、向量、类型化数组，以及 `#[napi(object)]` option/result 结构体。避免使用其生命周期无法跨越 N-API 工作的借用公共输入。
4. 让 napi-rs 应用默认的 snake_case 到 camelCase 名称转换，除非某个公共名称有意需要 `js_name`。
5. 保留 JS 契约：null/undefined 区分、顺序、错误与结果语义、回调时机，以及同步与 Promise 行为。

### 工作调度与取消

- 对 CPU 密集或阻塞型工作使用 `task::blocking(tag, cancel_token, work)`。它会返回一个 `AsyncTask`，对工作进行性能分析，并在 panic 跨越异步工作 FFI 边界前捕获它们。
- 对 Tokio 异步 I/O 使用 `task::future(env, tag, future)`。它通过 `Env::spawn_future` 返回一个 `PromiseRaw`。
- 当公共选项暴露 `timeoutMs` 或 `AbortSignal` 时，构建 `task::CancelToken::new(timeout_ms, signal)` 并在阻塞循环中按有意义的间隔调用 `heartbeat()`。取消是协作式的；一个从未被检查的 token 不会停止工作。
- 不要在模块初始化中创建运行时或工作线程池。JS 加载器在动态加载器锁释放后执行可选的 `__ompInstallTokioRuntime` 加载后步骤。

匹配具有相同调度/错误形状的现有导出，而不是引入第二种约定。

## 端到端检查清单

### 1. 实现并暴露

- 添加 Rust 逻辑，并在需要时为纯不变量添加有针对性的 Rust 测试。
- 添加 `#[napi]` 项以及 object/enum 类型。
- 在 `crates/pi-natives/src/lib.rs` 中注册新模块。
- 如果移植使用了另一个第一方 crate，请将其依赖添加到 `crates/pi-natives/Cargo.toml` 及其原生构建所需的构建系统输入中。

### 2. 重新生成并检查绑定

运行：

```bash
bun --cwd=packages/natives run build:bindings
```

然后验证：

- `native/index.d.ts` 包含预期的 JS 名称、精确的输入/结果类型、回调形状以及同步/Promise 返回；
- `native/index.js` 中标记的生成块包含 class/function 导出；
- 已更改的 enum 同时具有声明和字面量运行时对象。

`gen-enums.ts` 通过读取顶层 `export declare class`、`export declare function` 以及 enum 声明来派生导出。声明中缺失的项不会成为命名的根 ESM 导出。

### 3. 仅在有正当理由时添加惰性入口点

根会急切加载 addon。如果某个 worker 必须在不付出该启动成本的情况下导入，请遵循 desktop/clipboard 模式：

- 一个小型 JS 包装在导出函数内部调用 `loadNative()`；
- 匹配的 `.d.ts` 导入/重新导出根类型；
- `package.json#exports` 同时提供 `types` 和 `import` 路径。

不要仅仅为了重命名生成的根导出而添加包装。

### 4. 干净地迁移消费者

- 从 `@oh-my-pi/pi-natives` 导入生成的根符号或有意为之的惰性子路径。
- 在边界用例上将结果和错误与 JS 基线进行比较。
- 在同一次变更中切换所有预期的调用方并移除过时的实现。
- 当原生原语不拥有面向用户的策略和渲染时，将它们保留在消费者中。

### 5. 对有代表性的工作进行基准测试

将一个持久的基准测试放在所属包中（`packages/natives/bench`、`packages/tui/bench`、`packages/coding-agent/bench` 或其他现有包基准测试目录）。在同一进程中，在相同的准备输入上运行 JS 和原生实现。当调用方可以复用设置时，将设置/转换与计时操作分开。

```ts
const ITERATIONS = 2_000;

function bench(name: string, fn: () => void): number {
  const start = Bun.nanoseconds();
  for (let i = 0; i < ITERATIONS; i++) fn();
  const elapsedMs = (Bun.nanoseconds() - start) / 1e6;
  console.log(
    `${name}: ${elapsedMs.toFixed(2)}ms (${(elapsedMs / ITERATIONS).toFixed(6)}ms/op)`,
  );
  return elapsedMs;
}

bench("feature/js", () => jsImpl(sample));
bench("feature/native", () => nativeImpl(sample));
```

对于返回 Promise 的操作，使用异步基准测试循环并 await 每个调用；不要仅对 promise 创建进行计时。

### 6. 验证已加载的产物

针对刚刚构建的 addon 运行窄场景。在诊断候选不匹配时，检查加载器报告的候选路径：

```bash
bun -e 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url); const mod = require(process.argv[1]); console.log(Object.keys(mod).sort())' -- /path/to/pi_natives.<tag>[-variant].node
```

确认导出和包版本哨兵都存在。不要为必需的导出添加可选的消费者检查来掩盖产物不匹配。

## 常见失败

### 过时的变体或缓存获胜

对于现代宿主，x64 候选顺序为 modern → baseline → unsuffixed；对于基线宿主，候选顺序为 baseline → unsuffixed。已编译和暂存的 Windows 加载也可能先于包路径从 `<getNativesDir()>/<version>` 获胜。

仅移除加载器诊断所标识的过时本地产物/缓存，然后重新构建。加载器在成功加载后会尽力从有效旧版本中删除缓存目录，但它会刻意保留当前版本目录。

### 声明已更改但发布的 addon 没有更改

`build:bindings` 负责声明生成；`build` 负责 Bazel 宿主产物。CI/发布目标负责跨平台产物。验证生成的源代码控制输出和场景实际使用的二进制两者。

### 同版本的不完整 addon

哨兵证明的是发布版本，而非完整的导出集。本地生成的同版本二进制可以通过加载，但缺少新生成的成员。检查实际候选上的 `Object.keys` 并重新构建；不要削弱调用方。

### 运行时 enum 缺失

仅 napi-rs enum 声明不会提供根的字面量运行时对象。运行 `build:bindings` 并验证生成块。如果 `gen-enums.ts` 无法解析声明形状，请修复生成器，而不是手动编辑其标记块。

### 错误的同步/异步假设

以 `native/index.d.ts` 为权威。例如，`renderSnapcompactPng` 返回 `Promise<string>`，而 `snapcompactSupportedChars` 是同步的。改变调用方式的移植需要有意的消费者迁移。

## 完成标准

只有在生成的声明和 ESM 导出与 Rust API 匹配、预期的消费者正在使用它、过时的 JS 代码已被移除、针对已构建 addon 的有针对性真实调用成功，且代表性比较显示可接受的行为和性能时，移植才告完成。
