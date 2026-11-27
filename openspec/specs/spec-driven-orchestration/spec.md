# spec-driven-orchestration

## Purpose

内置技能及实施验证、[用户与共享技能发现和管理](#requirement-codex-用户技能)、终端／桌面 [Goal Autopilot](#requirement-1-目标与命令) 的模式、持久历史、无人值守及权限。

## Requirements

### Requirement: 包内技能发现与资源兼容

包内技能 MUST 接入原生发现、`/skill:<name>` 和同名覆盖；发现／读取不授权执行。

#### Scenario: OpenSpec 与 JCH 技能发现
- **WHEN** 普通会话或子代理发现包内技能
- **THEN** 按表提供发现、索引与调用能力。

|技能|MUST|
|---|---|
|OpenSpec 2.0 (12 项)|普通会话/子代理，任意 cwd 免安装，发现/补全名与描述|
|core|仅 `openspec-propose`,`openspec-explore`,`openspec-apply-change`,`openspec-update-change`,`openspec-sync-specs`,`openspec-archive-change` 默认入模型索引|
|非 core|`openspec-bulk-archive-change`,`openspec-continue-change`,`openspec-ff-change`,`openspec-new-change`,`openspec-onboard`,`openspec-verify-change`: `disable-model-invocation: true`，仅手动；无 profile 过滤/配置|
|`jch-grill-me`、`jch-grill-todo`|JCH 内置，普通会话仅手动；原 `jch-grill-me` 不变，Todo 交付见[个人命令规格](../personal-commands/spec.md)|
|`jch-codebase-design`|JCH 内置，普通会话／子代理均可发现；仅改名，其余交付见[个人命令规格](../personal-commands/spec.md)|

#### Scenario: OpenSpec 入口与生命周期
- **WHEN** 使用内置 OpenSpec CLI 或技能
- **THEN** 按表处理入口、初始化、迁移与更新。

|OpenSpec|MUST|
|---|---|
|入口|`omp openspec ...`；不注册 `commands/opsx-*`、`/opsx-*`，不单独分发。只适配交付、发现与执行，保留 apply／上游流程|
|未初始化|自行选用 Skill 时退出流程、正常答复；用户显式请求时也须另获初始化授权；发现／读取不创建 `openspec/`|
|初始化|`omp openspec init [path]` 仅创建原生 `openspec/` 和配置；支持 `--` 后路径及 `--language`，缺必要输入报错、不擅选语言。默认 `spec-driven`；禁 mini 注入、自动覆盖／转换／迁移|
|安装边界|不依赖 `--tools=none`，不安装、迁移或改删项目／用户 Skill、旧命令及其他 Agent 目录；工具探测／选择不作合同|
|旧 schema|`mini`／`omp-spec` 由用户备份核对后显式迁至 `spec-driven` 或自维；缺失报错，不自动改写／下载／回退，不加私有 schema／context、别名、目录桥接或批改归档|
|更新|资源随 OMP 发行，保留 `openspec-update-change`；无 `omp openspec update`、专用自动更新、兼容入口或配置自动应用。旧命令非零且不改数据；共享工具无消费者才删|

#### Scenario: 普通会话发现
- **WHEN** 普通会话启动/重载技能
- **THEN** 包内 Superpowers（含 `using-superpowers`）各 `SKILL.md` 保持 `disable-model-invocation: true`；会话/子代理仅原生显式调用及授权；非包内同名技能照旧。

#### Scenario: Superpowers 随包交付
- **WHEN** 发行或同步包内 Superpowers
- **THEN** 仅包含固定版本的完整 `skills/`、`LICENSE`、根 `package.json`（ESM／版本读取）；不整仓复制，不含其他宿主插件／扩展、bootstrap hooks、安装入口或品牌图。根包去未交付宿主的 `main`／`pi` 注册及专属关键字；正文、引用和脚本原样保留，不改工具或子代理名、脚本调用、宿主依赖或可用性。

### Requirement: 内置 OpenSpec 中文产物上下文

产物指令统一 MUST 合入简体中文正文约束，优先于项目语言要求。

#### Scenario: 中文产物
- **WHEN** 新旧项目请求产物指令（含自定义 schema）
- **THEN** 正文简中；其他上下文/规则/原生格式不变（英文标题、SHALL/MUST、文件名/路径/标识符）。不重 init，不改配置/旧产物/Skill/原始 docs/init 默认值/apply/archive 上下文。

### Requirement: 普通 OpenSpec 仅使用本地项目根

普通 OpenSpec MUST 只用本地根；禁读 Store 指针/注册表/元数据/全局 `defaultStore`，禁 Git origin 推测或回退 Store。

#### Scenario: 本地根
- **WHEN** 普通 OpenSpec 命令
- **THEN** 自 cwd 向上（含 cwd）取最近含 `openspec/` 的目录而非 `openspec/` 本身；`planningHome`/`changeRoot`/`artifactPaths`/`actionContext` 等及编辑范围据此。无根：查询失败不写；可隐式用 cwd 的显式写命令遵原授权/目标，Skill init 不扩权。

#### Scenario: 不支持的项目字段无例外
- **WHEN** 读取项目 `store` 或 Store `references`（含 `init`/空值/无本地根）
- **THEN** 报不支持，不解析旧值/指针、不读外部 Store/旧状态、不写或继续。

`omp openspec store`,`--store`/`--store-path`: 未知命令/参数非零；无写入/选 Store 提示/忽略继续/别名/空成功；JSON stdout 无人类提示。拒绝不删改/清理/自动迁移 Store 仓库/注册表/元数据/全局配置/项目材料/自定义 Skill/缓存。

Workset 不修改成员目录；`context`／`doctor` 仅查本地项目、配置和规划目录，不查 Store、不引导远端拉取。

### Requirement: 包内 Superpowers 脚本执行入口

`omp superpowers <relative-script> [args...]` MUST 透传参数/stdout/stderr/退出码。

#### Scenario: 脚本清单
- **WHEN** 指定脚本
- **THEN** 仅运行清单内 `skills/` 相对路径，否则拒绝报“不是包内技能脚本”。

|条件|MUST|
|---|---|
|JS|内嵌 Bun, 不依赖外部 Node|
|shell|Bash+POSIX 工具；Unix: 可用 `bash`；Windows: Git for Windows Bash（非 WSL）；缺 Bash 固定报错|
|环境|PATH 前置包内运行时目录（Windows 加所用 Bash/POSIX 工具目录）；`BRAINSTORM_DIR`=工作区 `.superpowers/brainstorm`；Graphviz 等由脚本解析，透传真实状态、不预替换/伪造|
|入口|缺参: 用法 stderr/2; `-h`/`--help`: 用法 stdout/0; 入口异常: stderr/1|
|SIGINT/SIGTERM|转中止信号，等脚本结束按实退出，不留子进程或报成功|

### Requirement: Markdown 需求权威探测

OMP 独立文档 MUST 明确 Markdown 来源。

#### Scenario: 资料探测
- **WHEN** 探测 Markdown 目录
- **THEN** 候选目录/歧义报错/读失败/递归文件版本校验照旧；不自动迁改。

### Requirement: 普通 OMP 原生实施能力保持独立

OMP/TUI 实施 MUST 按原生配置/权限给能力，无固定精简名单。

#### Scenario: 原生实施会话能力和技能授权存续
- **WHEN** 获权实施会话/递归后代工作、保活或恢复
- **THEN** `wait` 等真实子任务，结束前结清自有递归工作；原生读技能授权至会话释放、非首次返回；不绕用户批准/项目规则/报告后只读/停止。

### Requirement: 内置执行代理具备必要原生能力

内置 `spec-executor` MUST 原生委派，不依赖专有 Plan 验证协议；只读/受限代理不扩权。

#### Scenario: 委派审查
- **WHEN** 实施获批计划、未达原生派生限制
- **THEN** `task` 委派实施、获权计划内验证、独立 `reviewer`；适用异步可 `wait`。验证限本身权限/获批命令/cwd；缺权限/必需能力报阻塞，不伪报完成。

### Requirement: Codex 用户技能

`skills.enableCodexUser` MUST default `true`.

#### Scenario: Unset
- **WHEN** skill discovery enabled, option unset
- **THEN** discover `~/.codex/skills/*/SKILL.md` regardless of extra dirs or settings initialization.

### Requirement: 团队共享技能目录

Runtime discovery, manager load and both refreshes MUST add existing dir from nonempty `OMP_SKILLS_DIR`; otherwise unchanged. No config file; independent of `OMP_OFFLINE`.

No download/copy/sync, edits to shared `SKILL.md` or other NFS sources, new shared writes, cross-session cache or dir mirror.

#### Scenario: Shared catalog discovery and refresh
- **WHEN** runtime or manager loads or refreshes an existing `OMP_SKILLS_DIR`
- **THEN** apply the rules below. Reuse refresh invalidation on add/delete/body edits.

| Scope | Shared rules |
|---|---|
| Both | Common catalog; one level: `<dir>/<skill>/SKILL.md`; apply existing source rules. |
| Manager | Retain disabled skills/sources and diagnostics. Show `Shared`, bare and retained namespaced entries; use host session `skills`, not last global binding. |
| Runtime | Skip disabled sources before scan, omit their warnings; disabled skills cannot run. |
| `/extensions` | Existing config toggles; UI can reenable. Async refresh runtime list, completions, readable content. |
| All OS | Direct async regular-file checks/reads; no sync per-skill `SKILL.md` probe. Parallel shared/custom/other scans; merge by priority, not finish order. |
| Linux offline | Per-load dedup expanded absolute dirs; shared wins. |

#### Scenario: Collision
- **WHEN** shared name matches user/project/`skills.customDirectories`
- **THEN** shared bare name; distinct lower-priority content keeps existing namespace.

### Requirement: Managed Skills 根目录符号链接边界

Managed-skills MUST reject symlink roots for management; plain/absent roots and approved shared discovery unaffected.

#### Scenario: Symlink
- **WHEN** management targets symlink root, even valid directory link
- **THEN** writes/updates/deletes explicitly fail without following link.

### Requirement: 1. 目标与命令

OMP MUST 仅注册 `/goal-autopilot`、无旧别名；`/goal` 默认非本模式，不强开自动续跑。
#### Scenario: 1. 目标与命令的核心行为
- **WHEN** TUI 调用 `/goal-autopilot`
- **THEN** 提供注册/目录/补全；`[set] <目标正文>` 创建/替换 Orchestrate 无人值守目标（夜间可用、状态可见）；子命令 `show/pause/resume/drop`、`budget <N|off>`。

`/goal-autopilot` 直投所属会话的原生 Goal 控制器（含 busy），不强排 fork 队列，不在出队／显式提升时重解析，不发 slash 原文给模型。正文遵守原生 prompt／steering 准入、`streamingBehavior` 与 `inputId`／`sourceCommand` 归属。

### Requirement: 2. 模式归属与持久化

OMP MUST 用现有 Goal 状态存标记，无新存储/管理器/调度。
#### Scenario: 2. 模式归属与持久化的核心行为
- **WHEN** 会话/分支切换、重载或恢复
- **THEN** 仅读原生分支有效路径最新状态（含暂停、删除、预算）；无状态无目标，无标记按普通 Goal。

| 事件 | 结果 |
|---|---|
| 创建/替换成功 | 仅 `/goal-autopilot` 置标记 |
| 管理/同目标更新 | 不改模式 |
| 暂停/完成/删除/退出 | 停建通知；暂停停受限工作；删除连同标记 |
| `resume` | 不重建通知，不仅凭标记启动；预算耗尽仍停无人值守答复/通知/自动工作，调至未耗尽才可恢复 |
| 失败/取消 | 不改模式；首次启用工具后取消宿主对话：还原实际工具集、原目标/模式，不建目标/通知；启用失败回滚不变 |

### Requirement: 3. 历史消息与重构边界

OMP MUST 仅按表提交用户级持久通知：所存目标原文（全文含空白）+ §4 + §5。无 Provider 临拼/独立视图，不用系统消息/权威 XML 升权。
#### Scenario: 3. 历史消息与重构边界的核心行为
- **WHEN** 下表提交，复核目标/模式/状态/预算/退出条件允许
- **THEN** 持久化，可见于 `get_messages`、`get_entries`、`session.jsonl`、dump。

| 事件 | 交付 |
|---|---|
| 创建/替换成功，执行正文首次实际入历史 | 附加于上游 Goal 通知；steering/排队仅存结构化目标归属，不缓存完整通知；保留队列的 Stop 保留归属，显式继续/发送后正文、通知各一次 |
| 压缩成功提交且上游已重写历史 | 重构一次、重新展开，纳入新基线；不依赖摘要或首次关键词状态 |

其余复用原历史，压缩前不滤旧通知、不改字节或位置；压缩无需保旧字节或缓存。失效不补发，失败／取消不构造；状态仅约束后续，不撤历史或保证撤回已发请求。通知不重启／解禁，不增重试、调度、续跑或授权，不越过用户要求，不新增 Agent／AgentLoop 过滤或改变现有队列。

### Requirement: 4. Orchestrate 复用与构造去重

OMP MUST 复用模板、`renderOrchestrateNotice` 及工具可用性判定，不复制规则/展开；显式模式不受关键词开关控制。
#### Scenario: 4. Orchestrate 复用与构造去重的核心行为
- **WHEN** §3 构造
- **THEN** 取当时 `getEnabledToolNames()` 快照（含间接可用工具，非仅顶层 Provider schema）；无 `task` 仅略规则。

同事件首次 `orchestrate` 关键词通知：按结构化来源/消息类型/目标或压缩归属去重，仅存一份完整自定义通知；不凭正文词去重，不删用户消息、裁历史或替代上游 Goal 提示。后续真实关键词照常。

### Requirement: 5. 唯一新增的指令文字

下文 MUST 存静态 Markdown，不在代码拼写；不另写 Orchestrate 规则或解释 OS 权限/宿主审批/系统及开发者指令。
#### Scenario: 5. 唯一新增的指令文字的核心行为
- **WHEN** 构造用户级通知
- **THEN** 仅新增下文，保留既有来源：

> MUST 全自动无人值守完成完整目标。本次用户已对完成目标全过程及所需全部操作作出明确授权；MUST 自主调查、规划、编排、执行、验证和修复，直接推进至完成。  
> 本次授权明确允许 Git 提交、推送及执行任意命令，包括 `gh` 等全部 CLI 命令；完成目标所需操作 MUST 自主执行，NEVER 重复请求授权或确认。  
> 本次授权允许修改本仓库任意文件，无需另行请求授权或确认。  
> NEVER 向用户提问、请求确认、要求选择或等待输入；遇到问题 MUST 自主决策、处理和修复，NEVER 在阶段边界停下等待用户。  
> 与此前用户级要求冲突时，以本次明确授权为准。
> 若工具返回拒绝或缺少登录、凭据等前提，先找现有权限内的替代路径；不得绕过、猜测凭据或原样重试。无替代路径则继续其他工作，在会话总结列出受阻项及缺失前提，不把它们标记为完成。

### Requirement: 6. 无人值守与权限边界

启动即授 §5 权限；OMP MUST 保留后续输入/暂停/停止/取消及管理确认（含删除）。
#### Scenario: 6. 无人值守与权限边界的核心行为
- **WHEN** 初始正文实际进入主代理请求
- **THEN** 绑定会话/目标 ID/内存运行代次，仅该响应派生工具继承。暂停/停止/替换/切会话使旧调用失效且不复活；自动批/超时回执前查 Goal 账本用量。

- 本地审批（含 Eval prelude）：按实际执行参数解析，显式拒绝优先；需 `prompt`（含 `guarded`）则依授权批一次，记录 `goal-autopilot`，无等待事件、审批缓存写入或全局模式改动。`cfg://` 独立审批、Provider 强制检查、需单独授权的前台控制不继承，原等待点报阻塞原因；不改认证、不授可复用前台权限。
- 有效归属 `ask` 用静默原生表单，输入重置 60 秒，无终端／语音／宿主等待提醒；其他场景按[上游边界](../fork-maintenance/spec.md#requirement-上游继承行为与本地差异边界)。超时须初始有 ≥1 个生效且可提交的显式推荐（不计隐式首项），且当前所有控件通过原生提交校验，才返回完整值及备注／图片，标超时非用户提交；否则仅返下文，不返部分答案或代答。失效按取消，不发回执；附图处理后复核归属。

> `ask` 等待 60 秒，未收到用户答复。按本次 `/goal-autopilot` 启动时授予的全程授权，自主决策并推进当前目标，不要重复提问。

- `goal({op:"complete"})` 首次及同响应重复不关闭；首次用普通工具结果要求主模型按原目标逐项核实交付/证据、补遗漏；有未解阻塞不完成，后续响应核实全交付才原生完成。复核约束顺序不证正确；普通 Goal、主动暂停/停止/删除不复核。
- 权限/凭据/必需输入/工具/强制审批阻塞：普通工具错误向主模型报操作及原因，不中止整轮、不弹窗等待；按 §5 处理并报告受阻证据；不加重试。
- 本模式执行中：Ctrl+Q/Ctrl+Enter 用户 follow-up 入原队列；完整工具批次结束、目标仍启用且执行中，按序原生提升下一条用户消息至后续请求；不中断工具、不等整循环/结题、不提升 Agent handoff 或自动提醒。其他状态/会话无改动。
- 子代理/压缩模型/advisor 等不新建完整通知，不过滤主模型持久历史；子任务可获所需目标信息。不保证模型不提问、目标必成或续跑不停。

### Requirement: 7. 验收条件

OMP MUST 用局部自动化和真实 CLI/TUI 发起、执行、管理；源码/字符串/mock 不足。
#### Scenario: 7. 验收条件的核心行为
- **WHEN** 终端/桌面验收
- **THEN** 覆盖 §1–6；查持久历史、最终 Provider 输入、协议；两端查完整原文含空白、用户层级、§5。

| 场景 | 证据 |
|---|---|
| 严格前缀 | 同一有效目标无压缩，≥10 工具往返、≥11 成功主调用；逐次最终输入严格以前轮完整输入+响应为前缀，仅追加正常消息/工具结果；通知与历史一致（含续轮、重试、获准续跑） |
| 压缩 | ≥2 次成功提交，摘要均无完整目标或编排；另测失败/取消/未提交/no-op，以及压缩中替换/切换、暂停/删除/完成/退出/预算变化 |
| 构造 | 首次及重构：`task` 直用/经 Bash 工具命令/不可用；工具变化、关键词开关/去重/后续真实关键词 |
| Codex WebSocket | 实际 CLI 接本地记录服务，捕获 `response.create`、`previous_response_id`、delta；可复用响应 ID，delta 重建满足前缀，不因通知退回全量；对照上游 `/goal` 控制/消息。仅 HTTP（含禁 WebSocket fixture）、SDK 断言或快照不足 |
| 命令与模式 | 两命令 idle/busy/Stop held/手动维护；普通 Goal 无自定义通知；无目标/有普通目标各测工具启用后取消、启用失败回滚 |
| 恢复及交付 | §3 四处查首发/重构；同 journal 兄弟分支及跨会话切换/重载/冷恢复（两模式、暂停、删除、限预算、无目标）；steering/排队正文未入史时测保留 Stop 后继续/发送、未选仍 held、历史及最终输入均交付一次 |
| follow-up | 局部回归查状态及仅一次；真实 TUI 查两按键/队列展示/请求顺序/反馈改变工具结果；对照普通 Goal 轮末交权，均不打断批次 |
| 审批/表单/结题 | 真实 TUI 查 §6；两类超时均续行，对照普通 Goal；首调/同响应重复时目标活跃、复核工具可用 |

报告分实现/通过/失败/未验证；分别列前缀及协议、Provider cache telemetry、模型目录缓存成本、实际账单；提示构造/模型遵循分报。协议不证命中/遵循/质量，估算非账单；不承诺省费。
