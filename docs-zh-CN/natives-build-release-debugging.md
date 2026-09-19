# 原生模块构建、发布与调试运行手册

本运行手册介绍 `@oh-my-pi/pi-natives` 如何生成 `.node` 插件、生成的声明以及已编译二进制内嵌产物，并说明如何调试加载器与构建失败。

发布插件由 Bazel（`rules_rust` + `crate_universe` + 密封 cc 工具链）构建，`win32-arm64` 除外 —— 它在 GitHub 的 Windows ARM64 runner 上通过 Cargo/N-API 原生构建。cargo workspace 对本地 Rust 迭代（rust-analyzer、`cargo nextest`）以及宿主机构建保持权威。运行时加载与内嵌机制没有变化。

它遵循 `docs/natives-architecture.md` 中的架构术语：

- **构建期产物生成**（通过 `scripts/bazel-natives.ts` 使用 Bazel `//:natives-<target>` 或由 Cargo 支持的 `host` 目标）
- **内嵌插件清单生成**（`scripts/embed-native.ts`）
- **运行时插件加载**（`native/index.js`、`native/loader-state.js`）

## 实现文件

构建侧：

- `BUILD.bazel`（根目录）— 八个 `//:natives-<target>` 插件目标 + 聚合 filegroup
- `bazel/defs.bzl` — `native_addon` 规则/transition
- `bazel/platforms/BUILD.bazel` — 每个已发布插件一个 `platform()`
- `bazel/variants/BUILD.bazel` — `baseline`/`modern` ISA constraint 取值
- `bazel/toolchains/` — musl rustc 消歧 + msvc 交叉 cc 工具链（`msvc/NOTES.md`）
- `bazel/clippy.bazelrc` — 由 `Cargo.toml` 中的 `[workspace.lints]` 生成
- `MODULE.bazel`、`MODULE.bazel.lock`、`.bazelrc`、`.bazelversion`（Bazel 9.2.0）
- `scripts/bazel-natives.ts` — 标准驱动（构建 + 定位 + 安装）
- `crates/pi-natives/BUILD.bazel`、`crates/pi-natives/Cargo.toml`

包侧（运行时/打包不变）：

- `packages/natives/scripts/build-bindings.ts` — 宿主机 Cargo/N-API 构建与 typedef 重新生成
- `packages/natives/scripts/embed-native.ts`、`gen-enums.ts`、`gen-npm-packages.ts`
- `packages/natives/package.json`
- `packages/natives/native/index.js`、`native/loader-state.js`

## 构建架构

### 1) `//:natives-<target>` 插件目标

根 `BUILD.bazel` 为每个由 Bazel 构建的 `(platform, arch, ISA-variant)` 实例化一个 `native_addon`：

| 目标                                 | 平台                                        | 规范输出                              |
| ------------------------------------ | ------------------------------------------- | ------------------------------------- |
| `//:natives-linux-x64-baseline`      | `//bazel/platforms:linux-x64-baseline`      | `pi_natives.linux-x64-baseline.node`  |
| `//:natives-linux-x64-modern`        | `//bazel/platforms:linux-x64-modern`        | `pi_natives.linux-x64-modern.node`    |
| `//:natives-linux-arm64`             | `//bazel/platforms:linux-arm64`             | `pi_natives.linux-arm64.node`         |
| `//:natives-linux-musl-x64-baseline` | `//bazel/platforms:linux-musl-x64-baseline` | `pi_natives.linux-x64-baseline.node`  |
| `//:natives-linux-musl-arm64`        | `//bazel/platforms:linux-musl-arm64`        | `pi_natives.linux-arm64.node`         |
| `//:natives-darwin-x64-baseline`     | `//bazel/platforms:darwin-x64-baseline`     | `pi_natives.darwin-x64-baseline.node` |
| `//:natives-darwin-arm64`            | `//bazel/platforms:darwin-arm64`            | `pi_natives.darwin-arm64.node`        |
| `//:natives-win32-x64-baseline`      | `//bazel/platforms:win32-x64-baseline`      | `pi_natives.win32-x64-baseline.node`  |

备注：

- Windows ARM64 没有 Bazel 目标：发布矩阵在 `windows-11-arm` 上通过 Cargo/N-API 构建 `host`，产出 `pi_natives.win32-arm64.node`。
- musl 插件**有意复用**纯 `linux-<arch>` 文件名 —— 加载器永远不会同时看到 gnu 与 musl；发布作业将它们保留在各自独立的调用/dest 目录中（`scripts/bazel-natives.ts` 在同一次运行内出现 basename 冲突时会硬报错）。
- 聚合目标：`//:natives-linux-all`（所有 linux 目标 + msvc 交叉构建，即从 linux-x64 宿主机上可构建的全部内容）以及 `//:natives-darwin-all`（仅限 mac 宿主机）。

### 2) `native_addon` 规则（`bazel/defs.bzl`）

`native_addon` 把 `//crates/pi-natives:pi_natives`（一个 `rust_shared_library`）包装进一个 configuration transition，按目标固定以下内容：

- `--platforms=<the addon's platform>`
- `--compilation_mode=opt`
- `@rules_rust//rust/settings:lto=thin`
- 额外的 rustc flags `-Ccodegen-units=16 -Cstrip=symbols`

