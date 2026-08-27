# pi-native auth-gateway 传输

`pi-native` 是 pi-ai 客户端与 `omp auth-gateway` 之间的无损传输。它
**不是文本工具调用方言**：在当前实现中不存在 `<call:NAME>` 语法、
解析器、渲染器，也不存在 `PI_DIALECT=pi-native` 这个取值。工具调用
仍然是 `Context` 和 `AssistantMessageEvent` 内的规范 pi-ai `ToolCall`
内容块。

在客户端已经使用 pi-ai、并且网关持有 provider 凭据时使用此传输——例如，
容器化 omp 与宿主网关通信，或 robomp 插槽与其 sidecar 通信。
OpenAI/Anthropic 兼容路由会进行翻译，可能丢失 pi 特有字段；pi-native
直接发送规范类型，从而保留 service tier、cache 标记、thinking 预算、
tool-choice 变体、图像以及工具调用 ID。

## 配置与调度

模型通过以下方式启用：

```yaml
transport: pi-native
baseUrl: http://gateway.internal:4000
```

`baseUrl` MUST 标识一个 `omp auth-gateway`（或兼容服务）。缺少
`baseUrl` 将以如下错误失败：

```text
pi-native transport requires `baseUrl` on model MODEL_ID (set it on the provider config in models.yml)
```

当 `model.transport === "pi-native"` 时，`streamSimple` 会绕过常规的
按 API provider 实现，转而调用 `streamPiNative`。客户端会移除
`baseUrl` 末尾的斜杠并向 `/v1/pi/stream` 发起 POST 请求。

网关 bearer 是已解析的 model/API key。它以
`Authorization: Bearer …` 形式发送，绝不出现在 JSON options 中。模型
headers 也会被转发；显式的 `model.headers.Authorization` 优先于已解析
的 key。

`transport` 仅影响调度。价格、上下文窗口、maximum-token 以及 thinking
元数据仍然在本地从模型目录中解析。

## 请求

```http
POST /v1/pi/stream
Content-Type: application/json
Accept: text/event-stream

{
  "modelId": "provider/model-id",
  "context": {
    "systemPrompt": ["..."],
    "messages": [],
    "tools": []
  },
  "options": {},
  "stream": true
}
```

客户端始终将 `modelId` 限定为 `${provider}/${id}` 形式，并始终请求
流式响应。服务器也接受 `modelId`、字符串形式的 `model` 或 `model.id`；
其底层请求解析器将 `stream` 默认设为 `true`。

网关边界的校验刻意保持浅层：

- 请求体 MUST 是一个对象；
- MUST 提供一个非空的模型标识符；
- `context` MUST 是一个带有 `messages` 数组的对象；
- 当存在时，`context.systemPrompt` 和 `context.tools` MUST 是数组。

非法的形状会生成校验错误。规范的消息/工具内部结构不会在此边界重新
校验；下游失败会以网关上游错误的形式呈现。

## 跨网络传输的 Options

服务器接受以下 `SimpleStreamOptions` 子集：

`temperature`、`topP`、`topK`、`minP`、`presencePenalty`、
`frequencyPenalty`、`repetitionPenalty`、`stopSequences`、`maxTokens`、
`cacheRetention`、`cachedContent`、`headers`、`initiatorOverride`、
`maxRetryDelayMs`、`metadata`、`sessionId`、`promptCacheKey`、`promptCache`、
`statefulResponses`、`streamFirstEventTimeoutMs`、`streamIdleTimeoutMs`、
`reasoning`、`disableReasoning`、`hideThinkingSummary`、`thinkingBudgets`、
`toolChoice`、`serviceTier`、`kimiApiFormat`、`syntheticApiFormat`、
`preferWebsockets`、`openrouterVariant`，以及 `loopGuard`。

未知的、为 `null` 的和 `undefined` 的 option 值会被服务器静默丢弃。
客户端还会额外剥离运行时/服务器所拥有的字段：`signal`、`apiKey`、
`fetch`、`onPayload`、`onResponse`、`onSseEvent`、`execHandlers`、
`cursorExecHandlers`、`cursorOnToolResult`，以及
`providerSessionState`。`onResponse` 仍然会针对网关的 HTTP 响应在本地
运行；回调与运行时句柄本身绝不会跨网络传输。

## 流式响应

每个规范的 `AssistantMessageEvent` 都会被 JSON 序列化（不做重塑）
并以 SSE 框架发送：

```text
data: {"type":"start",...}

data: {"type":"text_delta",...}

data: {"type":"done","reason":"stop","message":{...}}

data: [DONE]

```

服务器在规范的 `done` 或 `error` 事件之后停止，然后写入 `[DONE]`。
如果其事件迭代器先抛出，则会尽力发送
`{"type":"error","reason":"error","errorMessage":"..."}`，随后是
`[DONE]`。取消 HTTP 请求体会将取消信号传播到网关请求。

客户端会解析每个事件并将其原样推送到
`AssistantMessageEventStream`；不存在 partial-content 重建或工具
转换。调用方中止会取消响应体。首事件和空闲看门狗在提供 request
options 时使用这些选项，否则使用标准的
`PI_STREAM_FIRST_EVENT_TIMEOUT_MS` / `PI_STREAM_IDLE_TIMEOUT_MS` 策略。
初始的 `start` 事件不被视为空闲看门狗的进度。

如果 SSE 连接在没有终止事件的情况下关闭，客户端会合成一个终止的
assistant 边界，使 `.result()` 不会挂起。调用方取消会发出
`{type:"error", reason:"aborted", error: syntheticAssistant}`；其中嵌套
的 `AssistantMessage` 具有 `stopReason:"aborted"` 以及
`errorMessage:"stream closed without terminal event"`。其他任何干净的
关闭会发出 `{type:"done", reason:"stop", message: syntheticAssistant}`，
其嵌套消息具有 `stopReason:"stop"`。因此 `reason` 是顶层事件字段；
`stopReason` 仅存在于嵌套的 `AssistantMessage` 中。

客户端仅消费流式响应。服务器端点也支持 `stream: false`，返回：

```json
{ "message": { "role": "assistant", "content": [] } }
```

其中 `message` 中是完整的规范 `AssistantMessage`。

## 错误

抵达 pi-native 路由的 provider/handler 失败使用：

```json
{ "error": { "type": "rate_limit_error", "message": "..." } }
```

并附带适当的 HTTP 状态码、`Content-Type: application/json`，以及
`Cache-Control: no-store`。客户端会将此形状转换为
`AuthGatewayError`，保留状态码、响应头以及 `type`。

Bearer 鉴权在路由处理器之前运行。缺失或无效的网关 bearer 会被拒绝
为 `{"error":"unauthorized"}`，而非结构化的 provider 错误体；因此
客户端使用其通用的 `auth-gateway STATUS: BODY_OR_STATUS_TEXT` 回退
路径，并且没有 provider 的 `type` 需要保留。其他不符合规范的错误体
也使用相同的回退路径。没有 body 的成功响应同样是
`AuthGatewayError`。

## 权威来源

- `packages/catalog/src/types.ts` — `Model.transport`
- `packages/ai/src/stream.ts` — pi-native 调度
- `packages/ai/src/providers/pi-native-client.ts` — 请求、鉴权、SSE
  以及超时行为
- `packages/ai/src/providers/pi-native-server.ts` — 请求校验、
  option 白名单、SSE 以及错误体
- `packages/ai/src/auth-gateway/server.ts` — `/v1/pi/stream` 路由以及
  网关的 model/credential 解析
