# 上下文文件

上下文文件是 `omp` 在会话开始前自动发现并注入到智能体项目上下文中的 Markdown 指令文件。可用于存放仓库规范、架构说明、测试与评审期望，以及那些应随用户账号或项目一同携带的指令。

你永远不需要让智能体去读取 `AGENTS.md`、`CLAUDE.md`、`GEMINI.md` 或类似文件 —— 相关文件在会话开始时就已经被发现、加载并放入上下文。

## 上下文文件与其他概念的关系

四个名字相近的概念行为各不相同。请注意区分：

- **上下文文件** 以纯 Markdown 形式读取，并在生成的项目指令（使用默认提示模板时位于 `<repo-rules>` 内）展示给智能体。它们是会话开场指令，也是仓库工作的背景信息。
- **粘性规则** 来自顶层的原生 `RULES.md`。它们会被转换为一条 always-apply 规则，并在当前轮附近被重新挂接，因此即使可见的对话变长，它们仍能保持效力。详见下文的「粘性规则与普通上下文的区别」。
- **发现提供者** 是配置源适配器（`native`、`claude`、`codex`、`gemini`、`opencode`、`github`、`agents`、`agents-md`），它们清楚每个工具把文件放在哪里。贡献上下文文件的同一个提供者也可能贡献 MCP 服务器、斜杠命令、技能、钩子、工具、提示和设置。
- **模型提供者** 是推理后端，例如 `anthropic`、`openai`、`google`、`groq`、`ollama` 和 `openrouter`。它们与上下文文件无关，只是这两类 id 共享同一个 `disabledProviders` 列表 —— 详见下文的「禁用发现提供者」和 [Providers](./providers.md)。

**技能** 与 **规则** 文件（相对于粘性的 `RULES.md`）的编写方式见 [Skills](./skills.md)。使用 `SYSTEM.md` 自定义系统提示见 [System prompt customization](./system-prompt-customization.md)。

## 原生 `.omp` 文件

对于新项目，推荐使用原生提供者的格式。它会从用户代理目录和项目内的 `.omp/` 目录读取文件，并且具有最高的发现优先级，因此其文件在同作用域下胜过任何其他约定。

| 文件                                          | 作用域 | 行为                                                                                                                                                                                                                                              |
| --------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `~/.omp/agent/AGENTS.md`                      | 用户   | 每个会话的用户级上下文，除非 `native` 提供者被禁用。                                                                                                                                                                                            |
| `<nearest-non-empty-ancestor>/.omp/AGENTS.md` | 项目   | 项目上下文，但仅当从 cwd 向仓库根目录上溯过程中找到的**最近一个非空 `.omp/` 目录**中存在 `AGENTS.md` 时才会读取。一旦选定的最近目录中没有此文件，OMP 不会继续向更远的 `.omp/` 目录查找。 |
| `~/.omp/agent/RULES.md`                       | 用户   | 用户级粘性规则内容。作为 always-apply 规则加载，而非上下文文件。                                                                                                                                                                                  |
| `<nearest-non-empty-ancestor>/.omp/RULES.md`  | 项目   | 项目粘性内容，但仅当同一上溯选定的最近非空 `.omp/` 目录中存在 `RULES.md` 时才会读取。                                                                                                                                                            |

有两个细节需要注意：

- **最近一个非空的 `.omp/` 目录拥有原生项目发现权。** 发现从当前工作目录开始，向仓库根目录上溯。一旦找到非空的 `.omp/`，便停止；原生的 `AGENTS.md` 和 `RULES.md` 都只从该目录读取。文件缺失并不会让发现继续向上。
- **空目录和空文件不贡献任何内容。** 上溯过程中空 `.omp/` 目录会被跳过。在选定的非空目录中，空的 `AGENTS.md` 或 `RULES.md` 也不贡献任何内容。

`~/.omp/agent` 是当前原生代理目录的简写。`PI_CODING_AGENT_DIR` 可重定位它。命名 profile（`omp --profile <name>`、`OMP_PROFILE` 或 `PI_PROFILE`）默认使用 `~/.omp/profiles/<name>/agent`；外部工具的用户基础目录（例如 `~/.claude`）不受 profile 作用域影响。

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

- 原生上下文文件是 `repo/packages/api/.omp/AGENTS.md`（最近的那一个）。`repo/.omp/AGENTS.md` **不会** 被同时包含。
- 因为 `repo/packages/api/.omp/` 是最近非空的原生目录，项目粘性内容只能来自 `repo/packages/api/.omp/RULES.md`。如果该文件不存在，则 **不会** 使用 `repo/.omp/RULES.md`。

