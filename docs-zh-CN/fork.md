# Fork 与上游差异

本仓库仅供个人使用：持续同步上游最新 `main`，保留个人功能和默认值，安装后无需额外配置即可使用，不以对外发布为目标。

本页面向本人和 AI agent，只记录**相对当前上游基线仍有效、对使用者有影响的功能差异**，不记录实现细节、修复或同步历史。开发规则见 `AGENTS.md`，同步步骤见 `.omp/skills/upstream-release-sync/SKILL.md`。

## 当前上游基线

* **分支**：`can1357/oh-my-pi@main`
* **版本**：`v18.2.6`
* **Upstream commit**：`6d31705a08530fcaa79c1ff45b4862c113184a18`
* **同步日期**：2026-09-20

## 当前功能差异

### Markdown 文档索引

* 索引管理只有两个命令：`omp docs init "<dir>" --name "<name>"` 新建（同名已存在直接报错）与 `omp docs remove <name> --force` 删除；没有 list/status/更新/重建等其他命令入口（`/wiki` 面板会列出已有索引供检索，并可直接发起这两个动作），索引也不记录状态或时间戳。删除只删数据库中的索引，不删源文件。
* 文档重新导出后，刷新方式固定为「先 remove 删除旧索引，再 init 新建」。本 fork 只维护这两个命令：新增其他索引维护入口属于超出当前契约的范围，NEVER 引入。
* 固定使用 SQLite FTS5 全文检索；在有界 BM25 候选中优先排列连续中文词组、带符号及边界的完整技术名称和当前章节标题匹配，同级继续按 BM25 排序。保留原有 AND 全词匹配作为精确档（全部词元都出现的章节优先）；不改变数据库结构；导入和查询不调用模型，不需要凭据、向量、结构化提取或 schema。
* 普通代理可用的只读 `wiki` 工具只有一个参数 `query`，用法等同搜索框：关键词或整句都可以，没有需要学习的语法（`AND`/`OR`/引号/通配都按普通字符处理）。分析在实现内完成：拉丁词与数字按整词匹配（`MBIST是什么` 这类中英粘连写法同样保留整词），汉字串按书写原样做相邻 bigram 切分（功能词整词丢弃，不先删单字功能词，避免产生语料中不存在的组合），查询之间是**并集**而非过滤，命中越多排序越靠前；超过 32 个词元的长查询按等距取样保留首尾，需求句的尾部技术点不会被丢弃。排序优先级：查询原样字面量出现在标题 → 出现在正文（`std::vector` 优于散落的 `vector std`）→ 全部词元都出现 → 同级按 BM25。返回命中章节的**完整 Markdown 正文**（每节带路径、行号区间、`sectionId`），单次上限约 20000 字符（页头行本身计入该预算；`query` 超过 500 字符会先截断——带省略号——再检索与回显，无命中错误的回显同样截断）；入库段落上限 18000 字符，因此任何命中都能整段返回。表头给出命中总数，页脚显示被预算截断、因过长跳过的段数与折叠的重复命中；跨文档逐字重复的段落只保留首条，其余折叠为指针行（约 200 字符以下的短重复不折叠）。转换器结构标签（`#### Cell` 之类，约 33 万条）不入库；标题本身即内容的需求/清单条目单独保留，以「仅有标题」形式返回。多个索引时一次查询覆盖全部索引。参数只接受 `query`；多带的无关键会被忽略，缺 `query` 时报错并指出实际收到的参数名与示例。
* 非受限会话中，显式声明 `read` 的工具清单会自动附加只读 `wiki`（含自定义 agent 的 `tools:` frontmatter 与 SDK/RPC 传入的清单）；受限清单（如 `/team` 子代理的工具集）不附加。
* 被强杀的中断导入留下的隐藏半成品索引（`list`/`remove` 都够不到）会在下一次 `init` 枚举到非空语料后回收，避免它长期占用空间。
* 数据库保存完整 Markdown 文字、原始路径和行号；导入成功后，查询不再依赖源目录。图片、附件及链接目标不随文字入库；路径和行号对应导入时的版本。
* 上游文档树内的 `docs/tools/wiki.md` 是 fork 新增文件：上游测试 `docs-tool-coverage` 要求每个内置工具都有 `docs/tools/<name>.md`，`wiki` 是 fork 新增内置工具，同步时该文件 MUST 保留。
* 导入全量成功后才公开索引，失败或取消不留下可见半成品；旧版全文或结构化数据库自动迁移，保留原文章节和全文检索，移除结构化数据。
* Markdown 围栏中的标题不拆分章节，结束围栏须使用相同字符、长度不少于起始围栏且后面仅有空白；支持 ATX/Setext 标题，CRLF 原文保持原始换行；Linux 上仅大小写不同的文档保持独立，终端展示过滤控制字符。

### OpenCode Zen

* `/models` 面板仅展示内置目录明确标为免费、且当前 input/output 价格均为 0 的 `opencode-zen` 模型。
* 缺失价格或未列入内置免费目录的模型隐藏，新发现模型即使报告零价也不例外；此过滤不代表全局禁用其他模型。

### 代理行为

* Todo 提示词默认以至少 3 个独立用户可见结果作为创建条件，常规检查 → 执行 → 验证算一个结果；仍保留用户明确要求、提供任务集合或中途追加指令等创建/更新条件。
* 工具集刷新（MCP、扩展、RPC 等变化触发的基准工具集重设）不丢弃扩展挂载的 `xd://` 设备：刷新后按「基准工具集 ∪ 存活挂载」恢复，保持原有顶层 / `xd://` 划分。

### 魔法关键词的内置命令与 fullsend

