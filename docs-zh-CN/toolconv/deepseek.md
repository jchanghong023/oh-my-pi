# DeepSeek 工具调用线协议格式

DeepSeek 的对话模型（DeepSeek-V3、V3-0324、R1、R1-0528 以及 DeepSeek-V3.1）共享同一套
分词器族，并使用由**全角竖线**特殊 token 构成的独特外壳，例如
`<｜begin▁of▁sentence｜>` 和 `<｜User｜>`。工具调用通过一段专用特殊 token
（`<｜tool▁calls▁begin｜>` … `<｜tool▁calls▁end｜>`）输出，而不是文本内嵌 JSON 或 XML。
本文以 **DeepSeek-V3.1**（当前的思考/非思考混合模型）为中心，并将较早的
**DeepSeek-V3-0324** 和 **DeepSeek-R1-0528** 格式作为显式的版本差异来记录，因为它们在
线协议上的工具语法与 V3.1 *并不*相同。

推理服务器通过聊天模板加工具调用解析器来启用它：

- vLLM V3.1：`--enable-auto-tool-choice --tool-call-parser deepseek_v31 --chat-template examples/tool_chat_template_deepseekv31.jinja`（可选 `--reasoning-parser deepseek_r1`）。
- vLLM V3-0324 / R1-0528：`--enable-auto-tool-choice --tool-call-parser deepseek_v3 --chat-template examples/tool_chat_template_deepseekv3.jinja`（V3-0324）或 `tool_chat_template_deepseekr1.jinja`（R1-0528）。
- 模型自带的 `tokenizer_config.json` 中的 `chat_template`（以及完全相同的 `assets/chat_template.jinja`）会渲染 V3.1 的外壳、工具调用和工具输出；但它**不会**合成 `## Tools` 声明块，因此 vLLM 提供了一个会合成该块的模板（见下文）。

> 已对照以下来源验证：DeepSeek-V3.1 模型卡中 “Chat Template” / “ToolCall” 章节；
> `tokenizer_config.json` 与 `assets/chat_template.jinja` 中逐字节相同的 `chat_template`；
> `tokenizer.json` 中的 `added_tokens`（token ID）；`config.json`（bos/eos ID）；
> DeepSeek-V3-0324 和 DeepSeek-R1-0528 的 `tokenizer_config.json` 聊天模板；vLLM 的
> `tool_chat_template_deepseekv31.jinja`；以及 vLLM 工具调用 / 推理输出文档。

## 关于不寻常 Unicode 的说明（请勿替换为 ASCII）

DeepSeek 的标记**并不**使用 ASCII 竖线 `|`（U+007C）或 ASCII 下划线
`_`。它们使用的是：

- `｜` — **U+FF5C FULLWIDTH VERTICAL LINE（全角竖线）**，作为尖括号内紧邻的分隔符。
- `▁` — **U+2581 LOWER ONE EIGHTH BLOCK（八分之一低块）**（SentencePiece 词边界字形），
  作为 token *词与词之间*的分隔符，例如 `begin▁of▁sentence`、`tool▁calls▁begin`。

因此 `<｜tool▁calls▁begin｜>` 即 `<` + `｜`（FF5C）+ `tool` + `▁`（2581）+ `calls` + `▁`（2581）
+ `begin` + `｜`（FF5C）+ `>`。如果将这些 token 复制为 `<|tool_calls_begin|>`（ASCII 竖线 +
下划线），模型将得到它从未训练过的 token，并会在解析与生成时静默失败。唯一使用 ASCII
尖括号的 DeepSeek 标记是思考标签 `<think>` / `</think>`（使用纯 `<`、`/`、`>`）和极少
使用的 `<|EOT|>`（使用 ASCII 竖线）。

## 特殊 token

token ID 取自 DeepSeek-V3.1 的 `tokenizer.json`（`added_tokens`）；`vocab_size` 为 129280。
`special` 列反映分词器的 `"special"` 标志（它控制 `skip_special_tokens`）；请注意角色
/思考/工具标记的 `special` 为 `false`。

