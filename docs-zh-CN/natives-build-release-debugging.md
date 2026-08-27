# Natives Build, Release, and Debugging Runbook

本运行手册介绍 `@oh-my-pi/pi-natives` 如何生成 `.node` 插件、生成类型声明以及已编译二进制内嵌产物，并说明如何调试 loader 与构建失败。

插件 **artifacts are built by Bazel**（`rules_rust` + `crate_universe` + 密封 cc 工具链）；cargo workspace 仍然是本地 Rust 迭代（rust-analyzer、`cargo nextest`）以及 napi typedef 重新生成的权威来源。Runtime loading and embedding are unchanged。

它遵循 `docs/natives-architecture.md` 中的架构术语：

- **build-time artifact production**（通过 `scripts/bazel-natives.ts` 调用 Bazel `//:natives-<target>`）
- **embedded addon manifest generation**（`scripts/embed-native.ts`）
- **runtime addon loading**（`native/index.js`、`native/loader-state.js`）

## Implementation files

Build side:

- `BUILD.bazel`（根目录）— 八个 `//:natives-<target>` 插件目标 + 聚合 filegroup
- `bazel/defs.bzl` — `native_addon` 规则/transition
- `bazel/platforms/BUILD.bazel` — 每个已发布插件一个 `platform()`
- `bazel/variants/BUILD.bazel` — `baseline`/`modern` ISA constraint 取值
- `bazel/toolchains/` — musl rustc 消歧 + msvc 交叉 cc 工具链（`msvc/NOTES.md`）
- `bazel/clippy.bazelrc` — 由 `Cargo.toml` 中的 `[workspace.lints]` 生成
- `MODULE.bazel`、`MODULE.bazel.lock`、`.bazelrc`、`.bazelversion`（Bazel 9.2.0）
- `scripts/bazel-natives.ts` — 标准驱动（build + locate + install）
- `crates/pi-natives/BUILD.bazel`、`crates/pi-natives/Cargo.toml`

Package side (unchanged runtime/packaging):

- `packages/natives/scripts/build-bindings.ts` — 仅开发期 typedef 重新生成
- `packages/natives/scripts/embed-native.ts`、`gen-enums.ts`、`gen-npm-packages.ts`
- `packages/natives/package.json`
- `packages/natives/native/index.js`、`native/loader-state.js`

## Build architecture

### 1) `//:natives-<target>` addon targets

根 `BUILD.bazel` 为每个已发布的 `(platform, arch, ISA-variant)` 实例化一个 `native_addon`：

| Target                               | Platform                                    | Canonical output                      |
| ------------------------------------ | ------------------------------------------- | ------------------------------------- |
| `//:natives-linux-x64-baseline`      | `//bazel/platforms:linux-x64-baseline`      | `pi_natives.linux-x64-baseline.node`  |
| `//:natives-linux-x64-modern`        | `//bazel/platforms:linux-x64-modern`        | `pi_natives.linux-x64-modern.node`    |
| `//:natives-linux-arm64`             | `//bazel/platforms:linux-arm64`             | `pi_natives.linux-arm64.node`         |
| `//:natives-linux-musl-x64-baseline` | `//bazel/platforms:linux-musl-x64-baseline` | `pi_natives.linux-x64-baseline.node`  |
| `//:natives-linux-musl-arm64`        | `//bazel/platforms:linux-musl-arm64`        | `pi_natives.linux-arm64.node`         |
| `//:natives-darwin-x64-baseline`     | `//bazel/platforms:darwin-x64-baseline`     | `pi_natives.darwin-x64-baseline.node` |
| `//:natives-darwin-arm64`            | `//bazel/platforms:darwin-arm64`            | `pi_natives.darwin-arm64.node`        |
| `//:natives-win32-x64-baseline`      | `//bazel/platforms:win32-x64-baseline`      | `pi_natives.win32-x64-baseline.node`  |

Notes:

- musl addons **intentionally reuse** the plain `linux-<arch>` filenames — the loader never sees gnu and musl side by side; release jobs keep them in separate invocations/dest dirs (`scripts/bazel-natives.ts` hard-errors on a basename collision within one run).
- Aggregates: `//:natives-linux-all`（所有 linux 目标 + msvc 交叉构建，即从 linux-x64 宿主机上可构建的全部内容）以及 `//:natives-darwin-all`（仅限 mac 宿主机）。

### 2) `native_addon` rule (`bazel/defs.bzl`)

`native_addon` 将 `//crates/pi-natives:pi_natives`（一个 `rust_shared_library`）包装在 configuration transition 中，按目标固定以下内容：

- `--platforms=<the addon's platform>`
- `--compilation_mode=opt`
- `@rules_rust//rust/settings:lto=thin`
- 额外 rustc flags `-Ccodegen-units=16 -Cstrip=symbols`

