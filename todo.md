# OpenSpec 内置副本裁剪计划

## 目标与边界

保留 OpenSpec 在 OMP 中需要的业务实现、全部通用工作流、Skill、schema、模板、有用文档及必要构建输入；删除独立上游仓库的工程管理材料、上游自身需求与历史计划、上游测试，以及其他 Agent 专用适配和安装能力。

- 唯一裁剪根目录：`packages/coding-agent/src/spec-driven/vendor/resources/openspec/`，下文路径均相对此目录。
- 上游参考：`C:\Users\jiang\Documents\OpenSpec`，只读，不改动。
- 仅更新执行计划，未执行本文件中的删除、源码修改、构建或测试。
- 不修改 OMP 根目录的 `openspec/`、规则、用户需求或 `packages/coding-agent/test/`，不裁剪 Superpowers、JCH 等兄弟资源。
- 这次是有边界的内置业务裁剪，不再追求与上游整仓文件集合相同；除明确列出的裁剪依赖外，不重写 OpenSpec 业务语义，不恢复 mini／omp-spec 等旧魔改。

## 1. 执行前保护

- [x] 固定实际来源提交、版本，记录目标已有改动；既有来源记录只作背景，不将旧比对结果当作本轮已完成证明。
  - 来源实测（`C:\Users\jiang\Documents\OpenSpec`）：`main` @ `ea635dd255f8686dcf48626bbcbe0e3fd59b6067`（2026-11-13 22:09:16 +0000，`fix(binaries): label the Windows executables as OpenSpec (#2246)`），`git describe` 为 `@fission-ai/openspec@2.0.0-1-gea635dd2`，`package.json` 版本 `2.0.0`，工作区干净（0 修改／未跟踪），`git ls-files` 1378 个文件。
  - 目标实测：同路径 1378 个文件，与来源无任何单侧独有文件；`diff -rq --strip-trailing-cr` 无差异，唯一差异是换行（目标 1372 个含 LF 的文本文件、5 个二进制、1 个空文件 `AGENTS.md`；来源工作区为 CRLF）。结论：目标无内容层面的既有改动，仅有检出换行差异。
  - `vendor/inventory.json` 中 `openspec.version=2.0.0`、`integrity=git:ea635dd255f8686dcf48626bbcbe0e3fd59b6067` 与本次实测一致，仅作背景，不作为完成依据。
  - OMP 仓库对该路径及目标树无未提交改动；本轮开始时唯一未提交文件为 `todo.md` 自身。
- [x] 将当前目标完整备份到仓库外，记录恢复位置；备份不能放进 vendor 资源树。
  - 备份位置：`F:\code2026\_backup\openspec-vendor-preTrim-ea635dd-20261114`（OMP 仓库根 `F:\code2026\oh-my-pi` 的同级目录，`git status` 未出现该路径）。
  - 方式与范围：`cp -a` 整树复制（含空文件与二进制），1378 个文件、11 MB；目标与备份的全量文件 sha256 清单哈希均为 `a2615a10e307c7dfe170009c3197292bff65bc2093fe2613a11f470ad928a83d`，`diff -rq` 0 差异。
  - 恢复方式：将备份目录内容复制回 `packages/coding-agent/src/spec-driven/vendor/resources/openspec/` 覆盖即可；清单哈希不一致时以备份为准重新复制。
- [x] 生成按相对路径列出的删除／修改清单。核对真实根目录，不经 junction／符号链接递归删除，不使用全仓文件名匹配。
  - 根目录核对：`packages\coding-agent\src\spec-driven\vendor\resources\openspec` 的 `realpath` 仍为同一仓库内路径；根目录及上级 `resources`／`vendor`／`spec-driven`／`src` 均非符号链接、非 reparse point。
  - 链接扫描：目标树内 0 个 symlink／junction（`os.walk(followlinks=False)` 全树检查）。后续删除只用清单中的显式相对路径，不做文件名通配递归。
  - 清单见文末“附录 A”，按当前实测树（来源 `ea635dd`）逐项列出，共 1022 个目录内文件 + 12 个根文件 + 15 个脚本 + 33 个 adapter + 2 个独立源码文件待删，另有 12 个源码／配置文件的修改点。
- [x] 保存保留文件的路径及内容摘要；本轮结束按“明确删除、明确修改、原样保留”三类核对。
  - 清单文件：`F:\code2026\_backup\openspec-vendor-retained-sha256-ea635dd.txt`（仓库外，与备份同目录），294 行，格式 `sha256<TAB>相对路径`；文件自身 sha256 为 `606631d7f47c23312817c9c056d3c0b54ab64ed9e0bfc05ed5e3a258c2ee8e87`。
  - 分类基数（合计 1378，与来源 `git ls-files` 一致）：明确删除 1084（A.1 目录 1022 + A.2 根文件 12 + A.3 脚本 15 + A.4 源码 35）；明确修改候选 18（A.5 展开到文件：`adapters/index.ts`、`registry.ts`、`config.ts`、`available-tools.ts`、`shared-skill-target.ts`、`shared/skill-paths.ts`、`shared/tool-detection.ts`、`shared/shared-skill-install.ts`、`shared/skill-links.ts`、`retired-tools.ts`、`legacy-cleanup.ts`、`released-output-sweep.ts`、`init.ts`、`update.ts`、`cli/index.ts`、`package.json`、`pnpm-lock.yaml`、`docs/supported-tools.md`，均已确认存在）；原样保留 276。
  - 保留分布：`src/` 189（224 − 35）、`docs/` 27、`docs-lab/` 43、`skills/` 13、`schemas/` 5、`assets/` 4、`bin/` 1、根文件 12。
  - 收尾核对方式：对实际保留文件重算 sha256，与清单逐行比对；不在 18 个修改候选内的文件必须哈希一致，删除项不得存在。

## 2. 原样保留业务与构建输入

- [x] 保留 `src/` 的通用业务：CLI、根目录／store 解析、需求管理、artifact graph、schema、模板、提示词、校验、同步、归档、完整工作流。仅按第 5 节裁掉特定外部工具集成。
  - 逐项核对（保留清单 189 个 `src/` 文件全部命中；本步未删任何文件）：CLI `src/cli/index.ts` + `src/cli/commands/`（7）；根目录／store `src/core/openspec-root.ts`、`root-selection.ts`、`project-config.ts`、`global-config.ts`、`src/core/store/`（6）；需求管理 `src/core/list.ts`、`view.ts`、`specs-apply.ts`、`change-status-policy.ts`、`relationship-health.ts` + `src/commands/{change,spec,show,validate}.ts`；artifact graph `src/core/artifact-graph/`（8）；schema `src/core/schemas/`（4）+ `config-schema.ts` + 根 `schemas/`（5）；模板 `src/core/templates/`（19）；提示词 `src/prompts/searchable-multi-select.ts` + workflow 模板；校验 `src/core/validation/`（6）+ `validate.ts`；同步 `src/core/archive.ts`（归档时重建／同步 specs）与 `specs-apply.ts`；归档 `src/core/archive.ts` + `archive [change-name]` 注册（L612）；完整工作流 `src/commands/workflow/`（8）+ `command-surface.ts`、`profiles.ts`、`src/core/init.ts`、`update.ts`。
  - 裁剪边界：`src/` 内仅 A.4 的 33 个 adapter、`github-copilot/cloud-agent.ts`、`commands/install-standalone.ts` 待删（其余为 A.5 修改），通用业务目录均不在删除清单中。
  - 备注：上游无独立 `sync` 命令，“同步”由 `archive` 的 delta→specs 重建承担；`src/commands/archive.ts` 不存在，归档实现位于 `src/core/archive.ts`。
- [x] 保留 `bin/`、`schemas/`、`skills/` 及全部通用 Skill，不按默认 profile 删掉 apply、verify、onboard 等可选工作流。
  - `bin/`（1）：`bin/openspec.js`（79 字节，导入 `../dist/cli/index.js` 后调用 `runCli()`），不在删除清单。
  - `schemas/`（5）：`schemas/spec-driven/schema.yaml` 与 `templates/{proposal,spec,design,tasks}.md`，全部保留。
  - `skills/`（13）：`README.md` + 12 个 `openspec-*/SKILL.md`，与 `ALL_WORKFLOWS` 的 12 个 id 一一对应（propose、explore、new、continue、apply、update、ff、sync、archive、bulk-archive、verify、onboard），apply／verify／onboard 均在列。
  - 说明：`CORE_WORKFLOWS`（默认 profile）只含 propose／explore／apply／update／sync／archive，这是运行时装配策略；裁剪不据此删除其余 6 个可选工作流的 Skill 文件。`skills/README.md` 声明其内容由模板生成（`generate:skills`），本轮仅保留现成文件与模板，不因删除该脚本而删除 Skill 数据。
  - 三者均完整出现在保留清单（`bin/` 1 + `schemas/` 5 + `skills/` 13），本步未改动任何文件。
- [x] 保留 `LICENSE`、`package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`、`tsconfig.json`、`build.js`、`.gitattributes`、`.gitignore`。
  - 8 个文件全部存在且均在保留清单中，不在 A.2 删除范围：`LICENSE`（1072 B，MIT）、`package.json`（2253 B，`version 2.0.0`、`type: module`、`bin.openspec=./bin/openspec.js`、`files=[dist,bin,schemas,…]`、`engines.node>=22.12.0`）、`pnpm-lock.yaml`（88647 B，`pnpm@10.34.5`）、`pnpm-workspace.yaml`（2662 B，`packages: ['.']` + `allowBuilds.esbuild` + 8 组安全 overrides）、`tsconfig.json`（530 B，`rootDir src`／`outDir dist`／`include src/**/*`、`exclude test`）、`build.js`（836 B，仅依赖本地 `typescript/bin/tsc` 清理并编译到 `dist`）、`.gitattributes`（652 B）、`.gitignore`（2466 B）。
  - 构建链核对：`build.js` → `tsc` → `dist`，`bin/openspec.js` 导入 `../dist/cli/index.js`；无对 `scripts/`、`test/` 的构建依赖，删除这些目录不破坏构建入口。
  - 需注意但不属于本项：`.gitattributes` 仍保留 `test/fixtures/released-output/**` 的 `-text` 规则，`test/` 删除后会成为失效规则；`package.json` 的 `files` 含 `dist/**/*.test.js` 等排除项同理。留待第 4 节清理时按“仅为已移除材料服务”处理，不在本步改动。
- [x] `pnpm-workspace.yaml` 含实际依赖 overrides，不因其名称为 workspace 而删除。package.json 也被 CLI 用于读取版本，不可删除。
  - `pnpm-workspace.yaml` 是 overrides 的唯一声明处：`packages: ['.']`、`allowBuilds.esbuild=true`，9 条安全覆盖（brace-expansion、postcss、js-yaml×2、nanoid、fflate、shell-quote、launch-editor、minimatch），与 `pnpm-lock.yaml` 的 `overrides:` 段逐条一致；`package.json` 无 `pnpm.overrides`（注释说明 pnpm 10 会用 workspace 文件替代而非合并，故不能迁入 package.json）。
  - `package.json` 版本读取消费者实测 6 处：`src/cli/index.ts:73`、`src/core/init.ts:95`、`src/core/update.ts:93`、`src/core/version-check.ts:15`（并 L441 以 URL 读取）、`src/core/shared/own-skill-texts.ts:16`、`src/commands/feedback.ts:44`；删除 `package.json` 会直接破坏 `openspec version`、初始化与技能文本。
  - 结论：两个文件都必须保留，且本轮不改 overrides 内容；第 4 节只清理 devDependencies 与脚本时须保留该 overrides 块不动。
