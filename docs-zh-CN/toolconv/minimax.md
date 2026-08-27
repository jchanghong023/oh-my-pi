# MiniMax 拥有的工具调用格式（`<minimax:tool_call>`）

OMP 的 `minimax` 方言是面向 MiniMax 系列模型的、由提示驱动且内联的工具协议。调用是普通的助手文本：单个 `<minimax:tool_call>` 信封中包含一个或多个 `<invoke>` 元素。OMP 解析调用并在下一次用户回合中返回 `<function_results>` 块。该格式不携带工具调用 id，因此调用与结果按顺序对应。

本参考描述的是 OMP 已实现的转换器，而非 MiniMax 供应商原生的结构化工具 API。它的实现依据包括 `packages/ai/src/dialect/minimax.ts`、`packages/ai/src/dialect/anthropic.ts` 中的共享 XML 扫描器、`packages/ai/src/dialect/catalog.ts` 中的提示词组装，以及 `packages/ai/src/dialect/owned-stream.ts` 中的流式投影。

## 选择与请求转换

在 `~/.omp/agent/config.yml` 或项目/覆盖配置中显式设置该格式：

```yaml
tools:
  format: minimax
```

`tools.format: minimax` 会在本次会话中强制使用该自有方言。在 `auto` 模式下，除非所选模型显式声明 `supportsTools: false`，OMP 会保留供应商原生工具调用；对于 MiniMax 系列模型 id，该回退会解析为 `minimax`。参见 [`tools.format`](../settings.md#tools-and-approvals)。

当自有方言生效时，OMP 会：

1. 从供应商请求中移除原生结构化 `tools` 字段；
2. 向系统提示词追加内联工具目录和 MiniMax 格式说明；
3. 将先前的结构化助手调用和工具结果消息改写为本文本协议；以及
4. 将模型的文本流扫描回结构化的工具调用事件。

## 工具定义与提示词注入

注入的提示词以 `# Tools` 开头，说明调用是文本而非供应商原生工具消息，并在 `<tools></tools>` 内列出可用函数。每一行都是一个紧凑的 OpenAI 风格函数对象，包含归一化后的线路 schema：

```text
<tools>
{"type":"function","function":{"name":"read","description":"Read a file","parameters":{"type":"object","properties":{"path":{"type":"string"},"count":{"type":"number"}},"required":["path"]}}}
</tools>
```

目录之后是来自 `packages/ai/src/dialect/minimax.md` 的 MiniMax 专用说明。其契约要求函数名必须出现在列表中、字符串/标量体保持字面量形式、列表/对象使用 JSON、批量调用使用单一信封，并且禁止模型自行生成结果块。

## 工具调用信封

单个调用如下：

```text
<minimax:tool_call>
<invoke name="read"><parameter name="path">src/main.ts</parameter><parameter name="count">40</parameter></invoke>
</minimax:tool_call>
```

精确结构如下：

| 元素 | 含义 |
| --- | --- |
| `<minimax:tool_call>…</minimax:tool_call>` | 提示词契约中要求的模型输出信封。 |
| `<invoke name="TOOL">…</invoke>` | 一次调用。`name` 必须是已列出的工具。 |
| `<parameter name="ARG">VALUE</parameter>` | 一个具名参数。参数直接出现在 invoke 内部。 |

渲染器会对属性中的工具名和参数名做 XML 转义。参数体**不**做 XML 转义：该协议基于分隔符匹配，而非按 XML 解析。例如，字符串体写作 `a & b < c`，而不是 `a &amp; b &lt; c`。字面量 `</parameter>` 是唯一的保留序列，因为它会关闭当前参数。

扫描器比提示词契约更具容错性。它接受上述带命名空间的包装器、不带前缀的 `<tool_call>` 包装器，或独立于包装器之外的裸 `<invoke>`。模型仍应输出规范的 `<minimax:tool_call>` 形式，以保证行为不依赖恢复路径。

## 参数编码与强制转换

编码使用所选工具的 schema：

| 声明/值类型 | 渲染后的参数体 | 解析后的值 |
| --- | --- | --- |
| schema 声明为字符串且运行时值也是字符串 | 原样文本，包括首尾空格与换行 | 原样字符串 |
| 数字、布尔值、`null`、数组或对象 | JSON | 解析后的 JSON 值 |
| 没有匹配字符串 schema 的值 | JSON，字符串会包含引号 | 在合法时解析为 JSON |

示例：

```text
<invoke name="write"><parameter name="path">notes/a & b.txt</parameter><parameter name="options">{"append":false,"tags":["x","y"]}</parameter></invoke>
```

扫描器根据提供的工具 schema 解析字符串参数。`string` 参数属性可以覆盖该决定：

- `string="true"`（以及除 `false`、`0`、`no` 之外的任意值）强制按原样字符串处理。
- `string="false"`、`string="0"` 或 `string="no"` 强制按 JSON 解析，即使 schema 声明为字符串。

对于非字符串参数，仅在 JSON 解析阶段会裁剪两端空白。OMP 使用具备修复能力的 JSON 解析器；如果解析仍失败，则保留原始字符串体，而不是丢弃该参数。空体仍保留为空字符串。`name` 不可用的参数会被忽略。

## 多重与并行调用

并行调用是同一信封内按输出顺序排列的兄弟 `<invoke>` 元素：

```text
<minimax:tool_call>
<invoke name="read"><parameter name="path">src/a.ts</parameter></invoke>
<invoke name="read"><parameter name="path">src/b.ts</parameter></invoke>
</minimax:tool_call>
```

由于线路格式没有 id，扫描器会为每个 invoke 分配一个内部 id。OMP 可以将生成的调用作为一个批次派发。工具结果必须按相同顺序返回；结果协议中不存在可用于纠正顺序的调用 id。

## 工具结果信封

OMP 将连续的工具结果合并为一个 `<function_results>` 块。成功与失败使用不同的记录：

```text
<function_results>
<result>
<tool_name>read</tool_name>
<stdout>file contents</stdout>
</result>
<error>
<tool_name>read</tool_name>
<stderr>ENOENT: file not found</stderr>
</error>
</function_results>
```

对每条结果：

- 成功使用 `<result>`，内容放在 `<stdout>` 中；
- `isError: true` 使用 `<error>`，内容放在 `<stderr>` 中；
- `<tool_name>` 经过 XML 文本转义；
- stdout/stderr 原样插入；并且
- 不存在调用 id，模型按调用顺序读取记录。

OMP 将此文本放入合成的 `user` 消息中。同一工具结果的文本块会被拼接；图像结果块在渲染文本后仍保持为图像块。模型自身绝不能输出 `<function_results>` 或 `<tool_response>`。

## 思考与可见文本

OMP 将保留的推理块渲染为：

```text
<thinking>
reasoning text
</thinking>
```

在正常的自有工具流中，思考解析是启用的。MiniMax 扫描器识别 `<thinking>`、`<think>` 和 `<scratchpad>`（包括支持的前缀形式），分别发出思考事件，并将内容排除在可见助手文本之外。如果为直接使用扫描器的消费者禁用了 `parseThinking`，这些标签将作为可见文本保留。未闭合的思考块在流刷新时会被逻辑闭合，并保留其累积内容。

可见正文可以出现在工具信封之前。调用之外的文本保留为助手文本；包装器内不属于调用的文本会被扫描器丢弃。

## 流式、畸形输出与恢复

扫描器是增量且对分块边界安全的：开闭标签和参数体可能出现在不同的供应商 delta 中。其可观测的生命周期为：

1. 非空的 `<invoke name="…">` 立即发出 `toolStart`；
2. 每个具名参数体在文本块到达时发出带键的 `toolArgDelta` 事件；以及
3. 匹配的 `</invoke>` 执行最终的强制转换，并发出携带完整参数以及精确原始 invoke 块的 `toolEnd`。

重要的失败行为：

- **缺少调用名：** 不会为该 invoke 发出任何工具生命周期事件。
- **缺少参数名：** 该参数会被忽略。
- **JSON 格式错误：** 回退到原始参数文本。
- **超大参数：** 输入上限为 1,000,000 个 JavaScript 字符串代码单元；超出部分将替换为已接受的前缀并附上显式的截断标记。
- **invoke 不完整：** 刷新会重置扫描器本地的调用状态，并且不会发出 `toolEnd`。然而，OMP 的流投影已经从 `toolStart` 物化了一次调用；在正常停止的响应中，它会保留该未完成的调用，将该回合标记为工具使用，并可能派发它。已经流出的参数文本仍保持未强制转换状态，且没有参数文本的调用其参数为 `{}`。供应商的 `length` 停止原因保持为 `length`，而不会成为可运行的工具使用。
- **invoke 完整但包装器不完整：** 已闭合的 invoke 仍然有效；包装器闭合标签并不是发出其 `toolEnd` 事件的必要条件。
- **思考不完整：** 保留为思考，并在刷新时逻辑结束。

OMP 还会防止模型在自身调用之后伪造工具输出。对于本方言，第一个 `<function_results>` 或 `<tool_response>` 边界会停止投影。在默认的 `tools.abortOnFabricatedResult: true` 下，生成会立即中止；禁用时，OMP 会排空供应商流，但丢弃伪造的续接内容。

## 端到端示例

注入的工具定义（已缩写为相关目录行）：

```text
<tools>
{"type":"function","function":{"name":"get_weather","description":"Get weather","parameters":{"type":"object","properties":{"city":{"type":"string"},"units":{"type":"string"}},"required":["city"]}}}
</tools>
```

助手调用：

```text
I'll check both cities.
<minimax:tool_call>
<invoke name="get_weather"><parameter name="city">Tokyo</parameter><parameter name="units">celsius</parameter></invoke>
<invoke name="get_weather"><parameter name="city">Oslo</parameter><parameter name="units">celsius</parameter></invoke>
</minimax:tool_call>
```

OMP 生成的下一轮用户消息：

```text
<function_results>
<result>
<tool_name>get_weather</tool_name>
<stdout>{"temperature":28,"condition":"clear"}</stdout>
</result>
<result>
<tool_name>get_weather</tool_name>
<stdout>{"temperature":14,"condition":"rain"}</stdout>
</result>
</function_results>
```

随后助手可以正常回答，也可以再发出一个完整的 MiniMax 调用信封。

## 解析说明与注意事项

- **并非真正的 XML。** 不要对参数体进行实体转义，也不要将其交给 XML DOM 解析器；匹配基于协议分隔符。
- **一个信封，多个 invoke。** 并行通过 `<minimax:tool_call>` 内部的兄弟调用实现，而不是 JSON `tool_calls`，也不是每个必需的批次一个信封。
- **schema 决定字符串。** 在没有工具 schema 的情况下，即使是 JavaScript 字符串渲染值也会被 JSON 加引号；若需要往返，请在渲染器/扫描器 API 中提供工具定义。
- **线路上没有 id。** OMP 生成的 id 是内部使用的。请保持调用/结果的顺序。
- **错误是一等记录。** 使用 `<error>/<stderr>`，而不是在成功的 `<result>` 中附带一个带外的错误标志。
- **规范包装器与可接受的恢复语法。** 解析器接受裸 invoke 和 `<tool_call>`，但注入的契约要求使用 `<minimax:tool_call>`。
- **停止前请完成 invoke。** 自然语言中承诺调用工具并不算一次调用；闭合的 `</invoke>` 才是完成强制转换和正常生命周期的标志。

## 资料来源

- `packages/ai/src/dialect/minimax.md` — 注入的 MiniMax 格式说明。
- `packages/ai/src/dialect/minimax.ts` — 调用、结果、思考与转写渲染器，以及扫描器配置。
- `packages/ai/src/dialect/anthropic.ts` — 共享的增量 invoke/参数扫描器与强制转换行为。
- `packages/ai/src/dialect/catalog.ts` 与 `prompt-template.md` — 工具目录与系统提示词注入。
- `packages/ai/src/dialect/history.ts` 与 `owned-stream.ts` — 历史转换、流式投影、不完整调用行为以及伪造结果边界。
- `packages/catalog/src/identity/dialect.ts` 与 `packages/coding-agent/src/sdk.ts` — MiniMax 系列亲和性以及 `tools.format` 解析。
- `packages/ai/test/inband-tools.test.ts` — 提示词渲染、调用往返、分块参数 delta、原始块、MiniMax 包装器恢复与结果渲染。
