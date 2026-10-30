# fork-verification-gates

## Purpose

规定 fastcheck、fulltest 和 slowtest 的范围、预算、源码快照、原生测试选择、失败汇总及证据合同。报告只对实际执行的源码、平台和范围有效。

## Requirements

### Requirement: 按风险选择验证和报告证据

验证 MUST 选择与行为和风险相称的最小充分集合，并准确区分实际执行、原生选测排除与未验证的范围。

#### Scenario: 选择与变更相称的验证

- **WHEN** 为变更选择验证
- **THEN** 局部逻辑用 UT，真实跨模块或公开入口验收用集成/E2E；测试对应相关规格的需求与验收场景，覆盖核心成功路径及关键失败路径，不仅验证没有崩溃；模拟、静态检查和编译不证明未运行的真实边界
- **AND** 纯文档变更只检查内容、差异和链接，不运行产品构建或测试；三层门禁的范围及运行授权遵循本规格的「Fork 验证体系」
- **AND** 保留有效构建缓存，不无理由 `cargo clean` 或删除 `target/`
- **AND** 已有公开入口从仓库根运行；`bun run robomp:test:integration` 需要 Python 依赖及 PATH 中的 `omp`，不因入口存在而扩大 fork 门禁范围。其他入口及其范围见本规格的「Fork 验证体系」

#### Scenario: 验证失败或证据不完整

- **WHEN** 验证失败、缺工具或部分工作未运行
- **THEN** 对比上游基线；上游原样代码失败默认只报告，除非用户明确要求修复或已有真实入口证据确认核心业务缺陷
- **AND** 区分已实现、验证通过、失败及未验证；缺工具不自动安装，不将跳过、缓存命中或未运行写成新执行通过

### Requirement: 临时 TUI 交互验证

临时 TUI 交互验证 MUST 使用源码入口及隔离环境，不以模拟或其他产物冒充真实边界。

#### Scenario: 验证 TUI 交互

- **WHEN** 临时验证 TUI 交互
- **THEN** 使用源码入口 `bun run dev`（`packages/coding-agent/src/cli.ts` → `main.ts` → `sdk.ts`）和 `tui-test`，首次使用先通过 Bash 执行 CLI 子命令 `tui-test skill` 并阅读完整指南；以唯一 session 显式指定 cwd、cols、rows，通过业务断言确认结果，`wait idle` 不能代替业务完成断言，核对各命令失败及进程退出状态，最后仅关闭自有 session；不另写 PTY/ANSI 驱动脚本，工具缺失时如实报告、不自动安装或绕过
- **AND** 仅在明确要求验证 exe 或打包产物时使用确认过的当前构建产物绝对路径，不能以源码运行结果代替产物验证；已有 fulltest PTY 冒烟不迁移、不重复实现

#### Scenario: TUI 验证需要模型响应

- **WHEN** TUI 交互验证需要模型响应
- **THEN** 使用隔离配置及本地模拟模型，发消息前确认实际模型与请求目标；失败时报告阻塞，不回退真实模型。真实模型/提供者认证及共享桌面输入需各自明确授权，模拟响应不能作为真实模型能力或提供者认证的验收证据

### Requirement: Fork 验证体系

OMP MUST 按各入口规定范围、预算、源码快照与失败汇总执行，并只报告实际完成的证据。

#### Scenario: Fork 验证体系的详细边界

- **WHEN** 本节所述功能在适用条件下运行
- **THEN** 以下具体约束适用：

| 入口 | 当前有效范围 | 非编译硬上限 | 总墙钟硬上限 |
| --- | --- | --- | --- |
| `bun run fastcheck` | 静态分析、类型/格式检查和编译；无任何测试，包括冒烟、自测 | 360 秒 | 沿用非编译预算 |
| `bun run fulltest` | 全部 fastcheck 检查 + 本机 fork 功能的 Bun、Cargo/Nextest 和适用 doctest、变更对应的仓库脚本自测、native 构建及隔离 dev-TUI 公开入口 E2E；测试选择见下文，无跨 WSL | 1800 秒 | 1800 秒 |
| `bun run slowtest` | 本机 fulltest 一次 + 项目所需且现有兼容 WSL 可用时的 Linux fulltest；无适用 WSL 时保留本机 fulltest | 3000 秒 | 3000 秒 |

