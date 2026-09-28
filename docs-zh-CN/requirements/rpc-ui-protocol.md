# rpc-ui 桌面应用协议扩展

> **状态：第一期实施中（批次 0 与批次 1 已合入：4.0 协商基建、4.1 权限审批第一档、4.2 会话列表、4.3 富 ask、4.4 生命周期 E2E 均已实现并按实际验证范围标注）。** 本文档是 rpc-ui 协议扩展的唯一权威需求：第 4–6 节为完整功能需求（P2 条款同为有效需求与明确待实现规划，不因当前未实现而删减验收条件），第 7 节为协议演进与上游同步约束，第 8 节为验证要求，三者对实现同等强制。桌面 App 本体的 UI 实现不在本仓库范围；本仓库的交付物是 `omp --mode rpc-ui` 的协议与服务端能力。

## 1. 背景与目标

### 1.1 背景

fork 计划基于 omp 的 RPC 模式（`omp --mode rpc-ui`；协议实现位于 `packages/coding-agent/src/modes/rpc/`，权威协议文档为 `docs/rpc.md`）实现一个桌面 App，核心功能对齐 ZCode 桌面端的 agent 核心域：会话主视图、输入区（Composer）、权限与答疑交互、任务/会话列表与工作台、工作流/子代理/计划/后台任务、设置页中与 Agent/模型相关的分区（对照清单：《ZCode UI 功能清单（Agent 核心）》，存放于本机 ZCode 工程目录，不属于本仓库）。

截至上游基线 v18.4.2，该协议是**单会话 stdio 驱动协议**：JSONL 帧、v1/v2 分帧协商、约 40 个命令、`AgentSessionEvent` 原样转发（消息帧附 `messageId`）、`extension_ui_request/response` 通用弹窗桥、host tool 与 host URI 反向通道、子代理三级订阅。一进程任一时刻只持有一个活动会话；stdin EOF 即拒绝全部挂起请求并退出进程。对照桌面 App 需求的全量缺口分析（2026-09-28 基于当前 `main` 只读核对）结论：

* 消息时间线流式渲染、模型/思考档切换、压缩与重试 marker、子代理订阅与回放、斜杠命令目录等主干能力已具备；
* 交互层缺口（权限审批、富答疑、排队队列、任务列表、后台任务、计划模式）的底层能力大多现成（ACP 权限网关、ask 富对话框、队列 API、会话列表/置顶、job 控制、plan 状态），只是未暴露到 RPC；
* 配置面（设置读写、模型供应商与模型 CRUD、MCP CRUD、技能管理、用量统计）底层完整，RPC 零暴露；
* 工作流运行时、自动化（定时/闲时任务）、IM 机器人渠道、套餐付费在 omp 底层整体不存在。

### 1.2 目标

* 把桌面 App 第一期（P0–P1）所需能力补进 rpc-ui 协议与服务端；优先包装既有底层能力，MUST NOT 为协议扩展重造已有运行时。
* 完整需求（含 P2）全部固定于本文档；P2 条款是有效需求与明确规划，排期实施时不得反过来按实现现状删减需求。
* 协议扩展 MUST 与上游增量演进共存：未协商 fork 扩展的客户端 MUST 获得与现状一致的行为（见 4.0）。

### 1.3 范围与非目标

* 范围：`packages/coding-agent/src/modes/rpc/` 的协议扩展，及为暴露底层能力所需的最小挂钩（工具审批门、子会话 UI 委托、plan 状态拆分、goal 迭代计数等）；配套更新 TS 客户端 `rpc-client.ts` 与 Python 客户端 `python/omp-rpc/`。
* 非目标：桌面 App UI 实现本身；TUI/ACP/print/SDK 等其它模式的行为改变（审批门挂钩除外，见 4.1——它 MUST 保持 ACP/TUI 路径行为不变）；ZCode 特有且与本 fork 个人使用定位冲突的条目按第 6 节各小节的处理方式执行。

## 2. 现状基线（协议事实）

以下为本文档撰写时（2026-09-28，上游 v18.4.2 + fork main）经源码核对的协议事实，作为需求的对照基线；实现时以代码为准：

