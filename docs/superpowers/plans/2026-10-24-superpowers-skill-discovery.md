# Superpowers Referenced-Skill Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 恢复八项被其他技能引用的内置 Superpowers 技能的普通发现与读取，同时让 `brainstorming`、`using-superpowers` 继续隐藏。

**Architecture:** 在既有包内资源生成阶段调整八项技能的 frontmatter，不另建运行时发现、依赖授权或会话激活机制。技能正文、上游原件副本、配套文件和固定版本不变；现有 Provider、普通 `skill://` 读取及 `/spec` 阶段门禁继续承担各自职责。

**Tech Stack:** Bun、TypeScript、既有 YAML/frontmatter 工具、包内 tar.gz 资源、Bun 测试和现有 app-server＋localhost 模型夹具。

**Spec:** `docs-zh-CN/requirements/spec-driven-orchestration.md` 第二节及 AC-02；该文档已先于本计划更新，是唯一需求权威，不另建设计或规格副本。

## Global Constraints

- 包内来源清单固定为 OpenSpec **1.14.3** 和 Superpowers **7.0.1**，后者源码修订为 `2ce8aa15d05bd57213e6f746f953aafb7ded7a8b`。
- `brainstorming` 是用户主动选择的手动入口，不恢复自动发现，也不自动启动需求探索。
- `using-superpowers` 不删除、不默认发现、不自动启用 bootstrap；其 `SKILL.md` 和整个 `references/` 均保留。
- 不新增递归依赖加载、整套技能预加载或会话激活机制；依赖正文只在实际使用时读取。
- 尚未恢复发现的隐藏技能继续使用既有显式调用或程序授权规则，不随上述八项一起放开。
- 仅修改下表八项的发现元数据和 description。两个既有可发现技能、所有技能正文、脚本、其他隐藏技能及 OpenSpec 发现策略保持不变。
- `/spec` 阶段允许名单、角色权限与批准门禁不变。允许读取技能不授予命令执行、提交或下游阶段权限。
- 不修改外部 Superpowers 克隆或运行时缓存中的技能来代替仓库资源生成；不升级版本、安装工具、恢复 Git hooks 或调用真实模型。
- 本计划不授权 commit/push、全仓构建、fulltest/slowtest、跨 WSL 或桌面操作；这些操作遵守仓库原有授权规则。

## Review Focus

1. 普通会话没有任何调用记录时，八项应出现在模型索引并能通过真实 `skill://` 读取；正文不预装。由既有 discovery/access 集成用例覆盖。
2. 手动启动 `brainstorming` 后读取 `writing-plans`，不应再索要 B 的独立调用授权；其他隐藏技能仍被拒绝。由真实 app-server 的同会话资源读取场景覆盖。
3. 当前处于 `/spec` 需求阶段时，新公开的 `writing-plans` 仍不能读取或注入。由既有 wrong-stage 用例覆盖。
4. 隐藏入口继续要求当前分支调用记录或程序授权，授权撤销不影响普通技能但仍收回隐藏技能访问。由既有 provenance/grant 用例覆盖。
5. `executing-plans`、`writing-skills` 仍能找到 `using-superpowers/references/`；资源重新生成不能删除平台说明或启用 bootstrap。用本轮临时资源/公开入口冒烟核验，不新增复制或措辞快照测试。

## File Structure