| Token（逐字） | ID | `special` | 用途 |
| --- | --- | --- | --- |
| `<｜begin▁of▁sentence｜>` | 0 | true | BOS；在提示最开头仅添加一次。 |
| `<｜end▁of▁sentence｜>` | 1 | true | EOS；结束每个助手/工具轮次，并作为停止 token。 |
| `<｜▁pad▁｜>` | 2 | true | 填充（`pad_token`；模型卡/config 也将 EOS 复用作 pad）。 |
| `<｜search▁begin｜>` | 128796 | false | 搜索代理查询开始（思考模式搜索工具）。 |
| `<｜search▁end｜>` | 128797 | false | 搜索代理查询结束。 |
| `<think>` | 128798 | false | 打开推理/思考片段。使用 ASCII 尖括号。 |
| `</think>` | 128799 | false | 关闭推理片段；**在非思考模式中也会输出**（见下文）。 |
| `<｜fim▁hole｜>` / `<｜fim▁begin｜>` / `<｜fim▁end｜>` | 128800–128802 | false | 填充中间（不是聊天）。 |
| `<｜User｜>` | 128803 | false | 用户角色标记。 |
| `<｜Assistant｜>` | 128804 | false | 助手角色标记。 |
| `<\|EOT\|>` | 128805 | true | 轮次结束（旧式；使用 ASCII 竖线，聊天中很少使用）。 |
| `<｜tool▁calls▁begin｜>` | 128806 | false | 打开助手的一批工具调用。 |
| `<｜tool▁calls▁end｜>` | 128807 | false | 关闭一批工具调用。 |
| `<｜tool▁call▁begin｜>` | 128808 | false | 打开批次中的单个工具调用。 |
| `<｜tool▁call▁end｜>` | 128809 | false | 关闭单个工具调用。 |
| `<｜tool▁outputs▁begin｜>` | 128810 | false | 打开一批工具结果（**仅限 R1-0528 / V3-0324**）。 |
| `<｜tool▁outputs▁end｜>` | 128811 | false | 关闭一批工具结果（**仅限 R1-0528 / V3-0324**）。 |
| `<｜tool▁output▁begin｜>` | 128812 | false | 打开单个工具结果。 |
| `<｜tool▁output▁end｜>` | 128813 | false | 关闭单个工具结果。 |
| `<｜tool▁sep｜>` | 128814 | false | 工具调用内的分隔符（位于名称和参数之间）。 |

`config.json` 确认 `bos_token_id: 0`，`eos_token_id: 1`。

## 角色 / 通道 / 轮次结构

没有 OpenAI 风格的 `system`/`developer` 通道 token。角色以内联标记呈现，整个提示是一段扁平的字符串：

```text
<｜begin▁of▁sentence｜>{system_prompt}<｜User｜>{query}<｜Assistant｜>{response}<｜end▁of▁sentence｜>
```

- **系统提示**没有标记。所有 `system` 消息会拼接在一起（若有多个则用 `\n\n` 连接），
  并紧接 `<｜begin▁of▁sentence｜>` 之后、第一个 `<｜User｜>` 之前输出。当存在工具时，
  `## Tools` 块会附加到该系统文本之后（以 `\n\n` 分隔）。
- **用户轮次**：`<｜User｜>` + 内容。（V3.1 中用户文本后无 EOS；助手标记紧跟其后。）
- **助手轮次**：以 `<｜Assistant｜>` 开头，然后是思考标签、内容，最后是
  `<｜end▁of▁sentence｜>`。
