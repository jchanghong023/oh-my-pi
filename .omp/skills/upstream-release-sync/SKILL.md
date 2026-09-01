---
name: upstream-release-sync
description: Safely merge the latest formally published can1357/oh-my-pi GitHub Release into this fork's main branch, automatically resolve reliable conflicts, validate sequentially without local Rust/native work, and keep origin/upstream as an exact Release mirror. Use when the user asks to sync, merge, update, or pull the newest upstream release/version/tag; 上游发布新版本、同步上游正式版、合入最新 release、按发布页版本升级。 Requires a published GitHub Release, never a tag-only version.
---

# 上游正式 Release 同步

固定目标：

1. 将 `can1357/oh-my-pi` 最新正式 GitHub Release 合入本 fork 已存在的本地 `main`，发生冲突时主动自动解决。
2. 本地合入、验证和 fork 快照全部完成后，使本地 `upstream`、`origin/upstream` 与该 Release commit 精确一致。

<critical>
- MUST 以 GitHub Release API 返回的最新正式 Release 为唯一版本来源；NEVER 用 tag 排序、`git describe`、`git ls-remote` 或 `upstream/main` 猜版本。
- Release MUST 满足 `draft=false`、`prerelease=false`、`published_at` 非空。
- 目标分支固定为本地 `main`；MUST 显式确认其已存在并用 `git switch --no-guess main` 切换，NEVER 隐式创建。
- MUST 仅合并 Release 的原始 `tag_name`；NEVER merge/pull `upstream/main`。
- merge MUST 使用 `--no-commit`；在创建 merge commit 前完成冲突解决和全部验证。验证失败 MUST 自动 `git merge --abort` 并确认恢复。
- 冲突 MUST 主动尝试完整解决；只有无法从代码、历史、调用关系和 fork 差异可靠确定正确结果时才中止并回滚本次 merge。
- 本地弱机策略：静态检查和直接相关测试 MUST 顺序执行；NEVER 运行完整测试套件、UI/browser/heavy 测试、Docker、benchmark、打包或发布流程。
- 上游同步期间 NEVER 运行任何本地 Rust/native build、check、test、lint、fmt、clippy、codegen 或 packaging；NEVER 运行 `cargo`、`bazel`、`nix build` 或会间接触发这些工作的脚本。
- 根级 `bun run check` 包含 Rust 检查，禁止运行。全仓静态检查必须使用经脚本图复核的 TS-only 顺序命令。
- 所有会改变 ref、index、worktree、commit、tracking 或远端的 Git 命令 MUST 禁用本地 hooks、GPG commit signing 和自动 maintenance/GC；配置型 `hook.*.command` 存在时 STOP。
- 三个 fork 治理文件 MUST 无条件保留同步前版本：`AGENTS.md`、`.omp/skills/upstream-release-sync/SKILL.md`、`docs-zh-CN/fork.md`；即使 Git 无冲突自动合并，也必须恢复，再按本流程更新 `fork.md`。
- `origin/upstream` 是可重建的纯 Release 镜像，MUST 精确等于 `release_commit`，不得包含 fork-only commit。
- 本地 `upstream` MUST 精确等于 `release_commit` 并跟踪 `origin/upstream`；缺失或 tracking 错误时自动创建/校正。
- 镜像只在本地 `main` 合入、验证和 fork 快照全部完成后更新；镜像漂移时仅允许对 `origin/upstream` 使用带精确旧 SHA lease 的 `--force-with-lease`。
- 任何远端查询失败都 MUST STOP；NEVER 把网络、认证、权限或远端错误误判为“分支不存在”。
- NEVER 自动 push `main`、创建 tag 或发布 Release；默认自动 push 的唯一分支是专用镜像 `origin/upstream`。
</critical>

## 固定对象

- Fork：`jchanghong023/oh-my-pi`
- 目标分支：本地 `main`
- Fork 远端：`origin`
- 上游仓库：`can1357/oh-my-pi`
- 上游远端：`upstream` → `https://github.com/can1357/oh-my-pi.git`
- Release API：`https://api.github.com/repos/can1357/oh-my-pi/releases/latest`
- Release 镜像：本地 `upstream` → `origin/upstream`
- Fork 快照：`docs-zh-CN/fork.md`

## 完成条件

