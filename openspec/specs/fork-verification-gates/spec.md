# fork-verification-gates

## Purpose

规定 fastcheck、fulltest 和 slowtest 的范围、预算、Git 版本记录、原生测试选择、失败汇总及证据合同。报告只对实际执行的平台和范围有效，不证明运行期间整个工作区内容未变化。

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

OMP MUST 按各入口规定范围、预算、Git 版本记录与失败汇总执行，并只报告实际完成的证据。

#### Scenario: Fork 验证体系的详细边界

- **WHEN** 本节所述功能在适用条件下运行
- **THEN** 以下具体约束适用：

| 入口 | 当前有效范围 | 非编译硬上限 | 总墙钟硬上限 |
| --- | --- | --- | --- |
| `bun run fastcheck` | 静态分析、类型/格式检查和编译；无任何测试，包括冒烟、自测 | 360 秒 | 沿用非编译预算 |
| `bun run fulltest` | 全部 fastcheck 检查 + 本机 fork 功能的 Bun、Cargo/Nextest 和适用 doctest、变更对应的仓库脚本自测、native 构建及隔离 Dev 浏览器／原生公开入口 E2E 与普通 TUI smoke；测试选择见下文，无跨 WSL | 1800 秒 | 1800 秒 |
| `bun run slowtest` | 本机 fulltest 一次 + 项目所需且现有兼容 WSL 可用时的 Linux fulltest；无适用 WSL 时保留本机 fulltest | 3000 秒 | 3000 秒 |

表中列出必需的独立工作与适用套件；原生增量选测只说明本轮实际覆盖，不能声称整套测试均新执行。

