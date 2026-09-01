---
name: upstream-release-sync
description: Keep this fork continuously aligned with the exact current HEAD of can1357/oh-my-pi main. On every run, inspect only the fixed upstream refs/heads/main and origin/upstream, perform a true no-op when current, otherwise merge the verified upstream commit into the existing local main, resolve reliable conflicts, avoid Rust/native work, update the fork snapshot, and mirror that commit to origin/upstream. The historical skill name and path are retained for compatibility; GitHub Releases and tags are never consulted.
---

# 持续同步上游 `main`

> `.omp/skills/upstream-release-sync/` 是历史兼容路径。当前流程不再跟踪 GitHub Release 或 tag；每次执行都以 `can1357/oh-my-pi` 的 `refs/heads/main` 当前精确 HEAD 为同步目标。

## 不变量

1. 上游来源固定为 `https://github.com/can1357/oh-my-pi.git` 的 `refs/heads/main`。
2. 本地 `main` 包含 `baseline_upstream_commit`；成功同步后包含本次确认的 `upstream_head`，同时保留 fork 改动。
3. 本地 `upstream == origin/upstream == baseline_upstream_commit`，且本地 `upstream` 跟踪 `origin/upstream`。
4. 允许访问的远程分支仅有固定上游 `refs/heads/main` 与本 fork 的 `origin/upstream`。
5. 不读取 Release/tag，不依赖配置型 `upstream` remote，不自动 push `main` 或 tag，本机不运行 Rust/native 工具链。

<critical>
- MUST 先执行第 0 节快速门禁。上游 `main` HEAD、快照基线与四项镜像均未变化时必须真正 no-op：不切分支、不 fetch、不改 ref、不运行检查或测试。
- 上游目标只能来自固定 URL 的精确 `refs/heads/main`；NEVER 查询 GitHub Release、tag、其他 branch、仓库活动或用 `target_commitish` 猜同步目标。
- NEVER 查询、比较、拉取、合并或重置 `origin/main`、配置型 `upstream/main` 或任何其他远程分支。
- 精确 fetch 只能把固定上游 `refs/heads/main` 写入临时 ref `refs/omp-sync/upstream-main`；验证完成前不得移动镜像或合入 `main`。
- fetch 后 MUST 再确认远端 HEAD；若 fetch 期间上游移动，只允许重新 fetch/确认一次，再次移动即 STOP。
- `baseline_upstream_commit` MUST 是 `upstream_head` 的祖先；否则视为上游历史改写或目标历史不足，定向补历史后仍不能证明即 STOP，NEVER 自动接受 force-push 或降级。
- 新 merge 使用 `--no-ff --no-commit`；失败必须安全 abort，不留下半完成 merge。
- 无冲突默认只做 staged Git 检查；若上游触及 fork 的 `fastcheck`/lint/format 契约，必须将其作为窄范围兼容契约审计并运行一次安全的 `fastcheck`。
- 有冲突仅运行一次 `fastcheck`、冲突 workspace 的安全 `check:types` 和最多 3 个直接测试。
- NEVER 运行根级 `bun run check`、完整测试套件、全 workspace 检查、UI/browser/heavy、Docker、benchmark、打包、发布、`cargo`、`bazel`、`nix build`，或任何 Rust/native build/check/test/lint/fmt/clippy/codegen/packaging。
- `AGENTS.md`、本文件、`docs-zh-CN/fork.md` 始终保留同步前 fork 版本；仅 `fork.md` 在 merge 后按实际结果更新。
- 只有本地 `main` 已成功包含目标 commit 且 `fork.md` 已更新，才允许把 `origin/upstream` 镜像推进到该 commit。
</critical>

## 唯一允许访问的远程对象

- 固定 URL `https://github.com/can1357/oh-my-pi.git` 的精确 `refs/heads/main`
- 本 fork 的 `origin/upstream`
- 本地 `origin` 的 fetch/push URL，仅用于确认它唯一解析为 `jchanghong023/oh-my-pi`
- 浅历史补全时：固定上游 `refs/heads/main`，以及 `origin` 中当前本地 `main` 的精确 `pre_merge_head` SHA

禁止运行或访问：

```text
GitHub /releases、/tags 或 tag refs
任何 origin/main、upstream/main 或其他远程分支操作
git fetch --all
git remote update
git branch -r
git ls-remote --heads（未精确限定 refs/heads/main 或 refs/heads/upstream）
git ls-remote --tags
```

