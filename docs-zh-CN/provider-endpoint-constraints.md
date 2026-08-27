# 提供商端点约束

提供商集成并不能因为它们都使用类 OpenAI 的 HTTP 协议就互换使用。
一个请求同时由四层共同决定其形态：

1. 端点族：`openai-completions`、`openai-responses`、
   `openai-codex-responses`、`anthropic-messages` 等
2. 网关/认证层：OpenRouter、Vercel AI Gateway、Azure OpenAI、Copilot、
   Alibaba Coding Plan、Kimi Code、Fireworks/Firepass 等宿主
3. 模型元数据与 `compat` 覆盖
4. 请求上下文：工具、图像、推理模式、有状态会话、服务层级

在新增提供商、新增 compat 开关，或将逻辑从提供商特定分支中抽离时，
请参考本页。目标是仅在真正拥有该行为的最小层一次性编码端点约束。

相关参考：

- [Providers](./providers.md) — 提供商可用性、凭证、自定义提供商
- [Model and Provider Configuration](./models.md) — `models.yml`、路由与 compat 字段
- [Provider streaming internals](./provider-streaming-internals.md) — 流事件归一化
- [Provider compat reference](./provider-compat-reference.md) — 每个 compat 开关、推理层级、各提供商的工具处理
- [Provider quirks](./provider-quirks.md) — 各提供商的特例、流行为、认证/用量、目录处理
- [Adding a provider](./adding-a-provider.md) — 新提供商的目录/认证接入

## 基线规则

- 当行为可由模型或端点配置决定时，优先使用 compat 元数据，
  而不是按提供商名称分支。
- 将传输机制保留在传输层本地。Codex websocket 重放、Responses
  条目路由、Chat Completions SSE 解码属于协议行为，而非通用
  compat 开关。
- 将回退范围限定到失败的能力。严格工具失败不应禁用不相关的功能。
  过期的 Responses 链应重置链状态，而非完全禁用 Responses。
- 不要发出会改变网关路由的默认值。OpenRouter 是默认 `max_tokens`
  的已知案例，但任何网关都可能将可选字段视为路由提示。
- 在出现可见副作用后停止重试。一旦文本或工具调用对用户/会话可见，
  重试策略必须避免重复输出和重复工具执行。

## 1. 首先选择端点族

### 兼容 OpenAI Chat Completions

保留以下差异，而不是把每个宿主都当作标准 OpenAI 处理：

- `stream_options.include_usage` 仅在 compat 指明支持流式用量时才是安全的。
- `store: false` 仅被部分宿主接受。
- 最大输出上限使用 `max_tokens` 或 `max_completion_tokens`。
- 在当前的类 OpenAI 端点集中，停止序列和频率惩罚仅出现在该路径上。
- OpenRouter 风格的推理与路由字段不可移植到其他 OpenAI 兼容宿主，
  除非 compat 明确允许。

### 兼容 OpenAI Responses

Responses 请求形态自成一派：

- 使用 `input`、`instructions`、`store`、`prompt_cache_key`、可选的
  `previous_response_id`，以及 `max_output_tokens`
- 可以将官方 OpenAI 请求默认为带 `previous_response_id` 加
  `store: true` 的有状态链接
- 第三方 Responses 代理可能拒绝原生推理历史、加密推理重放，
  或 `previous_response_id`
- 流式完成仅在 `response.completed` 或 `response.incomplete` 之后
  才被视为权威；若流在任一终结事件之前关闭，对 OpenAI Responses
  而言应判定为失败，而非将部分输出作为成功呈现

### OpenAI Codex Responses

Codex 并不是换了 URL 的普通 Responses。请将以下视为 Codex 传输策略：

- Codex 账户头和 beta 头
- `x-codex-turn-state` 和 `x-models-etag`
- 可选的 websocket 传输及 SSE 回退
- `responsesLite`
- 用作传输状态的 prompt-cache/session id
- 仅 websocket 的 `previous_response_id` 链接；SSE 从不链接
- Codex 重试/重放规则，包括重连和 SSE 重放边界
- 提供商重试仅在用户可见内容尚未发出前进行
- 仅包含空白字符的工具调用参数循环中断器

Codex 故意不转发调用方设置的最大 token 上限，因为后端会拒绝。

### Anthropic/OpenAI 双表面提供商

Kimi Code 和 Synthetic 可以以 OpenAI 兼容或 Anthropic 兼容方式调用。
适配层可能需要：

- 切换 `format`
- 必要时重建一个 Anthropic 模型
- 将内部推理映射为 Anthropic 思考预算
- 回退到 OpenAI Completions

不要将这些编码为单向的提供商迁移；它们是运行时的表面选择决策。

