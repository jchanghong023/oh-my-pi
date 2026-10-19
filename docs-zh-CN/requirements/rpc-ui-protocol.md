# ZCode 接入需求

使用 ZCode 的界面框架与风格，以 OMP 作为 Agent 核心。模型服务和认证就绪后，用户无需手工编写 OMP 配置文件即可开始使用；ZCode 负责必要的启动与接入。共同场景约束见 [Fork 定位](fork.md#项目定位与使用场景)。

## 多会话与消息

支持多个会话同时运行。一个会话等待用户回答时，不阻塞其他会话；消息、停止和问答按所属会话处理。

不要求同一项目的会话共用一个 OMP 进程，允许每个会话独立进程。具体实现优先复用上游能力。

保留普通消息、流式回答、工具过程、停止、执行中插话和排队补充，以及创建、历史恢复、关闭、改名和删除会话。改名不得破坏旧格式（无标题槽）会话文件；改名和删除均不得直接改写其他进程仍托管（存活）的会话文件，须在持有相应所有权租约时操作，否则以可辨识错误拒绝。本进程托管的会话改名仍通过活跃会话 API 执行；拒绝沿用上游「会话存活优先」语义，不新增审批流程。

运行宿主恢复或切换到持久会话时，须在首次写入前取得并持续持有同一所有权租约；其他进程已持有时明确拒绝接管，切换失败保留原会话及其所有权，关闭后释放。纯历史读取、导出和渲染不取得运行所有权。`--no-session` 目录进程按当前 cwd/profile 的标准持久会话目录执行目录操作，不因自身不持久化而使用空目录；持久宿主已有的显式会话目录优先。

上述功能的具体行为，包括忙时限制、失败处理、停止后的内容保留和恢复语义，统一跟随上游 OMP，不维护 fork 独立规则。

真实 `agent://` 消息的成功投递回执保留总线生成的消息 ID 与发送时间，每个广播收件人使用其实际消息身份；写工具原有结构化结果直接持久化这些字段，使接入方在冷恢复时可将发送与接收记录幂等关联。不新增通信日志或猜测处理回执，失败仍保留真实失败语义。

## 权限与提问

权限行为与上游 OMP 默认保持一致，不维护 fork 自有权限策略，不新增 ZCode 权限审批界面。不得将“不做审批界面”解释为自动放行或自动拒绝。

保留模型向用户提问、用户回答后继续执行的交互。接入时须核对上游权限流程与无专用审批界面的兼容性。

## 命令与技能

保留完整命令目录、动态参数补全，以及命令和技能调用。目录来自实际注册信息，避免另行维护人工清单。

终端专属命令可以明确报告不支持。调用及错误处理优先跟随上游，不为界面另造业务语义。

### 必须接入的命令

`--mode rpc-ui` 必须支持 `/wiki`、`/repo`、`/team`、`/plan`、`/loop`、`/goal`、`/goal-autopilot`、`/advisor`、`/ultrathink`、`/orchestrate`、`/workflowz`、`/jch-workflowzbatch`、`/fullsend`、`/skill:<name>` 与 `/compact`。正文中的 `ultrathink` 等魔法关键词仍按共享会话规则生效；它不是 `/advisor` 的参数。

- 保留协议 v3，统一通过现有 `prompt.message` 提交命令。命令目录、别名与参数提示来自实际注册信息，补全复用现有机制；RPC 专属入口登记在同一命令规格中。已识别但仅限 TUI 的命令必须明确拒绝，不能把它原样交给模型执行。
- 文字结果与状态通过 `command_output` 返回，选择、输入和确认通过现有 `extension_ui_request` / `extension_ui_response` 完成。不新增 ZCode 专属面板协议或平行业务实现；下文明确规划的 Team 模型配置采用 RPC v3 共享配置接口，不另造界面传输协议。
- `/wiki` 提供已有索引的查看、检索、新建与删除；仍只有 init/remove 两种维护动作，业务契约见 [文档索引](fork.md#markdown-文档索引)。`/repo` 提供状态、首次确认建立、更新、重建恢复、删除及进度和取消，业务契约见 [代码定位索引](repo-index.md#用户入口repo-内置命令)。RPC 对话作为用户入口，与终端面板使用同一服务。
- `/plan [任务]` 进入或切换计划模式，复用计划只读保护、计划 role 临时模型、计划文件及 `xd://propose` 提交链路；已有草稿退出前确认。提交计划后展示计划正文并请求用户确认，取消或拒绝保留计划模式，批准后恢复工具与模型并复用上游计划保存、引用和执行链路。本次 RPC 审批支持保留当前上下文继续执行；清空上下文、压缩后执行和终端计划编辑器不属于本次接入范围。
- `/loop` 复用共享参数解析、次数/时长限制、`--while` / `--until` 条件和 prompt/compact/reset 设置；位置间隔参数与计数语义见 [循环间隔契约](fork.md#loop-轮次间隔)。首轮正常发送，后续轮次在会话空闲且间隔结束后执行；停止暂停重复提交，下一条用户提示可恢复，再次 `/loop` 关闭。切换或关闭会话取消旧会话的待提交、间隔定时器与条件进程；启用 loop 时不同时自动提交 goal 续跑。
- `/goal` 复用上游目标生命周期与已有 RPC goal 控制器，保留目标创建/替换、查看、暂停、恢复、删除和预算调整；不得维护第二份目标状态。自动续跑沿用上游 RPC 设置，无工具输出的一次性纠偏与停止提示统一见 [Goal 续跑边界](goal-autopilot.md#6-无人值守与权限边界)。
- `/goal-autopilot` 的完整模式契约与验收条件统一见 [Goal 自动编排需求](goal-autopilot.md)；接入沿用上述命令提交、目录、补全、输出与宿主对话机制，不维护第二份业务语义。
- `/jch-workflowzbatch <任务块软目标> <并发上限> <任务正文>` 复用共享命令处理器，以普通用户消息展开并沿用 workflowz；完整批处理约束见 [JCH 命令](fork.md#jch-命令)。通过 v3 目录和补全发现，使用现有 `prompt.message` 提交；正文内部空白及字面量须保留，非法参数只返回用法且不启动模型回合。不增加 RPC 专属调度、配置写入或程序级并发/禁测拦截。
- `/team`、`/advisor` 的开关/状态/记录、魔法关键词命令、技能与 `/compact` 复用已有执行路径。`/advisor configure` 的终端编辑器仍明确报告仅 TUI 可用，role 保存继续使用现有配置接口。
- 长操作与审批等待不得占住停止通道；取消、会话切换及 EOF 后不得向其他会话写入结果或启动后续轮次。命令的调用受理、模型运行与最终完成沿用现有 RPC 事件语义。

## 模型配置

保留仅作用于当前会话的临时切模型操作，不写持久配置，不改变其他会话及新会话默认值。

保留完整 role 配置界面和持久保存能力，包括未配置项、自定义 role、保存结果、并发修改及配置来源的处理。优先复用上游配置机制；已有上游行为按上游执行。

保存单个用户 role 由 Settings 的现有文件锁、比较并交换及原子写入统一负责；只改变目标 role，保留其他角色、配置字段及 YAML 注释。并发冲突不得改写文件，非法配置继续隔离备份并显式失败。验收覆盖已有角色更新、新角色添加、取消角色和并发外部编辑后的注释与字段保留，并通过真实 GUI 保存及重启读回。

模型筛选和可用性统一跟随上游，不新增 fork 专有禁用策略。

### Team 模型配置接口（规划，未实现）

**状态：OMP 侧 Team 配置接口与共享服务已实现，Windows 真实 RPC 入口有定向通过证据；外部 ZCode GUI 的实现及联调尚未验收，Linux／公司 NFS 跨主机验证仍未完成。** 原标题仅保留既有链接锚点；既有 `/team` 讨论可用不证明 GUI 面板已存在。业务、TUI 与保存服务以 [Team 第 2.9 节](team.md#29-team-模型配置界面规划未实现)及[第 5.6 节](team.md#56-模型配置实现方案规划未实现)为权威；offline 配置必须服从[用户配置的 shm／NFS 双写权威要求](offline-shm.md#23-用户配置的-shmnfs-双写权威要求程序实现待验收)。本节只定义 RPC 字段和 GUI 接入，不另立存储规则；具体证据、失败修复复用与未验收范围见[需求目录](README.md)。

#### 能力发现与通用约定

* 沿用现有 stdio RPC v3、请求 ID、响应外壳及分帧；协商 `negotiate_protocol {protocolVersion:3}` 后以 `capabilities.teamConfig: true` 宣布本能力，不增加协议大版本、HTTP 服务或独立连接。旧服务未声明该能力时 GUI 禁用配置入口并说明不支持，不能改读配置文件兜底。
* 三个接口均绑定接收它们的 OMP 进程、当前会话、profile 和项目上下文；不接受客户端任意路径、跨 profile 写入、凭据或 YAML 文本。GUI 需要切换配置目标时切换对应会话／进程并重新读取。
* 写入的模型引用复用 `RpcModelRef` 的 `provider`／`modelId`，只接受具体身份，不接受自然语言、通配符、`auto` 或思考级别扩展。查询采用下述无损槽位表示，原始 selector 即使失效也不能丢弃；只读预览可以携带该原文用于诊断，不能借预览将其写入。顺序及重复项完整保留，响应不含密钥、完整配置文件或无关设置。
* 正常响应沿用 `{id,type:"response",command,success:true,data}`；失败沿用现有错误消息及机器可读错误码。Team 失败响应允许附带结构化 `data`，用于返回问题索引、实际保存回执及可取得的最新配置；GUI 不从错误消息文本解析状态。

#### `get_team_config`

请求含 `id`、`type:"get_team_config"` 及可选 `preview`（见后文），不执行模型推理、不发起讨论、不修改配置。明确打开配置时可以按需读取原始 NFS 持久主配置以展示双方原值；不扫描其他目录，不进入启动回源。未提供 `preview` 时只返回已保存配置的查询快照；返回 `data`：

| 字段 | 契约 |
| --- | --- |
| `profile` | 当前命名 profile；默认 profile 为 `null` |
| `revision` | 当前用户层目标配置的不透明版本；Linux offline 联合覆盖活动和持久两端目标字段的原始值、缺失状态及实际文件身份，不是进程内计数。任一必要目标存在结构非法／重复键或不可安全读取时为 `null`；仅 selector 失效／模型不可用不影响版本生成 |
| `userMembers` | 活动端用户层的完整有序 `TeamMemberSlot[]`；字段缺失为 `null`，显式空名单为 `[]`，结构非法或不可读时省略。是否可读由 `storage.active.readState` 判定，不能把读失败或失效成员当成字段缺失 |
| `persistentMembers` | 原始 NFS 端同一 profile 的完整有序 `TeamMemberSlot[]`；字段缺失为 `null`，显式空名单为 `[]`。结构非法、不可读或单端模式不适用时省略，由 `storage.persistent.readState` 区分；不得只返回 `different` 而隐藏持久端原值 |
| `effectiveMembers` | 当前有效基础名单的完整有序 `TeamMemberSlot[]`，失效项原位保留；有效空名单／未配置时按既有规则回退为当前会话模型的一行。结构非法或无模型可供默认回退时为 `null` 并附问题 |
| `source` | 当前有效配置来源：`default`、`global`、`project`、`overlay` 或 `runtime`；无法确定时为 `null`。不因为某行模型不可用而抹去已知来源 |
| `sessionModel` | 当前主模型的引用、展示名称及 `available` 状态；无会话模型时为 `null`。其问题独立于成员名单，不通过保存成员顺带切换主模型 |
| `participants` | 当前有效名单按既有规则展开的 `{index,label,model}` 槽位数组；成员无法解析或实际 Team 资格校验失败时为空并附问题，不能以少量合法项拼成成功预览 |
| `issues` | 每项含 `code`、`message`、`target`。`target:"member"` 时必须含 `list`、零基 `index` 和原始 `selector`，`list` 精确指向 `userMembers`、`persistentMembers` 或 `effectiveMembers`；有效名单问题另含其 `source`。其他 target 为 `session_model`、`config` 或 `storage`；用户配置文件／存储问题必须有 `side:"active"` 或 `"persistent"`，高层配置问题则用 `source` 标识、不伪填用户文件 side。可含安全的逻辑文件标识及行／列 |
| `writableScopes` | 本能力仅支持 `["user"]`，不借此修改项目、overlay 或运行时层；服务无法保存时可返回空数组，并附原因 |
| `storage` | `{mode,syncState,active,persistent}`；`mode` 为 `single` 或 `offline_shm`。每端 `{readState}` 明确 `present`、`missing`、`invalid`、`unreadable`，持久端另可为 `not_applicable`；`present` 指目标字段是合法的字符串列表，包括 `[]`，`missing` 包括字段或文件缺失。`syncState` 为 `in_sync`、`different`、`unknown` 或 `not_applicable`，比较两端本次字段的原始有序值及缺失状态，不比较整文件；单端持久端不适用 |
| `preview` | 仅在请求含合法 `preview` 时返回的只读草稿投影；结构与语义见下文，不替换以上已保存快照 |

**无损成员槽位 `TeamMemberSlot`：** `{index,rawSelector,model,name?,status,reasonCode?,reason?}`。`index` 为原列表零基位置，`rawSelector` 原样保留配置中的字符串（不擅自 trim、改写大小写、去重或丢行）；`model` 为能确认身份时的具体引用，否则为 `null`；`status` 为 `available`、`unavailable` 或 `unresolved`，后两种必须给原因。例如用户列表 `[p/A,"失效旧别名",p/B]` 必须返回三行，中间行的 `model:null` 不得造成 A、B 丢失或索引前移；高层也有失效项时用不同 `list/source` 精确归属。重复映射键、非数组或非字符串成员属于结构非法，不伪装成模型失效；仅无法解析或当前不可用的字符串成员仍可显示并修复。

GUI 编辑 `userMembers`，分别展示 `persistentMembers` 和 `effectiveMembers/source`，不能把高层名单自动保存回用户层或在两端有差异时盲目覆盖。`revision:null` 时禁止保存，先修复结构／读权限并重读；结构可读但模型失效时必须能取得 revision，用候选替换或删除原槽位后提交修复。`writableScopes` 不得仅因旧模型失效就清空。

##### 只读草稿预览

保留三个接口，不增加第四个预览接口。`get_team_config` 可带 `{preview:{clientRevision,members}}`：`clientRevision` 为 GUI 草稿版本的非空不透明字符串，服务原样回传；`members` 与保存的数组／`[]`／`null` 语义相同。为诊断未修复的旧槽位，数组项额外允许 `{rawSelector:string}`，只读解析为真实候选或带问题的槽位，不进行自然语言猜选。写接口不接受此原文变体。

```json
{
  "id": "team-preview-1",
  "type": "get_team_config",
  "preview": {
    "clientRevision": "draft-7",
    "members": [
      {"provider": "company", "modelId": "GLM-5.2-public"},
      {"rawSelector": "失效旧别名"},
      {"provider": "company", "modelId": "Qwen3.8-27B"}
    ]
  }
}
```

返回 `data.preview:{clientRevision,userMembers,effectiveMembers,source,participants,issues}`，列表及槽位采用上面的无损结构，内部成员问题的 `list` 指向 `preview.userMembers` 或 `preview.effectiveMembers`。共享服务先在内存中投影拟保存的用户层值，再按真实项目／overlay／运行时优先级计算预计有效值及运行槽位；高层覆盖不因用户草稿改变而消失，主模型不变。不合法的保留槽位返回问题、不得生成部分成功的运行槽位。

预览仅校验与计算，不能保存、隔离／修复文件、启动保存锁、触发备份或修改 Settings 的持久／运行时层；默认回退和清除也只作投影。已保存快照字段不被草稿替换，GUI 同时展示实际和预计结果。GUI 按会话及 `clientRevision` 丢弃过期响应；没有问题的预览也不是锁定目录或承诺随后保存必成功，保存仍须重新校验版本及资格。TUI 复用同一只读方法，不各自重写槽位算法。

#### `get_team_models`

请求：`{id,type:"get_team_models",query?:string}`。省略或空查询返回当前上下文全部已知聊天候选，支持 GUI 本地过滤；不受当前成员、少数预置模型或其他界面的最近使用列表限制，不截断为前若干项。模型数据、可选资格和原因由共享服务提供；非聊天模型不进入此目录。

返回 `data.models` 数组，每项为 `{model,name,selectable,reasonCode?,reason?}`。`model` 是具体模型引用，`name` 是展示名称；`selectable:false` 必须有原因。原因至少区分未认证、被禁用／当前范围不允许、Team 不支持的后端 Agent 或必要能力缺失；可选性不等于真实提供者认证／任务质量已验证。旧成员不论是否仍在候选目录，都在 `get_team_config` 对应完整列表中保留原始槽位和问题。

`query` 对名称、ID、provider 及已核实的中文别称／简称进行确定性候选搜索，不通过模型推理理解名称，不自动选择或改写成员。无法唯一确定的别称返回全部真实匹配，零匹配返回空数组，不拼造 selector 或静默选“最新”。唯一结果供普通 Agent 代配使用，GUI 仍由用户确认。offline 保留原离线目录策略，不为查询或刷新回退到公网，也不修改认证／启用策略。

#### `set_team_config`

请求使用完整列表替换，不增加逐项写接口：

```json
{
  "id": "team-save-1",
  "type": "set_team_config",
  "scope": "user",
  "expectedRevision": "opaque-revision-from-get_team_config",
  "members": [
    {"provider": "company", "modelId": "GLM-5.2-public"},
    {"provider": "company", "modelId": "Qwen3.8-27B"},
    {"provider": "company", "modelId": "GLM-5.2-public"}
  ]
}
```

示例 ID 必须以目标环境实际目录为准。`members` 为具体模型引用数组、`[]` 或 `null`：非空数组保存有序名单；`[]` 保存显式默认回退；`null` 移除用户层字段。不可省略 `members`，不把省略、非法类型、空字符串或未知 ID 当成重置。`scope` 只接受 `"user"`；`expectedRevision` 为必需的非空字符串。

* 保存前重新核对当前候选资格，非法项返回零基位置及原因，不静默删除；允许重复身份。主模型问题独立返回，不阻止用户修复成员名单，也不宣称保存成员就已具备运行资格。
* 校验 revision、重复键和实际目标后，按[双写权威要求](offline-shm.md#23-用户配置的-shmnfs-双写权威要求程序实现待验收)的统一锁顺序持有 NFS 跨主机锁与活动端本机锁，在锁内重读、比较双方版本，首次提交前发现冲突不改任一配置。同旧版本的合作写入不能因锁只在本机生效而双双通过；保存阶段第二端 I/O 或目标身份变化仍须返回实际部分／未知结果。
* `success:true` 仅表示本请求在锁保护下将所有必要目标确认保存或判定同值无变更，并完成锁内读回；不代表没有高层覆盖。返回 `data` 含 `config`（随后取得的最新查询快照，含两端原值／读取状态）、`saveState`、`writes`、`effectiveMatchesRequested` 及可选 `effectiveNote`。`writes` 是本请求已确认的提交事实，不冒充永久不变的现值；若随后查询已被新保存改变，`config` 展示现值并明确说明，不把它伪造成此前请求未提交。
* `saveState` 为 `complete`、`partial`、`failed` 或 `unknown`；`writes` 含 `active` 与 `persistent`，每端为 `{status,message?}`，`status` 为 `saved`、`unchanged`、`failed`、`not_attempted`、`unknown` 或 `not_applicable`。普通单端模式的 `persistent` 为 `not_applicable`，不是重复写同一路径。
* 所有必要目标都已确认完成且读回成功才为 `complete`；部分目标已完成而其他未完成为 `partial`；确定没有提交且失败为 `failed`；任何关键提交／读回事实无法确定为 `unknown`。后三种均 `success:false` 并携带已知回执；部分或未知不是可自动重试的普通失败。
* `effectiveMatchesRequested` 是布尔值；存在高层覆盖或不能确定有效值时为 `false` 并给 `effectiveNote`，不能用保存成功遮蔽未生效。清除／空名单时按删除用户字段／默认回退语义判断，不与非空运行槽位机械比较。
* 复用 `invalid_params`、`scope_not_allowed`、`revision_conflict`、`persistence_failed`、`execution_failed`；本能力增加 `invalid_config` 区分重复键、非法 YAML 等必须先修复的配置问题。前置校验失败为 `failed`、两端 `not_attempted`；错误 data 可附 `issues` 和可安全取得的 `config`。返回错误码不能抹去实际提交状态。
* 本能力只改 `team.members`，不写 `models.yml`、role、凭据或 provider 开关，不创建／迁移数据库，不触发真实模型探测。失败或连接断开后 GUI 先重新查询，不自动重放保存或用旧 revision 覆盖。

#### GUI 展示、通知与会话隔离

GUI 提供专用 Team 模型配置面板，交互能力和预览按 Team 第 2.9 节，不要求用户了解配置文件或 shm。打开时读取完整用户／NFS 持久／有效三份列表及各自问题，分别展示具体原值、读取状态、主模型和覆盖来源；失效原槽位不得丢弃或把两端不同简化为一个告警。草稿编辑、排序、复制、删除后通过可选 `preview` 查询共享投影，不逐次写盘；保存时将所有修复后的具体模型引用一次提交，使用返回快照更新页面，不能在请求发出时乐观标为已持久化。

* 完整保存且生效、保存但被项目／overlay 覆盖、两端部分保存、结果未知及并发冲突分别展示；版本冲突保留草稿，允许重新读取并比较，不能直接自动重试。取消不调用保存；恢复默认只改草稿。
* 保存后复用现有 `settings_changed {scope:"user"}` 事件，不增加另一套订阅总线。面板收到事件或重新获得焦点时按需重读；有脏草稿时提示外部变化而不覆盖草稿。其他进程不能依赖此进程的广播，最终正确性依赖后端重新读取与版本检查。
* 面板请求与草稿绑定发起会话／profile，切换、关闭或失联后不得把旧响应写到新面板；取消界面不证明已发保存请求未提交，必须依据回执或重新查询。配置保存不占用模型生成通道，不阻塞停止讨论和普通消息。
* `prompt.message` 方式提交 `/team configure` 时，RPC 宿主须通过已有对话机制接入同一配置服务或明确指引客户端使用本能力，不把配置命令交给模型，不输出虚假保存成功。原 `/team <任务>` 派发及状态协议不变。

#### Team 模型配置验收

* 在隔离环境从真实 `cli.ts --mode rpc-ui` 进程验证 v3 capability、旧协议／缺能力拒绝、三个接口的响应及错误字段、空名单／清除、跨 provider 搜索、中文别称多解、不支持／失效成员与主模型问题。请求不触发真实模型或不允许的网络访问。
* 通过真实配置文件验证保存、顺序／重复保留、同 profile 重启读回、命名 profile 隔离、高层覆盖提示、重复键拒绝、同字段冲突及无关字段合并；三个来源列表各含不同位置失效 selector 时逐行无损返回，问题的 `list/source` 无歧义，模型失效但结构合法时仍可取得 revision 并替换／删除修复。
* 默认／命名 profile 的 shm 与原始 NFS 名单分别为不同非空列表、`[]` 和字段缺失时，查询及保存回执中的 `config` 都能展示双方具体值与读取状态；结构非法、读失败和单端不适用不混同。锁内确认双方写入成功才返回完整成功，NFS 权限／写入失败、提交事实未知及后续保存改变现值均有准确回执，不靠备份或异步补写求成功；验收按双写权威要求执行。
* 在实际 NFS 部署的两台主机、同一用户／目标上，从同一持久旧版本并发提交，只能一方提交该版本，另一方在首次写前冲突且原值不被覆盖；证明锁由共享服务器协调，锁不可用时不降级。只跑本机进程／Windows seam 不代表此项通过。
* `get_team_config` 的草稿预览覆盖添加、排序、重复、失效原槽位、`[]`、`null`、高层覆盖及无主模型，返回实际快照与投影不混同；对真实临时配置断言预览前后文件字节不变，未启动保存／备份；不同 `clientRevision` 的迟到响应不覆盖当前草稿。
* GUI 单独验证目录展示、成员编辑、草稿取消、有效来源、失效状态、保存／部分完成／冲突、通知时草稿保护及切换会话后迟到响应隔离。OMP 侧接口通过不等于 ZCode GUI 已实现／联调通过，需分别记录证据；当前仅有 OMP 侧 Windows 定向入口证据，外部 GUI 验收仍待执行。

## 范围与验收

除上述明确要求的 Team 模型配置及显示外，不新增此前已取消的管理面、附件协议、子代理管理或 SDK 同步义务。具体不要求：子代理过程和历史查看及控制；技能启停、删除和刷新管理；队列查看、删除、重排和清空管理；通用设置、Provider、MCP、用量、搜索和 jobs 管理；结构化附件协议；SDK 同步与未列出命令的逐命令覆盖；独立的 `/btw` GUI 接入。上游自带功能随上游保留，不因此新增 GUI 接入承诺。

通过真实 OMP 进程与 ZCode 接入验证：多会话并发和隔离、消息与工具过程、停止与恢复、提问回答、命令发现与补全、临时切模型及 role 持久保存；新增 Team 配置按上节单独标识规划、实现及接口／GUI 验收状态。

命令接入先在 OMP 侧覆盖注册目录、调用派发、索引操作确认与失败、计划拒绝/批准及模式恢复、loop 限制/条件/停止/会话隔离、goal 生命周期和已有命令路径；至少包含真实 `cli.ts --mode rpc-ui` 的协议入口验证。ZCode GUI 联调与真实模型全流程单独验收，本次仅改造 OMP，不以局部测试或静态检查宣称联调通过。

不再要求验收“一项目一进程”或本文未列明的 fork 专有行为。文档确认不代表接入已实现或验证通过。