## 执行预算

- 快速门禁不创建 TODO、不启动子代理、不重试、不使用 PTY/async。
- 精确 `ls-remote`、`origin/upstream` 查询：单次工具 timeout ≤ 20 秒。
- 精确上游 `main` fetch、唯一一次定向 deepen：单次 timeout ≤ 120 秒。
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

# 0. 每次执行快速门禁

## 0.1 读取上游 `main` 当前精确 HEAD

只执行一次：

```bash
upstream_url="https://github.com/can1357/oh-my-pi.git"
upstream_ref="refs/heads/main"
upstream_line="$(git_guarded ls-remote --heads "$upstream_url" "$upstream_ref")"
```

必须满足：

- 输出恰好一条；
- 格式为 `<40 位十六进制 SHA><TAB>refs/heads/main`；
- ref 名完全等于 `refs/heads/main`。

设置 `candidate_upstream_head`。失败、空输出、多行或格式异常 → STOP；不得降级到 Release、tag、网页、API 列表或其他发现方式。

## 0.2 读取本地基线

不切分支、不补历史：

```bash
git_guarded rev-parse --is-inside-work-tree
git_guarded show-ref --verify --quiet refs/heads/main
main_head_at_gate="$(git_guarded rev-parse main)"
fork_snapshot="$(git_guarded show main:docs-zh-CN/fork.md)"
```

“当前上游基线”必须唯一包含：

```text
分支：can1357/oh-my-pi@main
版本：vMAJOR.MINOR.PATCH
Upstream commit：完整 40 位 SHA
同步日期：YYYY-MM-DD
Integration：10 位 SHA
```

“上游同步记录”必须唯一且只含一条，并引用当前 upstream commit 前 12 位和 Integration 的 10 位 SHA。结构异常 → STOP，不扩散调查。

设置：

```text
baseline_version
baseline_upstream_commit
baseline_integration
```

必须能读取 `baseline_upstream_commit` commit 对象。若本地历史足以判断，还必须证明它是 `main` 的祖先；无法证明时记录 `baseline_ancestry_unproven=true`，不得走无变化或镜像修复路径，只能在有新上游 commit 时进入第 2.2 节定向补证。

## 0.3 读取镜像状态

确认 `origin` 的全部 fetch/push URL 均唯一解析为 `jchanghong023/oh-my-pi`。只查询：

```bash
origin_upstream_line="$(git_guarded ls-remote --heads origin refs/heads/upstream)"
```

失败、超过一条或格式异常 → STOP。空输出表示远端不存在。

只读本地：

```text
local_upstream_sha = refs/heads/upstream 的 SHA，缺失则为空
local_upstream_tracking = upstream 的 tracking，缺失则为空
origin_tracking_sha = refs/remotes/origin/upstream 的 SHA，缺失则为空
```

## 0.4 分类

### A. 上游 HEAD 等于基线

```text
candidate_upstream_head == baseline_upstream_commit
baseline_ancestry_unproven == false
```

若同时满足：

```text
origin/upstream == baseline_upstream_commit
local_upstream_sha == baseline_upstream_commit
local_upstream_tracking == origin/upstream
origin_tracking_sha == baseline_upstream_commit
```

立即返回 `upstream main already current`。MUST NOT 切分支、fetch、移动 ref、运行检查或测试。

镜像不完整时直接进入第 6 节，只修复到 `baseline_upstream_commit`；不得执行第 1–5 节。

### B. 上游 HEAD 不同于基线

进入第 1–5 节。候选 commit 可以包含任意数量的正常上游提交，不做版本或 Release 门禁。

### C. 基线祖先关系无法证明且上游 HEAD 未变化

报告 `baseline ancestry not provable` 并 STOP。不得为无变化路径补历史、改镜像或切换分支。

# 1. 本地前置检查

仅由第 0.4-B 进入：

```bash
test -z "$(git_guarded status --porcelain=v1 --untracked-files=all)"
git_guarded show-ref --verify --quiet refs/heads/main
git_guarded switch --no-guess main
test "$(git_guarded branch --show-current)" = main
pre_merge_head="$(git_guarded rev-parse HEAD)"
test "$pre_merge_head" = "$main_head_at_gate"
```

工作区不干净、本地 `main` 不存在、无法切换或门禁后 HEAD 已变化 → STOP。NEVER stash、reset、clean 或隐式创建分支。

显式确认没有：

