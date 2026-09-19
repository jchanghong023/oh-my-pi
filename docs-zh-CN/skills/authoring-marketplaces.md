---
name: authoring-marketplaces
description: Use when creating a new omp marketplace. Covers marketplace.json schema, source types, install commands, and publishing.
---

# 编写市场

市场（marketplace）是一个 Git 仓库（或本地目录），其中包含一份目录文件，位于 `.omp-plugin/marketplace.json`（omp 专用目录的首选路径）或 `.claude-plugin/marketplace.json`（兼容 Claude Code，用作回退路径）任一处。任何人都可以编写一个市场。用户使用 `/marketplace add owner/repo` 添加市场，然后从中安装各个插件。

## 最小可行的市场

```
my-marketplace/
  .claude-plugin/
    marketplace.json
  plugins/
    my-plugin/
      skills/
        my-skill/
          SKILL.md
```

```json
{
  "name": "my-marketplace",
  "owner": { "name": "Your Name" },
  "plugins": [
    {
      "name": "my-plugin",
      "description": "What it does",
      "source": "./plugins/my-plugin"
    }
  ]
}
```

推送到 GitHub。用户通过以下命令安装：

```
/marketplace add your-github-username/my-marketplace
/marketplace install my-plugin@my-marketplace
```

## marketplace.json schema

目录文件位于仓库根目录下的 `.omp-plugin/marketplace.json` 或 `.claude-plugin/marketplace.json`。omp 优先使用 `.omp-plugin/` 路径，并回退到 Claude 路径；一个仓库可以同时发布两份，以从单一源码树中暴露针对不同工具的目录。

### 顶层字段

| 字段 | 必需 | 描述 |
|---|---|---|
| `name` | 是 | 市场名称。小写字母数字、连字符、点。必须以字母数字开头和结尾。最长 64 个字符。 |
| `owner` | 是 | 对象，至少包含 `owner.name`（字符串） |
| `owner.name` | 是 | 市场所有者名称 |
| `owner.email` | 否 | 所有者联系邮箱 |
| `plugins` | 是 | 插件条目数组（见下文） |
| `metadata.description` | 否 | 市场的简短描述 |
| `metadata.version` | 否 | 目录元数据版本字符串 |
| `metadata.pluginRoot` | 否 | 前置到所有相对插件来源路径的字符串 |
| 额外的顶层字段 | 否 | 解析器会保留，但市场安装/运行时逻辑不使用 |

### 插件条目字段

| 字段 | 必需 | 描述 |
|---|---|---|
| `name` | 是 | 插件名称（命名规则与市场名称相同） |
| `source` | 是 | 在哪里找到插件 —— 字符串或对象（见下文的来源类型） |
| `description` | 否 | 插件的简短描述 |
| `version` | 否 | 版本字符串；依次回退到 `.claude-plugin/plugin.json`、`package.json`、来源 SHA，最后是 `0.0.0` |
| `author` | 否 | `{ name, email? }` |
| `homepage` | 否 | URL |
| `category` | 否 | 例如 `development`、`productivity`、`security` |
| `tags` / `keywords` | 否 | 字符串标签/关键词数组 |
| `repository` | 否 | 仓库 URL |
| `license` | 否 | 许可证字符串 |
| `strict` | 否 | 布尔元数据标志；解析器会保留，但安装/运行时逻辑不使用 |
| `commands`, `agents`, `hooks`, `mcpServers` | 否 | 解析器保留的目录元数据；运行时发现来自已安装的插件树和清单 |
| `lspServers` | 否 | 内联服务器映射或插件内的路径；安装时会写入 `.lsp.json` |
| `dapAdapters` | 否 | 内联适配器映射或插件内的 JSON/YAML 路径；安装时会写入 `.dap.json`、`.dap.yaml` 或 `.dap.yml` |

### 完整目录示例

```json
{
  "$schema": "https://anthropic.com/claude-code/marketplace.schema.json",
  "name": "acme-plugins",
  "owner": {
    "name": "Acme Corp",
    "email": "plugins@acme.example"
  },
  "metadata": {
    "description": "Official Acme plugins for oh-my-pi"
  },
  "plugins": [
    {
      "name": "acme-linter",
      "description": "Enforce Acme coding standards",
      "category": "development",
      "source": "./plugins/linter"
    },
    {
      "name": "acme-deploy",
      "description": "One-command deploy to Acme cloud",
      "category": "devops",
      "source": {
        "source": "github",
        "repo": "acme-corp/omp-deploy-plugin",
        "ref": "main"
      }
    }
  ]
}
```

## 插件来源类型

### 1. 相对路径字符串

指向市场仓库自身内部的子目录。必须以 `./` 开头。

```json
"source": "./plugins/my-plugin"
```

该路径相对于市场仓库根目录解析。解析到仓库根目录之外的路径遍历会被拒绝。

可使用 `metadata.pluginRoot` 来避免重复公共前缀：

```json
{
  "metadata": { "pluginRoot": "./plugins" },
  "plugins": [
    { "name": "plugin-a", "source": "./plugin-a" },
    { "name": "plugin-b", "source": "./plugin-b" }
  ]
}
```

### 2. Git URL

完整的 Git 仓库 URL。可选择固定到分支/标签（`ref`）或具体提交（`sha`）：

```json
"source": {
  "source": "url",
  "url": "https://github.com/org/my-plugin.git",
  "ref": "main",
  "sha": "a1b2c3d4..."
}
```

### 3. GitHub 简写

GitHub 仓库的简写形式。功能上等价于 Git URL，但更简洁：

