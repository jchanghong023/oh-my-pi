# OpenSpec 2.0 最终 OMP 适配与文档同步

## 本次操作与后续执行边界

**本轮剩余工作已完成，默认 fastcheck／fulltest 均通过。** OpenSpec 2.0 内置适配、12 Skill、文档、用户文件保护、本仓库 schema 迁移及验收已完成；源码／npm／Windows 二进制与真实 TUI 已验证。迁移不代表既有业务材料已补齐，其他平台未实测；详细证据、备份位置与门禁范围见下方。此前逐轮说明属于历史过程。

前置状态由用户确认：上游业务还原和无关材料裁剪已完成。本轮不重做整仓导入，不恢复其他 Agent 支持、独立安装器或旧魔改。

### 已确认合同

1. OpenSpec 随 OMP 内置，任意项目可发现、读取和显式调用 Skill，不要求先安装 Skill。
2. 所有实际调用入口为 `omp openspec ...`，不依赖外部 `openspec`／Node 安装，不新增裸命令启动器或 PATH 注入。
3. `init` 只负责项目初始化与配置，不向项目或用户目录安装、复制、链接、更新或清理 Skill／旧命令。
4. 内置 Skill 随 OMP 版本更新。`update` 不再管理 Skill；若移除交付职责后没有独立有效职责，删除命令与死代码，不保留无操作成功入口。
5. 适配交付、发现、执行及文档，不改变通用工作流、artifact 依赖、默认 spec-driven schema、校验、同步或归档语义，不恢复 mini／omp-spec 注入、私有目录桥接、需求专用版正文或旧五项白名单。
6. 不自动删除或迁移用户已有 Skill、命令、项目配置及 change；普通 OMP、Superpowers、JCH 的既有行为保持。
7. AIReq 需求尚未确定，完全不纳入本轮：不设计、修改或验证其会话、Skill 策略、权限、schema 或业务后端，也不将 AIReq 兼容／隔离作为 OpenSpec 适配的完成条件。共享代码仅按普通 OpenSpec 的实际需要修改，不承诺本轮完成 AIReq 接入。

---

## 1. 固定当前状态及明确实施文件

- [x] 读取当前裁剪结果及相关源码，不把前一阶段已完成记录当作本轮验证结果；保全无关改动，备份本轮确需迁移的配置和元数据。
  - 本轮只读确认：vendor `package.json` 与 `inventory.json` 均记录 OpenSpec 2.0.0，inventory 来源为 `git:ea635dd255f8686dcf48626bbcbe0e3fd59b6067`；现存 schema 目录包含 `spec-driven/`，根 `openspec/config.yaml` 仍为 `schema: omp-spec`。
  - 已读取 `src/spec-driven/resources.ts`、`resource-inventory.ts`、`scripts/spec-driven-resources.ts` 及 vendor `src/core/init.ts`：宿主仍引用私有 `omp-spec` schema，资源收集仍遍历 vendor 树，打包入口仍假设已有运行树与依赖；vendor init 仍保留工具选择、Skill 安装及旧产物迁移相关代码。这里只记录源码现状，不代表运行、构建或完整调用链已验证。
  - 本轮不迁移任何配置或元数据，故无须创建迁移备份；仅修改 todo.md，其他现有内容及改动未触碰。后续实际迁移前仍须备份对应文件。
- [x] 核对实际调用链：`src/cli.ts` → `src/spec-driven/resources.ts` → vendor OpenSpec；Skill discovery → manifest → 内置正文；源码、npm、二进制的资源生成及加载入口。
  - CLI：`src/cli.ts:520-535` 将 `openspec` 后的参数、真实 cwd 和中止信号交给 `runOpenSpec`；后者经 `ensureSpecDrivenResources` 解析缓存中的 `openspec/bin/openspec.js`，使用 `process.execPath` 与 `BUN_BE_BUN=1` 执行。vendor bin 导入 `../dist/cli/index.js` 的 `runCli`，对应源码 `src/cli/index.ts:878-879` 调用 Commander `program.parse`。宿主捕获 stdout／stderr／退出码，当前 stdin 为 ignore，保留禁用遥测、中止及子进程结清逻辑；init／new change 仍有宿主改写，尚非完全透传。
  - Skill：`src/discovery/index.ts` 注册 `./spec-driven`，`src/extensibility/skills.ts` 经 `skillCapability` 加载；provider 从 `ensureSpecDrivenResources().manifest.skills` 逐项扫描正文目录，当前仍过滤为五项 OpenSpec Skill，并另行注册旧 opsx 文件命令。manifest 由 `resource-inventory.ts` 遍历资源树，将 `<source>/skills/<name>/SKILL.md` 登记为 Skill；`skill://` 经 `skill-protocol.ts` 名称解析、访问检查与 containment 后由 `readSkillTarget` 读取实际文件，`loadSpecDrivenSkill` 另提供按 manifest 查找及正文摘要核对的直接加载入口。
  - 源码：`resource-archive.ts` 默认为 undefined；加载器仅以 vendor `openspec/node_modules` 是否为目录决定读取本地树，否则读取 `dist/spec-driven-resources.tar.gz`。本地树通过 `collectSpecDrivenResources` 生成 manifest／entries；归档读取 manifest；两者均经锁、文件摘要与路径检查解出到内容摘要缓存。当前未比较目标源码指纹，也未检查完整运行依赖闭包；vendor `build.js` 单独负责清理并编译 dist，宿主资源打包函数不调用它或安装依赖。
  - npm／二进制：`package.json` 的 `prepack` → `gen:bundle` → `scripts/bundle-dist.ts`，与 `scripts/compile-binary.ts` 共用 `buildSpecDrivenArchive` 和 `createSpecDrivenArchivePlugin`；前者生成 `dist/cli.js`、固定名归档及 file-loader 资源并定义 `PI_BUNDLED`，后者通过 Bun compile 内嵌资源并定义 `PI_COMPILED`。两种构建均替换 `./resource-archive`，运行时读取该 asset；npm 的源码／SDK 导入还可走固定名归档回退，package files 包含该归档。
  - 完成范围仅为上述源码调用链核对，未运行 CLI、构建、打包或 TUI，不代表源码／npm／二进制运行资源已准备完毕或验收通过；未修改实现、配置或测试，其余待办不勾选。
- [x] 检索旧定制与调用方：`mini`、`omp-spec`、`runOpenSpecDirectory`、`assertAIReqSpecSchema`、`specSchemaPath`、`archivePlan`、OMP 私有归档环境变量、`OPEN_SPEC_CORE_*`、`opsx-*`、`loadSpecDrivenCommands`。按运行代码、测试、文档、现存用户数据分类，不全局替换。
  - 运行代码：`src/spec-driven/resources.ts` 仍写入／注入 mini、导出 `specSchemaPath`／`runOpenSpecDirectory`／`assertAIReqSpecSchema`，并由 `archivePlan` 设置 `OMP_AIREQ_ARCHIVE_PLAN`。本次仓库文本检索未发现这三个 API 在定义文件外的生产调用方，消费者仅见 `test/spec-driven/resources.test.ts`；未发现 `archivePlan` 的外部传入方或 `OMP_DEV_ARCHIVE_PLAN` 的代码引用，不据此宣称仓外消费者不存在。`src/discovery/spec-driven.ts` 保留两个 `OPEN_SPEC_CORE_*` 集合及 `loadSpecDrivenCommands` provider；vendor 仍有 oh-my-pi 命令 adapter、命令引用转换、migration 和 released-generated-fingerprints 中的 opsx 路径，不能将这些上游交付代码误判为全部属于 OMP 私有桥接。
  - 测试：`test/spec-driven/resources.test.ts` 覆盖 mini 图、固定 1.15.0、omp-spec 来源／覆盖拒绝及 directory bridge；`process-resources.e2e.test.ts` 使用 `/opsx-propose` 并断言 mini，`skill-policy.test.ts` 固定五项 opsx 命令。`process-packaged-skills-fixture.ts`／`process.e2e.test.ts` 的 `@omp-spec-*` 是临时目录前缀，不是 schema；模型名、mini UI 描述及其他包同名文本不属于本次迁移对象。
  - 文档：权威 `openspec/specs/spec-driven-orchestration/spec.md` 与 `docs-zh-CN/quick-start-intranet.md` 仍有旧五项／mini／omp-spec 合同；vendor `install.md`、`docs/{faq,glossary,how-commands-work,installation,troubleshooting}.md` 有 opsx 说明。宿主／vendor CHANGELOG 的历史条目保留；`openwiki/` 及 `.claims/` 命中属于生成知识，不手工修改。根项目规则中的相关约定已在加载上下文提供，不另行搜索规则文件。
  - 现存项目数据：对仓库 `openspec/` 的 YAML／JSON（含隐藏、忽略文件）检索发现根配置及 30 份 change 元数据仍为 `schema: omp-spec`，其中 12 份非归档、18 份归档；未发现 mini 元数据。非归档为 `add-{fork-review-workflow,intranet-username-collab,todoloop-command}`、`refactor-dev-{native-stage-retirement,native-state-retirement,native-workflow,webgui-project-host,webgui-requirement-intake,webgui-workbench-retirement,webgui-workbench}`、`refine-compact-output-preview`、`revamp-compact-activity-dock`。这里只分类既有数据，未执行第 7 节逐项材料核对或迁移；AIReq 相关遗留仅记录，不改其业务。
  - 范围与结果：只读检索仓库源码、测试、文档和项目元数据，未访问仓外个人配置／Skill，未解包旧构建资源，未运行测试或构建；仅更新本条状态与证据，不全局替换、不删除文件、不推进下一项。
