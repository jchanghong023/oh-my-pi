# Auth Broker 与 Auth Gateway

Auth broker 与 auth gateway 是两个互相协作的 HTTP 服务，用于将 OAuth 刷新令牌和 provider 访问令牌从开发者笔记本迁移到一个统一的 broker 主机上。

- **`omp auth-broker serve`** 持有权威的 SQLite 凭据库，执行 OAuth 刷新，并通过 `/v1` 路径对外暴露 snapshot、credential、block、usage 和 health 等 API。
- **`omp auth-gateway serve`** 是一个正向代理。它接受 OpenAI Chat Completions、Anthropic Messages、OpenAI Responses 以及 pi-native stream 请求，解析由 broker 托管的凭据，并通过 `pi-ai` provider 逻辑进行派发。客户端（容器化的 omp、llm-git、macOS 用量小组件等）永远看不到访问令牌。

运维、broker 和 gateway 之间的传输安全由运维方自行负责（Tailscale / Wireguard / 反向代理 + TLS）。除了 `/v1/healthz`（broker）和 `/healthz`（gateway）之外，所有端点都需要 bearer 令牌。

源码位置：`packages/ai/src/auth-broker/`、`packages/ai/src/auth-gateway/`、`packages/coding-agent/src/cli/auth-broker-cli.ts`、`packages/coding-agent/src/cli/auth-gateway-cli.ts`、`packages/coding-agent/src/session/auth-broker-config.ts`。

## 数据流

```
                ┌────────────────────────────────────────────────────────────┐
                │ broker host                                                │
                │                                                            │
  developer ──▶ │  ┌──────────────────────────┐    ┌────────────────────┐    │
  laptop /      │  │  omp auth-broker serve   │◀──▶│  SQLite agent.db    │    │
  CI / robomp   │  │  - holds refresh tokens  │    │  (canonical writer)│    │
                │  │  - background refresher  │    └────────────────────┘    │
                │  │  /v1/{snapshot,refresh,…}│                              │
                │  └─────────┬────────────────┘                              │
                │            │  bearer ($CONFIG_DIR/auth-broker.token)       │
                │            ▼                                               │
                │  ┌──────────────────────────┐                              │
                │  │  omp auth-gateway serve  │  RemoteAuthCredentialStore   │
                │  │  /v1/{chat,messages,…}   │  receives snapshot stream,   │
                │  │  /v1/usage,/v1/models    │  refreshes credentials by id │
                │  │  /v1/credentials/check   │  via the broker on expiry    │
                │  └─────────┬────────────────┘                              │
                └────────────┼───────────────────────────────────────────────┘
                             │  bearer ($CONFIG_DIR/auth-gateway.token)
                             ▼
                  gateway clients
                  (llm-git, macOS widget, robomp containers, IDE plugins, …)
                                │
                                ▼ provider request with broker-resolved credential
                  api.anthropic.com / api.openai.com / …
```

Broker 是 OAuth 刷新令牌的唯一写入方。客户端（包括 gateway 自身）加载的是一份经过脱敏的 snapshot，其中每个 `refresh` 字段都已被替换为 `REMOTE_REFRESH_SENTINEL`；当访问令牌过期时，客户端调用 `POST /v1/credential/:id/refresh`，由 broker 在服务端完成刷新。`RemoteAuthCredentialStore` 拒绝本地的 replace / upsert / delete-by-provider 变更，错误提示指向 `omp auth-broker login` / `omp auth-broker logout`。

## auth-broker

### CLI

```
omp auth-broker serve     [--bind=host:port]                    # 启动 broker
omp auth-broker token     [--regenerate] [--json]               # 打印或轮换 bearer 令牌
omp auth-broker login     [<provider>] [--via=user@host] [--dry-run]
omp auth-broker logout    [<provider>]
omp auth-broker list      [--json]
omp auth-broker import    <file|dir> [--provider=<id>] [--include-disabled] [--dry-run] [--json]
omp auth-broker migrate   --from-local [--include-oauth] [--include-env] [--dry-run] [--json]
omp auth-broker status    [--json]
```

