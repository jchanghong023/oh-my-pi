---
name: upstream-release-sync
description: Narrow daily synchronization using only can1357/oh-my-pi's latest formal GitHub Release and that Release tag's exact commit. Exit immediately when tag, commit, and mirror are unchanged; otherwise merge the exact Release into the existing local main, resolve reliable conflicts, avoid Rust/native work, and maintain origin/upstream as the exact Release mirror. Never inspect or synchronize other remote branches.
---

# 每日上游正式 Release 同步

## 不变量

1. 上游只检查最新正式 Release、该 Release 的原始 tag、该 tag 的精确 commit。
2. 本地 `main` 包含 `release_commit`，同时保留 fork 改动。
3. 本地 `upstream == origin/upstream == release_commit`，且本地 `upstream` 跟踪 `origin/upstream`。
4. `origin/upstream` 是唯一允许访问和自动 push 的远程分支。
5. 不自动 push `main` 或 tag；本机不运行 Rust/native 工具链。

<critical>
- MUST 先执行第 0 节快速门禁。tag、commit、镜像均未变化时必须真正 no-op：不切分支、不 fetch、不改 ref、不运行检查或测试。
- 版本来源只能是 `GET /repos/can1357/oh-my-pi/releases/latest`；NEVER 查询 Release/tag 列表、上游分支列表、仓库活动或其他对象猜版本。
- tag commit 只能来自该 `tag_name` 的精确 Git ref；NEVER 用 `target_commitish`、`upstream/main` 或其他 tag 代替。
- NEVER 查询、比较、拉取、合并或重置 `origin/main`、`upstream/main` 或任何其他远程分支。
- 浅历史不足时只允许一次定向 deepen：当前 Release tag，以及 `origin` 中当前本地 `main` 的精确 `pre_merge_head` SHA；NEVER unshallow。
- 同名 Release tag 指向不同 commit → retag 异常，立即 STOP；NEVER 自动移动同名 tag、merge 或改写镜像。
- 新 tag 必须严格高于基线 `vMAJOR.MINOR.PATCH`；否则 STOP，防止 Release 删除或回退造成降级。
- 新 merge 使用 `--no-ff --no-commit`；失败必须安全 abort，不留下半完成 merge。
- 无冲突只做 staged Git 检查；有冲突仅运行一次 changed-TS `fastcheck`、冲突 workspace 的安全 `check:types` 和最多 3 个直接测试。
- NEVER 运行根级 `bun run check`、完整测试套件、全 workspace 检查、UI/browser/heavy、Docker、benchmark、打包、发布、`cargo`、`bazel`、`nix build`，或任何 Rust/native build/check/test/lint/fmt/clippy/codegen/packaging。
- `AGENTS.md`、本文件、`docs-zh-CN/fork.md` 始终保留同步前 fork 版本；仅 `fork.md` 在 merge 后按实际结果更新。
</critical>

## 唯一允许访问的远程对象

- `GET /repos/can1357/oh-my-pi/releases/latest`
- `GET /repos/can1357/oh-my-pi/git/ref/tags/<release_tag>`
- annotated tag 时，仅允许继续读取上述返回对象自身的 `object.url` 一次
- `origin/upstream`
- 新 Release 浅历史补全时：固定上游 URL 的当前 `release_tag`，以及 `origin` 中的精确 `pre_merge_head` SHA

禁止运行：

```text
git fetch --all
git remote update
git branch -r
git ls-remote --heads（未精确限定 refs/heads/upstream）
git ls-remote --tags（用于列举或排序）
任何 origin/main、upstream/main 或其他远程分支操作
```

## 执行预算

- 快速门禁不创建 TODO、不启动子代理、不重试、不使用 PTY/async。
- Release API、tag ref、`origin/upstream` 查询：单次工具 timeout ≤ 20 秒。
- 精确 tag fetch、唯一一次 deepen：单次 timeout ≤ 90 秒。
- `fastcheck`、`check:types`、单个精确测试：单次 timeout ≤ 120 秒。
- 精确测试最多 3 个，顺序执行；NEVER 使用 `timeout=0`。
- push 超时或结果不确定：只重新查询一次 `origin/upstream`，不得盲目重推。

## Git 隔离模板

不得假设 shell function 可跨 Bash 工具调用保留。每个 Bash 调用必须在同一 command 内重新定义，或把参数内联到每条 Git 命令：

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

