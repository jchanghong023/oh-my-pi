# 添加一个 provider

一个 provider 由两部分组成：

- **目录部分**（`packages/catalog`）：在 `CATALOG_PROVIDERS`
  表（`packages/catalog/src/provider-models/descriptors.ts`）中的一项，包含
  `id`、`defaultModel`、运行时模型发现工厂，以及目录生成
  接线。`KnownProvider`、`PROVIDER_DESCRIPTORS` 和
  `DEFAULT_MODEL_PER_PROVIDER` 均由该表派生。
- **鉴权部分**（`packages/ai`）：注册表中的一个声明式 `ProviderDefinition`，
  包含环境变量键的回退以及登录/刷新流程。
  `OAuthProvider` 联合类型、环境变量键映射、`/login` 的 provider 列表、
  `refreshOAuthToken` / `AuthStorage.login` 派发，以及 coding-agent
  回调映射均从该注册表派生。

**范围。** 适用于复用既有 wire API
（`openai-completions`、`anthropic-messages`、`google-generative-ai` 等）的
provider——这是网关和 API key provider 的常见情况，因为流式分派以
`model.api` 而非 `model.provider` 为键。添加一个_新的 wire 协议_（一个新的
`KnownApi`）是一项独立任务，还涉及 `stream.ts` 分派、
`api-registry.ts` 以及目录中的 `types.ts`。

## 形态

对于常见情况，一个 provider 是**一个目录条目 + 一个 def 文件 + 一行注册表**：

1. **在 `CATALOG_PROVIDERS` 中添加一项**，
   位于 `packages/catalog/src/provider-models/descriptors.ts`，包含 `id`、
   `defaultModel`、作为 `envVars` 的普通 API key 环境变量名（们），以及
   （通常）一个 `createModelManagerOptions` 工厂。对于一个
   简单的 OpenAI 兼容网关，可在
   `packages/catalog/src/provider-models/openai-compat.ts` 中构建工厂，或通过
   导出的 `createSimpleOpenAICompletionsOptions(providerId, baseUrl, config)` 内联构建。
2. **创建 `packages/ai/src/registry/<id>.ts`**，导出一个
   `export const <camelId>Provider = { … } as const satisfies ProviderDefinition;`，
   包含鉴权字段（`login` 等）。普通环境变量名位于目录
   条目的 `envVars` 中；仅在需要计算型解析器（Foundry/ADC/
   Bedrock 风格的探测）时设置 `envKeys`。
3. **将其加入 `ALL` 数组**，
   位于 `packages/ai/src/registry/registry.ts`
   （一个导入 + 一项数组条目）。`ALL` 数组的顺序即
   可登录 provider 的 `/login` 列表顺序。

这便是以下情况的完整改动：

- 仅使用环境变量键的 provider；
- 具有简单内联 API key 登录流程的 provider；
- 大多数 OpenAI 兼容网关。

对于**非平凡的 provider 本地 OAuth 流程**，将实现放在
`packages/ai/src/registry/oauth/<vendor>.ts`，并从 def 文件中按需懒导入。
其所基于的共享 OAuth 流程基础设施也位于同一
`registry/oauth/` 目录下。

描述符、默认模型映射、环境变量键映射、登录列表和刷新
派发都会自动更新；`KnownProvider` 联合类型从目录表获得新 id，
`OAuthProvider` 联合类型从注册表获得新 id。

## 字段参考

**目录表条目**（`ProviderCatalogEntry`，详见
`packages/catalog/src/provider-models/descriptor-types.ts` 中的 JSDoc）：

| 字段                         | 作用                                                                                                                                                                                                                                |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                         | 必填。`KnownProvider` 的成员。                                                                                                                                                                                                      |
| `defaultModel`               | 必填。在没有显式选择时优先使用的模型。                                                                                                                                                                                              |
| `envVars`                    | 运行时 API key 回退（`getEnvApiKey`）使用的环境变量名（们），按顺序排列。                                                                                                                                                            |
| `createModelManagerOptions`  | 运行时模型发现工厂。若存在（且非 `specialModelManager`）⇒ 出现在 `PROVIDER_DESCRIPTORS` 中。                                                                                                                                         |
| `allowUnauthenticated`       | 即使没有 key，运行时也会创建模型管理器。                                                                                                                                                                                            |
| `dynamicModelsAuthoritative` | 成功的发现会替换内建的模型。                                                                                                                                                                                                        |
| `catalogDiscovery`           | 用于离线目录生成（`generate-models.ts`）的 `{ label, envVars?, oauthProvider?, allowUnauthenticated? }`。此处的 `envVars` 在生成使用不同凭据时（例如 `cursor`）覆盖条目级列表。                                                          |
| `specialModelManager`        | 定制的运行时工厂（`google-antigravity` / `google-gemini-cli` / `openai-codex`）；会从 `PROVIDER_DESCRIPTORS` 中排除。                                                                                                                |

