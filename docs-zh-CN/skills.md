# Skills

Skills 是基于文件的能力包，在启动时被发现，并以下列形式暴露给模型：

- 系统提示中的轻量元数据（name + description）
- 通过 `read` 工具按需访问 `skill://...` 的内容
- 可选的交互式 `/skill:<name>` 命令

本文档涵盖 `packages/coding-agent/src/extensibility/skills.ts`、`packages/coding-agent/src/discovery/builtin.ts`、`packages/coding-agent/src/internal-urls/skill-protocol.ts` 以及 `packages/coding-agent/src/discovery/agents-md.ts` 中的当前运行时行为。

## 本代码库中 skill 的定义

一个被发现的 skill 表示为：

- `name`
- `description`
- `filePath`（`SKILL.md` 路径）
- `baseDir`（skill 目录）
- 来源元数据（`provider`、`level`、路径）

运行时仅要求 `name` 和 `path` 有效。实际匹配质量取决于 `description` 是否具有实际含义。

## 必需的布局与 SKILL.md 规范

### 目录布局

对于基于 provider 的发现（native/Claude/Codex/Agents/plugin provider），skill 在 **`skills/` 下一级**被发现：

- `<skills-root>/<skill-name>/SKILL.md`

形如 `<skills-root>/group/<skill>/SKILL.md` 的嵌套模式不会被 provider 加载器发现。

对于 `skills.customDirectories`，扫描同样使用非递归布局（`*/SKILL.md`）。

```text
Provider-discovered layout (non-recursive under skills/):

<root>/skills/
  ├─ postgres/
  │   └─ SKILL.md      ✅ discovered
  ├─ pdf/
  │   └─ SKILL.md      ✅ discovered
  └─ team/
      └─ internal/
          └─ SKILL.md  ❌ not discovered by provider loaders

Custom-directory scanning is also non-recursive, so nested paths are ignored unless you point `customDirectories` at that nested parent.
```

### `SKILL.md` frontmatter

skill 类型支持的 frontmatter 字段：

- `name?: string`
- `description?: string`
- `globs?: string[]`
- `alwaysApply?: boolean`
- `hide?: boolean`
- `disableModelInvocation?: boolean`（Agent Skills 中与 `hide` 等价的字段；由 kebab-case 的 `disable-model-invocation` 归一化而来）
- 其他键作为未知元数据保留

当前运行时行为：

- `name` 默认为 skill 目录名
- 以下场景要求 `description`：
  - 原生 `.omp` provider 的 skill 发现（`requireDescription: true`）
  - `omp-plugins` 扩展包 skill 和 `github` provider（`.github/skills/`），同样传入 `requireDescription: true`
  - 通过 `src/discovery/helpers.ts` 中的 `scanSkillsFromDir` 进行的 `skills.customDirectories` 扫描（非递归）
- claude/codex/agents/opencode/claude-plugins provider 可以在没有 description 的情况下加载 skill

## 发现流水线

`packages/coding-agent/src/extensibility/skills.ts` 中的 `loadSkills()` 执行三个阶段：

1. **Capability providers**，通过 `loadCapability("skills")`（managed/auto-learn provider 的 skill 在此被跳过，留到第 3 阶段处理）
2. **Custom directories**，通过 `scanSkillsFromDir(..., { requireDescription: true })`（单层目录枚举）。自定义目录中的 skill 会覆盖同名的默认 provider skill；自定义目录中重复的名称仍是先到者优先。
3. **Managed (auto-learn) skills**（`omp-managed` provider）放在最后解析，因此 provider 或自定义目录中任何同名的已启用 authored skill 都优先

如果 `skills.enabled` 为 `false`，则发现流程不返回任何 skill。

### 内置 skill provider 与优先级

Provider 排序优先按优先级（数值高者优先），并列时按注册顺序。

当前已注册的 skill provider：

1. `native`（priority 100）— 通过 `src/discovery/builtin.ts` 加载的 `.omp` 用户/项目 skill
2. `omp-plugins`（priority 90）— 与扩展包相邻捆绑的 `skills/`，扩展包通过 `extensions:`、`--extension`/`-e` 加载，或安装在 `~/.omp/plugins/node_modules` 下的插件
3. `claude`（priority 80）
4. priority 70 组（按注册顺序）：
   - `claude-plugins`
   - `agents`
   - `codex`
5. `opencode`（priority 55）
6. `github`（priority 30）— `.github/skills/<name>/SKILL.md`（GitHub Agent Skills 布局，仅限项目）
7. `omp-managed`（priority 5）— `~/.omp/agent/managed-skills` 下的 auto-learn skill，在 `src/discovery/builtin.ts` 中注册且无条件发现（仅写入/触发受 `autolearn.enabled` 控制）；始终让位于同名的 authored skill

去重键为 skill 名称。给定名称的首个条目胜出。

### 来源开关与过滤

`loadSkills()` 应用以下控制项：

- 来源开关：`enableCodexUser`、`enableClaudeUser`、`enableClaudeProject`、`enablePiUser`、`enablePiProject`、`enableAgentsUser`、`enableAgentsProject`
- 形如 `skill:<name>` 的 `disabledExtensions` 条目
- `ignoredSkills`（排除；glob 模式）
- `includeSkills`（包含白名单；glob 模式；为空表示全部包含）

过滤顺序为：

1. 未被 `disabledExtensions` 禁用
2. 来源已启用
3. 未被忽略
4. 被包含（若存在 include 列表）

