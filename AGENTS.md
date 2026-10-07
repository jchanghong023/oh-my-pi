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
* `docs/`：上游英文文档（fork 不维护英文站点，也不为其提供构建或 `/en/` 子路径合并）；`docs-zh-CN/`：仅含 fork 自有内容（需求目录与 `README.upstream.md` 对照快照），不维护翻译，不维护文档站点（见「中文文档」一节）。
* `.omp/skills/upstream-release-sync/SKILL.md`：上游同步流程。

子目录 `AGENTS.md` 注册表（全仓库仅此一个，上限 8 个）：

* `python/robomp/AGENTS.md`：robomp 子树（GitHub triage/fix bot）的开发规则与命令参考，上游自带并随上游维护，fork 不修改。

核心代码入口：

* CLI 链路：`packages/coding-agent/src/cli.ts` → `src/main.ts` → `src/sdk.ts`。
* fork 自有实现：`src/jch-commands/`（`/jch*` 命令）、`src/config/zcode-api-models.ts`、`src/config/company-provider.ts` 与 `company-models.ts`、`src/docs/` 与 `src/tools/wiki.ts`（文档索引）、`src/modes/magic-keywords.ts`（含 fullsend 关键词）、`src/modes/rpc/` 的 `rpc-fork-*.ts`（ZCode 接入的 RPC 协议 v3 扩展：命令目录与补全、role 持久配置、保存会话目录管理，宿主为上游单会话 RPC 模式，需求见 `docs-zh-CN/requirements/rpc-ui-protocol.md`）。

常用命令（工作目录为仓库根；以下入口来自 `package.json` 与脚本本身，本文档不声称已在当前机器执行过；能否运行受「验证」一节限制）：

| 目的 | 入口 |
| --- | --- |
| 安装依赖 | `bun install`（`bun run setup` 会继续构建 native addon 并链接 `omp`） |
| 运行 CLI（源码） | `bun run dev` |
| 类型检查 + lint（workspace 门禁） | `bun run check:ts` |
| 仅静态检查（oxlint / oxfmt） | `bun run check:tools` |
| fork 静态检查（委托上游 `check:ts` + `check:rs`：TS 类型检查、lint、格式、cargo check） | `bun run fastcheck` |
| TypeScript 测试 | `bun run test:ts`；分片 `ci:test:ts:workspace`、`ci:test:ts:native`、`ci:test:coding-agent:{singleton,ui,runtime,native,heavy}` |
| Rust 检查 / 测试 / lint / 格式 | `bun run check:rs`、`test:rs`、`lint:rs`、`fmt:rs`（经 `scripts/run-rs-task.ts`，测试走 `cargo nextest`） |
| Python 测试 | `bun run test:py` |
| 仓库脚本测试 | `bun run test:scripts` |
| 端到端冒烟（真实 CLI 公开入口） | `bun run ci:test:smoke` |
| 安装器端到端 | `bun run ci:test:install-methods` |
| fork 本地验证（当前 OS；TS 只跑 fork 差异测试文件、Rust 只跑改动 crate，未改动不测，含 UI 冒烟） | `bun run fulltest` |
| fork 流水线验证（fulltest 后 Ubuntu-24.04 WSL 验证 + 自动 push + 触发 + 监控 GH CI） | `bun run slowtest` |
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

同步 MUST 保留 `AGENTS.md`、同步 Skill、整个需求目录和根 `README.md` 的 fork 版本，NEVER 用上游版本覆盖；按实际变化维护内容（README 的更新方式见下节）。

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

现状与缺口（2026-10-07 依据仓库内容整理；当日精简会话运行的验证以各功能域记录为准）：

