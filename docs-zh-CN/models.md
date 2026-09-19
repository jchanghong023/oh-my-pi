# 模型与 provider 配置（`models.yml` / `models.yaml`）

本文档描述 coding-agent 当前如何加载模型、应用覆盖、解析凭据以及在运行时选择模型。

## 哪些因素控制模型行为

主要实现文件：

- `packages/coding-agent/src/config/model-registry.ts` — 加载内置 + 自定义模型、provider 覆盖、运行时发现、认证集成
- `packages/coding-agent/src/config/model-resolver.ts` — 解析模型 pattern 并选择 initial/smol/slow 模型
- `packages/coding-agent/src/config/settings-schema.ts` — 模型相关设置（`modelRoles`、provider transport 偏好）
- `packages/coding-agent/src/session/auth-storage.ts` — 从 `@oh-my-pi/pi-ai` 重新导出 `AuthStorage`；API key + OAuth 解析顺序
- `packages/catalog/src/models.ts` 和 `packages/catalog/src/types.ts` — 内置 providers/models 和公开的 model 类型

## 配置文件位置与旧行为

默认配置路径（按优先级顺序）：

- `~/.omp/agent/models.yml`
- `~/.omp/agent/models.yaml`

仍然存在的旧行为：

- 如果两个 YAML 文件都不存在，且同一位置存在 `models.json`，则会将其迁移为 `models.yml`。
- 当以编程方式传递给 `ModelRegistry` 时，显式的 `.json` / `.jsonc` 配置路径仍然受支持。

## `models.yml` / `models.yaml` 形态

```yaml
providers:
  <provider-id>:
    # provider-level config
```

`provider-id` 是在模型选择与认证查找中通用的规范 provider key。

根对象目前只包含 `providers`；未知的根 key 会导致 schema 校验失败。

## provider 级字段

```yaml
providers:
  my-provider:
    baseUrl: https://api.example.com/v1
    apiKey: MY_PROVIDER_API_KEY
    api: openai-completions
    headers:
      X-Team: platform
    authHeader: true
    auth: apiKey
    disableStrictTools: false # set true for Anthropic-compatible endpoints that reject the strict field
    discovery:
      type: ollama
      timeoutMs: 10000 # optional per-provider HTTP probe timeout in milliseconds
    modelOverrides:
      some-model-id:
        name: Renamed model
    models:
      - id: some-model-id
        name: Some Model
        api: openai-completions
        reasoning: false
        input: [text]
        imageInputDecoder: stb # local STB decoder; OMP converts WebP before dispatch
        cost:
          input: 0
          output: 0
          cacheRead: 0
          cacheWrite: 0
        contextWindow: 128000
        maxTokens: 16384
        headers:
          X-Model: value
        compat:
          supportsStore: true
          supportsDeveloperRole: true
          supportsReasoningEffort: true
          maxTokensField: max_completion_tokens
          openRouterRouting:
            only: [anthropic]
          vercelGatewayRouting:
            order: [anthropic, openai]
          extraBody:
            gateway: m1-01
            controller: mlx
```

### 压缩选项

- `compactionModel`（按 model，包括 `modelOverrides`）— 当该 model 的 session 被压缩时，用于总结/压缩上下文的模型选择器，而不是使用该模型本身。
- `remoteCompaction`（provider 级或按 model）— 让符合条件的模型使用 provider 原生压缩。支持的 key：`enabled`、`api`、`endpoint`、`model`、`v2StreamingEnabled`、`v2Endpoint`、`streamingEndpoint`。provider 级设置为基线；按模型的 key 会覆盖它们。

### 允许的 provider/model `api` 取值

- `openai-completions`
- `openai-responses`
- `openai-codex-responses`
- `azure-openai-responses`
- `anthropic-messages`
- `bedrock-converse-stream`
- `google-generative-ai`
- `google-gemini-cli`
- `google-vertex`

### 允许的 auth/discovery 取值

- `auth`：`apiKey`（默认）、`none` 或 `oauth`；对于 `models.yml` 中的自定义模型，schema 接受 `oauth`，但不会豁免 `apiKey` 的要求
- `discovery.type`：`ollama`、`llama.cpp`、`lm-studio`、`openai-models-list`、`proxy` 或 `litellm`
- `discovery.injectV1`：可选布尔值，默认 `true`，用于 `openai-models-list`。设置为 `false` 时，将从 `{baseUrl}/models` 获取模型列表而不注入 `/v1` —— 适用于把 OpenAI 兼容接口根植于带版本路径的网关（例如 `https://api.opper.ai/v3/compat`），在这些网关上强制使用 `/v1/models` 会返回一份不同且更小的模型列表。`baseUrl` 中的查询字符串会被忽略，与默认模式一致。
- `transport`：仅 `pi-native`。设置后，该 provider 下的每个模型都会通过 `POST /v1/pi/stream` 发送到与 `omp auth-gateway` 兼容的 `baseUrl`；`apiKey` 即为 gateway 的 bearer。
- `imageInputDecoder`：仅 `stb`。当服务后端使用无法接受 WebP 的 STB 兼容图像解码器时，在自定义模型或 `modelOverrides` 条目上设置此字段；OMP 会在 provider dispatch 之前转换所附加的以及历史消息中的 WebP 图像。
- `tokenizer`：当代理的 model id 模糊或非规范时，可选择使用特定的嵌入式本地 tokenizer。允许的值：`claude-v3`、`claude-v47`、`claude-v5`、`claude-v5-sonnet`、`qwen3`、`deepseek-v3`、`kimi-k2` 和 `glm5`。省略时使用 catalog identity 策略；未知模型保留快速本地估算。

## 校验规则（当前）

### 完整自定义 provider（`models` 非空）

必填：

- `baseUrl`
- 除非 `auth: none`，否则需要 `apiKey`
- 在 provider 级或每个 model 上设置 `api`

### 仅覆盖型 provider（`models` 缺失或为空）

必须定义以下至少一项：

