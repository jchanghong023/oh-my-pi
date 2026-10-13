# Fork 与上游差异

本仓库是个人自己使用的 fork 维护仓库：持续同步上游最新 `main`，保留个人功能和默认值，不以对外发布为目标。

本页面向本人和 AI agent，维护项目定位、共同使用目标及**相对当前上游基线仍有效、对使用者有影响的功能差异**，不记录实现细节或同步历史（随日常开发沉淀、上游尚未包含的缺陷修复统一记录在「上游缺陷散点修复」一节，并在上游等价修复合入后删除对应条目）。开发规则见仓库根 `AGENTS.md`，同步步骤见 `.omp/skills/upstream-release-sync/SKILL.md`；需求域划分见[目录索引](README.md)。当前有效范围：模型选择与验证编排跟随上游规则（fork 不维护模型硬排除或手工测试白名单），诊断日志继续复用上游 logger，覆盖契约见本文「运行诊断日志」；`/team`、`/repo`、`/wiki`、company/zcode-api、`/jch*`、fullsend、Codex 策略与分发能力完整保留（各域验证状态见[目录索引](README.md)）。代码定位索引的独立契约见[代码定位索引](repo-index.md)。

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
* **版本**：`v18.10.3`
- **Upstream commit**：`7738a3f082880bf5fbd38f043d31a05003a49b54`
- **同步日期**：2026-10-13

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

### `/goal-auto-orchestrate` 持续无人值守目标

完整命令、模式归属、正常历史中的持久化上下文、成功提交压缩后的目标恢复与 Orchestrate 规则重新展开、权限边界及验收条件统一维护在 [Goal 自动编排需求](goal-auto-orchestrate.md)，此处不重复条款；实现与验收状态见[目录索引](README.md)。

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
- `/jch-workflowzbatch <任务块软目标> <并发上限> <任务正文>`：内置提示词快捷命令，两个数量必须为正的安全整数，正文非空；非法输入只报用法，不启动模型回合。展开为以独立 `workflowz` 关键词开头的普通用户消息，保留正文中的换行与字面量，不新增关键词、调度器或配置写入。
  - 用于全仓审查、补日志、格式优化等互不依赖的批处理。任务块数量是期望最多约该数量的软目标，按工作量调整，不凑数或扩大范围；任务块数与并发槽数独立，可以多于并发槽数，不以并发上限决定拆分数量。并发数量是向 OMP 下达的同时运行子代理总数上限指令（含嵌套），不是命令新增的程序级限制，现有配置上限更低时仍遵守，由工作池自动截断为较低值；提示词明确要求不向用户询问是否覆盖或修改并发上限，也不修改任何全局配置。
  - 按任务正文确认实际范围和统一规则，向子代理提供已核实的适用规则/需求路径，修改型任务分配不重叠文件集合并保留无关已有修改；复用现有工作池排队、完成即补位，不等待整批屏障。
  - 子代理按任务正文自主完成所属范围：只读任务只报告，修改任务完成证据充分且已授权的最小修改及允许的文件级检查；证据不足只列候选，不推测性修改或扩大范围。跨界发现交主代理协调，不越过文件归属直接修改；跨文件修改由主代理调整归属并指定单一修复责任人。
  - 主代理负责调度、及时补位、跨界协调和结果汇总，不默认重复读取已分配文件的完整 diff 或重审全部改动，仅对争议发现、跨文件修改和结果冲突作必要的定点核对，不集中补跑检查；子代理对所属修改的自查与允许检查不受此限制。
  - 主代理和所有子代理禁止任何测试（含单文件、冒烟、E2E）、全仓格式化、全仓静态检查及 fastcheck/fulltest/slowtest 等门禁。仅允许对自己负责修改的文件执行文件级非测试检查或任务要求的格式化，不能限定这些文件的工具不得运行，也不得扩大到目录、包或工作区。
  - 上述限制须原样传给每个子代理并约束主代理收尾；与仓库及子目录 AGENTS.md 的验证要求冲突时，以本次明确限制为准，其他规则继续有效，系统及开发者级约束不受覆盖。不修改长期规则，不在汇总阶段补跑禁止操作。
  - 子代理精简返回完成状态、处理结果、覆盖及修改文件、实际文件级检查和受阻/未验证项；有发现或修复时保留触发条件、根因、修改位置及最短证据链，无发现时不展开调用链或正确性评级。主代理按任务项去重汇总完成项、失败或受阻项、修改文件及实际文件级检查，注明测试未运行与跨文件、运行时行为未验证，不声称功能验收通过。该例外仅适用于本命令发起的批处理，不适用于命令本身的实现维护。
  - 命令展开与参数边界需自动化验证；真实公开入口需确认展开内容以用户消息送至 Provider 并沿用原有关键词通知。命令机制验证不等于模型实际遵循约束或大规模批处理验收。

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
- 模型与参数照抄国内「智谱 coding plan」lane（`zhipu-coding-plan`）：15 个 GLM（`glm-4.5` / `glm-4.5-air` / `glm-4.6` / `glm-4.6v` / `glm-4.7` / `glm-5` / `glm-5-turbo` / `glm-5v-turbo` / `glm-5.1` / `glm-5.2` / `glm-5.2-highspeed` / `glm-5.3` / `glm-5.3-flash` / `glm-5.3-flashx` / `glm-5.3-highspeed`），上下文窗口、最大输出、视觉输入、tokenizer 与价格同该 lane；`glm-5.2-highspeed[1m]` 是该 lane 的折叠别名，本 provider 无折叠表，不收录。思考档位与 coding plan 相同（多数 SKU `minimal`–`high`；`glm-5.2*` 为 `high`/`max`；`glm-5.3*` 为 `low`/`high`/`max`、默认 `max` 且不可关闭）。
- 默认无凭据：请求不携带有效密钥；若本机代理设置了 `auth.proxyApiKey`，用环境变量 `ZCODE_API_KEY`（或 `ZCODE_PROXY_API_KEY`）或 `models.yml` 的 `providers.zcode-api.apiKey` 提供；代理自身的上游登录状态不受影响。无凭据时直通不发送 `Authorization`、不注入 `X-Api-Key` 的行为由上游无凭据 Anthropic 端点机制（上游 PR #13043）提供，非 fork 补丁；`model.headers` 中显式给出的 `Authorization` 仍然生效。
- 兼容规则提供 tool_result id 镜像与思考模式适配；认证面无 login 流程，不出现在 `/login`。
- `models.yml` 中 `providers.zcode-api` 的 provider 级 `baseUrl` / `headers` / `compat` 不生效（运行时合成行绕过用户覆盖）；仅 `apiKey` 与环境变量 `ZCODE_API_BASE_URL` 参与配置。命中这些不生效字段或 `models:` 定义时，启动会输出一条保留提示（不阻断启动）。

