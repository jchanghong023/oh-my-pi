# OpenAI Harmony 响应格式

Harmony 是 OpenAI 训练其开放权重 `gpt-oss` 模型时所采用的响应格式（`gpt-oss-20b`、`gpt-oss-120b`，于 2025 年 8 月发布）。它定义了对话封装、多通道的推理/答复分离，以及函数调用的线协议语法。如果不使用该格式进行提示，模型将无法正确工作。该格式刻意模仿 OpenAI 的 *Responses* API（角色、通道、收件人），而非较早的 Chat Completions 形式。

词元通过 `o200k_harmony` 编码生成（`o200k_base` BPE 词表加上一个 Harmony 特殊词元块；见下表）。参考的渲染器/解析器是 Rust crate `openai-harmony`（Python 绑定：`pip install openai-harmony`；编码名称 `HarmonyEncodingName.HARMONY_GPT_OSS`）。

只有在自己构建推理循环时，你才会直接处理原始 Harmony。通过兼容 OpenAI 的端点访问时，服务器会为你处理这些细节：

- **Ollama / LM Studio / HuggingFace**：Harmony 在内部应用；你只需发送标准的 OpenAI 风格 JSON。
- **vLLM**：`vllm serve openai/gpt-oss-120b --enable-auto-tool-choice --tool-call-parser openai --reasoning-parser openai_gptoss`。注意 tool-call 解析器标志是 `openai`（而非 `harmony`）。vLLM 也通过 `/v1/responses` 端点暴露 Harmony 原生路径。
- **SGLang**：`python3 -m sglang.launch_server --model-path openai/gpt-oss-20b --reasoning-parser gpt-oss --tool-call-parser gpt-oss`（在 NVIDIA Dynamo 分离模式下：`--dyn-tool-call-parser harmony --dyn-reasoning-parser gpt_oss`）。

随 gpt-oss 权重一同发布的聊天模板，会从标准的 `messages`/`tools` 数组渲染出同样的词元序列。

## 特殊词元

所有 Harmony 控制词元都采用字面形式 `<|type|>`（ASCII 管道符 `|`，U+007C —— 不使用 Unicode 变体）。它们在 `o200k_harmony` 中都是真实的单一词元，而非会被 BPE 切分的文本。结构上具有意义的如下：

| 词元（逐字） | 词元 ID | 用途 |
| :--------------- | :------- | :------ |
| `<\|start\|>`     | `200006` | 开启一条消息；紧跟其后是头部（角色、可选的收件人/通道/内容类型）。 |
| `<\|end\|>`       | `200007` | 结束一条已完整成形的消息。 |
| `<\|message\|>`   | `200008` | 头部到正文的过渡。它之后的所有内容（直到停止/结束词元）即为消息正文。 |
| `<\|channel\|>`   | `200005` | 引入头部的通道字段（`analysis` / `commentary` / `final`）。 |
| `<\|constrain\|>` | `200003` | 在工具调用头部中标记内容类型/受限解码格式（如 `<\|constrain\|>json`）。 |
| `<\|return\|>`    | `200002` | 停止词元：模型已完成最终答复。仅在解码时使用（见归一化说明）。 |
| `<\|call\|>`      | `200012` | 停止词元：模型正在发出工具调用，并希望其被执行。 |

`<|return|>` 和 `<|call|>` 是两个合法的生成停止词元 —— 遇到任一者即应停止推理。

该编码还定义（同属 `o200k_harmony` 块，ID 范围 `199998`–`200013`）了 `<|startoftext|>`（199998）、`<|endoftext|>`（199999），以及保留槽位 `<|reserved_200000|>`、`<|reserved_200001|>`、`<|reserved_200004|>`、`<|reserved_200009|>`–`<|reserved_200011|>`、`<|reserved_200013|>`，外加一段大容量保留范围 `<|reserved_200014|>`…`<|reserved_201088|>`。渲染器另外知道这些名称 `<|refusal|>`、`<|untrusted|>`、`<|end_untrusted|>`、`<|meta_end|>`，但它们并不属于已发布的 gpt-oss 词表，也不会出现在正常流量中。

## 角色 / 通道 / 轮次结构

**消息封装。** 每条消息的形式为：

```text
<|start|>{header}<|message|>{content}<|end|>
```

`{header}` 始终以角色开头，并可携带可选的收件人（`to=...`）、通道和内容类型。已完整的消息以 `<|end|>` 结尾；正在生成的助手消息则以停止词元（`<|return|>` 或 `<|call|>`）结尾。

