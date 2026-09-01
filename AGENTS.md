# Fork Repository

本仓库是 [`can1357/oh-my-pi`](https://github.com/can1357/oh-my-pi) 的 fork。

- MUST 仅同步上游最新正式 GitHub Release 对应的原始 tag；NEVER 直接同步上游 `main`。
- 上游 Release 固定合入本 fork 的 `main`；发生 merge conflict 时 MUST 主动尝试自动解决，只有无法可靠判断正确结果时才停止。
- 同步上游时 MUST 使用 `.omp/skills/upstream-release-sync/SKILL.md`，并按其中完整流程执行。
- 本地 `upstream` 与 fork 的 `origin/upstream` 是专用 Release 镜像，MUST 精确指向上游最新正式 Release commit；该分支不承载 fork 改动或开发提交。
- 本地 `upstream` MUST 跟踪 `origin/upstream`；缺失或 tracking 错误时按同步 skill 自动创建/校正。镜像漂移时只允许按 skill 对 `origin/upstream` 使用带精确 lease 的 `--force-with-lease`，NEVER 对其他分支 force-push。
- `AGENTS.md`、`.omp/skills/upstream-release-sync/SKILL.md`、`docs-zh-CN/fork.md` 是 fork 治理文件；同步上游时 MUST 保留 fork 版本，NEVER 被上游覆盖。其中 `docs-zh-CN/fork.md` 在 Release merge 后更新当前快照。
- 修改本 fork 前，MUST 先阅读当前差异快照：[`docs-zh-CN/fork.md`](docs-zh-CN/fork.md)。
- 合入上游正式 Release，或新增、修改、移除任何 fork 改动后，MUST 在同一变更中更新该快照；“上游同步记录”仅保留当前 Release，不作历史账本；每项描述 MUST 不超过 2 个 Markdown 源码行。不添加兼容别名或第二份清单。

# Development Rules

## Local Verification

After modifying local TypeScript code, you MUST run `bun run fastcheck` before yielding.

上游 Release 同步是唯一例外，MUST 按 `.omp/skills/upstream-release-sync/SKILL.md`：

- merge 全程无冲突 → NEVER 运行代码测试、代码检查、构建或编译。
- merge 出现冲突并由代理解决 → 创建 merge commit 前 MUST 且仅运行 `bun run fastcheck`。

其他规则：

- NEVER 本地开发禁止编译 Rust 代码。
- 仅测试交互式 UI 时，MUST 使用 `bun run omp2`；该命令从 `$HOME/.omp/natives/<version>` 加载原生包并运行仓库 TypeScript 源码，NEVER 本地编译原生代码。

## Change Discipline

- 不要为了测试而测试：仅为守护真实、可观察的契约添加测试，NEVER 为凑数、覆盖率或惯例添加测试。
- 本仓库长期与上游保持同步：自身修改 MUST 内聚、克制 —— 最小必要变更，改动集中，不引入无关重构、抽象或范围扩展。