继续条件：

```text
draft == false
prerelease == false
published_at != null
html_url 属于 can1357/oh-my-pi/releases/tag/
tag_name 匹配 ^v[0-9]+\.[0-9]+\.[0-9]+$
```

设置 `release_tag = tag_name`。任何失败或超时 → STOP；不得降级到其他发现方式。

## 0.2 解析精确 tag commit

只读取：

```text
/repos/can1357/oh-my-pi/git/ref/tags/<URL 编码后的 release_tag>
```

- `object.type == commit` → `release_commit = object.sha`。
- `object.type == tag` → 只读取其 `object.url` 一次，要求内部对象直接指向 commit。
- 其他类型、第二层仍为 tag、SHA 不是 40 位十六进制或读取失败 → STOP。

## 0.3 读取本地基线

不切分支、不补历史：

```bash
git_guarded rev-parse --is-inside-work-tree
git_guarded show-ref --verify --quiet refs/heads/main
fork_snapshot="$(git_guarded show main:docs-zh-CN/fork.md)"
```

“当前上游基线”必须唯一包含：

```text
版本：baseline_tag，格式 vMAJOR.MINOR.PATCH
Release commit：baseline_release_commit，完整 40 位 SHA
同步日期：YYYY-MM-DD
Merge：10 位 SHA
```

“上游同步记录”必须唯一且只含一条，并引用 `baseline_tag`、`baseline_release_commit` 前 12 位和 Merge 的 10 位 SHA。结构异常 → STOP，不扩散调查。

## 0.4 分类

### A. tag、commit 均相同

```text
release_tag == baseline_tag
release_commit == baseline_release_commit
```

进入第 6 节镜像检查。若镜像四项也完全一致，立即结束；不得执行其他章节。

### B. tag 相同、commit 不同

报告 `Retag anomaly` 并 STOP。NEVER 修改本地 tag、`main`、`fork.md` 或镜像。

### C. tag 不同

只在本地比较 SemVer 数值；候选必须严格高于基线，不通过即 STOP，不查询旧 Release 或其他 tag。

- `release_commit == baseline_release_commit`：新 tag 指向相同代码。执行第 1 节后直接进入第 5.2 节；不 fetch tag 历史、不 merge、不运行 Bun/测试。
- commit 不同：执行第 1–5 节完整新 Release 流程。

# 1. 新 Release 本地前置检查

仅由第 0.4-C 进入：

```bash
test -z "$(git_guarded status --porcelain=v1 --untracked-files=all)"
git_guarded show-ref --verify --quiet refs/heads/main
git_guarded switch --no-guess main
test "$(git_guarded branch --show-current)" = main
pre_merge_head="$(git_guarded rev-parse HEAD)"
```

工作区不干净、本地 `main` 不存在或无法切换 → STOP。NEVER stash、reset、clean 或隐式创建分支。

显式确认没有：

```text
MERGE_HEAD、CHERRY_PICK_HEAD、REVERT_HEAD、REBASE_HEAD、AM_HEAD、BISECT_START
rebase-merge、rebase-apply、sequencer
```

完整读取三个治理文件。确认 `origin` 的全部 fetch/push URL 均唯一解析为 `jchanghong023/oh-my-pi`；不得检查任何远程分支。

新 tag 指向相同代码时，此处通过后直接进入第 5.2 节。

# 2. 精确获取新 tag；必要时有限补历史

仅用于“新 tag、新 commit”。

## 2.1 获取 tag tip

本地同名 tag 已存在时，必须满足：

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

验证本地 tag commit 精确等于 `release_commit`。完整仓库 NEVER 使用 `--depth`。

## 2.2 确认 merge base

先执行：

```bash
git_guarded merge-base main "$release_commit"
```

成功则不再获取历史。失败且仓库非 shallow → STOP，NEVER `--allow-unrelated-histories`。

失败且仓库 shallow → 只允许一次定向 deepen，不读取任何远程分支：

```bash
git_guarded fetch --deepen=256 --no-tags origin "$pre_merge_head"
git_guarded fetch --deepen=256 --no-tags --update-shallow \
  https://github.com/can1357/oh-my-pi.git \
  "refs/tags/$release_tag:refs/tags/$release_tag"
```

再次执行 `merge-base`。仍失败 → STOP，报告 `targeted history insufficient`；NEVER unshallow 或查询远程开发分支。