```text
MERGE_HEAD、CHERRY_PICK_HEAD、REVERT_HEAD、REBASE_HEAD、AM_HEAD、BISECT_START
rebase-merge、rebase-apply、sequencer
```

完整读取三个治理文件。再次确认 `origin` 的全部 fetch/push URL 均唯一解析为 `jchanghong023/oh-my-pi`；不得检查任何其他远程分支。

删除此前成功流程遗留的临时 ref（若存在）：

```bash
git_guarded update-ref -d refs/omp-sync/upstream-main
```

# 2. 精确获取并确认稳定的上游 `main`

## 2.1 精确 fetch 与一次移动重试

首次 fetch：

```bash
if [ "$(git_guarded rev-parse --is-shallow-repository)" = true ]; then
  git_guarded fetch --depth=256 --no-tags --update-shallow \
    "$upstream_url" \
    "+refs/heads/main:refs/omp-sync/upstream-main"
else
  git_guarded fetch --no-tags \
    "$upstream_url" \
    "+refs/heads/main:refs/omp-sync/upstream-main"
fi
fetched_head="$(git_guarded rev-parse refs/omp-sync/upstream-main)"
```

再次只查询固定 `refs/heads/main`。若远端 HEAD 等于 `fetched_head`，设置：

```text
upstream_head = fetched_head
```

若远端 HEAD 已移动，只允许重新执行同一精确 fetch 一次，再查询一次；第二次仍不一致 → STOP，报告 `upstream main moved repeatedly`。不得循环追赶。

最终要求临时 ref、最后一次 `ls-remote` 与 `upstream_head` 三者完全相等。

## 2.2 前进关系与 merge base

必须证明：

```bash
git_guarded merge-base --is-ancestor "$baseline_upstream_commit" "$upstream_head"
git_guarded merge-base main "$upstream_head"
```

任一失败且仓库非 shallow → STOP，报告 `upstream main history rewrite or unrelated history`；NEVER 使用 `--allow-unrelated-histories`。

任一失败且仓库 shallow → 只允许一次定向 deepen：

```bash
git_guarded fetch --deepen=1024 --no-tags origin "$pre_merge_head"
git_guarded fetch --deepen=1024 --no-tags --update-shallow \
  "$upstream_url" \
  "+refs/heads/main:refs/omp-sync/upstream-main"
```

定向 deepen 后临时 ref MUST 仍等于已确认的 `upstream_head`；若上游已移动，STOP 并要求下次重新执行，不在历史补全过程继续追赶。

再次证明前进关系和 merge base。仍失败 → STOP，报告 `targeted history insufficient or upstream main rewritten`；NEVER unshallow 或查询其他远程分支。

## 2.3 解析版本基线

从精确 `upstream_head` 读取：

```text
packages/coding-agent/package.json
```

要求 `version` 唯一且符合 SemVer `MAJOR.MINOR.PATCH`，允许附带 prerelease/build 后缀。取核心三段并设置：

```text
upstream_package_version = 原始 version
baseline_version = vMAJOR.MINOR.PATCH
```

该字段只用于 fork 发布版本基线和 `ci.yml` 兼容，不参与是否同步的判断。读取或解析失败 → 在 merge 前 STOP。

# 3. 事务式 merge 与冲突处理

若 `upstream_head` 已是本地 `main` 祖先：

```text
already_contained = true
integration_commit = pre_merge_head
```

不创建空 merge，直接进入第 5 节更新快照。

否则：

```bash
merge_had_conflicts=false
if git_guarded merge --no-ff --no-commit --no-edit refs/omp-sync/upstream-main; then
  initial_conflicted_paths=""
else
  merge_had_conflicts=true
  initial_conflicted_paths="$(git_guarded diff --name-only --diff-filter=U)"
fi
```

必须存在 `MERGE_HEAD == upstream_head`。失败但没有有效 `MERGE_HEAD`，或声称冲突却没有 U 路径 → 第 4.3 节 abort 后 STOP。

无论是否冲突，都恢复并暂存三个治理文件：

```bash
git_guarded restore --source="$pre_merge_head" --staged --worktree -- \
  AGENTS.md \
  .omp/skills/upstream-release-sync/SKILL.md \
  docs-zh-CN/fork.md
```

有冲突时：

