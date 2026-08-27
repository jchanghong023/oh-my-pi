# Kimi K2 工具调用格式

Moonshot AI **Kimi K2** 系列（`moonshotai/Kimi-K2-Instruct` 与 `-Base`，`model_type: "kimi_k2"`，1T 参数 MoE）的原生工具调用约定。它是一种基于 TikToken 分词器（16 万词表）构建的类 ChatML 信封：每一轮都形如 `<|im_{class}|>{name}<|im_middle|>{body}<|im_end|>`，工具调用则在助手轮内部、由专门的 `<|tool_calls_section_begin|>…<|tool_calls_section_end|>` 块包裹发出。所有控制 token 都是纯 ASCII 的 `<|…|>` 形式（不像 DeepSeek 那样存在全角/Unicode 变体）。推理服务器通过解析器将原始流转换为 OpenAI 风格的 `tool_calls`：vLLM 与 SGLang 都提供 `--tool-call-parser kimi_k2`（vLLM 还需要额外加上 `--enable-auto-tool-choice`）。聊天模板（独立 `ch…

本文档已根据模型卡、官方 `docs/tool_call_guidance.md` 与 `docs/deploy_guidance.md`（GitHub `MoonshotAI/Kimi-K2`）、HF 仓库的原始 `chat_template.jinja` 和 `tokenizer_config.json`（本地渲染以获取以下字节级精确流），以及 vLLM `kimi_k2` 工具解析器源码进行了核对。

## 特殊 token

手动解析所需的五个工具调用标记，外加 ChatML 信封标记。Token ID 取自 `tokenizer_config.json`（`added_tokens_decoder`）。

| Token（原文） | ID | 用途 |
|---|---|---|
| `<\|tool_calls_section_begin\|>` | 163595 | 在助手轮内部开启工具调用段 |
| `<\|tool_call_begin\|>` | 163597 | 开启单个工具调用 |
| `<\|tool_call_argument_begin\|>` | 163598 | 分隔工具调用 ID 与其 JSON 参数 |
| `<\|tool_call_end\|>` | 163599 | 结束单个工具调用 |
| `<\|tool_calls_section_end\|>` | 163596 | 结束工具调用段 |
| `<\|im_system\|>` | 163594 | system 类轮次的起始标记（`system`、`tool`、`tool_declare`） |
| `<\|im_user\|>` | 163587 | 用户轮的起始标记 |
| `<\|im_assistant\|>` | 163588 | 助手轮的起始标记 |
| `<\|im_middle\|>` | 163601 | 分隔角色/名称头与消息正文 |
| `<\|im_end\|>` | 163586 | 结束任意轮次 |
| `[BOS]` | 163584 | 序列起始 token（见注释；聊天模板不会发出） |
| `[EOS]` | 163585 | 序列结束 token |

关于精确性的说明：
- 五个工具 token 使用 ASCII 管道符 `|`（U+007C）和下划线；请精确复现。Kimi K2 中不存在全角管道符（`｜`）或 `▁` 变体。
- `<|im_middle|>` 是唯一一个 ID（163601）与其他（163586–163599）不在同一序列中的信封 token；`163600` 槽位未被使用。
- 图像输入通过内容宏渲染为字面序列 `<|media_start|>image<|media_content|><|media_pad|><|media_end|>`。这些媒体标记出现在模板中，但 **并未** 在 `added_tokens_decoder` 中注册，因此它们会按普通文本进行分词，而非作为单一特殊 token。它们与文本工具调用无关，此处列出仅为完整起见。

## 角色 / 通道 / 轮次结构

Kimi K2 使用类 ChatML 信封。每条消息渲染为：

```text
<|im_{class}|>{name}<|im_middle|>{body}<|im_end|>
```

- 恰好有 **三个** 起始标记 token，由 `role` 选择：
  - `user` → `<|im_user|>`
  - `assistant` → `<|im_assistant|>`
  - 其他（`system`、`tool`，以及合成的 `tool_declare`）→ `<|im_system|>`
- 标记与 `<|im_middle|>` 之间的 `{name}` 段为 `message.name or message.role`。这是 Kimi K2 唯一的"通道"/子角色标签。对于普通轮次，它就是字面的 `system`、`user` 或 `assistant`；对于工具结果轮次，它在提供时为工具的 `name`（即函数名），否则为 `tool`；对于工具 schema 轮次，它为字面的 `tool_declare`。
- `<|im_end|>` 终止每一轮。聊天模板 **不会** 发出 `[BOS]`/`[EOS]`；轮次边界仅由 `<|im_*|>` 标记构成（分词器基于 TikToken，`add_bos_token`/`add_eos_token` 未设置，手动解析流程会将渲染好的模板直接送入 `/completions`）。
- **默认系统提示：** 若首条消息不是 `system` 消息，模板会在第一轮之前注入 `<|im_system|>system<|im_middle|>You are Kimi, an AI assistant created by Moonshot AI.<|im_end|>`。
- **生成提示：** 当 `add_generation_prompt=True` 时，模板以 `<|im_assistant|>assistant<|im_middle|>` 结尾，模型从该处继续生成。
- **思考/推理：** `Kimi-K2-Instruct` 是"反射级"模型，没有长思考，因此该格式中没有推理通道。（思考变体另行处理——vLLM 提供一个独立的 `kimi_k2` 推理解析器，以 `</think>` token 为键——但这超出了本文档所涉及的 Instruct 工具调用格式范围。）

## 工具定义

可用工具通过一条专用轮次在提示词最顶端（任何 system/user 轮之前）声明，使用合成的 `tool_declare` 子角色并置于 `<|im_system|>` 标记下：

```text
<|im_system|>tool_declare<|im_middle|>{TOOLS_JSON}<|im_end|>
```

`{TOOLS_JSON}` 是标准 OpenAI 风格的 `tools` 数组，使用 **紧凑分隔符** `(',', ':')`（不含空格）序列化为 JSON。数组元素原样透传，即每个元素为 `{"type":"function","function":{"name":…,"description":…,"parameters":{…}}}`，其中 `parameters` 是一个 JSON-Schema 对象。示例（单个工具，与实际发出内容完全一致）：

```text
<|im_system|>tool_declare<|im_middle|>[{"type":"function","function":{"name":"get_weather","description":"Get weather information. Call this tool when the user needs to get weather information","parameters":{"type":"object","required":["city"],"properties":{"city":{"type":"string","description":"City name"}}}}}]<|im_end|>
```

`tool_declare` 轮仅在 `tools` 非空时渲染。

## 工具调用格式

当模型决定调用函数时，它会在助手轮内部、任何自然语言内容之后，发出一个工具调用段。最简单的单次调用（这是 `<|im_assistant|>assistant<|im_middle|>` 之后的助手生成内容）：

```text
<|tool_calls_section_begin|><|tool_call_begin|>functions.get_weather:0<|tool_call_argument_begin|>{"city": "Beijing"}<|tool_call_end|><|tool_calls_section_end|>
```

单次调用的结构：

```text
<|tool_call_begin|>  functions.{func_name}:{idx}  <|tool_call_argument_begin|>  {JSON arguments}  <|tool_call_end|>
```

- 位于 `<|tool_call_begin|>` 与 `<|tool_call_argument_begin|>` 之间的 token 是 **工具调用 ID**，固定形式为 `functions.{func_name}:{idx}`。
  - `functions.` 是字面前缀（并非由工具 schema 派生）。
  - `{func_name}` 是被调函数的名称；函数名是通过从该 ID 中解析回出得到，而不是来自单独的字段。
  - `{idx}` 是当前助手轮内的 **从 0 开始的调用索引**（第一次调用为 `0`，第二次为 `1`，……）。
- 在 `<|tool_call_argument_begin|>` 之后是原始 JSON 参数对象（例如 `{"city": "Beijing"}`），由 `<|tool_call_end|>` 终止。
- 当前轮的所有调用位于同一对 `<|tool_calls_section_begin|>` / `<|tool_calls_section_end|>` 之间。助手文本内容出现在 `<|tool_calls_section_begin|>` 之前。
- 整个助手轮仍由 `<|im_end|>` 关闭，且补全结果的 `finish_reason` 变为 `tool_calls`。

## 多次 / 并行工具调用

同一轮中的两次或更多调用以连续的 `<|tool_call_begin|>…<|tool_call_end|>` 块形式发在同一段内，索引随每次调用递增。两个并行调用的原始助手输出：

```text
<|tool_calls_section_begin|><|tool_call_begin|>functions.get_weather:0<|tool_call_argument_begin|>{"city": "Beijing"}<|tool_call_end|><|tool_call_begin|>functions.get_weather:1<|tool_call_argument_begin|>{"city": "Shanghai"}<|tool_call_end|><|tool_calls_section_end|>
```

注意 ID `functions.get_weather:0` 和 `functions.get_weather:1`——同一函数，不同的尾部索引。索引是按轮次计的（在下一个助手轮重置为 `0`）。

## 工具结果格式

工具执行结果作为 `role: "tool"` 的轮次回传。因为 `tool` 既不是 `user` 也不是 `assistant`，所以它在 `<|im_system|>` 标记下渲染；子角色标签为该消息的 `name`（函数名），若未提供则为 `tool`。正文是一行字面的 `## Return of {tool_call_id}` 头，后跟结果内容：