* 上游已有 `ultrathink`、`orchestrate`、`workflowz` 魔法关键词，可在任务正文中以独立小写词触发，无需整条消息只有关键词；代码块、行内代码和 XML/HTML 区域不触发。fork 新增的关键词只有 `fullsend`，遵循同样的匹配规则。
* fork 为这四个关键词新增对应的内置命令 `/ultrathink`、`/orchestrate`、`/workflowz`、`/fullsend`，方便输入，并允许命令后直接携带任务文本。
* `fullsend` 注入执行策略：成本和 token 用量不作为优化约束；在同等正确性、完整性与验证标准下缩短完成时间，端到端完成任务。仅做对速度或验证质量有实际收益的调用与并行，不把额外调用或花费视为目标，不扩大任务范围或权限。
* fullsend 通知与上游其他关键词的注入形态一致；经 collab 转发的用户输入（guest 发送的提示词与关键词命令）同样注入关键词通知。
* 有 `task` 工具且委派更快时，该策略要求并行处理独立工作；有等待任务则完成一个立即补位，任务不足并发上限时全部启动，不为凑并发扩大范围。这是对模型的提示词要求，不是程序调度保证。
* 用户设置 `magicKeywords.fullsend`（默认 `true`，/config → Interaction → Magic Keywords）可关闭 fullsend 关键词注入。

### `/team` 多模型方案讨论

* `/team <问题或需求>`：代码驱动的五阶段多模型规划流程（独立调查 → 对齐与比较 → 交叉审查 → 修订与复核 → 汇总方案），完整需求见 `docs-zh-CN/team.md`。只读规划命令：不执行计划、不修改项目文件，选择方案不等于授权实施；后续追问由主代理基于结果消息作答，实质需求变化提示带约束重跑。
* 参与模型由 `team.members`（完整模型 ID 列表）定义；未配置且 `--offline` 时默认取 company lane 全部可用聊天模型，未配置且普通启动直接报错并给出配置示例，不静默降级单模型。提案者集合 = 去重（`team.members` ∪ 当前会话模型）；主代理（发起会话的模型）承担对齐与综合子调用，本身不作审查者。用户应在综合能力最强的模型会话中发起 `/team`。
* 机械保证（代码而非提示词）：各提案子代理相同输入并行独立调查（受 `task.maxConcurrency` 约束）；审查者按提案者顺序轮转指派给下一个不同模型（单一模型时同模型新子代理）；审查 prompt 不含作者模型名；修订最多两轮（第三轮拒绝）；修订回应的结构化标志（含"举证反驳阻断问题"第四标志）触发新审查子代理复核；未解决阻断问题的方案无论综合文本如何都机械标注「尚不可采用」，对不可采用方案的推荐由结构化追踪否决。
* 全部子代理（提案/审查/修订/对齐/综合）工具集机械限制为只读（`read`/`grep`/`glob`/`wiki`/`ast_grep` + yield），编排器直驱 `runSubprocess` 生成路径、精确指定各子代理模型。结构化输出贯穿全程（schema 机械约束；提案 ≤ 4000 字、审查 ≤ 1500 字由 schema maxLength 与解析端截断双重执行）。
* 运行承载于会话 async job（`/tan` 同款机制）：阶段进度经任务状态呈现、子代理明细在 Agent Hub、取消经后台任务取消传播到所有在跑子代理。最终结果为一条 markdown 消息落入会话（含统一验收标准、方案状态结构化追踪表、参与完整性说明、固定收尾契约；存在实质影响选择的需求理解差异时置顶提示带答案重跑）。对齐或综合子调用失败即报告流程未完成，不输出半成品结论；提案/审查/修订子代理失败如实标注参与不完整、其余继续。
* 入口门禁：空参数提示补充问题，不猜测。子代理失败不自动重试、不自动替补。

### JCH 命令

保留以下个人命令及其核心语义：

* `/jchfix`：定位根因并最小修复，不提交、不推送。
* `/jchdiagnose`：只读诊断根因、影响和修复边界。
* `/jchfuncreview`：独立只读功能审查，仅报告高置信问题。
* `/jchfuncreviewfix`：审查后最小修复。
* `/jchverify`：只读验证指定修改是否可交付。
* `/jchfuncreview`、`/jchfuncreviewfix`、`/jchverify` 的范围参数：三命令都支持 `uncommitted`（未提交改动）与 `commit <ref>`；`/jchfuncreview` 与 `/jchverify` 另支持 `path <路径>`，`/jchfuncreviewfix` 另支持 `repo`（全仓）；空参或非法 verb 在执行前报用法错误。
* `/jchci`：只读分析当前 HEAD/PR 的 GitHub Actions。
* `/jchcifix`：修复当前有效 CI 失败，并仅提交、普通推送相关修改；push 后 CI 不会自然触发新 run 时，仅对已定义 `workflow_dispatch` 的 workflow 以 `--ref` 指向已推送分支执行 `gh workflow run`。
* `/jchcatchup`：查看本地状态/最近提交；`full` 时深入比较远端差异。
* `/jchgs`：`fetch --all` 后显示状态。
* `/jchgitpull`：直接按当前 upstream/pull 配置执行 `git pull`。
* `/jchgitdiscardall [--ignored=true|false]`：始终无交互确认，先执行 `git fetch --all --prune`、`git reset --hard @{upstream}`。无参数或 `--ignored=false` 时以 `git clean -df` 清理未跟踪内容，保留 ignored；`--ignored=true` 时以 `git clean -xdf` 同时清理 ignored 文件和目录。clean 以 `git rev-parse --show-toplevel` 解析的仓库根为工作目录，会话位于仓库子目录时同样清理整个工作树（reset 本就是全仓生效）。该命令在交互界面（TUI）执行；ACP/RPC 通道返回提示、不派发；print/SDK 通道没有内置命令派发，命令文本会原样作为用户消息进入模型。非法、重复或多余参数在任何 Git 操作前报用法错误；任一步失败即停止。重置目标是当前分支配置的跟踪分支，不是本仓库名为 `upstream` 的分支。
* `/jchdftexplain`：面向 DFT 新手解释文件、目录、代码和业务概念，命令参数为待解释对象。只读：可读取文件、搜索代码和调用 `wiki`，不修改文件、不执行待解释脚本、不启动 EDA 流程；内部术语主动用 `wiki` 核对并标注来源，代码解释按命令去重、结论先行。