- 三层门禁及根脚本直接调用既有 Bun／Cargo 检查、构建与测试原语，保持平台限制和报告语义；fastcheck 不运行测试，保留既有工具及增量编译缓存，但不缓存门禁或完整命令结果以免执行。不建立 fork 专用 Bazel 验证图或自建结果缓存框架。上游原有显式目标 Bazel 工具及其 CI 原生产物不属于此门禁改动。
- 日常门禁包含真实 Rust 编译和 Clippy：`check:rs` 依次运行 `cargo fmt --all -- --check`、`cargo build --workspace`（保留既有 vendored fork 排除）和与 `lint:rs` 相同的 workspace Clippy（保留既有第三方排除、`--no-deps` 与 `-D warnings`）。编译必须生成并链接产物，不能以 Clippy／`cargo check` 代替；fastcheck 及复用它的 fulltest／slowtest 均检查 Rust 编译器与 Clippy 警告并以非零退出阻断。固定工具链、显式 `lint:rs`／`fix:rs` 入口、其他检查和测试范围及预算保持不变。
- 日常 `bun run test`、`test:ts`、`test:rs`、fulltest 和 slowtest 测试 fork 自有功能；父仓静态检查与测试发现排除 `vendor/openwiki` 子模块，构建和运行仍使用真实 fork。保留 Dev/OpenSpec 资源与原生编排、Team/Goal（包括取消与持久化）、Knowledge 索引、OpenWiki、company/Ascend/CodeAgent、offline/代理/统一数据根、共享 Skills、compact/中文 TUI 与状态栏、审批模式/个人命令/默认值及 fork 分发消费者边界；Dev 真实 E2E 不得省略。`/wt` 新策略由消费者测试覆盖，不因此运行全部 task/worktree 或 pi-vcs。
- 通用 Browser/upload/relay/CMUX/Tern、shell/VCS/builtins、通用 task/worktree、独立 RPC/ACP/SDK、全 provider 矩阵、基础 TUI 库与旁支包的完整回归不纳入日常范围；纯上游继承或仅 bugfix 专项即使记载于规格也不因此纳入。上游测试文件与已有显式手动入口保留。旧 Dev TUI 专属消费者 MUST 由新工作台网页及原生消费者替换。真实 PTY 中普通 TUI 的错误、状态和焦点边界保留；冷启动、准备失败／EOF、新流程冷读、owner／profile 隔离、权限、取消、Windows 句柄和公开打包资源等有效边界不得删减。四个开发角色的 missing／malformed／unknown 材料失败矩阵及现有平台条件转由工作台控制器、材料和公开网页／进程消费者承接，每例 provider／fixture 隔离不得共享。仅删除固定三行、旧模式 toggle、直接跳过业务检查、finish-business、执行 Next 终结、drop 留文件和旧状态恢复等已废止产品断言，不新增 skip、放宽时限或删减有效需求。本次 tui-presentation 允许清退的旧 compact 专属测试、fixture 和断言仍按原边界处理；上游、clean、detailed、共享布局或其他 fork 功能不在清退范围。
- 默认 fulltest 的普通 Bun 测试在 fork 白名单内以原生 `--changed` 根据变更及依赖选测；缺少合格基线或工具不支持时回退完整白名单，不能回退整个上游测试集。新 compact 的显示差异纳入普通 Bun 消费者范围，不再设始终完整运行的 compact 专属通道。显式选测及 `local`／`local-ts` 须如实报告范围，宿主 `CI` 或 `OMP_TEST_SHARD` 不改变本地范围；保留文件隔离、TSX 和共享并发预算。仓库脚本自测只在对应脚本或门禁模块本轮变化时选入，独立 `test:scripts` 保留。
- Dev 工作台 source 测试 `packages/coding-agent/test/dev-workbench/` MUST 纳入 fork 白名单；`browser.e2e.test.ts` 与 `process.e2e.test.ts` 属于既有启动敏感组，不建立绕过共享预算的专属通道。collab-web 仅精确新增 `test/dev-workbench.test.tsx`、`test/composer.test.tsx`、`test/transcript.test.tsx`、`test/tool-view.test.tsx`、`test/markdown.test.tsx`，native 仅精确新增 `packages/natives/test/dev-workbench-vcs.test.ts`；不因此纳入整个 collab-web 或通用 VCS 套件。测试发现、文件计数、空选择探针和报告 MUST 同时识别 `.test.tsx`。
- Bun fork 套件版本 MUST 使用 `suiteRevision: 4`；完整基线与计时提示资格须匹配当前消费者范围，旧范围完整报告不作为新范围完整证据。WebGUI 按 `scripts/ci-test-ts.ts` 的显式文件白名单选入核心浏览器、聊天、原生子代理／任务、目录／文件／Git／Skill、MCP 关闭、平台前置与资源消费者；本次精确补入 `test/webgui/native-attachments.test.ts`、`native-interactions.test.ts`、`native-browser-release.test.ts`、`project-ownership.test.ts`，以及 `test/registry/agent-lifecycle.test.ts`、`agent-session-dispose-releases-memory.test.ts`、`sharpshooter-extract.test.ts` 与 `packages/agent/test/pause-gate.test.ts`，验证严格结清／重试、独立根暂停及原默认行为，不扩大整个上游 agent 或通用 browser 套件。单个 browser runner 复用既有启动敏感组及共享预算，动态 Vite 前端与夹具输入定向触发该 runner，其余可追踪变更继续使用 Bun 原生 affected 选测。affected、失败及未完成报告的原语义不变。
- WebGUI 不再对接 MCP；移除 `test/webgui/native-mcp.test.ts`、`native-mcp-binding.test.ts` 及其白名单，精确保留 `test/webgui/mcp-disabled.test.ts` 验证真实 RPC 旧通道不可调用，核心浏览器消费者验证设置与 Skill 等保留页面正常。原生 Agent／TUI／Dev 的 MCP 测试与能力边界保持不变，不因浏览器清退删除原生覆盖或增加连接／授权验收。
- 显示验证 MUST 围绕 clean 基线、按文件目标筛选且与上游 detailed 一致的 write／edit 原组件显示、固定两行活动区及隐藏独立模型处理忙碌提示的消费者契约，复用既有普通测试入口和必要的共享布局、渲染、恢复验证；不按文件名收集 compact 大套件。纯上下文压缩模式注册、算法、预算、队列和 `/compact` 参数派发不因名称相似纳入。
- 旧 `compact_display` 命令、独立清单、执行通道、排除参数、专属报告和基线要求 MUST 移除，不保留兼容别名或用新名称重建同类通道。仍适用的显示消费者测试由普通选测机制发现，只执行一次，不再从普通组排除后另行执行。
- 旧 compact 专属完成帧矩阵、随机旅程、截图回归与真实 CLI 场景仅为旧行为存在的部分 MUST 清退，不以改写预期保留旧套件。新需求优先复用现有消费者验证，以显示差异的实际可观察结果和必要状态切换为边界；共享上游布局与其他 fork 场景不因此删减。实际执行、采样、平台条件和未覆盖部分须如实区分，不新增 skip 或放宽时限掩盖失败。
- 根目录 `docs/`、`docs-zh-CN/` 和 `AGENTS.md` 不作为 Git 测试选择输入，不触发 Bun 全量回退或独立 UI smoke；混合变更仍按其余运行输入判断。排除不扩大到包内 Markdown/prompt 等运行资源；缺少合格基线和显式 `--full` 的行为不变。
- `bun run fulltest --full` 显式运行当前平台支持的完整 Bun、Rust workspace、Python 普通套件、Go/Rust SDK 和仓库脚本测试，但不发现或运行 `vendor/openwiki` 子模块自身的测试；OMP OpenWiki 消费者测试仍在范围内。不使用 fork 白名单、变更选测、pytest-testmon 或环境分片；默认 fulltest 及 slowtest 不变。保留测试自身的 skip、平台不支持、真实桌面输入及另需单独授权的集成边界；不因全量模式放宽门禁时限。
- 独立 Python SDK、Robomp 和 legacy 通用 SDK 不纳入默认 fork 门禁，手动入口保留；Robomp integration 仍须单独显式启用，Windows 原生调用报告不支持并非零退出。
- `bun run test:rs` 用 Cargo 包及 Nextest namespace 标准筛选 `pi-knowledge` 全包和 `pi-natives` 的 `knowledge::` 绑定测试；scope 为 `rust-fork-features`。独立 doctest 阶段实际运行 `cargo test -p pi-knowledge --doc --no-fail-fast`，报告真实命令、退出码和命令墙钟时间；Cargo doctest 无标准 JUnit 报告，记 `report=not-supported`。`pi-natives` 是 `cdylib`，无 doctest，不生成虚构用例或 PASS，不运行上游 tree-sitter-go 文档例子凑数。保留同平台构建配置及正常 Cargo 增量编译缓存。
- 非 Rust 变更不能一律视为与 Rust 无关：构建脚本、配置、清单、锁文件、工具链、生成输入及跨语言依赖等可能影响 Rust。Bun 文件依赖是近似，动态依赖、环境和外部输入可能漏检；受影响选测不是全新完整回归的证明。
- 通过子进程启动 CLI 的测试须在公共 harness 或独立启动器中静态声明真实运行依赖，让 Bun `--changed` 能识别间接消费者；Tools registry 可作为输入，不能导入并执行 CLI 主入口来构造依赖图。
- 默认 fulltest 使用同一个真实 clean、完整成功的 fork 基线；Bun 完整基线包含当前普通和启动敏感组所需工作，不再要求已移除的 `compact-display` producer；旧范围报告不能充当新范围完整基线。Rust 用 cargo-delta 0.5.0 对 Git 变更和 Cargo metadata 分析受影响 crate 及逆向依赖，与 fork 包范围取交集后以标准 Cargo 包选择执行 Nextest。配置 tripwire 覆盖全局或无法安全归属的输入；动态依赖、构建脚本、环境及外部输入仍可能超出分析，无法确定时回退完整 fork 范围，仍须适时完整回归。工具缺失、失败或输出无效亦回退完整 fork 范围；无合格基线同样回退。空交集不启动 Cargo，`pi-knowledge` 被选时才独立运行 doctest；`pi-natives` 无 doctest。独立 UI smoke 和仓库脚本仍按 Git 变更规划，缺基线或依赖未知时保守执行；静态检查及必要 native 准备始终全局执行。affected、partial 或失败报告不能作为完整基线，不以提交 sidecar 或改写历史建立基线。
- cargo-delta 须预先安装 `cargo install cargo-delta --version 0.5.0 --locked`，门禁不自动安装；其标准分析缓存不是测试结果缓存。直接 `test:rs` 始终运行完整 fork 范围，`--full` 始终运行完整 workspace，不使用 delta。Git／cargo-delta 未选阶段记录有效基线 revision、相对变更路径、原因和零选择，cargo-delta 另记录空包列表；不虚构 XML、用例或耗时。实际受影响包的 Nextest 保留真实 JUnit、包列表和基线，doctest 按实际阶段状态报告；全未选可报告真实零执行，混合报告保留实际 XML 与失败，均不得当作完整新执行或完整基线。
- 单个用例、文件或语言套件失败后继续执行独立的其余必需测试，Nextest 与 rustdoc 使用 `--no-fail-fast`，Bun 不添加 `--bail`，pytest 不添加 `-x`；只有总预算、取消或参数错误可终止剩余工作。
- 默认 fulltest 不自动纳入独立 Go/Rust SDK；安装测试和另需授权的集成入口也不自动纳入 `--full`。手动构建发布 CI 不运行任何测试，也不以测试作业为发布依赖；保留的 `ci:test:*` 脚本只是显式测试工具，不由 CI 工作流调用。发布仍依赖版本元数据、二进制与浏览器扩展构建成功，不增加自动触发。
- native 安装从真实构建产物执行版本戳及宿主加载核验；最终版本戳后的 addon 字节与 bindings 内容均未变化、且已有文件可写时，保留安装文件及其修改时间。版本或内容变化时 MUST 按下文「原生安装替换与回滚」执行替换。

