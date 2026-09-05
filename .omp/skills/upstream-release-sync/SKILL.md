---
name: upstream-release-sync
description: 每日定时或手动将 can1357/oh-my-pi 最新 main 合入个人 fork，保留功能差异并更新 upstream 镜像。仅在执行上游同步时使用，不跟踪 Release 或 tag。
---

# 同步上游 `main`

保留现有 Skill 名称和路径，供定时任务继续调用。本流程只执行同步，不创建定时任务。

## 约定

* 唯一上游：`https://github.com/can1357/oh-my-pi.git` 的 `refs/heads/main` HEAD。
* `main` 集成个人改动；fork 的 `upstream` 精确镜像最近成功合入的上游 commit，供 GitHub PR/差异比较，不含 fork commit。
* 只查询固定上游 ref 与 fork 的远端 `upstream`，NEVER 使用 Release、tag、`origin/main`、其他远程分支或配置型 `upstream/main` 作为来源。
* 只允许推送 fork 的 `upstream`；NEVER 推送 `main` 或 tag，不创建 PR、不打包、不发布。
* MUST 保留 `AGENTS.md`、本 Skill、`docs-zh-CN/fork.md` 的 fork 版本。`fork.md` 是功能差异的唯一清单，保留行为意图而非旧实现。

## 0. 快速门禁

1. 用 `git ls-remote --heads` 查询固定上游 `refs/heads/main`，取得唯一合法 SHA。
2. 只读检查现有本地 `main`、`main:docs-zh-CN/fork.md`、origin fetch/push URL、本地 `upstream`、`origin/upstream` 及其跟踪配置，并查询 fork 远端 `refs/heads/upstream` 的实际 SHA。
3. `fork.md` 的 `Upstream commit` 必须唯一、有效且属于本地 `main` 历史；origin fetch/push 必须均指向 `jchanghong023/oh-my-pi`。不满足则停止。
4. 上游 SHA 等于基线且镜像/跟踪配置一致：返回 `upstream main already current`，立即结束；不切分支、不 fetch、不改 ref、不测试。
5. 上游 SHA 等于基线但镜像缺失或漂移：仅执行第 4 节；否则继续集成。

## 1. 获取与集成

* 要求工作区 clean、无进行中的 Git 操作；NEVER 用 stash/reset/clean 清理用户状态。
* 记录原分支和本地 `main` HEAD，切换到已存在的本地 `main`；保存三个文档的 fork 版本。
* 用 `--no-tags` 精确 fetch 固定上游 `refs/heads/main` 到 `refs/omp-sync/upstream-main`，再查询远端 HEAD。目标移动则重新 fetch/确认一次，再移动即停止。
* 原基线 MUST 是目标祖先，`main` 与目标 MUST 有 merge base；不接受历史改写。浅仓库缺历史时仅可按所需精确 SHA 定向 deepen，NEVER unshallow；无法证明则停止。
* 目标未包含于 `main` 时执行 `git merge --no-ff --no-commit --no-edit refs/omp-sync/upstream-main`；已包含则不创建空 merge，只补齐基线记录。
* 恢复三个文档的 fork 版本，再按本次集成结果更新 `fork.md`，不得被上游覆盖。

## 2. 保留功能与解决冲突

* 以 `fork.md` 为行为契约，优先采用上游最新接口和实现，只复核上游变化与冲突直接影响的条目，不全仓重审。
* 通常逐文件合并双方意图。冲突很大或模块重写时，可将受影响代码整体采用上游版本，再按契约重写 fork 功能；不得直接批量选 ours/theirs 后视为完成，也不得覆盖三个 fork 文档或改写 `main` 历史。
* 上游已提供等价且满足个人需求的行为时，采用上游实现并删除对应差异；不能因冲突难解决而删除仍需保留的功能。
* 接口或导出变化时检查直接调用方；工具链跟随上游，不保留已删除工具。Lockfile 冲突先合并 manifests，必要时无脚本重建。
* Rust/native 冲突仅做源码语义审查；无法可靠解决或无法在允许的验证范围内确认结果时，中止并报告未保留的功能或未验证项。

## 3. 更新记录、验证与提交

* 提交前更新 `fork.md`：保留 `can1357/oh-my-pi@main`、目标 package version（来自 `packages/coding-agent/package.json`）、完整 `Upstream commit`、UTC 同步日期及当前功能差异。不要追加历史、Integration 字段或第二份清单。
* 将基线和功能差异更新纳入同一集成提交；目标已在 `main` 历史中时，只提交必要的文档修正。
* MUST 通过 `git diff --cached --check`，检查冲突标记、三个 fork 文档和变更范围；不得遗留 unmerged、unstaged、意外 untracked 文件或无关生成物，只修正本次涉及的空白错误。
* 无冲突：仅 staged Git 检查；TS 或工具链变化确有必要时运行一次 `bun run fastcheck`。
* 有冲突：按影响选择最多一次 `fastcheck`、安全且相关的 `check:types`、最多 3 个精确测试，顺序执行。先确认脚本不会触发下列禁用工作；依赖缺失时可运行 `bun install --frozen-lockfile --ignore-scripts`。
* 同步期间 NEVER 运行全 workspace 检查、根级 `bun run check`、完整测试、UI/browser/heavy、Docker、benchmark、`jch-localci`、打包、发布，或任何 Rust/native build/check/test/lint/fmt/clippy/codegen/packaging（含 `cargo`、`bazel`、`nix build`）。
* 检查失败且无法在上述预算内修复并验证时，不提交、不更新镜像。未提交的 merge 用 `git merge --abort`；其他中止路径仅撤销本次操作，恢复原分支和工作区，不清理用户原有状态。
* 验证通过后提交 `sync(upstream): merge main@<目标前12位>`，禁 hooks/签名以避免隐式重型任务。若创建 merge commit，确认第一父为原 `main`、第二父为目标；补记文档提交不要求双亲。

## 4. 更新镜像

* 前提：本地 `main` 包含目标，`main:docs-zh-CN/fork.md` 已记录目标，工作区 clean、无进行中的 Git 操作。
* 镜像必须指向已成功集成的上游 SHA，而不是 fork 的集成提交。更新前查询 fork 远端 `refs/heads/upstream`，作为精确 lease；远端不同才 push，使用 `--force-with-lease=refs/heads/upstream:<观察到的SHA>`（分支不存在时期望值为空）。
* lease 失败即停止，不强推、不盲目重试；本地 `upstream` 在其他 worktree 检出时不强制移动。
* 确认远端成功后刷新 `refs/remotes/origin/upstream`，创建或移动本地 `upstream` 并跟踪 `origin/upstream`。最终本地分支、remote-tracking ref、实际远端 SHA 均须等于目标，跟踪配置一致。
* 推送或本地镜像更新失败时保留已验证的集成提交，报告“本地已集成，镜像未完成”；下次由第 0 节进入镜像修复，不重复合并。

## 5. 清理与报告

删除本次使用的 `refs/omp-sync/upstream-main`。简要报告旧/新基线、集成提交、功能保留与冲突结果、实际验证及未验证项、镜像和工作区状态；明确 `main` 未推送。无变化时只报告已是最新。
