# Hermes 工具调用格式

由 NousResearch 的 **Hermes 2 Pro**（基于 Llama-3 的开源模型）开创、并由 **Hermes 3** 系列以及社区大量微调版本延续下来的工具调用约定。其外层格式是 **ChatML**：每一轮对话都是 `<|im_start|>{role}\n{body}<|im_end|>\n`。可用工具在 system 轮中以 `<tools>…</tools>` 块的形式按 OpenAI 风格的 JSON 工具对象进行声明；模型每次调用都通过一个 `<tool_call>\n{json}\n</tool_call>` 块发出，其中 `arguments` 是一个**嵌套的 JSON 对象**（而不是字符串化的 JSON）；工具结果通过一个**专用的 `<|im_start|>tool` 轮**回传，内容是包裹 `{"name": …, "content": …}` 对象的 `<tool_response>…</tool_response>` 块——结果会携带函数名，因此每个结果对于其所调用的函数是自描述的，但与具体调用的绑定仍然依赖位置。

已根据以下来源核对：NousResearch 的 `Hermes-Function-Calling` README（已完整阅读——规范的系统提示、调用/结果格式以及下面的推理示例均直接引自该 README）、vLLM 工具调用文档（`hermes` 解析器），以及 `main` 分支 `4324de2` 提交上的 omp 实现（下面每一条 omp 相关论断都附有 `file:line` 引用）。

## 特殊标记

只有 ChatML 标记是控制标记；工具和推理标记是轮内容体内部的普通文本字符串。标记的**token ID 因模型而异**（每个 Hermes 版本的 tokenizer 都不同），因此本文有意不列出具体 ID。

| 标记（原文） | 类型 | 用途 |
|---|---|---|
| `<\|im_start\|>` | ChatML 控制标记 | 一轮对话的开始；紧跟角色名 + `\n` |
| `<\|im_end\|>` | ChatML 控制标记 | 一轮对话的结束 |
| `<tool_call>` | 文本级标记 | 开启一次工具调用 |
| `</tool_call>` | 文本级标记 | 关闭一次工具调用 |
| `<tool_response>` | 文本级标记 | 开启一个工具结果 |
| `</tool_response>` | 文本级标记 | 关闭一个工具结果 |
| `<tools>` … `</tools>` | 普通文本 | 在 system 轮中包裹工具列表 |
| `<scratch_pad>` … `</scratch_pad>` | 文本级标记（Hermes 3） | 调用前的 GOAP 推理段落 |
| `<think>` … `</think>` | 不在 Hermes 2 Pro 规范中 | omp 扫描器识别的思维标记（R1 风格微调） |

关于精确性的说明：

- 所有标记都使用 ASCII 竖线 `|`（U+007C）和 ASCII 尖括号。
- README 将 ChatML 描述为通过"特殊 token ……来标记任何轮对话的开始和结束，以及各轮的角色"；实际上只有 `<|im_start|>`/`<|im_end|>` 才是用来切分轮的控制标记。工具相关的标记都是普通文本，这就是为什么正则/子串解析器可以从解码后的输出中恢复它们。
- `<tools>`/`</tools>` 完全没有 token 层面的特殊地位——它们只是包裹 JSON 工具列表的提示词文本包装符。

## 角色 / 通道 / 轮结构

ChatML。每条消息的渲染形式为：

```text
<|im_start|>{role}
:{body}<|im_end|>
```

