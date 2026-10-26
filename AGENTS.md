# Fork 维护规则

本仓库 fork 自 `can1357/oh-my-pi`，是仅供个人使用的 fork 维护仓库，不以对外发布为目标。以近乎每日合并上游最新 `main` 为维护节奏，保持 OMP 核心持续跟进上游。两种使用场景与零配置目标统一见 [Fork 需求：项目定位与使用场景](openspec/specs/fork-product-scope/spec.md)。

## 项目概况

- `omp` 是终端编码代理 CLI：TypeScript（Bun）为主体，Rust（`crates/`，cargo / bazel）提供 native 能力，另有 Python（`python/robomp`、`sdk/python/omp-rpc`）组件。
- 本仓库完全由 AI Agent 实现和维护：改动是否正确不能依赖用户手工读代码或人工回归来保证，MUST 依靠可复现的自动化验证，以及本文件（开发与维护规则）、`openspec/specs/fork-product-scope/spec.md`（需求契约）中的明确约定。
- 本仓库禁用全部 Git 钩子，NEVER 在安装、开发或上游同步中恢复。提交与推送不自动运行检查；验证仅按任务授权从既有入口手动执行，契约见 [Git 钩子](openspec/specs/fork-maintenance/spec.md)。

## 主要入口

关键目录（不是完整清单）：

- `packages/coding-agent/`：主 CLI（`omp`）实现，日常改动的主要目标。
- `packages/ai`、`packages/catalog`、`packages/agent`、`packages/tui`、`packages/natives`、`packages/utils`，以及 `packages/omptype`、`packages/stats`、`packages/wire`、`packages/mnemopi`、`packages/snapcompact`、`packages/collab-web`：模型接入、模型目录、agent 运行时、TUI、native 绑定与共享库。
- `crates/`：Rust native 与系统能力（`pi-natives`、`pi-shell`、`pi-vcs`、`pi-edit`、`pi-builtins`、`pi-ast`、`pi-walker` 等）。
- `scripts/`：仓库脚本与 fork 工具（`fastcheck` / `fulltest` / `slowtest` 验证入口、`install.sh` / `install.ps1`、`ci-test-ts.ts`、`run-rs-task.ts`）。
- `docs/`：上游英文文档（fork 不维护英文站点，也不为其提供构建或 `/en/` 子路径合并）；`docs-zh-CN/`：仅含 fork 自有的指南、架构与工程说明、历史验收记录及 `README.upstream.md` 对照快照；批准需求见 `openspec/specs/`，不维护翻译或文档站点（见「中文文档」一节）。
- `jch-upstream-sync`：由 JCH 仓库 `skills/jch-upstream-sync/` 统一维护和分发的通用混合型上游同步 Skill；Agent 负责需求与冲突判断，部署脚本统一承载 Git 写操作。本仓库专属参数见「上游与分支」，不维护技能副本。

子目录 `AGENTS.md` 注册表（全仓库仅此一个，上限 8 个）：

- `python/robomp/AGENTS.md`：robomp 子树（GitHub triage/fix bot）的开发规则与命令参考，上游自带并随上游维护，fork 不修改。

核心代码入口：

