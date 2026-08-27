# github

> 调度 GitHub CLI 操作,涵盖仓库、仓库文件、Pull Request、搜索以及 Actions 运行监听。

## 源码
- 入口:`packages/coding-agent/src/tools/gh.ts`
- 面向模型的提示词:`packages/coding-agent/src/prompts/tools/github.md`
- 关键协作模块:
  - `packages/coding-agent/src/tools/gh-format.ts` — 为摘要缩短 commit SHA。
  - `packages/coding-agent/src/tools/gh-renderer.ts` — TUI 渲染,尤其是 `run_watch` 的实时/结果视图。
  - `packages/coding-agent/src/utils/git.ts` — `gh`/`git` 进程包装、仓库锁、分支配置写入。
  - `packages/utils/src/dirs.ts` — 专用 PR 工作树的基础目录。
  - `packages/coding-agent/src/sdk.ts` — 会话产物分配钩子。
  - `packages/coding-agent/src/session/artifacts.ts` — 产物文件名格式 `<id>.<toolType>.log`。

## 可用性与审批

- `github.enabled` 默认为 `false`;使用前请在 **Settings → Tools** 中启用 GitHub CLI 工具。
- 该工具可被发现且采用严格 schema,仅在 `PATH` 上存在 `gh` 时才会创建。认证状态在操作执行时由 CLI 检查。
- `repo_view`、`file_read`、所有 `search_*` 操作以及 `run_watch` 请求读取审批。`pr_create`、`pr_checkout` 和 `pr_push` 请求执行审批。

## 输入

| 字段 | 类型 | 必填 | 描述 |
| --- | --- | --- | --- |
| `op` | `"repo_view" \| "file_read" \| "pr_create" \| "pr_checkout" \| "pr_push" \| "search_issues" \| "search_prs" \| "search_code" \| "search_commits" \| "search_repos" \| "run_watch"` | 是 | 调度选择器。`GithubTool.execute()` 仅根据此字段进行分支切换。 |
| `repo` | `string` | 否 | `[host/]owner/repo` 覆盖项。只有当主机前缀与 `gh` 默认的主机(github.com,或在设置 `GH_HOST` 时使用该值)匹配时,前缀才可省略;位于其他主机的仓库——包括 `GH_HOST` 指向企业实例时的 github.com——必须显式带上主机限定,否则 `gh` 会把请求发到其默认主机。当标识符参数本身已是完整的 GitHub URL 时,该字段被忽略。对于 `search_issues`/`search_prs`/`search_code`/`search_commits`,省略时默认为当前 checkout 所在仓库(当查询已包含 `repo:`/`org:`/`user:`/`owner:` 限定符,或当前仓库解析失败时跳过此默认)。当 `gh` 无法从当前 checkout 推断仓库上下文时,实际上需要显式提供。 |
| `branch` | `string` | 否 | 由 `repo_view`、`file_read`、`pr_push` 和 `run_watch` 使用。`file_read` 省略该 ref 时使用仓库的默认分支;`run_watch` 在省略 `run` 时回退到当前 git 分支;`pr_push` 回退到当前分支。 |
| `path` | `string` | 否 | `file_read` 必填。GitHub 仓库中文件的相对路径;不允许以 `/` 开头。 |
| `pr` | `string \| string[]` | 否 | 由 `pr_checkout` 使用。每项可以是 PR 编号、分支名或 GitHub PR URL。数组形式支持批量处理。省略时表示当前分支对应的 PR。 |
| `force` | `boolean` | 否 | 仅供 `pr_checkout` 使用。默认为 `false`;允许将已存在的 `pr-<number>` 本地分支重置为 PR head commit。 |
| `forceWithLease` | `boolean` | 否 | 仅供 `pr_push` 使用;透传给 git push。 |
| `title` | `string` | 否 | 仅供 `pr_create` 使用。除非 `fill` 为 `true`,否则为必填。 |
| `body` | `string` | 否 | 仅供 `pr_create` 使用。与 `fill` 互斥。为空或省略时变为 `--body ""` 以抑制交互式编辑器。非空 body 会写入临时文件并通过 `--body-file` 传递。 |
| `base` | `string` | 否 | 仅供 `pr_create` 使用;作为 `--base` 传递。 |
| `head` | `string` | 否 | 仅供 `pr_create` 使用;作为 `--head` 传递。 |
| `draft` | `boolean` | 否 | 仅供 `pr_create` 使用。默认为 `false`。 |
| `fill` | `boolean` | 否 | 仅供 `pr_create` 使用。默认为 `false`。与 `title` 和 `body` 互斥。 |
| `reviewer` | `string[]` | 否 | 仅供 `pr_create` 使用;每个条目作为 `--reviewer`。 |
| `assignee` | `string[]` | 否 | 仅供 `pr_create` 使用;每个条目作为 `--assignee`。 |
| `label` | `string[]` | 否 | 仅供 `pr_create` 使用;每个条目作为 `--label`。 |
| `query` | `string` | 否 | 所有 `search_*` 操作都会使用。仅 `search_code` 的本地校验要求为必填;其他搜索操作会将其与可选的日期/仓库/类型限定符组合后发送给 GitHub。 |
| `since` | `string` | 否 | `search_issues`、`search_prs`、`search_commits` 和 `search_repos` 的下界日期。接受相对时长(`3d`、`12h`、`2w`、`2mo`、`1y`)、`YYYY-MM-DD` 或 ISO 时间。`search_code` 不接受此参数。 |
| `until` | `string` | 否 | `search_issues`、`search_prs`、`search_commits` 和 `search_repos` 的上界日期。格式与 `since` 相同。`search_code` 不接受此参数。 |
| `dateField` | `"created" \| "updated"` | 否 | issue/PR/repo 搜索的日期限定符字段。默认为 `created`;仓库搜索将 `updated` 映射为 GitHub 的 `pushed:` 限定符。提交搜索忽略此字段,始终使用 `committer-date:`。 |
| `limit` | `number` | 否 | 所有 `search_*` 操作都会使用。默认为 `10`,向下取整,上限为 `50`,且必须 `> 0`。 |
| `run` | `string` | 否 | 仅供 `run_watch` 使用。必须是数字型 run ID 或完整的 GitHub Actions run URL。 |
| `tail` | `number` | 否 | 仅供 `run_watch` 使用。默认为 `15`,向下取整,上限为 `200`,且必须 `> 0`。 |

