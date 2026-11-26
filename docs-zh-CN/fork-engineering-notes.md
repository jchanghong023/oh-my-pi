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

## 使用与验证参考

以下材料仅供查找实现和验证入口，不构成需求基线，也不表示本次已运行或通过。

### 本地构建与 CNB 分发

- Windows 执行 `bun run local` 构建并直接替换 `%LOCALAPPDATA%\omp\omp.exe`，可用 `PI_INSTALL_DIR` 指定安装目录。不执行测试、native 加载探测或 exe 试运行，不杀已有进程；先将旧 exe 改名再换入新版，换入失败恢复旧文件，仍被旧进程占用的映像保留。
- Windows 执行 `bun run cnb`，默认发布到 `jchanghong/bin` 仓库已创建的 `omp` Release，无需交互输入；可用 `--repo` 和 `--tag` 覆盖。脚本先在 Windows 和 Ubuntu-24.04 WSL2 的 `/root/oh-my-pi` 工作区执行 `git pull --ff-only`，再并行准备两端的 CLI 和 SDK ZIP。两端独立判断缓存，输入完全匹配且该端两个产物均完整才跳过构建；四个产物都就绪后并行覆盖 `omp-windows-x64.exe`、`omp-linux-x64`、`omp-sdk-win32-x64.zip` 和 `omp-sdk-linux-x64.zip`，不修改其他附件、不上传独立源码归档、不推送 Git。WSL 源码及 `scripts/cnb-wsl.sh` 只能通过 Git 远端同步，不复制、移动或打补丁绕过脏工作区检查。
- 两个命令只负责构建交付，便于手动验证，不运行任何测试、冒烟、worker 探测、native 加载探测或构建产物试运行。CNB 不做全仓源码哈希扫描、重复 WSL 预检、Release 附件竞态检查及发布后重复查询；只保留干净工作区、Git 提交一致性、Bun 版本、构建输出及上传接口所必需的检查和确认。
- CNB 上传在 Windows 端执行：需安装 Node.js 和官方 `@cnbcool/cnb-cli`（npm 全局安装），`node` 和 `cnb` 须在 `PATH` 上。CNB CLI 需具备目标仓库 Release 读写权限，可用 `CNB_TOKEN` 提供令牌。Windows 和 WSL 需使用相同 Bun 及 `rust-toolchain.toml` 固定的 Rust 工具链，并初始化两端的 `vendor/openwiki` 子模块；WSL 还需 `zip`。WSL 使用 `cargo-zigbuild` 和 Zig 构建 Linux glibc 2.17 x64 baseline，Windows 使用 Cargo 和 MSVC 构建 x64 modern，两端共用 `scripts/build-release-native.ts` 和 `scripts/ci-release-build-binaries.ts`，SDK ZIP 复用同端 addon，分发不依赖 Bazel。遗留的 `tool-views.generated.js` 作为生成产物忽略，不移动或删除用户文件。该分发不改变 `omp update` 或安装器的 GitHub 来源。

### 本地验证