## 2. 应用网关与认证覆盖

这些约束位于端点族之上。它们影响认证、请求头、路由、模型 id
或用量统计。

### Azure OpenAI

- Chat Completions 将基地址改写为
  `/deployments/{deployment}/chat/completions?api-version=...`。
- Responses 使用 `/responses?api-version=...` 而无部署作用域的 URL；
  部署名称改为作为请求的 `model` 发送。
- 两种表面都可以通过 `AZURE_OPENAI_DEPLOYMENT_NAME_MAP` 将模型 id
  映射为部署名称。
- Responses 使用 `api-key` 头进行认证，默认 API 版本为 `v1`，
  使用无状态的 `store: false`，并拒绝显式 prompt 缓存。

### GitHub Copilot

- API key 被解析为访问令牌。
- 动态 Copilot 请求头依赖于消息/图像。
- `premiumRequests` 必须在用量填充与替换过程中保留。
- 基地址可能从原始 key 解析得到。

### OpenRouter

- 添加归属/缓存头。
- 支持诸如 `:nitro` 和 `:floor` 的路由后缀。
- 仅在模型 id 在最后一个提供商路径段后没有显式后缀时，
  才追加路由后缀。
- 使用嵌套的 `reasoning` 请求字段。
- 通过 OpenRouter 的 `provider` 对象路由提供商。
- 具有特殊的缓存写入用量统计。
- 对 Anthropic 语法大小失败具有严格工具回退。
- 应省略目录默认的 `max_tokens`，除非调用方显式设置了上限，
  以避免对上游路由产生偏向。

### Vercel AI Gateway

- 路由偏好放在 `providerOptions.gateway.only` 和
  `providerOptions.gateway.order` 下。
- 不要复用 OpenRouter 的 `provider` 对象。

### Alibaba Coding Plan

- API key 字节可能是携带 `{ token, enterpriseUrl }` 的 JSON。
- 认证和基地址解析是提供商特定的。

### Kimi Code

- OpenAI 兼容路径需要常见的 Kimi 请求头。
- 它同时也参与 OpenAI/Anthropic 双表面适配。

### Fireworks 和 Firepass

- 线协议模型 id 需要提供商特定的映射。
- 在合并额外 body 字段后，Fireworks 可能在 DeepSeek 风格的
  `thinking` 与 OpenAI 风格的 `reasoning_effort` 同时存在时发生冲突。

## 3. 按方言序列化请求参数

在新增或转发字段前检查以下事项：

- **Model id。** 某些模型会从推理 effort 解析出 wire id。
  Firepass/Fireworks 会转换 id。OpenRouter 后缀处理是路径段感知的。
- **Max output tokens。** Kimi 系列模型即使调用方未设置，也可能
  要求最大 token 字段。OpenRouter 应省略目录默认值，除非显式设置。
  Codex 丢弃调用方上限。Responses 使用 `max_output_tokens`；Chat
  Completions 使用 `max_tokens` 或 `max_completion_tokens`。
- **Service tier。** Completions、Responses 和 Codex 都处理服务层级，
  但允许的值和价格倍率不同。Codex 对 `gpt-5.5` 有特殊优先级倍率。
- **Prompt cache/session。** OpenAI Responses 使用 `prompt_cache_key`。
  OpenRouter Responses 使用 `session_id`。Codex 将 prompt cache/session id
  用作传输状态。Anthropic 风格的缓存控制需要在文本 part 上设置
  `cache_control`。
- **Stateful chaining。** 官方 OpenAI Responses 默认可链接。
  第三方端点通常不应如此。Codex 仅在 websocket `response.create` 上链接。

## 4. 显式映射 reasoning 与 thinking

推理字段之间不可互换。

### OpenAI 风格 `reasoning_effort`

- Effort 值来自 compat/模型元数据。
- 如果禁用了推理但宿主没有真正的关闭开关，应映射为受支持的最低 effort，
  而不是凭空发明一个不支持的值。

### Responses `reasoning`

- 使用 `reasoning: { effort, summary }`。
- 可包含 `reasoning.encrypted_content` 用于重放。
- xAI Grok 模型可能需要省略 `reasoning.effort`。
- 某些 compat 路径会注入 GPT-5 的 `# Juice: 0 !important` 开发者脚手架。

### OpenRouter `reasoning`

- 使用嵌套的 `reasoning: { effort }`。
- 禁用推理必须发送 `reasoning: { enabled: false }`；否则 OpenRouter
  可能将默认的推理模型切换为思考模式。

### Z.AI / GLM

- 使用 `thinking: { type: "enabled" }` 或
  `thinking: { type: "disabled" }`。
