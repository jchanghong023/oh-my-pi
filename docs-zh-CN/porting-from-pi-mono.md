# 从 pi-mono 移植：实用的合并指南

本指南是将变更从 pi-mono 移植到本仓库的可重复检查清单。
适用于任何合并：单文件、特性分支，或完整发布同步。

## 上次同步点（历史上游标记）

**提交：** `b21b42d032919de2f2e6920a76fa9a37c3920c0a`
**日期：** 2026-03-22

每次同步后请更新本节；不要重复使用之前的范围。此提交是上游 pi-mono 的标记，可能不存在于本仓库的本地对象数据库中。

开始新的同步时，从该提交开始，在包含该提交的 pi-mono checkout 或远端中生成补丁：

```bash
git format-patch b21b42d032919de2f2e6920a76fa9a37c3920c0a..HEAD --stdout > changes.patch
```

## 0) 定义范围

- 确定上游参考（提交、标签或 PR）。
- 列出你计划涉及的包或文件夹。
- 决定哪些特性在范围内，哪些刻意跳过。

## 1) 安全地迁移代码

- 优先使用干净、聚焦的差异，而不是整体复制。
- 避免复制构建产物或生成的文件。
- 如果上游新增了文件，请显式添加并审查其内容。

## 2) 匹配 import 扩展名约定

大多数运行时 TypeScript 源在内部 import 中省略 `.js`，但当前的部分入口点和工具模块会保留 `.js` 以兼容 ESM/运行时。遵循周围文件和包的导出风格；不要一刀切地删除或添加扩展名。

- 在 `packages/coding-agent` 运行时源中，当周围模块省略扩展名时，优先使用无扩展名的内部 import；但在已要求 `.js` 的文件中保留现有的 `.js` import。
- 在 `packages/tui/test` 和 `packages/natives/bench` 中，当周围文件已使用 `.js` 时，保留 `.js`。
- 当工具或 import 断言要求真实文件扩展名时（例如 `.json`、`.css`、`.md` 文本嵌入），请保留。
- 示例：`import { x } from "./foo.js";` → `import { x } from "./foo";` 仅在该包/文件约定为无扩展名时。

## 3) 替换 import 作用域

上游使用不同的包作用域。请一致地替换它们。

- 用本仓库使用的本地作用域替换旧的作用域。
- 示例（根据实际要移植的包进行调整）：
  - `@mariozechner/pi-coding-agent` → `@oh-my-pi/pi-coding-agent`
  - `@mariozechner/pi-agent-core` → `@oh-my-pi/pi-agent-core`
  - `@mariozechner/pi-tui` → `@oh-my-pi/pi-tui`
  - `@mariozechner/pi-ai` → `@oh-my-pi/pi-ai`
  - `@mariozechner/pi-utils` → `@oh-my-pi/pi-utils`
  - `@mariozechner/pi-catalog` → `@oh-my-pi/pi-catalog`
  - `@mariozechner/pi-natives` → `@oh-my-pi/pi-natives`
- 部分上游包以 `@earendil-works/*` 作用域发布，而不是 `@mariozechner/*`。以相同方式映射（`@earendil-works/pi-coding-agent` → `@oh-my-pi/pi-coding-agent`，依此类推）。
- 裸的 `typebox` 包不是 `@oh-my-pi/*` 作用域；不要将其改写为 `@oh-my-pi/*` 作用域。工具参数 schema 的映射方式请参见第 15 节中的 Extensions divergence。

## 4) 在 Bun 优于 Node 的地方使用 Bun API

我们在 Bun 上运行，但当前源码有意将 Bun API 与少量 Node 标准库 API 混合使用。仅当 Bun 提供了更清晰、更安全或更简单的实现时才替换 Node API；不要机械地重写每一个 Node import。

**移植新代码时优先替换：**

- 进程派生：简单命令优先使用 Bun Shell `$`；需要流式处理或进程控制时使用 `Bun.spawn`/`Bun.spawnSync`。仅在需要其精确语义时保留现有的 `child_process`。
- HTTP 客户端：`node-fetch`、`axios` → 原生 `fetch`
- SQLite：`better-sqlite3` → `bun:sqlite`
- 环境变量加载：`dotenv` → Bun 自动加载 `.env`
- 运行时文本/资源：优先使用 Bun 的导入，例如 `with { type: "text" }` 或 `Bun.file()`，而不是复制步骤或打包的兜底文件读取。

**不要替换（在 Bun 中这些工作得很好）：**

