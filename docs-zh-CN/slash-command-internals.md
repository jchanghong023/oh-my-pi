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

- 支持 `'single'` 和 `"double"` 引用以保留空格
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

## 11) 内置命令说明：`/btw`

`/btw <question>` 使用当前会话上下文提出一个独立的旁支问题。单独的 `/btw` 会打开本会话的历史记录，并选中最新提出的问题。已保存的旁支问题不会追加到主转录中，也不会作为历史发送给无关的轮次。每次新的 `/btw <question>` 都保持独立；显式的后续提问只包含所选旁支对话以及当前主会话上下文。

之前的问题和回答会作为独立的 `user` 和 `assistant` 消息重放，随后是新的用户问题，而不是嵌入在一个提示中。原始问题模板在后续提问中保持相同的位置。历史记录在异步转换之前会被快照，并使用正常的 provider 规范化和密钥混淆管线。

主提示缓存键和静态系统/工具前缀被保留。每个 BTW 主题都有自己稳定的 provider 侧对话标识，与主对话以及其他主题分开。成功且串行化的后续提问会复用该标识；在取消、失败或中断的轮次之后，下一次请求会使用新的传输代（transport generation），因此一个正在回滚的请求无法共享其状态。没有会话键的独立临时调用者保持每次请求的 ID。实际的缓存命中取决于 provider。主会话上下文仍然是最新的，而不是冻结在第一个问题时的状态；推进或压缩它可能会改变前缀。

已保存的 BTW 记录包含可见的回答文本，而不是不透明的 provider 推理或重放签名，因此恢复时会保留对话的角色和文本，而不是逐字节的原生 provider 转录。

- 内联 BTW 正在运行时，`Esc` 会取消请求并将其部分回答以 `Cancelled` 保持可见。再按一次 `Esc` 关闭面板。
- 在历史记录中，`Esc` 会取消所选的运行中主题而不关闭历史记录；否则它会关闭历史记录。如果另一个主题仍在运行，其内联面板会被恢复，而不是留在后台隐藏。
- 已完成、已取消和失败的面板用 `Esc` 关闭；它们的历史记录保持已保存状态。没有「隐藏并继续」的操作，也没有单独的 `x` 取消键。
- `c` 复制已完成的内联回答，或所选主题最新的非空回答。
- 内联 BTW 回答完成后，`f` 直接打开该主题的后续提问输入，无需先输入 `/btw`。主编辑器必须为空且获得焦点。
- 在历史记录中，`f` 或 `Enter` 会为所选主题打开原生的后续提问输入。在输入中，`Enter` 发送非空问题，`Esc` 取消草稿并返回历史记录；`f`、`c` 和 `x` 是普通文本。Escape 也会在已提交的后续提问的启动写入仍待处理时取消它，而不会发起模型请求。如果它的初始检查点已经在进行中，该轮次会在另一个后续提问开始之前被保存为已取消。
- 后续提问追加到同一主题，保留之前的回答和已取消的部分输出，并且在恢复会话后仍然存在。原始问题仍是历史列表的标题；`Details` 按时间顺序显示每一个问题和回答。
- 在历史记录中，`Up`/`Down` 选择主题；`Tab` 在历史记录和详情之间切换。`Right` 聚焦详情，`Left` 返回历史记录。
- 聚焦的详情支持滚动、`Page Up`/`Page Down` 和 `Home`/`End`。窄终端一次只显示一个窗格。
- 任何 BTW 请求正在运行时，新问题和后续提问都会被拒绝。没有隐式取消或排队。
- 被拒绝的后续提问提交会保留草稿以便重试；在提交待处理期间重复按 Enter 不会创建重复的请求。

历史记录以私有的按主题文件形式保存在会话工件目录的 `btw-history/` 子目录下。这使 `/btw` 从仅瞬态显示变为随会话一起本地保留。即使是只包含旁支问题的会话也会变为可恢复的。`--no-session` 只将历史记录保存在内存中。普通的转录导出/分享不包含这些伴随记录。

每个主题都使用操作系统级的跨进程租约，并在原子替换之前进行修订检查。运行中的轮次会保留其租约直到终止检查点；另一个进程无法覆盖活跃的所有者或过期的主题快照。冲突的后续提问会在任何模型请求之前被拒绝，重新打开或重试会读取最新保存的历史记录。被拒绝的写入永远不会替换已提交的内存视图。

根问题和后续提问的时间戳必须为非负且在 JavaScript 支持的 Date 范围内（至多 `8.64e15` 毫秒）；无效的记录会在历史渲染之前被拒绝。

迁移在目标被选定并验证之前是无损的。在 BTW 请求正在启动或运行时，`/move`、`/wt` 和独立的持久化 `!cd` 会拒绝重定位，要求操作者显式完成或取消它。对于 `/move`，同一个门控会在确认或创建缺失的目标目录之前获取，并在整个重定位过程中保持。因此，忙碌的请求或未保存的检查点既不会留下新目录，也不会留下已移动的会话。`/wt` 门控会在创建分支或检出之前获取，并在会话重定位和配置的源清理过程中保持，因此忙碌拒绝不会留下未使用的 worktree。`!cd` 守卫在 shell 执行之前运行，并在 cwd 采用或回滚过程中保持，因此被拒绝的命令不会让 shell 停留在不同的目录中。已取消的选择器、无效的目标和失败的移动会保留 BTW 对话。成功的重定位只在移动已保存的工件之后才清除旧视图。

从路径、会话选择器或导入的会话恢复会取消 BTW 并等待其终止检查点后再切换。确认删除活动会话会在分离并移除其工件之前使用同样的清理。BTW 持久化失败会使源会话及其工件保持原样。拒绝删除或删除非活动会话不会取消当前的 BTW。使用 `context.newSession`、`context.switchSession` 或 `context.branch` 的扩展命令也会在更改会话状态或清除扩展 UI 之前运行此清理。这既适用于扩展初始化时，也适用于其命令上下文被重新初始化时。

会话操作最多等待 10 秒以完成未决的 BTW 持久化。超时会停止操作并让当前会话保持原位；它不会取消底层的文件系统写入，也不允许迁移/删除在该写入完成后延迟运行。失败的终止检查点也会在其待处理的 promise 结算后停止这些操作；未保存的回答仍然可以查看和复制。重试操作会针对其原始磁盘修订重试保留的快照。瞬态 I/O 失败可以恢复，但冲突绝不会静默地变基覆盖另一个写入者的更改。初始检查点被拒绝仍然会阻止模型分发，并且可以正常重新加载历史记录。可见的 BTW 错误使用有界的单行文本，移除了控制序列并缩短了内嵌的主目录路径；原始错误仍可在诊断日志和异常原因中用于故障排查。

开始一个问题会保存其运行状态。完成、错误和显式取消会保存最终检查点；已取消的回答保留已接收到的文本。崩溃可能丢失未检查点的流式文本，但已保存的运行记录会重新打开为 `Interrupted`，并且永远不会自动重新提交。历史记录保持附着在会话工件上，并跟随复制或移除这些工件的操作；它不会移动对话叶节点。

现有的内联 `b` 操作只有在原始会话/叶节点未更改且主会话空闲时，才会将已完成的单轮回答提升为聊天分支。多轮旁支对话仍保留在 BTW 历史中；只提升其最新的一对问答会丢弃更早的上下文。历史浏览不会提升回答或放宽这些分支守卫。
