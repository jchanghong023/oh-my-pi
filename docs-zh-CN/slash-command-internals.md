# 斜杠命令内部机制

本文档描述了 `coding-agent` 中斜杠命令的发现、去重、在交互模式中的展示以及在提示时的展开方式。

## 实现文件

- [`src/extensibility/slash-commands.ts`](../packages/coding-agent/src/extensibility/slash-commands.ts)
- [`src/capability/slash-command.ts`](../packages/coding-agent/src/capability/slash-command.ts)
- [`src/discovery/builtin.ts`](../packages/coding-agent/src/discovery/builtin.ts)
- [`src/discovery/omp-plugins.ts`](../packages/coding-agent/src/discovery/omp-plugins.ts)
- [`src/discovery/claude.ts`](../packages/coding-agent/src/discovery/claude.ts)
- [`src/discovery/codex.ts`](../packages/coding-agent/src/discovery/codex.ts)
- [`src/discovery/claude-plugins.ts`](../packages/coding-agent/src/discovery/claude-plugins.ts)
- [`src/discovery/agents.ts`](../packages/coding-agent/src/discovery/agents.ts)
- [`src/discovery/opencode.ts`](../packages/coding-agent/src/discovery/opencode.ts)
- [`src/capability/index.ts`](../packages/coding-agent/src/capability/index.ts)
- [`src/discovery/helpers.ts`](../packages/coding-agent/src/discovery/helpers.ts)
- [`src/slash-commands/builtin-registry.ts`](../packages/coding-agent/src/slash-commands/builtin-registry.ts)
- [`src/slash-commands/acp-builtins.ts`](../packages/coding-agent/src/slash-commands/acp-builtins.ts)
- [`src/slash-commands/available-commands.ts`](../packages/coding-agent/src/slash-commands/available-commands.ts)
- [`src/session/agent-session.ts`](../packages/coding-agent/src/session/agent-session.ts)
- [`src/modes/interactive-mode.ts`](../packages/coding-agent/src/modes/interactive-mode.ts)
- [`src/modes/controllers/input-controller.ts`](../packages/coding-agent/src/modes/controllers/input-controller.ts)
- [`src/modes/utils/ui-helpers.ts`](../packages/coding-agent/src/modes/utils/ui-helpers.ts)

## 1) 发现模型

斜杠命令是一项能力（`id: "slash-commands"`），以命令名作为键（`key: cmd => cmd.name`）。

能力注册表按提供者优先级降序加载所有已注册的提供者，并通过键进行去重，采用**先到优先**的语义。

### 提供者优先级

当前斜杠命令提供者及其优先级：

1. `native`（OMP）— 优先级 `100`
2. `omp-plugins`（扩展包）— 优先级 `90`
3. `claude` — 优先级 `80`
4. `claude-plugins` — 优先级 `70`
5. `agents`（`.agent`/`.agents` 标准目录）— 优先级 `70`
6. `codex` — 优先级 `70`
7. `opencode` — 优先级 `55`

平局行为：优先级相等的提供者保持注册顺序。当前的导入顺序依次注册 `claude-plugins`、`agents`、`codex`，因此在名称冲突时插件命令同时优先于后两者。

### 名称冲突行为

对于 `slash-commands`，冲突严格按照能力去重解决：

- 优先级最高的项保留在 `result.items` 中
- 优先级较低的重复项仅保留在 `result.all` 中，并被标记为 `_shadowed = true`

这适用于跨提供者的情况，也适用于单个提供者返回重复名称的情况。

内置命令不属于此文件能力中的条目。它们存在于统一的内置注册表中，并在 TUI 和 ACP/RPC 模式中会话级别的扩展/自定义/文件展开之前被分发。自动补全/ACP 可用性也会优先保留内置名称和别名。

### 文件扫描行为

提供者主要使用 `loadFilesFromDir(...)`，该函数当前：

- 默认采用非递归匹配（`*.md`）
- 使用原生 glob，参数为 `gitignore: true`、`hidden: false`、`fileType: File`
- 并行读取匹配的文件，并将其转换为 `SlashCommand` 项

因此不会加载隐藏文件/目录，会跳过被忽略的路径，文件顺序遵循原生 glob 的结果顺序，除非提供者添加了自定义排序。