这与旧的 cargo `ci` profile 一致。由于该 profile 位于 **transition 内部**，一条裸的 `bazel build //:natives-<t>` 无论 `-c` 如何都始终是发布级构建，并且每个插件对每个 (platform, source) 组合共享同一个缓存条目。随后该规则会把生成的共享库符号链接到加载器规范的 `pi_natives.<platform>-<arch>[-<variant>].node` 名称，并限定在该规则名下（`bazel-bin/natives-<t>/…`），因此 basename 相同的 gnu/musl 输出不会在包层级发生冲突。

不属于 transition 的按目标 codegen 位于 `crates/pi-natives/BUILD.bazel` 的 `rustc_flags` selects 中：通过 `//bazel/variants` 指定 `-Ctarget-cpu=x86-64-v2`（baseline）/ `x86-64-v3`（modern），napi 链接参数（macOS 上为 `-Wl,-undefined,dynamic_lookup`，linux 上为 `-Wl,-z,nodelete` —— 刻意不接入 `build.rs`/`napi_build::setup()`），musl 的 `-Ctarget-feature=-crt-static`，以及 win32-x64 msvc 的 `-Ctarget-feature=+crt-static`（与 `native_addon` transition 中启用的 `static_link_msvcrt` cc feature 配套，使 C 依赖同步以 `/MT` 编译 —— 由此发布的 `.node` 不再从 VC++ Redistributable 导入任何 `VCRUNTIME140.dll`）。Cargo 宿主机路径在 `build-bindings.ts` 中对 Windows ARM64 应用同样的 `+crt-static` 策略。

### 3) 平台与工具链

| 目标家族               | cc 工具链                                                                  | 备注                                                                                                  |
| ---------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| linux gnu (x64/arm64)  | `@zig_sdk//libc_aware/toolchain:linux_*_gnu.2.17`（密封 zig cc）            | glibc **2.17** 可移植性下限 —— 与之前交叉构建所用的下限相同                                            |
| linux musl (x64/arm64) | `@zig_sdk//libc_aware/toolchain:linux_*_musl`                              | 动态 CRT（crate BUILD 中的 `-Ctarget-feature=-crt-static`）                                            |
| darwin (x64/arm64)     | 宿主机 Xcode 工具链                                                        | Apple frameworks 不可再分发；darwin 插件只能在 mac 宿主机上构建                                        |
| win32-x64 msvc         | `//bazel/toolchains/msvc`（`@msvc_cc`）：clang-cl + lld-link + xwin CRT/SDK | 从 linux-x64 CI pod 与 darwin 开发宿主机进行密封交叉链接；**static CRT**（`+crt-static` + `static_link_msvcrt`）使插件无需 VC++ Redistributable；见 `bazel/toolchains/msvc/NOTES.md` |
| win32-arm64 msvc       | `windows-11-arm` 上的原生 Visual Studio ARM64 工具                        | 使用静态 CRT 的 Cargo/N-API 宿主机构建；产出的二进制与插件在同一 runner 上做冒烟测试                   |

Rust 工具链为 nightly（在 `MODULE.bazel` 中固定），并在 `//bazel/toolchains` 中对 musl 做 repo-local 重新注册，携带显式的 `@zig_sdk//libc:musl` constraint（否则 rules_rust 生成的 gnu 与 musl 工具链会共享 (os, cpu) constraint）。

### 4) 第三方 crate（`crate_universe`）

`@crates//...` 由工作区的 `Cargo.toml`/`Cargo.lock` 生成，且严格限定为七个 Bazel triple。Windows ARM64 的 Cargo 构建直接解析同一份工作区 lock。Crate 专属的构建修复以 `crate.annotation` 形式存在于 `MODULE.bazel` 中（见下方调试 playbook）。

根模块有意省略 `crate_universe` 可选的 rendering lock。crate 输入变更后的第一次 evaluation 会拼接工作区并根据已固定的 `Cargo.lock` 生成 external repository 规约；Bazel 会把该扩展结果记录进 `MODULE.bazel.lock`，因此之后清理过的 output base 可以复用它。因此，编辑 Cargo manifest、lock 与 annotation 都不需要单独的重新固定步骤。

## 本地开发

### 构建插件

```bash
# Addon for the current host (x64 hosts pick modern vs baseline via AVX2
# detection), installed into packages/natives/native/. The host target builds
# through the local cargo/napi-rs backend by default; set
# OMP_NATIVE_BUILD_BACKEND=bazel (or pass bazel args after `--`) for bazel:
bun --cwd=packages/natives run build          # = bun ../../scripts/bazel-natives.ts host --dest native
# same, from the repo root:
bun run build:native

# The driver directly — targets are //:natives-* names plus pseudo-targets
# host / linux-all / darwin-all:
bun scripts/bazel-natives.ts <target>... [--dest <dir>] [-- <extra bazel args>]
bun scripts/bazel-natives.ts linux-x64-baseline linux-x64-modern --dest packages/natives/native
bun scripts/bazel-natives.ts darwin-all

# Or bazelisk directly (outputs stay in bazel-bin, nothing is installed):
bazelisk build //:natives-darwin-arm64
bazelisk build //:natives-linux-all
```

驱动的行为是：除非通过 `OMP_NATIVE_BUILD_BACKEND=bazel` 或额外 bazel 参数请求 bazel，否则它通过本地 cargo/napi-rs 路径（`packages/natives/scripts/build-bindings.ts`）构建 `host`。对于显式目标，它会针对所有请求目标运行一次 `bazel build`，通过 `bazel cquery --output=files` 定位输出（回退到 `bazel-bin/natives-<t>/<canonical>.node` 路径约定），并把它们解引用后拷贝进 `--dest`（默认 `packages/natives/native`）。`--` 之后的额外参数原样传给 bazel。它从 `PATH` 解析 `bazelisk`（或 `bazel`），并把 `OMP_BAZEL_RC` 环境变量作为 `--bazelrc=` 启动选项处理（CI 就是这样注入缓存配置的）。

