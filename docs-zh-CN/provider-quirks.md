# Provider quirks：特殊情况、流、认证与目录处理

针对 `packages/ai` 各传输的逐 provider 深入解析：每个 provider 在共享管线之外还特殊处理哪些内容、
它的流与普通 SSE/delta 模型有何差异、它如何认证并追踪使用量/配额，
以及 `packages/catalog` 针对其模型有哪些特殊做法
(描述符、发现、身份、思考元数据、定价)。

相关参考：

- [Provider 兼容参考](./provider-compat-reference.md) — 兼容标志、推理等级、工具处理、强制工具选择
- [Provider 端点约束](./provider-endpoint-constraints.md) — 新增约束应放在哪里
- [Provider 流式传输内部机制](./provider-streaming-internals.md) — stream 事件归一化
- [Providers](./providers.md) — 可用性、凭据、登录流程


## OpenAI Chat Completions
OpenAI Chat Completions provider 针对标准 OpenAI `/chat/completions` wire 协议(`ChatCompletionCreateParamsStreaming` 请求 schema 和 `ChatCompletionChunk` 事件负载)实现基于 Server-Sent Events (SSE) 的 HTTP POST JSON body 流式传输。它作为主要的主力传输，服务于 OpenAI 模型以及数十个 OpenAI 兼容网关和第三方 provider，包括 Groq、Cerebras、Mistral、DeepSeek、Fireworks、Zhipu (Z.AI)、Qwen (DashScope)、Kimi (Moonshot)、Synthetic、GitLab Duo、OpenRouter、Vercel AI Gateway、CoreWeave、HuggingFace、Nvidia NIM、Novita、GMI Cloud、Baseten、NanoGPT 和 Sakana/Fugu。该传输实现在 `packages/ai/src/providers/openai-completions.ts`(主流式运行器 `streamOpenAICompletions`)、`packages/ai/src/providers/openai-chat-wire.ts`(内置的 wire 类型)、`packages/ai/src/providers/openai-shared.ts`(共享的请求/策略/用量辅助函数)、`packages/ai/src/providers/openai-reasoning-fallback.ts`(400 reasoning-effort 恢复)、`packages/ai/src/utils/openai-http.ts`(HTTP SSE 客户端 `postOpenAIStream`)和 `packages/ai/src/utils/empty-completion-retry.ts`(`withReplaySafeStreamRetry` 包装器)中。

### 特殊情况
- **Azure 部署名称映射**:`packages/ai/src/providers/openai-shared.ts` 中的 `parseAzureDeploymentNameMap` 在 `createRequestSetup`(`packages/ai/src/providers/openai-completions.ts`)中解析 `AZURE_OPENAI_DEPLOYMENT_NAME_MAP` 环境变量(逗号分隔的 `modelId:deploymentName` 对)，以将模型 ID 转换为 Azure 部署名称，未映射时默认为 `model.id`。
- **网关路由与变体转换**:`packages/ai/src/providers/openai-shared.ts` 中的 `applyOpenAIGatewayRouting` 注入 OpenRouter provider 路由偏好(`params.provider`)。`applyOpenRouterRoutingVariant` 和 `applyWireModelIdTransform` 追加 OpenRouter 模型变体后缀(`:nitro`、`:floor`、`:online`、`:extended`)。`resolveSakanaRequestBaseUrl` 处理 Sakana/Fugu base URL 覆盖(`SAKANA_BASE_URL` / `FUGU_BASE_URL`),`applyCoreWeaveProjectHeader` 注入 CoreWeave 项目头。
- **空补全重试**:`streamOpenAICompletions` 由 `withReplaySafeStreamRetry`(`packages/ai/src/utils/empty-completion-retry.ts`)包装：如果某次尝试以 `finish_reason: "stop"` 干净结束，但未发出任何可见的助手内容(`hasVisibleAssistantContent` 检查文本、思考、图像或工具调用)且输出 token <= 1，则最多重试 `MAX_EMPTY_COMPLETION_RETRIES` 次(2 次重试，指数退避 `EMPTY_COMPLETION_BASE_DELAY_MS` = 500ms)。该包装器缓冲输出前的事件，因此被丢弃的尝试绝不会被重放；此外(在 `retryProviderErrors: true`、`maxProviderErrorRetries: 1` 时)还会在提交任何输出之前重试瞬态 provider 错误。
- **Reasoning-Effort 400 回退**:`resolveOpenAIReasoningEffortFallback` 和 `applyOpenAIReasoningEffortFallback`(`packages/ai/src/providers/openai-reasoning-fallback.ts`)拦截由不受支持的 `reasoning_effort` 值引起的 400/422 HTTP 错误响应。它从错误消息中解析允许的等级(或解析出最接近的受支持等级/null)，在 provider 会话状态(`getOpenAICompletionsProviderSessionState`)中按端点/模型键(`createOpenAIReasoningEffortFallbackKey`、`rememberOpenAIReasoningEffortFallback`)记住回退结果，并透明地重试请求而不使该轮次失败。
- **完成原因提升**：在 `streamOpenAICompletionsOnce`(`packages/ai/src/providers/openai-completions.ts`)中，如果后端报告 `finish_reason: "stop"`，但该轮次产生了结构化 `toolCall` 块，或通过 `StreamMarkupHealing` 修复了工具调用，则 `output.stopReason` 会从 `"stop"` 提升为 `"toolUse"`，以便 agent 执行循环正确地调用工具处理程序。
- **Mistral 工具 ID 归一化**:`packages/ai/src/providers/openai-completions.ts` 中的 `normalizeMistralToolId` 将 Mistral 模型的工具调用 ID 限制为恰好 9 个字母数字字符(用确定性字符 `"ABCDEFGHI"` 填充或截断)。
- **MiniMax 对象参数深度合并**:`packages/ai/src/providers/openai-completions.ts` 中的 `mergeStreamingArgumentObjects` 处理 MiniMax 兼容后端：它们把 `function.arguments` 作为 JSON 对象而非字符串流式传输，该函数跨 stream chunk 递归合并部分对象 delta。
- **DeepSeek Chat 模板与特殊 token 剥离**:`packages/ai/src/providers/openai-completions.ts` 中的 `stripDeepseekSpecialTokens` 和 `getTrailingPartialDeepseekToken` 缓冲并剥离 DeepSeek 端点(例如 NVIDIA NIM、DeepSeek 原生 API)上泄漏进 `delta.content` 中的原始 `<｜...｜>` / `<|...|>` chat 模板标记。
- **方言与 provider 特定怪癖**:`packages/ai/src/providers/openai-shared.ts` 中的 `isZaiReasoningEffortDialect` 处理 GLM-5.2 的 `zai` 思考格式。`dropOpenRouterKimiForcedToolReasoning`、`hasActiveNativeKimiK3Reasoning` 和 `normalizeSchemaForMoonshot` 管理 Kimi (Moonshot) K3 的工具 schema 与推理模式。`applyOpenAIChatCompletionsPromptCachePolicy` 注入 prompt 缓存断点(`cache_control: { type: "ephemeral" }` 或 `normalizeOpenAIPromptCacheKey` 的 64 字符 `pc_` 前缀)。

### 流行为
- **SSE Delta 解码与归一化**:`postOpenAIStream`(`packages/ai/src/utils/openai-http.ts`)使用 `readSseJson` 将原始 SSE `data:` 负载解码为 `ChatCompletionChunk` 对象。`normalizeStreamingContentText`(`packages/ai/src/providers/openai-completions.ts`)将 `delta.content` 归一化，无论其以字符串还是内容部分数组(`[{ type: "text", text: "..." }]`，例如 Mistral Medium 3.5)形式到达，从而避免 `[object Object]` 字符串强制转换。
- **推理字段与加密签名**:`streamOpenAICompletionsOnce` 检查 `delta.reasoning_content`(llama.cpp/vLLM)、`delta.reasoning` 和 `delta.reasoning_text`，每个 chunk 取第一个非空字段，以避免重复的推理文本。`delta.reasoning_details`(`reasoning.encrypted`)中的加密推理签名会附加到对应的 `toolCall.thoughtSignature`。
- **部分 JSON 节流**:`parseStreamingJsonThrottled`(来自 `@oh-my-pi/pi-utils`)对 `streamOpenAICompletionsOnce` 中工具参数流式传输期间的增量 JSON 解析进行节流，以避免高 CPU 开销。
- **流标记修复**：当配置了 `policy.stream.markupHealingPattern` 时，`StreamMarkupHealing`(`packages/ai/src/utils/stream-markup-healing.ts`)会被启用。它检查流式文本中 XML/markdown 包裹的工具调用(例如 DSML 泄漏)，解析已完成的工具调用，发出 `toolcall_start`/`toolcall_delta`/`toolcall_end` 事件，并将 `stop` 完成原因提升为 `toolUse`。
- **降级思考与累积推理**:`renderDemotedThinking`(`packages/ai/src/dialect/demotion.ts`)处理被降级的思考块(`isDemotedThinking`)。`lastCumulativeReasoningBySignature` 跨文本块转换追踪累积推理流(例如 MiniMax-M3)，以防止在可见文本开始后将思考文本作为重复块再次发出。
- **看门狗与终端宽限窗口**:`iterateWithIdleTimeout`(`packages/ai/src/utils/idle-iterator.ts`)使用 `getOpenAIStreamFirstEventTimeoutMs` 和 `getOpenAIStreamIdleTimeoutMs` 监控流活动，并向下游注入 `X-Stainless-Timeout` 头。流结束时，`iterateWithTerminalGrace` 强制执行 2,500ms 的结束之后宽限窗口(`OPENAI_COMPLETIONS_POST_FINISH_GRACE_MS`)，允许携带缓存读取 token 明细(`awaitTrailingUsageDetails`)的尾部仅用量 chunk(`stream_options.include_usage`)在流关闭前到达。
- **用量 chunk 解析**:`packages/ai/src/providers/openai-completions.ts` 中的 `parseChunkUsage` 和 `applyUsagePayload` 处理来自 `chunk.usage` 或 `choice.usage` 的 token 用量。提取的字段包括 `prompt_tokens_details.cached_tokens`、`prompt_cache_hit_tokens`、`prompt_cache_miss_tokens`、`completion_tokens_details.reasoning_tokens`、`cache_write_tokens`，以及通过 `applyProviderReportedCost`(`packages/ai/src/providers/openai-shared.ts`)报告的 provider 成本。

### 认证与使用
- **API key 校验**:`packages/ai/src/registry/api-key-validation.ts` 中的 `validateOpenAICompatibleApiKey` 通过发出一个轻量级 `POST /chat/completions` 请求来校验 API 凭据，请求包含 `messages: [{ role: "user", content: "ping" }]`、`max_tokens: 1`、`temperature: 0` 和 `Authorization: Bearer ${apiKey}`。
- **凭据解析与环境变量**:`packages/ai/src/stream.ts` 中的 `getEnvApiKey` 为 OpenAI 兼容 provider 解析 provider 特定的环境变量：`OPENAI_API_KEY`、`GROQ_API_KEY`、`CEREBRAS_API_KEY`、`MISTRAL_API_KEY`、`DEEPSEEK_API_KEY`、`FIREWORKS_API_KEY`、`OPENROUTER_API_KEY`、`TOGETHER_API_KEY`、`SAMBANOVA_API_KEY`、`NEBIUS_API_KEY`、`NOVITA_API_KEY`、`AVALAI_API_KEY`、`CHUTES_API_KEY`、`NANOGPT_API_KEY`、`HYPERBOLIC_API_KEY`、`PERPLEXITY_API_KEY`、`XAI_API_KEY` 和 `AZURE_OPENAI_API_KEY`。
- **用量核算与配额呈现**:`calculateOpenAIUsageAccounting`(`packages/ai/src/providers/openai-shared.ts`)将输入、输出、缓存读取和缓存写入 token 协调为标准的 `Usage` 记录。OpenRouter 和 ClinePass 的权威网关费用通过 `applyProviderReportedCost` 填充到 `output.usage.cost`。Copilot 请求计数存储在 `output.usage.premiumRequests`。传输层 HTTP 错误(例如 429 Rate Limit、408 Timeout、5xx Server Error)会作为 `OpenAIHttpError`(`packages/ai/src/utils/openai-http.ts`)抛出，捕获状态码、头和错误信封明细，以供 `AIError.finalize` 中的上游错误映射使用。

### 目录模型处理
- **Provider 描述符**:`packages/catalog/src/provider-models/descriptors.ts` 中的 `CATALOG_PROVIDERS` 注册所有使用此传输的 catalog 条目(例如 `openai`、`groq`、`cerebras`、`mistral`、`deepseek`、`fireworks`、`openrouter`)，指定 `api: "openai-completions"`、`defaultModel`、环境变量键和文档 URL。
- **模型解析器与管理器**:`packages/catalog/src/provider-models/openai-compat.ts` 中的 `createOpenAICompatibleModelManagerOptions` 为 `openai-completions` provider 构造模型管理器。它组合静态/精选模型定义、捆绑参考规范(`getBundledModels`)以及从远程 catalog 端点获取的实时模型。
- **Catalog 发现**:`packages/catalog/src/discovery/openai-compatible.ts` 中的 `fetchOpenAICompatibleModels` 查询 provider 的 `/models` 端点。它安全地解析各种信封(`data`、`models`、`result`、`items`)，使用 `withOpenAICompatibleDiscoveryTimeout` 强制请求超时，校验模型记录 schema(`openAICompatibleModelRecordSchema`)，应用自定义映射器/过滤器，并按 ID 去重模型。
- **身份与分类**:`packages/catalog/src/identity/classify.ts` 中的 `parseKnownModel` 和 `parseOpenAIModel` 为匹配 `gpt-(\d+(?:\.\d+){0,2})(?:-(...))?` 的 OpenAI 模型提取模型家族、变体(`base`、`codex`、`mini`、`max`、`nano`)和 SemVer 版本(`parseSemVer`)。版本比较工具(`semverGte`、`semverEqual`)驱动跨 GPT-4、GPT-4o 和 GPT-5 家族的能力检测。
- **思考元数据与 effort 梯级**:`packages/catalog/src/model-thinking.ts` 中的 `resolveModelThinking` 和 `deriveThinking` 构造思考元数据(`ThinkingConfig`)，并将模型身份/兼容设置映射到 effort 梯级：
  - `DEFAULT_REASONING_EFFORTS`:`[minimal, low, medium, high]`
  - `DEFAULT_REASONING_EFFORTS_WITH_XHIGH`:`[minimal, low, medium, high, xhigh]`(例如 OpenRouter GLM-5.2)
  - `GPT_5_2_PLUS_EFFORTS`:`[low, medium, high, xhigh]`
  - `FIVE_TIER_EFFORTS_LOW_TO_MAX`:`[low, medium, high, xhigh, max]`(GPT-5.6+ wire effort 模型、Fire Pass Kimi 路由器)
  - `LOW_HIGH_MAX_REASONING_EFFORTS`:`[low, high, max]`(Kimi K3、DeepSeek V4 Flash)
  - `HIGH_MAX_REASONING_EFFORTS`:`[high, max]`(Z.ai/Umans/Baseten 上的 GLM-5.2、DeepSeek V4 Pro)
  - `HIGH_ONLY_REASONING_EFFORTS`:`[high]`(OpenRouter DeepSeek)
  - `OLLAMA_REASONING_EFFORTS`:`[low, medium, high, max]`(Ollama 端点)

## OpenAI Responses
OpenAI Responses provider(`packages/ai/src/providers/openai-responses.ts`)处理 OpenAI 有状态的 `/v1/responses` HTTP Server-Sent Events (SSE) 流式传输 wire 协议(类型定义在 `openai-responses-wire.ts` 中，共享的编码与解码逻辑在 `openai-shared.ts` 中)。与 chat completions 不同,Responses API 作用于结构化项序列(`ResponseInput`)，其中包含类型化的输入/输出项(`input_text`、`input_image`、`input_file`、`message`、`function_call`、`custom_tool_call`、`computer_call`、`reasoning`)，支持通过 `previous_response_id` 进行服务端上下文链接、显式 prompt 缓存断点，以及原生推理摘要和加密内容块。

### 特殊情况
- **Responses 输入项模型 vs chat 消息**:`openai-shared.ts` 中的 `buildResponsesInput` 将标准对话上下文转换为 `ResponseInput` 数组(`ResponseInputItem[]`)。系统指令默认使用顶层 `instructions`，当 `policy.messages.systemRole === "developer"` 时使用 developer 角色项(`{ role: "developer" }`)(推理模型所必需)。重放历史根据 `filterReasoningHistory` 剥离或保留推理项，而 Harmony 方言模型(GPT-5+)通过 `escapeReplayedControlTokens` 转义重放传输数据中保留的控制 token 拼写。
- **`previous_response_id` 链接与陈旧链重置**:`openai-responses.ts` 中的 `buildOpenAIResponsesChainedParams` 管理有状态轮次。当 `statefulResponses` 处于活动状态时(对官方 OpenAI 端点默认开启，通过 `PI_OPENAI_STATEFUL` 标志和 `hostMatchesUrl` 判定)，请求强制 `store: true`，并计算锚定到 `previous_response_id` 的 delta 负载(`buildResponsesDeltaInput`)。如果历史发生变化、选项改变或 prompt 缓存断点策略变动，链会重置为完整重放(`resetOpenAIResponsesChainState`)。如果端点返回陈旧 ID 错误(`isOpenAIResponsesStalePreviousResponseError`),provider 会递增 `staleFailures` 并回退到完整转录重放；在连续失败 `OPENAI_RESPONSES_CHAIN_STALE_FAILURE_LIMIT`(3)次之后，该会话禁用链接。零数据保留(ZDR)组织错误(`markOpenAIResponsesChainZeroDataRetention`)会立即禁用该会话的链接并强制 `store: false`。
- **加密推理项与摘要**：通过 `policy.reasoning.includeEncryptedReasoning` 支持 `include: ["reasoning.encrypted_content"]`。`ResponseReasoningItem` 对象包含加密内容负载、推理文本 delta(`response.reasoning_text.delta`)和摘要文本 delta(`response.reasoning_summary_text.delta`)。携带序列化 JSON 的思考签名通过 `parseResponseReasoningReplayItem` 解析，并在 `filterReasoningHistory` 为 false 时作为原生 `reasoning` 项重放。
- **复合 `callId|itemId` 工具 ID**:`packages/ai/src/utils.ts` 中的 `normalizeResponsesToolCallId` 负责工具调用 ID 归一化。Responses 中的工具调用标识符是格式为 `${callId}|${itemId}` 的复合字符串。该函数按 `|` 拆分传入 ID，得到不同的 `callId`(截断为 64 字符并加 `call_` 前缀)和 `itemId`(加 `fc_` 或 `ctc_` 前缀)。传入未合成的 ID 时，它会生成基于哈希的一对 ID(`call_<hash>` 和 `fc_<hash>` / `ctc_<hash>`)。转换后的消息使用 `normalizeResponsesToolCallIdForTransform` 来保持工具调用与工具结果消息之间的对齐。
- **自定义(freeform)工具与计算机工具**:`convertTools` 中的工具转换处理 function、custom 和 computer 工具。当 `model.applyPatchToolType === "freeform"`(通过 `supportsFreeformApplyPatch` 检查)时，自定义格式工具(如 `apply_patch`)被编码为带语法定义的 `type: "custom"`(`compactGrammarDefinition`)。当 `model.supportsComputerUse === true` 时，原生计算机工具(`type: "computer"`)使用结构化的 `ComputerAction` 列表发出 `computer_call` 和 `computer_call_output` 项；不支持原生计算机的模型回退为普通 function 工具。工具 schema 通过 `sanitizeSchemaForOpenAIResponses` 和 `adaptSchemaForStrict` 净化，违反严格约束的 schema 会被隔离(`findStrictToolSchemaViolation`)，以防无效的 MCP schema 使整个请求失败。
- **服务层级与混淆退出**:`serviceTier` 选项会向下传递到采样参数，并通过 `processResponsesStream` 在输出用量中报告。当 `model.compat.supportsObfuscationOptOut` 为 true 时，采样参数包含 `stream_options: { include_obfuscation: false }`。
- **图像 detail 处理**:`convertResponsesInputContent` 和 `appendResponsesToolResultMessages` 中的图像内容转换尊重 `model.compat.supportsImageDetailOriginal`。当其为 false 时，`"original"` 图像 detail 值会被映射为 `"auto"` 以避免上游拒绝。[provider 兼容性参考](./provider-compat-reference.md) 拥有多模态工具结果编码契约。

### 流行为
- **流事件协议(`response.*` 生命周期)**:`openai-shared.ts` 中的 `processResponsesStream` 处理 `/v1/responses` 发出的 SSE 事件。处理的生命周期事件包括 `response.created`、`response.output_item.added`、`response.output_text.delta`、`response.reasoning_text.delta`、`response.reasoning_summary_text.delta`、`response.function_call_arguments.delta`、`response.custom_tool_call_input.delta`、`response.output_item.done`、`response.completed` 和 `response.done`。交错的并行工具调用跨 `output_index`、`item_id` 和带前缀的调用 ID 查找映射(`openItemsByOutputIndex`、`openItemsByItemId`、`openItemsByPrefixedCallId`)并发追踪。
- **看门狗与瞬态重试**:`streamOpenAIResponsesOnce` 使用 `iterateWithIdleTimeout` 并设置两个超时阈值：`streamFirstEventTimeoutMs`(带有 `X-Stainless-Timeout` 请求头)用于初始响应头/事件，`streamIdleTimeoutMs` 用于事件间停顿。如果流在发出重放不安全输出(`isOpenAIResponsesReplayUnsafeEvent`)之前提前终止，单次尝试的 streamer 会在延迟(`OPENAI_RESPONSES_TRANSIENT_STREAM_RETRY_DELAY_MS = 500ms`)之后执行瞬态重试(`OPENAI_RESPONSES_MAX_TRANSIENT_STREAM_RETRIES = 1`)。公开的 `streamOpenAIResponses` 用 `withReplaySafeStreamRetry` 包装执行，以重试空补全。

### 认证与使用
- 标准 OpenAI 认证依赖通过 `getEnvApiKey` 和 `openai-shared.ts` 中的 `resolveOpenAIRequestSetup` 解析的 `OPENAI_API_KEY`(或 provider 特定环境变量)。请求传递标准 Bearer token 授权头(`Authorization: Bearer <key>`)以及可选的 Stainless/Copilot 头。*(注意：`openai-codex` / ChatGPT 订阅计划 OAuth 认证单独处理)。*

### 目录模型处理
- **`gpt-5+` 身份分类**:`gpt-5` 家族中的模型通过 `packages/catalog/src/identity/family.ts` 中的 `isOpenAIWireGen5Plus` 和 `isOpenAIWireGen54Plus` 识别。`gpt-5+` 模型在各服务主机上都会以 HTTP 400 错误拒绝遗留采样参数(例如 `temperature`、`top_p`、`frequency_penalty`),`buildOpenAICompat` / `buildOpenAIResponsesCompat` 通过 `supportsReasoningParams` 处理这一点。
- **Prompt 缓存断点(`supportsOfficialOpenAIPromptCacheBreakpoints`)**：在 `packages/catalog/src/compat/openai.ts` 中求值。对于为版本 >= 5.6 的模型提供服务的官方 OpenAI 端点，`supportsOfficialOpenAIPromptCacheBreakpoints` 返回 true。启用且 `promptCache.mode === "explicit"` 时，`openai-responses.ts` 中的 `markLatestStableResponsesCacheBreakpoint` 将 `{ mode: "explicit" }` 的 `prompt_cache_breakpoint` 注解注入到最新的稳定 developer/user 消息块上，同时保留有状态基线断点。
- **推理摘要配置与 effort 梯级**:`buildParams` 通过 `applyResponsesCompatPolicy` 应用推理参数。Effort 参数通过模型特定的映射(`reasoningEffortMap` 或 `thinking.effortMap`)映射。对于 `gpt-5.6+` 模型和 5 级 effort 标度(包括 `xhigh` 和 `max`),`model-thinking.ts` 配置 effort 梯级(`minimal`、`low`、`medium`、`high`、`xhigh`、`max`)，将 `xhigh` 和 `max` 按 1:1 映射或按主机方言移位(例如 `KIMI_K3_REASONING_EFFORT_MAP`、`MIMO_REASONING_EFFORT_MAP`)。生成的 pro 别名(`gpt-5.6-*-pro`)会自动附加 `reasoningMode: "pro"`。

## OpenAI Codex
OpenAI Codex provider 通过 SSE 或 WebSocket 传输，在 OpenAI Responses API 表面上集成 ChatGPT Plus/Pro 订阅模型。请求以 ChatGPT OAuth token 并带账户级隔离，面向 ChatGPT 后端(`https://chatgpt.com/backend-api/codex/responses` 或自定义 base URL)。入口模块包括 `packages/ai/src/providers/openai-codex-responses.ts` 中的流式处理、`packages/ai/src/providers/openai-codex/request-transformer.ts` 中的请求转换、`packages/ai/src/providers/openai-codex/response-handler.ts` 中的错误与限流解析、`packages/ai/src/usage/openai-codex.ts` 中的配额与用量追踪、`packages/ai/src/usage/openai-codex-reset.ts` 中的重置管理、`packages/ai/src/usage/openai-codex-base-url.ts` 中的 base URL 归一化、`packages/catalog/src/compat/rules/auth/openai-codex.kdl` 中的认证策略，以及 `packages/ai/src/registry/oauth/openai-codex.ts` 中的 OAuth 处理。

### 特殊情况
- **WebSocket vs SSE 双传输**：通过 `packages/ai/src/providers/openai-codex-responses.ts` 中的 `CodexWebSocketConnection` 支持 WebSocket 流式传输(`v2StreamingEnabled: true`、头 `OpenAI-Beta: responses_websockets=2026-02-06`、`preferWebsockets` 选项)。以最大空闲复用上限(`CODEX_WEBSOCKET_MAX_IDLE_REUSE_MS` = 30s)复用 socket,ping/pong 心跳(10s 间隔、60s 超时)，队列容量(4096)。在连接/握手失败时立即回退到 SSE(`CODEX_WEBSOCKET_FATAL_PATTERNS`、`CodexWebSocketTransportError`)。
- **采样参数剥离**：采样参数(`temperature`、`top_p`、`top_k`、`min_p`、`presence_penalty`、`repetition_penalty`、`frequency_penalty`、`stop`)在 `packages/ai/src/providers/openai-codex/request-transformer.ts` 的 `transformRequestBody` 中被剥离；如果发送任何采样参数,Codex 后端会返回 HTTP 400 `Unsupported parameter`(#3117)。
- **Responses Lite 传输**：常规推理默认使用完整 Responses；调用方通过 `responsesLite` 请求选项或 `PI_CODEX_RESPONSES_LITE=1` 选择启用 Lite，而 provider 原生压缩则显式遵循 catalog 的 `useResponsesLite` 标志。函数 `applyCodexResponsesLiteShape` 将声明的工具嵌入到前导 `additional_tools` developer 项中，将系统指令嵌入到 developer 消息中，剥离图像 `detail`，关闭并行工具调用，强制 `reasoning.context: "all_turns"`，并附加 `x-openai-internal-codex-responses-lite: true` 头(或在 WS `client_metadata` 中附加 `ws_request_header_x_openai_internal_codex_responses_lite`)。当不存在匹配的已声明工具时，托管工具选择(`tool_choice`)回退为 `"auto"`(#5771)。
- **工具调用/输出配对修复**:`request-transformer.ts` 中的 `repairToolCallPairs` 将缺少前置调用的孤立 `function_call_output`/`custom_tool_call_output` 改写为助手消息(`[Previous tool result; call_id=...]`)，并为缺少输出的孤立调用注入合成输出(`[No tool output recorded...]`)，从而防止后端 HTTP 400 校验失败。
- **会话亲和性与头**：发出会话头，包括 `session_id`、`session-id`、`x-codex-installation-id`、`x-codex-window-id`、`x-codex-turn-metadata`(包含 `turn_id`、`installation_id`、`parent_turn_id`、`request_kind` 的 JSON)、`x-codex-parent-thread-id` 和 `x-openai-subagent`，它们定义在 `packages/catalog/src/wire/codex.ts` 和 `openai-codex-responses.ts` 中。
- **证明与压缩**：为 `x-oai-attestation` 头(`getCodexAttestationHeader`)查询进程级 DeviceCheck 证明钩子 `setCodexAttestationProvider`。当 `PI_CODEX_ZSTD` 处于活动状态时，对官方源使用 zstd 压缩请求体负载(`compressCodexRequestBody`)。
- **区域固定的工作区驻留**：企业 ChatGPT 工作区可以固定到某个数据驻留区域，并拒绝任何出口区域与之不同的 Codex 请求——HTTP 401 `Workspace is not authorized in this region.`——除非客户端自行声明该工作区驻留区域。Codex 请求构造器从 OAuth 访问 token 读取它(`packages/catalog/src/wire/codex.ts` 中的 `getCodexResidency`，声明 `chatgpt_data_residency`，并以 `chatgpt_compute_residency` 作为回退)，并在 chat SSE 与 WebSocket 传输、web 搜索、远程压缩和 `generate_image` 上发送 `x-openai-internal-codex-residency`。不带该声明的账户(个人 ChatGPT、并非 JWT 的不透明代理密钥)不发送任何头，而调用方提供的同名头绝不会被覆盖。
- **Harmony 控制 token 转义**：对运行在 Harmony 方言上的模型(`isHarmonyDialectModel`)，用 `escapeHarmonyControlTokens` 净化重放的输入文本。

### 流行为
- **事件协议**：解析 SSE JSON 负载或 WebSocket 帧(`response`、`sequence_number`、`type`)。触发进度事件(`isOpenAIResponsesProgressEvent`、`CODEX_ADDITIONAL_PROGRESS_EVENT_TYPES`，例如 `response.done` 和 `response.incomplete`)。
- **超时看门狗**：对首个事件强制 `CODEX_WEBSOCKET_FIRST_EVENT_TIMEOUT_MS`(300s)，对稳态流空闲上限强制 `CODEX_WEBSOCKET_IDLE_TIMEOUT_MS`(300s)，并对 SSE 流使用 `iterateWithIdleTimeout`。
- **陈旧历史恢复**：在 `previous_response_id` 陈旧错误(`CODEX_STALE_PREVIOUS_RESPONSE_CODES`)上，通过清除无效的链式响应指针并重试来重新流式传输/重放。
- **重试预算与限流**：对瞬态错误(`model_error`、`server_error`、`internal_error` 或 `CODEX_RETRYABLE_EVENT_MESSAGE`)最多重试 `CODEX_MAX_RETRIES`(5)次。在 5 分钟预算内(`CODEX_RATE_LIMIT_BUDGET_MS`)，按服务端重试延迟处理 HTTP 429 退避。
- **空白循环防御**：检测无限的空白工具调用参数 delta(`CODEX_WHITESPACE_TOOL_CALL_ARGUMENT_DELTA_EVENT_LIMIT` = 256,16KB 限制)，以 `CodexWhitespaceToolCallLoopError` 中断执行，并最多尝试 2 次重试(`CODEX_WHITESPACE_LOOP_RETRY_LIMIT`)。
- **并发推理摘要**：当请求推理摘要时(`supportsCodexReasoningSummary`)，请求体包含 `stream_options: { reasoning_summary_delivery: "sequential_cutoff" }`，从而支持在摘要完成之前流式输出文本。

### 认证与使用
- **OAuth 登录流程**：实现 `packages/catalog/src/compat/rules/auth/openai-codex.kdl` 中声明的 ChatGPT OAuth(`login "oauth-code"`，引擎 `packages/ai/src/registry/engine/oauth-code.ts`)以及 `openai-codex-device.kdl`，钩子在 `packages/ai/src/registry/oauth/openai-codex.ts` 中。浏览器流程使用 PKCE S256(`createOpenAICodexAuthorizationUrl`)，固定本地端口 1455(`http://localhost:1455/auth/callback`)，客户端 ID `app_EMoamEEZ73f0CkXaXp7hrann`，以及简化的 CLI 流程标志。无头设备码流程(`loginOpenAICodexDevice`)使用 `https://auth.openai.com/api/accounts/deviceauth/usercode` 并轮询 `deviceauth/token`。
- **Token 刷新与声明**:`refreshOpenAICodexToken` 向 `https://auth.openai.com/oauth/token` 提交 `grant_type: refresh_token`。从 JWT 声明中提取 `chatgpt_account_id` 和用户 `email`(`getTokenProfile` 中的 `https://api.openai.com/auth` 和 `https://api.openai.com/profile`)。
- **账户轮换与限流排名**：账户身份通过 `ChatGPT-Account-Id` 头设置(`getCodexAccountId`)。`packages/ai/src/usage/openai-codex.ts` 中的 `codexRankingStrategy` 将标准 chat 限制(5h 主窗口、7d 次窗口)与 Spark 计量限制(`-spark` 模型后缀消耗 `spark` 作用域)隔离，防止 Spark 耗尽阻塞正常的 chat 请求。
- **用量追踪**:`openaiCodexUsageProvider` 在规范的 ChatGPT 源上查询 `/wham/usage`。解析 `primary_window`(5h)和 `secondary_window`(7d)，以及 `additional_rate_limits`(Spark/额外计量)。在 `parseCodexRateLimitHeaders`(`response-handler.ts` 的 `parseCodexError`)中摄取响应头(`x-codex-primary-used-percent`、`x-codex-primary-window-minutes`、`x-codex-primary-reset-at`、`x-codex-secondary-*`)。
- **保存的限流重置额度**：从 `/wham/usage` 读取 `rate_limit_reset_credits`。用 `listCodexResetCredits`(`GET /wham/rate-limit-reset-credits`)列出可用额度，用 `pickSoonestExpiringCredit` 选择最早过期的额度，并通过 `consumeCodexResetCredit`(`POST /wham/rate-limit-reset-credits/consume`，带客户端 UUID `redeem_request_id`)兑换。
- **Base URL 归一化**:`packages/ai/src/usage/openai-codex-base-url.ts` 中的 `normalizeCodexBaseUrl` 将账户 API 请求(`wham/usage`、重置额度)强制到规范的 `chatgpt.com` 或 `chat.openai.com` 源(`/backend-api`)，忽略会返回 404 的自定义代理覆盖(`providers.openai-codex.baseUrl`)。流 URL 通过 `openai-codex-responses.ts` 中的 `resolveCodexResponsesUrl` 解析。

### 目录模型处理
- **描述符与管理**：在 `packages/catalog/src/provider-models/descriptors.ts` 中定义为 `openai-codex` provider 描述符(默认模型 `"gpt-5.5"`)。在 `packages/catalog/src/provider-models/special.ts` 的 `createOpenAICodexModelManagerOptions` 中配置为具有动态模型发现的特殊托管 provider。
- **动态发现**:`packages/catalog/src/discovery/codex.ts` 中的 `fetchCodexModels` 以 `v2StreamingEnabled: true` 查询 `/codex/models` 或 `/models`，将 `reasoning_presets`(`effort`、`summary`)解析为 `ModelSpec<"openai-codex-responses">`。
- **身份与分类**:`packages/catalog/src/identity/classify.ts` 中的 `OpenAIVariant` 支持 `"codex"`、`"codex-max"`、`"codex-mini"`、`"codex-spark"`。`parseOpenAIModel` 匹配 `gpt-X.Y-(codex-spark|codex-mini|codex-max|codex|mini|max|nano)`。`packages/catalog/src/identity/priority.ts` 中的优先级列表将 `openai-codex` 排在通用 provider 回退之上。
- **思考与 effort 限制**:`packages/catalog/src/model-thinking.ts` 映射支持的 effort(`minimal`、`low`、`medium`、`high`、`xhigh`、`max`)，精准指定模型特定的层级(例如 `GPT_5_1_CODEX_MINI_EFFORTS`)，并检查 `identity/family.ts` 中的 `supportsAllTurnsReasoningContext` 和 `supportsCodexReasoningSummary`。
- **定价回退**：当 Codex 发现模型缺少显式成本元数据时，`packages/catalog/scripts/generate-models.ts` 中的 `applyCodexPricingFallback` 会从模型 ID 匹配的 `openai` provider 条目复制计费成本。

## Azure OpenAI
Azure OpenAI Responses provider(`azure-openai-responses`)处理通过 Azure OpenAI 的 Responses API 提供服务的 OpenAI 系列模型(GPT-4/4.1/4o、GPT-5 系列、o 系列、Codex)的传输、端点解析和兼容性包装。它使用内部 `postOpenAIStream` 传输(`packages/ai/src/utils/openai-http.ts`)发起 JSON-POST / SSE 请求。流生成在 `streamAzureOpenAIResponses`(`packages/ai/src/providers/azure-openai-responses.ts`)中初始化，而共享的 Responses 输入/输出处理逻辑位于 `packages/ai/src/providers/openai-shared.ts`。

### 特殊情况
- **部署名称映射**:Azure OpenAI 要求请求负载中包含部署名称。`resolveDeploymentName`(`packages/ai/src/providers/azure-openai-responses.ts`)先检查 `options.azureDeploymentName`，然后检查 `AZURE_OPENAI_DEPLOYMENT_NAME_MAP` 环境变量(由 `openai-shared.ts` 中的 `parseAzureDeploymentNameMap` 解析为 `modelId=deploymentName` 对的映射，例如 `gpt-5-mini=my-mini-dep,o3=my-o3-dep`)，并默认为 `model.id`。
- **Base URL / 资源解析**:`resolveAzureConfig`(`packages/ai/src/providers/azure-openai-responses.ts`)检查 `options.azureBaseUrl` 或 `$env.AZURE_OPENAI_BASE_URL`。如果缺失，则从 `options.azureResourceName` 或 `$env.AZURE_OPENAI_RESOURCE_NAME` 构造 `https://${resourceName}.openai.azure.com/openai/v1`。如果仍然缺失，则回退到 `model.baseUrl`，未找到端点时抛出 `AIError.ConfigurationError`。尾部斜杠会被剥离。
- **API 版本处理**:`resolveAzureConfig` 从 `options.azureApiVersion`、`$env.AZURE_OPENAI_API_VERSION` 解析 API 版本，或默认为 `"v1"`。它作为请求上的 `api-version` URL 查询参数(`${baseUrl}/responses?api-version=${apiVersion}`)传递，而不是作为 HTTP 头。
- **严格 responses 工具配对**：通过 `buildOpenAIResponsesCompat`(`packages/catalog/src/compat/openai.ts`,`isAzure = true`)对 Azure OpenAI 模型默认启用。在 `buildResponsesInput` / `appendResponsesToolResultMessages`(`packages/ai/src/providers/openai-shared.ts`)中，未配对的工具输出(其 `callId` 并非由先前的助手 `function_call` 项发出的结果)会被 Azure 的严格后端拒绝。omp 将孤立工具结果折叠为合成的助手注记消息(`[Orphan <tool> result; call_id=<id>]: <text>`，最多 16,000 字符，或 `[Orphan computer result; call_id=<id>]`)，而不是发送未配对的输出项。
- **图像 detail 钳制**：在 `appendResponsesToolResultMessages` / `convertResponsesInputContent` 中，如果 `supportsImageDetailOriginal` 为 `false`,`clampResponsesImageDetail` 会将 `detail: "original"` 钳制为 `"auto"`。对于 Azure OpenAI,`supportsImageDetailOriginal` 为 `true`(与 GitHub Copilot 和 xAI OAuth 不同)，从而保留原始图像分辨率。
- **计算机工具回退映射**:`modelForAzureEndpoint`(`packages/ai/src/providers/azure-openai-responses.ts`)验证解析出的端点主机以 `.openai.azure.com` 或 `models.inference.ai.azure.com` 结尾。如果经由无法识别的代理路由，则禁用 `supportsComputerUse`。在 `buildParams` 中，如果某个工具有 `native.type === "computer"` 且 `model.supportsComputerUse` 为 `true`，则序列化为 `{ type: "computer" }`。如果 `supportsComputerUse` 为 `false`，则回退为把计算机工具序列化为标准的 `{ type: "function", name: tool.name, ... }` 工具。`tool_choice` 会在 `computer` 与 `function` 目标之间自动转换。
- **与普通 Responses(`openai-responses`)的差异**：使用 `api-key` 头(绝不使用 `Authorization: Bearer`)，使用固定的端点路径 `${baseUrl}/responses?api-version=...`(`/responses` 路径不按部署划分，不同于 Chat Completions 的 `/deployments/{dep}/chat/completions`)，将部署名称作为 `model` 传入请求体，根据环境/选项动态构造运行时端点，并将 `strictResponsesPairing` 默认为 `true`。

### 流行为
- **事件处理**：使用 `packages/ai/src/providers/openai-shared.ts` 中的 `processResponsesStream` 消费 SSE 流事件(`response.created`、`response.output_item.added`、`response.content_part.added`、`response.output_text.delta`、`response.completed`、`response.incomplete`)。终止性的 `response.incomplete` 事件(输出 token 截断)会更新用量计数器并设置 `stopReason: "length"`。
- **空闲与首事件看门狗**：用 `iterateWithIdleTimeout` 包装。如果首个 SSE 事件未在 `streamFirstEventTimeoutMs` 内到达，则以 `"Azure OpenAI responses stream timed out while waiting for the first event"` 中止。
- **未类型化 SSE 负载解析**:`onSseEvent` 检查未类型化的 JSON 事件数据(`type` 或 `object` 属性)，以在标准 SSE 头行缺少事件类型标签时附加该标签。
- **推理 effort 回退**：在流启动期间捕获 `OpenAIHttpError`。如果端点拒绝所请求的推理 effort(例如 `xhigh`),`resolveOpenAIReasoningEffortFallback` 会确定更低的 effort 等级，下调 `params.reasoning`，并使用 `createOpenAIReasoningEffortFallbackKey("azure-responses", url, model)` 重试请求。

### 认证与使用
- **凭据来源**：来源于 `options.apiKey` 或 `$env.AZURE_OPENAI_API_KEY`(通过 `packages/ai/src/stream.ts` 中的 `getEnvApiKey(model.provider)` 或 `buildAzureResponsesRequest` 获取)。作为 `api-key` 头发送。
- **用量追踪**：由 `processResponsesStream` 直接从终止性的 `response.completed` / `response.incomplete` 流事件中提取(`input_tokens`、`output_tokens`、`reasoning_tokens`、`cached_tokens`)。`packages/ai/src/usage/` 下不存在单独的用量追踪器。
- **Prompt 缓存控制**:`prompt_cache_key` 通过 `getOpenAIPromptCacheKey(options)` 生成。显式 prompt 缓存模式会被拒绝(`AIError.ConfigurationError`)，因为 Azure Responses 不支持显式缓存控制头或保留指令。

### 目录模型处理
- **描述符**:Catalog provider 定义在 `packages/catalog/src/provider-models/descriptors.ts`(`id: "azure"`、`defaultModel: "gpt-5.5"`、`envVars: ["AZURE_OPENAI_API_KEY"]`)。在 `packages/catalog/src/provider-models/openai-compat.ts` 中，通过 `simpleModelsDevDescriptor("azure", "azure", "azure-openai-responses", "", ...)` 映射，该描述符将 stencil catalog 模型过滤为具备工具能力的 OpenAI 系列 ID(`gpt-`、`o1`、`o3`、`o4`、`codex`、`chatgpt`)，丢弃第三方 Foundry 模型(Claude、DeepSeek、Llama、Mistral、Phi)。
- **为什么捆绑模型不携带 `baseUrl`**:Azure OpenAI 端点是资源特定的，在 catalog 生成期间未知(`models.json` 存储 `baseUrl: ""`)。运行时解析从 `AZURE_OPENAI_BASE_URL` 或 `AZURE_OPENAI_RESOURCE_NAME` 解析端点。兼容性检测(`packages/catalog/src/compat/openai.ts` 中的 `isAzure`)匹配 `provider === "azure"`，确保带空 `baseUrl` 的捆绑模型仍获得 Azure 兼容标志(`strictResponsesPairing`、`supportsDeveloperRole`、`supportsStrictMode`)。
- **身份与分类**:`hosts.ts` 定义 `azureOpenAI`，匹配 `provider: "azure"` 或以 `.openai.azure.com`、`azure.com/openai`、`models.inference.ai.azure.com` 结尾的主机名。
- **思考元数据**：在 `packages/catalog/src/model-thinking.ts` 中,Azure 推理模型(o 系列、GPT-5、Codex)通过 `DEFAULT_REASONING_EFFORTS_WITH_XHIGH` 解析出离散的 OpenAI 推理 effort 层级(`minimal`、`low`、`medium`、`high`、`xhigh`、`max`)。

## Anthropic Messages
Anthropic provider(`packages/ai/src/providers/anthropic.ts`)通过 HTTPS POST 到 `/v1/messages`(或 `/v1/messages?beta=true`)，使用 Server-Sent Events (SSE) 实现 Anthropic Messages API 协议的流式传输。自定义 HTTP 客户端传输由 `AnthropicMessagesClient`(`packages/ai/src/providers/anthropic-client.ts`)提供，以内置的重试和超时逻辑取代 `@anthropic-ai/sdk`。Wire 结构和 SSE 负载在 `packages/ai/src/providers/anthropic-wire.ts` 中定义类型。客户端指纹常量(版本、user agent、工具前缀)位于 `packages/ai/src/providers/claude-code-fingerprint.ts`，而底层 Node HTTPS socket 复用和头顺序由 `coworkFetch`(`packages/ai/src/providers/cowork-fetch.ts`)处理。

### 特殊情况
- **OAuth vs API key 路径**:`buildAnthropicHeaders`(`packages/ai/src/providers/anthropic.ts`)检查 `options.isOAuth ?? isAnthropicOAuthToken(apiKey)`。OAuth 请求发送 `Authorization: Bearer <token>` 而不发送 `X-Api-Key`，默认 `Accept: application/json`(或 `text/event-stream`)，并注入 Cowork 桌面 beta 标志(`buildCoworkBetas`)。API key 请求发送 `X-Api-Key: <key>` 而不发送 `Authorization`，且仅包含调用方额外的 beta。当启用 `allowAnthropicHeaderOverrides` 时，非官方端点允许头覆盖。
- **Claude Code 指纹头与 beta**：默认头包括 `anthropic-version: 2023-06-01`、`anthropic-dangerous-direct-browser-access: true`、`x-app: cli` 和 `User-Agent: claude-cli/2.1.220 (external, claude-desktop)`(`coworkUserAgent`)。活动的 beta 标志(`buildCoworkBetas`)包括 `claude-code-20250219`、`interleaved-thinking-2025-05-14`、`thinking-token-count-2026-05-13`、`context-management-2025-06-27`、`prompt-caching-scope-2026-01-05`、`mid-conversation-system-2026-04-07`、`advanced-tool-use-2025-11-20`、`effort-2025-11-24` 和 `fallback-credit-2026-06-01`(`context-1m-2025-08-07` 被省略，以避免订阅 token 上的 429 额度错误,#7238)。指纹元数据(`generateClaudeCloakingUserId`、`deriveClaudeDeviceId`、`generateClaudeJsonUserId`)生成设备/会话 ID。计费证明头(`createClaudeBillingHeader`、`wrapFetchForCch`、`patchCch`)将 `cch=00000` XXHash64 哈希嵌入 `system[0]`。
- **系统提示注入**:`buildAnthropicSystemBlocks`(`packages/ai/src/providers/anthropic.ts`)会为 OAuth 凭据自动将 `claudeCodeSystemInstruction`(“You are a Claude agent, built on Anthropic's Claude Agent SDK.”)作为 `system[0]` 前置。对 Opus 4.8+ / Sonnet 5+，通过 `mid-conversation-system-2026-04-07` 在轮次历史中启用会话中系统消息。
- **思考签名与 redacted thinking**：重放被修改或未签名的思考块会导致 Anthropic API 报错(`invalid signature in thinking block`)。`convertAnthropicMessages` 转换 `ThinkingContent` 和 `RedactedThinkingContent`(`type: "redacted_thinking"`、`data`)。`maybeAddReplayUnsignedThinkingHint` 在签名错误时附加恢复提示，而 `unwrapAnthropicThinkingEnvelope` 剥离遗留的 `<thinking>` XML 包装。
- **工具使用重放与前缀**：使用 OAuth 时，`encodeAnthropicToolName` / `decodeAnthropicToolName`(`packages/ai/src/providers/anthropic.ts`)为自定义工具名添加 `_`(`claudeToolPrefix`)前缀，以防止与内置工具(`web_search`、`code_execution`、`text_editor`、`computer`)冲突。服务端执行的 web 搜索和工具搜索(`anthropic-wire.ts` 中的 `AnthropicServerToolHistoryBlockParam`)通过 `isAnthropicServerToolHistoryBlock` 检测，用于轮次重放。空的工具错误由 `ensureErrorToolResultWireContent` 填充。
- **严格工具 schema 归一化与回退**:`normalizeAnthropicToolSchema` 和 `normalizeAnthropicStrictSchema` 为 `structured-outputs-2025-12-15` beta 剥离不受支持的 JSON schema 关键字(例如对象上的 `minItems`/`maxItems`)。如果严格工具 schema 导致 HTTP 400,`streamAnthropicOnce` 会调用 `dropAnthropicStrictTools`，并在不带严格模式的情况下自动重试。
- **自适应 vs 预算思考**:`ThinkingConfigParam`(`anthropic-wire.ts`)支持预算思考(`{ type: "enabled", budget_tokens: N }`，由 `ensureMaxTokensForThinking` 强制执行)和自适应思考(通过 `effort-2025-11-24` beta 与 `output_config: { effort: level }` 配对的 `{ type: "adaptive" }`)。强制工具选择(`disableThinkingIfToolChoiceForced`)会自动禁用思考。
- **Prompt 缓存断点**:`applyPromptCaching`(`packages/ai/src/providers/anthropic.ts:3195`，在 `:3506` 处调用)在会话尾部标记一个双消息滚动窗口：它在两个尾部轮次各自最后一个普通内容块上附加 `cache_control: { type: "ephemeral" }`(仅在支持长保留的模型上为长保留附加 `ttl: "1h"`，由 `:497` 处的 `getCacheControl` 构造)，跳过 `thinking`、`redacted_thinking` 和 `fallback` 块(`:3179` 处的 `applyCacheControlToLastBlock`)。当尾部用户消息是助手预填之后追加的中性 `"Continue."` 填充时，窗口改为锚定在前一个真实的助手消息上。缓存绝不会应用于系统提示或工具定义，且没有总断点上限。

### 流行为
- **事件协议**:`streamAnthropicOnce`(`packages/ai/src/providers/anthropic.ts`)中的 SSE 流发出标准框架事件：`message_start`(传递初始输入和缓存用量)、`content_block_start`(初始化块类型:text、thinking、tool_use、redacted_thinking、fallback)、`content_block_delta`(流式传输 `text_delta`、`thinking_delta`、`signature_delta`、`input_json_delta`)、`message_delta`(传递 `stop_reason` 和最终 `output_tokens`)、`content_block_stop`、`message_stop` 和 `ping`。
- **细粒度工具流式传输**：通过 `fine-grained-tool-streaming-2025-05-14` beta 启用。传入的 `input_json_delta` chunk 在 `kStreamingPartialJson` 中累积，由 `parseStreamingJsonThrottled` 持续解析，以呈现流式工具参数。
- **流看门狗与修复**：使用 `iterateWithIdleTimeout` 内的 `getStreamFirstEventTimeoutMs` 和 `getStreamIdleTimeoutMs` 监控流的停顿超时。`ping` 事件(`ANTHROPIC_PING_EVENT`)会重置空闲超时乘数。空补全响应(0 token)通过 `withReplaySafeStreamRetry` 触发自动重试。快速模式(`speed: "fast"`)失败会清除会话快速模式状态(`clearAnthropicFastModeFallback`、`dropAnthropicFastMode`)，以回退到标准执行。

### 认证与使用
- **OAuth 认证与 PKCE**：在 `packages/catalog/src/compat/rules/auth/anthropic.kdl` 中声明为 `login "oauth-code"` 规则(`packages/ai/src/registry/engine/oauth-code.ts`)，身份钩子在 `packages/ai/src/registry/oauth/anthropic.ts`，使用解码后的客户端 ID(`OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl`)对 `https://claude.ai/oauth/authorize` 和 `https://api.anthropic.com/v1/oauth/token` 执行 PKCE `S256` 认证。OAuth token 带有 30 天的绝对授权 TTL(`anthropic-constants.ts` 中的 `ANTHROPIC_OAUTH_GRANT_TTL_MS`)，无论刷新 token 如何轮换，都需要每月交互式重新登录。账户身份通过 `extractAccountFromTokenResponse` 或 `fetchBootstrapIdentity`(`/api/claude_cli/bootstrap`)解析。
- **配额追踪与账户轮换**:`packages/ai/src/usage/claude.ts` 轮询 `https://api.anthropic.com/api/oauth/usage`，以追踪滚动的 `five_hour`、`seven_day`、`limits[]`(`weekly_scoped`)和 `anthropic-ratelimit-unified-*` 头。匹配 `isUsageLimitOutcome`(`packages/ai/src/error/rate-limit.ts`)和 `parseRateLimitReason`(`QUOTA_EXHAUSTED`)的错误会触发自动凭据轮换。
- **错误分类**:HTTP 错误由 `parseRateLimitReason`(`packages/ai/src/error/rate-limit.ts`)分类为 `QUOTA_EXHAUSTED`(30m 退避 / 轮换)、`RATE_LIMIT_EXCEEDED`(30s 退避)、`CONCURRENT_LIMIT`(5s 退避)和 `MODEL_CAPACITY_EXHAUSTED`(45s ± 15s 退避)。瞬态 HTTP 408/409/429/5xx 错误由 `AnthropicMessagesClient`(`packages/ai/src/providers/anthropic-client.ts`)重试，遵循 `retry-after-ms` / `retry-after` 头。

### 目录模型处理
- **模型身份与分类**:`isClaudeModelId`(`packages/catalog/src/identity/family.ts`)使用正则 `/(^|[/.])claude[-.]/i` 识别裸、带命名空间(`anthropic/claude-*`)和 Bedrock(`us.anthropic.claude-*`)的 Claude 模型。`parseAnthropicModel`(`packages/catalog/src/identity/classify.ts`)解析模型种类(Opus、Sonnet、Fable、Mythos)、版本和变体。功能检查包括 `anthropicModelSupportsThinking`(v>=3.7)、`supportsAdaptiveThinkingDisplay`(v>=4.7)、`supportsMidConversationSystemMessages`(v>=4.8)和 `isAnthropicFableOrMythosModel`。
- **Provider 描述符**:`CATALOG_PROVIDERS`(`packages/catalog/src/provider-models/descriptors.ts`)定义 Anthropic provider 条目，包含 `defaultModel: "claude-opus-4-8"`、`envVars: ["ANTHROPIC_API_KEY"]` 和模型管理器选项 `anthropicModelManagerOptions`。
- **思考配置**:`resolveModelThinking`(`packages/catalog/src/model-thinking.ts`)派生思考能力。现代自适应模型(Opus 4.7+、Sonnet 5+)使用 `FIVE_TIER_EFFORTS_LOW_TO_MAX`(`[low, medium, high, xhigh, max]`)，较旧的自适应模型使用 `FOUR_TIER_EFFORTS_LOW_TO_MAX`。Effort 等级通过 `mapEffortToAnthropicAdaptiveEffort` 映射到 Anthropic wire 值。
- **定价与倍数**:`packages/catalog/scripts/generate-models.ts` 中的 `COPILOT_PREMIUM_MULTIPLIERS` 在模型 catalog 生成期间为 GitHub Copilot 的 Anthropic 模型分配 premium 倍数(例如 `claude-opus-4.6`:3x,`claude-haiku-4.5`:0.33x)。

## Google Gemini
Google Gemini 集成通过 HTTP 使用 REST/SSE(`POST https://generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent?alt=sse`)。核心 provider 入口点是 `packages/ai/src/providers/google.ts`(`streamGoogle`)、`packages/ai/src/providers/google-shared.ts`(`streamGoogleGenAI`、`buildGoogleGenerateContentParams`、`convertMessages`、`consumeGoogleStream`)和 `packages/ai/src/providers/google-types.ts`。

### 特殊情况
- **`generateContent` 协议**：系统提示在 `buildGoogleGenerateContentParams` 中被提升到 `{ systemInstruction: { parts: [{ text }] } }`。工具使用 `parametersJsonSchema` 格式化为 `tools[].functionDeclarations`(通过 `packages/ai/src/utils/schema/normalize.ts` 中的 `normalizeSchemaForGoogle` 净化)。
- **`thinkingConfig` 映射**:`buildGoogleGenerateContentParams` 设置 `includeThoughts: !options.hideThinkingSummary`。Gemini 3 模型将 `options.thinking.level` 映射到 `thinkingLevel`(`THINKING_LEVEL_UNSPECIFIED`、`MINIMAL`、`LOW`、`MEDIUM`、`HIGH`)。Gemini 2.x 模型将 `options.thinking.budgetTokens` 映射到 `thinkingBudget`。Cloud Code Assist provider(`google-gemini-cli.ts`)在禁用时将 `thinking.suppress` 映射为显式的 `includeThoughts: false` 并附带 level/budget(`suppressWhenOff`)。
- **函数调用 ID 合成与 Vertex AI 剥离**：当 ID 缺失或重复时，`google-shared.ts` 中的 `nextToolCallId` 生成唯一 ID(`${name}_${Date.now()}_${++toolCallCounter}`)。`supportsFunctionPartId` 为 `claude-` 模型或 Gemini 3 模型(`isGemini3Model`)启用 `functionCall.id` / `functionResponse.id` 传播。`google-vertex` API 拒绝 function 部分中的 `id` 字段，因此 `google-shared.ts` 会为 Vertex 请求剥离 `part.functionCall.id` 和 `part.functionResponse.id`。
- **连续的 `functionResponse` 规则**:Gemini 要求并行工具调用结果位于单条连续的 `user` 角色消息中。`google-shared.ts` 中的 `convertMessages` 检查 `lastContent`，并将 `functionResponse` 部分合并进现有的 `user` 轮次(`lastContent.parts.push(functionResponsePart)`)。
- **按版本区分的多模态函数响应**:Gemini 3+ 模型(`supportsMultimodalFunctionResponse`，通过 `getGeminiMajorVersion >= 3` 检查)支持直接嵌套在 `functionResponse.parts` 内部的内联工具输出图像。Gemini < 3 模型将工具图像缓冲到 `pendingToolImageParts` 中，并在随后单独的 `user` 文本/图像轮次中刷出。
- **安全设置与 Prompt 反馈**:`PromptFeedback` 中的安全阻断(`blockReason`、`blockReasonMessage`)会抛出带 `kind: "content-blocked"` 的 `AIError.ProviderResponseError`。`FinishReason` 值(`SAFETY`、`BLOCKLIST`、`PROHIBITED_CONTENT`、`SPII`、`IMAGE_SAFETY`、`RECITATION`、`MALFORMED_FUNCTION_CALL`、`UNEXPECTED_TOOL_CALL`、`NO_IMAGE`、`OTHER`)在 `mapStopReason` 中映射为 `stopReason: "error"`。

### 流行为
- **`streamGenerateContent` SSE 协议**：流通过 `streamGoogleGenAI` 中的 `readSseJson<GenerateContentResponse>` 消费。
- **思考部分与签名保留**：当 `part.thought === true` 时，`isThinkingPart` 识别推理文本。加密的 `part.thoughtSignature` 字段使用 `retainThoughtSignature` 跨 delta 保留。在 `convertMessages` 中，只有当消息 provider/模型与目标匹配(`msg.provider === model.provider && msg.model === model.id`)且通过 `isValidThoughtSignature`(base64 检查)时，才保留思考签名。对于缺少有效签名的 Gemini 3 工具调用，公开 Gemini API 会在每次未签名调用上发出 `skip_thought_signature_validator` 绕过哨兵。Cloud Code Assist / Antigravity 仅在一个轮次的首次调用未签名时发出它；签名在前的并行轮次会从后续未签名调用中省略它。Vertex AI 始终省略该哨兵(#9638、#10602)。
- **空响应重试循环**:`streamGoogleGenAI` 防止 Gemini 返回 `finishReason: STOP` 且内容为空、又未调用工具的情况。`hasMeaningfulGoogleContent` 校验输出；如果为空，`streamGoogleGenAI` 在通过 `resetGoogleStreamOutputForRetry` 重置流输出后，以指数退避(`EMPTY_STREAM_BASE_DELAY_MS * 2^attempt`)最多重试 `MAX_EMPTY_STREAM_RETRIES`(2 次重试，共 3 次尝试)。
- **思考循环防护**：实现在 `packages/ai/src/utils/thinking-loop.ts`(`ThinkingLoopDetector`)中。Gemini、DeepSeek 和 Grok 的模型 ID 家族会在工具调用之前被监控三种失控形态：
  1. *逐字尾部重复*(`EXACT_TAIL_WINDOW = 4096`,>= 180 个重复字符)。
  2. *近似重复片段*(最近 16 个片段的 trigram Jaccard 相似度 >= 0.8)。
  3. *进展词汇停滞*(连续 8 个片段中新奇度 <= 0.2，且没有新的具体引用锚点)。
  4. Gemini 的 `GEMINI_HEADER_RUNAWAY_THRESHOLD = 24` 会中止那些发出过多带标题的推理摘要却不采取行动的流。触发时发出一个合成的可重试 `error`，并标记 `AIError.Flag.ThinkingLoop`。
- **完成原因映射与不完整流**:`candidate.finishReason` 通过 `mapStopReason` 映射；如果输出包含工具调用，`stop`/`length` 原因会升级为 `toolUse`。没有 `finishReason` 的丢弃会抛出带 `kind: "incomplete-stream"` 的 `ProviderResponseError`。
- **UsageMetadata 核算**：附加到 `consumeGoogleStream` 中的尾部 chunk。`input` 计算为 `promptTokenCount - (cachedContentTokenCount || 0)`;`output` 计算为 `candidatesTokenCount + (thoughtsTokenCount || 0)`;`cacheRead` 计算为 `cachedContentTokenCount || 0`;`reasoningTokens` 计算为 `thoughtsTokenCount`。Token 成本通过 `calculateCost(model, output.usage)` 计算。

### 认证与使用
- **凭据来源**：直接通过 `x-goog-api-key: apiKey` 头(或通过 `packages/ai/src/providers/google.ts` 中的 `getEnvApiKey(model.provider)` 获取的 `GEMINI_API_KEY` 环境变量)认证。
- **用量追踪器**:`packages/ai/src/usage/gemini.ts` 中的 `googleGeminiCliUsageProvider` 通过调用 `POST /v1internal:loadCodeAssist`(用于项目解析)和 `POST /v1internal:retrieveUserQuota` 来监控 OAuth 支持的 Cloud Code Assist 用量。配额桶被映射为层级(`Flash`、`Pro`、`3-Flash`)，带有剩余比例的使用百分比和重置窗口(`parseWindow`)。

### 目录模型处理
- **身份与分类**:`packages/catalog/src/identity/classify.ts` 中的 `parseGeminiModel` 解析匹配 `gemini-{version}-{kind}`(可带 `-preview` 后缀)的模型 ID，返回 `GeminiModel`(`family: "gemini"`、`kind: "pro" | "flash"`、`version: SemVer`)。
- **思考元数据与等级**:`packages/catalog/src/model-thinking.ts` 使用 `ThinkingLevel` 枚举字符串(`THINKING_LEVEL_UNSPECIFIED`、`MINIMAL`、`LOW`、`MEDIUM`、`HIGH`)配置思考选项。为 Gemini 3 模型定义了 effort 梯级：`GEMINI_3_PRO_EFFORTS`(`[low, high]`)和 `GEMINI_3_FLASH_EFFORTS`(`[minimal, low, medium, high]`)。
- **描述符与发现**：在 `packages/catalog/src/provider-models/descriptors.ts` 中配置(`google` 的 `CATALOG_PROVIDERS` 条目，默认模型 `gemini-3.1-pro-preview`,`GEMINI_API_KEY`)。`packages/catalog/src/discovery/gemini.ts`(`fetchGeminiModels`)中的动态发现获取 `GET /v1beta/models?key=...`，过滤 `generateContent` 方法并解析 `inputTokenLimit` 和 `outputTokenLimit`。
- **定价与 Antigravity 回填**：基础价格通过 `calculateCost` 计算。在 `scripts/generated-policies.ts` 和 `scripts/generate-models.ts` 中，`google-antigravity` 模型在上游报告 $0 标价，因此使用 `ANTIGRAVITY_PRICING_PEERS`(`["google", "google-vertex", "anthropic"]`)回填，并通过 `ANTIGRAVITY_PRICING_ID_ALIASES` 解析 Gemini 别名(例如 `gemini-3-flash` -> `gemini-3-flash-preview`)。

## Google Vertex AI

Google Vertex AI provider 为托管在 Google Cloud Vertex AI 上的 Gemini 模型以及通过 Vertex 端点提供服务的第三方模型(例如 Anthropic Claude)启用流式生成。入口点包括 `packages/ai/src/providers/google-vertex.ts` 中用于 Gemini 模型的 `streamGoogleVertex`(API 类型 `"google-vertex"`),`packages/ai/src/stream.ts` 中通过 `createVertexAuthenticatedFetch` 用于 Claude 模型的 `streamAnthropic`(API 类型 `"anthropic-messages"`)，以及 `packages/ai/src/providers/google-auth.ts` 中的 ADC 认证。传输使用 HTTPS REST / SSE，采用 Application Default Credentials(ADC OAuth Bearer token)或 Vertex Express Mode API key(`x-goog-api-key`)。

### 特殊情况
* **端点与项目/位置解析**：在 ADC 模式(`packages/ai/src/providers/google-vertex.ts`)下，请求 URL 遵循 `https://${host}/v1/projects/${project}/locations/${location}/publishers/google/models/${model.id}:streamGenerateContent?alt=sse`。`project` 从 `options.project`、`$env.GOOGLE_CLOUD_PROJECT`、`$env.GCP_PROJECT` 或 `$env.GCLOUD_PROJECT` 解析(缺失时抛出 `ConfigurationError`)。`location` 从 `options.location`、`$env.GOOGLE_VERTEX_LOCATION`、`$env.GOOGLE_CLOUD_LOCATION` 或 `$env.VERTEX_LOCATION` 解析(缺失时抛出 `ConfigurationError`)。在 Express Mode(通过 `options.apiKey` 或 `$env.GOOGLE_CLOUD_API_KEY` 的 API Key 模式)下,URL 遵循 `https://${host}/v1/publishers/google/models/${model.id}:streamGenerateContent?alt=sse`，带有 `x-goog-api-key` 头，`location` 默认为 `"global"`，并在环境区域主机失败时回退到全局端点。
* **端点主机解析**:`packages/catalog/src/hosts.ts` 中的 `resolveVertexEndpointHost(location)` 将位置映射到主机名：`"global"` → `aiplatform.googleapis.com`；多区域 `"eu"` / `"us"` → `aiplatform.{location}.rep.googleapis.com`(避免标准插值导致的 404)；区域(例如 `"us-central1"`、`"europe-west4"`)→ `${location}-aiplatform.googleapis.com`。
* **函数调用与响应 ID 剥离**:`packages/ai/src/providers/google-shared.ts` 中的 `supportsFunctionPartId(model)` 对 `google-vertex` 返回 `false`。`convertMessages` 在 wire 序列化之前显式删除 `part.functionCall.id` 和 `functionResponsePart.functionResponse.id`，因为当 function 部分包含 `id` 字段时 Vertex AI 会返回 `400 INVALID_ARGUMENT`。
* **安全设置默认值**:`packages/ai/src/providers/google-vertex.ts` 中的 `streamGoogleVertex` 在未配置时，自动将禁用所有危害类别的安全设置(`HARM_CATEGORY_HATE_SPEECH`、`HARM_CATEGORY_DANGEROUS_CONTENT`、`HARM_CATEGORY_SEXUALLY_EXPLICIT`、`HARM_CATEGORY_HARASSMENT` 设为 `threshold: "OFF"`)注入 `params.config.safetySettings`。
* **服务层级优先级头**:Vertex 会忽略直接的 `serviceTier` 请求体字段；`options.serviceTier === "priority"` 会作为请求头 `X-Vertex-AI-LLM-Shared-Request-Type: priority`(`google-vertex.ts`)传递。`flex` 没有文档化的控制方式，属于空操作。
* **缓存内容透传**：将调用方提供的 `cachedContent` 资源名原样传入 `params.config.cachedContent`(`google-shared.ts`)，绕过创建/刷新生命周期。

### 流行为
* **Gemini 流式执行**：委托给 `packages/ai/src/providers/google-shared.ts` 中的 `streamGoogleGenAI` 和 `consumeGoogleStream`，并带 `retainTextSignature: true`。处理 SSE chunk 解析、文本/思考块聚合(`thoughtSignature`)、工具调用 ID 合成(当 Vertex 省略 ID 时生成)和完成原因。
* **Anthropic-on-Vertex RawPredict 处理**:`packages/ai/src/stream.ts` 中的 `isGoogleVertexAuthenticatedModel` 匹配带有 `anthropic-messages` API 和 `:streamRawPredict` baseUrl 的 `model.provider === "google-vertex"`。请求使用 `apiKey: "vertex-adc"` 和 `createVertexAuthenticatedFetch` 经由 `streamAnthropic` 路由。
* **Anthropic 请求改写**:`packages/ai/src/stream.ts` 中的 `createVertexAuthenticatedFetch` 调用 `resolveVertexRequest` 替换 URL 中的 `{project}` 和 `{location}` 占位符，将 `:streamRawPredict/v1/messages` 路径归一化为 `:streamRawPredict`，并应用 `transformVertexAnthropicBody` 剥离 `payload.model`(编码在 URL 路径中)并向 JSON body 注入 `payload.anthropic_version = "vertex-2023-10-16"`。
* **Anthropic effort beta 门控**:Vertex `rawPredict` 会以 400 错误拒绝 `anthropic-beta` HTTP 头。在 `packages/ai/src/providers/anthropic.ts` 中，`effortBeta`(`effort-2025-11-24`)、`contextManagementBeta` 和 `output_config.effort` 字段对 `model.provider === "google-vertex"` 被关闭。`anthropic.ts` 中的回退负载在 Vertex 请求上也会清除 `output_config.effort`(#5614)。

### 认证与使用
* **ADC 解析阶梯**:`packages/ai/src/providers/google-auth.ts` 按优先级顺序解析凭据：
  1. 指向 JSON 凭据文件的 `GOOGLE_APPLICATION_CREDENTIALS` 环境变量。支持 `type: "service_account"`(通过 WebCrypto `crypto.subtle` 签名的 RS256 JWT 断言，在 `https://oauth2.googleapis.com/token` 交换)、`type: "authorized_user"`(刷新 token 交换)或 `type: "impersonated_service_account"`(先交换源凭据，再调用 GCP IAM `generateAccessToken`)。
  2. 用户 ADC 文件 `~/.config/gcloud/application_default_credentials.json`(`authorized_user` 流程)。
  3. GCE / Cloud Run 元数据服务器(`http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token`)。
* **显式访问 token 覆盖**:`GOOGLE_CLOUD_ACCESS_TOKEN` 或 `CLOUDSDK_AUTH_ACCESS_TOKEN` 环境变量会完全绕过文件/元数据查询和缓存。
* **Token 缓存与在途去重**：访问 token 存储在按解析来源为键的 `tokenCache`(Map)中，并在过期前 `GOOGLE_VERTEX_REFRESH_SKEW_MS`(默认 60s)刷新。并发解析请求共享 `inflight` Map 中的单个在途 promise，受 `SHARED_TOKEN_RESOLVE_TIMEOUT_MS`(30s)约束。各个调用方通过 `raceWithSignal` 用自身的中止信号与共享 promise 竞速，因此单个调用方的中止不会取消批量解析。请求的 OAuth 作用域：`https://www.googleapis.com/auth/cloud-platform`。
* **用量与 Token 归一化**:`packages/ai/src/providers/google-shared.ts` 中的 `consumeGoogleStream` 从响应中提取 `usageMetadata`:`input` 计算为 `promptTokenCount - cachedContentTokenCount`,`output` 计算为 `candidatesTokenCount + thoughtsTokenCount`,`cacheRead` 计算为 `cachedContentTokenCount`,`reasoningTokens` 计算为 `thoughtsTokenCount`。将归一化用量传递给 `calculateCost(model, output.usage)`。

### 目录模型处理
* **Catalog API 解析**:`packages/catalog/src/provider-models/openai-compat.ts` 中的 `resolveGoogleVertexApi` 将 `@ai-sdk/google-vertex/anthropic` npm 包模型路由到 `api: "anthropic-messages"`，并使用 `GOOGLE_VERTEX_ANTHROPIC_BASE_URL`(`https://{location}-aiplatform.googleapis.com/v1/projects/{project}/locations/{location}/publishers/anthropic/models/{model}:streamRawPredict`)。ID 带斜杠或使用 `@ai-sdk/openai-compatible` 的模型路由到 `api: "openai-completions"`。所有其他模型路由到 `api: "google-vertex"`，并使用 `GOOGLE_VERTEX_BASE_URL`(`https://{location}-aiplatform.googleapis.com`)。
* **Provider 描述符**:`packages/catalog/src/provider-models/descriptors.ts` 注册 `id: "google-vertex"`，带 `defaultModel: "gemini-3.1-pro-preview"`。
* **注册表凭据守卫**：在 `packages/catalog/src/compat/rules/auth/google-vertex.kdl` 中通过 `env hook="google-vertex-adc"`(`packages/ai/src/registry/hooks/env.ts`)声明。如果设置了 `$env.GOOGLE_CLOUD_API_KEY` 则返回它；否则如果存在 ADC 凭据(`hasVertexAdcCredentials()`)且项目环境变量(`GOOGLE_CLOUD_PROJECT`/`GCP_PROJECT`/`GCLOUD_PROJECT`)和位置环境变量(`GOOGLE_VERTEX_LOCATION`/`GOOGLE_CLOUD_LOCATION`/`VERTEX_LOCATION`)都存在，则返回 `AUTHENTICATED_SENTINEL`(`"<authenticated>"`)。否则返回 `undefined`，防止模型在没有适当认证的情况下出现在 catalog 列表中。

## Google Gemini CLI / Antigravity
Google Cloud Code Assist (CCA) 传输包装器，通过 `/v1internal:streamGenerateContent` SSE 端点访问 Gemini 和 Claude 模型。实现横跨 `packages/ai/src/providers/google-gemini-cli.ts`(共享执行引擎、请求构造、流解析和规划泄漏过滤器)、`packages/catalog/src/compat/rules/auth/google-gemini-cli.kdl` 和 `packages/catalog/src/compat/rules/auth/google-antigravity.kdl`(认证策略声明)、`packages/ai/src/registry/oauth/google-gemini-cli.ts` 和 `google-antigravity.ts`(OAuth 钩子、项目发现和入职)、`packages/ai/src/usage/google-antigravity.ts` 和 `packages/ai/src/usage/gemini.ts`(配额追踪和凭据排名)，以及 `packages/catalog/src/discovery/antigravity.ts`(模型 catalog 发现)。

### 特殊情况
- **CCA JSON Schema 归一化**:`normalizeSchemaForCCA`(`packages/ai/src/utils/schema/normalize.ts`)递归剥离不受支持的 JSON Schema 关键字(`propertyNames`、`additionalProperties`、`patternProperties`、`$schema`、`title`、`description` 等)，以防 CCA 返回 HTTP 400 错误。它会准确跟踪名为 `properties` 的属性内部上下文，避免过早重新断言属性剥离。工具在 `buildRequest`(`packages/ai/src/providers/google-gemini-cli.ts`)中通过 `normalizeSchemaForCCA` 归一化。
- **函数调用配置模式**：在 `buildRequest` 中,Antigravity 默认为 `functionCallingConfig: { mode: "VALIDATED" }`。Antigravity 上的 Claude 模型即使在上下文未声明任何工具时也强制 `VALIDATED` 模式(`isClaudeModel`)。单个具名工具选择(`options.toolChoice`)会设置 `mode: "ANY"` 并带 `allowedFunctionNames: [...]`。
- **Provider 协议与请求信封**:
  - **端点**:`google-gemini-cli` 默认为 `https://cloudcode-pa.googleapis.com`。`google-antigravity` 在 `https://daily-cloudcode-pa.googleapis.com`(主)和 `https://daily-cloudcode-pa.sandbox.googleapis.com`(沙箱)之间自动故障转移，并在 `AntigravityProviderSessionState` 中持久化 `lastGoodEndpoint`。
  - **头与 User-Agent**:`google-gemini-cli` 发送 `getGeminiCliHeaders()`(`GeminiCLI/0.46.0/<modelId> (platform; arch; terminal)`)。`google-antigravity` 发送 `getAntigravityUserAgent()`(`antigravity/hub/<version> (aidev_client; os_type=<os>; arch=<arch>; cl=<cl>)`)；后端会依据客户端版本对较新的模型(例如 gemini-3.7-flash)做门控。Antigravity 上的推理 Claude 模型发送 `anthropic-beta: interleaved-thinking-2025-05-14`(`needsClaudeThinkingBetaHeader`)。
  - **系统指令**:Antigravity 将系统指令标记为 `role: "user"`。不注入任何身份提示——后端在所有路由上都接受任意系统指令(已针对 gemini-3.x 和 Claude wire id 验证)。
  - **请求信封与会话状态**:Antigravity 将请求包装进 `buildAntigravityRequestEnvelope`:`project`(projectId)、`requestId`(`agent/<agentId>/<ts>/<trajectoryId>/<step>`)、`userAgent`(`antigravity`)、`requestType`(`agent`)和 `labels`(`last_step_index`、`model_enum`、`trajectory_id`、`used_claude`、`used_claude_conservative`、`last_execution_id`)。状态维护单调递增的 `stepIndex`、持久化的 `agentId`、`trajectoryId` 和带符号十进制的 `sessionId`(`deriveAntigravitySessionId`)。
  - **Wire 配置档**:`getAntigravityModelWireProfile`(`packages/catalog/src/wire/gemini-headers.ts`)将 wire ID 映射到 `maxOutputTokens` 和 `model_enum`。Claude wire ID 将 `maxOutputTokens` 上限设为 `64000`(后端拒绝 >64000 并返回 400)。
- **思考配置与 wire 抑制**:Gemini 2.x 模型发送 `thinkingConfig.thinkingBudget`，而 Gemini 3 模型发送 `thinkingConfig.thinkingLevel`。当对具有 `thinking.suppressWhenOff` 的模型禁用推理时，`buildRequest` 会发出显式的 wire 抑制(`includeThoughts: false` 并带 level/budget)。省略 `thinkingConfig` 会导致 CCA 重新应用服务端默认值，并静默计费思考 token。

### 流行为
- **传输与 SSE 协议**：通过 `readSseJson<CloudCodeAssistResponseChunk>` 消费 `POST /v1internal:streamGenerateContent?alt=sse`。Chunk 传递 `candidates[0].content.parts`、`usageMetadata`、`modelVersion`、`responseId`、`promptFeedback` 或顶层 `error`。
- **带内错误与阻断原因**:`chunk.error` 状态/代码 >=400 会抛出 `AIError.GeminiCliApiError` 或 `AIError.ProviderResponseError`。`promptFeedback.blockReason` 抛出带 `kind: "content-blocked"` 的 `AIError.ProviderResponseError`。
- **规划泄漏检测与过滤**:Flash 模型(`isFlashLeakModel`)可能将原始 JSON 内部规划块流式传输到可见文本部分。`consumePlanningBuffer` 使用 `isPlanningLeakPrefix` 和 `splitLeadingJsonObject` 检查以 `{` 或 `"thought":` 开头的前缀。如果解析出的 JSON 包含 `thought`、`call`(匹配活动工具名)、`_i`、`paths`、`command` 或 `path`/`content`，该对象会被归类为 `kind: "leak"` 并从可见输出中剥离。
- **思考部分与签名保留**：带 `thought: true` 或 `isThinkingPart()` 的部分会路由到思考块。文本、思考或 toolCall 部分上的 `thoughtSignature` 通过 `retainThoughtSignature` 保留。内联 `<thinking>` 标签使用 `StreamMarkupHealing` 处理。
- **空流重试**:Google 模型可能返回 `finishReason: "STOP"` 且文本部分为空、没有工具调用。`hasMeaningfulGoogleContent` 检查非空文本、思考或工具调用。`stopReason === "stop"` 的空响应会在失败之前以指数退避(`EMPTY_STREAM_BASE_DELAY_MS = 1000ms`)最多重试 `MAX_EMPTY_STREAM_RETRIES`(3 次重试)(`packages/ai/src/providers/google-gemini-cli.ts`)。
- **响应前看门狗**：使用 `getStreamFirstEventTimeoutMs`(5 分钟上限)设置 `armPreResponseTimeout`，以防止首个 SSE chunk 到达之前出现挂起的 HTTP 代理连接。Bun 原生 fetch 的响应前超时被禁用(`timeout: false`)。

### 认证与使用
- **凭据模型与 token 过期**：凭据以 JSON 存储(`parseGeminiCliCredentials`):`{ token, projectId, refreshToken, expiresAt, email }`。AuthStorage 是唯一的刷新权威。`shouldRefreshGeminiCliCredentials` 以 60s 偏斜检查 token 过期(`ANTIGRAVITY_REFRESH_SKEW_MS` / `GOOGLE_GEMINI_REFRESH_SKEW_MS`)。陈旧 token 会在发起 HTTP 请求之前快速失败。
- **OAuth 已安装应用流程**：回调端口为 `8085`(`google-gemini-cli`,`/oauth2callback`)和 `51121`(`google-antigravity`,`/oauth-callback`)。支持粘贴代码流程(`pasteCodeFlow: true`)。通过 Google PKCE OAuth 2.0(`accounts.google.com/o/oauth2/v2/auth`)授权。Antigravity 作用域包括 `cloud-platform`、`userinfo.email`、`userinfo.profile`、`cclog` 和 `experimentsandconfigs`。
- **项目发现与入职**:
  - `google-gemini-cli`(`packages/catalog/src/compat/rules/auth/google-gemini-cli.kdl`，钩子在 `packages/ai/src/registry/oauth/google-gemini-cli.ts`)：使用 `$GOOGLE_CLOUD_PROJECT` 回退调用 `POST /v1internal:loadCodeAssist`。如果项目不存在，则使用 `tierId`(`free-tier`、`legacy-tier`、`standard-tier`)调用 `POST /v1internal:onboardUser`，并通过 `pollOperation` 轮询 `LongRunningOperationResponse`(最多 `POLL_MAX_ATTEMPTS = 24`，间隔 5s)。检测 VPC-SC 限制(`SECURITY_POLICY_VIOLATED`)。
  - `google-antigravity`(`packages/catalog/src/compat/rules/auth/google-antigravity.kdl`，钩子在 `packages/ai/src/registry/oauth/google-antigravity.ts`)：针对 `https://daily-cloudcode-pa.googleapis.com` 镜像原生 `antigravity/hub` 流程：`loadCodeAssist` 请求携带 `{ metadata: { ideType: "ANTIGRAVITY" } }`，在响应缺少 `paidTier` 时用 `cloudaicompanionProject` 重复，并在解析账户状态后刷新。没有 `currentTier` 的账户会用 `onboardUser` 和 `tierId: "free-tier"` 一次性开通；其长运行操作在一段 30 秒的截止时间内每秒用 `GET /v1internal/{operation.name}` 轮询。
- **用量与配额追踪(`google-antigravity`)**:`antigravityUsageProvider`(`packages/ai/src/usage/google-antigravity.ts`)查询 `POST /v1internal:fetchAvailableModels`。将配额桶归一化为每日(24h)和每周(7d)窗口。将配额去重为后端计数器键(`Anthropic`、`Google`、`OpenAI`)。`antigravityRankingStrategy` 按请求的模型家族限定排名范围(`getAntigravityCounterKeyForModel`:`claude-` → Anthropic,`gemini-`/`gemma-` → Google,`gpt-`/`openai/` → OpenAI)，选择具有可用配额余量的已存储 OAuth 凭据。
- **用量与配额追踪(`google-gemini-cli`)**:`googleGeminiCliUsageProvider`(`packages/ai/src/usage/gemini.ts`)查询 `loadCodeAssist` 和 `retrieveUserQuota`，按模型层级(`3-Flash`、`Flash`、`Pro`)呈现配额百分比。

### 目录模型处理
- **Provider 描述符**:`google-antigravity`(默认模型 `gemini-3.1-pro`)和 `google-gemini-cli`(默认模型 `gemini-3.1-pro-preview`)在 `CATALOG_PROVIDERS` 中定义为 `specialModelManager: true`(`packages/catalog/src/provider-models/descriptors.ts`)，绕过标准工厂。
- **模型解析与发现**:`googleAntigravityModelManagerOptions` 和 `googleGeminiCliModelManagerOptions`(`packages/catalog/src/provider-models/google.ts`)调用 `fetchAntigravityDiscoveryModels`(`packages/catalog/src/discovery/antigravity.ts`)。
- **身份与思考元数据**：解析为 `family: "gemini"`，种类为 `pro` / `flash`(`packages/catalog/src/identity/classify.ts`)。Gemini 3.0+ 模型强制推理(`model-thinking.ts` 中的 `impliesMandatoryReasoning`)。Effort:`GEMINI_3_PRO_EFFORTS`(`[Low, High]`)和 `GEMINI_3_FLASH_EFFORTS`(`[Minimal, Low, Medium, High]`)。
- **变体折叠**:effort 层级变体在发现时折叠为逻辑规范(`packages/catalog/src/variant-collapse.ts`):
  - `gemini-3.5-flash`：折叠 `gemini-3.5-flash-extra-low`、`gemini-3.5-flash-low`、`gemini-3-flash-agent`。Antigravity 预算模式将 Minimal/Low → `extra-low`(1000 token)、Medium → `low`(4000 token)、High → `agent`(10000 token)。Gemini CLI 映射到 level 传输。别名：`gemini-3-flash`。
  - `gemini-3.6-flash`：将 `gemini-3.6-flash-low`、`-medium`、`-high`、`-tiered` 折叠为带 `google-level` 模式的 `gemini-3.6-flash`。
  - `gemini-3.1-pro`：折叠 `gemini-3.1-pro-low`、`gemini-pro-agent`、`gemini-3.1-pro-high`。High effort 路由到 `gemini-pro-agent`，因为上游 `gemini-3.1-pro-high` 部署在 streamGenerateContent 上返回 INVALID_ARGUMENT。
  - `claude-*`：裸模型与 `-thinking` 配对使用 `thinkingPair` 折叠为 `claude-*`(`preserveAbsentEffortRoutes: true`)。
- **Catalog 生成器集成**:`fetchAntigravityModels`(`packages/catalog/scripts/generate-models.ts`)通过发现 token 获取模型(从 `google-antigravity` 回退到 `google-gemini-cli` OAuth 凭据)，并将 `baseUrl` 固定为 `https://daily-cloudcode-pa.googleapis.com`。

## Amazon Bedrock
Amazon Bedrock(`amazon-bedrock` provider,`bedrock-converse-stream` API)通过 HTTPS POST 请求直接与 `bedrock-runtime.{region}.amazonaws.com/model/{modelId}/converse-stream` 通信，使用 AWS SigV4 签名或显式 bearer token，并解码二进制 `application/vnd.amazon.eventstream` 响应。该实现绕过了沉重的 AWS SDK 依赖(`@aws-sdk/*`、`@smithy/*`)，执行用 WebCrypto 签名的原生 fetch，并通过轻量级 eventstream 解析器解码。入口模块包括 `packages/ai/src/providers/amazon-bedrock.ts`(`streamBedrock`)、`packages/ai/src/registry/amazon-bedrock.ts`(`amazonBedrockTransport`)、`packages/catalog/src/compat/rules/auth/amazon-bedrock.kdl` 中的认证策略、`packages/ai/src/registry/aws.ts`、`packages/ai/src/providers/aws-credentials.ts`(`resolveAwsCredentials`)、`packages/ai/src/providers/aws-eventstream.ts`(`decodeEventStream`)和 `packages/ai/src/providers/aws-sigv4.ts`(`signRequest`)。

### 特殊情况
- **Converse API 负载与消息映射**：请求构造 `ConverseStreamRequest`，包含 `messages`、`system`、`inferenceConfig`(`maxTokens`、`temperature`、`topP`)、`toolConfig` 和 `additionalModelRequestFields`。系统提示归一化为带文本块和 `CachePoint` 标记(`{ cachePoint: { type: "default", ttl?: "1h" } }`)的 `SystemContent[]`。用户内容映射为 `text`、`image`(通过 `createImageBlock` 的 `jpeg`/`png`/`gif`/`webp` base64)、`toolResult` 或 `cachePoint`。Bedrock 要求连续的工具结果块合并为单条 `user` 角色 `WireMessage`(`convertMessages` 循环合并相邻的 `toolResult` 轮次)。空文本块和空内容数组会被过滤，以避免 HTTP 400 校验失败。
- **NO_TOOLS_SENTINEL(`__no_tools__`)**:Bedrock 校验：任何包含先前 `toolUse` 或 `toolResult` 块的请求都必须提供 `toolConfig`。当工具被禁用(`toolChoice: "none"`)，或在具有工具历史的轮次上为空时，`planToolConfig` 注入占位工具 `NO_TOOLS_SENTINEL`(`name: "__no_tools__"`，虚拟 schema)。每请求标志 `sentinelInjected` 追踪注入情况(因此名为 `__no_tools__` 的调用方工具仍可正常工作)。当 `sentinelInjected` 为 true 时，`handleContentBlockStart` 会忽略合成的 tool-use 开始事件，且 `messageStop` 将 `stopReason: "tool_use"` 降级为 `"stop"`。
- **思考与推理(`additionalModelRequestFields`)**:
  - `anthropic-adaptive` 模型(Claude Opus 4.7+、Sonnet/Opus 5、Fable/Mythos 5)：通过 `mapEffortToAnthropicAdaptiveEffort` 映射为 `{ thinking: { type: "adaptive", display? }, output_config: { effort } }`。在支持 display 的模型上，`thinkingDisplay` 默认为 `"summarized"`，以避免在 Anthropic 默认的 `"omitted"` 下静默推理流(issue #1373)。
  - 预算模式模型(例如 Claude 3.7 / 4.6)：映射为 `{ thinking: { type: "enabled", budget_tokens, display }, anthropic_beta? }`。当 `interleavedThinking` 为 true 时设置 `anthropic_beta: ["interleaved-thinking-2025-05-14"]`。
  - 强制工具选择冲突：当 `toolChoice` 强制工具执行(`any` 或具名的 `{ tool: { name } }`)时,Bedrock 拒绝思考。当强制工具选择处于活动状态时，`streamBedrock` 会清除 `additionalModelRequestFields`。
  - 思考签名与降级：在 Claude 模型(`supportsThinkingSignature`)上，没有 `thinkingSignature` 的助手思考块会通过 `renderDemotedThinking` 降级为文本。非 Claude 模型(Nova、Titan、Llama、Mistral)拒绝思考签名，并接收未签名的 `reasoningContent`。
- **区域与推理配置档解析**:`resolveBedrockRegion` 按以下顺序解析运行时区域：显式 `options.region` -> ARN 内嵌区域(`inferRegionFromBedrockArn`)-> 环境/配置文件区域(`resolveAwsAmbientRegion`)。对于带地理前缀的跨区域推理配置档(`us.`、`us-gov.`、`eu.`、`apac.`、`au.`、`jp.`),`regionServesGeo` 验证环境区域兼容性；环境区域不匹配或缺失时回退到地理默认端点(`INFERENCE_PROFILE_GEO_DEFAULT_REGION`:`us` -> `us-east-1`,`us-gov` -> `us-gov-west-1`,`eu` -> `eu-west-1`,`apac` -> `ap-southeast-1`,`au` -> `ap-southeast-2`,`jp` -> `ap-northeast-1`)。`global.` 配置档使用环境区域或 `us-east-1`。

### 流行为
- **AWS Eventstream 二进制解码**：按大端整数分帧(`[total len u32][headers len u32][prelude CRC u32][headers][payload][message CRC u32]`)。`packages/ai/src/providers/aws-eventstream.ts` 中的 `decodeMessage` 检查总长度(最小 16 字节)，通过 `Bun.hash.crc32(bytes) >>> 0`(`crc32`)计算 IEEE 802.3 CRC32，并校验前奏(前 8 字节)和消息 CRC(整个帧减去 4 字节)。头解析器(`parseHeaders`)读取类型化头(bool、byte、short、int、long、byte-array、string、timestamp、uuid)。`decodeEventStream` 使用可增长的 Uint8Array 缓冲区从 `ReadableStream<Uint8Array>` 产出消息，并在中止时取消 reader 锁。
- **事件分发与错误处理**：携带 `:message-type = "event"` 的流消息分发：
  - `messageStart`：校验 `role === "assistant"` 并推送流 `start`。
  - `contentBlockStart`：推送 `toolcall_start`(跳过哨兵)。
  - `contentBlockDelta`：推送 `text_delta`(不存在时创建文本块)、`toolcall_delta`(在 `kStreamingPartialJson` 中累积 JSON 输入 delta，经 `parseStreamingJsonThrottled` 节流)或 `thinking_delta`(累积推理文本和签名)。
  - `contentBlockStop`：通过 `parseStreamingJson` 解析工具 JSON，并推送 `text_end`/`thinking_end`/`toolcall_end`。
  - `messageStop`：映射 `stopReason`(`end_turn`/`stop_sequence` -> `stop`,`max_tokens`/`model_context_window_exceeded` -> `length`,`tool_use` -> `toolUse`)。
  - `metadata`：提取用量(`inputTokens`、`outputTokens`、`cacheReadInputTokens`、`cacheWriteInputTokens`)并调用 `calculateCost`。
  - `:message-type = "exception"` 提取 `:exception-type` 和错误负载以抛出 `BedrockApiError`(400)。`:message-type = "error"` 提取 `:error-code` 和 `:error-message`。
- **空闲看门狗与响应前超时**：禁用 Bun 原生 `fetch` 超时(`timeout: false`)以支持长预填提示。响应前超时通过 `armPreResponseTimeout` 使用 `streamFirstEventTimeoutMs` 设置。Bedrock 流在推理期间不发送 ping/keepalive 事件;catalog 兼容设置(`packages/catalog/src/compat/bedrock.ts` 的 `buildBedrockCompat`)为标准推理模型将 `streamIdleTimeoutMs` 下限设为 600s，为自适应思考模型(Claude Opus 4.7+、Sonnet/Opus 5、Fable 5)设为 900s。

### 认证与使用
- **双重认证模式**:
  - Bearer token：如果存在 `options.bearerToken`、`options.apiKey` 或 `$env.AWS_BEARER_TOKEN_BEDROCK`(`resolveAwsBearerToken`)，则设置 `Authorization: Bearer <token>` 并绕过 SigV4 签名。
  - AWS SigV4 签名：`signRequest`(`packages/ai/src/providers/aws-sigv4.ts`)使用 WebCrypto(`crypto.subtle`)对头签名。计算 SHA-256 负载摘要(`x-amz-content-sha256`)、日期(`x-amz-date`)、host 和安全 token(`x-amz-security-token`)。派生 HMAC-SHA256 签名密钥链(`AWS4` + `secretAccessKey` -> `kDate` -> `kRegion` -> `kService`("bedrock")-> `kSigning`)。
- **5 层凭据解析链**:`resolveAwsCredentials`(`packages/ai/src/providers/aws-credentials.ts`)按 `profile\0region\0config` 键缓存已解析凭据，带 60s 刷新偏斜(`REFRESH_SKEW_MS`)和受 30s 超时限制的 single-flight 在途去重(`SHARED_RESOLVE_TIMEOUT_MS`)。链优先级：
  1. 环境变量：`AWS_ACCESS_KEY_ID`、`AWS_SECRET_ACCESS_KEY`，可选 `AWS_SESSION_TOKEN`。
  2. Web Identity / OIDC:`AWS_WEB_IDENTITY_TOKEN_FILE`、`AWS_ROLE_ARN`、`AWS_ROLE_SESSION_NAME`。在 `sts.{region}.amazonaws.com` 上调用 STS `AssumeRoleWithWebIdentity`。
  3. 共享配置 / 配置文件(`~/.aws/credentials`、`~/.aws/config`，通过 `parseAwsIni` 解析)：静态密钥(文件会话 token 通过 `FILE_SESSION_CREDS_TTL_MS` 限制为 5 分钟 TTL)、AWS SSO(`sso_account_id`、`sso_role_name`，遗留的 `sso_start_url`/`sso_region` 或 `sso-session` 块；从 `~/.aws/sso/cache/*.json` 读取缓存 token 并调用 `portal.sso.{ssoRegion}.amazonaws.com/federation/credentials`)或 `credential_process`(使用 POSIX 分词 `tokenizeCredentialProcessCommand` 生成外部进程;Windows `.cmd`/`.bat` 经由 `cmd.exe /c`；期望 Version 1 JSON 信封)。
  4. ECS / 容器：`AWS_CONTAINER_CREDENTIALS_RELATIVE_URI`(在 `http://169.254.170.2/` 上)或带可选认证 token/文件的 `AWS_CONTAINER_CREDENTIALS_FULL_URI`。
  5. EC2 IMDSv2:`169.254.169.254`(或 IPv6 `[fd00:ec2::254]`)，以 1s 超时(`IMDS_TIMEOUT_MS`)从 `latest/api/token` 请求 PUT token。
- **缓存失效与注册表状态**：在 401/403 HTTP 响应时，`streamBedrock` 调用 `invalidateAwsCredentialCache({ profile, region })` 丢弃缓存凭据，以便后续轮次重新解析新凭据。`packages/catalog/src/compat/rules/auth/amazon-bedrock.kdl`(`env hook="aws-bedrock"`)中的认证解析会求值 `hasAwsCredentialSource()`(`packages/ai/src/registry/aws.ts`)，在存在有效凭据或环境 token 时返回 `AUTHENTICATED_SENTINEL`。

### 目录模型处理
- **描述符注册**：在 `CATALOG_PROVIDERS`(`packages/catalog/src/provider-models/descriptors.ts`)中注册，默认模型为 `us.anthropic.claude-opus-4-8`。
- **models.dev 映射与跨区域配置档**:`MODELS_DEV_PROVIDER_DESCRIPTORS`(`packages/catalog/src/provider-models/openai-compat.ts`)将 `modelsDevKey: "amazon-bedrock"` 映射到 API `bedrock-converse-stream`。`bedrockCrossRegionId` 为匹配的模型添加 `global.` 或 `us.` 前缀。对于 `anthropic.claude-*` 模型，`transformModel` 会自动生成 EU(`eu.`)和 AWS GovCloud(`us-gov.`)跨区域推理配置档规范变体。非工具和遗留模型(`ai21.jamba`、`titan-text-express`、`mistral-7b`)会被过滤掉。
- **Mantle 与未记录模型排除**:Bedrock Mantle 是一个独立的 provider(`bedrock-mantle`、`openai-responses` API、`https://bedrock-mantle.{region}.api.aws/openai/v1`)，由单独的子代理覆盖。Catalog 构建策略(`packages/catalog/scripts/generated-policies.ts`)运行 `dropBedrockMantleOpenAIModels`，以从 `amazon-bedrock` 中排除 Mantle OpenAI 模型行(`openai.gpt-5.4`、`5.5`、`5.6-luna`、`sol`、`terra`)。`dropUnsupportedBedrockGeoIds` 修剪 `jp.anthropic.claude-opus-5`(在上游 models.dev 上列出，但不受支持且被 AWS Bedrock 拒绝)。
- **Prompt 缓存与思考兼容**:`buildBedrockCompat`(`packages/catalog/src/compat/bedrock.ts`)将模型 ID 映射到显式的 prompt 缓存契约(`promptCacheMode`:`explicit` 或 `none`，最小 token 阈值 512、1024、2048、4096;`supportsLongPromptCacheRetention` 1h 与 5m；最多 4 个检查点)。`inferThinkingControlMode`(`packages/catalog/src/model-thinking.ts`)将 Claude 4.6+ 自适应模型归类为 `anthropic-adaptive`(设置 `supportsDisplay: true`)，将 Opus 4.5 归类为 `anthropic-budget-effort`，将非自适应模型归类为 `budget`。定价会生成并物化到 `packages/catalog/src/models.json`。

## Amazon Bedrock Mantle

Amazon Bedrock Mantle 是 AWS 的网关端点，通过 OpenAI Responses API(`openai-responses`)协议而非 Bedrock 原生的 Converse JSON 传输(`amazon-bedrock`)提供 OpenAI 兼容模型(例如 `openai.gpt-5.4`、`openai.gpt-5.5` 以及 `openai.gpt-5.6` 的 Luna/Sol/Terra 变体)。请求面向按区域插值的端点(`https://bedrock-mantle.{region}.api.aws/openai/v1`)，使用 OpenAI Responses API 负载(`/responses`)。入口模块是 `packages/ai/src/providers/bedrock-mantle.ts`、`packages/ai/src/registry/bedrock-mantle.ts`，以及 `packages/catalog/src/provider-models/openai-compat.ts` 中的 catalog 设置。

### 特殊情况
- **端点结构**：与标准 Bedrock Converse 端点(`bedrock-runtime.{region}.amazonaws.com`)不同,Mantle 请求面向 `https://bedrock-mantle.{region}.api.aws/openai/v1`。`model.baseUrl` 中的 `{region}` 模板占位符会在请求准备阶段由 `prepareBedrockMantleRequest`(`packages/ai/src/providers/bedrock-mantle.ts`)动态替换。
- **区域解析层级**:`resolveAwsRegion`(`packages/ai/src/utils/aws-profile.ts`)中的区域替换按以下顺序求值：显式 `providerOptions.region` -> `AWS_REGION` -> `AWS_DEFAULT_REGION` -> `~/.aws/config` 中活动 AWS 共享配置文件的区域(`resolveAwsProfileRegion`)-> 回退默认 `"us-east-1"`。
- **401/403 凭据失效**：在 `createSignedFetch`(`packages/ai/src/providers/bedrock-mantle.ts`)中使用 SigV4 签名请求时,HTTP 401 或 403 响应会触发 `invalidateAwsCredentialCache({ profile, region })`(`packages/ai/src/providers/aws-credentials.ts`)，以便后续尝试从配置文件、环境或 STS 角色重新解析新凭据。
- **注册表哨兵与认证标志**:`packages/catalog/src/compat/rules/auth/bedrock-mantle.kdl` 设置 `allows-missing-api-key #true` 和 `env hook="aws-bedrock-mantle"`(传输在 `packages/ai/src/registry/bedrock-mantle.ts`)。当存在环境 AWS 凭据(`packages/ai/src/registry/aws.ts` 中的 `hasAwsCredentialSource`)时，`resolveAwsRegistryApiKey` 返回 `AUTHENTICATED_SENTINEL`。`resolveAwsBearerToken` 会剥离该哨兵值，因此除非存在真正的 bearer token，否则会选择 SigV4 认证。
- **生成器模型丢弃策略**：在 `packages/catalog/scripts/generated-policies.ts` 中，`dropBedrockMantleOpenAIModels` 从 `amazon-bedrock` provider 中过滤掉 `openai.gpt-5.*` 行(上游 `models.dev` 错误地将它们归到 Bedrock Converse 下)，从而只暴露可用的 `bedrock-mantle` Responses API 模型。

### 流行为
- **传输**：委托给 `openai-responses` provider 管线(`packages/ai/src/providers/openai-responses.ts`)，消费诸如 `response.created`、`response.text.delta`、`response.output_item.added` 和 `response.completed` 的 SSE 流事件。
- **推理与思考 effort**：通过 `BEDROCK_MANTLE_GPT_5_X_THINKING` 和 `BEDROCK_MANTLE_GPT_5_6_THINKING`(`packages/catalog/src/provider-models/openai-compat.ts`)配置，支持 effort 等级(`low`、`medium`、`high`、`xhigh`、`max`)。推理内容在 `openai-responses` 推理 delta 帧中流式传输。
- **错误处理**：非 2xx SSE 流会将错误状态码传回给流结果处理器;401/403 状态码会使 `createSignedFetch` 中缓存的 AWS 凭据状态失效。

### 认证与使用
- **双重认证模式**:
  - **Bearer token**：由 `resolveBearerToken`(`packages/ai/src/providers/bedrock-mantle.ts`)求值。当提供 `AWS_BEARER_TOKEN_BEDROCK`、`providerOptions.bearerToken` 或显式非哨兵 `apiKey` 时处于活动状态。`createBedrockMantleAuthenticatedFetch` 注入 `Authorization: Bearer <token>`。
  - **AWS SigV4 签名**：当不存在 bearer token 但环境凭据通过 `hasAwsCredentialSource` 时处于活动状态。请求头由 `signRequest`(`packages/ai/src/providers/aws-sigv4.ts`)使用服务名 `"bedrock-mantle"` 签名，设置 `Authorization: AWS4-HMAC-SHA256 ...` 和 `x-amz-security-token`(使用会话凭据时)。
- **认证优先级**：当两者都可用时,bearer token 优先于 SigV4 签名。
- **用量追踪**：输入、输出、缓存和推理 token 用量由 `openai-responses` 直接从标准 OpenAI Responses wire 负载(`usage.input_tokens`、`usage.output_tokens`、`usage.input_token_details.cached_tokens`、`usage.output_token_details.reasoning_tokens`)解析。

### 目录模型处理
- **Provider 描述符**:`packages/catalog/src/provider-models/descriptors.ts` 中的 `bedrock-mantle` 描述符设置 `defaultModel: "openai.gpt-5.6-terra"`、`envVars: ["AWS_BEARER_TOKEN_BEDROCK"]` 和 `dynamicModelsAuthoritative: true`。
- **静态种子**：预捆绑在 `BEDROCK_MANTLE_STATIC_MODELS`(`packages/catalog/src/provider-models/openai-compat.ts`)中，包含 5 个 OpenAI 模型(`openai.gpt-5.4`、`openai.gpt-5.5`、`openai.gpt-5.6-luna`、`openai.gpt-5.6-sol`、`openai.gpt-5.6-terra`)，定义上下文窗口(272,000)、最大 token(128,000)、定价结构和思考 effort 规范。
- **经认证的模型发现**:
  - `packages/ai/src/registry/bedrock-mantle.ts` 中的 `prepareModelDiscovery` 需要有效的 bearer token(`resolveAwsBearerToken`)。如果未认证或仅有 SigV4，则返回 `authenticated: false` 并跳过发现。
  - 认证后，发现会剥离 `/openai/v1`，以通过 `fetchOpenAICompatibleModels` 调用 `https://bedrock-mantle.{region}.api.aws/v1/models`。
- **权威动态模型替换**:`bedrockMantleModelManagerOptions` 中的 `dynamicModelsAuthoritative: true` 会让成功的动态发现响应**完全替换**静态种子，从而修剪掉未对 AWS 账户/token 启用的模型。
- **参考属性合并**:`mapWithBundledReference` 将静态定义的成本、思考配置和上下文窗口合并到与 `BEDROCK_MANTLE_MODEL_BY_ID` 匹配的动态发现模型定义上。

## Kimi Code
Kimi Code(`kimi-code`)和 Moonshot(`moonshot`)通过双传输执行提供对 Moonshot AI 模型家族的访问——包装 OpenAI 兼容的 chat completions(`/coding/v1/chat/completions`)和 Anthropic 兼容的 messages(`/coding/v1/messages`)。入口点是 `packages/ai/src/providers/kimi.ts`(`streamKimi`)和 `packages/ai/src/providers/openai-anthropic-shim.ts`(`streamOpenAIAnthropicShim`)，模型发现和 catalog 描述符配置在 `packages/catalog/src/provider-models/descriptors.ts` 和 `packages/catalog/src/provider-models/openai-compat.ts` 中。

### 特殊情况
- **双传输路由**:`streamKimi` 委托给 `packages/ai/src/providers/openai-anthropic-shim.ts` 中的 `streamOpenAIAnthropicShim`，从 `model.compat.kimiApiFormat` 或 `KimiOptions` 中的显式 `options.format` 选择格式。
  - `anthropic`：以 `api: "anthropic-messages"` 重建模型规范，通过 `model.baseUrl.replace(/\/v1\/?$/, "")`(`https://api.kimi.com/coding`)调整 base URL，注入 `getKimiCommonHeaders()`，将思考格式映射为 `anthropic-adaptive`，通过 `ANTHROPIC_THINKING` 计算 token 预算，并经 `streamAnthropic` 流式传输。
  - `openai`：保留 `model.baseUrl`(`https://api.kimi.com/coding/v1`)，注入 `getKimiCommonHeaders()`，传递 `reasoning` effort，并经 `streamOpenAICompletions` 流式传输。
- **MFJS 工具 schema 校验**：对原生 Moonshot 主机(`isMoonshotNative`)以及第三方代理上的 Kimi 模型 ID，在 `packages/catalog/src/compat/openai.ts`(`buildOpenAICompat`)中强制 `toolSchemaFlavor: "moonshot-mfjs"`。Moonshot 风味 JSON Schema 将单值 `const` 构造折叠为单元素 `enum` 数组，在裸 `enum` 声明上推断显式 `type`，并剥离不受支持的非标准关键字，以防止 400 schema 校验错误。
- **强制工具选择守卫**：原生 K2.7 Code 模型(`kimi-k2.7-code`、`kimi-for-coding`)和 K3 模型要求服务端思考(`packages/catalog/src/compat/anthropic.ts` 中的 `requiresThinkingEnabled = true`)。在 Anthropic 表面上，强制工具选择会降级为 `auto`。在 OpenAI 表面上(`packages/catalog/src/compat/openai.ts`),`supportsForcedToolChoice` 对强制思考的 K2.7 模型(`requiresEnabledThinking`)为 `false`，但对 K3 保持 `true`(`!isMoonshotKimiK3`)。
- **轮次与 token 不变量**:
  - `packages/catalog/src/compat/openai.ts` 中的 `alwaysSendMaxTokens: isKimiModel`:Kimi 基于 `max_tokens` 而非实际发出的 token 计算限流(TPM)，因此每个请求都要求显式的 max tokens。
  - `requiresReasoningContentForToolCalls`：对非 OpenCode provider 上的 Kimi 模型为 true(`packages/catalog/src/compat/openai.ts`)。先前的助手工具调用轮次在思考跟进中必须携带 `reasoning_content`，当原始推理缺失时允许合成占位符 `"."`(`allowsSyntheticReasoningContentForToolCalls`)。
  - `requiresAssistantContentForToolCalls`：强制助手工具调用轮次中包含非空文本内容。

### 流行为
- **带内控制标签与思考扫描**:`packages/ai/src/dialect/kimi.ts` 中的 `KimiInbandScanner` 处理原始输出流中的类 XML 工具控制标签(`<|tool_calls_section_begin|>`、`<|tool_call_begin|>`、`<|tool_call_argument_begin|>`、`<|tool_call_end|>`、`<|tool_calls_section_end|>`)和 `<think>...</think>` 思考块，发出结构化的 `InbandScanEvent` 事件(`text`、`thinkingStart`、`thinkingDelta`、`thinkingEnd`、`toolStart`、`toolEnd`)。
- **流标记修复**:`packages/catalog/src/compat/openai.ts` 中的 `streamMarkupHealingPattern: "kimi"`(`detectStreamMarkupHealingPattern`)为 `kimi-code`、`moonshot` 或 `kimi-k2` 模型 ID 修复跨 chunk 边界被截断或拆分的带内控制 token。
- **空闲看门狗超时**：对原生 K2.7 Code 模型，`packages/catalog/src/compat/openai.ts` 中的 `streamIdleTimeoutMs` 下限延长到 300s，以防在长时间初始推理生成期间过早中止流。

### 认证与使用
- **设备 OAuth 流程**：在 `packages/catalog/src/compat/rules/auth/kimi-code.kdl` 中声明为 `login "device-code"` 规则(`packages/ai/src/registry/engine/device-code.ts`)，头钩子在 `packages/ai/src/registry/oauth/kimi.ts`。使用 OAuth 2.0 设备授权授予(`urn:ietf:params:oauth:grant-type:device_code`)，客户端 ID `17e5f671-d194-4dfb-9706-5516cb48c098`，面向主机 `${resolveOAuthHost()}`(`https://auth.kimi.com`，可通过 `KIMI_CODE_OAUTH_HOST` 或 `KIMI_OAUTH_HOST` 配置)。
  - 通过 `POST /api/oauth/device_authorization` 发起，向用户呈现 `userCode` 和 `verificationUriComplete`，并对 `authorization_pending` 和 `slow_down` 退避轮询 `POST /api/oauth/token`。Token 刷新使用 `grant_type: "refresh_token"`。
- **指纹头与设备 ID**:`packages/ai/src/registry/oauth/kimi.ts` 中的 `getKimiCommonHeaders()` 注入设备追踪头：`User-Agent: KimiCLI/<ver>`、`X-Msh-Platform: kimi_cli`、`X-Msh-Version`、`X-Msh-Device-Name`、`X-Msh-Device-Model`、`X-Msh-Os-Version` 和 `X-Msh-Device-Id`。`getDeviceId` 将随机十六进制 UUID 持久化到 `path.join(getAgentDir(), "kimi-device-id")`(模式 0600)，或回退到临时的进程 UUID。
- **用量与配额追踪器**:`packages/ai/src/usage/kimi.ts` 中的 `kimiUsageProvider` 使用 OAuth bearer token 和 `getKimiCommonHeaders()`，面向 `GET /coding/v1/usages`(`https://api.kimi.com/coding/v1/usages`，可通过 `KIMI_CODE_BASE_URL` 配置)。
  - 当凭据过期(`credential.expiresAt <= nowMs`)时短路。解析 `KimiUsagePayload`：将 `usage` 对象映射为 `Total quota` 摘要行，并将 `limits` 数组(提取 `detail` 和 `window` 时长/timeUnit)映射为 `UsageLimit` 条目，通过 `parseResetTime`(`reset_at`、`resetTime`、`ttl`)解析重置时间戳。

### 目录模型处理
- **Provider 描述符**:`packages/catalog/src/provider-models/descriptors.ts` 定义：
  - `kimi-code`：默认模型 `"kimi-for-coding"`，环境变量 `KIMI_API_KEY`，通过 `kimiCodeModelManagerOptions` 进行动态发现。
  - `moonshot`：默认模型 `"kimi-k2.7-code"`，环境变量 `MOONSHOT_API_KEY` 和 `KIMI_API_KEY` 回退，通过 `moonshotModelManagerOptions` 进行动态发现(默认 base URL `https://api.moonshot.ai/v1`，可通过 `MOONSHOT_BASE_URL` 覆盖)。
- **身份分类**:`packages/catalog/src/identity/family.ts` 导出 `isKimiModelId`(匹配 `moonshotai/kimi` 或 `/(^|\/)kimi[-.]/`)、`isKimiK26ModelId`(`/kimi-k2(\.6|p6)/`)和 `isKimiK3ModelId`(`/kimi-k3/`)。`packages/catalog/src/provider-models/openai-compat.ts` 中的 `isKimiK27CodeModelId` 匹配 `/kimi-k2.7-code/`。
- **K2.x 与 K3 的推理差异**:
  - **K2.x**：原生 Moonshot K2.x 模型通过 `packages/catalog/src/compat/openai.ts` 中的 `thinkingFormat: "zai"` 使用二元思考(`thinking: { type: "enabled" | "disabled" }`)。在 `moonshotModelManagerOptions` 中配置为 4 级 effort 范围 `[Minimal, Low, Medium, High]`。K2.6 保留完整思考上下文(`thinkingKeep: "all"`)。
  - **K3**:K3 模型使用 OpenAI 风格的 `reasoning_effort`(`thinkingFormat: "openai"`)。配置为 3 级 wire 标度 `LOW_HIGH_MAX_REASONING_EFFORTS`(`[Low, High, Max]`)、`defaultLevel: Effort.Max` 和强制推理(`packages/catalog/src/model-thinking.ts` 中的 `requiresEffort: true`、`impliesMandatoryReasoning`)。`moonshotModelManagerOptions` 打上 1M 上下文窗口、131,072 maxTokens 和视觉输入(`["text", "image"]`)。
- **输出 token 上限**:`packages/catalog/src/provider-models/openai-compat.ts` 中的 `kimiCodeMaxTokens` 按家族派生输出限制：`k3` / `k3-256k` 为 131,072(`KIMI_CODE_K3_MAX_TOKENS`),`kimi-for-coding` / `kimi-for-coding-highspeed` 为 32,768(`KIMI_CODE_FOR_CODING_MAX_TOKENS`)，遗留 K2 发现行回退为 32,000(`KIMI_CODE_DEFAULT_MAX_TOKENS`)。在 catalog 生成器(`packages/catalog/scripts/generate-models.ts`)中应用。

## Ollama
Ollama 集成由 `packages/ai` 中两个不同的 provider 定义组成：用于本地 Ollama 实例的 `ollama`(通过指向本地端点 `/v1` 的 `baseUrl` 使用 `openai-responses` 或 `openai-completions` API，默认为 `http://127.0.0.1:11434/v1`)，以及用于 Ollama Cloud 的 `ollama-cloud`(在 `https://ollama.com/api/chat` 使用原生 `ollama-chat` API 传输)。入口模块是用于原生流式传输的 `packages/ai/src/providers/ollama.ts`、用于本地 Ollama catalog 选项的 `packages/catalog/src/provider-models/openai-compat.ts`(`ollamaModelManagerOptions`)，以及用于 Ollama Cloud catalog 选项的 `packages/catalog/src/provider-models/ollama.ts`(`ollamaCloudModelManagerOptions`)。

### 特殊情况
- **传输路由**：本地 `ollama` 默认使用 OpenAI 兼容路径(`openai-responses` / `openai-completions`)，而 `ollama-cloud` 使用原生 `ollama-chat` 协议。
- **思考 / 推理支持**：对于 `ollama-chat`，推理通过 `createChatBody` 中的原生 `think` 字段控制，由 `mapReasoning` 映射(`minimal`/`low` -> `"low"`,`medium` -> `"medium"`,`high`/`xhigh` -> `"high"`,`max` -> `"max"`，或设置 `disableReasoning` 时为 `false`)。Ollama Cloud 上 GLM-5.2 的 effort 等级被限制为 `high` 和 `max`(`packages/catalog/src/provider-models/ollama.ts` 中的 `OLLAMA_CLOUD_GLM_52_THINKING`)。本地 `ollama` 在 OpenAI 兼容路径上支持 `reasoning.effort`，取值为 `low`、`medium`、`high`、`max`、`none`(`packages/catalog/src/model-thinking.ts` 中的 `OLLAMA_REASONING_EFFORTS`)，并为本地 KV-cache/chat 模板保留自动启用 `replayReasoningContent: true`(`packages/catalog/src/compat/openai.ts` 中的 `LOCAL_OPENAI_COMPAT_PROVIDERS`)。
- **工具选择模拟**：当请求特定的具名工具选择(`{ type: "function", function: { name } }` 或 `{ name }`)时，`packages/ai/src/providers/ollama.ts` 中的 `selectToolsForToolChoice` 手动将 `context.tools` 过滤为该目标工具。`toolChoice` 映射将 `"none"` 映射为 `"none"`,`"required"`/`"any"`/具名对象映射为 `"required"`,`"auto"` 映射为 `undefined`。
- **Developer 角色与历史净化**：如果 developer 系统提示是初始系统提示或归属于 agent，则保留在 Ollama 的 `system` 角色上；但归属于用户的 developer 轮次会降级为 `user`，以获得稳定的前缀缓存。如果不存在 `user` 角色，`convertMessages` 会将最后一个 system 轮次降级为 `user`，以防 Ollama 在不生成输出的情况下发出 `done_reason: "load"`。对于 `ollama-cloud`，会从助手历史消息中剥离 `thinking` 字段(`convertMessages`)，因为 Ollama Cloud 会以 HTTP 400 拒绝携带 `thinking` 的传入历史。
- **Schema 净化**：工具 schema 经过 `sanitizeSchemaForOllama(toolWireSchema(tool))` 以确保兼容性。
- **模型加载 / `keep_alive` 与错误改写**：当请求不包含 user 轮次，或 Ollama 生成零 token 时,Ollama 返回 `done_reason: "load"`，映射为 stopReason `"error"` 并带 `EMPTY_OLLAMA_LOAD_COMPLETION_MESSAGE`。来自本地 llama.cpp 后端的畸形工具调用 JSON 错误(HTTP 500)由 `packages/ai/src/error/format.ts` 中的 `rewriteOllamaToolCallJsonError` 改写。`shouldRetryOllamaResponse` 会重试 5xx 错误，除非匹配 `LLAMA_CPP_TOOL_CALL_PARSE_PATTERN`。

### 流行为
- **NDJSON / JSONL 事件协议**：原生 `ollama-chat` 流是经 `readJsonl<OllamaChatChunk>` 解析的 NDJSON chunk。
- **推理与内容处理**：推理 chunk 以 `chunk.message.thinking` 到达(产出 `thinking_start`、`thinking_delta`、`thinking_end`)。内容文本以 `chunk.message.content` 到达。结构化工具调用以 `chunk.message.tool_calls` 到达。
- **流标记修复**：对文本通道的工具调用与推理恢复启用流标记修复(使用 `getStreamMarkupHealingPattern` 的 `StreamMarkupHealing`)。当存在原生 `chunk.message.thinking` 时，`suppressHealedThinking` 设为 `true`，以避免重复计算推理块。
- **完成原因映射**:`mapDoneReason` 映射 `done_reason`:`"length"` -> `"length"`,`"tool_calls"` -> `"toolUse"`,`"load"` -> `"error"`，以及带工具调用时的 `undefined` -> `"toolUse"`。产生工具调用的自然 `stop` 会提升为 `"toolUse"`。
- **看门狗与本地预填**：响应前超时通过 `armPreResponseTimeout` 以 `firstEventTimeoutMs`(派生自 `PI_STREAM_FIRST_EVENT_TIMEOUT_MS` 或 `idleTimeoutMs`)设置，同时向 `fetchWithRetry` 传入 `timeout: false`，以避免繁重的本地预填期间 Bun fetch 过早超时中止。重试使用延迟 `[2000, 5000, 10000]`。
- **空补全重试**:`streamOllama` 用 `withReplaySafeStreamRetry` 包装，以透明地重试仅 EOS 的空补全。

### 认证与使用
- **凭据来源**：在 `packages/catalog/src/compat/rules/auth/ollama.kdl` 中声明为 `login "api-key"` 规则(`packages/ai/src/registry/engine/api-key.ts`)，提示输入可选 API key(`allowEmpty: true`)，默认为无认证的本地使用，`envVars: ["OLLAMA_API_KEY"]`。`packages/catalog/src/compat/rules/auth/ollama-cloud.kdl` 强制要求在 `https://ollama.com/settings/keys` 创建的 API key,`envVars: ["OLLAMA_CLOUD_API_KEY"]`。
- **认证头**：本地请求在提供时附加 `Authorization: Bearer ${apiKey}`;`ollama-cloud` 要求 `Authorization: Bearer ${apiKey}`。
- **用量与配额**：配额追踪通过 `packages/ai/src/usage/ollama.ts` 中的 `ollamaUsageProvider` 和 `ollamaCloudUsageProvider` 注册。两者都不暴露独立的用量/配额 API(`validatesCredentials: false`，空的 `limits`)，而是依赖流完成 chunk 中返回的每响应 `prompt_eval_count`(输入)和 `eval_count`(输出)。

### 目录模型处理
- **描述符**：定义在 `packages/catalog/src/provider-models/descriptors.ts` 中：
  - `ollama`:`defaultModel: "gpt-oss:20b"`、`allowUnauthenticated: true`、`envVars: ["OLLAMA_API_KEY"]`，选项通过 `ollamaModelManagerOptions` 构建。被排除在 `generate-models.ts` 静态烘焙之外(`DISCOVERY_ONLY_PROVIDERS`)。
  - `ollama-cloud`:`defaultModel: "gpt-oss:120b"`、`envVars: ["OLLAMA_CLOUD_API_KEY"]`、`catalogDiscovery: { label: "Ollama Cloud", oauthProvider: "ollama-cloud" }`，选项通过 `ollamaCloudModelManagerOptions` 构建。
- **本地 catalog 发现**:`packages/catalog/src/provider-models/openai-compat.ts` 中的 `ollamaModelManagerOptions` 先尝试在 `/v1/models` 调用 `fetchOpenAICompatibleModels`。如果不可用，则回退到查询 `/api/tags` 的原生 `fetchOllamaNativeModels`。
- **云端 catalog 发现**:`packages/catalog/src/provider-models/ollama.ts` 中的 `ollamaCloudModelManagerOptions` 使用 `OLLAMA_CLOUD_API_KEY` 查询 `https://ollama.com` 上的 `/api/tags`。
- **经由 `/api/show` 的上下文长度与能力检测**：本地和云端发现都会为每个模型查询 Ollama 的 `/api/show`，以检查 `model_info` 和 `capabilities`。
  - 上下文长度从 `model_info` 中以 `.context_length`、`.num_ctx` 或 `.context_window` 结尾的键提取。回退上下文窗口为 `128_000`(`OLLAMA_FALLBACK_CONTEXT_WINDOW`)。
  - 能力标记：`capabilities.includes("thinking")` 设置 `reasoning: true` 并配置 `thinking` effort 配置(`[minimal, low, medium, high]`)。`capabilities.includes("vision")` 标记 `input: ["text", "image"]`。
- **输出 token 上限钳制**:Ollama Cloud 对 DeepSeek V4 Pro/Flash 模型强制 `OLLAMA_CLOUD_MAX_OUTPUT_TOKENS = 65_536`(`isOllamaCloudOutputCapped`)。`ollamaCloudModelManagerOptions` 将 `maxTokens` 钳制为 `min(contextWindow, 65536)` 并设置 `omitMaxOutputTokens: true`。`packages/ai/src/providers/ollama.ts` 中的 `resolveNumPredict` 进一步将 wire 负载上的 `num_predict` 钳制到 `65_536`。
- **缓存 Provider ID**：由 `packages/catalog/src/provider-models/cache-provider-id.ts` 中的 `resolveModelCacheProviderId` 解析，对 `ollama` 使用 `http://127.0.0.1:11434` 或端点哈希。

## Cursor

Cursor 在 `packages/ai` 中的集成通过 HTTP/2 Connect RPC 传输（`/agent.v1.AgentService/Run`）运行，发送带长度前缀的二进制 Protobuf 消息（`AgentClientMessage` 和 `AgentServerMessage`）。关键实现入口点包括：`packages/ai/src/providers/cursor.ts` 负责连接生命周期、Connect 消息流与帧调度；`packages/ai/src/providers/cursor-pi-args.ts` 负责纯参数与路径转换；`packages/ai/src/providers/cursor/exec-modern.ts` 负责本地工具结果帧构建器；认证策略位于 `packages/catalog/src/compat/rules/auth/cursor.kdl`（`login "custom" hook="cursor"`）以及 `packages/ai/src/registry/oauth/cursor.ts` 负责 PKCE 浏览器认证与令牌刷新；`packages/ai/src/usage/cursor.ts` 负责多端点配额跟踪；`packages/catalog/src/discovery/cursor.ts` 负责 Connect RPC 模型发现。

### 特殊情况
- **纯参数转换（`cursor-pi-args.ts`）**：路径与参数格式化函数（`piReadPath`、`piReadPathHasRange`、`piReadDisplayPath`、`piGrepSkip`、`piJoinPath`、`piLsPath`、`piEscapeRegexLiteral`、`piLimit`、`piTimeout`）严格保持独立于 Protobuf 导入，以便旧版 shim 可以在不将 protobuf schema 打包进虚拟注册表的情况下共享它们。
- **空 Grep 模式拒绝**：带有空 `pattern` 且 `glob` 非空的 `grepArgs` 帧会在一开始就被拒绝（`emptyGrepPatternRejection`）并给出描述性错误，迫使模型重试或切换工具，而不是在块持久化之后才触发本地工具失败。
- **原生工具与 `SoftToolRequirement` 的相互影响**：
  - 在构建 `requestContext` MCP 工具定义时，原生工具（`CURSOR_NATIVE_TOOL_NAMES`：`bash`、`read`、`write`、`delete`、`ls`、`grep`、`todo`）会被省略。
  - **例外**：只要宣告了 pi-agent 工具，`write` 就会在 `buildMcpToolDefinitions` 中被显式重新纳入。`write` 充当暂存预览（例如 `ast_edit`）的 `xd://` 传输。没有 `write`，暂存预览就无法被解析，`SoftToolRequirement('write')` 升级会中止该轮次。
- **`rootPromptMessagesJson` 与 Blob 存储**：
  - `buildGrpcRequest` 将对话历史作为 SHA-256 二进制 blob ID（`blobStore`）传入 `rootPromptMessagesJson` 和 `turns`。
  - 系统提示以各自独立的 JSON blob 存储（`buildCursorSystemPromptJsons`），使得仅当下游提示发生变化时也能命中各自独立的服务端前缀 blob 缓存。
- **思考重放保护**：
  - 助手思考内容仅在相同模型的 Kimi K3 变体（`assertCursorKimiK3HistoryReplayable`）中才会被重放到轮次历史（`canReplayCursorThinking`）。外部或隐藏的推理会被省略，以防止非 Cursor 的思考块泄漏到原生对话轮次中。

### 流行为
- **带长度前缀的 Connect 帧**：
  - Connect HTTP/2 流使用 5 字节标头（1 字节标志 + 4 字节大端 uint32 负载长度）。
  - `CONNECT_END_STREAM_FLAG`（`0b00000010`）标记携带 JSON 错误对象的终止帧（`parseConnectEndStream`）。
- **尾部与传输错误处理**：
  - 监视 HTTP/2 尾部（`grpc-status`、`grpc-message`），并使用 `mapH2TransportError` 映射套接字或 TLS 断开。
- **双向 RPC 调度**：
  - 服务端流式发送 `AgentServerMessage`（`interactionUpdate`、`execServerMessage`、`kvServerMessage`、`interactionQuery`）。
  - 客户端写入 `AgentClientMessage`（`runRequest`、每 5 秒一次的周期性 `clientHeartbeat`、`interactionResponse`）以及 `ExecClientMessage` 工具响应（`readResult`、`writeResult`、`execClientThrow`、`requestContextResult`）。
- **交互查询握手**：
  - 托管式 Web 搜索 / Exa / 未命名的 field-9 WebFetch 会发送 `interactionQuery`，并阻塞该轮次，直到客户端写入 `interactionResponse`。
  - 心跳维持 HTTP/2 存活，但并不代表语义上的进展；未获应答的查询会一直静默，直到 300 秒空闲看门狗触发（`Provider stream stalled while waiting for the next event`）。
  - `handleInteractionQuery` 批准网络权限门禁，并拒绝交互式 ask / 切换模式 / 创建计划。VM 设置保持未应答，因为它的结果 oneof 仅支持 success。
- **异步执行排空与轮次完成**：
  - `handleServerMessage` 异步处理帧，使套接字持续排空。调度会被记录在 `inFlightDispatches` 中，并在最终确定流完成之前由 `options.signal` 中止处理加以约束。
  - 流完成会校验 `turnEnded`（`sawTurnEnded`），否则抛出 `incomplete-stream`。
- **工具调用合成**：
  - `synthesizeCursorExecToolCall` 在助手输出消息上生成用于显示的 `toolCall` 块，以在 UI 与转录中镜像本地工具执行。

### 认证与使用
- **凭证与标头**：
  - 通过 `CURSOR_ACCESS_TOKEN` 进行认证，该令牌在 `Authorization: Bearer <token>` 中发送。
  - 客户端标头：`x-ghost-mode: true`、`x-cursor-client-version: cli-2026.07.23-e383d2b`、`x-cursor-client-type: cli`、`x-request-id`。
- **PKCE OAuth 与轮询**：
  - 深度链接 PKCE 登录生成 verifier/challenge，并重定向到 `https://cursor.com/loginDeepControl`。
  - 以指数退避（延迟 1 秒到 10 秒，最多 150 次尝试）轮询 `https://api2.cursor.sh/auth/poll?uuid=...&verifier=...`。
  - 刷新通过 POST `https://api2.cursor.sh/auth/exchange_user_api_key` 交换刷新令牌。
- **使用与配额跟踪（`packages/ai/src/usage/cursor.ts`）**：
  - 标准配额取自 `https://api2.cursor.sh/auth/usage`（`parseCursorUsage`）。
  - 对于带有 WorkOS 用户会话的 OAuth 凭证（`WorkosCursorSessionToken=${userId}::${accessToken}`），从 `https://cursor.com/api/usage-summary` 获取个人使用情况（`parseCursorIndividualUsage`），并从 `https://cursor.com/api/auth/me` 获取用户资料邮箱。

### 目录模型处理
- **描述符配置（`packages/catalog/src/provider-models/descriptors.ts`）**：
  - 配置了提供商 ID `"cursor"`、默认模型 `"claude-4.6-opus-high"`、运行时环境变量 `CURSOR_ACCESS_TOKEN`，以及目录发现环境变量 `CURSOR_API_KEY`。
- **缓存提供商 ID（`packages/catalog/src/provider-models/cache-provider-id.ts`）**：
  - 返回 `"cursor:max-mode-v3"` 以确保上下文窗口缓存失效。
- **模型发现（`packages/catalog/src/discovery/cursor.ts`）**：
  - `fetchCursorUsableModels` 通过 Connect RPC 调用 `GetUsableModels`（`/agent.v1.AgentService/GetUsableModels`）。
  - 从 `details.maxMode` 设置 `cursorMaxMode`，分配 `api: "cursor-agent"`，映射 1M 最大模式与 200k 默认上下文窗口，并将 `maxTokens` 默认为 64,000。
  - 动态发现会与来自 `models.json` 的捆绑参考模型合并。

## Devin
Devin 集成（`devin-agent` API）通过 HTTP/1.1 使用 Connect 协议和 gRPC/Protobuf 消息与 Codeium Cascade 后端服务通信。其实现横跨 `packages/ai/src/providers/devin.ts` 中的提供商流逻辑（`streamDevin`、`DEVIN_API_URL`）、`packages/catalog/src/compat/rules/auth/devin.kdl` 中的认证策略（`login "oauth-code"` 规则、`packages/ai/src/registry/engine/oauth-code.ts`），以及位于 `packages/catalog/src/discovery/devin-gen/exa/*` 的 Connect protobuf schema。

### 特殊情况
* **Connect 二进制协议与帧包装：** 传输在 HTTP/1.1 上使用 Connect 协议，目标为 `https://server.codeium.com`。请求负载是序列化的 Protobuf（`GetChatMessageRequestSchema`），经 gzip 压缩，并包装在 5 字节的 Connect 流式二进制帧标头中（`CONNECT_COMPRESSED_FLAG = 0x01`，4 字节大端负载长度）。流结束帧携带 `CONNECT_END_STREAM_FLAG = 0x02` 以及 JSON 错误尾部（`readConnectTrailerError`）。
* **帧大小保护：** 读取器在 `streamDevin` 中强制实施 16MB 的帧负载上限（`MAX_CONNECT_FRAME_PAYLOAD`），以便在缓冲之前拒绝损坏的帧长度标头。
* **消息格式映射：** 系统提示会被规范化（`normalizeSystemPrompts`）为顶层 `prompt` 字段。消息在 `buildChatMessagePrompts` 中格式化：
  * 用户/开发者消息映射为 `ChatMessageSource.USER`，并带有确定性消息 ID（`cascadeId\0index\0role`）。
  * 助手消息映射为 `ChatMessageSource.SYSTEM`，包含文本、`thinking`、`signature` 和 `toolCalls`。原生 Devin 助手轮次会保留 `responseId`，否则回退到 `bot-<uuid>`。
  * 工具结果映射为 `ChatMessageSource.TOOL`，包含 `toolCallId` 和 `toolResultIsError`。
* **会话线程与停止模式：** 会话线程化会将 `options.conversationId` 或 `options.sessionId` 作为 `cascadeId` 传入。默认停止模式包括 `<|user|>`、`<|bot|>`、`<|context_request|>`、`<|endoftext|>` 和 `<|end_of_turn|>`（`DEVIN_DEFAULT_STOP_PATTERNS`）。工具选择指定 `auto` 选择与临时系统提示缓存（`CacheControlType.EPHEMERAL`）；`disableParallelToolCalls` 是目录 `compat.supportsParallelToolCalls` 的反值，因此原生允许并行工具的配置可以使用它们。
* **路由器分配：** 带有 `compat.modelRouter`（当前为 `adaptive`）的目录配置是服务端调度器，不是合法的 `chatModelUid`。在开始聊天之前，`assignDevinModel` 会携带当前的用户/开发者提示与该轮次的 `cascadeId` 调用 `AssignModel`，然后在匹配的 `GetChatMessage` 请求上发送返回的 `modelUid` 以及 `modelAssignmentJwt`。缺少分配会导致该轮次失败；响应中的 `actualModelUid` 会作为 `AssistantMessage.upstreamModel` 暴露。

### 流行为
* **Protobuf 帧流式传输：** `streamDevin` 读取分块响应字节，解析 5 字节 Connect 标头。解压后的二进制负载会被解码为 `GetChatMessageResponseSchema`。
* **不透明错误恢复（`invalid_argument`）：** 带有 `invalid_argument` 错误码（例如 "internal error occurred"）的流结束尾部会在 `streamDevin` 中触发历史恢复。当符合条件的历史请求大小超过 512KB（`LARGE_HISTORY_RECOVERY_BYTES`）时，该错误会被重新归类为 `AIError.Flag.ContextOverflow`，以调用自动上下文修剪，而不是作为无效请求失败。
* **事件流转换：**
  * `deltaThinking` -> `thinking_start` / `thinking_delta`（签名从 `deltaSignature` 填充）。
  * `deltaText` -> `text_start` / `text_delta`。
  * `deltaToolCalls` -> `toolcall_start` / `toolcall_delta`。
* **节流的流式工具参数：** 流中途的参数解析使用 `parseStreamingJsonThrottled`（`toolLastParseLen`），以在流式 JSON 增量上保持 O(N) 性能，随后在 `toolcall_end` 时执行权威的 `parseStreamingJson`。
* **停止原因解析：** 将 `StopReason.MAX_TOKENS` 映射为 `length`，将活动工具调用映射为 `toolUse`，默认映射为 `stop`。

### 认证与使用
* **双重认证生命周期：**
  * **会话令牌前缀：** API 密钥凭证通过 `normalizeDevinSessionToken` 规范化，以确保带有 `devin-session-token$` 前缀。
  * **JWT 交换：** `fetchDevinAuthMetadata` 使用 `MetadataSchema` 中的 `apiKey` 向 `/exa.auth_pb.AuthService/GetUserJwt` 发送初始 Connect 请求（`GetUserJwtRequestSchema`）。服务端返回 `userJwt`（以及可选的服务器 base URL 覆盖），该值会被包含在后续聊天请求元数据中。
* **CLI OAuth 流程：** 在 `packages/catalog/src/compat/rules/auth/devin.kdl` 中声明为 `login "oauth-code"` 规则（`packages/ai/src/registry/engine/oauth-code.ts`），使用 `https://app.devin.ai/auth/cli/continue` 执行 PKCE OAuth 流程。令牌在 `https://api.devin.ai/auth/cli/token` 处交换，过期时间派生自 JWT 负载或默认回退的 1 年。
* **使用面：** 流式响应帧包含令牌计数（`msg.usage`：`inputTokens`、`outputTokens`、`cacheReadTokens`、`cacheWriteTokens`），它们直接馈入 `calculateCost(model, output.usage)`，此外还有暴露在 `usage.credits` 上的 credit 计量（`creditCost`、`committedCreditCost`、`committedAcuCost`）。账户计划与余额报告使用 `devinUsageProvider`（`packages/ai/src/usage/devin.ts`），它以原生 CLI 身份调用 `SeatManagementService/GetUserStatus`，并将 prompt/flow/flex credit 桶、带日期的每日/每周配额窗口、计划层级、超额余额以及账户/组织身份映射到 `/usage`。按 credit 计费的计划会省略无日期的百分比窗口，因此它们不会被渲染为已耗尽的配额。

### 目录模型处理
* **模型管理器配置：** `packages/catalog/src/provider-models/special.ts` 中的 `devinModelManagerOptions` 在 API 密钥可用时以 `dynamicModelsAuthoritative: true` 配置动态发现。`descriptors.ts` 在 `CATALOG_PROVIDERS` 中注册 `devin`（`DEVIN_API_KEY`、OAuth 提供商 `devin`、`defaultModel: "swe-1-6"`）。
* **静态种子：** Cascade 的目录是凭证作用域的，因此在没有 `DEVIN_API_KEY` 的情况下生成目录不会抓取到任何内容，也永远不会将提供商标记为权威——否则先前的 `models.json` 快照会被永久保留。`DEVIN_STATIC_MODELS`（`special.ts`）将两条在用的 SWE-1.6 通道（`swe-1-6-fast`、`swe-1-6`）作为 `staticModels` 播种，并由 `scripts/generate-models.ts` 无条件推送；其中的 `CREDENTIAL_SCOPED_PROVIDERS` 使 Devin 不参与生成期抓取，并丢弃其先前快照行（退役已失效的 `devin/swe-1-6-slow` 行）。配置的 `baseUrl` 会将种子重新指向该主机。
* **动态发现：** `packages/catalog/src/discovery/devin.ts` 中的 `fetchDevinModels` 调用一元 Connect RPC `GetCliModelConfigs`（`/exa.api_server_pb.ApiServerService/GetCliModelConfigs`），并携带来自 `packages/catalog/src/wire/devin.ts` 的原生 `chisel` 发现元数据以及所有受支持的显示槽位。`normalizeDevinModels` 丢弃已禁用/内部的配置，将 `ClientModelConfig` 转换为 `ModelSpec<"devin-agent">` 条目（默认 200k 上下文窗口、64k 最大令牌），并保留服务端提供的输出上限、定价维度、工具/并行工具/图像支持、描述以及 `new`/`beta`/`recommended` 徽标。例外：`DEVIN_IMAGE_BLIND_UIDS` 会从 `swe-1-6`/`swe-1-6-fast` 中剥离图像模态，这两个模型的配置宣称支持 `supports_images`，而后端会静默丢弃 `ChatMessagePrompt.images` 字段（已实测验证；其他所有模型都能读取该字段）。返回 200 但为空的目录响应会记录一条 stale-identity-pin 警告。路由器配置（`displayOption MODEL_ROUTER` 或 `isModelRouter`）会以 `compat.modelRouter` 保持独立。
* **系列折叠：** 服务端的 `modelFamilyMetadata` effort 通道会优先折叠，以规范化后的系列标签为键，并为 Fast Mode 顺序 1 拆出一个 `-fast` 兄弟项；服务端的默认成员成为折叠后规范的 `requestModelId` 与 `thinking.defaultLevel`。随后静态的 `DEVIN_VARIANT_COLLAPSE_TABLE` 处理那些在线配置缺少系列元数据的已知系列。
* **思考检测：** `supportsDevinThinking` 优先使用 `modelInfo.modelFeatures.supportsThinking`；标签正则模式（`/think|thinking|minimal|high|medium|low|xhigh|max|reasoning/i` 与 `/\bno thinking\b/i`）只是无特性时的回退。
* **Compat 解析：** `packages/catalog/src/compat/devin.ts` 中的 `buildDevinCompat` 设置 `trustExplicitThinkingOnly: true`（`ResolvedDevinCompat`），阻止隐式 effort 阶梯推断（`model-thinking.ts`）。
* **推理 Effort 路由：** Devin 模型使用兄弟模型路由，而不是线路推理字段（`variant-collapse.ts`）。`DEVIN_VARIANT_COLLAPSE_TABLE` 将模型系列（例如 `gpt-5-6-luna`、`claude-opus-5`）跨线路 effort 级别（`low`、`medium`、`high`、`xhigh`、`max`）映射到特定的路由兄弟模型 UID。
* **选择器一致性：** `DEVIN_VARIANT_COLLAPSE_TABLE.providerAliases` 镜像原生 CLI 的短标签（`opus`、`claude`/`sonnet`、`haiku`、`gemini`、`gpt`、`codex`、`swe`）以及带点的上游拼写（`gpt-5.6-terra`、`gemini-3.7-flash`、`swe-1.7-lightning`、`grok-4.6`、`glm-5.2`、`claude-haiku-4.5`）。提供商别名只能通过 `resolveVariantAlias(provider, id)` 解析——它们被有意排除在 `resolveBareVariantAlias` 与反向索引之外，因此裸的 `gpt` 或 `opus` 会保留其全局含义，无法重新绑定配置。仅在发现时折叠的系列不带有手工表别名，因此 `resolveProviderModelReference`（`packages/coding-agent/src/config/model-resolver.ts`）还会反向解析在用模型 `thinking.effortRouting` 中出现的任何原始线路 uid；精确的在用模型 ID 仍然优先。

## GitLab Duo

GitLab Duo 在 OMP 中通过两个不同的提供商集成：**GitLab Duo Non-Agentic**（`gitlab-duo`），它使用标准 HTTP/SSE 子提供商通过 GitLab AI Gateway 代理 LLM 请求；以及 **GitLab Duo Agent**（`gitlab-duo-agent`），它通过基于 WebSocket 的代理执行协议连接到 GitLab Duo Workflow Service（DWS）。`gitlab-duo` 的入口模块是 `packages/ai/src/providers/gitlab-duo.ts` 和 `packages/catalog/src/compat/rules/auth/gitlab-duo.kdl`（OAuth 钩子在 `packages/ai/src/registry/oauth/gitlab-duo.ts`），而 `gitlab-duo-agent` 在 `packages/ai/src/providers/gitlab-duo-workflow.ts`、`packages/catalog/src/compat/rules/auth/gitlab-duo-agent.kdl` 中实现，目录发现在 `packages/catalog/src/discovery/gitlab-duo-workflow.ts`。

### 特殊情况
- **`gitlab-duo` 模型路由与代理**：在 `MODEL_MAPPINGS`（`packages/ai/src/providers/gitlab-duo.ts`）中将 Duo 模型标识符（`duo-chat-opus-4-6`、`duo-chat-sonnet-4-6`、`duo-chat-gpt-5-1`、`duo-chat-gpt-5-codex` 等）映射到底层提供商类型（`anthropic` 或 `openai`）和 API 风格（`anthropic-messages`、`openai-completions`、`openai-responses`）。请求会使用通过 `getDirectAccessToken` 交换的直接访问令牌代理到 GitLab AI Gateway 端点（`https://cloud.gitlab.com/ai/v1/proxy/anthropic/` 或 `https://cloud.gitlab.com/ai/v1/proxy/openai/v1`）。
- **`gitlab-duo-agent` ChatML 目标生成**：将 OMP 对话历史（`context.messages`）转换为单个扁平化的已渲染 ChatML 提示字符串（`packages/ai/src/providers/gitlab-duo-workflow.ts` 中的 `buildGitLabDuoWorkflowGoal`、`renderGitLabDuoWorkflowChatMl`、`buildGitLabDuoWorkflowInlineFlowConfig`）。由 `gitlab-duo-workflow-chatml-note.md` 中的系统提示指令指导。
- **`gitlab-duo-agent` 内联流规范**：发送环境内联工作流定义（`buildGitLabDuoWorkflowInlineFlowConfig`），其中包含名为 `"omp_agent"` 的 `AgentComponent`，在其模板中携带 OMP 的系统提示，用户模板为 `{{goal}}`，并带有 UI 日志事件（`on_agent_reasoning`、`on_agent_final_answer`、`on_tool_execution_success`、`on_tool_execution_failed`）。
- **`gitlab-duo-agent` 字节预算与溢出**：强制实施目标字节上限（`GITLAB_DUO_WORKFLOW_GOAL_SOFT_OVERFLOW_BYTES` = 1MB、`GITLAB_DUO_WORKFLOW_GOAL_HARD_OVERFLOW_BYTES` = 2MB）。超出上限的目标会触发溢出错误消息（`buildGitLabDuoWorkflowGoalOverflowMessage`），在会话循环中驱动自动上下文压缩。
- **`gitlab-duo-agent` 工具执行协议**：将 OMP 工具映射为 MCP 工具定义（`buildGitLabDuoWorkflowMcpTools`、`GitLabMcpToolDefinition`），并在 `startRequest.mcpTools` 中发送。通过 WebSocket 接收的工具调用请求（`runMCPTool`、`run_mcp_tool`）会被提取（`extractGitLabDuoWorkflowAction`），分派到 OMP 工具执行（`mapGitLabDuoWorkflowActionToOmpTool`、`emitGitLabDuoWorkflowActionToolCall`），并通过 `buildGitLabDuoWorkflowActionResponse` 返回。
- **`gitlab-duo-agent` 命名空间设置自动启用**：REST 设置例程会调用 `ensureGitLabDuoWorkflowSettings`，将 `buildGitLabDuoWorkflowSettingsBody` POST 到 `/api/v4/ai/duo_workflows/settings`，以启用所需的命名空间标志（`duo_workflow`、`duo_workflow_service`、`duo_agent_platform`）。

### 流行为
- **`gitlab-duo` 委托流式传输**：在 `streamGitLabDuo`（`packages/ai/src/providers/gitlab-duo.ts`）中直接调用 `streamAnthropic`、`streamOpenAICompletions` 或 `streamOpenAIResponses`，在注入直接访问标头（`Authorization: Bearer <direct_access_token>`）后逐字转发底层 SSE 事件。
- **`gitlab-duo-agent` WebSocket 代理循环**：通过 WebSocket（`wss://<instance>/api/v4/ai/duo_workflows/ws` 或 DWS runway 主机 `buildGitLabDuoWorkflowWebSocketUrl`）连接。接收由 `parseGitLabDuoWorkflowSocketData` 解析并在 `runGitLabDuoWorkflowSocket`（`packages/ai/src/providers/gitlab-duo-workflow.ts`）中处理的原始 JSON 事件。
- **`gitlab-duo-agent` 事件处理与推理**：提取工作流检查点（`extractGitLabDuoWorkflowCheckpoint`），发出从 `on_agent_reasoning` UI 日志事件派生的增量文本（`emitGitLabDuoWorkflowText`）和思维链推理（`emitGitLabDuoWorkflowThinking`）。
- **`gitlab-duo-agent` 审批与完成信号**：监视工作流审批状态（`isGitLabWorkflowApprovalStatus`：`PLAN_APPROVAL_REQUIRED`、`TOOL_CALL_APPROVAL_REQUIRED`）和完成状态（`isGitLabWorkflowCompletionStatus`：`INPUT_REQUIRED`、`FINISHED`）。
- **`gitlab-duo-agent` 超时与健康截止时间**：在 WebSocket 上实施 90 秒空闲截止时间（`GITLAB_DUO_WORKFLOW_IDLE_TIMEOUT_MS`）。套接字不活动会触发中止，并在现有 `workflowID` 上恢复。REST 设置调用受 30 秒超时约束（`GITLAB_DUO_WORKFLOW_REST_TIMEOUT_MS`）。
- **`gitlab-duo-agent` 有界重启**：
  - 步骤上限超限：当服务端报告达到最大步骤上限（`isGitLabDuoWorkflowStepLimitMessage`）时，在新工作流上最多重启 4 次（`GITLAB_DUO_WORKFLOW_MAX_STEP_LIMIT_RESTARTS`）。
  - 通用错误：对于瞬时处理故障（`isGitLabDuoWorkflowGenericProcessingError`），最多重试 1 次（`GITLAB_DUO_WORKFLOW_MAX_GENERIC_ERROR_RETRIES`）。
  - 停滞检测：当 `detectGitLabDuoWorkflowStall` 在工具边界（`lastToolBoundaryContentLength`）检测到连续未变化的检查点内容长度时，最多重启 2 次（`GITLAB_DUO_WORKFLOW_MAX_STALL_RESTARTS`）。

### 认证与使用
- **`gitlab-duo` 认证**：支持通过 `GITLAB_TOKEN` 使用 PAT，或在 `packages/catalog/src/compat/rules/auth/gitlab-duo.kdl` 中声明的 OAuth（`login "oauth-code"`，引擎 `packages/ai/src/registry/engine/oauth-code.ts`），缓存清理钩子位于 `packages/ai/src/registry/oauth/gitlab-duo.ts`。直接访问令牌通过 `POST /api/v4/ai/third_party_agents/direct_access` 并携带 `DuoAgentPlatformNext: true` 获取（`packages/ai/src/providers/gitlab-duo.ts` 中的 `getDirectAccessToken`），并缓存 25 分钟（`DIRECT_ACCESS_TTL_MS`）。OAuth 使用 PKCE 与 `DEFAULT_CLIENT_ID`（可通过 `GITLAB_CLIENT_ID` / `GITLAB_REDIRECT_URI` 覆盖）以及回调端口 8080。
- **`gitlab-duo-agent` 认证**：通过 `GITLAB_TOKEN` 接受 PAT，或在 `packages/catalog/src/compat/rules/auth/gitlab-duo-agent.kdl` 中声明为 `login "oauth-code"` 规则的 OAuth（`packages/ai/src/registry/engine/oauth-code.ts`）。直接访问工作流令牌通过 `POST /api/v4/ai/duo_workflows/direct_access`（`requestGitLabDuoWorkflowDirectAccess`）获取。OAuth 依赖官方 GitLab VS Code 客户端 ID（`GITLAB_DUO_WORKFLOW_OAUTH_CLIENT_ID = "36f2a70cddeb5a0889d4fd8295c241b7e9848e89cf9e599d0eed2d8e5350fbf5"`），重定向到 `vscode://gitlab.gitlab-workflow/authentication`（`pasteCodeFlow: true`）。
- **`gitlab-duo-agent` 协议标头**：请求包含 `x-gitlab-client-type: node-websocket`、`x-gitlab-language-server-version: 8.104.0`，以及由 `buildGitLabDuoWorkflowWebSocketHeaders` 构造的资源作用域标头（`x-gitlab-project-id`、`x-gitlab-namespace-id`、`x-gitlab-root-namespace-id`）。
- **使用跟踪**：两个提供商都不使用 `packages/ai/src/usage/` 下的模块。对于 `gitlab-duo-agent`，上下文占用从服务端检查点遥测提取（`extractGitLabDuoWorkflowContextUsage` 读取 `agent_context_usage`），优先考虑 `"Chat Agent"` 和 `"context_builder"` 条目，并在 `applyGitLabDuoWorkflowContextUsage` 中应用于提示令牌估算。

### 目录模型处理
- **提供商描述符**：在 `packages/catalog/src/provider-models/descriptors.ts` 中定义：
  - `gitlab-duo`：默认模型 `duo-chat-opus-4-6`，`envVars: ["GITLAB_TOKEN"]`。模型通过 `getGitLabDuoModels()` 静态构建。
  - `gitlab-duo-agent`：默认模型 `claude_sonnet_4_6_vertex`，`envVars: ["GITLAB_TOKEN"]`，`dynamicModelsAuthoritative: true`，管理器选项由 `packages/catalog/src/provider-models/special.ts` 中的 `gitLabDuoWorkflowModelManagerOptions` 构建。
- **命名空间自动发现**：`discoverGitLabDuoWorkflowNamespace`（`packages/catalog/src/discovery/gitlab-duo-workflow.ts`）从显式覆盖、配置或工作区 Git 远程（`discoverGitLabDuoWorkflowProject`）定位根命名空间。模型通过 GraphQL 查询 `aiChatAvailableModels(rootNamespaceId:)`（`fetchGitLabDuoWorkflowModels`）发现。
- **上下文窗口解析**：`packages/catalog/src/discovery/gitlab-duo-workflow.ts` 中的 `resolveGitLabDuoWorkflowContextWindow` 从模型引用推断上下文窗口大小（Claude Opus/Sonnet：1,000,000；Haiku：200,000；GPT-5：400,000；默认：200,000）。
- **缓存分区**：`gitLabDuoWorkflowModelCacheProviderId`（`packages/catalog/src/provider-models/special.ts`）通过对 `apiKey`、`baseUrl`、`namespaceId`、`projectId` 和工作区 `cwd` 做哈希来分区动态目录缓存键。
- **目录生成规则**：`scripts/generate-models.ts` 将 `gitlab-duo-agent` 排除在静态生成发现之外，以防将单账户命名空间模型打包进静态目录，只捆绑 `buildGitLabDuoWorkflowFallbackModel` 作为通用回退种子。

## Pi Native
Pi Native 是一种无损的内部服务端/客户端传输协议，用于 pi-ai 客户端（例如容器化的 `omp` 或 sidecar 代理槽位）将请求执行委托给持有真实提供商凭证的 `omp auth-gateway`。当 `Model` 设置 `transport: "pi-native"` 时激活，`packages/ai/src/stream.ts` 中的 `streamSimple` 会短路本地提供商解析，并将规范 `Context` 直接 POST 到 `/v1/pi/stream`。主要入口模块是客户端侧的 `packages/ai/src/providers/pi-native-client.ts`（`streamPiNative`）、线路帧侧的 `packages/ai/src/providers/pi-native-server.ts`（`parseRequest`、`encodeStream`、`formatError`），以及服务端侧的 `packages/ai/src/auth-gateway/server.ts`（`POST /v1/pi/stream` 路由处理程序）。

### 特殊情况
- **无损直通与方言缺失**：与 OpenAI/Anthropic 路由不同，`pi-native` 不是文本化的工具调用方言（`docs/toolconv/pi-native.md`）。工具调用保持为 `Context` 和 `AssistantMessageEvent` 内部的规范 pi-ai `ToolCall` 内容块。它保留 pi-ai 的一等字段（服务层级、缓存标记、思考预算、工具选择变体、图像块、工具调用 ID），而无需外部线路量化。
- **线路请求与最小边界校验**：客户端将 `{ modelId: "${provider}/${id}", context, options, stream: true }` POST 到 `${model.baseUrl}/v1/pi/stream`（`packages/ai/src/providers/pi-native-client.ts` `resolveStreamUrl`）。`packages/ai/src/providers/pi-native-server.ts` `parseRequest` 接受 `modelId`、`model.id` 或字符串 `model`（支持 `streamProxy` 目标替换）。校验只检查对象形状与数组（`context.messages`、可选的 `context.systemPrompt`、`context.tools`），消息/工具内部在下游提供商执行之前不做校验。
- **选项允许列表与非线路键剥离**：服务端在 `packages/ai/src/providers/pi-native-server.ts` `parseRequest` 中依据 `ALLOWED_OPTION_KEYS`（31 个键）过滤 `options`，为跨版本兼容静默丢弃未知键。客户端通过 `packages/ai/src/providers/pi-native-client.ts` `buildWireOptions` 中的 `NON_WIRE_KEYS` 剥离仅运行时与函数值的字段（`signal`、`apiKey`、`fetch`、`onPayload`、`onResponse`、`onSseEvent`、`execHandlers`、`cursorExecHandlers`、`cursorOnToolResult`、`providerSessionState`）。
- **网关选项修改**：在 auth-gateway（`packages/ai/src/auth-gateway/server.ts`）上，对 `openai-codex-responses` 模型剥离采样控制项（`temperature`、`topP`、`topK`、`minP`、`stopSequences`、惩罚项）以避免 400 错误，并捕获直通请求标头（`captureRequestHeaders`）并合并到客户端标头之下。
- **调度优先级与缓存绕过**：在 `packages/ai/src/stream.ts` `streamSimple` 中，`model.transport === "pi-native"` 优先于扩展注册的自定义 API（`getCustomApi`）。`packages/ai/src/stream.ts` `assertExplicitOpenAIResponsesPromptCacheSupport` 对 `pi-native` 传输显式绕过提示缓存断言，因为校验被推迟到网关解析出的模型。

### 流行为
- **逐字 SSE 帧**：服务端的 `encodeStream`（`packages/ai/src/providers/pi-native-server.ts`）将每个规范 `AssistantMessageEvent` 逐字流式输出为 JSON 序列化的 SSE 帧（`data: ${JSON.stringify(event)}\n\n`），并以 `data: [DONE]\n\n` 终止。客户端（`packages/ai/src/providers/pi-native-client.ts` `streamPiNative`）使用 `readSseJson`，并将事件直接推入 `AssistantMessageEventStream`。
- **二次方部分帧**：Delta 事件包含滚动的 `partial: AssistantMessage` 快照，使线路带宽随轮次长度呈 O(N²)。对于提供商延迟占主导的回环 / sidecar 拓扑，这一开销是可接受的。
- **空闲与首事件看门狗**：客户端使用 `iterateWithIdleTimeout` 以 `PI_STREAM_FIRST_EVENT_TIMEOUT_MS` 和 `PI_STREAM_IDLE_TIMEOUT_MS` 包装 SSE 流。`packages/ai/src/providers/pi-native-client.ts` 中的 `isPiNativeProgressEvent` 忽略 `type: "start"` 事件，因此初始设置不会重置空闲超时。
- **合成终止边界**：如果 SSE 流在没有 `done` 或 `error` 事件的情况下关闭，客户端的 `streamPiNative` 会通过 `makeSyntheticAssistant` 构造一条合成助手消息。如果调用方已中止，它会推送 `{ type: "error", reason: "aborted", error: { ..., stopReason: "aborted", errorMessage: "stream closed without terminal event" } }`；若是不优雅的干净关闭，则推送 `{ type: "done", reason: "stop", message: { ..., stopReason: "stop" } }`。
- **服务端迭代器异常回退**：如果服务端的 `encodeStream` 事件迭代器抛出异常，它会先入队 `data: {"type":"error","reason":"error","errorMessage":"..."}\n\n`，随后是 `data: [DONE]\n\n`，以便客户端迭代器得以完成而不是挂起。
- **思考循环防护**：`packages/ai/src/stream.ts` `streamSimple` 用 `withThinkingLoopGuard` 和 `withProviderInFlightLimit` 包装 `streamPiNative`，确保 Gemini、DeepSeek 和 Grok 失控的思考流以空内容可重试错误中止。

### 认证与使用
- **Bearer 令牌授权**：客户端（`packages/ai/src/providers/pi-native-client.ts` `buildHeaders`）在 `Authorization: Bearer <apiKey>` 中传入 `options.apiKey`（网关 bearer 令牌），除非显式提供了 `model.headers.Authorization`。
- **网关凭证解析**：服务端路由处理程序（`packages/ai/src/auth-gateway/server.ts`）首先校验网关 bearer。缺失/无效的令牌通过 `packages/ai/src/providers/pi-native-server.ts` `formatError` 返回 `401`。有效请求会实例化 `buildGatewayApiKeyResolver`，以使用 `sessionId`/`promptCacheKey` 和格式 `"pi-native"` 从 `AuthStorage` 获取目标提供商凭证。
- **错误信封与网关映射**：服务端通过 `formatError` 以 `{ error: { type, message } }` 发出错误，并带有 HTTP 状态、`application/json` 和 `Cache-Control: no-store`。客户端的 `decodeGatewayError` 将非 2xx 响应转换为 `AIError.AuthGatewayError`，保留 HTTP 状态、标头与错误 `type`。
- **使用与标头跟踪**：令牌使用量（`input`、`output`、`cacheRead`、`cacheWrite`、`cost`）直接携带在规范 `AssistantMessage` 事件中。客户端通过 `notifyProviderResponse` 通知响应元数据（`x-request-id`、标头）。

### 目录模型处理
- **无目录提供商条目**：`pi-native` 不是 `packages/catalog` 中的提供商（不在 `descriptors.ts` `CATALOG_PROVIDERS`、`src/provider-models/*`、`src/identity/classify.ts`、`src/model-thinking.ts` 和 `scripts/generate-models.ts` 中）。
- **传输覆盖属性**：仅在 `packages/catalog/src/types.ts` 的 `Model` 接口上定义为 `transport?: "pi-native"`。
- **本地目录解析**：元数据（定价、上下文窗口、最大令牌、`ThinkingConfig` 中的思考配置、能力标志、提供商优先级）从本地目录模型定义（例如 `anthropic/claude-3-5-sonnet`）解析，而执行调度则路由到网关 `baseUrl`。

---

# 目录提供商

每个 `CATALOG_PROVIDERS` 条目（`packages/catalog/src/provider-models/descriptors.ts`）只要本身不是传输，就按提供商 ID 字母顺序每个提供商一节。这些提供商基于上文记录的某种传输运行；每节只涵盖该提供商在其之上新增的内容：特殊情况、认证与使用/配额跟踪，以及目录接线。ID 本身即传输的提供商（anthropic、openai、openai-codex、azure、google、google-vertex、amazon-bedrock、bedrock-mantle、cursor、devin）由前半部分的传输章节覆盖。共享引擎提供商（google-gemini-cli、google-antigravity、gitlab-duo、gitlab-duo-agent、kimi-code、moonshot、ollama、ollama-cloud）两者都写：上面的引擎机制，以及下面按 ID 的认证/使用/目录接线。

## ai& (`aiand`)
ai& (`aiand`) 是一个 OpenAI 兼容的推理 API 提供商（aiand.com），提供开放权重与旗舰 LLM，具备动态模型目录发现、推理 effort 元数据和令牌使用定价。传输：OpenAI Chat Completions。

### 特殊情况
- **Base URL 规范化**：`packages/catalog/src/provider-models/openai-compat.ts` 中的 `normalizeAiandBaseUrl` 会修剪 base URL，默认为 `https://api.aiand.com/v1`，去除尾部斜杠，并在省略时追加 `/v1`。除此之外没有超出 OpenAI Chat Completions 管道的内容。

### 认证与使用
- **API 密钥认证**：支持通过 `AIAND_API_KEY` 环境变量配置的 API 密钥认证（通过 `packages/ai/src/stream.ts` 中的 `getEnvApiKey("aiand")` 解析）或显式的 `apiKey` 选项。
- **控制台登录与校验**：在 `packages/catalog/src/compat/rules/auth/aiand.kdl` 中声明为 `login "api-key"` 规则（`packages/ai/src/registry/engine/api-key.ts`），提示输入来自 `https://console.aiand.com/api-keys` 的 API 密钥，并针对 `https://api.aiand.com/v1/models` 校验凭证（`validate "models-endpoint"`）。注册于 `packages/ai/src/registry/registry.ts`。

### 目录模型处理
- **提供商描述符**：在 `packages/catalog/src/provider-models/descriptors.ts` 中注册，带有 `defaultModel: "moonshotai/kimi-k2.7-code"`、`envVars: ["AIAND_API_KEY"]` 和 `dynamicModelsAuthoritative: true`。
- **静态种子模型**：`packages/catalog/src/provider-models/openai-compat.ts` 中的 `AIAND_STATIC_MODELS` 提供 9 个捆绑的离线模型规范（`qwen/qwen3.6-27b`、`deepseek-ai/deepseek-v4-flash`、`google/gemma-4-31b-it`、`openai/gpt-oss-120b`、`deepseek-ai/deepseek-v4-pro`、`moonshotai/kimi-k2.7-code`、`moonshotai/kimi-k2.6`、`zai-org/glm-5.2`、`zai-org/glm-5.1`），通过 `createAiandStaticModel` 创建，并带有 effort 推理阶梯（`[low, medium, high]`，默认 `medium`）。当权威在线目录生成被禁用时，种子模型会在 `scripts/generate-models.ts` 中被推送。
- **权威发现**：`packages/catalog/src/provider-models/openai-compat.ts` 中的 `aiandModelManagerOptions` 设置 `dynamicModelsAuthoritative: true`，并通过 `dropCachedModelIdsOnStaticMismatch: AIAND_STATIC_MODEL_IDS` 使静态 ID 失效。当提供了 `apiKey` 时，`fetchDynamicModels` 使用 `fetchOpenAICompatibleModels` 与 `mapAiandModel` 查询 `/v1/models`。
- **思考配置（`mapAiandThinking`）**：`mapAiandThinking` 通过 `AIAND_EFFORT_BY_WIRE_VALUE`（`minimal`、`low`、`medium`、`high`、`xhigh`、`max`）将线路字符串数组 `reasoning_efforts` 转换为 pi `Effort` 级别，并在有效时从 `reasoning_effort_default` 设置 `defaultLevel`。如果 efforts 为空，则返回 `undefined`。
- **成本映射（`mapAiandCost`）**：`mapAiandCost` 通过 `toPositiveNumber` 提取 `input_per_1m` 和 `output_per_1m` 的 USD 令牌价格。非 USD 的组织计费货币（例如 `currency !== "usd"`）回退为 `{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }`，以避免成本模型被破坏。
- **模型属性映射（`mapAiandModel`）**：`mapAiandModel` 映射模型描述或名称（`toModelName`），检查 `capabilities` 中的 `"reasoning"`（附加 `thinking`）与 `"vision"`（设置 `input: ["text", "image"]`），并解析 `context_window`。

## AIML API (`aimlapi`)
AIML API 是一个 AI 模型聚合平台，通过统一的 OpenAI 兼容端点提供对多种多厂商模型的访问。它使用 OpenAI Chat Completions（`openai-completions`）传输管道。

### 特殊情况
- **非聊天模型过滤**：动态模型列表通过 `isLikelyAimlApiChatModelId`（`packages/catalog/src/provider-models/openai-compat.ts`）过滤，排除由正则 `/(?:^|[/:._-])(?:audio|embed|embedding|embeddings|i2i|i2v|image|speech|t2i|t2v|tts|video)(?:$|[/:._-])/i` 或子串（`dall-e`、`dalle`、`flux`、`imagen`、`sora`、`veo`、`whisper`）匹配的音频、嵌入、图像、视频和 TTS 模型。
- **标准传输管道**：使用未经定制的 `openai-completions` 传输，没有自定义请求转换器或错误处理程序（`packages/catalog/src/provider-models/openai-compat.ts`）。

### 认证与使用
- **环境认证**：配置为通过 `AIMLAPI_API_KEY` 环境变量发现凭证（`packages/catalog/src/provider-models/descriptors.ts`、`packages/catalog/src/compat/rules/auth/aimlapi.kdl`）。
- **API 授权**：将密钥作为 HTTP `Authorization: Bearer <key>` 标头发送到目标主机 `https://api.aimlapi.com/v1`。
- **使用跟踪**：在 `packages/ai/src/usage/` 中没有注册专门的配额或使用解析模块。

### 目录模型处理
- **描述符注册**：在 `PROVIDER_DESCRIPTORS` 中定义，带有 `defaultModel: "gpt-5.5-2026-04-23"`、`dynamicModelsAuthoritative: true` 和标签 `"AIML API"`（`packages/catalog/src/provider-models/descriptors.ts`）。
- **动态发现**：通过 `packages/catalog/src/provider-models/openai-compat.ts` 中的 `aimlApiModelManagerOptions()` 管理，它会抓取 `https://api.aimlapi.com/v1/models`，并通过 `filterModel`（`isLikelyAimlApiChatModelId`）和 `mapWithBundledReference` 映射候选项。
- **规范解析**：多厂商命名空间模型（例如 `alibaba/qwen3-32b`、`x-ai/grok-4-3`）通过 `buildModelProviderPriorityRank` 解析规范参数默认值，其中 `aimlapi` 参与跨提供商身份查找（`packages/catalog/src/identity/priority.ts`、`packages/catalog/test/canonical-limit-fallback.test.ts`）。

## Alibaba Coding Plan (`alibaba-coding-plan`)
Alibaba Coding Plan 提供托管在阿里云 DashScope 平台上的面向编码的模型端点。它使用 `OpenAI Chat Completions` 传输（`openai-completions`）连接到国际（`https://coding-intl.dashscope.aliyuncs.com/v1`）或中国大陆（`https://coding.dashscope.aliyuncs.com/v1`）端点。

### 特殊情况
- **结构化 API 密钥解析**：在 `packages/ai/src/providers/openai-shared.ts` 中，当启用 `alibabaCodingPlanAuth`（`packages/ai/src/providers/openai-completions.ts`）时，JSON 格式的 API 密钥（由登录/OAuth 存储发出）会被解析，以提取 bearer `token` 并通过 `enterpriseUrl` 覆盖 `baseUrl`。
- **低优先级选择**：包含在 `LOW_PRIORITY_PROVIDERS`（`packages/catalog/src/identity/priority.ts`）中，防止 `alibaba-coding-plan` 模型在模糊的自动角色选择中压过主要提供商。
- **主机分类**：归入 `packages/catalog/src/hosts.ts` 中的 `alibabaDashscope` 主机条目（`urlMarkers: ["dashscope", "token-plan."]`）。
- **OAuth 结构化密钥标志**：在 `needsStructuredApiKey`（`packages/ai/src/registry/oauth/index.ts`）中注册，以将端点与令牌元数据（`enterpriseUrl`、`access`、`refresh`、`expires`）序列化为 JSON 密钥字符串。

### 认证与使用
- **交互式登录与端点选择**：在 `packages/catalog/src/compat/rules/auth/alibaba-coding-plan.kdl` 中声明（`login "custom" hook="alibaba-coding-plan"`），并在 `packages/ai/src/registry/oauth/alibaba-coding-plan.ts`（`loginAlibabaCodingPlan`）中实现，提示用户在 International（`https://coding-intl.dashscope.aliyuncs.com/v1`）、Mainland China（`https://coding.dashscope.aliyuncs.com/v1`）或自定义代理 base URL 之间选择。
- **API 密钥校验**：通过 `apiKeyValidation.validateOpenAICompatibleApiKey`（`packages/ai/src/registry/api-key-validation.ts`）对预设端点针对模型 `qwen3.5-plus` 校验凭证，自定义 URL 则使用 `validateApiKeyAgainstModelsEndpoint`（`packages/ai/src/registry/oauth/alibaba-coding-plan.ts`）。
- **环境变量**：API 密钥通过 `ALIBABA_CODING_PLAN_API_KEY` 获取（`packages/catalog/src/provider-models/descriptors.ts`）。
- **使用与配额跟踪**：与 `alibaba-token-plan` 不同，`alibaba-coding-plan` 在 `packages/ai/src/usage/` 中没有专门的使用提供商或配额跟踪。

### 目录模型处理
- **模型管理器选项**：`alibabaCodingPlanModelManagerOptions`（`packages/catalog/src/provider-models/openai-compat.ts`）通过 `createOpenAICompatibleModelManagerOptions` 创建管理器选项，配置为 `providerId: "alibaba-coding-plan"`、`defaultBaseUrl: "https://coding-intl.dashscope.aliyuncs.com/v1"` 和 `mapWithBundledReference`。
- **描述符与默认值**：注册的描述符（`packages/catalog/src/provider-models/descriptors.ts`）设置 `defaultModel: "qwen3.7-plus"`。
- **模型来源**：模型规范捆绑在 `packages/catalog/src/models.json` 中的 `"alibaba-coding-plan"` 下。

### 流行为
- **扩展的流空闲超时**：将 `streamIdleTimeoutMs` 设置为 600,000 毫秒（`packages/catalog/src/compat/openai.ts` 中的 `ALIBABA_CODING_PLAN_STREAM_IDLE_TIMEOUT_MS = 600_000`），以防止在首个 SSE 事件之前的长时间初始生成延迟期间，流看门狗过早中止。

## QwenCloud Token Plan (`alibaba-token-plan`)
QwenCloud Token Plan 提供对阿里云 Qwen 和 DeepSeek 模型套件的模型订阅访问。它通过 HTTP POST JSON 和 Server-Sent Events（SSE）流式传输，使用 OpenAI Chat Completions 传输（`openai-completions` API schema）（`packages/ai/src/providers/openai-shared.ts`）。

### 特殊情况
- **显式凭证隔离**：`resolveOpenAIRequestSetup`（`packages/ai/src/providers/openai-shared.ts`）要求显式的 `ALIBABA_TOKEN_PLAN_API_KEY` 或 `BAILIAN_TOKEN_PLAN_API_KEY` 凭证，并显式禁用通用的 `$env.OPENAI_API_KEY` 回退，以防止密钥泄漏到 QwenCloud 端点。
- **区域 Base URL 路由**：凭证支持区域锁定的端点：International Singapore（`ALIBABA_TOKEN_PLAN_BASE_URL` = `https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1`）和 China Beijing（`ALIBABA_TOKEN_PLAN_CN_BASE_URL` = `https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1`）。区域密钥不可互换；存储的 `baseUrl` 会为推理与模型发现覆盖目录默认值（`packages/catalog/src/provider-models/openai-compat.ts`）。
- **存储去重**：`hasAuthCredentialForProvider`（`packages/ai/src/auth/sqlite-credential-store.ts`）解析 JSON 复合凭证（`parseAlibabaTokenPlanCredential`），以比较内部的 `token` 字符串，而不是原始 JSON 文本。

### 认证与使用
- **环境与线路凭证**：依次解析 `ALIBABA_TOKEN_PLAN_API_KEY` 和 `BAILIAN_TOKEN_PLAN_API_KEY`。支持纯 bearer 密钥（`sk-sp-...`）或序列化 JSON 字符串（`{ token, cookie?, baseUrl? }`），前者通过 `parseAlibabaTokenPlanCredential` 解析，后者通过 `serializeAlibabaTokenPlanCredential` 格式化（`packages/catalog/src/wire/alibaba-token-plan.ts`）。
- **交互式登录**：在 `packages/catalog/src/compat/rules/auth/alibaba-token-plan.kdl` 中声明（`login "custom" hook="alibaba-token-plan"`），并在 `packages/ai/src/registry/oauth/alibaba-token-plan.ts`（`loginAlibabaTokenPlan`）中实现，提示选择区域（1=International，2=China Beijing，3=Custom URL），通过 `${baseUrl}/models` 校验 API 密钥（`validateApiKeyAgainstModelsEndpoint`），并接受可选的 `cs-data.qwencloud.com` 浏览器 `Cookie` 标头用于配额报告。
- **控制台配额抓取**：`alibabaTokenPlanUsageProvider`（`packages/ai/src/usage/alibaba-token-plan.ts`）使用存储的 `Cookie` 标头从 `https://home.qwencloud.com/tool/user/info.json` 抓取 `secToken`，并向 `https://cs-data.qwencloud.com/data/api.json?product=sfm_bailian&action=IntlBroadScopeAspnGateway&api=zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/usage` 发起带 URL 编码参数的 POST。
- **配额窗口与排序**：解析 `per5HourPercentage`/`per5HourResetTime`（5 小时窗口，`credits:5h`）和 `per1WeekPercentage`/`per1WeekResetTime`（7 天窗口，`credits:7d`）。`alibabaTokenPlanRankingStrategy` 将 `credits:5h` 配置为主限制（5h 窗口），将 `credits:7d` 配置为次要限制（7d 窗口）。

### 目录模型处理
- **权威发现**：配置了 `dynamicModelsAuthoritative: true`（`packages/catalog/src/provider-models/descriptors.ts`）。`/models` 发现是订阅作用域的；成功的端点响应即为权威，即使为空也会覆盖静态回退目录（`packages/catalog/scripts/generate-models.ts`）。
- **发现过滤与覆盖**：`isAlibabaTokenPlanChatModelId`（`packages/catalog/src/provider-models/openai-compat.ts`）过滤非聊天前缀（`qwen-audio-`、`qwen-image-`、`text-embedding-`、`wan2.7-`）。发现到的 `deepseek-v4*` 模型会以 `reasoning: true` 和 effort 思考（`[Effort.High, Effort.Max]`）映射。
- **静态目录回退**：`ALIBABA_TOKEN_PLAN_STATIC_MODELS` 在无凭证或发现失败时提供静态目录种子回退（`packages/catalog/scripts/generate-models.ts`）。

## Baseten (`baseten`)
Baseten 为托管开放权重 LLM（包括 Moonshot Kimi、DeepSeek、Zhipu GLM 和 gpt-oss 系列）提供高性能基础设施。请求通过 OpenAI Chat Completions 传输（`openai-completions` API）执行，目标为默认 base URL `https://inference.baseten.co/v1`。

### 特殊情况
- 除了 `openai-completions` 管道之外没有任何内容。

### 认证与使用
- **API 密钥认证**：通过 `BASETEN_API_KEY` 认证（`packages/catalog/src/provider-models/descriptors.ts`）。登录流程在 `packages/catalog/src/compat/rules/auth/baseten.kdl` 中声明为 `login "api-key"` 规则（`packages/ai/src/registry/engine/api-key.ts`），指向仪表盘 `https://app.baseten.co/settings/api_keys`，占位符为 `bt_...`。
- **端点校验**：`packages/catalog/src/compat/rules/auth/baseten.kdl` 中的 API 密钥校验通过 `GET https://inference.baseten.co/v1/models` 验证凭证（`models-endpoint` 校验类型）。
- **使用核算**：通过标准 OpenAI Chat Completions 使用处理来对账令牌使用量与定价（`packages/ai/src/providers/openai-shared.ts` 中的 `calculateOpenAIUsageAccounting`）。

### 目录模型处理
- **提供商描述符**：在 `CATALOG_PROVIDERS`（`packages/catalog/src/provider-models/descriptors.ts`）中注册，带有 `id: "baseten"`、`defaultModel: "moonshotai/Kimi-K2.7-Code"`、`envVars: ["BASETEN_API_KEY"]`、`dynamicModelsAuthoritative: true` 和发现标签 `"Baseten"`。
- **模型管理器选项**：`packages/catalog/src/provider-models/openai-compat.ts` 中的 `basetenModelManagerOptions` 以 `defaultBaseUrl: "https://inference.baseten.co/v1"` 和 `requireApiKey: true` 配置模型解析。
- **动态模型发现与定价**：`fetchDynamicModels` 查询 `https://inference.baseten.co/v1/models`。`mapModel` 解析原始记录元数据，包括 `supported_features`、`input_modalities`（视觉能力的 `image`）、上下文与补全令牌边界（`context_length`、`max_completion_tokens`），以及每百万令牌定价（`prompt`、`completion`、`input_cache_read`）。
- **原生推理识别**：当动态特性列出 `reasoning` 或 `reasoning_effort` 时，为 `openai/gpt-oss-120b`、`deepseek-ai/DeepSeek-V4-Pro` 和 `zai-org/GLM-5.2` 标记 `reasoning: true`。
- **推理 Effort 层级限制**：`packages/catalog/src/model-thinking.ts` 中的 `getModelDefinedEfforts` 与 `packages/catalog/src/provider-models/openai-compat.ts` 中的 `basetenModelManagerOptions` 将 `zai-org/GLM-5.2`（`isGlm52ReasoningEffortModelId`）和 `openai/gpt-oss-120b`（`isOpenAIGptOssModelId`）路由的推理 effort 层级限制为两级 `HIGH_MAX_REASONING_EFFORTS` 标度（`[high, max]`）。
- **身份优先级与主机匹配**：在 `PROVIDER_PRIORITY`（`packages/catalog/src/identity/priority.ts`）中被优先考虑，并通过 `packages/catalog/src/hosts.ts` 中的 URL 标记 `baseten.co` 匹配。

## Cerebras (`cerebras`)
Cerebras 在晶圆级引擎硬件上为开放权重模型（例如 `zai-glm-4.7`、`gpt-oss-120b`、`qwen-3-235b-a22b-instruct-2507` 和 `gemma-4-31b`）提供超高速推理。它通过 OpenAI Chat Completions（`openai-completions`）传输通信。

### 特殊情况
- **`all_strict` 工具模式**：在 `packages/catalog/src/compat/openai.ts`（`isCerebras`）中，Cerebras 的 `toolStrictMode` 默认为 `"all_strict"`，在 `openai-completions.ts`（`AppliedToolStrictMode`）中强制所有传入的工具 schema 设置 `strict: true`。
- **`supportsUsageInStreaming: false`**：通过 `packages/catalog/src/compat/openai.ts` 中的 `supportsUsageInStreaming: !isCerebras` 配置，以在 `openai-completions.ts` 中抑制 `stream_options: { include_usage: true }`，防止流式响应时被 API 拒绝。
- **空 400/413 上下文溢出检测**：Cerebras 的上下文与负载溢出错误会返回空的 HTTP 400 或 413 响应体。在 `packages/ai/src/error/flags.ts` 中通过 `OVERFLOW_NO_BODY_PATTERN`（`/\b4(00|13)\s*(status code)?\s*\(no body\)/i`）识别，使 `isContextOverflow` 能够设置 `Flag.ContextOverflow`，从而让 agent 会话自动压缩上下文而不是终止性失败。
- **Gemma 图像输入序列化**：当由 `packages/ai/src/providers/openai-completions.ts` 中的 `convertMessages` 处理时，匹配 `gemma-4-31b` 的模型会将附加的图像块序列化为 Chat Completions `image_url` 数据 URI（`data:image/png;base64,...`）。

### 认证与使用
- **API 密钥登录**：在 `packages/catalog/src/compat/rules/auth/cerebras.kdl` 中声明为 `login "api-key"` 规则（`packages/ai/src/registry/engine/api-key.ts`），默认校验模型为 `gpt-oss-120b`，base URL 为 `https://api.cerebras.ai/v1`。
- **环境解析**：在目录描述符 `descriptors.ts` 和 `packages/catalog/src/compat/rules/auth/cerebras.kdl` 中注册，使用环境变量 `CEREBRAS_API_KEY`。

### 目录模型处理
- **提供商注册**：`descriptors.ts`（`CATALOG_PROVIDERS`）中的目录条目设置 `id: "cerebras"`、`defaultModel: "zai-glm-4.7"`，并将选项构建委托给 `cerebrasModelManagerOptions`。
- **管理器选项与发现**：`packages/catalog/src/provider-models/openai-compat.ts` 中的 `cerebrasModelManagerOptions` 使用 `createOpenAICompatibleModelManagerOptions`，带有 `providerId: "cerebras"` 和默认 base URL `https://api.cerebras.ai/v1`。
- **Gemma 图像能力覆盖**：`packages/catalog/src/provider-models/openai-compat.ts` 中的 `applyCerebrasDiscoveryOverrides` 在模型映射期间检查 `CEREBRAS_IMAGE_INPUT_MODEL_IDS`（`Set(["gemma-4-31b"])`），以将 `"image"` 显式追加到 `input` 能力（`input: ["text", "image"]`），覆盖远程端点发现元数据中缺失的视觉能力标志。

## Cloudflare AI Gateway (`cloudflare-ai-gateway`)
Cloudflare AI Gateway 通过 Cloudflare 的边缘基础设施将请求代理到模型提供商，使用 Anthropic Messages 传输。base URL 需要在模型配置中将 `<account>` 和 `<gateway>` 路径占位符替换为用户特定的 Cloudflare 账户 ID 和网关标识。

### 特殊情况
- **自定义授权标头**：使用 `cf-aig-authorization: Bearer <key>`，而不是标准的 `x-api-key` 或 `Authorization` 标头（`packages/ai/src/providers/anthropic.ts:buildAnthropicHeaders`）。
- **被抑制的客户端凭证**：在 Anthropic 客户端选项对象上将 `apiKey` 和 `authToken` 设为 `null`，使凭证仅通过预构建的默认标头传递（`packages/ai/src/providers/anthropic.ts:3027-3037`）。
- **签名代理检测**：匹配 `gateway.ai.cloudflare.com/.+/anthropic` 的 URL 会通过 `isCloudflareAnthropicGateway` 被识别为 Anthropic 签名代理（`packages/catalog/src/compat/anthropic.ts:CLOUDFLARE_ANTHROPIC_GATEWAY_URL_MARKER`、`isAnthropicSigningProxyUrl`）。
- **OAuth 会话保护**：被排除在接收 Claude OAuth `account_uuid` 标头之外，以防身份泄漏给第三方代理（`packages/coding-agent/src/session/session-metadata.ts`）。

### 认证与使用
- **认证提示**：在 `packages/catalog/src/compat/rules/auth/cloudflare-ai-gateway.kdl` 中声明（`login "custom" hook="cloudflare-ai-gateway"`），在 `packages/ai/src/registry/oauth/cloudflare-ai-gateway.ts` 中实现（传输位于 `packages/ai/src/registry/cloudflare-ai-gateway.ts`），提示输入 Cloudflare AI Gateway 令牌/API 密钥（`cf-aig-...`），并引导用户查阅 Cloudflare 的认证文档。
- **环境变量**：从 `CLOUDFLARE_AI_GATEWAY_API_KEY` 读取 API 密钥凭证（`packages/catalog/src/provider-models/descriptors.ts`）。
- **账户与网关解析**：使用 `https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/anthropic` 作为 base URL 模板，其中 `<account>` 和 `<gateway>` 占位符会替换为用户的 Cloudflare 账户 ID 和网关标识（`packages/catalog/src/provider-models/openai-compat.ts:cloudflareAiGatewayModelManagerOptions`）。

### 目录模型处理
- **描述符与默认模型**：通过 `anthropicMessagesDescriptor` 接入，默认模型为 `anthropic/claude-opus-4-8`（`packages/catalog/src/provider-models/descriptors.ts`）。
- **静态回退模型**：在目录生成期间，当发现没有返回任何模型时注入 `CLOUDFLARE_FALLBACK_MODEL`（`claude-sonnet-4-5`，启用推理，200k 上下文）（`packages/catalog/scripts/generated-policies.ts`、`packages/catalog/scripts/generate-models.ts:536-538`）。
- **优先级接线**：在 `providerPriority`（`packages/catalog/src/identity/priority.ts`）中被分配目录优先级 39。

## CoreWeave Serverless Inference (`coreweave`)
CoreWeave Serverless Inference 在 `https://api.inference.wandb.ai/v1` 提供由 Weights & Biases（W&B）基础设施驱动的托管 AI 模型推理。它使用 "OpenAI Chat Completions" 传输运行。

### 特殊情况
- **项目标头注入**：`packages/ai/src/providers/openai-shared.ts` 中的 `applyCoreWeaveProjectHeader` 会在 `resolveOpenAIRequestSetup` 中拦截针对 `coreweave` 模型的请求，并注入必需的 `OpenAI-Project` HTTP 标头。标头解析由 `packages/catalog/src/wire/coreweave.ts` 中的 `resolveCoreWeaveProject` 和 `coreWeaveProjectHeaders` 处理，检查 `COREWEAVE_PROJECT`、`WANDB_INFERENCE_PROJECT` 或 `WANDB_ENTITY`/`WANDB_PROJECT`。`removeBlankCoreWeaveProjectHeaders` 会移除空的项目标头，以允许回退到环境变量。
- **GPT-OSS 推理转换**：在 `openAiCompletionsDescriptor`（`packages/catalog/src/provider-models/openai-compat.ts`）中，以 `openai/gpt-oss-` 开头的模型会被转换以设置 `reasoning: true`，并配置基于 effort 的思考（`Effort.Low`、`Effort.Medium`、`Effort.High`）。

### 认证与使用
- **API 密钥与环境解析**：通过 `COREWEAVE_API_KEY` 认证，回退到 `WANDB_API_KEY`（`descriptors.ts`、`packages/ai/src/stream.ts` 中的 `getEnvApiKey`）。
- **登录流程与项目校验**：交互式登录在 `packages/catalog/src/compat/rules/auth/coreweave.kdl` 中声明为 `login "api-key"` 规则（`packages/ai/src/registry/engine/api-key.ts`），引用 `https://wandb.ai/settings` 处的设置。`requireCoreWeaveProjectHeaders`（`packages/ai/src/registry/oauth/coreweave.ts`）强制要求：在针对 `https://api.inference.wandb.ai/v1/models` 校验凭证之前，必须能够从环境变量构造出有效的 `OpenAI-Project` 标头。

### 目录模型处理
- **描述符配置**：在 `packages/catalog/src/provider-models/descriptors.ts` 的 `CATALOG_PROVIDERS` 中注册，ID 为 `coreweave`，默认模型为 `openai/gpt-oss-120b`，发现标签为 `"CoreWeave Serverless Inference"`。
- **模型管理器与动态发现**：`packages/catalog/src/provider-models/openai-compat.ts` 中的 `coreWeaveModelManagerOptions` 通过 `createSimpleOpenAICompletionsOptions` 为 `https://api.inference.wandb.ai/v1` 构造提供商选项，并在目录模型抓取时动态提供 `coreWeaveProjectHeaders(Bun.env)`。

## DeepSeek (`deepseek`)
DeepSeek 提供商使用 OpenAI Chat Completions 传输（`openai-completions`）直接对接 DeepSeek 的 API（`https://api.deepseek.com/v1`）。它为 `deepseek-v4-pro` 和 `deepseek-v4-flash` 等官方 DeepSeek 模型提供支持，实现了提供商特定的推理标志、令牌剥离流过滤器、自定义提示缓存使用核算，以及 Bearer 清理的 API 密钥存储。

### 特殊情况
- **推理兼容与 `whenThinking` 交换**：直接 DeepSeek 推理模型（`packages/catalog/src/compat/openai.ts` 中的 `isDirectDeepseekReasoning`）配置 `supportsToolChoice: false`（在推理调用中省略 `tool_choice`）和 `reasoningDisableMode: "zai-thinking-disabled"`。活动推理会激活 `whenThinking` 兼容指针交换，合并 `extraBody: { thinking: { type: "enabled" } }`。设置任何 `tool_choice` 都会丢弃推理字段（`disableReasoningOnToolChoice: true`）。参见 [Provider 兼容参考](./provider-compat-reference.md)。
- **推理内容不变量**：在后续轮次中重放完全一致的先前 `reasoning_content`（`requiresReasoningContentForToolCalls` 和 `requiresReasoningContentForAllAssistantTurns`），拒绝合成的 `"."` 占位符（`allowsSyntheticReasoningContentForToolCalls: false`）。工具轮次上的空助手内容会被提升为 `"."`（`requiresAssistantContentForToolCalls: true`）。
- **聊天模板令牌剥离与修复**：`packages/ai/src/providers/openai-completions.ts` 中的 `stripDeepseekSpecialTokens` 会缓冲并剥离原始流式聊天模板令牌（`<｜User｜>`、`<｜Assistant｜>` 等）。带内 DSML 工具块（`<｜DSML｜tool_calls>`）通过 `StreamMarkupHealing` 修复，模式为 `"dsml"`。
- **线路参数与流看门狗**：输出令牌上限使用 `max_tokens`（`maxTokensField: "max_tokens"`）。事件间流看门狗延长至 300 秒（`DEEPSEEK_REASONING_STREAM_IDLE_TIMEOUT_MS`），以允许漫长的预填充/思考延迟。为函数工具启用 `supportsStrictMode: true`。

### 认证与使用
- **API 密钥规范化与登录**：在 `packages/catalog/src/compat/rules/auth/deepseek.kdl` 中声明为带 `normalize "strip-bearer"` 的 `login "api-key"` 规则（`packages/ai/src/registry/engine/api-key.ts`），会修剪输入并剥离任何前导的 `Bearer ` 前缀（不区分大小写），并针对 `/v1/models` 校验。运行时凭证依赖 `DEEPSEEK_API_KEY`。
- **提示缓存使用核算**：DeepSeek 返回顶层使用字段 `prompt_cache_hit_tokens` 和 `prompt_cache_miss_tokens`。`calculateOpenAIUsageAccounting`（`packages/ai/src/providers/openai-shared.ts`）会检测 `isDeepSeekUsage`，将净输入令牌映射为 `Math.max(0, promptTokens - cachedTokens)`（未命中计数），并将 `cacheWrite` 设为 `0`，以避免把未缓存的提示令牌当作显式缓存写入而重复计费。

### 目录模型处理
- **描述符与管理器**：`packages/catalog/src/provider-models/descriptors.ts` 中的目录条 `deepseek` 设置 `defaultModel: "deepseek-v4-pro"`，并使用 `deepseekModelManagerOptions`（`packages/catalog/src/provider-models/openai-compat.ts`），目标为 `https://api.deepseek.com`。内置的发现过滤器用于支持工具调用的 `deepseek-v4` 模型。
- **推理 Effort 阶梯**：为 `deepseek-v4-pro` 配置 `HIGH_MAX_REASONING_EFFORTS`（`[high, max]`），为 `deepseek-v4-flash` 配置 `LOW_HIGH_MAX_REASONING_EFFORTS`（`[low, high, max]`）。在所有 DeepSeek 模型上将 `xhigh` effort 请求规范化为 `max`（`isDeepseekModelIdOrName`）。

## Fire Pass (`firepass`)
Fire Pass 是 Fireworks AI 的订阅层级，提供对 Kimi K2.6 Turbo 的专用高吞吐量路由器访问。它使用 OpenAI Chat Completions 传输（`https://api.fireworks.ai/inference/v1`），并带有 Fireworks 路由器端点转换。

### 特殊情况
- **线路模型 ID 转换（`wireModelIdMode: "firepass"`）**：`buildOpenAICompat`（`packages/catalog/src/compat/openai.ts`）会为 `firepass` 或 Fireworks 快速路由器模型（`isFireworksFastRouter`）分配 `wireModelIdMode: "firepass"`。`applyWireModelIdTransform`（`packages/ai/src/providers/openai-shared.ts`）使用 `toFirepassWireModelId`（`packages/catalog/src/fireworks-model-id.ts`）将友好的目录 ID（例如 `kimi-k2.6-turbo`）转换为 Fireworks 路由器线路 ID（`accounts/fireworks/routers/kimi-k2p6-turbo`），方法是将点替换为 `p`。
- **最大输出令牌上限**：输出令牌被限制为 32,768（`FIREWORKS_KIMI_MAX_TOKENS`），通过 `clampFireworksKimiMaxTokens`（`packages/catalog/src/provider-models/openai-compat.ts`）和 `applyKimiMaxTokensCap`（`packages/catalog/scripts/generate-models.ts`）实现，以防止 Kimi K2 模型上的推理轨迹失控。
- **五级思考 Effort**：`getThinkingConfig`（`packages/catalog/src/model-thinking.ts`）将 `firepass` 映射到 `FIVE_TIER_EFFORTS_LOW_TO_MAX`（`low`、`medium`、`high`、`xhigh`、`max`）。

### 认证与使用
- **认证**：在 `packages/catalog/src/compat/rules/auth/firepass.kdl` 中定义为 `login "api-key"` 规则（`packages/ai/src/registry/engine/api-key.ts`），使用环境变量 `FIREPASS_API_KEY`（`fpk_...`）。
- **校验**：专用的 `fpk_...` 密钥只能授权路由器端点，在 `/v1/models` 上会失败。`packages/catalog/src/compat/rules/auth/firepass.kdl` 中的校验使用 `validate "chat-completions"`，直接针对 `accounts/fireworks/routers/kimi-k2p6-turbo`。

### 目录模型处理
- **描述符**：在 `packages/catalog/src/provider-models/descriptors.ts` 中注册（`id: "firepass"`、`defaultModel: "kimi-k2.6-turbo"`、`envVars: ["FIREPASS_API_KEY"]`）。
- **管理器选项**：`firepassModelManagerOptions`（`packages/catalog/src/provider-models/openai-compat.ts`）返回不带动态发现的静态配置，依赖 `models.json` 中捆绑的规范目录。
- **脚本清理**：`dropFireworksWireIds`（`packages/catalog/scripts/generate-models.ts`）在目录生成期间剥离内部的 `accounts/fireworks/` 线路 ID。

## Fireworks (`fireworks`)
Fireworks（`packages/catalog/src/compat/rules/auth/fireworks.kdl`）是一个高吞吐量的 AI 推理提供商，通过 OpenAI 兼容的 HTTP REST API（`https://api.fireworks.ai/inference/v1`）为无服务器和专用模型提供服务。它使用 OpenAI Chat Completions 传输（`packages/ai/src/providers/openai-completions.ts` 中的 `streamOpenAICompletions`），并带有自定义模型 ID 线路转换、思考参数冲突解决和优先级层级处理。

### 特殊情况
- **`wireModelIdMode: "fireworks"` 与线路模型 ID 转换**：`applyWireModelIdTransform`（`packages/ai/src/providers/openai-shared.ts`）由 `packages/catalog/src/compat/openai.ts` 中解析出的 `wireModelIdMode: "fireworks"` 启用，它调用 `toFireworksWireModelId`（`packages/catalog/src/fireworks-model-id.ts`）为公开目录模型 ID 添加 `accounts/fireworks/models/` 前缀，并将版本中的点转换为 `p`（例如 `glm-5.1` 映射为 `accounts/fireworks/models/glm-5p1`）。公开目录规范化使用 `toFireworksPublicModelId`。
- **快速路由器与 Fire Pass 模型线路路由**：以 `-fast` 结尾的模型（`packages/catalog/src/fireworks-model-id.ts` 中的 `isFireworksFastModelId`）代表高吞吐量服务路由。`buildOpenAICompat`（`packages/catalog/src/compat/openai.ts`）将 `isFireworksFastRouter` 解析为 `wireModelIdMode: "firepass"`，通过 `toFirepassWireModelId` 将线路调度映射为 `accounts/fireworks/routers/<id>-fast`，而不是 `accounts/fireworks/models/`。
- **`dropThinkingWhenReasoningEffort` 冲突解决**：在 `packages/catalog/src/compat/openai.ts` 中，Fireworks 的 `compat.dropThinkingWhenReasoningEffort` 被设为 `true`。当请求参数中存在 `reasoning_effort` 时，`applyOpenAIExtraBody`（`packages/ai/src/providers/openai-shared.ts`）会删除顶层的 `thinking` 开关对象，以避免 Fireworks 因同时拒绝这两个参数而返回 HTTP 400 错误。
- **Qwen 思考格式覆盖**：`buildOpenAICompat`（`packages/catalog/src/compat/openai.ts`）为 Fireworks 托管的 Qwen 模型（例如 `fireworks/qwen3.7-plus`）分配 `thinkingFormat: "openai"` 而不是 `"qwen"`，强制使用 `reasoning_effort` 而不是阿里云 DashScope 的 `enable_thinking` 布尔值（Fireworks 会以 400 拒绝它）。
- **服务层级 / 优先级控制**：`excludesInferredOpenAIServiceTier` 和 `shouldSendServiceTier`（`packages/ai/src/types.ts`）允许 `fireworks` 请求在启用 `providers.fireworksTier: priority`（或 `/fast` 模式）时发送 `service_tier: "priority"`，抑制不需要的层级默认值。
- **流标记修复**：`packages/ai/src/utils/stream-markup-healing.ts` 中的 `modelMayLeakDsmlToolCalls` 会标记 `provider === "fireworks"`，调用 `ThinkingInbandScanner` 来缓冲并清理从可见文本增量中泄漏的 DSML XML 标记。

### 认证与使用
- **API 密钥认证**：使用通过 `FIREWORKS_API_KEY` 配置的 HTTP Bearer 令牌（`Authorization: Bearer ${apiKey}`）进行认证（通过 `packages/ai/src/stream.ts` 中的 `getEnvApiKey` 解析）。
- **控制平面登录校验**：`/login fireworks`（在 `packages/catalog/src/compat/rules/auth/fireworks.kdl` 中声明为 `login "api-key"` 规则，`packages/ai/src/registry/engine/api-key.ts`）针对静态控制平面目录 `GET /v1/accounts/fireworks/models?filter=supports_serverless%3Dtrue&pageSize=1` 校验凭证，而不是 `/v1/models`（推理端点服务的是按账户部署，对没有活跃部署的账户返回 500）。
- **使用核算**：令牌使用通过 `calculateOpenAIUsageAccounting`（`packages/ai/src/providers/openai-shared.ts`）中的标准 `openai-completions` 核算处理，提取 `prompt_tokens`、`completion_tokens`、`prompt_tokens_details.cached_tokens` 和 `completion_tokens_details.reasoning_tokens`。

### 目录模型处理
- **描述符注册**：在 `CATALOG_PROVIDERS`（`packages/catalog/src/provider-models/descriptors.ts`）中注册，带有 `id: "fireworks"`、`defaultModel: "kimi-k2.7-code"`、`envVars: ["FIREWORKS_API_KEY"]` 和 `createModelManagerOptions: fireworksModelManagerOptions`。
- **控制平面发现**：`fireworksModelManagerOptions`（`packages/catalog/src/provider-models/openai-compat.ts`）通过控制平面目录 `GET /v1/accounts/fireworks/models?filter=supports_serverless=true` 而不是 `/v1/models` 枚举模型，并使用 `toFireworksPublicModelId` 将资源名称（`accounts/fireworks/models/<id>`）转换为公开目录 ID。内部账户资源 ID 会在 `scripts/generate-models.ts` 中的目录生成期间被剪除。
- **快速变体播种**：`buildFireworksFastSeed`（`packages/catalog/src/provider-models/openai-compat.ts`）以编程方式为精选基础模型生成配对的 `-fast` 目录种子（例如 `kimi-k2.7-code-fast`、`glm-5.1-fast`），在保留基础定价的同时指向高速路由器线路路径。
- **Kimi 系列输出令牌上限**：`clampFireworksKimiMaxTokens`（`packages/catalog/src/provider-models/openai-compat.ts`）将 Kimi K2.5/K2.6 模型（`isFireworksKimiK2ModelId`）的输出预算 `maxTokens` 限制为 `FIREWORKS_KIMI_MAX_TOKENS = 32_768`，以防止 Fireworks 报告的 `max_completion_tokens: 65536` 导致推理轨迹失控。`kimi-k2.7-code` 被显式排除在该上限之外，允许达到其完整的输出预算（`FIREWORKS_KIMI_K27_CODE_MAX_TOKENS = 65_536`）。
- **推理 Effort 阶梯**：`FIREWORKS_REASONING_EFFORT_MAP`（`packages/catalog/src/model-thinking.ts`）将 `minimal -> "none"` 映射（在 Fireworks 上禁用推理），同时让 `low`、`medium` 和 `high` 原样通过。受限模型（例如 `minimax-m2.7`、`gpt-oss-120b`）在目录定义中将 effort 阶梯覆盖为 `[low, medium, high]`。

## GitHub Copilot (`github-copilot`)
GitHub Copilot 通过 GitHub 的统一代理端点（`https://api.githubcopilot.com` 或企业版 `copilot-api.<domain>`）路由多厂商模型执行（OpenAI GPT、Anthropic Claude、xAI Grok、Google Gemini）。该提供商在三种线路传输之间动态调度：OpenAI Chat Completions、OpenAI Responses 和 Anthropic Messages。

### 特殊情况
- **动态 Copilot 标头与发起者**：`buildCopilotDynamicHeaders`（`packages/ai/src/providers/github-copilot-headers.ts`）注入逐请求标头 `X-Initiator`（通过 `inferCopilotInitiator` 从消息历史推断出的 `"user"` 与 `"agent"`，或通过 `getCopilotInitiatorOverride` 覆盖）、`Openai-Intent: conversation-edits`，以及当 `hasCopilotVisionInput` 在用户或工具结果块中检测到图像负载时的 `Copilot-Vision-Request: true`。
- **API 版本与线路标头**：`COPILOT_API_HEADERS`（`packages/catalog/src/wire/github-copilot.ts`）强制要求 `User-Agent: opencode/1.3.15`（`COPILOT_USER_AGENT`）和 `X-GitHub-Api-Version: 2026-06-01`（`COPILOT_API_VERSION`）。`packages/catalog/src/provider-models/openai-compat.ts` 中的 `restorableHeaderFallback` 在离线缓存重新水化期间保留静态线路标头。
- **Base URL 与端点解析**：`resolveGitHubCopilotBaseUrl`（`packages/ai/src/providers/github-copilot-headers.ts`）和 `parseGitHubCopilotApiKey`（`packages/catalog/src/wire/github-copilot.ts`）解析嵌入在 API 密钥或凭证中的自定义 `enterpriseUrl` 和 `apiEndpoint` 属性，默认值为 `https://api.githubcopilot.com`（`PERSONAL_GITHUB_COPILOT_BASE_URL`）。
- **OpenAI 与 Responses 兼容标志**：
  - `supportsReasoningParams`：在 `packages/catalog/src/compat/openai.ts` 中禁用（`supportsReasoningParams: provider !== "github-copilot"`），因为 Copilot Chat Completions 端点会以 HTTP 400 拒绝 `reasoning_effort` 和推理字段。
  - `supportsDeveloperRole`：对 Chat Completions 规范禁用（`openai-compat.ts`），但在 OpenAI Responses 规范上启用。
  - `strictResponsesPairing`：在 `packages/catalog/src/compat/openai.ts` 中启用（`spec.provider === "github-copilot"`），强制 Responses 端点上的工具调用与工具结果消息严格配对。
  - `supportsImageDetailOriginal`：禁用（`supportsImageDetailOriginal: false`），将图像细节从 `"original"` 限制为 `"auto"`，以避免代理 400/422 拒绝。
- **Anthropic 线路与签名兼容**：
  - `supportsEagerToolInputStreaming`：在 `packages/catalog/src/compat/anthropic.ts` 中禁用（`supportsEagerToolInputStreaming: false`），并且省略细粒度工具流式传输 beta 标头，因为 Copilot Anthropic 代理会拒绝 `eager_input_streaming`（#2558）。
  - 被识别为签名主机（`buildAnthropicCompat`），从而对 Claude 模型抑制未签名的思考重放（#2851）。

### 认证与使用
- **设备流 OAuth（`opencode` OAuth 应用）**：
  - 在 `packages/catalog/src/compat/rules/auth/github-copilot.kdl` 中声明（`login "custom" hook="github-copilot"`），`packages/ai/src/registry/oauth/github-copilot.ts` 中的 `loginGitHubCopilotHook` 使用客户端 ID `Ov23li8tweQw6odWQebz`（`CLIENT_ID`）和作用域 `read:user` 执行 GitHub 设备授权流程。
  - `startDeviceFlow` 使用 `OPENCODE_HEADERS` 向 `https://<domain>/login/device/code` 发起 POST。`pollForGitHubAccessToken` 轮询 `https://<domain>/login/oauth/access_token`，自动处理 `authorization_pending` 和 `slow_down` 速率限制退避。
  - 登录后，`discoverGitHubCopilotApiEndpoint` 查询 `https://api.github.com/copilot_internal/user`，`enableAllGitHubCopilotModels` 发出模型启用请求（`POST /models/{modelId}/policy`，携带 `{ state: "enabled" }` 和 `openai-intent: chat-policy`）。
- **令牌交换与刷新**：
  - `refreshGitHubCopilotToken`（`packages/ai/src/registry/oauth/github-copilot.ts`）直接使用长期有效的 GitHub OAuth 令牌，无需二次 JWT 交换循环，将过期时间设为 `FAR_FUTURE_MS`（10 年）。
- **使用与配额核算**：
  - `packages/ai/src/usage/github-copilot.ts` 中的 `fetchInternalUsage` 在 `resolveGitHubApiBaseUrl` 上使用 `OPENCODE_HEADERS` 查询 `GET /copilot_internal/user`。
  - `normalizeQuotaSnapshots` 和 `buildLimitFromQuota` 将 `quota_snapshots`（`chat`、`completions`、`premium_interactions`）与 `quota_reset_date` 转换为按月 `UsageLimit` 结构（`copilot:premium`、`copilot:chat`、`copilot:completions`）。`fetchBillingUsage` 提供补充的用户账单详情（`/settings/billing/premium_request/usage`）。
  - `getCopilotPremiumRequests`（`packages/ai/src/providers/github-copilot-headers.ts`）计算模型的高级请求成本：agent 轮次（`initiator === "agent"`）为 `0`，用户轮次则为 `getCopilotPremiumMultiplier(premiumMultiplier, planTier)`。

### 目录模型处理
- **描述符与管理**：在 `PROVIDER_DESCRIPTORS`（`packages/catalog/src/provider-models/descriptors.ts`）中注册为 `github-copilot` 描述符，带有 `defaultModel: "gpt-5.5"` 和环境变量 `COPILOT_GITHUB_TOKEN`。选项通过 `githubCopilotModelManagerOptions` 构造。
- **动态模型发现**：`packages/catalog/src/provider-models/openai-compat.ts` 中的 `fetchDynamicModels` 使用 `COPILOT_API_HEADERS` 抓取 `/models`。从 `entry.capabilities.limits`（`maxContextWindowTokens`、`maxPromptTokens`、`maxOutputTokens`）解析窗口/令牌上限，推断线路 API（`inferCopilotApi`），并配置视觉支持（`extractCopilotSupportsVision`）。
- **长上下文变体合成**：在 `billing.token_prices.long_context` 中宣告长上下文定价的模型会触发 `createCopilotLongContextVariant`，以合成可选加入的 `-1m` 目录模型（例如 `claude-opus-4.7-1m`，其 `requestModelId: "claude-opus-4.7"`）。基础模型会获得指向其长上下文兄弟项的 `contextPromotionTarget`。
- **高级请求乘数**：模型特定的请求乘数在 `COPILOT_PREMIUM_MULTIPLIERS`（`packages/catalog/scripts/generate-models.ts`）中映射，分配诸如 `gpt-4o: 0`、`grok-code-fast-1: 0.25`、`claude-haiku-4.5: 0.33`、`gpt-5.4-mini: 0.33` 和 `claude-opus-4.6: 3` 等值。

## GitLab Duo Non-Agentic (`gitlab-duo`)

`GitLab Duo Non-Agentic`（`gitlab-duo`）将 Duo Chat 的 LLM 补全请求代理到 GitLab AI Gateway 代理端点。根据目标模型映射，它会动态地将执行委托给 [Anthropic Messages](#anthropic-messages)、[OpenAI Chat Completions](#openai-chat-completions) 或 [OpenAI Responses](#openai-responses) 线路传输。它依托共享的 [GitLab Duo](#gitlab-duo) 传输章节。

### 特殊情况
- **模型 ID 映射与路由：** `packages/ai/src/providers/gitlab-duo.ts` 中的 `MODEL_MAPPINGS` 将 Duo 模型标识符（`duo-chat-opus-4-6`、`duo-chat-sonnet-4-6`、`duo-chat-opus-4-5`、`duo-chat-sonnet-4-5`、`duo-chat-haiku-4-5`、`duo-chat-gpt-5-1`、`duo-chat-gpt-5-2`、`duo-chat-gpt-5-mini`、`duo-chat-gpt-5-codex`、`duo-chat-gpt-5-2-codex`）映射到后端提供商（`anthropic` 或 `openai`）、底层模型 ID、API schema（`anthropic-messages`、`openai-completions`、`openai-responses`）以及代理目标 URL（`ANTHROPIC_PROXY_URL` = `https://cloud.gitlab.com/ai/v1/proxy/anthropic/` 或 `OPENAI_PROXY_URL` = `https://cloud.gitlab.com/ai/v1/proxy/openai/v1`）。
- **规范模型别名查找：** `packages/ai/src/providers/gitlab-duo.ts` 中的 `getModelMapping` 通过匹配 Duo 别名键或底层规范模型 ID 字符串（例如 `gpt-5-codex` 或 `claude-sonnet-4-5-20250929`）来解析模型映射。
- **直接访问令牌交换与缓存：** `packages/ai/src/providers/gitlab-duo.ts` 中的 `getDirectAccessToken` 通过 `POST https://gitlab.com/api/v4/ai/third_party_agents/direct_access` 并携带 `{ feature_flags: { DuoAgentPlatformNext: true } }`，将用户的 GitLab 访问令牌交换为短期直接访问令牌。生成的令牌与标头会缓存在 `directAccessCache` 中 25 分钟（`DIRECT_ACCESS_TTL_MS`）。
- **委托流调度：** `packages/ai/src/providers/gitlab-duo.ts` 中的 `streamGitLabDuo` 会校验用户令牌（`MissingApiKeyError`），获取直接访问标头，通过 `mapAnthropicToolChoice`（`packages/ai/src/stream.ts`）转换 Anthropic 工具选择，并使用合成的模型规范（`buildModel`）分派到 `streamAnthropic`、`streamOpenAICompletions` 或 `streamOpenAIResponses`（`packages/ai/src/providers/register-builtins.ts`）。

### 认证与使用
- **PAT 与 OAuth 支持：** 在 `packages/catalog/src/compat/rules/auth/gitlab-duo.kdl` 中声明（`login "oauth-code"`，引擎 `packages/ai/src/registry/engine/oauth-code.ts`），缓存清理钩子位于 `packages/ai/src/registry/oauth/gitlab-duo.ts`，支持通过 `GITLAB_TOKEN` 使用个人访问令牌，或使用 PKCE 浏览器 OAuth。
- **OAuth 授权与客户端 ID：** 在 `packages/catalog/src/compat/rules/auth/gitlab-duo.kdl` 中声明，针对 `https://gitlab.com/oauth/authorize` 执行 PKCE OAuth（`scope: "api"`、`callbackPort: 8080`、`pasteCodeFlow: true`）。使用 `client-id`（`"da4edff2e6ebd2bc3208611e2768bc1c1dd7be791dc5ff26ca34ca9ee44f7d4b"`），可通过 `GITLAB_CLIENT_ID`（`env="GITLAB_CLIENT_ID"`）和 `GITLAB_REDIRECT_URI`（`redirect-uri-env="GITLAB_REDIRECT_URI"`）覆盖。
- **令牌刷新与缓存失效：** `packages/catalog/src/compat/rules/auth/gitlab-duo.kdl` 中的令牌刷新在 `https://gitlab.com/oauth/token` 交换刷新令牌。交换与刷新都会通过 `gitLabDuoClearCacheHook`（`packages/ai/src/registry/oauth/gitlab-duo.ts`，调用 `packages/ai/src/providers/gitlab-duo.ts` 中的 `clearGitLabDuoDirectAccessCache`）清除缓存的直接访问令牌。
- **使用面：** 除 [GitLab Duo](#gitlab-duo) 管道之外没有其他内容。

### 目录模型处理
- **描述符配置：** `packages/catalog/src/provider-models/descriptors.ts` 中的 `PROVIDER_DESCRIPTORS` 注册 `gitlab-duo`，带有 `defaultModel: "duo-chat-opus-4-6"` 和 `envVars: ["GITLAB_TOKEN"]`。
- **静态目录生成：** `packages/catalog` 中的 `scripts/generate-models.ts` 调用 `getGitLabDuoModels`（`packages/ai/src/providers/gitlab-duo.ts`），将 `MODEL_MAPPINGS` 条目转换为 `models.json` 中捆绑的 `ModelSpec` 定义。
- **提供商优先级：** `packages/catalog/src/identity/priority.ts` 中的 `PROVIDER_PRIORITY` 为 `gitlab-duo` 分配优先级等级 35。

## GitLab Duo Agent (`gitlab-duo-agent`)
`gitlab-duo-agent` provider 通过 WebSocket action-bridge 协议将 OMP 连接到 GitLab Duo Workflow Service（DWS）以执行代理。它遵循 `GitLab Duo` 传输部分。

### 特殊情况
- **流直接绕过与思考修复**：在 `packages/ai/src/stream.ts` 中，`gitlab-duo-agent` 绕过 `withProviderInFlightLimit` 和标准 `iterateWithIdleTimeout` 包装器。`streamGitLabDuoWorkflow`（`packages/ai/src/providers/gitlab-duo-workflow.ts`）被直接调用，并包装在 `healLeakedThinking` 中。
- **运行时命名空间解析与自动启用**：流初始化调用 `resolveGitLabDuoWorkflowNamespaceSelection`（`packages/ai/src/providers/gitlab-duo-workflow.ts`），以从选项、`GITLAB_DUO_NAMESPACE_ID`/`GITLAB_DUO_PROJECT_ID` 环境变量或工作区 git 远程解析根命名空间。`ensureGitLabDuoWorkflowSettings` 向 `/api/v4/ai/duo_workflows/settings` 发起 POST（通过 `GITLAB_DUO_WORKFLOW_REST_TIMEOUT_MS` 设置 30 秒超时），以自动启用所需的命名空间设置（`duo_workflow`、`duo_workflow_service`、`duo_agent_platform`）。
- **ChatML 目标与内联规范生成**：将会话历史渲染为 ChatML 目标字符串（`buildGitLabDuoWorkflowGoal`、`renderGitLabDuoWorkflowChatMl`），受 1MB 软限制（`GITLAB_DUO_WORKFLOW_GOAL_SOFT_OVERFLOW_BYTES`）和 2MB 硬限制（`GITLAB_DUO_WORKFLOW_GOAL_HARD_OVERFLOW_BYTES`）约束。发出一个面向 `omp_agent` 的环境内联工作流定义（`buildGitLabDuoWorkflowInlineFlowConfig`）。
- **WebSocket 操作桥接**：工具定义在 `startRequest.mcpTools` 中转换为 MCP 格式（`buildGitLabDuoWorkflowMcpTools`）。通过 WebSocket 传入的 `runMCPTool`/`run_mcp_tool` 操作被提取（`extractGitLabDuoWorkflowAction`），在本地执行，并通过 `buildGitLabDuoWorkflowActionResponse` 返回。

### 认证与使用
- **注册与凭据解析**：在 `packages/catalog/src/compat/rules/auth/gitlab-duo-agent.kdl` 中声明，要求 `GITLAB_TOKEN`（PAT 或通过 `env "GITLAB_TOKEN"` 提供的 OAuth token）。
- **OAuth PKCE 与官方客户端 ID**：在 `packages/catalog/src/compat/rules/auth/gitlab-duo-agent.kdl` 中声明的浏览器认证（`login "oauth-code"`，引擎 `packages/ai/src/registry/engine/oauth-code.ts`）在 `vscode://gitlab.gitlab-workflow/authentication` 上使用 S256 PKCE 与 `manual-only=#true`。它使用官方 GitLab VS Code 客户端 ID（`36f2a70cddeb5a0889d4fd8295c241b7e9848e89cf9e599d0eed2d8e5350fbf5`），在 VS Code 拦截重定向时支持手动粘贴回调 URL。Token 刷新在 KDL 规则的 `refresh` 下声明（`packages/ai/src/registry/engine/refresh.ts`）。
- **直接访问 token**：通过 `POST /api/v4/ai/duo_workflows/direct_access`（`packages/ai/src/providers/gitlab-duo-workflow.ts` 中的 `requestGitLabDuoWorkflowDirectAccess`）请求临时凭据。`packages/ai/src/usage/` 下不存在专用的使用模块。
- **上下文遥测使用**：`extractGitLabDuoWorkflowContextUsage` 提取检查点遥测（`agent_context_usage`），优先处理 `"Chat Agent"` 和 `"context_builder"` 条目，并通过 `applyGitLabDuoWorkflowContextUsage` 更新 token 估算。

### 目录模型处理
- **provider 描述符**：在 `packages/catalog/src/provider-models/descriptors.ts` 中注册，带有 `defaultModel: "claude_sonnet_4_6_vertex"`、`envVars: ["GITLAB_TOKEN"]` 和 `dynamicModelsAuthoritative: true`。省略 `catalogDiscovery`，以防止在静态目录生成期间运行单账户命名空间发现。
- **指纹化作用域缓存**：`packages/catalog/src/provider-models/special.ts` 中的 `gitLabDuoWorkflowModelManagerOptions` 配置动态模型管理。`gitLabDuoWorkflowModelCacheProviderId` 使用 `Bun.hash` 对 `apiKey` 以及由 `baseUrl`、`namespaceId`、`projectId` 和工作区 `cwd` 组成的作用域字符串进行哈希，以分区动态目录缓存。
- **GraphQL 发现**：`fetchGitLabDuoWorkflowModels`（`packages/catalog/src/discovery/gitlab-duo-workflow.ts`）调用 `discoverGitLabDuoWorkflowNamespace` 定位根命名空间（经由显式配置、环境变量或匹配 `discoverGitLabRemoteProjectPath` 的 git 远程），并执行 GraphQL 查询 `aiChatAvailableModels(rootNamespaceId:)` 以查询 `defaultModel`、`selectableModels` 和 `pinnedModel`。
- **模型规范与上下文窗口**：`buildGitLabDuoWorkflowModelSpec` 构造模型规范且 `reasoning: false`（禁用思考 UI 控件，因为 Duo Agent Platform 在服务端管理 Anthropic 推理参数）。`resolveGitLabDuoWorkflowContextWindow` 将模型引用映射为上下文窗口大小（Claude Opus/Sonnet：1,000,000；Haiku：200,000；Gemini：1,000,000；GPT-5：400,000；默认：200,000）。
- **回退模型播种**：`scripts/generate-models.ts` 播种 `buildGitLabDuoWorkflowFallbackModel()`（`claude_sonnet_4_6_vertex`），使未认证/全新安装的实例包含一个默认模型条目。

## GMI Cloud (`gmi-cloud`)
GMI Cloud 是一个 AI GPU 基础设施与云模型推理 provider，托管开放权重和专有模型端点。它通过 OpenAI Chat Completions 传输运行，使用托管在 `https://api.gmi-serving.com/v1` 的标准 `/v1` wire 协议。

### 特殊情况
- 除了 OpenAI Chat Completions 管道之外没有任何内容。

### 认证与使用
- **API 密钥登录与校验**：在 `packages/catalog/src/compat/rules/auth/gmi-cloud.kdl` 中声明为 `login "api-key"` 规则（`packages/ai/src/registry/engine/api-key.ts`），将用户指向 `https://console.gmicloud.ai`。密钥校验使用 `kind: "models-endpoint"`，命中 `https://api.gmi-serving.com/v1/models`。
- **环境变量**：主要凭据解析检查 `GMI_API_KEY`（`packages/catalog/src/provider-models/descriptors.ts` 中的 `envVars`）。
- **provider 注册表**：通过 `packages/ai/src/registry/build.ts` 从 `packages/catalog/src/compat/rules/auth/gmi-cloud.kdl` 编译进 `packages/ai/src/registry/registry.ts`。

### 目录模型处理
- **描述符与网关选项**：在 `CATALOG_PROVIDERS`（`packages/catalog/src/provider-models/descriptors.ts`）中注册，带有 `id: "gmi-cloud"`、`defaultModel: "deepseek-ai/DeepSeek-V4-Flash"` 和 `dynamicModelsAuthoritative: true`。网关选项由 `gmiCloudModelManagerOptions` 创建，它用 `GMI_CLOUD_BASE_URL`（`https://api.gmi-serving.com/v1`）包装 `createSimpleOpenAICompletionsOptions`（`packages/catalog/src/provider-models/openai-compat.ts`）。
- **动态模型发现**：配置 `catalogDiscovery: { label: "GMI Cloud" }`（`packages/catalog/src/provider-models/descriptors.ts`），通过 `fetchOpenAICompatibleModels`（`packages/catalog/src/discovery/openai-compatible.ts`）动态查询 `/v1/models`。当 API 凭据可用时，标记为权威的实时发现结果会覆盖缓存或静态条目。
- **静态种子模型**：`GMI_CLOUD_STATIC_MODELS`（`packages/catalog/src/provider-models/openai-compat.ts`）为 `deepseek-ai/DeepSeek-V4-Flash` 定义捆绑的回退种子（1,048,576 上下文窗口、384,000 最大 token、每 100 万输入/输出 token `$0.14`/`$0.28`、启用推理并支持 `High` 和 `Max` effort 模式）。该种子确保缺少 `GMI_API_KEY` 的全新安装或模型生成运行可以同步解析该 provider 的默认模型（`packages/catalog/scripts/generate-models.ts`、`packages/catalog/test/gmi-cloud-provider.test.ts`）。

## Google Antigravity (`google-antigravity`)
Google Antigravity provider（`google-antigravity`）使用专用 OAuth 凭据将请求路由到 Google Cloud Code Assist daily/sandbox 端点（`daily-cloudcode-pa.googleapis.com`）。它使用共享的 "Google Gemini CLI / Antigravity" 传输（`packages/ai/src/providers/google-gemini-cli.ts`），提供对 Google Gemini 3.x/2.5 模型以及 Anthropic Claude 和 OpenAI GPT-OSS 模型的访问。

### 特殊情况
- **校验式函数调用默认值**：`buildRequest`（`packages/ai/src/providers/google-gemini-cli.ts`）中的默认工具选择模式为 `VALIDATED`（`functionCallingConfig: { mode: "VALIDATED" }`）。Antigravity 上的 Claude 模型即使未声明任何工具，也始终强制 `VALIDATED` 工具模式（`packages/ai/src/providers/google-gemini-cli.ts`）。
- **系统指令与请求信封**：Antigravity 将 `systemInstruction` 标记为 `role: "user"`，并原样发送调用方的提示词。`buildAntigravityRequestEnvelope` 使用 `getAntigravityModelWireProfile` 注入结构化的 `requestId`（`agent/<id>/<ts>/<trajectoryId>/<step>`）、`userAgent: "antigravity"`、`requestType: "agent"`、`sessionId` 和 `labels`（`model_enum`、`trajectory_id`、`last_step_index`、`last_execution_id`、`used_claude*`）。
- **端点自动故障转移**：在 `ANTIGRAVITY_DAILY_ENDPOINT`（`https://daily-cloudcode-pa.googleapis.com`）和 `ANTIGRAVITY_SANDBOX_ENDPOINT`（`https://daily-cloudcode-pa.sandbox.googleapis.com`）之间运行，并在 `getAntigravityProviderSessionState`（`packages/ai/src/providers/google-gemini-cli.ts`）中实现带状态跟踪的回退。

### 认证与使用
- **专用 OAuth 流程**：在 `packages/catalog/src/compat/rules/auth/google-antigravity.kdl` 中声明（`login "oauth-code"` 规则，`packages/ai/src/registry/engine/oauth-code.ts`），项目发现钩子在 `packages/ai/src/registry/oauth/google-antigravity.ts`（`googleAntigravityProjectHook`），执行独立的 OAuth 流程，使用不同的客户端凭据和回调端口 51121。项目发现镜像原生 `antigravity/hub`：精确 200 的 `loadCodeAssist` 调用使用 `ANTIGRAVITY_LOAD_CODE_ASSIST_METADATA`，免费层级资格会被尊重，缺少层级时触发一次 `onboardUser` 请求，加上在 30 秒截止时间内的 1 秒操作轮询，最后刷新一次加载以提供 `cloudaicompanionProject`。
- **模型系列凭据排序**：`antigravityRankingStrategy`（`packages/ai/src/usage/google-antigravity.ts`）按模型系列限定使用限制（`scopeAntigravityLimitsForModel` 通过 `getAntigravityCounterKeyForModel`：`claude-` 为 `anthropic`，`gemini-`/`gemma-` 为 `google`，`gpt-`/`openai/` 为 `openai`）。这防止某个计数器（例如 Gemini）的配额耗尽阻塞另一个系列（例如 Claude）的多账户凭据选择。

### 目录模型处理
- **目录发现**：`fetchAntigravityDiscoveryModels`（`packages/catalog/src/discovery/antigravity.ts`）查询 `/v1internal:fetchAvailableModels`，过滤拒绝名单 ID（`chat_20706`、`chat_23310`、`gemini-2.5-pro`）和内部模型（`isInternal`），并通过 `ANTIGRAVITY_VARIANT_COLLAPSE_TABLE` 应用 effort 层级变体折叠。
- **Claude 与 GPT-OSS 模型可用性**：在 `models.json`（`packages/catalog/src/models.json`）中，与 Gemini 3.x/2.5 模型一起暴露 Anthropic Claude 模型（`claude-opus-4-5`、`claude-opus-4-6`、`claude-sonnet-4-5`、`claude-sonnet-4-6`）和 `gpt-oss-120b`。
- **定价回退**：`applyAntigravityPricingFallback`（`packages/catalog/scripts/generated-policies.ts`）使用 `ANTIGRAVITY_PRICING_PEERS`（`google`、`google-vertex`、`anthropic`）和 `ANTIGRAVITY_PRICING_ID_ALIASES`（`gemini-3-flash` -> `gemini-3-flash-preview`、`claude-opus-4-5` -> `claude-opus-4-5@20251101`）回填零成本发现模型，将 Gemini 模型映射到 Google API 价格，将 Claude 模型映射到 Google Vertex 列表价。

## Google Gemini CLI (`google-gemini-cli`)
Google Cloud Code Assist (Gemini CLI)（`google-gemini-cli`）是 Google 经 OAuth 认证的开发者免费与工作区层级，通过 Cloud Code Assist API 端点（`https://cloudcode-pa.googleapis.com`）提供对 Gemini 模型的直接访问。遵循共享的 **Google Gemini CLI / Antigravity** 传输部分（`packages/ai/src/providers/google-gemini-cli.ts`）。

### 特殊情况
- **默认端点与标头**：将请求分派到 `https://cloudcode-pa.googleapis.com`，并通过 `getGeminiCliHeaders()` 发出标头（`packages/catalog/src/wire/gemini-headers.ts` 中的 `GeminiCLI/0.46.0/<modelId> ...`）。
- **思考传输**：通过 `google-level` `thinkingLevel` 传输映射 Gemini 思考（`packages/catalog/src/variant-collapse.ts` 中的 `GEMINI_CLI_VARIANT_COLLAPSE_TABLE`），不同于使用 `budget` 传输的 `google-antigravity`（`ANTIGRAVITY_VARIANT_COLLAPSE_TABLE`）。
- 标准请求管道：除了 Google Gemini CLI / Antigravity 传输管道之外没有任何内容。

### 认证与使用
- **OAuth 已安装应用流程**：通过 Google PKCE OAuth 2.0 授权，声明在 `packages/catalog/src/compat/rules/auth/google-gemini-cli.kdl`（`login "oauth-code"`，引擎 `packages/ai/src/registry/engine/oauth-code.ts`），回调端口 `8085`（`/oauth2callback`），请求 Google Cloud 作用域（`cloud-platform`、`userinfo.email`、`userinfo.profile`）。刷新在 `refresh` 下声明（`packages/ai/src/registry/engine/refresh.ts`），项目钩子在 `packages/ai/src/registry/oauth/google-gemini-cli.ts`。
- **项目发现与入驻**：`discoverProject`（`packages/ai/src/registry/oauth/google-gemini-cli.ts`）通过 `POST /v1internal:loadCodeAssist` 检查现有项目，并以 `$GOOGLE_CLOUD_PROJECT` / `$GOOGLE_CLOUD_PROJECT_ID` 作为回退。非免费层级（`legacy-tier`、`standard-tier`）或新账户会调用 `POST /v1internal:onboardUser` 并传入 `tierId`（`free-tier`、`legacy-tier`、`standard-tier`），并轮询 `pollOperation`（最多 `POLL_MAX_ATTEMPTS = 24` 次，间隔 5 秒）。检测 VPC-SC 限制（`isVpcScAffectedUser` 检查 `SECURITY_POLICY_VIOLATED`）。
- **配额与使用 provider**：`googleGeminiCliUsageProvider`（`packages/ai/src/usage/gemini.ts`）向 `loadCodeAssist` 和 `retrieveUserQuota`（`/v1internal:retrieveUserQuota`）发起 POST，将剩余桶比例映射为按模型层级（`3-Flash`、`Flash`、`Pro`，通过 `getModelTier`）分组的使用百分比。

### 目录模型处理
- **provider 描述符**：在 `CATALOG_PROVIDERS`（`packages/catalog/src/provider-models/descriptors.ts`）中注册，带有 `defaultModel: "gemini-3.1-pro-preview"` 和 `specialModelManager: true`，绕过标准模型工厂。
- **模型解析与发现**：`googleGeminiCliModelManagerOptions`（`packages/catalog/src/provider-models/google.ts`）使用 `GEMINI_CLI_VARIANT_COLLAPSE_TABLE` 对 Antigravity daily 端点调用 `fetchAntigravityDiscoveryModels`（`packages/catalog/src/discovery/antigravity.ts`），将结果过滤为 Gemini 模型，然后将 provider 改写为 `google-gemini-cli`，将推理 base URL 改写为 `https://cloudcode-pa.googleapis.com`。当 Antigravity 端点对该凭据未授权时（Gemini Code Assist Standard 返回 HTTP 403），它回退到 `fetchGeminiCliQuotaModels`（`packages/catalog/src/discovery/gemini-cli.ts`），后者根据账户自身在 Cloud Code Assist 上的 `retrieveUserQuota` 响应推导模型列表，并在 ID 已知时从捆绑目录填充元数据。
- **生成器集成与优先级**：如果 `google-antigravity` 访问不可用，则在 `fetchAntigravityModels`（`packages/catalog/scripts/generate-models.ts`）中充当回退 OAuth token provider。在 provider 优先级中排名第二（`packages/catalog/src/identity/priority.ts`）。

## Groq (`groq`)
Groq 使用 OpenAI Chat Completions 传输（`https://api.groq.com/openai/v1`），为开放权重模型提供由定制 LPU 硬件驱动的高速 LLM 推理。

### 特殊情况
- **上下文溢出**：当错误消息匹配 `OVERFLOW_PATTERNS`（`packages/ai/src/error/flags.ts`）中的 `/reduce the length of the messages/i` 时被检测到。
- **推理 effort 映射**：模型 `qwen/qwen3-32b` 通过 `GROQ_QWEN3_32B_REASONING_EFFORT_MAP`（`packages/catalog/src/model-thinking.ts`）将 `Minimal`、`Low`、`Medium`、`High` 和 `XHigh` 映射为 `"default"`。
- **多条系统消息**：通过 `supportsMultipleSystemMessagesDefault`（`packages/catalog/src/compat/openai.ts`）中的 `isGroqHost`，在 OpenAI 兼容性设置中默认为原生支持。

### 认证与使用
- **认证**：通过 `GROQ_API_KEY` 环境变量认证（`packages/catalog/src/provider-models/descriptors.ts`）。
- **provider 注册表**：在 `packages/catalog/src/compat/rules/auth/groq.kdl` 中声明，并编译进 `packages/ai/src/registry/registry.ts`。
- **优先级**：在 provider 优先级排序中列第 19 位（`packages/catalog/src/identity/priority.ts`）。

### 目录模型处理
- **主机匹配**：在主机定义（`packages/catalog/src/hosts.ts`）中通过 URL 标记 `api.groq.com` 或 provider `groq` 匹配。
- **管理器选项**：通过 `groqModelManagerOptions` 配置，目标为 `https://api.groq.com/openai/v1`（`packages/catalog/src/provider-models/openai-compat.ts`）。
- **默认模型**：默认为 `openai/gpt-oss-120b`（`packages/catalog/src/provider-models/descriptors.ts`）。

## Hugging Face Inference (`huggingface`)
Hugging Face Inference 使用指向 `https://router.huggingface.co/v1` 的 OpenAI Chat Completions 传输（`openai-completions`），提供对托管在 Hugging Face Hub 上的开源模型无服务器端点的访问。该 provider 支持跨包括 DeepSeek-R1 在内的模型进行无服务器 LLM 生成。

### 特殊情况
- **标准传输管道**：除了 OpenAI Chat Completions 管道之外没有任何内容（`packages/ai/src/providers/openai-completions.ts`）。

### 认证与使用
- **环境回退**：`getEnvApiKey`（`packages/ai/src/stream.ts`）中的环境变量解析会查阅 `CATALOG_PROVIDERS`（`packages/catalog/src/provider-models/descriptors.ts`）的 `envVars`，先检查 `HUGGINGFACE_HUB_TOKEN`，然后是 `HF_TOKEN`。
- **交互式 CLI 登录**：在 `packages/catalog/src/compat/rules/auth/huggingface.kdl` 中声明为 `login "api-key"` 规则（`packages/ai/src/registry/engine/api-key.ts`），用于提示输入细粒度用户访问 token（占位符 `hf_...`）。
- **细粒度 token 权限**：认证设置将用户引导至 `https://huggingface.co/settings/tokens/new?ownUserPermissions=inference.serverless.write&tokenType=fineGrained`（`packages/catalog/src/compat/rules/auth/huggingface.kdl` 中的 `AUTH_URL`），该链接会自动选择具有所需 "Make calls to Inference Providers" 权限（`inference.serverless.write`）的细粒度 token。
- **凭据校验**：在 `packages/catalog/src/compat/rules/auth/huggingface.kdl` 中声明，使用轻量聊天补全请求（`validate "chat-completions"`），针对 base URL `https://router.huggingface.co/v1` 和校验模型 `openai/gpt-oss-120b` 校验 API 密钥。

### 目录模型处理
- **provider 描述符**：在 `CATALOG_PROVIDERS`（`packages/catalog/src/provider-models/descriptors.ts`）中注册，带有 `id: "huggingface"`、`defaultModel: "deepseek-ai/DeepSeek-R1"`、环境回退 `envVars: ["HUGGINGFACE_HUB_TOKEN", "HF_TOKEN"]` 和 `catalogDiscovery: { label: "Hugging Face" }`。
- **模型管理器选项**：`packages/catalog/src/provider-models/openai-compat.ts` 中的 `huggingfaceModelManagerOptions` 通过 `createSimpleOpenAICompletionsOptions` 构造管理器选项，绑定默认 base URL `https://router.huggingface.co/v1`，并使用捆绑的参考规范（`mapWithBundledReference`）映射静态模型。
- **目录描述符**：`packages/catalog/src/provider-models/openai-compat.ts` 中的 `openAiCompletionsDescriptor` 在 `PROVIDER_DESCRIPTORS` 中注册 `huggingface`，目标为 `https://router.huggingface.co/v1`。
- **目录发现**：通过 `catalogDiscovery` 参与目录生成，`generate-models.ts`（`packages/catalog/scripts/generate-models.ts`）通过 `resolveProviderApiKey` 解析 API token，并对 `https://router.huggingface.co/v1/models` 调用 `fetchOpenAICompatibleModels`（`packages/catalog/src/discovery/openai-compatible.ts`），以发现可用的 Hub 推理端点。

## Kilo Gateway (`kilo`)
Kilo Gateway（`kilo`）是一个 AI 模型聚合与代理服务（`https://api.kilo.ai/api/gateway`），使用 OpenAI Chat Completions 传输（`api: "openai-completions"`）。它支持通过 `KILO_API_KEY` 或设备代码 OAuth 流程（`/login kilo`）进行认证，并允许从其 OpenAI 兼容的 `/models` 目录端点进行未认证的动态模型发现。

### 特殊情况
- **设备代码 OAuth 认证**：在 `packages/catalog/src/compat/rules/auth/kilo.kdl` 中声明（`login "custom" hook="kilo"`），并在 `packages/ai/src/registry/oauth/kilo.ts`（`loginKilo`）中实现，通过 `POST https://api.kilo.ai/api/device-auth/codes` 发起设备授权，返回用户 `code`、`verificationUrl` 和 `expiresIn` 秒数。它通过 `callbacks.onAuth` 显示说明，并每 5,000ms 轮询 `GET https://api.kilo.ai/api/device-auth/codes/<userCode>` 直到过期。处理 HTTP 202（待处理）、403/410（拒绝/过期）和速率限制（HTTP 429），在批准后（`pollData.status === "approved"`）返回有效期为 1 年的访问 token。通过 `callbacks.signal` 支持取消。
- **非标准主机分类**：`modelMatchesHost(hostModel, "kilo")` 在 `packages/catalog/src/compat/openai.ts` 中设置 `isKilo`，将 Kilo 归入非标准 OpenAI 兼容 provider（`isNonStandard`），以治理传输兼容行为。
- **主机 URL 匹配**：`packages/catalog/src/hosts.ts` 中的主机映射将 URL 标记 `api.kilo.ai` 与 provider `"kilo"` 关联。
- **provider 优先级**：包含在 `packages/catalog/src/identity/priority.ts` 的 provider 优先级序列中（`"opencode-go"`、`"kilo"`、`"vercel-ai-gateway"`）。

### 认证与使用
- **API 密钥与 OAuth token**：通过静态环境变量 `KILO_API_KEY` 或经设备代码流程（`/login kilo`）签发的 OAuth 访问 token 进行认证。
- **Bearer token 标头**：请求以标准 Bearer token（`Authorization: Bearer <key>`）携带凭据，目标 base URL 为 `https://api.kilo.ai/api/gateway`。

### 目录模型处理
- **provider 描述符**：在 `packages/catalog/src/provider-models/descriptors.ts` 中注册，带有 `defaultModel: "anthropic/claude-opus-4.8"`、环境变量 `KILO_API_KEY` 和 `catalogDiscovery: { label: "Kilo Gateway", allowUnauthenticated: true }`，从而无需 API 密钥即可进行目录发现。
- **模型管理器与 wire 描述符**：`packages/catalog/src/provider-models/openai-compat.ts` 中的 `kiloModelManagerOptions` 将 `providerId: "kilo"` 映射到 base URL `https://api.kilo.ai/api/gateway`，并将动态模型发现委托给 `fetchOpenAICompatibleModels`。与 `openAiCompletionsDescriptor("kilo", "kilo", "https://api.kilo.ai/api/gateway")` 关联。
- **思考配置**：经由 Kilo 路由的模型（例如 `moonshotai/kimi-k2.6`）继承标准 OpenAI 风格的思考格式解析（`compat.thinkingFormat = "openai"`）。

## Kimi Code (`kimi-code`)
Kimi Code 通过 Moonshot AI 的 `/coding/v1` API 端点提供对 Kimi 模型（`kimi-for-coding`、`k3`）的订阅支持访问。它遵循 [Kimi Code](#kimi-code) 传输管道，将请求执行委托给 `streamKimi`（`packages/ai/src/providers/kimi.ts`）和 `streamOpenAIAnthropicShim`（`packages/ai/src/providers/openai-anthropic-shim.ts`）。

### 特殊情况
- **提示词缓存键共享**：`isKimiModel`（`packages/ai/src/providers/kimi.ts`）控制提示词缓存；Anthropic 兼容（`packages/ai/src/providers/anthropic.ts:3480`）和 OpenAI 兼容（`packages/ai/src/providers/openai-completions.ts:1508`）请求都会附加通过 `getOpenAIPromptCacheKey` 派生的 `prompt_cache_key`，以在传输切换时共享亲和身份。
- **通用标头前置**：`packages/ai/src/providers/openai-completions.ts` 中的 `prependHeaders` 将 `getKimiCommonHeaders()`（`packages/ai/src/registry/oauth/kimi.ts`）注入所有 `kimi-code` 请求。
- **Schema 校验与工具选择**：通过 `isMoonshotNative`（`packages/catalog/src/hosts.ts`）匹配，强制 `toolSchemaFlavor: "moonshot-mfjs"`（`packages/catalog/src/compat/openai.ts`）。强制思考模型（`kimi-for-coding`、`k3`）在 Anthropic 兼容中解析为 `requiresThinkingEnabled = true`（`packages/catalog/src/compat/anthropic.ts`），将强制工具选择降级为 `auto`。
- **推理守卫**：`stream.ts:1214` 在执行前检查 `isKimiModel`，在 K3 上禁用不支持的推理配置（`packages/ai/src/providers/openai-completions.ts:1454`）。

### 认证与使用
- **设备 OAuth 流程**：在 `packages/catalog/src/compat/rules/auth/kimi-code.kdl` 中声明为 `login "device-code"` 规则（`packages/ai/src/registry/engine/device-code.ts`），标头钩子在 `packages/ai/src/registry/oauth/kimi.ts`。使用 OAuth 2.0 设备代码授权（`client-id` `17e5f671-d194-4dfb-9706-5516cb48c098`），针对 base URL `https://auth.kimi.com`（可通过 `KIMI_CODE_OAUTH_HOST` 或 `KIMI_OAUTH_HOST` 覆盖）。
- **指纹识别与设备持久化**：`getKimiCommonHeaders()` 注入跟踪标头（`User-Agent: KimiCLI/<ver>`、`X-Msh-Platform`、`X-Msh-Version`、`X-Msh-Device-Name`、`X-Msh-Device-Model`、`X-Msh-Os-Version`、`X-Msh-Device-Id`）。`getDeviceId` 将随机十六进制 UUID 持久化到 `path.join(getAgentDir(), "kimi-device-id")`（模式 `0600`），若文件写入失败则回退到内存中的临时 UUID。
- **使用与配额跟踪器**：`kimiUsageProvider`（`packages/ai/src/usage/kimi.ts`）为 OAuth 凭据获取 `GET /coding/v1/usages`（`https://api.kimi.com/coding/v1/usages`，可通过 `KIMI_CODE_BASE_URL` 配置）。当 token 过期（`credential.expiresAt <= nowMs`）时短路。将 `usage` 和 `limits` 解析为 `UsageLimit` 条目，在窗口重置时间缺失时把行级重置时间戳（`reset_at`、`resetTime`、`ttl`）带到窗口对象上。

### 目录模型处理
- **provider 描述符**：在 `CATALOG_PROVIDERS`（`packages/catalog/src/provider-models/descriptors.ts`）中注册，带有 `id: "kimi-code"`、`defaultModel: "kimi-for-coding"`、发现标签 `"Kimi Code"` 和 `envVars: ["KIMI_API_KEY"]`。委托选项通过 `kimiCodeModelManagerOptions` 构建。
- **动态模型发现**：`kimiCodeModelManagerOptions`（`packages/catalog/src/provider-models/openai-compat.ts`）使用 `KimiCLI/1.0` 标头，通过 `fetchOpenAICompatibleModels` 查询 `/coding/v1/models`。通过 `kimiSupportsReasoning`、`mapKimiThinking` 和 `mapKimiApiFormat`（将 `compat.kimiApiFormat` 设为 `"anthropic"` 或 `"openai"`）映射模型。
- **按系列划分的输出上限**：`kimiCodeMaxTokens`（`packages/catalog/src/provider-models/openai-compat.ts`）按 ID 派生输出上限：`k3`/`k3-256k` 为 131,072（`KIMI_CODE_K3_MAX_TOKENS`），`kimi-for-coding`/`kimi-for-coding-highspeed` 为 32,768（`KIMI_CODE_FOR_CODING_MAX_TOKENS`），旧版 K2 行的回退值为 32,000（`KIMI_CODE_DEFAULT_MAX_TOKENS`）。在静态生成期间应用（`packages/catalog/scripts/generate-models.ts`）。

## LiteLLM (`litellm`)
LiteLLM 是一个开源 AI 代理与网关，在 OpenAI 兼容 API 主机之后统一对多个 LLM provider 的访问。在 `pi` 中，它使用 OpenAI Chat Completions（`openai-completions`）传输管道运行。

### 特殊情况
- **推理回放排除（`packages/catalog/src/compat/openai.ts`）**：列于 `PROXY_OPENAI_COMPAT_PROVIDERS`。与原生本地运行时（`llama.cpp`、`vllm`）不同，`replayReasoningContent` 默认为 `false`，因为 LiteLLM 代理会将轮次路由到任意上游 provider（例如 Anthropic、OpenAI），在这些地方回放 `reasoning_content` 会触发 HTTP 400 错误。
- **回环流超时下限（`packages/catalog/src/compat/openai.ts`）**：尽管 LiteLLM 被排除在 `isLocalOpenAICompatBackend` 之外，回环/RFC1918 URL（`localhost`、`127.0.0.1`）仍参与 `hasLocalLoopbackBaseUrl`，保留本地流超时下限，以避免在为缓慢的本地后端前置时过早触发 prefill 超时。
- **Anthropic 与 Bedrock 工具兼容性（`packages/ai/src/providers/openai-completions.ts`）**：
  - 当 `context.tools` 为 `undefined` 但会话历史包含工具调用时，为兼容 Anthropic-via-LiteLLM 将 `params.tools` 设为 `[]`。
  - 当 `context.tools` 显式为空（`[]`，例如 `/btw` 或后台轮次）时，省略 `params.tools` 和 `tool_choice: "none"`，以免 LiteLLM → Bedrock 路由生成无效的空 `toolConfig` 块。
- **遥测与网关标头检测（`packages/agent/src/telemetry.ts`、`packages/ai/src/auth-gateway/http.ts`）**：`detectGatewayFromHeaders` 检查 `x-litellm-call-id`（回退到 `x-litellm-model-id` 或 `x-litellm-model-group`）以填充 `pi.gen_ai.gateway.*` span 属性。Auth gateway HTTP 端点暴露 `x-litellm-model-id`、`x-litellm-model-api-base`、`x-litellm-response-cost` 和 `x-litellm-response-duration-ms`。

### 认证与使用
- **凭据与环境（`packages/catalog/src/provider-models/descriptors.ts`、`packages/catalog/src/compat/rules/auth/litellm.kdl`）**：通过 `LITELLM_API_KEY` 认证。
- **登录引导（`packages/catalog/src/compat/rules/auth/litellm.kdl`）**：声明为 `login "api-key"` 规则（`packages/ai/src/registry/engine/api-key.ts`），将用户引导到设置文档（`https://docs.litellm.ai/docs/proxy/deploy`），提示输入主密钥/虚拟密钥（`sk-...`），并注明用 `LITELLM_BASE_URL` 指定自定义代理端点。CLI `login` 委托给 `SqliteAuthCredentialStore.login()`。
- **默认 base URL（`packages/catalog/src/provider-models/cache-provider-id.ts`）**：解析为 `Bun.env.LITELLM_BASE_URL` 或 `http://localhost:4000/v1`。

### 目录模型处理
- **捆绑目录排除（`packages/scripts/generate-models.ts`）**：包含在 `DISCOVERY_ONLY_PROVIDERS` 中。LiteLLM 模型被排除在静态 `models.json` 生成之外，以避免泄漏开发者 localhost 端点。
- **富管理端点发现（`packages/catalog/src/provider-models/openai-compat.ts`）**：`fetchLiteLLMRichModels` 探测 `/model_group/info`、`/v2/model/info`、`/model/info` 和 `/v1/model/info`。它过滤哨兵占位 ID（`all-team-models`、`all-proxy-models`、`no-default-models`）和已知的特定任务模式（`audio_speech`、`audio_transcription`、`batch`、`embedding`、`guardrail`、`image_edit`、`image_generation`、`moderation`、`ocr`、`rerank`、`search`、`vector_store`、`video_generation`），同时保留 null、缺失、畸形和未知模式。它解析上下文限制（`max_input_tokens`）、输出限制（`max_output_tokens`）、`supports_vision`、`supports_reasoning`、`supported_openai_params`（映射 `reasoning_effort`）以及按 token 定价（`input_cost_per_token`、`output_cost_per_token`、映射为 $/百万 token 的缓存读取/写入成本）。
- **回退发现与显示名称（`packages/catalog/src/provider-models/openai-compat.ts`）**：如果富端点失败，发现会回退到 `/v1/models`（`fetchOpenAICompatibleModels`），应用相同的模式过滤，并依据 `models.dev` 参考解析规范。从显示名称中剥离经销商乘数后缀（例如 `(1.5x usage)`）。
- **兼容性覆盖（`packages/catalog/src/provider-models/openai-compat.ts`）**：为所有解析出的模型硬编码 `compat.supportsStore: false` 和 `compat.supportsDeveloperRole: false`。

## LM Studio (`lm-studio`)
LM Studio 是运行在用户硬件上的本地 OpenAI 兼容模型服务器（默认 `http://127.0.0.1:1234/v1`）。它使用 [OpenAI Chat Completions](#openai-chat-completions) 传输（`api: "openai-completions"`）来流式传输聊天补全和工具调用。

### 特殊情况
- **仅字符串的命名工具选择**：在 `STRING_ONLY_NAMED_TOOL_CHOICE_PROVIDERS`（`packages/catalog/src/compat/openai.ts`）中注册，`supportsNamedToolChoice: false`。对象式强制工具选择（`{ type: "function", function: { name: "..." } }`）被降级为 `"required"`，同时声明的 `tools` 列表被收窄为单个强制工具。
- **语法 schema 规范化**：在目录兼容中配置 `toolSchemaFlavor: "grammar"`（`packages/catalog/src/compat/openai.ts`）。工具 JSON schema 通过 `sanitizeSchemaForGrammar`（`packages/ai/src/utils/schema/normalize.ts`）清理，将属性位置的裸布尔 `true` 或 `{}` 子 schema 拓宽为原始类型联合，以避免 GBNF 语法解析器失败（`Unrecognized schema: true`，issue #5914）。
- **回放推理内容与仅追加上下文**：包含在 `LOCAL_OPENAI_COMPAT_PROVIDERS`（`packages/catalog/src/compat/openai.ts`）和 `LOCAL_INFERENCE_PROVIDERS`（`packages/coding-agent/src/config/append-only-context-mode.ts`）中。会为本地推理模型自动启用 `replayReasoningContent`，以便在本地聊天模板中跨轮次将 `<think>` 块保留在 `reasoning_content` 中，从而命中 KV 缓存；对于 Qwen 思考方言也会启用 `qwenPreserveThinking`。
- **静态目录生成器排除**：列于 `DISCOVERY_ONLY_PROVIDERS`（`scripts/generate-models.ts`）和 `LOCAL_ONLY_PROVIDERS`（`test/models-json-no-local-endpoints.test.ts`），确保本地端点从不在构建期间被抓取，也不会提交到静态 `models.json`。

### 流行为
- **看门狗超时下限**：配置 `streamFirstEventTimeoutMs: 0`（`packages/catalog/src/compat/openai.ts`），在本地模型长时间冷加载或提示词 prefill 期间禁用响应前的首事件看门狗，并设置 `streamIdleTimeoutMs: 300_000`（300 秒事件间隔下限；参见 [Provider compat reference](./provider-compat-reference.md)），以防止在缓慢的 token 生成期间取消流。

### 认证与使用
- **无密钥本地认证**：在 `packages/catalog/src/compat/rules/auth/lm-studio.kdl` 中定义为无密钥 provider（`empty-fallback "lm-studio-local"`，`packages/catalog/src/provider-models/descriptors.ts` 中 `allowUnauthenticated: true`）。未提供 `LM_STUDIO_API_KEY` 时使用占位符 `"lm-studio-local"`。
- **端点与凭据**：Base URL 默认为 `http://127.0.0.1:1234/v1` 或 `LM_STUDIO_BASE_URL`。交互式 CLI 登录在 `packages/catalog/src/compat/rules/auth/lm-studio.kdl` 中声明为 `login "api-key"` 规则（`packages/ai/src/registry/engine/api-key.ts`）。
- **使用量核算**：采用标准 OpenAI Chat Completions 使用量核算（`packages/ai/src/providers/openai-shared.ts` 中的 `calculateOpenAIUsageAccounting`）。

### 目录模型处理
- **隐式与动态发现**：未配置时，`ModelRegistry`（`packages/coding-agent/src/config/model-registry.ts`）自动将 `lm-studio` 注册为隐式可发现 provider。动态模型解析（`packages/catalog/src/provider-models/openai-compat.ts` 中的 `lmStudioModelManagerOptions` / `packages/coding-agent/src/config/model-discovery.ts` 中的 `discoverLmStudioModels`）查询 `/v1/models`。
- **原生元数据探测**：通过 `fetchLmStudioNativeModelMetadata` 探测 LM Studio 的原生端点 `/api/v0/models`（使用 `LM_STUDIO_NATIVE_METADATA_TIMEOUT_MS = 250`）。当 `type === "vlm"` 或能力包含 `vision`/`image` 时设置 `input: ["text", "image"]`（在发现期间设置 `imageInputDecoder: "stb"`）。
- **已加载上下文长度**：`getLmStudioNativeContextWindow` 对活动模型优先使用 `loaded_context_length`，而非架构上限（`max_context_length`、`context_length`、`max_model_len`），确保上下文窗口限制准确反映当前的 VRAM/RAM 分配。

## Meta Model API (`meta`)
Meta Model API 是 Meta 的商业 API 平台，托管 `muse-spark-1.1` 等第一方模型。它通过面向 `https://api.meta.ai/v1` 的 OpenAI Responses 传输与模型服务交互。

### 特殊情况
- **输出 token 钳制绕过**：`resolveOpenAIResponsesOutputClamp`（`packages/ai/src/providers/openai-shared.ts`）检查 `model.provider === "meta"`，以允许 Meta 请求最多输出 `model.maxTokens`（131,072 token），而不受默认 64,000 token 上限（`OPENAI_MAX_OUTPUT_TOKENS`）的限制。

### 认证与使用
- **API 密钥登录**：在 `packages/catalog/src/compat/rules/auth/meta.kdl` 中声明为 `login "api-key"` 规则（`packages/ai/src/registry/engine/api-key.ts`），仪表盘 URL 为 `https://developer.meta.com/ai/`。校验向 `https://api.meta.ai/v1/models` 发起 GET 请求（`validate "models-endpoint"`）。
- **环境变量**：密钥解析先检查 `MODEL_API_KEY`，回退到 `META_API_KEY`（`packages/catalog/src/provider-models/descriptors.ts`）。

### 目录模型处理
- **描述符与管理**：在 `CATALOG_PROVIDERS`（`packages/catalog/src/provider-models/descriptors.ts`）中定义，带有 `defaultModel: "muse-spark-1.1"`。使用 `metaModelManagerOptions`（`packages/catalog/src/provider-models/openai-compat.ts`），通过 `createOpenAICompatibleModelManagerOptions` 构造（`api: "openai-responses"`、`providerId: "meta"`、`defaultBaseUrl: "https://api.meta.ai/v1"`、`mapModel: mapWithBundledReference`）。
- **静态捆绑模型**：`META_MUSE_STATIC_MODELS`（`packages/catalog/src/provider-models/openai-compat.ts`）定义 `muse-spark-1.1`：
  - 1,048,576 token 上下文窗口与 131,072 token 最大输出限制。
  - 多模态输入支持（`text`、`image`）。
  - 启用推理，带有基于 effort 的思考级别（`minimal`、`low`、`medium`、`high`、`xhigh`）。
  - 兼容性标志 `supportsReasoningEffort: true` 和 `includeEncryptedReasoning: true`。

## MiniMax (`minimax`)
MiniMax 提供基础模型（包括 MiniMax-M3 和 M2 代），可通过区域性的国际（`api.minimax.io`）与中国大陆（`api.minimaxi.com`）端点访问。传输取决于描述符类型：标准 `minimax` 和 `minimax-cn` 使用 "Anthropic Messages"（`/anthropic`），而 MiniMax Token Plan 的 `minimax-code` 和 `minimax-code-cn` 使用 "OpenAI Chat Completions"（`/v1`）。

### 特殊情况
- **累积推理增量**：`packages/catalog/src/compat/openai.ts` 中的 `MINIMAX_PROVIDER_OR_ID_PATTERN` 为任何匹配 `/minimax/i` 的 provider 或模型 ID 标记 `reasoningDeltasMayBeCumulative: true`，防止流重新发送累积思考文本时出现重复推理内容。
- **对象工具参数**：`packages/ai/src/providers/openai-completions.ts` 中的 `streamOpenAICompletions` 拦截那些以原始 JSON 对象而非标准 JSON 字符串流式传输 `function.arguments` 的 MiniMax 兼容主机，将对象增量深度合并到 `block.partialArgs`，并在 `toolcall_end` 之前的 `finishToolCallBlock` 处序列化为单个可安全拼接的字符串增量。
- **单条系统消息约束**：`packages/catalog/src/compat/openai.ts` 中的 `isMiniMaxHost`（在 `packages/catalog/src/hosts.ts` 中匹配 `api.minimax.io` 和 `api.minimaxi.com`）将 `supportsMultipleSystemMessagesDefault` 设为 `false`，要求将系统提示词合并为单条系统消息。
- **思考 effort 限制**：`packages/catalog/src/identity/family.ts` 中的 `isMinimaxM2FamilyModelId` 为 M2/M3 模型强制允许的 `reasoning_effort` 为 `low|medium|high`，并拒绝 `minimal`/`xhigh`。
- **带内 XML 方言**：`packages/ai/src/dialect/minimax.ts` 为回退 XML 工具调用解析注册 `minimax` 方言（`<minimax:tool_call>`）。
- **网关 API 覆盖**：`packages/catalog/src/provider-models/openai-compat.ts` 中的 `OPENCODE_ZEN_API_RESOLUTION` 和 `OPENCODE_GO_API_RESOLUTION` 强制 OpenCode 网关上的 `minimax-m3` / `minimax-m3-free` / `minimax-m2.7` 经由 `openai-completions` 在 `/v1/chat/completions` 上路由，而不是 Anthropic 的 `/v1/messages`。

### 认证与使用
- **认证密钥**：使用 `packages/catalog/src/provider-models/descriptors.ts` 中声明的 `MINIMAX_API_KEY`（`minimax`）、`MINIMAX_CODE_API_KEY`（`minimax-code`）和 `MINIMAX_CODE_CN_API_KEY`（`minimax-code-cn`）。
- **Token Plan 登录**：在 `packages/catalog/src/compat/rules/auth/minimax-code.kdl` 和 `minimax-code-cn.kdl` 中声明为 `login "api-key"` 规则（`packages/ai/src/registry/engine/api-key.ts`），驱动提示链接到 `https://platform.minimax.io/subscribe/token-plan`（国际）和 `https://platform.minimaxi.com/subscribe/token-plan`（中国），并针对模型 `MiniMax-M3` 校验 API 密钥设置。
- **使用配额**：`packages/ai/src/usage/minimax-code.ts` 中的 `minimaxCodeUsageProvider` 在 `https://api.minimax.io`（或中国等效端点）轮询 `GET /v1/token_plan/remains`，按计划桶解析滚动间隔和每周使用窗口为剩余百分比，供 `omp usage` 使用。

### 目录模型处理
- **默认模型**：在 `packages/catalog/src/provider-models/descriptors.ts` 中设置 `MiniMax-M3`（`minimax`、`minimax-code`、`minimax-code-cn`）。
- **上下文窗口策略**：`scripts/generated-policies.ts` 将 `minimax`、`minimax-cn`、`minimax-code` 和 `minimax-code-cn` 的 `MiniMax-M3` 上下文限制覆盖为 1,000,000 token，以文档记载的 1M 长上下文层级优先于上游定价边界。
- **OpenAI completions 标志**：`packages/catalog/src/provider-models/openai-compat.ts` 中的 `openAiCompletionsDescriptor` 配置 `supportsStore: false`、`supportsDeveloperRole: false`、`supportsReasoningEffort: false` 和 `reasoningContentField: "reasoning_content"`。

## MiniMax Token Plan (`minimax-code`)
MiniMax Token Plan provider（`minimax-code`，及其中国大陆区域变体 `minimax-code-cn`）使用 HTTP POST SSE 上的 OpenAI Chat Completions 传输（国际为 `https://api.minimax.io/v1`，中国为 `https://api.minimaxi.com/v1`），提供对 `MiniMax-M3` 和 `MiniMax-M2.5` 等 MiniMax 订阅模型的访问。与普通 `minimax`（使用标准静态 API 密钥认证、经由 Anthropic Messages 传输路由）相比，`minimax-code` 使用交互式订阅登录流程，并通过 `omp usage` 提供 token plan 配额监控。

### 特殊情况
- **与普通 `minimax` 的传输差异**：普通 `minimax`（`minimax` / `minimax-cn`）通过 `anthropic-messages` 传输（`https://api.minimax.io/anthropic`）通信，而 `minimax-code`（`minimax-code` / `minimax-code-cn`）指向 `openai-completions` 传输（`/v1/chat/completions`）。
- **流式对象工具调用参数**：`packages/ai/src/providers/openai-completions.ts` 中的 `mergeStreamingArgumentObjects` 处理以部分 JSON 对象而非标准 OpenAI JSON 字符串流式传输 `function.arguments` 的 MiniMax 后端，跨增量深度合并对象属性，以防止 `[object Object]` 字符串强制转换。
- **推理内容与 think 标签去重**：配置 `reasoningContentField: "reasoning_content"`（`packages/catalog/src/provider-models/openai-compat.ts`）。该 provider 将内联 `<think>`...`</think>` 标签解析为思考块，同时对 MiniMax-M3 累积推理快照去重，以防止在可见答案内容开始后重新发出思考文本。
- **兼容标志限制**：OpenAI 兼容性策略显式禁用 `store`、开发者系统角色和推理 effort 控制（`packages/catalog/src/provider-models/openai-compat.ts` 中的 `supportsStore: false`、`supportsDeveloperRole: false`、`supportsReasoningEffort: false`）。

### 认证与使用
- **交互式订阅登录流程**：在 `packages/catalog/src/compat/rules/auth/minimax-code.kdl` 中声明为 `login "api-key"` 规则（`packages/ai/src/registry/engine/api-key.ts`）。这是交互式 API 密钥提示：它指向订阅门户（`https://platform.minimax.io/subscribe/token-plan`），提示输入密钥（`sk-...`），并使用 `MiniMax-M3` 通过 `POST /v1/chat/completions` 请求（`validate "chat-completions"`）校验该密钥。
- **环境变量**：国际 `minimax-code` 从 `MINIMAX_CODE_API_KEY` 解析凭据，中国 `minimax-code-cn` 从 `MINIMAX_CODE_CN_API_KEY` 解析（普通 `minimax` 解析 `MINIMAX_API_KEY` / `MINIMAX_CN_API_KEY`）。
- **Token Plan 配额跟踪**：`packages/ai/src/usage/minimax-code.ts` 中的 `minimaxCodeUsageProvider` 使用 `Authorization: Bearer ${apiKey}` 查询 `GET /v1/token_plan/remains`。
- **配额指标解析与规范化**：将 `model_remains[]` 条目解析为滚动间隔窗口（`current_interval_*`）和 7 天窗口（`current_weekly_*`）。共享计划配额 `general` 的作用域为 `{ shared: true }`。通过 `(100 - remainingPercent) / 100` 计算 `usedFraction`，并在 `current_*_status === 2`（`STATUS_EXHAUSTED`）时覆盖状态。计划外模型（状态 3 `STATUS_UNLIMITED` 且总量为零）被过滤到 `metadata.unavailableModels` 中。通过 `base_resp.status_code === 0` 校验成功，以捕获在 HTTP 200 响应下返回的 API 错误。

### 目录模型处理
- **provider 描述符**：在 `packages/catalog/src/provider-models/descriptors.ts` 中注册（`id: "minimax-code"`、`id: "minimax-code-cn"`），默认为 `MiniMax-M3`。
- **目录接线**：`packages/catalog/src/provider-models/openai-compat.ts` 中的 `openAiCompletionsDescriptor` 注册描述符 `"minimax-coding-plan"` 和 `"minimax-cn-coding-plan"`，绑定到 base URL `https://api.minimax.io/v1` 和 `https://api.minimaxi.com/v1`。
- **1M 上下文层级覆盖**：策略生成（`packages/catalog/scripts/generated-policies.ts`）显式将 `minimax-code` 和 `minimax-code-cn` 的 `MiniMax-M3` 上下文窗口覆盖为文档记载的 1,000,000 token 层级，而不是上游 512,000 token 定价边界。
- **主机匹配**：`packages/catalog/src/hosts.ts` 中的 provider 主机映射将 `urlMarkers` `api.minimax.io` 和 `api.minimaxi.com` 与 `minimax`、`minimax-code` 和 `minimax-code-cn` 关联。

## MiniMax Token Plan (China) (`minimax-code-cn`)
MiniMax Token Plan (China) 使用 OpenAI Chat Completions 传输（`openai-completions`）为中国大陆订阅者提供对 MiniMax 模型的访问。它连接到中国区域端点以进行订阅引导、API 密钥校验和模型执行。

### 特殊情况
- **流式参数深度合并**：`packages/ai/src/providers/openai-completions.ts` 中的 `mergeStreamingArgumentObjects` 处理以原始 JSON 对象而非标准 OpenAI JSON 字符串流式传输 `function.arguments` 的 MiniMax 后端，跨流块递归合并部分对象增量，既不失败也不将参数强制转换为 `[object Object]`（`test/issue-1776-repro.test.ts`、`test/issue-2080-repro.test.ts`）。
- **推理去重与 think 标签**：内容流中投递的 `<think>` 标签被规范化为思考块（`test/issue-1203-repro.test.ts`），而 `packages/ai/src/dialect/demotion.ts` 中的 `lastCumulativeReasoningBySignature` 和 `streamOpenAICompletionsOnce`（`packages/ai/src/providers/openai-completions.ts`）在文本块转换之间对 `MiniMax-M3` 的累积推理快照去重。
- **不支持功能剥离**：请求省略不支持的思考选项（`test/issue-955-repro.test.ts`），并在 `packages/catalog/src/provider-models/openai-compat.ts` 中应用静态兼容性覆盖（`supportsStore: false`、`supportsDeveloperRole: false`、`supportsReasoningEffort: false`、`reasoningContentField: "reasoning_content"`）。

### 认证与使用
- **API 密钥与交互式登录**：通过 `MINIMAX_CODE_CN_API_KEY` 认证（`packages/catalog/src/provider-models/descriptors.ts`）。交互式登录在 `packages/catalog/src/compat/rules/auth/minimax-code-cn.kdl` 中声明为 `login "api-key"` 规则（`packages/ai/src/registry/engine/api-key.ts`），指向 `https://platform.minimaxi.com/subscribe/token-plan`，并针对 `https://api.minimaxi.com/v1` 通过 `MiniMax-M3` 补全检查校验粘贴的密钥。
- **端点与主机检测**：API 请求指向 `https://api.minimaxi.com/v1`（`packages/catalog/src/models.json`）。在 `packages/catalog/src/hosts.ts` 中，`urlMarkers` 在 `minimax` 主机分类下包含 `api.minimaxi.com`。
- **使用遥测可用性**：与 `minimax-code`（通过 `packages/ai/src/usage/minimax-code.ts` 中的 `minimaxCodeUsageProvider` 从 `https://api.minimax.io/v1/token_plan/remains` 获取配额剩余百分比）不同，`minimax-code-cn` 没有注册使用 provider（`packages/ai/src/auth-storage.ts` 和 `test/minimax-token-plan-usage.test.ts` 中 `storage.usageProviderFor("minimax-code-cn")` 返回 `undefined`），因此中国区域账户的使用遥测被禁用。

### 目录模型处理
- **默认模型**：在 `CATALOG_PROVIDERS`（`packages/catalog/src/provider-models/descriptors.ts`）中配置默认为 `MiniMax-M3`。
- **1M 上下文窗口覆盖**：`packages/catalog/scripts/generated-policies.ts` 将 `minimax-code-cn`（连同 `minimax-code`、`minimax` 和 `minimax-cn`）的 `MiniMax-M3` 上下文窗口从上游 512K 定价边界覆盖为 1,000,000（1M）token（`model.contextWindow = 1_000_000`）。
- **目录策略覆盖**：`generated-policies.ts` 从 `model.compat` 中移除 `thinkingFormat`，并强制 `reasoningContentField: "reasoning_content"`、`supportsStore: false`、`supportsDeveloperRole: false` 和 `supportsReasoningEffort: false`。

## Mistral (`mistral`)
Mistral AI 通过 `api.mistral.ai/v1` 提供对 Mistral、Codestral、Devstral、Ministral 和 Pixtral 模型的访问。请求使用 OpenAI Chat Completions 传输（`openai-completions`）。

### 特殊情况
- **兼容集群（`packages/catalog/src/compat/openai.ts`：`isMistral`）**：
  - `requiresMistralToolIds` / `toolCallIdKind: "mistral-9-alnum"`（`packages/ai/src/providers/openai-shared.ts`）：将工具调用 ID 限制为 9 个字符的字母数字字符串（`[a-zA-Z0-9]{9}`）。
  - `requiresAssistantAfterToolResult`：在工具结果消息之后、后续内容之前合成一条助手消息桥（`packages/ai/src/providers/openai-completions.ts`）。
  - `requiresToolResultName`：强制工具结果消息上的工具函数 `name` 属性（`packages/ai/src/providers/openai-completions.ts`）。
  - `requiresThinkingAsText`：将推理和思考内容格式化为纯文本块，而不是原生推理字段（`packages/catalog/src/compat/openai.ts`）。
  - `maxTokensField: "max_tokens"`：在请求负载中发出 `max_tokens` 而不是 `max_completion_tokens`（`packages/catalog/src/compat/openai.ts`）。
- **数组式 `delta.content` 流式规范化（`packages/ai/src/providers/openai-completions.ts`：`normalizeStreamingContentText`）**：解包模型（例如 `mistral-medium-2604`）以类型化数组（`[{ type: "text", text: "..." }]`）投递 `delta.content` 的流式响应块，防止 `[object Object]` 字符串强制转换缺陷。

### 认证与使用
- **认证**：使用来自 `MISTRAL_API_KEY` 环境变量的 bearer token 认证（`packages/catalog/src/provider-models/descriptors.ts`：`mistral`）。
- **使用跟踪**：标准 OpenAI chat completions 使用解析（`packages/ai/src/providers/openai-completions.ts`）。

### 目录模型处理
- **provider 描述符**：通过 `mistralModelManagerOptions` 配置，指向 `https://api.mistral.ai/v1`（`packages/catalog/src/provider-models/openai-compat.ts`），默认模型为 `devstral-medium-latest`（`packages/catalog/src/provider-models/descriptors.ts`）。
- **主机匹配**：主机 URL 标记匹配检查 `mistral.ai`（`packages/catalog/src/hosts.ts`：`mistral`）。

## Moonshot (`moonshot`)
Moonshot 是 Moonshot AI 端点（`https://api.moonshot.ai/v1` 或中国大陆 `https://api.moonshot.cn/v1`）的按量付费开放平台 provider。它使用 `OpenAI Chat Completions` 传输引擎（`openai-completions` API 表面），并共享 Kimi 系列方言与思考机制（`packages/catalog/src/identity/family.ts` 中的 `isKimiModelId`）。它与使用订阅设备 OAuth 和订阅端点（`api.kimi.com` / `/coding/v1/*`）的 `kimi-code` 不同。

### 特殊情况
- **`MOONSHOT_BASE_URL` 覆盖**：`resolveOpenAIRequestSetup`（`packages/ai/src/providers/openai-shared.ts`）用 `$env.MOONSHOT_BASE_URL` 覆盖默认目录 base URL（`api.moonshot.ai/v1`）（例如，为中国大陆平台用户使用 `https://api.moonshot.cn/v1`，其密钥会被国际端点拒绝；issue #2883）。
- **Moonshot 风格 JSON Schema（`moonshot-mfjs`）**：对于原生 Moonshot 主机（`packages/catalog/src/hosts.ts` 中的 `moonshotNative`）和 Kimi 模型 ID（`isKimiModel`），`toolSchemaFlavor` 通过 `buildOpenAICompat`（`packages/catalog/src/compat/openai.ts`）默认为 `"moonshot-mfjs"`。`normalizeSchemaForMoonshot`（`packages/ai/src/utils/schema/normalize.ts`）在 `packages/ai/src/providers/openai-completions.ts` 和 `openai-responses.ts` 中规范化工具参数（将 `const` 折叠为 `enum`、为裸枚举推断 `type`、剥离不支持的结构），以防止 HTTP 400 校验失败（`tools.function.parameters is not a valid moonshot flavored json schema`）。
- **Z.AI 思考格式与保留思考**：`packages/catalog/src/compat/openai.ts` 中的 `isMoonshotKimi` 设置 `thinkingFormat: "zai"`。对于 `kimi-k2.6`（以及 `kimi-k2.x` 模型），启用 `thinkingKeep: "all"`（`compat/openai.ts` 中的 `usesMoonshotKimiPreservedThinking`）。活动推理轮次在 `openai-completions.ts` 中发出 `thinking: { type: "enabled", keep: "all" }`（禁用时为 `{ type: "disabled" }`）（`issues #1838`、`#2113`）。K3 模型通过 `MOONSHOT_KIMI_K3_THINKING` 使用 OpenAI 风格的 `reasoning_effort: "max"`（`packages/catalog/src/provider-models/openai-compat.ts`）。
- **流标记修复与带内控制标签**：`modelMayLeakKimiToolCalls`（`packages/ai/src/utils/stream-markup-healing.ts`）和 `detectStreamMarkupHealingPattern`（`packages/catalog/src/compat/openai.ts`）对 `provider === "moonshot"` 返回 `"kimi"`，从而启用对原始带内控制标签（`<|tool_calls_section_begin|>` 等）的流解析。
- **最大 token 输出上限与强制 token**：`alwaysSendMaxTokens`（`packages/catalog/src/compat/openai.ts`）在每次 Kimi 请求上强制 `max_tokens`，因为 Moonshot 根据 `max_tokens` 计算 TPM 速率限制。`resolveOpenAIRequestSetup`（`packages/ai/src/providers/openai-shared.ts`）将 K3 模型（`isKimiK3ModelId`）的 `max_tokens` 上限设为 `131_072`。
- **推理内容回放要求**：`requiresReasoningContentForToolCalls`（`packages/catalog/src/compat/openai.ts`）强制工具调用后续轮次回放先前的 `reasoning_content`（或合成占位符 `.`），防止 Moonshot 中止或从头重新推导推理。

### 认证与使用
- **API 密钥认证**：在 `packages/catalog/src/compat/rules/auth/moonshot.kdl` 中声明为 `login "api-key"` 规则（`packages/ai/src/registry/engine/api-key.ts`），将用户指向仪表盘 `https://platform.moonshot.ai/console/api-keys`。
- **端点校验**：通过 `GET ${MOONSHOT_BASE_URL || "https://api.moonshot.ai/v1"}/models` 校验密钥（`packages/catalog/src/compat/rules/auth/moonshot.kdl` 中的 `validate "models-endpoint"`，带 `base-url-env="MOONSHOT_BASE_URL"`）。
- **环境变量解析**：`packages/catalog/src/provider-models/descriptors.ts` 中的 `envVars: ["MOONSHOT_API_KEY", "KIMI_API_KEY"]` 接受 `KIMI_API_KEY` 作为未配置 `MOONSHOT_API_KEY` 的中国大陆用户的回退（issue #2883）。
- **无专用使用跟踪器**：token 使用直接由 `openai-completions` 中 OpenAI 流块的 `usage` 对象返回；`packages/ai/src/usage/` 中不存在单独的使用 API 或文件。

### 目录模型处理
- **描述符注册**：在 `CATALOG_PROVIDERS`（`packages/catalog/src/provider-models/descriptors.ts`）中注册为 `moonshot`，带有 `defaultModel: "kimi-k2.7-code"`、`envVars: ["MOONSHOT_API_KEY", "KIMI_API_KEY"]` 和 `createModelManagerOptions: moonshotModelManagerOptions`。
- **动态模型发现**：`moonshotModelManagerOptions`（`packages/catalog/src/provider-models/openai-compat.ts`）使用 `createOpenAICompatibleModelManagerOptions`，带 `defaultBaseUrl: Bun.env.MOONSHOT_BASE_URL ?? "https://api.moonshot.ai/v1"`。
- **动态 K3 与 K2.x 模型映射**：在 `moonshotModelManagerOptions`（`packages/catalog/src/provider-models/openai-compat.ts`）中：
  - 未被引用的 `kimi-k3` 条目被标注 `reasoning: true`、输入 `["text", "image"]`、`MOONSHOT_KIMI_K3_COST`、`contextWindow: 1_000_000`、`maxTokens: 131_072`，以及基于 effort 的 `thinking` 配置（issue #5756）。
  - `kimi-k2.x` 条目（例如 `kimi-k2.5`、`kimi-k2.6`）被标注 `reasoning: true`、视觉 `["text", "image"]` 和多层 effort（`[Minimal, Low, Medium, High]`），确保生成 `thinking` 负载，使模型不会停滞（issue #2113）。
- **主机与优先级 token 分类**：`packages/catalog/src/hosts.ts` 中的主机标记 `moonshotNative`（`urlMarkers: ["api.moonshot.ai", "api.kimi.com"]`）映射原生 Moonshot 端点。`packages/catalog/src/identity/priority.ts` 中的系列优先级 token 将 `"moonshot"` 紧排在 `"kimi-code"` 之后。

## NanoGPT (`nanogpt`)
NanoGPT 是一个按 token 计费的 API 网关，通过 OpenAI 兼容接口暴露多样的开放权重与商业语言模型。它使用 OpenAI Chat Completions 传输（`openai-completions`）执行请求，默认 base URL 为 `https://nano-gpt.com/api/v1`。

### 特殊情况
- **DSML 泄漏修复**：NanoGPT 被包含在 `packages/ai/src/utils/stream-markup-healing.ts` 的 `modelMayLeakDsmlToolCalls` 中。托管在 NanoGPT 上的 DeepSeek 模型（例如 `nanogpt/deepseek/deepseek-v4-pro`）在流式传输期间泄漏 `<｜DSML｜tool_calls>...</｜DSML｜tool_calls>` 文本信封时，会被路由到 `getStreamMarkupHealingPattern("nanogpt", modelId)`，以将流修复为结构化工具调用。
- **直接路由执行**：NanoGPT 避免在 DeepSeek 请求上追加 `:tools` 模型路由后缀，防止由 NanoGPT 服务端工具解析器在复杂 schema 上触发 `code: "malformed_tool_call"` 的 `502` 错误。
- **带索引工具增量保留**：依赖 `streamOpenAICompletionsOnce`（`packages/ai/src/providers/openai-completions.ts`）中的 `tool_calls[].index` 跟踪，确保来自 NanoGPT 的并行流式工具调用不会跨增量合并或丢失参数。

### 认证与使用
- **API 密钥与环境变量**：通过 `NANO_GPT_API_KEY` 认证（通过 `packages/ai/src/stream.ts` 中的 `getEnvApiKey` 解析，并配置在目录描述符 `packages/catalog/src/provider-models/descriptors.ts` 中）。
- **交互式登录**：在 `packages/catalog/src/compat/rules/auth/nanogpt.kdl` 中声明为 `login "api-key"` 规则（`packages/ai/src/registry/engine/api-key.ts`），提示输入来自 `https://nano-gpt.com/api` 的 API 密钥，并通过 `validate "models-endpoint"` 对 `https://nano-gpt.com/api/v1/models` 校验凭据。

### 目录模型处理
- **描述符与选项**：在 `CATALOG_PROVIDERS`（`packages/catalog/src/provider-models/descriptors.ts`）中注册，默认模型为 `openai/gpt-5.5`，选项通过 `nanoGptModelManagerOptions`（`packages/catalog/src/provider-models/openai-compat.ts`）配置。
- **模型变体过滤**：在 `fetchDynamicModels` 的动态发现期间，匹配 `NANO_GPT_NON_TEXT_MODEL_TOKENS` 中非文本 token 的模型（例如 `embedding`、`image`、`vision`、`audio`、`speech`、`transcribe`、`moderation`、`realtime`、`whisper`、`tts`）会被 `isLikelyNanoGptTextModelId` 过滤掉。
- **思考变体检测**：带有 `:thinking` 或 `:thinking:<level>` 后缀的模型由 `NANO_GPT_THINKING_SUFFIX_RE` 匹配，并从模型列表中排除，同时其基础模型 ID 记录在 `thinkingBaseIds` 中，以将相应的基础模型标记为具备推理能力（`model.reasoning = true`）。

## Novita (`novita`)
Novita AI 是一个 AI 云平台，为开放模型提供无服务器 OpenAI 兼容 LLM 推理。它在 `https://api.novita.ai/openai/v1` 上使用 OpenAI Chat Completions 传输。

### 特殊情况
- 除了 OpenAI Chat Completions 管道之外没有任何内容。

### 认证与使用
- **认证**：在 `packages/catalog/src/compat/rules/auth/novita.kdl` 中声明为 `login "api-key"` 规则（`packages/ai/src/registry/engine/api-key.ts`），使用标准 API 密钥提示（`sk_...`）链接到 `https://novita.ai/settings/key-management`。环境变量 `NOVITA_API_KEY` 通过目录描述符检查（`packages/catalog/src/provider-models/descriptors.ts`）。
- **基于推理的密钥校验**：在 `packages/catalog/src/compat/rules/auth/novita.kdl` 中通过使用 `moonshotai/kimi-k2.7-code` 向 `/chat/completions` 发送请求（`validate "chat-completions"`）来校验密钥。Novita 的 Developer 和 Basic 团队角色缺少 `/openapi/v1/billing/balance/detail` 的权限，因此推理校验避免拒绝有效的开发者密钥。

### 目录模型处理
- **模型发现**：通过 `novitaModelManagerOptions`（`packages/catalog/src/provider-models/openai-compat.ts`）配置，带 `defaultBaseUrl: "https://api.novita.ai/openai/v1"` 和 `dynamicModelsAuthoritative: true`。
- **未认证发现**：描述符设置 `catalogDiscovery.allowUnauthenticated: true`（`packages/catalog/src/provider-models/descriptors.ts`），允许在没有 API 密钥的情况下从 `/openai/v1/models` 获取公共目录。
- **模型过滤**：`filterModel` 校验活动状态（`status === 1` 或非数字），要求 `endpoints` 包含 `"chat/completions"`，检查 `max_output_tokens` 为正，并使用 `isPublicNovitaModelId` 排除内部测试模型 ID（排除以 `ai_infer_test` 开头的前缀）。
- **成本缩放**：`toNovitaCostPerMillion` 通过除以 10,000 转换价格字段（`input_token_price_per_m`、`output_token_price_per_m`、`pricing.input_cache_read.price_per_m`），将 Novita 的 1/10,000 美元每百万速率缩放为标准美元每百万 token。
- **能力与元数据**：`mapNovitaModel` 通过 `novitaArrayIncludes` 检查 `features` 中的 `"reasoning"` 和 `"function-calling"`，用 `toInputCapabilities` 解析输入模态，并提取上下文/输出窗口边界。

## NVIDIA (`nvidia`)
NVIDIA NIM（Inference Microservice）通过 OpenAI Chat Completions 传输（`openai-completions` API）提供对托管的开放与专有基础模型的访问。基础端点默认为 `https://integrate.api.nvidia.com/v1`。

### 特殊情况
- **Qwen 思考格式**：主机 `nvidia`（`integrate.api.nvidia.com`，`packages/catalog/src/hosts.ts:63`）将 Qwen 模型（`isQwen`）路由到 `thinkingFormat: "qwen-chat-template"`（`packages/catalog/src/compat/openai.ts:452`）。顶层 `enable_thinking` 会被 NIM 的严格请求 schema（`additionalProperties: false`）拒绝，因此思考通过 `chat_template_kwargs.enable_thinking` 传递。
- **DeepSeek token 剥离与 DSML 标记**：对于 `provider === "nvidia"` 下的 DeepSeek 模型，`stripDeepseekSpecialTokens` 设为 `true`（`packages/catalog/src/compat/openai.ts:596,755`），从可见输出中剥离泄漏的原始 `<｜DSML｜...｜>` 信封和思考标签（`packages/ai/test/openai-completions-compat.test.ts:2096-2216`）。为流标记修复注册在 `modelMayLeakDsmlToolCalls` 中（`packages/ai/src/utils/stream-markup-healing.ts:227`）。
- **工具选择与推理**：DeepSeek 推理模型在工具选择激活时禁用推理（`disableReasoningOnToolChoice`，`packages/catalog/src/compat/openai.ts:487`），而标准模型支持强制工具选择（`supportsForcedToolChoice: true`，`packages/ai/test/openai-completions-compat.test.ts:1801`）。

### 认证与使用
- **认证**：使用 NVIDIA NGC 个人密钥的基于密钥的认证（`packages/catalog/src/compat/rules/auth/nvidia.kdl` 中的 `auth-url "https://org.ngc.nvidia.com/setup/personal-keys"`），存储在 `NVIDIA_API_KEY` 中（`packages/catalog/src/provider-models/descriptors.ts:316`）。Base URL 为 `https://integrate.api.nvidia.com/v1`。
- **登录与校验**：在 `packages/catalog/src/compat/rules/auth/nvidia.kdl` 中声明为 `login "api-key"` 规则（`packages/ai/src/registry/engine/api-key.ts`），针对 `nvidia/llama-3.1-nemotron-70b-instruct` 校验密钥（`validate "chat-completions"` 带 `optional=#true`）。致命认证错误（`401`/`403`、`AIError.Flag.AuthFailed`）会中止登录；非致命校验错误被捕获，以允许自定义或新部署的模型。
- **provider 注册**：通过 `packages/ai/src/registry/build.ts` 从 `packages/catalog/src/compat/rules/auth/nvidia.kdl` 编译进 `packages/ai/src/registry/registry.ts`。凭据存储与去重在 `packages/ai/test/auth-storage-email-dedupe.test.ts:756-775` 中测试。
- **使用**：标准 OpenAI Chat Completions 使用指标；没有自定义使用处理器或配额端点。

### 目录模型处理
- **描述符与选项**：通过 `nvidiaModelManagerOptions`（`packages/catalog/src/provider-models/openai-compat.ts:1072`）和 `openAiCompletionsDescriptor`（`packages/catalog/src/provider-models/openai-compat.ts:5675`）配置。
- **默认值**：默认上下文窗口为 `131072`（`packages/catalog/src/provider-models/openai-compat.ts:5676`）。默认模型为 `nvidia/llama-3.1-nemotron-70b-instruct`（`packages/catalog/src/provider-models/descriptors.ts:315`）。
- **目录发现**：在目录描述符中注册，带 `catalogDiscovery: { label: "NVIDIA" }`（`packages/catalog/src/provider-models/descriptors.ts:318`）。

## Ollama (`ollama`)
本地 OpenAI 兼容 provider 集成，运行在本地或自托管的 Ollama 实例上（默认 base URL `http://127.0.0.1:11434/v1`）。发现到的模型使用共享的 Ollama 与 OpenAI Responses 传输引擎。

### 特殊情况
- **工具调用错误改写**：`packages/ai/src/error/format.ts` 中的 `rewriteOllamaToolCallJsonError` 拦截来自本地 `llama.cpp` 后端、匹配 `LLAMA_CPP_TOOL_CALL_PARSE_PATTERN` 的 HTTP 500 工具调用 JSON 解析失败，并将其改写为解释上下文溢出期间确定性模型输出退化的错误。
- **空长度完成上下文错误**：在 `buildOpenAICompat`（`packages/catalog/src/compat/openai.ts`）中，当 `provider === "ollama"` 时 `emptyLengthFinishIsContextError` 设为 `true`，将 `finish_reason: "length"` 的空补全视为上下文溢出错误。
- **KV 缓存推理回放**：`packages/catalog/src/compat/openai.ts` 中的 `LOCAL_OPENAI_COMPAT_PROVIDERS` 包含 `"ollama"`，自动启用 `OpenAICompat.replayReasoningContent`，使本地 Qwen3 / DeepSeek-R1 / GLM 聊天模板跨轮次重建先前的 `<think>` 块，以实现字节一致的前缀 KV 缓存复用。
- **DSML 工具调用标记修复**：`packages/ai/src/utils/stream-markup-healing.ts` 中的 `modelMayLeakDsmlToolCalls` 和 `packages/catalog/src/compat/openai.ts` 中的 `DSML_HEALING_PROVIDERS` 包含 `"ollama"`，以修复可见文本流中泄漏的 DeepSeek DSML 工具调用信封。
- **wire 推理 effort 阶梯**：`packages/catalog/src/model-thinking.ts` 中的 `spec.provider === "ollama"` 返回 `OLLAMA_REASONING_EFFORTS`（`[low, medium, high, max]`），匹配 Ollama 的原生 wire effort 词汇，无需 compat 层级的 effort 重映射。

### 认证与使用
- **交互式登录与可选密钥**：在 `packages/catalog/src/compat/rules/auth/ollama.kdl` 中声明为 `login "api-key"` 规则（`packages/ai/src/registry/engine/api-key.ts`），提示输入可选的 API 密钥/token（`empty-fallback ""`，占位符 `"ollama-local"`）并指向 `auth-url`；返回 `""` 表示本地无密钥模式。
- **使用 provider 与配额呈现**：`packages/ai/src/usage/ollama.ts` 中的 `ollamaUsageProvider`（`id: "ollama"`）实现 `fetchUsage`，返回 `limits` 为空并带有说明未暴露独立配额端点的 `UsageReport`；`validatesCredentials` 设为 `false`。
- **环境变量回退**：`CATALOG_PROVIDERS`（`packages/catalog/src/provider-models/descriptors.ts`）中的 `envVars: ["OLLAMA_API_KEY"]` 从 `process.env.OLLAMA_API_KEY` 解析可选的调用方凭据。

### 目录模型处理
- **描述符与无密钥注册**：`packages/catalog/src/provider-models/descriptors.ts` 中的 `CATALOG_PROVIDERS` 注册 `id: "ollama"`，带 `defaultModel: "gpt-oss:20b"`、`envVars: ["OLLAMA_API_KEY"]`、`allowUnauthenticated: true`（允许在没有密钥的情况下创建模型管理器），以及委托给 `ollamaModelManagerOptions` 的 `createModelManagerOptions`。
- **静态捆绑排除**：`scripts/generate-models.ts` 中的 `DISCOVERY_ONLY_PROVIDERS` 包含 `"ollama"`，防止本地端点将机器特定的 localhost 模型烘焙进已提交的 `models.json`。
- **动态模型发现**：`packages/catalog/src/provider-models/openai-compat.ts` 中的 `ollamaModelManagerOptions` 通过 `normalizeOllamaBaseUrl`（默认 `http://127.0.0.1:11434/v1`）规范化端点，并使用 `fetchOpenAICompatibleModels`（`packages/catalog/src/discovery/openai-compatible.ts`）查询 `/v1/models`。如果 `/v1/models` 不可用或为空，则回退到在 `toOllamaNativeBaseUrl`（`http://127.0.0.1:11434`）上查询 `/api/tags` 的原生 `fetchOllamaNativeModels`。
- **能力探测与上下文长度标注**：`packages/catalog/src/provider-models/openai-compat.ts` 中的 `fetchOllamaShowMetadata` 通过 `createOllamaMetadataResolver` 将 `{ model: modelId }` POST 到 `/api/show`。它从匹配 `.context_length`、`.num_ctx` 或 `.context_window` 的 `model_info` 键提取上下文长度（回退到 `OLLAMA_FALLBACK_CONTEXT_WINDOW` = 128,000 和 `OLLAMA_DEFAULT_MAX_TOKENS` = 8,192）。`capabilities.includes("thinking")` 会设置 `reasoning: true` 并配置 `thinking` effort（`[minimal, low, medium, high]`），而 `capabilities.includes("vision")` 会标注 `input: ["text", "image"]`。
- **模型缓存分区**：`ollamaModelManagerOptions` 中的 `cacheProviderId` 调用 `resolveModelCacheProviderId`（`packages/catalog/src/provider-models/cache-provider-id.ts`），按由 `baseUrl` 派生的 `ollama:ollama-models-v1:<hash>` 分区本地模型缓存键。

## Ollama Cloud (`ollama-cloud`)
Ollama Cloud 通过位于 `https://ollama.com` 的原生 `ollama-chat` 协议端点，为开放权重 LLM 提供托管云访问。它遵循 [Ollama](#ollama) 传输部分，与本地 Ollama 的区别在于要求显式 API 密钥认证，并强制执行云特有的历史清理与输出 token 上限。

### 特殊情况
- **助手历史思考剥离**：当 `model.provider === "ollama-cloud"` 时，`convertMessages`（`packages/ai/src/providers/ollama.ts`）从助手历史消息中剥离 `thinking` 字段。Ollama Cloud 端点会以 HTTP 400 错误拒绝包含 `thinking` 的传入历史，而本地 `ollama` 会保留它们。
- **推理 effort 映射**：`mapReasoning`（`packages/ai/src/providers/ollama.ts`）通过 `model.thinking.effortMap` 映射推理。`OLLAMA_CLOUD_GLM_52_THINKING`（`packages/catalog/src/provider-models/ollama.ts`）将 GLM-5.2 推理 effort 级别限制为 `high` 和 `max`，通过 `isOllamaCloudGlm52ReasoningEffortModel`（`packages/catalog/src/model-thinking.ts`）分配。
- **wire 层输出 token 钳制**：`resolveNumPredict`（`packages/ai/src/providers/ollama.ts`）对 `ollama-cloud` 模型将 `options.num_predict` 钳制为 `OLLAMA_CLOUD_NUM_PREDICT_CAP`（65,536），在传入 `maxTokens` 或覆盖时充当防 HTTP 400 错误的安全网（#3392）。本地 `ollama` 端点不钳制 `num_predict`。
- **流标记修复**：注册在 `DSML_HEALING_PROVIDERS`（`packages/catalog/src/compat/openai.ts`）和 `getStreamMarkupHealingPattern`（`packages/ai/src/utils/stream-markup-healing.ts`）中，用于 XML/markdown 工具调用与推理恢复。

### 认证与使用
- **交互式密钥认证**：在 `packages/catalog/src/compat/rules/auth/ollama-cloud.kdl` 中声明为 `login "api-key"` 规则（`packages/ai/src/registry/engine/api-key.ts`），提示输入在 `https://ollama.com/settings/keys` 生成的 API 密钥，并以 `ApiKeyRequiredError` 拒绝空输入。
- **环境变量解析**：`descriptors.ts`（`packages/catalog/src/provider-models/descriptors.ts`）和 `getEnvApiKey`（`packages/ai/src/stream.ts`）通过 `OLLAMA_CLOUD_API_KEY` 解析凭据。
- **使用核算**：`ollamaCloudUsageProvider`（`packages/ai/src/usage/ollama.ts`）使用 `fetchOllamaUsage` 处理 `ollama-cloud` 的使用。由于 Ollama Cloud 没有独立的配额 API（`validatesCredentials: false`），使用量按响应通过 `prompt_eval_count` 和 `eval_count` 流指标跟踪。

### 目录模型处理
- **描述符与发现接线**：描述符 `CATALOG_PROVIDERS`（`packages/catalog/src/provider-models/descriptors.ts`）定义 `defaultModel: "gpt-oss:120b"`、`envVars: ["OLLAMA_CLOUD_API_KEY"]`、选项构建器 `ollamaCloudModelManagerOptions` 和 `catalogDiscovery: { label: "Ollama Cloud", oauthProvider: "ollama-cloud" }`。
- **动态模型发现与 `/api/show` 元数据**：`ollamaCloudModelManagerOptions`（`packages/catalog/src/provider-models/ollama.ts`）使用 Bearer token 认证通过 `GET /api/tags` 从 `https://ollama.com` 获取模型，然后对每个模型查询 `POST /api/show`（`fetchShowMetadata`）以检查能力（`thinking`、`vision`）和 `model_info` 上下文窗口大小（默认 128,000）。未认证时返回空列表。
- **输出 token 上限与 token 参数省略**：`isOllamaCloudOutputCapped`（`packages/catalog/src/provider-models/ollama.ts`）识别 DeepSeek V4 Pro/Flash 模型，将 `maxTokens` 固定为 `Math.min(contextWindow, OLLAMA_CLOUD_MAX_OUTPUT_TOKENS)`（65,536），以防止后端拒绝请求（ollama/ollama#16890、#7266）。所有发现的云模型都设置 `omitMaxOutputTokens: true`（也通过 `packages/catalog/scripts/generated-policies.ts` 中的 `applyGeneratedModelPolicy` 强制执行）。

## OpenCode Go (`opencode-go`)
OpenCode Go 通过位于 `https://opencode.ai/zen/go` 的统一网关提供对多 provider 订阅模型（包括 Kimi、DeepSeek、GLM、Qwen 和 MiniMax）的访问。根据目标模型，请求经 OpenAI Chat Completions 或 Anthropic Messages 传输管道路由，并带有动态 API 解析。

### 特殊情况
- **API 解析与模型 ID 覆盖**：`createOpenCodeApiResolution`（`packages/catalog/src/provider-models/openai-compat.ts`）为 `https://opencode.ai/zen/go` 构造 `OPENCODE_GO_API_RESOLUTION`。显式 ID 覆盖（`minimax-m2.7`、`minimax-m3`、`minimax-m3-free`、`qwen3.5-plus`、`qwen3.6-plus`）优先于基于 npm 的启发式（`@ai-sdk/anthropic`），强制路由解析为 `/v1/chat/completions` 上的 `openai-completions`，以防止网关 404 HTML 错误或原始工具调用标记泄漏。
- **推理工具调用回放策略**：当 `isOpenCodeProvider` 为 true（`opencode-go` / `opencode-zen`）且推理激活时，应用 `packages/catalog/src/compat/openai.ts` 中的 `OPENCODE_WHEN_THINKING`。它设置 `requiresReasoningContentForToolCalls: true`、`allowsSyntheticReasoningContentForToolCalls: false` 和 `reasoningContentField: "reasoning_content"`，满足网关在思考工具调用回放缺少 `reasoning_content` 时报 400（#1484）或在思考关闭时发送时报 400（#1071）的要求。
- **`X-Api-Key` 认证规范化**：在 `packages/ai/src/providers/anthropic.ts`（第 3045–3046 行）中，当 `model.provider === "opencode-go"` 时，传输会删除自动生成的 `Authorization` Bearer 标头，以便 `AnthropicMessagesClient` 发出 `X-Api-Key`。对 OpenCode Anthropic 端点的仅 Bearer 请求会以 HTTP `401 Missing API key` 失败（#6510）。

### 认证与使用
- **API 密钥登录流程**：在 `packages/catalog/src/compat/rules/auth/opencode-go.kdl` 中声明为 `login "api-key"` 规则（`packages/ai/src/registry/engine/api-key.ts`）。它将用户引导到 `https://opencode.ai/auth`，提示输入 API 密钥，并返回存储在 `OPENCODE_API_KEY` 下的已修剪密钥。
- **支出窗口**：`opencodeGoUsageProvider`（`packages/ai/src/usage/opencode-go.ts`）为每个存储的密钥轮询 `GET /zen/go/v1/usage`（Bearer + `User-Agent` + `x-opencode-session`），并将三个服务器计算的窗口（`rolling` → `rolling-5h`、`weekly`、`monthly`；每个为 `{status: "ok" | "rate-limited", percent: 0-100, resetsAt}`）解码为带 `resetsAt` 截止时间的百分比限制。排序（`opencodeGoRankingStrategy`）使用滚动/每周余量；`monthly` 仅用于展示，因为当月度耗尽但控制台 "Use balance" 回退开启时仍可服务——硬性月度失败仍会通过 `401 Insufficient balance` 使用限制分类轮换（#3169）。响应式配额 429（`GoUsageLimitError`、`Resets in …`）通过 `markUsageLimitReached` 轮换，服务器声明的窗口由 `extractRetryHint` 解析（`packages/utils/src/fetch-retry.ts`）。

### 目录模型处理
- **权威动态模型**：`opencodeGoModelManagerOptions`（`packages/catalog/src/provider-models/openai-compat.ts`）和描述符配置（`packages/catalog/src/provider-models/descriptors.ts`，默认模型 `kimi-k2.7-code`）指定 `dynamicModelsAuthoritative: true`。从 `https://opencode.ai/zen/go/v1/models` 通过 `fetchOpenAICompatibleModels` 成功进行的运行时发现会完全替换捆绑的 provider 模型，而不是合并仅回退的 ID（`model-manager.ts`）。

## OpenCode Zen (`opencode-zen`)
OpenCode Zen（`opencode-zen`）是一项订阅服务，通过位于 `https://opencode.ai/zen` 的统一代理端点，提供对多厂商 AI 模型（Anthropic Claude、DeepSeek、MiniMax、Gemini 等）的访问。请求根据目录解析规则动态分派到多个底层传输 API——主要是 "Anthropic Messages"（`/zen`）、"OpenAI Chat Completions"（`/zen/v1`）、"OpenAI Responses"（`/zen/v1`）和 "Google Generative AI"（`/zen/v1`）——其中 `claude-opus-4-8` 被指定为其默认模型。

### 特殊情况
- **多 API 解析与端点接线**：`packages/catalog/src/provider-models/openai-compat.ts` 中的 `createOpenCodeApiResolution` 通过 `@ai-sdk/*` npm 元数据解析模型传输目标。`OPENCODE_ZEN_API_RESOLUTION` 定义按 id 的覆盖，将 `"minimax-m3"` 和 `"minimax-m3-free"` 映射到 `https://opencode.ai/zen/v1` 上的 `"openai-completions"`，覆盖会导致 HTTP 400 错误或原始 `<invoke>`/`<|minimax|>`/`<tool_call>` 标记泄漏的上游 `@ai-sdk/anthropic` 标签（#1617）。
- **Anthropic 代理标头与 Beta 处理**：在 `packages/ai/src/providers/anthropic.ts` 中，`opencode-zen` 删除默认 `Authorization` 标头（`delete defaultHeaders.Authorization`）并提供 `apiKey` 以发出 `X-Api-Key` 标头。对 `opencode-zen` 的思考请求会抑制 `context_management_20251015` beta 标头和 body 字段（`context_management`），因为 Zen Anthropic 代理会以 `400 Extra inputs are not permitted` 拒绝未识别字段（#6510）。
- **思考模式内容回放（`whenThinking`）**：OpenCode 模型的基线兼容设置 `requiresReasoningContentForToolCalls: false`，以防止在思考禁用的请求上发送未识别参数（#1071）。当启用推理时，`packages/catalog/src/compat/openai.ts` 中的 `buildOpenAICompat` 构造 `OPENCODE_WHEN_THINKING` 覆盖层（`requiresReasoningContentForToolCalls: true`、`allowsSyntheticReasoningContentForToolCalls: false`），由 `packages/ai/src/providers/openai-shared.ts` 中的 `resolveOpenAICompatPolicy` 在请求时指针替换，以防止 `400 thinking is enabled but reasoning_content is missing in assistant tool call message` 错误（#1484、#2084）。
- **别名推理模型（`big-pickle`）**：模型 ID `big-pickle` 是 OpenCode Zen 的 DeepSeek 推理别名，通过 `packages/catalog/src/compat/openai.ts` 和 `packages/catalog/src/model-thinking.ts` 中的 `isOpenCodeDeepseekAlias` 识别。它被归类为 `isDeepseekFamily` 的一部分，在思考工具调用轮次强制执行严格的 `reasoning_content` 回放。

### 认证与使用
- **API 密钥手动认证**：通过 `OPENCODE_API_KEY` 环境变量配置（`packages/catalog/src/provider-models/descriptors.ts` 中的 `CATALOG_PROVIDERS` 描述符）。
- **交互式 CLI 登录流程**：在 `packages/catalog/src/compat/rules/auth/opencode-zen.kdl` 中声明为 `login "api-key"` 规则（`packages/ai/src/registry/engine/api-key.ts`）：它在浏览器中打开 `https://opencode.ai/auth` 并提示用户粘贴其 API 密钥。
- **wire 认证**：跨 Anthropic 与 OpenAI 兼容协议端点的凭据通过 `X-Api-Key` 标头传递，而不是标准 Bearer token。

### 目录模型处理
- **描述符与选项**：目录条目 `opencode-zen`（`packages/catalog/src/provider-models/descriptors.ts`）设置 `defaultModel: "claude-opus-4-8"`、`dynamicModelsAuthoritative: true`，并实例化 `packages/catalog/src/provider-models/openai-compat.ts` 中的 `opencodeZenModelManagerOptions`。
- **动态发现与 base URL 规范化**：`opencodeZenModelManagerOptions` 调用 `openCodeModelManagerOptions("opencode-zen", config)`，从 `https://opencode.ai/zen/v1/models`（`discoveryBaseUrl`）获取动态 OpenAI 兼容模型。模型被映射为正的 `contextWindow`（`context_length`）和 `maxTokens`（`max_completion_tokens`），并按 API 类型规范化 base URL（`openCodeBaseUrlForApi` / `normalizeOpenCodeBasePath`）。
- **Zen 与 Go 的差异**：
  - **Base URL 根**：Zen 使用基础路径 `https://opencode.ai/zen`（补全位于 `/zen/v1`），而 OpenCode Go（`opencode-go`）指向 `https://opencode.ai/zen/go`（补全位于 `/zen/go/v1`）。
  - **默认模型**：Zen 默认为 `claude-opus-4-8`；Go 默认为 `kimi-k2.7-code`。
  - **API 解析覆盖**：Zen（`OPENCODE_ZEN_API_RESOLUTION`）将 `"minimax-m3"` 和 `"minimax-m3-free"` 覆盖为 `"openai-completions"`。Go（`OPENCODE_GO_API_RESOLUTION`）将 `"minimax-m2.7"`、`"minimax-m3"`、`"minimax-m3-free"`、`"qwen3.5-plus"` 和 `"qwen3.6-plus"` 覆盖为 `"openai-completions"`，以防止网关 404 或 XML 标记泄漏（#887、#1617）。
  - **模型别名**：Zen 包含 `big-pickle` 别名（DeepSeek 推理），它通过 `isOpenCodeDeepseekAlias` 被专门检测，以应用 DeepSeek 兼容策略。

## OpenRouter (`openrouter`)
OpenRouter 是一个统一的多 provider 路由网关，通过 OpenAI 兼容接口为数以百计的第三方模型提供服务。请求使用伪 API `openrouter` 执行，默认分派到 OpenAI Responses 传输，或根据环境配置回退到 OpenAI Chat Completions。

### 特殊情况
- **伪 API 分派与双 wire 回退**：`packages/ai/src/stream.ts` 中的 `streamSimple` 判断 `model.api === "openrouter"`。当 `$env.PI_OPENROUTER_RESPONSES !== "0"`（默认）时，它分派到 `streamOpenAIResponses`（"OpenAI Responses"）；当设为 `"0"` 时，回退到 `streamOpenAICompletions`（"OpenAI Chat Completions"）。目录兼容使用 `ResolvedOpenRouterCompat`（`packages/catalog/src/types.ts`），由 `packages/catalog/src/compat/openai.ts` 中的 `buildOpenRouterCompat` 组合 `ResolvedOpenAICompat` 与 `ResolvedOpenAIResponsesCompat` 构造。
- **路由变体转换（`:nitro` / `:floor`）**：指定 `openrouterVariant`（`"nitro"`、`"floor"`、`"online"`、`"exacto"`、`"extended"`）的选项通过 `applyOpenRouterRoutingVariant`（`packages/ai/src/providers/openai-shared.ts`）映射。变体后缀（`:<variant>`）在请求时追加到 `model.id`，除非最后一个斜杠之后已存在冒号（`lastColon > lastSlash`），从而保留用户或目录的显式变体覆盖。
- **Provider 顺序与排除偏好**：当 `compat.isOpenRouterHost` 为 true 时，`packages/ai/src/providers/openai-shared.ts` 中的 `applyOpenAIGatewayRouting` 将目录 `openRouterRouting` 偏好（`OpenRouterRouting` 接口，带 `only?: string[]` 与 `order?: string[]`）注入到顶层 `provider` 请求参数中。
- **Anthropic `cache_control` 断点**：解析后的兼容字段 `cacheControlFormat === "anthropic"`（基线：OpenRouter 主机 + Anthropic 模型类）选择 Anthropic 缓存标记方言。在 Chat Completions wire 上，`applyOpenAIChatCompletionsPromptCachePolicy`（`openai-completions.ts`）将 `cache_control: { type: "ephemeral" }` 附加到最新消息的最后一个非空文本部分。在 Responses wire 上，`applyOpenAIResponsesPromptCachePolicy`（`openai-responses.ts`）设置 `params.cache_control = cacheRetention === "long" ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" }`。
- **目录默认 max-tokens 省略**：当 `isOpenRouterHost` 为 true 且 `maxTokensExplicit` 为 false 时，`packages/ai/src/providers/openai-shared.ts` 中的 `resolveOpenAIOutputTokenParam` 省略默认输出 token 上限（`max_tokens`、`max_completion_tokens`、`max_output_tokens`）。这可防止 OpenRouter 在执行 `provider.order` / `only` 回退时过滤掉所宣传输出上限低于目录最大值的上游；调用方显式指定的 `maxTokens` 会保留。
- **自定义请求头**：`packages/ai/src/utils/openrouter-headers.ts` 中的 `getOpenRouterHeaders` 为所有请求附加 `User-Agent: omp/<ver>`、`HTTP-Referer: https://omp.sh/`、`X-OpenRouter-Title: omp`、`X-OpenRouter-Categories: cli-agent`、`X-OpenRouter-Cache: true` 和 `X-OpenRouter-Cache-TTL: 3600`，用于边缘响应缓存。

### 认证与使用
- **通过 `/api/v1/auth/key` 进行认证密钥验证**：在 `packages/catalog/src/compat/rules/auth/openrouter.kdl` 中声明为 `login "oauth-code"` 规则（`packages/ai/src/registry/engine/oauth-code.ts`），并带有针对 `https://openrouter.ai/api/v1/auth/key` 的 `paste-key` 验证。公开的 `/api/v1/models` 对未认证请求返回 HTTP 200，因此使用 `/api/v1/auth/key` 作为规范的身份检查（有效密钥返回 200，否则返回 401）。密钥解析通过 `packages/ai/src/stream.ts` 中的 `getEnvApiKey` 检查 `OPENROUTER_API_KEY`。
- **权威上报费用对账**：`packages/ai/src/providers/openai-shared.ts` 中的 `applyProviderReportedCost` 提取 OpenRouter 与 ClinePass 回显的 `rawUsage.cost`。如果估算的 token 费用为有限正值，则输入、输出、缓存读取与缓存写入费用按 `reportedCost / estimatedCost` 缩放，以匹配精确的可计费总额；否则直接将上报费用赋给 `usage.cost.input`。

### 目录模型处理
- **描述符与未认证发现**：在 `CATALOG_PROVIDERS`（`packages/catalog/src/provider-models/descriptors.ts`）中注册为 `openrouter`，具有 `defaultModel: "openai/gpt-5.5"`、`envVars: ["OPENROUTER_API_KEY"]` 和 `catalogDiscovery: { label: "OpenRouter", allowUnauthenticated: true }`。
- **动态发现与过滤**：`packages/catalog/src/provider-models/openai-compat.ts` 中的 `openrouterModelManagerOptions` 使用 `fetchOpenAICompatibleModels` 以 `api: "openrouter"` 查询 `https://openrouter.ai/api/v1/models`。缓存条目按 `resolveModelCacheProviderId("openrouter")` 分区。发现的模型被过滤为指定了 `supported_parameters.includes("tools")` 的条目。
- **规格映射**：`openrouterModelManagerOptions` 映射 `modality`（`text`/`image`）、每百万 token 定价（`prompt`、`completion`、`input_cache_read`、`input_cache_write`）、`context_length`、`top_provider.max_completion_tokens`，并通过 `mapOpenRouterThinking` 映射推理 effort 阶梯。

## Qianfan (`qianfan`)
Qianfan（百度云）通过使用 OpenAI Chat Completions 传输的 OpenAI 兼容 v2 API，提供对百度托管模型家族的访问。入口点包括用于认证策略与 API 密钥认证的 `packages/catalog/src/compat/rules/auth/qianfan.kdl`、用于目录注册的 `packages/catalog/src/provider-models/descriptors.ts`（`CATALOG_PROVIDERS`），以及用于模型管理器选项的 `packages/catalog/src/provider-models/openai-compat.ts`（`qianfanModelManagerOptions`）。

### 特殊情况
- 除 OpenAI Chat Completions 流水线之外没有其他特殊处理。

### 认证与使用
- **API 密钥认证与验证**：通过 `QIANFAN_API_KEY` 或存储的凭据进行认证，使用格式为 `bce-v3/ALTAK-...` 的 API 密钥（从 `https://console.bce.baidu.com/qianfan/ais/console/apiKey` 获取）。CLI 登录流程在 `packages/catalog/src/compat/rules/auth/qianfan.kdl` 中声明为 `login "api-key"` 规则（`packages/ai/src/registry/engine/api-key.ts`），通过向 `https://qianfan.baidubce.com/v2` 发起使用 `deepseek-v3.2` 的聊天补全请求（`validate "chat-completions"`）验证凭据。
- **使用与配额**：适用标准 OpenAI Chat Completions token 使用追踪（`input`、`output`、`reasoning`）与 HTTP 状态码错误处理。

### 目录模型处理
- **Provider 描述符**：在 `CATALOG_PROVIDERS`（`packages/catalog/src/provider-models/descriptors.ts`）中配置，具有 `defaultModel: "deepseek-v3.2"`、`envVars: ["QIANFAN_API_KEY"]` 和目录发现标签 `"Qianfan"`。
- **模型选项**：`qianfanModelManagerOptions`（`packages/catalog/src/provider-models/openai-compat.ts`）通过 `createSimpleOpenAICompletionsOptions` 构造绑定到 `https://qianfan.baidubce.com/v2` 的 `openai-completions` 选项。
- **捆绑模型**：`packages/catalog/src/models.json` 中的静态模型规格定义了 Qianfan 模型（例如 `deepseek-v3.2`，带 `reasoning: true` 与 `baseUrl: "https://qianfan.baidubce.com/v2"`）。

## Qwen Portal (`qwen-portal`)
Qwen Portal 通过 `https://portal.qwen.ai/v1` 上的 OpenAI 兼容端点提供对 Qwen 托管模型的访问。它使用 OpenAI Chat Completions 传输进行模型执行与工具调用。

### 特殊情况
- **系统消息限制**：主机匹配（`packages/catalog/src/hosts.ts` 中的 `qwenPortal`，匹配 `portal.qwen.ai`）设置 `supportsMultipleSystemMessagesDefault = false`（`packages/catalog/src/compat/openai.ts`）。这会强制将多系统消息块合并为单个块，以防止默认 Qwen 聊天模板触发 500 内部服务器错误。

### 认证与使用
- **环境变量**：自动从 `QWEN_OAUTH_TOKEN` 或 `QWEN_PORTAL_API_KEY` 解析凭据（`packages/catalog/src/provider-models/descriptors.ts:385`）。
- **交互式登录**：在 `packages/catalog/src/compat/rules/auth/qwen-portal.kdl` 中声明为 `login "api-key"` 规则（`packages/ai/src/registry/engine/api-key.ts`），引导用户从 `https://chat.qwen.ai` 复制 token 或 API 密钥并提示输入。
- **凭据验证**：在 `packages/catalog/src/compat/rules/auth/qwen-portal.kdl` 中使用 `validate "chat-completions"` 针对 `coder-model` 验证输入 token 是否可用于 `https://portal.qwen.ai/v1`。
- **使用追踪**：`packages/ai/src/usage/` 下不存在专门的使用上报模块。

### 目录模型处理
- **描述符设置**：`qwenPortalModelManagerOptions` 使用 `createSimpleOpenAICompletionsOptions`（`packages/catalog/src/provider-models/openai-compat.ts:4139`），默认上下文窗口 128,000 token、最大输出 token 8,192（`openai-compat.ts:5894`）。
- **目录配置**：在 `descriptors.ts:383` 中注册，默认模型 `coder-model`，发现标签 `"Qwen Portal"`，`oauthProvider: "qwen-portal"`。
- **静态模型定义**：在 `packages/catalog/src/models.json` 中公开预定义的静态模型：`coder-model`（Qwen Coder）与 `vision-model`（Qwen Vision，支持 `text` 和 `image` 模态）。

## Sakana AI (`sakana`)
Sakana AI 提供通过 `api.sakana.ai` 托管的 Fugu 模型家族的推理模型。
请求通过有状态的 OpenAI Responses 传输（`api: "openai-responses"`）路由。

### 特殊情况
- **Base URL 归一化与覆盖**：`packages/ai/src/providers/openai-shared.ts` 中的 `resolveSakanaRequestBaseUrl`
  与 `packages/catalog/src/provider-models/openai-compat.ts` 中的 `normalizeSakanaBaseUrl` 解析 base URL 覆盖
  （来自 `SAKANA_BASE_URL`，或回退 `FUGU_BASE_URL`）。Base URL 会被归一化以移除尾部斜杠并确保
  带有 `/v1` 路径后缀，回退到 `https://api.sakana.ai/v1`。

### 认证与使用
- **API 密钥解析**：环境变量发现首先检查 `SAKANA_API_KEY`，然后回退到 `FUGU_API_KEY`
  （在描述符 `packages/catalog/src/provider-models/descriptors.ts` 中配置）。
- **交互式登录**：在 `packages/catalog/src/compat/rules/auth/sakana.kdl` 中声明为 `login "api-key"` 规则（`packages/ai/src/registry/engine/api-key.ts`），引导用户
  前往 Sakana AI 控制台（`https://console.sakana.ai/api-keys`），并针对 `https://api.sakana.ai/v1/models` 验证凭据。

### 目录模型处理
- **静态 Fugu 种子**：`packages/catalog/src/provider-models/openai-compat.ts` 中的 `SAKANA_FUGU_STATIC_MODELS` 导出捆绑的
  种子规格（`fugu`、`fugu-ultra`、`fugu-ultra-20260615`），默认 provider 模型为 `fugu`。
- **动态模型管理器**：`sakanaModelManagerOptions` 将实时 `/models` 发现标记为权威
  （`dynamicModelsAuthoritative: true`），并通过 `dropCachedModelIdsOnStaticMismatch` 在种子变更时清除过期的缓存模型行。
- **两层 effort 配置**：`isSakanaFuguReasoningModel`（`packages/catalog/src/model-thinking.ts`）与 `isSakanaFuguModelId`
  （`packages/catalog/src/provider-models/openai-compat.ts`）匹配 Fugu 模型（`/^fugu(?:$|-)/i`），将其标记为带两层 effort 标度的
  推理模型（`HIGH_MAX_REASONING_EFFORTS`：`[high, max]`）。

## SiliconFlow (`siliconflow`)
SiliconFlow 是一个高性能 AI 推理平台，提供对开源模型（如 DeepSeek 和 GLM）的访问。它使用 OpenAI Chat Completions 传输（全球为 `https://api.siliconflow.com/v1`，中国区域为 `https://api.siliconflow.cn/v1`）。

### 特殊情况
- **仅动态目录**：在 `CATALOG_PROVIDERS`（`packages/catalog/src/provider-models/descriptors.ts`）中配置为 `dynamicModelsAuthoritative: true`。不捆绑任何静态目录模型（省略了 `catalogDiscovery`，且 `MODELS_DEV_PROVIDER_DESCRIPTORS` 在生成器捆绑中排除它）；模型通过 `/v1/models` 实时发现。
- **非聊天模型过滤**：`packages/catalog/src/provider-models/openai-compat.ts` 中的 `isLikelySiliconFlowChatModelId` 使用 `SILICONFLOW_NON_CHAT_MODEL_TOKENS` 过滤掉 `/v1/models` 返回的非聊天模型（嵌入、重排序器、Stable Diffusion、Flux，以及 Whisper、Wan2、CosyVoice 等音视频生成器）。
- **运行时元数据补水与回退**：`loadSiliconFlowModelsDevReferences` 以 5,000ms 超时（`SILICONFLOW_MODELS_DEV_REFERENCE_TIMEOUT_MS`）查询 models.dev。缺失的模型回退到规范捆绑规格（`resolveModelReference`）以推断上下文窗口、最大 token 与推理能力，同时排除定价。

### 认证与使用
- **API 密钥登录**：通过存储在 `SILICONFLOW_API_KEY`（或 `siliconflow-cn` 的 `SILICONFLOW_CN_API_KEY`）中的 API 密钥进行认证。在 `packages/catalog/src/compat/rules/auth/siliconflow.kdl` 和 `siliconflow-cn.kdl` 中交互式声明为 `login "api-key"` 规则（`packages/ai/src/registry/engine/api-key.ts`）。
- **端点验证**：登录期间通过向 `https://api.siliconflow.com/v1/models`（`https://api.siliconflow.cn/v1/models`）发起 `models-endpoint` 请求来验证凭据。
- **控制台 URL**：密钥创建说明指向 `https://cloud.siliconflow.com/account/ak`（中国区域为 `https://cloud.siliconflow.cn/account/ak`）。

### 目录模型处理
- **管理器构造**：`packages/catalog/src/provider-models/openai-compat.ts` 中的 `siliconflowModelManagerOptions` 与 `siliconflowCnModelManagerOptions` 通过 `createSiliconFlowModelManagerOptions` 构造动态 OpenAI 兼容模型管理器。
- **默认模型**：`siliconflow` 的默认模型为 `zai-org/GLM-5.1`，`siliconflow-cn` 为 `deepseek-ai/DeepSeek-V4-Pro`（定义于 `packages/catalog/src/provider-models/descriptors.ts`）。
- **动态模型发现**：当 API 密钥可用时，`fetchDynamicModels` 调用 `fetchOpenAICompatibleModels` 从 `/v1/models` 获取实时模型，并合并 models.dev 定价/限制（`mapWithBundledReference`）或规范回退参考。

## SiliconFlow (中国) (`siliconflow-cn`)
SiliconFlow（中国）是 SiliconFlow AI 模型平台在中国本土的部署，为面向区域可用性定制的开放权重模型提供 OpenAI 兼容的 LLM 推理。它使用 OpenAI Chat Completions 传输（`openai-completions`），base URL 为 `https://api.siliconflow.cn/v1`。

### 特殊情况
- **端点差异**：在 `siliconflowCnModelManagerOptions`（`packages/catalog/src/provider-models/openai-compat.ts`）中为模型端点使用 `https://api.siliconflow.cn/v1`，与全球 `siliconflow`（`https://api.siliconflow.com/v1`）不同。
- **非聊天模型过滤**：模型发现会排除非聊天模型 ID（嵌入、重排序、图像、TTS、音频与视频模型中包含 `bge-`、`bce-`、`stable-diffusion`、`flux`、`kolors`、`sensevoice`、`cosyvoice`、`fish-speech`、`wan2` 等 token 的条目），通过 `packages/catalog/src/provider-models/openai-compat.ts` 中的 `isLikelySiliconFlowChatModelId` 实现。
- **捆绑上游参考回退**：models.dev 中缺失的模型会从捆绑的上游模型参考定义（`getBundledModelReferenceIndex`）恢复内在能力（`reasoning`、`input`）、上下文窗口与最大输出 token，同时省略 provider 特定的定价。

### 认证与使用
- **环境变量**：通过描述符 `envVars` 中配置的 `SILICONFLOW_CN_API_KEY`（`packages/catalog/src/provider-models/descriptors.ts`）进行认证，与全球 `SILICONFLOW_API_KEY` 相互独立。
- **API 密钥登录**：在 `packages/catalog/src/compat/rules/auth/siliconflow-cn.kdl` 中声明为 `login "api-key"` 规则（`packages/ai/src/registry/engine/api-key.ts`），管理控制台 URL 为 `https://cloud.siliconflow.cn/account/ak`，验证端点为 `https://api.siliconflow.cn/v1/models`。
- **无使用追踪**：`packages/ai/src/usage/` 下不存在专门的配额或使用解析模块。

### 目录模型处理
- **描述符配置**：定义于 `packages/catalog/src/provider-models/descriptors.ts`，具有 `defaultModel: "deepseek-ai/DeepSeek-V4-Pro"`（对比 `siliconflow` 的 `zai-org/GLM-5.1`）、`envVars: ["SILICONFLOW_CN_API_KEY"]` 和 `dynamicModelsAuthoritative: true`。
- **仅动态模型发现**：有意从 `MODELS_DEV_PROVIDER_DESCRIPTORS` 与静态目录生成（`scripts/generate-models.ts`）中省略，改为从 `https://api.siliconflow.cn/v1/models` 实时获取可用聊天模型。
- **运行时参考补水**：实时发现的模型在 `loadSiliconFlowModelsDevReferences`（`packages/catalog/src/provider-models/openai-compat.ts`）中以 5 秒超时（`SILICONFLOW_MODELS_DEV_REFERENCE_TIMEOUT_MS`）与 models.dev 目录条目（`SILICONFLOW_MODELS_DEV_DESCRIPTORS`）交叉引用，以补水定价与限制元数据。

## Synthetic (`synthetic`)
Synthetic 是一个为其模型提供双 API 格式支持的 AI 平台，同时公开 OpenAI 兼容端点（`https://api.synthetic.new/openai/v1/chat/completions`）与 Anthropic 兼容端点（`https://api.synthetic.new/anthropic/v1/messages`）。调用默认使用 `OpenAI Chat Completions` 传输，但在配置后可以动态切换到 `Anthropic Messages` 传输。

### 特殊情况
- **双 API 表面**：`streamSynthetic`（`packages/ai/src/providers/synthetic.ts`）利用 `streamOpenAIAnthropicShim`（`packages/ai/src/providers/openai-anthropic-shim.ts`）同时包装 OpenAI 补全与 Anthropic 消息端点。API 格式可通过请求的 `syntheticApiFormat` 选项（`"openai"` | `"anthropic"`）选择，默认为 `"openai"`。
- **提前导入模块**：`streamSynthetic` 与 `isSyntheticModel` 在 `packages/ai/src/stream.ts` 中被提前导入（绕过惰性内置注册），以支持即时的模型 provider 分类与路由。
- **动态推理与特性**：在 `packages/catalog/src/provider-models/openai-compat.ts` 中，`syntheticModelManagerOptions` 映射来自 `GET /openai/v1/models` 的动态模型条目。它检查 `supported_features` 中是否有 `"reasoning"`，并解析 wire effort 档位（例如 `reasoning_parameters.efforts`）以构造 `thinking` 选项并相应设置 `reasoning` 标志。

### 认证与使用
- **认证**：使用 `SYNTHETIC_API_KEY` 的密钥认证（`packages/catalog/src/compat/rules/auth/synthetic.kdl`）。通过 `login "api-key"` 规则（`packages/ai/src/registry/engine/api-key.ts`）针对 `GET https://api.synthetic.new/openai/v1/models` 验证。
- **使用与配额轮询**：`syntheticUsageProvider`（`packages/ai/src/usage/synthetic.ts`）使用 bearer API 密钥轮询 `GET https://api.synthetic.new/v2/quotas`。它上报两个不同的限制窗口：
  - `synthetic:requests:5h`：滚动 5 小时请求限制，带每 tick 再生百分比（`rollingFiveHourLimit`）。
  - `synthetic:usd:7d`：以美元计的每周额度限制（`weeklyTokenLimit`），带每 tick 美元再生速率。

### 目录模型处理
- 默认模型：`hf:zai-org/GLM-5.1`（`packages/catalog/src/provider-models/descriptors.ts`）。
- `dynamicModelsAuthoritative: true`：模型通过 `syntheticModelManagerOptions`（`packages/catalog/src/provider-models/openai-compat.ts`）动态获取。
- 模态与视觉：`input` 模态（`"text"`、`"image"`）从 `input_modalities`、`supports_vision` 或回退参考规格动态解析。
- 能力过滤：`supported_features` 严格限定工具支持；如果存在但缺少 `"tools"`，则该模型的工具调用被禁用。

## Together (`together`)
Together 是一个云推理 provider，通过 OpenAI Chat Completions 兼容 API 提供对各种开源与专有基础模型的访问。

### 特殊情况
- **严格 JSON Schema 模式**：被识别为支持严格 schema 模式（`packages/catalog/src/compat/openai.ts` 中的 `detectStrictModeSupport`），对 `together` provider ID 与 `api.together.xyz` base URL 启用。
- **多系统消息**：被识别为支持多系统消息（`packages/catalog/src/compat/openai.ts` 中的 `supportsMultipleSystemMessagesDefault`），因此系统消息不会被强制在索引 0 处合并。

### 认证与使用
- **API 密钥认证**：使用 `TOGETHER_API_KEY` 环境变量或在 `pi-ai login together` 期间输入的 API 密钥进行认证。
- **验证**：在 `packages/catalog/src/compat/rules/auth/together.kdl` 中将密钥声明为 `login "api-key"` 规则（`packages/ai/src/registry/engine/api-key.ts`），针对 `https://api.together.xyz/v1/models` 验证。
- **API base URL**：`https://api.together.xyz/v1`。

### 目录模型处理
- **描述符与默认值**：在 `descriptors.ts` 中配置，默认模型 `moonshotai/Kimi-K2.7-Code`，并在 `openai-compat.ts` 中配置 `togetherModelManagerOptions`。
- **目录来源**：模型通过 `models.dev` 描述符生成，使用键 `togetherai` 映射到 `https://api.together.xyz/v1` 上的 provider `together`（`packages/catalog/src/provider-models/openai-compat.ts`）。
- **主机匹配**：列于 `packages/catalog/src/hosts.ts` 中，匹配主机 URL 标记 `api.together.xyz`，并注册到 `priority.ts` 身份映射中。

## Umans AI Coding Plan (`umans`)
Umans AI Coding Plan 是面向 AI 编码模型的代理服务，通过 Anthropic Messages 线路格式（"Anthropic Messages"）运行，其默认 base URL 设置为 `https://api.code.umans.ai`。

### 特殊情况
- **认证头策略**：Anthropic 兼容的 Umans 请求强制使用 `X-Api-Key` 头认证（在 `packages/catalog/src/compat/rules/auth/umans.kdl` 中声明），而非 `Authorization: Bearer`（`packages/ai/src/providers/anthropic.ts` 中的 `buildAnthropicClientOptions`）。
- **工具名转义**：配置了 `compat.escapeBuiltinToolNames: true`（`packages/catalog/src/compat/anthropic.ts`），在出站请求中为客户端工具名添加 `_` 前缀并在返回时剥离，以避免与网关内置工具名冲突，除非网关 web 搜索处于活动状态（`packages/ai/src/providers/anthropic.ts`）。
- **网关 web 搜索**：通过检查 `X-Umans-Websearch-Provider` 调用方请求头或 `UMANS_WEBSEARCH_PROVIDER`（`native` | `exa`）环境变量来路由 web 搜索请求（`packages/ai/src/providers/anthropic.ts`）。启用后，`web_search` 工具名不经转义直接通过。
- **思考 / 推理 effort**：支持思考配置，其等级通过 `UMANS_REASONING_EFFORT_BY_LEVEL`（`packages/catalog/src/provider-models/openai-compat.ts`）映射。Umans 上的 GLM-5.2 使用 high/max 两层 effort 标度，其中 `max` 映射到 `anthropic-budget-effort` 模式（`xhigh` effort）（`packages/catalog/src/model-thinking.ts`）。

### 认证与使用
- **认证**：使用 `UMANS_AI_CODING_PLAN_API_KEY` 环境变量或 `/login umans` 密钥提示（`packages/catalog/src/compat/rules/auth/umans.kdl`、`packages/ai/src/registry/engine/api-key.ts`）。密钥验证会向 `https://api.code.umans.ai` 执行一次轻量 Anthropic 消息调用（`max_tokens: 1`）。
- **使用端点**：使用 `Authorization: Bearer <key>` 从 `GET /v1/usage`（`packages/ai/src/usage/umans.ts`）获取配额与速率限制状态。
- **暴露的限制**：返回拆分为模型加权软上限（`umans:requests:soft`，即「有效请求」契约）与原始突发上限（`umans:requests:hard`、`hard_cap`）的滚动 5 小时请求限制，外加瞬时会话并发限制（`umans:concurrency`）。软上限只会告警——`exhausted` 保留给真正开始限流的突发上限。未上报突发上限（`hard_cap`）的负载会收敛为单行加权 `umans:requests`，它可以在有效请求限制处耗尽，因此请求耗尽永远不会无法上报；不带加权计数器的旧负载回退为单行原始 `umans:requests`。在这两种单行形态中，加权计数器（存在时）始终保持权威——超过限制的原始突发流量永远不会伪造出耗尽状态。当发生速率限制突发时，还会暴露低优先级状态说明。

### 目录模型处理
- **描述符与发现**：注册为 `umans`，默认模型 `umans-coder`（`packages/catalog/src/provider-models/descriptors.ts`）。动态发现从 `GET /v1/models/info`（`packages/catalog/src/provider-models/openai-compat.ts`）获取模型详情。
- **视觉能力过滤**：`umansSupportsVision` 严格检查 `supports_vision === true`。哨兵字符串值（如 `umans-glm-5.1` 和 `umans-glm-5.2` 的 `"via-handoff"`）被映射为纯文本（`["text"]`），因此图像内容通过客户端视觉交接处理，而不是发送会引发 HTTP 400 错误的原始图像块（`packages/catalog/src/provider-models/openai-compat.ts`）。
- **定价与回退**：为按需付费与诸如 `umans-qwen3.6-35b-a3b` 映射到 `umans-flash` 的技术别名模型生成带定价回退规则的目录条目（`packages/catalog/scripts/generate-models.ts`）。

## Venice (`venice`)
Venice 是一个注重隐私的 AI 平台，提供未经审查与开源的模型。它通过 OpenAI Chat Completions 传输（`api: "openai-completions"`）运行，默认 base URL 为 `https://api.venice.ai/api/v1`。

### 特殊情况
- **Qwen 推理方言**：Venice 严格的 chat-completions schema 拒绝 DashScope 的顶层 `enable_thinking`。`buildOpenAICompat` 通过 provider 或 `api.venice.ai` base URL 识别 Venice，并将 Qwen 推理等级路由到 OpenAI 风格的 `reasoning_effort`。
- **显式关闭思考**：`reasoningDisableMode: "venice-disable-thinking"` 将显式关闭选择编码为 `venice_parameters.disable_thinking: true`，同时保留诸如 `include_venice_system_prompt` 等同级 Venice 设置。

### 认证与使用
- **API 密钥登录与验证**：在 `packages/catalog/src/compat/rules/auth/venice.kdl` 中声明为 `login "api-key"` 规则（`packages/ai/src/registry/engine/api-key.ts`），引导用户前往 `https://venice.ai/settings/api` 获取 API 密钥（`vapi_...` 占位前缀），并使用验证模型 `qwen3-4b` 通过轻量 `chat-completions` 请求验证凭据。注册于 `packages/ai/src/registry/registry.ts`。
- **环境变量与凭据**：从 `CATALOG_PROVIDERS`（`packages/catalog/src/provider-models/descriptors.ts`）中配置的 `VENICE_API_KEY` 环境变量解析 API 密钥。
- **使用核算**：使用标准 OpenAI Chat Completions 使用核算（`packages/ai/src/providers/openai-shared.ts` 中的 `calculateOpenAIUsageAccounting`），没有自定义配额或使用端点。

### 目录模型处理
- **Provider 描述符**：在 `CATALOG_PROVIDERS`（`packages/catalog/src/provider-models/descriptors.ts`）中注册，默认模型 `llama-3.3-70b`、`envVars: ["VENICE_API_KEY"]`，目录发现配置了 `allowUnauthenticated: true`。
- **模型管理器选项**：`packages/catalog/src/provider-models/openai-compat.ts` 中的 `veniceModelManagerOptions` 使用 `createOpenAICompatibleModelManagerOptions` 在 `https://api.venice.ai/api/v1` 上配置模型管理。
- **流式使用兼容**：在 `veniceModelManagerOptions`（`packages/catalog/src/provider-models/openai-compat.ts`）中，映射后的模型通过设置 `compat: { ...model.compat, supportsUsageInStreaming: false }` 显式禁用流式使用负载。
- **Kimi K2.7 Code 最大 token 封顶**：`packages/catalog/src/provider-models/openai-compat.ts` 中的 `clampKimiK27CodeMaxTokens`（以及 `packages/catalog/scripts/generate-models.ts` 中的 `applyKimiMaxTokensCap`）将 Kimi K2.7 Code 模型（`isKimiK27CodeModelId`）的输出 token（`maxTokens`）封顶为 `KIMI_K27_CODE_RECOMMENDED_MAX_TOKENS`。
- **目录转换**：`packages/catalog/src/provider-models/openai-compat.ts` 中 Venice 的 `openAiCompletionsDescriptor` 在模型目录构建与发现转换期间应用 `clampKimiK27CodeMaxTokens`。

## Vercel AI Gateway (`vercel-ai-gateway`)
Vercel AI Gateway 通过统一代理（`https://ai-gateway.vercel.sh`）将 LLM 请求路由到底层上游 provider（如 Anthropic、OpenAI 或 Bedrock）。它根据模型配置跨 Anthropic Messages（`anthropic-messages`）、OpenAI Chat Completions（`openai-completions`）和 OpenAI Responses（`openai-responses`）传输协议运行。

### 特殊情况
- **主机检测**：`isVercelGatewayHost` 通过 `modelMatchesHost({ provider, baseUrl }, "vercelAIGateway")`（`packages/catalog/src/compat/openai.ts`、`packages/catalog/src/hosts.ts`）求值，匹配 `provider === "vercel-ai-gateway"

## vLLM (本地 OpenAI 兼容) (`vllm`)
vLLM 是一个开源的高吞吐量 LLM 服务引擎，运行本地或自托管的 OpenAI 兼容推理服务器。它通过 HTTP/SSE 使用 OpenAI Chat Completions 传输。入口模块包括用于认证与凭据处理的 `packages/catalog/src/compat/rules/auth/vllm.kdl`，以及用于目录选项与动态模型发现的 `packages/catalog/src/provider-models/openai-compat.ts`（`vllmModelManagerOptions`）。

### 特殊情况
- **推理内容重放（`replayReasoningContent`）**：注册于 `LOCAL_OPENAI_COMPAT_PROVIDERS`（`packages/catalog/src/compat/openai.ts`）。由于本地推理后端依赖前缀 KV 缓存复用，`isLocalOpenAICompatBackend` 会自动启用 `replayReasoningContent: true`。当助手历史包含推理内容（`<think>` 块）时，它会在后续请求中于 `reasoning_content` 中重放，以维持精确的提示词 token 对齐。
- **Qwen 思考保留（`qwenPreserveThinking`）**：当 `thinkingFormat` 为 `"qwen"` 或 `"qwen-chat-template"` 且 `isLocalOpenAICompatBackend` 为 true 时自动启用（`packages/catalog/src/compat/openai.ts`）。在兼容对象上设置 `qwenPreserveThinking: true`，在请求体中（顶层与 `chat_template_kwargs` 内）发出 `preserve_thinking: true`，使 Qwen 3.6+ 聊天模板在多轮历史中保留 `<think>` 块。
- **流空闲超时下限**：作为本地服务后端（`packages/catalog/src/compat/openai.ts` 中的 `isLocalServingBackend`），vLLM 自动应用扩展的流空闲超时下限（`streamIdleTimeoutMs: 300_000` / 5 分钟），而非默认的 100 秒，以适应本地 GPU 或 CPU 上繁重的模型预填充延迟。
- **仅动态目录排除**：包含于 `DISCOVERY_ONLY_PROVIDERS`（`scripts/generate-models.ts`）与 `LOCAL_ONLY_PROVIDERS`（`test/models-json-no-local-endpoints.test.ts`）。本地 vLLM 模型被排除在静态目录生成之外，因此机器特定的端点永远不会提交到 `models.json`。

### 认证与使用
- **凭据解析与默认值**：在 `packages/catalog/src/compat/rules/auth/vllm.kdl` 中声明为 `login "api-key"` 规则（`packages/ai/src/registry/engine/api-key.ts`）。从 `VLLM_API_KEY` 环境变量或通过 `omp auth-broker login vllm` 存储的凭据读取可选 API 密钥。
- **未认证本地模式**：当未提供密钥时（`emptyKeyFallback: "vllm-local"`），默认 base URL 为 `http://127.0.0.1:8000/v1`，占位 token 为 `"vllm-local"`（`DEFAULT_LOCAL_TOKEN`）。描述符设置指定 `catalogDiscovery: { label: "vLLM", allowUnauthenticated: true }`。
- **文档与端点设置**：登录助手指向 `https://docs.vllm.ai/en/latest/serving/openai_compatible_server.html`，用于配置本地 vLLM OpenAI 兼容服务器端点。

### 目录模型处理
- **描述符配置**：在 `packages/catalog/src/provider-models/descriptors.ts` 中注册，具有 `id: "vllm"`、`defaultModel: "gpt-oss-20b"`、`envVars: ["VLLM_API_KEY"]`、`allowUnauthenticated: true`，以及由 `vllmModelManagerOptions` 生成的管理器选项。
- **动态模型发现**：`vllmModelManagerOptions`（`packages/catalog/src/provider-models/openai-compat.ts`）调用 `fetchOpenAICompatibleModels`，使用 `api: "openai-completions"`、`provider: "vllm"`、base URL `config?.baseUrl ?? getDefaultModelDiscoveryBaseUrl("vllm")!`（`http://127.0.0.1:8000/v1`）以及 10 秒超时（`VLLM_DISCOVERY_TIMEOUT_MS = 10_000`）。
- **上下文窗口提取**：`vllmModelManagerOptions` 中的自定义 `mapModel` 使用 `toPositiveNumber(entry.max_model_len, model.contextWindow)` 从 vLLM 非标准的 `/v1/models` 响应字段 `entry.max_model_len` 提取 `contextWindow`。
- **缓存 provider ID**：由 `packages/catalog/src/provider-models/cache-provider-id.ts` 中的 `resolveModelCacheProviderId("vllm", { baseUrl })` 解析（使用 `getDefaultModelDiscoveryBaseUrl("vllm")`），生成格式为 `vllm:${Bun.hash(baseUrl).toString(36)}` 的基于 base URL 哈希的缓存键。

## Wafer Serverless (`wafer-serverless`)
Wafer Serverless 是一个按需付费的 provider，通过位于 `https://pass.wafer.ai/v1` 的 OpenAI 兼容 API 代理多个上游模型（如 Zhipu GLM、Moonshot Kimi、Alibaba Qwen 和 DeepSeek）。它依赖 OpenAI Chat Completions 传输（`openai-completions`）。

### 特殊情况
- 上游思考参数选择通过 `resolveWaferServerlessThinkingFormat`（`packages/catalog/src/provider-models/openai-compat.ts:2137`）基于 `wafer.provider` 信封提示动态配置：
  - 匹配 `zai`、`zhipu`、`moonshot` 或 `kimi` 的上游设置 `thinkingFormat: "zai"`。
  - 匹配 `qwen`、`alibaba` 或 `dashscope` 的上游设置 `thinkingFormat: "qwen"`。
  - 无信封提示时的回退使用 `isReasoningGlmModelId` 或 `isKimiModelId` 判定 `"zai"`（`packages/catalog/src/provider-models/openai-compat.ts:2150`）。
  - `generated-policies.ts` 中的静态策略为捆绑的 GLM/Kimi 模型应用 `thinkingFormat: "zai"`（`packages/catalog/scripts/generated-policies.ts:364`）。
- 所有推理条目都配置 `reasoningContentField: "reasoning_content"` 并设置 `supportsDeveloperRole: false`（`packages/catalog/src/provider-models/openai-compat.ts:2244`）。
- `wafer-pass` 已被弃用，改用 `wafer-serverless`（`packages/catalog/scripts/generate-models.ts:79`）。

### 认证与使用
- 使用通过 `WAFER_SERVERLESS_API_KEY` 环境变量（`packages/catalog/src/provider-models/descriptors.ts:465`）提供的 Bearer API 密钥（`wfr_…` 前缀）进行认证。
- 交互式登录在 `packages/catalog/src/compat/rules/auth/wafer-serverless.kdl` 中声明为 `login "api-key"` 规则（`packages/ai/src/registry/engine/api-key.ts`），引导用户前往 `https://app.wafer.ai/usage`。
- 密钥验证探测 `https://pass.wafer.ai/v1/models`（`packages/catalog/src/compat/rules/auth/wafer-serverless.kdl` 中的 `validate "models-endpoint"`）。

### 目录模型处理
- 在 provider 描述符中注册，`defaultModel: "GLM-5.1"`，base URL `https://pass.wafer.ai/v1`（`packages/catalog/src/provider-models/descriptors.ts:463`）。
- 动态目录生成使用 `waferServerlessModelManagerOptions`（`packages/catalog/src/provider-models/openai-compat.ts:2252`），并通过 `readWaferRecord`（`packages/catalog/src/provider-models/openai-compat.ts:2151`）解析 `/v1/models` 响应。
- 从 `wafer.capabilities` 映射模型能力：`vision` 启用 `["text", "image"]` 输入，`reasoning` 启用推理模式，`tools` 设置 `supportsTools`（`packages/catalog/src/provider-models/openai-compat.ts:2193`）。
- 上下文窗口读取 `wafer.context_length`（回退到 `max_model_len`），`maxTokens` 封顶为 `65536`（`WAFER_MAX_TOKENS_CAP`，`packages/catalog/src/provider-models/openai-compat.ts:2201`）。
- 定价将 `wafer.pricing` 中的内部批发单位使用 `cents * 125 / 10000`（`cents * 0.0125`）换算为 USD/百万 token（`packages/catalog/src/provider-models/openai-compat.ts:2203`）。
- 模型 ID 在线路上逐字保留，不做大小写转换（`packages/catalog/src/provider-models/openai-compat.ts:2210`）。

## xAI API (`xai`)
xAI API（`xai`）使用标准 API 密钥认证提供对 xAI Grok 模型套件的访问。它通过 OpenAI Chat Completions 传输（`https://api.x.ai/v1`）路由推理请求，与使用 OAuth bearer token 和 OpenAI Responses 传输的 `xai-oauth` 不同。

### 特殊情况
- **Grok 主机兼容性**：主机检测（`packages/catalog/src/hosts.ts` 符号 `hosts.xai`）匹配 provider `"xai"` 与 `api.x.ai` URL，以在 Chat Completions 兼容层（`packages/catalog/src/compat/openai.ts` 符号 `resolveOpenAICompatForHost`）中求值 `isGrok`。
- **提示词缓存头**：当 `isGrok` 为 true 时配置 `promptCacheSessionHeader: "x-grok-conv-id"`（`packages/catalog/src/compat/openai.ts` 符号 `resolveOpenAICompatForHost`），启用会话 ID 头附加以用于提示词缓存保留。
- **推理 effort 禁用**：在 Chat Completions 兼容性中通过 `!isGrok` 检查显式设置 `supportsReasoningEffort: false`（`packages/catalog/src/compat/openai.ts` 符号 `resolveOpenAICompatForHost`），与 `xai-oauth` 有选择的推理 effort 支持形成对照。
- **Provider 优先级排序**：在 provider 优先级中（`packages/catalog/src/identity/priority.ts` 符号 `PROVIDER_PRIORITY`）位于 `xai-oauth` 之下（`"xai-oauth"` > `"xai"` > `"mistral"`）。

### 认证与使用
- **认证**：在 `packages/catalog/src/compat/rules/auth/xai.kdl` 中声明为 `login "api-key"` 规则的基于密钥认证（`packages/ai/src/registry/engine/api-key.ts`）。引导用户前往 `"https://console.x.ai/team/default/api-keys"`，提示 `"Paste your xAI API key"`（占位符 `"xai-..."`）。
- **验证**：通过 `models-endpoint` 针对 `"https://api.x.ai/v1/models"` 执行凭据检查（`packages/catalog/src/compat/rules/auth/xai.kdl` 中的 `validate "models-endpoint"`）。
- **环境回退**：配置为解析 `XAI_API_KEY`（`packages/catalog/src/provider-models/descriptors.ts` 符号 `descriptors`）。
- **使用追踪**：`OpenAI Chat Completions` 流水线之外没有其他内容。

### 目录模型处理
- **描述符配置**：provider 描述符（`packages/catalog/src/provider-models/descriptors.ts` 符号 `descriptors`）指定默认模型 `grok-4-fast-non-reasoning` 并委托给 `xaiModelManagerOptions`。
- **管理器选项**：通过 `createSimpleOpenAICompletionsOptions("xai", "https://api.x.ai/v1", config)`（`packages/catalog/src/provider-models/openai-compat.ts` 符号 `xaiModelManagerOptions`）构造。
- **补全描述符**：以 `openAiCompletionsDescriptor("xai", "xai", "https://api.x.ai/v1")` 注册（`packages/catalog/src/provider-models/openai-compat.ts` 符号 `openAiCompletionsDescriptor`），通过 `openai-completions` API 提供 Grok 模型。

## xAI Grok OAuth (SuperGrok) (`xai-oauth`)
xAI Grok OAuth 通过 OpenAI Responses 传输（`api: "openai-responses"`、`baseUrl: "https://api.x.ai/v1"`）提供对 xAI Grok 模型的订阅制访问（SuperGrok / X Premium+）。认证使用针对 `https://auth.x.ai` 的 RFC 8628 设备码流程，而使用追踪探测专用的 SuperGrok CLI 计费代理。

### 特殊情况
- **加密推理与历史重放**：`includeEncryptedReasoning` 为 `false`（`packages/catalog/src/compat/openai.ts` `buildOpenAIResponsesCompat`）以抑制加密推理条目的重放。`filterReasoningHistory` 为 `true`（`packages/catalog/src/compat/openai.ts`、`packages/ai/src/providers/openai-responses.ts`）以从重放的 Responses 历史中过滤掉原生推理条目与思考签名。
- **图像细节钳制**：`supportsImageDetailOriginal` 为 `false`（`packages/catalog/src/compat/openai.ts` `buildOpenAIResponsesCompat`），将图像细节从 `"original"` 钳制为 `"auto"`，因为 xAI 端点在 `"original"` 时返回 HTTP 400/422。
- **推理 effort 门控与摘要**：`supportsReasoningEffort` 为 `false`，除非模型位于 `isGrokReasoningEffortCapable` 允许列表（`packages/catalog/src/identity/family.ts`，例如 `grok-3-mini`、`grok-4.20-multi-agent`、`grok-4.3`、`grok-4.5`）。不具备能力的模型（`grok-build`、`grok-build-0.1`、`grok-4.20-0309-reasoning`、`grok-composer-2.5-fast`）设置 `omitReasoningEffort: true` 以防止 `api.x.ai` 上的 HTTP 400。`reasoningSummary` 在 `packages/ai/src/providers/openai-responses.ts` 中被设为 `null`（禁用时为 `undefined`），以省略不受支持的 `reasoning.summary` wire 字段。
- **推理 effort 映射与缓存**：将 `minimal` 映射为 `"low"`（`packages/catalog/src/provider-models/openai-compat.ts` `XAI_REASONING_EFFORT_MAP`）。发送 `X-Grok-Conv-Id` 以用于会话提示词缓存保留（`promptCacheSessionHeader`）。

### 认证与使用
- **OAuth 认证**：在 `packages/catalog/src/compat/rules/auth/xai-oauth.kdl` 中声明为 `login "device-code"` 规则（`packages/ai/src/registry/engine/device-code.ts`），token 钩子在 `packages/ai/src/registry/oauth/xai-oauth.ts`。针对 `https://auth.x.ai` 执行 RFC 8628 设备授权（客户端 ID `b1a00492-073a-47ea-816f-4c329264a828`，scope `openid profile email offline_access grok-cli:access api:access`）。端点验证与身份辅助函数位于 `packages/ai/src/registry/oauth/xai-oauth.ts`（`validateXAIEndpoint`、`fetchXAIOAuthIdentity`）。环境回退：先 `XAI_OAUTH_TOKEN`，然后 `XAI_API_KEY`（`descriptors.ts`）。
- **使用追踪**：`xaiOauthUsageProvider`（`packages/ai/src/usage/xai-oauth.ts`）使用头 `X-XAI-Token-Auth: xai-grok-cli`（`getXAICliBillingHeaders`）查询 `https://cli-chat-proxy.grok.com/v1/billing`（`validateXAIBillingEndpoint` 固定到 HTTPS `*.grok.com`）。仅接受有效的 OAuth bearer 凭据。探测旧的每周额度（`?format=credits`，`parseWeeklyBillingConfig` 解析 `creditUsagePercent` 与 `productUsage`）与统一的每月配额（`parseMonthlyBillingConfig` 解析 `monthlyLimit` 与 `used`），以及正的 `onDemandCap` / `onDemandUsed` 限制。

### 目录模型处理
- **精选模型与静态种子**：`XAI_OAUTH_CURATED_MODELS`（`packages/catalog/src/provider-models/openai-compat.ts`）定义成本为零（`cost: 0`）的静态模型（`grok-build`、`grok-build-0.1`、`grok-4.3`、`grok-4.5`、`grok-4.6`、`grok-4.20-multi-agent-0309`、`grok-4.20-0309-reasoning`、`grok-4.20-0309-non-reasoning`、`grok-composer-2.5-fast`）。默认模型为 `grok-4.6`（`descriptors.ts`）。`buildXaiOAuthStaticSeed` 在启动时同步为 `ModelRegistry` 播种，使 `modelRoles.default = "xai-oauth/<id>"` 在动态刷新之前即可工作。
- **动态精选覆盖层**：`applyXAIOAuthCuration`（`openai-compat.ts`、`xaiOAuthModelManagerOptions`）过滤非聊天前缀（`grok-imagine-`、`grok-stt-`、`grok-voice-`），覆盖精选上下文窗口（最高 2M），将 `maxTokens` 设为等于 `contextWindow`，保留图像能力与推理标志，并注入缺失的精选模型。
- **参考解析排除**：`isZeroCostXaiOAuthCandidate`（`packages/catalog/src/identity/reference.ts`）将零成本订阅条目排除在参考索引匹配之外，以免订阅定价与限制覆盖公开/付费的 Grok 参考。

## Xiaomi MiMo (`xiaomi`)
Xiaomi MiMo 通过 OpenAI 兼容端点提供小米专有的 MiMo 模型家族（如 `mimo-v2.5` 与 `mimo-v2.5-pro`）。请求使用标准按需付费 base URL（`https://api.xiaomimimo.com/v1`）或区域 Token Plan base URL（`https://token-plan-{sgp,ams,cn}.xiaomimimo.com/v1`）通过 OpenAI Chat Completions 传输执行。

### 特殊情况
- **MiMo 兼容分类**：在 `packages/catalog/src/compat/openai.ts` 中通过 `isXiaomiHost`（`modelMatchesHost(hostModel, "xiaomi")`）与 `isMimoModelIdOrName`（`packages/catalog/src/identity/family.ts`）匹配。
- **推理内容不变量**：
  - `requiresReasoningContentForToolCalls: true`（`packages/catalog/src/compat/openai.ts`）：MiMo 模型要求在标准与 Token Plan 主机的思考模式工具调用延续中精确重放 `reasoning_content`。
  - `requiresReasoningContentForAllAssistantTurns: true`（`packages/catalog/src/compat/openai.ts`）：在推理模式下强制所有先前助手轮次都具备 `reasoning_content`（通过 OpenRouter 路由时除外）。
  - `allowsSyntheticReasoningContentForToolCalls: false`（`packages/catalog/src/compat/openai.ts`）：在工具调用轮次上拒绝合成的 `reasoning_content` 占位符（例如 `"."`）。
- **思考格式与 effort 映射**：
  - `thinkingFormat: "zai"`（`packages/catalog/src/compat/openai.ts`）：使用 z.ai 二进制 `thinking` 结构格式化思考模式负载。
  - `supportsReasoningEffort: false`（`packages/catalog/src/compat/openai.ts`）：抑制标准的 `reasoning_effort` 参数。
- **非标准主机协议标志**：`isXiaomiHost` 被归类到 `isNonStandard`（`packages/catalog/src/compat/openai.ts`）之下，设置 `supportsStore: false` 并将 `supportsDeveloperRole: false` 作为默认值。

### 流行为
- **放宽空闲看门狗超时**：在 `packages/catalog/src/compat/openai.ts` 中，`streamIdleTimeoutMs` 通过 `XIAOMI_MIMO_STREAM_IDLE_TIMEOUT_MS` 放宽到 300,000 ms（5 分钟），因为 `api.xiaomimimo.com` 上的 MiMo Pro 可能在发出第一个 SSE 事件前停滞约 2 分钟（issue #1770）。

### 认证与使用
- **注册表与 provider 定义**：主 provider 声明于 `packages/catalog/src/compat/rules/auth/xiaomi.kdl`；区域 Token Plan provider 声明于 `packages/catalog/src/compat/rules/auth/xiaomi-token-plan-{ams,cn,sgp}.kdl`。
- **交互式密钥提示与验证**：标准 Xiaomi 登录（`packages/ai/src/registry/oauth/xiaomi.ts` 中的 `loginXiaomi`）提示输入标准（`sk-...`）或 Token Plan（`tp-...`）API 密钥，并通过 `validateXiaomiApiKey` 验证，而区域 Token Plan provider 使用各自 `.kdl` 文件中的声明式 `login "api-key"` 规则。
- **Token Plan 验证回退**：使用 `tp-` 密钥的标准 `xiaomi` 登录依次回退 SGP（`https://token-plan-sgp.xiaomimimo.com/v1`）→ AMS（`https://token-plan-ams.xiaomimimo.com/v1`）→ CN（`https://token-plan-cn.xiaomimimo.com/v1`），每个端点使用全新的 `AbortSignal.timeout(15_000)` 信号，使区域超时不会中止后续回退端点。区域 `xiaomi-token-plan-*` 登录针对其特定集群验证。
- **环境变量**：标准 `xiaomi` 使用 `XIAOMI_API_KEY`，区域 Token Plan provider 使用 `XIAOMI_TOKEN_PLAN_AMS_API_KEY`、`XIAOMI_TOKEN_PLAN_CN_API_KEY`、`XIAOMI_TOKEN_PLAN_SGP_API_KEY`（`packages/catalog/src/provider-models/descriptors.ts`）。

### 目录模型处理
- **Provider 描述符**：`packages/catalog/src/provider-models/descriptors.ts` 中的目录描述符配置 `xiaomi`、`xiaomi-token-plan-ams`、`xiaomi-token-plan-cn` 和 `xiaomi-token-plan-sgp`，`defaultModel: "mimo-v2.5"`。
- **动态模型发现**：`packages/catalog/src/provider-models/openai-compat.ts` 中的 `xiaomiModelManagerOptions` 检查密钥（`tp-` 与 `sk-`）与 provider ID，以查询标准或区域 `/models` 端点（`XIAOMI_TOKEN_PLAN_BASE_URLS`），并在返回的模型上保留区域 provider ID。
- **音频模型过滤**：语音与音频模型被排除在发现与目录生成之外（`!model.id.includes("-tts") && !model.id.includes("-asr")`），涉及 `xiaomiModelManagerOptions`（`packages/catalog/src/provider-models/openai-compat.ts`）与 `scripts/generate-models.ts`。
- **主机匹配**：`modelMatchesHost`（`packages/catalog/src/hosts.ts`）将 `xiaomi` provider ID、`xiaomi-token-plan-` provider 前缀和 `xiaomimimo.com` URL 标记匹配到 `xiaomi` 主机类。

## Xiaomi Token Plan (欧洲) (`xiaomi-token-plan-ams`)
Xiaomi Token Plan（欧洲）（`xiaomi-token-plan-ams`）通过小米的欧洲 Token Plan 网关（`https://token-plan-ams.xiaomimimo.com/v1`）提供对小米 MiMo 模型家族（如 `mimo-v2.5` 与 `mimo-v2-omni`）的区域访问。它使用 OpenAI Chat Completions 传输（`api: "openai-completions"`）。此区域 provider 允许 CLI 登录（`omp login`）与动态模型查找，以针对欧洲集群存储和验证 `tp-` API 密钥，而不跨区域回退。

### 特殊情况
- **主机匹配与扩展空闲超时**：通过 `packages/catalog/src/hosts.ts` 中的 `providerPrefixes: ["xiaomi-token-plan-"]` 匹配到 `xiaomi` 主机类。在 `packages/catalog/src/compat/openai.ts` 中 `isXiaomiHost` 匹配，启用 `isXiaomiMimo`，后者配置 `XIAOMI_MIMO_STREAM_IDLE_TIMEOUT_MS = 300_000`（5 分钟流空闲看门狗），以适应 MiMo 模型上的初始响应停滞。
- **TTS/ASR 模型过滤**：动态模型管理器选项（`packages/catalog/src/provider-models/openai-compat.ts` 中的 `xiaomiModelManagerOptions`）与模型生成脚本（`scripts/generate-models.ts`）过滤掉音频模型（`!model.id.includes("-tts") && !model.id.includes("-asr")`）。
- **Provider ID 保留**：`xiaomiModelManagerOptions`（`packages/catalog/src/provider-models/openai-compat.ts`）显式设置 `providerId: "xiaomi-token-plan-ams"`，并将动态发现条目映射回 `provider: "xiaomi-token-plan-ams"`，而不是将其折叠为通用的 `xiaomi`。

### 认证与使用
- **注册表 provider 与认证策略**：在 `packages/catalog/src/compat/rules/auth/xiaomi-token-plan-ams.kdl` 中声明，ID 为 `"xiaomi-token-plan-ams"`，作为 `login "api-key"` 规则（`packages/ai/src/registry/engine/api-key.ts`）。
- **区域控制台说明**：在 `packages/catalog/src/compat/rules/auth/xiaomi-token-plan-ams.kdl` 中声明的交互式 CLI 登录会提示用户输入 `tp-` 前缀的 API 密钥，并引导其前往 Token Plan 控制台 URL（`https://platform.xiaomimimo.com/console/plan-manage`）。
- **单集群验证**：直接针对 `https://token-plan-ams.xiaomimimo.com/v1` 验证密钥（使用 `mimo-v2.5`，通过 `packages/catalog/src/compat/rules/auth/xiaomi-token-plan-ams.kdl` 中的 `validate "chat-completions"`），绕过通用 `loginXiaomi` 使用的多区域回退序列。
- **请求头与错误**：请求传递标准的 `Authorization: Bearer tp-...` 头。认证或网络失败会抛出 `AIError.OAuthError` 或 `AIError.ApiKeyRequiredError`。

### 目录模型处理
- **Provider 描述符**：在 `CATALOG_PROVIDERS`（`packages/catalog/src/provider-models/descriptors.ts`）中注册，具有 `id: "xiaomi-token-plan-ams"`、`defaultModel: "mimo-v2.5"`，以及管理器工厂 `xiaomiModelManagerOptions({ ...config, providerId: "xiaomi-token-plan-ams", tokenPlanRegion: "ams" })`。
- **OpenAI 兼容描述符**：在 `packages/catalog/src/provider-models/openai-compat.ts` 中通过 `openAiCompletionsDescriptor("xiaomi-token-plan-ams", "xiaomi-token-plan-ams", "https://token-plan-ams.xiaomimimo.com/v1")` 配置。
- **动态模型管理器**：`xiaomiModelManagerOptions`（`packages/catalog/src/provider-models/openai-compat.ts`）将 `tokenPlanRegion: "ams"` 映射为 base URL `https://token-plan-ams.xiaomimimo.com/v1` 以供 `fetchDynamicModels` 使用，并利用 `createBundledReferenceMap("xiaomi")` 获取基线规格。
- **预打包目录模型**：捆绑模型（例如 `mimo-v2-omni`、`mimo-v2.5`）在 `packages/catalog/src/models.json` 中注册于键 `"xiaomi-token-plan-ams"` 之下，设置 `baseUrl: "https://token-plan-ams.xiaomimimo.com/v1"` 与 `api: "openai-completions"`。

## Xiaomi Token Plan (中国) (`xiaomi-token-plan-cn`)
Xiaomi Token Plan（中国）是小米 MiMo 的 Token Plan 订阅服务的中国区域端点（`https://token-plan-cn.xiaomimimo.com/v1`）。它使用区域 `tp-...` API 密钥提供对 MiMo AI 模型的访问。它使用 "OpenAI Chat Completions" 传输。

### 特殊情况
- **主机分类**：`packages/catalog/src/hosts.ts` 中的 `KNOWN_HOSTS.xiaomi` 通过 `providerPrefixes: ["xiaomi-token-plan-"]` 与 `urlMarkers: ["xiaomimimo.com"]` 匹配 `xiaomi-token-plan-cn`，为所有 Token Plan 端点启用主机级兼容标志。
- **推理内容重放**：`packages/catalog/src/compat/openai.ts` 将 Xiaomi 主机上的 MiMo 模型标记为 `requiresReasoningContentForToolCalls: true` 与 `requiresReasoningContentForAllAssistantTurns: true`，要求先前的助手工具调用轮次保留精确的 `reasoning_content`。
- **合成推理拒绝**：`packages/catalog/src/compat/openai.ts` 中的 `allowsSyntheticReasoningContentForToolCalls` 对 MiMo 模型求值为 `false`，在工具调用延续上拒绝合成的 `.` 占位符。
- **扩展流空闲超时**：`packages/catalog/src/compat/openai.ts` 中的 `XIAOMI_MIMO_STREAM_IDLE_TIMEOUT_MS`（300,000 ms / 5 分钟）覆盖默认的首事件/空闲超时，以适应生成前的推理停滞。
- **音频 SKU 过滤**：`packages/catalog/scripts/generate-models.ts` 为 `xiaomi-token-plan-` provider 过滤掉包含 `-tts` 或 `-asr` 的语音合成与识别 SKU。

### 认证与使用
- **环境变量与登录**：通过 `XIAOMI_TOKEN_PLAN_CN_API_KEY` 认证。在 `packages/catalog/src/compat/rules/auth/xiaomi-token-plan-cn.kdl` 中声明为 `login "api-key"` 规则（`packages/ai/src/registry/engine/api-key.ts`）。
- **区域 API 密钥验证**：提示输入来自 `https://platform.xiaomimimo.com/console/plan-manage` 的 `tp-...` 密钥，并通过 `validateXiaomiApiKey` 严格针对 `https://token-plan-cn.xiaomimimo.com/v1` 发送 `mimo-v2.5` 的 `POST /v1/chat/completions` 请求进行验证，超时 15 秒（`VALIDATION_TIMEOUT_MS`）。
- **使用核算**：适用标准 OpenAI Chat Completions 使用核算（`calculateOpenAIUsageAccounting`）；不存在 provider 特定的使用或配额模块。

### 目录模型处理
- **Provider 描述符**：在 `packages/catalog/src/provider-models/descriptors.ts` 中配置，具有 `id: "xiaomi-token-plan-cn"`、`defaultModel: "mimo-v2.5"`、`envVars: ["XIAOMI_TOKEN_PLAN_CN_API_KEY"]`，以及委托给带 `tokenPlanRegion: "cn"` 的 `xiaomiModelManagerOptions` 的 `createModelManagerOptions`。
- **OpenAI 兼容条目**：在 `packages/catalog/src/provider-models/openai-compat.ts` 中通过 `openAiCompletionsDescriptor` 注册，base URL 为 `https://token-plan-cn.xiaomimimo.com/v1`。
- **区域发现与模型管理器**：`packages/catalog/src/provider-models/openai-compat.ts` 中的 `xiaomiModelManagerOptions` 将发现固定到 `XIAOMI_TOKEN_PLAN_BASE_URLS.cn`（`https://token-plan-cn.xiaomimimo.com/v1`）。动态模型发现保留 `providerId: "xiaomi-token-plan-cn"`，过滤 `-tts` 与 `-asr` 模型，并使用 `createBundledReferenceMap("xiaomi")` 合并来自捆绑 `xiaomi` 参考规格的元数据。

## Xiaomi Token Plan (新加坡) (`xiaomi-token-plan-sgp`)
Xiaomi Token Plan（新加坡）provider（`xiaomi-token-plan-sgp`）使用 OpenAI Chat Completions 传输（`openai-completions`）将请求路由到小米的新加坡 Token Plan 集群。它使用绑定区域的 `tp-...` API 密钥提供对小米 MiMo 模型（`mimo-v2.5`、`mimo-v2-omni`）的专用访问，目标为 `https://token-plan-sgp.xiaomimimo.com/v1`。此区域条目使登录与模型存储与标准 Xiaomi MiMo（`xiaomi`）及其他区域 token plan 端点（`xiaomi-token-plan-ams`、`xiaomi-token-plan-cn`）相隔离。

### 特殊情况
- **区域 base URL 绑定**：当配置 `tokenPlanRegion: "sgp"` 时，`xiaomiModelManagerOptions`（`packages/catalog/src/provider-models/openai-compat.ts`）显式将 `baseUrl` 设为 `https://token-plan-sgp.xiaomimimo.com/v1`（`XIAOMI_TOKEN_PLAN_BASE_URLS.sgp`），防止 token-plan 密钥回退到标准 Xiaomi 端点 `https://api.xiaomimimo.com/v1`（`XIAOMI_STANDARD_BASE_URL`）。
- **音频/语音模型排除**：`fetchOpenAICompatibleModels`（`packages/catalog/src/provider-models/openai-compat.ts`）与 `scripts/generate-models.ts` 中的模型生成器过滤（`isXiaomiProvider`）从动态目录发现与生成中过滤掉包含 `-tts` 或 `-asr` 的非聊天模型。
- **扩展流空闲超时**：`modelMatchesHost`（`packages/catalog/src/hosts.ts`）通过 `providerPrefixes` 匹配 `xiaomi-token-plan-`，继承 `packages/catalog/src/compat/openai.ts` 中的 `XIAOMI_MIMO_STREAM_IDLE_TIMEOUT_MS`（300,000ms / 5 分钟），以防止 MiMo 模型长时间初始响应延迟期间的过早超时。

### 认证与使用
- **固定区域验证**：严格针对新加坡端点 `https://token-plan-sgp.xiaomimimo.com/v1` 验证密钥（通过 `packages/catalog/src/compat/rules/auth/xiaomi-token-plan-sgp.kdl` 中的 `validate "chat-completions"`）。与通用 `loginXiaomi`（对 `tp-` 密钥执行 SGP -> AMS -> CN 回退）不同，`xiaomi-token-plan-sgp` 在认证验证期间禁用跨区域回退。
- **Plan 管理认证 URL**：在 `packages/catalog/src/compat/rules/auth/xiaomi-token-plan-sgp.kdl` 中声明，向用户提示指向 `https://platform.xiaomimimo.com/console/plan-manage` 的说明以获取区域 `tp-` 密钥（`placeholder="tp-..."`），与标准的 `https://platform.xiaomimimo.com/#/console/api-keys` 形成对照。
- **验证握手**：验证通过 `POST /chat/completions` 测试凭据，使用模型 `mimo-v2.5`（`packages/catalog/src/compat/rules/auth/xiaomi-token-plan-sgp.kdl` 中的 `validate "chat-completions"`）、`max_tokens: 1` 与 `messages: [{ role: "user", content: "ping" }]`，并强制 15 秒超时。
- **使用核算**：token 消耗与缓存指标通过标准 OpenAI Chat Completions 核算计算，即 `calculateOpenAIUsageAccounting`（`packages/ai/src/providers/openai-shared.ts`）。

### 目录模型处理
- **Provider 描述符**：在 `CATALOG_PROVIDERS`（`packages/catalog/src/provider-models/descriptors.ts`）中注册，具有 `id: "xiaomi-token-plan-sgp"`、`defaultModel: "mimo-v2.5"`，以及提供 `tokenPlanRegion: "sgp"` 与 `providerId: "xiaomi-token-plan-sgp"` 的 `createModelManagerOptions`。静态模型元数据在 `openAiCompletionsDescriptor`（`packages/catalog/src/provider-models/openai-compat.ts`）中声明。
- **Provider 身份保留**：`xiaomiModelManagerOptions`（`packages/catalog/src/provider-models/openai-compat.ts`）的动态模型抓取器（`fetchOpenAICompatibleModels`）为所有发现的模型打上 `provider: "xiaomi-token-plan-sgp"` 与 `baseUrl: "https://token-plan-sgp.xiaomimimo.com/v1"` 标签，确保存储的模型选择映射回新加坡 provider 条目。
- **捆绑规格映射**：动态模型映射使用 `createBundledReferenceMap`（`packages/catalog/src/provider-models/openai-compat.ts`）将动态模型与 `packages/catalog/src/models.json` 中定义在 `"xiaomi"` 之下的静态参考规格合并。

## Z.AI (GLM Coding Plan) (`zai`)
Z.AI 通过 Zhipu AI 的编码计划基础设施使用 Anthropic Messages 传输（`https://api.z.ai/api/anthropic`）提供 GLM 家族模型（如 `glm-5.2`）。认证同时支持直接 API 密钥与铸造持久 API 密钥的 OAuth 浏览器登录流程。

### 特殊情况
- **`zai` 思考格式方言**：`isZaiThinkingFormat`（`packages/catalog/src/model-thinking.ts`）与 `isZaiReasoningEffortDialect`（`packages/ai/src/providers/openai-shared.ts`）识别使用 `thinkingFormat: "zai"` 方言（`thinking: { type: "enabled" | "disabled" }`）的端点。当推理被关闭时（`reasoningDisableMode === "zai-thinking-disabled"` 或 wire effort `"none"`），`resolveOpenAICompatPolicy`（`packages/ai/src/providers/openai-shared.ts`）设置 `params.thinking = { type: "disabled" }`。
- **推理内容延续重放**：在 `streamOpenAICompletionsOnce`（`packages/ai/src/providers/openai-completions.ts`）中，当 `compat.thinkingFormat === "zai"` 且 `model.reasoning` 为 true 时，跨 API 的 provider 切换（例如 Anthropic → OpenAI）会把保留的思考块重新序列化进 `assistantMsg.reasoning_content`，以在不降级为文本的情况下保留结构化推理历史（#3434）。
- **外来思考保留**：`packages/ai/src/providers/transform-messages.ts` 中的 `targetReadsForeignThinking` 对具有 `compat.thinkingFormat === "zai"` 的推理模型返回 true，在消息转换中保留非原生思考块。
- **最大输出 token 钳制**：`packages/ai/src/providers/openai-shared.ts` 中的 `resolveOpenAICompletionsOutputClamp` 将 `isZaiReasoningEffortDialect` 模型（`glm-5.2`）的输出钳制为 `model.maxTokens`，而不是默认的 64k 上限。
- **主机 URL 匹配**：`packages/catalog/src/hosts.ts` 中的 `hostMatchesUrl` 依据 `api.z.ai` URL 标记匹配 Z.AI 端点。

### 认证与使用
- **API 密钥登录**：在 `packages/catalog/src/compat/rules/auth/zai.kdl` 中声明为 `login "api-key"` 规则（`packages/ai/src/registry/engine/api-key.ts`），提示输入 `ZAI_API_KEY`（仪表盘 `https://z.ai/manage-apikey/apikey-list`），并通过针对 `https://api.z.ai/api/coding/paas/v4` 使用模型 `glm-5.2` 的聊天补全探测进行验证。
- **OAuth 流程与浏览器登录**：在 `packages/catalog/src/compat/rules/auth/zai-coding-plan.kdl` 中声明为 `login "oauth-code"` 规则（`packages/ai/src/registry/engine/oauth-code.ts`），密钥铸造钩子在 `packages/ai/src/registry/oauth/zai.ts`。它在 `https://chat.z.ai/api/oauth/authorize` 发起授权，使用 ZCode 注册的 CLI 重定向 `http://127.0.0.1:9999/callback`（粘贴代码回退），并在 `https://zcode.z.ai/api/v1/oauth/token` 交换授权码。
- **持久密钥铸造**：`mintZaiApiKey`（`packages/ai/src/registry/oauth/zai.ts`）通过 `businessLogin`（`https://api.z.ai/api/auth/z/login`）将短期 OAuth token 交换为业务 token，通过 `getCustomerInfo`（`BIZ_BASE` = `https://api.z.ai`）解析默认组织/项目，创建或复用密钥 `"oh-my-pi"`（`KEY_NAME`），并通过 `/copy/${apiKey}` 复制密钥，以输出保存为 `storeCredentialsAs: "zai"` 的持久 49 字符 `${apiKey}.${secretKey}` token。
- **使用与配额抓取器**：`fetchZaiUsage` / `zaiUsageProvider`（`packages/ai/src/usage/zai.ts`）使用直接密钥授权查询 `DEFAULT_ENDPOINT`（`https://api.z.ai`）上的 `QUOTA_PATH`（`/api/monitor/usage/quota/limit`）。`parseLimitItem` 将 `TOKENS_LIMIT` 解析为 token 配额（`zai:tokens:<window>`）、将 `TIME_LIMIT` 解析为请求配额（`zai:requests:<window>`，或当 `isZaiFeatureRequestLimit` 匹配时为 `zai:features:zread:<window>`）、将 `CREDIT_LIMIT` 解析为信用额度配额（`zai:credits:<window>`，单位 `credits`），用于基于信用额度的 GLM Coding Plan（例如 12k 信用额度 / 5 小时 + 60k 信用额度 / 周；`usage` 是配额总量，`currentValue` 是消耗量）。负载的 `data.level`（例如 `"lite"`、`"pro"`、`"max"`）作为 `metadata.planType` 暴露。`buildZaiWindow` 将时间单位映射为 1h、1d、1mo 或 1w 窗口，并可选地抓取 `MODEL_USAGE_PATH`（`/api/monitor/usage/model-usage`）。
- **凭据排序**：`zaiRankingStrategy`（`packages/ai/src/usage/zai.ts`，注册于 `packages/ai/src/auth-storage.ts`）通过 `rankZaiRequestLimits` 对请求限制排序（当不存在请求配额时回退到完整凭据限制集——tokens/requests/credits），选择主要 5 小时与次要每周配额窗口。

### 目录模型处理
- **描述符与按需付费定价**：`packages/catalog/src/provider-models/openai-compat.ts` 中的 `MODELS_DEV_PROVIDER_DESCRIPTORS_CODING_PLANS` 定义 `anthropicMessagesDescriptor("zai", "zai", "https://api.z.ai/api/anthropic")`，映射 models.dev 的 `zai` 按需付费定价键而非 `zai-coding-plan`，以避免将订阅费率显示为全 $0 的 Free 模型（#5598）。
- **默认模型与上下文策略**：`packages/catalog/src/provider-models/descriptors.ts` 中的 `PROVIDER_DESCRIPTORS` 设置默认模型 `glm-5.2`。`generated-policies.ts`（`packages/catalog/scripts/generated-policies.ts`）将 `glm-5.2` 上下文窗口固定为 1,000,000 token，而 `dropUnusableZaiContextTierIds`（`packages/catalog/scripts/generate-models.ts`）过滤掉 `[1m]` 上下文档位 ID 后缀。
- **GLM-5.2 effort 支持**：`packages/catalog/src/model-thinking.ts` 中的 `getModelDefinedEfforts`（通过 `isAnthropicMessagesGlm52ReasoningEffortModel` 检查）为 `glm-5.2` 分配 `HIGH_MAX_REASONING_EFFORTS`（`["high", "max"]`），并将 `"none"` 视为禁用状态而非用户档位级别。

## ZenMux (`zenmux`)
ZenMux 是一个基于模型归属进行双传输路由的多 provider 网关。由 Anthropic 拥有的模型（通过 `owned_by: "anthropic"` 或 `anthropic/` 前缀识别）通过 Anthropic Messages（`https://zenmux.ai/api/anthropic`）路由，而所有其他模型通过 OpenAI Chat Completions（`https://zenmux.ai/api/v1`）路由。

### 特殊情况
- **双传输 base URL 归一化**：`normalizeZenMuxOpenAiBaseUrl` 与 `toZenMuxAnthropicBaseUrl`（`packages/catalog/src/provider-models/openai-compat.ts`）在端点 URL 之间转换。OpenAI 端点默认为 `https://zenmux.ai/api/v1`，Anthropic 路由到 `https://zenmux.ai/api/anthropic`，在指定自定义 base URL 时自动转换路径。
- **Anthropic 代理签名完整性**：`KNOWN_HOSTS.zenmux`（`packages/catalog/src/hosts.ts`）将 ZenMux 识别为签名主机。在 `buildAnthropicCompat`（`packages/catalog/src/compat/anthropic.ts`）中，`isZenmux` 将代理标记为 `signingEndpoint`，设置 `replayUnsignedThinking: false`。这确保历史思考块保留有效签名，而不是重放会触发 HTTP 400 错误的空签名。
- **严格模式支持**：`detectStrictModeSupport`（`packages/catalog/src/compat/openai.ts`）为 ZenMux 的 OpenAI 兼容端点启用严格结构化工具输出。

### 认证与使用
- **API 密钥解析**：`ZENMUX_API_KEY` 在 `descriptors.ts`（`packages/catalog/src/provider-models/descriptors.ts`）中注册，并通过 `packages/ai/src/stream.ts` 中的 `getEnvApiKey("zenmux")` 解析。
- **密钥验证与登录**：在 `packages/catalog/src/compat/rules/auth/zenmux.kdl` 中声明为 `login "api-key"` 规则（`packages/ai/src/registry/engine/api-key.ts`），引导用户前往 `https://zenmux.ai/settings/keys`，并通过 `validate "models-endpoint"` 针对 `https://zenmux.ai/api/v1/models` 验证凭据。
- **未认证发现**：`descriptors.ts` 中的 `allowUnauthenticated: true` 使模型目录发现无需 API 密钥即可进行。

### 目录模型处理
- **描述符与默认模型**：`descriptors.ts` 定义 provider 描述符，默认模型为 `anthropic/claude-opus-4.8`。
- **动态模型发现**：`packages/catalog/src/provider-models/openai-compat.ts` 中的 `zenmuxModelManagerOptions` 使用 `fetchOpenAICompatibleModels` 查询 `https://zenmux.ai/api/v1/models`。`isZenMuxAnthropicModel` 检查 `entry.owned_by === "anthropic"` 或 ID 前缀 `anthropic/`，以设置 `api: "anthropic-messages"` 或 `api: "openai-completions"`。
- **定价提取**：`getZenMuxPricingValue` 与 `getZenMuxCacheWritePrice`（`packages/catalog/src/provider-models/openai-compat.ts`）从 `entry.pricings` 提取 token 成本：`prompt` 为输入成本，`completion` 为输出成本，`input_cache_read` 为缓存读取成本，并按层级查找 `input_cache_write_1_h`、`input_cache_write_5_min` 或 `input_cache_write` 作为缓存写入成本。
- **能力与限制**：映射 `entry.display_name`、`entry.context_length`（`contextWindow`）、`entry.max_completion_tokens`（`maxTokens`）、`entry.input_modalities`（`input`）和 `capabilities.reasoning`（`reasoning`）。

## Zhipu Coding Plan (智谱) (`zhipu-coding-plan`)
Zhipu（智谱）BigModel 的国内编码计划 provider，使用 OpenAI Chat Completions 传输（`openai-completions` API）。它将请求路由到 Zhipu 专用的 Coding Plan 端点（`https://open.bigmodel.cn/api/coding/paas/v4`），而非通用 BigModel 端点，以确保 API 调用消耗编码计划配额而不是账户余额。

### 特殊情况
- **Z.AI 思考格式与推理 effort**：配置 `thinkingFormat: "zai"`（`packages/catalog/src/compat/openai.ts` 第 447 行），以通过 `thinking: { type: "enabled" }` 与 `reasoning_content` delta 构造思考输出（与 Z.AI 格式相互参照）。仅对 GLM-5.2+ 模型通过 `isGlm52ReasoningEffortModelId`（`packages/catalog/src/compat/openai.ts` 第 283、469 行）启用 `supportsReasoningEffort`。
- **流看门狗空闲下限**：当 `isZhipu` 生效时，为 GLM 编码计划模型 ID（`glm-5...`）应用 600 秒（`600_000` ms）的流空闲超时下限（`GLM_CODING_PLAN_STREAM_IDLE_TIMEOUT_MS = 600_000`、`GLM_CODING_PLAN_MODEL_PATTERN`，位于 `packages/catalog/src/compat/openai.ts` 第 39-40、417 行），避免长时间推理阶段中虚假的流看门狗中止。
- **最大 token 与系统消息**：为 `isZhipu` 设置 `useMaxTokens: true`（`packages/catalog/src/compat/openai.ts` 第 362 行）并启用 `supportsMultipleSystemMessages: true`（`packages/catalog/src/compat/openai.ts` 第 408 行）。

### 认证与使用
- **凭据与 API base**：通过 `ZHIPU_API_KEY`（`packages/catalog/src/provider-models/descriptors.ts` 第 541 行）认证，API base URL 为 `https://open.bigmodel.cn/api/coding/paas/v4`，仪表盘 URL 为 `https://bigmodel.cn/coding-plan/personal/overview`（`packages/catalog/src/compat/rules/auth/zhipu-coding-plan.kdl`）。
- **API 密钥登录与验证**：在 `packages/catalog/src/compat/rules/auth/zhipu-coding-plan.kdl` 中声明为 `login "api-key"` 规则（`packages/ai/src/registry/engine/api-key.ts`），密钥格式为 `<id>.<secret>`，针对 `https://open.bigmodel.cn/api/coding/paas/v4` 上的 `glm-5.1` 验证。主机检测通过 `hosts.ts` 接线（`zhipu`、urlMarker `open.bigmodel.cn`，`packages/catalog/src/hosts.ts` 第 42 行）。
- **中文 429 配额分类**：`packages/ai/src/error/rate-limit.ts` 第 60 行中的 `CN_QUOTA_EXHAUSTED_PATTERN`（`/使用.{0,30}?上限|(?:额度|配额)已?(?:用|耗)(?:完|尽)|限额.{0,30}重置|余额不足/`）将 Zhipu 的 429 配额耗尽响应（`"429 已达到 5 小时的使用上限。您的限额将在 ... 重置。"`）分类为 `QUOTA_EXHAUSTED`，触发凭据轮换而不是瞬时退避。

### 目录模型处理
- **Provider 描述符**：在 `CATALOG_PROVIDERS`（`packages/catalog/src/provider-models/descriptors.ts` 第 539 行）中注册，默认模型 `glm-5.1`、`dynamicModelsAuthoritative: true`，模型管理器选项来自 `zhipuCodingPlanModelManagerOptions`（`packages/catalog/src/provider-models/openai-compat.ts` 第 1689、5764 行）。
- **GLM 身份分类**：使用 `parseGlmModel`（`packages/catalog/src/identity/classify.ts` 第 145 行）将 `glm-<version>[v][-<variant>]` 解析为家族（`"glm"`）、版本、视觉标志（`v`）与变体（`base`、`air`、`turbo`、`flash`、`flashx`、`preview`）。
- **能力门控与策略**：`isReasoningGlmModelId`（`packages/catalog/src/identity/family.ts` 第 219 行）对版本 >= 4.5（`base`/`air`/`turbo`）门控推理，`isGlm52ReasoningEffortModelId` 对版本 >= 5.2 门控 `reasoning_effort`，`isGlmVisionModelId` 检测视觉模型（`glm-4v`、`glm-4.5v`）。生成的策略将 `glm-5.2` 上下文窗口固定为 1,000,000 token（`packages/catalog/scripts/generated-policies.ts` 第 332 行）。
