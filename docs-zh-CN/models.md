# Model and Provider Configuration (`models.yml` / `models.yaml`)

本文档描述 coding-agent 当前如何加载模型、应用覆盖、解析凭据以及在运行时选择模型。

## What controls model behavior

主要实现文件：

- `packages/coding-agent/src/config/model-registry.ts` — 加载内置 + 自定义模型、provider 覆盖、运行时发现、认证集成
- `packages/coding-agent/src/config/model-resolver.ts` — 解析模型 pattern 并选择 initial/smol/slow 模型
- `packages/coding-agent/src/config/settings-schema.ts` — 模型相关设置（`modelRoles`、provider transport 偏好）
- `packages/coding-agent/src/session/auth-storage.ts` — 从 `@oh-my-pi/pi-ai` 重新导出 `AuthStorage`；API key + OAuth 解析顺序
- `packages/catalog/src/models.ts` 和 `packages/catalog/src/types.ts` — 内置 providers/models 和公开的 model 类型

## Config file location and legacy behavior

默认配置路径（按优先级顺序）：

- `~/.omp/agent/models.yml`
- `~/.omp/agent/models.yaml`

仍存在的旧行为：

- 如果两个 YAML 文件都不存在，且同目录下存在 `models.json`，则会被迁移到 `models.yml`。
- 以编程方式传递给 `ModelRegistry` 时，显式的 `.json` / `.jsonc` 配置路径仍然受支持。

## `models.yml` / `models.yaml` shape

```yaml
providers:
  <provider-id>:
    # provider-level config
```

`provider-id` 是跨选择与认证查找所使用的规范 provider key。

根对象目前只包含 `providers`；未知的根 key 会导致 schema 校验失败。

## Provider-level fields

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

### Allowed provider/model `api` values

- `openai-completions`
- `openai-responses`
- `openai-codex-responses`
- `azure-openai-responses`
- `anthropic-messages`
- `bedrock-converse-stream`
- `google-generative-ai`
- `google-gemini-cli`
- `google-vertex`

### Allowed auth/discovery values

- `auth`：`apiKey`（默认）、`none` 或 `oauth`；对于 `models.yml` 中的自定义模型，schema 接受 `oauth`，但不会豁免 `apiKey` 的要求
- `discovery.type`：`ollama`、`llama.cpp`、`lm-studio`、`openai-models-list`、`proxy` 或 `litellm`
- `transport`：仅 `pi-native`。设置后，该 provider 下的每个模型都会通过 `POST /v1/pi/stream` 发送到与 `omp auth-gateway` 兼容的 `baseUrl`；`apiKey` 即为 gateway 的 bearer。
- `imageInputDecoder`：仅 `stb`。当服务后端使用无法接受 WebP 的 STB 兼容图像解码器时，在自定义模型或 `modelOverrides` 条目上设置此字段；OMP 会在 provider dispatch 之前转换所附加的以及历史消息中的 WebP 图像。
- `tokenizer`：当代理的 model id 模糊或非规范时，可选择使用特定的嵌入式本地 tokenizer。允许的值：`claude-v3`、`claude-v47`、`claude-v5`、`claude-v5-sonnet`、`qwen3`、`deepseek-v3`、`kimi-k2` 和 `glm5`。省略时使用 catalog identity 策略；未知模型保留快速本地估算。

## Validation rules (current)

### Full custom provider (`models` is non-empty)

必填：

- `baseUrl`
- 除非 `auth: none`，否则需要 `apiKey`
- 在 provider 级别或每个 model 上设置 `api`

### Override-only provider (`models` missing or empty)

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

### Discovery

- `discovery.timeoutMs` 会覆盖该 provider 运行时 HTTP 探测超时（毫秒）。它必须是正的有限数。
- `discovery` 要求 provider 级别设置 `api`，但 `discovery.type: proxy` 除外（按模型自动检测线路）。

### Remote compaction

对于 override-only provider，`remoteCompaction` 单独就足够了。
它支持 `enabled`、`api`、`endpoint`、`model`、`v2StreamingEnabled`、
`v2Endpoint` 和 `streamingEndpoint`。

### Model value checks

- `id` 必填
- 如果提供 `contextWindow` 和 `maxTokens`，它们必须为正数

### Command-resolved secrets

provider 的 `apiKey` 值以及 provider/model 的 `headers` 值可以以 `!` 开头，以从命令的标准输出读取 secret。命令以 10 秒超时运行，标准输出会被裁剪首尾空白；空输出或执行失败的命令会被忽略：

```yaml
providers:
  openai:
    apiKey: "!op read op://dev/openai/api-key"
    headers:
      X-Team-Key: "!bw get password omp-team-key"
```

成功的命令输出会在进程生命周期内被缓存，因此不会为每个模型重新执行命令。