1. 其他文件逐个理解双方意图；NEVER 批量选择 `--ours` 或 `--theirs`。
2. 保留 `fork.md` 当前 fork 功能，同时迁移上游 `main` 的接口、类型、数据结构、调用方和行为。
3. 修改、移动或删除导出符号前搜索本地 references，并审查直接调用方和相关测试。
4. 上游改动触及 `package.json`、lint/format 配置或 fork 的 `fastcheck` 实现时，必须保留 `fastcheck` 用户契约，并把实现适配到合入后的真实工具链，禁止保留指向已删除工具或配置的脚本。
5. Lockfile 冲突先合并 manifests；仅在必要时运行 `bun install --lockfile-only --ignore-scripts`，并确认未产生其他文件。
6. 无法可靠判断 → abort；Rust/native 冲突只做语义审查和非 Rust 调用侧检查。

逐文件 `git_guarded add`，要求无 unmerged、unstaged 和 untracked 文件。

# 4. 提交前窄范围验证与 merge commit

## 4.1 所有 merge

```bash
git_guarded diff --cached --check
test "$(git_guarded rev-parse MERGE_HEAD)" = "$upstream_head"
test -z "$(git_guarded diff --name-only)"
test -z "$(git_guarded ls-files -u)"
test -z "$(git_guarded ls-files --others --exclude-standard)"
validation_tree="$(git_guarded write-tree)"
```

审查 staged diff，确认无冲突标记、误删治理文件、异常全仓格式化、无关生成文件或不属于 `baseline_upstream_commit..upstream_head` 与必要冲突解决的改动。

若没有冲突，且上游区间未触及 fork 的 `fastcheck`/lint/format 契约，直接进入第 4.4 节。

## 4.2 冲突路径和验证契约路径

只读取根 `package.json`、实际 `fastcheck` 实现及冲突文件所在 workspace 的 `package.json`；不得遍历所有 workspace。

1. 冲突中存在 TypeScript，或上游区间触及 fork 的 `fastcheck`/lint/format 契约 → 审计 `fastcheck`、`prefastcheck`、`postfastcheck` 后运行一次 `bun run fastcheck`。若工具链已变化，必须先完成第 3 节要求的兼容适配。
2. 冲突 workspace 存在 `check:types` 时，必须同时审计 `precheck:types`、`check:types`、`postcheck:types`；确认不触发 Rust/native、build、codegen、Docker 或安装后，逐个运行：

```bash
bun --cwd=<conflicted-workspace> run check:types
```

3. 最直接既有测试最多 3 个，逐个运行；禁止 workspace/全仓测试、UI/browser/heavy/native 和网络集成测试。
4. Shell/Python/JSON/YAML 冲突只做对应轻量语法解析；不得借此启动完整构建。
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
git_guarded update-ref -d refs/omp-sync/upstream-main
```

abort 失败时 NEVER 使用 `reset --hard`；保留现场并准确报告。回滚成功后不得更新 `fork.md` 或镜像。

## 4.4 创建 merge commit

```bash
upstream_short="${upstream_head:0:12}"
git_guarded commit --no-gpg-sign -m "sync(upstream): merge main@$upstream_short"
merge_commit="$(git_guarded rev-parse HEAD)"
integration_commit="$merge_commit"
```

验证第一父提交为 `pre_merge_head`、第二父提交为 `upstream_head`，工作区 clean。

# 5. 更新和校验 `docs-zh-CN/fork.md`

基线固定包含：

```text
分支：can1357/oh-my-pi@main
版本：baseline_version
Upstream commit：完整 upstream_head
同步日期：本次集成的 UTC 日期 YYYY-MM-DD
Integration：integration_commit 前 10 位 SHA
```

同步记录只保留当前上游 `main` 一条，并引用 upstream commit 前 12 位、`upstream_package_version` 和 Integration 前 10 位。

只复核本次上游区间和冲突直接影响的 fork 差异；NEVER 每次重新全仓审计。

- 新 merge：以 `merge_commit` 作为 `integration_commit`。
- already-contained：以进入同步时的 `pre_merge_head` 作为 `integration_commit`，明确记录 `already contained`，不伪造 merge。

只暂存 `fork.md`，验证提交范围后创建独立 docs commit；该提交只修改此文件，父提交为 `integration_commit`。

字段已完全一致时不创建空 docs commit。文档失败 → 恢复文件、保持工作区 clean、不更新镜像，并报告 partial。

# 6. `origin/upstream` 上游 `main` 镜像

## 6.1 目标 commit

- 第 0.4-A 镜像修复路径：`mirror_target = baseline_upstream_commit`。
- 第 1–5 节成功路径：`mirror_target = upstream_head`，且本地 `main` MUST 已包含该 commit，`fork.md` MUST 已记录该 commit。

## 6.2 查询当前状态

再次确认 `origin` 的全部 fetch/push URL 均唯一解析为 `jchanghong023/oh-my-pi`。只查询：

```bash
origin_upstream_line="$(git_guarded ls-remote --heads origin refs/heads/upstream)"
```

同时读取本地 `upstream`、tracking 与 `refs/remotes/origin/upstream`。

四项均精确等于 `mirror_target` 时立即返回 `mirror already current`。MUST NOT fetch、push、移动分支或设置 tracking。

## 6.3 修复前置

仅当镜像不完整时：

- 显式确认没有进行中的 merge/rebase/cherry-pick/revert/am/bisect/sequencer 操作。
- 若本地 `upstream` 需要创建或移动，确认没有任何 worktree 正检出它；NEVER 自动切换用户分支。
- 必须证明本地 `main` 包含 `mirror_target`。
- 若本地缺少对象，只能从固定上游 URL 精确 fetch `refs/heads/main`；fetch 后必须验证得到的 commit 等于 `mirror_target`，否则 STOP。

## 6.4 修复远端

远端不存在：

```bash
git_guarded push --no-verify --no-follow-tags --no-signed --recurse-submodules=no \
  --force-with-lease="refs/heads/upstream:" \
  origin "${mirror_target}:refs/heads/upstream"