This mirrors the old cargo `ci` profile. Because the profile lives **in the transition**, a bare `bazel build //:natives-<t>` is always release-grade regardless of `-c`, and every addon shares one cache entry per (platform, source) pair. The rule then symlinks the produced shared library to the loader's canonical `pi_natives.<platform>-<arch>[-<variant>].node` name, scoped under the rule name (`bazel-bin/natives-<t>/…`) so gnu/musl outputs with identical basenames cannot collide at the package level.

不属于 transition 的每目标 codegen 位于 `crates/pi-natives/BUILD.bazel` 的 `rustc_flags` selects 中：通过 `//bazel/variants` 设置 `-Ctarget-cpu=x86-64-v2`（baseline）/ `x86-64-v3`（modern），napi 链接参数（macOS 上的 `-Wl,-undefined,dynamic_lookup`、linux 上的 `-Wl,-z,nodelete` —— 故意未接入 `build.rs`/`napi_build::setup()`），musl 的 `-Ctarget-feature=-crt-static`，以及 win32-x64 msvc 的 `-Ctarget-feature=+crt-static`（配合 `native_addon` transition 中启用的 `static_link_msvcrt` cc feature，使 C 依赖项同步以 `/MT` 编译 —— 由此发布的 `.node` 不需要从 VC++ Redistributable 导入任何 `VCRUNTIME140.dll`）。

### 3) Platforms and toolchains

| Target family          | cc toolchain                                                               | Notes                                                                                                 |
| ---------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| linux gnu (x64/arm64)  | `@zig_sdk//libc_aware/toolchain:linux_*_gnu.2.17`（hermetic zig cc）        | glibc **2.17** portability floor —— 与之前交叉构建所用的底线相同                                    |
| linux musl (x64/arm64) | `@zig_sdk//libc_aware/toolchain:linux_*_musl`                              | 动态 CRT（crate BUILD 中为 `-Ctarget-feature=-crt-static`）                                          |
| darwin (x64/arm64)     | 宿主机 Xcode 工具链                                                        | Apple frameworks 不可再分发；darwin 插件只能在 mac 宿主机上构建                                      |
| win32-x64 msvc         | `//bazel/toolchains/msvc`（`@msvc_cc`）：clang-cl + lld-link + xwin CRT/SDK | 从 linux-x64 CI 节点和 darwin 开发主机进行的密封交叉链接；**static CRT**（`+crt-static` + `static_link_msvcrt`）使插件无需 VC++ Redistributable；见 `bazel/toolchains/msvc/NOTES.md` |

Rust toolchains are nightly (pinned in `MODULE.bazel`)，其中在 `//bazel/toolchains` 中对 musl 进行了 repo-local re-registration，并携带显式的 `@zig_sdk//libc:musl` constraint（rules_rust 自动生成的 gnu 与 musl 工具链的 (os, cpu) constraint 相同）。

### 4) Third-party crates (`crate_universe`)

`@crates//...` 由工作区的 `Cargo.toml`/`Cargo.lock` 生成，限定为正好七个已发布 triple。Crate-specific 的构建修复以 `crate.annotation` 形式存在于 `MODULE.bazel` 中（见下方调试 playbook）。

根模块故意省略了 `crate_universe` 可选的 rendering lock。crate 输入变更后的第一次 evaluation 会拼接工作区并根据已固定的 `Cargo.lock` 生成 external repository 规约；Bazel 会将该扩展结果记录在 `MODULE.bazel.lock` 中，因此之后清理过的 output base 可以复用它。因此，编辑 Cargo manifest、lock 和 annotation 不需要单独的重新固定步骤。

## Local development

### Building addons

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

驱动在未通过 `OMP_NATIVE_BUILD_BACKEND=bazel` 或额外 bazel 参数显式请求 bazel 时，会通过本地 cargo/napi-rs 路径（`packages/natives/scripts/build-bindings.ts`）构建 `host`。对于显式目标，它会针对所有请求目标运行一次 `bazel build`，通过 `bazel cquery --output=files` 定位输出（回退到 `bazel-bin/natives-<t>/<canonical>.node` 路径约定），并将其解引用（dereference）后拷贝到 `--dest`（默认 `packages/natives/native`）。`--` 之后的额外参数将原样传给 bazel。它从 `PATH` 解析 `bazelisk`（或 `bazel`），并将 `OMP_BAZEL_RC` 环境变量作为 `--bazelrc=` 启动选项处理（这就是 CI 注入缓存配置的方式）。

将 `linux-all` 构建到同一个 dest 中会用 musl 产物覆盖 gnu 插件（basename 相同）—— 驱动会拒绝；请使用不同的 `--dest` 目录分别调用。

