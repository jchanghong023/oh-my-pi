# Replace Dev TUI with Browser Workbench Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 一次性以真实浏览器工作台替换 Dev 专属 TUI，完整交付新需求的八阶段、五类原生 Agent、offline Collab、需求级 Git／PR 操作和人工决定；保留普通 OMP TUI、普通 ZCode 与其他独立能力。

**Architecture:** 同一 OMP 宿主持有 `SpecDrivenController`、原生 runtime／AgentSession 和长寿命 Bun 工作台服务；浏览器只呈现快照、订阅原生事件、提交明确动作。业务逻辑留在 `spec-driven/`，传输、网页会话适配和宿主生命周期集中于 `dev-workbench/`；复用 collab-web React transcript、Markdown、工具卡及 Composer，不建立第二聊天／执行引擎。每需求最小业务记录纳入 Git，本地原生会话和操作恢复资料保持本地。使用现有 native VCS 和 Forge runner，不调用整 index 提交 TUI，不创建分支或 worktree。

**Tech Stack:** Bun、TypeScript、React、现有 `@oh-my-pi/pi-wire`／CollabSocket／native crypto、`@oh-my-pi/pi-natives/vcs`、Rust `pi-vcs`／N-API、包内 OpenSpec 1.15.0、Superpowers 7.0.1、既有 Team／Goal／权限与资源插件、Bun 定向测试及隔离 Chromium 消费者测试。

**Spec:** `openspec/changes/replace-dev-tui-with-browser-workbench/proposal.md`；该变更下 `specs/dev-browser-workbench/spec.md`、`specs/spec-driven-orchestration/spec.md`、`specs/personal-commands/spec.md`；`docs-zh-CN/lander-sailor-six-stage-agent-workflow.md`，特别是 4.1、4.4—4.8 节。需求与既有主规格冲突时，以本次已批准变更的明确替代条款为准，不恢复已经清理的 Dev↔ZCode 条款。

**Status:** 实施及 Win32 x64／Bun 1.4.4 定向验收完成。参考四区、默认深色、右侧原生命令／技能输入已由真实 Chrome 观察并执行；八阶段 PR／独立测试／关联修复／复测／只读、未合入取消与原生问答／权限／附件场景均已有有效通过证据。普通 TUI 独占进入退出、原生 Goal、普通会话历史、Collab、ZCode及未受影响的 Git／native 结果复用；不重复跑已有效范围。源码、实际 npm CLI 与 Windows 独立二进制均已运行验证，具体来源和限制见账本。未执行 fulltest／slowtest、真实模型／外部 Forge 凭据／真实桌面 opener或其他平台验收；未 commit／push／发布，未执行 OpenSpec sync／archive。

## Global Constraints

- 一次性切换，只接纳本次新流程。删除旧 Dev UI、终端子操作、旧状态恢复／迁移与兼容分支；不删除已有用户材料、代码或 Git 历史。内部依赖波次不是分期交付，不允许只交网页外壳或保留双轨。
- Dev 与 ZCode 完全脱钩：只清退旧 Dev 专属 bridge、schema、projection、catalog、路由与消费者；不建设新 ZCode 适配、协议、协商、观测或控制，不扩展 OmpCode 跨仓交付。普通 ZCode 的会话、权限、动态 workflow、Team／Goal 等保持。
- 八个业务阶段与五个 Agent 角色分开；ST／PR／测试复用执行会话辅助而非新增三个专有 Agent。导入业务材料时允许没有业务 Actor／recipient。读取记录、查看阶段、打开页面均不启动模型、Team 或 Goal。
- 保留真实原生工具、MCP、扩展、模型设置、技能发现／按需授权、上下文、附件、队列、问答、审批、流式工具、子代理、Team 与 Goal；不能为浏览器采用裸 SDK 默认值、模拟 TUI context 或虚假的“执行成功”。当前资源发现规则按当前规格保留，不照搬旧计划示例中的过期发现集合。
- `/dev` 进入独占模式：普通任务未结清时拒绝进入，不自动终止普通工作；进入后当前TUI只接受再次 `/dev` 退出，不与网页同时执行普通输入、命令或快捷操作。退出先按原生机制停止并结清Dev工作、关闭服务，再恢复原普通会话；不取消需求、不撤销Git。关页不退出。借用原root及Provider／MCP，删除只为普通 `/new`／`/move`／dispose并存新增的快照、克隆或线程桥。
- Dev逻辑留在独立模块，公共层仅保留确实必需且默认不启用的接口；Collab通过网页适配器复用原引擎，普通调用恢复原接口。不新增网页全局Team／模型角色配置入口，继续原配置方式。仅完成明确需求和已证实直接缺陷，不顺带重构、扩展配置、抽象或兼容分支。
- 呈现参考 `runs/dev-workbench-demo/index.html` 和用户参考图的信息层级，不逐像素复制：左需求列表、中央材料上方八阶段、中央只读材料、右共享AI会话及底部输入。Dev默认深色，不改变普通OMP默认主题；只呈现当前进行阶段适用的必要控制，确认／结果就近显示，不铺开所有动作，不提供原生命令下拉框、JSON参数／状态／调试面板或内部hash控制台。输入复用现有内置斜杠命令和技能，不增加配置／权限／聊天引擎。
- 未选择需求时引导新建需求，不默认进入本地业务写作；本地写作须明确选择。无目标且未加入真实Collab会话时输入不可发送；打开页面不启动Agent或自动join。
- 第一至第五阶段 Next 确认真实材料及其字节版本；方案多候选须明确选择，单候选自动采用唯一 ID。Back 只相邻退回并失效相关确认，不撤销 Git／文件、不自动调用模型。第五阶段只交 ST，只有第七阶段显式同步归档；归档成功不是终态。
- 第六至第八阶段人员点击决定完成；测试失败、未运行、限制照实保留，不新增全部 ST 通过／AI 审核／独立审查程序门禁。人员原始决定不由聊天、AI、PR 查询或退出码代签。
- Markdown 上传读取浏览器选择的内容；路径导入读取 OMP 宿主本地文件。只支持 Markdown，不下载 URL、不转换 Word／PDF。外部源永不进入本需求写入／撤销范围。
- 同一 canonical Git 根、同一既有分支一个开发名额；不建分支、worktree 或跨机器调度。PR 已提交仍占用；真实合入并由人员标记，或取消且全部撤销及原生工作结清后释放。已合入测试可与下一开发共存，但最多写自身业务记录。
- Git 确认列出真实 existing source／base／remote、目标 ref、已观察 remote tip 和全部待发布 commit；不根据 `origin/main` 等名字猜目标。push 不能过滤祖先；若固定目标 SHA 必带未获当前范围授权的其他需求提交，拒绝／待同步，保留成功步骤，不夹带、不重做 commit、不 force push、不直推 base 绕 PR。
- 仅承诺同步至本次确认的目标；源分支已推送不等于进入目标主分支。合入后状态也选用已发现、明确确认的既有目标；缺少可行拓扑／凭据／原生能力如实阻塞，不偷偷创建新分支、PR 平台或发布路径。
- 关闭／刷新／断网只解除订阅及对应 guest 连接，不停止后台 Agent／工具／Team／Goal；宿主退出才按原生规则结清。重连读事实，不重放 prompt、工具、确认或 Git 操作。
- offline 参与者可操作全部工作台，不新增角色权限系统；这不覆盖原生 deny、restrictedFolders、工具白名单、执行范围、人员确认和非 offline 安全边界。用户名是既有路由／署名，不声称认证身份。
- 源码、npm bundle、独立二进制采用同一 UI 载荷，随既有发行链内嵌；不要求前端 dev server、checkout、远端 CDN 或新增服务部署。
- 保留工作区已有内容和无关改动；本轮仅实施已批准需求及上述最新收窄边界。
- 实施工作者不得逐片运行 tests／build／lint／formatters；全部修改落地后由集成主代理统一最小定向验证，修复只复验受影响失败项。用户新的广泛授权允许完成任务所需命令，但不要求或正当化fulltest／slowtest、无关全套、重复构建或外部能力检查；复用有效证据，仅补本次改动和真实失败所需范围。授权不取消Git范围、凭据及发布安全边界，也不将未执行项目变成通过证据。本次文档同步不运行软件检查。

## Review Focus

1. 无业务 Actor 的导入、零对话 Next、原始批准和完整材料交接；新流程冷读不依赖本机聊天，更不扫描旧材料猜批准。见 T01、T02、T04、V01—V04。
2. 第五步批准与第六步合法报告更新分开；第七步真实归档位置贯穿读取、校验、Agent 写授权和再同步，不能重复 archive、重建活动源或把变化的 ADDED 当作幂等。见 T02—T04、V02—V04。
3. 范围内 commit 和 push 的祖先范围是两件事；同次标记、最终只读提交、SHA 自引用、响应丢失、跨人重复操作必须准确。见 T05、T06、V05、V06。
4. 取消涵盖已提交／暂存／未暂存改动及同步主规格／归档移动，保留原有脏内容和历史；冲突、不明归属、PR 合入竞态不假释放。见 T01、T07、V07。
5. 合入后测试只写自身记录，原生工具、shell、扩展、自定义工具、Team／Goal 和任意深度后代不能绕过；无法约束的测试命令明确受阻。见 T04、V04、V14。
6. HTTP／普通 WS offline 纯浏览器参与同一原生会话；薄 guest transport 不抢房主 `ctx.collabGuest`，不依赖远端浏览器 WebCrypto、不另建 Relay、不自动跟阶段。见 T08—T10、V08—V10。
7. 真实网页完整原生交互，不把只有 select/editor 当成全部审批；身份、reqId、队列、附件、迟到事件和断线各自有实际消费者验收。见 T04、T08—T10、V09、V10、V14。
8. 两入口完整资源链、普通聊天不换绑、旧 TUI／旧 Dev↔ZCode 所有消费者一次退役；有效材料失败矩阵、普通 TUI、权限、取消、Team／Goal 覆盖不随旧 UI 删除。见 T11—T15、V11—V15。

## File Structure and Ownership

路径以仓库根为基准。`Modify`／`Retire` 均是已经核实存在的路径；`Create` 是明确的新文件，不表示当前已有实现。目录行限定下列已存在的成员，不授权顺手重构整个目录。

