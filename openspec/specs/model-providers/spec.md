# model-providers

## Purpose

Provider 目录、请求路由与[会话模型选择](#requirement-judge-候选池的会话作用域)。可用性依平台、认证、[offline 真值](../fork-runtime/spec.md#requirement-安装与运行)；不推断公网可达。

## Requirements

### Requirement: 沿用上游 Provider 目录

上游目录 MUST NOT 另设 fork 聊天 allowlist。

#### Scenario: 目录准入

- **WHEN** 合并目录、注册模型或列登录入口
- **THEN** 不另退役 `opencode-zen`（含 judge），不增选择器语法/SDK 拦截，不迁移/删用户数据。

CodeAgent/Ascend/`company` 凭据不写配置/日志；后两者不自发现/回退厂商公网 API。

CodeAgent/Ascend：reasoning/tools，`maxTokens=32768`。

### Requirement: CodeAgent 内置模型

MUST 仅 Windows 非 offline 注册 `codeagent/deepseek-v4.1-flash-1017`(末段=ID=名称)，免登录/手配；offline 无入口。

#### Scenario: 内置请求

- **WHEN** 使用 CodeAgent
- **THEN** 固定 `https://snapengine.cida.cce.prod-szv-y.dragon.tools.huawei.com/api/v2`、`openai-completions`、`auth: none`、`supports-strict-mode #false`(非 `disableStrictTools`)、`contextWindow=409600`。

不强制/禁用工具选择。`low`/`high`/`max` → `thinking: {type: "enabled"}` + 对应 `reasoning_effort`；关/未指定 → `thinking: {type: "disabled"}`。思考延续同 DeepSeek V4；历史 assistant 思考用 `reasoning_content` 回传。

启动直读 `HKCU\Environment\JCH_CODEAGENT3_X_AUTH_TOKEN`（非进程 env），内存缓存供 `x-auth-token`；仅认证/API 失败重读，读失败留缓存。新 Token ≠ 请求 Token 才更新（免重启/切模型/新会话）；无流式正文/思考/工具输出且未取消才自动重试一次。

对话/压缩摘要/handoff 仅 CodeAgent 禁外层重试及认证/模型/压缩方法回退重发。

#### Scenario: 提交消息和标题的生成回退
- **WHEN** CodeAgent 快速生成 commit 消息失败，或标题候选认证/请求/结果解析失败
- **THEN** 不因 CodeAgent 特判提前终止上游分析/重试/回退。

### Requirement: Ascend 内置模型

MUST 内置下表；不改默认模型/角色，免 `models.yml`/登录，无内置密钥。

#### Scenario: 显式选用

- **WHEN** 普通/offline 列 `ascend` 或设 `ASCEND_API_KEY` 后显式选用
- **THEN** env 解析/Bearer；固定 `http://models.ascend.huawei.com`(用户指定明文)、`anthropic-messages`、禁严格工具模式。

均含文本。

|ID|图片|上下文(tokens)|
|---|---|---:|
|`minimax2.7`, `kimi-k2.6`, `deepseek-v4-flash`|否|200000|
|`qwen3.8-27b`|否|256000|
|`qwen-aw-35b`|是|200000|
|`qwen3.8-flash-next`|是|256000|

`qwen3.8-*` 用 `anthropic-budget-effort`: `low`/`medium`/`high`/`xhigh`(默认)，`high` → 服务端 `xhigh`。无计费数据，零费占位≠免费。

### Requirement: 公司内网模型（仅 `OMP_OFFLINE`）

MUST 仅 offline 读公司认证；有效即注册 `company`(下表)，允许向量回退。lane/角色缺省/发现策略限进程。

#### Scenario: 准入与发现

- **WHEN** 非 offline 初始化/使用目录或角色
- **THEN** 无公司模型/启动告警；显式 `--provider company`/`--model company/...` 报错提示启用 `OMP_OFFLINE`。

发现只读缓存：自动刷新、凭据登录/保存后同步、selector-miss；内置公网目录/默认探测/扩展动态发现无例外。仅 `omp models refresh`/模型面板手动刷新可访问显式端点（`models.yml` 的 `discovery`/`baseUrl` 或本地模型端点 env）。模型/OAuth 请求依用户选。

`models`/`bench <selector…>`：建 registry 前开 lane。`compress`/`commit`/Git AI 提交等独立消费者：注册/解析前开 lane、角色缺省、cache-only；无需显式 offline 参数。

按需复用初始化/自动发现，不另注册：
- `dry-balance`：lane → 解析。
- `usage`：目录仅缓存；请求如常，不虚构公司接口/额度。
- 本地 `read`/已有会话 `render`：无公司配置依赖/认证发现/在线发现；MCP/远端/模型原认证。
- `read "<图片路径>?q=<问题>"`：按需初始化 company/vision、请求选中模型。配置错误可见；显式已解析的非 `company` vision/default 继续，需 `company` 则失败、不回退。

#### Scenario: 认证快照

- **WHEN** offline 启动或 SDK/独立命令初始化认证
- **THEN** 真异步读 `settings.json`（目录 `CLAUDE_CONFIG_DIR` > `~/.claude`）的 `env.ANTHROPIC_BASE_URL`/`env.ANTHROPIC_AUTH_TOKEN`。免登录/另填凭据/建 `models.yml`；禁 Promise 包同步读，主线程独立步骤不停。

读→校验→仅内存发布 URL/Token。异步入口/调用方显式等就绪→公司 registry 建/刷、公司模型/默认角色解析、依赖快照的认证返回或 Worker/受管子进程启动。后者只继承父进程就绪快照，源文件更换/删除无影响。同步查询只用就绪/继承快照，不读文件/误报缺失。

同进程并发/重复共享单读终态(成功/缺失/坏 JSON/错字段)，不重读/监听/重试/回退；变更须重启。

缺失/无效：禁用 `company`，显式选用失败；脱敏原因走原 TUI 警告/独立模型命令 stderr，每命令一次。共享 SDK 初始化/认证发现/会话或子代理创建不直写终端，状态/错误可查。

聊天：仅快照、Anthropic Messages + Bearer；文本、`maxTokens=81920`。[KDL 覆盖及角色缺省/优先级](../fork-runtime/spec.md#requirement-安装与运行)另计。

|ID|图片|上下文(tokens)|
|---|---|---:|
|`DeepSeek-V4-Flash-public`, `GLM-5.2-public`, `GLM-5.3-public`|否|1000000|
|`Deepseek-v4.1-Flash`|是|1000000|
|`MiniMax-M2.7`|否|204800|
|`Qwen3.6-27B-public`, `Qwen3.6-35B-A3B`, `Qwen3.8-27B`|是|262144|

- `GLM-5.3-public`：Provider 默认、tools；预算思考 `output_config.effort` 仅 `low`/`medium`(MUST 默认)/`xhigh`(MUST 映射 `ultra`)/`max`。
- Mnemopi 启用、无显式向量配置 → 文本向量 + 公司快照；启用不变。显式模型/地址/凭据及 `mnemopi.embeddingVariant` 优先，仅其 schema 默认让位；公司 Token 不发显式其他地址。
- `OPENROUTER_BASE_URL` 非官方或 `MNEMOPI_EMBEDDINGS_VIA_API` 真 → 通用 API 模型/地址/密钥，不用公司快照。仅共享密钥、无自定义网关不触发；官方主机仅 `openrouter.ai`/`www.openrouter.ai`，不认路径/相似域/其他子域。
- OpenAI 兼容 `/v1/embeddings`：去尾斜杠、不重复 `/v1`、保留其他前缀；禁探测其他路径/回退公网；须内网实测。临时过载可重试：最多 4 次(1+3)，默认指数退避 1s/2s/4s，公共策略；尊重服务端提示/超时/取消。
- 检索专用：文本向量 `Qwen3-Embedding-8B`(4096 维)、文本重排 `Qwen3-Reranker-8B` 均 32768 tokens；`Qwen3-VL-Embedding-2B`、`Qwen3-VL-Reranker-2B`。记忆用多样性排序，不远端重排、不自动混用/覆盖旧向量。

### Requirement: 保留 Provider ID 的运行时注册

MUST 忽略 `models.yml` `providers.codeagent`/`providers.company` 整段并提示；公司段不阻启动；CodeAgent 段格式/字段错不影响其他自定义 Provider。

#### Scenario: 拒绝替换

- **WHEN** 扩展/运行时注册 `company` 或 `codeagent`
- **THEN** 报错(禁换内置/实时 Provider)，注册/目录/其他 Provider 不变。

### Requirement: 重试回退链的路由剥离

含 `@` 字面 ID MUST 优先匹配，不作路由。

#### Scenario: 同源路由

- **WHEN** 重试回退复制 ID(含通配项)
- **THEN** 跨 Provider 剥离 `@upstream`，同 Provider 保留。

### Requirement: 容量未知的模型

缺值 MUST 显示未知，不代填零/本地预算或估值/他模型值/已知上限。

#### Scenario: 缺值判定

- **WHEN** `contextWindow` 或 `maxTokens` 缺失
- **THEN** 不按本地体量估算标超上下文/触发“先压缩再切换”。

### Requirement: Anthropic 思考块保真

本地投影器 MUST 为 Anthropic 兼容流保留不带增量的 `redacted_thinking`。

#### Scenario: 无增量块

- **WHEN** 本地投影器重建 Anthropic 兼容流 assistant 消息
- **THEN** 仅有首尾事件的块也原位原样持久化/回传，不改写或伪造签名。

### Requirement: Judge 候选池的会话作用域

Auto thinking/image/text/etc. judges MUST filter primary/fallback by session/project `enabledModels` before role-chain resolution, as in `ModelControls.getAvailableModels` and Team config. Unset: original pool. `withSessionFallback` still appends unfiltered session model. Judge only: main selection, other roles, compaction, title and Team member config unchanged; no user config rewrite or result caching.

#### Scenario: 作用域外模型不参与判定
- **WHEN** scope excludes remote judge default
- **THEN** scoped candidate or session model; no out-of-scope remote primary/fallback calls.

### Requirement: 补全层级的模型角色解析

`completion()` MUST 保留层级角色的回退身份；层级中仅 `slow` 发送思考档位。

#### Scenario: Tiers
- **WHEN** 以 `smol`、`default` 或 `slow` 层级补全
- **THEN** `slow` 用角色配置的档位；`auto`/未配置时，仅支持推理的模型请求最高支持档。`smol`/`default` 不因用户档位发送思考。启用回退时沿层级角色追加既有链，思考按上游回退规则及上述层级边界。

### Requirement: 自动角色别名的来源保留

Agent model overrides MUST retain matching auto-role origin, not expand to model ID.

#### Scenario: Alias
- **WHEN** subagent or vibe startup agent/task override matches auto-role alias
- **THEN** execution resolves inherited retry fallback by role.