- [x] 确定 `update` 剩余职责。当前 vendor `src/core/update.ts` 主要是 Skill／命令交付、profile 同步及迁移；删除这些后若没有与交付无关且必须保留的项目操作，则本计划采用删除 `update` CLI 入口及专属实现。任何确需保留的独立职责先写明实际消费者，不能凭函数名保留整套旧交付链。
  - 结论：采用删除 `update` CLI 入口及专属实现。`src/core/update.ts:177-182` 的 plan 只记录同一个 execute；`:209-630` 的主流程及辅助方法负责工具目录／profile 迁移、交付版本与内容漂移检测、Skill 生成与共享安装、旧命令对账、取消选择的 Skill／历史产物／全局提示词清理，以及交付结果提示。全局配置写入用于交付 profile 迁移，并非独立的项目配置升级；未发现更新业务 artifacts、schema、store 或项目数据的独立必要操作。
  - 额外职责已核对：`src/cli/index.ts:356-425` 还包含上游 CLI 版本探测、交互自升级及升级后重跑 update，不仅是文件刷新。但内置 OpenSpec 随 OMP 发行升级，合同禁止新增自动更新／下载机制，因此该入口的独立安装升级链不是必须保留的项目职责，也不能据此保留 update；本轮未执行网络检查或升级。
  - 实际消费者：vendor `src/cli/index.ts:324-438` 注册普通及 dry-run／JSON 路径；`src/commands/config.ts:690-713` 在 profile 修改后可直接实例化 UpdateCommand 应用交付配置，`:341-345` 等位置给出 update 指引；`src/core/completions/command-registry.ts:38-56` 注册补全；宿主 `test/spec-driven/resources.test.ts:215` 仍断言 update 成功。配置侧直接调用也是旧交付旁路，后续必须与入口一起清除，不能仅删除命令注册。
  - 后续删除边界：清除 update 注册／专属实现、补全、调用方及过时提示，按实际剩余消费者处理公开导出和 version-check 的专属升级／重跑辅助函数；共享 `update-plan`、migration、配置、模板及安全工具不能按名称整文件删除，init 等仍有消费者。保留 `openspec-update-change` 业务 Skill；不改原生同步／归档语义，不清理用户旧 Skill／命令。
  - 本项只完成源码职责判定及删除决策，未实施删除、未更新权威规格、未运行测试或构建；仅更新 todo.md，其他未完成事项保持原状态。

## 2. 先同步相关权威需求

本节按待办逐项同步规格；勾选仅表示对应需求文档已更新，不代表实现、资源生成或验收已完成。

- [x] 更新 `openspec/specs/spec-driven-orchestration/spec.md` 的“包内技能发现与资源兼容”：改为内置 OpenSpec 2.0 Skill、任意目录通过原生发现／补全／按需读取／调用使用，CLI 统一 `omp openspec`；删除五项限制、排除 apply、仅需求版正文和旧 opsx 文件命令交付条款。
  - 已替换该章节 OpenSpec 表格行及旧 opsx 交付段落：规定内置 Skill 的原生发现、补全、按需读取、显式调用与授权，统一宿主 CLI，撤销五项／apply 限制、需求专用正文及旧文件命令入口要求，保留上游工作流语义、同名覆盖及显式初始化边界。
  - 仅修改上述需求条款并核对编辑结果；Superpowers／JCH 与 AIReq 专属条款未改，12 项完整清单、init／schema／update 等后续待办保持未完成。本轮未改实现、配置或测试，未运行测试或构建，不宣称新合同已实现。
- [x] 明确内置全部 12 项 Skill 均通过原生机制可用；普通会话不再施加旧五项过滤。模型实际使用仍遵循原生授权；本轮不增加 AIReq 专用 Skill 过滤或阶段策略绑定。
  - 已按 vendor `skills/` 实际目录核对 12 项名称，并在 `openspec/specs/spec-driven-orchestration/spec.md` 的“包内技能发现与资源兼容”中逐项列明；统一适用原生发现、补全、按需读取、路径授权及显式调用，禁止旧五项白名单，明确可发现／读取不授予执行权限，不新增 AIReq 专用过滤或阶段绑定。
  - 仅完成需求文档同步并核对编辑结果，不代表发现实现已放开全部技能；未改实现、配置或测试，未运行测试或构建，其余待办不变。
- [x] 将初始化要求改为“不交付 Skill／命令，不触碰已有文件”，保留上游项目路径、配置、语言、重复初始化保护、store 指针与错误语义；删除强制追加 tools=none 和默认 mini 的条款。
  - 已更新 `openspec/specs/spec-driven-orchestration/spec.md` 的初始化合同及对应场景：init 自身保证不安装、复制、链接、更新或清理 Skill／旧命令，不依赖宿主强制注入 tools 参数；新项目默认上游 `spec-driven`，保留项目路径、语言、已有配置／重复初始化保护、store 指针拒绝和原生错误语义，非 TTY 不要求选择交付工具。
  - 已核对编辑结果；原 update 及 AIReq 专属条款保留给后续对应待办，本项不进行普通 OpenSpec 与 AIReq 的完整解绑。仅修改需求文档及本文件，未改实现、项目配置或测试，未执行测试／构建，不代表 init 实现已完成适配。
- [x] 将普通 OpenSpec 与旧包内 omp-spec 技术约束解绑，明确普通入口使用上游 spec-driven，不受 AIReq 旧假设约束。AIReq 专属需求暂不重新定义、删除或实现；若同一规格文件中仍保留其旧条款，明确其不约束普通 OpenSpec，后续由 AIReq 需求另行确定。
  - 已在 `openspec/specs/spec-driven-orchestration/spec.md` 明确普通入口沿用上游通用 `spec-driven`、原生产物依赖与校验及显式 schema 解析，不以 AIReq 旧假设要求固定包内 omp-spec、私有注入或目录桥接，不删减 design／tasks，不自动迁移用户配置或 change。
  - 已为保留的 AIReq 旧 schema 章节添加专属适用范围：不约束普通 OpenSpec、不要求本轮恢复旧资源，AIReq 后续需求另定；原专属条款未重写、删除或实现，不将接入／兼容／隔离作为本轮验收条件。
  - 已核对编辑结果；本次仅同步需求与待办，未修改实现、配置或测试，未运行测试或构建，不代表运行代码已完成解绑；update 等其余待办保持未完成。
- [x] 依据第 1 步确定的实际职责写明 update 的保留或移除结果，不继续要求通过 update 升级内置 Skill。
  - 已更新 `openspec/specs/spec-driven-orchestration/spec.md`：根据第 1 节职责结论规定移除 update 入口及专属实现，清除导出／补全／帮助／配置侧自动应用及旧更新提示；调用按正常未知命令非零退出，不保留别名、无操作成功或“已是最新”。
  - 明确 Skill 与运行资源仅随 OMP 发行更新，不通过 update 或新增运行时自动下载／自升级替代；保留 `openspec-update-change` 业务 Skill、仍有消费者的共享能力及用户已有文件，AIReq 专属正文未改。
  - 已核对编辑结果；仅完成需求同步，未实际删除 CLI 或代码，未修改配置或测试，未运行测试或构建；实现与验收及其余待办保持未完成。
- [x] 按实际关联检查 `openspec/specs/model-and-skill-discovery/spec.md`、`openspec/specs/fork-runtime/spec.md`、`openspec/specs/personal-commands/spec.md`，只修改与本次内置发现、入口、离线交付直接冲突的条款；无冲突不改。保留其他已批准能力。
  - `model-and-skill-discovery/spec.md`：核对 Codex 用户技能、共享目录单层发现／同名优先级、来源启停／刷新及 managed-skills 根链接管理边界；均不要求安装 OpenSpec Skill、不规定五项白名单或 opsx 入口，与复用原生发现及授权的合同无直接冲突，未改。
  - `fork-runtime/spec.md`：核对 offline 不访问公网／不回退下载源、统一数据根与缓存、发行资源及现有 `omp update` 规则；未规定独立 OpenSpec 安装或旧 schema／入口。`omp update` 是 OMP 本体更新，不是拟移除的 `omp openspec update`，其既有能力保持；AIReq／WebGUI／OpenWiki 专属资源约束不扩写为本轮适配，未改。
  - `personal-commands/spec.md`：核对原生命令派发门禁与 Developer Test Agent 的独立资源／显式调用规则；检索 OpenSpec／opsx／omp-spec／旧版本与参数引用，仅发现 AIReq 提案场景中的 OpenSpec 材料称谓，不涉及普通 OpenSpec 交付。其他功能的“五个技能”不属于旧 OpenSpec 五项限制；无直接冲突，未改。
  - 本项仅完成相关条款检查，三份规格均保持原样；未将文档检查表述为实现或发行验收，未运行测试或构建，未推进下一项失效约束清理。
