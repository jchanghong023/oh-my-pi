---
name: upstream-release-sync
description: Safely merge the latest formally published can1357/oh-my-pi GitHub Release into this fork. Use when the user asks to sync, merge, update, or pull the newest upstream release/version/tag; 上游发布新版本、同步上游正式版、合入最新 release、按发布页版本升级。Requires a published GitHub Release, never a tag-only version.
---

# 上游正式发布版本同步

将 `can1357/oh-my-pi` GitHub Releases 页面上的最新正式版本合入当前 fork 分支。

<critical>
- MUST 以 GitHub Release API 返回的已发布正式版本为唯一版本来源。
- NEVER 根据最新 Git tag、`upstream/main`、版本号排序或 tag 创建时间选版本。
- Release MUST 满足：`draft=false`、`prerelease=false`、`published_at` 非空。
- MUST 仅合并 Release 的 `tag_name`；NEVER 直接合并或同步 `upstream/main`。
- MUST 保留当前分支历史和用户改动；工作区不干净时 NEVER 开始合并。
- MUST 检查当前本地分支的 tracking branch；目标分支 SHOULD 跟踪 fork 的 `origin/<branch>`，NEVER 要求其跟踪 `upstream/main`。
- 仅有本地 `main` 完全有效；NEVER 为同步 Release 额外创建本地 upstream/release 分支，除非用户明确要求。
- NEVER push、force-push、创建 tag、发布 Release，除非用户明确要求。
</critical>

## 固定对象

- 上游仓库：`https://github.com/can1357/oh-my-pi.git`
- GitHub 仓库：`can1357/oh-my-pi`
- 预期远端名：`upstream`
- 发布页：`https://github.com/can1357/oh-my-pi/releases`
- 最新正式 Release API：`https://api.github.com/repos/can1357/oh-my-pi/releases/latest`

## 完成条件

仅在以下条件全部成立时报告完成：

1. 版本来自 GitHub Releases 页面对应的非草稿、非预发布 Release。
2. 本地 tag 与该 Release 的 `tag_name` 完全相同。
3. Release tag commit 和合并前分支头均为当前 `HEAD` 的祖先。
4. 合并无未解决冲突，工作区状态符合合并前状态要求。
5. 必需检查通过；失败则报告失败，NEVER 声称同步完成。
6. 最终报告 Release URL、版本、tag commit、合并提交、验证结果、是否 push。

## 流程

### 1. 检查仓库、分支、远端

从仓库根目录执行：

```bash
git status --short --branch
git branch --show-current
git branch -vv
git remote -v
git remote get-url origin
git remote get-url upstream
tracking_ref="$(git rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' 2>/dev/null || true)"
printf 'tracking=%s\n' "$tracking_ref"
```

要求：

- 当前分支 MUST 是用户要求同步的分支；用户未指定时使用当前分支。
- 仅有本地 `main` 时直接以 `main` 为目标；不需要创建 `upstream-main`、`release/*` 或其他中转分支。
- Git 的“upstream tracking branch”和名为 `upstream` 的远端不是同一概念：目标分支 SHOULD 跟踪 fork 的 `origin/<当前分支>`，而不是上游仓库的 `upstream/main`。
- `tracking_ref` 为 `origin/<当前分支>` → 正常继续。
- `tracking_ref` 为空 → MAY 继续合并，但 MUST 在最终报告中注明“当前分支无 tracking branch”；NEVER 自动设置 tracking。
- `tracking_ref` 为 `upstream/main` 或其他 `upstream/*` → STOP 并报告错误跟踪关系；NEVER 自动改写。用户明确授权后才可执行 `git branch --set-upstream-to=origin/<当前分支> <当前分支>`。
- `origin` MUST 指向用户 fork；`upstream` MUST 指向 `can1357/oh-my-pi`。
- 工作区 MUST 干净：无 staged、unstaged、untracked 文件。
- detached HEAD、merge/rebase/cherry-pick 进行中或远端错误 → STOP，先报告阻塞。
- `upstream` 缺失时直接添加远端；这不会创建任何本地分支或 tracking branch：

