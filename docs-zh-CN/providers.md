# Providers

Provider 是 `omp` 可以把请求路由到的模型后端：Anthropic、OpenAI、Google Gemini、Groq、OpenRouter、Mistral、xAI、Ollama 这类本地引擎、托管网关、`models.yml` 中的自定义 provider，以及由扩展注册的 provider。

**provider** 是账户或后端命名空间，例如 `anthropic`、`openai`、`google` 或 `ollama`。**模型** 是该 provider 下的一个具体模型，以 `provider/model-id` 的形式选择，例如 `anthropic/claude-opus-4-6`。禁用一个 provider 会把它下面的所有模型从选择中移除；如果你只想收窄个别模型，请改用模型设置。

本页涵盖 provider 如何变为可用、凭据如何解析、provider/环境变量对照表、本地引擎、禁用 provider 以及自定义 provider。关于特定端点的请求、推理、工具、流、用量与重试约束，见 [provider 端点约束](./provider-endpoint-constraints.md)。关于模型选择与完整的 `models.yml` schema，见 [模型与 provider 配置](./models.md)。关于配置文件位置与合并优先级，见 [设置](./settings.md)。关于凭据存储与登录流程的深入说明，见 [密钥与凭据](./secrets.md)。关于完整的环境变量参考，见 [环境变量](./environment-variables.md)。关于本地引擎的安装，见 [本地模型](./local-models.md)。关于上下文文件发现 provider，见 [上下文文件](./context-files.md)。

## `omp` 如何判断 provider 是否可用

启动时，模型注册表按顺序从四个来源组装其目录：

1. 内置的模型目录（每个内置 provider 及其已知模型）。
2. 来自 `~/.omp/agent/models.yml` 的自定义 provider 与模型条目。
3. 支持发现的 provider 的运行时发现模型（本地引擎与启用发现的网关）。
4. 由扩展注册的 provider 与模型。

即使某个模型当前不可选，注册表也可以持有它。只有同时满足以下两个条件，模型才变为**可用**：

1. 其 provider ID **不在**生效的 `disabledProviders` 列表中；**并且**
2. 该 provider 要么**无需 key**（隐式的本地 provider，或带 `auth: none` 的自定义 provider），**要么**有可解析的凭据。

`disabledProviders` 会在凭据**之前**检查。如果某个 provider ID 被禁用，任何已存储的 key、OAuth 会话、环境变量、`.env` 条目或 `models.yml` 的 `apiKey` 都无法让它变为可选——无论凭据如何，该 provider 的模型都会从可用性中被移除。把该 ID 从生效列表中移除即可恢复它们。

