# Gemini Pythonic tool-calling format (`tool_code` / `default_api`)

Google 托管的 **Gemini** 模型（当前代，包括 `gemini-3.5-flash` / `*-pro` / `*-preview`）以及 **Gemma 3** 开源权重系列的工具调用约定。两者都**完全通过 prompt 工程**驱动工具使用——**没有专用的特殊 token**。模型将每次调用输出为 **Python 源码**：一次调用 `default_api.<function_name>(<kwargs>)`，按惯例包装在 `print(...)` 中，并放在一个围栏代码块 ```` ```tool_code ```` 内；它从 ```` ```tool_outputs ```` 块中读取返回结果。因为该机制是模型在后续训练中被要求生成的纯文本，所以完全相同的语法会周期性地泄漏到普通输出中（在 Vertex/AI-Studio 中表现为 `finish_reason = MALFORMED_FUNCTION_CALL`）——这种泄漏是……

验证来源：官方 Gemma 3 function-calling 指南（`ai.google.dev/gemma/docs/capabilities/function-calling`——两个推荐 prompt，一个 Pythonic，一个 JSON）、Simon Willison 对这两个 prompt 的转录、Philipp Schmid 的 Gemma 3 演练（`philschmid.de/gemma-function-calling`），以及从 `MALFORMED_FUNCTION_CALL` 报告中逆向工程得到的托管 Gemini 形式：`google/adk-go#492`（`Malformed function call: print(default_api.`）、`google-gemini/cookbook#929`（`executableCode` 部分 = `print(default_api.get_complaint_number_tool(consumer_number_or_mobile_number='2001234567'))`）、`firebase/genkit#2628`（```` ```tool_code ```` 的 markdown 包装），以及 Google AI 开发者论坛的帖子 "Gemini 2 flash returns raw markdown ……

## "Special" tokens

**None.** 这里没有 token 化器特殊 token 表中的控制 token——以下每个标记在 BPE 中都会拆分为普通文本，并能通过 `skip_special_tokens=True` 解码后保留。这是该约定的决定性特征，也是它同时 (a) 能够在托管 Gemini 和开源 Gemma 上不依赖 token 化器工作，以及 (b) 会发生泄漏的原因。功能性标记有：

| Marker (verbatim) | Role |
|---|---|
| ` ```tool_code ` | 打开一个围栏代码块，其主体是应用必须执行的 Python。由一个裸的 ` ``` ` 关闭。 |
| ` ```tool_outputs ` | 打开一个围栏代码块，将已执行的结果回传给模型。由一个裸的 ` ``` ` 关闭。 |
| `default_api` | 托管栈将无命名空间的工具捆绑进其中的合成模块命名空间。调用形式为 `default_api.<name>(...)`。 |
| `print(...)` | 托管 Gemini 形式中围绕调用的惯用包装（模型被训练为"打印"该调用）。语义上无关紧要——运行时解析该调用，但不会执行 Python。 |

在传输中**没有**每次调用的 id，也**没有**带内推理标记——Gemini 的推理以 API "thought signatures" 的形式带外传输，从不以 `<think>` 风格的文本形式出现。

> **OMP dialect note:** 因为该约定没有原生的带内推理标记，OMP `gemini` 方言在其上叠加了一个同级的围栏 ` ```thinking ` 块（由一个裸的 ` ``` ` 关闭，与 ` ```tool_code ` 完全相同），以便由 prompt 驱动的 Gemini / Gemma-3 部署能够以带内方式表达推理。这是 OMP 的约定，不属于 Google 格式的一部分。

## Roles / turn structure

Pythonic 负载独立于外壳，而外壳因部署方式而异：

- **Hosted Gemini** 使用普通的 `contents[]` 轮次结构（`role: "user" | "model"`）；`tool_code` 块出现在 `model` 轮次的文本中，而 `tool_outputs` 作为下一轮提供。
- **Gemma 3**（开源权重）使用 Gemma 对话模板（`<start_of_turn>user … <end_of_turn>` / `<start_of_turn>model`）；工具 prompt 被前置到第一个 user 轮次，块位于 model/user 轮次内部。

本文档规定**负载**（两个围栏代码块 + Python 调用形式）；外层的轮次标记属于承载它的任何模板。

## Tool definitions

工具在 prompt 中以 JSON-Schema 目录的形式进行声明。Gemma 3 官方指南提供了**两套**可互换的系统 prompt 模板，区别仅在于告诉模型如何作答：

