---
name: upstream-release-sync
description: Safely merge the latest formally published can1357/oh-my-pi GitHub Release into this fork's existing local main branch, automatically resolve reliable conflicts, validate sequentially without Rust or native-binary work, and keep origin/upstream as an exact Release mirror. Use when the user asks to sync, merge, update, or pull the newest upstream release/version/tag; 上游发布新版本、同步上游正式版、合入最新 release、按发布页版本升级。 Requires a published GitHub Release, never a tag-only version.
---

# 上游正式 Release 同步

固定目标：

1. 将 `can1357/oh-my-pi` 最新正式 GitHub Release 合入本 fork 已存在的本地 `main`，发生冲突时主动自动解决。
2. 本地合入、验证和 fork 快照全部完成后，使本地 `upstream`、`origin/upstream` 与该 Release commit 精确一致。

<critical>
- MUST 以 GitHub Release API 返回的最新正式 Release 为唯一版本来源；NEVER 用 tag 排序、`git describe`、`git ls-remote` 或 `upstream/main` 猜版本。
- Release MUST 满足 `draft=false`、`prerelease=false`、`published_at` 非空。
- 目标分支固定为已存在的本地 `main`；MUST 用 `git switch --no-guess main`，NEVER 隐式创建。
- MUST 仅合并 Release 的原始 `tag_name`；NEVER merge/pull `upstream/main`。
- merge MUST 使用 `--no-commit`；冲突解决和验证全部通过后才能创建 merge commit。失败 MUST 自动 abort 并验证恢复。
- 冲突 MUST 主动尝试完整解决；只有无法从代码、历史、调用关系和 fork 差异可靠确定正确结果时才回滚并停止。
- 弱机策略：静态检查和直接相关测试 MUST 顺序执行；NEVER 运行完整测试套件、UI/browser/heavy 测试、Docker、benchmark、打包或发布流程。
- NEVER 在本机运行会编译、检查、测试、lint、fmt、clippy、生成或打包 Rust 源码/native 二进制的命令；NEVER 运行 `cargo`、`bazel`、`nix build` 或间接触发这些工作的脚本。
- TS/JS 对 native 包装层的纯静态检查 MAY 运行，但 MUST 先确认脚本不调用 Rust/native 工具链。根级 `bun run check` 包含 Rust 检查，NEVER 运行。
- 所有 Git 命令 MUST 隔离本地 hooks、rerere、签名、自动 maintenance/GC、隐式 tag/submodule push 和交互认证；未知自定义 merge/filter driver → STOP。
- 三个 fork 治理文件 MUST 无条件保留同步前版本：`AGENTS.md`、`.omp/skills/upstream-release-sync/SKILL.md`、`docs-zh-CN/fork.md`；`fork.md` 随后按实际 merge 更新。
- `origin/upstream` 是可重建的纯 Release 镜像，MUST 精确等于 `release_commit`，不得包含 fork-only commit。
- 本地 `upstream` MUST 精确等于 `release_commit` 并跟踪 `origin/upstream`；缺失或 tracking 错误时自动创建/校正。
- 镜像只在本地 `main` 合入、验证和 fork 快照全部完成后更新；非 fast-forward 漂移只允许对 `origin/upstream` 使用精确旧 SHA 的 `--force-with-lease`。
- 任何远端查询失败都 MUST STOP；NEVER 把网络、认证、权限或远端错误误判为“分支不存在”。
- NEVER 自动 push `main`、push tag 或发布 Release；默认自动 push 的唯一 ref 是 `refs/heads/upstream`。
</critical>

## 固定对象与完成条件

- Fork：`jchanghong023/oh-my-pi`
- 目标分支：本地 `main`
- Fork 远端：`origin`
- 上游仓库：`can1357/oh-my-pi`
- 上游远端：`upstream` → `https://github.com/can1357/oh-my-pi.git`
- Release API：`https://api.github.com/repos/can1357/oh-my-pi/releases/latest`
- Release 镜像：本地 `upstream` → `origin/upstream`
- Fork 快照：`docs-zh-CN/fork.md`