- [x] 删除规格中已失效的具体实现约束，不把“文档已更新”写成实现已完成，不用旧需求迫使新实现恢复魔改。
  - 已检索并核对 `openspec/specs/spec-driven-orchestration/spec.md` 的普通 OpenSpec 合同：前述同步已撤销固定 core 五项及 init 生成正文基准、排除 apply、需求专用正文、opsx 文件命令交付、宿主强制 tools=none、默认 mini 和沿用上游 update 的旧要求；本轮未发现需要额外删除的普通 OpenSpec 失效约束，故不为完成待办重复修改规格。
  - 当前 mini／tools／opsx 等引用是禁止恢复旧行为的负向合同，不是继续依赖旧实现；保留的 omp-spec 固定来源与目录比较属于明确限定范围的 AIReq 旧条款，按已确认边界不删除、不实现，也不据此恢复普通入口的私有 schema 或桥接。Superpowers／JCH 的既有约束保留。
  - 规格已明确需求更新不代表实现、资源生成或验收完成；本轮仅完成文档清理结果核对并更新状态，未宣称运行代码已适配，未改实现／配置／测试，未运行测试或构建，不推进第 3 节资源实现。

## 3. 准备可发行的内置运行资源

重点文件：`packages/coding-agent/scripts/spec-driven-resources.ts`、`src/spec-driven/resource-inventory.ts`、`src/spec-driven/resource-archive.ts`、`src/spec-driven/vendor/inventory.json` 及实际 binary／npm 构建调用方。

- [x] 保留 vendor 源码作为维护基线，构建阶段从当前裁剪源码准备运行产物及所需生产依赖；不手改 dist，也不要求目标用户运行 pnpm、安装 Node 或访问上游源码目录。
  - 在 `packages/coding-agent/scripts/spec-driven-resources.ts` 实现 `prepareOpenSpecRuntime()`，返回调用方持有并清理的 TempDir：用 Bun 转译当前 vendor src 到独立 dist，保留模块相对布局，复制 bin／schemas／skills／assets／LICENSE；vendor 源码与原有 dist 均不改写。
  - 构建主机使用 Bun 从 pnpm 锁迁移并冻结安装生产依赖，staging package 同步锁中的 overrides；禁用生命周期脚本，不运行 vendor 的 Node／pnpm／tsc 构建。异常清理自有临时目录，运行使用 OMP 自带 Bun，不需要用户单独安装 OpenSpec、Node 或 pnpm。依赖准备允许构建阶段使用包缓存或注册源，不在运行阶段安装。
  - Windows Bun 1.4.4 的隔离验证通过：准备后将运行树移到另一临时目录，清空运行 PATH 并隔离 HOME／配置／数据／缓存；真实执行 --version（2.0.0）、schema which（包内 spec-driven）、new change、status（proposal／specs／design／tasks 原生图）、instructions proposal（读取模板）；确认运行树没有 src 或 TypeScript 开发依赖，临时项目与运行树已自动清理。未运行全仓测试、类型检查、npm 或二进制构建。
  - 已更新包 CHANGELOG。仅完成运行树准备能力；接入现有资源生成／发行构建、旧归档清理、完整闭包检查、清单指纹与宿主加载失效规则仍属后续未完成项，不宣称当前 omp openspec 已切换到新资源或完成最终适配。
- [x] 接入已有构建链，复用相同资源生成入口；源码开发的资源准备、npm 打包、编译二进制都必须取得同一版本的运行文件，不各写一套 OpenSpec 构建器。
  - `buildSpecDrivenArchive()` 现在调用 `prepareOpenSpecRuntime()`，将运行树移入自有 staging，与原有 Superpowers／JCH／omp-runtime 一同收集、打包；临时树自动清理。既有 `bundle-dist.ts` 和 `compile-binary.ts` 的调用直接复用此入口，无须另写构建器。
  - 根及 coding-agent package 增加 `gen:spec-driven-resources`，脚本直接执行时通过同一个归档生成器写入 `dist/spec-driven-resources.tar.gz`。`resources.ts` 的源码／SDK 路径统一读取准备归档，不再因 vendor/node_modules 存在而绕过；打包路径仍由同一个 file-loader 插件提供归档，保留原摘要、路径及锁定提取逻辑。同步更新 `resource-archive.ts` 说明和包 CHANGELOG。
  - 实际执行 `bun run gen:spec-driven-resources` 成功；隔离 HOME／配置／缓存后，真实源码 CLI `openspec --version` 返回 2.0.0。另以现有插件构建临时 Bun bundle，验证其真实加载结果与源码准备归档 manifest 完全一致、版本 2.0.0 且包含全部 12 项 OpenSpec Skill；临时 bundle／缓存已清理。
  - 本轮未执行完整 npm 打包或二进制编译，未宣称两种发行产物验收通过；旧同类归档清理、指纹失效、完整依赖闭包门禁及后续 vendor／Skill 适配仍未完成。生成归档仅为当前源码的中间产物，后续修改后必须重新准备；仅勾选本项，不推进其余待办。
- [x] 在使用源码入口前，核对并移除仅属于本功能的旧生成归档 `packages/coding-agent/dist/spec-driven-resources.tar.gz` 及实际使用的同类旧产物，保留无关 dist 文件；接入重新生成流程，禁止存在旧归档就自动将其当作有效资源。
  - 核对 dist 中本功能归档：固定名 `spec-driven-resources.tar.gz` 为前轮准备的 2.0.0，散列名 `spec-driven-resources.tar-29519j9k.gz` 为 1.15.0；两者均无新运行格式标记。仅移除这两个已确认生成文件，未删除其他 dist 内容；固定名归档随后由 `bun run gen:spec-driven-resources` 重新生成，旧散列名归档不再存在。
  - `resource-inventory.ts` 为新 manifest 写入 `runtimeFormat: 1`，`resources.ts` 在读取 manifest 后、缓存命中及提取／执行前拒绝无标记或不支持格式的归档，明确提示重新运行准备命令；不以文件存在或旧缓存标记作为接受依据。
  - 隔离配置／HOME／缓存下真实源码 CLI 验证通过：分别放入旧 1.15.0 与前轮无格式标记的 2.0.0 归档，均非零退出并提示准备入口；移除归档后同样失败、不回退；经既有命令重建后 manifest 格式为 1、版本 2.0.0，`openspec --version` 成功输出 2.0.0。临时验证目录已清理，已更新包 CHANGELOG。
  - 本项仅建立旧格式切断及清理／重建路径；同格式下源码／Skill／依赖锁指纹比较、完整依赖闭包门禁与最终资源验收仍未完成，不勾选后续事项，不把此中间归档当作最终适配产物。
- [x] 第 3 步先建立资源生成、就绪检查及失效规则；第 4～6 步完成后再从最终源码和 Skill 重新生成运行资源供第 9 步验收。不得在后续源码修改后继续使用第 3 步的旧中间产物。
  - 新增 `src/spec-driven/resource-fingerprint.ts`：对 OpenSpec 源码、bin／schema／Skill／assets、许可证、package／依赖锁、inventory 及宿主生成／加载／格式相关源码计算确定性 SHA-256，排除生成 dist 与安装依赖目录，避免产物自我失效。
  - 共用生成器在准备前记录指纹，打包前再次核对，准备期间输入变化则拒绝交付；manifest 携带 sourceFingerprint。源码／SDK 加载在缓存命中前比较当前输入指纹，不匹配或缺失则报错并提示 `bun run gen:spec-driven-resources`，不继续用同版本旧中间归档。既有旧格式拒绝和字节摘要提取规则保留。
  - Windows 隔离验证通过：上轮无指纹中间归档被拒绝；重新准备后真实 CLI 输出 2.0.0；篡改为旧指纹时即便已有热缓存仍拒绝。临时输入树分别修改源码、Skill、锁、生成器及加载器均改变指纹，写入 dist 产物不改变指纹；验证归档已恢复，临时材料已清理。已更新包 CHANGELOG。
  - 本勾选表示第 3 步的阶段规则已建立，不代表第 4～6 步或最终重建已执行。后续 vendor／Skill 修改将使源码归档失效，必须在这些步骤完成后通过共用入口重新生成再进入第 9 步验收；本轮生成物仍是中间产物。完整 staging／依赖闭包门禁、发行嵌入预期指纹核对及最终形态验收保留给后续未完成项，未运行完整 npm／二进制构建或全仓测试。
