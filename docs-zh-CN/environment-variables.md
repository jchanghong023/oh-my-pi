# 环境变量（当前运行时参考）

本参考源自以下代码路径：

- `packages/coding-agent/src/**`
- `packages/ai/src/**`（coding-agent 使用的 provider/auth 解析）
- `packages/utils/src/**` 和 `packages/tui/src/**` 中这些变量直接影响 coding-agent 运行时的部分

本文档仅记录当前生效的行为。

## 解析模型与优先级

大多数运行时查找使用来自 `@oh-my-pi/pi-utils`（`packages/utils/src/env.ts`）的 `$env`。

`$env` 加载顺序：

1. 已存在的进程环境（`Bun.env`）
2. 来自启动工作目录的项目 `.env`，仅针对当前值为空/未设置的键
3. 当前 agent 的 `.env`（通常为 `~/.omp/agent/.env`），仅针对当前值为空/未设置的键
4. 当前配置根目录的 `.env`（通常为 `~/.omp/.env`），仅针对当前值为空/未设置的键
5. 家目录的 `.env`（`~/.env`），仅针对当前值为空/未设置的键

agent/根目录位置遵循 profile、`PI_CONFIG_DIR`，以及——仅对默认 profile 生效——`PI_CODING_AGENT_DIR`。整个 dotenv 文件使用 Bun 的 `node:util.parseEnv` 解析，包括带引号的多行值、转义的换行符和行内注释。名称必须是 shell 标识符（`[A-Za-z_][A-Za-z0-9_]*`）；不安全的名称/值会被丢弃。在该解析器中变量引用保持字面值；只有 Bun 在启动目录的 dotenv 自动加载会在本模块运行之前执行变量展开。子 shell 过滤使用同一个解析器来识别项目 dotenv 值。

每个 `.env` 文件内部的额外规则：每一个 `OMP_*` 键都会被镜像到其 `PI_*` 别名，且该镜像值会替换同一文件中的 `PI_*` 值。此镜像仅适用于解析得到的 dotenv 文件，不适用于从父进程继承的任意变量。

---

## 1) 模型/Provider 认证

除非另有说明，这些变量通过 `getEnvApiKey()`（`packages/ai/src/stream.ts`）使用。

### 核心 Provider 凭证

| 变量 | 用途 | 何时必需 | 备注 / 优先级 |
| --- | --- | --- | --- |
| `ANTHROPIC_OAUTH_TOKEN` | Anthropic API 认证 | 使用 Anthropic 并采用 OAuth token 认证 | 在 provider 认证解析中优先于 `ANTHROPIC_API_KEY` |
| `ANTHROPIC_API_KEY` | Anthropic API 认证 | 使用 Anthropic 且没有 OAuth token | 在 `ANTHROPIC_OAUTH_TOKEN` 之后作为回退 |
| `ANTHROPIC_FOUNDRY_API_KEY` | 通过 Azure Foundry / 企业网关使用 Anthropic | 启用了 `CLAUDE_CODE_USE_FOUNDRY` | 启用 Foundry 模式时优先于 `ANTHROPIC_OAUTH_TOKEN` 和 `ANTHROPIC_API_KEY` |
| `OPENAI_API_KEY` | OpenAI 认证 | 使用 OpenAI 系列 provider 且未显式传入 apiKey 参数 | 由 OpenAI Completions/Responses provider 使用 |
| `OPENAI_CODEX_OAUTH_TOKEN` | OpenAI Codex 认证 | 使用 `openai-codex` provider | 由环境提供的 Codex OAuth token |
| `GEMINI_API_KEY` | Google Gemini 认证 | 使用 `google` provider 模型 | Gemini provider 映射的主要密钥 |
| `GOOGLE_API_KEY` | Gemini 图像工具认证回退 | 使用 `gemini_image` 工具且未设置 `GEMINI_API_KEY` | 由 coding-agent 图像工具的回退路径使用 |
| `GROQ_API_KEY` | Groq 认证 | 使用 Groq 模型 | |
| `CEREBRAS_API_KEY` | Cerebras 认证 | 使用 Cerebras 模型 | |
| `FIREWORKS_API_KEY` | Fireworks 认证 | 使用 Fireworks 模型 | |
| `FIREPASS_API_KEY` | Fire Pass 认证 | 使用 Fire Pass 模型 | |
| `TOGETHER_API_KEY` | Together 认证 | 使用 `together` provider | |
| `AIMLAPI_API_KEY` | AIML API 认证 | 使用 `aimlapi` provider | OpenAI 兼容的 AIML API 端点 `https://api.aimlapi.com/v1` |
| `HUGGINGFACE_HUB_TOKEN` | Hugging Face 认证 | 使用 `huggingface` provider | Hugging Face 的主要 token 环境变量 |
| `HF_TOKEN` | Hugging Face 认证 | 使用 `huggingface` provider | 在 `HUGGINGFACE_HUB_TOKEN` 未设置时回退 |
| `SYNTHETIC_API_KEY` | Synthetic 认证 | 使用 Synthetic 模型 | |
| `NVIDIA_API_KEY` | NVIDIA 认证 | 使用 `nvidia` provider | |
| `NANO_GPT_API_KEY` | NanoGPT 认证 | 使用 `nanogpt` provider | |
| `NOVITA_API_KEY` | Novita 认证 | 使用 `novita` provider | |
| `VENICE_API_KEY` | Venice 认证 | 使用 `venice` provider | |
| `LITELLM_API_KEY` | LiteLLM 认证 | 使用 `litellm` provider | OpenAI 兼容的 LiteLLM 代理密钥 |
| `LM_STUDIO_API_KEY` | LM Studio 认证（可选） | 使用 `lm-studio` provider 且主机需要认证 | 本地 LM Studio 通常无需认证；需要密钥时任何非空 token 均可 |
| `OLLAMA_API_KEY` | Ollama 认证（可选） | 使用 `ollama` provider 且主机需要认证 | 本地 Ollama 通常无需认证；需要密钥时任何非空 token 均可 |
| `LLAMA_CPP_API_KEY` | llama.cpp 认证（可选） | 使用 `llama.cpp` provider 且主机需要认证 | 本地 llama.cpp 通常无需认证；配置了密钥时任何非空 token 均可 |
| `XIAOMI_API_KEY` | Xiaomi MiMo 认证 | 使用 `xiaomi` provider | |
| `XIAOMI_TOKEN_PLAN_AMS_API_KEY` | Xiaomi MiMo Token Plan 认证（AMS） | 使用 `xiaomi-token-plan-ams` provider | |
| `XIAOMI_TOKEN_PLAN_CN_API_KEY` | Xiaomi MiMo Token Plan 认证（CN） | 使用 `xiaomi-token-plan-cn` provider | |
| `XIAOMI_TOKEN_PLAN_SGP_API_KEY` | Xiaomi MiMo Token Plan 认证（SGP） | 使用 `xiaomi-token-plan-sgp` provider | |
| `MOONSHOT_API_KEY` | Moonshot 认证 | 使用 `moonshot` provider | `KIMI_API_KEY` 可作为回退别名 |
| `XAI_API_KEY` | xAI 认证 | 使用 xAI 模型或作为 `xai-oauth` 的回退 | |
| `XAI_OAUTH_TOKEN` | xAI OAuth/SuperGrok 认证 | 使用 `xai-oauth` provider | 在 `xai-oauth` 中优先于 `XAI_API_KEY` |
| `OPENROUTER_API_KEY` | OpenRouter 认证 | 使用 OpenRouter 模型 | 当首选/自动 provider 为 OpenRouter 时，图像工具也会使用 |
| `MISTRAL_API_KEY` | Mistral 认证 | 使用 Mistral 模型 | |
| `ZAI_API_KEY` | z.ai 认证 | 使用 z.ai 模型 | z.ai 网络搜索 provider 也会使用 |
| `ZHIPU_API_KEY` | Zhipu Coding Plan 认证 | 使用 `zhipu-coding-plan` provider | |
| `UMANS_AI_CODING_PLAN_API_KEY` | Umans AI Coding Plan 认证 | 使用 `umans` provider | |
| `MINIMAX_API_KEY` | MiniMax 认证 | 使用 `minimax` provider | |
| `MINIMAX_CODE_API_KEY` | MiniMax Code 认证 | 使用 `minimax-code` provider | |
| `MINIMAX_CODE_CN_API_KEY` | MiniMax Code CN 认证 | 使用 `minimax-code-cn` provider | |
| `OPENCODE_API_KEY` | OpenCode 认证 | 使用 `opencode-go` / `opencode-zen` 模型 | |
| `QIANFAN_API_KEY` | Qianfan 认证 | 使用 `qianfan` provider | |
| `QWEN_OAUTH_TOKEN` | Qwen Portal 认证 | 使用 `qwen-portal` 并采用 OAuth token | 优先于 `QWEN_PORTAL_API_KEY` |
| `QWEN_PORTAL_API_KEY` | Qwen Portal 认证 | 使用 `qwen-portal` 并采用 API key | 在 `QWEN_OAUTH_TOKEN` 之后作为回退 |
| `ZENMUX_API_KEY` | ZenMux 认证 | 使用 `zenmux` provider | 用于 ZenMux 的 OpenAI 与 Anthropic 兼容路由 |
| `COMMAND_CODE_API_KEY` | Command Code 认证 | 使用 `commandcode` provider | `COMMANDCODE_API_KEY` 可作为旧版别名 |
| `CHARM_HYPER_API_KEY` | Charm Hyper 认证 | 使用 `charm-hyper` provider | `HYPER_API_KEY` 可作为回退别名 |
| `VLLM_API_KEY` | vLLM 认证/发现启用开关 | 使用 `vllm` provider（本地 OpenAI 兼容服务器） | 对于无认证的本地服务器，任何非空值均可 |
| `CURSOR_ACCESS_TOKEN` | Cursor provider 认证 | 使用 Cursor provider | `CURSOR_API_KEY` 可作为别名 |
| `AI_GATEWAY_API_KEY` | Vercel AI Gateway 认证 | 使用 `vercel-ai-gateway` provider | `VERCEL_AI_GATEWAY_API_KEY` 可作为别名 |
| `CLOUDFLARE_AI_GATEWAY_API_KEY` | Cloudflare AI Gateway 认证 | 使用 `cloudflare-ai-gateway` provider | 具有 AI Gateway Run 权限的网关 token；`/login` 会将其与路由 ID 一并存储 |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare AI Gateway 账户路由 | 使用环境变量提供的网关 token | 当账户 ID 已由 `/login` 存储时不需要 |
| `CLOUDFLARE_GATEWAY_ID` | Cloudflare AI Gateway 选择 | 使用环境变量提供的网关 token | 网关 slug，通常为 `default`；已由 `/login` 存储时不需要 |
| `ALIBABA_CODING_PLAN_API_KEY` | Alibaba Coding Plan 认证 | 使用 `alibaba-coding-plan` provider | |
| `ALIBABA_TOKEN_PLAN_API_KEY` | QwenCloud Token Plan 认证 | 使用 `alibaba-token-plan` provider | 首选的 provider 专用名称 |
| `BAILIAN_TOKEN_PLAN_API_KEY` | QwenCloud Token Plan 认证 | 使用 `alibaba-token-plan` provider | 兼容 Qwen Code 的 Token Plan 预设 |
| `DEEPINFRA_API_KEY` | DeepInfra 认证 | 使用 `deepinfra` provider | |
| `DEEPSEEK_API_KEY` | DeepSeek 认证 | 使用 DeepSeek 模型 | |
| `SILICONFLOW_API_KEY` | SiliconFlow 认证 | 使用 `siliconflow` provider | |
| `SILICONFLOW_CN_API_KEY` | SiliconFlow（中国）认证 | 使用 `siliconflow-cn` provider | |
| `KILO_API_KEY` | Kilo 认证 | 使用 Kilo 模型 | |
| `OLLAMA_CLOUD_API_KEY` | Ollama Cloud 认证 | 使用 `ollama-cloud` provider | |
| `CLINE_API_KEY` | ClinePass 订阅 + 免费额度认证 | 使用 `cline-pass` provider | 官方 Cline API key 变量 |
| `YOLO_AUTO_API_KEY` | Yolo-Auto 认证 | 使用 `yolo-auto` provider | 统一定价的 Qwen 模型；对照 `https://yolo-auto.com/v1/models` 校验 |
| `WAFER_SERVERLESS_API_KEY` | Wafer Serverless 认证 | 使用 `wafer-serverless` provider | 按量计费的 Wafer SKU；对照 `https://pass.wafer.ai/v1/models` 校验 |
| `GITLAB_TOKEN` | GitLab Duo 认证 | 使用 `gitlab-duo` / `gitlab-duo-agent` provider | 两个 GitLab provider 读取同一个 token |
| `BASETEN_API_KEY` | Baseten 认证 | 使用 `baseten` provider | 也可通过交互式 API key 登录配置（`/login baseten`，密钥来自 Baseten 控制台） |
| `COREWEAVE_API_KEY` / `WANDB_API_KEY` | CoreWeave Serverless Inference 认证 | 使用 `coreweave` provider | 两个变量均可（W&B 回退）。`COREWEAVE_PROJECT`（回退 `WANDB_INFERENCE_PROJECT`）提供必需的 `OpenAI-Project` 请求头 |
| `SAKANA_API_KEY` / `FUGU_API_KEY` | Sakana AI 认证 | 使用 `sakana` provider | 两个变量均可；`SAKANA_BASE_URL` / `FUGU_BASE_URL` 覆盖请求基础 URL |
| `DEVIN_API_KEY` | Devin 认证 | 使用 `devin` provider | 也可通过交互式登录获取（`/login devin`，OAuth） |
| `AIAND_API_KEY` | ai& 认证 | 使用 `aiand` provider | |
| `GMI_API_KEY` | GMI Cloud 认证 | 使用 `gmi-cloud` provider | |
| `MODEL_API_KEY` / `META_API_KEY` | Meta Model API 认证 | 使用 `meta` provider | 两个变量均可 |