- CLI 链路：`packages/coding-agent/src/cli.ts` → `src/main.ts` → `src/sdk.ts`。
- fork 自有实现：`src/jch-commands/`（`/jch*` 命令）、`src/config/company-provider.ts` 与 `company-models.ts`、`src/docs/` 与 `src/tools/wiki.ts`（文档索引）、`src/modes/magic-keywords.ts`（含 fullsend 关键词）、`src/goals/` 与 `src/prompts/goals/`（`/goal-autopilot` 无人值守编排，需求见 `openspec/specs/goal-autopilot/spec.md`）、`src/modes/zcode/hosts/`（命令宿主：plan／loop／goal、命令目录与补全、role 持久保存，由 app-server 命令链路同进程调用）。`src/modes/rpc/` 与上游保持逐字一致，fork 不修改、不使用。ZCode app-server 的独立协议目录、同进程 AgentSession API 调用、多会话隔离、存储准备及完整交付契约见 `openspec/specs/zcode-app-server/spec.md`；不提前登记尚未实现的源码入口。
- ZCode app-server：`src/modes/zcode/index.ts` 注册独立 stdio 入口，`server.ts` 路由公开协议，`sessions.ts` 直接组合同进程 AgentSession，`projection.ts`／`topics.ts` 管理可重建投影与订阅，`storage.ts` 生产真实存储准备事实；`spec-driven.ts` 观察同一个原生 `/dev` 控制器，以显式协商的 `schema/omp-spec-extension.ts` 提供运行、输入模式、消息、完整材料与共用动作事实，操作仍走既有原生命令，历史只读且不恢复批准或执行。桌面 UI 不在本轮实现；完整功能与验收仍以 `openspec/specs/zcode-app-server/spec.md` 为准。
- 协同开发模式：`src/spec-driven/controller.ts` 独占 `/dev` 输入模式、草稿、消息归属与共用动作；`orchestrator.ts` 管理四阶段、文件版本与用户决定；`runtime.ts`／`actors.ts` 管理需求／方案／计划／执行四个 SDK 会话；`artifacts.ts` 读取真实文件并检查最低格式。每步文件有效仅进入待决定，缺失或格式不符仍停当前阶段。切阶段直接传完整原文件和用户原始回复，方案到计划还传所选候选 ID，不调用模型总结，不生成交接、确认或任务状态文件。单能力只需五个正式文件：OpenSpec 原 proposal／spec，及同放 `docs/superpowers/plans/` 的 `YYYY-MM-DD-<change>.md` 原格式计划、同 stem 的 `-solutions.json` 和 `-completion.md`。验收后原生同步归档仅处理需求，执行材料原地保留。不建立逐任务／TDD／审查证据引擎、固定审查配额或强制 commit；方案可选 Team、执行可选会话内原生 Goal，不增加阶段或审批。权威需求见 `openspec/specs/spec-driven-orchestration/spec.md`。
- `/dev confirm-spec [--team] [确认说明...]`、`/dev choose <candidate-id> [确认说明...]`、`/dev confirm-plan [--goal] [确认说明...]`、`/dev accept` 分别作出四次明确决定；文件摘要仍由程序核对，不要求用户传版本参数。Team／Goal 在原确认面板勾选或以命令参数启用，默认关闭、只对本次运行有效、提交后不热切换；Team 成员复用既有配置，Goal 只在执行 Agent 会话内采用完整获批计划为目标。`/dev revise-plan <说明...>` 保留未变的已批准上游、撤销计划批准与旧验收，重新生成计划后待批准，不自动实施。`/dev repair <说明...>` 才从待验收恢复获批范围内写入。完成报告固定 `# 完成报告` 及非空 `## 完成情况`／`## 验证结果`／`## 未完成项`；报告存在不证明软件正确，实际工程验证由执行 Agent 按计划和项目规则负责。取消、暂停、消息结清、迟到结果隔离与 runtime 释放仍属本次 owner，未真实释放不允许新 start 接管；不提供跨进程恢复。
- `/dev help` 在 TUI 打开当前阶段决策面板，澄清与回答同屏、完整方案／计划／报告可读；动作分当前决策／材料／管理，批准阶段安全初选查看材料。启动先填需求并提供可编辑的自动 change ID；未启动、完成、取消显示真实状态。已启动流程等待澄清／决定、暂停或受阻时自动打开同一面板，同轮关闭不重弹，已有对话框结束后再显示，保留草稿及附件；不自动批准、不切换模式。自动输出去重，显式详情与 status 保留完整命令、材料和诊断，ZCode 投影同一原生事实；中文按键及 ANSI／native 120×36、100×28 可达性要求不变。
- 独立 OpenSpec 的六项 `opsx-*` 由 `src/discovery/spec-driven.ts` 随 Superpowers／JCH 技能提供；当前会话工作目录直接含 `openspec/` 目录时将名称与中文描述纳入模型索引，正文按需读取，不向父目录查找，其他目录保留 `/skill:opsx-*` 手动入口。目录变化后重载或新建会话。propose 新建需求，update 修订补齐；包内 `omp openspec ...`、原生 schema、校验／同步／归档引擎独立闭环，不依赖 `/dev` 状态或批准。Superpowers 原技能及 `omp superpowers <相对脚本> ...` 入口不变，不因简化 `/dev` 重写其方法或模板。
- 普通会话保留全部包内 Superpowers 的 `/skill:<name>` 手动入口（含 `writing-plans`、`executing-plans`），可在独立 OpenSpec 更新需求后写计划和实施；只有调试、完成验证、技能编写三项进入默认模型索引，其余技能仅手动补全和调用。`/dev` 的阶段权限及受控资源授权不变；发现范围契约见 `openspec/specs/spec-driven-orchestration/spec.md`。
- 输入法恢复：`/jchime [故障现象]` 在 `src/jch-commands/workflow.ts` 注册，复用提示词命令工厂；`src/prompts/jch-ime.md` 提供完整小模型首选恢复块及失败后同用户/同 DISPLAY 的自主诊断、有限停止与重建步骤。契约见 `openspec/specs/personal-commands/spec.md`「JCH 命令」；服务状态与真实中文输入恢复分别核验。
- 命令宿主复用同一 slash 注册表：索引对话在 `src/slash-commands/helpers/index-dashboard.ts`，计划／循环／目标宿主位于 `src/modes/zcode/hosts/`（plan-host／loop-host／goal-host），命令目录与 role 保存在同目录（command-catalog、model-roles），由 app-server 命令链路调用，不另建命令表。
- TUI 显示模式：`/display [clean|compact|detailed]` 复用既有设置，默认紧凑；三档显示及验收以 `openspec/specs/tui-presentation/spec.md` 为准。命令沿用现有 slash 注册表，渲染在 `packages/tui/src/chat/`。

常用命令（工作目录为仓库根；下表受支持的检查、类型、构建与测试 root scripts 默认经 Bazel 执行，三层入口不变；支持列表与缓存边界以 `openspec/specs/fork-verification-gates/spec.md`「Fork 验证体系」为准。本文档不声称已在当前机器执行过；能否运行受「验证」一节限制）：