仅当以下条件全部满足时报告完成：

1. `release_tag` 来自最新正式 GitHub Release，本地 tag 精确对应 `release_commit`。
2. 本地 `main` 包含 `release_commit` 和同步前 `pre_merge_head`，且同步前未与 `origin/main` 分叉。
3. 新 merge 在提交前通过检查；没有 unresolved conflict；失败路径已安全 abort。
4. `fork.md` 的版本、UTC 日期、Merge 和唯一同步记录与实际 Release merge 一致。
5. 本地 `upstream == origin/upstream == release_commit`，且本地 tracking 正确。
6. 工作区最终 clean；未自动 push `main` 或 tag。
7. 未运行本地 hook、rerere 自动复用、签名、自动 maintenance/GC、Rust/native 工具链或完整重型测试。

## 1. 强前置检查

### 1.1 仓库、历史和操作状态

从仓库根目录先执行最小只读检查：

```bash
git rev-parse --is-inside-work-tree
git rev-parse --show-toplevel
test "$(git rev-parse --is-shallow-repository)" = "false"
test -z "$(git -c core.fsmonitor=false status --porcelain=v1 --untracked-files=all)"
```

浅克隆或工作区不干净 → STOP。NEVER 自动 unshallow、stash、commit、reset、clean 或丢弃用户改动。

显式检查正在进行的 Git 操作：

```bash
for marker in MERGE_HEAD CHERRY_PICK_HEAD REVERT_HEAD REBASE_HEAD AM_HEAD BISECT_START; do
  marker_path="$(git rev-parse --git-path "$marker")"
  test ! -e "$marker_path" || exit 1
done
for state_dir in rebase-merge rebase-apply sequencer; do
  state_path="$(git rev-parse --git-path "$state_dir")"
  test ! -e "$state_path" || exit 1
done
```

任一状态存在 → STOP。NEVER 接管已有操作。

### 1.2 建立隔离的 Git 调用

可靠区分配置型 hook 查询结果：

```bash
configured_hook_commands="$(git config --show-origin --get-regexp '^hook\..*\.command$' 2>/dev/null)"
hook_query_status=$?
if [ "$hook_query_status" -eq 0 ]; then
  printf '%s\n' "$configured_hook_commands"
  exit 1
fi
test "$hook_query_status" -eq 1 || exit 1
```

发现 `hook.*.command` 或查询失败 → STOP。

