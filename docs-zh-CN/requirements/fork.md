# Fork 与上游差异

本仓库是个人自己使用的 fork 维护仓库：持续同步上游最新 `main`，保留个人功能和默认值，不以对外发布为目标。

本页面向本人和 AI agent，维护项目定位、共同使用目标及**相对当前上游基线仍有效、对使用者有影响的功能差异**，不记录实现细节或同步历史（随日常开发沉淀、上游尚未包含的缺陷修复统一记录在「上游缺陷散点修复」一节，并在上游等价修复合入后删除对应条目）。开发规则见仓库根 `AGENTS.md`，同步步骤见 `.omp/skills/upstream-release-sync/SKILL.md`；需求域划分见[目录索引](README.md)。当前有效范围：模型选择、日志行为与验证编排跟随上游规则（fork 不维护模型硬排除、专用日志策略或手工测试白名单），`/team`、`/repo`、`/wiki`、company/zcode-api、`/jch*`、fullsend、Codex 策略与分发能力完整保留（各域验证状态见[目录索引](README.md)）。代码定位索引的独立契约见[代码定位索引](repo-index.md)。

## 项目定位与使用场景

三种主要使用场景统一使用本 fork 的 OMP 作为 Agent 核心，目标均为零配置文件、开箱即用：

| 场景 | 使用目标 | 具体契约 |
| --- | --- | --- |
| 上游默认 TUI | 直接使用 OMP 原生终端交互入口，跟进上游能力，并带有本 fork 的个人默认值 | 本文「默认设置」「快捷键与状态栏」「安装与运行」 |
| 公司无互联网环境 | 通过 `OMP_OFFLINE=1` 使用本地资源和公司内部模型服务，日常启动与核心任务不依赖公网 | 本文「公司内网模型（仅 `OMP_OFFLINE`）」「安装与运行」；[新手快速指南](../quick-start-intranet.md) |
| ZCode 界面 | 使用 ZCode 的界面框架与风格，以本 fork 的 OMP 替换其 Agent 核心，复用同一套 OMP 执行能力与状态 | [ZCode 接入](rpc-ui-protocol.md) |

- **零配置文件**：默认使用不要求用户手工创建、填写或修改 OMP 配置文件；所需默认值由内置行为、场景启动参数和已有环境信息提供。模型服务可达及必要认证仍是使用前提；公司环境复用既有 Claude Code 配置的具体约定见下文，不要求另配一份 OMP 凭据。
- 用户仍可主动调整偏好并由程序持久化，例如通过 ZCode 保存 role；可选设置不能成为默认使用的必经步骤。零配置不禁止程序保存会话、缓存或用户主动选择。
- **共同验收目标**：在未手工提供 OMP 配置文件、对应服务与认证已就绪的条件下，三种场景分别从真实入口完成消息发送、模型响应和工具执行；公司场景在无公网条件下完成。ZCode 的具体能力范围与验收按其独立契约执行，不由本节扩大。
- 高频同步与最小业务代码差异的维护原则统一见 [AGENTS.md](../../AGENTS.md)；这些目标不代表当前三种场景均已实现或验收通过，具体状态以各功能域记录为准。

## 当前上游基线

- **分支**：`can1357/oh-my-pi@main`
* **版本**：`v18.8.6`
- **Upstream commit**：`579da1d661c5cb8d43bc2ddd429ab72e67165ad8`
- **同步日期**：2026-10-09

## 当前功能差异

### Markdown 文档索引

