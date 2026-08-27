# GLM-4.5 / GLM-4.6 工具调用格式

智谱 AI / Z.ai **GLM-4.5** 系列（`zai-org/GLM-4.5` 355B-A32B 与 `zai-org/GLM-4.5-Air` 106B-A12B，`model_type: "glm4_moe"`）原生工具调用约定，**GLM-4.6** 字节级共享。与大多数系列使用的"标签内 JSON"约定不同，GLM 将每次工具调用作为一个 **类 XML** 块发出：`<tool_call>{name}` 后接交替出现的 `<arg_key>`/`<arg_value>` 元素对，以 `</tool_call>` 收尾。提示词是 GLM 风格的序列，以 `[gMASK]<sop>` 开头，使用 `<|system|>`、`<|user|>`、`<|assistant|>`、`<|observation|>` 作为回合标记。推理服务器通过工具解析器与推理解析器将原始流转换为 OpenAI 风格的 `tool_calls`：vLLM 和 SGLang 均提供 `--tool-call-parser glm45 --reasoning-parser glm45`（vLLM addition…

本文档已对照 HF 仓库中权威的 `chat_template.jinja`（原始抓取并**在本地用 Jinja2 渲染** —— `trim_blocks=True, lstrip_blocks=True`，transformers 的 `tojson` 过滤器 —— 以生成下面字节精确的流）、用于精确 token ID 与停止 token 的 `tokenizer_config.json` 与 `generation_config.json`、模型卡，以及 vLLM（`Glm4MoeModelToolParser`）与 SGLang（`Glm4MoeDetector`）解析器源码进行验证。HF 的 `resolve`/`blob` 网页路径会重定向到模型卡 API；字节精确源码通过 `resolve/main/...:raw` 缓存获取（模板提交 `cbb2c7cfb52fa128a9660cb1a7a78e017899e115`）。GLM-4.5 与 GLM-4.6 的 `chat_template.jinja` 完全相同（内容哈希同为 `41478957…`）。

## 特殊 token

Token ID 来自 `tokenizer_config.json`（`added_tokens_decoder`）。注意区分：回合/角色标记注册为 **special** token，而结构性的工具调用与思考标签各为一个专用词表 token，但被标记为 **`special: false`**（作为普通文本发出/打印，而非作为控制 token 被剥离）。

| Token（原文） | ID | `special` | 用途 |
|---|---|---|---|
| `[gMASK]` | 151331 | true | GLM 前缀 / 空填充哨兵；每个提示词的第一个 token |
| `<sop>` | 151333 | true | "Start of piece" — 紧跟在 `[gMASK]` 之后以开启序列 |
| `<eop>` | 151334 | true | "End of piece"（聊天模板不会发出） |
| `<\|system\|>` | 151335 | true | 开启系统回合（以及注入的 tools 回合） |
| `<\|user\|>` | 151336 | true | 开启用户回合（同时是 EOS id —— 见下文） |
| `<\|assistant\|>` | 151337 | true | 开启助手回合 / 生成提示 |
| `<\|observation\|>` | 151338 | true | 开启工具结果（observation）回合（同时是 EOS id） |
| `<\|endoftext\|>` | 151329 | true | 文本结束；`eos_token` 与 `pad_token` |
| `<think>` | 151350 | false | 在助手回合内开启推理区间 |
| `</think>` | 151351 | false | 关闭推理区间 |
| `<tool_call>` | 151352 | false | 开启一次工具调用；函数名紧随其后位于同一行 |
| `</tool_call>` | 151353 | false | 关闭一次工具调用 |
| `<arg_key>` | 151356 | false | 开启参数名元素 |
| `</arg_key>` | 151357 | false | 关闭参数名元素 |
| `<arg_value>` | 151358 | false | 开启参数值元素 |
| `</arg_value>` | 151359 | false | 关闭参数值元素 |
| `<tool_response>` | 151354 | false | 在 observation 回合中包裹一个工具结果 |
| `</tool_response>` | 151355 | false | 关闭一个工具结果 |
| `/nothink` | 151360 | true | 附加在用户文本后的软开关，用于抑制思考 |

