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

确认名单后，可用设置命令写入活动全局配置。以下单引号 JSON 写法用于 Bash／tcsh：

```sh
omp config set team.members '["company/GLM-5.2-public","company/Qwen3.8-27B","company/MiniMax-M2.7"]'
omp config get team.members --json
```

使用命名 profile 时，以上每条命令都加相同的 `-P <名称>`，如 `omp -P work config path`。不要把配置写到默认 profile，却在 `work` profile 中使用。

**Linux offline 下，上述 `config set` 只改 shm 活动配置，还必须按第 4 节同步修改原始持久配置。**

## 3. 让 Agent 根据自然语言自动配置

在普通聊天中明确要求配置，而不是把配置任务交给只读的 `/team`。例如：

```text
请给当前 profile 配置 Team，依次使用智谱 GLM 5.2、千问 3.8 27B 和 MiniMax 2.7。
先查当前环境的真实模型 ID；offline 时只用内网模型，并同步修改 shm 和原始持久配置，保留其他设置。
```

这是由普通会话 Agent 查询并编辑现有配置的操作流程，**不是新增的自动配置命令，也不是 `/team` 自带的自然语言模型解析器**。代配按以下步骤执行：

1. **确认目标。** 从当前进程／启动参数确认操作系统、`OMP_OFFLINE`、原始 `OMP_CONFIG_ROOT`、profile、项目目录，以及已有配置覆盖。不能用另一个终端的默认环境代替目标会话。能从环境和配置查到的内容不要重复问用户。
2. **读取真实目录。** 在相同上下文运行 `omp models --json`；必要时用 `omp models find <目录可能使用的名称片段> --json` 缩小候选。查询和配置不是模型推理调用，目录可用也不等于已验证服务连通性或任务质量。
3. **逐项匹配。** 将用户的中文名、简称、版本、参数规模和 provider 限制与目录中的 `name`、`id`、`provider`、`selector` 核对。例如“智谱”“千问”可作为查找 GLM／Qwen 候选的线索，但不能据此拼造一个模型 ID。只有目录中的完整 ID 或已核实的精确别名才可落盘。
4. **处理歧义与缺失。** 用户指定的完整 selector 精确匹配时直接采用；自然语言描述按名称／家族、版本、规模、来源与可用范围筛选后只有一个有效候选时也直接采用，并说明映射。多个 provider 提供同名模型、存在多个符合描述的版本，或“最好／最新”没有可核实标准时，列出会影响选择的候选差异，批量请用户确认；不擅自按字典序、价格、名称相似度选一个，也不静默升级版本。零匹配先换中英文名称片段并检查完整目录及禁用／认证配置；仍无匹配就报告缺失，不生成假 ID，不用另一模型替换。
5. **检查实际允许范围。** 核对 `enabledModels`、`enabledProviders`／`disabledProviders` 和当前项目的覆盖，排除非聊天模型与不支持 Team 的后端 Agent；当前会话主模型也必须满足要求。用户只要求配置参与者时，不顺带切换主模型、开放被禁用的 provider、添加所有可用模型或更改凭据。
6. **最小写入。** 按用户顺序保存真实 selector，保留其明确要求的重复项；只更新 `team.members`。已有 provider 无需重写 `models.yml`。确需新增自定义服务时，先依据用户提供或已核实的 endpoint、协议、模型 ID 和认证来源按 [模型配置](models.md) 接入；缺失关键信息再问，不能虚构地址、密钥、上下文或工具能力。密钥不在回复中展示，也不为了名单配置复制认证文件。
7. **读回验证。** 检查 YAML 可解析、保存名单及有效值与用户意图一致，报告“自然语言名称 → selector”、修改路径及覆盖情况。只查询名单不足以证明真实服务可用；未经当次明确授权，不为验证配置启动 `/team` 或发送真实模型请求。

`team.members` 是数组，高优先级配置会**整体替换**低优先级名单，不会追加合并。项目 `.omp/config.yml`、`--config`／`PI_CONFIG_FILES` overlay 和运行时覆盖都可能遮蔽全局设置。`config set` 可能提示已保存但被覆盖；先查清来源，只在用户授权的范围内修改，不以“写入成功”冒充已生效。

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

