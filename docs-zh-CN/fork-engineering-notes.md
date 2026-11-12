# Fork 工程现状线索

> AIReq 文档状态：最新需求见[AIReq 流程说明](spec-driven-orchestration.md)。本文件中的旧四阶段／八阶段设计、实现与验收记录仅对应当时版本；本次只更新文档，未改原型或代码，历史证据不证明新并行、规格交付、IR 验收及归档规则已实现。

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

## 使用与验证参考

以下材料仅供查找实现和验证入口，不构成需求基线，也不表示本次已运行或通过。

### 本地构建与 CNB 分发

- Windows 执行 `bun run local` 构建并直接替换 `%LOCALAPPDATA%\omp\omp.exe`，可用 `PI_INSTALL_DIR` 指定安装目录。不执行测试、native 加载探测或 exe 试运行，不杀已有进程；先将旧 exe 改名再换入新版，换入失败恢复旧文件，仍被旧进程占用的映像保留。
- Windows 执行 `bun run cnb`，默认发布到 `jchanghong/bin` 仓库已创建的 `omp` Release，无需交互输入；可用 `--repo` 和 `--tag` 显式覆盖目标。脚本先在 Windows 和 Ubuntu-24.04 WSL2 的 `/root/oh-my-pi` 工作区执行 `git pull --ff-only`，再并行构建、并行上传 `omp-windows-x64.exe` 和 `omp-linux-x64`，复用本机依赖及编译缓存。每次直接覆盖这两个同名附件，不再需要 `--overwrite`，不修改其他附件；不打包、上传或向 CNB 推送源码。WSL 源码及 `scripts/cnb-wsl.sh` 只能通过 Git 远端同步，不复制、移动或打补丁绕过脏工作区检查。
- 两个命令只负责构建交付，便于手动验证，不运行任何测试、冒烟、worker 探测、native 加载探测或构建产物试运行。CNB 不做全仓源码哈希扫描、重复 WSL 预检、Release 附件竞态检查及发布后重复查询；只保留干净工作区、Git 提交一致性、Bun 版本、构建输出及上传接口所必需的检查和确认。
- CNB CLI 需具备目标仓库 Release 读写权限；`CNB_TOKEN` 可提供令牌。WSL 需安装与 Windows 完全相同版本的 Bun，以及 Rust、Bazel 和项目构建依赖；Bun 版本不一致会在编译前拒绝。Bazel 构建使用已提交的 `MODULE.bazel.lock`，锁文件过期时运行 `bun run gen:bazel-lock` 并通过 Git 提交同步，不由发布构建改写。遗留的 `tool-views.generated.js` 作为生成产物忽略，不移动或删除用户文件。该分发不改变 `omp update` 或安装器的 GitHub 来源。
- 仓库根目录 `.cnb.yml` 提供单独的 `main`／`api_trigger` fastcheck 流水线，使用 64 核 amd64 节点，不发布产物；CNB `docker:cache` 分别缓存系统依赖、Bun／Rust 工具链和项目 Bun 依赖包，版本键包含对应 Dockerfile、工具链或依赖清单及锁文件。每轮仍执行 `bun install --frozen-lockfile` 及安装脚本，不缓存检查结果。手动触发需要 `repo-cnb-trigger:rw`；配置须提交到目标分支，或通过触发接口的 `config` 参数传入。

### Fork 门禁与 AIReq 消费者分片

