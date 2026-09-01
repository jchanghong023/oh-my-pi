---
name: upstream-release-sync
description: Merge the latest formally published can1357/oh-my-pi GitHub Release into this fork's main branch, automatically resolve merge conflicts when reliable, and keep origin/upstream as an exact mirror of that Release commit. Use when the user asks to sync, merge, update, or pull the newest upstream release/version/tag; 上游发布新版本、同步上游正式版、合入最新 release、按发布页版本升级。 Requires a published GitHub Release, never a tag-only version.
---

# 上游正式 Release 同步

目标固定为两件事：

1. 将 `can1357/oh-my-pi` 最新正式 GitHub Release 合入 fork 的 `main`，发生冲突时主动自动解决。
2. 让本地 `upstream`、`origin/upstream` 与该 Release 的 commit 精确一致；`upstream` 是可重建的纯镜像分支，不承载 fork 改动。

<critical>
- MUST 以 GitHub Release API 返回的最新正式 Release 为唯一版本来源；NEVER 用 tag 排序、`git describe` 或 `upstream/main` 猜版本。
- Release MUST 满足 `draft=false`、`prerelease=false`、`published_at` 非空。
- 目标分支固定为 `main`；NEVER 将 Release 合入其他 fork 分支。
- MUST 仅合并 Release 的原始 `tag_name`；NEVER merge/pull `upstream/main`。
- `origin/upstream` MUST 精确等于 `release_commit`，不得包含 fork-only commit。
- 本地 `upstream` MUST 精确等于 `release_commit` 并跟踪 `origin/upstream`；缺失时自动创建，tracking 缺失或错误时自动校正。
- `upstream` 是专用镜像分支，允许为恢复镜像不变量而重建本地 ref，并仅对 `origin/upstream` 使用带精确 lease 的 `--force-with-lease`；NEVER 对其他分支 force-push。
- 工作区不干净或已有 merge/rebase/cherry-pick 进行中时 STOP；NEVER 自动 stash、reset 或丢弃用户改动。
- merge 出现冲突时 MUST 主动尝试完整解决；NEVER 仅因出现冲突就停止。只有无法从代码、历史、调用关系和 fork 差异中可靠判断正确结果时才 STOP。
- 无冲突 merge 不运行代码测试、检查、构建或编译；发生冲突并修改解决结果时，提交 merge 前 MUST 且仅运行 `bun run fastcheck`。这是 `AGENTS.md` Local Verification 的上游同步专用规则。
- MUST 保留 fork 治理文件：`AGENTS.md`、`.omp/skills/upstream-release-sync/SKILL.md`、`docs-zh-CN/fork.md`。其中 `docs-zh-CN/fork.md` 在 merge 后按当前 Release 更新。
- NEVER 自动 push `main`、创建 tag 或发布 Release；默认自动 push 的唯一分支是专用镜像 `upstream` → `origin/upstream`。
</critical>

## 固定对象

- Fork：`jchanghong023/oh-my-pi`
- 目标分支：`main`
- 上游仓库：`can1357/oh-my-pi`
- 上游远端：`upstream` → `https://github.com/can1357/oh-my-pi.git`
- Fork 远端：`origin`
- Release API：`https://api.github.com/repos/can1357/oh-my-pi/releases/latest`
- Release 镜像：本地 `upstream` → `origin/upstream`
- Fork 快照：`docs-zh-CN/fork.md`

## 完成条件

仅当以下条件全部满足时报告完成：

1. `release_tag` 来自最新正式 GitHub Release，且本地 tag 对应 `release_commit`。
2. `main` 包含 `release_commit`，并保留同步前 `main` 历史。
3. merge 无未解决冲突；若本次出现冲突，`bun run fastcheck` 已通过。
4. 本地 `refs/heads/upstream == release_commit`。
5. 远端 `origin/upstream == release_commit`，以远端实际 ref 再次确认。
6. 本地 `upstream` 跟踪 `origin/upstream`。
7. `docs-zh-CN/fork.md` 当前基线与唯一同步记录匹配 `release_tag`；新 merge 时记录对应 merge commit。
8. 工作区最终 clean；`main` 未被自动 push。

## 流程

### 1. 前置检查并固定到 `main`

从仓库根目录检查：

```bash
git rev-parse --is-inside-work-tree
git status --porcelain=v1
git branch --show-current
git remote get-url origin
git remote get-url upstream 2>/dev/null || true
```

要求：

- 工作区 MUST 无 staged、unstaged、untracked 文件。
- MUST 无 merge、rebase、cherry-pick 进行中。
- `origin` MUST 是 `jchanghong023/oh-my-pi` fork；不是则 STOP。
- `upstream` 远端缺失时自动添加：

```bash
git remote add upstream https://github.com/can1357/oh-my-pi.git
```

- `upstream` 远端已存在但不是 `can1357/oh-my-pi` → STOP，NEVER 自动改写。
- MUST 切换到 `main`；`main` 不存在 → STOP，NEVER 从其他分支猜测创建。

