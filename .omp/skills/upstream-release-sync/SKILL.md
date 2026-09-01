---
name: upstream-release-sync
description: Perform a narrow daily sync against only can1357/oh-my-pi's latest formal GitHub Release and that Release tag's exact commit. Fast-exit when tag and commit are unchanged; otherwise merge the exact commit into this fork's existing local main, resolve reliable conflicts, avoid Rust/native work, and keep origin/upstream as the exact Release mirror. Never inspect or synchronize other remote branches.
---

# 每日上游正式 Release 同步

固定目标：

1. 每天只检查上游最新正式 GitHub Release 页面、该页面的原始 tag，以及该 tag 精确指向的 commit。
2. tag 和 commit 都未变化时快速结束；仅在 `origin/upstream` 或本地 tracking 漂移时修复镜像。
3. 出现新 Release 时，将该精确 commit 合入本 fork 已存在的本地 `main`，可靠冲突由代理主动解决。
4. 本地 merge、必要验证和 `fork.md` 更新完成后，使本地 `upstream`、`origin/upstream` 精确等于 `release_commit`。

<critical>
- MUST 首先执行第 0 节快速门禁；无新 Release 时 NEVER 进入完整同步流程。
- 上游版本来源只能是 `https://api.github.com/repos/can1357/oh-my-pi/releases/latest`，并只解析该 Release 的原始 `tag_name` 与该 tag 的精确 commit。
- NEVER 查询 Release 列表、tag 列表、上游分支列表、`upstream/main`、其他 tag、其他 commit 或仓库活动来判断版本。
- NEVER 查询、比较、拉取、合并或重置任何远程开发分支。唯一允许维护的远程分支是 `origin/upstream`。
- 浅历史不足时只允许按第 2 节：从固定上游 URL 深化当前 `release_tag`，并从 `origin` 深化当前本地 `main` 的精确 `pre_merge_head` SHA；NEVER 读取 `origin/main`，NEVER unshallow。
- tag 与基线 tag 相同但 commit 不同，视为上游 retag/改写异常，立即 STOP；NEVER 自动移动本地同名 tag、merge 或改写镜像。
- 候选 tag 与基线 tag 不同时，二者 MUST 均符合 `vMAJOR.MINOR.PATCH`，且候选数值版本严格更高；否则 STOP，防止 Release 删除或回退导致降级。
- 目标固定为已存在的本地 `main`；NEVER 隐式创建，NEVER 自动 push `main` 或 tag。
- 新 merge 使用 `--no-ff --no-commit`；冲突解决和验证通过后才提交。失败必须安全 abort，不留下半完成 merge。
- 无冲突时只做 Git staged 检查，不运行 Bun、测试或全仓扫描；有冲突时仅运行一次 changed-TS `fastcheck`，并只对冲突 workspace 做类型检查和直接测试。
- NEVER 在本机运行 Rust/native build、check、test、lint、fmt、clippy、codegen 或 packaging；NEVER 运行 `cargo`、`bazel`、`nix build`、根级 `bun run check`、完整测试套件、UI/browser/heavy、Docker、benchmark、打包或发布流程。
- `AGENTS.md`、本文件、`docs-zh-CN/fork.md` 始终保留同步前 fork 版本；`fork.md` 随后按实际 Release 更新。
- `origin/upstream` 是可重建的纯 Release 镜像，不承载 fork commit；默认自动 push 的唯一 ref 是 `refs/heads/upstream`。
</critical>

## 唯一允许访问的对象

- 最新 Release：`GET /repos/can1357/oh-my-pi/releases/latest`
- 该 Release 的精确 tag ref：`GET /repos/can1357/oh-my-pi/git/ref/tags/<release_tag>`
- annotated tag 时仅允许继续读取该返回对象自身的 `object.url` 一次；仍未直接得到 commit 则 STOP。
- 本地分支：`main`、`upstream`
- 唯一远程分支：`origin/upstream`
- 浅历史补全时的精确对象：`release_tag` 与 `pre_merge_head` SHA

禁止：