- **思考与非思考（V3.1 混合）** —— 由模板选择，而非由模型决定：
  - 非思考生成前缀：`…<｜Assistant｜></think>` —— 模型从一个它从未打开过的
    `</think>` *之后*开始。与 DeepSeek-V3 不同，V3.1 总会注入这个 `</think>`。
  - 思考生成前缀：`…<｜Assistant｜><think>` —— 模型输出其思维链，以 `</think>` 结束，
    然后给出答案。
  - 在多轮上下文中，**每个**存储的助手轮次都会保留 `</think>`；只有最后一轮前导的
    思考标签反映所请求的模式。渲染存储的助手消息时，在重新输出之前，会将
    `content` 中直到并包括 `</think>` 的文本剔除（模板执行 `content.split('</think>', 1)[1]`）。
- **工具调用在非思考模式下运行。**模型卡中说明 “Toolcall is supported in non-thinking mode”，
  V3.1 工具模板以 `<｜Assistant｜></think>` 打开工具调用轮次。在 vLLM 中，V3.1 默认禁用
  推理；可通过 `chat_template_kwargs={"thinking": true}` 启用。
- **搜索代理通道**：一种使用 `<｜search▁begin｜>` / `<｜search▁end｜>` 的独立思考模式协议
  （参见模型卡中的 `assets/search_tool_trajectory.html`）；不在普通函数调用范围内。

## 工具定义

工具以**注入系统区域的 Markdown 块**形式声明（位于系统提示之后、第一个 `<｜User｜>`
之前）。`tokenizer_config.json` 中的聊天模板不会从 `tools=[…]` 参数构建此块；由调用方
（或 vLLM 的 `tool_chat_template_deepseekv31.jinja`）构造。按 DeepSeek-V3.1 模型卡逐字
复现，完整布局为：
`<｜begin▁of▁sentence｜>{system prompt}\n\n{tool_description}<｜User｜>{query}<｜Assistant｜></think>`
其中 `{tool_description}` 为：

```text
## Tools
You have access to the following tools:

### {tool_name1}
Description: {description}

Parameters: {json.dumps(parameters)}

IMPORTANT: ALWAYS adhere to this exact format for tool use:
<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>tool_call_name<｜tool▁sep｜>tool_call_arguments<｜tool▁call▁end｜>{additional_tool_calls}<｜tool▁calls▁end｜>

Where:
- `tool_call_name` must be an exact match to one of the available tools
- `tool_call_arguments` must be valid JSON that strictly follows the tool's Parameters Schema
- For multiple tool calls, chain them directly without separators or spaces
```

每个工具贡献一个 `### {name}` 段，包含一行 `Description:` 和一行 `Parameters: {…}`，
其值是 JSON-Schema 参数对象的紧凑 JSON（模型卡中为 `json.dumps(parameters)`，vLLM 模板中为
`parameters | tojson`）。`IMPORTANT:` 指令块在最后一个工具之后仅追加一次。

## 工具调用格式

模型输出一个包含一个或多个调用的批包装。每个调用形式为
`name <｜tool▁sep｜> arguments`，其中 **arguments 是原始的 JSON 对象字符串**（无代码
围栏）。最小单次调用（模型在 `<｜Assistant｜></think>` 前缀之后生成的内容）：

```text
<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>get_weather<｜tool▁sep｜>{"location": "San Francisco, CA"}<｜tool▁call▁end｜><｜tool▁calls▁end｜>
```

语法（V3.1）：

```text
<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>{name}<｜tool▁sep｜>{json_args}<｜tool▁call▁end｜>{…more calls…}<｜tool▁calls▁end｜>
```

- `{name}` 必须与某个已声明的工具名精确匹配。它位于**最前**，紧跟
  `<｜tool▁call▁begin｜>` 之后。
- `{json_args}` 是符合该工具参数 schema 的有效 JSON，直接内联。
- 之后由模板/服务器用 `<｜end▁of▁sentence｜>` 关闭整个助手轮次。

