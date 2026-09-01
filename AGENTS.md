# Fork Repository

本仓库是 [`can1357/oh-my-pi`](https://github.com/can1357/oh-my-pi) 的 fork。

- MUST 仅同步上游 `/releases/latest` 返回的最新正式 GitHub Release 及该 Release 原始 tag 精确指向的 commit；NEVER 查询 Release/tag 列表或用其他对象猜版本。
- 每日同步 MUST 先执行 `.omp/skills/upstream-release-sync/SKILL.md` 第 0 节快速门禁；tag 与 Release commit 都未变化时立即结束，只检查/修复 `origin/upstream`。
- 唯一允许访问的远程分支是 `origin/upstream`。NEVER 查询、比较、拉取、合并或重置 `origin/main`、`upstream/main` 或任何其他远程分支。
- 新 Release 固定合入本 fork 已存在的本地 `main`；MUST 禁用分支名猜测，NEVER 隐式创建 `main`，NEVER 自动 push `main` 或 tag。
- 浅仓库不构成日常门禁阻塞：无新 Release 时不补历史；新 Release 缺少 merge base 时，只允许对当前 Release tag 和当前本地 `main` 的精确 HEAD SHA 做一次定向 deepen，NEVER unshallow。
- 同一 Release tag 指向的 commit 与 `fork.md` 记录不一致时 MUST 视为 retag 异常并停止，NEVER 自动移动同名 tag、merge 或改写镜像。
- 发生 merge conflict 时 MUST 主动尝试自动解决；只有无法可靠判断正确结果时才安全 abort，不得留下半完成 merge。
- 本地 `upstream` 与 `origin/upstream` 是专用 Release 镜像，MUST 精确指向最新正式 Release commit，不承载 fork 改动或开发提交。
- `AGENTS.md`、`.omp/skills/upstream-release-sync/SKILL.md`、`docs-zh-CN/fork.md` 是 fork 治理文件；同步时 MUST 保留同步前 fork 版本，随后仅按 skill 更新 `fork.md`。
- 修改本 fork 前，MUST 先阅读当前差异快照：[`docs-zh-CN/fork.md`](docs-zh-CN/fork.md)。
- 合入上游正式 Release，或新增、修改、移除任何 fork 改动后，MUST 在同一变更中更新该快照；“上游同步记录”仅保留当前 Release，不作历史账本；每项描述 MUST 不超过 2 个 Markdown 源码行。不添加兼容别名或第二份清单。

# Development Rules

## Local Verification

After modifying local TypeScript code, you MUST run `bun run fastcheck` before yielding.

上游 Release 同步是唯一例外，MUST 按 `.omp/skills/upstream-release-sync/SKILL.md`：

- 无新 Release → 不切换 `main`、不补历史、不运行代码检查或测试。
- 新 Release 使用 `git merge --no-ff --no-commit`；无冲突只执行 staged Git 检查，不运行 Bun 或测试。
- 发生冲突时，只读取根和冲突 workspace 的脚本，只运行一次 `fastcheck`、冲突 workspace 中确认安全的 `check:types` 以及最多 3 个直接精确测试；全部顺序执行。
- NEVER 遍历或检查全部 workspace，NEVER 运行根级 `bun run check`、完整测试套件、UI/browser/heavy、Docker、benchmark、打包或发布流程。
- NEVER 在上游同步期间运行 Rust/native build、check、test、lint、fmt、clippy、codegen 或 packaging；NEVER 运行 `cargo`、`bazel`、`nix build` 或间接触发这些工作的脚本。
- TS/JS 对 native 包装层的纯静态 `check:types` MAY 运行，但 MUST 先确认不调用 Rust/native 工具链。

其他规则：

- NEVER 在本地开发中编译 Rust 代码。
- 仅测试交互式 UI 时，MUST 使用 `bun run omp2`；该命令从 `$HOME/.omp/natives/<version>` 加载原生包并运行仓库 TypeScript 源码，NEVER 本地编译原生代码。

## Change Discipline

- 不要为了测试而测试：仅为守护真实、可观察的契约添加测试，NEVER 为凑数、覆盖率或惯例添加测试。
- 本仓库长期与上游保持同步：自身修改 MUST 内聚、克制 —— 最小必要变更，改动集中，不引入无关重构、抽象或范围扩展。
