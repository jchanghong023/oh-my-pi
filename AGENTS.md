# Fork Repository

本仓库是 [`can1357/oh-my-pi`](https://github.com/can1357/oh-my-pi) 的 fork。

- MUST 仅同步上游最新正式 GitHub Release 对应的原始 tag；NEVER 直接同步上游 `main`。
- 上游 Release 固定合入本 fork 已存在的本地 `main`；MUST 禁用分支名猜测，NEVER 隐式创建 `main`。
- 发生 merge conflict 时 MUST 主动尝试自动解决；只有无法可靠判断正确结果时才安全 abort，不得留下半完成 merge。
- 同步上游时 MUST 完整执行 `.omp/skills/upstream-release-sync/SKILL.md`，不得抽取部分步骤或降低其中的验证要求。
- 本地 `upstream` 与 fork 的 `origin/upstream` 是专用 Release 镜像，MUST 精确指向上游最新正式 Release commit；该分支不承载 fork 改动或开发提交。
- 镜像只在本地 `main` 合入、验证和 fork 快照完成后更新；漂移时只允许按 skill 对 `origin/upstream` 使用带精确旧 SHA lease 的 `--force-with-lease`，NEVER 对其他分支 force-push。
- `AGENTS.md`、`.omp/skills/upstream-release-sync/SKILL.md`、`docs-zh-CN/fork.md` 是 fork 治理文件；同步时 MUST 无条件保留同步前 fork 版本，随后仅按 skill 更新 `fork.md`。
- 修改本 fork 前，MUST 先阅读当前差异快照：[`docs-zh-CN/fork.md`](docs-zh-CN/fork.md)。
- 合入上游正式 Release，或新增、修改、移除任何 fork 改动后，MUST 在同一变更中更新该快照；“上游同步记录”仅保留当前 Release，不作历史账本；每项描述 MUST 不超过 2 个 Markdown 源码行。不添加兼容别名或第二份清单。

# Development Rules

## Local Verification

After modifying local TypeScript code, you MUST run `bun run fastcheck` before yielding.

上游 Release 同步是唯一例外，MUST 按 `.omp/skills/upstream-release-sync/SKILL.md`：

- MUST 使用 `git merge --no-ff --no-commit`，在创建 merge commit 前完成检查；任一检查失败 MUST `git merge --abort` 并验证恢复到同步前状态。
- 所有会修改 ref、index、worktree、commit、tracking 或远端的 Git 命令 MUST 按 skill 禁用本地 hooks；存在配置型 hook command 时停止，防止 hook 暗中触发重型工作。
- 无论是否发生冲突，MUST 运行 staged Git 检查，并在脚本图审计后顺序执行 `bun run check:tools` 与 `bun run --sequential --workspaces --if-present check`。
- 发生冲突时额外运行经审计的 `bun run fastcheck`，并仅逐个运行与原始冲突直接相关、不会构建 native 或写入仓库的精确测试文件；NEVER 运行完整测试套件。
- 上游同步期间 NEVER 运行任何 Rust/native build、check、test、lint、fmt、clippy、codegen 或 packaging；NEVER 运行根级 `bun run check`、`cargo`、`bazel`、`nix build`、Docker/native build 或会间接触发这些工作的脚本。

其他规则：

- NEVER 在本地开发中编译 Rust 代码。
- 仅测试交互式 UI 时，MUST 使用 `bun run omp2`；该命令从 `$HOME/.omp/natives/<version>` 加载原生包并运行仓库 TypeScript 源码，NEVER 本地编译原生代码。

## Change Discipline

- 不要为了测试而测试：仅为守护真实、可观察的契约添加测试，NEVER 为凑数、覆盖率或惯例添加测试。
- 本仓库长期与上游保持同步：自身修改 MUST 内聚、克制 —— 最小必要变更，改动集中，不引入无关重构、抽象或范围扩展。