- 角色：`system`、`user`、`assistant`、`tool`。没有独立的"通道"概念；唯一的子流是 assistant 轮开头的可选 Hermes 3 `<scratch_pad>`（或 R1 风格的 `<think>`）块。
- `<|im_end|>\n` 终止每一轮。当 `add_generation_prompt=True` 时，提示词以 `<|im_start|>assistant\n` 结尾，模型从该位置继续生成。
- **System 轮：** 如果调用方提供 `system` 消息，它会成为第一轮。当存在工具时，工具声明**就是**该 system 轮的内容（即下文引用的函数调用提示词）——没有单独的工具轮。
- **工具结果轮使用专用的 `tool` 角色。** 每个执行结果都作为携带 `<tool_response>` 块的 `<|im_start|>tool` 轮发回。这是经典的 Hermes 2 Pro 形态；Qwen3 的模板则将同样的块折叠进 `user` 轮中（见 [qwen3.md](qwen3.md) §角色）。
- **思维/推理：** Hermes 2 Pro 的函数调用规范中并不存在思维通道。Hermes 3 的工具使用模板可能会在 `<tool_call>` 之前插入 `<scratch_pad>…</scratch_pad>` GOAP 块（Goal / Actions / Observation / Reflection 段落）。

## 工具定义

工具以**系统提示本身**的形式进行声明。NousResearch README 中规范的 Hermes 2 Pro 提示词原文如下：

```text
<|im_start|>system
You are a function calling AI model. You are provided with function signatures within <tools></tools> XML tags. You may call one or more functions to assist with the user query. Don't make assumptions about what values to plug into functions. Here are the available tools: <tools> [{"type": "function", "function": {"name": "get_stock_fundamentals", "description": "Get fundamental data for a given stock symbol using yfinance API.", "parameters": {"type": "object", "properties": {"symbol": {"type": "string"}}, "required": ["symbol"]}}}] </tools> Use the following pydantic model json schema for each tool call you will make: {"title": "FunctionCall", "type": "object", "properties": {"name": {"title": "Name", "type": "string"}, "arguments": {"title": "Arguments", …
<tool_call>
{"name": <function-name>, "arguments": <args-dict>}
</tool_call><|im_end|>
```

- 列表中的每个元素都是完整的 OpenAI 工具对象 `{"type": "function", "function": {...}}`（其中 `parameters` 是一个 JSON-Schema 对象）。2 Pro 的提示词将整个 JSON **数组内联**嵌入；Hermes 3 模板则把 `<tools>` 块独立成行，但 JSON 内容相同。
- 末尾的指令是提示词字面的一部分，包括占位行 `{"name": <function-name>, "arguments": <args-dict>}`（那些尖括号标记是说明性文字，不是模型会发出的输出）。
- `FunctionCall` pydantic schema 句子说明了两键调用对象；Qwen3 在采用该约定时删去了这句话（见 [qwen3.md](qwen3.md) §工具定义）。
- Hermes 3 模板还额外要求模型在调用函数之前，将 GOAP 推理记录在 `<scratch_pad>…</scratch_pad>` 中，其中 `Actions` 以 `result_var = functions.name(param=value, …)` 这种行的形式书写。

## 工具调用格式

模型每次调用都通过一行 `<tool_call>`、一个单行 JSON 对象、再到 `</tool_call>` 来发出。最简单的单次调用（README 示例，原文）：

```text
<tool_call>
{"name": "get_stock_fundamentals", "arguments": {"symbol": "TSLA"}}
</tool_call>
```

- `arguments` 是一个**嵌套的 JSON 对象**，不是 JSON 编码的字符串。在线协议中它是 `"arguments": {"symbol": "TSLA"}`——绝不是 `"arguments": "{\"symbol\": \"TSLA\"}"`。
- 调用对象恰好有两个键：`name`（字符串）和 `arguments`（对象），与 `FunctionCall` schema 一致。**线协议上不存在每次调用的 ID**——OpenAI 风格的 `tool_call_id` 由服务层生成（见 API 映射）。
- 一次发起工具调用的 assistant 轮中，在第一个 `<tool_call>` 之前也可以包含自然语言正文。

## 多次 / 并行工具调用

并行调用以连续的 `<tool_call>…</tool_call>` 块的形式，在同一 assistant 轮中发出。系统提示明确允许"一个或多个函数"；每个块独立解析，并且每个调用必须回传一个对应的 `<tool_response>`。

## 工具结果格式

