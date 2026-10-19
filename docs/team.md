# Team：多代理讨论与模型配置

`/team <问题或需求>` 让多个独立代理调查、交叉审查和修订方案，再由当前会话模型综合结果。适合需求分析、故障诊断和设计比较；不执行方案、不修改项目代码。本文可通过 `omp://team.md` 读取。

行为与验收的权威契约见 [Team 需求](../docs-zh-CN/requirements/team.md)；本文是使用指南，不另立需求。通用模型接入见 [模型配置](models.md)，设置优先级见 [设置](settings.md)。

## 1. 怎么用

先通过 `/model` 选择你希望负责核实与综合的主模型，再输入完整问题，例如：

```text
/team 根据 docs/api.md、内部 Wiki 和现有代码，比较接口缓存方案，说明风险与验收方法
```

流程依次为独立调查、对齐比较、交叉审查、修订复核、综合报告。可查看阶段与代理状态，也可通过当前界面的取消操作停止讨论。启用且已有索引时，子代理优先检索 Wiki 和 Repo；没有关键资料时会说明缺口，不能把流程完成当成方案已验证。

结果进入当前会话。可以追问，或回复“选择方案 A”；选择只确认方案，不触发实施。要修改代码须另行明确要求。若需求或关键约束改变，补全问题后重跑 `/team`。图片不传给讨论子代理，必要背景请写成文字或提供可读文件路径。

## 2. 多个模型怎么配置

### 首选：交互式有序草稿

在目标会话输入 **`/team configure`**，打开 Team 配置面板，不会发起讨论。面板显示用户保存名单、当前有效来源与名单、主模型、实际提案槽位及诊断；旧的失效／无法解析项保留在原槽位，须替换或删除后才能保存，不会静默丢弃。

| 键位 | 操作 |
| --- | --- |
| `↑`／`↓` | 选择名单槽位 |
| `a`／`e` | 添加／替换所选槽位，打开只选择模型的候选面板 |
| `u`／`j` | 所选槽位上移／下移 |
| `c`／`d` | 复制／删除所选槽位；重复模型保留为独立槽位 |
| `0` | 将草稿改为默认名单 `[]`，仍需保存 |
| `s` | 保存当前有序草稿到当前 profile 的用户设置 |
| `r` | 重读版本并与保留的草稿比较，不自动覆盖草稿 |
| `Esc` | 取消；草稿已改时以 `Y` 确认放弃、`N` 留在面板 |
| `PgUp`／`PgDn` | 滚动查看窄屏中的诊断与保存回执 |

候选来自当前完整模型目录，可跨 provider 选择，不局限于会话的临时模型轮换列表；仍遵守认证、启用策略与 Team 能力限制。搜索按 provider、ID、名称及模型家族确定性匹配，支持“千问／通义千问／通义 → Qwen”“智谱／智谱清言 → GLM”查找线索，不会将歧义描述自动选成某个版本。选择候选、编辑草稿和只读预览都**不写盘、不切换主模型、不请求真实模型**。取消候选选择返回原草稿；取消未提交草稿不写盘。已经按 `s` 提交后退出不能撤销写入，须重新打开核实。

保存只更新 `team.members`，顺序和重复项原样保留，只影响随后启动的 Team。出现版本冲突时保留草稿，按 `r` 重读、比较外部变更后再决定提交，不覆盖别人的更新。区分完整保存、保存但被高层覆盖、`partial`（部分保存）和 `unknown`（结果未知）；后两者先核实两端文件与回执，**不得自动重放保存**。候选不唯一时由用户选择，Agent 代配也不能猜。

### CLI 查询与保存

无需配置也能使用：`team.members` 未设置或为 `[]` 时，当前会话模型生成三个独立提案代理。offline 下规则相同，**不会自动拉入所有 company 模型**。

名单写在当前 profile 的主设置文件 **`config.yml`**，不是 `models.yml`：

