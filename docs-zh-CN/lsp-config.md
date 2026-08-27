# OMP 中的 LSP 配置

本指南介绍如何为 OMP 编程代理配置语言服务器。

代码中的事实来源：

- 服务器配置类型：`packages/coding-agent/src/lsp/types.ts`（`ServerConfig`）
- 配置加载器：`packages/coding-agent/src/lsp/config.ts`
- 内置服务器定义：`packages/coding-agent/src/lsp/defaults.json`

## 自动检测

当没有任何配置文件提供服务器覆盖时，OMP 通过同时满足以下两个条件来自动检测内置服务器：

1. 当前工作目录包含服务器的至少一个 `rootMarkers`。
2. 服务器二进制可用——首先在受支持的项目本地 bin 目录中查找（例如 `node_modules/.bin/`、Python 虚拟环境、Ruby binstubs 以及 Go 的项目 `bin/`），然后在 `$PATH` 中查找。

启动时的根标记检测仅作用于当前工作目录，不会搜索父目录。通配符标记（例如 `*.cabal`）仅匹配直接位于当前工作目录中的条目，不会递归。对于常见配置无需任何设置；完整的内置集合请参见 [`defaults.json`](../packages/coding-agent/src/lsp/defaults.json)。

## 配置文件位置

OMP 按从低到高的优先级合并来自多个来源的 LSP 配置：

| 优先级       | 位置                                                                                                         |
| -----------: | ------------------------------------------------------------------------------------------------------------ |
|       最低   | `~/lsp.json`、`~/.lsp.json`、`~/lsp.yaml`、`~/.lsp.yaml`、`~/lsp.yml`、`~/.lsp.yml`                         |
|              | 插件 LSP 配置（marketplace / `--plugin-dir` 根目录）                                                          |
|              | 用户配置目录：当前原生代理目录，然后是 `~/.claude/lsp.*`、`~/.codex/lsp.*`、`~/.gemini/lsp.*`                |
|              | 当前工作目录配置目录：`<cwd>/.omp/lsp.*`、`<cwd>/.claude/lsp.*`、`<cwd>/.codex/lsp.*`、`<cwd>/.gemini/lsp.*` |
|       最高   | 当前工作目录根：`<cwd>/lsp.*` 和 `<cwd>/.lsp.*`                                                               |

每个位置都接受 `.json`、`.yaml` 和 `.yml`，包括隐藏的变体。当同一位置存在多个变体时，从高到低的优先级为 `lsp.json`、`.lsp.json`、`lsp.yaml`、`.lsp.yaml`、`lsp.yml`、`.lsp.yml`。

合并按服务器浅合并：更高优先级的服务器对象仅覆盖其顶层字段，但像 `settings`、`initOptions`、`capabilities` 和 `workspaceReadyTimings` 这类对象类型的字段会整体替换较低优先级的值，而不是深度合并它们。覆盖文件中未列出的服务器保持内置默认值。

原生用户配置目录遵循 `PI_CONFIG_DIR` 和当前 profile；`~/.omp/agent/lsp.json` 是默认 profile 的形式。此共享配置查找不会将 `PI_CODING_AGENT_DIR` 作为任意的替换基础。项目和当前工作目录来源不会向上遍历父级目录。

**推荐位置：**

- 用户全局偏好 → 当前原生代理目录中的 `lsp.json`
- 项目特定覆盖 → `<cwd>/.omp/lsp.json`

> **注意：** 仅当至少有一个可读的配置文件贡献了非空的服务器映射时，才会跳过自动检测模式。仅设置了 `idleTimeoutMs` 的配置仍会使用内置自动检测。对于带服务器覆盖的情况，OMP 首先将它们合并到所有默认值之上，然后保留那些根标记与当前工作目录匹配、二进制可解析、且合并后配置未设置为 `disabled` 的服务器。

## 文件格式

JSON 和 YAML 均可接受。顶层对象既可以使用 `servers` 包装键，也可以直接使用扁平映射：

```json
{
  "servers": {
    "server-name": { ... }
  },
  "idleTimeoutMs": 300000
}
```

或者（扁平形式，不带 `servers` 包装键）：

```json
{
  "server-name": { ... },
  "idleTimeoutMs": 300000
}
```

顶层键：

- `servers` — 服务器名称到 `ServerConfig` 的映射（可选的包装键；扁平形式是等价的）
- `idleTimeoutMs` — 在此毫秒数后关闭空闲的语言服务器；省略、零和负值都会使空闲关闭保持禁用