- `os.homedir()` — 不要替换为 `Bun.env.HOME` 或字面量 `"~"`
- `os.tmpdir()` — 不要替换为 `Bun.env.TMPDIR || "/tmp"` 或硬编码路径
- `fs.mkdtempSync()` — 不要替换为手动构造路径
- `path.join()`、`path.resolve()` 等 — 这些都没有问题

**导入风格：** Node 标准库导入使用 `node:` 前缀。命名空间导入很常见，但当周围代码已使用具名导入时，具名导入也可接受。

**其他 Bun 约定：**

- 简短、非流式的命令优先使用 Bun Shell `$`；仅在需要流式 I/O 或进程控制时使用 `Bun.spawn`。
- 简单文件使用 `Bun.file()`/`Bun.write()`，面向目录的操作使用 `node:fs/promises`。当调用流程有意为同步时，现有的同步 `node:fs` 调用是可接受的。
- 避免 `Bun.file().exists()` 检查；在 try/catch 中使用 `isEnoent` 处理。
- 优先使用 `Bun.sleep(ms)`，而不是 `setTimeout` 包装器。

**错误示例：**

```typescript
// BROKEN: env vars may be undefined, "~" is not expanded
const home = Bun.env.HOME || "~";
const tmp = Bun.env.TMPDIR || "/tmp";
```

**正确示例：**

```typescript
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";

const configDir = path.join(os.homedir(), ".config", "myapp");
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "myapp-"));
```

## 5) 优先使用 Bun 嵌入（不要复制）

不要新增运行时资源复制步骤。将资源保留在仓库中并优先使用 Bun 嵌入/import；保留现有的显式生成工作流，例如 `packages/coding-agent/src/export/html/tool-views.generated.js`（通过 `bun run gen:tool-views` 从 collab-web 源构建生成）。

- 如果上游将资源复制到 dist 文件夹，请替换为 Bun 友好的嵌入。
- 提示词是静态的 `.md` 文件；使用 Bun 文本导入（`with { type: "text" }`）和 Handlebars，而不是内联提示字符串。
- 使用 `import.meta.dir` + `Bun.file` 加载相邻的非文本资源。
- 将资源保留在仓库中，由打包器负责包含它们。
- 除非用户明确要求或包已有有意的生成步骤，否则删除复制脚本。
- 如果上游在运行时读取打包的兜底文件，除非当前包已使用生成资源流水线，否则请将文件系统读取替换为 Bun 文本嵌入导入。
  - 示例（Codex 指令兜底）：
    - `const FALLBACK_PROMPT_PATH = join(import.meta.dir, "codex-instructions.md");` -> 已移除
    - `import FALLBACK_INSTRUCTIONS from "./codex-instructions.md" with { type: "text" };`
    - 使用 `return FALLBACK_INSTRUCTIONS;` 代替 `readFileSync(FALLBACK_PROMPT_PATH, "utf8")`

## 6) 谨慎移植 `package.json`

将 `package.json` 视为契约。请有意识地合并。

- 保留现有的 `name`、`version`、`type`、`exports` 和 `bin`，除非移植要求变更。
- 将 npm/node 脚本替换为 Bun 等价物（例如 `bun check`、`bun test`）。
- 确保依赖使用正确的作用域。
- 不要通过降级依赖来修复类型错误；应当升级。
- 验证 workspace 包链接和 `peerDependencies`。

## 7) 对齐代码风格和工具

- 保留现有的格式化约定。
- 不要引入 `any`，除非必要。
- 避免动态 import，除非可选依赖、启动开销或仅运行时模块确实需要；否则优先使用顶层 import。
- 永远不要在代码中构建提示词；提示词是使用 Handlebars 渲染的静态 `.md` 文件。
- 在 `packages/coding-agent` 中，使用 `@oh-my-pi/pi-utils` 的 `logger` 进行内部/运行时日志记录；CLI 命令文件可以为面向用户的输出使用 `console.*`。
- 使用 `Promise.withResolvers()` 代替 `new Promise((resolve, reject) => ...)`。
- 对于新的封装状态优先使用 ES `#` 私有字段。构造函数参数属性已存在于当前代码中，是可接受的；移植时不要无关地修改访问修饰符。
- 优先使用现有的辅助函数和实用工具，而不是新增临时代码。
  保留本仓库已做的 Bun 优先基础设施变更：
  - 运行时为 Bun（主 CLI 没有 Node 入口点）。
  - 包管理器为 Bun（没有 npm 锁文件）。
  - 不应随意引入繁重的 Node API；当前源在适合 provider、CLI 或进程控制语义的地方仍然使用选定的 Node API（`node:crypto`、`node:readline`、同步 `node:fs` 以及 `child_process`）。
  - 轻量级 Node API（`os.homedir`、`os.tmpdir`、`fs.mkdtempSync`、`path.*`）予以保留。
  - CLI shebang 使用 `bun`（而不是 `node`，也不是 `tsx`）。
  - TypeScript 包通常直接使用源文件；`@oh-my-pi/pi-natives` 从 `packages/natives/native` 导出已生成的原生绑定。
  - CI 工作流使用 Bun 进行 install/check/test。

