# Fork Rules

本仓库 fork 自 `can1357/oh-my-pi`。

## Upstream Sync

* 唯一上游：`https://github.com/can1357/oh-my-pi.git` 的 `refs/heads/main` HEAD。
* NEVER 使用 Release、tag、其他分支、`origin/main` 或配置型 `upstream/main`。
* 同步 MUST 遵循 `.omp/skills/upstream-release-sync/SKILL.md`，先执行第 0 节门禁。
* 无变化：立即结束；不切分支、不 fetch、不改 ref、不测试。
* 有新 commit：仅合入已存在的本地 `main`，使用 `git merge --no-ff --no-commit`。
* 当前基线 MUST 是候选上游 HEAD 的祖先；否则停止，NEVER 接受历史改写。
* 浅仓库仅可按精确 SHA 定向 deepen；NEVER unshallow。
* 冲突可自动可靠解决则解决，否则 abort。
* `upstream` 与 `origin/upstream` MUST 精确指向最近成功合入的上游 commit。
* 同步 MUST 保留 fork 版：
  `AGENTS.md`、`.omp/skills/upstream-release-sync/SKILL.md`、`docs-zh-CN/fork.md`。
* 同步更新fork.md 

## Fork Changes

修改前 MUST 阅读 `docs-zh-CN/fork.md`。

合入上游或修改 fork 内容后 MUST 同步更新该文件；仅保留当前基线和当前差异，不记历史，不建第二份清单。

## Verification

普通 TypeScript 修改后 MUST：

`bun run fastcheck`

上游同步按 Skill：

* 无新 commit：不测试。
* 无冲突：仅 staged Git 检查；必要时一次 `fastcheck`。
* 有冲突：最多一次 `fastcheck`、安全的相关 `check:types`、最多 3 个精确测试，顺序执行。

同步期间 NEVER：

* 全 workspace 检查；
* 根级 `bun run check`、完整测试、UI/browser/heavy、Docker、benchmark、打包、发布；
* Rust/native build/check/test/lint/fmt/clippy/codegen/packaging；
* `cargo`、`bazel`、`nix build`。

## Native / UI

* 仅用户明确要求时运行 `bun scripts/jch-localci.ts`；仅明确要求 `full` 时构建 Linux-x64 native addon。
* UI 测试 MUST 使用 `bun run dev`，复用本地当前源码编译出的 native addon，不存在就编译本地代码，不要下载或者复用其他来源的本地包。

## Discipline

所有 fork 改动 MUST 最小、集中、内聚；不做无关重构，不为覆盖率或惯例添加测试。

## 文档
docs-zh-CN 是docs的全部翻译加上新文档。代码review，对比上游分支变化的时候，忽视同名文件翻译内容，只涉及新增文档，除非用户明确要求同步翻译
同步翻译的时候，要先检查上游有没有新增或者删除文档。fork仓只维护上游最新文档的翻译副本。