每个执行结果都作为 `<|im_start|>tool` 轮回传，其内容体是一个包裹 JSON 对象的 `<tool_response>` 块，对象中包含函数**名**和**内容**（README 示例，原文）：

```text
<|im_start|>tool
<tool_response>
{"name": "get_stock_fundamentals", "content": {"symbol": "TSLA", "company_name": "Tesla, Inc.", "sector": "Consumer Cyclical", "industry": "Auto Manufacturers", "market_cap": 611384164352, "pe_ratio": 49.604652, "pb_ratio": 9.762013, "dividend_yield": null, "eps": 4.3, "beta": 2.427, "52_week_high": 299.29, "52_week_low": 152.37}}
</tool_response>
<|im_end|>
```

- `{"name": …, "content": …}` 这种嵌套让每个结果对于被调用的函数是自描述的，但与具体调用的绑定仍然依赖位置。对同一函数的两个并行调用具有相同的 `name`，而该原始格式并不提供唯一的调用 ID。（Qwen3 在 `user` 轮下只发出裸内容，并依赖顺序——见 [qwen3.md](qwen3.md) §工具结果格式。）
- 在 OpenAI API 层，一条结果消息是 `{"role": "tool", "content": "...", "tool_call_id": "..."}`；上面的渲染形式就是模板从该消息生成的产物。

## 端到端示例

完整的对话直接拼自 NousResearch README 中函数调用演示的四个连续代码块（每轮都已与源文逐字节核对）：

```text
<|im_start|>user
Fetch the stock fundamentals data for Tesla (TSLA)<|im_end|>
<|im_start|>assistant
<tool_call>
{"name": "get_stock_fundamentals", "arguments": {"symbol": "TSLA"}}
</tool_call><|im_end|>
<|im_start|>tool
<tool_response>
{"name": "get_stock_fundamentals", "content": {"symbol": "TSLA", "company_name": "Tesla, Inc.", "sector": "Consumer Cyclical", "industry": "Auto Manufacturers", "market_cap": 611384164352, "pe_ratio": 49.604652, "pb_ratio": 9.762013, "dividend_yield": null, "eps": 4.3, "beta": 2.427, "52_week_high": 299.29, "52_week_low": 152.37}}
</tool_response>
<|im_end|>
<|im_start|>assistant
The stock fundamentals data for Tesla (TSLA) are as follows:
- **Symbol**: TSLA
- **Company Name**: Tesla, Inc.
- **Sector**: Consumer Cyclical
- **Industry**: Auto Manufacturers
- **Market Capitalization**: $566,160,130,480
- **Forward Price-to-Earnings Ratio (PE Ratio)**: 42.73
- **Price-to-Book Ratio (PB Ratio)**: 9.04
- **Dividend Yield**: N/A
- **Trailing Earnings Per Share (EPS)**: $4.3
- **Beta Value of the Stock**: 2.42
- **52-Week High Price of the Stock**: $299.29
- **52-Week Low Price of the Stock**: $152.37

This information provides a snapshot of Tesla's financial position and performance based on the fundamental data obtained from the yfinance API. It shows that Tesla has a substantial market capitalization and a relatively high P/E and P/B ratio compared to other stocks in its industry. The company does not pay a dividend at the moment, which is reflected by a 'Dividend Yield' of 'None'. The Beta value indicates that Tesla's stock has a moderate level of volatility relative to the market. The 52-week high and low prices give an idea of the stock's range over the past year. This data can be useful when assessing investment opportunities and making investment decisions.<|im_end|>
```

## 兼容 OpenAI 的 API 映射

服务引擎通过 **`hermes` 工具调用解析器**暴露该约定（vLLM：`--enable-auto-tool-choice --tool-call-parser hermes`，`Hermes2ProToolParser`——Qwen3 也使用同一个解析器，参见 [qwen3.md](qwen3.md) §兼容 OpenAI 的 API 映射和 §解析说明中已核实的流式细节）：