### Typedef regeneration (napi CLI, dev-only)

`native/index.js`/`index.d.ts` **已提交**，因此 Bazel 产物构建从不使用 napi CLI。仅当 Rust API 表面的导出 typedef 发生变化时：

```bash
bun --cwd=packages/natives run build:bindings   # = bun scripts/build-bindings.ts
```

这会在 `crates/pi-natives` 上运行 napi CLI（仅宿主机，使用本地 cargo profile），安装重新生成的 `index.d.ts`，规范化插件文件名，并通过 `gen-enums.ts` 重新渲染显式 ESM exports 和运行时 enum 对象。提交 `index.js`/`index.d.ts` 的相应变更。

### Opt-in remote cache (`.bazelrc.user`)

`.bazelrc` 以 `try-import %workspace%/.bazelrc.user` 结尾（已被 git 忽略）。bazel-remote 端点仅限集群内部访问；若你能访问（VPN/tailnet），可以将其配置为只读：

```
# .bazelrc.user
build --config=cache-ro
build --remote_cache=grpcs://bazel-remote.bazel-cache.svc.cluster.local:9092
build --tls_certificate=infra/bazel-remote/ca.crt
```

`.bazelrc` 中的 `cache-ro`/`cache-rw` 仅承载策略（upload on/off、`--remote_local_fallback`、重试/超时，使缓存宕机时构建不会失败）；端点与凭据始终由消费者自行组合。一条简单的 `--disk_cache=<dir>` 配置在此处同样有效。

## CI

### Split Rust validation and addon production

`.github/workflows/ci.yml` 将 `rust_validate` 与 `native_addons` 分开；TypeScript 作业仅依赖 `native_addons`。

**Pull requests never build or validate Rust.** Native-affecting PRs are rare enough that they don't warrant a PR-side bazel build: `rust_validate` is skipped entirely (`if: github.event_name != 'pull_request'`)，并且 `native_addons` 会从 `@oh-my-pi/pi-natives-linux-x64` npm 叶包中拉取最新发布的 Linux x64 插件对，对两者进行冒烟加载，并将它们上传为 `native-addons` workflow artifact。Loader 在 workspace 加载时跳过其版本哨兵，因此发布版本化的插件可以在更新的 checkout 下正常加载。其 TypeScript 测试依赖变更原生行为的 PR 会以明显方式失败（CI 也会在涉及原生的 PR 上发出提示）；Rust 端在 main 上 post-merge 验证，发布时再次验证。

On non-PR events both jobs run on `omp-kata` pods against the cluster remote cache. `rust_validate` 运行：

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

`native_addons` on main builds the six Linux-hosted targets one at a time to avoid concurrent-link OOMs，then builds `//:natives-linux-all` as an aggregate consistency check. It uploads every `.node` output as the `native-addons` workflow artifact. Downstream jobs use `.github/actions/native-artifacts` to download that artifact and install the requested target set without invoking Bazel.

原生作业无需任何工具链设置步骤：bazelisk 已预装在 GitHub 镜像中并烘焙进 kata runner 镜像；Bazel 以 hermetic 方式拉取 Rust/zig/LLVM/xwin。

### Hosted cache warmer

`.github/workflows/bazel-cache-warm.yml` seeds the GitHub-hosted caches that have no other reliable producer: `release-darwin-*` bazel disk caches（built on the same macOS images as the `release_binary_darwin` matrix，so a release's bazel build is the version-bump delta instead of a ~40-min cold graph）以及 PR jobs 恢复但从不保存的 shared bun store entry。它仅在可能更改这些归档的推送上触发（crate/bazel/lock 输入、`bun.lock`、`.github/**`）。

### `bazel-cache` action (`.github/actions/bazel-cache`)

Single source of truth for cache wiring，emitted as a bazelrc fragment（其 `rc` 输出）由消费者通过 `bazelisk --bazelrc=...` 或 `OMP_BAZEL_RC` 传递。通过 `BAZEL_REMOTE_USER`/`BAZEL_REMOTE_PASSWORD` 选择两种模式：

| Runner        | Fragment contents                                                                                                                                                                                            |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| omp-kata pod  | 一个临时 output root、`--config=ci`、基于 PVC 的 repository/xwin 缓存、`--config=cache-rw`、集群内 TLS remote-cache 端点及经掩码处理的 Basic-auth 头，外加 `--remote_download_toplevel` |
| GitHub-hosted | `--config=ci`、`--disk_cache=$HOME/.cache/omp-bazel-disk` 以及 `--repository_cache=$HOME/.cache/omp-bazel-repo`                                                                                              |