- `serve` 打开 `getAgentDbPath()` 处的本地 SQLite 存储并绑定 HTTP 监听（默认 `127.0.0.1:8765`）。启动时会确保在 `<config-dir>/auth-broker.token` 处存在令牌（权限 `0600`，父目录 `0700`）。后台 refresher 以 `refreshIntervalMs`（默认 60 s）为周期，刷新任何 `expires - Date.now() < refreshSkewMs`（默认 5 分钟）的 OAuth 凭据。
- `token` 打印已缓存的 bearer 令牌或生成新的令牌。`--regenerate` 用于轮换令牌。
- `login [<provider>]` 在本地运行针对特定 provider 的 OAuth 流程——当未提供 provider 时，回退到交互式编号选择器。使用 `--via=user@host` 时，它会 shell 外调用 `ssh -L <callback-port>:127.0.0.1:<callback-port> user@host omp auth-broker login <provider>`，使 OAuth 回调命中本地浏览器，但凭据写入 broker 主机（`--via` 要求提供 `<provider>`）。内置回调端口：`anthropic:54545`、`openai-codex:1455`、`google-gemini-cli:8085`、`google-antigravity:51121`、`gitlab-duo:8080`、`devin:59653`、`gitlab-duo-agent:8080`、`zai-coding-plan:54548`。OAuth 流程通过进程内的 `AuthStorage.login()` 驱动——不再需要 spawn 一个 `pi-ai` 二进制。
- `logout [<provider>]` 删除 `<provider>` 的所有凭据行。不带参数时，显示当前已存储 provider 的交互式编号选择器。
- `list` 枚举所有已注册的 OAuth provider id/name（内置 provider 与 `registerOAuthProvider` 自定义 provider 的并集）。`--json` 输出机器可读的数组。
- `import <file|dir>` 将 CLIProxyAPI 风格的 JSON 凭据导入到本地 SQLite 存储。映射 `type` 字段 → omp provider（`claude → anthropic`、`codex → openai-codex`、`gemini → google-gemini-cli`、`antigravity → google-antigravity`、`gemini-cli → google-gemini-cli`）。
- `migrate --from-local` 将本地 SQLite 凭据上传到已配置的 broker（`POST /v1/credential`）。本地 API key 默认包含；本地 OAuth 行默认跳过，除非设置 `--include-oauth`；源自环境变量的 API key 默认跳过，除非设置 `--include-env`。重复运行相对于 broker snapshot 是幂等的。
- `status` 对已配置的远端 broker 执行健康 ping。

### 端点

| Method   | Path                         | Auth   | Purpose                                                            |
| -------- | ---------------------------- | ------ | ------------------------------------------------------------------ |
| `GET`    | `/v1/healthz`                | none   | Liveness + version                                                 |
| `GET`    | `/v1/snapshot`               | bearer | Redacted snapshot (refresh tokens replaced by sentinel)            |
| `GET`    | `/v1/snapshot/stream`        | bearer | SSE snapshot stream with delta events and keepalives               |
| `POST`   | `/v1/credential`             | bearer | Upsert one OAuth or API-key credential                             |
| `POST`   | `/v1/credential/:id/refresh` | bearer | Force-refresh one OAuth credential                                 |
| `POST`   | `/v1/credential/:id/disable` | bearer | Disable one credential with a recorded cause                       |
| `GET`    | `/v1/credentials/disabled`   | bearer | List disabled credentials; optional `provider` query filter        |
| `POST`   | `/v1/credential/:id/block`   | bearer | Upsert a provider/scope rate-limit block                           |
| `DELETE` | `/v1/credential/:id/blocks`  | bearer | Delete all rate-limit blocks for a credential                      |
| `GET`    | `/v1/usage`                  | bearer | Aggregate current `UsageReport[]` across credentials               |
| `GET`    | `/v1/usage/history`          | bearer | Persisted usage history; optional `sinceMs` and `provider` filters |
| `POST`   | `/v1/usage/observed`         | bearer | Record usage observed by a broker client                           |
| `GET`    | `/v1/usage/clients`          | bearer | Summarize client-observed usage since optional `sinceMs`           |
| `POST`   | `/v1/usage/stale`            | bearer | Invalidate the broker's current usage cache                        |

请求使用 `Authorization: Bearer <token>`。服务器对照内存中的令牌允许列表进行比较；gateway 实现使用的是时间安全的比较方式。

#### 条件 snapshot 长轮询

