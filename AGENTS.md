# Fork Repository

本仓库是 [`can1357/oh-my-pi`](https://github.com/can1357/oh-my-pi) 的 fork。

- MUST 仅同步上游正式发布版本对应的 tag。
- NEVER 直接同步上游 `main` 分支。
- 同步上游分支时，直接使用 skill：`.omp/skills/upstream-release-sync/`（读取其中的 `SKILL.md` 并按其流程执行）。
- 本仓库的 `AGENTS.md` 是 fork 的有意差异：同步上游时 MUST 保留本仓库版本，NEVER 被上游合并覆盖。
- 修改本 fork 前，MUST 先阅读当前差异快照：[`docs-zh-CN/fork.md`](docs-zh-CN/fork.md)。
- 合入上游正式 release，或新增、修改、移除任何 fork 改动后，MUST 在同一变更中更新该快照；“上游同步记录”仅保留当前 release，不作历史账本；每项描述 MUST 不超过 2 个 Markdown 源码行。不添加兼容别名或第二份清单。

# Development Rules

## Local Verification

After modifying local TypeScript code, you MUST run `bun run fastcheck` before yielding.
- NEVER 本地开发禁止编译 Rust 代码。

## Change Discipline

- 不要为了测试而测试：仅为守护真实、可观察的契约添加测试，NEVER 为凑数、覆盖率或惯例添加测试。
- 本仓库长期与上游保持同步：自身修改 MUST 内聚、克制 —— 最小必要变更，改动集中，不引入无关重构、抽象或范围扩展。