| 目的                                                                                                                                                                           | 入口                                                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 安装依赖                                                                                                                                                                       | `bun install`（`bun run setup` 会继续构建 native addon 并链接 `omp`）                                                                                                                               |
| 运行 CLI（源码）                                                                                                                                                               | `bun run dev`                                                                                                                                                                                       |
| ZCode app-server（源码，由 Host 监督 stdio）                                                                                                                                   | `bun run dev app-server --stdio --surface desktop --cwd <绝对目录>`                                                                                                                                 |
| 协同开发模式与包内能力 | OMP 输入框 `/dev` 切换模式、`/dev help` 打开阶段决策面板；显式 `/dev start <change-id> <需求...>`，`/dev confirm-spec`、`/dev choose <candidate-id> [确认说明...]`、`/dev confirm-plan`、`/dev accept` 逐步决定，`/dev status` 获取完整诊断；当前目录直接含 `openspec/` 时六项独立 OpenSpec 技能可按自然语言发现，任意目录保留 `/skill:opsx-*` 手动入口；终端 `omp openspec <原生参数...>`、`omp superpowers <相对脚本> [参数...]` |
| 类型检查 + lint（workspace 门禁）                                                                                                                                              | `bun run check:ts`                                                                                                                                                                                  |
| 仅静态检查（oxlint / oxfmt）                                                                                                                                                   | `bun run check:tools`                                                                                                                                                                               |
| 只读 lint（默认经同一 Bazel 适配器；`lint:tools`／`lint:ts` 可缓存，`lint:rs` 及聚合 `lint` 每轮真实执行）                                                                     | `bun run lint`、`lint:ts`、`lint:tools`、`lint:rs`；写源码的 `fmt`／`fix` 族不接管，仍用原入口                                                                                                      |
| fork 静态门禁（沿用现有 TS 与 Rust 静态/编译检查；非编译预算 180 秒）                                                                                                           | `bun run fastcheck`                                                                                                                                                                                 |
| TypeScript 测试                                                                                                                                                                | `bun run test:ts`；分片 `ci:test:ts:workspace`、`ci:test:ts:native`、`ci:test:coding-agent:{singleton,ui,runtime,native,heavy}`                                                                     |
| Rust 检查 / 测试 / lint / 格式                                                                                                                                                 | `bun run check:rs`、`test:rs`、`lint:rs`、`fmt:rs`（经 `scripts/run-rs-task.ts`，测试走 `cargo nextest`）                                                                                           |
| Python 测试                                                                                                                                                                    | `bun run test:py`                                                                                                                                                                                   |
| 独立 SDK 计时测试                                                                                                                                                              | `bun run sdk:test:go`、`bun run sdk:test:go:smoke`、`bun run sdk:test:rust`（需相应工具链；不属于 fork-affected 门禁）                                                                              |
| 仓库脚本测试                                                                                                                                                                   | `bun run test:scripts`                                                                                                                                                                              |
| 端到端冒烟（真实 CLI 公开入口）                                                                                                                                                | `bun run ci:test:smoke`                                                                                                                                                                             |
| 安装器端到端                                                                                                                                                                   | `bun run ci:test:install-methods`                                                                                                                                                                   |
| 当前平台 fork 本地门禁（全部 fastcheck 检查 + fork TS 测试、受影响 Rust 测试、脚本测试〔不含重型 Bazel 集成测试〕、native 构建及隔离 TUI 冒烟；非编译与总墙钟上限均为 900 秒） | `bun run fulltest`                                                                                                                                                                                  |
| 本机 fulltest + 宿主重型 Bazel 集成测试一次 + 可用的项目所需 WSL fulltest（WSL 不跑重型 Bazel 集成测试；不推送、不触发 CI；非编译与总墙钟上限均为 1500 秒）                    | `bun run slowtest`                                                                                                                                                                                  |
| 测试计时报告                                                                                                                                                                   | 已运行的测试在被忽略的 `runs/test-timing/<run-id>/` 中记录 JUnit XML、producer 元数据及 `run.json`；范围与时间口径见 `openspec/specs/fork-verification-gates/spec.md`「Fork 验证体系」                             |
| 构建                                                                                                                                                                           | `bun run build`（workspace 包）、`bun run build:native`（native addon）                                                                                                                             |
| 显式选择独立公开 Bazel 任务（普通受支持 root scripts 已默认路由；不扩展 fulltest）                                                                                             | `bun run bazel -- <existing-task> [task arguments]`，例如 `check:ts`、`build:native`、`test:py`、`sdk:test:go`；支持列表、原命令语义与缓存边界见 `openspec/specs/fork-verification-gates/spec.md`「Fork 验证体系」 |
| 启动独立 profile（fork 新增 `-P`，无需 shell alias）                                                                                                                           | `omp -P <name>`（等同 `omp --profile <name>`）                                                                                                                                                      |
| 导出代码审查材料（内置命令）                                                                                                                                                   | `/code-review-export`，参数与交互同 `/review`；固定导出到仓库根 `.tmp/review-bundle.zip`，契约见 [代码审查材料导出需求](openspec/specs/code-review-export/spec.md)                              |

## 开发约束

- 平台：日常在 Windows x64（PowerShell）上工作，同时支持 Linux x64 与 WSL2；本地验证只在当前操作系统运行对应测试。
- 工具链版本跟随上游固定，不在 fork 内单独升级：Bun `>=1.4`（`package.json` 的 `packageManager`）、Rust `nightly-2026-10-06`（`rust-toolchain.toml`）、Bazel `9.2.0`（`.bazelversion`）。
- 上游开发约定（代码质量、Bun 优先、prompt 放 `.md`、模型/Provider 策略在 KDL、生成文件与 changelog 规则等）同样适用于 fork 改动，但不在本文件重复：以 `openspec/specs/fork-upstream-baseline/spec.md` 记录的 Upstream commit 为准，用 `git show <upstream-commit>:AGENTS.md` 读取。fork 改动 MUST 与上游既有风格和机制一致，不引入局部风格。