关于精确性的注意事项：
- 所有竖线均为 ASCII `|`（U+007C）；GLM 不使用全角 `｜`（U+FF5C）或 `▁`（U+2581）变体（与 DeepSeek 不同）。请原样复现 `<|system|>`、`<|user|>`、`<|assistant|>`、`<|observation|>`，并使用字面方括号的 `[gMASK]`。
- 由于 `<tool_call>`、`<arg_key>`、`<arg_value>`、`<tool_response>`、`<think>`（及其闭合标签）每个都精确对应 **一个** token ID，它们在流中各占一个 token —— 但因为 `special: false`，在 detokenize 时作为普通文本往返。因此解析器在解码文本中将它们作为字面子串匹配，而非作为控制 token id。
- `eos_token_id` 是一个 **列表**：`[151329, 151336, 151338]` = `<|endoftext|>`、`<|user|>`、`<|observation|>`（来自 `generation_config.json`）。工具调用回合的结束方式即此：模型在 `</tool_call>` 之后发出 `<|observation|>`，后者是 EOS id，生成因此停止，服务器上报工具调用（见回合结构）。

## 角色 / 通道 / 回合结构

每个提示词都以字面两 token 前缀 `[gMASK]<sop>` 开头（其后无换行）。然后回合被串接，每个回合由其角色标记引入；在渲染出的历史中，每回合没有终止 token（下一个标记，或生成期间的 EOS id，结束一个回合）。

- **System**（`<|system|>`）：角色标记、换行，然后是消息文本。当提供 `tools` 时，一个合成的 tools 系统回合会被 **首先** 渲染，位于任何用户提供的系统回合之前（两者是独立的 `<|system|>` 块 —— 见工具定义）。
- **User**（`<|user|>`）：角色标记、换行，然后是文本。如果 `enable_thinking` 为 false，则将字面量 `/nothink` 追加到用户文本之后（除非它已经以 `/nothink` 结尾）。
- **Assistant**（`<|assistant|>`）：角色标记，然后是推理区间和/或可见内容和/或工具调用。推理区间为 `\n<think>{reasoning}</think>`；可见内容紧随其单独一行；工具调用作为 `<tool_call>…</tool_call>` 块出现。
- **Tool result**（`<|observation|>`）：角色标记，引入一个或多个 `<tool_response>…</tool_response>` 块（见工具结果格式）。

思考 / 推理通道：
- 推理位于助手回合内的 `<think>…</think>`。`--reasoning-parser glm45` 将其抽取到独立的 `reasoning_content` 字段中；可见答案为 `</think>` 之后的内容。
- **仅保留最后一条用户消息之后助手回合的推理。** 模板对每个更早的助手回合渲染为空的 `<think></think>`，并丢弃其 `reasoning_content`（或嵌入在 `content` 中的任何行内 `<think>…</think>`）。这避免在后续回合中将陈旧的思维链留在上下文中。
- 既无保留推理也无显式链的助手回合渲染为 `\n<think></think>`（空），然后是内容/工具调用。

生成提示（`add_generation_prompt=True`）：
- **思考模式（默认）：** 提示词以裸 `<|assistant|>` 结尾；模型继续以 `\n<think>…</think>` 输出，然后是其答案或工具调用。
- **非思考模式**（`enable_thinking=false`）：提示词以 `<|assistant|>\n<think></think>` 结尾，预填一个空推理区间，使模型直接进入答案。

工具调用回合如何终止：没有专用的"工具调用后停止"token。模型发出 `</tool_call>` 然后是 `<|observation|>`（token 151338），后者是三个 EOS id 之一，解码因此停止。服务器检查文本，发现 `<tool_call>`，返回 `finish_reason: "tool_calls"`。

## 工具定义

当请求携带 `tools` 时，模板会在前面加一个 `<|system|>` 回合，其中包含固定前言、用 `<tools>…</tools>` 包裹的工具列表，以及对输出格式的字面描述。每个工具以 `tool | tojson(ensure_ascii=False)` 序列化 —— 即 **整个 OpenAI 工具对象原样** 包含 `{"type": "function", "function": {…}}` 包装层，并使用默认 JSON 缩进（`", "` / `": "`）。每个工具一行。

