# 上下文文件

上下文文件是 `omp` 在会话开始前自动发现并注入 agent 项目上下文的 Markdown 指令文件。可用于存放仓库规范、架构说明、测试与评审期望，以及应当随用户账号或项目一同携带的指令。

你永远不需要开口让 agent 去读取 `AGENTS.md`、`CLAUDE.md`、`GEMINI.md` 或类似文件 —— 相关文件在会话开始时就已经被发现、加载并放入上下文。

## 上下文文件与其他概念的关系

四个名字相近的概念行为各不相同。请注意区分：

- **上下文文件** 以纯 Markdown 形式读取，并在生成的项目指令中（使用默认提示词模板时位于 `<repo-rules>` 内）展示给 agent。它们是会话开场指令，也是仓库工作的背景信息。
- **粘性规则** 来自顶层的原生 `RULES.md`。它们会被转换为一条 always-apply 规则，其完整正文随每一次请求携带，因此始终留在上下文中，即使可见对话不断变长也持续保持效力。详见下文的「粘性规则与普通上下文的区别」。
- **发现 provider** 是知道每个工具把文件放在哪里的配置源适配器。完整注册表为 `native`、`omp-plugins`、`claude`、`agent-plugins`、`codex`、`agents`、`claude-plugins`、`gemini`、`opencode`、`cursor`、`windsurf`、`cline`、`github`、`vscode`、`agents-md`、`mcp-json`、`ssh-json` 和 `builtin-defaults`。其中只有一部分贡献上下文文件（`native`、`claude`、`codex`、`gemini`、`opencode`、`github`、`agents`、`agents-md`）；其余贡献其他能力，例如规则、MCP 服务器、skill、命令、hook、工具或 SSH 主机。贡献上下文文件的同一个 provider 也可能同时贡献 MCP 服务器、斜杠命令、skill、hook、工具、提示词和设置。
- **模型 provider** 是推理后端，例如 `anthropic`、`openai`、`google`、`groq`、`ollama` 和 `openrouter`。它们与上下文文件毫无关系，唯一交集是这两类 id 共享同一个 `disabledProviders` 列表 —— 详见下文的「禁用发现 provider」和 [Providers](./providers.md)。

**skill** 与**规则**文件（区别于粘性的 `RULES.md`）的编写方式见 [Skills](./skills.md)。用 `SYSTEM.md` 自定义系统提示词见 [System prompt customization](./system-prompt-customization.md)。

## 原生 `.omp` 文件

原生 provider 是新项目推荐的格式。它会从你的用户 agent 目录和项目内的 `.omp/` 目录读取文件，并且拥有最高的发现优先级，因此其文件在同一作用域下胜过所有其他约定。

| 文件                                          | 作用域 | 行为                                                                                                                                                                                                                                              |
| --------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `~/.omp/agent/AGENTS.md`                      | 用户   | 用户级上下文，适用于每个会话，除非 `native` provider 被禁用。                                                                                                                                                                                      |
| `<nearest-non-empty-ancestor>/.omp/AGENTS.md` | 项目   | 项目上下文，但仅当从 cwd 向仓库根目录上溯过程中找到的**最近一个非空 `.omp/` 目录**中存在 `AGENTS.md` 时才会读取。最近的目录缺少此文件时，OMP 不会继续前往更远的 `.omp/` 目录。                                                                    |
| `~/.omp/agent/RULES.md`                       | 用户   | 用户级粘性规则内容。作为 always-apply 规则加载，而不是上下文文件。                                                                                                                                                                                |
| `<nearest-non-empty-ancestor>/.omp/RULES.md`  | 项目   | 项目粘性内容，但仅当同一次上溯选定的最近非空 `.omp/` 目录中存在 `RULES.md` 时才会读取。                                                                                                                                                          |

有两个细节需要注意：

- **最近一个非空的 `.omp/` 目录主导原生项目发现。** 发现从当前工作目录开始，向仓库根目录上溯。一旦找到非空的 `.omp/`，便停止；原生的 `AGENTS.md` 和 `RULES.md` 都只从该目录读取。文件缺失并不会让发现继续向上。
- **空目录和空文件不贡献任何内容。** 上溯过程中空的 `.omp/` 目录会被跳过。在选定的非空目录中，空的 `AGENTS.md` 或 `RULES.md` 也不贡献任何内容。