- [x] 保留业务源码中的内嵌说明、历史格式识别和通用迁移安全检查；“历史指纹”不等于“上游历史研发档案”，不能不看消费者便整文件删除。
  - 历史指纹（`src/core/shared/released-generated-fingerprints.ts`，4010 行：2867 条内容指纹 + 1 组 `RELEASED_GENERATED_PATHS`）是“哪些旧版本产物可以安全删除”的白名单，不是上游计划档案。消费者链：`generated-fingerprint.ts`（`isReleasedGeneratedContent`／`hasReleasedOpenSpecBlock`／`normalizeGeneratedContent`）→ `legacy-cleanup.ts`（L563/591/1055/1059）、`released-output-sweep.ts`（L18/217）、`shared-skill-target.ts`（L97）、`shared/command-reconcile.ts`（L122）、`shared/skill-content-equivalence.ts`。无该数据会把用户改过的文件误判为可删。
  - 历史格式识别：`legacy-cleanup.ts`（1376 行）保留 `LEGACY_CONFIG_FILES`（8 个根配置文件）、`LEGACY_SLASH_COMMAND_PATHS`（目录式／文件式旧命令）、`LEGACY_GLOBAL_SLASH_COMMAND_PATHS`、marker 块解析与 `cleanupLegacyArtifacts`；`migration.ts`（715 行）保留 profile 迁移、`migrateLegacyToolDirs`、`needsConsent` 等安全检查；`retired-tools.ts`（109 行）保留退役目标清点；`released-output-sweep.ts`（243 行）保留旧产物清理与 `pruneEmptyParents`。
  - 调用方实测：`init.ts` L46/67/78/274/779/980 与 `update.ts` L40/46/48/49 均依赖上述模块；它们是 init/update 通用安全网，不能按名称命中整文件删除。
  - 第 5 节裁剪约束：A.5 对 `legacy-cleanup.ts`／`retired-tools.ts`／`released-output-sweep.ts` 只移除“遍历、迁移、删除其他 Agent 用户目录”的分支，必须保留 OMP 自身旧输出识别、marker 解析、指纹判定与防误删检查；`LEGACY_CONFIG_FILES` 中的其他 Agent 文件名属于“被管理产物清单”数据，不是待删除适配代码。
  - 内嵌说明：`generated-fingerprint.ts` 的归一化注释（BOM／CRLF／`generatedBy` 版本）与 `legacy-cleanup.ts` 的“只删自己写的文件、目录空才删”注释均说明安全性设计，随源码保留，不清理注释。

## 3. 保留有用文档及引用资源

- [x] 保留根 `README.md`、`CHANGELOG.md`、`SECURITY.md`、`install.md`；它们提供使用入口、版本变化、安全说明及安装背景，不因不是可执行代码而删除。
  - 4 个文件均在保留清单：`README.md`（255 行，项目入口、工作流说明、仪表盘预览）、`CHANGELOG.md`（1520 行，版本历史，最新 2.0.0）、`SECURITY.md`（62 行，报告渠道／支持版本／威胁模型与发布包边界）、`install.md`（83 行，面向 Agent 的安装与初始化步骤）。
  - 本地引用核对：`README.md` 引用 `assets/openspec_bg.png`（L4/5）与 `assets/openspec_dashboard.png`（L101），两张图均在保留清单，故 `assets/` 不能整删；`CHANGELOG.md` 中的 `./doc.md` 仅是示例文本，不是失效链接；`SECURITY.md`、`install.md` 无本地文件链接。
  - `README.md` 的 CI 徽章指向 `github.com/.../actions/workflows/ci.yml`（外链，不依赖被删的 `.github/` 本地文件）。
  - 待随第 5.3 节处理：`install.md` 仍描述 `openspec install` 独立二进制安装；删除独立安装能力后该段落会成为失效说明，届时按“文档链接指向已删除能力”规则改写，不影响本步保留决定。
- [x] 保留 `docs/`、`docs-lab/` 中的使用指南、CLI、工作流、配置、schema 定制、store、多仓使用、格式规范、排错和示例。
  - 全量保留：`docs/` 27 个文件、`docs-lab/` 43 个文件，全部命中保留清单；本步未删改任何文档。
  - 主题覆盖实测：使用指南 `docs/{getting-started,overview,concepts,existing-projects}.md` + `docs-lab/start/{installation,overview,quickstart,setup}.md`；CLI `docs/{cli,commands,how-commands-work,opsx}.md` + `docs-lab/reference/cli.md`；工作流 `docs/{workflows,team-workflow,explore,reviewing-changes,editing-changes}.md` + `docs-lab/guides/{apply,change-course,explore,review-the-plan,teams}.md`；配置 `docs/customization.md` + `docs-lab/customize/{overview,profiles,project-config,skills}` + `docs-lab/reference/configuration/{index,config-json,config-yaml,change-metadata,environment-variables,stores}.md`；schema 定制 `docs-lab/customize/schemas.md` + `docs-lab/reference/schemas/{index,schema-yaml,spec-driven/index}.md`；store／多仓 `docs/stores-beta/user-guide.md` + `docs-lab/multi-repo/{stores,worksets}.md`；格式规范 `docs/writing-specs.md`、`docs/agent-contract.md`、`docs-lab/reference/glossary.md`、`message-map.md`；排错 `docs/troubleshooting.md`、`docs/faq.md`、`docs-lab/help/{faq,troubleshooting,legacy/migration,upgrade-to-2}.md`；示例 `docs/examples.md`、`docs-lab/guides/examples.md`；安装 `docs/installation.md`、`docs-lab/start/installation.md`。
  - `docs/supported-tools.md` 与 `docs-lab/reference/supported-tools.md` 保留，其中“其他 Agent 用法”按下一项规则处理，不按名称整篇删除。
  - 待下一项分类：`docs-lab/Notes.md`、`docs-lab/sources.md`、`docs-lab/README.md` 及 `docs-lab/reference/architecture/*` 需按内容判定是否纯工程管理，本步不作删除决定。
- [x] 文档中包含其他 Agent 的用法，不单凭名称命中就整篇删除；共用业务说明保留，纯其他 Agent 安装教程可单独移除。历史上游用法不等于 OMP 已支持，不能用文档存在宣称功能可用。
  - 命中范围：23 个文档提及其他 Agent（按提及数排序：`docs/supported-tools.md` 40、`docs-lab/reference/supported-tools.md` 27、`docs/migration-guide.md` 22、`docs-lab/reference/cli.md` 21、`docs/how-commands-work.md` 12、`docs/cli.md` 12、`docs-lab/start/setup.md` 9、`docs/installation.md` 8、`docs/commands.md` 7、`docs-lab/help/upgrade-to-2.md` 6、`docs/troubleshooting.md` 4、`docs/opsx.md` 4、`docs-lab/start/installation.md` 4、`docs/faq.md` 3、`docs/customization.md` 3、`docs/community.md` 2、`docs-lab/multi-repo/{worksets,stores}.md`、`docs/stores-beta/user-guide.md`、`docs-lab/help/legacy/migration.md`、`docs-lab/Notes.md`、`docs-lab/README.md`、`docs-lab/reference/configuration/config-json.md`）。
  - 内容性质判定：全部是 OpenSpec 自身业务说明（支持矩阵、按工具生成 Skill／命令的路径、迁移与升级、CLI 参数、配置字段），没有“如何安装 Claude Code／Cursor／Codex”的第三方教程；唯一的 `install Claude Code integration files` 出现在 `docs-lab/reference/cli.md` 的 `openspec init --tools` 示例注释中，属业务示例。
  - 结论：本步不删除任何文档。按规则保留共用业务说明；第 5 节裁剪 AI_TOOLS 后再同步支持矩阵与工具目录，避免“文档列出 XX 目标”被误读为 OMP 已支持（`docs/supported-tools.md`、`docs-lab/reference/supported-tools.md`、`docs-lab/start/setup.md`、`docs/cli.md`、`docs-lab/reference/cli.md` 为首批受影响文档，归入 A.5 文档行）。
- [x] 对 `docs-lab/` 中的研究笔记、网站维护说明或内部计划按内容分类，只删除纯工程管理内容；不把整个 docs-lab 视为无用。
  - 分类结果：纯工程管理 7 个文件，已删除；其余 36 个文件保留（原 43）。删除项：`docs-lab/README.md`（文档并行重建项目计划、站点映射规则）、`docs-lab/Notes.md`（个人评审笔记）、`docs-lab/sources.md`（旧→新迁移映射与站点切换重定向清单）、`docs-lab/message-map.md`（Answered／Skeleton／Gap 状态跟踪表）、`docs-lab/reference/architecture/{index,workflow-runs,design-decisions}.md`（仅 WIP 注释、零正文，且注释声明“未上线、待写”）。
  - 删除前摘要：`README.md` `806a2bf6…`、`Notes.md` `65139179…`、`sources.md` `bba9adf0…`、`message-map.md` `27106f8d…`、`architecture/index.md` `2ec13eb0…`、`workflow-runs.md` `e35edc32…`、`design-decisions.md` `d726673d…`；空目录 `docs-lab/reference/architecture/` 一并移除。
  - 保留判定：`start/`、`guides/`、`customize/`、`multi-repo/`、`reference/{cli,configuration,schemas,skills,supported-tools,glossary}.md`、`help/` 等 36 个文件是实际使用文档（部分仍为骨架），不属于工程管理，未删除。
  - 悬空引用核对：删除后无 markdown 链接指向被删文件；`docs/getting-started.md` 的 `README.md` 指向仍存在的 `docs/README.md`。`docs-lab/start/overview.md`、`guides/teams.md`、`reference/skills.md` 的 HTML 注释中仍有 `Notes.md`／`message-map.md`／`sources.md` 字样，属作者备注，按后续文档链接清理项处理。
- [x] 保留 `assets/` 中被保留文档引用的图片等文件；没有引用且仅用于网站展示／构建的资源再删除。先核对相对链接及源码资源引用，不能整删 assets。
  - `assets/` 共 4 个文件，引用实测（全树搜索，排除 `.git`）：`openspec_bg.png` ← `README.md` L4/5；`openspec_dashboard.png` ← `README.md` L101（README_OLD 亦引用）；`openspec_pixel_dark.svg`、`openspec_pixel_light.svg` ← 仅 `README_OLD.md` L4/5/6。
  - `src/`、`skills/`、`schemas/`、`docs/`、`docs-lab/` 均无 `assets/` 引用；`website/` 不引用根 `assets/`，其图标用自带 `website/public/docs/openspec-pixel.svg`。
  - 本步判定：`openspec_bg.png`、`openspec_dashboard.png` 由保留的 `README.md` 引用，必须保留；两张 pixel SVG 当前由 `README_OLD.md` 引用，暂不删除。待第 4 节核对 `README_OLD.md` 内容覆盖并删除后，两张 SVG 即失去唯一引用，届时一并删除（归入 `README_OLD.md` 的删除动作）。
  - 结论：本步零删除，`assets/` 保持 4 个文件；不存在“仅网站使用”的资产（网站资源在 `website/public/docs/`，随 `website/` 一起删除）。