- 三层均在一个单调累计时钟下计费，排除实际观测到的**纯编译区间之并集**；编译和非编译并行时重叠仍计费一次。发现、准备、原生选测、下载、同步、非编译等待、汇总和清理计费；不能把混合检查/测试命令整段排除，也不能将历史耗时计入本轮编译排除。fulltest/slowtest 另有包含编译及全部收尾的总墙钟硬上限，不因纯编译排除而延长；嵌套阶段共享外层剩余额度，并保持更严格的内层上限。`--limit-seconds` 同时下调本入口的非编译与总墙钟上限。
- 到限主动终止本次拥有的进程树，非零退出并报告 `TIMEOUT`，不在阶段间重置时钟、不放宽上限。所有退出路径（成功、失败、缺工具、超时、中断、参数错误）都输出 status、total、compile_excluded、budgeted、limit 与退出码，秒至少一位小数。fastcheck 按 budgeted 判断到限；fulltest/slowtest 在 budgeted 或 total 任一到限时退出，独立线程须能在主线程同步阻塞时执行总墙钟强退。
- 三级门禁默认只向控制台显示失败用例及错误诊断；成功用例、成功分块、成功命令及其 stdout/stderr MUST 隐藏，不生成逐条成功用例的普通过程日志。保留最外层入口最终状态、耗时、退出码及报告位置。失败名称、错误／堆栈、相关命令上下文和取消／超时诊断 MUST 保留，首错通知不得等待输出缓冲收尾。此规则仅改变呈现，不改变执行范围、失败继续、并发、预算或原退出码；成功与失败用例的完整 JUnit、计时及结构化结果仍须记录。
- fastcheck／fulltest／slowtest 的验证失败不终止整轮：记录实际用例、检查、编译、执行、准备或核验失败及原退出码，继续执行不依赖它的剩余必需工作；同一 producer 内完整执行其余用例（如 nextest 使用 `--no-fail-fast`）。工具或环境缺失仅使依赖它的工作失败或阻塞，被阻塞的依赖项标记未运行且不计通过。只有到限、中断或参数错误才立即终止本次拥有的任务与进程树。嵌套运行器及时通知外层并保留原退出码；汇总全部失败，最终退出码取首个实际失败的原退出码（失败状态附带 0 时归为 1），未启动、取消或阻塞不算通过。
- Windows 截止监督及失败通知不得被同步阻塞或管道背压延迟；初始化收到首错／中断时锁定原始退出码并禁止工作。缺失工具与缺失证据／产物分别报告，不能把所有 `ENOENT` 归为缺工具。
- 构建脚本能力探针的预期非零编译退出作为探针答案原样返回，不单独触发门禁失败；Cargo 正式编译单元及 Go 工具的失败仍须即时上报并保留原退出码，不能依赖外层进程转发失败；外层收到后继续其余独立工作。
- 门禁的进程监督须在命令仍运行时回收已退出的孤儿后代，不得截获由运行器持有的主命令退出码；宿主直接退出或 IPC 断开时，监督进程仍须停止并回收普通自有后代，含逃逸的独立 session。跨 Windows/WSL 的取消命令须在强退前独立发起，不等待其收尾。Windows 隔离临时目录的正常清理须能解除带拒绝读取 ACL 的目录 junction，且不得遍历或删除其目标；清理失败不得降级成通过。
- 独立且安全的检查/测试/Windows与WSL两端应并行；本机资源不足时可按共享预算调度重负载。改写共享生成文件的构建、打包或代码生成须先于其静态/测试读取者，避免共享文件竞争。编译项目必须保留正常增量缓存、固定同平台配置与路径；NEVER 在连续 fastcheck 之间清缓存、切换 target/profile/flags 或制造冷样本。Windows 与 WSL 使用各自稳定的原生缓存。
- 真实 public process 测试的隔离环境 MUST 继承门禁显式配置的 `BUN_RUNTIME_TRANSPILER_CACHE_PATH`，避免每个临时 HOME／TEMP 都重建相同源码的 Bun 编译缓存；应用配置、凭据、会话、数据库、工作区及运行期临时文件仍逐例隔离，不缓存进程或测试结果。
- native 生成后静态检查与测试按依赖安全调度：Rust 测试等待 Rust 静态检查完成；普通 Bun、Dev 工作台公开 process／browser 及保留的普通 TUI／RPC goal 启动敏感组尽早并行启动，各组按实测耗时长任务优先，不再让启动敏感长测试等待整个普通队列结束。时钟、watchdog、未知脚本和共享写入者的仓库自测须先隔离执行；明确允许的纯夹具脚本可在预留容量内最多两个并行，与重负载阶段重叠。移除独立 `test/compact_display` 调度及其专属环境／资源分配；仍适用的显示消费者测试随普通组或已有启动敏感组执行，共享原有 CPU 预算。全部静态、普通、启动敏感、Rust、仓库脚本及其余重负载工作结束后运行独立隔离的普通 TUI smoke。小预算机器串行，先完成静态检查，再优先运行启动敏感长测试。启动敏感测试文件内串行，保持各自独立的 HOME、工作区、端口及清理，不扩大用例时限或弱化业务断言。fastcheck 保留独立的 360 秒非编译预算；保留既有 target、profile、features 与 flags，不杀其他 Agent 的 Cargo 进程或放宽时限。
- 测试运行器按当前可用核心数动态限制并发，任务不足时进一步缩小。Windows 本机 TS（包括初始完整轮、无合格计时提示及 fulltest 短任务池）、启动敏感测试和 Rust Nextest 均最多 `min(28, 当前可用核心数, 可运行任务数)`；Linux 等其他平台维持同一上限。Bun 的 chunk 池与每个 chunk 的文件 worker 共同分配预算，不能相乘后越过上限；显式配置仍可降低并发。fulltest 为静态检查和独立脚本预留容量，普通 Bun、启动敏感 Bun 与 Rust 测试池共享剩余 CPU 预算：普通 Bun 与 Rust 两端都有工作时，短 Rust 阶段最多分配 4 个 worker；并行的启动敏感阶段最多分配 4 个 worker，其余分配给普通 Bun。只有启动敏感阶段有工作时可使用剩余容量。没有选中 Rust 工作时不得继续为其预留测试 worker。容量不足时串行运行重负载。后置普通 TUI smoke 最多使用三个 PTY worker，仍受继承的外层额度约束。`--full` 同样受高成本 integration／E2E 子限制约束；调度不改变测试覆盖、隔离、超时、时间预算或计费。
- fulltest MUST 将可用实测耗时最长的分块优先启动。排序提示可使用最近七天内同平台、架构、Bun 版本及 `suiteRevision: 4` 的 `fulltest: fork feature suites` 运行中已经完成的分块，即使整轮失败、部分完成或被中断；优先读取独立 producer 记录，每个精确分块取最新、有效且无歧义的实际命令墙钟耗时。当前运行、未完成分块、缺失报告、非法耗时或有歧义的同次测量不得提供提示；提示缺失不阻止必需工作，未知分块保留稳定顺序。允许历史报告来自不同的有效 Git 提交，但只有 label 与预算／报告参数以外的 argv 精确匹配的原分块才能复用，不拆分文件耗时或跨分块重组。历史耗时仅用于排序，不是测试结果缓存，不写成本轮新执行，也不改变分片、超时及结果合同；失败或未完成运行仍不能成为受影响选测的完整成功基线。
- 本地高成本 integration／E2E chunk（包括 Dev 范围 Git 发布与撤销消费者 `test/dev-workbench/git.test.ts`、`test/dev-workbench/cancel.test.ts`）同时运行不得超过 4 个，且仍受上述 Bun 测试并发上限约束；达到此子限制时，空余并发 MUST 继续调度其他可运行工作，不得因等待高成本 chunk 而闲置，不因此增加普通全局并发。此子限制不改变超时、断言、覆盖及结果合同。
- Knowledge CLI 的既有真实消费者场景可在单个测试文件内最多两个并行，并遵守调用方单槽预算。每个场景须独立拥有 provider、查询状态、观测、子进程、配置、工作区及清理；只可共享只读的预备索引字节，再复制为各自的数据库／WAL，不共享可变应用状态或 CLI 进程。既有全部用例、分页正文、控制字符、错误、移除索引和真实至少 500ms 对外等待断言保持，不以减少矩阵或跳过实际启动加速。
- 门禁只以轻量 Git 查询记录本轮开始时的 HEAD 和工作区状态，不遍历、读取或哈希全仓文件及子模块源码，不维护源码指纹、阶段快照或对应环境参数／报告字段。运行期间文件、未跟踪临时文件或 HEAD 变化 MUST NOT 触发整轮失败、取消或自动重跑，也不要求为本机门禁先提交或清空工作区。native 生成仍先于静态检查和测试读取者；版本记录不作为内容未变化的证明，受影响测试选择与实际失败报告保持独立。
- Windows 测试子进程的 PATH 排除 WindowsApps 执行占位程序，复用已安装的真实 Python；Python 夹具的 UTF-8 标准流协议不依赖宿主 ANSI 代码页。环境覆盖遵循 Windows 变量名大小写不敏感语义，不修改系统 PATH 或宿主配置。测试使用隔离应用配置、HOME 和凭据，不读取用户真实配置。
- 旧 Dev TUI E2E 的有效启动、输入、生命周期及 Team 报告持久化／取消场景 MUST 转由真实工作台 process／browser 和原生会话消费者承接，进入启动敏感组，不把普通 PTY smoke 冒充网页替代验收；保留隔离、超时、依赖顺序和业务断言，Goal 手动启动／停止、长任务断线和任意深度子代理结清继续覆盖。既有 PTY smoke 本身覆盖普通 CLI、`/team`、取消、输入和退出，不承担旧 Dev 模式场景；工作台 process 消费者验证 `/dev` 拒绝在普通任务未结清时进入、进入后当前 TUI 只接受再次 `/dev`、网页与普通 TUI 不同时操作、退出经 native settlement 恢复原会话但不取消需求或回滚，以及关页不停止。删除仅服务普通 `/new`／move／dispose 与 Dev 并存、快照或克隆的断言，不保留并发架构。普通 TUI 部分仍用既有 `tui-test`／TUI harness，不另造 PTY／ANSI 驱动；既有启动与 Team／取消独立分组仍受可用核心数与继承的 `OMP_TEST_CPU_BUDGET` 约束，最多两组并行，组内依赖顺序不变，全部自有进程须完成并回收。缺失 `tui-test` 按缺工具失败；网页验收使用已安装、可执行的 Chromium，缺失即前置失败，不自动下载、不用静态渲染替代真实 DOM。
- Dev source 测试只依赖隔离源码服务及本地模型／Git／bare remote／既有 Relay fixture，不要求预构建 npm／binary。独立成品程序 `packages/coding-agent/scripts/verify-dev-workbench-package.ts` MUST 不被普通发现、全仓 Bun 或 `--full` 自动运行；只有当次明确授权并提供实际本次产物时，才以 `--npm-entry`、`--binary`、`--assets-manifest` 验证真实 CLI、完整内嵌 UI、载荷摘要和构建来源。缺产物、浏览器或来源不符必须失败，不回退源码、不自动 releasebuild，不以源码证据代表 npm／binary 或所有平台通过。
- fastcheck 仅在具体需要且相关修改批次完成后由 Agent 选择，不能逐文件保存即运行。fulltest/slowtest 需要本次用户明确运行授权，授权不跨任务延续；不能通过直接执行内部阶段绕过权限。新/改门禁入口脚本可直接执行显式限定到该文件的非测试静态检查，不得扩大到目录/仓库或执行测试、打包、跨 WSL。
- 三层 NEVER 调用或触发 CI/远端发布流水线、push、发布、部署、Computer Use、共享鼠标或抢前台焦点。独立构建发布 CI 仅手动触发，发布不属于门禁。真实桌面输入测试保留并另行明确授权，记 `NOT_RUN_SEPARATE_USER_INSTRUCTION_REQUIRED`，不计为已通过；隔离的浏览器 DOM/协议、虚拟终端和 PTY 自动化可纳入本地测试。
- 本项目支持 Windows/Linux x64，Windows→WSL 验证显式选定 **Ubuntu-24.04 WSL2**，不能替换目标；未指定目标的一般项目才优先合适的已安装 CentOS。无 WSL/无兼容发行版记 `SKIPPED_WSL_UNAVAILABLE`，项目不需要则 `SKIPPED_NOT_APPLICABLE`，此时 slowtest 仍覆盖本机 fulltest。其余发现、同步、脏源码、缺工具、执行或证据核验失败须使该端记为失败并使整轮最终非零退出，不得降级成跳过；本机与 WSL 并行阶段按失败汇总继续各自其余独立工作，不因单端失败提前终止另一端，也不得把单端结果表述为两端完成。不自动安装 WSL、发行版或缺失测试工具。
- WSL 通过 `scripts/slowtest-wsl-stage.ts` 在 slowtest 内执行，源码只能经 **Windows → Git 网络远端 → root 身份的原生 `/root` 工作区** 同步并测试完整固定 SHA。禁止本地快照、bundle、复制、rsync、patch、stdin 传源码、本地 remote 及 `/mnt/*` 工作区；stdin/stdout 仅承载调度计划/参数与日志。门禁没有 commit/push/stash 授权：源码未提交或未推送须立即报告为该端失败，不能测试旧提交代表当前改动。既有固定提交同步 helper 的 plan 保留远端身份、fetch/固定 SHA 可达性、快进、工作区与子模块保护、未跟踪残留隔离和测试后状态检查；流式执行计划并观测嵌套 fulltest 的纯编译事件，无法可靠计时则 UNVERIFIED，不能整段豁免混合命令。helper 的 7200 秒墙钟防挂另行报告，不得放宽外层 3000 秒总墙钟上限。记录两端 HEAD、工作树、Linux 工具路径与版本；不同固定提交不得合并 PASS，不增加本地源码指纹扫描或运行期间不变性检查。取消只处理本次拥有的资源，不关闭发行版、不删除用户改动、残留证据或有效编译缓存。
- WSL 验证使用已就绪的本机依赖，不自动执行 `bun install` 或安装缺失工具；依赖不足按原始准备／执行失败报告，不降级为不可用跳过，也不运行旧源码冒充当前固定提交。
- WSL 原生仓库发现受 slowtest 同一累计非编译与总墙钟额度约束，不另设 25/30 秒的提前截止；宿主与 Linux 的有限防挂不能延长外层时限。完整发现须保留嵌套工作区与多匹配拒绝语义，不通过缩小遍历范围规避超时。
- 本地门禁报告本平台适用工作和实际测试选择范围，不能把 affected 范围写成完整新执行，不能称全仓全量通过。保留现有 TS/Rust 静态检查、native 构建及 Dev 网页／原生、普通 TUI 集成边界；独立 SDK、安装发布、真实桌面、真实 Forge 和实际模型集成仍按各自授权执行。不得将平台跳过、尚未验收的成品或独立授权范围表述为通过。
- 公开测试入口写入被 Git 忽略的 `runs/test-timing/<run-id>/`：本轮执行的 Bun、nextest 与可提供结构化结果的 rustdoc 各自输出独立 JUnit XML，CLI/PTY 场景按实际命令或场景计时；`run.json` 保存源码与环境、实际范围、原始退出码、每个 producer 的命令、报告路径及完成状态。默认 fulltest scope 为 `fulltest: fork feature suites`、控制台范围为 `fork-features`；`--full` 分别为 `fulltest: all test suites` 和 `all-tests`。原生选择元数据记录工具、`full`／`affected` 模式及可用的选中／排除数量、原因、基线和报告路径；区分实际执行、deselected、not-selected 与未运行，历史 testcase 和耗时不是本轮新执行。独立运行与重试不得覆盖前次报告；报告缺失、被取消、提前退出或仅有阶段耗时须标为部分覆盖，不能把阶段时间冒充单测时间。正常执行完所选用例但含失败的报告标为失败；JUnit 用例时间之和不是并行挂钟时间。
- 普通 PTY smoke 的 fulltest label 为 `smoke/isolated native TUI PTY`，场景 JUnit classname 为 `native-tui/pty`、producer 为 `native-tui/<case>`、scope 为 `native TUI PTY smoke scenarios`；运行器阶段仍为 `ui-smoke/runner-stage`。这些报告只证明普通原生 TUI 场景，不代表 Dev 工作台 process／browser 或成品验收。
- 正常报告收尾由门禁生命周期跟踪，计入同一预算与总墙钟时限；验证失败须在预算内完成全量失败汇总报告后退出，发生超时、中断或阻断时立即退出优先于报告补写，不能为生成完整 `run.json` 延迟结束。强退可能留下缺失、未完成或临时报告；报告须结合门禁最终输出及进程退出码判读，非零退出时任何暂存的 complete/0 元数据均不代表通过。
- `slowtest` 的 Linux JUnit/XML 与元数据留在 WSL 原生仓库，宿主运行的 `run.json` 标注未汇总范围并保持部分报告状态；即使门禁在两端通过，也不能把宿主 XML 当成两端完整测试报告。WSL 不可用时以门禁原有跳过状态为准。
- 环境/工具缺失、平台不适用和检查失败须分别说明，不把缺失或跳过当通过。失败须先区分业务缺陷与测试适配，平台 fixture 应验证实际平台合同，不用手工白名单绕过失败；未运行的实际模型质量、公司内网、独立发布和桌面输入不属于本地 PASS 的证明。
- 门禁机制自测在临时目录中用短任务覆盖原生选择与报告、失败继续与全量汇总、首个失败码、缺工具、超时/中断、首错通知、挂起 afterAll/报告收尾、同步阻塞、含编译的总墙钟与更严格嵌套时限、强退后的进程树回收、编译排除与重叠计费、累计与下调预算、并行、工具缓存保留、包含关系、适用 WSL 和禁止外部操作；自测不是 fastcheck 的阶段，也不能代替真实三层入口执行的证据。