| 文件 | 处理／唯一职责／任务 owner |
| --- | --- |
| `packages/coding-agent/src/spec-driven/types.ts`、`stages.ts` | Modify；唯一共享类型入口、八业务阶段／五角色／动作版本，T01 |
| `packages/coding-agent/src/spec-driven/workspace.ts` | Modify；canonical 根、既有分支、跨进程写租约及开发名额，T01 |
| `packages/coding-agent/src/spec-driven/records.ts` | Create；Git 最小业务记录读写／CAS／实际 commit 解析，本地 native 引用分离，T01 |
| `packages/coding-agent/src/spec-driven/controller.ts` | Modify；唯一业务 owner 与统一控制入口；T01 定契约、T02 实现，不再依赖 TUI bind |
| `packages/coding-agent/src/spec-driven/orchestrator.ts` | Modify；八阶段、批准、Back、人工标记、归档非终态，T02 |
| `packages/coding-agent/src/spec-driven/artifacts.ts`、`resources.ts` | Modify；统一活动／归档材料、原生检查与内部目录同步入口，T03 |
| `packages/coding-agent/src/spec-driven/native-sync.ts` | Create；窄的 OpenSpec 同步桥，不另造解析／合并语义，T03 |
| `packages/coding-agent/src/spec-driven/vendor/resources/openspec/dist/core/archive.js`、`packages/coding-agent/src/spec-driven/vendor/resources/openspec/dist/core/specs-apply.js` | Modify；在现有原生archive事务中提取可接真实目录的内部同步函数，不改独立CLI语义，T03 |
| `packages/coding-agent/scripts/spec-driven-resources.ts`、`packages/coding-agent/src/spec-driven/resource-inventory.ts` | Reuse existing generation；收集当前vendor树、重算manifest／摘要并打包，T03／T13；不手改缓存归档或虚构旧`--embed`命令 |
| `packages/coding-agent/src/spec-driven/actors.ts`、`runtime.ts`、`skill-policy.ts` | Modify；真实角色会话、历史／来源恢复、递归权限和原生交互，T04；技能规则只做新宿主绑定所需修改 |
| `crates/pi-vcs/src/types.rs`、`crates/pi-vcs/src/git/{mutate.rs,cli.rs,patch.rs}`、`crates/pi-natives/src/vcs.rs` | Modify；scoped commit／index协调、真实remote ref查询、限定前像patch部分结果，复用原生实现，T05 |
| `packages/natives/native/index.d.ts` | Modify generated；通过既有binding生成链同步声明，不手写声明代替native实现，T05 |
| `packages/natives/test/dev-workbench-vcs.test.ts` | Create；只覆盖本次新增VCS消费者，精确接入fork选择，不将全部通用VCS套件纳入日常门禁，T05／T14；现有`vcs.test.ts`作为参考不扩大默认范围 |
| `packages/coding-agent/src/spec-driven/git.ts` | Create；确认快照、归属范围、固定 SHA push、operation 部分成功，T06 |
| `packages/coding-agent/src/spec-driven/forge.ts` | Create；复用 `utils/github.ts`、`utils/gitlab.ts`、`utils/forge-cli.ts` 的既有 runner，明确 PR 身份／事实／取消，T06；不新增 Forge 框架 |
| `packages/coding-agent/src/spec-driven/cancel.ts` | Create；完整撤销、PR 竞态、补偿提交与取消 tombstone，T07 |
| `packages/coding-agent/src/main.ts`、`packages/coding-agent/src/dev-workbench/host.ts` | Reuse restored ordinary main／Create independent Dev host；Dev bootstrap及宿主适配留在host模块，复用普通启动公共能力，持有root native session，不启动普通TUI，T08 |
| `packages/coding-agent/src/dev-workbench/server.ts`、`native-ui.ts` | Create；同源 HTTP／WS、真实原生 UI 交互 seam、页面订阅生命周期，T08 |
| `packages/collab-web/src/dev-workbench/{main.tsx,Workbench.tsx,client.ts,styles.css}`、`packages/collab-web/dev-workbench.html` | Create；独立工作台入口与四区 UI，T09 |
| `packages/collab-web/src/components/shell/Composer.tsx`、`packages/collab-web/src/components/agents/AgentDrawer.tsx`、`packages/collab-web/src/app.tsx`、`packages/collab-web/src/lib/client.ts` | Modify；最小异步发送／agent端口、共享session面及生产帧reducer提取，普通Collab App保持既有边界，T09 |
| `packages/coding-agent/src/dev-workbench/collab.ts` | Create；每浏览器薄 native guest transport，T10 |
| `packages/coding-agent/src/collab/host.ts`、`controller.ts` | Modify；只提取可供工作台绑定原生会话的最小宿主端口／业务动作 seam，T10；房间与 Relay 仍归现有 Collab |
| `packages/coding-agent/src/commands/dev.ts` | Create；懒加载 CLI 入口、有效环境、长寿命宿主，T11 |
| `packages/coding-agent/src/cli-commands.ts`、`cli/command-help.ts`、`slash-commands/builtin-spec-driven.ts`、`slash-commands/types.ts`、`utils/open.ts` | Modify；双启动入口、帮助／拒绝旧参数、可观察 opener，T11；旧模式方法由 T12 清除 |
| `packages/coding-agent/src/modes/interactive-mode.ts`、`modes/types.ts`、`modes/controllers/input-controller.ts`、`command-controller.ts`、`session-focus-controller.ts`、`modes/utils/ui-helpers.ts` | Modify；只删除 Dev TUI 接线，保留普通输入、focus、compaction、菜单、widget 容器，T12 |
| `packages/coding-agent/src/modes/zcode/spec-driven.ts`、`modes/zcode/schema/omp-spec-extension.ts` | Retire；旧 Dev 专属 bridge／schema，T12；先迁出仍属普通协议的非 Dev定义，再删除无消费者文件 |
| `packages/coding-agent/src/modes/zcode/{server.ts,commands.ts,sessions.ts,projection.ts,topics.ts}`、`modes/zcode/hosts/command-catalog.ts` | Modify；删除旧 Dev import／状态／能力／查询／输入／退出接线，不接新工作台，T12 |
| `packages/coding-agent/scripts/dev-workbench-resources.ts`、`packages/coding-agent/src/dev-workbench/assets.ts` | Create；单一 content-addressed UI 载荷与 Bun 插件，T13 |
| `packages/coding-agent/scripts/{bundle-dist.ts,compile-binary.ts,build-binary.ts}`、`packages/coding-agent/package.json`、`packages/collab-web/package.json`、根`package.json` | Modify；source准备／postinstall与npm／binary共用资源生成链和白名单，T13 |
| `packages/coding-agent/src/dev-workbench/assets.generated.json` | Create generated；同一生成器输出的内容寻址UI载荷，源码／SDK延迟读取，打包插件内嵌，T13 |
| `packages/coding-agent/test/spec-driven/{orchestrator,controller,artifacts,runtime,actors,actors-descendants,workspace,command,skill-policy,resources}.test.ts`、`packages/coding-agent/test/spec-driven/{process,process-resources}.e2e.test.ts` | Modify；真实文件名的原生／独立资源消费者，Dev公开驱动迁移而非保留ZCode接入，T01—T04、T11、T14 |
| `packages/coding-agent/test/dev-workbench/{records,git,cancel,host,server,collab,cli,resources}.test.ts` | Create；各片真实最小 fixture，T01、T06—T08、T10、T11、T13 |
| `packages/coding-agent/test/dev-workbench/{browser,process}.e2e.test.ts`、`fixture.ts` | Create；source真实服务／浏览器／CLI消费者；不依赖npm／binary预构建产物，T14 |
| `packages/coding-agent/scripts/verify-dev-workbench-package.ts` | Create；独立显式成品验收程序，非Bun test命名，默认发现及`--full`均不执行；必须提供本次产物及manifest，T14 |
| `packages/collab-web/test/dev-workbench.test.tsx` | Create；工作台纯组件／输入归属合同，T09；不替代真实浏览器 |
| `packages/collab-web/test/{composer,transcript,tool-view,markdown}.test.tsx` | Modify only if interface affected；现有组件覆盖随最小端口改造保持，T09 |
| `packages/coding-agent/test/spec-driven/tui*.ts`、`native-surface.test.ts` | Retire Dev-only expectations／helpers；已核实目录内旧 TUI E2E 转由 T14 网页／原生消费者承接；混合普通 TUI断言保留，T14 |
| `packages/coding-agent/test/modes/{zcode-spec-extension.test.ts,zcode-spec-materials.test.ts,zcode-spec-version-contract.test.ts,zcode-spec-driven.e2e.ts}` | Retire Dev-only consumers；必要的“Dev 已无接线”拒绝断言并入现有普通 ZCode tests，不保留专门新 Dev协议测试，T14 |
| `packages/coding-agent/test/modes/{zcode-commands.test.ts,zcode-sessions.test.ts,zcode-projection.test.ts,zcode-hosts-command-catalog.test.ts}` | Modify；普通能力不变与无 Dev route／projection，T12、T14 |
| `scripts/{ci-test-ts.ts,fulltest.ts,fulltest-ui-smoke.ts,test-report-ui-smoke.ts,ci-test-ts.test.ts,fulltest.test.ts}` | Modify；旧 Dev专属 smoke／白名单／启动敏感选择替换为新消费者，普通 TUI覆盖保留，T14 |
| `openspec/specs/fork-verification-gates/spec.md` | Modify；只替换旧 Dev TUI 特有合同及消费者，预算／跳过／授权规则不变，T15 |
| `openspec/specs/spec-driven-orchestration/spec.md`、`openspec/changes/replace-dev-tui-with-browser-workbench/specs/spec-driven-orchestration/spec.md` | Modify only retained provenance wording；把“仅本地历史确证”对齐为宿主从真实原生结果确证并持久化最小版本事实，历史可用仍核对；不放松方案来源和Team可采用合同，T04／T15 |
| `docs-zh-CN/lander-sailor-six-stage-agent-workflow.md`、`packages/coding-agent/CHANGELOG.md`、`packages/collab-web/README.md` | Modify；最终八阶段、命令、资源／网络／失败边界与 Unreleased说明，T15；现有正确需求不重写 |

**运行时数据约定（不是本轮创建的交付文件）：** 开发需求记录固定 `docs/dev-requirements/<requirementId>.json`；正式材料保持现有路径。新本地宿主状态使用 `.omp/dev-workbench/`，不读取 `.omp/dev/state.json` 作为新权威。原生 session 文件继续由既有 profile/session storage 拥有；只保存其引用，不把它们搬进新目录。取消保留最小同路径 tombstone。纯业务本地写作无 Git 需求记录，使用本地唯一业务 Markdown和原生会话；开发接手另建需求导入。

## Shared Interfaces — Implementation Decisions

以下新增名称／签名是本计划固定的实现合同，**不是声称现有 API 已存在**。现有 API 的复用单独列明。共享数据定义统一从 `src/spec-driven/types.ts` 导出，浏览器仅 `import type`，不得把 Node／native 实现带入前端。

### A. 业务事实、动作版本与运行事实

```ts
export type DevStage =
  | "business" | "requirements" | "solution" | "planning"
  | "executing" | "st" | "pr" | "testing";
export type DevHumanMark = "st-complete" | "pr-submitted" | "pr-merged" | "tested";
export type DevLifecycle = "active" | "completed" | "cancelling" | "cancelled";
export interface DevPerson { name: string; source: "local" | "collab"; peerId?: string }
export interface DevMaterialRef extends SpecFileVersion {
  id: string;
  kind: "business" | "proposal" | "delta" | "solution" | "plan" | "report";
}
export interface DevDecision {
  operationId: string; stage: DevStage; actor: DevPerson; at: string;
  userReply: string; files: SpecFileVersion[]; candidateId?: string;
}
export interface DevPrRef {
  forge: "github" | "gitlab"; repository: string; number: number; url: string;
  sourceRef: string; baseRef: string;
}
export interface DevPrFact {
  pr: DevPrRef; state: "open" | "closed" | "merged";
  headSha: string; baseSha: string; mergeSha: string | null; observedAt: string;
}
export interface DevGitTarget {
  localSourceRef: string; sourceRepository: string; sourceRef: string;
  baseRepository: string; baseRef: string;
  remote: string; remoteUrl: string; targetRef: string; observedTip: string | null;
}
export type DevGitAction = DevHumanMark | "set-test-state" | "link-fix" | "commit" | "cancel";
export interface DevGitOperation {
  operationId: string; kind: DevGitAction;
  actor: DevPerson; at: string; files: SpecFileVersion[];
  target: DevGitTarget; authorizedCommits: string[];
  knownCommitShas: string[];
}
export interface DevSolutionBasis {
  solutionVersion: string; candidateIds: string[]; usableCandidateIds: string[];
  source: "single-agent" | "team"; sourceSessionId: string;
  sourceEntryIds: string[];
}
export interface DevSyncRevision {
  operationId: string; files: SpecFileVersion[];
  mainSpecs: Array<{ path: string; version: string | null }>; // null明确记录原生retirement后不存在
  archivedChangePath: string | null; progress: SpecCloseProgress;
}
export interface DevRequirementRecord {
  schemaVersion: 1; requirementId: string; changeId: string;
  branch: string; stage: DevStage; lifecycle: DevLifecycle;
  materials: DevMaterialRef[]; decisions: DevDecision[];
  marks: Partial<Record<DevHumanMark, DevDecision>>;
  solutionBasis: DevSolutionBasis | null;
  report: { development: SpecApproval | null; st: SpecFileVersion | null };
  syncRevisions: DevSyncRevision[]; gitOperations: DevGitOperation[];
  pr: DevPrFact | null;
  testing: "not-started" | "in-progress" | "failed" | "retest-pending" | "tested";
  relatedRequirementIds: string[];
}
export interface DevActionBinding {
  requirementId: string; expectedRecordVersion: string; expectedStage: DevStage;
  files: SpecFileVersion[]; operationId: string; expectedGeneration: number | null;
}
export interface DevRuntimeState {
  requirementId: string; generation: number;
  execution: "idle" | "running" | "waiting" | "stopping" | "interrupted" | "failed";
  recipient: SpecConversationRecipient | null;
  history: "available" | "unavailable" | "not-created";
  blockedReason?: string;
}
export interface DevStoredRequirement {
  record: DevRequirementRecord;
  recordVersion: string; // 实际JSON文件字节的SHA-256；不写回JSON自身
}
export interface DevRequirementSnapshot extends DevStoredRequirement {
  runtime: DevRuntimeState | null;
  actions: Array<{ id: string; available: boolean; blockedReason?: string }>;
}
export type DevActionIntent =
  | { kind: "next"; candidateId?: string }
  | { kind: "back" }
  | { kind: "sync-archive" }
  | { kind: "mark"; mark: DevHumanMark }
  | { kind: "cancel" }
  | { kind: "set-test-state"; state: "in-progress" | "failed" | "retest-pending" }
  | { kind: "link-fix"; fixRequirementId: string };
export type DevAction = DevActionIntent & {
  binding: DevActionBinding; previewId: string | null; userReply: string;
};
export interface DevActionPreview {
  action: DevActionIntent & { binding: DevActionBinding; previewId: string | null };
  confirmationToken: string; git: DevGitPreview | null;
}
export type DevEffectStatus = "not-started" | "succeeded" | "failed" | "unknown";
export interface DevActionResult {
  snapshot: DevRequirementSnapshot;
  persistence: {
    save: DevEffectStatus;
    commit: { status: DevEffectStatus; sha: string | null; indexReconciled: boolean };
    push: { status: DevEffectStatus; target: DevGitTarget | null };
    error?: string;
  };
}
```

- `SpecStageRole` 保持业务／需求／方案／计划／执行五类既有值，不把 `DevStage` 强制赋给 role；删除旧 `SpecInputMode = "chat" | "dev"` 的 Dev产品路由，保留普通模式本身。
- 记录不保存正文副本、聊天、运行 owner／锁、token、队列、busy、按钮状态、Team冻结副本或 Goal副本。`DevSolutionBasis` 只保存材料 hash及宿主从真实原生结果核实的候选可采用事实，不能信任模型自填或浏览器上传；原始历史可用时仍核对，缺失时据已持久化事实及正式材料继续。
- 同一 `operationId` 的本次 commit SHA 从实际 Git对象中该记录的 operation 内容解析；`knownCommitShas` 只写当时已知的历史SHA。不得为让 commit 包含自身SHA无限补交。push结果／锁／临时诊断保留本地 operation恢复资料，UI重开再从远端事实核实，不以 Git中的“pushed”缓存作真值。
- `recordVersion: string`是实际记录字节的SHA-256、用于CAS；`schemaVersion`是格式版本、`generation`是原生运行代际，二者为number；材料`version`是现有`artifactVersion(bytes)`的SHA-256。记录摘要不存回自身JSON，避免自引用。所有接口只用`expectedRecordVersion: string`，不得混入计数版本。recipient用显式`null`，导入无Actor不是错误。
- ST继续修改同一 completion Markdown。保留第五步 `report.development` 的原始批准／版本；第六步 `report.st` 记录后来合法报告字节，不能静默改写第五步批准。报告合法追加不会使业务／需求／方案／计划批准失效；报告中开发结论／范围被修正则撤销本轮报告资格，按范围Back／重确认，不以“ST”标签豁免任意变更。

### B. 唯一 owner、记录和材料 API

```ts
// records.ts
loadDevRequirements(cwd: string): Promise<DevStoredRequirement[]>;
readDevRequirement(cwd: string, requirementId: string): Promise<DevStoredRequirement>;
saveDevRequirement(cwd: string, record: DevRequirementRecord,
  expectedRecordVersion: string | null): Promise<DevStoredRequirement>;
resolveDevOperationCommit(cwd: string, requirementId: string,
  operationId: string): Promise<string | null>;

// controller.ts; 同一实例按 canonical cwd 管理需求和唯一开发名额
createRequirement(input: {
  source: "conversation" | "import"; request?: string;
  relatedRequirementIds?: string[];
}): Promise<DevRequirementSnapshot>;
listRequirements(): Promise<DevRequirementSnapshot[]>;
getRequirement(requirementId: string): Promise<DevRequirementSnapshot>;
dispatch(action: DevAction, actor: DevPerson): Promise<DevActionResult>;
observe(listener: (snapshot: DevRequirementSnapshot) => void): () => void;
stop(requirementId: string): Promise<void>;
prepareDevAction(input: {
  requirementId: string; expectedRecordVersion: string; expectedStage: DevStage;
  intent: DevActionIntent; gitTarget: DevGitTarget | null;
}): Promise<DevActionPreview>;
confirmDevAction(input: { operationId: string; confirmationToken: string;
  userReply: string }): Promise<DevActionResult>;
readDevAction(operationId: string): Promise<DevActionResult>;
discoverDevGitTargets(requirementId: string): Promise<DevGitTarget[]>;
startLocalBusiness(request: string): Promise<{
  document: SpecDocument | null; recipient: SpecConversationRecipient;
}>;
saveTeamConfiguration(input: { requirementId: string | null;
  expectedRecordVersion: string | null; useTeam: boolean }): Promise<{ useTeam: boolean }>;

// artifacts.ts; ref.id 为逻辑身份，path 始终是真实当前位置
resolveDevMaterials(cwd: string, record: DevRequirementRecord): Promise<DevMaterialRef[]>;
readDevMaterial(cwd: string, record: DevRequirementRecord,
  materialId: string): Promise<SpecDocument>;
importDevBusiness(cwd: string, record: DevRequirementRecord, source:
  | { kind: "upload"; name: string; bytes: Uint8Array }
  | { kind: "host-path"; path: string }): Promise<SpecDocument>;

// native-sync.ts；只接宿主已经核准的实际目录／材料
syncDevRequirement(input: {
  cwd: string; changeId: string; changeDirectory: string;
  acceptedVersions: readonly SpecFileVersion[];
  previous: DevSyncRevision | null; operationId: string;
  onProgress: (progress: SpecCloseProgress) => Promise<void>;
}, signal: AbortSignal): Promise<DevSyncRevision>;
```

