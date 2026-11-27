# Fork 工程现状线索

本页保存当前仍有本地代码差异的散点修复线索，以及使用、实现定位与验证参考。部分条目的必要性仍待按实际使用场景核对；已被上游吸收的特性与修复不列入本页。

## 上游缺陷散点修复

基础设施修复只在已确认使用场景确实依赖时保留；不因历史上修复过就形成独立维护义务。以下剩余补丁是待核对必要性的现状线索，不代表已确认必须保留，也不能在未核实依赖前直接认定可删除。上游已包含等价修复后，移除重复实现及 fork 额外保留的回归测试，fork 测试聚焦仍有效的本地差异。

- `packages/coding-agent/src/lsp/clients/biome-client.ts`：Windows 上 abort 与 stdout 管道读取 race，脚本包装的孙子进程不再持有管道造成永久等待。
- `packages/utils/src/ptree.ts`：stdout 经包装流跟踪 EOF（attachSignal 等待 stdout/stderr 收尾、stdout 惰性暴露与完成后收口），孙子进程在截止/中止后持有管道不再永久挂起读取；`packages/utils/test/ptree-timeout.test.ts` 覆盖。
- `packages/coding-agent/src/session/agent-session.ts`：用户及自定义 aside 的预处理跨越 `switchSession()` 时，统一等待已有代际结算屏障；切换回滚保留原会话的消息，成功切换仍丢弃旧会话的延迟消息。
- `packages/utils/src/sqlite.ts`：输入历史、会话标题和 recap 的损坏恢复不得遗漏多个坏页之间仍可读取的记录；保留损坏原库和既有恢复上限，不改变健康数据库的读取路径。
- `packages/natives/native/loader-state.js`：并发冷启动的 embedded 提取与 Windows 包安装 staging 均先写唯一临时文件再原子发布；Windows 已加载 winner 阻止替换时，仅完整字节一致才可复用，否则保留发布错误，不能截断已发布 DLL。
- `packages/coding-agent/src/tools/read-archive.ts`：Windows 同尺寸快速重写归档并恢复 mtime 时，ctime 也可能不变；该平台不复用仅由文件元数据验证的归档目录缓存，避免返回旧成员名称或读取错误成员。其他平台保留既有有界缓存。
- `crates/natives/src/memory.rs`：glibc Linux 保留原有堆修剪计数与释放通知，其他目标的平台空操作使用独立 `const fn` 定义，满足 Windows Clippy 检查，不屏蔽 `missing_const_for_fn` 或改变运行时行为。
- `scripts/ci-release-build-binaries.ts`：上游基线 `b0756921` 的 Linux x64 musl baseline target 写成 `bun-linux-x64-musl-baseline`，不符合 Bun 的 `SIMD-Libc` 顺序；改为 `bun-linux-x64-baseline-musl`，保留 musl 与 baseline CPU 兼容目标，不改成 glibc 或 modern。

