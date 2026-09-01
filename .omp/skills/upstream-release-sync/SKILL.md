---
name: upstream-release-sync
description: Quickly detect whether can1357/oh-my-pi has a new formal GitHub Release; if so, merge it into this fork's existing local main, automatically resolve reliable conflicts, validate on a low-resource machine without Rust/native builds, and keep origin/upstream as an exact Release mirror. Use for 更新上游、同步上游正式版、合入最新 release、按发布页版本升级。 Never sync upstream/main or tag-only versions.
---

# 上游正式 Release 同步

固定目标：

1. **先快速判断是否真的有新 Release**；没有新版本时立即结束，不做历史补全、分支切换、脚本审计或测试。
2. 有新 Release 时，将其合入本 fork 已存在的本地 `main`，冲突由代理主动解决。
3. 本地合入、验证和 `fork.md` 更新成功后，使本地 `upstream`、`origin/upstream` 精确等于该 Release commit。

<critical>
- 第 0 节快速门禁 MUST 是第一步；NEVER 在确认存在新 Release 前执行 unshallow/deepen、fetch `origin/main`、切换分支、审计全部脚本、运行 Bun 或创建长 TODO。
- 最新正式 Release 仅由 GitHub Release API 决定，必须满足 `draft=false`、`prerelease=false`、`published_at` 非空；NEVER 用 tag 排序、`git describe` 或 `upstream/main` 猜版本。
- 若 Release tag 与 `main:docs-zh-CN/fork.md` 的当前基线相同，进入快速 no-op／镜像修复路径；浅克隆完全允许，NEVER 要求用户手动 unshallow。
- 只有确认存在新 Release 且确实需要历史时，才自动按需 deepen；仍不足时自动 unshallow。NEVER 仅因仓库是浅克隆而停止，也 NEVER 把手动 unshallow 作为前置要求。
- 目标分支固定为已存在的本地 `main`；NEVER 隐式创建，NEVER 合入其他 fork 分支，NEVER merge/pull `upstream/main`。
- merge 使用 `--no-ff --no-commit`；冲突解决和验证通过后才提交。失败必须 `git merge --abort` 并验证恢复。
- 本机弱机策略：只检查本次改动和受影响 workspace，全部顺序执行；NEVER 扫描/测试所有 workspace，NEVER 运行完整测试套件、UI/browser/heavy、Docker、benchmark、打包或发布流程。
- NEVER 在本机运行 Rust/native build、check、test、lint、fmt、clippy、codegen 或 packaging；NEVER 运行 `cargo`、`bazel`、`nix build`、根级 `bun run check` 或间接触发这些工作的脚本。
- `AGENTS.md`、本文件、`docs-zh-CN/fork.md` 始终保留同步前 fork 版本；`fork.md` 在 merge 后按实际 Release 更新。
- `origin/upstream` 是可重建的纯 Release 镜像，不承载 fork commit；默认自动 push 的唯一 ref 是 `refs/heads/upstream`。NEVER 自动 push `main` 或 tag。
</critical>

## 固定对象

- Fork：`jchanghong023/oh-my-pi`
- 目标分支：本地 `main`
- Fork 远端：`origin`
- 上游仓库：`can1357/oh-my-pi`
- 上游 URL：`https://github.com/can1357/oh-my-pi.git`
- 上游远端名：`upstream`
- Release API：`https://api.github.com/repos/can1357/oh-my-pi/releases/latest`
- Release 镜像：本地 `upstream` → `origin/upstream`
- Fork 快照：`docs-zh-CN/fork.md`

## Git 隔离入口

网络查询及所有写 ref、index、worktree、commit、tracking 或远端的命令统一使用：

```bash
git_guarded() {
  GIT_TERMINAL_PROMPT=0 \
  GCM_INTERACTIVE=Never \
  GIT_LFS_SKIP_SMUDGE=1 \
  command git \
    -c core.hooksPath=/dev/null \
    -c core.fsmonitor=false \
    -c commit.gpgSign=false \
    -c push.gpgSign=false \
    -c push.followTags=false \
    -c push.recurseSubmodules=no \
    -c rerere.enabled=false \
    -c rerere.autoupdate=false \
    -c maintenance.auto=false \
    -c gc.auto=0 \
    -c fetch.writeCommitGraph=false \
    "$@"
}
```

