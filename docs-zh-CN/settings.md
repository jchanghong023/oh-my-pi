# 设置

`omp` 从内置默认值、持久化全局配置文件、可选的本地项目配置、一次性 CLI 覆盖层和内存中的运行时覆盖中解析设置。当某个代码仓库需要与全局默认值不同的 provider 集合、模型角色、工具策略、记忆后端或 UI 行为时，可使用项目设置——而不必改动机器级配置。

设置以纯 YAML 映射形式存储。每个键及其类型、默认值和枚举值都来自设置 schema。`omp config` 暴露完整的 schema；交互式 `/settings` 面板暴露带有 UI 元数据的 schema 条目。

- 关于模型/provider 凭据、`.env` 文件以及解析 API 密钥的环境变量表，请参阅 [Providers](./providers.md)。
- 关于 `models.yml` 中的自定义模型定义，请参阅 [Models](./models.md)。
- 关于发现到 agent 上下文中的指令文件（`AGENTS.md`、`.omp/` 等），请参阅 [上下文文件](./context-files.md)。
- 关于环境变量的完整目录，请参阅 [环境变量](./environment-variables.md)。
- 关于激活专用逐轮行为的提示词，请参阅 [Magic keywords](./magic-keywords.md)。

## 设置存储位置

| 作用域            | 路径                                                  | 读取行为                                                                                                                                 | 写入行为                                                                                                                                                                         |
| ----------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 全局              | `~/.omp/agent/config.yml` (or existing `config.yaml`) | 主持久化设置文件。`config.yml` 是规范的写入目标；已有的 `config.yaml` 会被就地加载并更新。                                               | `/settings`、`omp config set` 和 `omp config reset` 写入此处。                                                                                                                   |
| 全局遗留          | `~/.omp/agent/settings.json`                          | 仅在两个主 YAML 文件名都不存在时，迁移进 `config.yml`，只执行一次。                                                                      | 迁移后不再写入；原文件被重命名为 `settings.json.bak`。                                                                                                                           |
| 项目              | `<cwd>/.omp/config.yml` (plus `.omp/settings.json`)   | 当进程工作目录中存在非空 `.omp/` 时加载。                                                                                                | 设置命令不会写入任意项目键。当 `modelRoleStorage: project` 时，模型选择器的角色分配只更新此处的 `modelRoles`；其他键请手动编辑。                                                |
| 项目遗留          | `<cwd>/.omp/settings.json`                            | 仍会读取；项目 `config.yml` 会合并在其之上。                                                                                             | 设置命令不会写入。                                                                                                                                                               |
| CLI 覆盖层        | 通过 `--config <file>` 传入的任意文件                 | 在全局和项目设置之后加载，仅对该进程生效。可重复传入。                                                                                   | 永不持久化。                                                                                                                                                                     |
| 运行时覆盖        | 仅内存中                                              | 由专用 CLI 标志（`--model`、`--approval-mode`、…）和功能环境变量设置。                                                                   | 永不持久化。                                                                                                                                                                     |

`PI_CODING_AGENT_DIR` 可重定位 `~/.omp/agent` 基础目录。设置它后，全局 `config.yml`、认证存储（`agent.db`）以及 agent 目录下的其他所有内容都会随其移动。使用 `omp config path` 打印当前生效的 agent 目录。