`~/.omp/agent` 是当前原生 agent 目录的简写。`PI_CODING_AGENT_DIR` 可重定位它。命名 profile（`omp --profile <name>`、`OMP_PROFILE` 或 `PI_PROFILE`）默认使用 `~/.omp/profiles/<name>/agent`；外部工具的用户基础目录（例如 `~/.claude`）不受 profile 作用域影响。

### Monorepo 示例

```text
repo/
  .omp/
    AGENTS.md
    RULES.md
  packages/api/
    .omp/
      AGENTS.md
```

在 `repo/packages/api` 中启动会话时：

- 原生上下文文件是 `repo/packages/api/.omp/AGENTS.md`（最近的那一个）。`repo/.omp/AGENTS.md` **不会**被同时包含。
- 由于 `repo/packages/api/.omp/` 是最近非空的原生目录，项目粘性内容只能来自 `repo/packages/api/.omp/RULES.md`。如果该文件不存在，则**不会**使用 `repo/.omp/RULES.md`。

把广泛而持久的项目背景放进 `AGENTS.md`。把 `RULES.md` 留给那些必须在长对话中始终可见的简短硬性要求。

## 其他支持的上下文约定

`omp` 也会发现其他 agent 工具的上下文与规则文件，让既有项目无需迁移即可继续工作。

| Provider id | 约定路径                                    | 作用域         | 备注                                                                                                                                                                                                                                                                                                                                                          |
| ----------- | ------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `native`    | `.omp/AGENTS.md`                            | 用户 + 项目    | 推荐的 OMP 格式。用户文件位于当前原生 agent 目录；项目文件仅从向仓库根目录上溯找到的最近非空 `.omp/` 目录读取。                                                                                                                                                                                                                                                |
| `claude`    | `.claude/CLAUDE.md`                         | 用户 + 项目    | 用户文件为 `~/.claude/CLAUDE.md`；项目文件仅来自 `<cwd>/.claude/CLAUDE.md`（不上溯祖先目录）。                                                                                                                                                                                                                                                                |
| `codex`     | `.codex/AGENTS.md`                          | 用户           | 仅用户文件 `~/.codex/AGENTS.md`。项目级 Codex 上下文通过 `agents-md` provider 来自独立的 `AGENTS.md`，而不是 `<cwd>/.codex/AGENTS.md`。                                                                                                                                                                                                                        |
| `gemini`    | `.gemini/GEMINI.md`                         | 用户 + 项目    | 用户文件为 `~/.gemini/GEMINI.md`；项目文件仅来自 `<cwd>/.gemini/GEMINI.md`（不上溯祖先目录）。                                                                                                                                                                                                                                                                |
| `opencode`  | `.config/opencode/AGENTS.md`                | 用户           | 仅用户文件 `~/.config/opencode/AGENTS.md`。                                                                                                                                                                                                                                                                                                                    |
| `github`    | `.github/copilot-instructions.md`           | 用户 + 项目    | 项目文件仅来自 `<cwd>/.github/copilot-instructions.md`（不上溯祖先目录），外加一份用户全局的 `~/.copilot/copilot-instructions.md`（可用 `COPILOT_HOME` 重定位）。来自 `COPILOT_CUSTOM_INSTRUCTIONS_DIRS` 的 `AGENTS.md` 候选在用户作用域下同样会被考虑，并适用常规的「单用户文件」去重规则。                                                                    |
| `agents`    | `.agent/AGENTS.md`、`.agents/AGENTS.md`     | 用户 + 项目    | 用户文件来自 `~/.agent/` 和 `~/.agents/`；项目文件在从当前目录向仓库根目录上溯的过程中发现。                                                                                                                                                                                                                                                                  |
| `agents-md` | `AGENTS.md`                                 | 项目           | 独立（非配置目录）的 `AGENTS.md` 文件，通过从当前目录向仓库根目录上溯来发现；当该仓库嵌套在用户主目录之下时，还会继续穿过外层工作区目录，直到（但不包含）主目录。若没有仓库根目录，则对主目录下的会话以主目录作为边界，并包含该边界文件。父目录名以 `.` 开头的文件会被忽略 —— 它们属于某个配置目录 provider。                                                      |
| `claude-md` | `CLAUDE.md`                                 | 项目           | 独立（非配置目录）的 `CLAUDE.md` 文件，通过从当前目录向仓库根目录上溯来发现；当该仓库嵌套在用户主目录之下时，还会继续穿过外层工作区目录，直到（但不包含）主目录。若没有仓库根目录，则对主目录下的会话以主目录作为边界，并包含该边界文件。父目录名以 `.` 开头的文件会被忽略 —— 它们属于某个配置目录 provider。                                                      |
| `github`    | `.github/instructions/**/*.instructions.md` | 项目规则       | GitHub Copilot / VS Code 指令文件会成为规则。`applyTo: '*'`、`applyTo: '**'` 或 `applyTo: '**/*'` 会作为 always-apply 内容注入；其他 `applyTo` glob 会列入规则簿，必要时附带生成的描述，并可作为 `rule://<name>` 读取。缺失 `applyTo` 同样会产生规则簿条目并发出发现警告。                                                                                        |