- [x] 删除 `website/` 工程前，先检查其中是否有 `docs/`、`docs-lab/` 没有的实际使用文档或示例。有则将正文和必要引用资源按主题移入保留文档目录、修正本地链接，再删除网站运行、组件、部署、依赖及构建文件。不能直接删掉独有的有用正文。
  - 内容核对（42 个文件、229 KB）：`README.md` 自述“doc pages are generated, not authored here”，`docs.sync.config.mjs` 的 37 个 `source` 全部指向 `docs-lab/`（`start/`、`guides/`、`customize/`、`multi-repo/`、`reference/`、`help/`）；`app/` 仅有路由与布局，`app/page.tsx` 是跳转到 `/docs` 的 meta-refresh 占位，`app/llms*.txt` 从生成内容输出，`lib/`、`components/` 为站点运行代码，`public/docs/*` 为站点图标，`cloudflare/router` 与 `scripts/` 为部署／同步工具。
  - 提取判定：无 `docs/`、`docs-lab/` 缺失的正文或示例，无需搬运；`docs-lab` 中 36 个保留文档即站点唯一内容源。`website/README.md` 描述的是站点自身构建／部署流程，属工程材料，不并入产品文档。
  - 已删除整个 `website/`（42 个文件），含 Next.js 运行代码、组件、搜索与 og 路由、Cloudflare Worker、`docs.sync.config.mjs`、`scripts/{sync-docs,preview}.mjs`、独立 `package.json`／`pnpm-lock.yaml`／`pnpm-workspace.yaml`、`public/docs` 图标。
  - 引用核对：保留文档中仅有 HTML 注释提到 `website/docs.sync.config.mjs`（`docs-lab/help/{faq,troubleshooting,legacy/migration}.md`）与 `CHANGELOG.md` 的历史发布说明；无 markdown 链接指向 `website/`。`test/` 中的 `website/` 断言随 `test/` 整体删除。
  - 备注：第 4 节“`website/`：仅在第 3 节完成有用内容提取后删除”已由本步完成，待该行执行时标记。
- [x] 文档链接指向已删除的本地研发文件时，删除无用导航或改为固定来源的上游链接；保留业务示例，不伪造 OMP 支持状态，不把检查扩展为全站联网链接审计。
  - 范围：`README.md`、`install.md`、`SECURITY.md`、`docs/**/*.md`、`docs-lab/**/*.md` 的相对链接全量解析（不联网、不扩展为外链审计），修改后 0 断链。
  - `README.md:93` 原指向本地 `openspec/specs`、`openspec/changes`（第 4 节将删除的上游自身需求），已改为固定提交的 GitHub 链接：`.../tree/ea635dd255f8686dcf48626bbcbe0e3fd59b6067/openspec/{specs,changes}`，保留“真实示例”价值。
  - 清理已删 `docs-lab` 文件的内部引用：`docs-lab/start/overview.md` 删除指向 `Notes.md` 的句子、"README rules" 改为 "earlier authoring rules"；`guides/teams.md` 去掉 "in message-map.md"；`reference/skills.md` 去掉 "per sources.md"。
  - 保留业务示例与正文，无导航页需要删除；未新增 OMP 支持声明。`docs/supported-tools.md` 等仍描述上游全部工具，待第 5 节裁剪 `AI_TOOLS` 后同步（已记录于 A.5 文档行）。

## 4. 删除上游独立工程管理与测试材料

以下删除均限于裁剪根目录内部：

### 直接删除的目录

- [x] `test/`：上游 UT、集成测试、fixtures 和文档声明测试。
  - 已删除整个 `test/`：293 个文件、约 3.9 MB，含 `cli-e2e/`、`core/`（artifact-graph、command-generation、commands、completions、converters、parsers、shared、store、templates）、`fixtures/{released-output,tmp-init}`、`helpers/`、`prompts/`、`specs/`、`telemetry/`、`ui/`、`utils/`。
  - 依赖核对：`src/`、`bin/`、`build.js` 无任何指向 `test/` 的 import（`tsconfig.json` 本就把 `test` 列入 `exclude`）；`test/fixtures/released-output` 仅被测试读取，运行时代码使用的是 `src/core/shared/released-generated-fingerprints.ts` 内嵌指纹。
  - 连带待清理（第 4 节后续项）：`package.json` 的 `test*` 脚本与 vitest 依赖、`.gitattributes` 的 `test/fixtures/released-output/**` 规则、根 `vitest.config.ts`／`vitest.setup.ts`。
- [x] `openspec/`：上游自身需求规格、变更及归档、explorations、initiatives、work 和相关配置；不是 OMP 根目录的需求。
  - 已删除整个 `openspec/`：663 个文件、约 2.9 MB，含 `specs/`（上游自身能力规格）、`changes/`（`add-global-install-scope`、`add-tool-command-surface-capabilities`、`share-skills-in-agents-folder`、`simplify-skill-installation` 及 `archive/`）、`explorations/`、`initiatives/`、`work/`（含 `AGENTS.md`、`README.md`、`simplify-context-and-workspace-model`）与 `config.yaml`（schema: spec-driven 及上游项目上下文）。
  - 依赖核对：`src/`、`bin/`、`build.js` 无指向该目录的 import；运行时 `openspec/` 路径由 cwd／store 解析动态确定（`openspec-root.ts`、`root-selection.ts`），不读取 vendored 仓库自带的这份数据。
  - 区分：OMP 仓库根自身的 `openspec/` 未受影响（本步只作用于 vendor 资源根内部）。
- [x] `.github/`：上游 CI、Issue／PR 模板和维护配置。
  - 已删除整个 `.github/`：12 个文件，含 `CODEOWNERS`、`dependabot.yml`、`PULL_REQUEST_TEMPLATE.md`、`ISSUE_TEMPLATE/{bug_report,config,docs,feature_request}.yml`、`workflows/{README.md,binaries.yml,ci.yml,release-prepare.yml,security.yml}`。
  - 依赖核对：`src/` 中出现的 `.github/` 均为 OMP 用户项目内的目标路径（Copilot 集成、`--tools` 产物）或注释，不是对本仓库 `.github/` 的导入；`package.json` 无指向该目录的脚本。
  - 遗留注释（不阻塞）：`src/commands/feedback.ts:116` 注释说明其标题镜像已删的 `bug_report.yml`；`src/core/github-copilot/cloud-agent.ts`、`src/core/init.ts` 的 `.github/` 字样属用户项目产物路径，不是本地文件引用。
- [x] `.changeset/`：上游发布管理。
  - 已删除 `.changeset/config.json`、`.changeset/README.md`（2 个文件）。
  - 消费方核对：仅 `package.json` 的 `release:ci`／`changeset` 脚本与 `@changesets/*` devDependencies 使用；这些在“维护脚本与包配置”项一并清理，源码与构建入口不依赖。
- [x] `.devcontainer/`：上游开发容器。
  - 已删除 `.devcontainer/devcontainer.json`、`.devcontainer/README.md`（2 个文件）：TypeScript Node 22 镜像、VS Code 扩展、pnpm 安装命令与 SSH 挂载。
  - 依赖核对：`src/`、`build.js`、`bin/`、`package.json` 均无 devcontainer 引用；不影响 Node 构建入口。
- [x] `.agents/`：上游仓库开发用的 Agent 配置／技能副本；保留根 `skills/` 的产品资源。
  - 已删除 `.agents/` 8 个文件：`skills/{draft-openspec-docs,release-openspec,verify-openspec-docs,write-openspec-docs}/SKILL.md` 及 `release-openspec/{agents/openai.yaml,references/release-notes.md}`、`write-openspec-docs/{full-process.md,writing.md}`。
  - 保留核对：根 `skills/` 13 个文件（README + 12 个 `openspec-*` 产品 Skill）未受影响。文档中的 `.agents/skills/` 字样均为用户项目目标路径，不是对本地目录的引用；原先引用 `.agents/skills/write-openspec-docs/writing.md` 的 `docs-lab/README.md` 已在第 3 节删除。
- [x] `website/`：仅在第 3 节完成有用内容提取后删除。
  - 第 3 节已完成内容核对（无独有正文、37 个 `source` 全指向 `docs-lab/`）并删除整个目录 42 个文件；本步复核 `website/` 不存在，工作区无残留。

### 直接删除的根文件

- [x] `vitest.config.ts`、`vitest.setup.ts`、`eslint.config.js`：上游测试／lint 配置。
  - 已删除 3 个根文件（`vitest.config.ts` 2488 B、`vitest.setup.ts` 529 B、`eslint.config.js` 1339 B）。
  - 依赖核对：`build.js` 与 `src/` 无 vitest／eslint 引用；`tsc` 构建不读这些配置。`package.json` 的 `lint`／`test*` 脚本与相关 devDependencies 在后续“维护脚本与包配置”项清理。
- [x] `.actrc`、`.coderabbit.yaml`：CI 模拟和评审机器人配置。
  - 已删除 `.actrc`（48 B，act 容器镜像映射）、`.coderabbit.yaml`（281 B，评审机器人配置）。
  - 依赖核对：全树搜索无 coderabbit／`.actrc` 引用；与 Node 构建和 CLI 运行无关。
- [x] `flake.nix`、`flake.lock`：独立 Nix 环境，不属于现有 Node build 入口依赖。
  - 已删除 `flake.nix`（3940 B）、`flake.lock`（567 B）。
  - 依赖核对：`src/`、`build.js`、`bin/`、`package.json` 无 `flake` 引用；Node 构建链只依赖 `tsc`，Nix 环境不参与。
- [x] `AGENTS.md`、`CONTRIBUTING.md`、`MAINTAINERS.md`：复制来的上游开发规范及协作管理文件。
  - 已删除 `AGENTS.md`（0 B 空文件）、`CONTRIBUTING.md`（4268 B）、`MAINTAINERS.md`（687 B）。
  - 引用修复：`README.md` 的贡献流程与维护者段落原链接本地文件，已改为固定提交 `ea635dd…` 的上游 URL（`.../blob/ea635dd…/CONTRIBUTING.md`、`.../MAINTAINERS.md`）；其余文档无引用。
  - 复检：README／install／SECURITY／`docs/`／`docs-lab/` 的相对链接 0 断链。
- [x] `openspec-parallel-merge-plan.md`：上游内部研发计划。
  - 已删除 `openspec-parallel-merge-plan.md`（98 行，上游并行 delta 合并问题的内部整改计划）。
  - 依赖核对：全树无引用；属工程管理材料，不影响源码或构建。
- [x] `README_OLD.md`：核对有用内容已被当前文档覆盖后删除；若有独有且仍适用的说明，先合入对应主题文档，不保留整份旧入口。
  - 内容比对：`README_OLD.md` 475 行对应 1.x 流程（`openspec/project.md`、`/openspec:proposal` 等旧命令），当前版本已改为 `config.yaml` 上下文与 Skill 工作流。逐节核对后，仍适用的主题均已被现有文档覆盖：支持工具 → `docs/supported-tools.md`；安装与初始化 → `docs/installation.md`、`docs/getting-started.md`；命令参考 → `docs/commands.md`、`docs/cli.md`；delta 格式与示例 → `docs/writing-specs.md`、`docs/examples.md`；团队采用 → `docs/team-workflow.md`；OPSX 实验特性与动机 → `docs/opsx.md`；遥测 → 当前 `README.md` 的 Usage Notes。
  - 结论：无独有且仍适用的说明需要合入，删除 `README_OLD.md`（475 行）。
  - 连带资产：`assets/openspec_pixel_dark.svg`、`assets/openspec_pixel_light.svg` 仅被 `README_OLD.md` 引用，随之一并删除；`assets/` 由 4 个文件降为 2 个（`openspec_bg.png`、`openspec_dashboard.png`，均被 `README.md` 引用）。
  - 复检：README／install／SECURITY／`docs/`／`docs-lab/` 相对链接 0 断链，README 的图片引用均存在。