#### Scenario: Fork 验证体系的可观察行为

- **WHEN** 执行 fastcheck、fulltest 或 slowtest
- **THEN** 按各入口规定范围、预算、Git 版本记录、原生选测与失败汇总执行，并区分本轮实际执行、排除和未运行的范围

#### Scenario: 三级门禁只显示失败用例

- **WHEN** fastcheck、fulltest 或 slowtest 中的命令、测试文件或用例成功
- **THEN** 控制台不显示其成功名称、成功分块进度或普通过程输出，本轮执行的结构化计时仍保留
- **WHEN** 出现用例失败、命令错误、缺工具、取消或超时
- **THEN** 显示对应失败和必要诊断，继续独立必需工作，并按原有规则给出最外层最终状态、耗时及退出码

#### Scenario: Dev 工作台取代旧专属消费者

- **WHEN** 清退旧 Dev TUI 验收或规划新工作台测试
- **THEN** 按下表保留有效合同，不用源码字符串、文案回显、静态页面或接线存在代替行为证据：

| 有效合同 | 对应新消费者 |
| --- | --- |
| 材料 missing／malformed／unknown、版本、路径、原生校验／同步／归档及部分副作用 | `test/spec-driven/{orchestrator,controller,artifacts,resources}.test.ts`、`process-resources.e2e.test.ts` 及工作台公开流程 |
| 真实工具／MCP／扩展、原生审批、阶段权限、只读 Scout、Team 可采用来源、Goal、取消与递归后代结清 | `test/spec-driven/{actors,actors-descendants,runtime,skill-policy}.test.ts` 及工作台 native／browser 消费者 |
| 八阶段、导入零对话、人工决定、范围 Git／PR、完整撤销、合入后自身记录限制与修复 | `test/dev-workbench/{records,git,cancel,host,server,cli}.test.ts`、`browser.e2e.test.ts`、`process.e2e.test.ts` 及新增 native VCS 消费者 |
| 全部原生问答／审批、附件／草稿／队列、迟到事件、断线不停止及重连不重放、HTTP／WS offline Collab | `test/dev-workbench/{host,server,collab}.test.ts`、真实浏览器与精确选入的共享 TSX 组件消费者 |
| 普通 TUI 输入／焦点／菜单／compact／Team／Goal 与双启动入口 | 保留的混合普通 TUI 消费者及原生 TUI PTY smoke；双启动入口另由启动敏感组的工作台 process 消费者覆盖 |