表中列出必需的独立工作与适用套件；原生增量选测只说明本轮实际覆盖，不能声称整套测试均新执行。

- 三层门禁及根脚本直接调用既有 Bun／Cargo 检查、构建与测试原语，保持平台限制和报告语义；fastcheck 不运行测试，保留既有工具及增量编译缓存，但不缓存门禁或完整命令结果以免执行。不建立 fork 专用 Bazel 验证图或自建结果缓存框架。上游原有显式目标 Bazel 工具及其 CI 原生产物不属于此门禁改动。
- 日常 `bun run test`、`test:ts`、`test:rs`、fulltest 和 slowtest 测试 fork 自有功能，静态检查与编译范围不缩减。保留 Dev/OpenSpec 资源与原生编排、Team/Goal（包括取消与持久化）、ZCode app-server 权限及模型配置、Wiki/Repo 索引与 Python symbols、company/Ascend/CodeAgent、offline/代理/统一数据根、共享 Skills、compact/中文 TUI 与状态栏、审批模式/个人命令/默认值及 fork 分发消费者边界；Dev 真实 E2E 不得省略。`/wt` 新策略由消费者测试覆盖，不因此运行全部 task/worktree 或 pi-vcs。
- 通用 Browser/upload/relay/CMUX/Tern、shell/VCS/builtins、通用 task/worktree、独立 RPC/ACP/SDK、全 provider 矩阵、基础 TUI 库与旁支包的完整回归不纳入日常范围；纯上游继承或仅 bugfix 专项即使记载于规格也不因此纳入。上游测试文件与已有显式手动入口保留；仅本次允许在完整消费者契约不变的条件下合并 Dev／ZCode 重复的正常进程场景，并由已有低层合同测试覆盖纯输入字段／命令参数排列，不赋予后续自动删测权限。真实 PTY 保留不同错误、状态和焦点边界；冷启动、准备失败／EOF、冷恢复、owner／profile 隔离、权限、取消、Windows 句柄和公开打包资源等真实边界不得删减。Dev 四角色 × missing／malformed／unknown 材料失败矩阵及其现有平台条件保持，每例 provider／fixture 隔离不得共享。不得新增 skip、放宽时限或删减产品需求。
- 默认 fulltest 的 Bun 仅在 fork 白名单内以原生 `--changed` 根据变更及依赖选测；缺少合格基线或工具不支持时回退完整白名单，不能回退整个上游测试集。显式选测及 `local`／`local-ts` 须如实报告范围，宿主 `CI` 或 `OMP_TEST_SHARD` 不改变本地范围；保留文件隔离、TSX 和共享并发预算。仓库脚本自测只在对应脚本或门禁模块本轮变化时选入，独立 `test:scripts` 保留。
- 根目录 `docs/`、`docs-zh-CN/` 和 `AGENTS.md` 不作为 Git 测试选择输入，不触发 Bun 全量回退或独立 UI smoke；混合变更仍按其余运行输入判断。排除不扩大到包内 Markdown/prompt 等运行资源，也不移除这些文档的源码快照完整性核验；缺少合格基线和显式 `--full` 的行为不变。
- `bun run fulltest --full` 显式运行当前平台支持的完整 Bun、Rust workspace、Python 普通套件、Go/Rust SDK 和仓库脚本测试，不使用 fork 白名单、变更选测、pytest-testmon 或环境分片；默认 fulltest 及 slowtest 不变。保留测试自身的 skip、平台不支持、真实桌面输入及另需单独授权的集成边界；不因全量模式放宽门禁时限。
- 独立 Python SDK、Robomp 和 legacy 通用 SDK 不纳入默认 fork 门禁，手动入口保留；Robomp integration 仍须单独显式启用，Windows 原生调用报告不支持并非零退出。
- `bun run test:rs` 用 Cargo 包及 Nextest namespace 标准筛选 `pi-wiki` 全包、`pi-natives` 的 `wiki::` 绑定测试和 `python_symbols::`；scope 为 `rust-fork-features`。独立 doctest 阶段实际运行 `cargo test -p pi-wiki --doc --no-fail-fast`，报告真实命令、退出码和命令墙钟时间；Cargo doctest 无标准 JUnit 报告，记 `report=not-supported`。`pi-natives` 是 `cdylib`，无 doctest，不生成虚构用例或 PASS，不运行上游 tree-sitter-go 文档例子凑数。保留同平台构建配置及正常 Cargo 增量编译缓存。
- 非 Rust 变更不能一律视为与 Rust 无关：构建脚本、配置、清单、锁文件、工具链、生成输入及跨语言依赖等可能影响 Rust。Bun 文件依赖是近似，动态依赖、环境和外部输入可能漏检；受影响选测不是全新完整回归的证明。
- 通过子进程启动 CLI 的测试须在公共 harness 或独立启动器中静态声明真实运行依赖，让 Bun `--changed` 能识别间接消费者；Tools registry 可作为输入，不能导入并执行 CLI 主入口来构造依赖图。
- 默认 fulltest 使用同一个真实 clean、完整成功的 fork 基线；Rust 用 cargo-delta 0.5.0 对 Git 变更和 Cargo metadata 分析受影响 crate 及逆向依赖，与 fork 包范围取交集后以标准 Cargo 包选择执行 Nextest。配置 tripwire 覆盖全局或无法安全归属的输入；动态依赖、构建脚本、环境及外部输入仍可能超出分析，无法确定时回退完整 fork 范围，仍须适时完整回归。工具缺失、失败或输出无效亦回退完整 fork 范围；无合格基线同样回退。空交集不启动 Cargo，`pi-wiki` 被选时才独立运行 doctest；`pi-natives` 无 doctest。独立 UI smoke 和仓库脚本仍按 Git 变更规划，缺基线或依赖未知时保守执行；静态检查、必要 native 准备及源码快照核验始终全局执行。affected、partial 或失败报告不能作为完整基线，不以提交 sidecar 或改写历史建立基线。
- cargo-delta 须预先安装 `cargo install cargo-delta --version 0.5.0 --locked`，门禁不自动安装；其标准分析缓存不是测试结果缓存。直接 `test:rs` 始终运行完整 fork 范围，`--full` 始终运行完整 workspace，不使用 delta。Git／cargo-delta 未选阶段记录有效基线 revision、相对变更路径、原因和零选择，cargo-delta 另记录空包列表；不虚构 XML、用例或耗时。实际受影响包的 Nextest 保留真实 JUnit、包列表和基线，doctest 按实际阶段状态报告；全未选可报告真实零执行，混合报告保留实际 XML 与失败，均不得当作完整新执行或完整基线。
- 单个用例、文件或语言套件失败后继续执行独立的其余必需测试，Nextest 与 rustdoc 使用 `--no-fail-fast`，Bun 不添加 `--bail`，pytest 不添加 `-x`；只有总预算、取消或完整性阻断可终止剩余工作。
- 默认 fulltest 不自动纳入独立 Go/Rust SDK；安装测试和另需授权的集成入口也不自动纳入 `--full`。手动构建发布 CI 不运行任何测试，也不以测试作业为发布依赖；保留的 `ci:test:*` 脚本只是显式测试工具，不由 CI 工作流调用。发布仍依赖版本元数据、二进制与浏览器扩展构建成功，不增加自动触发。
- native 安装从真实构建产物执行版本戳及宿主加载核验；最终版本戳后的 addon 字节与 bindings 内容均未变化、且已有文件可写时，保留安装文件及其修改时间。版本或内容变化时 MUST 按下文「原生安装替换与回滚」执行替换。