- `finish_reason`：当本轮在工具调用处结束时为 `"tool_calls"`（否则为 `"stop"`）。
- `message.role`：`"assistant"`；`message.content`：对于纯工具调用轮为 `null`（调用前的任何正文会作为 `content`）。
- `message.tool_calls[]`：每个 `<tool_call>` 块对应一个条目，每条都带有服务端生成的 `id`（模型本身不发出 id）、`type: "function"`、`function.name`，以及在 API 边界被重新序列化为 **JSON 字符串**的 `function.arguments`（使用前需要 `json.loads(...)`）。
- 回传结果：为每个结果追加 `{"role": "tool", "content": <result>, "tool_call_id": <id-from-the-call>}`；引擎会将其渲染成上文所示的 `<tool_response>` 形式。

## omp / pi 转换器行为

仓库中的 `hermes` 方言是一个**自有的带内转换器**，在 `packages/ai/src/dialect/factory.ts:16` 中注册，并在 `packages/ai/src/dialect/hermes.ts:195-206` 中定义。当存在工具时，代理会将 Hermes 格式指南和精简后的工具目录追加到系统提示中，移除原生 provider 工具，按本语法把之前的调用和结果改写为文本，并将流式输出扫描回规范的 pi 工具调用事件。`qwen3` 仍然是独立可选的方言，尽管两者发出的是相同的基本 "JSON-in-`<tool_call>`" 约定。

### 选择方式

通过 `tools.format: hermes` 或 `PI_DIALECT=hermes` 强制使用该方言（`resolveOwnedDialectFromEnv`，`packages/agent/src/agent-loop.ts:171-191`，在 `agent-loop.ts:1527` 处生效）。`tools.format` 枚举（`packages/coding-agent/src/config/settings-schema.ts:2655-2671`；UI 标签在 `2679-2697`）提供以下选项：

| `tools.format` 取值 | UI 标签 | 含义 |
|---|---|---|
| `auto` | Auto | 原生工具调用，除非模型被标记为不支持工具调用，此时回退到该模型族自有方言（GLM 回退） |
| `native` | Native | Provider 原生工具调用 |
| `glm` | GLM | GLM 风格的带内工具调用 |
| `hermes` | Hermes | 本方言 |
| `kimi` | Kimi | Kimi 风格的带内工具调用 |
| `xml` | XML | 通用 XML 带内工具调用 |
| `anthropic` | Anthropic | Anthropic 风格的带内工具调用 |
| `deepseek` | DeepSeek | DeepSeek 风格的带内工具调用 |
| `harmony` | Harmony | Harmony 风格的带内工具调用 |
| `qwen3` | Qwen3 | Qwen3 自有方言 |
| `gemini` | Gemini | Gemini 自有方言 |
| `gemma` | Gemma | Gemma 自有方言 |
| `minimax` | MiniMax | MiniMax 自有方言 |

没有任何模型族会自动映射到 `hermes`：`preferredDialect`（`packages/catalog/src/identity/dialect.ts:18-42`）永远不会返回它，而 `auto` 的回退是 `glm`（`packages/coding-agent/src/sdk.ts:628-633`）。该方言只能通过显式指定来使用。

### 提示词与目录

自有模式会追加 `renderInbandToolPrompt` 的输出（`packages/ai/src/dialect/catalog.ts:24-29`）：一个 `# Tools` 标题、**每行一个 OpenAI 风格 JSON 工具对象**的 `<tools>` 块（`catalog.ts:9-22`，模板在 `packages/ai/src/dialect/prompt-template.md`），再接 Hermes 格式指南（`packages/ai/src/dialect/hermes.md`）。指南展示了精确的 `<tool_call>`/`<tool_response>` 形态，要求 `arguments` 必须是 JSON 对象（"绝不能是字符串化的 JSON"），禁止对参数字符串进行 HTML 转义，并指示模型在停止前写出完整的调用、且永远不要自行发出 `<tool_response>`。该包装是 omp 自有的——它不是上文引用的 2 Pro 那段散文 + `FunctionCall` schema 句子。