- 索引管理只有两个命令：`omp docs init "<dir>" --name "<name>"` 新建（同名已存在直接报错）与 `omp docs remove <name> --force` 删除；没有 list/status/更新/重建等其他命令入口（`/wiki` 面板会列出已有索引供检索，并可直接发起这两个动作），索引也不记录状态或时间戳。删除只删数据库中的索引，不删源文件。
- 文档重新导出后，刷新方式固定为「先 remove 删除旧索引，再 init 新建」。本 fork 只维护这两个命令：新增其他索引维护入口属于超出当前契约的范围，NEVER 引入。
- 固定使用 SQLite FTS5 全文检索；在有界 BM25 候选中优先排列连续中文词组、带符号及边界的完整技术名称和当前章节标题匹配，同级继续按 BM25 排序。保留原有 AND 全词匹配作为精确档（全部词元都出现的章节优先）；档位判断基于章节**完整正文**（超长候选按需加载全文评分，不因性能截断而丢失词组档）；单次查询的候选、命中正文与计数来自**同一读快照**，并发 remove+init 不会拼出"旧路径行号 + 无关新正文"；不改变数据库结构；导入和查询不调用模型，不需要凭据、向量、结构化提取或 schema。
- 普通代理可用的只读 `wiki` 工具只有一个参数 `query`，用法等同搜索框：关键词或整句都可以，没有需要学习的语法（`AND`/`OR`/引号/通配都按普通字符处理）。分析在实现内完成：拉丁词与数字按整词匹配（`MBIST是什么` 这类中英粘连写法同样保留整词），汉字串按书写原样做相邻 bigram 切分（功能词整词丢弃，不先删单字功能词，避免产生语料中不存在的组合），查询之间是**并集**而非过滤，命中越多排序越靠前；超过 32 个词元的长查询按等距取样保留首尾，需求句的尾部技术点不会被丢弃。排序优先级：查询原样字面量出现在标题 → 出现在正文（`std::vector` 优于散落的 `vector std`）→ 全部词元都出现 → 同级按 BM25。返回命中章节的**完整 Markdown 正文**（每节带路径、行号区间、`sectionId`），单次上限约 20000 字符（页头行本身计入该预算；`query` 超过 500 字符会先截断——带省略号——再检索与回显，无命中错误的回显同样截断）；入库段落上限 18000 字符，因此任何命中都能整段返回；该上限调低前建的旧索引中超出页预算的段落仍会在作为首个命中时整段返回（保证内容可读），页脚会标注该超限，重建索引即可消除。表头给出命中总数，页脚显示被预算截断、因过长跳过的段数与折叠的重复命中；跨文档逐字重复的段落只保留首条，其余折叠为指针行（约 200 字符以下的短重复不折叠）。转换器结构标签（`#### Cell` 之类，约 33 万条）不入库；标题本身即内容的需求/清单条目单独保留，以「仅有标题」形式返回。多个索引时一次查询覆盖全部索引。参数只接受 `query`；多带的无关键会被忽略，缺 `query` 时报错并指出实际收到的参数名与示例。
- 非受限会话中，显式声明 `read` 的工具清单会自动附加只读 `wiki` 与 `repo`（含自定义 agent 的 `tools:` frontmatter 与 SDK/RPC 传入的清单）；受限清单（如 `/team` 子代理的工具集）不附加。
- 被强杀的中断导入留下的隐藏半成品索引（`list`/`remove` 都够不到）会在下一次 `init` 枚举到非空语料后回收，避免它长期占用空间。
- 数据库保存完整 Markdown 文字、原始路径和行号；导入成功后，查询不再依赖源目录。图片、附件及链接目标不随文字入库；路径和行号对应导入时的版本。
- 入库复用上游 Markdown 词法解析，代码围栏及行内代码中的运算符和技术名称保持原样；围栏跨段切分仍保留代码语境。超长行采用 500 字符重叠，避免最长合法查询在切分边界漏检，各段保持真实原始字节与行号范围且不超过 18000 字符。
- 只丢弃明确的转换器 `Cell` / `Row` 空标题，英文单词技术标题同样保留。候选内先将逐字重复的长段落分组，再按独立正文、仅标题内容、重复指针填页，重复资料不能挤掉候选中的独立正文；候选扩展以独立正文数量判定，仍保持有界。
- 每个命中的定位信息包含索引名、相对路径、行号、原文档 SHA-256 和 `sectionId`；索引名区分同名路径，文档指纹区分导入版本，不能把会随 remove+init 复用的 `sectionId` 当作永久引用。旧库可由存储的 Markdown 自动恢复代码字面量检索，不访问源目录、不改变表结构；旧导入已经丢弃的标题及无重叠的旧式长行切块仍须按 remove+init 重新导入以采用新入库规则。
- 自动化验证同时覆盖导入、旧库迁移、完整文字与引用来源、长行跨界、重复资料、取消和失败；`packages/coding-agent/test/wiki-cli.test.ts` 从真实 `bun run dev` CLI 导入，经实际模型工具派发读取源目录移走后的存储文字，再验证删除后的缺失索引错误。该测试模型响应由 localhost stub 提供，不代表真实模型任务质量验收。
- 上游文档树内的 `docs/tools/wiki.md` 是 fork 新增文件：上游测试 `docs-tool-coverage` 要求每个内置工具都有 `docs/tools/<name>.md`，`wiki` 是 fork 新增内置工具，同步时该文件 MUST 保留。
- 导入全量成功后才公开索引，失败或取消不留下可见半成品；旧版全文或结构化数据库自动迁移，保留原文章节和全文检索，移除结构化数据。
- Markdown 围栏中的标题不拆分章节，结束围栏须使用相同字符、长度不少于起始围栏且后面仅有空白；支持 ATX/Setext 标题，CRLF 原文保持原始换行；Linux 上仅大小写不同的文档保持独立，终端展示过滤控制字符。

### 当前仓库代码定位索引

完整行为、验收条件与验证边界统一维护在[代码定位索引需求](repo-index.md)。

### 魔法关键词的内置命令与 fullsend