- 三层均在一个单调累计时钟下计费，排除实际观测到的**纯编译区间之并集**；编译和非编译并行时重叠仍计费一次。发现、准备、原生选测、下载、同步、非编译等待、汇总和清理计费；不能把混合检查/测试命令整段排除，也不能将历史耗时计入本轮编译排除。fulltest/slowtest 另有包含编译及全部收尾的总墙钟硬上限，不因纯编译排除而延长；嵌套阶段共享外层剩余额度，并保持更严格的内层上限。`--limit-seconds` 同时下调本入口的非编译与总墙钟上限。
- 到限主动终止本次拥有的进程树，非零退出并报告 `TIMEOUT`，不在阶段间重置时钟、不放宽上限。所有退出路径（成功、失败、缺工具、超时、中断、参数错误）都输出 status、total、compile_excluded、budgeted、limit 与退出码，秒至少一位小数。fastcheck 按 budgeted 判断到限；fulltest/slowtest 在 budgeted 或 total 任一到限时退出，独立线程须能在主线程同步阻塞时执行总墙钟强退。
- 三级门禁默认只向控制台显示失败用例及错误诊断；成功用例、成功分块、成功命令及其 stdout/stderr MUST 隐藏，不生成逐条成功用例的普通过程日志。保留最外层入口最终状态、耗时、退出码及报告位置。失败名称、错误／堆栈、相关命令上下文和取消／超时诊断 MUST 保留，首错通知不得等待输出缓冲收尾。此规则仅改变呈现，不改变执行范围、失败继续、并发、预算或原退出码；成功与失败用例的完整 JUnit、计时及结构化结果仍须记录。
- fastcheck／fulltest／slowtest 的验证失败不终止整轮：记录实际用例、检查、编译、执行、准备或核验失败及原退出码，继续执行不依赖它的剩余必需工作；同一 producer 内完整执行其余用例（如 nextest 使用 `--no-fail-fast`）。工具或环境缺失仅使依赖它的工作失败或阻塞，被阻塞的依赖项标记未运行且不计通过。只有到限、中断、参数错误、源码或工作区完整性破坏等阻断才立即终止本次拥有的任务与进程树。嵌套运行器及时通知外层并保留原退出码；汇总全部失败，最终退出码取首个实际失败的原退出码（失败状态附带 0 时归为 1），未启动、取消或阻塞不算通过。
- Windows 截止监督及失败通知不得被同步阻塞或管道背压延迟；初始化收到首错／中断时锁定原始退出码并禁止工作。缺失工具与缺失证据／产物分别报告，不能把所有 `ENOENT` 归为缺工具。
- 构建脚本能力探针的预期非零编译退出作为探针答案原样返回，不单独触发门禁失败；Cargo 正式编译单元及 Go 工具的失败仍须即时上报并保留原退出码，不能依赖外层进程转发失败；外层收到后继续其余独立工作。
- 门禁的进程监督须在命令仍运行时回收已退出的孤儿后代，不得截获由运行器持有的主命令退出码；宿主直接退出或 IPC 断开时，监督进程仍须停止并回收普通自有后代，含逃逸的独立 session。跨 Windows/WSL 的取消命令须在强退前独立发起，不等待其收尾。Windows 隔离临时目录的正常清理须能解除带拒绝读取 ACL 的目录 junction，且不得遍历或删除其目标；清理失败不得降级成通过。
- 独立且安全的检查/测试/Windows与WSL两端必须并行；改写共享生成文件的构建、打包或代码生成须先于其静态/测试读取者，避免共享文件竞争。编译项目必须保留正常增量缓存、固定同平台配置与路径；NEVER 在连续 fastcheck 之间清缓存、切换 target/profile/flags 或制造冷样本。Windows 与 WSL 使用各自稳定的原生缓存。
- native 生成后静态检查与普通测试按依赖安全调度：Rust 测试等待 Rust 静态检查完成，TS 静态检查和普通测试可并行；spec-driven TUI 及 RPC goal 启动敏感测试须在这些工作全部结束后运行，其独立测试文件进程并发受下述 28、可用核心数及任务数量限制，文件内串行，并保持各自独立的 HOME、工作区、端口及清理，不扩大用例时限或弱化业务断言。fastcheck 保留独立的 360 秒非编译预算；保留既有 target、profile、features 与 flags，不杀其他 Agent 的 Cargo 进程或放宽时限。
- 测试运行器按当前可用核心数动态限制并发，任务不足时进一步缩小。Windows 本机 TS（包括初始完整轮、无合格计时提示及 fulltest 短任务池）、启动敏感测试和 Rust Nextest 均最多 `min(28, 当前可用核心数, 可运行任务数)`；Linux 等其他平台维持最多 `min(28, 当前可用核心数, 可运行任务数)`。Bun 的 chunk 池与每个 chunk 的文件 worker 共同分配预算，不能相乘后越过上限；显式配置仍可降低并发。TS 与 Rust 并行时各自并发可能叠加、导致本机资源争用；是否提速和稳定须由后续完整门禁实测，不得预称通过。不固定启动上限数量的 worker，不改变静态检查并发、测试覆盖、隔离、超时、时间预算或计费。
- fulltest MAY 使用合格的既有完整计时报告作为测试调度的排序和资源容量提示；报告 scope 须为 `fulltest: fork feature suites`，旧范围报告不能作为新范围基线。报告缺失、不完整或无对应耗时不得阻止必需工作。历史耗时不得写成本轮新执行，亦不得改变分片、超时及结果合同。
- 本地高成本 integration／E2E chunk（包括按路径归入的 ZCode 真实 process 测试）同时运行不得超过 4 个，且仍受上述 Bun 测试并发上限约束；达到此子限制时，空余并发 MUST 继续调度其他可运行工作，不得因等待高成本 chunk 而闲置，不因此增加普通全局并发。此子限制不改变超时、断言、覆盖及结果合同。
- fulltest 的全部脚本／静态／测试读取者必须绑定同一 post-native 源码快照；准备阶段及后续执行期间的源码或 HEAD 变化立即拒绝，原生选测不能绕过完整性核验。native 生成阶段仅允许两个已跟踪普通文件 `packages/natives/native/index.js`、`index.d.ts` 的内容更新，不能借此接受其他文件、类型、模式或 HEAD 变化；构建完成后重取快照，并在全部必需工作结束时再次核对。
- Windows 测试子进程的 PATH 排除 WindowsApps 执行占位程序，复用已安装的真实 Python；Python 夹具的 UTF-8 标准流协议不依赖宿主 ANSI 代码页。环境覆盖遵循 Windows 变量名大小写不敏感语义，不修改系统 PATH 或宿主配置。测试使用隔离应用配置、HOME 和凭据，不读取用户真实配置。
- Dev TUI E2E 保持现有场景、隔离、超时及断言；启动、Team／取消、Repo 三组独立 PTY 进程可在可用核心数约束下最多三组并行，Team 报告与取消保持组内依赖顺序，全部进程须完成并回收；缺失 `tui-test` 按缺工具失败。
- fastcheck 仅在具体需要且相关修改批次完成后由 Agent 选择，不能逐文件保存即运行。fulltest/slowtest 需要本次用户明确运行授权，授权不跨任务延续；不能通过直接执行内部阶段绕过权限。新/改门禁入口脚本可直接执行显式限定到该文件的非测试静态检查，不得扩大到目录/仓库或执行测试、打包、跨 WSL。
- 三层 NEVER 调用或触发 CI/远端发布流水线、push、发布、部署、Computer Use、共享鼠标或抢前台焦点。独立 CI 仅手动触发，发布不属于门禁。真实桌面输入测试保留并另行明确授权，记 `NOT_RUN_SEPARATE_USER_INSTRUCTION_REQUIRED`，不计为已通过；隔离的浏览器 DOM/协议、虚拟终端和 PTY 自动化可纳入本地测试。
- 本项目支持 Windows/Linux x64，Windows→WSL 验证显式选定 **Ubuntu-24.04 WSL2**，不能替换目标；未指定目标的一般项目才优先合适的已安装 CentOS。无 WSL/无兼容发行版记 `SKIPPED_WSL_UNAVAILABLE`，项目不需要则 `SKIPPED_NOT_APPLICABLE`，此时 slowtest 仍覆盖本机 fulltest。其余发现、同步、脏源码、缺工具、执行或证据核验失败须使该端记为失败并使整轮最终非零退出，不得降级成跳过；本机与 WSL 并行阶段按失败汇总继续各自其余独立工作，不因单端失败提前终止另一端，也不得把单端结果表述为两端完成。不自动安装 WSL、发行版或缺失测试工具。
- WSL 通过 `scripts/slowtest-wsl-stage.ts` 在 slowtest 内执行，源码只能经 **Windows → Git 网络远端 → root 身份的原生 `/root` 工作区** 同步并测试完整固定 SHA。禁止本地快照、bundle、复制、rsync、patch、stdin 传源码、本地 remote 及 `/mnt/*` 工作区；stdin/stdout 仅承载调度计划/参数与日志。门禁没有 commit/push/stash 授权：源码未提交或未推送须立即报告为该端失败，不能测试旧提交代表当前改动。既有固定提交同步 helper 的 plan 保留远端身份、fetch/固定 SHA 可达性、快进、工作区与子模块保护、未跟踪残留隔离和测试后状态检查；流式执行计划并观测嵌套 fulltest 的纯编译事件，无法可靠计时则 UNVERIFIED，不能整段豁免混合命令。helper 的 7200 秒墙钟防挂另行报告，不得放宽外层 3000 秒总墙钟上限。记录两端 HEAD、本机源码指纹、工作树、Linux 工具路径与版本；不同提交不得合并 PASS。取消只处理本次拥有的资源，不关闭发行版、不删除用户改动、残留证据或有效编译缓存。
- WSL 验证使用已就绪的本机依赖，不自动执行 `bun install` 或安装缺失工具；依赖不足按原始准备／执行失败报告，不降级为不可用跳过，也不运行旧源码冒充当前固定提交。
- WSL 原生仓库发现受 slowtest 同一累计非编译与总墙钟额度约束，不另设 25/30 秒的提前截止；宿主与 Linux 的有限防挂不能延长外层时限。完整发现须保留嵌套工作区与多匹配拒绝语义，不通过缩小遍历范围规避超时。
- 本地门禁报告本平台适用工作和实际测试选择范围，不能把 affected 范围写成完整新执行，不能称全仓全量通过。保留现有 TS/Rust 静态检查、native 构建及 dev-TUI 集成边界；独立 SDK、安装发布、真实桌面和实际模型集成仍按各自授权执行。不得将平台跳过或独立授权范围表述为通过。
- 公开测试入口写入被 Git 忽略的 `runs/test-timing/<run-id>/`：本轮执行的 Bun、nextest 与可提供结构化结果的 rustdoc 各自输出独立 JUnit XML，CLI/PTY 场景按实际命令或场景计时；`run.json` 保存源码与环境、实际范围、原始退出码、每个 producer 的命令、报告路径及完成状态。默认 fulltest scope 为 `fulltest: fork feature suites`、控制台范围为 `fork-features`；`--full` 分别为 `fulltest: all test suites` 和 `all-tests`。原生选择元数据记录工具、`full`／`affected` 模式及可用的选中／排除数量、原因、基线和报告路径；区分实际执行、deselected、not-selected 与未运行，历史 testcase 和耗时不是本轮新执行。独立运行与重试不得覆盖前次报告；报告缺失、被取消、提前退出或仅有阶段耗时须标为部分覆盖，不能把阶段时间冒充单测时间。正常执行完所选用例但含失败的报告标为失败；JUnit 用例时间之和不是并行挂钟时间。
- 正常报告收尾由门禁生命周期跟踪，计入同一预算与总墙钟时限；验证失败须在预算内完成全量失败汇总报告后退出，发生超时、中断或阻断时立即退出优先于报告补写，不能为生成完整 `run.json` 延迟结束。强退可能留下缺失、未完成或临时报告；报告须结合门禁最终输出及进程退出码判读，非零退出时任何暂存的 complete/0 元数据均不代表通过。
- `slowtest` 的 Linux JUnit/XML 与元数据留在 WSL 原生仓库，宿主运行的 `run.json` 标注未汇总范围并保持部分报告状态；即使门禁在两端通过，也不能把宿主 XML 当成两端完整测试报告。WSL 不可用时以门禁原有跳过状态为准。
- 环境/工具缺失、平台不适用和检查失败须分别说明，不把缺失或跳过当通过。失败须先区分业务缺陷与测试适配，平台 fixture 应验证实际平台合同，不用手工白名单绕过失败；未运行的实际模型质量、公司内网、独立发布和桌面输入不属于本地 PASS 的证明。
- 门禁机制自测在临时目录中用短任务覆盖原生选择与报告、失败继续与全量汇总、首个失败码、缺工具、超时/中断、首错通知、挂起 afterAll/报告收尾、同步阻塞、含编译的总墙钟与更严格嵌套时限、强退后的进程树回收、编译排除与重叠计费、累计与下调预算、并行、工具缓存保留、包含关系、适用 WSL 和禁止外部操作；自测不是 fastcheck 的阶段，也不能代替真实三层入口执行的证据。

