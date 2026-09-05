# Fork 维护规则

本仓库 fork 自 `can1357/oh-my-pi`，仅供个人使用，不以对外发布为目标。持续同步上游最新 `main`，同时维护个人功能和默认值，使安装后无需额外配置即可使用。

## 三份文档的职责

* `AGENTS.md`：本仓库的维护原则与 agent 规则。
* `.omp/skills/upstream-release-sync/SKILL.md`：每日定时同步或手动同步上游的操作流程。
* `docs-zh-CN/fork.md`：面向本人和 AI agent 的当前上游基线与用户可感知的功能契约，也是冲突后重建 fork 功能的依据。

同步 MUST 保留这三份文档的 fork 版本，NEVER 用上游版本覆盖；按实际变化维护内容。

## 开发与差异记录

* 修改前 MUST 阅读 `docs-zh-CN/fork.md`。
* fork 改动 MUST 最小、集中、内聚；不做无关重构，不为覆盖率或惯例添加测试。
* 功能或默认值变化时 MUST 同步更新 `fork.md`；成功合入上游时 MUST 更新基线并复核受影响条目。
* `fork.md` 只记录当前有效的功能、默认值及必要行为约束，不记实现流水账、修复历史或同步历史，不建第二份差异清单。
* 优先采用上游最新实现。冲突很大时，可在上游实现上重写 fork 功能，不必保留旧代码；无法可靠保留功能时 MUST 中止同步，不能静默丢弃。

## 上游与分支

* 唯一同步来源：`https://github.com/can1357/oh-my-pi.git` 的 `refs/heads/main` HEAD；NEVER 使用 Release、tag、其他分支、`origin/main` 或配置型 `upstream/main` 代替。
* `main`：上游代码与个人改动的集成分支。
* `upstream`：最近成功合入的上游 `main` 的精确镜像，不含 fork commit；GitHub 上用于 PR/差异比较（base 为 `upstream`，compare 为 `main`）。
* 同步 MUST 遵循 Skill 的门禁、集成、验证、镜像与中止流程；NEVER 接受上游历史改写。
* 同步只完成本地 `main` 集成与 `upstream` 镜像，不自动推送 `main`；本地完成不代表 GitHub 已可比较最新 fork 差异，后者取决于远端 `main` 是否另行更新。

## 验证

* 普通 TypeScript 修改后 MUST 运行 `bun run fastcheck`；纯文档修改只做差异与格式检查。
* 上游同步的检查范围、次数和失败处理统一遵循 Skill，不运行全 workspace 检查、完整测试、Rust/native 检查或构建、打包、发布。
* 仅用户明确要求时运行 `bun scripts/jch-localci.ts`；该入口仅明确要求 `full` 时构建 Linux-x64 native addon。
* 用户要求 UI 测试时 MUST 使用 `bun run dev`，仅使用本地当前源码编译的 native addon；不存在则本地编译，不下载或复用其他来源的包。上游同步不运行 UI 测试。

## 中文文档

* `docs-zh-CN` 以覆盖上游 `docs` 全部文档的完整翻译为目标，并包含 fork 新增文档；翻译独立同步，可能落后于代码基线。
* 代码 review 或对比上游差异时，忽略同名文档的翻译内容，只审查新增文档，除非用户明确要求同步翻译。
* 同步翻译时先检查上游文档的新增与删除，只维护上游最新文档的翻译副本；不因同步代码自动开展翻译。