| 事实 | 说明与出处 |
| --- | --- |
| 传输与帧 | 子进程 stdio JSONL；物理帧上限 1 MiB，v2 逻辑帧重组上限 64 MiB（`rpc-frame.ts`）；命令带可选 `id`，响应 `{type:"response",command,success,data?/error?,code?}`，未知命令报错且循环继续 |
| 协商 | 启动即发 `ready`（现公告 `supportedProtocolVersions:[1,2]`）；`negotiate_protocol {protocolVersion:2}` 升 v2（`rpc-mode.ts`） |
| 命令面 | `RpcCommand` 联合约 40 个：prompt 族、状态族、模型/思考档、队列模式、压缩、重试、bash、会话切换/分支、消息分页、登录、host tools/URI、子代理订阅与回放（`rpc-types.ts:24-94`） |
| 事件面 | `AgentSessionEvent` 原样转发（message_start/update/end、tool_execution_*、auto_compaction_*、auto_retry_*、model_changed、goal_updated、notice 等）+ 子代理三帧 + `prompt_result`/`session_settled`/`available_commands_update` 等控制帧 |
| 单会话进程 | 一进程一活动会话；`new_session/switch_session/branch/open_session` 切换；无会话列表枚举命令 |
| EOF 语义 | stdin EOF → 拒绝全部挂起 UI/host 请求 → drain → dispose → 退出（`rpc-mode.ts` 尾部） |
| 工具审批现状 | 审批门在 `extensibility/extensions/wrapper.ts` 的 `execute` 内：`uiContext.select(formatApprovalPrompt(...), ["Approve","Deny"])` 纯文本二选一；无结构化载荷、无 allow_always 语义、拒绝无理由回传；ACP 模式另有完整权限网关（`session/acp-permission-gate.ts`、`session/session-tools.ts`、`session/client-bridge.ts`）但仅挂在 ACP clientBridge 上 |
| 答疑现状 | rpc-ui 下 `ask` 工具降级为逐题 `extension_ui_request select`；富对话框 `askDialog`（多题/preview/倒计时）存在于 TUI 与 ACP（`modes/acp/acp-agent.ts`），RPC 未实现 |
| 队列/后台任务现状 | session 层已有 `getQueuedMessages/clearQueue/replaceQueues`（`agent-session.ts`）、`getAsyncJobSnapshot`（同文件）、`snapshotJobs/executeCancel`（`async/job-control.ts`），RPC 仅暴露 `queuedMessageCount` 计数与文本 `/jobs` 输出 |
| 会话列表现状 | `session/session-listing.ts`（`listAllSessions` 等）、`session-pins.ts`（全局置顶）、`updateSessionTitle`、`deleteSessionWithArtifacts` 均为底层现成能力，RPC 未暴露 |

## 3. 分期与优先级

| # | 缺口 | 优先级 | 修改大小 | 底层现状 | 第一期实现 |
| --- | --- | --- | --- | --- | --- |
| 1 | 工具权限审批专用协议 | P0 | 中 | ACP 网关现成，未接入 RPC | 是 |
| 2 | 会话/任务列表命令族 | P0 | 小-中 | 列表/置顶/重命名/删除现成 | 是 |
| 3 | 富 ask 答疑帧 + 倒计时暂停 | P0 | 小-中 | 富对话框与 ACP 映射现成 | 是 |
| 4 | 会话进程生命周期（宿主进程池） | P0 | 小（fork 侧） | EOF 语义保留，宿主持有进程 | 是 |
| 5 | 排队消息面板命令 | P1 | 小 | session API 齐全 | 是 |
| 6 | 后台任务结构化命令 | P1 | 小 | job-control 现成 | 是 |
| 7 | 计划模式命令化 | P1 | 小-中 | plan 状态/文件 API 齐全，TUI-only | 是 |
| 8 | 历史分页倒序 + 流式期可读 | P1 | 小-中 | 正向分页已有 | 是 |
| 9 | 附件通道扩展 | P1 | 中 | 仅 images 内联 | 是 |
| 10 | 配置与管理面（设置/供应商/MCP/技能/子代理/用量） | P1 | 中-大（分期） | 底层完整，RPC 零暴露 | 是（分期，见 5.6） |
| 11 | 文件与目录搜索命令 | P1 | 小 | 无（同机可绕过） | 是 |
| 12 | 会话状态补全（goal 快照与迭代、钩子遥测、赞/踩反馈） | P1 | 小-中 | 部分有 | 是 |
| 13 | 会话组织（归档/分组/已读未读/变更统计） | P2 | 中 | 底层零（或宿主自建） | 否 |
| 14 | 工作流运行时整套 | P2 | 特大 | 底层整体缺失 | 否（需产品决策） |
| 15 | 自动化（定时任务/闲时任务） | P2 | 大 | 底层零 | 否 |
| 16 | IM 机器人渠道 | P2 | 特大 | 底层零 | 否 |
| 17 | 套餐与付费 | P2 | 特大 | 底层零 | 否（占位，倾向不实现） |
| 18 | 远程工作区（SSH 会话） | P2 | 大 | 仅 ssh:// 文件 IO | 否 |
| 19 | 协议级 detach/attach 与事件回放 | P2 | 大 | 无 | 否 |
| 20 | 零星（调用轨迹/反馈上报/CUA 状态/btw 辅助对话/画板） | P2 | 小-中 | 零星 | 否 |

