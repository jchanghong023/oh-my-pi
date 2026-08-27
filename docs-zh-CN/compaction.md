# 压缩与分支摘要

压缩与分支摘要是两种机制，让长会话保持可用、同时不丢失先前工作的上下文。

- **压缩（Compaction）** 将旧历史改写为当前分支上的一条摘要。
- **分支摘要（Branch summary）** 在 `/tree` 导航过程中捕获被放弃的分支上下文。

两者都作为会话条目持久化，并在重建 LLM 输入时被转换回用户上下文消息。

## 关键实现文件

- `packages/agent/src/compaction/compaction.ts`（上下文完整的摘要生成与交接文档生成）
- `packages/snapcompact/src/snapcompact.ts`（snapcompact 策略：将历史以密集位图归档）
- `packages/agent/src/compaction/branch-summarization.ts`
- `packages/agent/src/compaction/pruning.ts`
- `packages/agent/src/compaction/compaction-v2-streaming.ts`（provider 原生流式压缩）
- `packages/agent/src/compaction/shake.ts`（机械式内容删减）
- `packages/agent/src/compaction/utils.ts`
- `packages/agent/src/compaction/openai.ts`
- `packages/coding-agent/src/session/session-manager.ts`
- `packages/coding-agent/src/session/agent-session.ts`
- `packages/coding-agent/src/session/session-maintenance.ts`（自动维护编排）
- `packages/coding-agent/src/session/messages.ts`
- `packages/coding-agent/src/extensibility/hooks/types.ts`
- `packages/coding-agent/src/config/settings-schema.ts`

## 会话条目模型

压缩和分支摘要是头等的会话条目，而不是普通的 assistant/user 消息。

- `CompactionEntry`
  - `type: "compaction"`
  - `summary`，可选的 `shortSummary`
  - `firstKeptEntryId`（压缩边界）
  - `tokensBefore`
  - 可选的 `details`、`preserveData`、`fromExtension`
- `BranchSummaryEntry`
  - `type: "branch_summary"`
  - `fromId`、`summary`
  - 可选的 `details`、`fromExtension`

在重建上下文时（`buildSessionContext`）：

1. 活动路径上最新的压缩被转换为一条 `compactionSummary` 消息。
2. 从 `firstKeptEntryId` 到压缩点的被保留条目被重新纳入。
3. 路径上之后的条目被追加在后面。
4. `branch_summary` 条目被转换为 `branchSummary` 消息。
5. `custom_message` 条目被转换为 `custom` 消息。

随后这些自定义角色在 `convertToLlm()` 中被转换为面向 LLM 的消息：`compactionSummary` 和 `branchSummary` 通过静态模板渲染为 user 消息

- `packages/agent/src/compaction/prompts/compaction-summary-context.md`
- `packages/agent/src/compaction/prompts/branch-summary-context.md`

而 `custom` 消息则作为 developer 消息直接以原始内容透传（不使用模板）。

## 压缩流程

### 触发条件

压缩/上下文维护可以通过六种方式运行：

1. **手动上下文压缩**：`/compact [instructions]` 调用 `AgentSession.compact(...)`。
2. **自动溢出恢复**：在同模型 assistant 报错且匹配上下文溢出后。
3. **自动不完整输出恢复**：在同模型 assistant 消息以 `stopReason === "length"` 结束时（OpenAI/Codex `response.incomplete`）。
4. **自动阈值维护**：在成功的轮次之后，上下文超过解析得到的阈值时。
5. **轮次中途阈值维护**：在工具循环轮次跨过阈值且 `compaction.midTurnEnabled !== false` 时，在下一次 provider 请求之前。
6. **空闲维护**：`runIdleCompaction()` 可以以 `"idle"` 为 reason 触发相同的自动维护路径。

### 压缩形态（可视化）

