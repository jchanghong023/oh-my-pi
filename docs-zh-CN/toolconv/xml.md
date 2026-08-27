# 通用 XML 自有工具调用格式（`<invoke>` / `<tool_response>`）

OMP 的 `xml` 方言是一种通用的、由提示词驱动的带内协议。模型在助手文本中直接为每个工具调用写入一个 `<invoke>` 元素；OMP 解析这些调用，并在下一个用户轮次中按顺序为每个结果返回一个 `<tool_response>` 块。双方都不携带工具调用 id，结果块也不携带工具名称，因此顺序就是关联机制。

本参考描述了由 `packages/ai/src/dialect/xml.ts` 实现的转换器。普通的 `tools.format: xml` 路径使用共享的 Anthropic 风格 invoke 扫描器。导出的扫描器 API 也可以选择 DeepSeek 的用竖线包裹的 DSML 标签集；该仅扫描器选项将在下文单独说明。

## 选择与请求转换

可在 `~/.omp/agent/config.yml`、项目配置或覆盖层中选择该方言：

```yaml
tools:
  format: xml
```

`tools.format: xml` 会在本次会话中强制使用通用 XML 自有方言。`auto` **不会**将通用 XML 选作其未知系列的回退：当某个模型具有 `supportsTools: false` 时，解析器会选用已知的模型系列方言，或者在没有特定亲和性时选用 GLM。需要使用此语法时请显式指定 `xml`。参见 [`tools.format`](../settings.md#tools-and-approvals)。

当选中后，OMP 会从 provider 请求中移除原生结构化工具，将带内工具目录和 XML 指南追加到系统提示词中，将先前的结构化调用/结果转换为文本，并将助手文本扫描回结构化工具调用事件。

## 工具定义与提示词注入

OMP 注入共享的 `# Tools` 提示词。可用函数在 `<tools></tools>` 中以每个工具一行、一个紧凑的 OpenAI 风格函数对象的形式呈现，使用各工具的规范化线路 schema：

```text
<tools>
{"type":"function","function":{"name":"read","description":"Read a file","parameters":{"type":"object","properties":{"path":{"type":"string"},"count":{"type":"number"}},"required":["path"]}}}
</tools>
```

来自 `packages/ai/src/dialect/xml.md` 的 XML 专用指南紧随目录之后。它要求使用列出的函数名称、字面量字符串主体、非字符串值的 JSON、有序的结果，以及在模型停止之前完成的调用。调用是文本，绝不是原生 `tool_calls` JSON。

## 规范调用格式

一次调用对应一个 invoke：

```text
<invoke name="read"><parameter name="path">src/main.ts</parameter><parameter name="count">40</parameter></invoke>
```

| 元素 | 含义 |
| --- | --- |
| `<invoke name="TOOL">…</invoke>` | 一次工具调用。提示词契约要求使用已列出的工具名称。 |
| `<parameter name="ARG">VALUE</parameter>` | 一个具名参数。 |
| `<tool_calls>…</tool_calls>` | 模型可选择发出的可选包装器，指南/扫描器接受该包装器；OMP 的渲染器不会添加它。 |

`renderAssistantToolCalls` 输出以换行符分隔的连续 invoke，没有外层包装器。默认扫描器还接受 `<function_calls>` 作为包装器别名、`antml:` 前缀的 Anthropic 标签变体，以及裸的 invoke。其接受的输入刻意比规范渲染器的输出更宽。

当 OMP 渲染属性时，工具和参数名称会进行 XML 转义。参数主体不会进行 XML 转义，因为该格式是按分隔符匹配的，而不是由 XML DOM 解析的。应当写 `a & b < c`，而不是 `a &amp; b &lt; c`；只有字面量 `</parameter>` 才会与主体的闭合分隔符冲突。

## 参数编码与强制转换

渲染器使用所提供的工具 schema 来判定一个值是否为字面量字符串：

| 声明/值类型 | 渲染主体 | 默认扫描器结果 |
| --- | --- | --- |
| 运行时值为字符串的 schema 声明的字符串 | 原样保留空白 | 原样保留的字符串 |
| 数字、布尔值、`null`、数组或对象 | JSON | 解析后的 JSON 值 |
| 未被识别为字符串参数的运行时字符串 | JSON 字符串，包括引号 | 解析后的字符串 |

示例：

```text
<invoke name="write"><parameter name="path">notes/a & b.txt</parameter><parameter name="options">{"append":false,"tags":["draft","xml"]}</parameter></invoke>
```

默认扫描器在每个参数上接受 `string` 覆盖：

- `string="true"`（或除 `false`、`0`、`no` 之外的任何值）强制将原始主体保留为字符串。
- `string="false"`、`string="0"` 或 `string="no"` 即使 schema 声明为字符串，也强制进行 JSON 解析。

非字符串主体在解析前会进行修剪，并交由 OMP 支持修复的 JSON 解析器处理。若修复失败，则将原始主体作为字符串保留。空主体保留为空字符串。没有可用名称的参数会被丢弃。

## 多次调用与并行调用

OMP 将一批调用渲染为连续的 invoke：

```text
<invoke name="read"><parameter name="path">src/a.ts</parameter></invoke>
<invoke name="read"><parameter name="path">src/b.ts</parameter></invoke>
```

模型可以选择将整批调用包装起来：

```text
<tool_calls>
<invoke name="read"><parameter name="path">src/a.ts</parameter></invoke>
<invoke name="read"><parameter name="path">src/b.ts</parameter></invoke>
</tool_calls>
```

扫描器为每个 invoke 生成一个内部调用 id；XML 中没有 id。OMP 可以将这些调用作为一批调度。结果必须保持调用顺序，因为 `<tool_response>` 既没有 id 也没有名称。

## 工具结果格式

OMP 将每个结果返回到各自的块中：

```text
<tool_response>
file contents
</tool_response>
<tool_response>
ENOENT: file not found
</tool_response>
```

连续的结果块以换行符分隔，并放在一条合成的 `user` 消息中。结果文本按原样插入。工具结果中的图像块在渲染文本之后保留在同一消息中。

通用 XML 协议**没有成功/错误标记**。`renderToolResults` 故意将 `isError: true` 渲染成与成功相同的 `<tool_response>` 形态；错误必须从其文本中可理解。模型自身绝不能生成 `<tool_response>`。

## 思考与可见文本

OMP 将保留的思考渲染为：

```text
<thinking>
reasoning text
</thinking>
```

对于正常的自有工具流，`parseThinking` 是启用的。在默认的 Anthropic 标签集下，`<thinking>`、`<think>` 和 `<scratchpad>`（包括受支持的前缀形式）会变成独立的思考事件，并且不会出现在可见文本中。将 `parseThinking` 保留为 false 的直接扫描器使用者会将这些标签视为文本。未闭合的思考块在刷新时按逻辑闭合，并保留其内容。

可见散文可以出现在裸 invoke 之前或之间。在已识别的 `<tool_calls>` 或 `<function_calls>` 包装器内部，非调用文本会被丢弃。

## 扫描器标签集

`XmlInbandScanner` 根据 `InbandScannerOptions.xmlTagset` 委托给两个扫描器之一：

| `xmlTagset` | 扫描器 | 接受的调用语法 | 参数规则 |
| --- | --- | --- | --- |
| 省略或 `anthropic` | `AnthropicInbandScanner` | 纯/`antml:` `<invoke>/<parameter>`，可选地放在 `<tool_calls>` 或 `<function_calls>` 内部 | 工具 schema 决定字符串；`string` 属性可覆盖 |
| `dsml` | `DeepSeekInbandScanner` | 用竖线包裹的 DSML 信封和 invoke（以及该扫描器的 DeepSeek token 语法） | 参数默认为字符串；只有 `string="false"` 才会请求 JSON 强制转换 |

直接 API 使用者可以请求 DSML 解析：

```ts
import { createInbandScanner } from "@oh-my-pi/pi-ai/dialect";

const scanner = createInbandScanner("xml", {
  xmlTagset: "dsml",
  parseThinking: true,
});
```

DSML 接受全角竖线标签：

```text
<｜DSML｜tool_calls>
<｜DSML｜invoke name="read">
<｜DSML｜parameter name="path" string="true">src/a.ts</｜DSML｜parameter>
<｜DSML｜parameter name="count" string="false">2</｜DSML｜parameter>
</｜DSML｜invoke>
</｜DSML｜tool_calls>
```

它也接受 ASCII 竖线等效形式，如 `<|DSML|tool_calls>`。在 DSML 模式下，`string="false"` 解析经过修复的 JSON；无效的 JSON 会回退为原始字符串。DSML 思考使用 `<think>…</think>`，除非 `parseThinking: false`，否则默认解析。

`xmlTagset` **仅影响扫描器选择**。`xml` 定义的调用、结果、思考和转录渲染器始终输出上文描述的通用纯 XML 形式。正常的 `tools.format: xml` 自有流路径不传递 `xmlTagset`，因此它使用 Anthropic 标签集。OMP 目前将 DSML 选择器用于泄漏的 DSML 输出的流标记修复，而不是用于更改 `tools.format: xml` 渲染器。

## 流式、畸形输出与恢复

### 默认 Anthropic 标签集

解析是增量的，并且在 provider 数据块边界之间是安全的。对于每个非空的 `<invoke name="…">`，扫描器：

1. 在起始 invoke 标签闭合后立即发出 `toolStart`；
2. 在参数主体流式传输期间发出带键的 `toolArgDelta` 事件；并且
3. 仅在匹配的 `</invoke>` 之后执行最终强制转换并发出 `toolEnd`。

完成的事件包含用于诊断的确切原始 invoke 块。包装器文本不属于该原始块的一部分。

失败行为是显式的：

- 名称缺失或为空的 invoke 不会发出任何工具生命周期事件；
- 名称缺失或为空的参数会被忽略；
- 畸形的 JSON 会回退为原始文本；
- 参数内容上限为 1,000,000 个 JavaScript 字符串代码单元，超出时会附加显式的截断标记；
- 当刷新时，不完整的参数或 invoke 不会发出 `toolEnd`；并且
- 即便外层包装器永不闭合，完整的 invoke 仍然有效。

OMP 的流投影器在 `toolEnd` 之前，于 `toolStart` 处创建一个规范调用。因此，在正常停止的 provider 响应中，未闭合的 invoke 可能会保留为可部分运行的调用：流式传输的参数文本保持未强制转换状态，或者若没有任何参数到达则为 `{}`。provider 的 `length` 停止仍为不可运行的 `length`。此行为适用于普通的自有 `xml` 路径，在诊断停在标签中间的模型输出时非常重要。

### DSML 标签集

DSML 扫描器也将每个参数流式传输为带键的增量，并且仅在 `</｜DSML｜invoke>` 或其 ASCII 等效形式处发出 `toolEnd`。不完整的 DSML 参数在刷新时会重置部分调用，而不发出完成事件。因为 `xmlTagset: dsml` 是直接的扫描器选项，而非正常的自有渲染器路径，消费这些事件的调用方负责处理未匹配的 `toolStart`。

### 伪造的结果

对于通用 XML 方言，第一个由模型编写的 `<tool_response>` 被视为伪造结果的边界。OMP 会保留此前的调用/文本，并在此处停止投影。默认的 `tools.abortOnFabricatedResult: true` 会中止 provider 生成；禁用该设置则会排空但丢弃伪造的延续内容。

## 端到端示例

注入的目录行：

```text
<tools>
{"type":"function","function":{"name":"get_weather","description":"Get weather","parameters":{"type":"object","properties":{"city":{"type":"string"},"days":{"type":"number"}},"required":["city"]}}}
</tools>
```

助手调用批次：

```text
I'll compare both cities.
<invoke name="get_weather"><parameter name="city">Tokyo</parameter><parameter name="days">2</parameter></invoke>
<invoke name="get_weather"><parameter name="city">Oslo</parameter><parameter name="days">2</parameter></invoke>
```

OMP 生成的下一轮用户消息：

```text
<tool_response>
{"forecast":["clear","rain"]}
</tool_response>
<tool_response>
{"forecast":["rain","cloudy"]}
</tool_response>
```

然后助手正常作答，或发出另一序列的 invoke。

## 解析注意事项与陷阱

- **不是真正的 XML。** 参数主体按分隔符匹配，并且故意不转义。使用 XML 解析器/实体解码器会改变其值。
- **渲染器与扫描器的接受范围不同。** OMP 渲染裸的连续 invoke；默认扫描器另外接受两种包装器和 `antml:` 变体。
- **没有调用 id 或结果名称。** 在并行批次中保持调用/结果顺序。
- **错误仅为文本。** 通用 `<tool_response>` 不编码 `isError`。
- **Schema 上下文很重要。** 为渲染器/扫描器 API 提供工具，以便 schema 声明的字符串保持字面量，而不是被 JSON 加引号或强制转换。
- **`xmlTagset` 仅作用于扫描器。** 选择 DSML 并不会让 XML 渲染器输出 DSML。
- **闭合标签完成调用。** `toolStart` 和参数增量会尽早流式传输，但只有 `</invoke>` 才会生成最终强制转换后的参数对象和 `toolEnd`。

## 源文件

- `packages/ai/src/dialect/xml.md` — 注入的通用 XML 格式指南。
- `packages/ai/src/dialect/xml.ts` — 渲染器定义以及 Anthropic/DSML 扫描器选择。
- `packages/ai/src/dialect/anthropic.ts` — 默认的增量 invoke/参数扫描器、强制转换、思考以及不完整调用行为。
- `packages/ai/src/dialect/deepseek.ts` — DSML 信封扫描器以及 `string="false"` 强制转换。
- `packages/ai/src/dialect/catalog.ts` 和 `prompt-template.md` — 工具目录和系统提示词注入。
- `packages/ai/src/dialect/rendering.ts`、`history.ts` 和 `owned-stream.ts` — 结果渲染、历史转换、投影以及伪造结果处理。
- `packages/ai/src/utils/stream-markup-healing.ts` — 当前的 DSML 扫描器集成。
- `packages/coding-agent/src/sdk.ts` — `tools.format` 解析。
- `packages/ai/test/inband-tools.test.ts` 和 `dialect-thinking.test.ts` — 往返、分块参数增量、原始块、结果渲染以及思考行为。