```text
<|system|>
# Tools

You may call one or more functions to assist with the user query.

You are provided with function signatures within <tools></tools> XML tags:
<tools>
{"type": "function", "function": {"name": "get_weather", "description": "Get current weather for a city", "parameters": {"type": "object", "properties": {"location": {"type": "string", "description": "City name"}, "unit": {"type": "string", "enum": ["celsius", "fahrenheit"]}}, "required": ["location"]}}}
</tools>

For each function call, output the function name and arguments within the following XML format:
<tool_call>{function-name}
<arg_key>{arg-key-1}</arg_key>
<arg_value>{arg-value-1}</arg_value>
<arg_key>{arg-key-2}</arg_key>
<arg_value>{arg-value-2}</arg_value>
...
</tool_call>
```

上面的 `<tool_call>{function-name}` / `<arg_key>` / `<arg_value>` 行属于 **提示词文本**（告知模型遵循的格式规范），不是示例调用。仅当 `tools` 非空时才发出此 tools 回合，并被下一个角色标记（例如用户提供的 `<|system|>` 或第一个 `<|user|>`）隐式关闭，两者之间无空行。

## 工具调用格式

模型以 `<tool_call>` 块形式发出调用：函数 **名与起始标签位于同一行**，一个换行，然后每个参数一组 `<arg_key>…</arg_key>` + `<arg_value>…</arg_value>` 对，以 `</tool_call>` 关闭。最简单的单次调用（助手在思考模式下生成；为逼真起见展示推理）：

```text
<think>The user wants the weather in Beijing. I'll call get_weather.</think>
<tool_call>get_weather
<arg_key>location</arg_key>
<arg_value>Beijing</arg_value>
<arg_key>unit</arg_key>
<arg_value>celsius</arg_value>
</tool_call>
```

结构与值编码（这是最容易出错的部分）：

- 函数名是 `<tool_call>` 与第一个换行之间的文本 —— 其外 **没有** 包裹标签，且 `<tool_call>` 后 **没有** 空格。
- 每个参数由两个相邻元素组成：`<arg_key>name</arg_key>` 后接 `<arg_value>value</arg_value>`，习惯上每对占一行。
- **参数值并非统一为 JSON。** 模板将每个值渲染为 `value | tojson(ensure_ascii=False) if value is not string else value`：
  - **string** 值以 **原始形式发出，不带包裹引号** → `<arg_value>Beijing</arg_value>`（而非 `"Beijing"`）。
  - **非 string** 值（number、boolean、null、object、array）以 JSON 编码 → `<arg_value>3</arg_value>`、`<arg_value>true</arg_value>`、`<arg_value>{"k": 1}</arg_value>`。
- **零参数** 调用没有键值对：函数名后接一个换行和闭合标签 —— `<tool_call>get_time\n</tool_call>`。

由于字符串值丢失了引号，解析器必须对每个参数分别决定是 JSON 解码还是将其视为字面字符串。两份参考解析器都通过查询工具的 JSON Schema 来完成此判断：若参数类型为 `string`，则原样采用原始文本；否则进行 JSON 解码（带 `ast.literal_eval` 和 raw-string 兜底）。模型经过训练遵循 schema，因此仅在参数为 string 类型时才发出裸字符串。

## 多次 / 并行工具调用

一轮中两个或更多调用以连续的 `<tool_call>…</tool_call>` 块发出，由单个换行分隔（集合外无包裹元素）。两次并行调用、参数类型混合时助手的原始输出：

```text
<think>Two cities. Call get_weather twice in parallel.</think>
<tool_call>get_weather
<arg_key>location</arg_key>
<arg_value>Beijing</arg_value>
<arg_key>unit</arg_key>
<arg_value>celsius</arg_value>
</tool_call>
<tool_call>get_weather
<arg_key>location</arg_key>
<arg_value>Shanghai</arg_value>
<arg_key>days</arg_key>
<arg_value>3</arg_value>
<arg_key>verbose</arg_key>
<arg_value>true</arg_value>
</tool_call>
```

