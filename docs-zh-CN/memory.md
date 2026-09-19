# 自主记忆

Oh My Pi 支持五种记忆模式。记忆默认关闭；可通过 `/settings` 或 `config.yml` 选择一个后端：

| `memory.backend` | 存储与行为                                           | 指南                                              |
| ---------------- | ---------------------------------------------------- | ------------------------------------------------- |
| `off`            | 无记忆后端                                           | —                                                 |
| `local`          | 由已持久化的会话生成项目级摘要与经验                 | 本页面                                            |
| `hindsight`      | 远程的、按 bank 划分的 Hindsight 记忆                | [Hindsight](#hindsight-远程后端)            |
| `mnemopi`        | 本地 Mnemopi SQLite 记忆                             | [Mnemopi 记忆后端](./mnemosyne-memory-backend.md) |
| `sharpshooter`   | 摩擦门控的项目决策文件（架构/产品/风格），在后台整合 | —                                                 |

启用本地摘要流水线：

```yaml
memory:
  backend: local
```

## 用法

### 注入哪些内容

会话开始时，如果当前项目存在已整合的摘要或手动捕获的经验，就会将其作为 **Memory Guidance** 块注入系统提示中。摘要与经验共享 `memories.summaryInjectionTokenLimit`。

- 把记忆视为启发式上下文——对流程与先前的决策有用，但对当前仓库状态不具权威性。
- 当记忆改变了计划时，引用记忆产物的路径，并在行动前将其与当前仓库的证据配合使用。
- 当仓库状态或用户指令与记忆冲突时，优先采纳前者；把与之冲突的记忆视为过期。

### 读取记忆产物

智能体可以使用 `read` 工具，通过 `memory://` URL 直接读取记忆文件：

| URL                                    | 内容                                                                                                                  |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `memory://root`                        | 启动时注入的紧凑摘要                                                                                                  |
| `memory://root/MEMORY.md`              | 完整的长期记忆文档                                                                                                    |
| `memory://root/learned.md`             | 由 `learn` 工具捕获的经验                                                                                             |
| `memory://root/skills/<name>/SKILL.md` | 生成的技能剧本                                                                                                        |
| `memory://<memory-id>`                 | 完整的 Mnemopi 记忆行（working 或 episodic），带 YAML frontmatter 元数据头；仅当 `memory.backend` 为 `mnemopi` 时可用 |

`memory://<memory-id>` 形式返回完整的存储行，而不是被裁剪的 recall 预览（超出预览上限的 recall 内容会以结尾的 `…` 结束）；智能体被要求在执行任何 `memory_edit update` 之前先读取它。

`memory://root[/…]` 各行由文件支撑，仅在 `memory.backend: local` 时存在，该后端会通过整合流水线填充磁盘上的记忆根目录。在 `hindsight` 或 `mnemopi` 下，根目录永远不会被写入，因此这些 URL 无法解析——请改用 `recall`/`reflect`（在 `mnemopi` 上还可使用 `read memory://<memory-id>`）。

### `/memory` 斜杠命令

| 子命令                | 效果                                                                                                        |
| --------------------- | ----------------------------------------------------------------------------------------------------------- |
| `view`                | 显示当前后端的注入载荷                                                                                      |
| `stats`               | 显示后端特定的记忆统计信息（受支持时）                                                                      |
| `diagnose`            | 显示后端特定的诊断信息（受支持时）                                                                          |
| `queue`               | 显示等待整合的挂起记忆增量                                                                                  |
| `sync`                | 立即运行记忆整合                                                                                            |
| `clear` / `reset`     | 删除当前后端的记忆数据/产物                                                                                 |
| `enqueue` / `rebuild` | 为当前后端强制执行整合/保留工作                                                                             |
| `mm …`                | Hindsight 心智模型维护（`list`/`show`/`refresh`/`history`/`seed`/`delete`/`reload`）；在 ACP 模式下不受支持 |

### 捕获经验

启用 `autolearn.enabled` 以使 `learn` 工具可用：

```yaml
autolearn:
  enabled: true
```

在本地后端处于活动状态时，`learn` 会将显式的持久经验保存到项目的 `learned.md`。经验按最新在前排列，会去重、对敏感信息脱敏，上限为 100 条，并从下一个会话开始被注入；一次 `learn` 调用不会变更当前会话的 prompt-cache 前缀。每条经验的内容上限为 2,000 个字符，可选上下文上限为 400 个字符。本地后端不提供结构化记忆搜索、`recall`、`retain`、`reflect` 与 `memory_edit`。

## 工作原理

本地摘要记忆由一个在启动时运行的后台流水线构建；`/memory enqueue` 会标记整合工作，由下一次启动接手处理。对于子智能体以及未持久化到会话文件的会话，该流水线会被跳过。

**阶段 1 — 按会话提取：** 对于自上次处理以来发生变化的每个过往会话，模型会读取会话历史并提取持久信号：技术决策、约束、已解决的失败、反复出现的工作流。过于新、过于旧、当前处于活动状态，或超出配置的扫描/时长上限的会话会被跳过。每次提取都会为该会话产出一段原始记忆块和一段简短概要。

**阶段 2 — 整合：** 提取完成后，第二轮模型会读取所有按会话提取的内容，并生成三个写入磁盘的产物：

- `MEMORY.md` — 经整理的长期记忆文档
- `memory_summary.md` — 在会话开始时注入的紧凑文本
- `skills/` — 可复用的流程剧本，每个位于各自的子目录中

单独维护的 `learned.md` 不会被整合过程覆盖。

阶段 2 使用租约与心跳，以防止多个进程同时启动时的重复运行。先前运行遗留的过期技能目录会被自动清理。

在将 `MEMORY.md`、`memory_summary.md` 或生成的技能写入磁盘之前，整合输出会针对常见的 secret/token 模式进行脱敏。

### 提取行为

记忆提取与整合行为由 `packages/coding-agent/src/prompts/memories/` 中的静态 prompt 文件驱动。

| 文件                      | 用途                     | 变量                                        |
| ------------------------- | ------------------------ | ------------------------------------------- |
| `stage_one_system.md`     | 按会话提取的系统提示     | —                                           |
| `stage_one_input.md`      | 包裹会话内容的用户轮模板 | `{{thread_id}}`, `{{response_items_json}}`  |
| `consolidation_system.md` | 跨会话整合的系统提示     | —                                           |
| `consolidation.md`        | 跨会话整合的用户轮提示   | `{{raw_memories}}`, `{{rollout_summaries}}` |
| `read-path.md`            | 注入活动会话的记忆指引   | `{{memory_summary}}`, `{{learned}}`         |

### 模型选择

记忆复用了模型角色系统。

| 阶段           | 角色                                                          | 用途             |
| -------------- | ------------------------------------------------------------- | ---------------- |
| 阶段 1（提取） | `default`                                                     | 按会话的知识提取 |
| 阶段 2（整合） | `smol`（回退到 `default`，再回退到当前/注册表中的第一个模型） | 跨会话综合       |

如果所请求的记忆角色未配置，记忆模型的解析会回退到 `default` 角色，然后是当前活动会话模型，最后是注册表中的第一个模型。

## 配置

| 设置                                  | 默认值  | 描述                                                                                                           |
| ------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------- |
| `memory.backend`                      | `off`   | 为这条流水线选择 `local`；未显式设置后端时，旧版的 `memories.enabled: true` 会被迁移为 `memory.backend: local` |
| `memories.maxRolloutAgeDays`          | `30`    | 早于该时长的会话不会被处理                                                                                     |
| `memories.minRolloutIdleHours`        | `12`    | 最近活动时间晚于该时长的会话会被跳过                                                                           |
| `memories.maxRolloutsPerStartup`      | `64`    | 单次启动中处理的会话数上限                                                                                     |
| `memories.threadScanLimit`            | `300`   | 启动时扫描的最近会话记录数上限                                                                                 |
| `memories.maxRawMemoriesForGlobal`    | `200`   | 提供给全局整合的按会话提取数上限                                                                               |
| `memories.stage1Concurrency`          | `8`     | 并发的按会话提取任务数                                                                                         |
| `memories.stage1LeaseSeconds`         | `120`   | 提取任务的租约时长                                                                                             |
| `memories.stage1RetryDelaySeconds`    | `120`   | 失败的提取重新变为可领取之前的延迟                                                                             |
| `memories.phase2LeaseSeconds`         | `180`   | 整合租约时长                                                                                                   |
| `memories.phase2RetryDelaySeconds`    | `180`   | 失败的整合重试之前的延迟                                                                                       |
| `memories.phase2HeartbeatSeconds`     | `30`    | 整合租约心跳间隔                                                                                               |
| `memories.rolloutPayloadPercent`      | `0.7`   | 所选模型的上下文预算中可供 rollout 载荷使用的比例                                                              |
| `memories.phase1InputTokenLimit`      | `4000`  | 按会话提取的输入上限                                                                                           |
| `memories.fallbackTokenLimit`         | `16000` | 模型未声明有限上下文窗口时使用的模型 token 预算                                                                |
| `memories.summaryInjectionTokenLimit` | `5000`  | 注入系统提示的摘要与捕获经验共享的近似 token 上限                                                              |

## Hindsight 远程后端

Hindsight 需要一个可访问的 [Hindsight](https://hindsight.vectorize.io/) 服务器。默认端点为 `http://localhost:8888`；当服务器需要身份验证时设置 token：

```yaml
memory:
  backend: hindsight
hindsight:
  apiUrl: http://localhost:8888
  apiToken: ${HINDSIGHT_API_TOKEN}
```

`HINDSIGHT_*` 环境变量会覆盖 `hindsight.*` 设置，后者又会覆盖内置默认值。有关全部 18 个受支持覆盖项、可接受的值、解析规则、优先级与默认值，请参阅 [完整的 Hindsight 环境变量表](./environment-variables.md#hindsight-记忆后端)。

默认情况下，Hindsight 使用 `per-project-tagged` 作用域：写入操作使用共享 bank 并附带项目标签，而 recall 包含带项目标签和未打标签的全局记忆。`per-project` 将每个工作目录项目隔离到各自的 bank；`global` 使用单个共享 bank。显式设置 `hindsight.bankId` 会选定 bank 基准。对 bank ID、前缀或作用域的更改会重建主会话状态，以便后续操作使用新的作用域。

两种项目作用域模式以相同方式命名项目：取仓库的主 checkout 根目录（这样同一仓库的每个链接的 worktree 都解析到同一目录），然后将该目录的 basename 转为小写。因此位于 `~/code/General` 的 checkout 会打上 `project:general` 标签。标签按字面匹配，因此这一折叠规则确保无论路径大小写如何，同一仓库始终处于同一记忆作用域内。

主会话在首次模型轮次时进行 recall（`hindsight.autoRecall: true`），并在默认情况下每三次用户轮次自动保留已完成的对话轮次。`/memory enqueue` 会刷新排队的工具 retain 并强制对当前会话执行保留。在智能体结束时，主状态会按节奏调度保留并刷新 retain 队列；会话释放在释放该状态之前会排空该队列。请求失败与配置的超时会被记录，并使编码会话保持可用。子智能体会沿用父级的 client、bank 与作用域来进行显式的 `recall`、`retain` 与 `reflect` 调用，但不会运行自身的自动 recall 或保留。

Recall 作为背景上下文而非指令注入，被 recall 的记忆在压缩期间也可作为额外上下文使用。选择 Hindsight 后会暴露 `recall`、`retain` 与 `reflect`；`memory_edit` 不可用，因为上游 Hindsight 记忆不通过本后端进行编辑。

`/memory view`、`/memory stats`、`/memory diagnose` 与 `/memory enqueue` 通过当前活动的 Hindsight 状态运行。`/memory clear` 首先排空挂起的 retain，然后仅清除本地会话状态与 recall 缓存。它**不会删除服务端的 bank**；请使用 Hindsight 的 UI 或 API 删除该 bank。

## 关键文件

- `packages/coding-agent/src/memories/index.ts` — 流水线编排、注入、clear/enqueue 入口（`/memory` 命令通过 `packages/coding-agent/src/memory-backend/local-backend.ts` 路由至此）
- `packages/coding-agent/src/memories/storage.ts` — 基于 SQLite 的任务队列与线程注册表
- `packages/coding-agent/src/prompts/memories/` — 记忆 prompt 模板
- `packages/coding-agent/src/internal-urls/memory-protocol.ts` — `memory://` URL 处理器