标记为「不上溯祖先目录」的 provider 只查看当前工作目录下的配置目录。如果你需要祖先目录上溯行为，请优先使用原生 `.omp/AGENTS.md` 格式，或独立的 `AGENTS.md` / `CLAUDE.md`（即 `agents-md` / `claude-md` provider），或者在存放配置目录的那一层目录中启动 `omp`。

发现注册表中还包含完全不贡献上下文文件的 provider：`cursor`（`.cursor/rules/*.mdc` 与旧式 `.cursorrules` 规则，外加 MCP 服务器和设置）、`windsurf`（`.windsurf/rules/*.md`、旧式 `.windsurfrules` 与全局 Windsurf 规则，外加 MCP 服务器）、`cline`（`.clinerules` 规则）、`vscode` 和 `mcp-json`（MCP 服务器）、`claude-plugins`（Claude marketplace 插件：skill、命令、规则、hook、工具、MCP 服务器）、`omp-plugins`（OMP 插件：skill、命令、规则、提示词、hook、工具、MCP 服务器）、`agent-plugins`（Agent Plugins 标准包：skill 与 MCP 服务器）、`ssh-json`（SSH 主机）以及 `builtin-defaults`（内置默认规则）。这些 provider 与规则及其他能力相关，也与下文的共享 `disabledProviders` 开关有关。

## 加载顺序与覆盖

当两个 provider 描述 _同一_ 作用域时，优先级较高的 provider 胜出。完整注册表优先级如下：

| 优先级 | Provider id                        |
| -----: | ---------------------------------- |
|    100 | `native`                           |
|     90 | `omp-plugins`                      |
|     80 | `claude`                           |
|     75 | `agent-plugins`                    |
|     70 | `agents`、`claude-plugins`、`codex` |
|     60 | `gemini`                           |
|     55 | `opencode`                         |
|     50 | `cursor`、`windsurf`               |
|     40 | `cline`                            |
|     30 | `github`                           |
|     20 | `vscode`                           |
|     10 | `agents-md`                        |
|     10 | `claude-md`                        |
|      5 | `mcp-json`、`ssh-json`             |
|      1 | `builtin-defaults`                 |

随后按作用域对发现的文件去重：

- **跨所有 provider 仅保留一个用户上下文文件。** 由于 `native` 拥有最高优先级，`~/.omp/agent/AGENTS.md` 会覆盖其他所有用户级上下文文件。
- **每个目录深度保留一个项目上下文文件。** 深度从当前目录算起：cwd 为深度 0，其父目录为深度 1，依此类推。祖先目录的配置子目录（`.claude/`、`.github/`、`.gemini/` 等）与该祖先目录计为同一深度。
- **在同一深度上，优先级更高的 provider 会覆盖其余文件。**
- **跨深度时，多个文件都会保留。** 在 monorepo 中，祖先 `AGENTS.md` 与 package 级的 `AGENTS.md` 处于不同深度，两者都会加载。
- **字节完全相同的文件会在排序后被合并。** 在项目副本中，最接近 cwd 的那一份保留。唯一保留的用户作用域文件排在项目文件之后，因此当其内容与项目内容完全相同时，改由它保留。

最终注入顺序是 **先注入更远的项目祖先**，然后是更接近 cwd 的项目文件，最后是保留下来的用户作用域文件。越靠后的文件在生成上下文中越接近末尾，也越显眼。

### 覆盖示例演示

```text
repo/
  AGENTS.md
  packages/api/
    AGENTS.md
    .github/copilot-instructions.md
```

在 `repo/packages/api` 中启动：