```yaml
team:
  members:
    - company/GLM-5.2-public
    - company/Qwen3.8-27B
    - company/MiniMax-M2.7
```

这些是内网 company 模型的示例，使用前必须确认它们出现在当前环境的可用目录中；不要照抄不存在或未认证的模型。也可以混用已配置的不同 provider，但 offline 时只能选择获准使用的内网服务。

- 每项推荐使用目录返回的完整 `provider/model-id`，保留大小写、标点、顺序和重复项，不写自然语言名称或通配符。
- 名单是提案模型，不是主模型设置。**当前会话模型负责对齐和综合**，不必在名单里，也不会自动追加进去；程序不判断哪个模型“最强”。
- 提案代理数为 `max(3, 名单长度)`：一个模型 A → AAA，两个模型 AB → ABA，三个模型 ABC → ABC，四个模型 ABCD → ABCD。相同模型的槽位仍有独立上下文；重复项不去重。
- 并发受 `task.maxConcurrency` 控制，超限排队，不减少名单。
- 成员和当前会话模型都必须可用、未被禁用，并支持前端只读工具与结构化输出。JchTools 的后端 Agent 模式不能用于 Team。无效项会报错，不自动剔除或换模型。

先在**与目标会话相同的环境、项目目录和 profile**中查询：

```sh
omp config path
omp config get team.members --json
omp models --json
omp models find GLM --json
```

`config path` 输出的是活动 **agent 目录**，不是文件路径；主设置通常为其中的 `config.yml`，兼容已有 `config.yaml`。`models --json` 返回 `models` 数组，读取每项的 `selector`、`provider`、`id` 和 `name`。`models find` 只是 provider／ID／名称的子串过滤，不会理解“千问”“智谱”等自然语言别称。

确认名单后，也可用设置命令写入活动全局配置。以下单引号 JSON 写法用于 Bash／tcsh：

```sh
omp config set team.members '["company/GLM-5.2-public","company/Qwen3.8-27B","company/MiniMax-M2.7"]'
omp config get team.members --json
```

使用命名 profile 时，以上每条命令都加相同的 `-P <名称>`，如 `omp -P work config path`。不要把配置写到默认 profile，却在 `work` profile 中使用。

Linux offline 下，`/team configure`、Team RPC 保存和 `omp config set/reset` 使用的用户 Settings 主动保存会最小更新 shm 活动配置与同 profile 的原始持久配置；不再需要为一次成功的程序保存手工补写 `P`。必须检查保存回执与覆盖情况；严格读取失败或锁不可用时不会降级为“只改 shm 也算成功”，详见第 4 节。

## 3. 让 Agent 根据自然语言自动配置

在普通聊天中明确要求配置，而不是把配置任务交给只读的 `/team`。例如：

```text
请给当前 profile 配置 Team，依次使用智谱 GLM 5.2、千问 3.8 27B 和 MiniMax 2.7。
先查当前环境的真实候选；有歧义不要猜，只改 team.members，不切换主模型。
```

普通会话 Agent 可通过以下共享配置接口执行查询、预览和保存；这不是把配置任务交给只读讨论，也不是让模型随意编辑 YAML。`/team configure` 是交互入口，自然语言到候选的确认仍须遵守以下规则。