定义唯一 Git 入口：

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
    -c push.pushOption= \
    -c push.recurseSubmodules=no \
    -c push.useForceIfIncludes=false \
    -c remote.origin.mirror=false \
    -c rerere.enabled=false \
    -c rerere.autoupdate=false \
    -c maintenance.auto=false \
    -c gc.auto=0 \
    -c fetch.writeCommitGraph=false \
    "$@"
}
```

从这里开始，MUST 使用 `git_guarded` 执行所有 Git 命令，包括只读命令；若执行工具不保留 shell function，必须把同样的环境变量和 `-c` 配置直接附到每次调用。

### 1.3 远端与外部 Git 驱动

读取全部 fetch/push URL。`origin` MUST 恰好只有一个 push URL，且 fetch/push 都解析为 `jchanghong023/oh-my-pi`；SSH alias 无法展开确认、多个 push URL、`remote.origin.mirror=true`、自定义 `remote.origin.receivepack/uploadpack` → STOP。

`upstream` 缺失时：

```bash
git_guarded remote add upstream https://github.com/can1357/oh-my-pi.git
```

若已存在，其 fetch URL MUST 解析为 `can1357/oh-my-pi`；错误或不确定 → STOP，NEVER 自动改写。

MUST 读取所有生效的 system/global/repository/info attributes 及相关 Git 配置，审计本仓库实际使用的 `merge=<driver>`、`filter=<driver>`：

- 内建 text/binary/union 行为允许。
- 标准 Git LFS filter 允许，但始终设置 `GIT_LFS_SKIP_SMUDGE=1`，禁止自动下载大对象。
- 自定义 merge/filter 命令、Git LFS merge driver 的 `--program`、或任何可能调用包管理器、编译器、构建、网络脚本的 driver → STOP。
- 配置解析失败或无法证明 driver 安全 → STOP。

### 1.4 固定并对齐本地 `main`

```bash
git_guarded show-ref --verify --quiet refs/heads/main
git_guarded switch --no-guess main
test "$(git_guarded branch --show-current)" = "main"
test -z "$(git_guarded status --porcelain=v1 --untracked-files=all)"
git_guarded fetch origin "+refs/heads/main:refs/remotes/origin/main"
```

本地 `main` 不存在、切换失败、fetch 失败或 `origin/main` 不存在 → STOP。

判定关系：

- 本地 `main` 是 `origin/main` 祖先 → `git_guarded merge --ff-only origin/main`。
- `origin/main` 是本地 `main` 祖先 → 本地相同或领先，继续。
- 两者均不是对方祖先 → STOP；NEVER 自动 merge/rebase/reset `origin/main`。

`main` 无 tracking 时设置 `origin/main`；已跟踪其他 ref 时 STOP：

```bash
main_tracking="$(git_guarded for-each-ref --format='%(upstream:short)' refs/heads/main)"
if [ -z "$main_tracking" ]; then
  git_guarded branch --set-upstream-to=origin/main main
elif [ "$main_tracking" != "origin/main" ]; then
  exit 1
fi
```

再次确认 clean 后记录：

```bash
pre_merge_head="$(git_guarded rev-parse main)"
```

### 1.5 治理文件与 worktree

MUST 完整读取：

- `AGENTS.md`
- `.omp/skills/upstream-release-sync/SKILL.md`
- `docs-zh-CN/fork.md`

三者缺失、不可读，或 `fork.md` 没有唯一“当前上游基线”和唯一“上游同步记录”段 → STOP。

若任一 worktree 正检出本地 `upstream` → STOP，避免移动使用中的分支。

## 2. 确定并获取最新正式 Release

读取 Release API，记录 `tag_name`、`html_url`、`published_at`、`draft`、`prerelease`。仅在下列条件成立时继续：

```text
draft == false
prerelease == false
published_at != null
html_url 属于 can1357/oh-my-pi/releases/tag/
```

`release_tag` MUST 等于原始 `tag_name`。API 不可达、限流、字段缺失或不是正式 Release → STOP，NEVER 降级到其他版本发现方式。

仅 fetch 已选 tag：

```bash
git_guarded fetch upstream "refs/tags/$release_tag:refs/tags/$release_tag"
git_guarded show-ref --verify --quiet "refs/tags/$release_tag"
release_commit="$(git_guarded rev-parse "$release_tag^{commit}")"
git_guarded cat-file -e "$release_commit^{commit}"
```

fetch 失败时只允许只读查询该精确 tag 诊断。本地与远端同名 tag 对象不同 → STOP，NEVER 覆盖；网络/认证/权限错误也直接 STOP。

## 3. 准备未提交 merge

确认仍在 `main`、HEAD 未变且 clean。若 `release_commit` 已是 `main` 祖先，标记 `already_contained=true`，进入第 6 节。

否则：

```bash
merge_had_conflicts=false
if git_guarded merge --no-ff --no-commit --no-edit "$release_tag"; then
  initial_conflicted_paths=""
else
  merge_had_conflicts=true
  initial_conflicted_paths="$(git_guarded diff --name-only --diff-filter=U)"
