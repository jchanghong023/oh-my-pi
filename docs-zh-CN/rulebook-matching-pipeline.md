# Rulebook 匹配流水线

本文档描述 coding-agent 如何从受支持的配置格式中发现规则，将其归一化为统一的 `Rule` 形态，解决优先级冲突，并将结果拆分为：

- **Rulebook 规则**（通过系统提示 + `rule://` URL 供模型使用）
- **TTSR 规则**（Time Traveling Stream Rules，时间回溯流规则）

它反映了当前的实现，包括部分语义以及已解析但未强制执行的元数据。

## 实现文件

- [`packages/coding-agent/src/capability/rule.ts`](../packages/coding-agent/src/capability/rule.ts)
- [`packages/coding-agent/src/capability/rule-buckets.ts`](../packages/coding-agent/src/capability/rule-buckets.ts)
- [`packages/coding-agent/src/capability/index.ts`](../packages/coding-agent/src/capability/index.ts)
- [`packages/coding-agent/src/discovery/index.ts`](../packages/coding-agent/src/discovery/index.ts)
- [`packages/coding-agent/src/discovery/helpers.ts`](../packages/coding-agent/src/discovery/helpers.ts)
- [`packages/coding-agent/src/discovery/builtin.ts`](../packages/coding-agent/src/discovery/builtin.ts)
- [`packages/coding-agent/src/discovery/omp-plugins.ts`](../packages/coding-agent/src/discovery/omp-plugins.ts)
- [`packages/coding-agent/src/discovery/builtin-defaults.ts`](../packages/coding-agent/src/discovery/builtin-defaults.ts)
- [`packages/coding-agent/src/discovery/agents.ts`](../packages/coding-agent/src/discovery/agents.ts)
- [`packages/coding-agent/src/discovery/github.ts`](../packages/coding-agent/src/discovery/github.ts)
- [`packages/coding-agent/src/discovery/cursor.ts`](../packages/coding-agent/src/discovery/cursor.ts)
- [`packages/coding-agent/src/discovery/windsurf.ts`](../packages/coding-agent/src/discovery/windsurf.ts)
- [`packages/coding-agent/src/discovery/cline.ts`](../packages/coding-agent/src/discovery/cline.ts)
- [`packages/coding-agent/src/sdk.ts`](../packages/coding-agent/src/sdk.ts)
- [`packages/coding-agent/src/system-prompt.ts`](../packages/coding-agent/src/system-prompt.ts)
- [`packages/coding-agent/src/internal-urls/rule-protocol.ts`](../packages/coding-agent/src/internal-urls/rule-protocol.ts)
- [`packages/utils/src/frontmatter.ts`](../packages/utils/src/frontmatter.ts)

## 1. 规范的规则形态

所有 provider 将源文件归一化为 `Rule`：

```ts
interface Rule {
  name: string;
  path: string;
  content: string;
  globs?: string[];
  alwaysApply?: boolean;
  description?: string;
  condition?: string[];
  astCondition?: string[];
  scope?: string[];
  interruptMode?: "never" | "prose-only" | "tool-only" | "always";
  _source: SourceMeta;
}
```

能力标识为 `rule.name`（`ruleCapability.key = rule => rule.name`）。

推论：优先级与去重**仅基于名称**。两个具有相同 `name` 的不同文件被视为同一条逻辑规则。

## 2. 发现源与归一化

`src/discovery/index.ts` 会自动注册 provider。对于 `rules`，当前的 provider 包括：

- `native`（优先级 `100`）
- `omp-plugins`（优先级 `90`）— 已配置的扩展包根目录下的 `rules/*.{md,mdc}`，通过共享的 `buildRuleFromMarkdown` 路径归一化
- `agents`（优先级 `70`）
- `cursor`（优先级 `50`）
- `windsurf`（优先级 `50`）
- `cline`（优先级 `40`）
- `github`（优先级 `30`）
- `builtin-defaults`（优先级 `1`）

### Native provider（`builtin.ts`）

从以下位置加载 `.omp` 规则：

