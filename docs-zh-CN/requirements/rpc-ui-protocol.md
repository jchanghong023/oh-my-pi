# rpc-ui 协议扩展与 RPC 项目运行服务（统一需求）

> **状态（2026-09-29 合并版）**：本文件由《rpc-ui 桌面应用协议扩展》与《OMP RPC 扩展与 ZCode 核心能力接入：顶层设计方案 v1.0（2026-09-29）》合并而成，是 `omp --mode rpc-ui` 协议与服务端能力、以及把 RPC 入口升级为项目运行服务的**唯一权威需求**。两文冲突处以顶层设计（本文件 §9–§16）为准；已实现项的回退与迁移处置固定在 §17。
>
> * **P0（已实现，兼容基线）**：协议协商 v3、工具权限审批、富 ask、会话列表第一版、单会话生命周期（4.0–4.4），各项按原标注的验证状态保留。
> * **P1（本期必须实现）**：两部分——(a) 已实现子项维持（5.1–5.8，其中技能开关命令按 §17 迁移）；(b) **顶层设计全部需求（§9–§16）定为 P1**：每项目单进程多会话共存、技能管理闭环、命令与补全统一服务、ZCode 桌面接入验证（阶段 A–E，见 15.4）。
> * **P2**：6.1–6.8 待实现规划保留，按新模型对位修订。
>
> 桌面 App 本体的 UI 实现不在本仓库范围；本仓库的交付物是 `omp --mode rpc-ui` 的协议与服务端能力。本次合并仅修改文档，未改代码、未运行功能或性能验证。

## 1. 背景与目标

### 1.1 背景

fork 基于 omp 的 RPC 模式（`omp --mode rpc-ui`；协议实现位于 `packages/coding-agent/src/modes/rpc/`，上游协议文档为 `docs/rpc.md`）实现桌面 App，核心功能对齐 ZCode 桌面端的 agent 核心域：会话主视图、输入区（Composer）、权限与答疑交互、任务/会话列表与工作台、设置页中与 Agent/模型相关的分区（对照清单：《ZCode UI 功能清单（Agent 核心）》，存放于本机 ZCode 工程目录，不属于本仓库）。第一期（P0 与 5.x）已实现，见 §4、§5。

在此之上，用户进一步明确三项需求（R1–R3）：**在保留 ZCode 现有界面与交互布局的前提下，让其使用 OMP**。桌面调用层承担协议映射和界面衔接；OMP 提供真实的运行能力和状态。

单纯把协议字段转换放在桌面调用层，无法完成以下工作：把一个 OMP 主进程变成多个独立会话的容器；让 TUI 与 GUI 共用命令的业务行为；确保技能修改后，所有相关会话实际采用正确的技能状态。这些能力需要由 OMP 提供。

本方案以三项核心需求为范围依据。绘画、聊天、编程、远程控制等业务功能不作为本次新增设计范围；现有 Agent 执行能力仅作为命令与技能的底层执行基础。

### 1.2 三项核心目标

| 编号 | 需求 | 完成后的用户体验 |
| --- | --- | --- |
| R1 | GUI 管理 OMP 技能 | 在现有技能界面查看、启停、复制、删除技能；相关安装和更新操作使用 OMP 的技能管理能力；界面状态与实际可调用状态一致 |
| R2 | GUI 输入并调用 OMP 内置命令和技能 | 输入命令时得到说明、参数提示与补全；提交后由 OMP 执行；需要选择、确认或输入时，使用 GUI 现有交互组件承接 |
| R3 | 每项目一个 OMP 主进程，多会话共存 | 一个项目新增 5 个会话时，仍只有一个 OMP 主进程；切换界面上的会话不会替换其他会话的运行对象，也不会取消其工作 |

“一个进程”指承载项目会话的 OMP 主进程。工具、终端、MCP 等原有能力必要时启动的子进程不计作新增会话进程。

“任意添加会话”表示会话数量不与主进程数量绑定，不表示无限数量的会话同时占用内存。持久化会话可以按需加载和卸载。

### 1.3 总体设计结论

**将 OMP 的 RPC 入口扩展为“项目运行服务”：内部管理多个会话，并统一提供技能管理、命令发现、输入补全、命令执行和交互请求。**

保留 OMP 自身协议风格与业务语义。ZCode 的界面数据结构、界面选择状态和产品专用事件，由桌面调用层映射。

本文件规定职责、接口能力、状态规则、交付顺序和验收要求；具体类结构、函数签名、代码补丁、数据库实现和测试代码由执行 Agent 决定。

### 1.4 范围与非目标

* 范围：`packages/coding-agent/src/modes/rpc/` 的协议扩展与服务端能力，及为暴露底层能力所需的最小挂钩（工具审批门、子会话 UI 委托、plan 状态拆分、goal 迭代计数、多会话容器与命令解耦等）；配套更新 TS 客户端 `rpc-client.ts` 与 Python 客户端 `python/omp-rpc/`。
* 非目标：桌面 App UI 实现本身；TUI/ACP/print/SDK 等其它模式的行为改变（审批门挂钩除外，见 4.1——它 MUST 保持 ACP/TUI 路径行为不变）；ZCode 特有且与本 fork 个人使用定位冲突的条目按第 6 节各小节的处理方式执行；范围排除清单见 15.3。

## 2. 现状基线

### 2.1 上游协议基线（2026-09-28 源码核对）

以下为第一期撰写时（2026-09-28，上游 v18.4.2 + fork main）经源码核对的协议事实，作为对照基线；其中“无会话列表枚举命令”等缺口已由 §4/§5 的 fork 扩展补齐（以各条实现状态为准），“单会话进程”仍是当前上游结构，是 §11 要改造的对象。实现时以代码为准：

| 事实 | 说明与出处 |
| --- | --- |
| 传输与帧 | 子进程 stdio JSONL；物理帧上限 1 MiB，v2 逻辑帧重组上限 64 MiB（`rpc-frame.ts`）；命令带可选 `id`，响应 `{type:"response",command,success,data?/error?,code?}`，未知命令报错且循环继续 |
| 协商 | 启动即发 `ready`（现公告 `supportedProtocolVersions:[1,2]`）；`negotiate_protocol {protocolVersion:2}` 升 v2（`rpc-mode.ts`） |
| 命令面 | `RpcCommand` 联合约 40 个：prompt 族、状态族、模型/思考档、队列模式、压缩、重试、bash、会话切换/分支、消息分页、登录、host tools/URI、子代理订阅与回放（`rpc-types.ts:24-94`） |
| 事件面 | `AgentSessionEvent` 原样转发（message_start/update/end、tool_execution_*、auto_compaction_*、auto_retry_*、model_changed、goal_updated、notice 等）+ 子代理三帧 + `prompt_result`/`session_settled`/`available_commands_update` 等控制帧 |
| 单会话进程 | 一进程一活动会话；`new_session/switch_session/branch/open_session` 切换；上游无会话列表枚举命令 |
| EOF 语义 | stdin EOF → 拒绝全部挂起 UI/host 请求 → drain → dispose → 退出（`rpc-mode.ts` 尾部） |
| 工具审批现状 | 审批门在 `extensibility/extensions/wrapper.ts` 的 `execute` 内：`uiContext.select(formatApprovalPrompt(...), ["Approve","Deny"])` 纯文本二选一；无结构化载荷、无 allow_always 语义、拒绝无理由回传；ACP 模式另有完整权限网关（`session/acp-permission-gate.ts`、`session/session-tools.ts`、`session/client-bridge.ts`）但仅挂在 ACP clientBridge 上 |
| 答疑现状 | rpc-ui 下 `ask` 工具降级为逐题 `extension_ui_request select`；富对话框 `askDialog`（多题/preview/倒计时）存在于 TUI 与 ACP（`modes/acp/acp-agent.ts`），RPC 未实现 |
| 队列/后台任务现状 | session 层已有 `getQueuedMessages/clearQueue/replaceQueues`（`agent-session.ts`）、`getAsyncJobSnapshot`（同文件）、`snapshotJobs/executeCancel`（`async/job-control.ts`），RPC 仅暴露 `queuedMessageCount` 计数与文本 `/jobs` 输出 |
| 会话列表现状 | `session/session-listing.ts`（`listAllSessions` 等）、`session-pins.ts`（全局置顶）、`updateSessionTitle`、`deleteSessionWithArtifacts` 均为底层现成能力 |

### 2.2 项目运行服务设计的源码核实（2026-09-29）

以下结论基于顶层设计撰写时的本地仓库版本（早于当前基线 v18.4.3，实施前按 §18 第 1 条重新核对差异）：