**角色**（五种）。用于解决冲突的指令优先级为 `system` > `developer` > `user` > `assistant` > `tool`。

| 角色 | 用途 |
| :--- | :------ |
| `system` | 身份、知识截止日期 / 当前日期、推理力度、合法通道声明、内置工具。并非面向用户的"系统提示词"。 |
| `developer` | 传统的"系统提示词"：指令 + `# Tools` 函数声明 + （可选的）结构化输出 schema。 |
| `user` | 最终用户输入。 |
| `assistant` | 模型输出。携带通道，对于工具调用还携带收件人。 |
| `tool` | 已执行工具的输出。消息的*作者/角色即为工具自身的名称*（如 `functions.get_current_weather`），而非字面词 `tool`。 |

**通道**（仅限助手输出；助手消息上通道是必填的）：

| 通道 | 用途 |
| :------ | :------ |
| `analysis` | 原始的思维链（推理）。不要求与 `final` 同样的安全标准；不要向最终用户展示。内置的 `python`/`browser` 调用通常出现在此。 |
| `commentary` | 函数工具调用，以及调用多个工具之前的用户可见"序言"（行动计划）。 |
| `final` | 面向用户的答复。 |

**推理力度**在系统消息中以 `Reasoning: high`（或 `medium` / `low`；默认为 medium）设置。模型将 CoT 输出到 `analysis`，将答复输出到 `final`。

**CoT 延续规则。** 下一轮时，*如果*上一轮助手消息以 `final` 结束，则丢弃先前的 `analysis` 消息。例外情况是进行中的工具调用轮次：位于工具调用之前的 `analysis` 必须随工具结果一起回传，以便模型能继续其推理（`openai-harmony` 渲染器通过 `RenderConversationConfig { auto_drop_analysis: true }` 实现此行为）。

## 工具定义

函数工具在 **developer** 消息中的 `# Tools` 段下声明，位于一个 TypeScript 风格的 `namespace functions { ... }` 中。（内置的 `browser`/`python` 工具则在 **system** 消息中、以各自的 `# Tools` / `## browser` / `## python` 标题声明。）渲染器按以下规则将每个 JSON Schema 转换为 TS 类型：

- 无参函数 → `type name = () => any;`
- 带参时 → 单一参数命名为 `_`，其对象类型内联：`type name = (_: { ... }) => any;`
- 返回类型始终为 `any`。
- 名为 `description` 的属性变为该字段*上一行*的 `//` 注释；JSON Schema 的 `title` 渲染为 `// TITLE` 后跟一个 `//` 空注释行；`examples` 渲染为 `// Examples:` 再加若干 `// - "value"` 行。
- 可选（非 `required`）字段带有尾随的 `?`。`default` 渲染为尾随的 `// default: <value>` 注释；`enum` 变为 `"a" | "b"` 联合类型；`oneOf` 变为多行 `|` 联合类型；JSON 的 `integer` 映射为 TS 的 `number`。
- 各函数定义之间用一个空行分隔；代码块以 `} // namespace functions` 闭合。

如果 developer 消息没有指令文本，则省略 `# Instructions` 标题，消息仅剩 `# Tools` 代码块。定义了任何函数时，system 消息会追加路由行 `Calls to these tools must go to the commentary channel: 'functions'.`

逐字的 developer 消息示例（指令 + 两个函数），与渲染器输出的完全一致：

```text
<|start|>developer<|message|># Instructions

Use a friendly tone.

# Tools

## functions

namespace functions {

// Gets the location of the user.
type get_location = () => any;

// Gets the current weather in the provided location.
type get_current_weather = (_: {
// The city and state, e.g. San Francisco, CA
location: string,
format?: "celsius" | "fahrenheit", // default: celsius
}) => any;

// Gets the current weather in the provided list of locations.
type get_multiple_weathers = (_: {
// List of city and state, e.g. ["San Francisco, CA", "New York, NY"]
locations: string[],
format?: "celsius" | "fahrenheit", // default: celsius
}) => any;

} // namespace functions<|end|>
```

## 工具调用格式

函数调用是 **commentary** 通道上的一条 **assistant** 消息，通过收件人 `to=functions.<name>` 寻址到该工具，正文为 JSON 参数，以 `<|call|>` 停止词元结束。

收件人可出现在头部的 *role 段* 或 *channel 段* —— 两种形式都是合法的 Harmony，解析器都接受。模型通常在 channel 段中发出。pi 渲染器省略可选的内容类型标记：