- GLM 5.2 reasoning-effort 模型也可能接收 `reasoning_effort`。
- 工具请求需要 `tool_stream: true`。

### Qwen

- 一种方言使用顶层 `enable_thinking`。
- 另一种使用 `chat_template_kwargs.enable_thinking`。

### 兼容 Anthropic 的格式

- 推理映射为 Anthropic 的 thinking 启用与 thinking 预算 token，
  而非 OpenAI 风格字段。

### DeepSeek 推理历史

- DeepSeek 兼容的推理模型可能要求精确的 `reasoning_content` 重放。
- 某些变体要求在每个助手回合都重放，而不仅限于工具调用回合。
- 合成的 `"."` 占位符对 Kimi/OpenRouter 风格 compat 可以接受，
  但对 DeepSeek V4 的精确重放则不行。

### 推理加工具选择

- DeepSeek 推理模型在 thinking 启用时可能拒绝 `tool_choice`。
- Kimi 在 thinking 启用时可能拒绝强制工具选择。
- Compat 需要同时具备两种策略：对任何工具选择禁用推理，
  以及仅对强制工具选择禁用推理。

### xAI Grok 通过 Responses（`xai` 和 `xai-oauth`）

付费 API key 提供商（`xai` / `XAI_API_KEY`）和 SuperGrok OAuth
（`xai-oauth`）都通过 `https://api.x.ai/v1/responses` 进行对话。
请保持以下各项独立处理：

- 除非模型在 Grok effort 支持的允许列表中，否则省略 `reasoning.effort`
- 省略 `reasoning.summary`（宿主会拒绝；不要回退到 `"auto"`）
- 省略存在/频率惩罚（`/v1/responses` 对每个 Grok 模型都会拒绝）
- 在请求中包含 `reasoning.encrypted_content`
- 在后续回合中重放加密的推理条目

某些模型仅拒绝其中某一个字段；不要将它们合并为一个"Grok 模式"分支。

## 5. 按端点归一化工具与 schema

### 严格工具

严格 schema 不是通用能力：

- 部分提供商支持严格工具
- 部分拒绝混合使用严格/非严格工具
- 部分拒绝被严格化后的 schema
- OpenRouter 上的 Anthropic 模型可能因"编译语法过大"而失败

不带严格模式的回退应该是限定在当前会话/提供商路径的 compat 恢复策略。

### Responses 与 Codex 自定义工具

Responses 和 Codex 都支持用于 `apply_patch` 的 freeform 自定义语法工具。
自定义语法工具并不强制请求级别的 `parallel_tool_calls`；Codex 的
`responsesLite` 在存在工具时单独禁用请求级别的并行工具调用。
Responses 还会：

- 以不同方式清理 schema
- 隔离无效的 enum/const schema 冲突
- 将孤立的工具输出修复为助手注释
- 为孤立的工具调用合成占位输出

Codex 在发送前应用其自身的请求转换。

### 工具选择

在发出 `tool_choice` 之前：

- 确认端点支持该选项
- 如果不支持强制选择，则降级为 `auto`
- 当没有工具发出时，丢弃 `tool_choice: "none"`
- 当指定的具名工具被过滤掉时，丢弃强制具名工具选择

### 通过 LiteLLM/Bedrock 的 Anthropic

- 如果历史中包含工具调用/结果且 `context.tools` 未定义，则发送
  `tools: []` 作为哨兵。
- 如果 `context.tools = []`，则视为显式 opt-out，不要发出该哨兵。

### Mistral / Devstral

- 工具调用 id 必须正好是 9 个字母数字字符。
- 某些流程在工具结果之后、下一个用户消息之前需要合成的助手桥接。

### 自定义工具输出

Responses/Codex 必须记住调用是否为 `custom_tool_call`；配对的输出
随后必须是 `custom_tool_call_output`，而不是 `function_call_output`。

### MiniMax 兼容的流式参数

工具参数可以流式作为对象而非 JSON 字符串。深合并对象增量，
然后发出一个最终可安全拼接的 JSON 增量。

## 6. 安全地转换消息并重放历史

- **System/developer 角色。** 推理模型可能要求 `developer`。某些
  提供商不支持 `developer`，必须降级为 `user`。某些拒绝多个系统
  消息，需要合并。
- **Responses 系统提示。** Responses 通常使用顶层 `instructions`。
  支持 `developer` 的推理模型将系统提示内联为 developer 消息。
- **助手内容。** 某些 OpenAI 兼容后端按字面镜像数组内容，因此助手内容
  被归一化为字符串。工具调用重放可能要求 `content: ""` 或 `content: "."`
  而非 `null`。
