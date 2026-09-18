# 配置发现与解析

本文档介绍 coding-agent 当前如何解析配置：扫描哪些根目录、优先级如何运作，以及解析后的配置如何被设置、skill、hook、工具和扩展消费。

## 范围

主要实现：

- `packages/coding-agent/src/config.ts`
- `packages/coding-agent/src/config/config-file.ts`（从 `config.ts` 重新导出）
- `packages/coding-agent/src/config/settings.ts`
- `packages/coding-agent/src/config/settings-schema.ts`
- `packages/coding-agent/src/discovery/builtin.ts`
- `packages/coding-agent/src/discovery/helpers.ts`

关键集成点：

- `packages/coding-agent/src/capability/index.ts`
- `packages/coding-agent/src/discovery/index.ts`
- `packages/coding-agent/src/extensibility/skills.ts`
- `packages/coding-agent/src/extensibility/hooks/loader.ts`
- `packages/coding-agent/src/extensibility/custom-tools/loader.ts`
- `packages/coding-agent/src/extensibility/extensions/loader.ts`

---

## 解析流程（可视化）

```text
         Generic helper order (`config.ts`)
┌───────────────────────────────────────┐
│ 1) ~/.omp/agent, ~/.claude, ...       │
│ 2) <cwd>/.omp, <cwd>/.claude, ...     │
└───────────────────────────────────────┘
                    │
                    ▼
        capability providers enumerate items
 (native provider scans project .omp before user .omp;
  other providers have their own loading rules)
                    │
                    ▼
      provider priority sort + capability dedup
                    │
                    ▼
          subsystem-specific consumption
   (settings, skills, hooks, tools, extensions)
```

## 1) 配置根目录与源顺序

## 规范根目录

`src/config.ts` 定义了一个固定的源优先级列表：

1. `.omp`（native）
2. `.claude`
3. `.codex`
4. `.gemini`

用户级基础目录：

- OMP native：`~/<PI_CONFIG_DIR>/agent`（通常为 `~/.omp/agent`；命名 profile 会按下文所述更改此路径）
- `~/.claude`
- `~/.codex`
- `~/.gemini`

项目级基础目录：

- `<cwd>/.omp`
- `<cwd>/.claude`
- `<cwd>/.codex`
- `<cwd>/.gemini`

`CONFIG_DIR_NAME` 为 `.omp`（`packages/utils/src/dirs.ts`）。`PI_CONFIG_DIR` 会更改通用助手使用的 OMP 用户根目录。`PI_CODING_AGENT_DIR` 则不同：对于默认 profile，它会更改 `getAgentDir()` 的各类使用者（如 native 发现、设置和运行时状态），但**不会**更改通用 `getConfigDirs()` / `findConfigFile()` 所用的 OMP 基础目录。命名 profile 会忽略 `PI_CODING_AGENT_DIR`。

## Profile

命名 profile（`omp --profile <name>`、`OMP_PROFILE`，或旧版回退 `PI_PROFILE`）会重新定位 OMP 用户基础目录。只要 `OMP_PROFILE` 已定义（即使显式为空），它就优先；`default`、空值或纯空白会选择默认 profile。当某个 profile 处于活动状态时，本文写作 `~/.omp/agent/...` 的每个 OMP native 用户级路径通常都会解析为 `~/.omp/profiles/<name>/agent/...`。`--alias <command>` 本身不会选择 profile：与 `--profile` 搭配时，它会为该 profile 创建一个 shell 快捷方式。

这种重定位在 native provider（`builtin.ts`）和通用 `config.ts` 助手之间是一致的，因此它覆盖斜杠命令、规则、提示词、指令、hook、工具、扩展、设置、skill 和 MCP，以及顶层 `SYSTEM.md` / `RULES.md` / `AGENTS.md` 文件和运行时状态（会话、blob、`agent.db`）。一个 profile 只能看到自己的 OMP 配置，永远看不到默认 profile 的 agent 配置。