### Codex 用户技能

* 默认启用 `skills.enableCodexUser`，`~/.codex/skills/*/SKILL.md` 与上游默认来源一并参与发现；来源优先级不变，同名技能仍优先取 `.agents/skills` 等上游默认开启来源中的版本。
* 仅适用于技能：`~/.codex` 下的 MCP、hooks、commands、AGENTS.md 等其它能力仍按上游规则保持 opt-in。
* 技能是否进入系统提示词列表仍由自身 `disable-model-invocation` / `hide` 决定；不可由模型调用的技能只通过 `/skill:<name>` 与 `skill://<name>` 使用。

### ZCode 本地代理（zcode-api）

* 内置 provider `zcode-api`，默认指向本机 ZCode Proxy（`http://127.0.0.1:8080`；环境变量 `ZCODE_API_BASE_URL` 以完整的 `http://主机:端口` 基地址覆盖；Anthropic 传输会自行去掉末尾斜杠与多余的 `/v1`），无登录、无配置即在模型面板与 `omp models` 中可见可用；`disabledProviders` 仍可禁用。
* 固定使用代理的 Anthropic Messages 直通路由（`/v1/messages`，与 Claude Code 同路径）：工具调用、thinking、上游错误状态原样传递，不经过 OpenAI 翻译层。不做模型发现，不写入 `models.json`（上游守护测试禁止内置目录携带回环地址），模型清单在运行时构建。
* 模型与参数照抄国内「智谱 coding plan」lane（`zhipu-coding-plan`）：14 个 GLM（`glm-4.5` / `glm-4.5-air` / `glm-4.6` / `glm-4.6v` / `glm-4.7` / `glm-5` / `glm-5-turbo` / `glm-5v-turbo` / `glm-5.1` / `glm-5.2` / `glm-5.2-highspeed` / `glm-5.3` / `glm-5.3-flash` / `glm-5.3-highspeed`），上下文窗口、最大输出、视觉输入、tokenizer 与价格同该 lane；`glm-5.2-highspeed[1m]` 是该 lane 的折叠别名，本 provider 无折叠表，不收录。思考档位与 coding plan 相同（多数 SKU `minimal`–`high`；`glm-5.2*` 为 `high`/`max`；`glm-5.3*` 为 `low`/`high`/`max`、默认 `max` 且不可关闭）。
* 默认无凭据：请求不携带有效密钥；若本机代理设置了 `auth.proxyApiKey`，用环境变量 `ZCODE_API_KEY`（或 `ZCODE_PROXY_API_KEY`）或 `models.yml` 的 `providers.zcode-api.apiKey` 提供；代理自身的上游登录状态不受影响。无凭据时直通不发送 `Authorization`，也不注入 `X-Api-Key`；`model.headers` 中显式给出的 `Authorization` 仍然生效。
* 兼容规则提供 tool_result id 镜像与思考模式适配；认证面无 login 流程，不出现在 `/login`。
* `models.yml` 中 `providers.zcode-api` 的 provider 级 `baseUrl` / `headers` / `compat` 不生效（运行时合成行绕过用户覆盖）；仅 `apiKey` 与环境变量 `ZCODE_API_BASE_URL` 参与配置。

### 公司内网模型（仅 `--offline`）

* `company` lane 只在 `--offline` 进程中存在：普通启动不注册该 provider，没有 company 模型、向量回退或启动警告；显式 `--provider company` 或 `--model company/...` 直接报错提示需要 `--offline`。以下条目均限于 `--offline` 进程。
* 内置 `company` provider，无需登录、填写凭据或创建 `models.yml`。OMP 启动时读取一次 Claude Code 配置目录（默认 `~/.claude`，可用 `CLAUDE_CONFIG_DIR` 覆盖，与其它 Claude 发现路径同一入口）下 `settings.json` 的 `env.ANTHROPIC_BASE_URL` 和 `env.ANTHROPIC_AUTH_TOKEN`；成功和失败均缓存，运行期间不重读、不监听文件，同进程 Worker 继承内存快照，修改配置须重启 OMP。
* URL 和 Token 仅保存在内存，不复制到 OMP 配置；配置缺失、字段错误或 JSON 无效时 provider 不可用，启动提示不包含凭据。
* 聊天使用 Anthropic Messages 协议和 Bearer 认证，不做公司模型发现、不请求对应厂商的公网 API。内置参数固定如下（token 数）：

  | Model ID | 输入 | 上下文 | 最大输出 |
  | --- | --- | ---: | ---: |
  | `DeepSeek-V4-Flash-public` | 文本 | 1,000,000 | 81,920 |
  | `GLM-5.2-public` | 文本 | 1,000,000 | 81,920 |
  | `MiniMax-M2.7` | 文本 | 204,800 | 81,920 |
  | `Qwen3.6-27B-public` | 文本、图片 | 262,144 | 81,920 |
  | `Qwen3.6-35B-A3B` | 文本、图片 | 262,144 | 81,920 |
  | `Qwen3.8-27B` | 文本、图片 | 262,144 | 81,920 |