```bash
git remote add upstream https://github.com/can1357/oh-my-pi.git
```

`origin` 缺失、远端已存在但 URL 不符时 NEVER 擅自改写；报告实际状态。

记录合并前提交，后续验证 fork 历史未丢失：

```bash
pre_merge_head="$(git rev-parse HEAD)"
```

#### 工作区不干净时

默认 STOP，不自动 stash、不提交用户改动。报告具体文件，让用户先提交或暂存。

用户明确要求临时暂存时，才执行：

```bash
git stash push --include-untracked -m "pre-upstream-release-sync"
```

合并和验证完成后执行 `git stash pop`，再检查冲突。stash 恢复失败意味着任务未完成；NEVER 丢弃 stash。

### 2. 从发布页面确定版本

首选通过 GitHub API/Read 工具读取：

```text
https://api.github.com/repos/can1357/oh-my-pi/releases/latest
```

必须提取并记录：

- `tag_name`
- `html_url`
- `published_at`
- `draft`
- `prerelease`

`/releases/latest` 排除草稿和预发布；仍 MUST 检查返回字段。将 `tag_name` 原样作为 `release_tag`，NEVER 自行规范化、递增或猜测版本号。

可用 GitHub CLI 时，等价命令：

```bash
release_tag="$(gh api repos/can1357/oh-my-pi/releases/latest --jq '.tag_name')"
gh api "repos/can1357/oh-my-pi/releases/tags/$release_tag" \
  --jq '{tag_name,html_url,published_at,draft,prerelease}'
```

继续前 MUST 确认：

```text
tag_name == release_tag
draft == false
prerelease == false
published_at != null
html_url 包含 /can1357/oh-my-pi/releases/tag/
```

API 不可达、限流、字段缺失或返回预发布 → STOP。NEVER 降级为 `git tag --sort`、`git describe` 或 `git ls-remote` 猜最新版本。

### 3. 获取 Release 对应 tag

仅获取选定 tag；不要把 `upstream/main` 当作合并目标：

```bash
git fetch upstream "refs/tags/$release_tag:refs/tags/$release_tag"
```

若本地同名 tag 已存在且 fetch 拒绝更新，NEVER force 覆盖。分别检查本地和远端后报告 tag 不一致风险。

验证 tag 存在并解析到 commit：

```bash
git show-ref --verify --quiet "refs/tags/$release_tag"
release_commit="$(git rev-parse "$release_tag^{commit}")"
git show --no-patch --format='%H%n%cd%n%s' "$release_tag^{commit}"
```

`git ls-remote` 只用于确认该已选 Release tag 确实存在于上游；NEVER 用它选择“最新”版本：

```bash
git ls-remote --exit-code --tags upstream "refs/tags/$release_tag" "refs/tags/$release_tag^{}"
```

### 4. 判断是否已经合入

```bash
if git merge-base --is-ancestor "$release_tag" HEAD; then
  echo "Release $release_tag is already contained in HEAD"
fi
```

已是祖先 → 不创建空余 merge commit；转到验证并报告“已包含”。

可选查看合并范围：

```bash
git log --oneline --decorate "HEAD..$release_tag"
git diff --stat "HEAD...$release_tag"
```

这些命令用于风险检查，不改变版本来源。

### 5. 合并 Release tag

工作区干净且 tag 尚未合入时执行：

```bash
git merge --no-ff --no-edit "$release_tag"
```

预期产生明确的 tag 合并提交，例如：

```text
Merge tag 'vX.Y.Z'
```

NEVER 使用 `git merge upstream/main`、`git pull upstream main`、rebase、squash 或 cherry-pick 代替 tag 合并。

### 6. 冲突处理