```json
"source": {
  "source": "github",
  "repo": "org/my-plugin",
  "ref": "v2.1.0",
  "sha": "a1b2c3d4..."
}
```

### 4. Git 子目录（monorepo）

用于位于更大仓库子目录中的插件。`url` 接受完整的 HTTPS URL 或 GitHub 的 `owner/repo` 简写：

```json
"source": {
  "source": "git-subdir",
  "url": "https://github.com/org/monorepo.git",
  "path": "packages/my-plugin",
  "ref": "main",
  "sha": "a1b2c3d4..."
}
```

`path` 必须在克隆下来的仓库内解析——目录越界会被拒绝。

### 5. NPM 包

将插件声明为一个 npm 包。`version` 是可选的：

```json
"source": {
  "source": "npm",
  "package": "@acme/omp-plugin",
  "version": "1.2.0"
}
```

> 注意：npm 插件来源会被目录解析接受，但安装时会以 `npm plugin sources are not yet supported` 拒绝。目前请使用相对路径或基于 Git 的来源。

## 插件结构

插件目录（无论来源类型）按惯例位置提供内容，所有位置都是可选的：

```
my-plugin/
  skills/<name>/SKILL.md         ← skills
  commands/*.md                  ← slash commands
  agents/*.md                    ← subagent definitions
  hooks/pre/, hooks/post/        ← hooks
  tools/                         ← custom tools
  .mcp.json                      ← MCP server definitions (default location)
  .claude-plugin/plugin.json     ← optional paths for skills/commands and other manifest metadata
  package.json                   ← optional version and `omp.extensions`
  README.md                      ← recommended: description + usage
```

> 注意：MCP 服务器也可以改为通过清单的 `mcpServers` 字段声明——要么是内联的服务器映射，要么是指向插件根目录内某个配置文件的路径（`{ "mcpServers": "./mcp-omp.json" }`）。omp 会先读取 `.omp-plugin/plugin.json`，再读取 `.claude-plugin/plugin.json`；清单声明会替换默认的 `.mcp.json`，而不是与它合并，因此一个发布的源码树可以携带针对特定 harness 的 MCP 配置。

> 注意：通过 `package.json` 的 `omp.extensions` 声明的扩展模块**确实**会从市场安装中加载——安装时会把缓存的插件符号链接到作用域的 `node_modules` 中，并记录到 `omp-plugins.lock.json` 里，与 npm 安装和 `omp plugin link` 的插件使用相同的运行时表面。

## 安装命令

```
/marketplace install name@marketplace-name
/marketplace install --force name@marketplace-name     # reinstall
/marketplace install --scope project name@marketplace  # project-scoped
```

等价的 CLI 命令：

```
omp plugin marketplace add owner/repo
omp plugin install name@marketplace-name
```

作用域行为：

- **user**（默认）—— 安装到用户插件数据根目录下的 `installed_plugins.json`（默认 `~/.omp/plugins/installed_plugins.json`），在所有项目中可用。在 Linux 和 macOS 上，`omp config init-xdg` 会创建（但不会向其中迁移数据）XDG 根目录；一旦相关根目录存在且设置了 XDG 变量，新的用户状态会使用 `$XDG_DATA_HOME/omp/plugins/installed_plugins.json`。
- **project** —— 安装到 `<project>/.omp/plugins/installed_plugins.json`，仅在该项目中可用

一个已启用的项目作用域安装会覆盖具有相同 `name@marketplace` ID 的已启用用户作用域安装。被禁用的项目副本则会保留用户副本仍处于活动状态。

安装与发现细节：

- 无效的插件条目会被记录并跳过；无效的 JSON 或缺失必需的顶层字段会拒绝整个目录。
- `skills/` 和 `commands/` 可以通过 `.claude-plugin/plugin.json` 重新映射。声明的 skill 路径通常会附加到默认路径之后；对于目录来源恰好是 `"./"` 的插件，它们会替换默认路径。声明的 `commands`（优先）或 `slash-commands` 会替换默认路径，除非显式包含 `./commands`。插件根目录之外的路径会被忽略并给出警告。
- 目录中的 `lspServers` 和 `dapAdapters` 值会在安装时被物化。目录中的 `commands`、`agents`、`hooks` 和 `mcpServers` 仅为元数据；它们不会重新映射运行时发现。

## 命名规则

市场名称和插件名称必须满足：

- 仅包含小写字母、数字、连字符（`-`）和点（`.`）
- 以小写字母或数字开头和结尾
- 最多 64 个字符

插件 ID（`name@marketplace`）总长度最多 128 个字符。

合法：`my-plugin`、`code-review`、`acme.tools`、`ai-v2`
非法：`-bad-start`、`bad-end-`、`.dot-start`、`Under_score`、`HAS_CAPS`

## 发布工作流

1. 在一个新的 Git 仓库中，于 `.omp-plugin/marketplace.json`（仅 omp）或 `.claude-plugin/marketplace.json`（与 Claude Code 共享）创建 `marketplace.json`。
2. 添加指向子目录（或外部来源）的插件条目。
3. 推送到 GitHub。
4. 分享 `owner/repo` 字符串。用户使用 `/marketplace add owner/repo` 添加。
5. 当你更新目录后，用户运行 `/marketplace update your-marketplace-name` 来拉取最新版本。

发布前在本地测试：

```
/marketplace add ./path/to/my-marketplace
```

本地路径来源也接受 `~/` 和绝对路径。

## 进一步阅读

- `docs/marketplace.md` — 市场系统内部机制、磁盘布局、命令参考
- `docs/skills/authoring-extensions.md` — 如何编写插件内的扩展模块
- `docs/skills/examples/mini-marketplace/` — 最小可运行的市场示例