* Mnemopi 已启用且没有显式向量配置时，自动使用 `Qwen3-VL-Embedding-2B`，复用启动缓存中的 URL 和 Token，不改变记忆系统的启用状态。显式向量模型、地址、凭据，以及显式设置的 `mnemopi.embeddingVariant` 仍优先（只有它的 schema 默认值会让位给公司模型）；不会将公司 Token 发送给显式配置的其他地址。
* 向量采用 OpenAI 兼容 `/v1/embeddings`：去掉 Base URL 末尾斜杠，已有 `/v1` 时不重复追加，保留其他路径前缀。不探测其他路径、不回退到公网；公司网关兼容性需要内网实测。
* 检索模型目录仅包含 `Qwen3-VL-Embedding-2B` 和 `Qwen3-VL-Reranker-2B`，不包含 8B 模型，两种检索模型不作为聊天模型展示。现有记忆流程只接文本向量，默认的 `Qwen3-VL-Embedding-2B` 也只传文本，图片向量与远端 Reranker 尚未接入检索流程。

### 交互界面 SIGINT 保护与诊断

* 交互界面（TUI）下，进程级 SIGINT 不再首个信号即整体退出：首个信号被消费并提示「SIGINT received — press Ctrl+C again to exit」，5 秒确认窗口内再次 SIGINT、teardown 进行中的任何 SIGINT、或未注册门控时的任何 SIGINT，仍走原有信号退出路径（session_exit 记录 `sigint`，exit 130）。动机：Windows 控制台 ctrl 事件（Break 键、共享控制台被翻回 processed input、兄弟进程广播 `GenerateConsoleCtrlEvent`）会绕过 raw mode 直接以信号到达，历史上一次事件即摧毁带在跑子代理的会话。Ctrl+C 按键路径（raw mode、500ms 双击）与非交互通道（print/ACP/SDK、CI `kill -INT`）行为不变；SIGTERM/SIGHUP 不加门。
* Windows 上每次进程级 SIGINT 会把当时的控制台诊断追加到日志目录的 `sigint-diagnostics.log`：stdin 的 console input mode（含 `ENABLE_PROCESSED_INPUT` 等标志解码）与同控制台附加进程清单（pid + 映像名，即 ctrl 事件的广播受众），用于事后归因「未按键却收到 SIGINT」。其他平台不写该文件；诊断失败被吞掉，绝不影响信号处理。

### Collab 长期链接与网页端命令

* 房间身份（roomId、房间密钥、write token）持久化在 config root 的 `collab/identity.json`（POSIX 下 `0600`；文件含 write token，Windows 依赖 config root 的 ACL，与 guest replica 同）。同一进程内每个房间复用同一身份：`/new`、`/resume`、`/fork`、`/collab stop` 后重开、以及 omp 重启后，`/collab` 打印的同一条链接始终可用；房间仍按会话轮换（`generation` 递增、guest 重连），不引入常驻进程。文件损坏或缺失时自动重建，第二个 omp 进程托管同一身份时由 relay 以既有 4009 提示拒绝（`/collab` 报 `relay connection closed during startup: a host is already connected for this room`；`/collab list` 可看到占用该房间的会话，停掉它或直接用它的链接）。
* `/collab`、`/collab view` 执行后自动把对应的浏览器深链接写入系统剪贴板，并在提示块末尾说明；终端链接与二维码行为不变。
* host 在 guest 加入时（快照分片之后）下发本会话的命令清单：内置命令、`/skill:<name>`、扩展命令、自定义/MCP 命令与文件命令，与主机自身补全列表一致；清单每次 join 下发一次，运行中的技能/插件变化需重新 join 才可见。
* fork 的网页端（含上述补全与目录选择）随中文文档站一起发布到 GitHub Pages：`https://jchanghong023.github.io/oh-my-pi/collab/`，`collab.webUrl` 默认指向它，`/collab` 的链接因此形如 `https://jchanghong023.github.io/oh-my-pi/collab/#<relay-link>`，外部浏览器（含跨网络设备）可直接使用；中继托管的 `my.omp.sh` 是上游构建，永远不会带 fork 功能。把 `collab.webUrl` 置空则回到上游行为（按 `collab.relayUrl` 推导，即 `my.omp.sh`）；本地开发该客户端时用 `collab.webUrl=http://localhost:3000`（`packages/collab-web` 的 `bun run dev`）。
* 网页端 composer 支持 `/` 补全（`Tab` 补全、`↑`/`↓` 选择、`Esc` 关闭、鼠标点选），可执行的命令范围与清单一致：内置命令、技能、扩展/自定义/文件命令，以及 `!`/`!!`（主机 shell）与 `$`/`$$`（主机 python）；会话轮换类命令（`/new`、`/resume`、`/fork`、`/exit` 等）同样开放。清单之外的斜杠输入按未知命令回错，不再当作 prompt 交给模型。持有可写链接者因此可在主机上执行任意 shell/python 与任意会话操作，绕过 agent 策略与审批；view-only 链接仍被拒绝。
* 命令输出（如 `/move <path>` 的 `Moved to <path>.`）以 host notice 事件下发到浏览器；需要主机交互对话框的命令（选择器等）在主机 TUI 上打开。
* `/move`、`/add-dir` 的路径候选由 host 的文件系统搜索提供（同一 TUI 覆盖层数据源），仅限可写链接；候选只做前缀匹配与目录列举，不执行、不落盘。
* 网页端收到 `bye`（会话轮换、`/collab stop`、重启）不再结束页面：保留链接进入自动重连（指数退避），同一 roomId 的新房间建立后自动加入；`/collab stop` 后页面持续显示重连中，直到再次 `/collab`。
* `COLLAB_PROTO` 保持 `3`：新增帧为加性扩展，旧客户端忽略未知帧；网页端对旧 host 的目录请求 10 秒超时后按无候选处理。

### Windows 行为修复

