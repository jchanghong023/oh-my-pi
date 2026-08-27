---
name: upstream-release-sync
description: Safely merge the latest formally published can1357/oh-my-pi GitHub Release into this fork. Use when the user asks to sync, merge, update, or pull the newest upstream release/version/tag; 上游发布新版本、同步上游正式版、合入最新 release、按发布页版本升级。 Requires a published GitHub Release, never a tag-only version.
---

# 上游正式发布版本同步

将 `can1357/oh-my-pi` 最新正式 GitHub Release 的 tag 合入当前 fork 分支。

<critical>
- MUST 以 GitHub Release API 返回的正式版本为唯一版本来源。
- Release MUST 满足：`draft=false`、`prerelease=false`、`published_at` 非空。
- MUST 仅合并 Release 的原始 `tag_name`；NEVER 同步 `upstream/main`。
- MUST 保留当前分支历史和用户改动；工作区不干净时 NEVER 合并。
- 目标分支 SHOULD 跟踪 fork 的 `origin/<branch>`；NEVER 跟踪 `upstream/*`。
- NEVER 创建中转分支、rebase、squash、cherry-pick 或覆盖同名 tag。
- 无冲突 → NEVER 运行代码测试、代码检查、构建或编译命令。
- 有冲突 → 仅运行 `bun run fastcheck`；NEVER 运行其他代码验证命令。
- NEVER push、force-push、创建 tag 或发布 Release，除非用户明确要求。
</critical>

## 固定对象

- 上游仓库：`https://github.com/can1357/oh-my-pi.git`
- GitHub 仓库：`can1357/oh-my-pi`
- 上游远端名：`upstream`
- Release API：`https://api.github.com/repos/can1357/oh-my-pi/releases/latest`

## 完成条件

仅当以下条件全部成立时报告完成：

1. 版本来自非草稿、非预发布 GitHub Release。
2. 本地 tag 名与 Release `tag_name` 完全相同。
3. Release commit 和合并前分支头均为当前 `HEAD` 的祖先。
4. 无未解决冲突；工作区状态符合合并前要求。
5. 无冲突时未运行代码验证；有冲突时仅运行且通过 `bun run fastcheck`。
6. 报告 Release URL、版本、tag commit、合并提交、验证结果、push 状态。

## 流程

### 1. 前置检查

从仓库根目录执行最小检查：

```bash
git status --branch
git branch --show-current
tracking_ref="$(git rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' 2>/dev/null || true)"
printf 'tracking=%s\n' "$tracking_ref"
git remote get-url origin
git remote get-url upstream
```

要求：

- 用户未指定目标分支 → 使用当前分支；detached HEAD → STOP。
- 工作区 MUST 无 staged、unstaged、untracked 文件。
- merge、rebase、cherry-pick 进行中 → STOP。
- `origin` MUST 指向用户 fork；错误或缺失 → STOP，NEVER 自动改写。
- `upstream` MUST 指向 `can1357/oh-my-pi`。
- `upstream` 缺失 → 仅添加远端，NEVER 创建分支或 tracking：

```bash
git remote add upstream https://github.com/can1357/oh-my-pi.git
```

Tracking 判定：

- `origin/<当前分支>` → 继续。
- 空 → MAY 继续；最终报告 `none`，NEVER 自动设置。
- `upstream/*` 或其他错误关系 → STOP；用户明确授权后才可改为 `origin/<当前分支>`。

记录合并前提交：

```bash
pre_merge_head="$(git rev-parse HEAD)"
```

工作区不干净时默认 STOP，NEVER 自动 stash 或提交。仅在用户明确授权后：

```bash
git stash push --include-untracked -m "pre-upstream-release-sync"
```

### 2. 确定正式 Release

用 Read 工具读取：

```text
https://api.github.com/repos/can1357/oh-my-pi/releases/latest
```

提取并记录：`tag_name`、`html_url`、`published_at`、`draft`、`prerelease`。

继续条件：

```text
tag_name == release_tag
draft == false
prerelease == false
published_at != null
html_url 包含 /can1357/oh-my-pi/releases/tag/
```

`release_tag` MUST 为原始 `tag_name`。NEVER 规范化、递增或猜测版本号。

API 不可达、限流、字段缺失或结果非正式 Release → STOP。NEVER 降级到 tag 排序、`git describe`、`git ls-remote` 或 `upstream/main` 选择版本。

### 3. 获取选定 tag

仅 fetch 已选 Release tag：

```bash
git fetch upstream "refs/tags/$release_tag:refs/tags/$release_tag"
git show-ref --verify --quiet "refs/tags/$release_tag"
release_commit="$(git rev-parse "$release_tag^{commit}")"
```