注意 `Beijing`/`Shanghai`/`celsius`（字符串）为裸值，而 `3`（数字）与 `true`（布尔）为 JSON 字面量。解析器在非贪婪的 `<tool_call>.*?</tool_call>` 正则上分割，因此支持任意数量的调用；每条作为 `tool_calls[]` 中独立的一项。

## 工具结果格式

结果在 **observation** 回合中返回。对于单个结果：`<|observation|>` 标记，一个换行，然后用 `<tool_response>` / `</tool_response>` 包裹的结果：

```text
<|observation|>
<tool_response>
{"temperature": 26, "unit": "celsius", "condition": "Sunny"}
</tool_response>
```

标签之间的内容 **原样** 插入（调用者通常传入 JSON 字符串，但允许任何文本）。对于并行调用集合产生的 **多个** 结果，`<|observation|>` 标记仅出现 **一次**，每个结果各自一个 `<tool_response>` 块（连续的 `tool` 角色消息在单个 observation 回合下合并）：

```text
<|observation|>
<tool_response>
{"temperature": 26, "condition": "Sunny"}
</tool_response>
<tool_response>
{"temperature": 30, "condition": "Cloudy"}
</tool_response>
```

聊天模板 **只** 读取工具消息的 `content` —— 不参考任何 `tool_call_id`。因此结果与调用按 **位置 / 顺序** 关联，而非通过嵌入的 id（GLM 的线协议不携带每调用 id；见 API 映射）。

## 端到端示例

一个完整的多轮天气对话。这些是本地渲染出的精确流；回合内的换行是字面的，回合之间其他情况下是连续的（标记之间无分隔符）。

**阶段 1 —— 喂给模型的提示词**（已设置 `tools`、一条先前的系统消息、`add_generation_prompt=True`、思考模式）：

```text
[gMASK]<sop><|system|>
# Tools

You may call one or more functions to assist with the user query.

You are provided with function signatures within <tools></tools> XML tags:
<tools>
{"type": "function", "function": {"name": "get_weather", "description": "Get current weather for a city", "parameters": {"type": "object", "properties": {"location": {"type": "string", "description": "City name"}, "unit": {"type": "string", "enum": ["celsius", "fahrenheit"]}}, "required": ["location"]}}}
</tools>

For each function call, output the function name and arguments within the following XML format:
<tool_call>{function-name}
<arg_key>{arg-key-1}</arg_key>
<arg_value>{arg-value-1}</arg_value>
<arg_key>{arg-key-2}</arg_key>
<arg_value>{arg-value-2}</arg_value>
...
</tool_call><|system|>
You are a helpful assistant.<|user|>
What's the weather in Beijing?<|assistant|>
```

**助手生成**（模型输出；以发出 `<|observation|>`（EOS id）结束，因此解码在此停止；服务器返回 `finish_reason: "tool_calls"`）：

```text
<think>The user wants the weather in Beijing. I'll call get_weather.</think>
<tool_call>get_weather
<arg_key>location</arg_key>
<arg_value>Beijing</arg_value>
<arg_key>unit</arg_key>
<arg_value>celsius</arg_value>
</tool_call>
```

**阶段 2 —— 下一轮的提示词**，在追加了助手工具调用回合与工具结果之后，然后 `add_generation_prompt=True`：

```text
[gMASK]<sop><|system|>
# Tools

You may call one or more functions to assist with the user query.

You are provided with function signatures within <tools></tools> XML tags:
<tools>
{"type": "function", "function": {"name": "get_weather", "description": "Get current weather for a city", "parameters": {"type": "object", "properties": {"location": {"type": "string", "description": "City name"}, "unit": {"type": "string", "enum": ["celsius", "fahrenheit"]}}, "required": ["location"]}}}
</tools>

For each function call, output the function name and arguments within the following XML format:
<tool_call>{function-name}
<arg_key>{arg-key-1}</arg_key>
<arg_value>{arg-value-1}</arg_value>
<arg_key>{arg-key-2}</arg_key>
<arg_value>{arg-value-2}</arg_value>
...
</tool_call><|system|>
You are a helpful assistant.<|user|>
What's the weather in Beijing?<|assistant|>
<think>The user wants the weather in Beijing. I'll call get_weather.</think>
<tool_call>get_weather
<arg_key>location</arg_key>
<arg_value>Beijing</arg_value>
<arg_key>unit</arg_key>
<arg_value>celsius</arg_value>
</tool_call><|observation|>
<tool_response>
{"temperature": 26, "unit": "celsius", "condition": "Sunny"}
</tool_response><|assistant|>
```