* 内建工具（`rg`、`grep` 等）的 stdout 与 stderr 指向普通文件时按块缓冲写出，与 Unix 行为对齐：`rg 模式 > out.txt` 的输出在工具退出前对并发目录遍历不可见，避免遍历器匹配到自己正在增长的输出、把少量命中放大成 GB 级结果；`>f 2>&1` 时 stderr 与 stdout 一致，不再按行即时落盘。判断在 SIGPIPE 保护包装流之前完成（包装后无法再区分文件与管道），也不改变管道/终端下的行缓冲。
* hashline 标签的路径恢复在 Windows 上与非 Windows 一致：比较前对恢复路径与工作目录都清理 `\\?\` verbatim 前缀，避免 std canonicalize 产生的 verbatim 形式 cwd 使恢复被静默拒绝。
* 临时目录删除在 Windows 上先强制一次 GC 再重试（Bun 在 GC 阶段才释放 SQLite `db` / `-wal` / `-shm` 的文件与目录句柄），已关闭的数据库不会把删除阻塞数秒。

### 上游缺陷的本地行为修复

以下为 fork 对上游基线代码的本地修复，记录的是当前有效的行为契约（上游修复合入后按同步流程复核并撤除本地补丁）：

* 用户级 mcp.json（当前 profile 的 agent 目录）解析失败时不再使整个 MCP 加载失败：该文件不贡献任何条目——`disabledServers` / `enabledServers` 列表按空处理并记录警告，项目 `.mcp.json` 等其他来源照常加载；`/mcp` 写入命令遇到损坏的该文件时仍报错、不静默覆写。
* LSP 共享 mux daemon 在语言服务器进程退出后保持存活：会话清理向已退出子进程 stdin 的写入失败只记录警告，不再以 unhandledRejection 终止 daemon、拖断全部 omp 实例的 LSP 链路。

### 默认设置

保持以下 fork 默认值：

* `recap.enabled=false`
* `statusLine.compactThinkingLevel=false`
* `composer.shape=pi`
* `theme.dark=dark-terminal`（浅色主题仍为上游默认 `light`）
* `display.showTurnTime=true`
* `task.maxConcurrency=8`
* `mnemopi.embeddingVariant=multilingual`
* `stt.language=zh-CN`（区域标签归一化为基语言，如 `zh-CN`→`zh`；仅对 whisper tier 生效，默认 tier parakeet/sherpa 不使用语言参数）
* `collab.webUrl=https://jchanghong023.github.io/oh-my-pi/collab/`（fork 网页端，随文档站发布；置空回退上游按 relay 推导的行为）
* 文件日志默认关闭；临时开启方式见“安装与运行”。

### 快捷键与状态栏

* `Shift+Tab`：计划模式。
* `Ctrl+T`：临时模型。
* `Alt+P`：thinking blocks 显示/隐藏。
* `Shift+F1`：循环切换 thinking level。
* 状态栏默认显示 active time，并支持窄终端自动换行；`composer.shape=band` 除外——其状态行位于编辑器顶带，装不下的段按上游行为省略，不生成换行行。
* `composer.shape=pi` 时状态栏独立位于输入框下方。
* `@` 文件补全在输入、删除字符时立即过滤已有候选，不等待后台目录搜索完成；网络文件系统上的新文件仍需等待扫描结果，后台搜索保持串行，避免堆积 I/O。过滤把候选清空时弹窗不吞键：Enter 照常提交草稿、Tab 走普通补全、方向键移动光标。

### 安装与运行

* `omp --log-file` 仅为本次启动启用现有轮转文件日志，写入当前 profile 的默认日志目录；例如 `omp --profile work --log-file`。不启用控制台日志、不写持久配置；未传参数时默认不写文件，也不覆盖已有显式日志配置。
* 默认启动、`omp launch`、`omp acp`、`omp join`、`omp setup` 这些经过会话启动路径的进程，若未设置 `PI_WALK_WORKERS` 且本机逻辑核数 > 8，会在进程内把文件遍历线程数设为 `min(核数/2, 16)`（32 逻辑核 → 16）；逻辑核数 ≤ 8 时保留 native 默认值 4。只改当前进程环境，不写配置文件，用户显式设置的值（含 `0`）永远优先；其他子命令（`omp grep`、`omp models` 等）不受影响。
* `--offline` 进程中若未设置 `FS_SCAN_CACHE_TTL_MS`，进程内设为 `30000` 毫秒；该变量只影响 `@` 文件补全的目录重扫间隔，非 offline 进程完全不变，用户显式设置的值（含 `0`）优先。
* `omp --offline` 以无公网模式启动本次进程：临时把 `web_search.enabled`、`browser.enabled`、`fetch.enabled` 关为 `false`，所有 `company` 聊天模型的 `contextWindow` 设为 `200000`（不改 `maxTokens`）。这些覆盖不写配置文件，退出即消失，普通启动保持原值。Python Eval 沿用原有解释器配置与自动发现机制。系统提示词仍追加“当前处于 offline 模式，环境无公网。不要尝试访问公网；使用本地资源和公司内部服务。”。公司内部模型 API、bash/eval、本地文件、LSP、本地 Git、Computer Use 等能力仍可用。
* `--offline` 且 company provider 可用时，仅为未配置的 model role 补充当前进程默认值：`default`、`task`、`vision`、`advisor` → `company/Qwen3.6-27B-public`；`smol`、`tiny`、`commit` → `company/Qwen3.6-35B-A3B`；`plan`、`slow` → `company/GLM-5.2-public`。已有角色配置和显式 CLI 模型参数仍优先，不写配置文件，不限制 `/model`、`Ctrl+T` 或角色切换，也不锁定 company。普通启动不受影响。
* `--offline` 当前进程将 `startup.setupWizard` 覆盖为 `false`，不自动弹出或导入首次启动的全屏配置向导；显式启用的启动动画按需独立加载，手动设置入口保持原有行为。
* `--offline` 启动不检查 OMP 新版本、不自动检查或更新插件市场、不读取或展示启动更新日志，也不自动触发在线模型发现——含交互界面就绪后的后台发现，以及会话恢复、默认角色解析和 `enabledModels`/`--models` scope 预解析里的 discovery fallback（这些自动路径只用本地缓存，缓存缺失时按既有链路降级，不发任何请求）。已安装插件、内置和缓存模型照常加载；显式 `--model` 解析、手动模型刷新、更新命令及 `/changelog` 保持原有行为。上述覆盖只在当前进程生效，不写配置文件，非 offline 启动不受影响。