## 权威来源与文档职责

本仓库是持续同步上游的 Fork（同步来源与分支约定见「上游与分支」），文档职责如下：

- `AGENTS.md`：本仓库的维护原则与 agent 规则。
- JCH 的 `jch-upstream-sync` Skill：每日定时同步或手动同步上游的通用流程及 Git 执行脚本；本仓库的来源、镜像、基线记录与验证限制由本文件维护。调用入口统一使用新名称，不保留旧名称别名或平行实现。
- `openspec/specs/`：本仓库唯一已批准的 fork 差异需求基线，仅记录相对当前上游仍有效的本地特性、修复、默认值及明确规划，按能力域维护行为、约束和验收场景。未修改的纯上游需求不记录；本地特性或修复已由上游等价提供后，删除对应需求及当前差异说明，不保留“由上游满足”的占位条目。`openspec/changes/` 仅保存尚未批准的本地需求提案与增量。上游基线元数据见 `fork-upstream-baseline`，桌面接入见 `zcode-app-server`。

同步 MUST 保留 `AGENTS.md`、整个 `openspec/`、`docs-zh-CN/quick-start-intranet.md` 和根 `README.md` 的 fork 版本，NEVER 用上游版本覆盖；按实际变化维护内容（README 的更新方式见下节）。共享 Skill 不随本仓库同步改写。

## README 与上游同步

- 仓库根 `README.md` 是上游 README 的**中文版**，内容跟随上游：上游改了正文，同步时把对应段落重译进 `README.md`。
- `docs-zh-CN/README.upstream.md` 是最近一次合入的上游 README 英文快照，只作对照稿源，不对外；同步时用本次 fetch 的上游 README 与快照比较，先更新快照，再据差异改中文正文（上游 README 未变则不动）。merge 或恢复过程改动了根 `README.md` 时，提交前按快照复核正文。
- `README.md` 的 Install / 下载段是 fork 专有内容（fork release 链接、`install.sh --binary`、`install.ps1 -Binary`、`+fork.N` 版本说明、平台支持声明），NEVER 采用上游的 npm / Homebrew / Nix / mise / `omp.sh` 写法；中文翻译照此段本身翻译。
- 除下载段与「提示词控制」中 fork 新增的 `fullsend` 条目外，`README.md` 不保留 fork 专有内容：其余正文以当前上游快照为准。

## 开发与差异记录

- 修改前 MUST 按功能域阅读 `openspec/specs/` 中相关已批准规格及适用的待定变更；跨域约束按引用补读，不一次性加载全部规格。权威体系缺失时先查明，再修改实现。
- 在完整满足需求、保证正确性并遵循上游机制的前提下，fork 业务代码改动 MUST 最小、集中、内聚，控制相对上游的差异规模，降低高频合并的冲突与维护成本；不做无关重构，不为覆盖率或惯例添加测试。
- fork 新增功能 SHOULD 优先写入对应的上游已有文件并接入现有执行链路，让上游变化尽早在合并中暴露需要处理的适配问题；MUST NOT 为规避合并冲突而另建一套平行业务实现。确需新增文件时，须有明确的职责或上游结构依据，并核对其注册与调用入口，避免文件保留但功能已脱离执行链路而静默失效；无 Git 冲突不能作为功能仍有效的依据。
- 新增、修改或取消已批准需求时 MUST 同步维护对应 `openspec/specs/<capability>/spec.md`；尚未批准的提议只放在 `openspec/changes/` 的原生 proposal 与 delta spec。每条需求只有一个权威位置，跨域用引用表达；已批准但未实现的目标仍在基线，不按代码现状删减。
- 成功合入上游时 MUST 更新 `openspec/specs/fork-upstream-baseline/spec.md` 基线，并逐域对照源码确认仍有效的 fork 差异。上游等价提供本地特性或修复后，MUST 删除对应需求和当前差异说明，不记录已吸收的功能或修复清单；部分吸收时只保留剩余本地差异。
- 规格仅维护当前有效的目标、行为和验收条件，不追加修复或同步历史，不建第二份差异清单。
- `fork-upstream-baseline/spec.md` 的 `## 当前上游基线` 是 Release CI 的机器可读输入：该节 MUST 保留唯一一行以 `* **版本**：` 或 `- **版本**：` 开头、值为反引号包裹的 `v数字.数字.数字` 的条目；改标题、改格式或增加第二个版本行会让 Release 在 `release_metadata` 阶段失败。
- 需求或预期用户可见行为变化时 MUST 检查并同步对应原生规格；仅实现方式变化且需求不变时，不制造需求变更，也不得改写需求来合理化实现缺陷。入口、命令或开发规则变化时同步更新本文件。
- 优先采用上游最新实现。冲突很大时，可在上游实现上重写 fork 功能，不必保留旧代码；无法可靠保留功能时 MUST 中止同步，不能静默丢弃。
- 已获授权的同步先保全本地改动与整个 `openspec/`，优先可靠合并；重建限于相关冲突部分，不能丢弃无关改动、覆盖唯一需求依据或重置整个仓库。重建后须通过相应 UT 与真实入口 E2E；现有同步规则未授权这些验证时，应报告未验证并中止，不能宣称重建或同步完成。