#### Scenario: Fork 验证体系的可观察行为

- **WHEN** 执行 fastcheck、fulltest 或 slowtest
- **THEN** 按各入口规定范围、预算、源码快照、原生选测与失败汇总执行，并区分本轮实际执行、排除和未运行的范围

#### Scenario: 三级门禁只显示失败用例

- **WHEN** fastcheck、fulltest 或 slowtest 中的命令、测试文件或用例成功
- **THEN** 控制台不显示其成功名称、成功分块进度或普通过程输出，本轮执行的结构化计时仍保留
- **WHEN** 出现用例失败、命令错误、缺工具、取消或超时
- **THEN** 显示对应失败和必要诊断，继续独立必需工作，并按原有规则给出最外层最终状态、耗时及退出码

### Requirement: 原生测试选择

fulltest 和 slowtest MUST 使用 Bun 原生选测能力和 cargo-delta 受影响 crate 分析；不将门禁或整个测试命令作为可跳过的缓存目标；fastcheck 保留原有编译和工具缓存且不运行测试。

#### Scenario: 受影响测试与回退

- **WHEN** 运行本机或适用 WSL 的 fulltest
- **THEN** Bun 在 fork 白名单内依据合格基线使用 `--changed`；不可建立有效选择时回退完整白名单。Rust 基于 cargo-delta 受影响 crate 与 fork 范围的交集执行 Nextest，空交集记为未选；选中 `pi-wiki` 才运行其 Cargo doctest，native `cdylib` 无 doctest。缺基线、工具缺失或失败、输出无效及无法确定边界时回退完整 fork 范围
- **AND** 选择结果区分执行、排除和未选中，报告 full 或 affected；历史执行与平台跳过不算本轮通过，选择近似不证明完整新回归
- **AND** 失败、取消或未完成的上次执行不得仅因已有历史数据而被排除；运行器须实际重跑并保留真实失败退出码