```text
git fetch --all
git remote update
git branch -r
git ls-remote --heads（未限定 refs/heads/upstream）
git ls-remote --tags（用于列举或排序 tag）
origin/main
upstream/main
任何其他远程分支或 tag
```

## 执行预算

- 快速门禁不创建 TODO，不启动子代理，不使用 PTY/async，不重试。
- Release API、精确 tag ref、`origin/upstream` 查询：每次工具调用 timeout MUST ≤ 20 秒。
- 精确 tag fetch 和唯一一次历史深化：每次 timeout MUST ≤ 90 秒。
- `fastcheck`、`check:types`、单个精确测试：每次 timeout MUST ≤ 120 秒。
- 精确测试最多 3 个，全部顺序执行；NEVER 使用 `timeout=0`。
- push 超时或返回不确定时，只允许重新查询一次实际 `origin/upstream`；不得盲目重推。

## Git 隔离模板

不得假设 shell function 能跨 Bash 工具调用保留。每个 Bash 调用必须在同一 command 内重新定义以下函数，或把相同环境变量和 `-c` 参数内联到每条 Git 命令：

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

push 额外显式使用：

```text
--no-verify --no-follow-tags --no-signed --recurse-submodules=no
```

# 0. 每日快速门禁

## 0.1 读取最新正式 Release

只读取 `/releases/latest` 一次，提取：

```text
tag_name
html_url
published_at
draft
prerelease
```

必须满足：

```text
draft == false
prerelease == false
published_at != null
html_url 属于 can1357/oh-my-pi/releases/tag/
tag_name 匹配 ^v[0-9]+\.[0-9]+\.[0-9]+$
```

设置 `release_tag` 为原始 `tag_name`。字段缺失、读取失败或超时 → STOP；不得改用其他版本发现方式。

## 0.2 解析该 tag 的精确 commit

只读取：

```text
/repos/can1357/oh-my-pi/git/ref/tags/<URL 编码后的 release_tag>
```

- `object.type == commit` → `release_commit = object.sha`。
- `object.type == tag` → 只读取其返回的 `object.url` 一次，要求内部对象直接指向 commit。
- 其他类型、第二层仍为 tag、SHA 非 40 位十六进制或读取失败 → STOP。

NEVER 查询其他 tag，也 NEVER 用 `target_commitish` 代替 tag commit。

## 0.3 读取本地声明基线

只读本地既有 `main`，不切分支、不补历史：

```bash
git_guarded rev-parse --is-inside-work-tree
git_guarded show-ref --verify --quiet refs/heads/main
fork_snapshot="$(git_guarded show main:docs-zh-CN/fork.md)"
```

要求“当前上游基线”唯一包含：

```text
版本：baseline_tag，且匹配 ^v[0-9]+\.[0-9]+\.[0-9]+$
Release commit：baseline_release_commit，完整 40 位 SHA
同步日期：YYYY-MM-DD
Merge：10 位 SHA
```

“上游同步记录”必须唯一且只含一条，并同时引用：

```text
baseline_tag
baseline_release_commit 前 12 位
Merge 的 10 位 SHA
```

结构缺失或歧义 → STOP；不要进入扩散式调查。

## 0.4 分类

### A. tag 相同、commit 相同

```text
release_tag == baseline_tag
release_commit == baseline_release_commit
```

没有新 Release。只进入第 7 节检查/修复 `origin/upstream` 和本地 `upstream`，然后立即结束。不得检查浅克隆、切换 `main`、fetch 任何开发分支、运行 Bun 或测试。

### B. tag 相同、commit 不同

上游同名 tag 被改写。立即 STOP：

```text
Retag anomaly: release tag unchanged but commit changed
```

NEVER 移动本地 tag、merge、更新 `fork.md` 或更新 `origin/upstream`。

### C. tag 不同

只做本地 SemVer 数值比较：候选必须严格高于基线；不通过立即 STOP，不查询旧 Release 页面或其他 tag。

- 若 `release_commit == baseline_release_commit`：这是“新 tag、相同代码”路径。进入第 1 节完成本地安全检查后直接执行第 6.2 节；NEVER fetch tag 历史、merge、运行 Bun 或测试。
- 若 commit 不同：进入第 1–6 节完整新 Release 路径。