优先级定义：P0 = 没有它桌面 App 的核心体验不成立；P1 = 核心功能明显缺口，第一期一并实现；P2 = 完整需求与明确规划，实现前部分条目需先做产品决策（14）。

以下纯客户端能力不构成协议缺口，桌面 App 自行实现，本仓库 NEVER 为其改动协议：虚拟滚动与贴底跟随、分屏与窗格管理、IME/快捷键/草稿与输入历史持久化、划词引用（拼 prompt 文本）、会话内查找（客户端分页拉取后本地搜索）、时间线分组折叠渲染、状态面板布局、通用确认弹窗。

## 4. P0 需求（第一期·第一批）

### 4.0 协议协商：版本 3

* fork 构建下 `ready` 帧公告 `supportedProtocolVersions:[1,2,3]`；`negotiate_protocol {protocolVersion:3}` 成功后启用本文档定义的全部 fork 扩展命令与帧；v3 隐含 v2 分帧能力。
* 未协商 v3（或协商 v1/v2、非 fork 构建）的客户端 MUST 收到与现状一致的行为：不收到任何新帧，发送新命令得到现有 `Unknown command` 错误响应；工具审批退回 `extension_ui_request select("Approve","Deny")`，ask 退回逐题 select。
* 协商失败与降级路径 MUST 有自动化测试覆盖（见第 8 节）。

> 实现状态（2026-09-28）：已实现并通过验证。`ready` 公告 `[1,2,3]`、`negotiate_protocol` 接受 v3（成功数据 `{protocolVersion:3}`，v3 隐含 v2 分帧）、fork 门控分发框架落地（`packages/coding-agent/src/modes/rpc/rpc-fork-types.ts`、`rpc-fork-host.ts`，挂钩于 `rpc-mode.ts` negotiate/default/控制帧/EOF 四处）；UT+E2E 见 `packages/coding-agent/test/rpc-fork-protocol.test.ts`（v2 降级、无效版本拒绝、bypass 帧不消费均覆盖）。

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
  prefixSuggestion?: string   // 4.1 前缀档（2026-09-28 契约增补）：bash 首词前缀建议（含尾随空格），供 allow_always_prefix
}
```

* 新旁路帧（客户端 → 服务端，即时分发，同 extension_ui_response 模式）：

```text
permission_response {
  id: string
  option: "allow_once" | "allow_session" | "allow_always" | "allow_always_prefix" | "reject_once" | "reject_always"
                             // allow_always_prefix 为前缀档选项（2026-09-28 契约增补）：按请求携带的
                             // prefixSuggestion 持久化前缀规则并放行本次调用
  feedback?: string           // 拒绝理由，≤ 4096 字符，附给模型
}
```

* 新命令：`set_approval_mode {mode: "always-ask"|"write"|"yolo"}`（运行时切换，会话内生效并写回设置）；`get_state` 响应 MUST 增补 `approvalMode` 字段；`config_update` 帧增补该字段。

**行为规则**：

* 审批门实现 MUST 复用 ACP 权限网关的选项语义与既有抽象（`session/acp-permission-gate.ts`、`session/session-tools.ts` 的 `#wrapToolForAcpPermission`、`session/client-bridge.ts`），以 RPC 实现注入同一 bridge 接口；MUST NOT 复制一份平行逻辑。TUI 与 ACP 路径行为 MUST 保持不变。
* `allow_session`：会话内存效（对齐 ACP 内存 Map 语义）；`allow_always`/`reject_always`：写入既有配置键 `tools.approval.<tool>: allow|deny` 并依赖既有热加载，重启后仍生效；命中已允许策略时不再发帧。
* `feedback` 非空时，拒绝错误文本 MUST 附带理由回传给模型（替换裸 `Tool call denied by user`）；空 feedback 保持现状文案。
* 子代理会话的审批 MUST 委托到宿主 UI：为子会话注入携带 `origin` 标注的委托 UI context（落点 `task/executor.ts` 子会话构建处），子代理审批请求在主连接上呈现并带来源徽标；委托失败按现状 fail-closed 报错。
* bash 命令前缀级"始终允许"（`allow_always_prefix`，前缀规则持久化）为同一审批协议的第二档能力：验收分两档（见下），第一档交付整工具级 allow_always 即可，前缀规则 MUST 在第一档交付后、第一期结束前补齐，并扩展 `tools/approval` 的策略键以支持前缀粒度。
* 超时/断连：v3 客户端断连时挂起审批按现状 fail-closed（拒绝并报错）；不引入审批静默放行路径。