1. **确认目标。** 从当前进程／启动参数确认操作系统、`OMP_OFFLINE`、原始 `OMP_CONFIG_ROOT`、profile、项目目录，以及已有配置覆盖。不能用另一个终端的默认环境代替目标会话。能从环境和配置查到的内容不要重复问用户。
2. **读取真实目录。** 优先使用 Team 的 `get_team_models`（见下文），可确定性查询中文线索与跨 provider 候选；CLI 环境可在相同上下文运行 `omp models --json`，必要时用 `omp models find <目录可能使用的名称片段> --json` 缩小候选。查询和配置不是模型推理调用，目录可用也不等于已验证服务连通性或任务质量。
3. **逐项匹配。** 将用户的中文名、简称、版本、参数规模和 provider 限制与候选的名称和真实模型引用核对。例如“智谱”“千问”是查找 GLM／Qwen 的线索，不是可拼造的模型 ID。保存只采用目录中的真实 `{provider, modelId}`；CLI 使用其完整 selector。
4. **处理歧义与缺失。** 用户指定的完整 selector 精确匹配时直接采用；自然语言描述按名称／家族、版本、规模、来源与可用范围筛选后只有一个有效候选时也直接采用，并说明映射。多个 provider 提供同名模型、存在多个符合描述的版本，或“最好／最新”没有可核实标准时，列出会影响选择的候选差异，批量请用户确认；不擅自按字典序、价格、名称相似度选一个，也不静默升级版本。零匹配先换中英文名称片段并检查完整目录及禁用／认证配置；仍无匹配就报告缺失，不生成假 ID，不用另一模型替换。
5. **检查实际允许范围。** 核对 `enabledModels`、`enabledProviders`／`disabledProviders` 和当前项目的覆盖，排除非聊天模型与不支持 Team 的后端 Agent；当前会话主模型也必须满足要求。用户只要求配置参与者时，不顺带切换主模型、开放被禁用的 provider、添加所有可用模型或更改凭据。
6. **最小写入。** 先用共享接口预览，再按用户顺序保存真实模型引用，保留其明确要求的重复项；只更新 `team.members`。CLI 可用 `config set/reset`。已有 provider 无需重写 `models.yml`。确需新增自定义服务时，先依据用户提供或已核实的 endpoint、协议、模型 ID 和认证来源按 [模型配置](models.md) 接入；缺失关键信息再问，不能虚构地址、密钥、上下文或工具能力。当前没有主动 provider 保存接口，不得假称 Team 保存会自动保存 provider；手工代配须遵守第 4 节双端最小写规则。密钥不在回复中展示，也不为了名单配置复制认证文件。
7. **读回验证。** 核对保存回执、两端状态、名单及有效值与用户意图一致，报告“自然语言名称 → selector”、修改路径及覆盖情况。冲突先重读比较；部分完成或结果未知先核实，不自动重试。只查询名单不足以证明真实服务可用；未经当次明确授权，不为验证配置启动 `/team` 或发送真实模型请求。

`team.members` 是数组，高优先级配置会**整体替换**低优先级名单，不会追加合并。项目 `.omp/config.yml`、`--config`／`PI_CONFIG_FILES` overlay 和运行时覆盖都可能遮蔽全局设置。`config set` 可能提示已保存但被覆盖；先查清来源，只在用户授权的范围内修改，不以“写入成功”冒充已生效。

### RPC：GUI／Agent 共用的配置入口

RPC v3 的 `teamConfig` 能力提供三个接口。调用方必须在目标会话／profile 的 RPC 上操作；它们是可供 GUI 和 Agent 集成的入口，**不表示外部 ZCode GUI 已完成集成或验收**。

- `get_team_config`：读取版本 `revision`、用户／持久／有效名单、来源、主模型、槽位、诊断和存储状态。可传 `preview: {clientRevision, members}` 只读预览拟保存名单与最终有效参与者；`members` 使用 `{provider, modelId}` 数组，保留顺序与重复项。无法解析的旧槽位可用 `{rawSelector}` 参与预览诊断，但不能直接保存。调用方只展示仍匹配当前会话与 `clientRevision` 的结果。
- `get_team_models`：可选 `query`，返回完整目录的确定性候选及 `selectable`／不可选原因。中文查找线索同上述面板规则；不调用模型替用户猜选。
- `set_team_config`：传入 `scope: "user"`、上次读取的 `expectedRevision` 和 `members: [{provider, modelId}, ...]`。`[]` 显式保存默认名单，`null` 移除用户字段以继承其他来源；均不改变主模型。保存回传配置、逐端写入状态与是否有效匹配；失败通过 `revision_conflict`、`invalid_config`、`persistence_failed` 等结构化错误及状态区分，不将请求已发出等同于保存成功。

