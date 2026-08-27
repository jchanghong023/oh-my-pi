# Gemma 4 工具调用格式（由 token 分隔的 `call:NAME{…}`）

Google **Gemma 4** 开源权重系列（`google/gemma-4-*-it`）的工具调用约定。它彻底摆脱了 Gemma 3 和托管版 Gemini 使用的、由提示工程构造的 Pythonic `tool_code` 形式（参见 `gemini.md`）：Gemma 4 引入了**专用的特殊 token**和一套紧凑的**由 token 分隔的大括号语法**。调用和响应各自拥有一对标记，每个字符串值由 `<|"|>` token 包裹，而不是使用 ASCII 引号。模型发出一次调用，形如 `<|tool_call>call:NAME{key:value,…}<tool_call|>`；开发者解析它、运行工具，然后追加 `<|tool_response>response:NAME{output:…}<tool_response|>`。

已对照 OMP 的 `gemma` 方言（`packages/ai/src/dialect/gemma.ts`）验证：用于解析这些块的流式扫描器，以及生成这些块的 `renderAssistantToolCalls` / `renderToolResults` / `renderTranscript` 渲染器。下面的示例流与该实现一致；示例所用的模型 id 为 `google/gemma-4-E2B-it`。

## 特殊 token

Gemma 4 将每个结构元素包裹在一对 token 中。注意**管道符的不对称位置**——开标记的管道符在左侧（`<|x>`），对应的闭标记的管道符在右侧（`<x|>`）：

| 开标记 | 闭标记 | 用途 |
|---|---|---|
| `<bos>` | — | 序列开始 |
| `<\|turn>` | `<turn\|>` | 一段对话轮次；角色名是正文第一行 |
| `<\|tool_call>` | `<tool_call\|>` | 模型发出的一次工具**调用** |
| `<\|tool_response>` | `<tool_response\|>` | 回填给模型的一次工具**结果** |
| `<\|channel>` | `<channel\|>` | 推理通道；`<\|channel>thought` 开启模型的思维链（由 `<channel\|>` 关闭），位于可见回复之前 |
| `<\|"\|>` | `<\|"\|>` | 字符串字面量分隔符（两端使用同一 token） |
| `<eos>` | — | 序列结束 |

由于字符串分隔符是一个 token（`<|"|>`），值中可以包含原始的 ASCII 引号和逗号而无需转义——只有字面的 `<|"|>` token 序列不能出现在字符串内部。

推理变体会在专用通道中输出推理内容——位于模型轮次起始处的 `<|channel>thought\n…<channel|>`，位于任何回复文本或工具调用之前。`gemma` 扫描器将该通道路由到思考事件（使其不进入可见回复），并继续解析其后出现的工具调用；`renderThinking` 会将一段思考回转为同样的 `<|channel>thought\n…<channel|>` 块。当 `parseThinking: false` 时，该通道会保留在可见文本中。

## 角色 / 轮次结构

每段轮次为 `<|turn>{role}\n{body}<turn|>`，轮次之间不使用任何分隔符直接拼接。角色包括 `system`、`user`、`model`（`developer` 消息会渲染为 `system`）。在带 generation prompt 的情况下，流转在 `<|turn>model\n` 处结束，由模型继续生成。工具调用以及紧跟其后的工具响应都位于同一个 `model` 轮次内——响应块紧跟在调用块之后，出现在重新渲染的历史中。

## 工具定义

自有的 `gemma` 提示**确实**携带每个工具的标准化线协议 schema。`renderInbandToolPrompt` 在 `<tools></tools>` 内每行序列化一个紧凑的 OpenAI 风格对象，随后追加 Gemma 格式指南：

```text
<tools>
{"type":"function","function":{"name":"get_current_temperature","description":"Gets the current temperature for a given location.","parameters":{"type":"object","properties":{"location":{"type":"string","description":"The city name, e.g. San Francisco"}},"required":["location"]}}}
</tools>
```

`renderToolInventory` 是一个独立的、用于系统提示和 `/dump` 的详尽清单。它输出一个 `## functions` 形式的 TypeScript `namespace functions { … }` 块。工具描述以 `//` 注释的形式出现在 `type NAME = (_: PARAMS);` 声明之上；已配置的示例以 JSDoc 风格的 `// @example` 条目出现，其中的调用使用 Python 关键字参数语法。它不输出每个工具各自的 Markdown 段落，也不输出原生 Gemma 的 `<|tool_call>` 示例。

## 工具调用格式

模型在每个 `<|tool_call>…<tool_call|>` 块中发出一次调用。块体为 `call:NAME{ARGS}`，其中 `ARGS` 是由逗号分隔的 `key:value` 对列表：

```text
<|tool_call>call:get_current_temperature{location:<|"|>London<|"|>}<tool_call|>
```

`{…}` 内部的值语法：

| 值类型 | 编码方式 | 示例 |
|---|---|---|
| 字符串 | `<\|"\|>text<\|"\|>` | `location:<\|"\|>London<\|"\|>` |
| 整数 / 浮点数 | 裸字面量 | `count:42` |
| 布尔值 | 裸字面量 | `flag:true` |
| 空值 | 裸字面量 | `unit:null` |
| 列表 | `[v,v,…]` | `tags:[<\|"\|>a<\|"\|>,<\|"\|>b<\|"\|>]` |
| 嵌套对象 | `{k:v,…}` | `config:{theme:<\|"\|>dark<\|"\|>}` |