`saveDevRequirement`在canonical workspace写锁内比较实际记录字节摘要，临时文件加原子替换并返回新摘要；不得另建数据库。记录读取不获得runtime owner；写入／继续才申请现有`DevWorkspace.acquire`跨进程租约。开发占用由未合入且未完整取消的Git记录推导，不以进程锁消失释放。独立目录保持隔离；无需跨机器名额协调。

现有材料接口继续复用：`artifactVersion`、`containedSpecPath`、`assertSpecWritePath`、`formalMaterialPaths`、`parseSpecSolution`、`SpecArtifactStore.readBusiness/readRequirements/readSolution/readPlan/readReport/checkVersions/close`。实现中改为共同材料解析后再调用这些检查，不复制格式规则；`close`只用于第一次真实原生archive，不再代表需求结束。

### C. Git／PR／撤销 API

```ts
export interface DevGitPreview {
  previewId: string; binding: DevActionBinding; headSha: string; indexVersion: string;
  files: SpecFileVersion[]; patchHash: string; target: DevGitTarget;
  proposedTree: string; commitsToPublish: string[];
  operation: DevGitAction;
}
export interface DevCancelPlan {
  preview: DevGitPreview; committedShas: string[];
  paths: string[]; conflicts: Array<{ path: string; reason: string }>;
  pr: DevPrFact | null;
}
// git.ts
previewDevGitOperation(record: DevRequirementRecord,
  input: { binding: DevActionBinding; operation: Exclude<DevGitAction, "cancel">;
    target: DevGitTarget; files: SpecFileVersion[] },
  signal: AbortSignal): Promise<DevGitPreview>;
executeDevGitOperation(preview: DevGitPreview, decision: DevDecision,
  signal: AbortSignal): Promise<DevActionResult>;
resumeDevGitOperation(requirementId: string, operationId: string,
  signal: AbortSignal): Promise<DevActionResult>;
// forge.ts
observeDevPr(pr: DevPrRef, signal: AbortSignal): Promise<DevPrFact>;
createDevPr(input: { requirementId: string; target: DevGitTarget;
  title: string; body: string }, signal: AbortSignal): Promise<DevPrFact>;
closeDevPr(pr: DevPrRef, signal: AbortSignal): Promise<DevPrFact>;
// cancel.ts
planDevCancellation(record: DevRequirementRecord,
  binding: DevActionBinding, target: DevGitTarget,
  signal: AbortSignal): Promise<DevCancelPlan>;
executeDevCancellation(plan: DevCancelPlan, decision: DevDecision,
  signal: AbortSignal): Promise<DevActionResult>;
```

这些函数由持有 cwd／native repo／records 的具体服务类方法实现，构造依赖用已有 `VcsGitRepo`、controller、Forge runner，禁止全局隐式cwd；同名参数／返回值保持上述合同。取消和普通标记共用operation及范围commit能力，不另建通用事务框架。

**最小native补口（本轮新增；实际N-API及生成声明的验证见证据账本）：**

```ts
export interface VcsScopedCommitOptions {
  expectedHeadRef: string; expectedHeadSha: string; expectedIndexVersion: string;
  indexPath: string; reconciledIndexPath: string; expectedTree: string; files: string[];
}
export interface VcsScopedCommitResult {
  sha: string | null; refUpdated: boolean; indexUpdated: boolean; diagnostic?: string;
}
VcsGitRepo.commitCreateScoped(message: string, options: VcsScopedCommitOptions,
  signal?: unknown): Promise<VcsScopedCommitResult>;
VcsGitRepo.remoteRef(remote: string, fullRef: string,
  signal?: unknown): Promise<{ sha: string | null }>;
VcsGitRepo.applyOwnedPatch(patch: string, options: {
  reverse: boolean;
  expected: Array<{ path: string; beforeVersion: string | null; afterVersion: string | null }>;
}, signal?: unknown): Promise<{
  paths: Array<{ path: string; status: "applied" | "unchanged" | "failed";
    actualVersion: string | null }>;
  complete: boolean; diagnostic?: string;
}>;
```

scoped commit复用现有身份／signing和ref CAS，**新路径不恢复或执行Git hooks**；有效hook要求无法在当前仓库规则下满足时变更前明确阻塞，不修改配置／偷偷禁用或运行hook，普通API原有语义不变。scoped额外固定symbolic ref＋SHA、真实index版本及预构造协调index；持真实Git index写锁检查／发布，保留无关entries／flags／staged hunks。HEAD和index非跨文件原子，返回分步事实；HEAD成功index失败保留SHA，只续办index，不能再commit／无条件回退HEAD。`remoteRef`复用`git/cli.rs`网络runner区分不存在与未知；`applyOwnedPatch`复用`git/patch.rs`前像核对／逐路径结果供取消恢复。针对已证实的clean filter／hook缺陷，窄补口还包含 `previewOwnedPatch`（只读取得实际原始字节前后像）、`stageFilesIntoIndex`（通过原生clean链把精确路径写入私有index）和 `hookPath`（解析实际生效的可执行hook，不执行）；这些能力贯穿真实N-API及生成声明，不造Git引擎、不扩大hook执行范围。

### D. 宿主、原生交互、浏览器传输

```ts
// host.ts
export interface DevWorkbenchHandle {
  url: string;
  close(): Promise<void>; // 仅宿主 shutdown 调用
}
getOrStartDevWorkbench(host: DevWorkbenchHost): Promise<DevWorkbenchHandle>;
createDevWorkbenchHost(input: {
  session: AgentSession; settings: Settings; cwd: string;
}): Promise<DevWorkbenchHost>;
export interface DevWorkbenchHost {
  readonly cwd: string;
  readonly settings: Settings;
  readonly rootSession: AgentSession;
  readonly controller: SpecDrivenController;
  readonly collab: CollabController;
  subscribeEntries(
    listener: NonNullable<AgentSession["sessionManager"]["onEntryAppended"]>,
  ): () => void;
  respondNativeUi(input: Parameters<typeof respondDevNativeUi>[0]):
    ReturnType<typeof respondDevNativeUi>;
  close(): Promise<void>;
}
// DevWorkbenchHost 持有 session、controller、原生 UI controller 与 Collab适配；
// 不包含 bindMainSession，不接受伪造 SlashCommandRuntime。

// native-ui.ts
export interface DevNativeUiRequest {
  requestId: string; requirementId: string; sessionId: string; generation: number;
  kind: "select" | "editor" | "confirm";
  title: string; options?: Array<string | { label: string; description?: string }>;
  prefill?: string;
}
respondDevNativeUi(input: {
  requestId: string; requirementId: string; sessionId: string; generation: number;
  value: string | boolean | null;
}): Promise<{ accepted: boolean; reason?: string }>;
// collab.ts；guest方法不拥有房主runtime
joinDevCollab(input: { browserId: string; usernameOrLink: string; name: string },
  signal: AbortSignal): Promise<{ peerId: string; roomId: string; canWrite: boolean }>;
leaveDevCollab(browserId: string): Promise<void>;
export type DevSubmitResult =
  | { kind: "accepted" }
  | { kind: "rejected"; message: string }
  | { kind: "unknown"; message: string };
export interface DevComposerPort {
  sendPrompt(text: string, images?: readonly ImageContent[]): Promise<DevSubmitResult>;
  sendUiResponse(reqId: number, value?: CollabUiResponseValue): Promise<DevSubmitResult>;
  sendAbort(): Promise<DevSubmitResult>;
}
export interface DevSessionTarget {
  requirementId: string | null; sessionId: string; generation: number;
}
prepareDevInput(target: DevSessionTarget): Promise<{ requestId: string }>;
submitDevInput(input: { requestId: string; text: string;
  images?: readonly ImageContent[] }): Promise<DevSubmitResult>;
inspectDevInput(requestId: string): Promise<DevSubmitResult>;
runDevNativeCommand(input: { target: DevSessionTarget; command: string;
  args: string[] }): Promise<DevSubmitResult>;
// utils/open.ts
openPathWithResult(urlOrPath: string): Promise<
  { opened: true } | { opened: false; reason: string }>;
```

- `DevWorkbenchHost`的原生会话能力来自真实 `AgentSession`、原生 UI和既有 Collab宿主最小端口；实现者从当前 `SlashCommandRuntime`／`InteractiveModeContext` 中提取确实被runtime／host使用的成员，而不是造一份假的完整TUI对象。普通调用者的 `openPath(): void` 可继续保持其非 Dev行为；新结果方法共用底层 opener，不保留旧 Dev产品兼容。
- 同源HTTP协议固定在实际服务URL的capability前缀下：`GET /api/requirements`、`GET /api/requirements/:id`、`POST /api/requirements`、`POST /api/action-preview`（prepare）、`POST /api/actions`（confirm）、`GET /api/operations/:operationId`、`GET /api/materials/:id`（只读材料元数据）、`GET /api/materials/:id/:materialId`（实际材料字节）、`POST /api/business/:id`、`POST /api/git-preview`、`POST /api/cancel-preview`、`POST /api/native-ui-response`、`POST /api/collab/join`、`POST /api/collab/leave`、`GET /api/events`（WebSocket upgrade）。`:id`为requirementId，不接受任意文件路径作为下载路由。材料元数据读取独立于批准：未批准材料也应按真实现状可见，读取不产生批准、模型调用或业务推进。
- `POST /api/business/:id` 为 multipart上传或JSON宿主路径，两种输入都调用 `importDevBusiness`；下载返回实际Markdown字节及安全文件名。方案JSON用原有可读候选展示，原件可查看，不伪造新的正式Markdown方案。
- 聊天／原生交互沿用现有wire快照、entries、events、agents、bus、ui-request／ui-request-end、bye／error形状；工作台WS只加明确业务snapshot envelope，不建立聊天正文存储。Composer用上述异步最小port；现有GuestClient通过适配器保留独立网页行为，不能将void发送后立即清草稿当作宿主已接收。完整原生操作通过实际已有端口绑定，不把slash文本变成业务批准。
- `prepareDevAction`只预览，不批准／推进／Git写入；宿主生成operationId、confirmationToken、browserId和输入请求身份，绑定实际材料／owner代际。浏览器仅回传，不依赖普通HTTP不存在的`crypto.randomUUID`／`crypto.subtle`。confirm只能消费宿主保存的原范围；token不入Git、不覆盖原生deny，重连查询operation而不重放确认。
- 业务动作只通过控制API；person由宿主按连接／既有peer填写，不信任浏览器任意actor。Composer只有accepted才消费草稿／附件；rejected／unknown保留并显示事实，unknown不自动重发。AgentDrawer另用其`sendAgentCmd/fetchTranscript`最小端口，不能通过全局registry控制无关owner。
- 本地业务路由为`POST /api/local-business`→`startLocalBusiness`、`GET /api/local-business/material`→当前本地写作已登记Markdown的实际字节；只能读此写作实例，不开放任意路径。Team开关为`GET /api/team-config`读取原工作区保存值、`POST /api/team-config`→`saveTeamConfiguration`；原生成员／模型设置仍走既有native交互。local-business不建Git需求record；Team配置保存不启动模型／Team／Goal。
- `set-test-state`（包括失败／待复测）和人工`link-fix`也是第八步业务状态变化，同样走宿主preview／confirm并在同次明确范围内commit／push，不能成为绕过R19的直接JSON写入口。新建修复需求对已completed原需求只保存新记录的关联，不回写只读原记录。
- 原生输入路由固定`POST /api/input-preview`→`prepareDevInput`、`POST /api/input`→`submitDevInput`、`GET /api/inputs/:requestId`→`inspectDevInput`；短期回执只存身份／接受事实，不保存另一份正文／消息队列。`POST /api/native-command`→`runDevNativeCommand`按原生可用命令目录执行选模／推理／Goal／Team成员等；`GET /api/native-commands`只返回当前目标实际目录，命令名不得被当作业务批准。target的requirementId为null仅用于本地业务写作；所有target仍校验真实session／generation／owner，不能控制任意原生会话。
- 首次调用顺序固定：先读取需求snapshot和`GET /api/git-targets/:id`→`discoverDevGitTargets`；传**不含previewId／operationId**的intent及选定gitTarget给prepare。prepare由宿主分配一个operationId，建立binding，再在这个operation下调用Git／cancel预览并生成真实previewId／confirmationToken，返回待确认action；Next／Back无Git时previewId和gitTarget为null。mark／cancel／set-test-state／link-fix必须有已确认候选目标，缺失明确拒绝。confirm只回传operationId／token／人员原文，查宿主已保存action后dispatch，不需要浏览器预造ID。V02／V06／V07覆盖首次标记、首次删除和过期确认。

## Dependency Waves

| 波次 | 任务与依赖 | 并行边界 |
| --- | --- | --- |
| A | T01共享类型／records／owner先完成 | 这是所有切片的必要共同契约，不先开多套状态机 |
| B | T02阶段；T03材料／同步；T04会话／权限；T05native scoped commit | 在T01合同上并行；T02独占controller/orchestrator，T03独占artifacts/resources，T04独占actors/runtime，T05独占native |
| C | T06 Git／Forge → T07取消；T08宿主／传输 | T06依赖T01/T05；T07依赖T04/T06；T08依赖T02/T04，接口可先写但不伪称完整 |
| D | T09网页、T10 Collab、T11入口、T12旧UI／ZCode清退 | 依赖T08及T06/T07动作。T09独占collab-web；T10独占Collab宿主适配；T11独占命令；T12统一修改旧消费者，不同时让其他片编辑同一接线 |
| E | T13资源；T14消费者／门禁迁移；T15文档与一次性集成验收 | T13等待真实UI入口；T14归并各片fixture与旧覆盖；最后T15由主代理统一执行已授权验证。任一任务未完成均不可交付新模式 |

每个任务实施者写测试但跳过运行；测试文件所有权随生产片，T14只集成公共fixture／覆盖迁移，不在半成品上启动并行gates。

## Task 01: Establish Records, Owner and Shared Action Contracts

**Files:** Modify `types.ts`、`stages.ts`、`workspace.ts`、`controller.ts`（仅owner契约）；Create `records.ts`、`test/dev-workbench/records.test.ts`；Modify `test/spec-driven/workspace.test.ts`。

**Interfaces:** Shared A/B；复用 `DevWorkspace.acquire` 的root realpath／文件锁，不复用旧单run state schema。