> 前缀档实现状态（2026-09-28）：已实现（第一档交付同批）。`allow_always_prefix` 按请求携带的 `prefixSuggestion`（bash 首词+尾随空格）持久化到新增设置键 `tools.approvalPrefixes.<tool>`（`tools/settings.ts`），命中前缀规则的后续调用不再发帧；整工具策略键不受前缀档影响（只放行匹配前缀的命令）。UT 覆盖建议生成、规则持久化与去重、命中跳帧、未命中仍审批（`test/rpc-fork-permission.test.ts`）。

**验收条件**：

1. `always-ask` 下 edit 类工具调用触发带 `toolCallId`、`details`、`input` 的 `permission_request`，客户端可据 `input`（oldString/newString 等）渲染 diff 预览并与工具行关联。
2. `allow_always` 后同工具后续调用不再触发请求，重启进程后仍生效（配置已持久化）；`allow_session` 仅本会话生效。
3. 拒绝且带 feedback 时，模型收到的工具错误文本包含理由。
4. 子代理发起的审批在主连接收到且 `origin` 正确；TUI/ACP 路径回归不变。
5. `set_approval_mode` 运行时生效，`get_state`/`config_update` 反映当前档位。
6. 未协商 v3 的客户端全程行为与现状一致（既有审批 select 路径）。

> 实现状态（2026-09-28）：第一档（整工具级 allow_always）已实现，服务端在 `packages/coding-agent/src/modes/rpc/rpc-fork-permission.ts`（经 `session.setClientBridge` 注入 ACP 权限网关，`task/executor.ts` 注入 origin 子代理委托桥）；`set_approval_mode`/`get_state.approvalMode`/`config_update.approvalMode` 同步落地。UT 覆盖审批帧结构、五选项语义、allow_always/reject_always 配置持久化、feedback 回传、子代理 origin、断连 fail-closed、v2 门控（`test/rpc-fork-permission.test.ts`）；真实模型驱动 E2E 见 `test/rpc-fork-approval-e2e.test.ts`（需 API key，本机验证环境未运行）。**前缀档（allow_always_prefix）未实现，本期结束前补齐。**

### 4.2 会话与任务列表

**需求**：暴露会话枚举与任务列表操作，支撑桌面 App 侧栏任务区（列表、置顶、重命名、删除）。

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
* 不预选任何选项；多选题空提交 = 合法"全不选"；单选题未作答而 `cancelled` = 整个 ask 工具 abort（对齐现状）；空答案提交的"明确跳过"语义由 answers 结构表达（`selected: []`）。
* 草稿按 `ask_request.id` 保留为客户端职责，协议不提供草稿重开。

**验收条件**：

1. 多题 ask 一次下发，客户端分页渲染、逐题/整体提交均正确收敛到工具结果。
2. 多选、Other 自定义输入、`chat` 转向、`cancelled` 四条路径结果正确。
3. 倒计时期间 `ask_pause` 或任意响应后不再自动收尾；未暂停时到期仍按 recommended 收尾。
4. `sensitive` 输入在 login 流可用（v2 仍拒绝）。
5. 未协商 v3 时逐题 select 降级路径与现状一致。