仅当以下条件全部满足时报告完成：

1. `release_tag` 来自最新正式 GitHub Release，且本地 tag 对应 `release_commit`。
2. 本地 `main` 包含 `release_commit` 和同步前 `pre_merge_head`；同步前本地 `main` 与 `origin/main` 未分叉。
3. 新 merge 在提交前完成验证；无 unresolved conflict，失败路径已安全 abort。
4. `docs-zh-CN/fork.md` 的当前版本、同步日期、Merge 和唯一同步记录均与实际 Release merge 一致。
5. 本地 `refs/heads/upstream == release_commit`，且跟踪 `origin/upstream`。
6. 远端实际 `origin/upstream == release_commit`。
7. 工作区最终 clean；未自动 push `main`。
8. 未运行本地 Git hook、GPG commit signing、自动 maintenance/GC、任何 Rust/native 工作或完整测试套件。

## 1. 强前置检查

### 1.1 仓库、历史和操作状态

从仓库根目录执行只读检查：

```bash
git rev-parse --is-inside-work-tree
git rev-parse --show-toplevel
test "$(git rev-parse --is-shallow-repository)" = "false"
test -z "$(git status --porcelain=v1 --untracked-files=all)"
```

浅克隆或工作区不干净 → STOP。NEVER 自动 unshallow、stash、commit、reset、clean 或丢弃用户改动。

显式检查进行中的 Git 操作，不能只依赖 porcelain status：

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

任一状态存在 → STOP。NEVER 接管或覆盖已有操作。

### 1.2 禁用 hooks、签名与自动维护

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

发现 `hook.*.command` 或查询失败 → STOP；不得冒险执行未知 hook。

本流程以下文 `git_safe` 表示：

```bash
git_safe() {
  command git \
    -c core.hooksPath=/dev/null \
    -c commit.gpgSign=false \
    -c maintenance.auto=false \
    -c gc.auto=0 \
    -c fetch.writeCommitGraph=false \
    "$@"
}
```

所有会修改 ref、index、worktree、commit、tracking 或远端的 Git 命令 MUST 使用 `git_safe`。若命令工具不保留 shell function，必须把上述 `-c` 配置直接写入每条命令。只读查询可使用普通 `git`。

### 1.3 远端身份

读取所有 URL：

```bash
git remote get-url --all origin
git remote get-url --push --all origin
```

`origin` 的全部 fetch/push 目标 MUST 解析为 `jchanghong023/oh-my-pi`；出现其他仓库、多个不同目标或无法确认的 SSH alias → STOP。

`upstream` 远端缺失时：

```bash
git_safe remote add upstream https://github.com/can1357/oh-my-pi.git
```

若已存在，其 fetch URL MUST 解析为 `can1357/oh-my-pi`；错误或不确定 → STOP，NEVER 自动改写。

### 1.4 固定并对齐本地 `main`

本地 `main` MUST 已存在：

```bash
git show-ref --verify --quiet refs/heads/main
git_safe switch --no-guess main
test "$(git branch --show-current)" = "main"
test -z "$(git status --porcelain=v1 --untracked-files=all)"
```

不存在或切换失败 → STOP，NEVER 从 `origin/main` 或其他分支隐式创建。

精确刷新 fork 远端基线；`+` 只更新 remote-tracking ref，不改本地 `main`：

```bash
git_safe fetch origin "+refs/heads/main:refs/remotes/origin/main"
```

fetch 失败或 `origin/main` 不存在 → STOP。随后判定：

- 本地 `main` 是 `origin/main` 的祖先 → `git_safe merge --ff-only origin/main`。
- `origin/main` 是本地 `main` 的祖先 → 本地相同或领先，继续。
- 两者均不是对方祖先 → 已分叉，STOP；NEVER 自动 merge/rebase/reset `origin/main`。

`main` 无 tracking 时设置为 `origin/main`；已跟踪其他 ref 时 STOP：

```bash
main_tracking="$(git for-each-ref --format='%(upstream:short)' refs/heads/main)"
if [ -z "$main_tracking" ]; then
  git_safe branch --set-upstream-to=origin/main main
elif [ "$main_tracking" != "origin/main" ]; then
  exit 1
fi
```

再次确认 clean 后记录：

```bash
pre_merge_head="$(git rev-parse main)"
```