**最终助手生成**（自然语言答案，由 `<|endoftext|>` 终止；`finish_reason: "stop"`）：

```text
<think>Got it, 26C and sunny.</think>
It's 26°C and sunny in Beijing right now.
```

上面可见两处细节：(1) 助手工具调用回合的推理仅在阶段 2 中被 **保留**，因为它是最后一条用户消息之后的那一段；若之后又有用户回合，则该 `<think>…</think>` 会被重新渲染为空。(2) 工具调用回合与 observation 回合直接相接（`</tool_call><|observation|>`），observation 又与下一个助手标记相接（`</tool_response><|assistant|>`）。

对于 **非思考** 模式，用户文本带有软开关，且生成提示预填一个空的 think 区间：

```text
<|user|>
Hi there/nothink<|assistant|>
<think></think>
```

## OpenAI 兼容 API 映射

当服务器解析器激活时（`--tool-call-parser glm45 --reasoning-parser glm45`），原始流到 Chat Completions 的映射如下：

- `choices[].finish_reason` = `"tool_calls"` 当输出中至少含一个 `<tool_call>`（否则为 `"stop"`）。
- `choices[].message.content` = 第一个 `<tool_call>` **之前** 的文本（若为空/空白则规范化为 `null`）。`<think>…</think>` 推理由推理解析器移除，并单独作为 `message.reasoning_content` 暴露。
- `choices[].message.tool_calls[]` —— 每个 `<tool_call>…</tool_call>` 块对应一项：
  - `.id` = **服务器生成** 的 id（如 vLLM 的 `make_tool_call_id()`），**不** 出现在模型输出中。GLM 在流中不发出每调用 id。
  - `.type` = `"function"`。
  - `.function.name` = `<tool_call>` 之后、第一个换行之前的文本。
  - `.function.arguments` = 一个 **JSON 字符串**（一个对象），由 `<arg_key>`/`<arg_value>` 对根据工具 schema 按参数类型重建。vLLM 返回 `json.dumps(arg_dct, ensure_ascii=False)`，例如 `"{\"location\": \"Beijing\", \"unit\": \"celsius\"}"`。客户端在使用前应 `json.loads()`。
- **请求侧 —— 工具结果** 以 `role: "tool"` 消息发回，例如：

  ```json
  {"role": "tool", "tool_call_id": "call_abc123", "content": "{\"temperature\": 26, \"unit\": \"celsius\", \"condition\": \"Sunny\"}"}
  ```

  聊天模板仅渲染 `content`（位于 `<tool_response>` 内）；`tool_call_id` 被模板 **忽略**，仅对客户端自身的簿记有用。按与调用匹配的顺序排列结果。
- **请求侧 —— 助手工具调用历史**：OpenAI 形式将 `function.arguments` 作为 JSON **字符串** 携带，但聊天模板遍历 `arguments.items()`，因此需要 **对象**。vLLM/SGLang 在渲染前将字符串解析回字典；若你直接调用 `tokenizer.apply_chat_template`，请将 `arguments` 作为字典（可选地，将 `reasoning_content` 作为字符串）传入，否则模板会抛出异常。
- 通过 `extra_body={"chat_template_kwargs": {"enable_thinking": False}}`（OpenAI Python 客户端）禁用思考 —— 这会将模板切换到 `/nothink` + 预填 `<think></think>` 路径。

## 解析注意事项与陷阱