## 输出
该工具返回由 `packages/coding-agent/src/tools/gh.ts` 中 `buildTextResult()` 构建的单一文本结果。

- `content`:一个文本块。多项操作的结果以空行和 `---` 分隔符连接各部分。
- `sourceUrl`:在已知规范 URL 时,为仓库/文件/PR/运行结果设置。
- `details`:TUI 渲染器使用的可选结构化元数据。
  - 通用字段:`artifactId`、`repo`、`branch`、`worktreePath`、`remote`、`remoteBranch`、`headSha`、`runId`、`runIds`、`status`、`conclusion`、`failedJobs`。
  - `pr_checkout` 增加 `checkouts: GhPrCheckoutSummary[]`。
  - `run_watch` 增加 `watch: GhRunWatchViewDetails`,驱动 `packages/coding-agent/src/tools/gh-renderer.ts` 中的自定义实时/结果渲染器。
- 产物尾部:当 `artifactId` 存在时,文本正文末尾会追加一行类似 `Full failed-job logs: artifact://<id>`。
  - `run_watch` 通过 `session.allocateOutputArtifact("github")` 分配产物;因此持久化会话会将失败日志正文保存为 `<artifact-dir>/<id>.github.log`。

`run_watch` 是唯一支持流式输出的操作。它在轮询期间发出 `onUpdate` 快照,然后返回一条最终文本结果。