`GET /v1/snapshot?wait=<ms>` 支持基于 generation 的条件轮询。
通过 `If-None-Match` 发送上一次响应中的 generation。Broker 接受裸形式的非负整数 generation、引号形式（如 `"42"`）或弱引号形式（如 `W/"42"`）作为 tag。

`wait` 解析为数字，截断为整毫秒，并限制在 0–30,000 ms 范围内；缺失或非数值的值按 `0` 处理。响应状态机如下：

- 如果 tag 缺失/无效、与当前 generation 不同，或 `wait <= 0`，立即返回当前脱敏 snapshot，状态码 `200`。
- 如果 tag 匹配且 `wait > 0`，则等待 generation 变化。变化时返回新 snapshot，状态码 `200`；等待超时未变化时返回空响应，状态码 `304`；调用方断开时返回空响应，状态码 `499`。

每个 `200`、`304` 和 `499` snapshot 响应都附带当前 generation 作为带引号的 `ETag`，以及 `Cache-Control: no-store` 和 `Vary: OMP-Auth-Broker-Capabilities`。

### Codex block-scope 兼容性

能够理解 per-meter Codex block 的客户端发送 `OMP-Auth-Broker-Capabilities: codex-meter-block-scopes`。此时 snapshot 响应携带规范的 `chat` 和 `spark` scope。若不包含该 capability，broker 会将这些行在传输时投影到旧式的 `shared` scope。

本地 SQLite schema 7 将 `chat` 和 `spark` 保留为当前 store API 暴露的规范 scope。它同时维护一个物理的 `shared` 兼容镜像，供直接读取 `agent.db` 的 pre-meter 二进制使用。SQLite trigger 会独立于 meter 行派生该镜像的截止时间和更新时间，并将旧式进程的 `shared` 写回复制到两个 meter。当前 store API 省略该物理镜像，因此 broker snapshot 和模型选择不会重复计算它。

在该 capability 出现之前发布的客户端（包括 17.1.4）会收到保守的 `shared` 投影，直到它们被升级。这些客户端在现有传输上无法区分，因此混合版本的部署倾向于保持被限流的凭据处于 blocked 状态，而不是允许反复向 provider 发起请求并返回 429。

依赖 capability 的响应包含 `Vary: OMP-Auth-Broker-Capabilities`，以避免中间节点为不同的客户端复用同一种表示。加密的客户端 snapshot 缓存也使用了新的格式版本：旧版缓存文件会被忽略并重新拉取，从而防止旧式与 meter-scoped 的表示在不同的客户端版本之间混合使用。

### 后台 refresher

`AuthBrokerRefresher` 以 `refreshIntervalMs` 周期遍历活跃的 OAuth 凭据，并刷新任何距离过期时间在 `refreshSkewMs` 内的凭据。同一凭据 id 的刷新是 single-flight 的，因此慢速刷新不会被重复触发。Refresher 会区分：

- **确定性失败**（`invalid_grant`、`invalid_token`、`revoked`、未授权的 refresh token、非网络抖动导致的 401/403）——凭据被传递给 `AuthStorage.disableCredentialById(id, cause)`，使下一次 snapshot 拉取在客户端表面为干净的删除；
- **瞬时失败**（超时 / ECONNREFUSED / fetch 失败）——保留原状，留待下一轮扫描。

## auth-gateway

### CLI

```
omp auth-gateway serve   [--bind=host:port] [--no-auth]
omp auth-gateway token   [--regenerate] [--json]
omp auth-gateway status  [--json]
omp auth-gateway check   [--strict] [--json]
```

- `serve` 要求设置 `OMP_AUTH_BROKER_URL`（或 `config.yml` 中的 `auth.broker.url`）——gateway 自身就是一个 broker 客户端。它调用 `AuthBrokerClient.fetchSnapshot()`，将其包装为 `RemoteAuthCredentialStore`，并构造一个通过 broker 解析访问令牌的 `AuthStorage`。默认绑定 `127.0.0.1:4000`。Gateway 令牌存储在 `<config-dir>/auth-gateway.token`（权限 `0600`）；`--no-auth` 完全禁用 bearer 校验（仅用于 loopback 场景）。
- `token` / `status` 用于管理和检视 gateway 的 bearer 令牌以及上游 broker 的就绪状态。
- `check` 通过 gateway store 探测由 broker 托管的凭据。无需 `--strict` 时使用 provider 用量探测；`--strict` 还会通过 chat-completion 端点对每个凭据进行实际验证，可能会消耗少量配额。