- `baseUrl`
- `apiKey`
- `auth: none`
- `headers`
- `compat`
- `disableStrictTools`
- `modelOverrides`
- `discovery`
- `remoteCompaction`

### 发现

- `discovery.timeoutMs` 会覆盖该 provider 运行时 HTTP 探测超时（毫秒）。它必须是正的有限数。
- `discovery` 要求在 provider 级设置 `api`，但 `discovery.type: proxy` 除外（按模型自动检测线路）。

### 远程压缩

对于仅覆盖型 provider，`remoteCompaction` 单独就足够了。
它支持 `enabled`、`api`、`endpoint`、`model`、`v2StreamingEnabled`、
`v2Endpoint` 和 `streamingEndpoint`。

### 模型取值检查

- `id` 必填
- 如果提供了 `contextWindow` 和 `maxTokens`，它们必须为正数

### 由命令解析的 secret

provider 的 `apiKey` 值以及 provider/model 的 `headers` 值可以以 `!` 开头，以便从命令的 stdout 读取 secret。命令以 10 秒超时异步运行；stdout 会被裁剪首尾空白，空输出或执行失败的命令会被忽略。加载或查看 catalog 不会执行它们：凭据只在请求或在线凭据探测需要时才会解析。

```yaml
providers:
  openai:
    apiKey: "!op read op://dev/openai/api-key"
    headers:
      X-Team-Key: "!bw get password omp-team-key"
```

成功的命令输出会在进程生命周期内被缓存，并发请求会共享同一次进行中的执行。失败会退避 30 秒。显式的模型刷新或 401 凭据刷新会使相关的已缓存 API key 和 headers 失效。运行时的 API key 覆盖（包括 `--api-key`）优先于已配置的凭据。

## 合并与覆盖顺序

ModelRegistry 流程（在 refresh 时）：

1. 从 `@oh-my-pi/pi-catalog` 加载内置 providers/models（`getBundledProviders` / `getBundledModels`）。
2. 加载 `models.yml` / `models.yaml` 自定义配置。
3. 将 provider 覆盖（`baseUrl`、`headers`、`disableStrictTools`）应用到内置模型。
4. 应用 `modelOverrides`（按 provider + model id）。
5. 合并自定义 `models`：
   - 相同的 `provider + id` 替换已有项
   - 否则追加
6. 加载已缓存以及运行时发现的模型。这包括本地服务器、内置 provider 管理器，以及针对已知 provider 的共享 models.dev catalog。合并之后再次应用 model overrides。

### Provider-model 缓存与静态指纹

按 provider 缓存的模型列表会持久化到 model-cache SQLite
数据库（当前 schema 版本为 12），其中包含一个 `static_fingerprint` 列，
用于对合并到该行中的静态 catalog 切片进行哈希。当 `resolveProviderModels`
跳过网络获取，并且内存中静态 catalog 的指纹与缓存一致时，
缓存的行会原样返回——完全跳过静态 + 动态合并。
该指纹在每个进程中通过给 static-models 数组打上一个 symbol 属性进行记忆化，
因此重复的冷启动调用不会重新计算哈希。

### 共享 catalog 刷新

内置 catalog 仍是启动时与离线时的基线。启动时同步加载内置行与缓存行之后，现有的后台刷新生命周期会为已知 provider 获取当前的共享 models.dev catalog。新的 model id 会以追加方式合并到各 provider 的内置切片中，经该 provider 的 catalog descriptor 归一化，并持久化到 model-cache 数据库中。这使得新发布的模型无需等待新的 OMP 二进制即可出现。

远程行可以为新加入的 id 提供当前的限制、价格、模态和能力标志，但它们无法引入代码、任意 header 或未注册的 provider。成功的 provider 端点发现对账户可用性仍然具有权威性。共享 catalog 不具有权威性：当某个远程行消失时，它不会移除内置模型。

新鲜的缓存快照可以避免网络请求。如果刷新失败，OMP 会保留最后一份可用的缓存快照并将其标记为过期；没有缓存时，则回退到内置 catalog。provider 发现状态会记录 `source`（`bundled`、`models.dev`、`provider` 或 `cache`）和 `fetchedAt`，以便调用方区分当前远程数据与离线回退数据。

## provider 与 model 标识

注册表保留具体的 `provider` + `id` 标识。当同一 model id 存在于多个 provider 下时，请使用精确的
`provider/modelId` 选择器。Session 状态
和会话记录会记录执行该轮的具体 provider/model。

provider 默认值 vs per-model 覆盖：

- provider 的 `headers`、`compat` 和 `remoteCompaction` 作为基线。
- model 的 `headers` 会覆盖 provider 的 header key。
- `modelOverrides` 可以覆盖 model 元数据（`name`、`reasoning`、`thinking`、`input`、`imageInputDecoder`、
  `tokenizer`、`supportsTools`、`cost`、`premiumMultiplier`、`contextWindow`、`maxTokens`、
  `omitMaxOutputTokens`、`headers`、`compat`、`contextPromotionTarget`、`compactionModel` 以及
  `remoteCompaction`）。
- 嵌套路由块（`openRouterRouting`、`vercelGatewayRouting`、
  `extraBody` 和 `whenThinking`）的 `compat` 会进行深度合并。

## 使用成本与基于时间的定价

OMP 根据所选 provider/model 的 catalog 价格估算 token 成本，并在可用时优先采用服务端报告的金额成本。已完成的消息会保留其记录的成本：跨越定价边界、切换模型或重新打开会话都不会重新计算累积用量。

