# 系统提示词自定义

本文说明编码智能体如何组装其系统提示词，以及用户可以通过 `SYSTEM.md`、`APPEND_SYSTEM.md`、`TITLE_SYSTEM.md` 以及对应的 CLI 标志控制哪些内容。

主要实现位置：

- `packages/coding-agent/src/main.ts`（`discoverSystemPromptFile`、`discoverAppendSystemPromptFile`、`applyResolvedSystemPromptInputs`）
- `packages/coding-agent/src/sdk.ts`（`CreateAgentSessionOptions`，提示词构建）
- `packages/coding-agent/src/system-prompt.ts`（`buildSystemPrompt`、`resolvePromptInput`）
- `packages/coding-agent/src/prompts/system/system-prompt.md`（默认指令模板）
- `packages/coding-agent/src/prompts/system/custom-system-prompt.md`（当 `SYSTEM.md` 生效时使用的模板）
- `packages/coding-agent/src/prompts/system/project-prompt.md`（项目/环境尾部内容）

## 输入与优先级

| 输入                                      | 来源                 | 作用                                                                                                     |
| ----------------------------------------- | -------------------- | -------------------------------------------------------------------------------------------------------- |
| `--system-prompt <text-or-file>`          | CLI                  | 使用内置的自定义提示词模板替代默认指令模板。优先级最高。                                                 |
| `SYSTEM.md`                               | 自动发现的配置文件   | 与上述标志相同的模板切换；在标志未提供时使用。                                                           |
| `--append-system-prompt <text-or-file>`   | CLI                  | 向渲染后的提示词追加文本。追加优先级最高。                                                               |
| `APPEND_SYSTEM.md`                        | 自动发现的配置文件   | 与追加标志效果相同；在标志未提供时使用。                                                                 |

`SYSTEM.md` 和 `APPEND_SYSTEM.md` 按项目优先、用户级次之的顺序查找。在每个作用域内，配置基础目录的顺序为 `.omp`、`.claude`、`.codex`、`.gemini`：

1. `<cwd>/.omp/<file>`、`<cwd>/.claude/<file>`、`<cwd>/.codex/<file>`、`<cwd>/.gemini/<file>`
2. `~/.omp/agent/<file>`、`~/.claude/<file>`、`~/.codex/<file>`、`~/.gemini/<file>`

原生用户路径遵循当前激活的 profile：使用 `omp --profile work` 时，`~/.omp/agent` 变为 `~/.omp/profiles/work/agent`。`PI_CONFIG_DIR` 用于更改原生配置目录的名称。此共享配置查找不会将 `PI_CODING_AGENT_DIR` 作为任意的替代基础目录使用。

发现过程**不会**向父目录逐级查找。在 `<repo>/packages/api` 启动 OMP 并不会发现 `<repo>/.omp/SYSTEM.md`；请从 `<repo>` 启动，将文件放到当前目录的配置基础目录下，或使用用户级文件。有关共享配置目录的约定，请参阅 [配置使用](./config-usage.md)。

标志的优先级高于任何自动发现的文件。对于每个文件名，项目作用域优先于用户作用域；在同一作用域内，按上述顺序中靠前的配置基础目录优先。

### 文本或文件的解析

对于单行值，OMP 首先尝试将该值作为文件路径读取。如果读取失败的原因是路径不存在（或路径过长），则按字面值使用该值。包含换行的值不进行文件读取，直接按字面值使用。其他文件读取失败会被记录，原始值仍按字面值使用。

## `SYSTEM.md` 所替换的内容

`SYSTEM.md` 并不会作为原始的、唯一的系统消息。CLI 将其存储为 `CreateAgentSessionOptions.customSystemPrompt`，`buildSystemPrompt` 会渲染 `custom-system-prompt.md` 而非默认的 `system-prompt.md`。

自定义模板保留以下生成的内容板块：

- 自定义文本以及任何追加文本；
- 自动发现的上下文文件；
- 自动发现的技能；
- 始终应用的规则以及规则集清单；
- 启用时的密钥脱敏指引。

独立的项目/环境尾部内容仍然保留，并承载工作站数据、更深层目录的上下文指针、可选的工作区信息以及最终的完成要求。可选的额外系统块（例如计算机工具安全提示、当前嵌套仓库上下文）也仍会在适用时保留。

当前日期与工作目录不再存放在尾部内容中：它们在每次 provider 请求的首次用户轮次中以 `<system-reminder>` 块的形式发出（`date-cwd-reminder.md`）。将每次请求的字节内容移出系统提示词，可以使在系统内容之后渲染工具 schema 的开放权重 provider（DeepSeek、Qwen、GLM 等）保持其前缀缓存，并允许跨越午夜的会话在不重建提示词的情况下刷新日期（#7404）。

消失的是默认指令模板特有的内容：其内置的角色/人格文本、工具清单与通用工具策略、内部 URL 目录、探索/委派/工作流规则，以及 `xd://` 协议指引。生成的技能和规则**不会**丢失；自定义模板会显式渲染它们。

由此带来的影响：

- 若希望添加少量指令同时保留完整的默认提示词，请仅使用 `APPEND_SYSTEM.md` 或 `--append-system-prompt`。
- 若希望替换默认指令模板同时保留生成的项目上下文、技能和规则，请使用 `SYSTEM.md` 或 `--system-prompt`。
- 如果自定义提示词仍需要默认的工具策略或工作流，请自行复制并维护所需的指引；不支持从 `system-prompt.md` 中进行选择性继承。