### 1.5 治理文件与 worktree

MUST 完整读取：

- `AGENTS.md`
- `.omp/skills/upstream-release-sync/SKILL.md`
- `docs-zh-CN/fork.md`

三者缺失、不可读，或 `fork.md` 不具备唯一“当前上游基线”和唯一“上游同步记录”段 → STOP。

检查所有 worktree：

```bash
if git worktree list --porcelain | grep -Fqx 'branch refs/heads/upstream'; then
  exit 1
fi
```

本地 `upstream` 正被任一 worktree 检出 → STOP，避免移动正在使用的分支。

## 2. 确定最新正式 Release

读取：

```text
https://api.github.com/repos/can1357/oh-my-pi/releases/latest
```

记录 `tag_name`、`html_url`、`published_at`、`draft`、`prerelease`。继续条件：

```text
draft == false
prerelease == false
published_at != null
html_url 属于 can1357/oh-my-pi/releases/tag/
```

设置 `release_tag` 为原始 `tag_name`。API 不可达、限流、字段缺失或不是正式 Release → STOP。NEVER 降级到其他版本发现方式。

## 3. Fetch 精确 Release tag

仅 fetch 已选 tag：

```bash
git_safe fetch upstream "refs/tags/$release_tag:refs/tags/$release_tag"
git show-ref --verify --quiet "refs/tags/$release_tag"
release_commit="$(git rev-parse "$release_tag^{commit}")"
git cat-file -e "$release_commit^{commit}"
```

fetch 失败时，只允许只读查询该精确远端 tag 对象进行诊断：

- 本地与远端 tag 对象不同 → 报告冲突，NEVER 覆盖本地 tag。
- 对象相同但 fetch 仍失败 → 报告原始网络/认证/权限错误。
- 任何失败均 STOP；NEVER 查询其他 tag 猜版本。

## 4. 准备未提交 merge

确认仍在 `main`、HEAD 未变且 clean：

```bash
test "$(git branch --show-current)" = "main"
test "$(git rev-parse HEAD)" = "$pre_merge_head"
test -z "$(git status --porcelain=v1 --untracked-files=all)"
```

若 Release 已是 `main` 祖先，标记 `already_contained=true`，NEVER 重复 merge，进入第 7 节。

否则开始事务式 merge：

```bash
merge_had_conflicts=false
if git_safe merge --no-ff --no-commit --no-edit "$release_tag"; then
  initial_conflicted_paths=""
else
  merge_had_conflicts=true
  initial_conflicted_paths="$(git diff --name-only --diff-filter=U)"
fi
```

检查 merge 状态：

```bash
merge_head_path="$(git rev-parse --git-path MERGE_HEAD)"
```

- `MERGE_HEAD` 存在时 MUST 精确等于 `release_commit`；不一致则按第 6.5 节 abort。
- merge 返回成功但没有 `MERGE_HEAD` → 状态异常；确认 `HEAD == pre_merge_head` 且工作区 clean 后 STOP，否则保留现场报告。
- merge 返回失败且没有 `MERGE_HEAD` → 不是普通冲突；确认 `HEAD == pre_merge_head` 且工作区 clean 后 STOP，否则保留现场报告。
- `merge_had_conflicts=true` 但 `initial_conflicted_paths` 为空 → 按第 6.5 节 abort 后 STOP。

### 4.1 无条件保留三个治理文件

仅在有效 `MERGE_HEAD` 已确认后执行。不论这些文件是否显示 conflict，MUST 从同步前 `main` 恢复并暂存：

```bash
git_safe restore --source="$pre_merge_head" --staged --worktree -- \
  AGENTS.md \
  .omp/skills/upstream-release-sync/SKILL.md \
  docs-zh-CN/fork.md
```

这样可防止上游同路径的无冲突修改静默覆盖 fork 规则。`fork.md` 在 merge commit 后由第 7 节更新。

## 5. 自动解决冲突

若 `merge_had_conflicts=true`：

