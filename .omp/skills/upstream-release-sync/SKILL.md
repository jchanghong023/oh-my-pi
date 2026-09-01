---
name: upstream-release-sync
description: Keep this fork continuously aligned with the exact current HEAD of can1357/oh-my-pi main. On every run, inspect only the fixed upstream refs/heads/main and origin/upstream, perform a true no-op when current, otherwise merge the verified upstream commit into the existing local main, resolve reliable conflicts, avoid Rust/native work, update the fork snapshot, and mirror that commit to origin/upstream. The historical skill name and path are retained for compatibility; GitHub Releases and tags are never consulted.
---

# 持续同步上游 `main`

历史路径保留；语义仅为同步固定上游 `main`，不跟踪 Release/tag。

<critical>
- 唯一上游：`https://github.com/can1357/oh-my-pi.git` 的精确 `refs/heads/main`。
- 唯一远程分支：上述 ref + 本 fork `origin/upstream`。
- NEVER 查询/操作 Release、tag、`origin/main`、配置型 `upstream/main`、其他分支。
- MUST 先执行快速门禁；状态全一致必须真正 no-op。
- fetch 只写 `refs/omp-sync/upstream-main`；验证前不移动镜像或合并。
- 候选必须是当前快照基线的后代；NEVER 接受历史改写、降级、无关历史。
- 新合并必须 `--no-ff --no-commit`；失败安全 abort。
- 同步时保留合并前 `AGENTS.md`、本文件、`docs-zh-CN/fork.md`。
- 本机 NEVER 运行 Rust/native、完整/重型测试、打包、发布。
- 仅当本地 `main` 包含目标且 `fork.md` 已记录目标，MAY 推进 `origin/upstream`。
- NEVER push `main` 或 tag。
</critical>

## 固定约束

- fork 仓库：`jchanghong023/oh-my-pi`。
- 本地 `upstream` 必须跟踪 `origin/upstream`；二者最终精确指向最近成功集成的上游 commit。
- 所有 Git 操作禁用交互、hooks、签名、LFS smudge、自动维护、gc、rerere 自动更新、隐式 tag/submodule push。
- push 必须使用精确 `force-with-lease`，且禁 hooks、tag、签名、submodule 递归。
- `ls-remote` ≤20s；fetch/deepen/专项检查 ≤120s。
- 精确测试最多 3 个，顺序执行；NEVER 无限 timeout。
- push 结果不确定时只复查一次远端；NEVER 盲目重推。
- 所有执行步骤使用 Bash/Git 工具；NEVER 发送到 Python/Eval。

# 0. 快速门禁

1. 仅一次 `ls-remote --heads` 查询固定上游精确 `refs/heads/main`。
2. 输出必须唯一匹配 `<40位小写十六进制SHA><TAB>refs/heads/main`；异常立即停止，不降级到其他发现方式。
3. 不切分支、不补历史，读取本地 `main` HEAD 与 `main:docs-zh-CN/fork.md`。
4. 快照“当前上游基线”必须唯一包含分支、`vMAJOR.MINOR.PATCH`、完整 upstream SHA、`YYYY-MM-DD`、10 位 Integration。
5. “上游同步记录”必须唯一且仅一条，引用 upstream 前 12 位与 Integration 10 位；异常停止。
6. 基线对象必须存在且是 `main` 祖先。仅 shallow 仓库可暂记“祖先未证明”；非 shallow 失败立即停止。
7. 验证 origin 全部 fetch/push URL 唯一解析为 fork 仓库；只远程查询 `origin/upstream`。
8. 读取四项镜像：远端 upstream、本地 upstream、本地 tracking、remote-tracking。

分类：

- 候选 = 基线、祖先已证明、四项镜像一致 → 立即返回 `upstream main already current`；不切分支、fetch、改 ref、检查、测试。
- 候选 = 基线、祖先已证明、镜像不完整 → 仅修复镜像到基线。
- 候选 ≠ 基线 → 继续集成。
- 候选 = 基线、祖先未证明 → `baseline ancestry not provable`，停止；不补历史或改镜像。

快速门禁不创建 TODO、不启动子代理、不重试、不使用 PTY/async。

# 1. 本地前置

仅新提交路径执行：

- 工作区必须 clean；本地 `main` 必须已存在。
- 使用禁猜测方式切换现有 `main`；HEAD 必须仍等于门禁时 HEAD。
- NEVER stash、reset、clean、隐式创建分支。
- 必须无 merge/cherry-pick/revert/rebase/am/bisect/sequencer 状态。
- 完整读取三个治理文件；再次验证 origin URL。
- 删除旧 `refs/omp-sync/upstream-main`。

# 2. 获取与确认目标

1. 精确 fetch 固定上游 ref 到临时 ref；shallow 首次深度 256，非 shallow 保持完整历史；禁止 tag。
2. fetch 后再次精确查询远端 HEAD。
3. 远端移动时仅重新 fetch/确认一次；再次移动 → `upstream main moved repeatedly`，停止。
4. 临时 ref、末次远端 HEAD、目标 SHA 必须完全一致。
5. 当前快照基线必须是目标祖先，且 `main` 与目标必须有 merge base。
6. 非 shallow 验证失败 → `upstream main history rewrite or unrelated history`，停止。
7. shallow 验证失败 → 仅一次定向 `deepen=1024`：固定上游 ref + origin 中门禁时本地 `main` 精确 SHA；NEVER unshallow/扩散查询。
8. deepen 后目标不得移动；仍无法证明 → `targeted history insufficient or upstream main rewritten`，停止。
9. 从目标的 `packages/coding-agent/package.json` 读取唯一 SemVer；原值用于记录，核心三段用于 `vMAJOR.MINOR.PATCH` 基线。解析失败在 merge 前停止；版本不决定是否同步。