- **AND** 表中 coding-agent 测试路径以 `packages/coding-agent/` 为基准；纯组件测试不冒充真实浏览器，原生资源独立入口继续覆盖。普通 TUI、权限、Team／Goal、预算、并发、授权及跳过规则不因消费者替换而放松。

### Requirement: 本次 WebGUI 交付的真实模型双浏览器独立验收

本次 WebGUI 交付 MUST 分别取得默认 `bun run fastcheck` 成功、默认 `bun run fulltest` 成功、真实 Chrome 完整业务 E2E 成功及本机真实 Firefox 68 完整业务 E2E 成功的证据，四者缺一不可、不得互代。真实模型双浏览器 E2E 是用户为本次交付明确授权的独立验收，不改变日常门禁范围、预算、选测、报告或授权边界，不把公网模型、真实提供者认证、生产构建或 Firefox 68 引入默认 fulltest 的每次运行。

#### Scenario: 分开判断默认门禁与独立业务验收

- **WHEN** 判断本次 WebGUI 交付是否完成验收
- **THEN** `bun run fastcheck` 和 `bun run fulltest` 均以现有默认入口、范围及预算实际成功，不加 `--full`、不新增验收 flags、不放宽时间预算，不以 skip、删减有效用例或替换成较小入口掩盖失败；affected 选择仍按原规则如实报告，不能声称完整新回归
- **AND** Chrome 与 Firefox 68 各自完成下述全部十五项行为，不能将两浏览器的部分结果拼为完整结果，不能用 Chrome、Chromium 或兼容模式代替真实 Firefox 68，也不能用普通 TUI smoke、默认浏览器测试或仅页面可打开代替任一业务 E2E
- **AND** 本次需求文档维护本身不执行门禁、构建或业务 E2E；上述成功标准适用于后续交付验收，文档写入不构成已运行或通过证据

