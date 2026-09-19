# Marketplace 插件系统

Marketplace 系统让你从 Git、本地或直接 catalog 来源发现、安装和管理插件。它兼容 Claude Code 插件注册表格式。

## 快速开始

```
/marketplace add anthropics/claude-plugins-official
/marketplace install wordpress.com@claude-plugins-official
```

在 TUI 中，不带参数的 `/marketplace` 会打开交互式插件浏览器。在 ACP/RPC 命令处理中，`/marketplace` 列出已配置的 marketplace；使用 `/marketplace discover` 进行浏览。

## 概念

**marketplace** 是一个 Git 仓库（或本地目录），其中包含位于 `.omp-plugin/marketplace.json`（首选）或 `.claude-plugin/marketplace.json`（Claude Code 兼容回退）的 catalog 文件。catalog 列出可用的插件及其来源、描述和元数据。

**plugin** 是包含 Claude/OMP 插件内容的目录，例如 skills、commands、agents、rules、hooks、tools、MCP servers 或 LSP servers。Marketplace 安装还会加载由 `package.json` 的 `omp.extensions` 声明的扩展模块：安装会把缓存的插件符号链接进作用域的 `node_modules` 树，并记录到 `omp-plugins.lock.json`，这与 npm 安装和 `omp plugin link` 的插件所使用的运行时表面相同。插件以 `name@marketplace` 标识（例如 `code-review@claude-plugins-official`）。

**作用域**：marketplace 插件可以安装在两个作用域：

- **user**（默认）—— 在所有项目中可用，存储在用户插件数据根目录的 `installed_plugins.json`（默认位于 `~/.omp/plugins/installed_plugins.json`）
- **project** —— 仅在当前项目中可用，存储在最近项目的 `.omp/plugins/installed_plugins.json` 中

已启用的 project 作用域安装会覆盖同一插件已启用的 user 作用域安装。已禁用的 project 安装不会覆盖 user 安装。

在 Linux 和 macOS 上，`omp config init-xdg` 会创建 XDG data、state 和 cache 根目录；它不会移动现有数据。一旦相关根目录存在并设置了 `XDG_DATA_HOME`、`XDG_STATE_HOME` 和 `XDG_CACHE_HOME`，新的用户 marketplace/插件状态会解析到 `$XDG_DATA_HOME/omp` 下（包括 `marketplaces.json` 和 `plugins/`）。下面的 `~/.omp` 路径是非 XDG 的默认值。

## 命令

### 交互模式

| 命令 | 用途 |
| --- | --- |
| `/marketplace` | 打开交互式插件浏览器（安装） |

### Marketplace 管理

| 命令 | 用途 |
| --- | --- |
| `/marketplace add <source>` | 添加一个 marketplace 来源 |
| `/marketplace remove <name>` | 移除一个 marketplace |
| `/marketplace update [name]` | 重新抓取 catalog；省略 name 则更新全部 |
| `/marketplace list` | 列出已配置的 marketplace |

### 插件操作

| 命令 | 用途 |
| --- | --- |
| `/marketplace discover [marketplace]` | 浏览可用的插件 |
| `/marketplace install [--force] [--scope user\|project] name@marketplace` | 安装插件 |
| `/marketplace uninstall [--scope user\|project] name@marketplace` | 卸载插件；不带参数则打开 TUI 选择器 |
| `/marketplace installed` | 列出已安装的 marketplace 插件 |
| `/marketplace upgrade [--scope user\|project] [name@marketplace]` | 升级一个或全部插件 |
| `/plugins list` | 列出 npm/link 和 marketplace 插件 |
| `/plugins enable [--scope user\|project] name@marketplace` | 启用一个 marketplace 插件 |
| `/plugins disable [--scope user\|project] name@marketplace` | 禁用 marketplace 插件 |

### CLI 等效命令

相同的操作也可在命令行中执行：

```
omp plugin marketplace add <source>
omp plugin marketplace remove <name>
omp plugin marketplace update [name]
omp plugin marketplace list
omp plugin discover [marketplace]
omp plugin install [--force] [--scope user|project] name@marketplace
omp plugin uninstall [--scope user|project] name@marketplace
omp plugin upgrade [--scope user|project] [name@marketplace]
omp plugin enable [--scope user|project] name@marketplace
omp plugin disable [--scope user|project] name@marketplace
omp plugin list

```

