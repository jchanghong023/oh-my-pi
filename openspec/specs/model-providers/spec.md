# model-providers

## Purpose

规定 Provider 目录、模型选择和请求路由。可用性依平台、认证及 [offline 真值](../fork-runtime/spec.md#requirement-安装与运行)，不推断公网可达。

## Requirements

### Requirement: 沿用上游 Provider 目录

MUST 沿用上游 Provider 目录，不另设 fork 聊天 allowlist。

#### Scenario: 目录准入

- **WHEN** 合并目录、注册模型或列出登录入口
- **THEN** 沿用上游准入，不增加选择器语法或 SDK 拦截，不迁移或删除用户数据。

CodeAgent、Ascend、`company` 的凭据不写配置或日志；Ascend 和 `company` 不自动发现或回退到厂商公网 API。CodeAgent 和 Ascend 支持推理与工具，`maxTokens=32768`。

### Requirement: CodeAgent 内置模型

MUST 仅在 Windows 非 offline 注册 `codeagent/deepseek-v4.1-flash-1017`，末段同时为 ID 和名称，无须登录或手动配置。

#### Scenario: 内置请求

- **WHEN** 使用 CodeAgent
- **THEN** 走 `https://snapengine.cida.cce.prod-szv-y.dragon.tools.huawei.com/api/v2` 的 `openai-completions`；`auth: none`、`supports-strict-mode #false`、`contextWindow=409600`，不强制或禁用工具选择。
- **AND** `low`／`high`／`max` 发送 `thinking: {type: "enabled"}` 和对应 `reasoning_effort`；关闭或未指定时发送 `thinking: {type: "disabled"}`。延续 DeepSeek V4 的思考规则，以 `reasoning_content` 回传历史 assistant 思考。
- **AND** 启动从 Windows 用户注册表 `HKCU\Environment\JCH_CODEAGENT3_X_AUTH_TOKEN` 读取并缓存 `x-auth-token`，不用进程环境变量。认证或 API 请求失败时重读，读失败保留缓存；取消或内容拦截不重读。不换会话，凭据已变且尚无正文、思考或工具输出时重试一次。对话、压缩摘要及 handoff 无外层重发。

#### Scenario: 提交消息和标题的生成回退

- **WHEN** 快速生成提交消息失败，或标题候选认证、请求或解析失败
- **THEN** 不因 CodeAgent 提前终止上游分析、重试或回退。

### Requirement: Ascend 内置模型

MUST 内置下列模型，不改默认模型或角色，无须 `models.yml` 或登录，不内置密钥。

#### Scenario: 显式选用

- **WHEN** 普通或 offline 环境显式选用 Ascend
- **THEN** 用 `ASCEND_API_KEY` 作 Bearer，固定走 `http://models.ascend.huawei.com` 的 `anthropic-messages`，禁用严格工具模式。

| ID | 图片 | 上下文（tokens） |
|---|---|---:|
| `minimax2.7`、`kimi-k2.6`、`deepseek-v4-flash` | 否 | 200000 |
| `qwen3.8-27b` | 否 | 256000 |
| `qwen-aw-35b` | 是 | 200000 |
| `qwen3.8-flash-next` | 是 | 256000 |

均支持文本。`qwen3.8-*` 用 `anthropic-budget-effort`：`low`／`medium`／`high`／`xhigh`（默认）；`high` 向服务端发 `xhigh`。无计费数据，零值为占位，不表示免费。

### Requirement: 公司内网模型（仅 `OMP_OFFLINE`）

MUST 仅在 offline 读取公司认证；有效才注册 `company` 和允许向量回退。发现策略和角色默认仅在本进程生效。

#### Scenario: 准入与发现

- **WHEN** 在非 offline 环境初始化目录，或在该环境显式选择 `company`
- **THEN** 不注册、不发启动告警；显式选择失败并提示启用 `OMP_OFFLINE`。
- **AND** offline 自动发现只读缓存，涵盖登录后同步、自动刷新、selector-miss 和扩展发现；仅 `omp models refresh` 或模型面板手动刷新可访问显式配置的发现或模型端点。凭据刷新遵守 [offline 运行规则](../fork-runtime/spec.md#requirement-安装与运行)。

独立模型命令（含 `models`、`bench`、`compress`、`commit`、Git AI 提交和 `dry-balance`）在注册或解析前复用适用的 offline 初始化、角色和缓存规则，不另要求 offline 参数。`usage` 的目录只读缓存，实际请求照常，不虚构公司接口或额度。本地文件 `read` 和已有会话 `render` 不启动公司认证或在线发现；图片问答按需初始化。如果公司配置无效，明确报因；已解析的显式非 `company` vision/default 可用，依赖 `company` 时失败、不回退。

#### Scenario: 认证快照

- **WHEN** offline 启动或独立命令、SDK 需要公司认证
- **THEN** 异步读取 `settings.json`（`CLAUDE_CONFIG_DIR` 优先于 `~/.claude`），校验 `env.ANTHROPIC_BASE_URL` 和 `env.ANTHROPIC_AUTH_TOKEN`，仅存内存；无须登录、额外凭据或 `models.yml`。
- **AND** 每进程启动时只读一次（含失败）；Worker 等待并继承快照，不重读、不回退。凭据不入参数、环境变量、持久文件或日志；变更须重启。
- **AND** 无效认证禁用 `company`，显式调用失败。脱敏原因通过 TUI 或独立模型命令 stderr 各报一次；共享 SDK、认证发现和会话创建只提供可查状态，不直写终端。

聊天只用快照，经 Anthropic Messages + Bearer；均支持文本，`maxTokens=81920`。下表列出目录种子容量，offline 生效容量及角色默认见[运行规则](../fork-runtime/spec.md#requirement-安装与运行)。

| ID | 图片 | 目录种子上下文（tokens） |
|---|---|---:|
| `DeepSeek-V4-Flash-public`、`GLM-5.2-public`、`GLM-5.3-public` | 否 | 1000000 |
| `Deepseek-v4.1-Flash` | 是 | 1000000 |
| `MiniMax-M2.7` | 否 | 204800 |
| `Qwen3.6-27B-public`、`Qwen3.6-35B-A3B`、`Qwen3.8-27B` | 是 | 262144 |

`GLM-5.3-public` 为 Provider 默认，支持工具；`output_config.effort` 仅允许 `low`／`medium`（默认）／`xhigh`（发 `ultra`）／`max`。

**向量及重排：**

- Mnemopi 已启用且无显式向量设置：用公司文本向量和认证快照；显式模型、地址、凭据及 `mnemopi.embeddingVariant` 优先，只覆盖其 schema 默认。公司 Token 不发往显式配置的其他地址。
- `OPENROUTER_BASE_URL` 为非官方地址或 `MNEMOPI_EMBEDDINGS_VIA_API` 为真时，使用通用 API 模型、地址和凭据，不用公司快照。仅有共享密钥不触发；官方主机仅 `openrouter.ai`、`www.openrouter.ai`。
- OpenAI 兼容请求用 `/v1/embeddings`，保留自定义前缀，不重复 `/v1`，不探测其他路径或回退公网；须内网实测。临时过载最多请求四次，默认退避 1s／2s／4s，尊重服务端提示、超时和取消。
- 检索使用 `Qwen3-Embedding-8B`（4096 维）、`Qwen3-Reranker-8B`（两者均 32768 tokens）和 `Qwen3-VL-Embedding-2B`、`Qwen3-VL-Reranker-2B`。记忆只做多样性排序，不远端重排，不自动混用或覆盖旧向量。

### Requirement: 保留 Provider ID 的运行时注册

MUST 忽略并提示 `models.yml` 中的 `providers.codeagent`、`providers.company`；不阻启动或影响其他自定义 Provider，包括保留段本身配置无效时。

#### Scenario: 拒绝替换

- **WHEN** 扩展或运行时尝试注册 `company` 或 `codeagent`
- **THEN** 拒绝并报错，不替换内置 Provider。扩展加载与批次失败沿用上游。

### Requirement: 重试回退链的路由剥离

含 `@` 的字面模型 ID MUST 优先匹配，不作路由修饰。

#### Scenario: 同源路由

- **WHEN** 重试或回退复制模型 ID（含通配项）
- **THEN** 只在跨 Provider 时去掉路由后缀 `@upstream`。

### Requirement: Anthropic 思考块保真

Anthropic 兼容流 MUST 保留无增量的 `redacted_thinking`。

#### Scenario: 无增量块

- **WHEN** 重建 assistant 消息时只有块首尾事件
- **THEN** 仍原位原样持久化并回传，不改写或伪造签名。

### Requirement: 补全层级的模型角色解析

`completion()` MUST 保留层级角色的回退身份；仅 `slow` 发送思考档位。

#### Scenario: Tiers

- **WHEN** 以 `smol`、`default` 或 `slow` 补全
- **THEN** `slow` 用角色档位；`auto`／未设置时，仅向支持推理的模型请求最高档。`smol`／`default` 不因用户设置而发送思考。启用回退时沿用原角色链和上游回退规则。

### Requirement: 自动角色别名的来源保留

Agent 覆盖模型时 MUST 保留匹配的自动角色别名，不提前展开为模型 ID。

#### Scenario: Alias

- **WHEN** 子代理或 vibe 启动时的 Agent／任务覆盖匹配自动角色别名
- **THEN** 按继承的角色解析重试回退链。