#### Scenario: 使用真实模型与同一份生产页面资源

- **WHEN** 执行本次独立 WebGUI 业务 E2E
- **THEN** 使用真实 OpenCode Go 提供者 `opencode-go` 的 Beam Free 模型，通过权威模型 catalog 或实际 discovery 确认并记录真实 model id，不从显示名称猜测 id；记录目录／发现来源及实际请求所用 provider、model id，不以其他模型、模拟响应或本地 echo 替代
- **AND** 两浏览器使用同一份生产构建的完整 WebGUI 页面资源，经公开 HTTP／WebSocket 入口驱动实际业务，不使用测试专用聊天页、开发服务器资源、绕过网页的内部调用或为旧浏览器另做简化页面；保留原有 ZCode 精简 UI 及仍有效的原生底层功能，不恢复已明确删除的 ZCode 产品页面
- **AND** 使用已安装的真实 Chrome 和本机真实 Firefox 68，各自采用隔离浏览器 profile、应用 profile、工作区、会话及端口；认证仅使用本次授权的凭据，不读取或修改个人浏览器配置，不自动安装浏览器、驱动或其他工具
- **AND** 每浏览器均通过网页发起真实原生 Agent 开发任务，观察真实模型请求、原生工具执行、目标工作区实际文件写入及可核对的开发结果；启动成功、消息回显、虚构工具事件或预先写入的文件不构成成功
- **AND** 本地 mock 可补充过期、拒绝、断线及确定性失败路径，但必须单列其证据与范围，不能代替任一浏览器真实模型端到端完整流程

#### Scenario: 每浏览器完整覆盖十五项可观察行为

- **WHEN** 在 Chrome 或 Firefox 68 中验收本次 WebGUI
- **THEN** 该浏览器独立完成下表全部行为，并对每项记录实际操作、预期、结果及可观察业务证据；需失败路径配合时区分真实执行与本地 mock 辅助覆盖：

| 项 | 行为 | 必须观察到的验收结果 |
| --- | --- | --- |
| 1 | 独立启动与项目选择／打开／创建 | 独立 `omp webgui` 启动保持 lazy：未显式工作前无自动 Agent、项目记录、项目占用或模型调用；网页能选择、打开、创建真实项目，页面项目作用域不等于全局 current，跨项目切换后旧连接不能读写另一项目。 |
| 2 | 新建原生会话与真实开发／历史继续 | 显式创建会话或发送首条消息后实际建立原生 AgentSession 并用真实工具完成开发写文件，不使用模拟会话、ZCode 执行器或独立 SDK 进程；允许同进程原生 SDK 创建。全部可访问历史仍可只读查看，不因 current 改变静默删减；显式继续历史按目标真实 cwd 取得准入，再加载独立驻留原生会话，已驻留则复用该会话，不切走另一执行中会话。 |
| 3 | 独立停止／取消 | 按原生 abort 语义取消指定会话，保留历史、不删除开发文件、不回滚 Git，不终止兄弟会话；实际取消状态与会话归属可核对。 |
| 4 | 原生补充问答 | 网页显示真实原生问题、选项及输入，回答返回该会话的真实等待点；过期、重复及跨会话回答不影响其他请求，失败不假装已回答。 |
| 5 | 文件／图片上传 | 上传真实字节，保留文件名、MIME、大小与会话归属；图片进入原生图片输入并按实际模型能力处理，不假设模型支持。取消／断线清理不删除仍被已接纳消息使用的附件。 |
| 6 | `@` 文件上下文 | 引用经过授权路径解析，模型实际收到被引用上下文并用于任务；越权路径被拒绝，不能仅回显引用文字或读取另一项目文件冒充成功。 |
| 7 | 忙时队列 | 忙时消息默认采用原生 follow-up，显示真实入队、处理或拒绝状态，消息被正确会话消费，不能以用户消息 echo 冒充已经执行。 |
| 8 | 运行 guide／立即发送 | guide 采用原生 steer 并产生可见接受、执行或拒绝状态；显式立即发送遵循原生中断和队列语义，不暗中中断，也不串入另一会话。 |
| 9 | 编辑已有提问重发 | 使用原生 branch 语义形成正确会话分支并重新执行，默认不回滚工作区；失败保留编辑内容与草稿，不静默改写原历史或丢失输入。 |
| 10 | 失败回复重试 | 失败回复通过原生 retry 在正确会话重试，真实结果可追踪；失败保留编辑／草稿，不能用新建无归属请求或回显替代重试。 |
| 11 | 当前 profile 用户 AGENTS | 展示当前进程有效 profile 的用户级 AGENTS 实际目标路径，读取、编辑、保存真实文件；不写项目 AGENTS 或 `~/.zcode`。未保存与保存失败均保留内容，切换上下文不写错 profile。 |
| 12 | 文件及 Git 自动刷新 | 原生工具写入与外部修改均自动更新文件树、预览和 Git 状态，不依赖手工刷新；切换／退出清理订阅及 watcher，不新增 Git 写操作。 |
| 13 | 多会话并行与隔离 | 独立原生会话实际并行执行，项目绑定、临时模型选择、草稿、问答、队列、取消及递归子代理均保持各自归属；切换或重连不让旧事件、连接及附件影响另一会话，关页不取消工作。 |
| 14 | 全部内置命令与有效 Skills | 按当次原生 TUI 完整命令／Skill 目录逐项对应并执行，参数与执行语义一致；未知命令明确报错而不发给模型当普通文字，交互命令由网页完成对应交互，模式／退出类保持已有独占、结清及权限语义。不能将“全部支持”降为只展示目录、大部分可用或不可用兜底；原生 Agent／TUI／Dev 能力保留。 |
| 15 | 所有并行工作的退出结清 | 退出先禁止新工作，结清本实例全部并行 root 及任意深度子工作、在途问答、队列、上传和配置写入，再释放自有 socket、watcher、listener 与 lease；失败保持锁定且可重试，不影响其他进程，不错误 dispose 借用的 TUI 原会话。 |

