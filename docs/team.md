# Team：多代理讨论与模型配置

`/team <问题或需求>` 让多个独立代理调查、交叉审查和修订方案，再由当前会话模型综合结果。适合需求分析、故障诊断和设计比较；不执行方案、不修改项目代码。本文可通过 `omp://team.md` 读取。

本文是操作指南。行为与验收以 [Team 规格](../openspec/specs/team-discussion/spec.md)为准。

## 1. 怎么用

先通过 `/model` 选择你希望负责核实与综合的主模型，再输入完整问题，例如：

```text
/team 根据 docs/api.md、docs/compatibility.md 和现有代码，比较接口缓存方案，说明风险与验收方法
```

运行中可看阶段状态，在 Agent Hub 查看代理进度，通过当前界面的取消操作停止讨论。图片不传给讨论代理；请把必要背景写成文字，或提供可读文件路径（包括 Wiki 摘录）。关键资料缺失时，先看报告列出的缺口，不把流程结束当成方案已验证。

结果落在当前会话。可追问或回复“选择方案 A”；选择不触发实施，要修改代码须另行明确要求。关键约束变化时，带上新约束重跑 `/team`。失败报告未送达时，按提示中的 `proc://<jobId>` 回查。

## 2. 多个模型怎么配置

### 首选：交互式有序草稿

输入 **`/team configure`** 打开当前 profile 的全局成员草稿，不会发起讨论或切换主模型。选择候选和预览均不写盘、不调用模型；取消候选选择返回原草稿。旧的失效槽位保留原位，须替换或删除后再保存。

| 键位 | 操作 |
| --- | --- |
| `↑`／`↓` | 选择名单槽位 |
| `a`／`e` | 添加／替换所选槽位，打开只选择模型的候选面板 |
| `u`／`j` | 所选槽位上移／下移 |
| `c`／`d` | 复制／删除所选槽位；重复模型保留为独立槽位 |
| `0` | 将草稿改为默认名单 `[]`，仍需保存 |
| `s` | 保存当前有序草稿到当前 profile 的用户设置 |
| `r` | 重读版本并与保留的草稿比较，不自动覆盖草稿 |
| `v`／`V` | 展开／收起只读详情：用户存储、实际来源和运行预览 |
| `Esc` | 取消；草稿已改时以 `Y` 确认放弃、`N` 留在面板 |
| `PgUp`／`PgDn` | 滚动查看窄屏中的诊断与保存回执 |

用 provider、ID、名称或模型家族查找真实候选，也可用“千问／通义千问／通义”查 Qwen、“智谱／智谱清言”查 GLM。同名跨 provider 时核对来源，选定具体版本；候选不局限于当前会话的临时模型列表。

`s` 只提交 `team.members`，保留顺序和重复项，只影响随后启动的 Team。退出不能撤销已提交的保存。回执分清**已保存且生效**、**已保存但被覆盖**、**保存失败**和**结果未知**（`unknown`）：被覆盖时按 `v` 查来源；版本冲突时按 `r` 重读、比较后再提交；结果未知时先核实文件与有效值，不自动重试。

### CLI 查询与保存

无需配置即可使用：`team.members` 未设置或为 `[]` 时，当前会话模型生成三个独立提案代理，offline 也不会自动加入 company 名单。

名单在当前 profile 的主设置 `config.yml`，不是定义 provider 的 `models.yml`：

```yaml
team:
  members:
    - company/GLM-5.2-public
    - company/Qwen3.8-27B
    - company/MiniMax-M2.7
```

这些 selector 是内网示例，先确认模型出现在当前环境的目录中。可混用已接入且获准的 provider；填完整 `provider/model-id`，保留原大小写、标点、顺序和重复项。