- 项目规则：当 cwd 的 `.omp/` 目录非空时，加载 `<cwd>/.omp/rules/*.{md,mdc}`
- 用户规则：`<active-native-agent-dir>/rules/*.{md,mdc}`
- 粘性用户规则：`<active-native-agent-dir>/RULES.md`
- 粘性项目规则：从 cwd 向仓库根目录遍历时，所选最近且非空的 `.omp/` 目录中的 `RULES.md`；当该目录缺少该文件时，OMP 不会继续向更上层查找

活动的 native agent 目录默认为 `~/.omp/agent`，遵循命名 profile，并支持 `PI_CODING_AGENT_DIR`。

归一化：

- `name` = 不含 `.md`/`.mdc` 的文件名
- frontmatter 通过 `parseFrontmatter` 解析
- `content` = 正文（剥离 frontmatter 后）
- `globs`、`alwaysApply`、`description`、`condition`/旧版 `ttsr_trigger`、`astCondition`、`scope` 和 `interruptMode` 由 `buildRuleFromMarkdown` 解析
- 顶层的 `RULES.md` 被合成为规则名 `RULES`，并强制设为 `alwaysApply: true`

两个粘性文件都使用固定名称 `RULES`。由于 native 项依次作为项目规则、用户规则、用户粘性 `RULES.md`、项目粘性 `RULES.md` 追加，最先出现的 `RULES` 项获胜。通常这意味着用户粘性内容会覆盖项目粘性内容；常规的 `rules/RULES.md` 可以同时覆盖两者。

重要提示：看起来像文件 globs 的 `condition` 值会被转换为 `tool:edit(...)` / `tool:write(...)` scope 简写形式，并附带通配条件 `.*`。

### Agents provider（`agents.ts`）

同时从 `.agent` 和 `.agents` 目录加载：

- 项目：从 `cwd` 向仓库根目录向上遍历，加载 `<ancestor>/.agent/rules/*.{md,mdc}` 和 `<ancestor>/.agents/rules/*.{md,mdc}`
- 用户：`~/.agent/rules/*.{md,mdc}` 和 `~/.agents/rules/*.{md,mdc}`

归一化使用共享的 `buildRuleFromMarkdown` 路径：派生自文件名的名称、剥离 frontmatter 的正文，以及解析后的 `globs`、`alwaysApply`、`description`、`condition`/旧版 `ttsr_trigger`、`astCondition`、`scope` 和 `interruptMode`。

### Cursor provider（`cursor.ts`）

从以下位置加载：

- 用户：`~/.cursor/rules/*.{mdc,md}`
- 项目：`<cwd>/.cursor/rules/*.{mdc,md}`

归一化（`transformMDCRule`）：

- `description`：仅当为字符串时保留
- `alwaysApply`：归一化为布尔值 — 仅当 frontmatter 中存在 `alwaysApply: true` 时为 `true`（其他情况均为 `false`）
- `globs`：接受数组（仅限字符串元素）或单个字符串
- `condition`/旧版 `ttsr_trigger`、`astCondition`、`scope` 和 `interruptMode` 由共享的规则辅助函数解析
- `name` 来自不含扩展名的文件名

### Windsurf provider（`windsurf.ts`）

从以下位置加载：

- 用户：`~/.codeium/windsurf/memories/global_rules.md`（固定规则名 `global_rules`）
- 项目：`<cwd>/.windsurf/rules/*.md`

归一化：

- `globs`：字符串数组或单个字符串
- `alwaysApply`、`description`、`condition`/旧版 `ttsr_trigger`、`astCondition`、`scope` 和 `interruptMode` 由共享的规则辅助函数解析
- `name` 对于用户全局文件固定为 `global_rules`，对于项目规则则派生自文件名

### Cline provider（`cline.ts`）

从 `cwd` 向上搜索最近的 `.clinerules`：

- 如果是目录：加载其中的 `*.md`
- 如果是文件：将该文件作为名为 `clinerules` 的单条规则加载

归一化：

- `globs`：字符串数组或单个字符串
- `alwaysApply`、`description`、`condition`/旧版 `ttsr_trigger`、`astCondition`、`scope` 和 `interruptMode` 由共享的规则辅助函数解析
- `name` 对于 `.clinerules` 文件固定为 `clinerules`，对于 `.clinerules/*.md` 则派生自文件名

