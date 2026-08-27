# Qwen3 工具调用格式（Hermes 约定）

Alibaba **Qwen3** 系列的工具调用约定（`Qwen/Qwen3-*`：稠密 `0.6B–32B` 以及 MoE `30B-A3B`/`235B-A22B`；与 `Qwen2.5-*` 和 `QwQ-32B` 同一模板路线）。它采用 **Hermes** 约定——由 NousResearch 的 Hermes 2 Pro 首创、被 Qwen 原样采用，并被大量社区微调沿用的 XML+JSON 格式。整体外壳是 **ChatML**：每个回合都是 `<|im_start|>{role}\n{body}<|im_end|>\n`。可用工具在 system 回合的 `<tools>…</tools>` 块内声明（每行一个 JSON spec）；模型将每次调用以 `<tool_call>\n{json}\n</tool_call>` 块的形式发出，其中 `arguments` 是**嵌套的 JSON 对象**（而非字符串化 JSON）；工具结果以 `<tool_response>…</tool_response>` 反馈回来。混合推理…

核验来源：Qwen 官方的 function-calling 指南（`qwen.readthedocs.io/en/latest/framework/function_call.html`，全文阅读含 Qwen-Agent 与 vLLM 章节）、`Qwen/Qwen3-8B` 的 `tokenizer_config.json` 中字节级精确的 `chat_template` 字段（HF resolve-cache commit `b968826d9c46dd6066d109eabc6255188de91218`，本地用 Jinja2 渲染得到下方原始流）以及 `added_tokens_decoder` 中的 token ID、NousResearch 的 `Hermes-Function-Calling` README，以及 vLLM 工具调用文档（`hermes` 解析器与 Qwen 模型章节）。

## 特殊 token

只有三个 ChatML 标记属于"特殊"控制 token（`special=true`，会被 `skip_special_tokens` 跳过）。推理与工具标记虽然也是单一词表 token（每个各占一个 ID），但注册为 `special=false`，即按普通文本渲染，**不会**被 `skip_special_tokens` 剥离。`<tools>`/`</tools>` 包装层**完全不存在**专用 token——它是普通文本，会被 BPE 拆分为若干 token。ID 取自 `Qwen/Qwen3-8B` 的 `added_tokens_decoder`。

| Token（逐字） | ID | `special` | 用途 |
|---|---|---|---|
| `<\|im_start\|>` | 151644 | true | 回合起始；后接 role 名称 + `\n` |
| `<\|im_end\|>` | 151645 | true | 回合结束；即 chat 停止 token |
| `<\|endoftext\|>` | 151643 | true | 基础 EOS / pad token |
| `<think>` | 151667 | false | 开启推理块 |
| `</think>` | 151668 | false | 关闭推理块 |
| `<tool_call>` | 151657 | false | 开启一次工具调用 |
| `</tool_call>` | 151658 | false | 关闭一次工具调用 |
| `<tool_response>` | 151665 | false | 开启一条工具结果 |
| `</tool_response>` | 151666 | false | 关闭一条工具结果 |
| `<tools>` … `</tools>` | — | — | system 回合中工具列表的纯文本包装（并非单一 token） |

关于精确性的说明：
- 所有标记使用 ASCII 管道符 `|`（U+007C）与 ASCII 尖括号。Qwen3 **没有**全角（`｜` U+FF5C）或 `▁`（U+2581）变体——那是 DeepSeek/SentencePiece 体系的范畴，与 Qwen 无关。
- `<|im_start|>` 与 `<|im_end|>` 是回合切分中真正起作用的两个 token。由于 `<tool_call>`、`</tool_call>`、`<tool_response>`、`<think>`、`</think>` 是 `special=false`，它们在 `skip_special_tokens=True` 解码后会保留下来，这正是基于正则的 `hermes` 解析器能从解码文本中恢复它们的原因。
- 模型卡确认 `</think>` = token `151668`（被参考解析片段 `output_ids[::-1].index(151668)` 使用）。

## Role / 通道 / 回合结构

ChatML。每条消息渲染为：

```text
<|im_start|>{role}
:{body}<|im_end|>
```