OMP 解析器是流式的 `GemmaInbandScanner`（`packages/ai/src/dialect/gemma.ts`），而非扁平的正则表达式。对于每个 `<|tool_call>` 块，它：

1. 找到匹配的 `<tool_call|>` 闭合标记，跳过其中的 `<|"|>…<|"|>` 字符串区间，因此出现在字符串值内的 `<tool_call|>` 序列不会提前结束该块；
2. 匹配 `call:NAME{` 头部，然后取走大括号内直到按深度匹配的 `}` 的内容；
3. 在顶层逗号处将该块体切分为 `key:value` 对——跳过括号深度（`[]`、`{}`）和 `<|"|>` 字符串区间——并按上述语法解码每个值，因此嵌套的列表和对象也能正确解析（单层正则做不到这一点）。
调用只有在完整的闭合标记到达后才会被发出；不存在部分参数事件。如果流转在工具块尚未终止时被刷新，OMP 会丢弃这个不完整的块。一个语法上已闭合、但缺少最末参数大括号的块，仍会基于已有内容进行解析。

## 多次 / 并行工具调用

并行调用就是连续的多个 `<|tool_call>…<tool_call|>` 块（每个块一次调用），按顺序返回。应用程序按相同顺序为每次调用返回一个 `<|tool_response>`。

## 工具结果格式

每个结果形如 `<|tool_response>response:NAME{output:VALUE}<tool_response|>`。`renderToolResults` 总是将结果包裹在单个 `output` 键下，并先对工具的文本进行 `JSON.parse`——因此 JSON 输出会成为大括号语法中的嵌套对象/数组，而纯字符串则被包裹在 `<|"|>…<|"|>` 中：

```text
<|tool_response>response:get_current_weather{output:{temperature:15,weather:<|"|>sunny<|"|>}}<tool_response|>
<|tool_response>response:read{output:<|"|>FILE<|"|>}<tool_response|>
```

Gemma 线协议中没有专用的 success/error 字段。OMP 将 `isError` 结果渲染成与成功结果相同的 `response:NAME{output:…}` 形式，因此任何失败标识都必须出现在结果文本自身之中。

## 端到端示例

针对一次天气查询的 `renderTranscript` 输出。系统轮次同样携带 `<tools>` 目录和格式指南（参见 *工具定义*，此处已缩写）；模型的调用与其工具响应合并到同一个 `model` 轮次中（响应紧跟在调用之后），最终答复则是下一个 `model` 轮次。各轮次之间无任何分隔符直接相连——只有每个角色之后的 `\n` 是字面存在的：

```text
<bos><|turn>system
You are a helpful assistant.<turn|><|turn>user
Hey, what's the weather in Tokyo right now?<turn|><|turn>model
<|tool_call>call:get_current_weather{location:<|"|>Tokyo, JP<|"|>}<tool_call|><|tool_response>response:get_current_weather{output:{temperature:15,weather:<|"|>sunny<|"|>}}<tool_response|><turn|><|turn>model
The current weather in Tokyo is 15 degrees Celsius and sunny.<turn|>
```

## 解析注意事项与陷阱

- **字符串分隔符是 token，而不是引号。** 在 `<|"|>…<|"|>` 内部，字节 `"` 和 `,` 都是字面数据——示例 `<|"|>The city and state, e.g. "San Francisco, CA"…<|"|>` 同时包含这两者。只能在 `<|"|>…<|"|>` 区间**之外**按 `,`/`}` 切分参数。
- **管道符不对称。** 闭标记是 `<tool_call|>`，而不是 `</tool_call>` 或 `<|tool_call>`。如果匹配错了管道符的位置，该块永远无法闭合。
- **每个块一次调用。** 与 JSON 的 `tool_calls[]` 数组不同，并行是“更多块”，而不是“同一块中的更多条目”。
- **裸标量。** 未被 `<|"|>` 包裹的值：`true`/`false` → 布尔值，`null`/`none` → 空值，数字 → 数值，否则为裸字符串（例如未加引号的枚举或类型名，如 `STRING`）。
- **工具调用 id 是合成的。** 该格式不携带 id；在收到完整闭合的块后，OMP 解析它，并发出相邻的 `toolStart`/`toolEnd` 事件，其中使用新生成的 id。渲染后的响应通过相邻消息的顺序/名称进行关联。
- **不是 Gemma 3 / 托管版 Gemini。** 那些使用 `gemini.md` 中的 Pythonic `tool_code` / `default_api` 形式。Gemma 4 已用本 token 语法取代了它，二者不可互换。
- **Gemma 3 自动选择注意事项。** OMP 当前的家族亲和映射会把 Gemma 3 和 Gemma 4 的模型 ID 都映射到 `gemma`。如果某个 Gemma 3 模型被标记为 `supportsTools: false`，`tools.format=auto` 因此会选择本 Gemma 4 语法，尽管 Gemma 3 实际需要 `gemini.md` 中的 Pythonic 约定；此时请显式设置 `tools.format=gemini`。

## 来源

- OMP `gemma` 方言实现：`packages/ai/src/dialect/gemma.ts`（扫描器 + 渲染器），`packages/ai/src/dialect/catalog.ts` 与 `packages/ai/src/dialect/prompt-template.md`（工具目录），`packages/ai/src/dialect/gemma.md`（格式指南）。
- Gemma 4 函数调用：https://ai.google.dev/gemma/docs/capabilities/text/function-calling-gemma4
- Gemma 4 提示格式：https://ai.google.dev/gemma/docs/core/prompt-formatting-gemma4