托管磁盘缓存使用 `bazel-disk-v3-<scope>-<os>-<arch>-<config-hash>-<source-hash>`。config hash 涵盖 Cargo/Bazel/工具链设置；source hash 涵盖 `crates/**` 和根 `BUILD.bazel`。恢复从精确 key 回退到 config-scoped 前缀，再回退到裸 `<scope>-<os>-<arch>` 前缀 —— 裸回退避免了发布版本升级（会重写 `Cargo.toml`/`Cargo.lock` 并因此改变 config hash）触发冷构建；bazel 的 content-addressed action keys 使得陈旧的归档只是部分命中，永远不会产生错误输出。允许一次不精确恢复后进行一次刷新的精确 key 保存。在托管构建之前，超过 14 天未访问的 disk-cache 文件将被裁剪；repository-cache 内容刻意不按时间裁剪，因为已解压的文件 r…

### Native artifact actions

`.github/actions/bazel-natives` 是直接构建器：`bazel-cache` → `OMP_BAZEL_RC=<rc> bun scripts/bazel-natives.ts <targets> --dest <dest>`，followed by a disk-cache save after a hosted miss. `.github/actions/native-artifacts` 是无构建的消费者：download `native-addons` → run the same driver with `--source`.

### Release binary builds and publishing

Binary builds are build-only and run in parallel with the test fan-out. `release_binary`（Linux + Windows 矩阵）仅需要 `native_addons`，其 workflow artifact 提供它们的插件。`release_binary_darwin` 仅需要 `release_metadata`，并从检测到发布运行那一刻启动：darwin 产物无法在 Linux 上交叉构建，因此每个 macOS 分支都通过 `bazel-natives` 配合 scope `release-<target_id>` 构建各自的架构（由 warm workflow 在接近 HEAD 处预热 —— 通常仅为版本升级的差异），然后 `bun run ci:release:build-binaries` 内嵌并编译可执行文件。发布被 `release_gate`（每个 validation job 的聚合）挡住：`release_native_leaves` 下载所有已构建的插件并发布五个 `@oh-my-p…

## Debugging playbook

### Where things land / how to inspect

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

### Common failure classes (seen during bring-up — fixes already in tree, cite when they resurface)

| Symptom                                                                                        | Cause                                                                                                | Fix (in tree)                                                                                                                                                                  |
| ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| musl 构建“成功”但未产出 `.node`                                                                | musl 默认为 `+crt-static`；rustc 静默不输出 cdylib                                                   | `crates/pi-natives/BUILD.bazel` 中 `-Ctarget-feature=-crt-static` select                                                                                                      |
| opus/cmake `try_compile` 链接 UBSan 运行时失败                                                  | zig cc 默认启用 UBSan；cmake 的测试可执行文件使用裸 wrapper 链接（无工具链特性）                     | `MODULE.bazel` 中 `audiopus_sys` 注释中的 `CFLAGS=-fno-sanitize=undefined`                                                                                                    |
| `tree-sitter-just` scanner.c 在 opt 下出现 `#error`                                            | 设置 `NDEBUG`（opt 模式 cc 默认）时 scanner 硬报错                                                   | `CFLAGS=-UNDEBUG` 注释（cc-rs 将 env CFLAGS 追加在末尾，因此 `-U` 生效）                                                                                                       |
| vendored 测试中 rstest 宏：“Cargo.toml not found”                                                | rstest 验证 manifest 目录中存在 `Cargo.toml`                                                         | `rust_test` 上的 `compile_data = ["Cargo.toml"]`（见 `crates/vendor/uu-tail/BUILD.bazel`）                                                                                    |
| vendored 测试在裸 `test_data/...` 路径上失败 / 符号链接到 srcs                                  | 测试假定 cargo 的 cwd，与 runfiles 执行不兼容                                                        | `tags = ["manual"]`；在修改 fork 时通过 `cargo nextest` 运行；hermetic sibling test 覆盖了该契约                                                                          |
| blake3 msvc：`ml64.exe` 未找到                                                                  | cc-rs 在非 windows 宿主机上从 build-script PATH 解析 MASM                                            | `@msvc_cc` 中 `bin/ml64.exe → llvm-ml -m64` 垫片，通过 `blake3` 注释的 PATH 前置                                                                                              |
| audiopus_sys msvc：cmake 要求 VS generator / rc+mt 工具；`try_compile` 需要 `msvcrtd.lib`       | 在 linux/mac 宿主机上交叉 cmake；Debug config → `/MDd` 精简 xwin splat 缺失                          | `CMAKE_GENERATOR_x86_64_pc_windows_msvc=Ninja` + `@msvc_cc` 的 `toolchain.cmake`（`CMAKE_TOOLCHAIN_FILE_x86_64_pc_windows_msvc`）固定 wrapper + Release try-compile + `/MT`（静态 CRT，与插件策略一致） |
| win32 链接问题（一般）                                                                          | —                                                                                                    | 先阅读 `bazel/toolchains/msvc/NOTES.md`：wrapper 自身定位、`lld-link` flavor/driver-link 行为、`LIB`、`/MD` CRT 选择、xwin splat 注意事项                                       |
| `rust_test(crate = ...)` 宏展开时“can't find crate”                                              | rmeta-only 流水化依赖破坏 macro_rules 重新导出 harness 的编译                                        | rust pipelined_compilation 保持 OFF（`.bazelrc` 中有说明）                                                                                                                   |
| 构建脚本找不到 cmake/ninja                                                                      | `--incompatible_strict_action_env` —— 宿主机环境不泄漏                                              | 在 crate 注释（`MODULE.bazel`）中显式设置 `PATH`，而非使用宿主机环境                                                                                                          |