### 维护脚本与包配置

- [x] 删除 `scripts/` 中上游独立发布、二进制安装器、安装 smoke／E2E、指纹再生成、Nix 更新及仅供网站／外部技能平台分发的脚本；保留的业务源码和 build 不能再导入它们。当前 `build.js` 是根文件，不在本项删除范围。
  - 已删除整个 `scripts/`（15 个文件）：`README.md`；`binary/{build.mjs,entry.mjs,install.sh,install.ps1,install-check.sh,smoke.sh,e2e.sh}`；`capture-released-fingerprints.mjs`、`generate-skillssh.mjs`、`pack-version-check.mjs`、`parity-hash-shared.mjs`、`regen-parity-hashes.mjs`、`skillssh-shared.mjs`、`update-flake.sh`。
  - 依赖核对：`src/` 无 import 这些模块；仅 `src/commands/install-standalone.ts:21` 以字符串形式引用 `scripts/binary` 的远程下载 URL（该文件将在 5.3 删除），`released-generated-fingerprints.ts` 仅注释提及生成脚本，数据本身保留。`build.js` 为根文件、只调 `tsc`，未受影响。
  - 待清理消费方：`package.json` 的 `generate:skills`／`regen:parity-hashes`／`check:pack-version`／`release:ci` 脚本（下一项处理）；`.github/` 工作流引用已随目录删除失效。
- [x] 核对 `scripts/generate-skillssh.mjs` 等维护脚本不属于产品运行依赖后，删除；保留现成 `skills/` 及运行源码中的模板／指纹，不为删脚本而删对应业务数据。
  - 运行依赖核对：`src/` 中仅 `skill-generation.ts:47`、`command-references.ts:137` 的注释提到 skills.sh 分发，无 import 或读取已删脚本；运行时代码不执行这些 `.mjs`。
  - 业务数据保留：根 `skills/` 13 个文件（README + 12 个 `openspec-*`）完整；生成源 `src/core/templates/workflows/`（19 个文件，含 apply-change、archive-change、onboard 等）完整；`src/core/shared/released-generated-fingerprints.ts`（114958 B）指纹数据完整。
  - 结论：维护脚本已随 `scripts/` 删除，产品运行所需的 Skill 文件、模板与指纹均保留，未因删脚本删数据。
- [x] 删除完成后，清理 package.json 中指向已删除材料的 test／lint／release／changeset／资源维护脚本，保留 build、prepare 和仍有效的开发入口。不得保留确定失效的脚本并宣称本副本构建完整。
  - 已移除 11 个失效脚本：`lint`（eslint 配置已删）、`generate:skills`、`regen:parity-hashes`、`test`、`test:watch`、`test:ui`、`test:coverage`、`check:pack-version`、`release`、`release:ci`、`changeset`。
  - 保留 5 个仍有效入口：`build`（`node build.js`）、`dev`（`tsc --watch`）、`dev:cli`（`pnpm build && node bin/openspec.js`）、`prepare`（`node build.js`）、`prepublishOnly`（`pnpm run build`）；均只依赖 `build.js`／`bin/openspec.js`／`typescript`。
  - 复检：`package.json` 仍为合法 JSON，`name`／`version` 可读（CLI 版本消费者不受影响）。devDependencies 清理见下一项。
- [x] 删除只服务已移除测试／发布／lint 的 devDependencies；保留 TypeScript、实际构建所需类型及仍被保留脚本使用的依赖。以真实使用关系判断，不直接清空 devDependencies。
  - 已移除 8 个：`@changesets/changelog-github`、`@changesets/cli`（release／changeset 已删）、`@vitest/ui`、`vitest`、`vite`（测试已删）、`eslint`、`typescript-eslint`（lint 配置已删）、`smol-toml`（全树无 import，仅旧维护脚本使用）。
  - 保留 3 个：`typescript`（`build.js` 直接调用 `typescript/bin/tsc`）、`@types/node`、`@types/picomatch`（`src/core/artifact-graph/outputs.ts` 使用 `picomatch`，构建需其类型）。
  - 运行依赖 `dependencies` 未改动（zod、yaml、commander、picomatch 等仍被 `src/` 使用）。锁文件同步见下一项。
- [x] 使用来源声明的包管理器更新锁文件，保留仍有效的安全 overrides，不升级无关依赖、不手改锁文件。同步去掉仅为已移除依赖服务且已无用途的配置。
  - 使用 `pnpm@10.34.5`（`packageManager` 声明）执行 `pnpm install --lockfile-only --ignore-scripts` 更新锁文件；未手改。
  - 结果：`pnpm-lock.yaml` 由 88647 B／约 2600 行降为 21930 B／679 行；diff 为 2000 行删除、0 行新增，说明只移除已删 devDependencies 的传递树，未升级或改动任何保留依赖的版本（如 commander 14.0.3、yaml 2.9.1、zod 4.6.7、typescript 6.0.3 保持不变）。
  - overrides 保留：`brace-expansion`、`postcss`、`js-yaml`×2、`nanoid`、`fflate`、`shell-quote`、`launch-editor`、`minimatch` 共 9 条与 `pnpm-workspace.yaml` 一致。
  - 无用途配置清理：`package.json` 的 `files` 去掉 `!dist/**/*.test.js`、`!dist/**/__tests__`（测试已删），保留 `dist`、`bin`、`schemas`、`!dist/**/*.map`；`.gitattributes` 删除已失效的 `test/fixtures/released-output/**` 两条规则，保留 `skills/** text eol=lf` 与指纹文件的 `linguist-generated`，并更新注释去除已删 parity 测试引用。`publishConfig`、`packageManager`、`engines`、`bin` 保持有效。

## 5. 删除其他 Agent 专用适配与安装能力

这一步涉及源码依赖，必须先改调用方和注册项再删文件；不能直接删除整个 `command-generation/`、`shared/`、`init.ts` 或 `update.ts`。

### 5.1 支持范围

- [x] 外部工具目标仅保留上游已有 `oh-my-pi`。`pi`、`zcode` 是独立目标，不因名称与当前宿主有关就保留。通用共享 Skill 协议／格式保留，但不以通用目标为借口继续支持其他 Agent 安装。
  - 支持范围实测：`AI_TOOLS` 现有 49 个条目（含 `oh-my-pi`、`pi`、`zcode` 与通用目标 `agents`），`command-generation/adapters/` 有 34 个 `toolId`，`TOOL_ID_ALIASES` 有 `windsurf→devin`，`RETIRED_TOOLS` 有 `amazon-q`。
  - 保留目标唯一为 `oh-my-pi`：沿用上游现有 `AI_TOOLS` 条目（`skillsDir: '.omp'`）、`adapters/oh-my-pi.ts` 与其命令注册，不新增 OMP 启动器、PATH 注入、TUI 适配或兼容层。
  - 待删除目标：其余 48 个 `AI_TOOLS` 条目（包括独立的 `pi`、`zcode`，以及通用 `agents`）、33 个非 `oh-my-pi` adapter、`windsurf` 别名、`amazon-q` 退役条目及其专用清理分支。
  - 通用共享 Skill 协议／格式保留：`skills/` 下 SKILL.md、模板生成、frontmatter、路径安全检查等与具体目标无关的能力不删；`agents` 作为“可安装目标”不保留，共享目录逻辑仅在 OMP 自身仍需要时保留。
  - 该决定在 5.2 各项落到调用链：先清点引用再改注册／导出，最后删 adapter 文件，不静默把未知目标映射为 OMP。
- [x] 保留 OpenSpec 自身的项目初始化、配置、需求操作和 Skill 材料更新；删除的是其他 Agent 的发现、安装、链接、配置改写及专用服务，不是全部 init/update 业务。
  - 保留的业务模块：`src/core/init.ts`（1452 行，init 编排、选择器、配置写入、Skill 生成、legacy 清理）、`src/core/update.ts`（1710 行，刷新、profile 同步、Skill 安装、dry-run 计划）、`project-config.ts`（692 行）、`global-config.ts`（281 行）、`available-tools.ts`、`shared/{skill-generation,own-skill-texts,skill-content-equivalence,command-reconcile}.ts`、`migration.ts`、`update-plan.ts`，以及需求操作 `src/commands/*` 与 `src/core/{list,view,archive,specs-apply,validation,artifact-graph}`。
  - 仅删除其他 Agent 专属部分：`AI_TOOLS` 其余目标、`command-generation/adapters/*`、`SKILL_LINKED_TOOL_IDS` 的链接安装（claude/continue/…/hermes 共 14 个）、`globalSkillsDir`（minimax 的 HOME 写入）、各目标的 `detectionPaths` 探测、`TOOL_ID_ALIASES`／`RETIRED_TOOLS`（amazon-q）、Copilot 云 Agent。
  - 边界确认：`oh-my-pi` 走 `usesSharedSkills()` → 项目 Skill 写入共享 `.agents/skills/`，且不在 `SKILL_LINKED_TOOL_IDS`，因此“共享目录 + 路径安全”逻辑必须保留；其 `skillsDir: '.omp'` 与上游条目原样沿用。技能材料生成（模板、frontmatter、own-skill 文本、指纹判定）与 init/update 编排均不因删目标而删除。
- [x] 不增加新的 OMP 启动器、PATH 注入、TUI 适配或兼容层；保留下来的 OMP 目标仅沿用上游现有实现。
  - 现有 OMP 实现即上游自带的：`adapters/oh-my-pi.ts`（`.omp/commands/opsx-<id>.md` + description frontmatter + `$@` 注入）与 `AI_TOOLS` 中的 `oh-my-pi` 条目（`skillsDir: '.omp'`）；未新增任何文件或代码。
  - 全树核对：无 OMP 专用启动脚本（`bin/` 仅 `openspec.js`）、无 OMP PATH 注入、无 TUI 适配或兼容层；搜索 `oh-my-pi`／`.omp` 仅命中 adapter、注册、`config.ts` 条目与指纹数据中的历史产物路径。
  - shell completion 的 `.bashrc`／`.zshrc` 写入属 OpenSpec 自身补全功能（5.3 明确不顺带删除），不是 OMP 启动器或 PATH 注入，本步不动。

### 5.2 配置、注册及导出联动清理

- [x] 在 `src/core/config.ts` 裁掉非 `oh-my-pi` 的 `AI_TOOLS` 条目，以及只服务被删除目标的别名、退役目标、专用链接集合、提示及字段消费者。先清点实际引用，不盲删共享接口。
  - `AI_TOOLS`：49 → 1，仅保留 `{ name: 'Oh My Pi', value: 'oh-my-pi', available: true, skillsDir: '.omp' }`。
  - 删除只服务被删目标的 API：`UNIVERSAL_TOOL_ID`／`getUniversalTool`／`universalToolFallbackHint`、`TOOL_ID_ALIASES`／`resolveToolIdAlias`、`RetiredTool`／`RETIRED_TOOLS`／`findRetiredTool`／`formatRetiredToolError`；`SKILL_LINKED_TOOL_IDS` 保留为空集合（共享路径逻辑仍引用）。
  - 消费者联动：`init.ts` 移除 universal 提示、alias 归一化、retired 报错与 retired 清理循环、linked-from 提示；`update.ts` 移除 retired 清理步骤；`legacy-cleanup.ts` 去掉 retired 过滤；`cli/index.ts` 移除 alias 帮助文本。
  - 因已无退役目标，`src/core/retired-tools.ts`（原 109 行）整体删除，避免留下空实现；A.5 中该项由“修改”调整为“删除”，第 5.2 节清理链条目执行时复核。
  - 共享接口保留：`AIToolOption` 字段、`OPENSPEC_SKILL_NAMES`、`OPENSPEC_MARKERS`、`usesSharedSkills`/`SKILL_LINKED_TOOL_IDS` 等仍被 OMP 路径使用，不做无依据删除。
