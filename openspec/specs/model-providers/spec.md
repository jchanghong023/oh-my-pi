# model-providers

## Purpose

规定 fork 的 CodeAgent、Ascend 和公司内网模型接入、发现、认证与请求边界。不同运行环境和显式模型选择的条件必须分别遵守，不推断公网可用。

## Requirements

### Requirement: CodeAgent 内置模型

OMP MUST 无需单独登录或手写模型配置即可发现内置模型，认证轮换仅按规定条件重试。

#### Scenario: CodeAgent 内置模型的详细边界

- **WHEN** 本节所述功能在适用条件下运行
- **THEN** 以下具体约束适用：

- Windows 非 offline 启动内置 `codeagent/DeepSeek-V4-Flash-0731-CodeAgent`，无需配置或登录；非 Windows 平台不注册该内置模型，`OMP_OFFLINE` 生效时所有入口隐藏，其他 Provider 行为不变。
- 固定 base URL `https://snapengine.cida.cce.prod-szv-y.dragon.tools.huawei.com/api/v2`，API `openai-completions`，`auth: none`，禁用严格工具模式（OpenAI 兼容轴 `supports-strict-mode #false`，不使用仅适用于 Anthropic 的 `disableStrictTools`）；模型 ID 与名称均为 `DeepSeek-V4-Flash-0731-CodeAgent`，支持 reasoning 与 tools，contextWindow `200000`，maxTokens `32768`。
- Windows 启动直接读取 `HKCU\Environment\JCH_CODEAGENT3_X_AUTH_TOKEN` 并在内存缓存，作为 `x-auth-token` 请求头；正常请求不重读注册表，不使用进程环境变量快照。
- 认证或 API 请求失败时重读注册表；新 Token 与请求所用 Token 不同则刷新缓存，并仅在尚无流式正文、思考或工具输出且未取消时自动重试一次；Token 未变化不重试。此限制覆盖对话、压缩摘要与 handoff，不允许外层重试或认证、模型、压缩方法回退重新发送失败请求。已产生流式输出的请求只刷新后续请求的缓存，禁止重放；刷新无需重启、切模型或创建新会话。
- 凭据不写配置或日志，不改变其他 Provider 的缓存、认证或重试行为；注册表读取失败不清除已缓存 Token。
- `models.yml` 的 `providers.codeagent` 为保留 ID，整段忽略并提示，不允许该段的格式或字段错误使其他自定义 Provider 配置失效。

#### Scenario: CodeAgent 内置模型的可观察行为

- **WHEN** Windows 非 offline 启动并选择 CodeAgent
- **THEN** 无需单独登录或手写模型配置即可发现内置模型，认证轮换仅按规定条件重试

### Requirement: Ascend 内置模型

OMP MUST 普通或 offline 场景使用内置模型目录与固定服务，不要求额外模型文件或改变默认模型。

#### Scenario: Ascend 内置模型的详细边界

- **WHEN** 本节所述功能在适用条件下运行
- **THEN** 以下具体约束适用：

- 内置 `ascend`，设置环境变量 `ASCEND_API_KEY` 即可使用，无需创建 `models.yml` 或登录；普通与 offline 进程均可显式选择，不改变现有默认模型或角色。密钥不内置、不写入 OMP 配置或日志，认证复用现有环境变量解析与 Bearer 请求头。
- 固定地址 `http://models.ascend.huawei.com`，使用 `anthropic-messages`，禁用严格工具模式；不进行 Ascend 模型目录发现，不回退至厂商公网地址。HTTP 为用户指定地址，传输不加密。

  | Model ID | 输入 | 上下文 | 最大输出 |
  | --- | --- | ---: | ---: |
  | `minimax2.7` | 文本 | 200000 | 32768 |
  | `kimi-k2.6` | 文本 | 200000 | 32768 |
  | `deepseek-v4-flash` | 文本 | 200000 | 32768 |
  | `qwen3.8-27b` | 文本 | 256000 | 32768 |
  | `qwen-aw-35b` | 文本、图片 | 200000 | 32768 |
  | `qwen3.8-flash-next` | 文本、图片 | 256000 | 32768 |

- 全部模型支持 reasoning 与 tools；两个 `qwen3.8-*` 模型使用 `anthropic-budget-effort`，档位为 `low`、`medium`、`high`、`xhigh`，默认 `xhigh`，`high` 映射为服务端 `xhigh`。未提供计费信息，不将占位零费率视为免费承诺。
- 使用示例（PowerShell）：`$env:ASCEND_API_KEY = "<你的密钥>"`，随后运行 `omp --model ascend/qwen3.8-flash-next`；`omp models ascend` 查看内置目录。

#### Scenario: Ascend 内置模型的可观察行为

- **WHEN** 用户显式选择 Ascend 且提供 ASCEND_API_KEY
- **THEN** 普通或 offline 场景使用内置模型目录与固定服务，不要求额外模型文件或改变默认模型

### Requirement: 公司内网模型（仅 `OMP_OFFLINE`）