### 追加内容的放置

没有 `SYSTEM.md` 时，追加文本会渲染在 `project-prompt.md` 的末尾，位于默认指令块以及项目/环境内容之后。

有 `SYSTEM.md` 时，追加文本会渲染在 `custom-system-prompt.md` 中紧随自定义文本之后的位置。上下文、技能和规则紧随其后，独立的项目/环境尾部内容再随其后。模板会防止追加文本与上下文文件被重复发出。

SDK 生成的追加内容（用于已启用的记忆/自动学习功能以及 MCP 指引）会在用户提供追加文本之前进行合并。

## 纯文本约定

`SYSTEM.md`、`APPEND_SYSTEM.md`、`--system-prompt` 和 `--append-system-prompt` 都是纯文本。它们作为值被插入到内置的 Handlebars 模板中；其内容不会作为 Handlebars 进行递归编译。

例如，如果 `SYSTEM.md` 包含：

```handlebars
Working in
:{{cwd}}
on
:{{date}}.
:{{#if hasMemoryRoot}}Memory enabled.{{/if}}
```

这些字符会按原样传递给模型。诸如 `cwd`、`skills`、`rules`、`toolRefs` 之类的内部值是模板的私有实现细节，并非用户的模板 API。日历日期已被刻意不再作为模板值暴露——它通过每次请求首次轮次的提醒来承载（见上文）。

## 实践示例

### 向默认提示词添加规则

创建 `APPEND_SYSTEM.md`，不创建 `SYSTEM.md`：

```text
# ~/.omp/agent/APPEND_SYSTEM.md
Prefer Bun APIs over Node APIs in this project.
When you change a public function, run `bun check` before yielding.
```

### 提供自定义基础提示词

```text
# <cwd>/.omp/SYSTEM.md
You are a code reviewer. Read changes, surface concrete issues, and never edit files.
Cite paths with backticks.
```

OMP 仍会添加生成的上下文、技能、规则以及项目/环境尾部内容，但不会添加默认指令模板中的工具与工作流指引。

### 替换人格块

默认模板会渲染由 `personality` 设置（`default`、`friendly`、`pragmatic`、`none`）选择的人格块。用户级的 `PERSONALITY.md` 会替换所选预设的文本：

```text
# ~/.omp/agent/PERSONALITY.md
Follow ASD-STE100 Simplified Technical English for all responses.
```

仅检查 agent 目录（默认为 `~/.omp/agent`；支持 profile 和 XDG）——不进行项目级或其他配置基础目录的查找。`personality: none` 仍会完全省略该块（子智能体始终以 `none` 运行），而空文件或无法读取的文件会回退到已配置的预设，并记录一条警告。

### 自定义自动会话标题

`SYSTEM.md` 和 `APPEND_SYSTEM.md` 不会影响标题生成调用。请使用 `TITLE_SYSTEM.md`：

```text
# ~/.omp/agent/TITLE_SYSTEM.md
Generate a session name using lowercase `<type>:<primary-objective>`.
If the message has no concrete task, output exactly `none`.
```

`TITLE_SYSTEM.md` 使用相同的项目优先、配置基础目录发现机制以及不向父目录查找的行为。当其不存在时，OMP 使用内置的标题提示词。该覆盖同时用于初始自动标题以及由 replan 驱动的标题刷新。

即使使用自定义提示词，生成的标题输出也遵循强制性的规范化约定。OMP 仅考虑首个去除首尾空白后的行，剥去外层引号、`<title>...</title>` 标记以及末尾标点，并将 `none` 或 `<title/>` 视为“尚无标题”。超过 80 个字符或 12 个词的结果会被拒绝，而非截断。空、延迟或被拒绝的输出会使会话保持未命名状态，以便后续符合条件的标题尝试可以为其命名。

## 完全面向 provider 的替换（仅 SDK）

`CreateAgentSessionOptions.systemPrompt` 是一个不同的、更底层的 API。传入字符串或数组可以替换完全渲染后的默认块；传入回调会接收已渲染的块数组并返回其替换内容。这可以省略所有生成的上下文块与安全块。

CLI 标志和文件**不会**设置此属性：它们设置的是 `customSystemPrompt` 和 `appendSystemPrompt`，这些仍会经过上文所述的内置模板处理。

## 速查表

| 目标                                                                                  | 使用方式                                                                   |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| 在保留完整默认提示词的同时添加指令                                                    | `APPEND_SYSTEM.md` 或 `--append-system-prompt`                             |
| 替换默认指令模板但保留生成的上下文、技能和规则                                        | `SYSTEM.md` 或 `--system-prompt`                                           |
| 替换所有面向 provider 的系统块                                                        | SDK `CreateAgentSessionOptions.systemPrompt`                               |
| 自定义自动会话标题                                                                    | `TITLE_SYSTEM.md`                                                          |
| 替换人格块同时保留默认提示词的其余部分                                                | `PERSONALITY.md`                                                           |
| 在用户文件中使用 `{{cwd}}` 或其他内部变量                                            | 不支持；用户内容按原样插入                                                 |
| 继承默认模板中的选定片段                                                              | 不支持；请向默认提示词追加或自行复制所需文本                               |
| 按目录覆盖                                                                            | 在用于启动 OMP 的 cwd 下直接放置一个受支持的配置基础目录                   |
| 全局覆盖                                                                              | 当前激活的原生 agent 目录，或其他受支持的用户配置基础目录                 |