```

远端已等于 `mirror_target`：不 push。

远端存在但不同：

```bash
git_guarded push --no-verify --no-follow-tags --no-signed --recurse-submodules=no \
  --force-with-lease="refs/heads/upstream:$expected_origin_upstream" \
  origin "${mirror_target}:refs/heads/upstream"
```

push 后或结果不确定时只重新查询一次；远端未达到 `mirror_target` → STOP，不刷新 lease 重试。

## 6.5 修复本地镜像

精确刷新唯一允许的 fork remote-tracking ref：

```bash
git_guarded fetch --no-tags origin "+refs/heads/upstream:refs/remotes/origin/upstream"
```

仅当本地 `upstream` 缺失或 SHA 不等于 `mirror_target` 时执行：

```bash
git_guarded branch -f upstream "$mirror_target"
```

仅当 tracking 不等于 `origin/upstream` 时执行：

```bash
git_guarded branch --set-upstream-to=origin/upstream upstream
```

最终验证四项精确相等。任何失败 → STOP。

# 7. 清理与最终报告

成功且无进行中的 Git 操作后删除临时 ref：

```bash
git_guarded update-ref -d refs/omp-sync/upstream-main
```

## 上游无变化

```text
Upstream: can1357/oh-my-pi@main
Upstream HEAD: <baseline_upstream_commit>（无新 commit）
Fast gate: upstream HEAD matched fork baseline
Main branch: not switched or modified; only fork.md snapshot read
Upstream mirror: already current / repaired
Other remote branches: not queried
History expansion: none
Checks/tests: not run
Mirror push: not needed / performed
Main/tag push: not performed
```

## 上游有变化

```text
Upstream: can1357/oh-my-pi@main
Previous upstream commit: <baseline_upstream_commit>
Upstream HEAD: <upstream_head>
History: sufficient / one targeted deepen / targeted history insufficient
Main: merged @ <merge_commit> / already contained @ <integration_commit>
Conflict resolution: none / auto-resolved / blocked and aborted
Validation: Git staged check; contract/conflict-only checks <list/none>
Rust/native local work: not run
Fork snapshot: updated @ <fork_doc_commit> / already current / blocked
Upstream mirror: local upstream == origin/upstream == <upstream_head> / blocked
Other remote branches: not queried
Working tree: clean / not clean
Main/tag push: not performed
```

<critical>
- 每次执行只认固定上游 `refs/heads/main` 当前精确 HEAD。
- GitHub Release 与 tag 不再参与发现、门禁、merge、镜像或版本判断。
- 无变化必须真正 no-op；有变化必须验证稳定 HEAD、前进关系、merge base 和 fork 契约后再合入。
- 唯一允许访问的远程分支是固定上游 `main` 与 `origin/upstream`；不查询或同步其他远程分支。
- 浅历史最多一次定向 deepen；NEVER unshallow。
- 本机绝不运行 Rust/native 工具链或完整重型测试。
- 不自动 push `main` 或 tag。
</critical>
