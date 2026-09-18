# Fork 与上游差异

本仓库仅供个人使用：持续同步上游最新 `main`，保留个人功能和默认值，安装后无需额外配置即可使用，不以对外发布为目标。

本页面向本人和 AI agent，只记录**相对当前上游基线仍有效、对使用者有影响的功能差异**，不记录实现细节、修复或同步历史。开发规则见 `AGENTS.md`，同步步骤见 `.omp/skills/upstream-release-sync/SKILL.md`。

## 当前上游基线

* **分支**：`can1357/oh-my-pi@main`
* **版本**：`v18.2.4`
* **Upstream commit**：`dc04ad406e5eb4f24fadb86a479e4e781a1ea632`
* **同步日期**：2026-09-17

## 当前功能差异

### Markdown 文档索引

* 索引管理只有两个命令：`omp docs init "<dir>" --name "<name>"` 新建（同名已存在直接报错）与 `omp docs remove <name> --force` 删除；没有 list/status/更新/重建等其他命令入口（`/wiki` 面板会列出已有索引供检索，并可直接发起这两个动作），索引也不记录状态或时间戳。删除只删数据库中的索引，不删源文件。
* 文档重新导出后，刷新方式固定为「先 remove 删除旧索引，再 init 新建」。本 fork 只维护这两个命令：新增其他索引维护入口属于超出当前契约的范围，NEVER 引入。
* 固定使用 SQLite FTS5 全文检索；在有界 BM25 候选中优先排列连续中文词组、带符号及边界的完整技术名称和当前章节标题匹配，同级继续按 BM25 排序。保留原有 AND 全词匹配作为精确档（全部词元都出现的章节优先）；不改变数据库结构；导入和查询不调用模型，不需要凭据、向量、结构化提取或 schema。
* 普通代理可用的只读 `wiki` 工具只有一个参数 `query`，用法等同搜索框：关键词或整句都可以，没有需要学习的语法（`AND`/`OR`/引号/通配都按普通字符处理）。分析在实现内完成：拉丁词与数字按整词匹配（`MBIST是什么` 这类中英粘连写法同样保留整词），汉字串按书写原样做相邻 bigram 切分（功能词整词丢弃，不先删单字功能词，避免产生语料中不存在的组合），查询之间是**并集**而非过滤，命中越多排序越靠前；超过 32 个词元的长查询按等距取样保留首尾，需求句的尾部技术点不会被丢弃。排序优先级：查询原样字面量出现在标题 → 出现在正文（`std::vector` 优于散落的 `vector std`）→ 全部词元都出现 → 同级按 BM25。返回命中章节的**完整 Markdown 正文**（每节带路径、行号区间、`sectionId`），单次上限约 20000 字符；入库段落上限 18000 字符，因此任何命中都能整段返回。表头给出命中总数，页脚显示被预算截断、因过长跳过的段数与折叠的重复命中；跨文档逐字重复的段落只保留首条，其余折叠为指针行（约 200 字符以下的短重复不折叠）。转换器结构标签（`#### Cell` 之类，约 33 万条）不入库；标题本身即内容的需求/清单条目单独保留，以「仅有标题」形式返回。多个索引时一次查询覆盖全部索引。参数只接受 `query`；多带的无关键会被忽略，缺 `query` 时报错并指出实际收到的参数名与示例。
* 被强杀的中断导入留下的隐藏半成品索引（`list`/`remove` 都够不到）会在下一次 `init` 枚举到非空语料后回收，避免它长期占用空间。
* 数据库保存完整 Markdown 文字、原始路径和行号；导入成功后，查询不再依赖源目录。图片、附件及链接目标不随文字入库；路径和行号对应导入时的版本。
* 导入全量成功后才公开索引，失败或取消不留下可见半成品；旧版全文或结构化数据库自动迁移，保留原文章节和全文检索，移除结构化数据。
* Markdown 围栏中的标题不拆分章节，结束围栏须使用相同字符、长度不少于起始围栏且后面仅有空白；支持 ATX/Setext 标题，CRLF 原文保持原始换行；Linux 上仅大小写不同的文档保持独立，终端展示过滤控制字符。