```bash
git switch main
pre_merge_head="$(git rev-parse HEAD)"
```

随后 MUST 完整读取：

- `AGENTS.md`
- `docs-zh-CN/fork.md`
- `.omp/skills/upstream-release-sync/SKILL.md`

### 2. 确定最新正式 Release

读取：

```text
https://api.github.com/repos/can1357/oh-my-pi/releases/latest
```

记录：`tag_name`、`html_url`、`published_at`、`draft`、`prerelease`。

继续条件：

```text
draft == false
prerelease == false
published_at != null
html_url 属于 can1357/oh-my-pi/releases/tag/
```

设置：

```text
release_tag = 原始 tag_name
```

API 不可达、限流、字段缺失或不是正式 Release → STOP。NEVER 降级为 tag 排序、`git describe`、`git ls-remote` 或 `upstream/main` 选版本。

### 3. Fetch 精确 Release tag

```bash
git fetch upstream "refs/tags/$release_tag:refs/tags/$release_tag"
git show-ref --verify --quiet "refs/tags/$release_tag"
release_commit="$(git rev-parse "$release_tag^{commit}")"
```

如果本地同名 tag 因对象不同导致 fetch 拒绝，才允许读取远端同名 tag 对象进行比较；对象不一致 → STOP，NEVER 覆盖本地 tag。

### 4. 先同步 Release 镜像 `upstream`

`upstream` 是可重建镜像，不保存 fork 历史。其唯一正确状态是：

```text
refs/heads/upstream == origin/upstream == release_commit
```

先查询远端镜像是否存在：

```bash
remote_upstream_line="$(git ls-remote --heads origin refs/heads/upstream)"
```

始终将本地镜像 ref 重建到 Release commit；当前已在 `main`，因此不会修改检出的工作树：

```bash
git branch -f upstream "$release_commit"
```

#### 4a. `origin/upstream` 不存在

直接创建远端镜像：

```bash
git push origin "refs/heads/upstream:refs/heads/upstream"
```

#### 4b. `origin/upstream` 已存在

提取查询到的远端旧 SHA 为 `expected_origin_upstream`。若其已经等于 `release_commit`，无需 push。

若不同，专用镜像分支允许覆盖旧镜像，但 MUST 使用精确 lease 防止并发覆盖：

```bash
git push \
  --force-with-lease="refs/heads/upstream:$expected_origin_upstream" \
  origin "refs/heads/upstream:refs/heads/upstream"
```

NEVER 对 `main` 或任何其他分支使用 force/force-with-lease。

随后刷新 tracking ref 并设置本地 tracking：

```bash
git fetch origin "refs/heads/upstream:refs/remotes/origin/upstream"
git branch --set-upstream-to=origin/upstream upstream
```

立即验证：

```bash
test "$(git rev-parse refs/heads/upstream)" = "$release_commit"
test "$(git rev-parse refs/remotes/origin/upstream)" = "$release_commit"
test "$(git for-each-ref --format='%(upstream:short)' refs/heads/upstream)" = "origin/upstream"
test "$(git ls-remote --heads origin refs/heads/upstream | awk '{print $1}')" = "$release_commit"
```

任一失败 → 镜像同步未完成，STOP。

### 5. 将 Release 合入 `main`

确认仍在 `main`：

```bash
test "$(git branch --show-current)" = "main"
```

先判断是否已经包含：

```bash
git merge-base --is-ancestor "$release_commit" main
```

返回 0：

- 标记 `already_contained=true`。
- NEVER 再创建 merge commit。
- 直接进入第 7 节快照对账。

返回非 0：

```bash
git merge --no-ff --no-edit "$release_tag"
```

- merge 成功且无冲突 → 记录 `merge_commit=$(git rev-parse HEAD)`，直接进入第 7 节；NEVER 运行代码验证。
- merge 进入冲突状态 → MUST 执行第 6 节自动解决。

NEVER 使用 `git merge upstream/main`、`git pull upstream main`、rebase、squash 或 cherry-pick 代替 Release merge。

### 6. 自动解决 merge 冲突

先定位：

```bash
git status --short
git diff --name-only --diff-filter=U
```

#### 6a. Fork 治理文件

以下文件属于 fork 有意差异；发生冲突时 MUST 以 fork 版本为基线保留，NEVER 被上游覆盖：

- `AGENTS.md`
- `.omp/skills/upstream-release-sync/SKILL.md`
- `docs-zh-CN/fork.md`

对这 3 个文件允许显式使用 `--ours` 解决冲突；`docs-zh-CN/fork.md` 在 merge commit 完成后再按第 7 节更新。

#### 6b. 其他冲突

对其他文件：

1. MUST 逐文件理解双方改动意图；NEVER 批量 `--ours` / `--theirs`。
2. MUST 保留 `docs-zh-CN/fork.md` 中列出的 fork 功能，同时迁移 Release 的接口、类型、调用方和行为变化。
3. 修改或删除导出符号前 MUST 搜索全部相关 references。
4. Lockfile 冲突：先正确合并依赖清单，再使用仓库对应包管理器重建 lockfile；禁止手工拼接 lockfile，禁止借机升级无关依赖。
5. MUST 主动完成所有可可靠判断的冲突；只有证据不足、双方语义不可兼容或无法可靠确定正确行为时才 STOP，并保留现场说明阻塞点。
6. NEVER 使用 `git reset --hard`、rebase、squash 或 cherry-pick 逃避冲突。

