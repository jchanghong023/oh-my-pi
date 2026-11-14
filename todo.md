# OMP 内置 OpenSpec：完整还原上游文件

## 当前范围

先完整还原用户指定上游的全部版本化文件，不做 OMP 适配，不评估是否满足已有需求，不以兼容性问题阻止文件还原。

- 来源：`C:\Users\jiang\Documents\OpenSpec`。
- 目标：`packages/coding-agent/src/spec-driven/vendor/resources/openspec/`。
- 已读取的来源 `package.json` 版本为 `2.0.0`；实施时以固定快照为准，不将此版本号等同于已核验的远端最新状态。
- 本次已完成文件还原与校验（15/15）；仅 `inventory.json` 来源记录按实际快照更正，未实施 OMP 适配。

## 1. 固定完整上游快照

- [x] 记录来源仓库完整提交 SHA 及版本，检查是否存在已跟踪文件的本地改动；以该提交的完整版本化文件树作为还原基准，本地未提交内容不自动视为上游。
- [x] 导出全部版本化文件，包含隐藏文件、源码、测试、文档、配置、脚本、全部 Skill、schema、网站及上游自身的 `openspec/` 等，不按 npm 发布清单或 core profile 裁剪。
- [x] 保持原始相对路径、内容及文件类型；符号链接保留链接目标，不跟随链接复制仓库外内容。若快照包含子模块，记录其固定 revision 并完整取得对应内容，不能以空目录冒充完成。
- [x] 不复制来源 `.git` 管理数据、未跟踪的个人文件、缓存、依赖安装目录或本地生成产物；这些不属于固定提交的上游文件树。提交中本身包含的文件不得仅因属于隐藏目录或生成文件而被排除。

## 2. 干净替换内置 OpenSpec 文件树

- [x] 核对目标目录及其中已有改动，保留可恢复副本；删除前生成仅限该目录的替换清单。
- [x] 在独立临时目录准备完整上游快照，准备完成后再替换目标，不先删空再下载，不采用覆盖复制留下旧文件。
- [x] 目标文件集合必须与固定上游快照完全一致；删除所有仅存在于旧目标中的文件，不保留 OMP 添加或修改的副本。
- [x] 旧 `schemas/mini/`、`schemas/omp-spec/`、`dist/core/omp-sync.js`、定制 `dist/`、旧 `commands/` 和旧依赖目录，凡不在固定上游文件树中，全部随干净替换移除；不另存回目标作为兼容资源。
- [x] 原样保留上游全部 Skill、模板、说明、frontmatter、命令示例和工具声明，不改为 `omp openspec`，不加入仅需求流程限制，不补写上游没有的文件。
- [x] 只替换上述目标子树。上游自身的 `openspec/` 位于目标子树内，不覆盖 OMP 仓库根目录的 `openspec/`。
- [x] 不改动 Superpowers、JCH、共享运行时、其他 OMP 源码及无关用户改动；不修改来源仓库。

## 3. 仅校验文件还原结果

- [x] 对固定快照与目标逐项比对相对路径、文件类型、普通文件内容摘要及链接目标：缺失文件、额外文件和内容差异均为零。
- [x] 确认隐藏目录及非发布文件未漏拷，没有遗留旧 OpenSpec 私有文件，也没有混入来源 `.git`、个人配置或本地依赖。
- [x] 记录来源路径、提交 SHA、版本、还原目录和比对结果；版本及完整性记录放在目标树外，不向上游文件树添加自有清单。
- [x] 如需更新 `packages/coding-agent/src/spec-driven/vendor/inventory.json` 的来源记录，只记录实际固定快照的信息，不冒用旧 npm integrity；不得为维护旧清单格式扩展成宿主适配或构建工作。

## 明确不做