1. 三个治理文件已按第 4.1 节恢复为 fork 版本。
2. 其他文件 MUST 逐文件理解双方意图；NEVER 批量选 `--ours` 或 `--theirs`。
3. MUST 以 `fork.md` 的当前 fork 功能为保留基线，同时迁移 Release 的新接口、类型、数据结构、调用方和行为变化。
4. 修改、移动或删除导出符号前 MUST 搜索全部 references；调用方与测试必须同步审查。
5. Lockfile 冲突：先正确合并 package manifests，再运行 `bun install --lockfile-only --ignore-scripts`；之后确认除 manifests/lockfile 外没有额外生成文件。NEVER 运行 lifecycle scripts 或升级无关依赖。
6. 证据不足、双方语义不可兼容或不能可靠确定正确行为 → 按第 6.5 节安全回滚，不留下半完成 merge。
7. NEVER 使用 rebase、squash、cherry-pick、`git reset --hard` 或全局 ours/theirs 策略逃避冲突。

解决后逐文件 `git_safe add`，并要求：

```bash
test -z "$(git diff --name-only --diff-filter=U)"
test -z "$(git ls-files -u)"
test -z "$(git diff --name-only)"
test -z "$(git ls-files --others --exclude-standard)"
```

## 6. 提交前弱机验证

所有验证都在 merge commit 创建前执行。任一失败按第 6.5 节回滚。

### 6.1 通用 Git 检查与基线快照

```bash
git diff --cached --check
test "$(git rev-parse MERGE_HEAD)" = "$release_commit"
test -z "$(git diff --name-only)"
test -z "$(git ls-files --others --exclude-standard)"
validation_index_tree="$(git write-tree)"
```

审查 staged diff，确认无遗留冲突标记、误删治理文件、无关生成文件或异常全仓格式化。

### 6.2 审计脚本图

运行任何 Bun script 前，MUST 读取合并结果中的：

- 根 `package.json` 的目标 script，以及对应 `pre<name>` / `post<name>`；
- 所有 workspace `package.json` 的 `check` 及其 pre/post script；
- 冲突路径拟运行测试的配置和脚本。

若脚本链包含 Rust/native build/check/test、`run-rs-task`、`cargo`、`bazel`、`nix build`、native codegen、打包、发布、Docker 或隐式安装 → 禁止执行。缺少 Bun 或依赖时安全回滚；NEVER 自动运行完整 `bun install`。

### 6.3 顺序执行 TS-only 静态检查

当前默认批准的弱机命令是根 `check:ts` 的显式顺序等价形式：

```bash
bun run check:tools
bun run --sequential --workspaces --if-present check
```

只有第 6.2 节确认每个实际执行的 workspace `check` 都是 TS/JS/配置静态检查时才可运行。若未来出现不安全 workspace，改为逐个运行其余已确认安全的 workspace check；任何受本次 merge 影响的 workspace 无法获得安全静态检查 → 回滚并报告。

NEVER 运行：

```text
bun run check
bun run check:rs
bun run test:rs
bun run lint:rs
bun run fmt:rs
bun run build
bun run build:native
bun run ci:test:full
任何 cargo / bazel / nix build / native build 命令
```

### 6.4 冲突路径附加验证与不可变检查

仅当 `merge_had_conflicts=true`：

1. 审计后运行 `bun run fastcheck`。
2. 再运行第 6.3 节顺序静态检查。
3. 对 `initial_conflicted_paths` 中的实现文件，搜索直接引用相同模块、符号或行为的既有测试；只运行最直接的精确测试文件，每个文件单独执行。
4. 对已解决的 shell/Python 冲突，可分别运行不写文件的 `bash -n` / Python AST 解析；其他配置只使用仓库已安装的轻量解析器，NEVER 为验证安装新工具。
5. NEVER 运行整个 `bun test`、workspace/CI suite、UI/browser/heavy/native 测试、Docker、网络集成测试或 benchmark。
6. 测试命令 MUST 预先确认不会构建 Rust/native、更新 snapshot 或写入仓库。不存在安全且直接相关的测试时，记录 `focused_tests=none found`，不得编造验证。
7. Rust/native 源码即使冲突，也 NEVER 在本机运行 Rust/native 验证；只能逐行语义审查并检查非 Rust 调用侧，报告 `rust_native_validation=not run by policy`。

无冲突路径不运行 `fastcheck` 或 focused tests，但仍 MUST 完成第 6.1–6.3 节。

完成所有实际验证后、创建 commit 前，MUST 证明任何检查或测试都没有改写 index、worktree 或生成文件：