push 额外使用 `--no-verify --no-follow-tags --no-signed --recurse-submodules=no`。

# 0. 快速 Release 门禁——永远先执行

本节目标是用最少读取和最多几个轻量远端查询判断“有没有新版本”。不要先创建长 TODO；门禁确认需要更新后再建立后续任务。

## 0.1 读取最新正式 Release

用 Read 工具读取 Release API，提取：

```text
tag_name
html_url
published_at
draft
prerelease
```

字段不完整、API 失败、草稿或预发布 → STOP。设置：

```text
release_tag = 原始 tag_name
```

## 0.2 读取当前声明基线并确认 fork 身份

只做轻量只读检查，不要求完整历史，也不切分支：

```bash
git rev-parse --is-inside-work-tree
git show-ref --verify --quiet refs/heads/main
fork_snapshot="$(git show main:docs-zh-CN/fork.md)"
git remote get-url --all origin
git remote get-url --push --all origin
```

`origin` 的 fetch/push URL 必须唯一解析为 `jchanghong023/oh-my-pi`；缺失、多个不同目标、其他仓库或无法确认的 SSH alias → STOP。不得在身份未确认时报告镜像正确或执行 push。

从 `fork_snapshot` 提取：

- 唯一“当前上游基线”版本 `baseline_tag`；
- 唯一“上游同步记录”，且该记录引用 `baseline_tag`。

结构不唯一或无法解析 → 进入第 1 节严格检查，不得假装无更新。

## 0.3 精确解析 Release commit

仅查询该 tag，不 fetch 历史：

```bash
if ! tag_lines="$(git_guarded ls-remote --tags \
  https://github.com/can1357/oh-my-pi.git \
  "refs/tags/$release_tag" "refs/tags/$release_tag^{}")"; then
  exit 1
fi
```

要求恰好一个直接 tag ref，最多一个 peeled ref。若有 peeled ref，以 peeled SHA 为 `release_commit`；否则以直接 SHA 为 `release_commit`。查询失败、缺失或歧义 → STOP。

## 0.4 判定

### A. `release_tag != baseline_tag`

确认有新 Release，进入第 1 节。此时才允许创建后续 TODO、补历史、merge 和验证。

### B. `release_tag == baseline_tag`

这是**无新版本路径**。只检查镜像状态：

```bash
if ! origin_upstream_line="$(git_guarded ls-remote --heads origin refs/heads/upstream)"; then
  exit 1
fi
```

同时读取本地 `upstream` SHA 与 tracking（不存在视为空）。

若同时满足：

```text
实际 origin/upstream == release_commit
本地 upstream == release_commit
本地 upstream tracking == origin/upstream
```

立即报告：

```text
Release: <release_tag>（无新版本）
Main: 未修改
Upstream mirror: already current
Shallow repository: accepted; no history expansion performed
Checks/tests: not run
Mirror push: not needed
Main/tag push: not performed
```

然后结束。MUST NOT 继续执行任何后续章节。

若 Release 未变化但镜像缺失或漂移，只执行第 7 节“镜像修复”；不得 deepen/unshallow、切换 `main`、merge、运行 Bun 或测试。镜像修复后立即报告结束，并准确写明 `Mirror push: performed / not needed`。

# 1. 新 Release 的严格前置检查

仅由第 0.4-A 进入。

## 1.1 工作区和 Git 状态

```bash
test -z "$(git_guarded status --porcelain=v1 --untracked-files=all)"
```

工作区不干净 → STOP；NEVER 自动 stash、reset、clean 或提交用户改动。

显式检查：

```text
MERGE_HEAD、CHERRY_PICK_HEAD、REVERT_HEAD、REBASE_HEAD、AM_HEAD、BISECT_START
rebase-merge、rebase-apply、sequencer
```

任一存在 → STOP。检查其他 worktree；本地 `upstream` 被任一 worktree 检出时，后续镜像移动将受阻，应在 merge 前 STOP。