把 `linux-all` 构建进同一个 dest 会用 musl 插件覆盖 gnu 插件（basename 相同）—— 驱动会拒绝；请使用各自独立的 `--dest` 目录分别调用。

### typedef 重新生成（napi CLI，仅开发期）

`native/index.js`/`index.d.ts` 是**已提交**的，因此 Bazel 产物构建从不需要 napi CLI。只有当 Rust API 表面改变了其导出的 typedef 时：

```bash
bun --cwd=packages/natives run build:bindings   # = bun scripts/build-bindings.ts
```

这会在 `crates/pi-natives` 上运行 napi CLI（仅宿主机、本地 cargo profile），安装重新生成的 `index.d.ts`，规范化插件文件名，并通过 `gen-enums.ts` 重新渲染显式 ESM exports 与运行时 enum 对象。提交由此产生的 `index.js`/`index.d.ts` 变更。

### 可选启用的远程缓存（`.bazelrc.user`）

`.bazelrc` 以 `try-import %workspace%/.bazelrc.user` 结尾（已被 gitignore）。bazel-remote 端点仅在集群内部可达；如果你能访问它（VPN/tailnet），可以将其配置为只读：

```
# .bazelrc.user
build --config=cache-ro
build --remote_cache=grpcs://bazel-remote.bazel-cache.svc.cluster.local:9092
build --tls_certificate=infra/bazel-remote/ca.crt
```

`.bazelrc` 中的 `cache-ro`/`cache-rw` 只承载策略（upload 开关、`--remote_local_fallback`、重试/超时，使缓存故障永远不会导致构建失败）；端点与凭据始终由使用者组合。这里写一行普通的 `--disk_cache=<dir>` 也同样可行。

## CI

### 拆分 Rust 验证与插件产物生成

`.github/workflows/ci.yml` 将 `rust_validate` 与 `native_addons` 分开；TypeScript 作业仅依赖 `native_addons`。

**Pull request 永不构建或验证 Rust。** 涉及原生的 PR 足够罕见，不值得在 PR 侧做 bazel 构建：`rust_validate` 会被完全跳过（`if: github.event_name != 'pull_request'`），而 `native_addons` 会从 `@oh-my-pi/pi-natives-linux-x64` npm 叶子包获取最新发布版的 Linux x64 插件对，对两者做冒烟加载，并把它们上传为 `native-addons` workflow artifact。加载器对 workspace 加载跳过其版本哨兵，因此带发布版本的插件在更新的 checkout 下也能正常加载。其 TypeScript 测试依赖已变更原生行为的 PR 会以可见方式失败（CI 还会在任何触及原生的 PR 上发出提示）；Rust 侧在合并后的 main 上验证，并在发布时再次验证。

在非 PR 事件中，两个作业都在 `omp-kata` pod 上针对集群远程缓存运行。`rust_validate` 运行：

```bash
bazelisk --bazelrc="$rc" test //crates/...                 # full Rust suite
# clippy scope mirrors `cargo clippy --workspace` (libraries only), split by
# lint policy via a query kind filter:
bazelisk query "kind('rust_library|rust_shared_library', //crates/pi-ast/... + //crates/pi-iso/... + //crates/pi-natives/... + //crates/pi-shell/... + //crates/pi-voice/... + //crates/pi-walker/...)" \
  | xargs bazelisk --bazelrc="$rc" build --config=clippy-strict --
bazelisk query "kind('rust_library|rust_shared_library', //crates/... - (…strict set…) - //crates/vendor/brush-core/... - //crates/pi-builtins/...)" \
  | xargs bazelisk --bazelrc="$rc" build --config=clippy --
bazelisk --bazelrc="$rc" build --config=rustfmt //crates/...
```

- `--config=clippy` = rules_rust clippy aspect + `-Dwarnings`；`--config=clippy-strict` 为带有 `[lints] workspace = true` 的 crate 叠加生成的 `bazel/clippy.bazelrc`。
- `--config=rustfmt` = 针对工作区 `rustfmt.toml` 的 rustfmt aspect。

main 上的 `native_addons` 会逐个构建六个 Linux 宿主机目标以避免并发链接 OOM，然后构建 `//:natives-linux-all` 作为聚合一致性检查。它把每个 `.node` 输出上传为 `native-addons` workflow artifact。下游作业使用 `.github/actions/native-artifacts` 下载该 artifact，并在不调用 Bazel 的情况下安装所请求的目标集合。

Bazel 原生作业不需要任何工具链设置：bazelisk 已随 GitHub 镜像提供并烘焙进 kata runner 镜像，而 Bazel 以密封方式拉取 Rust/zig/LLVM/xwin。Windows ARM64 宿主机构建使用安装在 `windows-11-arm` 上的 Rust、Ninja、CMake 与 Visual Studio ARM64 工具；`rust-toolchain.toml` 选择固定的 nightly。

### 托管缓存预热