# 1. 新 Release 的本地前置检查

只在第 0.4-C 进入。

```bash
test -z "$(git_guarded status --porcelain=v1 --untracked-files=all)"
git_guarded show-ref --verify --quiet refs/heads/main
git_guarded switch --no-guess main
test "$(git_guarded branch --show-current)" = main
pre_merge_head="$(git_guarded rev-parse HEAD)"
```

工作区不干净、本地 `main` 不存在或无法切换 → STOP。NEVER stash、reset、clean 或隐式创建分支。

显式确认不存在：

```text
MERGE_HEAD、CHERRY_PICK_HEAD、REVERT_HEAD、REBASE_HEAD、AM_HEAD、BISECT_START
rebase-merge、rebase-apply、sequencer
```

完整读取三个治理文件。确认 `origin` 的全部 fetch/push URL 唯一解析为 `jchanghong023/oh-my-pi`；只用于精确 SHA 历史补全和维护 `origin/upstream`，不得检查任何其他远程分支。

若已标记“新 tag、相同代码”，此处检查通过后直接进入第 6.2 节。

# 2. 只获取精确 tag；必要时有限补历史

仅用于“新 tag、新 commit”路径。

## 2.1 获取 tag tip

如果本地同名 tag 已存在：

```bash
test "$(git_guarded rev-parse "$release_tag^{commit}")" = "$release_commit"
```

不一致 → STOP，NEVER force 覆盖。

本地 tag 不存在时：

```bash
if [ "$(git_guarded rev-parse --is-shallow-repository)" = true ]; then
  git_guarded fetch --depth=1 --no-tags --update-shallow \
    https://github.com/can1357/oh-my-pi.git \
    "refs/tags/$release_tag:refs/tags/$release_tag"
else
  git_guarded fetch --no-tags \
    https://github.com/can1357/oh-my-pi.git \
    "refs/tags/$release_tag:refs/tags/$release_tag"
fi
```

随后必须验证 tag commit 精确等于 `release_commit`。完整仓库 NEVER 使用 `--depth`，避免被转换为浅仓库。

## 2.2 确认 merge base

先直接尝试：

```bash
git_guarded merge-base main "$release_commit"
```

成功 → 不再获取任何历史。

失败且仓库不是 shallow → 视为无共同历史，STOP；NEVER `--allow-unrelated-histories`。

失败且仓库 shallow → 仅允许一次定向深化，且不读取任何远程分支：

```bash
git_guarded fetch --deepen=256 --no-tags origin "$pre_merge_head"
git_guarded fetch --deepen=256 --no-tags --update-shallow \
  https://github.com/can1357/oh-my-pi.git \
  "refs/tags/$release_tag:refs/tags/$release_tag"
```

再次执行 `merge-base`。仍失败 → STOP，报告 `targeted history insufficient`；NEVER unshallow、NEVER 查询 `origin/main` 或 `upstream/main`。

# 3. 事务式合入本地 `main`

若 `release_commit` 已是本地 `main` 的祖先，标记 `already_contained=true`，跳到第 6.2 节对账。

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

必须存在 `MERGE_HEAD == release_commit`。merge 失败但没有有效 `MERGE_HEAD`，或声称冲突但没有 U 路径 → 安全 abort 后 STOP。

无论是否出现冲突，都从 `pre_merge_head` 恢复并暂存三个治理文件：

```bash
git_guarded restore --source="$pre_merge_head" --staged --worktree -- \
  AGENTS.md \
  .omp/skills/upstream-release-sync/SKILL.md \
  docs-zh-CN/fork.md
```

# 4. 自动解决冲突

仅当 `merge_had_conflicts=true`：