- Role：`system`、`user`、`assistant`、`tool`。不存在独立的"通道"概念；唯一的子流是 assistant 回合内的 `<think>` 推理块。
- 每个回合以 `<|im_end|>\n` 结束。设置 `add_generation_prompt=True` 时，prompt 以 `<|im_start|>assistant\n` 结尾，模型从该处继续生成。
- **system 回合：** 若调用方提供 `system` 消息，它会成为第一个回合。当存在 `tools` 时，工具声明会**合并到**同一个 system 回合中（先放用户传入的系统文本，再 `\n\n`，再放 `# Tools` 块——见下文）。Qwen3 在未提供时不注入默认系统提示。
- **工具结果回合使用 `user` 外壳。** Qwen3 模板把每条 `role: "tool"` 消息映射为一个 `<|im_start|>user` 回合，承载 `<tool_response>` 块（连续的 tool 消息会合并到同一个 user 回合）。这与经典 Hermes 2 Pro 不同——后者使用专门的 `<|im_start|>tool` 回合承载结果；Qwen 将其折入 `user`。
- **思考/推理：** 通过 assistant 回合开头的 `<think>…</think>` 承载（切换开关与历史重渲染规则见 Parsing notes）。

## 工具定义

工具在 system 回合内声明。模板先输出固定的前导文本，然后对每个工具对象用 `tool | tojson`（`json.dumps(..., ensure_ascii=False)`）逐行序列化，最后输出固定的后缀。每个列表元素是完整的 OpenAI 工具对象 `{"type": "function", "function": {...}}`（其中 `parameters` 是一个 JSON-Schema 对象）。Qwen3 实际产出的、逐字精确的包装层如下：

```text
<|im_start|>system
{optional original system content}

# Tools

You may call one or more functions to assist with the user query.

You are provided with function signatures within <tools></tools> XML tags:
<tools>
{"type": "function", "function": {"name": "get_current_temperature", "description": "Get current temperature at a location.", "parameters": {"type": "object", "properties": {"location": {"type": "string", "description": "The location to get the temperature for, in the format \"City, State, Country\"."}, "unit": {"type": "string", "enum": ["celsius", "fahrenheit"], "description": "The unit to return the temperature in. Defaults to \"celsius\"."}}, "required": ["location"]}}}
{"type": "function", "function": {"name": "get_temperature_date", "description": "Get temperature at a location and date.", "parameters": {"type": "object", "properties": {"location": {"type": "string", "description": "The location to get the temperature for, in the format \"City, State, Country\"."}, "date": {"type": "string", "description": "The date to get the temperature for, in the format \"Year-Month-Day\"."}, "unit": {"type": "string", "enum": ["celsius", "fahrenheit"], "description": "The unit to return the temperature in. Defaults to \"celsius\"."}}, "required": ["location", "date"]}}}
</tools>

For each function call, return a json object with function name and arguments within <tool_call></tool_call> XML tags:
<tool_call>
{"name": <function-name>, "arguments": <args-json-object>}
</tool_call><|im_end|>
```

- 如果首条消息是 `system`，其内容会放在 `# Tools` 之前（以空行分隔）；否则回合直接以 `# Tools` 开头。
- 末尾的指令是 prompt 的一部分字面内容，包括占位行 `{"name": <function-name>, "arguments": <args-json-object>}`（这些尖括号 token 是指令，不是模型实际输出）。
- 版本说明：原版 Hermes 2 Pro 的系统提示额外内嵌了一行 `FunctionCall` pydantic schema（`{"title": "FunctionCall", "type": "object", "properties": {"name": …, "arguments": …}}`）。Qwen3 移除了该行；上面的包装层就是 Qwen3 实际产出的内容。

## 工具调用格式

模型每次调用以一行 `<tool_call>`、一个单行 JSON 对象、然后 `</tool_call>` 的形式发出。最小单次调用：

```text
<tool_call>
{"name": "get_current_temperature", "arguments": {"location": "San Francisco, CA, USA", "unit": "celsius"}}
</tool_call>
```

- `arguments` 是**嵌套的 JSON 对象**，不是 JSON 编码字符串。在线协议上是 `"arguments": {"location": "..."}`，**绝不**是 `"arguments": "{\"location\": ...}"`。（模板通过 `tojson` 渲染 dict 形式的参数；只有当调用方把 `arguments` 存为预序列化字符串时，它才会原样透传。）
- 调用对象恰好有两个键，`name`（字符串）与 `arguments`（对象）。线协议上不存在 per-call ID——OpenAI 风格的 `tool_call_id` 由服务端生成，而非模型生成（见 API 映射）。
- 工具调用的 assistant 回合也可以在首个 `<tool_call>` 之前包含自然语言 `content`；模板会在该 content 与首个调用之间插入一个 `\n`。