- [x] 按共享类型建立八阶段、五角色、可空recipient、实际字节摘要`recordVersion: string`与native generation；业务事实和运行事实完全分开。配置仍是原工作区Team开关和原生成员设置，不新增Dev Goal／冻结副本。
- [x] 在 `docs/dev-requirements/` 严格枚举新schema记录；未知／损坏新记录显示诊断且不删除，旧`.omp/dev/state.json`及历史材料不枚举为新需求、不迁移或清除。唯一ID沿用合法change命名，生成时检查活动、归档、计划、业务文档及取消记录冲突，跨日期不重分配。
- [x] 使用 canonical Git root及实际current branch界定workspace。读取列表无需租约／Actor；修改在跨进程租约内CAS。目录别名／子目录同源；读到其他owner占用不抢占。进程退出不抹掉未合入业务记录的占用事实。
- [x] 独立保存本地native session引用及operation恢复资料；读取Git记录无历史时显示history unavailable，不自动建会话。只在人员明确继续、准入成功后建立原生会话。占用名额在未完成取消时保持，合入后测试不占开发名额。
- [x] 保存必要状态失败，禁止依赖它启动目标Actor或报告阶段成功；保留已发生文件和真实失败。`resolveDevOperationCommit` 读取真实commit中的record operation及父链，不仅匹配message；最终状态无自引用补交。
- [x] 写V01用例：同根别名／双进程争用、评审占用、合入后共存、pull冷读无模型、损坏新记录保留、旧状态完全不接管、无本地历史、CAS重复／过期、保存失败不启动工作。

**Verification:** V01（统一集成后执行）。**Pass:** 记录可在无聊天机器读取，唯一开发名额不可绕过，没有运行态／聊天／token入Git。

## Task 02: Implement Eight Stages, Imports and Human Decisions

**Files:** Modify `controller.ts`、`orchestrator.ts`、`test/spec-driven/{controller,orchestrator}.test.ts`；导入落点通过T03 API，Agent调用通过T04 ports。

**Interfaces:** `createRequirement/listRequirements/getRequirement/dispatch/observe/stop`；Shared A动作；现有原始 `SpecApproval`保留。

- [x] 替换旧 `start()`直接requirements及`startBusiness()`必启动模型路径：新开发需求先建business；conversation在用户实际请求时创建业务Actor，import仅建记录／材料，不要求正文或业务会话。业务Next仅 `readBusiness`＋owner／结清检查，之后才prepare requirements。
- [x] 纯业务本地写作复用业务Actor、唯一Markdown、查看／下载，不创建Git开发记录、PR、完成报告、归档、团队交付终态或`finishBusiness`；不消耗开发名额或绕过开发建需求流程。用户开发时另建需求导入，不继承旧批准。
- [x] 前五Next逐阶段检查现有模板／结构／上游版本／实际结清，保留原始userReply、全部候选、推荐、选择ID及完整文件；多候选必须会话明确选择，单候选可省略。保存成功才启动下一阶段；查看、普通“同意”、AI消息不调用dispatch。
- [x] 第五Next只确认development报告进入st，绝不调用close／archive。第六阶段允许合法更新同一completion报告，保留开发批准原版本与ST当前版本；结构和事实披露不变，不新增ST全通过门禁。
- [x] 第六标记st-complete、第七pr-submitted／pr-merged、第八tested分别走同次Git确认；记录真实人工决定与观察PR事实分离。pr-submitted显示“已开发”仍占名额；pr-merged须核实对应PR实际merged再进入testing，不由后台查询自动标记。
- [x] 先保存人工决定，再提交推送；保存成功／commit失败不伪报提交，commit成功／push失败保留阶段及SHA且显示未同步。最终tested决定保存并纳入同次commit，再对所有后续业务写入只读；仅允许续办这次已确认operation尚未完成的push，不复活业务执行。
- [x] Back只到相邻上一阶段；business无Back、merged后无Back。清除目标及下游的本轮确认／选择，保留有效上游原文、所有文件／代码／配置／历史／archive位置；不自动模型、Team、Goal。完整成功archive不阻止Back，部分副作用未结清明确阻塞。
- [x] 合入前范围内修复在当前需求继续并失效旧报告本轮资格；上游范围变化按Back重新确认。合入后failure／retest-pending与关联新修复保持原需求代码只读，修复合入只使可复测；completed原需求保持只读，后续新建关联需求。
- [x] 所有action先校验requirement、stage、实际`expectedRecordVersion`摘要、材料hash、宿主签发operationId／token和原生busy树；冲突立即拒绝，不排队成下阶段批准。重复同operation返回既有事实；新operation但过期binding拒绝，不串其他需求。
- [x] 写V02：完整八阶段、无Actor合格／不合格导入、单／多候选、第五Next不archive、ST失败仍可人标记、ST合法报告更新、全部Back边界、已归档修正、PR分标记、最终只读／关联修复、重复及保存失败。

**Verification:** V02。**Pass:** 八阶段人工边界可观察，导入零业务模型调用，ST与独立测试不合并，无旧产品终态。

## Task 03: Make Real Material Locations and Archive Revisions Usable

**Files:** Modify `artifacts.ts`、`resources.ts`、`test/spec-driven/artifacts.test.ts`及已存在vendor `openspec/dist/core/{archive.js,specs-apply.js}`；Create `native-sync.ts`。复用现有 `scripts/spec-driven-resources.ts`／`resource-inventory.ts`收集和打包改变的vendor，不改固定上游身份或独立CLI公共语义。

**Interfaces:** Shared B材料／同步接口；复用 `formalMaterialPaths`、`artifactVersion`、`containedSpecPath`、`assertSpecWritePath`、`parseSpecSolution`、原生 `Validator` 与 `specs-apply.js`实际exports。

- [x] 将逻辑material ID→真实活动／归档路径定位贯穿 `readRequirements`、原生校验、checkVersions、阶段交接、完整材料查看／下载、缺项诊断和actors精确写白名单；不能只改只读viewer。方案／计划／报告始终原路径。返回实际路径、完整字节及hash，不能按当前日期猜archive目录。
- [x] 上传与宿主路径先读取来源，再复制至本需求 `docs/business-requirements/<change-id>.md`。拒绝非Markdown及URL，不把源路径作为内部目标、不覆盖现有独立材料；内部目标继续原有链接／junction／硬链接／普通文件边界，导入源无删除权。Next统一调用原 `readBusiness` 的标题／十章节／非空规则。
- [x] 第七阶段第一次明确同步归档仍调用现有 `SpecArtifactStore.close`／`runOpenSpec(["archive", changeId, "--yes", "--json", ...])`，沿用原生校验和真实移动；Markdown原权威原位维护，已同步按原生 `--skip-specs`，禁止`--no-validate`。
- [x] 完整归档后修正直接修改真实archive材料。需求Agent必须针对**当前主规格**形成可再次合法应用的delta；例如上次已应用的ADDED正文需要修改，应形成对应MODIFIED，而不是声称变化的ADDED可幂等。已移除／改名／本轮不再要求的内容也形成明确相应delta，不能仅删除旧delta就假定主规格随之撤销。旧同步版本由syncRevisions及Git历史保留，不重建活动change目录。
- [x] `native-sync.ts`在既有 `resources.ts`资源定位／进程边界中加载 `openspec/dist/core/specs-apply.js` 的 `findSpecUpdates(realChangeDirectory, mainSpecsDir)`、`buildUpdatedSpec(update, changeId, {silent:true})`、`writeUpdatedSpec(update, rebuilt, counts, options)`；校验使用 `Validator.validateChangeDeltaSpecs(realChangeDirectory)`、`validateSpecContent(id, rebuilt)`，解析仍为该模块现有 `parseDeltaSpec`／`extractRequirementsSection`消费链。不另造正则合并器、不改变独立CLI公共语义。
- [x] 在真实`archive.js`把现有prepare／fingerprint／snapshot／apply／rollback／retirement-finalize事务提取为内部export `syncSpecDirectory(input: { changeDir: string; mainSpecsDir: string; changeName: string; archivePath: string | null; skipSpecs: boolean; expectedSources: readonly { path: string; version: string }[]; expectedTargets: readonly { path: string; version: string | null }[] }): Promise<{ archivedChangePath: string | null; targets: { path: string; version: string | null }[]; progress: SpecCloseProgress }>`；这里是计划定义的返回形状，由bridge映射OMP类型，vendor JS不import宿主TS。原`ArchiveCommand`传原生archivePath，保持原有移动／验证／回滚／retirement语义；归档后重同步传`archivePath:null`，只同步、不移动／重建活动目录。核心解析／build／write继续`specs-apply.js`原函数，retirement仍核实原生metadata授权；不静默unlink、不另造合并器。
- [x] 源码 `ensureSpecDrivenResources()`用现有`collectSpecDrivenResources`重算当前vendor manifest／内容摘要；npm／binary由 `buildSpecDrivenArchive()`及现有archive plugin重新收集并嵌入同一vendor修订，内容地址变更使旧cache不被当新资源。不手改提取缓存或invent旧归档生成参数；V03／资源消费者分别证明源码与打包后桥接均加载实际新模块。
- [x] 每次sync以operationId、acceptedVersions及实际目标版本记录修订；重试已有同步revision只完成未结清cleanup／回滚，不重新apply。材料修订后由人员形成新的sync确认及版本，不把旧 `progress.synced` 当作所有未来修订均同步。
- [x] 保留并准确显示同步后回滚失败、archive已生成但源cleanup失败、retirement备份路径含空格／括号、响应丢失后的真实archive发现。部分副作用未结清阻断冲突Back／业务写；解释只读，明确限定修复不自动重试同步、不自动业务推进。
- [x] 写V03真实native fixture：活动→归档所有材料消费者一致；归档后Back、合法delta修订再同步且无活动源目录；重复确认无重复archive／apply；变化ADDED真实拒绝；递归新增spec失效；原有rollback／source cleanup／retirement失败矩阵完整保留。

**Verification:** V03。**Pass:** 已归档需求可在第七阶段继续修正并原生重同步，所有失败事实可续办，归档不终结需求。

## Task 04: Preserve Native Actors, Recovery, UI and Recursive Permissions

**Files:** Modify `actors.ts`、`runtime.ts`、`skill-policy.ts`、`test/spec-driven/{actors,actors-descendants,runtime,skill-policy}.test.ts`；T08消费原生UI seam。

**Interfaces:** 现有 `createSpecDrivenRuntime`、`SpecDrivenRuntime.stop/dispose`、`SpecDrivenPorts.agents`、`SpecConversationRecipient`；新增 `DevSolutionBasis`持久事实；Shared D原生UI request。

- [x] business／requirements继续原Grill-me及固定职责、solution完整候选／推荐、planning原writing-plans裁掉Execution Handoff、execution原using-superpowers＋subagent-driven-development；不改包内技能原文／版本。保留只读scout、知识检索、MCP、扩展、原生task／reviewer／wait及模型／上下文设置。
- [x] `runtime.originalRequest`对导入显式表达“无原业务访谈”，只交完整业务文件及当前人员决定，不能伪造原始对话。恢复可用历史保留各阶段自身选模；缺失／损坏历史保留同需求和批准，人员主动续聊才根据正式材料＋原批准＋当前输入建立真实新会话。
- [x] `actors.checkSolutionCandidates`不再把本地聊天存在作为唯一恢复依据。生成正式方案时由宿主从真实native单Agent／Team结果核对候选可采用关系，保存绑定solution hash的 `DevSolutionBasis`；跨机器无历史时使用该必要事实，不复制聊天／Team全文，不放宽Team失败／不可采用方向检查。hash变化必须重建来源证明，不能信任任意JSON或模型自报。
- [x] 网页仅保留既有Team使用开关，成员与模型角色继续原有配置方式，不新增网页配置入口；Team只在进入solution时启动，普通追问、查看、恢复、Back不重跑；失败仍受阻、不自动降级单Agent。Goal只由用户对当前执行会话手动开启／设置／预算／暂停继续，报告后停止自主写，恢复不自动启动。
- [x] 按阶段、报告资格、merge／completed事实、明确修复授权计算实际工具policy，覆盖直接工具、shell、eval、自定义／扩展工具、MCP写入、task注入与任意深度后代；旧accepted＝永远收尾的条件改为精确阶段授权，不为宿主commit放开早期Agent shell。
- [x] testing只允许读和更新自身 `docs/dev-requirements/<id>.json` 的业务状态；记录结构仍由owner CAS保存，Agent不能任意写JSON绕过人工mark。可能写缓存／报告／电路／代码／Git的测试命令，只有现有受限执行能力能证明符合范围才运行，否则明确阻塞。不能以提示词、命令名看似test、执行后diff或允许所有bash替代写边界。completed拒绝新写及后台续轮。
- [x] 保留原生deny／restrictedFolders／项目规则／安全路径／早期精确文档白名单。需求材料归档后白名单指向真实archive，不误放行旧源。普通询问只读，明确范围内修复才解除对应限制；未结清同步副作用只开放限定故障处理。
- [x] 原生select/editor、confirm、tool approval、权限拒绝、原生命令／模型／推理设置、Team／Goal及子代理操作必须接到真实目标会话和既有pending promise，保留原生审批模式及默认deny；没有可用网页呈现的交互须实现其薄适配，不能要求回终端或自动批准。原生UI响应校验session／generation／reqId并首答结清；断线不等于取消／批准。
- [x] stop／delete／host shutdown复用 `cancelSpecDescendantJobs`、AsyncJobManager lineage及runtime原有prepare／active屏障，等真实promise结清，保留失败halted，不影响无关owner；页面unsubscribe不调用这些方法。
- [x] 写V04：精确写路径／设备／links/hardlinks、读写工具组合及递归后代、缺历史恢复与Team provenance、模型归属、所有原生审批类型、报告后／ST／归档故障／合入后／completed权限，cancelled回执但cleanup未结清继续阻断。

**Verification:** V04。**Pass:** 原生能力不缩水、权限不放宽，纯浏览器正常操作不需要终端补审批。

## Task 05: Add the Minimal Native Scoped Commit Primitive

**Files:** Modify `crates/pi-vcs/src/{types.rs,git/mutate.rs,git/cli.rs,git/patch.rs}`、实际N-API owner `crates/pi-natives/src/vcs.rs`；通过现有 `packages/natives/scripts/build-bindings.ts`生成 `packages/natives/native/index.d.ts`；Create `packages/natives/test/dev-workbench-vcs.test.ts`，不手改声明冒充ABI。

**Interfaces:** Shared C的 `commitCreateScoped/remoteRef/applyOwnedPatch`及已证实filter／hook缺陷所需的 `previewOwnedPatch/stageFilesIntoIndex/hookPath`；复用existing `commit_create`中的身份／`sign_commit`、index锁／read/write、ref CAS、网络runner及patch helper；新路径不调用`run_commit_hook`，普通API原语义保留。