### GitHub/Copilot 令牌

| 变量 | 用途 | 备注 |
| --- | --- | --- |
| `COPILOT_GITHUB_TOKEN` | GitHub Copilot provider 认证 | 此处不使用通用 GitHub token |
| `COPILOT_INTEGRATION_ID` | GitHub Copilot 客户端身份覆盖 | 默认为 `copilot-chat`（聊天入口）。被拒绝的请求会以 Copilot CLI 身份重试一次；设置此项可固定客户端 ID 并跳过重试（[#11372](https://github.com/can1357/oh-my-pi/issues/11372)） |
| `GH_TOKEN` | 网络爬虫中的 GitHub API 认证 | 网络爬虫在 `GITHUB_TOKEN` 之后的回退 |
| `GITHUB_TOKEN` | 网络爬虫中的 GitHub API 认证 | 网络爬虫先检查此项，再检查 `GH_TOKEN` |

### 认证代理 / 认证网关（远程凭证保险库）

启用 broker 后，本地 SQLite 凭证存储会被绕过，所有 OAuth 刷新/访问令牌都保存在 broker 主机上。完整协议、CLI 界面与 5 分钟/15 秒使用缓存分层请参见 [`auth-broker-gateway.md`](./auth-broker-gateway.md)。

| 变量 | 用途 | 何时必需 | 备注 / 优先级 |
| --- | --- | --- | --- |
| `OMP_AUTH_BROKER_URL` | 远程 auth-broker 的基础 URL（如 `https://broker.tailnet:8765`）；选择 broker 模式 | 通过 broker 解析凭证；`omp auth-gateway serve` 同样需要它（网关本身也是 broker 客户端） | 优先于 `config.yml` 中的 `auth.broker.url`。设置此项但解析不出 token 时，`resolveAuthBrokerConfig()` 会直接报错，而不是回退到本地 SQLite。 |
| `OMP_AUTH_BROKER_TOKEN` | 除 `/v1/healthz` 外每个 broker 端点都会发送的 Bearer token | 设置了 `OMP_AUTH_BROKER_URL`，且无法从 `auth.broker.token` 或 `<config-dir>/auth-broker.token` 获得 token | 解析顺序：本环境变量 → `auth.broker.token`（支持 `$ENV_NAME` 间接引用）→ `<config-dir>/auth-broker.token`（权限 `0600`）。`<config-dir>` 为 `~/.omp/`（遵循 `PI_CONFIG_DIR`）。 |
| `OMP_AUTH_BROKER_SNAPSHOT_TTL_MS` | 加密的本地 broker 快照缓存的保鲜时间窗口 | broker 模式下可选 | 默认 `3600000`（1 小时）。保鲜度基于 broker 的 `snapshot.generatedAt`；`0` 会禁用缓存读写，并强制每次启动时执行旧的阻塞式拉取。 |
| `OMP_AUTH_BROKER_SNAPSHOT_CACHE` | 加密的本地 broker 快照缓存路径 | broker 模式下可选 | 默认为 `~/.omp/cache/auth-broker-snapshot.enc`（或 XDG 缓存等价路径）。适用于测试、临时主机，或需要迁移 `0600` 缓存文件的场景。 |
| `OMP_AUTH_BROKER_ACCOUNT_POOL_FILE` | 受信任 broker 客户端的进程级 OAuth 账户路由 | broker 模式下可选 | 一个 JSON 对象的路径，将 provider ID 映射为精确的 broker `identityKey` 数组。缺失的 provider 不受限制；`[]` 会隐藏该 provider 的 OAuth 账户；API key 仍然可见。启动时解析一次，输入无效时以失败关闭。这不是服务器端授权。 |

网关没有专门的环境变量——它继承 `OMP_AUTH_BROKER_*`。其自身的入站 Bearer token 位于 `<config-dir>/auth-gateway.token`，通过 `omp auth-gateway token` 管理。

---

## 2) Provider 特定的运行时配置

### 出站代理路由

在应用 `NO_PROXY` / `no_proxy` 之后，provider 的 HTTP 请求按以下顺序解析代理：

1. `PI_PROXY_<PROVIDER>`（provider ID 转为大写，非字母数字字符替换为 `_`，例如 `PI_PROXY_GITHUB_COPILOT`）
2. `PI_PROXY`
3. HTTPS 与 WebSocket 目标使用 `HTTPS_PROXY` / `https_proxy`，HTTP 目标使用 `HTTP_PROXY` / `http_proxy`
4. `ALL_PROXY` / `all_proxy`

provider 的代理查找结果在进程生命周期内缓存。localhost 目标会绕过 provider 请求包装器。

两种 `PI_PROXY` 形式的作用范围不同：

- `PI_PROXY` 在 CLI 启动时安装到进程级 `fetch` 上，因此也覆盖 provider 请求包装器之外的请求——OAuth token 刷新与登录、用量探测、模型发现。若不设置，被区域封锁的 token 端点在刷新时会返回 `403 Request not allowed`，即使数据流本身已走代理。
- `PI_PROXY_<PROVIDER>` 仅作用于该 provider 的请求，并会对这些请求覆盖 `PI_PROXY`。它不覆盖上述非 provider 范围的调用；如果该 provider 封锁了你的所在区域，请同时设置 `PI_PROXY`。

回环、链路本地、私有网段（`10/8`、`172.16/12`、`192.168/16`）以及 `NO_PROXY` 目标始终绕过代理，因此本地模型服务器与 MCP 主机保持直连。

### Anthropic Foundry 网关（Azure / 企业代理）

启用 `CLAUDE_CODE_USE_FOUNDRY` 时，Anthropic 请求切换到 Foundry 模式：

- 基础 URL 从 `FOUNDRY_BASE_URL` 解析（未设置时仍回退到模型/默认基础 URL）。
- provider `anthropic` 的 API key 解析顺序变为：
  `ANTHROPIC_FOUNDRY_API_KEY` → `ANTHROPIC_OAUTH_TOKEN` → `ANTHROPIC_API_KEY`。
- `ANTHROPIC_CUSTOM_HEADERS` 被解析为以逗号/换行分隔的 `key: value` 对，并合并进请求头。当 `ANTHROPIC_BASE_URL` 指向非 Anthropic 主机（例如企业 API 网关）时，这些头也会被转发，因此需要专有认证头的企业网关无需启用 Foundry 模式即可工作。
- TLS 客户端/服务端材料可从环境变量值注入：
  `NODE_EXTRA_CA_CERTS`、`CLAUDE_CODE_CLIENT_CERT`、`CLAUDE_CODE_CLIENT_KEY`。
  每个变量接受以下二者之一：
  - 指向 PEM 内容的文件系统路径，或
  - 内联 PEM（包括转义的 `\n` 序列）。

  `NODE_EXTRA_CA_CERTS` 对每次 provider 请求都生效（OpenAI 兼容、Codex、Ollama、Azure Responses、Google、Anthropic），不仅限于 Foundry——Bun 的 `fetch` 原生并不读取该环境变量，因此该 CA 集会与系统根证书一起合并进 `RequestInit.tls.ca`。`CLAUDE_CODE_*` 的 mTLS 材料仍仅限 Anthropic Foundry。

| 变量 | 值类型 | 行为 |
| --- | --- | --- |
| `CLAUDE_CODE_USE_FOUNDRY` | 布尔型字符串（`1`、`true`、`yes`、`on`） | 为 Anthropic provider 启用 Foundry 模式 |
| `FOUNDRY_BASE_URL` | URL 字符串 | Foundry 模式下 Anthropic 端点的基础 URL |
| `ANTHROPIC_FOUNDRY_API_KEY` | Token 字符串 | 用于 `Authorization: Bearer <token>` |
| `ANTHROPIC_CUSTOM_HEADERS` | 头部列表字符串 | 额外请求头；格式为 `header-a: value, header-b: value` 或以换行分隔。只要 `ANTHROPIC_BASE_URL` 指向非 Anthropic 主机，在 Foundry 之外也会转发。 |
| `NODE_EXTRA_CA_CERTS` | PEM 路径或内联 PEM | 用于服务器证书校验的额外 CA 链 |
| `CLAUDE_CODE_CLIENT_CERT` | PEM 路径或内联 PEM | mTLS 客户端证书 |
| `CLAUDE_CODE_CLIENT_KEY` | PEM 路径或内联 PEM | mTLS 客户端私钥（必须与证书配对） |

### Amazon Bedrock

| 变量 | 默认 / 行为 |
| --- | --- |
| `AWS_REGION` | 主要区域来源 |
| `AWS_DEFAULT_REGION` | 在 `AWS_REGION` 未设置时回退 |
| `AWS_PROFILE` | 启用命名 profile 认证路径 |
| `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` | 启用 IAM key 认证路径 |
| `AWS_BEARER_TOKEN_BEDROCK` | 最高优先级的 Bearer token 认证路径；设置后跳过 AWS profile/凭证链查找 |
| `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI` / `AWS_CONTAINER_CREDENTIALS_FULL_URI` | 在 provider 检测中将 Bedrock 标记为可用（凭证解析本身依次涵盖环境变量密钥、profile/SSO/`credential_process`，再到 IMDSv2） |
| `AWS_WEB_IDENTITY_TOKEN_FILE` + `AWS_ROLE_ARN` | 在 provider 检测中将 Bedrock 标记为可用（与上述 ECS 变量相同的注意事项） |
| `AWS_BEDROCK_SKIP_AUTH` | 若为 `1`，注入虚拟凭证（代理/无认证场景） |
| `HTTPS_PROXY` / `HTTP_PROXY` | 通过 Bun 原生 fetch 代理支持生效（provider 不再内置 AWS SDK / proxy-agent 传输层） |
| `NO_PROXY` | 从 Bun 原生代理路由中排除匹配的主机 |

provider 代码中的区域回退：`options.region` → `AWS_REGION` → `AWS_DEFAULT_REGION` → `us-east-1`。

由原生 Bedrock 解析器实现的额外凭证链控制项：

| 变量 | 行为 |
| --- | --- |
| `AWS_SESSION_TOKEN` | 与 `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` 配对的会话 token |
| `AWS_SHARED_CREDENTIALS_FILE`、`AWS_CONFIG_FILE` | 覆盖共享凭证/配置 INI 路径 |
| `AWS_SDK_LOAD_CONFIG` | `1`/`true` 在没有显式 profile 时启用共享配置加载 |
| `AWS_ROLE_SESSION_NAME` | Web Identity 角色扮演使用的会话名称 |
| `AWS_CONTAINER_AUTHORIZATION_TOKEN`、`AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE` | ECS 容器凭证的授权 |
| `AWS_EC2_METADATA_DISABLED` | `true` 禁用 IMDSv2 |
| `AWS_EC2_METADATA_SERVICE_ENDPOINT`、`AWS_EC2_METADATA_SERVICE_ENDPOINT_MODE` | 覆盖 IMDS 端点 / 选择 IPv6 回退 |

### Azure OpenAI Responses

| 变量 | 默认 / 行为 |
| --- | --- |
| `AZURE_OPENAI_API_KEY` | 除非以选项形式传入 API key，否则必需 |
| `AZURE_OPENAI_API_VERSION` | 默认 `v1` |
| `AZURE_OPENAI_BASE_URL` | 直接覆盖基础 URL |
| `AZURE_OPENAI_RESOURCE_NAME` | 用于构造基础 URL：`https://<resource>.openai.azure.com/openai/v1` |
| `AZURE_OPENAI_DEPLOYMENT_NAME_MAP` | 可选的映射字符串：`modelId=deploymentName,model2=deployment2` |

基础 URL 解析顺序：选项 `azureBaseUrl` → 环境变量 `AZURE_OPENAI_BASE_URL` → 选项/环境变量资源名 → `model.baseUrl`。

### Google Vertex AI

| 变量 | 是否必需 | 备注 |
| --- | --- | --- |
| `GOOGLE_CLOUD_PROJECT` | 是（除非在选项中传入） | 主要项目 ID 来源 |
| `GCP_PROJECT` | 回退 | 备选项目 ID 来源 |
| `GCLOUD_PROJECT` | 回退 | 备选项目 ID 来源 |
| `GOOGLE_CLOUD_PROJECT_ID` | 仅用于 OAuth 登录辅助 | 由 Gemini CLI OAuth 项目发现使用 |
| `GOOGLE_VERTEX_LOCATION` | 是（除非在选项中传入） | 主要 Vertex 位置来源 |
| `GOOGLE_CLOUD_LOCATION` | 回退 | 备选 Vertex 位置来源 |
| `VERTEX_LOCATION` | 回退 | 备选 Vertex 位置来源 |
| `GOOGLE_CLOUD_API_KEY` | 条件性 | 直接的 Vertex API key 认证；否则当项目和位置已设置时，ADC 回退也可完成认证 |
| `GOOGLE_APPLICATION_CREDENTIALS` | 条件性 | 若设置，文件必须存在；否则检查 ADC 回退路径（`~/.config/gcloud/application_default_credentials.json`） |

`GOOGLE_CLOUD_ACCESS_TOKEN`（或兼容的 `CLOUDSDK_AUTH_ACCESS_TOKEN` 回退）提供显式的 Google OAuth 访问令牌，并绕过 ADC token 获取。

### Kimi

| 变量 | 默认 / 行为 |
| --- | --- |
| `KIMI_CODE_OAUTH_HOST` | 主要 OAuth 主机覆盖 |
| `KIMI_OAUTH_HOST` | 回退 OAuth 主机覆盖 |
| `KIMI_CODE_BASE_URL` | 覆盖 Kimi 用量端点基础 URL（`usage/kimi.ts`） |

OAuth 主机链：`KIMI_CODE_OAUTH_HOST` → `KIMI_OAUTH_HOST` → `https://auth.kimi.com`。

### OpenAI 兼容端点控制

| 变量 | 默认 / 行为 |
| --- | --- |
| `OPENAI_BASE_URL` | 模型/provider 提供默认值时，OpenAI 兼容请求的基础 URL 回退 |
| `MOONSHOT_BASE_URL` | Moonshot 聊天与模型发现端点覆盖 |
| `XAI_BASE_URL` | xAI HTTP 端点覆盖 |
| `SAKANA_BASE_URL` / `FUGU_BASE_URL` | Sakana/Fugu 端点覆盖（`SAKANA_BASE_URL` 优先） |
| `PI_OPENROUTER_RESPONSES` | 除非设为 `0`，否则启用 Responses API；`0` 选择 OpenAI Completions 路由 |
| `UMANS_WEBSEARCH_PROVIDER` | 未显式提供时，Umans Anthropic 网络搜索 provider 的默认选择 |

### Gemini CLI 与 Antigravity 兼容性

| 变量 | 默认 / 行为 |
| --- | --- |
| `PI_AI_GEMINI_CLI_VERSION` | 覆盖 Gemini CLI user-agent 版本标签（未设置时为 `0.46.0`） |
| `PI_AI_ANTIGRAVITY_VERSION` | 覆盖自动发现的 Antigravity hub user-agent 版本；未设置且发现失败时回退为 `2.8.0` |
| `PI_AI_ANTIGRAVITY_CL` | 覆盖 Antigravity hub user-agent 的 build changelist（未设置时为 `963137146`） |
| `PI_AI_ANTIGRAVITY_OS` | 覆盖 Antigravity hub user-agent 的 os_type（未设置时固定为 `darwin`） |
| `PI_AI_ANTIGRAVITY_ARCH` | 覆盖 Antigravity hub user-agent 的 arch（未设置时固定为 `arm64`） |

### GitLab Duo

| 变量 | 默认 / 行为 |
| --- | --- |
| `GITLAB_CLIENT_ID` | OAuth 客户端 ID。若未设置，则使用捆绑的 GitLab OAuth 应用客户端 ID。 |
| `GITLAB_REDIRECT_URI` | 向 GitLab 声明的精确 OAuth 重定向 URI。若未设置，本地回调使用 `http://localhost:8080/callback`，并以随机端口作为回退。必须使用 HTTP 或 HTTPS；回环回调必须使用 HTTP 并绑定 URI 中的主机与端口。 |
| `GITLAB_DUO_NAMESPACE_ID` | 工作流命名空间覆盖。运行时选项优先；否则命名空间/项目发现使用当前凭证与工作目录。 |
| `GITLAB_DUO_PROJECT_ID` | 按 ID 覆盖工作流项目。运行时 `projectId` 优先，其次是运行时 `projectPath`；此变量优先于 `GITLAB_DUO_PROJECT_PATH`。 |
| `GITLAB_DUO_PROJECT_PATH` | 在未设置运行时项目或 `GITLAB_DUO_PROJECT_ID` 时，按路径覆盖工作流项目。 |
| `GITLAB_DUO_WORKFLOW_DEFINITION` | 工作流定义覆盖；运行时 `workflowDefinition` 优先。默认为 `ambient`。 |
| `GITLAB_DUO_WORKFLOW_TRACE` | 仅当值恰好为 `1` 时启用工作流跟踪。每个跟踪事件以每行一个 JSON 对象的形式追加；跟踪写入失败会被忽略。 |
| `GITLAB_DUO_WORKFLOW_TRACE_FILE` | 跟踪输出路径。该值会去除首尾空白；未设置或为空白时，默认为从 provider 模块解析 `../../../../.tmp/gitlab-duo-workflow-trace.log` 得到的绝对路径（在源码检出中即 `<repo>/.tmp/gitlab-duo-workflow-trace.log`）。缺失的父目录会自动创建。 |

`GITLAB_CLIENT_ID` 和 `GITLAB_REDIRECT_URI` 影响 OAuth 登录。四个路由/创建覆盖项（`GITLAB_DUO_NAMESPACE_ID`、`GITLAB_DUO_PROJECT_ID`、`GITLAB_DUO_PROJECT_PATH` 和 `GITLAB_DUO_WORKFLOW_DEFINITION`）影响 `gitlab-duo-agent` 的工作流命名空间/项目解析或工作流创建；它们不配置 OAuth。上述两个跟踪变量仅影响本地诊断输出。非回环重定向 URI 无法由本地回调监听器直接服务，因此通过粘贴代码路径完成。

### OpenAI Codex responses（功能/调试控制）

| 变量 | 行为 |
| --- | --- |
| `PI_CODEX_DEBUG` | `1`/`true` 启用 Codex provider 调试日志 |
| `PI_CODEX_WEBSOCKET` | `1`/`true` 启用 WebSocket 传输偏好 |
| `PI_CODEX_RESPONSES_LITE` | `1`/`true` 让常规推理改用 Responses Lite；`0`/`false` 强制使用标准 Responses 请求体；未设置时常规推理默认使用完整 Responses |
| `PI_OPENAI_STATEFUL` | 覆盖平台 OpenAI Responses API 的有状态链接默认值（`previous_response_id`，强制 `store: true`）：对 api.openai.com 默认开启，其他主机默认关闭 |
| `PI_CODEX_ZSTD` | `0`/`false` 禁用发往官方 Codex API 的请求体 zstd 压缩（默认启用） |
| `PI_CODEX_WEBSOCKET_IDLE_TIMEOUT_MS` | 正整数覆盖（默认 `300000`） |
| `PI_CODEX_WEBSOCKET_FIRST_EVENT_TIMEOUT_MS` | 首事件超时覆盖（默认 `300000`） |
| `PI_CODEX_WEBSOCKET_PING_INTERVAL_MS` | Ping 间隔覆盖（默认 `10000`） |
| `PI_CODEX_WEBSOCKET_PONG_TIMEOUT_MS` | Pong 超时覆盖（默认 `60000`） |
| `PI_CODEX_WEBSOCKET_MESSAGE_QUEUE_CAPACITY` | 缓冲消息容量覆盖（默认 `4096`） |
| `PI_CODEX_WEBSOCKET_MAX_IDLE_REUSE_MS` | 连接不再被复用前的最大空闲时间（默认 `30000`） |
| `PI_CODEX_WEBSOCKET_RETRY_BUDGET` | 非负整数覆盖（默认 `5`） |
| `PI_CODEX_WEBSOCKET_RETRY_DELAY_MS` | 正整数基础退避覆盖（默认 `500`） |
| `PI_STREAM_FIRST_EVENT_TIMEOUT_MS` | 通用流首事件超时；`0` 禁用 |
| `PI_STREAM_IDLE_TIMEOUT_MS` | 通用流空闲超时；`0` 禁用 |
| `PI_OPENAI_STREAM_FIRST_EVENT_TIMEOUT_MS` | OpenAI 特定的首事件超时覆盖；`0` 禁用并优先于通用值。`omp config set providers.streamFirstEventTimeoutSeconds <seconds>` 提供持久化的等价配置 |
| `PI_OPENAI_STREAM_IDLE_TIMEOUT_MS` | OpenAI 特定的空闲超时覆盖；`0` 禁用并优先于通用值。`omp config set providers.streamIdleTimeoutSeconds <seconds>` 提供持久化的等价配置 |

### Cursor provider 调试

| 变量 | 行为 |
| --- | --- |
| `DEBUG_CURSOR` | 启用 provider 调试日志；`2`/`verbose` 输出详细的负载片段 |
| `DEBUG_CURSOR_LOG` | JSONL 调试日志输出的可选文件路径 |

### 提示词缓存兼容性开关

| 变量 | 行为 |
| --- | --- |
| `PI_CACHE_RETENTION` | 在支持的场景（`anthropic`、`openai-responses`、Bedrock）覆盖缓存保留策略。接受 `long`、`short` 或 `none`；其他值会被忽略 |

---

## 3) 网络搜索子系统

### 搜索 provider 凭证

| 变量 | 由谁使用 |
| --- | --- |
| `EXA_API_KEY` | Exa 搜索/MCP；也可使用 `/login exa` |
| `TINYFISH_API_KEY` | TinyFish 搜索 provider（必需） |
| `BRAVE_API_KEY` | Brave 搜索 provider |
| `PERPLEXITY_API_KEY` | Perplexity 搜索 provider 的 API key 模式 |
| `PERPLEXITY_COOKIES` | Perplexity 的 cookie 认证搜索模式 |
| `PI_PERPLEXITY_RESPONSES` | `1` 选择 Perplexity Responses 端点而非 Chat Completions |
| `PI_PERPLEXITY_MODEL` | Perplexity 消费者订阅的模型偏好（默认 `experimental`） |
| `PI_PERPLEXITY_API_MODEL` | Perplexity 直连 API 的模型覆盖（默认 `sonar-pro`） |
| `FIRECRAWL_API_KEY` | Firecrawl 搜索 provider（未设置时回退为无密钥模式）与 fetch 阅读器后端（必需） |
| `FIRECRAWL_BASE_URL` | Firecrawl API 端点覆盖（`FIRECRAWL_API_URL` 为回退别名） |
| `GOOGLE_GEMINI_BASE_URL` | Gemini 搜索端点覆盖；必须是有效的绝对 HTTP(S) URL |
| `TAVILY_API_KEY` | Tavily 搜索 provider |
| `ZAI_API_KEY` | z.ai 搜索 provider（也会检查 `agent.db` 中存储的 OAuth） |
| `OPENAI_API_KEY` / 数据库中的 Codex OAuth | Codex 搜索 provider 的可用性/认证 |
| `PI_CODEX_WEB_SEARCH_MODEL` | Codex 搜索 provider 的模型覆盖 |
| `GEMINI_SEARCH_MODEL` | Gemini 搜索模型覆盖 |
| `MOONSHOT_SEARCH_API_KEY` / `KIMI_SEARCH_API_KEY` | Kimi/Moonshot 搜索 provider 的环境变量认证 |
| `MOONSHOT_SEARCH_BASE_URL` / `KIMI_SEARCH_BASE_URL` | Kimi/Moonshot 搜索端点覆盖 |
| `KAGI_API_KEY` | Kagi 搜索 provider |
| `JINA_API_KEY` | Jina 搜索 provider |
| `PARALLEL_API_KEY` | Parallel 搜索 provider |
| `OLLAMA_CLOUD_API_KEY` | Ollama 网络搜索 provider |
| `SEARXNG_ENDPOINT`、`SEARXNG_TOKEN` | SearXNG 端点与可选的 bearer token |
| `SEARXNG_BASIC_USERNAME`、`SEARXNG_BASIC_PASSWORD` | SearXNG HTTP Basic 认证凭证 |

DuckDuckGo 搜索无需密钥——它查询无 JS 的 HTML 前端（`html.duckduckgo.com`），不需要任何凭证；它也为无需凭证的 `public` 聚合提供结果（与 startpage、google、ecosia 和 mojeek 一道）。

SearXNG 还会从 `~/.omp/agent/config.yml` 读取等价的 `searxng.endpoint`、`searxng.token`、`searxng.basicUsername` 和 `searxng.basicPassword` 设置；环境变量作为回退。

### Anthropic 网络搜索认证链

`searchAnthropic()` 按以下顺序解析凭证：

1. `ANTHROPIC_SEARCH_API_KEY`
2. `authStorage.getApiKey("anthropic")` 回退凭证（运行时与配置覆盖、存储的 OAuth、登录获取的 API key、通用 Anthropic 环境回退，然后是其他已存储的 API key；环境回退在 Foundry 模式下为 `ANTHROPIC_FOUNDRY_API_KEY` → `ANTHROPIC_OAUTH_TOKEN` → `ANTHROPIC_API_KEY`，否则为 `ANTHROPIC_OAUTH_TOKEN` → `ANTHROPIC_API_KEY`）

对于任一凭证路径，基础 URL 解析顺序为：

1. `ANTHROPIC_SEARCH_BASE_URL`
2. 启用 `CLAUDE_CODE_USE_FOUNDRY` 时使用 `FOUNDRY_BASE_URL`
3. `ANTHROPIC_BASE_URL`
4. `https://api.anthropic.com`

相关变量：

| 变量 | 默认 / 行为 |
| --- | --- |
| `ANTHROPIC_SEARCH_API_KEY` | 专用于 Anthropic 网络搜索 provider 的 API key。搜索认证的最高优先级；对搜索调用覆盖 `ANTHROPIC_API_KEY` / OAuth / Foundry，不影响聊天补全。 |
| `ANTHROPIC_SEARCH_BASE_URL` | 专用于 Anthropic 网络搜索 provider 的基础 URL。既应用于 `ANTHROPIC_SEARCH_API_KEY`，也应用于回退的 Anthropic 凭证；对搜索调用覆盖 `ANTHROPIC_BASE_URL`（以及 Foundry 模式下的 `FOUNDRY_BASE_URL`）。 |
| `ANTHROPIC_SEARCH_MODEL` | 搜索模型覆盖。默认为 `claude-haiku-4-5`。 |
| `ANTHROPIC_BASE_URL` | 在未设置搜索专用基础 URL 时，Anthropic 请求的通用回退基础 URL。 |

使用 `ANTHROPIC_SEARCH_BASE_URL`（可选搭配 `ANTHROPIC_SEARCH_API_KEY`）可让聊天继续经由企业网关（`ANTHROPIC_BASE_URL` 或 `CLAUDE_CODE_USE_FOUNDRY=true`）路由，同时将网络搜索指向直连的 Anthropic 端点，反之亦然。

### Perplexity OAuth 流程行为标志

| 变量 | 行为 |
| --- | --- |
| `PI_AUTH_NO_BORROW` | 若设置，则在 Perplexity 登录流程中禁用 macOS 原生应用的 token 借用路径 |

### TypeSafe 判断

agent 对自身状态做出的小型类型化决策（`auto` 思考级别难度分类器、Smart 意外停止检测、git TUI AI 暂存）都经由同一个判断接口。有 TypeSafe 凭证时，它们运行在 TypeSafe 的 System One 模型（`POST /v1/systemone`）上；请求失败时依次回退到 `tiny`、`smol`、`default` 以及当前会话模型。没有 TypeSafe 时，这些功能使用该聊天模型链或各自配置的本地设备模型。`providers.judgmentProvider`（`auto` / `typesafe` / `llm`）用于固定首选后端。

| 变量 | 默认 / 行为 |
| --- | --- |
| `TYPESAFE_API_KEY` | TypeSafe API key；也可使用 `/login typesafe` |
| `TYPESAFE_BASE_URL` | API 根地址覆盖（默认 `https://api.typesafe.ai`）；`/login` 校验也会使用 |
| `TYPESAFE_DEFAULT_MODEL` | System One 模型名称（默认 `jev-latest`） |

---

## 4) Python 工具与内核运行时

| 变量 | 默认 / 行为 |
| --- | --- |
| `PI_PY` | Python 的布尔型覆盖；未设置时遵循 `eval.py`（默认启用） |
| `PI_JS` | JavaScript 的布尔型覆盖；未设置时遵循 `eval.js`（默认启用） |
| `PI_PYTHON_SKIP_CHECK` | 真值标志会跳过 Python 解释器可用性检查（子进程运行器仍按需启动） |
| `PI_PYTHON_IPC_TRACE` | 真值标志会记录与 Python 运行器子进程交换的 NDJSON 帧 |
| `VIRTUAL_ENV` | Python 运行时解析的最高优先级 venv 路径 |
| `CONDA_PREFIX` | Python 环境回退，位于 `VIRTUAL_ENV` 之后、本地 `.venv` / `venv` 目录之前 |

Python 子进程过滤会拒绝常见的 API 密钥变量，并允许安全的基础变量以及带 `LC_`、`XDG_`、`PI_` 前缀的变量。

---

## 5) Agent/运行时行为开关

| 变量 | 默认 / 行为 |
| --- | --- |
| `PI_SMOL_MODEL` | `smol` 模型角色的临时覆盖（CLI `--smol` 优先） |
| `PI_SLOW_MODEL` | `slow` 模型角色的临时覆盖（CLI `--slow` 优先） |
| `PI_PLAN_MODEL` | `plan` 模型角色的临时覆盖（CLI `--plan` 优先） |
| `PI_NO_TITLE` | 若设置（任何非空值），则在首条用户消息时禁用自动会话标题生成 |
| `PI_TINY_DEVICE` | 本地 tiny 模型的推理后端；覆盖 `providers.tinyModelDevice` 设置（默认：CPU；ONNX provider 包括 `cpu`、`gpu`、`webgpu`、`auto`、`cuda`、`dml`、`coreml`、`wasm`、`webnn`、`webnn-gpu`、`webnn-cpu`、`webnn-npu`，或在 Apple 芯片上通过 mlx-lm 运行 MLX 权重的 `mlx`/`metal`） |
| `PI_TINY_DTYPE` | 本地 tiny 模型的 ONNX 量化/精度；覆盖 `providers.tinyModelDtype` 设置（默认：各模型自带的 dtype，目前为 `q4`；支持 `auto`、`fp32`、`fp16`、`q8`、`int8`、`uint8`、`q4`、`bnb4`、`q4f16`、`q2`、`q2f16`、`q1`、`q1f16`） |
| `PI_NO_INTERLEAVED_THINKING` | 若为 `1`，禁用 Anthropic 交错思考预算行为，并对旧版思考模式使用输出 token 膨胀 |
| `PI_NO_THINKING_LOOP_GUARD` | 若为 `1`，禁用模型思考循环保护 |
| `NULL_PROMPT` | 若为 `true`，系统提示词构建器返回空字符串 |
| `PI_BLOCKED_AGENT` | 在任务工具中阻止特定的子 agent 类型 |
| `PI_SUBPROCESS_CMD` | 覆盖子 agent 的派生命令（绕过 `omp` / `omp.cmd` 解析） |
| `PI_TASK_MAX_OUTPUT_BYTES` | 每个子 agent 可捕获的最大输出字节数（默认 `500000`） |
| `PI_TASK_MAX_OUTPUT_LINES` | 每个子 agent 可捕获的最大输出行数（默认 `5000`） |
| `PI_WALK_WORKERS` | `omp grep` 遍历器及相关并行遍历（`pi-walker`）使用的文件系统遍历工作线程数（默认 `4`；`0` = 自动检测，`1` = 串行）。由 `PI_GREP_WORKERS` 改名而来；不再读取旧名称 |
| `PI_TIMING` | 若设置（任何非空值），则通过 `logger.printTimings()` 向 **stderr** 打印层级化的计时 span 树。交互模式下，agent 就绪后（TUI 启动前）打印一次；print 模式下，在整个提示词批次完成后打印。print 模式的提示词会包在 `print:prompt:initial` / `print:prompt:next` span 中，因此每条用户消息都显示为独立的一行。`PI_TIMING=x` 会在交互模式下打印完成后立即以退出码 0 退出进程（仅用于测量冷启动）。`PI_TIMING=full` 会列出每个模块加载条目，而不仅是前 N 条。 |
| `PI_DEBUG_STARTUP` | 若设置（任何非空值），则在每个启动阶段开始/结束时向 **stderr** 同步输出一行 `[startup] <phase>:start` / `:done` 标记——包括命令模块导入（`cli:load:<name>`）以及 native addon 解压/`dlopen`（`native:*`）。与 `PI_TIMING`（只在启动完成后打印）不同，这些标记在进程硬性卡死时依然存在：stderr 的最后一行会指明进程卡在哪个阶段。可与 `PI_TIMING` 自由组合；标记与 span 树使用相同的阶段名称。 |
| `PI_PACKAGE_DIR` | 覆盖包资源基础目录的解析（`docs/`、`examples/`、`CHANGELOG.md`） |
| `OMP_SKIP_SETUP` | 除 `0`、`false` 或 `no` 之外的任何非空值都会跳过自动交互式设置场景；显式强制执行设置时会忽略该变量 |
| `PI_DISABLE_LSPMUX` | 若为 `1`，禁用 lspmux 检测/集成，并强制直接派生 LSP 服务器 |
| `PI_RPC_EMIT_TITLE` | 在 RPC 模式下启用标题事件的布尔型标志 |
| `SMITHERY_URL` | Smithery 网页 URL 覆盖（默认 `https://smithery.ai`） |
| `SMITHERY_API_URL` | Smithery API 基础 URL 覆盖（默认 `https://api.smithery.ai`） |
| `SMITHERY_API_KEY` | 用于托管 MCP 认证查找的 Smithery API key |
| `PUPPETEER_EXECUTABLE_PATH` | Eval 浏览器运行时的 Chromium 可执行文件覆盖 |
| `LITELLM_BASE_URL` | LiteLLM 代理基础 URL 回退（未设置时为 `http://localhost:4000/v1`）；显式的 `providers.litellm.baseUrl` / `models.yml` 配置优先 |
| `LM_STUDIO_BASE_URL` | 默认隐式 LM Studio 发现基础 URL 覆盖（未设置时为 `http://127.0.0.1:1234/v1`） |
| `OLLAMA_BASE_URL` | 默认隐式 Ollama 发现基础 URL 覆盖（未设置时使用 `OLLAMA_HOST`，再退到 `http://127.0.0.1:11434`） |
| `OLLAMA_HOST` | 在 `OLLAMA_BASE_URL` 未设置时用于隐式 Ollama 发现的 Ollama 主机；接受 Ollama 风格的值，如 `127.0.0.1:11434` 或 `http://host:11434` |
| `OLLAMA_CONTEXT_LENGTH` | 隐式 Ollama 发现的正整数上下文窗口覆盖；仅影响 OMP 的上下文预算，不会更改 Ollama 运行时的 `num_ctx` |
| `LLAMA_CPP_BASE_URL` | 默认隐式 Llama.cpp 发现基础 URL 覆盖（未设置时为 `http://127.0.0.1:8080`） |
| `PI_EDIT_VARIANT` | 在值有效时强制编辑工具变体（`patch`、`replace`、`hashline`、`apply_patch`） |
| `PI_INTENT_TRACING` | 工具意图元数据的布尔型覆盖；回退到 `tools.intentTracing` |
| `PI_STRICT_EDIT_MODE` | 若为 `1`，禁用内建的按模型编辑模式回退，因此除非被 `PI_EDIT_VARIANT` 或 `edit.modelVariants` 覆盖，否则使用配置的/全局的 `edit.mode` |
| `PI_FORCE_IMAGE_PROTOCOL` | 在使用处强制受支持的图像协议（`kitty`、`iterm2`/`iterm`、`sixel`、`none`）。在 tmux 内设置 `kitty` 还会启用 Kitty Unicode 占位符放置，除非 `PI_KITTY_PLACEHOLDERS=0` 或 `PI_NO_KITTY_PLACEHOLDERS=1` 将其禁用 |
| `PI_ALLOW_SIXEL_PASSTHROUGH` | 在 `PI_FORCE_IMAGE_PROTOCOL=sixel` 时允许 SIXEL 透传 |
| `PI_NO_PTY` | 若为 `1`，禁用 bash 工具的交互式 PTY 路径 |
| `OMP_MCP_TIMEOUT_MS` | 覆盖每个 MCP 服务器的 MCP 客户端请求超时（毫秒）。`0` 禁用客户端侧超时（`AbortSignal` 永不触发）。无效（负数或非数字）值会在给出警告后被忽略，并使用每服务器配置或默认值（`30000`）。 |
| `PI_DISABLE_UUTILS_BUILTINS` | 除 `0`/`false` 之外的非空值会禁用 bash 工具的 uutils 内建命令；`shell.env.PI_DISABLE_UUTILS_BUILTINS` 优先 |
| `OMP_NO_WEBP` | `1` 或 `true`（不区分大小写）在图像缩放格式选择中禁用 WebP |
| `MNEMOPI_EMBEDDING_MODEL` | 在未提供显式覆盖时，mnemopi 记忆配置使用的嵌入模型覆盖 |
| `PI_AUTO_QA` | 自动工具问题报告注入/记录的最高优先级布尔标志（其次查阅 `dev.autoqa` 设置）；`0`/`false` 禁用，`1`/`true` 强制开启 |
| `PI_AUTO_QA_PUSH` | `1`/`true` 绕过同意对话框，在无头/非交互环境中强制进行工具问题推送记录 |
| `PI_AUTO_QA_PUSH_URL` | 自动 QA grievance 推送的端点覆盖；优先于 `dev.autoqaPush.endpoint` 设置 |
| `PI_BROWSER_RELAY` | 浏览器中继的 `0`/`1` 停用开关；覆盖 `browser.relay` 设置（当 Eval 的浏览器 API 需要时，中继会自动启动） |

### Hindsight 记忆后端

`loadHindsightConfig()` 对每个受支持的环境覆盖先在对应的 `hindsight.*` 设置之上解析，再落到其内建默认值。字符串值会去除首尾空白，空字符串会被忽略。布尔值不区分大小写：只有 `true`、`1` 和 `yes` 表示真；任何其他已定义的值都表示假。整数值使用十进制 `parseInt`；非数字值会被忽略，且加载器不会对解析得到的整数做钳制。枚举值必须与所列小写值之一完全匹配；无效值会被忽略。

| 变量 | 被覆盖的设置 | 接受的值 / 内建默认值 |
| --- | --- | --- |
| `HINDSIGHT_API_URL` | `hindsight.apiUrl` | 非空字符串；默认 `http://localhost:8888` |
| `HINDSIGHT_API_TOKEN` | `hindsight.apiToken` | 非空字符串；默认未设置 |
| `HINDSIGHT_BANK_ID` | `hindsight.bankId` | 非空字符串；默认未设置，bank 由所选的范围模式派生 |
| `HINDSIGHT_BANK_MISSION` | `hindsight.bankMission` | 非空字符串；默认为空字符串 |
| `HINDSIGHT_RETAIN_MODE` | `hindsight.retainMode` | `full-session` 或 `last-turn`；默认 `full-session` |
| `HINDSIGHT_RECALL_BUDGET` | `hindsight.recallBudget` | `low`、`mid` 或 `high`；默认 `mid` |
| `HINDSIGHT_AUTO_RECALL` | `hindsight.autoRecall` | 布尔值；默认 `true` |
| `HINDSIGHT_AUTO_RETAIN` | `hindsight.autoRetain` | 布尔值；默认 `true` |
| `HINDSIGHT_SCOPING` | `hindsight.scoping` | `global`、`per-project` 或 `per-project-tagged`；默认 `per-project-tagged` |
| `HINDSIGHT_DEBUG` | `hindsight.debug` | 布尔值；默认 `false` |
| `HINDSIGHT_RECALL_MAX_TOKENS` | `hindsight.recallMaxTokens` | 整数；默认 `1024` |
| `HINDSIGHT_RECALL_CONTEXT_TURNS` | `hindsight.recallContextTurns` | 整数；默认 `1` |
| `HINDSIGHT_RECALL_MAX_QUERY_CHARS` | `hindsight.recallMaxQueryChars` | 整数；默认 `800` |
| `HINDSIGHT_RETAIN_EVERY_N_TURNS` | `hindsight.retainEveryNTurns` | 整数；默认 `3` |
| `HINDSIGHT_REQUEST_TIMEOUT_MS` | `hindsight.requestTimeoutMs` | 整数毫秒；默认 `30000` |
| `HINDSIGHT_REFLECT_TIMEOUT_MS` | `hindsight.reflectTimeoutMs` | 整数毫秒；默认 `120000` |
| `HINDSIGHT_RECALL_TIMEOUT_MS` | `hindsight.recallTimeoutMs` | 整数毫秒；默认 `30000` |
| `HINDSIGHT_RETAIN_TIMEOUT_MS` | `hindsight.retainTimeoutMs` | 整数毫秒；默认 `60000` |

使用 CLI `--no-pty` 时，`PI_NO_PTY` 也会被内部设置。

---

## 6) 存储与配置根路径

这些变量影响 coding-agent 存储数据的位置，以及它加载哪些进程本地的设置覆盖层。

| 变量 | 默认 / 行为 |
| --- | --- |
| `OMP_PROFILE` | 规范的命名 profile 选择器；即使显式为空也优先于 `PI_PROFILE` |
| `PI_PROFILE` | 旧版 profile 选择器，仅在 `OMP_PROFILE` 未定义时使用 |
| `PI_CONFIG_DIR` | 家目录下配置根目录的目录名（默认 `.omp`） |
| `PI_CODING_AGENT_DIR` | 仅对默认 profile 生效的完整 agent 目录覆盖；命名 profile 会忽略它 |
| `PI_CODING_AGENT_SESSION_DIR` | 由启动参数解析消费的初始会话目录覆盖 |
| `PI_CONFIG_FILES` | 设置覆盖层的平台路径列表（Unix 上为 `:`，Windows 上为 `;`）；在显式 `--config` 覆盖之前按顺序加载 |
| `OMP_AUTORESEARCH_DB_DIR` | 每项目 autoresearch 数据库与项目产物根目录的目录覆盖 |
| `XDG_DATA_HOME`、`XDG_STATE_HOME`、`XDG_CACHE_HOME` | 在 macOS/Linux 上，仅当目标 `omp` 根目录（或命名 profile 根目录）已存在时才重定向对应的 OMP 路径 |
| `PWD` | 在路径辅助函数中匹配规范化当前工作目录时使用 |
| `OMP_WORKTREE_DIR` | agent 管理的工作树目录覆盖（默认 `~/.omp/wt`）；必须为绝对路径或 `~` 相对路径，相对路径会被忽略；优先于 `worktree.base` 设置 |
| `OMP_GITHUB_CACHE_DB` | 覆盖 GitHub 视图缓存数据库路径（默认 `~/.omp/cache/github-cache.db`） |

---

## 7) Shell/工具执行环境

（来自 `packages/utils/src/procmgr.ts` 与 coding-agent 的 bash 工具集成。）

| 变量 | 行为 |
| --- | --- |
| `PI_BASH_NO_CI` | 抑制向派生 shell 环境自动注入 `CI=true` |
| `CLAUDE_BASH_NO_CI` | `PI_BASH_NO_CI` 的旧版别名回退 |
| `PI_BASH_NO_LOGIN` | 禁用 login shell 模式；shell 参数变为 `['-c']` 而不是 `['-l','-c']` |
| `CLAUDE_BASH_NO_LOGIN` | `PI_BASH_NO_LOGIN` 的旧版别名回退 |
| `PI_SHELL_PREFIX` | 可选的命令前缀包装器 |
| `CLAUDE_CODE_SHELL_PREFIX` | `PI_SHELL_PREFIX` 的旧版别名回退 |
| `VISUAL` | 首选外部编辑器命令 |
| `EDITOR` | 回退外部编辑器命令 |

当前实现：`PI_BASH_NO_LOGIN`/`CLAUDE_BASH_NO_LOGIN` 处于生效状态；任一被设置时，`getShellArgs()` 返回 `['-c']`。

`PI_BASH_NO_CI`、`PI_BASH_NO_LOGIN` 和 `PI_SHELL_PREFIX` 仅在规范变量未设置时才使用各自的 `CLAUDE_*` 别名。

---

## 8) UI/主题/会话检测（自动检测的环境变量）

这些变量作为运行时信号读取；通常由终端/操作系统设置，而非手动配置。

| 变量 | 用途 |
| --- | --- |
| `COLORTERM`、`TERM`、`WT_SESSION` | 颜色能力检测（主题颜色模式） |
| `COLORFGBG` | 终端背景明暗自动检测 |
| `TERM_PROGRAM`、`TERM_PROGRAM_VERSION`、`TERMINAL_EMULATOR` | 系统提示词/上下文中的终端标识 |
| `TMUX_PANE`、`CMUX_SURFACE_ID`、`KITTY_WINDOW_ID`、`TERM_SESSION_ID`、`WT_SESSION` | 稳定的每终端会话面包屑 ID |
| `SHELL`、`ComSpec`、`TERM_PROGRAM`、`TERM` | 系统信息诊断 |
| `APPDATA`、`XDG_CONFIG_HOME` | lspmux 配置路径解析 |
| `HOME` | MCP 命令 UI 中的路径缩短显示 |

`COPILOT_HOME` 覆盖 GitHub Copilot 配置主目录（默认 `~/.copilot`），`COPILOT_CUSTOM_INSTRUCTIONS_DIRS` 提供额外的逗号分隔指令目录。`JS_DEBUG_DAP_SERVER` 选择一个已存在的 JavaScript 调试适配器服务器；`XDG_DATA_HOME` 也参与捆绑调试器的发现。

---

## 9) TUI 运行时标志（共享包，影响 coding-agent UX）

| 变量 | 行为 |
| --- | --- |
| `PI_NOTIFICATIONS` | `off` / `0` / `false` 抑制桌面通知 |
| `PI_TUI_WRITE_LOG` | 若设置，则将 TUI 写入记录到文件 |
| `PI_TUI_RAW_BACKSPACE_IS_CTRL` | 若为 `1`，将原始 `0x08` 解释为 Ctrl+Backspace 而不是 Backspace；适用于 SSH/容器跳转隐藏了 Windows Terminal 客户端的场景 |
| `PI_HARDWARE_CURSOR` | 若为 `1`，启用硬件光标模式 |
| `PI_NO_SYNC_OUTPUT` | 若设置（任何非空值），禁用 DEC 2026 同步输出包装，同时保留 TUI 自动换行保护 |
| `PI_NO_DECCARA` | 若设置（真值），禁用 Kitty DECCARA 矩形 SGR 背景填充（强制使用填充字符串渲染） |
| `PI_DEBUG_REDRAW` | 若为 `1`，启用重绘调试日志 |
| `PI_FORCE_IMAGE_PROTOCOL` | 强制终端图像协议检测（`kitty`、`iterm2`/`iterm`、`sixel`、`none`）。在终端复用器内设置 `kitty` 还会启用 Kitty Unicode 占位符放置，除非 `PI_KITTY_PLACEHOLDERS=0` 或 `PI_NO_KITTY_PLACEHOLDERS=1` 将其禁用 |
| `PI_KITTY_PLACEHOLDERS` | `1` 强制开启 Kitty Unicode 占位符放置；`0` 强制关闭。在终端复用器下，仅在确认外层终端支持 Kitty `U=1` 占位符后才使用 `1`——否则 U+10EEEE 可能渲染为字面 PUA 方块 |
| `PI_NO_KITTY_PLACEHOLDERS` | `1` 硬性禁用 Kitty Unicode 占位符放置，并优先于 `PI_KITTY_PLACEHOLDERS` |
| `PI_TUI_RESIZE_IN_PLACE` | `1`/`true` 强制就地调整大小（不借用 alt-screen，不做 ED3 重排）；`0`/`false` 强制走 alt-screen 快速路径。对 Warp 默认开启，因为它在切换 alt-screen 时会重新报告自身尺寸——但在 ConPTY 宿主（Windows，以及经 `wslhost` 的 WSL）上例外，那里由 conhost 拥有字符网格并在调整大小时重绘自己的视口，因此锚点无法恢复 |

### 浏览器启动/代理控制

| 变量 | 行为 |
| --- | --- |
| `PUPPETEER_PROXY` | 添加 Chromium 的 `--proxy-server` 启动参数 |
| `PUPPETEER_PROXY_BYPASS_LOOPBACK` | 布尔型标志，将 `<-loopback>` 加入绕过列表，使 localhost 也走代理 |
| `PUPPETEER_PROXY_IGNORE_CERT_ERRORS` | 布尔型标志，启动 Chromium 时忽略证书错误 |
| `CMUX_WORKSPACE_ID`、`CMUX_SURFACE_ID` | 浏览器打开分屏时的目标 cmux 工作区/surface |
| `CMUX_RELAY_ID`、`CMUX_RELAY_TOKEN` | cmux 中继身份/认证回退 |

---

## 10) Commit 生成控制

| 变量 | 行为 |
| --- | --- |
| `PI_COMMIT_TEST_FALLBACK` | 若为 `true`（不区分大小写），强制走 commit 回退生成路径 |
| `PI_COMMIT_NO_FALLBACK` | 若为 `true`，在 agent 未返回提案时禁用回退 |
| `PI_COMMIT_MAP_REDUCE` | 若为 `false`，禁用 map-reduce commit 分析路径 |
| `DEBUG` | 若设置，则打印 commit agent 错误的堆栈跟踪 |

---

## 11) OpenTelemetry 导出

仅当至少一个信号配置了端点时，OMP 才初始化 OTLP 导出。`OTEL_SDK_DISABLED=true` 会禁用初始化。

| 变量组 | 行为 |
| --- | --- |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | 通用端点回退 |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`、`OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`、`OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` | 按信号的端点；优先于通用端点 |
| `OTEL_TRACES_EXPORTER`、`OTEL_LOGS_EXPORTER`、`OTEL_METRICS_EXPORTER` | 列表中包含 `none` 会禁用该信号 |
| `OTEL_EXPORTER_OTLP_PROTOCOL` 以及按信号的 `..._PROTOCOL` 变体 | 此运行时仅启用 `http/protobuf`；显式指定其他协议会禁用该信号 |
| `OTEL_SERVICE_NAME`、`OTEL_RESOURCE_ATTRIBUTES` | OpenTelemetry 资源元数据 |
| `OTEL_LOG_LEVEL` | 导出的 OMP 日志最低级别 |

---

## 安全敏感变量

请将这些视为机密；不要记录或提交它们：

- Provider/API 密钥以及 OAuth/bearer 凭证（所有 `*_API_KEY`、`*_TOKEN`、OAuth 访问/刷新令牌）
- 云凭证（`AWS_*`、`GOOGLE_APPLICATION_CREDENTIALS` 路径可能暴露服务账户材料）
- 搜索/provider 认证变量（`EXA_API_KEY`、`BRAVE_API_KEY`、`PERPLEXITY_API_KEY`、Anthropic 搜索密钥）
- Foundry mTLS 材料（`CLAUDE_CODE_CLIENT_CERT`、`CLAUDE_CODE_CLIENT_KEY`，以及指向私有 CA 集时的 `NODE_EXTRA_CA_CERTS`）

Python 运行时在派生内核子进程之前也会显式剥离许多常见的密钥变量（`packages/coding-agent/src/eval/py/runtime.ts`）。