- 从仓库根目录运行 `bun run check` 做静态检查；定向回归优先指定实际文件，例如 `bun test ./packages/coding-agent/test/eval/js-cancel-output.test.ts`。获授权扩大范围时，`bun run test:ts` 运行上游本地 TS 套件，`bun run test` 额外调用 Rust 任务。Rust 检查与测试可能按上游变更判定跳过；`bun run test:rs` 实际运行时执行 workspace Nextest 及 Cargo doctests。
- `bun scripts/monitor-system.ts` 在 Windows 后台启动性能采集器，每 2 秒将 CPU、内存、各磁盘卷容量及各物理磁盘 I/O 繁忙度、读写速率和队列长度写入系统临时目录 `omp-test-monitor-*/samples.jsonl`，启动后立即返回。入口使用 TypeScript/Bun，常驻 PowerShell 进程读取 Windows 原生性能计数器，避免每轮创建进程。`--stop <监控目录>` 请求停止并保留数据；`--report <监控目录>` 显示 CPU/内存及各磁盘 I/O 均值、峰值和容量，可在采集中读取。数据包含时间戳和采集耗时，便于对齐测试阶段；容量使用率与 I/O 繁忙度分开记录。
- 需要对应分组时显式运行 `bun run ci:test:ts:workspace`、`bun run ci:test:ts:native`、相应 `ci:test:coding-agent:*` 或 `bun run ci:test:smoke`。Python SDK 和 RoboOMP 普通测试用 `bun run test:py`，其集成冒烟单独授权；安装路由用例在支持 POSIX `sh` 的环境中显式运行 `bun test ./scripts/install-tests/fork-installer-routing.test.ts`。产物验收和 `bun run ci:test:install-methods` 不随普通套件自动运行。
- fork 业务回归纳入现有上游测试目录或原生套件。父仓静态检查与测试发现排除 `vendor/openwiki`，不排除宿主集成测试。验证 Windows Chromium 时须隔离 `USERPROFILE`、`APPDATA`、`LOCALAPPDATA` 和浏览器数据目录；Windows Rust 继续使用现有 MSVC 工具链发现。
- 手动 GitHub CI 只执行版本元数据、构建、打包及明确授权的发布，不调用 `ci:test:*`。本地验证不自动启动 WSL、同步或推送源码、触发 CI 或发布。真实桌面输入、模型、公司实机及其他独立验收各自授权。
- CLI 子进程夹具在公共 harness 或独立启动器中静态导入真实使用的 Tools registry，补足 Bun 无法追踪的 spawn 路径字符串；不导入或执行 CLI 主入口，不仅为某两个实验源码添加特例依赖。
- Settings 的“排队保存后发生外部编辑”场景在同一 JS turn 完成外部写入再 flush，不让异步文件 I/O 与 100ms debounce 自由竞争后仍假定固定顺序；保留外部值优先及内存状态断言。
- 记录实际命令、平台、退出状态及覆盖范围，区分执行、跳过及未验证。只有局部或分片结果时，不以历史记录补作当前全量结果。
- 功能回归夹具显式启用被测能力：idle maintenance 用例自行开启 recap，仍保留 fork 的默认关闭及显式关闭覆盖；顾问配置验证布局、选择、鼠标操作与工具授权差异，不绑定中英文提示文案。
- Cursor TLS reset 子进程按退出码与结构化错误事件验证传输合同，stderr 保留为失败诊断，合法的运行时警告不当作协议错误。Rust CLI 选择夹具沿用既有用例时限，不另设提前终止子进程的 10 秒截止。
- 受限目录审批夹具从当前选项解析一次允许／拒绝，未知回答仍拒绝执行；不再返回过时的英文标签。SDK 恢复夹具先关闭原 journal 所有者再重开，以模拟进程退出，不能只 flush 后让两个存活 manager 同时占用日志。
- 注入 `createAgentSession` 的协作启动夹具须满足当前 SDK 返回类型；无原生工具上下文的 `--no-tools` 场景沿用既有显式报错的 `getToolContext`，不返回伪造上下文或放宽生产接口。
- 首事件禁用回归验证超过 idle 预算后仍可成功收到正文，不再断言整个进程没有其他定时器；透明预览回归验证实际终端单元的显式前景色和透明背景，兼容 256 色及真彩编码，不绑定翻译文本。命令报告以输入／补全完成后的实际呈现边界核对恢复、主屏无污染和历史无重复，不将输入阶段的重排归因于报告。
- Windows sed 文件截断夹具验证 Windows 流式读取与 Unix 打开时快照各自的既有合同，取消手工过滤；Python `export_html` 按 `Path` 比较跨平台结果，而非要求 Windows 路径呈现为 POSIX 字符串。
- 上游 TS 入口覆盖的范围以实际运行器为准；`metaharness` 的包根目录 edit adapter 测试可显式运行。历史费用回填用例使用独立的分时／分日期价格夹具，不假定实时模型目录中某个型号必然在固定日期换价；仍断言费用、缓存节省及重启后的回填结果。
- 递归 submodule 隔离用例中的独立只读 Git 查询并行执行；copy／rcopy 两条路径、父工作树不变、对象保留及分支合并断言与原 30 秒用例预算保持不变。

定向验证和上游归因见[历史验证记录](verification-history.md)。不同版本、平台或受影响范围的报告不得互相替代。

### Provider 配置保存现状

当前 `ConfigFile`／`ModelsConfigFile` 只承担读取／迁移，没有主动 `models.yml` writer 或 provider 保存 API；Team 接口不提供 provider 配置。Agent 获授权新增 provider 时，不能把任意文本 `edit` 视为具有共享程序服务的锁、版本校验或事务保证。

### TUI 显示验证参考

使用**模拟模型 + tui-test**验证：

- 三种显示模式、插话不拆轮、聊天历史过滤及切换时布局稳定性。紧凑模式显示固定两行活动和最近工具的只读输出预览，不显示独立的模型处理忙碌提示。
- 紧凑模式直接显示本轮工具结果自带的 Diff，不从快照重算。`Ctrl+O` 按完成顺序展开原始 Diff，`Esc` 收起；新一轮开始时清除，不写入聊天历史。
- Bash 沿用上游的输出、计时和前后台反馈；验证短命令成功与失败、等待输入、前台转后台及跨轮次后台任务，不再验证专有的 30 秒日志触发。
- 日志刷新不新增模型请求或工具调用。

### TUI 文案验证参考

- 验收须观察真实源码入口的简体中文欢迎提示、英文操作界面及关键交互，不以静态文案检查或局部渲染代替。范围及授权以 [Fork 验证要求](../openspec/specs/fork-verification-gates/spec.md) 为准。