## 多次 / 并行工具调用

并行调用以同一 assistant 回合内连续的 `<tool_call>…</tool_call>` 块形式发出，相邻块之间以换行分隔：

```text
<|im_start|>assistant
<tool_call>
{"name": "get_current_temperature", "arguments": {"location": "San Francisco, CA, USA"}}
</tool_call>
<tool_call>
{"name": "get_temperature_date", "arguments": {"location": "San Francisco, CA, USA", "date": "2024-10-01"}}
</tool_call><|im_end|>
```

解析器按发射顺序返回 `tool_calls[0]`、`tool_calls[1]`，……应用必须执行它们并按相同顺序返回每个调用对应的 `<tool_response>`。

## 工具结果格式

每条已执行结果被包裹在 `<tool_response>…</tool_response>` 中。Qwen3 将它们放在 **`user`** 回合内，并**合并**连续的工具结果为同一个回合（每个结果一个 `<tool_response>` 块，换行分隔，共用一个收尾 `<|im_end|>`）：

```text
<|im_start|>user
<tool_response>
{"temperature": 26.1, "location": "San Francisco, CA, USA", "unit": "celsius"}
</tool_response>
<tool_response>
{"temperature": 25.9, "location": "San Francisco, CA, USA", "date": "2024-10-01", "unit": "celsius"}
</tool_response><|im_end|>
```

- 标签之间的内容体是工具返回值（通常是 JSON 字符串，但也允许任意文本）。函数名**不会**在 Qwen3 的 `<tool_response>` 内重复——通过顺序将结果与调用绑定。（经典 Hermes 2 Pro 则在 `tool` 回合下的 `<tool_response>` 内嵌套 `{"name": ..., "content": ...}`；Qwen3 的模板在 `user` 回合下输出纯 content。）
- 在 OpenAI API 层面，一条结果消息是 `{"role": "tool", "content": "...", "tool_call_id": "..."}`；模板仅将其 `content` 渲染进 `<tool_response>` 块。

## 端到端示例

**非思考模式**（`enable_thinking=False`）下的完整多回合天气交互流程，与 `apply_chat_template` 对实时流程渲染出的内容完全一致。关闭思考时，每个生成步骤会在 `<|im_start|>assistant\n` 之后注入一个空的 `<think>\n\n</think>\n\n`；然后模型再发出工具调用 / 最终回答。可直接复制粘贴、字节级精确：

```text
<|im_start|>system
You are a helpful assistant. Current Date: 2024-09-30.

# Tools

You may call one or more functions to assist with the user query.

You are provided with function signatures within <tools></tools> XML tags:
<tools>
{"type": "function", "function": {"name": "get_current_temperature", "description": "Get current temperature at a location.", "parameters": {"type": "object", "properties": {"location": {"type": "string", "description": "The location to get the temperature for, in the format \"City, State, Country\"."}, "unit": {"type": "string", "enum": ["celsius", "fahrenheit"], "description": "The unit to return the temperature in. Defaults to \"celsius\"."}}, "required": ["location"]}}}
</tools>

For each function call, return a json object with function name and arguments within <tool_call></tool_call> XML tags:
<tool_call>
{"name": <function-name>, "arguments": <args-json-object>}
</tool_call><|im_end|>
<|im_start|>user
What's the temperature in San Francisco now?<|im_end|>
<|im_start|>assistant
<think>

</think>

<tool_call>
{"name": "get_current_temperature", "arguments": {"location": "San Francisco, CA, USA", "unit": "celsius"}}
</tool_call><|im_end|>
<|im_start|>user
<tool_response>
{"temperature": 26.1, "location": "San Francisco, CA, USA", "unit": "celsius"}
</tool_response><|im_end|>
<|im_start|>assistant
<think>

</think>

The current temperature in San Francisco is 26.1°C.<|im_end|>
```