```text
Before compaction:

  entry:  0     1     2     3      4     5     6      7      8     9
        ┌─────┬─────┬─────┬──────┬─────┬─────┬──────┬──────┬─────┬──────┐
        │ hdr │ usr │ ass │ tool │ usr │ ass │ tool │ tool │ ass │ tool │
        └─────┴─────┴─────┴──────┴─────┴─────┴──────┴──────┴─────┴──────┘
                └────────┬───────┘ └──────────────┬──────────────┘
               messagesToSummarize            kept messages
                                   ↑
                          firstKeptEntryId (entry 4)

After compaction (new entry appended):

  entry:  0     1     2     3      4     5     6      7      8     9      10
        ┌─────┬─────┬─────┬──────┬─────┬─────┬──────┬──────┬─────┬──────┬─────┐
        │ hdr │ usr │ ass │ tool │ usr │ ass │ tool │ tool │ ass │ tool │ cmp │
        └─────┴─────┴─────┴──────┴─────┴─────┴──────┴──────┴─────┴──────┴─────┘
               └──────────┬──────┘ └──────────────────────┬───────────────────┘
                 not sent to LLM                    sent to LLM
                                                         ↑
                                              starts from firstKeptEntryId

What the LLM sees:

  ┌────────┬─────────┬─────┬─────┬──────┬──────┬─────┬──────┐
  │ system │ summary │ usr │ ass │ tool │ tool │ ass │ tool │
  └────────┴─────────┴─────┴─────┴──────┴──────┴─────┴──────┘
       ↑         ↑      └─────────────────┬────────────────┘
    prompt   from cmp          messages from firstKeptEntryId
```

### 溢出/不完整恢复 与 阈值/空闲维护

自动路径在设计上有所不同：

- **溢出恢复**
  - 触发：检测到当前模型的 assistant 错误是上下文溢出，且该错误不早于最近一次压缩。
  - 失败的 assistant 错误消息在重试前从活动的 agent 状态中移除。
  - 优先尝试上下文提升（context promotion）；若配置了更大的模型，则 agent 切换模型后重试而不进行压缩。
  - 若提升不可用且压缩已启用，则自动维护以 `reason: "overflow"` 和 `willRetry: true` 遍历 `compaction.methodOrder`；由于交接请求会复用溢出的输入，因此跳过交接。
  - 成功时调度 `agent.continue()` 以重试该轮次。
- **不完整输出恢复**
  - 触发：同模型 assistant 消息以 `stopReason === "length"` 结束，且该消息不早于最近一次压缩。
  - 不完整的 assistant 消息在恢复前从活动 agent 状态中移除。
  - 优先尝试上下文提升。
  - 若提升不可用且压缩已启用，则自动维护以 `reason: "incomplete"` 和 `willRetry: true` 遍历 `compaction.methodOrder`。
  - 与溢出不同，可达的 `handoff` 偏好可以运行，因为输入上下文仍然可用。
  - 软压缩成功时调度 `agent.continue()` 以重试该轮次。
- **阈值维护**
  - 触发：成功的、非错误的 assistant 消息，其调整后上下文 token 数超过 `resolveThresholdTokens(...)`。
  - 当 `compaction.midTurnEnabled !== false` 时，轮次中途维护也会在下一次 provider 请求之前检查安全的工具循环边界。
  - 工具输出剪枝（tool-output pruning）可以在阈值比较前降低测得的 token 数。
  - 上下文提升在轮次后压缩之前先尝试。
  - 若提升不可用，则自动维护以 `reason: "threshold"` 和 `willRetry: false` 遍历 `compaction.methodOrder`。
  - 当 `handoff` 是下一个可运行方法时，轮次后阈值维护通常会调度一个 post-prompt 任务来生成交接文档并将其作为压缩条目提交；pre-prompt 和 mid-turn 检查以内联方式运行所有方法，以避免与下一轮竞争。
  - 成功时，如果 `compaction.autoContinue !== false`，轮次后维护会从 `prompts/system/auto-continue.md` 调度一个由 agent 编写的 developer 自动续接 prompt；mid-turn 维护永远不会调度单独的续接，因为核心循环已经拥有了下一个 provider 请求。
- **空闲维护**
  - 触发：`runIdleCompaction()` 在未流式处理或已压缩时。
  - 使用 `reason: "idle"` 且之后不会自动续接。