## 1.2 远端身份和治理文件

- 再次确认 `origin` 的 fetch/push URL 唯一解析为 `jchanghong023/oh-my-pi`。
- `upstream` 缺失时自动添加上述固定 URL；已存在但指向其他仓库 → STOP。
- 完整读取 `AGENTS.md`、本文件和 `docs-zh-CN/fork.md`。
- 只在真正 merge 前审计实际生效的自定义 merge/filter driver；标准 text/binary/union 和 Git LFS 允许，未知外部命令 → STOP。

## 1.3 固定并对齐本地 `main`

```bash
git_guarded show-ref --verify --quiet refs/heads/main
git_guarded switch --no-guess main
git_guarded fetch --no-tags origin "+refs/heads/main:refs/remotes/origin/main"
```

先比较 SHA；相同直接继续。不同则判定祖先关系：

- 本地 `main` 是 `origin/main` 祖先 → `git_guarded merge --ff-only origin/main`。
- `origin/main` 是本地 `main` 祖先 → 本地领先，保留并继续。
- 两项均失败且仓库为浅克隆 → 按第 2 节自动补历史后重试，不能立即认定分叉。
- 完整历史下仍均失败 → 分叉，STOP；NEVER 自动 merge/rebase/reset `origin/main`。

无 tracking 时设置 `main → origin/main`；错误 tracking → STOP。完成后重新读取 `main:fork.md`：若远端 fast-forward 后基线已等于 `release_tag`，直接转第 7 节镜像检查/修复，不执行 merge 或测试。

记录：

```bash
pre_merge_head="$(git_guarded rev-parse main)"
```

# 2. 浅克隆自动补历史

浅克隆不是错误。仅当新 Release 路径中的祖先关系、merge-base 或历史对账因缺失历史无法确定时执行。

## 2.1 优先增量 deepen

按顺序尝试增量 `64`、`256`、`1024`，每轮只取需要的 ref，并在每轮后立即重试原判定：

```bash
git_guarded fetch --no-tags --deepen=<N> origin "+refs/heads/main:refs/remotes/origin/main"
git_guarded fetch --no-tags --deepen=<N> --update-shallow upstream \
  "refs/tags/$release_tag:refs/tags/$release_tag"
```

一旦祖先关系或 merge-base 可确定，立即停止 deepen。不要为了“完整”继续下载历史。

## 2.2 最后自动 unshallow

三轮仍不足且仓库仍 shallow 时，自动执行一次：

```bash
git_guarded fetch --unshallow --no-tags origin \
  "+refs/heads/main:refs/remotes/origin/main"
git_guarded fetch --no-tags upstream \
  "refs/tags/$release_tag:refs/tags/$release_tag"
```

随后重试判定。失败则报告原始网络/权限/Git 错误并 STOP；NEVER 要求用户先手动 unshallow。

# 3. 获取 tag 并准备事务式 merge

若本地尚无正确 tag：

```bash
git_guarded fetch --no-tags --update-shallow upstream \
  "refs/tags/$release_tag:refs/tags/$release_tag"
```

本地同名 tag 与远端对象不一致 → STOP，NEVER force 覆盖。确认：

```bash
test "$(git_guarded rev-parse "$release_tag^{commit}")" = "$release_commit"
```

若 `release_commit` 已是 `main` 祖先，进入第 6.2 节对账；浅克隆下判定不确定时先执行第 2 节。

否则：

```bash
merge_had_conflicts=false
if git_guarded merge --no-ff --no-commit --no-edit "$release_tag"; then
  initial_conflicted_paths=""
else
  merge_had_conflicts=true
  initial_conflicted_paths="$(git_guarded diff --name-only --diff-filter=U)"
fi
```

必须存在 `MERGE_HEAD == release_commit`。merge 失败但没有有效 `MERGE_HEAD`，或声称冲突却没有 U 路径 → 不是普通冲突，按第 5.4 节回滚。

无论是否冲突，恢复三个治理文件：

```bash
git_guarded restore --source="$pre_merge_head" --staged --worktree -- \
  AGENTS.md \
  .omp/skills/upstream-release-sync/SKILL.md \
  docs-zh-CN/fork.md
```