| 文件 | 职责及改动 |
| --- | --- |
| `docs-zh-CN/requirements/spec-driven-orchestration.md:58-84,304` | 已更新发现范围、隐藏入口及 AC-02；实施不再改变已确认范围 |
| `packages/coding-agent/src/prompts/skills/superpowers-descriptions.md`（新增） | 八项简短描述的静态源；内容为 YAML 映射，每个技能名对应一个字符串，由既有 YAML 解析器读取 |
| `packages/coding-agent/scripts/spec-driven-resources.ts:138-141,219-227` | 基于固定上游原件生成普通可发现技能或隐藏技能；生成产物仍由该脚本负责 |
| `packages/coding-agent/src/spec-driven/vendor/archive.generated.ts`、`inventory.json` | 通过现有生成器重建归档和文件摘要，不手工修改生成内容 |
| `packages/coding-agent/test/spec-driven/skill-policy.test.ts:71-131,169-213,253-309` | 验证十项普通发现/读取、十八项隐藏，以及隐藏授权和阶段拒绝；原先依赖 `writing-plans` 隐藏状态的场景改用真正的隐藏入口 |
| `packages/coding-agent/test/spec-driven/resources.test.ts:25-60` | 更新资源加载后的可见范围；沿用现有真实资源/CLI 覆盖，不新增 description 文字快照 |
| `packages/coding-agent/test/spec-driven/process.e2e.test.ts:584-753` | 更新真实公开入口的可见集合，补同会话 A→B 的读取场景 |
| `packages/coding-agent/test/spec-driven/provider-fixture.ts:113-133` | 仅为同会话资源场景扩展既有 localhost 模型夹具；真实 read 工具结果而非模型回答决定验收 |
| `docs-zh-CN/requirements/README.md:43`、`packages/coding-agent/CHANGELOG.md:17` | 同步需求索引说明和 Unreleased 用户可见变更，不改历史验证记录或发布段落 |

`resources.ts`、`discovery/spec-driven.ts`、`skill-policy.ts`、`internal-urls/skill-protocol.ts` 与系统技能匹配提示词预期无需修改：八项不再隐藏后即可复用既有普通分支。若实际运行证明必须修改这些运行时接口，先说明具体证据和最小必要变化，不扩大为通用授权改造。

## Description Copy

以下为计划编写者选择的文案，批准本计划即固定这些文案；不作为永久测试的文字快照。

| 技能 | description |
| --- | --- |
| `writing-plans` | Implementation planning for multi-step tasks with specifications or requirements. |
| `subagent-driven-development` | Execute plans with independent tasks using subagents in this session. |
| `executing-plans` | Execute plans inline when your partner chooses it or subagents are unavailable. |
| `using-git-worktrees` | Prepare isolated workspaces for feature work or plan execution, using native tools or Git worktrees. |
| `test-driven-development` | Apply TDD before implementing features or bug fixes. |
| `requesting-code-review` | Request code review after tasks or major features, or before merging. |
| `finishing-a-development-branch` | Choose integration steps after implementation and all tests pass. |
| `writing-skills` | Create, edit, or validate skills before deployment. |

## Task 1: Restore Referenced-Skill Discovery End to End

**Files:** 上述文件构成一个内聚交付；生成器、归档、调用消费者和验收不能分开交付。

**Interfaces:**
- Consumes: `ensureSpecDrivenResources(): Promise<SpecDrivenResources>`、`loadSpecDrivenSkill(source: SpecDrivenResourceSource, name: string): Promise<Skill>`、`SkillProtocolHandler.resolve(url: InternalUrl, context?: ResolveContext): Promise<InternalResource>`，签名不变。
- Produces: `superpowers-descriptions.md` 的固定八项 `Record<string, string>` 数据；生成器新增私有 `adaptSuperpowersSkill(name: string, raw: Uint8Array): Uint8Array`。不新增公开运行时 API、配置项或 CLI 参数。
- Ordinary set: Description Copy 的八项，加 `systematic-debugging`、`verification-before-completion`；其余五项 Superpowers 和十三项 OpenSpec 继续隐藏。

