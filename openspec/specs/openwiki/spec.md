# openwiki Specification

## Purpose

OpenWiki 随 OMP 一体发行，复用 OMP 模型和认证生成、更新仓库 Wiki，通过内置工具按需只读检索，并兼容已有 Wiki 数据。

## Requirements

### Requirement: 仓库 Wiki 命令与功能边界

`omp openwiki` MUST be repo-only. Query via OMP's built-in tools; no personal mode/KB, external connectors, MCP or other Agent integration.

#### Scenario: 显式生成和更新
- **WHEN** `omp openwiki [code] --init` or `omp openwiki [code] --update`
- **THEN** generate/update with OMP models. `--language`: explicit > `zh-CN`. Missing `openwiki/INSTRUCTIONS.md`: create empty; else preserve.

#### Scenario: 只读预览生成和更新
- **WHEN** `--dry-run`
- **THEN** init/update only: repo, per-phase default role/explicit selector, snapshot candidates, comparable changed paths, existing page scope. Mark runtime discovery/auth selectors unverified; model plans final pages, candidates not exhaustive reads. No model calls, Wiki/state/instruction/telemetry writes or side effects.

|Input|Contract|
|---|---|
|No operation / unsupported (incl. `search`, `read`)|Repo help / error respectively; no legacy chat/implicit generation.|
|`link [directory]`; `workspace use <workspace>`, `workspace current`, `workspace clear`; `visualize [path] [--port <port>] [--no-open] [--export <dir>]`|Expose native commands within OMP.|
|Telemetry|No public OpenWiki telemetry; explicit `--telemetry-file` local only: `disabled: true`, `sent: false`. OMP telemetry unchanged. Generation follows OMP offline/log rules.|

### Requirement: OpenWiki 源码归属与合并发行

MUST embed the `vendor/openwiki` gitlink (`https://github.com/jchanghong023/openwiki.git`), not a substitute. OMP owns wiring/build/references, not a second knowledge core, storage implementation, model policy or installer.

#### Scenario: 正式发行与本地构建
- **WHEN** building Windows x64/Linux glibc x64 OMP
- **THEN** release: explicitly init obtainable parent gitlink, no floating branch/package; missing code/deps/assets fails. Local: dirty submodule allowed, no forced reset/release claim.