```text
<|im_system|>get_weather<|im_middle|>## Return of functions.get_weather:0
{"weather": "Sunny"}<|im_end|>
```

- `{tool_call_id}` 回显原始调用中的精确 ID（`functions.get_weather:0`），模型借此将结果与产生它的调用关联起来。
- 结果 `content` 紧接在头之后的行原样插入；调用方通常传入 JSON 字符串（例如 `json.dumps(tool_result)`）。
- 如果 `tool` 消息省略 `name`，则信封变为 `<|im_system|>tool<|im_middle|>## Return of …`。

## 端到端示例

完整的多轮天气交互。这些是精确的渲染流（system 和 user 显式提供；轮次内的换行是字面的，轮次之间则是连续的）。

**阶段 1 — 输入模型的提示词**（已设置 `tools`，`add_generation_prompt=True`）：

```text
<|im_system|>tool_declare<|im_middle|>[{"type":"function","function":{"name":"get_weather","description":"Get weather information. Call this tool when the user needs to get weather information","parameters":{"type":"object","required":["city"],"properties":{"city":{"type":"string","description":"City name"}}}}}]<|im_end|><|im_system|>system<|im_middle|>You are Kimi, an AI assistant created by Moonshot AI.<|im_end|><|im_user|>user<|im_middle|>What's the weather like in Beijing today? Use the tool to check.<|im_end|><|im_assistant|>assistant<|im_middle|>
```