> 实现状态（2026-09-28）：已实现（`packages/coding-agent/src/modes/rpc/rpc-fork-ask.ts`，`RpcExtensionUIContext.askDialog` 按 v3 激活动态暴露，未协商时该方法不存在、ask 工具自动走逐题 select）。UT 覆盖 ask_request 结构（timeoutMs/deadlineAt）、answers/chat/cancelled 三路径、多选空提交、Other 自定义、未知标签过滤、`ask_pause` 幂等（暂停后不再自动收尾）、到期 recommended 收尾、abort 取消帧、断连 fail-closed（`test/rpc-fork-ask.test.ts`）。`extension_ui_request` 的 `input`/`editor` 增补 `sensitive?: boolean`，login secret 输入 v3 解禁、v1/v2 保持拒绝（`rpc-mode.ts` login 臂）；`input.sensitive` 的真实 login 流 E2E 依赖外部 OAuth 提供方，未在本机验证。

### 4.4 会话进程生命周期（宿主进程池模式）

**需求**：桌面 App 需要"关闭窗格（会话继续运行）"、多窗格多会话与断线恢复。第一阶段采用**宿主进程池**模式，fork 侧不新增协议。

**行为规则**：

* fork 侧 MUST 保持现有 EOF 语义不变（stdin EOF → 有序退出），并保持 `open_session`（按目录续接最新非空会话）与 `get_messages_page` 的恢复能力稳定——这是宿主侧断线恢复的协议依赖。
* 宿主约定（对桌面 App 的契约性说明，不是本仓库实现项）：关窗格时宿主保持子进程 stdin 打开、仅解除 UI 绑定；重开窗格复用同一进程；宿主重启后按 `open_session` + 分页重拉恢复；跨进程任务列表实时性由宿主轮询 `get_state`/`list_sessions` join。
* 协议级 detach/attach 与事件回放为 P2（见 6.7），在其实施前本条是唯一生命周期方案。

**验收条件**：

1. 现有 EOF 有序退出与 `open_session` 恢复行为有 E2E 覆盖（真实 `omp --mode rpc-ui` 进程：kill 宿主 → respawn → open_session → 历史完整）。
2. 本条不引入协议改动；回归以既有 RPC 测试为准。

> 实现状态（2026-09-28）：已实现且 E2E 通过。真实 `omp --mode rpc-ui` 进程验证 EOF 有序退出（exit 0）、kill 宿主 → respawn → `open_session` 续接同一会话文件 → `get_messages` 历史一致（`test/rpc-fork-lifecycle.test.ts`）。

## 5. P1 需求（第一期·第二批）

### 5.1 排队消息面板

* 新命令：`get_queue` → `{ steering: [{id,text,imageCount}], followUp: [...] }`；`remove_queued {queue:"steering"|"followUp", entryId}`（条目 id 命名为 `entryId`，避免与命令关联 `id` 撞名——2026-09-28 契约修订）；`reorder_queue {queue, ids}`（全量顺序）；`clear_queue {queue?}`。
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

### 5.4 历史分页倒序与流式期可读

* `get_messages_page` 增补 `order?: "asc"|"desc"` 与锚点游标（`before`/`after`），支持从尾部向前的倒序分页；放宽 `session_busy`：流式/压缩期间 MUST 允许读取历史页（只读快照），仅游标绑定的活跃窗口语义保持。
* 行为：倒序页与正向页在同一会话上结果一致（顺序相反）；贴顶预取不得影响活跃流推送。
* 验收：流式中贴顶预取成功；超大会话倒序翻页与 `get_messages` 全量结果一致；`stale_cursor` 语义保留。

### 5.5 附件通道扩展

* `prompt/steer/follow_up/abort_and_prompt` 增补 `attachments?: Attachment[]`：

```text
Attachment = { kind: "file", path, mime? }        // 同机文件引用（首选，避免大帧）
           | { kind: "data", mime, data }          // 内联 base64，受物理帧上限约束
```

* 支持类型：图片（与现有 `images` 等价并保留 `images` 兼容）、PDF、纯文件；视频为 P2（底层模型输入能力未定，先不承诺）。
* 错误码：`attachment_too_large`、`attachment_unsupported`、`attachment_unreadable`；数量上限（8）与超限错误码 `attachment_limit`。
* 行为：附件随用户消息持久化（会话存储沿用现有自定义消息载荷），历史回放可见；`kind:"file"` 在发送时读取一次，不建立持久附件 id（重传语义 = 重发消息，第一期不引入上传会话）。
* 验收：PDF/文件附件端到端入会话且历史可见；超大/超限/不可读分别返回对应错误码；仅用 `images` 的旧客户端不回归。

### 5.6 配置与管理面（分期实施，第一期完成 A/B 两档）