### Shake 方法

在 `compaction.methodOrder` 中包含 `shake` 会执行内联的、本地的缩减，而不会调用摘要模型。它使用受保护的最近 token 窗口和最小节省阈值，将符合条件的工具结果和大型围栏/XML 块替换为可恢复的 `artifact://` 引用。自动 shake 以 `action: "shake"` 发出正常的自动压缩事件。

阈值、不完整输出和溢出恢复在 shake 无法回收足够上下文以回到恢复带之下时，会推进到下一个已配置方法；这避免了重复的空操作 shake 循环。空闲 shake 不使用该回退，因为空闲计时器会在再次运行前重新检查使用量。手动 `/shake` 是一个独立的、更激进的命令，可以针对所有符合条件的历史。

### Snapcompact 方法

在 `compaction.methodOrder` 中包含 `snapcompact` 会将 LLM 摘要调用替换为本地、确定性的归档过程（`@oh-my-pi/snapcompact` 中的 `compact`）：

- 丢弃的历史被序列化、空格折叠，并使用内嵌的公共领域像素字体打印到模型相关的 PNG 帧上（每种形状的帧宽度固定；帧高度贴合实际打印的行数）。形状和帧大小在测量模型行时通过 **model id** 解析：Claude 读取 X.org `8x13` 字形、采用 11px 步进（额外字距、黑色墨水 — `11on16-bw`；高分辨率行 — Opus 4.7+、Fable、Mythos — 在 Anthropic 的 4,784 visual-token 上限下获得 1932px 帧，旧行保持 1568px），Gemini 读取 `8x13` 字形、采用 22px 间距（额外行距、黑色墨水 — `8on22-bw` 在 2048px，因为 Gemini 3.x 对每张图按固定的 1,120-token 预算计费、与像素大小无关），GPT/Codex 以 1568px 读取相同的 `8on22-bw` 形状（…
- 序列化保持归档的对话密度：工具结果按头+尾截断（默认 2,000 字符、头尾比例 0.6），工具调用的参数值按值（500）和按调用（2,000）封顶，并且工具输出以暗灰色墨水打印，使对话读起来比工具噪声更突出。所有预算和调暗行为都可通过 `SerializeOptions`（`toolResultMaxChars`、`toolArgMaxChars`、`toolCallMaxChars`、`truncateHeadRatio`、`dimToolResults`）配置。
- snapcompact 归档持久化在 `CompactionEntry.preserveData.snapcompact` 下，作为有界源文本加上渲染后的帧。在每次上下文重建时，它被重建为有序的压缩块：最旧边缘的纯文本、中间的图像块、最新边缘的纯文本。条目的 `summary` 只是简短的恢复引导加上通常的文件操作列表。
- 后续压缩从该有界源文本（`Archive.text`）重新渲染，而不是盲目地携带旧 PNG 向前。`maxFrames` 现在默认为 `MAX_FRAMES_DEFAULT`（80）并仅作为上限；当图像块较大时，会在内部进行注视点渲染（HQ/LQ/HQ），而两个时序边缘则保持逐字的文本。
- 不涉及模型、API 密钥或网络，因此 snapcompact 也安全用于溢出恢复。它需要具备视觉能力的当前模型（`model.input` 包含 `"image"`）；否则自动维护会跳过它并推进到下一个已配置方法。手动 `/compact` 遵守方法顺序，除非给出了自定义指令（这些指令意味着有向的 LLM 摘要）。
- 原理：形状表来自 `packages/snapcompact` 中的 snapcompact 200k-token 评估，在该评估中，与原始文本相比，位图帧以更低的计费 token 成本为具备视觉能力的模型保留了 QA 召回。

### 显示式会话记录

压缩不再从视觉上重启会话。TUI 渲染 **display transcript**（`buildSessionContext({ transcript: true })` / `AgentSession.buildTranscriptSessionContext()`）：按时间顺序的每条路径条目，每次压缩在触发处以纤细分隔线 `── 📷 compacted · ctrl+o ──` 内联显示。展开（ctrl+o）会显示摘要。只有 LLM 上下文在压缩边界处重置；分隔线上方的滚动历史保持完整，包括跨会话恢复时也是如此。