### 渲染

渲染器始终写出：

- 调用为 `<tool_call>\n{单行 JSON}\n</tool_call>`，其中的 `arguments` 是**嵌套**对象（`hermes.ts:170-172`），并行调用用换行分隔（`hermes.ts:174-176`）；
- 结果为 `<tool_response>\n{裸结果文本}\n</tool_response>` 块，以换行作为分隔（`packages/ai/src/dialect/rendering.ts:5-7`）；
- 整段转写为 ChatML 轮，使用**专用的 `tool` 结果角色**（`hermes.ts:186-193` → `renderChatMlTranscript`，参数为 `toolResultRole: "tool"`，`rendering.ts:107-136`；轮外层在 `rendering.ts:275-277`）。连续的工具结果会合并到同一段（`rendering.ts:125-129`）；`developer` 消息按 `system` 渲染（`rendering.ts:131`）。

相对于经典 Hermes 2 Pro 渲染有两处刻意的差异：结果体是**裸文本**（不是 `{"name": …, "content": …}` 包装形式——注入的格式指南会让模型看到裸形式），工具声明使用 omp 自有的 `# Tools` 目录。一次 assistant 轮先渲染思维，再渲染正文，最后渲染调用（`rendering.ts:116-123`）；存储的思维会以 `<think>\n{text}\n</think>` 形式往返转换，嵌套的块会被展开并以换行连接（`hermes.ts:182-184` → `renderDelimitedThinking`，`rendering.ts:250-273`）。

### 扫描

`HermesInbandScanner`（`hermes.ts:21-168`）识别 `<tool_call>`/`</tool_call>` 和 `<think>`/`</think>`（`hermes.ts:15-18`），并在流分块之间保留部分标记后缀（`hermes.ts:19,82`；`packages/ai/src/dialect/coercion.ts:114-126`）。它在 `<tool_call>` 处生成一个 id（`ptc_…`，`hermes.ts:98`；`coercion.ts:109-112`），并在前导 JSON 中包含完整字符串 `name` 时立即发出 `toolStart`（`hermes.ts:132-142`）。它会等到 `</tool_call>` 才发出 `toolEnd`，且不流式推送参数增量；闭合时它使用共享的容错 JSON 解析器，同时也接受字符串化的 `arguments` 值（再解析一次），把非对象参数归一化为 `{}`（`hermes.ts:144-160`；`coercion.ts:134-136`）。原始块会被保留……

如果在已经恢复 `name` 但尚未到达 `</tool_call>` 时就遇到 EOF，则不会发出 `toolEnd`，但由 `toolStart` 创建的规范调用会以空参数存活下来，并可能在正常停止时被派发（`hermes.ts:107-109`）。一个已闭合的块如果其 `name` 无法被恢复，则会被消费而不创建调用（`hermes.ts:147`）。

自有流还会监视模型自行伪造的 `<tool_response>`（`packages/ai/src/dialect/owned-stream.ts:22,205-206`），并在 `tools.abortOnFabricatedResult` 设置时中止请求（`packages/coding-agent/src/sdk.ts:3318`）。

### 思维解析默认值

**`HermesInbandScanner` 构造函数默认将思维解析设为关闭**：`this.#parseThinking = options.parseThinking === true;`（`hermes.ts:32`）。因此，不带选项调用 `createInbandScanner("hermes")` 的消费者（`factory.ts:32-34`）会得到保留在可见文本中的 `<think>…</think>`——根本不会去搜索该标记（`hermes.ts:79`）。