- [x] 最小提取共享commit实现，scoped方法固定symbolic source ref、HEAD SHA、真实index版本、确认tree和两份隔离index。持真实index锁核对版本，精确消耗所属暂存内容并保留同文件无关hunks／flags／entries；不使用真实index拼装确认tree。
- [x] 新scoped路径不恢复、不执行任何Git hook，不通过hook自动运行gates／formatter或扩大写范围；保留原生身份／签名。有实际生效的hook要求与当前禁用规则无法兼容时，预先明确阻塞，不修改用户配置或偷偷绕过／运行hook；签名失败不移动HEAD。既有普通`commitCreate`不因新入口改变。
- [x] ref CAS后发布协调index，返回`refUpdated/indexUpdated/sha`；两步非跨文件原子，HEAD成功／index失败保留真实commit并可续办index，不能再commit或自动回退HEAD。含冲突index／无法保留状态／非预期分支／unborn HEAD在变更前阻塞，不能通过普通index map丢弃冲突entries。
- [x] `remoteRef`只查明确fullRef，严格区分不存在与网络未知；fetch必要对象仅用私有观察ref，不创建／切换开发分支。`applyOwnedPatch`复用原patch解析和逐路径落地，前像校验＋部分路径结果，不承诺`canApplyPatch`成功等于后续原子应用。
- [x] 贯穿Rusttypes、`vcs.rs`实际N-API options／methods／results及生成声明；普通工具行为不变，不以现有`commitTree`代替必须的签名／ref／index发布。
- [x] 写V05专属native消费者：同文件hunks、无关index语义／worktree、有效hook预先阻塞且未执行、签名失败、ref／index竞态、ref成功index失败续办、remote不存在／超时／响应丢失、逐文件patch部分失败。index可合法重写，但无关entries／flags／暂存语义必须保留。不直接运行Cargo，不把既有`test:rs`知识模块范围冒充VCS行为覆盖。

**Verification:** V05，native build／binding生成只在获后续实施验证授权的集成阶段进行。**Pass:** 只提交确认tree，原生能力与真实用户index保留，无只写声明的伪实现。

## Task 06: Implement Scoped Git Operations and Actual PR Facts

**Files:** Create `spec-driven/git.ts`、`forge.ts`、`test/dev-workbench/git.test.ts`；消费T01/T05，不调用 `commands/git.ts`、`commands/commit.ts`或 `commit/agentic`整index流程。

**Interfaces:** Shared C；现有VCS `headSha/currentBranch/configGet/remoteList/remoteUrl/resolveRef/revListRange/mergeBase/showBlob/showCommit/commitDetails/diffText/diffTree/readTree/applyPatch/writeTree/push`；现有Forge runner。

- [x] 创建需求时固定已有HEAD／index状态；只对实际受控写入路径记录开始前worktree／untracked前像和随后所属patch，本地恢复资料由既有native缓存／Git对象引用持有。不新增全工作区正文快照／监视器／代码漂移门禁；开始前dirty及用户外部改动不按时间自动认领。正式提交展示并由人明确确认归属。
- [x] 从真实配置／远端查询发现existing source／base／remote候选；歧义让确认选择，不猜`origin/main`，不调用pr_checkout创建分支。固定源仓／源ref、目标PR仓／base、发布remote／ref及observed remote tip；没有合法PR拓扑／凭据时明确阻塞。
- [x] preview绑定实际recordVersion摘要、stage、symbolic ref／HEAD、index版本、内容hash、scope和真实remote tip，展示全部待发布祖先及proposed tree；新commit尚未存在不预填SHA。确认后再核对，目标／内容／HEAD／index变化拒绝旧preview，不扩大授权；remote URL持久化去除嵌入凭据。
- [x] 以 `readTree(HEAD, temporaryIndex)`＋精确`applyPatch(...indexPath)`＋`writeTree`构造commit tree，并预构造真实index协调结果；调用T05 scoped commit同时负责index协调。message含requirementId／operationId，核实实际tree／parent／record operation。不能清空真实index、整文件stage、留下已提交内容的反向暂存或丢冲突entries。
- [x] 文档可提前提交、代码可分批提交；会话提出范围请求、宿主确认执行，Agent不能自主Git写。实际SHA由native结果／真实对象核实，message不作为唯一归属。squash／rebase后原对象不可达且无可靠映射时如实显示不可解析，不把merge SHA冒充原SHA。
- [x] same-operation顺序：确认→保存决定→scoped commit及index协调→核实SHA→`push({remote, refspec: fixedSha + ":" + targetRef, forceWithLease:false})`→`remoteRef`查证。ref成功index失败只续办index；push响应丢失先查实际远端是否等于／包含确切SHA，未知照实显示，不重做commit或推动态HEAD。
- [x] `revListRange(observedTip, fixedSha)`核实全部待发布commit；不存在remote tip使用完整可达集合调查，不能省略祖先。若含未获本次需求范围授权的其他需求commit，明确待同步／拒绝push，即使本次commit本身只有A记录；不夹带B、不cherry-pick到新分支、不rebase／amend已成功commit、不force。人工确认不允许顺便扩大成其他需求交付。
- [x] `forge.ts`通过 `github.run/json/text`／GitLab已有runner的实际能力查询／创建／关闭明确PR；保存repo、number、source/base、head/base SHA、mergeSha与真实state。查询展示字段不足时新增精确Forge查询，不从缓存或文本猜merge。创建超时先按明确source/base和关联operation查实际PR，不盲目重复创建；实际不支持的Forge操作如实阻塞。
- [x] pr-submitted仅在真实PR已存在且来源匹配后记录；pr-merged在人员点击时重新核实merged，不由后台观察代点。合入后status发布只承诺本次目标；同分支merge／squash／rebase实际拓扑经确认，不自动reset／pull/rebase／直推base。
- [x] 写V06：真实bare remote／临时repo、脏index隔离、同文件patch、分批SHA／自引用解析、过期preview／并发、保存／有效hook阻塞／签名／push失败及丢响应、未授权祖先拒推、A测试与B未推commit、普通既有分支无ompPr配置、PR参数／query失败。Forge故障fixture只证明接口恢复，不冒充真实GitHub／GitLab在线验收。

**Verification:** V06。**Pass:** saved／committed／pushed准确分开，重试不重复副作用，任何push均不夹带未授权需求。

## Task 07: Cancel Unmerged Requirements Without Losing Unrelated Work

**Files:** Create `spec-driven/cancel.ts`、`test/dev-workbench/cancel.test.ts`；仅经T02 dispatch调用；复用T04真实stop与T06范围Git／Forge。

**Interfaces:** `planDevCancellation/executeDevCancellation`；Shared C；既有 `canApplyPatch/applyPatch/diffTree/showCommit`。

- [x] 删除预览以PR真实未合入为界，不以commit／PR／archive存在拒绝；列出本需求全部明确SHA、文档、代码、主规格同步、archive路径、暂存／未暂存／untracked归属及冲突。外部导入源与需求前原有内容不属删除范围。
- [x] 确认后先将需求置cancelling并保存，停止并等待本需求所有原生任务／Goal／Team／后代真正结清，仍占名额；再重新查询PR。请求关闭后核实最终state；如果确认期间merged立即拒绝撤销，已发生事实保留。超时先查事实，不假报取消。
- [x] 按实际commit父子依赖而非`revListRange`时间顺序逆序构造补偿；merge commit必须有明确parent／归属依据，不猜mainline。shared文件只反向应用所属patch；代码、文档多批commit、archive移动及主规格写入都覆盖，不reset／强推／整体restore start HEAD。
- [x] staged和unstaged分别按开始基线、所属patch及当前版本检查；存在用户／后续修改重叠、归属不明、无本地未提交基线时列具体冲突等待人员处理，不猜、不覆盖。需求独有新增文件可删除，既有共享文件保留；二进制／重命名／删除按真实Git diff支持能力处理，不支持或无法确认时阻塞，不静默漏项。
- [x] 每个破坏性批次前重新查询明确PR及head身份；close不是远端事务锁，reopen／merge／查询未知立即停止，不声称本地锁能锁住远端。工作树落地经T05 `applyOwnedPatch`前像校验和逐路径结果保存，部分失败只恢复仍匹配本操作后像的路径；其他人已改路径不覆盖。已成功路径和待处理路径可续办，不以TS try/catch假装全量原子回滚。
- [x] 在原分支新增关联requirementId的补偿commit／必要push，保留原始Git／PR历史及最小cancelled tombstone；撤销正式材料但不删除审计事实。已成功PR关闭／局部撤销／补偿commit保留并可按operation续办，不重复逆应用。
- [x] 仅在所属撤销全部完成、必要保存／Git步骤和native结清都确认后标记cancelled并释放名额；部分失败保留cancelling／明确待结清，不把旧drop清状态作为成功。已合入一律拒删，completed只读。
- [x] 写V07：文档C1＋代码C2/C3＋已归档／主规格修改＋staged／unstaged；无关／后续同文件变化保留；外部源不变；PR merge竞态、close响应丢失、取消清理阻塞、撤销冲突续办、双人重复删除、已合入拒绝。

**Verification:** V07。**Pass:** 撤销需求全部明确所属变化且历史保留，任何未结清均不释放名额，不损害无关内容。

## Task 08: Host Native Sessions and a Long-Lived Workbench Service

**Files:** Reuse restored ordinary `main.ts`公共能力；Create独立 `dev-workbench/{host,server,native-ui}.ts`、`test/dev-workbench/{host,server}.test.ts`。

**Interfaces:** Shared D；独立 `dev-workbench/host.ts`拥有Dev bootstrap，复用 `createSessionManager`、`buildSessionOptions`、原生SDK session初始化、controller observe、现有Bun.serve／capability路径模式；`main.ts`恢复普通启动职责，不照搬一次性Sketch关闭语义。

- [x] Dev bootstrap集中于独立 `dev-workbench/host.ts`，复用普通启动公共能力，使CLI dev沿用profile／cwd／模型／settings／auth／MCP／extensions／loadedProjectContext／asyncJobManager及原生审批策略；`main.ts`普通launch行为保持原职责。不要伪装interactive或无UI模式来吞掉pending请求。
- [x] `/dev`宿主借用当前真实root能力，业务Actor独立持有；普通TUI主聊天不bind到Dev阶段。Dev活跃期间普通侧锁定，退出实际结清后释放服务但不dispose借用root；standalone仅释放自己创建的root。开发名额仍由workspace统一控制。
- [x] 原生entries只安装一个真实 `sessionManager.onEntryAppended`发布者向网页／Collab扇出；当前Host设置／清空单槽不能让两者互相覆盖，拆卸只移除自身listener。复用原 `snapshotForReplication`／shrink／chunked welcome与native `getContextUsage()`，不复制第二套序列化或伪造context usage。Agent列表／transcript／kill／revive严格限当前owner及后代。
- [x] 监听与URL策略固定：非offline绑定`127.0.0.1:0`；offline绑定`0.0.0.0:0`，就绪后打印实际`http://<宿主IPv4或主机名>:<port>/<capability>/`及本机loopback入口。地址取真实非loopback网卡，多个候选全部列出而不捏造唯一可达性；端口取server实际分配值。页面连接携带capability并校验Origin／Host，offline不额外要求证书／认证；非offline不放宽原远程控制边界。无法发现远端地址明确给本机可用地址和网络限制，不把0.0.0.0当可访问URL。
- [x] 按Shared D实现真实requirements／actions／materials／import／Gitpreview／cancel-preview／native UI／Collab endpoints；错误按保存、业务准入、原生工具、Git、PR明确返回，不返回成功占位。文件读取只经已登记material，不暴露任意宿主文件下载。
- [x] WS只呈现host事实和原生事件；连接close／unsubscribe最多释放listener和本browser guest，不调用controller.exit/stop/dispose。显式Stop通过owner结清；host close等待原生工作及持久化，失败真实呈现，不自动删除／归档／commit。
- [x] native-ui映射真实select/editor/confirm／tool approval等待对象、权限模式和取消语义；reqId＋requirement＋session＋generation绑定，首个有效应答结清，旧页／旧代际拒绝。原生deny原样保留。未join房主也可在网页完成正常原生交互。
- [x] prompt、附件、命令、模型／推理控制、原生队列、子代理详情绑定提交时target session；切列表不消费草稿、不把晚到结果投到新阶段。拒收／失败保留本次文本及附件各一次；不创建独立Dev消息队列或正文副本。
- [x] 写V08：双启动宿主复用、准备失败不输出假URL、普通聊天不换绑、无Actor快照、原生UI race、断开长任务继续、重连无重放、host shutdown真实结清、服务只能读取所属材料。

**Verification:** V08。**Pass:** 宿主是唯一执行owner，页面不拥有任务，正常原生流程无需终端接力。

## Task 09: Build the Real Browser Workbench from Existing Components

**Files:** Create collab-web工作台入口与`test/dev-workbench.test.tsx`；Modify `Composer.tsx`、`AgentDrawer.tsx`、`app.tsx`、`lib/client.ts`及受影响组件tests。

**Interfaces:** Shared D HTTP／WS；Composer最小发送port；直接复用 `Transcript`、`Markdown`、`ToolCard`／ToolView、现有agents panel／drawer、原生wire状态。

- [x] 按已批准原型／参考图的信息层级实现四区，不逐像素复制：左需求列表、中央材料上方固定八阶段、中央只读真实材料、右共享AI会话且输入在底部；Dev默认深色，普通App主题默认值不变。进行阶段／查看阶段分离。点击阶段／需求不发prompt、不启动Actor、不dispatch、不推进、不隐式join；缺失／不可读／未生成显示真实原因，无演示数据。
- [x] 方案显示全部候选、完整Markdown内容及推荐／理由，保留正式方案JSON文件格式但不新增原始JSON查看面板；通过当前会话选择，Next消费实际选择。Markdown保持现有HTML转义与链接协议边界，不增加编辑器。
- [x] 新建需求、显式本地业务写作、上传Markdown、宿主路径、下载及当前进行阶段适用的Next／Back、既有Team使用开关、ST／PR／tested人工标记、测试状态／修复关联和删除撤销预览接真实host；不把全部动作铺成控制台，不新增网页成员／模型角色配置入口。未选需求时引导新建，不默认本地写作、不自动启动Agent，无目标且未join时输入不可发送。按钮可用性来自owner，前端校验不代替后端门禁。
- [x] 明确操作时才显示对应确认／结果：标记同次确认展示需求、原／新状态、实际文件／patch、既有source/base/remote、target ref、remote tip、全部待发布commit和风险；取消确认无副作用。saved／committed／pushed与真实错误／续办以可读结果区分，不把未同步画为全成功，不隐藏最后tested未推送事实；不展示JSON状态／参数、内部hash或调试面板。
- [x] 从现有App提取可嵌入session面，Composer依赖最小port，普通Collab App仍可使用GuestClient。右侧底部输入支持现有内置斜杠命令和技能发现／调用，走真实目标会话，不用原生命令下拉框或JSON参数表单替代。完整原生history、流式tool／partial、失败／abort、队列、问答、确认、权限审批、模型／推理、Team／Goal和子代理详情复用既有能力，适用交互按需呈现，不另建配置／权限／聊天引擎。
- [x] Composer按`DevSubmitResult`处理真实owner准入：本地owner完成原生输入接收返回accepted；拒收返回rejected，网络／relay无可靠接收回执返回unknown。既有Collab prompt协议没有业务exactly-once ACK，不把socket.send成功冒充Host接收；unknown保留草稿／附件并查询可确认事实，不自动重发。保留IME与ask editor空白原文，输入绑定requirement／recipient／generation，迟到UI不误答；普通独立GuestClient适配不扩大其旧安全边界。
- [x] 显式共享／join入口与打开工作台分开；离开仅guest。房间结束／会话换代显示已结束，不自动按用户名跟进下一阶段。
- [x] 调整受呈现变更影响的既有组件合同与V09／V14消费者：参考四区、默认深色、当前阶段控制、只读导航／全部候选、空状态及显式本地写作、输入内置命令／技能；保留零对话上传Next、人工确认取消／部分失败、原生权限弹窗／附件恢复、测试只读／修复关联及页面关闭重连的有效覆盖。不为文案、内部常量或接线另造测试，不重跑无关已通过范围。