```bash
test "$(git write-tree)" = "$validation_index_tree"
test -z "$(git diff --name-only)"
test -z "$(git ls-files --others --exclude-standard)"
git diff --cached --check
```

任一不满足 → 不得提交，按第 6.5 节回滚。

### 6.5 失败时安全回滚

冲突不能可靠解决、unmerged 残留、脚本不安全、检查/测试失败、验证改写文件或 merge 状态异常时：

```bash
merge_head_path="$(git rev-parse --git-path MERGE_HEAD)"
if [ -e "$merge_head_path" ]; then
  git_safe merge --abort
fi
test "$(git rev-parse HEAD)" = "$pre_merge_head"
test -z "$(git status --porcelain=v1 --untracked-files=all)"
```

没有 `MERGE_HEAD` 时不运行必然失败的 abort，只验证 Git 已保持同步前状态。abort 或恢复验证失败时 NEVER 改用 `git reset --hard`；保留现场并准确报告。回滚成功后状态为 blocked，且不得更新 `origin/upstream`。

### 6.6 创建并验证 merge commit

全部检查通过后：

```bash
git_safe commit --no-edit --no-gpg-sign
merge_commit="$(git rev-parse HEAD)"
```

必须验证：

```bash
test "$(git rev-parse "$merge_commit^1")" = "$pre_merge_head"
test "$(git rev-parse "$merge_commit^2")" = "$release_commit"
test -z "$(git status --porcelain=v1 --untracked-files=all)"
```

## 7. 更新和校验 `docs-zh-CN/fork.md`

该文件是当前状态快照，不是 Release 历史账本。

### 7.1 新建 merge 路径

计算 merge 的 committer UTC 日期与短 hash：

```bash
merge_timestamp="$(git log -1 --pretty=format:%cI "$merge_commit")"
merge_date="$(bun -e 'console.log(new Date(process.argv[1]).toISOString().slice(0,10))' "$merge_timestamp")"
merge_short="$(printf '%s' "$merge_commit" | cut -c1-10)"
```

更新：

- “当前上游基线”：版本=`release_tag`，同步日期=`merge_date`，Merge=`merge_short`。
- “上游同步记录”必须且只能保留一条：`merge_date`：合入正式 release `release_tag`（merge `merge_short`）。
- 对照 `release_commit` 审查“Fork 改动”：删除上游已等价实现的条目，保留仍存在的差异，更新因冲突解决而改变的描述；不得新增第二份清单。

验证文档不变量后提交：

```bash
git_safe add docs-zh-CN/fork.md
git_safe commit --no-gpg-sign -m "docs(fork): record upstream ${release_tag}"
fork_doc_commit="$(git rev-parse HEAD)"
```

该提交 MUST 只修改 `docs-zh-CN/fork.md`，且父提交 MUST 为 `merge_commit`。

### 7.2 Release 已包含路径

即使 `fork.md` 已写相同版本，也 MUST 校验日期和 Merge，不得只比较 tag。

定位 `main` first-parent 历史中第二父提交精确等于 `release_commit` 的 merge：

```bash
integration_matches="$(
  for candidate in $(git rev-list --first-parent --merges main); do
    if [ "$(git rev-parse "$candidate^2")" = "$release_commit" ]; then
      git show -s --format='%H%x09%cI' "$candidate"
    fi
  done
)"
```

要求恰好一条。以其 committer UTC 日期和前 10 位 hash 校验当前版本、同步日期、Merge，以及唯一同步记录的版本、日期和 hash。

全部一致 → `fork_doc_commit=none`。任一不一致 → 按第 7.1 节格式校正并创建只修改 `fork.md` 的独立 docs commit。

0 条或多条匹配 → 不猜测；保持文件 clean，STOP，报告“代码已包含 Release，但无法唯一确定对应 merge”，不得更新镜像。

### 7.3 文档失败处理与不变量

文档修改后若不变量或提交检查失败，MUST 用 `git_safe restore --source=HEAD --staged --worktree -- docs-zh-CN/fork.md` 恢复并确认 clean；不得更新镜像。本地 Release merge可能已完成，最终状态报告为 partial。

最终不变量：

- “当前上游基线”恰好一个。
- “上游同步记录”恰好一个且仅含一条当前 Release 记录。
- 版本、UTC 日期和 Merge hash 与唯一实际 merge 精确一致。
- 新 merge 的 docs commit 只修改 `docs-zh-CN/fork.md`。