## 上游与分支

- 唯一同步来源：`https://github.com/can1357/oh-my-pi.git` 的 `refs/heads/main` HEAD；NEVER 使用 Release、tag、其他分支、`origin/main` 或配置型 `upstream/main` 代替。
- fork 身份固定为 `jchanghong023/oh-my-pi`；同步使用 `origin`，其有效 fetch/push URL 必须均匹配该身份，不满足则停止。
- `main`：上游代码与个人改动的集成分支。
- `upstream`：最近成功合入的上游 `main` 的精确镜像，不含 fork commit；GitHub 上用于 PR/差异比较（base 为 `upstream`，compare 为 `main`）。
- 已集成基线以本仓库自有的本地 `upstream` 和远端 `origin/upstream` 分支为准；本地 `main:openspec/specs/fork-upstream-baseline/spec.md` 是基线文档，`Upstream commit` 必须唯一、有效并与已集成状态一致，分支或文档矛盾时先查明，不盲目推进。成功集成时在同一提交更新完整 SHA、UTC 同步日期和当前功能差异，保留 `can1357/oh-my-pi@main`；版本取本次上游目标的 `packages/coding-agent/package.json`，保持现有机器可读格式，不追加历史或第二份清单。
- 本仓库明确授权同步流程只推送 fork 的 `refs/heads/upstream` 镜像，使用实际远端 SHA 的精确 lease；本地 `upstream` 跟踪 `origin/upstream`，三者须指向同一已成功集成的上游 SHA，不指向 fork 集成提交。镜像失败保留已验证的本地集成，下次仅修复镜像。
- 同步请求包含完成该次集成所需的本地提交授权；提交采用 `sync(upstream): merge main@<目标前12位>`，以命令级设置禁用 hooks/签名，避免隐式重型任务，不改用户全局 Git 配置。
- 同步 MUST 遵循 Skill 的门禁、集成、验证、镜像与中止流程；Git 写操作统一通过已部署技能的受限脚本会话执行，不在 Agent 外部命令中绕过检查。NEVER 接受上游历史改写。
- 同步只完成本地 `main` 集成与 `upstream` 镜像，不自动推送 `main`；本地完成不代表 GitHub 已可比较最新 fork 差异，后者取决于远端 `main` 是否另行更新。

## 测试与验证要求

- 功能性开发和功能性修改 MUST 有自动化验证：UT 验证局部逻辑，E2E 从真实公开入口跑到可观察结果（本仓库已有 `bun run ci:test:smoke`、`bun run ci:test:install-methods`，UI 冒烟并入 `bun run fulltest`），跨模块交互按需要增加集成测试；已有有效覆盖可以复用，不要求为每处修改机械新增测试。
- TUI 改动需要新增或临时交互验证时，默认 MUST 使用 `bun run dev` + `tui-test` + 本地模拟模型：由 `tui-test` 启动并操作当前源码的真实 CLI，需要模型响应时连接隔离的本地模拟服务。NEVER 为每次改动另写直接驱动 PTY、解析 ANSI 输出的测试脚本，也不为普通 TUI 验证额外编译 exe。已有 fulltest PTY 冒烟保留，不因本规则迁移或重复实现；已有有效证据足够时不追加验证。`tui-test` 不操作共享桌面，不属于 Computer Use；本规则不扩大 fulltest/slowtest、构建或真实模型调用的运行授权。
- `tui-test` 用法：首次使用先运行 `tui-test skill` 阅读当前安装版本的使用指南，再通过 `tui-test --help` 或相关子命令的 `--help` 确认当前接口；需要完整命令结构时使用 `tui-test agent-context`。以唯一 `--session` 启动，显式指定 `--cwd`、`--cols` 和 `--rows`。默认启动示例：`tui-test --session <name> run --cwd <repo> --cols 120 --rows 36 -- bun run dev <args...>`；`--` 将程序参数与 tui-test 参数隔开，模型及隔离配置须按下文要求设置。只有用户明确要求验证 exe 或打包产物时，才改为直接传入已确认的当前构建产物绝对路径，不能用源码运行结果代替 exe 验证。
- 使用 `key press Ctrl+T`、`type`、`submit`、`resize` 等命令交互，用 `expect text` 等断言等待可观察结果；`wait idle` 只表示画面暂时稳定，不能代替业务完成断言。需要时用 `text`、`state`、`screenshot` 留存证据，分别核对每条命令的失败与进程退出状态，结束后仅关闭本次自有 session。工具缺失时如实报告，不自动安装或改写 PTY 脚本绕过。
- TUI 验证中需要模型响应的对话、流式回复、思考和工具显示等场景，默认 MUST 使用本地模拟模型服务和隔离配置，并在发送消息前确认当前模型及请求目标确为本地模拟服务；无需模型响应的界面操作不要求启动模拟服务。用户仅要求“测试对话”“测试 TUI”或“测试基本功能”不构成真实模型调用授权。只有用户明确要求测试真实模型，或明确要求验证指定提供者的连通性、认证时，才 MAY 在其授权范围内调用真实服务；已有默认模型、登录信息或可用额度不能代替该授权。模拟服务不可用或配置失败时 MUST 报告阻塞，NEVER 自动回退到真实模型。模拟测试中的工具可真实执行，但仍须遵守本次任务的操作范围；模拟响应不能作为真实模型能力或提供者认证的验收证据。
- UT、编译、静态检查和局部模拟 MUST NOT 替代 E2E；桩与模拟可用于补充测试，但未经真实边界验证的部分 MUST 说明，不能把局部模拟冒充端到端验证。
- 测试 MUST 对应相关 OpenSpec 规格的需求与验收场景，覆盖核心成功路径和关键失败路径；不得只复述实现，也不得只验证「没有崩溃」。
- 状态 MUST 区分「已实现」「验证通过」「验证失败」「未验证」；环境、依赖或权限不足时说明未验证范围，NEVER 声称功能已验收。
- 缺少 UT 或 E2E 时 MUST 如实写明缺口与后续要求，不编造命令、不降低标准；纯文档等非功能性变更按实际影响验证，不强制运行无关的完整测试。
- 测试失败后 MUST 先对比当前上游基线，区分 fork 改动与上游原样代码导致的失败。上游代码导致的失败默认只报告，NEVER 为使门禁转绿自动修复；只有用户明确要求修复，或已有真实入口证据确认是影响核心功能的业务代码缺陷时，才 MAY 最小修复。单独的测试失败不构成核心功能受损的证据。
- `/jch-workflowzbatch` 发起的批处理采用 [JCH 命令规格](openspec/specs/personal-commands/spec.md) 中的调用级验证例外；仅适用于该批处理，命令本身的实现维护及其他开发仍遵循本节。