`.github/workflows/bazel-cache-warm.yml` 为那些没有其他可靠生产者的 GitHub 托管缓存做种：`release-darwin-*` bazel 磁盘缓存（在与 `release_binary_hosted` 矩阵的 Darwin 分支相同的 macOS 镜像上构建，因此一次发布的 bazel 构建只是版本升级的增量，而不是约 40 分钟的冷图）以及 PR 作业会恢复但从不保存的共享 bun store 条目。它只在可能改变这些归档的推送上触发（crate/bazel/lock 输入、`bun.lock`、`.github/**`）。

### `bazel-cache` action（`.github/actions/bazel-cache`）

缓存配置的唯一事实来源，以 bazelrc 片段的形式输出（其 `rc` 输出），使用者通过 `bazelisk --bazelrc=...` 或 `OMP_BAZEL_RC` 传入。通过 `BAZEL_REMOTE_USER`/`BAZEL_REMOTE_PASSWORD` 选择两种模式：

| Runner        | 片段内容                                                                                                                                                                                            |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| omp-kata pod  | 一个临时 output root、`--config=ci`、由 PVC 支持的 repository/xwin 缓存、`--config=cache-rw`、集群内 TLS remote-cache 端点与经掩码处理的 Basic-auth 头，外加 `--remote_download_toplevel` |
| GitHub-hosted | `--config=ci`、`--disk_cache=$HOME/.cache/omp-bazel-disk` 以及 `--repository_cache=$HOME/.cache/omp-bazel-repo`                                                                                              |

托管磁盘缓存使用 `bazel-disk-v3-<scope>-<os>-<arch>-<config-hash>-<source-hash>`。config hash 覆盖 Cargo/Bazel/工具链设置；source hash 覆盖 `crates/**` 与根 `BUILD.bazel`。恢复从精确 key 回退到 config 范围前缀，再回退到裸 `<scope>-<os>-<arch>` 前缀 —— 正是这个裸回退让发布版本升级（会重写 `Cargo.toml`/`Cargo.lock`，从而改变 config hash）不至于冷重建；bazel 的 content-addressed action key 使陈旧的归档只是部分命中，而绝不会产生错误输出。一次不精确恢复允许进行一次刷新的精确 key 保存。托管构建之前，14 天内未被触碰的磁盘缓存文件会被修剪；repository 缓存内容刻意不按时间修剪，因为解压出的文件保留了上游 mtime。远程端点只在集群内部可解析。

### 原生产物 action

`.github/actions/bazel-natives` 是直接构建器：`bazel-cache` → `OMP_BAZEL_RC=<rc> bun scripts/bazel-natives.ts <targets> --dest <dest>`，随后在托管未命中之后进行一次磁盘缓存保存。`.github/actions/native-artifacts` 是无构建的消费者：下载 `native-addons` → 用 `--source` 运行同一个驱动。

### 发布二进制构建与发布

二进制构建只做构建，并与测试扇出并行运行。`release_binary`（Linux 加上交叉构建的 win32-x64）只需要 `native_addons`，其 workflow artifact 提供所需的插件。`release_binary_hosted` 只需要 `release_metadata`，并在检测到发布时启动：每个 Darwin 分支通过 `bazel-natives` 以 scope `release-<target_id>` 构建（由预热 workflow 在接近 HEAD 处做种），而 `windows-11-arm` 分支通过 Cargo/N-API 构建其原生插件。每个分支随后运行 `bun run ci:release:build-binaries`，并在其目标架构上对可执行文件做冒烟测试。发布被挡在 `release_gate` 之后：`release_native_leaves` 下载所有已构建的插件，并在一个 Linux runner 上发布六个 `@oh-my-pi/pi-natives-<tag>` 叶子包，GitHub release / verify / core npm 链路则在一旁并行运行。

## 调试 playbook

### 产物位置 / 如何检查

```bash
# Outputs (workspace-relative): bazel-bin/natives-<target>/pi_natives.<...>.node
bazelisk cquery --output=files //:natives-linux-x64-baseline

# What actions/flags a target produces (add the same --config flags as the build):
bazelisk aquery 'outputs(".*\.node", deps(//:natives-linux-arm64))'
bazelisk aquery 'mnemonic("Rustc", deps(//crates/pi-natives:pi_natives))'

# Which toolchain resolved (e.g. confirm @msvc_cc, not host cc, for win32):
bazelisk cquery 'deps(//:natives-win32-x64-baseline)' | grep msvc_cc

# Keep the sandbox dir + print the full command line of a failing action:
bazelisk build --sandbox_debug --verbose_failures //:natives-<t>

# Analyze without building (cheap cross-target sanity check):
bazelisk build --nobuild //:natives-win32-x64-baseline
```

`scripts/bazel-natives.ts` 实时流式输出 bazel stderr，并在失败时重复输出最后 40 行；当其 cquery 步骤失败时，它会回退到 `bazel-bin` 路径约定。

### 常见失败类别（bring-up 期间所见 —— 修复已在树中，再次出现时请引用）