以下是现有个人分发能力，不代表对外发布目标；上游同步不触发构建或发布。

* 个人 Release 版本使用 `+fork.N`，仅从本仓库 `main` 通过手动 CI 生成；`N` 取 `.github/workflows/ci.yml` 工作流的 `run_number`，GitHub 按工作流文件路径维护计数，重命名或删除重建该文件会让 `N` 从 1 重新开始（与历史 tag 撞号、旧安装收不到后续更新），NEVER 这样做。
* 二进制必须携带 fork 版本、构建时间和更新仓库信息。
* 本地构建脚本 `packages/coding-agent/scripts/build-binary.ts` 同样注入本 fork 更新仓库：本地构建产物的 `omp update` 指向本 fork Release，不会回退官方渠道（版本号不注入，`--version` 无 `+fork.N` 后缀属预期）。
* `omp update` 按 fork build counter 判断更新，并支持 `%2B` 编码的 `+` 版本 URL。
* `update.channel=canary` 在 fork 二进制上不可用：启动版本检查会提示该配置并指向 `omp update --stable`；其余更新检查失败仍静默。
* `-fork.N` 时代（fork build ≤ 35，2026-08-26 及更早）的旧安装内嵌只认 `vX.Y.Z-fork.N` 的校验，会拒绝此后所有 `+fork.N` Release（报 `Invalid fork release tag`）且无法自愈，只能用安装器重装后再交给 `omp update`。
* 安装器只安装 fork Release 的预编译二进制：Linux x64/arm64、Windows x64。
* 安装器替换目标二进制时不中断运行中的 omp：Linux 用同目录原子 `mv`；Windows 先把旧 `omp.exe` 重命名到唯一的 `.omp.old.*` 再换入（换入失败自动回滚），仅当重命名失败（如杀软锁定）才回退为按安装路径精确匹配强杀，`.omp.old.*` 残留由下次安装尽力清扫。强杀回退中若换入再次失败、或换入失败后回滚也失败，保留已下载的 `.omp.tmp.*` 文件作为安装目录内可恢复的二进制（重跑安装器即可恢复）。

### 文档站

* 仓库根 `README.md` 是上游 README 的**中文版**，正文跟随上游更新；Install / 下载段与「提示词控制」中 fork 新增的 `fullsend` 条目为有意保留的 fork 内容（下载段不采用上游的 npm / Homebrew / Nix / mise / `omp.sh` 写法），其余正文与上游一致。上游英文快照保存在 `docs-zh-CN/README.upstream.md`，仅作同步对照稿源，已从中文文档站排除。
* `README.md` 与三份维护文档一样在同步时保护：上游 README 有变化时先更新快照，再把变化段落重译进中文正文；上游未变则不动。
* 只保留中文 VitePress 文档站及 GitHub Pages 部署能力；不维护英文站点，不为上游英文 `docs` 提供构建或 `/en/` 子路径合并。
* 中文站不是纯翻译站点：以覆盖上游全部文档的完整翻译为目标，同时收录 fork 新增文档——站点首页 `index.md`、命令与快捷键教程 `command-shortcut-tutorial.md`、`config.yml` 全量设置参考 `settings-reference.md`、知识索引研究 `dft-oh-my-pi-knowledge-research.md`、`/team` 需求文档 `team.md` 和 fork 契约 `fork.md`；翻译独立同步，内容可能落后于当前代码基线。
* 翻译页 `magic-keywords.md` 与 `settings.md` 内含 fork 专有条目（fullsend 关键词与 `/fullsend` 等四命令、`magicKeywords.fullsend` 设置行）；对照上游同步这些页面时 MUST 保留这些条目。
* 站点构建把 `../packages`、`../crates` 前缀的仓库相对链接改写为本 fork GitHub 绝对链接，避免 Pages 上的死链。

## Fork 验证体系

三级命令为 fork 专属验证入口，名称与职责全新设计；旧入口 `jch-localci`、`jch-dev-ui-test` 废弃，能力并入新体系：