- **字符串值未加引号；类型判断需要 schema。** 决定性规则：仅当工具 JSON Schema 中参数为 string 类型时，`<arg_value>` 为字面字符串；否则为 JSON。vLLM 的 `_is_string_type` 与 SGLang 的 `get_argument_type` 都遍历 `properties[arg].type`（处理 `anyOf`/`oneOf`/`enum`/`allOf`/类型数组）。如果 schema 缺失/宽松，则回退到"尝试 `json.loads`，再 `ast.literal_eval`，最后视为字符串" —— 因此像 `celsius` 这样的裸词保留为字符串，而 `26` 成为数字。仅当 schema 指明为 `string` 时，*看起来* 像 JSON 的字符串值（例如类型为 `string`、值为 `{"a":1}` 的参数）才会被正确保留为字面字符串。
- **抽取正则（GLM-4.5/4.6）。** vLLM：调用通过 `<tool_call>.*?</tool_call>`（DOTALL）；名称/主体通过 `<tool_call>([^\n]*)\n(.*)</tool_call>`；键值对通过 `<arg_key>(.*?)</arg_key>\s*<arg_value>(.*?)</arg_value>`。名称正则 **要求** 名称后跟换行 —— 与 4.5/4.6 模板一致。SGLang 使用等价的 `(?:\\n|\n)` 形式，因此同样能容忍字面转义的 `\n`。
- **值中出现的 `</arg_value>` 会破坏解析。** 值以非贪婪方式捕获到下一个 `</arg_value>`；若值文本中包含 `</arg_value>`（或 `</tool_call>`），则会提前截断。线协议中没有转义机制。
- **工具调用仅从 `content` 解析，不从推理解析。** 在 `<think>…</think>` 内发出的 `<tool_call>` 会被工具解析器忽略（vLLM 的推理/工具解析器协同工作，仅扫描 `</think>` 之后的内容）。不要指望"思考时"做出的调用会触发。
- **GLM 抑制引导解码。** 对于 `tool_choice: "required"` 或具名工具，vLLM 故意 **不** 应用 JSON 结构化输出 / 引导解码，因为这会强制 JSON 输出而与 GLM 的 XML 语法冲突；解析器改为从自由形式的 XML 中抽取。
- **`skip_special_tokens` 必须关闭。** 尽管工具/思考标签为 `special: false`，vLLM 在启用工具时强制设置 `skip_special_tokens = False`（防御 transformers 5.x detokenize 变更），以使字面 `<tool_call>`/`</tool_call>` 文本能为正则所用。
- **流式传输。** 长字符串参数过去会一直缓冲到闭合标签（vLLM issue #32829）；当前解析器在每个 delta 上重新解析累积的文本，仅发出差异部分，采用"先开引号再填充"策略流式输出增量字符串内容，并保留任何部分尾部标签（`partial_tag_overlap`）。流式工具名为第一个 `\n` 或 `<arg_key>` 之前的文本。SGLang 将其实现为显式的 XML→JSON 状态机（`INIT → IN_KEY → WAITING_VALUE → IN_VALUE`）。畸形的尾部（在 `</tool_call>` 之前缺少 `</arg_value>`）会通过启发式方式补齐。
- **谱系 —— GLM-4.5 与 GLM-4.6：** 线协议相同，`chat_template.jinja` 相同（同一内容哈希）；同一 `glm45` 解析器同时为两者服务。
- **谱系 —— GLM-4.7 / GLM-5 改变了格式。** 较新的模型可能省略结构性换行：函数名可直接位于第一个 `<arg_key>` 之前，零参数调用可以是 `<tool_call>func</tool_call>`，并行调用可紧挨。vLLM/SGLang 对此变体需要各自独立的 GLM-4.7 解析器。omp 的仓库扫描器有意做得更宽：它接受换行、`<arg_key>` 或 `</tool_call>` 作为名称分隔符，因此同一 `glm` 方言扫描器即可处理两种版式。

## omp / pi 转换器行为