| 症状                                                                                        | 原因                                                                                                | 修复（已在树中）                                                                                                                                                                  |
| ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| musl 构建“成功”但不产出任何 `.node`                                                     | musl 默认为 `+crt-static`；rustc 静默地不产出 cdylib                                       | `crates/pi-natives/BUILD.bazel` 中的 `-Ctarget-feature=-crt-static` select                                                                                                       |
| Opus 目标文件拖入宿主机 UBSan 运行时                                                       | zig cc 默认启用 UBSan                                                                      | `MODULE.bazel` 中 `opusic-sys` annotation 里的 `CFLAGS=-fno-sanitize=undefined`                                                                                              |
| `tree-sitter-just` scanner.c 在 opt 下 `#error`                                                | 当设置了 `NDEBUG`（opt 模式 cc 的默认值）时 scanner 会硬报错                                       | `CFLAGS=-UNDEBUG` annotation（cc-rs 把环境变量 CFLAGS 追加在最后，因此 `-U` 生效）                                                                                                     |
| vendored 测试中 rstest 宏：“Cargo.toml not found”                                        | rstest 会校验 manifest 目录中存在 `Cargo.toml`                                              | `rust_test` 上的 `compile_data = ["Cargo.toml"]`（见 `crates/vendor/uu-tail/BUILD.bazel`）                                                                                   |
| vendored 测试在裸 `test_data/...` 路径上失败 / 符号链接到 srcs                          | 测试假定 cargo 的 cwd，与 runfiles 执行不兼容                                       | `tags = ["manual"]`；在改动该 fork 时通过 `cargo nextest` 运行；密封的同级测试覆盖该契约                   |
| blake3 msvc：找不到 `ml64.exe`                                                              | 在非 Windows 宿主机上 cc-rs 从 build-script PATH 解析 MASM                                      | `@msvc_cc` 中的 `bin/ml64.exe → llvm-ml -m64` 垫片，通过 `blake3` annotation 的 PATH 前置                                                                                   |
| `opusic-sys` msvc 需要交叉 CMake 工具链                                               | 捆绑的 Opus 是在 Linux/macOS 上为 Windows 目标配置的                                     | 通过 `CMAKE_TOOLCHAIN_FILE_x86_64_pc_windows_msvc` 使用 `@msvc_cc` 的 `toolchain.cmake`；该 sys crate 选择 Ninja、静态 try-compile 与 `/MT`                                  |
| win32 链接方面的各种异常                                                                  | —                                                                                                    | 先读 `bazel/toolchains/msvc/NOTES.md`：wrapper 自身定位、`lld-link` flavor/driver-link 行为、`LIB`、`/MD` CRT 选择、xwin splat 注意事项                        |
| `rust_test(crate = ...)` 在宏展开时报 “can't find crate”                                 | 仅 rmeta 的流水线依赖破坏了 macro_rules 再导出 harness 的编译                               | rust pipelined_compilation 保持 OFF（`.bazelrc` 中有说明）                                                                                                                         |
| 构建脚本找不到 cmake/ninja                                                            | `--incompatible_strict_action_env` —— 不会泄漏宿主机环境                                               | 在 crate annotation（`MODULE.bazel`）中显式设置 `PATH`，而不是依赖宿主机环境                                                                                                         |

### 缓存行为

- **omp-kata：** 对集群内 bazel-remote 的读写 gRPC（`grpcs://bazel-remote.bazel-cache.svc.cluster.local:9092`，TLS 使用已提交的 `infra/bazel-remote/ca.crt`，htpasswd 用户 `ci`）。`--remote_local_fallback` 加上重试使一次宕机降级为本地执行，而不是让构建失败。
- **GitHub-hosted：** 无集群访问；这里只有 darwin release/warm 作业用 bazel 构建。v3 `actions/cache` 磁盘 key 通过前缀 + 裸回退区分 config 与 source 代次（见上文 `bazel-cache` action 一节）；`.github/workflows/bazel-cache-warm.yml` 从与发布消费者相同的 macOS 镜像发布 `release-darwin-*` 归档。
- **msvc repos：** 约 2 GiB 的 LLVM 下载经过 sha256 固定并由 repository 缓存支持；约 1 GiB 的 xwin CRT/SDK splat 在 repo rule 内部从 Microsoft CDN 拉取，且**不**由 repository 缓存支持 —— 冷 output base 会重新下载它。Microsoft 会随时间推进 VS channel payload，因此 win32 action 的 remote-cache 命中率在 MS 升级后会优雅降级（与之前的交叉工具链具有相同特性）。Win32 链接 action 也不会跨宿主机 OS 共享缓存条目（linux 与 mac 的 clang 二进制）。
- 服务端操作（部署、TLS/auth、egress、poisoning 边界）：`infra/docs/04-arc-and-caching.md` §5。

## 目标/变体模型与命名约定

## 平台标签

构建与运行时都使用平台标签：

`<platform>-<arch>`（例如：`darwin-arm64`、`linux-x64`）。

## 变体模型（仅 x64）

x64 支持 CPU 变体，以平台上的 `//bazel/variants` constraint 取值编码（baseline → `-Ctarget-cpu=x86-64-v2`，modern → `x86-64-v3`）：

- `modern`（支持 AVX2 的路径）
- `baseline`（回退）

非 x64 使用单一默认产物，不带变体后缀。不存在构建时变体 _switch_：每个变体各自是一个 `//:natives-*` 目标，`host` 伪目标通过 AVX2 检测在 modern 与 baseline 之间选择。

### 输出文件名

- x64：`pi_natives.<platform>-<arch>-modern.node` 或 `...-baseline.node`
- 非 x64：`pi_natives.<platform>-<arch>.node`

运行时 x64 候选项顺序在所选变体候选项之后，还包含不带后缀的默认文件名。

## 运行时标志