### 必须同步改 shm 与原始配置

用户授权持久配置 Team 时，Linux offline 的代配必须完成两处修改：

1. 读取 `R` 与 `P` 下**相同 profile**的实际主配置，各自保留现有其他键；不存在时只创建所需的主配置，不复制整棵目录。
2. 更新 `R` 下活动配置的 `team.members`，并把**同一份有序 selector 名单**合并写入 `P` 下原始配置。可用 `omp config set` 更新活动设置，但它不会代写 `P`；原始文件须单独最小编辑。两边内容可以不同，只要求本次目标字段一致；不能用其中一整份覆盖另一份。
3. 如本次确实新增或修改了 `models.yml` 的自定义 provider，则将本次 provider 变更也分别合并到两处对应模型文件，保留各自无关 provider；已有内置 company 模型无需这样做。认证来源仍按既有机制处理，不把令牌复制到示例或 `team.members` 中。
4. 分别读回两处实际文件，核对名单、顺序和 YAML 解析，再用相同 profile 的 `omp config get team.members --json` 检查活动有效值。写入一处成功、另一处失败时明确报告部分完成及失败路径，不能声称已经持久配置；不要为重试而覆盖外部新改动。含凭据的既有文件和新建私有目录／文件保持用户私有权限（Linux 目录 `0700`、文件仅所有者可读写）。

**为什么不能只改一边：** 只改 `P`，当前 offline 进程不会回源读到它；只改 `R`，shm 清空后会丢失这次手工持久配置。不能把 `OMP_CONFIG_ROOT` 改成 shm 路径来“同步”，这会改变运行域及真正的备份目标。

后台备份写到 `P/.offline-shm-backups/<备份域>/` 中的隔离版本，**不会覆盖 `P/agent/config.yml` 等原始活动文件**；等待备份不能代替上述双写。不要编辑备份 generation 或 `current.json`。双写也不意味着重启／重启机器后自动恢复：同一运行根还在时继续使用它，shm 丢失时启动仍不从 `P` 自动复制配置。需要按 [离线 shm 恢复契约](../docs-zh-CN/requirements/offline-shm.md#44-完整版本与人工恢复) 人工恢复完整备份；只恢复配置时也须先停止该运行域的相关进程，再由用户明确授权将所需配置放回正确的空运行目录，不能顺带恢复或覆盖数据库与会话。

### 公司模型的认证来源

offline 中的 `company` provider 复用外部 Claude 配置目录中的 `settings.json`：默认 `~/.claude/settings.json`，设置 `CLAUDE_CONFIG_DIR` 时以其实际解析位置为准。需要已有 `env.ANTHROPIC_BASE_URL` 和 `env.ANTHROPIC_AUTH_TOKEN`；它们来自该文件，不是仅凭 shell 中同名变量就能完成接入。外部文件不随 OMP 的 profile 或 shm 迁移，修复后需重启 OMP。

优先复用已有公司接入，不为每个 Team 成员重复创建 provider／凭据。offline 不等于模型本地推理或禁止所有网络：可以调用获准的公司内网模型，但目录缺失、配置失败或无可用服务时不能切到公网、安装依赖或擅自调用真实模型进行探测。

## 5. 生效与常见问题

- **改了名单仍使用旧模型：** 确认当前 profile、运行目录、实际 `.yml`／`.yaml` 和项目／overlay／运行时覆盖。设置热重载供后续运行读取，不改变已经启动的 Team；provider 定义或外部认证有变化时，重新加载模型目录或重启后再检查。最稳妥的是配置完成后新开同一 profile 的会话核对。
- **提示某个模型不可用：** 对照 `omp models --json` 的 selector 检查认证、禁用策略、版本和大小写；不能删除报错项后冒充完成用户指定名单。
- **两个模型却出现三个提案：** 正常行为，AB 按顺序循环为 ABA。
- **主模型不在名单中仍被调用：** 正常行为，当前会话模型承担对齐和综合。
- **想恢复默认：** 将 `team.members` 设为 `[]`，或移除该字段；有项目／overlay 覆盖时也要核对。Linux offline 的持久变更仍需同步处理 `R` 和 `P`，不要只重置 shm。