## Merge and override order

ModelRegistry 流程（refresh 时）：

1. 从 `@oh-my-pi/pi-catalog` 加载内置 providers/models（`getBundledProviders` / `getBundledModels`）。
2. 加载 `models.yml` / `models.yaml` 自定义配置。
3. 将 provider 覆盖（`baseUrl`、`headers`、`disableStrictTools`）应用到内置模型。
4. 应用 `modelOverrides`（按 provider + model id）。
5. 合并自定义 `models`：
   - 相同的 `provider + id` 替换已有项
   - 否则追加
6. 加载已缓存/运行时发现的模型（Ollama、llama.cpp、LM Studio，以及内置 provider 管理器），然后再次应用 model overrides。

### Provider-model cache and static fingerprint

按 provider 缓存的模型列表会持久化到 model-cache SQLite
数据库（当前 schema 版本为 12），其中包含一个 `static_fingerprint` 列，
用于对合并到该行的静态 catalog 切片进行哈希。当 `resolveProviderModels`
跳过网络获取，并且内存中静态 catalog 的指纹与缓存一致时，
缓存的行会原样返回——完全跳过静态 + 动态合并。
该指纹在每个进程中通过给 static-models 数组打上一个 symbol 属性进行记忆化，
因此重复的冷启动调用不会重新计算哈希。

## Provider and model identity

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

## Runtime discovery integration

### Implicit Ollama discovery

如果未显式配置 `ollama`，注册表会添加一个隐式的可发现 provider：

- provider：`ollama`
- api：`openai-responses`
- base URL：`OLLAMA_BASE_URL`，或 `OLLAMA_HOST`，或 `http://127.0.0.1:11434`
- context window：如果设置了 `OLLAMA_CONTEXT_LENGTH`，则使用其值；否则使用 Ollama `/api/show` 元数据；否则为 `128000`
- auth 模式：无 key（`auth: none` 行为）

运行时发现会调用 Ollama 端点，并将发现的 OpenAI 兼容模型归一化为 `openai-responses`。

`OLLAMA_CONTEXT_LENGTH` 不会配置 Ollama 运行时的 `num_ctx`；请在 Ollama/model 配置中单独设置。

### Implicit llama.cpp discovery

如果未显式配置 `llama.cpp`，注册表会添加一个隐式的可发现 provider：

- provider：`llama.cpp`
- api：`openai-responses`
- base URL：`LLAMA_CPP_BASE_URL` 或 `http://127.0.0.1:8080`
- auth 模式：无 key（`auth: none` 行为）

运行时发现会调用 llama.cpp model 端点，并使用本地默认值合成 model 条目。

### Implicit LM Studio discovery

如果未显式配置 `lm-studio`，注册表会添加一个隐式的可发现 provider：

- provider：`lm-studio`
- api：`openai-completions`
- base URL：`LM_STUDIO_BASE_URL` 或 `http://127.0.0.1:1234/v1`
- auth 模式：无 key（`auth: none` 行为）

运行时发现会获取模型（`GET /models`），并使用本地默认值合成 model 条目。

该路径也适用于不是 LM Studio 的本地 OpenAI 兼容服务器。例如，如果 oMLX 绑定到 Ollama 常用的端口，可设置 `LM_STUDIO_BASE_URL=http://127.0.0.1:11434/v1`，以通过现有的 `/v1/models` 流程发现它。oMLX 和 Ollama 同时运行需要为其中之一分配不同的端口。不要将 oMLX 配置为 `ollama`：Ollama 发现使用原生的 `/api/tags` 和 `/api/show` 端点，而不是 OpenAI 的 `/v1/models`。

### LiteLLM provider discovery

当 `litellm` 处于活动状态时（例如通过 `LITELLM_API_KEY` 或已存储的认证），运行时发现会使用 LiteLLM 代理：

- provider：`litellm`
- api：对于 OpenAI 后端模型为 `openai-responses`；其他模型为 `openai-completions`
- base URL：显式 provider 的 `baseUrl` / `models.yml` 配置，否则为 `LITELLM_BASE_URL`，否则为 `http://localhost:4000/v1`
- auth 模式：当代理需要 key 时，使用 `LITELLM_API_KEY` 或已存储的 LiteLLM 认证

运行时发现按以下顺序探测 LiteLLM 管理元数据：`GET /model_group/info`、`GET /v2/model/info`、`GET /model/info` 和 `GET /v1/model/info`。所配置的 key 必须被授权至少可访问其中一条路由；在限制管理端点的部署上，应通过 LiteLLM 的 `allowed_routes` 访问控制授予该路由，或使用 master/admin key 进行发现。