`agents` provider（`.agent[s]/skills`）是规范的 OMP 原生位置，拥有独立的 `enableAgentsUser`/`enableAgentsProject` 开关——禁用 Claude/Codex/Pi **不会**关闭它。没有专用开关的 provider（`claude-plugins`、`opencode`、`github` ……）在**任意**具名第三方来源开关被启用时即被启用。

### 冲突与重复处理

- Capability 去重已按名称保留首个 skill（最高优先级的 provider）
- `extensibility/skills.ts` 额外进行：
  - 通过 `realpath` 对相同文件去重（对 symlink 安全）
  - 在后续 skill 名称冲突时发出冲突警告
  - 保留便捷的 `loadSkillsFromDir({ dir, source })` API，作为 `scanSkillsFromDir` 的轻量适配器
- 自定义目录中的 skill 在 provider skill 之后合并，并覆盖同名的默认路径 provider skill。在自定义目录之间，同名 skill 先到者优先。

## 运行时使用行为

### 系统提示暴露

系统提示构建（`src/system-prompt.ts`）按如下方式使用已发现的 skill：

- 若 `read` 工具可用：
  - 在提示中包含已发现 skill 列表，排除 `hide: true` 的 skill
- 否则：
  - 省略已发现列表

`hide: true` 并不会禁用该 skill。隐藏的 skill 仍会被加载，并在启用 skill 命令时可通过 `skill://<name>` 和 `/skill:<name>` 访问。

Task 工具的子代理通过常规会话创建接收当前会话的已发现/已提供 skill 列表；没有针对单个任务的 skill 钉选覆写。

### 交互式 `/skill:<name>` 命令

如果 `skills.enableSkillCommands` 为 true，交互模式会为每个已发现的 skill 注册一个斜杠命令。

`/skill:<name> [args]` 行为：

- 识别传统的前导形式，以及嵌入在普通散文中的、以空白分隔的 `/skill:<name>` 标记
- 对于嵌入的标记，移除该标记并将周围散文作为参数传递
- 当草稿以其他斜杠命令或本地 bash/Python 执行标记开头时，不将嵌入的标记视为调用
- 直接从 `filePath` 读取 skill 文件
- 去除 frontmatter
- 用 skill 名称、基础目录和可选的用户参数包装正文，然后将其作为自定义消息注入
- 投递模式遵循 **提交按键绑定**：
  - **Enter** → 在流式输出期间，将 skill 投递到 `steer` 队列（与自由文本 Enter 行为一致，同样用于 steer）；当智能体未在流式输出时，作为普通的空闲提示
  - **Ctrl+Enter**（`app.message.followUp`）→ 在流式输出期间，将 skill 投递到 `followUp` 队列；当智能体未在流式输出时，作为普通的空闲提示

没有任何标志、模式选择器或 frontmatter 旋钮可以覆写投递模式——按键绑定 _就是_ 选择，与流式输出期间的自由文本路由完全一致。

## `skill://` URL 行为

`src/internal-urls/skill-protocol.ts` 支持：

- `skill://<name>` → 解析为该 skill 的 `SKILL.md`
- `skill://<name>/<relative-path>` → 在该 skill 目录内解析

```text
skill:// URL resolution

skill://pdf
  -> <pdf-base>/SKILL.md

skill://pdf/references/tables.md
  -> <pdf-base>/references/tables.md

Guards:
- reject absolute paths
- reject `..` traversal
- reject any resolved path escaping <pdf-base>
```

解析细节：

- skill 名称必须完全匹配
- 相对路径会进行 URL 解码
- 拒绝绝对路径
- 拒绝路径穿越（`..`）
- 解析后的路径必须位于 `baseDir` 之内
- 缺失的文件返回显式的 `File not found` 错误

内容类型：

- `.md` => `text/markdown`
- 其他一切 => `text/plain`

对缺失的资源不执行回退搜索。

## Skills 与 AGENTS.md、命令、工具、Hooks 的区别

### Skills vs AGENTS.md

- **Skills**：按名称可选的能力包，依据任务上下文或显式请求被选用
- **AGENTS.md/上下文文件**：作为上下文文件能力加载的持久性指令文件，按 level/depth 规则合并

`src/discovery/agents-md.ts` 从 `cwd` 开始向上遍历祖先目录，以发现独立的 `AGENTS.md` 文件。对于位于用户主目录下的仓库，它会继续遍历外层的工作区目录，直到但不包括主目录。若主目录下没有仓库根，则主目录边界仍然包含在内。否则，它会在仓库根目录处停止，或在主目录之外无法识别仓库根目录时在文件系统根目录处停止。隐藏属主目录下的文件会被跳过。

### Skills vs 斜杠命令

- **Skills**：模型可读取的知识/工作流内容
- **Slash commands**：用户调用的命令入口
- `/skill:<name>` 是一个注入 skill 文本的便捷包装器；它不会改变 skill 发现语义

### Skills vs 自定义工具

- **Skills**：通过提示上下文和 `read` 加载的文档/工作流内容
- **Custom tools**：可由模型调用、具备 schema 和运行时副作用的可执行工具 API

### Skills vs Hooks

- **Skills**：被动内容
- **Hooks**：事件驱动的运行时拦截器，可在执行期间阻止/修改行为

## 与发现逻辑绑定的实用编写指南

- 将每个 skill 放在自己的目录中：`<skills-root>/<skill-name>/SKILL.md`
- 始终显式包含 `name` 和 `description` frontmatter
- 将引用的资源放在同一 skill 目录下，并通过 `skill://<name>/...` 访问
- 对于嵌套分类（`team/domain/skill`），将 `skills.customDirectories` 指向嵌套的父目录；扫描本身仍是非递归的
- 避免跨来源出现重复的 skill 名称；首个匹配按 provider 优先级胜出