**Verification:** 已执行直接受影响的 V09／V14 消费者及实际参考布局查看，结果见账本。**Pass:** 真实网页符合四区、默认深色及简洁当前阶段操作，右侧输入复用命令／技能并完成适用原生交互；普通 Collab 及通用 renderers 继续复用。旧技术控制台及 light 主题截图不作为新呈现验收证据。

## Task 10: Connect Offline Browsers to Existing Collab Rooms

**Files:** Create `dev-workbench/collab.ts`、`test/dev-workbench/collab.test.ts`；Modify现有 `collab/host.ts`／`controller.ts`最小宿主端口；T09 join UI调用Shared D。

**Interfaces:** 复用 `resolveIntranetUsername`、现有 `CollabSocket`、native crypto、protocol／wire GuestFrame、房主现有snapshot／UI／prompt处理。新bridge只做browser peer与native guest transport映射。

- [x] owner共享当前真正AgentSession仍走既有CollabController／Host／Relay及offline配置；不新增Relay或会话存储。明确share当前会话，不因打开页面自动发布。
- [x] 浏览器显式join用户名或现有link；服务端offline校验后使用既有lookup，同relay origin校验及现有错误；每个browserId独立guest peer、room generation、reqId和显示名。welcome＋完整snapshot成功才报告joined。
- [x] 不在房主ctx实例化完整 `CollabGuestLink`；只复用socket／crypto／protocol，browser只访问同源工作台，lookup和加解密留native，避开HTTP缺少`crypto.subtle/randomUUID`及CORS，不放宽独立GuestClient。提取现有client生产frame reducer供bridge消费，不调用`applyFrameForTest`生产入口；chunked snapshot、entry/event、agents/bus、ui-request/ui-request-end、bye/error完整到达现有消费者。
- [x] prompt／原生UI response／显式abort／agent命令／transcript沿用原生Host校验及wire；工作台Next／Back／标记／删除通过同owner API，不冒充prompt或ui-response。offline已加入的参与者可用全部业务操作，非offline仍原有邀请／view／write与命令门禁。
- [x] 断开／leave只关该guest，不停房主；pending UI仍由Host持有、首答结清并校验旧room／generation／reqId。网络掉线／换代立即停止mutation准入并复用 `CollabSocket.discardPendingSends()`撤销未发帧及异步sealing，不只禁按钮；重连只恢复snapshot／结果，不重放prompt／abort／UI答复／业务动作。房间终结不自动lookup跟入下一Agent。
- [x] 写V10真实本地既有Relay＋原生Host＋两个纯浏览器：同一历史／回复／tool／UI、普通远端HTTP／WS、用户名未共享／冲突／异源／不可达、非offline拒绝放宽、readonly不升级、离开不中止、换代不跟随、原生deny仍拒绝。

**Verification:** V10及V14。**Pass:** 不要求访客各运行OMP，不新增证书／SSO前置，不抢房主native ownership，不跨阶段迁移。

## Task 11: Cut Over Both Launch Entrypoints and Observable Browser Opening

**Files:** Create `commands/dev.ts`、`test/dev-workbench/cli.test.ts`；Modify `cli-commands.ts`、`cli/command-help.ts`、`slash-commands/builtin-spec-driven.ts`、`slash-commands/types.ts`、`utils/open.ts`、`test/spec-driven/command.test.ts`。

**Interfaces:** `getOrStartDevWorkbench`、`openPathWithResult`；既有CLI懒加载注册／有效profile环境解析；不在cli.ts加绕环境的独立启动分支。

- [x] 在commands表注册dev，并把dev加入真实 `PROFILE_FLAG_COMMANDS`，使尾部profile在懒模块加载前生效；支持的launch-global参数按既有解析接入相应表，不能只新增commands项。`omp dev`不变成prompt或TUI，保留真实cwd／profile／模型／offline，help不宣传不存在的参数。
- [x] `/dev`进入独占模式、输出完整ready URL并尝试打开；再次 `/dev` 停止并结清Dev运行后退出。普通工作未结清拒绝进入；Dev期间普通输入／命令／快捷操作不得执行，退出恢复原会话和草稿。不创建需求／Team／Goal，不设计普通session／cwd切换与Dev并存。
- [x] opener共用原跨Windows／macOS／Linux实现但返回可观察spawn／非零失败；服务失败与浏览器失败分开。浏览器启动失败仍打印实际可用URL及原因，不能保证OS opener成功就证明页面已实际显示。
- [x] 删除subcommands声明／补全／帮助和终端new/business/finish-business/next/back/drop/config实现；有参数明确拒绝并列网页入口，不自动转换、不交模型。保留网页对应业务能力。
- [x] CLI宿主常驻至显式退出／信号，shutdown走原生结清；网页close不退出进程。入口本身不自动git pull／写Git／接管其他机器session。
- [x] 写V11源码public CLI及slash consumer：两入口完整URL、进入／退出互斥、普通忙碌拒绝进入、无桌面失败、service失败、旧参数拒绝、环境继承、退出恢复原会话及草稿，无新需求／模型副作用。

**Verification:** V11及V14。**Pass:** 两真实入口同业务能力；新 `/dev` 仅切换独占模式，不恢复旧阶段TUI或子操作，地址真实完整可复制。

## Task 12: Remove Old Dev TUI and Dev–ZCode Consumers Completely

**Files:** File Structure中的T12全部现有modes／zcode消费者；T11独占命令主体，T12统一清退其已无用runtime接口。

**Interfaces:** 删除旧Dev专属 `bindMainSession/showDevCommandStatus/isDevInputRoute/handleDevInput/exitDevForSessionMove`及Dev input mode；不把新API接到ZCode。

- [x] 删除interactive-mode中的Devobserver／状态字段、`native-dev-input`三行widget注册、空transcript视图、Dev详情前缀、stage主聊天切换／retry隐藏、退出／session／cwd切换隐式dispose。保留通用widget容器、普通状态栏、菜单、原生聊天及host shutdown真实资源清理。
- [x] input-controller清除Dev专属Esc、draft detach／restore、target切换、retry／queue分支；command-controller清除shell cwd前旧Dev退出；session-focus移除无消费者专用包装。ui-helpers只删除Dev空视图接线，保留按session隔离compaction queue、迟到拒绝、Team draft恢复及普通focus。
- [x] 删除ZCode旧Devbridge及索引写读、`omp-spec-extension`中Dev协议、`ompSpecDriven/includeSpecDriven/includeSpecBusiness/sendText.specRun`、Dev topics snapshot／delta／replay过滤、workspace/session runs合并及material APIs中的旧Dev分支、Dev catalog命令／模式／退出路由。普通dynamic workflow、artifact版本、会话、权限等共用定义先保留到所属普通schema，不能整块误删。
- [x] 不让ZCode普通`sendText`因通用注册表新增 `/dev` 而启动网页或接管新流程；按其现有命令目录规则把Dev列为不可用／不暴露，旧Dev命令明确不再支持。普通TUI `/dev`仍为网页入口；这是彻底脱钩，不是协商fallback。
- [x] 删除旧Dev index terminal推导（businessCompleted或idle+archive）、本地 `.omp/spec-sessions/<runId>/zcode.json`消费者及恢复入口，但不主动删除磁盘用户索引／历史。不要给新记录建ZCode projection或能力标识。
- [x] 更新所有旧类型import／registry消费者和混合tests；仅删除已无消费者的Dev专属文件／exports／注释，不保留deprecated别名／兼容shim。普通命令、模型、子代理、workflow、权限、TUI菜单／附件／compact都保持原行为。
- [x] 写V12普通消费者正向＋Dev拒绝断言：普通ZCode run／artifact／permissions／session／workflow仍有效，所有transport快照／delta／replay无Dev专属字段；普通TUI在Dev退出后retry／queue／cwd／focus无回归，不要求两模式并行。

**Verification:** V12及T14覆盖迁移审查。**Pass:** 无新ZCode接入、无旧Dev产品残留或双轨，普通功能保留。

## Task 13: Embed One UI Payload Across Source, Npm and Binary

**Files:** Create `scripts/dev-workbench-resources.ts`、`src/dev-workbench/assets.ts`、生成载荷`src/dev-workbench/assets.generated.json`及`test/dev-workbench/resources.test.ts`；Modify现有 `scripts/{bundle-dist,compile-binary,build-binary}.ts`、coding-agent／collab-web／根package.json，复用spec资源archive链。

**Interfaces:** 新增 `buildDevWorkbenchAssets(): Promise<ReadonlyMap<string, { bytes: Uint8Array; contentType: string }>>`、`createDevWorkbenchAssetsPlugin(assets: ReadonlyMap<string, { bytes: Uint8Array; contentType: string }>): Bun.BunPlugin`；`getDevWorkbenchAsset(path: string): Promise<{ bytes: Uint8Array; contentType: string } | null>`。服务和构建共用同一asset manifest。

资源验收元数据也由同一生成器固定：`DevAssetManifest = { digest: string; sourceDigest: string; files: readonly { path: string; contentType: string; version: string }[] }`；`getDevWorkbenchAssetManifest(): Promise<DevAssetManifest>`，服务capability内`GET /api/assets-manifest`返回这个形状。`digest`覆盖实际UI载荷；`sourceDigest`在构建时对本工作台运行依赖、生成输入及所用包内资源的规范路径／实际字节排序取SHA-256，源码与成品同算法，运行时只读嵌入值、不重新扫描工作区。成品程序用本次生成manifest比对两个摘要，不能用相同版本号／旧dist文件的存在代替本次来源。此为验收身份而非运行遥测、聊天／业务状态或新发布系统。

- [x] 从真实 `collab-web/dev-workbench.html`／React入口用Bun构建生产HTML／JS／CSS及需要的既有renderer资源，content-addressed manifest保存实际MIME与字节；不要把现有export-viewer生成器冒充完整工作台。
- [x] 参照现有resource archive plugin在npm `bundleDist()`及binary `compileCodingAgent()`接入同一插件；`build-binary.ts`及所有调用compile helper的既有发行消费者自动得到工作台，不依赖某一wrapper先生成。普通ZCode打包保持，不加Dev协议。
- [x] 新生成器CLI固定`bun packages/coding-agent/scripts/dev-workbench-resources.ts --write`，写`assets.generated.json`（manifest／digest／MIME／base64字节）。源码准备接根`postinstall`及显式`gen:dev-workbench`脚本；`getDevWorkbenchAsset`只延迟读取／缓存已生成载荷，HTTP请求不编译、不联网／启动前端server。缺载荷明确报准备缺失，不回退运行时构建或演示页。
- [x] npm prepack／`bundleDist()`和公共`compileCodingAgent()`调用同一生成器／插件，SDK源文件白名单包含生成载荷，不依赖同级collab-web checkout；root现有postinstall的OpenWiki准备保留。新UI生成不等于发布；保留stats／export-viewer／OpenWiki／spec链和仅自有输出清理，禁止CDN／远程字体／JS补取。
- [x] 写V13 source资源fixture：clean manifest、所有HTML引用／MIME／完整依赖、无公网补取；缺asset明确失败。npm／binary实际消费者由T14独立成品程序执行，不在普通测试中要求成品路径，更不能以源码替代成品证据。

**Verification:** V13；构建仅在后续明确授权的集成验证执行。**Pass:** 三种真实启动来源均完整内嵌UI，无另起前端server。

## Task 14: Replace Old UI Acceptance While Retaining Effective Native Coverage

**Files:** Create `test/dev-workbench/{fixture.ts,browser.e2e.test.ts,process.e2e.test.ts}`和独立非test程序`packages/coding-agent/scripts/verify-dev-workbench-package.ts`；迁移列明旧spec-driven TUI／native-surface及Dev ZCode消费者；Modify既有选测／smoke／脚本自测文件。

**Interfaces:** 复用provider／环境准备，不复用旧`process-fixture.ts`的ZCode PublicPeer驱动Dev；保留其非Dev资源场景。fixture新增`resolveInstalledDevChromium(): Promise<string>`：先校验显式`PUPPETEER_EXECUTABLE_PATH`，否则只枚举现有`systemChromiumCandidatesForTest()`并用`chromiumExecutableProbeForTest(path)`做无下载版本探测；仅返回已存在且可执行的Chromium，缺失立即前置失败。随后固定该环境变量并给`loadPuppeteer().launch`明确`executablePath`，复用`closeLaunchedBrowser`清理。**不调用会走`browsers.install()`的未固定ensure路径**，不自动下载／安装。命名为ForTest的现有探测只在本测试fixture使用，不变更生产browser安装策略。