现状与缺口（2026-10-07 依据仓库内容整理；当日精简会话运行的验证以各功能域记录为准）：

- fork 功能多数随改动附带自动化测试，例如 `packages/coding-agent/test/` 下的 `wiki-tool`、`docs-index`、`modes/fullsend`、`slash-commands/jch-git`、`slash-commands/magic-keywords`、`company-provider`、`cli-offline-flag`、`modes/zcode`（hosts 宿主），以及 `scripts/fulltest.test.ts`、`scripts/slowtest.test.ts`、`scripts/test-gate-runtime.test.ts`、`scripts/slowtest-wsl-stage.test.ts`、`scripts/install-tests/fork-installer-routing.test.ts`。按维护者明确要求，标准门禁沿用既有 fork 范围，完整范围与未覆盖项以 `openspec/specs/fork-verification-gates/spec.md`「Fork 验证体系」为准，不自动扩大到 Python、独立 SDK 或全部 workspace 打包。
- fork 的 `.github/workflows/ci.yml` 只有手动 `workflow_dispatch` 触发（没有 push / pull_request 触发器），永久只构建和发布，不运行测试、冒烟、lint、类型检查或独立校验作业。该独立发布流程保持不变，但 NEVER 由 fastcheck/fulltest/slowtest 推送、触发或监控；直接运行 CI 不代表本地验证通过。
- 标准 fulltest 必须包含 fastcheck 的全部检查。现有 `test:rs` 在 Windows 过滤上游确定性失败的 `pi-builtins sed::fast_io::tests::test_file_truncated_after_open`，Linux 不过滤；该既有测试定义在门禁迁移中不改写，不能据此声称该用例已通过。上游带入的格式差异与 Linux 会话隔离测试的既有适配仍按相应源码注释维护；门禁迁移不改变其检查定义、产品行为或通过标准。
- 未执行的门禁与因工具/环境受阻的验证均须如实记录为未验证；运行授权本身不是通过证据，不能报告未运行的检查已通过或功能已验收。

## 构建与缓存纪律