- 上游已有 `ultrathink`、`orchestrate`、`workflowz`、`jevify` 魔法关键词，可在任务正文中以独立小写词触发，无需整条消息只有关键词；代码块、行内代码和 XML/HTML 区域不触发。fork 新增的关键词只有 `fullsend`，在与上游同一份关键词表（`modes/magic-keywords.ts`）中注册，匹配、注入与高亮规则一致，设置项与内置命令同样按该表生成。
- fork 为这四个关键词新增对应的内置命令 `/ultrathink`、`/orchestrate`、`/workflowz`、`/fullsend`，方便输入，并允许命令后直接携带任务文本。
- `fullsend` 注入执行策略：成本和 token 用量不作为优化约束；在同等正确性、完整性与验证标准下缩短完成时间，端到端完成任务。仅做对速度或验证质量有实际收益的调用与并行，不把额外调用或花费视为目标，不扩大任务范围或权限。
- fullsend 通知与上游其他关键词的注入形态一致；经 collab 转发的用户输入（guest 发送的提示词与关键词命令）同样注入关键词通知。
- 有 `task` 工具且委派更快时，该策略要求并行处理独立工作；有等待任务则完成一个立即补位，任务不足并发上限时全部启动，不为凑并发扩大范围。这是对模型的提示词要求，不是程序调度保证。
- 用户设置 `magicKeywords.fullsend`（默认 `true`，`/settings` 面板 → Interaction → Magic Keywords）可关闭 fullsend 关键词注入。

### `/team` 多模型方案讨论

完整行为与验收条件统一维护在[多模型方案讨论需求](team.md)，此处不重复条款。

### ZCode 接入

完整功能、权限边界与验收要求统一维护在 [ZCode 接入需求](rpc-ui-protocol.md)。

### JCH 命令

保留以下个人命令及其核心语义：

- `/jchfix`：定位根因并最小修复，不提交、不推送。
- `/jchdiagnose`：只读诊断根因、影响和修复边界。
- `/jchfuncreview`：独立只读功能审查，仅报告高置信问题。
- `/jchfuncreviewfix`：审查后最小修复。
- `/jchverify`：只读验证指定修改是否可交付。
- `/jchfuncreview`、`/jchfuncreviewfix`、`/jchverify` 的范围参数：三命令都支持 `uncommitted`（未提交改动）与 `commit <ref>`；`/jchfuncreview` 与 `/jchverify` 另支持 `path <路径>`，`/jchfuncreviewfix` 另支持 `repo`（全仓）；空参或非法 verb 在执行前报用法错误。
- `/jchci`：只读分析当前 HEAD/PR 的 GitHub Actions。
- `/jchcifix`：修复当前有效 CI 失败，并仅提交、普通推送相关修改；push 后 CI 不会自然触发新 run 时，仅对已定义 `workflow_dispatch` 的 workflow 以 `--ref` 指向已推送分支执行 `gh workflow run`。
- `/jchcatchup`：查看本地状态/最近提交；`full` 时深入比较远端差异。
- `/jchgs`：`fetch --all` 后显示状态。
- `/jchgitpull`：直接按当前 upstream/pull 配置执行 `git pull`。
- `/jchgitdiscardall [--ignored=true|false]`：始终无交互确认，先执行 `git fetch --all --prune`、`git reset --hard @{upstream}`。无参数或 `--ignored=false` 时以 `git clean -df` 清理未跟踪内容，保留 ignored；`--ignored=true` 时以 `git clean -xdf` 同时清理 ignored 文件和目录。clean 以 `git rev-parse --show-toplevel` 解析的仓库根为工作目录，会话位于仓库子目录时同样清理整个工作树（reset 本就是全仓生效）。该命令在交互界面（TUI）执行；ACP/RPC 通道返回提示、不派发；print/SDK 通道没有内置命令派发，命令文本会原样作为用户消息进入模型。非法、重复或多余参数在任何 Git 操作前报用法错误；任一步失败即停止。重置目标是当前分支配置的跟踪分支，不是本仓库名为 `upstream` 的分支。
- `/jchdftexplain`：面向 DFT 新手解释文件、目录、代码和业务概念，命令参数为待解释对象。只读：可读取文件、搜索代码和调用 `wiki`，不修改文件、不执行待解释脚本、不启动 EDA 流程；内部术语主动用 `wiki` 核对并标注来源，代码解释按命令去重、结论先行。

### Codex 用户技能

- 默认启用 `skills.enableCodexUser`，`~/.codex/skills/*/SKILL.md` 与上游默认来源一并参与发现；来源优先级不变，同名技能仍优先取 `.agents/skills` 等上游默认开启来源中的版本。
- 仅适用于技能：`~/.codex` 下的 MCP、hooks、commands、AGENTS.md 等其它能力仍按上游规则保持 opt-in。
- 技能是否进入系统提示词列表仍由自身 `disable-model-invocation` / `hide` 决定；不可由模型调用的技能只通过 `/skill:<name>` 与 `skill://<name>` 使用。

### Codex 压缩默认模型