## 8) 移除旧兼容性层

除非要求，否则移除上游兼容性垫片。

- 删除已被替换的旧 API。
- 将所有调用点直接更新到新 API。
- 不要保留 `*_v2` 或并行版本。

## 9) 更新文档和引用

- 适当地替换 pi-mono 仓库链接。
- 更新示例以使用 Bun 和正确的包作用域。
- 确保 README 指令仍然与当前仓库行为一致。

## 10) 验证移植

运行覆盖此次移植的检查：

- `bun check` 用于仓库的 TypeScript 和 Rust 检查。
- 针对你更改的包和行为的定向 Bun 测试（例如 `bun test packages/<package>/test/<file>.test.ts`）。
- 如果依赖发生了变化，在更新 `bun.lock` 后运行 `bun install --frozen-lockfile`。

测试使用 Bun 的 runner，而不是 Vitest。不要用项目范围内的 `bun test` 替代定向覆盖；根目录的 `test` 脚本使用仓库的分片 runner。如果某项检查已因不相关的原因失败，请明确指出具体的命令和失败信息。

## 11) 保护已改进的功能（回归陷阱清单）

如果你已经在本地改进了行为，请将其视为**不可协商**。移植之前，请记下这些改进并添加显式检查，确保它们不会在合并中丢失。

- **冻结预期行为**：为每项改进添加简短的"before/after"说明（输入、输出、默认值、边界情况）。这可以防止静默回滚。
- **映射旧 API → 新 API**：如果上游重命名了概念（hooks → extensions、custom tools → tools 等），请确保每个旧入口点仍然接通。漏掉一个标志或导出就等于丢失功能。
- **验证导出**：检查 `package.json` 的 `exports`、公共类型和 barrel 文件。上游移植常常忘记重新导出本地的添加内容。
- **覆盖非正常路径**：如果你修复了错误处理、超时或兜底逻辑，请添加测试或至少一份手动检查清单来演练这些路径。
- **检查默认值和配置合并顺序**：改进常常体现在默认值中。确认新默认值没有被还原（例如，新的配置优先级、被禁用的功能、工具列表）。
- **审计环境/Shell 行为**：如果你修复了执行或沙箱，请验证新路径仍使用你清理过的环境，并且没有重新引入别名/函数覆盖。
- **重新运行定向样本**：保留一组最小的"已知正常"示例，并在移植后运行它们（CLI 标志、扩展注册、工具执行）。

## 12) 检测并处理被重写的代码

移植一个文件之前，请检查上游是否对其进行了重大重构：

```bash
# Compare the file you're about to port against what you have locally
git diff HEAD upstream/main -- path/to/file.ts
```

如果差异显示该文件被**重写**（不仅仅是修补）：

- 新的抽象、重命名的概念、合并的模块、改变的数据流

那么你必须在移植之前**彻底阅读新的实现**。盲目合并被重写的代码会丢失功能，因为：

注意：交互模式最近被拆分为 controllers/utils/types。在回移植相关变更时，请将这些更新移植到我们创建的各个文件中，并确保 `interactive-mode.ts` 的接线保持同步。

1. **默认值静默改变** - 一个新的变量 `defaultFoo = [a, b]` 可能替换了旧的返回 `[a, b, c, d, e]` 的 `getAllFoo()`。

2. **API 选项被丢弃** - 当系统合并时（例如 `hooks` + `customTools` → `extensions`），旧选项可能没有接通到新实现。

3. **代码路径变陈旧** - 重命名的概念（例如 `hookMessage` → `custom`）需要在每个 switch 语句、类型守卫和处理程序中更新——而不仅仅是在定义处。

4. **上下文/能力缩减** - 旧 API 可能曾暴露 `{ logger, typebox, pi }`，而新 API 忘记了包含。

### 语义化移植流程

当上游重写了一个模块时：