OMP MUST 注册固定 company 模型与未配置角色默认值；缺失或损坏配置明确报错且不泄露凭据。

#### Scenario: 公司内网模型（仅 `OMP_OFFLINE`）的详细边界

- **WHEN** 本节所述功能在适用条件下运行
- **THEN** 以下具体约束适用：

- `company` lane 只在 offline（`OMP_OFFLINE=1`）进程中存在：普通启动不注册该 provider，没有 company 模型、向量回退或启动警告；显式 `--provider company` 或 `--model company/...` 直接报错提示需要 `OMP_OFFLINE=1`。`models.yml` 中名为 `company` 的 provider 段整段忽略（该 id 为 fork 保留），命中时启动会输出保留提示（不阻断启动）。以下条目均限于 offline 进程。
- `OMP_OFFLINE=1` 下的 `omp models` 与 `omp bench <selector…>` 采用与进程级 offline 同一套 company 语义：先翻转 lane 再构建 registry，因此 `omp models` 列出公司聊天模型、`omp bench` 能解析并压测 `company/<模型>` 选择器；刷新与 selector-miss 的发现回退都用 cache-only 策略、不发公网模型发现请求；公司配置缺失或无效时把公司 provider 的错误原因写到 stderr，不静默。`omp dry-balance`、`omp read`、`omp render`、`omp usage` 按实际需要复用既有初始化与 cache-only 策略，不新增平行注册流程：
  - `dry-balance` 在解析模型前初始化 company lane；`read "<图片路径>?q=<问题>"` 按需初始化 company 与 vision 角色，再向选中的模型发出真实请求。显式配置且解析成功的非 `company` vision／default 角色仍按用户选择执行，公司配置错误须可见但不阻断该显式路径；需要默认或显式选择的 `company` 模型时，配置缺失或无效须明确失败，不允许隐式回退到其他 Provider。
  - 普通 `read` 本地文件与 `render` 渲染已有会话不需要公司配置，不为此触发 auth discovery 或在线模型发现；实际需要 MCP、远端服务或模型的读取仍沿用相应能力的认证与请求流程。
  - `usage` 复用现有账号与 usage provider 流程，只将模型目录发现限制为 cache-only；不禁用真实 usage／公司模型 API 请求，不虚构 company usage 接口或额度数据。实际需要初始化 company 的路径须让配置错误可见且不泄露凭据。
  - 上述 lane、角色默认值与发现策略仅在当前 offline 进程生效，不持久化；非 offline 行为不变，不注册公司 provider，也不把 cache-only 扩展为所有网络请求的禁令。
- `omp compress`、`omp commit` 与 Git AI 提交等独立模型消费者同样在注册／解析前启用 company lane、进程角色默认值及 cache-only 目录发现；未显式传递 offline 选项也不能绕过进程 offline 策略。实际模型／OAuth 请求仍按用户选择执行，不将目录发现限制扩大成网络请求总禁令。
- 内置 `company` provider，无需登录、填写凭据或创建 `models.yml`。OMP 启动时读取一次 Claude Code 配置目录（默认 `~/.claude`，可用 `CLAUDE_CONFIG_DIR` 覆盖，与其它 Claude 发现路径同一入口）下 `settings.json` 的 `env.ANTHROPIC_BASE_URL` 和 `env.ANTHROPIC_AUTH_TOKEN`；成功和失败均缓存，运行期间不重读、不监听文件，同进程 Worker 继承内存快照，修改配置须重启 OMP。
- URL 和 Token 仅保存在内存，不复制到 OMP 配置；配置缺失、字段错误或 JSON 无效时 provider 不可用，启动提示不包含凭据。
- 公司配置诊断由入口负责呈现：交互式启动使用现有 TUI 警告通知，独立模型命令使用 stderr；共享 SDK 初始化、认证发现、会话及子代理创建不得直接写终端流，同一命令内重复初始化不得重复输出启动警告。不可用状态与具体配置错误仍可查询，显式选择不可用公司模型仍按原规则失败。
- 公司聊天复用 Anthropic 流的既有空闲检测：空正文、空思考及空工具参数 delta 不算有效进展，也不能延长 ping 保活窗口；非空片段和其他协议事件保持既有处理，不新增超时机制、不调整现有时限、不增加自动重试或后台任务。
- 聊天使用 Anthropic Messages 协议和 Bearer 认证，仅请求上述 Claude Code 配置中的地址，不做公司模型发现，也不自动发现或回退到对应厂商的公网 API。内置参数固定如下（token 数）：

   | Model ID                   | 输入       |    上下文 | 最大输出 |
   | -------------------------- | ---------- | --------: | -------: |
   | `DeepSeek-V4-Flash-public` | 文本       | 1,000,000 |   81,920 |
   | `GLM-5.2-public`           | 文本       | 1,000,000 |   81,920 |
   | `MiniMax-M2.7`             | 文本       |   204,800 |   81,920 |
   | `Qwen3.6-27B-public`       | 文本、图片 |   262,144 |   81,920 |
   | `Qwen3.6-35B-A3B`          | 文本、图片 |   262,144 |   81,920 |
   | `Qwen3.8-27B`              | 文本、图片 |   262,144 |   81,920 |