- 压缩候选链（主模型自身、model role 兜底、最大上下文兜底，含 advisor 上下文维护的同名解析）里凡落到 `openai-codex` provider 的候选一律替换为 `openai-codex/gpt-6-luna` 后再参与认证与 remote 资格过滤；luna 不在可用模型中（未认证/被禁用）时保留原候选，不阻断压缩回退。服务器压缩（Responses V2 流式）因此也在 luna 上执行；preserve 数据的 provider 仍是 `openai-codex`，与主模型同 provider，原生回放不受影响。
- 显式配置的 `compactionModel`（models.json `modelOverrides`）不被替换：用户显式指定优先于本默认值。
- 以 `gpt-6-luna` 为压缩模型时，压缩请求的推理档位固定为 `low`（本地摘要、handoff、短摘要与 V2 流式服务器压缩共用同一生效点 `resolveCompactionEffort`），不继承会话当前档位——包括 high/max、未设置时的 high 默认与显式 Off。
- 仅约束压缩链路：主模型选择、主模型推理档位及其他 provider 的压缩行为不变；luna 作为主模型正常使用时档位不受影响（钉制只在压缩调用生效）。

### ZCode 本地代理（zcode-api）

- 内置 provider `zcode-api`，默认指向本机 ZCode Proxy（`http://127.0.0.1:8080`；环境变量 `ZCODE_API_BASE_URL` 以完整的 `http://主机:端口` 基地址覆盖；Anthropic 传输会自行去掉末尾斜杠与多余的 `/v1`），无登录、无配置即在模型面板与 `omp models` 中可见可用；`disabledProviders` 仍可禁用。
- offline（`OMP_OFFLINE=1`）进程中该 lane 在所有入口一律隐藏：`omp models`、TUI `/models` 面板与模型解析都不再列出或解析 `zcode-api`，隐藏只取决于 offline 标志本身，不依赖公司配置是否可用——无公司配置的 offline 进程同样隐藏，此时进程内既无 zcode-api 也无 company，可用聊天模型仅剩其余已配置且凭据就绪的 lane。普通启动照常可见可用。
- 固定使用代理的 Anthropic Messages 直通路由（`/v1/messages`，与 Claude Code 同路径）：工具调用、thinking、上游错误状态原样传递，不经过 OpenAI 翻译层。不做模型发现，不写入 `models.json`（上游守护测试禁止内置目录携带回环地址），模型清单在运行时构建。
- 模型与参数照抄国内「智谱 coding plan」lane（`zhipu-coding-plan`）：14 个 GLM（`glm-4.5` / `glm-4.5-air` / `glm-4.6` / `glm-4.6v` / `glm-4.7` / `glm-5` / `glm-5-turbo` / `glm-5v-turbo` / `glm-5.1` / `glm-5.2` / `glm-5.2-highspeed` / `glm-5.3` / `glm-5.3-flash` / `glm-5.3-highspeed`），上下文窗口、最大输出、视觉输入、tokenizer 与价格同该 lane；`glm-5.2-highspeed[1m]` 是该 lane 的折叠别名，本 provider 无折叠表，不收录。思考档位与 coding plan 相同（多数 SKU `minimal`–`high`；`glm-5.2*` 为 `high`/`max`；`glm-5.3*` 为 `low`/`high`/`max`、默认 `max` 且不可关闭）。
- 默认无凭据：请求不携带有效密钥；若本机代理设置了 `auth.proxyApiKey`，用环境变量 `ZCODE_API_KEY`（或 `ZCODE_PROXY_API_KEY`）或 `models.yml` 的 `providers.zcode-api.apiKey` 提供；代理自身的上游登录状态不受影响。无凭据时直通不发送 `Authorization`、不注入 `X-Api-Key` 的行为由上游无凭据 Anthropic 端点机制（上游 PR #13043）提供，非 fork 补丁；`model.headers` 中显式给出的 `Authorization` 仍然生效。
- 兼容规则提供 tool_result id 镜像与思考模式适配；认证面无 login 流程，不出现在 `/login`。
- `models.yml` 中 `providers.zcode-api` 的 provider 级 `baseUrl` / `headers` / `compat` 不生效（运行时合成行绕过用户覆盖）；仅 `apiKey` 与环境变量 `ZCODE_API_BASE_URL` 参与配置。命中这些不生效字段或 `models:` 定义时，启动会输出一条保留提示（不阻断启动）。

### 公司内网模型（仅 `OMP_OFFLINE`）

