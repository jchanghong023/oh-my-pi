# Fork 与上游差异

本仓库仅供个人使用：持续同步上游最新 `main`，保留个人功能和默认值，安装后无需额外配置即可使用，不以对外发布为目标。

本页面向本人和 AI agent，只记录**相对当前上游基线仍有效、对使用者有影响的功能差异**，不记录实现细节、修复或同步历史。开发规则见 `AGENTS.md`，同步步骤见 `.omp/skills/upstream-release-sync/SKILL.md`。

## 当前上游基线

* **分支**：`can1357/oh-my-pi@main`
* **版本**：`v18.1.18`
* **Upstream commit**：`e24466515dae616f4027170027245c6222f28ab2`
* **同步日期**：2026-09-12

## 当前功能差异

### Markdown 文档索引

* 索引管理只有两个命令：`omp docs init "<dir>" --name "<name>"` 新建（同名已存在直接报错）与 `omp docs remove <name> --force` 删除；没有 list/status/更新/重建等入口，索引也不记录状态或时间戳。删除只删数据库中的索引，不删源文件。
* 文档重新导出后，刷新方式固定为「先 remove 删除旧索引，再 init 新建」。本 fork 只维护这两个命令：新增其他索引维护入口属于超出当前契约的范围，NEVER 引入。
* 固定使用 SQLite FTS5 全文检索；在有界 BM25 候选中优先排列连续中文词组、带符号及边界的完整技术名称和当前章节标题匹配，同级继续按 BM25 排序。保留原有 AND 全词匹配作为精确档（全部词元都出现的章节优先）；不改变数据库结构；导入和查询不调用模型，不需要凭据、向量、结构化提取或 schema。
* 普通代理可用的只读 `wiki` 工具只有一个参数 `query`，用法等同搜索框：关键词或整句都可以，没有需要学习的语法（`AND`/`OR`/引号/通配都按普通字符处理）。分析在实现内完成：拉丁词与数字按整词匹配（`MBIST是什么` 这类中英粘连写法同样保留整词），汉字串去功能字后按相邻 bigram 切分，查询之间是**并集**而非过滤，命中越多排序越靠前；超过 32 个词元的长查询按等距取样保留首尾，需求句的尾部技术点不会被丢弃。排序优先级：查询原样字面量出现在标题 → 出现在正文（`std::vector` 优于散落的 `vector std`）→ 全部词元都出现 → 同级按 BM25。返回命中章节的**完整 Markdown 正文**（每节带路径、行号区间、`sectionId`），单次上限约 20000 字符；入库段落上限 18000 字符，因此任何命中都能整段返回。表头给出命中总数，页脚显示被预算截断、因过长跳过的段数与折叠的重复命中；跨文档逐字重复的段落只保留首条，其余折叠为指针行。转换器结构标签（`#### Cell` 之类，约 33 万条）不入库；标题本身即内容的需求/清单条目单独保留，以「仅有标题」形式返回。多个索引时一次查询覆盖全部索引。参数只接受 `query`；多带的无关键会被忽略，缺 `query` 时报错并指出实际收到的参数名与示例。
* 被强杀的中断导入留下的隐藏半成品索引（`list`/`remove` 都够不到）会在下一次 `init` 枚举到非空语料后回收，避免它长期占用空间。
* 数据库保存完整 Markdown 文字、原始路径和行号；导入成功后，查询不再依赖源目录。图片、附件及链接目标不随文字入库；路径和行号对应导入时的版本。
* 导入全量成功后才公开索引，失败或取消不留下可见半成品；旧版全文或结构化数据库自动迁移，保留原文章节和全文检索，移除结构化数据。
* Markdown 围栏中的标题不拆分章节，结束围栏须使用相同字符、长度不少于起始围栏且后面仅有空白；支持 ATX/Setext 标题，CRLF 原文保持原始换行；Linux 上仅大小写不同的文档保持独立，终端展示过滤控制字符。