仓库的 `glm` 方言是一个 **自有带内转换器**。可通过 `PI_DIALECT=glm` 选择；遗留的 `PI_DIALECT=1` 与 `PI_DIALECT=true` 同样解析为 GLM。当存在工具时，代理将 GLM 格式指南与精简工具目录追加到系统提示中，移除原生 provider 工具，将先前的调用/结果改写为 grammar 拥有的文本，并将助手文本扫描回规范的 pi 事件。GLM 系列模型亲和性解析到此方言。

自有渲染器始终发出 GLM-4.5 换行版式。它查询每个工具的规范化 schema：纯 string 属性以原始形式发出，而所有其他值被 JSON 序列化。并行调用以换行分隔。在自有历史中，结果批成为包含 `<observation>` 与每个结果对应一个 `<tool_response>` 的合成用户消息；底层 GLM transcript 渲染器则改用模型原生 `<|observation|>` 角色标记。

扫描器合成 `ptc_…` id，在名称分隔符到达时发出 `toolStart`，并将每个参数主体作为带键的 `toolArgDelta` 事件流式发出。纯 string schema 属性保持原样；其他已完成的属性在 trim 后以严格 `JSON.parse` 解析，失败时回退到原始文本。flush 时，未完成的键/值仅丢弃扫描器的私有调用状态。若 `toolStart` 已发出，OMP 会保留该规范调用，正常 stop 可分派它；先前累积的参数 —— 包括通过 `toolArgDelta` 发布的部分值文本 —— 仍保留在该调用上。永不产生有效名称的输入不会发出 `toolStart`，因此不会留下任何调用。扫描器还修复可被狭义识别的模型错误：用 `</arg_key>` 替代 `</arg_value>`、真实闭合标签之前的多余错误闭合标签，以及紧接着下一个参数或调用闭合前缺失的值闭合标签。

思考解析默认启用，并将 `<think>…</think>` 排除在可见文本之外。若助手输出中出现 `<tool_response>`，扫描器丢弃该标签以及当前已缓冲块的剩余部分，而不会将幻觉出的结果视为助手内容。

## 来源

- 聊天模板（权威；本地渲染以获得字节精确流），GLM-4.5 提交 `cbb2c7c…`：https://huggingface.co/zai-org/GLM-4.5/resolve/main/chat_template.jinja —— `blob`/网页路径会重定向到模型卡 API；已通过原始 `resolve/main` 缓存验证。
- 完全相同的 GLM-4.6 模板（同一内容哈希，证明格式共享）：https://huggingface.co/zai-org/GLM-4.6/resolve/main/chat_template.jinja
- 特殊 token ID 与 `special` 标志（`added_tokens_decoder`、`additional_special_tokens`）：https://huggingface.co/zai-org/GLM-4.5/resolve/main/tokenizer_config.json
- 停止 token（`eos_token_id = [151329, 151336, 151338]`）：https://huggingface.co/zai-org/GLM-4.5/resolve/main/generation_config.json
- 模型卡（服务器标志 `--tool-call-parser glm45 --reasoning-parser glm45`、`enable_thinking` 开关、解析器链接）：https://huggingface.co/zai-org/GLM-4.5
- vLLM GLM-4.5/4.6 工具解析器（`Glm4MoeModelToolParser`：正则、schema 驱动的 string 类型判定、JSON 字符串 `arguments`、流式、`skip_special_tokens`）：https://github.com/vllm-project/vllm/blob/main/vllm/tool_parsers/glm4_moe_tool_parser.py
- vLLM GLM-4.7 工具解析器（`Glm47MoeModelToolParser`：同行名称、可选/零参数）：https://github.com/vllm-project/vllm/blob/main/vllm/tool_parsers/glm47_moe_tool_parser.py
- SGLang GLM-4.5/4.6 检测器（`Glm4MoeDetector`：格式 docstring、XML→JSON 状态机、参数类型判定）：https://github.com/sgl-project/sglang/blob/main/python/sglang/srt/function_call/glm4_moe_detector.py
- SGLang GLM-4.7 检测器（`Glm47MoeDetector`：无换行 / 紧挨调用）：https://github.com/sgl-project/sglang/blob/main/python/sglang/srt/function_call/glm47_moe_detector.py
- vLLM 工具调用文档：https://docs.vllm.ai/en/latest/features/tool_calling/
