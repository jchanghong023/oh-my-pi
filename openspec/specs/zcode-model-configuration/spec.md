# zcode-model-configuration

## Purpose

规定 ZCode 对原生模型目录、profile、role、临时模型与 Team 全局配置的协议投影。保存必须使用原生配置所有者；全局 Team 设置不要求聊天会话。

## Requirements

### Requirement: 模型配置

OMP MUST 将 ZCode 的模型目录、role 保存及临时模型操作适配到原生所有者，投影真实结果并隔离目标上下文；全局 Team 配置不依赖聊天会话。

#### Scenario: 模型配置的详细边界

- **WHEN** 本节所述功能在适用条件下运行
- **THEN** 以下具体约束适用：


ZCode 提供完整 role 配置界面和持久保存能力，包括未配置项、自定义 role、保存结果、并发修改及配置来源的处理。

ZCode 的 role 保存请求必须路由原生 Settings 服务并投影其回执与冲突，不在 Host 或 GUI 拼写配置；界面取消不派发保存。

**原生模型目录与 GUI 投影**

- 同一配置根、运行 profile、cwd 和有效环境下，GUI 模型目录必须严格等于原生 TUI 可用目录，沿用原生筛选与认证裁决；Host 账户、旧 ZCode provider registry 与 GUI 不得增删、合并或重新排序出第二份事实。
- GUI 必须完整展示原生投影中的免凭据可用模型，不以旧 Host 登录态、`providerRuntime.modelSelection` 或配置文件存在作为额外就绪／过滤门禁；ready 和不可用原因直接来自原生事实。
- GUI 以 `workspace-config` 的 `configOptions` 中 `id:"model"` 且选项非空的原生模型配置为目录来源，完整消费 provider 身份与显示名、支持的思考档位及默认思考档位；不按模型名称猜 provider 或能力。`currentValue` 必须是 OMP 原生 `default` role 真实解析出的模型身份，不能取目录首项或旧 Host 默认值。未手选的新会话初值跟随该原生默认；已存在会话保留原生会话临时模型及档位。
- `workspace-config` 由 app-server 投影发布，registry、Settings、认证或 role 有效事实变化后重新解析并发布；GUI 热更新目录、档位与默认值，迟到的旧 workspace／profile／连接代际响应不得覆盖新事实。presentation 的 mode／命令恢复不得清空已收到的模型投影。
- 非空原生模型配置来源具有绝对优先级；来源缺失或选项为空时，仅沿当前已有机制显示真实空态或等待态，不回落 Host 注入目录，不调用账户同步、注入 provider 源或新增目录查询协议，不捏造模型或就绪状态。
- 原生 registry／Settings 是模型、role 与认证事实的唯一 owner；app-server 只投影，Host 只路由／保留已接受投影，GUI 只消费和提交既有模型操作。桌面与手机向同一 owner 投递，分别保留 desktop-continuous 与 web-remote-replayable 的恢复语义。




**多 profile、多 role 与临时模型界面**

- 三者是 OMP 核心优势，均须在界面提供可发现入口；不能把 OMP 压缩为 ZCode CLI 的单套模型设置。页面显示实际执行端、当前原生 profile、配置来源及作用范围；无法支持的操作仍保留可见并明确原因。
- GUI 的 profile 选择路由到原生启动入口，不改写正在运行进程的全局 profile；旧会话继续绑定原执行端，切换不得静默停止或迁移运行中任务、复制配置或认证。
- `omp/profiles/list` 的附加返回包含原生实际 `configRoot` 与稳定 `storageScope`；后者标识实际有效持久数据域与运行 profile，而非仅配置文件根，在相同域重启后保持；offline 临时 shm 域映射回持久数据域，不采用进程随机身份或待重启选择。`configRoot` 含义不变。OmpCode 的任务组织索引、草稿与 Recent 隔离消费此可信事实，应用侧具体所有者及切回恢复合同由 ZCode 仓 FORK-004 维护。
- 会话删除的已完成墓碑只供历史／账本扫描确认缺席，不构成 profile 切换 blocker；只有实际进行中的创建、恢复、关闭和删除才阻塞切换。并发恢复同一会话可以共用一次打开，但不能静默忽略调用方不兼容的目录、MCP 或工具策略。
- 设置页枚举默认／命名 profile，选择由应用持久化并于完整退出重启后生效；不热切换正在运行的同一原生进程。待重启期间设置页、会话工具栏及 Host 持久写入边界均禁止向旧 profile 保存角色，并明确说明原因；当前会话临时模型仍保持既有运行语义。
- role 界面展示原生完整角色目录、未配置项及自定义角色，分别编辑保存，保留无损原值、来源、revision、冲突和保存回执；只写目标 role，不顺带更改 Team、当前主模型或其他 profile。
- GUI 临时模型选择请求绑定显式目标会话，显示该会话返回的实际生效值；取消不派发修改，目标会话或连接代际变化后不应用迟到结果。