- [x] 清理 `src/core/command-generation/registry.ts` 中其他 Agent adapter 的 imports 和注册；同步清理 `adapters/index.ts` 的导出，再删除对应 adapter 文件，仅保留 `oh-my-pi.ts` 及其仍需的公共基础模块。
  - `registry.ts`：34 个 import／register → 仅 `ohMyPiAdapter`；注释改为“vendored copy ships only the host's adapter”。
  - `adapters/index.ts`：仅导出 `ohMyPiAdapter`；`command-generation/index.ts` 的 `claudeAdapter, cursorAdapter, devinAdapter` 导出改为 `ohMyPiAdapter`。
  - 已删除 33 个 adapter 文件（`amazon-q`、`antigravity`、`atomcode`、`auggie`、`bob`、`claude`、`cline`、`codeassistant`、`codebuddy`、`codestudio`、`command-code`、`continue`、`costrict`、`crush`、`cursor`、`devin`、`easycode`、`factory`、`gemini`、`gigacode`、`github-copilot`、`iflow`、`junie`、`kilocode`、`kiro`、`lingma`、`opencode`、`pi`、`qoder`、`qwen`、`roocode`、`trae`、`zcode`）；`adapters/` 只剩 `index.ts`、`oh-my-pi.ts`。
  - 静态核对：全树无对已删 adapter 的 import／导出引用；`generator.ts`、`invocation.ts`、`types.ts` 等公共基础模块未改动。
- [x] 同步 CLI 的 tools 参数帮助、校验、可选项及初始化选择器，不再列出或接受被删除的其他 Agent。未知目标应沿用明确错误处理，不静默映射为 OMP。
  - 帮助文本由 `AI_TOOLS` 派生（`availableToolIds = AI_TOOLS.filter(skillsDir || globalSkillsDir).map(value)`），裁剪后自动只剩 `oh-my-pi`；`init` 与 `update --tool` 共用同一 `tools` 值。
  - 校验：`resolveToolsArg` 用 `getToolsWithSkillsDir()` 构造 `availableSet`，未知 token 进入 `invalidTokens` 并抛出 `Invalid tool(s): … Available values: all, none, oh-my-pi`；不静默映射为 OMP。`all` 现在只返回 `oh-my-pi`，`none` 仍为空。
  - 初始化选择器：`validTools` 仅 1 项，searchable multi-select 仍要求至少选择 1 项；通用目标提示已随 config 清理移除。
  - 无新增代码：本项由 `config.ts` 的 `AI_TOOLS` 裁剪自动生效；`--copilot-cloud` 选项属 Copilot 集成，留待“检查 `github-copilot/`”项处理。
- [x] 检查 `available-tools.ts`、`shared/skill-paths.ts`、`shared/tool-detection.ts`、`shared-skill-target.ts`、`shared/shared-skill-install.ts`、`shared/skill-links.ts` 的调用链，删除非 OMP 专属的探测／全局 HOME 写入／软链接安装分支和失效 import；共享路径安全及 OMP 仍使用的逻辑保留。
  - `available-tools.ts`：删除 `detectionPaths` 探测与 `globalSkillsDir` HOME 扫描，OMP 只按自身 `.omp` 目录或被 `.openspec-target` 列出判定。
  - `skill-paths.ts`：删除 `hasGlobalSkillTarget`、`resolveToolSkillsDir` 的 HOME 分支、`resolveSkillLinkDir` 与 `SKILL_LINKED_TOOL_IDS` 依赖；`SkillCapableTool` 仅要求 `skillsDir`。
  - `tool-detection.ts`：删除 `hasSkillLinks` 及 `isListedToolPresent` 的链接目录判定，保留命令/列表与共享目录检查。
  - `shared-skill-install.ts`：删除链接创建（`ops.linkSkill`）与“linksWanted”分支，旧自有目录清理只保留：缺失跳过、用户文件保留、非链接的旧副本/发行副本删除；`ownSkillFolderNeedsWork` 同样只判断旧副本。
  - `skill-links.ts`：删除 `skillLinkText`、`createSkillLink`、`isSymlink`，保留链接分类（`classifySkillLinkSpot` 等）与用户链接保护，OMP 旧 `.omp/skills` 迁移仍需判断链接归属。
  - `update-plan.ts`：移除 `linkSkill` ops 与计划内链接记录；dry-run 仍按真实写入/删除/移动生成计划。
  - `config.ts`：删除 `globalSkillsDir`、`detectionPaths` 字段；`init.ts`/`update.ts`/`migration.ts`/`released-output-sweep.ts`/`cli/index.ts` 的对应全局路径分支同步移除。
  - 保留：`legacySkillsDirs`（OMP 旧自有目录迁移检查仍读取）、`searchAliases`/`setupNote`/`requiresIdeRestart` 字段（当前唯一目标不赋值，属通用展示能力，不属其他 Agent 安装）。共享路径安全 `assertPathWithin`、链接分类与用户文件保护全部保留。
  - 静态核对：全树无 `resolveSkillLinkDir`／`SKILL_LINKED_TOOL_IDS`／`hasSkillLinks`／`hasGlobalSkillTarget`／`linkSkill` 引用；相对 import 全部可解析。
- [x] 检查 `retired-tools.ts`、`legacy-cleanup.ts`、`released-output-sweep.ts` 等清理链，不再遍历、迁移或删除其他 Agent 的用户目录。保留 OMP 自身旧输出识别及通用防误删检查；历史指纹数据只有在明确无消费者后才删除。
  - `retired-tools.ts`：已在前项整体删除（无退役目标）。
  - `legacy-cleanup.ts`：`LEGACY_SLASH_COMMAND_PATHS` 与 `LEGACY_GLOBAL_SLASH_COMMAND_PATHS` 置空，不再扫描 claude/cursor/codex/kilo 等其他 Agent 的命令目录或全局 prompt 目录；删除仅服务于这些条目的常量（`LEGACY_DIRECTORY_COMMAND_FILES`、`LEGACY_THREE_COMMAND_NAMES`、`LEGACY_KILOCODE_COMMAND_FILES`、`LEGACY_GLOBAL_CODEX_WORKFLOWS`、`getCodexPromptDir`）及失效 import。`LEGACY_CONFIG_FILES` 保留（8 个根文件名，仅删除带 OpenSpec marker 或已发布指纹的块，属防误删检查，§2 已说明为被管理产物清单数据）。
  - `migration.ts`：`LEGACY_TOOL_ROOTS` 置空，不再迁移 `.kimi`／`.windsurf`／`.codex`／`.agent` 等他人目录；迁移实现与 `needsConsent` 检查保留。
  - `released-output-sweep.ts`：所有路径推导均以 `AI_TOOLS`（现仅 `oh-my-pi`）为入口，`formerRoots` 为空，不再枚举其他工具目录；指纹判定与 `currentGeneratablePaths` 防误删逻辑保留。
  - 历史指纹保留：`released-generated-fingerprints.ts` 仍有 7 个消费者（`legacy-cleanup`、`released-output-sweep`、`shared-skill-target`、`shared/command-reconcile`、`generated-fingerprint`、`skill-content-equivalence`、`skill-links`），非零引用，故不删除。
- [x] 检查 `src/core/github-copilot/` 的实际入口；删除 Copilot 专用云 Agent 集成及全部注册、导出和调用，不替换为空实现。
  - 入口：`src/core/github-copilot/cloud-agent.ts` 被 `init.ts`（8 个符号）与 `update.ts`（7 个符号）引用，另有 CLI `--copilot-cloud`／`--no-copilot-cloud` 与 shell completion 条目。
  - 已整体删除 `src/core/github-copilot/`（`cloud-agent.ts`），并移除全部调用：`init.ts` 的决定/持久化/清理/报告与 `writeCopilotCloud` 参数；`update.ts` 的 `syncCopilotCloudFiles` 及三处调用、`CopilotCloudFileOps`；`project-config.ts` 的 `githubCopilot.cloudAgent` schema 与解析；`cli/index.ts` 的两个选项、选项类型与传参；`core/completions/command-registry.ts` 的两个补全条目。
  - 静态核对：`src/` 内已无 `copilot` 代码引用（仅 `command-generation/invocation.ts` 的历史注释以其他工具举例）；未以空文件、no-op 或兼容别名替代。
  - 遗留：`docs/customization.md`、`docs/supported-tools.md` 仍有 `githubCopilot.cloudAgent` 说明，按 A.5 文档行在第 6 节前同步。
- [x] 搜索其他 Agent 名称时区分代码分支、示例、字符串指纹和普通业务文本；不得全局替换模型／工具名称或删除通用提示词。
  - 代码分支清理：`command-surface.ts` 的 `codex`/`warp` 特判；`shared-skill-target.ts` 的 `$openspec-`→codex 推断（改为通用 `/openspec-`→`oh-my-pi`）；`utils/command-references.ts` 的 `SKILL_INVOCATION_PREFIX`（kimi/codex）、`NATURAL_LANGUAGE_SKILL_TOOLS` 与 codex 专用 transformer；`init.ts` 的 codex 首轮提示；`update.ts` 的 codex workflow 推断/覆盖；`migration.ts` 的 devin/windsurf 专用提示。全树已无 `'codex'` 等目标 id 分支。
  - 保留的普通业务文本：`openers.ts` 的编辑器/终端启动器（VS Code、Cursor、Claude Code、codex）是 `workset open` 的用户功能，不是 Agent 安装能力；`command-generation/{index,types,invocation}.ts`、`migration.ts` 的注释示例；`onboarding-commands.ts`/templates 中的 `continue` 等是工作流 id，不是 Agent 名。
  - 保留的数据：`released-generated-fingerprints.ts` 中的历史产物路径（含其他 Agent 目录）是防误删白名单，不按名称删除。
  - 文档：`docs/`、`docs-lab/` 中的其他 Agent 用法按第 3 节结论保留；已移除功能的描述（`githubCopilot.cloudAgent`、多目标支持矩阵）仍待同步，避免文档宣称已删除能力。
  - 未做全局替换：模型/工具通用名称与提示词未改动。

### 5.3 独立安装与分发

- [x] 删除 OpenSpec 独立发行安装能力：在 `src/cli/index.ts` 取消 `install [version]` 命令注册，再删除 `src/commands/install-standalone.ts` 及无消费者的专用辅助代码。
  - `src/cli/index.ts`：删除 `install [version]` 命令块（含 `installStandalone` 动态 import）。
  - 删除 `src/commands/install-standalone.ts`（原约 190 行；导出 `InstallTarget`、`resolveInstallTarget`、`removeCommandFor`、`checkSource`、`installerBase`、`installStandalone`，无其他消费者）。
  - `core/completions/command-registry.ts`：删除顶层 `install` 命令的补全条目；`completion install [shell]` 子命令条目保留（shell completion 功能，非独立安装）。
  - 当时保留：`version-check.ts` 的 `getCliInstallInfo`／`getStandaloneBinaryPath` 与 `utils/executable-path.ts` 仍被 `version` 命令、`standalone-tip.ts` 使用；下一项确认 standalone 提示为唯一消费者后一并删除。
  - 待下一项：版本提示与帮助中的 `openspec install` 文案。
