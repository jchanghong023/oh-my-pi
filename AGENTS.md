# Fork 维护规则

本仓库 fork 自 `can1357/oh-my-pi`，仅供个人使用，不以对外发布为目标。持续同步上游最新 `main`，同时维护个人功能和默认值，使安装后无需额外配置即可使用。

## 项目概况

* `omp` 是终端编码代理 CLI：TypeScript（Bun）为主体，Rust（`crates/`，cargo / bazel）提供 native 能力，另有 Python（`python/robomp`、`python/omp-rpc`）与 VitePress 文档站。
* 本仓库完全由 AI Agent 实现和维护：改动是否正确不能依赖用户手工读代码或人工回归来保证，MUST 依靠可复现的自动化验证，以及本文件（开发与维护规则）、`docs-zh-CN/fork.md`（需求契约）中的明确约定。

## 主要入口

关键目录（不是完整清单）：

* `packages/coding-agent/`：主 CLI（`omp`）实现，日常改动的主要目标。
* `packages/ai`、`packages/catalog`、`packages/agent`、`packages/tui`、`packages/natives`、`packages/utils`，以及 `packages/omptype`、`packages/stats`、`packages/wire`、`packages/mnemopi`、`packages/snapcompact`、`packages/collab-web`：模型接入、模型目录、agent 运行时、TUI、native 绑定与共享库。
* `crates/`：Rust native 与系统能力（`pi-natives`、`pi-shell`、`pi-vcs`、`pi-edit`、`pi-builtins`、`pi-ast`、`pi-walker` 等）。
* `scripts/`：仓库脚本与 fork 工具（`fastcheck` / `fulltest` / `slowtest` 验证入口、`install.sh` / `install.ps1`、`ci-test-ts.ts`、`run-rs-task.ts`）。
* `docs/`：上游英文文档（fork 不维护英文站点，也不为其提供构建或 `/en/` 子路径合并）；`docs-zh-CN/`：中文文档站，含 fork 新增文档与 `fork.md`。
* `.omp/skills/upstream-release-sync/SKILL.md`：上游同步流程。

核心代码入口：

* CLI 链路：`packages/coding-agent/src/cli.ts` → `src/main.ts` → `src/sdk.ts`。
* fork 自有实现：`src/jch-commands/`（`/jch*` 命令）、`src/config/zcode-api-models.ts`、`src/config/company-provider.ts` 与 `company-models.ts`、`src/docs/` 与 `src/tools/wiki.ts`（文档索引）、`src/modes/fullsend.ts`、`src/primary-agent/`。

常用命令（工作目录为仓库根；以下入口来自 `package.json` 与脚本本身，本文档不声称已在当前机器执行过；能否运行受「验证」一节限制）：

| 目的 | 入口 |
| --- | --- |
| 安装依赖 | `bun install`（`bun run setup` 会继续构建 native addon 并链接 `omp`） |
| 运行 CLI（源码） | `bun run dev` |
| 类型检查 + lint（workspace 门禁） | `bun run check:ts` |
| 仅静态检查（oxlint / oxfmt） | `bun run check:tools` |
| fork 静态检查（TS 类型检查 + lint + 格式、cargo check） | `bun run fastcheck` |
| TypeScript 测试 | `bun run test:ts`；分片 `ci:test:ts:workspace`、`ci:test:ts:native`、`ci:test:coding-agent:{singleton,ui,runtime,native,heavy}` |
| Rust 检查 / 测试 / lint / 格式 | `bun run check:rs`、`test:rs`、`lint:rs`、`fmt:rs`（经 `scripts/run-rs-task.ts`，测试走 `cargo nextest`） |
| Python 测试 | `bun run test:py` |
| 仓库脚本测试 | `bun run test:scripts` |
| 端到端冒烟（真实 CLI 公开入口） | `bun run ci:test:smoke` |
| 安装器端到端 | `bun run ci:test:install-methods` |
| fork 本地全量测试（当前 OS，含 UI 冒烟） | `bun run fulltest` |
| fork 流水线验证（自动 push + 触发 + 监控 GH CI） | `bun run slowtest` |
| 构建 | `bun run build`（workspace 包）、`bun run build:native`（native addon） |

## 开发约束