**Team 模型配置接口**


**能力发现与通用约定**

- 传输与能力发现使用既有附加式扩展：`omp/team/configure` 携带 operation 与参数（schema 在 `packages/coding-agent/src/modes/zcode/schema/omp-config-extension.ts`，不改任何既有方法与 vendored schema），能力经 `runtime/capabilities` 的 `ompConfiguration` 宣布；沿用既有请求关联与分帧，不增加协议大版本、HTTP 服务或独立连接。旧版本未声明该能力时 GUI 禁用配置入口并说明不支持，不能改读配置文件兜底。
- 三个 Team 配置操作属于运行 profile 的全局用户配置，通过显式 workspace 作可信进程路由和模型目录解析，不依赖、不创建也不绑定聊天会话。均不接受任意路径、跨 profile 写入、凭据或 YAML 文本；GUI 切换 workspace／profile 后重新读取，不要求切换或重启进程。
- 写入的模型引用使用 `provider`／`modelId` 组成的具体身份，不接受自然语言、通配符、`auto` 或思考级别扩展。查询采用下述无损槽位表示，原始 selector 即使失效也不能丢弃；只读预览可以携带该原文用于诊断，不能借预览将其写入。顺序及重复项完整保留，响应不含密钥、完整配置文件或无关设置。
- 正常响应与失败回执沿用 ZCode 协议 `omp/team/configure` 的 result／error 信封（data 结构以扩展 schema 为准）及机器可读错误码。外层 `error.code` 仍是数字；共享配置服务的字符串错误码保留在 `error.data.code`，已有问题索引、实际保存回执及可取得的最新配置一并保留。GUI 不从错误消息文本解析状态。

**`get_team_config`**

请求含 `id`、`type:"get_team_config"` 及可选 `preview`（见后文），不执行模型推理、不发起讨论、不修改配置。明确打开配置时可以按需读取原始 NFS 持久主配置以展示双方原值；不扫描其他目录，不进入启动回源。未提供 `preview` 时只返回已保存配置的查询快照；返回 `data`：