**助手生成**（模型输出；服务器报告 `finish_reason: "tool_calls"`）：

```text
<|tool_calls_section_begin|><|tool_call_begin|>functions.get_weather:0<|tool_call_argument_begin|>{"city": "Beijing"}<|tool_call_end|><|tool_calls_section_end|><|im_end|>
```

**阶段 2 — 下一轮的提示词**，在追加了助手工具调用轮和工具结果轮之后（`add_generation_prompt=True`）：

```text
<|im_system|>tool_declare<|im_middle|>[{"type":"function","function":{"name":"get_weather","description":"Get weather information. Call this tool when the user needs to get weather information","parameters":{"type":"object","required":["city"],"properties":{"city":{"type":"string","description":"City name"}}}}}]<|im_end|><|im_system|>system<|im_middle|>You are Kimi, an AI assistant created by Moonshot AI.<|im_end|><|im_user|>user<|im_middle|>What's the weather like in Beijing today? Use the tool to check.<|im_end|><|im_assistant|>assistant<|im_middle|><|tool_calls_section_begin|><|tool_call_begin|>functions.get_weather:0<|tool_call_argument_begin|>{"city": "Beijing"}<|tool_call_end|><|tool_calls_section_end|><|im_end|><|im_system|>get_weather<|im_middle|>## …
{"weather": "Sunny"}<|im_end|><|im_assistant|>assistant<|im_middle|>
```

**最终助手生成**（模型产生自然语言回答并以 `<|im_end|>` 结束；`finish_reason: "stop"`）：

```text
It's sunny in Beijing today.<|im_end|>
```

## OpenAI 兼容 API 映射

启用服务器解析器（`--tool-call-parser kimi_k2`）后，原始流按如下方式映射到 Chat Completions 形式：