在**思考模式**（`enable_thinking=True`，默认）下，生成 prompt 改为以裸的 `<|im_start|>assistant\n` 结尾，模型自行在 `<tool_call>` 之前生成 `<think>…真实推理…</think>` 块。（重渲染已存储历史时，模板仅对最后一条 assistant 消息或带有 `reasoning_content` 的消息保留 `<think>` 块，并剥离更早回合的推理——见 Parsing notes。）

## OpenAI 兼容 API 映射

使用 `--enable-auto-tool-choice --tool-call-parser hermes` 时，vLLM 会将原始流转换为标准 Chat Completions 响应：

- `finish_reason`：当回合终止于工具调用时为 `"tool_calls"`，否则为 `"stop"`。
- `message.role`：`"assistant"`；`message.content`：纯工具调用回合为 `null`（任何调用前的自然语言会成为 `content`）。
- `message.tool_calls[]`：每个 `<tool_call>` 块对应一项，每项包含：
  - `id`：服务端生成，例如 `"chatcmpl-tool-924d705adb044ff88e0ef3afdd155f15"`（模型不输出 ID）。
  - `type`：`"function"`。
  - `function.name`：调用的 `name`。
  - `function.arguments`：在 API 边界为**JSON 字符串**，例如 `'{"location": "San Francisco, CA, USA"}'`。线协议格式是嵌套对象，但服务端在此处重新序列化为字符串（使用前需 `json.loads(...)`），与 OpenAI 和 Qwen-Agent 行为一致。
- 启用思考 + `--reasoning-parser deepseek_r1` 时，`<think>…</think>` 内容会被切分为 `message.reasoning_content` 并从 `content` 中移除。
- 反馈结果：为每条结果追加 `{"role": "tool", "content": <result>, "tool_call_id": <id-from-the-call>}`。`tool_call_id` 将结果与对应调用关联（Qwen3 模板在渲染时忽略 id——到达模型的是顺序——但 API 仍要求该字段）。

针对双调用查询返回的 assistant 消息示例：

```text
finish_reason='tool_calls'
message.content = None
message.tool_calls = [
  {id:'chatcmpl-tool-924d…', type:'function', function:{name:'get_current_temperature', arguments:'{"location": "San Francisco, CA, USA"}'}},
  {id:'chatcmpl-tool-7e30…', type:'function', function:{name:'get_temperature_date',   arguments:'{"location": "San Francisco, CA, USA", "date": "2024-10-01"}'}},
]
```

## omp / pi 转换器行为

仓库的 `qwen3` 方言是一个**自有的带内转换器**。通过 `PI_DIALECT=qwen3`（或等价的 agent 配置）选择它。当存在工具时，agent 会向系统提示追加 Qwen3 格式指南与精简的工具目录，移除原生 provider 工具，将此前的调用与结果改写为该语法的文本，并将流式输出重新扫描为规范的 pi 工具调用事件。`hermes` 仍是独立可选的方言，尽管两者都发出基本相同的 JSON-in-`<tool_call>` 约定（参见 [hermes.md](hermes.md)）。

目录当前的家族亲和辅助函数将任何模型 id 中包含 `qwen` 的项映射到 `qwen3`，包括 Qwen3-Coder。对于 Coder 端点，需设置 `tools.format=native`（或等价的 native-tool 设置）并在服务端点本身配置其 `qwen3_xml` 解析器。`qwen3_xml` 不是 OMP 自有的方言，因此不是有效的 `tools.format` 取值。

omp 渲染器始终写出嵌套的 `arguments` 对象，并换行分隔并行调用。结果会成为合成 user 历史消息中换行分隔的 `<tool_response>` 块。扫描器在首段 JSON 中包含完整字符串 `name` 时立即生成 id（`ptc_…`）并发出 `toolStart`。它会等待 `</tool_call>` 后再发出 `toolEnd`，且不流式传输参数增量。结束时使用共享的可修复 JSON 解析器。为兼容起见，它也接受字符串化的 `arguments` 值并再解析一次，尽管自有渲染器永远不会产出该形态。已完成的字符串解析失败或非对象参数会规整为 `{}`；若外层已完成对象但 name 无法恢复，则消费而不创建调用。

若 EOF 到达时 name 已恢复但 `</tool_call>` 尚未出现，则不会发出 `toolEnd`，但 `toolStart` 创建的规范调用会以空参数存活，并可能在正常停止时被派发。始终无法产出 name 的畸形输入不产生任何调用。