将广泛而持久的项目背景放在 `AGENTS.md` 中。将 `RULES.md` 留给那些必须在长对话中始终可见的简短硬性要求。

## 其他支持的上下文约定

`omp` 也会发现其他智能体工具的上下文与规则文件，从而让既有项目无需迁移即可继续工作。

| Provider id | 约定路径                              | 作用域          | 备注                                                                                                                                                                                                                                                                                                                                                          |
| ----------- | ------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `native`    | `.omp/AGENTS.md`                      | 用户 + 项目     | 推荐的 OMP 格式。用户文件位于当前原生代理目录；项目文件仅从向仓库根目录上溯时找到的最近非空 `.omp/` 目录读取。                                                                                                                                                                                                                                                |
| `claude`    | `.claude/CLAUDE.md`                   | 用户 + 项目     | 用户文件 `~/.claude/CLAUDE.md`；项目文件仅来自 `<cwd>/.claude/CLAUDE.md`（不上溯祖先目录）。                                                                                                                                                                                                                                                                  |
| `codex`     | `.codex/AGENTS.md`                    | 用户            | 仅用户文件 `~/.codex/AGENTS.md`。项目级 Codex 上下文来自独立的 `AGENTS.md`（通过 `agents-md` 提供者），而不是 `<cwd>/.codex/AGENTS.md`。                                                                                                                                                                                                                      |
| `gemini`    | `.gemini/GEMINI.md`                   | 用户 + 项目     | 用户文件 `~/.gemini/GEMINI.md`；项目文件仅来自 `<cwd>/.gemini/GEMINI.md`（不上溯祖先目录）。                                                                                                                                                                                                                                                                  |
| `opencode`  | `.config/opencode/AGENTS.md`          | 用户            | 仅用户文件 `~/.config/opencode/AGENTS.md`。                                                                                                                                                                                                                                                                                                                  |
| `github`    | `.github/copilot-instructions.md`     | 用户 + 项目     | 项目文件仅来自 `<cwd>/.github/copilot-instructions.md`（不上溯祖先目录），加上一份用户全局的 `~/.copilot/copilot-instructions.md`（用 `COPILOT_HOME` 重定位）。来自 `COPILOT_CUSTOM_INSTRUCTIONS_DIRS` 的 `AGENTS.md` 候选在用户作用域下也会被考虑，正常「单用户文件」去重规则适用。                                                                            |
| `agents`    | `.agent/AGENTS.md`、`.agents/AGENTS.md` | 用户 + 项目    | 用户文件来自 `~/.agent/` 和 `~/.agents/`；项目文件从当前目录向仓库根目录上溯时发现。                                                                                                                                                                                                                                                                          |
| `agents-md` | `AGENTS.md`                           | 项目            | 独立（非配置目录）的 `AGENTS.md` 文件，通过从当前目录向仓库根目录上溯来发现；并且当该仓库嵌套于用户主目录下时，会继续穿过外层的工作目录直到（但不包括）主目录。若无仓库根目录，则对主目录下的会话使用主目录作为边界，并包含该边界文件。父目录名以 `.` 开头的文件会被忽略 —— 它们属于配置目录提供者。                                                       |
| `github`    | `.github/instructions/**/*.instructions.md` | 项目规则 | GitHub Copilot / VS Code 指令文件会作为规则注入。`applyTo: '*'`、`applyTo: '**'` 或 `applyTo: '**/*'` 会作为 always-apply 内容注入；其他 `applyTo` glob 会在规则簿中列出，必要时附上生成的描述，并可作为 `rule://<name>` 读取。缺失 `applyTo` 同样会产生规则簿条目并发出发现警告。                                                                              |

标记为「（不上溯祖先目录）」的提供者仅查看当前工作目录下的配置目录。如果你需要祖先目录上溯行为，请优先选择原生 `.omp/AGENTS.md` 格式或独立 `AGENTS.md`（即 `agents-md` 提供者），或者在包含配置目录的目录中启动 `omp`。

## 加载顺序与覆盖

当两个提供者描述 _同一_ 作用域时，优先级较高的提供者胜出。提供者优先级：

| 优先级 | Provider id           |
| -----: | --------------------- |
|    100 | `native`              |
|     80 | `claude`              |
|     70 | `agents`、`codex`     |
|     60 | `gemini`              |
|     55 | `opencode`            |
|     30 | `github`              |
|     10 | `agents-md`           |

随后按作用域对发现的文件去重：

