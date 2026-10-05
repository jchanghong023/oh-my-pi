# Fork 与上游差异

本仓库仅供个人使用：持续同步上游最新 `main`，保留个人功能和默认值，安装后无需额外配置即可使用，不以对外发布为目标。

本页面向本人和 AI agent，只记录**相对当前上游基线仍有效、对使用者有影响的功能差异**，不记录实现细节、修复或同步历史。开发规则见仓库根 `AGENTS.md`，同步步骤见 `.omp/skills/upstream-release-sync/SKILL.md`；需求域划分见[目录索引](README.md)。本文现有功能条款保留为需求基线，本次整理未运行功能验证，历史验证描述不代表当前验收通过。代码定位索引的独立契约见[代码定位索引](repo-index.md)。

## 当前上游基线

* **分支**：`can1357/oh-my-pi@main`
* **版本**：`v18.6.2`
* **Upstream commit**：`1c0993c3d12e70042169a951663bb2702e2c0a9e`
* **同步日期**：2026-10-04

## 预采纳的上游 PR（上游合并后删除对应条目）

以下条目是上游尚未合并的开放 PR，本 fork 已提前合入。每次上游同步后核对：PR 已被上游合并（进入基线）时删除对应条目——此时同步流程会自然带入同一改动，保留条目只会制造假差异。

* **#13802**（live-steered 队列条目标记为已发送）：`QueuedMessagesSnapshot` 新增 `liveSteered` 计数，`get_state.queuedMessages` 与 `queue_update` 透传；TUI 队列带把已发送条目渲染为锁定的 Sent 组。RPC 快照接线移植进 `RpcSessionHost`（`rpc-mode.ts` 保持传输壳）；fork 侧 `queuedMessages` 文案段（rpc.md）保留 fork 版并融入 `liveSteered` 语义。上游 v18.6.0 把 Python 客户端重组为 `sdk/python/omp-rpc` 并改用机器可读 wire schema 生成各语言类型（生成入口 `bun run gen:rpc`），fork 将 `liveSteered` 补进 wire DSL（`QueuedMessagesState`/`QueueUpdateEvent`，旧服务器省略时解码为 0）并随同步重新生成全部工件。合入提交 `52316aa576`。
* **#13689**（恢复会话的保存模型不可用时 fail closed）：启动 `--continue`/`--resume` 与运行时 `switchSession` 在无法恢复保存模型时对无 UI 路径报错 `Could not restore model <provider/id>`（TUI 保持警告后切换）；RPC `open_session`/`switch_session` 新增可选 `provider`/`modelId` 绑定对（按 `set_model` 校验，`findRpcModel` 等待在途发现）。RPC 接线（`resolveRequestedRpcModel`、`handleRpcSessionChange`/`openRpcSession` 的 model 参数）移植进 `RpcSessionHost`。Python 客户端随上游 v18.6.0 重组为 `sdk/python/omp-rpc`（wire schema 生成）后，fork 侧补丁为：wire DSL 给 `open_session`/`switch_session` 声明可选 `provider`/`modelId`（`bun run gen:rpc` 重新生成各语言工件），手写 `client.py` 另维护 fork v3 入口（`negotiate_protocol_v3`、`send_fork_frame`、`get_messages` 的 v3 分页分支）。合入提交 `bfa4d40847`。
* **#14110**（RPC hosts 的 `/btw` 侧问）：`btw`/`btw_cancel`/`get_btw_history` 三命令 + `btw_delta`/`btw_record` 流式帧，问答不进 transcript、存 `btw-history` sidecar；`btw_cancel` 进 BACKGROUND_COMMANDS 可超车串行队列，会话变更与 dispose 前强制 close。全套接线（`RpcBtwController`、三命令 case、dispose 通知）移植进 `RpcSessionHost`，`rpc-client.ts` 的 `btw`/`cancelBtw`/`getBtwHistory` 方法由上游自带合入，项目模式已路由三命令。合入提交 `ec11e7c411`。

## 当前功能差异

### Markdown 文档索引