- 当该轮包含工具调用段时，`choices[].finish_reason` = `"tool_calls"`（否则为 `"stop"`）。
- `choices[].message.tool_calls[]` —— 每个 `<|tool_call_begin|>…<|tool_call_end|>` 块对应一项：
  - `.id` = 原始调用 ID（原文），例如 `"functions.get_weather:0"`。
  - `.type` = `"function"`。
  - `.function.name` = 从 ID 中解析出的函数名。vLLM 通过 `id.split(":")[0].split(".")[-1]` 计算 → `"get_weather"`。
  - `.function.arguments` = 一个 **JSON 字符串**（即 `<|tool_call_argument_begin|>` 与 `<|tool_call_end|>` 之间捕获的原始文本），例如 `"{\"city\": \"Beijing\"}"`。客户端在使用前需 `json.loads()`。
- 工具结果按以下形式的消息回传：

  ```json
  {"role": "tool", "tool_call_id": "functions.get_weather:0", "name": "get_weather", "content": "{\"weather\": \"Sunny\"}"}
  ```

  `tool_call_id` 必须等于该调用返回的 `id`；`name` 成为 `<|im_system|>{name}<|im_middle|>` 子角色；`content` 成为 `## Return of …` 之后的正文。
- 流式响应：增量通过 `choices[].delta.tool_calls[]` 到达并带有 `index`；函数 `name`/`id` 在调用头完成后一次性流出，随后 `function.arguments` 以增量字符串片段形式流出以待拼接（标准 OpenAI 工具调用流式装配）。

Moonshot 的托管 API（`platform.moonshot.ai`）同时提供 OpenAI 兼容与 Anthropic 兼容端点；其中 Anthropic 兼容端点将温度按 `real_temperature = request_temperature * 0.6` 缩放。`Kimi-K2-Instruct` 的推荐采样温度为 `0.6`。

## 解析注意事项与陷阱

- **ID → 名称的解析在不同参考中不同。** 官方
  `tool_call_guidance.md` 使用 `function_id.split('.')[1].split(':')[0]`，
  而 vLLM 与 omp 取冒号前最后一个点分段的子串。
  后者能容忍额外的命名空间段，但两种约定
  都不能保留字面的点作为函数名的一部分；工具名应当遵循
  文档化的 `functions.{name}:{idx}` 形式，且 `{name}` 中
  不含点。
- **抽取正则也不同。** 指南：`<\|tool_call_begin\|>\s*(?P<tool_call_id>[\w\.]+:\d+)\s*<\|tool_call_argument_begin\|>\s*(?P<function_arguments>.*?)\s*<\|tool_call_end\|>`。vLLM：ID 类为 `[^<]+:\d+`，参数主体使用负向先行断言 `(?:(?!<\|tool_call_begin\|>).)*?`，以避免相邻调用被合并。两者都使用 `DOTALL` 模式运行。
- **`skip_special_tokens` 必须为 False。** 解析器依赖字面标记文本在 detokenize 后仍然存在；vLLM 在启用工具且 `tool_choice != "none"` 时强制将 `skip_special_tokens = False`。若标记被剥离，将检测不到任何工具调用。
- **参数是未经校验的原始文本。** 模型在参数标记与 `<|tool_call_end|>` 之间发出的任何内容都会原样作为 `arguments` 字符串透传；它对于下游 `json.loads` 必须是合法 JSON，且模型可能发出格式错误/截断的 JSON。执行前请校验。
- **索引语义。** `{idx}` 是从 `0` 开始的每轮调用计数器；它不是全局计数器，且每个助手轮都会重置。不要假设 ID 在多轮之间唯一——持久化历史时请按轮消歧。
- **流式标记拆分。** 段标记与调用标记可能被拆到 token 边界之间。
  vLLM 会暂留任何部分匹配标记的尾部后缀，再流出
  参数片段。omp 自有的扫描器也会暂留部分标记，但会缓冲
  单次调用的参数直至 `<|tool_call_end|>`，并且不发出 `toolArgDelta` 事件。