- **跨所有提供者仅保留一个用户上下文文件。** 由于 `native` 拥有最高优先级，`~/.omp/agent/AGENTS.md` 会覆盖其他所有用户级上下文文件。
- **每个目录深度保留一个项目上下文文件。** 深度从当前目录测量：cwd 为深度 0，其父目录为深度 1，依此类推。祖先目录的配置子目录（`.claude/`、`.github/`、`.gemini/` 等）计为与该祖先目录相同的深度。
- **在同一深度上，优先级较高的提供者覆盖其他提供者。**
- **跨深度时，多个文件会同时保留。** 在 monorepo 中，祖先 `AGENTS.md` 与 package 级的 `AGENTS.md` 处于不同深度，都会加载。
- **字节相同的文件在排序后会被合并。** 在项目副本中，最接近 cwd 的那一份保留。单一保留的用户作用域文件排在项目文件之后，因此当其内容与项目内容相同时，由它保留。

最终注入顺序是 **先注入更远的项目祖先，再注入更接近 cwd 的项目文件，最后注入保留的用户作用域文件**。文件越靠后，就越接近生成上下文的尾部，也更显眼。

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
- `repo/packages/api/AGENTS.md`（`agents-md`，优先级 10）和 `repo/packages/api/.github/copilot-instructions.md`（`github`，优先级 30）都解析为深度 0。GitHub 的优先级更高，覆盖了 package 级的独立 `AGENTS.md`，因此在该深度 Copilot 文件胜出。
- 两份保留文件按「根在前、package 在后」排序，因此 `packages/api` 的文件更显眼。
- 如果你加入 `repo/packages/api/.omp/AGENTS.md`，`native`（优先级 100）会在深度 0 完全胜出，覆盖两个低优先级的文件。

## 注入行为

使用默认提示模板时，发现的上下文文件会作为单个 `<repo-rules>` 块注入到开场项目提示中，每个保留文件对应一个 `<file>` 元素，按上述排序顺序排列：

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

当 `SYSTEM.md` 选择了内置的自定义提示模板时，相同文件会在该模板的 `<project>` / `<instructions>` 部分输出。无论哪种模式，智能体都会看到每个文件的绝对路径以及完全展开的 Markdown 内容（其中 `@` 导入已提前解析完成）。

加载是自动的 —— 无需在会话中指示智能体去搜索 `AGENTS.md`、`CLAUDE.md`、`GEMINI.md`、`.cursorrules` 或类似文件。

未自动加载的更深层目录下的 `AGENTS.md` 文件（例如当前目录以下的那些）会在单独的 `<dir-context>` 块中列出其路径，并提示智能体在编辑这些目录之前先读取它们。这些文件是指针，而非完整注入的内容。

## `@` 导入

在任何上下文文件内部，`@path` 标记会在注入前内联展开为所引用文件的内容：

```markdown
# Project notes

Read @docs/architecture.md before changing storage code.
Shared release steps live in @../RELEASE.md and personal aliases in @~/.notes/aliases.md.
```

具体规则如下：

- **相对路径从导入文件自身的目录解析**，而不是会话的工作目录。
- **`~/` 和 `~`** 从用户主目录解析；绝对路径按原样使用。
- **围栏代码块和行内代码块内的标记保持原样** —— 当你希望「描述」一个 `@token` 而不展开它时很有用。
- **`git@github.com:org/repo.git` 和 `user@example.com` 形式的标记不会被视为导入。** 只有当 `@` 出现在行首或紧跟在空格或制表符之后时，它才算作导入标记。
- **会去除路径末尾的句子标点**（`. , ; : ! ? ) ] } " '`），因此 `@docs/setup.md.` 实际导入的是 `docs/setup.md`。
- **导入最多递归五层。** 导入文件自身也可以包含 `@` 导入，递归总深度上限为五。
- **循环会被跳过。** 已经被纳入当前展开树的文件不会被再次展开，因此相互导入可以干净地终止。
- **目标缺失或不可读时，会保留原始的 `@token` 文本**，而不会报错。

## 粘性规则与普通上下文的区别

将大部分指导内容放入普通上下文文件（`AGENTS.md`、`CLAUDE.md`、`GEMINI.md`、`.github/copilot-instructions.md` 等）：仓库概览、代码风格、构建与测试命令、评审期望以及本地约定。这些会加载到开场生成的项目上下文中。

将顶层 **`RULES.md`** 用于那些必须在长对话（即使开场上下文已被推到对话很远的上方）之后仍保持生效的少数硬性要求：

```markdown
# ~/.omp/agent/RULES.md

Never commit or push unless the user explicitly asks.
Do not edit generated files.
```