原生项目设置有意识地限定在进程工作目录的 `.omp/` 文件夹——设置发现**不会**向上遍历祖先目录寻找最近的 `.omp/`。其他发现 provider（Claude、Codex、Gemini、Cursor、OpenCode）也可以从各自的文件贡献项目级设置；对 `omp` 设置命令而言这些是只读的，且可以按 provider id 关闭（参见 [Provider 与来源禁用](#provider-与来源禁用)）。

## 配置文件格式

规范的全局文件是 YAML 格式的 `config.yml`；`config.yaml` 作为兼容文件名也被接受。用于其他文件（例如 `models.yml`）的通用配置加载器接受 `.yml`、`.yaml`、`.json` 和 `.jsonc`：

- 当请求 `.yml`/`.yaml` 路径而同目录下只存在 `.json` 时，会自动迁移为 YAML（幂等，每个进程一次）。
- `.json` 和 `.jsonc` 配置按原样读取，不做迁移。
- 顶层不是映射的设置 YAML 文件无效。在可写启动时，`omp` 会把无效的持久化设置文件移动为唯一命名的 `.broken-*` 备份，并带着原始错误和备份路径退出。仅包含裸数组/标量的 `--config` 覆盖层同样是硬错误，但不会被移动。

## 读取和写入设置

在会话内使用交互式 `/settings` 面板，或在 shell 中使用 `omp config` 命令。两者读取的都是合并后的生效设置。普通的持久化写入落在**全局**文件中；当 `modelRoleStorage: project` 时，模型选择器的角色变更是例外（参见 [写入位置](#写入位置)）。

```bash
omp config list                 # all settings with current effective values
omp config list --json          # same, machine-readable
omp config get theme.dark       # one value
omp config get theme.dark --json
omp config set compaction.enabled false
omp config set defaultThinkingLevel medium
omp config reset steeringMode   # restore a key to its schema default
omp config path                 # print the active agent directory
```

对于希望在正常启动时看到完整首次运行动画的用户，设置 `startup.showSplash`：

```bash
omp config set startup.showSplash true
```

这仅控制启动 splash 动画。它不会重新运行设置向导，也不会改变设置状态，并且 `startup.quiet: true` 仍会抑制包括 splash 在内的所有启动界面元素。

### 子命令

| 命令                           | 效果                                                                                                                                                                                                                                                                                              |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `omp config list`              | 打印按标签页分组的每个设置，及其当前值和类型。`--json` 输出一个以设置路径为键、值为 `{ value, type, description }` 的对象。已配置的凭据字段在人类可读输出中会被掩码为 `********`；在 JSON 中其 `value` 被省略并输出 `redacted: true`。                                                            |
| `omp config get <key>`         | 打印某个键的生效值。未知键会以非零状态退出。`--json` 输出 `{ key, value, type, description }`。这是显式的单键请求，因此凭据值会以未掩码形式返回。                                                                                                                                                 |
| `omp config set <key> <value>` | 按该键的 schema 类型解析 `<value>`，并写入全局主 YAML 文件。                                                                                                                                                                                                                                      |
| `omp config reset <key>`       | 把该键的 schema **默认值**写回全局配置（这会持久化默认值，而不是删除该键）。                                                                                                                                                                                                                      |
| `omp config path`              | 打印当前生效的 agent 目录（遵循 `PI_CODING_AGENT_DIR`）。                                                                                                                                                                                                                                         |
| `omp config init-xdg`          | 在 Linux 和 macOS 上，在生效的 XDG data、state 和 cache 主目录下创建 `omp` 目录。它不会移动已有文件，也不会设置 XDG 环境变量。其他平台以非零状态退出。                                                                                                                                            |

不带子命令、带 `--help` 或 `-h` 的 `omp config` 会列出设置。`list`、`get`、`set` 和 `reset` 都接受 `--json` 标志。

### 值解析

`omp config set` 会根据目标键的 schema 类型解析值字符串。字符串会先被去除首尾空白。

| 类型    | 接受的输入                                          | 备注                                                              |
| ------- | --------------------------------------------------- | ----------------------------------------------------------------- |
| boolean | `true`, `false`, `yes`, `no`, `on`, `off`, `1`, `0` | 不区分大小写。其他任何值都会被拒绝。                              |
| number  | 任意有限 JavaScript 数字                            | `Infinity`/`NaN` 会被拒绝。                                       |
| enum    | 该键允许的取值之一                                  | 必须精确匹配；错误信息会列出有效值。                              |
| array   | 一个 JSON 数组                                      | 例如 `'["anthropic","openai"]'`。必须能解析且为数组。             |
| record  | 一个 JSON 对象                                      | 例如 `'{"bash":"prompt"}'`。必须能解析且为非数组对象。            |
| string  | 按给定值存储（去除首尾空白）                        | 多个单词的值以空格连接。                                          |

键必须与真实的 schema 路径精确匹配。没有简写——应设置 `theme.dark`，而不是 `theme`。

### 写入位置

`omp config set`、`omp config reset`、`/settings` 以及普通的运行时设置变更，都会写入当前生效 agent 目录下的全局主 YAML 文件。它们不会把任意键写入 `<cwd>/.omp/config.yml`。唯一受支持的项目写入路径是当 `modelRoleStorage` 为 `project` 时的模型选择器角色分配；它只更新 `<cwd>/.omp/config.yml` 中的该角色，缺失的项目角色仍会回退到全局角色。要创建任何其他项目本地覆盖，请直接编辑项目文件（参见 [项目本地配置](#项目本地配置)）。保存会去抖动，并在锁保护下重新读取文件，因此会话打开期间所做的外部编辑会被保留。

## 优先级

从最低到最高优先级，某个设置的生效值按如下顺序构建：

```text
built-in defaults  <-  global config  <-  project config  <-  CLI overlays  <-  runtime overrides
```

从最高到最低：

1. **运行时覆盖** — 为当前进程在内存中应用的专用 CLI 标志和功能环境变量：`--model`、`--smol`、`--slow`、`--plan`、`--approval-mode`、`--auto-approve`/`--yolo`、`--hide-thinking`、`--advisor`、`--no-pty`、`--api-key` 以及协议模式默认值。永不持久化。
2. **CLI 配置覆盖层** — 每个 `--config <file>`；靠后的覆盖文件会覆盖靠前的。
3. **项目设置** — 先是 `<cwd>/.omp/settings.json`，然后是 `<cwd>/.omp/config.yml`（以及项目级其他发现 provider 的贡献）。
4. **全局设置** — `~/.omp/agent/config.yml`。
5. **内置默认值** — 来自设置 schema。

在每一层都未设置的键，在读取时会解析为其 schema 默认值。

### 环境变量覆盖

环境变量**不是**一个单一的设置层。每个变量都由拥有该值的功能读取，通常作为按机器的覆盖或回退，且永远不会写回 `config.yml`。以下变量直接映射到某个设置：

| 环境变量                | 覆盖的设置                  | 备注                                                                                              |
| ----------------------- | --------------------------- | ------------------------------------------------------------------------------------------------- |
| `PI_SMOL_MODEL`         | `modelRoles.smol`           | 也通过 `--smol` 暴露。                                                                            |
| `PI_SLOW_MODEL`         | `modelRoles.slow`           | 也通过 `--slow` 暴露。                                                                            |
| `PI_PLAN_MODEL`         | `modelRoles.plan`           | 也通过 `--plan` 暴露。                                                                            |
| `PI_NO_PTY=1`           | （禁用 PTY bash）           | 对该进程等同于 `--no-pty`。                                                                       |
| `PI_PY`                 | `eval.py`                   | `PI_PY=0` 禁用 Python eval 后端。                                                                 |
| `PI_JS`                 | `eval.js`                   | `PI_JS=0` 禁用 JavaScript eval 后端。                                                             |
| `PI_TINY_DEVICE`        | `providers.tinyModelDevice` | 本地 tiny 模型的 ONNX 执行 provider 或 `mlx` 后端。                                               |
| `PI_TINY_DTYPE`         | `providers.tinyModelDtype`  | 本地 tiny 模型的 ONNX 精度。                                                                      |
| `OMP_AUTH_BROKER_URL`   | `auth.broker.url`           | 环境变量值优先于配置。                                                                            |
| `OMP_AUTH_BROKER_TOKEN` | `auth.broker.token`         | 环境变量值优先于配置。                                                                            |
| `PI_CODING_AGENT_DIR`   | （重定位 agent 目录）       | 移动 `config.yml`、`agent.db` 以及整个 agent 基础目录。                                           |
| `PI_CONFIG_FILES`       | CLI 配置覆盖层              | 平台路径列表（Unix 上用 `:`，Windows 上用 `;`）；文件按顺序在 `--config` 覆盖层之前加载。         |

Provider API 密钥单独解析（存储的认证、OAuth、`models.yml`、环境以及 `.env` 文件）；参见 [Providers](./providers.md) 和完整的 [环境变量](./environment-variables.md) 参考。

## 合并规则

各层通过深度合并组合：

- **对象会深度合并** — 只存在于较低层的键会被保留；同时存在于较高层的键会覆盖。
- **标量和数组会被较高优先级的层整体替换**。较高层的数组不会追加到较低层的数组上。

点分设置路径请使用嵌套的 YAML 映射：

```yaml
theme:
  dark: titanium
  light: light

tools:
  approvalMode: write
  approval:
    bash: prompt
    read: allow
```

### Bash 命令审批模式

`tools.approval` 是一个以工具名为键的 record；诸如 `tools.approval.eval` 和 `tools.approval.computer` 这样的点分形式标识的是该 record 中的条目，而不是独立的设置 schema 路径。每个条目设置该工具的默认策略。对于 bash，可以用 `bash.patterns` 添加有序的命令规则；第一条匹配的规则生效。模式支持字面文本以及作为通配符的 `*`。

默认情况下，`allow` 规则必须匹配整条命令，且无法批准复合命令行。设置 `bash.allowCompoundCommands: true` 后，还会对仅由 `&&` 连接的两个或更多字面命令组成的保守链进行求值：

```yaml
tools:
  approvalMode: write
  approval:
    bash: allow

bash:
  allowCompoundCommands: true
  patterns:
    - match: "rm -f *"
      approval: allow
```

使用此配置，`cmp tmp/result.json artifacts/result.json && rm -f tmp/result.json` 可以在无需提示的情况下运行。OMP 会针对每个原始分段独立解析有序规则：`rm` 被显式允许，而未匹配的 `cmp` 分段则继承常规的独立 bash 策略。当任一分段未匹配时，该命令保留 `exec` 层级且没有显式策略，因此通用解析器会应用 `tools.approval.bash`，之后是当前激活的审批模式。因此，未匹配的分段只有当该工具级策略或模式要求时才会触发提示。

显式限制会沿整条链保守地合并：解析出的 `deny` 优先，否则解析出的 `prompt` 优先。匹配整条链但不匹配任何单个分段的 `deny` 或 `prompt` 规则仍构成整链限制（例如 `cmp * && rm *`）。所有匹配的整链限制都会被考虑：靠后的整链 `deny` 会覆盖靠前的整链 `prompt`。除此之外，分段规则保留首个匹配的顺序：在求值 `git status && git status` 时，靠前的 `git status` allow 不会被靠后的 `git *` deny 覆盖。

因此，当靠前的窄范围分段 allow 位于宽泛的兜底 deny 之前时，启用该设置可能放行默认策略原本拒绝的复合命令。请把必须始终生效的分段 deny 放在与之重叠的 allow 之前。

该可选功能只接受参数为字面量（包括带引号的字面量参数）的扁平 `&&` 链。它会拒绝展开、变量赋值、其他控制流、重定向、通配、换行、畸形语法，以及诸如 `cd`、`source` 和 `eval` 这类改变 shell 状态的命令。被拒绝的形式保持遗留审批行为；启用该设置绝不会扩大 `allow` 模式可批准的非链式命令范围。显式的整链和分段限制在现有的原始与规范化关键命令检查之前解析，后者仍会检查整条命令和每个分段，因此宽泛的 allow 无法隐藏靠后的关键分段。

该可选功能要求明确识别出采用 POSIX 引号规则的 shell：`sh`、`bash`、`dash`、`ash`、`ksh` 或 `zsh`，包括它们的 `.exe` 名称。集中式分类器会跨 Windows 和 POSIX 路径检查可执行文件名。其他 shell（包括 cmd、PowerShell、fish 以及未知包装器）保留遗留审批行为。它们的引号规则可能与识别器不同：fish 会把单引号内的 `\'` 视为转义引号，而 POSIX shell 不会。

有效的规则审批值为 `allow`、`prompt` 和 `deny`。无论是否启用该可选功能，`deny` 和 `prompt` 规则都可以匹配整条命令，或匹配其他复合形式分词后的分段（按 `&&`、`||`、`;`、`|`、单个 `&`、子 shell 和换行分割）。这使得 `match: "rm -rf *"` 能够拒绝 `cd /tmp && rm -rf build` 和 `sleep 1 & rm -rf build`。

`bash.patterns` 是审批策略，而非隔离手段。被允许的程序仍拥有 bash 进程的文件系统、网络和子进程访问权限；看似范围很窄的程序也可能通过自身的选项或配置执行更广泛的操作。这些规则仅约束 `bash` 工具；它们不覆盖通过 `eval` 启动的 shell。要封堵这条路径，请同时添加 `tools.approval.eval` 策略（`prompt` 或 `deny`）；参见 [工具审批模式](./approval-mode.md)。

### Bash 拦截器模式

`bashInterceptor` 与 `bash.patterns` 相互独立：它把 Bash 命令重定向到专用工具，而不是定义命令是否可以执行。需显式启用，并配置带有替换工具和面向模型的消息的正则表达式模式：

```yaml
bashInterceptor:
  enabled: true
  patterns:
    - pattern: '^\s*(cat|head|tail)\s+'
      tool: read
      message: "Use the read tool instead."
```

指定的替换工具必须在当前会话中可用，否则拦截器不会阻止该 Bash 调用。关于权限策略与专用工具路由的详细比较（包括复合命令行为与顺序），请参阅 [Bash 工具文档](tools/bash.md#命令策略与专用工具路由)。

### 示例：全局与项目

```yaml
# ~/.omp/agent/config.yml
tools:
  approvalMode: write
  approval:
    bash: prompt
    read: allow
disabledProviders:
  - anthropic
  - openai
  - google

# <repo>/.omp/config.yml
tools:
  approval:
    bash: allow
disabledProviders:
  - groq
```

在 `<repo>` 内的生效设置：

```yaml
tools:
  approvalMode: write # kept from global (object deep-merge)
  approval:
    bash: allow # overridden by project
    read: allow # kept from global
disabledProviders:
  - groq # project array REPLACES the global array
```

数组替换是最常见的意外：项目的 `disabledProviders` 不会扩展全局列表——它会成为该项目完整的列表。`enabledModels`、`cycleOrder`、`extensions` 以及所有其他数组类型设置同理。

## 项目本地配置

当某个代码仓库需要自己的设置时，创建 `<repo>/.omp/config.yml`：

```yaml
# <repo>/.omp/config.yml
modelRoles:
  default: anthropic/claude-sonnet-4-5
  smol: openai/gpt-4.1-mini
  slow: anthropic/claude-opus-4-5:high

tools:
  approvalMode: write
  approval:
    bash: prompt

compaction:
  methodOrder: [snapcompact, remote, soft]
  thresholdPercent: 80

theme:
  dark: titanium
```

除非仓库策略允许，否则不要把机密放进已提交的项目配置。凭据应优先使用环境变量、存储的认证、auth broker 或未被跟踪的 `--config` 覆盖层。

### 一次性覆盖

对于不应持久化的临时层，使用 `--config`：

```bash
omp --config ./local/ci-settings.yml "check this failure"
omp --config ./base.yml --config ./experiment.yml "try this model"
```

默认启动命令、`acp` 和 `models` 都接受 `--config`。

包装器也可以改为把 `PI_CONFIG_FILES` 设为平台分隔的路径列表（Unix 上用 `:`，Windows 上用 `;`）。环境覆盖层按列出的顺序在显式的 `--config` 覆盖层之前加载。

覆盖层路径相对于进程工作目录解析（并且会展开 `~`）。每个覆盖层都必须解析为 YAML 映射；文件缺失、YAML 无效或顶层为数组/标量都是硬错误——它**不会**静默回退到较低优先级的设置。

## 按路径作用域的数组

有三个数组设置——`enabledModels`、`enabledProviders` 和 `disabledProviders`——除了裸字符串外还接受路径作用域条目，因此单个全局配置可以在不同目录表现不同：

```yaml
enabledModels:
  - claude-sonnet-4-5 # applies everywhere
  - path: ~/work/high-context
    models:
      - anthropic/claude-opus-4-5

disabledProviders:
  - ollama # applies everywhere
  - paths:
      - ~/projects/sensitive
      - ~/clients/acme
    providers:
      - anthropic
      - openai
```

裸字符串条目在任何位置都生效。当当前工作目录**就是**配置的路径或**位于其下**时，作用域条目生效。`~` 展开为你的主目录，相对路径会在匹配前解析。

接受的 **path** 键（可任意组合）：`path`、`paths`、`pathPrefix`、`pathPrefixes`。

接受的 **value** 键：

- `models`（用于 `enabledModels`）或 `providers`（用于 `enabledProviders` 和 `disabledProviders`）
- `values` 或 `items`（适用于任何设置）

只保留字符串值；格式错误的作用域条目会被忽略。路径作用域在层合并**之后**解析，因此读取的是最终生效的数组。

## Provider 与来源禁用

`enabledProviders` 让外部的用户级配置来源加入发现。其默认值为空，因此在列出其 provider id（或列出 `*`/`all`）之前，来自 Cursor、Codex、Claude、Claude marketplace 插件、Gemini、OpenCode、Windsurf 和 GitHub 的用户根目录不会加载。项目根目录保持启用。原生 OMP 根目录——包括注册在 `~/.omp/plugins` 下的 marketplace 插件——不属于外部来源，无需条目。

`disabledProviders` 是一个共享的单一 id 命名空间，在任何凭据检查之前对两个不同子系统进行管控：

| 条目类型          | 示例 id                                                                            | 效果                                                                                                                                                           |
| ----------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 模型 provider     | `anthropic`, `openai`, `google`, `groq`, `ollama`, `openrouter`                    | 从模型选择中移除这些后端，即使凭据可用也是如此。参见 [Providers](./providers.md)。                                                                             |
| 发现来源          | `native`, `claude`, `codex`, `gemini`, `github`, `opencode`, `cursor`, `agents-md` | 阻止该来源贡献上下文文件、MCP 服务器、命令、skill、hook、工具、提示词或设置。参见 [上下文文件](./context-files.md)。                                            |

大多数 provider 控制场景列出的是模型 provider id。禁用 `claude` 发现来源与禁用 `anthropic` 模型 provider 不同——前者停止 Claude 格式的配置发现，后者停止 Anthropic 模型后端。

由于数组是替换而非追加，设置了 `disabledProviders` 的项目必须列出完整的期望集合：

```yaml
# ~/.omp/agent/config.yml
disabledProviders:
  - anthropic
  - openai

# <repo>/.omp/config.yml — inside this repo ONLY groq is disabled
disabledProviders:
  - groq
```

默认值为空数组（不禁止任何内容）。关于两个子系统的 provider id 与顺序，参见 [Providers](./providers.md) 和 [上下文文件](./context-files.md)。

## 设置目录

下面的目录只列出一部分常用设置，并非完整 schema。`omp config list` 是每个键、当前值、类型和描述的权威参考。此处显示的默认值和枚举值来自 schema。凡是接受环境变量或标志覆盖的设置都会注明；这些覆盖只作用于当前进程，不会被持久化。

### 模型

`modelRoles`、`modelTags` 和 `cycleOrder` 共同定义了你可以在其间切换的模型。角色值可以带思考后缀（`:minimal`、`:low`、`:medium`、`:high`、`:xhigh`、`:max`）。

```yaml
modelRoles:
  default: anthropic/claude-sonnet-4-5
  smol: openai/gpt-4.1-mini
  slow: anthropic/claude-opus-4-5:high
  vision: google/gemini-3.1-pro-preview
  plan: anthropic/claude-opus-4-5
  advisor: anthropic/claude-sonnet-4-5:medium

cycleOrder:
  - smol
  - default
  - slow

modelProviderOrder:
  - anthropic
  - openai

enabledModels:
  - claude-sonnet-4-5
```

| 键                     | 类型    | 默认值                      | 备注                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------------------- | ------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `modelRoles`           | record  | `{}`                        | 角色名 -> 模型 id 的映射。内置角色：`default`、`smol`、`slow`、`vision`、`plan`、`commit`、`tiny`、`task`、`advisor`。`tiny` 角色会为轻量后台任务（标题、记忆、自动思考、意外停止）覆盖在线模型，否则使用 `@smol`。按角色的环境变量/标志只对 `--model`/`--smol`/`--slow`/`--plan` 存在；请用 `modelRoles.advisor` 配置顾问。 |
| `modelRoleStorage`     | enum    | `global`                    | `global` 会把模型选择器的角色分配保存在当前生效的全局/profile 配置中；`project` 只把这些角色分配保存到 `<cwd>/.omp/config.yml`。缺失的项目角色会回退到全局角色。                                                                                                                                                                                                     |
| `modelTags`            | record  | `{}`                        | 自定义角色/标签元数据；可以引入额外的角色。                                                                                                                                                                                                                                                                                                                                                        |
| `modelProviderOrder`   | array   | `[]`                        | 当模型 id 有歧义时的首选提供方顺序。                                                                                                                                                                                                                                                                                                                                                           |
| `cycleOrder`           | array   | `["smol","default","slow"]` | 模型切换器循环切换的角色。                                                                                                                                                                                                                                                                                                                                                                              |
| `enabledModels`        | array   | `[]`                        | 模型允许列表；支持[路径作用域条目](#按路径作用域的数组)。为空表示所有可用模型。                                                                                                                                                                                                                                                                                                     |
| `enabledProviders`     | array   | `[]`                        | 要加载的外部用户级发现来源；支持路径作用域条目。参见[上文](#provider-与来源禁用)。                                                                                                                                                                                                                                                                                          |
| `disabledProviders`    | array   | `[]`                        | 禁用的模型/发现提供方；支持路径作用域条目。参见[上文](#provider-与来源禁用)。                                                                                                                                                                                                                                                                                                   |
| `includeModelInPrompt` | boolean | `true`                      | 在系统提示词中包含当前生效的模型名称。                                                                                                                                                                                                                                                                                                                                                              |

`models.yml` 的 schema 和自定义提供方定义参见 [模型](./models.md)。

### 顾问

顾问是第二个模型，它会审查每一轮已完成的交互，并能向主会话注入建议。用 `modelRoles.advisor` 指定模型，然后用 `advisor.enabled`、`/advisor on`，或以 `--advisor` 标志启动来启用它。

运行时行为、`WATCHDOG.md` 发现和有界追赶语义参见 [Advisor 和 WATCHDOG.md](./advisor-watchdog.md)。

| 键                    | 类型    | 默认值  | 备注                                                                                                                                                |
| --------------------- | ------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `advisor.enabled`     | boolean | `false` | 当 `modelRoles.advisor` 解析到可用模型时启用顾问运行时。                                                                                                 |
| `task.agentAdvisor`   | record  | `{}`    | 按代理的子代理顾问：代理名 → `"on"` / `"off"` / 顾问模型模式。覆盖代理 frontmatter 中的 `advisor`；在 `/agents` hub 中配置。 |
| `advisor.syncBacklog` | enum    | `off`   | 顾问有界追赶延迟：`off`、`1`、`3` 或 `5`。只有当顾问积压达到或超过该阈值时，主代理才最多等待 30 秒。 |
| `advisor.immuneTurns` | number  | `3`     | 在 `concern`/`blocker` 中断之后的这么多已完成主轮次内，把进一步的 concern/blocker 作为不中断的旁注传递。            |
| `advisor.maxNotesPerUpdate` | number | `4` | 每次顾问审查接受的非 blocker 备注数量，取值 1–32。严重程度更高的备注只能替换同一次审查中仍待处理的备注。`WATCHDOG.yml` 的顶层值或按顾问的值会覆盖此默认值。 |

### 思考

```yaml
defaultThinkingLevel: high
hideThinkingBlock: false
thinkingBudgets:
  minimal: 1024
  low: 2048
  medium: 8192
  high: 16384
  xhigh: 32768
  max: 32768
```

| 键                                | 类型    | 默认值  | 取值                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --------------------------------- | ------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `defaultThinkingLevel`            | enum    | `high`  | `minimal`、`low`、`medium`、`high`、`xhigh`、`max`、`auto`。可用 `--thinking` 按运行覆盖。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `hideThinkingBlock`               | boolean | `false` | 在输出中隐藏思考块。`--hide-thinking` 会为本次运行设置它（仅影响显示）。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `thinkingBudgets.minimal`         | number  | `1024`  | `minimal` 级别的 token 预算。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `thinkingBudgets.low`             | number  | `2048`  | `low` 的 token 预算。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `thinkingBudgets.medium`          | number  | `8192`  | `medium` 的 token 预算。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `thinkingBudgets.high`            | number  | `16384` | `high` 的 token 预算。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `thinkingBudgets.xhigh`           | number  | `32768` | `xhigh` 的 token 预算。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `thinkingBudgets.max`             | number  | `32768` | `max` 的 token 预算。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `providers.autoThinkingMaxEffort` | enum    | `xhigh` | `defaultThinkingLevel: auto` 可以解析到的最高 effort。`xhigh` 让分类器始终比最高档低一级，因此只有 `ultrathink` 能达到 `max`；`max` 则允许分类器在暴露最高档的模型上按最高档计费。无论哪种情况，本地设备端分类器都仍以上限 `xhigh` 封顶。这决定了 `auto` 能_解析_出什么：若某个模型的阶梯在封顶之下没有任何档位，它就完全拿不到自动级别；而元数据要求显式 effort 的模型仍会从传输层收到其支持的最低 effort —— 在 `["max"]` 阶梯上那就是 `max`，因为该模型不接受其他值。 |

### 采样

值为 `-1` 表示「使用提供方/模型默认值」—— `omp` 不会发送该参数。

| 键                  | 类型   | 默认值    | 备注                                                                                                                                                                                                                                                                          |
| ------------------- | ------ | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `temperature`       | number | `-1`      | 采样温度。                                                                                                                                                                                                                                                          |
| `topP`              | number | `-1`      | 核采样。                                                                                                                                                                                                                                                              |
| `topK`              | number | `-1`      | Top-K 采样。                                                                                                                                                                                                                                                                |
| `minP`              | number | `-1`      | 最小概率截断。                                                                                                                                                                                                                                                    |
| `presencePenalty`   | number | `-1`      | 存在惩罚。                                                                                                                                                                                                                                                              |
| `repetitionPenalty` | number | `-1`      | 重复惩罚。                                                                                                                                                                                                                                                            |
| `textVerbosity`     | enum   | `medium`  | `low`、`medium`、`high`。由 OpenAI Responses 和 Codex 传输层作为响应详细程度发送。                                                                                                                                                                                  |
| `tier.openai`       | enum   | `none`    | `none`、`auto`、`default`、`flex`、`scale`、`priority`。对 OpenAI / OpenAI-Codex 以及 OpenAI 系的 OpenRouter 模型以 `service_tier` 发送。用 `--service-tier <value>` 启动可对 OpenAI 做单次会话覆盖；该标志不会被持久化（`none` 会省略 `service_tier`）。 |
| `tier.anthropic`    | enum   | `none`    | `none`、`priority`。`priority` 会在受支持的直连 Claude 模型上启用 fast mode（在 Bedrock/Vertex 上以及通过 OpenRouter 时被忽略）。                                                                                                                                            |
| `tier.google`       | enum   | `none`    | `none`、`flex`、`priority`。Gemini API 在请求体中发送它；Vertex 通过请求头发送 `priority`（`flex` 在 Vertex 上无效）。                                                                                                                                                 |
| `tier.subagent`     | enum   | `inherit` | `inherit`、`none`、`auto`、`default`、`flex`、`scale`、`priority`。作用于所派生模型所属的家族；`inherit` 跟随主代理。                                                                                                                                     |
| `task.agentServiceTierOverrides` | record | `{}` | 针对 task/eval 派生的代理的稀疏精确名称覆盖（Vibe worker 保留 `tier.subagent`）。取值：`inherit`、`none`、`auto`、`default`、`flex`、`scale`、`priority`。条目会覆盖 `tier.subagent`；具体值只有在解析出的模型所属提供方家族支持时才生效。非映射值会导致设置加载失败。 |
| `tier.advisor`      | enum   | `none`    | `inherit`、`none`、`auto`、`default`、`flex`、`scale`、`priority`。作用于顾问模型所属的家族。                                                                                                                                                                      |
| `personality`       | enum   | `default` | `default`、`friendly`、`pragmatic`、`none`。用户级的 `<agent dir>/PERSONALITY.md` 会替换所选预设的文本；`none` 仍然会省略该块。参见 [system-prompt-customization](./system-prompt-customization.md)。                                                  |

### 重试和回退

```yaml
retry:
  enabled: true
  maxRetries: 10
  baseDelayMs: 500
  maxDelayMs: 300000
  modelFallback: true
  fallbackRevertPolicy: cooldown-expiry
  fallbackChains:
    # Any role without an explicit chain inherits the "default" chain.
    default:
      - anthropic/claude-opus-4-5
      - openai/gpt-5.5
      - google/gemini-3-pro
    # Per-role chains override the default (roles from `modelRoles`,
    # including custom roles). Selectors accept an optional thinking
    # suffix, e.g. openai/gpt-5.5:low.
    smol:
      - openai/gpt-5.5-mini
      - anthropic/claude-haiku-4-5
    # Model-selector keys (any key containing "/") attach the chain to the
    # model itself: it applies whenever that model is active, no matter
    # which role it is assigned to, and survives role reassignment.
    google/gemini-3-pro:
      - google-vertex/gemini-3-pro
    # A `provider/*` KEY covers every model of a provider — current or
    # future. A `provider/*` ENTRY keeps the failing model's id and swaps
    # the provider: google-antigravity/x -> google/x -> google-vertex/x.
    # Ids missing on the target provider are skipped (near-miss ids resolve
    # fuzzily); exact model keys override the wildcard for a specific model.
    google-antigravity/*:
      - google/*
      - google-vertex/*

providers:
  anthropic:
    serverSideFallback: false
```

| 键                                       | 类型    | 默认值            | 备注                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------------------- | ------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `retry.enabled`                          | boolean | `true`            | 重试暂时性的提供方错误。                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `retry.maxRetries`                       | number  | `10`              | 每个请求的最大重试次数。                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `retry.baseDelayMs`                      | number  | `500`             | 初始退避。                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `retry.maxDelayMs`                       | number  | `300000`          | 退避上限（5 分钟）。当没有凭据或模型回退成功时，提供方声明的、长于该值的等待会快速失败而不是继续休眠；`0` 会禁用该上限（以便在提供方声明的配额重置后自动恢复）。                                                                                                                                                                                                                                                                                                                  |
| `retry.modelFallback`                    | boolean | `true`            | 当某个模型不可用时回退到另一个模型。在线自动思考分类和会话标题（tiny/smol/commit）也会使用它。为 `false` 时，这些后台任务只尝试其第一个可解析的角色模型，不会跳到其他角色或已配置的回退模型。                                                                                                                                                                                                                                                          |
| `retry.fallbackChains`                   | record  | `{}`              | 把角色、模型选择器或 `provider/*` 通配符映射到有序的回退选择器。含 `/` 的键以模型为导向，并优先于角色：`provider/model-id` 匹配该确切模型，`provider/*` 匹配该提供方的每个模型。`provider/*` _条目_ 会保留失败模型的 id 并替换提供方。`default` 链覆盖所有没有自己的链的已分配角色。未知的模型/提供方或格式错误的链会在启动时报告为配置警告。 |
| `retry.fallbackRevertPolicy`             | enum    | `cooldown-expiry` | `cooldown-expiry` 会在主模型的抑制窗口结束后回到主模型；`never` 会一直留在回退模型上，直到手动切换。                                                                                                                                                                                                                                                                                                                                                     |
| `providers.anthropic.serverSideFallback` | boolean | `false`           | 选择启用 Anthropic 的 `server-side-fallback-2026-06-01` beta。只有使用 `anthropic-messages` API 对 Claude Fable 或 Mythos 模型的直连 `anthropic` 提供方请求符合条件。在 Anthropic 安全分类器拦截时，提供方可以用 `claude-opus-4-8` 在服务端重试；其他所有提供方、API 和模型都不受影响。                                                                                                                                          |
| `providers.openai-codex.codeMode`           | enum    | `off`             | 针对 `code_mode_only` 模型（GPT-5.6 Sol/Terra/Luna）的 Codex Code Mode，与 codex-rs 保持一致：直接工具面收缩为 `eval`/`ask`/`todo`，其他所有会话工具都通过其 `tool.<name>()` 桥从 `eval` 单元中调用，从而把多步工具工作压缩为一次模型往返。`auto` 跟随模型目录的 `tool_mode` 标志；`on` 对任何 Codex 模型强制启用；`off`（默认）保留完整的直接工具面。启用期间，轮次元数据会携带 codex-rs 的 `tool_namespaces_info` 暴露快照。 |
| `providers.openai-codex.codeModeDirectTools` | array   | `[]`              | Codex Code Mode 激活时，除 `eval`/`ask`/`todo` 之外额外保持可直接调用的工具名；会话中未启用的条目会被忽略。 |

当当前生效的模型持续失败（429、配额墙、提供方故障）且 `retry.modelFallback` 打开时，会话会按特指程度选择拥有该失败模型的链：先是精确的 `provider/model-id` 键，然后是 `provider/*` 通配符，再是当前角色的链，最后是 `default`。如果多个角色分配了同一个模型，yaml 键顺序不起决定作用：当前实时会话的角色优先；当会话不在那些角色上时，`default` 优先于其他匹配角色。它会跳过选择器仍在冷却中的模型，并在本轮剩余时间切换过去。当子代理的代理定义列出多个模型模式时，它们会获得自己按派生计算的链 —— 第一个可解析的模式是主模型，其余成为其回退；`fallbackChains` 中没有 `agent:<name>` 键。

### 工具和审批

```yaml
tools:
  format: auto
  approvalMode: yolo # default
  approval:
    bash: prompt
    edit: allow
  maxTimeout: 0
  intentTracing: true
```

| 键                             | 类型    | 默认值  | 备注                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------ | ------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tools.format`                 | enum    | `auto`  | 工具线上格式：`auto`、`native`、`glm`、`hermes`、`kimi`、`xml`、`anthropic`、`deepseek`、`harmony`、`qwen3`、`gemini`、`gemma` 或 `minimax`。`native` 始终使用提供方原生工具调用。`auto` 也使用原生调用，除非所选模型显式设置了 `supportsTools: false`；此时它会选择该模型家族自有的方言，在没有已知的特定家族方言时回退到 GLM。其他取值会强制使用那个自有带内方言。`xml` 是[通用 XML 格式](./toolconv/xml.md)；`minimax` 是 [MiniMax 格式](./toolconv/minimax.md)。在会话启动时生效。参见 [GLM](./toolconv/glm-4.5.md)、[Qwen3/Hermes](./toolconv/qwen3.md)、[Kimi](./toolconv/kimi-k2.md)、[Anthropic](./toolconv/anthropic.md)、[DeepSeek](./toolconv/deepseek.md)、[Harmony](./toolconv/harmony.md)、[Gemini](./toolconv/gemini.md) 和 [Gemma](./toolconv/gemma.md)。 |
| `tools.approvalMode`           | enum    | `yolo`  | `always-ask`（自动批准只读）、`write`（自动批准读取 + 工作区写入）、`yolo`（自动批准所有层级）。`--approval-mode` 和 `--auto-approve`/`--yolo` 可按运行覆盖。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `tools.approval`               | record  | `{}`    | 按工具名索引的每工具策略；每个取值为 `allow`、`deny` 或 `prompt`。例如 `omp config set tools.approval '{"bash":"prompt"}'`。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `tools.maxTimeout`             | number  | `0`     | 工具的最长运行时间（秒）；`0` = 不设上限。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `tools.intentTracing`          | boolean | `true`  | 记录每次调用的意图字符串。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `tools.outputMaxColumns`       | number  | `768`   | 流式输出的每行字节上限；`0` 禁用。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `tools.artifactSpillThreshold` | number  | `50`    | 工具输出超过该 KB 数时溢出为工件。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `tools.artifactHeadBytes`      | number  | `20`    | 溢出时内联保留的头部 KB 数；`0` = 仅保留尾部。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `tools.artifactTailBytes`      | number  | `20`    | 溢出时内联保留的尾部 KB 数。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `tools.artifactTailLines`      | number  | `500`   | 溢出时内联保留的尾部最大行数。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

各个内置工具和 Eval 预置项由各自的键开关，例如 `bash.enabled`、`launch.enabled`、`eval.py`、`eval.js`、`glob.enabled`、`grep.enabled`、`fetch.enabled`、`browser.enabled`、`computer.enabled`、`astEdit.enabled`、`astGrep.enabled` 和 `web_search.enabled`。图像提问使用 `read <image>?q=<question>`，并遵循 `images.questionTimeoutMs`。

### 窗口作用域的计算机使用

默认禁用的 `computer` Eval 预置项通过原生 OS API 捕获并控制真实的宿主窗口。窗口句柄可以在不聚焦应用、不移动真实指针的情况下隔离一个应用；`desktop` 对象保留所选显示器的合成与全局输入行为。它与 `browser` Eval 预置项相互独立，后者管理 Chromium/CDP 标签页和结构化的页面自动化。

```yaml
computer:
  enabled: true
  display: all
  maxWidth: 3840
  maxHeight: 2400
```

| 键                   | 类型    | 默认值  | 备注                                                                                                                                                                                                                                                        |
| -------------------- | ------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `computer.enabled`   | boolean | `false` | 启用可感知窗口的 `computer` Eval 预置项；`/computer` 斜杠命令只会为当前会话切换它。                                                                        |
| `computer.display`   | string  | `all`   | 只控制 `desktop` 目标：合成所有活动显示器，或使用一个数字显示器 ID。                                                                                                                                                            |
| `computer.maxWidth`  | number  | `3840`  | 合成截图的最大宽度（像素）。无法保留原始细节的图像传输通道（包括 GitHub Copilot Responses 和 xAI OAuth）会把有效宽度上限定为 `1280`；Claude 系列模型作为兼容回退也使用同一上限。 |
| `computer.maxHeight` | number  | `2400`  | 合成截图的最大高度（像素）。那些坐标安全的传输通道会把有效高度上限定为 `896`；其他模型保留配置的限制。                                                                                                 |

计算机设置和当前生效模型的坐标安全图像限制会在每次调用时读取；对设置文件的修改需要新建会话，而运行时的设置变更会在下一次调用时生效。直接使用 `computer` 辅助方法，以及传给 `computer.run(fnOrCode, options)` 的代码，都通过桌面根对象或 `window(...)` 选择目标。切换目标会使先前的坐标帧失效，因此在指针输入前请先捕获新目标。在启用输入之前，请配置 `tools.approvalMode` 或 `tools.approval.computer` 并授予平台权限。参见[窗口作用域的计算机使用](computer-use.md)。

### Shell、eval 和 LSP

```yaml
bash:
  enabled: true
  allowCompoundCommands: false
  autoBackground:
    enabled: true
    thresholdMs: 60000

eval:
  py: true
  js: true

python:
  kernelMode: session # session, per-call
  interpreter: ""

lsp:
  enabled: true
  lazy: true
  diagnosticsOnWrite: true
  diagnosticsOnEdit: false
  formatOnWrite: false
```

| 键                                | 类型    | 默认值    | 备注                                                                                                                                                       |
| --------------------------------- | ------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bash.enabled`                    | boolean | `true`    | 启用 bash 工具。                                                                                                                                       |
| `bash.allowCompoundCommands`      | boolean | `false`   | 按段评估扁平的字面 `&&` 链；未匹配的段继承常规 bash 审批策略与模式。                                            |
| `launch.enabled`                  | boolean | `true`    | 启用用于共享的长时间运行项目进程的 launch 工具。                                                                                           |
| `bash.autoBackground.enabled`     | boolean | `true`    | 自动把长时间运行的命令转入后台。                                                                                                                      |
| `bash.autoBackground.thresholdMs` | number  | `60000`   | 自动转入后台的阈值。                                                                                                                        |
| `eval.py`                         | boolean | `true`    | Python eval 后端。`PI_PY=0` 会为该进程禁用它。                                                                                                    |
| `eval.js`                         | boolean | `true`    | JavaScript eval 后端。`PI_JS=0` 会为该进程禁用它。                                                                                                |
| `eval.tools.enabled`              | boolean | `true`    | 把内核定义的 `@tool` / `tool(fn)` 函数暴露给 `task`、`agent()` 和 `workpool()` 子代理。                                                      |
| `eval.workpool.freshAgents`       | boolean | `false`   | 为每个条目派生新的 workpool 代理，而不是复用空闲 worker 或批量处理排队条目。                                                        |
| `python.kernelMode`               | enum    | `session` | `session`（持久内核）或 `per-call`。                                                                                                                |
| `python.interpreter`              | string  | `""`      | Python 解释器路径；为空 = 自动检测。                                                                                                          |
| `lsp.enabled`                     | boolean | `true`    | 语言服务器集成。`--no-lsp` 会为本次运行禁用它。                                                                                               |
| `lsp.lazy`                        | boolean | `true`    | 按需启动服务器。                                                                                                                                    |
| `lsp.shared`                      | boolean | `true`    | 通过守护进程 broker 让本地 `omp` 进程共享每个项目的一个语言服务器；broker 不可用时回退到私有服务器。 |
| `lsp.diagnosticsOnWrite`          | boolean | `true`    | 写入后运行诊断。                                                                                                                              |
| `lsp.diagnosticsOnEdit`           | boolean | `false`   | 编辑后运行诊断。                                                                                                                              |
| `lsp.formatOnWrite`               | boolean | `false`   | 写入时格式化文件。                                                                                                                                      |
| `lsp.diagnosticsDeduplicate`      | boolean | `true`    | 合并重复的诊断。                                                                                                                             |
| `shellPath`                       | string  | _(unset)_ | 覆盖 bash 使用的 shell 二进制文件。                                                                                                                     |

### 文件：编辑和读取

```yaml
edit:
  mode: hashline # apply_patch, hashline, patch, replace
  fuzzyMatch: true
  fuzzyThreshold: 0.95
  blockAutoGenerated: true
  blackbox:
    enabled: false

read:
  defaultLimit: 300
  toolResultPreview: false
  summarize:
    enabled: true
    prose: false
```

| 键                        | 类型    | 默认值     | 备注                                             |
| ------------------------- | ------- | ---------- | ------------------------------------------------- |
| `edit.mode`               | enum    | `hashline` | `apply_patch`、`hashline`、`patch`、`replace`。    |
| `edit.fuzzyMatch`         | boolean | `true`     | 允许模糊锚点匹配。                      |
| `edit.fuzzyThreshold`     | number  | `0.95`     | 模糊匹配的相似度阈值。          |
| `edit.blockAutoGenerated` | boolean | `true`     | 拒绝编辑生成文件/类锁文件。     |
| `edit.streamingAbort`     | boolean | `false`    | 流式编辑不匹配时中止。                 |
| `edit.blackbox.enabled`   | boolean | `false`    | 在 AST 解析回归时追加完整源码。      |
| `read.defaultLimit`       | number  | `300`      | 调用 `read` 未提供选择器时的默认行数。 |
| `read.summarize.enabled`  | boolean | `true`     | 对代码读取提供结构化摘要。              |
| `read.summarize.prose`    | boolean | `false`    | 也对散文类文件生成摘要。                        |
| `read.toolResultPreview`  | boolean | `false`    | 工具结果的内联预览。                   |
| `readLineNumbers`         | boolean | `false`    | 显示普通行号。                          |

### 上下文、压缩和内存

`/extended-context on` 选择启用更大的上下文窗口；`/extended-context off` 恢复标准窗口和溢价定价上限。对于 `openai-codex/gpt-6-astra` 及其 `-wm` 路由，关闭时使用 272,000 token，开启时使用文档记载的 922,000 token 输入窗口（总计 1.05M 上下文、128K 输出），或发现到的更高最大值。人工整理出的该最大值会修正过时的偏低探测值。`models.yml` 中显式的按模型 `contextWindow` 覆盖在两种模式下都优先；如果你希望由该开关控制某个模型，请移除对应覆盖。在 `openai-codex` 上，显式覆盖仍会被裁剪到服务器认可的上限（`min(override, maximum)`，与 Codex 的 `model_context_window` 一致），因此它无法突破文档记载的最大值。

压缩余量与这个选择启用项是分开的。在默认 15% 预留下，Astra 文档记载的扩展窗口对应的自动压缩阈值是 783,700 token。即使没有额外的长上下文定价倍率，更大的窗口也可能消耗更多用量。

```yaml
extendedContext: false

contextPromotion:
  enabled: false

compaction:
  enabled: true
  methodOrder: [remote, snapcompact, handoff, shake, soft]
  midTurnEnabled: true # check thresholds between tool-loop provider requests
  thresholdPercent: -1 # -1 = default reserve-based behavior
  thresholdTokens: -1 # fixed token limit when > 0
memory:
  backend: off # off, local, hindsight, mnemopi
```

| 键                            | 类型    | 默认值                                   | 备注                                                                                                                                                                                                                                     |
| ----------------------------- | ------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `extendedContext` | boolean | `false` | 选择启用更大的模型窗口；`/extended-context on`、`off` 或 `status`。 |
| `contextPromotion.enabled`    | boolean | `false`                                  | 在上下文溢出时提升为当前生效模型显式配置的 `contextPromotionTarget`。                                                                                                                                                      |
| `compaction.enabled`          | boolean | `true`                                   | 自动对话压缩。                                                                                                                                                                                                        |
| `compaction.asyncEnabled`     | boolean | `true`                                   | 当上下文接近压缩阈值时，在后台投机性地生成摘要，并在跨过阈值时把已就绪的结果拼接进来。                                                                                        |
| `compaction.midTurnEnabled`   | boolean | `true`                                   | 在下一个提供方请求之前，于安全的轮次中途工具循环边界检查阈值。                                                                                                                                                  |
| `compaction.methodOrder`      | array   | `remote, snapcompact, handoff, shake, soft` | 有序回退。`remote` 使用提供方原生的服务端压缩（OpenAI Responses compact、Anthropic compaction beta）；不可用或失败的方法会向下推进。 |
| `compaction.thresholdPercent` | number  | `-1`                                     | 按上下文百分比触发；`-1` = 基于预留的默认行为。                                                                                                                                                                                 |
| `compaction.thresholdTokens`  | number  | `-1`                                     | 当 `> 0` 时按固定 token 数触发。                                                                                                                                                                                                           |
| `compaction.reserveTokens`    | number  | _(unset)_                                | 绝对预留下限。未设置时，有效预留取 `16384` 与上下文窗口 15% 中的较大者；如果该默认值会导致小窗口下没有实际可用的预算，则回退为 15% 预留。                         |
| `compaction.keepRecentTokens` | number  | `20000`                                  | 始终保留的近期 token。                                                                                                                                                                                                           |
| `compaction.autoContinue`     | boolean | `true`                                   | 压缩后自动继续。                                                                                                                                                                                                  |
| `memory.backend`              | enum    | `off`                                    | `off`、`local`、`hindsight`、`mnemopi`。每个后端都有自己的 `hindsight.*` / `mnemopi.*` / `memories.*` 调优键。                                                                                                                  |
| `autolearn.enabled`           | boolean | `false`       | 实验性：代理停止后，提示它把经验教训记录到记忆，并在 `~/.omp/agent/managed-skills` 下创建/增强隔离的托管技能。启用 `manage_skill` 工具（以及在记忆后端处于活动状态时的 `learn`）。 |
| `autolearn.autoContinue`      | boolean | `false`       | 当 `autolearn.enabled` 时，在停止时自动运行一次捕获轮次（会消耗额外 token）。关闭 = 被动提醒会搭载在你的下一轮上。                                                                                                           |
| `autolearn.minToolCalls`      | number  | `5`           | 仅在一轮中至少使用了这么多工具之后才提示。                                                                                                                                                                               |

`compaction` 还有其他调优键（空闲压缩、取代/丢弃启发式），可在 `omp config list` 中看到。完整策略参考参见 [压缩](./compaction.md)。

### 外观和终端

```yaml
theme:
  dark: titanium
  light: light
symbolPreset: unicode # unicode, nerd, ascii
colorBlindMode: false

statusLine:
  preset: default # default, minimal, compact, full, nerd, ascii, custom
  separator: powerline-thin
  transparent: false
  showHookStatus: true

terminal:
  showImages: true
images:
  autoResize: true
  blockImages: false
tui:
  hyperlinks: auto # off, auto, always
```

| 键                          | 类型    | 默认值           | 取值                                                                    |
| --------------------------- | ------- | ---------------- | ------------------------------------------------------------------------- |
| `theme.dark`                | string  | `titanium`       | 在深色终端背景上使用的主题。                                 |
| `theme.light`               | string  | `light`          | 在浅色终端背景上使用的主题。                                |
| `symbolPreset`              | enum    | `unicode`        | `unicode`、`nerd`、`ascii`。                                               |
| `colorBlindMode`            | boolean | `false`          | diff 新增内容使用蓝色代替绿色。                             |
| `showHardwareCursor`        | boolean | `true`           | 显示终端硬件光标。                                        |
| `statusLine.preset`         | enum    | `default`        | `default`、`minimal`、`compact`、`full`、`nerd`、`ascii`、`custom`。       |
| `statusLine.separator`      | enum    | `powerline-thin` | `powerline`、`powerline-thin`、`slash`、`pipe`、`block`、`none`、`ascii`。 |
| `statusLine.sessionAccent`  | boolean | `true`           | 用会话颜色给编辑器边框着色。                            |
| `statusLine.transparent`    | boolean | `false`          | 状态栏使用终端背景。                          |
| `statusLine.showHookStatus` | boolean | `true`           | 显示钩子状态消息。                                                |
| `terminal.showImages`       | boolean | `true`           | 内联渲染图像（当终端支持时）。                     |
| `images.autoResize`         | boolean | `true`           | 为兼容模型而调整大尺寸图像。                              |
| `images.blockImages`        | boolean | `false`          | 永不向提供方发送图像。                                           |
| `tui.hyperlinks`            | enum    | `auto`           | `off`、`auto`、`always`。                                                  |
| `tui.mouse`                 | boolean | `false`          | 在主会话中捕获鼠标点击，使实时子代理卡片和 HUD 行在点击时聚焦，并在目标上显示悬停高亮。开启时，原生文本选择变为 Shift+拖拽，滚轮滚动变为 Shift+滚轮。 |
| `display.pinnedAgents`      | enum    | `collapsed`      | 编辑器上方的固定实时代理跳转列表：`off` 隐藏它，`collapsed` 显示几行并带展开器，`full` 列出全部。 |
| `tui.resizeScrollback`      | enum    | `rebuild`        | 宽度变化稳定后如何刷新保留在终端回滚区中的转录行：`append` 在保留的历史之下以新宽度重放转录，`rebuild` 清除窗格回滚区后重放一份当前宽度的副本，`preserve` 只重绘视口。 |

要使用自定义状态栏，请设置 `statusLine.preset: custom`，并配置 `statusLine.leftSegments`、`statusLine.rightSegments` 和 `statusLine.segmentOptions`。在任一片段列表中包含 `status`，即可渲染通过 `ctx.ui.setStatus()` 注册的扩展状态；它们按键排序并内联拼接。设置 `statusLine.showHookStatus: false` 可在页脚中抑制这些相同的状态。

`cost` 片段显示已记录的会话成本。对于采用分时定价的当前生效提供方/模型，它会在高峰时段附加 `↑`、在非高峰时段附加 `↓`，并在时段边界刷新 —— 即使处于空闲状态也是如此。箭头反映的是当前费率，而不是过去的花费；固定价格模型和显式成本覆盖不会显示箭头。UTC 时段表和估算语义参见[使用成本与基于时间的定价](models.md#使用成本与基于时间的定价)。

### 交互

| 键                     | 类型    | 默认值          | 取值                                                                                                  |
| ---------------------- | ------- | --------------- | ------------------------------------------------------------------------------------------------------- |
| `steeringMode`         | enum    | `one-at-a-time` | `all`、`one-at-a-time`。排队的引导消息如何投递。                                     |
| `followUpMode`         | enum    | `one-at-a-time` | `all`、`one-at-a-time`。                                                                                 |
| `interruptMode`        | enum    | `immediate`     | `immediate`、`wait`。                                                                                    |
| `doubleEscapeAction`   | enum    | `rewind`          | `rewind`、`none`。                                                                               |
| `autoResume`           | boolean | `false`         | 自动恢复 cwd 中最近的会话。                                                         |
| `plan.enabled`         | boolean | `true`          | 启用计划模式。                                                                                       |
| `plan.defaultOnStartup` | boolean | `false`         | 在启用计划模式时，让每个新的交互式会话都以计划模式启动。Print/JSON（`--print`）模式会忽略它并打印一条提示；无头计划流程请使用 `--plan-yolo`。 |
| `ask.timeout`          | number  | `0`             | `ask` 提示超时前的秒数；`0` = 不超时。 |
| `ask.notify`           | enum    | `on`            | `on`、`off`。                                                                                            |
| `magicKeywords.enabled` | boolean | `true`          | 启用四个魔法关键词的隐藏通知。                                                                          |
| `magicKeywords.ultrathink` | boolean | `true`       | 启用独立 `ultrathink` 通知及最高自动思考覆盖。                                                          |
| `magicKeywords.orchestrate` | boolean | `true`      | 启用独立 `orchestrate` 多智能体通知。                                                                    |
| `magicKeywords.workflow` | boolean | `true`         | 启用独立 `workflowz` eval 工作流通知。                                                                   |
| `magicKeywords.fullsend` | boolean | `true`         | 启用不受成本/token 限制的最快验证执行；仅当委派带来实际速度或验证收益时才使用委派。                      |

四个关键词斜杠命令均接受可选任务文本：`/ultrathink [task]`、`/orchestrate [task]`、`/workflowz [task]` 和 `/fullsend [task]`。

### 提供方和服务

```yaml
providers:
  webSearchOrder: [perplexity, exa, gemini]
  imageOrder: [openai, xai]
  fetch: auto
  webSearchGeminiModel: gemini-2.5-flash
  tinyModel: online
  tinyModelDevice: default
  tinyModelDtype: default
  openaiWebsockets: auto
  openrouterVariant: default
  kimiApiFormat: auto
  cacheRetention: auto
  maxInFlightRequests:
    anthropic: 2

provider:
  appendOnlyContext: auto # auto, on, off

exa:
  enabled: true
  searchDelayMs: 1000

searxng:
  endpoint: https://search.example.com
  token: SEARXNG_TOKEN
```

| 键                                  | 类型    | 默认值    | 取值 / 备注                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------------------- | ------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `providers.webSearchOrder`          | array   | `[]`      | 用于 `web_search` 的提供方 ID（按优先级排序）（`perplexity`、`gemini`、`anthropic`、`codex`、`xai`、`zai`、`exa`、`tinyfish`、`jina`、`kagi`、`tavily`、`firecrawl`、`brave`、`kimi`、`parallel`、`synthetic`、`ollama`、`searxng`、`startpage`、`duckduckgo`、`ecosia`、`google`、`mojeek`、`public`）。重复项和未知 ID 会被忽略；未列出的提供方之后保留其内置相对顺序。为空 = 使用内置顺序。取代已移除的 `providers.webSearch` 枚举（旧值会迁移到该列表开头）。 |
| `providers.webSearchExclude`        | array   | `[]`      | `web_search` 绝不能使用的搜索提供方 ID，即使作为回退也不行。接受与 `providers.webSearchOrder` 相同的提供方 ID。                                                                                                                                                                                                                                                                                              |
| `providers.webSearchTimeoutSeconds` | number  | `60`      | 在自动链推进到下一个回退之前，提供给每个 `web_search` 提供方传输通道的硬性超时（秒）。对较慢的模型驱动提供方请使用更大的值；大于 `300` 的值会被限制为五分钟。这不是整条链的截止时间，提供方特定的上游限制或聚合限制仍可能更短。                                                                                   |
| `providers.webSearchGeminiModel`    | string  | _(unset)_ | 当 `web_search` 使用 Gemini 时，用于 Google Search grounding 的 Gemini 模型 ID；默认为 `gemini-2.5-flash`，可由 `GEMINI_SEARCH_MODEL` 覆盖。                                                                                                                                                                                                                                                                                        |
| `providers.imageOrder`              | array   | `[]`      | 图像生成提供方 ID（按优先级排序）（`openai`、`openai-codex`、`antigravity`、`xai`、`gemini`、`openrouter`）。未列出的提供方跟随当前会话的提供方和内置顺序。取代已移除的 `providers.image` 枚举（旧值会迁移到该列表开头）。                                                                                                                                |
| `providers.fetch`                   | enum    | `auto`    | `auto`、`native`、`trafilatura`、`lynx`、`parallel`、`firecrawl`、`jina`。                                                                                                                                                                                                                                                                                                                                                              |
| `providers.judgmentProvider`        | enum    | `auto`    | 类型化判断（自动思考难度、Smart 意外停止检测、git AI 暂存）的首选后端。当存在 `TYPESAFE_API_KEY` 或 `/login typesafe` 凭据时，`auto` 使用 TypeSafe；失败的 TypeSafe 请求会依次回退到 `tiny`、`smol`、`default`，然后是当前会话模型。`llm` 跳过 TypeSafe；未选择 TypeSafe 时，功能配置的本地模型仍是直接后端。                                                                                                                       |
| `providers.tinyModel`               | enum    | `online`  | `online` 或本地模型（`lfm2.5-230m`、`lfm2.5-350m`、`falcon-h1-90m`）。                                                                                                                                                                                                                                                                                                                                                              |
| `providers.tinyModelDevice`         | enum    | `default` | 本地微小模型使用的 ONNX 执行提供方，或 `mlx`（Apple 芯片，经 mlx-lm）。由 `PI_TINY_DEVICE` 覆盖。                                                                                                                                                                                                                                                                                                                                                         |
| `providers.maxInFlightRequests`     | record  | `{}`      | 每个提供方对 LLM HTTP 请求的并发上限（正数），在使用同一配置根的本地 `omp` 进程之间共享。省略的提供方不受限制。`omp config set` 会拒绝非正数或非数值。                                                                                                                                                                                                          |
| `providers.tinyModelDtype`          | enum    | `default` | 本地微小模型的 ONNX 精度。由 `PI_TINY_DTYPE` 覆盖。                                                                                                                                                                                                                                                                                                                                                                   |
| `providers.openaiWebsockets`        | enum    | `auto`    | `auto`、`off`、`on`。                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `providers.openrouterVariant`       | enum    | `default` | `default`、`nitro`、`floor`、`online`、`exacto`。                                                                                                                                                                                                                                                                                                                                                                                       |
| `providers.kimiApiFormat`           | enum    | `auto`    | `auto`、`openai`、`anthropic`。`auto` 跟随实时的模型元数据。                                                                                                                                                                                                                                                                                                                                                                     |
| `providers.cacheRetention`          | enum    | `auto`    | `auto`、`short`、`long`、`none`。转发给支持它的提供方的提示词缓存保留策略。`auto` 保持提供方默认值（Anthropic：OAuth 订阅者会话使用 1h 条目，API key 使用 5m 条目加空闲 keep-alive 刷新）并遵循 `PI_CACHE_RETENTION`；`short` 强制 5m；`long` 在支持的地方使用 1h TTL 并禁用 keep-alive 刷新；`none` 禁用提示词缓存和缓存亲和路由。         |
| `provider.appendOnlyContext`        | enum    | `auto`    | `auto`、`on`、`off`。                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `exa.enabled`                       | boolean | `true`    | 启用 Exa 网络搜索提供方。                                                                                                                                                                                                                                                                                                                                                                                                    |
| `exa.searchDelayMs`                 | number  | `1000`    | Exa 网络搜索请求之间的最小延迟（毫秒）；设为 `0` 可禁用节流。                                                                                                                                                                                                                                                                                                                                               |
| `searxng.endpoint`                  | string  | _(unset)_ | SearXNG 实例 URL。                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `searxng.token`                     | string  | _(unset)_ | SearXNG token；还有 `searxng.basicUsername`/`searxng.basicPassword`/`searxng.categories`/`searxng.language`/`searxng.engines`（逗号分隔的引擎名或 bang 快捷方式，例如 `ddg, br, startpage`，作为 API 的 `engines=` 参数发送）/`searxng.safesearch`。                                                                                                                                                                                                                                                                                                 |
| `auth.broker.url`                   | string  | _(unset)_ | Auth-broker URL。由 `OMP_AUTH_BROKER_URL` 覆盖。                                                                                                                                                                                                                                                                                                                                                                                  |
| `auth.broker.token`                 | string  | _(unset)_ | Auth-broker token。由 `OMP_AUTH_BROKER_TOKEN` 覆盖。                                                                                                                                                                                                                                                                                                                                                                              |
| `secrets.enabled`                   | boolean | `false`   | 在向提供方发起请求之前，启用已配置的密钥混淆和内置的凭据形态 token 遮蔽。参见[密钥混淆](./secrets.md)。                                                                                                                                                                                                                                                                                  |

提供方凭据和自定义模型定义单独配置 —— 参见 [提供方](./providers.md) 和 [模型](./models.md)。

### 其他组

凡是在本目录中没有单独列表的 schema 路径，都明确以 `omp config list` 为准。其他组包括：

- 代理行为与安全：`ask.*`、`eval.*`、`features.*`、`goal.*`、`loop.*`、`model.loopGuard.*`、`model.toolCallLoopGuard.*`、`prewalk.*`、`recap.*`、`tools.*` 和 `vault.*`。
- 执行与内容：`commit.*`、`completion.*`、`edit.*`、`error.*`、`extensionHandlers.*`、`generate_image.*`、`git.*`、`images.*`、`live.*`、`paste.*`、`power.*`、`read.*`、`shellMinimizer.*`、`speech.*`、`terminal.*` 和 `title.*`。
- 界面与启动：`display.*`、`statusLine.*`、`startup.*`、`stt.*`、`tui.*` 和 `ttsr.*`。
- 未归组的键：`setupVersion`、`proseOnlyThinking`、`omitThinking`、`externalThinking`、`includeWorkspaceTree`、`autocompleteMaxVisible`、`emojiAutocomplete`、`disabledExtensions`、`inlineToolDescriptors` 和 `treeFilterMode`。

这些设置遵循上文中同样的 schema 定义的类型与默认值规则。

## 旧版迁移

`omp` 会自动迁移较旧的配置形态。这些都不需要你采取任何操作；列出它们是为了让你知道在 `config.yml` 中可能看到哪些变化。

### 启动时迁移到 `config.yml`

当 `~/.omp/agent/config.yml` 和兼容的 `config.yaml` 都不存在时，启动过程会从旧版来源构建一次权威的 `config.yml`，然后写入结果：

1. `~/.omp/agent/settings.json`（成功解析后重命名为 `settings.json.bak`）。
2. 持久化在 `agent.db` 中的设置。

只要两个主 YAML 文件中的任意一个存在，就不再查阅这些旧版来源。通用配置加载器还会在其他配置文件只存在 `.json` 形式时，执行 `.json` -> `.yml` 迁移。

### 字段级迁移

每当加载原始设置时都会应用（全局、项目、叠加层和运行时覆盖）：

| 旧                                                                       | 新                                                                                                           |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `inspect_image.enabled` / `inspect_image.mode`                           | 已移除                                                                                                      |
| `inspect_image.timeoutMs`                                                | `images.questionTimeoutMs`                                                                                   |
| `queueMode`                                                              | `steeringMode`                                                                                               |
| 扁平的 `theme: "<name>"` 字符串                                            | `theme.dark` / `theme.light`（槽位按亮度选择；内置的 `light`/`dark` 会被丢弃以使用默认值） |
| 旧版 `task.isolation.mode: none`                                       | `task.isolation.enabled: false`                                                                              |
| 旧版 `task.isolation.mode: <backend>`                                  | `task.isolation.enabled: true` + `isolation.backend: <backend>`                                              |
| `task.simple`                                                            | 已移除                                                                                                      |
| 旧版隔离后端（`worktree`、`fuse-overlay`、`fuse-projfs`）    | `rcopy`、`overlayfs`、`projfs`                                                                               |
| `lastChangelogVersion`                                                   | 移到标记文件并从 `config.yml` 中剥离                                                        |

## 故障排查

### 项目设置未生效

- 从包含 `.omp/config.yml` 的目录启动 `omp`。设置发现只检查当前工作目录的 `.omp/`，不检查祖先目录。
- 确保 `.omp/` 非空；空配置目录会被忽略。
- 确认该文件是合法 YAML，且其顶层是映射。
- 在该目录运行 `omp config get <key>` 查看生效值。
- 请记住 `--config` 叠加层和运行时标志会覆盖项目配置。

### 项目中全局数组消失

数组是替换，而不是追加。如果项目设置了 `disabledProviders`、`enabledModels`、`cycleOrder`、`extensions` 或任何其他数组，请在项目层中包含**完整**的期望值 —— 全局数组会被完全替换。

### 编辑配置后提供方仍然可用

- 检查你禁用的是一个模型提供方 id（例如 `anthropic`）还是一个发现来源 id（例如 `claude`）—— 它们是不同的命名空间，效果也不同。
- 检查是否有项目（或叠加层）的 `disabledProviders` 数组替换了你的全局数组。
- 凭据仍然可以来自环境变量、`.env`、OAuth、存储的认证或 `models.yml`；禁用提供方无论如何都会阻止选择，但请确认你编辑的是正确的层。参见[提供方](./providers.md)。
- 如果模型列表已经初始化，请重启会话。

### `omp config set` 写入了错误的文件

`omp config set` 和 `omp config reset` 始终写入当前代理目录下的全局 `config.yml`。运行 `omp config path` 可打印它的位置。对于项目本地设置，请直接编辑 `<repo>/.omp/config.yml`。

### `omp config reset` 未删除我的键

`reset` 会把 schema 的**默认**值写入全局配置 —— 它持久化默认值，而不是删除该键。要停止从全局配置覆盖某个项目值，请手动从 `~/.omp/agent/config.yml` 删除该键。

### 启动时 `--config` 覆盖失败

`--config` 文件是仅作用于当前进程的 YAML 映射。文件缺失、YAML 非法，或顶层是数组/标量，都是硬错误 —— 它不会静默回退到优先级更低的设置。请修正路径或内容。

### 环境变量覆盖了我的配置

有些设置（模型角色、eval 后端、微小模型设备/精度、认证 broker、PTY）可以被环境变量或 CLI 标志覆盖，以便按机器调整，且它们优先于 `config.yml`。取消设置该变量或去掉该标志，让持久化的值生效。参见[环境变量覆盖](#环境变量覆盖)和[环境变量](./environment-variables.md)。

### `omp config set <key>` 提示 "Unknown setting"

键必须与某个 schema 路径完全一致，不能使用简写。请使用 `theme.dark`，而不是 `theme`。运行 `omp config list` 查看所有有效的键。