### CodeAgent 内置模型

- Windows 非 offline 启动内置 `codeagent/DeepSeek-V4-Flash-0731-CodeAgent`，无需配置或登录；非 Windows 平台不注册该内置模型，`OMP_OFFLINE` 生效时所有入口隐藏，其他 Provider 行为不变。
- 固定 base URL `https://snapengine.cida.cce.prod-szv-y.dragon.tools.huawei.com/api/v2`，API `openai-completions`，`auth: none`，禁用严格工具模式（OpenAI 兼容轴 `supports-strict-mode #false`，不使用仅适用于 Anthropic 的 `disableStrictTools`）；模型 ID 与名称均为 `DeepSeek-V4-Flash-0731-CodeAgent`，支持 reasoning 与 tools，contextWindow `200000`，maxTokens `32768`。
- Windows 启动直接读取 `HKCU\Environment\JCH_CODEAGENT3_X_AUTH_TOKEN` 并在内存缓存，作为 `x-auth-token` 请求头；正常请求不重读注册表，不使用进程环境变量快照。
- 认证或 API 请求失败时重读注册表；新 Token 与请求所用 Token 不同则刷新缓存，并仅在尚无流式正文、思考或工具输出且未取消时自动重试一次；Token 未变化不重试。此限制覆盖对话、压缩摘要与 handoff，不允许外层重试或认证、模型、压缩方法回退重新发送失败请求。已产生流式输出的请求只刷新后续请求的缓存，禁止重放；刷新无需重启、切模型或创建新会话。
- 凭据不写配置或日志，不改变其他 Provider 的缓存、认证或重试行为；注册表读取失败不清除已缓存 Token。

