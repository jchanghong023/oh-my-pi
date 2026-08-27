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

## marketplace.json 结构

目录文件位于仓库根目录下的 `.omp-plugin/marketplace.json` 或 `.claude-plugin/marketplace.json`。omp 优先使用 `.omp-plugin/` 路径，并回退到 Claude 路径；一个仓库可以同时发布两份，以从单一源码树中暴露针对不同工具的目录。

### 顶层字段

| Field | Required | Description |
|---|---|---|
| `name` | yes | Marketplace name. Lowercase alphanumeric, hyphens, dots. Must start and end with alphanumeric. Max 64 chars. |
| `owner` | yes | Object with at minimum `owner.name` (string) |
| `owner.name` | yes | Marketplace owner name |
| `owner.email` | no | Owner contact email |
| `plugins` | yes | Array of plugin entries (see below) |
| `metadata.description` | no | Short description of the marketplace |
| `metadata.version` | no | Catalog metadata version string |
| `metadata.pluginRoot` | no | String prepended to all relative plugin source paths |
| extra top-level fields | no | Preserved by the parser but not used by marketplace install/runtime logic |

### 插件条目字段

| Field | Required | Description |
|---|---|---|
| `name` | yes | Plugin name (same naming rules as marketplace name) |
| `source` | yes | Where to find the plugin — string or object (see source types below) |
| `description` | no | Short plugin description |
| `version` | no | Version string; falls back to `.claude-plugin/plugin.json`, `package.json`, source SHA, then `0.0.0` |
| `author` | no | `{ name, email? }` |
| `homepage` | no | URL |
| `category` | no | e.g. `development`, `productivity`, `security` |
| `tags` / `keywords` | no | Arrays of string tags/keywords |
| `repository` | no | Repository URL |
| `license` | no | License string |
| `strict` | no | Boolean metadata flag; preserved but not used by install/runtime logic |
| `commands`, `agents`, `hooks`, `mcpServers` | no | Catalog metadata preserved by the parser; runtime discovery comes from the installed plugin tree and manifests |
| `lspServers` | no | Inline server map or path inside the plugin; installation writes `.lsp.json` |
| `dapAdapters` | no | Inline adapter map or JSON/YAML path inside the plugin; installation writes `.dap.json`, `.dap.yaml`, or `.dap.yml` |

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

> Note: npm plugin sources are accepted by catalog parsing but installation rejects them with `npm plugin sources are not yet supported`. Use relative or Git-based sources today.

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

> Note: MCP servers may instead be declared by the manifest's `mcpServers` field — either an inline server map or a path to a config file inside the plugin root (`{ "mcpServers": "./mcp-omp.json" }`). omp reads `.omp-plugin/plugin.json` first, then `.claude-plugin/plugin.json`; a manifest declaration replaces the default `.mcp.json` rather than merging with it, so one published tree can carry a per-harness MCP config.

> Note: extension modules declared via `package.json` `omp.extensions` **are** loaded from marketplace installs — installation symlinks the cached plugin into the scope's `node_modules` and records it in `omp-plugins.lock.json`, the same runtime surfaces used by npm-installed and `omp plugin link`ed plugins.

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

## 延伸阅读

- `docs/marketplace.md` — marketplace system internals, on-disk layout, command reference
- `docs/skills/authoring-extensions.md` — how to author the extension modules inside plugins
- `docs/skills/examples/mini-marketplace/` — minimal working marketplace example