出现冲突时：

```bash
git status --short
git diff --name-only --diff-filter=U
```

处理原则：

1. MUST 逐文件理解双方意图；NEVER 批量选 `--ours` 或 `--theirs`。
2. MUST 保留 fork 的有意差异，同时接入 Release 的接口、迁移和调用方变化。
3. 修改导出符号前 MUST 查全部 references；迁移所有调用方，避免兼容残片。
4. lockfile 冲突 SHOULD 先合并清单文件，再使用仓库包管理器重新生成；NEVER 手工拼 lockfile。
5. 解决后执行 `git add <resolved-files>`，确认无 `U` 状态，再执行：

```bash
git commit --no-edit
```

无法可靠解决 → 保持冲突现场并报告；若用户要求回退，执行：

```bash
git merge --abort
```

NEVER 使用 `git reset --hard` 清理冲突。

### 7. 验证历史与状态

验证 Release 和原 fork 分支均被保留：

```bash
git merge-base --is-ancestor "$release_tag" HEAD
git merge-base --is-ancestor "$pre_merge_head" HEAD
git status --short --branch
git log -1 --format='%H%n%P%n%s'
```

两个 `merge-base` 命令都 MUST 返回 0。新建 merge 时，合并提交应有两个父提交；已提前包含 Release 时可只有一个父提交。

检查 tag 指向并记录证据：

```bash
git rev-parse "$release_tag^{commit}"
git describe --tags --always HEAD
```

### 8. 验证代码

Release 合并会改变 TypeScript 时，MUST 执行仓库要求的快速检查：

```bash
bun run fastcheck
```

`bun` 不在 `PATH` 时先定位本机安装；例如本仓库工作站常见路径：

```bash
/root/.bun/bin/bun run fastcheck
```

额外验证按实际合并内容决定：

- 有手工冲突解决 → MUST 运行覆盖每个冲突区域的聚焦测试。
- package/类型边界变化 → SHOULD 运行 `bun check`。
- worker、CLI 启动或打包路径变化 → MUST 运行 `omp --smoke-test` 或对应安装 smoke。
- Rust 冲突或本地 Rust 修改 → MUST 使用 `bun run test:rs`，NEVER 直接 `cargo test`。
- 仅无冲突地合入上游已发布提交 → `fastcheck` + 历史/状态验证为最低要求。

任何检查失败都 MUST 原样报告命令、退出码和关键错误；NEVER 用“上游已经测试过”替代本地验证。

### 9. 恢复明确授权的 stash

仅当第 1 步经用户授权创建过 stash 时：

```bash
git stash pop
git status --short --branch
```

恢复后冲突 MUST 解决或明确报告。确认恢复成功前 NEVER drop stash。

### 10. 最终报告

报告以下事实：

```text
Release: <tag_name>
Release URL: <html_url>
Published: <published_at>
Release commit: <release_commit>
Merge commit: <merge_commit；已包含时写 already contained>
Branch: <branch>
Tracking branch: <origin/<branch>、none 或检测到的错误关系>
Verification: <实际运行命令及结果>
Working tree: <clean 或保留的用户改动>
Push: not performed / 明确授权后的实际结果
```

版本只有 tag、但无对应 GitHub Release 时，结论必须是“不可合入：不是发布页面版本”，并给出该 tag 与当前最新正式 Release 的差异。

<critical>
- Release API 选版本；Git tag 仅承载已选 Release。
- NEVER 同步 `upstream/main`，即使其版本号更高。
- 目标本地分支 SHOULD 跟踪 fork 的 `origin/<branch>`；NEVER 为 Release 同步创建跟踪 `upstream/main` 的本地分支。
- 工作区不干净、Release 证据不足、冲突未解、验证失败 → NEVER 报告完成。
- MUST 验证 Release tag 与合并前分支头均可达。
- NEVER push，除非用户明确授权。
</critical>