- `PI_NATIVE_VARIANT`：x64 运行时覆盖；有效值为 `modern` 与 `baseline`。非法值会被忽略，并执行正常检测。
- `PI_DEBUG_STARTUP`：在加载器入口、内嵌解压、候选项加载以及原生 Tokio runtime 安装前后，向 stderr 写入同步的 `[startup] native:…` 标记；用它来定位启动挂起。
- `PI_COMPILED`：编译模式信号。发布编译会把 `process.env.PI_COMPILED` 常量折叠为 `"true"`；已填充的内嵌插件清单与 Bun 内嵌 URL 标记同样标示编译模式。

## 内嵌生命周期（`embed-native.ts`）

1. **初始化**：计算平台标签（宿主机取值，可由发布打包脚本为 cross-target 归档覆盖）。
2. **候选项集合**：
   - x64 查找 `modern` 与 `baseline` 文件；
   - 非 x64 查找一个默认文件。
3. **校验可用性**：`packages/natives/native` 中必须至少存在一个预期文件。
4. **生成归档 + 清单**：写入 `native/embedded-addons.<platform>-<arch>.tar.gz`，其中包含所有可用的目标插件文件，以及带包版本、归档元数据与文件大小的 `native/embedded-addon.js`。
5. **运行时解压就绪**（供编译模式使用）。

`--reset` 会写入 null 清单桩（`embeddedAddon = null`）而不校验插件可用性，并删除 `native/` 中任何已存在的 `embedded-addons.*.tar.gz` 归档。

## 开发工作流 vs 发布/编译后行为

## 本地开发工作流

典型的本地循环：

1. 构建插件：`bun --cwd=packages/natives run build`。
2. 加载器解析平台 npm 叶子包候选项（`@oh-my-pi/pi-natives-<platform>-<arch>`，在可解析时），然后是包内 `native/` 与可执行文件目录的回退候选项。
3. `native/index.d.ts` 中生成的声明描述公共 TS API（仅在 Rust API 表面变化时用 `build:bindings` 重新生成）。
4. 在 Windows 的包安装中，加载器会先把 `node_modules` 插件拷贝进版本化缓存，这样正在运行的进程就不会锁住 Bun 在之后的全局更新中必须替换的文件。
5. 成功加载后，会尽力移除较旧的 semver 形状的版本缓存目录；清理失败永远不会中止启动。

## 发布/编译后二进制工作流

在编译模式下（`PI_COMPILED`、Bun 内嵌 URL 标记，或已填充的内嵌清单）：

1. 加载器计算版本化缓存目录：`<getNativesDir()>/<packageVersion>`。
2. 如果内嵌清单与当前 platform+version 匹配，则当缓存文件缺失或大小不对时，加载器会把所选文件从 `embedded-addons.<tag>.tar.gz` 解压进该版本化目录。
3. 运行时候选项顺序包括：
   - 已解压的版本化缓存路径（如可用），
   - 版本化缓存目录，
   - 旧版已编译二进制目录（Windows 上为 `%LOCALAPPDATA%/omp`，其他地方为 `~/.local/bin`），
   - 包/可执行文件目录。
4. 返回第一个成功加载且带有预期版本哨兵的插件。

这就是为什么打包与运行时加载器的预期必须对齐：文件名、平台标签、CPU 变体以及内嵌清单版本都必须与 `native/loader-state.js` 探测的内容一致。

## JS API ↔ Rust 导出映射（构建健全性子集）

目前生成的声明包含来自以下 Rust 模块的导出：

| 领域                   | 代表性 JS 导出                                                                                                               | Rust 源码                                                                  |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 搜索/工作区       | `grep`, `search`, `hasMatch`, `fuzzyFind`, `glob`, `listWorkspace`, `invalidateFsScanCache`                                             | `grep.rs`, `fd.rs`, `glob.rs`, `workspace.rs`, `iofs.rs`（缓存在 `pi-walker`） |
| AST/块/摘要      | `astGrep`, `astEdit`, `blockRangeAt`, `summarizeCode`                                                                                   | `ast.rs`, `block.rs`, `summary.rs`                                           |
| 文本/高亮/token  | `visibleWidth`, `truncateToWidth`, `highlightCode`, `countTokens`                                                                       | `text.rs`, `highlight.rs`, `tokens.rs`                                       |
| Shell/PTY/进程/按键 | `executeShell`, `Shell`, `PtySession`, `Process`, `parseKey`                                                                            | `shell.rs`, `pty.rs`, `ps.rs`, `keys.rs`                                     |
| 媒体/系统/iso       | `encodeSixel`, `copyToClipboard`, `detectMacOSAppearance`, `PowerAssertion`, `getWorkProfile`, `isoBackend`, `isoStart`, `isoDiff`      | `sixel.rs`, `clipboard.rs`, `appearance.rs`, `power.rs`, `prof.rs`, `iso.rs` |

## 失败行为与诊断

## 构建期失败

- Bazel 分析/编译失败：`scripts/bazel-natives.ts` 会给出退出码以及 stderr 尾部；直接重新运行它打印出的 `bazel build` 命令行（加上 `--verbose_failures`、`--sandbox_debug`）来迭代。
- 未知目标名：驱动会报错并列出全部已知目标（`//:natives-*` 名称 + `host`/`linux-all`/`darwin-all`）。
- 构建成功但未定位到任何 `.node` 输出：驱动以 1 退出（请手动检查 `bazel cquery --output=files`）。
- basename 冲突（同一次调用中同时有 gnu 与 musl）：驱动拒绝安装并列出两个来源 —— 请拆分到各自独立的 `--dest` 目录。
- `build:bindings`（napi）失败：脚本会给出非零退出码与 stderr；产物构建不受影响（Bazel 从不运行 napi CLI）。