#### Scenario: Bun 白名单内受影响测试

- **WHEN** Bun 已有有效测试依赖基线，只有业务源码文件 A 变化，其他输入及环境保持有效
- **THEN** 按原生测试文件依赖图在白名单内选择直接或间接依赖 A 的测试；新增或失效用例仍须实际执行，无法确定边界时回退完整白名单并报告原因
- **AND** 验收使用真实独立 A／B 源码及对应测试：先建立有效基线，再仅修改 A，观察 A 的依赖测试实际执行且独立 B 测试未执行；不能以修改测试文件、整命令缓存命中或零用例未执行代替依赖选择证明

#### Scenario: Rust 修改 A 选择受影响 crate

- **WHEN** Rust 源码 A 变化且存在合格基线，cargo-delta 能确定受影响包
- **THEN** 以 Cargo metadata 逆向依赖与 Git 变更分析选出受影响 crate，在 fork 范围内只对交集执行 Nextest；`pi-wiki` 被选才执行其 doctest。空交集不启动 Cargo，保留正常增量编译缓存；动态或未知输入不能被假定为已完整追踪，仍须适时完整回归

#### Scenario: 连续运行验收

- **WHEN** 在同一最终源码上连续执行两轮 fastcheck 和 fulltest
- **THEN** 两轮均须通过，第二轮的 fastcheck 与 fulltest 各自实际墙钟耗时 MUST 小于 100 秒；只有实际运行证据才能证明此验收，不得放宽原有预算或省略独立工作