- **思考重放。** 某些模型希望将思考作为可见文本。某些需要提供商特定的
  推理字段。某些允许合成占位符；某些需要精确重放。
- **视觉。** 如果模型/提供商无法接受图像，将图像输入和工具结果中的图像
  转换为占位符。某些 Qwen/Dashscope 兼容模式即使在高层模型是多模态
  时也是纯文本。
- **原生 Responses 历史。** 原生提供商 payload 重放是模型绑定的。
  剥离或归一化外部推理签名。共享代码会归一化 Responses 中以竖线分隔
  的工具 id，对外部条目 id 进行哈希，并可过滤推理历史。

## 7. 按提供商行为而非仅按 schema 解码流

- **通用 OpenAI 兼容流。** 保活 chunk、仅 role 的 delta 和空的
  `choices: []` 都不是进度。空闲看门狗不得因此永远睡眠。
- **Mistral Medium 3.5 风格内容。** `delta.content` 可以是文本部分的
  数组/对象，而不是字符串；应归一化为文本。
- **DeepSeek 通过 NVIDIA/native/代理。** 某些端点会将 chat-template
  标记（如 `<｜...｜>`）泄漏到可见内容中。由于标记可能被拆分到
  不同 chunk 中，必须进行缓冲。
- **DeepSeek/模板泄漏的工具调用。** 某些提供商会同时在文本中泄漏
  工具调用标记并产生结构化工具调用。标记修复应属于流解码器策略，
  而非端点业务逻辑。
- **MiniMax-M3 累积推理。** 推理增量可能是累积快照。应按推理字段签名
  去重。
- **Responses 流。** 通过 `output_index`、`item_id`、call-id 别名
  以及带前缀的 `fc_` 别名路由并行条目。容忍缺失的 `content_part.added`
  或 `output_item.added`。在终结事件时终结挂起的工具调用。
- **终结行为。** Chat Completions 可能在 `finish_reason` 加用量之后结束。
  Responses 在 `response.completed` 或 `response.incomplete` 时结束。
  `stop` 的工具调用提升为 `toolUse`。Codex/Responses 的 `end_turn:false`
  映射为 `pause_turn`。
- **Ollama 长度失败。** `finish_reason: length` 且无可见内容被视为
  上下文窗口失败，并映射为错误。

## 8. 保留用量与成本语义

- OpenRouter `prompt_tokens_details.cache_write_tokens` 计费方式不同：
  从输入 token 中减去，并作为 cache-write 用量发出。
- DeepSeek 原生 `prompt_cache_miss_tokens` 是计费的输入部分，而非单独
  的 cache-write 费用。不要重复计算。
- GitHub Copilot `premiumRequests` 必须在用量被填充或替换时保留。
- Responses 和 Codex 都按解析后的服务层级调整成本，但 Codex 使用
  不同的倍率。

## 9. 在正确的边界实现恢复

- **严格工具回退。** `400`/`422` schema 或严格工具失败应禁用
  适当会话范围内的严格工具，并以非严格模式重试。
- **OpenAI Responses 有状态回退。** 过期、无效或不受支持的
  `previous_response_id` 重置链状态并以完整上下文重试。
  零数据保留立即禁用链接。
- **Codex websocket 回退。** Websocket 连接错误、过期的 socket、
  连接限制、重试预算耗尽或不安全的部分输出都可能触发重连
  或 SSE 重放。
- **Codex 空白工具循环中断器。** Codex 可能无限地流式发出仅含空白字符
  的工具调用参数增量。限制事件/字符数，丢弃退化的部分工具调用，
  仅在安全时重试。
- **Codex `previous_response_id` 回退。** 过期或不受支持的 id 属于
  链中断，并以完整上下文重试，但仅对 websocket 如此，因为 SSE
  从不链接。
- **提供商在内容发出前重试。** Codex 仅在用户可见内容尚未发出前
  对可重试的提供商流错误进行重试。

## 10. 新约束的检查清单

在新增分支或 compat 字段前，按顺序回答以下问题：

1. 这是端点族行为、网关行为、模型行为，还是请求上下文行为？
2. 是否可以由现有的 `compat` 元数据表示？
3. 如果不能，是新增 compat 字段更好还是按提供商名称分支更好？
4. 该字段需要提供商级默认值、模型级覆盖，还是两者都需要？
5. 它是否与工具、图像、推理、有状态 Responses 链或服务层级交互？
6. 重试是否只能在可见文本/工具调用出现之前进行？
7. 用量统计是否仍然保留 cache 读/写、计费输入、服务层级倍率，
   以及诸如 Copilot `premiumRequests` 这样的提供商特定计数器？