- 三层门禁直接运行既有 Bun／Cargo 原语，记录 Git 版本和工作区状态，保留预算和失败汇总；不扫描全仓内容指纹，也不因运行期间源码或临时文件变化中止或自动重跑。fastcheck 不运行测试，保留原有工具和增量编译缓存。slowtest 运行本机 fulltest 及适用的 WSL fulltest，各端独立选测并保留固定提交同步；不缓存门禁或完整命令结果，也不引入自建结果缓存框架。
- `bun scripts/monitor-system.ts` 在 Windows 后台启动性能采集器，每 2 秒将 CPU、内存、各磁盘卷容量及各物理磁盘 I/O 繁忙度、读写速率和队列长度写入系统临时目录 `omp-test-monitor-*/samples.jsonl`，启动后立即返回。入口使用 TypeScript/Bun，常驻 PowerShell 进程读取 Windows 原生性能计数器，避免每轮创建进程。`--stop <监控目录>` 请求停止并保留数据；`--report <监控目录>` 显示 CPU/内存及各磁盘 I/O 均值、峰值和容量，可在采集中读取。数据包含时间戳和采集耗时，便于对齐测试阶段；容量使用率与 I/O 繁忙度分开记录。
- 日常 `bun run test`、`test:ts`、`test:rs`、fulltest 和 slowtest 测 fork 自有功能：AIReq/OpenSpec 与原生编排、Team/Goal、Knowledge 索引与 OpenWiki、company/Ascend/CodeAgent、offline/代理/统一数据根、共享 Skills、compact/中文 TUI、状态栏、审批/个人命令/默认值及分发消费者契约。真实 AIReq E2E、持久化和取消等业务边界保留；`/wt` 策略由消费者测试覆盖，不展开完整上游 task/worktree 与 pi-vcs。
- 通用 Browser/upload/relay/CMUX/Tern、shell/VCS/builtins、task/worktree、独立 RPC/ACP/SDK、全 provider 矩阵、基础 TUI 与旁支包完整回归，以及纯上游继承或仅 bugfix 专项不随日常门禁运行，即使规格记载亦然；上游测试文件及已有显式手动入口保留。仅本次允许在完整消费者契约不变的条件下合并 AIReq 重复正常进程场景，将纯输入字段／命令参数排列交由已有低层合同测试覆盖，不扩大后续自动删测权限；真实 PTY 保留不同错误、状态和焦点边界。冷启动、准备失败／EOF、冷恢复、owner／profile 隔离、权限、取消、Windows 句柄和公开打包资源等真实边界不删减；AIReq 四角色 × missing／malformed／unknown 材料失败矩阵和现有平台条件不变，每例 provider／fixture 保持隔离。独立 Python SDK、Robomp、legacy 通用 SDK 只保留手动入口。静态检查和编译范围不缩减，不新增 skip 或放宽时限。
- 默认 Bun 门禁只在 fork 白名单内以 `--changed` 按变更及依赖选测；缺少合格基线或工具不支持时回退完整白名单，不回退上游全量。`CI` 与本地 TS 的 `OMP_TEST_SHARD` 不改变本地范围；仓库脚本自测仅对应脚本或门禁模块本轮变化时选入，独立 `test:scripts` 入口保留。
- `bun run fulltest --full` 显式覆盖当前平台支持的完整 Bun、Rust workspace、Python 普通套件、Go/Rust SDK 与仓库脚本测试，不使用 fork 白名单、变更选测、testmon 或环境分片；默认范围不变。测试自身 skip、平台不支持、真实桌面输入与另需单独授权的集成仍受原边界约束。
- `bun run test:rs` 用 Cargo 包和 Nextest namespace 筛选 `pi-knowledge` 全包和 `pi-natives` 的 `knowledge::` 绑定测试，scope 为 `rust-fork-features`。独立 doctest 阶段运行 `cargo test -p pi-knowledge --doc --no-fail-fast`，报告真实命令、退出码及命令墙钟时间；Cargo doctest 无标准 JUnit 报告，记 `report=not-supported`。native `cdylib` 无 doctest，不生成虚构用例或 PASS，也不运行上游 tree-sitter-go 文档例子凑数。保留同平台配置和正常 Cargo 增量编译缓存。非 Rust 构建、配置、清单、锁文件、工具链、生成输入与跨语言依赖也可能影响 Rust。
- 默认 fulltest 使用同一真实 clean、完整成功的 fork 基线，以 cargo-delta 0.5.0 分析 Git 变更和 Cargo metadata 中的 crate 逆向依赖，再将受影响包与 fork 范围取交集，使用标准 Cargo 包选择执行 Nextest；空交集不启动 Cargo，`pi-knowledge` 被选才运行 doctest。tripwire 配置覆盖全局及无法安全归属的输入；缺基线、工具缺失或失败、输出无效以及无法确定边界时回退完整 fork 范围。使用前安装 `cargo install cargo-delta --version 0.5.0 --locked`，门禁不自动安装；标准分析缓存不是测试结果缓存。直接 `test:rs` 保持完整 fork 范围，`--full` 保持完整 workspace，不使用 delta。
- 独立 UI smoke 和仓库脚本仍按 Git 变更规划；CLI、native、Team、TUI 等实际依赖变化须运行 UI。缺基线或依赖未知时保守运行，静态检查及必要 native 准备始终全局执行。Git／cargo-delta 未选证据包含有效基线 revision、相对变更路径、零选择及原因，delta 另记录空包列表，不虚构 XML、用例或耗时。实际执行的受影响 Nextest 使用 `cargo-delta`／`affected` 并记录包和基线及真实 JUnit；全量回退仍使用 `cargo-nextest`／`full`。doctest 无 JUnit，按实际阶段结果报告，未选不冒充 PASS。混合报告保留实际用例和失败；affected、partial、失败报告不能作为完整基线，不提交报告 sidecar 或改写历史。
- Bun 与 cargo-delta 的依赖分析均有近似：动态依赖、环境或外部输入可能漏检，affected 不等于完整新回归，仍须适时运行完整回归。报告区分本轮实际执行、deselected、not-selected 与未运行；默认 fulltest scope 为 `fulltest: fork feature suites`，控制台范围为 `fork-features`，旧范围报告不能作为新范围基线。历史用例耗时不算本轮新执行，也不能称全仓全量通过。普通失败继续其他独立工作，保留首个实际失败退出码；取消、参数错误和原预算到限仍停止本次拥有的工作。
- CLI 子进程夹具在公共 harness 或独立启动器中静态导入真实使用的 Tools registry，补足 Bun 无法追踪的 spawn 路径字符串；不导入或执行 CLI 主入口，不仅为某两个实验源码添加特例依赖。双连接订阅的初始快照按各自游标对齐后再比较完整状态，不假定顺序订阅恰好处于同一版本。当前 AIReq 公开工作流消费者使用 `operationId`、`expectedRevision` 及精确对象／原生会话绑定，不套用旧阶段终端 `sendText` 去重合同。
- 并发门禁中的时序断言以实际完成边界为准：Superpowers 服务启动先等待完整换行终止的状态记录，再验证 HTTP 与进程退出；Settings 的“排队保存后发生外部编辑”场景须在同一 JS turn 完成外部写入，再 flush，不能让异步文件 I/O 与 100ms debounce 自由竞争后仍假定固定顺序。原退出、回收、外部值优先及内存状态断言保持。
- 原生 AIReq 的 public process 夹具继承门禁的 `BUN_RUNTIME_TRANSPILER_CACHE_PATH`，只共享 Bun 编译缓存；每例 HOME、TEMP、应用配置、凭据、会话、数据库及工作区仍独立，实际 CLI 和协议链路不替换为模拟调用。
- Knowledge CLI 的 23 个既有真实消费者场景使用各自的 provider、观测、配置、工作区、子进程和清理，最多两个场景并行，单槽预算仍串行。预备索引只保留不可变数据库／WAL 字节，每例复制后独立打开；不共享运行期数据库、CLI 或会话，不减少分页、控制字符、错误及真实至少 500ms 等待覆盖。
- 原生 AIReq 的版本与会话绑定消费者保留过期请求、错误对象及 session／round 拒绝断言；请求使用从真实工作流视图取得的 `expectedRevision`，不再描述旧 `guard.revision`／epoch／watermark 接口。不能把刷新视图变成放宽故意错误绑定的拒绝检查，也不能因响应未知而重复派发已经接受的原生输入。
- fastcheck、fulltest、slowtest 默认隐藏成功用例、成功分块及成功命令输出，仅显示失败用例和错误诊断；最外层最终状态、耗时、退出码和报告路径保留。`--debug` 不恢复成功用例刷屏。静默只影响呈现，本轮实际执行的用例写入 JUnit／计时结果，平台跳过明确报告，首错通知、失败继续、取消与预算不变。真实桌面输入仍需单独授权。
- 手动 CI 只执行构建、打包及其必要准备，不执行单元、集成、冒烟或安装测试，发布只依赖版本元数据、二进制和浏览器扩展构建成功。保留的 `ci:test:*` 名称是显式测试工具，不由工作流调用；本地 fulltest／slowtest 仍须用户明确授权。现有上游显式目标 Bazel 工具和产物保留，不恢复 fork 专用 Bazel 图或引入统一框架。
- 测试运行器按可用核心数、可运行任务数及显式预算限制并发，Windows/Linux 的 TS、启动敏感组和 Rust Nextest 均不超过 28。fulltest 为静态检查／子进程保留容量，按实际选中工作分配余量，而非永久各给 Bun／Rust 一半：28 核预算下，没有 Rust 工作时 Bun 可用 24 个 worker；两端都有工作时为 Bun 分配 20、Rust 分配 4。后置启动敏感组与 dev-TUI smoke 共享外层额度，28 核预算下分别分配 25／3；额度不超过 5 时串行。Bun 的 chunk 池与文件 worker 共用预算，显式配置仍可降低并发，测试覆盖、隔离、超时及计费不变。
- fulltest 可用最近同平台、架构、Bun 和套件版本且完整成功的计时报告，按精确 label／argv 匹配为原分块执行长任务优先排序；允许跨 Git 提交复用耗时提示，但不拆分旧分块、不缓存测试结果，也不改变受影响选测的 clean 基线资格。最新失败／未完成报告及不匹配、歧义分块不给提示，历史 PASS 和耗时不算本轮执行。本地高成本 integration／E2E chunk（包括 AIReq 原生 Git 发布 `test/aireq-workbench/git.test.ts` 与工作流领域 `test/aireq-workbench/workflow-domain.test.ts` 消费者）共享最多 4 个并发槽，达到子限制时仍继续调度其他可运行工作，不改变全局预算、超时或业务断言。原连续运行验收仍按实际证据判定，不以排序提示代替执行。
- fulltest 的普通 TS 套件与静态检查可同时启动，Rust 测试只等待 Rust 静态检查结束。时钟、watchdog、未知脚本和共享写入者的自测仍先隔离执行；明确允许的纯夹具脚本占用预留容量，最多两个并行并可与重负载阶段重叠。所有静态、普通、Rust、脚本及其余重负载工作结束后，隔离的 dev-TUI smoke 与 spec-driven TUI／RPC goal 启动敏感组在拆分的同一 CPU 额度内并行；文件内串行，各自保持独立 HOME、工作区、端口及清理，不放宽超时或删除断言。smoke 的启动、Team／取消两组遵守继承预算且最多两组并行，Team 与取消仍顺序执行并保留原等待断言。
- singleton／全局状态桶按最多 10 文件切成独立进程，每个进程仍以 `--parallel=1` 执行；UI 与 Windows runtime／native 的原有分块隔离不变。明确命名的 E2E／integration chunk 在分片选择后优先启动，减少长任务排队，不改变分片归属；本地入口不因继承 `CI` 而退回串行。
- 功能回归夹具显式启用被测能力：idle maintenance 用例自行开启 recap，仍保留 fork 的默认关闭及显式关闭覆盖；顾问配置验证布局、选择、鼠标操作与工具授权差异，不绑定中英文提示文案。
- Cursor TLS reset 子进程按退出码与结构化错误事件验证传输合同，stderr 保留为失败诊断，合法的运行时警告不当作协议错误。Rust CLI 选择夹具沿用既有用例／门禁时限，不另设提前终止子进程的 10 秒截止。
- 受限目录审批夹具从当前选项解析一次允许／拒绝，未知回答仍拒绝执行；不再返回过时的英文标签。SDK 恢复夹具先关闭原 journal 所有者再重开，以模拟进程退出，不能只 flush 后让两个存活 manager 同时占用日志。
- 注入 `createAgentSession` 的协作启动夹具须满足当前 SDK 返回类型；无原生工具上下文的 `--no-tools` 场景沿用既有显式报错的 `getToolContext`，不返回伪造上下文或放宽生产接口。
- 首事件禁用回归验证超过 idle 预算后仍可成功收到正文，不再断言整个进程没有其他定时器；透明预览回归验证实际终端单元的显式前景色和透明背景，兼容 256 色及真彩编码，不绑定翻译文本。命令报告以输入／补全完成后的实际呈现边界核对恢复、主屏无污染和历史无重复，不将输入阶段的重排归因于报告。
- Windows sed 文件截断夹具验证 Windows 流式读取与 Unix 打开时快照各自的既有合同，取消手工过滤；Python `export_html` 按 `Path` 比较跨平台结果，而非要求 Windows 路径呈现为 POSIX 字符串。
- 上游显式 TS 全量入口覆盖 `stats` 及 `metaharness`，后者包含包根目录下的 edit adapter 测试；这不意味着两者完整套件进入日常 fork 门禁。历史费用回填用例使用独立的分时／分日期价格夹具，不假定实时模型目录中某个型号必然在固定日期换价；仍断言费用、缓存节省及重启后的回填结果。
- 历史 `dev-TUI smoke`／`spec-driven TUI` 分组名和 `tui-` 文件前缀不等于仍测试旧 AIReq TUI。`tui.e2e.test.ts`、`tui-materials.e2e.test.ts`、`tui-materials-later-roles.e2e.test.ts`、`tui-interactions.e2e.test.ts`、`tui-business.e2e.test.ts`、`tui-lifecycle.e2e.test.ts`、`tui-closing.e2e.test.ts` 及 `tui-resource-lifecycle.e2e.test.ts` 使用 `test/aireq-workbench/workflow-fixture.ts` 等当前夹具，通过真实源码 CLI 的公开浏览器工作台 API 驱动 Release／IR／SR 及原生四阶段；这不是浏览器像素布局或旧 AIReq 三行状态区验证。普通 TUI 的资源读取和压缩显示仍分别由 `tui-resources.e2e.test.ts`、`tui-compact-mixed.e2e.test.ts` 及 `tui-harness.ts` 保留；`tui-capabilities.e2e.test.ts` 同时包含普通 TUI 和工作台原生阶段场景。当前行为见 [Release／IR／SR 浏览器研发协作指南及七项配套增量](lander-sailor-six-stage-agent-workflow.md#9-当前证据边界与依据)，不能沿用旧八阶段证据宣称新链路通过。
- 协同开发公开进程 E2E 按两个测试文件分片；共享进程与 provider fixture 保持每个场景的独立目录、会话和超时，重复正常场景可按上述消费者契约等价合并；材料失败矩阵的 provider／fixture 保持逐例隔离。
- 普通 TUI 的 OpenSpec 资源授权 E2E 先确认多行草稿及光标已进入真实输入框，再单独发送 Enter；每轮关联独立输入和完成标记后检查原生读取结果，不用旧回复或画面 idle 代替当前工具轮完成。工作台缺失完成报告的消费者场景检查公开 API 的材料诊断、原生阶段会话及批准不变，不再要求旧 AIReq 状态区或 `/session` 画面。
- 递归 submodule 隔离用例中的独立只读 Git 查询并行执行；copy／rcopy 两条路径、父工作树不变、对象保留及分支合并断言与原 30 秒用例预算保持不变。
- 验证时按授权运行对应局部测试及门禁，并核对场景、隔离、超时和实际报告；入口存在不代表已通过。

本次范围调整和编排精简未运行测试、构建或门禁；性能收益及用例是否通过均待实测，不能用旧范围报告代表本次结果。

### Provider 配置保存现状

当前 `ConfigFile`／`ModelsConfigFile` 只承担读取／迁移，没有主动 `models.yml` writer 或 provider 保存 API；Team 接口不提供 provider 配置。Agent 获授权新增 provider 时，不能把任意文本 `edit` 视为具有共享程序服务的锁、版本校验或事务保证。

### TUI 显示验证参考

使用**模拟模型 + tui-test**验证：

- 三种模式、插话不拆轮、历史隐藏、普通工具优先级与数量、长命令折叠、输入框上方固定单行思考及空闲留白、显隐时布局稳定性。
- 真实写入分类、最近 3 次 write/edit，以及最新展开、其余折叠。
- Bash 的 30 秒边界、短命令成功与失败、等待输入、无输出、前台转后台，以及跨轮次后台任务。
- 日志刷新不新增模型请求或工具调用。

### 中文界面验证参考

- 本次不增加测试；复用既有自动化验证。验收须观察真实源码入口的中文界面及关键交互，并运行当前平台 `bun run fulltest`；不得把静态文案检查或局部渲染冒充真实入口验收，也不得因汉化改写业务断言或放宽门禁。尚未实际执行的验证保持未验证。