* 索引管理只有两个命令：`omp docs init "<dir>" --name "<name>"` 新建（同名已存在直接报错）与 `omp docs remove <name> --force` 删除；没有 list/status/更新/重建等其他命令入口（`/wiki` 面板会列出已有索引供检索，并可直接发起这两个动作），索引也不记录状态或时间戳。删除只删数据库中的索引，不删源文件。
* 文档重新导出后，刷新方式固定为「先 remove 删除旧索引，再 init 新建」。本 fork 只维护这两个命令：新增其他索引维护入口属于超出当前契约的范围，NEVER 引入。
* 固定使用 SQLite FTS5 全文检索；在有界 BM25 候选中优先排列连续中文词组、带符号及边界的完整技术名称和当前章节标题匹配，同级继续按 BM25 排序。保留原有 AND 全词匹配作为精确档（全部词元都出现的章节优先）；档位判断基于章节**完整正文**（超长候选按需加载全文评分，不因性能截断而丢失词组档）；单次查询的候选、命中正文与计数来自**同一读快照**，并发 remove+init 不会拼出"旧路径行号 + 无关新正文"；不改变数据库结构；导入和查询不调用模型，不需要凭据、向量、结构化提取或 schema。
* 普通代理可用的只读 `wiki` 工具只有一个参数 `query`，用法等同搜索框：关键词或整句都可以，没有需要学习的语法（`AND`/`OR`/引号/通配都按普通字符处理）。分析在实现内完成：拉丁词与数字按整词匹配（`MBIST是什么` 这类中英粘连写法同样保留整词），汉字串按书写原样做相邻 bigram 切分（功能词整词丢弃，不先删单字功能词，避免产生语料中不存在的组合），查询之间是**并集**而非过滤，命中越多排序越靠前；超过 32 个词元的长查询按等距取样保留首尾，需求句的尾部技术点不会被丢弃。排序优先级：查询原样字面量出现在标题 → 出现在正文（`std::vector` 优于散落的 `vector std`）→ 全部词元都出现 → 同级按 BM25。返回命中章节的**完整 Markdown 正文**（每节带路径、行号区间、`sectionId`），单次上限约 20000 字符（页头行本身计入该预算；`query` 超过 500 字符会先截断——带省略号——再检索与回显，无命中错误的回显同样截断）；入库段落上限 18000 字符，因此任何命中都能整段返回；该上限调低前建的旧索引中超出页预算的段落仍会在作为首个命中时整段返回（保证内容可读），页脚会标注该超限，重建索引即可消除。表头给出命中总数，页脚显示被预算截断、因过长跳过的段数与折叠的重复命中；跨文档逐字重复的段落只保留首条，其余折叠为指针行（约 200 字符以下的短重复不折叠）。转换器结构标签（`#### Cell` 之类，约 33 万条）不入库；标题本身即内容的需求/清单条目单独保留，以「仅有标题」形式返回。多个索引时一次查询覆盖全部索引。参数只接受 `query`；多带的无关键会被忽略，缺 `query` 时报错并指出实际收到的参数名与示例。
* 非受限会话中，显式声明 `read` 的工具清单会自动附加只读 `wiki` 与 `repo`（含自定义 agent 的 `tools:` frontmatter 与 SDK/RPC 传入的清单）；受限清单（如 `/team` 子代理的工具集）不附加。
* 被强杀的中断导入留下的隐藏半成品索引（`list`/`remove` 都够不到）会在下一次 `init` 枚举到非空语料后回收，避免它长期占用空间。
* 数据库保存完整 Markdown 文字、原始路径和行号；导入成功后，查询不再依赖源目录。图片、附件及链接目标不随文字入库；路径和行号对应导入时的版本。
* 上游文档树内的 `docs/tools/wiki.md` 是 fork 新增文件：上游测试 `docs-tool-coverage` 要求每个内置工具都有 `docs/tools/<name>.md`，`wiki` 是 fork 新增内置工具，同步时该文件 MUST 保留。
* 导入全量成功后才公开索引，失败或取消不留下可见半成品；旧版全文或结构化数据库自动迁移，保留原文章节和全文检索，移除结构化数据。
* Markdown 围栏中的标题不拆分章节，结束围栏须使用相同字符、长度不少于起始围栏且后面仅有空白；支持 ATX/Setext 标题，CRLF 原文保持原始换行；Linux 上仅大小写不同的文档保持独立，终端展示过滤控制字符。

### 当前仓库代码定位索引

完整行为、验收条件与验证边界统一维护在[代码定位索引需求](repo-index.md)。

### 代理行为

* Todo 提示词默认以至少 3 个独立用户可见结果作为创建条件，常规检查 → 执行 → 验证算一个结果；仍保留用户明确要求、提供任务集合或中途追加指令等创建/更新条件。
* 工具集刷新（MCP、扩展、RPC 等变化触发的基准工具集重设）不丢弃扩展挂载的 `xd://` 设备：刷新后按「基准工具集 ∪ 存活挂载」恢复，保持原有顶层 / `xd://` 划分。

### 魔法关键词的内置命令与 fullsend

* 上游已有 `ultrathink`、`orchestrate`、`workflowz`、`jevify` 魔法关键词，可在任务正文中以独立小写词触发，无需整条消息只有关键词；代码块、行内代码和 XML/HTML 区域不触发。fork 新增的关键词只有 `fullsend`，在与上游同一份关键词表（`modes/magic-keywords.ts`）中注册，匹配、注入与高亮规则一致，设置项与内置命令同样按该表生成。
* fork 为这四个关键词新增对应的内置命令 `/ultrathink`、`/orchestrate`、`/workflowz`、`/fullsend`，方便输入，并允许命令后直接携带任务文本。
* `fullsend` 注入执行策略：成本和 token 用量不作为优化约束；在同等正确性、完整性与验证标准下缩短完成时间，端到端完成任务。仅做对速度或验证质量有实际收益的调用与并行，不把额外调用或花费视为目标，不扩大任务范围或权限。
* fullsend 通知与上游其他关键词的注入形态一致；经 collab 转发的用户输入（guest 发送的提示词与关键词命令）同样注入关键词通知。
* 有 `task` 工具且委派更快时，该策略要求并行处理独立工作；有等待任务则完成一个立即补位，任务不足并发上限时全部启动，不为凑并发扩大范围。这是对模型的提示词要求，不是程序调度保证。
* 用户设置 `magicKeywords.fullsend`（默认 `true`，`/settings` 面板 → Interaction → Magic Keywords）可关闭 fullsend 关键词注入。

### `/team` 多模型方案讨论

完整行为与验收条件统一维护在[多模型方案讨论需求](team.md)，此处不重复条款。

### rpc-ui 协议与项目运行服务

目标是用本 fork 的 OMP 替换 ZCode 内部 Agent CLI，保留核心界面。**ZCode 功能是接入基线，不是 OMP RPC 能力上限；须开放 OMP 已有业务命令、多代理通信和详细工具过程，GUI 按 OMP 能力适配。**ZCode 负责调用适配与桌面展示；**最高优先级为普通消息、技能调用与补全、内置命令与补全、子代理过程查看，以及模型选择：会话临时切换不写配置，界面显示全部可配置 role，修改后自动保存 OMP 配置。**OMP 补齐项目内多会话、命令执行与补全、子代理历史恢复和会话归属、完整 role 目录与逐项持久保存，复用必要运行能力；技能管理按后续优先级完成。已有接口按业务归属审查，不以已经实现为保留理由；通用文件搜索、界面反馈等不作为新接入依赖。接口取舍、架构分层、参数与结果、事件流、兼容迁移、分仓实施工作包和验收统一见[rpc-ui 协议与项目运行服务](rpc-ui-protocol.md)。2026-09-29 完成 OMP 侧首轮实施：`--mode rpc-ui --rpc-project` 项目模式（单进程多会话、零会话目录查询、命令目录/补全/严格执行、技能管理双视图、子代理持久目录与控制入口、完整 role 目录与逐项持久保存），单会话旧模式命令集不变（上游 v18.4.10 起其输入排序与取消语义变化，见该文档 §14.4、§17.3）；实施与验证状态见该文档 §17.3。ZCode 侧接入未开始，GUI 真实验收未执行。

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