### Cache behavior

- **omp-kata:** read-write gRPC to the in-cluster bazel-remote（`grpcs://bazel-remote.bazel-cache.svc.cluster.local:9092`，TLS 通过已提交的 `infra/bazel-remote/ca.crt`，htpasswd 用户 `ci`）。`--remote_local_fallback` 加上重试使宕机降级为本地执行而不是使构建失败。
- **GitHub-hosted:** 无集群访问；只有 darwin release/warm jobs 在这里使用 bazel 构建。v3 `actions/cache` 磁盘 key 通过前缀 + 裸回退区分 config 和 source 代次（见上文 `bazel-cache` action 部分）；`.github/workflows/bazel-cache-warm.yml` 从与发布消费者相同的 macOS 镜像发布 `release-darwin-*` 归档。
- **msvc repos:** 约 2 GiB 的 LLVM 下载经过 sha256 固定并由 repository-cache 支持；约 1 GiB 的 xwin CRT/SDK splat 在 repo rule 内从 Microsoft CDN 拉取，**不**受 repo-cache 支持 —— 冷 output base 会重新下载。Microsoft 会随时间推进 VS channel payload，因此 win32 actions 在 MS 升级后的 remote-cache 命中率会优雅降级（这与之前的交叉工具链具有相同特性）。Win32 链接 action 也不会跨宿主机 OS 共享缓存条目（linux vs mac 的 clang 二进制）。
- 服务端操作（部署、TLS/auth、egress、poisoning 边界）：`infra/docs/04-arc-and-caching.md` §5。

## Target/variant model and naming conventions

## Platform tag

构建和运行时都使用 platform tag：

`<platform>-<arch>`（例如：`darwin-arm64`、`linux-x64`）。

## Variant model (x64 only)

x64 支持 CPU 变体，在 platform 上以 `//bazel/variants` constraint value 形式编码（baseline → `-Ctarget-cpu=x86-64-v2`，modern → `x86-64-v3`）：

- `modern`（AVX2-capable 路径）
- `baseline`（回退）

非 x64 使用单一默认产物，不带变体后缀。不存在构建时变体 _switch_：每个变体各自是一个 `//:natives-*` 目标，`host` 伪目标通过 AVX2 检测在 modern 与 baseline 之间选择。

### Output filenames

- x64：`pi_natives.<platform>-<arch>-modern.node` 或 `...-baseline.node`
- 非 x64：`pi_natives.<platform>-<arch>.node`

Runtime x64 候选顺序在所选变体候选之后，还包含未加后缀的默认文件名。

## Runtime flags

- `PI_NATIVE_VARIANT`：x64 运行时覆盖；有效值为 `modern` 和 `baseline`。非法值会被忽略，正常检测照常进行。
- `PI_DEBUG_STARTUP`：在 loader 入口、内嵌解压、候选加载以及原生 Tokio runtime 安装周围向 stderr 写入同步的 `[startup] native:…` 标记；可用于定位启动挂起。
- `PI_COMPILED`：compiled-mode signal. Release compilation constant-folds `process.env.PI_COMPILED` to `"true"`；a populated embedded-addon manifest and Bun embedded URL markers also signal compiled mode.

## Embed lifecycle (`embed-native.ts`)

1. **Init**：计算 platform tag（宿主值，可由 release packaging script 覆盖以处理 cross-target 归档）。
2. **Candidate set**：
   - x64 查找 `modern` 和 `baseline` 文件；
   - 非 x64 查找一个默认文件。
3. **Validate availability**：`packages/natives/native` 中必须至少存在一个预期文件。
4. **Generate archive + manifest**：写入 `native/embedded-addons.<platform>-<arch>.tar.gz`，其中包含所有可用的目标插件文件以及 `native/embedded-addon.js`，后者带有 package version、archive metadata 和 file size。
5. **Runtime extraction ready** for compiled mode.

