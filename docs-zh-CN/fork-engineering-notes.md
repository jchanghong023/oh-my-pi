# Fork 工程现状线索

本页保存当前仍有本地代码差异的散点修复线索，以及使用、实现定位与验证参考。部分条目的必要性仍待按实际使用场景核对；已被上游吸收的特性与修复不列入本页。

## 上游缺陷散点修复

基础设施修复只在已确认使用场景确实依赖时保留；不因历史上修复过就形成独立维护义务。以下剩余补丁是待核对必要性的现状线索，不代表已确认必须保留，也不能在未核实依赖前直接认定可删除。上游已包含等价修复后，移除重复实现及 fork 额外保留的回归测试，fork 测试聚焦仍有效的本地差异。

- `packages/coding-agent/src/lsp/clients/biome-client.ts`：Windows 上 abort 与 stdout 管道读取 race，脚本包装的孙子进程不再持有管道造成永久等待。
- `packages/utils/src/ptree.ts`：stdout 经包装流跟踪 EOF（attachSignal 等待 stdout/stderr 收尾、stdout 惰性暴露与完成后收口），孙子进程在截止/中止后持有管道不再永久挂起读取；`packages/utils/test/ptree-timeout.test.ts` 覆盖。
- `packages/coding-agent/src/session/agent-session.ts`：用户及自定义 aside 的预处理跨越 `switchSession()` 时，统一等待已有代际结算屏障；切换回滚保留原会话的消息，成功切换仍丢弃旧会话的延迟消息。
- `packages/utils/src/sqlite.ts`：输入历史、会话标题和 recap 的损坏恢复不得遗漏多个坏页之间仍可读取的记录；保留损坏原库和既有恢复上限，不改变健康数据库的读取路径。
- `packages/coding-agent/src/launch/client.ts`、`packages/natives/native/loader-state.js`：独立长寿命 daemon broker 在实际 worker 启动、native 加载前，把 native 缓存所有者切到自身 scope runtime 的 `natives/`，不能继承短寿命 creator core 的独占 `PI_NATIVES_DIR`；正常 core／worker 的显式缓存根语义不变。并发冷启动的 embedded 提取与 Windows 包安装 staging 均先写唯一临时文件再原子发布；Windows 已加载 winner 阻止替换时，仅完整字节一致才可复用，否则保留发布错误，不能截断已发布 DLL。
- `packages/coding-agent/src/tools/read-archive.ts`：Windows 同尺寸快速重写归档并恢复 mtime 时，ctime 也可能不变；该平台不复用仅由文件元数据验证的归档目录缓存，避免返回旧成员名称或读取错误成员。其他平台保留既有有界缓存。
- `crates/pi-shell/src/shell.rs`：TERM 宽限等待按平台编译：Unix 继续异步等待清理，Windows 的 TERM 本已强制结束进程，返回立即就绪的 Future；不增加延迟，也不屏蔽 `clippy::unused_async`。
- `crates/pi-natives/src/memory.rs`：非 Linux/glibc 平台的空操作入口使用 `const fn`，满足 Windows 静态门禁；Linux/glibc 继续执行原有工作计数、释放通知与空闲裁剪，不屏蔽 lint。
- `crates/vendor/brush-core/src/interp.rs`：前台子进程已启动后收到取消时，仍通过既有取消感知等待保留 TERM 清理宽限；不能因等待前的取消检查提前丢弃子进程并强制结束，导致清理或输出丢失。取消总时限与进程隔离规则不变。
- `crates/pi-shell/src/process.rs`：取消时每一波信号在发送前冻结自有目标，同一进程／进程组不重复投递 TERM，避免重入清理 trap；跨组后代与 TERM 后新生进程仍由后续 KILL 波回收，保留既有进程身份保护和宽限时限。
- `crates/pi-natives/src/memory.rs`：glibc Linux 保留原有堆修剪计数与释放通知，其他目标的平台空操作使用独立 `const fn` 定义，满足 Windows 严格静态门禁，不屏蔽 `missing_const_for_fn` 或改变运行时行为。
- `python/robomp/src/tasks.py`：GitHub 元数据读取失败须向 delivery 执行器传播，保留重试机会，不能把未执行的 PR 审查、review 或 conversation 当作已成功处理；映射缺失或 branch 缺失时查询 PR 的失败同样不得吞掉。Robomp 测试保留手动入口，不纳入默认 fork 门禁；Windows 原生不支持。
- `scripts/ci-release-build-binaries.ts`：上游基线 `b0756921` 的 Linux x64 musl baseline target 写成 `bun-linux-x64-musl-baseline`，不符合 Bun 的 `SIMD-Libc` 顺序；改为 `bun-linux-x64-baseline-musl`，保留 musl 与 baseline CPU 兼容目标，不改成 glibc 或 modern。