TUI marketplace 的修改操作（显式命令和选择器）会更新磁盘状态并使发现缓存失效，但不会刷新当前会话。运行 `/reload-plugins` 可刷新 skills、斜杠命令和 MCP servers；新安装的 tools、hooks 或扩展模块需要重启会话。ACP/RPC marketplace 处理器会自动刷新 skills 和斜杠命令，但同样不会重建每个已初始化的能力集。

## Marketplace 来源

当你运行 `/marketplace add <source>` 时，系统会对来源进行分类：

| 来源格式 | 类型 | 示例 |
| --- | --- | --- |
| `owner/repo` | GitHub 简写 | `anthropics/claude-plugins-official` |
| `https://...*.json` | 直接 catalog URL | `https://example.com/marketplace.json` |
| `https://...` / `http://...` | Git 仓库，除非 URL 路径以 `.json` 结尾 | `https://github.com/org/repo` |
| `git@...` / `ssh://...` | Git 仓库 | `git@github.com:org/repo.git` |
| `./path` 或 `~/path` 或 `/path` | 本地目录 | `./my-marketplace` |

Git 和本地来源必须在 `.omp-plugin/marketplace.json`（首选）或 `.claude-plugin/marketplace.json`（Claude Code 兼容回退）包含 catalog。直接 catalog URL 仅缓存 JSON catalog；URL 来源 catalog 中的插件不能使用相对字符串来源（例如 `"./plugins/foo"`）。

## Catalog 格式（marketplace.json）

marketplace catalog 位于仓库根目录的 `.omp-plugin/marketplace.json`。当 omp 是唯一的使用者时，优先使用此路径。要保持与 Claude Code 兼容（omp 会从任一路径加载相同结构），请改为发布到 `.claude-plugin/marketplace.json`——当 `.omp-plugin/marketplace.json` 缺失时 omp 会用它作为回退。一个仓库可以同时发布两者：omp 读取 `.omp-plugin/` 副本，Claude Code 读取 `.claude-plugin/` 副本。两种方式下 catalog 格式相同：

```json
{
  "$schema": "https://anthropic.com/claude-code/marketplace.schema.json",
  "name": "my-marketplace",
  "owner": {
    "name": "Your Name",
    "email": "you@example.com"
  },
  "metadata": {
    "description": "A collection of plugins",
    "version": "1.0.0",
    "pluginRoot": "plugins"
  },
  "plugins": [
    {
      "name": "my-plugin",
      "description": "What this plugin does",
      "source": "./my-plugin",
      "category": "development",
      "homepage": "https://github.com/you/my-plugin"
    }
  ]
}
```

### 必填字段

| 字段 | 描述 |
| --- | --- |
| `name` | Marketplace 名称。小写字母数字、连字符和点。必须以字母数字开头和结尾。最多 64 个字符。 |
| `owner.name` | Marketplace 所有者名称 |
| `plugins` | 插件条目数组 |

顶层的 `metadata.description`、`metadata.version` 和 `metadata.pluginRoot` 是可选的。当设置了 `metadata.pluginRoot` 时，它会被前置到插件的相对 `source` 路径之前。

### 插件条目字段

| 字段 | 必填 | 描述 |
| --- | --- | --- |
| `name` | 是 | 插件名称（规则与 marketplace 名称相同） |
| `source` | 是 | 插件的查找位置（见下文） |
| `description` | 否 | 简短描述 |
| `version` | 否 | 版本字符串；安装版本依次回退到插件 manifest、来源 SHA，然后是 `0.0.0` |
| `author` | 否 | `{ name, email? }` |
| `homepage` | 否 | URL |
| `repository` | 否 | 仓库 URL/字符串 |
| `license` | 否 | 许可证字符串 |
| `keywords` | 否 | 字符串关键字数组 |
| `category` | 否 | 类别字符串（例如 `development`、`productivity`、`security`） |
| `tags` | 否 | 字符串标签数组 |
| `strict` | 否 | 布尔元数据标志；会被保留，但不被安装/运行时逻辑使用 |
| `commands` | 否 | commands 元数据；会被保留，但运行时 commands 从已安装的插件树中发现 |
| `agents` | 否 | agents 元数据；会被保留，但不会被 marketplace 安装消费 |
| `hooks` | 否 | hooks 元数据；会被保留，但运行时 hooks 从已安装的插件树中发现 |
| `mcpServers` | 否 | MCP 元数据；在此保留；运行时 MCP 配置来自插件 manifest/树 |
| `lspServers` | 否 | 内联映射或插件内路径；安装期间会被复制到 `.lsp.json` |
| `dapAdapters` | 否 | 内联映射或插件内 JSON/YAML 路径；会被复制到 `.dap.json`、`.dap.yaml` 或 `.dap.yml` |