对于第一方 `deepseek` provider，catalog 遵循 [DeepSeek 官方定价](https://api-docs.deepseek.com/quick_start/pricing)：

- 高峰时段为 **周一至周五 01:00–04:00 和 06:00–10:00 UTC**（起始含、结束不含）。其他所有时间（包括周末）按**高峰费率的 50%** 计费。
- Flash 定价覆盖 `deepseek-flash` 以及已退役但仍被接受的 `deepseek-v4-flash` 和 `deepseek-v4-flash-vision-exp` id，全部按 Flash 费率卡计费。每百万 token 的高峰费率为未缓存输入 $0.30、缓存输入 $0.006、输出 $1.20。
- `deepseek-v4-pro` 最初使用每百万 token 未缓存输入 $1.32、缓存输入 $0.044、输出 $3.96 的高峰费率。从 **2026-09-14 04:00 UTC** 起，其估算改用 Flash 费率卡，并沿用相同的高峰/非高峰时间表。

本地估算使用 assistant 消息的**请求开始时间戳**为整个请求同时选择费率卡和费率档。这是 OMP 的估算约定：DeepSeek 的定价页面并未规定其服务器如何对跨越边界的请求计费。无法恢复时间戳的请求会被留作未计价，而不会依据墙上时钟所选的费率档进行估算。

状态栏的 `cost` 片段会针对**当前生效的 provider/model**，按当前墙上时钟在高峰时附加 **↑**、非高峰时附加 **↓**。它会在费率边界处刷新，即使处于空闲状态也是如此；该箭头并不是对已累积会话总量的标注。没有时间表定价的模型（包括显式的固定价格覆盖）不显示箭头。

在 `models.yml` 中（包括 `modelOverrides`）显式设置的 model `cost` 属于固定价格覆盖，会禁用该 model 继承的基于时间的定价。省略 `cost` 则保留 catalog 定价。`models.yml` **不**接受 `timeBased` 时间表；该元数据属于 catalog 的 [KDL 定价规则](../packages/catalog/src/compat/rules/README.md#time-based-pricing)。

`models.yml` 中省略 `cost` 的自定义模型会继承其参考行的费率卡（包括时间表）。该查找以 model id 为键，并优先选择限制最宽的行，因此 `deepseek-v4-flash` 解析到某个经销商的固定费率卡，而 `deepseek-flash` 解析到带时间表的第一方费率卡。被发现的代理与 gateway 模型则相反：它们的定价是 provider 特定的，很少与内置 catalog 匹配，因此发现会让它们保持本地未知的零成本，也不会对它们应用任何费率档。

## 运行时发现集成

### 隐式 Ollama 发现

如果未显式配置 `ollama`，注册表会添加一个隐式的可发现 provider：

- provider：`ollama`
- api：`openai-responses`
- base URL：`OLLAMA_BASE_URL`，或 `OLLAMA_HOST`，或 `http://127.0.0.1:11434`
- context window：如果设置了 `OLLAMA_CONTEXT_LENGTH`，则使用其值；否则使用 Ollama `/api/show` 元数据；否则为 `128000`
- auth 模式：无 key（`auth: none` 行为）

运行时发现会调用 Ollama 端点，并将发现的 OpenAI 兼容模型归一化为 `openai-responses`。

`OLLAMA_CONTEXT_LENGTH` 不会配置 Ollama 运行时的 `num_ctx`；请在 Ollama/model 配置中单独设置。

### 隐式 llama.cpp 发现

如果未显式配置 `llama.cpp`，注册表会添加一个隐式的可发现 provider：

- provider：`llama.cpp`
- api：`openai-responses`
- base URL：`LLAMA_CPP_BASE_URL` 或 `http://127.0.0.1:8080`
- auth 模式：无 key（`auth: none` 行为）

运行时发现会调用 llama.cpp model 端点，并使用本地默认值合成 model 条目。

### 隐式 LM Studio 发现

如果未显式配置 `lm-studio`，注册表会添加一个隐式的可发现 provider：

- provider：`lm-studio`
- api：`openai-completions`
- base URL：`LM_STUDIO_BASE_URL` 或 `http://127.0.0.1:1234/v1`
- auth 模式：无 key（`auth: none` 行为）

运行时发现会获取模型（`GET /models`），并使用本地默认值合成 model 条目。

该路径也适用于并非 LM Studio 的本地 OpenAI 兼容服务器。例如，如果 oMLX 绑定到 Ollama 常用的端口，可设置 `LM_STUDIO_BASE_URL=http://127.0.0.1:11434/v1`，以通过现有的 `/v1/models` 流程发现它。同时运行 oMLX 和 Ollama 需要为其中之一分配不同的端口。不要将 oMLX 配置为 `ollama`：Ollama 发现使用原生的 `/api/tags` 和 `/api/show` 端点，而不是 OpenAI 的 `/v1/models`。

### LiteLLM provider 发现

当 `litellm` 处于活动状态时（例如通过 `LITELLM_API_KEY` 或已存储的认证），运行时发现会使用 LiteLLM 代理：

- provider：`litellm`
- api：对于 OpenAI 后端模型为 `openai-responses`；其他模型为 `openai-completions`
- base URL：显式 provider 的 `baseUrl` / `models.yml` 配置，否则为 `LITELLM_BASE_URL`，否则为 `http://localhost:4000/v1`
- auth 模式：当代理需要 key 时，使用 `LITELLM_API_KEY` 或已存储的 LiteLLM 认证

运行时发现按以下顺序探测 LiteLLM 管理元数据：`GET /model_group/info`、`GET /v2/model/info`、`GET /model/info` 和 `GET /v1/model/info`。所配置的 key 必须被授权至少可读其中一条路由；在限制管理端点的部署上，可通过 LiteLLM 的 `allowed_routes` 访问控制授予该路由，或使用 master/admin key 进行发现。

如果每条元数据路由都不可用，发现会回退到 OpenAI 兼容的 `GET /models` 列表。被禁止或失败的元数据请求会以端点和状态各记录一次；`404` 被视为路由不存在。两条路径都会排除被显式标记为已知任务特定 LiteLLM mode 的模型：`audio_speech`、`audio_transcription`、`batch`、`embedding`、`guardrail`、`image_edit`、`image_generation`、`moderation`、`ocr`、`rerank`、`search`、`vector_store` 和 `video_generation`。缺失、为 null 以及无法识别的 mode 仍可被选择，以便 router 别名继续可用。丰富的元数据会映射每个模型的 context、capability 和 upstream-provider 字段。OpenAI 后端的模型使用 LiteLLM 的 Responses 路由，以便 reasoning 摘要保持可用；混合 provider 的组继续使用 Chat Completions。裸回退 id 使用已知的 OpenAI model 系列进行路由，并在可用时使用打包的参考元数据。因此，在回退之后，缺少打包 catalog 的模型可能具有未知的 context 和价格。

### 显式 provider 发现

你可以自行配置发现：

```yaml
providers:
  ollama:
    baseUrl: http://127.0.0.1:11434
    api: openai-responses
    auth: none
    discovery:
      type: ollama

  llama.cpp:
    baseUrl: http://127.0.0.1:8080
    api: openai-responses
    auth: none
    discovery:
      type: llama.cpp
```

自定义 LiteLLM gateway 也可以使用同一丰富的发现路径：

```yaml
providers:
  litellm-gateway:
    baseUrl: http://gateway.example:4000/v1
    apiKey: LITELLM_API_KEY
    api: openai-completions
    discovery:
      type: litellm
```

LiteLLM 元数据端点使用配置的 base URL，仅在发现时剥离末尾的 `/v1`，并保留其前面的代理路径。运行时的模型调用会保留配置的 OpenAI 兼容 `/v1` base URL。

### 代理发现（`discovery.type: proxy`）

适用于在同一 host 之后同时暴露 `/v1/messages` 和 `/v1/chat/completions` 的
Anthropic + OpenAI 兼容代理（new-api / one-api / 类似）。发现会请求
`GET /v1/models`（10 秒超时，OpenAI 风格的 payload），并根据条目的
`supported_endpoint_types` 推导每个模型的 `api`：

- 包含 `"anthropic"` -> `api: anthropic-messages`（通过 `/v1/messages` 路由）
- 包含 `"openai"` -> `api: openai-completions`（通过 `/v1/chat/completions` 路由）
- 否则 -> 如果设置了 provider 级别的 `api` 则回退到它，否则被丢弃

在使用 `discovery.type: proxy` 时，provider 级别的 `api` 是**可选的**，因为
按模型的线路是自动检测的。Anthropic SDK 在追加 `/v1/messages` 之前会从 `baseUrl` 中剥离末尾的 `/v1`，
因此单个发现的 `baseUrl`（以 `/v1` 结尾）可以正确往返到两种线路。

```yaml
providers:
  newapi-reseller:
    baseUrl: https://api.example.com/v1
    apiKey: xxxx
    authHeader: true # injects Authorization: Bearer for openai models
    disableStrictTools: true # most anthropic-fronted proxies reject `strict`
    discovery:
      type: proxy
```

### 扩展注册 provider

Extension 可以在运行时注册 provider（`pi.registerProvider(...)`），包括：

- 对某个 provider 进行 model 替换/追加
- 为新 API ID 注册自定义 stream handler
- 注册自定义 OAuth provider

## 认证与 API key 解析顺序

当请求某个 provider 的 key 时，有效顺序为：

1. 运行时覆盖（CLI `--api-key`）
2. 配置覆盖（`models.yml` `providers.<name>.apiKey`）
3. 已存储的 OAuth 凭据（带刷新）
4. 来源于登录的已存储 API key
5. 环境变量映射（`OPENAI_API_KEY`、`ANTHROPIC_API_KEY` 等）
6. 其他已存储的 API key，例如由 broker 迁移过来的副本
7. ModelRegistry 回退解析器（`models.yml` 自定义 provider，使用 env-name-or-literal 语义）

`models.yml` `apiKey` 行为：

- 值首先被视为环境变量名。
- 如果不存在对应的环境变量，则使用字面量字符串作为 token。

如果设置了 `authHeader: true` 并且设置了 provider 的 `apiKey`，模型将获得：

- 注入的 `Authorization: Bearer <resolved-key>` 头。

无 key 的 provider：

- 标记为 `auth: none` 的 provider 被视为无需凭据即可使用。
- 对于它们，`getApiKey*` 返回 `kNoAuth`。

### Broker 模式

当设置了 `OMP_AUTH_BROKER_URL`（或 `auth.broker.url`）时，本地 SQLite 凭据存储会被 `RemoteAuthCredentialStore` 替代。上述第 3、4、6 层（已存储的 OAuth 和 API key 凭据）由 broker 提供的快照提供，其 `refresh` token 会被脱敏；过期时会在 broker 上触发 `POST /v1/credential/:id/refresh`，而不是本地刷新。

`AuthStorage.setConfigApiKey` 允许 `models.yml` 中的 `apiKey` 覆盖 broker 解析的 OAuth token，但不会覆盖运行时的 `--api-key`。有关完整的 broker / gateway 设计和环境变量接口（`OMP_AUTH_BROKER_URL`、`OMP_AUTH_BROKER_TOKEN`、`auth.broker.url`、`auth.broker.token`），请参阅 [`auth-broker-gateway.md`](./auth-broker-gateway.md)。

## 模型可用性与全部模型

- `getAll()` 返回已加载的模型注册表（内置 + 合并后的自定义 + 已发现）。
- `getAvailable()` 过滤出无 key 或具有可解析认证的模型。

因此，一个模型可以存在于注册表中，但在认证可用之前无法被选择。

## 运行时模型解析

### CLI 与 pattern 解析

`model-resolver.ts` 支持：

- 精确的 `provider/modelId`
- 精确的 model id（自动推断 provider）
- 模糊/子串匹配
- `--models` 中的 glob 范围 pattern（例如 `openai/*`、`*sonnet*`）
- 可选的 `:thinkingLevel` 后缀（`off|minimal|low|medium|high|xhigh|max`）

`--provider` 是旧式用法；推荐使用 `--model`。精确的 `provider/modelId` 是无歧义的；裸 id
和模糊 pattern 会针对可用的具体模型进行解析。

精确选择器的解析优先级：

1. 精确的 `provider/modelId` 引用
2. 精确的裸 id（不区分大小写）；当多个 provider 携带同一 id 时，偏好排序会选出胜者（见下文）
3. 已退役的 effort 档位变体别名（折叠的 catalog 条目，例如 `X`/`X-thinking` 双生条目）
4. provider 范围内的模糊匹配，随后是配合别名与带日期版本取舍的子串匹配

glob 范围 pattern（由 `enabledModels` 和 CLI `--models` 使用）会在精确匹配之后，单独针对具体模型运行。

当裸 id 匹配到来自多个 provider 的模型时，偏好顺序为：

1. 最近使用过的模型变体
2. provider 优先级（`modelProviderOrder` 设置，然后内置 catalog 的 provider 优先级）
3. 最近使用过的 provider
4. 注册表顺序

### 初始模型选择优先级

`findInitialModel(...)` 使用以下顺序：

1. 显式的 CLI provider+model
2. 第一个有范围的 model（如果未在恢复会话）
3. 已保存的默认 provider/model
4. 在可用模型中的已知 provider 默认值（例如 OpenAI/Anthropic/等）
5. 第一个可用模型

### 角色别名与设置

支持的 model 角色：

- `default`、`smol`、`slow`、`vision`、`plan`、`commit`、`tiny`、`task`、`advisor`

`tiny` 角色会覆盖用于轻量级后台任务的在线模型（session 标题、memory、`auto` 思考难度分类、意外停止检测）；未设置时，这些任务会回退到 `@smol`。在 `/models` 中选择一个。

诸如 `@smol` 的角色别名会通过 `settings.modelRoles` 展开；`*` 选择 `@default`。在 YAML 值中引用 `@` 别名时需要加引号（`fable: "@slow"`）。每个角色值还可以附加一个 thinking 选择器，例如 `:minimal`、`:low`、`:medium` 或 `:high`。

如果一个角色指向另一个角色，目标模型仍按常规继承，并且引用角色上的任何显式后缀会针对该角色的特定用途生效。

相关设置：

- `modelRoles`（记录）
- `enabledModels`（有范围的 pattern 列表）
- `modelProviderOrder`（当等效的具体选择共享同一 id 时的 provider 优先级）
- `providers.kimiApiFormat`（`openai` 或 `anthropic` 请求格式）
- `providers.openaiWebsockets`（OpenAI Codex transport 的 websocket 偏好，`auto|off|on`）

`modelRoles` 存储 model 选择器，例如 `provider/modelId`；`enabledModels` 和 CLI `--models`
接受精确选择器、glob 和模糊匹配。

全局的 `enabledModels` 和 `disabledProviders` 条目也可以限定到某个路径前缀：

```yaml
enabledModels:
  - claude-sonnet-4-5
  - path: ~/work
    models:
      - anthropic/claude-opus-4-5
disabledProviders:
  - ollama
  - path: ~/private
    providers:
      - anthropic
```

字符串条目适用于所有位置。有范围的条目仅在当前工作目录是配置的路径或其子目录之一时生效。可使用 `path`、`paths`、`pathPrefix` 或 `pathPrefixes`；`enabledModels` 使用 `models`，`disabledProviders` 使用 `providers`，或两者皆使用 `values`。

## `/model` 和 `omp models`

这两种界面都会让带 provider 前缀的具体模型保持可见并可选择。

- `/model` 显示一个全部模型视图，以及每个 provider 一个视图
- `omp models`（默认 `ls` 动作）打印按 provider 分组的全部可用模型表格；`omp models find <substring>` 按 provider、id 或 name 过滤；`omp models refresh` 忽略模型缓存 TTL 强制重新在线获取 catalog；任何 provider 名也可以当作 `ls` 过滤器使用（例如 `omp models openai-codex`）。标志：`--json`、`-e <path>`（加载扩展，可重复）、`--no-extensions`、`--config <overlay>`（额外配置叠加层，可重复）

选择某个 provider 行会存储其显式的 `provider/modelId`。

表格的 `images` 列报告的是 transport 实际会发送的内容，因此图像会被剥离的模型
（`compat.stripImageInput`，参见[图像处理](#兼容性与路由字段)）会显示 `no`，
即使其 spec 声明了 `input: [text, image]`；`--json` 则保留声明的 `input`。

## 上下文提升（模型级 fallback 链）

上下文提升是一种用于小上下文变体（例如 `*-spark`）的溢出恢复机制，当 API 因上下文长度错误拒绝请求时，会自动提升到具有更大上下文的兄弟模型。

### 触发与顺序

当某轮因上下文溢出错误（例如 `context_length_exceeded`）失败时，`AgentSession` 会在回退到 compaction 之前**先**尝试提升：

1. 如果 `contextPromotion.enabled` 为 true，则解析一个提升目标（见下文）。
2. 如果找到目标，则切换到该目标并重试请求——无需 compaction。
3. 如果没有可用目标，则在当前模型上回退到 auto-compaction。

### 目标选择

选择是显式的且由模型驱动：

1. `currentModel.contextPromotionTarget`（如果已配置）

只会考虑已配置的目标；上下文提升不会自动选择同一 provider/API 的更大兄弟模型。除非凭据能够解析（`ModelRegistry.getApiKey(...)`），否则已配置的目标会被忽略。

### OpenAI Codex websocket 交接

如果切换自/至 `openai-codex-responses`，则 session provider 状态 key `openai-codex-responses` 会在 model 切换之前被关闭。这会丢弃 websocket transport 状态，以便下一轮在提升后的模型上以干净状态开始。

### 持久化行为

提升使用临时切换（`setModelTemporary`）：

- 在 session 历史中记录为临时的 `model_change`
- 不会重写已保存的角色映射

### 配置显式 fallback 链

通过 `contextPromotionTarget` 在模型元数据中直接配置 fallback。

`contextPromotionTarget` 接受以下两种形式：

- `provider/model-id`（显式）
- `model-id`（在当前 provider 内解析）

示例（`models.yml`）显式的 OpenAI fallback：

```yaml
providers:
  openai-codex:
    modelOverrides:
      gpt-5.5:
        contextPromotionTarget: openai-codex/gpt-5.4
```

内置的模型策略当前将 OpenAI `codex-spark` 变体链接到 `gpt-5.5`，并将 `gpt-5.5` 链接到 `gpt-5.4`（当该目标存在于同一 provider/API 上时）。

## 兼容性与路由字段

provider 或 model 上的 `compat` 块会覆盖 `packages/catalog/src/compat/openai.ts`（`buildOpenAICompat`）中基于 URL 的自动检测。它由 `packages/coding-agent/src/config/models-config-schema.ts` 中的 `OpenAICompatSchema` 校验，并由每个 `openai-completions` transport（`packages/ai/src/providers/openai-completions.ts`）消费。规范类型是 `packages/catalog/src/types.ts` 中的 `OpenAICompat`。

与这些字段交互的端点特定例外在 [Provider 端点约束](./provider-endpoint-constraints.md) 中列出。

`models.yml` 接受以下 key（均为可选；未设置时回退到 URL 检测）：

请求塑形：

- `supportsStore` — 在请求中发出 `store: false`。默认：auto（对于非标准端点关闭）。
- `supportsDeveloperRole` — 对 reasoning 模型使用 `developer` 系统角色而不是 `system`。默认：auto。
- `supportsMultipleSystemMessages` — 保留分开的引导 system/developer 消息，而不是合并它们。默认：auto（已知的 OpenAI 兼容托管 API 保留；严格模板/本地宿主会合并）。
- `supportsUsageInStreaming` — 发送 `stream_options: { include_usage: true }` 以在流式响应中接收 token 使用情况。默认：`true`。
- `maxTokensField` — `"max_completion_tokens"` 或 `"max_tokens"`。默认：auto。
- `supportsToolChoice` — 当调用方强制指定特定工具时，发出 `tool_choice` 参数。默认：`true`。对于在 `tool_choice` 上返回 400 的端点（例如 reasoning 开启时的 DeepSeek）请设置为 `false`。
- `supportsForcedToolChoice` — 接受需要特定工具的强制 `tool_choice`。默认：`true`。当为 `false` 时，强制选择器会被降级为 `auto`，以便工具对于拒绝强制工具调用的端点（例如某些需要 thinking 的 OpenAI 兼容模型）仍然可用。
- `disableReasoningOnForcedToolChoice` — 只要 `tool_choice` 强制调用，就丢弃 `reasoning_effort` / OpenRouter `reasoning`。默认：auto（Kimi/Anthropic 前端端点）。
- `disableReasoningOnToolChoice` — 只要发送任何 `tool_choice`，就丢弃 reasoning 字段。默认：auto（DeepSeek reasoning 模型）。
- `alwaysSendMaxTokens` — 当调用方未提供 max-token 字段时，始终发送该字段。默认：auto（Kimi 系列模型从 `max_tokens` 推导 TPM 限制）。
- `strictResponsesPairing` — Responses-API 的 tool-call/result 历史必须严格配对。默认：auto（Azure OpenAI、GitHub Copilot）。
- `streamIdleTimeoutMs` — 慢 reasoning 主机的流式看门狗空闲超时下限（毫秒）。默认：auto（GLM coding-plan 主机，直接 DeepSeek reasoning）。
- `cacheControlFormat` — `"anthropic"` 以在 chat-completions payload 中包含 Anthropic 风格的 prompt-cache 标记。默认：auto（OpenRouter `anthropic/*` 模型）。
- `supportsLongPromptCacheRetention` — 主机在 Responses API 上支持 `prompt_cache_retention: "24h"`。默认：auto（api.openai.com）。
- `supportsImageDetailOriginal` — 在端点支持时，允许 Responses API 的非标准 `detail: "original"` 图像
  模式。
- `supportsConfigurationUpdate` — 允许 Responses API 在会话中途通过 `configuration_update` 输入项更改 `reasoning.effort`，同时请求级别的 effort 为 prompt caching 保持固定（GPT-6 Astra）。默认：auto（对每个主机上的 `gpt-6-astra` 为 `true`，否则为 `false`）。对于以 HTTP 400 拒绝该条目类型的自定义 `openai-responses` / `openai-codex-responses` 端点，请设置为 `false`；此时 effort 变更会作为顶层 `reasoning.effort` 发送，且不会发出任何更新条目。
- `extraBody` — 合并到每个请求 body 的额外顶层字段（gateway 提示、controller 选择器等）。

图像处理：

- `stripImageInput` — 在编码 `openai-completions` 请求之前丢弃图像部分（包括 OpenRouter 的 chat 回退，`PI_OPENROUTER_RESPONSES=0`）。catalog 的
  类别规则会为端点通常以纯文本方式提供的 model 系列设置它（例如 DeepSeek 类别），
  这与 provider 自身的 `input` 声明无关，因此一个模型可以声明 `input: [text, image]`
  却仍然不发送图像。按模型的 `compat` 会在这些规则之上深度合并并获胜：对于端点确实接受
  `image_url` 的 id（例如做视觉增强的代理），请设置 `stripImageInput: false`。默认：auto（catalog 类别与 provider 规则）。Responses 与 Anthropic/Google
  编码器会按模型声明的模态发送，`pi-native` transport 也是如此（它会把
  原始上下文转发给 gateway，因此守卫从不在客户端运行，`images` 列报告的是声明的 `input`）。

Reasoning / thinking：

自定义 model 条目可以定义 `thinking: { mode, efforts, defaultLevel, requiresEffort }`。
`requiresEffort` 默认为自动检测；仅当已验证所配置的后端接受显式的 reasoning-off
请求时，才将其设置为 `false`。这可以避免 `:off` 选择器被钳制到最低 effort。

- `supportsReasoningEffort` — 接受 `reasoning_effort`。默认：auto（对 Grok、Z.ai/Zhipu 和 Xiaomi MiMo 关闭）。
- `supportsReasoningParams` — 请求塑形是否真的可以发送 reasoning 参数。默认：auto（对 GitHub Copilot chat-completions 关闭）。
- `reasoningEffortMap` — 从内部 effort 级别（`minimal|low|medium|high|xhigh|max`）到 provider 特定字符串的部分映射（例如 Fireworks GLM 将 `minimal -> "none"`）。
- `thinkingFormat` — thinking 的请求形态：`"openai"`（`reasoning_effort`）、`"openrouter"`（`reasoning: { effort }`）、`"zai"`（`thinking: { type: "enabled" }`）、`"qwen"`（顶层 `enable_thinking`），或 `"qwen-chat-template"`（`chat_template_kwargs.enable_thinking`）。默认：`"openai"`。
- `qwenTemplateReasoningEffort` — 将所选 effort 路由到 Qwen 3.8+ chat template 的 `reasoning_effort` kwarg（`chat_template_kwargs.reasoning_effort`，以及 `qwen` 方言的顶层字段）。默认：auto（对本地非 Ollama 后端上的 Qwen 3.8+ id 开启）。对于拒绝未知 `chat_template_kwargs` 的严格服务器，请设置为 `false`；之后 Qwen 方言不会发送 effort 选择，模板会以自身默认值运行。
- `reasoningContentField` — 承载 chain-of-thought 的 assistant 字段：`"reasoning_content"`、`"reasoning"` 或 `"reasoning_text"`。默认：auto。
- `requiresReasoningContentForToolCalls` — assistant tool-call 轮次必须往返 reasoning 字段（DeepSeek-R1、Kimi、reasoning 开启时的 OpenRouter）。默认：`false`。
- `allowsSyntheticReasoningContentForToolCalls` — 当先前的 assistant tool-call 轮次缺少 provider reasoning 内容时，允许使用占位 reasoning 字段。默认：`true`；对于验证精确 reasoning 值的 provider，请设置为 `false`。
- `requiresAssistantContentForToolCalls` — assistant tool-call 轮次必须包含非空文本内容（Kimi）。默认：`false`。
- `whenThinking` — 仅在请求实际进入 thinking 模式时应用的部分 compat 覆盖（在基线 compat 之上深度合并）。

工具 / 消息归一化：

- `requiresToolResultName` — tool-result 消息需要 `name` 字段（Mistral）。默认：auto。
- `requiresAssistantAfterToolResult` — tool result 之后的 user 消息需要在中间插入一个 assistant 轮次。默认：auto。
- `requiresThinkingAsText` — 将 thinking 块转换为用 `<thinking>` 分隔符包裹的文本（Mistral）。默认：auto。
- `requiresMistralToolIds` — 将 tool-call id 归一化为恰好 9 个字母数字字符。默认：auto。
- `supportsStrictMode` — 接受工具 schema 上的 per-tool `strict` 字段。默认：按 provider/baseUrl 的保守自动检测。
- `toolStrictMode` — `"all_strict"` 强制对每个工具启用 strict，`"none"` 强制关闭；未设置时保留现有的 per-tool 混合行为。

Gateway 路由（仅在 `baseUrl` 与 gateway 匹配时应用）：

- `openRouterRouting.only` / `openRouterRouting.order` — 在 `openrouter.ai` 上的 provider 路由（参见 <https://openrouter.ai/docs/provider-routing>）。
- `vercelGatewayRouting.only` / `vercelGatewayRouting.order` — 在 `ai-gateway.vercel.sh` 上的 provider 路由（参见 <https://vercel.com/docs/ai-gateway/models-and-providers/provider-options>）。

provider 级别的 `compat` 是基线；per-model 的 `compat` 在其之上深度合并，其中
`openRouterRouting`、`vercelGatewayRouting`、`extraBody` 和 `whenThinking` 作为嵌套对象进行合并。

### Anthropic 兼容性（`anthropic-messages`）

对于 `anthropic-messages` 模型，运行时使用单独的 `AnthropicCompat` 结构
（`packages/catalog/src/types.ts`）。`models.yml` schema 将 strict-tools 的 opt-out 暴露为
provider 顶层字段，以及 `compat` 中的 `requiresToolResultId`、`replayUnsignedThinking`、
`supportsEagerToolInputStreaming` 和 `allowAnthropicHeaderOverrides`。其他
Anthropic 侧的旋钮由内置的 catalog 元数据提供，不能在此处配置。

### Bedrock 兼容性（`bedrock-converse-stream`）

同一个 `compat` 槽位接受 Bedrock 模型的 `promptCacheMode`（`none`、`automatic` 或 `explicit`）、
`supportsLongPromptCacheRetention`、`promptCacheMinimumTokens` 以及
`promptCacheMaximumCheckpoints`。

默认情况下，`bedrock-converse-stream` 请求会发往 `bedrock-runtime.{region}.amazonaws.com`，其中
`{region}` 来自显式的按请求 region、model id（ARN 或跨区域
inference-profile 前缀），或 `AWS_REGION`/`AWS_DEFAULT_REGION`/AWS profile —— 回退到
`us-east-1`。在 `providers.amazon-bedrock` 上（或在使用
`api: bedrock-converse-stream` 的自定义 provider 上）设置 `baseUrl`，即可改为把请求发往其他地方 —— VPC/PrivateLink
端点、FIPS 主机或 gateway。`baseUrl` 上的任何路径或查询字符串都会被保留 —— 路径
作为前缀，查询字符串追加到最终 URL（并在签名时包含进 SigV4 的规范化请求中）—— 因此
`{baseUrl}/model/{id}/converse-stream[?query]` 就是最终 URL。这覆盖了
通过查询参数而非 header 认证的 gateway：

```yaml
providers:
  amazon-bedrock:
    baseUrl: https://vpce-0123456789abcdef0.bedrock-runtime.us-east-1.vpce.amazonaws.com
```

有一种 host 形态不会被原样采纳：恰好为
`bedrock-runtime.{region}.amazonaws.com` 的 `baseUrl` 是 AWS 自己的端点，其 region 段会被替换
为解析出的 region —— 签名必须与其发送到的 region 一致，而且每个内置 Bedrock
模型都已带有这样的 `baseUrl`。请使用一个明确不同的 host（VPC 端点、`-fips`、gateway）来
精确固定某个源站。

region 解析本身不受 `baseUrl` 影响，因为 SigV4 仍然使用真实的 AWS
region 签名 —— 如果端点期望特定的 region，请设置 `AWS_REGION` 或使用限定 region 的 model id/ARN。接受 bearer token
而非 SigV4 的 gateway 完全不需要 region：设置
provider 的 `apiKey`（或 `AWS_BEARER_TOKEN_BEDROCK`）即可跳过签名。

### 严格工具 schema（`disableStrictTools`）

Anthropic API 在工具定义上支持一个 `strict` 字段，它会强制模型始终精确遵循所提供的 schema。OMP 默认会为一个小范围的高频内置 `anthropic-messages` 工具（`bash`、`python`、`edit` 和 `find`）启用它，这些工具的 schema 符合 Anthropic 的 strict 语法限制；其他工具仍然发送归一化后的 schema，但省略 `strict`。

那些前端为 Anthropic API 的第三方 provider（AWS Bedrock、Azure、自托管代理）并不总是实现该字段，并会拒绝包含它的请求。在 provider 级别设置 `disableStrictTools: true` 以选择不对 allowlist 中的工具启用 strict 模式：

```yaml
providers:
  bedrock-anthropic:
    baseUrl: https://bedrock-runtime.us-east-1.amazonaws.com/anthropic
    apiKey: AWS_BEARER_TOKEN
    api: anthropic-messages
    disableStrictTools: true
    models:
      - id: claude-sonnet-4-20250514
        name: Claude Sonnet 4 (Bedrock)
        input: [text, image]
        contextWindow: 200000
        maxTokens: 16384
        cost:
          input: 3.00
          output: 15.00
          cacheRead: 0.30
          cacheWrite: 3.75
```

`disableStrictTools` 是一个 provider 级别的标志，应用于该 provider 中的所有模型。它仅对 OMP 本应标记为 strict 的工具禁用 Anthropic `strict` 标记；它不会改变运行时的工具参数验证。OMP 可以在 Anthropic 在第一个流式 token 之前报告 strict-grammar-too-large 错误后自动重试并去掉 strict 工具，但因其他原因拒绝 `strict` 字段的代理应显式设置此标志。

要送上线路的工具 schema 由
`packages/ai/src/utils/schema/normalize.ts` 中的统一流程进行归一化（Google/CCA/MCP dispatcher
以及 OpenAI strict-mode sanitize+enforce pipeline）。有关 strict-mode
边界情况（局部 `$ref` 内联、单项 `allOf` 折叠、
`anyOf` 包装的 description 提升、enum/const 基元类型推断）以及 per-provider dispatcher 映射，
请参见 [`ai-schema-normalize.md`](./ai-schema-normalize.md)。

## 实用示例

### 本地 OpenAI 兼容端点（无认证）

```yaml
providers:
  local-openai:
    baseUrl: http://127.0.0.1:8000/v1
    auth: none
    api: openai-completions
    models:
      - id: Qwen/Qwen2.5-Coder-32B-Instruct
        name: Qwen 2.5 Coder 32B (local)
```

对于 oMLX 或其他具有可发现 `/v1/models` 端点的本地 OpenAI 兼容服务器，请优先使用发现而不是手动列出模型。将 `api` 设置为你的服务器实际公开的端点系列：`openai-completions` 使用 `/v1/chat/completions`；公开 `/v1/responses` 的服务器则需要使用 `openai-responses`。

```yaml
providers:
  omlx:
    baseUrl: http://127.0.0.1:11434/v1
    auth: none
    api: openai-completions
    discovery:
      type: openai-models-list
```

内置的 vLLM provider 可以指向非默认端点，而无需声明自定义 discovery type。OMP 使用 vLLM 的 `/v1/models` 元数据，并将 vLLM 的 `max_model_len` 字段保留为发现的 context window。

```yaml
providers:
  vllm:
    baseUrl: http://192.168.5.3:8085/v1
    auth: none
```

对于多个 vLLM 端点，可以使用任意的 provider id 配合通用 OpenAI 兼容的发现路径。本地无认证服务器请设置 `auth: none`，需要认证的请设置 `apiKey`。通用发现会先读取 `max_model_len`，然后在通用 OpenAI 兼容回退时读取 `context_length`。

```yaml
providers:
  vllm-fast:
    baseUrl: http://host-a:8000/v1
    auth: none
    api: openai-completions
    discovery:
      type: openai-models-list
  vllm-long:
    baseUrl: http://host-b:8000/v1
    auth: none
    api: openai-completions
    discovery:
      type: openai-models-list
```

### 使用基于环境变量 key 的托管代理

```yaml
providers:
  anthropic-proxy:
    baseUrl: https://proxy.example.com/anthropic
    apiKey: ANTHROPIC_PROXY_API_KEY
    api: anthropic-messages
    authHeader: true
    disableStrictTools: true # if the proxy doesn't support strict tool schemas
    models:
      - id: claude-sonnet-4-20250514
        name: Claude Sonnet 4 (Proxy)
        reasoning: true
        input: [text, image]
```

### 覆盖内置 provider 路由 + 模型元数据

```yaml
providers:
  openrouter:
    baseUrl: https://my-proxy.example.com/v1
    headers:
      X-Team: platform
    modelOverrides:
      anthropic/claude-sonnet-4:
        name: Sonnet 4 (Corp)
        compat:
          openRouterRouting:
            only: [anthropic]
```

## 旧式使用方式的注意事项

现在大多数模型配置都通过 `ModelRegistry` 经由 `models.yml` / `models.yaml` 流转。显式的 `.json` / `.jsonc` 路径仅在以编程方式传递给 `ModelRegistry` 时仍受支持；默认的用户配置优先使用 `~/.omp/agent/models.yml`，然后回退到 `~/.omp/agent/models.yaml`。

## 失败模式

如果 `models.yml` / `models.yaml` 未通过 schema 或验证检查：

- 注册表继续使用内置模型运行
- 错误通过 `ModelRegistry.getError()` 暴露，并在 UI/通知中显示