1. **阅读旧实现** - 了解它做了什么、接受哪些选项、暴露了什么。
2. **阅读新实现** - 了解新的抽象以及它们如何映射到旧行为。
3. **验证功能对等** - 对于旧代码中的每个能力，确认新代码保留或显式移除了它。
4. **Grep 遗漏点** - 搜索可能在 switch 语句、处理程序、UI 组件中遗漏的旧名称/概念。
5. **测试边界** - CLI 标志、SDK 选项、事件处理程序、默认值——这些都是回归隐藏的地方。

### 快速检查

```bash
# Find all uses of an old concept that may need updating
rg "oldConceptName" --type ts

# Compare default values between versions
git show upstream/main:path/to/file.ts | rg "default|DEFAULT"

# Check if all enum/union values have handlers
rg "case \"" path/to/file.ts
```

## 13) 快速审计清单

将其作为完成前的最终一遍检查：

- [ ] import 扩展名遵循本地包约定（不一律去除 `.js`）
- [ ] 没有新增的仅限 Node 的 API，除非它们匹配现有的合理模式
- [ ] 所有包作用域已更新
- [ ] `package.json` 脚本使用 Bun
- [ ] 提示词使用 `.md` 文本导入（没有内联提示字符串）
- [ ] coding-agent 中没有内部/运行时 `console.*`；CLI 面向用户的输出是有意的
- [ ] 资源通过 Bun 嵌入/导入模式加载，或通过现有的有意生成流水线加载
- [ ] 已运行测试或检查（或明确标注被阻塞）
- [ ] 没有功能回归（参见第 11-12 节）

## 14) 提交信息格式

提交回移植时，请遵循仓库格式 `<type>(scope): <past-tense description>`，并在标题中保留提交范围。

```
fix(coding-agent): backported pi-mono changes (<from>..<to>)

packages/<package>:
- <type>: <description>
- <type>: <description> (#<issue> by @<contributor>)

packages/<other-package>:
- <type>: <description>
```

**示例：**

```
fix(coding-agent): backported pi-mono changes (9f3eef65f..52532c7c0)

packages/ai:
- fix: handle "sensitive" stop reason from Anthropic API
- fix: normalize tool call IDs with special characters for Responses API
- fix: add overflow detection for Bedrock, MiniMax, Kimi providers
- fix: 429 status is rate limiting, not context overflow

packages/tui:
- fix: refactored autocomplete state tracking
- fix: file autocomplete should not trigger on empty text
- fix: configurable autocomplete max visible items
- fix: improved table column width calculation with word-aware wrapping

packages/coding-agent:
- fix: preserve external config.yml edits on save (#1046 by @nicobailonMD)
- fix: resolve macOS NFD and curly quote variants in file paths
```

**规则：**

- 按包对变更进行分组
- 使用 conventional commit 类型（`fix`、`feat`、`refactor`、`perf`、`docs`）
- 包含上游 issue/PR 编号和外部贡献者署名
- 标题中的提交范围有助于跟踪同步点

## 15) 有意的差异

我们的 fork 存在与上游不同的架构决策。**不要移植这些上游模式：**

### UI 架构

| Upstream                                    | Our Fork                                                            | Reason                                                                                                                                         |
| ------------------------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `FooterDataProvider` class                  | `StatusLineComponent`                                               | 简化、集成状态行                                                                                                                |
| `ctx.ui.setHeader()` / `ctx.ui.setFooter()` | 在当前扩展上下文中为 no-op stub                                     | 当前未接通以替换 TUI 状态/头部 UI                                                                                        |
| `ctx.ui.setEditorComponent()`               | 在 interactive mode 中接通；在 ACP/RPC/headless 上下文中为 no-op stub | 自定义编辑器替换在交互式 TUI 中有效；非 TUI 运行时保留 stub                                                            |
| `ctx.ui.addAutocompleteProvider()`          | 在 interactive mode 中接通；在 ACP/RPC/headless 上下文中为 no-op stub | 工厂包装与上游匹配；omp 的编辑器没有自定义 `triggerCharacters`，因此包装的 provider 在内置触发点出现 |
| `InteractiveModeOptions` options object     | 位置构造参数（options 类型仍导出）                                  | 保留构造函数签名；上游新增字段时更新该类型                                                                          |

### 组件命名

| Upstream                     | Our Fork                |
| ---------------------------- | ----------------------- |
| `extension-input.ts`         | `hook-input.ts`         |
| `extension-selector.ts`      | `hook-selector.ts`      |
| `ExtensionInputComponent`    | `HookInputComponent`    |
| `ExtensionSelectorComponent` | `HookSelectorComponent` |

### API 命名