- `company` lane 只在 offline（`OMP_OFFLINE=1`）进程中存在：普通启动不注册该 provider，没有 company 模型、向量回退或启动警告；显式 `--provider company` 或 `--model company/...` 直接报错提示需要 `OMP_OFFLINE=1`。`models.yml` 中名为 `company` 的 provider 段整段忽略（该 id 为 fork 保留），命中时启动会输出保留提示（不阻断启动）。以下条目均限于 offline 进程。
- `OMP_OFFLINE=1` 下的 `omp models` 与 `omp bench <selector…>` 采用与进程级 offline 同一套 company 语义：先翻转 lane 再构建 registry，因此 `omp models` 列出公司聊天模型、`omp bench` 能解析并压测 `company/<模型>` 选择器（两者同样隐藏 zcode-api，见「ZCode 本地代理」）；刷新与 selector-miss 的发现回退都用 cache-only 策略、不发公网请求；公司配置缺失或无效时把公司 provider 的错误原因写到 stderr，不静默。未设 `OMP_OFFLINE` 时两者都不注册公司 provider。其余需要解析模型的子命令（`omp dry-balance`、`omp render`、`omp read`、`omp usage` 等）尚未接入该开关：改动这些命令时 MUST 按同一语义补齐，不得让其继续静默走 zcode/公网路径。
- 内置 `company` provider，无需登录、填写凭据或创建 `models.yml`。OMP 启动时读取一次 Claude Code 配置目录（默认 `~/.claude`，可用 `CLAUDE_CONFIG_DIR` 覆盖，与其它 Claude 发现路径同一入口）下 `settings.json` 的 `env.ANTHROPIC_BASE_URL` 和 `env.ANTHROPIC_AUTH_TOKEN`；成功和失败均缓存，运行期间不重读、不监听文件，同进程 Worker 继承内存快照，修改配置须重启 OMP。
- URL 和 Token 仅保存在内存，不复制到 OMP 配置；配置缺失、字段错误或 JSON 无效时 provider 不可用，启动提示不包含凭据。
- 聊天使用 Anthropic Messages 协议和 Bearer 认证，不做公司模型发现、不请求对应厂商的公网 API。内置参数固定如下（token 数）：

   | Model ID                   | 输入       |    上下文 | 最大输出 |
   | -------------------------- | ---------- | --------: | -------: |
   | `DeepSeek-V4-Flash-public` | 文本       | 1,000,000 |   81,920 |
   | `GLM-5.2-public`           | 文本       | 1,000,000 |   81,920 |
   | `MiniMax-M2.7`             | 文本       |   204,800 |   81,920 |
   | `Qwen3.6-27B-public`       | 文本、图片 |   262,144 |   81,920 |
   | `Qwen3.6-35B-A3B`          | 文本、图片 |   262,144 |   81,920 |
   | `Qwen3.8-27B`              | 文本、图片 |   262,144 |   81,920 |

- Mnemopi 已启用且没有显式向量配置时，自动使用 `Qwen3-VL-Embedding-2B`，复用启动缓存中的 URL 和 Token，不改变记忆系统的启用状态。显式向量模型、地址、凭据，以及显式设置的 `mnemopi.embeddingVariant` 仍优先（只有它的 schema 默认值会让位给公司模型）；不会将公司 Token 发送给显式配置的其他地址。
- company 嵌入默认值同样让位于通用 API 路由：company lane 激活时，若 `OPENROUTER_BASE_URL` 指向非 openrouter 主机（自定义通用网关），或 `MNEMOPI_EMBEDDINGS_VIA_API` 为真值（显式要求向量走 API），向量改按通用 API 配置解析（模型、地址、密钥），不注入公司 URL 与 Token；仅有共享的通用 API 密钥而无自定义网关地址时不构成让位条件。
- 向量采用 OpenAI 兼容 `/v1/embeddings`：去掉 Base URL 末尾斜杠，已有 `/v1` 时不重复追加，保留其他路径前缀。不探测其他路径、不回退到公网；公司网关兼容性需要内网实测。
- 检索模型目录仅包含 `Qwen3-VL-Embedding-2B` 和 `Qwen3-VL-Reranker-2B`，不包含 8B 模型，两种检索模型不作为聊天模型展示。现有记忆流程只接文本向量，默认的 `Qwen3-VL-Embedding-2B` 也只传文本，图片向量与远端 Reranker 尚未接入检索流程。

### 上游缺陷散点修复

基础设施修复只在已确认使用场景确实依赖时保留；不因历史上修复过就形成独立维护义务。以下剩余补丁是待核对必要性的现状线索，不代表已确认必须保留，也不能在未核实依赖前直接认定可删除。上游已包含等价修复后，移除重复实现及 fork 额外保留的回归测试，fork 测试聚焦仍有效的本地差异。

- `packages/coding-agent/src/lsp/clients/biome-client.ts`：Windows 上 abort 与 stdout 管道读取 race，脚本包装的孙子进程不再持有管道造成永久等待。
- `packages/utils/src/ptree.ts`：stdout 经包装流跟踪 EOF（attachSignal 等待 stdout/stderr 收尾、stdout 惰性暴露与完成后收口），孙子进程在截止/中止后持有管道不再永久挂起读取；`packages/utils/test/ptree-timeout.test.ts` 覆盖。截止时取消管道读取并保留部分输出已由上游（2026-10-07 `#cutoff` + `#pipeReaders`）等价提供，不再由 fork 承担。
- `packages/utils/src/marked/core.ts`：共享 Markdown lexer 与文档章节解析使用一致的围栏合法性：反引号围栏的 info string 含反引号时按普通段落处理，不中断已有段落或丢弃其中的检索词；波浪线围栏的 info string 及有效代码正文不受影响。文档索引迁移从存储原文恢复受影响的全文检索，不要求源目录存在。
- `packages/coding-agent/src/modes/rpc/rpc-mode.ts`：上游 `RpcUserInputGate.enqueue` 无重入通道，从运行中 section 自身异步子树内再次 enqueue 会等待自己而死锁（e0fc1cf 基线即与其自身 `rpc-user-input-order` 测试矛盾）；fork 以 AsyncLocalStorage section 作用域让该重入内联执行，其余仍按到达顺序排队。
- `packages/coding-agent/src/session/session-paths.ts`：temp 根嵌套在 home 内（Windows `%TEMP%`）且 cwd 两者皆属时，除既有 `shadowedHomeDirName` 外同时前移 home 范围的旧 hashed 命名目录（`shadowedHomeHashedDirName`），旧会话目录不因命名切换而失联。
- `packages/omptype/src/typebox.ts`：指数形式数值（如 `1e21`）超出 DSL 边界可表达范围时回退运行时 narrow，并补齐 JSON Schema minimum/maximum 输出。
- `packages/utils/src/ar/open.ts`：归档解压 symlink 在 Windows EPERM 时降级为 junction 或文件复制（PR #14267 待上游合并）。
- `crates/pi-builtins/src/cksum.rs`：行解析中 `(` 位于行首时的 `par_idx` 越界守卫（PR #14265 待上游合并）。
- `.zcodeignore`：ZCode 客户端忽略清单（上半部从 `.gitignore` 同步，下半部为 ZCode 默认排除规则）；不改变 omp 行为，属开发环境配置。

