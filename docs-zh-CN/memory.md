# Autonomous Memory

Oh My Pi 支持四种记忆模式。记忆默认关闭；可通过 `/settings` 或 `config.yml` 选择一个后端：

| `memory.backend` | 存储与行为                                                     | 指南                                                        |
| ---------------- | -------------------------------------------------------------- | ----------------------------------------------------------- |
| `off`            | 无记忆后端                                                     | —                                                           |
| `local`          | 由已持久化的会话生成项目级摘要与经验                           | 本页面                                                     |
| `hindsight`      | 远程的、按 bank 划分的 Hindsight 记忆                          | [Hindsight](#hindsight-remote-backend)                      |
| `mnemopi`        | 本地 Mnemopi SQLite 记忆                                       | [Mnemopi memory backend](./mnemosyne-memory-backend.md)     |

启用本地摘要流水线：

```yaml
memory:
  backend: local
```

## Usage

### What gets injected

会话开始时，如果当前项目存在合并后的摘要或手动捕获的经验，会将其作为 **Memory Guidance** 块注入到系统提示中。摘要与经验共享 `memories.summaryInjectionTokenLimit`。

- 将记忆视为启发式上下文——对流程与先前的决策有用，但不应作为当前仓库状态的权威依据。
- 当记忆改变了计划时，引用记忆产物的路径，并在行动前与当前仓库的证据配合使用。
- 当仓库状态或用户指令与记忆冲突时，优先采纳前者，并将冲突的记忆视为过期。

### Reading memory artifacts

智能体可直接使用 `read` 工具通过 `memory://` URL 读取记忆文件：

| URL                                    | Content                              |
| -------------------------------------- | ------------------------------------ |
| `memory://root`                        | Compact summary injected at startup  |
| `memory://root/MEMORY.md`              | Full long-term memory document       |
| `memory://root/learned.md`             | Lessons captured by the `learn` tool |
| `memory://root/skills/<name>/SKILL.md` | A generated skill playbook           |

### `/memory` slash command

| Subcommand            | Effect                                                    |
| --------------------- | --------------------------------------------------------- |
| `view`                | Show the current backend injection payload                |
| `stats`               | Show backend-specific memory statistics, when supported   |
| `diagnose`            | Show backend-specific diagnostics, when supported         |
| `clear` / `reset`     | Delete active backend memory data/artifacts               |
| `enqueue` / `rebuild` | Force consolidation/retention work for the active backend |

### Capturing lessons

启用 `autolearn.enabled` 以使 `learn` 工具可用：

```yaml
autolearn:
  enabled: true
```

在本地后端激活时，`learn` 会将显式的持久经验保存到项目的 `learned.md`。经验按时间倒序排列，已去重，对敏感信息已脱敏，最多 100 条，并在下一个会话开始时被注入；`learn` 调用不会变更当前会话的 prompt-cache 前缀。每条经验的内容上限为 2,000 个字符，可选上下文上限为 400 个字符。本地后端不提供结构化记忆搜索、`recall`、`retain`、`reflect` 与 `memory_edit`。

## How it works

本地摘要记忆由一个在启动时运行的后台流水线构建；`/memory enqueue` 会标记整合工作，由下一次启动接管。对于子智能体和未持久化到会话文件的会话，该流水线会被跳过。

**Phase 1 — per-session extraction：** 对于自上次处理以来发生变化的每个过往会话，模型会读取会话历史并提取持久化信号：技术决策、约束、已解决的失败、重复出现的工作流。过于新、过于旧、当前正在进行的会话，或超出配置的扫描/时间上限的会话将被跳过。每次提取会为该会话产出一段原始记忆块和一段简短摘要。

**Phase 2 — consolidation：** 提取完成后，第二轮模型会读取所有按会话提取的内容，并生成三个写入磁盘的产物：

- `MEMORY.md` — 经过策展的长期记忆文档
- `memory_summary.md` — 在会话开始时注入的紧凑文本
- `skills/` — 可复用的流程剧本，每个位于各自的子目录中

由 `learned.md` 单独维护，不会在整合时被覆盖。

Phase 2 使用租约与心跳机制以防止多进程同时启动时的重复运行。先前运行遗留的过期技能目录会被自动清理。

在将 `MEMORY.md`、`memory_summary.md` 与生成的 skills 写入磁盘前，整合输出会针对常见的 secret/token 模式进行脱敏。

### Extraction behavior

记忆提取与整合行为由 `packages/coding-agent/src/prompts/memories/` 中的静态 prompt 文件驱动。

| File                      | Purpose                                          | Variables                                   |
| ------------------------- | ------------------------------------------------ | ------------------------------------------- |
| `stage_one_system.md`     | System prompt for per-session extraction         | —                                           |
| `stage_one_input.md`      | User-turn template wrapping session content      | `{{thread_id}}`, `{{response_items_json}}`  |
| `consolidation_system.md` | System prompt for cross-session consolidation    | —                                           |
| `consolidation.md`        | User-turn prompt for cross-session consolidation | `{{raw_memories}}`, `{{rollout_summaries}}` |
| `read-path.md`            | Memory guidance injected into live sessions      | `{{memory_summary}}`, `{{learned}}`         |

### Model selection

记忆复用了模型角色系统。

| Phase                   | Role                                                                | Purpose                          |
| ----------------------- | ------------------------------------------------------------------- | -------------------------------- |
| Phase 1 (extraction)    | `default`                                                           | Per-session knowledge extraction |
| Phase 2 (consolidation) | `smol` (falls back to `default`, then current/first registry model) | Cross-session synthesis          |

如果所请求的记忆角色未配置，则记忆模型的解析会回退到 `default` 角色，然后是当前会话模型，最后是注册表中的第一个模型。

## Configuration

| Setting                               | Default | Description                                                                                                                              |
| ------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `memory.backend`                      | `off`   | Select `local` for this pipeline; legacy `memories.enabled: true` is migrated to `memory.backend: local` when no explicit backend is set |
| `memories.maxRolloutAgeDays`          | `30`    | Sessions older than this are not processed                                                                                               |
| `memories.minRolloutIdleHours`        | `12`    | Sessions active more recently than this are skipped                                                                                      |
| `memories.maxRolloutsPerStartup`      | `64`    | Cap on sessions processed in a single startup                                                                                            |
| `memories.threadScanLimit`            | `300`   | Maximum recent session records scanned at startup                                                                                        |
| `memories.maxRawMemoriesForGlobal`    | `200`   | Maximum per-session extractions supplied to global consolidation                                                                         |
| `memories.stage1Concurrency`          | `8`     | Concurrent per-session extraction jobs                                                                                                   |
| `memories.stage1LeaseSeconds`         | `120`   | Extraction job lease duration                                                                                                            |
| `memories.stage1RetryDelaySeconds`    | `120`   | Delay before a failed extraction becomes claimable again                                                                                 |
| `memories.phase2LeaseSeconds`         | `180`   | Consolidation lease duration                                                                                                             |
| `memories.phase2RetryDelaySeconds`    | `180`   | Delay before failed consolidation is retried                                                                                             |
| `memories.phase2HeartbeatSeconds`     | `30`    | Consolidation lease heartbeat interval                                                                                                   |
| `memories.rolloutPayloadPercent`      | `0.7`   | Fraction of the selected model's context budget available to rollout payloads                                                            |
| `memories.phase1InputTokenLimit`      | `4000`  | Per-session extraction input cap                                                                                                         |
| `memories.fallbackTokenLimit`         | `16000` | Model token budget used when the model has no finite declared context window                                                             |
| `memories.summaryInjectionTokenLimit` | `5000`  | Shared approximate token cap for the summary and captured lessons injected into the system prompt                                        |

## Hindsight remote backend

Hindsight 要求可访问的 [Hindsight](https://hindsight.vectorize.io/) 服务器。默认端点为 `http://localhost:8888`；当服务器需要身份验证时设置 token：

```yaml
memory:
  backend: hindsight
hindsight:
  apiUrl: http://localhost:8888
  apiToken: ${HINDSIGHT_API_TOKEN}
```

`HINDSIGHT_*` 环境变量会覆盖 `hindsight.*` 设置，后者又会覆盖内置默认值。有关全部 18 个受支持覆盖项、可接受的值、解析规则、优先级与默认值，请参阅 [完整的 Hindsight 环境变量表](./environment-variables.md#hindsight-memory-backend)。

默认情况下，Hindsight 使用 `per-project-tagged` 作用域：写入操作使用共享 bank 并附带项目标签，而 recall 包含项目标签和未打标签的全局记忆。`per-project` 将每个工作目录项目隔离到各自的 bank；`global` 使用单个共享 bank。通过显式设置 `hindsight.bankId` 来选择 bank 基础。对 bank ID、前缀或作用域的更改会重建主会话状态，以便后续操作使用新的作用域。

两种项目作用域模式以相同方式命名项目：取仓库的主 checkout 根目录（这样同一仓库的每个链接的 worktree 都解析到同一目录），然后将其 basename 小写化。因此位于 `~/code/General` 的 checkout 会打上 `project:general` 标签。标签按字面匹配，因此这一折叠规则确保无论路径大小写如何，同一仓库始终处于同一记忆作用域内。

主会话在首次模型轮次时进行 recall（`hindsight.autoRecall: true`），并在默认情况下每三次用户轮次自动 retain 已完成的对话轮次。`/memory enqueue` 会刷新排队的工具 retain 并强制对当前会话执行 retain。在智能体结束时，主状态会调度基于节奏的 retain 并刷新 retain 队列；会话释放在释放该状态之前会排空该队列。请求失败与配置的超时会被记录，并使编码会话保持可用。子智能体复用父级的 client、bank 和作用域以进行显式的 `recall`、`retain` 与 `reflect` 调用，但不会运行自身的自动 recall 或 retain。

Recall 作为背景上下文而非指令注入，被 recall 的记忆在压缩过程中也作为额外上下文可用。选择 Hindsight 后会暴露 `recall`、`retain` 与 `reflect`；`memory_edit` 不可用，因为上游 Hindsight 记忆不通过本后端进行编辑。

`/memory view`、`/memory stats`、`/memory diagnose` 与 `/memory enqueue` 通过当前激活的 Hindsight 状态运行。`/memory clear` 首先排空挂起的 retain，然后仅清除本地会话状态与 recall 缓存。它**不会删除服务端的 bank**；请使用 Hindsight 的 UI 或 API 删除该 bank。

## Key files

- `packages/coding-agent/src/memories/index.ts` — 流水线编排、注入、clear/enqueue 入口（`/memory` 命令通过 `packages/coding-agent/src/memory-backend/local-backend.ts` 路由至此）
- `packages/coding-agent/src/memories/storage.ts` — 基于 SQLite 的任务队列与线程注册表
- `packages/coding-agent/src/prompts/memories/` — 记忆 prompt 模板
- `packages/coding-agent/src/internal-urls/memory-protocol.ts` — `memory://` URL 处理器
