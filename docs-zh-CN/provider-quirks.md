# Provider quirks: special casings, streams, auth, and catalog handling

针对 `packages/ai` 各传输的逐 provider 深入解析:每个 provider 在共享管线之外的特殊处理、其 stream 与普通 SSE/delta 模型的区别、认证与使用/配额追踪方式,以及 `packages/catalog` 针对其模型的特殊做法(描述符、发现、身份、思考元数据、定价)。

相关参考:

- [Provider compat reference](./provider-compat-reference.md) — 兼容标志、推理等级、工具处理、强制工具选择
- [Provider endpoint constraints](./provider-endpoint-constraints.md) — 新增约束应放在哪里
- [Provider streaming internals](./provider-streaming-internals.md) — stream 事件归一化
- [Providers](./providers.md) — 可用性、凭据、登录流程


## OpenAI Chat Completions
OpenAI Chat Completions provider 为标准 OpenAI `/chat/completions` wire 协议(`ChatCompletionCreateParamsStreaming` 请求 schema 和 `ChatCompletionChunk` 事件负载)实现基于 Server-Sent Events (SSE) 的 HTTP POST JSON body 流式传输。它作为主要的主力传输,服务于 OpenAI 模型以及数十个 OpenAI 兼容网关和第三方 provider,包括 Groq、Cerebras、Mistral、DeepSeek、Fireworks、Zhipu (Z.AI)、Qwen (DashScope)、Kimi (Moonshot)、Synthetic、GitLab Duo、OpenRouter、Vercel AI Gateway、CoreWeave、HuggingFace、Nvidia NIM、Novita、GMI Cloud、Baseten、NanoGPT 和 Sakana/Fugu。传输在 `packages/ai/src/providers/openai-completions.ts`(主流式运行器 `streamOpenAICompletions`)、共享逻辑在 `packages/ai/src/providers/openai-shared.ts` 和 `packages/ai/src/utils/openai-http.ts`、动态网关路由在 `openai-shared.ts` 中实现。响应解析在 `parseChatCompletion`(`openai-shared.ts` 中),每个 chunk 包装在 `ChatCompletionChunk` 类型化结构中,使用 `OpenAICompletionsStreamDelta` 进行增量更新。

### Special casings
- **Azure Deployment Name Mapping**:`packages/ai/src/providers/openai-shared.ts` 中的 `parseAzureDeploymentNameMap` 在 `createRequestSetup`(`packages/ai/src/providers/openai-completions.ts`)中解析 `AZURE_OPENAI_DEPLOYMENT_NAME_MAP` 环境变量(逗号分隔的 `modelId:deploymentName` 对),以将模型 ID 转换为 Azure 部署名称,未映射时默认为 `model.id`。
- **Gateway Routing & Variant Transformations**:`packages/ai/src/providers/openai-shared.ts` 中的 `applyOpenAIGatewayRouting` 注入 OpenRouter provider 路由偏好(`params.provider`)。`applyOpenRouterRoutingVariant` 和 `applyWireModelIdTransform` 追加 OpenRouter 模型变体后缀(`:nitro`、`:floor`、`:online`、`:extended`)。`resolveSakanaRequestBaseUrl` 处理 Sakana/Fugu base URL 覆写(`SAKANA_BASE_URL` / `FUGU_BASE_URL`),`applyCoreWeaveProjectHeader` 注入 CoreWeave 项目头。
- **Empty-Completion Retry**:`streamOpenAICompletions` 用 `withEmptyCompletionRetry`(`packages/ai/src/utils/empty-completion-retry.ts`)包装,如果某个尝试以 `finish_reason: "stop"` 干净完成但未发出可见助手内容(`hasVisibleAssistantContent` 检查文本、思考、图像或工具调用)且 <= 1 个输出 token,则最多重试 `MAX_EMPTY_COMPLETION_RETRIES` 次(2 次重试,指数退避 `EMPTY_COMPLETION_BASE_DELAY_MS` = 500ms)。
- **Reasoning-Effort 400 Fallback**:`packages/ai/src/providers/openai-reasoning-fallback.ts` 中的 `resolveOpenAIReasoningEffortFallback` 和 `applyOpenAIReasoningEffortFallback` 拦截由不支持的 `reasoning_effort` 值引起的 400/422 HTTP 错误响应。它从错误消息中解析允许的等级(或解析最近的支持等级/null),在 provider 会话状态(`getOpenAICompletionsProviderSessionState`)中按 endpoint/model 键(`createOpenAIReasoningEffortFallbackKey`、`rememberOpenAIReasoningEffortFallback`)记住回退,并透明地重试请求而不会使回合失败。
- **Finish Reason Promotion**:在 `streamOpenAICompletionsOnce`(`packages/ai/src/providers/openai-completions.ts`)中,如果后端报告 `finish_reason: "stop"` 但回合产生了结构性 `toolCall` 块或通过 `StreamMarkupHealing` 修复了工具调用,则 `output.stopReason` 从 `"stop"` 提升为 `"toolUse"`,以便 agent 执行循环正确调用工具处理程序。
- **Mistral Tool ID Normalization**:`packages/ai/src/providers/openai-completions.ts` 中的 `normalizeMistralToolId` 将 Mistral 模型的工具调用 ID 限制为恰好 9 个字母数字字符(使用确定性字符 `"ABCDEFGHI"` 填充或截断)。
- **MiniMax Object Arguments Deep Merge**:`packages/ai/src/providers/openai-completions.ts` 中的 `mergeStreamingArgumentObjects` 处理以 JSON 对象而非字符串流式传输 `function.arguments` 的 MiniMax 兼容后端,跨 stream chunk 递归合并部分对象 delta。
- **DeepSeek Chat Template & Special Token Stripping**:`packages/ai/src/providers/openai-completions.ts` 中的 `stripDeepseekSpecialTokens` 和 `getTrailingPartialDeepseekToken` 在 DeepSeek 端点(例如 NVIDIA NIM、DeepSeek 原生 API)上缓冲并剥离泄漏在 `delta.content` 中的原始 `<｜...｜>` / `<|...|>` 聊天模板标记。
- **Dialect & Provider-Specific Quirks**:`packages/ai/src/providers/openai-shared.ts` 中的 `isZaiReasoningEffortDialect` 处理 GLM-5.2 `zai` 思考格式。`dropOpenRouterKimiForcedToolReasoning`、`hasActiveNativeKimiK3Reasoning` 和 `normalizeSchemaForMoonshot` 管理 Kimi (Moonshot) K3 工具 schema 和推理模式。`applyOpenAIChatCompletionsPromptCachePolicy` 注入 prompt 缓存断点(`cache_control: { type: "ephemeral" }` 或 `normalizeOpenAIPromptCacheKey` 64 字符 `pc_` 前缀)。

### Stream behavior
- **SSE Delta Decoding & Normalization**:`postOpenAIStream`(`packages/ai/src/utils/openai-http.ts`)使用 `readSseJson` 将原始 SSE `data:` 负载解码为 `ChatCompletionChunk` 对象。`normalizeStreamingContentText`(`packages/ai/src/providers/openai-completions.ts`)将 `delta.content` 归一化,无论以字符串还是内容部分数组(`[{ type: "text", text: "..." }]`,例如 Mistral Medium 3.5)形式接收,防止 `[object Object]` 字符串强制转换。
- **Reasoning Fields & Encrypted Signatures**:`streamOpenAICompletionsOnce` 检查 `delta.reasoning_content`(llama.cpp/vLLM)、`delta.reasoning` 和 `delta.reasoning_text`,使用每个 chunk 的第一个非空字段以防止重复推理文本。`delta.reasoning_details`(`reasoning.encrypted`)中的加密推理签名附加到对应的 `toolCall.thoughtSignature`。
- **Partial JSON Throttling**:`parseStreamingJsonThrottled`(来自 `@oh-my-pi/pi-utils`)在 `streamOpenAICompletionsOnce` 中的工具参数流式传输期间节流增量 JSON 解析,以避免高 CPU 开销。
- **Stream Markup Healing**:`StreamMarkupHealing`(`packages/ai/src/utils/stream-markup-healing.ts`)在配置 `policy.stream.markupHealingPattern` 时激活。它检查流式文本中 XML/markdown 包装的工具调用(例如 DSML 泄漏),解析已完成的工具调用,发出 `toolcall_start`/`toolcall_delta`/`toolcall_end` 事件,并将 `stop` 完成原因提升为 `toolUse`。
- **Demoted Thinking & Cumulative Reasoning**:`renderDemotedThinking`(`packages/ai/src/dialect/demotion.ts`)处理降级思考块(`isDemotedThinking`)。`lastCumulativeReasoningBySignature` 跨文本块转换跟踪累积推理流(例如 MiniMax-M3),以防止在可见文本开始后重新发出思考文本作为重复块。
- **Watchdogs & Terminal Grace Window**:`iterateWithIdleTimeout`(`packages/ai/src/utils/idle-iterator.ts`)使用 `getOpenAIStreamFirstEventTimeoutMs` 和 `getOpenAIStreamIdleTimeoutMs` 监控 stream 活动,向下游注入 `X-Stainless-Timeout` 头。在 stream 完成时,`iterateWithTerminalGrace` 强制 2,500ms 后完成宽限窗口(`OPENAI_COMPLETIONS_POST_FINISH_GRACE_MS`),允许尾随的仅使用 chunk(`stream_options.include_usage`)在关闭 stream 之前到达,这些 chunk 带有缓存读取 token 详情(`awaitTrailingUsageDetails`)。
- **Usage Chunk Parsing**:`packages/ai/src/providers/openai-completions.ts` 中的 `parseChunkUsage` 和 `applyUsagePayload` 从 `chunk.usage` 或 `choice.usage` 处理 token 使用情况。提取的字段包括 `prompt_tokens_details.cached_tokens`、`prompt_cache_hit_tokens`、`prompt_cache_miss_tokens`、`completion_tokens_details.reasoning_tokens`、`cache_write_tokens`,以及通过 `applyOpenRouterReportedCost`(`packages/ai/src/providers/openai-shared.ts`)从 provider 报告的成本。

### Auth & usage
- **API-Key Validation**:`packages/ai/src/registry/api-key-validation.ts` 中的 `validateOpenAICompatibleApiKey` 通过发出轻量级 `POST /chat/completions` 请求(使用 `messages: [{ role: "user", content: "ping" }]`、`max_tokens: 1`、`temperature: 0` 和 `Authorization: Bearer ${apiKey}`)来验证 API 凭据。
- **Credential Resolution & Env Vars**:`packages/ai/src/stream.ts` 中的 `getEnvApiKey` 解析 OpenAI 兼容 provider 的特定环境变量:`OPENAI_API_KEY`、`GROQ_API_KEY`、`CEREBRAS_API_KEY`、`MISTRAL_API_KEY`、`DEEPSEEK_API_KEY`、`FIREWORKS_API_KEY`、`OPENROUTER_API_KEY`、`TOGETHER_API_KEY`、`SAMBANOVA_API_KEY`、`NEBIUS_API_KEY`、`NOVITA_API_KEY`、`AVALAI_API_KEY`、`CHUTES_API_KEY`、`NANOGPT_API_KEY`、`HYPERBOLIC_API_KEY`、`PERPLEXITY_API_KEY`、`XAI_API_KEY` 和 `AZURE_OPENAI_API_KEY`。
- **Usage Accounting & Quota Surfacing**:`calculateOpenAIUsageAccounting`(`packages/ai/src/providers/openai-shared.ts`)将输入、输出、缓存读取和缓存写入 token 协调为标准 `Usage` 记录。OpenRouter 权威费用通过 `applyOpenRouterReportedCost` 填充到 `output.usage.cost` 中。Copilot 请求计数存储在 `output.usage.premiumRequests` 中。传输 HTTP 错误(例如 429 Rate Limit、408 Timeout、5xx Server Error)作为 `OpenAIHttpError`(`packages/ai/src/utils/openai-http.ts`)抛出,捕获状态、头和错误信封详情,以便在 `AIError.finalize` 中进行上游错误映射。

### Catalog model handling
- **Provider Descriptors**:`packages/catalog/src/provider-models/descriptors.ts` 中的 `CATALOG_PROVIDERS` 注册使用此传输的所有 catalog 条目(例如 `openai`、`groq`、`cerebras`、`mistral`、`deepseek`、`fireworks`、`openrouter`),指定 `api: "openai-completions"`、`defaultModel`、环境变量键和文档 URL。
- **Model Resolvers & Managers**:`packages/catalog/src/provider-models/openai-compat.ts` 中的 `createOpenAICompatibleModelManagerOptions` 为 `openai-completions` provider 构造模型管理器。它结合静态/精选模型定义、捆绑参考规范(`getBundledModels`)和从远程 catalog 端点获取的实时模型。
- **Catalog Discovery**:`packages/catalog/src/discovery/openai-compatible.ts` 中的 `fetchOpenAICompatibleModels` 查询 provider 的 `/models` 端点。它安全地解析信封(`data`、`models`、`result`、`items`),使用 `withOpenAICompatibleDiscoveryTimeout` 强制请求超时,验证模型记录 schema(`openAICompatibleModelRecordSchema`),应用自定义映射器/过滤器,并按 ID 对模型进行去重。
- **Identity & Classification**:`packages/catalog/src/identity/classify.ts` 中的 `parseKnownModel` 和 `parseOpenAIModel` 为匹配 `gpt-(\d+(?:\.\d+){0,2})(?:-(...))?` 的 OpenAI 模型提取模型族、变体(`base`、`codex`、`mini`、`max`、`nano`)和 SemVer 版本(`parseSemVer`)。版本比较工具(`semverGte`、`semverEqual`)驱动 GPT-4、GPT-4o 和 GPT-5 系列的能力检测。
- **Thinking Metadata & Effort Ladders**:`packages/catalog/src/model-thinking.ts` 中的 `resolveModelThinking` 和 `deriveThinking` 构造思考元数据(`ThinkingConfig`)并将模型身份/兼容设置映射到 effort 等级:
  - `DEFAULT_REASONING_EFFORTS`:`[minimal, low, medium, high]`
  - `DEFAULT_REASONING_EFFORTS_WITH_XHIGH`:`[minimal, low, medium, high, xhigh]`(例如 OpenRouter GLM-5.2)
  - `GPT_5_2_PLUS_EFFORTS`:`[low, medium, high, xhigh]`
  - `FIVE_TIER_EFFORTS_LOW_TO_MAX`:`[low, medium, high, xhigh, max]`(GPT-5.6+ wire effort 模型,Fire Pass Kimi 路由器)
  - `LOW_HIGH_MAX_REASONING_EFFORTS`:`[low, high, max]`(Kimi K3、DeepSeek V4 Flash)
  - `HIGH_MAX_REASONING_EFFORTS`:`[high, max]`(Z.ai/Umans/Baseten 上的 GLM-5.2,DeepSeek V4 Pro)
  - `HIGH_ONLY_REASONING_EFFORTS`:`[high]`(OpenRouter DeepSeek)
  - `OLLAMA_REASONING_EFFORTS`:`[low, medium, high, max]`(Ollama 端点)

## OpenAI Responses
OpenAI Responses provider(`packages/ai/src/providers/openai-responses.ts`)处理 OpenAI 的有状态 `/v1/responses` HTTP Server-Sent Events (SSE) 流式传输 wire 协议(类型在 `openai-responses-wire.ts` 中定义,共享的编码和解码逻辑在 `openai-shared.ts` 中)。与 chat completions 不同,Responses API 在结构化项序列(`ResponseInput`)上运行,包含类型化的输入/输出项(`input_text`、`input_image`、`input_file`、`message`、`function_call`、`custom_tool_call`、`computer_call`、`reasoning`),通过 `previous_response_id` 支持服务器端上下文链接,支持显式 prompt 缓存断点,以及原生推理摘要和加密内容块。

### Special casings
- **Responses input-item model vs chat messages**:`openai-shared.ts` 中的 `buildResponsesInput` 将标准对话上下文转换为 `ResponseInput` 数组(`ResponseInputItem[]`)。系统指令默认使用顶层 `instructions`,或在 `policy.messages.systemRole === "developer"`(推理模型所需)时使用开发者角色项(`{ role: "developer" }`)。重放历史根据 `filterReasoningHistory` 剥离或保留推理项,而 Harmony 方言模型(GPT-5+)通过 `escapeReplayedControlTokens` 在重放的传输数据中转义保留的控制 token 拼写。
- **`previous_response_id` chaining & stale-chain reset**:`openai-responses.ts` 中的 `buildOpenAIResponsesChainedParams` 管理有状态回合。当 `statefulResponses` 处于活动状态时(默认对官方 OpenAI 端点通过 `PI_OPENAI_STATEFUL` 标志和 `hostMatchesUrl` 启用),请求强制 `store: true` 并计算锚定到 `previous_response_id` 的 delta 负载(`buildResponsesDeltaInput`)。如果历史发生变化、选项更改或 prompt 缓存断点策略改变,则链重置为完整重放(`resetOpenAIResponsesChainState`)。如果端点返回陈旧 ID 错误(`isOpenAIResponsesStalePreviousResponseError`),则 provider 增加 `staleFailures` 并回退到完整转录重放;在 `OPENAI_RESPONSES_CHAIN_STALE_FAILURE_LIMI…` 之后...
- **Encrypted reasoning items & summaries**:通过 `policy.reasoning.includeEncryptedReasoning` 支持 `include: ["reasoning.encrypted_content"]`。`ResponseReasoningItem` 对象包含加密内容负载、推理文本 delta(`response.reasoning_text.delta`)和摘要文本 delta(`response.reasoning_summary_text.delta`)。携带序列化 JSON 的思考签名通过 `parseResponseReasoningReplayItem` 解析,并在 `filterReasoningHistory` 为 false 时作为原生 `reasoning` 项重放。
- **Composite `callId|itemId` tool IDs**:`packages/ai/src/utils.ts` 中的 `normalizeResponsesToolCallId` 处理工具调用 ID 归一化。Responses 中的工具调用标识符是格式为 `${callId}|${itemId}` 的复合字符串。该函数将传入的 ID 按 `|` 分割为不同的 `callId`(用 `call_` 前缀截断为 64 个字符)和 `itemId`(用 `fc_` 或 `ctc_` 前缀)。当传递未合成的 ID 时,它生成基于哈希的对(`call_<hash>` 和 `fc_<hash>` / `ctc_<hash>`)。转换后的消息使用 `normalizeResponsesToolCallIdForTransform` 以保持跨工具调用和工具结果消息的对齐。
- **Custom (freeform) tools & computer tools**:`convertTools` 中的工具转换处理函数、自定义和计算机工具。当 `model.applyPatchToolType === "freeform"`(通过 `supportsFreeformApplyPatch` 检查)时,自定义格式工具(如 `apply_patch`)编码为 `type: "custom"`,并使用语法定义(`compactGrammarDefinition`)。当 `model.supportsComputerUse === true` 时,原生计算机工具(`type: "computer"`)使用结构化 `ComputerAction` 列表发出 `computer_call` 和 `computer_call_output` 项;不支持原生计算机的模型回退到常规函数工具。工具 schema 通过 `sanitizeSchemaForOpenAIResponses` 和 `adaptSchemaForStrict` 进行清理,违反严格约束的 schema 被隔离(`findStrictT…`)。
- **Service tier & obfuscation opt-out**:`serviceTier` 选项向下传递给采样参数,并通过 `processResponsesStream` 在输出使用情况中报告。当 `model.compat.supportsObfuscationOptOut` 为 true 时,采样参数包括 `stream_options: { include_obfuscation: false }`。
- **Image detail handling**:`convertResponsesInputContent` 和 `appendResponsesToolResultMessages` 中的图像内容转换遵守 `model.compat.supportsImageDetailOriginal`。当为 false 时,`"original"` 图像 detail 值映射为 `"auto"` 以防止上游拒绝。[provider compatibility reference](./provider-compat-reference.md) 拥有多模态工具结果编码契约。

### Stream behavior
- **Stream event protocol (`response.*` lifecycle)**:`openai-shared.ts` 中的 `processResponsesStream` 处理 `/v1/responses` 发出的 SSE 事件。处理生命周期事件,包括 `response.created`、`response.output_item.added`、`response.output_text.delta`、`response.reasoning_text.delta`、`response.reasoning_summary_text.delta`、`response.function_call_arguments.delta`、`response.custom_tool_call_input.delta`、`response.output_item.done`、`response.completed` 和 `response.done`。交错并行工具调用在 `output_index`、`item_id` 和前缀调用 ID 查找映射(`openItemsByOutputIndex`、`openItemsByItemId`、`openItemsByPrefixedCallId`)中并发跟踪。
- **Watchdogs & transient retries**:`streamOpenAIResponsesOnce` 使用 `iterateWithIdleTimeout` 和两个超时阈值:`streamFirstEventTimeoutMs`(带有 `X-Stainless-Timeout` 请求头)用于初始响应头/事件,`streamIdleTimeoutMs` 用于事件间停顿。如果 stream 在发出重放不安全输出(`isOpenAIResponsesReplayUnsafeEvent`)之前过早终止,则单次尝试 streamer 在延迟(`OPENAI_RESPONSES_TRANSIENT_STREAM_RETRY_DELAY_MS` = 500ms)后执行瞬态重试(`OPENAI_RESPONSES_MAX_TRANSIENT_STREAM_RETRIES` = 1)。公共 `streamOpenAIResponses` 用 `withEmptyCompletionRetry` 包装执行以重试空补全。

### Auth & usage
- 标准 OpenAI 认证依赖于通过 `getEnvApiKey` 和 `openai-shared.ts` 中的 `resolveOpenAIRequestSetup` 解析的 `OPENAI_API_KEY`(或 provider 特定的环境变量)。请求传递标准 Bearer token 授权头(`Authorization: Bearer <key>`)以及可选的 Stainless/Copilot 头。*(注意:`openai-codex` / ChatGPT 订阅计划 OAuth 认证单独处理)。*

### Catalog model handling
- **`gpt-5+` identity classification**:`gpt-5` 系列中的模型通过 `packages/catalog/src/identity/family.ts` 中的 `isOpenAIWireGen5Plus` 和 `isOpenAIWireGen54Plus` 识别。`gpt-5+` 模型通过 HTTP 400 错误拒绝遗留的采样参数(例如 `temperature`、`top_p`、`frequency_penalty`)、跨服务主机,`buildOpenAICompat` / `buildOpenAIResponsesCompat` 通过 `supportsReasoningParams` 考虑这一点。
- **Prompt-cache breakpoints (`supportsOfficialOpenAIPromptCacheBreakpoints`)**:在 `packages/catalog/src/compat/openai.ts` 中求值。`supportsOfficialOpenAIPromptCacheBreakpoints` 对于为版本 >= 5.6 的模型提供服务的官方 OpenAI 端点返回 true。当启用且 `promptCache.mode === "explicit"` 时,`openai-responses.ts` 中的 `markLatestStableResponsesCacheBreakpoint` 将 `{ mode: "explicit" }` `prompt_cache_breakpoint` 注释注入到最新稳定开发者/用户消息块,同时保留有状态基线断点。
- **Reasoning summary config & effort ladders**:`buildParams` 通过 `applyResponsesCompatPolicy` 应用推理参数。Effort 参数通过模型特定映射(`reasoningEffortMap` 或 `thinking.effortMap`)映射。对于 `gpt-5.6+` 模型和 5 级 effort 标度(包括 `xhigh` 和 `max`),`model-thinking.ts` 配置 effort 等级(`minimal`、`low`、`medium`、`high`、`xhigh`、`max`),按主机方言 1:1 映射 `xhigh` 和 `max` 或进行移位(例如 `KIMI_K3_REASONING_EFFORT_MAP`、`MIMO_REASONING_EFFORT_MAP`)。生成的专业别名(`gpt-5.6-*-pro`)自动附加 `reasoningMode: "pro"`。

## OpenAI Codex
OpenAI Codex provider 通过 SSE 或 WebSocket 传输在 OpenAI Responses API 表面上集成 ChatGPT Plus/Pro 订阅模型。请求以 ChatGPT OAuth token 面向 ChatGPT 后端(`https://chatgpt.com/backend-api/codex/responses` 或自定义 base URL),具有账户级隔离。入口模块包括 `packages/ai/src/providers/openai-codex-responses.ts` 中的流式传输、`packages/ai/src/providers/openai-codex/request-transformer.ts` 中的请求转换、`packages/ai/src/providers/openai-codex/response-handler.ts` 中的错误和速率限制解析、`packages/ai/src/usage/openai-codex.ts` 中的配额和使用追踪、`packages/ai/src/usage/openai-codex-reset.ts` 中的重置管理、`packages/ai/src/usag…` 中的 base URL 归一化...

### Special casings
- **WebSocket vs SSE dual transport**:通过 `packages/ai/src/providers/openai-codex-responses.ts` 中的 `CodexWebSocketConnection` 支持 WebSocket 流式传输(`v2StreamingEnabled: true`,头 `OpenAI-Beta: responses_websockets=2026-02-06`,`preferWebsockets` 选项)。重用 socket 最多空闲重用上限(`CODEX_WEBSOCKET_MAX_IDLE_REUSE_MS` = 30s)、ping/pong 心跳(10s 间隔,60s 超时)和队列容量(4096)。在连接/握手失败时立即回退到 SSE(`CODEX_WEBSOCKET_FATAL_PATTERNS`、`CodexWebSocketTransportError`)。
- **Sampling parameter stripping**:在 `packages/ai/src/providers/openai-codex/request-transformer.ts` 的 `transformRequestBody` 中剥离采样参数(`temperature`、`top_p`、`top_k`、`min_p`、`presence_penalty`、`repetition_penalty`、`frequency_penalty`、`stop`);Codex 后端在发送任何采样参数时返回 HTTP 400 `Unsupported parameter`(#3117)。
- **Responses Lite transport**:通过 catalog(`useResponsesLite`)、请求选项(`responsesLite`)或 `PI_CODEX_RESPONSES_LITE` 环境(`resolveCodexResponsesLite`)启用。函数 `applyCodexResponsesLiteShape` 将声明的工具嵌入到前导 `additional_tools` 开发者项中,将系统指令嵌入到开发者消息中,剥离图像 `detail`,关闭并行工具调用,强制 `reasoning.context: "all_turns"`,并附加 `x-openai-internal-codex-responses-lite: true` 头(或 WS `client_metadata` 中的 `ws_request_header_x_openai_internal_codex_responses_lite`)。如果没有匹配的声明工具,则托管工具选择(`tool_choice`)回退到 `"auto"`(#5771)。
- **Tool call/output pair repair**:`request-transformer.ts` 中的 `repairToolCallPairs` 将缺少先前调用的孤立 `function_call_output`/`custom_tool_call_output` 重写为助手消息(`[Previous tool result; call_id=...]`),并为缺少输出的孤立调用注入合成输出(`[No tool output recorded...]`),防止后端 HTTP 400 验证失败。
- **Session affinity & headers**:发出会话头,包括 `session_id`、`session-id`、`x-codex-installation-id`、`x-codex-window-id`、`x-codex-turn-metadata`(包含 `turn_id`、`installation_id`、`parent_turn_id`、`request_kind` 的 JSON)、`x-codex-parent-thread-id` 和 `x-openai-subagent`,在 `packages/catalog/src/wire/codex.ts` 和 `openai-codex-responses.ts` 中定义。
- **Attestation & compression**:咨询进程范围的 DeviceCheck 认证 hook `setCodexAttestationProvider` 以获取 `x-oai-attestation` 头(`getCodexAttestationHeader`)。在 `PI_CODEX_ZSTD` 处于活动状态时,使用 zstd(`compressCodexRequestBody`)压缩官方源的请求体负载。
- **Region-pinned workspace residency**:企业 ChatGPT 工作空间可以固定到数据驻留区域,并拒绝任何出口区域不同的 Codex 请求 — HTTP 401 `Workspace is not authorized in this region.` — 除非客户端自己声明工作空间驻留。Codex 请求构建器从 OAuth 访问 token(`packages/catalog/src/wire/codex.ts` 中的 `getCodexResidency`,声明 `chatgpt_data_residency` 与 `chatgpt_compute_residency` 作为回退)读取它,并在 chat SSE 和 WebSocket 传输、web 搜索、远程压缩和 `generate_image` 上发送 `x-openai-internal-codex-residency`。没有该声明的账户(个人 ChatGPT、不是 JWT 的不透明代理密钥)不发送头,并且相同名称的调用方提供的头 i...
- **Harmony control token escaping**:使用 `escapeHarmonyControlTokens` 对使用 Harmony 方言(`isHarmonyDialectModel`)的模型重放的输入文本进行清理。

### Stream behavior
- **Event protocol**:解析 SSE JSON 负载或 WebSocket 帧(`response`、`sequence_number`、`type`)。触发进度事件(`isOpenAIResponsesProgressEvent`、`CODEX_ADDITIONAL_PROGRESS_EVENT_TYPES`,例如 `response.done` 和 `response.incomplete`)。
- **Timeout watchdogs**:对第一个事件强制 `CODEX_WEBSOCKET_FIRST_EVENT_TIMEOUT_MS`(300s),对稳态 stream 空闲上限强制 `CODEX_WEBSOCKET_IDLE_TIMEOUT_MS`(300s),并对 SSE stream 使用 `iterateWithIdleTimeout`。
- **Stale history recovery**:在陈旧 `previous_response_id` 错误(`CODEX_STALE_PREVIOUS_RESPONSE_CODES`)上通过清除无效的链式响应指针并重试来重新流式传输/重放。
- **Retry budget & rate limits**:对瞬态错误(`model_error`、`server_error`、`internal_error` 或 `CODEX_RETRYABLE_EVENT_MESSAGE`)最多 `CODEX_MAX_RETRIES`(5)次重试。在 5 分钟预算(`CODEX_RATE_LIMIT_BUDGET_MS`)内处理 HTTP 429 退避和服务器重试延迟。
- **Whitespace loop defense**:检测无限空白工具调用参数 delta(`CODEX_WHITESPACE_TOOL_CALL_ARGUMENT_DELTA_EVENT_LIMIT` = 256,16KB 限制),使用 `CodexWhitespaceToolCallLoopError` 中断执行并尝试最多 2 次重试(`CODEX_WHITESPACE_LOOP_RETRY_LIMIT`)。
- **Concurrent reasoning summaries**:当请求推理摘要时,请求体包括 `stream_options: { reasoning_summary_delivery: "sequential_cutoff" }`(`supportsCodexReasoningSummary`),在摘要完成之前启用输出文本流式传输。

### Auth & usage
- **OAuth login flows**:在 `packages/ai/src/registry/oauth/openai-codex.ts` 中实现 ChatGPT OAuth。浏览器流使用 PKCE S256(`createOpenAICodexAuthorizationUrl`),固定本地端口 1455(`http://localhost:1455/auth/callback`),客户端 ID `app_EMoamEEZ73f0CkXaXp7hrann`,以及简化的 CLI 流标志。无头设备码流(`loginOpenAICodexDevice`)使用 `https://auth.openai.com/api/accounts/deviceauth/usercode` 并轮询 `deviceauth/token`。
- **Token refresh & claims**:`refreshOpenAICodexToken` 将 `grant_type: refresh_token` 发布到 `https://auth.openai.com/oauth/token`。从 JWT 声明中提取 `chatgpt_account_id` 和用户 `email`(`getTokenProfile` 中的 `https://api.openai.com/auth` 和 `https://api.openai.com/profile`)。
- **Account rotation & rate-limit ranking**:账户身份通过 `ChatGPT-Account-Id` 头设置(`getCodexAccountId`)。`packages/ai/src/usage/openai-codex.ts` 中的 `codexRankingStrategy` 将标准聊天限制(主要 5h,次要 7d)与 Spark 计量限制(`-spark` 模型后缀消耗 `spark` 范围)隔离,防止 Spark 耗尽阻塞正常聊天请求。
- **Usage tracking**:`openaiCodexUsageProvider` 在规范 ChatGPT 源上查询 `/wham/usage`。解析 `primary_window`(5h)和 `secondary_window`(7d),以及 `additional_rate_limits`(Spark/额外计量)。在 `response-handler.ts` 的 `parseCodexError` 中的 `parseCodexRateLimitHeaders` 中提取响应头(`x-codex-primary-used-percent`、`x-codex-primary-window-minutes`、`x-codex-primary-reset-at`、`x-codex-secondary-*`)。
- **Saved rate limit reset credits**:从 `/wham/usage` 读取 `rate_limit_reset_credits`。使用 `listCodexResetCredits`(`GET /wham/rate-limit-reset-credits`)列出可用信用,使用 `pickSoonestExpiringCredit` 选择最快过期的信用,并通过 `consumeCodexResetCredit`(`POST /wham/rate-limit-reset-credits/consume` 与客户端 UUID `redeem_request_id`)兑换。
- **Base URL normalization**:`packages/ai/src/usage/openai-codex-base-url.ts` 中的 `normalizeCodexBaseUrl` 强制账户 API 请求(`wham/usage`、重置信用)到规范 `chatgpt.com` 或 `chat.openai.com` 源(`/backend-api`),忽略会 404 的自定义代理覆写(`providers.openai-codex.baseUrl`)。Stream URL 通过 `openai-codex-responses.ts` 中的 `resolveCodexResponsesUrl` 解析。

### Catalog model handling
- **Descriptor & management**:在 `packages/catalog/src/provider-models/descriptors.ts` 中定义为 `openai-codex` provider 描述符(默认模型 `"gpt-5.5"`)。在 `packages/catalog/src/provider-models/special.ts` 的 `createOpenAICodexModelManagerOptions` 中配置为具有动态模型发现特殊管理的 provider。
- **Dynamic discovery**:`packages/catalog/src/discovery/codex.ts` 中的 `fetchCodexModels` 使用 `v2StreamingEnabled: true` 查询 `/codex/models` 或 `/models`,将 `reasoning_presets`(`effort`、`summary`)解析为 `ModelSpec<"openai-codex-responses">`。
- **Identity & classification**:`packages/catalog/src/identity/classify.ts` 中的 `OpenAIVariant` 支持 `"codex"`、`"codex-max"`、`"codex-mini"`、`"codex-spark"`。`parseOpenAIModel` 匹配 `gpt-X.Y-(codex-spark|codex-mini|codex-max|codex|mini|max|nano)`。`packages/catalog/src/identity/priority.ts` 中的优先级列表将 `openai-codex` 排名在通用 provider 回退之上。
- **Thinking & effort limits**:`packages/catalog/src/model-thinking.ts` 映射支持的 effort(`minimal`、`low`、`medium`、`high`、`xhigh`、`max`),精准定位模型特定等级(例如 `GPT_5_1_CODEX_MINI_EFFORTS`),并检查 `identity/family.ts` 中的 `supportsAllTurnsReasoningContext` 和 `supportsCodexReasoningSummary`。
- **Pricing fallback**:`packages/catalog/scripts/generate-models.ts` 中的 `applyCodexPricingFallback` 在 Codex 发现模型缺少显式成本元数据时,从具有匹配模型 ID 的 `openai` provider 条目复制可计费成本。

## Azure OpenAI
Azure OpenAI Responses provider(`azure-openai-responses`)处理通过 Azure OpenAI 的 Responses API 提供服务的 OpenAI 系列模型(GPT-4/4.1/4o、GPT-5 系列、o 系列、Codex)的传输、端点解析和兼容性包装。它使用内部 `postOpenAIStream` 传输(`packages/ai/src/utils/openai-http.ts`)进行 JSON-POST / SSE 请求。流生成在 `streamAzureOpenAIResponses`(`packages/ai/src/providers/azure-openai-responses.ts`)中初始化,而共享 Responses 输入/输出处理逻辑位于 `packages/ai/src/providers/openai-shared.ts`。

### Special casings
- **Deployment-name mapping**:Azure OpenAI 需要请求负载中的部署名称。`resolveDeploymentName`(`packages/ai/src/providers/azure-openai-responses.ts`)检查 `options.azureDeploymentName`,然后检查 `AZURE_OPENAI_DEPLOYMENT_NAME_MAP` 环境变量(由 `openai-shared.ts` 中的 `parseAzureDeploymentNameMap` 解析为 `modelId=deploymentName` 对的映射,例如 `gpt-5-mini=my-mini-dep,o3=my-o3-dep`),并默认为 `model.id`。
- **Base-URL / resource resolution**:`resolveAzureConfig`(`packages/ai/src/providers/azure-openai-responses.ts`)检查 `options.azureBaseUrl` 或 `$env.AZURE_OPENAI_BASE_URL`。如果缺失,则从 `options.azureResourceName` 或 `$env.AZURE_OPENAI_RESOURCE_NAME` 构造 `https://${resourceName}.openai.azure.com/openai/v1`。如果仍然缺失,则回退到 `model.baseUrl`,如果未找到端点则抛出 `AIError.ConfigurationError`。剥离尾部斜杠。
- **API-version handling**:`resolveAzureConfig` 从 `options.azureApiVersion`、`$env.AZURE_OPENAI_API_VERSION` 解析 API 版本,或默认为 `"v1"`。它作为请求上的 `api-version` URL 查询参数传递(`${baseUrl}/responses?api-version=${apiVersion}`),而不是作为 HTTP 头传递。
- **Strict responses tool-pairing**:默认通过 `buildOpenAIResponsesCompat`(`packages/catalog/src/compat/openai.ts`,`isAzure = true`)为 Azure OpenAI 模型启用。在 `buildResponsesInput` / `appendResponsesToolResultMessages`(`packages/ai/src/providers/openai-shared.ts`)中,Azure 的严格后端拒绝未配对的工具输出(`callId` 不是由先前的助手 `function_call` 项发出的结果)。Omp 将孤立工具结果折叠为合成助手注释消息(`[Orphan <tool> result; call_id=<id>]: <text>` 最多 16,000 个字符,或 `[Orphan computer result; call_id=<id>]`),而不是发送未配对的输出项。
- **Image detail clamps**:在 `appendResponsesToolResultMessages` / `convertResponsesInputContent` 中,如果 `supportsImageDetailOriginal` 为 `false`,则 `clampResponsesImageDetail` 将 `detail: "original"` 限制为 `"auto"`。对于 Azure OpenAI,`supportsImageDetailOriginal` 为 `true`(与 GitHub Copilot 和 xAI OAuth 不同),保留原始图像分辨率。
- **Computer-tool fallback mapping**:`packages/ai/src/providers/azure-openai-responses.ts` 中的 `modelForAzureEndpoint` 验证解析的端点主机是否以 `.openai.azure.com` 或 `models.inference.ai.azure.com` 结尾。如果通过无法识别的代理路由,则 `supportsComputerUse` 被禁用。在 `buildParams` 中,如果工具具有 `native.type === "computer"` 且 `model.supportsComputerUse` 为 `true`,则它被序列化为 `{ type: "computer" }`。如果 `supportsComputerUse` 为 `false`,则它回退到将计算机工具序列化为标准的 `{ type: "function", name: tool.name, ... }` 工具。`tool_choice` 在 `computer` 和 `function` 目标之间自动转换。
- **Differences from plain Responses (`openai-responses`)**:使用 `api-key` 头(从不使用 `Authorization: Bearer`),使用固定端点路径 `${baseUrl}/responses?api-version=...`(`/responses` 路径是非部署范围的,与 Chat Completions `/deployments/{dep}/chat/completions` 不同),将部署名称作为 `model` 传递到请求体中,执行从环境/选项的动态运行时端点构造,并将 `strictResponsesPairing` 默认为 `true`。

### Stream behavior
- **Event processing**:使用 `packages/ai/src/providers/openai-shared.ts` 中的 `processResponsesStream` 来消费 SSE stream 事件(`response.created`、`response.output_item.added`、`response.content_part.added`、`response.output_text.delta`、`response.completed`、`response.incomplete`)。终端 `response.incomplete` 事件(输出 token 截断)更新使用计数器并将 `stopReason` 设置为 `"length"`。
- **Idle & first-event watchdogs**:用 `iterateWithIdleTimeout` 包装。如果在 `streamFirstEventTimeoutMs` 内第一个 SSE 事件未到达,则中止并显示 `"Azure OpenAI responses stream timed out while waiting for the first event"`。
- **Untyped SSE payload resolution**:`onSseEvent` 检查未类型化的 JSON 事件数据(`type` 或 `object` 属性)以在标准 SSE 头行中缺少事件类型标签时附加该标签。
- **Reasoning effort fallback**:在 stream 启动期间捕获 `OpenAIHttpError`。如果端点拒绝请求的推理 effort(例如 `xhigh`),则 `resolveOpenAIReasoningEffortFallback` 确定较低的 effort 级别,逐步降低 `params.reasoning`,并使用 `createOpenAIReasoningEffortFallbackKey("azure-responses", url, model)` 重试请求。

### Auth & usage
- **Credential source**:从 `options.apiKey` 或 `$env.AZURE_OPENAI_API_KEY` 源获取(通过 `packages/ai/src/stream.ts` 中的 `getEnvApiKey(model.provider)` 或 `buildAzureResponsesRequest` 检索)。作为 `api-key` 头发送。
- **Usage tracking**:直接从终端 `response.completed` / `response.incomplete` stream 事件(`input_tokens`、`output_tokens`、`reasoning_tokens`、`cached_tokens`)中提取,由 `processResponsesStream` 处理。`packages/ai/src/usage/` 下不存在单独的使用追踪器。
- **Prompt caching controls**:`prompt_cache_key` 通过 `getOpenAIPromptCacheKey(options)` 生成。显式 prompt 缓存模式被拒绝(`AIError.ConfigurationError`),因为 Azure Responses 不支持显式缓存控制头或保留指令。

### Catalog model handling
- **Descriptors**:在 `packages/catalog/src/provider-models/descriptors.ts` 中定义的 catalog provider(`id: "azure"`、`defaultModel: "gpt-5.5"`、`envVars: ["AZURE_OPENAI_API_KEY"]`)。在 `packages/catalog/src/provider-models/openai-compat.ts` 中,通过 `simpleModelsDevDescriptor("azure", "azure", "azure-openai-responses", "", ...)` 映射,该选项将模板 catalog 模型过滤为具有工具能力的 OpenAI 系列 ID(`gpt-`、`o1`、`o3`、`o4`、`codex`、`chatgpt`),删除第三方 Foundry 模型(Claude、DeepSeek、Llama、Mistral、Phi)。
- **Why bundled models carry no `baseUrl`**:Azure OpenAI 端点是资源特定的,在 catalog 生成期间是未知的(`models.json` 存储 `baseUrl: ""`)。运行时解析从 `AZURE_OPENAI_BASE_URL` 或 `AZURE_OPENAI_RESOURCE_NAME` 解析端点。兼容性检测(`packages/catalog/src/compat/openai.ts` 中的 `isAzure`)匹配 `provider === "azure"`,确保携带空 `baseUrl` 的捆绑模型仍接收 Azure 兼容标志(`strictResponsesPairing`、`supportsDeveloperRole`、`supportsStrictMode`)。
- **Identity & classification**:`hosts.ts` 定义 `azureOpenAI` 匹配 `provider: "azure"` 或以 `.openai.azure.com`、`azure.com/openai` 或 `models.inference.ai.azure.com` 结尾的主机名。
- **Thinking metadata**:在 `packages/catalog/src/model-thinking.ts` 中,Azure 推理模型(o 系列、GPT-5、Codex)通过 `DEFAULT_REASONING_EFFORTS_WITH_XHIGH` 解析离散的 OpenAI 推理 effort 等级(`minimal`、`low`、`medium`、`high`、`xhigh`、`max`)。

## Anthropic Messages
Anthropic provider(`packages/ai/src/providers/anthropic.ts`)通过 HTTPS POST 到 `/v1/messages`(或 `/v1/messages?beta=true`)实现 Anthropic Messages API 协议,使用 Server-Sent Events (SSE)进行流式传输。自定义 HTTP 客户端传输由 `AnthropicMessagesClient`(`packages/ai/src/providers/anthropic-client.ts`)提供,用内置的重试和超时逻辑替换 `@anthropic-ai/sdk`。Wire 结构和 SSE 负载在 `packages/ai/src/providers/anthropic-wire.ts` 中类型化。客户端指纹常量(版本、user-agent、工具前缀)位于 `packages/ai/src/providers/claude-code-fingerprint.ts`,而低级 Node HTTPS socket 重用和头排序由 `coworkFetch`(`packages/ai/src/providers/cowork-fetch.t…`)处理。

### Special casings
- **OAuth vs API Key Paths**:`buildAnthropicHeaders`(`packages/ai/src/providers/anthropic.ts`)检查 `options.isOAuth ?? isAnthropicOAuthToken(apiKey)`。OAuth 请求发送 `Authorization: Bearer <token>` 而不发送 `X-Api-Key`,默认 `Accept: application/json`(或 `text/event-stream`),并注入 Cowork 桌面 beta 标志(`buildCoworkBetas`)。API key 请求发送 `X-Api-Key: <key>` 而不发送 `Authorization`,仅包括调用方额外的 beta。当 `allowAnthropicHeaderOverrides` 启用时,非官方端点允许头覆写。
- **Claude Code Fingerprint Headers & Betas**:默认头包括 `anthropic-version: 2023-06-01`、`anthropic-dangerous-direct-browser-access: true`、`x-app: cli` 和 `User-Agent: claude-cli/2.1.220 (external, claude-desktop)`(`coworkUserAgent`)。活动 beta 标志(`buildCoworkBetas`)包括 `claude-code-20250219`、`interleaved-thinking-2025-05-14`、`thinking-token-count-2026-05-13`、`context-management-2025-06-27`、`prompt-caching-scope-2026-01-05`、`mid-conversation-system-2026-04-07`、`advanced-tool-use-2025-11-20`、`effort-2025-11-24` 和 `fallback-credit-2026-06-01`(`context-1m-2025-08-07` 被省略以避免订阅 token 上的 429 信用错误,#7238)。指纹元数据(`generateClaudeCloakingUserId`、`deriveClaudeDeviceId`、`generat…`...
- **System-Prompt Injection**:`buildAnthropicSystemBlocks`(`packages/ai/src/providers/anthropic.ts`)自动为 OAuth 凭据将 `claudeCodeSystemInstruction`("You are a Claude agent, built on Anthropic's Claude Agent SDK.")作为 `system[0]` 前置。通过 `mid-conversation-system-2026-04-07` 为 Opus 4.8+ / Sonnet 5+ 启用回合历史中的中间会话系统消息。
- **Thinking Signatures & Redacted Thinking**:重放修改或未签名的思考块会导致 Anthropic API 错误(`invalid signature in thinking block`)。`convertAnthropicMessages` 转换 `ThinkingContent` 和 `RedactedThinkingContent`(`type: "redacted_thinking"`、`data`)。`maybeAddReplayUnsignedThinkingHint` 在签名错误时附加恢复提示,而 `unwrapAnthropicThinkingEnvelope` 剥离遗留的 `<thinking>` XML 包装。
- **Tool Use Replay & Prefixes**:`encodeAnthropicToolName` / `decodeAnthropicToolName`(`packages/ai/src/providers/anthropic.ts`)在使用 OAuth 时为自定义工具名称添加 `_` 前缀(`claudeToolPrefix`),以防止与内置工具(`web_search`、`code_execution`、`text_editor`、`computer`)冲突。服务器执行的 web 搜索和工具搜索(`anthropic-wire.ts` 中的 `AnthropicServerToolHistoryBlockParam`)通过 `isAnthropicServerToolHistoryBlock` 检测以进行回合重放。空工具错误由 `ensureErrorToolResultWireContent` 填充。
- **Strict-Tool Schema Normalization & Fallback**:`normalizeAnthropicToolSchema` 和 `normalizeAnthropicStrictSchema` 为 `structured-outputs-2025-12-15` beta 剥离不受支持的 JSON schema 关键字(例如对象上的 `minItems`/`maxItems`)。如果严格工具 schema 导致 HTTP 400,`streamAnthropicOnce` 调用 `dropAnthropicStrictTools` 并在没有严格模式的情况下自动重试。
- **Adaptive vs Budget Thinking**:`ThinkingConfigParam`(`anthropic-wire.ts`)支持预算思考(`{ type: "enabled", budget_tokens: N }`,由 `ensureMaxTokensForThinking` 强制)和自适应思考(`{ type: "adaptive" }` 与 `output_config: { effort: level }` 通过 `effort-2025-11-24` beta 配对)。强制工具选择(`disableThinkingIfToolChoiceForced`)自动禁用思考。
- **Prompt Cache Breakpoints**:`applyPromptCaching`(`packages/ai/src/providers/anthropic.ts:3195`,在 `:3506` 调用)标记对话尾部的两消息滚动窗口:它将 `cache_control: { type: "ephemeral" }`(加上 `ttl: "1h"` 仅用于支持它的模型的长时间保留,由 `:497` 的 `getCacheControl` 构建)附加到两个尾随回合的每个的最后一个普通内容块,跳过 `thinking`、`redacted_thinking` 和 `fallback` 块(`:3179` 的 `applyCacheControlToLastBlock`)。当尾随用户消息是助手预填充之后附加的中性 `"Continue."` 填充时,窗口锚定在前面的真实助手上。缓存从不应用于系统提示或工具定义,并且没有 to...

### Stream behavior
- **Event Protocol**:`streamAnthropicOnce`(`packages/ai/src/providers/anthropic.ts`)中的 SSE stream 发出标准框架事件:`message_start`(传递初始输入和缓存使用情况)、`content_block_start`(初始化块类型:text、thinking、tool_use、redacted_thinking、fallback)、`content_block_delta`(流式传输 `text_delta`、`thinking_delta`、`signature_delta`、`input_json_delta`)、`message_delta`(传递 `stop_reason` 和最终 `output_tokens`)、`content_block_stop`、`message_stop` 和 `ping`。
- **Fine-Grained Tool Streaming**:通过 `fine-grained-tool-streaming-2025-05-14` beta 启用。传入的 `input_json_delta` chunk 在 `kStreamingPartialJson` 中累积,由 `parseStreamingJsonThrottled` 持续解析以显示流式工具参数。
- **Stream Watchdogs & Healing**:使用 `getStreamFirstEventTimeoutMs` 和 `getStreamIdleTimeoutMs` 在 `iterateWithIdleTimeout` 中监控 stream 的停顿超时。`ping` 事件(`ANTHROPIC_PING_EVENT`)重置空闲超时乘数。空补全响应(0 token)通过 `withEmptyCompletionRetry` 触发自动重试。快速模式(`speed: "fast"`)失败清除会话快速模式状态(`clearAnthropicFastModeFallback`、`dropAnthropicFastMode`)以回退到标准执行。

### Auth & usage
- **OAuth Authentication & PKCE**:`AnthropicOAuthFlow`(`packages/ai/src/registry/oauth/anthropic.ts`)使用解密的 Client ID(`OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl`)对 `https://claude.ai/oauth/authorize` 和 `https://api.anthropic.com/v1/oauth/token` 执行 PKCE `S256` 身份验证。OAuth token 具有 30 天的绝对授权 TTL(`anthropic-constants.ts` 中的 `ANTHROPIC_OAUTH_GRANT_TTL_MS`),无论刷新 token 轮换如何,都需要每月交互式重新登录。账户身份通过 `extractAccountFromTokenResponse` 或 `fetchBootstrapIdentity`(`/api/claude_cli/bootstrap`)解析。
- **Quota Tracking & Account Rotation**:`packages/ai/src/usage/claude.ts` 轮询 `https://api.anthropic.com/api/oauth/usage` 以跟踪滚动的 `five_hour`、`seven_day`、`limits[]`(`weekly_scoped`)和 `anthropic-ratelimit-unified-*` 头。匹配 `isUsageLimitOutcome`(`packages/ai/src/error/rate-limit.ts`)和 `parseRateLimitReason`(`QUOTA_EXHAUSTED`)的错误触发自动凭据轮换。
- **Error Classification**:HTTP 错误由 `parseRateLimitReason`(`packages/ai/src/error/rate-limit.ts`)分类为 `QUOTA_EXHAUSTED`(30m 退避/轮换)、`RATE_LIMIT_EXCEEDED`(30s 退避)、`CONCURRENT_LIMIT`(5s 退避)和 `MODEL_CAPACITY_EXHAUSTED`(45s ± 15s 退避)。瞬态 HTTP 408/409/429/5xx 错误由 `AnthropicMessagesClient`(`packages/ai/src/providers/anthropic-client.ts`)重试,遵守 `retry-after-ms` / `retry-after` 头。

### Catalog model handling
- **Model Identity & Classification**:`isClaudeModelId`(`packages/catalog/src/identity/family.ts`)使用正则 `/(^|[/.])claude[-.]/i` 来识别裸露、命名空间(`anthropic/claude-*`)和 Bedrock(`us.anthropic.claude-*`)Claude 模型。`parseAnthropicModel`(`packages/catalog/src/identity/classify.ts`)解析模型种类(Opus、Sonnet、Fable、Mythos)、版本和变体。功能检查包括 `anthropicModelSupportsThinking`(v>=3.7)、`supportsAdaptiveThinkingDisplay`(v>=4.7)、`supportsMidConversationSystemMessages`(v>=4.8) 和 `isAnthropicFableOrMythosModel`。
- **Provider Descriptor**:`CATALOG_PROVIDERS`(`packages/catalog/src/provider-models/descriptors.ts`)定义具有 `defaultModel: "claude-opus-4-8"`、`envVars: ["ANTHROPIC_API_KEY"]` 和模型管理器选项 `anthropicModelManagerOptions` 的 Anthropic provider 条目。
- **Thinking Configuration**:`resolveModelThinking`(`packages/catalog/src/model-thinking.ts`)派生思考能力。现代自适应模型(Opus 4.7+、Sonnet 5+)使用 `FIVE_TIER_EFFORTS_LOW_TO_MAX`(`[low, medium, high, xhigh, max]`),而较旧的自适应模型使用 `FOUR_TIER_EFFORTS_LOW_TO_MAX`。Effort 级别通过 `mapEffortToAnthropicAdaptiveEffort` 映射到 Anthropic wire 值。
- **Pricing & Multipliers**:`packages/catalog/scripts/generate-models.ts` 中的 `COPILOT_PREMIUM_MULTIPLIERS` 在模型 catalog 生成期间为 GitHub Copilot Anthropic 模型分配高级乘数(例如 `claude-opus-4.6`:3x,`claude-haiku-4.5`:0.33x)。

## Google Gemini
Google Gemini 集成使用基于 HTTP 的 REST/SSE(`POST https://generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent?alt=sse`)。核心 provider 入口点是 `packages/ai/src/providers/google.ts`(`streamGoogle`)、`packages/ai/src/providers/google-shared.ts`(`streamGoogleGenAI`、`buildGoogleGenerateContentParams`、`convertMessages`、`consumeGoogleStream`)和 `packages/ai/src/providers/google-types.ts`。

### Special casings
- **`generateContent` protocol**:系统提示在 `buildGoogleGenerateContentParams` 中提升到 `{ systemInstruction: { parts: [{ text }] } }`。工具使用 `parametersJsonSchema`(通过 `packages/ai/src/utils/schema/normalize.ts` 中的 `normalizeSchemaForGoogle` 清理)格式化为 `tools[].functionDeclarations`。
- **`thinkingConfig` mapping**:`buildGoogleGenerateContentParams` 设置 `includeThoughts: !options.hideThinkingSummary`。Gemini 3 模型将 `options.thinking.level` 映射到 `thinkingLevel`(`THINKING_LEVEL_UNSPECIFIED`、`MINIMAL`、`LOW`、`MEDIUM`、`HIGH`)。Gemini 2.x 模型将 `options.thinking.budgetTokens` 映射到 `thinkingBudget`。Cloud Code Assist provider(`google-gemini-cli.ts`)在禁用时将 `thinking.suppress` 映射到显式 `includeThoughts: false` 以及 level/budget(`suppressWhenOff`)。
- **Function call ID synthesis & Vertex AI strip**:`google-shared.ts` 中的 `nextToolCallId` 在 ID 缺失或重复时生成唯一 ID(`${name}_${Date.now()}_${++toolCallCounter}`)。`supportsFunctionPartId` 为 `claude-` 模型或 Gemini 3 模型(`isGemini3Model`)启用 `functionCall.id` / `functionResponse.id` 传播。`google-vertex` API 拒绝 function 部分中的 `id` 字段,因此 `google-shared.ts` 为 Vertex 请求剥离 `part.functionCall.id` 和 `part.functionResponse.id`。
- **Contiguous `functionResponse` rule**:Gemini 要求并行工具调用结果驻留在单个连续的 `user` 角色消息中。`google-shared.ts` 中的 `convertMessages` 检查 `lastContent` 并将 `functionResponse` 部分合并到现有的 `user` 回合(`lastContent.parts.push(functionResponsePart)`)。
- **Multimodal function responses by version**:Gemini 3+ 模型(`supportsMultimodalFunctionResponse` 通过 `getGeminiMajorVersion >= 3` 检查)支持直接嵌套在 `functionResponse.parts` 内的内联工具输出图像。Gemini < 3 模型将工具图像缓冲到 `pendingToolImageParts` 中,并在后续的单独 `user` 文本/图像回合中刷新它们。
- **Safety settings & Prompt feedback**:`PromptFeedback`(`blockReason`、`blockReasonMessage`)中的安全块抛出 `AIError.ProviderResponseError` 与 `kind: "content-blocked"`。`FinishReason` 值(`SAFETY`、`BLOCKLIST`、`PROHIBITED_CONTENT`、`SPII`、`IMAGE_SAFETY`、`RECITATION`、`MALFORMED_FUNCTION_CALL`、`UNEXPECTED_TOOL_CALL`、`NO_IMAGE`、`OTHER`)在 `mapStopReason` 中映射到 `stopReason: "error"`。

### Stream behavior
- **`streamGenerateContent` SSE protocol**:Stream 通过 `streamGoogleGenAI` 中的 `readSseJson<GenerateContentResponse>` 消费。
- **Thought parts & signature retention**:`isThinkingPart` 在 `part.thought === true` 时识别推理文本。加密的 `part.thoughtSignature` 字段使用 `retainThoughtSignature` 跨 delta 保留。在 `convertMessages` 中,仅当消息 provider/模型与目标匹配(`msg.provider === model.provider && msg.model === model.id`)并通过 `isValidThoughtSignature`(base64 检查)时,才保留思考签名。缺乏签名的 Gemini 3 工具调用回退到 `SKIP_THOUGHT_SIGNATURE`(`"skip_thought_signature_validator"`)。
- **Empty response retry loop**:`streamGoogleGenAI` 防止 Gemini 返回 `finishReason: STOP` 与空白内容而不调用工具。`hasMeaningfulGoogleContent` 验证输出;如果为空,`streamGoogleGenAI` 在通过 `resetGoogleStreamOutputForRetry` 重置 stream 输出后,以指数退避(`EMPTY_STREAM_BASE_DELAY_MS * 2^attempt`)重试最多 `MAX_EMPTY_STREAM_RETRIES`(2 次重试,共 3 次尝试)。
- **Thinking loop guard**:在 `packages/ai/src/utils/thinking-loop.ts`(`ThinkingLoopDetector`)中实现。Gemini、DeepSeek 和 Grok 模型 ID 系列在工具调用之前针对三种失控形状进行监控:
  1. *逐字尾部重复*(`EXACT_TAIL_WINDOW` = 4096,>= 180 个重复字符)。
  2. *近似重复段*(跨最后 16 段的 trigram Jaccard 相似度 >= 0.8)。
  3. *Progress-lexicon stall*(在 8 个连续段中,新颖度 <= 0.2 且没有新的具体引用锚点)。
  4. Gemini 的 `GEMINI_HEADER_RUNAWAY_THRESHOLD = 24` 停止发出过多有标题的推理摘要而不采取行动的 stream。触发器发出合成的可重试 `error`,标记为 `AIError.Flag.ThinkingLoop`。
- **Finish reason mapping & incomplete streams**:`candidate.finishReason` 通过 `mapStopReason` 映射;如果输出包含工具调用,则 `stop`/`length` 原因升级为 `toolUse`。没有 `finishReason` 的丢弃抛出 `ProviderResponseError` 与 `kind: "incomplete-stream"`。
- **UsageMetadata accounting**:附加到 `consumeGoogleStream` 中的尾随 chunk。`input` 计算为 `promptTokenCount - (cachedContentTokenCount || 0)`;`output` 为 `candidatesTokenCount + (thoughtsTokenCount || 0)`;`cacheRead` 为 `cachedContentTokenCount || 0`;`reasoningTokens` 为 `thoughtsTokenCount`。Token 成本通过 `calculateCost(model, output.usage)` 计算。

### Auth & usage
- **Credential source**:直接通过 `x-goog-api-key: apiKey` 头(或通过 `packages/ai/src/providers/google.ts` 中的 `getEnvApiKey(model.provider)` 检索的 `GEMINI_API_KEY` 环境变量)进行身份验证。
- **Usage tracker**:`packages/ai/src/usage/gemini.ts` 中的 `googleGeminiCliUsageProvider` 通过调用 `POST /v1internal:loadCodeAssist`(用于项目解析)和 `POST /v1internal:retrieveUserQuota` 来监控 OAuth 支持的 Cloud Code Assist 使用情况。配额桶映射到等级(`Flash`、`Pro`、`3-Flash`),具有剩余分数使用百分比和重置窗口(`parseWindow`)。

### Catalog model handling
- **Identity & classification**:`packages/catalog/src/identity/classify.ts` 中的 `parseGeminiModel` 解析匹配 `gemini-{version}-{kind}`(带有可选的 `-preview` 后缀)的模型 ID,返回 `GeminiModel`(`family: "gemini"`、`kind: "pro" | "flash"`、`version: SemVer`)。
- **Thinking metadata & levels**:`packages/catalog/src/model-thinking.ts` 使用 `ThinkingLevel` 枚举字符串(`THINKING_LEVEL_UNSPECIFIED`、`MINIMAL`、`LOW`、`MEDIUM`、`HIGH`)配置思考选项。为 Gemini 3 模型定义 effort 等级:`GEMINI_3_PRO_EFFORTS`(`[low, high]`)和 `GEMINI_3_FLASH_EFFORTS`(`[minimal, low, medium, high]`)。
- **Descriptors & discovery**:在 `packages/catalog/src/provider-models/descriptors.ts`(`CATALOG_PROVIDERS` 条目用于 `google`,默认模型 `gemini-3.1-pro-preview`,`GEMINI_API_KEY`)中配置。`packages/catalog/src/discovery/gemini.ts`(`fetchGeminiModels`)中的动态发现获取 `GET /v1beta/models?key=...`,过滤 `generateContent` 方法并解析 `inputTokenLimit` 和 `outputTokenLimit`。
- **Pricing & Antigravity backfill**:基础价格通过 `calculateCost` 计算。在 `scripts/generated-policies.ts` 和 `scripts/generate-models.ts` 中,`google-antigravity` 模型报告上游 0 美元列表价格,并使用 `ANTIGRAVITY_PRICING_PEERS`(`["google"、"google-vertex"、"anthropic"]`)回填,通过 `ANTIGRAVITY_PRICING_ID_ALIASES`(例如 `gemini-3-flash` -> `gemini-3-flash-preview`)解析 Gemini 别名。

## Google Vertex AI

Google Vertex AI provider 为托管在 Google Cloud Vertex AI 上的 Gemini 模型以及通过 Vertex 端点提供的第三方模型(例如 Anthropic Claude)启用流式生成。入口点包括 `packages/ai/src/providers/google-vertex.ts` 中的 `streamGoogleVertex`(API 类型 `"google-vertex"`)用于 Gemini 模型,`packages/ai/src/stream.ts` 中的 `streamAnthropic` 通过 `createVertexAuthenticatedFetch` 用于 Claude 模型(API 类型 `"anthropic-messages"`),以及 `packages/ai/src/providers/google-auth.ts` 中的 ADC 身份验证。传输使用 HTTPS REST / SSE,具有 Application Default Credentials (ADC OAuth Bearer token)或 Vertex Express Mode API key(`x-goog-api-key`)。

### Special casings
* **Endpoint & Project/Location Resolution**:在 ADC 模式(`packages/ai/src/providers/google-vertex.ts`)中,请求 URL 遵循 `https://${host}/v1/projects/${project}/locations/${location}/publishers/google/models/${model.id}:streamGenerateContent?alt=sse`。`project` 从 `options.project`、`$env.GOOGLE_CLOUD_PROJECT`、`$env.GCP_PROJECT` 或 `$env.GCLOUD_PROJECT` 解析(如果缺失则抛出 `ConfigurationError`)。`location` 从 `options.location`、`$env.GOOGLE_VERTEX_LOCATION`、`$env.GOOGLE_CLOUD_LOCATION` 或 `$env.VERTEX_LOCATION` 解析(如果缺失则抛出 `ConfigurationError`)。在 Express 模式(通过 `options.apiKey` 或 `$env.GOOGLE_CLOUD_API_KEY` 的 API Key 模式)中,URL 遵循 `https://${host}/v1/publishers/google/models/${model.id}:streamGenerateConte…`。
* **Endpoint Host Resolution**:`packages/catalog/src/hosts.ts` 中的 `resolveVertexEndpointHost(location)` 将位置映射到主机名:`"global"` → `aiplatform.googleapis.com`;多区域 `"eu"` / `"us"` → `aiplatform.{location}.rep.googleapis.com`(防止来自标准插值的 404);区域(例如 `"us-central1"`、`"europe-west4"`)→ `${location}-aiplatform.googleapis.com`。
* **Function Call & Response ID Stripping**:`packages/ai/src/providers/google-shared.ts` 中的 `supportsFunctionPartId(model)` 为 `google-vertex` 返回 `false`。`convertMessages` 在 wire 序列化之前显式删除 `part.functionCall.id` 和 `functionResponsePart.functionResponse.id`,因为当 function 部分包含 `id` 字段时,Vertex AI 返回 `400 INVALID_ARGUMENT`。
* **Safety Settings Defaults**:`packages/ai/src/providers/google-vertex.ts` 中的 `streamGoogleVertex` 在未配置时自动将禁用所有危害类别的安全设置(`HARM_CATEGORY_HATE_SPEECH`、`HARM_CATEGORY_DANGEROUS_CONTENT`、`HARM_CATEGORY_SEXUALLY_EXPLICIT`、`HARM_CATEGORY_HARASSMENT` 设置为 `threshold: "OFF"`)注入到 `params.config.safetySettings`。
* **Service Tier Priority Header**:直接 `serviceTier` 请求体字段被 Vertex 忽略;`options.serviceTier === "priority"` 作为请求头 `X-Vertex-AI-LLM-Shared-Request-Type: priority`(`google-vertex.ts`)传输。`flex` 没有记录在案的控制,是无操作。
* **Cached Content Passthrough**:将调用方提供的 `cachedContent` 资源名称不透明地传递到 `params.config.cachedContent`(`google-shared.ts`),绕过创建/刷新生命周期。

### Stream behavior
* **Gemini Streaming Execution**:委托给 `packages/ai/src/providers/google-shared.ts` 中的 `streamGoogleGenAI` 和 `consumeGoogleStream`,具有 `retainTextSignature: true`。处理 SSE chunk 解析、文本/思考块聚合(`thoughtSignature`)、工具调用 ID 合成(在 Vertex 省略它们时生成 ID)和完成原因。
* **Anthropic-on-Vertex RawPredict Handling**:`packages/ai/src/stream.ts` 中的 `isGoogleVertexAuthenticatedModel` 匹配 `model.provider === "google-vertex"` 与 `anthropic-messages` API 和 `:streamRawPredict` baseUrl。请求使用 `apiKey: "vertex-adc"` 和 `createVertexAuthenticatedFetch` 通过 `streamAnthropic` 路由。
* **Anthropic Request Rewriting**:`packages/ai/src/stream.ts` 中的 `createVertexAuthenticatedFetch` 调用 `resolveVertexRequest` 以替换 URL 中的 `{project}` 和 `{location}` 占位符,将 `:streamRawPredict/v1/messages` 路径归一化为 `:streamRawPredict`,并应用 `transformVertexAnthropicBody` 来剥离 `payload.model`(在 URL 路径中编码)并将 `payload.anthropic_version = "vertex-2023-10-16"` 注入 JSON body。
* **Anthropic Effort Beta Gating**:Vertex `rawPredict` 拒绝 `anthropic-beta` HTTP 头,返回 400 错误。在 `packages/ai/src/providers/anthropic.ts` 中,`effortBeta`(`effort-2025-11-24`)、`contextManagementBeta` 和 `output_config.effort` 字段在 `model.provider === "google-vertex"` 时被禁用。`anthropic.ts` 中的回退负载也会在 Vertex 请求上清理 `output_config.effort`(#5614)。

### Auth & usage
* **ADC Resolution Ladder**:`packages/ai/src/providers/google-auth.ts` 按优先级顺序解析凭据:
  1. `GOOGLE_APPLICATION_CREDENTIALS` 环境变量,指向 JSON 凭据文件。支持 `type: "service_account"`(通过 WebCrypto `crypto.subtle` 签名的 RS256 JWT 断言,在 `https://oauth2.googleapis.com/token` 交换)、`type: "authorized_user"`(刷新 token 交换)或 `type: "impersonated_service_account"`(交换源凭据然后调用 GCP IAM `generateAccessToken`)。
  2. 用户 ADC 文件 `~/.config/gcloud/application_default_credentials.json`(`authorized_user` 流)。
  3. GCE / Cloud Run 元数据服务器(`http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token`)。
* **Explicit Access Token Override**:`GOOGLE_CLOUD_ACCESS_TOKEN` 或 `CLOUDSDK_AUTH_ACCESS_TOKEN` 环境变量完全绕过文件/元数据查找和缓存。

* **Token Caching & In-flight Deduplication**:访问 token 存储在 `tokenCache`(Map)中,以解析的源为键,并在过期前(`GOOGLE_VERTEX_REFRESH_SKEW_MS`,默认 60s)刷新。并发解析请求在 `inflight` Map 中共享单个 in-flight promise,受 `SHARED_TOKEN_RESOLVE_TIMEOUT_MS`(30s)限制。各个调用方通过 `raceWithSignal` 让它们的 abort signal 与共享 promise 竞争,因此一个调用方的中止不会取消批处理解析。请求的 OAuth 范围:`https://www.googleapis.com/auth/cloud-platform`。
* **Usage & Token Normalization**:`packages/ai/src/providers/google-shared.ts` 中的 `consumeGoogleStream` 从响应中提取 `usageMetadata`:`input` 计算为 `promptTokenCount - cachedContentTokenCount`,`output` 为 `candidatesTokenCount + thoughtsTokenCount`,`cacheRead` 为 `cachedContentTokenCount`,`reasoningTokens` 为 `thoughtsTokenCount`。将归一化的使用情况传递给 `calculateCost(model, output.usage)`。

### Catalog model handling
* **Catalog API Resolution**:`packages/catalog/src/provider-models/openai-compat.ts` 中的 `resolveGoogleVertexApi` 将 `@ai-sdk/google-vertex/anthropic` npm 包模型路由到 `api: "anthropic-messages"`,使用 `GOOGLE_VERTEX_ANTHROPIC_BASE_URL`(`https://{location}-aiplatform.googleapis.com/v1/projects/{project}/locations/{location}/publishers/anthropic/models/{model}:streamRawPredict`)。带斜杠 ID 或 `@ai-sdk/openai-compatible` 的模型路由到 `api: "openai-completions"`。所有其他模型路由到 `api: "google-vertex"`,使用 `GOOGLE_VERTEX_BASE_URL`(`https://{location}-aiplatform.googleapis.com`)。
* **Provider Descriptor**:`packages/catalog/src/provider-models/descriptors.ts` 注册 `id: "google-vertex"`,`defaultModel: "gemini-3.1-pro-preview"`。
* **Registry Credentials Guard**:`packages/ai/src/registry/google-vertex.ts` 中的 `googleVertexProvider` 导出 `envKeys()`。如果设置了 `$env.GOOGLE_CLOUD_API_KEY`,则返回该值;或者如果存在 ADC 凭据(`hasVertexAdcCredentials()`)且项目环境(`GOOGLE_CLOUD_PROJECT`/`GCP_PROJECT`/`GCLOUD_PROJECT`)和位置环境(`GOOGLE_VERTEX_LOCATION`/`GOOGLE_CLOUD_LOCATION`/`VERTEX_LOCATION`)都存在,则返回 `AUTHENTICATED_SENTINEL`(`"<authenticated>"`)。否则返回 `undefined`,防止模型在没有适当身份验证的情况下出现在 catalog 列表中。

## Google Gemini CLI / Antigravity
Google Cloud Code Assist (CCA) 传输包装器,通过 `/v1internal:streamGenerateContent` SSE 端点访问 Gemini 和 Claude 模型。实现横跨 `packages/ai/src/providers/google-gemini-cli.ts`(共享执行引擎、请求构造、stream 解析和规划泄漏过滤器)、`packages/ai/src/registry/google-gemini-cli.ts` 和 `packages/ai/src/registry/google-antigravity.ts`(provider 定义和 OAuth 惰性加载器)、`packages/ai/src/registry/oauth/google-gemini-cli.ts` 和 `google-antigravity.ts`(OAuth 登录流、项目发现和入门)、`packages/ai/src/usage/google-antigravity.ts` 和 `packages/ai/src/usage/gemini.ts`(配额跟踪和凭据排名),以及 `packages/catalog/src/discovery/antigravity.ts`(模型…)。

### Special casings
- **CCA JSON Schema Normalization**:`normalizeSchemaForCCA`(`packages/ai/src/utils/schema/normalize.ts`)递归剥离不受支持的 JSON Schema 关键字(`propertyNames`、`additionalProperties`、`patternProperties`、`$schema`、`title`、`description` 等),以防止来自 CCA 的 HTTP 400 错误。准确跟踪名为 `properties` 的属性内的上下文,以避免过早重新断言属性剥离。工具在 `buildRequest`(`packages/ai/src/providers/google-gemini-cli.ts`)中通过 `normalizeSchemaForCCA` 进行归一化。
- **Function Calling Config Mode**:在 `buildRequest` 中默认为 `functionCallingConfig: { mode: "VALIDATED" }`,适用于 Antigravity。Antigravity 上的 Claude 模型强制 `VALIDATED` 模式,即使上下文中没有声明工具(`isClaudeModel`)。单个命名工具选择(`options.toolChoice`)设置 `mode: "ANY"` 与 `allowedFunctionNames: [...]`。
- **Provider Protocol & Request Envelope**:
  - **Endpoints**:`google-gemini-cli` 默认为 `https://cloudcode-pa.googleapis.com`。`google-antigravity` 在 `https://daily-cloudcode-pa.googleapis.com`(主要)和 `https://daily-cloudcode-pa.sandbox.googleapis.com`(沙箱)之间自动故障转移,在 `AntigravityProviderSessionState` 中持久化 `lastGoodEndpoint`。
  - **Headers & User-Agent**:`google-gemini-cli` 发送 `getGeminiCliHeaders()`(`GeminiCLI/0.46.0/<modelId> (platform; arch; terminal)`)。`google-antigravity` 发送 `getAntigravityUserAgent()`(`antigravity/hub/<version> (aidev_client; os_type=<os>; arch=<arch>; cl=<cl>)`);后端在较新模型(例如 gemini-3.7-flash)上对客户端版本进行门控。Antigravity 上的推理 Claude 模型发送 `anthropic-beta: interleaved-thinking-2025-05-14`(`needsClaudeThinkingBetaHeader`)。
  - **System Instructions**:Antigravity 用 `role: "user"` 标记系统指令。不注入身份提示 — 后端在所有路由上接受任意系统指令(针对 gemini-3.x 和 Claude wire id 验证)。
  - **Request Envelope & Session State**:Antigravity 在 `buildAntigravityRequestEnvelope` 中包装请求:`project`(projectId)、`requestId`(`agent/<agentId>/<ts>/<trajectoryId>/<step>`)、`userAgent`(`antigravity`)、`requestType`(`agent`)和 `labels`(`last_step_index`、`model_enum`、`trajectory_id`、`used_claude`、`used_claude_conservative`、`last_execution_id`)。状态维护单调 `stepIndex`、持久 `agentId`、`trajectoryId` 和签名十进制 `sessionId`(`deriveAntigravitySessionId`)。
  - **Wire Profiles**:`getAntigravityModelWireProfile`(`packages/catalog/src/wire/gemini-headers.ts`)将 wire ID 映射到 `maxOutputTokens` 和 `model_enum`。Claude wire ID 将 `maxOutputTokens` 限制为 `64000`(后端以 400 拒绝 >64000)。
- **Thinking Configuration & Wire Suppression**:Gemini 2.x 模型发送 `thinkingConfig.thinkingBudget`,而 Gemini 3 模型发送 `thinkingConfig.thinkingLevel`。当对具有 `thinking.suppressWhenOff` 的模型禁用推理时,`buildRequest` 发出显式 wire 抑制(具有 level/budget 的 `includeThoughts: false`)。省略 `thinkingConfig` 会导致 CCA 重新应用服务器默认值并静默计费思考 token。

### Stream behavior
- **Transport & SSE Protocol**:通过 `readSseJson<CloudCodeAssistResponseChunk>` 消费 `POST /v1internal:streamGenerateContent?alt=sse`。Chunk 传递 `candidates[0].content.parts`、`usageMetadata`、`modelVersion`、`responseId`、`promptFeedback` 或顶层 `error`。
- **In-band Errors & Block Reasons**:`chunk.error` 状态/代码 >=400 抛出 `AIError.GeminiCliApiError` 或 `AIError.ProviderResponseError`。`promptFeedback.blockReason` 抛出 `AIError.ProviderResponseError` 与 `kind: "content-blocked"`。
- **Planning Leak Detection & Filtering**:Flash 模型(`isFlashLeakModel`)可以将原始 JSON 内部规划块流式传输到可见文本部分。`consumePlanningBuffer` 使用 `isPlanningLeakPrefix` 和 `splitLeadingJsonObject` 检查以 `{` 或 `"thought":` 开头的前缀。如果解析的 JSON 包含 `thought`、`call`(匹配活动工具名称)、`_i`、`paths`、`command` 或 `path`/`content`,则该对象被分类为 `kind: "leak"` 并从可见输出中剥离。
- **Thinking Parts & Signature Retention**:具有 `thought: true` 或 `isThinkingPart()` 的部分路由到思考块。文本、思考或 toolCall 部分上的 `thoughtSignature` 通过 `retainThoughtSignature` 保留。内联 `<thinking>` 标签使用 `StreamMarkupHealing` 处理。
- **Empty Stream Retry**:Google 模型可以返回 `finishReason: "STOP"` 与空文本部分且没有工具调用。`hasMeaningfulGoogleContent` 检查非空文本、思考或工具调用。具有 `stopReason === "stop"` 的空响应在失败之前以指数退避(`EMPTY_STREAM_BASE_DELAY_MS = 1000ms`)触发最多 `MAX_EMPTY_STREAM_RETRIES`(3 次重试)(`packages/ai/src/providers/google-gemini-cli.ts`)。
- **Pre-Response Watchdogs**:使用 `getStreamFirstEventTimeoutMs`(5 分钟上限)武装 `armPreResponseTimeout`,以防止在第一个 SSE chunk 到达之前挂起的 HTTP 代理连接。原生 Bun fetch 预响应超时被禁用(`timeout: false`)。

### Auth & usage
- **Credential Model & Token Expiry**:凭据存储为 JSON(`parseGeminiCliCredentials`):`{ token, projectId, refreshToken, expiresAt, email }`。AuthStorage 是唯一的刷新授权机构。`shouldRefreshGeminiCliCredentials` 使用 60s 偏斜(`ANTIGRAVITY_REFRESH_SKEW_MS` / `GOOGLE_GEMINI_REFRESH_SKEW_MS`)检查 token 过期。陈旧 token 在发出 HTTP 请求之前快速失败。
- **OAuth Installed-App Flow**:回调端口为 `8085`(`google-gemini-cli`,`/oauth2callback`)和 `51121`(`google-antigravity`,`/oauth-callback`)。支持粘贴代码流(`pasteCodeFlow: true`)。通过 Google PKCE OAuth 2.0(`accounts.google.com/o/oauth2/v2/auth`)进行授权。Antigravity 范围包括 `cloud-platform`、`userinfo.email`、`userinfo.profile`、`cclog` 和 `experimentsandconfigs`。
- **Project Discovery & Onboarding**:
  - `google-gemini-cli`(`packages/ai/src/registry/oauth/google-gemini-cli.ts`):使用 `$GOOGLE_CLOUD_PROJECT` 回退调用 `POST /v1internal:loadCodeAssist`。如果项目不存在,则使用 `tierId`(`free-tier`、`legacy-tier`、`standard-tier`)调用 `POST /v1internal:onboardUser`,并通过 `pollOperation` 轮询 `LongRunningOperationResponse`(最多 `POLL_MAX_ATTEMPTS = 24` 次,间隔 5s)。检测 VPC-SC 限制(`SECURITY_POLICY_VIOLATED`)。
  - `google-antigravity`(`packages/ai/src/registry/oauth/google-antigravity.ts`):针对 `https://daily-cloudcode-pa.googleapis.com` 镜像原生 `antigravity/hub` 流:`loadCodeAssist` 请求携带 `{ metadata: { ideType: "ANTIGRAVITY" } }`,当响应缺少 `paidTier` 时使用 `cloudaicompanionProject` 重复,并在解析账户状态后刷新。没有 `currentTier` 的账户使用 `onboardUser` 和 `tierId: "free-tier"` 配置一次;其长时间运行的操作在 30 秒截止时间内每秒通过 `GET /v1internal/{operation.name}` 轮询。
- **Usage & Quota Tracking (`google-antigravity`)**:`antigravityUsageProvider`(`packages/ai/src/usage/google-antigravity.ts`)查询 `POST /v1internal:fetchAvailableModels`。将配额桶归一化为每日(24h)和每周(7d)窗口。将配额去重为后端计数器键(`Anthropic`、`Google`、`OpenAI`)。`antigravityRankingStrategy` 按请求的模型族(`getAntigravityCounterKeyForModel`:`claude-` → Anthropic,`gemini-`/`gemma-` → Google,`gpt-`/`openai/` → OpenAI)限定排名范围,选择具有可用配额余量的存储的 OAuth 凭据。
- **Usage & Quota Tracking (`google-gemini-cli`)**:`googleGeminiCliUsageProvider`(`packages/ai/src/usage/gemini.ts`)查询 `loadCodeAssist` 和 `retrieveUserQuota`,按模型等级(`3-Flash`、`Flash`、`Pro`)显示配额百分比。

### Catalog model handling
- **Provider Descriptors**:`google-antigravity`(默认模型 `gemini-3.1-pro`)和 `google-gemini-cli`(默认模型 `gemini-3.1-pro-preview`)在 `CATALOG_PROVIDERS` 中定义,具有 `specialModelManager: true`(`packages/catalog/src/provider-models/descriptors.ts`),绕过标准工厂。
- **Model Resolution & Discovery**:`googleAntigravityModelManagerOptions` 和 `googleGeminiCliModelManagerOptions`(`packages/catalog/src/provider-models/google.ts`)调用 `fetchAntigravityDiscoveryModels`(`packages/catalog/src/discovery/antigravity.ts`)。
- **Identity & Thinking Metadata**:解析为 `family: "gemini"`,种类为 `pro` / `flash`(`packages/catalog/src/identity/classify.ts`)。Gemini 3.0+ 模型强制强制推理(`model-thinking.ts` 中的 `impliesMandatoryReasoning`)。Effort:`GEMINI_3_PRO_EFFORTS`(`[Low, High]`)和 `GEMINI_3_FLASH_EFFORTS`(`[Minimal, Low, Medium, High]`)。
- **Variant Collapsing**:在发现时将 Effort 等级变体折叠为逻辑规范(`packages/catalog/src/variant-collapse.ts`):
  - `gemini-3.5-flash`:将 `gemini-3.5-flash-extra-low`、`gemini-3.5-flash-low`、`gemini-3-flash-agent` 折叠。Antigravity 预算模式映射 Minimal/Low → `extra-low`(1000 tokens),Medium → `low`(4000 tokens),High → `agent`(10000 tokens)。Gemini CLI 映射到 level 传输。别名:`gemini-3-flash`。
  - `gemini-3.6-flash`:将 `gemini-3.6-flash-low`、`-medium`、`-high`、`-tiered` 折叠为 `gemini-3.6-flash`,具有 `google-level` 模式。
  - `gemini-3.1-pro`:将 `gemini-3.1-pro-low`、`gemini-pro-agent`、`gemini-3.1-pro-high` 折叠。由于上游 `gemini-3.1-pro-high` 部署在 streamGenerateContent 上返回 INVALID_ARGUMENT,因此 High effort 路由到 `gemini-pro-agent`。
  - `claude-*`:裸和 `-thinking` 对使用 `thinkingPair`(`preserveAbsentEffortRoutes: true`)折叠为 `claude-*`。
- **Catalog Generator Integration**:`fetchAntigravityModels`(`packages/catalog/scripts/generate-models.ts`)通过发现 token 获取模型(从 `google-antigravity` 回退到 `google-gemini-cli` OAuth 凭据),并将 `baseUrl` 修复为 `https://daily-cloudcode-pa.googleapis.com`。

## Amazon Bedrock
Amazon Bedrock(`amazon-bedrock` provider,`bedrock-converse-stream` API)通过 HTTPS POST 请求直接与 `bedrock-runtime.{region}.amazonaws.com/model/{modelId}/converse-stream` 通信,使用 AWS SigV4 签名或显式 bearer token,解码二进制 `application/vnd.amazon.eventstream` 响应。该实现绕过沉重的 AWS SDK 依赖(`@aws-sdk/*`、`@smithy/*`),执行使用 WebCrypto 签名的原生 fetch,并通过轻量级 eventstream 解析器解码。入口模块包括 `packages/ai/src/providers/amazon-bedrock.ts`(`streamBedrock`)、`packages/ai/src/registry/amazon-bedrock.ts`(`amazonBedrockProvider`)、`packages/ai/src/registry/aws.ts`、`packages/ai/src/providers/aws-credentials.ts`(`resolveAwsCredentials`)、…

### Special casings
- **Converse API Payload & Message Mapping**:请求构建具有 `messages`、`system`、`inferenceConfig`(`maxTokens`、`temperature`、`topP`)、`toolConfig` 和 `additionalModelRequestFields` 的 `ConverseStreamRequest`。系统提示归一化为具有文本块和 `CachePoint` 标记(`{ cachePoint: { type: "default", ttl?: "1h" } }`)的 `SystemContent[]`。用户内容映射到 `text`、`image`(通过 `createImageBlock` 的 `jpeg`/`png`/`gif`/`webp` base64)、`toolResult` 或 `cachePoint`。Bedrock 要求将连续的工具结果块合并到单个 `user` 角色 `WireMessage`(`convertMessages` 循环合并相邻的 `toolResult` 回合)。空文本块和空内容数组被过滤以避免 HTTP 400 验证失败。
- **NO_TOOLS_SENTINEL (`__no_tools__`)**:Bedrock 验证任何包含先前 `toolUse` 或 `toolResult` 块的请求必须提供 `toolConfig`。当工具被禁用(`toolChoice: "none"`)或在具有工具历史的回合上为空时,`planToolConfig` 注入占位符工具 `NO_TOOLS_SENTINEL`(`name: "__no_tools__"`,虚拟 schema)。每个请求标志 `sentinelInjected` 跟踪注入(因此命名为 `__no_tools__` 的调用方工具正常工作)。当 `sentinelInjected` 为 true 时,`handleContentBlockStart` 忽略合成工具使用开始事件,而 `messageStop` 将 `stopReason: "tool_use"` 降级为 `"stop"`。
- **Thinking & Reasoning (`additionalModelRequestFields`)**:
  - `anthropic-adaptive` 模型(Claude Opus 4.7+、Sonnet/Opus 5、Fable/Mythos 5):通过 `mapEffortToAnthropicAdaptiveEffort` 映射到 `{ thinking: { type: "adaptive", display? }, output_config: { effort } }`。`thinkingDisplay` 在支持显示的模型上默认为 `"summarized"`,以避免在 Anthropic 的 `"omitted"` 默认下静默推理流(issue #1373)。
  - 预算模式模型(例如 Claude 3.7 / 4.6):映射到 `{ thinking: { type: "enabled", budget_tokens, display }, anthropic_beta? }`。当 `interleavedThinking` 为 true 时,设置 `anthropic_beta: ["interleaved-thinking-2025-05-14"]`。
  - 强制工具选择冲突:Bedrock 在 `toolChoice` 强制工具执行时(`any` 或命名 `{ tool: { name } }`)拒绝思考。`streamBedrock` 在强制工具选择处于活动状态时清除 `additionalModelRequestFields`。
  - 思考签名与降级:在没有 `thinkingSignature` 的 Claude 模型(`supportsThinkingSignature`)上的助手思考块通过 `renderDemotedThinking` 降级为文本。非 Claude 模型(Nova、Titan、Llama、Mistral)拒绝思考签名并接收未签名的 `reasoningContent`。
- **Region & Inference-Profile Resolution**:`resolveBedrockRegion` 按以下顺序解析运行时区域:显式 `options.region` -> ARN 嵌入区域(`inferRegionFromBedrockArn`)-> 环境/配置文件区域(`resolveAwsAmbientRegion`)。对于地理前缀的跨区域推理配置文件(`us.`、`us-gov.`、`eu.`、`apac.`、`au.`、`jp.`),`regionServesGeo` 验证环境区域兼容性;不匹配或缺少环境区域回退到地理默认端点(`INFERENCE_PROFILE_GEO_DEFAULT_REGION`:`us` -> `us-east-1`,`us-gov` -> `us-gov-west-1`,`eu` -> `eu-west-1`,`apac` -> `ap-southeast-1`,`au` -> `ap-southeast-2`,`jp` -> `ap-northeast-1`)。`global.` 配置文件使用环境区域或 `us-east-1`。

### Stream behavior
- **AWS Eventstream Binary Decoding**:帧格式为 big-endian 整数(`[total len u32][headers len u32][prelude CRC u32][headers][payload][message CRC u32]`)。`packages/ai/src/providers/aws-eventstream.ts` 中的 `decodeMessage` 检查总长度(最小 16 字节),通过 `Bun.hash.crc32(bytes) >>> 0`(`crc32`)计算 IEEE 802.3 CRC32,并验证前奏(前 8 个字节)和消息 CRC(整个帧减去 4 字节)。头解析器(`parseHeaders`)读取类型化头(bool、byte、short、int、long、byte-array、string、timestamp、uuid)。`decodeEventStream` 从 `ReadableStream<Uint8Array>` 生成消息,使用可增长的 Uint8Array 缓冲区,并在中止时取消读取器锁。
- **Event Dispatch & Error Handling**:携带 `:message-type = "event"` 的 stream 消息分派:
  - `messageStart`:验证 `role === "assistant"` 并推送 stream `start`。
  - `contentBlockStart`:推送 `toolcall_start`(跳过 sentinel)。
  - `contentBlockDelta`:推送 `text_delta`(如果不存在则创建文本块)、`toolcall_delta`(在 `kStreamingPartialJson` 中累积 JSON 输入 delta,通过 `parseStreamingJsonThrottled` 节流)或 `thinking_delta`(累积推理文本和签名)。
  - `contentBlockStop`:通过 `parseStreamingJson` 解析工具 JSON 并推送 `text_end`/`thinking_end`/`toolcall_end`。
  - `messageStop`:映射 `stopReason`(`end_turn`/`stop_sequence` -> `stop`,`max_tokens`/`model_context_window_exceeded` -> `length`,`tool_use` -> `toolUse`)。
  - `metadata`:提取使用情况(`inputTokens`、`outputTokens`、`cacheReadInputTokens`、`cacheWriteInputTokens`)并调用 `calculateCost`。
  - `:message-type = "exception"` 提取 `:exception-type` 和错误负载以抛出 `BedrockApiError`(400)。`:message-type = "error"` 提取 `:error-code` 和 `:error-message`。
- **Idle Watchdogs & Pre-Response Timeout**:禁用 Bun 的原生 `fetch` 超时(`timeout: false`)以支持长预填充提示。使用 `streamFirstEventTimeoutMs` 通过 `armPreResponseTimeout` 武装预响应超时。Bedrock stream 在推理期间不发送 ping/keepalive 事件;catalog 兼容(`packages/catalog/src/compat/bedrock.ts` 的 `buildBedrockCompat`)将标准推理模型的 `streamIdleTimeoutMs` 下限设置为 600s,将自适应思考模型(Claude Opus 4.7+、Sonnet/Opus 5、Fable 5)设置为 900s。

### Auth & usage
- **Dual Auth Modes**:
  - Bearer Token:如果存在 `options.bearerToken`、`options.apiKey` 或 `$env.AWS_BEARER_TOKEN_BEDROCK`(`resolveAwsBearerToken`),则设置 `Authorization: Bearer <token>` 并绕过 SigV4 签名。
  - AWS SigV4 Signing:`signRequest`(`packages/ai/src/providers/aws-sigv4.ts`)使用 WebCrypto(`crypto.subtle`)对头进行签名。计算 SHA-256 负载摘要(`x-amz-content-sha256`)、日期(`x-amz-date`)、host 和安全 token(`x-amz-security-token`)。派生 HMAC-SHA256 签名密钥链(`AWS4` + `secretAccessKey` -> `kDate` -> `kRegion` -> `kService`("bedrock") -> `kSigning`)。
- **5-Tier Credential Resolution Chain**:`resolveAwsCredentials`(`packages/ai/src/providers/aws-credentials.ts`)按 `profile\0region\0config` 键缓存解析的凭据,具有 60s 刷新偏斜(`REFRESH_SKEW_MS`)和单次 in-flight 去重,受 30s 超时(`SHARED_RESOLVE_TIMEOUT_MS`)限制。链优先级:
  1. 环境变量:`AWS_ACCESS_KEY_ID`、`AWS_SECRET_ACCESS_KEY`、可选的 `AWS_SESSION_TOKEN`。
  2. Web Identity / OIDC:`AWS_WEB_IDENTITY_TOKEN_FILE`、`AWS_ROLE_ARN`、`AWS_ROLE_SESSION_NAME`。在 `sts.{region}.amazonaws.com` 上调用 STS `AssumeRoleWithWebIdentity`。
  3. 共享配置/配置文件(`~/.aws/credentials`、`~/.aws/config` 通过 `parseAwsIni` 解析):静态密钥(通过 `FILE_SESSION_CREDS_TTL_MS` 将文件会话 token 限制为 5 分钟 TTL)、AWS SSO(`sso_account_id`、`sso_role_name`、遗留 `sso_start_url`/`sso_region` 或 `sso-session` 块;从 `~/.aws/sso/cache/*.json` 读取缓存 token 并调用 `portal.sso.{ssoRegion}.amazonaws.com/federation/credentials`)或 `credential_process`(使用 POSIX 标记化 `tokenizeCredentialProcessCommand` 生成外部进程;Windows `.cmd`/`.bat` 通过 `cmd.exe /c` 路由;期望版本 1 JSON 信封)。
  4. ECS / 容器:`AWS_CONTAINER_CREDENTIALS_RELATIVE_URI`(在 `http://169.254.170.2/` 上)或 `AWS_CONTAINER_CREDENTIALS_FULL_URI`,具有可选的身份验证 token/文件。
  5. EC2 IMDSv2:`169.254.169.254`(或 IPv6 `[fd00:ec2::254]`),使用 1s 超时(`IMDS_TIMEOUT_MS`)从 `latest/api/token` 请求 PUT token。
- **Cache Invalidation & Registry Status**:在 401/403 HTTP 响应上,`streamBedrock` 调用 `invalidateAwsCredentialCache({ profile, region })` 以丢弃缓存的凭据,以便后续回合重新解析新凭据。`amazonBedrockProvider`(`packages/ai/src/registry/amazon-bedrock.ts`)评估 `hasAwsCredentialSource()`(`packages/ai/src/registry/aws.ts`)以在存在有效凭据或环境 token 时返回 `AUTHENTICATED_SENTINEL`。

### Catalog model handling
- **Descriptor Registration**:在 `CATALOG_PROVIDERS`(`packages/catalog/src/provider-models/descriptors.ts`)中注册,默认模型 `us.anthropic.claude-opus-4-8`。
- **models.dev Mapping & Cross-Region Profiles**:`MODELS_DEV_PROVIDER_DESCRIPTORS`(`packages/catalog/src/provider-models/openai-compat.ts`)将 `modelsDevKey: "amazon-bedrock"` 映射到 API `bedrock-converse-stream`。`bedrockCrossRegionId` 为匹配模型添加 `global.` 或 `us.` 前缀。对于 `anthropic.claude-*` 模型,`transformModel` 自动发出 EU(`eu.`)和 AWS GovCloud(`us-gov.`)跨区域推理配置文件规范变体。过滤掉非工具和遗留模型(`ai21.jamba`、`titan-text-express`、`mistral-7b`)。
- **Mantle & Undocumented Model Exclusion**:Bedrock Mantle 是一个不同的 provider(`bedrock-mantle`,`openai-responses` API,`https://bedrock-mantle.{region}.api.aws/openai/v1`),由单独的子代理覆盖。Catalog 构建策略(`packages/catalog/scripts/generated-policies.ts`)运行 `dropBedrockMantleOpenAIModels` 以从 `amazon-bedrock` 中排除 Mantle OpenAI 模型行(`openai.gpt-5.4`、`5.5`、`5.6-luna`、`sol`、`terra`)。`dropUnsupportedBedrockGeoIds` 修剪 `jp.anthropic.claude-opus-5`(在 models.dev 上上游列出但不受 AWS Bedrock 支持并被拒绝)。
- **Prompt Caching & Thinking Compat**:`buildBedrockCompat`(`packages/catalog/src/compat/bedrock.ts`)将模型 ID 映射到显式 prompt 缓存契约(`promptCacheMode`:`explicit` 或 `none`,最小 token 阈值 512、1024、2048、4096;`supportsLongPromptCacheRetention` 1h vs 5m;最多 4 个检查点)。`inferThinkingControlMode`(`packages/catalog/src/model-thinking.ts`)将 Claude 4.6+ 自适应模型分类为 `anthropic-adaptive`(设置 `supportsDisplay: true`),Opus 4.5 为 `anthropic-budget-effort`,非自适应模型为 `budget`。价格生成并具体化为 `packages/catalog/src/models.json`。

## Amazon Bedrock Mantle

Amazon Bedrock Mantle 是 AWS 的网关端点,通过 OpenAI Responses API(`openai-responses`)协议而不是 Bedrock 的原生 Converse JSON 传输(`amazon-bedrock`)提供 OpenAI 兼容模型(例如 `openai.gpt-5.4`、`openai.gpt-5.5` 和 `openai.gpt-5.6` Luna/Sol/Terra 变体)。请求面向区域插入的端点(`https://bedrock-mantle.{region}.api.aws/openai/v1`),使用 OpenAI Responses API 负载(`/responses`)。入口模块是 `packages/ai/src/providers/bedrock-mantle.ts`、`packages/ai/src/registry/bedrock-mantle.ts` 以及 `packages/catalog/src/provider-models/openai-compat.ts` 中的 catalog 设置。

### Special casings
- **Endpoint Structure**:与标准 Bedrock Converse 端点(`bedrock-runtime.{region}.amazonaws.com`)不同,Mantle 请求面向 `https://bedrock-mantle.{region}.api.aws/openai/v1`。`model.baseUrl` 中的 `{region}` 模板占位符在请求准备时在 `prepareBedrockMantleRequest`(`packages/ai/src/providers/bedrock-mantle.ts`)中动态替换。
- **Region Resolution Hierarchy**:`resolveAwsRegion`(`packages/ai/src/utils/aws-profile.ts`)中的区域替换按以下顺序求值:显式 `providerOptions.region` -> `AWS_REGION` -> `AWS_DEFAULT_REGION` -> 来自 `~/.aws/config` 中活动 AWS 共享配置文件的区域(`resolveAwsProfileRegion`)-> 回退默认 `"us-east-1"`。
- **401/403 Credential Invalidation**:在 `createSignedFetch`(`packages/ai/src/providers/bedrock-mantle.ts`)中使用 SigV4 签名请求时,HTTP 401 或 403 响应触发 `invalidateAwsCredentialCache({ profile, region })`(`packages/ai/src/providers/aws-credentials.ts`),以便后续尝试从配置文件、环境或 STS 角色重新解析新凭据。
- **Registry Sentinel & Auth Flag**:`packages/ai/src/registry/bedrock-mantle.ts` 中的 `bedrockMantleProvider` 设置 `allowsMissingApiKey: true`。当存在环境 AWS 凭据(`packages/ai/src/registry/aws.ts` 中的 `hasAwsCredentialSource`)时,`resolveAwsRegistryApiKey` 返回 `AUTHENTICATED_SENTINEL`。`resolveAwsBearerToken` 剥离此 sentinel 值,因此除非存在实际的 bearer token,否则选择 SigV4 身份验证。
- **Generator Model Drop Policy**:在 `packages/catalog/scripts/generated-policies.ts` 中,`dropBedrockMantleOpenAIModels` 从 `amazon-bedrock` provider 中过滤掉 `openai.gpt-5.*` 行(其中上游 `models.dev` 错误地将它们分配给 Bedrock Converse),以便仅公开工作的 `bedrock-mantle` Responses API 模型。

### Stream behavior
- **Transport**:委托给 `openai-responses` provider 管道(`packages/ai/src/providers/openai-responses.ts`),消费 SSE stream 事件,如 `response.created`、`response.text.delta`、`response.output_item.added` 和 `response.completed`。
- **Reasoning & Thinking Effort**:通过 `BEDROCK_MANTLE_GPT_5_X_THINKING` 和 `BEDROCK_MANTLE_GPT_5_6_THINKING`(`packages/catalog/src/provider-models/openai-compat.ts`)配置,支持 effort 等级(`low`、`medium`、`high`、`xhigh`、`max`)。推理内容在 `openai-responses` 推理 delta 帧中流式传输。
- **Error Handling**:非 2xx SSE stream 将错误状态代码传递回 stream 结果处理程序;401/403 状态代码使 `createSignedFetch` 中的缓存 AWS 凭据状态无效。

### Auth & usage
- **Dual Authentication Modes**:
  - **Bearer Token**:由 `resolveBearerToken`(`packages/ai/src/providers/bedrock-mantle.ts`)求值。当提供 `AWS_BEARER_TOKEN_BEDROCK`、`providerOptions.bearerToken` 或显式非 sentinel `apiKey` 时处于活动状态。`createBedrockMantleAuthenticatedFetch` 注入 `Authorization: Bearer <token>`。
  - **AWS SigV4 Signing**:当不存在 bearer token 但环境凭据通过 `hasAwsCredentialSource` 时处于活动状态。请求头由 `signRequest`(`packages/ai/src/providers/aws-sigv4.ts`)使用服务名称 `"bedrock-mantle"` 签名,设置 `Authorization: AWS4-HMAC-SHA256 ...` 和 `x-amz-security-token`(使用会话凭据时)。
- **Authentication Precedence**:当两者都可用时,bearer token 优先于 SigV4 签名。
- **Usage Tracking**:输入、输出、缓存和推理 token 使用直接从标准 OpenAI Responses wire 负载(`usage.input_tokens`、`usage.output_tokens`、`usage.input_token_details.cached_tokens`、`usage.output_token_details.reasoning_tokens`)中解析,由 `openai-responses` 处理。

### Catalog model handling
- **Provider Descriptor**:`packages/catalog/src/provider-models/descriptors.ts` 中的 `bedrock-mantle` 描述符设置 `defaultModel: "openai.gpt-5.6-terra"`、`envVars: ["AWS_BEARER_TOKEN_BEDROCK"]` 和 `dynamicModelsAuthoritative: true`。
- **Static Seeds**:在 `BEDROCK_MANTLE_STATIC_MODELS`(`packages/catalog/src/provider-models/openai-compat.ts`)中预捆绑,具有 5 个 OpenAI 模型(`openai.gpt-5.4`、`openai.gpt-5.5`、`openai.gpt-5.6-luna`、`openai.gpt-5.6-sol`、`openai.gpt-5.6-terra`),定义上下文窗口(272,000)、最大 token(128,000)、定价结构和思考 effort 规范。
- **Authenticated Model Discovery**:
  - `packages/ai/src/registry/bedrock-mantle.ts` 中的 `prepareModelDiscovery` 需要有效的 bearer token(`resolveAwsBearerToken`)。如果未通过身份验证或仅 SigV4,则返回 `authenticated: false` 并绕过发现。
  - 通过身份验证时,发现剥离 `/openai/v1` 以通过 `fetchOpenAICompatibleModels` 调用 `https://bedrock-mantle.{region}.api.aws/v1/models`。
- **Authoritative Dynamic Model Replacement**:`bedrockMantleModelManagerOptions` 中的 `dynamicModelsAuthoritative: true` 导致成功的动态发现响应**完全替换**静态 seed,修剪未为 AWS 账户/token 启用的模型。
- **Reference Attribute Merging**:`mapWithBundledReference` 将静态定义的成本、思考配置和上下文窗口合并到与 `BEDROCK_MANTLE_MODEL_BY_ID` 匹配的动态发现模型定义上。


## Kimi Code
Kimi Code (`kimi-code`) 和 Moonshot (`moonshot`) 通过双传输执行提供对 Moonshot AI 模型家族的访问——包装 OpenAI 兼容的聊天补全 (`/coding/v1/chat/completions`) 和 Anthropic 兼容的消息 (`/coding/v1/messages`)。入口点为 `packages/ai/src/providers/kimi.ts` (`streamKimi`) 和 `packages/ai/src/providers/openai-anthropic-shim.ts` (`streamOpenAIAnthropicShim`)，模型发现和目录描述符在 `packages/catalog/src/provider-models/descriptors.ts` 和 `packages/catalog/src/provider-models/openai-compat.ts` 中配置。

### 特殊情况
- **双传输路由**：`streamKimi` 委托给 `packages/ai/src/providers/openai-anthropic-shim.ts` 中的 `streamOpenAIAnthropicShim`，从 `model.compat.kimiApiFormat` 或 `KimiOptions` 中的显式 `options.format` 选择格式。
  - `anthropic`：使用 `api: "anthropic-messages"` 重建模型规范，通过 `model.baseUrl.replace(/\/v1\/?$/, "")` 调整 base URL (`https://api.kimi.com/coding`)，注入 `getKimiCommonHeaders()`，将思考格式映射到 `anthropic-adaptive`，通过 `ANTHROPIC_THINKING` 计算 token 预算，并通过 `streamAnthropic` 进行流式传输。
  - `openai`：保留 `model.baseUrl` (`https://api.kimi.com/coding/v1`)，注入 `getKimiCommonHeaders()`，传递 `reasoning` effort，并通过 `streamOpenAICompletions` 进行流式传输。
- **MFJS 工具 Schema 验证**：在 `packages/catalog/src/compat/openai.ts` (`buildOpenAICompat`) 中为原生 Moonshot 主机 (`isMoonshotNative`) 和跨第三方代理的 Kimi 模型 ID 强制执行 `toolSchemaFlavor: "moonshot-mfjs"`。Moonshot 风格 JSON Schema 将单值 `const` 构造折叠为单元素 `enum` 数组，推理出裸 `enum` 声明的显式 `type`，并剥离不受支持的非标准关键字，以防止 400 schema 验证错误。
- **强制工具选择保护**：原生 K2.7 Code 模型 (`kimi-k2.7-code`、`kimi-for-coding`) 和 K3 模型需要在 `packages/catalog/src/compat/anthropic.ts` 中的服务器端思考 (`requiresThinkingEnabled = true`)。在 Anthropic 表面，强制工具选择降级为 `auto`。在 OpenAI 表面 (`packages/catalog/src/compat/openai.ts`)，`supportsForcedToolChoice` 对于强制思考的 K2.7 模型 (`requiresEnabledThinking`) 为 `false`，但对于 K3 (`!isMoonshotKimiK3`) 仍为 `true`。
- **轮次与 Token 不变量**：
  - `alwaysSendMaxTokens: isKimiModel` 在 `packages/catalog/src/compat/openai.ts` 中：Kimi 根据 `max_tokens`（而非已发出的 token）计算速率限制（TPM），因此需要在每个请求中显式设置最大 token。
  - `requiresReasoningContentForToolCalls`：对于非 OpenCode 提供商上的 Kimi 模型 (`packages/catalog/src/compat/openai.ts`) 为 `true`。先前的助手工具调用轮次必须在思考后续中携带 `reasoning_content`，当原始推理缺失时允许使用合成占位符 `"."` (`allowsSyntheticReasoningContentForToolCalls`)。
  - `requiresAssistantContentForToolCalls`：在助手工具调用轮次中强制使用非空文本内容。

### 流行为
- **带内控制标签与思考扫描**：`packages/ai/src/dialect/kimi.ts` 中的 `KimiInbandScanner` 处理原始输出流中的类似 XML 的工具控制标签 (`<|tool_calls_section_begin|>`、`<|tool_call_begin|>`、`<|tool_call_argument_begin|>`、`<|tool_call_end|>`、`<|tool_calls_section_end|>`) 和 `<think>...</think>` 思考块，发出结构化 `InbandScanEvent` 事件 (`text`、`thinkingStart`、`thinkingDelta`、`thinkingEnd`、`toolStart`、`toolEnd`)。
- **流标记修复**：`packages/catalog/src/compat/openai.ts` 中的 `streamMarkupHealingPattern: "kimi"` (`detectStreamMarkupHealingPattern`) 修复 `kimi-code`、`moonshot` 或 `kimi-k2` 模型 ID 跨块边界被截断或分割的带内控制标记。
- **空闲看门狗超时**：`packages/catalog/src/compat/openai.ts` 中原生 K2.7 Code 模型的 `streamIdleTimeoutMs` 下限延长至 300 秒，以防止在长时间初始推理生成期间过早中止流。

### 认证与使用
- **设备 OAuth 流**：在 `packages/ai/src/registry/oauth/kimi.ts` (`loginKimi`、`refreshKimiToken`) 中实现。使用 OAuth 2.0 设备授权授予 (`urn:ietf:params:oauth:grant-type:device_code`)，客户端 ID 为 `17e5f671-d194-4dfb-9706-5516cb48c098`，主机为 `${resolveOAuthHost()}` (`https://auth.kimi.com`，可通过 `KIMI_CODE_OAUTH_HOST` 或 `KIMI_OAUTH_HOST` 配置)。
  - 通过 `POST /api/oauth/device_authorization` 启动，向用户提示 `userCode` 和 `verificationUriComplete`，并通过 `authorization_pending` 和 `slow_down` 退避策略轮询 `POST /api/oauth/token`。Token 刷新使用 `grant_type: "refresh_token"`。
- **指纹标头与设备 ID**：`packages/ai/src/registry/oauth/kimi.ts` 中的 `getKimiCommonHeaders()` 注入设备跟踪标头：`User-Agent: KimiCLI/<ver>`、`X-Msh-Platform: kimi_cli`、`X-Msh-Version`、`X-Msh-Device-Name`、`X-Msh-Device-Model`、`X-Msh-Os-Version` 和 `X-Msh-Device-Id`。`getDeviceId` 将随机十六进制 UUID 持久化到 `path.join(getAgentDir(), "kimi-device-id")` (模式 0600)，或回退到临时进程 UUID。
- **使用与配额跟踪器**：`packages/ai/src/usage/kimi.ts` 中的 `kimiUsageProvider` 面向 `GET /coding/v1/usages` (`https://api.kimi.com/coding/v1/usages`，可通过 `KIMI_CODE_BASE_URL` 配置)，使用 OAuth bearer token 和 `getKimiCommonHeaders()`。
  - 当凭证过期时短路 (`credential.expiresAt <= nowMs`)。解析 `KimiUsagePayload`：将 `usage` 对象映射到 `Total quota` 摘要行，并将 `limits` 数组（提取 `detail` 和 `window` duration/timeUnit）映射到 `UsageLimit` 条目，通过 `parseResetTime` (`reset_at`、`resetTime`、`ttl`) 解析重置时间戳。

### 目录模型处理
- **提供商描述符**：`packages/catalog/src/provider-models/descriptors.ts` 定义：
  - `kimi-code`：默认模型 `"kimi-for-coding"`，环境变量 `KIMI_API_KEY`，通过 `kimiCodeModelManagerOptions` 进行动态发现。
  - `moonshot`：默认模型 `"kimi-k2.7-code"`，环境变量 `MOONSHOT_API_KEY` 和 `KIMI_API_KEY` 回退，通过 `moonshotModelManagerOptions` 进行动态发现（默认 base URL `https://api.moonshot.ai/v1`，可通过 `MOONSHOT_BASE_URL` 覆盖）。
- **身份分类**：`packages/catalog/src/identity/family.ts` 导出 `isKimiModelId` (匹配 `moonshotai/kimi` 或 `/(^|\/)kimi[-.]/`)、`isKimiK26ModelId` (`/kimi-k2(\.6|p6)/`) 和 `isKimiK3ModelId` (`/kimi-k3/`)。`packages/catalog/src/provider-models/openai-compat.ts` 中的 `isKimiK27CodeModelId` 匹配 `/kimi-k2.7-code/`。
- **K2.x 与 K3 推理差异**：
  - **K2.x**：原生 Moonshot K2.x 模型通过 `packages/catalog/src/compat/openai.ts` 中的 `thinkingFormat: "zai"` 使用二元思考 (`thinking: { type: "enabled" | "disabled" }`)。在 `moonshotModelManagerOptions` 中配置 4 级 effort 范围 `[Minimal, Low, Medium, High]`。K2.6 保留完整思考上下文 (`thinkingKeep: "all"`)。
  - **K3**：K3 模型使用 OpenAI 风格的 `reasoning_effort` (`thinkingFormat: "openai"`)。配置 3 级线路规模 `LOW_HIGH_MAX_REASONING_EFFORTS` (`[Low, High, Max]`)、`defaultLevel: Effort.Max` 和强制推理 (`requiresEffort: true`，`packages/catalog/src/model-thinking.ts` 中的 `impliesMandatoryReasoning`)。`moonshotModelManagerOptions` 标记 1M 上下文窗口、131,072 maxTokens 和视觉输入 (`["text", "image"]`)。
- **输出 Token 上限**：`packages/catalog/src/provider-models/openai-compat.ts` 中的 `kimiCodeMaxTokens` 派生每个家族的输出限制：131,072 (`KIMI_CODE_K3_MAX_TOKENS`) 用于 `k3` / `k3-256k`，32,768 (`KIMI_CODE_FOR_CODING_MAX_TOKENS`) 用于 `kimi-for-coding` / `kimi-for-coding-highspeed`，以及回退 32,000 (`KIMI_CODE_DEFAULT_MAX_TOKENS`) 用于旧版 K2 发现行。应用于目录生成器 (`packages/catalog/scripts/generate-models.ts`)。

## Ollama
Ollama 集成由 `packages/ai` 中的两个不同提供商定义组成：`ollama` 用于本地 Ollama 实例（通过 `baseUrl` 指向本地端点 `/v1` 的 `openai-responses` 或 `openai-completions` API，默认为 `http://127.0.0.1:11434/v1`），`ollama-cloud` 用于 Ollama Cloud（在 `https://ollama.com/api/chat` 使用原生 `ollama-chat` API 传输）。入口模块为 `packages/ai/src/providers/ollama.ts`（用于原生流式传输）、`packages/catalog/src/provider-models/openai-compat.ts`（用于本地 Ollama 目录选项 `ollamaModelManagerOptions`）和 `packages/catalog/src/provider-models/ollama.ts`（用于 Ollama Cloud 目录选项 `ollamaCloudModelManagerOptions`）。

### 特殊情况
- **传输路由**：本地 `ollama` 默认使用 OpenAI 兼容路径 (`openai-responses` / `openai-completions`)，而 `ollama-cloud` 使用原生 `ollama-chat` 协议。
- **思考/推理支持**：对于 `ollama-chat`，推理通过 `createChatBody` 中由 `mapReasoning` 映射的原生 `think` 字段控制（`minimal`/`low` -> `"low"`，`medium` -> `"medium"`，`high`/`xhigh` -> `"high"`，`max` -> `"max"`，或在设置 `disableReasoning` 时为 `false`）。GLM-5.2 的 Ollama Cloud effort 级别限制为 `high` 和 `max`（`packages/catalog/src/provider-models/ollama.ts` 中的 `OLLAMA_CLOUD_GLM_52_THINKING`）。OpenAI 兼容路径上的本地 `ollama` 支持值为 `low`、`medium`、`high`、`max`、`none` 的 `reasoning.effort`（`packages/catalog/src/model-thinking.ts` 中的 `OLLAMA_REASONING_EFFORTS`），并为本地 KV 缓存/聊天模板保留自动启用 `replayReasoningContent: true`（`packages/catalog/src/compat/openai.ts` 中的 `LOCAL_OPENAI_COMPAT_PROVIDERS`）。
- **工具选择模拟**：`packages/ai/src/providers/ollama.ts` 中的 `selectToolsForToolChoice` 在请求特定命名工具选择时（`{ type: "function", function: { name } }` 或 `{ name }`）手动将 `context.tools` 过滤到目标工具。映射 `toolChoice` 将 `"none"` 映射为 `"none"`，`"required"`/`"any"`/命名对象映射为 `"required"`，`"auto"` 映射为 `undefined`。
- **开发者角色与历史清理**：开发者系统提示如果是初始系统提示或由代理归属，则保留在 Ollama 的 `system` 角色上，但用户归属的开发者轮次降级为 `user` 以实现稳定的前缀缓存。如果不存在 `user` 角色，`convertMessages` 将最后一个系统轮次降级为 `user`，以防止 Ollama 在不生成输出时发出 `done_reason: "load"`。对于 `ollama-cloud`，`thinking` 字段从助手历史消息中剥离（`convertMessages`），因为 Ollama Cloud 拒绝接收携带 `thinking` 的传入历史，返回 HTTP 400。
- **Schema 清理**：工具 schema 通过 `sanitizeSchemaForOllama(toolWireSchema(tool))` 以确保兼容性。
- **模型加载 / `keep_alive` 与错误重写**：当请求不包含用户轮次或 Ollama 生成零个 token 时，Ollama 返回 `done_reason: "load"`，映射为带有 `EMPTY_OLLAMA_LOAD_COMPLETION_MESSAGE` 的 stopReason `"error"`。来自本地 llama.cpp 后端的格式错误的工具调用 JSON 错误（HTTP 500）由 `packages/ai/src/error/format.ts` 中的 `rewriteOllamaToolCallJsonError` 重写。`shouldRetryOllamaResponse` 重试 5xx 错误，除非与 `LLAMA_CPP_TOOL_CALL_PARSE_PATTERN` 匹配。

### 流行为
- **NDJSON / JSONL 事件协议**：原生 `ollama-chat` 通过 `readJsonl<OllamaChatChunk>` 解析流式 NDJSON 块。
- **推理与内容处理**：推理块作为 `chunk.message.thinking` 到达（产生 `thinking_start`、`thinking_delta`、`thinking_end`）。内容文本作为 `chunk.message.content` 到达。结构化工具调用作为 `chunk.message.tool_calls` 到达。
- **流标记修复**：流标记修复（使用 `getStreamMarkupHealingPattern` 的 `StreamMarkupHealing`）用于文本通道工具调用和推理恢复。当存在原生 `chunk.message.thinking` 时，`suppressHealedThinking` 设置为 `true` 以避免重复计算推理块。
- **结束原因映射**：`mapDoneReason` 映射 `done_reason`：`"length"` -> `"length"`，`"tool_calls"` -> `"toolUse"`，`"load"` -> `"error"`，带工具调用的 `undefined` -> `"toolUse"`。生成的工具调用的自然 `stop` 提升为 `"toolUse"`。
- **看门狗与本地预填充**：通过 `armPreResponseTimeout` 与 `firstEventTimeoutMs`（派生自 `PI_STREAM_FIRST_EVENT_TIMEOUT_MS` 或 `idleTimeoutMs`）设置预响应超时，同时将 `timeout: false` 传递给 `fetchWithRetry` 以避免在大量本地预填充期间过早中止 Bun fetch 超时。重试使用延迟 `[2000, 5000, 10000]`。
- **空补全重试**：`streamOllama` 用 `withEmptyCompletionRetry` 包装，以透明地重试仅 EOS 的空补全。

### 认证与使用
- **凭证来源**：`loginOllama`（`packages/ai/src/registry/ollama.ts`）提示输入可选的 API 密钥（`allowEmpty: true`），默认情况下本地无认证使用 `envVars: ["OLLAMA_API_KEY"]`。`loginOllamaCloud`（`packages/ai/src/registry/ollama-cloud.ts`）要求在 `https://ollama.com/settings/keys` 创建的 API 密钥，`envVars: ["OLLAMA_CLOUD_API_KEY"]`。
- **认证标头**：本地请求在提供时附加 `Authorization: Bearer ${apiKey}`；`ollama-cloud` 需要 `Authorization: Bearer ${apiKey}`。
- **使用与配额**：配额跟踪通过 `packages/ai/src/usage/ollama.ts` 中的 `ollamaUsageProvider` 和 `ollamaCloudUsageProvider` 注册。两个提供商均不公开独立的使用/配额 API（`validatesCredentials: false`，空的 `limits`），而是依赖流式补全块中返回的每个响应 `prompt_eval_count`（输入）和 `eval_count`（输出）。

### 目录模型处理
- **描述符**：在 `packages/catalog/src/provider-models/descriptors.ts` 中定义：
  - `ollama`：`defaultModel: "gpt-oss:20b"`，`allowUnauthenticated: true`，`envVars: ["OLLAMA_API_KEY"]`，通过 `ollamaModelManagerOptions` 构建选项。从 `generate-models.ts` 静态烘焙中排除（`DISCOVERY_ONLY_PROVIDERS`）。
  - `ollama-cloud`：`defaultModel: "gpt-oss:120b"`，`envVars: ["OLLAMA_CLOUD_API_KEY"]`，`catalogDiscovery: { label: "Ollama Cloud", oauthProvider: "ollama-cloud" }`，通过 `ollamaCloudModelManagerOptions` 构建选项。
- **本地目录发现**：`packages/catalog/src/provider-models/openai-compat.ts` 中的 `ollamaModelManagerOptions` 首先尝试在 `/v1/models` 上 `fetchOpenAICompatibleModels`。如果不可用，则回退到查询 `/api/tags` 的原生 `fetchOllamaNativeModels`。
- **云目录发现**：`packages/catalog/src/provider-models/ollama.ts` 中的 `ollamaCloudModelManagerOptions` 在 `https://ollama.com` 上使用 `OLLAMA_CLOUD_API_KEY` 查询 `/api/tags`。
- **通过 `/api/show` 进行上下文长度和功能检测**：本地和云发现都查询 Ollama 的 `/api/show` 以检查每个模型的 `model_info` 和 `capabilities`。
  - 上下文长度从以 `.context_length`、`.num_ctx` 或 `.context_window` 结尾的 `model_info` 键中提取。回退上下文窗口为 `128_000`（`OLLAMA_FALLBACK_CONTEXT_WINDOW`）。
  - 功能标记：`capabilities.includes("thinking")` 设置 `reasoning: true` 并配置 `thinking` effort 配置（`[minimal, low, medium, high]`）。`capabilities.includes("vision")` 标记 `input: ["text", "image"]`。
- **输出 Token 上限封顶**：Ollama Cloud 对 DeepSeek V4 Pro/Flash 模型强制执行 `OLLAMA_CLOUD_MAX_OUTPUT_TOKENS = 65_536`（`isOllamaCloudOutputCapped`）。`ollamaCloudModelManagerOptions` 将 `maxTokens` 限制为 `min(contextWindow, 65536)` 并设置 `omitMaxOutputTokens: true`。`packages/ai/src/providers/ollama.ts` 中的 `resolveNumPredict` 进一步将线路有效负载上的 `num_predict` 限制为 `65_536`。
- **缓存提供商 ID**：由 `packages/catalog/src/provider-models/cache-provider-id.ts` 中的 `resolveModelCacheProviderId` 解析，使用 `http://127.0.0.1:11434` 作为 `ollama` 或端点哈希。

## Cursor

Cursor 在 `packages/ai` 中的集成通过 HTTP/2 Connect RPC 传输（`/agent.v1.AgentService/Run`）操作，发送带长度前缀的二进制 Protobuf 消息（`AgentClientMessage` 和 `AgentServerMessage`）。关键实现入口点包括 `packages/ai/src/providers/cursor.ts`（用于连接生命周期、Connect 消息流和帧调度）；`packages/ai/src/providers/cursor-pi-args.ts`（用于纯参数和路径转换）；`packages/ai/src/providers/cursor/exec-modern.ts`（用于本地工具结果帧构建器）；`packages/ai/src/registry/cursor.ts` 和 `packages/ai/src/registry/oauth/cursor.ts`（用于 PKCE 浏览器身份验证和令牌刷新）；`packages/ai/src/usage/cursor.ts`（用于多端点配额跟踪）；以及 `packages/catalog/src/discovery/cursor.ts`（用于 Connect RPC 模型发现）。

### 特殊情况
- **纯参数转换（`cursor-pi-args.ts`）**：路径和参数格式化函数（`piReadPath`、`piReadPathHasRange`、`piReadDisplayPath`、`piGrepSkip`、`piJoinPath`、`piLsPath`、`piEscapeRegexLiteral`、`piLimit`、`piTimeout`）严格独立于 Protobuf 导入，以便旧版 shim 可以在不将 protobuf schema 捆绑到虚拟注册表的情况下共享它们。
- **空 Grep 模式拒绝**：具有空 `pattern` 和非空 `glob` 的 `grepArgs` 帧被预先拒绝（`emptyGrepPatternRejection`）并带有描述性错误，强制模型重试或切换工具，而不是在块持久化后触发本地工具失败。
- **原生工具与 `SoftToolRequirement` 交互**：
  - 在构建 `requestContext` MCP 工具定义时，省略原生工具（`CURSOR_NATIVE_TOOL_NAMES`：`bash`、`read`、`write`、`delete`、`ls`、`grep`、`todo`）。
  - **例外**：每当宣传 pi-agent 工具时，`write` 在 `buildMcpToolDefinitions` 中被明确重新包含。`write` 充当用于暂存预览的 `xd://` 传输（例如 `ast_edit`）。没有 `write`，暂存预览无法解析，`SoftToolRequirement('write')` 升级将中止轮次。
- **`rootPromptMessagesJson` 与 Blob 存储**：
  - `buildGrpcRequest` 将对话历史作为 SHA-256 二进制 blob ID（`blobStore`）传递到 `rootPromptMessagesJson` 和 `turns` 中。
  - 系统提示存储为单独的 JSON blob（`buildCursorSystemPromptJsons`），允许仅当下游提示更改时进行独立的服务器端前缀 blob 缓存命中。
- **思考重放保护**：
  - 助手思考内容仅针对同模型 Kimi K3 变体（`assertCursorKimiK3HistoryReplayable`）在轮次历史中重放（`canReplayCursorThinking`）。外部或隐藏推理被省略，以防止将非 Cursor 思考块泄漏到原生对话轮次中。

### 流行为
- **带长度前缀的 Connect 帧**：
  - Connect HTTP/2 流使用 5 字节标头（1 字节标志 + 4 字节大端 uint32 有效负载长度）。
  - `CONNECT_END_STREAM_FLAG`（`0b00000010`）标记携带 JSON 错误对象（`parseConnectEndStream`）的终止帧。
- **尾部与传输错误处理**：
  - 监视 HTTP/2 尾部（`grpc-status`、`grpc-message`），并使用 `mapH2TransportError` 映射套接字或 TLS 断开连接。
- **双向 RPC 调度**：
  - 服务器流式传输 `AgentServerMessage`（`interactionUpdate`、`execServerMessage`、`kvServerMessage`、`interactionQuery`）。
  - 客户端写入 `AgentClientMessage`（`runRequest`、每 5 秒的周期性 `clientHeartbeat`、`interactionResponse`）和 `ExecClientMessage` 工具响应（`readResult`、`writeResult`、`execClientThrow`、`requestContextResult`）。
- **交互查询握手**：
  - 托管的 Web 搜索 / Exa / 未命名的 field-9 WebFetch 发送 `interactionQuery` 并阻塞轮次，直到客户端写入 `interactionResponse`。
  - 心跳保持 HTTP/2 存活但不是语义进度；未应答的查询在 300 秒空闲看门狗（`Provider stream stalled while waiting for the next event`）之前一直保持静默。
  - `handleInteractionQuery` 批准网络权限网关并拒绝交互式询问/切换模式/创建计划。VM 设置保持未应答状态，因为其结果 oneof 仅限 success。
- **异步执行排出与轮次完成**：
  - `handleServerMessage` 异步处理帧，以便套接字继续排出。调度在 `inFlightDispatches` 中跟踪，并在最终确定流完成之前由 `options.signal` 中止处理限制。
  - 流完成验证 `turnEnded`（`sawTurnEnded`），否则抛出 `incomplete-stream`。
- **工具调用合成**：
  - `synthesizeCursorExecToolCall` 在助手输出消息上生成显示 `toolCall` 块，以在 UI 和转录中镜像本地工具执行。

### 认证与使用
- **凭证与标头**：
  - 通过在 `Authorization: Bearer <token>` 中发送的 `CURSOR_ACCESS_TOKEN` 进行身份验证。
  - 客户端标头：`x-ghost-mode: true`、`x-cursor-client-version: cli-2026.07.23-e383d2b`、`x-cursor-client-type: cli`、`x-request-id`。
- **PKCE OAuth 与轮询**：
  - 深度链接 PKCE 登录生成 verifier/challenge 并重定向到 `https://cursor.com/loginDeepControl`。
  - 使用指数退避（延迟 1 秒到 10 秒，最多 150 次尝试）轮询 `https://api2.cursor.sh/auth/poll?uuid=...&verifier=...`。
  - 刷新通过 POST `https://api2.cursor.sh/auth/exchange_user_api_key` 交换刷新令牌。
- **使用与配额跟踪（`packages/ai/src/usage/cursor.ts`）**：
  - 从 `https://api2.cursor.sh/auth/usage` 获取标准配额（`parseCursorUsage`）。
  - 对于具有 WorkOS 用户会话的 OAuth 凭证（`WorkosCursorSessionToken=${userId}::${accessToken}`），从 `https://cursor.com/api/usage-summary` 获取个人使用情况（`parseCursorIndividualUsage`），并从 `https://cursor.com/api/auth/me` 获取用户配置文件电子邮件。

### 目录模型处理
- **描述符配置（`packages/catalog/src/provider-models/descriptors.ts`）**：
  - 配置提供商 ID `"cursor"`、默认模型 `"claude-4.6-opus-high"`、运行时环境变量 `CURSOR_ACCESS_TOKEN` 和目录发现环境变量 `CURSOR_API_KEY`。
- **缓存提供商 ID（`packages/catalog/src/provider-models/cache-provider-id.ts`）**：
  - 返回 `"cursor:max-mode-v3"` 以确保上下文窗口缓存失效。
- **模型发现（`packages/catalog/src/discovery/cursor.ts`）**：
  - `fetchCursorUsableModels` 通过 Connect RPC 调用 `GetUsableModels`（`/agent.v1.AgentService/GetUsableModels`）。
  - 从 `details.maxMode` 设置 `cursorMaxMode`，分配 `api: "cursor-agent"`，映射 1M 最大模式与 200k 默认上下文窗口，并默认 `maxTokens` 为 64,000。
  - 动态发现与来自 `models.json` 的捆绑参考模型合并。

## Devin
Devin 集成（`devin-agent` API）通过 HTTP/1.1 使用 Connect 协议和 gRPC/Protobuf 消息与 Codeium Cascade 后端服务通信。其实现跨越 `packages/ai/src/providers/devin.ts`（`streamDevin`、`DEVIN_API_URL`）中的提供商流逻辑、`packages/ai/src/registry/devin.ts`（`devinProvider`）中的提供商注册表条目、`packages/ai/src/registry/oauth/devin.ts`（`loginDevin`）中的 CLI OAuth 处理，以及位于 `packages/catalog/src/discovery/devin-gen/exa/*` 的 Connect protobuf schema。

### 特殊情况
* **Connect 二进制协议与帧包装**：传输通过 HTTP/1.1 上的 Connect 协议面向 `https://server.codeium.com`。请求有效负载是序列化的 Protobuf（`GetChatMessageRequestSchema`），使用 gzip 压缩，并包装在 5 字节 Connect 流式二进制帧标头中（`CONNECT_COMPRESSED_FLAG = 0x01`，4 字节大端有效负载长度）。流结束帧携带 `CONNECT_END_STREAM_FLAG = 0x02` 和 JSON 错误尾部（`readConnectTrailerError`）。
* **帧大小保护**：读取器在 `streamDevin` 中强制执行 16MB 帧有效负载上限（`MAX_CONNECT_FRAME_PAYLOAD`），以在缓冲之前拒绝损坏的帧长度标头。
* **消息格式映射**：系统提示被标准化（`normalizeSystemPrompts`）到顶级 `prompt` 字段。消息在 `buildChatMessagePrompts` 中格式化：
  * 用户/开发者消息映射到 `ChatMessageSource.USER`，具有确定性消息 ID（`cascadeId\0index\0role`）。
  * 助手消息映射到 `ChatMessageSource.SYSTEM`，具有文本、`thinking`、`signature` 和 `toolCalls`。原生 Devin 助手轮次保留 `responseId` 或回退到 `bot-<uuid>`。
  * 工具结果映射到 `ChatMessageSource.TOOL`，具有 `toolCallId` 和 `toolResultIsError`。
* **会话线程与停止模式**：会话线程将 `options.conversationId` 或 `options.sessionId` 作为 `cascadeId` 传递。默认停止模式包括 `<|user|>`、`<|bot|>`、`<|context_request|>`、`<|endoftext|>` 和 `<|end_of_turn|>`（`DEVIN_DEFAULT_STOP_PATTERNS`）。工具选择指定 `auto` 选择与 `disableParallelToolCalls: true` 和临时系统提示缓存（`CacheControlType.EPHEMERAL`）。

### 流行为
* **Protobuf 帧流式传输**：`streamDevin` 读取分块响应字节，解析 5 字节 Connect 标头。解压缩的二进制有效负载被解码为 `GetChatMessageResponseSchema`。
* **不透明错误恢复（`invalid_argument`）**：具有 `invalid_argument` 错误代码（例如"internal error occurred"）的流结束尾部在 `streamDevin` 中触发历史恢复。当符合条件的历史请求大小超过 512KB（`LARGE_HISTORY_RECOVERY_BYTES`）时，错误被重新分类为 `AIError.Flag.ContextOverflow` 以调用自动上下文修剪，而不是作为无效请求失败。
* **事件流转换**：
  * `deltaThinking` -> `thinking_start` / `thinking_delta`（签名从 `deltaSignature` 填充）。
  * `deltaText` -> `text_start` / `text_delta`。
  * `deltaToolCalls` -> `toolcall_start` / `toolcall_delta`。
* **节流流式传输工具参数**：中间流参数解析使用 `parseStreamingJsonThrottled`（`toolLastParseLen`）以在流式 JSON delta 上保持 O(N) 性能，然后在 `toolcall_end` 上执行权威的 `parseStreamingJson`。
* **停止原因解析**：将 `StopReason.MAX_TOKENS` 映射为 `length`，活动工具调用映射为 `toolUse`，默认为 `stop`。

### 认证与使用
* **双认证生命周期**：
  * **会话令牌前缀**：通过 `normalizeDevinSessionToken` 标准化 API 密钥凭证以确保 `devin-session-token$` 前缀。
  * **JWT 交换**：`fetchDevinAuthMetadata` 使用 `MetadataSchema` 中的 `apiKey` 向 `/exa.auth_pb.AuthService/GetUserJwt` 发送初始 Connect 请求（`GetUserJwtRequestSchema`）。服务器返回 `userJwt`（和可选的服务器 base URL 覆盖），该信息包含在后续聊天请求元数据中。
* **CLI OAuth 流**：`packages/ai/src/registry/oauth/devin.ts` 中的 `loginDevin` 使用 `https://app.devin.ai/auth/cli/continue` 执行 PKCE OAuth 流。令牌在 `https://api.devin.ai/auth/cli/token`（`exchangeDevinCliToken`）处交换，到期时间派生自 JWT 有效负载或 1 年默认回退。
* **使用面**：Devin 在 `packages/ai/src/usage/` 下没有单独的使用端点提供程序（不同于 `umans`）。流式响应帧包括令牌计数（`msg.usage`：`inputTokens`、`outputTokens`、`cacheReadTokens`、`cacheWriteTokens`），这些直接馈入 `calculateCost(model, output.usage)`。

### 目录模型处理
* **模型管理器配置**：`packages/catalog/src/provider-models/special.ts` 中的 `devinModelManagerOptions` 配置动态发现，当 API 密钥可用时使用 `dynamicModelsAuthoritative: true`。`descriptors.ts` 在 `CATALOG_PROVIDERS`（`DEVIN_API_KEY`、OAuth 提供商 `devin`）中注册 `devin`。
* **动态发现**：`packages/catalog/src/discovery/devin.ts` 中的 `fetchDevinModels` 使用 `MetadataSchema` 调用一元 Connect RPC `GetCliModelConfigs`（`/exa.api_server_pb.ApiServerService/GetCliModelConfigs`）。`normalizeDevinModels` 将 `ClientModelConfig` 转换为 `ModelSpec<"devin-agent">` 条目（默认为 200k 上下文窗口，64k 最大令牌）。
* **思考检测**：`supportsDevinThinking` 检查标签正则表达式模式（`/think|thinking|minimal|high|medium|low|xhigh|max|reasoning/i` 与 `/\bno thinking\b/i`）和 `modelInfo.modelFeatures.supportsThinking`。
* **Compat 解析**：`packages/catalog/src/compat/devin.ts` 中的 `buildDevinCompat` 设置 `trustExplicitThinkingOnly: true`（`ResolvedDevinCompat`），防止隐式 effort 阶梯推理（`model-thinking.ts`）。
* **推理 Effort 路由**：Devin 模型使用兄弟模型路由而不是线路推理字段（`variant-collapse.ts`）。`DEVIN_VARIANT_COLLAPSE_TABLE` 将模型系列（例如 `gpt-5-6-luna`、`claude-opus-5`）跨线路 effort 级别（`low`、`medium`、`high`、`xhigh`、`max`）映射到特定的路由兄弟模型 UID。

## GitLab Duo

GitLab Duo 通过 OMP 中的两个不同提供商集成：**GitLab Duo Non-Agentic**（`gitlab-duo`），它使用标准 HTTP/SSE 子提供商通过 GitLab AI Gateway 代理 LLM 请求；以及 **GitLab Duo Agent**（`gitlab-duo-agent`），它通过基于 WebSocket 的代理执行协议连接到 GitLab Duo Workflow Service（DWS）。`gitlab-duo` 的入口模块是 `packages/ai/src/providers/gitlab-duo.ts` 和 `packages/ai/src/registry/gitlab-duo.ts`（OAuth 在 `packages/ai/src/registry/oauth/gitlab-duo.ts`），而 `gitlab-duo-agent` 在 `packages/ai/src/providers/gitlab-duo-workflow.ts`、`packages/ai/src/registry/gitlab-duo-workflow.ts`（OAuth 在 `packages/ai/src/registry/oauth/gitlab-duo-workflow.ts`）和 `packages/catalog/src/discovery/gitlab-duo-workflow.ts` 中的目录发现中实现。

### 特殊情况
- **`gitlab-duo` 模型路由与代理**：在 `packages/ai/src/providers/gitlab-duo.ts` 的 `MODEL_MAPPINGS` 中将 Duo 模型标识符（`duo-chat-opus-4-6`、`duo-chat-sonnet-4-6`、`duo-chat-gpt-5-1`、`duo-chat-gpt-5-codex` 等）映射到底层提供商类型（`anthropic` 或 `openai`）和 API 风格（`anthropic-messages`、`openai-completions`、`openai-responses`）。请求被代理到 GitLab AI Gateway 端点（`https://cloud.gitlab.com/ai/v1/proxy/anthropic/` 或 `https://cloud.gitlab.com/ai/v1/proxy/openai/v1`），使用通过 `getDirectAccessToken` 交换的直接访问令牌。
- **`gitlab-duo-agent` ChatML 目标生成**：将 OMP 对话历史（`context.messages`）转换为单个扁平化的渲染 ChatML 提示字符串（`packages/ai/src/providers/gitlab-duo-workflow.ts` 中的 `buildGitLabDuoWorkflowGoal`、`renderGitLabDuoWorkflowChatMl`、`buildGitLabDuoWorkflowInlineFlowConfig`）。由 `gitlab-duo-workflow-chatml-note.md` 中的系统提示说明指导。
- **`gitlab-duo-agent` 内联流规范**：发送环境内联工作流定义（`buildGitLabDuoWorkflowInlineFlowConfig`），其中包含名为 `"omp_agent"` 的 `AgentComponent`，在其模板中携带 OMP 的系统提示，用户模板 `{{goal}}`，以及 UI 日志事件（`on_agent_reasoning`、`on_agent_final_answer`、`on_tool_execution_success`、`on_tool_execution_failed`）。
- **`gitlab-duo-agent` 字节预算与溢出**：强制目标字节限制（`GITLAB_DUO_WORKFLOW_GOAL_SOFT_OVERFLOW_BYTES` = 1MB，`GITLAB_DUO_WORKFLOW_GOAL_HARD_OVERFLOW_BYTES` = 2MB）。超出限制的目标会触发溢出错误消息（`buildGitLabDuoWorkflowGoalOverflowMessage`），在会话循环中驱动自动上下文压缩。
- **`gitlab-duo-agent` 工具执行协议**：将 OMP 工具映射到 MCP 工具定义（`buildGitLabDuoWorkflowMcpTools`、`GitLabMcpToolDefinition`），在 `startRequest.mcpTools` 中发送。通过 WebSocket 接收的工具调用请求（`runMCPTool`、`run_mcp_tool`）被提取（`extractGitLabDuoWorkflowAction`），分派到 OMP 工具执行（`mapGitLabDuoWorkflowActionToOmpTool`、`emitGitLabDuoWorkflowActionToolCall`），并通过 `buildGitLabDuoWorkflowActionResponse` 返回。
- **`gitlab-duo-agent` 命名空间设置自动启用**：REST 设置例程调用 `ensureGitLabDuoWorkflowSettings` 将 `buildGitLabDuoWorkflowSettingsBody` POST 到 `/api/v4/ai/duo_workflows/settings` 以启用所需的命名空间标志（`duo_workflow`、`duo_workflow_service`、`duo_agent_platform`）。

### 流行为
- **`gitlab-duo` 委托流式传输**：在 `streamGitLabDuo`（`packages/ai/src/providers/gitlab-duo.ts`）中直接调用 `streamAnthropic`、`streamOpenAICompletions` 或 `streamOpenAIResponses`，在注入直接访问标头（`Authorization: Bearer <direct_access_token>`）后逐字传递底层 SSE 事件。
- **`gitlab-duo-agent` WebSocket 代理循环**：通过 WebSocket（`wss://<instance>/api/v4/ai/duo_workflows/ws` 或 DWS runway 主机 `buildGitLabDuoWorkflowWebSocketUrl`）连接。接收由 `parseGitLabDuoWorkflowSocketData` 解析并在 `runGitLabDuoWorkflowSocket`（`packages/ai/src/providers/gitlab-duo-workflow.ts`）中处理的原始 JSON 事件。
- **`gitlab-duo-agent` 事件处理与推理**：提取工作流检查点（`extractGitLabDuoWorkflowCheckpoint`），发出从 `on_agent_reasoning` UI 日志事件派生的增量文本（`emitGitLabDuoWorkflowText`）和思维链推理（`emitGitLabDuoWorkflowThinking`）。
- **`gitlab-duo-agent` 批准与完成信号**：监视工作流批准状态（`isGitLabWorkflowApprovalStatus`：`PLAN_APPROVAL_REQUIRED`、`TOOL_CALL_APPROVAL_REQUIRED`）和完成状态（`isGitLabWorkflowCompletionStatus`：`INPUT_REQUIRED`、`FINISHED`）。
- **`gitlab-duo-agent` 超时与健康截止时间**：在 WebSocket 上实现 90 秒空闲截止时间（`GITLAB_DUO_WORKFLOW_IDLE_TIMEOUT_MS`）。套接字不活动会触发中止并在现有 `workflowID` 上恢复。REST 设置调用受 30 秒超时（`GITLAB_DUO_WORKFLOW_REST_TIMEOUT_MS`）限制。
- **`gitlab-duo-agent` 有界重启**：
  - 步骤限制超出：当服务器报告最大步骤限制（`isGitLabDuoWorkflowStepLimitMessage`）时，在新工作流上最多 4 次重启（`GITLAB_DUO_WORKFLOW_MAX_STEP_LIMIT_RESTARTS`）。
  - 通用错误：对于瞬态处理故障（`isGitLabDuoWorkflowGenericProcessingError`），最多 1 次重试（`GITLAB_DUO_WORKFLOW_MAX_GENERIC_ERROR_RETRIES`）。
  - 停滞检测：当 `detectGitLabDuoWorkflowStall` 在工具边界（`lastToolBoundaryContentLength`）检测到连续未更改的检查点内容长度时，最多 2 次重启（`GITLAB_DUO_WORKFLOW_MAX_STALL_RESTARTS`）。

### 认证与使用
- **`gitlab-duo` 身份验证**：通过 `GITLAB_TOKEN` 支持 PAT 或 OAuth（`packages/ai/src/registry/oauth/gitlab-duo.ts` 中的 `loginGitLabDuo`）。直接访问令牌通过 `POST /api/v4/ai/third_party_agents/direct_access` 配合 `DuoAgentPlatformNext: true` 获取（`packages/ai/src/providers/gitlab-duo.ts` 中的 `getDirectAccessToken`），并缓存 25 分钟（`DIRECT_ACCESS_TTL_MS`）。OAuth 使用 PKCE 和 `DEFAULT_CLIENT_ID`（可通过 `GITLAB_CLIENT_ID` / `GITLAB_REDIRECT_URI` 覆盖）以及回调端口 8080（`packages/ai/src/registry/gitlab-duo.ts`）。
- **`gitlab-duo-agent` 身份验证**：通过 `GITLAB_TOKEN` 接受 PAT 或 OAuth（`packages/ai/src/registry/oauth/gitlab-duo-workflow.ts` 中的 `loginGitLabDuoWorkflow`）。直接访问工作流令牌通过 `POST /api/v4/ai/duo_workflows/direct_access`（`requestGitLabDuoWorkflowDirectAccess`）获取。OAuth 依赖官方 GitLab VS Code 客户端 ID（`GITLAB_DUO_WORKFLOW_OAUTH_CLIENT_ID = "36f2a70cddeb5a0889d4fd8295c241b7e9848e89cf9e599d0eed2d8e5350fbf5"`），重定向到 `vscode://gitlab.gitlab-workflow/authentication`（`pasteCodeFlow: true`）。
- **`gitlab-duo-agent` 协议标头**：请求包括 `x-gitlab-client-type: node-websocket`、`x-gitlab-language-server-version: 8.104.0`，以及由 `buildGitLabDuoWorkflowWebSocketHeaders` 构造的资源范围标头（`x-gitlab-project-id`、`x-gitlab-namespace-id`、`x-gitlab-root-namespace-id`）。
- **使用跟踪**：两个提供商都不使用 `packages/ai/src/usage/` 下的模块。对于 `gitlab-duo-agent`，从服务器检查点遥测中提取上下文占用（`extractGitLabDuoWorkflowContextUsage` 读取 `agent_context_usage`），优先考虑 `"Chat Agent"` 和 `"context_builder"` 条目，并应用于 `applyGitLabDuoWorkflowContextUsage` 中的提示令牌估计。

### 目录模型处理
- **提供商描述符**：在 `packages/catalog/src/provider-models/descriptors.ts` 中定义：
  - `gitlab-duo`：默认模型 `duo-chat-opus-4-6`，`envVars: ["GITLAB_TOKEN"]`。通过 `getGitLabDuoModels()` 静态构建模型。
  - `gitlab-duo-agent`：默认模型 `claude_sonnet_4_6_vertex`，`envVars: ["GITLAB_TOKEN"]`，`dynamicModelsAuthoritative: true`，通过 `packages/catalog/src/provider-models/special.ts` 中的 `gitLabDuoWorkflowModelManagerOptions` 构建管理器选项。
- **命名空间自动发现**：`discoverGitLabDuoWorkflowNamespace`（`packages/catalog/src/discovery/gitlab-duo-workflow.ts`）从显式覆盖、配置或工作区 Git 远程（`discoverGitLabDuoWorkflowProject`）定位根命名空间。通过 GraphQL 查询 `aiChatAvailableModels(rootNamespaceId:)`（`fetchGitLabDuoWorkflowModels`）发现模型。
- **上下文窗口解析**：`packages/catalog/src/discovery/gitlab-duo-workflow.ts` 中的 `resolveGitLabDuoWorkflowContextWindow` 从模型引用中推断上下文窗口大小（Claude Opus/Sonnet：1,000,000；Haiku：200,000；GPT-5：400,000；默认：200,000）。
- **缓存分区**：`gitLabDuoWorkflowModelCacheProviderId`（`packages/catalog/src/provider-models/special.ts`）通过对 `apiKey`、`baseUrl`、`namespaceId`、`projectId` 和工作区 `cwd` 进行哈希来分区动态目录缓存键。
- **目录生成规则**：`scripts/generate-models.ts` 从静态生成发现中排除 `gitlab-duo-agent`，以防止将单账户命名空间模型捆绑到静态目录中，仅将 `buildGitLabDuoWorkflowFallbackModel` 捆绑为通用回退种子。

## Pi Native
Pi Native 是一种无损的内部服务器/客户端传输协议，当 pi-ai 客户端（例如容器化 `omp` 或 sidecar 代理插槽）将请求执行委托给持有真实提供商凭证的 `omp auth-gateway` 时使用。当 `Model` 设置 `transport: "pi-native"` 时激活，`packages/ai/src/stream.ts` 中的 `streamSimple` 短路本地提供商解析，并将规范 `Context` 直接 POST 到 `/v1/pi/stream`。主要入口模块是客户端上的 `packages/ai/src/providers/pi-native-client.ts`（`streamPiNative`），线路帧端的 `packages/ai/src/providers/pi-native-server.ts`（`parseRequest`、`encodeStream`、`formatError`），以及服务器端的 `packages/ai/src/auth-gateway/server.ts`（`POST /v1/pi/stream` 路由处理程序）。

### 特殊情况
- **无损直通与方言不存在**：与 OpenAI/Anthropic 路由不同，`pi-native` 不是文本工具调用方言（`docs/toolconv/pi-native.md`）。工具调用保留为 `Context` 和 `AssistantMessageEvent` 内的规范 pi-ai `ToolCall` 内容块。它保留一流的 pi-ai 字段（服务层、缓存标记、思考预算、工具选择变体、图像块、工具调用 ID），无需外部线路量化。
- **线路请求与最小边界验证**：客户端将 `{ modelId: "${provider}/${id}", context, options, stream: true }` POST 到 `${model.baseUrl}/v1/pi/stream`（`packages/ai/src/providers/pi-native-client.ts` `resolveStreamUrl`）。`packages/ai/src/providers/pi-native-server.ts` `parseRequest` 接受 `modelId`、`model.id` 或字符串 `model`（支持 `streamProxy` 目标交换）。验证仅检查对象形状和数组（`context.messages`、可选的 `context.systemPrompt`、`context.tools`），将消息/工具内部保持未验证状态，直到下游提供商执行。
- **选项允许列表与非线路键剥离**：服务器在 `packages/ai/src/providers/pi-native-server.ts` `parseRequest` 中根据 `ALLOWED_OPTION_KEYS`（31 个键）过滤 `options`，静默丢弃未知键以实现跨版本兼容性。客户端通过 `packages/ai/src/providers/pi-native-client.ts` `buildWireOptions` 中的 `NON_WIRE_KEYS` 剥离仅运行时和函数值的字段（`signal`、`apiKey`、`fetch`、`onPayload`、`onResponse`、`onSseEvent`、`execHandlers`、`cursorExecHandlers`、`cursorOnToolResult`、`providerSessionState`）。
- **网关选项修改**：在 auth-gateway（`packages/ai/src/auth-gateway/server.ts`）上，为 `openai-codex-responses` 模型剥离采样控制（`temperature`、`topP`、`topK`、`minP`、`stopSequences`、`penalties`）以防止 400 错误，并捕获直通请求标头（`captureRequestHeaders`）并合并到客户端标头下。
- **调度优先级与缓存绕过**：在 `packages/ai/src/stream.ts` `streamSimple` 中，`model.transport === "pi-native"` 优先于扩展注册的自定义 API（`getCustomApi`）。`packages/ai/src/stream.ts` `assertExplicitOpenAIResponsesPromptCacheSupport` 显式绕过 `pi-native` 传输的提示缓存断言，因为验证被推迟到网关解析的模型。

### 流行为
- **逐字 SSE 帧**：服务器的 `encodeStream`（`packages/ai/src/providers/pi-native-server.ts`）将每个规范 `AssistantMessageEvent` 逐字流式传输为 JSON 序列化的 SSE 帧（`data: ${JSON.stringify(event)}\n\n`），以 `data: [DONE]\n\n` 终止。客户端（`packages/ai/src/providers/pi-native-client.ts` `streamPiNative`）使用 `readSseJson` 并将事件直接推送到 `AssistantMessageEventStream`。
- **二次部分帧**：Delta 事件包括滚动的 `partial: AssistantMessage` 快照，使线路带宽相对于轮次长度为 O(N²)。对于提供商延迟占主导地位的回环/边车拓扑，接受此开销。
- **空闲与首事件看门狗**：客户端使用 `PI_STREAM_FIRST_EVENT_TIMEOUT_MS` 和 `PI_STREAM_IDLE_TIMEOUT_MS` 通过 `iterateWithIdleTimeout` 包装 SSE 流。`packages/ai/src/providers/pi-native-client.ts` 中的 `isPiNativeProgressEvent` 忽略 `type: "start"` 事件，因此初始设置不会重置空闲超时。
- **合成终端边界**：如果 SSE 流在没有 `done` 或 `error` 事件的情况下关闭，客户端的 `streamPiNative` 通过 `makeSyntheticAssistant` 构造合成助手消息。如果调用者中止，它会推送 `{ type: "error", reason: "aborted", error: { ..., stopReason: "aborted", errorMessage: "stream closed without terminal event" } }`，或者在不优雅的干净关闭时推送 `{ type: "done", reason: "stop", message: { ..., stopReason: "stop" } }`。
- **服务器迭代器异常回退**：如果服务器的 `encodeStream` 事件迭代器抛出异常，它会排队 `data: {"type":"error","reason":"error","errorMessage":"..."}\n\n` 后跟 `data: [DONE]\n\n`，以便客户端迭代器解析而不是挂起。
- **思考循环保护**：`packages/ai/src/stream.ts` `streamSimple` 使用 `withThinkingLoopGuard` 和 `withProviderInFlightLimit` 包装 `streamPiNative`，确保 Gemini、DeepSeek 和 Grok 失控的思考流以空内容可重试错误中止。

### 认证与使用
- **Bearer 令牌授权**：客户端（`packages/ai/src/providers/pi-native-client.ts` `buildHeaders`）在 `Authorization: Bearer <apiKey>` 中传递 `options.apiKey`（网关 bearer 令牌），除非明确提供 `model.headers.Authorization`。
- **网关凭证解析**：服务器路由处理程序（`packages/ai/src/auth-gateway/server.ts`）首先验证网关 bearer。缺失/无效的令牌通过 `packages/ai/src/providers/pi-native-server.ts` `formatError` 返回 `401`。有效请求实例化 `buildGatewayApiKeyResolver` 以使用 `sessionId`/`promptCacheKey` 和格式 `"pi-native"` 从 `AuthStorage` 获取目标提供商凭证。
- **错误信封与网关映射**：服务器通过 `formatError` 发出错误，格式为 `{ error: { type, message } }`，具有 HTTP 状态、`application/json` 和 `Cache-Control: no-store`。客户端的 `decodeGatewayError` 将非 2xx 响应转换为 `AIError.AuthGatewayError`，保留 HTTP 状态、标头和错误 `type`。
- **使用与标头跟踪**：令牌使用（`input`、`output`、`cacheRead`、`cacheWrite`、`cost`）直接携带在规范 `AssistantMessage` 事件中。客户端通过 `notifyProviderResponse` 通知响应元数据（`x-request-id`、标头）。

### 目录模型处理
- **无目录提供商条目**：`pi-native` 不是 `packages/catalog` 中的提供商（在 `descriptors.ts` `CATALOG_PROVIDERS`、`src/provider-models/*`、`src/identity/classify.ts`、`src/model-thinking.ts` 和 `scripts/generate-models.ts` 中不存在）。
- **传输覆盖属性**：仅在 `packages/catalog/src/types.ts` 的 `Model` 接口上定义为 `transport?: "pi-native"`。
- **本地目录解析**：元数据（定价、上下文窗口、最大令牌、`ThinkingConfig` 中的思考配置、功能标志、提供商优先级）从目录模型定义（例如 `anthropic/claude-3-5-sonnet`）本地解析，而执行调度路由到网关 `baseUrl`。

---

# 目录提供商

每个 `CATALOG_PROVIDERS` 条目（`packages/catalog/src/provider-models/descriptors.ts`）如果不是传输本身，则按提供商 ID 字母顺序排列，每个部分一个提供商。这些提供商使用上面记录的一种传输；每个部分仅涵盖提供商在传输之上添加的内容：特殊情况、身份验证和使用/配额跟踪以及目录布线。ID 本身就是传输的提供商（anthropic、openai、openai-codex、azure、google、google-vertex、amazon-bedrock、bedrock-mantle、cursor、devin）在前半部分的传输部分中介绍。共享引擎提供商（google-gemini-cli、google-antigravity、gitlab-duo、gitlab-duo-agent、kimi-code、moonshot、ollama、ollama-cloud）两者都获得：上面的引擎机制，下面的每个 ID 身份验证/使用/目录布线。

## ai& (`aiand`)
ai& (`aiand`) 是一个 OpenAI 兼容的推理 API 提供商（aiand.com），提供开放权重和旗舰 LLM，具有动态模型目录发现、推理 effort 元数据和令牌使用定价。传输：OpenAI Chat Completions。

### 特殊情况
- **Base URL 标准化**：`packages/catalog/src/provider-models/openai-compat.ts` 中的 `normalizeAiandBaseUrl` 修剪 base URL，默认为 `https://api.aiand.com/v1`，去除尾部斜杠，如果省略则附加 `/v1`。除了 OpenAI Chat Completions 管道之外没有任何内容。

### 认证与使用
- **API 密钥身份验证**：支持通过 `AIAND_API_KEY` 环境变量配置 API 密钥身份验证（通过 `packages/ai/src/stream.ts` 中的 `getEnvApiKey("aiand")` 解析）或显式 `apiKey` 选项。
- **控制台登录与验证**：交互式登录（`packages/ai/src/registry/aiand.ts` 中的 `loginAiand`）从 `https://console.aiand.com/api-keys` 提示输入 API 密钥，并通过 `createApiKeyLogin` 针对 `https://api.aiand.com/v1/models` 验证凭证。在 `packages/ai/src/registry/registry.ts` 中注册为 `aiandProvider`。

### 目录模型处理
- **提供商描述符**：在 `packages/catalog/src/provider-models/descriptors.ts` 中注册，使用 `defaultModel: "moonshotai/kimi-k2.7-code"`、`envVars: ["AIAND_API_KEY"]` 和 `dynamicModelsAuthoritative: true`。
- **静态种子模型**：`packages/catalog/src/provider-models/openai-compat.ts` 中的 `AIAND_STATIC_MODELS` 提供 9 个捆绑的离线模型规范（`qwen/qwen3.6-27b`、`deepseek-ai/deepseek-v4-flash`、`google/gemma-4-31b-it`、`openai/gpt-oss-120b`、`deepseek-ai/deepseek-v4-pro`、`moonshotai/kimi-k2.7-code`、`moonshotai/kimi-k2.6`、`zai-org/glm-5.2`、`zai-org/glm-5.1`），通过 `createAiandStaticModel` 创建，具有 effort 推理阶梯（`[low, medium, high]`，默认为 `medium`）。当禁用权威在线目录生成时，种子模型在 `scripts/generate-models.ts` 中推送。
- **权威发现**：`packages/catalog/src/provider-models/openai-compat.ts` 中的 `aiandModelManagerOptions` 设置 `dynamicModelsAuthoritative: true` 并通过 `dropCachedModelIdsOnStaticMismatch: AIAND_STATIC_MODEL_IDS` 使静态 ID 失效。当提供 `apiKey` 时，`fetchDynamicModels` 使用 `fetchOpenAICompatibleModels` 和 `mapAiandModel` 查询 `/v1/models`。
- **思考配置（`mapAiandThinking`）**：`mapAiandThinking` 通过 `AIAND_EFFORT_BY_WIRE_VALUE`（`minimal`、`low`、`medium`、`high`、`xhigh`、`max`）将线路字符串数组 `reasoning_efforts` 转换为 pi `Effort` 级别，并在有效时从 `reasoning_effort_default` 设置 `defaultLevel`。如果 effort 为空，则返回 `undefined`。
- **成本映射（`mapAiandCost`）**：`mapAiandCost` 通过 `toPositiveNumber` 提取 `input_per_1m` 和 `output_per_1m` USD 令牌价格。非 USD 组织计费货币（例如 `currency !== "usd"`）回退到 `{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }` 以避免成本模型损坏。
- **模型属性映射（`mapAiandModel`）**：`mapAiandModel` 映射模型描述或名称（`toModelName`），检查 `capabilities` 中的 `"reasoning"`（附加 `thinking`）和 `"vision"`（设置 `input: ["text", "image"]`），并解析 `context_window`。

## AIML API (`aimlapi`)
AIML API 是一个 AI 模型聚合器平台，通过统一的 OpenAI 兼容端点提供对各种多供应商模型的访问。它使用 OpenAI Chat Completions（`openai-completions`）传输管道。

### 特殊情况
- **非聊天模型过滤**：动态模型列表通过 `packages/catalog/src/provider-models/openai-compat.ts` 中的 `isLikelyAimlApiChatModelId` 进行过滤，排除由正则表达式 `/(?:^|[/:._-])(?:audio|embed|embedding|embeddings|i2i|i2v|image|speech|t2i|t2v|tts|video)(?:$|[/:._-])/i` 或子字符串（`dall-e`、`dalle`、`flux`、`imagen`、`sora`、`veo`、`whisper`）匹配的音频、嵌入、图像、视频和 TTS 模型。
- **标准传输管道**：使用未自定义的 `openai-completions` 传输，没有自定义请求转换器或错误处理程序（`packages/catalog/src/provider-models/openai-compat.ts`）。

### 认证与使用
- **环境身份验证**：配置为通过 `AIMLAPI_API_KEY` 环境变量（`packages/catalog/src/provider-models/descriptors.ts`、`packages/ai/src/registry/aimlapi.ts`）发现凭证。
- **API 授权**：将密钥作为 HTTP `Authorization: Bearer <key>` 标头传输到目标主机 `https://api.aimlapi.com/v1`。
- **使用跟踪**：在 `packages/ai/src/usage/` 中没有注册专门的配额或使用解析模块。

### 目录模型处理
- **描述符注册**：在 `PROVIDER_DESCRIPTORS` 中定义，使用 `defaultModel: "gpt-5.5-2026-04-23"`、`dynamicModelsAuthoritative: true` 和标签 `"AIML API"`（`packages/catalog/src/provider-models/descriptors.ts`）。
- **动态发现**：通过 `packages/catalog/src/provider-models/openai-compat.ts` 中的 `aimlApiModelManagerOptions()` 管理，该方法获取 `https://api.aimlapi.com/v1/models` 并通过 `filterModel`（`isLikelyAimlApiChatModelId`）和 `mapWithBundledReference` 映射候选项。
- **规范解析**：多供应商命名空间模型（例如 `alibaba/qwen3-32b`、`x-ai/grok-4-3`）通过 `buildModelProviderPriorityRank` 解析规范参数默认值，其中 `aimlapi` 参与跨提供商身份查找（`packages/catalog/src/identity/priority.ts`、`packages/catalog/test/canonical-limit-fallback.test.ts`）。

## Alibaba Coding Plan (`alibaba-coding-plan`)
Alibaba Coding Plan 提供托管在阿里云 DashScope 平台上的面向代码的模型端点。它使用 `OpenAI Chat Completions` 传输（`openai-completions`）连接到国际（`https://coding-intl.dashscope.aliyuncs.com/v1`）或中国大陆（`https://coding.dashscope.aliyuncs.com/v1`）端点。

### 特殊情况
- **结构化 API 密钥解析**：在 `packages/ai/src/providers/openai-shared.ts` 中，当启用 `alibabaCodingPlanAuth`（`packages/ai/src/providers/openai-completions.ts`）时，JSON 格式的 API 密钥（由登录/OAuth 存储发出）被解析以提取 bearer `token` 并通过 `enterpriseUrl` 覆盖 `baseUrl`。
- **低优先级选择**：包含在 `packages/catalog/src/identity/priority.ts` 的 `LOW_PRIORITY_PROVIDERS` 中，防止 `alibaba-coding-plan` 模型在主要提供商上赢得模糊的自动角色选择。
- **主机分类**：在 `packages/catalog/src/hosts.ts`（`urlMarkers: ["dashscope", "token-plan."]`）的 `alibabaDashscope` 主机条目下分组。
- **OAuth 结构化密钥标志**：在 `needsStructuredApiKey`（`packages/ai/src/registry/oauth/index.ts`）中注册，以将端点和令牌元数据（`enterpriseUrl`、`access`、`refresh`、`expires`）序列化为 JSON 密钥字符串。

### 认证与使用
- **交互式登录与端点选择**：`loginAlibabaCodingPlan`（`packages/ai/src/registry/alibaba-coding-plan.ts`）提示用户在 International（`https://coding-intl.dashscope.aliyuncs.com/v1`）、Mainland China（`https://coding.dashscope.aliyuncs.com/v1`）或自定义代理 base URL 之间进行选择。
- **API 密钥验证**：通过 `apiKeyValidation.validateOpenAICompatibleApiKey` 针对预设端点的模型 `qwen3.5-plus` 验证凭证，或针对自定义 URL 的 `validateApiKeyAgainstModelsEndpoint`（`packages/ai/src/registry/alibaba-coding-plan.ts`）。
- **环境变量**：API 密钥通过 `ALIBABA_CODING_PLAN_API_KEY`（`packages/catalog/src/provider-models/descriptors.ts`）检索。
- **使用与配额跟踪**：与 `alibaba-token-plan` 不同，`alibaba-coding-plan` 在 `packages/ai/src/usage/` 中没有专门的使用提供商或配额跟踪。

### 目录模型处理
- **模型管理器选项**：`packages/catalog/src/provider-models/openai-compat.ts` 中的 `alibabaCodingPlanModelManagerOptions` 通过配置为 `providerId: "alibaba-coding-plan"`、`defaultBaseUrl: "https://coding-intl.dashscope.aliyuncs.com/v1"` 和 `mapWithBundledReference` 的 `createOpenAICompatibleModelManagerOptions` 创建管理器选项。
- **描述符和默认值**：注册的描述符（`packages/catalog/src/provider-models/descriptors.ts`）设置 `defaultModel: "qwen3.7-plus"`。
- **模型来源**：模型规范捆绑在 `packages/catalog/src/models.json` 的 `"alibaba-coding-plan"` 下。

### 流行为
- **扩展流空闲超时**：将 `streamIdleTimeoutMs` 设置为 600,000 毫秒（`packages/catalog/src/compat/openai.ts` 中的 `ALIBABA_CODING_PLAN_STREAM_IDLE_TIMEOUT_MS = 600_000`），以防止在第一个 SSE 事件之前的长时间初始生成延迟期间过早中止流看门狗。

## QwenCloud Token Plan (`alibaba-token-plan`)
QwenCloud Token Plan 提供对阿里云 Qwen 和 DeepSeek 模型套件的模型订阅访问。它使用 OpenAI Chat Completions 传输（`openai-completions` API schema）通过 HTTP POST JSON 和 Server-Sent Events（SSE）流式传输（`packages/ai/src/providers/openai-shared.ts`）进行操作。

### 特殊情况
- **显式凭证隔离**：`packages/ai/src/providers/openai-shared.ts` 中的 `resolveOpenAIRequestSetup` 需要显式的 `ALIBABA_TOKEN_PLAN_API_KEY` 或 `BAILIAN_TOKEN_PLAN_API_KEY` 凭证，并显式禁用通用的 `$env.OPENAI_API_KEY` 回退，以防止密钥泄漏到 QwenCloud 端点。
- **区域 Base URL 路由**：凭证支持区域锁定端点：International Singapore（`ALIBABA_TOKEN_PLAN_BASE_URL` = `https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1`）和 China Beijing（`ALIBABA_TOKEN_PLAN_CN_BASE_URL` = `https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1`）。区域密钥不可互换；存储的 `baseUrl` 覆盖推理和模型发现的目录默认值（`packages/catalog/src/provider-models/openai-compat.ts`）。
- **存储去重**：`packages/ai/src/auth/sqlite-credential-store.ts` 中的 `hasAuthCredentialForProvider` 解析 JSON 复合凭证（`parseAlibabaTokenPlanCredential`）以比较内部 `token` 字符串而不是原始 JSON 文本。

### 认证与使用
- **环境与线路凭证**：解析 `ALIBABA_TOKEN_PLAN_API_KEY` 然后是 `BAILIAN_TOKEN_PLAN_API_KEY`。支持普通 bearer 密钥（`sk-sp-...`）或通过 `parseAlibabaTokenPlanCredential` 解析并通过 `serializeAlibabaTokenPlanCredential` 格式化的序列化 JSON 字符串（`{ token, cookie?, baseUrl? }`）（`packages/catalog/src/wire/alibaba-token-plan.ts`）。
- **交互式登录**：`loginAlibabaTokenPlan`（`packages/ai/src/registry/alibaba-token-plan.ts`）提示选择区域（1=International，2=China Beijing，3=Custom URL），通过 `${baseUrl}/models`（`validateApiKeyAgainstModelsEndpoint`）验证 API 密钥，并接受可选的 `cs-data.qwencloud.com` 浏览器 `Cookie` 标头用于配额报告。
- **控制台配额抓取**：`packages/ai/src/usage/alibaba-token-plan.ts` 中的 `alibabaTokenPlanUsageProvider` 使用存储的 `Cookie` 标头从 `https://home.qwencloud.com/tool/user/info.json` 获取 `secToken`，并向 `https://cs-data.qwencloud.com/data/api.json?product=sfm_bailian&action=IntlBroadScopeAspnGateway&api=zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/usage` 发出带有 URL 编码参数的 POST。
- **配额窗口与排名**：解析 `per5HourPercentage`/`per5HourResetTime`（5 小时窗口，`credits:5h`）和 `per1WeekPercentage`/`per1WeekResetTime`（7 天窗口，`credits:7d`）。`alibabaTokenPlanRankingStrategy` 将 `credits:5h` 配置为主限制（5h 窗口），将 `credits:7d` 配置为次要限制（7d 窗口）。

### 目录模型处理
- **权威发现**：使用 `dynamicModelsAuthoritative: true`（`packages/catalog/src/provider-models/descriptors.ts`）配置。`/models` 发现是订阅范围的；成功的端点响应是权威的，即使为空也会覆盖静态回退目录（`packages/catalog/scripts/generate-models.ts`）。
- **发现过滤与覆盖**：`packages/catalog/src/provider-models/openai-compat.ts` 中的 `isAlibabaTokenPlanChatModelId` 过滤非聊天前缀（`qwen-audio-`、`qwen-image-`、`text-embedding-`、`wan2.7-`）。发现的 `deepseek-v4*` 模型使用 `reasoning: true` 和 effort 思考（`[Effort.High, Effort.Max]`）映射。
- **静态目录回退**：`ALIBABA_TOKEN_PLAN_STATIC_MODELS` 在无凭证或发现失败时提供静态目录种子回退（`packages/catalog/scripts/generate-models.ts`）。

## Baseten (`baseten`)
Baseten 为托管开放权重 LLM（包括 Moonshot Kimi、DeepSeek、Zhipu GLM 和 gpt-oss 系列）提供高性能基础设施。请求通过 OpenAI Chat Completions 传输（`openai-completions` API）执行，面向默认 base URL `https://inference.baseten.co/v1`。

### 特殊情况
- 除了 `openai-completions` 管道之外没有任何内容。

### 认证与使用
- **API 密钥身份验证**：通过 `BASETEN_API_KEY`（`packages/catalog/src/provider-models/descriptors.ts`）进行身份验证。登录流 `loginBaseten`（`packages/ai/src/registry/baseten.ts`）使用 `createApiKeyLogin` 指向仪表板 `https://app.baseten.co/settings/api_keys`，占位符为 `bt_...`。
- **端点验证**：`loginBaseten`（`packages/ai/src/registry/baseten.ts`）中的 API 密钥验证通过 `GET https://inference.baseten.co/v1/models`（`models-endpoint` 验证类型）验证凭证。
- **使用核算**：通过标准 OpenAI Chat Completions 使用处理（`packages/ai/src/providers/openai-shared.ts` 中的 `calculateOpenAIUsageAccounting`）协调令牌使用和定价。

### 目录模型处理
- **提供商描述符**：在 `CATALOG_PROVIDERS`（`packages/catalog/src/provider-models/descriptors.ts`）中注册，使用 `id: "baseten"`、`defaultModel: "moonshotai/Kimi-K2.7-Code"`、`envVars: ["BASETEN_API_KEY"]`、`dynamicModelsAuthoritative: true` 和发现标签 `"Baseten"`。
- **模型管理器选项**：`packages/catalog/src/provider-models/openai-compat.ts` 中的 `basetenModelManagerOptions` 使用 `defaultBaseUrl: "https://inference.baseten.co/v1"` 和 `requireApiKey: true` 配置模型解析。
- **动态模型发现与定价**：`fetchDynamicModels` 查询 `https://inference.baseten.co/v1/models`。`mapModel` 解析原始记录元数据，包括 `supported_features`、`input_modalities`（视觉功能的 `image`）、上下文和补全令牌边界（`context_length`、`max_completion_tokens`），以及每百万令牌定价（`prompt`、`completion`、`input_cache_read`）。
- **原生推理识别**：当动态功能列出 `reasoning` 或 `reasoning_effort` 时，为 `openai/gpt-oss-120b`、`deepseek-ai/DeepSeek-V4-Pro` 和 `zai-org/GLM-5.2` 标记 `reasoning: true`。
- **推理 Effort 层级限制**：`packages/catalog/src/model-thinking.ts` 中的 `getModelDefinedEfforts` 和 `packages/catalog/src/provider-models/openai-compat.ts` 中的 `basetenModelManagerOptions` 将 `zai-org/GLM-5.2`（`isGlm52ReasoningEffortModelId`）和 `openai/gpt-oss-120b`（`isOpenAIGptOssModelId`）路由的推理 effort 层级限制为两级 `HIGH_MAX_REASONING_EFFORTS` 规模（`[high, max]`）。
- **身份优先级与主机匹配**：在 `packages/catalog/src/identity/priority.ts` 的 `PROVIDER_PRIORITY` 中优先，并通过 `packages/catalog/src/hosts.ts` 中的 URL 标记 `baseten.co` 匹配。

## Cerebras (`cerebras`)
Cerebras 在晶圆级引擎硬件上为开源权重模型（如 `zai-glm-4.7`、`gpt-oss-120b`、`qwen-3-235b-a22b-instruct-2507` 和 `gemma-4-31b`）提供超快速推理。它通过 OpenAI Chat Completions (`openai-completions`) 传输协议进行通信。

### 特殊情况处理
- **`all_strict` 工具模式**：Cerebras 在 `packages/catalog/src/compat/openai.ts`（`isCerebras`）中将 `toolStrictMode` 默认为 `"all_strict"`，在 `openai-completions.ts`（`AppliedToolStrictMode`）中强制所有传入的工具 schema 设置 `strict: true`。
- **`supportsUsageInStreaming: false`**：通过 `packages/catalog/src/compat/openai.ts` 中的 `supportsUsageInStreaming: !isCerebras` 进行配置，以在 `openai-completions.ts` 中抑制 `stream_options: { include_usage: true }`，防止流式响应时出现 API 拒绝。
- **空 400/413 上下文溢出检测**：Cerebras 上下文和负载溢出错误返回空的 HTTP 400 或 413 响应体。在 `packages/ai/src/error/flags.ts` 中通过 `OVERFLOW_NO_BODY_PATTERN`（`/\b4(00|13)\s*(status code)?\s*\(no body\)/i`）识别，允许 `isContextOverflow` 设置 `Flag.ContextOverflow`，以便 agent 会话自动压缩上下文而不是以失败终止。
- **Gemma 图像输入序列化**：匹配 `gemma-4-31b` 的模型在 `packages/ai/src/providers/openai-completions.ts` 中的 `convertMessages` 处理时，会将附加的图像块序列化为 Chat Completions `image_url` 数据 URI（`data:image/png;base64,...`）。

### 认证与使用
- **API 密钥登录**：通过 `packages/ai/src/registry/cerebras.ts` 中的 `loginCerebras` 进行配置，使用 `createApiKeyLogin`，默认验证模型为 `gpt-oss-120b`，基础 URL 为 `https://api.cerebras.ai/v1`。
- **环境解析**：在 `packages/ai/src/registry/cerebras.ts` 中注册为 `cerebrasProvider`，在 `descriptors.ts` 中使用环境变量 `CEREBRAS_API_KEY` 作为目录描述符。

### 目录模型处理
- **提供商注册**：`descriptors.ts`（`CATALOG_PROVIDERS`）中的目录条目设置 `id: "cerebras"`、`defaultModel: "zai-glm-4.7"`，并将选项构建委托给 `cerebrasModelManagerOptions`。
- **管理器选项与发现**：`packages/catalog/src/provider-models/openai-compat.ts` 中的 `cerebrasModelManagerOptions` 使用 `createOpenAICompatibleModelManagerOptions`，设置 `providerId: "cerebras"` 和默认基础 URL `https://api.cerebras.ai/v1`。
- **Gemma 图像能力覆盖**：`packages/catalog/src/provider-models/openai-compat.ts` 中的 `applyCerebrasDiscoveryOverrides` 在模型映射期间检查 `CEREBRAS_IMAGE_INPUT_MODEL_IDS`（`Set(["gemma-4-31b"])`），以将 `"image"` 显式附加到 `input` 能力（`input: ["text", "image"]`），覆盖远程端点发现元数据中缺失的视觉能力标志。

## Cloudflare AI Gateway (`cloudflare-ai-gateway`)
Cloudflare AI Gateway 通过 Cloudflare 的边缘基础设施将请求代理到模型提供商，使用 Anthropic Messages 传输协议。基础 URL 需要在模型配置中用用户特定的 Cloudflare 账户 ID 和网关标识替换 `<account>` 和 `<gateway>` 路径占位符。

### 特殊情况处理
- **自定义授权头**：使用 `cf-aig-authorization: Bearer <key>` 而不是标准的 `x-api-key` 或 `Authorization` 头（`packages/ai/src/providers/anthropic.ts:buildAnthropicHeaders`）。
- **抑制的客户端凭据**：在 Anthropic 客户端选项对象上将 `apiKey` 和 `authToken` 设置为 `null`，以便凭据仅通过预构建的默认头传递（`packages/ai/src/providers/anthropic.ts:3027-3037`）。
- **签名代理检测**：通过 `isCloudflareAnthropicGateway` 将匹配 `gateway.ai.cloudflare.com/.+/anthropic` 的 URL 识别为 Anthropic 签名代理（`packages/catalog/src/compat/anthropic.ts:CLOUDFLARE_ANTHROPIC_GATEWAY_URL_MARKER`、`isAnthropicSigningProxyUrl`）。
- **OAuth 会话保护**：排除在接收 Claude OAuth `account_uuid` 头之外，以防止身份泄露给第三方代理（`packages/coding-agent/src/session/session-metadata.ts`）。

### 认证与使用
- **认证提示**：`loginCloudflareAiGateway` 提示输入 Cloudflare AI Gateway 令牌/API 密钥（`cf-aig-...`），并引导用户访问 Cloudflare 的认证文档（`packages/ai/src/registry/cloudflare-ai-gateway.ts`）。
- **环境变量**：从 `CLOUDFLARE_AI_GATEWAY_API_KEY` 读取 API 密钥凭据（`packages/catalog/src/provider-models/descriptors.ts`）。
- **账户和网关解析**：使用 `https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/anthropic` 作为基础 URL 模板，其中 `<account>` 和 `<gateway>` 占位符被替换为用户的 Cloudflare 账户 ID 和网关标识（`packages/catalog/src/provider-models/openai-compat.ts:cloudflareAiGatewayModelManagerOptions`）。

### 目录模型处理
- **描述符与默认模型**：通过 `anthropicMessagesDescriptor` 连接，默认模型为 `anthropic/claude-opus-4-8`（`packages/catalog/src/provider-models/descriptors.ts`）。
- **静态回退模型**：在目录生成期间，当发现没有返回任何模型时，注入 `CLOUDFLARE_FALLBACK_MODEL`（`claude-sonnet-4-5`，启用推理，200k 上下文）（`packages/catalog/scripts/generated-policies.ts`，`packages/catalog/scripts/generate-models.ts:536-538`）。
- **优先级连接**：在 `providerPriority`（`packages/catalog/src/identity/priority.ts`）中分配目录优先级级别 39。

## CoreWeave Serverless Inference (`coreweave`)
CoreWeave Serverless Inference 在 `https://api.inference.wandb.ai/v1` 提供由 Weights & Biases (W&B) 基础设施支持的托管 AI 模型推理。它使用"OpenAI Chat Completions"传输协议运行。

### 特殊情况处理
- **项目头注入**：`packages/ai/src/providers/openai-shared.ts` 中的 `applyCoreWeaveProjectHeader` 在 `resolveOpenAIRequestSetup` 中拦截对 `coreweave` 模型的请求，并注入所需的 `OpenAI-Project` HTTP 头。头部解析由 `packages/catalog/src/wire/coreweave.ts` 中的 `resolveCoreWeaveProject` 和 `coreWeaveProjectHeaders` 处理，检查 `COREWEAVE_PROJECT`、`WANDB_INFERENCE_PROJECT` 或 `WANDB_ENTITY`/`WANDB_PROJECT`。`removeBlankCoreWeaveProjectHeaders` 删除空项目头，以允许回退到环境变量。
- **GPT-OSS 推理转换**：在 `openAiCompletionsDescriptor`（`packages/catalog/src/provider-models/openai-compat.ts`）中，以 `openai/gpt-oss-` 开头的模型被转换以设置 `reasoning: true`，并配置基于努力的思考（`Effort.Low`、`Effort.Medium`、`Effort.High`）。

### 认证与使用
- **API 密钥与环境解析**：通过 `COREWEAVE_API_KEY` 进行认证，回退到 `WANDB_API_KEY`（`descriptors.ts`，`packages/ai/src/stream.ts` 中的 `getEnvApiKey`）。
- **登录流程与项目验证**：交互式登录在 `loginCoreWeave`（`packages/ai/src/registry/coreweave.ts`）中配置，引用 `https://wandb.ai/settings` 处的设置。`requireCoreWeaveProjectHeaders` 强制要求在根据 `https://api.inference.wandb.ai/v1/models` 验证凭据之前，能够从环境变量构造有效的 `OpenAI-Project` 头。

### 目录模型处理
- **描述符配置**：在 `packages/catalog/src/provider-models/descriptors.ts` 的 `CATALOG_PROVIDERS` 中注册，ID 为 `coreweave`，默认模型为 `openai/gpt-oss-120b`，发现标签为 `"CoreWeave Serverless Inference"`。
- **模型管理器与动态发现**：`packages/catalog/src/provider-models/openai-compat.ts` 中的 `coreWeaveModelManagerOptions` 通过 `createSimpleOpenAICompletionsOptions` 为 `https://api.inference.wandb.ai/v1` 构造提供商选项，在目录模型获取时动态提供 `coreWeaveProjectHeaders(Bun.env)`。

## DeepSeek (`deepseek`)
DeepSeek 提供商使用 OpenAI Chat Completions 传输协议（`openai-completions`）直接与 DeepSeek 的 API（`https://api.deepseek.com/v1`）接口。它为官方 DeepSeek 模型（如 `deepseek-v4-pro` 和 `deepseek-v4-flash`）提供支持，实现提供商特定的推理标志、令牌剥离流过滤器、自定义提示缓存使用计费和 Bearer 清理的 API 密钥存储。

### 特殊情况处理
- **推理兼容性与 `whenThinking` 交换**：直接 DeepSeek 推理模型（`packages/catalog/src/compat/openai.ts` 中的 `isDirectDeepseekReasoning`）配置 `supportsToolChoice: false`（在推理调用上省略 `tool_choice`）和 `reasoningDisableMode: "zai-thinking-disabled"`。活动推理激活 `whenThinking` 兼容指针交换，合并 `extraBody: { thinking: { type: "enabled" } }`。设置任何 `tool_choice` 会删除推理字段（`disableReasoningOnToolChoice: true`）。参见[提供商兼容性参考](./provider-compat-reference.md)。
- **推理内容不变量**：在后续回合上重放完全相同的先前 `reasoning_content`（`requiresReasoningContentForToolCalls` 和 `requiresReasoningContentForAllAssistantTurns`），拒绝合成 `"."` 占位符（`allowsSyntheticReasoningContentForToolCalls: false`）。工具回合上的空助手内容被提升为 `"."`（`requiresAssistantContentForToolCalls: true`）。
- **聊天模板令牌剥离与修复**：`packages/ai/src/providers/openai-completions.ts` 中的 `stripDeepseekSpecialTokens` 缓冲并剥离原始流式聊天模板令牌（`<｜User｜>`、`<｜Assistant｜>` 等）。带内 DSML 工具块（`<｜DSML｜tool_calls>`）通过 `StreamMarkupHealing` 修复，模式为 `"dsml"`。
- **线路参数与流监视器**：输出令牌上限使用 `max_tokens`（`maxTokensField: "max_tokens"`）。事件间流监视器延长到 300 秒（`DEEPSEEK_REASONING_STREAM_IDLE_TIMEOUT_MS`），以允许长时间的预填充/思考延迟。为功能工具启用 `supportsStrictMode: true`。

### 认证与使用
- **API 密钥标准化与登录**：`packages/ai/src/registry/deepseek.ts` 中的 `normalizeDeepSeekApiKey` 修剪输入并剥离任何前导 `Bearer ` 前缀（不区分大小写），如果为空则抛出 `ApiKeyRequiredError`。交互式 `loginDeepSeek` 使用标准化包装 `onPrompt` 并根据 `/v1/models` 进行验证。运行时凭据依赖于 `DEEPSEEK_API_KEY`。
- **提示缓存使用计费**：DeepSeek 返回顶级使用字段 `prompt_cache_hit_tokens` 和 `prompt_cache_miss_tokens`。`calculateOpenAIUsageAccounting`（`packages/ai/src/providers/openai-shared.ts`）检测 `isDeepSeekUsage`，将净输入令牌映射到 `Math.max(0, promptTokens - cachedTokens)`（未命中计数），并将 `cacheWrite` 设置为 `0`，以避免将未缓存的提示令牌作为显式缓存写入双重收费。

### 目录模型处理
- **描述符与管理器**：`packages/catalog/src/provider-models/descriptors.ts` 中的目录条目 `deepseek` 设置 `defaultModel: "deepseek-v4-pro"`，并使用 `deepseekModelManagerOptions`（`packages/catalog/src/provider-models/openai-compat.ts`），目标为 `https://api.deepseek.com`。针对工具调用 `deepseek-v4` 模型的内置发现过滤器。
- **推理努力阶梯**：为 `deepseek-v4-pro` 配置 `HIGH_MAX_REASONING_EFFORTS`（`[high, max]`），为 `deepseek-v4-flash` 配置 `LOW_HIGH_MAX_REASONING_EFFORTS`（`[low, high, max]`）。在 DeepSeek 模型中将 `xhigh` 努力请求规范化为 `max`（`isDeepseekModelIdOrName`）。

## Fire Pass (`firepass`)
Fire Pass 是 Fireworks AI 订阅层，提供对 Kimi K2.6 Turbo 的专用高吞吐量路由器访问。它使用 OpenAI Chat Completions 传输协议（`https://api.fireworks.ai/inference/v1`），并使用 Fireworks 路由器端点转换。

### 特殊情况处理
- **线路模型 ID 转换（`wireModelIdMode: "firepass"`）**：`buildOpenAICompat`（`packages/catalog/src/compat/openai.ts`）为 `firepass` 或 Fireworks 快速路由器模型（`isFireworksFastRouter`）分配 `wireModelIdMode: "firepass"`。`applyWireModelIdTransform`（`packages/ai/src/providers/openai-shared.ts`）使用 `toFirepassWireModelId`（`packages/catalog/src/fireworks-model-id.ts`）将友好的目录 ID（例如 `kimi-k2.6-turbo`）转换为 Fireworks 路由器线路 ID（`accounts/fireworks/routers/kimi-k2p6-turbo`），方法是用 `p` 替换点。
- **最大输出令牌上限**：通过 `clampFireworksKimiMaxTokens`（`packages/catalog/src/provider-models/openai-compat.ts`）和 `applyKimiMaxTokensCap`（`packages/catalog/scripts/generate-models.ts`）将输出令牌限制为 32,768（`FIREWORKS_KIMI_MAX_TOKENS`），以防止 Kimi K2 模型上的推理跟踪失控。
- **五级思考力度**：`getThinkingConfig`（`packages/catalog/src/model-thinking.ts`）将 `firepass` 映射到 `FIVE_TIER_EFFORTS_LOW_TO_MAX`（`low`、`medium`、`high`、`xhigh`、`max`）。

### 认证与使用
- **认证**：在 `packages/ai/src/registry/firepass.ts`（`firepassProvider`、`loginFirepass`）中定义，使用环境变量 `FIREPASS_API_KEY`（`fpk_...`）。
- **验证**：专用的 `fpk_...` 密钥仅授权路由器端点，在 `/v1/models` 上失败。`loginFirepass` 使用 `validation.kind: "chat-completions"`，直接针对 `accounts/fireworks/routers/kimi-k2p6-turbo`。

### 目录模型处理
- **描述符**：在 `packages/catalog/src/provider-models/descriptors.ts` 中注册（`id: "firepass"`、`defaultModel: "kimi-k2.6-turbo"`、`envVars: ["FIREPASS_API_KEY"]`）。
- **管理器选项**：`firepassModelManagerOptions`（`packages/catalog/src/provider-models/openai-compat.ts`）返回一个没有动态发现的静态配置，依赖于 `models.json` 中捆绑的规范目录。
- **脚本清理**：`dropFireworksWireIds`（`packages/catalog/scripts/generate-models.ts`）在目录生成期间剥离内部的 `accounts/fireworks/` 线路 ID。

## Fireworks (`fireworks`)
Fireworks（`packages/ai/src/registry/fireworks.ts`）是一个高吞吐量的 AI 推理提供商，通过 OpenAI 兼容的 HTTP REST API（`https://api.fireworks.ai/inference/v1`）提供无服务器和专用模型服务。它使用 OpenAI Chat Completions 传输协议（`packages/ai/src/providers/openai-completions.ts` 中的 `streamOpenAICompletions`），具有自定义模型 ID 线路转换、思考参数冲突解决和优先级层处理功能。

### 特殊情况处理
- **`wireModelIdMode: "fireworks"` 与线路模型 ID 转换**：`applyWireModelIdTransform`（`packages/ai/src/providers/openai-shared.ts`）由 `packages/catalog/src/compat/openai.ts` 中解析的 `wireModelIdMode: "fireworks"` 启用，调用 `toFireworksWireModelId`（`packages/catalog/src/fireworks-model-id.ts`）以为公共目录模型 ID 添加 `accounts/fireworks/models/` 前缀，并将版本点转换为 `p`（例如，`glm-5.1` 映射到 `accounts/fireworks/models/glm-5p1`）。公共目录标准化使用 `toFireworksPublicModelId`。
- **快速路由器和 Fire Pass 模型线路路由**：以 `-fast` 结尾的模型（`packages/catalog/src/fireworks-model-id.ts` 中的 `isFireworksFastModelId`）表示高吞吐量服务路由。`buildOpenAICompat`（`packages/catalog/src/compat/openai.ts`）将 `isFireworksFastRouter` 解析为 `wireModelIdMode: "firepass"`，通过 `toFirepassWireModelId` 将线路调度映射到 `accounts/fireworks/routers/<id>-fast` 而不是 `accounts/fireworks/models/`。
- **`dropThinkingWhenReasoningEffort` 冲突解决**：在 `packages/catalog/src/compat/openai.ts` 中为 Fireworks 将 `compat.dropThinkingWhenReasoningEffort` 设置为 `true`。当请求参数中存在 `reasoning_effort` 时，`applyOpenAIExtraBody`（`packages/ai/src/providers/openai-shared.ts`）会删除顶级 `thinking` 开关对象，以防止 Fireworks 同时拒绝两个参数导致的 HTTP 400 错误。
- **Qwen 思考格式覆盖**：`buildOpenAICompat`（`packages/catalog/src/compat/openai.ts`）为 Fireworks 托管的 Qwen 模型（例如 `fireworks/qwen3.7-plus`）分配 `thinkingFormat: "openai"` 而不是 `"qwen"`，强制使用 `reasoning_effort` 而不是 Alibaba DashScope 的 `enable_thinking` 布尔值（Fireworks 会以 400 拒绝）。
- **服务层/优先级控制**：`excludesInferredOpenAIServiceTier` 和 `shouldSendServiceTier`（`packages/ai/src/types.ts`）允许 `fireworks` 请求在启用 `providers.fireworksTier: priority`（或 `/fast` 模式）时发送 `service_tier: "priority"`，抑制不需要的层默认值。
- **流标记修复**：`packages/ai/src/utils/stream-markup-healing.ts` 中的 `modelMayLeakDsmlToolCalls` 标记 `provider === "fireworks"`，调用 `ThinkingInbandScanner` 缓冲和清理从可见文本增量中泄露的 DSML XML 标记。

### 认证与使用
- **API 密钥认证**：使用通过 `FIREWORKS_API_KEY`（通过 `packages/ai/src/stream.ts` 中的 `getEnvApiKey` 解析）配置的 HTTP Bearer 令牌（`Authorization: Bearer ${apiKey}`）进行认证。
- **控制平面登录验证**：`/login fireworks`（`packages/ai/src/registry/fireworks.ts` 中的 `loginFireworks`）根据静态控制平面目录 `GET /v1/accounts/fireworks/models?filter=supports_serverless%3Dtrue&pageSize=1` 验证凭据，而不是 `/v1/models`（推理端点为每个账户的部署提供服务，并对没有活动部署的账户返回 500）。
- **使用计费**：通过 `calculateOpenAIUsageAccounting`（`packages/ai/src/providers/openai-shared.ts`）中的标准 `openai-completions` 计费处理令牌使用情况，提取 `prompt_tokens`、`completion_tokens`、`prompt_tokens_details.cached_tokens` 和 `completion_tokens_details.reasoning_tokens`。

### 目录模型处理
- **描述符注册**：在 `CATALOG_PROVIDERS`（`packages/catalog/src/provider-models/descriptors.ts`）中注册，`id: "fireworks"`、`defaultModel: "kimi-k2.7-code"`、`envVars: ["FIREWORKS_API_KEY"]`，以及 `createModelManagerOptions: fireworksModelManagerOptions`。
- **控制平面发现**：`fireworksModelManagerOptions`（`packages/catalog/src/provider-models/openai-compat.ts`）通过控制平面目录 `GET /v1/accounts/fireworks/models?filter=supports_serverless=true` 枚举模型，而不是 `/v1/models`，使用 `toFireworksPublicModelId` 将资源名称（`accounts/fireworks/models/<id>`）转换为公共目录 ID。在 `scripts/generate-models.ts` 中的目录生成期间修剪内部账户资源 ID。
- **快速变体种子**：`buildFireworksFastSeed`（`packages/catalog/src/provider-models/openai-compat.ts`）以编程方式为精选的基础模型生成配对的 `-fast` 目录种子（例如 `kimi-k2.7-code-fast`、`glm-5.1-fast`），保留基础定价，同时针对高速路由器线路路径。
- **Kimi 系列输出令牌上限**：`clampFireworksKimiMaxTokens`（`packages/catalog/src/provider-models/openai-compat.ts`）将 Kimi K2.5/K2.6 模型的输出预算 `maxTokens` 限制为 `FIREWORKS_KIMI_MAX_TOKENS = 32_768`（`isFireworksKimiK2ModelId`），以防止由 Fireworks 报告的 `max_completion_tokens: 65536` 引起的推理跟踪失控。`kimi-k2.7-code` 被明确排除在此上限之外，允许达到其全部输出预算（`FIREWORKS_KIMI_K27_CODE_MAX_TOKENS = 65_536`）。
- **推理努力阶梯**：`FIREWORKS_REASONING_EFFORT_MAP`（`packages/catalog/src/model-thinking.ts`）将 `minimal -> "none"` 映射（禁用 Fireworks 上的推理），同时传递 `low`、`medium` 和 `high`。限制性模型（例如 `minimax-m2.7`、`gpt-oss-120b`）在目录定义中将努力阶梯覆盖为 `[low, medium, high]`。

## GitHub Copilot (`github-copilot`)
GitHub Copilot 通过 GitHub 的统一代理端点（`https://api.githubcopilot.com` 或企业版 `copilot-api.<domain>`）路由多供应商模型执行（OpenAI GPT、Anthropic Claude、xAI Grok、Google Gemini）。该提供商在三种线路传输之间动态调度：OpenAI Chat Completions、OpenAI Responses 和 Anthropic Messages。

### 特殊情况处理
- **动态 Copilot 头和发起者**：`buildCopilotDynamicHeaders`（`packages/ai/src/registry/github-copilot.ts`）为每个请求注入头 `X-Initiator`（通过 `inferCopilotInitiator` 从消息历史推断的 `"user"` 与 `"agent"`，或通过 `getCopilotInitiatorOverride` 覆盖）、`Openai-Intent: conversation-edits`，以及当 `hasCopilotVisionInput` 在用户或工具结果块中检测到图像负载时的 `Copilot-Vision-Request: true`。
- **API 版本控制和线路头**：`COPILOT_API_HEADERS`（`packages/catalog/src/wire/github-copilot.ts`）强制要求 `User-Agent: opencode/1.3.15`（`COPILOT_USER_AGENT`）和 `X-GitHub-Api-Version: 2026-06-01`（`COPILOT_API_VERSION`）。`packages/catalog/src/provider-models/openai-compat.ts` 中的 `restorableHeaderFallback` 在离线缓存重新水化期间保留静态线路头。
- **基础 URL 和端点解析**：`resolveGitHubCopilotBaseUrl`（`packages/ai/src/registry/github-copilot.ts`）和 `parseGitHubCopilotApiKey`（`packages/catalog/src/wire/github-copilot.ts`）解析嵌入在 API 密钥或凭据中的自定义 `enterpriseUrl` 和 `apiEndpoint` 属性，默认为 `https://api.githubcopilot.com`（`PERSONAL_GITHUB_COPILOT_BASE_URL`）。
- **OpenAI 和 Responses 兼容标志**：
  - `supportsReasoningParams`：在 `packages/catalog/src/compat/openai.ts` 中禁用（`supportsReasoningParams: provider !== "github-copilot"`），因为 Copilot Chat Completions 端点会拒绝 `reasoning_effort` 和推理字段并返回 HTTP 400。
  - `supportsDeveloperRole`：对 Chat Completions 规范禁用（`openai-compat.ts`），但对 OpenAI Responses 规范启用。
  - `strictResponsesPairing`：在 `packages/catalog/src/compat/openai.ts` 中启用（`spec.provider === "github-copilot"`），强制 Responses 端点上工具调用和工具结果消息之间的严格配对。
  - `supportsImageDetailOriginal`：禁用（`supportsImageDetailOriginal: false`），将图像细节从 `"original"` 限制为 `"auto"`，以避免代理 400/422 拒绝。
- **Anthropic 线路和签名兼容**：
  - `supportsEagerToolInputStreaming`：在 `packages/catalog/src/compat/anthropic.ts` 中禁用（`supportsEagerToolInputStreaming: false`），并且省略细粒度工具流式传输 beta 头，因为 Copilot Anthropic 代理拒绝 `eager_input_streaming`（#2558）。
  - 被识别为签名主机（`buildAnthropicCompat`），抑制 Claude 模型的未签名思考重放（#2851）。

### 认证与使用
- **设备流 OAuth（`opencode` OAuth 应用）**：
  - `packages/ai/src/registry/oauth/github-copilot.ts` 中的 `loginGitHubCopilot` 使用客户端 ID `Ov23li8tweQw6odWQebz`（`CLIENT_ID`）和作用域 `read:user` 执行 GitHub 设备授权流程。
  - `startDeviceFlow` 使用 `OPENCODE_HEADERS` 发布到 `https://<domain>/login/device/code`。`pollForGitHubAccessToken` 轮询 `https://<domain>/login/oauth/access_token`，自动处理 `authorization_pending` 和 `slow_down` 速率限制退避。
  - 登录后，`discoverGitHubCopilotApiEndpoint` 查询 `https://api.github.com/copilot_internal/user`，`enableAllGitHubCopilotModels` 发出模型启用请求（`POST /models/{modelId}/policy`，使用 `{ state: "enabled" }` 和 `openai-intent: chat-policy`）。
- **令牌交换和刷新**：
  - `refreshGitHubCopilotToken`（`packages/ai/src/registry/oauth/github-copilot.ts`）直接使用长期 GitHub OAuth 令牌，而不进行二次 JWT 交换周期，将过期时间设置为 `FAR_FUTURE_MS`（10 年）。
- **使用和配额计费**：
  - `packages/ai/src/usage/github-copilot.ts` 中的 `fetchInternalUsage` 在 `resolveGitHubApiBaseUrl` 上使用 `OPENCODE_HEADERS` 查询 `GET /copilot_internal/user`。
  - `normalizeQuotaSnapshots` 和 `buildLimitFromQuota` 将 `quota_snapshots`（`chat`、`completions`、`premium_interactions`）和 `quota_reset_date` 转换为月度 `UsageLimit` 结构（`copilot:premium`、`copilot:chat`、`copilot:completions`）。`fetchBillingUsage` 提供补充的用户计费详细信息（`/settings/billing/premium_request/usage`）。
  - `getCopilotPremiumRequests`（`packages/ai/src/registry/github-copilot.ts`）计算模型高级请求成本：对于 agent 回合（`initiator === "agent"`）为 `0`，或对于用户回合为 `getCopilotPremiumMultiplier(premiumMultiplier, planTier)`。

### 目录模型处理
- **描述符和管理**：在 `PROVIDER_DESCRIPTORS`（`packages/catalog/src/provider-models/descriptors.ts`）中注册为 `github-copilot` 描述符，`defaultModel: "gpt-5.5"`，环境变量为 `COPILOT_GITHUB_TOKEN`。通过 `githubCopilotModelManagerOptions` 构造选项。
- **动态模型发现**：`packages/catalog/src/provider-models/openai-compat.ts` 中的 `fetchDynamicModels` 使用 `COPILOT_API_HEADERS` 获取 `/models`。从 `entry.capabilities.limits`（`maxContextWindowTokens`、`maxPromptTokens`、`maxOutputTokens`）解析窗口/令牌限制，推断线路 API（`inferCopilotApi`），并配置视觉支持（`extractCopilotSupportsVision`）。
- **长上下文变体合成**：在 `billing.token_prices.long_context` 中宣传长上下文定价的模型触发 `createCopilotLongContextVariant` 以合成选择性加入的 `-1m` 目录模型（例如 `claude-opus-4.7-1m`，具有 `requestModelId: "claude-opus-4.7"`）。基础模型接收指向其长上下文兄弟的 `contextPromotionTarget`。
- **高级请求乘数**：模型特定请求乘数在 `COPILOT_PREMIUM_MULTIPLIERS`（`packages/catalog/scripts/generate-models.ts`）中映射，分配如下值：`gpt-4o: 0`、`grok-code-fast-1: 0.25`、`claude-haiku-4.5: 0.33`、`gpt-5.4-mini: 0.33` 和 `claude-opus-4.6: 3`。

## GitLab Duo Non-Agentic (`gitlab-duo`)

`GitLab Duo Non-Agentic`（`gitlab-duo`）将 Duo Chat LLM 完成请求代理到 GitLab AI Gateway 代理端点。根据目标模型映射，它动态地将执行委托给 [Anthropic Messages](#anthropic-messages)、[OpenAI Chat Completions](#openai-chat-completions) 或 [OpenAI Responses](#openai-responses) 线路传输。它遵循共享的 [GitLab Duo](#gitlab-duo) 传输部分。

### 特殊情况处理
- **模型 ID 映射和路由**：`packages/ai/src/providers/gitlab-duo.ts` 中的 `MODEL_MAPPINGS` 将 Duo 模型标识符（`duo-chat-opus-4-6`、`duo-chat-sonnet-4-6`、`duo-chat-opus-4-5`、`duo-chat-sonnet-4-5`、`duo-chat-haiku-4-5`、`duo-chat-gpt-5-1`、`duo-chat-gpt-5-2`、`duo-chat-gpt-5-mini`、`duo-chat-gpt-5-codex`、`duo-chat-gpt-5-2-codex`）映射到后端提供商（`anthropic` 或 `openai`）、基础模型 ID、API 架构（`anthropic-messages`、`openai-completions`、`openai-responses`）和代理目标 URL（`ANTHROPIC_PROXY_URL` = `https://cloud.gitlab.com/ai/v1/proxy/anthropic/` 或 `OPENAI_PROXY_URL` = `https://cloud.gitlab.com/ai/v1/proxy/openai/v1`）。
- **规范模型别名查找**：`packages/ai/src/providers/gitlab-duo.ts` 中的 `getModelMapping` 通过匹配 Duo 别名键或基础规范模型 ID 字符串（例如 `gpt-5-codex` 或 `claude-sonnet-4-5-20250929`）来解析模型映射。
- **直接访问令牌交换和缓存**：`packages/ai/src/providers/gitlab-duo.ts` 中的 `getDirectAccessToken` 通过 `POST https://gitlab.com/api/v4/ai/third_party_agents/direct_access` 与 `{ feature_flags: { DuoAgentPlatformNext: true } }` 交换用户的 GitLab 访问令牌以获得短期直接访问令牌。生成的令牌和头在 `directAccessCache` 中缓存 25 分钟（`DIRECT_ACCESS_TTL_MS`）。
- **委托流调度**：`packages/ai/src/providers/gitlab-duo.ts` 中的 `streamGitLabDuo` 验证用户令牌（`MissingApiKeyError`），获取直接访问头，通过 `mapAnthropicToolChoice`（`packages/ai/src/stream.ts`）转换 Anthropic 工具选择，并使用合成的模型规范（`buildModel`）调度到 `streamAnthropic`、`streamOpenAICompletions` 或 `streamOpenAIResponses`（`packages/ai/src/providers/register-builtins.ts`）。

### 认证与使用
- **PAT 和 OAuth 支持**：`packages/ai/src/registry/gitlab-duo.ts` 中的 `gitlabDuoProvider` 通过 `GITLAB_TOKEN` 支持个人访问令牌，或通过 `packages/ai/src/registry/oauth/gitlab-duo.ts` 中的 `loginGitLabDuo` 支持 PKCE 浏览器 OAuth。
- **OAuth 授权和客户端 ID**：`packages/ai/src/registry/oauth/gitlab-duo.ts` 中的 `GitLabDuoOAuthFlow` 针对 `https://gitlab.com/oauth/authorize` 执行 PKCE OAuth（`scope: "api"`、`callbackPort: 8080`、`pasteCodeFlow: true`）。使用 `DEFAULT_CLIENT_ID`（`"da4edff2e6ebd2bc3208611e2768bc1c1dd7be791dc5ff26ca34ca9ee44f7d4b"`），可通过 `GITLAB_CLIENT_ID`（`resolveClientId`）和 `GITLAB_REDIRECT_URI`（`resolveCallbackOptions`）覆盖。
- **令牌刷新和缓存失效**：`packages/ai/src/registry/oauth/gitlab-duo.ts` 中的 `refreshGitLabDuoToken` 在 `https://gitlab.com/oauth/token` 交换刷新令牌。交换和刷新都通过 `clearGitLabDuoDirectAccessCache`（`packages/ai/src/providers/gitlab-duo.ts`）清除缓存的直接访问令牌。
- **使用界面**：除了 [GitLab Duo](#gitlab-duo) 管道之外，没有其他内容。

### 目录模型处理
- **描述符配置**：`packages/catalog/src/provider-models/descriptors.ts` 中的 `PROVIDER_DESCRIPTORS` 使用 `defaultModel: "duo-chat-opus-4-6"` 和 `envVars: ["GITLAB_TOKEN"]` 注册 `gitlab-duo`。
- **静态目录生成**：`packages/catalog` 中的 `scripts/generate-models.ts` 调用 `getGitLabDuoModels`（`packages/ai/src/providers/gitlab-duo.ts`），将 `MODEL_MAPPINGS` 条目转换为 `models.json` 中捆绑的 `ModelSpec` 定义。
- **提供商优先级**：`packages/catalog/src/identity/priority.ts` 中的 `PROVIDER_PRIORITY` 为 `gitlab-duo` 分配优先级 35。

## GitLab Duo Agent (`gitlab-duo-agent`)
`gitlab-duo-agent` 提供商将 OMP 连接到 GitLab Duo Workflow Service（DWS），通过 WebSocket action-bridge 协议执行代理。它遵循 `GitLab Duo` 传输部分。

### 特殊情况处理
- **流直接绕过和思考修复**：在 `packages/ai/src/stream.ts` 中，`gitlab-duo-agent` 绕过 `withProviderInFlightLimit` 和标准 `iterateWithIdleTimeout` 包装器。`streamGitLabDuoWorkflow`（`packages/ai/src/providers/gitlab-duo-workflow.ts`）被直接调用，包装在 `healLeakedThinking` 中。
- **运行时命名空间解析和自动启用**：流初始化调用 `resolveGitLabDuoWorkflowNamespaceSelection`（`packages/ai/src/providers/gitlab-duo-workflow.ts`）以从选项、`GITLAB_DUO_NAMESPACE_ID`/`GITLAB_DUO_PROJECT_ID` 环境变量或工作区 git 远程解析根命名空间。`ensureGitLabDuoWorkflowSettings` 发布到 `/api/v4/ai/duo_workflows/settings`（通过 `GITLAB_DUO_WORKFLOW_REST_TIMEOUT_MS` 设置 30 秒超时）以自动启用所需的命名空间设置（`duo_workflow`、`duo_workflow_service`、`duo_agent_platform`）。
- **ChatML 目标和内联规范生成**：将会话历史呈现为 ChatML 目标字符串（`buildGitLabDuoWorkflowGoal`、`renderGitLabDuoWorkflowChatMl`），受 1MB 软限制（`GITLAB_DUO_WORKFLOW_GOAL_SOFT_OVERFLOW_BYTES`）和 2MB 硬限制（`GITLAB_DUO_WORKFLOW_GOAL_HARD_OVERFLOW_BYTES`）约束。发出针对 `omp_agent` 的环境内联工作流定义（`buildGitLabDuoWorkflowInlineFlowConfig`）。
- **WebSocket Action Bridge**：工具定义在 `startRequest.mcpTools` 中转换为 MCP 格式（`buildGitLabDuoWorkflowMcpTools`）。通过 WebSocket 传入的 `runMCPTool`/`run_mcp_tool` 操作被提取（`extractGitLabDuoWorkflowAction`），本地执行，并通过 `buildGitLabDuoWorkflowActionResponse` 返回。

### 认证与使用
- **注册表和凭据解析**：提供商定义 `gitLabDuoWorkflowProvider`（`packages/ai/src/registry/gitlab-duo-workflow.ts`）需要 `GITLAB_TOKEN`（PAT 或 OAuth 令牌）。
- **OAuth PKCE 和官方客户端 ID**：浏览器认证（`packages/ai/src/registry/oauth/gitlab-duo-workflow.ts` 中的 `loginGitLabDuoWorkflow`）在回调端口 8080 上使用 S256 PKCE 和 `pasteCodeFlow: true`。它使用官方 GitLab VS Code 客户端 ID `GITLAB_DUO_WORKFLOW_OAUTH_CLIENT_ID`（`36f2a70cddeb5a0889d4fd8295c241b7e9848e89cf9e599d0eed2d8e5350fbf5`）和重定向 URI `vscode://gitlab.gitlab-workflow/authentication`，支持在 VS Code 拦截重定向时手动粘贴回调 URL。令牌刷新使用 `refreshGitLabDuoWorkflowToken`。
- **直接访问令牌**：通过 `POST /api/v4/ai/duo_workflows/direct_access`（`packages/ai/src/providers/gitlab-duo-workflow.ts` 中的 `requestGitLabDuoWorkflowDirectAccess`）请求临时凭据。`packages/ai/src/usage/` 下不存在专用的使用模块。
- **上下文遥测使用**：`extractGitLabDuoWorkflowContextUsage` 提取检查点遥测（`agent_context_usage`），优先处理 `"Chat Agent"` 和 `"context_builder"` 条目，并通过 `applyGitLabDuoWorkflowContextUsage` 更新令牌估计。

### 目录模型处理
- **提供商描述符**：在 `packages/catalog/src/provider-models/descriptors.ts` 中注册，`defaultModel: "claude_sonnet_4_6_vertex"`、`envVars: ["GITLAB_TOKEN"]` 和 `dynamicModelsAuthoritative: true`。省略 `catalogDiscovery` 以防止单账户命名空间发现在静态目录生成期间运行。
- **指纹作用域缓存**：`packages/catalog/src/provider-models/special.ts` 中的 `gitLabDuoWorkflowModelManagerOptions` 配置动态模型管理。`gitLabDuoWorkflowModelCacheProviderId` 使用 `Bun.hash` 对 `apiKey` 和由 `baseUrl`、`namespaceId`、`projectId` 和工作区 `cwd` 组成的作用域字符串对动态目录缓存进行分区。
- **GraphQL 发现**：`fetchGitLabDuoWorkflowModels`（`packages/catalog/src/discovery/gitlab-duo-workflow.ts`）调用 `discoverGitLabDuoWorkflowNamespace` 以定位根命名空间（通过显式配置、环境变量或匹配 `discoverGitLabRemoteProjectPath` 的 git 远程），并执行 GraphQL 查询 `aiChatAvailableModels(rootNamespaceId:)` 以查询 `defaultModel`、`selectableModels` 和 `pinnedModel`。
- **模型规范和上下文窗口**：`buildGitLabDuoWorkflowModelSpec` 构造具有 `reasoning: false` 的模型规范（禁用思考 UI 控件，因为 Duo Agent Platform 在服务器端管理 Anthropic 推理参数）。`resolveGitLabDuoWorkflowContextWindow` 将模型引用映射到上下文窗口大小（Claude Opus/Sonnet：1,000,000；Haiku：200,000；Gemini：1,000,000；GPT-5：400,000；默认：200,000）。
- **回退模型种子**：`scripts/generate-models.ts` 植入 `buildGitLabDuoWorkflowFallbackModel()`（`claude_sonnet_4_6_vertex`），以便未经身份验证/全新安装包含默认模型条目。

## GMI Cloud (`gmi-cloud`)
GMI Cloud 是一个 AI GPU 基础设施和云模型推理提供商，托管开源权重和专有模型端点。它通过 OpenAI Chat Completions 传输协议在托管于 `https://api.gmi-serving.com/v1` 的标准 `/v1` 线路协议上运行。

### 特殊情况处理
- 除了 OpenAI Chat Completions 管道之外没有其他内容。

### 认证与使用
- **API 密钥登录和验证**：`loginGmiCloud`（`packages/ai/src/registry/gmi-cloud.ts`）通过 `createApiKeyLogin` 实现交互式 API 密钥认证，将用户引导至 `https://console.gmicloud.ai`。密钥验证使用 `kind: "models-endpoint"`，通过 `validateOpenAICompatibleApiKey`（`packages/ai/src/registry/api-key-validation.ts`）命中 `https://api.gmi-serving.com/v1/models`。
- **环境变量**：主要凭据解析检查 `GMI_API_KEY`（`packages/catalog/src/provider-models/descriptors.ts` 中的 `envVars`）。
- **提供商注册表**：`gmiCloudProvider`（`packages/ai/src/registry/gmi-cloud.ts`）在 `packages/ai/src/registry/registry.ts` 的提供商定义数组中导出。

### 目录模型处理
- **描述符和网关选项**：在 `CATALOG_PROVIDERS`（`packages/catalog/src/provider-models/descriptors.ts`）中注册，`id: "gmi-cloud"`、`defaultModel: "deepseek-ai/DeepSeek-V4-Flash"` 和 `dynamicModelsAuthoritative: true`。网关选项由包装 `createSimpleOpenAICompletionsOptions` 与 `GMI_CLOUD_BASE_URL`（`https://api.gmi-serving.com/v1`）的 `gmiCloudModelManagerOptions` 创建（`packages/catalog/src/provider-models/openai-compat.ts`）。
- **动态模型发现**：使用 `catalogDiscovery: { label: "GMI Cloud" }`（`packages/catalog/src/provider-models/descriptors.ts`）进行配置，以通过 `fetchOpenAICompatibleModels`（`packages/catalog/src/discovery/openai-compatible.ts`）动态查询 `/v1/models`。当 API 凭据可用时，标记为权威的实时发现结果将覆盖缓存或静态条目。
- **静态种子模型**：`GMI_CLOUD_STATIC_MODELS`（`packages/catalog/src/provider-models/openai-compat.ts`）为 `deepseek-ai/DeepSeek-V4-Flash`（1,048,576 上下文窗口、384,000 最大令牌、每 1M 输入/输出令牌 `$0.14`/`$0.28`、启用推理与 `High` 和 `Max` 努力模式）定义捆绑的回退种子。此种子确保缺乏 `GMI_API_KEY` 的全新安装或模型生成运行可以同步解析提供商的默认模型（`packages/catalog/scripts/generate-models.ts`，`packages/catalog/test/gmi-cloud-provider.test.ts`）。

## Google Antigravity (`google-antigravity`)
Google Antigravity 提供商（`google-antigravity`）使用专用 OAuth 凭据将请求路由到 Google Cloud Code Assist 日常/沙盒端点（`daily-cloudcode-pa.googleapis.com`）。它使用共享的"Google Gemini CLI / Antigravity"传输协议（`packages/ai/src/providers/google-gemini-cli.ts`）提供对 Google Gemini 3.x/2.5 模型以及 Anthropic Claude 和 OpenAI GPT-OSS 模型的访问。

### 特殊情况处理
- **已验证的函数调用默认**：`buildRequest`（`packages/ai/src/providers/google-gemini-cli.ts`）中的默认工具选择模式是 `VALIDATED`（`functionCallingConfig: { mode: "VALIDATED" }`）。Antigravity 上的 Claude 模型即使未声明任何工具，也始终强制使用 `VALIDATED` 工具模式（`packages/ai/src/providers/google-gemini-cli.ts`）。
- **系统指令和请求包络**：Antigravity 使用 `role: "user"` 标记 `systemInstruction` 并按原样发送调用者的提示。`buildAntigravityRequestEnvelope` 使用 `getAntigravityModelWireProfile` 注入结构化的 `requestId`（`agent/<id>/<ts>/<trajectoryId>/<step>`）、`userAgent: "antigravity"`、`requestType: "agent"`、`sessionId` 和 `labels`（`model_enum`、`trajectory_id`、`last_step_index`、`last_execution_id`、`used_claude*`）。
- **端点自动故障转移**：跨 `ANTIGRAVITY_DAILY_ENDPOINT`（`https://daily-cloudcode-pa.googleapis.com`）和 `ANTIGRAVITY_SANDBOX_ENDPOINT`（`https://daily-cloudcode-pa.sandbox.googleapis.com`）运行，使用 `getAntigravityProviderSessionState`（`packages/ai/src/providers/google-gemini-cli.ts`）进行状态跟踪回退。

### 认证与使用
- **专用 OAuth 流程**：`loginAntigravity` 和 `refreshAntigravityToken`（`packages/ai/src/registry/oauth/google-antigravity.ts`）使用不同的客户端凭据和回调端口 51121 执行独立的 OAuth 流程。项目发现镜像原生 `antigravity/hub`：精确-200 `loadCodeAssist` 调用使用 `ANTIGRAVITY_LOAD_CODE_ASSIST_METADATA`，尊重免费层资格，缺失的层触发一个 `onboardUser` 请求加上 30 秒期限内的 1 秒操作轮询，最终加载刷新提供 `cloudaicompanionProject`。
- **模型系列凭据排名**：`antigravityRankingStrategy`（`packages/ai/src/usage/google-antigravity.ts`）按模型系列对使用限制进行作用域划分（`scopeAntigravityLimitsForModel` 通过 `getAntigravityCounterKeyForModel`：`anthropic` 用于 `claude-`，`google` 用于 `gemini-`/`gemma-`，`openai` 用于 `gpt-`/`openai/`）。这可以防止一个计数器（例如 Gemini）上的配额耗尽阻塞另一个系列（例如 Claude）的多账户凭据选择。

### 目录模型处理
- **目录发现**：`fetchAntigravityDiscoveryModels`（`packages/catalog/src/discovery/antigravity.ts`）查询 `/v1internal:fetchAvailableModels`，过滤列入黑名单的 ID（`chat_20706`、`chat_23310`、`gemini-2.5-pro`）和内部模型（`isInternal`），并通过 `ANTIGRAVITY_VARIANT_COLLAPSE_TABLE` 应用努力层变体折叠。
- **Claude 和 GPT-OSS 模型可用性**：在 `models.json`（`packages/catalog/src/models.json`）中与 Gemini 3.x/2.5 模型一起公开 Anthropic Claude 模型（`claude-opus-4-5`、`claude-opus-4-6`、`claude-sonnet-4-5`、`claude-sonnet-4-6`）和 `gpt-oss-120b`。
- **定价回退**：`applyAntigravityPricingFallback`（`packages/catalog/scripts/generated-policies.ts`）使用 `ANTIGRAVITY_PRICING_PEERS`（`google`、`google-vertex`、`anthropic`）和 `ANTIGRAVITY_PRICING_ID_ALIASES`（`gemini-3-flash` -> `gemini-3-flash-preview`，`claude-opus-4-5` -> `claude-opus-4-5@20251101`）回填 0 成本发现模型，将 Gemini 模型映射到 Google API 价格，将 Claude 模型映射到 Google Vertex 列表价格。

## Google Gemini CLI (`google-gemini-cli`)
Google Cloud Code Assist (Gemini CLI)（`google-gemini-cli`）是 Google 的 OAuth 认证开发人员免费和工作区层，通过 Cloud Code Assist API 端点（`https://cloudcode-pa.googleapis.com`）提供对 Gemini 模型的直接访问。遵循共享的 **Google Gemini CLI / Antigravity** 传输部分（`packages/ai/src/providers/google-gemini-cli.ts`）。

### 特殊情况处理
- **默认端点和头**：将请求调度到 `https://cloudcode-pa.googleapis.com` 并通过 `getGeminiCliHeaders()` 发出头（`packages/catalog/src/wire/gemini-headers.ts` 中的 `GeminiCLI/0.46.0/<modelId> ...`）。
- **思考传输**：通过 `google-level` `thinkingLevel` 传输映射 Gemini 思考（`packages/catalog/src/variant-collapse.ts` 中的 `GEMINI_CLI_VARIANT_COLLAPSE_TABLE`），与使用 `budget` 传输的 `google-antigravity` 不同（`ANTIGRAVITY_VARIANT_COLLAPSE_TABLE`）。
- 标准请求管道：除了 Google Gemini CLI / Antigravity 传输管道之外没有其他内容。

### 认证与使用
- **OAuth 已安装应用流程**：通过 Google PKCE OAuth 2.0（`packages/ai/src/registry/oauth/google-gemini-cli.ts` 中的 `loginGeminiCli`）在回调端口 `8085`（`/oauth2callback`）上授权，请求 Google Cloud 作用域（`cloud-platform`、`userinfo.email`、`userinfo.profile`）。刷新通过 `refreshGoogleCloudToken`（`packages/ai/src/registry/oauth/google-gemini-cli.ts`）处理。
- **项目发现和引导**：`discoverProject`（`packages/ai/src/registry/oauth/google-gemini-cli.ts`）通过 `$GOOGLE_CLOUD_PROJECT`/`$GOOGLE_CLOUD_PROJECT_ID` 回退使用 `POST /v1internal:loadCodeAssist` 检查现有项目。非免费层（`legacy-tier`、`standard-tier`）或新帐户使用 `tierId`（`free-tier`、`legacy-tier`、`standard-tier`）调用 `POST /v1internal:onboardUser`，并轮询 `pollOperation`（最多 `POLL_MAX_ATTEMPTS = 24` 次，间隔 5 秒）。检测 VPC-SC 限制（`isVpcScAffectedUser` 检查 `SECURITY_POLICY_VIOLATED`）。
- **配额和使用提供商**：`googleGeminiCliUsageProvider`（`packages/ai/src/usage/gemini.ts`）发布到 `loadCodeAssist` 和 `retrieveUserQuota`（`/v1internal:retrieveUserQuota`），将剩余存储桶分数映射到按模型层（通过 `getModelTier` 的 `3-Flash`、`Flash`、`Pro`）分组的使用百分比。

### 目录模型处理
- **提供商描述符**：在 `CATALOG_PROVIDERS`（`packages/catalog/src/provider-models/descriptors.ts`）中注册，`defaultModel: "gemini-3.1-pro-preview"` 和 `specialModelManager: true`，绕过标准模型工厂。
- **模型解析和发现**：`googleGeminiCliModelManagerOptions`（`packages/catalog/src/provider-models/google.ts`）使用 `GEMINI_CLI_VARIANT_COLLAPSE_TABLE` 针对 Antigravity 日常端点调用 `fetchAntigravityDiscoveryModels`（`packages/catalog/src/discovery/antigravity.ts`），将结果过滤为 Gemini 模型，然后将提供商重写为 `google-gemini-cli`，将推理基础 URL 重写为 `https://cloudcode-pa.googleapis.com`。当 Antigravity 端点对凭据未经授权（Gemini Code Assist Standard 返回 HTTP 403）时，它回退到 `fetchGeminiCliQuotaModels`（`packages/catalog/src/discovery/gemini-cli.ts`），从 Cloud Code Assist 上帐户自己的 `retrieveUserQuota` 响应中派生模型列表，在 id 已知的地方从捆绑目录填充元数据。
- **生成器集成和优先级**：在 `fetchAntigravityModels`（`packages/catalog/scripts/generate-models.ts`）中作为回退 OAuth 令牌提供程序（如果 `google-antigravity` 访问不可用）。在提供商优先级中排名第二（`packages/catalog/src/identity/priority.ts`）。

## Groq (`groq`)
Groq 使用 OpenAI Chat Completions 传输协议（`https://api.groq.com/openai/v1`）为由定制 LPU 硬件驱动的开源权重模型提供高速 LLM 推理。

### 特殊情况处理
- **上下文溢出**：当错误消息在 `OVERFLOW_PATTERNS`（`packages/ai/src/error/flags.ts`）中匹配 `/reduce the length of the messages/i` 时检测。
- **推理努力映射**：模型 `qwen/qwen3-32b` 通过 `GROQ_QWEN3_32B_REASONING_EFFORT_MAP`（`packages/catalog/src/model-thinking.ts`）将 `Minimal`、`Low`、`Medium`、`High` 和 `XHigh` 映射到 `"default"`。
- **多个系统消息**：通过 OpenAI 兼容性设置中的 `isGroqHost` 在 `supportsMultipleSystemMessagesDefault`（`packages/catalog/src/compat/openai.ts`）中默认原生支持。

### 认证与使用
- **认证**：通过 `GROQ_API_KEY` 环境变量（`packages/catalog/src/provider-models/descriptors.ts`）进行认证。
- **提供商注册表**：注册为 `groqProvider`（`packages/ai/src/registry/groq.ts`）。
- **优先级**：在提供商优先级排序中列为第 19 位（`packages/catalog/src/identity/priority.ts`）。

### 目录模型处理
- **主机匹配**：通过主机定义中的 URL 标记 `api.groq.com` 或提供商 `groq` 进行匹配（`packages/catalog/src/hosts.ts`）。
- **管理器选项**：通过 `groqModelManagerOptions` 配置，目标为 `https://api.groq.com/openai/v1`（`packages/catalog/src/provider-models/openai-compat.ts`）。
- **默认模型**：默认为 `openai/gpt-oss-120b`（`packages/catalog/src/provider-models/descriptors.ts`）。

## Hugging Face Inference (`huggingface`)
Hugging Face Inference 使用 OpenAI Chat Completions 传输协议（`openai-completions`）提供对托管在 Hugging Face Hub 上的开源模型无服务器端点的访问，指向 `https://router.huggingface.co/v1`。该提供商在包括 DeepSeek-R1 在内的模型上启用无服务器 LLM 生成。

### 特殊情况处理
- **标准传输管道**：除了 OpenAI Chat Completions 管道（`packages/ai/src/providers/openai-completions.ts`）之外没有其他内容。

### 认证与使用
- **环境回退**：`packages/ai/src/stream.ts` 中的 `getEnvApiKey` 中的环境变量解析会查阅 `CATALOG_PROVIDERS`（`packages/catalog/src/provider-models/descriptors.ts`）中的 `envVars`，首先检查 `HUGGINGFACE_HUB_TOKEN`，然后是 `HF_TOKEN`。
- **交互式 CLI 登录**：`packages/ai/src/registry/huggingface.ts` 中的 `loginHuggingface` 使用 `createApiKeyLogin`（`packages/ai/src/registry/api-key-login.ts`）来提示输入细粒度的用户访问令牌（占位符 `hf_...`）。
- **细粒度令牌权限**：认证设置将用户引导至 `https://huggingface.co/settings/tokens/new?ownUserPermissions=inference.serverless.write&tokenType=fineGrained`（`packages/ai/src/registry/huggingface.ts` 中的 `AUTH_URL`），自动选择具有所需"对推理提供程序进行调用"权限（`inference.serverless.write`）的细粒度令牌。
- **凭据验证**：`loginHuggingface` 使用针对基础 URL `https://router.huggingface.co/v1`（`API_BASE_URL`）针对验证模型 `openai/gpt-oss-120b`（`packages/ai/src/registry/huggingface.ts` 中的 `VALIDATION_MODEL`）的轻量级聊天完成请求来验证 API 密钥。

### 目录模型处理
- **提供商描述符**：在 `CATALOG_PROVIDERS`（`packages/catalog/src/provider-models/descriptors.ts`）中注册，`id: "huggingface"`、`defaultModel: "deepseek-ai/DeepSeek-R1"`、环境回退 `envVars: ["HUGGINGFACE_HUB_TOKEN", "HF_TOKEN"]` 和 `catalogDiscovery: { label: "Hugging Face" }`。
- **模型管理器选项**：`packages/catalog/src/provider-models/openai-compat.ts` 中的 `huggingfaceModelManagerOptions` 通过 `createSimpleOpenAICompletionsOptions` 构造管理器选项，绑定默认基础 URL `https://router.huggingface.co/v1` 并使用捆绑的参考规范映射静态模型（`mapWithBundledReference`）。
- **目录描述符**：`packages/catalog/src/provider-models/openai-compat.ts` 中的 `openAiCompletionsDescriptor` 在 `PROVIDER_DESCRIPTORS` 中注册针对 `https://router.huggingface.co/v1` 的 `huggingface`。
- **目录发现**：通过 `catalogDiscovery` 参与目录生成，`generate-models.ts`（`packages/catalog/scripts/generate-models.ts`）通过 `resolveProviderApiKey` 解析 API 令牌并针对 `https://router.huggingface.co/v1/models` 调用 `fetchOpenAICompatibleModels`（`packages/catalog/src/discovery/openai-compatible.ts`）以发现可用的 Hub 推理端点。

## Kilo Gateway (`kilo`)
Kilo Gateway（`kilo`）是一个 AI 模型聚合器和代理服务（`https://api.kilo.ai/api/gateway`），使用 OpenAI Chat Completions 传输协议（`api: "openai-completions"`）。它支持通过 `KILO_API_KEY` 进行认证或设备代码 OAuth 流程（`/login kilo`），并允许从其 OpenAI 兼容的 `/models` 目录端点进行未经身份验证的动态模型发现。

### 特殊情况处理
- **设备代码 OAuth 认证**：`packages/ai/src/registry/kilo.ts` 中的 `loginKilo` 通过 `POST https://api.kilo.ai/api/device-auth/codes` 启动设备授权，返回用户 `code`、`verificationUrl` 和 `expiresIn` 秒数。它通过 `callbacks.onAuth` 显示说明，并每 5,000 毫秒轮询一次 `GET https://api.kilo.ai/api/device-auth/codes/<userCode>` 直至过期。处理 HTTP 202（待处理）、403/410（拒绝/过期）和速率限制（HTTP 429），在批准时返回具有 1 年有效期的访问令牌（`pollData.status === "approved"`）。支持通过 `callbacks.signal` 取消。
- **非标准主机分类**：`packages/catalog/src/compat/openai.ts` 中的 `modelMatchesHost(hostModel, "kilo")` 设置 `isKilo`，将 Kilo 归类于非标准 OpenAI 兼容提供商（`isNonStandard`）中，以管理传输兼容性行为。
- **主机 URL 匹配**：`packages/catalog/src/hosts.ts` 中的主机映射将 URL 标记 `api.kilo.ai` 与提供商 `"kilo"` 相关联。
- **提供商优先级**：包含在 `packages/catalog/src/identity/priority.ts` 提供商优先级序列中（`"opencode-go"`、`"kilo"`、`"vercel-ai-gateway"`）。

### 认证与使用
- **API 密钥和 OAuth 令牌**：通过静态环境变量 `KILO_API_KEY` 或通过设备代码流程（`/login kilo`）颁发的 OAuth 访问令牌进行认证。
- **Bearer 令牌头**：针对基础 URL `https://api.kilo.ai/api/gateway` 将凭据作为标准 Bearer 令牌传递（`Authorization: Bearer <key>`）。

### 目录模型处理
- **提供商描述符**：在 `packages/catalog/src/provider-models/descriptors.ts` 中注册，`defaultModel: "anthropic/claude-opus-4.8"`、环境变量 `KILO_API_KEY` 和 `catalogDiscovery: { label: "Kilo Gateway", allowUnauthenticated: true }`，启用无需 API 密钥的目录发现。
- **模型管理器和线路描述符**：`packages/catalog/src/provider-models/openai-compat.ts` 中的 `kiloModelManagerOptions` 将 `providerId: "kilo"` 映射到基础 URL `https://api.kilo.ai/api/gateway`，并将动态模型发现委托给 `fetchOpenAICompatibleModels`。与 `openAiCompletionsDescriptor("kilo", "kilo", "https://api.kilo.ai/api/gateway")` 相关联。
- **思考配置**：通过 Kilo 路由的模型（例如 `moonshotai/kimi-k2.6`）继承标准 OpenAI 风格的思考格式解析（`compat.thinkingFormat = "openai"`）。

## Kimi Code (`kimi-code`)
Kimi Code 通过 Moonshot AI 的 `/coding/v1` API 端点提供对 Kimi 模型（`kimi-for-coding`、`k3`）的订阅支持访问。它遵循 [Kimi Code](#kimi-code) 传输管道，将请求执行委托给 `streamKimi`（`packages/ai/src/providers/kimi.ts`）和 `streamOpenAIAnthropicShim`（`packages/ai/src/providers/openai-anthropic-shim.ts`）。

### 特殊情况处理
- **提示缓存键共享**：`isKimiModel`（`packages/ai/src/providers/kimi.ts`）控制提示缓存；Anthropic 兼容（`packages/ai/src/providers/anthropic.ts:3480`）和 OpenAI 兼容（`packages/ai/src/providers/openai-completions.ts:1508`）请求都附加通过 `getOpenAIPromptCacheKey` 派生的 `prompt_cache_key`，以在传输切换之间共享关联标识。
- **通用头前置**：`packages/ai/src/providers/openai-completions.ts` 中的 `prependHeaders` 将 `getKimiCommonHeaders()`（`packages/ai/src/registry/oauth/kimi.ts`）注入所有 `kimi-code` 请求。
- **架构验证和工具选择**：通过 `packages/catalog/src/hosts.ts` 中的 `isMoonshotNative` 进行匹配，强制执行 `toolSchemaFlavor: "moonshot-mfjs"`（`packages/catalog/src/compat/openai.ts`）。强制思考模型（`kimi-for-coding`、`k3`）在 Anthropic 兼容中解析 `requiresThinkingEnabled = true`（`packages/catalog/src/compat/anthropic.ts`），将强制工具选择降级为 `auto`。
- **推理保护**：`stream.ts:1214` 在执行前检查 `isKimiModel`，在 K3 上禁用不支持的推理配置（`packages/ai/src/providers/openai-completions.ts:1454`）。

### 认证与使用
- **设备 OAuth 流程**：`kimiCodeProvider`（`packages/ai/src/registry/kimi-code.ts`）延迟加载 `loginKimi` 和 `refreshKimiToken`（`packages/ai/src/registry/oauth/kimi.ts`）。针对 `${resolveOAuthHost()}`（`https://auth.kimi.com`，可通过 `KIMI_CODE_OAUTH_HOST` 或 `KIMI_OAUTH_HOST` 覆盖）使用 OAuth 2.0 设备代码授权（`CLIENT_ID` `17e5f671-d194-4dfb-9706-5516cb48c098`）。
- **指纹识别和设备持久性**：`getKimiCommonHeaders()` 注入跟踪头（`User-Agent: KimiCLI/<ver>`、`X-Msh-Platform`、`X-Msh-Version`、`X-Msh-Device-Name`、`X-Msh-Device-Model`、`X-Msh-Os-Version`、`X-Msh-Device-Id`）。`getDeviceId` 将随机十六进制 UUID 持久化到 `path.join(getAgentDir(), "kimi-device-id")`（模式 `0600`），如果文件写入失败则回退到内存中的临时 UUID。
- **使用和配额跟踪器**：`kimiUsageProvider`（`packages/ai/src/usage/kimi.ts`）获取 `GET /coding/v1/usages`（`https://api.kimi.com/coding/v1/usages`，可通过 `KIMI_CODE_BASE_URL` 配置）以获取 OAuth 凭据。当令牌过期时（`credential.expiresAt <= nowMs`）会短路。将 `usage` 和 `limits` 解析为 `UsageLimit` 条目，当窗口重置时间不存在时，将行级重置时间戳（`reset_at`、`resetTime`、`ttl`）传递到窗口对象。

### 目录模型处理
- **提供商描述符**：在 `CATALOG_PROVIDERS`（`packages/catalog/src/provider-models/descriptors.ts`）中注册，`id: "kimi-code"`、`defaultModel: "kimi-for-coding"`、发现标签 `"Kimi Code"` 和 `envVars: ["KIMI_API_KEY"]`。通过 `kimiCodeModelManagerOptions` 构建委托选项。
- **动态模型发现**：`packages/catalog/src/provider-models/openai-compat.ts` 中的 `kimiCodeModelManagerOptions` 使用 `KimiCLI/1.0` 头通过 `fetchOpenAICompatibleModels` 查询 `/coding/v1/models`。通过 `kimiSupportsReasoning`、`mapKimiThinking` 和 `mapKimiApiFormat`（将 `compat.kimiApiFormat` 设置为 `"anthropic"` 或 `"openai"`）映射模型。
- **每个系列的输出上限**：`packages/catalog/src/provider-models/openai-compat.ts` 中的 `kimiCodeMaxTokens` 按 ID 派生输出上限：`k3`/`k3-256k` 为 131,072（`KIMI_CODE_K3_MAX_TOKENS`），`kimi-for-coding`/`kimi-for-coding-highspeed` 为 32,768（`KIMI_CODE_FOR_CODING_MAX_TOKENS`），旧版 K2 行的回退值为 32,000（`KIMI_CODE_DEFAULT_MAX_TOKENS`）。在静态生成期间应用（`packages/catalog/scripts/generate-models.ts`）。

## LiteLLM (`litellm`)
LiteLLM 是一个开源 AI 代理和网关，在 OpenAI 兼容的 API 主机后面统一对多个 LLM 提供商的访问。在 `pi` 中，它使用 OpenAI Chat Completions（`openai-completions`）传输管道运行。

### 特殊情况处理
- **推理重放排除（`packages/catalog/src/compat/openai.ts`）**：列在 `PROXY_OPENAI_COMPAT_PROVIDERS` 中。与原生本地运行时（`llama.cpp`、`vllm`）不同，`replayReasoningContent` 默认为 `false`，因为 LiteLLM 代理将回合路由到任意上游提供商（例如 Anthropic、OpenAI），在那里重放 `reasoning_content` 可能会触发 HTTP 400 错误。
- **环回流超时下限（`packages/catalog/src/compat/openai.ts`）**：即使 LiteLLM 从 `isLocalOpenAICompatBackend` 中排除，环回/RFC1918 URL（`localhost`、`127.0.0.1`）仍然参与 `hasLocalLoopbackBaseUrl`，保留本地流超时下限，以避免在前置慢速本地后端时过早预填充超时。
- **Anthropic 和 Bedrock 工具兼容性（`packages/ai/src/providers/openai-completions.ts`）**：
  - 当 `context.tools` 为 `undefined` 但会话历史包含工具调用时，为 Anthropic-via-LiteLLM 兼容性将 `params.tools` 设置为 `[]`。
  - 当 `context.tools` 显式为空（`[]`，例如 `/btw` 或后台回合）时，省略 `params.tools` 和 `tool_choice: "none"`，以使 LiteLLM → Bedrock 路由不生成无效的、空的 `toolConfig` 块。
- **遥测和网关头检测（`packages/ai/src/telemetry.ts`，`packages/ai/src/auth-gateway/http.ts`）**：`detectGatewayFromHeaders` 检查 `x-litellm-call-id`（回退到 `x-litellm-model-id` 或 `x-litellm-model-group`）以填充 `pi.gen_ai.gateway.*` 跨度属性。认证网关 HTTP 端点公开 `x-litellm-model-id`、`x-litellm-model-api-base`、`x-litellm-response-cost` 和 `x-litellm-response-duration-ms`。

### 认证与使用
- **凭据和环境（`packages/catalog/src/provider-models/descriptors.ts`，`packages/ai/src/registry/litellm.ts`）**：通过 `LITELLM_API_KEY` 进行认证。
- **登录引导（`packages/ai/src/registry/litellm.ts`）**：`loginLiteLLM`（通过 `createApiKeyLogin`）将用户引导至设置文档（`https://docs.litellm.ai/docs/proxy/deploy`），提示输入主密钥/虚拟密钥（`sk-...`），并注明自定义代理端点的 `LITELLM_BASE_URL`。CLI `login` 委托给 `SqliteAuthCredentialStore.login()`。
- **默认基础 URL（`packages/catalog/src/provider-models/cache-provider-id.ts`）**：解析为 `Bun.env.LITELLM_BASE_URL` 或 `http://localhost:4000/v1`。

### 目录模型处理
- **捆绑目录排除（`packages/scripts/generate-models.ts`）**：包含在 `DISCOVERY_ONLY_PROVIDERS` 中。LiteLLM 模型从静态 `models.json` 生成中排除，以避免泄露开发人员本地主机端点。
- **丰富的管理端点发现（`packages/catalog/src/provider-models/openai-compat.ts`）**：`fetchLiteLLMRichModels` 探测 `/model_group/info`、`/v2/model/info`、`/model/info` 和 `/v1/model/info`。它过滤哨兵占位符 ID（`all-team-models`、`all-proxy-models`、`no-default-models`）并解析上下文限制（`max_input_tokens`）、输出限制（`max_output_tokens`）、`supports_vision`、`supports_reasoning`、`supported_openai_params`（映射 `reasoning_effort`）和每令牌定价（`input_cost_per_token`、`output_cost_per_token`，缓存读/写成本映射为 $/百万令牌）。
- **回退发现和显示名称（`packages/catalog/src/provider-models/openai-compat.ts`）**：如果丰富端点失败，发现回退到 `/v1/models`（`fetchOpenAICompatibleModels`）并根据 `models.dev` 引用解析规范。从显示名称中剥离经销商乘数后缀（例如 `(1.5x usage)`）。
- **兼容性覆盖（`packages/catalog/src/provider-models/openai-compat.ts`）**：为所有解析的模型硬编码 `compat.supportsStore: false` 和 `compat.supportsDeveloperRole: false`。

## LM Studio (`lm-studio`)
LM Studio 是运行在用户硬件上的本地 OpenAI 兼容模型服务器（默认地址 `http://127.0.0.1:1234/v1`）。它使用 [OpenAI Chat Completions](#openai-chat-completions) 传输（`api: "openai-completions"`）来流式传输聊天补全和工具调用。

### 特殊处理
- **仅字符串命名工具选择**：在 `packages/catalog/src/compat/openai.ts` 的 `STRING_ONLY_NAMED_TOOL_CHOICE_PROVIDERS` 中注册，`supportsNamedToolChoice: false`。对象式强制工具选择（`{ type: "function", function: { name: "..." } }`）被降级为 `"required"`，同时将声明的 `tools` 列表收窄为单个强制工具。
- **语法 Schema 规范化**：在 catalog compat 中配置 `toolSchemaFlavor: "grammar"`（`packages/catalog/src/compat/openai.ts`）。工具 JSON schema 通过 `sanitizeSchemaForGrammar`（`packages/ai/src/utils/schema/normalize.ts`）进行清洗，将属性位置上的裸布尔值 `true` 或 `{}` 子模式扩展为原始类型联合，以避免 GBNF 语法解析器失败（`Unrecognized schema: true`，issue #5914）。
- **回放推理内容 & 仅追加上下文**：包含在 `LOCAL_OPENAI_COMPAT_PROVIDERS`（`packages/catalog/src/compat/openai.ts`）和 `LOCAL_INFERENCE_PROVIDERS`（`packages/coding-agent/src/config/append-only-context-mode.ts`）中。`replayReasoningContent` 自动为本地推理模型启用，以便在多轮对话中通过本地聊天模板在 `reasoning_content` 中保留 `<think>` 块以命中 KV 缓存；`qwenPreserveThinking` 也为 Qwen 思考方言启用。
- **静态目录生成器排除**：列于 `DISCOVERY_ONLY_PROVIDERS`（`scripts/generate-models.ts`）和 `LOCAL_ONLY_PROVIDERS`（`test/models-json-no-local-endpoints.test.ts`），确保本地端点在构建期间永远不会被获取，也不会被提交到静态的 `models.json` 中。

### 流行为
- **看门狗超时下限**：配置 `streamFirstEventTimeoutMs: 0`（`packages/catalog/src/compat/openai.ts`），在本地模型冷启动加载或提示预填充期间禁用预响应的首事件看门狗，并设置 `streamIdleTimeoutMs: 300_000`（300 秒事件间下限；参见 [Provider compat reference](./provider-compat-reference.md)），以防止在慢速 token 生成期间流被取消。

### 认证 & 使用
- **无密钥本地认证**：定义为无密钥提供者（`packages/ai/src/registry/lm-studio.ts` 中的 `lmStudioProvider`，`packages/catalog/src/provider-models/descriptors.ts` 中的 `allowUnauthenticated: true`）。当未提供 `LM_STUDIO_API_KEY` 时，使用 `DEFAULT_LOCAL_TOKEN = "lm-studio-local"`。
- **端点 & 凭据**：基础 URL 默认为 `http://127.0.0.1:1234/v1` 或 `LM_STUDIO_BASE_URL`。交互式 CLI 登录使用 `loginLmStudio`（`packages/ai/src/registry/lm-studio.ts` 中的 `createApiKeyLogin`）。
- **用量统计**：采用标准 OpenAI Chat Completions 用量统计（`packages/ai/src/providers/openai-shared.ts` 中的 `calculateOpenAIUsageAccounting`）。

### 目录模型处理
- **隐式 & 动态发现**：当未配置时，`ModelRegistry`（`packages/coding-agent/src/config/model-registry.ts`）自动将 `lm-studio` 注册为隐式可发现提供者。动态模型解析（`packages/catalog/src/provider-models/openai-compat.ts` 中的 `lmStudioModelManagerOptions` / `packages/coding-agent/src/config/model-discovery.ts` 中的 `discoverLmStudioModels`）查询 `/v1/models`。
- **原生元数据探测**：通过 `fetchLmStudioNativeModelMetadata` 探测 LM Studio 的原生端点 `/api/v0/models`（使用 `LM_STUDIO_NATIVE_METADATA_TIMEOUT_MS = 250`）。当 `type === "vlm"` 或能力包含 `vision`/`image` 时，设置 `input: ["text", "image"]`（在发现期间设置 `imageInputDecoder: "stb"`）。
- **已加载上下文长度**：`getLmStudioNativeContextWindow` 优先使用活动模型的 `loaded_context_length`，而不是架构上限（`max_context_length`、`context_length`、`max_model_len`），确保上下文窗口限制准确反映当前的 VRAM/RAM 分配。

## Meta Model API (`meta`)
Meta Model API 是 Meta 的商业 API 平台，托管如 `muse-spark-1.1` 等第一方模型。它通过面向 `https://api.meta.ai/v1` 的 OpenAI Responses 传输与模型服务交互。

### 特殊处理
- **输出 Token 限制绕过**：`resolveOpenAIResponsesOutputClamp`（`packages/ai/src/providers/openai-shared.ts`）检查 `model.provider === "meta"`，以允许 Meta 请求输出高达 `model.maxTokens`（131,072 token），而不是被默认的 64,000 token 上限（`OPENAI_MAX_OUTPUT_TOKENS`）限制。

### 认证 & 使用
- **API 密钥登录**：通过 `loginMeta` / `metaProvider`（`packages/ai/src/registry/meta.ts`）配置，使用 `createApiKeyLogin` 和控制面板 URL `https://developer.meta.com/ai/`。验证通过向 `https://api.meta.ai/v1/models` 发送 GET 请求进行。
- **环境变量**：密钥解析首先检查 `MODEL_API_KEY`，回退到 `META_API_KEY`（`packages/catalog/src/provider-models/descriptors.ts`）。

### 目录模型处理
- **描述符 & 管理**：在 `CATALOG_PROVIDERS`（`packages/catalog/src/provider-models/descriptors.ts`）中定义，`defaultModel: "muse-spark-1.1"`。使用 `metaModelManagerOptions`（`packages/catalog/src/provider-models/openai-compat.ts`），通过 `createOpenAICompatibleModelManagerOptions`（`api: "openai-responses"`，`providerId: "meta"`，`defaultBaseUrl: "https://api.meta.ai/v1"`，`mapModel: mapWithBundledReference`）构建。
- **静态捆绑模型**：`META_MUSE_STATIC_MODELS`（`packages/catalog/src/provider-models/openai-compat.ts`）定义 `muse-spark-1.1`：
  - 1,048,576 token 上下文窗口和 131,072 token 最大输出限制。
  - 多模态输入支持（`text`、`image`）。
  - 启用推理，支持基于 effort 的思考级别（`minimal`、`low`、`medium`、`high`、`xhigh`）。
  - 兼容性标志 `supportsReasoningEffort: true` 和 `includeEncryptedReasoning: true`。

## MiniMax (`minimax`)
MiniMax 提供基础模型（包括 MiniMax-M3 和 M2 代），可通过区域国际端点（`api.minimax.io`）和中国大陆端点（`api.minimaxi.com`）访问。传输取决于描述符类型：标准的 `minimax` 和 `minimax-cn` 使用 "Anthropic Messages"（`/anthropic`），而 MiniMax Token Plan 的 `minimax-code` 和 `minimax-code-cn` 使用 "OpenAI Chat Completions"（`/v1`）。

### 特殊处理
- **累积推理增量**：`packages/catalog/src/compat/openai.ts` 中的 `MINIMAX_PROVIDER_OR_ID_PATTERN` 标记 `reasoningDeltasMayBeCumulative: true`，适用于任何匹配 `/minimax/i` 的提供者或模型 ID，防止流重新发送累积思考文本时出现重复的推理内容。
- **对象工具参数**：`packages/ai/src/providers/openai-completions.ts` 中的 `streamOpenAICompletions` 拦截以原始 JSON 对象而非标准 JSON 字符串流式传输 `function.arguments` 的 MiniMax 兼容主机，将对象增量深度合并到 `block.partialArgs` 中，并在 `finishToolCallBlock` 之前的 `toolcall_end` 处序列化单个可安全连接的字符串增量。
- **单系统消息约束**：`packages/catalog/src/compat/openai.ts` 中的 `isMiniMaxHost`（在 `packages/catalog/src/hosts.ts` 中匹配 `api.minimax.io` 和 `api.minimaxi.com`）将 `supportsMultipleSystemMessagesDefault` 设置为 `false`，要求将系统提示合并为单个系统消息。
- **思考 effort 限制**：`packages/catalog/src/identity/family.ts` 中的 `isMinimaxM2FamilyModelId` 对 M2/M3 模型强制 `low|medium|high` 的允许 `reasoning_effort`，并拒绝 `minimal`/`xhigh`。
- **带内 XML 方言**：`packages/ai/src/dialect/minimax.ts` 注册 `minimax` 方言（`<minimax:tool_call>`），用于回退 XML 工具调用解析。
- **网关 API 覆盖**：`packages/catalog/src/provider-models/openai-compat.ts` 中的 `OPENCODE_ZEN_API_RESOLUTION` 和 `OPENCODE_GO_API_RESOLUTION` 在 OpenCode 网关上强制将 `minimax-m3` / `minimax-m3-free` / `minimax-m2.7` 通过 `openai-completions` 在 `/v1/chat/completions` 上路由，而不是 Anthropic 的 `/v1/messages`。

### 认证 & 使用
- **认证密钥**：使用在 `packages/catalog/src/provider-models/descriptors.ts` 中声明的 `MINIMAX_API_KEY`（`minimax`）、`MINIMAX_CODE_API_KEY`（`minimax-code`）和 `MINIMAX_CODE_CN_API_KEY`（`minimax-code-cn`）。
- **Token Plan 登录**：`packages/ai/src/registry/oauth/minimax-code.ts` 中的 `loginMiniMaxCode` 和 `loginMiniMaxCodeCn` 驱动浏览器登录流程，分别到 `platform.minimax.io`（国际）和 `platform.minimaxi.com`（中国），提示并验证针对模型 `MiniMax-M3` 的 API 密钥设置。
- **使用配额**：`packages/ai/src/usage/minimax-code.ts` 中的 `minimaxCodeUsageProvider` 在 `https://api.minimax.io`（或中国对应端点）上轮询 `GET /v1/token_plan/remains`，按计划桶解析滚动间隔和每周使用窗口的剩余百分比，以用于 `omp usage`。

### 目录模型处理
- **默认模型**：`MiniMax-M3` 在 `packages/catalog/src/provider-models/descriptors.ts` 中设置（`minimax`、`minimax-code`、`minimax-code-cn`）。
- **上下文窗口策略**：`scripts/generated-policies.ts` 将 `minimax`、`minimax-cn`、`minimax-code` 和 `minimax-code-cn` 的 `MiniMax-M3` 上下文限制覆盖为 1,000,000 token，与文档化的 1M 长上下文层级匹配，超过上游定价边界。
- **OpenAI completions 标志**：`packages/catalog/src/provider-models/openai-compat.ts` 中的 `openAiCompletionsDescriptor` 配置 `supportsStore: false`、`supportsDeveloperRole: false`、`supportsReasoningEffort: false` 和 `reasoningContentField: "reasoning_content"`。

## MiniMax Token Plan (`minimax-code`)
MiniMax Token Plan 提供者（`minimax-code`，以及其中国大陆区域变体 `minimax-code-cn`）使用 HTTP POST SSE 上的 OpenAI Chat Completions 传输提供对 MiniMax 订阅模型（如 `MiniMax-M3` 和 `MiniMax-M2.5`）的访问（国际为 `https://api.minimax.io/v1`，中国为 `https://api.minimaxi.com/v1`）。与通过使用标准静态 API 密钥认证的 Anthropic Messages 传输路由的普通 `minimax` 相比，`minimax-code` 使用交互式订阅登录流程，并通过 `omp usage` 提供 token 计划配额监控。

### 特殊处理
- **与普通 `minimax` 的传输差异**：普通 `minimax`（`minimax` / `minimax-cn`）通过 `anthropic-messages` 传输（`https://api.minimax.io/anthropic`）通信，而 `minimax-code`（`minimax-code` / `minimax-code-cn`）目标是 `openai-completions` 传输（`/v1/chat/completions`）。
- **流式对象工具调用参数**：`packages/ai/src/providers/openai-completions.ts` 中的 `mergeStreamingArgumentObjects` 处理将 `function.arguments` 作为部分 JSON 对象而非标准 OpenAI JSON 字符串流式传输的 MiniMax 后端，跨增量深度合并对象属性以防止 `[object Object]` 字符串强制转换。
- **推理内容 & 思考标签去重**：配置 `reasoningContentField: "reasoning_content"`（`packages/catalog/src/provider-models/openai-compat.ts`）。提供者将内联 `<think>`...`</think>` 标签解析为思考块，同时对 MiniMax-M3 累积推理快照进行去重，以防止在可见答案内容开始后重新发出思考文本。
- **兼容性标志限制**：OpenAI 兼容性策略明确禁用 `store`、开发者系统角色和推理 effort 控制（`packages/catalog/src/provider-models/openai-compat.ts` 中的 `supportsStore: false`、`supportsDeveloperRole: false`、`supportsReasoningEffort: false`）。

### 认证 & 使用
- **交互式订阅登录流程**：通过 `packages/ai/src/registry/oauth/minimax-code.ts` 中的 `createApiKeyLogin` 实现（由 `packages/ai/src/registry/minimax-code.ts` 和 `minimax-code-cn.ts` 延迟加载）。尽管位于 `oauth/` 之下，但这是一个交互式 API 密钥提示，而不是 OAuth PKCE：它打开区域订阅门户（国际为 `https://platform.minimax.io/subscribe/token-plan`，中国为 `https://platform.minimaxi.com/subscribe/token-plan`），提示输入密钥（`sk-...`），并通过使用 `MiniMax-M3` 的 `POST /v1/chat/completions` 请求验证密钥。
- **环境变量**：从国际 `minimax-code` 的 `MINIMAX_CODE_API_KEY` 和中国 `minimax-code-cn` 的 `MINIMAX_CODE_CN_API_KEY` 解析凭据（普通 `minimax` 解析 `MINIMAX_API_KEY` / `MINIMAX_CN_API_KEY`）。
- **Token Plan 配额跟踪**：`packages/ai/src/usage/minimax-code.ts` 中的 `minimaxCodeUsageProvider` 使用 `Authorization: Bearer ${apiKey}` 查询 `GET /v1/token_plan/remains`。
- **配额指标解析 & 规范化**：将 `model_remains[]` 条目解析为滚动间隔窗口（`current_interval_*`）和 7 天窗口（`current_weekly_*`）。共享计划配额 `general` 作用域为 `{ shared: true }`。通过 `(100 - remainingPercent) / 100` 计算 `usedFraction`，并在 `current_*_status === 2`（`STATUS_EXHAUSTED`）时覆盖状态。计划外模型（状态 3 `STATUS_UNLIMITED` 且总额为零）被过滤到 `metadata.unavailableModels` 中。通过 `base_resp.status_code === 0` 验证成功，以捕获 HTTP 200 响应下返回的 API 错误。

### 目录模型处理
- **提供者描述符**：在 `packages/catalog/src/provider-models/descriptors.ts`（`id: "minimax-code"`，`id: "minimax-code-cn"`）中注册，默认为 `MiniMax-M3`。
- **目录连接**：`packages/catalog/src/provider-models/openai-compat.ts` 中的 `openAiCompletionsDescriptor` 将描述符 `"minimax-coding-plan"` 和 `"minimax-cn-coding-plan"` 绑定到基础 URL `https://api.minimax.io/v1` 和 `https://api.minimaxi.com/v1`。
- **1M 上下文层级覆盖**：策略生成（`packages/catalog/scripts/generated-policies.ts`）显式将 `minimax-code` 和 `minimax-code-cn` 的 `MiniMax-M3` 上下文窗口覆盖为文档化的 1,000,000 token 层级，而不是上游的 512,000 token 定价边界。
- **主机匹配**：`packages/catalog/src/hosts.ts` 中的提供者主机映射将 `urlMarkers` `api.minimax.io` 和 `api.minimaxi.com` 与 `minimax`、`minimax-code` 和 `minimax-code-cn` 关联。

## MiniMax Token Plan (China) (`minimax-code-cn`)
MiniMax Token Plan (China) 使用 OpenAI Chat Completions 传输（`openai-completions`）为中国大陆订阅者提供对 MiniMax 模型的访问。它连接到中国区域端点进行订阅、API 密钥验证和模型执行。

### 特殊处理
- **流式参数深度合并**：`packages/ai/src/providers/openai-completions.ts` 中的 `mergeStreamingArgumentObjects` 处理将 `function.arguments` 作为原始 JSON 对象而非标准 OpenAI JSON 字符串流式传输的 MiniMax 后端，在流块之间递归合并部分对象增量，而不会失败或将参数强制转换为 `[object Object]`（`test/issue-1776-repro.test.ts`、`test/issue-2080-repro.test.ts`）。
- **推理去重 & 思考标签**：内容流中传递的 `<think>` 标签被规范化为思考块（`test/issue-1203-repro.test.ts`），而 `packages/ai/src/dialect/demotion.ts` 中的 `lastCumulativeReasoningBySignature` 和 `streamOpenAICompletionsOnce`（`packages/ai/src/providers/openai-completions.ts`）在文本块转换之间对 `MiniMax-M3` 的累积推理快照进行去重。
- **不支持的功能剥离**：请求省略不支持的思考选项（`test/issue-955-repro.test.ts`），并在 `packages/catalog/src/provider-models/openai-compat.ts` 中应用静态兼容性覆盖（`supportsStore: false`、`supportsDeveloperRole: false`、`supportsReasoningEffort: false`、`reasoningContentField: "reasoning_content"`）。

### 认证 & 使用
- **API 密钥 & 交互式登录**：通过 `MINIMAX_CODE_CN_API_KEY`（`packages/catalog/src/provider-models/descriptors.ts`）进行认证。交互式登录（`packages/ai/src/registry/oauth/minimax-code.ts` 中的 `loginMiniMaxCodeCn`）打开 `https://platform.minimaxi.com/subscribe/token-plan`，并通过针对 `https://api.minimaxi.com/v1` 的 `MiniMax-M3` 补全检查验证粘贴的密钥。
- **端点 & 主机检测**：API 请求目标是 `https://api.minimaxi.com/v1`（`packages/catalog/src/models.json`）。`packages/catalog/src/hosts.ts` 中 `minimax` 主机分类下的 `urlMarkers` 包含 `api.minimaxi.com`。
- **使用遥测可用性**：与 `minimax-code`（通过 `packages/ai/src/usage/minimax-code.ts` 中的 `minimaxCodeUsageProvider` 从 `https://api.minimax.io/v1/token_plan/remains` 获取配额剩余百分比）不同，`minimax-code-cn` 没有注册使用提供者（`packages/ai/src/auth-storage.ts` 和 `test/minimax-token-plan-usage.test.ts` 中 `storage.usageProviderFor("minimax-code-cn")` 返回 `undefined`），因此中国区域账户的使用遥测被禁用。

### 目录模型处理
- **默认模型**：在 `CATALOG_PROVIDERS`（`packages/catalog/src/provider-models/descriptors.ts`）中配置默认为 `MiniMax-M3`。
- **1M 上下文窗口覆盖**：`packages/catalog/scripts/generated-policies.ts` 将 `minimax-code-cn`（以及 `minimax-code`、`minimax` 和 `minimax-cn`）的 `MiniMax-M3` 上下文窗口从上游 512K 定价边界覆盖为 1,000,000（1M）token（`model.contextWindow = 1_000_000`）。
- **目录策略覆盖**：`generated-policies.ts` 从 `model.compat` 中移除 `thinkingFormat`，并强制 `reasoningContentField: "reasoning_content"`、`supportsStore: false`、`supportsDeveloperRole: false` 和 `supportsReasoningEffort: false`。

## Mistral (`mistral`)
Mistral AI 通过 `api.mistral.ai/v1` 提供对 Mistral、Codestral、Devstral、Ministral 和 Pixtral 模型的访问。请求使用 OpenAI Chat Completions 传输（`openai-completions`）。

### 特殊处理
- **兼容性集群（`packages/catalog/src/compat/openai.ts`：`isMistral`）**：
  - `requiresMistralToolIds` / `toolCallIdKind: "mistral-9-alnum"`（`packages/ai/src/providers/openai-shared.ts`）：将工具调用 ID 限制为 9 个字符的字母数字字符串（`[a-zA-Z0-9]{9}`）。
  - `requiresAssistantAfterToolResult`：在工具结果消息之后、后续内容之前合成助手消息桥接（`packages/ai/src/providers/openai-completions.ts`）。
  - `requiresToolResultName`：要求工具结果消息上具有工具函数 `name` 属性（`packages/ai/src/providers/openai-completions.ts`）。
  - `requiresThinkingAsText`：将推理和思考内容格式化为纯文本块，而不是原生推理字段（`packages/catalog/src/compat/openai.ts`）。
  - `maxTokensField: "max_tokens"`：在请求负载中发出 `max_tokens` 而不是 `max_completion_tokens`（`packages/catalog/src/compat/openai.ts`）。
- **数组 `delta.content` 流式规范化（`packages/ai/src/providers/openai-completions.ts`：`normalizeStreamingContentText`）**：解包模型（例如 `mistral-medium-2604`）将 `delta.content` 作为类型化数组（`[{ type: "text", text: "..." }]`）传递的流式响应块，防止 `[object Object]` 字符串强制转换错误。

### 认证 & 使用
- **认证**：使用来自 `MISTRAL_API_KEY` 环境变量（`packages/catalog/src/provider-models/descriptors.ts`：`mistral`）的 Bearer 令牌进行认证。
- **使用跟踪**：标准 OpenAI Chat Completions 使用解析（`packages/ai/src/providers/openai-completions.ts`）。

### 目录模型处理
- **提供者描述符**：通过 `mistralModelManagerOptions` 配置，指向 `https://api.mistral.ai/v1`（`packages/catalog/src/provider-models/openai-compat.ts`），默认模型为 `devstral-medium-latest`（`packages/catalog/src/provider-models/descriptors.ts`）。
- **主机匹配**：主机 URL 标记匹配检查 `mistral.ai`（`packages/catalog/src/hosts.ts`：`mistral`）。

## Moonshot (`moonshot`)
Moonshot 是 Moonshot AI 端点（`https://api.moonshot.ai/v1` 或中国大陆 `https://api.moonshot.cn/v1`）的按需付费开放平台提供者。它使用 `OpenAI Chat Completions` 传输引擎（`openai-completions` API 接口），并共享 Kimi 系列方言和思考机制（`packages/catalog/src/identity/family.ts` 中的 `isKimiModelId`）。它与使用订阅设备 OAuth 和订阅端点（`api.kimi.com` / `/coding/v1/*`）的 `kimi-code` 不同。

### 特殊处理
- **`MOONSHOT_BASE_URL` 覆盖**：`resolveOpenAIRequestSetup`（`packages/ai/src/providers/openai-shared.ts`）使用 `$env.MOONSHOT_BASE_URL`（例如，针对其密钥被国际端点拒绝的中国大陆平台用户的 `https://api.moonshot.cn/v1`；issue #2883）覆盖默认目录基础 URL（`api.moonshot.ai/v1`）。
- **Moonshot 风格 JSON Schema（`moonshot-mfjs`）**：对于原生 Moonshot 主机（`packages/catalog/src/hosts.ts` 中的 `moonshotNative`）和通过 `buildOpenAICompat`（`packages/catalog/src/compat/openai.ts`）的 Kimi 模型 ID（`isKimiModel`），`toolSchemaFlavor` 默认为 `"moonshot-mfjs"`。`normalizeSchemaForMoonshot`（`packages/ai/src/utils/schema/normalize.ts`）规范化工具参数（将 `const` 折叠到 `enum` 中，在裸枚举上推断 `type`，剥离不支持的结构）在 `packages/ai/src/providers/openai-completions.ts` 和 `openai-responses.ts` 中以防止 HTTP 400 验证失败（`tools.function.parameters is not a valid moonshot flavored json schema`）。
- **Z.AI 思考格式 & 保留思考**：`packages/catalog/src/compat/openai.ts` 中的 `isMoonshotKimi` 设置 `thinkingFormat: "zai"`。对于 `kimi-k2.6`（以及 `kimi-k2.x` 模型），启用 `thinkingKeep: "all"`（`compat/openai.ts` 中的 `usesMoonshotKimiPreservedThinking`）。活动推理轮次在 `openai-completions.ts`（issues #1838、#2113）中发出 `thinking: { type: "enabled", keep: "all" }`（或禁用时为 `{ type: "disabled" }`）。K3 模型通过 `MOONSHOT_KIMI_K3_THINKING`（`packages/catalog/src/provider-models/openai-compat.ts`）使用 OpenAI 风格的 `reasoning_effort: "max"`。
- **流标记修复 & 带内控制标签**：`modelMayLeakKimiToolCalls`（`packages/ai/src/utils/stream-markup-healing.ts`）和 `detectStreamMarkupHealingPattern`（`packages/catalog/src/compat/openai.ts`）对 `provider === "moonshot"` 返回 `"kimi"`，启用对原始带内控制标签（`<|tool_calls_section_begin|>` 等）的流解析。
- **最大 Token 输出上限 & 强制 Token**：`alwaysSendMaxTokens`（`packages/catalog/src/compat/openai.ts`）强制在每个 Kimi 请求上设置 `max_tokens`，因为 Moonshot 从 `max_tokens` 计算 TPM 速率限制。`resolveOpenAIRequestSetup`（`packages/ai/src/providers/openai-shared.ts`）将 K3 模型（`isKimiK3ModelId`）的 `max_tokens` 限制为 `131_072`。
- **推理内容回放要求**：`requiresReasoningContentForToolCalls`（`packages/catalog/src/compat/openai.ts`）强制工具调用继续轮次回放先前的 `reasoning_content`（或合成占位符 `.`），防止 Moonshot 中止或从头开始重新推导推理。

### 认证 & 使用
- **API 密钥认证**：`loginMoonshot`（`packages/ai/src/registry/moonshot.ts`）使用 `createApiKeyLogin` 指向用户到控制面板 `https://platform.moonshot.ai/console/api-keys`。
- **端点验证**：`resolveMoonshotModelsUrl`（`packages/ai/src/registry/moonshot.ts`）通过 `GET ${MOONSHOT_BASE_URL || "https://api.moonshot.ai/v1"}/models`（`kind: "models-endpoint"`）验证密钥。
- **环境变量解析**：`packages/catalog/src/provider-models/descriptors.ts` 中的 `envVars: ["MOONSHOT_API_KEY", "KIMI_API_KEY"]` 接受 `KIMI_API_KEY` 作为未配置 `MOONSHOT_API_KEY` 的中国大陆用户的回退（issue #2883）。
- **无专用使用跟踪器**：令牌使用直接在 `openai-completions` 的 OpenAI 流块 `usage` 对象中返回；`packages/ai/src/usage/` 中不存在单独的使用 API 或文件。

### 目录模型处理
- **描述符注册**：在 `CATALOG_PROVIDERS`（`packages/catalog/src/provider-models/descriptors.ts`）中注册为 `moonshot`，带有 `defaultModel: "kimi-k2.7-code"`、`envVars: ["MOONSHOT_API_KEY", "KIMI_API_KEY"]`，以及 `createModelManagerOptions: moonshotModelManagerOptions`。
- **动态模型发现**：`packages/catalog/src/provider-models/openai-compat.ts` 中的 `moonshotModelManagerOptions` 使用 `createOpenAICompatibleModelManagerOptions`，`defaultBaseUrl: Bun.env.MOONSHOT_BASE_URL ?? "https://api.moonshot.ai/v1"`。
- **动态 K3 & K2.x 模型映射**：在 `moonshotModelManagerOptions`（`packages/catalog/src/provider-models/openai-compat.ts`）中：
  - 未引用的 `kimi-k3` 条目标记有 `reasoning: true`、输入 `["text", "image"]`、`MOONSHOT_KIMI_K3_COST`、`contextWindow: 1_000_000`、`maxTokens: 131_072`，以及基于 effort 的 `thinking` 配置（issue #5756）。
  - `kimi-k2.x` 条目（例如 `kimi-k2.5`、`kimi-k2.6`）标记有 `reasoning: true`、视觉 `["text", "image"]` 和多层 effort（`[Minimal, Low, Medium, High]`），确保生成 `thinking` 负载，使模型不会停滞（issue #2113）。
- **主机 & 优先级令牌分类**：`packages/catalog/src/hosts.ts` 中的主机标记 `moonshotNative`（`urlMarkers: ["api.moonshot.ai", "api.kimi.com"]`）映射原生 Moonshot 端点。`packages/catalog/src/identity/priority.ts` 中的系列优先级令牌将 `"moonshot"` 排在 `"kimi-code"` 之后。

## NanoGPT (`nanogpt`)
NanoGPT 是一个按 token 计费的 API 网关，通过 OpenAI 兼容接口公开各种开源权重和商业语言模型。它使用 OpenAI Chat Completions 传输（`openai-completions`）执行请求，默认基础 URL 为 `https://nano-gpt.com/api/v1`。

### 特殊处理
- **DSML 泄漏修复**：NanoGPT 包含在 `packages/ai/src/utils/stream-markup-healing.ts` 的 `modelMayLeakDsmlToolCalls` 中。在 NanoGPT 上托管的 DeepSeek 模型（如 `nanogpt/deepseek/deepseek-v4-pro`）在流式传输期间泄漏 `<｜DSML｜tool_calls>...</｜DSML｜tool_calls>` 文本信封，被路由到 `getStreamMarkupHealingPattern("nanogpt", modelId)` 以将流修复为结构化工具调用。
- **直接路由执行**：NanoGPT 避免在 DeepSeek 请求上附加 `:tools` 模型路由后缀，防止由 NanoGPT 的服务器端工具解析器在复杂 schema 上触发的 `502` 错误（`code: "malformed_tool_call"`）。
- **索引工具增量保留**：依赖 `streamOpenAICompletionsOnce`（`packages/ai/src/providers/openai-completions.ts`）中的 `tool_calls[].index` 跟踪，以确保来自 NanoGPT 的并行流式工具调用不会在增量之间合并或丢弃参数。

### 认证 & 使用
- **API 密钥 & 环境变量**：通过 `NANO_GPT_API_KEY` 进行认证（通过 `packages/ai/src/stream.ts` 中的 `getEnvApiKey` 解析并在 `packages/catalog/src/provider-models/descriptors.ts` 的目录描述符中配置）。
- **交互式登录**：`packages/ai/src/registry/nanogpt.ts` 中的 `loginNanoGPT` 提示输入从 `https://nano-gpt.com/api` 链接的 API 密钥，并通过针对 `https://nano-gpt.com/api/v1/models` 的 `models-endpoint` 验证凭据。

### 目录模型处理
- **描述符 & 选项**：在 `CATALOG_PROVIDERS`（`packages/catalog/src/provider-models/descriptors.ts`）中注册，默认模型为 `openai/gpt-5.5`，选项通过 `nanoGptModelManagerOptions`（`packages/catalog/src/provider-models/openai-compat.ts`）配置。
- **模型变体过滤**：在 `fetchDynamicModels` 的动态发现过程中，匹配 `NANO_GPT_NON_TEXT_MODEL_TOKENS`（例如 `embedding`、`image`、`vision`、`audio`、`speech`、`transcribe`、`moderation`、`realtime`、`whisper`、`tts`）中非文本令牌的模型被 `isLikelyNanoGptTextModelId` 过滤掉。
- **思考变体检测**：具有 `:thinking` 或 `:thinking:<level>` 后缀的模型由 `NANO_GPT_THINKING_SUFFIX_RE` 匹配并从模型列表中排除，而其基础模型 ID 记录在 `thinkingBaseIds` 中，以将相应基础模型标记为具有推理能力（`model.reasoning = true`）。

## Novita (`novita`)
Novita AI 是一个 AI 云平台，通过 `https://api.novita.ai/openai/v1` 上的 OpenAI Chat Completions 传输为开源模型提供无服务器 OpenAI 兼容 LLM 推理。

### 特殊处理
- 除了 OpenAI Chat Completions 管道之外没有任何特殊处理。

### 认证 & 使用
- **认证**：通过 `loginNovita`（`packages/ai/src/registry/novita.ts`）使用标准 API 密钥提示（`sk_...`）配置，链接到 `https://novita.ai/settings/key-management`。环境变量 `NOVITA_API_KEY` 通过目录描述符（`packages/catalog/src/provider-models/descriptors.ts`）检查。
- **基于推理的密钥验证**：`loginNovita`（`packages/ai/src/registry/novita.ts`）通过使用 `moonshotai/kimi-k2.7-code` 向 `/chat/completions` 发送 1 个 token 的请求来验证密钥。Novita 的 Developer 和 Basic 团队角色没有 `/openapi/v1/billing/balance/detail` 的权限，因此推理验证避免拒绝有效的开发者密钥。

### 目录模型处理
- **模型发现**：通过 `novitaModelManagerOptions`（`packages/catalog/src/provider-models/openai-compat.ts`）配置，`defaultBaseUrl: "https://api.novita.ai/openai/v1"`，`dynamicModelsAuthoritative: true`。
- **未认证发现**：描述符设置 `catalogDiscovery.allowUnauthenticated: true`（`packages/catalog/src/provider-models/descriptors.ts`），允许从 `/openai/v1/models` 进行公共目录检索而无需 API 密钥。
- **模型过滤**：`filterModel` 验证活动状态（`status === 1` 或非数字），要求 `endpoints` 包含 `"chat/completions"`，检查正 `max_output_tokens`，并使用 `isPublicNovitaModelId` 排除内部测试模型 ID（排除以 `ai_infer_test` 开头的前缀）。
- **成本缩放**：`toNovitaCostPerMillion` 通过除以 10,000 将价格字段（`input_token_price_per_m`、`output_token_price_per_m`、`pricing.input_cache_read.price_per_m`）转换，将 Novita 的 1/10,000 美元/百万 token 速率缩放为标准美元/百万 token。
- **能力 & 元数据**：`mapNovitaModel` 通过 `novitaArrayIncludes` 检查 `features` 是否包含 `"reasoning"` 和 `"function-calling"`，使用 `toInputCapabilities` 解析输入模态，并提取上下文/输出窗口边界。

## NVIDIA (`nvidia`)
NVIDIA NIM（推理微服务）通过 OpenAI Chat Completions 传输（`openai-completions` API）提供对托管的开源和专有基础模型的访问。基础端点默认为 `https://integrate.api.nvidia.com/v1`。

### 特殊处理
- **Qwen 思考格式**：主机 `nvidia`（`integrate.api.nvidia.com`，`packages/catalog/src/hosts.ts:63`）将 Qwen 模型（`isQwen`）路由到 `thinkingFormat: "qwen-chat-template"`（`packages/catalog/src/compat/openai.ts:452`）。顶级 `enable_thinking` 被 NIM 严格的请求 schema（`additionalProperties: false`）拒绝，因此思考通过 `chat_template_kwargs.enable_thinking` 传递。
- **DeepSeek Token 剥离 & DSML 标记**：在 `provider === "nvidia"`（`packages/catalog/src/compat/openai.ts:596,755`）下，DeepSeek 模型设置 `stripDeepseekSpecialTokens` 为 `true`，从可见输出中剥离泄漏的原始 `<｜DSML｜...｜>` 信封和思考标签（`packages/ai/test/openai-completions-compat.test.ts:2096-2216`）。在 `modelMayLeakDsmlToolCalls`（`packages/ai/src/utils/stream-markup-healing.ts:227`）中注册以进行流标记修复。
- **工具选择 & 推理**：DeepSeek 推理模型在工具选择处于活动状态时禁用推理（`disableReasoningOnToolChoice`，`packages/catalog/src/compat/openai.ts:487`），而标准模型支持强制工具选择（`supportsForcedToolChoice: true`，`packages/ai/test/openai-completions-compat.test.ts:1801`）。

### 认证 & 使用
- **认证**：使用 NVIDIA NGC 个人密钥（`AUTH_URL = "https://org.ngc.nvidia.com/setup/personal-keys"`，`packages/ai/src/registry/nvidia.ts:6`）进行基于密钥的认证，存储在 `NVIDIA_API_KEY`（`packages/catalog/src/provider-models/descriptors.ts:316`）中。基础 URL 是 `API_BASE_URL = "https://integrate.api.nvidia.com/v1"`（`packages/ai/src/registry/nvidia.ts:7`）。
- **登录 & 验证**：CLI 登录（`loginNvidia`，`packages/ai/src/registry/nvidia.ts:12`）使用 `validateOpenAICompatibleApiKey` 针对 `VALIDATION_MODEL = "nvidia/llama-3.1-nemotron-70b-instruct"`（`packages/ai/src/registry/nvidia.ts:8`）验证密钥。致命认证错误（`401`/`403`，`AIError.Flag.AuthFailed`）中止登录；非致命验证错误被捕获以允许自定义或新部署的模型。
- **提供者注册**：注册为 `nvidiaProvider`（`packages/ai/src/registry/nvidia.ts:57`，`packages/ai/src/registry/registry.ts:126`）。凭据存储和去重在 `packages/ai/test/auth-storage-email-dedupe.test.ts:756-775` 中测试。
- **使用**：标准 OpenAI Chat Completions 使用指标；无自定义使用处理程序或配额端点。

### 目录模型处理
- **描述符 & 选项**：通过 `nvidiaModelManagerOptions`（`packages/catalog/src/provider-models/openai-compat.ts:1072`）和 `openAiCompletionsDescriptor`（`packages/catalog/src/provider-models/openai-compat.ts:5675`）配置。
- **默认值**：默认上下文窗口为 `131072`（`packages/catalog/src/provider-models/openai-compat.ts:5676`）。默认模型为 `nvidia/llama-3.1-nemotron-70b-instruct`（`packages/catalog/src/provider-models/descriptors.ts:315`）。
- **目录发现**：在目录描述符中注册，带有 `catalogDiscovery: { label: "NVIDIA" }`（`packages/catalog/src/provider-models/descriptors.ts:318`）。

## Ollama (`ollama`)
本地 OpenAI 兼容提供者集成，运行在本地或自托管的 Ollama 实例上（默认为基础 URL `http://127.0.0.1:11434/v1`）。发现的模型使用共享的 Ollama 和 OpenAI Responses 传输引擎。

### 特殊处理
- **工具调用错误重写**：`packages/ai/src/error/format.ts` 中的 `rewriteOllamaToolCallJsonError` 拦截来自本地 `llama.cpp` 后端的 HTTP 500 工具调用 JSON 解析失败，匹配 `LLAMA_CPP_TOOL_CALL_PARSE_PATTERN`，并将其重写以解释上下文溢出期间确定性模型输出降级。
- **空长度完成上下文错误**：在 `buildOpenAICompat`（`packages/catalog/src/compat/openai.ts`）中，当 `provider === "ollama"` 时，`emptyLengthFinishIsContextError` 设置为 `true`，将具有 `finish_reason: "length"` 的空补全视为上下文溢出错误。
- **KV 缓存推理回放**：`packages/catalog/src/compat/openai.ts` 中的 `LOCAL_OPENAI_COMPAT_PROVIDERS` 包含 `"ollama"`，自动启用 `OpenAICompat.replayReasoningContent`，以便本地 Qwen3 / DeepSeek-R1 / GLM 聊天模板在多轮对话中重建先前的 `<think>` 块，以实现字节相同的前缀 KV 缓存重用。
- **DSML 工具调用标记修复**：`packages/ai/src/utils/stream-markup-healing.ts` 中的 `modelMayLeakDsmlToolCalls` 和 `packages/catalog/src/compat/openai.ts` 中的 `DSML_HEALING_PROVIDERS` 包含 `"ollama"`，以修复可见文本流中泄漏的 DeepSeek DSML 工具调用信封。
- **线协议推理 Effort 阶梯**：`packages/catalog/src/model-thinking.ts` 中的 `spec.provider === "ollama"` 返回 `OLLAMA_REASONING_EFFORTS`（`[low, medium, high, max]`），匹配 Ollama 的原生线协议 effort 词汇表，而不需要兼容性级别的 effort 重映射。

### 认证 & 使用
- **交互式登录 & 可选密钥**：`packages/ai/src/registry/ollama.ts` 中的 `loginOllama` 通过 `options.onPrompt` 提示输入可选 API 密钥/令牌（`allowEmpty: true`，占位符 `"ollama-local"`），指向 `OLLAMA_DOCS_URL`；返回 `""` 表示本地无密钥模式。`ollamaProvider` 注册 `loginOllama`。
- **使用提供者 & 配额显示**：`packages/ai/src/usage/ollama.ts` 中的 `ollamaUsageProvider`（`id: "ollama"`）实现 `fetchUsage`，返回带有空 `limits` 和不公开独立配额端点说明的 `UsageReport`；`validatesCredentials` 设置为 `false`。
- **环境变量回退**：`CATALOG_PROVIDERS`（`packages/catalog/src/provider-models/descriptors.ts`）中的 `envVars: ["OLLAMA_API_KEY"]` 从 `process.env.OLLAMA_API_KEY` 解析可选调用者凭据。

### 目录模型处理
- **描述符 & 无密钥注册**：`packages/catalog/src/provider-models/descriptors.ts` 中的 `CATALOG_PROVIDERS` 注册 `id: "ollama"`，带有 `defaultModel: "gpt-oss:20b"`、`envVars: ["OLLAMA_API_KEY"]`、`allowUnauthenticated: true`（允许在没有密钥的情况下创建模型管理器），以及委托给 `ollamaModelManagerOptions` 的 `createModelManagerOptions`。
- **静态包排除**：`scripts/generate-models.ts` 中的 `DISCOVERY_ONLY_PROVIDERS` 包含 `"ollama"`，防止本地端点将特定于机器的 localhost 模型烘焙到已提交的 `models.json` 中。
- **动态模型发现**：`packages/catalog/src/provider-models/openai-compat.ts` 中的 `ollamaModelManagerOptions` 通过 `normalizeOllamaBaseUrl`（默认为 `http://127.0.0.1:11434/v1`）规范化端点，并使用 `fetchOpenAICompatibleModels`（`packages/catalog/src/discovery/openai-compatible.ts`）查询 `/v1/models`。如果 `/v1/models` 不可用或为空，则回退到本地的 `fetchOllamaNativeModels`，查询 `toOllamaNativeBaseUrl`（`http://127.0.0.1:11434`）上的 `/api/tags`。
- **能力探测 & 上下文长度标记**：`packages/catalog/src/provider-models/openai-compat.ts` 中的 `fetchOllamaShowMetadata` 通过 `createOllamaMetadataResolver` 将 `{ model: modelId }` 提交到 `/api/show`。它从匹配 `.context_length`、`.num_ctx` 或 `.context_window` 的 `model_info` 键中提取上下文长度（回退到 `OLLAMA_FALLBACK_CONTEXT_WINDOW` = 128,000 和 `OLLAMA_DEFAULT_MAX_TOKENS` = 8,192）。`capabilities.includes("thinking")` 设置 `reasoning: true` 并配置 `thinking` effort（`[minimal, low, medium, high]`），而 `capabilities.includes("vision")` 标记 `input: ["text", "image"]`。
- **模型缓存分区**：`ollamaModelManagerOptions` 中的 `cacheProviderId` 调用 `resolveModelCacheProviderId`（`packages/catalog/src/provider-models/cache-provider-id.ts`），按从 `baseUrl` 派生的 `ollama:ollama-models-v1:<hash>` 对本地模型缓存键进行分区。

## Ollama Cloud (`ollama-cloud`)
Ollama Cloud 通过 `https://ollama.com` 上的原生 `ollama-chat` 协议端点提供对开源权重 LLM 的托管云访问。它使用 [Ollama](#ollama) 传输部分，通过需要显式 API 密钥认证以及强制执行云特定历史清理和输出 token 上限，与本地 Ollama 区分开来。

### 特殊处理
- **助手历史思考剥离**：`convertMessages`（`packages/ai/src/providers/ollama.ts`）在 `model.provider === "ollama-cloud"` 时从助手历史消息中剥离 `thinking` 字段。Ollama Cloud 端点拒绝包含 `thinking` 的传入历史，返回 HTTP 400 错误，而本地 `ollama` 保留它们。
- **推理 Effort 映射**：`mapReasoning`（`packages/ai/src/providers/ollama.ts`）通过 `model.thinking.effortMap` 映射推理。`OLLAMA_CLOUD_GLM_52_THINKING`（`packages/catalog/src/provider-models/ollama.ts`）将 GLM-5.2 推理 effort 级别限制为 `high` 和 `max`，通过 `isOllamaCloudGlm52ReasoningEffortModel`（`packages/catalog/src/model-thinking.ts`）分配。
- **线协议输出 Token 限制**：`resolveNumPredict`（`packages/ai/src/providers/ollama.ts`）将 `options.num_predict` 限制为 `OLLAMA_CLOUD_NUM_PREDICT_CAP`（65,536），用于 `ollama-cloud` 模型，作为当传递 `maxTokens` 或覆盖时的安全网，防止 HTTP 400 错误（#3392）。本地 `ollama` 端点不限制 `num_predict`。
- **流标记修复**：在 `DSML_HEALING_PROVIDERS`（`packages/catalog/src/compat/openai.ts`）和 `getStreamMarkupHealingPattern`（`packages/ai/src/utils/stream-markup-healing.ts`）中注册，用于 XML/markdown 工具调用和推理恢复。

### 认证 & 使用
- **交互式密钥认证**：`loginOllamaCloud`（`packages/ai/src/registry/ollama-cloud.ts`）提示输入在 `https://ollama.com/settings/keys` 生成的 API 密钥，使用 `ApiKeyRequiredError` 拒绝空输入。
- **环境变量解析**：`descriptors.ts`（`packages/catalog/src/provider-models/descriptors.ts`）和 `getEnvApiKey`（`packages/ai/src/stream.ts`）通过 `OLLAMA_CLOUD_API_KEY` 解析凭据。
- **使用统计**：`ollamaCloudUsageProvider`（`packages/ai/src/usage/ollama.ts`）使用 `fetchOllamaUsage` 处理 `ollama-cloud` 的使用。因为 Ollama Cloud 没有独立的配额 API（`validatesCredentials: false`），使用通过 `prompt_eval_count` 和 `eval_count` 流指标按响应跟踪。

### 目录模型处理
- **描述符 & 发现连接**：描述符 `CATALOG_PROVIDERS`（`packages/catalog/src/provider-models/descriptors.ts`）定义 `defaultModel: "gpt-oss:120b"`、`envVars: ["OLLAMA_CLOUD_API_KEY"]`、选项构建器 `ollamaCloudModelManagerOptions`，以及 `catalogDiscovery: { label: "Ollama Cloud", oauthProvider: "ollama-cloud" }`。
- **动态模型发现 & `/api/show` 元数据**：`packages/catalog/src/provider-models/ollama.ts` 中的 `ollamaCloudModelManagerOptions` 使用 Bearer 令牌认证通过 `GET /api/tags` 在 `https://ollama.com` 上获取模型，然后针对每个模型查询 `POST /api/show`（`fetchShowMetadata`）以检查能力（`thinking`、`vision`）和 `model_info` 上下文窗口大小（默认为 128,000）。未认证时返回空列表。
- **输出 Token 上限 & Token 参数省略**：`isOllamaCloudOutputCapped`（`packages/catalog/src/provider-models/ollama.ts`）识别 DeepSeek V4 Pro/Flash 模型，将 `maxTokens` 固定为 `Math.min(contextWindow, OLLAMA_CLOUD_MAX_OUTPUT_TOKENS)`（65,536），以防止后端拒绝的请求（ollama/ollama#16890，#7266）。所有发现的云模型设置 `omitMaxOutputTokens: true`（也通过 `applyGeneratedModelPolicy` 在 `packages/catalog/scripts/generated-policies.ts` 中强制执行）。

## OpenCode Go (`opencode-go`)
OpenCode Go 通过 `https://opencode.ai/zen/go` 上的统一网关提供对多提供者订阅模型（包括 Kimi、DeepSeek、GLM、Qwen 和 MiniMax）的访问。根据目标模型，请求通过 OpenAI Chat Completions 或 Anthropic Messages 传输管道路由，并具有动态 API 解析。

### 特殊处理
- **API 解析 & 模型 ID 覆盖**：`createOpenCodeApiResolution`（`packages/catalog/src/provider-models/openai-compat.ts`）为 `https://opencode.ai/zen/go` 构建 `OPENCODE_GO_API_RESOLUTION`。显式 ID 覆盖（`minimax-m2.7`、`minimax-m3`、`minimax-m3-free`、`qwen3.5-plus`、`qwen3.6-plus`）优先于基于 npm 的启发式方法（`@ai-sdk/anthropic`），强制路由解析到 `/v1/chat/completions` 上的 `openai-completions`，以防止网关 404 HTML 错误或原始工具调用标记泄漏。
- **推理工具调用回放策略**：`packages/catalog/src/compat/openai.ts` 中的 `OPENCODE_WHEN_THINKING` 在 `isOpenCodeProvider` 为 true（`opencode-go` / `opencode-zen`）且推理处于活动状态时应用。它设置 `requiresReasoningContentForToolCalls: true`、`allowsSyntheticReasoningContentForToolCalls: false` 和 `reasoningContentField: "reasoning_content"`，满足网关在思考工具调用回放时 `reasoning_content` 缺失返回 400（#1484）或在思考关闭时发送返回 400（#1071）的要求。
- **`X-Api-Key` 认证规范化**：在 `packages/ai/src/providers/anthropic.ts`（第 3045-3046 行）中，当 `model.provider === "opencode-go"` 时，传输会删除自动生成的 `Authorization` Bearer 头，以便 `AnthropicMessagesClient` 发出 `X-Api-Key`。对 OpenCode Anthropic 端点的仅 Bearer 请求会因 HTTP `401 Missing API key` 失败（#6510）。

### 认证 & 使用
- **API 密钥登录流程**：`opencodeGoProvider`（`packages/ai/src/registry/opencode-go.ts`）从 `packages/ai/src/registry/oauth/opencode.ts` 延迟导入 `loginOpenCode`。它通过 `onAuth` 将用户定向到 `https://opencode.ai/auth`，通过 `onPrompt` 提示输入 API 密钥，并返回存储在 `OPENCODE_API_KEY` 下的已修剪密钥。
- **滚动支出窗口**：`opencodeGoUsageProvider`（`packages/ai/src/usage/opencode-go.ts`）跟踪 OMP 观察到的跨三个滚动时间窗口的请求成本：`rolling-5h`（5 小时 12 美元）、`weekly`（7 天 30 美元）和 `monthly`（30 天 60 美元）。成本通过 `ctx.listUsageCosts` 聚合，使用 `sumWindowCosts` 来计算分数使用率、重置时间戳（`resetsAt`）和限制状态（`ok`、>=80% 时 `warning`、>=100% 时 `exhausted`）。

### 目录模型处理
- **权威动态模型**：`opencodeGoModelManagerOptions`（`packages/catalog/src/provider-models/openai-compat.ts`）和描述符配置（`packages/catalog/src/provider-models/descriptors.ts`，默认模型 `kimi-k2.7-code`）指定 `dynamicModelsAuthoritative: true`。通过 `fetchOpenAICompatibleModels` 从 `https://opencode.ai/zen/go/v1/models` 成功进行运行时发现会完全替换捆绑的提供者模型，而不是合并仅回退 ID（`model-manager.ts`）。

## OpenCode Zen (`opencode-zen`)
OpenCode Zen（`opencode-zen`）是一项订阅服务，通过 `https://opencode.ai/zen` 上的统一代理端点提供对多供应商 AI 模型（Anthropic Claude、DeepSeek、MiniMax、Gemini 等）的访问。根据目录解析规则，请求动态分派到多个底层传输 API——主要是 "Anthropic Messages"（`/zen`）、"OpenAI Chat Completions"（`/zen/v1`）、"OpenAI Responses"（`/zen/v1`）和 "Google Generative AI"（`/zen/v1`），其中 `claude-opus-4-8` 被指定为默认模型。

### 特殊处理
- **多 API 解析 & 端点连接**：`packages/catalog/src/provider-models/openai-compat.ts` 中的 `createOpenCodeApiResolution` 通过 `@ai-sdk/*` npm 元数据解析模型传输目标。`OPENCODE_ZEN_API_RESOLUTION` 定义每个 id 的覆盖，将 `"minimax-m3"` 和 `"minimax-m3-free"` 映射到 `https://opencode.ai/zen/v1` 上的 `"openai-completions"`，覆盖导致 HTTP 400 错误或原始 `<invoke>`/`<|minimax|>`/`<tool_call>` 标记泄漏的上游 `@ai-sdk/anthropic` 标签（#1617）。
- **Anthropic 代理头 & Beta 处理**：在 `packages/ai/src/providers/anthropic.ts` 中，`opencode-zen` 删除默认的 `Authorization` 头（`delete defaultHeaders.Authorization`）并提供 `apiKey` 以发出 `X-Api-Key` 头。对 `opencode-zen` 的思考请求会抑制 `context_management_20251015` beta 头和 body 字段（`context_management`），因为 Zen Anthropic 代理会因 `400 Extra inputs are not permitted` 拒绝未识别的字段（#6510）。
- **思考模式内容回放（`whenThinking`）**：OpenCode 模型的基础兼容性设置 `requiresReasoningContentForToolCalls: false` 以防止在思考禁用请求上发送未识别的参数（#1071）。当启用推理时，`packages/catalog/src/compat/openai.ts` 中的 `buildOpenAICompat` 构造一个 `OPENCODE_WHEN_THINKING` 覆盖（`requiresReasoningContentForToolCalls: true`、`allowsSyntheticReasoningContentForToolCalls: false`），`resolveOpenAICompatPolicy` 在 `packages/ai/src/providers/openai-shared.ts` 中在请求时指针交换它，以防止 `400 thinking is enabled but reasoning_content is missing in assistant tool call message` 错误（#1484，#2084）。
- **别名推理模型（`big-pickle`）**：模型 ID `big-pickle` 是通过 `packages/catalog/src/compat/openai.ts` 和 `packages/catalog/src/model-thinking.ts` 中的 `isOpenCodeDeepseekAlias` 识别的 OpenCode Zen DeepSeek 推理别名。它被归类为 `isDeepseekFamily` 的一部分，在思考工具调用轮次中强制执行严格的 `reasoning_content` 回放。

### 认证 & 使用
- **API 密钥手动认证**：通过 `OPENCODE_API_KEY` 环境变量（`packages/catalog/src/provider-models/descriptors.ts` 中的 `CATALOG_PROVIDERS` 描述符）配置。
- **交互式 CLI 登录流程**：`opencodeZenProvider.login`（`packages/ai/src/registry/opencode-zen.ts`）惰性调用 `packages/ai/src/registry/oauth/opencode.ts` 中的 `loginOpenCode`。尽管位于 `oauth/` 之下，但它是一个 API 密钥提示流程：它在浏览器中打开 `https://opencode.ai/auth` 并提示用户粘贴其 API 密钥。
- **线协议认证**：跨 Anthropic 和 OpenAI 兼容协议端点的凭据通过 `X-Api-Key` 头传递，而不是标准 Bearer 令牌。

### 目录模型处理
- **描述符 & 选项**：目录条目 `opencode-zen`（`packages/catalog/src/provider-models/descriptors.ts`）设置 `defaultModel: "claude-opus-4-8"`、`dynamicModelsAuthoritative: true`，并实例化 `packages/catalog/src/provider-models/openai-compat.ts` 中的 `opencodeZenModelManagerOptions`。
- **动态发现 & 基础 URL 规范化**：`opencodeZenModelManagerOptions` 调用 `openCodeModelManagerOptions("opencode-zen", config)`，从 `https://opencode.ai/zen/v1/models`（`discoveryBaseUrl`）获取动态 OpenAI 兼容模型。模型映射到正 `contextWindow`（`context_length`）和 `maxTokens`（`max_completion_tokens`），每个 API 类型的基础 URL 已规范化（`openCodeBaseUrlForApi` / `normalizeOpenCodeBasePath`）。
- **Zen 与 Go 的差异**：
  - **基础 URL 根**：Zen 使用基础路径 `https://opencode.ai/zen`（补全在 `/zen/v1`），而 OpenCode Go（`opencode-go`）目标是 `https://opencode.ai/zen/go`（补全在 `/zen/go/v1`）。
  - **默认模型**：Zen 默认为 `claude-opus-4-8`；Go 默认为 `kimi-k2.7-code`。
  - **API 解析覆盖**：Zen（`OPENCODE_ZEN_API_RESOLUTION`）将 `"minimax-m3"` 和 `"minimax-m3-free"` 覆盖为 `"openai-completions"`。Go（`OPENCODE_GO_API_RESOLUTION`）将 `"minimax-m2.7"`、`"minimax-m3"`、`"minimax-m3-free"`、`"qwen3.5-plus"` 和 `"qwen3.6-plus"` 覆盖为 `"openai-completions"`，以防止网关 404 或 XML 标记泄漏（#887，#1617）。
  - **模型别名**：Zen 包含 `big-pickle` 别名（DeepSeek 推理），通过 `isOpenCodeDeepseekAlias` 唯一检测，以应用 DeepSeek 兼容性策略。

## OpenRouter (`openrouter`)
OpenRouter 是一个统一的多提供者路由网关，通过 OpenAI 兼容接口为数以百计的第三方模型提供服务。请求使用伪 API `openrouter` 执行，默认分派到 OpenAI Responses 传输，或根据环境配置回退到 OpenAI Chat Completions。

### 特殊处理
- **伪 API 分派 & 双线回退**：`packages/ai/src/stream.ts` 中的 `streamSimple` 评估 `model.api === "openrouter"`。当 `$env.PI_OPENROUTER_RESPONSES !== "0"`（默认）时，它分派到 `streamOpenAIResponses`（"OpenAI Responses"）；当设置为 `"0"` 时，它回退到 `streamOpenAICompletions`（"OpenAI Chat Completions"）。目录兼容性使用 `ResolvedOpenRouterCompat`（`packages/catalog/src/types.ts`），通过 `packages/catalog/src/compat/openai.ts` 中的 `buildOpenRouterCompat` 组合 `ResolvedOpenAICompat` 和 `ResolvedOpenAIResponsesCompat` 构建。
- **路由变体转换（`:nitro` / `:floor`）**：指定 `openrouterVariant`（`"nitro"`、`"floor"`、`"online"`、`"exacto"`、`"extended"`）的选项通过 `applyOpenRouterRoutingVariant`（`packages/ai/src/providers/openai-shared.ts`）映射。除非最后一个斜杠之后已存在冒号（`lastColon > lastSlash`），否则变体后缀（`:<variant>`）在请求时附加到 `model.id`，保留显式用户或目录变体覆盖。
- **提供者顺序 & 排除首选项**：`packages/ai/src/providers/openai-shared.ts` 中的 `applyOpenAIGatewayRouting` 在 `compat.isOpenRouterHost` 为 true 时将目录 `openRouterRouting` 首选项（具有 `only?: string[]` 和 `order?: string[]` 的 `OpenRouterRouting` 接口）注入到顶级 `provider` 请求参数中。
- **Anthropic `cache_control` 断点**：`packages/ai/src/providers/openai-shared.ts` 中的 `isOpenRouterAnthropicModel` 识别 `provider === "openrouter"` 且 ID 以 `anthropic/` 开头的模型。在 Chat Completions 线协议上，`applyOpenAIChatCompletionsPromptCachePolicy`（`openai-completions.ts`）将 `cache_control: { type: "ephemeral" }` 附加到最新消息的最后一个非空文本部分。在 Responses 线协议上，`applyOpenAIResponsesPromptCachePolicy`（`openai-responses.ts`）设置 `params.cache_control = cacheRetention === "long" ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" }`。
- **目录默认 Max-Tokens 省略**：`packages/ai/src/providers/openai-shared.ts` 中的 `resolveOpenAIOutputTokenParam` 在 `isOpenRouterHost` 为 true 且 `maxTokensExplicit` 为 false 时省略默认输出 token 限制（`max_tokens`、`max_completion_tokens`、`max_output_tokens`）。这可以防止 OpenRouter 在执行 `provider.order` / `only` 回退时过滤掉其声明的输出上限低于目录最大值的上游；保留显式指定的调用者 `maxTokens`。
- **自定义请求头**：`packages/ai/src/utils/openrouter-headers.ts` 中的 `getOpenRouterHeaders` 附加 `User-Agent: omp/<ver>`、`HTTP-Referer: https://omp.sh/`、`X-OpenRouter-Title: omp`、`X-OpenRouter-Categories: cli-agent`、`X-OpenRouter-Cache: true` 和 `X-OpenRouter-Cache-TTL: 3600` 到所有请求以进行边缘响应缓存。

### 认证 & 使用
- **通过 `/api/v1/auth/key` 进行认证密钥验证**：`packages/ai/src/registry/openrouter.ts` 中的 `loginOpenRouter` 使用针对 `https://openrouter.ai/api/v1/auth/key` 的 `validateApiKeyAgainstModelsEndpoint` 配置 API 密钥验证。公共 `/api/v1/models` 对未认证请求返回 HTTP 200，因此 `/api/v1/auth/key` 用作规范身份检查（对有效密钥返回 200，否则返回 401）。密钥解析通过 `packages/ai/src/stream.ts` 中的 `getEnvApiKey` 检查 `OPENROUTER_API_KEY`。
- **权威报告成本协调**：`packages/ai/src/providers/openai-shared.ts` 中的 `applyOpenRouterReportedCost` 提取 API 响应中回显的 `rawUsage.cost`。如果估计的 token 成本是有限且为正数，则输入、输出、缓存读取和缓存写入成本按 `reportedCost / estimatedCost` 缩放以匹配 OpenRouter 的精确计费总额；否则，`usage.cost.input` 直接分配报告的成本。

### 目录模型处理
- **描述符 & 未认证发现**：在 `CATALOG_PROVIDERS`（`packages/catalog/src/provider-models/descriptors.ts`）中注册为 `openrouter`，带有 `defaultModel: "openai/gpt-5.5"`、`envVars: ["OPENROUTER_API_KEY"]`，以及 `catalogDiscovery: { label: "OpenRouter", allowUnauthenticated: true }`。
- **动态发现 & 过滤**：`packages/catalog/src/provider-models/openai-compat.ts` 中的 `openrouterModelManagerOptions` 使用 `fetchOpenAICompatibleModels`（`api: "openrouter"`）查询 `https://openrouter.ai/api/v1/models`。缓存条目在 `resolveModelCacheProviderId("openrouter")` 下分区。发现的模型被过滤为指定 `supported_parameters.includes("tools")` 的条目。
- **规范映射**：`openrouterModelManagerOptions` 映射 `modality`（`text`/`image`）、每百万 token 定价（`prompt`、`completion`、`input_cache_read`、`input_cache_write`）、`context_length`、`top_provider.max_completion_tokens`，以及通过 `mapOpenRouterThinking` 的推理 effort 阶梯。

## Qianfan (`qianfan`)
Qianfan（百度云）通过使用 OpenAI Chat Completions 传输的 OpenAI 兼容 v2 API 提供对百度托管模型系列的访问。入口点包括用于提供者注册和 API 密钥认证的 `packages/ai/src/registry/qianfan.ts`（`qianfanProvider`、`loginQianfan`）、用于目录注册的 `packages/catalog/src/provider-models/descriptors.ts`（`CATALOG_PROVIDERS`），以及用于模型管理器选项的 `packages/catalog/src/provider-models/openai-compat.ts`（`qianfanModelManagerOptions`）。

### 特殊处理
- 除了 OpenAI Chat Completions 管道之外没有任何特殊处理。

### 认证 & 使用
- **API 密钥认证 & 验证**：通过 `QIANFAN_API_KEY` 或存储的凭据进行认证，使用从 `https://console.bce.baidu.com/qianfan/ais/console/apiKey` 获得的格式为 `bce-v3/ALTAK-...` 的 API 密钥。CLI 登录流程（`packages/ai/src/registry/qianfan.ts` 中的 `loginQianfan`）通过使用 `deepseek-v3.2` 向 `https://qianfan.baidubce.com/v2` 发出 `openai-completions` 请求来使用 `createApiKeyLogin` 验证凭据。
- **使用 & 配额**：应用标准 OpenAI Chat Completions token 使用跟踪（`input`、`output`、`reasoning`）和 HTTP 状态代码错误处理。

### 目录模型处理
- **提供者描述符**：在 `CATALOG_PROVIDERS`（`packages/catalog/src/provider-models/descriptors.ts`）中配置，带有 `defaultModel: "deepseek-v3.2"`、`envVars: ["QIANFAN_API_KEY"]` 和目录发现标签 `"Qianfan"`。
- **模型选项**：`packages/catalog/src/provider-models/openai-compat.ts` 中的 `qianfanModelManagerOptions` 通过 `createSimpleOpenAICompletionsOptions` 构造绑定到 `https://qianfan.baidubce.com/v2` 的 `openai-completions` 选项。
- **捆绑模型**：`packages/catalog/src/models.json` 中的静态模型规范定义 Qianfan 模型（例如 `deepseek-v3.2`，带有 `reasoning: true` 和 `baseUrl: "https://qianfan.baidubce.com/v2"`）。

## Qwen Portal (`qwen-portal`)
Qwen Portal 通过 `https://portal.qwen.ai/v1` 上的 OpenAI 兼容端点提供对 Qwen 托管模型的访问。它使用 OpenAI Chat Completions 传输进行模型执行和工具调用。

### 特殊处理
- **系统消息限制**：主机匹配（`packages/catalog/src/hosts.ts` 中的 `qwenPortal`，匹配 `portal.qwen.ai`）将 `supportsMultipleSystemMessagesDefault` 设置为 `false`（`packages/catalog/src/compat/openai.ts`）。这强制将多系统消息块合并为单个块，以防止由默认 Qwen 聊天模板触发的 500 内部服务器错误。

### 认证 & 使用
- **环境变量**：自动从 `QWEN_OAUTH_TOKEN` 或 `QWEN_PORTAL_API_KEY`（`packages/catalog/src/provider-models/descriptors.ts:385`）解析凭据。
- **交互式登录**：`loginQwenPortal`（`packages/ai/src/registry/qwen-portal.ts:8`）指导用户从 `https://chat.qwen.ai` 复制令牌或 API 密钥，并通过 `options.onPrompt` 提示输入。
- **凭据验证**：使用 `validateOpenAICompatibleApiKey` 针对 `https://portal.qwen.ai/v1` 验证输入令牌，目标为 `coder-model`（`packages/ai/src/registry/qwen-portal.ts:35`）。
- **使用跟踪**：`packages/ai/src/usage/` 下不存在专用使用报告模块。

### 目录模型处理
- **描述符设置**：`qwenPortalModelManagerOptions` 使用 `createSimpleOpenAICompletionsOptions`（`packages/catalog/src/provider-models/openai-compat.ts:4139`），默认上下文窗口为 128,000 token，最大输出 token 为 8,192（`openai-compat.ts:5894`）。
- **目录配置**：在 `descriptors.ts:383` 中注册，默认模型为 `coder-model`，发现标签为 `"Qwen Portal"`，`oauthProvider: "qwen-portal"`。
- **静态模型定义**：在 `packages/catalog/src/models.json` 中公开预定义的静态模型：`coder-model`（Qwen Coder）和 `vision-model`（Qwen Vision，支持 `text` 和 `image` 模态）。

## Sakana AI (`sakana`)
Sakana AI 提供来自 Fugu 模型家族的推理模型,通过 `api.sakana.ai` 进行托管。
请求通过有状态的 OpenAI Responses 传输路由(`api: "openai-responses"`)。

### 特殊情况
- **基础 URL 规范化与覆盖**:`resolveSakanaRequestBaseUrl`(位于 `packages/ai/src/providers/openai-shared.ts`)和 `normalizeSakanaBaseUrl`(位于 `packages/catalog/src/provider-models/openai-compat.ts`)从 `SAKANA_BASE_URL` 或回退的 `FUGU_BASE_URL` 解析基础 URL 覆盖。基础 URL 会被规范化以移除尾部斜杠并确保带有 `/v1` 路径后缀,回退值为 `https://api.sakana.ai/v1`。

### 认证与使用
- **API 密钥解析**:环境变量发现首先检查 `SAKANA_API_KEY`,然后回退到 `FUGU_API_KEY`(在描述符 `packages/catalog/src/provider-models/descriptors.ts` 中配置)。
- **交互式登录**:`packages/ai/src/registry/sakana.ts` 中的 `loginSakana` 配置 API 密钥登录,引导用户前往 Sakana AI 控制台(`https://console.sakana.ai/api-keys`),并对照 `https://api.sakana.ai/v1/models` 验证凭据。

### 目录模型处理
- **静态 Fugu 种子**:`packages/catalog/src/provider-models/openai-compat.ts` 中的 `SAKANA_FUGU_STATIC_MODELS` 导出捆绑的种子规范(`fugu`、`fugu-ultra`、`fugu-ultra-20260615`),默认提供方模型为 `fugu`。
- **动态模型管理器**:`sakanaModelManagerOptions` 将实时 `/models` 发现标记为权威(`dynamicModelsAuthoritative: true`),并通过 `dropCachedModelIdsOnStaticMismatch` 在种子变更时清除过时的缓存模型行。
- **两层努力度配置**:`packages/catalog/src/model-thinking.ts` 中的 `isSakanaFuguReasoningModel` 和 `packages/catalog/src/provider-models/openai-compat.ts` 中的 `isSakanaFuguModelId` 匹配 Fugu 模型(`/^fugu(?:$|-)/i`),将其标记为具有两层努力度量表(`HIGH_MAX_REASONING_EFFORTS`:`[high, max]`)的推理模型。

## SiliconFlow (`siliconflow`)
SiliconFlow 是一个高性能 AI 推理平台,提供对开源模型(如 DeepSeek 和 GLM)的访问。它使用 OpenAI Chat Completions 传输(全球为 `https://api.siliconflow.com/v1`,中国区域为 `https://api.siliconflow.cn/v1`)。

### 特殊情况
- **仅动态目录**:在 `CATALOG_PROVIDERS`(`packages/catalog/src/provider-models/descriptors.ts`)中配置为 `dynamicModelsAuthoritative: true`。不捆绑静态目录模型(省略 `catalogDiscovery`,`MODELS_DEV_PROVIDER_DESCRIPTORS` 排除它用于生成器捆绑);模型通过 `/v1/models` 实时发现。
- **非聊天模型过滤**:`packages/catalog/src/provider-models/openai-compat.ts` 中的 `isLikelySiliconFlowChatModelId` 使用 `SILICONFLOW_NON_CHAT_MODEL_TOKENS` 来过滤 `/v1/models` 返回的非聊天模型(嵌入、重排序、Stable Diffusion、Flux、Whisper、Wan2、CosyVoice 等音视频生成器)。
- **运行时元数据填充与回退**:`loadSiliconFlowModelsDevReferences` 使用 5,000 毫秒超时(`SILICONFLOW_MODELS_DEV_REFERENCE_TIMEOUT_MS`)查询 models.dev。缺失的模型回退到规范捆绑规范(`resolveModelReference`)以推断上下文窗口、最大令牌数和推理能力,同时排除定价。

### 认证与使用
- **API 密钥登录**:通过存储在 `SILICONFLOW_API_KEY`(或 `siliconflow-cn` 的 `SILICONFLOW_CN_API_KEY`)中的 API 密钥进行身份验证。通过 `packages/ai/src/registry/siliconflow.ts` 中的 `loginSiliconFlow` 和 `packages/ai/src/registry/siliconflow-cn.ts` 中的 `loginSiliconFlowCn` 进行交互式注册。
- **端点验证**:登录期间通过 `models-endpoint` 请求对照 `https://api.siliconflow.com/v1/models`(`https://api.siliconflow.cn/v1/models` 用于中国区域)验证凭据。
- **控制台 URL**:密钥创建说明指向 `https://cloud.siliconflow.com/account/ak`(中国区域为 `https://cloud.siliconflow.cn/account/ak`)。

### 目录模型处理
- **管理器构造**:`packages/catalog/src/provider-models/openai-compat.ts` 中的 `siliconflowModelManagerOptions` 和 `siliconflowCnModelManagerOptions` 通过 `createSiliconFlowModelManagerOptions` 构造动态 OpenAI 兼容模型管理器。
- **默认模型**:`siliconflow` 的默认模型为 `zai-org/GLM-5.1`,`siliconflow-cn` 的默认模型为 `deepseek-ai/DeepSeek-V4-Pro`(在 `packages/catalog/src/provider-models/descriptors.ts` 中定义)。
- **动态模型发现**:当 API 密钥可用时,`fetchDynamicModels` 调用 `fetchOpenAICompatibleModels` 从 `/v1/models` 获取实时模型,连接 models.dev 的定价/限制(`mapWithBundledReference`)或规范回退引用。

## SiliconFlow (中国) (`siliconflow-cn`)
SiliconFlow(中国)是 SiliconFlow AI 模型平台的国内中国部署,提供针对区域可用性量身定制的开源权重模型的 OpenAI 兼容 LLM 推理。它使用 OpenAI Chat Completions 传输(`openai-completions`),基础 URL 为 `https://api.siliconflow.cn/v1`。

### 特殊情况
- **端点差异**:`packages/catalog/src/provider-models/openai-compat.ts` 中的 `siliconflowCnModelManagerOptions` 使用 `https://api.siliconflow.cn/v1` 作为模型端点,与全球 `siliconflow`(`https://api.siliconflow.com/v1`)不同。
- **非聊天模型过滤**:通过 `packages/catalog/src/provider-models/openai-compat.ts` 中的 `isLikelySiliconFlowChatModelId`,模型发现会排除包含令牌(如 `bge-`、`bce-`、`stable-diffusion`、`flux`、`kolors`、`sensevoice`、`cosyvoice`、`fish-speech`、`wan2` 等)的非聊天模型 ID(嵌入、重排序、图像、TTS、音频和视频模型)。
- **捆绑上游引用回退**:models.dev 中缺失的模型从捆绑的上游模型引用定义(`getBundledModelReferenceIndex`)恢复内在能力(`reasoning`、`input`)、上下文窗口和最大输出令牌数,同时省略提供方特定的定价。

### 认证与使用
- **环境变量**:通过描述符 `envVars`(`packages/catalog/src/provider-models/descriptors.ts`)中配置的 `SILICONFLOW_CN_API_KEY` 进行身份验证,与全球 `SILICONFLOW_API_KEY` 分开。
- **API 密钥登录**:通过 `packages/ai/src/registry/siliconflow-cn.ts` 中的 `createApiKeyLogin` 进行配置,管理控制台 URL 为 `https://cloud.siliconflow.cn/account/ak`,验证端点为 `https://api.siliconflow.cn/v1/models`。
- **无使用跟踪**:`packages/ai/src/usage/` 下不存在专门的配额或使用解析模块。

### 目录模型处理
- **描述符配置**:在 `packages/catalog/src/provider-models/descriptors.ts` 中定义,带有 `defaultModel: "deepseek-ai/DeepSeek-V4-Pro"`(而 `siliconflow` 为 `zai-org/GLM-5.1`)、`envVars: ["SILICONFLOW_CN_API_KEY"]` 和 `dynamicModelsAuthoritative: true`。
- **仅动态模型发现**:故意从 `MODELS_DEV_PROVIDER_DESCRIPTORS` 和静态目录生成(`scripts/generate-models.ts`)中省略,从 `https://api.siliconflow.cn/v1/models` 实时获取可用的聊天模型。
- **运行时引用填充**:实时发现的模型与 models.dev 目录条目(`SILICONFLOW_MODELS_DEV_DESCRIPTORS`)交叉引用,在 `packages/catalog/src/provider-models/openai-compat.ts` 的 `loadSiliconFlowModelsDevReferences` 中使用 5 秒超时(`SILICONFLOW_MODELS_DEV_REFERENCE_TIMEOUT_MS`)来填充定价和限制元数据。

## Synthetic (`synthetic`)
Synthetic 是一个 AI 平台,为其模型提供双 API 格式支持,既公开 OpenAI 兼容端点(`https://api.synthetic.new/openai/v1/chat/completions`),也公开 Anthropic 兼容端点(`https://api.synthetic.new/anthropic/v1/messages`)。调用默认使用 `OpenAI Chat Completions` 传输,但可以在配置时动态切换到 `Anthropic Messages` 传输。

### 特殊情况
- **双 API 表面**:`packages/ai/src/providers/synthetic.ts` 中的 `streamSynthetic` 利用 `packages/ai/src/providers/openai-anthropic-shim.ts` 中的 `streamOpenAIAnthropicShim` 来包装 OpenAI completions 和 Anthropic messages 端点。API 格式可通过请求的 `syntheticApiFormat` 选项(`"openai"` | `"anthropic"`)进行选择,默认为 `"openai"`。
- **急切模块导入**:`streamSynthetic` 和 `isSyntheticModel` 在 `packages/ai/src/stream.ts` 中急切导入(绕过惰性内置注册),以支持立即的模型提供方分类和路由。
- **动态推理与特性**:在 `packages/catalog/src/provider-models/openai-compat.ts` 中,`syntheticModelManagerOptions` 从 `GET /openai/v1/models` 映射动态模型条目。它检查 `supported_features` 中的 `"reasoning"`,并解析线路努力度级别(例如 `reasoning_parameters.efforts`)以构建 `thinking` 选项并适当设置 `reasoning` 标志。

### 认证与使用
- **身份验证**:使用 `SYNTHETIC_API_KEY`(`packages/ai/src/registry/synthetic.ts`)进行基于密钥的身份验证。通过 `createApiKeyLogin` 对照 `GET https://api.synthetic.new/openai/v1/models` 进行验证。
- **使用与配额轮询**:`packages/ai/src/usage/synthetic.ts` 中的 `syntheticUsageProvider` 使用 bearer API 密钥轮询 `GET https://api.synthetic.new/v2/quotas`。它报告两个不同的限制窗口:
  - `synthetic:requests:5h`:滚动 5 小时请求限制,带有每个 tick 的再生百分比(`rollingFiveHourLimit`)。
  - `synthetic:usd:7d`:以美元计的每周信用额度(`weeklyTokenLimit`),带有每个 tick 的美元再生率。

### 目录模型处理
- 默认模型:`hf:zai-org/GLM-5.1`(`packages/catalog/src/provider-models/descriptors.ts`)。
- `dynamicModelsAuthoritative: true`:模型通过 `packages/catalog/src/provider-models/openai-compat.ts` 中的 `syntheticModelManagerOptions` 动态获取。
- 模态与视觉:`input` 模态(`"text"`、`"image"`)从 `input_modalities`、`supports_vision` 或回退引用规范动态解析。
- 能力过滤:`supported_features` 严格限制工具支持;如果存在但没有 `"tools"`,则该模型禁用工具调用。

## Together (`together`)
Together 是一个云推理提供方,通过 OpenAI Chat Completions 兼容 API 提供对各种开源和专有基础模型的访问。

### 特殊情况
- **严格 JSON Schema 模式**:被识别为支持严格 schema 模式(`packages/catalog/src/compat/openai.ts` 中的 `detectStrictModeSupport`),为 `together` 提供方 ID 和 `api.together.xyz` 基础 URL 启用。
- **多个系统消息**:被识别为支持多个系统消息(`packages/catalog/src/compat/openai.ts` 中的 `supportsMultipleSystemMessagesDefault`),因此系统消息不会被强制合并到索引 0。

### 认证与使用
- **API 密钥认证**:使用 `TOGETHER_API_KEY` 环境变量或 `pi-ai login together` 期间的 API 密钥输入进行身份验证。
- **验证**:`loginTogether` 使用模型 `moonshotai/Kimi-K2.5` 通过 `createApiKeyLogin` 使用 `chat-completions` 对照 `https://api.together.xyz/v1` 验证密钥。
- **API 基础 URL**:`https://api.together.xyz/v1`。

### 目录模型处理
- **描述符与默认值**:在 `descriptors.ts` 中配置,默认模型为 `moonshotai/Kimi-K2.7-Code`,`openai-compat.ts` 中有 `togetherModelManagerOptions`。
- **目录源**:通过 `models.dev` 描述符生成模型,使用键 `togetherai` 映射到 `https://api.together.xyz/v1` 处的提供方 `together`(`packages/catalog/src/provider-models/openai-compat.ts`)。
- **主机匹配**:列于 `packages/catalog/src/hosts.ts` 中,匹配主机 URL 标记 `api.together.xyz`,并在 `priority.ts` 身份映射中注册。

## Umans AI Coding Plan (`umans`)
Umans AI Coding Plan 是 AI 编码模型的代理服务,通过 Anthropic Messages 线路格式("Anthropic Messages")运行,其默认基础 URL 设置为 `https://api.code.umans.ai`。

### 特殊情况
- **认证标头策略**:Anthropic 兼容的 Umans 请求强制使用 `X-Api-Key` 标头身份验证(`packages/ai/src/registry/umans.ts` 中的 `loginUmans`),而不是 `Authorization: Bearer`(`packages/ai/src/providers/anthropic.ts` 中的 `buildAnthropicClientOptions`)。
- **工具名称转义**:配置 `compat.escapeBuiltinToolNames: true`(`packages/catalog/src/compat/anthropic.ts`),在出站请求上为客户端工具名称添加 `_` 前缀,在返回时去除,以避免与网关内置工具名称冲突,除非网关网络搜索处于活动状态(`packages/ai/src/providers/anthropic.ts`)。
- **网关网络搜索**:通过检查 `X-Umans-Websearch-Provider` 调用者标头或 `UMANS_WEBSEARCH_PROVIDER`(`native` | `exa`)环境变量(`packages/ai/src/providers/anthropic.ts`)来路由网络搜索请求。启用时,`web_search` 工具名称未经转义直接传递。
- **思考/推理努力度**:支持通过 `UMANS_REASONING_EFFORT_BY_LEVEL`(`packages/catalog/src/provider-models/openai-compat.ts`)映射级别的思考配置。Umans 上的 GLM-5.2 使用两层 high/max 努力度等级,其中 `max` 映射到 `anthropic-budget-effort` 模式(`xhigh` 努力度)(`packages/catalog/src/model-thinking.ts`)。

### 认证与使用
- **认证**:使用 `UMANS_AI_CODING_PLAN_API_KEY` 环境变量或 `/login umans` 密钥提示(`packages/ai/src/registry/umans.ts`、`packages/ai/src/registry/registry.ts`)。密钥验证执行对 `https://api.code.umans.ai/v1/messages` 的轻量级 Anthropic messages 调用(`max_tokens: 1`)。
- **使用端点**:使用 `Authorization: Bearer <key>` 从 `GET /v1/usage`(`packages/ai/src/usage/umans.ts`)获取配额和速率限制状态。
- **公开的限制**:返回滚动 5 小时请求,分为模型加权软上限(`umans:requests:soft`,即"有效请求"契约)和原始突发上限(`umans:requests:hard`,`hard_cap`),加上瞬时会话并发限制(`umans:concurrency`)。软上限仅发出警告——`exhausted` 保留给突发上限,即实际开始限流的位置。没有报告突发上限(`hard_cap`)的负载会折叠为单个加权 `umans:requests` 行,该行可以在有效请求限制时耗尽,因此请求耗尽永远不会无法报告;没有加权计数器的旧版负载回退到单个原始 `umans:requests` 行。在这两种单行形式中,加权计数器(如果存在)保持权威性——超过限制的原始突发流量永远不会伪造耗尽状态。当速率限制突发发生时,也会公开低优先级状态注释。

### 目录模型处理
- **描述符与发现**:注册为 `umans`,默认模型为 `umans-coder`(`packages/catalog/src/provider-models/descriptors.ts`)。动态发现从 `GET /v1/models/info`(`packages/catalog/src/provider-models/openai-compat.ts`)获取模型详情。
- **视觉能力过滤**:`umansSupportsVision` 严格检查 `supports_vision === true`。哨兵字符串值(如 `umans-glm-5.1` 和 `umans-glm-5.2` 的 `"via-handoff"`)映射到仅文本(`["text"]`),以便通过客户端视觉交接处理图像内容,而不是发送导致 HTTP 400 错误的原始图像块(`packages/catalog/src/provider-models/openai-compat.ts`)。
- **定价与回退**:为按需付费和技术别名模型(如 `umans-qwen3.6-35b-a3b` 映射到 `umans-flash`)生成带有定价回退规则的目录条目(`packages/catalog/scripts/generate-models.ts`)。

## Venice (`venice`)
Venice 是一个注重隐私的 AI 平台,提供未经审查和开源模型。它通过 OpenAI Chat Completions 传输(`api: "openai-completions"`)运行,默认基础 URL 为 `https://api.venice.ai/api/v1`。

### 特殊情况
- **Qwen 推理方言**:Venice 的严格 chat-completions 架构拒绝 DashScope 的顶层 `enable_thinking`。`buildOpenAICompat` 通过提供方或 `api.venice.ai` 基础 URL 识别 Venice,并通过 OpenAI 风格的 `reasoning_effort` 路由 Qwen 推理级别。
- **显式关闭思考**:`reasoningDisableMode: "venice-disable-thinking"` 将显式关闭选择编码为 `venice_parameters.disable_thinking: true`,保留同级 Venice 设置(如 `include_venice_system_prompt`)。

### 认证与使用
- **API 密钥登录与验证**:`packages/ai/src/registry/venice.ts` 中的 `loginVenice` 使用 `packages/ai/src/registry/api-key-login.ts` 中的 `createApiKeyLogin`,引导用户前往 `https://venice.ai/settings/api` 获取 API 密钥(`vapi_...` 占位符前缀),并通过使用验证模型 `qwen3-4b` 的轻量级 `chat-completions` 请求验证凭据。在 `packages/ai/src/registry/registry.ts` 中注册为 `veniceProvider`。
- **环境变量与凭据**:从 `CATALOG_PROVIDERS`(`packages/catalog/src/provider-models/descriptors.ts`)中配置的 `VENICE_API_KEY` 环境变量解析 API 密钥。
- **使用核算**:使用标准 OpenAI Chat Completions 使用核算(`packages/ai/src/providers/openai-shared.ts` 中的 `calculateOpenAIUsageAccounting`),无需自定义配额或使用端点。

### 目录模型处理
- **提供方描述符**:在 `CATALOG_PROVIDERS`(`packages/catalog/src/provider-models/descriptors.ts`)中注册,默认模型为 `llama-3.3-70b`,`envVars: ["VENICE_API_KEY"]`,目录发现配置为 `allowUnauthenticated: true`。
- **模型管理器选项**:`packages/catalog/src/provider-models/openai-compat.ts` 中的 `veniceModelManagerOptions` 通过 `https://api.venice.ai/api/v1` 上的 `createOpenAICompatibleModelManagerOptions` 配置模型管理。
- **流式使用兼容性**:在 `packages/catalog/src/provider-models/openai-compat.ts` 的 `veniceModelManagerOptions` 中,映射的模型通过设置 `compat: { ...model.compat, supportsUsageInStreaming: false }` 显式禁用流式使用负载。
- **Kimi K2.7 Code 最大令牌上限**:`packages/catalog/src/provider-models/openai-compat.ts` 中的 `clampKimiK27CodeMaxTokens`(以及 `packages/catalog/scripts/generate-models.ts` 中的 `applyKimiMaxTokensCap`)将 Kimi K2.7 Code 模型(`isKimiK27CodeModelId`)的输出令牌(`maxTokens`)上限设置为 `KIMI_K27_CODE_RECOMMENDED_MAX_TOKENS`。
- **目录转换**:`packages/catalog/src/provider-models/openai-compat.ts` 中 Venice 的 `openAiCompletionsDescriptor` 在模型目录构建和发现转换期间应用 `clampKimiK27CodeMaxTokens`。

## Vercel AI Gateway (`vercel-ai-gateway`)
Vercel AI Gateway 通过统一代理(`https://ai-gateway.vercel.sh`)将 LLM 请求路由到基础提供方(如 Anthropic、OpenAI 或 Bedrock)。它根据模型配置跨 Anthropic Messages(`anthropic-messages`)、OpenAI Chat Completions(`openai-completions`)和 OpenAI Responses(`openai-responses`)传输协议运行。

### 特殊情况
- **主机检测**:`isVercelGatewayHost` 通过 `modelMatchesHost({ provider, baseUrl }, "vercelAIGateway")`(`packages/catalog/src/compat/openai.ts`、`packages/catalog/src/hosts.ts`)进行评估,匹配 `provider === "vercel-ai-gateway"`

## vLLM (本地 OpenAI 兼容) (`vllm`)
vLLM 是一个开源的高吞吐量 LLM 服务引擎,运行本地或自托管的 OpenAI 兼容推理服务器。它通过 HTTP/SSE 使用 OpenAI Chat Completions 传输。入口模块包括用于身份验证和凭据处理的 `packages/ai/src/registry/vllm.ts`,以及用于目录选项和动态模型发现的 `packages/catalog/src/provider-models/openai-compat.ts`(`vllmModelManagerOptions`)。

### 特殊情况
- **推理内容重放(`replayReasoningContent`)**:在 `LOCAL_OPENAI_COMPAT_PROVIDERS`(`packages/catalog/src/compat/openai.ts`)中注册。由于本地推理后端依赖前缀 KV 缓存重用,`isLocalOpenAICompatBackend` 自动启用 `replayReasoningContent: true`。当助手历史记录包含推理内容(`<think>` 块)时,会在后续请求中的 `reasoning_content` 中重放,以保持精确的提示令牌对齐。
- **Qwen 思考保留(`qwenPreserveThinking`)**:当 `thinkingFormat` 为 `"qwen"` 或 `"qwen-chat-template"` 且 `isLocalOpenAICompatBackend` 为 true 时,在 `packages/catalog/src/compat/openai.ts` 中自动启用。在 compat 对象上设置 `qwenPreserveThinking: true`,在请求体中发出 `preserve_thinking: true`(顶层和 `chat_template_kwargs` 中),以便 Qwen 3.6+ 聊天模板在多轮历史记录中保留 `<think>` 块。
- **流式空闲超时下限**:作为本地服务后端(`packages/catalog/src/compat/openai.ts` 中的 `isLocalServingBackend`),vLLM 自动应用扩展的流式空闲超时下限(`streamIdleTimeoutMs: 300_000` / 5 分钟),而不是默认的 100 秒,以适应本地 GPU 或 CPU 上的重型模型预填充延迟。
- **仅动态目录排除**:包含在 `DISCOVERY_ONLY_PROVIDERS`(`scripts/generate-models.ts`)和 `LOCAL_ONLY_PROVIDERS`(`test/models-json-no-local-endpoints.test.ts`)中。本地 vLLM 模型从静态目录生成中排除,因此机器特定的端点永远不会提交到 `models.json`。

### 认证与使用
- **凭据解析与默认值**:通过 `packages/ai/src/registry/vllm.ts` 中的 `loginVllm`(`createApiKeyLogin`)管理。从 `VLLM_API_KEY` 环境变量或通过 `omp auth-broker login vllm` 存储的凭据读取可选 API 密钥。
- **未经身份验证的本地模式**:当未提供密钥时,默认基础 URL 为 `http://127.0.0.1:8000/v1`,占位符令牌为 `"vllm-local"`(`DEFAULT_LOCAL_TOKEN`)(`emptyKeyFallback: "vllm-local"`)。描述符设置指定 `catalogDiscovery: { label: "vLLM", allowUnauthenticated: true }`。
- **文档与端点设置**:登录助手指向 `https://docs.vllm.ai/en/latest/serving/openai_compatible_server.html` 以配置本地 vLLM OpenAI 兼容服务器端点。

### 目录模型处理
- **描述符配置**:在 `packages/catalog/src/provider-models/descriptors.ts` 中注册,带有 `id: "vllm"`、`defaultModel: "gpt-oss-20b"`、`envVars: ["VLLM_API_KEY"]`、`allowUnauthenticated: true`,以及由 `vllmModelManagerOptions` 生成的管理器选项。
- **动态模型发现**:`packages/catalog/src/provider-models/openai-compat.ts` 中的 `vllmModelManagerOptions` 使用 `api: "openai-completions"`、`provider: "vllm"`、基础 URL `config?.baseUrl ?? getDefaultModelDiscoveryBaseUrl("vllm")!`(`http://127.0.0.1:8000/v1`)和 10 秒超时(`VLLM_DISCOVERY_TIMEOUT_MS = 10_000`)调用 `fetchOpenAICompatibleModels`。
- **上下文窗口提取**:`vllmModelManagerOptions` 中的自定义 `mapModel` 使用 `toPositiveNumber(entry.max_model_len, model.contextWindow)` 从 vLLM 的非标准 `/v1/models` 响应字段 `entry.max_model_len` 中提取 `contextWindow`。
- **缓存提供方 ID**:由 `packages/catalog/src/provider-models/cache-provider-id.ts` 中的 `resolveModelCacheProviderId("vllm", { baseUrl })`(使用 `getDefaultModelDiscoveryBaseUrl("vllm")`)解析,生成格式为 `vllm:${Bun.hash(baseUrl).toString(36)}` 的基础 URL 哈希缓存键。

## Wafer Serverless (`wafer-serverless`)
Wafer Serverless 是一个按需付费的提供方代理,通过 `https://pass.wafer.ai/v1` 处的 OpenAI 兼容 API 代理多个上游模型(如 Zhipu GLM、Moonshot Kimi、Alibaba Qwen 和 DeepSeek)。它依赖 OpenAI Chat Completions 传输(`openai-completions`)。

### 特殊情况
- 上游思考参数选择通过 `resolveWaferServerlessThinkingFormat`(`packages/catalog/src/provider-models/openai-compat.ts:2137`)根据 `wafer.provider` 信封提示动态配置:
  - 匹配 `zai`、`zhipu`、`moonshot` 或 `kimi` 的上游设置 `thinkingFormat: "zai"`。
  - 匹配 `qwen`、`alibaba` 或 `dashscope` 的上游设置 `thinkingFormat: "qwen"`。
  - 没有信封提示的回退使用 `isReasoningGlmModelId` 或 `isKimiModelId` 作为 `"zai"`(`packages/catalog/src/provider-models/openai-compat.ts:2150`)。
  - `generated-policies.ts` 中的静态策略对捆绑的 GLM/Kimi 模型应用 `thinkingFormat: "zai"`(`packages/catalog/scripts/generated-policies.ts:364`)。
- 所有推理条目配置 `reasoningContentField: "reasoning_content"` 并设置 `supportsDeveloperRole: false`(`packages/catalog/src/provider-models/openai-compat.ts:2244`)。
- `wafer-pass` 已被 `wafer-serverless` 取代(`packages/catalog/scripts/generate-models.ts:79`)。

### 认证与使用
- 使用通过 `WAFER_SERVERLESS_API_KEY` 环境变量(`packages/catalog/src/provider-models/descriptors.ts:465`)提供的 Bearer API 密钥(`wfr_…` 前缀)进行身份验证。
- 交互式登录由 `packages/ai/src/registry/oauth/wafer.ts:14` 中使用 `createApiKeyLogin` 的 `loginWaferServerless` 处理,引导用户前往 `https://app.wafer.ai/usage`。
- 密钥验证探测 `https://pass.wafer.ai/v1/models`(`packages/ai/src/registry/oauth/wafer.ts:11`)。

### 目录模型处理
- 在提供方描述符中注册,带有 `defaultModel: "GLM-5.1"` 和基础 URL `https://pass.wafer.ai/v1`(`packages/catalog/src/provider-models/descriptors.ts:463`)。
- 动态目录生成使用 `waferServerlessModelManagerOptions`(`packages/catalog/src/provider-models/openai-compat.ts:2252`),并通过 `readWaferRecord`(`packages/catalog/src/provider-models/openai-compat.ts:2151`)解析 `/v1/models` 响应。
- 从 `wafer.capabilities` 映射模型能力:`vision` 启用 `["text", "image"]` 输入,`reasoning` 启用推理模式,`tools` 设置 `supportsTools`(`packages/catalog/src/provider-models/openai-compat.ts:2193`)。
- 上下文窗口读取 `wafer.context_length`(回退到 `max_model_len`),`maxTokens` 上限为 `65536`(`WAFER_MAX_TOKENS_CAP`,`packages/catalog/src/provider-models/openai-compat.ts:2201`)。
- 定价使用 `cents * 125 / 10000`(`cents * 0.0125`)将内部批发单位从 `wafer.pricing` 转换为 USD/M 令牌(`packages/catalog/src/provider-models/openai-compat.ts:2203`)。
- 模型 ID 在线路上按原样保留,不进行大小写转换(`packages/catalog/src/provider-models/openai-compat.ts:2210`)。

## xAI API (`xai`)
xAI API(`xai`)使用标准 API 密钥身份验证提供对 xAI Grok 模型套件的访问。它通过 OpenAI Chat Completions 传输(`https://api.x.ai/v1`)路由推理请求,与使用 OAuth bearer 令牌和 OpenAI Responses 传输的 `xai-oauth` 不同。

### 特殊情况
- **Grok 主机兼容性**:主机检测(`packages/catalog/src/hosts.ts` 符号 `hosts.xai`)匹配提供方 `"xai"` 和 `api.x.ai` URL,以在 Chat Completions 兼容性层(`packages/catalog/src/compat/openai.ts` 符号 `resolveOpenAICompatForHost`)中评估 `isGrok`。
- **提示缓存标头**:当 `isGrok` 为 true 时(`packages/catalog/src/compat/openai.ts` 符号 `resolveOpenAICompatForHost`),配置 `promptCacheSessionHeader: "x-grok-conv-id"`,启用对话 ID 标头附加以保留提示缓存。
- **推理努力度已禁用**:在 Chat Completions 兼容性中通过 `!isGrok` 检查显式设置 `supportsReasoningEffort: false`(`packages/catalog/src/compat/openai.ts` 符号 `resolveOpenAICompatForHost`),与 `xai-oauth` 的选择性推理努力度支持形成对比。
- **提供方优先级排名**:在提供方优先级(`packages/catalog/src/identity/priority.ts` 符号 `PROVIDER_PRIORITY`)中位于 `xai-oauth` 之下(`"xai-oauth"` > `"xai"` > `"mistral"`)。

### 认证与使用
- **身份验证**:通过 `packages/ai/src/registry/xai.ts` 中的 `createApiKeyLogin` 实现基于密钥的身份验证(符号 `loginXAI`、`xaiProvider`)。引导用户前往 `"https://console.x.ai/team/default/api-keys"`,提示为 `"Paste your xAI API key"`(占位符 `"xai-..."`)。
- **验证**:通过 `models-endpoint` 对照 `"https://api.x.ai/v1/models"`(`packages/ai/src/registry/xai.ts` 符号 `loginXAI`)执行凭据检查。
- **环境回退**:配置为解析 `XAI_API_KEY`(`packages/catalog/src/provider-models/descriptors.ts` 符号 `descriptors`)。
- **使用跟踪**:除 `OpenAI Chat Completions` 管道外没有其他内容。

### 目录模型处理
- **描述符配置**:提供方描述符(`packages/catalog/src/provider-models/descriptors.ts` 符号 `descriptors`)指定默认模型 `grok-4-fast-non-reasoning`,并委托给 `xaiModelManagerOptions`。
- **管理器选项**:通过 `createSimpleOpenAICompletionsOptions("xai", "https://api.x.ai/v1", config)`(`packages/catalog/src/provider-models/openai-compat.ts` 符号 `xaiModelManagerOptions`)构造。
- **Completions 描述符**:使用 `openAiCompletionsDescriptor("xai", "xai", "https://api.x.ai/v1")`(`packages/catalog/src/provider-models/openai-compat.ts` 符号 `openAiCompletionsDescriptor`)注册,通过 `openai-completions` API 提供 Grok 模型。

## xAI Grok OAuth (SuperGrok) (`xai-oauth`)
xAI Grok OAuth 通过 OpenAI Responses 传输(`api: "openai-responses"`、`baseUrl: "https://api.x.ai/v1"`)提供基于订阅的访问(SuperGrok / X Premium+)到 xAI Grok 模型。身份验证使用针对 `https://auth.x.ai` 的 RFC 8628 设备代码流,而使用跟踪探测专用 SuperGrok CLI 计费代理。

### 特殊情况
- **加密推理与历史重放**:`includeEncryptedReasoning` 为 `false`(`packages/catalog/src/compat/openai.ts` `buildOpenAIResponsesCompat`)以抑制加密推理项重放。`filterReasoningHistory` 为 `true`(`packages/catalog/src/compat/openai.ts`、`packages/ai/src/providers/openai-responses.ts`)以从重放的 Responses 历史记录中过滤原生推理项和思考签名。
- **图像细节限制**:`supportsImageDetailOriginal` 为 `false`(`packages/catalog/src/compat/openai.ts` `buildOpenAIResponsesCompat`),因为 xAI 端点对 `"original"` 返回 HTTP 400/422,所以将图像细节从 `"original"` 限制为 `"auto"`。
- **推理努力度门控与摘要**:除非模型在 `isGrokReasoningEffortCapable` 白名单(`packages/catalog/src/identity/family.ts`,例如 `grok-3-mini`、`grok-4.20-multi-agent`、`grok-4.3`、`grok-4.5`)上,否则 `supportsReasoningEffort` 为 `false`。不合格的模型(`grok-build`、`grok-build-0.1`、`grok-4.20-0309-reasoning`、`grok-composer-2.5-fast`)设置 `omitReasoningEffort: true` 以防止 `api.x.ai` 上的 HTTP 400。`reasoningSummary` 在 `packages/ai/src/providers/openai-responses.ts` 中设置为 `null`(或在禁用时为 `undefined`)以省略不支持的 `reasoning.summary` 线路字段。
- **推理努力度映射与缓存**:将 `minimal` 映射到 `"low"`(`packages/catalog/src/provider-models/openai-compat.ts` `XAI_REASONING_EFFORT_MAP`)。为会话提示缓存保留发送 `X-Grok-Conv-Id`(`promptCacheSessionHeader`)。

### 认证与使用
- **OAuth 身份验证**:`packages/ai/src/registry/xai-oauth.ts` 中的 `xaiOauthProvider` 委托给 `loginXAIOAuth` 和 `refreshXAIOAuthToken`(`packages/ai/src/registry/oauth/xai-oauth.ts`)。针对 `https://auth.x.ai`(客户端 ID `b1a00492-073a-47ea-816f-4c329264a828`,范围 `openid profile email offline_access grok-cli:access api:access`)执行 RFC 8628 设备授权。`xaiOAuthDiscovery` 获取 OIDC 配置并验证端点(`validateXAIEndpoint` 固定为 HTTPS `*.x.ai`)。从 `https://auth.x.ai/oauth2/userinfo`(`fetchXAIOAuthIdentity`)获取用户身份。环境回退:`XAI_OAUTH_TOKEN` 然后 `XAI_API_KEY`(`descriptors.ts`)。
- **使用跟踪**:`packages/ai/src/usage/xai-oauth.ts` 中的 `xaiOauthUsageProvider` 使用标头 `X-XAI-Token-Auth: xai-grok-cli`(`getXAICliBillingHeaders`)查询 `https://cli-chat-proxy.grok.com/v1/billing`(`validateXAIBillingEndpoint` 固定为 HTTPS `*.grok.com`)。仅接受有效的 OAuth bearer 凭据。探测旧版每周信用(`?format=credits`,`parseWeeklyBillingConfig` 用于 `creditUsagePercent` 和 `productUsage`)和统一月度配额(`parseMonthlyBillingConfig` 用于 `monthlyLimit` 和 `used`),以及正的 `onDemandCap` / `onDemandUsed` 限制。

### 目录模型处理
- **精选模型与静态种子**:`packages/catalog/src/provider-models/openai-compat.ts` 中的 `XAI_OAUTH_CURATED_MODELS` 定义静态模型(`grok-build`、`grok-build-0.1`、`grok-3-mini`、`grok-4.3`、`grok-4.5`、`grok-4.6`、`grok-4.20-multi-agent-0309`、`grok-4.20-0309-reasoning`、`grok-4.20-0309-non-reasoning`、`grok-composer-2.5-fast`),零成本(`cost: 0`)。默认模型为 `grok-4.6`(`descriptors.ts`)。`buildXaiOAuthStaticSeed` 在引导时同步为 `ModelRegistry` 设定种子,以便 `modelRoles.default = "xai-oauth/<id>"` 在动态刷新之前工作。
- **动态精选覆盖**:`packages/catalog/src/provider-models/openai-compat.ts`、`xaiOAuthModelManagerOptions` 中的 `applyXAIOAuthCuration` 过滤非聊天前缀(`grok-imagine-`、`grok-stt-`、`grok-voice-`),覆盖精选上下文窗口(最高 2M),将 `maxTokens` 设置为等于 `contextWindow`,保留图像能力和推理标志,并注入缺失的精选模型。
- **引用解析排除**:`packages/catalog/src/identity/reference.ts` 中的 `isZeroCostXaiOAuthCandidate` 从引用索引匹配中排除零成本订阅条目,因此订阅定价和限制不会覆盖公共/付费 Grok 引用。

## Xiaomi MiMo (`xiaomi`)
Xiaomi MiMo 通过 OpenAI 兼容端点提供 Xiaomi 专有的 MiMo 模型家族(如 `mimo-v2.5` 和 `mimo-v2.5-pro`)。请求通过 OpenAI Chat Completions 传输执行,使用标准按需付费基础 URL(`https://api.xiaomimimo.com/v1`)或区域 Token Plan 基础 URL(`https://token-plan-{sgp,ams,cn}.xiaomimimo.com/v1`)。

### 特殊情况
- **MiMo 兼容性分类**:通过 `packages/catalog/src/identity/family.ts` 中的 `isXiaomiHost`(`modelMatchesHost(hostModel, "xiaomi")`)和 `isMimoModelIdOrName` 在 `packages/catalog/src/compat/openai.ts` 中匹配。
- **推理内容不变量**:
  - `requiresReasoningContentForToolCalls: true`(`packages/catalog/src/compat/openai.ts`):MiMo 模型需要在标准主机和 Token Plan 主机上的思考模式工具调用延续中精确重放 `reasoning_content`。
  - `requiresReasoningContentForAllAssistantTurns: true`(`packages/catalog/src/compat/openai.ts`):在推理模式期间对所有先前的助手轮强制执行 `reasoning_content` 存在(除非通过 OpenRouter 路由)。
  - `allowsSyntheticReasoningContentForToolCalls: false`(`packages/catalog/src/compat/openai.ts`):在工具调用轮上拒绝合成 `reasoning_content` 占位符(例如 `"."`)。
- **思考格式与努力度映射**:
  - `thinkingFormat: "zai"`(`packages/catalog/src/compat/openai.ts`):使用 z.ai 二进制 `thinking` 结构格式化思考模式负载。
  - `supportsReasoningEffort: false`(`packages/catalog/src/compat/openai.ts`):抑制标准 `reasoning_effort` 参数。
- **非标准主机协议标志**:`isXiaomiHost` 在 `packages/catalog/src/compat/openai.ts` 中归类于 `isNonStandard`,设置 `supportsStore: false` 并默认 `supportsDeveloperRole: false`。

### 流行为
- **扩展空闲看门狗超时**:`streamIdleTimeoutMs` 通过 `packages/catalog/src/compat/openai.ts` 中的 `XIAOMI_MIMO_STREAM_IDLE_TIMEOUT_MS` 扩展到 300,000 毫秒(5 分钟),因为 `api.xiaomimimo.com` 上的 MiMo Pro 在发出第一个 SSE 事件之前可能会停顿约 2 分钟(问题 #1770)。

### 认证与使用
- **注册表与提供方定义**:主要提供方在 `packages/ai/src/registry/xiaomi.ts`(`xiaomiProvider`)中定义;区域 Token Plan 提供方在 `packages/ai/src/registry/xiaomi-token-plan-{ams,cn,sgp}.ts`(`xiaomiTokenPlanAmsProvider`、`xiaomiTokenPlanCnProvider`、`xiaomiTokenPlanSgpProvider`)中导出。
- **交互式密钥提示与验证**:`packages/ai/src/registry/oauth/xiaomi.ts` 中的 `loginXiaomi` 和 `loginXiaomiTokenPlan` 提示输入标准(`sk-...`)或 Token Plan(`tp-...`)API 密钥,并通过 `validateXiaomiApiKey` 进行验证。
- **Token Plan 验证回退**:使用 `tp-` 密钥的标准 `xiaomi` 登录按顺序回退通过 SGP(`https://token-plan-sgp.xiaomimimo.com/v1`)→ AMS(`https://token-plan-ams.xiaomimimo.com/v1`)→ CN(`https://token-plan-cn.xiaomimimo.com/v1`),使用每个端点的新 `AbortSignal.timeout(15_000)` 信号,以便区域超时不会中止后续回退端点。区域 `xiaomi-token-plan-*` 登录对照其特定集群进行验证。
- **环境变量**:标准 `xiaomi` 使用 `XIAOMI_API_KEY`,区域 Token Plan 提供方使用 `XIAOMI_TOKEN_PLAN_AMS_API_KEY`、`XIAOMI_TOKEN_PLAN_CN_API_KEY`、`XIAOMI_TOKEN_PLAN_SGP_API_KEY`(`packages/catalog/src/provider-models/descriptors.ts`)。

### 目录模型处理
- **提供方描述符**:`packages/catalog/src/provider-models/descriptors.ts` 中的目录描述符配置 `xiaomi`、`xiaomi-token-plan-ams`、`xiaomi-token-plan-cn` 和 `xiaomi-token-plan-sgp`,带有 `defaultModel: "mimo-v2.5"`。
- **动态模型发现**:`packages/catalog/src/provider-models/openai-compat.ts` 中的 `xiaomiModelManagerOptions` 检查密钥(`tp-` 与 `sk-`)和提供方 ID,以查询标准或区域 `/models` 端点(`XIAOMI_TOKEN_PLAN_BASE_URLS`),在返回的模型上保留区域提供方 ID。
- **音频模型过滤**:语音和音频模型从发现和目录生成中排除(`!model.id.includes("-tts") && !model.id.includes("-asr")`),在 `packages/catalog/src/provider-models/openai-compat.ts` 的 `xiaomiModelManagerOptions` 和 `scripts/generate-models.ts` 中。
- **主机匹配**:`packages/catalog/src/hosts.ts` 中的 `modelMatchesHost` 匹配 `xiaomi` 提供方 ID、`xiaomi-token-plan-` 提供方前缀和 `xiaomimimo.com` URL 标记到 `xiaomi` 主机类。

## Xiaomi Token Plan (欧洲) (`xiaomi-token-plan-ams`)
Xiaomi Token Plan(欧洲)(`xiaomi-token-plan-ams`)通过 Xiaomi 的欧洲 Token Plan 网关(`https://token-plan-ams.xiaomimimo.com/v1`)提供对 Xiaomi 的 MiMo 模型家族(如 `mimo-v2.5` 和 `mimo-v2-omni`)的区域访问。它使用 OpenAI Chat Completions 传输(`api: "openai-completions"`)。此区域提供方允许 CLI 登录(`omp login`)和动态模型查找,以在欧洲集群上存储和验证 `tp-` API 密钥,而无需跨区域回退。

### 特殊情况
- **主机匹配与扩展空闲超时**:通过 `packages/catalog/src/hosts.ts` 中 `providerPrefixes: ["xiaomi-token-plan-"]` 在 `xiaomi` 主机类下匹配。在 `packages/catalog/src/compat/openai.ts` 中,`isXiaomiHost` 匹配,启用 `isXiaomiMimo`,配置 `XIAOMI_MIMO_STREAM_IDLE_TIMEOUT_MS = 300_000`(5 分钟流式空闲看门狗)以适应 MiMo 模型上的初始响应停顿。
- **TTS/ASR 模型过滤**:`packages/catalog/src/provider-models/openai-compat.ts` 中的动态模型管理器选项(`xiaomiModelManagerOptions`)和模型生成脚本(`scripts/generate-models.ts`)过滤掉音频模型(`!model.id.includes("-tts") && !model.id.includes("-asr"`)。
- **提供方 ID 保留**:`packages/catalog/src/provider-models/openai-compat.ts` 中的 `xiaomiModelManagerOptions` 显式设置 `providerId: "xiaomi-token-plan-ams"`,并将动态发现条目映射回 `provider: "xiaomi-token-plan-ams"`,而不是将它们折叠为通用 `xiaomi`。

### 认证与使用
- **注册表提供方与 OAuth 惰性加载器**:`packages/ai/src/registry/xiaomi-token-plan-ams.ts` 中的 `xiaomiTokenPlanAmsProvider` 注册 ID `"xiaomi-token-plan-ams"`,并从 `packages/ai/src/registry/oauth/xiaomi.ts` 惰性加载 `loginXiaomiTokenPlan`。
- **区域控制台说明**:交互式 CLI 登录(`loginXiaomiTokenPlan(cb, "ams")`)提示用户输入 `tp-` 前缀 API 密钥,并引导他们前往 Token Plan 控制台 URL(`https://platform.xiaomimimo.com/console/plan-manage`)。
- **单集群验证**:`packages/ai/src/registry/oauth/xiaomi.ts` 中的 `validateXiaomiApiKey` 直接对照 `https://token-plan-ams.xiaomimimo.com/v1/chat/completions`(使用 `mimo-v2.5`,`max_tokens: 1`)验证密钥,绕过通用 `loginXiaomi` 使用的多区域回退序列。
- **标头与错误**:请求传递标准 `Authorization: Bearer tp-...` 标头。身份验证或网络失败抛出 `AIError.OAuthError` 或 `AIError.ApiKeyRequiredError`。

### 目录模型处理
- **提供方描述符**:在 `CATALOG_PROVIDERS`(`packages/catalog/src/provider-models/descriptors.ts`)中注册,带有 `id: "xiaomi-token-plan-ams"`、`defaultModel: "mimo-v2.5"`,以及管理器工厂 `xiaomiModelManagerOptions({ ...config, providerId: "xiaomi-token-plan-ams", tokenPlanRegion: "ams" })`。
- **OpenAI 兼容描述符**:通过 `packages/catalog/src/provider-models/openai-compat.ts` 中的 `openAiCompletionsDescriptor("xiaomi-token-plan-ams", "xiaomi-token-plan-ams", "https://token-plan-ams.xiaomimimo.com/v1")` 配置。
- **动态模型管理器**:`packages/catalog/src/provider-models/openai-compat.ts` 中的 `xiaomiModelManagerOptions` 将 `tokenPlanRegion: "ams"` 映射到 `fetchDynamicModels` 的基础 URL `https://token-plan-ams.xiaomimimo.com/v1`,利用 `createBundledReferenceMap("xiaomi")` 获取基线规范。
- **预打包目录模型**:捆绑模型(例如 `mimo-v2-omni`、`mimo-v2.5`)在 `packages/catalog/src/models.json` 中的键 `"xiaomi-token-plan-ams"` 下注册,设置 `baseUrl: "https://token-plan-ams.xiaomimimo.com/v1"` 和 `api: "openai-completions"`。

## Xiaomi Token Plan (中国) (`xiaomi-token-plan-cn`)
Xiaomi Token Plan(中国)是 Xiaomi MiMo 的 Token Plan 订阅服务的区域中国端点(`https://token-plan-cn.xiaomimimo.com/v1`)。它使用区域 `tp-...` API 密钥提供对 MiMo AI 模型的访问。它使用 "OpenAI Chat Completions" 传输。

### 特殊情况
- **主机分类**:`packages/catalog/src/hosts.ts` 中的 `KNOWN_HOSTS.xiaomi` 通过 `providerPrefixes: ["xiaomi-token-plan-"]` 和 `urlMarkers: ["xiaomimimo.com"]` 匹配 `xiaomi-token-plan-cn`,在所有 Token Plan 端点上启用主机级兼容性标志。
- **推理内容重放**:`packages/catalog/src/compat/openai.ts` 使用 `requiresReasoningContentForToolCalls: true` 和 `requiresReasoningContentForAllAssistantTurns: true` 标记 Xiaomi 主机上的 MiMo 模型,要求先前的助手工具调用轮保留精确的 `reasoning_content`。
- **合成推理拒绝**:`packages/catalog/src/compat/openai.ts` 中的 `allowsSyntheticReasoningContentForToolCalls` 对 MiMo 模型计算为 `false`,在工具调用延续上拒绝合成 `.` 占位符。
- **扩展流式空闲超时**:`packages/catalog/src/compat/openai.ts` 中的 `XIAOMI_MIMO_STREAM_IDLE_TIMEOUT_MS`(300,000 毫秒 / 5 分钟)覆盖默认的第一事件/空闲超时以适应预生成推理停顿。
- **音频 SKU 过滤**:`packages/catalog/scripts/generate-models.ts` 为 `xiaomi-token-plan-` 提供方过滤掉包含 `-tts` 或 `-asr` 的语音合成和识别 SKU。

### 认证与使用
- **环境变量与登录**:通过 `XIAOMI_TOKEN_PLAN_CN_API_KEY` 进行身份验证。`packages/ai/src/registry/xiaomi-token-plan-cn.ts` 中的 `xiaomiTokenPlanCnProvider.login` 在 `packages/ai/src/registry/oauth/xiaomi.ts` 中调用 `loginXiaomiTokenPlan(options, "cn")`。
- **区域 API 密钥验证**:提示从 `https://platform.xiaomimimo.com/console/plan-manage` 获取 `tp-...` 密钥,并通过 `validateXiaomiApiKey` 对 `mimo-v2.5` 严格对照 `https://token-plan-cn.xiaomimimo.com/v1` 发送 `POST /v1/chat/completions` 请求(15 秒超时,`VALIDATION_TIMEOUT_MS`)进行验证。
- **使用核算**:应用标准 OpenAI Chat Completions 使用核算(`calculateOpenAIUsageAccounting`);不存在提供方特定的使用或配额模块。

### 目录模型处理
- **提供方描述符**:在 `packages/catalog/src/provider-models/descriptors.ts` 中配置,带有 `id: "xiaomi-token-plan-cn"`、`defaultModel: "mimo-v2.5"`、`envVars: ["XIAOMI_TOKEN_PLAN_CN_API_KEY"]`,以及 `createModelManagerOptions` 委托给带有 `tokenPlanRegion: "cn"` 的 `xiaomiModelManagerOptions`。
- **OpenAI 兼容条目**:通过 `packages/catalog/src/provider-models/openai-compat.ts` 中的 `openAiCompletionsDescriptor` 注册,基础 URL 为 `https://token-plan-cn.xiaomimimo.com/v1`。
- **区域发现与模型管理器**:`packages/catalog/src/provider-models/openai-compat.ts` 中的 `xiaomiModelManagerOptions` 将发现固定到 `XIAOMI_TOKEN_PLAN_BASE_URLS.cn`(`https://token-plan-cn.xiaomimimo.com/v1`)。动态模型发现保留 `providerId: "xiaomi-token-plan-cn"`,过滤 `-tts` 和 `-asr` 模型,并使用 `createBundledReferenceMap("xiaomi")` 从捆绑的 `xiaomi` 引用规范合并元数据。

## Xiaomi Token Plan (新加坡) (`xiaomi-token-plan-sgp`)
Xiaomi Token Plan(新加坡)提供方(`xiaomi-token-plan-sgp`)使用 OpenAI Chat Completions 传输(`openai-completions`)将请求路由到 Xiaomi 的新加坡 Token Plan 集群。它使用绑定到区域的 `tp-...` API 密钥提供对 Xiaomi MiMo 模型(`mimo-v2.5`、`mimo-v2-omni`)的专用访问,目标是 `https://token-plan-sgp.xiaomimimo.com/v1`。此区域条目允许登录和模型存储与标准 Xiaomi MiMo(`xiaomi`)和其他区域 token plan 端点(`xiaomi-token-plan-ams`、`xiaomi-token-plan-cn`)隔离。

### 特殊情况
- **区域基础 URL 绑定**:`packages/catalog/src/provider-models/openai-compat.ts` 中的 `xiaomiModelManagerOptions` 在配置 `tokenPlanRegion: "sgp"` 时显式将 `baseUrl` 设置为 `https://token-plan-sgp.xiaomimimo.com/v1`(`XIAOMI_TOKEN_PLAN_BASE_URLS.sgp`),防止 token-plan 密钥恢复到标准 Xiaomi 端点 `https://api.xiaomimimo.com/v1`(`XIAOMI_STANDARD_BASE_URL`)。
- **音频/语音模型排除**:`packages/catalog/src/provider-models/openai-compat.ts` 中的 `fetchOpenAICompatibleModels` 和 `scripts/generate-models.ts`(`isXiaomiProvider`)中的模型生成器过滤从动态目录发现和生成中过滤掉包含 `-tts` 或 `-asr` 的非聊天模型。
- **扩展流式空闲超时**:`packages/catalog/src/hosts.ts` 中的 `modelMatchesHost` 通过 `providerPrefixes` 匹配 `xiaomi-token-plan-`,在 `packages/catalog/src/compat/openai.ts` 中继承 `XIAOMI_MIMO_STREAM_IDLE_TIMEOUT_MS`(300,000 毫秒 / 5 分钟),以防止 MiMo 模型上长时间初始响应延迟期间的过早超时。

### 认证与使用
- **固定区域验证**:`packages/ai/src/registry/oauth/xiaomi.ts` 中的 `loginXiaomiTokenPlan` 严格对照新加坡端点 `https://token-plan-sgp.xiaomimimo.com/v1`(`TOKEN_PLAN_VALIDATION_ENDPOINTS.sgp`)使用 `validateXiaomiApiKey`(`packages/ai/src/registry/oauth/xiaomi.ts`)验证密钥。与为 `tp-` 密钥执行 SGP -> AMS -> CN 回退的通用 `loginXiaomi` 不同,`xiaomi-token-plan-sgp` 在身份验证期间禁用跨区域回退。
- **计划管理身份验证 URL**:`packages/ai/src/registry/xiaomi-oauth.ts` 中的 `loginXiaomiTokenPlan` 由 `xiaomiTokenPlanSgpProvider`(`packages/ai/src/registry/xiaomi-token-plan-sgp.ts`)调用,提示用户使用指向 `https://platform.xiaomimimo.com/console/plan-manage`(`TOKEN_PLAN_AUTH_URL`)的说明获取区域 `tp-` 密钥(`TOKEN_PLAN_KEY_PREFIX`),与 `STANDARD_AUTH_URL`(`https://platform.xiaomimimo.com/#/console/api-keys`)形成对比。
- **验证握手**:`packages/ai/src/registry/oauth/xiaomi.ts` 中的 `validateXiaomiApiKey` 通过 `POST /chat/completions` 使用模型 `mimo-v2.5`(`TOKEN_PLAN_VALIDATION_MODEL`)、`max_tokens: 1` 和 `messages: [{ role: "user", content: "ping" }]` 测试凭据,强制执行 15 秒超时(`VALIDATION_TIMEOUT_MS = 15_000`)。
- **使用核算**:令牌消耗和缓存指标通过 `calculateOpenAIUsageAccounting`(`packages/ai/src/providers/openai-shared.ts`)使用标准 OpenAI Chat Completions 核算进行计算。

### 目录模型处理
- **提供方描述符**:在 `CATALOG_PROVIDERS`(`packages/catalog/src/provider-models/descriptors.ts`)中注册,带有 `id: "xiaomi-token-plan-sgp"`、`defaultModel: "mimo-v2.5"`,以及 `createModelManagerOptions` 提供 `tokenPlanRegion: "sgp"` 和 `providerId: "xiaomi-token-plan-sgp"`。静态模型元数据在 `packages/catalog/src/provider-models/openai-compat.ts` 的 `openAiCompletionsDescriptor` 中声明。
- **提供方身份保留**:`packages/catalog/src/provider-models/openai-compat.ts` 中的 `xiaomiModelManagerOptions` 动态模型获取器(`fetchOpenAICompatibleModels`)将所有发现的模型标记为 `provider: "xiaomi-token-plan-sgp"` 和 `baseUrl: "https://token-plan-sgp.xiaomimimo.com/v1"`,确保存储的模型选择映射回新加坡提供方条目。
- **捆绑规范映射**:动态模型映射使用 `createBundledReferenceMap`(`packages/catalog/src/provider-models/openai-compat.ts`)将动态模型与 `packages/catalog/src/models.json` 中 `"xiaomi"` 下定义的静态引用规范合并。

## Z.AI (GLM Coding Plan) (`zai`)
Z.AI 通过 Zhipu AI 的编码计划基础设施使用 Anthropic Messages 传输(`https://api.z.ai/api/anthropic`)提供 GLM 家族模型(如 `glm-5.2`)。身份验证支持直接 API 密钥和铸造持久 API 密钥的 OAuth 浏览器登录流程。

### 特殊情况
- **`zai` 思考格式方言**:`packages/catalog/src/model-thinking.ts` 中的 `isZaiThinkingFormat` 和 `packages/ai/src/providers/openai-shared.ts` 中的 `isZaiReasoningEffortDialect` 识别使用 `thinkingFormat: "zai"` 方言(`thinking: { type: "enabled" | "disabled" }`)的端点。当推理关闭时(`reasoningDisableMode === "zai-thinking-disabled"` 或线路努力度 `"none"`),`packages/ai/src/providers/openai-shared.ts` 中的 `resolveOpenAICompatPolicy` 设置 `params.thinking = { type: "disabled" }`。
- **推理内容延续重放**:在 `packages/ai/src/providers/openai-completions.ts` 的 `streamOpenAICompletionsOnce` 中,当 `compat.thinkingFormat === "zai"` 且 `model.reasoning` 为 true 时,保留的思考块在跨 API 提供方切换(例如 Anthropic → OpenAI)时重新序列化为 `assistantMsg.reasoning_content`,以在没有文本降级(#3434)的情况下保留结构化推理历史。
- **外部思考保留**:`packages/ai/src/providers/transform-messages.ts` 中的 `targetReadsForeignThinking` 对具有 `compat.thinkingFormat === "zai"` 的推理模型返回 true,在消息转换中保留非原生思考块。
- **最大输出令牌限制**:`packages/ai/src/providers/openai-shared.ts` 中的 `resolveOpenAICompletionsOutputClamp` 将 `isZaiReasoningEffortDialect` 模型(`glm-5.2`)的输出限制为 `model.maxTokens`,而不是默认的 64k 上限。
- **主机 URL 匹配**:`packages/catalog/src/hosts.ts` 中的 `hostMatchesUrl` 匹配 Z.AI 端点与 `api.z.ai` URL 标记。

### 认证与使用
- **API 密钥登录**:`packages/ai/src/registry/zai.ts` 中的 `loginZai` 提示输入 `ZAI_API_KEY`(仪表板 `https://z.ai/manage-apikey/apikey-list`),并通过针对 `https://api.z.ai/api/coding/paas/v4` 使用模型 `glm-5.2`(`VALIDATION_MODEL`)的 chat completions 探测进行验证。
- **OAuth 流程与浏览器登录**:`packages/ai/src/registry/zai.ts` 中的 `zaiCodingPlanProvider` 将登录路由到 `loginZaiOAuth` / `ZaiOAuthFlow`(`packages/ai/src/registry/oauth/zai.ts`)。它在 `AUTHORIZE_URL`(`https://chat.z.ai/api/oauth/authorize`,回调端口 54548 / 粘贴代码回退)启动授权,并在 `TOKEN_URL`(`https://zcode.z.ai/api/v1/oauth/token`)交换授权代码。
- **持久密钥铸造**:`packages/ai/src/registry/oauth/zai.ts` 中的 `mintZaiApiKey` 通过 `businessLogin`(`https://api.z.ai/api/auth/z/login`)将短期 OAuth 令牌交换为业务令牌,通过 `getCustomerInfo`(`BIZ_BASE` = `https://api.z.ai`)解析默认组织/项目,创建或重用密钥 `"oh-my-pi"`(`KEY_NAME`),并通过 `/copy/${apiKey}` 复制密钥以输出保存为 `storeCredentialsAs: "zai"` 的持久 49 字符 `${apiKey}.${secretKey}` 令牌。
- **使用与配额获取器**:`packages/ai/src/usage/zai.ts` 中的 `fetchZaiUsage` / `zaiUsageProvider` 在 `DEFAULT_ENDPOINT`(`https://api.z.ai`)上使用直接密钥授权查询 `QUOTA_PATH`(`/api/monitor/usage/quota/limit`)。`parseLimitItem` 将 `TOKENS_LIMIT` 解析为令牌配额(`zai:tokens:<window>`),将 `TIME_LIMIT` 解析为请求配额(`zai:requests:<window>`,或在 `isZaiFeatureRequestLimit` 匹配时为 `zai:features:zread:<window>`)。`buildZaiWindow` 将时间单位映射到 1h、1d、1mo 或 1w 窗口,并可选地获取 `MODEL_USAGE_PATH`(`/api/monitor/usage/model-usage`)。
- **凭据排名**:`packages/ai/src/usage/zai.ts` 中的 `zaiRankingStrategy`(在 `packages/ai/src/auth-storage.ts` 中注册)通过 `rankZaiRequestLimits` 对请求限制进行排名,选择主要 5 小时和次要每周配额窗口。

### 目录模型处理
- **描述符与 PAYG 定价**:`packages/catalog/src/provider-models/openai-compat.ts` 中的 `MODELS_DEV_PROVIDER_DESCRIPTORS_CODING_PLANS` 定义 `anthropicMessagesDescriptor("zai", "zai", "https://api.z.ai/api/anthropic")`,映射 models.dev `zai` 按需付费定价键而不是 `zai-coding-plan`,以避免将订阅费率显示为全 $0 免费模型(#5598)。
- **默认模型与上下文策略**:`packages/catalog/src/provider-models/descriptors.ts` 中的 `PROVIDER_DESCRIPTORS` 设置默认模型 `glm-5.2`。`packages/catalog/scripts/generated-policies.ts` 中的 `generated-policies.ts` 将 `glm-5.2` 上下文窗口固定为 1,000,000 令牌,而 `packages/catalog/scripts/generate-models.ts` 中的 `dropUnusableZaiContextTierIds` 过滤掉 `[1m]` 上下文层级 ID 后缀。
- **GLM-5.2 努力度支持**:`packages/catalog/src/model-thinking.ts` 中的 `getModelDefinedEfforts`(通过 `isAnthropicMessagesGlm52ReasoningEffortModel` 检查)将 `HIGH_MAX_REASONING_EFFORTS`(`["high", "max"]`)分配给 `glm-5.2`,将 `"none"` 视为禁用状态而不是用户层级。

## ZenMux (`zenmux`)
ZenMux 是一个多提供商网关，基于模型所有权采用双传输路由。由 Anthropic 拥有的模型（通过 `owned_by: "anthropic"` 或 `anthropic/` 前缀识别）通过 Anthropic Messages（`https://zenmux.ai/api/anthropic`）路由，而所有其他模型通过 OpenAI Chat Completions（`https://zenmux.ai/api/v1`）路由。

### 特殊情况处理
- **双传输基础 URL 规范化**：`normalizeZenMuxOpenAiBaseUrl` 和 `toZenMuxAnthropicBaseUrl`（`packages/catalog/src/provider-models/openai-compat.ts`）在端点 URL 之间进行转换。OpenAI 端点默认为 `https://zenmux.ai/api/v1`，Anthropic 路由到 `https://zenmux.ai/api/anthropic`，在指定自定义基础 URL 时自动转换路径。
- **Anthropic 代理签名完整性**：`KNOWN_HOSTS.zenmux`（`packages/catalog/src/hosts.ts`）将 ZenMux 标识为签名主机。在 `buildAnthropicCompat`（`packages/catalog/src/compat/anthropic.ts`）中，`isZenmux` 将代理标记为 `signingEndpoint`，设置 `replayUnsignedThinking: false`。这确保历史思考块保留有效签名，而不是重放会触发 HTTP 400 错误的空签名。
- **严格模式支持**：`detectStrictModeSupport`（`packages/catalog/src/compat/openai.ts`）为 ZenMux 兼容 OpenAI 的端点启用严格的结构化工具输出。

### 认证与使用
- **API 密钥解析**：`ZENMUX_API_KEY` 在 `descriptors.ts`（`packages/catalog/src/provider-models/descriptors.ts`）中注册，并通过 `packages/ai/src/stream.ts` 中的 `getEnvApiKey("zenmux")` 解析。
- **密钥验证与登录**：`packages/ai/src/registry/zenmux.ts` 中的 `loginZenMux` 将用户引导至 `https://zenmux.ai/settings/keys`，并使用 `kind: "models-endpoint"` 对 `https://zenmux.ai/api/v1/models` 验证凭据。
- **未认证发现**：`descriptors.ts` 中的 `allowUnauthenticated: true` 允许无需 API 密钥即可发现模型目录。

### 目录模型处理
- **描述符与默认模型**：`descriptors.ts` 定义提供商描述符，默认模型为 `anthropic/claude-opus-4.8`。
- **动态模型发现**：`packages/catalog/src/provider-models/openai-compat.ts` 中的 `zenmuxModelManagerOptions` 使用 `fetchOpenAICompatibleModels` 查询 `https://zenmux.ai/api/v1/models`。`isZenMuxAnthropicModel` 检查 `entry.owned_by === "anthropic"` 或 ID 前缀 `anthropic/` 以设置 `api: "anthropic-messages"` 或 `api: "openai-completions"`。
- **价格提取**：`getZenMuxPricingValue` 和 `getZenMuxCacheWritePrice`（`packages/catalog/src/provider-models/openai-compat.ts`）从 `entry.pricings` 提取 token 成本：`prompt` 表示输入成本，`completion` 表示输出成本，`input_cache_read` 表示缓存读取成本，并通过层级查找 `input_cache_write_1_h`、`input_cache_write_5_min` 或 `input_cache_write` 获取缓存写入成本。
- **能力与限制**：映射 `entry.display_name`、`entry.context_length`（`contextWindow`）、`entry.max_completion_tokens`（`maxTokens`）、`entry.input_modalities`（`input`）和 `capabilities.reasoning`（`reasoning`）。

## 智谱 Coding Plan（智谱）(`zhipu-coding-plan`)
智谱（智谱）BigModel 的国内编程计划提供商，使用 OpenAI Chat Completions 传输（`openai-completions` API）。它将请求路由到智谱的专用 Coding Plan 端点（`https://open.bigmodel.cn/api/coding/paas/v4`）而非通用 BigModel 端点，以确保 API 调用消耗编程计划配额而非账户余额。

### 特殊情况处理
- **Z.AI 思考格式与推理力度**：配置 `thinkingFormat: "zai"`（`packages/catalog/src/compat/openai.ts` 第 447 行），通过 `thinking: { type: "enabled" }` 和 `reasoning_content` 增量来构建思考输出（交叉引用 Z.AI 格式）。仅通过 `isGlm52ReasoningEffortModelId`（`packages/catalog/src/compat/openai.ts` 第 283、469 行）为 GLM-5.2+ 模型启用 `supportsReasoningEffort`。
- **流监控空闲下限**：当 `isZhipu` 处于激活状态时，为 GLM 编程计划模型 ID（`glm-5...`）应用 600 秒（`600_000` 毫秒）流空闲超时下限（`GLM_CODING_PLAN_STREAM_IDLE_TIMEOUT_MS = 600_000`，`packages/catalog/src/compat/openai.ts` 第 39-40、417 行中的 `GLM_CODING_PLAN_MODEL_PATTERN`），以避免长时间推理阶段出现虚假的流监控中止。
- **最大 Token 数与系统消息**：为 `isZhipu` 设置 `useMaxTokens: true`（`packages/catalog/src/compat/openai.ts` 第 362 行），并启用 `supportsMultipleSystemMessages: true`（`packages/catalog/src/compat/openai.ts` 第 408 行）。

### 认证与使用
- **凭据与 API 基础**：通过 `ZHIPU_API_KEY`（`packages/catalog/src/provider-models/descriptors.ts` 第 541 行）进行认证，API 基础 URL 为 `https://open.bigmodel.cn/api/coding/paas/v4`（`packages/ai/src/registry/zhipu-coding-plan.ts` 第 6 行），仪表板 URL 为 `https://bigmodel.cn/coding-plan/personal/overview`（`packages/ai/src/registry/zhipu-coding-plan.ts` 第 5 行）。
- **API 密钥登录与验证**：`loginZhipuCodingPlan`（`packages/ai/src/registry/zhipu-coding-plan.ts` 第 10 行）使用 `createApiKeyLogin`，密钥格式为 `<id>.<secret>`，在 `https://open.bigmodel.cn/api/coding/paas/v4` 上针对 `glm-5.1` 进行验证。主机检测通过 `hosts.ts`（`zhipu`，urlMarker `open.bigmodel.cn`，`packages/catalog/src/hosts.ts` 第 42 行）连接。
- **中文 429 配额分类**：`packages/ai/src/error/rate-limit.ts` 第 60 行中的 `CN_QUOTA_EXHAUSTED_PATTERN`（`/使用.{0,30}?上限|(?:额度|配额)已?(?:用|耗)(?:完|尽)|限额.{0,30}重置|余额不足/`）将智谱的 429 配额耗尽响应（`"429 已达到 5 小时的使用上限。您的限额将在 ... 重置。"`）归类为 `QUOTA_EXHAUSTED`，触发凭据轮换而非临时退避。

### 目录模型处理
- **提供商描述符**：在 `CATALOG_PROVIDERS`（`packages/catalog/src/provider-models/descriptors.ts` 第 539 行）中注册，默认模型为 `glm-5.1`，`dynamicModelsAuthoritative: true`，模型管理器选项来自 `zhipuCodingPlanModelManagerOptions`（`packages/catalog/src/provider-models/openai-compat.ts` 第 1689、5764 行）。
- **GLM 身份分类**：使用 `parseGlmModel`（`packages/catalog/src/identity/classify.ts` 第 145 行）将 `glm-<version>[v][-<variant>]` 解析为族（`"glm"`）、版本、视觉标志（`v`）和变体（`base`、`air`、`turbo`、`flash`、`flashx`、`preview`）。
- **能力门槛与策略**：`isReasoningGlmModelId`（`packages/catalog/src/identity/family.ts` 第 219 行）在版本 >= 4.5（`base`/`air`/`turbo`）时启用推理，`isGlm52ReasoningEffortModelId` 在版本 >= 5.2 时启用 `reasoning_effort`，`isGlmVisionModelId` 检测视觉模型（`glm-4v`、`glm-4.5v`）。生成的策略将 `glm-5.2` 上下文窗口固定为 1,000,000 token（`packages/catalog/scripts/generated-policies.ts` 第 332 行）。