## 2) 提供者特定的源路径和本地优先级

## `native` 提供者（`builtin.ts`）

搜索根目录来自 `.omp` 目录：

- 项目：`<cwd>/.omp/commands/*.md`
- 用户：当前配置文件的 agent 目录 `commands/*.md`（默认配置文件为 `~/.omp/agent/commands/*.md`；具名配置文件为 `~/.omp/profiles/<name>/agent/commands/*.md`）

`getConfigDirs()` 优先返回项目目录，然后是用户目录，因此当名称冲突时**项目原生命令优先于用户原生命令**。

## `omp-plugins` 提供者（`omp-plugins.ts`）

在已配置的扩展包根目录以及已启用的 npm/link 插件中扫描 `commands/*.md`。根目录优先级为：调用/CLI、项目设置、用户设置，然后是已安装的插件。此处排除市场根目录以避免重复发现，由 `claude-plugins` 处理。

## `claude` 提供者（`claude.ts`）

在 `commands.enableClaudeUser` 和 `commands.enableClaudeProject` 设置的约束下加载：

- 用户：`~/.claude/commands/**/*.md`（递归）
- 项目：`<cwd>/.claude/commands/**/*.md`（递归）

子目录中的命令还会获得一个命名空间别名：`foo/bar.md` 会同时以 `bar` 和 `foo:bar` 注册（`addClaudeCommandNamespaceAliases`）。

该提供者先推送用户项，然后推送项目项，因此在此提供者内部出现同名冲突时，**用户 Claude 命令优先于项目 Claude 命令**。

## `codex` 提供者（`codex.ts`）

加载：

- 用户：`~/.codex/commands/*.md`
- 项目：`<cwd>/.codex/commands/*.md`

两侧加载后按用户优先的顺序扁平化，因此发生冲突时**用户 Codex 命令优先于项目 Codex 命令**。

Codex 命令内容通过剥离 frontmatter 进行解析（`parseFrontmatter`），命令名可由 frontmatter 中的 `name` 覆盖；否则使用文件名。

## `opencode` 提供者（`opencode.ts`）

在 `commands.enableOpencodeUser` 和 `commands.enableOpencodeProject` 设置的约束下加载：

- 用户：`~/.config/opencode/commands/*.md`
- 项目：`<cwd>/.opencode/commands/*.md`

两侧加载后按用户优先的顺序扁平化，因此发生冲突时**用户 OpenCode 命令优先于项目 OpenCode 命令**。OpenCode 命令内容通过剥离 frontmatter 进行解析，命令名可由 frontmatter 中的 `name` 覆盖；否则使用文件名。

## `claude-plugins` 提供者（`claude-plugins.ts`）

通过 `listClaudePluginRoots(...)` 加载插件命令根目录，该函数读取 `~/.claude/plugins/installed_plugins.json`、`~/.omp/plugins/installed_plugins.json` 以及从 cwd 解析出的最近项目级注册表。对于每个根目录，会扫描 `<pluginRoot>/commands/*.md`（该目录可通过插件配置键 `commands`/`slash-commands` 重新映射），命令名以插件名为前缀：`<plugin>:<command>`。

在这三个注册表之间，根目录按优先级合并而非排序：`--plugin-dir` 注入的根目录排在最前，然后是项目级条目（对于同一插件 id，它们会遮蔽用户条目），再然后是用户条目，其中 OMP 注册表对同一插件 id 拥有比 Claude 更高的权威性。在每个注册表内部，JSON 数据中每个插件条目的顺序被保留；没有额外的排序步骤。

## `agents` 提供者（`agents.ts`）

从 cwd 向上扫描到仓库根目录下的 `.agent/` 和 `.agents/` 中的非递归 `commands/*.md`，然后是 `~/.agent/commands` 和 `~/.agents/commands`。在此提供者内部，最近的项目根目录优先；`.agent` 先于 `.agents`；项目条目先于用户条目。

## 3) 物化为运行时 `FileSlashCommand`

`loadSlashCommands()` 位于 `src/extensibility/slash-commands.ts`，它将能力项转换为提示时使用的 `FileSlashCommand` 对象。

对于每个命令：