### Codex 压缩默认模型

* 压缩候选链（主模型自身、model role 兜底、最大上下文兜底，含 advisor 上下文维护的同名解析）里凡落到 `openai-codex` provider 的候选一律替换为 `openai-codex/gpt-6-luna` 后再参与认证与 remote 资格过滤；luna 不在可用模型中（未认证/被禁用）时保留原候选，不阻断压缩回退。服务器压缩（Responses V2 流式）因此也在 luna 上执行；preserve 数据的 provider 仍是 `openai-codex`，与主模型同 provider，原生回放不受影响。
* 显式配置的 `compactionModel`（models.json `modelOverrides`）不被替换：用户显式指定优先于本默认值。
* 以 `gpt-6-luna` 为压缩模型时，压缩请求的推理档位固定为 `low`（本地摘要、handoff、短摘要与 V2 流式服务器压缩共用同一生效点 `resolveCompactionEffort`），不继承会话当前档位——包括 high/max、未设置时的 high 默认与显式 Off。
* 仅约束压缩链路：主模型选择、主模型推理档位及其他 provider 的压缩行为不变；luna 作为主模型正常使用时档位不受影响（钉制只在压缩调用生效）。

### ZCode 本地代理（zcode-api）

* 内置 provider `zcode-api`，默认指向本机 ZCode Proxy（`http://127.0.0.1:8080`；环境变量 `ZCODE_API_BASE_URL` 以完整的 `http://主机:端口` 基地址覆盖；Anthropic 传输会自行去掉末尾斜杠与多余的 `/v1`），无登录、无配置即在模型面板与 `omp models` 中可见可用；`disabledProviders` 仍可禁用。
* 公司环境（`--offline` 且 Claude settings 提供可用公司配置）中该 lane 在所有入口隐藏：`omp models`、TUI `/models` 面板与模型解析都不再列出或解析 `zcode-api`，只保留公司内网模型（见下节）。判定条件是「公司配置可用」而非单纯的 `--offline` 标志——无公司配置的 `--offline` 进程（例如家用 `--offline` 搭配本机代理）仍照常可见可用。
* 固定使用代理的 Anthropic Messages 直通路由（`/v1/messages`，与 Claude Code 同路径）：工具调用、thinking、上游错误状态原样传递，不经过 OpenAI 翻译层。不做模型发现，不写入 `models.json`（上游守护测试禁止内置目录携带回环地址），模型清单在运行时构建。
* 模型与参数照抄国内「智谱 coding plan」lane（`zhipu-coding-plan`）：14 个 GLM（`glm-4.5` / `glm-4.5-air` / `glm-4.6` / `glm-4.6v` / `glm-4.7` / `glm-5` / `glm-5-turbo` / `glm-5v-turbo` / `glm-5.1` / `glm-5.2` / `glm-5.2-highspeed` / `glm-5.3` / `glm-5.3-flash` / `glm-5.3-highspeed`），上下文窗口、最大输出、视觉输入、tokenizer 与价格同该 lane；`glm-5.2-highspeed[1m]` 是该 lane 的折叠别名，本 provider 无折叠表，不收录。思考档位与 coding plan 相同（多数 SKU `minimal`–`high`；`glm-5.2*` 为 `high`/`max`；`glm-5.3*` 为 `low`/`high`/`max`、默认 `max` 且不可关闭）。
* 默认无凭据：请求不携带有效密钥；若本机代理设置了 `auth.proxyApiKey`，用环境变量 `ZCODE_API_KEY`（或 `ZCODE_PROXY_API_KEY`）或 `models.yml` 的 `providers.zcode-api.apiKey` 提供；代理自身的上游登录状态不受影响。无凭据时直通不发送 `Authorization`、不注入 `X-Api-Key` 的行为由上游无凭据 Anthropic 端点机制（上游 PR #13043）提供，非 fork 补丁；`model.headers` 中显式给出的 `Authorization` 仍然生效。
* 兼容规则提供 tool_result id 镜像与思考模式适配；认证面无 login 流程，不出现在 `/login`。
* `models.yml` 中 `providers.zcode-api` 的 provider 级 `baseUrl` / `headers` / `compat` 不生效（运行时合成行绕过用户覆盖）；仅 `apiKey` 与环境变量 `ZCODE_API_BASE_URL` 参与配置。命中这些不生效字段或 `models:` 定义时，启动会输出一条保留提示（不阻断启动）。

### 公司内网模型（仅 `--offline`）

* `company` lane 只在 `--offline` 进程中存在：普通启动不注册该 provider，没有 company 模型、向量回退或启动警告；显式 `--provider company` 或 `--model company/...` 直接报错提示需要 `--offline`。`models.yml` 中名为 `company` 的 provider 段整段忽略（该 id 为 fork 保留），命中时启动会输出保留提示（不阻断启动）。以下条目均限于 `--offline` 进程。
* `omp models --offline` 与 `omp bench <selector…> --offline` 采用与进程级 `--offline` 同一套 company 语义：先翻转 lane 再构建 registry，因此 `omp models` 列出公司聊天模型、`omp bench` 能解析并压测 `company/<模型>` 选择器（两者同样隐藏 zcode-api，见「ZCode 本地代理」）；刷新与 selector-miss 的发现回退都用 cache-only 策略、不发公网请求；公司配置缺失或无效时把公司 provider 的错误原因写到 stderr，不静默。未传 `--offline` 时两者都不注册公司 provider。其余需要解析模型的子命令（`omp dry-balance`、`omp render`、`omp read`、`omp usage` 等）尚未提供该开关：改动这些命令时 MUST 按同一语义补齐，不得让其继续静默走 zcode/公网路径。
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