OMP install/update bundles OpenWiki code, runtime dependencies (incl. SQLite/FTS5), agent Skill/prompts (incl. repo Mermaid guidance), browser assets and third-party licenses. Follow [release rules](../fork-runtime/spec.md#requirement-发布-ci-的触发并发与权限), [acceptance](../fork-maintenance/spec.md#requirement-按风险选择验证和报告证据); no new platform, separate package, npm/Nix release or auto-release grant. Clean install: in-process, no standalone package/home, dev checkout, `node_modules`, extra Node/Bun, CLI/Agent/MCP/gateway processes or runtime downloads. Git/browser helpers allowed; generation needs reachable model.

### Requirement: 使用 OMP 模型与认证

Both phases MUST use OMP auth/endpoints/provider limits/request policy and model-tool-model calls; no OpenWiki provider/list/credentials/login/gateway. Model/effort run-local.

|Phase|Precedence|
|---|---|
|Page|`--modelId`/`--model-id` (shared explicit) > current profile `default`|
|Planner|`--planner-model` > shared explicit > `plan` > `default` only if `plan` unset; no auto `task`|

#### Scenario: 单独指定规划模型
- **WHEN** `--planner-model` on init/update
- **THEN** override planner model/effort only. Equal selectors share instance; else reuse factory. Pages share instance. `--debug`: both actual IDs. Persist shared/page model; no checkpoint format change.

OMP-normalized selector effort; honor `off`; no forced unspecified effort/provider session `auto`. Internal/supported auth-free models: OMP config, not generic creds alone. `OMP_OFFLINE`: configured reachable internal model only; no online discovery/auth wizard/connector. Read/browse credential-free. Resolution/auth/tool support/call failure/cancel: report, release resources, no fallback/switch.

### Requirement: 复用原生生成编排与恢复

Embedded generation MUST use OpenWiki's durable lifecycle, not OMP Task. Page/run success depends on respective persisted state, not Agent claim/exit.

#### Scenario: 原有页面并行行为
- **WHEN** concurrent page commits
- **THEN** write owned pages only; preserve other in-flight pages/verification. No new cross-process lock; per-run dedup only.

`--help` and no-arg help: `OPENWIKI_PAGE_CONCURRENCY` default `1`, range `1–8`, setup/run examples: csh/tcsh session `setenv`; PowerShell user-persistent `[Environment]::SetEnvironmentVariable`, then new terminal.

|State|OMP contract|
|---|---|
|Incremental|Git clean cannot mask incomplete/invalid evidence. Track only root `AGENTS.md`, `openwiki/INSTRUCTIONS.md`. With baseline: effective content changes only. Without: nonempty `INSTRUCTIONS.md` or changed unignored Git-visible `AGENTS.md`; prior nonempty→empty undetectable. No whole-repo per-file baseline.|
|Interrupted/partial/finalization failure|Native same-checkout resume. Distinguish partial failure/interruption. Failed/skipped page: nonzero; uncovered incomplete, no partial global success baseline advance. No new state machine/required specific checkpoint.|

Finalization: DOM-free Mermaid structure checks only (flowchart node labels/reserved words, sequence/compound state blocks). Definite error: preserve body as plaintext, log reason. Unhandled syntax/types intact. No generator parser/jsdom.

### Requirement: OMP 内置只读查询工具

MUST embed `openwiki_search`, `openwiki_read`, `openwiki_list_workspaces`, `openwiki_list_wikis`: in-process read-only, no MCP/models/Wiki, Claims or registry writes. No chat generation tools/restricted allowlist expansion.

#### Scenario: 按设置启用或关闭内置查询
- **WHEN** `openwiki.tools.enabled` changes
- **THEN** sync session tools/prompts per allowlist and mount below; CLI unchanged:

|Permission|Mount|
|---|---|
|Unset/`false` (normal/offline default)|None; explicit lists cannot bypass. Disable removes all four.|
|`true`, unrestricted, `tools.commands` on + built-in Bash|Discoverable Bash commands, dispatch not file write.|
|`true`, unrestricted, `tools.commands` off or built-in Bash absent|Top-level tools.|

|Query state|Contract|
|---|---|
|Search/read|Tool docs: nonempty query, integer limit, relative hints with count cap (rank only). Split each `results[].ref` at `#` → anchor-free `page` + nonempty `sections`. Combine only same Wiki/page; keep `wiki` only if returned. Include complete result-to-read JSON example; preserve API and normalization.|
|Bad input/ref or no Wiki|Native error class; no substitute read. Bad field: location/constraints, not raw validator JSON alone. Missing page: echo path, suggest re-search. Mixed page/anchor: `page`/`sections` split. Unknown section: page/bad anchor, ≤20 available anchors, flag truncation.|
|Chinese/natural language/mixed IDs|Adjacent Han terms, not scattered chars; partial multi-term matches. Equal hint rank: contiguous original Chinese > punctuation-separated. English/single chars; original snippets/full Markdown sections.|
|List|Repo-context workspaces or reachable specified workspace members; profile IDs/selection.|

### Requirement: 按需检索仓库 Wiki

MUST query only on request/evidence need. Unrelated tasks: no auto list/read/preload repo/linked Wiki, generation or visualization.

#### Scenario: 概览调研优先使用已有 Wiki
- **WHEN** architecture/feature overview/cross-module task, Wiki not excluded/known absent, search available, not source-first
- **THEN** before answer/exploration/delegation reuse session sections, else `openwiki_search`; no workspace list first. For full sections use refs via available `openwiki_read`; no guessed pages/quickstart as tool. Enough evidence: no duplicate Wiki delegation.

Named file/symbol/error, edit/current behavior or major Wiki claim: source first (no forced query); source wins, verify claims. Search unavailable, Wiki excluded/absent, `invalid_state`, empty/stale/conflicting result: use source; no block/implicit generation. Default prompt uses actual mount; no required unavailable tools.

### Requirement: 保留跨仓库工作区链接

OMP MUST retain cross-repo search/read via local named workspaces and their membership/active selection, without personal sources or a cross-repo graph promise.

#### Scenario: 管理并使用仓库工作区
- **WHEN** `omp openwiki link` with active workspace selected
- **THEN** resolve linked repos via active workspace; unresolved ambiguity: `workspace_required`, no unrelated choice. Moved/missing/inaccessible Wiki: identifiable error, no substitute.

Isolate registry/cache/user state by effective `OMP_CONFIG_ROOT`/profile per [OMP rules](../fork-runtime/spec.md#requirement-安装与运行), default fallback; offline same root. No parallel standalone home/`OPENWIKI_CONFIG_DIR` or standalone rule change. No required legacy read/migration/takeover, legacy registry edit/delete/empty overwrite on read error, or KB/connector/credential imports. Switches leave repo data/formats intact.

### Requirement: 保留已有仓库 Wiki 数据格式

MUST preserve repo `openwiki/`, Claims, page manifest, checkpoint formats/identity. Unreadable: error, no silent clear/empty overwrite/rebuild.

#### Scenario: 接续已有 Wiki 和 Claims
- **WHEN** update/resume/query existing Wiki
- **THEN** reuse pages/Claims/progress. Init may replace output; retain instructions per [init](#scenario-显式生成和更新).

### Requirement: 原有可视化与静态导出

MUST retain visualization/export: default loopback, static HTTP, no `file://` promise.

#### Scenario: 实时浏览与关闭
- **WHEN** `omp openwiki visualize`, then stop service or exit owning command
- **THEN** 显示实页，Wiki 变化可触发刷新；如实报启动/刷新故障。退出释放监听、刷新和监视资源，不中断其他宿主任务。

`--export <dir>`: HTTP subpath/relative assets, no Agent/MCP/generator. Live/export use bundled assets offline, no CDN/external fonts/downloads/dev-cache substitute. OpenWiki source, asset generator, actual relevant deps, license or browser asset content change: reject stale assets, require regen. OMP version/unrelated locks/checkout path alone: valid.

### Requirement: 默认接入不安装外部 OpenWiki 链路

Entry MUST NOT implicitly add standalone install/run or dependent auto-update workflows, pull connectors, create/edit `CLAUDE.md`. Don't delete/overwrite/run user workflows or require workflows/instructions for built-in install/auth/run. Built-in exclusions/init/telemetry MUST NOT disable/remove standalone CLI/MCP/personal/other entries.

#### Scenario: 显式生成维护指令区块
- **WHEN** explicit init/update, not [preview](#scenario-只读预览生成和更新)
- **THEN** write `openwiki/`; create/refresh marked root `AGENTS.md` OpenWiki block (Wiki location/read-only query). Keep outside text; malformed/duplicate markers error without edits.