**注册表定义**（`ProviderDefinition`，详见
`packages/ai/src/registry/types.ts`）：

| 字段                       | 作用                                                                                                                                                                                                                                |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`、`name`               | 必填。当定义具有可见的登录流程时，`name` 显示在 `/login` 列表中。                                                                                                                                                                    |
| `available`                | 可选的登录列表可用性标志。                                                                                                                                                                                                          |
| `showInLoginList`          | 设为 `false` 以将具有 `login` 流程的 provider 排除在交互式列表之外。                                                                                                                                                                 |
| `envKeys`                  | `getEnvApiKey` 的计算型环境变量回退，覆盖目录条目中的 `envVars`：一个变量名字符串或一个 `() => string \| undefined` 解析器。当 `envVars` 已覆盖时省略。                                                                              |
| `allowsMissingApiKey`      | provider 传输可以在没有解析到 API key 字符串的情况下完成鉴权。                                                                                                                                                                      |
| `prepareRequest`           | 在通用 API 分派之前由 provider 拥有的请求塑形。返回要分派的模型和流选项。                                                                                                                                                            |
| `mapSimpleOptions`         | 将通用简单流选项包投影为 provider 拥有的选项。                                                                                                                                                                                      |
| `prepareModelDiscovery`    | 用于运行时模型发现的、由 provider 拥有的鉴权或端点设置。                                                                                                                                                                            |
| `login`                    | 交互式登录。存在 ⇒ `OAuthProvider` 的成员，可通过 `AuthStorage.login` 派发，除非 `showInLoginList` 为 false，否则显示在 `/login` 列表中。返回一个 API key `string` 或 `OAuthCredentials`。                                              |
| `refreshToken`             | OAuth 刷新器；对于静态令牌的 provider 省略（派发将原样返回凭据）。                                                                                                                                                                  |
| `getApiKey`                | 将存储的 OAuth 凭据转换为传输所用的 API key/令牌字符串。                                                                                                                                                                            |
| `storeCredentialsAs`       | 将凭据存储在不同的 provider id 下（例如 `openai-codex-device` ⇒ `openai-codex`）。                                                                                                                                                  |
| `callbackPort`             | 若存在 ⇒ 鉴权代理 `CALLBACK_PORTS` 映射中的一项。                                                                                                                                                                                   |
| `pasteCodeFlow`            | OAuth 流程需要粘贴的 code/重定向 URL ⇒ `PASTE_CODE_LOGIN_PROVIDERS` 的成员。                                                                                                                                                          |

## 约定

- 使用 `... as const satisfies ProviderDefinition`，以便字面量 `id` 在联合类型派生中得以保留。
- 简单 API key 或基于验证的流程对应的 `login` / `refreshToken` 可以
  直接放在 provider def 文件中（在此处导出命名的 login 函数，以便
  测试可以直接导入）。
- 重量级 provider 本地 OAuth 流程对应的 `login` / `refreshToken` 必须通过动态导入
  thunk（`const { loginX } = await import("./oauth/x"); return loginX(cb);`）
  访问相邻的 `registry/oauth/*` 模块，
  以避免这些流程进入急切启动的依赖图。
- 所有 OAuth 代码位于 `registry/oauth/` 下：共享的流程基础设施
  （`callback-server`、`pkce`、`google-oauth-shared`、`types`、运行时 API
  `index`）以及每一个 provider 流程，包括被流式和用量层复用的
  `github-copilot` / `kimi` / `openai-codex` 辅助函数。非 OAuth
  的 API key 辅助函数（`api-key-login`、`api-key-validation`）位于 `registry/` 中
  def 文件旁边，因为它们支持简单的粘贴 API key 登录。
- 对于简单的 OpenAI 兼容网关，可使用
  导出的 `createSimpleOpenAICompletionsOptions(providerId, baseUrl, config)` 内联
  构建管理器——无需修改 `openai-compat.ts`。
- `ProviderDefinition` 也可以在运行时由扩展通过
  `registerOAuthProvider` 进行注册（`AuthStorage.login` 派发器通过同一路径处理内建
  和扩展）。