* 平台：日常在 Windows x64（PowerShell）上工作，同时支持 Linux x64 与 WSL2；本地验证只在当前操作系统运行对应测试。
* 工具链版本跟随上游固定，不在 fork 内单独升级：Bun `>=1.4`（`package.json` 的 `packageManager`）、Rust `nightly-2026-08-12`（`rust-toolchain.toml`）、Bazel `9.2.0`（`.bazelversion`）。
* 上游开发约定（代码质量、Bun 优先、prompt 放 `.md`、模型/Provider 策略在 KDL、生成文件与 changelog 规则等）同样适用于 fork 改动，但不在本文件重复：以 `fork.md` 记录的 Upstream commit 为准，用 `git show <upstream-commit>:AGENTS.md` 读取。fork 改动 MUST 与上游既有风格和机制一致，不引入局部风格。

## 权威来源与文档职责

本仓库是持续同步上游的 Fork（同步来源与分支约定见「上游与分支」），文档职责如下：

* `AGENTS.md`：本仓库的维护原则与 agent 规则。
* `.omp/skills/upstream-release-sync/SKILL.md`：每日定时同步或手动同步上游的操作流程。
* `docs-zh-CN/fork.md`：面向本人和 AI agent 的当前上游基线与用户可感知的功能契约，也是冲突后重建 fork 功能的依据。

同步 MUST 保留这四份文档的 fork 版本（上述三份与根 `README.md`），NEVER 用上游版本覆盖；按实际变化维护内容（README 的更新方式见下节）。

## README 与上游同步

* 仓库根 `README.md` 是上游 README 的**中文版**，内容跟随上游：上游改了正文，同步时把对应段落重译进 `README.md`。
* `docs-zh-CN/README.upstream.md` 是最近一次合入的上游 README 英文快照，只作对照稿源，不对外；同步时先更新快照，再据差异改中文正文（上游 README 未变则不动）。
* `README.md` 的 Install / 下载段是 fork 专有内容（fork release 链接、`install.sh --binary`、`install.ps1 -Binary`、`+fork.N` 版本说明、平台支持声明），NEVER 采用上游的 npm / Homebrew / Nix / mise / `omp.sh` 写法；中文翻译照此段本身翻译。
* 除下载段与「提示词控制」中 fork 新增的 `fullsend` 条目外，`README.md` 不保留 fork 专有内容：其余正文以当前上游快照为准。

## 开发与差异记录

* 修改前 MUST 阅读 `docs-zh-CN/fork.md`。
* fork 改动 MUST 最小、集中、内聚；不做无关重构，不为覆盖率或惯例添加测试。
* 功能或默认值变化时 MUST 同步更新 `fork.md`；成功合入上游时 MUST 更新基线并复核受影响条目，而不是只检查是否存在 Git 冲突。
* `fork.md` 只记录当前有效的功能、默认值及必要行为约束，不记实现流水账、修复历史或同步历史，不建第二份差异清单。
* `fork.md` 的 `## 当前上游基线` 是 Release CI 的机器可读输入：该节 MUST 保留唯一一行以 `* **版本**：` 开头、值为反引号包裹的 `v数字.数字.数字` 的条目；改标题、改格式或增加第二个版本行会让 fork Release 在 `release_metadata` 阶段直接失败。
* 需求或预期用户可见行为变化时 MUST 检查并同步 `fork.md`；仅实现方式变化且需求不变时，不制造需求变更，也不得改写需求来合理化实现缺陷。
* 优先采用上游最新实现。冲突很大时，可在上游实现上重写 fork 功能，不必保留旧代码；无法可靠保留功能时 MUST 中止同步，不能静默丢弃。

## 上游与分支

* 唯一同步来源：`https://github.com/can1357/oh-my-pi.git` 的 `refs/heads/main` HEAD；NEVER 使用 Release、tag、其他分支、`origin/main` 或配置型 `upstream/main` 代替。
* `main`：上游代码与个人改动的集成分支。
* `upstream`：最近成功合入的上游 `main` 的精确镜像，不含 fork commit；GitHub 上用于 PR/差异比较（base 为 `upstream`，compare 为 `main`）。
* 同步 MUST 遵循 Skill 的门禁、集成、验证、镜像与中止流程；NEVER 接受上游历史改写。
* 同步只完成本地 `main` 集成与 `upstream` 镜像，不自动推送 `main`；本地完成不代表 GitHub 已可比较最新 fork 差异，后者取决于远端 `main` 是否另行更新。

## 测试与验证要求