# 3. 事务式 merge 与冲突处理

若 `release_commit` 已是本地 `main` 祖先，标记 `already_contained=true`，进入第 5.2 节。

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

必须存在 `MERGE_HEAD == release_commit`。失败但没有有效 `MERGE_HEAD`，或声称冲突却没有 U 路径 → 第 4.3 节 abort 后 STOP。

无论是否冲突，都恢复并暂存三个治理文件：

```bash
git_guarded restore --source="$pre_merge_head" --staged --worktree -- \
  AGENTS.md \
  .omp/skills/upstream-release-sync/SKILL.md \
  docs-zh-CN/fork.md
```

有冲突时：

1. 其他文件逐个理解双方意图；NEVER 批量选 `--ours` 或 `--theirs`。
2. 保留 `fork.md` 当前 fork 功能，同时迁移该 Release 的接口、类型、数据结构、调用方和行为。
3. 修改、移动或删除导出符号前搜索本地 references，并审查直接调用方和相关测试。
4. Lockfile 冲突先合并 manifests；仅在必要时运行 `bun install --lockfile-only --ignore-scripts`，并确认未产生其他文件。
5. 无法可靠判断 → abort；Rust/native 冲突只做语义审查和非 Rust 调用侧检查。

逐文件 `git_guarded add`，要求无 unmerged、unstaged 和 untracked 文件。

# 4. 提交前窄范围验证与 merge commit

## 4.1 所有 merge

```bash
git_guarded diff --cached --check
test "$(git_guarded rev-parse MERGE_HEAD)" = "$release_commit"
test -z "$(git_guarded diff --name-only)"
test -z "$(git_guarded ls-files -u)"
test -z "$(git_guarded ls-files --others --exclude-standard)"
validation_tree="$(git_guarded write-tree)"
```

审查 staged diff，确认无冲突标记、误删治理文件、异常全仓格式化或无关生成文件。

无冲突时不运行 Bun 或测试，直接进入第 4.4 节。

## 4.2 仅冲突路径

只读取根 `package.json` 和冲突文件所在 workspace 的 `package.json`；不得遍历所有 workspace。

1. 冲突中存在 TypeScript → 审计 `fastcheck`、`prefastcheck`、`postfastcheck` 后运行一次 `bun run fastcheck`。它检查本次 merge 修改的 TypeScript，不遍历全 workspace。
2. 冲突 workspace 存在 `check:types` 时，必须同时审计 `precheck:types`、`check:types`、`postcheck:types`；确认不触发 Rust/native、build、codegen、Docker 或安装后，逐个运行：

```bash
bun --cwd=<conflicted-workspace> run check:types
```

3. 最直接既有测试最多 3 个，逐个运行；禁止 workspace/全仓测试、UI/browser/heavy/native 和网络集成测试。
4. Shell/Python/JSON 冲突只做 `bash -n`、Python AST 或轻量 JSON 解析。
5. 缺少 Bun/依赖、超时、脚本不安全或验证失败 → abort。

检查后证明无写回：

```bash
test "$(git_guarded write-tree)" = "$validation_tree"
test -z "$(git_guarded diff --name-only)"
test -z "$(git_guarded ls-files --others --exclude-standard)"
git_guarded diff --cached --check
```

## 4.3 失败回滚

```bash
if [ -e "$(git_guarded rev-parse --git-path MERGE_HEAD)" ]; then
  git_guarded merge --abort
fi
test "$(git_guarded rev-parse HEAD)" = "$pre_merge_head"
test -z "$(git_guarded status --porcelain=v1 --untracked-files=all)"
```

abort 失败时 NEVER 使用 `reset --hard`；保留现场并准确报告。回滚成功后不得更新 `fork.md` 或镜像。

## 4.4 创建 merge commit

```bash
git_guarded commit --no-edit --no-gpg-sign
merge_commit="$(git_guarded rev-parse HEAD)"
```

验证第一父提交为 `pre_merge_head`、第二父提交为 `release_commit`，工作区 clean。

# 5. 更新和校验 `docs-zh-CN/fork.md`

基线固定包含：

```text
版本：release_tag
Release commit：完整 release_commit
同步日期：integration merge 的 committer UTC 日期
Merge：integration merge 前 10 位 SHA
```

同步记录只保留当前 Release 一条，并引用 Release commit 前 12 位和 merge 前 10 位。