### 压缩前剪枝

在压缩检查之前，工具结果剪枝可能会运行（`pruneToolOutputs`）。

默认剪枝策略：

- 保护最新的 `40_000` 工具输出 token。
- 要求至少 `20_000` 的总估计节省。
- 永远不要将结果清空到 `50` token 以下（`MIN_PRUNE_TOKENS`）：`[Output truncated - N tokens]` 占位符本身约 8 个 token，因此对低于阈值的结果进行剪枝反而会扩大上下文并无谓地搅动 prompt 缓存。（被取代和无用的结果保持各自的规则 — 无用收集器已经丢弃无节省的候选项；被取代的读取会出于正确性进行剪枝，与大小无关。）
- 永远不要剪枝 `skill` 工具结果、`skill://` 路径的 `read` 结果，或活动计划引用文件的读取（通过 `AgentSession` 的计划保护加入）。

剪枝后的工具结果被替换为：

- `[Output truncated - N tokens]`

如果剪枝改变了条目，则在压缩决策之前会重写会话存储并刷新 agent 消息状态。

### 无用结果的删减

工具可以将已完成的结果标记为上下文无用 — 零匹配的搜索、超时且所有内容仍在运行的 `hub` 等待、空的 `hub` 收件箱排出。该标记源自工具结果（`AgentToolResult.useless`，通过 `ToolResultBuilder.useless()` 设置或直接设置在返回对象上），由 agent 循环复制到持久化的 `ToolResultMessage` 上（绝不与 `isError` 同时出现 — 错误总是优先），并在三个地方被消费：

- **每轮过时结果扫描**（`pruneSupersededToolResults`，由 `compaction.dropUseless` 守护，默认开启）：被标记的结果被清空为精确占位符 `[Uneventful result elided]`（`USELESS_NOTICE`），其时序与被取代的读取相同的缓存感知策略 — 仅当候选之后的后缀很小（≤ 约 8k token）或会话空闲时间已超过 provider prompt 缓存生命周期时。结果小于通知本身的永远不会被清空（无节省），且受保护工具豁免。
- **阈值剪枝**（`pruneToolOutputs`）：被标记的结果绕过"保护最近"窗口，与被取代的读取相同，并接收 `USELESS_NOTICE` 而不是 token 数占位符。
- **摘要序列化**：`serializeConversation`（agent 和 snapcompact）从摘要器/归档输入中丢弃整个工具调用/结果对 — 源区域反正会在摘要后被丢弃，因此该排除不会产生缓存成本。

该标记永远不到达 provider 线格式，并且被标记的成对项永远不从历史中移除（仅就地清空），因此工具调用/结果配对和 provider 原生历史重放保持完整。

### 边界与切点逻辑

`prepareCompaction()` 仅考虑自上次压缩条目（如果有）以来的条目。

1. 找到前一次压缩的索引。
2. 计算 `boundaryStart = prevCompactionIndex + 1`。
3. 在可用时使用测得的使用率调整 `keepRecentTokens`。
4. 在边界窗口上运行 `findCutPoint()`。

有效的切点包括：

- 角色为以下的消息条目：`user`、`assistant`、`bashExecution`、`hookMessage`、`branchSummary`、`compactionSummary`
- `custom_message` 条目
- `branch_summary` 条目

硬性规则：永远不要在 `toolResult` 处切。

如果切点紧邻存在非消息元数据条目（`model_change`、`thinking_level_change`、标签等），则通过向后移动切点索引直到命中消息或压缩边界，将它们拉入被保留区域。

### 切分轮次的处理

如果切点不在用户轮次开始处，则压缩将其视为切分轮次。

轮次开始检测将以下视为用户轮次边界：

- `message.role === "user"`
- `message.role === "bashExecution"`
- `custom_message` 条目
- `branch_summary` 条目

切分轮次压缩生成两份摘要：