1. 三个治理文件保持 fork 版本。
2. 其他冲突逐文件理解双方意图；NEVER 批量选 `--ours` 或 `--theirs`。
3. 以 `fork.md` 当前差异为保留基线，同时迁移该 Release 的接口、类型、数据结构、调用方和行为变化。
4. 修改、移动或删除导出符号前搜索本地全部 references，并审查直接调用方及相关测试。
5. Lockfile 冲突：先正确合并 manifests；仅在确有需要时运行 `bun install --lockfile-only --ignore-scripts`，并确认未产生 manifests/lockfile 之外的文件。
6. 无法可靠判断 → 第 5.3 节 abort；不得留下半完成 merge。
7. Rust/native 冲突只做源代码语义审查和非 Rust 调用侧检查；本机绝不运行 Rust/native 工具链。

解决后逐文件 `git_guarded add`，要求无 unmerged、unstaged 和 untracked 文件。

# 5. 提交前窄范围验证

## 5.1 所有 merge 路径

```bash
git_guarded diff --cached --check
test "$(git_guarded rev-parse MERGE_HEAD)" = "$release_commit"
validation_tree="$(git_guarded write-tree)"
```

审查 staged diff，确认无冲突标记、误删治理文件、异常全仓格式化或无关生成文件。

无冲突路径到此结束本地验证：NEVER 运行 Bun 或测试，直接进入第 5.4 节提交。

## 5.2 仅冲突路径

只读取根 `package.json` 和包含 `initial_conflicted_paths` 的 workspace `package.json`；不得遍历所有 workspace。

按顺序执行：

1. 冲突路径中存在 TypeScript 时，审计后运行一次 `bun run fastcheck`；该命令会检查本次 merge 修改的 TypeScript，不是全仓 workspace 检查。
2. 对包含非治理冲突文件的 workspace，仅当存在 `check:types` 且其脚本确认不调用 Rust/native、build、codegen、Docker 或安装流程时，逐个运行：

```bash
bun --cwd=<conflicted-workspace> run check:types
```

3. 最直接的既有测试最多 3 个，每个单独执行；不得运行 workspace/全仓测试套件、UI/browser/heavy/native 或网络集成测试。
4. Shell/Python/JSON 冲突分别只做 `bash -n`、Python AST 解析或轻量 JSON 解析。
5. 缺少 Bun/依赖、检查超时、脚本不安全或验证失败 → abort。

检查后必须证明没有写回：

```bash
test "$(git_guarded write-tree)" = "$validation_tree"
test -z "$(git_guarded diff --name-only)"
test -z "$(git_guarded ls-files --others --exclude-standard)"
git_guarded diff --cached --check
```

## 5.3 失败回滚

```bash
if [ -e "$(git_guarded rev-parse --git-path MERGE_HEAD)" ]; then
  git_guarded merge --abort
fi
test "$(git_guarded rev-parse HEAD)" = "$pre_merge_head"
test -z "$(git_guarded status --porcelain=v1 --untracked-files=all)"
```

abort 失败时 NEVER 使用 `reset --hard`；保留现场并准确报告。回滚成功后不得更新 `fork.md` 或镜像。

## 5.4 创建 merge commit

全部通过后：

```bash
git_guarded commit --no-edit --no-gpg-sign
merge_commit="$(git_guarded rev-parse HEAD)"
```

验证第一父提交为 `pre_merge_head`、第二父提交为 `release_commit`，工作区 clean。

# 6. 更新和校验 `docs-zh-CN/fork.md`

“当前上游基线”固定包含：

```text
版本：release_tag
Release commit：完整 release_commit
同步日期：实际 integration merge 的 committer UTC 日期
Merge：integration merge 前 10 位 SHA
```

“上游同步记录”只保留当前 Release 一条，并同时记录 Release commit 前 12 位和 merge 前 10 位。

## 6.1 新 merge

使用本次 `merge_commit` 更新上述字段。只复核此次 Release/冲突直接影响的 fork 差异条目；NEVER 为每日同步重新全仓审计所有差异。

只暂存 `fork.md`，验证提交范围后创建独立 docs commit；该提交只修改此文件，父提交为 `merge_commit`。

## 6.2 commit 已包含或新 tag 指向相同代码