### GitHub provider（`github.ts`）

递归加载以下位置的 `*.instructions.md`：

- 项目：`<cwd>/.github/instructions/`
- 用户：逗号分隔的 `COPILOT_CUSTOM_INSTRUCTIONS_DIRS` 中每个目录下的 `<dir>/.github/instructions/`

不含 `.instructions.md` 的文件名即为规则名。共享的 Markdown 解析仍能识别常规的 OMP 规则元数据，包括 TTSR 字段。GitHub 的 `applyTo` 还会进行如下额外归一化：

- 逗号分隔的字符串（或可容错的 YAML 数组）转换为 `globs`；
- `*`、`**` 或 `**/*` 使该规则变为 always-apply，并清空 `globs`；
- 任何其他 glob 使该规则变为非 always-apply；缺失的 `description` 会由 globs 生成；
- 缺失的 `applyTo` 会产生一条 rulebook 描述以及一条发现警告。

由于 TTSR 分桶在 always-apply/rulebook 分桶之前运行，因此带有可接受的 `condition` 或 `astCondition` 的 GitHub 指令无论 `applyTo` 如何，都只会作为 TTSR 处理。

## 3. Frontmatter 解析行为与歧义

所有 provider 都使用 `parseFrontmatter`（`utils/frontmatter.ts`），其语义如下：

1. 仅当内容以 `---` 开头并以 `\n---` 闭合时，才会解析 frontmatter。
2. 提取 frontmatter 后会对正文进行 trim。
3. 如果整篇文档的 YAML 解析失败：
   - 记录一条警告，
   - 解析器回退为简单的 `key: value` 行解析（`^([\w-]+):\s*(.*)$`），
   - 每个捕获的值会单独重新按 YAML 解析，只有仍然解析失败的值才保留为原始 trim 后的字符串。

回退模式的限制：

- 多行数组、嵌套对象以及其他依赖缩进的 YAML 结构不会被重建。单行 flow 形式（例如 `[text, thinking]`）仍可能在逐值重解析中存活下来。
- 单独畸形值会保留为原始字符串；需要布尔、列表或对象的 provider 可能会丢弃此类元数据。
- `ttsr_trigger` 在回退模式下可用（下划线键）；带连字符的键如 `thinking-level` 也能解析，并被归一化为 camelCase（`thinkingLevel`）— 键归一化同样适用于 YAML 路径。
- 没有合法 frontmatter 的文件仍会作为规则加载，具有空元数据和完整的内容正文。scope 解析器还能容忍常见的畸形回退写法 `scope: "text","thinking"`，但推荐使用合法的 YAML（`"text, thinking"` 或 `[text, thinking]`）。

## 4. Provider 优先级与去重

`loadCapability("rules")`（`capability/index.ts`）合并各 provider 的输出，然后按 `rule.name` 去重。

### 优先级模型

- Provider 按优先级降序排列。
- 相同优先级保留注册顺序（在 `discovery/index.ts` 中 `cursor` 排在 `windsurf` 之前）。
- 去重采用先到先得：保留最先遇到的规则名；后续同名项在 `all` 中被标记为 `_shadowed`，并从 `items` 中排除。

当前有效的规则 provider 顺序为：

1. `native` (100)
2. `omp-plugins` (90)
3. `agents` (70)
4. `cursor` (50)
5. `windsurf` (50)
6. `cline` (40)
7. `github` (30)
8. `builtin-defaults` (1)

### provider 内部排序的注意事项

在同一个 provider 内，项的顺序来自 `loadFilesFromDir` glob 结果的顺序以及显式的 push 顺序。这在正常使用下足够确定，但代码中并未显式排序。

值得注意的源顺序差异：

- `native` 依次追加项目 `.omp/rules`、用户 `~/.omp/agent/rules`、用户 `RULES.md`，然后是最近的项目 `RULES.md`。
- `omp-plugins` 针对每个已配置的扩展包根目录依次追加其 `rules/` 结果。
- `agents` 先追加项目向上遍历的 `.agent`/`.agents` 规则目录，再追加用户主目录。
- `cursor` 先追加用户结果，再追加项目结果。
- `windsurf` 先追加用户 `global_rules`，再追加项目规则。
- `cline` 仅加载最近的 `.clinerules` 源。
- `github` 先追加 cwd 项目指令，再按环境列表顺序追加每个 `COPILOT_CUSTOM_INSTRUCTIONS_DIRS` 条目。
- `builtin-defaults` 使用内嵌规则的源顺序。

