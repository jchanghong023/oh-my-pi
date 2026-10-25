# model-providers

## Purpose

规定 fork 的 CodeAgent、JchTools、Ascend 和公司内网模型接入、发现、认证与请求边界。不同运行环境和显式模型选择的条件必须分别遵守，不推断公网可用。

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

### Requirement: JchTools 零配置发现与远端 Agent

OMP MUST 从真实目录注册模型；选用后按来源投影历史并以 ACP/SSE 交给远端 Agent。

#### Scenario: JchTools 零配置发现与远端 Agent的详细边界

- **WHEN** 本节所述功能在适用条件下运行
- **THEN** 以下具体约束适用：

- Windows 上默认通过当前用户、当前登录会话的 JchTools 控制管道进行只读发现，仅接收版本化服务身份、状态、实例标识、实际运行 HTTP 地址与能力；不读取或暴露启动程序、参数、凭据及保存配置，不启动、应用配置、重启或停止服务。服务缺席或未就绪时探测有界，不阻塞正常启动与模型选择。
- 仅在服务已就绪、发现身份与能力匹配时访问实际端点的 `GET /v1/models`，按返回的真实模型 ID 注册进程内 `jchtools/<ID>`；不猜测端口、不伪造模型、不写 OMP 配置，不自动改变默认模型、角色或用户选择。`disabledProviders` 禁用 `jchtools` 或进程环境 `OMP_JCHTOOLS_DISCOVERY=0` 时不探测、不注册；此开关只影响当前进程，不持久化。JchTools 启动的子 Agent 继承关闭发现的防递归保护，服务端职责统一按 JchTools AH 需求执行。
- 启动及模型选择器打开/刷新时重新发现：OMP 先启动、服务后启动也能出现；服务重启或应用新端口后按新实例与实际地址刷新，撤销失效目录和地址，不继续使用旧端点。可用性变化不自动切换模型或补发已有任务。
- 选择该 provider 即进入真实远端 Agent 模式，OMP 仅作为文本/SSE 的 ACP 客户端，而非普通模型的客户端工具循环：不注入自己的 system、工具 schema／指令或技能正文，不发送工具调用控制字段，不在前端执行工具；后端 ACP Agent 的系统提示、工具、技能、决策、执行与权限边界以 JchTools `docs/requirements/ACP-MODEL-SERVICE.md` 的 AH-03～AH-05 / AH-13 为权威，不在本仓库替换或重复实现。
- 请求使用 `POST /v1/chat/completions` 的受支持文本消息、流式选项、后端公布的模型 ID 及顶层 `cwd` 字符串。2026-10-12 用户确认：仅 `server_agent` 模式按来源投影用户亲自提交的原文、用户明确提供的任务背景／约束及当前聊天的完整可见用户／助手文本历史；普通模型接口不变。OMP 生成的系统／开发者提示、技能正文、工具定义／指令、子代理规则、魔法关键词通知、Goal 编排／授权／自动提醒及其他自动通知、推理、工具调用／结果和调试元数据不进入请求，即使已持久化为 user 角色也不变成用户亲自提交内容。用户亲自输入的“使用 scout”、system/developer、目标或授权等字面文本原样保留，不按正文关键词清洗，也不要求 JchTools 全局丢弃其他调用方显式提供的 system/developer 背景。普通模型历史中的可见用户／助手文本保留，工具和推理记录不转入远端。接口仍仅接受文本，用户媒体输入明确报错，不扩展图片／工具协议。
- 远端任务 slash 命令按用户原文提交给后端 Agent；公开 SDK、TUI、RPC 与 ACP 输入链不执行或展开 OMP 本地 extension 命令、custom prompt、file templates 或同名技能，不读取 OMP 本地技能正文，不用本地模板或技能覆盖同名远端命令。ACP slash 按官方协议由 Agent 识别原始命令前缀（如 `/web ...`），不是 OMP 的本地工具调用。宿主本地管理命令的派发、状态和确认机制保持不变；被本地管理命令消费的输入不作为远端任务重放。
- 每个 ACP 会话使用调用方当前任务目录。OMP 每次请求从当前会话的运行目录取得绝对、已存在目录，通过独立 `cwd` 字段显式传给 JchTools；后端 ACP 会话及省略目录的终端回调使用该目录。受支持的内置文本请求（含显式远端角色的补全、提交推断/摘要、编辑修复、标注摘要、技能描述、语音改写、标题/任务标签及内存处理）同样传递所属任务目录；后台会话消费者在请求时读取当前目录，命令消费者使用该命令的任务目录，隔离子任务使用其工作树目录。不扩展图片或客户端工具能力，不改变模型角色选择。目录缺失、相对或不可用时明确失败，不从提示猜测，不静默使用进程全局目录，不修改进程全局 cwd。
- 当前聊天首次请求不带后端会话 ID，保存成功响应的 `X-JchTools-Session-ID`，后续自动回传；仍发送按来源投影后的完整 HTTP 历史，供 JchTools 校验并仅向 ACP 提交新增部分。新建／分支聊天、任务目录或服务地址改变时不复用旧关联；切换离开该模式也清除关联。关联仅在内存中保存，不跨进程／后台重启恢复；新投影规则使用版本化关联键并清除旧键，旧聊天下次用投影后的历史建立新后端会话。后端明确报告 `session_unavailable`，或请求已发出 HTTP／ACP 后被取消时，清除该内存关联，不采纳该轮会话头或因迟到响应恢复关联；本轮不自动重试或重放，下一次用户显式请求不带已取消／失效会话 ID，建立新会话。不因其他 HTTP 错误清除关联，不采纳错误响应的会话头。
- 响应按真实 SSE 文本增量展示；取消传播到在途 HTTP 请求并按 JchTools 取消契约收尾，已发送请求的取消同时按上述规则清除内存会话关联。HTTP、协议、后端与中途断流错误如实呈现，保留已收到文本但不伪称成功。任何失败、取消或服务重启均不自动重试、回退模型或重放任务。
- CLI/TUI 明确展示“后端 Agent 执行”，不把后端文本伪造成前端工具事件或已验证的工具执行记录；模型目录缺失的上下文、输出容量等元信息不得作为已确认的远端实际能力宣称，界面所需占位值不构成容量承诺。
- 验收须覆盖本地单元与集成测试，以及真实 CLI/TUI 或公开 SDK 入口连接实际 JchTools 服务、由合成 ACP Agent 提供可核对行为的端到端测试，验证发现／禁用、防递归、后启动／重启刷新、真实 ID、按来源投影且保留真实用户原文／背景／约束和完整可见历史、不注入 OMP system／tools／skills／Goal 或魔法通知、SDK 远端 slash 原文送达且不执行／展开本地 extension／custom／file templates、TUI／RPC／ACP 同名技能不消费远端原文或读取本地技能文件、宿主本地管理命令不变、完整 HTTP 历史与 ACP 新增提交、同聊天复用、新建／分支／目录隔离、实际会话及终端工作目录、增量输出，以及已发请求取消后清除关联、下一次用户显式请求新会话且不自动重试／重放。合成 Agent 或本地测试通过不代表真实 OpenCode／付费模型、账号与任务质量已验证；真实 OpenCode 多轮验证须当次另行授权，未执行的验收不得标为通过。

#### Scenario: JchTools 零配置发现与远端 Agent的可观察行为

- **WHEN** Windows 用户的 JchTools 服务就绪且模型身份匹配
- **THEN** 从真实目录注册模型；选用后按来源投影历史并以 ACP/SSE 交给远端 Agent

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
