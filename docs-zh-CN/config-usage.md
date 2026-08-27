# 配置发现与解析

本文档介绍 coding-agent 当前如何解析配置：扫描哪些根目录、优先级如何运作，以及已解析的配置如何被设置、技能、钩子、工具和扩展所使用。

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
         通用助手顺序（`config.ts`）
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

## 1) 配置根目录和源顺序

## 规范根目录

`src/config.ts` 定义了一个固定的源优先级列表：

1. `.omp`（原生）
2. `.claude`
3. `.codex`
4. `.gemini`

用户级基础目录：

- OMP 原生：`~/<PI_CONFIG_DIR>/agent`（通常为 `~/.omp/agent`；命名 profile 会按下文所述更改此路径）
- `~/.claude`
- `~/.codex`
- `~/.gemini`

项目级基础目录：

- `<cwd>/.omp`
- `<cwd>/.claude`
- `<cwd>/.codex`
- `<cwd>/.gemini`

`CONFIG_DIR_NAME` 为 `.omp`（`packages/utils/src/dirs.ts`）。`PI_CONFIG_DIR` 更改通用助手使用的 OMP 用户根目录。`PI_CODING_AGENT_DIR` 则不同：对于默认 profile，它会更改 `getAgentDir()` 的使用者，如原生发现、设置和运行时状态，但**不会**更改通用的 `getConfigDirs()` / `findConfigFile()` 的 OMP 基础目录。命名 profile 会忽略 `PI_CODING_AGENT_DIR`。

## Profile

命名 profile（`omp --profile <name>`、`OMP_PROFILE`，或旧版回退 `PI_PROFILE`）会重新定位 OMP 用户基础目录。当 `OMP_PROFILE` 已定义时它优先，包括明确为空时；`default`、空或空白会选择默认 profile。当 profile 处于活动状态时，此处写为 `~/.omp/agent/...` 的每个 OMP 原生用户级路径通常解析为 `~/.omp/profiles/<name>/agent/...`。`--alias <command>` 本身不会选择 profile：与 `--profile` 配合使用时，它为该 profile 创建一个 shell 快捷方式。

此重定位在原生 provider（`builtin.ts`）和通用 `config.ts` 助手之间是一致的，因此它涵盖斜杠命令、规则、提示、指令、钩子、工具、扩展、设置、技能和 MCP，以及顶层 `SYSTEM.md` / `RULES.md` / `AGENTS.md` 文件和运行时状态（会话、blob、`agent.db`）。profile 只能看到自己的 OMP 配置，永远看不到默认 profile 的 agent 配置。