* fork 功能多数随改动附带自动化测试，例如 `packages/coding-agent/test/` 下的 `wiki-tool`、`docs-index`、`modes/fullsend`、`slash-commands/jch-git`、`slash-commands/magic-keywords`、`company-provider`、`cli-offline-flag`、`rpc-fork-*`，以及 `scripts/fulltest.test.ts`、`scripts/slowtest.test.ts`、`scripts/rust-test-scope.test.ts`、`scripts/ci-test-ts.test.ts`、`scripts/install-tests/fork-installer-routing.test.ts`。fulltest 按 `upstream` 基线差异动态选择测试目标（TS 只跑 fork 改动的测试文件、Rust 只跑改动 crate），无需手工维护清单。
* E2E 入口存在，但 fork 的 `.github/workflows/ci.yml` 只有手动 `workflow_dispatch` 触发（没有 push / pull_request 触发器）：fork 改动不会自动跑这些验证，`release_gate` 也只在手动运行且各验证作业全部通过时放行。
* 临时状态（2026-10-06 起）：上游 main 处于红色（TS 测试与 bazel clippy 损坏）时，CI 中的 TS 分片与 Rust 测试/校验作业经 `if: false` 临时禁用，`release_gate` 的 needs 相应缩减为 `[release_metadata, check, native_addons]`，流水线只构建发布产物；恢复条件为上游转绿后按 ci.yml 内注释还原被禁用作业与 release_gate 完整 needs。同一上游红色状态波及本地静态门禁（2026-10-07 确认，同日经验收补全清单）：上游自身 Windows 专属代码共三处在 pinned nightly 下违反 `clippy::map_unwrap_or`（`-D warnings` 必红；上游 CI 只在 Linux lint，扫描不到这些文件）——`crates/pi-vfs/src/native/windows.rs`、`crates/pi-shell/src/process.rs`、`crates/pi-natives/src/oauth_callback/windows.rs`，三处均与上游逐字节一致；后两处在 workspace clippy 于首个失败 crate（pi-vfs）中止并取消排队任务时不暴露，仅当 `check:rs` 实际运行（如工作树含 Rust 改动的 `fastcheck`）才依次显现，因此 fulltest 静态阶段临时只跑 `bun run check:ts`、不含 `check:rs` 的 fmt/clippy 半边；`fastcheck` 别名本身不变（无 Rust 相关改动时 run-rs-task 以**工作树**为准自跳过 `check:rs` 整个任务——cargo fmt 检查与 clippy 一并跳过，改动已提交后同样跳过；要强制执行设 `CI=1`）。同一上游红色状态还有第二个 Windows 表现（2026-10-07 确认）：上游自身测试 `pi-builtins sed::fast_io::tests::test_file_truncated_after_open` 在 Windows 确定性失败（LineReader 在外部 `set_len(0)` 后读出 0 行，上游 CI 只在 Linux 测试、从不执行该场景），`test:rs` 的 nextest 调用在 Windows 上带过滤表达式排除该单个用例（见 `scripts/run-rs-task.ts` 内注释），Linux 门禁不受影响。同批上游还带入 18 个未过 `oxfmt --check` 的原样文件（2026-10-07 同步 `04c267c37a` 后确认与上游逐字节一致，且上游 lockfile 同样锁定 oxfmt 0.65.0，即上游自身未过其格式门禁）；为使本地门禁保持可用，fork 已按锁定版本将其格式化（格式化产物与上游日后用 0.65.0 格式化的输出一致，届时差异自动消除；上游若先升级 oxfmt 则会产生少量可预期的格式冲突）。恢复条件均为上游转绿后按各文件内注释还原。上游 `rpc-mode.ts` 的 `RpcUserInputGate` 在 e0fc1cf 基线同样与其自身测试矛盾（重入 enqueue 死锁），fork 以最小修复保留在原文件内。
* 受「验证」一节约束，未经用户明确要求的改动处于「未验证」状态；此时 MUST NOT 报告为已验证或已修复。

## 构建与缓存纪律

* NEVER 无理由 `cargo clean`，NEVER 删除当前有效的 `target` 目录：构建缓存属于项目资产，清理必须有具体理由（缓存损坏、废弃配置清理等），定点进行并说明范围。
* 保持构建配置与 `target` 目录稳定：不为提速切换 profile / target 目录 / `RUSTFLAGS` 等构建配置变体；`fastcheck`、`fulltest` 与日常开发复用同一套默认配置与同一份缓存，不引入分叉的构建目录或 flags。
* 最终打包 / 发布 profile 的构建（native addon 打包、release 构建等）只出现在 `fulltest` / `slowtest`，NEVER 进入 `fastcheck`。

## 验证