- [x] 打包前检查实际 staging 根的 `dist/cli/index.js`、`bin/openspec.js`、package.json、schema、Skill 和生产依赖闭包齐全；沿用 node_modules 交付时必须检查该目录及必要依赖可解析，不能只判断目录存在。不允许生成摘要自洽但启动必失败的归档。
  - 在共用生成器中新增 `assertOpenSpecRuntime()`，于实际 staging 的 openspec 根、收集摘要及打包之前执行；检查 CLI／bin／package／许可证文件、node_modules 目录、vendor 清单中的全部 Skill、各 schema 及其声明模板，复用 canonical containment 校验，不以目录存在代替资源完整。
  - 复用既有 package-directory 定位工具递归检查生产 dependencies 及存在的 optionalDependencies，核对每层 manifest 的实际包含边界；再用 Bun 对真实 CLI 及其静态可解析的惰性模块图执行内存构建，拒绝缺失入口、导出或传递模块。未运行用户项目、模型或联网业务命令，不将任意动态字符串加载宣称为静态可证明。
  - 首轮门禁发现原转译器保留了仅用于类型的 Spec／Change 等导入，导致 parser 模块缺失导出；已启用 Bun 的 trimUnusedImports，与上游 TypeScript 类型导入消除语义保持一致，未改 vendor 业务源码。
  - Windows 隔离验证通过：完整生产运行树通过；逐项移走 CLI、bin、package、schema、模板、Skill、node_modules、必需包及依赖真实入口共九类情况均拒绝。真实 validate 命令可加载 parser 图，不再出现类型导出错误；执行 `bun run gen:spec-driven-resources` 已通过新门禁并重新生成中间归档。验证修改仅发生在自有临时树，已恢复并清理。
  - 已更新包 CHANGELOG，仅勾选本项；未运行完整 npm／二进制构建、全仓测试或最终业务验收，其余资源裁剪、路径交付与发行指纹待办保持未完成。
- [x] 不将完整 vendor 开发树直接打入运行归档。归档包含实际 CLI 运行产物、package.json、schema／模板、全部内置 Skill、生产依赖及许可证；保留文档在仓库中，不因打包排除而删除文档源文件。
  - 运行树保持显式交付范围：bin、转译 dist、package.json、schemas（含模板）、skills、生产 node_modules 及 LICENSE；在自有 staging 安装后移除 pnpm／Bun 锁文件，不复制无 CLI／schema／Skill 消费者的 assets 文档截图。vendor src、README、install、docs、构建配置及依赖锁均留在仓库，不删除文档源文件，不裁剪 Superpowers／JCH。
  - 同步资源输入指纹，移除不再参与运行交付的 assets 截图目录；依赖锁仍是生成输入，但不作为运行文件交付。
  - `bun run gen:spec-driven-resources` 成功；检查真实归档的 openspec 根恰为上述七类、包含全部 12 项 Skill，并确认 README／install／docs／原始依赖锁与截图仍在 vendor。隔离目录解包后清空 PATH，真实 CLI 输出 2.0.0，new change 与 instructions proposal 成功读取包内模板；临时目录已清理，已更新包 CHANGELOG。
  - 仅完成运行归档裁剪；未运行完整 npm／二进制构建或最终业务验收，后续独立路径、缓存、来源元数据及发行指纹待办保持未完成。
- [x] 保持 bin／dist／package.json／schemas 的相对路径满足上游解析；生产依赖不得链接到仓库外的 pnpm store 或个人开发目录。
  - 核对现有运行树保留原生模块布局；staging 检查复用真实路径 containment 校验，归档收集同样拒绝指向资源根以外的链接，不依赖开发机 pnpm store 或个人目录。已有实现满足本项，本轮未添加重复逻辑。
  - Windows 隔离验证通过：将真实归档解包到含空格及中文的新路径，从另一项目 cwd、空 PATH 执行 CLI，版本为 2.0.0；schema which 的真实路径严格等于新运行树 schemas/spec-driven，new change 和 instructions proposal 成功读取模板。遍历解包生产 node_modules 未发现符号链接，运行不需源码目录或外部依赖树。
  - 在自有临时树将必需包 commander 改为指向运行根外开发目录的 junction，staging 门禁与归档收集均明确拒绝；随后恢复并自动清理临时材料。仅完成本项验证并更新状态，未改实现／配置／测试，其余待办保持未完成。
- [x] 保留清单摘要校验、资源 containment、锁及内容摘要缓存切换；不靠手工清空全局缓存生效，不回退旧归档掩盖新资源缺失。
  - 已核对 `resources.ts`：manifest 内容决定缓存目录，既有文件锁包围提取与切换；临时树逐文件做 canonical containment 和 SHA-256 校验，全部通过后才写完成标记并切换缓存，失败不进入旧资源回退。本轮未修改现有实现。
  - Windows 隔离场景通过：两个进程并发冷提取收敛到同一完成目录；修改 fixture 内容及对应摘要后自动选择新缓存目录并读到新字节，无须清空全局缓存；损坏快照被摘要校验拒绝且保留此前完成缓存；归档缺失时即便已有缓存也失败、不回退；父目录穿越路径明确拒绝。链接 containment 的实际 junction 拒绝证据沿用上一项。
  - 首次验证 fixture 误用未压缩 tar，已改为符合实际格式的 gzip tar 后完成上述验证，未为 fixture 错误修改实现。归档原始字节在 finally 中恢复，隔离缓存及临时目录已清理；仅勾选本项，未改代码／用户配置／现有测试，未执行完整发行构建。
- [x] 区分源码来源 revision 与实际运行资源摘要，修正 inventory／manifest 的记录及必要类型；不能把裁剪、适配后的字节宣称为未修改的官方 npm 包 integrity。
  - `vendor/inventory.json` 将 OpenSpec 的 `integrity: git:...` 改为真实含义的 `revision`，保留原来源提交；manifest 类型与生成器同步删除旧 integrity 字段，不留兼容别名。
  - manifest.openspec 新增 `runtimeSha256`：对按路径排序的 OpenSpec 运行文件记录（相对路径、实际字节 SHA-256、可执行标志）计算 SHA-256。来源 revision、生成输入 sourceFingerprint、运行树摘要及逐文件摘要分别表达不同信息，不冒充官方 npm 包 integrity。
  - `runtimeFormat` 升为 2，加载器拒绝旧格式；通过既有准备入口重新生成。Windows 隔离验证通过：从真实归档字节逐文件复算再汇总的摘要与 runtimeSha256 一致；临时 fixture 改变运行字节只改变运行摘要、不改变来源 revision，恢复字节后摘要恢复；真实源码 CLI 输出 2.0.0。临时材料已清理，已更新包 CHANGELOG。
  - 仅完成本项元数据切换，未运行完整 npm／二进制构建、全仓测试或最终业务验收；下一项发行预期指纹与不完整资源加载门禁保持未完成。
- [x] 加载本地运行树或 dist 归档前，将其生成指纹与当前目标源码／Skill／依赖锁及宿主资源格式对应的预期指纹比较；旧格式、陈旧指纹或不完整资源必须明确报错并提示准备入口，不能静默回退。只核对版本 2.0.0 不足以区分同版本适配前后的产物。
  - 源码／SDK 继续仅使用准备归档，并在缓存命中前比较当前目标输入指纹。共用发行插件改为异步，独立计算当前构建目标的 sourceFingerprint 并嵌入归档 SHA-256；npm／二进制构建调用方同步 await。加载时同时核对内嵌字节摘要与预期来源指纹，不再跳过发行模式的指纹比较，也不以归档自身声明作为发行预期值。
  - 加载器在命中完成缓存前检查必要 CLI／bin／package／默认 schema 记录、Skill 记录及所有已声明文件的实际归档字节与 SHA-256；无 manifest、损坏 manifest、缺少文件或摘要不符均明确提示准备入口。保留提取时的路径 containment、摘要复核及锁定切换，不增加本地 vendor 回退或运行时安装／构建。
  - Windows Bun 1.4.4 隔离验证：重新准备后源码 CLI 为 2.0.0；已有热缓存时，无格式／旧格式、同版本旧指纹、缺 CLI、缺 commander 依赖文件及缺 manifest 均被拒绝。临时真实 bundle 使用同一插件可运行 2.0.0；替换 asset 被固定字节摘要拒绝，构建时传入同版本旧指纹归档也被独立目标指纹拒绝；归档已恢复，恢复后的源码 CLI 成功。
  - 验证脚本初次使用无效 outfile 参数、随后临时 bundle 缺少原生库；仅修正自有验证器的输出路径并携带现有本机原生库后通过，未为这些验证环境错误改产品逻辑。临时脚本、bundle／隔离缓存及自有根目录输出已清理；已更新包 CHANGELOG。未执行完整 npm／二进制构建或全仓测试，只勾选本项，下一项仍未完成。