### 默认设置

保持以下 fork 默认值：

- `recap.enabled=false`
- `statusLine.compactThinkingLevel=false`
- `composer.shape=pi`
- `theme.dark=dark-terminal`（浅色主题仍为上游默认 `light`）
- `display.showTurnTime=true`
- `mnemopi.embeddingVariant=multilingual`
- `stt.language=zh-CN`（本地 Whisper 与云端转录的区域标签均归一化为基语言，如 `zh-CN`→`zh`；默认 tier parakeet/sherpa 不使用语言参数）

### 快捷键与状态栏

- `Shift+Tab`：计划模式。
- `Ctrl+T`：临时模型。
- `Alt+P`：thinking blocks 显示/隐藏。
- `Shift+F1`：循环切换 thinking level。
- 状态栏默认显示 active time，并支持窄终端自动换行；`composer.shape=band` 除外——其状态行位于编辑器顶带，装不下的段按上游行为省略，不生成换行行。
- `composer.shape=pi` 时状态栏独立位于输入框下方。
- 设置向导的主题选项「Match terminal」保留已配置的深色主题，只把浅色主题映射为 `light`；选择该项不会把现有深色主题覆盖为 `titanium`。

### 安装与运行

- 维护面向公司内网 Linux/tcsh 使用者的简洁[新手快速指南](../quick-start-intranet.md)：最前面说明 `OMP_OFFLINE` 与 `OMP_CONFIG_ROOT`，随后说明先执行 `ma dmas_ide`、`ide agent` 启动 IDE 和模型代理，再覆盖常用终端命令、内置命令、快捷键及可复制的任务示例（含 `/loop`、`/goal`、`/team`、代码定位索引 `/repo`、`/advisor`，以及可直接携带任务文本的 `/ultrathink`、`/orchestrate`、`/workflowz`、`/fullsend`）。内容依据当前实现，明确循环/目标的停止方式及内网限制，不扩展为上游文档翻译或站点。
- 日志行为跟随上游默认，不维护 fork 专用日志策略或启动参数。
- 默认启动、`omp launch`、`omp acp`、`omp join`、`omp setup` 这些经过会话启动路径的进程，若未设置 `PI_WALK_WORKERS` 且本机逻辑核数 > 8，会在进程内把文件遍历线程数设为 `min(核数/2, 16)`（32 逻辑核 → 16）；逻辑核数 ≤ 8 时保留 native 默认值 4。只改当前进程环境，不写配置文件，用户显式设置的值（含 `0`）永远优先；其他子命令（`omp grep`、`omp models` 等）不受影响。
- offline 模式只由环境变量 `OMP_OFFLINE` 触发（取值 `1`/`true`/`yes`/`on`，忽略大小写；未设置、空串、`0`/`false` 等其余值不触发），不存在 offline 命令行参数：环境变量对所有 omp 进程及其子进程一致生效，这是把触发入口统一到环境变量的原因（多进程数据根与 lane 状态不能因 spawn 透传遗漏而分裂）。
- `OMP_CONFIG_ROOT`（绝对路径，支持 `~` 展开；相对值被忽略）把整个数据根从 `~/.omp` 迁移到指定目录：agent 数据、缓存、运行状态、profiles 等全部派生目录随之迁移，浏览器工具的 storage-state 等跟随；项目级 `.omp/` 不受影响。与 `PI_CONFIG_DIR` 同时设置时由 `OMP_CONFIG_ROOT` 决定根位置。
- `OMP_OFFLINE` 进程中若未设置 `FS_SCAN_CACHE_TTL_MS`，进程内设为 `30000` 毫秒；该变量只影响 `@` 文件补全的目录重扫间隔，非 offline 进程完全不变，用户显式设置的值（含 `0`）优先。
- `OMP_OFFLINE=1` 以无公网模式启动本次进程：临时把 `web_search.enabled`、`browser.enabled`、`fetch.enabled` 关为 `false`，所有 `company` 聊天模型的 `contextWindow` 设为 `200000`（不改 `maxTokens`）。这些覆盖不写配置文件，退出即消失，普通启动保持原值。Python Eval 沿用原有解释器配置与自动发现机制。系统提示词仍追加“当前处于 offline 模式，环境无公网。不要尝试访问公网；使用本地资源和公司内部服务。”。公司内部模型 API、bash/eval、本地文件、LSP、本地 Git、Computer Use 等能力仍可用。
- offline 且 company provider 可用时，仅为未配置的 model role 补充当前进程默认值：`default`、`task`、`vision`、`advisor` → `company/Qwen3.8-27B`；`smol`、`tiny`、`commit` → `company/Qwen3.6-35B-A3B`；`plan`、`slow` → `company/GLM-5.2-public`。已有角色配置（包括显式 `null` 清除项）和显式 CLI 模型参数仍优先，不写配置文件，不限制 `/model`、`Ctrl+T` 或角色切换，也不锁定 company。普通启动不受影响。
- offline 当前进程将 `startup.setupWizard` 覆盖为 `false`，不自动弹出或导入首次启动的全屏配置向导；显式启用的启动动画按需独立加载，手动设置入口保持原有行为。
- offline 启动不检查 OMP 新版本、不自动检查或更新插件市场、不读取或展示启动更新日志，也不自动触发在线模型发现——含交互界面就绪后的后台发现，以及会话恢复、默认角色解析、prewalk 目标解析和 `enabledModels`/`--models` scope 预解析里的 discovery fallback（这些自动路径只用本地缓存，缓存缺失时按既有链路降级，不发任何请求）。同进程 task 子代理的新建与恢复也继承该限制。已安装插件、内置和缓存模型照常加载；显式 `--model` 解析、手动模型刷新、更新命令及 `/changelog` 保持原有行为。上述覆盖只在当前进程生效，不写配置文件，非 offline 启动不受影响。