`--reset` 写入 null manifest stub（`embeddedAddon = null`）而不验证 addon 可用性，并删除 `native/` 中任何已存在的 `embedded-addons.*.tar.gz` 归档。

## Dev workflow vs shipped/compiled behavior

## Local development workflow

典型本地循环：

1. 构建插件：`bun --cwd=packages/natives run build`。
2. Loader 解析 platform npm 叶包候选（`@oh-my-pi/pi-natives-<platform>-<arch>`，在可解析时），然后解析 package-local `native/` 以及可执行目录回退候选。
3. 生成的 `native/index.d.ts` 中的声明描述了公共 TS API（仅在 Rust API 表面更改时使用 `build:bindings` 重新生成）。
4. 在 Windows 上进行 package install 时，loader 首先将 `node_modules` 插件拷贝到版本化缓存中，以使运行中的进程不会锁定 Bun 在后续全局更新中必须替换的文件。
5. 成功加载后，尽力移除较旧的 semver 形式的版本缓存目录；清理失败永远不会中止启动。

## Shipped/compiled binary workflow

在 compiled mode 下（`PI_COMPILED`、Bun embedded URL markers 或已填充的 embedded manifest）：

1. Loader 计算版本化缓存目录：`<getNativesDir()>/<packageVersion>`。
2. 如果 embedded manifest 与当前 platform+version 匹配，则当缓存文件缺失或大小不对时，loader 将所选文件从 `embedded-addons.<tag>.tar.gz` 解压到该版本化目录。
3. Runtime 候选顺序包括：
   - 已解压的版本化缓存路径（如果有），
   - 版本化缓存目录，
   - 旧的 compiled-binary 目录（Windows 上为 `%LOCALAPPDATA%/omp`，其他地方为 `~/.local/bin`），
   - package/executable 目录。
4. 第一个成功加载并带有预期版本哨兵的插件被返回。

…

…

这就是为什么 packaging + runtime loader 的预期必须保持一致：文件名、platform tag、CPU variant 以及 embedded manifest version 必须与 `native/loader-state.js` 探测的内容相匹配。

## JS API ↔ Rust export mapping (build sanity subset)

目前生成的声明包含来自以下 Rust 模块的导出：

| Area                   | Representative JS exports                                                                                                               | Rust source                                                                  |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Search/workspace       | `grep`, `search`, `hasMatch`, `fuzzyFind`, `glob`, `listWorkspace`, `invalidateFsScanCache`                                             | `grep.rs`, `fd.rs`, `glob.rs`, `workspace.rs`, `iofs.rs`                     |
| AST/block/summary      | `astGrep`, `astEdit`, `blockRangeAt`, `summarizeCode`                                                                                   | `ast.rs`, `block.rs`, `summary.rs`                                           |
| Text/highlight/tokens  | `visibleWidth`, `truncateToWidth`, `highlightCode`, `countTokens`                                                                       | `text.rs`, `highlight.rs`, `tokens.rs`                                       |
| Shell/PTY/process/keys | `executeShell`, `Shell`, `PtySession`, `Process`, `parseKey`                                                                            | `shell.rs`, `pty.rs`, `ps.rs`, `keys.rs`                                     |
| Media/system/iso       | `encodeSixel`, `copyToClipboard`, `detectMacOSAppearance`, `MacOSPowerAssertion`, `getWorkProfile`, `isoBackend`, `isoStart`, `isoDiff` | `sixel.rs`, `clipboard.rs`, `appearance.rs`, `power.rs`, `prof.rs`, `iso.rs` |

## Failure behavior and diagnostics

## Build-time failures

- Bazel analysis/compile failure: `scripts/bazel-natives.ts` surfaces the exit code plus a stderr tail; re-run the printed `bazel build` line directly (add `--verbose_failures`, `--sandbox_debug`) to iterate.
- Unknown target name: the driver errors with the full known-target list (`//:natives-*` names + `host`/`linux-all`/`darwin-all`).
- No `.node` outputs located after a successful build: driver exits 1 (check `bazel cquery --output=files` manually).
- Basename collision (gnu + musl in one invocation): driver refuses to install and names both sources — split into separate `--dest` dirs.
- `build:bindings` (napi) failure: script surfaces non-zero exit and stderr; artifact builds are unaffected (Bazel never runs the napi CLI).

## Runtime loader failures (`native/loader-state.js`)

- Unsupported platform tag: throws with supported platform list after probing fails.
- No candidate could load: throws with full candidate error list and mode-specific remediation hints.
- Embedded extraction and Windows staging problems: archive/mkdir/write/copy errors are recorded and included in final diagnostics if load fails.
- Version mismatch: install/compiled loads that lack the package-version sentinel are rejected during candidate probing.