```text
<|start|>assistant<|channel|>commentary to=functions.get_current_weather<|message|>{"location":"San Francisco, CA"}<|call|>
```

某些 Harmony 序列化器会包含显式的 JSON 内容类型，并将收件人放到 role 段中：

```text
<|start|>assistant to=functions.get_current_weather<|channel|>commentary <|constrain|>json<|message|>{"location":"San Francisco, CA"}<|call|>
```

参数正文是原始 JSON 对象。可选的 `<|constrain|>json` 内容类型用以指示 JSON（也是受限解码/基于文法的解码的钩子）；内容类型也可以是裸词，如 `code`（在使用内置工具时可见）。内置工具仅在通道和收件人上有所区别：它们通常在 `analysis` 上渲染，收件人分别为 `browser.search` / `browser.open` / `browser.find`，或始终为 `python`。

### OMP `harmony` 方言行为

OMP 输出上述第一种形式：不带 `<|constrain|>` 标记、收件人位于 channel 段、参数为紧凑 JSON。它在收到时合成一个调用 id，因为 Harmony 不携带 id。有状态的扫描器接受两个头部段中的任一位置出现的收件人，去除暴露的工具名称前的 `functions.`，并将除 `assistant` 之外的任何非空收件人视为工具调用（包括 `browser.search` 等内置工具）。

参数会持续累积，直到遇到 `<|call|>`、`<|end|>` 或 `<|return|>`，然后通过 JSON 修复进行解析。空参数、或经修复后仍无法解析的输入，会成为 `{}` 而非扫描器错误。扫描器在头部完成时发出 `toolStart`，仅在消息终止符处发出 `toolEnd`；`analysis` 正文块以思考增量的形式流式输出，而普通的助手 `commentary`/`final` 正文以文本形式流式输出。非助手消息（包括工具结果封装）会被此输出扫描器跳过。

与规范 Harmony 不同，有一个重要的自有扫描器边界情况需要留意。当携带收件人的头部到达 `<|message|>` 时，OMP 已经发出了 `toolStart`。如果普通流式路径已排空正文字节，而流随后在没有 `<|call|>`、`<|end|>` 或 `<|return|>` 的情况下结束，`flush()` 不会发出 `toolEnd`，也不会撤回先前的 start。Harmony 扫描器不发出参数增量，因此即使出现过未终止的正文文本，被保留的规范调用仍然具有 `{}`。在正常的停止时，OMP 会将该轮次改为 `toolUse`，并可能派发该空调用。这是一种宽松且不安全的恢复行为，并非合法的 Harmony 终止符规则。

## 多次 / 并行工具调用

Harmony 没有专门的"并行"包装。多次调用只是多条连续的消息。模型可以先发出一段可选的**序言** —— 一条位于 `commentary` 通道上的*用户可见*助手消息（与 `analysis` 不同，这部分应当展示给用户） —— 然后对每个函数各发一条工具调用消息。每次单独的调用仍以各自的 `<|call|>` 停止词元结束，因此一个在 `<|call|>` 处停止的宿主可以一次收集一条调用、执行后回传结果、再继续：

```text
<|channel|>analysis<|message|>{reasoning}<|end|><|start|>assistant<|channel|>commentary<|message|>**Action plan**:
1. Generate an HTML file
2. Generate a JavaScript for the Node.js server
3. Start the server
---
Will start executing the plan step by step<|end|><|start|>assistant<|channel|>commentary to=functions.generate_file<|message|>{"template": "basic_html", "path": "index.html"}<|call|>
```

## 工具结果格式

已执行工具的输出以一条消息回传，该消息的**作者/角色即为工具的名称**，以 `to=assistant` 回指助手，位于 **commentary** 通道，以 `<|end|>` 结尾。这是规范（推荐）形式：

```text
<|start|>functions.get_current_weather to=assistant<|channel|>commentary<|message|>{"sunny": true, "temperature": 20}<|end|>
```

头部顺序为 `{toolname} to=assistant<|channel|>commentary`。内置工具的结果遵循相同形态（如 `<|start|>browser.search to=assistant<|channel|>commentary<|message|>{"result": "https://openai.com/"}<|end|>`）。当消息未设置通道/收件人时，渲染器接受的最小形式仅为 `<|start|>{toolname}<|message|>{output}<|end|>`，但发出完整的 `to=assistant<|channel|>commentary` 头部是参考解析器可往返处理的，也是推荐形式。追加结果后，通过发出下一个 `<|start|>assistant` 重启生成。