### JchTools 零配置发现与远端 Agent

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
- `packages/utils/src/ar/open.ts`：Windows EPERM 时降级为 junction 或文件复制、跳过 dangling link 已由上游提供；fork 仅保留文件复制时的独占目标语义，不能覆盖现有文件或跟随已有 symlink。
- `packages/coding-agent/src/tools/read-archive.ts`：Windows 同尺寸快速重写归档并恢复 mtime 时，ctime 也可能不变；该平台不复用仅由文件元数据验证的归档目录缓存，避免返回旧成员名称或读取错误成员。其他平台保留既有有界缓存。
- `crates/pi-builtins/src/cksum.rs`：行解析中 `(` 位于行首时的 `par_idx` 越界守卫（PR #14265 待上游合并）。
- `crates/pi-builtins/src/uptime.rs`、`du.rs`：仅在 Unix 导入 `std::io` 与声明可变 mount 集合；Windows 保留实际使用的 `Write` 和不可变空集合，满足现有零警告 Rust 静态门禁，不改变命令行为。
- `crates/pi-natives/src/file_lock/windows.rs`：Windows 进程间租约仅申请 `SYNCHRONIZE` 权限；已有同名互斥锁允许同步但不允许全部访问时，按正常锁竞争返回未获取租约，不能导致 broker 启动失败与文字补全暂停。真实拒绝访问仍保留为错误；持有者退出或释放后，后继进程可获取租约。
- `.zcodeignore`：ZCode 客户端忽略清单（上半部从 `.gitignore` 同步，下半部为 ZCode 默认排除规则）；不改变 omp 行为，属开发环境配置。

### 默认设置

保持以下 fork 默认值：

- `recap.enabled=false`
- `ask.timeout=30`（秒；显式 `0` 关闭超时，计划模式继续关闭 ask 自动选择；同一设置也约束 `cfg://` 审批，未回答时拒绝写入）
- `startup.quiet=false`（保留上游默认的欢迎界面、Logo、版本号、Tip 与启动状态消息；用户显式改为 `true` 可隐藏，不影响设置向导开关）
- `startup.setupWizard=false`（任何机器上 setupVersion 落后于当前版本也不自动运行设置向导；`--setup` 显式入口与 force 分支不受影响）
- `statusLine.compactThinkingLevel=false`
- `composer.shape=box`（Rounded Box）
- `theme.dark=dark-terminal`（浅色主题仍为上游默认 `light`）
- `display.showTurnTime=true`
- `mnemopi.embeddingVariant=multilingual`
- `stt.language=zh-CN`（本地 Whisper 与云端转录的区域标签均归一化为基语言，如 `zh-CN`→`zh`；默认 tier parakeet/sherpa 不使用语言参数）

### 快捷键与状态栏

- `Shift+Tab`：计划模式。
- `Ctrl+T`：临时模型。
- `Alt+P`：thinking blocks 显示/隐藏。
- `Shift+F1`：循环切换 thinking level。
- ANSI 终端的空输入框固定显示 `Ctrl+T 临时模型 · Ctrl+Q 排队发送 · Esc Esc 回退对话 · /tree 会话历史 · /goal 目标 · 有使用问题反馈j00808874`，只作为帮助文字，不随状态、使用次数或自定义按键变化；输入文字后隐藏，清空后恢复。复用既有占位提示布局，宽度不足时隐藏，不新增配置或轮播；“回退对话”不表示撤销文件修改。
- 状态栏默认配置（`statusLine.preset` 的 `default` 定义，零配置启动即生效）：左组依次 `pi`、`model`、`mode`、`collab`、`stream`、`path`、`git`、`subagents`、`token_rate`、`cache_hit`、`context_pct`、`time_spent`，右组为空，分隔符 `powerline-thin`；segmentOptions 沿用上游 default 定义（模型显示思考等级、路径缩写上限 40、git 分支显示且 staged/unstaged/untracked 三类改动均计入合并数量）。该清单之外的状态栏段（会话名/ID、主机名、vim、hook 状态、PR、输入/输出/总 token、费用、缓存读写、上下文窗口大小、挂钟时间、订阅额度）默认不显示；用户选择 `custom` preset 时仍可完整自定义。
- Git 段统一显示纯文本 `git main · 改动5`，不显示 Git／分支图标及 `*`、`+`、`?` 分类符号；改动数为已暂存、未暂存、未跟踪文件的并集，同一文件同时有暂存与未暂存改动只计一次，未跟踪目录内按文件逐个统计，忽略文件不计入。零改动时省略数量；无分支或用户关闭分支显示时只显示 `git 改动5`，分支与数量都不可见时隐藏该段。ANSI 与 native 界面采用同一文字与计数规则；既有三类显示选项仍控制是否计入对应类别。
- 配置中的 `subagents` 段按所属组与顺序显示，运行中的子代理徽章不得强制移到右组或重复显示；未配置该段时保留上游临时右侧徽章。后台作业徽章沿用上游显示机制，右组配置为空不关闭这些临时徽章。
- 输入框顶边的 `statusLine.contextLine=embedded` 模式把上下文使用率与窗口容量合并为靠右的 `ctx 3% · 500K` 信息组，容量与说明文字弱化，组后留两个字符间距；使用率变化不让标签沿横线移动。保留用量横线，不显示预压缩与自动压缩的两根刻度，不改变压缩功能（显式选择 `annotated` 模式仍显示刻度）；未知用量只显示容量，超过 100% 的真实比例仍以错误色显示；窄窗口优先缩短路径，顶边放不下时沿用状态栏溢出显示。
- 状态栏支持窄终端自动换行；`composer.shape=band` 除外——其状态行位于编辑器顶带，装不下的段按上游行为省略，不生成换行行。
- `composer.shape=pi` 时状态栏独立位于输入框下方。
- 设置向导的主题选项「Match terminal」保留已配置的深色主题，只把浅色主题映射为 `light`；选择该项不会把现有深色主题覆盖为 `titanium`。