完整需求覆盖桌面 App 设置页；按依赖分期，第一期实现 A 档（必用）与 B 档（设置页主体），C 档为 P2（见 6.8 相关条目）。

**A 档（第一期先做）**：

* `get_settings {scope} / set_settings {scope, key, value} / unset_settings {scope, key}`：包装 `createSettingsHost`（`config/settings-ui.ts`），凭据字段 MUST 脱敏返回；作用域 = 用户（`~/.omp/agent/config.yml`）/ 项目（`.omp/config.yml`）既有分层。
* `list_providers` → 供应商与模型清单（合并内置目录、`models.yml`、运行时发现状态）；`upsert_provider {provider}` / `delete_provider {provider}` / `set_model_enabled {provider, modelId, enabled}`：写 `models.yml` 与既有 `enabledModels/enabledProviders/modelProviderOrder` 设置键，复用现有校验（`validateProviderConfiguration`）。
* `test_model {provider, modelId}`：实测连通性，失败归因至少区分 认证失败/模型未找到/限流/网络/服务端/未配置 endpoint 六类（参考 `dry-balance` 实测路径与 provider 发现状态机）。

**B 档（第一期后段）**：

* MCP：`list_mcp_servers`（含连接状态与失败分类，源用 `mcp:connection-status` 事件与 `MCPFailureClass`）、`upsert_mcp_server / delete_mcp_server / set_mcp_server_disabled / mcp_reconnect`：包装 `mcp/config-writer.ts` 全套。
* 技能：`list_skills`（含 source、warnings、加载诊断）、`set_skill_source_enabled / set_skill_ignored`：包装 `extensibility/settings.ts` 既有键；技能删除与选择性导入为 P2。
* 子代理定义：`list_agent_definitions / upsert_agent_definition / delete_agent_definition`：包装 `task/discovery.ts` 发现与定义文件读写；颜色标记与单独启用开关为 P2 扩展字段。
* 用量与统计：`get_usage {provider?, days?, history?}`（包装 `packages/ai/src/usage` 模块，结构与 `omp usage --json` 一致）；`get_stats_summary {range}`（包装 `packages/stats` 聚合，即"根据本地会话历史估算"口径）。
* 事件：`settings_changed {scope}`（设置文件变更通知，尽力推送，配合既有热加载）。

**验收条件**：

1. 设置读写经 ACP/RPC 与直接编辑文件语义一致，热加载后新会话生效；凭据不以明文回传。
2. 供应商/模型增删改后 `get_available_models` 与 TUI 模型面板反映一致；`test_model` 六类归因有构造用例覆盖。
3. MCP 增删改与启停后重连生效，失败分类可渲染设置页错误行。
4. `get_usage`/`get_stats_summary` 输出与对应 CLI（`omp usage --json`、`omp stats`）一致口径。

### 5.7 文件与目录搜索

* 新命令：`search_paths {query, cwd?, limit?}` → `{entries: [{path, type:"file"|"dir"}]}`，默认上限 1000，匹配遵循既有忽略规则与 `fs-scan-cache` 架构。
* 用途：输入区 `@` 面板数据源；远程 transport（TS 客户端 spawn 抽象支持 SSH）下唯一可行路径。
* 验收：模糊查询命中文件与目录；忽略规则生效；上限与截断提示明确；空查询返回有界默认集。

> 实现状态（2026-09-28）：已实现（`packages/coding-agent/src/modes/rpc/rpc-fork-search.ts`，包装 native `fuzzyFind`，hidden+gitignore+cache 与 TUI @ 面板同参；默认上限 1000、绝对路径输出、`truncated` 标志；native 不可用时错误码 `search_unavailable`）。UT 覆盖文件+目录命中、忽略规则、非法参数（`test/rpc-fork-queue-jobs-search-state.test.ts`）。

### 5.8 会话状态补全

* `get_state` 增补 `goal?: { goal, state, iteration }`；`goal_updated` 事件增补 `iteration`（迭代序号，底层 `goals/state.ts` 增设计数）。后接入的客户端可从 `get_state` 拿到当前 goal 快照（现仅事件推送）。
* 新事件 `hook_executed { hookId, event, source, durationMs, status, reason? }`：扩展 runner 增补 per-hook 遥测（事件名、来源用户/工作区/插件、耗时、状态），支撑助手轮次"钩子详情"。
* 新命令 `submit_feedback { messageId, rating: "up"|"down", comment? }`：落本地轻量存储（config root 下 jsonl），无任何上报；赞/踩失败可重试。
* 客户端配套：TS 客户端事件 allowlist 补 `config_warnings_changed/advisor_cost_changed/advisor_yielded`（现被静默丢弃，属客户端侧缺陷）。
* 验收：goal 面板可显示迭代序号与暂停/继续状态；一轮含 hook 的会话可经事件还原逐 hook 列表；feedback 落库可查。