OMP 始终渲染上面展示的完整规范结果头部，并原样传递 `result.text`。Harmony 没有专门的错误位，因此 `isError` 不会被单独表示；失败必须在结果负载中描述。

## 端到端示例

完整的多轮天气对话：系统 + 开发者提示 → 用户提问 → 助手 analysis CoT → 助手 commentary 工具调用 → 工具结果 → 助手最终答复。这是一段连续的词元流（头部内的换行仅出于可读性、出现在顶层消息之间；实际中各消息之间不带分隔符地拼接在一起）。

```text
<|start|>system<|message|>You are ChatGPT, a large language model trained by OpenAI.
Knowledge cutoff: 2024-06
Current date: 2025-06-28

Reasoning: high

# Valid channels: analysis, commentary, final. Channel must be included for every message.
Calls to these tools must go to the commentary channel: 'functions'.<|end|><|start|>developer<|message|># Instructions

Use a friendly tone.

# Tools

## functions

namespace functions {

// Gets the current weather in the provided location.
type get_current_weather = (_: {
// The city and state, e.g. San Francisco, CA
location: string,
format?: "celsius" | "fahrenheit", // default: celsius
}) => any;

} // namespace functions<|end|><|start|>user<|message|>What is the weather like in SF?<|end|><|start|>assistant<|channel|>analysis<|message|>User wants the weather in San Francisco. Use get_current_weather.<|end|><|start|>assistant<|channel|>commentary to=functions.get_current_weather<|message|>{"location":"San Francisco, CA"}<|call|><|start|>functions.get_current_weather to=assistant<|channel|>commentary<|message|>{"sunny": true, "temperature": 20}<|end|><|start|>assistant<|channel|>final<|message|>It's sunny and about 20°C in San Francisco right now.<|return|>
```

轮次边界：

- 宿主在 `<|call|>` 处停止生成，解析 `commentary` 调用，运行 `get_current_weather`，并追加 `functions.get_current_weather to=assistant` 结果消息。
- 然后追加 `<|start|>assistant` 并继续。先前的 `analysis` 消息被保留（该轮以工具调用而非 `final` 结束），以便模型能继续其推理。
- 生成在 `<|return|>` 处停止。当此轮次被持久化到历史中用于*之后*的轮次时，将尾部的 `<|return|>` 归一化为 `<|end|>`（见下一条说明）。

**`<|return|>` 归一化。** `<|return|>` 仅是解码时的停止词元。当你将助手的回复存入历史以供下一轮使用时，请将尾部的 `<|return|>` 替换为 `<|end|>`，使每条存储的消息都成为良构的 `<|start|>{header}<|message|>{content}<|end|>`。（对于监督训练目标，以 `<|return|>` 结束示例是正确的。）

## 兼容 OpenAI 的 API 映射

当服务器（vLLM/SGLang/Ollama）将 Harmony 桥接到 Chat Completions JSON 时：

- **`finish_reason`**：在 `<|call|>` 处停止生成时为 `tool_calls`；在 `<|return|>` 处停止时为 `stop`。
- **`message.tool_calls[]`**：每条 `commentary` `to=functions.*` 调用对应一个条目。`function.name` 为去掉 `functions.` 命名空间前缀的收件人（即 `get_current_weather`）。`function.arguments` 是**JSON 字符串**（即逐字的 `<|message|>` 正文），与 OpenAI 语义一致 —— 而非已解析对象。
- **`tool_call_id`**：Harmony 没有原生调用 ID。服务器会合成一个（如 `call_abc123`），并负责将后续的 `role:"tool"` 消息关联回 Harmony 工具结果封装（收件人 `to=functions.<name>` / 调用顺序）。
- **工具结果消息**（`{"role":"tool","tool_call_id":...,"content":...}`）被渲染为 `<|start|>{toolname} to=assistant<|channel|>commentary<|message|>{content}<|end|>`。服务器将 `tool_call_id` 映射到原始函数名以构建 `{toolname}` 作者。
- **推理**：`analysis` 通道文本作为 `reasoning_content`（vLLM/SGLang）或 `reasoning`/`thinking` 字段呈现，通常在后续请求中不回显。`final` 通道文本是正常的 `message.content`。`commentary` 序言若被呈现，也映射到助手内容。
- **OMP 脚本渲染：** `developer`、`user` 和其他非助手角色直接映射到 Harmony 封装。助手消息按顺序发出：先一条完整的 `analysis` 消息表示思考，再一条完整的 `final` 消息表示可见文本，然后每个工具调用各一条 `commentary` 调用消息。因此与工具调用一同出现的可见文本被渲染为 `final`，而非 commentary 序言。工具结果运行变成连续的多条规范工具作者封装。
- **原生服务器/聊天模板编译：**在原生 vLLM/SGLang 路径上，请求中的 `tools` / `tool_choice` 由服务器的聊天模板编译到 developer 消息的 `namespace functions { ... }` 块中；系统消息会获得 commentary 路由行。
- **OMP 自有方言宣告：**当选择 OMP 的 `harmony` 方言时，OMP 移除原生 provider 工具，并向系统提示追加其通用的紧凑型 `<tools>` JSON 目录与 Harmony 格式指南。该路径不使用规范的 developer 消息命名空间作为工具宣告。