## 5.1 新 merge

使用本次 `merge_commit` 更新字段。只复核此次 Release/冲突直接影响的 fork 差异；NEVER 每日重新全仓审计。

只暂存 `fork.md`，验证提交范围后创建独立 docs commit；该提交只修改此文件，父提交为 `merge_commit`。

## 5.2 commit 已包含或新 tag 指向相同代码

- 新 tag、相同 commit：保留原同步日期和 Merge，只更新版本、完整 Release commit和唯一同步记录；不获取历史、不 merge、不运行 Bun/测试。
- 其他 already-contained：在本地已有历史中定位第二父提交精确等于 `release_commit` 的唯一 first-parent merge。找不到或不唯一 → STOP；浅历史不足时只允许第 2.2 节的一次定向 deepen。

字段不一致则校正并创建只修改 `fork.md` 的 docs commit。文档失败 → 恢复文件、保持工作区 clean、不更新镜像，并报告 partial。

# 6. 唯一远程分支：`origin/upstream`

## 6.1 查询当前状态

确认 `origin` 的全部 fetch/push URL 均唯一解析为 `jchanghong023/oh-my-pi`。只查询：

```bash
origin_upstream_line="$(git_guarded ls-remote --heads origin refs/heads/upstream)"
```

失败、超过一条或格式异常 → STOP。空输出表示远端不存在；存在时记录 `expected_origin_upstream`。

只读本地状态：

```text
local_upstream_sha = refs/heads/upstream 的 SHA，缺失则为空
local_upstream_tracking = upstream 的 tracking，缺失则为空
```

如果同时满足：

```text
expected_origin_upstream == release_commit
local_upstream_sha == release_commit
local_upstream_tracking == origin/upstream
本地 refs/remotes/origin/upstream == release_commit
```

立即返回 `mirror already current`。MUST NOT fetch、push、移动分支或设置 tracking。

## 6.2 修复前置

仅当镜像不完整时：

- 显式确认没有进行中的 merge/rebase/cherry-pick/revert/am/bisect/sequencer 操作。
- 若本地 `upstream` 需要创建或移动，确认没有任何 worktree 正检出它；NEVER 自动切换用户分支。
- 若本地缺少 `release_commit` 对象，只从固定上游 URL精确 fetch 当前 tag：shallow 仓库用 `--depth=1`，完整仓库不用 `--depth`。

## 6.3 修复远端

远端不存在：

```bash
git_guarded push --no-verify --no-follow-tags --no-signed --recurse-submodules=no \
  --force-with-lease="refs/heads/upstream:" \
  origin "${release_commit}:refs/heads/upstream"
```

远端已等于 `release_commit`：不 push。

远端存在但不同：只有在“基线 tag+commit 与最新完全一致”，或新 Release 的本地 merge/docs 已完成时，才执行：

```bash
git_guarded push --no-verify --no-follow-tags --no-signed --recurse-submodules=no \
  --force-with-lease="refs/heads/upstream:$expected_origin_upstream" \
  origin "${release_commit}:refs/heads/upstream"
```

push 后或结果不确定时只重新查询一次；远端未达到 `release_commit` → STOP，不刷新 lease 重试。

## 6.4 修复本地镜像

先精确刷新唯一允许的 remote-tracking ref：

```bash
git_guarded fetch --no-tags origin "+refs/heads/upstream:refs/remotes/origin/upstream"
```

仅当本地 `upstream` 缺失或 SHA 不等于 `release_commit` 时执行：

```bash
git_guarded branch -f upstream "$release_commit"
```

仅当 tracking 不等于 `origin/upstream` 时执行：

```bash
git_guarded branch --set-upstream-to=origin/upstream upstream
```

最终验证四项精确相等。任何失败 → STOP。

# 7. 最终报告

## 无新 Release

```text
Release: <release_tag>（无新版本）
Release commit: <release_commit>
Fast gate: tag and commit matched fork baseline
Main branch: not switched or modified; only fork.md snapshot read
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
- 每日无变化必须真正 no-op。
- 上游只检查 latest Release 及其精确 tag commit。
- 唯一远程分支是 `origin/upstream`；不查询或同步任何其他远程分支。
- 浅历史最多一次定向 deepen；NEVER unshallow。
- 本机绝不运行 Rust/native 工具链或完整重型测试。
</critical>