## Troubleshooting matrix

| Symptom                                                                | Likely cause                                                                                | Verify                                                            | Fix                                                                                                                                  |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `Cannot find module` 或每个候选的 dynamic library load error            | 缺少 release 产物、错误的 platform tag，或陈旧的 compiled cache                              | 检查 loader error list 和 `packages/natives/native` 中的文件名    | 构建正确的目标（`bun scripts/bazel-natives.ts <t> --dest packages/natives/native`）；删除该 package version 的陈旧缓存                 |
| 运行时缺少导出，但 TypeScript 中存在                                     | 加载了陈旧的 `.node`、生成的声明比二进制新，或 Rust 导出未编译                              | 获取实际候选并检查 `Object.keys(mod)`                              | 重建 native package 并移除陈旧的候选/缓存路径                                                                                       |
| x64 机器在期望 modern 时却加载 baseline                                 | `PI_NATIVE_VARIANT=baseline`、未检测到 AVX2，或 modern 文件不可用                          | 检查环境变量和 `native/` 中的文件名                                | 构建并发布 modern 目标（`bun scripts/bazel-natives.ts linux-x64-modern --dest packages/natives/native`）                              |
| gnu 插件被 musl 覆盖（或反之）                                           | 两者被构建到同一 dest —— 它们按设计共享 canonical basename                                  | 对比 `bazel-bin/natives-<t>/` 来源与已安装文件                    | 使用不同 `--dest` 目录分别调用（release 矩阵已如此）                                                                                |
| 升级后 compiled binary 失败                                              | 陈旧的解压缓存、embedded archive 不匹配或 embedded manifest version 不匹配                  | 检查 `<getNativesDir()>/<version>` 和 loader error list            | 删除该 package version 的版本化缓存；在打包期间重新生成 embedded archive/manifest                                                  |
| `gen:native` 失败，提示 `No native addons found`                         | 内嵌之前未构建所需的平台产物                                                                 | 检查错误文本中的预期列表                                            | 至少为目标构建一个预期产物，然后重新运行 `gen:native`                                                                               |

## Operational commands

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

## Orchestrator-side content-addressed build cache (robomp)

当 `pi-natives` 在 robomp orchestrator（`python/robomp/`）中构建时，工作区通过 content-addressed cache 共享已构建的产物，而不是在每个 issue 的 worktree 中从头重建。缓存是 **orchestrator-side only** —— `bun --cwd=packages/natives run build` 本身不变；缓存位于构建流水线之外，由 `python/robomp/src/natives_cache.py` 中的 `ensure_workspace` 和 task 成功后路径填充/捕获。

### What is cached

缓存从 `packages/natives/native/` 捕获以下文件，并使用计算出的 key。正确的复用假定 keyed 路径的工作区内容与已提交的 `HEAD` 匹配；由于 key 忽略未提交的更改，因此对脏 keyed 路径的构建可能会被以未更改的 key 捕获并在以后被错误地复用：

- `pi_natives.<platform>-<arch>[-variant].node`（glob `pi_natives.*.node`）
- `index.d.ts`
- `index.js`
- `embedded-addon.js`
- `manifest.json`（缓存元数据：key、target triple、捕获时间戳、源工作区、commit）

只有当 `.node` glob 匹配并且每个伴随文件以及 manifest 都存在时，该条目才被视为命中。部分条目在 GC 时被淘汰。

### Cache key

key 是按以下顺序（顺序重要）的 `(path \t git-tree-hash \n)` 对的 `sha256`，随后是 target triple：

1. `crates`（整个子树 —— pi-natives 传递依赖于其他工作区 crate）
2. `Cargo.lock`
3. `Cargo.toml`
4. `rust-toolchain.toml`
5. `packages/natives`（整个子树 —— 构建脚本、`scripts/*`、package.json）

Tree hashes 来自针对 `HEAD` 的一次 `git cat-file --batch-check` 调用；`HEAD` 中缺失的路径会以一个固定的 null hash 折入，从而使跨不发布每个输入的仓库的 key 保持确定性。目标后缀在非 x64 上为 `<platform>-<arch>`。在 x64 上为 `<platform>-<arch>-<TARGET_VARIANT>`，当 `TARGET_VARIANT` 未设置时为 `<platform>-<arch>-host`；Python 缓存不执行 AVX2 检测。

此输入集之外的内容（如 `MODULE.bazel`/`BUILD.bazel` 等 Bazel 定义文件、宿主 glibc、target 后缀以外的环境变量）**不**包含在 key 中。内容哈希也描述已提交的 `HEAD`，而非未提交的工作区更改。在一次超出 key 或未提交的构建输入更改后，删除相关的缓存条目；在上述五个 keyed 路径之一下提交更改会自动产生一个新 key。