* `bun run fastcheck`：静态检查 = TS 三件套（类型检查、lint、格式）+ Rust 静态检查（cargo check），只查不测、不产构建物。整体设 60 秒墙钟硬超时：超时杀掉运行中的子进程、输出 TIMEOUT 与已耗时间并判失败（冷缓存如同步后首次 Rust 编译超时属预期失败，无时限完整静态验证由 fulltest 以 `FASTCHECK_BUDGET_MS=0` 复用同一静态门承担）。agent 可按需自主调用；TypeScript 修改后 MUST 运行。脚本自身测试 `scripts/fastcheck.test.ts`（本地并入 `test:scripts`，CI workspace 作业亦直接引用）。
* `bun run fulltest`（仅限用户明确要求）：fastcheck 全部静态检查（以无预算模式复用同一静态门，冷缓存不因 60 秒预算在第一阶段中止）+ 当前操作系统的 fork 绿色测试集合 + 构建当前宿主平台 native addon。TS 阶段运行 fork 维护的白名单测试组（清单在 `scripts/fulltest.ts`：core 各包关键组、coding-agent 关键组与 fork 功能测试），结果非黑即白，不设失败豁免或失败基线；上游全量 TS 分片不在本地跑（大量用例假设 POSIX 文件系统/权限语义，Windows 上不可运行），由 slowtest 触发的 Linux CI 流水线全量覆盖。Rust（先以 `cargo test --no-run` 编译、再以 `cargo nextest` 运行；Windows 自动把 VS Build Tools 的 CMake/Ninja 注入 PATH，`.cargo/config.toml` 固定 Ninja 生成器）、脚本测试、UI 冒烟（原 `jch-dev-ui-test` 并入：PTY 启动 `bun run dev` TUI，断言全屏渲染/交互/Ctrl+D 退出，仅使用本地构建的 native addon；基础用例启动参数固定 `--offline --profile localci-ui`，不触发向导与外网请求；`/team` 用例使用 `--profile localci-ui-team --model zcode-api/glm-5.2`（不带 `--offline`），经环境变量把 zcode-api 基地址指向本地 stub server，仅 localhost 通信、不访问外网；`--debug` 可转储 TUI 原始输出）。每个测试执行阶段（TS 白名单、Rust 测试运行、脚本测试、UI 冒烟）设 3 分钟硬超时，编译时间不计入，超时即杀掉子进程、停止尚未启动的后续测试组，并判 fulltest 失败。Python 组件（`python/omp-rpc`、`python/robomp`，上游附带的自托管 GitHub bot 服务）fork 无改动，不在本地验证范围，`bun run test:py` 入口保留供手动使用。只运行当前操作系统对应的测试，不维护 WSL2/双平台测试运行能力。端到端冒烟与安装器 E2E 不在本地跑，由 slowtest 的流水线覆盖。
* `bun run slowtest`（仅限用户明确要求）：fulltest 全部内容 + 把本地 `main` 自动 push 到远端，触发仓库 GitHub Actions CI（手动 `workflow_dispatch`），并持续轮询监控该次运行直到结束，返回成功/失败结论与失败日志入口；除总耗时外逐阶段输出耗时（fulltest、push、触发+出现、CI 监控）。