- `repo/AGENTS.md` 由 `agents-md` 在深度 2 发现并保留。
- `repo/packages/api/AGENTS.md`（`agents-md`，优先级 10）与 `repo/packages/api/.github/copilot-instructions.md`（`github`，优先级 30）都解析到深度 0。GitHub 的优先级更高，覆盖了 package 级的独立 `AGENTS.md`，因此该深度由 Copilot 文件胜出。
- 两份保留文件按「根在前、package 在后」排序，因此 `packages/api` 的文件更显眼。
- 如果你添加 `repo/packages/api/.omp/AGENTS.md`，`native`（优先级 100）将在深度 0 直接胜出，覆盖两个优先级更低的文件。

## 注入行为

使用默认提示词模板时，发现的上下文文件会作为一个 `<repo-rules>` 块注入开场项目提示词，每个保留文件对应一个 `<file>` 元素，按上述排序排列：

```xml
<repo-rules>
You MUST follow the context files below for all tasks:
<file path="/abs/path/to/repo/AGENTS.md">
...root content...
</file>
<file path="/abs/path/to/repo/packages/api/.github/copilot-instructions.md">
...package content...
</file>
</repo-rules>
```

当 `SYSTEM.md` 选用内置的自定义提示词模板时，同样的文件会改为在该模板的 `<project>` / `<instructions>` 部分输出。无论哪种模式，agent 都会看到每个文件的绝对路径以及完全展开的 Markdown 内容（`@` 导入已预先解析）。

加载是自动的 —— 无需在会话中指示 agent 去搜索 `AGENTS.md`、`CLAUDE.md`、`GEMINI.md`、`.cursorrules` 或类似文件。

未被自动加载的更深层目录中的 `AGENTS.md` 文件（例如位于当前目录之下的那些）会在单独的 `<dir-context>` 块中另行呈现，其中列出它们的路径，并告知 agent 在编辑这些目录之前先读取它们。这些文件只是指针，而非完整注入的内容。

## `@` 导入

在任何上下文文件内部，`@path` 标记会在注入前内联展开为被引用文件的内容：

```markdown
# Project notes

Read @docs/architecture.md before changing storage code.
Shared release steps live in @../RELEASE.md and personal aliases in @~/.notes/aliases.md.
```

确切规则如下：

- **相对路径从导入文件自身所在目录解析**，而不是会话的工作目录。
- **`~/` 和 `~`** 从用户主目录解析；绝对路径按原样使用。
- **围栏代码块和行内代码 span 内的标记保持原样** —— 当你想在文中_提及_某个 `@token` 而不展开它时很有用。
- **`git@github.com:org/repo.git` 和 `user@example.com` 形式的标记不会被视为导入。** 只有当 `@` 位于行首，或紧跟在空格或制表符之后时，标记才算作导入。
- **路径末尾的句子标点会被去除**（`. , ; : ! ? ) ] } " '`），因此 `@docs/setup.md.` 导入的是 `docs/setup.md`。
- **导入最多递归五层。** 被导入的文件自身也可以包含 `@` 导入，总深度上限为五。
- **循环会被跳过。** 已经被拉入当前展开树的文件不会被再次展开，因此相互导入可以干净地终止。
- **目标缺失或不可读时，原始 `@token` 文本保持原样**，而不会报错。

## 粘性规则与普通上下文的区别

把大部分指导内容放进普通上下文文件（`AGENTS.md`、`CLAUDE.md`、`GEMINI.md`、`.github/copilot-instructions.md` 等）：仓库概览、代码风格、构建与测试命令、评审期望以及本地约定。这些会加载进开场生成的项目上下文。

把顶层 **`RULES.md`** 留给少数几条硬性要求 —— 即使长对话已经把开场上下文推到对话记录很靠后的位置，它们也必须保持生效：

```markdown
# ~/.omp/agent/RULES.md

Never commit or push unless the user explicitly asks.
Do not edit generated files.
```

`RULES.md` 的特殊之处：