- NEVER 无理由 `cargo clean`，NEVER 删除当前有效的 `target` 目录：构建缓存属于项目资产，清理必须有具体理由（缓存损坏、废弃配置清理等），定点进行并说明范围。
- 保持同一平台的构建配置与 `target` 目录稳定：不为提速切换 profile / target 目录 / `RUSTFLAGS` 等配置变体；fastcheck/fulltest 与日常开发 MUST 复用正常增量缓存，NEVER 在连续 fastcheck 之间清缓存、强制全量重建或切换缓存变体。只为 Windows/WSL 平台隔离使用各自稳定的原生缓存；编译计时包装器固定在仓库原生 `node_modules/.cache/omp-gate-wrappers/<platform>-<arch>`，不随隔离 HOME/TMPDIR、源码哈希或每轮运行改变入口路径，源码及编译器更新只原地刷新必要资产，保留已有缓存包装器、features 与 flags。自然冷启动可记录，不能清缓存制造冷样本。
- Rust 静态检查和测试复用仓库根稳定的 `target/`、既有 dev/test profile、features 与 flags；native host 构建复用既有 Cargo/N-API 路径，使用 Bazel 的既有构建复用其缓存和配置，不为计时切换缓存变体。
- 三层门禁 MUST 通过 Bazel 的真实文件依赖与成功结果缓存复用既有检查原语；Bazel 已提供的摘要、传递依赖、增量判定、任务并发、结果缓存和测试产物管理 MUST 直接复用，NEVER 保留项目平行实现。同平台、同语义的 action/test 配置跨层稳定，不用 HEAD、随机运行 ID 或临时报告路径使缓存失效。每轮选择完整必需目标，报告实际执行、有效缓存命中及未完成目标；无法可靠表达的外部依赖或副作用目标须禁用结果复用并说明。缓存命中不等于本轮执行，原生 BEP／执行日志／测试产物为证据，不重放旧用例冒充新执行。
- 公开任务的 stock Bazel 规则、原生文件监听与摘要缓存、扫描排除、规则图精简及独立适配器契约 MUST 以 `openspec/specs/fork-verification-gates/spec.md`「Fork 验证体系」为唯一需求来源；NEVER 将独立任务可达性当作 fulltest 覆盖或未闭合外部环境的缓存有效性证据。
- Bazel 的版本、`output_base`、启动参数与配置来源 MUST 稳定；任意结果（含成功、失败、超时、中断及宿主断连）均 NEVER 主动终止 Server，亦不得借 fixture 清理、Job／subreaper 或进程树回收误杀 JVM。失败、超时、中断及断连仍 MUST 仅取消本轮自有 invocation/actions，保留其他 Agent 作业；普通自有进程清理与失败即停继续生效，Server 生命周期边界统一遵守 `openspec/specs/fork-verification-gates/spec.md`「Fork 验证体系」。共享工作区准备与运行上下文 MUST 防串扰，锁等待计入原预算。
- 性能优化 MUST 先通过 `openspec/specs/fork-verification-gates/spec.md`「Fork 验证体系」的无改动双轮验收，再处理编辑后的增量运行；每轮只修一处有时间证据的瓶颈。MUST 保留外层墙钟、显式 profile 与 BEP，区分锁等待、加载／分析、实际动作、测试缓存与脚本开销；缺证标为待定位，NEVER 把诊断 probe 当作真实 `bazel test` 验收。
- 最终打包 / 发布 profile 的构建（native addon 打包、release 构建等）NEVER 进入 `fastcheck`；三层内仅可出现在 `fulltest` / `slowtest` 的既有范围，门禁外独立构建仍遵守原授权。

## 验证