fi
merge_head_path="$(git_guarded rev-parse --git-path MERGE_HEAD)"
```

状态要求：

- 有效 merge MUST 存在 `MERGE_HEAD` 且其值精确等于 `release_commit`。
- merge 失败但无 `MERGE_HEAD`，或报告冲突却无 U 路径 → 不是普通冲突；确认 `HEAD == pre_merge_head` 且工作区 clean 后 STOP，否则保留现场准确报告。
- `MERGE_HEAD` 存在但错误 → 第 5.5 节 abort 后 STOP。

有效 merge 建立后，不论是否冲突，恢复三个治理文件：

```bash
git_guarded restore --source="$pre_merge_head" --staged --worktree -- \
  AGENTS.md \
  .omp/skills/upstream-release-sync/SKILL.md \
  docs-zh-CN/fork.md
```

## 4. 自动解决冲突

若 `merge_had_conflicts=true`：

1. 三个治理文件保持 fork 版本。
2. 其他文件逐文件理解双方意图；NEVER 批量选 `--ours`/`--theirs`。
3. 以 `fork.md` 的当前 fork 功能为保留基线，同时迁移 Release 的新接口、类型、数据结构、调用方和行为。
4. 修改、移动或删除导出符号前搜索全部 references，并审查调用方及测试。
5. Lockfile：先正确合并 manifests，再运行 `bun install --lockfile-only --ignore-scripts`；确认除 manifests/lockfile 外无生成文件，NEVER 升级无关依赖。
6. 证据不足或语义不能可靠兼容 → 第 5.5 节 abort，不留下半完成 merge。
7. NEVER 使用 rebase、squash、cherry-pick、`git reset --hard` 或全局 ours/theirs 策略。

解决后逐文件 `git_guarded add`，要求无 unmerged、无 unstaged、无 untracked 文件。

## 5. 提交前弱机验证

所有验证都在 merge commit 前执行；任何失败进入第 5.5 节。

### 5.1 Git 检查与 index 快照

```bash
git_guarded diff --cached --check
test "$(git_guarded rev-parse MERGE_HEAD)" = "$release_commit"
test -z "$(git_guarded diff --name-only)"
test -z "$(git_guarded ls-files -u)"
test -z "$(git_guarded ls-files --others --exclude-standard)"
validation_index_tree="$(git_guarded write-tree)"
```

审查 staged diff，确认无冲突标记、误删治理文件、无关生成文件或异常全仓格式化。

### 5.2 审计脚本图

运行任何 Bun script 前，MUST 读取合并结果中的：

- 根 `package.json` 的目标 script 及对应 pre/post script；
- 所有 workspace `package.json` 的 `check` 及对应 pre/post script；
- 拟运行精确测试的配置和脚本。

出现 Rust/native 工具链、`run-rs-task`、`cargo`、`bazel`、`nix build`、native codegen、打包、发布、Docker、隐式安装或未知间接命令 → 禁止执行并 abort。缺少 Bun/依赖时也 abort，NEVER 自动完整 `bun install`。

### 5.3 顺序 TS-only 静态检查

当前默认批准的弱机命令是根 `check:ts` 的显式顺序等价形式：

```bash
bun run check:tools
bun run --sequential --workspaces --if-present check
```

仅当第 5.2 节确认每个实际 workspace `check` 都是 TS/JS/配置静态检查时运行。若出现不安全 workspace，逐个运行其余安全 workspace；任何受本次 merge 影响的 workspace 无安全静态检查 → abort。

无冲突路径在本节执行上述命令一次；冲突路径先进入第 5.4 节，在 `fastcheck` 后执行上述命令一次，NEVER 重复执行。

NEVER 运行根 `bun run check`、任何 `*:rs`、`build`、`build:native`、`ci:test:full`、`cargo`、`bazel`、`nix build` 或 native binary 命令。

### 5.4 冲突路径附加验证与通用不可变检查

仅当 `merge_had_conflicts=true`：

1. 审计后运行 `bun run fastcheck`。
2. 随后执行第 5.3 节顺序静态检查一次。
3. 对 `initial_conflicted_paths` 中的实现文件，仅逐个运行最直接、已存在、不会构建 native、更新 snapshot 或写入仓库的精确测试文件。
4. Shell/Python 冲突可运行不写文件的 `bash -n` / Python AST 解析；NEVER 为验证安装工具。
5. 不存在安全直接测试时记录 `focused_tests=none found`，不得编造。
6. Rust/native 源码即使冲突，也 NEVER 在本机运行其工具链；只做逐行语义审查和非 Rust 调用侧静态检查，并报告验证边界。

无冲突路径不运行 `fastcheck` 或 focused tests。

无论有无冲突，所有实际检查结束后、commit 前都必须证明检查没有改写 index、worktree 或生成 untracked 文件：

```bash
test "$(git_guarded write-tree)" = "$validation_index_tree"
test -z "$(git_guarded diff --name-only)"
test -z "$(git_guarded ls-files --others --exclude-standard)"
git_guarded diff --cached --check
```

### 5.5 失败时安全回滚

```bash
merge_head_path="$(git_guarded rev-parse --git-path MERGE_HEAD)"
if [ -e "$merge_head_path" ]; then
  git_guarded merge --abort