## 5. 拆分为 Rulebook、Always-Apply 与 TTSR 桶

在 `createAgentSession`（`sdk.ts`）中完成规则发现后，`bucketRules(...)` 会应用会话级过滤与桶分配：

1. 丢弃 `ttsr.disabledRules` 中列出的规则。
2. 当 `ttsr.builtinRules === false` 时，丢弃来自 `builtin-defaults` provider 的规则。
3. 将具有非空 `condition` 或 `astCondition` 的规则注册到 `TtsrManager`；如果注册成功，该规则仅为 TTSR。
4. 将剩余的 `alwaysApply === true` 规则放入 `alwaysApplyRules`。
5. 将剩余的具有 `description` 的规则放入 `rulebookRules`。

### 桶的行为

- **TTSR 桶**：任何启用的规则，只要具有非空的已解析 `condition`（正则）或 `astCondition`（ast-grep 模式），且能被 `TtsrManager.addRule(...)` 接受。优先级高于其他桶。
- **Always-apply 桶**：`alwaysApply === true` 且非 TTSR。完整内容被注入系统提示。可通过 `rule://` 解析。
- **Rulebook 桶**：必须具有 description，必须不是 TTSR，必须不是 `alwaysApply`。在系统提示中按名称 + description 列出；内容通过 `rule://` 按需读取。
- 同时具有触发条件和 `alwaysApply` 的规则仅当 TTSR 注册接受时才会进入 TTSR；否则它可以回退到 always-apply。
- 同时具有 `alwaysApply` 和 `description` 的规则仅进入 always-apply（不会进入 rulebook）。

## 6. 元数据如何影响运行时行为

### `description`

- 包含进 rulebook 所必需。
- 在系统提示的 rulebook 块中渲染（默认模板中为 `<domain-rules>`，自定义提示模板中为 `<rules>`）。
- 缺失 description 会使该规则无法出现在 rulebook 列表中；除非它是 always-apply 或被接受的 TTSR 规则，否则也无法通过 `rule://` 寻址。

### `globs`

- 沿用至 `Rule`。
- 在默认提示的 rulebook 列表中以内联形式渲染（`- <name> (<glob>, ...): <description>`）；自定义提示模板则将其渲染为 `<glob>...</glob>` 条目。
- 在 rules UI 状态中暴露（`extensions` 模式列表）。
- 被 TTSR 用作全局路径门控：如果 TTSR 规则带有 globs，则匹配上下文必须包含至少一个匹配的文件路径。
- 不会自动为 `rule://` 选择 rulebook 规则；rulebook 匹配仍属于建议性的提示行为。

### `alwaysApply`

- 由 provider 解析并保留。
- 用于 UI 显示（extensions 状态管理器中的 `"always"` 触发器标签）。
- 用作 `rulebookRules` 的排除条件。
- **完整规则内容会被自动注入系统提示**（在 rulebook 规则段之前）。
- 该规则也可通过 `rule://<name>` 寻址以重新读取。

### `condition`、`astCondition`、`scope` 和 `interruptMode`