1. **Pythonic**（本规范针对的形式）：
   > You have access to functions. If you decide to invoke any of the function(s), you MUST put it in the format of `[func_name1(params_name1=params_value1, params_name2=params_value2...), func_name2(params)]`
   > You SHOULD NOT include any other text in the response if you call a function

2. **JSON**（同级约定——参见 `qwen3.md` 中与之密切相关的 Hermes 形式）：
   > … you MUST put it in the format of `{"name": function name, "parameters": dictionary of argument name and its value}`

托管 Gemini 将同样的思路包装在 markdown 围栏和 `default_api` 命名空间中。函数签名本身以 OpenAI 风格的工具 JSON 传递（`{"type":"function","function":{name,description,parameters}}`）。OMP 的渲染器输出 `default_api.NAME(...)`，不带 `print`；其扫描器也接受下面列出的包装和裸的变体。

## Tool-call format

一次调用是一个 Python 调用表达式。托管 Gemini 通常输出 `default_api` 方法的 `print()`：

````text
```tool_code
print(default_api.get_current_temperature(location="London", unit="celsius"))
```
````

以下所有变体都被视为等价的、接受的写法，常见于实际场景以及各种 Gemma/Gemini 变体；健壮的解析器会将其归一化为 `{name, arguments}`：

- `print(default_api.NAME(KWARGS))` — 托管 Gemini 的规范形式。
- `default_api.NAME(KWARGS)` — `print`/命名空间是可选的语法糖。
- `NAME(KWARGS)` — 裸调用（Gemma 3 Pythonic prompt）。
- `result = NAME(KWARGS)` — 赋值形式（Gemma 3 文档使用 `result = convert(...)`）。

参数值是 **Python 字面量**，而不是 JSON：

| Python literal | Example | Decoded |
|---|---|---|
| string | `'London'` 或 `"London"` | `"London"` |
| int / float | `42`, `3.14` | `42`, `3.14` |
| bool | `True` / `False` | `true` / `false` |
| null | `None` | `null` |
| list | `["a", "b"]` | `["a","b"]` |
| dict | `{"k": 1}` | `{"k":1}` |

字符串使用 Python 转义（`\n`, `\t`, `\\`, `\'`, `\"`）；托管 Gemini 输出单引号（`location='London'`），Gemma 示例使用双引号——两者都合法。参数使用关键字形式（`name=value`）；不使用位置参数，因为运行时映射到带名称的 schema。

## Multiple / parallel tool calls

在单个 `tool_code` 块内有两种编码形式：

- **OMP / Gemma 3 Pythonic 形式** — 调用表达式的 Python **列表**。OMP 对两次或更多调用渲染这种形式：
  ````text
  ```tool_code
  [default_api.get_current_temperature(location="London"), default_api.get_temperature_date(location="London", date="2024-10-01")]
  ```
  ````
- **Hosted Gemini 变体** — 每个 `print(default_api...)` **语句占一行**：
  ````text
  ```tool_code
  print(default_api.get_current_temperature(location="London"))
  print(default_api.get_temperature_date(location="London", date="2024-10-01"))
  ```
  ````

OMP 扫描器按源代码顺序从任一形式中提取顶层调用表达式。它为每个解析出的调用生成一个 tool-call id；该文本约定本身没有 id。

## Tool-result format