名单只决定提案模型，当前会话模型仍负责对齐与综合。槽位数和资格见[参与者与模型配置](../openspec/specs/team-discussion/spec.md#requirement-22-参与者与模型配置)。

在**目标会话的环境、项目目录和 profile**中查询：

```sh
omp config path
omp config get team.members --json
omp models --json
omp models find GLM --json
```

`models --json` 返回 `models` 数组，核对 `selector`、`provider`、`id` 和 `name`；列入目录不证明服务连通或任务质量。`models find` 只按 provider／ID／名称做子串过滤，不识别 TUI 的中文查找线索。

确认名单后，也可用设置命令写入活动全局配置。以下单引号 JSON 写法用于 Bash／tcsh：

```sh
omp config set team.members '["company/GLM-5.2-public","company/Qwen3.8-27B","company/MiniMax-M2.7"]'
omp config get team.members --json
```

使用命名 profile 时，以上每条命令都加相同的 `-P <名称>`，如 `omp -P work config path`。不要把配置写到默认 profile，却在 `work` profile 中使用。


## 3. 让 Agent 根据自然语言自动配置

在普通聊天中明确授权代配，不把写入任务交给只读 `/team`：

```text
请给当前 profile 配置 Team，依次使用智谱 GLM 5.2、千问 3.8 27B 和 MiniMax 2.7。
先查当前环境的真实候选；有歧义不要猜，只改 team.members，不切换主模型。
```

按[代配契约](../openspec/specs/team-discussion/spec.md#scenario-agent-按自然语言代配成员)核实候选、处理歧义并读回有效值。沿用目标会话的操作系统、目录、profile、`OMP_OFFLINE`、原始 `OMP_CONFIG_ROOT` 及覆盖，不用另一个终端的默认环境代替；先读可查的环境和设置。未经当次明确授权，不为验收启动 `/team` 或发送真实模型请求。

已有 provider 无需再写 `models.yml`。如另行授权接入自定义服务，按[模型配置](models.md)使用已核实的 endpoint、协议、模型 ID 与认证来源；关键信息缺失再询问，不虚构配置、不展示密钥或复制认证文件。

## 4. 配置文件在哪里

`omp config path` 返回活动 **agent 目录**，不是文件路径。该目录内可能沿用 `config.yaml`；核对实际读写文件，不改被遮蔽的同名文件。目录解析见 [profile 与设置位置](settings.md#where-settings-live)及 [fork 数据根](../openspec/specs/fork-runtime/spec.md#requirement-安装与运行)。手工编辑仅改授权字段，保留私有权限；它不具备程序保存的锁、版本和回执保证。

### 公司模型的认证来源

`company` 不在目录时，先核对[内网启动环境](../docs-zh-CN/quick-start-intranet.md#红区)，再按[公司模型规格](../openspec/specs/model-providers/spec.md#requirement-公司内网模型仅-omp_offline)检查认证来源；修复后重启 OMP。不要为 Team 重建已有 company provider、切到公网或安装依赖来排查。

## 5. 生效与常见问题

- **改了名单仍用旧模型：** 核对 profile、实际配置文件及[设置优先级](settings.md#precedence)。`team.members` 被更高层整体替换，不追加合并；保存不会清除项目、overlay 或运行时覆盖，也不会改变正在运行的 Team。provider 定义变化后重读模型目录；必要时新开同一 profile 的会话核对。
- **模型不可用：** 用 `omp models --json` 核对 selector 的版本和大小写，再查认证、`enabledModels` 和[来源／禁用策略](settings.md#provider-and-source-disabling)。不要删掉报错项后声称原名单已配置。
- **两个模型却出现三个提案：** 正常行为，AB 按顺序循环为 ABA。
- **主模型不在名单中仍被调用：** 正常行为，当前会话模型承担对齐和综合。
- **想恢复默认：** 面板按 `0` 后 `s`，或通过 CLI 将 `team.members` 设为 `[]`；`omp config reset team.members` 移除用户字段以继承其他来源。有项目／overlay 覆盖时核对最终有效名单。