fi
test "$(git_guarded rev-parse HEAD)" = "$pre_merge_head"
test -z "$(git_guarded status --porcelain=v1 --untracked-files=all)"
```

无 `MERGE_HEAD` 时不运行必然失败的 abort，只验证状态未变。abort/恢复验证失败时 NEVER 改用 `reset --hard`；保留现场报告。回滚成功后状态为 blocked，不得更新镜像。

### 5.6 创建并验证 merge commit

全部通过后：

```bash
git_guarded commit --no-edit --no-gpg-sign
merge_commit="$(git_guarded rev-parse HEAD)"
test "$(git_guarded rev-parse "$merge_commit^1")" = "$pre_merge_head"
test "$(git_guarded rev-parse "$merge_commit^2")" = "$release_commit"
test -z "$(git_guarded status --porcelain=v1 --untracked-files=all)"
```

## 6. 更新和校验 `fork.md`

### 6.1 新建 merge

以 `merge_commit` 的 committer timestamp 转 UTC `YYYY-MM-DD`，并取前 10 位 hash。更新：

- “当前上游基线”的版本、同步日期、Merge；
- “上游同步记录”唯一一条当前 Release 记录；
- “Fork 改动”：删除上游已等价实现的条目，保留实际差异，更新因冲突解决改变的描述。

验证文档不变量后，MUST 仅暂存该文件并再次检查提交范围：

```bash
git_guarded add docs-zh-CN/fork.md
test "$(git_guarded diff --cached --name-only)" = "docs-zh-CN/fork.md"
test -z "$(git_guarded diff --name-only)"
test -z "$(git_guarded ls-files --others --exclude-standard)"
git_guarded diff --cached --check
git_guarded commit --no-gpg-sign -m "docs(fork): record upstream ${release_tag}"
fork_doc_commit="$(git_guarded rev-parse HEAD)"
```

验证该 commit 只修改 `fork.md`，且父提交是 `merge_commit`。

### 6.2 Release 已包含

即使 `fork.md` 已写相同 tag，也 MUST 校验日期和 Merge。定位 `main` first-parent 历史中第二父提交精确等于 `release_commit` 的 merge commit；要求恰好一个。

以该 merge 的 committer UTC 日期和前 10 位 hash 校验版本、日期、Merge 及唯一同步记录。全部一致 → 不提交；不一致 → 校正并按第 6.1 节的暂存、范围检查和 docs commit 流程执行。0 或多条匹配 → STOP，保持 clean，不更新镜像。

### 6.3 文档不变量与失败

- “当前上游基线”恰好一个。
- “上游同步记录”恰好一个且仅含当前 Release 一条记录。
- 版本、UTC 日期和 Merge hash 与唯一实际 merge 精确一致。
- 新 docs commit 只修改 `fork.md`。

文档修改或提交前验证失败 → 恢复 `fork.md` 并确认 clean，不更新镜像；已创建的本地 Release merge 报告为 partial，NEVER 报 completed。

## 7. 最后同步 Release 镜像

只有本地 merge、验证、`fork.md` 全部成功且工作区 clean 后执行。保存 `main_final_head`，再次确认没有 worktree 使用本地 `upstream`。

查询实际远端 ref；失败 STOP，成功且输出为空才表示不存在。精确查询只能返回一条。

### 7.1 推送唯一镜像 ref

所有 push MUST 显式使用：

```text
--no-verify --no-follow-tags --no-signed --recurse-submodules=no
```

远端不存在，使用空 expected-value lease防止并发创建：

```bash
git_guarded push --no-verify --no-follow-tags --no-signed --recurse-submodules=no \
  --force-with-lease="refs/heads/upstream:" \
  origin "${release_commit}:refs/heads/upstream"
