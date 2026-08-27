# Provider 兼容参考：OpenAI 兼容标志、推理级别与工具处理

`packages/ai`（类型定义位于 `packages/catalog`）四个子系统的参考：

1. [OpenAI 兼容标志](#1-openai-兼容标志) — 每个 `compat` 字段及其线上行为
2. [推理级别](#2-推理级别) — 思考强度/思考预算如何下发到各 provider
3. [各 provider 的工具处理](#3-各-provider-的工具处理) — schema 转换、流式传输、结果编码
4. [强制工具选择](#4-强制工具选择) — `toolChoice` 语义、线上映射、模拟实现

相关参考：

- [Provider endpoint constraints](./provider-endpoint-constraints.md) — 新约束应归入何处
- [Provider streaming internals](./provider-streaming-internals.md) — 流事件规范化
- [Provider quirks](./provider-quirks.md) — 各 provider 特殊场景、流行为、鉴权/使用、目录处理
- [Model and Provider Configuration](./models.md) — `models.yml` 与面向用户的 `compat` 覆盖

## 1. OpenAI 兼容标志

### 架构

兼容标志分两个阶段解析：

1. **目录构建时**（`packages/catalog/src/compat/openai.ts`）：`buildOpenAICompat(spec)` / `buildOpenAIResponsesCompat(spec)` 在 `buildModel` 内对每个模型运行一次。默认值从 `provider`、`baseUrl`、模型 id/名称以及 `spec.reasoning` 自动推断；显式的 `spec.compat` 覆盖通过 `applyCompatOverrides`（`packages/catalog/src/compat/apply.ts`）合并。如果存在适用的 `whenThinking` 变体（显式覆盖、直接 DeepSeek 推理、OpenCode 推理网关），则会预构建一个**完整的备用解析兼容对象**，作为 `compat.whenThinking` 挂载。
   OpenRouter 是一个伪 API：`buildOpenRouterCompat` 将完整的 chat-completions 视图与仅 Responses 字段合并为 `ResolvedOpenRouterCompat`，因此同一模型对象可同时满足两个运行时 handler（`PI_OPENROUTER_RESPONSES` 选择派发路径）。
2. **请求时**（`packages/ai/src/providers/openai-shared.ts`）：`resolveOpenAICompatPolicy(model, options)` 将已解析的 compat 与每个请求的选项（`reasoning`、`disableReasoning`、`toolChoice` 等）组合为包含 `reasoning`、`tools`、`messages` 和 `stream` 子策略的 `OpenAICompatPolicy`。当思考已开启且存在 `whenThinking` 时，策略会**指针切换**到预构建的变体上 —— 不进行逐请求的展开或分配：

   ```ts
   const compat = enabled && baseCompat.whenThinking ? baseCompat.whenThinking : baseCompat;
   ```

消费者：`openai-completions.ts` 中的 `applyChatCompletionsCompatPolicy` + `buildParams`、`openai-responses.ts` 中的 `buildResponsesInput`、`transform-messages.ts` 中的消息转换、`stream.ts` 中的流看门狗。

`packages/catalog/src/types.ts` 中声明的每个标志都在 `packages/ai` 的某处被消费；不存在无效标志。

### 共享标志（chat-completions + responses）

类型：`packages/catalog/src/types.ts` 中的 `OpenAICompat` / `ResolvedOpenAISharedCompat`。

"共享"指该字段在两种解析视图上以相同的线上契约存在 —— **并非**两个 builder 推断出相同的默认值。`buildOpenAICompat` 与 `buildOpenAIResponsesCompat` 各自计算自身的默认值；下表在两者不一致处以 *Chat:* / *Responses:* 区分（单一推断 = 两个表面相同）。

#### 消息整形

| 标志 | 默认推断 | 线上效果 |
| --- | --- | --- |
| `supportsDeveloperRole` | Chat：官方 OpenAI、Azure。Responses：另加 GitHub Copilot | 系统提示以 `developer` 角色而非 `system` 角色发送 |
| `requiresToolResultName` | Chat：Mistral 为 `true`。Responses：始终为 `false` | 在 `role: "tool"` 消息上添加 `name: <toolName>` |
| `requiresAssistantAfterToolResult` | Chat：Mistral 为 `true`。Responses：始终为 `false` | 在工具结果与随后的用户消息之间插入一条合成的 assistant 消息（严格的角色交替） |
| `requiresThinkingAsText` | Chat：Mistral 为 `true`。Responses：始终为 `false` | 将 assistant 的思考以 `<thinking>...</thinking>` 文本形式重放，而非原生 reasoning 字段（`transform-messages.ts`） |
| `requiresMistralToolIds` | Chat：Mistral 为 `true`。Responses：始终为 `false` | 工具调用 id 规范化为恰好 9 个字母数字字符（`normalizeMistralToolId`） |
| `requiresAssistantContentForToolCalls` | Chat：Kimi、直接 DeepSeek 推理。Responses：仅 Kimi | 工具调用轮次上的空 assistant 内容变为 `"."`，以避免 HTTP 400 |
| `usesOpenAIToolCallIdLimit` | 官方 OpenAI 为 `true` | 工具调用 id 截断为 40 个字符 |

#### 推理线上格式

| 标志 | 默认推断 | 线上效果 |
| --- | --- | --- |
| `supportsReasoningEffort` | Chat：Grok、Xiaomi MiMo、部分 Z.AI/Zhipu 为 `false`。Responses：仅 `xai-oauth` 上非 effort 能力的 Grok 为 `false` | 控制是否发出 `reasoning_effort` |
| `omitReasoningEffort` | 当 `supportsReasoningEffort` 为 `false` 时为 `true` | 即使思考开关已开启，也抑制 `reasoning_effort`（思考开关字段仍会发出） |
| `reasoningEffortMap` | Chat：Kimi K3（`KIMI_K3_REASONING_EFFORT_MAP`）、MiMo；否则为 `{}`。Responses：始终为 `{}` | 将 `Effort` 值重映射为 provider 字符串（例如 `minimal` → `low`） |
| `thinkingFormat` | Chat：`"zai"`（Kimi K2.x/Z.AI/Zhipu/MiMo）、`"qwen"`（DashScope）、`"qwen-chat-template"`（NVIDIA NIM 上的 Qwen）、`"openrouter"`、`"openai"` 默认（含 Venice/Fireworks Qwen）。Responses：仅 `"openrouter"` 或 `"openai"` | 选择思考启用的编码方式：`thinking: { type: "enabled" }`（zai）、`enable_thinking: true`（qwen）、`chat_template_kwargs: { enable_thinking: true }`（qwen-chat-template）、`reasoning: { effort }`（openrouter）、直接的 `reasoning_effort`（openai） |
| `reasoningDisableMode` | 从 `thinkingFormat` 派生，并带有 host 覆盖 | 显式关闭推理时发送的内容：`venice-disable-thinking` → `venice_parameters.disable_thinking: true`，`zai-thinking-disabled` → `thinking: { type: "disabled" }`，`qwen-enable-thinking-false` → `enable_thinking: false`，`qwen-template-false` → `chat_template_kwargs.enable_thinking: false`，`openrouter-enabled-false` → `reasoning: { enabled: false }`，`lowest-effort`，或 `omit`（`encodeChatCompletionsDisabledReasoning`） |
| `supportsReasoningParams` | Chat：GitHub Copilot 为 `false`。Responses：始终为 `true` | 当为 `false` 时，抑制**所有**推理参数 |
| `reasoningContentField` | 默认 `"reasoning_content"`；备选 `"reasoning"`、`"reasoning_text"` | 在历史消息上重放 assistant 思考时使用的键 |
| `requiresReasoningContentForToolCalls` | Chat：Kimi（OpenCode 别名除外）、DeepSeek 推理、MiMo、OpenRouter 推理请求。Responses：Kimi/DeepSeek/OpenRouter，仅在具备推理能力时 | 历史中的 assistant 工具调用轮次必须带有推理内容（真实或合成的） |
| `requiresReasoningContentForAllAssistantTurns` | 直接 DeepSeek 推理、MiMo | 将上述要求扩展到每个 assistant 轮次 |
| `allowsSyntheticReasoningContentForToolCalls` | Chat：DeepSeek 推理家族与 MiMo 为 `false`。Responses：DeepSeek 推理为 `false` | 当为 `true` 时，`"."` 占位符可替代被剥离的推理；当为 `false` 时，仅重放真实内容 |
| `replayReasoningContent` | Chat：本地后端为 `true`（llama.cpp、LM Studio、vLLM、Ollama、loopback/private baseUrls）。Responses：始终为 `false`（通过加密 item 重放推理） | 在每个 assistant 轮次上将保留的思考以 `reasoning_content` 形式重放，以便本地聊天模板能重建 `<think>` 块并保持前缀 KV-cache 命中 |
| `qwenPreserveThinking` | Chat：本地后端上具备 `replayReasoningContent` 的 Qwen 思考格式。Responses：始终为 `false`（模板开关仅适用于 chat-completions） | 发出 `preserve_thinking: true`（顶层和/或位于 `chat_template_kwargs` 中），使 Qwen 3.6+ 模板也能为更早的轮次渲染 `<think>` —— 这是一个历史开关，而非逐轮切换（`applyChatCompletionsCompatPolicy`） |
| `kimiApiFormat` | 按模型协议元数据 | Kimi Code 模型的 `"openai"` 与 `"anthropic"` 传输（`providers/kimi.ts`） |
| `includeEncryptedReasoning` | Chat：始终为 `true`。Responses：`xai-oauth` 为 `false` | Responses 请求是否重放加密的推理 item |
| `filterReasoningHistory` | Chat：OpenRouter Anthropic 模型。Responses：另加 `xai-oauth` | 从重放的 Responses 历史中过滤原生推理 item |

#### 工具选择 / 严格模式交互

| 标志 | 默认推断 | 线上效果 |
| --- | --- | --- |
| `supportsToolChoice` | Chat：直接 DeepSeek 推理为 `false`。Responses：始终为 `true` | 当为 `false` 时，完全省略 `tool_choice` |
| `supportsForcedToolChoice` | Chat：必须思考的模型以及 OpenCode DeepSeek 推理为 `false`。Responses：始终为 `true` | 当为 `false` 时，`required`/命名选择降级为 `auto` |
| `supportsNamedToolChoice` | 仅支持字符串的 host（llama.cpp、LM Studio）为 `false` | 当为 `false` 时，命名选择变为：将 `tools` 过滤至该单一函数 + `tool_choice: "required"` |
| `disableReasoningOnForcedToolChoice` | Chat：Kimi（原生 K3 除外）或 Anthropic 模型 id。Responses：所有 Kimi | 当工具选择被强制时，丢弃推理字段 |
| `disableReasoningOnToolChoice` | DeepSeek 推理（经 OpenRouter 的除外） | 当存在**任何** `tool_choice` 时，丢弃推理字段 |
| `supportsStrictMode` | OpenAI、OpenRouter、Cerebras、Together、Copilot、Zenmux、Azure、DeepSeek 为 `true` | 当为 `false` 时，永远不会在工具定义上设置 `strict: true` |
| `toolSchemaFlavor` | Kimi/Moonshot 为 `"moonshot-mfjs"`，本地后端为 `"grammar"` | 额外的 schema 规范化：`normalizeSchemaForMoonshot` 或 `sanitizeSchemaForGrammar`（`utils/schema/normalize.ts`） |

#### 采样、token、缓存、路由

| 标志 | 默认推断 | 线上效果 |
| --- | --- | --- |
| `supportsSamplingParams` | o1/o3/gpt-5+ 类模型为 `false` | 当为 `false` 时，省略 `temperature`/`top_p`/惩罚项（它们会返回 400） |
| `alwaysSendMaxTokens` | Kimi 家族 | 始终发送最大输出 token 字段（默认为模型上限）以保证 Kimi TPM 核算正确 |
| `openRouterRouting` | 未设置 | 在 OpenRouter 请求体中添加 `provider: { only, order }` 字段（`applyOpenAIGatewayRouting`） |
| `promptCacheSessionHeader` | Chat：Grok（`xai`）为 `"x-grok-conv-id"`。Responses：同一 header，用于 `xai-oauth` | 随 prompt-cache 会话键一起发出该 HTTP header |
| `supportsPromptCacheBreakpoints` / `promptCacheBreakpointTtl` | 官方 OpenAI GPT-5.6+ | 控制是否启用显式 prompt-cache 断点；若请求不被支持则抛出 `ConfigurationError`。TTL 默认为 `"30m"` |
| `isOpenRouterHost` | OpenRouter host 推断（两个 builder 均适用） | 省略默认最大 token 上限（OpenRouter 上可选字段为路由提示）并附加路由 |
| `wireModelIdMode` | Chat：`"firepass"` / `"fireworks"` / `"openrouter"` / `"raw"`。Responses：`"openrouter"` 或 `"raw"` | 用于网关派发的模型 id 重写 |

#### 流解析 / 看门狗

| 标志 | 默认推断 | 线上/流效果 |
| --- | --- | --- |
| `reasoningDeltasMayBeCumulative` | MiniMax host | 流解析器将推理增量视为累积快照而非增量 |
| `stripDeepseekSpecialTokens` | NVIDIA NIM 或直接 API 上的 DeepSeek | 从可见文本中剥离泄漏的聊天模板 token（`<｜User｜>` 等） |
| `streamMarkupHealingPattern` | `"kimi"`（Kimi/Moonshot）、`"dsml"`（DeepSeek DSML host）、`"thinking"`（通用兼容 host），官方 OpenAI 未设置 | 为泄漏的模板标记选择 `StreamMarkupHealing` 模式 |
| `emptyLengthFinishIsContextError` | Ollama | 完成内容为空且 `finish_reason: "length"` → 上下文溢出错误 |
| `streamFirstEventTimeoutMs` | 本地后端为 `0` | 首事件看门狗提示（`0` = 无上限的预填充/模型加载时间） |
| `streamIdleTimeoutMs` | GLM/Alibaba coding plans 为 600 s；MiMo、Kimi 推理、DeepSeek 推理、本地后端为 300 s | 事件间空闲看门狗下限（`stream.ts`） |

### 仅 chat-completions 的标志（`ResolvedOpenAICompat`）

| 标志 | 默认推断 | 线上效果 |
| --- | --- | --- |
| `supportsStore` | 标准 OpenAI 形态的 host 为 `true`，非标准的（Cerebras、Grok、Mistral、Fireworks、Z.AI 等）为 `false` | 当为 `true` 时，发送 `store: false`（选择不保留）；当为 `false` 时，省略该字段，因为 host 会拒绝 |
| `supportsMultipleSystemMessages` | 仅对规范 host 白名单为 `true`（OpenAI、Azure、OpenRouter、Cerebras、Together、Fireworks、Groq、DeepSeek、Mistral、Grok、Z.AI、Zhipu、Copilot、Zenmux），对 MiniMax/Alibaba/Qwen host 永不为 `true`；其余一律为 `false`（`openai.ts` 中 `supportsMultipleSystemMessagesDefault`） | 当为 `false` 时，前导的系统消息合并为一条（以 `\n\n` 连接）；当为 `true` 时，保持分开以复用 KV-cache |
| `supportsUsageInStreaming` | Cerebras 为 `false` | 添加 `stream_options: { include_usage: true }` |
| `maxTokensField` | Mistral、原生 Moonshot、Z.AI、Zhipu、Chutes、Fireworks、直接 DeepSeek 为 `"max_tokens"`；其余为 `"max_completion_tokens"` | 输出 token 字段名（`resolveOpenAIOutputTokenParam`） |
| `thinkingKeep` | Kimi K2.6 为 `"all"` | 添加 `thinking.keep: "all"` |
| `cacheControlFormat` | OpenRouter `anthropic/*` 模型为 `"anthropic"` | 向消息部分添加 Anthropic `cache_control: { type: "ephemeral" }` 标记（`maybeAddAnthropicCacheControl`） |
| `toolStrictMode` | Cerebras 为 `"all_strict"`；默认 `"mixed"` | `all_strict` 强制对所有工具设置 `strict: true`，`none` 省略它，`mixed` 尊重每个工具的 `strict` |
| `vercelGatewayRouting` / `isVercelGatewayHost` | Vercel AI Gateway host（在 Responses 视图上同样存在） | 路由位于 `providerOptions.gateway` 之下 |
| `dropThinkingWhenReasoningEffort` | Fireworks | 当存在 `reasoning_effort` 时删除 `thinking` 块（Fireworks 同时拒绝两者） |
| `extraBody` | 未设置（由 DeepSeek 推理策略使用） | 任意 JSON 合并到请求体中（`applyOpenAIExtraBody`） |
| `whenThinking` | OpenCode 网关、直接 DeepSeek 推理、显式覆盖 | 预构建的完整备用 `ResolvedOpenAICompat`，在思考激活时指针切换（仅 chat-completions 视图；OpenRouter 的合并 compat 继承它） |

### 仅 Responses 的标志（`ResolvedOpenAIResponsesCompat`）

| 标志 | 默认推断 | 线上效果 |
| --- | --- | --- |
| `supportsLongPromptCacheRetention` | 官方 OpenAI | 请求时发送 `prompt_cache_retention: "24h"` |
| `strictResponsesPairing` | Azure OpenAI、Copilot Responses | 在构建 Responses input item 时强制严格的 1:1 工具调用/工具结果配对 |
| `supportsImageDetailOriginal` | Copilot、xai-oauth 为 `false` | 输入图片上的 `detail: "original"` 与 `detail: "auto"`（对 `original` 返回 400 的 host 改用 `auto`） |
| `supportsObfuscationOptOut` | 官方 OpenAI | 允许 `stream_options: { include_obfuscation: false }` |

## 2. 推理级别

### 强度模型

规范的强度刻度为 `Effort` 枚举（`packages/catalog/src/effort.ts`）：`minimal`、`low`、`medium`、`high`、`xhigh`、`max`。

每模型的能力存储于 `ThinkingConfig`（`packages/catalog/src/types.ts`），由 `resolveModelThinking`（`packages/catalog/src/model-thinking.ts`）在模型构建时一次性解析：

- `mode` — 传输机制：`effort`（OpenAI 风格）、`budget`（token 预算）、`google-level`（枚举级别）、`anthropic-adaptive`、`anthropic-budget-effort`
- `efforts` — 按规范顺序支持的级别
- `effortMap` — 烘焙的上游线上字符串重映射（例如在不具有 xhigh 的模型上 `xhigh` → `high`）
- `effortRouting` — 强度（或 `"off"`） → 动态模型 id 变体（`resolveWireModelId` 选择线上 id）
- `effortBudgets` — 为合并后的强度层级预计算的 token 预算
- `requiresEffort` — 思考不可关闭
- `suppressWhenOff` — "off" 必须在线上显式发送（`includeThoughts: false` / `thinkingBudget: 0`），而不仅仅是省略

运行时辅助函数：`clampThinkingLevelForModel`（将请求的强度限制为模型支持的强度）、`mapEffortToGoogleThinkingLevel`、`mapEffortToAnthropicAdaptiveEffort`。

### 各 provider 的线上映射

| Provider | 模式 | 线上编码 |
| --- | --- | --- |
| Anthropic（`providers/anthropic.ts`） | `anthropic-adaptive` 或 `budget` | 自适应：`thinking: { type: "adaptive" }` + `output_config.effort: low…max`（需要 beta `effort-2025-11-24`）；预算：`thinking: { type: "enabled", budget_tokens: N }`。交错思考通过 beta `interleaved-thinking-2025-05-14`。`ensureMaxTokensForThinking` 将 `max_tokens` 至少提升至 `budget_tokens + 1024` |
| OpenAI Responses（`providers/openai-responses.ts`） | `effort` | `reasoning: { effort }` 加上 `reasoning.summary: "auto" \| "detailed" \| "concise" \| null` |
| OpenAI Chat Completions（`providers/openai-completions.ts`） | `effort` | 默认 `reasoning_effort`；实际开关字段取决于 `thinkingFormat`（参见[标志表](#推理线上格式)） |
| Google Gemini / Vertex（`providers/google-shared.ts`） | `google-level` 或 `budget` | `thinkingConfig: { includeThoughts, thinkingLevel: MINIMAL…HIGH, thinkingBudget: N }` |

### OpenAI 兼容解析流水线

`resolveOpenAICompatPolicy`（`providers/openai-shared.ts`）在每个请求上做如下决策：

1. **启用/禁用** — 请求的强度与模型推理支持对比，减去抑制规则（`disableReasoningOnForcedToolChoice`、`disableReasoningOnToolChoice`、`none` 强度处理）。
2. **`whenThinking` 切换** — 启用 + 变体存在 → 活动 compat 变为预构建的变体。
3. **线上强度** — 请求的 `Effort` 通过 `compat.reasoningEffortMap` / `model.thinking.effortMap` 映射；`omitReasoningEffort` 抑制该字段同时保留思考开关。
4. **禁用编码** — 当推理关闭但线上需要显式的关闭信号时，`encodeChatCompletionsDisabledReasoning` 按 `reasoningDisableMode` 发出对应格式。

如果 host 以 400/422 拒绝发出的强度，`resolveOpenAIReasoningEffortFallback`（`providers/openai-reasoning-fallback.ts`）会解析错误文本，提取可接受的值或丢弃该参数，然后重试。

### 从流中取回思考

- **结构化增量**：provider 发出 `thinking_start` / `thinking_delta` / `thinking_end` 流事件。
- **历史重放**：先前的思考通过 assistant 消息上的 `reasoningContentField` 重放（在 DeepSeek/Z.AI/Qwen/本地后端上保留 KV-cache）；要求工具调用轮次上具有推理内容的模型，根据 `allowsSyntheticReasoningContentForToolCalls` 获得真实内容或 `"."` 占位符。
- **泄漏的思考修复**：`wrapLeakedThinkingStream`（`utils/leaked-thinking-stream.ts`）将行为异常的 host 在带内泄露的 ` ```thinking ` / `<think>` 围栏实时转换为结构化思考块。
- **循环防护**：`withThinkingLoopGuard`（`utils/thinking-loop.ts`）检测失控的推理（逐字重复、近似三字母组合簇、进度词典停滞）并以可重试的 `AIError.Flag.ThinkingLoop` 终止流。

### 交互

- **采样夹紧**：启用推理的模型（Opus 4.7+、Fable/Mythos 5、o-series/GPT-5）拒绝显式的 `temperature`/`top_p`；`anthropic.ts` 与兼容策略（`supportsSamplingParams`）会抑制它们。
- **强制工具选择**：参见[§4](#边界情况)；若干 provider 必须在强制工具调用时丢弃思考。

## 3. 各 provider 的工具处理

所有 provider 起始于同一中性线上 schema —— `toolWireSchema(tool)`（`utils/schema/wire.ts`）—— 在规范化、流形态以及结果编码上发生分歧。

### Anthropic（`providers/anthropic.ts`）

- **Schema**：`buildAnthropicToolSchemaPlans` 决定每个工具的严格度：白名单（`ANTHROPIC_STRICT_TOOL_ALLOWLIST`）、禁用不兼容关键字（`oneOf`/`allOf`/`$ref`/`patternProperties`/`propertyNames`）、以及预算上限（`MAX_ANTHROPIC_STRICT_TOOLS`、可选/联合参数限制）。严格 schema 经 `normalizeAnthropicStrictSchema` 处理（`additionalProperties: false`）；开放 map 保持非严格以保留 map 语义。线上格式：`{ name, description, input_schema, eager_input_streaming?, strict? }`。
- **流式传输**：`content_block_start`（`tool_use`，携带 `id`+`name`） → `input_json_delta` 片段 → 在 `content_block_stop` 通过 `parseStreamingJson` 解析。包络异常会被记录（`reportAnthropicEnvelopeAnomaly`），但不会致命。
- **结果**：带有 `tool_result` 块（`tool_use_id`）的 `user` 消息。图像嵌入在 `tool_result.content` 内部；**错误**结果时 Anthropic 拒绝嵌入的图像，因此文本保留在块中，图像被提升到 `tool_result` 段之后。Z.AI 的 Anthropic 形态端点额外需要块上的 `id`（`requiresToolResultId`）。
- **重放怪癖**：assistant 轮次被稳定地划分为 `[...non_tool_use, ...tool_use]`，使 `tool_use` 块位于尾部 —— 否则 Anthropic 会以 "tool_use ids were found without tool_result blocks immediately after" 返回 400。
- **严格回退**：400 严格拒绝将设置 `providerSessionState.strictToolsDisabled` 并在无 `strict` 下重试。

### OpenAI Chat Completions（`providers/openai-completions.ts`）

- **Schema**：`convertTools` + `adaptSchemaForStrict`；严格度来自 `toolStrictMode`（`all_strict` / `mixed` / `none`），由 `supportsStrictMode` 与每工具的 `strict` 控制。Moonshot host 还会通过 MFJS 子集检查。线上格式：`{ type: "function", function: { name, description, parameters, strict? } }`。
- **流式传输**：`choice.delta.tool_calls`（`index`、`id`、`function.name`、`function.arguments` 片段）。MiniMax 将 arguments 作为原始 JSON **对象**而非字符串流出 —— 两种形态会被合并（`mergeStreamingArgumentObjects`）。泄漏的 DeepSeek 模板 token 会按 `stripDeepseekSpecialTokens` 剥离。当看到结构化调用时，`finish_reason: "stop"` 被提升为 `"tool_calls"`。
- **结果**：`{ role: "tool", tool_call_id, content }`；Mistral id 被规范化；assistant 重放设置 `tool_calls` 数组与内容 `""`（或在 `requiresAssistantContentForToolCalls` 下为 `"."`）。非视觉模型通过 `partitionVisionContent` 获得图像占位符。

### OpenAI Responses（`providers/openai-responses.ts`）

- **Schema**：`sanitizeSchemaForOpenAIResponses` + `adaptSchemaForStrict`。支持 function 工具、自由格式的 **custom 工具**以及原生 **computer 工具**（`model.supportsComputerUse`）。线上格式：扁平的 `{ type: "function", name, description, parameters, strict? }`。
- **流式传输**：`response.output_item.added` → `response.function_call_arguments.delta` / `response.custom_tool_call_input.delta` → `response.output_item.done`。工具调用 id 是组合形式 `callId|itemId`（`normalizeResponsesToolCallId`）。
- **结果**：`function_call_output` 与 `custom_tool_call_output` item 通过 `call_id`（组合 id 的 `callId` 半部分）与调用配对。其 `output` 可以是字符串，也可以是规范的 `input_text` 和 `input_image` 块数组。具备视觉能力的模型将工具结果图像保留在该数组内部，而非创建合成的用户消息；不支持图像输入的模型接收文本占位符。鉴权网关解析同样接受遗留的 `output_text`、`text` 与 `refusal` 块，将内联 data 图像 URL 解码为图像内容，并保留远程图像 URL 或 OpenAI 图像文件 ID 作为引用。文件 ID 要求上游兼容 Responses，因为其他 provider 传输无法解析它们。`input_file` 在请求消息中仍受支持但…

### Google Gemini / Vertex（`providers/google-shared.ts`、`google.ts`）

- **Schema**：函数包裹在 `{ functionDeclarations }` 内。Gemini API/Vertex 使用 `parametersJsonSchema: normalizeSchemaForGoogle(...)`（剥离 `$schema`、`additionalProperties`，将类型数组转换为 nullable）；Cloud Code Assist / Antigravity / Gemini CLI 使用 `parameters: normalizeSchemaForCCA(...)`。
- **流式传输**：`part.functionCall` 携带 `name` 与完整的 `args` **对象**（无参数片段流式传输）。Google 省略 call id → 通过 `nextToolCallId(name)` 合成。
- **Vertex 怪癖**：Vertex `GenerateContent` **拒绝** `functionCall`/`functionResponse` 部分上的 `id`；当 `model.provider === "google-vertex"` 时它们会被删除。
- **结果**：带有 `functionResponse` 部分的 `user` 消息。所有并行的响应必须合并到**一个连续的** `user` 消息中，否则 Google 会报 "number of function response parts is not equal to number of function call parts"。图像：Gemini 3+ 支持多模态 `functionResponse.parts`；更早的 Gemini 将图像缓冲（`pendingToolImageParts`）并在响应之后作为单独的用户轮次刷新。

### Amazon Bedrock（`providers/amazon-bedrock.ts`）

- **Schema**：`convertToolSpec` → `{ toolSpec: { name, description, inputSchema: { json } } }`。
- **流式传输**：`start.toolUse`（`toolUseId`、`name`），然后 `delta.toolUse.input` 片段。
- **结果**：所有连续的工具结果分组到一个包含 `toolResult` 数组的 `user` 消息中（Converse API 要求）；图像嵌入 `content` 数组。
- **哨兵怪癖**：Converse 验证任何历史中包含 `toolUse`/`toolResult` 的请求都必须提供 `toolConfig`。在无活动工具（或 `toolChoice: "none"`）的情况下，`planToolConfig` 注入 `NO_TOOLS_SENTINEL`（`__no_tools__`，"do not call" 描述）并附带 `toolChoice: { auto: {} }`；对哨兵的调用会从流中丢弃（`sentinelInjected` 检查）。

### 差异总结

| | Anthropic | OpenAI Completions | OpenAI Responses | Google | Bedrock |
| --- | --- | --- | --- | --- | --- |
| Schema 规范化器 | 严格白名单 + 预算 | `adaptSchemaForStrict` | `sanitizeSchemaForOpenAIResponses` | `normalizeSchemaForGoogle` / CCA | 原始 JSON schema |
| 参数流式 | JSON 字符串片段 | JSON 字符串片段（MiniMax：对象） | JSON 字符串片段 | 完整对象，无片段 | JSON 字符串片段 |
| Call id | 原生 | 原生（外加 Mistral 9 字符、OpenAI 40 字符规则） | 组合 `callId\|itemId` | 合成；Vertex 剥离 | 原生 |
| 结果编码 | `user` + `tool_result` 块 | `role: "tool"` 消息 | function/custom output item | `user` + `functionResponse` 部分，单一消息 | `user` + 分组的 `toolResult` 数组 |
| 结果中的图像 | 嵌入；错误时提升 | 占位符分区 | 位于 output 数组内；无图像输入时占位符 | Gemini 3+ 嵌入，否则为尾部用户轮次 | 嵌入 |
| 并行调用 | 原生 | 原生 | 原生 | 原生 | 原生 |

### 严格工具生命周期

`OpenAIStrictToolsState`（`providers/openai-shared.ts`）按作用域 `${provider}:${baseUrl}:${modelId}` 跟踪严格模式失败：一次 400 严格 schema 拒绝会调用 `disableStrictToolsForScope`，而 `isStrictToolsDisabledForScope` 使该作用域之后的所有请求以非严格模式运行 —— 一次重试，然后记住，不再每轮 400 税。Anthropic 拥有类似的每会话 `strictToolsDisabled` 标志。

### 基于文本的工具调用方言（`src/dialect/`）

在原生工具 API 不可用时，或当历史必须为不同的模型家族重新编码时使用：

1. **带内工具调用**：`renderInbandToolPrompt(tools, dialect)` 将工具清单注入到提示中；`InbandScanner` / `wrapInbandToolStream` 将流式文本解析回结构化工具调用。方言：`harmony`、`gemini`、`qwen3`、`deepseek`、`kimi`、`glm`、`gemma`、`hermes`、`minimax`、`xml`、`anthropic`。
2. **跨模型历史重放**：在会话中途切换模型时，按目标的 `preferredDialect(modelId)` 重新渲染先前的思考/工具轮次（`renderDemotedThinking`、`encodeInbandToolHistory`）。
3. **Harmony**（`dialect/harmony.ts`）：GPT-5/Codex 控制 token（`<|start|>`、`<|call|>`、`<|channel|>`、`<|return|>`）；在通过非 Harmony 端点重放时，`utils/harmony-leak.ts` 对其进行转义。
4. **修复**：`StreamMarkupHealing`（`utils/stream-markup-healing.ts`）使用相同的扫描器，从托管模型泄露到可见文本中的标记重构工具调用和思考。

### 边界防护

- **`utils/tool-call-loop-guard.ts`**：`ToolCallLoopGuard` 对参数规范化（排序键、剥离 `intent`），对 `${name}:${canonicalArgs}` 哈希，在重复的相同调用上返回 `RepeatedToolCallDetection` 用于将模型引导出循环。
- **`utils/deterministic-id.ts`**：`deterministicUuid(seed)`（SHA-256 → UUID 形态）在 provider 省略或扰乱线上 id 时为 `ensureToolCallId` 提供支持（Google、Bedrock、退化的 completions）。
- **`providers/transform-messages.ts`**：在 provider 特定转换之前的共享预检过程 —— 工具调用去重、清理、id 规范化。

## 4. 强制工具选择

### 统一的 `ToolChoice`（`src/types.ts`）

```ts
type ToolChoice =
  | "auto" | "none" | "any" | "required"
  | { type: "function"; name: string }
  | { type: "function"; function: { name: string } }
  | { type: "tool"; name: string }
  | { type: "computer" };
```

- `auto` — 模型自行决定（默认当存在工具时）
- `none` — 本轮不进行工具调用
- `required` / `any` — 至少一次工具调用（OpenAI 与 Anthropic 的拼写差异；可互换）
- 命名 pin — 仅调用此工具
- `{ type: "computer" }` — 派发到原生 computer-use 工具

在 `packages/ai` 中，`toolChoice` 是**每个请求一次性**的 —— 无粘性；调用方决定每一轮。

### 映射工具函数（`src/utils/tool-choice.ts`）

| 导出 | 语义 |
| --- | --- |
| `isForcedToolChoice(choice)` | 对于 `undefined`/`"auto"`/`"none"` 之外的任何值（即 `required`、`any` 以及所有 pin）为 `true`。在 provider 必须对强制作出反应的任何地方使用 |
| `mapToOpenAICompletionsToolChoice` | → `"auto" \| "none" \| "required" \| { type: "function", function: { name } }`（`any` → `required`，嵌套的 name 形态） |
| `mapToOpenAIResponsesToolChoice` | → 同样的字符串加上**扁平**的 `{ type: "function", name }`、`{ type: "custom", name }`、`{ type: "computer" }` 透传 |
| `mapToAnthropicToolChoice` | → `"auto" \| "none" \| "any" \| { type: "tool", name }`（`required` → `any`） |

### 各 provider 的线上映射

| Provider | 线上字段 | 取值 | 降级/防护 |
| --- | --- | --- | --- |
| OpenAI Completions | `tool_choice` | 字符串 + 嵌套 function 对象 | `!supportsNamedToolChoice` → 过滤工具 + `"required"`；`!supportsForcedToolChoice` → `"auto"`；强制的工具不在 `tools` 中 → 删除 `tool_choice`；`"none"` 且无工具 → 丢弃（LiteLLM/Bedrock 代理会返回 400） |
| OpenAI Responses | `tool_choice` | 字符串 + 扁平的 function/custom/computer 对象 | 同样的命名/强制降级；选择针对**幸存的 schema 隔离**工具进行验证 —— 在已丢弃工具上的 pin 会被删除；模型无原生 computer use 时的 `{ type: "computer" }` 被重映射到 function 工具名称（同样适用于 `azure-openai-responses.ts`） |
| Anthropic | `tool_choice` | `{ type: "auto" \| "none" \| "any" \| "tool", name? }` | 名称通过 `encodeAnthropicToolName`；`!supportsForcedToolChoice`（Fable/Mythos） → `auto` |
| Google Gemini/Vertex | `toolConfig.functionCallingConfig` | `mode: AUTO \| NONE \| ANY`（pin 时 + `allowedFunctionNames`） | Antigravity/Gemini CLI 使用 `mode: VALIDATED` 默认（`google-gemini-cli.ts`） |
| Bedrock | `toolConfig.toolChoice` | `{ auto: {} } \| { any: {} } \| { tool: { name } }` | `planToolConfig`；`"none"` + 工具历史 + 无工具 → `NO_TOOLS_SENTINEL` 配合 `{ auto: {} }` |
| Ollama | `tool_choice` | 仅 `"none"` / `"required"` | Pin 通过 `selectToolsForToolChoice` 模拟：过滤工具至目标，发送 `"required"` |

### 模拟与回退路径

1. **仅支持字符串的 host**（`supportsNamedToolChoice: false` —— LM Studio、llama.cpp、Ollama）：对象 pin 会被 host 拒绝，因此 provider 仅**展示被 pin 的工具**并发送 `tool_choice: "required"` —— 在仅提供一个工具时，`required` 等同于 pin。
2. **Bedrock 哨兵**：参见[§3](#amazon-bedrock-providersamazon-bedrockts)。
3. **Computer pin 回退**：无原生支持时的 `{ type: "computer" }` 降级为命名 function pin。
4. **陈旧 pin 剪枝**：在最终工具列表中缺失的强制工具（活动工具过滤、schema 隔离）会静默丢弃 `tool_choice` 而非发出无效请求。

### 与推理的交互

若干后端会同时拒绝思考 + 强制工具选择：

- **Anthropic**：`disableThinkingIfToolChoiceForced` 删除 `params.thinking`；仅自适应模型将 `output_config.effort = "low"` 钉住，以免默认的自适应思考再次生效。
- **Bedrock**：强制的 `any`/`tool` 清空 `additionalModelRequestFields`（思考配置所在之处）。
- **OpenAI 兼容**：`resolveOpenAICompatPolicy` 遵守 `disableReasoningOnForcedToolChoice` / `disableReasoningOnToolChoice`。例外：Kimi K3 在强制的 `"required"` 下保留推理强度（`openai-completions.ts` 中的 `hasActiveNativeKimiK3Reasoning`）。

### Agent 循环如何驱动它（`packages/agent`）

- **每轮解析**：`agent-loop.ts` 在每轮开始时解析 `config.getToolChoice()`：
  ```ts
  const effectiveToolChoice = ownedDialect ? undefined : (hostToolChoice ?? forcedToolChoice ?? config.toolChoice);
  ```
  当活动的 owned 带内方言激活时，原生工具会被剥离，因此 `tool_choice` 必须为 `undefined`（无原生 `tools` 时的原生 `tool_choice` 会返回 400）。
- **软要求**（`SoftToolRequirement`，`packages/agent/src/types.ts`）：每轮强制 `tool_choice` 会搅动 provider prompt cache。软要求（`{ soft: true, toolName, reminder }`）首先以 `toolChoice` 保持 auto 注入提醒文本；只有当模型未能调用 `toolName` 时，下一轮才会升级为单个轮次的硬性 `{ type: "tool", name }`。
- **活动工具刷新**：`refreshToolChoiceForActiveTools`（`packages/agent/src/agent.ts`）丢弃工具不再位于活动集合中的已排队强制选择。
- **压缩/交接**：以 `toolChoice: "none"` 运行以保持 prompt-cache 前缀同时强制仅文本输出；仅 auto 的 400 获得一次 `"auto"` 的重试（`packages/agent/src/compaction/compaction.ts`）。