| 字段                | 契约                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `profile`           | 当前命名 profile；默认 profile 为 `null`                                                                                                                                                                                                                                                                                                                                                                                 |
| `revision`          | 当前用户层目标配置的不透明版本；Linux offline 联合覆盖活动和持久两端目标字段的原始值、缺失状态及实际文件身份，不是进程内计数。任一必要目标存在结构非法／重复键或不可安全读取时为 `null`；仅 selector 失效／模型不可用不影响版本生成                                                                                                                                                                                      |
| `userMembers`       | 活动端用户层的完整有序 `TeamMemberSlot[]`；字段缺失为 `null`，显式空名单为 `[]`，结构非法或不可读时省略。是否可读由 `storage.active.readState` 判定，不能把读失败或失效成员当成字段缺失                                                                                                                                                                                                                                  |
| `persistentMembers` | 原始 NFS 端同一 profile 的完整有序 `TeamMemberSlot[]`；字段缺失为 `null`，显式空名单为 `[]`。结构非法、不可读或单端模式不适用时省略，由 `storage.persistent.readState` 区分；不得只返回 `different` 而隐藏持久端原值                                                                                                                                                                                                     |
| `effectiveMembers` | 当前有效基础名单的完整有序 `TeamMemberSlot[]`，失效项原位保留；默认回退保留为 `[]`，不从当前聊天会话补入模型。结构非法时为 `null` 并附问题 |
| `source`            | 当前有效配置来源：`default`、`global`、`project`、`overlay` 或 `runtime`；无法确定时为 `null`。不因为某行模型不可用而抹去已知来源                                                                                                                                                                                                                                                                                        |
| `participants` | 按显式有效名单展开的 `{index,label,model}` 槽位；默认回退及无法展开时为空，不从聊天会话读取主模型来生成配置预览。默认回退的实际运行模型在启动讨论时确定 |
| `issues`            | 每项含 `code`、`message`、`target`。`target:"member"` 时必须含 `list`、零基 `index` 和原始 `selector`，`list` 精确指向 `userMembers`、`persistentMembers` 或 `effectiveMembers`；有效名单问题另含其 `source`。其他 target 为 `config` 或 `storage`；用户配置文件／存储问题必须有 `side:"active"` 或 `"persistent"`，高层配置问题则用 `source` 标识、不伪填用户文件 side。可含安全的逻辑文件标识及行／列 |
| `writableScopes`    | 本能力仅支持 `["user"]`，不借此修改项目、overlay 或运行时层；服务无法保存时可返回空数组，并附原因                                                                                                                                                                                                                                                                                                                        |
| `storage`           | `{mode,syncState,active,persistent}`；`mode` 为 `single` 或 `offline_shm`。每端 `{readState}` 明确 `present`、`missing`、`invalid`、`unreadable`，持久端另可为 `not_applicable`；`present` 指目标字段是合法的字符串列表，包括 `[]`，`missing` 包括字段或文件缺失。`syncState` 为 `in_sync`、`different`、`unknown` 或 `not_applicable`，比较两端本次字段的原始有序值及缺失状态，不比较整文件；单端持久端不适用           |
| `preview`           | 仅在请求含合法 `preview` 时返回的只读草稿投影；结构与语义见下文，不替换以上已保存快照                                                                                                                                                                                                                                                                                                                                    |

**无损成员槽位 `TeamMemberSlot`：** `{index,rawSelector,model,name?,status,reasonCode?,reason?}`。`index` 为原列表零基位置，`rawSelector` 原样保留配置中的字符串（不擅自 trim、改写大小写、去重或丢行）；`model` 为能确认身份时的具体引用，否则为 `null`；`status` 为 `available`、`unavailable` 或 `unresolved`，后两种必须给原因。例如用户列表 `[p/A,"失效旧别名",p/B]` 必须返回三行，中间行的 `model:null` 不得造成 A、B 丢失或索引前移；高层也有失效项时用不同 `list/source` 精确归属。重复映射键、非数组或非字符串成员属于结构非法，不伪装成模型失效；仅无法解析或当前不可用的字符串成员仍可显示并修复。

GUI 编辑 `userMembers`，分别展示 `persistentMembers` 和 `effectiveMembers/source`，不能把高层名单自动保存回用户层或在两端有差异时盲目覆盖。`revision:null` 时禁止保存，先修复结构／读权限并重读；结构可读但模型失效时必须能取得 revision，用候选替换或删除原槽位后提交修复。`writableScopes` 不得仅因旧模型失效就清空。

**只读草稿预览**

保留三个接口，不增加第四个预览接口。`get_team_config` 可带 `{preview:{clientRevision,members}}`：`clientRevision` 为 GUI 草稿版本的非空不透明字符串，服务原样回传；`members` 与保存的数组／`[]`／`null` 语义相同。为诊断未修复的旧槽位，数组项额外允许 `{rawSelector:string}`，只读解析为真实候选或带问题的槽位，不进行自然语言猜选。写接口不接受此原文变体。

```json
{
	"id": "team-preview-1",
	"type": "get_team_config",
	"preview": {
		"clientRevision": "draft-7",
		"members": [
			{ "provider": "company", "modelId": "GLM-5.2-public" },
			{ "rawSelector": "失效旧别名" },
			{ "provider": "company", "modelId": "Qwen3.8-27B" }
		]
	}
}
```

