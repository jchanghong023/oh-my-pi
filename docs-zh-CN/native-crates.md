# Native Crates

`crates/` 下 Rust workspace 成员的贡献者导览。它们是 `@oh-my-pi/pi-natives` 及其内嵌 shell 背后的实现细节；包的消费者使用 JavaScript 入口点，而非这些 crate 的 API。

根目录的 `Cargo.toml` 在 `workspace.members` 中显式列出了 `crates/` 下的每一个 crate —— 在那里添加新 crate。它还会把 crates.io 上的 `brush-core` patch 为 vendored 副本。

## First-party crates

| Crate           | Path                                              | Role and consumers                                                                                                                                              |
| --------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pi-natives`    | [`crates/pi-natives`](../crates/pi-natives)       | 顶层 N-API `cdylib`。它对外暴露 JS 可见的 API，并依赖 `pi-ast`、`pi-iso`、`pi-shell`、`pi-voice` 和 `pi-walker`。                              |
| `pi-builtins`   | [`crates/pi-builtins`](../crates/pi-builtins)     | 内嵌 shell 所安装的全部 builtin：一份 brush POSIX/bash builtin 的 patch 派生版，加上每个进程内命令行实用工具对应的一个模块（`cat`、`grep`/`rg`、`sed`、`ls`、`find`、`jq`、`fd`、`diff`、`ps`、`top`、`kill`、moreutils 套件……）。`src/host.rs` 包含 `Utility` trait 以及 shell 的 `Host` 视图（标准 I/O、工作目录、对外导出的环境、取消机制），各实用工具在此之上运行。uutils coreutils/findutils/sed 与 jaq 的移植也位于此处；第三方声明请见该 crate 的 `LICENSE`。 |
| `pi-shell`      | [`crates/pi-shell`](../crates/pi-shell)           | 由 `pi-natives` 使用的常驻内嵌 brush shell、命令执行与最小化、进程管道、文件系统遍历以及进程内命令集成。 |
| `pi-voice`      | [`crates/pi-voice`](../crates/pi-voice)           | `AudioCapture`、`AudioPlayback` 与 `LiveWebRtcPeer` 绑定所使用的跨平台麦克风/回放与 Opus/WebRTC 支持。                          |
| `pi-ast`        | [`crates/pi-ast`](../crates/pi-ast)               | 跨工作区语法集合的 tree-sitter/ast-grep 语言注册、匹配/编辑、块分析与摘要支持。                           |
| `pi-iso`        | [`crates/pi-iso`](../crates/pi-iso)               | APFS、Linux/Windows clone/reflink 路径、overlayfs、ProjFS 的隔离后端实现与差异计算，以及递归复制的回退方案。                      |
| `pi-walker`     | [`crates/pi-walker`](../crates/pi-walker)         | 基于 ignore 规则与 globsets 的并行、可感知缓存的文件系统遍历器；由原生 grep/glob/workspace 路径以及 shell 命令共享。                         |

## Vendored workspace crates

| Group | Paths | Purpose |
| ----- | ----- | ------- |
| Brush | [`crates/vendor/brush-core`](../crates/vendor/brush-core) | 由 `pi-shell` 与 `pi-builtins` 使用的 vendored shell 引擎。其清单保留上游包的元数据；通过一条 workspace patch 选择该本地派生版本。 |

`pi_builtins::utility_builtins()` 与 `pi_builtins::process_builtins()` 是链接进内嵌 shell 的命令的权威列表；`pi-shell` 决定注册其中的哪些。仅作为 workspace 成员并不等同于 `pi-natives` 将其作为 JavaScript API 对外暴露。

## Boundary map

```text
@oh-my-pi/pi-natives JS entrypoints
  -> pi-natives (N-API conversion, platform bindings, task boundaries)
       -> pi-ast / pi-iso / pi-voice / pi-walker
       -> pi-shell
            -> brush-core (parser, expansion, interpreter)
            -> pi-builtins (bash builtins + utility builtins; host.rs: per-invocation I/O and cwd)
```

关于加载器与 JS 边界，参见：

- [`natives-architecture.md`](./natives-architecture.md)
- [`natives-addon-loader-runtime.md`](./natives-addon-loader-runtime.md)
- [`natives-binding-contract.md`](./natives-binding-contract.md)

子系统细节位于：

- [`natives-build-release-debugging.md`](./natives-build-release-debugging.md)
- [`natives-media-system-utils.md`](./natives-media-system-utils.md)
- [`natives-rust-task-cancellation.md`](./natives-rust-task-cancellation.md)
- [`natives-shell-pty-process.md`](./natives-shell-pty-process.md)
- [`natives-text-search-pipeline.md`](./natives-text-search-pipeline.md)
- [`fs-scan-cache-architecture.md`](./fs-scan-cache-architecture.md)

## Documentation policy

这些 crate 仍是面向贡献者的实现细节。仅当某个 crate 获得了独立于 `@oh-my-pi/pi-natives` 之外被使用的公开 API 或可执行入口时，才将其提升为独立的面向用户的文档；请参见 [`user-facing-packages.md`](./user-facing-packages.md)。