### Command Code

* 采用上游 provider（id `commandcode`，默认模型 `claude-sonnet-4-6`、双协议发现、KDL 静态价目表与逐 id 思考等级表），fork 不再维护自己的 `command-code` provider。
* 迁移：`modelRoles` 等配置中的 `command-code/...` 需改为 `commandcode/...`；已存凭据的 provider 键同步改名，否则重新登录。
* fork 增量有两处：`providers/commandcode.kdl` 把 `deepseek/deepseek-v4.1-flash` 并入 `deepseek/deepseek-v4-flash` 一组的等级阶梯（`high` / `max`），并声明输入模态 `text` + `image` 与 `strip-image-input #false`；`src/models.json` 的同名内置行按该 KDL 重新烘焙（`reasoning`、等级、图片与相应 compat），以通过「烘焙值 = 引擎值」的 parity 门禁。等级与图片支持见下节。
* 发现结果保持中性：上游映射器不再从同名模型继承 `reasoning` 与上下文，映射代码不再有 fork 增量；KDL 的精确 `thinking-efforts` 配合 provider 级 `thinking-upgrade-neutral` 负责把中性默认升级为可推理模型。
* 价格取上游静态表：上游已收录该 id 的 `cost-patch`（`0.15` / `0.60`），fork 不再把它并入 `deepseek-v4-flash` 的价目组。
* 上游若在 KDL 中补齐该 id 的等级阶梯与模态，上述 fork 条目可整体删除。

### OpenCode Zen

* `/models` 面板仅展示内置目录明确标为免费、且当前 input/output 价格均为 0 的 `opencode-zen` 模型。
* 缺失价格或未列入内置免费目录的模型隐藏，新发现模型即使报告零价也不例外；此过滤不代表全局禁用其他模型。

### DeepSeek V4.1 Flash