1. 解析 frontmatter/正文（`parseFrontmatter`）
2. 描述来源：
   - 若存在则使用 `frontmatter.description`
   - 否则使用正文中第一个非空行（最多 60 个字符，超出部分以 `...` 表示）
3. 将解析后的正文保留为可执行模板内容
4. 计算类似 `via Claude Code Project` 的展示来源字符串

Frontmatter 解析的严重程度因级别而异：

- 已发现的用户/项目命令使用警告级解析，并附带回退的键/值解析
- 显式标记为 `native` 的能力项使用致命级解析
- 内置的回退模板使用致命级解析

### 内置回退命令

在文件系统/提供者命令之后，如果名称尚未出现，则会追加嵌入式命令模板（`EMBEDDED_COMMAND_TEMPLATES`）。

当前的嵌入式集合来自 `src/task/commands.ts`，用作回退（`source: "bundled"`）。

## 4) 交互模式：命令列表的来源

交互模式组合多个命令源用于自动补全和命令路由。

在构造时，它从以下来源构建待处理命令列表：

- 内置命令（`BUILTIN_SLASH_COMMANDS`，包括参数补全和选定命令的内联提示）
- 扩展注册的斜杠命令（`extensionRunner.getRegisteredCommands(...)`）
- TypeScript 自定义命令（`session.customCommands`），映射为斜杠命令标签
- 在启用 `skills.enableSkillCommands` 时的可选技能命令（`/skill:<name>`）

然后 `init()` 调用 `refreshSlashCommandState(...)` 来加载基于文件的命令，并安装一个自动补全提供者（`createPromptActionAutocompleteProvider`，一个包装了 `CombinedAutocompleteProvider` 的 `PromptActionAutocompleteProvider`），其包含：

- 上述待处理命令
- 已发现的基于文件的命令
- 名称未被内置/钩子/自定义/技能/文件命令占用的已发现提示模板命令

`refreshSlashCommandState(...)` 还会更新 `session.setSlashCommands(...)`，使提示展开使用同一组已发现的文件命令。

### 刷新生命周期

斜杠命令状态会在以下时机刷新：

- 交互初始化期间
- `/move` 更改工作目录之后（`applyCwdChange` 重置能力并根据新的 cwd 刷新）
- 编辑器组件被替换时
- 显式的插件重载流程，例如 `/reload-plugins`

不存在针对命令目录的持续文件监视器。

### 其他展示方式

扩展仪表板还会加载 `slash-commands` 能力，并显示激活/被遮蔽的命令条目，包括 `_shadowed` 重复项。

## 5) 路由和提示管线位置

在 TUI 和 ACP/RPC 模式中，统一的内置注册表会在 `AgentSession.prompt(...)` 之前被检查。内置命令可以消费输入或返回剩余的提示文本。仅 TUI 的内置命令在 ACP 可用性和分发中会被省略；ACP 可见的内置命令是那些具有文本模式 `handle` 的条目。

在该边界之后，当 `expandPromptTemplates !== false` 时，`AgentSession.prompt(...)` 按以下顺序处理斜杠输入：

1. **扩展命令**（`#tryExecuteExtensionCommand`）  
   如果 `/name` 匹配扩展已注册的命令，其处理程序会立即执行，提示返回。
2. **TypeScript 自定义命令和 MCP 提示命令**（`#tryExecuteCustomCommand`）  
   匹配可能返回：
   - `string` -> 使用该字符串替换提示文本
   - `void/undefined` -> 视为已处理；不向 LLM 发送提示
3. **基于文件的斜杠命令**（`expandSlashCommand`）  
   如果文本仍以 `/` 开头，则尝试进行 markdown 命令展开。
4. **提示模板**（`expandPromptTemplate`）  
   在斜杠/自定义处理之后应用。
5. **投递**
   - 空闲：提示立即发送给 agent
   - 流式传输：根据 `streamingBehavior`，提示作为 steer/follow-up 排队

这就是为什么内置命令在考虑文件命令之前就保留其名称，斜杠命令展开位于提示模板展开之前，自定义命令可以在文件命令匹配之前转换掉前导斜杠。

## 6) 基于文件的斜杠命令的展开语义

`expandSlashCommand(text, fileCommands)` 的行为：