## 流程
1. `GithubTool.createIf()` 仅在 `git.github.available()` 在 `PATH` 上找到 `gh` 时才暴露该工具。
2. `GithubTool.execute()` 将调度包装在 `untilAborted()` 中,并根据 `params.op` 进行分支切换。
3. 每个操作在 `packages/coding-agent/src/tools/gh.ts` 中对可选字符串、数组、布尔值和数值上限进行本地规范化。
4. CLI 执行通过 `packages/coding-agent/src/utils/git.ts` 中的 `git.github.run/json/text()`:
   - 使用 `Bun.spawn()` 启动 `gh ...`;
   - 除非 `trimOutput: false`,否则裁剪 stdout/stderr;
   - 将常见的认证/仓库上下文错误映射为面向工具的 `ToolError` 消息;
   - `json()` 拒绝空或无效的 JSON。
   - 当前 checkout 解析运行 `gh repo view --json url -q .url` 并保留主机部分:在 github.com 上结果为 `owner/repo`,在其他主机上为 `host/owner/repo`。`gh` 会将无主机的 `--repo` 解析为 `GH_HOST`(默认为 github.com),因此该前缀正是防止企业 checkout 被错误路由到 github.com 的关键。`gh api` 的端点路径从不携带主机,因此仓库范围的 API 调用会去掉该前缀,改用 `--hostname`;GitHub 搜索限定符同样处理(`repo:owner/repo` 加上 `--hostname`)。
   - 由完整 URL 提供的主机(来自 `pr://<host>/…` 读取、PR/issue/run URL 参数)会按原样保留,包括 `github.com`,因此 `GH_HOST` 无法重定向该请求。缓存行会丢弃与 `gh` 默认主机同名的主机前缀——通常 `github.com/owner/repo` 和 `owner/repo` 共享同一行,而在 `GH_HOST` 下,显式的 `github.com/` 形式会保留各自的行,因为此时裸形式指的是所配置的实例。
5. 读取型操作(`repo_view`、`file_read`、`search_*`)获取仓库数据并返回文本或格式化的类 Markdown 摘要。`file_read` 使用带 raw-media accept 头的 GitHub contents API,并将响应字节保留为文本。单 issue 和单 PR 视图已从该工具中移出,现通过 `issue://` / `pr://` 内部 URL 方案解析,这些方案共享同一个 SQLite 缓存。
6. PR diff 已从该工具中移出。`pr://<N>/diff` 列出变更文件,`pr://<N>/diff/<i>` 切片单个文件,`pr://<N>/diff/all` 返回完整 unified diff——参见 `docs/tools/read.md`。这三种变体通过 `pr-diff` 缓存行共享同一次 `gh pr diff` 调用。
7. `pr_checkout` 首先解析 PR 元数据,然后在执行任何 git 修改前进入 `git.withRepoLock()`,以避免对同一主仓库的并行 checkout 调用在共享的 `.git` 状态上产生竞争。
8. `pr_push` 从 git 分支配置中读取 PR head 元数据,推导 refspec,使用 `git.push()` 推送,然后通过 `invalidateAllForNumber()` 使所推送 PR 的 `pr://` 缓存行失效,以便下一次 `pr://` 读取反映该推送。
9. `pr_create` 仅 shell 一次,然后尽力重新读取已创建的 PR 以获取更丰富的摘要。
10. `run_watch` 选择 run 模式(提供 `run`)或 commit 模式(省略 `run`),在第一分钟内每 3 秒轮询一次 GitHub Actions API,之后每 15 秒一次,发出流式更新,并可能在返回前保存完整的失败日志产物。
11. 最终文本通过 `toolResult().text(...)` 输出;如果 `session.allocateOutputArtifact()` 返回了槽位,则失败日志文本会通过 `Bun.write()` 持久化。

## 模式 / 变体

### `repo_view`

| 方面 | 值 |
| --- | --- |
| 必填字段 | `op` |
| 可选字段 | `repo`、`branch` |
| `gh` 命令 | `gh repo view [<repo>] [--branch <branch>] --json <GH_REPO_FIELDS>` |
| 批处理 | 无 |
| 输出 | `# <owner/repo>` 头部、描述、URL、默认分支、请求的分支、可见性、权限、主要语言、star、fork、archive/fork 标志、更新时间戳、主页、topics。`sourceUrl = data.url`。 |

如果省略 `repo`,则使用 `gh` 的仓库解析。

### `file_read`

| 方面 | 值 |
| --- | --- |
| 必填字段 | `op`、`path` |
| 可选字段 | `repo`、`branch` |
| `gh` 命令 | `gh api /repos/<repo>/contents/<encoded-path> --method GET -H "Accept: application/vnd.github.raw+json" [-f ref=<branch>]` |
| 批处理 | 无 |
| 输出 | 与 contents API 返回的文件内容完全一致(`trimOutput: false`)。`sourceUrl` 指向 `https://github.com/<repo>/blob/<branch-or-HEAD>/<encoded-path>`;`details` 包含已解析的 `repo` 和可选的 `branch`。 |