* DeepSeek V4.1 Flash 使用不带 `v4` 段的 id（官方 `deepseek-flash`，Command Code 的 `deepseek/deepseek-v4.1-flash`），因此不匹配原有 `*deepseek*v4*flash*` 分类规则。这些 id 统一按同一模型处理，继承内置 `deepseek-v4-flash` 条目的能力元数据：显示名 `DeepSeek V4.1 Flash`，上下文 1M；官方 `deepseek`、`opencode-go`、`opencode-zen` 为思考等级 `low` / `high` / `max`、最大输出 384K，`commandcode` 则按该网关既有条目为 `high` / `max`、最大输出 64K。官方 `deepseek` 的裸别名自本基线起另有上游内置条目与精确兼容规则（等级阶梯、`max_tokens` + `reasoning_content` 回放契约），该 lane 的推理能力不再依赖本继承面。
* 这两条 id 在 `opencode-go` 上另带 fork 维护的内置目录行（显示名 `DeepSeek V4.1 Flash`、`low` / `high` / `max`、1M / 384K、`text` + `image`、不剥离图片）：发现完成前或缓存行被迁移丢弃时，选择器与 `modelRoles` 仍能解析到本 lane。此前这两条 id 仅存在于发现结果中，缺失时 role 会静默改绑同网关的纯文本 `deepseek-v4-flash`（表现为「V4.1 Flash 没有视觉」），`--model opencode-go/deepseek-flash:等级` 也会直接报 not found。发现成功后仍以动态行与本继承面为准。
* 官方 `deepseek` 的内置行也直接携带该能力面：显示名、图片输入与「不剥离图片」由 fork 的行提供，推理等级与 wire 契约由上游条目提供；此前只有发现行携带表面，未发现或内置行优先时界面会同时出现 `deepseek-flash` 与 `DeepSeek V4.1 Flash` 两个名称，且该 lane 无视觉、无思考等级。
* 本 lane 按同网关 Flash 档定价（`0.15` / `0.6`）：网关只对 `deepseek-v4.1-flash`、`deepseek-v4-flash` 下发价格，裸别名未定价，此前在面板里显示为 free。
* `opencode-go` 上同一 SKU 的两个 id（`deepseek-v4.1-flash` 与裸别名 `deepseek-flash`）在目录层收敛为一行：规范 id 取带版本号的 `deepseek-v4.1-flash`，名称 `DeepSeek V4.1 Flash`；裸别名仍可继续作为选择器（`modelRoles`、`--model` 无需改动），档位 `low` / `high` / `max` 与图片输入不变。
* 影响范围：官方 `deepseek` provider、`opencode-go`、`opencode-zen`、`commandcode`。不继承其他 provider 的价格与传输。
* OpenRouter 的同名 `deepseek/deepseek-v4.1-flash` 由上游内置条目与 `openrouter.kdl`（思考等级 `low` / `high` / `max`、图片输入）独立提供，不属于本继承面。
* V4.1 Flash 原生支持图片输入，而被继承的 `deepseek-v4-flash` 条目为纯文本，其 id 也不含 `vision` / `ocr` 字样、会命中 DeepSeek 类规则默认的图片剥离。因此继承面同时携带输入模态（`text` + `image`）与「不剥离图片」的覆盖；图片按原样交给网关，不做本地降级。上游 `opencode-go.kdl` 已自行声明该 provider 的模态与不剥离图片，此处继承面只补充推理能力与限额；官方 `deepseek` 与 `opencode-zen` 的这两项仍来自继承面。思考等级、限额与显示名仍与同类 DeepSeek 模型一致。
* 原因：这些网关的模型列表只返回 `id` 等有限字段，未被内置目录或分类规则覆盖的 id 会保留发现默认值 `reasoning: false`，导致没有思考等级、上下文未知。
* 继承关系同时作为缓存失效策略：修复前写入的旧缓存行会在下次启动时自动重新拉取，无需等待 TTL 或手动刷新。
* 内置目录出现这些 id 的正式条目后自动以条目为准。上游已为官方 `deepseek` 裸别名补齐等级阶梯与 wire 契约，本继承面在该 lane 只剩显示名与图片模态；`opencode-go`、`opencode-zen`、`commandcode` 仍整体由本继承面提供，这些 provider 在 KDL 中补齐等级阶梯与模态后，本 fork 的对应改动即可整体移除。
* `commandcode` 的 `deepseek/deepseek-v4.1-flash` 由上方「Command Code」的 KDL 条目提供等级与图片输入，价格取上游 `cost-patch`；官方 `deepseek` 的 `deepseek-flash` 自本基线起由上游条目提供推理等级与 wire 契约，本继承面在该处只补显示名与图片输入。
* 分类侧另有一处 fork 改动：`taxonomy/deepseek.kdl` 用 `*deepseek-flash*` glob 把不带 `v4` 段的裸 id 归入 Flash 家族，避免落到通用档位；官方 `deepseek` 已由上游精确规则覆盖，该 glob 主要服务 `opencode-go`、`opencode-zen`、`commandcode` 的裸 id，档位生效仍以对应能力面开启推理为前提。

### 代理行为与 Discuss

* Todo 提示词默认以至少 3 个独立用户可见结果作为创建条件，常规检查 → 执行 → 验证算一个结果；仍保留用户明确要求、提供任务集合或中途追加指令等创建/更新条件。
* `Shift+F2` 固定在 Main ↔ Discuss 之间切换，不支持配置顺序；运行中或有排队消息时不能切换。
* 会话/分支切换后恢复对应代理状态。
* Discuss 只能使用允许的**内置工具实例**，不能被同名扩展替代；可用只读工具含 `wiki`，因此 `/jchdftexplain` 等只读命令在 Discuss 下同样可用。
* Discuss 可在聊天内给出实施方案和步骤，但不写计划文件、不执行命令、修改文件或外部状态、创建 Todo 或委派工作；需要实施时提示用 `Shift+F2` 切回 Main，不自动重放或实施请求。
* Discuss 与 Plan/Goal/Vibe/Loop 互斥，相关模式启用或暂停时都不能切入 Discuss；循环模式也不能在 Discuss 下启动。