1. 历史摘要（`messagesToSummarize`）
2. 轮次前缀摘要（`turnPrefixMessages`）

最终存储的摘要按如下方式合并：

```markdown
<history summary>

---

**Turn Context (split turn):**

<turn prefix summary>
```

### 摘要生成

`compact(...)` 从序列化后的会话文本构建摘要：

1. 通过 `convertToLlm()` 转换消息。
2. 使用 `serializeConversation()` 序列化。
3. 包装在 `<conversation>...</conversation>` 内。
4. 可选地包含 `<previous-summary>...</previous-summary>`。
5. 可选地将扩展钩子上下文和活动 memory-backend 压缩上下文注入为 `<additional-context>` 条目。
6. 使用 `SUMMARIZATION_SYSTEM_PROMPT` 执行摘要 prompt。

Prompt 选择：

- 第一次压缩：`compaction-summary.md`
- 已有先前摘要的迭代压缩：`compaction-update-summary.md`
- 切分轮次的第二轮：`compaction-turn-prefix.md`
- 短 UI 摘要：`compaction-short-summary.md`
- 交接文档：`handoff-document.md`（由 `generateHandoff(...)` 使用，非序列化压缩）

远程摘要模式：

- 如果设置了 `compaction.remoteEndpoint` 并启用了远程压缩，本地摘要生成会 POST 以下两种线路格式之一：
  - 自定义 omp 摘要器端点接收 `{ systemPrompt, prompt }` 并必须返回至少包含 `{ summary }` 的 JSON。
  - 路径以 `/chat/completions` 结尾的 OpenAI 兼容端点接收 `{ model, messages, stream: false }`，其中 `messages` 包含一条 system prompt 和一条 user prompt。摘要从 `choices[0].message.content` 读取，这使得自托管服务器（如 llama.cpp 和 vLLM）可以充当远程压缩器而无需单独的摘要器垫片。
- 启用 V2 流式压缩的兼容 OpenAI Responses、Azure OpenAI Responses 和 Codex 模型（其目录元数据启用）首先将 `compaction_trigger` 追加到正常的 Responses 流。返回的压缩项加上保留的真实用户消息成为替换历史，受 `compaction.v2RetainedMessageBudget` 限制；该替换持久化在 `preserveData.openaiRemoteCompaction` 下。
- 如果 V2 不可用或失败，符合条件的 OpenAI/OpenAI Codex 模型会尝试 provider 原生的 `/responses/compact` 路径。本地失败再回退到本地摘要。

### 交接生成

`packages/agent/src/compaction/compaction.ts` 还导出 `generateHandoff(...)`。交接生成使用与摘要相同的 `completeSimple(...)` oneshot 风格，但它通过发送活动系统 prompt、工具数组和真实 LLM 消息历史来保留活动的 agent 缓存前缀，然后追加一条由 agent 归属的包含交接 prompt 的 `user` 消息。它强制 `toolChoice: "none"` 并直接返回已合并的文本块。

交接在当前会话上提交一个常规的 `CompactionEntry`：`SessionMaintenance.handoff()`（手动 `/handoff`）和自动维护的 `handoff` 方法都通过 `SessionHandoff.generateDocument()` 生成文档，并将其作为压缩摘要存储，`firstKeptEntryId` 来自 `prepareCompaction`，因此最近历史被保留，且会话 id、记录和 provider 缓存键不变。

当 `compaction.handoffSaveToDisk` 启用时，**自动触发** 的交接还会在持久化会话的工件目录中写入 `handoff-<ISO timestamp>.md`。手动交接不会通过此设置写入，未持久化的会话没有工件目录。

### 摘要中的文件操作上下文

压缩使用 assistant 工具调用跟踪累积的文件活动：

- `read(path)` → 已读集合
- `write(path)` → 已修改集合
- `edit(path)` → 已修改集合

累积行为：

- 仅当先前条目是 pi 生成时（`fromExtension !== true`）才包含先前压缩详情。
- 在切分轮次中，也包含轮次前缀文件操作。
- `details.readFiles` 排除同时被修改的文件；`details.modifiedFiles` 承载其余文件（持久化形状不变）。