取消／切换会话后丢弃迟到结果；已提交保存不能因界面退出视为撤销。GUI／Agent 同样必须对冲突重读比较，对 `partial`／`unknown` 不自动重放，并提示高优先级覆盖。

## 4. offline 下配置文件到底在哪里

`OMP_OFFLINE` 的 `1`／`true`／`yes`／`on` 启用 offline（忽略大小写与首尾空白）。**仅 Linux offline 使用 shm**；Windows offline 和非 offline 不使用这套映射。

先区分两个根，再定位同一个 profile 的 agent 目录：

| 位置 | 默认 profile | 命名 profile `work` |
| --- | --- | --- |
| 原始持久根 `P` | `P/agent/config.yml` | `P/profiles/work/agent/config.yml` |
| Linux offline 运行根 `R` | `R/agent/config.yml` | `R/profiles/work/agent/config.yml` |

- `P` 优先取有效的 `OMP_CONFIG_ROOT`：必须为绝对路径，支持 `~` 展开；相对值无效。没有有效值时按当前安装的默认目录规则解析：当前实现为用户 home 下的 `PI_CONFIG_DIR`，未指定则为 `.omp`。不要无视环境直接写死 `~/.omp`。
- `R` 为 `/dev/shm/omp-<uid>-<domainId>/<P 的末级目录名>`（`P` 为文件系统根时末级使用 `root`）。域身份由主机、用户和规范化原始根决定；不能选第一个 `/dev/shm/omp-*` 或照搬其他机器的 hash。
- 在目标会话相同的用户、环境及 profile 下执行 `omp config path`，以返回的实际 agent 目录定位运行配置，再与已解析的 `P` 和 profile 相对布局核对。仓库／SDK 环境还可用 `getOfflineShmState()` 获取 `persistentRoot`／`runtimeRoot`，用 `getAgentDir()` 获取活动 agent 目录；不是要求安装用户额外准备源码或 Bun。
- 非 Linux offline 情况，直接使用 `omp config path` 的结果；默认 profile 的 `PI_CODING_AGENT_DIR` 可能改变 agent 目录，命名 profile 忽略它。Linux offline 忽略该 agent 目录覆盖，统一使用运行域内的 profile 布局。
- 项目级 `.omp/` 和外部 Claude 配置不迁入 shm。`config.yaml`／`models.yaml` 是已有 YAML 的兼容文件名，读取时 `.yml` 优先；必须核对实际读取文件，不能只改被遮蔽的 `.yaml`。

### 程序主动保存与手工代配的边界

现有程序的用户 Settings 主动保存（包括 Team TUI／RPC、CLI `config set/reset`）在 Linux offline 下对 `R` 与 `P` 的同一 profile 进行双端最小写，分别保留无关键与注释，不用整份文件互相覆盖。保存前严格读取实际 YAML；语法损坏、重复键、读取／权限错误等不能当成空配置继续写。版本不匹配返回冲突；完整、部分、未知与未写入结果须按回执处理，不能笼统宣称成功。

持久侧使用稳定旁路文件的 POSIX record lock，再串行更新活动侧；不支持或锁获取失败时严格报错，不退化为仅主机内有效的锁。**原始 `P` 所在真实公司 NFS 必须支持有效的跨主机 POSIX 锁**；本地 Windows seam 不能证明公司 NFS、Linux／CentOS 的实际锁语义已验收。双端写不是跨文件原子事务，部分失败须读回两端核实，禁止自动重放。

当前 `ConfigFile`／`ModelsConfigFile` 只有读取／迁移能力，**没有新增 provider 的主动保存命令或自动双写接口**。若用户授权手工编辑主配置或代配 `models.yml`，Linux offline 仍须按权威双端最小写规则处理：