### 端点

| Method | Path                    | Auth   | Purpose                                                      |
| ------ | ----------------------- | ------ | ------------------------------------------------------------ |
| `GET`  | `/healthz`              | none   | Liveness + version                                           |
| `GET`  | `/v1/usage`             | bearer | Aggregate `UsageReport[]` (proxied through `AuthStorage`)    |
| `GET`  | `/v1/models`            | bearer | Bundled-model catalog filtered to providers with credentials |
| `GET`  | `/v1/credentials/check` | bearer | Per-credential auth health probe                             |
| `POST` | `/v1/chat/completions`  | bearer | OpenAI Chat Completions wire format                          |
| `POST` | `/v1/messages`          | bearer | Anthropic Messages wire format                               |
| `POST` | `/v1/responses`         | bearer | OpenAI Responses wire format                                 |
| `POST` | `/v1/pi/stream`         | bearer | Native `pi-ai` stream wire format                            |

对于外部 wire 格式，model id 从顶层的 `model` 字段读取；对于 `/v1/pi/stream`，则从 pi-native 请求体中读取。Gateway 选择第一个与该 id 匹配的已捆绑 `Model<Api>`，将入站 wire 格式解析为 omp `Context`，从由 broker 托管的 `AuthStorage` 解析 provider 凭据，通过 `streamSimple()` 派发，并将结果重新编码为入站格式（流式响应使用 SSE）。

不存在原始 provider 直通路径。所有受支持的路由都经过 `pi-ai` provider 逻辑，因此凭据相关的请求整形、OAuth 在鉴权错误时的刷新以及 provider 的怪癖都集中在一处。

底层 `Bun.serve` 上的 `idleTimeout` 设置为 `255 s`，避免长 thinking-budget 的调用被 Bun 的默认 idle timeout 杀掉。

## 用量缓存：服务端 5 分钟抖动 + 客户端 15 秒 single-flight

聚合 provider 用量报告通过两层缓存。这两层都是有意为之，并且相互叠加。

### 服务端缓存（broker `AuthStorage`）

`AuthStorage` 在 broker 的 SQLite 存储中以**每凭据 5 分钟 TTL、±25 % 抖动**的方式缓存每个凭据的 `UsageReport`。Anthropic 和 OpenAI 会按源 IP 强力限流 `/usage`，5 个凭据的同步扇出会在每个周期都触发 429；抖动在几个周期内解耦刷新时间。获取失败时，存储会**保留最后一次成功**的报告最长 24 小时，并使用一个短时间的抖动重试窗口——这样上游的瞬时抖动不会让小组件空白。

常量：`USAGE_REPORT_TTL_MS = 5 * 60_000`、`USAGE_LAST_GOOD_RETENTION_MS = 24 * 60 * 60_000`（`packages/ai/src/auth-storage.ts`）。

### 客户端 single-flight（`RemoteAuthCredentialStore`）

当 gateway（或任何其他 broker 客户端）调用 `fetchUsageReports()` / `getUsageReport(provider, credential)` 时，`RemoteAuthCredentialStore` 会把并发调用合并为单次 `GET /v1/usage` 往返，并将结果**在内存中缓存 15 秒**。

- `USAGE_CACHE_TTL_MS = 15_000`（`packages/ai/src/auth-broker/remote-store.ts`）。
- 跨所有调用方共享一个 `#usageInflight` promise；每个调用方的 `AbortSignal` 是与该共享 promise **竞争**的关系，而不是被串入其中，因此某个调用方的中止不会级联影响到其他正在进行的请求。
- 获取失败时，被拒绝的 promise 会被记录日志，等待的值为 `null`——调用方（`AuthStorage.fetchUsageReports`、`#getUsageReport`）将 `null` 报告视为“本周期无用量信号”，并继续执行而不依赖它。**这就是 15 秒 TTL 的回退机制**：客户端通过抑制错误、向排序返回 `null` 并在 15 秒窗口后重试来吸收 broker 的瞬时不可用。

15 秒的客户端窗口刻意位于 broker 5 分钟服务端缓存之下，因此几乎所有客户端轮询都由 broker 已缓存的值提供；客户端缓存的存在是为了将由 `AuthStorage.#rankOAuthSelections` 产生的并行扇出吸收为单次 broker 往返。