- 不修改 `src/spec-driven/resources.ts`、CLI、发现 provider、Skill 权限策略或 AIReq 调用方。
- 不处理裸 `openspec` 的 PATH、启动器、stdin／TTY、命令补全或重复 Skill 发现。
- 不迁移 `mini`／`omp-spec` 项目配置、活动 change 或用户需求资料，不为旧调用保留兼容 schema。
- 不修改既有需求规格以要求它们适配本轮文件还原，不评估 AIReq 或其他现有功能是否满足需求。
- 不安装依赖、不运行构建、不生成 dist 或默认 profile 资源、不调整 npm／二进制打包及缓存机制。
- 不运行功能测试、TUI／浏览器验收或全仓检查，不为通过旧测试而修改上游文件。
- 不提交、不推送、不发布。

## 固定快照记录（目标树外）

- 来源路径：`C:\Users\jiang\Documents\OpenSpec`
- 提交 SHA：`ea635dd255f8686dcf48626bbcbe0e3fd59b6067`（`main`，2026-11-13 22:09:16 +0000，`fix(binaries): label the Windows executables as OpenSpec (#2246)`）
- 包名／版本：`@fission-ai/openspec` `2.0.0`
- 本地状态：已跟踪改动 0、已暂存改动 0、未跟踪文件 0；工作区干净，`HEAD` 即快照基准。
- 子模块：无（`git submodule status` 为空）；符号链接：无（无 mode `120000` 条目）。
- 版本化文件数：1378（`git ls-tree -r --name-only HEAD`，含隐藏文件与上游自身 `openspec/`）。
- 提交时 HEAD 无 tag 指向。
- 导出方式与位置：`git archive --format=tar <SHA>` → `F:/tmp-omp/snap.tar`，解包至 `F:/tmp-omp/openspec-src`（仓库外独立临时目录）。
- 导出结果：1378 个文件、638 个目录；与 `git ls-tree -r --name-only <SHA>` 的路径集合逐一 `diff` 无差异；目录清单含 `src`、`test`、`docs`、`docs-lab`、`website`、`skills`、`schemas`、`scripts`、`bin`、`openspec`（663 个文件）及 `.github`／`.agents`／`.changeset`／`.devcontainer` 等隐藏目录；无 `.git`、`node_modules`、日志文件，无子模块与符号链接条目。
- 内容一致性：对快照 1378 个文件逐个 `git hash-object --no-filters`，与 `git ls-tree -r` 的 blob SHA 逐行比对，差异 0（含 1 个空文件）。相对路径一致（见上条 `diff`）。
- 文件类型：上游全部为普通文件（1373 个 `100644`、5 个 `100755`），无 `120000` 符号链接、无 `160000` gitlink 子模块，故无需保留链接目标或子模块 revision。5 个可执行文件：`bin/openspec.js`、`scripts/binary/e2e.sh`、`scripts/binary/install-check.sh`、`scripts/binary/smoke.sh`、`scripts/update-flake.sh`（Windows 挂载统一报 777，执行位不可由文件系统区分，替换后按此清单核对）。
- 来源仓库复核：操作后 `git status --porcelain --untracked-files=all` 仍为 0 行，未修改来源。
- 排除审计：快照中 `.git`／`node_modules`／`.cache`／`.turbo`／`.next`／`coverage`／`.pnpm-store`／`*.log`／`*.tsbuildinfo`／`dist`／`.venv`／`__pycache__` 命中数为 0；来源工作区 `git status --ignored=matching -uall` 为空（来源本无未跟踪／忽略文件），故快照 = 固定提交树，与来源工作目录顶层仅差 `.git`。
- 未误排隐藏／生成文件：`.actrc`、`.coderabbit.yaml`、`.gitattributes`、`.gitignore` 及 `.github/`、`.agents/`、`.changeset/`、`.devcontainer/`、`website/.gitignore` 均在快照内；`pnpm-lock.yaml`、`flake.lock`、`package.json`、`tsconfig.json`、`vitest.config.ts` 均存在。分组计数：`src` 224、`test` 293、`openspec` 663、`docs-lab` 43、`website` 42、`docs` 27、`scripts` 15、`skills` 13、`schemas` 5、`bin` 1。

## 目标现状与替换清单（目标树外）