### 魔法关键词的内置命令与 fullsend

* 上游已有 `ultrathink`、`orchestrate`、`workflowz` 魔法关键词，可在任务正文中以独立小写词触发，无需整条消息只有关键词；代码块、行内代码和 XML/HTML 区域不触发。fork 新增的关键词只有 `fullsend`，遵循同样的匹配规则。
* fork 为这四个关键词新增对应的内置命令 `/ultrathink`、`/orchestrate`、`/workflowz`、`/fullsend`，方便输入，并允许命令后直接携带任务文本。
* `fullsend` 注入执行策略：成本和 token 用量不作为优化约束；在同等正确性、完整性与验证标准下缩短完成时间，端到端完成任务。仅做对速度或验证质量有实际收益的调用与并行，不把额外调用或花费视为目标，不扩大任务范围或权限。
* 有 `task` 工具且委派更快时，该策略要求并行处理独立工作；有等待任务则完成一个立即补位，任务不足并发上限时全部启动，不为凑并发扩大范围。这是对模型的提示词要求，不是程序调度保证。

### JCH 命令

保留以下个人命令及其核心语义：

* `/jchfix`：定位根因并最小修复，不提交、不推送。
* `/jchdiagnose`：只读诊断根因、影响和修复边界。
* `/jchfuncreview`：独立只读功能审查，仅报告高置信问题。
* `/jchfuncreviewfix`：审查后最小修复。
* `/jchverify`：只读验证指定修改是否可交付。
* `/jchci`：只读分析当前 HEAD/PR 的 GitHub Actions。
* `/jchcifix`：修复当前有效 CI 失败，并仅提交、普通推送相关修改。
* `/jchcatchup`：查看本地状态/最近提交；`full` 时深入比较远端差异。
* `/jchgs`：`fetch --all` 后显示状态。
* `/jchgitpull`：直接按当前 upstream/pull 配置执行 `git pull`。
* `/jchgitdiscardall [--ignored=true|false]`：始终无交互确认，先执行 `git fetch --all --prune`、`git reset --hard @{upstream}`。无参数或 `--ignored=false` 时以 `git clean -df` 清理未跟踪内容，保留 ignored；`--ignored=true` 时以 `git clean -xdf` 同时清理 ignored 文件和目录。非法、重复或多余参数在任何 Git 操作前报用法错误；任一步失败即停止。重置目标是当前分支配置的跟踪分支，不是本仓库名为 `upstream` 的分支。
* `/jchdftexplain`：面向 DFT 新手解释文件、目录、代码和业务概念，命令参数为待解释对象。只读：可读取文件、搜索代码和调用 `wiki`，不修改文件、不执行待解释脚本、不启动 EDA 流程；内部术语主动用 `wiki` 核对并标注来源，代码解释按命令去重、结论先行。

### Codex 用户技能

* 默认启用 `skills.enableCodexUser`，`~/.codex/skills/*/SKILL.md` 与上游默认来源一并参与发现；来源优先级不变，同名技能仍优先取 `.agents/skills` 等上游默认开启来源中的版本。
* 仅适用于技能：`~/.codex` 下的 MCP、hooks、commands、AGENTS.md 等其它能力仍按上游规则保持 opt-in。
* 技能是否进入系统提示词列表仍由自身 `disable-model-invocation` / `hide` 决定；不可由模型调用的技能只通过 `/skill:<name>` 与 `skill://<name>` 使用。

### Claude 配置同步

* 保留 `omp sync-claude [--provider <name>]`，将 Claude Code endpoint/token 同步到当前 OMP profile。
* 可自动识别仅修改 `baseUrl`/`apiKey` 的内置 Anthropic provider。