#### Scenario: 保留逐项证据与诚实的完成状态

- **WHEN** 汇总本次 WebGUI 验收
- **THEN** 分别保留两个默认门禁的实际命令、退出码、耗时、范围及原有报告位置；Chrome 和 Firefox 68 各自保留可执行文件实际路径、精确版本、隔离目录、生产构建来源及资源标识、实际公开 HTTP／WebSocket 入口，证明两者使用同一份生产资源，而非以版本声明代替实际加载证据
- **AND** 记录真实模型的 provider、实际 model id 及确认来源，每项业务结果对应项目真实 cwd、会话／分支归属、真实问答／队列／工具事件、写入文件路径及可核对内容；命令与 Skill 验收保留原生有效目录和逐项结果，不以单个代表命令覆盖全部
- **AND** 命令逐项结果遵守同一原生能力与权限前提：本机已具备且已授权的正向操作必须实际完成；显式取消或缺少特定外部服务／设备／认证时，验证对应的原生取消／拒绝及无错误副作用。不得将 WebGUI 缺少 handler、未适配提示或伪成功当作原生前提不足，也不得用这些拒绝替代上述核心开发功能的正向验收
- **AND** 对退出记录所有本实例 root、递归子工作、在途操作的结清结果，以及自有端口、连接、watcher、listener、lease 和进程资源的释放证据；同时记录兄弟会话、其他进程及借用 TUI 原会话未被错误终止或处置的结果
- **AND** 验证 WebGUI 不干扰正常 OMP／TUI：未启用时无网页资源或交互绑定副作用；普通源入口的聊天、工具、问答、原命令与默认暂停／录制路径保持原样；从真实 TUI 进入 WebGUI 后结清退出，原会话、草稿、工具／扩展 UI 与审批输入恢复且可继续执行。复用既有普通 TUI smoke 和相关原生消费者，只对缺少的真实进入／退出边界补充验证，网页通过不代替 TUI 非干扰证据
- **AND** 缺认证、模型不可用、浏览器／工具缺失、业务失败、未运行及证据不足分别如实标为阻塞、失败或未验证，不能跳过后宣称完成；重试保留前次记录，任何 gate 或任一浏览器未完整成功都不能宣称本次交付通过
- **AND** 本次独立验收仅含两个默认门禁和上述两浏览器，不扩展手机实机、安装发布物、发行、部署或发布流水线验收，不自动下载安装或修改个人浏览器配置

### Requirement: 原生测试选择

fulltest 和 slowtest MUST 使用 Bun 原生选测能力和 cargo-delta 受影响 crate 分析；不将门禁或整个测试命令作为可跳过的缓存目标；fastcheck 保留原有编译和工具缓存且不运行测试。

#### Scenario: 受影响测试与回退

- **WHEN** 运行本机或适用 WSL 的 fulltest
- **THEN** Bun 测试在 fork 白名单内依据合格基线使用 `--changed`，新 compact 消费者与其他功能使用同一选择规则；不可建立有效选择时回退完整白名单，不再存在完整执行 compact 专属清单的例外。Rust 基于 cargo-delta 受影响 crate 与 fork 范围的交集执行 Nextest，空交集记为未选；选中 `pi-knowledge` 才运行其 doctest，native `cdylib` 无 doctest。缺基线、工具缺失或失败、输出无效及无法确定边界时回退完整 fork 范围
- **AND** 选择结果区分执行、排除和未选中，报告 full 或 affected；历史执行与平台跳过不算本轮通过，选择近似不证明完整新回归
- **AND** 失败、取消或未完成的上次执行不得仅因已有历史数据而被排除；运行器须实际重跑并保留真实失败退出码

#### Scenario: Bun 白名单内受影响测试

- **WHEN** Bun 已有有效测试依赖基线，只有业务源码文件 A 变化，其他输入及环境保持有效
- **THEN** 按原生测试文件依赖图在白名单内选择直接或间接依赖 A 的测试；新增或失效用例仍须实际执行，无法确定边界时回退完整白名单并报告原因；compact 不另设独立清单或全量执行豁免
- **AND** 验收使用真实独立 A／B 源码及对应测试：先建立有效基线，再仅修改 A，观察 A 的依赖测试实际执行且独立 B 测试未执行；不能以修改测试文件、整命令缓存命中或零用例未执行代替依赖选择证明

#### Scenario: 紧凑 TUI 关键回归进入默认范围

- **WHEN** 日常 `test`、`test:ts`、默认 fulltest 或 slowtest 发现 fork 功能测试
- **THEN** 新 compact 的文件型 write／edit 上游原组件显示、两行活动区、隐藏独立模型处理忙碌提示及其必要的模式切换消费者纳入既有普通白名单；不再强制列入旧 Bash 错误预览、工具段投影、stdout 回退或旧混合截图矩阵的指定文件。
- **AND** 现有 clean、detailed、共享布局、输入、恢复、原 diff 及其他 fork 功能的有效测试按原职责保留，纯旧 compact 专属部分删除，不按测试文件名称整块删减。
- **AND** 保留原有有效消费者对流式表格、Composer 布局及历史重建、Web Search 完整答案、压缩期间子代理消息投递和压缩后继续收取结果的业务断言；这些能力不因原测试曾位于旧显示清单而被删除，也不因名称含 compact 把纯压缩算法套件强制纳入显示验证。
- **AND** 使用既有 affected 选择、失败继续、隔离、报告和预算规则，fastcheck 仍不运行测试；不为新 compact 新建独立执行通道或大型替代套件。

#### Scenario: Rust 修改 A 选择受影响 crate

- **WHEN** Rust 源码 A 变化且存在合格基线，cargo-delta 能确定受影响包
- **THEN** 以 Cargo metadata 逆向依赖与 Git 变更分析选出受影响 crate，在 fork 范围内只对交集执行 Nextest；`pi-knowledge` 被选才执行其 doctest。空交集不启动 Cargo，保留正常增量编译缓存；动态或未知输入不能被假定为已完整追踪，仍须适时完整回归

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

### Requirement: 新 compact 的最小必要验证边界

新 compact MUST 复用现有普通测试入口、历史原组件及消费者验证，只为文件型 write／edit 历史原展示、两行活动摘要、六行只读 Output 预览及有限 Bash 自动名称的具体行为缺口增加必要证据，不重建专属测试框架、截图矩阵或全工具组合套件。验收 MUST 区分活动摘要、只读预览与聊天历史，不要求临时区复用完整卡片、Shell 可视化或交互。本需求产物不授予软件验证权限。

#### Scenario: 两项差异具有行为证据