## 客户端 snapshot 缓存

`discoverAuthStorage()` 在初次 `/v1/snapshot` 拉取之后以及后续由 broker 来源的完整 snapshot 之后，将 broker snapshot 持久化到 `~/.omp/cache/auth-broker-snapshot.enc`。该文件使用 `SHA-256(OMP_AUTH_BROKER_TOKEN)` 进行 AES-256-GCM 加密，并以 broker URL 作为附加认证数据，因此更改令牌或 URL 都会使缓存不可读。该文件以原子方式写入，权限 `0600`。

新鲜度以 broker 盖戳的 `snapshot.generatedAt` 为锚，而不是本地写入时间。默认 TTL 为 1 小时（`OMP_AUTH_BROKER_SNAPSHOT_TTL_MS`）；设为 `0` 禁用缓存读取和写入。新鲜的缓存会在启动时（500 ms 预算）对可达的 broker 进行再验证，以便导入、撤销或轮换的凭据能够立即对一次性命令可见。如果由于 broker 不可用或响应缓慢导致再验证失败，`omp` 从缓存启动，而 `RemoteAuthCredentialStore` 在后台继续正常的 SSE / 长轮询同步。过期的 OAuth 访问令牌仍可通过 `POST /v1/credential/:id/refresh` 进行刷新。

如果启动时 broker 不可用且存在新鲜缓存，则从缓存的 snapshot 成功启动。鉴权失败（401/403）不会被缓存掩盖；瞬时服务端错误会回退到缓存。如果缓存缺失、过期、损坏、为不同 URL 写入，或使用不同令牌加密，则回退到实时拉取，并在 broker 不可达时失败。

## 客户端账户池（路由，而非授权）

Broker 客户端可以通过将 `OMP_AUTH_BROKER_ACCOUNT_POOL_FILE` 设置为一个 JSON 文件来限制其可见的 OAuth 账户。该文件将 provider ID 映射为 broker snapshot 协议中的精确 `identityKey` 值：

```json
{
  "anthropic": ["email:alice@example.com|org:org-team"],
  "openai-codex": []
}
```

`identityKey` 是每个已鉴权 `/v1/snapshot` 凭据条目中已经携带的、不含令牌的身份字段。运维工具应仅投影 `provider` 和 `identityKey`；不得保留或打印伴随的凭据负载。本路由特性刻意不包含专门的账户列表 CLI。

SDK 宿主可以在 `discoverAuthStorage()` 或 `RemoteAuthCredentialStore` 中以 `accountPool` 的形式提供相同的 provider-to-identity 映射。显式的编程式 pool 优先于环境变量文件。

- 缺失的 provider 不受限。
- 空数组隐藏该 provider 的所有 OAuth 凭据。
- 非空数组仅暴露精确的身份匹配，包括 organization/workspace 限定符。
- API key 凭据保持可见；pool 仅作用于 OAuth 账户。

该文件在 broker-backed auth storage 启动时解析一次。文件不可读、JSON 格式错误或 provider 条目无效将中止初始化，而不是悄悄扩大 pool。完整 snapshot、SSE 更新、刷新响应和聚合用量会被一致地过滤。对于 pool 中命名的 provider，只有在能够归属于可见的 OAuth 身份时才会返回聚合报告；仅归属于 API key 或缺少匹配身份元数据的报告会 fail close。加密的 snapshot 缓存仍保持为原始的 broker snapshot，以便共享该缓存的可信进程能够应用不同的 pool。

这是一项**可信客户端的路由策略，而不是授权边界**。客户端仍然持有 broker bearer 令牌，在应用本地视图之前会接收原始的 broker 响应，并可以直接调用 broker 端点。当需要防止客户端检索其他凭据时，应使用服务端授权，而非账户池。

## 运维侧显式启用

除非设置了 `OMP_AUTH_BROKER_URL`（或 `config.yml` 中的 `auth.broker.url`），否则 broker **处于关闭状态**。设置后，`packages/coding-agent/src/sdk.ts` 中的 `discoverAuthStorage` 会将本地 SQLite 凭据存储替换为 `RemoteAuthCredentialStore`，所有 API 调用都通过 broker 解析凭据。

### 环境变量