1. 读取 `R` 与 `P` 下**相同 profile**的实际目标文件，各自保留现有其他键；不存在时只创建所需文件，不复制整棵目录。
2. 手工更改 `team.members` 时，将同一份有序 selector 名单分别最小合并到两侧主配置；若已通过程序保存且回执完整，不重复补写。
3. 确实新增／修改自定义 provider 时，将本次变更分别最小合并到两侧模型文件，保留各自无关 provider；已有内置 company 模型无需这样做。认证来源仍按既有机制处理，不复制令牌。
4. 分别读回实际文件，核对名单／provider 变更、顺序及 YAML 解析，再在相同 profile 检查活动有效值。单侧成功必须报告部分完成与失败路径，不能覆盖外部新改动来重试。含凭据的既有文件及新建私有目录／文件保持用户私有权限（Linux 目录 `0700`、文件仅所有者可读写）。普通文本编辑本身不具备程序保存的锁、版本检查或事务回执保证，不得假称安全事务已完成。

**为什么不能只改一边：** 只改 `P`，当前 offline 进程不会回源读到它；只改 `R`，shm 清空后会丢失这次手工持久配置。不能把 `OMP_CONFIG_ROOT` 改成 shm 路径来“同步”，这会改变运行域及真正的备份目标。

后台备份写到 `P/.offline-shm-backups/<备份域>/` 中的隔离版本，**不会覆盖 `P/agent/config.yml` 等原始活动文件**；等待备份不能代替主动双写。不要编辑备份 generation 或 `current.json`。双写也不意味着重启／重启机器后自动恢复：同一运行根还在时继续使用它，shm 丢失时启动仍不从 `P` 自动复制配置。需要按 [离线 shm 恢复契约](../docs-zh-CN/requirements/offline-shm.md#44-完整版本与人工恢复) 人工恢复完整备份；只恢复配置时也须先停止该运行域的相关进程，再由用户明确授权将所需配置放回正确的空运行目录，不能顺带恢复或覆盖数据库与会话。

### 公司模型的认证来源

offline 中的 `company` provider 复用外部 Claude 配置目录中的 `settings.json`：默认 `~/.claude/settings.json`，设置 `CLAUDE_CONFIG_DIR` 时以其实际解析位置为准。需要已有 `env.ANTHROPIC_BASE_URL` 和 `env.ANTHROPIC_AUTH_TOKEN`；它们来自该文件，不是仅凭 shell 中同名变量就能完成接入。外部文件不随 OMP 的 profile 或 shm 迁移，修复后需重启 OMP。

优先复用已有公司接入，不为每个 Team 成员重复创建 provider／凭据。offline 不等于模型本地推理或禁止所有网络：可以调用获准的公司内网模型，但目录缺失、配置失败或无可用服务时不能切到公网、安装依赖或擅自调用真实模型进行探测。

## 5. 生效与常见问题

- **改了名单仍使用旧模型：** 确认当前 profile、运行目录、实际 `.yml`／`.yaml` 和项目／overlay／运行时覆盖。设置热重载供后续运行读取，不改变已经启动的 Team；provider 定义或外部认证有变化时，重新加载模型目录或重启后再检查。最稳妥的是配置完成后新开同一 profile 的会话核对。
- **提示某个模型不可用：** 对照 `omp models --json` 的 selector 检查认证、禁用策略、版本和大小写；不能删除报错项后冒充完成用户指定名单。
- **两个模型却出现三个提案：** 正常行为，AB 按顺序循环为 ABA。
- **主模型不在名单中仍被调用：** 正常行为，当前会话模型承担对齐和综合。
- **想恢复默认：** 面板按 `0` 后 `s`，或通过 CLI 将 `team.members` 设为 `[]`；`omp config reset team.members`／RPC `members: null` 移除用户字段以继承其他来源。有项目／overlay 覆盖时核对最终有效名单；Linux offline 程序保存检查双端回执，手工修改仍须同步处理 `R` 和 `P`。
