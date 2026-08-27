# Anthropic Claude 工具使用（Messages API 内容块）

Anthropic 的 Claude 是一个闭源的托管模型系列；没有公开的权重，因此也没有需要设置的 `--tool-call-parser` 标志。规范的工具调用约定是 **Messages API**（`POST /v1/messages`，请求头 `anthropic-version: 2023-06-01`）：工具在顶层 `tools` 数组中声明，模型返回结构化的 `tool_use` **内容块**，并带有 `stop_reason: "tool_use"`，你将结果作为 `tool_result` 内容块放在 `user` 消息内回传。工具使用只需通过包含 `tools` 参数（可选地加上 `tool_choice`）即可“启用”；API 会注入一个工具使用的系统提示，并将模型的输出解析回 JSON 块。这一约定适用于所有当前模型（Claude Opus / Sonnet / Haiku 3.x、4、4.x）以……

在底层，模型被训练为发出 **XML** 函数调用语法（`<function_calls>` / `<invoke>` / `<parameter>`）；API 会将你的 JSON Schema 工具序列化到系统提示中，并把模型输出的 XML 转换为 JSON 形式的 `tool_use` 块。这一底层格式在下方作为*次要*约定记录，同时记录更早的、现已弃用的基于提示的 **legacy XML** 格式（`<tool_name>` / `<parameters>` / `<function_results>`），该格式早于 Messages API 出现，在你完全通过提示来使用工具时仍会浮现。

对于任何解析器/渲染器而言，主要的权威形态是 JSON 内容块格式。XML 仅作为信息参考（在 token 级别重建提示时，它是唯一可见的内容）。

---

## 内容块类型与停止原因

Anthropic 公共 API 中没有 token 级别的工具分隔符。其单位是**内容块**：每个 `message.content` 是一个由类型化块组成的数组。工具调用增加了两种块类型和一种停止原因；流式响应则增加一种增量类型。

| 项目 | 位置 | 形态/含义 |
| --- | --- | --- |
| `text` 块 | 助手与用户 | `{"type":"text","text":"..."}`。纯文本。助手在工具调用之前可能会发出文本。 |
| `tool_use` 块 | 助手 | `{"type":"tool_use","id":"toolu_...","name":"<tool>","input":{...}}`。函数调用。`input` 是一个**嵌套的 JSON 对象**（已经解析过），需符合该工具的 `input_schema`。 |
| `tool_result` 块 | 用户 | `{"type":"tool_result","tool_use_id":"toolu_...","content":<string \| block[]>,"is_error":<bool?>}`。执行结果，作为 `user` 消息回传。 |
| `server_tool_use` 块 | 助手 | `{"type":"server_tool_use","id":"srvtoolu_...","name":"web_search","input":{...}}`。由 Anthropic 执行的服务器工具所产生；你**不**需要为这些返回 `tool_result`。 |
| `web_search_tool_result`（及类似） | 助手 | 服务器工具的输出，由 Anthropic 在助手回合中内联注入。 |
| `thinking` / `redacted_thinking` 块 | 助手 | 扩展思考的推理块；带有一个 `signature`。在思考与工具结合使用时，必须在各轮之间原样保留。 |
| `stop_reason: "tool_use"` | 响应顶层 | 模型调用了一个或多个工具并正在等待结果。驱动代理循环。 |
| `stop_reason: "end_turn"` | 响应顶层 | 自然结束（没有工具调用）；循环退出。 |
| 其他 `stop_reason` | 响应顶层 | `"max_tokens"`、`"stop_sequence"`、`"pause_turn"`（长服务器工具回合，原样重发以继续）、`"refusal"`、`"sensitive"`（输出被安全过滤器标记）、`"model_context_window_exceeded"`（在上下文窗口处截断的输出，按 `max_tokens` 处理）。 |
| `id` 前缀 | — | 消息 `msg_…`；客户端工具调用 `toolu_…`；服务器工具调用 `srvtoolu_…`。 |