### Layout and ownership

- 根目录：`/data/cache/pi-natives`（由 `entrypoint.sh` 与 cargo 缓存一起配置，所有者 `root:omp`，模式 `02770` setgid，使缓存文件继承 `gid=omp` 并对所有 slot 用户可读）。
- Per-repo 子目录：`<root>/<repo-slug>/`，其中 slug 为 `owner__repo`（镜像 `SandboxManager.pool_path`）。
- Per-entry 目录：`<root>/<repo-slug>/<sha256-key>/`，包含缓存文件以及 `manifest.json`。
- Per-repo lockfile：`<root>/<repo-slug>/.lock`（advisory `fcntl.flock`，capture 和 GC 时排他）。
- Capture 期间使用 staging 目录（`.<key>.tmp.<pid>`）；原子地重命名为最终条目路径。崩溃 capture 遗留的陈旧 staging 目录在 GC 时被清扫。

### Populate and capture semantics

- **Populate**（workspace ← cache）在 `ensure_workspace` 内运行。在 key 命中时，`.node` 被 **hardlink** 到工作区（zero-copy，共享 inode）；伴随的 `index.d.ts` / `index.js` / `embedded-addon.js` 被 **拷贝**（独立 inode），因为绑定重新生成流程（`build-bindings.ts` 的 `installGeneratedBindings` 和 `gen-enums.ts`）通过 `open(..., 'w')` 重写这些文件 —— 这种原地截断会通过硬链接传播并损坏缓存。跨设备硬链接失败（`EXDEV`）回退到拷贝。
- **Capture**（cache ← workspace）从 task 成功后的路径运行，前提是构建产生了完整的产物集。Capture 使用 **copy** 而非 hardlink：硬链接 slot-owned 工作区文件会保留缓存 inode 上的 slot UID 所有权，从而破坏 shared-group 模型。拷贝通过 setgid 缓存根创建一个新的 root-owned、`gid=omp` inode。Capture 在 per-repo flock 下是幂等的：相同 key 的并发 capture 返回现有条目。

### Garbage collection

周期性的 GC 循环在 `WorkerPool` 中运行，每个仓库有两个上限。当任一上限被超出时，最旧的条目（按 `manifest.json.captured_at`）首先被丢弃：

- 条目数上限（`max_entries_per_repo`，默认 8）
- 字节数上限（`max_bytes`，默认 4 GiB）

在 GC 之前硬链接 `.node` 的工作区通过内核 inode 引用计数保留访问权 —— 对缓存条目的 `rmtree` 不会从工作区中删除该文件。

### Configuration (settings on `robomp.config.Settings`)

| Env var                                     | Default                  | Effect                                                                                              |
| ------------------------------------------- | ------------------------ | --------------------------------------------------------------------------------------------------- |
| `ROBOMP_NATIVES_CACHE_ENABLED`              | `true`                   | Master switch. When false the populate/capture hooks no-op and every workspace builds from scratch. |
| `ROBOMP_NATIVES_CACHE_ROOT`                 | `/data/cache/pi-natives` | Cache root directory. Must be `root:omp 02770` for cross-slot reads.                                |
| `ROBOMP_NATIVES_CACHE_MAX_ENTRIES_PER_REPO` | `8`                      | LRU entry-count cap, per repo slug.                                                                 |
| `ROBOMP_NATIVES_CACHE_MAX_BYTES`            | `4294967296` (4 GiB)     | LRU byte cap, per repo slug.                                                                        |
| `ROBOMP_NATIVES_CACHE_GC_INTERVAL_SECONDS`  | `3600`                   | Period of the background GC loop in `WorkerPool`.                                                   |

### Manual invalidation

- 单个 key：`rm -rf /data/cache/pi-natives/<repo-slug>/<sha256>`。
- 单个 repo：`rm -rf /data/cache/pi-natives/<repo-slug>`。
- 全部：`rm -rf /data/cache/pi-natives/*`（保留根目录以使其 setgid 模式生效）。
- 卡住的锁：`rm /data/cache/pi-natives/<repo-slug>/.lock`（仅在没有 orchestrator 进程访问该 repo 时）。

For a fixed target suffix, a committed `HEAD` change under `crates`, `Cargo.lock`, `Cargo.toml`, `rust-toolchain.toml`, or `packages/natives/` produces an automatic miss. Changing platform/architecture, or `TARGET_VARIANT` on x64, also selects a different key. Merely editing an uncommitted worktree changes neither the `HEAD` hashes nor the key.