同步时需重新应用的测试级适配（上游重写对应文件后会丢失，且上游 CI 覆盖不到）：`is_regular_file` 需导入 `pi-builtins` 的测试宿主模块（fork 自有代码，上游不编译该目标）；`pi-shell` 的 jobspec 强杀测试预算放宽到 600 秒、该测试目标的 bazel `timeout` 设为 `long`（CI 分片 CPU 争用；bazel 默认 300 秒上限会先于用例内预算触发）；同一测试的两个管道进程按序自停（第二个轮询第一个的 ready 文件后才 `kill -STOP`，降低并发停止下 `waitid(All)` 扫掉多个 WUNTRACED 通知的竞争）；配套的 vendored 修复：`crates/vendor/brush-core` 的 `ChildProcess::wait` 在 SIGCHLD/SIGTSTP 监听之外以 250ms 定时器（首次触发立即执行）重复轮询 stopped children——子进程在等待者订阅信号监听之前自停时，其 SIGCHLD 会被 tokio 信号注册表的广播直接丢弃（当时无接收者），仅靠信号等待会永久挂起（2026-09-19 CI 在代码路径零改动的 600 秒挂死即此竞态），轮询兜底保证 stop 状态总能经 `waitid` 被观察到；`pi-shell` 的 `incomplete_utf8_at_eof_becomes_replacement` 在 Windows 上改用 UTF-8 回退构造器（上游 `new()` 在非 UTF-8 ACP 主机上会把 EOF 悬挂字节按设计交给 ACP 解码，DBCS 代码页产出默认字符 `?` 而非替换符，与该用例期望冲突；上游 CI 仅 Linux 测不到）；mcp stdio pidfile 轮询只接受活进程 pid；`startup-composer-graph` 测试把注册表路径归一化为 `/`（Windows）；`oauth_callback` 测试在无头/SSH/WSL 会话遇到 `Unsupported` 时跳过；`pi-vcs` 的 git 测试以 `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM` 指向空设备、`pi-vcs` 与 `natives` 的 git 测试在 fixture 内固定 `core.autocrlf=false`（hermetic 化，防宿主配置破坏字节级断言）；`pi-vcs` 另有 worktree 断言剥 `\\?\` 前缀的 Windows 适配，以及 index 快照失败用目录占位替代 `chmod 000` 的 root 确定性改造（该用例仍为 unix 门控：Windows 上打开目录得到 `PermissionDenied` 而非 `IsADirectory`，不随本地验证在 Windows 运行）；`pi-shell` 的 registry 期望列表在 Windows 上不含 `errno`（`cfg!(unix)` 条件注入）、find/fd/rg 输出断言接受平台路径分隔符（`.\`、`sub\nested.txt` 形态），`pi-edit` 的两个 hashline 测试以真实临时目录 cwd 替代 POSIX 字面路径（`/workspace`、`/tmp/work` 在 Windows 无法剥离），`pi-edit` 的 `file:///tmp/a%20b` 百分号解码断言门控 unix；`pi-shell` 的 `uutils_find_display_and_actions_split_paths` 整例在 Windows `ignore`，`wait_jobspec_observes_background_stop_after_dropped_sigchld`（SIGCHLD 丢弃竞态回归，unix 门控）为 fork 新增用例；`pi-builtins` 的 stat `win_tests` 模块补上游缺失的 `tempdir` 助手（上游从未在 Windows 编译该 `cfg(all(test, windows))` 目标）、`timeout` 的 preserve-status 用例在 Windows 断言 128（无信号语义，交付信号号为 0 的确定性映射）、`timeout` 的信号拼写表与 `-s KILL` 单独杀停两用例门控 unix（Windows 无 kill(2) 信号表与 SIGKILL 语义）；`session-manager` 的三个 temp 会话目录用例（`-tmp` 命名与两段迁移）在 Windows 跳过（上游 home 优先分类把 %TEMP% 下的 cwd 归为 home 命名，用例隐含「tmpdir 不在 home 下」的 Linux 假设）；`packages/coding-agent/test` 的一批适配（上游重写对应文件后同样会丢失）：`write-shebang-chmod`（2 处）与 `shell-snapshot`（4 处）chmod 用例门控非 Windows、`task/worktree` fixture 固定 `maintenance.auto=false`、`task/structured-subagent` 与 `settings-reload-cwd` 清理先 `AgentStorage.close()` 再 `removeWithRetries`、`profile-cli` 隔离 `USERPROFILE`、`read-multi-range` 断言以 `/` 连接路径（hashline 头固定 `/` 分隔）、`bash-failure-result` 以 `Settings.init({ inMemory: true })` 隔离、`modes/controllers/event-controller-idle-compaction` 显式 `recap.enabled: true`、`docs-index` 的非门控 symlink 用例在 Windows 跳过（EPERM）；另一批与平台无关的上游测试滞后适配：上游重设计 sloppy 载荷语法（`<SM:EDIT path="…">` XML 形态改为 `*** SM:EDIT <路径>` 头部形态、正文到下一个识别头或 EOF、无闭合分隔符）后，`tools/edit-renderer`（2 例）、`edit-blackbox`（1 例）、`edit-tool-details`（1 例）、`session/inline-edit-recovery`（1 例，内嵌载荷移到消息末尾以避免正文吞并后续散文）、`tools/approval`（1 处共享 fixture，覆盖 4 例 tier 分类与 1 例 prompt 文件行显示）仍用旧语法，已改为新语法；上游 catalog 重构（757b49a4bc 统一发现与路由）把本地 llama.cpp 的 Qwen 方言改为 `qwen-chat-template`（`enable_thinking`/`preserve_thinking`/`reasoning_effort` 只走 `chat_template_kwargs`，不再顶层双发；允许档位列表类拒绝在 kwargs 原地改值、字段不支持类拒绝提升顶层）后，`ai/test/issue-3528-repro`（5 例）、`ai/test/openai-compat-policy`（3 例）、`ai/test/openai-reasoning-effort-fallback`（2 例）仍断言旧顶层形状，已按新 kwargs 形状改写（各形状均经实现探针核实，非弱化）；上游自行修正这些测试后，同步时丢弃本适配；`scripts/musl-release.test.ts` 门控 Linux（POSIX sh 工具链与冒号 PATH 依赖）；`shell-snapshot` 的 fn-env helper 三例（`test/shell-snapshot.test.ts`）解析真实 POSIX bash（文件既有的 `REAL_BASH`，Windows 回退 Git for Windows 的 `Program Files\Git\bin\bash.exe`），两者都不存在时跳过——Windows 上 PATH 里的 `bash` 常是 WSL 启动器，把 helper 经 `-c` 传入会被破坏、子进程空输出（本机即此情形）；`fastcheck` 的 TS 阶段与上游 `check:ts` 同构（`check:tools` + 每个声明 `check:types` 的包），仅把包级检查以有界池（4 路）并行调度以守住 60 秒预算——上游若增删 `check:ts` 的组成，需同步调整 `scripts/fastcheck.ts` 的 `listTypeCheckPackages`/相位定义；`pi-natives` 的 `timeout_drains_pipeline_output_before_stopping_reader` 超时预算放宽到 3000ms（750ms 在 Windows 上仍会输给饱和 nextest 并发下外部 `yes` 的启动延迟，`tail` 环缓冲为空、断言 0≠5；单跑约 1s 通过，实测整目录并发 1/3 轮失败）；`slash-commands/acp-builtins.ts` 的 ACP 面板必须惰性构建（`acpBuiltinSlashCommands()` / `acpBuiltinReservedNames()`，首次调用时记忆化）：该文件与 `builtin-registry` 同处一个导入环（registry → builtin-marketplace → extensibility/plugins → extensions/loader → index.ts → main.ts → modes/rpc/rpc-mode → acp-builtins → registry），在模块求值期读取注册表会让 `import "@oh-my-pi/pi-coding-agent/team"` 一类入口直接抛 `Cannot access 'BUILTIN_SLASH_COMMANDS_INTERNAL' before initialization`；上游重写该文件需保留惰性（或上游自行修复后丢弃本适配）。已知边界：`pi-builtins` 完整测试套件在 Windows 上另有约 21 个上游既有失败（信号表、POSIX 输出形态类），fork 本地验证范围（fulltest 的 Rust 核心 crate 集合）本就不含该 crate，不逐项适配。`slash-commands/rename.test.ts` 的 2 例（`discards a pending rename after switching away and back to the same session`，TUI/headless 各一）同样在白名单外：会话文件经 `path.join(sessionDir, …)` 写入（用例的 `/sessions` 字面量 → 盘符相对的 `\sessions\<id>.jsonl`），而 switch/load 链经 `path.resolve` 读取（→ `D:\sessions\<id>.jsonl`），按字符串键的内存存储因此未命中（preload 打点确认全程无 `rename`/`unlink`，并非文件被删）；POSIX 上两种拼写相同、真实用户传入完整 sessionDir 时 join≡resolve，属上游用例的 POSIX 字面量假设，确定性失败且与 fork 改动无关（该用例未引用任何 ACP 面板值，也未改 `executeAcpBuiltinSlashCommand`）；可选修法：改用真实临时目录，与 `read-multi-range`/`pi-edit` hashline 的同类适配一致。`collab/controller.test.ts` 的 session-switch 用例（`revokes the old room before publishing the next generation on a session switch`）断言前任与新房间共享同一条链接（`second.webLink === first.webLink`，房间轮换由注册表的 generation 断言覆盖）：fork 的持久身份（`collab/identity.ts`）让同进程的每个房间复用同一链接，上游的链接轮换断言在此不成立（上游重写该文件需重新应用本适配）。