（V3.1 **没有** `type` 字段，也**没有**包裹参数的 ` ```json ` 围栏 —— 那是较早的
R1/V3-0324 约定；见版本差异一节。）

## 多次 / 并行工具调用

所有调用都位于同一个 `<｜tool▁calls▁begin｜>…<｜tool▁calls▁end｜>` 包装内。在第一个
`<｜tool▁call▁begin｜>…<｜tool▁call▁end｜>` 之后，每个额外的调用都是
**直接相连的另一个 `<｜tool▁call▁begin｜>…<｜tool▁call▁end｜>`，调用之间无分隔符、
换行或空格**（模型卡：“chain them directly without separators or spaces”）：

```text
<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>get_weather<｜tool▁sep｜>{"location": "San Francisco, CA"}<｜tool▁call▁end｜><｜tool▁call▁begin｜>get_weather<｜tool▁sep｜>{"location": "Seattle, WA"}<｜tool▁call▁end｜><｜tool▁calls▁end｜>
```

请注意 `<｜tool▁calls▁begin｜>`（复数，id 128806）仅出现一次；每个调用使用单数形式的
`<｜tool▁call▁begin｜>`（id 128808）/ `<｜tool▁call▁end｜>`（id 128809）。

## 工具结果格式

执行结果以 `tool` 角色的消息回传。在 **V3.1** 中，每个结果都用单数输出 token 包装，
**没有**复数形式的 `<｜tool▁outputs▁…｜>` 包装，紧跟在助手工具调用轮次的
`<｜end▁of▁sentence｜>` 之后：

```text
<｜tool▁output▁begin｜>{result_text}<｜tool▁output▁end｜>
```

`{result_text}` 是原始的工具输出（通常是 JSON 字符串，但可以是任意文本）。对于多个结果，
V3.1 模板对每个 `tool` 消息输出一个 `<｜tool▁output▁begin｜>…<｜tool▁output▁end｜>`，
彼此直接拼接。线协议中**没有工具调用 ID** —— 结果与调用按**位置**匹配
（输出顺序 ↔ 调用顺序）。

然后模型**直接在 `<｜tool▁output▁end｜>` 之后**给出最终答复，没有
`<｜Assistant｜>` 标记，也没有 `</think>`（见解析注意事项 —— V3.1 参考模板特意将
工具后的助手内容渲染为仅 `content<｜end▁of▁sentence｜>`）。

> R1-0528 / V3-0324 不同：结果被包裹在 `<｜tool▁outputs▁begin｜>` …
> `<｜tool▁outputs▁end｜>` 批包装中，每个结果为
> `<｜tool▁output▁begin｜>…<｜tool▁output▁end｜>`，多个结果以换行分隔。

## 端到端示例

一个完整的 DeepSeek-V3.1 **非思考**多轮交互。所有内容是一段扁平字符串；内联的
`←` 注释标出模型生成的起点（它们不属于流的一部分）。`## Tools` 块内的空白是字面
换行。

```text
<｜begin▁of▁sentence｜>You are a helpful assistant.

## Tools
You have access to the following tools:

### get_weather
Description: Get the current weather for a location

Parameters: {"type": "object", "properties": {"location": {"type": "string", "description": "City and state, e.g. San Francisco, CA"}, "unit": {"type": "string", "enum": ["celsius", "fahrenheit"]}}, "required": ["location"]}

IMPORTANT: ALWAYS adhere to this exact format for tool use:
<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>tool_call_name<｜tool▁sep｜>tool_call_arguments<｜tool▁call▁end｜>{additional_tool_calls}<｜tool▁calls▁end｜>

Where:
- `tool_call_name` must be an exact match to one of the available tools
- `tool_call_arguments` must be valid JSON that strictly follows the tool's Parameters Schema
- For multiple tool calls, chain them directly without separators or spaces
<｜User｜>What's the weather in San Francisco?<｜Assistant｜></think><｜tool▁calls▁begin｜><｜tool▁call▁begin｜>get_weather<｜tool▁sep｜>{"location": "San Francisco, CA", "unit": "celsius"}<｜tool▁call▁end｜><｜tool▁calls▁end｜><｜end▁of▁sentence｜><｜tool▁output▁begin｜>{"temperature": 18, "unit": "celsius", "condition": "Foggy"}<｜tool▁output▁end｜>It's currently 18°C and foggy in San Francisco.<｜end▁of▁sentence｜>
```

