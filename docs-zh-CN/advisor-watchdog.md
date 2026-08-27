# Advisor、WATCHDOG.md 和 WATCHDOG.yml

顾问子系统为一个会话附加一个或多个可选的审阅模型。每个顾问都会审阅主代理的转录更新，可以使用自己的工具检视工作区，并将简明的建议注入回主会话。

顾问不批准操作，也不直接变更主会话状态。其默认的调查工具集是 `read`、`grep` 和 `glob`，但 `WATCHDOG.yml` 名单条目可授权任何内建工具 —— 包括变更类工具，如 `edit`、`write`、`bash`、`eval` 和 `browser`。这些工具运行在隔离的顾问 `ToolSession` 中，但会遵守会话的常规审批模式和按工具配置的策略；仅在顾问模型和工作区可信时授予（参见 [工具与隔离](#工具与隔离)）。

## 实现文件

- [`src/advisor/runtime.ts`](../packages/coding-agent/src/advisor/runtime.ts)
- [`src/advisor/advise-tool.ts`](../packages/coding-agent/src/advisor/advise-tool.ts)
- [`src/advisor/emission-guard.ts`](../packages/coding-agent/src/advisor/emission-guard.ts)
- [`src/advisor/watchdog.ts`](../packages/coding-agent/src/advisor/watchdog.ts)
- [`src/advisor/config.ts`](../packages/coding-agent/src/advisor/config.ts)
- [`src/advisor/transcript-recorder.ts`](../packages/coding-agent/src/advisor/transcript-recorder.ts)
- [`src/prompts/advisor/system.md`](../packages/coding-agent/src/prompts/advisor/system.md)
- [`src/prompts/advisor/advise-tool.md`](../packages/coding-agent/src/prompts/advisor/advise-tool.md)
- [`src/session/session-advisors.ts`](../packages/coding-agent/src/session/session-advisors.ts)
- [`src/session/agent-session.ts`](../packages/coding-agent/src/session/agent-session.ts)
- [`src/slash-commands/builtin-registry.ts`](../packages/coding-agent/src/slash-commands/builtin-registry.ts)
- [`src/config/settings-schema.ts`](../packages/coding-agent/src/config/settings-schema.ts)

---

## 启用顾问

该子系统要求 `advisor.enabled: true`。模型选择随后取决于名单：

- 若未发现任何 `WATCHDOG.yml` 顾问条目，OMP 会创建遗留/默认顾问，并从 `modelRoles.advisor` 解析其模型。
- 若存在名单，每个已启用条目在有显式 `model` 时使用该模型，否则使用 `modelRoles.advisor`。无法解析的条目会报告为 `no_model`，但不会阻止其他条目运行。
- `advisors[].enabled: false` 会让条目在状态中显示为已暂停，但不会构建其运行时。

示例：

```yaml
modelRoles:
  advisor: anthropic/claude-sonnet-4-5:medium

advisor:
  enabled: true
```

模型选择器使用常规的角色/模型解析机制，包括带 provider 前缀的 id、规范 id、回退列表，以及可选的思考后缀。

`tier.advisor` 控制所有顾问的服务层级。默认为 `none`（标准处理）；`inherit` 跟随主代理当前按家族的层级，包括 `/fast` 变更。具体取值（`auto`、`default`、`flex`、`scale`、`priority`）仅在顾问模型的 provider 家族支持时才会应用。

### 无头运行

使用 `--advisor` 在单次打印模式进程中启用顾问，而不持久化 `advisor.enabled`：

```sh
omp -p --advisor "Review this task."
```

当主提示正在运行时，顾问的关注事项和阻断信号会持续引导该实时轮次。在最终提示结束后，打印模式保留迟到的顾问备注而不启动隐藏的主轮次，然后等待最多十分钟以完成最终审阅，再释放会话。错误退出使用 30 秒的排空预算，以便失败的自动化能够终止。如果任一期限到期，OMP 会记录将被释放所放弃的审阅；已完成的审阅会保留其转录和 token/成本用量。

斜杠命令：

| 命令                  | 效果                                                                                                                                     |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `/advisor`           | 切换当前会话的顾问子系统（会话级覆盖；不更改持久化的 `advisor.enabled`）。                                                                  |
| `/advisor on`        | 为当前会话启用已配置/默认的顾问运行时。会话级；不持久化到配置。                                                                                |
| `/advisor off`       | 为当前会话禁用顾问子系统并停止其运行时。会话级；不持久化到配置。                                                                              |
| `/advisor status`    | 显示每个顾问的运行时状态、模型、上下文用量、token 用量和成本。                                                                                  |
| `/advisor dump`      | 将精简转录（存在名单时为所有活跃顾问）复制到剪贴板。                                                                                          |
| `/advisor dump raw`  | 复制完整转储，包括系统提示、工具、思考和调用。                                                                                                 |
| `/advisor configure` | 打开项目级或用户级 `WATCHDOG.yml` 的交互式 TUI 编辑器。非 TUI 命令宿主会报告该编辑器仅限 TUI。                                                 |

如果子系统已启用但遗留/默认或名单中的模型都无法解析，状态会将已配置的顾问报告为未激活/`no_model`。

## 顾问所见内容

在每次主代理更新时，`AdvisorRuntime` 只会接收自上次更新以来的新转录增量。增量会连同推理、工具意图、被关注角色标记以及展开后的主代理约束上下文一起渲染，因此顾问既能审阅助手推理，也能审阅用户可见的文本、工具调用和工具结果。与 provider 绑定的消息以及工具参数/结果在送达顾问模型之前会先经过会话密钥混淆器处理。

大多数隐藏的 `custom` 消息会在增量中折叠为单行摘要。主代理注入的约束上下文（`plan-mode-context` 和 `plan-mode-reference`）则会被原样渲染在 XML 转义的 `<primary-context kind="…">` 包装中，重复副本会被去重。顾问还会通过 `<project-context>` 系统提示块接收主代理发现的项目上下文文件（`AGENTS.md` 及相关的常驻指令）。如果会话的当前工作目录在 Git 之外且正好有一个直接子仓库，一个额外的 watchdog 块会告知顾问哪个子目录是当前活动项目。

已注入到主转录中的顾问消息会在渲染下一条增量前被过滤掉。这可以防止顾问递归地审阅自己的建议。

当主转录被重写时，顾问运行时会被重置：

- 压缩
- 会话切换/恢复
- 分支/分叉形式的历史替换
- 当顾问自身上下文无法容纳时的 context-maintenance 重新预热

重置会清除顾问私有的内存中转录并回退其游标。下一次顾问更新会重放当前有界的主转录，而不是从过时的重写前上下文继续。

当顾问在会话中途启用时，游标会从当前主转录长度开始播种。这避免了在首次启用轮次时重放整段旧对话。

## 工具与隔离

顾问是一个完整的代理，拥有自己的 `Agent` 实例和独立的 `ToolSession`，其 id 后缀为 `-advisor`。它不共享主代理的文件快照、已见行追踪、冲突状态或摘要缓存。

每个顾问都拥有 `advise` 工具，用于将备注呈现到主转录中。当省略 `tools` 时，其调查授权为：

- `read`
- `grep`
- `glob`

`WATCHDOG.yml` 名单条目可以选择任何实际上为该会话构建的内建工具子集（返回 `null` 的工厂，例如不可用的 `lsp`，则不包含在内）。显式空 `tools: []` 授予零个调查工具；`advise` 仍然可用。仅包含未知项的列表会被丢弃并给出警告，当前回退到默认子集。可授权名称包括变更类工具，如 `edit`、`write`、`bash`、`eval`、`browser`、`debug`、`ast_edit`、`task`、`hub` 以及内存工具。

顾问工具是针对隔离的顾问 `ToolSession` 构建的，并由 `ExtensionToolWrapper` 包装，因此 `tools.approvalMode`、按工具的审批策略和 `autoApprove` 的行为与注册表工具一致。Cursor 的服务端 exec 桥使用相同的审批上下文，并且仅在对应的顾问授权存在时才暴露 delete/edit/search 能力。

`advise` 工具接受一条备注和可选的严重程度：

| 严重程度            | 传递                                                                                                                                                                       | 预期用途                                                       |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| 省略 / `nit`        | 非中断性附注，在下一步边界批量合入主转录。                                                                                                                              | 清理、简化、低风险边界情况。                                     |
| `concern`           | 在下方传递约束允许时作为中断性引导消息。迟到的终局回答 `concern` 会作为可见卡片保留。                                                                                  | 重大风险、方向可能错误、约束缺失、API 幻觉。                   |
| `blocker`           | 在下方传递约束允许时作为中断性引导消息。与 `concern` 不同，仅靠终局回答无法阻止其触发轮次。                                                                              | 继续下去将明显浪费工作或产生损坏输出。                          |

被接受的备注会以 XML 转义的 `<advisory>` 元素形式渲染到主转录中。具名名单顾问会附加 `advisor` 属性：

```text
<advisory advisor="Architecture" severity="concern" guidance="weigh, don't blindly obey">
note text
</advisory>
```

当你刻意中断代理（Esc，或来自 collab、ACP、RPC、SDK、扩展的取消）时，顾问会停止自动恢复它。在运行已停止时提出的中断性 `concern`/`blocker` 会作为可见顾问卡片记录，而不会重启轮次；在你中断时已经在途的关注项也会以相同方式保留，而不是驱动一次意外的恢复。建议会在下次恢复时重新进入上下文 —— 新消息、`.`/`c` 继续快捷键，或 steer/follow-up。

代理自行驱动的普通 yield 与刻意中断的处理方式不同，但也不是"始终引导并恢复"的笼统规则。循环状态和已完成的轮次首先决定正常的传递路径：

- **在循环仍在流式输出时**（提出动作先于 yield 到达，或在你已经驱动的恢复期间），备注通常会引导进入当前轮次。
- **在循环已 yield 并进入空闲后**，传递取决于轮次如何结束：
  - 如果主代理的尾部是**没有待办工作的终局文本回答**，迟到的 `concern` 会作为可见卡片保留，而不是唤醒代理重述已完成的轮次（#4840）—— 它会在下次恢复时（新消息、`.`/`c`、或 steer/follow-up）重新进入上下文，与中断情况完全相同。`blocker` 是例外：它通常会引导一个被触发的轮次，因为它意味着代理交出了损坏的或未经检验的工作，必须在轮次被视为完成之前得到确认（#5628）。
  - 其他情况（代理在工作中途 yield，没有终局回答），空闲的 `concern`/`blocker` 通常会触发一个新轮次，以便建议立即被处理。

两条会话/客户端约束仍然可以保留那些正常传递路径为引导的备注：

- **计划模式：** 每次原本要进行的顾问引导都会作为可见卡片保留，即使在主循环流式输出时也是如此，因为只有用户驱动的轮次才会以 ask/resolve 收敛。
- **具有延迟代理主动轮次的 ACP：** 当 `deferAgentInitiatedTurns` 已启用且桥尚未允许代理主动轮次时，空闲中原本要进行的引导会被保留，因为客户端无法将触发的轮次表示为忙。在主循环已经在流式输出时提出的建议仍可引导进入该实时轮次。

因此，顾问可以在代理自行结束**仍在运行或中途 yield 且当前模式/客户端允许引导**的运行时引导并恢复该运行。当引导被阻止时，备注要么作为卡片保留（上述终局回答、计划模式、延迟 ACP 情况），要么降级为非中断性附注（下方 `advisor.immuneTurns` 冷却期）；无论哪种方式，它都会等待下一步边界或恢复，而不是唤醒代理。

`advisor.immuneTurns` 限制中断频率。在顾问通过引导通道成功传递 `concern` 或 `blocker` 之后，后续的 concern/blocker 会被路由为非中断性附注，直到配置的主轮次数完成。默认值为 `3`。`nit` 备注保持不变；在用户中断自动恢复抑制生效时提出的建议仍会被保留，而不是重启已停止的运行。

当顾问更新正在审阅仍在进行中的工作时，`AdviseTool` 会扣留 `nit` 和 `concern` 调用；只有 `blocker` 可以中断进行中的工作。该工具还会在相同空白归一化、严重程度相同或更低时抑制同一备注，同时允许真正的升级（`nit` → `concern` → `blocker`）。

### 输出守卫

每个顾问在 `AdviseTool` 到 YieldQueue/引导通道的路径上都有自己的 `AdvisorEmissionGuard`（`src/advisor/emission-guard.ts`）。它强制执行系统提示中的"每次更新最多接受一条备注"以及不重复规则：

1. **归一化。** 小写化、NFKC，将每一段非字母数字字符折叠为一个空格，然后修剪。`"Stop."`、`"*Stop*"` 和 `"  stop  "` 都归为 `stop`。
2. **无内容短语过滤。** 没有具体理由的短短语 —— `stop`、`done`、`complete`、`no issue continue`、`lgtm`、`nothing to add` 等等 —— 会被抑制。
3. **精确文本去重。** 本会话中本顾问已接受的任何归一化备注都会被丢弃。FIFO 历史最多保存 4096 条。
4. **每次更新速率限制。** 每个顾问模型 `prompt()` 周期最多接受一条备注。被抑制的噪声不会消耗预算。

由于 `AdviseTool` 已返回 `Recorded.`，守卫级抑制对模型不可见。该工具先前对严重程度相同或更低的重复检查会以 `Duplicate advice ignored.` 显式呈现；进行中的非 blocker 返回 `Recorded.` 而不进行路由。

守卫的完整状态 —— 去重历史和每次更新门控 —— 在每次顾问重置（压缩、会话切换、`/new`）时清除，因此重新预热的审阅者可以重新提出它已针对重写后转录提出过的问题。

## 通过 `advisor.syncBacklog` 实现有界追赶

`advisor.syncBacklog` 不是锁步轮次执行。它是当顾问落后时主代理的有界追赶延迟。

允许的取值：

- `off` —— 永不等待顾问追赶
- `1`
- `3`
- `5`

在主轮次结束时：

1. 主轮次增量被排队给顾问
2. 顾问排空循环在后台启动或继续
3. 如果 `advisor.syncBacklog` 不是 `off`，主代理仅在顾问积压达到或超过配置阈值时等待
4. 等待上限为 30 秒
5. 如果顾问追赶至低于阈值，主代理立即继续
6. 如果上限到期，主代理无论如何继续

实际含义：

- `off` 倾向于最大化主代理吞吐量。
- `1` 是最接近同步审阅的模式：每次排队顾问增量之后，主代理等待最多 30 秒以使积压归零。
- `3` 和 `5` 在主代理暂停前允许更多顾问延迟。

顾问失败不会永久阻塞主代理。宿主首先尝试其凭证/回退恢复。可重试失败最多尝试三次，然后该积压被丢弃；三次积压丢弃循环会暂停运行时，直至显式重置，而永久请求拒绝可能在一个循环后暂停运行时。配额/用量限制失败会暂停顾问并保留其批次，直至 `/advisor` 重建它、配置被重新加载、新会话开始，或进程重启。追赶等待者在顾问失败时立即被释放。

不安全的顾问输出遵循单独的隔离路径，而不是该三次请求重试策略。在工具调度之前，运行时会对请求顾问不可用的非桥工具的轮次进行隔离。它还会在检测到仅输出的破坏性 shell 指令时，或当破坏性 shell、指令覆盖、拒绝指令、账户删除声明中至少三类仅输出危险匹配时，隔离生成的文本/建议。新的指令覆盖加上输入中引用的破坏性命令也符合条件。整个顾问轮次（包括其中的任何建议）在调度前被丢弃。

首次连续隔离静默重置并以最新待处理上下文重新预热顾问。第二次连续隔离发出一次去重的宿主警告，丢弃受影响的批次，并重置顾问上下文以打破循环。任何成功的顾问轮次都会重置隔离计数器。

## WATCHDOG.md

`WATCHDOG.md` 是仅限顾问的指导。它被追加到顾问系统提示中；不会注入到主代理的常规上下文中，也不会像 `AGENTS.md`、`RULES.md` 或其他上下文文件那样表现。

用于审阅优先级：顾问应关注的风险、项目特有的陷阱、危险的 API、架构边界，以及对审阅者有用但对主执行者而言过于嘈杂的质量门槛。

示例：

```markdown
# Watchdog notes

Especially watch for:

- Changes that bypass the durable queue in `src/jobs/`.
- UI renderer paths that display unsanitized tool output.
- New worker spawns that do not re-enter the CLI host.
```

### 发现位置

`discoverWatchdogFiles(cwd, agentDir)` 从以下位置加载每个可读候选：

1. 用户级：`<active agent dir>/WATCHDOG.md`（默认为 `~/.omp/agent/WATCHDOG.md`；由 `PI_CODING_AGENT_DIR` 重定位）
2. 从 `cwd` 向上走到 git 仓库根的项目级（如果未找到仓库根，则走到主目录）：
   - `<dir>/WATCHDOG.md`
   - `<dir>/.omp/WATCHDOG.md`

与原生上下文文件不同，watchdog 发现不会在最近的项目文件处停止。多个项目 watchdog 文件可以一起加载。

隐藏的所有者目录中的候选文件会被忽略，除非该文件位于 `.omp` 目录内。这可以防止无关的点目录约定被意外选取，同时仍允许 `.omp/WATCHDOG.md`。

### `@` 导入

`WATCHDOG.md` 内容使用与上下文文件相同的 `@` 导入助手进行展开：

- 相对导入从导入文件所在目录解析
- `~/` 从用户主目录解析
- 围栏代码块和行内代码 span 中的导入保持原样
- 循环会被跳过
- 缺失或不可读的导入会保留原始 `@path` 文本

### 提示顺序

加载的 watchdog 块按以下顺序排序：

1. 用户级 `WATCHDOG.md`
2. 项目级文件，从较远的祖先向 `cwd` 靠近

每个文件作为以下内容追加到顾问系统提示中：

```xml
Especially pay attention to:
<attention>
...expanded watchdog content...
</attention>
```

较后的项目文件更接近顾问提示的末尾，因此更窄目录的指导比宽泛祖先的指导更为突出。

## WATCHDOG.yml

`WATCHDOG.yml`（或 `WATCHDOG.yaml`）是顾问名单。`WATCHDOG.md` 提供审阅优先级，而 `WATCHDOG.yml` 则声明顾问本身 —— 每个名称一个条目，各有自身的启用标志、模型、工具授权和专项提示。交互式 `/advisor configure` 覆盖层会就地编辑此文件。无法解析或未通过 schema 校验的文件会被记录并跳过，因此单个有问题的项目配置不会终止会话。

示例：

```yaml
instructions: |
  Everyone: prefer diffs that keep tests unified.

advisors:
  - name: Architecture
    enabled: true
    model: anthropic/claude-sonnet-4-5:medium
    tools: [read, grep, glob]
    instructions: |
      Watch cross-module coupling and public-API growth.

  - name: Fixer
    enabled: false
    model: anthropic/claude-sonnet-4-5:high
    tools: [read, grep, glob, edit, bash]
    instructions: |
      You may edit and run tests to prove a fix locally, then advise.
```

字段：

- `instructions`（顶级）：共享提示，与 `WATCHDOG.md` 一并前置到每个顾问的系统提示中。跨所有发现的 `WATCHDOG.yml` 文件拼接。
- `advisors[].name`：人类可读标签；用于会话 id 及其 `__advisor.<slug>.jsonl` 文件名的 slug 化。跨文件的重复 slug 通过与 `WATCHDOG.md` 发现相同的特异性规则解析（项目叶 > 项目祖先 > 用户）。
- `advisors[].enabled`：可选的按顾问开关，默认为 `true`。`false` 时该顾问在状态/配置中显示为已暂停。
- `advisors[].model`：可选的模型选择器，可带 `:level` 思考后缀（例如 `x-ai/grok-code-fast:high`）。省略 → 顾问使用 `modelRoles.advisor`。
- `advisors[].tools`：可选的内建工具名称列表以授予。省略 → 默认 `read`/`grep`/`glob` 子集；显式 `[]` → 无调查工具。接受 [`BUILTIN_TOOL_NAMES`](../packages/coding-agent/src/tools/builtin-names.ts) 中的任何名称，包括变更类工具。遗留别名（`search`→`grep`，`find`→`glob`）会被规范化。未知名称会被丢弃并给出警告；如果因此留下没有有效名称的非空输入，实现当前将其视为省略并使用默认子集。
- `advisors[].instructions`：本顾问的专项内容，追加在共享基线之后。两个指令字段都会像 `WATCHDOG.md` 一样展开 `@path` 导入。

### 发现位置

`WATCHDOG.yml`/`WATCHDOG.yaml` 共享与 `WATCHDOG.md` 相同的用户 + 项目搜索路径：用户级 `<active agent dir>/WATCHDOG.yml` 加上从 `cwd` 向上走到仓库根（如果未找到仓库根，则走到主目录）时遇到的每个 `WATCHDOG.yml`/`.omp/WATCHDOG.yml`。所有发现的文件一起加载；更具体的文件（项目叶 > 项目祖先 > 用户）会替换相同顾问 slug 的较早条目。

## 子代理

子代理默认不受顾问监督；顾问是**按代理**选择加入的，而不是通过全局开关：

- 代理定义 frontmatter `advisor`：`true` 会以 `advisor` 角色解析的模型为该代理生成的会话提供顾问；字符串（例如 `advisor: "deepseek/deepseek-v4-flash"` 或 `advisor: "@smol:high"`）设置显式的顾问模型模式，可带 `:level` 思考后缀。
- `task.agentAdvisor` 设置记录（代理名称 → `"on"` / `"off"` / 模型模式）覆盖 frontmatter，并从 `/agents` 集线器按代理配置：在代理上按 Enter 打开其属性条；顾问条提供 on/off、模型浏览器选择或原始模式。

遗留的 `advisor.subagents: true` 设置会迁移到 `task.agentAdvisor: { task: "on" }` —— 捆绑的通用 `task` 代理保留其顾问，其他代理默认不受顾问监督。

受顾问监督的子代理会话会构建自己的顾问子系统，使用相同的设置/模型角色解析（显式模式落到生成会话的 `modelRoles.advisor`），然后为该子代理会话的 `cwd` 和代理目录重新运行 `WATCHDOG.md` 和 `WATCHDOG.yml` 发现。子代理顾问与子代理的主工具会话保持隔离，与主顾问与主代理隔离的方式相同。

## 成本与上下文行为

顾问用量是单独的模型用量。`/advisor status` 从顾问代理自身的转录报告顾问 token 计数和成本。

顾问拥有自己的仅追加上下文。在每次顾问提示之前，`AgentSession` 估算传入 token 并可能维护顾问上下文：

1. 在启用且存在更大兼容模型时尝试模型级上下文提升
2. 如果提升无法容纳足够上下文，则压缩顾问自身的消息历史
3. 如果压缩没有候选或仍无法容纳，则从当前有界的主转录重新预热

顾问的实时上下文是内存中且仅追加的；在会话运行期间会被保留，以便 `/advisor dump` 检视它，并独立进行提升/压缩/重新预热（见上）。它不是主持久化转录的替代。

## 转录持久化与可观测性

顾问是被动审阅者，拥有自己的模型用量，因此 —— 与任务子代理类似 —— 每个已完成的顾问轮次都会以 JSONL 形式追加到所属会话的 artifacts 目录中：

- 遗留/默认顾问：`<session>/__advisor.jsonl`
- 具名顾问：`<session>/__advisor.<slug>.jsonl`
- 子代理顾问（frontmatter `advisor` / `task.agentAdvisor`）：`<session>/<SubId>/__advisor[.<slug>].jsonl`

路径源自所属会话文件（而非共享 artifacts 根），因此每个主代理/子代理顾问写入不同的文件。保留的 `__advisor` 名称不能与任务子代理 id 冲突。

为什么是文件：

- **用量归属。** `omp stats` 递归扫描每个会话文件夹，因此顾问助手轮次（连同其用量/成本）像任何其他子代理一样归属于同一项目/会话。顾问"会话更新"提示作为 `synthetic`、归属于代理的用户消息被持久化，因此不会膨胀用户消息指标。
- **可观测性。** [Agent Hub](./agent-hub.md) 在打开时发现遗留和具名的 `__advisor*.jsonl` 文件，并在所属会话下将每个显示为只读的 `advisor` 类型转录。

文件跟随会话切换：在 `/new`、恢复/切换和分支时，记录器在下一个顾问轮次时在新会话路径重新打开；在 `/drop` 删除旧 artifacts 目录之前，记录器馈送被分离并排空，以使排队写入不能重新创建已删除的文件。磁盘上的日志是仅追加的，与内存中上下文独立 —— 重新预热和压缩永远不会截断它。

顾问永远不是对等体。`advisor` 类型的注册表引用被排除在所有面向代理的表面之外 —— `hub` 对等体名单和广播目标、子代理对等体提示，以及 `history://` 索引/查找/补全 —— 并且不能被发送消息（`hub` 发送和 collab 聊天拒绝它）或从 [Agent Hub](./agent-hub.md#persisted-agents-and-advisors) 或 collab [恢复或终止](./agent-hub.md#persisted-agents-and-advisors)。它不可作为对等体寻址，无论被授予了什么工具。