### 运行诊断日志

- 项目 MUST 提供可落盘的诊断日志，主要用于运行时问题定位和 Agent 故障分析；fork 功能复用上游统一 logger、目录、级别与轮转，不建立平行日志系统或新增必填配置。
- 异常、超时、重试、降级与部分提交等分支 MUST 留下可识别的阶段和结果；关键调用 MUST 记录安全的结果摘要及耗时。可能阻塞的调用、网络请求、IPC 和子进程 MUST 有开始与成功/失败/取消终态，不能仅依赖 UI、stdout/stderr、协议回包或会话 JSONL。
- 运行日志使用单行结构化记录，MUST 写入 `.log` 文件，每条记录具有含时区的毫秒时间戳、级别和 PID；业务边界补充稳定事件、组件、阶段与 `elapsed_ms`。默认路径由 `getLogsDir()` 解析为当前数据根的 `logs/omp.<日期>.<PID>.log`，随 `OMP_CONFIG_ROOT`、profile 和适用的 Linux XDG 状态目录迁移；沿用现有日期/大小轮转与保留规则。
- 级别约定：INFO 记录关键开始、完成和状态变化；WARN 记录可恢复异常、重试或降级；ERROR 记录当前操作失败；DEBUG 仅承载额外细节。正常取消、服务缺席和协议预期拒绝不能冒充故障；必要诊断不得全部藏在可关闭的 DEBUG 中。
- 同一操作 MUST 通过 `operation_id` 及现有 request/job/goal/session/tool-call 标识关联起止和阶段；异步分支继承关联上下文，内部跨进程调用尽可能透传现有标识，不为日志改变外部协议。
- RPC 对话终态须区分用户取消、本地/宿主超时、abort、断连和失败，独立响应帧仍继承发起操作的标识；后台面板吞掉的异常、已保存但 reload 降级、Goal 工具激活/恢复失败与无效持久状态不得被完成/协议成功日志遮盖。
- 会话删除须区分主文件删除、备份清理和附件清理，明确已提交、部分清理及未知状态；team 通知发送与后续 UI 更新分别定位，内部终止仅记录安全原因分类；repo 整代读取失败使用文件指纹定位，不记录原路径或源码。
- 离线 models/bench 的 cache-only 日志仅描述目录发现/刷新，不代表模型请求离线；初始化及后续 selector-miss 刷新保留起止关联。WSL helper 预检拒绝记录有界原因码，不复制 helper 输出正文。
- 凭据、Authorization/Cookie、URL 认证与敏感查询参数、用户输入、提示词、源码、文档/响应正文 MUST NOT 直接入日志。仅记录有界、脱敏的类型、代码、状态、计数、长度和必要栈帧；不得无限复制 stdout/stderr 或大对象。
- 日志目录不可写时 MUST 尝试合理的用户级目录回退，仍失败则向 stderr 有界报告日志初始化故障；日志失败不能递归、掩盖业务结果或使业务崩溃。启动/退出须可追踪并刷新关键记录。
- 本契约覆盖已保留的 fork 功能及其公共边界：JchTools、team、Goal、RPC、docs/wiki、repo/AST 通知、company/zcode 与向量请求、Codex 压缩、JCH Git、门禁和安装/更新；补日志不改变业务控制流、权限、重试次数或超时。验收包含真实入口的成功/失败、适用的网络与 IPC/子进程异常、关联重建及生成日志的敏感信息检查。

### 安装与运行