阅读各段：

1. `<｜begin▁of▁sentence｜>` + 系统文本 + `\n\n` + `## Tools…` 块 —— 提示前缀。
2. `<｜User｜>What's the weather in San Francisco?` —— 用户轮次。
3. `<｜Assistant｜></think>` —— 非思考生成前缀（提示）。**模型从此处开始生成。**
4. `<｜tool▁calls▁begin｜>…<｜tool▁calls▁end｜>` —— 模型发起的工具调用；服务器追加 `<｜end▁of▁sentence｜>` 并以 `finish_reason: "tool_calls"` 停止。
5. `<｜tool▁output▁begin｜>…<｜tool▁output▁end｜>` —— 你执行得到的结果，追加到提示中。
6. `It's currently 18°C and foggy in San Francisco.<｜end▁of▁sentence｜>` —— **模型在工具输出后直接给出最终答复**（没有新的 `<｜Assistant｜>` 标记），以 EOS 结束。

## OpenAI 兼容 API 映射

当由 OpenAI 兼容服务器前置时（例如 vLLM 使用 `--tool-call-parser
deepseek_v31`）：

- **`finish_reason`**：模型输出一批 `<｜tool▁calls▁begin｜>…` 时为 `"tool_calls"`；
  否则为 `"stop"`。
- **`message.tool_calls[]`**：每个 `<｜tool▁call▁begin｜>…<｜tool▁call▁end｜>` 对应一个元素。
  - `.type` = `"function"`。
  - `.function.name` = `<｜tool▁call▁begin｜>` 与 `<｜tool▁sep｜>` 之间的文本。
  - `.function.arguments` = `<｜tool▁sep｜>` 与 `<｜tool▁call▁end｜>` 之间的文本，
    以 **JSON 字符串**形式返回（遵循 OpenAI 规范），而不是嵌套对象。模型本身就在那里
    输出原始 JSON，因此直接透传。
  - `.id` = **由服务器合成**（例如 `chatcmpl-tool-…`）。DeepSeek 的线协议不携带调用 ID。
- **工具结果消息**：`{"role": "tool", "tool_call_id": "<id>", "content": "<result>"}`。
  服务器将 `content` 渲染为 `<｜tool▁output▁begin｜>…<｜tool▁output▁end｜>`。由于提示中
  没有 ID，`tool_call_id` 仅用于客户端簿记；**模型依赖顺序**，因此请保持结果相对于
  调用的顺序不变。
- **助手回放**：当你将先前的助手轮次连同 `tool_calls` 一同发回时，模板会内联
  `function.arguments`。HF 参考模板将其**逐字**内联（假定它已经是 JSON 字符串）；
  vLLM 的 `tool_chat_template_deepseekv31.jinja` 则通过 `| tojson` 处理。按 OpenAI 规范
  以 JSON **字符串**形式发送 `arguments`（见下文关于双重编码的注意事项）。

## 解析注意事项与坑

- **Unicode 是承重的。**必须精确匹配 `｜` = U+FF5C 和 `▁` = U+2581。ASCII
  `<|tool_calls_begin|>` 不会切分到特殊 token。`<think>`/`</think>` 使用 ASCII 尖括号；
  罕见的 `<|EOT|>` 使用 ASCII 竖线。
- **工具/角色标记的 `special` 为 `false`。**只有 `<｜begin▁of▁sentence｜>`、
  `<｜end▁of▁sentence｜>`、`<｜▁pad▁｜>` 和 `<|EOT|>` 被标记为 `special: true`。因此
  以 `skip_special_tokens=True` 解码时**不会**剔除 `<｜tool▁calls▁begin｜>`、
  `<｜tool▁sep｜>`、`<｜Assistant｜>`、`</think>` 等 —— 它们仍会留在解码后的字符串中
  供解析器查找。（反之，不要假设特殊 token 过滤会移除它们。）