### Requirement: 门禁入口的参数解析

OMP MUST 只接受声明过的命令行参数，非法输入以用法提示和退出码 2 结束。

#### Scenario: 门禁入口的参数解析的详细边界

- **WHEN** 本节所述功能在适用条件下运行
- **THEN** 以下具体约束适用：

- `fastcheck`、`fulltest` 与 `slowtest` 均 MUST 接受 `--limit-seconds=<秒>`，取值 MUST 为有限正数且不超过该入口自己的硬上限（360／1800／3000 秒）；`fulltest` 与 `slowtest` 另 MUST 接受 `--debug`。重复的 `--limit-seconds` 只认第一次出现，第二个即视为非法。
- `fulltest` 开启 `--debug` 时 MUST 把该标志透传给隔离 UI 冒烟入口以产生诊断信息；控制台仍只在失败时显示相关诊断，不恢复成功用例输出。
- 未声明参数、重复限制参数或超界数值 MUST 输出该入口的用法行并以退出码 2 结束，MUST NOT 静默忽略或退化为默认值。
- `--debug` MUST 只影响诊断输出，MUST NOT 改变检查范围、预算或成功判据。

#### Scenario: 门禁入口的参数解析的可观察行为

- **WHEN** 以 `--debug`（fulltest／slowtest）、合法或非法的 `--limit-seconds` 值，或未声明参数执行各门禁入口
- **THEN** 合法参数正常启动（fulltest 把 `--debug` 传给 UI 冒烟），非法参数打印用法并以退出码 2 结束