- [x] 核对版本提示、首次运行提示、帮助中对独立安装命令的引用并去掉失效入口；保留必要版本读取，不顺带重写版本查询或其他联网政策。
  - 首次运行提示：删除 `src/core/standalone-tip.ts`（`STANDALONE_TIP_MESSAGE`／`maybeShowStandaloneTip`）及 `src/cli/index.ts` update 命令末尾的调用块；同步删除 `global-config.ts` 的 `standaloneTipSeen` 字段与 `config-schema.ts` 的 schema 项。
  - 版本提示：`version-check.ts` 删除 `standaloneBinaryPath` 状态、`markStandaloneBinary`／`getStandaloneBinaryPath`、`standaloneUpgradeCommand`（`openspec install`／`<path> install` 文案）、`fetchLatestStandaloneRelease` 与 `RELEASES_URL`，以及 `checkForCliUpdate`／`getInstallDir`／`getCliInstallInfo`／`getCliUpdateCommand`／`buildUpgradeCommandLines` 中的 standalone 分支和 `InstallScope` 的 `'standalone'`。npm registry 查询、opt-out、超时与响应校验未改。
  - 帮助：顶层 `install [version]` 已无注册与补全条目，`openspec --help` 不再出现；`completion install [shell]` 保留。
  - 无消费者辅助代码：`utils/executable-path.ts`（`findCopiesOnPath`／`samePath`）仅服务已删的 standalone 升级命令，整体删除；`version-check.ts` 对应 import 移除。
  - 文档同步失效安装说明：`README.md` 更新段去掉 standalone 句子；`install.md` 去掉 standalone 安装优先流程与安装器命令，改为包管理器安装（步骤重排 1–4）；`docs/installation.md` 顶部安装段落改为指向 Package Managers、删除“Switch from npm to the standalone install”整节与 uninstall 的 binary-schemas 说明、AI 提示词去掉 standalone 分支；`docs/troubleshooting.md` 删除 standalone binary 建议。
  - 静态核对：`src/` 已无 `standaloneTipSeen`／`standalone-tip`／`executable-path`／standalone 升级符号引用；剩余 `standalone` 字样均为 store（独立仓库）或注释语义，与安装能力无关。未运行构建（该副本无 `node_modules`／`dist`）。
- [x] 删除其他 Agent 的安装流程和上游独立二进制发行脚本，不删除 `bin/openspec.js` 或用于 OMP 集成的源码入口。
  - 其他 Agent 安装流程已无残留：`AI_TOOLS` 仅 `oh-my-pi`；`command-generation/adapters/` 仅 `index.ts`、`oh-my-pi.ts`；`available-tools.ts`／`shared/*` 不再探测其他目标或创建链接；`--tools` 校验只接受 `oh-my-pi`／`all`／`none`。
  - 二进制发行脚本：`scripts/` 已整目录删除（含 `binary/{build.mjs,entry.mjs,install.sh,install.ps1,install-check.sh,smoke.sh,e2e.sh}`）；根目录仅剩 `build.js`（`tsc` 构建）；`.github/workflows/binaries.yml` 已随 `.github/` 删除；`package.json` 无发布／打包脚本，`files` 仅 `dist`、`bin`、`schemas`。
  - `bin/openspec.js` 保留且未改动：shebang + `import { runCli } from '../dist/cli/index.js'` + `runCli()`；`package.json` 的 `bin.openspec` 与 `dev:cli` 仍指向它，属 OMP 集成所需 CLI 入口。
  - OMP 集成源码入口保留：`src/cli/index.ts` 的 `runCli`、`src/core/init.ts`／`update.ts`、`src/core/command-generation/`（仅 OMP adapter）与 `src/core/config.ts` 的唯一 `oh-my-pi` 目标。
  - 剩余“install”文件均为保留功能：`src/core/completions/installers/*`（shell completion）、`src/core/shared/shared-skill-install.ts`（OMP 共享 Skill 安装）、`released-output-sweep.ts`／`released-generated-fingerprints.ts`（旧产物清理）。
  - 文档中的独立二进制安装命令已移除：`README.md`（Quick Start 改 npm/Homebrew）、`docs/README.md`、`docs/getting-started.md`、`docs/installation.md`（Uninstalling）、`docs-lab/start/installation.md`（删除 Install options／Download by hand／Verify a download／standalone switch 节）、`docs-lab/help/upgrade-to-2.md`、`docs-lab/reference/cli.md`（删除 `openspec install` 条目与节、standalone 版本/更新说明）。剩余 `standalone` 均为 store（独立仓库）或 sync 语义。
  - 未运行构建（该副本无 `node_modules`／`dist`）。
- [x] shell completion 不是其他 Agent 安装功能，本轮不顺带删除；其他不属于上述范围的业务也不因“安装”关键词被误删。
  - 保留完整：`src/commands/completion.ts`；`src/core/completions/`（`command-registry.ts`、`completion-provider.ts`、`factory.ts`、`shared-flags.ts`、`types.ts`、`generators/`、`templates/`、`installers/{bash,fish,powershell,zsh}-installer.ts`、`installers/shell-quote.ts`）；`src/core/completion-tip.ts`。
  - CLI 注册未动：`completion generate [shell]`、`completion install [shell] --verbose`、`completion uninstall [shell] -y,--yes` 与隐藏 `__complete <type>` 均在 `src/cli/index.ts`；仅删除了已不存在的顶层 `install [version]` 注册与其在 `command-registry.ts` 的顶层条目。
  - 补全命令表中的 `install` 条目现仅剩 `completion install` 子命令（L632 附近）及 `uninstall`，属 shell completion 自身。
  - 消费者核对：`context.ts`、`doctor.ts`、`store.ts`、`workset.ts`、`completion-tip.ts` 仍引用 `completions/`；相对 import 全树可解析（唯一疑似为 `command-generation/index.ts` 文档注释中的示例路径，非实际 import）。
  - 未按“安装”关键词误删：剩余的 `installers/` 是 shell 补全安装器；`shared-skill-install.ts` 是 OMP 共享 Skill 安装；`released-output-sweep.ts`／指纹文件是旧产物清理。三者均保留并通过静态引用检查。
  - 未运行构建（副本无 `node_modules`／`dist`）。

## 6. 最小必要验证

- [x] 将路径／内容变化与清单比对：管理／测试目录已删除，业务文档、图片引用、Skill、schema、许可证和构建入口仍在。
  - 对照面：仓库外完整备份 `F:\code2026\_backup\openspec-vendor-preTrim-ea635dd-20261114`（1378 个文件）；逐文件 `rglob` 比对。
  - 结果：当前 282 个文件；删除 1096、修改 50、新增 0。无残留空目录。
  - 删除分类全部可归属：A.1 目录 1022（`test/` 293、`openspec/` 663、`.github/` 12、`.changeset/` 2、`.devcontainer/` 2、`.agents/` 8、`website/` 42）；A.2 根文件 12；A.3 `scripts/` 15；A.4 adapter／集成 35；另加已执行的 docs-lab 工程材料 7、失去引用的 assets 2（`openspec_pixel_*.svg`）、无消费者源码 3（`retired-tools.ts`、`standalone-tip.ts`、`utils/executable-path.ts`）。
  - 计划删除项逐一复核：A.2 的 12 个根文件、A.3 的 15 个脚本、A.4 的 `cloud-agent.ts`／`install-standalone.ts` 均不存在；`command-generation/adapters/` 仅 `index.ts`、`oh-my-pi.ts`；`src/core/github-copilot/` 不存在。
  - 管理／测试目录：`test/`、`openspec/`、`.github/`、`.changeset/`、`.devcontainer/`、`.agents/`、`website/`、`scripts/` 全部不存在。
  - 业务保留：`docs/` 27、`docs-lab/` 36、`skills/` 13、`schemas/` 5、`assets/` 2、`bin/` 1、`src/` 186。关键入口存在：`README.md`、`CHANGELOG.md`、`SECURITY.md`、`LICENSE`、`bin/openspec.js`、`build.js`、`tsconfig.json`、`package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`、`.gitattributes`、`.gitignore`、`docs/README.md`、`docs/getting-started.md`、`docs/supported-tools.md`、`docs/workflows.md`、`assets/openspec_bg.png`、`assets/openspec_dashboard.png`、`skills/README.md`、`schemas/spec-driven/schema.yaml`。
  - 50 个修改文件均属既定动作：21 个文档（原 12 个 + 7.1 支持矩阵同步新增 9 个）（§3 链接清理 3：`docs-lab/{guides/teams,reference/skills,start/overview}.md`；§4 `README.md`；§5.3 安装说明 8：`docs/{README,getting-started,installation,troubleshooting}.md`、`docs-lab/{help/upgrade-to-2,reference/cli,start/installation}.md`、`install.md`）；3 个包／仓库配置（`package.json`、`pnpm-lock.yaml`、`.gitattributes`）；26 个源码（A.5 目标 14 + 连锁裁剪 12：`config-schema`、`global-config`、`version-check`、`completions/command-registry`、`command-generation/index`、`command-surface`、`migration`、`profile-sync-drift`、`shared/index`、`utils/command-references`、`project-config`、`update-plan`）。
  - `docs/supported-tools.md` 文件仍在且本步未改；其内容同步（移除已删目标／`githubCopilot.cloudAgent`）仍按既有记录留待 A.5 文档行，不在本项宣称完成。
- [x] 对不在修改清单中的保留业务文件核对摘要，确认未附带改写；有意裁剪过的源码、包配置、锁文件及调整过的文档逐项说明，不能再要求它们与原版逐字相同。
  - 对照文件：`F:\code2026\_backup\openspec-vendor-retained-sha256-ea635dd.txt`（294 条 `sha256<TAB>相对路径`，文件自身 sha256 `606631d7…`）。
  - 路径核对：当前 282 个文件全部存在于清单，无清单外新增；清单中 12 条现缺失，均为已记录的后续有意删除：`docs-lab/` 工程材料 7（`README.md`、`Notes.md`、`sources.md`、`message-map.md`、`reference/architecture/{index,workflow-runs,design-decisions}.md`）、只剩 `README_OLD.md` 引用的 `assets/openspec_pixel_{dark,light}.svg` 2、无消费者源码 3（`src/core/retired-tools.ts`、`src/core/standalone-tip.ts`、`src/utils/executable-path.ts`）。
  - 摘要核对：232 个文件 sha256 与清单逐字节一致，全部属于“不在 50 个修改集内”的保留业务文件；未发现附带改写、换行或编码漂移（比对按原始字节）。
  - 50 个有意修改项逐类说明（原 41 项见上；新增 9 个支持矩阵／FAQ 文档由 7.1 说明）：
    - A.5 计划内源码 14：`config.ts`（AI_TOOLS→1）、`available-tools.ts`（删探测）、`command-generation/{adapters/index,registry}.ts`（仅 OMP）、`shared/{skill-paths,tool-detection,shared-skill-install,skill-links,shared-skill-target}.ts`（删链接／全局分支）、`legacy-cleanup.ts`／`released-output-sweep.ts`（清空其他 Agent 路径遍历，保留防误删）、`init.ts`／`update.ts`（移除 Copilot／退役／链接逻辑）、`cli/index.ts`（删 `install` 命令）。
    - 连锁裁剪源码 12：`project-config.ts`／`config-schema.ts`／`global-config.ts`（删 `githubCopilot.cloudAgent`、`standaloneTipSeen`）、`version-check.ts`（删 standalone 状态与更新命令）、`completions/command-registry.ts`（删顶层 install 条目）、`command-generation/index.ts`（导出 OMP adapter）、`command-surface.ts`（删 codex/warp 特判）、`migration.ts`（清空 `LEGACY_TOOL_ROOTS`、删 devin 文案）、`profile-sync-drift.ts`／`update-plan.ts`／`shared/index.ts`（删链接参数与导出）、`utils/command-references.ts`（删其他工具前缀／自然语言推断）。
    - 包／仓库配置 3：`package.json`（删测试／发布／lint 脚本与 devDependencies、files 清理）、`pnpm-lock.yaml`（pnpm 重新生成，仅删已移除依赖树）、`.gitattributes`（删已失效 test 规则）。
    - 文档 12：§3 死链清理 3（`docs-lab/{guides/teams,reference/skills,start/overview}.md`）、§4 `README.md`（上游贡献／维护链接改固定提交）、§5.3 安装说明 8（`docs/{README,getting-started,installation,troubleshooting}.md`、`docs-lab/{help/upgrade-to-2,reference/cli,start/installation}.md`、`install.md`），均为删除独立安装／其他目标说明或失效链接，不改 OpenSpec 业务语义。
  - 结论：保留文件除上述 41 项外摘要一致；修改均对应已执行章节，无计划外改写。