### OpenCode Zen

* `/models` 面板仅展示内置目录明确标为免费、且当前 input/output 价格均为 0 的 `opencode-zen` 模型。
* 缺失价格或未列入内置免费目录的模型隐藏，新发现模型即使报告零价也不例外；此过滤不代表全局禁用其他模型。

### 代理行为与 Discuss

* Todo 提示词默认以至少 3 个独立用户可见结果作为创建条件，常规检查 → 执行 → 验证算一个结果；仍保留用户明确要求、提供任务集合或中途追加指令等创建/更新条件。
* `Shift+F2` 固定在 Main ↔ Discuss 之间切换，不支持配置顺序；运行中或有排队消息时不能切换。
* 会话/分支切换后恢复对应代理状态。
* 工具集刷新（MCP、扩展、RPC 等变化触发的基准工具集重设）不丢弃扩展挂载的 `xd://` 设备：刷新后按「基准工具集 ∪ 存活挂载」恢复，受限 profile 下也保持原有顶层 / `xd://` 划分。
* Discuss 只能使用允许的**内置工具实例**，不能被同名扩展替代；可用只读工具含 `wiki`，因此 `/jchdftexplain` 等只读命令在 Discuss 下同样可用。
* Discuss 可在聊天内给出实施方案和步骤，但不写计划文件、不执行命令、修改文件或外部状态、创建 Todo 或委派工作；需要实施时提示用 `Shift+F2` 切回 Main，不自动重放或实施请求。
* Discuss 与 Plan/Goal/Vibe/Loop 互斥，相关模式启用或暂停时都不能切入 Discuss；循环模式也不能在 Discuss 下启动。
* `/tan` 后台派发视同委派工作，Discuss 下不能执行，提示先用 `Shift+F2` 切回 Main。

### 魔法关键词的内置命令与 fullsend

* 上游已有 `ultrathink`、`orchestrate`、`workflowz` 魔法关键词，可在任务正文中以独立小写词触发，无需整条消息只有关键词；代码块、行内代码和 XML/HTML 区域不触发。fork 新增的关键词只有 `fullsend`，遵循同样的匹配规则。
* fork 为这四个关键词新增对应的内置命令 `/ultrathink`、`/orchestrate`、`/workflowz`、`/fullsend`，方便输入，并允许命令后直接携带任务文本。
* `fullsend` 注入执行策略：成本和 token 用量不作为优化约束；在同等正确性、完整性与验证标准下缩短完成时间，端到端完成任务。仅做对速度或验证质量有实际收益的调用与并行，不把额外调用或花费视为目标，不扩大任务范围或权限。
* fullsend 通知在 Discuss 主代理下同样注入（与上游其他关键词的注入形态一致，不按主代理区分）；Discuss 的只读工具门禁保证该策略不会实际实施，委派条款也因 Discuss 工具集不含 `task` 而不注入。
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
* `/jchgitdiscardall [--ignored=true|false]`：始终无交互确认，先执行 `git fetch --all --prune`、`git reset --hard @{upstream}`。无参数或 `--ignored=false` 时以 `git clean -df` 清理未跟踪内容，保留 ignored；`--ignored=true` 时以 `git clean -xdf` 同时清理 ignored 文件和目录。clean 以 `git rev-parse --show-toplevel` 解析的仓库根为工作目录，会话位于仓库子目录时同样清理整个工作树（reset 本就是全仓生效）。该命令仅在交互界面（TUI）执行；其他通道输入只返回提示、不派发给模型。非法、重复或多余参数在任何 Git 操作前报用法错误；任一步失败即停止。重置目标是当前分支配置的跟踪分支，不是本仓库名为 `upstream` 的分支。
* `/jchdftexplain`：面向 DFT 新手解释文件、目录、代码和业务概念，命令参数为待解释对象。只读：可读取文件、搜索代码和调用 `wiki`，不修改文件、不执行待解释脚本、不启动 EDA 流程；内部术语主动用 `wiki` 核对并标注来源，代码解释按命令去重、结论先行。