默认开启思考解析：`<think>…</think>` 变为思考事件并从可见文本中排除。创建扫描器的调用方可设置 `parseThinking: false`，此时思考标记会按普通文本保留。

## 解析注意事项与陷阱

- **Arguments 对象 vs 字符串：** 在线协议上 `arguments` 是嵌套的 JSON 对象；OpenAI 层将其作为 JSON 字符串返回。读取原始流的代码必须解析为对象；读取 API 的代码必须 `json.loads` 该字符串。不要双重编码。
- **`<tools>` 不是 token。** 只有 `<|im_start|>`/`<|im_end|>`（以及 `*tool_call*`/`*tool_response*`/`*think*` 单一 token）可视为原子的。`<tools>`/`</tools>` 是普通文本。
- **正则/流式解析：** vLLM `hermes` 解析器（`vllm/tool_parsers/hermes_tool_parser.py`，`Hermes2ProToolParser`）以字面量 `<tool_call>` / `</tool_call>` 子串作为关键标记并对内容做 JSON 解码，支持单回合多个块。流式时，它从 `<tool_call>` 开始缓冲，先增量解析 `name` 再解析 `arguments`；部分参数 JSON 作为参数增量发出。首个 `<tool_call>` 之前的文本按普通 content 流式发出。
- **思考开关：** `enable_thinking=False`（通过 OpenAI API 时以 `chat_template_kwargs={"enable_thinking": False}` 传入，或 `tokenizer.apply_chat_template(..., enable_thinking=False)`）会在生成 prompt 中注入空的 `<think>\n\n</think>\n\n`，硬性抑制推理。用户/系统消息中的软开关 `/think` 与 `/no_think` 在启用思考时可按回合翻转该状态。不推荐对 Qwen3 使用贪心解码（有重复风险）。
- **历史重渲染不对称：** 当 `apply_chat_template` 重渲染已存储会话时，仅对最后一条 assistant 消息或带有 `reasoning_content` 的消息输出 `<think>` 块；更早回合的推理会被丢弃。因此已存储的中间工具调用 assistant 回合不显示 `<think>` 块，而生成该回合的实时生成步骤（在非思考模式下）原本带有该块。推理仅在当前多步工具序列内（最后一条真实 user 查询之后）保留。
- **推理模型 + 停止词模板：** Qwen 警告对 Qwen3 不要使用 ReAct 风格的停止词工具模板，因为推理文本可能包含停止词从而破坏解析——应改用此原生 Hermes 模板。
- **鲁棒性：** 该格式由 prompt/模板驱动，因此可能出现畸形输出
  （截断的 JSON、缺失 `</tool_call>`、调用中混入自然语言、或字符串化的
  arguments）。vLLM 视其解析路径可能回退到 content；omp 自有的扫描器则会消费已识别的块，并在外层 JSON/name 无法恢复时不发出调用。Named / `required` tool choice 在使用 vLLM 原生工具时，可经由 vLLM 的结构化输出后端路由；但自有模式不发送原生 provider 工具定义，因此不能依赖该后端。
- **版本/范围：** 本 `hermes` 模板覆盖 `Qwen3-*`、`Qwen2.5-*` 和 `QwQ-32B`。它**不**覆盖 `Qwen3-Coder`——后者使用不同的 XML 方案，由服务端引擎的 `qwen3_xml` 解析器解析。OMP 没有 `qwen3_xml` 自有方言；请使用 `tools.format=native` 并在端点配置该解析器。

## 来源

- Qwen function-calling 指南：https://qwen.readthedocs.io/en/latest/framework/function_call.html
- Qwen3-8B chat template + token IDs（`tokenizer_config.json`，`chat_template` + `added_tokens_decoder`）：https://huggingface.co/Qwen/Qwen3-8B/resolve/main/tokenizer_config.json（通过 HF resolve-cache commit `b968826d9c46dd6066d109eabc6255188de91218` 验证）
- Qwen3-8B 模型卡（思考模式、`enable_thinking`、`</think>`=151668）：https://huggingface.co/Qwen/Qwen3-8B
- NousResearch Hermes-Function-Calling（该约定的起源）：https://github.com/NousResearch/Hermes-Function-Calling
- vLLM 工具调用文档（`hermes` 解析器、Qwen 模型、自动工具选择）：https://docs.vllm.ai/en/latest/features/tool_calling/