# 4. 自动解决冲突

仅当 `merge_had_conflicts=true`：

1. 三个治理文件保持 fork 版本。
2. 其他文件逐个理解双方意图；NEVER 批量 `--ours`/`--theirs`。
3. 以 `fork.md` 当前差异为保留基线，同时迁移 Release 的新接口、类型、数据结构、调用方和行为。
4. 修改、移动或删除导出符号前搜索全部 references，并审查调用方及相关测试。
5. Lockfile 冲突：先合并 manifests，再运行 `bun install --lockfile-only --ignore-scripts`；确认除 manifests/lockfile 外无生成文件。
6. 无法可靠判断 → 第 5.4 节 abort；不得留下半完成 merge。
7. NEVER 使用 rebase、squash、cherry-pick、`git reset --hard` 或全局 ours/theirs 策略。

解决后逐文件 `git_guarded add`，要求无 unmerged、unstaged 和 untracked 文件。

# 5. 提交前弱机验证

验证只针对本次 staged 变更和受影响 workspace，顺序执行。任何失败进入第 5.4 节。

## 5.1 Git 与脚本安全检查

```bash
git_guarded diff --cached --check
test "$(git_guarded rev-parse MERGE_HEAD)" = "$release_commit"
validation_tree="$(git_guarded write-tree)"
```

读取根 `package.json` 及**受影响 workspace** 的 `package.json`，审计拟运行 script 和 pre/post script。含以下任一内容则禁止执行：

```text
cargo、bazel、nix build、run-rs-task、*:rs、native build/codegen/package
Docker、完整 CI/测试套件、隐式 bun install、发布或打包
```

## 5.2 轻量静态检查

按顺序执行：

1. staged 变更含 Biome 管理的 TS/JS/JSON/CSS 等文本时，运行 `bun run check:tools`；否则跳过并记录原因。
2. staged 变更含 TypeScript/JavaScript 源码时，运行 `bun run fastcheck`。
3. 找出发生源码变化的 workspace；只对这些 workspace 逐个运行其经审计、确认不触发 Rust/native 的 `check` script：

```bash
bun --cwd=<affected-workspace> run check
```

NEVER 使用 `bun run --workspaces ...` 扫描全部 workspace，NEVER 运行根级 `bun run check`。

## 5.3 冲突附加验证

仅当发生过冲突：

- 对原始冲突涉及的实现文件，只运行最直接、已存在、不会写仓库或构建 native 的精确测试文件，每个测试顺序执行。
- Shell/Python 冲突可运行 `bash -n` / Python AST 解析。
- 没有安全直接测试时记录 `focused_tests=none found`。
- Rust/native 源码冲突不在本机运行其工具链，只做语义审查和非 Rust 调用侧检查，明确报告验证边界。

## 5.4 失败回滚

```bash
if [ -e "$(git_guarded rev-parse --git-path MERGE_HEAD)" ]; then
  git_guarded merge --abort
fi
test "$(git_guarded rev-parse HEAD)" = "$pre_merge_head"
test -z "$(git_guarded status --porcelain=v1 --untracked-files=all)"
```

abort 失败时 NEVER 改用 `reset --hard`；保留现场并准确报告。回滚成功后不得更新镜像。

## 5.5 提交 merge

检查命令不得改写 index/worktree：

```bash
test "$(git_guarded write-tree)" = "$validation_tree"
test -z "$(git_guarded diff --name-only)"
test -z "$(git_guarded ls-files --others --exclude-standard)"
```

全部通过后：

```bash
git_guarded commit --no-edit --no-gpg-sign
merge_commit="$(git_guarded rev-parse HEAD)"
```

验证其第一父提交为 `pre_merge_head`、第二父提交为 `release_commit`。

# 6. 更新和校验 `fork.md`

## 6.1 新 merge

以 `merge_commit` 的 committer timestamp 转 UTC `YYYY-MM-DD`，取前 10 位 hash，并更新：

- 当前上游基线的版本、同步日期、Merge；
- 唯一一条当前 Release 同步记录；
- Fork 改动：删除上游已等价实现的条目，保留实际差异，更新因冲突解决改变的描述。