不要混合使用包装形式和扁平形式的服务器条目：当存在 `servers` 时，`idleTimeoutMs` 之外的同级键不会被视为服务器。

## ServerConfig 字段

| 字段                     | 类型       | 新建服务器是否必填  | 描述                                                                                            |
| ----------------------- | ---------- | ------------------: | ---------------------------------------------------------------------------------------------- |
| `command`               | `string`   |                  是 | 二进制名称（通过本地 bins / PATH 解析）或绝对路径                                              |
| `args`                  | `string[]` |                 否 | 传递给二进制的参数                                                                              |
| `fileTypes`             | `string[]` |                  是 | 该服务器处理的文件扩展名，例如 `[".ts", ".tsx"]`                                                |
| `languageId`            | `string`   |                 否 | 在 `textDocument/didOpen` 中发送的 LSP language id；省略时从文件路径推断                       |
| `rootMarkers`           | `string[]` |                  是 | 指示项目根的文件/目录；支持一级通配符模式，例如 `*.cabal`                                        |
| `initOptions`           | `object`   |                 否 | 在 LSP 握手期间作为 `initializationOptions` 发送                                                |
| `settings`              | `object`   |                 否 | 通过 `workspace/didChangeConfiguration` 推送                                                    |
| `disabled`              | `boolean`  |                 否 | 设置为 `true` 以禁用此服务器                                                                    |
| `warmupTimeoutMs`       | `number`   |                 否 | 该服务器的启动超时（毫秒）                                                                      |
| `isLinter`              | `boolean`  |                 否 | 标记仅用于 lint/格式化的服务器；将其排除在类型智能操作之外                                       |
| `capabilities`          | `object`   |                 否 | 选择性启用的服务器特定功能；参见 [Capabilities](#capabilities)                                   |
| `workspaceReadyTimings` | `object`   |                 否 | 高级的 rust-analyzer 工作区就绪时序覆盖；见下文                                                  |

对于内置服务器的覆盖，必填字段可以省略，因为它们在验证之前会被继承。一个真正的新服务器需要上述三个必填字段。`resolvedCommand` 和 `createClient` 是运行时拥有的字段，不得在配置中设置。

### Capabilities

`capabilities` 对象用于启用 OMP 按服务器支持的可选服务器特定功能：

```json
{
  "capabilities": {
    "flycheck": true,
    "ssr": true,
    "expandMacro": true,
    "runnables": true,
    "relatedTests": true
  }
}
```

所有字段都是布尔值且为可选字段。它们目前被 `rust-analyzer` 使用。

### 高级 rust-analyzer 就绪时序

`workspaceReadyTimings` 用于调整 rust-analyzer 的工作区就绪轮询：

```json
{
  "servers": {
    "rust-analyzer": {
      "workspaceReadyTimings": {
        "timeoutMs": 30000,
        "pollMs": 250,
        "settleMs": 2000,
        "statusRequestTimeoutMs": 2000
      }
    }
  }
}
```

所有四个字段都是可选的毫秒值。这是一个高级的调优面；普通配置应使用默认值。

## 常见配置示例

### 覆盖内置服务器的设置

部分覆盖会合并到内置默认值之上。只需指定要更改的字段。

```json
{
  "servers": {
    "typescript-language-server": {
      "args": ["--stdio", "--log-level", "4"]
    }
  }
}
```

```yaml
servers:
  gopls:
    settings:
      gopls:
        gofumpt: false
        staticcheck: false
```

### 禁用内置服务器

```json
{
  "servers": {
    "eslint": {
      "disabled": true
    }
  }
}
```

### 注册自定义服务器

新服务器需要非空的 `command`、`fileTypes` 和 `rootMarkers`。无效的服务器定义将被忽略并产生警告。无法读取的文件或无效的 JSON/YAML 会被忽略；加载器会继续处理其余来源。

```json
{
  "servers": {
    "my-lsp": {
      "command": "my-lsp-server",
      "args": ["--stdio"],
      "fileTypes": [".xyz"],
      "rootMarkers": [".xyz-project", ".git"]
    }
  }
}
```

### 设置全局空闲超时

关闭空闲超过五分钟的语言服务器：

```json
{
  "idleTimeoutMs": 300000
}
```

### 在单个项目中禁用某个服务器，但全局保留

将覆盖配置放在 `<project>/.omp/lsp.json` 中：

```json
{
  "servers": {
    "pylsp": {
      "disabled": true
    }
  }
}
```

`~/.omp/agent/lsp.json` 中的用户级配置不受影响；pylsp 仅在此项目中被禁用。

## 内置服务器列表

以下服务器随 `defaults.json` 提供，可被自动检测：

| Server key                    | Language(s)                   | Binary                            |
| ----------------------------- | ----------------------------- | --------------------------------- |
| `rust-analyzer`               | Rust                          | `rust-analyzer`                   |
| `clangd`                      | C, C++, ObjC                  | `clangd`                          |
| `zls`                         | Zig                           | `zls`                             |
| `gopls`                       | Go                            | `gopls`                           |
| `typescript-language-server`  | TypeScript, JavaScript        | `typescript-language-server`      |
| `denols`                      | TypeScript, JavaScript (Deno) | `deno`                            |
| `biome`                       | TS/JS/JSON (linter)           | `biome`                           |
| `eslint`                      | TS/JS/Vue/Svelte (linter)     | `vscode-eslint-language-server`   |
| `vscode-html-language-server` | HTML                          | `vscode-html-language-server`     |
| `vscode-css-language-server`  | CSS, SCSS, Less               | `vscode-css-language-server`      |
| `vscode-json-language-server` | JSON                          | `vscode-json-language-server`     |
| `tailwindcss`                 | HTML, CSS, TS/JS              | `tailwindcss-language-server`     |
| `svelte`                      | Svelte                        | `svelteserver`                    |
| `vue-language-server`         | Vue                           | `vue-language-server`             |
| `astro`                       | Astro                         | `astro-ls`                        |
| `pyright`                     | Python                        | `pyright-langserver`              |
| `basedpyright`                | Python                        | `basedpyright-langserver`         |
| `pylsp`                       | Python                        | `pylsp`                           |
| `ruff`                        | Python (linter)               | `ruff`                            |
| `jdtls`                       | Java                          | `jdtls`                           |
| `kotlin-lsp`                  | Kotlin                        | `kotlin-lsp`                      |
| `metals`                      | Scala                         | `metals`                          |
| `hls`                         | Haskell                       | `haskell-language-server-wrapper` |
| `ocamllsp`                    | OCaml                         | `ocamllsp`                        |
| `elixirls`                    | Elixir                        | `elixir-ls`                       |
| `expert`                      | Elixir                        | `expert`                          |
| `erlangls`                    | Erlang                        | `erlang_ls`                       |
| `gleam`                       | Gleam                         | `gleam`                           |
| `solargraph`                  | Ruby                          | `solargraph`                      |
| `ruby-lsp`                    | Ruby                          | `ruby-lsp`                        |
| `rubocop`                     | Ruby (linter)                 | `rubocop`                         |
| `bashls`                      | Bash, Zsh                     | `bash-language-server`            |
| `lua-language-server`         | Lua                           | `lua-language-server`             |
| `intelephense`                | PHP                           | `intelephense`                    |
| `phpactor`                    | PHP                           | `phpactor`                        |
| `omnisharp`                   | C#                            | `omnisharp`                       |
| `yamlls`                      | YAML                          | `yaml-language-server`            |
| `terraformls`                 | Terraform                     | `terraform-ls`                    |
| `dockerls`                    | Dockerfile                    | `docker-langserver`               |
| `helm-ls`                     | Helm                          | `helm_ls`                         |
| `nixd`                        | Nix                           | `nixd`                            |
| `nil`                         | Nix                           | `nil`                             |
| `ols`                         | Odin                          | `ols`                             |
| `dartls`                      | Dart                          | `dart`                            |
| `marksman`                    | Markdown                      | `marksman`                        |
| `texlab`                      | LaTeX                         | `texlab`                          |
| `graphql`                     | GraphQL                       | `graphql-lsp`                     |
| `prismals`                    | Prisma                        | `prisma-language-server`          |
| `vimls`                       | Vim script                    | `vim-language-server`             |
| `emmet-language-server`       | HTML, CSS, JSX                | `emmet-language-server`           |
| `sourcekit-lsp`               | Swift                         | `sourcekit-lsp`                   |
| `swiftlint`                   | Swift (linter)                | `swiftlint`                       |
| `tlaplus`                     | TLA+                          | `tlapm_lsp`                       |