* fork 验证入口为三级，编排尽量薄并优先复用上游检查与测试入口：`bun run fastcheck`（package.json 别名，即 `bun run check:ts && bun run check:rs`：TS 类型检查、lint、格式 + Rust fmt/clippy 检查，只查不测，不设 fork 侧整体时限，以实际检查结果判定成败）、`bun run fulltest`（`scripts/fulltest.ts`：以 `upstream` 基线差异（`git diff` + 未跟踪文件，文档级差异不触发测试）选择测试目标——**只跑 fork 改过的**：TS 跑「相对基线有差异的 `packages/*/test` 与 `packages/*/src` 内同位 `*.test.ts(x)` 文件」（上游全量 TS 套件是 POSIX 向、由 slowtest 的 Linux CI 覆盖，NEVER 在本地展开到未改动的上游测试）；Rust 委托 `test:rs --affected` 只选「有改动的 crate」（vendored crate 自身被排除在门禁外，其变更按消费者闭包选择，消费者经 `Cargo.lock` 解析；`cargo metadata`/`Cargo.lock` 解析失败、全局 Rust 配置改动或命中已删除/未注册 crate 时回退全量）。native 构建、脚本测试、UI 冒烟固定执行；不含 Python 组件（`bun run test:py` 仅手动）。静态检查临时只跑上游 `check:ts`（原因与恢复条件见「现状与缺口」临时状态条目）。选择逻辑有 UT（`fulltest.test.ts`、`rust-test-scope.test.ts`）。不维护测试白名单、新差异自动纳入、恢复上游的文件自动退出；结果非黑即白、不设豁免，也不设 fork 侧阶段时限——子进程各自拥有 `bun test` 用例级预算；上游全量 TS 分片设计上由 slowtest 的 Linux CI 覆盖，CI 作业临时禁用期间实际未覆盖，见「现状与缺口」）、`bun run slowtest`（fulltest 全部内容 + `wsl/ubuntu-24.04` 阶段 + 自动 push 本地 `main` 到远端、以 `publish_release=true` 触发 GitHub Actions CI 并持续监控直到返回（CI 全绿即创建 fork Release），并输出各阶段耗时；端到端冒烟与安装器 E2E 设计上由该流水线覆盖，CI 作业临时禁用期间实际未覆盖，见「现状与缺口」）。
* `bun run slowtest` 在 fulltest 通过后、主 push / CI 触发前执行 `wsl/ubuntu-24.04` 阶段（`scripts/slowtest-wsl-stage.ts`，仅 Windows 执行，其他平台自动跳过）：按 jch-wsl-git-test Skill 的方式机械化执行——Windows 工作区必须干净（脏即失败），按仓库实际 upstream（或唯一远端）先推送当前 HEAD 并确认远端可取（EXPECTED_SHA）；在 Ubuntu-24.04 WSL2 发行版以 root 于 /root 按 remote 身份定位（必要时经 Git 远端 clone）本仓库，WSL 工作区有未提交改动或本地分支领先/分叉即失败（不清理、不强推、不 reset），仅允许创建分支或快进到 EXPECTED_SHA 并校验 HEAD 一致；确认 bun/git 解析为发行版自身 Linux 路径（非 /mnt/ 挂载）后先 `bun install --frozen-lockfile` 再运行 `bun run fulltest`。任一步失败或 fulltest 退出码非 0 均判 slowtest 失败，不继续主 push、不触发 CI，但 WSL 获取提交所需的前置推送可能已经发生，不自动回滚远端。阶段不设 fork 侧硬时限，挂起的运行由操作者中止。CI 使用唯一 slowtest_run_id 与 HEAD SHA 关联此次运行，不能用同提交的其他运行代替。
* `bun run fastcheck` agent 可按需自主调用，普通 TypeScript 修改后 MUST 运行；纯文档修改只做差异与格式检查。除 fastcheck 外的本地编译、类型检查、测试（含 `bun test`、`bun run test`、`test:*`、`ci:test:*`、`bun run check`、`check:types`、`bun run build`、cargo / bazel / nix 等）以及 push、触发外部流水线，MUST 仅在用户明确要求时进行。
* `bun run fulltest` 只运行当前操作系统对应的测试；`bun run slowtest` 除当前操作系统测试外，唯一跨平台扩展是上述 `wsl/ubuntu-24.04` 阶段（仅 Windows 执行），不维护其他 WSL2/双平台运行能力；Rust 核心测试走 `cargo nextest`，Windows 自动注入 VS Build Tools 的 CMake/Ninja。
* UI 冒烟（原 `jch-dev-ui-test` 能力，已并入 fulltest）MUST 使用 `bun run dev`，仅使用本地当前源码编译的 native addon；不存在则本地编译，不下载或复用其他来源的包。上游同步不运行 UI 测试。
* 上游同步的检查范围、次数和失败处理统一遵循 Skill，不运行全 workspace 检查、完整测试、Rust/native 检查或构建、打包、发布；冲突场景同样不运行编译、类型检查或测试（含 Skill 中列出的 `check:types` 与精确测试），只做源码语义审查，除非用户明确要求。

## 中文文档

* `docs-zh-CN` 不维护翻译：上游 `docs` 的翻译文件已全部删除，后续同步不带入、不恢复；上游 `docs/` 的增删改不触发任何中文站维护。
* `docs-zh-CN` 仅保留 fork 自有内容：`requirements/` 需求目录与 `README.upstream.md` 对照快照。fork 不维护文档站点（VitePress 站点、GitHub Pages 发布与 `collab-web` 托管已于 2026-10-06 需求访谈后取消）。
* 代码 review 或对比上游差异时，只审查 `docs-zh-CN` 内的 fork 新增文档。