> 实现状态（2026-09-28）：已实现。`Goal.iteration` 计数（`pi-tui/tools/goal.ts` + `goals/runtime.ts` onTurnStart 递增），`get_state.goal` 快照经 `RpcForkStateController.goalSnapshot`（`rpc-fork-state.ts`），`goal_updated` 经 `Goal.iteration` 携带；`hook_executed` 经 runner 新增 `setHookExecutedListener`（`extensibility/extensions/runner.ts` 四个出口：ok/timeout/error/aborted）+ `RpcForkHookTelemetry` 源分类（user/workspace/plugin）；`submit_feedback` 落 `<configRoot>/agent/feedback.jsonl`（无上报）。UT 覆盖迭代快照、源分类与 v3 门控、feedback 落库与非法 rating（`test/rpc-fork-queue-jobs-search-state.test.ts`）；含 hook 的真实轮次事件流验证依赖扩展 hook 用例环境（extensions-runner.test.ts 回归通过）。TS 客户端 allowlist 增补随客户端同步批次落地。

## 6. P2 完整需求（待实现规划）

以下条款为有效需求与明确规划，当前未实现；实现排期后以本节为验收依据，MUST NOT 按实现现状反向删减。

### 6.1 会话组织：归档、分组、已读未读、变更统计

* 协议方案：会话元数据存储扩展（归档位、分组 id/颜色/顺序、已读游标、+N/−N 统计缓存），命令族 `archive_session/unarchive_session/list_sessions?filter=archived/delete_archived`、分组 CRUD 与排序命令、`mark_session_read/unread`。
* 允许的替代路径：上述状态由桌面 App 宿主侧自建本地存储（以 `sessionId` 为主键），fork 仅保证 `list_sessions` 提供足够的 join 键；两条路径择一，不得并存造成双写。
* +N/−N 统计来源：会话内 edit/write 工具结果的行级统计聚合（服务端）或宿主侧解析（二选一，实现前定案）。

### 6.2 工作流运行时（需产品决策）

* 完整需求（对齐 ZCode 工作台）：工作流 run 生命周期（待启动/运行中/已完成/出错/已停止 + 停止原因 + 血缘 lineage + resumable + 并发上限与冷却）、阶段脊线投影（阶段状态灯、分支结构、名册、步数、轮次⟳n）、子代理药丸与会话回放、脚本步骤日志簿、待答问题行、产物区（交付物、kind、版本步进、按 kind 预览）、配置弹层（子代理模型、并发上限、调整=另起新 run）、CreateWorkflow 工具卡与稿号、轮尾运行卡、完成卡、后台通知行、任务列表运行行。
* omp 底层现状：无工作流运行时（最接近原语：task 批量 schema、workpool、todo 阶段、async jobs）。
* 实施前 MUST 先做产品决策，三选一：(a) 新建工作流运行时（工作量特大）；(b) 桌面 App 以 task+todo+ask 模拟（无 Resume/血缘/轮次/冷却，体验降级需明示）；(c) 第一版砍掉工作流域。决策记录追加到本节，未决策前不实施。

### 6.3 自动化：定时任务与闲时任务

* 协议方案：cron/闲时任务的 CRUD（频率、指令、模型与档位、模式、最大运行次数、最早可用时段）、运行历史、立即运行/暂停/继续/取消、唤醒条件下（"仅在电脑处于唤醒状态时运行"为宿主能力，协议只表达状态）。
* 底层现状：仓库无 scheduler/cron 代码；实施时先补运行时（宿主持有或 omp 常驻进程，实现前定案），再暴露命令。

### 6.4 IM 机器人渠道

* 完整需求：渠道接入（微信/飞书/Lark/Telegram/Webhook）、绑定码轮询、回复颗粒度、允许工作区。底层零实现；可参考 collab 的 relay 拓扑。实施为全新后端子系统。

### 6.5 套餐与付费（占位）

* ZCode 的套餐/权益卡、升级弹窗、支付面板需求在此仅保留占位。本 fork 不以对外发布为目标、无套餐体系，默认不排期；若未来需要，须先建订阅后端再谈协议。