### 插件来源格式

`source` 字段支持以下格式。字符串来源必须以 `./` 开头，并在 marketplace 根目录内解析，可选的 `metadata.pluginRoot` 会被前置到前面：

**相对路径**（在 marketplace 仓库内）：

```json
"source": "./my-plugin"
```

**Git 仓库 URL**：

```json
"source": {
  "source": "url",
  "url": "https://github.com/org/repo.git",
  "sha": "abc123..."
}
```

**GitHub 简写**：

```json
"source": {
  "source": "github",
  "repo": "org/repo",
  "ref": "main",
  "sha": "abc123..."
}
```

**Git 子目录**（monorepo）：

```json
"source": {
  "source": "git-subdir",
  "url": "https://github.com/org/monorepo.git",
  "path": "plugins/my-plugin",
  "ref": "main",
  "sha": "abc123..."
}
```

**npm 包**（已解析但尚不可安装）：

```json
"source": {
  "source": "npm",
  "package": "@scope/my-plugin",
  "version": "1.0.0"
}
```

当前安装程序会以 `npm plugin sources are not yet supported` 拒绝 npm marketplace 来源；请使用相对、GitHub、URL 或 git-subdir 来源。

无效的 catalog JSON 或无效的必填顶层字段会导致 catalog 被拒绝。无效的插件条目会被记录并跳过，以便其他有效条目仍可用。

## 更新、移除和作用域

- `/marketplace update [name]` 仅刷新 catalog；它不会重新安装插件。
- 省略 `--scope` 时，`omp plugin upgrade name@marketplace` 会重新安装每个已安装的作用域。当插件同时存在于两个作用域时，`/marketplace upgrade name@marketplace`、卸载以及启用/禁用需要 `--scope user|project`。
- 升级所有插件时仅比较声明了 `version` 的 catalog 条目。Semver 版本必须较新；非 semver 版本在不相等时被视为已更改。单个插件的失败会被跳过，因此全部插件的升级可能会部分成功。
- `marketplace.autoUpdate` 控制启动时的检查：`off`、`notify`（默认）或 `auto`。超过 24 小时的 catalog 会在版本检查前尽力刷新。尽管名称如此，当前的 `notify` 模式仅把更新可用性写入调试日志；它不会显示面向用户的通知。
- 移除一个 marketplace 会删除其注册表条目和 catalog 缓存；它不会卸载已经缓存并注册的插件。

## 磁盘布局

```
~/.omp/
  marketplaces.json              # Registry of added marketplaces
  plugins/
    installed_plugins.json       # User-scoped marketplace plugins (version: 2)
    omp-plugins.lock.json         # Runtime enable/feature state
    node_modules/<package>        # Symlink to the cached plugin
    cache/
      marketplaces/<name>/       # Cached marketplace clone/catalog
      plugins/<marketplace>___<plugin>___<version>/  # Cached plugin directories

<project>/.omp/
  plugins/
    installed_plugins.json       # Project-scoped marketplace plugins (version: 2)
    omp-plugins.lock.json         # Project runtime enable/feature state
    node_modules/<package>        # Symlink to the cached plugin
```

## 命名规则

Marketplace 和插件名称必须满足以下条件：

- 以小写字母或数字开头和结尾
- 仅包含小写字母、数字、连字符和点
- 最多 64 个字符

插件 ID（`name@marketplace`）总计最多 128 个字符。

有效示例：`my-plugin`、`code-review`、`wordpress.com`、`ai-firstify`
无效示例：`-bad`、`bad-`、`.bad`、`Bad`、`under_score`