如果每条元数据路由都不可用，发现会回退到 OpenAI 兼容的 `GET /models` 列表。被禁止或失败的元数据请求会以端点和状态各记录一次；`404` 被视为路由不存在。丰富的元数据会映射每个模型的 context、capability 和 upstream-provider 字段。OpenAI 后端的模型使用 LiteLLM 的 Responses 路由，以便 reasoning 摘要保持可用；混合 provider 的组继续使用 Chat Completions。裸回退 id 使用已知的 OpenAI model 系列进行路由，并在可用时使用打包的参考元数据。因此，在回退之后，缺少打包 catalog 的模型可能具有未知的 context 和价格。

### Explicit provider discovery

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

### Proxy discovery (`discovery.type: proxy`)

适用于在同一 host 后同时暴露 `/v1/messages` 和 `/v1/chat/completions` 的 Anthropic + OpenAI 兼容代理（new-api / one-api / 类似）。
发现会请求 `GET /v1/models`（10 秒超时，OpenAI 风格的 payload），并根据条目的 `supported_endpoint_types` 推导每个模型的 `api`：

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

### Extension provider registration

Extension 可以在运行时注册 provider（`pi.registerProvider(...)`），包括：

- 对某个 provider 进行 model 替换/追加
- 为新 API ID 注册自定义 stream handler
- 注册自定义 OAuth provider

## Auth and API key resolution order

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

### Broker mode

当设置了 `OMP_AUTH_BROKER_URL`（或 `auth.broker.url`）时，本地 SQLite 凭据存储会被 `RemoteAuthCredentialStore` 替代。上述第 3、4、6 层（已存储的 OAuth 和 API key 凭据）由 broker 提供的快照提供，其 `refresh` token 会被脱敏；过期时会在 broker 上触发 `POST /v1/credential/:id/refresh`，而不是本地刷新。

`AuthStorage.setConfigApiKey` 允许 `models.yml` 中的 `apiKey` 覆盖 broker 解析的 OAuth token，但不会覆盖运行时的 `--api-key`。有关完整的 broker / gateway 设计和环境变量接口（`OMP_AUTH_BROKER_URL`、`OMP_AUTH_BROKER_TOKEN`、`auth.broker.url`、`auth.broker.token`），请参阅 [`auth-broker-gateway.md`](./auth-broker-gateway.md)。

## Model availability vs all models

- `getAll()` 返回已加载的模型注册表（内置 + 合并后的自定义 + 已发现）。
- `getAvailable()` 过滤出无 key 或具有可解析认证的模型。

因此，一个模型可以存在于注册表中，但在认证可用之前无法被选择。

## Runtime model resolution

### CLI and pattern parsing

`model-resolver.ts` 支持：

- 精确的 `provider/modelId`
- 精确的 model id（自动推断 provider）
- 模糊/子串匹配
- `--models` 中的 glob 范围 pattern（例如 `openai/*`、`*sonnet*`）
- 可选的 `:thinkingLevel` 后缀（`off|minimal|low|medium|high|xhigh|max`）

`--provider` 是旧式用法；推荐使用 `--model`。精确的 `provider/modelId` 是无歧义的；裸 id
和模糊 pattern 会针对可用的具体模型进行解析。

### Initial model selection priority

`findInitialModel(...)` 使用以下顺序：

1. 显式的 CLI provider+model
2. 第一个有范围的 model（如果未在恢复会话）
3. 已保存的默认 provider/model
4. 在可用模型中的已知 provider 默认值（例如 OpenAI/Anthropic/等）
5. 第一个可用模型

### Role aliases and settings

支持的 model 角色：

- `default`、`smol`、`slow`、`vision`、`plan`、`designer`、`commit`、`tiny`、`task`、`advisor`

`tiny` 角色会覆盖用于轻量级后台任务的在线模型（session 标题、memory、`auto` 思考难度分类、意外停止检测）；未设置时，这些任务会回退到 `@smol`。在 `/models` 中选择一个。

诸如 `@smol` 的角色别名会通过 `settings.modelRoles` 展开；`*` 选择 `@default`。在 YAML 值中引用 `@` 别名时需要加引号（`fable: "@slow"`）。每个角色值还可以附加一个 thinking 选择器，例如 `:minimal`、`:low`、`:medium` 或 `:high`。

如果一个角色指向另一个角色，目标模型仍按常规继承，并且引用角色上任何显式后缀会针对该角色的特定用途生效。

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

## `/model` and `omp models`

这两种界面都会让带 provider 前缀的具体模型保持可见并可选择。选择一个 provider 行会存储其显式的 `provider/modelId`。

## Context promotion (model-level fallback chains)

Context promotion 是一种用于小上下文变体（例如 `*-spark`）的溢出恢复机制，当 API 因上下文长度错误拒绝请求时，会自动提升到同一 provider 中具有更大上下文的兄弟模型。