- 维护面向公司内网 Linux/tcsh 使用者的简洁[新手快速指南](../quick-start-intranet.md)：最前面说明 `OMP_OFFLINE` 与 `OMP_CONFIG_ROOT`，随后说明先执行 `ma dmas_ide`、`ide agent` 启动 IDE 和模型代理，再覆盖常用终端命令、内置命令、快捷键及可复制的任务示例（含 `/loop`、`/goal`、`/team`、代码定位索引 `/repo`、`/advisor`，以及可直接携带任务文本的 `/ultrathink`、`/orchestrate`、`/workflowz`、`/fullsend`）。内容依据当前实现，明确循环/目标的停止方式及内网限制，不扩展为上游文档翻译或站点。
- 日志框架、默认目录与启动参数跟随上游；fork 功能的诊断覆盖遵循上文「运行诊断日志」。
- `-P <name>` 是上游 `--profile <name>` 的内置短参数，无需配置 shell alias；启动前选择 profile，认证、会话、设置与缓存隔离及环境变量优先级沿用上游。`-p` 仍为非交互 print 模式，不新增会话共享行为。
- 默认启动、`omp launch`、`omp acp`、`omp join`、`omp setup` 这些经过会话启动路径的进程，若未设置 `PI_WALK_WORKERS` 且本机逻辑核数 > 8，会在进程内把文件遍历线程数设为 `min(核数/2, 16)`（32 逻辑核 → 16）；逻辑核数 ≤ 8 时保留 native 默认值 4。只改当前进程环境，不写配置文件，用户显式设置的值（含 `0`）永远优先；其他子命令（`omp grep`、`omp models` 等）不受影响。
- offline 模式只由环境变量 `OMP_OFFLINE` 触发（取值 `1`/`true`/`yes`/`on`，忽略大小写；未设置、空串、`0`/`false` 等其余值不触发），不存在 offline 命令行参数：环境变量对所有 omp 进程及其子进程一致生效，这是把触发入口统一到环境变量的原因（多进程数据根与 lane 状态不能因 spawn 透传遗漏而分裂）。
- `OMP_CONFIG_ROOT`（绝对路径，支持 `~` 展开；相对值被忽略）把整个数据根从 `~/.omp` 迁移到指定目录：agent 数据、缓存、运行状态、profiles 等全部派生目录随之迁移，浏览器工具的 storage-state 等跟随；项目级 `.omp/` 不受影响。与 `PI_CONFIG_DIR` 同时设置时由 `OMP_CONFIG_ROOT` 决定根位置。
- `OMP_OFFLINE` 进程中若未设置 `FS_SCAN_CACHE_TTL_MS`，进程内设为 `30000` 毫秒；该变量只影响 `@` 文件补全的目录重扫间隔，非 offline 进程完全不变，用户显式设置的值（含 `0`）优先。
- `OMP_OFFLINE=1` 以无公网模式启动本次进程：临时把 `web_search.enabled`、`browser.enabled`、`fetch.enabled` 关为 `false`，所有 `company` 聊天模型的 `contextWindow` 设为 `200000`（不改 `maxTokens`）。这些覆盖不写配置文件，退出即消失，普通启动保持原值。Python Eval 沿用原有解释器配置与自动发现机制。系统提示词仍追加“当前处于 offline 模式，环境无公网。不要尝试访问公网；使用本地资源和公司内部服务。”。公司内部模型 API、bash/eval、本地文件、LSP、本地 Git、Computer Use 等能力仍可用。
- offline 且 company provider 可用时，仅为未配置的 model role 补充当前进程默认值：`default`、`task`、`vision`、`advisor` → `company/Qwen3.8-27B`；`smol`、`tiny`、`commit` → `company/Qwen3.6-35B-A3B`；`plan`、`slow` → `company/GLM-5.2-public`。已有角色配置（包括显式 `null` 清除项）和显式 CLI 模型参数仍优先，不写配置文件，不限制 `/model`、`Ctrl+T` 或角色切换，也不锁定 company。普通启动不受影响。
- offline 当前进程将 `startup.setupWizard` 覆盖为 `false`，不自动弹出或导入首次启动的全屏配置向导；显式启用的启动动画按需独立加载，手动设置入口保持原有行为。
- offline 启动不检查 OMP 新版本、不自动检查或更新插件市场、不读取或展示启动更新日志，也不自动触发在线模型发现——含交互界面就绪后的后台发现，以及会话恢复、默认角色解析、prewalk 目标解析和 `enabledModels`/`--models` scope 预解析里的 discovery fallback（这些自动路径只用本地缓存，缓存缺失时按既有链路降级，不发任何请求）。同进程 task 子代理的新建与恢复也继承该限制。已安装插件、内置和缓存模型照常加载；显式 `--model` 解析、手动模型刷新、更新命令及 `/changelog` 保持原有行为。上述覆盖只在当前进程生效，不写配置文件，非 offline 启动不受影响。