- **WHEN** 后续另获授权实施并验证本变更
- **THEN** 验证文件型 write／edit 历史原组件与上游 detailed 一致，包括目标已明确的参数流、执行中、成功、无变化、失败、取消、部分完成、跨轮历史及文件协议／设备包装；不以改动证明、diff、成功与否或快照字段作为额外显示门槛，没有最近次数淘汰。参数从未知目标转为文件目标时不因提前退休而漏显；消息、配置、进程控制、帮助及非文件设备调用不恢复普通聊天历史卡片，即使结果包含文件差异字段也不伪装成文件操作；其他工具不增加文件监控或合成 diff。
- **AND** 验证两行活动区的思考优先、最近两次实际派发调用（包含已返回）各占一行、意图优先及原始命令回退、不按同名去重、参数／输出／返回更新不改派发顺序、摘要内部不显示工具输出、固定占用，以及结束／取消／跨轮静态保留、逻辑会话快照隔离与思考显隐；保留工具行直接从工具名开始，不显示“上次活动 ·”前缀或替代历史标题，保留思考仍沿用原标识。取消本轮不作为工具已取消的证据，已返回及历史保留工具行不继续动画或计时；文件型 write／edit 历史原组件独立保留，非文件目标及其他普通工具和错误卡片不在聊天历史恢复。
- **AND** 验证工具行末耗时按每次调用独立计算，运行期间无输出及关闭颜色动画时仍递增，实际返回后冻结；轮次取消不伪造结束，后台继续工作不延长已返回调用的耗时，静态历史不递增，视图切回不重新起算，长命令下仍保持单行和有效宽度。
- **AND** 活跃思考的可观察配色为灰色基底与主题绿色扫光，而非彩虹或整段固定绿色；复用现有动画开关，历史保留内容静态，工具行配色、耗时与布局不因本次思考配色变更而变化，ANSI 与 native 采用一致的思考配色语义。
- **AND** 优先复用既有 ANSI／native、模式切换和真实入口设施，只针对消费者可观察缺陷验证，不检查源文本、内部接线、默认常量或快照长度增长。

#### Scenario: 最小上游差异与执行授权

- **WHEN** 选择验证范围或清理旧测试
- **THEN** 不因实现简化重建上游行为、重跑无关矩阵、补齐测试类别或扩大门禁；相关输入未变且已有有效证据足够时复用原结果。
- **AND** 非显示门禁的预算、失败继续、Git 版本记录、平台与独立授权要求保持不变；新增需求产物本身不授予构建、测试、真实模型、发布或部署权限。
- **AND** 仅因旧断言禁止任何普通工具正文而与只读 Output 临时区冲突时，应调整相应消费者契约，不保留互相矛盾的断言；仍保护 clean、detailed、历史隐藏、文件组件、两行摘要、输入及共享布局的有效断言继续保留。

#### Scenario: 六行只读 Output 的实时显示与稳定布局

- **WHEN** 后续另获授权验证只读输出预览的实际消费者行为
- **THEN** 证据 MUST 证明正常空间下总高固定 6 行，恰由 1 行真实工具信息及单行命令／目标、5 行最新 Output 组成；不另加标题或边框行，不显示参数区、Shell 结构、图片或交互控件。无 Output 或到期关闭时占 0 行，原活动摘要和输入区保持独立。
- **AND** 验证按派发顺序选最近已有非空 Output 的调用：B 无输出时保留 A 及其真实身份，B 首次有输出才切换，之后 A 迟到不能抢占 B；空白、参数和非文本帧不冒充 Output，同名调用不合并，不按缓存更新顺序恢复来源。
- **AND** 对每秒输出、持续 25 秒的有限异步 Bash，证明未被较新 Output 替换时预览在命令运行期间更新，启动返回或 loop 结束不提前关闭，不依赖模型读取 `proc://`、调用 wait 或重复查询驱动；前台及自动转后台仅补齐实际不同的路径缺口，不为同一路径重复排列输入。
- **AND** 验证累计输出快照替换而非重复追加，按可用宽度排版后过滤空行和纯空白显示行，再保留最近五个有文字的显示行；不足时补空位保持六行预算，控制字符及宽字符不溢出，不改写原始 Output。read 只预览所选调用自身 Output，不搬聚合组件；`out://` 正文不被抽取、移走、重复或随预览关闭删除。
- **AND** 来源切换和输出增长不改变显示期间高度或焦点，低高度终端优先保证输入和实际交互可达；预览不复用完整卡片，不在两处挂载同一原组件，也不接管原卡片的焦点、按键、图形或详情生命周期。
- **AND** 收起只要求预览自身占用归零、无专属错误占位；允许既有 Complete Scrollback 的正常空间补偿空白，不通过重放、复制或回填历史消除合法空白，历史结果和文件原组件保持。

#### Scenario: 运行保留、停止后计时与恢复不倒退

- **WHEN** 后续另获授权验证自动收起和会话恢复
- **THEN** 证据 MUST 证明复用状态栏运行判定，运行期间不因工具已终态而收起；状态栏停止且来源整体终态均已发生后，从较晚时刻起计时 3 秒，不等待可见绘制。切换视图、档位、全屏覆盖、输出更新及重建不暂停或重置期限；空闲时终态可在尚未看到时到期，切回不重新给三秒。
- **AND** 覆盖 B 仅派发无输出时不替换 A，运行期间保留 A，停止后按适用期限收起；B 输出被选中后 A 旧关闭动作不能关闭 B。允许新来源提前替换，不要求每个结果都完整展示三秒；空闲到期后不回退到更早仍运行的来源，也不被旧输出或重复终态重新打开。
- **AND** 验证有限异步调用返回 running 不算整体终态；终态先于启动回执且马上重建／跨线程重新聚焦时不恢复 running、不丢失原期限；多 job task 不按 primary job 单独结束关闭，最后排队项取消且无后续输出时仍能按已有权威结算关闭。
- **AND** 会话／代理视图／档位切换和相同 call ID 不串线，旧输出和旧关闭动作不能影响新视图；ANSI 与 native 的文本、六行预算、来源选择和关闭规则一致。真实 Windows／ConPTY 与虚拟终端或描述层证据分别标明，不能相互冒充。
- **AND** 预览关闭不删除原结果、助手正文、文件历史或独立诊断，不影响审批、问答、取消和既有全文入口；没有中间帧的工具不伪造实时 Output，service 与交互 PTY 不因预览新增日志轮询或复制链。

#### Scenario: 自动名称不改变有限任务语义

- **WHEN** 后续另获授权验证有限 Bash 自动命名
- **THEN** 证据 MUST 覆盖显式异步与自动转后台的名称可见、一致且稳定，同命令多任务可区分，原 ID 与 owner 不变，快速前台完成不新增可见后台项。
- **AND** 通过实际取消、完成／失败、退出码、输出读取及结果投递证明 job 生命周期仍有效；命名不会切换到 service、改变普通 timeout、绕过已有设置或审批，也不替换同名服务。
- **AND** 保留显式 Bash service `name` 及其与 `async`、`timeout`、`pty`、`ready` 组合的原有契约；名称不是新的 `proc://` 别名，既有 owner 隔离、任务身份与适用管道流降级仍成立。
- **AND** 用例只补齐本次可观察的具体缺口，复用既有任务与工具消费者覆盖，不为名称字段复制、内部转发或静态配置本身新增测试。