Fetch 成功即完成上游来源确认，NEVER 再运行 `git ls-remote`。

本地同名 tag 导致 fetch 拒绝 → 才可运行：

```bash
git ls-remote --exit-code --tags upstream "refs/tags/$release_tag" "refs/tags/$release_tag^{}"
```

比较本地与远端对象并报告不一致；NEVER force 覆盖或继续合并。

### 4. 判断是否已合入

```bash
git merge-base --is-ancestor "$release_tag" HEAD
```

返回 0 → Release 已包含：不创建空 merge commit；直接执行第 7 节历史验证。NEVER 运行代码测试、代码检查、构建或编译命令。

### 5. 合并 Release tag

Tag 尚未合入且工作区干净：

```bash
git merge --no-ff --no-edit "$release_tag"
```

命令成功且无冲突 → 直接执行第 7 节，NEVER 运行代码验证。

命令进入冲突状态 → 记录本次合并发生冲突并执行第 6 节；后续解决不改变该判定。

NEVER 使用 `git merge upstream/main`、`git pull upstream main`、rebase、squash 或 cherry-pick。

### 6. 解决冲突

定位冲突：

```bash
git status --short
git diff --name-only --diff-filter=U
```

规则：

1. MUST 逐文件理解双方意图；NEVER 批量选 `--ours` 或 `--theirs`。
2. MUST 保留 fork 的有意差异，同时迁移 Release 的接口和全部调用方。
3. 修改导出符号前 MUST 查全部 references。
4. Lockfile 冲突：先合并清单，再用仓库包管理器仅重建 lockfile；NEVER 手工拼接、运行生命周期脚本或编译代码。
5. 无法可靠解决 → 保持现场并报告；仅在用户要求时 `git merge --abort`。
6. NEVER 使用 `git reset --hard`。

解决后暂存并确认无 `U` 状态：

```bash
git add <resolved-files>
git diff --name-only --diff-filter=U
```

创建合并提交前，MUST 且仅可运行：

```bash
bun run fastcheck
```

`bun` 不在 `PATH` 时 MAY 使用已确认的 Bun 路径运行同一命令。`fastcheck` MUST 在提交前运行；提交后无本地 TypeScript 改动，会失去检查效果。

NEVER 运行聚焦测试、`bun check`、`omp --smoke-test`、`bun run test:rs`、构建、打包、编译器或任何其他代码测试/代码检查命令。

`fastcheck` 失败 → 保留合并状态，报告命令、退出码和关键错误；NEVER 改跑其他命令或创建提交。

`fastcheck` 通过：

```bash
git commit --no-edit
```

### 7. 验证历史与状态

```bash
git merge-base --is-ancestor "$release_tag" HEAD
git merge-base --is-ancestor "$pre_merge_head" HEAD
git status --short --branch
merge_commit="$(git rev-parse HEAD)"
git rev-list --parents -n 1 HEAD
git rev-parse "$release_tag^{commit}"
```

两个 `merge-base` MUST 返回 0。新建 merge 的 `HEAD` MUST 有两个父提交；已提前包含 Release 时报告 `already contained`。

历史与工作区验证不是代码测试，不受“无冲突不跑测试”规则影响。

### 8. 恢复授权的 stash

仅当第 1 节经用户授权创建过 stash：

```bash
git stash pop
git status --short --branch
```

恢复冲突 MUST 解决或报告；确认恢复成功前 NEVER drop stash。Stash 恢复失败 → 任务未完成。

### 9. 最终报告

```text
Release: <tag_name>
Release URL: <html_url>
Published: <published_at>
Release commit: <release_commit>
Merge commit: <merge_commit 或 already contained>
Branch: <branch>
Tracking branch: <origin/<branch>、none 或错误关系>
Verification: <历史检查；有冲突时另列 fastcheck 结果>
Working tree: <clean 或恢复后的用户改动>
Push: not performed / 明确授权后的实际结果
```

仅有 tag、无对应 GitHub Release → `不可合入：不是发布页面版本`。

<critical>
- Release API 选版本；Git tag 仅承载已选 Release。
- NEVER 同步 `upstream/main`，即使版本号更高。
- 工作区不干净、Release 证据不足、冲突未解、历史验证失败 → NEVER 报告完成。
- MUST 验证 Release tag 与合并前分支头均可达。
- 无冲突 → NEVER 运行代码测试、代码检查、构建或编译。
- 有冲突 → 提交前仅运行 `bun run fastcheck`；NEVER 编译本地代码。
- NEVER push，除非用户明确授权。
</critical>