键绑定是唯一的例外：命名 profile 会在自己的 `~/.omp/profiles/<name>/agent/keybindings.*` 之下合并默认 profile 的 `~/.omp/agent/keybindings.*`，由 profile 文件按绑定逐项覆盖（[#4867](https://github.com/can1357/oh-my-pi/issues/4867)）。键绑定描述的是用户面前的终端/键盘，它不随活动 profile 变化，因此用户级的重映射在每个 profile 中都继续生效，除非 profile 显式覆盖了它们。被继承的文件对 profile 进程是只读的——默认 profile 文件的旧格式迁移只在默认 profile 自身运行时才会发生。

在 macOS 和 Linux 上，已存在的 `$XDG_DATA_HOME/omp`、`$XDG_STATE_HOME/omp` 或 `$XDG_CACHE_HOME/omp` 可以重新定位相应的数据、状态或缓存路径。对于命名 profile，OMP 只在某个 XDG 类别中已经存在 `omp/profiles/<name>` 时才使用该类别；否则该类别仍保留在 `~/.omp/profiles/<name>` 之下。在依赖 XDG 路径之前，请先运行 `omp config init-xdg`。

其他源基础目录不受 profile 作用域限制，在每个 profile 下的加载方式完全相同：外部工具的基础目录（`~/.claude`、`~/.codex`、`~/.gemini`）属于那些工具本身，项目级基础目录（`<cwd>/.omp`、`<cwd>/.claude`，……）则绑定到工作目录。在本文档中，除非正在讨论环境变量覆盖或 XDG 路径，否则请将 `~/.omp/agent` 读作活动 profile 的 agent 目录的简写。

## 重要约束

`src/config.ts` 中的通用助手在源发现顺序中**不**包含 `.pi`。

---

## 2) 核心发现助手（`src/config.ts`）

## `getConfigDirs(subpath, options)`

返回有序条目：

- 先是用户级条目（按源优先级）
- 然后是项目级条目（按相同的源优先级）

选项：

- `user`（默认 `true`）
- `project`（默认 `true`）
- `cwd`（默认 `getProjectDir()`）
- `existingOnly`（默认 `false`）

此 API 用于基于目录的配置查找（命令、hook、工具、agent 等）。

## `findConfigFile(subpath, options)` / `findConfigFileWithMeta(...)`

在有序基础目录中搜索第一个存在的文件，返回第一个匹配项（仅路径，或路径+元数据）。

## `findAllNearestProjectConfigDirs(subpath, cwd)`

向上遍历父目录，返回**每个源基础目录中最近的现存目录**（`.omp`、`.claude`、`.codex`、`.gemini`），然后按源优先级对结果排序。

当项目配置需要从祖先目录继承时（monorepo/嵌套工作区行为）使用此 API。

---

## 3) 文件配置包装器（`src/config/config-file.ts` 中的 `ConfigFile<T>`，从 `src/config.ts` 重新导出）

`ConfigFile<T>` 是单个配置文件的 schema 验证加载器。

支持的格式：

- `.yml` / `.yaml`
- `.json` / `.jsonc`

行为：

- 根据提供的 omptype schema 验证解析后的数据。
- 缓存加载结果，直到调用 `invalidate()`。
- 通过 `tryLoad()` 返回三态结果：
  - `ok`
  - `not-found`
  - `error`（带有 schema/parse 上下文的 `ConfigError`）

仍支持旧版迁移：

- 如果目标路径是 `.yml`/`.yaml`，同级的 `.json` 会被自动迁移一次（`migrateJsonToYml`）。

---

## 4) 设置解析模型（`src/config/settings.ts`）

运行时设置模型是分层的：

1. 全局设置：`~/.omp/agent/config.yml` 与 `config.yaml` 中第一个存在的文件
2. 项目设置：通过设置能力发现（来自各 provider 的 `settings.json` 和 `config.yml`）
3. 配置覆盖层：`PI_CONFIG_FILES`（平台路径列表），随后是重复传入的 `omp --config <path>` 文件；所有这些都只作为本进程的 `config.yml` 风格 YAML 加载
4. 运行时覆盖：内存中，非持久化
5. schema 默认值：来自 `SETTINGS_SCHEMA`

有效优先级：

`defaults <- global <- project <- PI_CONFIG_FILES overlays <- --config overlays <- runtime overrides`

在任一覆盖层列表内，后面的文件覆盖前面的文件。覆盖层路径相对于活动项目目录解析（在 `~` 展开之后）。

写入行为：

- `settings.set(...)` 写入**全局**层（启动时选定的全局 YAML 文件），并排队一次后台保存。
- 从设置 API 看，项目设置和配置覆盖层是只读的。

### 设置加载失败

- 缺失的全局/项目 YAML 被视为空配置。
- 无效的全局或 native 项目 YAML 会在文件锁保护下移动到唯一的 `.broken-<timestamp>-<pid>-<uuid>` 同级文件，然后启动失败并给出原始路径和备份路径。不可读的文件会直接失败，不会被移动。
- 每个 `PI_CONFIG_FILES` / `--config` 覆盖层都是严格的：文件缺失、无效 YAML 以及非映射的文档根都是硬错误。覆盖层文件不会被隔离。

## 仍处于激活状态的迁移行为

启动时，如果全局 `config.yml` 和 `config.yaml` 都不存在：

1. 从 `~/.omp/agent/settings.json` 迁移（成功后重命名为 `.bak`）
2. 与 `agent.db` 中的旧版 DB 设置合并（冲突时以 DB 值为准）
3. 将合并结果写入 `config.yml`

`#migrateRawSettings` 中的字段级迁移：

- `queueMode` -> `steeringMode`
- 旧版扁平 `theme: "..."` -> `theme.dark/theme.light` 结构

---

## 5) 能力/发现集成

大多数非核心配置加载都流经能力注册表（`src/capability/index.ts` + `src/discovery/index.ts`）。

## Provider 排序

Provider 按数字优先级排序（高者优先）。完整集合：

- native OMP（`builtin.ts`）：`100`
- OMP 插件（`omp-plugins`）：`90`
- Claude：`80`
- Agent Plugins 标准（`agent-plugins`）：`75`
- Codex / agents / Claude 插件市场：`70`
- Gemini：`60`
- OpenCode：`55`
- Cursor / Windsurf：`50`
- Cline：`40`
- GitHub Copilot：`30`
- VS Code：`20`
- agents-md（`AGENTS.md` 文件）：`10`
- mcp-json / ssh-json：`5`
- 内置默认规则（`builtin-defaults`）：`1`

```text
Provider precedence (higher wins)

native (.omp)           priority 100
omp-plugins             priority  90
claude                  priority  80
agent-plugins           priority  75
codex / agents /
  claude-plugins        priority  70
gemini                  priority  60
opencode                priority  55
cursor / windsurf       priority  50
cline                   priority  40
github                  priority  30
vscode                  priority  20
agents-md               priority  10
mcp-json / ssh-json     priority   5
builtin-defaults        priority   1
```

## 去重语义

能力定义了一个 `key(item)`：

- 相同 key => 第一个条目获胜（优先级更高/更早加载的条目）
- 无 key（`undefined`）=> 不去重，保留所有条目

相关 key：

- skill：`name`
- 工具：`name`
- hook：`${type}:${tool}:${name}`
- 扩展模块：`name`
- 扩展：`name`
- 设置：不去重（保留所有条目）

---

## 6) native `.omp` provider 行为（`packages/coding-agent/src/discovery/builtin.ts`）

native provider（`id: native`）从以下位置读取 native 配置：

- 项目：`<cwd>/.omp/...`
- 用户：`~/.omp/agent/...`

### 目录准入规则

- 斜杠命令、目录规则、提示词、指令、hook、工具、扩展、扩展模块和设置，仅在其项目/用户根目录存在且非空时才会被使用。
- skill 会针对从当前工作目录向上直到仓库根/home 边界的每个祖先目录扫描 `<ancestor>/.omp/skills`，外加 `~/.omp/agent/skills`，且不要求根 `.omp` 目录本身非空。
- `SYSTEM.md`、`RULES.md` 和 `.omp/AGENTS.md` 直接读取用户级文件，项目级文件则使用最近的非空祖先 `.omp` 目录。`RULES.md` 会成为始终应用的粘性规则。完整的 `SYSTEM.md` / `APPEND_SYSTEM.md` 契约请参阅 [`docs/system-prompt-customization.md`](./system-prompt-customization.md)。
- MCP 不使用非空根目录准入助手。它直接依次读取项目级 `.omp/mcp.json`、`.omp/.mcp.json`，然后是用户级 `mcp.json`、`.mcp.json`。

### 范围特定加载

- skill：`<ancestor>/.omp/skills/*/SKILL.md` 和 `~/.omp/agent/skills/*/SKILL.md`
- 斜杠命令：`commands/*.md`
- 规则：`rules/*.{md,mdc}` 加上顶层 `RULES.md`
- 提示词：`prompts/*.md`
- 指令：`instructions/*.md`
- hook：`hooks/pre/*`、`hooks/post/*`
- 工具：`tools/*.{json,md,ts,js,sh,bash,py}` 和 `tools/<name>/index.ts`
- 扩展模块：在 `extensions/` 下发现（+ 旧版 `settings.json.extensions` 字符串数组）
- 扩展：`extensions/<name>/gemini-extension.json`
- 设置能力：`settings.json`，然后 `config.yml`
- 上下文文件：`.omp/AGENTS.md`；独立的祖先 `AGENTS.md` 文件由低优先级的 `agents-md` provider 单独加载

### 最近项目查找细节

对于 `SYSTEM.md`、`RULES.md` 和 `.omp/AGENTS.md`，native provider 会向上遍历到最近的非空项目 `.omp` 目录。

## 7) 主要子系统如何使用配置

## 设置子系统

- `Settings.init()` 按上述优先级加载全局 YAML 文件、发现的项目设置、`PI_CONFIG_FILES` / `--config` 覆盖层以及运行时覆盖。
- 只有 `level === "project"` 的能力条目才会合并进项目层。

### 会话标题提示词覆盖

在任意通用配置基础目录中创建 `TITLE_SYSTEM.md`：

```text
# ~/.omp/agent/TITLE_SYSTEM.md
Generate a session name using lowercase `<type>:<primary-objective>`.
```

- 缺少 `TITLE_SYSTEM.md` 时保留内置的标题提示词。
- 发现逻辑先检查当前项目目录基础目录（`<cwd>/.omp`、`.claude`、`.codex`、`.gemini`），然后按通用助手顺序检查用户级基础目录。与 native `SYSTEM.md` 不同，项目级标题发现**不会**遍历祖先目录。
- 此覆盖只替换自动会话标题生成的系统提示词；正常的 `SYSTEM.md` / `APPEND_SYSTEM.md` 提示词自定义不受影响。
- 在线路径会要求标题模型把标题包在 `<title>...</title>` 中，并从文本中宽松地解析（纯句子、被截断/未闭合的标签，或杂散的 `{"title": "..."}` JSON 回显都仍然有效）。`TITLE_SYSTEM.md` 覆盖会在其内容之后追加包装进 `<title>` 的指令。本地 tiny-title 路径保留 `<title>...</title>` 预填充/停止包装器，并将此文件用作其系统轮次。

## skill 子系统

- `extensibility/skills.ts` 通过 `loadCapability(skillCapability.id, { cwd })` 加载。
- 应用来源开关和过滤器（`ignoredSkills`、`includeSkills`、自定义目录）。
- 旧版命名的开关仍然存在（`skills.enablePiUser`、`skills.enablePiProject`），但它们门控的是 native provider（`provider === "native"`）。

## hook 子系统

- `discoverAndLoadHooks()` 从 hook 能力 + 显式配置的路径解析 hook 路径。
- 然后通过 Bun import 加载模块。

## 工具子系统

- `discoverAndLoadCustomTools()` 从工具能力 + 插件工具路径 + 显式配置的路径解析工具路径。
- 声明式 `.md/.json` 工具文件只包含元数据；可执行加载期望的是代码模块。

## 扩展子系统

- `discoverAndLoadExtensions()` 加载 native 扩展模块能力条目、JS/TS hook 工厂、已安装插件入口点以及显式配置的路径。
- 环境式扩展模块能力发现明确仅限 `provider: "native"`；此步骤不会扫描外部 provider。

---

## 8) 可依赖的优先级规则

使用以下心智模型：

1. `config.ts` 中的源目录排序决定候选路径顺序。
2. 能力 provider 优先级决定跨 provider 的优先次序。
3. 能力 key 去重决定冲突行为（对于有 key 的能力，先到者获胜）。
4. 子系统特定的合并逻辑可能进一步改变有效优先级（尤其是设置）。

### 设置特定注意事项

设置能力条目不会去重；`Settings.#loadProjectSettings()` 按返回顺序深度合并项目条目，因此后面的条目覆盖前面的条目。Provider 按从最高到最低的优先级被访问，这意味着低优先级 provider 的设置可能覆盖高优先级设置。在 native provider 内，项目 `config.yml` 排在 `settings.json` 之后并覆盖它。随后，native `.omp/config.yml` 的模型角色会被重新应用为权威的项目模型角色层。

---

## 9) 仍存在的旧版/兼容性行为

- 针对以 YAML 为目标文件的 `ConfigFile` JSON -> YAML 迁移。
- 从 `settings.json` 和 `agent.db` 到 `config.yml` 的设置迁移。
- 字段迁移涵盖重命名/移除的设置和值形状变化，包括 `queueMode`、changelog 设置、扁平 `theme`、已停用的 image-tool 设置、任务隔离/eager 设置、已移除的编辑和压缩模式、`inlineToolDescriptors`、状态行段、provider/搜索设置、memories/hindsight 设置以及嵌套叶重命名。当前的详尽列表请参阅 `Settings.#migrateRawSettings()`。
- 旧版设置名 `skills.enablePiUser` / `skills.enablePiProject` 仍是 native skill 来源的活动门控。

如果这些兼容性路径在代码中被移除，请立即更新本文档；当前仍有多个运行时行为依赖它们。