* 房间身份（roomId、房间密钥、write token）持久化在 config root 的 `collab/identity.json`（POSIX 下 `0600`，已有文件同样收紧权限；文件含 write token，Windows 依赖 config root 的 ACL，与 guest replica 同）。同一进程内每个房间复用同一身份：`/new`、`/resume`、`/fork`、`/collab stop` 后重开、以及 omp 重启后，`/collab` 打印的同一条链接始终可用；房间仍按会话轮换（`generation` 递增、guest 重连），不引入常驻进程。文件损坏或缺失时自动重建；临时不可读（如被杀软/备份占用）时只降级为进程内新身份、绝不覆盖文件。本地身份租约原子创建并支持过期恢复；第二个 omp 进程托管同一身份时由本地租约或 relay 拒绝，不能并发占用。`collab.autoStart=view` 仅限制 registry 新发出的链接，已有持久控制 token 不因此撤销。
* `/collab`、`/collab view` 执行后自动把对应的浏览器深链接写入系统剪贴板，并在提示块末尾说明；终端链接与二维码行为不变。
* host 在 guest 加入时（快照分片之后）下发本会话的命令清单：内置命令、`/skill:<name>`、扩展命令、自定义/MCP 命令与文件命令，与主机自身补全列表一致；清单每次 join 下发一次，运行中的技能/插件变化需重新 join 才可见。
* fork 的网页端（含上述补全与目录选择）随 fork 文档站一起发布到 GitHub Pages：`https://jchanghong023.github.io/oh-my-pi/collab/`，`collab.webUrl` 默认指向它，`/collab` 的链接因此形如 `https://jchanghong023.github.io/oh-my-pi/collab/#<relay-link>`，外部浏览器（含跨网络设备）可直接使用；中继托管的 `my.omp.sh` 是上游构建，永远不会带 fork 功能。把 `collab.webUrl` 置空则回到上游行为（按 `collab.relayUrl` 推导，即 `my.omp.sh`）；本地开发该客户端时用 `collab.webUrl=http://localhost:3000`（`packages/collab-web` 的 `bun run dev`）。
* 网页端 composer 支持 `/` 补全（`Tab` 补全、`↑`/`↓` 选择、`Esc` 关闭、鼠标点选），可执行的命令范围与清单一致：内置命令、技能、扩展/自定义/文件命令，以及 `!`/`!!`（主机 shell）与 `$`/`$$`（主机 python）；会话轮换类命令（`/new`、`/resume`、`/fork`、`/exit` 等）同样开放。未知斜杠命令、内置命令参数错误和命令目录加载失败明确回错，不当作 prompt 交给模型；繁忙时文件/自定义 prompt 使用 steer，所有异步命令提交前再次核对房间、会话与写权限。持有可写链接者因此可在主机上执行任意 shell/python 与任意会话操作，绕过 agent 策略与审批；终端 join 同样警告这个权限边界，view-only 链接仍被拒绝。
* 命令输出（如 `/move <path>` 的 `Moved to <path>.`）与扩展命令失败以 host notice 下发浏览器；`/move`、`/wt` 复用主机 TUI/BTW/cwd 切换链路。`/clear` 仍走真实 TUI 原位上下文清理及转录/滚屏重置，保留会话 id、标题、cwd 与文件，不能变成 `/new`；所有 `/logout` 形式（含 provider 参数）保留主机 provider/account 覆盖层。网页命令传入 detached draft，不占用主机正在编辑的草稿。共用运行时的选择与确认直接绑定主机 hook UI，带参数 `/skills` 的交互不继承无界面/no-op 回调。无参数 `/model`、`/switch` 在主机打开选择器；`/effort` 仅在模型支持 reasoning 时打开思考选择器，否则明确提示没有可调思考档位。
* `/move`、`/add-dir` 的路径候选由 host 的文件系统搜索提供（同一 TUI 覆盖层数据源），仅限活跃可写链接且不在 ask 交互期间；支持带空格的目录。候选只做大小写不敏感的子串匹配与目录列举，不执行、不落盘。
* 网页端收到 `bye`（会话轮换、`/collab stop`、重启）不再结束页面：保留链接进入自动重连（指数退避），同一 roomId 的新房间建立后自动加入；清除旧菜单、UI、目录与 transcript 请求，旧连接上的待发送命令丢弃而不重放。`/collab stop` 后页面持续显示重连中，直到再次 `/collab`。
* `COLLAB_PROTO` 保持 `3`：新增帧为加性扩展，旧客户端忽略未知帧；网页端对旧 host 的目录请求 10 秒超时后按无候选处理。

### Windows 行为修复

* 内建工具（`rg`、`grep` 等）的 stdout 与 stderr 指向普通文件时按块缓冲写出，与 Unix 行为对齐：`rg 模式 > out.txt` 的输出在工具退出前对并发目录遍历不可见，避免遍历器匹配到自己正在增长的输出、把少量命中放大成 GB 级结果；`>f 2>&1` 时 stderr 与 stdout 一致，不再按行即时落盘。判断在 SIGPIPE 保护包装流之前完成（包装后无法再区分文件与管道），也不改变管道/终端下的行缓冲。上游基线不包含该修复（Windows 分支的 `is_regular_file` 仍按变体匹配，看不到 SIGPIPE 包装后的文件），fork 在 `pi-builtins` 的 host 上维护快照判断与 Windows 句柄设备类型探测。
* 临时目录删除在 Windows 上对瞬时占用进行有界重试，必要时强制 GC 释放 Bun 的已关闭 SQLite 句柄；所有者仍须显式 close 自己的数据库、存储与进程，永久删除失败必须可见，不能吞掉清理错误或用全局 registry 强关其他实例。

### 上游缺陷散点修复

以下改动是随日常开发沉淀的上游缺陷修复与仓库开发环境配置，不属于个人功能或默认值，但相对上游基线仍有效、对使用者有影响，在此统一记录。每次上游同步后核对：上游已包含等价修复（进入基线）时删除对应条目——保留条目只会制造假差异（同「预采纳的上游 PR」的核对方式）。