| Variable                            | Purpose                                                                                                                                                                | Required when                                                                                                             |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `OMP_AUTH_BROKER_URL`               | Base URL of the remote auth-broker (e.g. `https://broker.tailnet:8765`). Selecting this puts the client in broker mode — local SQLite is bypassed.                     | Any time the omp client should resolve credentials through a broker (and required by `omp auth-gateway serve`).           |
| `OMP_AUTH_BROKER_TOKEN`             | Bearer token used for every broker endpoint except `/v1/healthz`.                                                                                                      | When `OMP_AUTH_BROKER_URL` is set and no token is available from `auth.broker.token` or `<config-dir>/auth-broker.token`. |
| `OMP_AUTH_BROKER_SNAPSHOT_TTL_MS`   | Freshness window for the encrypted local snapshot cache. Default `3600000` (1 h); `0` disables cache reads and writes.                                                 | Optional in broker mode.                                                                                                  |
| `OMP_AUTH_BROKER_SNAPSHOT_CACHE`    | Path override for the encrypted local snapshot cache. Default `~/.omp/cache/auth-broker-snapshot.enc` (or XDG cache equivalent).                                       | Optional in broker mode.                                                                                                  |
| `OMP_AUTH_BROKER_ACCOUNT_POOL_FILE` | JSON file mapping provider IDs to OAuth `identityKey` values visible to this trusted client. Parsed once; invalid files abort initialization. API keys are unaffected. | Optional in broker mode.                                                                                                  |

`resolveAuthBrokerConfig()` 中的解析顺序：

1. `OMP_AUTH_BROKER_URL` 环境变量（否则从 `config.yml` 中读取 `auth.broker.url`，通过 `resolveConfigValue` 解析）；
2. `OMP_AUTH_BROKER_TOKEN` 环境变量（否则从 `config.yml` 中读取 `auth.broker.token`，否则使用 `<config-dir>/auth-broker.token`）；
3. URL 已设置但无法解析到令牌 → 指向令牌文件路径的硬错误。

Gateway 没有专用的环境变量——它本身是 broker 客户端，因此继承 `OMP_AUTH_BROKER_*`。

### `config.yml` 键

| Key                 | Default | Purpose                                                                                                                                                                            |
| ------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auth.broker.url`   | unset   | Same as `OMP_AUTH_BROKER_URL`; env wins. Hidden from the settings UI. Values are resolved as a literal, an environment variable name, or `!<shell command>` to use trimmed stdout. |
| `auth.broker.token` | unset   | Same as `OMP_AUTH_BROKER_TOKEN`; env wins. Values are resolved the same way.                                                                                                       |

### 令牌文件

| Path                              | Owner                                                | Mode                          |
| --------------------------------- | ---------------------------------------------------- | ----------------------------- |
| `<config-dir>/auth-broker.token`  | `omp auth-broker serve` (created at first start)     | `0600` in a `0700` parent dir |
| `<config-dir>/auth-gateway.token` | `omp auth-gateway serve` (skipped under `--no-auth`) | `0600` in a `0700` parent dir |

`<config-dir>` 解析为 `~/.omp/`（遵循 `PI_CONFIG_DIR`）。

## 与本地 API key 解析顺序的交互

Broker 仅拥有已上传到它的 OAuth 凭据和 provider-API-key 凭据。`models.md`（`Auth and API key resolution order`）中的标准凭据层级得以保留，并伴随 gateway 新增了一项：

- `AuthStorage.setConfigApiKey / removeConfigApiKey / clearConfigApiKeys` 允许 `models.yml` 中的 `apiKey` **在不覆盖显式 `--api-key` 的前提下**优先于已存储的 OAuth 令牌。这正是在两者同时存在时，由 broker 解析的 OAuth 凭据能够被每个环境下的 `models.yml` 配置键可靠地覆盖的原因。

## 另请参阅

- [`secrets.md`](./secrets.md) ——针对那些确实会泄漏的令牌（例如 shell 输出中的 `OMP_AUTH_BROKER_TOKEN`）的机密混淆机制。
- [`models.md`](./models.md) ——provider 鉴权解析顺序；broker 提供已存储凭据的相关层。
- [`environment-variables.md`](./environment-variables.md) ——完整的环境变量参考，包括 `OMP_AUTH_BROKER_URL` / `OMP_AUTH_BROKER_TOKEN`。