- Mnemopi 已启用且没有显式向量配置时，自动使用 `Qwen3-VL-Embedding-2B`，复用启动缓存中的 URL 和 Token，不改变记忆系统的启用状态。显式向量模型、地址、凭据，以及显式设置的 `mnemopi.embeddingVariant` 仍优先（只有它的 schema 默认值会让位给公司模型）；不会将公司 Token 发送给显式配置的其他地址。
- company 嵌入默认值同样让位于通用 API 路由：company lane 激活时，若 `OPENROUTER_BASE_URL` 指向非 openrouter 主机（自定义通用网关），或 `MNEMOPI_EMBEDDINGS_VIA_API` 为真值（显式要求向量走 API），向量改按通用 API 配置解析（模型、地址、密钥），不注入公司 URL 与 Token；仅有共享的通用 API 密钥而无自定义网关地址时不构成让位条件。官方嵌入地址判定仅认可 `openrouter.ai` 和既有 `www.openrouter.ai` 别名，不因路径、相似域名或任意子域包含该字符串就信任它。
- 向量采用 OpenAI 兼容 `/v1/embeddings`：去掉 Base URL 末尾斜杠，已有 `/v1` 时不重复追加，保留其他路径前缀。不探测其他路径、不回退到公网；公司网关兼容性需要内网实测。
- 检索模型目录仅包含 `Qwen3-VL-Embedding-2B` 和 `Qwen3-VL-Reranker-2B`，不包含 8B 模型，两种检索模型不作为聊天模型展示。现有记忆流程只接文本向量，默认的 `Qwen3-VL-Embedding-2B` 也只传文本，图片向量与远端 Reranker 尚未接入检索流程。

#### Scenario: 公司内网模型（仅 `OMP_OFFLINE`）的可观察行为

- **WHEN** OMP_OFFLINE 开启且有效 Claude Code 配置可用
- **THEN** 注册固定 company 模型与未配置角色默认值；缺失或损坏配置明确报错且不泄露凭据

### Requirement: 保留 Provider ID 的运行时注册

扩展与运行时 MUST NOT 替换 `company`、`codeagent` 两个保留 Provider；注册这类 ID MUST 失败并返回明确错误，而不是静默覆盖。

#### Scenario: 扩展或运行时注册保留 ID

- **WHEN** 扩展或运行时通过 Provider 注册入口注册名为 `company` 或 `codeagent` 的 Provider
- **THEN** 注册 MUST 失败，并返回指明该 Provider 为内置或实时 Provider、不可替换的错误
- **AND** 既有注册状态、模型目录与其他 Provider 的注册行为保持不变。

#### Scenario: 注册其他 Provider

- **WHEN** 扩展或运行时注册其他 ID 的 Provider
- **THEN** 沿用既有注册、校验与凭据解析行为，不受保留 ID 限制影响。

### Requirement: 重试回退链的路由剥离

重试回退链 MUST 只在目标 Provider 与来源 Provider 相同时保留 `@upstream` 路由；跨 Provider 复制模型 ID MUST 剥离该路由。

#### Scenario: 回退项指向其他 Provider

- **WHEN** 回退链把失败模型解析到与来源不同的 Provider
- **THEN** 生成的候选选择器 MUST NOT 携带来源 Provider 的 `@upstream` 后缀
- **AND** 目录中确实存在的字面模型 ID（本身含 `@`）优先按字面解析，不被当作路由选择器。

#### Scenario: 通配回退项仍指向同一 Provider

- **WHEN** 通配回退项解析后的 Provider 与来源 Provider 相同
- **THEN** 候选 MUST 保留原 `@upstream` 路由。

### Requirement: 容量未知的模型

模型的上下文窗口或最大输出缺失时 MUST 视为未知，MUST NOT 当作本地预算、零容量或已知上限。

#### Scenario: 容量未知的展示与选择

- **WHEN** 模型的 `contextWindow` 或 `maxTokens` 为空
- **THEN** 界面 MUST 以未知占位形式显示，不得补 0、不得借用其他模型或本地估算的数值
- **AND** 该模型 MUST NOT 因本地估算的对话体量被标记为超出上下文，也 MUST NOT 触发“先压缩再切换”路径。

### Requirement: Anthropic 思考块保真

Anthropic 兼容流经本地投影器重建 assistant 消息时，`redacted_thinking` 块 MUST 按源位置原样保留。

#### Scenario: 缺少增量事件的加密思考块

- **WHEN** 流中出现仅有开始与结束事件、没有增量事件的 `redacted_thinking` 内容块
- **THEN** 该块 MUST 按原始内容与源位置合并进持久化的 assistant 消息，并在后续请求中原样回传
- **AND** MUST NOT 伪造签名、改写内容，也 MUST NOT 因其缺少增量事件而丢弃。