## 解析注意事项与陷阱

- **两个停止词元。** 始终同时在 `<|return|>` 和 `<|call|>` 处停止。仅在 `<|return|>` 处停止会越过工具调用继续生成；仅在 `<|end|>` 处停止对助手生成而言是错误的。
- **收件人位置不固定。** `to=functions.<name>` 可能位于 role 段（`<|start|>assistant to=...<|channel|>commentary`）或 channel 段（`<|channel|>commentary to=...`）。解析器必须两者都接受。
- **通道为必填项**，对助手消息而言；系统消息甚至会提醒模型（"Channel must be included for every message."）。缺失通道的输出是非法的。
- **工具作者，而非 `tool`。** 工具结果消息的角色是工具的*名称*（`functions.get_current_weather`），而不是字面字符串 `tool`。将 `functions.x` 拆分为命名空间和函数是解析器的职责。
- **CoT 丢弃是有条件的。** 仅在上一轮助手消息以 `final` 结束时才丢弃 `analysis`。丢弃紧接 `<|call|>` 之前的 `analysis` 会破坏多步工具推理。
- **`arguments` 是字符串。** 不要进行双重编码。`<|message|>` 之后的主体已经是序列化好的 JSON；应原样作为 `arguments` 字符串传递。
- **内容类型变体。** `<|constrain|>json` 是可选的。若存在，它只是元数据，并不保证 JSON 有效。通过受限解码/你自己的文法来强制 JSON 有效性 —— 仅提示格式本身不能保证 schema 遵从（同样的注意事项也适用于结构化输出的 `# Response Formats`）。
- **流式解析。** 使用有状态解析器（该库提供 `StreamableParser`），以便增量地重建不完整的 UTF-8 以及头部/通道/收件人/内容类型字段；朴素的子串扫描无法正确处理多字节切分和可选的头部字段。`parse_messages_from_completion_tokens` 接受 `strict=True|False` —— `strict=False` 可容忍某些畸形的头部。不要将尾部的停止词元传入解析器。
- **编码。** 使用 `o200k_harmony`（即 `o200k_base` 的 rank 加上上述 Harmony 特殊词元）。在编码和解码两侧都将 `<|...|>` 词元视为原子的特殊词元；将它们作为普通文本进行编码会产生不同的 rank 并破坏流。

## 参考资料

- OpenAI Cookbook —— OpenAI harmony 响应格式：https://cookbook.openai.com/articles/openai-harmony
- openai/harmony 渲染器（README）：https://github.com/openai/harmony
- openai/harmony 规范格式指南：https://raw.githubusercontent.com/openai/harmony/main/docs/format.md
- openai/harmony 特殊词元注册表（`o200k_harmony` ID）：https://raw.githubusercontent.com/openai/harmony/main/src/tiktoken_ext/public_encodings.rs
- openai/harmony 渲染器/解析器测试与 schema→TS 逻辑：https://raw.githubusercontent.com/openai/harmony/main/src/tests.rs , https://raw.githubusercontent.com/openai/harmony/main/src/encoding.rs
- openai/harmony 测试数据（逐字渲染的流）：`test-data/test_render_functions_with_parameters.txt`、`test-data/test_does_not_drop_if_ongoing_analysis.txt`、`test-data/test_tool_response_parsing.txt`、`test-data/test_streamable_parser.txt`、`test-data/test_browser_and_function_tool.txt`（https://github.com/openai/harmony/tree/main/test-data）
- vLLM 工具调用 / gpt-oss 解析器标志：https://docs.vllm.ai/en/latest/features/tool_calling/
- SGLang gpt-oss 用法（`--tool-call-parser gpt-oss`）：https://docs.sglang.io/basic_usage/gpt_oss.html