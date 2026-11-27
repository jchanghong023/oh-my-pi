# fork-maintenance

## Purpose

Fork 维护协议及[验证门禁](#requirement-按风险选择验证和报告证据)；验证独立于构建和发布。

## Requirements

### Requirement: Fork 维护责任和需求权威

`jchanghong023/oh-my-pi` 由 AI Agent 实现/维护；MUST 自动可复验，不靠用户读代码或人工回归。[已批准规格](../)唯一基线；[变更](../../changes/)仅未批准提案/增量。

#### Scenario: 修改功能或需求

- **WHEN** 开发或维护 fork
- **THEN** 按域读规格和待定变更，跨域循链接；[用户授权](../../../AGENTS.md#fork-requirements-and-additional-runbooks)才写文档。需求变才改规格，未实现不删；现行规则仅一处。规格只记 fork 独有需求，不复写上游、不记历史、不重复。`AGENTS.md` 仅必读，内网指南仅改受影响用法。
- 根 `AGENTS.md` 登记全部有效子级规则；子级只写所在目录的差异，不重复全局规则。高频跟上游，优先复用文件/链路，集中差异；禁避冲突另写、推测性抽象、兼容层、无关重构。
- 日常 Windows x64 PowerShell；另支持 Linux x64、Ubuntu-24.04 WSL2。仓库固定工具链不单升；用上游测试脚本。

### Requirement: 上游同步与基线

同步 MUST 保全本地改动、fork 功能及 `openspec/`；做不到即中止，不重置整仓或弃无关改动。

#### Scenario: 确定同步来源和保护工作区

- **WHEN** 同步上游
- **THEN** MUST 仅合 `https://github.com/can1357/oh-my-pi.git` 的 `refs/heads/main` HEAD 至本地 `main`；禁 tag/Release/其他分支/远端跟踪引用/上游改史。`origin` 有效 fetch/push 均须 `jchanghong023/oh-my-pi`。
- 用 `main:openspec/specs/fork-upstream-baseline/spec.md` 验证[当前基线](../fork-upstream-baseline/spec.md)。
- 常规同步只做 staged Git 检查和必要的语义审查；必要时运行一次 `bun run check:tools`，缺依赖仅用 `bun install --frozen-lockfile --ignore-scripts`。首败只修本次问题、复验失败项一次；再败中止、不提交。常规同步不编译、不做类型检查、测试、UI／浏览器验证、Docker、基准、打包、发布或 Rust／native 检查构建。
- 冲突若需重建行为，必要 UT 和真实入口 E2E 须另获验证授权；未获授权就中止并报告未验证，不称同步完成。同步授权本身不包含这些验证。
- 授权含必要本地提交，不含 push（分支/标签）；可用工具 MUST 执行普通 Git 写命令，无需受限脚本会话。提交 `sync(upstream): merge main@<目标前12位>`；命令级禁 hooks/签名，不改全局。
- 成功更新基线；保留根 `AGENTS.md` 的 fork 引用与内网快启。上游已等价提供时移除本地规格和差异，不增第二清单。

### Requirement: Fork 文档维护

根 README MUST 原样跟进已集成上游，不加 fork 安装段或自译。

#### Scenario: 更新上游 README

- **WHEN** 维护/审查文档
- **THEN** `docs-zh-CN/` 仅[内网快启](../../../docs-zh-CN/quick-start-intranet.md)；工程笔记与验证证据不作需求。只审 fork 文档。

### Requirement: Git 钩子

Fork MUST 禁用 Git 钩子及其自动安装。

#### Scenario: Git 钩子的详细边界

- **WHEN** 安装、开发或同步
- **THEN** 在当前仓库用 `git config --local core.hooksPath /dev/null` 停用钩子；不删除已有钩子、不改全局。提交或推送不自动检查或跟踪，验证须显式授权。

### Requirement: 上游继承行为与本地差异边界

MUST 沿用上游，保留已批准差异；不恢复下列本地特例。

#### Scenario: 维护上游继承能力

- **WHEN** 维护继承能力
- **THEN** 仅保留 fork 差异；RPC／RPC UI 及公开协议沿用上游。
  - `ask` 沿用上游 HTML 表单与宿主协议；仅活跃且绑定主代理请求的 [`/goal-autopilot`](../spec-driven-orchestration/spec.md#requirement-6-无人值守与权限边界) 可静默超时。普通默认值/取消、Plan 无超时均不变。

### Requirement: 按风险选择验证和报告证据

MUST 最小充分验证、实报。

#### Scenario: 选测与失败
- **WHEN** 验证
- **THEN** 按风险：UT 局部，集成/E2E 真实跨模块/公开入口；断言规格成功/关键失败；静态/编译/模拟≠实测。纯文档只查内容/差异/链接。公开入口默认仓库根；缺先决条件照报，禁自装。失败/缺项/漏测比上游；同败只报，除非用户要求修或真实入口证实核心缺陷。

### Requirement: 临时 TUI 交互验证

MUST 隔离，禁跨产物代验。

#### Scenario: 验证 TUI 交互
- **WHEN** 临时验 TUI
- **THEN** 源码用 `bun run dev` + `tui-test`；明确验证 exe 或包时，才使用确认过的当前产物绝对路径。隔离自有会话，显式设工作目录和终端尺寸；断言业务结果并查命令及进程退出，`wait idle` 不代验。只关闭自有会话，不自写 PTY／ANSI 驱动绕过缺工具。
  - 需模型：隔离配置、本地模拟；发消息前核实际模型/请求目标；失败报阻塞，禁回退真实模型；模拟不证真实模型能力/提供者认证。

### Requirement: 使用上游验证入口

MUST 复用上游/显式局部入口；禁新入口、兼容别名、fork 白名单、Git 测试基线、报告包装器。

#### Scenario: 入口与消费者
- **WHEN** 静态/自动化测试
- **THEN** 优先 `bun test <路径>`，扩测沿用[仓库脚本](../../../package.json)。保留下列 fork 约束：
  - Rust 不因生成输入或跨语言依赖一概跳过；沿用上游判定／Windows MSVC 发现，只用 `OMP_FORCE_RUST_TASKS=1` 强制，不增模式。
  - `test:ts`、`test` 的本地组含 `stats`；`.test.ts`／`.test.tsx` 共组。CI 套件不代 SDK、安装或桌面验收。
  - `test:py` 的 Python SDK 跨平台、RoboOMP 常测仅 Linux；`robomp:test:integration` 须显式授权，Linux 有 Python 依赖及 PATH 上的 `omp`。Go/Rust SDK 走局部原生入口；依赖 POSIX `sh`／进程语义的用例用 Linux，不因 Windows 失败排除跨平台或 Windows 用例。
  - 父仓静态检查／测试排除 `vendor/openwiki`；内置框架只交付实现／资源，父仓不设框架专项、宿主集成或通测生成用例。
  - 复用上游发现与原生套件，功能脚本可显式 `bun test`。只验受影响消费者的可观察合同／回归，不验静态文件、配置形状、打包计划或发行产物的内部细节；保留必要构建发行校验。
  - Agent/MCP/TUI 隔离配置、凭据、会话、端口及工作区，不读真实用户配置；Windows Chromium 另隔离 `USERPROFILE`、`APPDATA`、`LOCALAPPDATA` 与浏览器数据目录。MCP 不增真实连接／授权验收。
  - 源码 `ci:test:smoke` 与产物 `ci:test:install-methods` 不互代。普通 CLI、取消／输入／焦点／退出用[真实 PTY](#scenario-验证-tui-交互)；敏感启动禁仅凭进程启动、虚拟终端或模拟。

#### Scenario: 验证授权与证据独立
- **WHEN** 扩测/记证据
- **THEN** 整套/高成本须用户本次明确授权，禁拆跑绕过；留就绪工具/有效构建缓存，禁无故 `cargo clean`/删 `target/`、缓存通过。
  - 本地禁自动：启动 WSL、同步源码、commit/push、触发/等待 CI、发布/部署、Computer Use、共享鼠标/抢前台焦点。`ci:test:*` 仅显式且不入 fork 构建发布。
  - 独立 SDK/安装产物/公司实机/真实 Forge 依各自授权/环境；真实模型/提供者认证/真实桌面输入各须另行明确授权及对应环境。未授权桌面输入记 `NOT_RUN_SEPARATE_USER_INSTRUCTION_REQUIRED`；隔离浏览器 DOM/协议、虚拟终端、PTY 自动化非共享桌面输入。
  - 实报命令/平台/范围/跳过/原生选测/原始退出；分实现/通过/失败/未验；不适用非通过，缓存非新跑；局部/分片≠整套，源码≠产物，平台不互代。

### Requirement: compact 的最小必要验证边界

MUST 复用入口验[显示](../personal-commands/spec.md#scenario-clean-与-compact-的显示差异)/[只读 Output](../personal-commands/spec.md#requirement-紧凑模式的最近工具只读输出预览)消费者，不另建框架。

#### Scenario: compact 证据
- **WHEN** 验 compact 活动区/Output/Diff/历史交互
- **THEN** 沿用[真实入口验证](#scenario-验证-tui-交互)，只验受影响的不同消费者路径（如 ANSI／native、模式切换或前后台），不扩展截图、全工具或无关矩阵。证据沿用[通用规则](#scenario-验证授权与证据独立)分别报告实测平台、虚拟终端和未验范围；输入未变且证据仍充分时可复用。