- 仅在文本以 `/` 开头时运行
- 从 `/` 之后的第一个标记解析命令名
- 通过 `parseCommandArgs` 从剩余文本解析参数
- 在已加载的 `fileCommands` 中查找精确的名称匹配
- 如果匹配，则应用：
  - 位置替换：`$1`、`$2` 等
  - 切片替换：`$@[start]` / `$@[start:length]`，使用基于 1 的位置
  - 聚合替换：`$ARGUMENTS` 和 `$@`
  - 通过 `prompt.render` 进行模板渲染，参数为 `{ args, ARGUMENTS, arguments }`
  - 当模板未使用内联参数占位符时，附加内联参数回退

### `parseCommandArgs` 的注意事项

该解析器是简单的支持引号的拆分：

- 支持 `'单引号'` 和 `"双引号"` 引用以保留空格
- 剥离引号定界符
- 不实现反斜杠转义规则
- 未匹配的引号不是错误；解析器会一直消费到末尾

## 7) 未知的 `/...` 行为

核心斜杠逻辑**不会拒绝**未知的斜杠输入。

如果没有内置、扩展、自定义或文件命令处理它，`expandSlashCommand` 会返回原始文本，字面 `/...` 提示会继续通过提示模板展开和 LLM 投递。

TUI 和 ACP/RPC 在 `session.prompt(...)` 之前分发共享的内置注册表。仅 TUI 的内置命令在 ACP 中既不公开也不处理，因此在其他情况下未处理的拼写仍可能作为普通提示文本在那里透传。

## ACP/RPC 可用性

`buildAvailableSlashCommands(...)` 按以下顺序以先到优先的方式发布命令：具有文本能力的内置命令、可选的技能命令、扩展命令、TypeScript/MCP 自定义命令，然后是已发现的文件命令。内置的主名称和别名被保留；扩展名（例如 `model:foo`）如果其前缀可解析为内置命令，则会从 ACP 可用性中过滤掉。同一个文件命令加载会更新会话的展开集。

## 8) 流式传输时与空闲的差异

## 空闲路径

- `session.prompt("/x ...")` 运行命令管道，立即执行命令或直接发送展开后的文本。

## 流式传输路径（`session.isStreaming === true`）

- `prompt(...)` 仍然首先运行扩展/自定义/文件/模板转换
- 然后要求 `streamingBehavior`：
  - `"steer"` -> 排队中断消息（`agent.steer`）
  - `"followUp"` -> 排队回合后消息（`agent.followUp`）
- 如果省略 `streamingBehavior`，则 `prompt` 抛出错误

### 重要的命令特定流式传输行为

- 即使在流式传输期间，扩展命令也会立即执行（不会作为文本排队）。
- `steer(...)`/`followUp(...)` 辅助方法会拒绝扩展命令（`#throwIfExtensionCommand`），以避免为必须同步运行的处理程序将命令文本排队。
- 压缩队列重放使用 `isKnownSlashCommand(...)` 来决定排队的条目是通过 `session.prompt(...)` 重放（针对已知斜杠命令）还是通过原始的 steer/follow-up 方法重放。

## 9) 错误处理和失败面

- 提供者加载失败是隔离的；注册表会收集警告并继续处理其他提供者。
- 无效的斜杠命令项（缺少名称/路径/内容或级别无效）会被能力验证丢弃。
- Frontmatter 解析失败：
  - 原生命令：致命解析错误会向上抛出
  - 非原生命令：警告 + 回退的键/值解析
- 扩展/自定义命令处理程序的异常会被捕获并通过扩展错误通道报告（对于没有扩展运行器的自定义命令，则通过日志记录器回退），并视为已处理（不会意外地回退执行）。

## 10) 内置命令说明：`/pause`

`/pause` 仅在交互式 TUI 中可用。它为主要的 agent、进程内的子 agent 以及 advisor 启用一个进程级的门控。每个 agent 都会停在其下一个安全边界处：进行中的调用会完成，不会中止任何操作，并且在门控被释放之前不会开始新的工作。

在暂停界面，按 Esc、Enter、Space 或 Ctrl+C 恢复。Ctrl+C 是恢复而不是中止任何 agent。