`repo` 默认为当前 checkout 的 GitHub 仓库。省略 `branch` 时请求 GitHub 返回仓库的默认分支。每个路径段都会独立进行 URL 编码。该操作拒绝空路径或以 `/` 开头的路径;缺失文件、目录和无效 ref 由 GitHub 通过常规 CLI 错误映射上报。面向模型的提示词要求,对于托管在 GitHub 仓库中的文件,应使用本操作而非 `curl` 或 `wget`。

单 issue 和单 PR 读取位于 `issue://<N>` / `pr://<N>` URL 方案中(参见 `docs/tools/read.md`)。它们共享 `~/.omp/cache/github-cache.db`(可通过 `OMP_GITHUB_CACHE_DB` 覆盖)以及 `github.cache.softTtlSec` / `github.cache.hardTtlSec` / `github.cache.enabled` 设置。缓存同时保留渲染后的 Markdown 和 `gh` 返回的原始 JSON payload,包括私有正文、评论、reviews 以及启用评论时的 review comments;各行按本地 GitHub 凭据指纹作用域。根级和仓库范围的读取(`issue://`、`pr://owner/repo`)会发起一次实时的 `gh issue list` / `gh pr list` 用于浏览;查询参数 `state`、`limit`、`author`、`label` 透传给 `gh`(`issue://` 接受 `state=open|closed|all`;`pr://` 还接受 …

### `pr_create`

| 方面 | 值 |
| --- | --- |
| 必填字段 | `op` 加上 `fill=true` 或 `title` |
| 可选字段 | `repo`、`title`、`body`、`base`、`head`、`draft`、`fill`、`reviewer[]`、`assignee[]`、`label[]` |
| `gh` 命令 | 由所提供字段组装 flag 的 `gh pr create ...` |
| 批处理 | 无 |
| 输出 | `# Created Pull Request ...` 摘要,包括 URL、状态、draft 标志、base/head、作者、创建时间、labels、可选 body。`sourceUrl` 为已创建 PR 的 URL。 |

分支条件:
- `fill && (title || body !== undefined)` 抛出异常。
- 非空 `body` 写入 `os.tmpdir()` 中名为 `gh-pr-body-*` 的临时目录,作为 `--body-file` 传递,然后在 `finally` 中删除。
- 创建后,工具解析返回的 URL,并尽力执行 `gh pr view <number> --repo <repo> --json <GH_PR_FIELDS_NO_COMMENTS>`;该步骤的失败会被吞掉。

### `pr_checkout`

| 方面 | 值 |
| --- | --- |
| 必填字段 | `op` |
| 可选字段 | `repo`、`pr`、`force` |
| `gh` 命令 | 对每个请求的 PR:`gh pr view [<pr>] [--repo <repo>] --json <GH_PR_CHECKOUT_FIELDS>`;跨仓库 PR 还可能调用 `gh repo view <headRepository> --json <GH_REPO_CLONE_FIELDS>`。 |
| 批处理 | 是。`pr` 可为 `string[]`;每个 PR 并行解析,但 git 修改由 `git.withRepoLock()` 按主仓库串行化。 |
| 输出 | 单个 PR:checkout/worktree 摘要加上 `details.repo`、`details.branch`、`details.worktreePath`、`details.remote`、`details.remoteBranch`、`details.checkouts`。批量:`# <n> Pull Request Worktrees (...)` 加每个 PR 一个部分,以及聚合的 `details.checkouts`。部分失败时,头部变为 `# <n>/<total> Pull Request Worktrees checked out (<k> failed)`,并在末尾附加 `## Failed` 列表。 |

Worktree 与元数据行为:
- 本地分支名始终为 `pr-<number>`。
- worktree 路径为 `getWorktreeDir("<number>-<repo-hash>")` = `path.join(getWorktreesDir(), "<number>-<repo-hash>")`,其中 `<number>` 是 PR 编号,`<repo-hash>` 是 `hashPath(primaryRepoRoot)`(主仓库根路径的 7 位十六进制摘要)。`getWorktreesDir()` 按以下顺序解析基目录:有效的 `OMP_WORKTREE_DIR`、已应用的 `worktree.base` 设置,再是基于 profile/XDG 的数据根默认(通常为 `~/.omp/wt`)。两种覆盖方式都会展开前导的 `~`,且必须解析为绝对路径;无效的相对值会被忽略,解析回退到下一级。当解析出的路径已被 git 注册或已存在于磁盘上时,`resolveAvailableWorktreePath()` 会追加 `-2`/`-3`… 后缀。
- 已存在 worktree 的检测通过 `git.worktree.list()` 获取分支 ref `refs/heads/pr-<number>`。
- 新建 worktree 在验证路径既未被注册也不存在于磁盘上后,调用 `git.worktree.add(repoRoot, finalWorktreePath, localBranch, { signal })`。
- 对于同仓库 PR,remote 为 `origin`。对于跨仓库 PR,工具解析 head 仓库的 clone URL,尽可能复用具有相同 URL 的现有 remote,或创建 `fork-<owner>` / `fork-<owner>-<n>`。
- 分支推送元数据通过 `git config` 持久化到仓库共享的 `.git/config` 中:
  - `branch.pr-<number>.remote`
  - `branch.pr-<number>.merge`
  - `branch.pr-<number>.pushRemote`
  - `branch.pr-<number>.ompPrHeadRef`
  - `branch.pr-<number>.ompPrUrl`
  - `branch.pr-<number>.ompPrIsCrossRepository`
  - `branch.pr-<number>.ompPrMaintainerCanModify`
- 如果 `refs/heads/pr-<number>` 已存在但指向不同的 commit,checkout 会失败,除非 `force=true`,此时 `git branch --force` 将其重置为已 fetch 的 PR head。
- 如果匹配的 worktree 已存在,工具会复用它并报告 `reused: true`。

### `pr_push`

| 方面 | 值 |
| --- | --- |
| 必填字段 | `op` |
| 可选字段 | `branch`、`forceWithLease` |
| `gh` 命令 | 无。该路径使用 git,而不是 `gh`。 |
| 批处理 | 无 |
| 输出 | `# Pushed Pull Request Branch` 摘要,包括本地分支、remote、remote 分支、remote URL、PR URL 和 force-with-lease 标志。在已知时 `sourceUrl = prUrl`。 |

推送目标解析读取由 `pr_checkout` 写入的 `branch.<name>.ompPrHeadRef`、`pushRemote`/`remote`、`ompPrUrl`、`ompPrMaintainerCanModify` 和 `ompPrIsCrossRepository` git config 项。如果当前 checkout 的分支与目标分支匹配,源 ref 为 `HEAD`;否则推送 `refs/heads/<branch>`。refspec 为 `HEAD:refs/heads/<headRef>` 或 `refs/heads/<branch>:refs/heads/<headRef>`。

### `search_issues`

| 方面 | 值 |
| --- | --- |
| 必填字段 | `op` |
| 可选字段 | `repo`、`query`、`limit`、`since`、`until`、`dateField` |
| `gh` 命令 | `gh api -X GET /search/issues -f q="<query> [date qualifier] [repo:<repo>] is:issue" -F per_page=<limit>` |
| 批处理 | 无 |
| 输出 | `# GitHub issues search`,回显 query、可选 repo、结果数量,然后每条 issue 一行,包含 repo/state/作者/labels/时间戳/URL。 |

`repo` 在省略时通过 `resolveSearchRepoScope()` 默认为当前 checkout 的 `owner/repo`。当组合后的 query 已包含前导的 `repo:`/`org:`/`user:`/`owner:` 限定符,或 `gh repo view` 无法解析当前 checkout(例如不在 github remote 内)时,此默认会被抑制。

### `search_prs`

| 方面 | 值 |
| --- | --- |
| 必填字段 | `op` |
| 可选字段 | `repo`、`query`、`limit`、`since`、`until`、`dateField` |
| `gh` 命令 | `gh api -X GET /search/issues -f q="<query> [date qualifier] [repo:<repo>] is:pr" -F per_page=<limit>` |
| 批处理 | 无 |
| 输出 | 形状与 `search_issues` 相同,标记为 pull requests。 |

`repo` 在省略时默认为当前 checkout 的 `owner/repo`,与 `search_issues` 相同。

### `search_code`

| 方面 | 值 |
| --- | --- |
| 必填字段 | `op`、`query` |
| 可选字段 | `repo`、`limit` |
| `gh` 命令 | `gh api -X GET /search/code -f q="<query> [repo:<repo>]" -F per_page=<limit> -H "Accept: application/vnd.github.text-match+json"` |
| 批处理 | 无 |
| 输出 | `# GitHub code search`,结果数量,然后每条匹配一项,包含 path、repo、缩短的 commit SHA、URL,以及存在时的第一个规范化 text-match 片段行。 |

`repo` 在省略时默认为当前 checkout 的 `owner/repo`,与 `search_issues` 相同。由于 GitHub 代码搜索不支持日期限定符,该操作显式拒绝 `since` 和 `until`。

### `search_commits`

| 方面 | 值 |
| --- | --- |
| 必填字段 | `op` |
| 可选字段 | `repo`、`query`、`limit`、`since`、`until`、`dateField`(接受但忽略;提交搜索使用 `committer-date`) |
| `gh` 命令 | `gh api -X GET /search/commits -f q="<query> [committer-date qualifier] [repo:<repo>]" -F per_page=<limit>` |
| 批处理 | 无 |
| 输出 | `# GitHub commits search`,结果数量,然后每条 commit 一项:缩短的 SHA + 第一行 commit message、repo、作者、日期、URL。 |

`repo` 在省略时默认为当前 checkout 的 `owner/repo`,与 `search_issues` 相同。

### `search_repos`

| 方面 | 值 |
| --- | --- |
| 必填字段 | `op` |
| 可选字段 | `query`、`limit`、`since`、`until`、`dateField` |
| `gh` 命令 | `gh api -X GET /search/repositories -f q="<query> [date qualifier]" -F per_page=<limit>` |
| 批处理 | 无 |
| 输出 | `# GitHub repositories search`,结果数量,然后每个 repo 一项,包含第一行描述、语言、stars、forks、open issues、可见性、archive/fork 标志、更新时间、URL。 |

该操作有意不使用 `repo`。如果 `query`、`since` 和 `until` 同时省略,工具会发送空的 GitHub 仓库搜索 query,GitHub API 可能会拒绝该请求。

### `run_watch`

| 方面 | 值 |
| --- | --- |
| 必填字段 | `op` |
| 可选字段 | `repo`、`branch`、`run`、`tail` |
| `gh` 命令 | 仓库解析:当 `repo` 与 run URL 的 repo 均缺省时,执行 `gh repo view --json url -q .url`。单 run 模式使用 `gh api --method GET /repos/<repo>/actions/runs/<runId>` 和 `gh api --method GET /repos/<repo>/actions/runs/<runId>/jobs`。Commit 模式使用 `gh api --method GET /repos/<repo>/branches/<branch>`、`gh api --method GET /repos/<repo>/actions/runs`、`gh api --method GET /repos/<repo>/actions/runs/<runId>/jobs`,以及 `gh api /repos/<repo>/actions/jobs/<jobId>/logs` 获取失败 job 的日志。 |
| 批处理 | 仅 commit 模式隐式批处理:同一 commit 的所有 workflow run 会被一起跟踪。 |
| 输出 | 通过 `onUpdate` 发出流式 watch 快照,然后返回最终文本报告。失败时附加 `Full failed-job logs: artifact://<id>` 并设置 `details.artifactId`。 |

Watch 流程:
- `run` 解析接受十进制 run ID 或完整 run URL。URL 中的 repo 必须在与显式 `repo` 同时给出时匹配。
- 轮询间隔在 watch 的最初 `60` 秒(`RUN_WATCH_FAST_WINDOW_MS`)内为 `3` 秒(`RUN_WATCH_INTERVAL_DEFAULT`),之后为 `15` 秒(`RUN_WATCH_INTERVAL_SLOW`)。被限流的轮询错误以慢间隔退避,最多连续重试 `5` 次失败(`RUN_WATCH_MAX_POLL_FAILURES`)。Commit 模式下,如果始终没有 run 出现,会在 `90` 秒后以明确消息放弃(`RUN_WATCH_NO_RUNS_GIVE_UP_MS`)。
- 失败宽限期固定为 5 秒(`RUN_WATCH_GRACE_DEFAULT`)。当任何失败 job 在完成前出现,工具会发出提示,等待一次,重新拉取状态,然后收集日志,以便包含并发的失败。
- 失败 job 的日志通过 `gh api /repos/<repo>/actions/jobs/<jobId>/logs` 经由 `git.github.run()` 获取,而不是 `json()`。非零退出码会留下 `available: false`,而不是让整个 watch 失败。
- 内联结果仅包含每个失败 job 的最后 `tail` 行。已保存的产物包含完整日志(`mode: "full"`)。
- 在 commit 模式下,成功会被刻意双重确认:一旦所有已知 run 成功,工具会再等待一个轮询间隔,只有当 run ID 集合保持不变时才标记成功。这避免了同一 commit 的后发 workflow run 出现之前就提前返回。
- `details.watch` 驱动 `packages/coding-agent/src/tools/gh-renderer.ts` 中的专用渲染器;非 watch 结果回退到通用文本渲染。

## 副作用
- 文件系统
  - `pr_create` 可能在 `os.tmpdir()` 下创建名为 `gh-pr-body-*` 的临时目录,写入 `body.md`,然后在 `finally` 中删除该目录。
  - `pr_checkout` 可能创建 worktree 目录,命名为 `<pr-number>-<repo-hash>`,位于由 `OMP_WORKTREE_DIR`、然后 `worktree.base`、再后是基于 profile/XDG 的默认(通常为 `~/.omp/wt`)所选定的基目录下,并在其中添加 git worktree。
  - `run_watch` 可能写入包含失败 job 完整日志的会话产物。
- 网络
  - 除 `pr_push` 外的每个操作都会 shell 出去调用 `gh`,由其与 GitHub API 通信。
  - `pr_push` 使用 git 网络传输与所配置的 remote 通信。
- 子进程 / 原生绑定
  - 所有 `gh` 调用都使用 `Bun.spawn(["gh", ...args])`。
  - `pr_checkout` 和 `pr_push` 还会调用 `packages/coding-agent/src/utils/git.ts` 中的 git 辅助函数。
- 会话状态(会话记录、记忆、jobs、checkpoints、注册表)
  - `run_watch` 在持久化失败 job 日志时会占用 `session.allocateOutputArtifact()`。
  - 返回的 `details` 对象携带 run/checkouts 元数据,供渲染器/UI 使用。
- 用户可见的提示 / 交互式 UI
  - 通过强制使用 `--body-file` 或 `--body ""` 来抑制 `pr_create` 的 `gh` 交互式编辑器回退。
  - `gh-renderer` 为所有操作提供紧凑的 header,并为 `run_watch` 提供自定义的实时 watch 视图。
- 后台工作 / 取消
  - `run_watch` 循环直到成功/失败,并在轮询之间使用 `scheduler.wait()`。
  - `GithubTool.execute()` 被包装在 `untilAborted()` 中;`git.github.run()` 将 abort signal 转发到 `Bun.spawn()`。

## 限制与上限
- 搜索结果默认值:`10`(`packages/coding-agent/src/tools/gh.ts` 中的 `SEARCH_LIMIT_DEFAULT`)。
- 搜索结果最大值:`50`(`SEARCH_LIMIT_MAX`)。
- `pr://` 视图中的 PR 文件预览:仅前 `50` 个文件(`gh.ts` 中的 `FILE_PREVIEW_LIMIT`)。对于达到 GitHub 20,000 行限制而拒绝的聚合 diff,`pr://<N>/diff` 获取器会回退到分页 files API(每页 `100` 个文件,最多 `3000` 个文件);二进制或单个体积过大的 patch 仍会列出,并带有 unavailable-patch 标记。
- Run-watch 轮询间隔:最初 `60s` 内为 `3s`,之后为 `15s`(`RUN_WATCH_INTERVAL_DEFAULT`、`RUN_WATCH_FAST_WINDOW_MS`、`RUN_WATCH_INTERVAL_SLOW`);无 run 的 commit 模式在 `90s` 后放弃(`RUN_WATCH_NO_RUNS_GIVE_UP_MS`);最多容忍连续 `5` 次被限流的轮询失败(`RUN_WATCH_MAX_POLL_FAILURES`)。
- Run-watch 失败宽限期:`5s`(`RUN_WATCH_GRACE_DEFAULT`)。
- Run-watch 失败日志尾部默认值:`15` 行(`RUN_WATCH_TAIL_DEFAULT`)。
- Run-watch 失败日志尾部最大值:`200` 行(`RUN_WATCH_TAIL_MAX`)。
- PR review comments 页面大小:`100`(`REVIEW_COMMENTS_PAGE_SIZE`)。
- Actions jobs 页面大小:`100`(`RUN_JOBS_PAGE_SIZE`)。
- 搜索和 tail 数值输入会通过 `Math.floor()` 向下取整,被限制到最大值,在非有限或 `<= 0` 时被拒绝。
- `pr_checkout` 批处理扇出在工具代码中无界;所有请求的 PR 通过 `Promise.allSettled()` 并发启动,使得单个失败以部分结果形式呈现,而不是中止整个批次。

## 错误
- 当 `gh` 未安装时,工具创建被完全跳过。
- 如果在执行时 `gh` 缺失,`git.github.run()` 抛出 `ToolError("GitHub CLI (gh) is not installed...")`。
- `git.github.text/json()` 将常见错误映射为面向模型的消息:
  - 未认证 → `GitHub CLI is not authenticated. Run \`gh auth login\`.`
  - 缺少显式 `repo` 的仓库上下文 → `GitHub repository context is unavailable. Pass \`repo\` explicitly or run the tool inside a GitHub checkout.`
  - 其他情况为 stderr/stdout 文本,或回退的 `GitHub CLI command failed: gh ...`
- `json()` 还在 stdout 为空或 JSON 无效时抛出异常。
- 本地校验错误抛出 `ToolError`,包括:
  - 缺少按操作要求的必填字段(`file_read` 缺少 `path`,`search_code` 缺少 `query`,缺少 `title` 除非 `fill=true`)
  - 无效的数值型 `limit` / `tail`
  - 无效的 `since` / `until` 日期边界
  - 无效的 `run` 格式
  - `fill` 与 `title` 或 `body` 同时使用
  - checkout、push 或 watch 缺少 git 仓库 / 分支 / HEAD 上下文
  - `pr_push` 在没有 `ompPrHeadRef` 元数据的分支上
  - 冲突的现有 worktree 路径或没有 `force` 的分支
  - `file_read` 的绝对路径(以 `/` 开头)
- `run_watch` 对失败 job 日志获取做特殊处理:缺失的日志内容不会导致 watch 失败;它将该日志标记为 `available: false` 并打印 `Log tail unavailable.` / `Full log unavailable.`。
- `pr_create` 仅吞掉创建后尽力而为的 `gh pr view` 刷新;创建步骤本身仍按正常方式失败。

## 备注
- 当标识符参数本身已是完整的 GitHub URL 时,`appendRepoFlag()` 有意跳过 `--repo`;这使得 `gh` 可以从 URL 派生 repo/编号。
- `normalizePrIdentifierList()` 也接受 `reviewer`、`assignee` 和 `label` 数组;该辅助函数的名称比其调用方所体现的更宽泛。
- `pr_push` 依赖于该本地分支先运行过 `pr_checkout`;没有其他元数据来源。
- `pr_checkout` 将推送元数据存储在分支配置中,而不是 worktree 目录中。复用同一个 `pr-<number>` 分支会复用这些配置项。
- Worktree 写入串行化以主仓库根路径为键,而不是以当前 worktree 路径为键,因为 git worktree 共享 `.git/config`、`packed-refs`、commit-graph 和 worktree 元数据文件。
- `search_repos` 是唯一从不转发 `repo` 的搜索操作;仓库作用域必须在 query 本身中表达。
- `run_watch` 在 commit 模式下的成功意味着"所有观察到的 run 都已成功,且一个轮询周期后没有出现新的 run",而不仅仅是"最近一次轮询看起来是绿色"。
- TUI 渲染器在结果视图未展开时会折叠失败日志预览;底层文本结果仍包含相同的尾部行以及任何产物引用。