### Codex 用户技能

* 默认启用 `skills.enableCodexUser`，`~/.codex/skills/*/SKILL.md` 与上游默认来源一并参与发现；来源优先级不变，同名技能仍优先取 `.agents/skills` 等上游默认开启来源中的版本。
* 仅适用于技能：`~/.codex` 下的 MCP、hooks、commands、AGENTS.md 等其它能力仍按上游规则保持 opt-in。
* 技能是否进入系统提示词列表仍由自身 `disable-model-invocation` / `hide` 决定；不可由模型调用的技能只通过 `/skill:<name>` 与 `skill://<name>` 使用。

### ZCode 本地代理（zcode-api）

* 内置 provider `zcode-api`，默认指向本机 ZCode Proxy（`http://127.0.0.1:8080`；环境变量 `ZCODE_API_BASE_URL` 以完整的 `http://主机:端口` 基地址覆盖；Anthropic 传输会自行去掉末尾斜杠与多余的 `/v1`），无登录、无配置即在模型面板与 `omp models` 中可见可用；`disabledProviders` 仍可禁用。
* 固定使用代理的 Anthropic Messages 直通路由（`/v1/messages`，与 Claude Code 同路径）：工具调用、thinking、上游错误状态原样传递，不经过 OpenAI 翻译层。不做模型发现，不写入 `models.json`（上游守护测试禁止内置目录携带回环地址；模型在 `packages/coding-agent/src/config/zcode-api-models.ts` 运行时构建）。
* 模型与参数照抄国内「智谱 coding plan」lane（`zhipu-coding-plan`）：14 个 GLM（`glm-4.5` / `glm-4.5-air` / `glm-4.6` / `glm-4.6v` / `glm-4.7` / `glm-5` / `glm-5-turbo` / `glm-5v-turbo` / `glm-5.1` / `glm-5.2` / `glm-5.2-highspeed` / `glm-5.3` / `glm-5.3-flash` / `glm-5.3-highspeed`），上下文窗口、最大输出、视觉输入、tokenizer 与价格同该 lane；`glm-5.2-highspeed[1m]` 是该 lane 的折叠别名，本 provider 无折叠表，不收录。思考档位与 coding plan 相同（多数 SKU `minimal`–`high`；`glm-5.2*` 为 `high`/`max`；`glm-5.3*` 为 `low`/`high`/`max`、默认 `max` 且不可关闭）。
* 默认无凭据：请求不携带有效密钥；若本机代理设置了 `auth.proxyApiKey`，用环境变量 `ZCODE_API_KEY`（或 `ZCODE_PROXY_API_KEY`）或 `models.yml` 的 `providers.zcode-api.apiKey` 提供；代理自身的上游登录状态不受影响。无凭据时直通不发送 `Authorization`，也不注入 `X-Api-Key`；`model.headers` 中显式给出的 `Authorization` 仍然生效。
* 传输面在 `packages/catalog/src/compat/rules/providers/zcode-api.kdl`（tool_result id 镜像、思考模式），认证面在 `rules/auth/zcode-api.kdl`（无 login，不出现在 `/login`）。
* `models.yml` 中 `providers.zcode-api` 的 provider 级 `baseUrl` / `headers` / `compat` 不生效（运行时合成行绕过用户覆盖）；仅 `apiKey` 与环境变量 `ZCODE_API_BASE_URL` 参与配置。
* WSL（NAT 模式）下 `127.0.0.1` 指向 WSL 自身而非 Windows 主机：代理跑在 Windows、OMP 跑在 WSL 时，需将 `ZCODE_API_BASE_URL` 指向主机地址（如 `http://172.17.80.1:8080`，取自 `ip route show default`）或在 WSL 内运行代理。

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

### Windows 内建工具输出缓冲