- [x] 明确源码检出缺少准备资源时的准备入口与可操作错误；运行时不偷偷联网安装或构建，不引入依赖用户机器路径的回退。
  - `resources.ts` 对源码／SDK 固定 dist 归档读取的 ENOENT 使用既有 isEnoent 判断，改为说明缺少运行资源、归档位置、`bun run gen:spec-driven-resources` 及其 coding-agent 执行目录；保留原异常 cause，其他读取错误原样传播，不以存在性预检查或自动准备替代读取。
  - 未增加联网、安装、构建、vendor/node_modules 或个人目录回退。准备仍只由显式现有命令执行，已同步包 CHANGELOG。
  - Windows Bun 1.4.4：显式重新准备成功；隔离 HOME／配置／缓存、空 PATH、仓外 cwd 下，真实源码 CLI `openspec --version` 输出 2.0.0。随后暂存归档，已有热缓存时仍非零退出，错误含准备命令及准确执行目录，不输出旧版本成功结果，也未重新生成归档；finally 已恢复归档，临时脚本及隔离目录已清理。
  - 仅勾选本项；未修改 vendor 初始化／更新逻辑，未运行完整 npm／二进制构建或全仓测试，第 4 节及以后保持未完成。

## 4. 先将 vendor init/update 收敛为内置交付模型

以下 vendor 路径均相对 `src/spec-driven/vendor/resources/openspec/`。本步先于第 5 步移除宿主参数注入，避免 vendor 仍能安装 Skill 时宿主提前放开旧交付路径；两步作为同一完整变更交付，中间态不作为可运行成果。

- [x] 在 `src/core/init.ts` 保留项目校验、目录结构、默认 spec-driven 配置、语言上下文、目标路径、重复初始化／已有配置保护、store 指针拒绝规则。
  - 保留现有路径规范化、写权限校验、specs／changes／archive 目录及锚点创建、默认 spec-driven、语言校验与 context 写入、重复初始化及 config.yaml／config.yml 保护；不重新实现这些已有职责。
  - 将有效 store 指针根目录原“仅安装 integrations”分支改为与子目录同样拒绝，提示在 store 根目录初始化；继续拒绝无效指针，在交付迁移／提示／规划文件写入之前退出。移除失去用途的 integrationsOnly 分支及 resolveOpenSpecRoot 导入，不改 store 解析或其他命令。
  - Windows Bun 1.4.4 隔离临时运行树验证通过：中文／空格目标目录、完整规划目录、默认 spec-driven 和语言 context；重复初始化保留配置及已有材料；config.yml 不覆盖、不另建 config.yaml；冲突及空白语言拒绝；有效／无效 store 指针在根及子目录均非零退出且配置与目录内容不变。
  - 验证直接运行准备后的 vendor CLI，使用现有 tools=none 避免调用尚未移除的交付链；不将此参数作为最终合同。临时运行树／项目／脚本已清理，包 CHANGELOG 已更新；未重建发行归档或执行完整 npm／二进制构建、全仓测试。源码修改会使前轮归档指纹失效，后续按第 3 节规则重建；仅勾选本项，不推进 Skill 安装链清理或宿主改写移除。
- [x] 从 init 执行链移除工具探测与选择、Skill 生成／复制／链接、profile 交付选择、旧命令对账、旧产物清理、用户全局目录迁移、写入前确认等仅服务 Skill 安装的分支。
  - `src/core/init.ts` 执行链仅保留项目校验、store 指针拒绝、语言保护、规划目录／锚点及配置创建；删除工具探测／选择、profile 解析、欢迎／写入确认、Skill 生成及共享安装、命令对账、旧产物清理与迁移的调用和本类专属方法、类型及 imports，不保留禁用分支或空实现。
  - 删除交付专用结果统计／失败报告／profile 引导及 IDE 重启提示，成功输出仅报告项目配置。InitCommand 构造参数只保留 language，普通 init 与 experimental 调用方同步不再传递已删除的交付参数；未删除共享模块或 update 的仍存消费者。CLI 旧参数注册／帮助及 experimental 入口删除仍按后续独立待办处理，本项不宣称全部入口合同完成。
  - Windows Bun 1.4.4 隔离临时运行树中真实执行 vendor init：不传 tools，预置项目 Skill、旧 opsx 命令、旧工具目录及带旧标记的项目说明、用户全局 prompt／profile 后，首次及重复初始化均只创建／保留正确 spec-driven 项目配置，全部预置文件字节和相关目录集合不变；空项目仅新增 openspec/。实际输出已观察，不再显示工具安装或清理结果。
  - 首次验证将 Bun 自身转译缓存新增误计为 HOME 业务变更；仅把验证器转译缓存重定向到独立临时路径后通过，未为此修改产品逻辑。临时脚本／运行树／项目均已清理，已更新包 CHANGELOG；未重建发行归档、运行完整 npm／二进制构建或全仓测试。仅勾选本项，其余待办保持原状态。
- [x] 同步 `src/cli/index.ts` 的 init 选项／类型／帮助：删除仅服务交付的 tools、profile 等参数；force 等参数按剩余真实用途决定是否保留，不能给已移除参数保留兼容别名或静默忽略。
  - init 仅保留业务语言参数及 Commander 自带帮助；tools／profile 仅服务已删除交付链，force 仅用于已删除的旧产物自动清理，no-animation 仅用于已删除欢迎界面，因此全部移除，不提供兼容别名或忽略逻辑。同步缩减 action 参数类型，删除无消费者的工具列表及说明生成。
  - 同步 `src/core/completions/command-registry.ts` 的 init flags，避免补全继续推荐已拒绝参数；其他命令的同名参数及 experimental 入口不在本项删除范围。
  - Windows Bun 1.4.4 隔离临时运行树验证通过：真实 init --help 只显示 language 与 help；真实生成的 Fish 补全不再提供上述四项 init 参数。逐项传入旧参数均返回正常 unknown option 非零退出，目标目录保持空；language 仍生成 spec-driven 配置并记录指定语言 context。
  - 已清理临时脚本／运行树／项目并更新包 CHANGELOG。未重建发行归档或运行完整 npm／二进制构建、全仓测试；宿主强制 tools=none 仍按第 5 节后续任务移除，本轮不把中间态宣称为完整 omp openspec init 验收。只勾选本项，其余任务保持未完成。
- [x] 空项目非 TTY 执行 `omp openspec init` 不再要求选择工具；需要业务输入时使用现有配置／显式参数或给出明确错误，不以自动选语言、覆盖配置等新默认值替代上游约束。
  - 现有 init 执行链已无工具选择或交付提示，宿主也已撤销 tools=none 与 mini 改写；无语言参数时保留原生未指定语言状态，显式 language 通过原有校验写入 context，已有 config.yaml／config.yml 不覆盖，语言冲突明确失败。本轮核对相关源码，没有增加默认输入、特殊分支或配置写入。
  - 复用上一轮实际验证：隔离 HOME／配置／缓存、stdin ignore 下，真实源码 OMP 空项目 init 非零工具依赖已消除，成功输出 spec-driven、项目仅新增 openspec/、无虚构语言 context；同轮宿主窄回归为 1 pass、19 filtered、0 fail，覆盖显式中文语言、含空格目标路径、冲突语言拒绝及原配置字节保持。
  - 上述相关实现与通过结果对应的版本未变化，本轮不重复构建或测试，不将既有结果描述为本轮新运行。仅更新本项及顶部状态，其他未完成项不勾选；完整发行与集中验收仍未完成。
- [x] 按第 1 步职责结论处理 update。无独立职责时，从 CLI 注册、实现、公开导出、补全 registry、帮助、提示、配置刷新建议及调用方中完整删除；未知命令按正常错误退出，不返回“已是最新”等假成功。
  - 删除 vendor CLI 的 update 注册及普通／dry-run／JSON 分支，删除 core/update.ts（含 UpdateCommand、选项类型及仅供本类使用的 scanInstalledWorkflows 包装导出），移除补全 registry 条目；不保留别名、无操作成功或“已是最新”。
  - config profile 仍保存原有配置，但不再询问应用到当前项目、不调用 UpdateCommand、不输出 update 应用指引或交付漂移警告；删除仅服务该旁路的函数及 imports，修正过时引导注释。保留实际仍被配置／版本命令使用的共享能力，未按名称删除 migration／update-plan 等共享模块。
  - version-check.ts 删除 update 专属版本包装、升级提示、交互安装、自升级版本探测及升级后重跑函数，清理专属依赖；原生 version 报告及仍有消费者的版本检查／安装归属判定保留。不影响 OMP 本体 update，也不删除 openspec-update-change 业务 Skill；Skill 正文及其他文档更新仍按第 6、8 节独立待办处理。
  - 将旧“安装并更新集成”测试替换为移除合同回归：普通 update 与 dry-run JSON 均未知命令非零退出、stdout 为空且已有 Skill 不变；config profile core 实际保存配置、不创建项目规划或改写 Skill。显式重新生成资源成功，隔离窄测试结果为 1 pass、19 filtered、0 fail；真实 OMP 源码 CLI 同样拒绝 update，帮助与实际生成的 Fish 补全不再提供该命令，version --json 仍返回 2.0.0。
  - 帮助验证器首次把 version 描述换行中的“update availability”误判为命令；只修正命令行缩进匹配后通过，未为验证器错误修改产品。临时脚本／隔离目录已清理，已更新包 CHANGELOG；未执行完整 npm／二进制构建、全仓测试或完整交互 profile 验收。仅勾选本项，其他待办保持原状态；本次归档仍是待后续源码／Skill 修改后重建的中间产物。