- **V3.1 没有代码围栏 / 没有 `type` 字段。**为 R1/V3-0324 编写的解析器
  （`function<｜tool▁sep｜>name` + ` ```json ` 块）无法解析 V3.1，反之亦然。
  V3.1 是 `name<｜tool▁sep｜>raw_json`。
- **V3.1 的调用链没有分隔符。**调用之间紧邻：
  `…<｜tool▁call▁end｜><｜tool▁call▁begin｜>…`。不要按换行/空白拆分；按
  `<｜tool▁call▁begin｜>` / `<｜tool▁call▁end｜>` 边界拆分。（R1/V3-0324 在每个
  后续调用前放一个 `\n`。）
- **线协议中没有工具调用 ID。**按位置匹配结果与调用。服务器必须为 OpenAI 形态生成
  合成的 `tool_call_id`。
- **`</think>` 即便在非思考模式也会出现。**在将剩余部分视作可见答复之前，需剔除
  前导的 `</think>`（以及之前的所有推理）；模板在重放存储的轮次时执行
  `content.split('</think>', 1)[1]`。
- **工具后生成提示的怪癖。**V3.1 参考聊天模板仅在**最后一条消息是 `user` 时**追加
  `<｜Assistant｜></think>` 生成前缀。在 `tool` 消息之后它不会追加任何内容，模型
  直接在 `<｜tool▁output▁end｜>` 之后继续。以工具结果结尾的对话被智能体循环重新套用
  模板时，不要期望（也不要重复插入）助手标记。
- **`arguments` 双重编码风险。**回放时，vLLM 的示例模板会应用
  `arguments | tojson`。如果 `arguments` 已经是 JSON 字符串（OpenAI 约定），该管道
  将再次对其进行 JSON 编码（用引号包裹并转义）。在模板期望 `| tojson` 的地方传入
  对象，或者在模板逐字内联的地方传入字符串 —— 匹配你实际运行的模板。
- **流式。**工具调用逐 token 到达；名称只有在 `<｜tool▁sep｜>` 处才完整，参数在
  `<｜tool▁call▁end｜>` 之前都是部分 JSON。按调用边界进行缓冲；在调用闭合 token
  之前不要尝试对参数执行 `json.loads`。
- **格式错误的输出。**当 `tool_choice="auto"` 且无结构化标签约束
  （`VLLM_ENFORCE_STRICT_TOOL_CALLING=false`）时，模型可能在
  `tool_call_arguments` 中输出无效 JSON，或输出与任何工具都不匹配的 `tool_call_name`；
  解析器会尽力提取。命名/`required` 工具选择使用结构化输出后端，保证参数符合 schema。

## 版本差异：V3.1 与 V3-0324 / R1-0528

V3.1 之前的模型（DeepSeek-V3-0324 和 DeepSeek-R1-0528）共享一种更早的工具调用编码，
在 vLLM 中以 `--tool-call-parser deepseek_v3` 提供服务。每次调用的主体为：

````text
<｜tool▁call▁begin｜>function<｜tool▁sep｜>{name}
```json
{json_args}
```<｜tool▁call▁end｜>
````

与 V3.1 的差异：

| 方面 | V3.1（`deepseek_v31`） | V3-0324 / R1-0528（`deepseek_v3`） |
| --- | --- | --- |
| 调用中的字段顺序 | `{name}<｜tool▁sep｜>{args}` | `function<｜tool▁sep｜>{name}`（字面量 `type`，然后是 name） |
| 参数包装方式 | 原始 JSON，内联 | 用 ` ```json … ``` ` 围栏包裹（名称和参数以 `\n` 分隔） |
| 调用的串联 | 紧邻，**无分隔符** | 每个后续调用以 `\n` 前缀 |
| 工具结果 | 每个消息一个 `<｜tool▁output▁begin｜>…<｜tool▁output▁end｜>`，无批包装 | 包裹于 `<｜tool▁outputs▁begin｜>…<｜tool▁outputs▁end｜>` 之中，结果以换行分隔 |
| 用户→助手边界 | 用户轮次 = `<｜User｜>{q}`；`<｜Assistant｜></think>` 在生成时添加 | 用户轮次 = `<｜User｜>{q}<｜Assistant｜>`（助手标记在用户分支追加） |
| 思考 | 混合；`thinking` kwarg 切换 `<think>` 与 `</think>` 前缀 | R1-0528 始终推理（裸 `<｜Assistant｜>` 生成前缀，模型自行打开 `<think>`）；V3-0324 不推理 |
| vLLM 解析器 | `--tool-call-parser deepseek_v31` | `--tool-call-parser deepseek_v3` |

R1-0528 / V3-0324 的并行调用及其结果批示例：

````text
<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function<｜tool▁sep｜>get_weather
```json
{"location": "San Francisco, CA"}
```<｜tool▁call▁end｜>
<｜tool▁call▁begin｜>function<｜tool▁sep｜>get_weather
```json
{"location": "Seattle, WA"}
```<｜tool▁call▁end｜><｜tool▁calls▁end｜><｜end▁of▁sentence｜><｜tool▁outputs▁begin｜><｜tool▁output▁begin｜>{"temperature": 18}<｜tool▁output▁end｜>
<｜tool▁output▁begin｜>{"temperature": 14}<｜tool▁output▁end｜><｜tool▁outputs▁end｜>
````

`deepseek_r1` **推理**解析器（`--reasoning-parser deepseek_r1`）适用于 R1 系列**以及**
DeepSeek-V3.1；它会将 `<think>…</think>` 片段抽取到响应的 `reasoning` 字段中。它独立于
工具调用解析器。

## DSML 外壳（较新的 DeepSeek 模型）

较新的 DeepSeek 模型（例如 `deepseek-v4-pro`）以第二种 XML 风格的外壳 —— **DSML** ——
输出工具调用，而非 `<｜tool▁calls▁begin｜>` 特殊 token 序列。标签名复用相同的全角竖线
（`｜`，U+FF5C），但主体是 Anthropic 风格的 `invoke` / `parameter` 块，而不是
`name<｜tool▁sep｜>{json}` 对：

```text
<｜DSML｜tool_calls>
<｜DSML｜invoke name="get_weather">
<｜DSML｜parameter name="location" string="true">San Francisco, CA</｜DSML｜parameter>
</｜DSML｜invoke>
</｜DSML｜tool_calls>
```

- 一个 `<｜DSML｜tool_calls>…</｜DSML｜tool_calls>` 包装包含一个或多个
  `<｜DSML｜invoke name="…">…</｜DSML｜invoke>` 调用；标签之间的空白无意义。
- 每个参数是一个 `<｜DSML｜parameter name="…" string="…">value</｜DSML｜parameter>`。
  `string` 默认为 `"true"`（值作为原始字符串保留）；`string="false"` 将值解析为 JSON，
  因此 `…string="false">15</…>` 解码为数字 `15`。
- 在线上同时存在 ASCII 竖线变体（`<|DSML|tool_calls>`、`<|DSML|invoke …>`、
  `<|DSML|parameter …>`）与全角形式。
- 多个 OpenAI 兼容主机（DeepSeek 自家 API、NanoGPT、NVIDIA、Ollama / Ollama Cloud、
  Fireworks、OpenRouter、OpenCode）会将此外壳泄漏到可见的 `content` 中，而不是返回
  结构化的 `tool_calls`；解析器必须将其还原为工具调用，并将这些标记从用户可见文本中
  剔除。

## omp / pi 转换器行为

仓库中的 `deepseek` 方言是一个**自有的带内转换器**，而非 vLLM 解析器的包装。
通过 `PI_DIALECT=deepseek`（或等价的 agent 配置）来选用。当存在工具时，agent 会将
方言指南和精简的工具目录追加到系统提示中，从请求中移除原生的 provider 工具，
按本语法重新编码先前的调用/结果，并将流式助手文本扫描回规范的 pi 工具调用事件。

当前的扫描器接受上述全部三种形式：

- V3.1 的 `name<｜tool▁sep｜>{json}` 调用；
- 旧式的 `function<｜tool▁sep｜>name` 加一个 JSON 围栏主体；以及
- 全角或 ASCII 的 DSML `invoke` / `parameter` 块。

对于 V3.1 和旧式调用，omp 在头部完成后发出 `toolStart`，但会将参数缓冲至
`<｜tool▁call▁end｜>`；然后使用共享的修复型 JSON 解析器。缺失/无效的完整参数对象会
变成 `{}`。Flush 不会为未完成的调用发出 `toolEnd`，只会清除扫描器的私有状态。
不过一旦 `toolStart` 已被投影，规范调用即已存在，正常停止的轮次可能会派发它：
未完成的 V3.1/旧式调用保留 `{}`，而 DSML 调用保留已通过 `toolArgDelta` 发布的任何
参数文本。DSML 是真正增量的：参数主体文本作为这些 delta 进行流式发送。除非
`string="false"`，DSML 参数为原始字符串；后者在完整闭合时通过修复型 JSON 解码，
解码失败时回退为原始文本。无 ID 的 DeepSeek 形式的调用 ID 合成形式为 `ptc_…`。

扫描器还会从可见文本中剔除泄漏的 DeepSeek 聊天模板控制 token，并默认将
`<think>…</think>` 映射为思考事件。其渲染器发出 V3.1 调用，不加分隔符地连接并行
调用，并将多个结果渲染为以换行分隔的单数输出块。DSML 语法被接受用于修复泄漏的
provider 输出，但它并非自有方言所发出的历史格式。

## 来源

- DeepSeek-V3.1 模型卡（Chat Template / ToolCall 章节）：<https://huggingface.co/deepseek-ai/DeepSeek-V3.1>
- DeepSeek-V3.1 `assets/chat_template.jinja`：<https://huggingface.co/deepseek-ai/DeepSeek-V3.1/resolve/main/assets/chat_template.jinja>
- DeepSeek-V3.1 `tokenizer_config.json`（`chat_template`，与 jinja 逐字节相同）：<https://huggingface.co/deepseek-ai/DeepSeek-V3.1/resolve/main/tokenizer_config.json>
- DeepSeek-V3.1 `tokenizer.json`（`added_tokens` → token ID 与 `special` 标志）：<https://huggingface.co/deepseek-ai/DeepSeek-V3.1/resolve/main/tokenizer.json>
- DeepSeek-V3.1 `config.json`（`bos_token_id`、`eos_token_id`、`vocab_size`）：<https://huggingface.co/deepseek-ai/DeepSeek-V3.1/resolve/main/config.json>
- DeepSeek-R1-0528 模型卡及 `tokenizer_config.json`（旧工具格式）：<https://huggingface.co/deepseek-ai/DeepSeek-R1-0528> · <https://huggingface.co/deepseek-ai/DeepSeek-R1-0528/resolve/main/tokenizer_config.json>
- DeepSeek-R1 模型卡：<https://huggingface.co/deepseek-ai/DeepSeek-R1>
- DeepSeek-V3-0324 `tokenizer_config.json`（旧工具格式）：<https://huggingface.co/deepseek-ai/DeepSeek-V3-0324/resolve/main/tokenizer_config.json>
- vLLM V3.1 工具调用模板（`## Tools` 注入 + `| tojson`）：<https://github.com/vllm-project/vllm/blob/main/examples/tool_chat_template_deepseekv31.jinja>
- vLLM 工具调用文档（`deepseek_v3`、`deepseek_v31` 解析器标志）：<https://docs.vllm.ai/en/latest/features/tool_calling/>
- vLLM 推理输出文档（`deepseek_r1` 推理解析器；V3.1 思考默认）：<https://docs.vllm.ai/en/latest/features/reasoning_outputs/>