### Requirement: Windows 测试临时目录的选择

OMP MUST 在存在其他可写驱动器的 Windows 主机上把测试临时目录移出系统盘。

#### Scenario: Windows 测试临时目录的选择的详细边界

- **WHEN** 本节所述功能在适用条件下运行
- **THEN** 以下具体约束适用：

- 仅 Windows 生效：当前 `TEMP`（缺省时 `TMP`）已位于非系统盘时 MUST 原样返回、不做改动。
- 存在非系统盘时 MUST 逐盘尝试创建 `<驱动器>:\\omp-test-tmp` 并做实际写入探针（建临时目录再删除）；创建或写入失败 MUST 跳过该盘。
- 多个可用盘 MUST 按剩余空间择优；空间不可知时 MUST 保留探测顺序中的第一个可用盘。
- 选定后 MUST 同时返回 `TMP` 与 `TEMP` 指向该目录；没有任何可用盘时 MUST 返回空，由调用方保留系统默认值。
- 非 Windows 平台 MUST NOT 返回任何覆盖，MUST NOT 修改宿主环境或系统 PATH。

#### Scenario: Windows 测试临时目录的选择的可观察行为

- **WHEN** Windows 主机有可写的第二块盘且 `TEMP` 仍在系统盘
- **THEN** 测试进程的 `TMP`／`TEMP` 指向 `<盘>:\\omp-test-tmp`；`TEMP` 已在他盘或不存在其他盘时保持默认