以下是现有个人分发能力，不代表对外发布目标；上游同步不触发构建或发布。

- 个人 Release 版本使用 `+fork.N`，仅从本仓库 `main` 通过手动 CI 生成；手动运行默认只构建可下载的二进制 artifact（`publish_release=false`），明确启用发布后才创建 Release，非 `main` 分支不能发布。CI 永久只承担构建、产物汇总与发布，不运行测试、冒烟、lint、类型检查或独立校验作业；发布只等待版本元数据与全部二进制构建成功，不承担本地验收门禁。发布须单独明确授权，`bun run slowtest` 仅做本机及适用 WSL 本地验证，NEVER 自动推送、触发/等待 CI 或创建 Release。`N` 取 `.github/workflows/ci.yml` 工作流的 `run_number`，GitHub 按工作流文件路径维护计数，重命名或删除重建该文件会让 `N` 从 1 重新开始（与历史 tag 撞号、旧安装收不到后续更新），NEVER 这样做。
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
- 两个平台的安装器都下载到安装目录中的唯一临时文件，先确认可启动且 `omp --version` 与所选 Release 完全一致，再替换现有安装；验证失败保留旧安装并清理临时文件。可执行目标是目录时联网前拒绝，不移动目录内容；已经是所选版本时跳过下载但仍提示 PATH。Windows 优先 `curl.exe`；未设置目标协议的代理环境变量及 `ALL_PROXY` 时，自动解析当前用户的 Windows 系统代理并传给 curl，不要求额外设置环境变量。显式代理环境变量优先，curl 遵循 `NO_PROXY`；curl 失败或不可用时仍回退兼容 PowerShell 5.1 的 `Invoke-WebRequest -UseBasicParsing`。安装器只维护 PATH，不写废弃的 settings.json 或擅自改用户 shell/config.yml。安装器自身的全部 Web 请求（Release 元数据与二进制下载）默认放宽 TLS 校验，与运行时零配置姿态一致：curl 追加 `--insecure --ssl-no-revoke`（Schannel 吊销检查在拦截代理后常失败），PowerShell 5.1 启用 TLS 1.2 并挂接放行证书回调，PowerShell 7+ 对 `Invoke-RestMethod`/`Invoke-WebRequest` 传 `-SkipCertificateCheck`；下载完整性仍由装后 `omp --version` 与所选 Release 完全一致的校验兜底。
- 运行时代理与安装器同序：Windows 主进程内所有经全局 `fetch` 的出网请求（含 LLM 流、OAuth/usage 探测、模型发现、更新检查与 web 请求）按「请求自带显式 `proxy`（`PI_PROXY_<PROVIDER>`/`PI_PROXY`）→ 标准代理环境变量（`HTTPS_PROXY`/`HTTP_PROXY`/`ALL_PROXY`，Bun 原生应用）→ 当前用户 Windows 系统代理 → 直连」解析。系统代理仅取 HKCU Internet Settings 的静态 `ProxyEnable`/`ProxyServer`（含 `http=`/`https=` per-protocol 形式，`socks=` 条目与 PAC/WPAD 不支持），每进程读取一次并缓存；未启用或读取失败时行为与无此改动一致。`NO_PROXY` 与回环/内网硬 bypass 同样约束系统代理。仅 win32 生效；worker 子进程入口（本地服务）不经此链路。
- 零配置 TLS 默认：主进程网络引导时，未显式设置即默认 `NODE_TLS_REJECT_UNAUTHORIZED=0`（Bun fetch 认可，覆盖全部 fetch 请求的证书验证）与 `GIT_SSL_NO_VERIFY=true`（主进程拉起的 git 子进程继承），使拦截代理/私有网关的自有根证书场景免配置可用。显式设置任何值（如 `NODE_TLS_REJECT_UNAUTHORIZED=1`、`GIT_SSL_NO_VERIFY=false`）即恢复严格校验，agent 目录 `.env` 同样先于此默认生效；worker 子进程入口不经此默认。这是个人 fork 的安全姿态取舍：进程内所有 TLS 不再验证端点身份，凭据在可劫持网络下有被截获风险，仅在个人受控环境接受。
- 安装器替换目标二进制时不中断运行中的 omp：Linux 用同目录原子 `mv`；Windows 先把旧 `omp.exe` 重命名到唯一的 `.omp.old.*` 再换入（换入失败自动回滚），仅当重命名失败（如杀软锁定）才回退为按安装路径精确匹配强杀，`.omp.old.*` 残留由下次安装尽力清扫。Windows 的已验证下载在替换失败时保留为 `.omp.tmp.*`，包括旧安装已成功回滚的情况；回滚失败同时保留旧映像供恢复。
- Windows 下载成功后，校验、旧映像重命名/强杀回退、换入、回滚或 PATH 设置失败，MUST 打印失败阶段、原始错误、错误类型/代码、安装目标及可用的诊断日志路径，并输出正确引用路径的可执行 PowerShell 命令：未通过验证的二进制不能引导运行；已验证的保留下载可直接启动；旧映像恢复只在目标不存在时执行；重试固定本次 Release 与安装目录，最后核对目标文件及 PATH 命中的版本。二进制已换入但 PATH 设置失败时明确标为部分完成，不能提前报告安装成功。非致命清理失败须说明具体错误和安全重试命令；仍被旧会话占用的映像可留待会话退出后清理，不影响新版安装结果。详细错误仅向终端展示，落盘日志继续遵循脱敏契约。