* 功能性开发和功能性修改 MUST 有自动化验证：UT 验证局部逻辑，E2E 从真实公开入口跑到可观察结果（本仓库已有 `bun run ci:test:smoke`、`bun run ci:test:install-methods`，UI 冒烟并入 `bun run fulltest`），跨模块交互按需要增加集成测试；已有有效覆盖可以复用，不要求为每处修改机械新增测试。
* UT、编译、静态检查和局部模拟 MUST NOT 替代 E2E；桩与模拟可用于补充测试，但未经真实边界验证的部分 MUST 说明，不能把局部模拟冒充端到端验证。
* 测试 MUST 对应 `fork.md` 中的需求与验收条件，覆盖核心成功路径和关键失败路径；不得只复述实现，也不得只验证「没有崩溃」。
* 状态 MUST 区分「已实现」「验证通过」「验证失败」「未验证」；环境、依赖或权限不足时说明未验证范围，NEVER 声称功能已验收。
* 缺少 UT 或 E2E 时 MUST 如实写明缺口与后续要求，不编造命令、不降低标准；纯文档等非功能性变更按实际影响验证，不强制运行无关的完整测试。

现状与缺口（2026-09-16 依据仓库内容整理，编写本文档时未运行任何检查）：

* fork 功能多数随改动附带自动化测试，例如 `packages/coding-agent/test/` 下的 `wiki-tool`、`docs-index`、`modes/fullsend`、`slash-commands/jch-git`、`slash-commands/magic-keywords`、`company-provider`、`cli-offline-flag`，以及 `scripts/fulltest.test.ts`、`scripts/slowtest.test.ts`、`scripts/install-tests/fork-installer-routing.test.ts`。
* E2E 入口存在，但 fork 的 `.github/workflows/ci.yml` 只有手动 `workflow_dispatch` 触发（没有 push / pull_request 触发器）：fork 改动不会自动跑这些验证，`release_gate` 也只在手动运行且各验证作业全部通过时放行。
* 受「验证」一节约束，未经用户明确要求的改动处于「未验证」状态；此时 MUST NOT 报告为已验证或已修复。

## 验证

* fork 验证入口为三级：`bun run fastcheck`（静态检查：TS 类型检查、lint、格式 + `cargo check`，只查不测；整体 60 秒墙钟硬超时，超时杀掉运行中的子进程、输出 TIMEOUT 与已耗时间并判失败——冷缓存如同步后首次 Rust 编译超时属预期失败，无时限完整静态验证由 fulltest 承担）、`bun run fulltest`（fastcheck 全部静态检查 + 当前操作系统的 fork 绿色测试集合：TS 白名单（清单在 `scripts/fulltest.ts`，结果非黑即白、不设豁免）、Rust `cargo nextest` 核心 crate、脚本测试、UI 冒烟，不含 Python 组件；各测试执行阶段设 3 分钟硬超时、编译不计入；需要时先构建当前宿主平台 native addon；上游全量 TS 分片由 slowtest 的 Linux CI 覆盖）、`bun run slowtest`（fulltest 全部内容 + 自动 push 本地 `main` 到远端、触发 GitHub Actions CI 并持续监控直到返回，并输出各阶段耗时；端到端冒烟与安装器 E2E 由该流水线覆盖）。
* `bun run fastcheck` agent 可按需自主调用，普通 TypeScript 修改后 MUST 运行；纯文档修改只做差异与格式检查。除 fastcheck 外的本地编译、类型检查、测试（含 `bun test`、`bun run test`、`test:*`、`ci:test:*`、`bun run check`、`check:types`、`bun run build`、cargo / bazel / nix 等）以及 push、触发外部流水线，MUST 仅在用户明确要求时进行。
* `bun run fulltest` 与 `bun run slowtest` 在当前操作系统上运行、只运行当前操作系统对应的测试，不维护 WSL2/双平台运行能力；Rust 核心测试走 `cargo nextest`，Windows 自动注入 VS Build Tools 的 CMake/Ninja。
* UI 冒烟（原 `jch-dev-ui-test` 能力，已并入 fulltest）MUST 使用 `bun run dev`，仅使用本地当前源码编译的 native addon；不存在则本地编译，不下载或复用其他来源的包。上游同步不运行 UI 测试。
* 上游同步的检查范围、次数和失败处理统一遵循 Skill，不运行全 workspace 检查、完整测试、Rust/native 检查或构建、打包、发布；冲突场景同样不运行编译、类型检查或测试（含 Skill 中列出的 `check:types` 与精确测试），只做源码语义审查，除非用户明确要求。

## 中文文档

* `docs-zh-CN` 以覆盖上游 `docs` 全部文档的完整翻译为目标，并包含 fork 新增文档（不是纯翻译目录）；经 VitePress 构建发布到 GitHub Pages。翻译独立同步，可能落后于代码基线。
* 代码 review 或对比上游差异时，忽略同名文档的翻译内容，只审查新增文档，除非用户明确要求同步翻译。
* 同步翻译时先检查上游文档的新增与删除，只维护上游最新文档的翻译副本；不因同步代码自动开展翻译。