返回 `data.preview:{clientRevision,userMembers,effectiveMembers,source,participants,issues}`，列表及槽位采用上面的无损结构，内部成员问题的 `list` 指向 `preview.userMembers` 或 `preview.effectiveMembers`。共享服务先在内存中投影拟保存的用户层值，再按真实项目／overlay／运行时优先级计算预计有效值及运行槽位；高层覆盖不因用户草稿改变而消失；默认回退只显示配置选择，不解析任何聊天会话的主模型。不合法的保留槽位返回问题、不得生成部分成功的运行槽位。

预览仅校验与计算，不能保存、隔离／修复文件、启动保存锁、触发备份或修改 Settings 的持久／运行时层；默认回退和清除也只作投影。已保存快照字段不被草稿替换，GUI 同时展示实际和预计结果。GUI 按 workspace／profile 及 `clientRevision` 丢弃过期响应；没有问题的预览也不是锁定目录或承诺随后保存必成功，保存仍须重新校验版本及资格。TUI 复用同一只读方法，不各自重写槽位算法。

**`get_team_models`**

请求：`{id,type:"get_team_models",query?:string}`。省略或空查询返回当前上下文全部已知聊天候选，支持 GUI 本地过滤；不受当前成员、少数预置模型或其他界面的最近使用列表限制，不截断为前若干项。模型数据、可选资格和原因由共享服务提供；非聊天模型不进入此目录。

返回 `data.models` 数组，每项为 `{model,name,selectable,reasonCode?,reason?}`。`model` 是具体模型引用，`name` 是展示名称；`selectable:false` 必须有原因。原因至少区分未认证、被禁用／当前范围不允许、Team 不支持的后端 Agent 或必要能力缺失；可选性不等于真实提供者认证／任务质量已验证。旧成员不论是否仍在候选目录，都在 `get_team_config` 对应完整列表中保留原始槽位和问题。

`query` 对名称、ID、provider 及已核实的中文别称／简称进行确定性候选搜索，不通过模型推理理解名称，不自动选择或改写成员。无法唯一确定的别称返回全部真实匹配，零匹配返回空数组，不拼造 selector 或静默选“最新”。唯一结果供普通 Agent 代配使用，GUI 仍由用户确认。offline 保留原离线目录策略，不为查询或刷新回退到公网，也不修改认证／启用策略。

**`set_team_config`**

请求使用完整列表替换，不增加逐项写接口：

```json
{
	"id": "team-save-1",
	"type": "set_team_config",
	"scope": "user",
	"expectedRevision": "opaque-revision-from-get_team_config",
	"members": [
		{ "provider": "company", "modelId": "GLM-5.2-public" },
		{ "provider": "company", "modelId": "Qwen3.8-27B" },
		{ "provider": "company", "modelId": "GLM-5.2-public" }
	]
}
```

示例 ID 必须以目标环境实际目录为准。`members` 为具体模型引用数组、`[]` 或 `null`：非空数组保存有序名单；`[]` 保存显式默认回退；`null` 移除用户层字段。不可省略 `members`，不把省略、非法类型、空字符串或未知 ID 当成重置。`scope` 只接受 `"user"`；`expectedRevision` 为必需的非空字符串。