- 模型筛选、可用性、角色解析和显式选择统一采用上游规则；各 fork 功能复用这些规则，不维护 fork 专有的模型硬排除契约。

## Fork 验证体系

本节是三层本地门禁的唯一需求位置；具体权限、命令与缓存纪律见 `AGENTS.md`「验证」「构建与缓存纪律」，验证状态见[需求目录](README.md)。门禁只复用现有检查、测试与编译原语，不改写上游质量定义、通过标准、产品行为或 CI 工作流。

| 入口 | 当前有效范围 | 非编译硬上限 |
| --- | --- | --- |
| `bun run fastcheck` | 静态分析、类型/格式检查和编译；无任何测试，包括冒烟、自测 | 90 秒 |
| `bun run fulltest` | 全部 fastcheck 检查 + 完整 fork 差异中的 TS 测试、现有 `test:rs --affected` 选择的 Rust 测试、仓库脚本测试、native 构建和隔离 dev-TUI 公开入口 E2E；无跨 WSL | 900 秒 |
| `bun run slowtest` | fulltest 一次 + 项目所需且现有兼容 WSL 可用时的 Linux 验证；无适用 WSL 时覆盖等于 fulltest | 1500 秒 |

- 三层均在一个单调累计时钟下计费，排除实际观测到的**纯编译区间之并集**；编译和非编译并行时重叠仍计费一次。发现、准备、下载、同步、非编译等待、汇总和清理计费；不能把混合检查/测试命令整段排除。嵌套阶段共享外层剩余额度，并保持更严格的内层上限。
- 到限主动终止本次拥有的进程树，非零退出并报告 `TIMEOUT`，不在阶段间重置时钟、不放宽上限。所有退出路径（成功、失败、缺工具、超时、中断、参数错误）都输出 status、total、compile_excluded、budgeted、limit 与退出码，秒至少一位小数；按 budgeted 而不是 total 判断到限。
- 首个检查、测试、编译或执行阶段失败后，立即停止调度并终止本次拥有的并行任务、嵌套运行器与进程树；嵌套运行器也按首个失败停止。保留触发失败、退出码和最终计时；未启动/被取消工作不算通过。WSL 发现/同步前置条件受阻仍完成可达本机 fulltest，实际 Linux 检查/测试失败则立即取消其他执行任务。
- 门禁的进程监督须在命令仍运行时回收已退出的孤儿后代，不得截获由运行器持有的主命令退出码；Windows 隔离临时目录的清理须能解除带拒绝读取 ACL 的目录 junction，且不得遍历或删除其目标。上述生命周期编排不能改变测试通过标准或把清理失败降级成通过。
- 独立且安全的检查/测试/Windows与WSL两端必须并行；改写共享生成文件的构建、打包或代码生成须先于其静态/测试读取者，避免共享文件竞争。编译项目必须保留正常增量缓存、固定同平台配置与路径；NEVER 在连续 fastcheck 之间清缓存、切换 target/profile/flags 或制造冷样本。Windows 与 WSL 使用各自稳定的原生缓存。
- fastcheck 仅在具体需要且相关修改批次完成后由 Agent 选择，不能逐文件保存即运行。fulltest/slowtest 需要本次用户明确运行授权，授权不跨任务延续；不能通过直接执行内部阶段绕过权限。新/改门禁入口脚本可直接执行显式限定到该文件的非测试静态检查，不得扩大到目录/仓库或执行测试、打包、跨 WSL。
- 三层 NEVER 调用或触发 CI/远端发布流水线、push、发布、部署、Computer Use、共享鼠标或抢前台焦点。既有独立 CI 保持原配置，发布不属于门禁。真实桌面输入测试保留并另行明确授权，记 `NOT_RUN_SEPARATE_USER_INSTRUCTION_REQUIRED`，不计为已通过；隔离的浏览器 DOM/协议、虚拟终端和 PTY 自动化可纳入本地测试。
- 本项目支持 Windows/Linux x64，Windows→WSL 验证显式选定 **Ubuntu-24.04 WSL2**，不能替换目标；未指定目标的一般项目才优先合适的已安装 CentOS。无 WSL/无兼容发行版记 `SKIPPED_WSL_UNAVAILABLE`，项目不需要则 `SKIPPED_NOT_APPLICABLE`，此时 slowtest 覆盖等于 fulltest。已选择 WSL 后的同步、脏源码、工具或执行失败须 BLOCKED/UNVERIFIED/FAIL，不能降级成跳过；前置条件受阻仍完成可达的本机 fulltest 一次。不自动安装 WSL、发行版或缺失测试工具。
- WSL 通过 `scripts/slowtest-wsl-stage.ts` 在 slowtest 内执行，源码只能经 **Windows → Git 网络远端 → root 身份的原生 `/root` 工作区** 同步并测试完整固定 SHA。禁止本地快照、bundle、复制、rsync、patch、stdin 传源码、本地 remote 及 `/mnt/*` 工作区；stdin/stdout 仅承载调度计划/参数与日志。门禁没有 commit/push/stash 授权：源码未提交或未推送须阻塞 WSL，不能测试旧提交代表当前改动。既有固定提交同步 helper 的 plan 保留远端身份、fetch/固定 SHA 可达性、快进、工作区与子模块保护、未跟踪残留隔离和测试后状态检查；流式执行计划并观测嵌套 fulltest 的纯编译事件，无法可靠计时则 UNVERIFIED，不能整段豁免混合命令。helper 的 3600 秒墙钟防挂另行报告，外层累计非编译上限仍为 1500 秒。记录两端 HEAD、本机源码指纹、工作树、Linux 工具路径与版本；不同提交不得合并 PASS。取消只处理本次拥有的资源，不关闭发行版、不删除用户改动、残留证据或有效编译缓存。
- WSL 原生仓库发现使用 slowtest 的累计非编译额度，不另设 25/30 秒的提前截止；宿主与 Linux 仍有有限防挂，外层累计时钟、取消与用户下调额度始终优先。完整发现须保留嵌套工作区与多匹配拒绝语义，不通过缩小遍历范围规避超时。
- 按维护者明确要求沿用原有 fork 改动相关范围，不自动扩大到全仓库测试。比较基准为本页记录的 Upstream commit，纳入全部已提交、未提交及未跟踪差异；TS 沿用存在的差异测试文件集合，Rust 沿用现有 `test:rs --affected` 的 crate/vendor 消费者选择，不新增手工白名单，不排除该集合内失败项。保留现有 TS/Rust 静态检查、仓库脚本测试、native 构建和 dev-TUI 集成边界；Python、独立 Go/Python/Rust SDK、无关 workspace 打包、完整上游 TS 套件不在此门禁范围，原有独立入口保留。三层及 WSL 继承同一范围，报告 `scope=fork-affected`、基线、选择依据和上述未测覆盖；不得把该范围的 PASS 表述为全仓库 PASS。非编译预算、缓存、计时及失败标准不因范围选择改变。
- 环境/工具缺失、平台不适用和检查失败须分别说明，不把缺失或跳过当通过。既有 Windows 上游 sed 用例过滤及其他测试适配不在本次门禁编排中改写；未运行的实际模型质量、公司内网、独立发布和桌面输入不属于本地 PASS 的证明。
- 门禁机制自测在临时目录中用短任务覆盖成功/失败/缺工具/超时/中断、进程树清理、编译排除与重叠计费、累计与下调预算、并行、缓存保留、包含关系、适用 WSL 和禁止外部操作；自测不是 fastcheck 的阶段，也不能代替真实三层入口执行。