已执行的结果通过 ```` ```tool_outputs ```` 块返回给模型。OMP 按调用顺序为每个结果渲染一个完整块；它不单独编码 `isError`。Gemma 3 文档也展示了赋值风格的值（`result = 92.3`），而透明输出可以作为文本/JSON 返回：

````text
```tool_outputs
{"temperature": 26.1, "location": "London", "unit": "celsius"}
```
````

模型随后以自然语言答案或另一个 `tool_code` 块继续。

## End-to-end example

````text
<user>
What's the temperature in London?

<model>
```tool_code
print(default_api.get_current_temperature(location="London", unit="celsius"))
```

<user>
```tool_outputs
{"temperature": 11.4, "location": "London", "unit": "celsius"}
```

<model>
It's currently 11.4°C in London.
````

## OpenAI-compatible / native API mapping

- 托管 Gemini 的原生 API 通常返回一个结构化的 `functionCall` 部分（`{name, args}`）。在直接的 Gemini Generative AI 请求中，Gemini 3 调用携带一个 `id`，OMP 在匹配的 `functionResponse` 中回显该 `id`；它们的 `thoughtSignature` 也必须保留。OMP 的 Vertex 适配器是例外：Vertex GenerateContent 拒绝 function 部分的 ID，因此 OMP 从 `functionCall` 和 `functionResponse` 中都省略 `id`，保留来源函数名，并依赖函数名/顺序进行匹配。Thought signature 仍然保留。
- 当从 OpenAI 兼容的 shim 中解析出来时，每个恢复出的调用变为 `tool_calls[i] = {id (server-minted), type:"function", function:{name, arguments:<JSON string>}}` — Python 关键字参数在该边界被重新序列化为 JSON 字符串。
- 将结果作为部署的工具/`functionResponse` 轮次（托管）或下一 user 轮次中的 `tool_outputs` 块（prompt 驱动）回传。

## Parsing notes & gotchas

- **Python, not JSON.** `True`/`False`/`None`（而非 `true`/`false`/`null`）、单引号字符串和尾部逗号都是合法的。JSON 解析器会拒绝合法的调用；应解码 Python 字面量。
- **Strip the wrapper.** 在读取调用名之前，归一化移除 `print(...)`、`default_api.`（或任何 `module.`）前缀，以及 `LHS =` 赋值。`print` 永远不是工具名。
- **Skip string contents when scanning.** 像 `search(pattern="foo(")` 这样的调用在字符串内包含一个 `(`；朴素的 `\w+\(` 扫描会错误地将 `foo` 识别为被调函数。应跟踪字符串状态，仅将顶层的 `(` 视为调用开启符。
- **Fence ambiguity.** 主体在第一个裸的 ` ``` ` 处终止；字面包含 ` ``` ` 的字符串参数将提前截断该块（罕见，已接受的限制）。
- **It leaks.** 因为没有特殊 token，当模型"决定"调用工具但结构化解码器失火时，该格式会以原文形式出现在正常响应中。读取原始文本的生产代码应检测 ` ```tool_code ` 并解析；结构化 API 上的生产代码应在 `MALFORMED_FUNCTION_CALL` 时重试。
- **OMP streaming behavior.** 扫描器缓冲整个 `tool_code` 主体，仅在关闭围栏之后才发出工具事件；它不会流式传输部分参数。未终止的块在 flush 时被丢弃，而不会作为文本暴露。位置参数和格式错误的关键字段被跳过。除了普通的带引号字符串外，字面量解码器还接受 Python 的 raw/byte/unicode 前缀、三引号、八进制转义以及 `\x`/`\u`/`\U` 转义。
- **Transcript rendering.** OMP 将记录包装在 `<bos>` 和 Gemma 风格的 `<start_of_turn>user|model` 轮次中。`developer` 文本被前置到下一个 user 轮次（如果没有后续 user 消息则作为自己的 user 轮次发出）；连续的工具结果成为一个 user 轮次，其中包含它们各自的 `tool_outputs` 块。
- **Variant divergence.** Gemma **4** 放弃了这种 Pythonic 形式，转而使用由 token 分隔的大括号语法（`<|tool_call>call:NAME{…}<tool_call|>`）——这是另一种约定，记录在 `gemma.md` 中。本规范涵盖托管 Gemini 和 Gemma 3。
- **Gemma 3 automatic-selection caveat.** OMP 当前的家族亲和映射将每个已识别的 Gemma 版本——包括 Gemma 3——都映射到 `gemma` 方言。因此，当 Gemma 3 模型被标记为 `supportsTools: false` 并从原生工具回退时，`tools.format=auto` 会选择不兼容的 Gemma 4 语法。对于本文档所述的 Pythonic Gemma 3 约定，请显式设置 `tools.format=gemini`。

## Sources

- Gemma 3 function calling (two recommended prompts): https://ai.google.dev/gemma/docs/capabilities/function-calling
- Simon Willison, "Function calling with Gemma": https://simonwillison.net/2025/Mar/26/function-calling-with-gemma/
- Philipp Schmid, "Google Gemma 3 Function Calling Example": https://www.philschmid.de/gemma-function-calling
- Gemini 3 thought signatures + functionCall ids: https://ai.google.dev/gemini-api/docs/gemini-3
- `default_api` / `tool_code` leak evidence: https://github.com/google/adk-go/issues/492 · https://github.com/google-gemini/cookbook/issues/929 · https://github.com/firebase/genkit/issues/2628 · https://discuss.ai.google.dev/t/gemini-2-flash-api-returns-raw-markdown-instead-of-function-call/71964