## 运行时加载器失败（`native/loader-state.js`）

- 不支持的平台标签：探测失败后抛出异常并附上受支持的平台列表。
- 没有任何候选项能加载：抛出异常并附上完整的候选项错误列表以及针对具体模式的修复提示。
- 内嵌解压与 Windows 暂存问题：archive/mkdir/write/copy 错误会被记录，并在加载失败时纳入最终诊断。
- 版本不匹配：缺少包版本哨兵的安装/编译模式加载会在候选项探测期间被拒绝。

## 故障排查矩阵

| 症状                                                                | 可能原因                                                                                | 验证                                                            | 修复                                                                                                                                  |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 每个候选项都出现 `Cannot find module` 或动态库加载错误 | 缺少发布产物、平台标签错误，或编译缓存陈旧                       | 检查加载器错误列表与 `packages/natives/native` 中的文件名 | 构建正确的目标（`bun scripts/bazel-natives.ts <t> --dest packages/natives/native`）；删除该包版本的陈旧缓存 |
| 运行时缺少导出，但 TypeScript 中存在                 | 加载了陈旧的 `.node`、生成的声明比二进制更新，或 Rust 导出未被编译 | require 实际候选项并检查 `Object.keys(mod)`       | 重建 native 包并移除陈旧的候选项/缓存路径                                                                        |
| x64 机器在期望 modern 时却加载 baseline                        | `PI_NATIVE_VARIANT=baseline`、未检测到 AVX2，或 modern 文件不可用                  | 检查环境变量与 `native/` 中的文件名                              | 构建并发布 modern 目标（`bun scripts/bazel-natives.ts linux-x64-modern --dest packages/natives/native`）                    |
| gnu 插件被 musl 覆盖（或反之）                          | 两者被构建进同一个 dest —— 它们按设计共享规范 basename                         | 对比 `bazel-bin/natives-<t>/` 的来源与已安装文件        | 用各自独立的 `--dest` 目录分别调用（发布矩阵已这样做）                                                  |
| 升级后已编译二进制失败                                    | 解压缓存陈旧、内嵌归档不匹配，或内嵌清单版本不匹配     | 检查 `<getNativesDir()>/<version>` 与加载器错误列表       | 删除该包版本的版本化缓存；在打包期间重新生成内嵌归档/清单                                |
| `gen:native` 失败并提示 `No native addons found`                       | 在嵌入之前未构建所需的平台产物                                   | 检查错误文本中的预期列表                                 | 为该目标构建至少一个预期产物，然后重新运行 `gen:native`                                                         |

## 操作命令

```bash
# Addon for the current host, installed into packages/natives/native/
bun --cwd=packages/natives run build

# Explicit targets (x64 variants are separate targets, not env switches)
bun scripts/bazel-natives.ts linux-x64-modern linux-x64-baseline --dest packages/natives/native

# Raw bazel (output: bazel-bin/natives-<t>/pi_natives.<...>.node)
bazelisk build //:natives-darwin-arm64

# Regenerate TS typedefs + enum exports (napi CLI, only on Rust API changes)
bun --cwd=packages/natives run build:bindings

# Generate embedded addon manifest from built native files
bun run gen:native
# Output archive: packages/natives/native/embedded-addons.<platform>-<arch>.tar.gz

# Reset embedded manifest to null stub
bun run gen:native:reset
```

## Orchestrator 侧 content-addressed 构建缓存（robomp）

当 `pi-natives` 在 robomp orchestrator（`python/robomp/`）内部构建时，各工作区通过 content-addressed 缓存共享已构建的产物，而不是在每个按 issue 划分的 worktree 中从头重建。该缓存**仅在 orchestrator 侧** —— `bun --cwd=packages/natives run build` 本身没有变化；缓存位于构建流水线之外，由 `python/robomp/src/natives_cache.py` 在 `ensure_workspace` 周围以及 task 成功之后进行填充/捕获。

### 缓存的内容

缓存在计算出的 key 下从 `packages/natives/native/` 捕获以下文件。正确的复用假定被纳入 key 的路径其 worktree 内容与已提交的 `HEAD` 一致；由于 key 忽略未提交的更改，来自脏 keyed 路径的构建可能被以未变化的 key 捕获，并在之后被复用：

- `pi_natives.<platform>-<arch>[-variant].node`（glob `pi_natives.*.node`）
- `index.d.ts`
- `index.js`
- `embedded-addon.js`
- `manifest.json`（缓存元数据：key、target triple、捕获时间戳、源工作区、commit）

只有当 `.node` glob 匹配，**并且**每个伴随文件与清单都存在时，条目才被视为命中。不完整的条目会在 GC 时被逐出。

### 缓存 key

key 是对以下输入按此顺序（顺序有意义）计算的 `(path \t git-tree-hash \n)` 对的 `sha256`，其后拼接 target triple：

1. `crates`（整个子树 —— pi-natives 传递依赖其他工作区 crate）
2. `Cargo.lock`
3. `Cargo.toml`
4. `rust-toolchain.toml`
5. `packages/natives`（整个子树 —— 构建脚本、`scripts/*`、package.json）