### 本轮 fulltest 的待提 PR 缺陷（2026-11-15）

归属核对基线为 [`can1357/oh-my-pi@7c49c11aa5bbaf3f418406583096168ad5b8c6dc`](https://github.com/can1357/oh-my-pi/tree/7c49c11aa5bbaf3f418406583096168ad5b8c6dc)。以下缺陷路径已在该基线源码中确认；失败与修复验证来自 Windows x64、Bun 1.4.4 的本 fork 工作树，并非单独运行干净上游的结果。尚未核对更晚的上游 main，也未创建 PR；提交前须在当时上游复核并拆分最小补丁，不能把本次整个工作树作为上游修复提交。

#### 1. Windows：阻塞的 builtin stdin 不响应取消

- **上游证据：** [`host.rs` 的 `pollable_fd`／`Stdin::read`](https://github.com/can1357/oh-my-pi/blob/7c49c11aa5bbaf3f418406583096168ad5b8c6dc/crates/pi-builtins/src/host.rs#L1854-L1885)只在 Unix 等待可读并轮询取消；非 Unix 返回 `None`，随后直接阻塞在 `self.file.read(buf)`。
- **真实影响与复现：** Windows 管道写端保持打开但不写数据，builtin 开始读取后再取消；开始读取前的 token 检查不能唤醒已经阻塞的读取，abort／timeout 无法及时结清。现有回归为 `pi-builtins` 的 `extras::tests::cancelling_a_blocked_read_returns_130`。
- **最小修复范围：** `crates/pi-builtins/src/host.rs`、该 crate 的 `Cargo.toml`；仅 Windows pipe 使用 `PeekNamedPipe` 等待数据并检查取消，保留 broken pipe 的 EOF、非 pipe 及 Unix 行为。
- **已执行验证：** `bun run test:rs --full` 完成，现有取消回归通过；Nextest 与 workspace doctest 均 exit=0。报告：`runs/test-timing/2026-11-15T09-08-50.519Z-41764-12232413/run.json`。未据此声称 Linux 或发布二进制通过。

#### 2. JavaScript subprocess：硬取消丢失已经产生的输出

- **上游证据：** [`process-entry.ts`](https://github.com/can1357/oh-my-pi/blob/7c49c11aa5bbaf3f418406583096168ad5b8c6dc/packages/coding-agent/src/eval/js/process-entry.ts)将输出直接交给异步 IPC；[`spawnJsProcess().terminate()`](https://github.com/can1357/oh-my-pi/blob/7c49c11aa5bbaf3f418406583096168ad5b8c6dc/packages/coding-agent/src/eval/js/context-manager.ts#L1039-L1087)先终止进程，再等待 disconnect。disconnect 只能结清已越过通道的数据，不能恢复仍在被杀子进程发送队列中的输出。
- **真实影响与复现：** cell 已打印，父线程暂时同步阻塞，使消息尚未派发时触发 abort；调用者收到取消结果，却收不到此前输出。现有 `test/eval/js-cancel-output.test.ts` 的 “keeps that output, before the run settles, in subprocess mode” 确定性覆盖此窗口。
- **最小修复范围：** `src/eval/js/{process-entry,worker-protocol,context-manager}.ts` 及 `src/cli.ts` 的对应协议类型；仅 subprocess text／display 使用自有临时 outbox 同步原子发布，IPC 通知序号，进程退出后顺序排空并去重、清理。不改变其他 worker 或 thread-mode 协议。
- **已执行验证：** `bun test packages/coding-agent/test/eval/js-cancel-output.test.ts` 对应的完整 TS producer 四项通过，包含 subprocess／worker-thread 取消输出及 bridge 未完成时死亡的错误传播，无跳过。报告：`runs/test-timing/2026-11-15T09-25-19.657Z-36216-762b9182/run.json`；该整轮另有其他失败，不能写成整轮通过。

#### 3. vendored jaq-core：公开示例缺少可编译依赖

- **上游证据：** [`src/lib.rs` 的公开 doctest](https://github.com/can1357/oh-my-pi/blob/7c49c11aa5bbaf3f418406583096168ad5b8c6dc/crates/vendor/jaq-core/src/lib.rs#L9-L42)使用 `jaq_json` 和 `jaq_std`，但该基线的 [`Cargo.toml`](https://github.com/can1357/oh-my-pi/blob/7c49c11aa5bbaf3f418406583096168ad5b8c6dc/crates/vendor/jaq-core/Cargo.toml)没有相应 dependency／dev-dependency，workspace doctest 无法解析这两个 crate。这是文档／构建缺陷，不是 jaq 查询结果错误。
- **最小修复范围：** `crates/vendor/jaq-core/{Cargo.toml,src/lib.rs}`、生成的 `Cargo.lock` 及 `jaq-std/src/lib.rs` 的嵌入说明；补示例依赖，使用不要求宿主 `debug`／`halt_error` 函数的嵌入组合，保留实际编译、排序、遍历和输出断言。Windows 示例使用独立栈，不将 doctest 改为忽略或仅编译。
- **已执行验证：** 上述 `bun run test:rs --full` 的真实 workspace doctest 完成，jaq-core 示例通过；同一 Rust 报告可查。是否应同时向原 jaq 仓库提交须另核对其当前清单，不能仅凭 OMP 的 vendored 快照认定原仓库现状。

#### 不混入上游 bug PR 的变更

- 恢复完整 Provider／模型目录是本次明确选择的 fork 策略回退；退役模型 ID、中文／compact 默认值、原生表单及测试缺失 settings／认证／运行所有权上下文，分别属于过期 fixture 或本地合同对齐。
- capability 的禁用 Provider item 二次过滤条件是 fork 差异：上述上游基线没有该条件，不能将本次 `includeDisabledProviders` 修正报为上游缺陷。
- MCP 初始自签名证书被接受由继承的 `NODE_TLS_REJECT_UNAUTHORIZED=0` 导致；修正的是测试环境隔离，不是上游 TLS 漏洞。
- stats Windows 端口查询曾合并 `tasklist`／CIM 以减少一次进程启动，未单独量化耗时收益。现已恢复上游的 `tasklist` 后 CIM 查询顺序，仅保留 PowerShell 过滤器单引号修复；进程身份校验和安全回退不变。

## 使用与验证参考

以下材料仅供查找实现和验证入口，不构成需求基线，也不表示本次已运行或通过。

### 本地构建与 CNB 分发

- Windows 执行 `bun run local` 构建并直接替换 `%LOCALAPPDATA%\omp\omp.exe`，可用 `PI_INSTALL_DIR` 指定安装目录。不执行测试、native 加载探测或 exe 试运行，不杀已有进程；先将旧 exe 改名再换入新版，换入失败恢复旧文件，仍被旧进程占用的映像保留。
- Windows 执行 `bun run cnb`，默认发布到 `jchanghong/bin` 仓库已创建的 `omp` Release，无需交互输入；可用 `--repo` 和 `--tag` 显式覆盖目标。脚本先在 Windows 和 Ubuntu-24.04 WSL2 的 `/root/oh-my-pi` 工作区执行 `git pull --ff-only`，再并行准备两端二进制：各端独立判断缓存，输入完全匹配时复用已成功完成的二进制并跳过 native 构建和打包，否则重新构建并复用本机依赖及编译缓存。无论是否命中缓存，都并行上传并覆盖 `omp-windows-x64.exe` 和 `omp-linux-x64`，不再需要 `--overwrite`，不修改其他附件；不打包、上传或向 CNB 推送源码。WSL 源码及 `scripts/cnb-wsl.sh` 只能通过 Git 远端同步，不复制、移动或打补丁绕过脏工作区检查。
- 两个命令只负责构建交付，便于手动验证，不运行任何测试、冒烟、worker 探测、native 加载探测或构建产物试运行。CNB 不做全仓源码哈希扫描、重复 WSL 预检、Release 附件竞态检查及发布后重复查询；只保留干净工作区、Git 提交一致性、Bun 版本、构建输出及上传接口所必需的检查和确认。
- CNB 上传在 Windows 端执行：需安装 Node.js 和官方 `@cnbcool/cnb-cli`（npm 全局安装），并确保 `node` 和 `cnb` 在 `PATH` 上。CNB CLI 需具备目标仓库 Release 读写权限；`CNB_TOKEN` 可提供令牌。Windows 和 WSL 需使用相同版本的 Bun 及 `rust-toolchain.toml` 固定的 Rust 工具链；Bun 版本不一致会在编译前拒绝。WSL 使用 `cargo-zigbuild` 和 Zig 构建 Linux glibc 2.17 x64 baseline，Windows 使用 Cargo 和 MSVC 构建 x64 modern，两端共用 `scripts/build-release-native.ts` 和 `scripts/ci-release-build-binaries.ts`，分发不依赖 Bazel。遗留的 `tool-views.generated.js` 作为生成产物忽略，不移动或删除用户文件。该分发不改变 `omp update` 或安装器的 GitHub 来源。
- 仓库根目录 `.cnb.yml` 提供单独的 `main`／`api_trigger` fastcheck 流水线，使用 64 核 amd64 节点，不发布产物；CNB `docker:cache` 分别缓存系统依赖、Bun／Rust 工具链和项目 Bun 依赖包，版本键包含对应 Dockerfile、工具链或依赖清单及锁文件。每轮仍执行 `bun install --frozen-lockfile` 及安装脚本，不缓存检查结果。手动触发需要 `repo-cnb-trigger:rw`；配置须提交到目标分支，或通过触发接口的 `config` 参数传入。

### Fork 验证门禁

- 三层门禁直接运行既有 Bun／Cargo 原语，记录 Git 版本和工作区状态，保留预算和失败汇总；不扫描全仓内容指纹，也不因运行期间源码或临时文件变化中止或自动重跑。fastcheck 不运行测试，保留原有工具和增量编译缓存。slowtest 运行本机 fulltest 及适用的 WSL fulltest，各端独立选测并保留固定提交同步；不缓存门禁或完整命令结果，也不引入自建结果缓存框架。
- `bun scripts/monitor-system.ts` 在 Windows 后台启动性能采集器，每 2 秒将 CPU、内存、各磁盘卷容量及各物理磁盘 I/O 繁忙度、读写速率和队列长度写入系统临时目录 `omp-test-monitor-*/samples.jsonl`，启动后立即返回。入口使用 TypeScript/Bun，常驻 PowerShell 进程读取 Windows 原生性能计数器，避免每轮创建进程。`--stop <监控目录>` 请求停止并保留数据；`--report <监控目录>` 显示 CPU/内存及各磁盘 I/O 均值、峰值和容量，可在采集中读取。数据包含时间戳和采集耗时，便于对齐测试阶段；容量使用率与 I/O 繁忙度分开记录。
- 日常 `bun run test`、`test:ts`、`test:rs`、fulltest 和 slowtest 测 fork 自有功能：OpenSpec、Team/Goal、Knowledge 索引与 OpenWiki、company/Ascend/CodeAgent、offline/代理/统一数据根、共享 Skills、compact/中文 TUI、状态栏、审批/个人命令/默认值及分发消费者契约。`/wt` 策略由消费者测试覆盖，不展开完整上游 task/worktree 与 pi-vcs。
- 通用 Browser/upload/relay/CMUX/Tern、shell/VCS/builtins、task/worktree、独立 RPC/ACP/SDK、全 provider 矩阵、基础 TUI 与旁支包完整回归，以及纯上游继承或仅 bugfix 专项不随日常门禁运行，即使规格记载亦然；上游测试文件及已有显式手动入口保留。真实 PTY 保留不同错误、状态和焦点边界；当前消费者仍覆盖适用的冷启动、准备失败／EOF、冷恢复、owner／profile 隔离、权限、取消、Windows 句柄和公开打包资源。独立 Python SDK、Robomp、legacy 通用 SDK 只保留手动入口。静态检查和编译范围不缩减，不新增 skip 或放宽时限。
- 默认 Bun 门禁只在 fork 白名单内以 `--changed` 按变更及依赖选测；缺少合格基线或工具不支持时回退完整白名单，不回退上游全量。`CI` 与本地 TS 的 `OMP_TEST_SHARD` 不改变本地范围；仓库脚本自测仅对应脚本或门禁模块本轮变化时选入，独立 `test:scripts` 入口保留。
- 根目录的 `docs/`、`docs-zh-CN/` 和 `AGENTS.md` 不作为 Git 测试选测输入，不会单独触发 Bun 全量回退或独立 UI smoke。混合变更仍按其他运行输入判断；包内 Markdown、提示词等运行资源不在排除范围内。缺少合格基线和显式 `--full` 时的行为不变。
- `bun run fulltest --full` 显式覆盖当前平台支持的完整 Bun、Rust workspace、Python 普通套件、Go/Rust SDK 与仓库脚本测试，不使用 fork 白名单、变更选测、testmon 或环境分片；默认范围不变。全量模式不发现或运行 `vendor/openwiki` 子模块自身的测试，OMP 宿主侧的 OpenWiki 集成测试仍在范围内。测试自身 skip、平台不支持、真实桌面输入与另需单独授权的集成仍受原边界约束。
- 全量门禁不自动执行 POSIX 安装路由用例；需要时在支持 POSIX `sh` 的环境中显式运行 `bun test ./scripts/install-tests/fork-installer-routing.test.ts`，也可通过 `bun run test:scripts` 执行。默认 fulltest 仍按变更选入仓库脚本自测。
- `bun run test:rs` 用 Cargo 包和 Nextest namespace 筛选 `omp-knowledge` 全包和 `omp-natives` 的 `knowledge::` 绑定测试，scope 为 `rust-fork-features`。独立 doctest 阶段运行 `cargo test -p omp-knowledge --doc --no-fail-fast`，报告真实命令、退出码及命令墙钟时间；Cargo doctest 无标准 JUnit 报告，记 `report=not-supported`。native `cdylib` 无 doctest，不生成虚构用例或 PASS，也不运行上游 tree-sitter-go 文档例子凑数。保留同平台配置和正常 Cargo 增量编译缓存。非 Rust 构建、配置、清单、锁文件、工具链、生成输入与跨语言依赖也可能影响 Rust。
- Windows 的 Rust 门禁、本地 native 构建和发布 native 构建共用 VS Build Tools 的 CMake/Ninja 探测，优先使用现有 `PATH` 中的工具；Rust 门禁找不到 `vswhere` 时仍交给 Cargo 报告缺失工具。
- 默认 fulltest 使用同一真实 clean、完整成功的 fork 基线，以 cargo-delta 0.5.0 分析 Git 变更和 Cargo metadata 中的 crate 逆向依赖，再将受影响包与 fork 范围取交集，使用标准 Cargo 包选择执行 Nextest；空交集不启动 Cargo，`omp-knowledge` 被选才运行 doctest。tripwire 配置覆盖全局及无法安全归属的输入；缺基线、工具缺失或失败、输出无效以及无法确定边界时回退完整 fork 范围。使用前安装 `cargo install cargo-delta --version 0.5.0 --locked`，门禁不自动安装；标准分析缓存不是测试结果缓存。直接 `test:rs` 保持完整 fork 范围，`--full` 保持完整 workspace，不使用 delta。
- 独立 UI smoke 和仓库脚本仍按 Git 变更规划；CLI、native、Team、TUI 等实际依赖变化须运行 UI。缺基线或依赖未知时保守运行，静态检查及必要 native 准备始终全局执行。Git／cargo-delta 未选证据包含有效基线 revision、相对变更路径、零选择及原因，delta 另记录空包列表，不虚构 XML、用例或耗时。实际执行的受影响 Nextest 使用 `cargo-delta`／`affected` 并记录包和基线及真实 JUnit；全量回退仍使用 `cargo-nextest`／`full`。doctest 无 JUnit，按实际阶段结果报告，未选不冒充 PASS。混合报告保留实际用例和失败；affected、partial、失败报告不能作为完整基线，不提交报告 sidecar 或改写历史。
- Bun 与 cargo-delta 的依赖分析均有近似：动态依赖、环境或外部输入可能漏检，affected 不等于完整新回归。Bun fork 套件版本见 [`BUN_FORK_SUITE_REVISION`](../scripts/test-reporting.ts#L9)；范围变化后须在干净工作区通过一次获授权的完整 fork 回归才能建立新基线，旧范围报告不可复用。报告区分本轮实际执行、deselected、not-selected 与未运行；默认 fulltest scope 为 `fulltest: fork feature suites`，控制台范围为 `fork-features`。历史用例耗时不算本轮新执行，也不能称全仓全量通过。普通失败继续其他独立工作，保留首个实际失败退出码；取消、参数错误和原预算到限仍停止本次拥有的工作。
- CLI 子进程夹具在公共 harness 或独立启动器中静态导入真实使用的 Tools registry，补足 Bun 无法追踪的 spawn 路径字符串；不导入或执行 CLI 主入口，不仅为某两个实验源码添加特例依赖。
- 并发门禁中的时序断言以实际完成边界为准：Superpowers 服务启动先等待完整换行终止的状态记录，再验证 HTTP 与进程退出；Settings 的“排队保存后发生外部编辑”场景须在同一 JS turn 完成外部写入，再 flush，不能让异步文件 I/O 与 100ms debounce 自由竞争后仍假定固定顺序。原退出、回收、外部值优先及内存状态断言保持。
- Knowledge CLI 的 23 个既有真实消费者场景使用各自的 provider、观测、配置、工作区、子进程和清理，最多两个场景并行，单槽预算仍串行。预备索引只保留不可变数据库／WAL 字节，每例复制后独立打开；不共享运行期数据库、CLI 或会话，不减少分页、控制字符、错误及真实至少 500ms 等待覆盖。
- fastcheck、fulltest、slowtest 默认隐藏成功用例、成功分块及成功命令输出，仅显示失败用例和错误诊断；最外层最终状态、耗时、退出码和报告路径保留。`--debug` 不恢复成功用例刷屏。静默只影响呈现，本轮实际执行的用例写入 JUnit／计时结果，平台跳过明确报告，首错通知、失败继续、取消与预算不变。真实桌面输入仍需单独授权。
- 手动 CI 只执行构建、打包及其必要准备，不执行单元、集成、冒烟或安装测试，发布只依赖版本元数据、二进制和浏览器扩展构建成功。保留的 `ci:test:*` 名称是显式测试工具，不由工作流调用；本地 fulltest／slowtest 仍须用户明确授权。现有上游显式目标 Bazel 工具和产物保留，不恢复 fork 专用 Bazel 图或引入统一框架。
- Windows/Linux 的 Bun 和 Rust Nextest 各池最多 28；Bun 分块、文件 worker 与文件内并发共用预算。fulltest 按实际静态检查、脚本和语言套件预留槽：Rust 静态检查、workspace 测试、Rust SDK 依次复用 Cargo 槽；全量 Python／Go 复用先释放的非 Cargo 槽。低内存仍受每 GiB 一个槽及低容量串行限制。
- `--full` 启动后的 Bun 池可接管静态检查、纯夹具、Python／Go 及最后一个 Cargo 阶段归还的槽；只转移不用的预算，不提高本轮总并发上限。
- 全量的 Rust workspace 在八槽以上且 Bun 仍有至少两槽时也至少使用两槽，避免一槽的 Nextest 成为串行长尾；Cargo 链全部完成后仍归还其槽。
- 默认和全量 fulltest 使用各自最近七天的计时报告，按稳定标签和精确 argv 匹配完成分块，优先运行实测慢分块。默认报告的 `suiteRevision` 必须匹配 [`BUN_FORK_SUITE_REVISION`](../scripts/test-reporting.ts#L9)。跨 Git 提交只复用实际耗时提示，不拆分旧分块、不缓存结果，不改变默认增量选测的 clean 基线资格。
- 默认 Bun 普通和启动敏感组尽早并行；全量模式两组共享槽并保留分组报告，启动敏感工作尽早运行但不永久占槽。Knowledge CLI 的额外场景槽随该分块结束释放。时钟、watchdog 和共享写入者等脚本先隔离，允许的纯夹具最多两个并行。真实 Chromium 的 Windows Bun 测试把 `USERPROFILE`、`APPDATA` 和 `LOCALAPPDATA` 一起重定向到临时 profile，仍逐场景使用独立浏览器数据目录。全部重负载结束后才运行独立 PTY smoke。
- singleton／全局状态桶每最多 10 个文件开独立进程，多文件按 `--parallel=1` 执行；fulltest 的单文件分块在各自命令进程直接执行，不再额外启动 Bun 文件 worker。UI 与 Windows runtime／native 分块隔离不变，调度排序不改变分片归属。
- 功能回归夹具显式启用被测能力：idle maintenance 用例自行开启 recap，仍保留 fork 的默认关闭及显式关闭覆盖；顾问配置验证布局、选择、鼠标操作与工具授权差异，不绑定中英文提示文案。
- Cursor TLS reset 子进程按退出码与结构化错误事件验证传输合同，stderr 保留为失败诊断，合法的运行时警告不当作协议错误。Rust CLI 选择夹具沿用既有用例／门禁时限，不另设提前终止子进程的 10 秒截止。
- 受限目录审批夹具从当前选项解析一次允许／拒绝，未知回答仍拒绝执行；不再返回过时的英文标签。SDK 恢复夹具先关闭原 journal 所有者再重开，以模拟进程退出，不能只 flush 后让两个存活 manager 同时占用日志。
- 注入 `createAgentSession` 的协作启动夹具须满足当前 SDK 返回类型；无原生工具上下文的 `--no-tools` 场景沿用既有显式报错的 `getToolContext`，不返回伪造上下文或放宽生产接口。
- 首事件禁用回归验证超过 idle 预算后仍可成功收到正文，不再断言整个进程没有其他定时器；透明预览回归验证实际终端单元的显式前景色和透明背景，兼容 256 色及真彩编码，不绑定翻译文本。命令报告以输入／补全完成后的实际呈现边界核对恢复、主屏无污染和历史无重复，不将输入阶段的重排归因于报告。
- Windows sed 文件截断夹具验证 Windows 流式读取与 Unix 打开时快照各自的既有合同，取消手工过滤；Python `export_html` 按 `Path` 比较跨平台结果，而非要求 Windows 路径呈现为 POSIX 字符串。
- 上游显式 TS 全量入口覆盖 `stats` 及 `metaharness`，后者包含包根目录下的 edit adapter 测试；这不意味着两者完整套件进入日常 fork 门禁。历史费用回填用例使用独立的分时／分日期价格夹具，不假定实时模型目录中某个型号必然在固定日期换价；仍断言费用、缓存节省及重启后的回填结果。
- 普通 TUI 的 OpenSpec 资源授权 E2E 先确认多行草稿及光标已进入真实输入框，再单独发送 Enter；每轮关联独立输入和完成标记后检查原生读取结果，不用旧回复或画面 idle 代替当前工具轮完成。
- 目录、缺失、同名文件、仅父目录四种分支分别验证六项核心发现；同名文件场景完整验证技能补全、逐项原生读取与授权期限，其余场景保留代表性真实允许／拒绝，不重复整个技能与目录状态的笛卡尔积。Windows 既有不适用场景不变。
- 递归 submodule 隔离用例中的独立只读 Git 查询并行执行；copy／rcopy 两条路径、父工作树不变、对象保留及分支合并断言与原 30 秒用例预算保持不变。
- 验证时按授权运行对应局部测试及门禁，并核对场景、隔离、超时和实际报告；入口存在不代表已通过。

定向验证、上游归因和门禁实测见[历史验证记录](verification-history.md)。不同版本、平台或受影响范围的报告不得互相替代。

### Provider 配置保存现状

当前 `ConfigFile`／`ModelsConfigFile` 只承担读取／迁移，没有主动 `models.yml` writer 或 provider 保存 API；Team 接口不提供 provider 配置。Agent 获授权新增 provider 时，不能把任意文本 `edit` 视为具有共享程序服务的锁、版本校验或事务保证。

### TUI 显示验证参考

使用**模拟模型 + tui-test**验证：

- 三种显示模式、插话不拆轮、聊天历史过滤及切换时布局稳定性。紧凑模式显示固定两行活动和最近工具的只读输出预览，不显示独立的模型处理忙碌提示。
- 紧凑模式显示本轮 `write`／`edit` 产生的实际文件净差异，不按调用次数保留工具卡片。`Ctrl+O` 优先展开净差异，`Esc` 收起；新一轮开始时清除，不写入聊天历史。
- Bash 的 30 秒边界、短命令成功与失败、等待输入、无输出、前台转后台，以及跨轮次后台任务。
- 日志刷新不新增模型请求或工具调用。

### 中文界面验证参考

- 本次不增加测试；复用既有自动化验证。验收须观察真实源码入口的中文界面及关键交互，并运行当前平台 `bun run fulltest`；不得把静态文案检查或局部渲染冒充真实入口验收，也不得因汉化改写业务断言或放宽门禁。尚未实际执行的验证保持未验证。