上游缺陷归属：已集成基线 `can1357/oh-my-pi@88a69582c755bd000e8dc0290981fc787a4f400c` 的 [`writeEmbeddedAddonFile`、`maybeExtractEmbeddedAddon`](https://github.com/can1357/oh-my-pi/blob/88a69582c755bd000e8dc0290981fc787a4f400c/packages/natives/native/loader-state.js#L456-L524) 直接重命名覆盖缓存 DLL；Windows 已映射该文件时返回 `EPERM`。提取失败后 [`loadNative` 仍尝试旧缓存](https://github.com/can1357/oh-my-pi/blob/88a69582c755bd000e8dc0290981fc787a4f400c/packages/natives/native/loader-state.js#L857-L890)，且版本校验接受同版本的旧构建，可能使 Bash 预览实例化 `RunTrace` 时抛出 `undefined is not a constructor`。本条记录该上游基线的缺陷，不断言后续上游版本状态。

### Windows 验证发现的待提 PR 缺陷（2026-11-15）

归属核对基线为 [`can1357/oh-my-pi@7c49c11aa5bbaf3f418406583096168ad5b8c6dc`](https://github.com/can1357/oh-my-pi/tree/7c49c11aa5bbaf3f418406583096168ad5b8c6dc)。以下缺陷路径已在该基线源码中确认；失败与修复验证来自 Windows x64、Bun 1.4.4 的本 fork 工作树，并非单独运行干净上游的结果。尚未核对更晚的上游 main，也未创建 PR；提交前须在当时上游复核并拆分最小补丁，不能把本次整个工作树作为上游修复提交。

#### 1. Windows：阻塞的 builtin stdin 不响应取消

- **上游证据：** [`host.rs` 的 `pollable_fd`／`Stdin::read`](https://github.com/can1357/oh-my-pi/blob/7c49c11aa5bbaf3f418406583096168ad5b8c6dc/crates/pi-builtins/src/host.rs#L1854-L1885)只在 Unix 等待可读并轮询取消；非 Unix 返回 `None`，随后直接阻塞在 `self.file.read(buf)`。
- **真实影响与复现：** Windows 管道写端保持打开但不写数据，builtin 开始读取后再取消；开始读取前的 token 检查不能唤醒已经阻塞的读取，abort／timeout 无法及时结清。现有回归为 `pi-builtins` 的 `extras::tests::cancelling_a_blocked_read_returns_130`。
- **最小修复范围：** `crates/pi-builtins/src/host.rs`、该 crate 的 `Cargo.toml`；仅 Windows pipe 使用 `PeekNamedPipe` 等待数据并检查取消，保留 broken pipe 的 EOF、非 pipe 及 Unix 行为。
- **已执行验证：** 当时的 Windows workspace Nextest 与 Cargo doctest 均 exit=0，现有取消回归通过。报告：`runs/test-timing/2026-11-15T09-08-50.519Z-41764-12232413/run.json`。未据此声称 Linux 或发布二进制通过。

#### 2. JavaScript subprocess：硬取消丢失已经产生的输出

- **上游证据：** [`process-entry.ts`](https://github.com/can1357/oh-my-pi/blob/7c49c11aa5bbaf3f418406583096168ad5b8c6dc/packages/coding-agent/src/eval/js/process-entry.ts)将输出直接交给异步 IPC；[`spawnJsProcess().terminate()`](https://github.com/can1357/oh-my-pi/blob/7c49c11aa5bbaf3f418406583096168ad5b8c6dc/packages/coding-agent/src/eval/js/context-manager.ts#L1039-L1087)先终止进程，再等待 disconnect。disconnect 只能结清已越过通道的数据，不能恢复仍在被杀子进程发送队列中的输出。
- **真实影响与复现：** cell 已打印，父线程暂时同步阻塞，使消息尚未派发时触发 abort；调用者收到取消结果，却收不到此前输出。现有 `test/eval/js-cancel-output.test.ts` 的 “keeps that output, before the run settles, in subprocess mode” 确定性覆盖此窗口。
- **最小修复范围：** `src/eval/js/{process-entry,worker-protocol,context-manager}.ts` 及 `src/cli.ts` 的对应协议类型；仅 subprocess text／display 使用自有临时 outbox 同步原子发布，IPC 通知序号，进程退出后顺序排空并去重、清理。不改变其他 worker 或 thread-mode 协议。
- **已执行验证：** `bun test packages/coding-agent/test/eval/js-cancel-output.test.ts` 对应的完整 TS producer 四项通过，包含 subprocess／worker-thread 取消输出及 bridge 未完成时死亡的错误传播，无跳过。报告：`runs/test-timing/2026-11-15T09-25-19.657Z-36216-762b9182/run.json`；该整轮另有其他失败，不能写成整轮通过。

#### 3. vendored jaq-core：公开示例缺少可编译依赖

- **上游证据：** [`src/lib.rs` 的公开 doctest](https://github.com/can1357/oh-my-pi/blob/7c49c11aa5bbaf3f418406583096168ad5b8c6dc/crates/vendor/jaq-core/src/lib.rs#L9-L42)使用 `jaq_json` 和 `jaq_std`，但该基线的 [`Cargo.toml`](https://github.com/can1357/oh-my-pi/blob/7c49c11aa5bbaf3f418406583096168ad5b8c6dc/crates/vendor/jaq-core/Cargo.toml)没有相应 dependency／dev-dependency，workspace doctest 无法解析这两个 crate。这是文档／构建缺陷，不是 jaq 查询结果错误。
- **最小修复范围：** `crates/vendor/jaq-core/{Cargo.toml,src/lib.rs}`、生成的 `Cargo.lock` 及 `jaq-std/src/lib.rs` 的嵌入说明；补示例依赖，使用不要求宿主 `debug`／`halt_error` 函数的嵌入组合，保留实际编译、排序、遍历和输出断言。Windows 示例使用独立栈，不将 doctest 改为忽略或仅编译。
- **已执行验证：** 上述真实 workspace doctest 中的 jaq-core 示例通过。是否应同时向原 jaq 仓库提交须另核对其当前清单，不能仅凭 OMP 的 vendored 快照认定原仓库现状。

#### 不混入上游 bug PR 的变更

- 恢复完整 Provider／模型目录是本次明确选择的 fork 策略回退；退役模型 ID、中文／compact 默认值、原生表单及测试缺失 settings／认证／运行所有权上下文，分别属于过期 fixture 或本地合同对齐。
- capability 的禁用 Provider item 二次过滤条件是 fork 差异：上述上游基线没有该条件，不能将本次 `includeDisabledProviders` 修正报为上游缺陷。
- MCP 初始自签名证书被接受由继承的 `NODE_TLS_REJECT_UNAUTHORIZED=0` 导致；修正的是测试环境隔离，不是上游 TLS 漏洞。
- stats Windows 端口查询曾合并 `tasklist`／CIM 以减少一次进程启动，未单独量化耗时收益。现已恢复上游的 `tasklist` 后 CIM 查询顺序，仅保留 PowerShell 过滤器单引号修复；进程身份校验和安全回退不变。

## 构建与分发前置条件

- 源码开发：`bun setup` 安装 workspace 依赖、构建 native、生成 HTML export viewer 和内置浏览器 Relay 扩展。Git checkout 使用 Nix 2.27 或更新版本；保留仓库中的 `flake.lock`，并用 `git submodule update --init --recursive -- vendor/openwiki` 初始化固定 OpenWiki 提交。
- Windows 本地构建：`bun run local` 替换 `%LOCALAPPDATA%\omp\omp.exe`，可用 `PI_INSTALL_DIR` 改目标；[替换与回滚合同](../openspec/specs/fork-runtime/spec.md#requirement-安装与运行)。
- CNB：Windows 需要 PATH 上的 Node.js 和 `@cnbcool/cnb-cli`，以及目标 Release 读写权限（可用 `CNB_TOKEN`）。两端使用同版 Bun 和仓库固定 Rust 工具链，初始化 `vendor/openwiki`；Ubuntu-24.04 WSL2 还需 `zip`，Linux 使用 `cargo-zigbuild` 和 Zig，Windows 使用 MSVC。入口为 `bun run cnb`，目标、Git-only 同步、缓存和上传规则见 [CNB 交付规格](../openspec/specs/fork-runtime/spec.md#requirement-cnb-精确输入缓存与四附件交付)。

## 验证入口

入口、授权和证据要求见[验证规格](specs/fork-maintenance/spec.md#requirement-使用上游验证入口)；既往结果见[历史验证记录](verification-history.md)，不能替代本次验收。

- Windows 性能采集：`bun scripts/monitor-system.ts` 启动后台采集，每两秒写入 CPU、内存、磁盘容量和 I/O 到系统临时目录 `omp-test-monitor-*/samples.jsonl`。`--stop <监控目录>` 停止并保留数据；`--report <监控目录>` 显示均值、峰值和容量，采集期间也可读取。
- Windows Chromium 验证须隔离 `USERPROFILE`、`APPDATA`、`LOCALAPPDATA` 和浏览器数据目录；Windows Rust 沿用现有 MSVC 发现。
- Provider 保存边界：`ConfigFile`／`ModelsConfigFile` 只做读取与迁移，没有主动 `models.yml` writer 或 provider 保存 API，Team 不提供配置入口。文本 `edit` 不具备共享程序服务的锁、版本校验或事务保证。