* 内建工具（`rg`、`grep` 等）的 stdout 与 stderr 指向普通文件时按块缓冲写出，与 Unix 行为对齐：`rg 模式 > out.txt` 的输出在工具退出前对并发目录遍历不可见，避免遍历器匹配到自己正在增长的输出、把少量命中放大成 GB 级结果；`>f 2>&1` 时 stderr 与 stdout 一致，不再按行即时落盘。判断在 SIGPIPE 保护包装流之前完成（包装后无法再区分文件与管道），也不改变管道/终端下的行缓冲。

### Windows 编辑路径与临时清理

* hashline 标签的路径恢复在 Windows 上与非 Windows 一致：比较前对恢复路径与工作目录都清理 `\\?\` verbatim 前缀，避免 std canonicalize 产生的 verbatim 形式 cwd 使恢复被静默拒绝。
* 临时目录删除在 Windows 上先强制一次 GC 再重试（Bun 在 GC 阶段才释放 SQLite `db` / `-wal` / `-shm` 的文件与目录句柄），已关闭的数据库不会把删除阻塞数秒。

### 凭据环境变量

* 多候选环境变量的 provider，凭据来源摘要回显实际生效的变量名；解析范围与取键一致（进程 env、`cwd/.env`、`~/.env`）。

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
* 状态栏默认显示 active time，并支持窄终端自动换行；`composer.shape=band` 除外——其状态行位于编辑器顶带，装不下的段按上游行为省略，不生成换行行。
* 状态栏在未显示其他模式状态时显示当前主代理 Main/Discuss。
* `composer.shape=pi` 时状态栏独立位于输入框下方。
* `@` 文件补全在输入、删除字符时立即过滤已有候选，不等待后台目录搜索完成；网络文件系统上的新文件仍需等待扫描结果，后台搜索保持串行，避免堆积 I/O。

### 安装与运行

* `omp --log-file` 仅为本次启动启用现有轮转文件日志，写入当前 profile 的默认日志目录；例如 `omp --profile work --log-file`。不启用控制台日志、不写持久配置；未传参数时默认不写文件，也不覆盖已有显式日志配置。
* `omp --offline` 以无公网模式启动本次进程：临时把 `web_search.enabled`、`browser.enabled`、`fetch.enabled` 关为 `false`，所有 `company` 聊天模型的 `contextWindow` 设为 `200000`（不改 `maxTokens`）。这些覆盖不写配置文件，退出即消失，普通启动保持原值。Python Eval 沿用原有解释器配置与自动发现机制。系统提示词仍追加“当前处于 offline 模式，环境无公网。不要尝试访问公网；使用本地资源和公司内部服务。”。公司内部模型 API、bash/eval、本地文件、LSP、本地 Git、Computer Use 等能力仍可用。
* `--offline` 且 company provider 可用时，仅为未配置的 model role 补充当前进程默认值：`default`、`task`、`vision`、`advisor` → `company/Qwen3.6-27B-public`；`smol`、`tiny`、`commit` → `company/Qwen3.6-35B-A3B`；`plan`、`slow` → `company/GLM-5.2-public`。已有角色配置和显式 CLI 模型参数仍优先，不写配置文件，不限制 `/model`、`Ctrl+T` 或角色切换，也不锁定 company。普通启动不受影响。
* `--offline` 当前进程将 `startup.setupWizard` 覆盖为 `false`，不自动弹出或导入首次启动的全屏配置向导；显式启用的启动动画按需独立加载，手动设置入口保持原有行为。
* `--offline` 启动不检查 OMP 新版本、不自动检查或更新插件市场、不读取或展示启动更新日志，也不在交互界面就绪后自动触发在线模型发现。已安装插件、内置和缓存模型照常加载；显式模型解析、手动模型刷新、更新命令及 `/changelog` 保持原有行为。上述覆盖只在当前进程生效，不写配置文件，非 offline 启动不受影响。

以下是现有个人分发能力，不代表对外发布目标；上游同步不触发构建或发布。

* 个人 Release 版本使用 `+fork.N`，仅从本仓库 `main` 通过手动 CI 生成；`N` 取 `.github/workflows/ci.yml` 工作流的 `run_number`，GitHub 按工作流文件路径维护计数，重命名或删除重建该文件会让 `N` 从 1 重新开始（与历史 tag 撞号、旧安装收不到后续更新），NEVER 这样做。
* 二进制必须携带 fork 版本、构建时间和更新仓库信息。
* `omp update` 按 fork build counter 判断更新，并支持 `%2B` 编码的 `+` 版本 URL。
* `update.channel=canary` 在 fork 二进制上不可用：启动版本检查会提示该配置并指向 `omp update --stable`；其余更新检查失败仍静默。
* `-fork.N` 时代（fork build ≤ 35，2026-08-26 及更早）的旧安装内嵌只认 `vX.Y.Z-fork.N` 的校验，会拒绝此后所有 `+fork.N` Release（报 `Invalid fork release tag`），且无法通过任何后续代码改动自愈：这类机器只能用安装器重装后再交给 `omp update`。
* 安装器只安装 fork Release 的预编译二进制：Linux x64/arm64、Windows x64。
* 安装器替换目标二进制时不中断运行中的 omp：Linux 用同目录原子 `mv`；Windows 先把旧 `omp.exe` 重命名到唯一的 `.omp.old.*` 再换入（换入失败自动回滚），仅当重命名失败（如杀软锁定）才回退为按安装路径精确匹配强杀，`.omp.old.*` 残留由下次安装尽力清扫。强杀回退中若换入再次失败、或换入失败后回滚也失败，保留已下载的 `.omp.tmp.*` 文件作为安装目录内可恢复的二进制（重跑安装器即可恢复）。

### 文档站

* 仓库根 `README.md` 是上游 README 的**中文版**，正文跟随上游更新；Install / 下载段与「提示词控制」中 fork 新增的 `fullsend` 条目为有意保留的 fork 内容（下载段不采用上游的 npm / Homebrew / Nix / mise / `omp.sh` 写法），其余正文与上游一致。上游英文快照保存在 `docs-zh-CN/README.upstream.md`，仅作同步对照稿源，已从中文文档站排除。
* `README.md` 与三份维护文档一样在同步时保护：上游 README 有变化时先更新快照，再把变化段落重译进中文正文；上游未变则不动。
* 只保留中文 VitePress 文档站及 GitHub Pages 部署能力；不维护英文站点，不为上游英文 `docs` 提供构建或 `/en/` 子路径合并。
* 中文站不是纯翻译站点：以覆盖上游全部文档的完整翻译为目标，同时收录 fork 新增文档——命令与快捷键教程 `command-shortcut-tutorial.md`、`config.yml` 全量设置参考 `settings-reference.md`、知识索引研究 `dft-oh-my-pi-knowledge-research.md` 和 fork 契约 `fork.md`；翻译独立同步，内容可能落后于当前代码基线。

### Fork 开发工具

* 保留 `bun run fastcheck`，仅检查本地修改的 TypeScript lint/format。
* 保留 `bun scripts/jch-localci.ts [full]` 作为独立本地检查入口，在当前操作系统上运行（日常为 Windows x64），只运行当前操作系统对应的测试；默认不构建 native，`full` 才构建当前宿主平台的 native addon。Rust 核心测试统一走 `cargo nextest`，Windows 上会自动把 VS Build Tools 的 CMake/Ninja 注入 PATH（`.cargo/config.toml` 固定 Ninja 生成器）。个别 POSIX 专有断言（umask、uid、exec bit、bash symlink、依赖 `sh -c` 输出形态的 find 断言）在 Windows 上由测试内 `skipIf` / `ignore` 按平台跳过，其余测试同套运行。不维护 WSL2 与 Windows 双平台测试运行能力及相关工具链约定。
* 保留 `bun scripts/jch-dev-ui-test.ts` 作为 `bun run dev` 界面的自动化冒烟测试（`--debug` 可转储 TUI 原始输出）：通过本地构建的 pi-natives PTY（Windows ConPTY / POSIX openpty）启动 dev TUI，断言全屏界面渲染（光标控制序列 + 状态栏 Main 指示）、按键触发重绘、Ctrl+D 优雅退出（exit 0）；仅使用本地 addon，不联网。启动参数固定 `--offline --profile localci-ui`，不触发首次配置向导和网络请求。
* 同步时需重新应用的测试级适配（上游重写对应文件后会丢失，且上游 CI 覆盖不到）：`is_regular_file` 需导入 `pi-builtins` 的测试宿主模块（fork 自有代码，上游不编译该目标）；`pi-shell` 的 jobspec 强杀测试预算放宽到 600 秒、该测试目标的 bazel `timeout` 设为 `long`（CI 分片 CPU 争用；bazel 默认 300 秒上限会先于用例内预算触发）；`pi-shell` 的 `incomplete_utf8_at_eof_becomes_replacement` 在 Windows 上改用 UTF-8 回退构造器（上游 `new()` 在非 UTF-8 ACP 主机上会把 EOF 悬挂字节按设计交给 ACP 解码，DBCS 代码页产出默认字符 `?` 而非替换符，与该用例期望冲突；上游 CI 仅 Linux 测不到）；`session-code-mode` 的「保留启动工具体数组引用」用例在 fork 下跳过（`test.skip`）：应用工具一律经 Primary Agent 执行期门禁包装，Main 下捕获的句柄切到 Discuss 后必须被拒绝，上游新增的引用复用契约对包装后的实例不再适用，该跳过是本 fork 的有意偏差；mcp stdio pidfile 轮询只接受活进程 pid；`startup-composer-graph` 测试把注册表路径归一化为 `/`（Windows）；`oauth_callback` 测试在无头/SSH/WSL 会话遇到 `Unsupported` 时跳过；`pi-vcs` 的 git 测试以 `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM` 指向空设备、`pi-vcs` 与 `natives` 的 git 测试在 fixture 内固定 `core.autocrlf=false`（hermetic 化，防宿主配置破坏字节级断言）；`pi-vcs` 另有 worktree 断言剥 `\\?\` 前缀的 Windows 适配，以及 index 快照失败用目录占位替代 `chmod 000` 的 root 确定性改造（该用例仍为 unix 门控：Windows 上打开目录得到 `PermissionDenied` 而非 `IsADirectory`，不随 localci 在 Windows 运行）；`pi-shell` 的 registry 期望列表在 Windows 上不含 `errno`（`cfg!(unix)` 条件注入）、find/fd/rg 输出断言接受平台路径分隔符（`.\`、`sub\nested.txt` 形态），`pi-edit` 的两个 hashline 测试以真实临时目录 cwd 替代 POSIX 字面路径（`/workspace`、`/tmp/work` 在 Windows 无法剥离）；`pi-builtins` 的 stat `win_tests` 模块补上游缺失的 `tempdir` 助手（上游从未在 Windows 编译该 `cfg(all(test, windows))` 目标）、`timeout` 的 preserve-status 用例在 Windows 断言 128（无信号语义，交付信号号为 0 的确定性映射）、`timeout` 的信号拼写表与 `-s KILL` 单独杀停两用例门控 unix（Windows 无 kill(2) 信号表与 SIGKILL 语义）；`session-manager` 的三个 temp 会话目录用例（`-tmp` 命名与两段迁移）在 Windows 跳过（上游 home 优先分类把 %TEMP% 下的 cwd 归为 home 命名，用例隐含「tmpdir 不在 home 下」的 Linux 假设）。已知边界：`pi-builtins` 完整测试套件在 Windows 上另有约 21 个上游既有失败（信号表、POSIX 输出形态类），fork 验证范围（`jch-localci` 的 `CORE_RUST_CRATES`）本就不含该 crate，不逐项适配。