- [x] 建立隔离HOME／profile／config／data／cache／TEMP、临时真实Git／bare remote、localhost模型、独立工作台端口和既有Relay的最小fixture；继承门禁Bun transpiler cache约定。所有进程／浏览器／端口／native任务在自有cleanup结清，不读取用户凭据、不访问真实模型／remote。
- [x] 对旧 `tui.e2e`、business／materials／closing／lifecycle／interactions／capabilities／resources／compact-mixed等真实覆盖建立逐项去向表：材料缺失／格式／版本／路径失败矩阵进T02/T03，权限／停止／后代／Team／Goal进T04，交互／附件／draft／错误与生命周期进网页native consumer；只删除固定三行、旧toggle、直接requirements、finish-business、四次next终结、drop留文件和旧恢复这类废止产品断言。
- [x] 精确保留两处四角色材料失败矩阵：`tui-materials-cases.ts`及`process-fixture.ts`的requirements／solution／planner／executor × missing／malformed／unknown迁到新公开消费者；每例独立provider，原阶段／批准／输入／历史不变、具体错误可见、无后继模型，原平台条件／时限不放宽。`tui-compact-mixed`普通长会话／工具／子代理／压缩、`tui-resources`普通技能、`tui-capabilities`普通工具错误／独立需求场景继续保留，不能因文件前缀退役。
- [x] `native-surface.test.ts`不再验Dev三行和stage换绑；保留其普通TUI native surface、draft／附件／viewport／cwd相关有效断言到现有普通消费者。不删除TUI引擎或通用PTY smoke来让范围变小。
- [x] Dev-only ZCode tests退役，混合普通protocol／workflow／artifact version（包括超过16版本）／permissions场景迁入仍存在的普通tests，补旧Dev字段／命令拒绝；绝不将旧Dev协议tests改成新workbench协议tests。
- [x] `browser.e2e.test.ts`用实际headless Chromium和已服务的真实构建UI，不用renderToStaticMarkup替代DOM：完整八阶段、Markdown导入零对话、所有候选、只读导航、审批／工具／附件、Back／ST报告、同次Git标记及失败／续办、删除冲突、合入后修复／只读、刷新重连无重放；模型夹具只提供确定输入，断言真实工具／文件／Git／PR结果，不把模型回答当通过。
- [x] 新`process.e2e.test.ts`经真实`src/cli.ts dev`及普通TUI `/dev`验证双入口／环境／聊天不换绑；普通TUI部分复用既有`tui-harness.ts`／`tui-test`，不另造PTY/ANSI驱动。保留真实Team持久化／取消、Goal手动／报告后停止及长任务断线消费者；Dev部分不再用app-server PublicPeer。
- [x] `fulltest-ui-smoke.ts`按场景只替换真实旧Dev接线，保留普通CLI／`/team`／取消／输入／退出及真实JUnit。`test/dev-workbench/`仅放不依赖成品的source tests，并显式接fork白名单；新process/browser归既有启动敏感组，普通TUI／Goal保留，不开绕预算通道。成品程序在scripts下采用非`.test/.spec/.e2e`命名，普通发现、全仓Bun及`--full`均不会执行，不靠skip排除。
- [x] 默认fork目前不含collab-web，精确新增`dev-workbench.test.tsx`、`composer.test.tsx`、`transcript.test.tsx`、`tool-view.test.tsx`、`markdown.test.tsx`，不加入整个包／Browser／upload／relay套件；native只加`test/dev-workbench-vcs.test.ts`。同步`:1839/:1852`一类文件计数／空选择探针识别`.test.tsx`，使执行与报告一致。
- [x] `ci-test-ts.ts`当前`suiteRevision:2`统一升为3并更新所有完整基线资格／脚本期望，旧完整报告不得冒充新消费者范围完整证据；affected／失败报告语义不变。新public process fixture声明对实际workbench启动／资源／tools registry的静态依赖，不仅字符串spawn CLI，也不import执行主入口造图。预算、并发、高成本chunk上限、skip／授权及平台时限完全不变。
- [x] 独立成品程序参数固定`--npm-entry <path> --binary <path> --assets-manifest <path>`，必须提供实际本次构建产物，启动各自真实CLI dev并在浏览器验证完整内嵌UI；脚本读取manifest预期摘要，并核对服务`GET /api/assets-manifest`的实际载荷摘要及当前构建来源标识，旧产物不冒充本轮。缺产物／浏览器／来源不匹配立即失败，不回退源码／空通过／自动releasebuild；不注册到default fulltest／slowtest／`--full`，仅获得单独成品验收授权时显式调用。真实OS桌面、其他平台／CentOS产物不由headless结果冒充。
- [x] 为31项建立可观察业务断言及实际文件／Git／runtime证据对应，统一执行V14；一项失败如实报告，不以选择更窄用例冒充完整交付。

**Verification:** V14以及各片V01—V13；统一主代理执行，禁止各片自行风暴式跑gates。**Pass:** 新网页和原生真实消费者取代旧专属UI，所有有效失败／权限／取消／Team／Goal／普通TUI合同仍有去向。

## Task 15: Synchronize Docs and Complete One Clean Cutover

**Files:** Modify `openspec/specs/fork-verification-gates/spec.md`、`openspec/specs/spec-driven-orchestration/spec.md`及本变更对应orchestration delta中必要的方案来源恢复措辞、中文八阶段说明、coding-agent CHANGELOG、collab-web README；其他已正确授权需求／历史清理保留，不重复覆盖。当前计划按实际执行状态维护，不创建另一tasks文件。

**Interfaces:** 文档只描述已实现真实入口和边界；需求权威不由代码注释／UI文案替代。
- [x] 实施T04持久化来源事实前，将现行主规格“原生历史确证方案来源”的保留合同同步为：来源必须先由宿主从真实native单Agent／Team历史结果确证；保存绑定solution字节版本的最小可采用事实供Git冷读，历史可用仍核对；历史缺失不重造／放松证明。对应当前delta补同样细化，不仅修改实现绕过旧强要求，不新增方案评分／内容AI审核或聊天Git副本。

- [x] 将fork gate中固定旧Dev TUI的测试表、smoke、startup-sensitive及报告合同精确换成T14消费者；保留有效材料失败矩阵、native构建、权限／取消／Team／Goal和普通TUI，不改预算／并发／skip／fulltest授权，不扩大整collab-web suite。
- [ ] 中文说明／命令帮助／Unreleased同步八阶段、五角色、无对话导入、本地业务、ST报告、归档后修订、mark同次Git、PR等待占用／merge释放、cancel冲突、合入后状态限制及修复、断线／宿主边界、两个完整地址入口和内嵌资源。既有说明已经正确的内容保留，不以“已实现”冒充未验证平台。
- [ ] collab-web README区分独立GuestClient既有secure-context限制与新工作台native transport的offline普通HTTP／WS；不能全局删除非offline安全说明，也不能继续写工作台不支持内网HTTP。文档不宣传新ZCode接入、worktree、旧恢复或双轨。
- [ ] 根据R01—R31矩阵逐项核对所有callsite／tests／docs及旧专属删除清单；从实际消费链审查，不用源代码文字快照代替行为。检查新API确有生产调用者、没有只写类型或静态页面；删除本次自有临时夹具／脚手架，不删除用户旧材料或历史。
- [ ] 全部片落地后主代理只运行完成当前变更所需的最小定向验证，统一记录实际命令、退出码、平台、范围和阻塞；未运行写未运行。新的广泛授权覆盖必要命令，不使下表成为必跑清单，也不要求fulltest／slowtest、重复构建或无关真实外部集成；满足验收即停止。Git范围与发布安全边界继续有效，文档同步不执行软件检查。
- [ ] 完成交付只能宣称实际覆盖结果；列出未验证平台／发行产物／真实Forge／模型／桌面边界。任何必需代码／功能未完成则继续实施，不把内部波次当可单独完成交付。

**Verification:** V15文档／门禁选择合同＋全部授权V01—V14证据。**Pass:** 产品、实现、命令、测试、发行资源一致，31项完整，没有旧轨或新ZCode面。

## Exact Verification Commands and Observable Results

**执行规则：** 用户新的广泛授权允许完成任务所需命令，验证仍限八阶段流程、直接改动和普通OMP不受影响，以及项目强制要求；复用现有测试和仍有效的通过结果，不因授权扩大为全套或重复运行。下表是范围映射，不是本轮必跑清单。新增测试或复验必须解决当前正确性的具体问题，不测文案、内部接线或非契约常量。子代理不运行检查，主代理统一执行最小必要范围并记录实际结果；不额外运行不必要的成品构建、fulltest／slowtest、真实外部集成或相邻问题检查。满足验收立即停止，无法验收如实说明。本次文档同步没有新增检查结果。

| ID | 精确命令／前置 | 可观察通过条件 |
| --- | --- | --- |
| V01 | `bun scripts/test-report-bun.ts packages/coding-agent/test/dev-workbench/records.test.ts packages/coding-agent/test/spec-driven/workspace.test.ts` | Git业务事实冷读、CAS和跨进程名额，无旧状态接管／模型副作用 |
| V02 | `bun scripts/test-report-bun.ts packages/coding-agent/test/spec-driven/orchestrator.test.ts packages/coding-agent/test/spec-driven/controller.test.ts` | 八阶段、零业务会话导入、五步批准／Back、ST版本、人工mark及终态 |
| V03 | `bun scripts/test-report-bun.ts packages/coding-agent/test/spec-driven/artifacts.test.ts packages/coding-agent/test/spec-driven/resources.test.ts packages/coding-agent/test/spec-driven/process-resources.e2e.test.ts` | 真实native校验／归档／修订同步及资源桥，原生独立资源语义保留；矩阵Dev驱动已迁离ZCode |
| V04 | `bun scripts/test-report-bun.ts packages/coding-agent/test/spec-driven/actors.test.ts packages/coding-agent/test/spec-driven/actors-descendants.test.ts packages/coding-agent/test/spec-driven/runtime.test.ts packages/coding-agent/test/spec-driven/skill-policy.test.ts` | 所有原生权限／技能／历史／Team／Goal及后代限制与实际结清 |
| V05 | 已当次授权native生成／构建时，`bun --cwd packages/natives run build:bindings`（该现有脚本本身生成声明并安装host addon，无需再重复native build），然后 `bun scripts/test-report-bun.ts packages/natives/test/dev-workbench-vcs.test.ts` | 专属Bun native消费者覆盖scoped commit／index协调／remoteRef／guarded patch；ref成功index失败不重commit，hook未执行；不直接Cargo，不把全部VCS或test:rs知识范围纳入日常覆盖 |
| V06 | `bun scripts/test-report-bun.ts packages/coding-agent/test/dev-workbench/git.test.ts` | 真实临时Git＋bare remote、同次保存／commit／push、SHA解析、未授权祖先拒推、部分失败幂等 |
| V07 | `bun scripts/test-report-bun.ts packages/coding-agent/test/dev-workbench/cancel.test.ts` | 多commit＋暂存／未暂存＋归档完整撤销，PR竞态／冲突保留占用及无关内容 |
| V08 | `bun scripts/test-report-bun.ts packages/coding-agent/test/dev-workbench/host.test.ts packages/coding-agent/test/dev-workbench/server.test.ts` | 长寿命host、真实native UI归属、断开不停止、重连不重放、实际URL／材料边界 |
| V09 | `bun scripts/test-report-bun.ts packages/collab-web/test/dev-workbench.test.tsx packages/collab-web/test/composer.test.tsx packages/collab-web/test/transcript.test.tsx packages/collab-web/test/tool-view.test.tsx packages/collab-web/test/markdown.test.tsx` | 工作台只读导航、共享组件与输入合同；这些组件测试不冒充实际浏览器 |
| V10 | `bun scripts/test-report-bun.ts packages/coding-agent/test/dev-workbench/collab.test.ts` | 真实既有Relay／Host、两个browser peer、普通HTTP/WS offline、非offline及deny不放宽 |
| V11 | `bun scripts/test-report-bun.ts packages/coding-agent/test/dev-workbench/cli.test.ts packages/coding-agent/test/spec-driven/command.test.ts`；公开帮助探针 `bun packages/coding-agent/src/cli.ts dev --help` | dev确为注册命令、双入口真实语义／环境，旧参数拒绝、opener失败保留URL |
| V12 | `bun scripts/test-report-bun.ts packages/coding-agent/test/modes/zcode-commands.test.ts packages/coding-agent/test/modes/zcode-sessions.test.ts packages/coding-agent/test/modes/zcode-projection.test.ts packages/coding-agent/test/modes/zcode-hosts-command-catalog.test.ts` | 普通ZCode正向能力保留，Dev路由／字段／projection已无，不建立新适配 |
| V13 | 新生成器实现且单独授权build后 `bun packages/coding-agent/scripts/dev-workbench-resources.ts --write`；`bun scripts/test-report-bun.ts packages/coding-agent/test/dev-workbench/resources.test.ts`；单独授权成品构建时 `bun packages/coding-agent/scripts/bundle-dist.ts`、`bun packages/coding-agent/scripts/build-binary.ts` | 同一预构建载荷进入source／npm／binary；source HTTP不编译，普通resources测试不依赖成品，不自动发布／releasebuild |
| V14 | source消费者：`bun scripts/test-report-bun.ts packages/coding-agent/test/dev-workbench/browser.e2e.test.ts packages/coding-agent/test/dev-workbench/process.e2e.test.ts packages/coding-agent/test/spec-driven/native-surface.test.ts packages/coding-agent/test/spec-driven/tui-compact-mixed.e2e.test.ts packages/coding-agent/test/spec-driven/tui-resources.e2e.test.ts packages/coding-agent/test/spec-driven/tui-capabilities.e2e.test.ts`。**另行明确授权成品验收且V13生成实际产物后**，Windows：`bun packages/coding-agent/scripts/verify-dev-workbench-package.ts --npm-entry packages/coding-agent/dist/cli.js --binary packages/coding-agent/dist/omp.exe --assets-manifest packages/coding-agent/src/dev-workbench/assets.generated.json`；Linux同命令仅binary参数为`packages/coding-agent/dist/omp` | source／普通TUI与成品证据分开；成品非普通test，不会被fork／`--full`自动执行，不添加skip、空测试或下载；验本次真实资源／来源及无checkout／CDN依赖 |
| V15 | `bun scripts/test-report-bun.ts scripts/ci-test-ts.test.ts scripts/fulltest.test.ts` | 旧Dev专属选测已替换，新消费者进入原预算／范围，普通TUI仍在，未扩大上游suite |

手动实际用户路径的最终业务验收包含：`omp dev`或`/dev`→上传现有Markdown→零业务会话Next→四开发阶段→ST失败／未执行如实记录但由人标记→第七步同步归档→PR已提交仍占用→评审修正／必要Back及重同步→人员标记真实合入→原需求测试与下一开发共存→失败关联修复→修复合入后原需求复测→已测试同次范围commit/push并只读。另一路为未合入分批提交需求完整取消。该路径应由V14隔离真实消费者自动化，不要求共享桌面／真实模型来代替程序断言；真实外部Forge、其他平台和桌面opener能力须另列实际验收证据。

### Actual Evidence Ledger — 2026-11-07 Handoff

本账本只记实际已行使的范围，不把上表命令清单当执行记录。报告基准为 Win32 x64／Bun 1.4.4；每个完整run ID对应 `runs/test-timing/<ID>/run.json`，文件级结果取同目录JUnit的该文件汇总。`通过`不代表所属V项或R01—R31全部完成；`部分`保留已通过范围与尚未通过范围；后续直接受影响修改使旧结果失效的部分单列待验证。重叠运行不相加，原平台skip／时限不变。

**呈现纠正后的证据边界：** 原先将技术控制台式 UI 视为完成的结论已撤回；保留历史失败与旧截图，不用它们证明新呈现。当前深色四区布局已实际观察，最新浏览器有效结果覆盖当前阶段控制、原生输入和完整业务流程；显式本地写作另有真实原生写入／下载、零开发记录与 Git 不变的 smoke。未受影响的后端、普通 OMP 隔离、Git 和 Collab 结果继续复用。