- **`finish_reason` 因引擎而异。** 官方指南明确警告，工具调用的终止 `finish_reason`"可能因引擎而异"；应以 `finish_reason == "tool_calls"` 为循环条件，但需做防御性处理。
- **引擎回退。** Kimi K2 复用了 DeepSeek-V3 架构；`config.json` 设置 `model_type: "kimi_k2"`，因此引擎会应用正确的解析器。如果你将 `model_type: "deepseek_v3"` 强行作为兼容性兜底，则没有原生的 Kimi 工具解析器可用，必须手动解析 `<|tool_calls_section_*|>` 标记。
- **解析器可用性。** vLLM 同时提供 Python（`KimiK2ToolParser`）和较新的 Rust 工具解析器；SGLang 实现自己的 `kimi_k2` 解析器。两者都基于相同的五个标记以及本文档所述的 `functions.{name}:{idx}` ID 约定。
- **空白伪影。** 若未提供 `system` 消息，模板会注入默认系统提示，并在第一个 `<|im_user|>` 标记之前出现少量 `\n  `（换行+两空格）。这无害（分词会绕过标记），但显式提供 system 消息可得到上文所示的干净流。

## omp / pi 转换器行为

仓库的 `kimi` 方言是一个 **自有带内转换器**。通过
`PI_DIALECT=kimi`（或等效的代理配置）启用。当存在工具时，
代理会将 Kimi 指南与紧凑工具目录追加到系统提示中，
移除原生 provider 工具，将先前的调用/结果以 Kimi 文本形式
改写，并将流式输出转换回规范的 pi 事件。
Kimi 系列模型的亲和性解析到该方言。

渲染器为每次助手调用批渲染一个段。它会保留
已以 `functions.` 开头的既有 id；否则生成：
`functions.{name}:{batchIndex}`。工具结果以连续的
`<|im_system|>{name}<|im_middle|>## Return of …<|im_end|>` 轮次渲染，规范的
工具结果消息会合并为一条包含该文本的合成用户消息。

扫描器仅识别段内的调用。一旦参数标记到达，
它会将原始头部作为调用 id 保留，并从第一个冒号前的
最后一个点分段派生名称，然后发出 `toolStart`。
它会将参数主体缓冲至 `<|tool_call_end|>`，然后应用共享的
修复型 JSON 解析器并发出 `toolEnd`；它 **不会** 发出增量
参数增量。无效/非对象的已完成参数会规范化为 `{}`。
若 EOF 在 `toolStart` 之后、但在关闭标记之前到达，则不会发出 `toolEnd`，
但规范的 `{}` 调用仍然存在，并可能在正常停止时被派发。
只有从未到达参数标记的不完整输入会被丢弃而不创建调用。
段标记会在可见文本中抑制，而段外的孤立调用标记仍为普通文本。

思考解析默认启用，并将 `<think>…</think>` 映射为思考事件。
`parseThinking: false` 会将这些标签及其内容保留在可见
文本中。

## 参考来源

- 模型卡（Tool Calling 部分、OpenAI 风格示例、部署/API 说明）：https://huggingface.co/moonshotai/Kimi-K2-Instruct
- 官方工具调用指南（标记、ID 约定、手动解析器、`extract_tool_call_info`）：https://raw.githubusercontent.com/MoonshotAI/Kimi-K2/main/docs/tool_call_guidance.md（HF 的 `resolve`/`blob` 路径会重定向到模型卡；本文已根据该 GitHub 原始文件进行核对）
- 部署指南（`--tool-call-parser kimi_k2`、`--enable-auto-tool-choice`、SGLang 参数、`model_type` 兜底）：https://raw.githubusercontent.com/MoonshotAI/Kimi-K2/main/docs/deploy_guidance.md
- 聊天模板（`chat_template.jinja`，本地渲染以获取字节级精确流）：https://huggingface.co/moonshotai/Kimi-K2-Instruct/resolve/main/chat_template.jinja
- 分词器配置（`added_tokens_decoder` 中的特殊 token ID）：https://huggingface.co/moonshotai/Kimi-K2-Instruct/resolve/main/tokenizer_config.json
- vLLM `kimi_k2` 工具解析器（标记、正则、名称解析、`skip_special_tokens`、流式）：https://github.com/vllm-project/vllm/blob/main/vllm/tool_parsers/kimi_k2_tool_parser.py
- vLLM 添加该解析器的 PR：https://github.com/vllm-project/vllm/pull/20789
- vLLM 工具调用文档：https://docs.vllm.ai/en/latest/features/tool_calling/