- 目标目录：`packages/coding-agent/src/spec-driven/vendor/resources/openspec/`，旧文件 2237 个、237 个目录、14 MB。
- 已有改动：`git status --porcelain -uall -- <目标>` 为 0 行；2237 个文件全部被 git 跟踪（含 `node_modules/`、`dist/`），工作区与 `HEAD` 一致，无未提交改动。
- 可恢复副本：`F:/tmp-omp/target-backup`（`cp -a` 全量 2237 文件；与原目录逐文件 SHA-256 比对差异 0）。
- 替换清单：`F:/tmp-omp/replacement-manifest.txt`（仅覆盖该目录）。分类：删除 2215（`node_modules/` 1770、`dist/` 433、`commands/` 6、`schemas/mini/` 3、`schemas/omp-spec/` 3）、覆盖 16（`LICENSE`、`README.md`、`package.json`、`schemas/spec-driven/schema.yaml`、12 个 `skills/*/SKILL.md`）、新增 1356（`openspec/` 663、`test/` 293、`src/` 224、`docs-lab/` 43、`website/` 42、`docs/` 27、`scripts/` 15、`.github/` 12、`.agents/` 8 等）、保持不变 0。
- 旧目标中 `dist/core/` 共 317 个文件（含 `omp-sync.js` 与定制产物）全部在删除清单内。
- 替换执行：快照先在 `F:/tmp-omp/openspec-src` 完整解包并三证核验（路径／blob SHA／文件类型）后才动目标；随后删除旧目录并整树复制快照（非覆盖复制）。`snap.tar` 与 `F:/tmp-omp/target-backup` 均保留。
- 替换结果：目标目录 1378 文件 / 638 目录；与快照逐文件 SHA-256 比对差异 0；`node_modules`、`dist`、`commands`、`schemas/mini`、`schemas/omp-spec` 均不存在。
- 文件集合等式：`目标 - 快照 = 0`、`快照 - 目标 = 0`、同路径内容差异 = 0；旧目标独有文件（2215）在新目标中存活数 = 0。
- OMP 私有修改清理：旧目标 22 个上游同路径文件中 16 个内容被 OMP 改动过（`LICENSE`、`README.md`、`package.json`、`schemas/spec-driven/schema.yaml`、12 个 `skills/*/SKILL.md`），现已全部回到快照内容；其余 6 个（`bin/openspec.js`、`schemas/spec-driven/templates/{design,proposal,spec,tasks}.md`、`skills/README.md`）与上游本来就相同。
- git 视角：该子树 `2215 D / 16 M / 1356 ??`，无其他状态；未 `git add`，无暂存。
- 旧私有路径移除核验：`node_modules`、`dist`、`dist/core/omp-sync.js`、`commands`、`schemas/mini`、`schemas/omp-spec` 在目标中均不存在，且均不在上游快照路径集合内（`schemas/` 现仅 `spec-driven/` 的 5 个文件）。目标目录集合 637 个，与快照推导目录集合 637 个完全一致（多余 0、缺失 0），未以改名／嵌套方式另存兼容资源；名称含 `mini` 的 3 处命中均为上游自身文件（`openspec/changes/archive/2025-09-29-improve-deterministic-tests/*`、`openspec/initiatives/.../06-add-minimal-context-store-ux/*`、`src/core/command-generation/adapters/gemini.ts`）。
- 内容原样性：1378/1378 文件 SHA-256 与快照一致，Skill（`skills/` 13 文件，12 个 `SKILL.md` 均带 `name:` frontmatter）、模板（`schemas/spec-driven/templates/` 4 个）、`skills/README.md`、`.agents/` 8 个上游工具声明文件、`openspec/` 内 663 个说明与变更档案全部为上游原文。
- 未注入 OMP 改写：目标中 `AIReq`、`omp-sync`、`omp openspec`、`schemas/mini`、`omp-spec` 出现文件数均为 0，与快照一致；无补写文件（`目标 - 快照 = 0`）。上游文中出现的 `Oh My Pi`／`.omp` 属其自身 tool 支持（`openspec/specs/oh-my-pi-tool`、`cli-init`），非 OMP 改动。
- 作用域核验：全仓 `git status -uall` 除去目标子树后仅剩 `?? todo.md`（本任务计划文件，用户提供、按指示更新；未被 git 跟踪），其余改动全部落在目标子树内；OMP 仓库根 `openspec/`（138 文件）状态 0 行改动；`vendor/` 仅 `inventory.json` 与 `resources/`，`resources/` 下 `jch`、`omp-runtime`、`superpowers` 三个兄弟资源状态 0 行。目标子树内自带上游 `openspec/`（663 文件：`changes`、`specs`、`explorations`、`initiatives`、`work`、`config.yaml`）。
- 无附带改动：OMP 仓库中目标子树外的已跟踪差异 0、暂存 0、未跟踪仅 `todo.md`；`vendor/resources/{superpowers,jch,omp-runtime}`、`vendor/inventory.json`、`src/spec-driven/resources.ts` 及整个 `src/` 均为 0 行状态。
- 来源仓库：`git status -uall` 0 行、`HEAD` 仍为 `ea635dd255f8686dcf48626bbcbe0e3fd59b6067`、无 stash，未修改。
- 最终独立比对（重新 `git archive` 出 `F:/tmp-omp/v-src`，不依赖先前的 `openspec-src`）：canonical 1378 文件／638 目录 vs 目标 1378 文件／638 目录；缺失 0、额外 0、内容差异 0（双向 `sha256sum` 全表比对）；canonical 与目标符号链接条目均为 0，目标非常规文件 0；类型分布 `100644`=1373、`100755`=5（执行位在 Windows 挂载不可表达，按路径清单记录）。报告：`F:/tmp-omp/verification-report.txt`，结论 PASS。
- 隐藏文件与私有内容审计：目标隐藏文件 72 个，与 canonical 的 72 个路径逐一 `diff` 完全一致；隐藏目录 13 个；非发布目录文件数 `test` 293、`docs` 27、`docs-lab` 43、`website` 42、`.github` 12、`.agents` 8、`.changeset` 2、`.devcontainer` 2（canonical 对应 429 个全部到位）。目标中无 `.git`、`node_modules`、`.env*`、`.npmrc`、`.DS_Store`、`*.local`、`.venv`、`__pycache__`、`*.log`；无旧私有 `schemas/mini`、`schemas/omp-spec`、`omp-sync*`、`dist/`、顶层 `commands/` 残留（命中的 `commands` 路径均为上游 `src/cli/commands`、`src/commands`、`test/commands`、`test/core/commands`，共 81 个，已在 canonical 内）。
- 来源记录归档：`F:/tmp-omp/verification-report.txt` 已整合为单一完整记录（来源路径、分支 `main`、SHA、提交时间与标题、包名版本 `@fission-ai/openspec 2.0.0`、还原目录、还原与三种比对方法、canonical/目标计数、缺失/额外/差异全 0、隐藏文件 72=72、模式分布、执行位说明、结论 PASS、留存物清单）。目标树内无本记录或自有清单：`extra = 0`，仅存上游自身 `test/core/templates/spec-inventory.test.ts`（canonical 内文件）。
- `vendor/inventory.json` 更新：`openspec` 记录由 `version: 1.15.0` + npm `sha512-…` 改为 `version: 2.0.0` + `integrity: "git:ea635dd255f8686dcf48626bbcbe0e3fd59b6067"`；未冒用旧 npm integrity，未新增字段（保持 `resources.ts` 声明的 `{version: string; integrity: string}` 形状，因此无需改动 `resources.ts` 或任何消费代码）；`superpowers`、`jch` 记录未动。校验：JSON 可解析，`openspec` 键仍为 `version,integrity`，两者均为字符串。

## 完成标准与已接受边界

- 目标目录完整、原样对应固定上游文件树，无 OMP 私有增删改；文件比对通过即完成本轮还原。
- 本轮只保证文件还原，不保证 OMP 能加载或运行新文件，不保证源码入口、Skill、AIReq、npm 或二进制可用。
- 旧宿主包装代码和既有配置可能仍依赖已移除的资源，构建或运行可能失败；这些不在本轮修复和验收范围内，也不因此恢复旧魔改。
- 交付只报告实际还原及文件校验结果，不能宣称已完成 OMP 功能升级或运行验证。