* `packages/ai/src/providers/cursor.ts`：流式 `web-fetch` 块补配对 toolResult，重建 transcript 时不被整体剥离。
* `packages/coding-agent/src/commit/changelog/index.ts`：changelog 追加段与下一 `## ` 头之间补空行，修复每次更新吞一行空行。
* `packages/coding-agent/src/ida/worker.py`：`pthread_sigmask` 仅 POSIX，Windows 分支跳过。
* `packages/coding-agent/src/lsp/clients/biome-client.ts`：Windows 上 abort 与 stdout 管道读取 race，脚本包装的孙子进程不再持有管道造成永久等待。
* `packages/coding-agent/src/markit/converters/xlsx.ts`：xlsx→markdown 单元格转义换行、`\`、`|`，防破坏表格结构。
* `packages/coding-agent/src/mcp/oauth-discovery.ts`：发现递归深度上限（深度 ≥3 不再递归）；RFC 合法发现至多一跳，更深即是环或错配，不得无限递归。
* `packages/coding-agent/src/session/session-paths.ts`：temp 根嵌套在 home 内（Windows `%TEMP%`）且 cwd 两者皆属时，除既有 `shadowedHomeDirName` 外同时前移 home 范围的旧 hashed 命名目录（`shadowedHomeHashedDirName`），旧会话目录不因命名切换而失联。
* `packages/coding-agent/src/skillshare/pack.ts`：Windows 打包时 `scripts/` 下带 shebang 的文件强制 `executable`，POSIX 安装后可直接执行。
* `packages/coding-agent/src/web/scrapers/github.ts`：issue 作者/评论者 `user:null`（已注销账号）回退显示 `ghost`。
* `packages/coding-agent/src/cli/git-tui/state.ts`：SVG 探测正则的 `\s` 转义修复。
* `packages/omptype/src/typebox.ts`：指数形式数值（如 `1e21`）超出 DSL 边界可表达范围时回退运行时 narrow，并补齐 JSON Schema minimum/maximum 输出。
* `packages/utils/src/ar/open.ts`：归档解压 symlink 在 Windows EPERM 时降级为 junction 或文件复制。
* `crates/pi-builtins/src/cksum.rs`：行解析中 `(` 位于行首时的 `par_idx` 越界守卫。
* `crates/pi-builtins/src/tail.rs`：文件大小恰为块大小整数倍时末块大小为 0 的修复。
* `crates/pi-natives/src/desktop/linux/wayland/capture.rs`：PipeWire 流进入 error 态时触发 `state_changed`，error 流不再使捕获主循环永久阻塞。
* `.zcodeignore`：ZCode 客户端忽略清单（上半部从 `.gitignore` 同步，下半部为 ZCode 默认排除规则）；不改变 omp 行为，属开发环境配置。

### 默认设置

保持以下 fork 默认值：

* `recap.enabled=false`
* `statusLine.compactThinkingLevel=false`
* `composer.shape=pi`
* `theme.dark=dark-terminal`（浅色主题仍为上游默认 `light`）
* `display.showTurnTime=true`
* `task.maxConcurrency=20`
* `mnemopi.embeddingVariant=multilingual`
* `stt.language=zh-CN`（本地 Whisper 与云端转录的区域标签均归一化为基语言，如 `zh-CN`→`zh`；默认 tier parakeet/sherpa 不使用语言参数）
* `collab.webUrl=https://jchanghong023.github.io/oh-my-pi/collab/`（fork 网页端，随文档站发布；置空回退上游按 relay 推导的行为）
* 文件日志默认关闭；临时开启方式见“安装与运行”。

### 快捷键与状态栏

* `Shift+Tab`：计划模式。
* `Ctrl+T`：临时模型。
* `Alt+P`：thinking blocks 显示/隐藏。
* `Shift+F1`：循环切换 thinking level。
* 状态栏默认显示 active time，并支持窄终端自动换行；`composer.shape=band` 除外——其状态行位于编辑器顶带，装不下的段按上游行为省略，不生成换行行。
* `composer.shape=pi` 时状态栏独立位于输入框下方。
* `@` 文件补全的「立即过滤已有候选、不等待后台目录搜索」与「候选清空时弹窗不吞键」行为均已由上游等价满足（上游 PR #13046 合并后归一）；fork 无独立实现补丁，仅保留一个慢搜索过滤的回归测试钉。
* 设置向导的主题选项「Match terminal」保留已配置的深色主题，只把浅色主题映射为 `light`；选择该项不会把现有深色主题覆盖为 `titanium`。

### 安装与运行

* `omp --log-file` 仅为本次启动启用现有轮转文件日志，写入当前 profile 的默认日志目录；例如 `omp --profile work --log-file`。不启用控制台日志、不写持久配置；未传参数时默认不写文件，也不覆盖已有显式日志配置。
* 默认启动、`omp launch`、`omp acp`、`omp join`、`omp setup` 这些经过会话启动路径的进程，若未设置 `PI_WALK_WORKERS` 且本机逻辑核数 > 8，会在进程内把文件遍历线程数设为 `min(核数/2, 16)`（32 逻辑核 → 16）；逻辑核数 ≤ 8 时保留 native 默认值 4。只改当前进程环境，不写配置文件，用户显式设置的值（含 `0`）永远优先；其他子命令（`omp grep`、`omp models` 等）不受影响。
* `--offline` 进程中若未设置 `FS_SCAN_CACHE_TTL_MS`，进程内设为 `30000` 毫秒；该变量只影响 `@` 文件补全的目录重扫间隔，非 offline 进程完全不变，用户显式设置的值（含 `0`）优先。
* `omp --offline` 以无公网模式启动本次进程：临时把 `web_search.enabled`、`browser.enabled`、`fetch.enabled` 关为 `false`，所有 `company` 聊天模型的 `contextWindow` 设为 `200000`（不改 `maxTokens`）。这些覆盖不写配置文件，退出即消失，普通启动保持原值。Python Eval 沿用原有解释器配置与自动发现机制。系统提示词仍追加“当前处于 offline 模式，环境无公网。不要尝试访问公网；使用本地资源和公司内部服务。”。公司内部模型 API、bash/eval、本地文件、LSP、本地 Git、Computer Use 等能力仍可用。
* `--offline` 且 company provider 可用时，仅为未配置的 model role 补充当前进程默认值：`default`、`task`、`vision`、`advisor` → `company/Qwen3.6-27B-public`；`smol`、`tiny`、`commit` → `company/Qwen3.6-35B-A3B`；`plan`、`slow` → `company/GLM-5.2-public`。已有角色配置和显式 CLI 模型参数仍优先，不写配置文件，不限制 `/model`、`Ctrl+T` 或角色切换，也不锁定 company。普通启动不受影响。
* `--offline` 当前进程将 `startup.setupWizard` 覆盖为 `false`，不自动弹出或导入首次启动的全屏配置向导；显式启用的启动动画按需独立加载，手动设置入口保持原有行为。
* `--offline` 启动不检查 OMP 新版本、不自动检查或更新插件市场、不读取或展示启动更新日志，也不自动触发在线模型发现——含交互界面就绪后的后台发现，以及会话恢复、默认角色解析、prewalk 目标解析和 `enabledModels`/`--models` scope 预解析里的 discovery fallback（这些自动路径只用本地缓存，缓存缺失时按既有链路降级，不发任何请求）。同进程 task 子代理的新建与恢复也继承该限制。已安装插件、内置和缓存模型照常加载；显式 `--model` 解析、手动模型刷新、更新命令及 `/changelog` 保持原有行为。上述覆盖只在当前进程生效，不写配置文件，非 offline 启动不受影响。

以下是现有个人分发能力，不代表对外发布目标；上游同步不触发构建或发布。

* 个人 Release 版本使用 `+fork.N`，仅从本仓库 `main` 通过手动 CI 生成；手动运行默认只验证并构建可下载的二进制 artifact（`publish_release=false`），明确启用发布后才创建 Release，非 `main` 分支不能发布。`bun run slowtest` 的 CI 阶段固定以 `publish_release=true` 触发，等价于明确启用发布——流水线全绿即产出该 Release。`N` 取 `.github/workflows/ci.yml` 工作流的 `run_number`，GitHub 按工作流文件路径维护计数，重命名或删除重建该文件会让 `N` 从 1 重新开始（与历史 tag 撞号、旧安装收不到后续更新），NEVER 这样做。
* 二进制必须携带 fork 版本、构建时间和更新仓库信息。
* 本地构建脚本 `packages/coding-agent/scripts/build-binary.ts` 同样注入本 fork 更新仓库：本地构建产物的 `omp update` 指向本 fork Release，不会回退官方渠道（版本号不注入，`--version` 无 `+fork.N` 后缀属预期）。
* `omp update` 先比较正常 SemVer，再比较同基线的 fork build counter；本地构建未带 `+fork.N` 时按 counter 0 比较，因此可取得同基线的新 fork Release，而不把更高上游基线降级。支持 `%2B` 编码的 `+` 版本 URL；GitHub 元数据和资产统一优先环境令牌，再尝试本机 `gh auth token`，无凭据才匿名请求。
* `omp update` 下载二进制时，在交互终端显示下载百分比、速度与预计剩余时间；非 TTY 输出（如 CI、管道）不显示动态进度。若 `PATH` 中的 `omp` 与更新目标解析为不同文件，更新前警告并提示更新后运行 `omp --version` 核对实际生效的版本；指向同一文件的符号链接不视为冲突。
* `update.channel=canary` 在 fork 二进制上不可用：启动版本检查会提示该配置并指向 `omp update --stable`；其余更新检查失败仍静默。
* `-fork.N` 时代（fork build ≤ 35，2026-08-26 及更早）的旧安装内嵌只认 `vX.Y.Z-fork.N` 的校验，会拒绝此后所有 `+fork.N` Release（报 `Invalid fork release tag`）且无法自愈，只能用安装器重装后再交给 `omp update`。
* 发布链路不发布核心或平台 npm 包，也不发布 Homebrew tap；Release notes 由 GitHub 自动生成。发布物为 Linux x64/arm64（各含 glibc 与 musl）和 Windows x64 二进制、`omp-browser-relay-extension.zip`、`LICENSE`、`THIRD-PARTY-NOTICES.txt`、`SHA256SUMS.txt`；不构建 macOS 或 Windows arm64 二进制。
* 安装器只安装 fork Release 的预编译二进制：Linux x64/arm64、Windows x64；`install.sh` 在 macOS 上于联网前明确拒绝安装。安装目标已是所选 Release 版本时提示已安装并跳过下载，同时仍检查 PATH 配置。
* 两个平台的安装器都下载到安装目录中的唯一临时文件，先确认可启动且 `omp --version` 与所选 Release 完全一致，再替换现有安装；验证失败保留旧安装并清理临时文件。可执行目标是目录时联网前拒绝，不移动目录内容；已经是所选版本时跳过下载但仍提示 PATH。Windows 优先 `curl.exe`，失败或不可用时回退兼容 PowerShell 5.1 的 `Invoke-WebRequest -UseBasicParsing`，只维护 PATH，不写废弃的 settings.json 或擅自改用户 shell/config.yml。
* 安装器替换目标二进制时不中断运行中的 omp：Linux 用同目录原子 `mv`；Windows 先把旧 `omp.exe` 重命名到唯一的 `.omp.old.*` 再换入（换入失败自动回滚），仅当重命名失败（如杀软锁定）才回退为按安装路径精确匹配强杀，`.omp.old.*` 残留由下次安装尽力清扫。强杀回退中若换入再次失败、或换入失败后回滚也失败，保留已下载的 `.omp.tmp.*` 文件作为安装目录内可恢复的二进制（重跑安装器即可恢复）。

* 模型启用范围先应用 `enabledModels` 正向选择（`[]` 不限制），再应用 `disabledModels` 负向排除（默认 `[]` 不排除，`["*"]` 全排除）；两者复用模型选择及路径作用域规则，排除优先且不被显式 pin、已保存选择、role、cycle 或 `/team` 绕过。具体模型开关以 `provider/id` 排除表达，禁用最后一个或全部模型仍可持久化，不能把空正向名单误解为“全部禁用”。

### 文档站

* 仓库根 `README.md` 是上游 README 的**中文版**，正文跟随上游更新；Install / 下载段与「提示词控制」中 fork 新增的 `fullsend` 条目为有意保留的 fork 内容（下载段不采用上游的 npm / Homebrew / Nix / mise / `omp.sh` 写法），其余正文与上游一致。上游英文快照保存在 `docs-zh-CN/README.upstream.md`，仅作同步对照稿源，已从文档站排除。
* `README.md` 与维护规则、同步 Skill 和整个需求目录一样在同步时保护：上游 README 有变化时先更新快照，再把变化段落重译进中文正文；上游未变则不动。
* 只保留 VitePress 文档站及 GitHub Pages 部署能力；不维护英文站点，不为上游英文 `docs` 提供构建或 `/en/` 子路径合并。
* 不维护翻译：上游 `docs` 的翻译文件已全部删除，后续同步不带入、不恢复；`docs-zh-CN` 仅收录 fork 自有内容——站点首页 `index.md`、命令与快捷键教程 `command-shortcut-tutorial.md`、`config.yml` 全量设置参考 `settings-reference.md`、调研资料 `research.md`（知识索引与企业代码检索）、工具文档 `tools.md`（代理/进程协调、repo、wiki），以及 `requirements/` 中的需求文档。首页与侧栏只能指向保留页面或明确的外部原文，不能保留已删除翻译路由。
* 原翻译页承载的 fork 专有内容已并入保留文档：fullsend 关键词条目在根 `README.md`「提示词控制」，`magicKeywords.fullsend` 设置行与 `/fullsend` 等四条关键词斜杠命令说明在 `settings-reference.md` 的 `magicKeywords` 条目。
* 站点构建把 `../packages`、`../crates`、`../docs` 前缀的仓库相对链接改写为本 fork GitHub 绝对链接，避免 Pages 上的死链。

## Fork 验证体系

三级命令为 fork 专属验证入口，名称与职责全新设计；旧入口 `jch-localci`、`jch-dev-ui-test` 废弃，能力并入新体系：

* `bun run fastcheck`：静态检查 = TS 三件套（check:tools 的 lint/格式 + 每个声明 check:types 的 workspace 包）+ Rust 静态检查（cargo check），只查不测、不打包发布；cargo check 仍可生成并复用编译元数据与缓存。整体设 60 秒墙钟硬超时，覆盖 Rust/Windows 工具链探测和各检查：超时杀掉运行中的子进程，停止排队工作，输出 TIMEOUT 与已耗时间并判失败。首个检查失败也停止启动后续包，已运行包完成后汇总；损坏的 workspace manifest 明确报错，不静默省略。冷缓存超时属预期失败，无时限完整静态验证由 fulltest 以 FASTCHECK_BUDGET_MS=0 复用同一静态门承担。脚本自身测试在 test:scripts 与 CI workspace 作业中引用；普通 TypeScript 修改后的授权规则见 AGENTS.md。
* `bun run fulltest`（仅限用户明确要求）：fastcheck 全部静态检查（以无预算模式复用同一静态门，冷缓存不因 60 秒预算在第一阶段中止）+ 当前操作系统的 fork 绿色测试集合 + 构建当前宿主平台 native addon。TS 阶段运行 fork 维护的白名单测试组（清单在 `scripts/fulltest.ts`：core 各包关键组、coding-agent 关键组与 fork 功能测试），结果非黑即白，不设失败豁免或失败基线；上游全量 TS 分片不在本地跑（大量用例假设 POSIX 文件系统/权限语义，Windows 上不可运行），由 slowtest 触发的 Linux CI 流水线全量覆盖。Rust（先以 `cargo test --no-run` 编译、再以 `cargo nextest` 运行；Windows 自动把 VS Build Tools 的 CMake/Ninja 注入 PATH，`.cargo/config.toml` 固定 Ninja 生成器）、脚本测试、UI 冒烟（原 `jch-dev-ui-test` 并入：PTY 启动 `bun run dev` TUI，断言全屏渲染/交互/Ctrl+D 退出，仅使用本地构建的 native addon；基础用例启动参数固定 `--offline --profile localci-ui`，不触发向导与外网请求；`/team` 用例使用 `--profile localci-ui-team --model zcode-api/glm-5.2`（不带 `--offline`），经环境变量把 zcode-api 基地址指向本地 stub server，仅 localhost 通信、不访问外网；`--debug` 可转储 TUI 原始输出）。每个测试执行阶段（TS 白名单、Rust 测试运行、脚本测试、UI 冒烟）设硬超时（默认 3 分钟；TS 白名单阶段放宽为 5 分钟——该阶段以 2 路有界池并行，分组内测试大量派生 bash/git/ConPTY/CLI 子进程，满并发会击穿用例默认 5 秒预算，半宽并行的代价是更长的阶段墙钟时间），编译时间不计入，超时即杀掉子进程、停止尚未启动的后续测试组，并判 fulltest 失败。Python 组件（`sdk/python/omp-rpc`、`python/robomp`，后者有 fork 的最小 GitHub 错误传播修复；上游 v18.6.0 已把 `python/omp-rpc` 迁至 `sdk/python/omp-rpc` 并改用 wire schema 生成类型）不在本地验证范围，`bun run test:py` 入口保留供手动使用。只运行当前操作系统对应的测试，不维护 WSL2/双平台测试运行能力。端到端冒烟与安装器 E2E 不在本地跑，由 slowtest 的流水线覆盖。
* `bun run slowtest`（仅限用户明确要求）：fulltest 全部内容 + `wsl/ubuntu-24.04` 阶段 + 把干净的本地 main push 到远端，手动 workflow_dispatch 固定 publish_release=true，持续监控这次 CI 到结束（全绿才创建 fork Release/tag）。每次触发带唯一 slowtest_run_id，按对应 displayTitle、HEAD SHA 和触发时间定位，不把同提交的其他 push/手动运行冒充本次结果；逐阶段及总耗时均输出。WSL 阶段仅 Windows 运行，按仓库分支实际 upstream（或唯一远端）先推送 EXPECTED_SHA 并用 ls-remote 确认可取，再在 Ubuntu-24.04 root 的 /root 按 remote 身份定位或 clone 仓库；脏树、领先/分叉、非 Linux bun/git 路径均失败，不清理、不强推、不 reset，只创建分支或快进到 EXPECTED_SHA。先 bun install --frozen-lockfile，再 bun run fulltest，安装也计入两小时预算；超时仅清理继承本次 OMP_WSL_STAGE_ID 的 Linux 进程与所属 Windows 进程树，不按进程名全局 pkill。阶段失败不继续主 push 或触发 CI；用于 WSL 获取提交的前置推送可能已经发生，不自动回滚远端。

同步时需维护的活跃适配与测试契约如下；这是当前约束，不是失败基线或本次验证通过记录。上游包含等价实现后移除重复适配，不用 blanket skip 隐藏跨平台缺陷：

* **进程与资源所有权**：MCP stdio pidfile 只接受活进程 pid；通用状态、资源、工具归属、初始恢复和 print-ready 用例不得整类跳过 Windows。测试所有者关闭自己的 AgentStorage、AuthStorage、SQLite 与子进程，再做有界瞬时占用重试；禁止以全局 registry 关闭其他用例的资源。取消/超时须终止所属进程树、排空输出并保留原取消原因。
* **会话目录与文件系统安全**：所有平台先分类 temp，再分类 home；temp 命名、历史 hashed-home 迁移和 home 内嵌 TMPDIR 都有跨平台断言。artifact merge 与 speculative retarget 的 Windows 目录链接使用 junction，不能因普通文件符号链接的权限限制而跳过目录逃逸防护。路径 fixture 使用真实临时目录和规范化完整路径，不假定 `/workspace`、`/tmp/work`、`/sessions` 在 Windows 与 POSIX 同义。
* **档案与原始路径**：TAR 目录别名、ASAR 链式链接及 Windows EPERM 回退仍须真实提取、检查归属与结果，不能把整个档案分支跳过；POSIX 非 UTF-8 argv 由 `CommandArg::OsString` 保留字节，字符串接口的内建命令无法处理时转同名外部程序，找不到则明确失败。
* **真实平台差异**：保留仅适用于 POSIX 的 uid/umask/chmod/信号与文件符号链接用例门控；Windows `timeout` 的信号映射不冒充 kill(2)。oauth_callback 在无头/SSH/WSL 无 GUI 环境遇到 Unsupported 时可按该前置条件跳过，不免除其余鉴权测试。shell snapshot 的 fn-env helper 解析真实 POSIX Bash（REAL_BASH 或 Git for Windows Bash），不存在才跳过，不拿 WSL 启动器当同一种 Bash。VFS rename-over-open/follow-symlink 等用例按真实句柄语义处理；console 诊断用实际附加/分离的子控制台，不靠虚构共享控制台前提。
* **Rust shell 与宿主**：`is_regular_file` 需导入 `pi-builtins` 测试宿主。jobspec 强杀用例维持 600 秒内部预算与 Bazel long 级别，两个管道进程按 ready 文件依次自停；SIGCHLD 丢弃竞态采用上游的订阅后 stop 预检和管道范围轮询，不恢复旧 fork 周期轮询。Windows 悬挂 UTF-8 EOF 用例显式选择 UTF-8 构造器；pipeline timeout 输出用 READY 握手后再取消；snapcompact 断言遵守 64px 最小画布高度。
* **Git 与输出形态**：测试隔离 GIT_CONFIG_GLOBAL/GIT_CONFIG_SYSTEM、固定 core.autocrlf=false；worktree 比较规范化 verbatim 前缀、平台分隔符及 Windows 大小写，metadata list 期望使用注册形态路径。root 下权限拒绝用例用真实可预测的文件系统错误而非 chmod 000。find/fd/rg 输出断言区分平台路径分隔符，不把 stdout 身份缺失的重定向行为当作同一种 Unix 实现。
* **配置与启动 fixture**：profile-cli 隔离 USERPROFILE；bash-failure-result 使用内存 Settings。cli-non-tty-launch 和“无可用模型”preset 用例显式禁用 keyless zcode-api，防止测试发出非预期真实请求；欢迎首帧 fixture 固定 band，fork 的 pi 默认值另有断言。spinner 生命周期用例中和 WSL_DISTRO_NAME/WSL_INTEROP，静态 WSL 标题另行覆盖；注册表路径按 `/` 比较。
* **RPC 与命令注册**：ACP 面板与 reserved-name 集合惰性构建，避免 builtin-registry 导入环在求值期读取未初始化注册表；allowArgs 拒绝探针使用确实不允许参数的命令。getAgentTombstonePath 从 registry/agent-tombstone.ts 导入。wire conformance 仅比较上游面：fork 命令按差集排除，ForkParamFields/ForkResultFields 只对表内命令 Omit 专有键，避免无条件泛型 Omit<T, never> 破坏必需键推断；fork ready/UI/Goal 字段按明确字段裁剪。不能把 fork-only 面偷偷写入上游生成 schema，字段进入上游后缩小豁免表。
* **协作与发布**：collab session-switch 断言持久身份链接相同而 generation 轮换，剪贴板在用例内隔离。update-cli 的文件 symlink alias 用例只在支持该权限的平台运行；安装器另以实际可执行 fixture 覆盖精确版本、目录拒绝、运行中映像与 Windows 回滚。musl-release 的工具链用例门控 Linux，并按真实 omp/version 格式探测。
* **静态与看门狗**：fastcheck 的 TS 相位必须与上游 check:ts 同构（check:tools + 每个声明 check:types 的 workspace 包），4 路池只改变调度、不缩小范围；manifest 读取失败、首失败及预算超时不能静默省略后续工作后宣称通过。ci-test-ts watchdog fixture 给进程启动预留 3 秒，停滞仍由实际看门狗终止。fork 本地 Rust 白名单不含 pi-builtins，全量 Linux 覆盖归 slowtest CI；不保留未经本次运行证实的失败数量。