### Requirement: 原生安装替换与回滚

OMP MUST 在不中断已加载映像的前提下替换 native 产物，失败时保留可恢复文件并报错。

#### Scenario: 原生安装替换与回滚的详细边界

- **WHEN** 本节所述功能在适用条件下运行
- **THEN** 以下具体约束适用：

- 替换前 MUST 把新产物写入同目录的唯一临时文件；能直接原子重命名覆盖目标时 MUST 直接重命名。
- 目标映像已被加载而无法覆盖时 MUST 先把现有文件改名让位为 `<目标>.old.<PID>`（继续运行的进程保留旧映像），再安装新文件；仅在改名让位不可用时才允许先删除目标再换入。
- 换入新文件失败且已发生改名让位时 MUST 回滚：把让位文件改回原目标。回滚失败时 MUST 报错并保留让位文件与新产物两个恢复文件的路径，MUST NOT 静默删除其中任何一个。
- 换入成功后 MUST 删除让位文件；删除失败 MUST NOT 使安装失败。
- POSIX 上安装文件与 bindings MUST 为 0644：替换前把产物写入同目录临时文件后即设置该 mode，MUST NOT 依赖目标原有权限位。
- 是否需要安装 MUST 依据目标与产物内容字节比较（含“目标为普通文件且可写”），NEVER 以时间戳、大小或自建成功标记代替字节比较。

#### Scenario: 原生安装替换与回滚的可观察行为

- **WHEN** native 产物内容变化且目标映像正被占用（或未变化）
- **THEN** 占用时以改名让位完成替换、失败时回滚并保留恢复文件路径；未变化时保留原文件与修改时间

### Requirement: Native 换入后尝试清理让位文件

OMP MUST 在 native 产物成功替换后立即尝试清理该次让位的旧文件，且清理失败不得使成功安装失败。

#### Scenario: 改名让位后成功换入
- **WHEN** 旧 addon 因占用而先改名为 `<目标>.old.<PID>`，新产物已成功换入目标
- **THEN** MUST 尝试删除该次让位文件；删除失败 MUST NOT 撤销成功换入或将安装判失败。
- **AND** 换入失败时继续按既有回滚及恢复文件保留要求处理，不能先删除恢复所需的文件。