`RULES.md` 比较特殊：

- 它 **仅** 在原生位置读取：当前用户代理目录，以及从 cwd 向仓库根目录上溯所选定的最近非空项目 `.omp/` 目录。如果该项目目录中没有 `RULES.md`，OMP 不会回退到更远的 `.omp/RULES.md`。
- 它会作为 **always-apply 规则** 加载，而非上下文文件，因此它会在当前轮附近被重新挂接，并在长会话中持续生效。
- 它 **始终是粘性的**：frontmatter 无法让它变成非粘性。如果需要条件性或按需启用的行为，请改写一个普通规则文件（见 [Skills](./skills.md)）。
- 两个顶层候选都会以规则名 `RULES` 合成，且规则去重是基于名称的。常规情况下，用户 `RULES.md` 会覆盖项目 `RULES.md`；二者不会拼接。避免在 `.omp/rules/` 或用户 `rules/` 目录中将普通文件命名为 `RULES.md`，因为原生普通规则会更早加载并可能覆盖这两条粘性候选。

请保持 `RULES.md` 简短。冗长的背景内容应放在 `AGENTS.md` 中，它只需消耗一次上下文预算。

## 禁用发现提供者

通过 `~/.omp/agent/config.yml`、项目的 `.omp/config.yml` 或 `--config` 覆盖中的 `disabledProviders` 设置关闭某个提供者：

```yaml
# .omp/config.yml
disabledProviders:
  - claude
  - github
```

`disabledProviders` 是一个 **整个提供者的开关，共享一个 id 命名空间**，供两个不相关的子系统使用：

| Id 种类                  | 示例                                                                              | 被列出时的效果                                                                                                                                                                                |
| ------------------------ | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 发现提供者 id            | `native`、`claude`、`codex`、`gemini`、`opencode`、`github`、`agents`、`agents-md` | 整个配置源都会被移除 —— 不仅是其上下文文件，还包括它本应贡献的 MCP 服务器、斜杠命令、技能、钩子、工具、提示和设置。                                                                            |
| 模型提供者 id            | `anthropic`、`openai`、`google`、`groq`、`ollama`、`openrouter`                    | 即使凭据存在，模型后端也会从可选列表中移除。见 [Providers](./providers.md)。                                                                                                                  |