- 它**只**在原生位置读取：当前用户 agent 目录，以及从 cwd 向仓库根目录上溯所选定的最近非空项目 `.omp/` 目录。如果该项目目录中没有 `RULES.md`，OMP 不会回退到更远的 `.omp/RULES.md`。
- 它作为 **always-apply 规则**加载，而不是上下文文件，因此其完整正文随每一次请求携带 —— 绝不会被降级为按需的规则簿条目 —— 并在长会话中持续保持效力。默认情况下它随系统提示词一起传输；在启用了 `snapcompact.systemPrompt` 图像化的视觉模型上，系统提示词（包括这条规则）可能改为以附加图像帧的形式发送，但无论哪种方式，其正文都会随请求携带。
- 它会在会话开始时以及会话级重建（例如 `/clear` 和 `/new`）时从磁盘重新发现，因此在 OMP 运行期间创建或编辑它，会在下一次重置时生效 —— 无需重启。
- 它**始终是粘性的**：frontmatter 无法让它变为非粘性。如果需要条件性或主动启用（opt-in）的行为，请改写普通的规则文件（见 [Skills](./skills.md)）。
- 两个顶层候选都会以规则名 `RULES` 合成，而规则去重是基于名称的。常规情况下，用户 `RULES.md` 会覆盖项目 `RULES.md`；二者不会被拼接。避免把 `.omp/rules/` 或用户 `rules/` 目录下的普通文件命名为 `RULES.md`，因为原生普通规则加载得更早，可能覆盖这两个粘性候选。

保持 `RULES.md` 简短。冗长的背景内容应放进 `AGENTS.md`，在那里只需消耗一次上下文预算。

## 禁用发现 provider

通过 `~/.omp/agent/config.yml`、项目的 `.omp/config.yml` 或 `--config` 覆盖中的 `disabledProviders` 设置来关闭某个 provider：

```yaml
# .omp/config.yml
disabledProviders:
  - claude
  - github
```

`disabledProviders` 是一个**整 provider 级开关，共享同一个 id 命名空间**，被两个互不相关的子系统使用：

| Id 种类       | 示例                                                                              | 被列出时的效果                                                                                                                                                                    |
| ------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 发现 provider id | `native`、`claude`、`codex`、`gemini`、`opencode`、`github`、`agents`、`agents-md`、`claude-md` | 整个配置源都会被移除 —— 不仅是它的上下文文件，还包括它本应贡献的 MCP 服务器、斜杠命令、skill、hook、工具、提示词和设置。                                                           |
| 模型 provider id | `anthropic`、`openai`、`google`、`groq`、`ollama`、`openrouter`                   | 即使凭据存在，模型后端也会从可选范围中移除。见 [Providers](./providers.md)。                                                                                                      |