解决后：

```bash
git add <resolved-files>
git diff --name-only --diff-filter=U
```

必须无 unresolved 文件。随后本次同步唯一允许的代码验证是：

```bash
bun run fastcheck
```

`fastcheck` 失败 → 保留 merge 状态，报告退出码与关键错误；NEVER 改跑其他测试、构建或编译命令。

`fastcheck` 通过：

```bash
git commit --no-edit
merge_commit="$(git rev-parse HEAD)"
```

### 7. 更新 `docs-zh-CN/fork.md`

该文件是当前状态快照，不是 Release 历史账本。

#### 7a. 新建 merge 路径

计算 merge 的 committer UTC 日期：

```bash
merge_timestamp="$(git log -1 --pretty=format:%cI "$merge_commit")"
merge_date="$(bun -e 'console.log(new Date(process.argv[1]).toISOString().slice(0,10))' "$merge_timestamp")"
merge_short="$(printf '%s' "$merge_commit" | cut -c1-10)"
```

更新：

- “当前上游基线”中的版本 = `release_tag`。
- 同步日期 = `merge_date`。
- Merge = `merge_short`。
- “上游同步记录”段必须且只能保留一条当前记录：`merge_date`：合入正式 release `release_tag`（merge `merge_short`）。
- “Fork 改动”内容继续描述 fork 当前真实差异；不得因上游同步删除仍然存在的 fork 差异。

若文件发生变化，独立提交：

```bash
git add docs-zh-CN/fork.md
git commit -m "docs(fork): record upstream ${release_tag}"
fork_doc_commit="$(git rev-parse HEAD)"
```

此 docs commit MUST 只修改 `docs-zh-CN/fork.md`。

#### 7b. Release 已经包含路径

若 `main` 已包含 `release_commit`：

- `docs-zh-CN/fork.md` 已指向同一 `release_tag` → 不创建 docs commit。
- 文档基线不同 → 查找 `main` first-parent 历史中第二父提交精确等于 `release_commit` 的 merge commit。
- 恰好找到一个 → 使用该 merge 的 committer UTC 日期/hash 按第 7a 节格式校正快照并创建独立 docs commit。
- 找不到或找到多个 → 不猜测；报告“代码已包含 Release，但 fork 快照无法可靠对账”，任务状态为部分完成。

### 8. 最终验证

必须在 `main`：

```bash
test "$(git branch --show-current)" = "main"
git merge-base --is-ancestor "$release_commit" main
git merge-base --is-ancestor "$pre_merge_head" main
git status --porcelain=v1
```

镜像必须再次从远端确认：

```bash
test "$(git rev-parse refs/heads/upstream)" = "$release_commit"
test "$(git rev-parse refs/remotes/origin/upstream)" = "$release_commit"
test "$(git for-each-ref --format='%(upstream:short)' refs/heads/upstream)" = "origin/upstream"
test "$(git ls-remote --heads origin refs/heads/upstream | awk '{print $1}')" = "$release_commit"
```

文档必须满足：

- “当前上游基线”只有一个。
- 版本为 `release_tag`。
- “上游同步记录”只有一个，且只记录当前 `release_tag`。
- 新 merge 路径的 Merge/hash 与实际 `merge_commit` 一致。

代码验证规则：

- 本次 merge 从未冲突 → MUST NOT 运行代码测试、检查、构建或编译。
- 本次 merge 出现过冲突 → `bun run fastcheck` MUST 已在 merge commit 前通过；NEVER 额外运行其他代码验证。

### 9. 最终报告

简洁报告：

```text
Release: <release_tag>
Release URL: <html_url>
Release commit: <release_commit>
Main: merged @ <merge_commit> / already contained
Conflict resolution: none / auto-resolved + fastcheck passed / blocked
Upstream mirror: local upstream == origin/upstream == <release_commit>
Fork snapshot: updated @ <fork_doc_commit> / already current / reconciliation blocked
Working tree: clean / not clean
Main push: not performed
```

<critical>
- 核心 Git 关系必须是：`main` 包含 `release_commit`；本地 `upstream == origin/upstream == release_commit`。
- `upstream` 是可重建的正式 Release 镜像，不是开发分支，不保留 fork commit。
- 只有 `origin/upstream` 允许自动 push；镜像漂移时仅允许带精确旧 SHA lease 的 `--force-with-lease`。
- 冲突必须先自动尝试解决；不能可靠解决才停止。
- 三个 fork 治理文件必须保留：`AGENTS.md`、`.omp/skills/upstream-release-sync/SKILL.md`、`docs-zh-CN/fork.md`。
- NEVER 同步 `upstream/main`；NEVER 自动 push `main`。
</critical>