id 是精确匹配的，两个命名空间不会意外冲突：`google` 禁用 Google 模型后端，而 `gemini` 禁用 Gemini CLI 的发现文件。禁用发现提供者的影响比看起来更大 —— 例如禁用 `claude` 不仅会丢掉 `CLAUDE.md`，还会丢掉 Claude 发现的 MCP 服务器、命令、技能、钩子、工具和设置。如果只想丢弃该上下文文件而保留提供者贡献的其他内容，请改用 [`disabledExtensions`](#禁用单个上下文文件)。

只有 `enabledModels` 和 `disabledProviders` 支持 **路径作用域** 条目，因此你可以按子树变化提供者的可用性：

```yaml
disabledProviders:
  - github # 全局禁用
  - path: ~/work/legacy-claude
    providers:
      - claude # 仅在该目录下禁用
```

当 cwd 等于配置的路径或位于其下时，作用域条目生效；`~` 展开为主目录。裸字符串条目全局生效。

请记住，优先级更高的设置层会 **替换** 数组设置，而不是追加。如果你的全局配置禁用了 `claude`，但项目配置设置了 `disabledProviders: [github]`，那么在该项目内 Claude 发现会被重新启用，只有 GitHub 被禁用。完整层级优先级、合并规则和路径作用域数组细节见 [Settings](./settings.md)。

## 禁用单个上下文文件

`disabledProviders` 会移除整个配置源。要丢弃单个上下文文件而保留其提供者贡献的其他内容，请将它的扩展 id 列入 `disabledExtensions`：

```yaml
# ~/.omp/agent/config.yml、.omp/config.yml，或 --config 覆盖
disabledExtensions:
  - context-file:user:CLAUDE.md
```

上下文文件 id 形如 `context-file:<level>:<basename>`，其中 `<level>` 是 `user` 或 `project`，`<basename>` 是没有目录部分的文件名：

| Id                                  | 禁用内容                                                                                                  |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `context-file:user:CLAUDE.md`       | 用户级 `CLAUDE.md`；同时 Claude 的 MCP 服务器、命令、技能、钩子、工具和设置仍会加载。                      |
| `context-file:project:AGENTS.md`    | **所有** 项目级 `AGENTS.md`，无论上溯到达哪一层目录深度 —— id 不携带深度信息。                              |
| `context-file:user:AGENTS.md`       | 所有用户级名为 `AGENTS.md` 的文件，无论由哪个提供者提供。                                                  |

匹配只根据层级和文件名进行，因此一个条目涵盖了在该层级上提供同名文件的所有提供者，且项目条目无法缩小到单个深度。当你需要按目录控制时，请在需要差异的子树中放置项目级 `.omp/config.yml`，或使用上文路径作用域的 `disabledProviders` 形式。

禁用不同于覆盖，区别是可见的：被禁用的文件会在去重之前被丢弃，因此它不会占据其作用域。**原本被它覆盖的文件会被加载到该位置。** 在同时包含 `.claude/CLAUDE.md` 和 `AGENTS.md` 的项目中，`CLAUDE.md` 通常会胜出 depth-0 作用域；如果禁用 `context-file:project:CLAUDE.md`，那么 `AGENTS.md` 会成为项目上下文，而不是让该作用域空缺。若要让该作用域完全为空，请逐一禁用每个候选文件名。

两种日常用法：

- **非交互式运行。** 为你个人交互式会话编写的用户级上下文文件通常不适合由其他程序驱动的 `-p` 运行，因为后者会自带指令。在 `--config` 覆盖中禁用它，可以让交互式设置保持不变。
- **委托工作。** 当一个智能体驱动另一个智能体时，调用方自身的操作指令会作为用户级上下文传入被调用方的提示中，可能与实际给定的任务相矛盾。

`disabledExtensions` 不支持路径作用域：只有 `enabledModels` 和 `disabledProviders` 接受 `path:` 形式。和其他数组设置一样，它会被更高优先级的层替换而非合并。

可通过 `/extensions` 交互式浏览所有 id，该命令会列出每个发现的上下文文件及其层级、来源和当前状态，并切换同一设置。

## 故障排查

### 文件未被加载

- 原生项目上下文仅从最近非空的 `.omp/` 目录读取。该目录必须包含非空的 `AGENTS.md`；如果不存在，发现不会继续向更远的原生目录查找。
- 独立 `AGENTS.md` 由 `agents-md` 处理，而非 `native`。
- `.claude/CLAUDE.md`、`.gemini/GEMINI.md` 和 `.github/copilot-instructions.md` 仅从当前工作目录的配置目录读取，不会从每个祖先目录读取。
- `~/.codex/AGENTS.md` 和 `~/.config/opencode/AGENTS.md` 仅作用于用户层级，没有项目对应物。
- 对于原生和独立提供者，空文件不贡献任何内容。
- 被禁用的发现提供者不贡献任何内容 —— 请检查全局、项目和 `--config` 各层的 `disabledProviders`。
- 单个文件也可以单独关闭 —— 请在 `disabledExtensions` 中检查是否有匹配的 `context-file:<level>:<basename>` 条目，并注意项目条目会在每个深度生效。若属此原因，`/extensions` 会将该文件显示为 `disabled`。

### 错误的文件胜出

在某一用户作用域或项目深度上，优先级较高的提供者会覆盖其他提供者（native > claude > agents/codex > gemini > opencode > github > agents-md）。若要强制确定性行为，请将你的指导内容移入 `.omp/AGENTS.md`（native 始终胜出），或禁用竞争的发现提供者。

### 用户上下文消失

仅有一个用户级上下文文件保留，且 `~/.omp/agent/AGENTS.md` 具有最高优先级。如果它存在，它会覆盖用户级的 `~/.claude/CLAUDE.md`、`~/.codex/AGENTS.md`、`~/.gemini/GEMINI.md`、`~/.config/opencode/AGENTS.md`、`~/.copilot/copilot-instructions.md` 以及 `~/.agent`/`~/.agents` 文件。请将用户指导整合到原生文件中，或者如果你偏好其他工具的文件，请移除原生文件。

### `RULES.md` 文件被忽略

只有原生 `RULES.md` 位置是粘性的：当前用户代理目录，以及从 cwd 向仓库根目录上溯所选定的最近非空项目 `.omp/` 目录。如果存在更近的非空 `.omp/` 目录，即使它没有 `RULES.md`，也会阻塞更远的原生目录。位于其他位置的 `RULES.md` 不被识别。

### `@` 导入未展开

请确认目标相对于导入文件存在（而非相对于 cwd）。围栏代码块或行内代码块内的导入会按设计保持原样；`git@` / 邮件形式的标记永远不会被导入；循环会被跳过；展开在五层后停止；目标缺失时原始 `@path` 文本保持不变。