### 公司内网模型

* 内置 `company` provider，无需登录、填写凭据或创建 `models.yml`。OMP 启动时读取一次 `~/.claude/settings.json` 的 `env.ANTHROPIC_BASE_URL` 和 `env.ANTHROPIC_AUTH_TOKEN`；成功和失败均缓存，运行期间不重读、不监听文件，同进程 Worker 继承内存快照，修改配置须重启 OMP。
* URL 和 Token 仅保存在内存，不复制到 OMP 配置；配置缺失、字段错误或 JSON 无效时 provider 不可用，启动提示不包含凭据。
* 聊天使用 Anthropic Messages 协议和 Bearer 认证，不做公司模型发现、不请求对应厂商的公网 API。内置参数固定如下（token 数）：

  | Model ID | 输入 | 上下文 | 最大输出 |
  | --- | --- | ---: | ---: |
  | `DeepSeek-V4-Flash-public` | 文本 | 1,000,000 | 81,920 |
  | `GLM-5.2-public` | 文本 | 1,000,000 | 81,920 |
  | `MiniMax-M2.7` | 文本 | 204,800 | 81,920 |
  | `Qwen3.6-27B-public` | 文本、图片 | 262,144 | 81,920 |
  | `Qwen3.6-35B-A3B` | 文本、图片 | 262,144 | 81,920 |

* Mnemopi 已启用且没有显式向量配置时，自动使用 `Qwen3-VL-Embedding-2B`，复用启动缓存中的 URL 和 Token，不改变记忆系统的启用状态。显式向量模型、地址、凭据，以及显式设置的 `mnemopi.embeddingVariant` 仍优先（只有它的 schema 默认值会让位给公司模型）；不会将公司 Token 发送给显式配置的其他地址。
* 向量采用 OpenAI 兼容 `/v1/embeddings`：去掉 Base URL 末尾斜杠，已有 `/v1` 时不重复追加，保留其他路径前缀。不探测其他路径、不回退到公网；公司网关兼容性需要内网实测。
* 检索模型目录仅包含 `Qwen3-VL-Embedding-2B` 和 `Qwen3-VL-Reranker-2B`，不包含 8B 模型，两种检索模型不作为聊天模型展示。现有记忆流程只接文本向量，默认的 `Qwen3-VL-Embedding-2B` 也只传文本，图片向量与远端 Reranker 尚未接入检索流程。

### 默认设置

保持以下 fork 默认值：

* `recap.enabled=false`
* `statusLine.compactThinkingLevel=false`
* `composer.shape=pi`
* `theme.dark=dark-terminal`（浅色主题仍为上游默认 `light`）
* `display.showTurnTime=true`
* `task.maxConcurrency=8`
* `mnemopi.embeddingVariant=multilingual`
* `stt.language=zh-CN`
* 文件日志默认关闭；临时开启方式见“安装与运行”。

### 快捷键与状态栏

* `Shift+Tab`：计划模式。
* `Ctrl+T`：临时模型。
* `Alt+P`：thinking blocks 显示/隐藏。
* `Shift+F1`：循环切换 thinking level。
* 状态栏默认显示 active time，并支持窄终端自动换行。
* 状态栏在未显示其他模式状态时显示当前主代理 Main/Discuss。
* `composer.shape=pi` 时状态栏独立位于输入框下方。
* `@` 文件补全在输入、删除字符时立即过滤已有候选，不等待后台目录搜索完成；网络文件系统上的新文件仍需等待扫描结果，后台搜索保持串行，避免堆积 I/O。

### 安装与运行