文件列表是分组的、前缀折叠的目录树（find-tool 形状），每个文件带一个访问标记 — 仅读取的文件为 `(Read)`，仅修改且从未读取的为 `(Write)`，也出现在累积已读集合中的已修改文件为 `(RW)`。上限为 20 个文件，并带一行 `[…N files elided…]`。LLM 摘要策略将其作为 `<files>` 标签追加（通过 `upsertFileOperations`）；snapcompact 则在其摘要模板中作为 `FILES` 部分进行渲染。

```xml
<files>
# packages/agent/src/compaction/
compaction.ts (Read)
utils.ts (RW)
## prompts/
file-operations.md (Write)
</files>
```

旧版摘要写入的遗留 `<read-files>`/`<modified-files>` 标签（连同 `<files>`）在重新追加之前会被剥离，因此旧摘要会在下次压缩时自愈。

### 持久化与重载

在生成摘要（或由钩子提供摘要）后，agent 会话：

1. 通过 `appendCompaction(...)` 追加 `CompactionEntry`；handoff 方法将生成的文档作为该条目在同一会话上的摘要提交。
2. 通过 `buildDisplaySessionContext()` 从活动叶子重建显示上下文。
3. 用重建的上下文替换活动的 agent 消息。
4. 从重建的分支同步活动 todo 阶段，并关闭其历史已被重写的 provider 会话。
5. 发出 `session_compact` 钩子事件。

## 分支摘要流程

分支摘要与树导航相关，而非 token 溢出。

### 触发

在 `navigateTree(...)` 期间：

1. 使用 `collectEntriesForBranchSummary(...)` 从旧叶子到共同祖先计算被放弃的条目。
2. 如果调用者请求了摘要（`options.summarize`），则在切换叶子前生成摘要。
3. 如果存在摘要，则使用 `branchWithSummary(...)` 将其附加到导航目标。

在操作上，这通常由 `/tree` 流程在启用 `branchSummary.enabled` 时驱动。

### 分支切换形态（可视化）

```text
Tree before navigation:

         ┌─ B ─ C ─ D (old leaf, being abandoned)
    A ───┤
         └─ E ─ F (target)

Common ancestor: A
Entries to summarize: B, C, D

After navigation with summary:

         ┌─ B ─ C ─ D (abandoned branch, unchanged)
    A ───┤
         └─ E ─ F ─ [summary of B,C,D] (new leaf)
```

### 准备与 token 预算

`generateBranchSummary(...)` 按以下方式计算预算：

- `tokenBudget = model.contextWindow - branchSummary.reserveTokens`

然后 `prepareBranchEntries(...)`：

1. 第一遍：从所有被摘要的条目中收集累积文件操作，包括先前 pi 生成的 `branch_summary` 详情。
2. 第二遍：从最新到最旧遍历，添加消息直到达到 token 预算。
3. 优先保留最近上下文。
4. 仍可能在预算边缘附近包含大型摘要条目以保持连续性。

在分支摘要输入中，压缩条目作为消息（`compactionSummary`）被包含。

### 摘要生成与持久化

分支摘要：

1. 转换并序列化选定的消息。
2. 包装在 `<conversation>` 内。
3. 如果提供了自定义指令则使用，否则使用 `branch-summary.md`。
4. 使用 `SUMMARIZATION_SYSTEM_PROMPT` 调用摘要模型。
5. 前置 `branch-summary-preamble.md`。
6. 追加文件操作标签。

结果作为 `BranchSummaryEntry` 存储，可选详情（`readFiles`、`modifiedFiles`）。

## 扩展与钩子切入点

### `session_before_compact`

压缩前钩子。

可以：

- 取消压缩（`{ cancel: true }`）
- 提供完整自定义压缩负载（`{ compaction: CompactionResult }`）

### `session.compacting`

默认压缩的 Prompt/上下文自定义钩子。

可以返回：

- `prompt`（覆盖基础摘要 prompt）
- `context`（注入 `<additional-context>` 的额外上下文行）
- `preserveData`（存储在压缩条目上）

