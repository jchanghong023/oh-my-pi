# Fork Repository

本仓库是 [`can1357/oh-my-pi`](https://github.com/can1357/oh-my-pi) 的 fork。

- MUST 仅同步固定上游 `https://github.com/can1357/oh-my-pi.git` 的 `refs/heads/main` 当前精确 HEAD；NEVER 查询或使用 GitHub Release、tag、`target_commitish` 或其他分支决定同步内容。
- 每次同步 MUST 先执行 `.omp/skills/upstream-release-sync/SKILL.md` 第 0 节快速门禁；上游 `main` commit、当前基线与四项镜像均未变化时立即结束，不切分支、不 fetch、不改 ref、不运行检查或测试。
- 允许访问的远程分支仅有固定上游的 `refs/heads/main` 与本 fork 的 `origin/upstream`；NEVER 查询、比较、拉取、合并或重置 `origin/main`、配置型 `upstream/main` 或任何其他远程分支。
- 上游 `main` 出现新 commit 时，固定合入本 fork 已存在的本地 `main`；MUST 禁用分支名猜测，使用 `git merge --no-ff --no-commit`，NEVER 隐式创建 `main`，NEVER 自动 push `main` 或 tag。
- 当前基线 commit MUST 是候选上游 `main` HEAD 的祖先；非快进关系视为上游历史改写并停止，NEVER 自动接受 force-push、降级或改写镜像。
- 浅仓库缺少 merge base 时，只允许对固定上游 `refs/heads/main` 与 `origin` 中当前本地 `main` 的精确 HEAD SHA 做一次定向 deepen；NEVER unshallow 或扩散查询其他远程对象。
- 发生 merge conflict 时 MUST 主动尝试自动解决；只有无法可靠判断正确结果时才安全 abort，不得留下半完成 merge。
- 本地 `upstream` 与 `origin/upstream` 是专用上游 `main` 镜像，MUST 精确指向最近成功合入本地 `main` 的上游 commit，不承载 fork 改动或开发提交。
- `AGENTS.md`、`.omp/skills/upstream-release-sync/SKILL.md`、`docs-zh-CN/fork.md` 是 fork 治理文件；同步时 MUST 保留同步前 fork 版本，随后仅按 Skill 更新 `fork.md`。Skill 的历史名称和路径为兼容既有调用而保留，其当前语义是上游 `main` 同步，不再是 Release 同步。
- 修改本 fork 前，MUST 先阅读当前差异快照：[`docs-zh-CN/fork.md`](docs-zh-CN/fork.md)。
- 合入上游 `main`，或新增、修改、移除任何 fork 改动后，MUST 在同一变更中更新该快照；“上游同步记录”仅保留当前 `main` 基线，不作历史账本；每项描述 MUST 不超过 2 个 Markdown 源码行。不添加兼容别名或第二份清单。

# Development Rules

## Local Verification

After modifying local TypeScript code, you MUST run `bun run fastcheck` before yielding.

上游 `main` 同步是唯一例外，MUST 按 `.omp/skills/upstream-release-sync/SKILL.md`：

- 上游 `main` 无新 commit → 不切换 `main`、不补历史、不运行代码检查或测试。
- 上游 `main` 有新 commit → 使用 `git merge --no-ff --no-commit`；无冲突只执行 staged Git 检查，但若上游改动触及 fork 的 `fastcheck`/lint/format 契约，MUST 审计并执行一次安全的 `fastcheck`。
- 发生冲突时，只读取根和冲突 workspace 的脚本，只运行一次 `fastcheck`、冲突 workspace 中确认安全的 `check:types` 以及最多 3 个直接精确测试；全部顺序执行。
- NEVER 遍历或检查全部 workspace，NEVER 运行根级 `bun run check`、完整测试套件、UI/browser/heavy、Docker、benchmark、打包或发布流程。
- NEVER 在上游同步期间运行 Rust/native build、check、test、lint、fmt、clippy、codegen 或 packaging；NEVER 运行 `cargo`、`bazel`、`nix build` 或间接触发这些工作的脚本。
- TS/JS 对 native 包装层的纯静态 `check:types` MAY 运行，但 MUST 先确认不调用 Rust/native 工具链。

其他规则：

- NEVER 在本地开发中编译 Rust 代码；用户明确要求运行 `bun scripts/jch-localci.ts` 时，MAY 运行其白名单 Rust 测试；仅用户明确要求 `bun scripts/jch-localci.ts full` 时，MAY 构建当前 Linux-x64 native addon。
- 仅测试交互式 UI 时，MUST 使用 `bun run dev` 运行仓库 TypeScript 源码；native 由默认 loader 解析 `packages/natives/native/` 内已构建的 addon（`bun scripts/jch-localci.ts full` 构建或安装器预置），NEVER 本地编译原生代码。

## Change Discipline

- 不要为了测试而测试：仅为守护真实、可观察的契约添加测试，NEVER 为凑数、覆盖率或惯例添加测试。
- 本仓库长期与上游保持同步：自身修改 MUST 内聚、克制 —— 最小必要变更，改动集中，不引入无关重构、抽象或范围扩展。