这与其他兄弟方言相反，那些扫描器默认开启：`qwen3`（`packages/ai/src/dialect/qwen3.ts:37`）、`kimi`（`kimi.ts:45`）、`glm`（`glm.ts:87`）、`gemini`（`gemini.ts:52`）和 `gemma`（`gemma.ts:45`）都使用 `options.parseThinking !== false`，`deepseek` 使用 `options.parseThinking ?? true`（`deepseek.ts:107`）。（`anthropic` 同样采用默认关闭的形态，见 `anthropic.ts:107`。）该差异已在 [#9257](https://github.com/can1357/oh-my-pi/issues/9257) 中被标记出来，并在维护者做出决定前保持原样。

omp 自身的代理流程无论如何都不受影响：自有工具流始终以 `parseThinking: true` 构造其扫描器（`owned-stream.ts:200-204`），因此在 `tools.format: hermes` 下，代理循环会像其他兄弟方言一样把 `<think>` 块解析为思维事件。默认关闭的构造函数仅对直接使用扫描器的消费者有影响。当解析开启时，思维事件以增量方式流式推送，未闭合的 `<think>` 块会在 flush 时被逻辑闭合（`hermes.ts:48-75`）。

## 解析说明与注意事项

- **参数对象 vs 字符串：** 在线协议中 `arguments` 是嵌套的 JSON 对象；OpenAI 层在返回时将其作为 JSON 字符串。读取原始流的代码必须解析对象；读取 API 的代码必须对字符串执行 `json.loads`。切勿双重编码。（omp 的扫描器为提高健壮性而容忍字符串化形式；其渲染器从不会发出这种形式。）
- **`<tools>` 不是控制标记。** 只有 `<|im_start|>`/`<|im_end|>` 用来界定轮；其余一切都是对解码后文本的子串匹配。
- **正则/流式解析：** vLLM 的 `hermes` 解析器以字面子串 `<tool_call>`/`</tool_call>` 为关键，并对内容进行 JSON 解码；从 `<tool_call>` 开始缓冲，先增量解析 `name`，再解析 `arguments`——完整细节见 [qwen3.md](qwen3.md) §解析说明。
- **结果绑定：** 经典 Hermes 2 Pro 在 `tool` 轮下通过 `{"name": …, "content": …}` 嵌套把函数名作为元数据包含进来，但调用/结果绑定仍然依赖位置，因为名称不必唯一。Qwen3 也依赖顺序，并在 `user` 轮下使用裸内容。
- **规范中不存在思维通道：** Hermes 2 Pro 的函数调用提示词没有定义思维通道；Hermes 3 的 `<scratch_pad>` GOAP 标记**不会**被 omp 的 hermes 扫描器解析（它只识别 `<tool_call>` 和 `think`，见 `hermes.ts:15-19`）——scratchpad 文本会保留在可见部分。R1 风格的 `<think>` 块会被处理（见上文的思维默认值）。
- **历史重渲染：** omp 会为**每一个** assistant 轮重渲染存储的 `<think>` 块（`rendering.ts:116-123`），与 Qwen3 的 chat 模板不同——Qwen3 的模板会从除最后 assistant 轮以外的所有轮中裁剪掉推理内容；在跨方言比较转写时务必牢记这种不对称。
- **健壮性：** 该格式由提示词驱动，因此可能产生格式错误的输出（JSON 被截断、缺少 `</tool_call>`、正文混入调用块、参数被字符串化等）。omp 的扫描器在识别到块时，若外部 JSON/名称无法恢复，则不会发出调用；调用中途遇到 EOF 时，会留下一个以空参数启动的调用（见扫描一节）。

## 来源

- NousResearch Hermes-Function-Calling README（规范的提示词格式、调用/结果形式、推理示例）：https://github.com/NousResearch/Hermes-Function-Calling
- vLLM 工具调用文档（`hermes` 解析器、自动工具选择）：https://docs.vllm.ai/en/latest/features/tool_calling/
- [qwen3.md](qwen3.md)——Qwen3 对该约定的采用、共享的 vLLM 解析器行为，以及 `qwen3`/`hermes` 方言之分
- `main` 分支 `4324de2` 提交上的 omp 实现——上文每一条 omp 特有的论断都以 `file:line` 内联引用
