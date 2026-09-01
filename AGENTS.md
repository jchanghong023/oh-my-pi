# Fork Repository

本仓库是 [`can1357/oh-my-pi`](https://github.com/can1357/oh-my-pi) 的 fork。

- MUST 仅同步上游最新正式 GitHub Release 对应的原始 tag；NEVER 直接同步上游 `main`。
- 上游同步 MUST 先执行 `.omp/skills/upstream-release-sync/SKILL.md` 第 0 节快速门禁；Release tag 与 `main:docs-zh-CN/fork.md` 基线相同时立即 no-op，只检查/修复镜像，NEVER 进入完整同步流程。
- 无新 Release 时浅克隆完全允许：NEVER deepen、unshallow、切换 `main`、运行 Bun/测试或创建长 TODO。只有确认新 Release 且历史确实不足时，才自动增量 deepen，并在最后自动 unshallow；不得要求用户手工处理。
- 新 Release 固定合入本 fork 已存在的本地 `main`；MUST 禁用分支名猜测，NEVER 隐式创建 `main`。
- 发生 merge conflict 时 MUST 主动尝试自动解决；只有无法可靠判断正确结果时才安全 abort，不得留下半完成 merge。
- 本地 `upstream` 与 fork 的 `origin/upstream` 是专用 Release 镜像，MUST 精确指向上游最新正式 Release commit；该分支不承载 fork 改动或开发提交。
- 镜像只在新 Release 的本地合入、验证和 fork 快照完成后更新；无新 Release 时可单独快速修复。正常演进普通 push，非 fast-forward 漂移只允许对 `origin/upstream` 使用精确旧 SHA 的 `--force-with-lease`。
- `AGENTS.md`、`.omp/skills/upstream-release-sync/SKILL.md`、`docs-zh-CN/fork.md` 是 fork 治理文件；同步时 MUST 无条件保留同步前 fork 版本，随后仅按 skill 更新 `fork.md`。
- 修改本 fork 前，MUST 先阅读当前差异快照：[`docs-zh-CN/fork.md`](docs-zh-CN/fork.md)。
- 合入上游正式 Release，或新增、修改、移除任何 fork 改动后，MUST 在同一变更中更新该快照；“上游同步记录”仅保留当前 Release，不作历史账本；每项描述 MUST 不超过 2 个 Markdown 源码行。不添加兼容别名或第二份清单。

# Development Rules

## Local Verification

After modifying local TypeScript code, you MUST run `bun run fastcheck` before yielding.

上游 Release 同步是唯一例外，MUST 按 `.omp/skills/upstream-release-sync/SKILL.md`：

- 无新 Release → 不运行任何代码检查或测试；浅克隆不构成阻塞。
- 新 Release 使用 `git merge --no-ff --no-commit`，在 merge commit 前完成检查；任一检查失败 MUST `git merge --abort` 并验证恢复。
- 验证只针对 staged 改动和受影响 workspace，全部顺序执行；NEVER 使用全 workspace 扫描或完整测试套件。
- 运行 Bun script 前 MUST 审计根及受影响 workspace 的 script/pre/post 链；只运行 `check:tools`、`fastcheck` 和受影响 workspace 中确认安全的 TS/JS `check`，冲突时才追加精确直接测试。
- NEVER 在上游同步期间运行 Rust/native build、check、test、lint、fmt、clippy、codegen 或 packaging；NEVER 运行根级 `bun run check`、`cargo`、`bazel`、`nix build`、Docker/native build 或间接触发这些工作的脚本。
- TS/JS 对 native 包装层的纯静态检查 MAY 运行，但 MUST 先确认不调用 Rust/native 工具链。

其他规则：

- NEVER 在本地开发中编译 Rust 代码。
- 仅测试交互式 UI 时，MUST 使用 `bun run omp2`；该命令从 `$HOME/.omp/natives/<version>` 加载原生包并运行仓库 TypeScript 源码，NEVER 本地编译原生代码。

## Change Discipline

- 不要为了测试而测试：仅为守护真实、可观察的契约添加测试，NEVER 为凑数、覆盖率或惯例添加测试。
- 本仓库长期与上游保持同步：自身修改 MUST 内聚、克制 —— 最小必要变更，改动集中，不引入无关重构、抽象或范围扩展。