流式响应增加了如下 SSE 事件/增量类型（完整列表见 [角色 / 通道 / 回合结构](#角色--通道--回合结构) 和 [工具调用格式](#工具调用格式)）：

| 流式项 | 形态/含义 |
| --- | --- |
| `message_start` | 携带一个 `Message` 骨架，`content` 为空，`stop_reason: null`。 |
| `content_block_start` | 在 `index` 处打开一个块。对于工具调用：`content_block.{type:"tool_use",id,name,input:{}}` —— `input` 初始为一个**空对象**。 |
| `content_block_delta` / `input_json_delta` | `{"type":"input_json_delta","partial_json":"<chunk>"}` —— `tool_use.input` 的**部分 JSON 字符串**片段。 |
| `content_block_delta` / `text_delta` | `{"type":"text_delta","text":"..."}`。 |
| `content_block_delta` / `thinking_delta`、`signature_delta` | 扩展思考的内容/签名。 |
| `content_block_stop` | 关闭 `index` 处的块；此时累计的 `partial_json` 完整，可以安全地 `JSON.parse`。 |
| `message_delta` | 顶层更新；携带最终的 `delta.stop_reason`（例如 `"tool_use"`）和**累计**的 `usage`。 |
| `message_stop` | 流结束。 |
| `ping` / `error` | 心跳保活；`error`（例如 `overloaded_error`）可能出现在流的中间。 |

### 旧版 XML 标签（基于提示，早于 Messages API）

已弃用的基于提示的格式使用这些标签。它们是嵌套元素标签（无属性），不同于现代的属性形式（`<invoke name="…">`）。已对照 Anthropic 归档的 “Legacy tool use” 文档进行了验证（见 [来源](#来源)）。

| 标签 | 角色 | 备注 |
| --- | --- | --- |
| `<tools>` … `</tools>` | 工具声明 | 系统提示中的容器，包裹所有 `<tool_description>` 条目。 |
| `<tool_description>` | 工具声明 | 每个工具一条：包含 `<tool_name>`、`<description>`、`<parameters>`。 |
| `<tool_name>` | 两者 | 函数名（在定义、调用和结果中使用）。 |
| `<parameters>` / `<parameter>` | 定义 | `<parameters>` 包裹若干 `<parameter>` 条目，每条包含 `<name>`、`<type>`、`<description>`。 |
| `<function_calls>` | 模型输出 | 包裹一个或多个 `<invoke>` 块。 |
| `<invoke>` | 模型输出 | 一次函数调用；包含 `<tool_name>` + 一个包含 `<paramName>value</paramName>` 子标签的 `<parameters>` 块。 |
| `<function_results>` | 工具结果（回传） | 包裹 `<result>`（成功）或 `<error>`（失败）。 |
| `<result>` / `<stdout>` | 工具结果 | `<result>` 包含 `<tool_name>` + `<stdout>`；输出文本放在 `<stdout>` 中。 |
| `<error>` | 工具结果 | 当函数抛出错误时替代 `<result>`。 |
| `</function_calls>` | 停止序列 | 作为 `stop_sequence` 传入，使生成在调用后停止。 |
| `<scratchpad>` / `<answer>` | 模型输出 | 在旧版提示中通常用于思维链和最终答案。 |

---

## 角色 / 通道 / 回合结构

Messages API 主要使用两种对话角色 `user` 和 `assistant`，交替出现。没有专门的 `tool`/`function` 角色，标准系统提示是一个单独的顶层 `system` 参数（字符串或文本块数组）——而不是消息角色。（Claude Opus 4.8+ 以及 Fable/Mythos 5 代还接受一个选择加入的会话中间 `system` **消息**角色，由 `mid-conversation-system-2026-04-07` 测试版控制；否则只有 `user`/`assistant` 是有效的。）工具数据承载于普通角色内部：

- `assistant` 消息包含 AI 生成的 `text`、`thinking`，以及 `tool_use`（和 `server_tool_use`）块。
- `user` 消息包含你的 `text`/`image`/`document` 内容以及 `tool_result` 块。

没有命名的“通道”。最接近推理通道的是扩展思考的 `thinking` 内容块（一个一等公民的块，带有加密的 `signature`），它与用户可见的 `text` 块保持分离。当思考与工具一起启用时，来自工具调用回合的 `thinking` 块必须在后续请求中原样回传。

代理循环以 `stop_reason` 为驱动：

1. 发送 `tools` 和用户消息。
2. Claude 以 `stop_reason: "tool_use"` 响应，并附带一个或多个 `tool_use` 块（可选地前面有一个 `text` 块）。
3. 执行每个工具；为每次调用构建一个 `tool_result` 块。
4. 追加助手消息**并**附加一个携带所有 `tool_result` 块的 `user` 消息；重新发送。
5. 当 `stop_reason == "tool_use"` 时重复；在 `end_turn`（或其他终止原因）时退出。

严格的顺序规则（否则会返回 400）：
- `tool_result` 块必须位于 `user` 消息 `content` 数组的**最前面**（任何文本都要放在它们之后）。
- `tool_result` 的 `user` 消息必须**紧跟**助手 `tool_use` 消息——中间不能有其他内容。
- 每个 `tool_use.id` 都必须由下一条消息中的 `tool_result.tool_use_id` 回答。

---

## 工具定义

工具在顶层 `tools` 数组中传入。每个用户定义（客户端）的工具是一个**扁平**对象 —— 没有 `{"type":"function", "function":{…}}` 包装（那是 OpenAI 的）。字段包括：

- `name` —— 匹配 `^[a-zA-Z0-9_-]{1,64}$`。
- `description` —— 详细的纯文本（这是影响工具调用质量的最关键因素）。
- `input_schema` —— 一个 JSON Schema 对象（**不是** `parameters`），描述模型必须产生的输入。
- 可选：`cache_control`（提示缓存断点）、`strict`（结构化输出测试版）、`eager_input_streaming`（细粒度工具流测试版）。

```json
{
  "name": "get_weather",
  "description": "Get the current weather in a given location",
  "input_schema": {
    "type": "object",
    "properties": {
      "location": {
        "type": "string",
        "description": "The city and state, e.g. San Francisco, CA"
      },
      "unit": {
        "type": "string",
        "enum": ["celsius", "fahrenheit"],
        "description": "The unit of temperature, either 'celsius' or 'fahrenheit'"
      }
    },
    "required": ["location"]
  }
}
```

Anthropic 模式的客户端工具（`bash`、`text_editor`、`computer`、`memory`）和服务器工具（`web_search`、`web_fetch`、`code_execution`、`tool_search`）改为携带一个带版本的 `type`，例如 `{"type": "web_search_20250305", "name": "web_search"}`。

### OMP 原生适配器的 Schema 规范化

原生 Anthropic 提供商并不会原样转发 pi 工具的 JSON Schema。在放入 `input_schema` 之前，OMP 保留以下关键字：

- 每个节点上的：`$ref`、`$defs`、`$schema`、`definitions`、`type`、`enum`、`const`、`description`、`title`、`default`，以及 `nullable`；
- 嵌套的 `anyOf` 和 `allOf`（根级组合器不会被保留，且 `oneOf` 在任何深度都不会被保留）；
- 对象上的：`properties`、`required` 和 `additionalProperties`；
- 数组上的：`items`、`prefixItems`，以及仅当值为 `0` 或 `1` 时的 `minItems`；
- 字符串上的：`format`，仅限 `date-time`、`time`、`date`、`duration`、`email`、`hostname`、`uri`、`ipv4`、`ipv6` 或 `uuid`。

其他约束——包括 `pattern`、字符串长度限制、数值范围、`maxItems`、不支持的格式以及不支持的组合器——会被追加到该节点的 `description` 中。它们仍然作为模型可见的指导存在，但不再是机器强制执行的 Schema 关键字。对象节点默认 `additionalProperties: false`；显式的 `true` 或基于 Schema 值的 `additionalProperties` 仍保持开放（空 Schema 规范化为 `true`）。

OMP 仅在满足以下条件时发送 `strict: true`：适用于合格的内置工具（`bash`、`python`、`edit`、`find`），且 `PI_NO_STRICT` 与提供商兼容性/运行时回退都没有禁用严格工具，该工具未主动退出，原始 Schema 避免使用 `oneOf`、`allOf`、`$ref`、`patternProperties` 和 `propertyNames`，并且每个对象都是封闭的。单个请求最多选择 20 个严格工具，并共享 24 个可选属性和 16 个 union 使用的预算：可选属性预算耗尽后，必须使用 union 预算将另一个可选属性转换为 required-and-nullable，否则该工具仍保持非严格。其他工具使用规范化后的非严格 Schema。OMP 仅在模型兼容性数据和有效端点……

`tool_choice` 控制调用方式（四种选项）：
- `{"type":"auto"}` —— 由模型决定（当 `tools` 存在时的默认）。
- `{"type":"any"}` —— 必须调用某个工具。
- `{"type":"tool","name":"get_weather"}` —— 必须调用指定的工具。
- `{"type":"none"}` —— 不调用工具（当没有 `tools` 时的默认）。

使用 `any` 或 `tool` 时，API 会预填助手回合，因此 `tool_use` 块之前不会带有自然语言前置文本。在 `tool_choice` 内添加 `"disable_parallel_tool_use": true` 可将每回合的工具调用限制为一次。（扩展思考仅支持 `auto`/`none`。）

### API 如何将其转化为提示（通往 XML 的桥梁）

当 `tools` 存在时，API 会构建一个如下骨架的工具使用系统提示（已通过 “Define tools” 验证）：

```text
In this environment you have access to a set of tools you can use to answer the user's question.
{{ FORMATTING INSTRUCTIONS }}
String and scalar parameters should be specified as is, while lists and objects should use JSON format. Note that spaces for string values are not stripped. The output is not expected to be valid XML and is parsed with regular expressions.
Here are the functions available in JSONSchema format:
{{ TOOL DEFINITIONS IN JSON SCHEMA }}
{{ USER SYSTEM PROMPT }}
{{ TOOL CONFIGURATION }}
```

`{{ TOOL DEFINITIONS IN JSON SCHEMA }}` 是你的 `tools` 数组以 JSON Schema 形式序列化后的内容。`{{ FORMATTING INSTRUCTIONS }}` 是（未公开的）教导模型使用带 `antml:` 命名空间前缀的 XML 语法的代码块（见 [工具调用格式 → 底层 XML](#底层-xml-带-antml-命名空间的现代属性形式)）。“parsed with regular expressions” 这一说明解释了为什么输出不需要是良构的 XML。

---

## 工具调用格式

你的应用所消费的网络格式是 JSON。单次调用是助手消息中的一个 `tool_use` 内容块，响应顶层带有 `stop_reason: "tool_use"`：

```json
{
  "id": "msg_01Aq9w938a90dw8q",
  "type": "message",
  "role": "assistant",
  "model": "claude-opus-4-8",
  "content": [
    {
      "type": "text",
      "text": "I'll check the current weather in San Francisco for you."
    },
    {
      "type": "tool_use",
      "id": "toolu_01A09q90qw90lq917835lq9",
      "name": "get_weather",
      "input": { "location": "San Francisco, CA", "unit": "celsius" }
    }
  ],
  "stop_reason": "tool_use",
  "stop_sequence": null,
  "usage": { "input_tokens": 472, "output_tokens": 65 }
}
```

供解析器使用的一些关键事实：
- `tool_use.input` 是一个已经解析过的**对象**，而不是 JSON 字符串。
- 前置的 `text` 块是可选的、仅作为信息呈现；不要依赖其措辞。
- 通过 `id` → `tool_use_id` 将调用与结果进行匹配。

### 底层 XML（带 `antml:` 命名空间的现代属性形式）

在 API 转换之前，模型实际上发出的是 XML 块。当前（Claude 3+）的形式是基于属性的：

```text
<function_calls>
<invoke name="get_weather">
<parameter name="location">San Francisco, CA</parameter>
<parameter name="unit">celsius</parameter>
</invoke>
</function_calls>
```

当前的 Claude 模型在这些标签前加上 `antml:` XML 命名空间前缀（例如 `antml:function_calls`、`antml:invoke name="…"`、`antml:parameter name="…"`）。API 会剥离所有这些内容，只暴露 JSON 形式的 `tool_use` 块；集成者应以 JSON 为目标，而不是 XML。

### OMP `anthropic` 方言

OMP 在底层的基于提示的 XML 上操作，而不是 Messages API 内容块。其渲染器始终发出上面无前缀的属性形式，将多次调用包装在一个 `<function_calls>` 块中，并将每个参数渲染为 `<parameter name="…">` 子标签。对于具有 Schema 的工具，已声明的字符串参数以字面文本插入；其他值则进行 JSON 序列化。流式扫描器也接受带 `antml:` 前缀的标签、`<tool_calls>` 作为包装别名，以及在任一包装外的裸 `<invoke>`。

由于该 XML 不带调用 id，扫描器会生成调用 id。它以有状态方式扫描流式文本，在每个参数体到达时发出 `toolArgDelta` 事件，并在 `</invoke>` 之后通过 `toolEnd` 发布强制类型转换后的参数对象。参数值上限为 1,000,000 个 JavaScript 字符串代码单元；超出后会附加一个明确的截断后缀。类 JSON 值会经过修复后进行解析，而 Schema 声明的字符串则保持为字符串。当 `parseThinking: true` 时，`<thinking>`、`<think>` 和 `<scratchpad>`（带前缀或无前缀）会变成思考事件；否则这些标签会保留为可见文本。

`</invoke>` 触发 `toolEnd`，但它并不决定规范化调用的创建。一旦开头的 `<invoke name="…">` 已发出 `toolStart`，EOF 仅重置扫描器局部状态。在正常停止的流上，OMP 会保留该调用，将回合变为 `toolUse`，即使没有 `toolEnd` 也可能会派发它。任何已经累积的 `toolArgDelta` 文本会保留在调用中（不经过关闭时的强制类型转换）；没有累积参数文本的调用会以 `{}` 运行。`length` 停止仍然不可执行。

---

## 多次 / 并行工具调用

并行调用是默认行为。Claude 在**单个助手消息中发出多个 `tool_use` 块**：

```json
{
  "role": "assistant",
  "content": [
    { "type": "text", "text": "Let me check both cities." },
    {
      "type": "tool_use",
      "id": "toolu_01weather_sf",
      "name": "get_weather",
      "input": { "location": "San Francisco, CA" }
    },
    {
      "type": "tool_use",
      "id": "toolu_02weather_nyc",
      "name": "get_weather",
      "input": { "location": "New York, NY" }
    }
  ]
}
```

你在**一个** `user` 消息中返回**所有**结果，每个调用对应一个 `tool_result`，结果放在最前面：

```json
{
  "role": "user",
  "content": [
    {
      "type": "tool_result",
      "tool_use_id": "toolu_01weather_sf",
      "content": "San Francisco: 68F, partly cloudy"
    },
    {
      "type": "tool_result",
      "tool_use_id": "toolu_02weather_nyc",
      "content": "New York: 45F, clear skies"
    }
  ]
}
```

一轮中的调用是**无序的**，可以并发执行。如果两个批处理调用实际上相互依赖，请在带有 `"is_error": true` 的 `tool_result` 中返回相应的自然错误；Claude 会在后续回合重新发出有依赖关系的调用。（在旧版 XML 格式中，并行通过一个 `<function_calls>` 中的多个 `<invoke>` 块实现。）

---

## 工具结果格式

结果是 `user` 消息中的一个 `tool_result` 块：

- `tool_use_id`（必需）—— 所回答的 `tool_use` 的 `id`。
- `content`（可选）—— 一个字符串，**或者**一个由 `text`/`image`/`document` 块组成的数组。空结果可省略。
- `is_error`（可选）—— `true` 表示执行失败；请在 `content` 中放入有用的消息。

```json
{
  "role": "user",
  "content": [
    {
      "type": "tool_result",
      "tool_use_id": "toolu_01A09q90qw90lq917835lq9",
      "content": "15 degrees"
    }
  ]
}
```

错误结果：

```json
{
  "role": "user",
  "content": [
    {
      "type": "tool_result",
      "tool_use_id": "toolu_01A09q90qw90lq917835lq9",
      "content": "ConnectionError: the weather service API is not available (HTTP 500)",
      "is_error": true
    }
  ]
}
```

富结果（文本 + 图像块）：

```json
{
  "role": "user",
  "content": [
    {
      "type": "tool_result",
      "tool_use_id": "toolu_01A09q90qw90lq917835lq9",
      "content": [
        { "type": "text", "text": "15 degrees" },
        {
          "type": "image",
          "source": { "type": "base64", "media_type": "image/jpeg", "data": "/9j/4AAQSkZJRg..." }
        }
      ]
    }
  ]
}
```

服务器工具**不需要**你返回 `tool_result` —— Anthropic 会执行它们并将结果内联注入到助手回合中。（旧版 XML 将结果作为 `<function_results><result><tool_name>…</tool_name><stdout>…</stdout></result></function_results>` 回传，失败时则为 `<error>…</error>`。）

OMP 基于提示的方言与 Anthropic 的服务器工具行为不同。它将客户端结果渲染为：

```text
<function_results>
<result>
<tool_name>get_weather</tool_name>
<stdout>15 degrees</stdout>
</result>
<error>
<tool_name>other_tool</tool_name>
<stderr>execution failed</stderr>
</error>
</function_results>
```

该 XML 中没有结果 id，因此按调用顺序关联结果。OMP 在成功和错误条目中都包含工具名称，并且不在其他位置编码 `isError`。

---

## 端到端示例

一个完整的多回合天气交流。所有 JSON 都是有效的。

**请求 1 —— system + tools + 用户问题：**

```json
{
  "model": "claude-opus-4-8",
  "max_tokens": 1024,
  "system": "You are a helpful weather assistant. Use the provided tools to answer.",
  "tools": [
    {
      "name": "get_weather",
      "description": "Get the current weather in a given location",
      "input_schema": {
        "type": "object",
        "properties": {
          "location": { "type": "string", "description": "The city and state, e.g. San Francisco, CA" },
          "unit": { "type": "string", "enum": ["celsius", "fahrenheit"], "description": "Unit for the temperature" }
        },
        "required": ["location"]
      }
    }
  ],
  "messages": [
    { "role": "user", "content": "What's the weather in San Francisco?" }
  ]
}
```

**响应 1 —— 助手请求工具（`stop_reason: "tool_use"`）：**

```json
{
  "id": "msg_01Aq9w938a90dw8q",
  "type": "message",
  "role": "assistant",
  "model": "claude-opus-4-8",
  "content": [
    { "type": "text", "text": "I'll check the current weather in San Francisco for you." },
    {
      "type": "tool_use",
      "id": "toolu_01A09q90qw90lq917835lq9",
      "name": "get_weather",
      "input": { "location": "San Francisco, CA", "unit": "celsius" }
    }
  ],
  "stop_reason": "tool_use",
  "stop_sequence": null,
  "usage": { "input_tokens": 472, "output_tokens": 65 }
}
```

**请求 2 —— 重放历史，追加助手回合和 `tool_result`：**

```json
{
  "model": "claude-opus-4-8",
  "max_tokens": 1024,
  "system": "You are a helpful weather assistant. Use the provided tools to answer.",
  "tools": [
    {
      "name": "get_weather",
      "description": "Get the current weather in a given location",
      "input_schema": {
        "type": "object",
        "properties": {
          "location": { "type": "string", "description": "The city and state, e.g. San Francisco, CA" },
          "unit": { "type": "string", "enum": ["celsius", "fahrenheit"], "description": "Unit for the temperature" }
        },
        "required": ["location"]
      }
    }
  ],
  "messages": [
    { "role": "user", "content": "What's the weather in San Francisco?" },
    {
      "role": "assistant",
      "content": [
        { "type": "text", "text": "I'll check the current weather in San Francisco for you." },
        {
          "type": "tool_use",
          "id": "toolu_01A09q90qw90lq917835lq9",
          "name": "get_weather",
          "input": { "location": "San Francisco, CA", "unit": "celsius" }
        }
      ]
    },
    {
      "role": "user",
      "content": [
        {
          "type": "tool_result",
          "tool_use_id": "toolu_01A09q90qw90lq917835lq9",
          "content": "15 degrees Celsius, partly cloudy"
        }
      ]
    }
  ]
}
```

**响应 2 —— 助手的最终答案（`stop_reason: "end_turn"`）：**

```json
{
  "id": "msg_01EeFG3hijk2lmno4PqrSt",
  "type": "message",
  "role": "assistant",
  "model": "claude-opus-4-8",
  "content": [
    { "type": "text", "text": "It's currently 15 degrees Celsius and partly cloudy in San Francisco." }
  ],
  "stop_reason": "end_turn",
  "stop_sequence": null,
  "usage": { "input_tokens": 530, "output_tokens": 18 }
}
```

### 工具调用的流式（SSE）形态

同一个工具调用的流式形式。注意 `tool_use` 以空的 `input` 打开，参数以 `input_json_delta.partial_json` 片段的形式到达，最终的 `stop_reason` 在 `message_delta` 中出现。该块原样复制自 Anthropic 的流式文档：

```text
event: message_start
data: {"type":"message_start","message":{"id":"msg_014p7gG3wDgGV9EUtLvnow3U","type":"message","role":"assistant","model":"claude-opus-4-8","stop_sequence":null,"usage":{"input_tokens":472,"output_tokens":2},"content":[],"stop_reason":null}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

event: ping
data: {"type": "ping"}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Okay"}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" let"}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"'s"}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" check"}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: content_block_start
data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_01T1x1fJ34qAmk2tNTrN7Up6","name":"get_weather","input":{}}}

event: content_block_delta
data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"location\":"}}

event: content_block_delta
data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":" \"San"}}

event: content_block_delta
data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":" Francisc"}}

event: content_block_delta
data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"o,"}}

event: content_block_delta
data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":" CA\"}"}}

event: content_block_stop
data: {"type":"content_block_stop","index":1}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":89}}

event: message_stop
data: {"type":"message_stop"}
```

重组：对于给定的 `index`，将所有 `partial_json` 串接起来（`"" + "{\"location\":" + " \"San" + " Francisc" + "o," + " CA\"}"` → `{"location": "San Francisco, CA"}`），然后在该块的 `content_block_stop` 处执行 `JSON.parse`。工具使用还支持细粒度流式（每个工具的 `eager_input_streaming`）以获得更细的 `partial_json` 分块。

---

## 与 OpenAI 兼容 API 的映射

Anthropic 将工具集成进 `user`/`assistant` 消息结构，而不是使用 OpenAI 单独的 `tool` 角色和 `function` 包装。逐字段对比：

| 概念 | Anthropic Messages API | OpenAI Chat Completions |
| --- | --- | --- |
| 工具定义包装 | `tools[]` 中的扁平 `{"name","description","input_schema"}` | `tools[]` 中的 `{"type":"function","function":{"name","description","parameters"}}` |
| 工具 Schema 键 | `input_schema`（JSON Schema） | `parameters`（JSON Schema） |
| “必须调用工具” | `tool_choice:{"type":"any"}` / `{"type":"tool","name":…}` | `tool_choice:"required"` / `{"type":"function","function":{"name":…}}` |
| 禁用并行调用 | `tool_choice:{…,"disable_parallel_tool_use":true}` | `parallel_tool_calls:false`（顶层） |
| 助手调用容器 | `content[]` 中的 `tool_use` **内容块** | 助手 `message` 上的 `tool_calls[]` |
| 调用 id | `tool_use.id` = `toolu_…` | `tool_calls[].id` = `call_…` |
| 函数名 | `tool_use.name` | `tool_calls[].function.name` |
| 函数参数 | `tool_use.input` = **嵌套的 JSON 对象**（已解析） | `tool_calls[].function.arguments` = **JSON 字符串**（必须 `JSON.parse`） |
| “已调用工具”信号 | `stop_reason:"tool_use"` | `finish_reason:"tool_calls"` |
| 结果消息角色 | 包含 `tool_result` 块的 `user` 消息 | 专用的 `{"role":"tool",…}` 消息 |
| 结果 ↔ 调用关联 | `tool_result.tool_use_id` | `tool` 消息的 `tool_call_id` |
| 结果负载 | `tool_result.content` = 字符串**或**块数组（text/image/document） | `tool` 消息的 `content` = 字符串 |
| 错误结果 | 带有 `is_error:true` 的 `tool_result` | 没有专用标志；编码在 `content` 中 |
| 系统提示 | 顶层 `system` 参数（没有 `system` 角色） | `{"role":"system",…}` 消息 |
| 流式参数 | `input_json_delta.partial_json` 片段 | `tool_calls[].function.arguments` 字符串增量 |

转换时的注意事项：
- **对象 vs 字符串：** 要输出 OpenAI 形式，使用 `JSON.stringify(tool_use.input)`；要将 OpenAI 形式消费到 Anthropic 侧，使用 `JSON.parse(arguments)`。
- **角色重塑：** 将 N 条 OpenAI `tool` 消息合并为一条包含 N 个 `tool_result` 块的 Anthropic `user` 消息（将它们放在任何文本之前），反之亦然。
- Anthropic 自定义工具上**没有** `type:"function"` 包装；在转换时相应地添加或移除它。
- id 前缀不同（`toolu_` 与 `call_`）；永远不要假设一种格式的 id 在另一种格式中有效。

---

## 解析注意事项与陷阱

- **`input` 是对象而不是字符串。** 与 OpenAI 的 `arguments` 不同，请勿对非流式响应中的 `tool_use.input` 调用 `JSON.parse` —— 它已经是对象。只有*流式*的 `partial_json` 片段是字符串。
- **流式工具参数需要重组。** `tool_use` 的 `content_block_start` 总是具有 `input: {}`。按 `index` 缓冲 `partial_json`，仅在 `content_block_stop` 处进行解析；流中间的片段本身不是有效的 JSON（例如 `{"location":`）。当前模型一次发出一个完整的键/值，因此会出现突发和间隔。
- **`stop_reason` 的位置。** 在流式响应中，`message_start` 中 `stop_reason` 为 `null`，最终值（`"tool_use"`/`"end_turn"`）在 `message_delta` 中到达，而不是 `message_stop`。`message_delta` 中的 `usage` 是**累计**的。
- **顺序是强制性的。** `tool_result` 块必须位于其 `user` 消息的最前面，并且必须紧跟在助手 `tool_use` 消息之后；每个 `tool_use.id` 都需要一个匹配的 `tool_result.tool_use_id`，否则会收到 HTTP 400（"tool_use ids were found without tool_result blocks immediately after"）。
- **`tool_choice:any`/`tool` 会抑制前言。** API 会预填助手回合，因此 `tool_use` 之前不会出现 `text` 块 —— 不要编写期望解释性文本的解析器。
- **并行结果在同一条消息中。** 将并行的 `tool_result` 拆分为多条 `user` 消息会破坏契约；请将它们一起发送。
- **将结果内容视为不可信。** 工具结果可能携带间接的提示注入；请将它们保留在 `tool_result` 块内，绝不要提升到 `system`/`user` 文本中。
- **服务器工具不同。** `server_tool_use` / `web_search_tool_result` 块由 Anthropic 生成和消费；永远不要为它们合成 `tool_result`。`stop_reason:"pause_turn"` 表示原样重发响应以让一个长服务器工具回合继续。
- **扩展思考 + 工具。** 在各回合之间原样保留 `thinking`/`redacted_thinking` 块（以及它们的 `signature`）；当思考开启时，强制性的 `tool_choice`（`any`/`tool`）会被拒绝。
- **输出不是有效的 XML。** 底层模型输出由 Anthropic 使用正则表达式解析，而不是 XML 解析器（"The output is not expected to be valid XML"）。如果你在 token 级别重建提示，不要假设其良构性；请依赖 API 返回的 JSON。
- **旧版与现代 XML 是不同的标签集。** 旧版：`<invoke>` + 子标签 `<tool_name>` + 包含逐参数子标签的 `<parameters>`；结果位于 `<function_results>/<result>/<stdout>`。现代：`<invoke name="…">` + `<parameter name="…">`。混淆它们将导致解析错误。旧版格式还要求将 `</function_calls>` 作为 `stop_sequence` 传入，并且未针对 Claude 3+ 进行优化。

### 旧版 XML 格式（次要，基于提示 —— 已完全验证，现已弃用）

在 Messages API 出现之前，工具的整个定义和调用都在提示中完成。Anthropic 归档的 “Legacy tool use” 文档逐字记录了它。

工具定义（在系统提示中的一个 `<tools>` 块内）：

```text
<tool_description>
<tool_name>get_weather</tool_name>
<description>
Retrieves the current weather for a specified location.
Returns a dictionary with two fields:
- temperature: float, the current temperature in Fahrenheit
- conditions: string, a brief description of the current weather conditions
Raises ValueError if the provided location cannot be found.
</description>
<parameters>
<parameter>
<name>location</name>
<type>string</type>
<description>The city and state, e.g. San Francisco, CA</description>
</parameter>
</parameters>
</tool_description>
```

模型发出的调用（并行调用使用多个 `<invoke>`；将 `</function_calls>` 作为 `stop_sequence` 传入）：

```text
<function_calls>
<invoke>
<tool_name>get_weather</tool_name>
<parameters>
<location>San Francisco, CA</location>
</parameters>
</invoke>
</function_calls>
```

结果在下一个用户回合中回传：

```text
<function_results>
<result>
<tool_name>get_weather</tool_name>
<stdout>
59 degrees Fahrenheit, partly cloudy
</stdout>
</result>
</function_results>
```

错误结果：

```text
<function_results>
<error>
error message goes here
</error>
</function_results>
```

旧版的系统提示前言（来自归档文档的原文）如下：

```text
In this environment you have access to a set of tools you can use to answer the user's question.
You may call them like this:
<function_calls>
<invoke>
<tool_name>$TOOL_NAME</tool_name>
<parameters>
<$PARAMETER_NAME>$PARAMETER_VALUE</$PARAMETER_NAME>
...
</parameters>
</invoke>
</function_calls>

Here are the tools available:
<tools>
...one <tool_description> per tool...
</tools>
```

旧版注意事项：没有内置工具（一切都通过提示定义）；Anthropic 建议 ≤3–5 个工具；模型按惯例将推理包装在 `<scratchpad>` 中，将最终输出包装在 `<answer>` 中。此格式“已过时”并且“未针对 Claude 3 进行优化”——请对任何当前的工作使用 JSON Messages API。

---

## 来源

- 工具使用概述 — https://docs.claude.com/en/docs/agents-and-tools/tool-use/overview
- 工具使用的工作原理 — https://docs.claude.com/en/docs/agents-and-tools/tool-use/how-tool-use-works
- 工具定义（工具 Schema、`input_schema`、`tool_choice`、构造的系统提示） — https://docs.claude.com/en/docs/agents-and-tools/tool-use/define-tools
- 处理工具调用（`tool_use`/`tool_result`、`is_error`、顺序规则） — https://docs.claude.com/en/docs/agents-and-tools/tool-use/handle-tool-calls
- 并行工具使用 — https://docs.claude.com/en/docs/agents-and-tools/tool-use/parallel-tool-use
- 流式消息（SSE 事件、`input_json_delta`、逐字的工具使用流） — https://docs.claude.com/en/docs/build-with-claude/streaming
- Messages API 参考（`stop_reason` 枚举、响应形态、`tools`） — https://docs.claude.com/en/api/messages
- 旧版工具使用（已归档；逐字的 XML 标签和提示） — https://web.archive.org/web/20240528231249/https://docs.anthropic.com/en/docs/legacy-tool-use ；还有实时本地化副本，例如 https://docs.anthropic.com/de/docs/legacy-tool-use （英文路径现在会重定向到工具使用概述）