- [x] **Step 1: 更新既有契约测试，表达新的可观察行为。**
  将首个 discovery/access 用例命名为 `exposes referenced Superpowers skills without opening hidden entrypoints`，保留实际 Provider、system prompt、completion、resolve/locate 的消费链，使用独立于生产映射的期望：
  ```ts
  const ordinaryNames = [
    "writing-plans", "subagent-driven-development", "executing-plans", "using-git-worktrees",
    "test-driven-development", "requesting-code-review", "finishing-a-development-branch",
    "writing-skills", "systematic-debugging", "verification-before-completion",
  ].sort();
  expect(discovered.all.filter(skill => !isHidden(skill)).map(skill => skill.name).sort()).toEqual(ordinaryNames);
  expect(discovered.all.filter(isHidden)).toHaveLength(18);
  ```
  - 现有各技能循环继续验证：普通技能无 invocation branch 时 resolve/locate 成功，隐藏技能返回 `SkillAccessDeniedError`；系统索引和 completion 的可见集合一致。删除现有将 resolved 正文与源文件全文相等的复制断言，不新增正文或 description 快照。
  - 隐藏 provenance、scoped grants 和隐藏名称不枚举场景中，原先使用真实 `writing-plans` 的地方改用 `brainstorming`；本地同名覆盖场景继续使用 `writing-plans`，保持普通优先级。
  - 既有 wrong-stage 场景包含新公开的 `writing-plans`，断言 `SkillAccessDeniedError` 和 `not allowed during requirements`，不能删除阶段拒绝断言来求绿。
  - `resources.test.ts` 的可见范围与此契约一致。只更新消费行为期望，不增加 description 原文、字数或实现源码快照。

- [x] **Step 2: 运行上述两个精确文件，取得有效红灯。**
  Run: `bun scripts/test-report-bun.ts packages/coding-agent/test/spec-driven/skill-policy.test.ts packages/coding-agent/test/spec-driven/resources.test.ts`
  Expected: 新公开技能仍隐藏或仍遭 `explicit current-session invocation required` 的契约断言失败；工具、环境或无关用例失败不能作为本变更的红灯。此处只运行本次两个目标文件，不替代或隐式授权 fulltest。

- [x] **Step 3: 实现生成阶段的八项描述与可见性适配。**
  - 创建静态 `.md` 描述映射，通过 `with { type: "text" }` 导入生成器，使用已有 `yaml` 库解析；不在 TypeScript 内拼接新的模型指令。
  - `adaptSuperpowersSkill(name, raw)`：两个既有默认发现技能直接保留原字节；映射内八项仅改 YAML frontmatter 的 `description` 且不添加隐藏字段；其余技能复用现有 `hidden()`。
  - 以原文开头的 frontmatter 分隔符及第一个独占行的结束分隔符划分头部；仅对头部使用既有 `parseYaml`／`stringifyYaml` 修改 description，结束分隔符后的尾段按原字节保留。`original-skills/` 保留上游原件；`superpowersSkills` 和 manifest 身份清单不删项。

- [x] **Step 4: 从当前固定归档离线准备 staging，再调用原生成器重建产物。**
  - 确认既有 `vendor/staging` 不包含其他工作的内容；存在用户或其他任务的 staging 时停止占用，不覆盖。
  - 使用临时 Bun 脚本导入当前 `archiveBase64`、`resourceManifest`，通过现有 `extractArchive` 解包到生成器既有 staging；把 `superpowers/original-skills/<name>/SKILL.md` 恢复到相应源码技能位置，避免把上一轮隐藏适配当成上游原件再次处理。
  - 从当前 manifest 写入 staging 的 `source.json`（固定 revision/integrity），复用归档内现成的 OpenSpec CLI、模板、`bun.lock` 与 `node_modules`。不运行 `--prepare`、联网下载或依赖安装。
  Run: `bun packages/coding-agent/scripts/spec-driven-resources.ts --embed`
  Expected: 仍交付 28 项技能和固定版本；归档及 inventory 由生成器同步输出。临时比对新旧资源：仅八项生效 `SKILL.md` 的 frontmatter 以及生成 manifest/摘要变化，正文、上游原件、其他资源和 `dependency-lock.bun` 不变；若额外变化，先定位，不接受无关再生成差异。

- [x] **Step 5: 复验 Step 2 的受影响失败项及相关授权场景。**
  Run: 同 Step 2，若已有未变输入的通过证据则按具体失败 test-name 复验，不反复运行已通过项。
  Expected: 十项可发现且可普通读取、十八项仍隐藏；`brainstorming` 的有效调用和撤销行为保持，`writing-plans` 错阶段仍被拒绝，同名本地技能优先级不变。