以下是现有个人分发能力，不代表对外发布目标；上游同步不触发构建或发布。

- 个人 Release 版本使用 `+fork.N`，仅从本仓库 `main` 通过手动 CI 生成；手动运行默认只构建可下载的二进制 artifact（`publish_release=false`），明确启用发布后才创建 Release，非 `main` 分支不能发布。CI 永久只承担构建、产物汇总与发布，不运行测试、冒烟、lint、类型检查或独立校验作业；发布只等待版本元数据与全部二进制构建成功，不承担本地验收门禁。`bun run slowtest` 先完成本机与 WSL2 验证，再以 `publish_release=true` 触发 CI，构建发布成功即产出 Release。`N` 取 `.github/workflows/ci.yml` 工作流的 `run_number`，GitHub 按工作流文件路径维护计数，重命名或删除重建该文件会让 `N` 从 1 重新开始（与历史 tag 撞号、旧安装收不到后续更新），NEVER 这样做。
- 构建发布 CI 安装 native 产物时显式跳过宿主 addon 的加载探测（`--skip-load-probe`），仍执行构建所需的版本戳写入；该选项不改变本地构建/安装默认执行加载探测的行为。
- 构建发布 CI 使用 GitHub 原生缓存保存 Bazel action cache、依赖下载及 Cargo registry/git；无需自建缓存服务器或额外凭据。各 native target 独立恢复与保存缓存，键包含宿主平台、目标、工具链/构建配置及 native 源码指纹；源码变化时可恢复同配置的旧缓存，由 Bazel 判断哪些 action 可复用。缓存缺失或被 GitHub 淘汰时正常冷编译，不跳过构建。
- 二进制必须携带 fork 版本、构建时间和更新仓库信息。
- 本地构建脚本 `packages/coding-agent/scripts/build-binary.ts` 同样注入本 fork 更新仓库：本地构建产物的 `omp update` 指向本 fork Release，不会回退官方渠道（版本号不注入，`--version` 无 `+fork.N` 后缀属预期）。
- `omp update` 先比较正常 SemVer，再比较同基线的 fork build counter；本地构建未带 `+fork.N` 时按 counter 0 比较，因此可取得同基线的新 fork Release，而不把更高上游基线降级。支持 `%2B` 编码的 `+` 版本 URL；GitHub 元数据和资产统一优先环境令牌，再尝试本机 `gh auth token`，无凭据才匿名请求。
- `omp update` 下载二进制时，在交互终端显示下载百分比、速度与预计剩余时间；非 TTY 输出（如 CI、管道）不显示动态进度。若 `PATH` 中的 `omp` 与更新目标解析为不同文件，更新前警告并提示更新后运行 `omp --version` 核对实际生效的版本；指向同一文件的符号链接不视为冲突。
- `update.channel=canary` 在 fork 二进制上不可用：启动版本检查会提示该配置并指向 `omp update --stable`；其余更新检查失败仍静默。
- `-fork.N` 时代（fork build ≤ 35，2026-08-26 及更早）的旧安装内嵌只认 `vX.Y.Z-fork.N` 的校验，会拒绝此后所有 `+fork.N` Release（报 `Invalid fork release tag`）且无法自愈，只能用安装器重装后再交给 `omp update`。
- 发布链路不发布核心或平台 npm 包，也不发布 Homebrew tap；Release notes 由 GitHub 自动生成。发布物为 Linux x64/arm64（各含 glibc 与 musl）和 Windows x64 二进制、`omp-browser-relay-extension.zip`、`LICENSE`、`THIRD-PARTY-NOTICES.txt`、`SHA256SUMS.txt`；不构建 macOS 或 Windows arm64 二进制。
- 安装器只安装 fork Release 的预编译二进制：Linux x64/arm64、Windows x64；`install.sh` 在 macOS 上于联网前明确拒绝安装。安装目标已是所选 Release 版本时提示已安装并跳过下载，同时仍检查 PATH 配置。
- 两个平台的安装器都下载到安装目录中的唯一临时文件，先确认可启动且 `omp --version` 与所选 Release 完全一致，再替换现有安装；验证失败保留旧安装并清理临时文件。可执行目标是目录时联网前拒绝，不移动目录内容；已经是所选版本时跳过下载但仍提示 PATH。Windows 优先 `curl.exe`，失败或不可用时回退兼容 PowerShell 5.1 的 `Invoke-WebRequest -UseBasicParsing`，只维护 PATH，不写废弃的 settings.json 或擅自改用户 shell/config.yml。
- 安装器替换目标二进制时不中断运行中的 omp：Linux 用同目录原子 `mv`；Windows 先把旧 `omp.exe` 重命名到唯一的 `.omp.old.*` 再换入（换入失败自动回滚），仅当重命名失败（如杀软锁定）才回退为按安装路径精确匹配强杀，`.omp.old.*` 残留由下次安装尽力清扫。强杀回退中若换入再次失败、或换入失败后回滚也失败，保留已下载的 `.omp.tmp.*` 文件作为安装目录内可恢复的二进制（重跑安装器即可恢复）。