- [x] 完成静态导入、导出及 CLI 注册引用核对，无指向已删 adapter、Copilot 或 standalone installer 的调用；不得用空文件、no-op 或兼容别名掩盖悬空引用。
  - 已删模块引用：全树搜索 `github-copilot`、`install-standalone`、`retired-tools`、`standalone-tip`、`executable-path`、`adapters/<已删 33 个>`，`src/` 内 0 命中。
  - 已删符号引用：`claudeAdapter`／`cursorAdapter`／`devinAdapter`、`markStandaloneBinary`／`getStandaloneBinaryPath`／`maybeShowStandaloneTip`、`syncCopilotCloudFiles`／`CopilotCloudFileOps`、`installStandalone`／`resolveInstallTarget`／`findCopiesOnPath`、`hasGlobalSkillTarget`／`resolveSkillLinkDir`／`hasSkillLinks`／`linkSkill` 全部 0 命中。
  - 相对及动态 import：`src/**/*.ts` 的 `from './…'` 与 `import('./…')` 逐条解析，目标均存在（唯一疑似为 `command-generation/index.ts` 的文档注释示例，非 import）。
  - 导出面：`adapters/index.ts` 仅 `ohMyPiAdapter`；`command-generation/index.ts` 仅 `ohMyPiAdapter`；`registry.ts` 仅注册 `ohMyPiAdapter`；`shared/index.ts` 的导出（`getSkillCapableTools`、`resolveToolSkillsDir` 等）均在 `skill-paths.ts` 有定义；`adapters/` 仅 `index.ts`、`oh-my-pi.ts`。
  - CLI 注册：顶层命令为 `version`、`init`、`update`、`list`、`view`、`change`、`show`、`archive`、`validate`、`feedback`、`completion`、`status`、`instructions`、`templates`、`schemas`、`new` 等；无顶层 `install [version]`。`completion` 下仅 `generate`／`install [shell]`／`uninstall [shell]` 与隐藏 `__complete`。补全命令表顶层同样无 `install`。
  - 目标约束：`AI_TOOLS` 仅一个 `value: 'oh-my-pi'`；`--tools` 帮助由该数组派生，校验用 `getToolsWithSkillsDir()`，未知 id 走 `Invalid tool(s)` 分支（`init.ts:575` 起），不映射到 OMP；`all` 只返回 OMP。
  - 无空文件（`find src -type f -size 0` 为空）、无新增 no-op／占位导出；`src/` 中剩余 `copilot` 仅为 `command-generation/invocation.ts` 的历史注释示例，`standalone` 仅为 store／sync 语义与注释。
  - 本项为静态核对，未执行构建；构建与类型检查在下一项进行。
- [x] 在隔离工作目录使用保留的构建入口及锁定依赖进行一次最小构建验证，证明源码裁剪没有留下导入／类型错误。使用项目允许的构建命令，不直接调用 tsc；不安装或构建到用户上游目录。
  - 隔离目录：`F:\code2026\_build\openspec-vendor-build-20261114`（OMP 仓库外、上游目录外）；从裁剪后的 vendor 根完整复制 282 个文件，未在源树执行安装或构建。
  - 依赖：`npx pnpm@10.34.5 install --frozen-lockfile --ignore-scripts`，按 `pnpm-lock.yaml` 安装（typescript 6.0.3、@types/node 22.20.5、zod 4.6.7、commander 14.0.3、yaml 2.9.1、picomatch 4.0.7 等），未改动锁文件。
  - 首次 `pnpm build`（即 `node build.js`）失败：`src/core/update.ts` 4 处调用 `this.planLegacyToolMoves(...)`，但该方法在裁剪时被误删（`planLegacyToolMigrations` import 仍在）。已从备份恢复该方法（原逻辑：按 `recorder.view` 计划旧工具根迁移并记录 `needsConsent` 备注），不恢复任何其他 Agent 根（`LEGACY_TOOL_ROOTS` 仍为空）。
  - 复跑 `pnpm build` 成功：TypeScript 6.0.3 编译完成，`dist/` 生成；无导入／类型错误。
  - 结论：构建入口与锁定依赖可用；裁剪引入的 1 个真实编译错误已修复。未直接调用 tsc，未构建到上游或用户目录。
  - 保留隔离目录供下一项 CLI 行为验证使用（`dist/cli/index.js` 已生成）。
- [x] 用新生成的 CLI 验证 help 不再提供独立 install／其他 Agent 目标，在临时项目中验证 OMP 初始化及一次 status／instructions；被移除的 tools 目标明确拒绝，不写入其他 Agent 目录。需要安装／更新的用例隔离 HOME、配置根与项目目录。
  - CLI：上一项隔离构建产物 `F:\code2026\_build\openspec-vendor-build-20261114\bin\openspec.js`（`dist/` 由裁剪源码生成），全部命令经 `HOME`／`USERPROFILE`／`XDG_CONFIG_HOME`／`XDG_DATA_HOME` 指向 `F:\code2026\_build\openspec-cli-e2e-20261114\{home,xdg-config,xdg-data}`，并设 `OPENSPEC_NO_UPDATE_CHECK=1`、`CI=1`。
  - help：顶层 `--help` 中 `install` 匹配数为 0（无独立 `install [version]`）；`init --help` 的 tools 值仅为 `all, none, oh-my-pi`；`update --help` 无其他 Agent 选项。
  - 初始化：`node bin/openspec.js init <project> --tools oh-my-pi --no-animation` 退出 0；创建 `openspec/{config.yaml,specs,changes}` 与 `.agents/skills/openspec-*`（6 个 Skill + `.openspec-target`）；输出 “Setup complete for Oh My Pi”。
  - 写入边界：项目内无 `.claude`／`.cursor`／`.codex`／`.windsurf`／`.devin`／`.gemini`／`.qwen`／`.kimi`／`.opencode`／`.zcode`／`.pi` 等目录；隔离 `home`／`xdg-config`／`xdg-data` 在 init 后仍为空。
  - 被移除目标：`init <project-bad> --tools claude` 退出 1，报 `Invalid tool(s): claude. Available values: all, none, oh-my-pi`，目标目录保持为空。
  - 业务命令：`new change demo-change` 退出 0；`status --change demo-change` 退出 0（`Progress: 0/4 artifacts complete`，proposal ready，其余 blocked）；`instructions proposal --change demo-change` 退出 0（输出 `<artifact id="proposal">` 及写入路径）。
  - 版本／更新：`version` 输出 `OpenSpec 2.0.0`；`update --dry-run --json` 退出 0，唯一变更是在隔离 `xdg-config/openspec/config.json` 执行 `add`（tool `openspec`），未写入项目外其他 Agent 目录。
  - 未出现 OMP 宿主适配失败；被删功能未恢复，未扩大到全链路适配。临时目录保留作证据。
- [x] 若 CLI 的最小验证因尚未完成的 OMP 宿主适配失败，记录具体失败与层次，不恢复被删除功能、不转而扩大为 OMP 全链路适配，也不把“文件清理完成”写成“功能验收通过”。
  - 未触发：上一项 CLI 验证全部成功（help、init、new/status/instructions、version、update dry-run 均退出 0；移除的 `claude` 目标按预期退出 1）。无 OMP 宿主适配失败需要记录。
  - 未恢复任何被删除功能，未新增宿主适配；本项不额外宣称功能验收通过，结论仍限于本轮裁剪与最小验证范围。
- [x] 不运行已删除的上游测试，不新增整套测试体系，不运行 OMP 全仓 fulltest、Rust、浏览器或发行验证。
  - 上游测试：`test/` 已删除，本轮未运行、未恢复，也未从上游目录借用测试。
  - 未新增测试文件或测试框架；`package.json` 中测试脚本与 vitest／eslint 依赖已移除，未重新引入。
  - 未运行 OMP 全仓命令：无 `bun run fulltest`／`fastcheck`、无 Rust 测试（`bun run test:rs`／`cargo test`）、无浏览器／Selenium、无 release 或发行产物验证。
  - 实际执行仅限：裁剪树静态检查、仓库外隔离目录的 `pnpm install --frozen-lockfile` 与 `pnpm build`、以及该构建产物在临时项目中的 CLI 命令（help／init／new／status／instructions／version／update --dry-run）。

## 7. 交付与停止条件

### 7.1 文档残留同步

- [x] 清理权威文档中已删除工具与 Copilot 云 Agent 的支持声明。
  - `docs/supported-tools.md`、`docs-lab/reference/supported-tools.md` 重写为仅 `oh-my-pi`：skills 写入 `.agents/skills/`、不生成命令文件、`--tools` 仅接受 `oh-my-pi`／`all`／`none`，其他 id 明确报错。
  - `docs/customization.md`：删除 `githubCopilot.cloudAgent` 配置示例与集成选项条目。
  - `docs/cli.md`：删除 `--copilot-cloud`／`--no-copilot-cloud` 选项行；工具 ID 列表改为 `oh-my-pi`；示例改为 `--tools oh-my-pi`；dry-run 说明去掉 Copilot 文件。
  - `docs-lab/reference/cli.md`：删除 Copilot 云文件同步条目。
  - `docs/faq.md`：移除“30+ assistants”支持声明，改为本副本仅配置 Oh My Pi。
  - `docs/how-commands-work.md`、`docs/commands.md`：工具语法表收缩为 Oh My Pi，删除其他工具的 `/opsx`／`$openspec-*` 行与 Devin 双行说明。
  - 修改统计：文档修改由 12 增至 21；当前总数 282、删除 1096、修改 50、未修改摘要一致 232。
  - 未全面重写：仍保留上游历史 `/opsx` 旧命令说明与迁移背景；这些不再被作为本副本当前支持范围声明。未运行构建（文档变更不影响已完成的隔离构建与 CLI 验证）。