- [x] 沿调用图清理失去用途的安装／对账／迁移／profile drift／旧产物指纹辅助代码。只删确已无消费者的部分；保留仍被核心业务使用的配置、profile、模板生成和安全工具。
- [x] 检查 `experimental` 等旧别名是否仍可触发安装；无独立必要职责则随旧链路删除，不保留旁路。
  - 检索 vendor src 的 experimental 引用，唯一初始化别名注册位于 `src/cli/index.ts`，仅输出弃用提示并调用 InitCommand，没有独立业务职责；前轮已移除 init 安装链，但该别名仍会创建规划目录与配置，因此完整删除注册、专属选项及 action，不保留兼容入口或无操作成功。
  - 其他命中是 schema 的实验性说明、工作流标签／历史说明及未使用欢迎界面描述，不属于初始化入口，保持原样；不按单词全局删除，不改通用工作流或 schema。
  - Windows Bun 1.4.4 隔离临时运行树实测：experimental、experimental --tool oh-my-pi、experimental --no-interactive 均正常 unknown command 非零退出，stdout 为空，目标项目目录保持空。临时运行树／脚本／项目已清理，已更新包 CHANGELOG。
  - 仅勾选此项；前面的非 TTY 宿主初始化因仍有 tools=none 注入未宣称完成，update 及共享交付死代码清理保持未完成。未重建发行归档、运行完整 npm／二进制构建或全仓测试。
- [x] 全部路径均不得创建／修改／删除 `.omp/skills`、`.agents/skills`、其他 Agent 目录、旧命令及用户自定义 Skill。内置资源更新只由 OMP 发行升级承担。

## 5. 再缩减宿主 CLI 包装，移除旧定制

重点文件：`src/spec-driven/resources.ts`、`src/cli.ts`。完成第 4 步 vendor 交付逻辑移除后，再去掉下面的宿主参数注入。

- [x] 保留 `omp openspec` 分派、内置 Bun 执行、当前真实 cwd、参数／输出／退出码传递、中止与子进程结清。
  - 本轮源码核对：cli.ts 的 openspec 分派把原剩余参数、process.cwd() 和 AbortSignal 交给 runOpenSpec；按返回值分别写 stdout／stderr 并设置真实 exitCode，finally 移除 SIGINT／SIGTERM 监听。runOpenSpec 解析受信归档入口，使用 process.execPath 及 BUN_BE_BUN=1，不启动外部 openspec／Node。
  - 统一执行器保留 cwd、原参数和分流捕获，启动前检查已中止信号；运行中 abort 杀死自有子进程，postmortem 清理同样杀死并等待退出。输出读取与 child.exited 一起等待，中止后不返回成功，finally 移除信号监听、等待子进程并注销清理回调。本轮没有改动这些生命周期代码。
  - 普通入口的实际成功／失败证据沿用已记录的宿主 init、schema 查询及未知 update 非零退出结果；资源／指令窄回归最近为 1 pass、17 filtered、0 fail。中止与结清本轮仅核对源码，不声称新增了运行中信号验收，不重复运行未变化的场景。
  - 仅勾选本项；当前 stdin ignore 属于下一项交互 CLI／捕获输出 I/O 拆分的未完成问题，本项不把它描述为已解决。未执行完整 npm／二进制构建或全仓测试，其他任务保持原状态。
- [x] 删除 init 的 tools=none 强制注入、`setNewDefaultSchema`、mini 配置及输出改写；删除 new change 前的私有 context 探测和 schema 参数注入。
  - `runOpenSpec` 对 init／new change 不再特判、复制和修改参数，不预跑 context；直接将原参数交给包内 CLI，原样返回输出及退出码。删除 initTarget、hasProjectConfig、setNewDefaultSchema 及全部 mini 注入／输出改写逻辑，不改 vendor 的原生初始化／规划行为，也不新增参数解析或兼容分支。
  - 前置安全条件已由第 4 节已完成的 init 安装链及 update 移除满足；本项不恢复交付入口。archivePlan 环境、私有目录桥接及其他无关包装按后续各自待办处理，不在本次顺带删除。
  - 将旧 mini 图测试改为宿主原生默认合同：含空格目标路径及显式中文语言初始化成功，配置与输出均为 spec-driven；冲突语言非零退出且不覆盖原配置；无配置规划根执行 new change 后沿用原生 spec-driven 四产物图及默认配置。首次断言错误假设原生命令不创建缺省配置，核对 openspec-root.ts 后改为验证真实缺省配置内容，未修改 vendor 业务。
  - 重新生成资源成功；Windows Bun 1.4.4 隔离窄回归为 1 pass、19 filtered、0 fail。真实源码 OMP 非 TTY 空项目 init 成功，只创建 openspec/、默认 spec-driven、不虚构语言 context，已观察实际输出。临时脚本／项目／缓存已清理，已更新包 CHANGELOG；未运行完整 npm／二进制构建或全仓测试，只勾选本项。当前资源仍是后续源码／Skill 改动后须重建的中间归档。
- [x] 删除 `archivePlan` 私有参数、`OMP_AIREQ_ARCHIVE_PLAN`／`OMP_DEV_ARCHIVE_PLAN` 私有行为及无生产消费者的 `runOpenSpecDirectory`、`assertAIReqSpecSchema`、`specSchemaPath`；清理其测试引用。若发现实际消费者，明确记录影响，不借此扩展为 AIReq 适配或保留旧桥接。
  - 核对 coding-agent src／test／scripts 及跨包引用，实际消费者仅旧 resources.test.ts；未发现生产调用者。删除 runOpenSpec 的第四参数及 OMP_AIREQ_ARCHIVE_PLAN 注入，执行仅保留 BUN_BE_BUN；删除 runOpenSpecDirectory、assertAIReqSpecSchema 及资源类型／返回值中的 specSchemaPath，不保留 shim。未发现 OMP_DEV_ARCHIVE_PLAN 的运行代码消费者，不新增环境变量处理。
  - 删除仅约束已撤销私有 API 的固定包内 omp-spec／覆盖拒绝及目录桥接测试与专属 import。原“需求专用”指令测试改为上游 spec-driven，保留真实用户 context、proposal／specs instructions 和未知 change 的错误合同，不再要求两产物图或禁止 tasks；未修改 AIReq 会话、schema 或业务。
  - 显式重新准备资源成功；Windows Bun 1.4.4 隔离窄测试为 1 pass、17 filtered、0 fail。真实 OMP 源码 CLI schema which spec-driven --json 返回包内 schema；继承指向不存在文件的两项旧归档环境变量仍正常运行。未访问用户实际 change，临时脚本／目录／缓存已清理，已更新包 CHANGELOG。
  - 仅勾选本项；未运行完整 npm／二进制构建、全仓测试或 AIReq 验证，其余待办保持原状态。当前运行资源仍须在后续源码／Skill 修改后重新生成，不宣称最终发行验收完成。
- [x] 不以 init 参数特判替代第 4 步的干净项目初始化。其余命令尽量原样委托 vendor CLI，不额外解析上游业务参数。
  - 本轮核对 resources.ts：runOpenSpec 对所有命令使用同一路径，只解析可信运行入口，将原 args、cwd、signal 交给统一执行器，额外环境仅 BUN_BE_BUN；不存在 init／new change 分支、context 预探测、业务参数重解析、配置或输出重写。
  - vendor InitCommand 自身完成项目校验、store 指针拒绝、语言保护、目录／锚点与配置创建，已无工具选择及 Skill 交付链；不依赖宿主插入 tools=none 才避免安装。第 4 节尚未完成的共享死代码清理和完整文件保护检查保持原状态，不据本项宣称其全部完成。
  - 复用前轮已记录的真实证据：宿主 init／无配置根 new change 的 spec-driven 默认与冲突语言保护窄回归通过；最新私有桥接清理后的 context／proposal／specs instructions 窄测试为 1 pass、17 filtered、0 fail，真实宿主 schema 查询返回包内 spec-driven。核对结果足够，本轮没有实现变化，不重复构建或测试，不把既有结果表述为本轮新运行。
  - 仅更新本项与顶部状态，未勾选其他任务；交互 I/O、共享死代码及后续集中验收仍待完成。