无需 key 的本地引擎是一种特殊情况：未配置 key 时，`ollama`、`llama.cpp` 和 `lm-studio` 被视为无需 key，因此它们发现的模型在引擎一有响应时就可选——无需登录。见[内置本地引擎](#内置本地引擎)。

## 凭据与优先级

当 provider 需要 API key 时，`omp` 按以下顺序解析（先匹配者胜出）：

1. **运行时覆盖**：为当前进程提供的 key，例如 CLI 的 `--api-key`。永不持久化。
2. **`models.yml` 配置 key**：固定在自定义 provider 上的 `apiKey`，会注册为配置来源的 bearer。它会刻意优先于已存储的 OAuth，这样为自定义 `baseUrl` 或网关提供的 key 会被采用，而不是转发代理会拒绝的上游 OAuth token。
3. **已存储的 OAuth 凭据**：需要时刷新；多个账户会自动排序与轮换。对于 Anthropic 和 ChatGPT（Codex），每个组织或工作区都算作独立账户：一个邮箱如果同时持有 Team 或 Enterprise 席位与个人套餐，可以按订阅各登录一次（在浏览器同意页面上选择工作区），轮换时会把它们当作两个账户。
4. **来自登录的已存储 API key**：一次成功的 `/login` 所保存的 API-key 凭据。
5. **provider 环境变量**：包括从 `.env` 文件加载的值（见[环境变量表](#环境变量与-env-文件)）。
6. **其他已存储 API key**：例如由 broker 迁移过来的 key。这是最后手段，以便显式环境变量胜出。
7. **`models.yml` 回退解析器**：用于未以其他方式注册的自定义 provider 的 key。

已存储的凭据在本地认证模式下位于 `~/.omp/agent/agent.db` 的 auth store 中，在 broker 模式下则位于配置的 auth-broker snapshot 中。（`PI_CODING_AGENT_DIR` 会迁移 `~/.omp/agent` 基准目录，auth store 也随之移动。）

### OAuth 与 API key，以及 provider 作用域的登录

登录是**按 provider 划分作用域的**：认证 `anthropic` 不会认证 `openai`，每个 provider 各自跟踪自己的凭据。被禁用的 provider 即使有有效的已存储认证也保持禁用。

在会话内使用交互式斜杠命令：

- `/login` —— 打开 OAuth/key 选择器。`/login <provider>` 直接跳到某一个 provider（例如 `/login anthropic`）；对于需要粘贴回调的 OAuth 流程，运行 `/login <redirect-url>` 来完成它。
- `/logout` —— 打开 provider 选择器以移除已存储的凭据。

对于由共享 auth broker 支持的无头或远程环境，CLI 提供 `omp auth-broker login <provider>` / `omp auth-broker logout`（以及 `status`、`list`、`import`、`migrate`）。broker 模型见 [密钥与凭据](./secrets.md)。

当模型没有凭据时，`omp` 会提示你运行 `/login` 或设置该 provider 的环境变量。

对于 ClinePass，设置 `CLINE_API_KEY` 或运行 `/login cline-pass` 以打开 Cline 控制台并验证新建的 API key。OMP 会从 Cline 公开的 recommended-models 端点刷新成员资格，并捆绑当前十六个模型的名单以及 Cline 提供的限制、订阅定价、模态和逐模型推理控制，以供离线启动。新的实时 id 在重新生成之前仍然可选，此时使用保守的元数据，而不是猜测出来的控制项。`omp usage` 报告五小时、每周和每月的配额窗口。免费档模型标记为 `(free)`，同一个 key 可在任何 Cline 账户上使用；订阅模型显示与 API 等价的参考定价，而实际计费或折扣用量仍以流式网关上报的成本为准。请求会模仿 Cline CLI 客户端标头和稳定的每会话 task id，Qwen 路由使用 Cline 的 prompt-cache 形态，Qwen3.7 Plus 会把思考等级映射到网关的 token 预算字段。

### 在 `models.yml` 中固定一个 key

自定义 provider 的 `apiKey` 按**环境变量名或字面量**解析：如果该值命名了一个已存在的环境变量，就使用该变量的值；否则该字符串本身就是 key。在值前加 `!` 会把它作为 shell 命令运行，并使用裁剪后的 stdout（完整的取值语法见 [模型与 provider 配置](./models.md)）。

```yaml
# ~/.omp/agent/models.yml
providers:
  my-gateway:
    baseUrl: https://gateway.example.com/v1
    api: openai-completions
    apiKey: MY_GATEWAY_API_KEY # reads this env var if set, else literal text
    models:
      - id: claude-sonnet
        name: Claude Sonnet via Gateway
        contextWindow: 200000
        maxTokens: 8192
```

如果在自定义 provider 上设置了 `authHeader: true`，解析出的 key 会作为 `Authorization: Bearer <key>` 标头注入到对该 provider 的每个请求中。

## 环境变量与 `.env` 文件

每个 provider 都有一个或多个环境变量，用于在没有已存储凭据时提供 key。下表是经过验证的 provider → 变量对照表；完整目录很大，因此拆分为核心 provider 与其他托管 provider 两部分。由 OAuth 支持的 provider 除了 API key 之外（或代替 API key）还可以接受 token 变量。

### 核心 provider

| Provider ID      | 环境变量                                                                                                                                          |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `anthropic`      | `ANTHROPIC_OAUTH_TOKEN`，然后 `ANTHROPIC_API_KEY`（当 `CLAUDE_CODE_USE_FOUNDRY=true` 时，Foundry 模式优先使用 `ANTHROPIC_FOUNDRY_API_KEY`）       |
| `openai`         | `OPENAI_API_KEY`                                                                                                                                  |
| `openai-codex`   | `OPENAI_CODEX_OAUTH_TOKEN`                                                                                                                        |
| `google`         | `GEMINI_API_KEY`                                                                                                                                  |
| `google-vertex`  | `GOOGLE_CLOUD_API_KEY`，或 Application Default Credentials（`GOOGLE_APPLICATION_CREDENTIALS` + `GOOGLE_CLOUD_PROJECT` + `GOOGLE_CLOUD_LOCATION`） |
| `groq`           | `GROQ_API_KEY`                                                                                                                                    |
| `openrouter`     | `OPENROUTER_API_KEY`                                                                                                                              |
| `mistral`        | `MISTRAL_API_KEY`                                                                                                                                 |
| `xai`            | `XAI_API_KEY`                                                                                                                                     |
| `xai-oauth`      | `XAI_OAUTH_TOKEN`，然后 `XAI_API_KEY`                                                                                                             |
| `github-copilot` | `COPILOT_GITHUB_TOKEN`                                                                                                                            |
| `cursor`         | `CURSOR_ACCESS_TOKEN`                                                                                                                             |
| `azure`          | `AZURE_OPENAI_API_KEY`                                                                                                                            |
| `amazon-bedrock` | `AWS_PROFILE`，或 `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY`，或 ECS/IRSA 凭据链                                                               |

### 其他托管 provider

| Provider ID                      | 环境变量                                                                            |
| -------------------------------- | ----------------------------------------------------------------------------------- |
| `aiand`                          | `AIAND_API_KEY`                                                                     |
| `cerebras`                       | `CEREBRAS_API_KEY`                                                                  |
| `alibaba-token-plan`             | `ALIBABA_TOKEN_PLAN_API_KEY`，然后 `BAILIAN_TOKEN_PLAN_API_KEY`                     |
| `baseten`                        | `BASETEN_API_KEY`                                                                   |
| `bedrock-mantle`                 | `AWS_BEARER_TOKEN_BEDROCK`                                                          |
| `deepinfra`                      | `DEEPINFRA_API_KEY`                                                                 |
| `deepseek`                       | `DEEPSEEK_API_KEY`                                                                  |
| `siliconflow`                    | `SILICONFLOW_API_KEY`                                                               |
| `siliconflow-cn`                 | `SILICONFLOW_CN_API_KEY`                                                            |
| `fireworks`                      | `FIREWORKS_API_KEY`                                                                 |
| `together`                       | `TOGETHER_API_KEY`                                                                  |
| `coreweave`                      | `COREWEAVE_API_KEY`，然后 `WANDB_API_KEY`                                           |
| `nvidia`                         | `NVIDIA_API_KEY`                                                                    |
| `devin`                          | `DEVIN_API_KEY`                                                                     |
| `gmi-cloud`                      | `GMI_API_KEY`                                                                       |
| `huggingface`                    | `HUGGINGFACE_HUB_TOKEN`，然后 `HF_TOKEN`                                            |
| `moonshot`                       | `MOONSHOT_API_KEY`，然后 `KIMI_API_KEY`                                             |
| `meta`                           | `MODEL_API_KEY`，然后 `META_API_KEY`                                                |
| `nanogpt`                        | `NANO_GPT_API_KEY`                                                                  |
| `novita`                         | `NOVITA_API_KEY`                                                                    |
| `venice`                         | `VENICE_API_KEY`                                                                    |
| `vercel-ai-gateway`              | `AI_GATEWAY_API_KEY`（目录发现也可用 `VERCEL_AI_GATEWAY_API_KEY`）                  |
| `cloudflare-ai-gateway`          | `CLOUDFLARE_AI_GATEWAY_API_KEY` + `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_GATEWAY_ID` |
| `litellm`                        | `LITELLM_API_KEY`；代理端点可选用 `LITELLM_BASE_URL`                                |
| `kilo`                           | `KILO_API_KEY`                                                                      |
| `zai`                            | `ZAI_API_KEY`                                                                       |
| `zenmux`                         | `ZENMUX_API_KEY`                                                                    |
| `zhipu-coding-plan`              | `ZHIPU_API_KEY`                                                                     |
| `umans`                          | `UMANS_AI_CODING_PLAN_API_KEY`                                                      |
| `qianfan`                        | `QIANFAN_API_KEY`                                                                   |
| `qwen-portal`                    | `QWEN_OAUTH_TOKEN`，然后 `QWEN_PORTAL_API_KEY`                                      |
| `synthetic`                      | `SYNTHETIC_API_KEY`                                                                 |
| `minimax-code`                   | `MINIMAX_CODE_API_KEY`                                                              |
| `minimax-code-cn`                | `MINIMAX_CODE_CN_API_KEY`                                                           |
| `minimax`                        | `MINIMAX_API_KEY`                                                                   |
| `alibaba-coding-plan`            | `ALIBABA_CODING_PLAN_API_KEY`                                                       |
| `sakana`                         | `SAKANA_API_KEY`，然后 `FUGU_API_KEY`                                               |
| `aimlapi`                        | `AIMLAPI_API_KEY`                                                                   |
| `gitlab-duo`, `gitlab-duo-agent` | `GITLAB_TOKEN`                                                                      |
| `opencode-zen`, `opencode-go`    | `OPENCODE_API_KEY`                                                                  |
| `cline-pass`                     | `CLINE_API_KEY`                                                                     |
| `firepass`                       | `FIREPASS_API_KEY`                                                                  |
| `wafer-serverless`               | `WAFER_SERVERLESS_API_KEY`                                                          |
| `xiaomi`                         | `XIAOMI_API_KEY`                                                                    |
| `xiaomi-token-plan-ams`          | `XIAOMI_TOKEN_PLAN_AMS_API_KEY`                                                     |
| `xiaomi-token-plan-cn`           | `XIAOMI_TOKEN_PLAN_CN_API_KEY`                                                      |
| `xiaomi-token-plan-sgp`          | `XIAOMI_TOKEN_PLAN_SGP_API_KEY`                                                     |
| `ollama-cloud`                   | `OLLAMA_CLOUD_API_KEY`                                                              |
| `ollama`                         | `OLLAMA_API_KEY`（可选；本地发现默认无需 key）                                      |
| `lm-studio`                      | `LM_STUDIO_API_KEY`（可选；默认无需 key）                                           |
| `llama.cpp`                      | `LLAMA_CPP_API_KEY`（仅当服务器要求认证时）                                         |
| `vllm`                           | `VLLM_API_KEY`（未认证的本地服务器可选用）                                          |
| `yolo-auto`                      | `YOLO_AUTO_API_KEY`                                                                 |
| `charm-hyper`                    | `CHARM_HYPER_API_KEY`，然后 `HYPER_API_KEY`                                         |

`/login cloudflare-ai-gateway` 会提示输入 gateway token、Cloudflare account ID 和 gateway ID，然后把三者一起存储。要使用环境变量，请设置上面列出的全部三个值。OMP 会为每个模型选择 Anthropic、OpenAI 或 Workers AI 网关路由；你不需要在 `models.yml` 中覆盖 base URL。

`charm-hyper` 是 Charm 面向编码 agent 的 OpenAI 兼容推理网关。在 `https://hyper.charm.land/` 签发或管理 key；模型列表从该 provider 公开的 `/v1/models` 端点实时发现，并且 `HYPER_API_KEY` 可作为 `CHARM_HYPER_API_KEY` 的回退别名被接受。

由 OAuth 支持的 provider，例如 `anthropic`、`github-copilot`、`cursor`、`ollama-cloud`、`qwen-portal`、`kimi-code`、`xai-oauth`、`wafer-serverless`、`google-gemini-cli`、`google-antigravity`、`devin` 以及 GitLab provider（`gitlab-duo`、`gitlab-duo-agent`），通常通过 `/login` 而不是环境变量来接入。也存在交互式 API-key 登录：`/login baseten`、`/login coreweave` 和 `/login sakana` 会提示输入控制台/API key（`coreweave` 还需要 `COREWEAVE_PROJECT` 来构造 `OpenAI-Project` 标头）。此处未列出的搜索工具与配置变量见 [环境变量](./environment-variables.md)。

### `.env` 发现与优先级

`omp` 会在任何 provider 查找之前，先把 `.env` 文件急切加载到进程环境中。它会读取四个文件，对每个变量而言，**第一个**定义它的来源胜出。实际生效的优先级从高到低：

1. `omp` 继承的进程环境（已设置的变量总是胜出）。
2. `<cwd>/.env`
3. `~/.omp/agent/.env`
4. `~/.omp/.env`
5. `~/.env`

进程环境中已存在的变量永远不会被 `.env` 文件覆盖。在这些文件之间，`<cwd>/.env` 中设置的值优先于 `~/.omp/agent/.env`，后者优先于 `~/.omp/.env`，再优先于 `~/.env`。所以从 shell 导出的 `OPENAI_API_KEY` 胜过所有 `.env` 文件，而项目的 `<cwd>/.env` 胜过你主目录的 `~/.env`。

项目本地的 `.env` 是让某个仓库使用项目专属网关、key 或本地端点的最简单方式：

```dotenv
# <project>/.env
OPENROUTER_API_KEY=sk-or-...
OLLAMA_BASE_URL=http://127.0.0.1:11434
```

`.env` 的解析刻意保持最小化：

- 空行和以 `#` 开头的行会被忽略；
- 键必须匹配 `[A-Za-z_][A-Za-z0-9_]*`（shell 标识符形态）——其他名称会被丢弃；
- 值可以用单引号或双引号包裹，包裹符会被剥离；
- 包含 NUL 字节的值会被丢弃；
- 以 `OMP_` 为前缀的键还会镜像到对应的 `PI_` 前缀名称。

## 内置本地引擎

有三个本地引擎无需 `models.yml` 条目即可被自动发现。每个引擎都使用一个可被环境变量覆盖的 base URL：

| Provider ID | Base URL（环境变量覆盖 → 默认值）                                                | 备注                                          |
| ----------- | -------------------------------------------------------------------------------- | --------------------------------------------- |
| `ollama`    | `OLLAMA_BASE_URL`，然后 `OLLAMA_HOST`（已归一化），否则 `http://127.0.0.1:11434` | 默认无需 key。                                |
| `llama.cpp` | `LLAMA_CPP_BASE_URL`，否则 `http://127.0.0.1:8080`                               | 除非为 `llama.cpp` 存储了 key，否则无需 key。 |
| `lm-studio` | `LM_STUDIO_BASE_URL`，否则 `http://127.0.0.1:1234/v1`                            | 默认无需 key。                                |

以下情况下这些隐式引擎会被**跳过**：

- `models.yml` 中已经配置了相同 ID 的 provider（你的显式配置优先）；或
- 该 provider ID 出现在生效的 `disabledProviders` 列表中。

这些引擎的安装与运行见 [本地模型](./local-models.md)。

## 禁用模型 provider

使用 `disabledProviders` 设置可以把某个 provider 的模型从选择中移除：

```yaml
# ~/.omp/agent/config.yml or <project>/.omp/config.yml
disabledProviders:
  - anthropic
  - openai
  - google
  - groq
```

Provider ID 精确匹配。禁用 `google` 会隐藏 Google Gemini API provider；由 OAuth 支持的 Google provider `google-gemini-cli` 和 `google-antigravity` 是独立的 ID，必须分别禁用。禁用 `ollama`、`llama.cpp` 或 `lm-studio` 会停止该引擎的本地发现。

`disabledProviders` 统一适用于：

- 内置目录 provider；
- 自定义 `models.yml` provider；
- 运行时发现的 provider 模型；
- 扩展注册的 provider；
- 隐式本地引擎。

禁用一个 provider 不会删除其已存储的凭据——把它的 ID 从生效列表中移除即可重新启用它。

## 项目级别的 provider 控制

项目设置位于 `<project>/.omp/config.yml`。当某个仓库必须允许或隐藏与全局默认不同的 provider 集合时，就可以使用它们：

```yaml
# <project>/.omp/config.yml
disabledProviders:
  - openai
  - openrouter
```

设置数组会被更高优先级的层整体**替换**，而不是合并或追加。如果全局文件禁用了三个 provider 而项目文件只禁用了一个，项目内看到的就只有项目列表：

```yaml
# ~/.omp/agent/config.yml
disabledProviders:
  - anthropic
  - openai
  - google

# <project>/.omp/config.yml
disabledProviders:
  - groq
```

项目内实际生效的结果：

```json
["groq"]
```

项目数组会为该项目的会话重新启用 `anthropic`、`openai` 和 `google`。如果你想让项目在全局集合上_追加_，请在项目文件中重复全局的 ID。包含 `--config` 覆盖与运行时覆盖在内的完整优先级链见 [设置](./settings.md)。

## 路径作用域的 `disabledProviders`

`disabledProviders` 可以把普通字符串条目（处处生效）与路径作用域条目（仅当当前工作目录匹配配置的路径时才生效）混用：

```yaml
disabledProviders:
  - ollama
  - path: ~/projects/sensitive
    providers:
      - anthropic
      - openai
  - paths:
      - ~/work/client-a
      - ~/work/client-b
    values:
      - openrouter
```

- 裸字符串条目始终生效。
- 作用域条目在当前工作目录**就是**配置的路径或位于其**之下**时生效。`~` 展开为主目录。
- 接受的路径键：`path`、`paths`、`pathPrefix`、`pathPrefixes`。
- 接受的取值键：`providers`、`values`、`items`。

对于上面的示例：

- `ollama` 处处被禁用。
- `anthropic` 和 `openai` 在 `~/projects/sensitive` 下额外被禁用。
- `openrouter` 在 `~/work/client-a` 和 `~/work/client-b` 下额外被禁用。

路径作用域在设置合并**之后**解析。由于更高优先级的层会替换整个数组，项目级的 `disabledProviders` 数组会丢弃只存在于全局数组中的作用域条目。`enabledModels` 是唯一另一个支持相同路径作用域形式的设置。详见 [设置](./settings.md)。

## Provider ID 与发现 provider ID

`disabledProviders` 使用一个**共享的单一 ID 命名空间**，它同时管控两个不同的子系统：

- **模型 provider**——本页介绍的后端（`anthropic`、`openai`、`ollama`、自定义的 `models.yml` ID……）。禁用一个会将其模型从选择中移除。
- **发现 provider**——上下文文件、MCP 服务器、命令、skill、钩子、工具、提示词与设置的来源。禁用一个会阻止该来源贡献能力条目。

| 条目类型         | 示例                                                                          | 效果                                 |
| ---------------- | ----------------------------------------------------------------------------- | ------------------------------------ |
| 模型 provider ID | `anthropic`, `openai`, `google`, `groq`, `openrouter`, `ollama`, `my-gateway` | 把该 provider 的模型从可用性中移除。 |
| 发现 provider ID | `native`, `claude`, `codex`, `gemini`, `agents`, `github`                     | 阻止该发现来源贡献能力条目。         |

注意这些相关的名称。Google Gemini **API** 模型使用模型 provider ID `google`；`gemini` 是**发现** provider ID（读取 `GEMINI.md` 的来源），而不是 Google 模型 provider。只有当你打算禁用整个配置来源时，才使用发现 provider 的 ID。发现 provider 一侧见 [上下文文件](./context-files.md)。

## `models.yml` 中的自定义 provider

自定义 provider 位于 `~/.omp/agent/models.yml` 的 `providers:` 下。在那里定义的 provider ID 与内置 provider 参与相同的选择、凭据解析和 `disabledProviders` 规则。

最简 OpenAI 兼容 provider：

```yaml
providers:
  my-openai-compatible:
    baseUrl: https://api.example.com/v1
    api: openai-completions
    apiKey: MY_OPENAI_COMPATIBLE_KEY # env-var-name or literal
    models:
      - id: fast-chat
        name: Fast Chat
        contextWindow: 128000
        maxTokens: 8192
```

### Zhipu BigModel 账户余额 key

`/login zai` 面向全球的 Z.AI Coding Plan 端点，`/login zhipu-coding-plan` 面向国内的 Zhipu Coding Plan 端点。这两个流程都不会配置 `https://open.bigmodel.cn/api/paas/v4` 这个通用的按量付费 BigModel 端点。

对于从标准 BigModel 账户余额签发的 API key，请使用自定义 provider：

```yaml
providers:
  bigmodel:
    baseUrl: https://open.bigmodel.cn/api/paas/v4
    api: openai-completions
    apiKey: BIGMODEL_API_KEY
    models:
      - id: glm-4.6
        name: GLM-4.6 (BigModel)
```

在启动 `omp` 之前把 `BIGMODEL_API_KEY` 设为 `<id>.<secret>` 形式的 key，然后选择 `bigmodel/glm-4.6`。该 key 不使用 `sk-` 前缀。

无需 key 的本地 provider（不需要凭据）：

```yaml
providers:
  local-proxy:
    baseUrl: http://127.0.0.1:4000/v1
    api: openai-completions
    auth: none
    models:
      - id: local-model
        name: Local Model
        contextWindow: 32768
        maxTokens: 4096
```

启用发现的 provider（在运行时从端点获取模型）：

```yaml
providers:
  team-proxy:
    baseUrl: https://models.example.com/v1
    apiKey: TEAM_PROXY_API_KEY
    authHeader: true # send Authorization: Bearer <resolved key>
    disableStrictTools: true
    discovery:
      type: proxy
```

完整的 schema、所有允许的 `api` 取值、discovery 的 `type`、模型覆盖与等价性设置见 [模型与 provider 配置](./models.md)。

要禁用自定义 provider，请精确列出其 ID：

```yaml
disabledProviders:
  - my-openai-compatible
  - team-proxy
```

## 故障排查

**某个 provider 的模型不可选。** 确认该 provider 有凭据（`/login <provider>`、导出的环境变量，或 `models.yml` 的 `apiKey`），并且其 ID 不在生效的 `disabledProviders` 列表中。记住这条规则：未被禁用**并且**（无需 key**或**有凭据）。无需 key 的本地引擎只有在引擎确实在运行并有响应后才会出现。

**用错了 key（`.env` 里陈旧的 key）。** 解析顺序优先运行时 `--api-key`，然后是 `models.yml` 配置 key、已存储的 OAuth、`/login` 保存的 key、环境变量或 `.env`、其他已存储的 API key，最后是 `models.yml` 回退解析器。已设置的进程环境变量也胜过所有 `.env` 文件，并且 `<cwd>/.env` 胜过 `~/.env`。如果某个意外的 key 胜出，请检查导出的 shell 变量，并按优先级顺序检查四个 `.env` 文件，清除不应生效的那个。

**我已经禁用了某个 provider，但它仍然出现。** `disabledProviders` 数组是被替换而不是合并：项目的 `<project>/.omp/config.yml` 数组会完全覆盖全局数组。请核对你所在目录的_生效_列表（路径作用域条目只在配置路径处或其下生效），并确认 ID 拼写完全一致。用 `omp config get disabledProviders` 查看合并后的值（见 [设置](./settings.md)）。

**某个发现 provider 的名称对模型没有影响（或反之）。** ID 命名空间是共享的。`gemini`、`codex`、`claude`、`native` 和 `agents` 是发现来源 ID；Google 模型后端是 `google`。请确认你禁用的是正确类型的 provider。

**自定义 `models.yml` provider 无法加载。** YAML 或 schema 错误会让注册表跳过该自定义文件。用 `omp models` 验证该文件（用 `omp models find <substr>` 限定到某一个 provider）。带自定义 `models` 的 provider 需要 `baseUrl`、认证（`apiKey`，除非 `auth: none`），以及在 provider 层级或每个模型上的 `api`。没有模型的 provider 只要定义了至少一个受支持的覆盖项（`baseUrl`、`headers`、`apiKey`、`auth: none`、`compat`、`disableStrictTools`、`remoteCompaction`、`modelOverrides` 或 `discovery`）也是有效的。发现 provider 可以省略 `models`，但需要 provider 层级的 `api`，除非 `discovery.type` 为 `proxy`。显式的 `ollama`、`lm-studio` 或 `llama.cpp` 条目会有意替换该 ID 的内置发现。见 [模型与 provider 配置](./models.md)。
