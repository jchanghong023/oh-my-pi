# Fork 维护规则

本仓库 fork 自 `can1357/oh-my-pi`，是仅供个人使用的 fork 维护仓库，不以对外发布为目标。以近乎每日合并上游最新 `main` 为维护节奏，保持 OMP 核心持续跟进上游。三种使用场景与零配置目标统一见 [Fork 需求：项目定位与使用场景](docs-zh-CN/requirements/fork.md#项目定位与使用场景)。

## 项目概况

* `omp` 是终端编码代理 CLI：TypeScript（Bun）为主体，Rust（`crates/`，cargo / bazel）提供 native 能力，另有 Python（`python/robomp`、`sdk/python/omp-rpc`）组件。
* 本仓库完全由 AI Agent 实现和维护：改动是否正确不能依赖用户手工读代码或人工回归来保证，MUST 依靠可复现的自动化验证，以及本文件（开发与维护规则）、`docs-zh-CN/requirements/fork.md`（需求契约）中的明确约定。

## 主要入口

关键目录（不是完整清单）：

* `packages/coding-agent/`：主 CLI（`omp`）实现，日常改动的主要目标。
* `packages/ai`、`packages/catalog`、`packages/agent`、`packages/tui`、`packages/natives`、`packages/utils`，以及 `packages/omptype`、`packages/stats`、`packages/wire`、`packages/mnemopi`、`packages/snapcompact`、`packages/collab-web`：模型接入、模型目录、agent 运行时、TUI、native 绑定与共享库。
* `crates/`：Rust native 与系统能力（`pi-natives`、`pi-shell`、`pi-vcs`、`pi-edit`、`pi-builtins`、`pi-ast`、`pi-walker` 等）。
* `scripts/`：仓库脚本与 fork 工具（`fastcheck` / `fulltest` / `slowtest` 验证入口、`install.sh` / `install.ps1`、`ci-test-ts.ts`、`run-rs-task.ts`）。
* `docs/`：上游英文文档（fork 不维护英文站点，也不为其提供构建或 `/en/` 子路径合并）；`docs-zh-CN/`：仅含 fork 自有内容（需求目录、公司内网新手指南与 `README.upstream.md` 对照快照），不维护翻译，不维护文档站点（见「中文文档」一节）。
* `.omp/skills/upstream-release-sync/SKILL.md`：上游同步流程。

子目录 `AGENTS.md` 注册表（全仓库仅此一个，上限 8 个）：

* `python/robomp/AGENTS.md`：robomp 子树（GitHub triage/fix bot）的开发规则与命令参考，上游自带并随上游维护，fork 不修改。

核心代码入口：

* CLI 链路：`packages/coding-agent/src/cli.ts` → `src/main.ts` → `src/sdk.ts`。
* fork 自有实现：`src/jch-commands/`（`/jch*` 命令）、`src/config/zcode-api-models.ts`、`src/config/company-provider.ts` 与 `company-models.ts`、`src/docs/` 与 `src/tools/wiki.ts`（文档索引）、`src/modes/magic-keywords.ts`（含 fullsend 关键词）、`src/modes/rpc/` 的 `rpc-fork-*.ts`（ZCode 接入的 RPC 协议 v3 扩展：命令目录与补全、role 持久配置、保存会话目录管理，宿主为上游单会话 RPC 模式，需求见 `docs-zh-CN/requirements/rpc-ui-protocol.md`）。
* RPC 命令接入复用同一 slash 注册表的 `handleRpc` / `handle`：索引对话在 `src/slash-commands/helpers/index-dashboard.ts`，计划与循环宿主生命周期在 `src/modes/rpc/rpc-plan.ts`、`rpc-loop.ts`，目标复用 `rpc-goal.ts`；界面通过现有 `prompt` 与 RPC UI 对话调用，不另建命令表。

常用命令（工作目录为仓库根；以下入口来自 `package.json` 与脚本本身，本文档不声称已在当前机器执行过；能否运行受「验证」一节限制）：

| 目的 | 入口 |
| --- | --- |
| 安装依赖 | `bun install`（`bun run setup` 会继续构建 native addon 并链接 `omp`） |
| 运行 CLI（源码） | `bun run dev` |
| 类型检查 + lint（workspace 门禁） | `bun run check:ts` |
| 仅静态检查（oxlint / oxfmt） | `bun run check:tools` |
| fork 静态门禁（沿用现有 TS 与 Rust 静态/编译检查；非编译预算 60 秒） | `bun run fastcheck` |
| TypeScript 测试 | `bun run test:ts`；分片 `ci:test:ts:workspace`、`ci:test:ts:native`、`ci:test:coding-agent:{singleton,ui,runtime,native,heavy}` |
| Rust 检查 / 测试 / lint / 格式 | `bun run check:rs`、`test:rs`、`lint:rs`、`fmt:rs`（经 `scripts/run-rs-task.ts`，测试走 `cargo nextest`） |
| Python 测试 | `bun run test:py` |
| 仓库脚本测试 | `bun run test:scripts` |
| 端到端冒烟（真实 CLI 公开入口） | `bun run ci:test:smoke` |
| 安装器端到端 | `bun run ci:test:install-methods` |
| 当前平台 fork 本地门禁（全部 fastcheck 检查 + fork TS 测试、受影响 Rust 测试、脚本测试、native 构建及隔离 TUI 冒烟；非编译预算 900 秒） | `bun run fulltest` |
| 本机 + 可用的项目所需 WSL 本地门禁（不推送、不触发 CI；非编译预算 1500 秒） | `bun run slowtest` |
| 构建 | `bun run build`（workspace 包）、`bun run build:native`（native addon） |

## 开发约束

* 平台：日常在 Windows x64（PowerShell）上工作，同时支持 Linux x64 与 WSL2；本地验证只在当前操作系统运行对应测试。
* 工具链版本跟随上游固定，不在 fork 内单独升级：Bun `>=1.4`（`package.json` 的 `packageManager`）、Rust `nightly-2026-10-06`（`rust-toolchain.toml`）、Bazel `9.2.0`（`.bazelversion`）。
* 上游开发约定（代码质量、Bun 优先、prompt 放 `.md`、模型/Provider 策略在 KDL、生成文件与 changelog 规则等）同样适用于 fork 改动，但不在本文件重复：以 `fork.md` 记录的 Upstream commit 为准，用 `git show <upstream-commit>:AGENTS.md` 读取。fork 改动 MUST 与上游既有风格和机制一致，不引入局部风格。

## 权威来源与文档职责

本仓库是持续同步上游的 Fork（同步来源与分支约定见「上游与分支」），文档职责如下：

* `AGENTS.md`：本仓库的维护原则与 agent 规则。
* `.omp/skills/upstream-release-sync/SKILL.md`：每日定时同步或手动同步上游的操作流程。
* `docs-zh-CN/requirements/`：唯一固定需求目录，完整文档清单及功能边界见其中的 `README.md`。`fork.md` 保存项目定位、三种使用场景与零配置目标、当前上游基线和通用差异，`team.md` 保存多模型讨论契约，`repo-index.md` 保存代码索引需求，`rpc-ui-protocol.md` 保存 rpc-ui 协议 v3 扩展（ZCode 接入）需求；它们共同作为开发和冲突后重建的依据。

同步 MUST 保留 `AGENTS.md`、同步 Skill、整个需求目录、`docs-zh-CN/quick-start-intranet.md` 和根 `README.md` 的 fork 版本，NEVER 用上游版本覆盖；按实际变化维护内容（README 的更新方式见下节）。

## README 与上游同步

* 仓库根 `README.md` 是上游 README 的**中文版**，内容跟随上游：上游改了正文，同步时把对应段落重译进 `README.md`。
* `docs-zh-CN/README.upstream.md` 是最近一次合入的上游 README 英文快照，只作对照稿源，不对外；同步时先更新快照，再据差异改中文正文（上游 README 未变则不动）。
* `README.md` 的 Install / 下载段是 fork 专有内容（fork release 链接、`install.sh --binary`、`install.ps1 -Binary`、`+fork.N` 版本说明、平台支持声明），NEVER 采用上游的 npm / Homebrew / Nix / mise / `omp.sh` 写法；中文翻译照此段本身翻译。
* 除下载段与「提示词控制」中 fork 新增的 `fullsend` 条目外，`README.md` 不保留 fork 专有内容：其余正文以当前上游快照为准。

## 开发与差异记录

* 修改前 MUST 阅读 `docs-zh-CN/requirements/README.md`、`fork.md` 及涉及功能域的需求文档。目录或权威体系缺失时先补齐，再修改实现。
* 在完整满足需求、保证正确性并遵循上游机制的前提下，fork 业务代码改动 MUST 最小、集中、内聚，控制相对上游的差异规模，降低高频合并的冲突与维护成本；不做无关重构，不为覆盖率或惯例添加测试。
* fork 新增功能 SHOULD 优先写入对应的上游已有文件并接入现有执行链路，让上游变化尽早在合并中暴露需要处理的适配问题；MUST NOT 为规避合并冲突而另建一套平行业务实现。确需新增文件时，须有明确的职责或上游结构依据，并核对其注册与调用入口，避免文件保留但功能已脱离执行链路而静默失效；无 Git 冲突不能作为功能仍有效的依据。
* 新增、修改或取消本地需求时 MUST 同步维护需求目录中的对应文档；新独立功能域可新增文档并更新目录索引。每条需求只有一个权威位置，跨文档用引用表达；保留明确的待实现规划，不按代码现状删减需求。
* 成功合入上游时 MUST 更新 `fork.md` 基线并逐项核对需求目录中仍然有效的本地需求，而不是只检查是否存在 Git 冲突。上游等价满足的需求保留其目标并注明由上游满足，不因补丁消失而删除。
* 需求文档只维护当前有效的目标、行为、验收条件及明确规划，不追加修复或同步历史，不建第二份差异清单。
* `fork.md` 的 `## 当前上游基线` 是 Release CI 的机器可读输入：该节 MUST 保留唯一一行以 `* **版本**：` 或 `- **版本**：` 开头、值为反引号包裹的 `v数字.数字.数字` 的条目（CI 正则 `^[-*] \*\*版本\*\*` 两种前缀均接受）；改标题、改格式或增加第二个版本行会让 fork Release 在 `release_metadata` 阶段直接失败。
* 需求或预期用户可见行为变化时 MUST 检查并同步对应需求文档；仅实现方式变化且需求不变时，不制造需求变更，也不得改写需求来合理化实现缺陷。入口、命令或开发规则变化时同步更新本文件。
* 优先采用上游最新实现。冲突很大时，可在上游实现上重写 fork 功能，不必保留旧代码；无法可靠保留功能时 MUST 中止同步，不能静默丢弃。
* 已获授权的同步先保全本地改动与整个需求目录，优先可靠合并；重建限于相关冲突部分，不能丢弃无关改动、覆盖唯一需求依据或重置整个仓库。重建后须通过相应 UT 与真实入口 E2E；现有同步规则未授权这些验证时，应报告未验证并中止，不能宣称重建或同步完成。

## 上游与分支

* 唯一同步来源：`https://github.com/can1357/oh-my-pi.git` 的 `refs/heads/main` HEAD；NEVER 使用 Release、tag、其他分支、`origin/main` 或配置型 `upstream/main` 代替。
* `main`：上游代码与个人改动的集成分支。
* `upstream`：最近成功合入的上游 `main` 的精确镜像，不含 fork commit；GitHub 上用于 PR/差异比较（base 为 `upstream`，compare 为 `main`）。
* 同步 MUST 遵循 Skill 的门禁、集成、验证、镜像与中止流程；NEVER 接受上游历史改写。
* 同步只完成本地 `main` 集成与 `upstream` 镜像，不自动推送 `main`；本地完成不代表 GitHub 已可比较最新 fork 差异，后者取决于远端 `main` 是否另行更新。

## 测试与验证要求

* 功能性开发和功能性修改 MUST 有自动化验证：UT 验证局部逻辑，E2E 从真实公开入口跑到可观察结果（本仓库已有 `bun run ci:test:smoke`、`bun run ci:test:install-methods`，UI 冒烟并入 `bun run fulltest`），跨模块交互按需要增加集成测试；已有有效覆盖可以复用，不要求为每处修改机械新增测试。
* UT、编译、静态检查和局部模拟 MUST NOT 替代 E2E；桩与模拟可用于补充测试，但未经真实边界验证的部分 MUST 说明，不能把局部模拟冒充端到端验证。
* 测试 MUST 对应需求目录中相关文档的需求与验收条件，覆盖核心成功路径和关键失败路径；不得只复述实现，也不得只验证「没有崩溃」。
* 状态 MUST 区分「已实现」「验证通过」「验证失败」「未验证」；环境、依赖或权限不足时说明未验证范围，NEVER 声称功能已验收。
* 缺少 UT 或 E2E 时 MUST 如实写明缺口与后续要求，不编造命令、不降低标准；纯文档等非功能性变更按实际影响验证，不强制运行无关的完整测试。
* 测试失败后 MUST 先对比当前上游基线，区分 fork 改动与上游原样代码导致的失败。上游代码导致的失败默认只报告，NEVER 为使门禁转绿自动修复；只有用户明确要求修复，或已有真实入口证据确认是影响核心功能的业务代码缺陷时，才 MAY 最小修复。单独的测试失败不构成核心功能受损的证据。

现状与缺口（2026-10-07 依据仓库内容整理；当日精简会话运行的验证以各功能域记录为准）：

* fork 功能多数随改动附带自动化测试，例如 `packages/coding-agent/test/` 下的 `wiki-tool`、`docs-index`、`modes/fullsend`、`slash-commands/jch-git`、`slash-commands/magic-keywords`、`company-provider`、`cli-offline-flag`、`rpc-fork-*`，以及 `scripts/fulltest.test.ts`、`scripts/slowtest.test.ts`、`scripts/test-gate-runtime.test.ts`、`scripts/slowtest-wsl-stage.test.ts`、`scripts/ci-test-ts.test.ts`、`scripts/install-tests/fork-installer-routing.test.ts`。按维护者明确要求，标准门禁沿用既有 fork 范围，完整范围与未覆盖项以 `fork.md`「Fork 验证体系」为准，不自动扩大到 Python、独立 SDK 或全部 workspace 打包。
* fork 的 `.github/workflows/ci.yml` 只有手动 `workflow_dispatch` 触发（没有 push / pull_request 触发器），永久只构建和发布，不运行测试、冒烟、lint、类型检查或独立校验作业。该独立发布流程保持不变，但 NEVER 由 fastcheck/fulltest/slowtest 推送、触发或监控；直接运行 CI 不代表本地验证通过。
* 上游 Windows 专属 `clippy::map_unwrap_or` 问题已随上游修复合入；标准 fulltest 不再保留只运行 `check:ts` 的 Rust 静态跳过，必须包含 fastcheck 的全部检查。现有 `test:rs` 在 Windows 过滤上游确定性失败的 `pi-builtins sed::fast_io::tests::test_file_truncated_after_open`，Linux 不过滤；该既有测试定义在门禁迁移中不改写，不能据此声称该用例已通过。上游带入的格式差异、RPC 重入修复与 Linux 会话隔离测试的既有适配仍按相应源码注释维护；门禁迁移不改变其检查定义、产品行为或通过标准。
* 未执行的门禁与因工具/环境受阻的验证均须如实记录为未验证；本次明确技能调用可授权任务所需验证，但授权本身不是通过证据，不能报告未运行的检查已通过或功能已验收。

## 构建与缓存纪律

* NEVER 无理由 `cargo clean`，NEVER 删除当前有效的 `target` 目录：构建缓存属于项目资产，清理必须有具体理由（缓存损坏、废弃配置清理等），定点进行并说明范围。
* 保持同一平台的构建配置与 `target` 目录稳定：不为提速切换 profile / target 目录 / `RUSTFLAGS` 等配置变体；fastcheck/fulltest 与日常开发 MUST 复用正常增量缓存，NEVER 在连续 fastcheck 之间清缓存、强制全量重建或切换缓存变体。只为 Windows/WSL 平台隔离使用各自稳定的原生缓存；编译计时包装器也须保持固定路径并保留已有缓存包装器、features 与 flags。自然冷启动可记录，不能清缓存制造冷样本。
* 最终打包 / 发布 profile 的构建（native addon 打包、release 构建等）只出现在 `fulltest` / `slowtest`，NEVER 进入 `fastcheck`。

## 验证

* 三层语义固定，复用现有本地检查定义、通过标准与运行器，不为门禁改写上游质量规则。`bun run fastcheck` 沿用现有 TS 与 Rust 静态、类型/格式检查及编译，NEVER 执行任何测试（含冒烟或门禁自测）；`bun run fulltest` 包含全部 fastcheck 检查及声明的 fork 范围内测试、native 构建与隔离 TUI 公开入口 E2E；`bun run slowtest` 包含 fulltest 一次，并可增加同一范围的 WSL/Linux 验证。fulltest NEVER 启动另一操作系统；除适用 WSL 外，slowtest 不增加 VM、容器模拟或远端机器验证。
* 非编译硬上限分别为 fastcheck **60 秒**、fulltest **900 秒**、slowtest **1500 秒**。用单调时钟从入口到退出累计，排除真实观测到的纯编译区间之并集；编译与检查/测试并行时重叠仍计费一次，发现、准备、同步、等待、汇总与清理均计费。混合命令不能整段当编译。嵌套门禁共享外层剩余额度，并保留更严格的内层上限。超时须终止本次拥有的进程树、非零退出并打印 `TIMEOUT`，不能放宽上限或在阶段间重置时钟；`--limit-seconds=<N>` 只允许下调。
* 每次入口运行在成功、失败、缺工具、超时、中断及参数错误的最终路径均输出 status、total、compile_excluded、budgeted、limit（秒，至少一位小数）及退出码。独立且安全的检查、测试与 Windows/WSL 两端 MUST 并行；生成或改写共享文件的阶段须排在读取它们的检查之前，不能让并发读取部分生成结果。
* Agent 只能在有具体验证需要且一批相关修改完成后选择 fastcheck，NEVER 每次保存文件或对已有可用通过结果反复运行。fulltest/slowtest 通常需要本次用户明确运行授权；用户明确调用 `jch-fastcheck-fulltest-slowtest-gates` 执行其工作流时，授权本任务所需三层运行与修复后的必要重跑，不再逐层确认；任务结束即失效。不能通过直接执行内部测试、包装或 WSL 阶段绕过权限；新/改门禁入口脚本的逐文件静态检查可按该技能的限定例外执行。
* 三层入口 NEVER push、触发/等待 CI、发布、部署、调用 Computer Use、操作用户共享鼠标或抢前台焦点。真实桌面输入测试保留为门禁外单独入口，并需另外明确授权；`packages/natives/test/desktop.test.ts` 不由标准本地 TS 门禁调用，不能把未运行记成通过。浏览器 DOM/协议、虚拟终端及独立 PTY 测试可在本地门禁中使用。
* slowtest 的 WSL 扩展仅在 Windows、项目需要且现有兼容发行版可用时启动。本项目显式使用 **Ubuntu-24.04 WSL2**，不替换该目标；未指定目标的一般项目才优先合适的已安装 CentOS。无 WSL/无兼容发行版记 `SKIPPED_WSL_UNAVAILABLE`，项目不需要记 `SKIPPED_NOT_APPLICABLE`，此时覆盖等于 fulltest；已选择阶段的同步失败、脏源码或缺测试工具须 BLOCKED/UNVERIFIED/FAIL，不能伪装成不可用跳过，仍完成可达的当前平台 fulltest 一次。NEVER 自动安装/启用 WSL、发行版或缺失测试工具。
* WSL 仅在 slowtest 内按 `jch-fastcheck-fulltest-slowtest-gates/references/wsl-testing-workflow.md` 执行：源码只能经 **Windows → Git 网络远端 → WSL 原生 `/root` 工作区** 同步，所有 WSL 操作显式指定已解析发行版与 root。禁止本地快照、bundle、复制、rsync、patch、stdin 传源码、本地 Git remote 和 `/mnt/*` 工作区；调度脚本与返回日志可经 stdin/stdout。门禁不授权 commit/push/stash：未提交或未推送源码阻塞 WSL，不测试旧提交冒充当前改动。先确定实际 push/fetch 身份、完整固定 SHA 与 Linux 原语，再使用已部署 `workflow.py` 的 plan 保留同步、工作区保护、隔离未跟踪残留及测试后状态检查；原样流式执行计划、观测嵌套 fulltest 的纯编译事件，外层仍累计 1500 秒计费。混合命令不整段排除；无法可靠观测则 UNVERIFIED。既有 helper 3600 秒墙钟防挂单独报告，不是非编译预算。两端记录 HEAD、当前平台源码指纹、工作树与工具版本；只有同一固定提交可合并 PASS。取消仅处理本次拥有的进程/临时资源，不关发行版、不删除已有 WSL 用户改动或有效编译缓存。
* 标准门禁按维护者要求沿用既有 fork 范围，以需求记录的上游基线纳入**完整已提交与未提交 fork 差异**，包括未跟踪的新测试；不以最新提交或本轮文件代替完整差异。TS 测试沿用差异测试集合，Rust 测试复用现有 `test:rs --affected` 及 vendor 消费者选择，保留脚本测试和 native/TUI 集成边界。三层继承同一范围，报告 `scope=fork-affected`、基线、选择依据和未跑全项目覆盖；预算仍为 60/900/1500 秒，不通过排除失败项、放宽预算或改写测试标准求绿。全项目原有独立入口保留。
* 检查、测试与构建工具不可用时说明所缺环境及未验证部分，不自动安装工具或将缺失记为通过。完整本地门禁不等同公司模型、真实模型任务质量、独立发布 CI 或共享鼠标测试验收；上游原样检查失败仍遵循「测试与验证要求」的报告边界。
* UI 冒烟（原 `jch-dev-ui-test` 能力，已并入 fulltest）MUST 使用 `bun run dev`，仅使用本地当前源码编译的 native addon；不存在则本地编译，不下载或复用其他来源的包。上游同步不运行 UI 测试。
* 上游同步的检查范围、次数和失败处理统一遵循 Skill，不运行全 workspace 检查、完整测试、Rust/native 检查或构建、打包、发布；冲突场景同样不运行编译、类型检查或测试（含 Skill 中列出的 `check:types` 与精确测试），只做源码语义审查，除非用户明确要求。

## 中文文档

* `docs-zh-CN` 不维护翻译：上游 `docs` 的翻译文件已全部删除，后续同步不带入、不恢复；上游 `docs/` 的增删改不触发任何中文站维护。
* `docs-zh-CN` 仅保留 fork 自有内容：`requirements/` 需求目录、[公司内网新手快速指南](docs-zh-CN/quick-start-intranet.md) 与 `README.upstream.md` 对照快照。新手指南按当前命令、快捷键和环境变量维护，需求范围见 `docs-zh-CN/requirements/fork.md`；它不作为第二份需求来源。fork 不维护文档站点（VitePress 站点、GitHub Pages 发布与 `collab-web` 托管已于 2026-10-06 需求访谈后取消）。
* 代码 review 或对比上游差异时，只审查 `docs-zh-CN` 内的 fork 新增文档。