- [x] 拆清交互 CLI 与捕获输出调用的 I/O：真实终端需要交互时不能继续忽略 stdin；工具／非 TTY 调用按明确非交互规则工作。不得让两种路径互相污染协议输出。
  - resources.ts 增加明确的 capture／terminal I/O 模式，runOpenSpec 默认 capture；公共执行器仅在 terminal 模式继承 stdin／stdout／stderr，避免子进程提示被捕获直到退出或无法接收键盘。继承模式不再次返回已输出的字节，捕获模式保留 stdin ignore、分流输出及真实退出码；中止与等待子进程逻辑不变，Superpowers 调用继续沿用默认捕获。
  - cli.ts 仅在自身 stdin／stdout／stderr 全部为真实 TTY 时显式选择 terminal，否则选择 capture。不按上游业务命令名特判，不让 SDK／工具因宿主恰有终端而自动进入交互模式。
  - Windows Bun 1.4.4：重新准备资源成功；隔离 API 捕获 config profile 的交互要求错误并以返回数据提供，非 TTY 真实 OMP CLI 同命令非零退出且 stdout 为空，version --json 仍可直接解析为 2.0.0。
  - 真实 PTY 中启动隔离配置下的 OMP openspec config profile，实际观察到原生选项界面，发送下箭头与回车后选中 Keep current settings (exit)，显示 No config changes 并正常退出 0；证明键盘输入已到达真实子进程，不是只检查浏览器或命令启动。终端会话、临时脚本／项目／缓存已清理，已更新包 CHANGELOG。
  - 仅勾选本项；未修改用户实际配置、AIReq 或其他入口行为，未运行完整 npm／二进制构建或全仓测试。当前归档仍为后续源码／Skill 更新后须重建的中间资源，不宣称完整发行验收通过。
- [x] 保留原有禁用遥测与 offline 运行边界，不擅自开启遥测，不增加新的自动更新／下载机制。
  - 核对统一执行器：capture／terminal 均强制 OPENSPEC_TELEMETRY=0、DO_NOT_TRACK=1；资源加载仍只读准备归档，缺失／失效报错，不在运行期安装、下载或构建。保留这些既有边界，不修改 Superpowers／JCH 或 AIReq。
  - 发现 vendor version --check 的 requested 路径会绕过遥测 opt-out，原宿主没有把 offline 传递给更新检查门禁。runOpenSpec 现复用 offlineFromEnv，仅在 offline 时设置既有 OPENSPEC_NO_UPDATE_CHECK=1；普通在线调用不额外设置，用户已有禁查变量仍继承。不改 vendor 通用语义，不增加自动检查或升级。
  - 新增隔离子进程回归 offline.test.ts：SDK 与真实源码 CLI 的显式 version --check --json 均返回 disabled，受控本机注册源连接为零；在线对照仍尝试同一本机注册源并返回 offline，连接为一。继承环境与配置均主动开启遥测时，宿主调用仍不创建匿名 ID 或改写全局配置。验证只用临时配置及本机回环，不访问公网注册源。
  - Windows Bun 1.4.4：bun run gen:spec-driven-resources 成功；bun test packages/coding-agent/test/spec-driven/offline.test.ts 最终 1 pass、0 fail、9 expect。首轮受继承的 TLS 禁验环境警告干扰，只在测试子进程恢复证书验证后通过，未修改用户环境或为警告改变产品行为。临时目录由测试自动清理，已更新包 CHANGELOG。
  - 仅勾选本项；未运行全仓测试、完整 npm／二进制构建或最终发行验收，其余未完成事项保持原状态。

## 6. 接入全部内置 Skill，统一命令正文

重点文件：`src/discovery/spec-driven.ts`、`src/spec-driven/skill-policy.ts`、`src/internal-urls/skill-protocol.ts`，vendor `skills/` 及实际生成正文的模板。

- [x] 删除旧 OpenSpec 五项白名单和旧 `commands/opsx-*` 文件命令 provider／注册；清理 import 与测试消费者。不恢复 `/opsx-*` 别名或新增第二套命令分发表。
  - discovery/spec-driven.ts 删除 OPEN_SPEC_CORE_SKILLS／OPEN_SPEC_CORE_COMMANDS、OpenSpec 专属过滤、loadSpecDrivenCommands 及 slash-command provider 注册，移除其专属 imports。Skill 继续按 manifest 逐项扫描与 containment 边界进入原生能力目录，不新增别名或分发表；Superpowers／JCH 发现及访问策略保持。
  - skill-policy.test.ts 将普通目录合同从五项改为完整 12 项，旧命令 provider 结果改为不存在；保留现有模型可见性、skill:// 补全／读取和隐藏 Superpowers 的合同。process-resources.e2e.test.ts 唯一旧 /opsx-propose 调用改为 /skill:openspec-propose，保留带空格／中文参数进入真实模型请求、无业务阶段注入及项目无改动的断言，没有删除宿主 E2E。
  - Windows Bun 1.4.4，隔离 HOME／配置／数据／转译缓存执行上述两个现有窄测试：2 pass、24 filtered、0 fail、219 expect。真实 OMP 进程经本机模型 fixture 完成原生 Skill 调用，参数到达模型请求；未运行 AIReq 测试或进入其会话。本次发现改动不在资源指纹输入内，复用有效准备归档，不重复重建。
  - 已删除临时验证脚本与隔离目录并更新包 CHANGELOG。只勾选本项；同名覆盖、其余原生发现／调用与真实 TUI 的完整验收、正文／模板改写及最终发行验证仍按各自未完成项处理，不据本次窄验证宣称全部接入完成。
- [x] 内置全部 12 项 Skill 走原生发现、补全、按需读取、路径授权和调用流程，支持 `/skill:<name>`；保留项目／用户同名资源的原有覆盖机制，不干预 Superpowers／JCH 的发现规则。
- [x] 将实际 Skill 正文、allowed-tools、compatibility 和安装前提中的可执行 `openspec ...` 改为 `omp openspec ...`；只改宿主入口与已撤销交付行为，不重新写成需求专用工作流。
- [x] 同步仍会产生这些正文的静态模板及声明源，避免以后生成又恢复裸命令；不在加载时叠加第二层字符串重写，不保留旧／新两套正文来源。
- [x] 区分文件路径、包名、项目目录 `openspec/`、协议字段和可执行命令，不全局替换单词 openspec。
- [x] 处理 Skill 中要求运行已删除 update／安装命令的步骤，改为实际内置交付说明，不误删名为 `openspec-update-change` 的业务 Skill；后者是更新需求材料，不是更新安装文件。
- [x] 未初始化项目仍按上游条件检查并请求显式初始化；“任意项目可发现 Skill”不意味着可以自动创建 openspec 目录。
- [x] 不为本轮接入修改 AIReq 会话创建、阶段策略、技能目录或权限绑定；共享发现规则按普通 OpenSpec 合同工作，AIReq 接入留待其需求确定，不将其作为验收门槛。

## 7. 处理本仓库的旧 schema 引用

- [x] 清点 OMP 根 `openspec/config.yaml` 和活动 change 元数据中实际存在的 mini／omp-spec 引用，逐项记录受影响产物；迁移前根配置为 `schema: omp-spec`。
- [x] 将本仓库默认配置迁移为上游 `spec-driven`，并逐个核对活动 change 后再更新其 schema 引用。不能只改名称就宣称原有 proposal／specs 已满足 design／tasks 等完整产物图。
- [x] 已有内容保留；缺少的设计／任务材料如实呈现为待完成，不伪造完成状态、不自动生成业务方案、不为了通过校验禁用 schema 校验。
- [x] 历史归档不批量改写；其他用户项目不自动迁移。文档说明旧自定义 schema 的影响，不恢复包内兼容 schema 或别名。
- [x] 本步骤仅处理 OMP 仓库自身作为 OpenSpec 项目的配置与活动材料，不修改 AIReq 专属配置、schema、流程或生产消费者；遇到相关遗留依赖记录事实，不提供兼容桥接或新业务实现。

## 8. 同步全部相关用户文档与项目约定

在实现和需求合同确定后执行，不能继续保留互相矛盾的说明。

- [x] 更新 `docs-zh-CN/quick-start-intranet.md` 中版本、内置资源、Skill 使用、初始化和离线说明：无需额外安装 OpenSpec，命令统一 omp openspec，Skill 随 OMP 升级。
- [x] 按当前源码实际行为更新根 `AGENTS.md` 中 OpenSpec 相关约定；保留其他已批准规则，不改用户全局规则文件。
- [x] 更新保留的 vendor `README.md`、`install.md`、`docs/` 及仍保留的有用文档：去掉独立安装、其他 Agent 设置、重复安装 Skill、已移除 update／opsx 入口；保留 schema、store、配置、工作流及排错内容。
- [x] 文档、CLI help、错误提示、completion 及 Skill 使用同一真实入口，不出现“代码已删除但文档仍要求执行”的步骤；历史 CHANGELOG 原发布内容不改写。
- [x] 检查 `docs-zh-CN/` 及仓库中实际引用旧五项、mini、omp-spec 和 opsx 的维护说明，按用途更新。生成式 OpenWiki 不手改陈旧生成正文；如需刷新按既有生成流程处理，不能将它列为额外人工规格来源。
- [x] 在 `packages/coding-agent/CHANGELOG.md` 的 Unreleased 简要记录 OpenSpec 2.0 内置适配、Skill 随包交付、旧入口移除及自定义 schema 迁移影响；不修改已发布条目。

## 9. 集中执行最小验收

先更新与新合同冲突的现有测试，再集中验证；只重试失败且确受修复影响的项，不增加无关全仓检查。