- 若 `release_tag != baseline_tag` 且 `release_commit == baseline_release_commit`：保留原同步日期和 Merge，只更新版本、完整 Release commit 和唯一同步记录；不获取 tag 历史、不 merge、不运行 Bun 或测试。
- 其他 already-contained 情况：在本地已有历史中定位第二父提交精确等于 `release_commit` 的唯一 first-parent merge；找不到或不唯一即 STOP。浅历史不足时只允许第 2.2 节的一次定向深化，NEVER unshallow。

任何字段不一致则校正并创建只修改 `fork.md` 的 docs commit。

# 7. 只检查/维护 `origin/upstream`

本节是唯一允许访问远程分支的章节。

## 7.1 安全前置

- 确认 `origin` 的全部 fetch/push URL 均唯一解析为 `jchanghong023/oh-my-pi`；任一 URL 缺失、不同或无法确认即 STOP。
- 显式确认没有进行中的 merge/rebase/cherry-pick/revert/am/bisect/sequencer 操作。
- 不查询任何其他远程分支。
- 若本地 `upstream` 被任一 worktree 检出且需要移动，STOP；NEVER 自动切换用户分支。
- 若本地缺少 `release_commit` 对象，只从固定上游 URL 精确 fetch 当前 `release_tag`：shallow 仓库用 `--depth=1`，完整仓库不用 `--depth`；不得深化其他历史。

## 7.2 精确查询和 push

只查询：

```bash
origin_upstream_line="$(git_guarded ls-remote --heads origin refs/heads/upstream)"
```

查询失败 → STOP；空输出表示不存在；多于一条或格式异常 → STOP。存在时提取唯一 SHA 为 `expected_origin_upstream`。

远端不存在：

```bash
git_guarded push --no-verify --no-follow-tags --no-signed --recurse-submodules=no \
  --force-with-lease="refs/heads/upstream:" \
  origin "${release_commit}:refs/heads/upstream"
```

远端已等于 `release_commit`：不 push。

远端存在但不同：只有在第 0.4-A（基线 tag+commit 与最新完全一致）或新 Release 已完成本地 merge/docs 时，才执行：

```bash
git_guarded push --no-verify --no-follow-tags --no-signed --recurse-submodules=no \
  --force-with-lease="refs/heads/upstream:$expected_origin_upstream" \
  origin "${release_commit}:refs/heads/upstream"
```

push 后、push 超时或返回不确定时，只重新查询一次实际 `refs/heads/upstream`；达到 `release_commit` 则成功，否则 STOP，不刷新 lease 重试。

## 7.3 本地镜像和 tracking

远端正确后：

```bash
git_guarded branch -f upstream "$release_commit"
git_guarded fetch --no-tags origin "+refs/heads/upstream:refs/remotes/origin/upstream"
git_guarded branch --set-upstream-to=origin/upstream upstream
```

最终必须满足：

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
Release commit: <release_commit>
Fast gate: tag and commit matched fork baseline
Main: not inspected or modified
Upstream mirror: already current / repaired
Other remote branches: not queried
History expansion: none
Checks/tests: not run
Mirror push: not needed / performed
Main/tag push: not performed
```

## 有新 Release

```text
Release: <release_tag>
Release commit: <release_commit>
History: sufficient / one targeted deepen / targeted history insufficient
Main: merged @ <merge_commit> / already contained / same code under newer tag
Conflict resolution: none / auto-resolved / blocked and aborted
Validation: Git staged check; conflict-only checks <list/none>
Rust/native local work: not run
Fork snapshot: updated @ <fork_doc_commit> / blocked
Upstream mirror: local upstream == origin/upstream == <release_commit> / blocked
Other remote branches: not queried
Working tree: clean / not clean
Main/tag push: not performed
```

<critical>
- 每日无变化必须快速结束。
- 上游只检查 latest Release 及其精确 tag commit。
- 唯一远程分支是 `origin/upstream`；不查询或同步任何其他远程分支。
- 浅历史最多执行一次定向 deepen；NEVER unshallow。
- 本机绝不运行 Rust/native 工具链或完整重型测试。
- 核心关系：本地 `main` 包含 `release_commit`；本地 `upstream == origin/upstream == release_commit`。
</critical>