| 仓库 | 审阅基线 |
| --- | --- |
| [zai-org/ZCode](https://github.com/zai-org/ZCode) | `29628c9acdb81b703bbd4080c207a0e7ce5e276e` |
| [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi) | `d1932a6ff85613dde1160b87a73ddcdc3beb01f6` |

| 已确认的现状 | 对本方案的影响 |
| --- | --- |
| OMP 当前 `runRpcMode` 接收一个 `AgentSession`；创建、打开、切换会话围绕该对象运行 | RPC 需要增加会话管理与路由，不能仅增加一个字段便认为支持会话共存 |
| OMP 的 ACP 模式已有会话集合、创建/恢复/关闭流程和按会话维护的运行记录 | 应评估抽取、复用这部分基础；不能据此直接宣称 RPC 已具备同等能力或所有共享状态已隔离 |
| RPC 已有 `get_available_commands`、`available_commands_update`，命令元数据已有说明、别名、输入提示和子命令 | 扩充现有目录，不另建一套由桌面维护的命令清单 |
| RPC 的 `prompt` 已有技能调用分支，以及一部分内置命令分发 | 技能调用无需重写执行引擎；新增严格命令入口应复用已有执行路径 |
| 命令目录构建会跳过没有通用 `handle` 的内置命令；例如 `/skills` 当前只有 `handleTui` | TUI 中可用不等于 RPC 中可用；需要把这类命令的业务操作抽离 TUI |
| 动态参数补全分布在 TUI 命令构建和扩展回调中；RPC 的 `addAutocompleteProvider` 当前为空实现 | 需要建立可供 RPC 使用的补全服务，不能只暴露静态命令列表 |
| OMP 已有技能发现、刷新、安装、更新和卸载的底层能力 | 新管理接口应复用这些能力，统一来源解析和生效规则 |
| `manage_skill` 工具仅管理隔离的自动学习技能，受相关设置控制 | 不能将它直接当成所有 OMP 技能的 GUI 管理 API |
| 技能代码存在进程级 `activeSkills`，主会话创建或刷新时会更新它 | 多会话改造必须审查依赖此全局状态的路径；它是隔离风险，不是已通过测试确认的故障 |
| ZCode 技能服务现有查看、启停、复制到公共目录、移除和删除入口 | 接入方案需要覆盖这些管理行为；OMP 可以提供通用复制与删除语义，由桌面映射产品目录概念 |

## 3. 分期与优先级

* **P0（已实现，兼容基线）**：4.0–4.4。契约原样保留；未协商 v3 的客户端行为不变是多会话改造的兼容前提。
* **P1（本期必须实现）**：
  * (a) 已实现子项维持：5.1–5.8（其中 5.6 的技能开关命令按 §17 被 §12 取代/扩展）。
  * (b) 顶层设计全部需求（§9–§16）：多会话项目运行服务（§11）、技能管理闭环（§12）、命令与补全统一服务（§13）、配套内部调整（§14）、交付边界与阶段（§15）、验收场景（§16）。**用户已定：这部分全部为 P1，不降级、不裁剪为 P2。**
* **P2**：6.1–6.8 完整需求与明确规划保留，实现前部分条目需先做产品决策；15.2 的后续增强同属 P2 性质。
* **冲突裁决**：新旧文档冲突处以顶层设计（§9–§16）为准；已实现项的回退与迁移固定在 §17，未列入 §17 的已实现能力一律保留。

优先级定义：P0 = 已落地的兼容基线；P1 = 本期必须交付；P2 = 有效需求与明确规划，实现排期后以第 6 节为验收依据，MUST NOT 按实现现状反向删减。

以下纯客户端能力不构成协议缺口，桌面 App 自行实现，本仓库 NEVER 为其改动协议：虚拟滚动与贴底跟随、分屏与窗格管理、IME/快捷键/草稿与输入历史持久化、划词引用（拼 prompt 文本）、会话内查找（客户端分页拉取后本地搜索）、时间线分组折叠渲染、状态面板布局、通用确认弹窗。

## 4. P0 需求（已实现兼容基线）

### 4.0 协议协商：版本 3

* fork 构建下 `ready` 帧公告 `supportedProtocolVersions:[1,2,3]`；`negotiate_protocol {protocolVersion:3}` 成功后启用本文档定义的全部 fork 扩展命令与帧；v3 隐含 v2 分帧能力。
* 未协商 v3（或协商 v1/v2、非 fork 构建）的客户端 MUST 收到与现状一致的行为：不收到任何新帧，发送新命令得到现有 `Unknown command` 错误响应；工具审批退回 `extension_ui_request select("Approve","Deny")`，ask 退回逐题 select。
* 协商失败与降级路径 MUST 有自动化测试覆盖（见第 8 节）。
* 多会话等业务能力 MUST 经独立的能力发现声明（10.3），MUST NOT 仅凭协议版本号 v3 推断。

> 实现状态（2026-09-28）：已实现并通过验证。`ready` 公告 `[1,2,3]`、`negotiate_protocol` 接受 v3（成功数据 `{protocolVersion:3}`，v3 隐含 v2 分帧）、fork 门控分发框架落地（`packages/coding-agent/src/modes/rpc/rpc-fork-types.ts`、`rpc-fork-host.ts`，挂钩于 `rpc-mode.ts` negotiate/default/控制帧/EOF 四处）；UT+E2E 见 `packages/coding-agent/test/rpc-fork-protocol.test.ts`（v2 降级、无效版本拒绝、bypass 帧不消费均覆盖）。例外：5.4 明文宣布的 get_messages_page session_busy 拒绝移除为跨版本行为变更（stale_cursor 守卫保留），不适用前述 MUST。

### 4.1 工具权限审批

**需求**：rpc-ui（v3）下的工具审批从纯文本 select 升级为结构化权限协议，支撑桌面 App 的权限审批卡：预览、选项语义、拒绝理由回传、持久化、子代理来源、运行时档位切换。

**协议契约**：

* 新帧（服务端 → 客户端，旁路即时分发）：

```text
permission_request {
  id: string                  // 审批请求 id，响应用
  toolCallId: string          // 与 tool_execution_start 事件关联，供渲染工具行待审批态
  toolName: string
  tier: "read" | "write" | "exec"
  reason?: string             // 审批原因（来自审批门）
  approvalMode: "always-ask" | "write" | "yolo"
  details: string[]           // formatApprovalDetails 生成的预览行（diff/命令摘要等，现有能力）
  input: unknown              // 工具结构化参数（有界截断），供客户端渲染 diff/命令预览
  origin?: { subagentId: string; agentType: string }   // 子代理发起时必带
  prefixSuggestion?: string   // 前缀档：bash 首词前缀建议（含尾随空格），供 allow_always_prefix
}
```

* 新旁路帧（客户端 → 服务端，即时分发，同 extension_ui_response 模式）：

```text
permission_response {
  id: string
  option: "allow_once" | "allow_session" | "allow_always" | "allow_always_prefix" | "reject_once" | "reject_always"
  feedback?: string           // 拒绝理由，≤ 4096 字符，附给模型
}
```

* 新命令：`set_approval_mode {mode: "always-ask"|"write"|"yolo"}`（运行时切换，会话内生效并写回设置）；`get_state` 响应 MUST 增补 `approvalMode` 字段；`config_update` 帧增补该字段。

**行为规则**：

* 审批门实现 MUST 复用 ACP 权限网关的选项语义与既有抽象（`session/acp-permission-gate.ts`、`session/session-tools.ts` 的 `#wrapToolForAcpPermission`、`session/client-bridge.ts`），以 RPC 实现注入同一 bridge 接口；MUST NOT 复制一份平行逻辑。TUI 与 ACP 路径行为 MUST 保持不变。
* `allow_session`：会话内存效（对齐 ACP 内存 Map 语义）；`allow_always`/`reject_always`：写入既有配置键 `tools.approval.<tool>: allow|deny` 并依赖既有热加载，重启后仍生效；命中已允许策略时不再发帧。
* `feedback` 非空时，拒绝错误文本 MUST 附带理由回传给模型（替换裸 `Tool call denied by user`）；空 feedback 保持现状文案。
* 子代理会话的审批 MUST 委托到宿主 UI：为子会话注入携带 `origin` 标注的委托 UI context（落点 `task/executor.ts` 子会话构建处），子代理审批请求在主连接上呈现并带来源徽标；委托失败按现状 fail-closed 报错。
* bash 命令前缀级“始终允许”（`allow_always_prefix`，前缀规则持久化）为同一审批协议的第二档能力：验收分两档（见下），第一档交付整工具级 allow_always 即可，前缀规则 MUST 在第一档交付后、第一期结束前补齐，并扩展 `tools/approval` 的策略键以支持前缀粒度。
* 超时/断连：v3 客户端断连时挂起审批按现状 fail-closed（拒绝并报错）；不引入审批静默放行路径。

> 前缀档实现状态（2026-09-28）：已实现（第一档交付同批）。`allow_always_prefix` 按请求携带的 `prefixSuggestion`（bash 首词+尾随空格）持久化到新增设置键 `tools.approvalPrefixes.<tool>`（`tools/settings.ts`），命中前缀规则的后续调用不再发帧；整工具策略键不受前缀档影响（只放行匹配前缀的命令）。组合命令（含 `&&`/`;`/管道/反引号/`$()`/进程替换 `<()`/`>()`/换行）不适用前缀自动放行，一律回落审批。UT 覆盖建议生成、规则持久化与去重、命中跳帧、未命中仍审批（`test/rpc-fork-permission.test.ts`）。

**验收条件**：

1. `always-ask` 下 edit 类工具调用触发带 `toolCallId`、`details`、`input` 的 `permission_request`，客户端可据 `input`（oldString/newString 等）渲染 diff 预览并与工具行关联。
2. `allow_always` 后同工具后续调用不再触发请求，重启进程后仍生效（配置已持久化）；`allow_session` 仅本会话生效。
3. 拒绝且带 feedback 时，模型收到的工具错误文本包含理由。
4. 子代理发起的审批在主连接收到且 `origin` 正确；TUI/ACP 路径回归不变。
5. `set_approval_mode` 运行时生效，`get_state`/`config_update` 反映当前档位。
6. 未协商 v3 的客户端全程行为与现状一致（既有审批 select 路径）。

> 实现状态（2026-09-28）：第一档（整工具级 allow_always）已实现，服务端在 `packages/coding-agent/src/modes/rpc/rpc-fork-permission.ts`（经 `session.setClientBridge` 注入 ACP 权限网关，`task/executor.ts` 注入 origin 子代理委托桥）；`set_approval_mode`/`get_state.approvalMode`/`config_update.approvalMode` 同步落地。子代理委托经「仅 RPC v3 委托注册时」为四个网关覆盖工具写入子会话本地 `prompt` 策略实现（上游无人值守 yolo overlay 保留、非桥接工具不受影响；审批决策由主会话档位权威裁定）；allow_session 授权在 set_approval_mode 切档时随网关刷新而清空。UT 覆盖审批帧结构、六选项语义（含 allow_always_prefix）、allow_always/reject_always 配置持久化、feedback 回传、子代理 origin、断连 fail-closed、v2 门控（`test/rpc-fork-permission.test.ts`）；真实模型驱动 E2E 见 `test/rpc-fork-approval-e2e.test.ts`（需 API key，本机验证环境未运行）。

### 4.2 会话与任务列表（第一版）

**需求**：暴露会话枚举与任务列表操作，支撑桌面 App 侧栏任务区（列表、置顶、重命名、删除）。

> **合并处置**：多会话模式（§11）落地后，本条 `list_sessions`/`delete_session` 改造为项目会话目录语义、跨工作区聚合职责移交宿主，`pin`/`rename`/`sessions_changed` 保留并并入新事件体系；未声明多会话能力的客户端行为不变。逐项处置见 §17。

**协议契约**（均为新命令）：

```text
list_sessions { scope: "cwd" | "all", cursor?, limit? }
  → { sessions: [{ sessionId, sessionFile, title, cwd, created, modified,
                   messageCount, assistantTurns, status, pinned }],
      nextCursor? }
pin_session { sessionId } / unpin_session { sessionId }
rename_session { sessionFile, name }
delete_session { sessionFile }        // 连同 artifacts，复用 deleteSessionWithArtifacts
```

* 事件：`sessions_changed { }`（列表内容可能变化时的轻量通知，客户端收到后重拉；无 watcher 的变化源由轮询兜底，事件为尽力推送）。

**行为规则**：

* MUST 复用 `session/session-listing.ts`（`listSessions/listAllSessions`）与 `SessionManager` 的列表/选择器路径；置顶复用 `session-pins.ts` 全局存储，`scope:"all"` 时置顶项在响应中带 `pinned:true`，跨工作区合并置顶由客户端按 `pinned` 排序呈现。
* `rename_session` 支持非活动会话（复用 `updateSessionTitle`），活动会话等价 `set_session_name`。
* `delete_session` 拒绝删除当前活动会话（错误码 `active_session`）。
* 排序默认 `modified` 新→旧（底层现行为）；`created` 排序与分组视图由客户端完成，协议不新增排序参数。
* 归档/分组/已读未读/+N−N 统计不在本条范围（见 6.1）。

**验收条件**：

1. `scope:"all"` 返回跨工作区会话且置顶标记正确；分页游标可用。
2. 置顶/取消置顶后 TUI 会话选择器与 RPC 结果一致（同一存储）。
3. 重命名非活动会话后重新 `list_sessions` 标题更新；删除后文件系统与会话索引一致，活动会话删除被拒绝。
4. `sessions_changed` 在标题变更、会话新建/删除时触发（尽力）。

> 实现状态（2026-09-28）：已实现（`packages/coding-agent/src/modes/rpc/rpc-fork-sessions.ts`，复用 `session-listing`/`session-pins`/`session-storage`）。UT 覆盖 cwd/all 列表、分页游标、置顶/取消、重命名（活动/非活动）、删除与 `active_session` 拒绝、`sessions_changed` 尽力推送、v2 门控（`test/rpc-fork-sessions.test.ts`）。`sessions_changed` 目前仅由 fork 命令自身变更触发，跨进程变化由客户端轮询兜底。

### 4.3 富 ask 答疑与倒计时

**需求**：`ask` 工具（AskUserQuestion 对应物）在 v3 下以完整问题集一次下发，支撑多题分页、多选、preview、自定义回答、sensitive 输入与倒计时暂停。

**协议契约**：

* 新帧：`ask_request { id, questions: [{ id, question, header?, options: [{ label, description?, preview? }], multi?, recommended? }], note?, timeoutMs?, deadlineAt? }`
* 新旁路帧：

```text
ask_response { id, answers: [{ questionId, selected: string[], other? }] }
ask_response { id, chat: string }      // 转为对话（ZCode「在辅助对话中提问」语义）
ask_response { id, cancelled: true }   // 取消整个请求
ask_pause { targetId }                 // 幂等暂停倒计时；首次交互后客户端应自动发送
```

* `extension_ui_request` 的 `input`/`editor` 方法增补可选 `sensitive?: boolean`（密码框渲染）；login 流的 secret 输入在 v3 下解禁（现直接拒绝）。

**行为规则**：

* 服务端 MUST 在 `RpcExtensionUIContext` 实现 `askDialog`（`ExtensionUIContext` 已有该接口），问题集、选项、多选、recommended 语义与 TUI 富对话框一致；ACP 的 elicitation 映射（`modes/acp/acp-agent.ts`）为参考实现，MUST NOT 改变 ask 工具的模型侧契约。
* 倒计时：`timeoutMs` 到期自动按 recommended 收尾的行为保持；新增语义为——到期前客户端任意 `ask_response`/`ask_pause` 均取消自动收尾（幂等暂停）；服务端 MUST NOT 在收到暂停后仍静默超时。
* 不预选任何选项；多选题空提交 = 合法“全不选”；单选题未作答而 `cancelled` = 整个 ask 工具 abort（对齐现状）；空答案提交的“明确跳过”语义由 answers 结构表达（`selected: []`）。
* 草稿按 `ask_request.id` 保留为客户端职责，协议不提供草稿重开。

**验收条件**：

1. 多题 ask 一次下发，客户端分页渲染、逐题/整体提交均正确收敛到工具结果。
2. 多选、Other 自定义输入、`chat` 转向、`cancelled` 四条路径结果正确。
3. 倒计时期间 `ask_pause` 或任意响应后不再自动收尾；未暂停时到期仍按 recommended 收尾。
4. `sensitive` 输入在 login 流可用（v2 仍拒绝）。
5. 未协商 v3 时逐题 select 降级路径与现状一致。

> 实现状态（2026-09-28）：已实现（`packages/coding-agent/src/modes/rpc/rpc-fork-ask.ts`，`RpcExtensionUIContext.askDialog` 按 v3 激活动态暴露，未协商时该方法不存在、ask 工具自动走逐题 select）。UT 覆盖 ask_request 结构（timeoutMs/deadlineAt）、answers/chat/cancelled 三路径、多选空提交、Other 自定义、未知标签过滤、`ask_pause` 幂等（暂停后不再自动收尾）、到期 recommended 收尾、abort 取消帧、断连 fail-closed（`test/rpc-fork-ask.test.ts`）。`extension_ui_request` 的 `input`/`editor` 增补 `sensitive?: boolean`，login secret 输入 v3 解禁、v1/v2 保持拒绝（`rpc-mode.ts` login 臂）；`input.sensitive` 的真实 login 流 E2E 依赖外部 OAuth 提供方，未在本机验证。

### 4.4 会话进程生命周期（宿主进程池模式，已被多会话模型取代）

**需求**：桌面 App 需要“关闭窗格（会话继续运行）”、多窗格多会话与断线恢复。第一阶段采用**宿主进程池**模式，fork 侧不新增协议。

> **合并处置（2026-09-29）**：本条的宿主进程池约定**作为目标模式废止**，由 §11 的“每项目一个 OMP 主进程、多会话共存”取代（回退与迁移见 §17）。已实现部分无需回退代码：EOF 有序退出与 `open_session` 恢复保留为单会话兼容路径与旧客户端回归基线，其 E2E 继续有效。

**行为规则**：

* fork 侧 MUST 保持现有 EOF 语义不变（stdin EOF → 有序退出），并保持 `open_session`（按目录续接最新非空会话）与 `get_messages_page` 的恢复能力稳定——这是宿主侧断线恢复的协议依赖。
* 宿主约定（对桌面 App 的契约性说明，不是本仓库实现项）：关窗格时宿主保持子进程 stdin 打开、仅解除 UI 绑定；重开窗格复用同一进程；宿主重启后按 `open_session` + 分页重拉恢复；跨进程任务列表实时性由宿主轮询 `get_state`/`list_sessions` join。
* 协议级 detach/attach 与事件回放为 P2（见 6.7）。~~在其实施前本条是唯一生命周期方案。~~（该地位已由 §11 多会话模型取代。）

**验收条件**：

1. 现有 EOF 有序退出与 `open_session` 恢复行为有 E2E 覆盖（真实 `omp --mode rpc-ui` 进程：kill 宿主 → respawn → open_session → 历史完整）。
2. 本条不引入协议改动；回归以既有 RPC 测试为准。

> 实现状态（2026-09-28）：已实现且 E2E 通过。真实 `omp --mode rpc-ui` 进程验证 EOF 有序退出（exit 0）、kill 宿主 → respawn → `open_session` 续接同一会话文件 → `get_messages` 历史一致（`test/rpc-fork-lifecycle.test.ts`）。

## 5. P1 需求（已实现部分，维持）

以下第一批子项已实现并按实际验证范围标注；多会话模式落地时按 §10 为会话级请求、流式事件与 UI 请求补会话归属字段（可选中扩展，未声明多会话能力的客户端不变），语义本身不变。

### 5.1 排队消息面板

* 新命令：`get_queue` → `{ steering: [{id,text,imageCount}], followUp: [...] }`；`remove_queued {queue:"steering"|"followUp", entryId}`（条目 id 命名为 `entryId`，避免与命令关联 `id` 撞名）；`reorder_queue {queue, ids}`（全量顺序）；`clear_queue {queue?}`。
* 新事件：`queue_updated { steeringCount, followUpCount }`（内容或计数变化时；客户端据此重拉）。
* 行为：MUST 复用 session 层队列 API（`getQueuedMessages/clearQueue/replaceQueues`，`agent-session.ts`）；`reorder`/`remove` 后注入顺序相应变化；与 `get_state.queuedMessageCount`、`prompt_result(aborted)` 的暂停语义（队列暂停横幅）由客户端推导，协议不改。
* 验收：队列增删改后 `get_queue` 与实际注入顺序一致；事件与计数不漂移；abort 后队列内容保留可查。

> 实现状态（2026-09-28）：已实现（`packages/coding-agent/src/modes/rpc/rpc-fork-queue.ts`，包装 `agent.peekSteeringQueue/peekFollowUpQueue/replaceQueues`，条目 id 由 WeakMap 按消息对象稳定铸造）。UT 覆盖 get_queue 稳定 id、remove/reorder/clear 与 `queue_updated` 计数、非法 queue 名与未知条目错误码 `unknown_queue_entry`（`test/rpc-fork-queue-jobs-search-state.test.ts`）。`queue_updated` 当前仅由 fork 队列命令变更触发；abort 后队列保留为底层现成行为（`get_queue` 可查）。

### 5.2 后台任务

* 新命令：`get_jobs { includeRecent?, recentLimit? }` → `{ running: [...], recent: [...] }`，每项 `{ jobId, type, label, status, startedAt, durationMs, exitCode?, resultText? }`；`cancel_job { jobId }`。
* 行为：MUST 复用 `getAsyncJobSnapshot`（`agent-session.ts`）与 `snapshotJobs/executeCancel`（`async/job-control.ts`）；输出文件路径沿用 `tool_execution_update` 的 artifact 信息，不在本命令重复。
* 验收：后台 bash 运行中可见并可取消；完成后进入 recent 且带 exitCode；与 `hasPendingAsyncWork`/`session_settled` 语义一致。

> 实现状态（2026-09-28）：已实现（`packages/coding-agent/src/modes/rpc/rpc-fork-jobs.ts`，包装 `AsyncJobManager.getAllJobs` + `snapshotJobs`/`executeCancel`，按 owner 过滤；unknown job 错误码 `unknown_job`）。UT 覆盖无 manager 空快照与 unknown job 取消失败路径；运行中可见/取消/recent+exitCode 的全链路依赖真实后台 bash 任务，协议层由快照映射 UT 与既有 job-control 底层测试共同覆盖，端到端取消流待 key E2E 环境（见 rpc-fork-approval-e2e 同类门控）。

### 5.3 计划模式命令化

* 新命令：`set_plan_mode {enabled}`（等价 TUI `/plan` 的进入/退出）；`get_plan_state` → `{enabled, planFilePath?, workflow}`；`list_plans` → `[{path, title?, modified}]`；`read_plan {path}` → `{content}`；`approve_plan {decision:"approve"|"refine"|"reject", feedback?, model?}`（计划审批响应闭环）。
* 行为：MUST 复用 `getPlanModeState/setPlanModeState`（`agent-session.ts`）与 `plan-mode/plan-files.ts`；`approve_plan` 的核心逻辑 MUST 从 `interactive-mode.ts` 计划审批处理拆为 session 层方法供 RPC 复用（TUI 行为不变）；RPC 下发 `/plan` 文本不再作为普通 prompt 发给模型（`/plan` 为 TUI-only 的现状由此终结）。
* 验收：RPC 进入/退出 plan mode 后行为与 TUI 等价（计划文件写入、审批检测）；计划内容可读且随写更新（客户端可 watch 路径）；`approve_plan` 三种决策语义正确。
* 合并备注：`/plan` 文本拦截是“严格命令分发、不静默转交模型”（13.4）的既有先例，纳入 §13 统一命令服务时保留。

> 实现状态（2026-09-28）：已实现。会话层拆分落点 `plan-mode/session-approval.ts`（`dispatchApprovedPlan`/`enterPlanModeForSession`/`exitPlanModeForSession`），TUI `#approvePlan` 尾部已改为复用 `dispatchApprovedPlan`（overlay 关闭时机经 `beforeDispatch` 保留，interactive-mode plan 相关 36 项既有测试全部通过，TUI 行为不变）；RPC 侧 `rpc-fork-plan.ts` 提供 set_plan_mode/get_plan_state/list_plans/read_plan/approve_plan，`/plan` 文本在 RPC 模式（任意协议版本）被拦截为模式切换、不再作为 prompt 发给模型。`approve_plan.model` 契约为 `provider/modelId` 选择器（经 set_model 语义解析）。approve/refine 的执行轮经后台 ticket 派发（命令立即应答，不阻塞 abort/get_state 等普通命令）；该轮完成以一条无 `id` 的 `prompt_result` 帧报告（与命令 id 无关联），客户端依赖 agent 事件流观察执行轮。UT 见 `test/rpc-fork-plan.test.ts`（进入/退出/工具增补恢复、三决策语义、`plan_not_found`/`plan_not_active` 错误码、/plan 拦截）。

### 5.4 历史分页倒序与流式期可读

* `get_messages_page` 增补 `order?: "asc"|"desc"` 与锚点游标（`before`/`after`），支持从尾部向前的倒序分页；放宽 `session_busy`：流式/压缩期间 MUST 允许读取历史页（只读快照），仅游标绑定的活跃窗口语义保持。
* 行为：倒序页与正向页在同一会话上结果一致（顺序相反）；贴顶预取不得影响活跃流推送。
* 验收：流式中贴顶预取成功；超大会话倒序翻页与 `get_messages` 全量结果一致；`stale_cursor` 语义保留。

> 实现状态（2026-09-28）：已实现（`rpc-messages.ts` 增补 `order:"desc"` 倒序游标与 `before`/`after` 锚点游标，游标载荷携带方向；`rpc-mode.ts` 移除 `session_busy` 拒绝——流式/压缩期间允许只读快照分页，`stale_cursor` 为一致性守卫，`session_busy` 错误码从此不再产生）。UT 见 `test/rpc-fork-pagination.test.ts`（倒序全量与正向全量互为逆序、锚点方向、组合拒绝、stale_anchor、旧游标兼容）；既有 `rpc-messages.test.ts` 全部通过。

### 5.5 附件通道扩展

* `prompt/steer/follow_up/abort_and_prompt` 增补 `attachments?: Attachment[]`：

```text
Attachment = { kind: "file", path, mime? }        // 同机文件引用（首选，避免大帧）
           | { kind: "data", mime, data }          // 内联 base64，受物理帧上限约束
```

* 支持类型：图片（与现有 `images` 等价并保留 `images` 兼容）、PDF、纯文件；视频为 P2（底层模型输入能力未定，先不承诺）。
* 错误码：`attachment_too_large`、`attachment_unsupported`、`attachment_unreadable`；数量上限（8）与超限错误码 `attachment_limit`。
* 行为：附件随用户消息持久化（会话存储沿用现有自定义消息载荷），历史回放可见；`kind:"file"` 在发送时读取一次，不建立持久附件 id（重传语义 = 重发消息，不引入上传会话）。
* 验收：PDF/文件附件端到端入会话且历史可见；超大/超限/不可读分别返回对应错误码；仅用 `images` 的旧客户端不回归。

> 实现状态（2026-09-28）：已实现（`rpc-fork-attachments.ts`：图片 → `ImageContent`（与 `images` 同管线并存）、PDF → native `pdfToMarkdown` 转 markdown 文本块、文本类文件 → 有界文本块；上限 8 个（`attachment_limit`）、单附件 20 MiB（`attachment_too_large`）、不可读（`attachment_unreadable`）、不支持类型（`attachment_unsupported`）；`kind:"file"` 发送时读取一次，附件随用户消息内容持久化、历史回放可见）。接入 prompt/steer/follow_up/abort_and_prompt 四臂。UT 见 `test/rpc-fork-attachments.test.ts`（图片/PDF/文本/四类错误码）；旧客户端仅用 `images` 的路径未改动（回归以既有 rpc 测试为准）。PDF 端到端入会话依赖模型轮次，UT 覆盖转换与路由层。

### 5.6 配置与管理面

**A 档**：

* `get_settings {scope} / set_settings {scope, key, value} / unset_settings {scope, key}`：包装 `createSettingsHost`（`config/settings-ui.ts`），凭据字段 MUST 脱敏返回；作用域 = 用户（`~/.omp/agent/config.yml`）/ 项目（`.omp/config.yml`）既有分层。
* `list_providers` → 供应商与模型清单（合并内置目录、`models.yml`、运行时发现状态）；`upsert_provider {provider}` / `delete_provider {provider}` / `set_model_enabled {provider, modelId, enabled}`：写 `models.yml` 与既有 `enabledModels/enabledProviders/modelProviderOrder` 设置键，复用现有校验（`validateProviderConfiguration`）。
* `test_model {provider, modelId}`：实测连通性，失败归因至少区分 认证失败/模型未找到/限流/网络/服务端/未配置 endpoint 六类。

**B 档**：

* MCP：`list_mcp_servers`（含连接状态与失败分类，源用 `mcp:connection-status` 事件与 `MCPFailureClass`）、`upsert_mcp_server / delete_mcp_server / set_mcp_server_disabled / mcp_reconnect`：包装 `mcp/config-writer.ts` 全套。
* 技能：`list_skills`（含 source、warnings、加载诊断）、`set_skill_source_enabled / set_skill_ignored`：包装 `extensibility/settings.ts` 既有键。~~技能删除与选择性导入为 P2。~~（合并处置：本组技能命令由 §12 技能管理闭环取代/扩展——`set_skill_source_enabled`/`set_skill_ignored` 被 `set_skill_enabled` 取代、`list_skills` 原位扩展、技能删除/复制升为 P1 交付；逐项见 §17。）
* 子代理定义：`list_agent_definitions / upsert_agent_definition / delete_agent_definition`：包装 `task/discovery.ts` 发现与定义文件读写；颜色标记与单独启用开关为 P2 扩展字段。
* 用量与统计：`get_usage {provider?, days?, history?}`（包装 `packages/ai/src/usage` 模块，结构与 `omp usage --json` 一致）；`get_stats_summary {range}`（包装 `packages/stats` 聚合）。
* 事件：`settings_changed {scope}`（设置文件变更通知，尽力推送，配合既有热加载）。

**验收条件**：

1. 设置读写经 ACP/RPC 与直接编辑文件语义一致，热加载后新会话生效；凭据不以明文回传。
2. 供应商/模型增删改后 `get_available_models` 与 TUI 模型面板反映一致；`test_model` 六类归因有构造用例覆盖。
3. MCP 增删改与启停后重连生效，失败分类可渲染设置页错误行。
4. `get_usage`/`get_stats_summary` 输出与对应 CLI（`omp usage --json`、`omp stats`）一致口径。

> 实现状态（2026-09-28）：A/B 两档已实现（`rpc-fork-config.ts` + `rpc-fork-manage.ts`）。设置读写包装 `createSettingsHost`（经 `withActiveSettings` 绑定会话实例），凭据读取脱敏，项目作用域只读（错误码 `read_only_scope`——设置层仅持久化用户层，属上游既有边界）；供应商 CRUD 直接读写 `models.yml`（ConfigFile 无写 API，读改写 + `stringifyYamlConfig` + invalidate），`validateProviderConfiguration` 前置校验；`set_model_enabled` 写 `enabledModels` allowlist 键（空表 = 全放行的既有语义，首个显式 enable 开始收窄）；`test_model` 六类归因（auth_failed/model_not_found/rate_limited/network/server/endpoint_not_configured，经 `streamSimple` 实测 + `AIError` 归类）。MCP CRUD 包装 `mcp/config-writer.ts`（user/project 两路径），连接状态为 `mcp:connection-status` 事件的尽力缓存；`mcp_reconnect` 因 session 层未暴露 MCPManager 访问器而返回 `triggered:false`（连接按既有重连梯次在使用时重建）——**已知缺口**。技能启停写 `skills.enable*`/`skills.ignoredSkills`；子代理定义经 `task/discovery.ts` 读写项目 `.omp/agents/*.md`；`get_usage` 包装 `authStorage.usage`（去 raw，与 `omp usage --json` 同口径）；`get_stats_summary` 包装 `@oh-my-pi/omp-stats`。UT 见 `test/rpc-fork-config.test.ts`（脱敏、read_only_scope、供应商校验失败、test_model 归因、技能键写入、定义文件读写、usage 裁剪、mcp_reconnect 校验）。供应商增删改后的 TUI 面板一致性与 MCP 重连生效两条验收依赖真实多会话环境，未在本机验证。

### 5.7 文件与目录搜索

* 新命令：`search_paths {query, cwd?, limit?}` → `{entries: [{path, type:"file"|"dir"}]}`，默认上限 1000，匹配遵循既有忽略规则与 `fs-scan-cache` 架构。
* 用途：输入区 `@` 面板数据源；远程 transport（TS 客户端 spawn 抽象支持 SSH）下唯一可行路径。
* 验收：模糊查询命中文件与目录；忽略规则生效；上限与截断提示明确；空查询返回有界默认集。

> 实现状态（2026-09-28）：已实现（`packages/coding-agent/src/modes/rpc/rpc-fork-search.ts`，包装 native `fuzzyFind`，hidden+gitignore+cache 与 TUI @ 面板同参；默认上限 1000、绝对路径输出、`truncated` 标志；native 不可用时错误码 `search_unavailable`）。UT 覆盖文件+目录命中、忽略规则、非法参数（`test/rpc-fork-queue-jobs-search-state.test.ts`）。

### 5.8 会话状态补全

* `get_state` 增补 `goal?: { goal, state, iteration }`；`goal_updated` 事件增补 `iteration`（迭代序号，底层 `goals/state.ts` 增设计数）。后接入的客户端可从 `get_state` 拿到当前 goal 快照（现仅事件推送）。
* 新事件 `hook_executed { hookId, event, source, durationMs, status, reason? }`：扩展 runner 增补 per-hook 遥测（事件名、来源用户/工作区/插件、耗时、状态），支撑助手轮次“钩子详情”。
* 新命令 `submit_feedback { messageId, rating: "up"|"down", comment? }`：落本地轻量存储（config root 下 jsonl），无任何上报；赞/踩失败可重试。
* 客户端配套：TS 客户端事件 allowlist 补 `config_warnings_changed/advisor_cost_changed/advisor_yielded`（现被静默丢弃，属客户端侧缺陷）。
* 验收：goal 面板可显示迭代序号与暂停/继续状态；一轮含 hook 的会话可经事件还原逐 hook 列表；feedback 落库可查。

> 实现状态（2026-09-28）：已实现。`Goal.iteration` 计数（`pi-tui/tools/goal.ts` + `goals/runtime.ts` onTurnStart 递增），`get_state.goal` 快照经 `RpcForkStateController.goalSnapshot`（`rpc-fork-state.ts`），`goal_updated` 经 `Goal.iteration` 携带；`hook_executed` 经 runner 新增 `setHookExecutedListener`（`extensibility/extensions/runner.ts` 四个出口：ok/timeout/error/aborted）+ `RpcForkHookTelemetry` 源分类（user/workspace/plugin）；`submit_feedback` 落 `<configRoot>/agent/feedback.jsonl`（无上报）。UT 覆盖迭代快照、源分类与 v3 门控、feedback 落库与非法 rating（`test/rpc-fork-queue-jobs-search-state.test.ts`）；含 hook 的真实轮次事件流验证依赖扩展 hook 用例环境（extensions-runner.test.ts 回归通过）。TS 客户端 allowlist 增补随客户端同步批次落地。

## 6. P2 完整需求（待实现规划）

以下条款为有效需求与明确规划，当前未实现；实现排期后以本节为验收依据，MUST NOT 按实现现状反向删减。15.2 的后续增强同属本节性质。

### 6.1 会话组织：归档、分组、已读未读、变更统计

* 协议方案：会话元数据存储扩展（归档位、分组 id/颜色/顺序、已读游标、+N/−N 统计缓存），命令族 `archive_session/unarchive_session/list_sessions?filter=archived/delete_archived`、分组 CRUD 与排序命令、`mark_session_read/unread`。
* 允许的替代路径：上述状态由桌面 App 宿主侧自建本地存储（以 `sessionId` 为主键），fork 仅保证 `list_sessions` 提供足够的 join 键；两条路径择一，不得并存造成双写。
* +N/−N 统计来源：会话内 edit/write 工具结果的行级统计聚合（服务端）或宿主侧解析（二选一，实现前定案）。
* 合并备注：多会话模式下 join 键来自 §11 的项目会话目录；跨项目聚合由宿主完成。

### 6.2 工作流运行时（需产品决策）

* 完整需求（对齐 ZCode 工作台）：工作流 run 生命周期（待启动/运行中/已完成/出错/已停止 + 停止原因 + 血缘 lineage + resumable + 并发上限与冷却）、阶段脊线投影（阶段状态灯、分支结构、名册、步数、轮次⟳n）、子代理药丸与会话回放、脚本步骤日志簿、待答问题行、产物区（交付物、kind、版本步进、按 kind 预览）、配置弹层（子代理模型、并发上限、调整=另起新 run）、CreateWorkflow 工具卡与稿号、轮尾运行卡、完成卡、后台通知行、任务列表运行行。
* omp 底层现状：无工作流运行时（最接近原语：task 批量 schema、workpool、todo 阶段、async jobs）。
* 实施前 MUST 先做产品决策，三选一：(a) 新建工作流运行时（工作量特大）；(b) 桌面 App 以 task+todo+ask 模拟（无 Resume/血缘/轮次/冷却，体验降级需明示）；(c) 第一版砍掉工作流域。决策记录追加到本节，未决策前不实施。

### 6.3 自动化：定时任务与闲时任务

* 协议方案：cron/闲时任务的 CRUD（频率、指令、模型与档位、模式、最大运行次数、最早可用时段）、运行历史、立即运行/暂停/继续/取消、唤醒条件下（“仅在电脑处于唤醒状态时运行”为宿主能力，协议只表达状态）。
* 底层现状：仓库无 scheduler/cron 代码；实施时先补运行时（宿主持有或 omp 常驻进程，实现前定案），再暴露命令。

### 6.4 IM 机器人渠道

* 完整需求：渠道接入（微信/飞书/Lark/Telegram/Webhook）、绑定码轮询、回复颗粒度、允许工作区。底层零实现；可参考 collab 的 relay 拓扑。实施为全新后端子系统。

### 6.5 套餐与付费（占位）

* ZCode 的套餐/权益卡、升级弹窗、支付面板需求在此仅保留占位。本 fork 不以对外发布为目标、无套餐体系，默认不排期；若未来需要，须先建订阅后端再谈协议。

### 6.6 远程工作区（SSH）

* 现状仅 `ssh://host/path` 文件读写/搜索（内部 URL）。完整需求：远程工作区会话（cwd/bash 在远端执行）、MCP/技能同步到远端、“远程”徽标数据源；TS 客户端 spawn 抽象已支持 SSH transport 作为传输前提。
* 合并备注：远程工作区会话与 §11 的项目进程模型如何组合（远程项目进程的宿主位置）实施前需单独定案。

### 6.7 协议级 detach/attach 与事件回放

* 完整需求：会话进程与 UI 连接解耦（关连接不终止会话运行）、多客户端 attach 同一会话、事件序列号与断线回放（从上次序号续传）、跨进程会话运行态聚合投影（sessions-index 类实时 join）。
* 合并备注：多会话模型（§11）落地后，UI 切换/重载经状态读取 + 后续事件恢复由项目服务内置（11.3）；但连接断开仍触发 EOF 有序退出（4.4 保留语义），“关连接不终止会话”未因此满足，保留为本条诉求（实施时需与 EOF 语义协调定案）。本条实施时 MUST 保持单会话兼容路径（4.4）可回退。

### 6.8 零星条目

* 调用轨迹查询：模型请求/响应 wire 记录与查询命令（现状仅失败请求 dump 且 RPC 错误帧剥离路径；需先补成功请求的记录存储与脱敏）。
* 用户反馈上报：远端上报通道（本地 `submit_feedback` 已在 5.8；上报为增强）。
* CUA 电脑控制状态：设置分区查询、运行中动态授权帧、macOS 权限状态徽章（computer 工具与 safety checks 底层已有，缺状态查询命令）。
* /btw 辅助对话：`side_conversation` 命令包装 `runEphemeralTurn`/BtwController（底层现成；现状 RPC 下 `/btw` 文本会当普通 prompt 发给模型，属已知缺陷，实施本条时修复）。
* 画板（白板导出 PNG）：omp 无概念，经 `set_host_tools` 由宿主实现，不建协议。

## 7. 协议演进与上游同步约束

* **兼容性**：所有新增命令/帧仅在对 `negotiate_protocol` v3 协商成功后生效（4.0）；`RpcCommand`/`RpcResponse` 联合以追加成员方式扩展，MUST NOT 改动既有成员的形状；既有事件的增补字段（如 `goal_updated.iteration`）为可选向后兼容。
* **能力声明**：多会话运行、技能管理、严格命令执行、动态补全等业务能力经能力发现独立声明（10.3）；MUST NOT 仅凭协议版本号（v2 或 v3）推断业务能力是否可用。
* **上游同步**：fork 扩展的服务端实现 MUST 集中在 `packages/coding-agent/src/modes/rpc/` 下的 fork 专有模块（如 `rpc-fork-permission.ts`、`rpc-fork-sessions.ts` 等），对上游文件（`rpc-types.ts`、`rpc-mode.ts`、`wrapper.ts`、`task/executor.ts`、`agent-session.ts` 等）只保留最小挂钩点（联合类型追加、单一分发挂钩、bridge 注入点），降低同步冲突面；这与仓库“fork 改动最小、集中、内聚”的总体约束一致。§11/§13 要求的多会话容器与命令解耦等内部改造，同样以最小侵入方式落在 fork 专有模块或独立会话层模块中。
* **客户端**：TS 客户端（`rpc-client.ts`）与 Python 客户端（`python/omp-rpc/`）随服务端同步扩展，保持三端契约一致；Python 客户端 `request_raw()` 可先行验证新命令。
* **协议文档**：`docs/rpc.md` 为上游文档，fork 不在其中追加条款；本文档是 fork 扩展的唯一协议说明，新增命令 MUST 在本文件契约化后才可实现。

## 8. 验证要求

* **UT**：每个新命令/帧在 `packages/coding-agent/test/` 下有协议层测试（参照既有 RPC 测试布局），覆盖成功路径与关键失败路径（unknown 命令、非法参数、v2 降级、审批断连 fail-closed、倒计时暂停幂等、附件错误码、游标过期、会话不存在/繁忙等）。复用底层 API 的包装命令以边界测试为主，不为覆盖率复测底层逻辑。
* **E2E**：从真实公开入口（`omp --mode rpc-ui` 子进程）跑通：v3 协商 → 权限审批全选项流（含 allow_always 持久化与子代理来源）→ 富 ask 多题与暂停 → 会话列表/置顶/重命名/删除 → 队列增删改 → 后台 job 取消 → plan 进入/退出/审批 → 流式期倒序预取 → 附件入会话 → 设置变更后新会话生效。宿主进程池断线恢复（kill 宿主 → respawn → `open_session` → 历史一致）必须包含。P1 新需求按 §16 的 A01–A19 场景验收，性能验收按 §16 尾部要求记录测试环境与资源趋势。
* **门禁**：TS 改动后 MUST 运行 `bun run fastcheck`；`bun run fulltest`/`slowtest` 按仓库验证规则仅在用户明确要求时运行。
* **状态标注**：P0/已实现 P1 子项维持原验证状态标注；§9–§16 新需求条目在实现并通过对应 UT+E2E 前保持“未实现”；P2 条目 NEVER 标记为已验收。每期交付时更新本文件状态行与 `fork.md` 链接说明，不追加修复历史。

## 9. 职责与架构边界（P1）

### 9.1 三层职责

| 层级 | 应承担的职责 |
| --- | --- |
| ZCode 界面 | 展示技能和会话；显示命令提示及补全；收集选择、确认和输入；保持现有视觉与交互结构 |
| 桌面调用层 | 按项目启动或复用 OMP 进程；维护连接；将现有界面请求映射为 OMP 调用；将 OMP 事件转换为界面数据；保存界面当前选中的会话 |
| OMP 项目运行服务 | 管理项目内会话生命周期；执行技能和命令；提供目录、提示与补全；维护有效配置、技能来源和生效版本；处理取消、交互等待及资源释放 |

桌面负责“这个项目连接哪个进程”，OMP 负责“这个进程中有哪些会话，以及各会话如何运行”。协议本身不提供跨桌面实例的操作系统级单例保证；该能力不属于本次目标。

### 9.2 进程内状态分层

| 层级 | 适合放置的状态 | 约束 |
| --- | --- | --- |
| 项目层 | 项目标识、技能来源目录、共享只读元数据、项目配置、会话目录和管理操作 | 可共享的信息由 OMP 统一维护；不能将会话可变状态混入共享缓存 |
| 会话层 | 历史、运行状态、当前模型、命令上下文、有效技能视图、取消信号、待回应交互 | 按会话隔离；更改 A 不得隐式修改 B |
| 请求/操作层 | 请求关联、操作进度、结果、取消和失败原因 | 必须能定位到所属项目及会话；长操作不能占住整个进程的控制通道 |

不以共享所有资源为目标。例如 MCP 连接、扩展实例和工具资源，只有在确认其语义允许共享后才可共享。首要目标是会话正确隔离，其次才是减少重复资源。

### 9.3 保留前端的含义

保留现有页面、布局、输入方式和主要交互。允许调整调用层、数据适配和现有组件的数据连接。

业务命令需要 GUI 交互时，由 OMP 返回结构化请求，桌面映射到现有组件。如果某个 TUI 专属面板没有现有 GUI 承接方式，必须在命令覆盖表中写明替代交互或范围限制，不能声称“协议通了，所以全部界面行为自动等价”。

## 10. 公共协议设计（P1）

### 10.1 请求与事件的作用域

将接口分为三类：

1. **进程级**：能力发现、项目身份、服务关闭。
2. **项目级**：技能管理、会话目录、项目配置变更。
3. **会话级**：命令执行、会话状态、历史读取、取消，以及需要会话上下文的命令目录和补全。

多会话模式下，会话级请求必须明确目标会话。除创建会话等定义明确的操作外，缺失目标不得偷偷落到某个“当前会话”。

会话相关的结果、流式事件、命令输出、命令目录变化和 UI 请求均应携带会话归属。项目级技能变化事件可以不绑定单个会话，但应说明变化范围及受影响会话。

### 10.2 必须具备的公共信息

| 信息 | 用途 |
| --- | --- |
| 项目身份 | 核对连接是否属于预期项目；一个连接绑定一个项目 |
| 会话身份 | 路由命令、结果和界面交互；恢复历史后仍能识别同一会话 |
| 请求身份 | 将同步响应与发起调用对应起来 |
| 操作身份 | 区分长时间执行与最初受理响应；输出、完成、失败和取消都可关联 |
| 服务实例身份 | 区分进程重启前后产生的事件；避免将旧进程结果写入新状态 |
| 目录/状态版本 | 判断技能、命令和会话状态是否已经更新，识别过期请求 |

这些是协议语义要求，不规定必须使用多少独立字段。可以复用已有请求 ID 与事件格式，只要关联关系明确。

### 10.3 能力发现与兼容

扩展启动 `ready` 信息，或新增 `get_server_info`，报告项目身份、服务实例身份和能力集合，至少区分：

- 多会话运行。
- 技能管理。
- 严格命令执行。
- 动态输入补全。
- 交互请求类型及支持范围。

保留现有单会话客户端的兼容入口。新模式通过明确能力协商或独立启动选项启用，不得悄悄改变旧 `new_session`、`switch_session` 等接口的语义。

现有 `negotiate_protocol` 与协议 v1/v2/v3 涉及传输帧处理与 fork 扩展门控（4.0）。业务能力是否支持多会话，应独立声明，不能仅凭“协议 v3”推断。

### 10.4 异步操作与错误

受理成功不等于操作完成。长操作应能报告运行、等待交互、完成、失败和取消；每次已受理操作应有明确最终结果。

可区分的错误至少包括：会话不存在、会话繁忙、命令不存在、参数错误、能力不支持、技能不可编辑、版本冲突、操作已取消和交互已失效。

命令错误应以命令错误返回，不能将未识别或不支持的命令文本静默转交模型执行。

## 11. 项目与会话管理设计（P1）

### 11.1 需要新增或调整的接口

| 建议接口 | 类型 | 输入与结果要点 | 设计要求 |
| --- | --- | --- | --- |
| `create_session` | 新增 | 接收名称、可选初始化设置；返回新会话身份和状态 | 在本项目进程中创建独立会话；保留已有会话 |
| `list_sessions` | 改造 4.2 既有命令 | 可分页；返回持久化会话及是否已加载、是否运行中 | 不能只列当前内存对象，也不能只列磁盘文件；旧响应字段保留为目录字段 |
| `resume_session` | 新增 | 指定历史会话身份；返回加载后的状态 | 已加载时复用同一实例；不得因重复恢复创建两个运行对象 |
| `close_session` | 新增 | 指定会话及运行中处理策略 | 释放运行资源并保留历史；不关闭项目进程、不影响其他会话 |
| `delete_session` | 改造 4.2 既有命令 | 指定会话身份 | 显式删除持久化会话；与关闭、切换分开；不在后台自动强制中断工作 |
| `get_state`、历史读取、`set_session_name`、`abort` 等 | 扩展现有 | 接收目标会话身份；返回该会话结果 | 保留现有能力，增加明确路由和事件归属 |
| `new_session`、`open_session`、`switch_session` | 兼容保留 | 维持旧模式的既有约定 | 多会话 GUI 使用新生命周期接口；不依赖切换一个共享运行对象 |

`close_session` 默认在会话繁忙时返回可处理的状态；显式选择取消并关闭后，才取消该会话的任务与交互。`delete_session` 不承担隐式“先杀掉所有相关工作”的行为。

### 11.2 “切换会话”的定义

GUI 切换标签或列表选择，只改变显示目标。调用层读取目标会话状态和历史，并显示其事件。它不会调用旧的单会话切换路径来替换项目运行上下文。

多会话可以独立运行。同一会话内的操作顺序由 OMP 控制；不同会话的长操作不得互相占住全局命令队列。取消和交互回应始终应能进入系统。

### 11.3 事件与恢复

增加会话目录变化和会话状态变化通知，覆盖创建、重命名、加载、卸载、删除及运行状态变化（吸收 4.2 的 `sessions_changed`）。

保留历史与状态查询作为权威读取入口。切换界面或重新加载页面后，通过状态读取加后续事件恢复显示，并明确处理读取与事件之间的先后关系，避免漏更新或旧结果覆盖新状态。

首期不要求建立完整持久事件重放系统。项目进程重启后，应能发现并恢复历史会话；正在执行的操作不得伪装为已成功续跑，也不能自动重放可能产生副作用的命令。

### 11.4 生命周期相关内置命令

- `/new` 在多会话模式中创建新会话，返回新会话身份；由桌面决定是否选中它。
- `/resume` 通过会话目录和恢复接口操作目标会话；需要选择时发出交互请求。
- `/quit`、`/exit` 必须明确是关闭会话还是请求退出宿主。推荐 GUI 模式默认结束当前会话视图/运行实例，项目进程退出使用独立的显式动作；该模式差异应展示在命令说明中。
- `/move` 涉及工作目录或项目身份变化，不能直接修改整个进程的全局目录。项目内变化需限定到目标会话；跨项目变化需按命令覆盖表定义宿主协调流程，不能使其他会话随之迁移。

## 12. 技能管理设计（P1）

### 12.1 管理对象

OMP 应成为技能数据与有效状态的权威来源。管理界面所需信息由 OMP 提供，桌面不自行扫描目录并重写加载优先级。

技能条目至少应能表达：

- 稳定身份、名称、说明。
- 来源及作用域：项目、用户、插件等。
- 是否启用、是否对目标会话有效。
- 是否被同名高优先级来源覆盖。
- 是否允许编辑、复制、删除或卸载。
- 当前版本/内容修订，以及加载警告。
- 是否出现在自动技能目录中，以及是否允许用户显式调用。

不要把技能的“隐藏”当成“禁用”。现有 OMP 的 `hide` 技能仍可能通过显式命令调用。

同名技能不能只用名称作为管理对象身份。启停或删除操作必须能定位具体来源；是否因此露出另一个同名来源，应由 OMP 返回解析结果。现有按名称禁用的配置需要兼容，不能无说明地改变其含义。

### 12.2 接口能力清单

| 建议接口 | 类型/优先级 | 输入与结果要点 |
| --- | --- | --- |
| `list_skills` | 扩展 5.6 既有命令，核心 | 返回管理目录，包含禁用、被覆盖、不可编辑项；指定会话时同时返回该会话的有效状态；旧字段（source、warnings、加载诊断）保留 |
| `get_skill` | 新增，核心 | 按技能身份读取详情、正文、资源清单和修订信息；按能力返回可访问内容 |
| `set_skill_enabled` | 新增，核心（取代 5.6 的 `set_skill_source_enabled`/`set_skill_ignored`，见 §17） | 指定技能、启停值和生效作用域；返回新的解析结果及生效状态 |
| `copy_skill` | 新增，核心 | 指定来源技能及目标作用域；复制技能包和相关资源，返回新身份及名称冲突结果 |
| `delete_skill` | 新增，核心 | 删除允许管理的本地技能；插件或外部来源返回对应限制，不能任意递归删除目录 |
| `install_skill`、`update_skill`、`uninstall_skill` | 新增，复用已有能力 | 复用现有安装器和包管理逻辑；指定来源/包和作用域，返回变化及生效状态 |
| `reload_skills` | 新增，核心 | 重新发现指定作用域的技能；返回目录版本、警告及受影响会话 |
| `save_skill` | 可选扩展 | 仅在 GUI 确实需要创建/编辑时纳入；携带预期修订，防止覆盖其他来源的修改 |

技能市场的发布、所有者管理、令牌管理等不属于本方案的 GUI 管理目标。已支持的 `/skills search` 等命令仍应通过统一命令入口工作。

ZCode 的“复制到公共目录”由桌面映射到 OMP 的通用复制能力。目标存储位置遵循 OMP 的技能来源规则；确需保留 ZCode 公共目录时，应将其声明为受支持来源。不要在 OMP 协议中写死产品专用目录名称。

安装、更新的命令入口与管理接口必须调用同一套技能服务，产生一致的状态与事件。若安装器需要脚本确认，应复用交互请求，不应因改走 GUI 而绕过现有确认流程。

### 12.3 修改后的生效规则

技能修改的结果应同时说明“存储是否已变更”和“哪些会话已经采用”。

推荐规则：

1. 项目技能目录由项目服务统一维护，修改后生成新版本。
2. 空闲会话及时更新；新建会话采用最新有效目录。
3. 正在执行的操作保持明确的技能版本，下一次操作前采用更新；不能在执行中混用不同来源或版本。
4. 删除、更新资源等操作如果无法保证当前工作继续读取原版本，应延迟破坏性变更到安全边界，并返回“待生效”，不得先宣称已完成。
5. 用户级技能变更影响其他项目进程时，通过变更检测或重新校验收敛；不得长期保留无法解释的旧目录。
6. 外部编辑技能文件后，显式刷新必须可靠；自动发现变化可以作为后续增强。

发布 `skills_changed`，并更新各受影响会话的 `available_commands_update`。技能管理页、输入补全、命令执行和实际提示上下文必须最终采用同一份有效状态。

### 12.4 与 ZCode 会话技能目录的衔接

ZCode 已区分项目目录和会话使用的技能目录。OMP 同样需要区分“项目当前已发现的技能”和“目标会话当前有效的技能”。

桌面应展示 OMP 返回的会话有效视图。技能在管理页保存成功，不代表所有正在运行的会话已经切换版本；这类差异必须可查询、可解释。

## 13. 内置命令、技能调用与补全设计（P1）

### 13.1 统一命令服务

OMP 内部建立统一命令能力来源，TUI 和 RPC 使用相同的发现、解析、优先级、参数校验和业务执行规则。

现有共享处理器可以继续使用；仅有 TUI 处理器的命令，需要将业务行为抽成不依赖终端组件的能力。TUI 与 GUI 分别承接交互呈现。

例如 `/skills install` 的解析、安装、确认要求和刷新逻辑由 OMP 统一实现；终端状态行与桌面通知仅是不同呈现方式。

### 13.2 接口能力清单

| 建议接口 | 类型 | 输入与结果要点 | 设计要求 |
| --- | --- | --- | --- |
| `get_available_commands` | 扩展现有 | 目标会话；返回命令身份、名称、别名、来源、说明、参数提示、子命令、可用性和限制原因 | 覆盖应接入的 TUI 命令；不能继续仅按是否有通用处理器决定产品可见能力 |
| `complete_input` | 新增 | 目标会话、完整输入、光标位置、输入版本；返回候选、插入内容、替换范围和提示 | 复用命令与扩展补全能力；中文、空格和光标在输入中间时行为明确；不得产生执行副作用 |
| `execute_command` | 新增 | 目标会话及原始命令文本；也可支持目录返回的命令身份与参数；返回受理/完成信息 | 严格按命令分发；复用现有内置命令、技能和模板执行路径 |
| `prompt` | 保留并适配 | 保留现有文本与技能调用兼容路径；增加会话路由 | 与严格命令入口使用一致的解析与执行核心，不形成两套技能语义 |
| `available_commands_update` | 扩展现有事件 | 带会话归属与目录版本 | 技能、配置或扩展变化后及时更新 |
| 现有 UI 请求/响应 | 扩展现有 | 带会话、操作及交互请求身份 | 承接选择、确认、输入、编辑等；取消和过期必须明确 |

不要求为每个斜杠命令新增一个 RPC 方法，也不要求另建一条与现有技能分发不同的“技能执行引擎”。

“提示”包括命令说明、参数占位、使用方式和上下文补全。命令或技能中的提示模板展开仍由 OMP 完成。本方案不新增模型驱动的输入预测服务。

### 13.3 命令覆盖要求

执行 Agent 必须从当前版本的注册表生成完整覆盖清单，逐项归类：

| 命令类型 | 接入方式 |
| --- | --- |
| 已有通用处理器的业务命令 | 复用处理器，补齐会话路由、输出及结果关联 |
| 仅有 TUI 处理器的业务命令 | 抽离业务操作，提供通用交互请求；不能简单从目录中隐藏 |
| 技能调用 | 使用同一技能解析和执行路径；校验有效技能身份与版本 |
| 会话生命周期命令 | 映射为项目内会话管理语义，明确多会话模式差异 |
| 纯界面命令 | 映射到 GUI 现有组件或宿主动作，并在元数据中标明 |
| 明确超出本次范围的命令 | 标明范围和原因；不得将其计入“已实现命令等价” |

覆盖清单至少记录名称/别名、TUI 行为、GUI 目标行为、参数与交互需求、运行中限制、完成状态以及验收场景。

用户要求的内置命令与技能调用是目标集合。范围排除只适用于已经明确不接入的业务能力，或确实仅作用于终端呈现的行为；不能以“当前只在 TUI 中实现”为理由缩小核心交付。

扩展命令和文件命令的既有可用能力应保留。任意第三方扩展的自定义终端组件自动转换为 GUI，不作为首期承诺；这类限制需要明确暴露。

### 13.4 补全与严格执行

补全必须根据目标会话的有效命令、技能和上下文生成。输入改变或界面切换后，过期补全结果不得覆盖新输入。

候选结果明确区分显示文本与实际插入文本，并定义光标位置与替换区间的计量方式。桌面负责展示和插入，OMP 负责补全规则。

提交已识别的命令但参数错误、技能已经禁用或版本已失效时，应返回相应错误。尤其不能将这类文本作为普通模型请求继续执行（5.3 的 `/plan` 文本拦截为既有先例）。

### 13.5 交互与取消

优先扩展现有 `extension_ui_request` / `extension_ui_response`，承接业务命令中的交互；确需宿主动作时增加通用动作类型。

等待用户选择时，仅该操作进入等待状态。其他会话仍可继续工作。关闭会话、取消命令或进程结束后，相关交互应失效，迟到回应不得恢复已取消操作。

纯宿主动作应明确是选择界面、导航或生命周期请求。OMP 保留业务状态的控制权，桌面返回用户选择或动作完成情况。

## 14. 仅增加 RPC 接口仍不足的内部调整（P1）

| 必须调整的方向 | 为什么属于 OMP | 推荐设计方向 |
| --- | --- | --- |
| 项目内多会话容器 | 外部调用层无法让单个运行对象变成多个独立会话 | 评估抽取 ACP 已有会话管理基础，供 RPC 复用；避免另写一套长期分叉的生命周期 |
| 命令与终端 UI 解耦 | 业务代码直接引用 TUI 上下文时，转发协议不能替代真实交互 | 统一业务处理与交互抽象，TUI/RPC 各自呈现 |
| 动态补全服务 | 现有补全依赖会话上下文和运行时回调 | 将可复用补全规则下沉，提供协议可序列化的候选结果 |
| 技能管理与生效统一 | 保存文件与会话采用新技能是两个阶段 | 统一来源解析、管理操作、版本与会话刷新 |
| 全局状态与共享缓存审查 | 单进程会话共存后，全局“当前会话”假设可能串扰 | 优先检查技能全局快照、工作目录、注册表、扩展及工具 UI 上下文；按作用域注入或隔离 |
| 调度与资源释放 | 一个会话等待时，不能阻塞其他会话或取消入口 | 按会话调度；共享目录写入单独协调；关闭只释放目标会话资源 |
| 配置作用域 | 模型、技能开关、项目配置的影响范围不同 | 统一声明会话/项目/用户作用域，并发布真实影响范围 |

`activeSkills` 是已经发现的具体审查点。其他项目属于必须检查的方向，本文不声称它们都存在已确认的缺陷。

共享项目目录并不自动提供代码文件隔离。本次不引入每会话工作树或文件冲突合并系统；不得将“会话运行状态隔离”宣传为“所有文件副作用隔离”。

## 15. P1 交付边界与实施阶段

### 15.1 P1 必须交付

- 项目进程内多会话共存，以及创建、发现、恢复、关闭和基本持久化管理。
- 明确的会话路由、事件归属、取消和交互隔离。
- 技能查看、启停、复制、删除、安装/更新/卸载与刷新能力；管理行为与命令行为共用后端。
- 命令目录、严格执行、说明与动态补全；核心 TUI 命令可通过 GUI 路径执行。
- 技能变化到命令目录及会话有效状态的完整传播。
- 新旧 RPC 行为边界与能力协商。
- 可供桌面调用层映射的接口说明、命令覆盖清单和验收证据。

### 15.2 可后续增加（P2 性质，不属本期交付）

- GUI 内完整技能编辑器及其创建/保存入口（`save_skill` 同此）。
- 外部文件变化的自动监测；首期必须有可靠显式刷新。
- 历史会话的自动内存淘汰策略；首期至少支持显式卸载。
- 完整事件持久化与断线重放（对位 6.7）。
- 任意第三方 TUI 自定义组件的通用 GUI 宿主。
- 跨项目会话迁移的完整产品体验；但首期必须明确 `/move` 的可用范围与限制。

### 15.3 不应顺带扩展

远程桌面控制、新聊天或编程产品流程、绘图功能、文件检查点/回滚体系、技能市场发布体系、分布式后台服务，以及把 ZCode 的整套产品协议复制进 OMP。

这些项目不作为本次验收的隐含前提。

### 15.4 实施阶段

以下是交付顺序和设计约束，不是代码修改步骤。执行 Agent 应在每阶段开始时自行确定具体实现和测试方法。

| 阶段 | 要解决的问题 | 阶段交付物 | 进入下一阶段的条件 |
| --- | --- | --- | --- |
| A：基线与契约确认 | 当前版本哪些能力已有、哪些绑定 TUI；接口语义与范围是否一致 | 版本记录、命令覆盖表、技能操作映射表、协议能力清单 | 每个核心入口均有明确目标行为；未知项和范围限制单列 |
| B：多会话运行基础 | 一个项目进程如何容纳独立会话 | 会话管理能力、作用域规则、状态与事件路由、共享状态审查结果 | 同项目 5 会话一个主进程；A 的执行、取消和关闭不破坏 B |
| C：技能管理闭环 | 管理操作如何成为实际有效状态 | 技能接口、同名来源规则、修订/生效策略、变化通知 | GUI 所需管理行为能够通过 RPC 完成，且有效状态与调用结果一致 |
| D：命令与补全统一 | TUI 功能如何通过 RPC 可发现、可补全、可执行 | 通用命令能力、严格执行、动态补全、交互协议、覆盖表结果 | 核心命令均有等价业务结果；不支持项明确；没有静默模型回退 |
| E：接入契约验证 | ZCode 现有入口是否能通过调用层接通 | 基于真实界面服务契约的映射验证、旧 RPC 回归证据、异常与重启验证 | 技能管理、输入命令、多会话三个完整场景通过 |

B 完成后，C 与 D 的设计可以交叉推进，但必须共享同一技能目录与变更规则。本文件不要求采用多 Agent 并行实施。

阶段 E 的职责是验证既有界面能够被这些能力支撑。若必须新增大规模界面或把 OMP 状态逻辑重新搬到桌面，应回到本方案检查职责划分。

## 16. 验收场景（P1）

下表是执行 Agent 应证明的行为，本文未执行这些测试。

| 编号 | 场景 | 必须证明的结果 |
| --- | --- | --- |
| A01 | 同一项目连续创建 5 个会话 | OMP 主进程 PID 不变；5 个会话身份独立；新增会话没有另起 OMP 主进程 |
| A02 | A 运行时创建/恢复 B 并切换界面 | A 保持运行；B 可独立接收命令；无事件或输出串入错误会话 |
| A03 | A 等待选择或长操作时操作 B | B 可响应；取消入口可用；整个进程未被等待操作阻塞 |
| A04 | 关闭或取消 A | B 的运行、交互和历史不受影响；A 的迟到回应被正确处理 |
| A05 | 关闭后恢复同一历史会话 | 历史与身份可识别；重复恢复不会产生两个活跃实例 |
| A06 | 新建、卸载、恢复大量空闲会话 | 主进程数稳定；卸载后资源释放；记录内存与句柄变化，不能只验证 PID |
| A07 | 项目技能与用户技能同名 | 管理页能区分来源；有效来源与实际调用一致；修改一个条目不会不透明地改另一个 |
| A08 | 查看、启停、复制、删除技能 | 接口反馈与实际存储及加载状态一致；不可修改来源返回明确原因 |
| A09 | 安装/更新技能，或外部修改后刷新 | 命令目录、补全和受影响会话更新；已运行操作的版本行为符合约定 |
| A10 | 同一技能隐藏与禁用的对比 | 隐藏是否仍可显式调用符合 OMP 语义；禁用后严格调用给出正确结果 |
| A11 | GUI 输入内置命令、别名、子命令和技能命令 | 与同版本 TUI 对应业务结果一致；每个覆盖项有证据 |
| A12 | 中文输入、带空格参数、光标位于中间、快速连续输入 | 补全替换范围正确；旧响应不覆盖新输入；补全无执行副作用 |
| A13 | 调用仅有 TUI 实现的核心命令，例如技能安装 | 使用共用业务能力；需要确认时通过 GUI 交互完成；未忽略原确认要求 |
| A14 | 未知命令、错误参数、已禁用技能、过期交互 | 返回可区分的错误；没有静默转发模型或恢复已取消任务 |
| A15 | 技能写入冲突及插件技能修改 | 不无声覆盖新内容；不能把只读来源当普通目录删除 |
| A16 | 运行过程中重启项目进程 | 新实例身份可识别；历史可恢复；旧结果不污染新状态；不会自动重放副作用命令 |
| A17 | 两个项目引用用户级技能，随后修改它 | 各项目按约定检测并采用变化；差异与待生效状态可解释 |
| A18 | 原有单会话 RPC 客户端 | 既有接口与约定保持兼容；未声明新能力时不会收到无法理解的新语义 |
| A19 | ZCode 现有技能服务、命令输入、会话列表契约 | 三个入口均可由调用层完成映射，不需要桌面另实现技能解析或命令业务逻辑 |

性能验收应记录测试环境、会话数量、主进程与子进程分类、启动时间、内存和资源释放趋势。本文不承诺未经测量的内存降幅或延迟数值，也不把“共用一个主进程”等同于“每会话几乎没有额外成本”。

## 17. 合并处置：冲突裁决与回退/迁移清单

本节固定《rpc-ui 桌面应用协议扩展》与顶层设计合并后的冲突裁决。**裁决原则：冲突以顶层设计（§9–§16）为准。** 未列入本表的已实现能力一律保留。

| # | 已实现项（出处） | 处置 | 说明 |
| --- | --- | --- | --- |
| 1 | 4.4 宿主进程池模式（EOF 语义 + `open_session` 恢复，E2E 通过） | **废止目标模式，无需回退代码** | “每会话一个进程、宿主保活”的约定由 §11“每项目一个 OMP 主进程、多会话共存”取代。EOF 有序退出与 `open_session`/`get_messages_page` 恢复保留为单会话兼容路径与旧客户端回归基线，4.4 的 E2E 继续有效；“唯一生命周期方案”的地位表述废止 |
| 2 | 4.2 `list_sessions {scope:"cwd"\|"all"}`（`rpc-fork-sessions.ts`） | **改造为项目会话目录语义** | 多会话模式下返回本项目持久化会话 + 是否已加载/运行中（11.1）；旧响应字段（title/cwd/created/modified/messageCount/status/pinned 等）保留为目录字段；`scope:"all"` 的跨工作区聚合职责移交宿主（每项目进程各自提供目录）；未声明多会话能力的客户端继续获得现行为 |
| 3 | 4.2 `delete_session {sessionFile}`（拒绝活动会话） | **迁移为按会话身份删除** | 底层复用 `deleteSessionWithArtifacts`；“拒绝删除活动会话”改为新语义：繁忙时返回可处理状态，显式选择取消并删除才中断，不在后台自动强制中断工作（11.1）；旧参数形态在兼容层保留过渡 |
| 4 | 4.2 `pin_session`/`unpin_session`/`rename_session`/`sessions_changed` | 保留 | 置顶仍为全局存储、作为目录展示字段；`rename_session` 与会话命名统一（多会话下按会话身份）；`sessions_changed` 并入 11.3 的会话目录变化事件（覆盖创建/重命名/加载/卸载/删除/运行状态变化） |
| 5 | 5.6 `set_skill_source_enabled`/`set_skill_ignored`（写 `skills.enable*`/`ignoredSkills`） | **被 §12 `set_skill_enabled` 取代** | P1 交付新接口并通过验收后，旧两命令 MUST NOT 与新接口并存为第二套管理语义：移除，或收敛为同一实现的兼容别名（由实现定，须在交付说明中写明）。底层配置键保留为兼容存储；按名称禁用的既有含义不无说明地改变（12.1） |
| 6 | 5.6 `list_skills`（source/warnings/加载诊断） | 原位扩展 | 扩展为 12.2 的管理目录（含禁用、被覆盖、不可编辑、会话有效状态），旧字段保留 |
| 7 | 5.6 “技能删除与选择性导入为 P2” | **范围调整：删除/复制升为 P1** | `delete_skill`/`copy_skill` 为 P1 核心交付（12.2）；`save_skill` 与选择性导入维持可选/P2 |
| 8 | 4.0/4.1/4.3、5.1–5.5、5.7、5.8 全部已实现命令与帧 | 保留，无回退 | 多会话模式落地时按 §10 为会话级请求、事件与 UI 请求（`permission_request`、`ask_request`、`queue_updated`、`hook_executed` 等）补可选的会话归属字段；未声明多会话能力的客户端行为不变 |
| 9 | 5.3 `/plan` 文本拦截 | 保留并推广 | 作为严格命令分发（13.4）的既有先例，纳入 §13 统一命令服务 |
| 10 | 协议版本语义（4.0 v3 门控） | 保留并增补 | fork 扩展命令/帧继续经 v3 协商门控；多会话、技能管理、严格命令、补全为业务能力，经能力发现独立声明（10.3），不凭 v3 推断 |

回退风险控制：处置 2/3/5 涉及已实现行为的语义变化，MUST 保留未声明多会话能力客户端的旧路径（与 4.0 门控一致），并在交付时提供旧 RPC 客户端回归证据（A18）。

## 18. 给执行 Agent 的交接要求

1. 先核对仓库版本。若实现基线与 2.2 所列不同，重新检查相关现状，记录差异；不要把本文件建议接口误认成仓库已有接口。
2. 以三项核心需求（1.2）和本文件的行为约束为目标，自行选择具体代码结构。
3. 优先复用 OMP 已有会话、技能、命令与交互能力；新增接口不代表底层能力必须重写。
4. 涉及 TUI 业务处理迁移时，同时验证 TUI 原有行为，避免形成两个独立实现。
5. 对每个核心命令逐项记录实现状态；不能用少量命令跑通替代全量覆盖清单（13.3）。
6. 不以隐藏命令、在 GUI 中硬编码命令表、为每会话新增主进程，或直接从桌面修改技能目录的方式完成验收。
7. 不擅自加入范围外业务（15.3）。遇到与保留现有 GUI 的要求冲突时，提交具体入口、所缺协议能力和最小替代设计。
8. 实施前先按 §17 处置已实现冲突项；未列入 §17 的已实现能力一律保留，不为新需求顺带重构。
9. 交付应包含：变更说明、接口契约、命令覆盖表、技能生效说明、兼容说明、验收结果与真实剩余限制。

## 附录：源码依据

以下链接固定到顶层设计审阅版本，用于核对现状；它们不是要求执行 Agent 必须按这些文件逐个打补丁。

| 主题 | 源码依据 |
| --- | --- |
| RPC 现有接口与事件 | [OMP rpc-types.ts](https://github.com/can1357/oh-my-pi/blob/d1932a6ff85613dde1160b87a73ddcdc3beb01f6/packages/coding-agent/src/modes/rpc/rpc-types.ts) |
| RPC 单会话结构、命令分发及补全空实现 | [OMP rpc-mode.ts](https://github.com/can1357/oh-my-pi/blob/d1932a6ff85613dde1160b87a73ddcdc3beb01f6/packages/coding-agent/src/modes/rpc/rpc-mode.ts) |
| ACP 的多会话管理基础 | [OMP acp-agent.ts](https://github.com/can1357/oh-my-pi/blob/d1932a6ff85613dde1160b87a73ddcdc3beb01f6/packages/coding-agent/src/modes/acp/acp-agent.ts) |
| 命令目录与通用处理器过滤 | [OMP available-commands.ts](https://github.com/can1357/oh-my-pi/blob/d1932a6ff85613dde1160b87a73ddcdc3beb01f6/packages/coding-agent/src/slash-commands/available-commands.ts) |
| TUI 与通用命令上下文 | [OMP slash-commands/types.ts](https://github.com/can1357/oh-my-pi/blob/d1932a6ff85613dde1160b87a73ddcdc3beb01f6/packages/coding-agent/src/slash-commands/types.ts) |
| TUI 动态补全构建 | [OMP builtin-registry.ts](https://github.com/can1357/oh-my-pi/blob/d1932a6ff85613dde1160b87a73ddcdc3beb01f6/packages/coding-agent/src/slash-commands/builtin-registry.ts) |
| 技能命令绑定 TUI 的实例 | [OMP builtin-skills.ts](https://github.com/can1357/oh-my-pi/blob/d1932a6ff85613dde1160b87a73ddcdc3beb01f6/packages/coding-agent/src/slash-commands/builtin-skills.ts) |
| 技能全局快照、隐藏语义与发现逻辑 | [OMP skills.ts](https://github.com/can1357/oh-my-pi/blob/d1932a6ff85613dde1160b87a73ddcdc3beb01f6/packages/coding-agent/src/extensibility/skills.ts) |
| 技能刷新及命令目录通知 | [OMP session-tools.ts](https://github.com/can1357/oh-my-pi/blob/d1932a6ff85613dde1160b87a73ddcdc3beb01f6/packages/coding-agent/src/session/session-tools.ts) |
| 技能安装、更新与卸载 | [OMP skillshare/installer.ts](https://github.com/can1357/oh-my-pi/blob/d1932a6ff85613dde1160b87a73ddcdc3beb01f6/packages/coding-agent/src/skillshare/installer.ts) |
| 自动学习技能工具的管理边界 | [OMP manage-skill.ts](https://github.com/can1357/oh-my-pi/blob/d1932a6ff85613dde1160b87a73ddcdc3beb01f6/packages/coding-agent/src/tools/manage-skill.ts) |
| ZCode 的技能管理服务入口 | [ZCode skills.ts](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/services/src/skills/skills.ts) |
| ZCode 的项目/会话技能目录区分 | [ZCode useSkills.ts](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/hooks/useSkills.ts) |
| ZCode 按工作区维护进程 | [ZCode zcodeAgentProcessManager.ts](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/services/src/zcode-agent/zcodeAgentProcessManager.ts) |