- `condition` 是 TTSR 触发字段的正则形式；旧版 `ttsr_trigger` / `ttsrTrigger` 在解析期间作为回退输入被接受。前导的 `(?i)`、`(?m)` 或 `(?s)` 内联标志组会被转换为等价的 JavaScript `RegExp` 标志。
- `astCondition` 是 ast-grep 触发字段：字符串或 YAML 序列的结构模式，按原文保留（不进行 glob 推断）。它仅在 edit/write 工具流上匹配，工具流上的语言由文件路径推断。一条规则可以设置 `condition`、`astCondition`，或两者皆有。
- `scope` 将 TTSR 匹配限制在一组允许的流 surface 范围内。它接受逗号分隔的 YAML 字符串或 YAML 序列。省略时，会监听助手正文（`text`）和所有工具参数（`tool`），但不监听 thinking。

  ```yaml
  # 正文与 thinking；等效形式：
  scope: "text, thinking"
  ```

  ```yaml
  scope: [text, thinking]
  ```

  ```yaml
  # 块式 YAML 序列同样合法：
  scope:
    - text
    - thinking
  ```

  ```yaml
  # 仅匹配 edit/write 生成的 TypeScript 源码快照：
  scope: "tool:edit(*.ts), tool:write(*.ts)"
  ```

  合法的 token 包括 `text`、`thinking`、`tool`（或 `toolcall`），以及 `tool:<name>(<path-glob>)`。解析器能容忍畸形的回退写法 `scope: "text","thinking"`，但可移植的规则文件应将逗号放在一个 YAML 字符串内，或使用 YAML 序列。

- 看起来像文件 glob 的 `condition` token 会变成 `tool:edit(<glob>)` 和 `tool:write(<glob>)` scope 条目，并附带通配条件 `.*`；`astCondition` token 永远不会触发此简写。
- `interruptMode` 可以为该规则覆盖全局 TTSR 中断模式。

## 7. 系统提示的包含路径

`buildSystemPromptInternal` 接收 `rules`（rulebook）和 `alwaysApplyRules` 两类输入。

Always-apply 规则会与生效的系统/自定义/追加提示源以及已加载的上下文文件正文进行去重。规则内容已经出现在上述任一来源中的，会从自动注入中省略。其余原始正文渲染在 rulebook 列表之前：默认模板中位于 `<generic-rules>` 内部，在打包的自定义提示模板中直接渲染。

Rulebook 规则在 `<domain-rules>` 块中以 `- <name> (<globs>): <description>` 行形式渲染；提示中的 URL 列表会记录 `rule://<name>`，工作流部分会告诉模型先读取相关规则。自定义提示模板（`custom-system-prompt.md`）则改为以 `<rule name="...">` 条目渲染其下的 `<glob>` 子项，并在显式的 "You MUST read `rule://<name>`" 指令下组织。

这是建议性/上下文性的：提示文本要求模型读取适用的规则，但代码并不强制 glob 适用范围。

## 8. `rule://` 内部 URL 行为

`RuleProtocolHandler` 针对在 `sdk.ts` 中为每个顶层会话安装一次的进程全局 active-rule 快照进行解析：

```ts
setActiveRules([
  ...rulebookRules,
  ...alwaysApplyRules,
  ...ttsrManager.getRules(),
]);
```

含义如下：

- `rule://<name>` 会在 **rulebookRules**、**alwaysApplyRules** 以及 **已注册的 TTSR 规则** 中解析。
- TTSR 规则在分桶时被排除在 rulebook/always 之外，但 `ttsrManager.getRules()` 会将它们重新加入快照，因此被触发的规则（例如 builtin）仍可通过 `rule://` 寻址以重新读取。
- 没有 description、没有 `alwaysApply`、且没有可接受的 TTSR 条件的规则无法通过 `rule://` 寻址。
- 解析采用精确的名称匹配。
- 未知名称会返回错误，并列出可用的规则名。
- 返回的内容是原始的 `rule.content`（已剥离 frontmatter），内容类型为 `text/markdown`。

## 9. 已知部分实现/未强制执行的语义

1. 当前为 `rules` 加载的规则 provider 包括 `native`、`omp-plugins`、`agents`、`cursor`、`windsurf`、`cline`、`github` 以及内嵌的 `builtin-defaults`；针对其他工具的 provider 文件可能解析其他配置格式，但不会注册规则加载器。
2. `globs` 元数据会暴露给提示/UI，并被用作 TTSR 匹配的全局路径门控，但它不会被用于自动为 `rule://` 选择 rulebook 规则。
3. `rule://` 的规则选择包含 rulebook、always-apply 以及已注册的 TTSR 规则（因此被触发的 TTSR 规则可被重新读取），但不包括没有注册任何 condition、且既没有 description 也没有 `alwaysApply` 的规则。
4. 发现警告（`loadCapability("rules").warnings`）会被产生，但 `createAgentSession` 当前不会在该路径中暴露/记录它们。
