# Fork Repository

本仓库是 [`can1357/oh-my-pi`](https://github.com/can1357/oh-my-pi) 的 fork。

- MUST 仅同步上游正式发布版本对应的 tag。
- NEVER 直接同步上游 `main` 分支。
- 同步上游分支时，直接使用 skill：`.omp/skills/upstream-release-sync/`（读取其中的 `SKILL.md` 并按其流程执行）。

# Development Rules

## Local Verification

After modifying local TypeScript code, you MUST run `bun run fastcheck` before yielding.
- 本地开发禁止编译 Rust 代码。

## Change Discipline

- 不要为了测试而测试：仅为守护真实、可观察的契约添加测试，NEVER 为凑数、覆盖率或惯例添加。
- 本仓库长期与上游保持同步：自身修改 MUST 内聚、克制 —— 最小必要变更，改动集中，不引入无关重构、抽象或范围扩展。