### 6.6 远程工作区（SSH）

* 现状仅 `ssh://host/path` 文件读写/搜索（内部 URL）。完整需求：远程工作区会话（cwd/bash 在远端执行）、MCP/技能同步到远端、"远程"徽标数据源；TS 客户端 spawn 抽象已支持 SSH transport 作为传输前提。

### 6.7 协议级 detach/attach 与事件回放

* 完整需求：会话进程与 UI 连接解耦（关连接不终止会话）、多客户端 attach 同一会话、事件序列号与断线回放（从上次序号续传）、跨进程会话运行态聚合投影（sessions-index 类实时 join）。
* 在此之前，生命周期由 4.4 宿主进程池模式承担；本条实施时 MUST 保持 4.4 路径可回退。

### 6.8 零星条目

* 调用轨迹查询：模型请求/响应 wire 记录与查询命令（现状仅失败请求 dump 且 RPC 错误帧剥离路径；需先补成功请求的记录存储与脱敏）。
* 用户反馈上报：远端上报通道（本地 `submit_feedback` 已在 5.8；上报为增强）。
* CUA 电脑控制状态：设置分区查询、运行中动态授权帧、macOS 权限状态徽章（computer 工具与 safety checks 底层已有，缺状态查询命令）。
* /btw 辅助对话：`side_conversation` 命令包装 `runEphemeralTurn`/BtwController（底层现成；现状 RPC 下 `/btw` 文本会当普通 prompt 发给模型，属已知缺陷，实施本条时修复）。
* 画板（白板导出 PNG）：omp 无概念，经 `set_host_tools` 由宿主实现，不建协议。

## 7. 协议演进与上游同步约束

* **兼容性**：所有新增命令/帧仅在对 `negotiate_protocol` v3 协商成功后生效（4.0）；`RpcCommand`/`RpcResponse` 联合以追加成员方式扩展，MUST NOT 改动既有成员的形状；既有事件的增补字段（如 `goal_updated.iteration`）为可选向后兼容。
* **上游同步**：fork 扩展的服务端实现 MUST 集中在 `packages/coding-agent/src/modes/rpc/` 下的 fork 专有模块（如 `rpc-fork-permission.ts`、`rpc-fork-sessions.ts` 等），对上游文件（`rpc-types.ts`、`rpc-mode.ts`、`wrapper.ts`、`task/executor.ts`、`agent-session.ts` 等）只保留最小挂钩点（联合类型追加、单一分发挂钩、bridge 注入点），降低同步冲突面；这与仓库"fork 改动最小、集中、内聚"的总体约束一致。
* **客户端**：TS 客户端（`rpc-client.ts`）与 Python 客户端（`python/omp-rpc/`）随服务端同步扩展，保持三端契约一致；Python 客户端 `request_raw()` 可先行验证新命令。
* **协议文档**：`docs/rpc.md` 为上游文档，fork 不在其中追加条款；本文档是 fork 扩展的唯一协议说明，新增命令 MUST 在本文件契约化后才可实现。

## 8. 验证要求

* **UT**：每个新命令/帧在 `packages/coding-agent/test/` 下有协议层测试（参照既有 RPC 测试布局），覆盖成功路径与关键失败路径（unknown 命令、非法参数、v2 降级、审批断连 fail-closed、倒计时暂停幂等、附件错误码、游标过期）。复用底层 API 的包装命令以边界测试为主，不为覆盖率复测底层逻辑。
* **E2E**：从真实公开入口（`omp --mode rpc-ui` 子进程）跑通：v3 协商 → 权限审批全选项流（含 allow_always 持久化与子代理来源）→ 富 ask 多题与暂停 → 会话列表/置顶/重命名/删除 → 队列增删改 → 后台 job 取消 → plan 进入/退出/审批 → 流式期倒序预取 → 附件入会话 → 设置变更后新会话生效。宿主进程池断线恢复（kill 宿主 → respawn → `open_session` → 历史一致）必须包含。
* **门禁**：TS 改动后 MUST 运行 `bun run fastcheck`；`bun run fulltest`/`slowtest` 按仓库验证规则仅在用户明确要求时运行。
* **状态标注**：P0/P1 条目在实现并通过对应 UT+E2E 前保持"未实现"；P2 条目 NEVER 标记为已验收。每期交付时更新本文件状态行与 `fork.md` 链接说明，不追加修复历史。