- 三层语义固定，复用现有本地检查定义、通过标准与运行器，不为门禁改写上游质量规则。`bun run fastcheck` 沿用现有 TS 与 Rust 静态、类型/格式检查及编译，NEVER 执行任何测试（含冒烟或门禁自测）；`bun run fulltest` 包含全部 fastcheck 检查及声明的 fork 范围内测试、native 构建与隔离 TUI 公开入口 E2E；`bun run slowtest` 包含 fulltest 一次、宿主重型 Bazel 集成测试一次，并可增加 WSL/Linux fulltest。具体测试分层见 `openspec/specs/fork-verification-gates/spec.md`「Fork 验证体系」。fulltest NEVER 启动另一操作系统；除适用 WSL 外，slowtest 不增加 VM、容器模拟或远端机器验证。
- 非编译硬上限分别为 fastcheck **180 秒**、fulltest **900 秒**、slowtest **1500 秒**，排除真实观测到的纯编译区间之并集，混合命令不整段排除。fulltest/slowtest 还 MUST 遵守 **900/1500 秒总墙钟硬上限**，包含编译、准备、同步、等待、汇总与清理；独立看门狗 MUST 能在主线程同步阻塞时强退。嵌套门禁共享外层剩余额度，保留更严格内层上限。NEVER 放宽或重置时限；`--limit-seconds=<N>` 同时下调两种上限。具体计费及退出契约见需求文档「Fork 验证体系」。
- 每次入口运行在成功、失败、缺工具、超时、中断及参数错误的最终路径均输出 status、total、compile_excluded、budgeted、limit（秒，至少一位小数）及退出码。独立且安全的检查、测试与 Windows/WSL 两端 MUST 并行；生成或改写共享文件的阶段须排在读取它们的检查之前，不能让并发读取部分生成结果。
- 门禁仅按工程风险选择就绪目标的优先批次：门禁编排、共享接口、状态/并发与平台边界优先；批次内的依赖与安全并发由 Bazel 原生调度。MUST 记录风险依据、批次及原生执行日志，不仅排序命令标签，也不另建任务许可队列；风险元数据不进入 action 输入。
- 首个实际用例、检查、编译、执行、前置准备或结果核验失败时，fulltest/slowtest MUST 立即非零退出并终止全部自有并行任务、嵌套运行器和进程树；Bazel Server 仅按「构建与缓存纪律」取消自有工作，NEVER 杀 Server。NEVER 等待 afterAll、清理钩子、报告 I/O、WSL 或本机剩余测试。嵌套运行器 MUST 在识别失败时通知外层，不等自身退出；保留首个失败码与最终计时。MAY 绕过退出钩子直接退出，不能为补齐报告延迟结束。宿主强退后的普通自有后代仍由监督进程回收；未启动或被取消的工作不能记为通过。
- Agent 只能在有具体验证需要且一批相关修改完成后选择 fastcheck，NEVER 每次保存文件或对已有可用通过结果反复运行。fulltest/slowtest 需要本次用户明确运行授权，授权不跨任务延续。不能通过直接执行内部测试、包装或 WSL 阶段绕过权限；新/改门禁入口脚本可直接执行显式限定到该文件的非测试静态检查，不得扩大到目录/仓库或执行测试、打包、跨 WSL。
- 三层入口 NEVER push、触发/等待 CI、发布、部署、调用 Computer Use、操作用户共享鼠标或抢前台焦点。真实桌面输入测试保留为门禁外单独入口，并需另外明确授权；`packages/natives/test/desktop.test.ts` 不由标准本地 TS 门禁调用，不能把未运行记成通过。浏览器 DOM/协议、虚拟终端及独立 PTY 测试可在本地门禁中使用。
- slowtest 的 WSL 扩展仅在 Windows、项目需要且现有兼容发行版可用时启动。本项目显式使用 **Ubuntu-24.04 WSL2**，不替换该目标；未指定目标的一般项目才优先合适的已安装 CentOS。无 WSL/无兼容发行版记 `SKIPPED_WSL_UNAVAILABLE`，项目不需要记 `SKIPPED_NOT_APPLICABLE`，此时仍执行本机 fulltest 与宿主重型 Bazel 集成测试；其余发现、同步、脏源码、缺测试工具、执行或证据核验失败 MUST 立即终止整轮，NEVER 等本机完成或伪装成不可用跳过。NEVER 自动安装/启用 WSL、发行版或缺失测试工具。
- WSL 仅通过 `scripts/slowtest-wsl-stage.ts` 在 slowtest 内执行：源码只能经 **Windows → Git 网络远端 → WSL 原生 `/root` 工作区** 同步，所有 WSL 操作显式指定已解析发行版与 root。禁止本地快照、bundle、复制、rsync、patch、stdin 传源码、本地 Git remote 和 `/mnt/*` 工作区；调度脚本与返回日志可经 stdin/stdout。门禁不授权 commit/push/stash：未提交或未推送源码立即失败，不测试旧提交冒充当前改动。先确定实际 push/fetch 身份、完整固定 SHA 与 Linux 原语，再使用既有固定提交同步 helper 的 plan 保留同步、工作区保护、隔离未跟踪残留及测试后状态检查；原样流式执行计划、观测嵌套 fulltest 的纯编译事件，外层总墙钟仍为 1500 秒。混合命令不整段排除；无法可靠观测则 UNVERIFIED。既有 helper 3600 秒墙钟防挂单独报告，不得延长外层时限。两端记录 HEAD、当前平台源码指纹、工作树与工具版本；只有同一固定提交可合并 PASS。取消命令须在宿主强退前独立发起，只处理本次拥有的进程/临时资源，不关发行版、不删除已有 WSL 用户改动或有效编译缓存。
- 标准门禁按维护者要求沿用既有 fork 范围，以规格记录的上游基线纳入**完整已提交与未提交 fork 差异**，包括未跟踪的新测试；不以最新提交或本轮文件代替完整差异。TS 测试沿用差异测试集合，Rust 测试复用现有 `test:rs --affected` 及 vendor 消费者选择，保留脚本测试和 native/TUI 集成边界。各层按 `openspec/specs/fork-verification-gates/spec.md` 继承对应范围，报告 `scope=fork-affected`、基线、选择依据和未跑全项目覆盖；预算仍为 180/900/1500 秒，不通过排除失败项、放宽预算或改写测试标准求绿。全项目原有独立入口保留。
- 检查、测试与构建工具不可用时说明所缺环境及未验证部分，不自动安装工具或将缺失记为通过。完整本地门禁不等同公司模型、真实模型任务质量、独立发布 CI 或共享鼠标测试验收；上游原样检查失败仍遵循「测试与验证要求」的报告边界。
- fulltest 内的 UI 冒烟 MUST 使用 `bun run dev`，仅使用本地当前源码编译的 native addon；不存在则本地编译，不下载或复用其他来源的包。上游同步不运行 UI 测试。
- 上游同步仅做 staged Git 检查与必要的源码语义审查；无冲突时只在 TS 或工具链变化确有必要时运行一次 `bun run check:tools`，有冲突时同样最多一次，不运行编译、类型检查或测试（含 `check:types` 与精确测试）。缺依赖时仅允许 `bun install --frozen-lockfile --ignore-scripts`；首次检查失败只可修复本次相关问题并对首轮失败项额外复验一轮，不重跑已通过项、不追加范围，仍失败或无法确认时中止、不提交、不更新镜像。
- 上游同步 NEVER 运行全 workspace 检查、根级 `bun run check`、`bun run fastcheck`、`bun run fulltest`、`bun run slowtest`、完整测试、UI/browser/heavy、Docker、benchmark、打包、发布或任何 Rust/native build/check/test/lint/fmt/clippy/codegen/packaging（含 `cargo`、`bazel`、`nix build`）。冲突重建需要 UT 与真实入口 E2E 而本次未获明确验证授权时，按共享 Skill 中止并报告未验证；额外验证必须由用户明确要求。

## 中文文档

- `docs-zh-CN` 不维护翻译：上游 `docs` 的翻译文件已全部删除，后续同步不带入、不恢复；上游 `docs/` 的增删改不触发任何中文站维护。
- `docs-zh-CN` 保留 fork 自有的内网指南、架构背景、工程说明、历史验收记录与 `README.upstream.md` 对照快照；这些材料不作为第二份需求来源。当前已批准需求统一在 `openspec/specs/`，fork 不维护文档站点。
- 代码 review 或对比上游差异时，只审查 `docs-zh-CN` 内的 fork 新增文档。