id 精确匹配，两个命名空间不会意外撞名：`google` 禁用 Google 模型后端，而 `gemini` 禁用 Gemini CLI 的发现文件。禁用发现 provider 的影响比看上去更大 —— 例如禁用 `claude` 会同时丢掉 Claude 发现的 MCP 服务器、命令、skill、hook、工具和设置，而不仅是 `CLAUDE.md`。若只想丢弃那一个上下文文件并保留该 provider 贡献的其他一切，请改用 [`disabledExtensions`](#禁用单个上下文文件)。

只有 `enabledModels` 和 `disabledProviders` 支持**路径作用域**条目，因此你可以按子树调整 provider 的可用性：

```yaml
disabledProviders:
  - github # disabled everywhere
  - path: ~/work/legacy-claude
    providers:
      - claude # disabled only under this directory
```

当 cwd 等于所配置的路径或位于其下时，作用域条目生效；`~` 会展开为主目录。裸字符串条目处处生效。

请记住，优先级更高的设置层会**替换**数组设置，而不是向其追加。如果你的全局配置禁用了 `claude`，但某个项目配置设置了 `disabledProviders: [github]`，那么在该项目内 Claude 发现会被重新启用，只有 GitHub 被禁用。完整的层级优先级、合并规则与路径作用域数组细节见 [Settings](./settings.md)。

## 禁用单个上下文文件

`disabledProviders` 会移除整个配置源。要只丢弃一个上下文文件并保留其 provider 贡献的其余内容，请把它的扩展 id 列入 `disabledExtensions`：

```yaml
# ~/.omp/agent/config.yml, .omp/config.yml, or a --config overlay
disabledExtensions:
  - context-file:user:CLAUDE.md
```

上下文文件 id 形如 `context-file:<level>:<basename>`，其中 `<level>` 是 `user` 或 `project`，`<basename>` 是不含目录部分的文件名：

| Id                                  | 禁用内容                                                                                                 |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `context-file:user:CLAUDE.md`       | 用户级 `CLAUDE.md`；同时 Claude 的 MCP 服务器、命令、skill、hook、工具和设置仍会加载。                    |
| `context-file:project:AGENTS.md`    | **每一个**项目级 `AGENTS.md`，在上溯到达的每一层目录深度都生效 —— id 本身不携带深度。                     |
| `context-file:user:AGENTS.md`       | 每一个用户级名为 `AGENTS.md` 的文件，无论由哪个 provider 提供。                                           |

匹配只依据层级和文件名，因此一个条目就覆盖在该层级提供同名文件的每一个 provider，而且项目条目无法收窄到单个深度。需要按目录控制时，请在需要差异化的子树里放置项目级 `.omp/config.yml`，或使用上文路径作用域的 `disabledProviders` 形式。

禁用不等于覆盖，而且区别看得见：被禁用的文件会在去重之前就被丢弃，因此它不会占据自己的作用域。**原本被它覆盖的文件会取而代之被加载。** 在同时含有 `.claude/CLAUDE.md` 和 `AGENTS.md` 的项目中，`CLAUDE.md` 通常赢得 depth-0 作用域；禁用 `context-file:project:CLAUDE.md` 后，`AGENTS.md` 便成为项目上下文，而不是让该作用域空缺。若要让该作用域完全没有文件，请把每个候选文件名都禁用。

两种日常用法：

- **非交互式运行。** 为自己的交互式会话编写的用户级上下文文件，通常不适合由其他程序驱动的 `-p` 运行，因为后者自带指令。在 `--config` 覆盖中禁用它，可以保持交互式设置不受影响。
- **委托工作。** 当一个 agent 驱动另一个 agent 时，调用方自身的操作指令会作为用户级上下文进入被调用方的提示词，可能与它实际接到的任务相矛盾。

`disabledExtensions` 不支持路径作用域：只有 `enabledModels` 和 `disabledProviders` 接受 `path:` 形式。和所有数组设置一样，它会被更高优先级的层替换而不是合并。

可用 `/extensions` 交互式浏览这些 id，它会列出每个被发现的上下文文件及其层级、来源和当前状态，并可切换同一个设置。

## 故障排查

### 文件未被加载

- 原生项目上下文只从最近非空的 `.omp/` 目录读取。该目录必须包含非空的 `AGENTS.md`；如果没有，发现不会继续前往更远的原生目录。
- 独立的 `CLAUDE.md` 由 `claude-md` 处理，而不是 `native`。
- `.claude/CLAUDE.md`、`.gemini/GEMINI.md` 和 `.github/copilot-instructions.md` 只从当前工作目录的配置目录读取 —— 不会从每个祖先目录读取。
- `~/.codex/AGENTS.md` 和 `~/.config/opencode/AGENTS.md` 仅限用户级，没有项目级对应物。
- 对于原生和独立 provider，空文件不贡献任何内容。
- 被禁用的发现 provider 不贡献任何内容 —— 请在全局、项目和 `--config` 各层检查 `disabledProviders`。
- 单个文件也可以被单独关闭 —— 请检查 `disabledExtensions` 中是否有匹配的 `context-file:<level>:<basename>` 条目，并记住项目条目在每一层深度都会生效。若属此原因，`/extensions` 会把该文件显示为 `disabled`。

### 错误的文件胜出

在单一用户作用域或项目深度上，优先级更高的 provider 会覆盖其余（native > claude > agents/codex > gemini > opencode > github > agents-md > claude-md）。要强制获得确定性行为，请把你的指导内容移入 `.omp/AGENTS.md`（native 总是胜出），或禁用竞争的发现 provider。

### 用户上下文消失

只有一个用户级上下文文件能保留，而 `~/.omp/agent/AGENTS.md` 优先级最高。只要它存在，它就会覆盖用户级的 `~/.claude/CLAUDE.md`、`~/.codex/AGENTS.md`、`~/.gemini/GEMINI.md`、`~/.config/opencode/AGENTS.md`、`~/.copilot/copilot-instructions.md` 以及 `~/.agent`/`~/.agents` 文件。请把用户指导整合进原生文件；如果你更偏好其他工具的文件，则移除原生文件。

### `RULES.md` 文件被忽略

只有原生 `RULES.md` 位置是粘性的：当前用户 agent 目录，以及从 cwd 向仓库根目录上溯所选定的最近非空项目 `.omp/` 目录。只要存在更近的非空 `.omp/` 目录，即使其中没有 `RULES.md`，它也会阻挡更远的原生目录。位于其他任何位置的 `RULES.md` 都不是被识别的约定。

### `@` 导入未展开

请确认目标相对于导入文件（而不是 cwd）存在。围栏代码块或行内代码 span 内的导入会有意保持字面原样，`git@`/形如电子邮件的标记永远不会被导入，循环会被跳过，展开在五层后停止，目标缺失时原始 `@path` 文本保持不变。