## 8. 最后同步 Release 镜像

只有第 4–7 节全部完成且工作区 clean 后才执行。保存：

```bash
main_final_head="$(git rev-parse main)"
```

再次检查没有 worktree 使用本地 `upstream`。然后查询远端镜像；命令失败 → STOP，只有成功且输出为空才表示分支不存在：

```bash
if ! remote_upstream_line="$(git ls-remote --heads origin refs/heads/upstream)"; then
  exit 1
fi
```

精确查询最多允许一条结果；多条或无法解析 → STOP。

### 8.1 创建或校正 `origin/upstream`

远端不存在时也使用空 expected-value lease，防止查询后被并发创建：

```bash
git_safe push \
  --force-with-lease="refs/heads/upstream:" \
  origin "${release_commit}:refs/heads/upstream"
```

远端存在且 SHA 不同：提取唯一旧 SHA 为 `expected_origin_upstream`：

```bash
git_safe push \
  --force-with-lease="refs/heads/upstream:$expected_origin_upstream" \
  origin "${release_commit}:refs/heads/upstream"
```

lease 失败后只允许重新查询一次：

- 远端已经等于 `release_commit` → 视为目标由并发操作完成。
- 仍不等于 → STOP；NEVER 用新 lease 自动重试覆盖。

远端已经等于 `release_commit` → 不 push。

### 8.2 建立本地镜像 tracking

远端已确认正确后：

```bash
git_safe branch -f upstream "$release_commit"
git_safe fetch origin "+refs/heads/upstream:refs/remotes/origin/upstream"
git_safe branch --set-upstream-to=origin/upstream upstream
```

若分支因其他 worktree 占用而不能移动 → STOP；NEVER 绕过 worktree 保护。

### 8.3 精确验证镜像

```bash
test "$(git rev-parse refs/heads/upstream)" = "$release_commit"
test "$(git rev-parse refs/remotes/origin/upstream)" = "$release_commit"
test "$(git for-each-ref --format='%(upstream:short)' refs/heads/upstream)" = "origin/upstream"
if ! verified_remote_line="$(git ls-remote --heads origin refs/heads/upstream)"; then
  exit 1
fi
verified_remote_sha="$(printf '%s\n' "$verified_remote_line" | awk 'NR==1 {print $1}')"
test "$verified_remote_sha" = "$release_commit"
test "$(git rev-parse main)" = "$main_final_head"
```

## 9. 最终验证与报告

最终必须满足：

```bash
test "$(git branch --show-current)" = "main"
git merge-base --is-ancestor "$release_commit" main
git merge-base --is-ancestor "$pre_merge_head" main
test -z "$(git status --porcelain=v1 --untracked-files=all)"
```

再次确认第 7 节文档不变量、第 8.3 节镜像不变量，以及执行记录中没有本地 hook、GPG commit signing、自动 maintenance/GC、Rust/native 或完整重型测试命令。

最终报告：

```text
Release: <release_tag>
Release URL: <html_url>
Published: <published_at>
Release commit: <release_commit>
Main: merged @ <merge_commit> / already contained
Conflict resolution: none / auto-resolved / blocked and aborted
Validation: staged Git check; sequential TS static checks; focused tests <list/none>; all passed/failed
Git hooks/signing/auto-maintenance: disabled for mutating commands
Rust/native local work: not run
Fork snapshot: updated @ <fork_doc_commit> / already current / blocked
Upstream mirror: local upstream == origin/upstream == <release_commit> / blocked
Working tree: clean / not clean
Main push: not performed
```

<critical>
- 核心关系：本地 `main` 包含 `release_commit`；本地 `upstream == origin/upstream == release_commit`。
- merge 在提交前验证；失败自动 abort；镜像最后更新。
- `upstream` 是可重建的正式 Release 镜像，不保留 fork commit。
- 三个治理文件始终保留 fork 版本；`fork.md` 再按实际 merge 更新。
- 本机绝不运行 Git hooks、GPG commit signing、自动 maintenance/GC、Rust/native 工作或完整重型测试套件。
- NEVER 同步 `upstream/main`；NEVER 自动 push `main`。
</critical>