只暂存 `docs-zh-CN/fork.md`，检查范围后使用 `git_guarded commit --no-gpg-sign` 创建独立 docs commit。该 commit 的父提交必须是 `merge_commit`，且只修改此文件。

## 6.2 已包含路径

即使 tag 相同，也校验日期和 Merge。定位 `main` first-parent 历史中第二父提交精确等于 `release_commit` 的唯一 merge；浅历史不足时自动执行第 2 节。

以该 merge 的 committer UTC 日期和短 hash 校验版本、日期、Merge 和唯一同步记录。字段不一致则校正并创建只修改 `fork.md` 的 docs commit；0 或多条匹配 → STOP，不更新镜像。

# 7. 快速镜像检查／修复

本节既供第 0 节无新 Release 使用，也供新 merge 完成后使用。它不需要完整历史。

## 7.1 前置安全检查

- 再次确认 `origin` 的唯一 push URL 是 `jchanghong023/oh-my-pi`。
- 确认没有其他 worktree 检出本地 `upstream`；当前 worktree若在 `upstream`，只有工作区 clean 时才切到既有 `main`。
- 若本地没有 `release_commit` 对象，仅从固定上游 URL fetch 该 tag 的深度 1：

```bash
git_guarded fetch --depth=1 --no-tags --update-shallow \
  https://github.com/can1357/oh-my-pi.git \
  "refs/tags/$release_tag:refs/tags/$release_tag"
```

NEVER deepen/unshallow。

## 7.2 更新唯一远端镜像 ref

查询实际远端 `refs/heads/upstream`。查询失败 STOP；输出为空才表示不存在。

- 不存在：使用空 expected-value lease 创建。
- 已存在且等于 `release_commit`：不 push。
- 已存在但不同：使用精确旧 SHA 的 `--force-with-lease`。

所有 push 必须显式：

```text
--no-verify --no-follow-tags --no-signed --recurse-submodules=no
```

refspec 必须是：

```text
<release_commit>:refs/heads/upstream
```

push 失败后只重新查询一次；远端已达到目标则视为并发完成，否则 STOP，不刷新 lease 自动重试。

## 7.3 本地 tracking 和验证

远端正确后：

```bash
git_guarded branch -f upstream "$release_commit"
git_guarded fetch --no-tags origin "+refs/heads/upstream:refs/remotes/origin/upstream"
git_guarded branch --set-upstream-to=origin/upstream upstream
```

必须同时满足：

```text
本地 refs/heads/upstream == release_commit
本地 refs/remotes/origin/upstream == release_commit
实际远端 refs/heads/upstream == release_commit
本地 upstream tracking == origin/upstream
```

# 8. 最终报告

## 无新 Release

```text
Release: <release_tag>（无新版本）
Fast gate: matched fork baseline
Main: not modified
Upstream mirror: already current / repaired
Shallow repository: accepted; no deepen or unshallow
Checks/tests: not run
Mirror push: not needed / performed
Main/tag push: not performed
```

## 有新 Release

```text
Release: <release_tag>
Release commit: <release_commit>
History: already sufficient / auto-deepened / auto-unshallowed
Main: merged @ <merge_commit> / already contained
Conflict resolution: none / auto-resolved / blocked and aborted
Validation: changed-file checks; affected-workspace checks; focused tests <list/none>
Rust/native local work: not run
Fork snapshot: updated @ <fork_doc_commit> / already current / blocked
Upstream mirror: local upstream == origin/upstream == <release_commit> / blocked
Working tree: clean / not clean
Main/tag push: not performed
```

<critical>
- 无新 Release：必须在第 0 节快速结束；浅克隆不是阻塞原因。
- 有新 Release：历史不足由流程自动增量补全，最后才自动 unshallow；不得要求用户手工处理。
- 本机绝不运行 Rust/native 工具链或完整重型测试。
- 核心关系：本地 `main` 包含 `release_commit`；本地 `upstream == origin/upstream == release_commit`。
- NEVER 同步 `upstream/main`；NEVER 自动 push `main` 或 tag。
</critical>