Tree hash 来自针对 `HEAD` 的一次 `git cat-file --batch-check` 调用；`HEAD` 中缺失的路径会以一个固定的 null hash 参与折叠，使 key 在未发布全部输入的仓库之间保持确定性。目标后缀在非 x64 上为 `<platform>-<arch>`。在 x64 上为 `<platform>-<arch>-<TARGET_VARIANT>`，或当 `TARGET_VARIANT` 未设置时为 `<platform>-<arch>-host`；Python 缓存不执行 AVX2 检测。

此输入集合之外的任何内容（如 `MODULE.bazel`/`BUILD.bazel` 这类 Bazel 定义文件、宿主机 glibc、除目标后缀以外的环境变量）都**不**在 key 中。内容哈希描述的也是已提交的 `HEAD`，而非未提交的 worktree 更改。在一次超出 key 或未提交的构建输入变更之后，请删除相关的缓存条目；在五个 keyed 路径之一提交更改会自动产生新的 key。

### 布局与所有权

- 根目录：`/data/cache/pi-natives`（由 `entrypoint.sh` 与 cargo 缓存一并配置，属主 `root:omp`，mode `02770` setgid，因此缓存文件继承 `gid=omp`，并对每个 slot 用户保持可读）。
- 按仓库的子目录：`<root>/<repo-slug>/`，其中 slug 为 `owner__repo`（与 `SandboxManager.pool_path` 一致）。
- 按条目的目录：`<root>/<repo-slug>/<sha256-key>/`，包含缓存文件以及 `manifest.json`。
- 按仓库的 lockfile：`<root>/<repo-slug>/.lock`（advisory `fcntl.flock`，在捕获与 GC 时排他）。
- 捕获期间使用暂存目录（`.<key>.tmp.<pid>`）；以原子方式重命名为最终条目路径。因捕获崩溃而残留的陈旧暂存目录会在 GC 时清理。

### 填充与捕获语义

- **填充（Populate）**（workspace ← cache）在 `ensure_workspace` 内运行。key 命中时，`.node` 会被**硬链接**进工作区（zero-copy，共享 inode）；伴随文件 `index.d.ts` / `index.js` / `embedded-addon.js` 则被**拷贝**（独立 inode），因为绑定重新生成流程（`build-bindings.ts` 的 `installGeneratedBindings` 与 `gen-enums.ts`）会通过 `open(..., 'w')` 重写这些文件 —— 这种原地截断否则会经由硬链接传播并损坏缓存。跨设备硬链接失败（`EXDEV`）回退为拷贝。
- **捕获（Capture）**（cache ← workspace）在构建产出了完整产物集时，由 task 成功后的路径运行。捕获使用**拷贝**而非硬链接：硬链接一个属于 slot 的工作区文件会把 slot UID 所有权保留在缓存 inode 上，从而破坏共享组模型。拷贝经由 setgid 缓存根创建全新的、属主为 root、`gid=omp` 的 inode。在按仓库的 flock 之下，捕获是幂等的：对同一 key 的并发捕获会返回已存在的条目。

### 垃圾回收

`WorkerPool` 中运行一个周期性 GC 循环，每个仓库有两个上限。当任一上限被超出时，最旧的条目（按 `manifest.json.captured_at`）会先被丢弃：

- 条目数上限（`max_entries_per_repo`，默认 8）
- 字节数上限（`max_bytes`，默认 4 GiB）

在 GC 之前硬链接了 `.node` 的工作区通过内核 inode 引用计数保留访问权 —— 对缓存条目执行 `rmtree` 不会从工作区中删除该文件。

### 配置（`robomp.config.Settings` 上的设置）

| 环境变量                                     | 默认值                  | 效果                                                                                              |
| ------------------------------------------- | ------------------------ | --------------------------------------------------------------------------------------------------- |
| `ROBOMP_NATIVES_CACHE_ENABLED`              | `true`                   | 总开关。为 false 时填充/捕获钩子不执行任何操作，每个工作区都从头构建。 |
| `ROBOMP_NATIVES_CACHE_ROOT`                 | `/data/cache/pi-natives` | 缓存根目录。跨 slot 读取时必须为 `root:omp 02770`。                                |
| `ROBOMP_NATIVES_CACHE_MAX_ENTRIES_PER_REPO` | `8`                      | 每个 repo slug 的 LRU 条目数上限。                                                                 |
| `ROBOMP_NATIVES_CACHE_MAX_BYTES`            | `4294967296`（4 GiB）     | 每个 repo slug 的 LRU 字节上限。                                                                        |
| `ROBOMP_NATIVES_CACHE_GC_INTERVAL_SECONDS`  | `3600`                   | `WorkerPool` 中后台 GC 循环的周期。                                                   |

### 手动失效

- 单个 key：`rm -rf /data/cache/pi-natives/<repo-slug>/<sha256>`。
- 单个 repo：`rm -rf /data/cache/pi-natives/<repo-slug>`。
- 全部：`rm -rf /data/cache/pi-natives/*`（保留根目录，使其 setgid 模式得以保留）。
- 卡住的锁：`rm /data/cache/pi-natives/<repo-slug>/.lock`（仅在没有 orchestrator 进程正在访问该 repo 时）。

对于固定的目标后缀，在 `crates/`、`Cargo.lock`、`Cargo.toml`、`rust-toolchain.toml` 或 `packages/natives/` 下的一次已提交 `HEAD` 变更会产生自动未命中。改变平台/架构，或在 x64 上改变 `TARGET_VARIANT`，也会选中不同的 key。仅仅编辑未提交的 worktree 既不会改变 `HEAD` 哈希，也不会改变 key。