| 状态／范围 | 实际证据 | 结果与边界 |
| --- | --- | --- |
| 通过：原生构建／绑定 | 主代理实际native build，Win32 x64／Bun 1.4.4 | 已生成host addon及bindings；不是npm／binary成品构建或其他平台证明。 |
| 通过：专属native VCS文件（V05） | `2026-11-07T07-17-04.834Z-21004-6fc32a51` | `packages/natives/test/dev-workbench-vcs.test.ts`文件汇总24 pass／0 fail／0 skip；该组合run本身exit 1、93 executed／4 fail，不能称整run通过。Git／cancel／controller使用下行后续结果，不重复累计。 |
| 通过：Git／cancel／controller（V02／V06／V07） | `2026-11-07T08-00-47.528Z-34312-09b88c8b`，exit 0 | 三文件共70 pass／0 fail。临时Git／bare remote及Forge故障fixture不等于真实在线Forge凭据验收。 |
| 通过：artifacts／orchestrator（V02／V03） | `2026-11-07T07-10-47.822Z-64820-4fa1a92d`，exit 0 | 两文件共92 pass／0 fail；不与其他含controller或artifacts的运行累计。 |
| 通过：独立process-resources（V03） | `2026-11-07T08-00-47.543Z-108904-f21db053`，exit 0 | `spec-driven/process-resources.e2e.test.ts` 12 pass／0 fail。 |
| 通过：Dev＋普通Collab／重连回归（V10及普通OMP） | `2026-11-07T07-17-04.834Z-110496-4dd354ed`，exit 0 | Dev Collab、普通Collab controller／read-only／relay-client-reconnect及mcp-reconnect共136 pass／0 fail；不代替完整网页流程。 |
| 通过：native runtime／历史（V04） | `2026-11-07T08-00-47.530Z-81884-51626ca0`，exit 0；受影响历史由下方 source process 结果补足 | runtime 当时46 pass／0 fail；session 存放修正后的普通 `--continue`、真实 Goal 与退出恢复以 `2026-11-07T10-08-10.237Z-82052-a907e37e` 为准，不将旧历史结果重复累计。 |
| 通过：普通ZCode projection＋选测gate（V12／V15的实际子集） | `2026-11-07T07-10-47.818Z-77300-ff822704`，exit 0 | `zcode-projection.test.ts`＋`scripts/ci-test-ts.test.ts`共68 pass／0 fail；不是fulltest执行结果。 |
| 通过：其余四个普通ZCode文件（V12及普通OMP） | `2026-11-07T06-52-07.854Z-81628-194b6f2c` | 文件汇总：commands 32 pass、sessions 14 pass、hosts-command-catalog 8 pass、process-execution 10 pass，各0 fail。该组合run exit 1／3 fail，失败仅在projection及选测gate，已由上一行后续运行修正；不宣称原组合run通过，不叠加其旧projection／gate结果。 |
| 通过：UI资源source消费者（V13） | `2026-11-07T07-41-23.300Z-108400-49f63cdd`，exit 0 | `dev-workbench/resources.test.ts` 2 pass／0 fail；不冒充npm／binary成品验收。 |
| 历史通过：server／client／Composer／Workbench定向消费者（V08／V09的实际子集） | `2026-11-07T08-51-33.753Z-104040-4bbed1ee`，exit 0 | 当时server、collab-web client、composer、dev-workbench四文件共55 pass／0 fail；未受影响服务证据保留，前端直接受影响合同待最小复验，既有组件结果不证明新呈现或实际浏览器E2E通过。 |
| 通过：当前两package类型检查 | 主代理实际 `check:types` | coding-agent 5540 files、collab-web 142 files均通过；不代表浏览器完整流程通过。 |
| 通过：当前资源生成与实际成品载荷 | 主代理生成及下方真实成品验收 | UI digest=`443e2c2626f845a66c6787bd8956a87cbe5876b7ca4ed66c741455c77a6f522e`；sourceDigest=`d8971ba7b3cf7dcf928f30108d43dbe48719bfb31a033e408f3d72742df40c27`。UI摘要不代表整个后端工作树身份。 |
| 历史通过：真实Chrome定向smoke（V14的实际子集）；新呈现待验收 | 主代理真实Chromium消费当时已服务UI；截图 `F:/Temp/User/omp-sshots-15c49aa22a5a3f72.webp`、`F:/Temp/User/omp-sshots-15c49fdd605a3f73.webp` | 当时bootstrap的browser／team-config／requirements均HTTP 200，light主题文字可读，`browser.errors`为空。首次真实导入后服务facts为 `modelCalls=0`、stage business；Next后requirements真实生成proposal＋delta，批准前页面可读，业务record仍仅business已批准、stage requirements。该材料可见性及后端事实证据保留，但light主题和旧截图不满足本次默认深色参考布局；原先UI完成结论失效，不代表新呈现已通过，旧Browser E2E 2 pass／8 fail也仍须如实保留。 |
| 通过：source process与原生Goal／普通会话隔离 | `2026-11-07T10-08-10.237Z-82052-a907e37e`，exit 0 | process文件5 pass／0 fail，覆盖独占进入退出、Goal真实暂停和普通continue；普通native-surface 3项复用此前修复后通过结果。 |
| 通过：本轮取消／归档／候选与门禁定向修复 | `2026-11-07T10-40-17.939Z-87688-75dcd2de`，exit 0 | 四文件109 pass／0 fail，含已确认发布推进PR head后的安全取消和显式归档路径优先；不累计旧运行。 |
| 通过：本轮宿主原生输入 | `2026-11-07T10-44-33.633Z-37568-3678fbce`，exit 0 | host文件14 pass／0 fail；controller／collab／actors复用同轮组合中已通过的范围，两个错误fixture断言已修。 |
| 历史部分：呈现纠正中的 browser E2E | `2026-11-07T10-46-01.663Z-21880-29a4837e`，exit 1 | 6 pass／4 fail。图片fixture、bare HTTP fixture、取消后材料读取和拒绝按钮定位均已修；最终有效结果见下方，不将这次失败run称为通过。 |
| 通过：当前深色参考布局定向观察 | 主代理真实Chrome；截图 `F:/Temp/User/omp-sshots-15c4aa8fb986c0a9.webp`、`F:/Temp/User/omp-sshots-15c4ab09ef06c0aa.webp` | 左需求、横向八阶段、中央只读材料、右共享会话与底部输入可见；无技术控制台面板，真实导入／Next／材料读取及输入框 `/queue list` 已行使。布局不再追求像素复刻；该观察不替代未结业务流程。 |
| 通过：npm／Windows binary 实际构建与启动 | `bundle-dist.ts`、`build-binary.ts`及显式 `verify-dev-workbench-package.ts --npm-entry packages/coding-agent/dist/cli.js --binary packages/coding-agent/dist/omp.exe --assets-manifest packages/coding-agent/src/dev-workbench/assets.generated.json`，均 exit 0 | 两实际产物均为 `omp/18.17.0`，已在真实Chrome验证内嵌网页及新建需求，UI digest/sourceDigest与上行一致，无checkout／CDN回退。npm SHA256=`6ea927f3fe605fafe3edc3f204053ca49127cc6ccd9f13d7d5c8ae1ee991e679`；binary SHA256=`685f6f4cb1d4e507a59b9a138ff236d290af167d5c0f0c52d3af52466e4d6a30`。 |
| 通过：最终十个真实 browser 场景（V14） | `2026-11-07T11-23-54.633Z-57316-3d356969`全文件8 pass／2 fail；修正这两处fixture后 `2026-11-07T11-28-58.364Z-103452-54002cce`仅复验失败场景，2 pass／8 filtered out／0 fail，exit 0 | 八个未受影响场景复用前次有效通过；最后两项覆盖完整PR合入／独立失败测试／关联修复／复测／只读与真实deny／单次批准。不是一次十项全绿运行，也未新增永久skip或放宽断言。 |
| 通过：取消读取生命周期（V02／V08） | `2026-11-07T11-06-50.389Z-52728-2a256e0c`，exit 0；server复用 `2026-11-07T11-04-30.865Z-110112-ff2bae75`文件级结果 | controller15 pass；server4 pass。取消／取消中不再重新解析已撤销归档，保留域状态；最终browser取消场景已通过。 |
| 通过：显式本地业务写作 smoke（R11） | 主代理真实Chrome→开始本地写作→真实business原生write→读取文档→下载Markdown | 下载1327字节实际Markdown，存在标题及模板章节；宿主事实 `records=[]`、`gitUnchanged=true`，浏览器errors为空。仅模型回复由localhost夹具提供，不改变生产代码；自有临时脚本及进程清理。 |
| 未运行：广泛门禁、其他平台与真实外部能力 | 实际边界 | 未运行fulltest／slowtest、真实模型／外部Forge凭据、真实桌面opener及其他平台验收；未commit／push／release，未OpenSpec sync／archive。localhost模型／Forge夹具不冒充外部服务验收。 |

**当前结果：** 本次明确需求及直接缺陷已完成，R01—R31以当前生产入口、迁移后的消费者及上述有效证据核对。此前失败均保留记录并由受影响范围的后续有效结果闭合；不新增测试矩阵、审查关卡、额外美化或相邻功能。

## R01—R31 Coverage Matrix

| ID | 已批准范围 | 实际任务 | 必须可观察的验收 |
| --- | --- | --- | --- |
| R01 | 一次性替换、无旧模式兼容 | T01、T11、T12、T14、T15 | 只新记录／新流程，旧入口拒绝，无双轨／迁移／删用户历史 |
| R02 | 删除Dev阶段TUI、保留普通TUI | T08、T11、T12、T14 | `/dev`独占期间普通输入／命令被阻止；再次 `/dev`结清退出，恢复原普通会话／草稿／模型／菜单 |
| R03 | 复用五Agent／技能／工具／会话／Team／Goal | T02、T04、T08、T09、T14 | 真实原生工具流／问答／权限／模型／后代／Team／Goal消费者完整 |
| R04 | 完全脱钩ZCode、只清旧专属接线／条款 | T12、T14、T15 | 无Dev bridge/schema/capability/projection/routes，新工作台无ZCode适配；普通ZCode通过 |
| R05 | 双入口与完整地址 | T08、T11、T13、T14 | `/dev`／`omp dev`真实ready URL；TUI再次 `/dev`退出，关页不退出；opener失败仍可复制 |
| R06 | 参考四区／默认深色／当前阶段简洁控制 | T09、T14 | 实际左列表、中央材料上方八阶段、中央只读材料、右共享会话及底部输入；非像素复制，无JSON／命令下拉／调试控制台；已实际Chrome观察，见当前深色布局证据 |
| R07 | 查看不推进、会话改文档、上传下载 | T03、T08、T09、T14 | 视图导航零副作用，中央只读，实际Markdown往返与会话修改 |
| R08 | 业务检查必经八阶段 | T01、T02、T14 | 所有新开发需求business起步，无直接requirements产品入口 |
| R09 | 仅Markdown上传／OMP本地路径 | T03、T08、T09、T14 | 两种来源区别清楚，URL／Word／PDF拒绝，外部源不变 |
| R10 | 已有文档无对话Next模板检查 | T02、T03、T04、T14 | 合格零业务Actor／模型进入requirements，缺标题／十章明确拒绝 |
| R11 | 纯业务本地写作显式选择、不提交、开发另建导入 | T02、T04、T09、T15 | 初始空状态引导新建，不默认本地写作；明确选择才进入，无Git开发record／PR／交付终态，另建需求不依赖原会话 |
| R12 | 前五阶段确认和方案选择 | T02、T03、T04、T09 | 原文件／原始批准／hash，完整候选，多选明确／单选默认，计划不自动Git |
| R13 | Back相邻退回、失效确认不回滚 | T02、T03、T14 | 有效上游保留、目标下游失效，文件代码不变，不自动模型／Team／Goal |
| R14 | 第五步只交ST | T02、T04、T14 | 第五Next无archive／最终交付，第六继续同一报告 |
| R15 | 开发主导ST人工完成、不强制全通过 | T02、T04、T09、T14 | 失败／未运行真实记录，人标记才推进，无全通过／AI门禁 |
| R16 | 第七步会话PR及提交前同步归档 | T03、T06、T09、T14 | 人确认native同步／校验／archive，真实PR操作；归档后可修正合法重同步 |
| R17 | 已提交＝已开发、合入后独立测试 | T01、T02、T06、T14 | submitted仍占位，真实merged＋人标记进入testing，不自动tested |
| R18 | 第八人标记已测试只读、新改动另建 | T02、T04、T06、T09 | 最终record纳入同次提交，完成后拒写；新需求关联而非复活 |
| R19 | 标记同次commit/push与部分失败幂等 | T01、T02、T05、T06、T09 | 保存／提交／推送分别准确，commit成功push失败重试仅补push，重复不推进 |
| R20 | 独立Git记录、SHA／PR／修复关联 | T01、T02、T06、T07 | pull可读事实，真实SHA／operation解析，无聊天／token／正文副本或SHA补交循环 |
| R21 | 提交编号关联、push不夹带未授权commit | T05、T06、T14 | message关联ID＋实际对象归属，展示祖先集合，A状态不暗推B提交 |
| R22 | 单目录既有单分支串行、无worktree | T01、T05—T08 | realpath／branch和跨进程准入；无createBranch／worktree调用 |
| R23 | 合入或取消撤销完才释放 | T01、T02、T06、T07 | PR评审／取消cleanup／冲突继续占位，只有真实合入标记或完整取消释放 |
| R24 | 合入后测试可并存、只写自身记录 | T01、T02、T04、T06、T14 | A测试与B开发共存，A所有工具／后代不能写其他文件，commit/index隔离 |
| R25 | 合入前原需求修正、合入后关联修复复测 | T02、T03、T04、T06、T09 | 归档不封死修复，merge后另建，修复merge不自动改变原测试结论 |
| R26 | 未合入撤销全部所属改动、保留无关内容历史 | T01、T05—T07、T14 | 多commit／暂存／未暂存／archive／主规格补偿，冲突不覆盖，历史／取消事实保留 |
| R27 | 右侧网页offline Collab同会话、输入复用命令／技能、不跨阶段跟随 | T08—T10、T14 | 两纯浏览器同原生会话、普通HTTP/WS、底部Composer用既有内置命令／技能和native执行；换代不自动join，不另建聊天／配置／权限系统 |
| R28 | 无角色权限系统、offline全工作台权限不绕deny | T02、T04、T08—T10 | 每offline参与者可操作，但deny／restrictedFolders／审批／非offline边界不变 |
| R29 | 关页刷新断线不停止、重连不重放 | T04、T08—T11、T14 | 长任务一次执行，连接退订不abort；重连snapshot无prompt／tool／确认重放 |
| R30 | 内嵌资源随现有发行、无前端devserver | T08、T11、T13、T14 | source真实消费者；另行授权的npm／binary独立成品程序验证本次载荷，无checkout／CDN；默认fork不隐式要求成品 |
| R31 | 同步规则／文档验收、替换旧专属测试保留覆盖 | T12—T15 | 新source／TSX精确选测，成品程序不进default／`--full`，有效失败／权限／取消／Team／Goal／普通TUI覆盖保留，无预算／skip放宽 |

## Plan Completion Criteria

- [ ] T01—T15全部实现，31项均有实际生产路径与对应消费者，不以内部波次、静态原型、类型声明或mock结果替代交付。
- [ ] 所有旧Dev专属入口／类型／callsite／tests／文档合同完成cutover；普通TUI与普通ZCode保留，没有新增ZCode接入、worktree或旧兼容。
- [ ] 已授权验证的真实证据按source／npm／binary、平台、原生／浏览器、mock模型／真实外部能力分别报告；未运行不称通过。
- [ ] 未授权commit／push／发布不执行；实施与验证状态据实际证据更新。