| Upstream                                 | Our Fork                                 | Notes                                     |
| ---------------------------------------- | ---------------------------------------- | ----------------------------------------- |
| `sessionManager.appendSessionInfo(name)` | `sessionManager.setSessionName(name)`    | 我们全程使用 `sessionName`                |
| `sessionManager.getSessionName()`        | `sessionManager.getSessionName()`        | 相同（我们已统一以匹配上游的 RPC）        |
| `agent.sessionName` / `setSessionName()` | `agent.sessionName` / `setSessionName()` | 相同                                      |

### 文件整合

| Upstream                                           | Our Fork                                                  | Reason                                        |
| -------------------------------------------------- | --------------------------------------------------------- | --------------------------------------------- |
| `clipboard.ts` + `clipboard-image.ts`（工具文件）   | 由 `@oh-my-pi/pi-natives` 支持的 `src/utils/clipboard.ts` | 原生实现，外加一个小型 TS 包装                |

### 测试框架

| Upstream                  | Our Fork                      |
| ------------------------- | ----------------------------- |
| `vitest` with `vi.mock()` | `bun:test` with `vi` from bun |
| `node:test` assertions    | `expect()` matchers           |

### 工具架构

| Upstream                            | Our Fork                                                                                                      | Notes                                                     |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `createTool(cwd: string, options?)` | `createTools(session: ToolSession)` via `BUILTIN_TOOLS` registry                                            | 工具工厂接受 `ToolSession` 并可返回 `null`                |
| 每个工具的 `*Operations` 接口        | 仅保留当前每个工具的覆盖接口（例如 `FindOperations`）                                                          | 在存在的 SSH/远程覆盖处使用                              |
| 到处使用 Node.js `fs/promises`      | 简单文件读写使用 Bun 文件 API，目录使用 `node:fs/promises`，在需要时使用选定的同步 `node:fs`                  | 在简化的场景下优先使用 Bun API                            |

### 认证存储

| Upstream                        | Our Fork                                    | Notes                                                  |
| ------------------------------- | ------------------------------------------- | ------------------------------------------------------ |
| `proper-lockfile` + `auth.json` | `agent.db` (bun:sqlite)                     | 凭据仅存储在 `agent.db` 中                            |
| 每个 provider 单个凭据          | 多凭据加轮询选择                            | 保留会话亲和性和退避逻辑                                |

### 扩展

| Upstream                                                               | Our Fork                                                                                                                                                                                                                                                                                     |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 用于 TypeScript 加载的 `jiti`                                          | 原生 Bun `import()`                                                                                                                                                                                                                                                                        |
| `pkg.pi` 清单字段                                                      | 优先使用 `pkg.omp`；仍保留 `pkg.pi` 兜底                                                                                                                                                                                                                                            |
| 来自 `pi-ai` 的 `StringEnum`                                           | 来自 `pi.typebox` 的 `Type.Enum`，或 `pi.arktype.enumerated(...)`；`pi-ai` 不再导出 `StringEnum`                                                                                                                                                                                       |
| 来自 `pi-coding-agent` 的 `formatSize`                                 | 来自 `@oh-my-pi/pi-utils` 的 `formatBytes`                                                                                                                                                                                                                                                      |
| 上游的资源/包/设置管理器作为原生架构                                    | 基于能力的发现（`loadCapability(...)`）、`Settings` 单例以及 `EventBus`；对 `DefaultResourceLoader`、`DefaultPackageManager` 和 `SettingsManager` 的旧式扩展 import 是 `legacy-pi-coding-agent-shim.ts` 中的兼容性垫片，不是原生实现 |

### 跳过这些上游特性

移植时，请**完全跳过**这些文件/特性：

- `footer-data-provider.ts` — 我们使用 StatusLineComponent
- `clipboard-image.ts` — 图像剪贴板支持通过由 `@oh-my-pi/pi-natives` 支持的 `src/utils/clipboard.ts` 暴露
- GitHub workflow 文件 — 我们有自己的 CI
- `models.generated.ts` — 自动生成，请在本地重新生成（改为 models.json）

### 我们添加的特性（请保留）

这些特性存在于我们的 fork 中，但上游没有。**永远不要覆盖：**

- 交互模式中的 `StatusLineComponent`
- 带会话亲和性的多凭据认证
- 基于能力的发现系统（`defineCapability`、`registerProvider`、`loadCapability`、`skillCapability` 等）
- MCP/Exa/SSH 集成
- format-on-save 的 LSP 透写
- Bash 拦截（`checkBashInterception`）
- read 工具中的模糊路径建议