- [x] 更新 `test/spec-driven/resources.test.ts`：删除旧 mini／omp-spec 固定来源、私有 bridge、固定 1.15.0、强制 tools 参数等旧合同；保留资源摘要、路径约束、取消、真实退出码和离线加载覆盖。
- [x] 更新 discovery／`skill-policy.test.ts` 中与普通 OpenSpec 有关的五项限制和旧命令断言，验证全部内置 Skill 可达及同名覆盖规则；不新增或运行 AIReq 隔离测试，不以旧全局白名单恢复其限制，不检查源码或提示词固定措辞。
- [x] 将 `test/spec-driven/process-resources.e2e.test.ts` 等真实 `/opsx-propose` 入口改为原生 Skill 调用，保留参数透传和实际请求行为验证，不能简单删除整套宿主 E2E。
- [x] 在隔离 HOME／配置根／空项目中验证 init：生成正确项目配置，默认 spec-driven；不安装 Skill、不创建 Agent 专用目录、不触碰预置自定义 Skill／命令。覆盖非 TTY 默认路径及必要的已有配置保护。
- [x] 验证 update 的最终合同：已删除则 help／补全不再提供、调用返回正常未知命令错误；如保留真实职责则验证其实际状态变化，不能只断言“不抛错”。
- [x] 在无全局 openspec／Node 的环境，经 OMP 工具真实执行 Skill 中的 `omp openspec` 命令；完成临时项目 new change → status／instructions → validate → archive 的最小真实路径，保留设计／任务产物的原生约束，不触碰用户实际 change。
- [x] 用真实 TUI 观察任意目录 Skill 发现、补全及显式调用，覆盖普通主会话和实际子代理使用；确认不再加载旧 opsx 命令。此次不进入 AIReq 或验证其行为。
- [x] 分别对源码入口、npm 产物、二进制验证资源自包含及一致版本；移开源码资源、阻断运行时下载后仍使用内置资源。未实际验证的平台或形态明确列为未验证，不互相代称通过。
- [x] 验证资源失效路径：存在旧 1.15.0 归档、同版本旧指纹归档、缺 dist 或必要依赖时明确拒绝，不执行旧产物；重新准备后确认最终 manifest、运行版本及资源内容一致，运行归档不含旧 mini／omp-spec 私有资源。
- [x] 使用现有窄范围检查／类型检查／构建及测试入口，命令默认参数不随意变更；按用户本轮明确要求运行默认 `bun run fastcheck` 与 `bun run fulltest`，不直接运行 tsc，不另加独立 Rust、AIReq 浏览器或无关发布门禁。

## 10. 交付与停止

- [x] 汇总新合同、变更文件、实际验证及未验证项，确认需求、代码、Skill、CLI help 与文档一致。
- [x] 明确列出本仓库 schema 迁移结果及仍待完成的既有业务材料，不宣称旧需求因此自动实现；AIReq 不在本轮适配或验收范围，不能声称其兼容性或权限隔离已完成。
- [x] 清除本轮 throwaway fixture／验证脚本，不删除用户备份或无关文件；不留下旧兼容导出、空实现、双轨正文或失效入口。
- [x] 完成后停止；不提交、不推送、不发布，除非另有明确授权。

### 本轮实施与直接验证证据

- 删除 vendor 的交付闭环：migration／legacy-cleanup／update-plan／profile-sync-drift／released-output-sweep／shared-skill-target、core/shared、command-generation、旧欢迎 UI 及无消费者导出。配置、profile、schema 模板解析、store、校验／归档和安全工具保留；无消费者的 core/templates 同时退役，12 份实际 Skill 为唯一正文源，无二次加载改写。
- 12 份 Skill 的 executable／allowed-tools／compatibility 已统一宿主入口，保留项目路径／协议字段和业务工作流。README／install／vendor docs、内网指南、根项目规则与 Unreleased 同步；未修改用户全局规则、OpenWiki 生成正文或历史 CHANGELOG。
- 根配置及 12 份活动元数据已备份到 `openspec/.migration-backup/openspec-2.0/` 后迁移；原有材料 SHA-256 验证保持，逐项清单与缺失项见 `docs-zh-CN/openspec-schema-migration.md`。真实 CLI 对全部 13 个活动 change 返回 spec-driven 且 isComplete=false，未伪造 design／tasks 或业务完成状态。
- 隔离窄测试：23 pass、1 skip、0 fail，4438 expect；跳过为现有 Windows 条件下的原始脚本公共入口测试。其余覆盖资源摘要／路径、原生四产物与归档、12 Skill 发现／读取／补全、个人与项目同名覆盖、普通调用和 init 的预置 `.omp/skills`／`.agents/skills`／其他 Agent 命令及用户 Skill 保护。不把该跳过称为通过。
- 真实发行构建：调用既有 bundleDist 与 compileCodingAgent；源码、npm bundle、Windows x64-modern binary 均运行 OpenSpec 2.0.0。运行 npm／binary 时临时移走整个 vendor resources，PATH 只含验证安装的 omp.exe，仍可 init／new／status／instructions／schema 查询；源码资源已在 finally 恢复。npm 使用已安装的声明外部依赖（验证目录通过 junction 指向依赖树），未发布或安装全局包；不宣称 npm 无需声明依赖。
- 真实 BashTool 在仅含 omp.exe 的 PATH 下拒绝 node／裸 openspec，成功执行 omp openspec 的初始化、规划、status／instructions、严格校验及归档同步，断言主规格与归档状态；材料与项目全在临时目录。
- 最终资源检查：manifest runtimeFormat=2、版本 2.0.0、12 Skill、sourceFingerprint 与最终输入一致，无 mini／omp-spec schema。热缓存下，模拟 1.15.0 旧格式、同版本旧指纹、缺 CLI dist、缺 commander 依赖及归档缺失五种场景均明确拒绝并指向准备入口；恢复最终归档后真实 CLI 再次成功。未以 fixture 冒称取得并执行历史官方发行包。
- 实际生成 Bash／Zsh／Fish／PowerShell 补全均使用 omp openspec；help 不列 update，普通／dry-run JSON update 均未知命令非零退出。仅验证生成输出，不声称在未安装的四种 Shell 内完成交互验收。
- 真实 PTY 中观察 `/skill:openspec-` 补全首项到第 12 项 verify，`/opsx-` 无补全；主会话显式 `/skill:openspec-propose` 后，由真实 task 子代理读取 skill://openspec-propose，主会话消费子代理结果并正常退出 0。fixture 核验真实工具返回、提供模型响应的本机服务无失败、项目仍未初始化。两次前置 fixture 分别补齐 task context 与本机模型列表接口后最终通过，未为 fixture 限制修改产品。
- 平台范围：本机 Windows 10 x64、Bun 1.4.4；Windows baseline、Linux、macOS 产物未实测，不由当前 Windows modern 结果代称通过。未进入 AIReq 业务会话或新增其专项验收；用户明确要求的 fulltest 保持既有默认范围。
- 五个本轮 throwaway 验证脚本、实际 npm／binary 临时产物与项目、TUI fixture／终端会话已清理；仅保留明确要求的迁移原始备份和材料摘要。不提交、不推送、不发布。
- fast 首轮发现四个文件格式不合规及离线回归的闭包地址类型未收窄；仅对报告文件应用格式化，并在地址校验后捕获 port 常量。`packages/aireq-frontend/vite.config.ts` 与 `compact-tool-summary.ts` 仅为既有格式失败作格式化，不改业务行为；资源生成输入格式变化后已重新准备。最终默认 fast 通过，不把原有 lint 警告称为已消除。
- fulltest 首轮暴露遗漏的 TUI 五项旧合同、未准备的 OpenWiki 资源、入口资源未就绪仍可发布服务及旧 Compact 显示断言。已补齐 OpenWiki／AIReq 官方资源准备，仅修复共享 HTTP 应用发布前读取首页资源的既有就绪缺口，不改 AIReq 业务流程、会话、schema、Skill 策略或权限。思考测试按已批准的最新单行语义验证；保留编辑卡的测试等待合法的三秒临时预览结束后再核验完成活动行，保留逐帧稳定性与真实文件内容断言，没有放宽超时、增加 skip 或调整门禁。
- 首轮 Git 子进程超时没有确定的业务缺陷证据，未作猜测性改动或延长超时；最终默认门禁相关用例通过。中间失败均保留在各次测试报告中，不覆盖为成功。

### 最终默认门禁

|命令|实际结果|总耗时|
|---|---|---|
|`bun run fastcheck`|PASS，exit=0|21.3 秒|
|`bun run fulltest`|PASS，exit=0|312.5 秒|

完整报告：`runs/test-timing/2026-11-14T17-02-43.446Z-66340-4974396a/run.json`。fulltest 为既有默认 fork-features 范围，覆盖 TypeScript／Rust fork 用例、关联脚本、全项目静态检查、native 构建与 native-TUI smoke；不冒称运行 Python／Robomp、上游专属套件、真实桌面输入、凭据联网集成或独立 Go／Rust SDK。最终门禁后仅更新本状态文件，不再改实现、测试或资源。
