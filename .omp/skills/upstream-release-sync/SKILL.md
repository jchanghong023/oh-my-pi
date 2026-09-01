---
name: upstream-release-sync
description: Keep this fork continuously aligned with the exact current HEAD of can1357/oh-my-pi main. On every run, inspect only the fixed upstream refs/heads/main and origin/upstream, perform a true no-op when current, otherwise merge the verified upstream commit into the existing local main, resolve reliable conflicts, avoid Rust/native work, update the fork snapshot, and mirror that commit to origin/upstream. The historical skill name and path are retained for compatibility; GitHub Releases and tags are never consulted.
---

# 同步上游 `main`

历史路径保留；只同步固定上游 `main`，不跟踪 Release/tag。

<critical>
- 唯一上游：`https://github.com/can1357/oh-my-pi.git` 的 `refs/heads/main`。
- 只操作固定上游 ref 与 fork 的 `origin/upstream`。
- NEVER 查询/操作 Release、tag、`origin/main`、其他远程分支。
- 当前状态一致时 MUST 真正 no-op。
- NEVER 运行 Rust/native、完整测试、打包、发布。
- NEVER push `main` 或 tag。
</critical>

## 0. 快速门禁

1. 用 `ls-remote --heads` 读取固定上游 `refs/heads/main`；结果必须是唯一合法 SHA。
2. 读取本地 `main`、`main:docs-zh-CN/fork.md`、origin fetch/push URL、`origin/upstream` 与本地镜像 refs。
3. 快照基线必须存在、格式唯一、属于本地 `main` 历史；origin 必须是 `jchanghong023/oh-my-pi`。
4. 上游 SHA = 快照基线：
   - 镜像一致 → 返回 `upstream main already current`；不 fetch、不检查、不测试。
   - 镜像缺失/漂移 → 仅执行“更新镜像”。
5. 上游 SHA ≠ 基线 → 继续集成。

## 1. 获取与集成

- 要求 clean 工作区、现有本地 `main`、无进行中的 Git 操作；NEVER stash/reset/clean。
- 保留当前 `AGENTS.md`、本 Skill、`docs-zh-CN/fork.md`。
- 精确 fetch 上游 ref → `refs/omp-sync/upstream-main`；禁止 tag。
- 再次查询远端 HEAD；目标移动则重新 fetch/确认一次，再移动即停止。
- 快照基线必须是目标祖先；`main` 与目标必须有 merge base。
- shallow 缺历史时 MAY 仅定向 deepen 所需 refs；NEVER unshallow。
- 读取目标 `packages/coding-agent/package.json` version。
- 目标已包含于 `main` → 不创建空 merge；否则：
  `git merge --no-ff --no-commit --no-edit refs/omp-sync/upstream-main`。
- merge 后恢复并暂存三个治理文件的 fork 版本。

## 2. 冲突

- 逐文件合并双方意图；NEVER 批量选 ours/theirs。
- 保留 fork 功能，迁移上游接口、类型、调用方、行为。
- 导出符号变更前检查 references 与直接调用方。
- lint/format/fastcheck 迁移到上游现行工具；NEVER 保留已删除工具。
- Lockfile 冲突先合并 manifests；必要时无脚本重建。
- Rust/native 冲突只做语义审查；无法可靠解决才 abort。
- 结束时不得有 unmerged、unstaged、意外 untracked 文件。

## 3. 验证与提交

- 必须通过 `git diff --cached --check`；仅修正上游引入的空白错误。
- 检查冲突标记、治理文件、异常全仓格式化、无关生成物。
- 依赖缺失时 MAY 执行 `bun install --frozen-lockfile --ignore-scripts`。
- TS 或工具链受影响时只运行 `bun run fastcheck`；NEVER 运行其他测试或完整检查。
- `fastcheck` 失败 → 修复合并引入的问题并重跑；不要仅因可修复 lint/type 错误 abort。
- 只有结果不可靠、无法安全修复或 Git 状态损坏时 abort；恢复原 HEAD 与 clean 工作区。
- 成功后提交 `sync(upstream): merge main@<目标前12位>`，禁 hooks/签名。
- 验证 merge commit：第一父 = 原 `main`，第二父 = 目标。

## 4. 更新快照

更新 `docs-zh-CN/fork.md`：

- 当前基线：`can1357/oh-my-pi@main`、SemVer 核心三段、完整目标 SHA、UTC 日期、Integration 前 10 位。
- “上游同步记录”只保留当前一条：日期、目标前 12 位、完整 package version、Integration 前 10 位。
- 只复核上游区间与冲突直接影响的 fork 差异；NEVER 全仓重审。
- 只提交 `fork.md`；commit 父必须是 Integration。

## 5. 更新镜像

- 前提：`main` 包含目标，`fork.md` 已记录目标，工作区 clean。
- 只查询/更新 `origin/upstream`；目标是已集成的上游 SHA，不含 fork commits。
- 远端不同 → 用精确 `force-with-lease` push；NEVER push `main`/tag。
- 刷新 `refs/remotes/origin/upstream`；创建/移动本地 `upstream` 并跟踪它。
- 最终远端、本地 branch、tracking、remote-tracking refs 必须全等于目标。

## 6. 清理与报告

- 删除 `refs/omp-sync/upstream-main`。
- 报告：旧/新上游 SHA、Integration、冲突、`fastcheck`、快照 commit、镜像、工作区。

<critical>
- 只认固定上游 `refs/heads/main` 当前 HEAD。
- 无变化 MUST no-op；有变化 MUST 验证前进关系与 fork 契约。
- 可修复验证错误 MUST 修复后重验；仅不可安全完成时 abort。
- NEVER 运行 Rust/native、完整测试、打包、发布。
- NEVER push `main` 或 tag。
</critical>
