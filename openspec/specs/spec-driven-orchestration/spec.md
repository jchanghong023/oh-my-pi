# spec-driven-orchestration

## Purpose

OpenSpec 随包交付、其他内置技能、[用户技能发现和管理](#requirement-codex-用户技能)、终端／桌面 [Goal Autopilot](#requirement-1-目标与命令) 的模式、持久历史、无人值守及权限。

## Requirements

### Requirement: 包内技能发现与资源兼容

包内技能 MUST 接入原生发现、`/skill:<name>` 和同名覆盖；发现／读取不授权执行。

#### Scenario: 使用内置 OpenSpec

- **WHEN** 用户在本地项目使用 OpenSpec
- **THEN** 通过 `omp openspec ...` 和内置 `openspec-*` 技能使用上游工作流，无需另装 OpenSpec 或 Node.js。OMP 只负责随包交付及接入，不另定义产物、schema 或工作流。
- **AND** 仅在用户明确授权后初始化项目；发现或读取技能不得创建 `openspec/`。
- **AND** 未指定产物语言时，正文默认使用简体中文；显式语言设置优先。保留上游标题、文件名和结构化标识。

#### Scenario: 发现 JCH 技能

- **WHEN** 会话发现包内 JCH 技能
- **THEN** `jch-grill-me`、`jch-grill-todo` 在普通会话仅手动调用；`jch-codebase-design` 在普通会话及子代理均可发现。交付见[个人命令规格](../personal-commands/spec.md)。

#### Scenario: 使用内置 Superpowers

- **WHEN** 会话或子代理使用包内 Superpowers
- **THEN** 固定版本随包交付，包内技能仅可显式调用；非包内同名技能照旧。

### Requirement: 包内 Superpowers 脚本执行入口

`omp superpowers <relative-script> [args...]` MUST 仅运行包内清单列出的脚本，并透传参数、标准输出、标准错误和退出码。

#### Scenario: 执行或取消包内脚本

- **WHEN** 用户调用或中止脚本
- **THEN** JS 使用内置 Bun；Shell 使用 Bash，Windows 使用 Git for Windows Bash（不使用 WSL）。缺少 Bash 或路径不在清单时明确报错；中止须传递给脚本，不遗留子进程。

### Requirement: Codex 用户技能

`skills.enableCodexUser` MUST default `true`.

#### Scenario: Unset
- **WHEN** skill discovery enabled, option unset
- **THEN** discover `~/.codex/skills/*/SKILL.md` regardless of extra dirs or settings initialization.

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