- [x] 记录实际删除／修改清单、保留文档类别、来源版本／提交、备份位置及已执行验证结果。
  - 来源：`C:\Users\jiang\Documents\OpenSpec`，`main` @ `ea635dd255f8686dcf48626bbcbe0e3fd59b6067`，版本 `2.0.0`；目标原树 1378 个文件，与本轮开始时无内容差异（仅检出换行）。
  - 备份／对照：`F:\code2026\_backup\openspec-vendor-preTrim-ea635dd-20261114`（1378 文件、11 MB，清单哈希 `a2615a10…`）；保留摘要 `F:\code2026\_backup\openspec-vendor-retained-sha256-ea635dd.txt`（294 条）。
  - 结果：当前 282 个文件；删除 1096、修改 50、新增 0、未修改且摘要一致 232。
  - 删除清单：A.1 目录 1022（`test/` 293、`openspec/` 663、`.github/` 12、`.changeset/` 2、`.devcontainer/` 2、`.agents/` 8、`website/` 42）；A.2 根文件 12；A.3 `scripts/` 15；A.4 adapter／集成 35；追加删除 docs-lab 工程材料 7、失去引用的 SVG 2、无消费者源码 3（`retired-tools.ts`、`standalone-tip.ts`、`executable-path.ts`）。
  - 修改清单：源码 26（A.5 目标 14 + 连锁 12，含验证阶段恢复的 `update.ts` `planLegacyToolMoves`）、包／配置 3（`package.json`、`pnpm-lock.yaml`、`.gitattributes`）、文档 21（原 12 + 7.1 支持矩阵／FAQ 同步 9）；逐项原因见第 6 节与 7.1。
  - 保留类别与数量：业务源码 `src/` 186；文档 `docs/` 27、`docs-lab/` 36（使用指南、CLI、工作流、配置、schema、store、排错、示例等）；Skill `skills/` 13；schema `schemas/` 5；图片 `assets/` 2（README 引用）；CLI 入口 `bin/` 1；根构建／许可／包配置完整。
  - 已执行验证：静态路径／摘要比对；隔离目录 `pnpm@10.34.5 install --frozen-lockfile` + `pnpm build` 成功（修复 1 个裁剪导致的编译错误）；隔离 HOME／XDG 的临时项目 `init --tools oh-my-pi`、`new change`、`status`、`instructions`、`version`、`update --dry-run` 成功；`--tools claude` 明确拒绝且无写入。
  - 未执行：上游测试（已删除）、OMP 全仓 fulltest／Rust／浏览器／发行验证；未提交、未推送。
- [x] 明确区分：非业务文件清理、其他 Agent／独立安装源码裁剪、最小构建／CLI 验证各自是否完成；没有执行或失败的项如实保留。
  - 非业务文件清理：**完成**。A.1–A.3（`test/`、`openspec/`、`.github/`、`.changeset/`、`.devcontainer/`、`.agents/`、`website/`、12 个根文件、`scripts/`）已删除；docs-lab 工程材料 7 个与失去引用的 SVG 2 个已删除；无空目录、无新增文件。
  - 其他 Agent／独立安装源码裁剪：**代码完成**。A.4 的 33 个 adapter、Copilot 云集成、standalone installer 已删；`AI_TOOLS` 仅 OMP；链接／全局路径／探测分支与退役目标已清；CLI 无 `install [version]`，`--tools` 仅接受 `oh-my-pi`。源码 26 个修改文件通过静态引用核对与隔离构建。
  - 最小构建／CLI 验证：**完成**。隔离目录 `pnpm build` 成功（修复 `update.ts` 缺失方法）；临时项目 `init`／`new`／`status`／`instructions`／`version`／`update --dry-run` 成功，`--tools claude` 明确拒绝，未写其他 Agent 目录。
  - 原记录的文档残留已由 7.1 处理：权威支持矩阵、Copilot 云配置与显式支持声明已同步；历史 `/opsx` 旧命令说明仍保留为上游参考，不再作为当前支持范围声明。
  - 未执行／不适用：上游测试、OMP 全仓 fulltest／Rust／浏览器／发行验证；无失败项需要恢复被删功能。
- [x] 上游核心业务不因旧需求被改写，用户资料和其他 OMP 资源无附带改动。完成上述范围后停止，不追加宿主适配、规格迁移、提交、推送或发布。
  - 核心业务：保留的 CLI、init/update、需求操作、artifact graph、schema、模板、校验、归档、Skill 生成与文档正文未被重写；改动仅为删除其他目标分支、清理引用及失效安装说明。验证：隔离构建成功，CLI 的 init／new／status／instructions／version／update 流程可用。
  - 附带范围：`git status` 显示仓库内除 `todo.md` 外，改动全部位于 `packages/coding-agent/src/spec-driven/vendor/resources/openspec/`；OMP 根 `openspec/`、`packages/coding-agent/test/`、`AGENTS.md` 无改动；Superpowers／JCH 兄弟资源未触碰。
  - 上游只读：`C:\Users\jiang\Documents\OpenSpec` 仍为 `ea635dd…`，`git status` 0 条。
  - 未追加：无 OMP 宿主适配、无规格迁移、无提交、无推送、无发布；未安装或写入用户上游目录。隔离构建目录与临时项目仅位于 `F:\code2026\_build\`。
  - 停止条件：按用户指令停止于此。代码裁剪、最小验证与 7.1 文档残留同步均已完成；历史 `/opsx` 说明保留为上游参考，不作为当前支持范围声明。

## 执行提醒

前版 todo 中整删 docs／docs-lab／assets／README／CHANGELOG 的方案已撤销；也不再使用“只保留四个目录和八个文件”的白名单。文件清理可以按明确目录执行，但第 5 节是有调用链约束的源码修改，不能用批量文件删除命令代替。

## 附录 A：删除／修改清单（基准 `ea635dd`，2026-11-14）

路径均相对 `packages/coding-agent/src/spec-driven/vendor/resources/openspec/`。删除单位是显式路径，不做文件名通配；第 5 节源码项必须先改调用方再删文件。

### A.1 目录级删除（1022 个文件）

| 相对路径 | 文件数 | 依据 |
|---|---:|---|
| `test/` | 293 | 第 4 节：上游 UT／集成／fixtures |
| `openspec/` | 663 | 第 4 节：上游自身需求、change、archive、explorations、initiatives |
| `.github/` | 12 | 第 4 节：上游 CI／Issue／PR 模板 |
| `.changeset/` | 2 | 第 4 节：上游发布管理 |
| `.devcontainer/` | 2 | 第 4 节：上游开发容器 |
| `.agents/` | 8 | 第 4 节：上游仓库开发用 Agent 配置副本（保留根 `skills/`） |
| `website/` | 42 | 第 3 节完成内容提取后已删除 |

### A.2 根文件删除（12 个）

`.actrc`、`.coderabbit.yaml`、`flake.nix`、`flake.lock`、`vitest.config.ts`、`vitest.setup.ts`、`eslint.config.js`、`AGENTS.md`（0 字节）、`CONTRIBUTING.md`、`MAINTAINERS.md`、`openspec-parallel-merge-plan.md`、`README_OLD.md`（最后一项须先核对内容已被当前文档覆盖）。

### A.3 `scripts/` 删除（15 个，均须先确认无保留代码导入）

`scripts/README.md`、`scripts/binary/build.mjs`、`scripts/binary/entry.mjs`、`scripts/binary/install.sh`、`scripts/binary/install.ps1`、`scripts/binary/install-check.sh`、`scripts/binary/smoke.sh`、`scripts/binary/e2e.sh`、`scripts/capture-released-fingerprints.mjs`、`scripts/generate-skillssh.mjs`、`scripts/pack-version-check.mjs`、`scripts/parity-hash-shared.mjs`、`scripts/regen-parity-hashes.mjs`、`scripts/skillssh-shared.mjs`、`scripts/update-flake.sh`。

已知消费者：`package.json` 的 `generate:skills`／`regen:parity-hashes`／`check:pack-version`／`release:ci`；`.github/` 工作流（随 A.1 删除）；`src/commands/install-standalone.ts` 仅以字符串引用 `scripts/binary` 下载地址（该文件在 A.5 删除）；`src/core/shared/released-generated-fingerprints.ts` 仅注释提及生成脚本，数据本身保留。

### A.4 adapter 与专用集成删除（35 个文件）

- `src/core/command-generation/adapters/` 中除 `oh-my-pi.ts`、`index.ts` 外的 33 个文件：`amazon-q.ts`、`antigravity.ts`、`atomcode.ts`、`auggie.ts`、`bob.ts`、`claude.ts`、`cline.ts`、`codeassistant.ts`、`codebuddy.ts`、`codestudio.ts`、`command-code.ts`、`continue.ts`、`costrict.ts`、`crush.ts`、`cursor.ts`、`devin.ts`、`easycode.ts`、`factory.ts`、`gemini.ts`、`gigacode.ts`、`github-copilot.ts`、`iflow.ts`、`junie.ts`、`kilocode.ts`、`kiro.ts`、`lingma.ts`、`opencode.ts`、`pi.ts`、`qoder.ts`、`qwen.ts`、`roocode.ts`、`trae.ts`、`zcode.ts`。
- `src/core/github-copilot/cloud-agent.ts`（Copilot 云 Agent 集成，调用方见 A.5）。
- `src/commands/install-standalone.ts`（CLI 独立安装实现）。

### A.5 源码／配置修改点（12 个文件）

| 相对路径 | 修改内容 |
|---|---|
| `src/core/command-generation/adapters/index.ts` | 仅保留 `oh-my-pi` 导出 |
| `src/core/command-generation/registry.ts` | 仅保留 `ohMyPiAdapter` 的 import 与注册 |
| `src/core/config.ts` | `AI_TOOLS`（L102 起）仅留 `oh-my-pi`；移除 `pi`（L145）、`zcode`（L155）及其余条目、`UNIVERSAL_TOOL_ID`／`getUniversalTool`／`universalToolFallbackHint`、`TOOL_ID_ALIASES`、`retired-tools` 相关提示的失效消费者 |
| `src/core/available-tools.ts` | 移除非 OMP 探测分支，保留路径安全 |
| `src/core/shared-skill-target.ts`、`src/core/shared/skill-paths.ts`、`src/core/shared/tool-detection.ts`、`src/core/shared/shared-skill-install.ts`、`src/core/shared/skill-links.ts` | 清除非 OMP 专属探测／全局 HOME 写入／软链接安装分支与失效 import |
| `src/core/retired-tools.ts`、`src/core/legacy-cleanup.ts`、`src/core/released-output-sweep.ts` | 不再遍历／迁移／删除其他 Agent 用户目录；保留 OMP 旧输出识别与防误删检查 |
| `src/core/init.ts` | 移除 `cloud-agent` import（L92）、Copilot 选择与 `--copilot-cloud` 分支（L346/409/415/1048/1309），改接裁剪后的工具集 |
| `src/core/update.ts` | 同上去除 Copilot 集成与已删目标引用 |
| `src/cli/index.ts` | 取消 `install [version]` 命令注册（L455–460）；同步 tools 参数帮助／校验／选择器 |
| `package.json` | 删除测试／lint／release／changeset／资源维护脚本与对应 devDependencies，保留 `build`、`prepare`、仍有效入口 |
| `pnpm-lock.yaml` | 用 `pnpm@10.34.5` 按裁剪后的 `package.json` 更新，保留有效 overrides |
| `docs/supported-tools.md` 等文档 | 移除被删目标与失效本地链接（随第 3、4 节执行时为待定项） |

### A.6 保留基线（摘要核对的对照面）

`src/` 224 个文件（减去 A.4 的 2 个）、`docs/` 27、`docs-lab/` 43、`assets/` 4、`skills/` 13、`schemas/` 5、`bin/` 1，以及 `LICENSE`、`README.md`、`CHANGELOG.md`、`SECURITY.md`、`install.md`、`package.json`、`pnpm-workspace.yaml`、`tsconfig.json`、`build.js`、`.gitattributes`、`.gitignore`、`pnpm-lock.yaml`。