# 3. 事务式 merge

- 目标已被 `main` 包含 → 不创建空 merge；Integration 使用进入同步时的 `main` HEAD。
- 否则执行 `--no-ff --no-commit --no-edit` merge；`MERGE_HEAD` 必须等于目标。
- 无论是否冲突，恢复并暂存合并前的三个治理文件。
- merge 失败却无有效 `MERGE_HEAD`，或报告冲突却无 unmerged 路径 → 安全回滚。

冲突处理：

- 逐文件理解双方意图；NEVER 批量选择 ours/theirs。
- 保留 fork 功能，同时迁移上游接口、类型、数据结构、调用方、行为。
- 修改/移动/删除导出符号前检查 references、直接调用方、相关测试。
- manifest/lint/format/fastcheck 冲突必须保留 fork 契约并适配新工具链；不得引用已删除工具/配置。
- Lockfile 冲突先合并 manifests；仅必要时无脚本重建 lockfile，且不得生成其他文件。
- 无法可靠解决 → 回滚。Rust/native 冲突仅语义审查与非 Rust 调用侧检查。
- 完成后不得有 unmerged、unstaged、untracked 文件。

# 4. 窄范围验证与提交

所有 merge：

- staged diff 必须通过 Git whitespace/error 检查。
- `MERGE_HEAD`、工作区、index、untracked、write-tree 必须一致且稳定。
- staged diff 不得含冲突标记、治理文件误删、异常全仓格式化、无关生成物。
- 变更范围仅限上游区间与必要冲突解决。
- 仅上游引入的尾随空白可最小归一化并重验；其他错误回滚。

专项验证仅在有冲突或上游触及 fastcheck/lint/format 契约时运行：

- 只读取根 scripts、实际 fastcheck、冲突 workspace scripts。
- TS 冲突或契约变更：审计 pre/main/post 后运行一次安全 `bun run fastcheck`。
- 冲突 workspace 有安全 `check:types`：审计 pre/main/post 后逐个运行。
- 直接既有测试最多 3 个；禁止全仓/workspace/UI/browser/heavy/native/network 测试。
- Shell/Python/JSON/YAML 冲突仅做轻量语法检查。
- 缺 Bun/依赖、超时、不安全脚本、验证失败 → 回滚。
- 验证不得改写工作树/index；否则回滚。

成功后创建 `sync(upstream): merge main@<目标前12位>` merge commit；禁签名。验证第一父为原 `main`、第二父为目标、工作区 clean。

失败回滚：存在 merge 时执行 abort；HEAD 必须恢复为原 `main`，工作区 clean，删除临时 ref。abort 失败时 NEVER `reset --hard`；保留现场并报告。回滚成功后不得改 `fork.md` 或镜像。

# 5. 更新 fork 快照

快照基线固定记录：

- `can1357/oh-my-pi@main`
- 目标 package SemVer 核心三段
- 完整目标 SHA
- 本次集成 UTC 日期
- Integration 前 10 位

“上游同步记录”仅保留当前一条：日期、目标前 12 位、完整 package version、Integration 前 10 位。

仅复核本次上游区间与冲突直接影响的 fork 差异；NEVER 全仓重审。新 merge 的 Integration = merge commit；already-contained = 进入同步时 `main` HEAD，并明确记录，禁止伪造 merge。

只暂存 `fork.md`，创建独立 docs commit；父提交必须为 Integration，且只修改该文件。字段已一致则不创建空提交。失败时恢复文件、保持 clean、不更新镜像并报告 partial。

# 6. 修复 upstream 镜像

- 无变化修复目标 = 快照基线；成功集成目标 = 新上游 HEAD。
- 再次验证 origin URL；只查询 `origin/upstream` 与四项镜像。
- 四项已一致 → `mirror already current`；不 fetch/push/移动/设置 tracking。
- 修复前确认无 Git 操作状态、`main` 包含目标；移动本地 upstream 前确认无 worktree 检出它。
- 缺目标对象时只能从固定上游 ref 精确 fetch；结果必须等于目标。
- 远端不存在/不同 → 使用空/current 精确 lease 推送目标到 `origin/upstream`；远端已正确则不 push。
- push 后或结果不确定只复查一次；未达到目标立即停止。
- 精确刷新唯一允许的 remote-tracking ref；按需创建/移动本地 upstream 并设置 tracking。
- 最终四项必须完全等于目标。

# 7. 清理与报告

成功且无进行中 Git 操作后删除临时 ref。

报告：固定上游、旧/新 SHA、历史补全、main integration、冲突、实际验证、Rust/native 未运行、fork 快照 commit、镜像、工作区、未查询其他远程分支、未 push main/tag。无变化另报 fast gate 命中、main 未修改、未补历史、未运行检查/测试、镜像 push 状态。

<critical>
- 只认固定上游精确 `refs/heads/main` 当前 HEAD。
- 无变化必须真正 no-op；有变化必须验证稳定 HEAD、前进关系、merge base、fork 契约。
- 浅历史最多一次定向 deepen；NEVER unshallow。
- 本机 NEVER 运行 Rust/native 或完整重型流程。
- 失败 MUST 安全 abort；NEVER 自动 push `main` 或 tag。
</critical>
