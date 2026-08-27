# OMP 中的 MCP 配置

本指南介绍如何为 OMP 编程智能体添加、编辑和校验 MCP 服务器。

代码中的真实来源：

- 运行时配置类型：`packages/coding-agent/src/mcp/types.ts`
- 配置写入器：`packages/coding-agent/src/mcp/config-writer.ts`
- 加载器与校验：`packages/coding-agent/src/mcp/config.ts`
- 独立 `mcp.json` 发现：`packages/coding-agent/src/discovery/mcp-json.ts`
- 模式定义：`packages/coding-agent/src/config/mcp-schema.json`

## 推荐配置位置

OMP 可以从多个工具发现 MCP 服务器（`.claude/`、`.cursor/`、`.vscode/`、`opencode.json` 等），但对于 OMP 原生配置，通常应使用以下主要文件之一：

- 项目级：`.omp/mcp.json`
- 用户级：`~/.omp/agent/mcp.json`（或当某个命名 profile 处于激活状态时使用 `~/.omp/profiles/<name>/agent/mcp.json` —— 参见 [Profiles](#profiles)）

为了保持兼容，原生提供方还会读取 `.omp/.mcp.json` 与 `~/.omp/agent/.mcp.json`，但 OMP 写入的是上面那些主要的 `mcp.json` 路径。

OMP 也接受项目根目录下的独立后备文件：

- `mcp.json`
- `.mcp.json`

当你希望由 OMP 负责该配置时，请使用 `.omp/mcp.json` 或 `~/.omp/agent/mcp.json`。仅在你希望得到一个其他 MCP 客户端也能读取的可移植后备文件时，才使用根目录下的 `mcp.json` / `.mcp.json`。

### 导入的工具配置

OMP 还会翻译以下当前各工具原生配置源：

- Claude Code：`~/.claude.json`、`~/.claude/mcp.json`，以及项目下的 `.claude/.mcp.json` / `.claude/mcp.json`
- Codex：`~/.codex/config.toml` 和 `.codex/config.toml`（`[mcp_servers.*]`）
- Gemini CLI：`~/.gemini/settings.json` 和 `.gemini/settings.json`
- OpenCode：`~/.config/opencode/opencode.json` 和项目根目录下的 `opencode.json`
- Cursor：`~/.cursor/mcp.json` 和 `.cursor/mcp.json`
- Windsurf：`~/.codeium/windsurf/mcp_config.json` 和 `.windsurf/mcp_config.json`
- VS Code：仅项目级的 `.vscode/mcp.json`，使用 `mcp.servers`
- 已安装的 Claude 市场上声明了 MCP 服务器的插件，以及 OMP 扩展包

对于 Claude Code、Codex、Gemini CLI、Cursor 和 Windsurf，项目级条目会在同名的用户级条目之前被遇到——这与 OMP 原生配置一致，后者也是项目级条目先于当前激活 profile 的用户级条目——因此项目中的 `enabled: false` 会压制同名的用户级服务器。OpenCode 目前是先遇到用户级条目。跨提供方的优先级请参见 [发现与优先级](#discovery-and-precedence)。

### Profiles

命名 profile（`omp --profile <name>`、`--alias` 快捷方式，或 `OMP_PROFILE`/`PI_PROFILE`）会隔离用户级 MCP 配置。当某个 profile 处于激活状态时，**用户**作用域解析到该 profile 自身的 agent 目录，而不是默认目录：

- 默认 profile：`~/.omp/agent/mcp.json`
- profile `<name>`：`~/.omp/profiles/<name>/agent/mcp.json`

发现过程、`/mcp` 命令以及配置写入器都遵循当前激活的 profile，因此某个 profile 只能看到**它自己的**用户级服务器——绝不会看到默认 profile 的 `~/.omp/agent/mcp.json`。要向某个 profile 添加服务器，可以在该 profile 下启动（`omp --profile <name>`），然后运行 `/mcp add` → 用户级，或者直接编辑 `~/.omp/profiles/<name>/agent/mcp.json`。

项目级 MCP 配置（`.omp/mcp.json`）按工作目录绑定，而不是按 profile 绑定，因此它会在所有 profile 下生效。外部工具的配置（`.claude/`、`.cursor/` 等）也独立于 profile，因为它们属于那些工具，而不属于某个 OMP profile。

MCP 遵循的 profile 规则与 OMP 原生配置的其他部分相同；请参见 [配置发现 → Profiles](./config-usage.md#profiles)。

## 添加模式引用

在文件顶部添加这一行，以便编辑器自动补全与校验：

```json
{
  "$schema": "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json",
  "mcpServers": {}
}
```

当 `/mcp add`、`/mcp enable`、`/mcp disable`、`/mcp reauth` 或其他写入配置的流程创建或更新一个由 OMP 管理的 MCP 文件时，OMP 现在会自动写入这一行。

## 文件结构

OMP 支持以下顶层结构：

```json
{
  "$schema": "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json",
  "mcpServers": {
    "server-name": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "some-mcp-server"]
    }
  },
  "disabledServers": ["server-name"]
}
```

顶层键：

- `$schema` —— 供工具使用的可选 JSON Schema URL
- `mcpServers` —— 服务器名到服务器配置的映射
- `disabledServers` —— 当前激活 profile 的用户级黑名单；无论源条目中的 `enabled` 值如何，它都会按名称隐藏一个已发现的服务器
- `enabledServers` —— 当前激活 profile 的用户级白名单；它可以强制启用某个源声明为 `enabled: false` 的同名条目，但 `disabledServers` 仍然优先

配置写入器接受的名称最长为 100 个字符，可包含字母、数字、`_`、`-`、`.` 和 `:`。内置的 schema 当前在其名称 pattern 中省略了 `:`，因此像 `cloudflare:cloudflare-api` 这样由 OMP 管理的带命名空间的插件条目在运行时可能有效，但编辑器会报告模式错误。

## 支持的服务器字段

所有传输方式共有的字段：

- `enabled?: boolean` —— 当值为 `false` 时跳过此服务器，除非当前激活 profile 的用户级 `enabledServers` 白名单中列出了它
- `timeout?: number` —— MCP 请求的超时时间，单位为毫秒；`0` 表示禁用客户端侧的 MCP 超时
- `requestIdFormat?: "number" | "string"` —— 发出 JSON-RPC 请求时 request id 的编码方式；默认按各传输使用整数。`"string"` 使用抗冲突的雪花 ID。该 OMP 特有字段仅从 OMP 原生文件、根目录的 `mcp.json` / `.mcp.json` 以及 OMP 扩展包中读取；从其他工具翻译过来的配置会忽略它
- `auth?: { ... }` —— 已存储凭据的元数据；为 OAuth 实现了托管凭据注入
- `oauth?: { ... }` —— 在 auth/reauth 过程中使用的显式 OAuth 客户端与回调设置

`OMP_MCP_TIMEOUT_MS` 在进程范围内对每个服务器的 `timeout` 都具有最高优先级。将其设为 `0` 可禁用客户端侧超时，或设为一个正的毫秒数（如 `120000`）。如果未设置或无效，OMP 会先使用服务器的值，再退回到 30 秒的默认值；无效值会被记录并忽略。

### `stdio` 传输

当省略 `type` 时，默认就是 `stdio`。

必填项：

- `command: string`

可选项：

- `type?: "stdio"`
- `args?: string[]`
- `env?: Record<string, string>`
- `cwd?: string`

示例：

```json
{
  "$schema": "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json",
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-filesystem",
        "/Users/alice/projects",
        "/Users/alice/Documents"
      ]
    }
  }
}
```

这与官方的 Filesystem MCP 服务器包（`@modelcontextprotocol/server-filesystem`）一致。

### `http` 传输

必填项：

- `type: "http"`
- `url: string`

可选项：

- `headers?: Record<string, string>`

示例：

```json
{
  "$schema": "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json",
  "mcpServers": {
    "github": {
      "type": "http",
      "url": "https://api.githubcopilot.com/mcp/"
    }
  }
}
```

这与 GitHub 托管的 GitHub MCP 服务器端点一致。

### `sse` 传输

必填项：

- `type: "sse"`
- `url: string`

可选项：

- `headers?: Record<string, string>`

示例：

```json
{
  "$schema": "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json",
  "mcpServers": {
    "legacy-remote": {
      "type": "sse",
      "url": "https://example.com/mcp/sse"
    }
  }
}
```

为了兼容性仍支持 `sse`，但 MCP 规范现在为新服务器推荐使用 Streamable HTTP（`type: "http"`）。

## 认证字段

OMP 理解两类与认证相关的对象。

### `auth`

```json
{
  "type": "oauth",
  "credentialId": "optional-stored-credential-id",
  "tokenUrl": "optional-token-endpoint",
  "clientId": "optional-client-id",
  "clientSecret": "optional-client-secret",
  "resource": "optional-mcp-resource-uri"
}
```

对于托管的 OAuth，`auth` 告诉 OMP 如何查找并刷新已存储的凭据。虽然 `"apikey"` 是被接受的 `type`，但它不会从认证存储中加载或注入 API 密钥。请将 API 密钥直接放在 stdio 的 `env` 或远程的 `headers` 中（推荐使用下面介绍的环境变量或 `!command` 间接方式）。

通常你不需要编写这个块：当 OMP 为 `http`/`sse` 服务器完成 OAuth 流程时，它会使用一个由当前激活 profile 与服务器 URL 派生的确定性 id（`mcp_oauth:profile:<profile>:<url>`）来存储凭据，并将刷新材料一并嵌入。任何指向同一 URL 的配置——包括共享项目 `mcp.json` 中完全没有 `auth` 块的_仅定义_条目——都会自动解析到当前 profile 自己的凭据，即使认证存储由共享的认证代理托管也是如此。正是这一点让项目级服务器在跨 profile 时也是安全的：提交定义，每个 profile 通过 `/mcp reauth <name>` 自行授权（并保持登录自己的账户）。显式的 `credentialId` 在能够解析时仍会被遵循；如果它指向另一个 profile 的记录，OMP 会回退到按 profile 作用域以 URL 键控的绑定。

对一个仅含定义的条目执行 `/mcp reauth` 不会改动文件——凭据（包括刷新材料）完全存放在当前激活 profile 的认证存储中（本地 `agent.db` 或代理），因此已提交的项目配置永远不会带入本地认证状态。显式配置的 `Authorization` 头始终优先于按 URL 键控的绑定。

该绑定是按 profile 划分的，而不是按项目划分的：一旦某个 profile 授权了某个 URL，_任何_在其 `mcp.json` 中为该 URL 定义了服务器的检出目录都会自动使用该 profile 的凭据连接。已提交的 MCP 定义是受信任的输入——这对 `stdio` 条目同样适用，因为它们会执行任意命令——因此在使用持有你关心的凭据的 profile 打开一个代码库之前，请先审查其 `mcp.json`，或对不受信任的检出使用一个专用的 profile。

### `oauth`

```json
{
  "clientId": "...",
  "clientSecret": "...",
  "redirectUri": "...",
  "callbackPort": 3334,
  "callbackPath": "/oauth/callback",
  "prompt": "consent"
}
```

当 MCP 服务器需要显式的 OAuth 客户端或回调设置时，请使用 `oauth`。回调监听器默认使用端口 `3000` 与路径 `/callback`；HTTP 环回 `redirectUri` 会自带端口/路径，除非被显式覆盖。HTTPS 环回重定向需要在你的 TLS 终止器后端为本地 HTTP 监听器指定一个不同的 `callbackPort`。

`prompt` 控制 OAuth 的 `prompt` 授权参数。OMP 默认省略它，但有一个例外：当请求了 `offline_access` 作用域时，默认设为 `"consent"`，以便提供方能够签发刷新用的访问令牌。可将其显式设为提供方支持的值，如 `"consent"` 或 `"select_account"`，或设为 `""` 以强制省略。

示例：

```json
{
  "$schema": "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json",
  "mcpServers": {
    "slack": {
      "type": "http",
      "url": "https://mcp.slack.com/mcp",
      "oauth": {
        "clientId": "YOUR_SLACK_CLIENT_ID",
        "clientSecret": "YOUR_SLACK_CLIENT_SECRET"
      },
      "auth": {
        "type": "oauth",
        "tokenUrl": "https://slack.com/api/oauth.v2.user.access",
        "clientId": "YOUR_SLACK_CLIENT_ID",
        "clientSecret": "YOUR_SLACK_CLIENT_SECRET"
      }
    }
  }
}
```

来自 Slack 文档的相关端点：

- MCP 端点：`https://mcp.slack.com/mcp`
- 授权端点：`https://slack.com/oauth/v2_user/authorize`
- 令牌端点：`https://slack.com/api/oauth.v2.user.access`

## 常用复制粘贴示例

### 通过 stdio 接入 Filesystem 服务器

```json
{
  "$schema": "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json",
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-filesystem",
        "/absolute/path/one",
        "/absolute/path/two"
      ]
    }
  }
}
```

### 通过 HTTP 接入 GitHub 托管服务器

```json
{
  "$schema": "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json",
  "mcpServers": {
    "github": {
      "type": "http",
      "url": "https://api.githubcopilot.com/mcp/"
    }
  }
}
```

### 通过 Docker 接入 GitHub 本地服务器

```json
{
  "$schema": "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json",
  "mcpServers": {
    "github": {
      "command": "docker",
      "args": [
        "run",
        "-i",
        "--rm",
        "-e",
        "GITHUB_PERSONAL_ACCESS_TOKEN",
        "ghcr.io/github/github-mcp-server"
      ],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "GITHUB_PERSONAL_ACCESS_TOKEN"
      }
    }
  }
}
```

这与 GitHub 官方的本地 Docker 镜像 `ghcr.io/github/github-mcp-server` 一致。

### 通过 OAuth 接入 Slack 托管服务器

```json
{
  "$schema": "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json",
  "mcpServers": {
    "slack": {
      "type": "http",
      "url": "https://mcp.slack.com/mcp",
      "oauth": {
        "clientId": "YOUR_SLACK_CLIENT_ID",
        "clientSecret": "YOUR_SLACK_CLIENT_SECRET"
      },
      "auth": {
        "type": "oauth",
        "tokenUrl": "https://slack.com/api/oauth.v2.user.access",
        "clientId": "YOUR_SLACK_CLIENT_ID",
        "clientSecret": "YOUR_SLACK_CLIENT_SECRET"
      }
    }
  }
}
```

## 密钥与变量解析

这一部分通常最容易让人困惑。

### 发现阶段的 `${...}` 展开

OMP 在从 OMP 原生文件和独立后备文件中发现 MCP 配置时，会展开 `${VAR}` 和 `${VAR:-default}` 占位符。该展开会递归作用于 `command`、`args`、`env`、`cwd`、`url`、`headers`、`auth`、`oauth` 中的字符串值；未解析的占位符会原样保留为字符串。

示例：

```json
{
  "mcpServers": {
    "github": {
      "type": "http",
      "url": "https://api.githubcopilot.com/mcp/",
      "headers": {
        "Authorization": "Bearer ${GITHUB_TOKEN}"
      }
    }
  }
}
```

### 连接前的 env/header 解析

在 OMP 启动 stdio 服务器或发起 HTTP/SSE 请求之前，它会按以下方式解析 stdio 的 `env` 值与 HTTP/SSE 的 `headers` 值：

1. 如果值以 `!` 开头，OMP 将其余部分作为 shell 命令运行，设置 10 秒超时，并使用去除首尾空白后的 stdout。成功的结果会在进程的生命周期内被缓存。
2. 如果命令失败、超时或只输出空白，那么对应的 `env`/`headers` 条目会被省略。
3. 否则 OMP 会检查整个值是否正好是一个环境变量的名称。
4. 如果该环境变量已设置且值非空，OMP 使用该环境变量的值；否则按字符串字面使用。

示例：

```json
{
  "env": {
    "GITHUB_PERSONAL_ACCESS_TOKEN": "GITHUB_PERSONAL_ACCESS_TOKEN"
  },
  "headers": {
    "X-MCP-Insiders": "true"
  }
}
```

这意味着以下写法对本地密钥是有效且方便的：

- `"GITHUB_PERSONAL_ACCESS_TOKEN": "GITHUB_PERSONAL_ACCESS_TOKEN"` → 从当前 shell 环境中复制
- `"Authorization": "Bearer hardcoded-token"` → 使用字面值
- `"Authorization": "!printf 'Bearer %s' \"$GITHUB_TOKEN\""` → 通过命令构造该头

## 用户级启用与禁用覆盖

当前激活 profile 的用户文件提供两项跨源的覆盖：

- `disabledServers` 是优先级最高的黑名单。它会按名称从任何源中隐藏同名服务器。
- `enabledServers` 会强制启用某个源中标记为 `enabled: false` 的同名条目；它无法覆盖 `disabledServers`。

```json
{
  "$schema": "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json",
  "disabledServers": ["github"],
  "enabledServers": ["tool-owned-server"]
}
```

当定义位于 OMP 拥有的可写文件中时，`/mcp enable` 和 `/mcp disable` 会直接更新 `enabled`。OMP 不会改写其他工具的配置：对于这些来源，这些命令会改为维护用户级的白名单或黑名单，并移除与之冲突的过时覆盖。

## `/mcp add` 与直接编辑 JSON

当你希望获得引导式配置时，请使用 `/mcp add`。

在以下情况下，直接编辑 JSON：

- 你需要使用向导目前尚未提示的传输或认证选项
- 你希望从另一个 MCP 客户端粘贴一份服务器定义
- 你希望编辑器提供基于 schema 的校验

编辑完成后，使用：

- `/mcp reload` 在当前会话中重新发现并重连服务器
- `/mcp list` 查看某个服务器来自哪个配置文件
- `/mcp test <name>` 测试单个服务器
- `/mcp reconnect <name>` 重新连接单个服务器而无需重新发现所有配置
- `/mcp reauth <name>` 替换托管的 OAuth 凭据，或使用 `/mcp unauth <name>` 移除它们
- `/mcp resources`、`/mcp prompts` 与 `/mcp notifications` 检查非工具类 MCP 能力

## OMP 强制执行的校验规则

来自 `packages/coding-agent/src/mcp/config.ts` 中的 `validateServerConfig()`：

- `stdio` 需要 `command`
- `http` 与 `sse` 需要 `url`
- 一台服务器不能同时设置 `command` 与 `url`
- 未知 `type` 值会被拒绝

实际影响：

- 省略 `type` 意味着 `stdio`
- 如果你粘贴了一份远程服务器的配置却忘了写 `"type": "http"`，OMP 会按 `stdio` 处理并报 `command` 缺失
- `sse` 仍因兼容性而有效，但新托管服务器通常应配置为 `http`

## 发现与优先级

OMP 按从高到低的优先级加载各提供方。支持 MCP 的顺序为：

1. OMP 原生配置
2. OMP 扩展包
3. Claude Code
4. Claude 市场上的插件与 Codex
5. Gemini CLI
6. OpenCode
7. Cursor 与 Windsurf
8. VS Code
9. 根目录的 `mcp.json` / `.mcp.json` 后备文件

第一个定义胜出。重复的名称不会合并。即使名称不同，只要其传输、端点/命令输入、认证和 request id 模式与更高优先级的定义等价，也会被屏蔽。

在 OMP 原生配置内部，项目级的 `.omp/mcp.json` 先于 `.omp/.mcp.json`，然后是当前激活 profile 的用户级 `mcp.json` 和 `.mcp.json`。根目录的后备 `mcp.json` 先于根目录的 `.mcp.json`。实际上：

- 对于 OMP 特定的覆盖，优先使用 `.omp/mcp.json` 或当前激活 profile 的用户级 `mcp.json`
- 尽量在各个工具之间保持名称和端点定义唯一
- 当第三方配置反复引入不需要的服务器时，使用用户级 `disabledServers` 列表
- 设置 `mcp.enableProjectConfig: false` 以在去重前排除所有项目级源，从而允许同名的用户级条目保留下来

## 故障排查

### `Server "name": stdio server requires "command" field`

你很可能在远程服务器上漏掉了 `type: "http"`。

### `Server "name": both "command" and "url" are set`

二选一。OMP 将 `command` 视为 stdio，将 `url` 视为 http/sse。

### `/mcp add` 成功了，但服务器仍然无法连接

JSON 是有效的，但服务器可能仍然无法访问。请使用 `/mcp test <name>`，并检查以下情况：

- 二进制或 Docker 镜像是否存在
- 所需的环境变量是否已设置
- 远程 URL 是否可达
- OAuth 或 API 令牌是否有效

### 服务器存在于另一个工具的配置中，但在 OMP 中不存在

运行 `/mcp list`。OMP 会发现许多第三方 MCP 文件，但项目级加载也可以通过 `mcp.enableProjectConfig` 设置禁用，而用户级 `disabledServers` 条目可以按名称压制某个服务器。

### 带命名空间的服务器可以工作，但编辑器拒绝其名称

运行时/配置写入器接受市场插件所用名称中的 `:`。内置 JSON schema 的 `propertyNames` pattern 当前不接受；这是 schema 与运行时之间的不匹配，而不是连接失败。

### 某个配置文件被静默地排除在列表之外

格式错误的 JSON 或缺失/无效的服务器映射会使该提供方无法从该文件提供任何条目；根据提供方的不同，OMP 会记录一条发现警告或记录解析失败，而不是使整个会话失败。请修正 JSON 结构，然后运行 `/mcp reload` 和 `/mcp list`。

## 参考资料

- MCP 传输规范：https://modelcontextprotocol.io/specification/2025-03-26/basic/transports
- Filesystem 服务器包：https://www.npmjs.com/package/@modelcontextprotocol/server-filesystem
- GitHub MCP 服务器：https://github.com/github/github-mcp-server
- Slack MCP 服务器文档：https://docs.slack.dev/ai/slack-mcp-server/