### Trigger and order

当某轮因上下文溢出错误（例如 `context_length_exceeded`）失败时，`AgentSession` 会在回退到 compaction 之前**先**尝试 promotion：

1. 如果 `contextPromotion.enabled` 为 true，则解析一个 promotion 目标（见下文）。
2. 如果找到目标，则切换到该目标并重试请求——无需 compaction。
3. 如果没有可用目标，则在当前模型上回退到 auto-compaction。

### Target selection

选择是显式的且由模型驱动：

1. `currentModel.contextPromotionTarget`（如果已配置）

只会考虑已配置的目标；context promotion 不会自动选择同一 provider/API 的更大兄弟模型。除非凭据能够解析（`ModelRegistry.getApiKey(...)`），否则已配置的目标会被忽略。

### OpenAI Codex websocket handoff

如果切换自/至 `openai-codex-responses`，则 session provider 状态 key `openai-codex-responses` 会在 model 切换之前被关闭。这会丢弃 websocket transport 状态，以便下一轮在提升后的模型上以干净状态开始。

### Persistence behavior

Promotion 使用临时切换（`setModelTemporary`）：

- 在 session 历史中记录为临时的 `model_change`
- 不会重写已保存的角色映射

### Configuring explicit fallback chains

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

## Compatibility and routing fields

provider 或 model 上的 `compat` 块会覆盖 `packages/catalog/src/compat/openai.ts`（`buildOpenAICompat`）中基于 URL 的自动检测。它由 `packages/coding-agent/src/config/models-config-schema.ts` 中的 `OpenAICompatSchema` 校验，并由每个 `openai-completions` transport（`packages/ai/src/providers/openai-completions.ts`）消费。规范类型是 `packages/catalog/src/types.ts` 中的 `OpenAICompat`。

与这些字段交互的端点特定例外在 [Provider endpoint constraints](./provider-endpoint-constraints.md) 中列出。

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
- `extraBody` — 合并到每个请求 body 的额外顶层字段（gateway 提示、controller 选择器等）。

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

### Anthropic compatibility (`anthropic-messages`)

对于 `anthropic-messages` 模型，运行时使用单独的 `AnthropicCompat` 结构
（`packages/catalog/src/types.ts`）。`models.yml` schema 将 strict-tools 的 opt-out 暴露为
provider 顶层字段，以及 `compat` 中的 `requiresToolResultId`、`replayUnsignedThinking`、
`supportsEagerToolInputStreaming` 和 `allowAnthropicHeaderOverrides`。其他
Anthropic 侧的旋钮由内置的 catalog 元数据提供，不能在此处配置。

### Bedrock compatibility (`bedrock-converse-stream`)

同一个 `compat` 槽位接受 Bedrock 模型的 `promptCacheMode`（`none`、`automatic` 或 `explicit`）、
`supportsLongPromptCacheRetention`、`promptCacheMinimumTokens` 以及
`promptCacheMaximumCheckpoints`。

### Strict tool schemas (`disableStrictTools`)

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

`disableStrictTools` 是一个 provider 级别的标志，应用于该 provider 中的所有模型。它仅对 OMP 本应标记为 strict 的工具禁用 Anthropic `strict` 标记；它不会改变运行时的工具参数验证。OMP 可以在 Anthropic 在第一个流式 token 之前报告 strict-grammar-too-large 错误后自动重试时去掉 strict 工具，但因其他原因拒绝 `strict` 字段的代理应显式设置此标志。

要送上线路的工具 schema 由
`packages/ai/src/utils/schema/normalize.ts` 中的统一流程进行归一化（Google/CCA/MCP dispatcher
以及 OpenAI strict-mode sanitize+enforce pipeline）。有关 strict-mode
边界情况（局部 `$ref` 内联、单项 `allOf` 折叠、
`anyOf` 包装的 description 提升、enum/const 基元类型推断）以及 per-provider dispatcher 映射，
请参见 [`ai-schema-normalize.md`](./ai-schema-normalize.md)。

## Practical examples

### Local OpenAI-compatible endpoint (no auth)

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

### Hosted proxy with env-based key

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

### Override built-in provider route + model metadata

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

## Legacy consumer caveat

现在大多数模型配置都通过 `ModelRegistry` 经由 `models.yml` / `models.yaml` 流转。显式的 `.json` / `.jsonc` 路径仅在以编程方式传递给 `ModelRegistry` 时仍受支持；默认的用户配置优先使用 `~/.omp/agent/models.yml`，然后回退到 `~/.omp/agent/models.yaml`。

## Failure mode

如果 `models.yml` / `models.yaml` 未通过 schema 或验证检查：

- 注册表继续使用内置模型运行
- 错误通过 `ModelRegistry.getError()` 暴露，并在 UI/通知中显示