* `omp --log-file` 仅为本次启动启用现有轮转文件日志，写入当前 profile 的默认日志目录；例如 `omp --profile work --log-file`。不启用控制台日志、不写持久配置；未传参数时默认不写文件，也不覆盖已有显式日志配置。
* `omp --offline` 以无公网模式启动本次进程：临时把 `web_search.enabled`、`browser.enabled`、`fetch.enabled` 关为 `false`，所有 `company` 聊天模型的 `contextWindow` 设为 `200000`（不改 `maxTokens`）。这些覆盖不写配置文件，退出即消失，普通启动保持原值。Python Eval 沿用原有解释器配置与自动发现机制。系统提示词仍追加“当前处于 offline 模式，环境无公网。不要尝试访问公网；使用本地资源和公司内部服务。”。公司内部模型 API、bash/eval、本地文件、LSP、本地 Git、Computer Use 等能力仍可用。
* `--offline` 且 company provider 可用时，仅为未配置的 model role 补充当前进程默认值：`default`、`task`、`vision`、`advisor` → `company/Qwen3.6-27B-public`；`smol`、`tiny`、`commit` → `company/Qwen3.6-35B-A3B`；`plan`、`slow` → `company/GLM-5.2-public`。已有角色配置和显式 CLI 模型参数仍优先，不写配置文件，不限制 `/model`、`Ctrl+T` 或角色切换，也不锁定 company。普通启动不受影响。
* `--offline` 当前进程将 `startup.setupWizard` 覆盖为 `false`，不自动弹出或导入首次启动的全屏配置向导；显式启用的启动动画按需独立加载，手动设置入口保持原有行为。
* `--offline` 启动不检查 OMP 新版本、不自动检查或更新插件市场、不读取或展示启动更新日志，也不在交互界面就绪后自动触发在线模型发现。已安装插件、内置和缓存模型照常加载；显式模型解析、手动模型刷新、更新命令及 `/changelog` 保持原有行为。上述覆盖只在当前进程生效，不写配置文件，非 offline 启动不受影响。
* `PI_NATIVE_DIR` 严格限定 native addon 加载目录；指定后不回退到工作区、安装包、缓存或内嵌 addon，缺失或不兼容则加载失败。

以下是现有个人分发能力，不代表对外发布目标；上游同步不触发构建或发布。

* 个人 Release 版本使用 `+fork.N`，仅从本仓库 `main` 通过手动 CI 生成。
* 二进制必须携带 fork 版本、构建时间和更新仓库信息。
* `omp update` 按 fork build counter 判断更新，并支持 `%2B` 编码的 `+` 版本 URL。
* `-fork.N` 时代（fork build ≤ 35，2026-08-26 及更早）的旧安装内嵌只认 `vX.Y.Z-fork.N` 的校验，会拒绝此后所有 `+fork.N` Release（报 `Invalid fork release tag`），且无法通过任何后续代码改动自愈：这类机器只能用安装器重装后再交给 `omp update`。
* 安装器只安装 fork Release 的预编译二进制：Linux x64/arm64、Windows x64。

### 文档站

* 仓库根 `README.md` 是上游 README 的**中文版**，正文跟随上游更新；Install / 下载段与「提示词控制」中 fork 新增的 `fullsend` 条目为有意保留的 fork 内容（下载段不采用上游的 npm / Homebrew / Nix / mise / `omp.sh` 写法），其余正文与上游一致。上游英文快照保存在 `docs-zh-CN/README.upstream.md`，仅作同步对照稿源，已从中文文档站排除。
* `README.md` 与三份维护文档一样在同步时保护：上游 README 有变化时先更新快照，再把变化段落重译进中文正文；上游未变则不动。
* 保留供个人查阅的中英文 VitePress 文档站及 GitHub Pages 部署能力。
* 中文站以覆盖上游全部文档的完整翻译为目标，并保留使用指南和 `config.yml` 设置参考；翻译独立同步，内容可能落后于当前代码基线。

### Fork 开发工具

* 保留 `bun run fastcheck`，仅检查本地修改的 TypeScript lint/format。
* 保留 `bun scripts/jch-localci.ts [full]` 作为独立 Linux-x64 本地检查入口；默认不构建 native，`full` 才构建。