### `session_compact`

压缩后通知，包含已保存的 `compactionEntry` 和 `fromExtension` 标志。

### `session_before_tree`

在树导航上、默认分支摘要生成之前运行。

可以：

- 取消导航
- 提供自定义 `{ summary: { summary, details } }`，在用户请求摘要时使用

### `session_tree`

导航后事件，公开新/旧叶子以及可选的摘要条目。

## 运行时行为与失败语义

- 手动压缩首先中止当前 agent 操作。
- `abortCompaction()` 取消手动压缩、自动压缩和交接生成控制器。
- 自动压缩发出 start/end 会话事件以供 UI/状态更新。
- 自动压缩可以尝试多个模型候选项并重试瞬态失败；当有下一个候选项时，长重试延迟优先使用下一个候选项。
- 溢出错误被排除在通用重试路径之外，因为它们由上下文提升/压缩处理。
- 如果自动压缩失败：
  - 溢出路径发出 `Context overflow recovery failed: ...`
  - 不完整输出路径发出 `Incomplete response recovery failed: ...`
  - 阈值/空闲路径发出 `Auto-compaction failed: ...`
- 分支摘要可以通过中止信号取消（例如 Escape），返回已取消/中止的导航结果。

## 设置与默认值

来自 `settings-schema.ts`：

- `compaction.enabled` = `true`
- `compaction.methodOrder` = `["remote", "snapcompact", "handoff", "shake", "soft"]`。`remote` 在可用时使用 provider 原生的 OpenAI 兼容服务器压缩；不可用或失败的方法会推进到下一个偏好。
- `compaction.asyncEnabled` = `true`。异步（推测）压缩：当上下文进入预阈值带 `[threshold − lead, threshold)`（lead = `clamp(threshold × 0.125, 8192, 32000)`）时，维护会为第一个已配置的 LLM 支持方法（`remote`、`handoff` 或 `soft`）在分支快照上启动后台摘要，该快照通过侧会话 id 与活动轮次隔离。当真正跨过阈值时，已装备的结果会立即提交，隐藏摘要延迟；快照后轮次在摘要后原样追加。当分支前缀发生变化（新的压缩、重置边界、`/tree` 导航）、当 provider 原生重放负载不再可被活动模型读取，或当 cont…
- `compaction.reserveTokens` 默认未设置。压缩层通常应用 `16384` token 的下限和至少上下文窗口的 15%；在较小的窗口上该默认值不切实际时，预算检查使用 15% 的比例保留。显式配置的保留值会被遵守。
- `compaction.keepRecentTokens` = `20000`
- `compaction.autoContinue` = `true`
- `compaction.midTurnEnabled` = `true`
- `compaction.handoffSaveToDisk` = `false`
- `handoff` 方法通过 live-cache 侧请求管道生成交接文档，并将其作为压缩条目提交到当前会话（不创建新会话）；`/handoff` 手动执行相同操作。
- `compaction.remoteEndpoint` = `undefined`
- `compaction.remoteStreamingV2Enabled` = `true`
- `compaction.v2RetainedMessageBudget` = `64000`
- `compaction.thresholdPercent` = `-1` 且 `compaction.thresholdTokens` = `-1`；正固定 token 限制优先于百分比，否则使用基于保留的阈值。
- `compaction.idleEnabled` = `false`
- `compaction.idleThresholdTokens` = `200000`
- `compaction.idleTimeoutSeconds` = `300`
- `compaction.supersedeReads` = `true`
- `compaction.dropUseless` = `true`
- `snapcompact.systemPrompt` = `"none"`（`"agents-md"` 和 `"all"` 选择加入对系统 prompt 的瞬时成像）
- `snapcompact.toolResults` = `false`（对大型历史工具结果进行瞬时成像）
- `snapcompact.shape` = `"auto"`
- `branchSummary.enabled` = `false`
- `branchSummary.reserveTokens` = `16384`

这些值在运行时由 `AgentSession`、`SessionMaintenance` 和压缩/分支摘要模块消费。