键绑定是唯一的例外：命名 profile 会将其自身 `~/.omp/profiles/<name>/agent/keybindings.*` 下合并默认 profile 的 `~/.omp/agent/keybindings.*`，profile 文件按绑定覆盖默认文件（[#4867](https://github.com/can1357/oh-my-pi/issues/4867)）。键绑定描述的是用户面前的终端/键盘，这不会随活动 profile 变化，因此用户级重映射在每个 profile 中都继续工作，除非 profile 显式覆盖它们。继承的文件对 profile 进程是只读的——默认 profile 文件的旧格式迁移仅在默认 profile 本身运行时才会发生。

在 macOS 和 Linux 上，已存在的 `$XDG_DATA_HOME/omp`、`$XDG_STATE_HOME/omp` 或 `$XDG_CACHE_HOME/omp` 可以重定位相应的数据、状态或缓存路径。对于命名 profile，OMP 仅在该类别已包含 `omp/profiles/<name>` 时才使用 XDG 类别；否则该类别仍位于 `~/.omp/profiles/<name>` 下。在依赖 XDG 路径之前，请先运行 `omp config init-xdg`。

其他源基础目录不受 profile 作用域限制，在每个 profile 下加载方式相同：外部工具的基础目录（`~/.claude`、`~/.codex`、`~/.gemini`）属于那些工具，项目级基础目录（`<cwd>/.omp`、`<cwd>/.claude`，...）绑定到工作目录。在整个文档中，将 `~/.omp/agent` 视为活动 profile 的 agent 目录的简写，除非正在讨论环境覆盖或 XDG 路径。

## 重要约束

`src/config.ts` 中的通用助手在源发现顺序中**不**包含 `.pi`。

---

## 2) 核心发现助手（`src/config.ts`）

## `getConfigDirs(subpath, options)`

返回有序条目：

- 首先是用户级条目（按源优先级）
- 然后是项目级条目（按相同源优先级）

选项：

- `user`（默认 `true`）
- `project`（默认 `true`）
- `cwd`（默认 `getProjectDir()`）
- `existingOnly`（默认 `false`）

此 API 用于基于目录的配置查找（命令、钩子、工具、agent 等）。

## `findConfigFile(subpath, options)` / `findConfigFileWithMeta(...)`

跨有序基础目录搜索第一个现有文件，返回第一个匹配项（仅路径或路径+元数据）。

## `findAllNearestProjectConfigDirs(subpath, cwd)`

向上遍历父目录，并返回**每个源基础目录的最近现有目录**（`.omp`、`.claude`、`.codex`、`.gemini`），然后按源优先级对结果进行排序。

在项目配置应从祖先目录继承（monorepo/嵌套工作区行为）时使用此 API。

---

## 3) 文件配置包装器（`ConfigFile<T>` 在 `src/config/config-file.ts` 中，从 `src/config.ts` 重新导出）

`ConfigFile<T>` 是单个配置文件的 schema 验证加载器。

支持的格式：

- `.yml` / `.yaml`
- `.json` / `.jsonc`

行为：

- 根据提供的 omptype schema 验证已解析数据。
- 缓存加载结果，直到调用 `invalidate()`。
- 通过 `tryLoad()` 返回三态结果：
  - `ok`
  - `not-found`
  - `error`（带有 schema/parse 上下文的 `ConfigError`）

仍支持旧版迁移：

- 如果目标路径为 `.yml`/`.yaml`，同级 `.json` 会被自动迁移一次（`migrateJsonToYml`）。

---

## 4) 设置解析模型（`src/config/settings.ts`）

运行时设置模型是分层的：

1. 全局设置：`~/.omp/agent/config.yml` 和 `config.yaml` 中第一个存在的文件
2. 项目设置：通过设置能力发现（来自 provider 的 `settings.json` 和 `config.yml`）
3. 配置覆盖层：`PI_CONFIG_FILES`（平台路径列表），后跟重复的 `omp --config <path>` 文件；所有这些仅作为本进程的 `config.yml` 风格 YAML 加载
4. 运行时覆盖：内存中，非持久化
5. Schema 默认值：来自 `SETTINGS_SCHEMA`

有效优先级：

`defaults <- global <- project <- PI_CONFIG_FILES overlays <- --config overlays <- runtime overrides`

在任一覆盖层列表中，后面的文件覆盖前面的文件。覆盖路径相对于活动项目目录解析（在 `~` 扩展后）。

写入行为：

- `settings.set(...)` 写入**全局**层（启动时选择的全局 YAML 文件），并排队后台保存。
- 项目设置和配置覆盖层从设置 API 是只读的。

### 设置加载失败

- 缺失全局/项目 YAML 视为空配置。
- 无效的全局或原生项目 YAML 在文件锁下移至一个唯一的 `.broken-<timestamp>-<pid>-<uuid>` 同级文件，然后启动失败，并显示原始路径和备份路径。不可读的文件失败时不会被移动。
- 每个 `PI_CONFIG_FILES` / `--config` 覆盖层都是严格的：缺失文件、无效 YAML 以及非映射的文档根都是硬错误。覆盖层文件不会被隔离。

## 仍处于活动状态的迁移行为

启动时，如果全局 `config.yml` 和 `config.yaml` 都不存在：

1. 从 `~/.omp/agent/settings.json` 迁移（成功时重命名为 `.bak`）
2. 与 `agent.db` 中的旧版 DB 设置合并（冲突时 DB 值获胜）
3. 将合并结果写入 `config.yml`

`#migrateRawSettings` 中的字段级迁移：

- `queueMode` -> `steeringMode`
- `ask.timeout` 毫秒 -> 秒，当旧值看起来像毫秒时（`> 1000`）
- 旧版扁平 `theme: "..."` -> `theme.dark/theme.light` 结构

---

## 5) 能力/发现集成

大多数非核心配置加载都流经能力注册表（`src/capability/index.ts` + `src/discovery/index.ts`）。

## Provider 排序

Provider 按数字优先级排序（高者优先）。示例优先级：

- 原生 OMP（`builtin.ts`）：`100`
- Claude：`80`
- Codex / agents / Claude marketplace：`70`
- Gemini：`60`

```text
Provider precedence (higher wins)

native (.omp)          priority 100
claude                 priority  80
codex / agents / ...   priority  70
gemini                 priority  60
```

## 去重语义

能力定义了一个 `key(item)`：

- 相同 key => 第一个项目获胜（高优先级/先加载的项目）
- 无 key（`undefined`）=> 不去重，保留所有项目

相关 key：

- skills：`name`
- tools：`name`
- hooks：`${type}:${tool}:${name}`
- extension modules：`name`
- extensions：`name`
- settings：不进行去重（保留所有项目）

---

## 6) 原生 `.omp` provider 行为（`packages/coding-agent/src/discovery/builtin.ts`）

原生 provider（`id: native`）从以下位置读取原生配置：

- project：`<cwd>/.omp/...`
- user：`~/.omp/agent/...`

### 目录准入规则

- 斜杠命令、目录规则、提示、指令、钩子、工具、扩展、extension modules 和设置仅在项目/用户根目录存在且非空时使用。
- 技能为从当前工作目录向上到仓库根/home 边界的每个祖先扫描 `<ancestor>/.omp/skills`，加上 `~/.omp/agent/skills`，不要求根 `.omp` 目录本身非空。
- `SYSTEM.md`、`RULES.md` 和 `.omp/AGENTS.md` 直接读取用户级文件，并使用最近的非空祖先 `.omp` 目录作为项目文件。`RULES.md` 成为始终应用的粘性规则。有关完整的 `SYSTEM.md` / `APPEND_SYSTEM.md` 契约，请参阅 [`docs/system-prompt-customization.md`](./system-prompt-customization.md)。
- MCP 不使用非空根目录准入助手。它按顺序读取项目 `.omp/mcp.json`，然后 `.omp/.mcp.json`，接着是用户 `mcp.json`，然后 `.mcp.json`。

### 范围特定加载

- 技能：`<ancestor>/.omp/skills/*/SKILL.md` 和 `~/.omp/agent/skills/*/SKILL.md`
- 斜杠命令：`commands/*.md`
- 规则：`rules/*.{md,mdc}` 加上顶层 `RULES.md`
- 提示：`prompts/*.md`
- 指令：`instructions/*.md`
- 钩子：`hooks/pre/*`、`hooks/post/*`
- 工具：`tools/*.{json,md,ts,js,sh,bash,py}` 和 `tools/<name>/index.ts`
- Extension modules：在 `extensions/` 下发现（+ 旧版 `settings.json.extensions` 字符串数组）
- 扩展：`extensions/<name>/gemini-extension.json`
- 设置能力：`settings.json`，然后 `config.yml`
- 上下文文件：`.omp/AGENTS.md`；独立的祖先 `AGENTS.md` 文件由低优先级 `agents-md` provider 单独加载

### 最近项目查找细节

对于 `SYSTEM.md`、`RULES.md` 和 `.omp/AGENTS.md`，原生 provider 向上遍历到最近非空的项目 `.omp` 目录。

## 7) 主要子系统如何使用配置

## 设置子系统

- `Settings.init()` 按上述优先级加载全局 YAML 文件、已发现的项目设置、`PI_CONFIG_FILES` / `--config` 覆盖层和运行时覆盖。
- 只有 `level === "project"` 的能力项目才会合并到项目层。

### 会话标题提示覆盖

在任何通用配置基础目录中创建 `TITLE_SYSTEM.md`：

```text
# ~/.omp/agent/TITLE_SYSTEM.md
Generate a session name using lowercase `<type>:<primary-objective>`.
```

- 缺少 `TITLE_SYSTEM.md` 保留捆绑的标题提示。
- 发现首先检查当前项目目录基础目录（`<cwd>/.omp`、`.claude`、`.codex`、`.gemini`），然后按通用助手顺序检查用户基础目录。与原生 `SYSTEM.md` 不同，项目标题发现**不会**遍历祖先目录。
- 此覆盖仅替换自动会话标题生成系统提示；正常的 `SYSTEM.md` / `APPEND_SYSTEM.md` 提示自定义不受影响。
- 在线路径要求标题模型将标题包装在 `<title>...</title>` 中，并从文本中宽松地解析它（纯句子、截断/未闭合的标签或杂散的 `{"title": "..."}` JSON 回显都仍可工作）。`TITLE_SYSTEM.md` 覆盖会在其后追加包装在 `<title>` 中的指令。本地 tiny-title 路径保留 `<title>...</title>` 预填充/停止包装，并将此文件用作其系统轮次。

## 技能子系统

- `extensibility/skills.ts` 通过 `loadCapability(skillCapability.id, { cwd })` 加载。
- 应用源开关和过滤器（`ignoredSkills`、`includeSkills`、自定义目录）。
- 旧版命名的开关仍然存在（`skills.enablePiUser`、`skills.enablePiProject`），但它们门控原生 provider（`provider === "native"`）。

## 钩子子系统

- `discoverAndLoadHooks()` 从钩子能力 + 显式配置的路径解析钩子路径。
- 然后通过 Bun import 加载模块。

## 工具子系统

- `discoverAndLoadCustomTools()` 从工具能力 + 插件工具路径 + 显式配置的路径解析工具路径。
- 声明式 `.md/.json` 工具文件仅作为元数据；可执行加载需要代码模块。

## 扩展子系统

- `discoverAndLoadExtensions()` 加载原生 extension-module 能力项目、JS/TS 钩子工厂、已安装插件入口点和显式配置的路径。
- 环境 extension-module 能力发现明确限制为 `provider: "native"`；不会扫描外部 provider 以进行此步骤。

---

## 8) 可依赖的优先级规则

使用以下心智模型：

1. `config.ts` 中的源目录排序确定候选路径顺序。
2. 能力 provider 优先级确定跨 provider 的优先级。
3. 能力 key 去重确定冲突行为（键控能力时第一个获胜）。
4. 子系统特定的合并逻辑可以进一步改变有效优先级（尤其是设置）。

### 设置特定注意事项

设置能力项目不进行去重；`Settings.#loadProjectSettings()` 按返回顺序深度合并项目项，因此后面的项目覆盖前面的项目。Provider 按从高到低的优先级访问，这意味着低优先级 provider 设置可以覆盖高优先级设置。在原生 provider 内，项目 `config.yml` 跟随并覆盖 `settings.json`。然后将原生 `.omp/config.yml` 模型角色重新应用为权威的项目模型角色层。

---

## 9) 仍存在的旧版/兼容性行为

- 针对 YAML 目标文件的 `ConfigFile` JSON -> YAML 迁移。
- 从 `settings.json` 和 `agent.db` 到 `config.yml` 的设置迁移。
- 字段迁移涵盖重命名/移除的设置和值形状变化，包括 `queueMode`、changelog 设置、`ask.timeout`、扁平 `theme`、`inspect_image.enabled`、任务隔离/eager 设置、移除的编辑和压缩模式、`inlineToolDescriptors`、状态行段、provider/搜索设置、memories/hindsight 设置以及嵌套叶重命名。有关当前的详尽列表，请参阅 `Settings.#migrateRawSettings()`。
- 旧版设置名称 `skills.enablePiUser` / `skills.enablePiProject` 仍是原生技能源的活动门。

如果代码中移除了这些兼容性路径，请立即更新本文档；今天仍有多个运行时行为依赖于它们。