- 模型筛选、可用性、角色解析和显式选择统一采用上游规则；各 fork 功能复用这些规则，不维护 fork 专有的模型硬排除契约。

## Fork 验证体系

保留 `fastcheck`、`fulltest`、`slowtest` 三个入口，采用尽量简薄的编排，优先复用上游检查、测试运行器与 CI。

- `fastcheck` 承担静态检查，保留 TS 类型、lint、格式及 Rust 检查目标；不设置 fork 整体硬超时，以实际检查结果判定成败。
- `fulltest` 承担当前操作系统下的必要验证，包含保留的 fork 功能测试与真实公开入口验证。不维护上游测试白名单。上游入口的平台适用性须核对，不能以取消白名单为由省略必要覆盖，也不能把不支持或失败报告为通过。上游红色期间的例外：Windows 专属代码的 pinned-nightly clippy 缺陷已随上游修复合入，但 fulltest 静态阶段暂仍只跑上游 `check:ts`、不含 `check:rs` 的 fmt/clippy 半边；恢复 Rust 静态检查须另行验证，当前状态以 `AGENTS.md`「现状与缺口」为准。上游自身测试 `pi-builtins sed::fast_io::tests::test_file_truncated_after_open` 在 Windows 确定性失败（上游 CI 只在 Linux 测试），`test:rs` 的 nextest 调用在 Windows 上过滤该单个用例，不额外过滤所选 crate 内的其他用例；crate 选择仍遵循 `fulltest` 的差异范围。上游带入的未过其自身格式门禁的文件按锁定 oxfmt 版本在本地格式化以保持门禁可用（上游格式化后差异自动消除）。恢复条件均为上游转绿后按各文件内注释还原。
- `slowtest` 保留本机验证、Ubuntu-24.04 WSL2 验证、自动推送、触发和监控构建发布 CI、成功后发布个人 Release 的流程。测试留在本地 Windows 与 WSL2，不在远端 CI 重复运行；WSL2 仍是 Windows 发布流程的必经阶段，核对同一提交，保留工作区保护与失败停止要求；非 Windows 平台不增加 WSL 阶段。两端仍按 `fulltest` 的差异选择范围执行，不扩展为上游全量测试。
- 不设置 fork 自定义的测试阶段和 WSL 阶段时限，测试本体沿用上游运行器与 CI 的超时机制；WSL 阶段的非测试挂起（如安装或环境准备）无自动时限，由操作者中止。取消操作仍须正确处理本次任务拥有的资源。
- fork 功能继续要求自动化局部验证与真实入口 E2E。模拟不替代真实边界验证，未运行、失败和通过分别报告。执行授权仍遵循项目规则。
- 测试适配只维护已保留功能及支持平台所必需的部分，不再将历史测试补丁清单作为独立产品需求。

本节定义目标，已由 `scripts/fulltest.ts`、`scripts/slowtest.ts` 与 package.json 的 `fastcheck` 别名按薄编排实现（2026-10-07）；实现细节与运行细则以 `AGENTS.md`「验证」一节为准。