- [x] **Step 6: 更新既有真实入口场景并完成 A→B 冒烟。**
  - `process.e2e.test.ts` 的 `packaged skills preserve default discovery and explicit-only access` 使用同一明确的十项期望集合，不从生产 description 映射反推名单。
  - 复用 `provider-fixture.ts` 的 `OMP_SPEC_MANUAL_RESOURCE` 请求格式：给它增加可选的字符串数组 `allowedPaths`；格式校验保留，实际 read 顺序为 selected path、各 allowed path、合并的 denied paths。既有请求不带该字段时行为不变。
  - 在手动 `/skill:brainstorming` 的同一会话中，通过 `allowedPaths` 读取 `skill://writing-plans:raw`，不发送 `/skill:writing-plans`。按工具调用 ID 断言模型收到的真实工具结果和公开工具行成功；`using-superpowers` 等其他隐藏正文仍拒绝。该场景只读取，不让模拟模型执行计划或自动交接。
  - 一次性核对真实包内 `using-superpowers/references/codex-tools.md`、`gemini-tools.md` 和执行器引用的目录能按既有路径使用；不把该目录的读取当作 bootstrap 技能启动。
  Run: `bun scripts/test-report-bun.ts packages/coding-agent/test/spec-driven/process.e2e.test.ts --test-name-pattern "packaged skills preserve default discovery and explicit-only access"`
  Expected: 实际 `src/cli.ts app-server --stdio`＋隔离 localhost 服务验证模型请求的包内上游技能索引仅有十项、正文按需读取、A→B 成功、隐藏项拒绝、项目没有实现/归档/提交副作用，进程正常退出。运行后移除本轮临时脚本和夹具；不宣称真实模型遵循质量、编译发行包或其他平台已验收。

- [x] **Step 7: 同步用户可见说明并做必要静态检查。**
  - 修改需求索引对应行和现有 Unreleased Changed 条目，明确八项恢复发现、两个隐藏入口保留；验证记录只报告本次真实证据，不把旧 fulltest 改称本次通过。
  - 一批修改完成后，存在具体静态验证需要时运行一次 `bun run fastcheck`；它不是测试，也不授权 fulltest/slowtest。报告实际结果与未验证边界，不运行编译发行包来扩展本次范围。
  - 自有临时文件不保留；不改真实用户配置、外部克隆、旧缓存或现有构建缓存。

- [x] **Step 8: 交付证据，等待另行提交授权。**
  列出实际命令、退出码、平台、真实入口结果及未运行项。用户未要求 commit，因此不执行 Git 写操作；若之后获得授权，只显式暂存本计划涉及且实际修改的文件，以禁用 hooks 的既有规则提交，不使用 `git add .`。

## Self-Review

- 规格覆盖：第二节三类发现策略及 AC-02 对应 Steps 1–6；保留资源和原件对应 Steps 3–4、6；需求索引及发布说明对应 Step 7。
- 接口一致：不改运行时公开接口；唯一新增生产函数为生成器私有 `adaptSuperpowersSkill`，模型夹具新增字段为可选 `allowedPaths: string[]`。
- 步骤边界：一个内聚任务，不把生成器、归档和消费测试拆成可单独误交付的任务；没有新的安装、bootstrap 或阶段推进路径。
- Review Focus 逐项对应既有契约测试或真实入口/临时资源冒烟，不为文案、复制或形式上的覆盖新增永久测试。
- 当前状态：全部步骤已实施并完成自检及独立审查，未发现待修问题；定向契约复验、真实公开入口冒烟及 fastcheck 均通过。详细证据见 `runs/spec-driven-discovery/2026-10-24T02-37-29.554Z/verification.json`。未作提交，未运行 fulltest／slowtest，未构建发行包或验证真实模型、其他平台及当前进程热更新。