```

远端存在时，先精确 fetch 到 `origin/upstream` 并确认其 SHA 等于刚查询的 `expected_origin_upstream`：

```bash
git_guarded fetch origin "+refs/heads/upstream:refs/remotes/origin/upstream"
test "$(git_guarded rev-parse refs/remotes/origin/upstream)" = "$expected_origin_upstream"
```

若已经等于 `release_commit`，不 push。若旧 SHA 是 `release_commit` 的祖先，普通 push：

```bash
git_guarded push --no-verify --no-follow-tags --no-signed --recurse-submodules=no \
  origin "${release_commit}:refs/heads/upstream"
```

若不是 fast-forward，仅对该 ref 使用精确 lease：

```bash
git_guarded push --no-verify --no-follow-tags --no-signed --recurse-submodules=no \
  --force-with-lease="refs/heads/upstream:$expected_origin_upstream" \
  origin "${release_commit}:refs/heads/upstream"
```

任何 push 失败后只重新查询一次：远端已等于 `release_commit` 则视为并发完成；否则 STOP，NEVER 用新 lease 自动覆盖重试。

### 7.2 建立本地镜像 tracking

远端确认正确后：

```bash
git_guarded branch -f upstream "$release_commit"
git_guarded fetch origin "+refs/heads/upstream:refs/remotes/origin/upstream"
git_guarded branch --set-upstream-to=origin/upstream upstream
```

分支被其他 worktree 占用 → STOP，NEVER 绕过保护。

### 7.3 精确验证

必须同时满足：

```text
refs/heads/upstream == release_commit
refs/remotes/origin/upstream == release_commit
实际远端 refs/heads/upstream == release_commit
本地 upstream tracking == origin/upstream
main == main_final_head
```

## 8. 最终报告

最终再次验证：本地 `main` 包含 `release_commit` 与 `pre_merge_head`、工作区 clean、文档和镜像不变量成立、执行记录无 hooks/rerere/signing/auto-maintenance、无 Rust/native 工具链、无完整重型测试。

```text
Release: <release_tag>
Release URL: <html_url>
Published: <published_at>
Release commit: <release_commit>
Main: merged @ <merge_commit> / already contained
Conflict resolution: none / auto-resolved / blocked and aborted
Validation: staged Git check; sequential TS static checks; focused tests <list/none>; all passed/failed
Git isolation: hooks/rerere/signing/auto-maintenance/implicit pushes disabled
Rust/native local toolchain: not run
Fork snapshot: updated @ <fork_doc_commit> / already current / blocked
Upstream mirror: local upstream == origin/upstream == <release_commit> / blocked
Working tree: clean / not clean
Main or tag push: not performed
```

<critical>
- 核心关系：本地 `main` 包含 `release_commit`；本地 `upstream == origin/upstream == release_commit`。
- merge 在 commit 前验证；失败自动 abort；镜像最后更新。
- 三个治理文件始终保留 fork 版本；`fork.md` 再按实际 merge 更新。
- 本机绝不运行 Rust/native 工具链或完整重型测试套件。
- NEVER 同步 `upstream/main`；NEVER 自动 push `main` 或 tag。
</critical>