- 保存前重新核对当前候选资格，非法项返回零基位置及原因，不静默删除；允许重复身份。全局配置不查询聊天会话的主模型，也不以会话运行条件阻止成员修复。
- 校验 revision、重复键和实际目标后，按[双写权威要求](../offline-shm/spec.md)的统一锁顺序持有 NFS 跨主机锁与活动端本机锁，在锁内重读、比较双方版本，首次提交前发现冲突不改任一配置。同旧版本的合作写入不能因锁只在本机生效而双双通过；保存阶段第二端 I/O 或目标身份变化仍须返回实际部分／未知结果。
- `success:true` 仅表示本请求在锁保护下将所有必要目标确认保存或判定同值无变更，并完成锁内读回；不代表没有高层覆盖。返回 `data` 含 `config`（随后取得的最新查询快照，含两端原值／读取状态）、`saveState`、`writes`、`effectiveMatchesRequested` 及可选 `effectiveNote`。`writes` 是本请求已确认的提交事实，不冒充永久不变的现值；若随后查询已被新保存改变，`config` 展示现值并明确说明，不把它伪造成此前请求未提交。
- `saveState` 为 `complete`、`partial`、`failed` 或 `unknown`；`writes` 含 `active` 与 `persistent`，每端为 `{status,message?}`，`status` 为 `saved`、`unchanged`、`failed`、`not_attempted`、`unknown` 或 `not_applicable`。普通单端模式的 `persistent` 为 `not_applicable`，不是重复写同一路径。
- 所有必要目标都已确认完成且读回成功才为 `complete`；部分目标已完成而其他未完成为 `partial`；确定没有提交且失败为 `failed`；任何关键提交／读回事实无法确定为 `unknown`。后三种均 `success:false` 并携带已知回执；部分或未知不是可自动重试的普通失败。
- `effectiveMatchesRequested` 是布尔值；存在高层覆盖或不能确定有效值时为 `false` 并给 `effectiveNote`，不能用保存成功遮蔽未生效。清除／空名单时按删除用户字段／默认回退语义判断，不与非空运行槽位机械比较。
- 复用 `invalid_params`、`scope_not_allowed`、`revision_conflict`、`persistence_failed`、`execution_failed`；本能力增加 `invalid_config` 区分重复键、非法 YAML 等必须先修复的配置问题。前置校验失败为 `failed`、两端 `not_attempted`；错误 data 可附 `issues` 和可安全取得的 `config`。返回错误码不能抹去实际提交状态。
- 本能力只改 `team.members`，不写 `models.yml`、role、凭据或 provider 开关，不创建／迁移数据库，不触发真实模型探测。失败或连接断开后 GUI 先重新查询，不自动重放保存或用旧 revision 覆盖。

**GUI 展示、通知与配置上下文隔离**

GUI 提供专用 Team 模型配置面板，交互能力和预览按 Team 第 2.9 节，不要求用户了解配置文件或 shm。打开时读取完整用户／NFS 持久／有效三份列表及各自问题，分别展示具体原值、读取状态和覆盖来源；失效原槽位不得丢弃或把两端不同简化为一个告警。草稿编辑、排序、复制、删除后通过可选 `preview` 查询共享投影，不逐次写盘；保存时将所有修复后的具体模型引用一次提交，使用返回快照更新页面，不能在请求发出时乐观标为已持久化。

- 交互形态对齐 ZCode 既有样式：成员名单与模型候选是查询返回的有序列表（`get_team_config`／`get_team_models`），面板内选择框由 GUI 依据候选数据本地渲染，保存只提交具体 `provider`／`modelId`（同 `switchModelConfig` 形态），不在扩展里另造选择框 wire。

- 完整保存且生效、保存但被项目／overlay 覆盖、两端部分保存、结果未知及并发冲突分别展示；版本冲突保留草稿，允许重新读取并比较，不能直接自动重试。取消不调用保存；恢复默认只改草稿。
- 保存后复用现有 `settings_changed {scope:"user"}` 事件，不增加另一套订阅总线。面板收到事件或重新获得焦点时按需重读；有脏草稿时提示外部变化而不覆盖草稿。其他进程不能依赖此进程的广播，最终正确性依赖后端重新读取与版本检查。
- 面板请求与草稿绑定发起 workspace／profile，切换、关闭或失联后不得把旧响应写到新面板；取消界面不证明已发保存请求未提交，必须依据回执或重新查询。配置保存不占用模型生成通道，不阻塞停止讨论和普通消息。
- 经对话方式提交 `/team configure` 时，宿主须通过已有对话机制接入同一配置服务或明确指引 GUI 使用本能力，不把配置命令交给模型，不输出虚假保存成功。原 `/team <任务>` 派发及状态协议不变。

#### Scenario: 模型配置的可观察行为

- **WHEN** GUI 配置 profile、role、临时模型或全局 Team
- **THEN** ZCode 请求到达明确的原生 owner，结果投影不跨会话／profile；全局 Team 配置不消费聊天会话事实
