# security_scan

> 规划并运行 OMP 原生安全审查、验证已存储的发现，并显式与 Codex Security 云扫描交互。

## 可用性与先决条件

- `security.enabled` 默认为 `false`。禁用时,`security_scan` 会从可用工具集中省略,且 `security://` 读取会因未启用而失败。在 **Settings → Tools → Security** 中启用,或将 `security.enabled` 设为 `true`。
- 该工具可发现,采用严格 schema,分类为 `exec`。
- 原生 `preflight` 需要一个 Git 仓库、一个活动的模型、会话模型与认证注册表,以及活动模型提供商的已存储 OAuth 凭据。不接受仅 API 密钥的认证。
- 如果存在多个 OAuth 账号且没有活动账号,需传入 `credential_id`;若仅有一个账号则会自动选择。不可变计划会固定凭据行以及所记录的账号/工作区身份。执行与令牌刷新都停留在该行上,而不会轮换到其他账号。
- 云操作需要一个 `openai-codex` ChatGPT OAuth 凭据。它们调用 ChatGPT 的 Codex Security 云控制平面,而非公共 OpenAI API,绝不是原生扫描的兜底方案。

## 源码

- Public tool and schema: `packages/coding-agent/src/tools/security-scan.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/security-scan.md`
- Native planning and freshness: `packages/coding-agent/src/security/preflight.ts`
- Background execution: `packages/coding-agent/src/security/coordinator.ts`
- Scan-only publication tool: `packages/coding-agent/src/security/publication.ts`
- Canonical store and output files: `packages/coding-agent/src/security/store.ts`
- Cloud client/import: `packages/coding-agent/src/security/cloud.ts`
- Read-only resources: `packages/coding-agent/src/internal-urls/security-protocol.ts`

## 输入

| Field | Type | Used by | Description |
| --- | --- | --- | --- |
| `action` | `"preflight" \| "start" \| "status" \| "cancel" \| "validate" \| "cloud_scans" \| "cloud_start" \| "cloud_status" \| "cloud_pull"` | All | 必需的调度选择器。 |
| `plan_id` | `string` | `start` | 由 `preflight` 返回的计划 ID。 |
| `operation_id` | `string` | `status`, `cancel` | 由 `start` 返回的操作 ID。 |
| `target_kind` | `"repository" \| "scoped_path" \| "ref_diff" \| "working_tree"` | `preflight` | 默认为 `repository`。 |
| `include_paths` | `string[]` | `preflight` | 包含在不可变范围内的仓库相对路径。对于 `scoped_path`,至少需要一个非空值。 |
| `exclude_paths` | `string[]` | `preflight` | 从范围中移除的仓库相对路径。排除优先于包含。 |
| `base_revision` | `string` | `preflight` with `ref_diff` | 与 `head_revision` 一起必填;在 preflight 期间解析为一次提交。 |
| `head_revision` | `string` | `preflight` with `ref_diff` | 与 `base_revision` 一起必填;在 preflight 期间解析为一次提交。 |
| `knowledge_base_paths` | `string[]` | `preflight` | 相对于仓库根目录解析、规范化并通过 SHA-256 和大小固定的文件。 |
| `output_root` | `string` | `preflight` | 可选的外部结果目录。必须位于仓库外、规范化、非符号链接,除非 `archive_existing=true`,否则必须为空。 |
| `archive_existing` | `boolean` | `preflight` | 默认为 `false`。允许在执行开始时将非空输出目录重命名为 `<output_root>.archive-<scan-id>`。 |
| `credential_id` | positive integer | Native `preflight`; every cloud action | 固定一个 OAuth 凭据。原生扫描为活动模型提供商选择它;云操作为 `openai-codex` 选择它。 |
| `scan_id` | `string` | `validate` | 包含该发现的已存储扫描。 |
| `finding_id` | `string` | `validate` | 要更新的已存储发现。 |
| `validation_status` | `"unvalidated" \| "validated" \| "rejected" \| "partial" \| "error"` | `validate` | 新的验证状态。 |
| `validation_summary` | `string` | `validate` | 必需且非空的验证说明。 |
| `validation_evidence` | `{label: string, explanation: string}[]` | `validate` | 作为验证证据追加的可选证据;标签必须非空。 |
| `cloud_configuration_id` | `string` | `cloud_status`, `cloud_pull` | Codex Security 云配置 ID。 |
| `repository_id` | `string` | `cloud_start` | 必需的云仓库标识符。 |
| `repository_url` | `string` | `cloud_start` | 必需的云仓库 URL。 |
| `environment_id` | `string` | `cloud_start` | 必需的云环境标识符。 |
| `lookback_days` | positive integer or `"all"` | `cloud_start` | 默认为 `30`;`"all"` 表示发送无限回溯范围。 |

未使用且可选的字段会被不读取它们的操作忽略。

## 输出与执行模型

每个操作都会返回一个文本内容块以及包含 `action` 和下文所述特定操作对象的结构化 `details`。该工具自身不流式传输部分参数或进度更新。`start` 立即返回一个已排队的操作;其单独注册的 OMP 任务报告进度,调用方使用 `status` 获取持久的操作状态。

## 操作参考

### `preflight`

`preflight` 解析并持久化一个不可变的计划,然后返回:

```text
Security plan <plan-id> is ready. Fingerprint: <fingerprint>. Start it with action=start and plan_id=<plan-id>.
```

`details` 为 `{ action: "preflight", plan: { id, fingerprint } }`。

该计划固定了:

- 规范的仓库根目录以及规范化的包含/排除范围;
- 目标快照;
- 已解析的 ref-diff 修订及其差异摘要(如适用);
- 活动提供商/模型以及可选的思考级别;
- 精确的 OAuth 凭据以及所记录的账号/工作区身份;
- 知识库文件标识;
- 输出策略;
- 安全设置快照以及协调器提示/工作流的指纹。

对于 `repository`、`scoped_path` 和 `working_tree`,目标摘要涵盖范围内受跟踪和未受跟踪的文件路径与内容、可执行位、符号链接目标,以及当前 HEAD(或 `unborn`)。`ref_diff` 则会对已解析的 base/head 提交及其原始树差异计算指纹。范围路径必须相对仓库,必须存在且解析到仓库内部,并经过规范化、去重和排序。

如果省略 `output_root`,preflight 会在项目的 OMP 安全状态下分配一个私有的唯一目录。调用方提供的输出目录若不存在,则会在 preflight 期间创建;其父目录必须已具有规范身份。非空目录需要 `archive_existing=true`。

### `start`

`start` 加载已存储的计划,并根据当前目标、安全设置、知识库、输出策略和工作流重新计算其指纹。若不匹配则失败,返回:

```text
Security scan plan is stale: expected <old>, got <new>. Run security preflight again.
```

成功后,它在注册后台工作后立即返回:

```text
Security scan <scan-id> started as <operation-id>.
```

`details.operation` 包含 `operationId`、`planId`、`scanId`、`phase`、时间戳、`findingCount`,以及在可用时的 `jobId`、`sessionFile` 或 `error`。

操作阶段为:

```text
queued → preparing → reviewing → publishing → completed
```

终态的替代值为 `partial`、`cancelled` 和 `failed`。协调器会创建一个受限、自动批准的扫描会话,其中包含只读的仓库检查工具、只读的 LSP,以及仅 `security-reviewer` 任务工作线程。扩展发现、MCP 和 IRC 被禁用。模型兜底和账号轮换被禁用。

对于 `ref_diff`,执行会在固定的 head 修订处创建一个分离的临时工作树,并将固定的差异提供给审查会话;清理阶段会移除该工作树。其他目标类型则直接审查仓库根目录。

### `status`

需要 `operation_id`。它返回:

```text
Security scan <scan-id>: <phase>; <count> finding(s).
```

完整的操作快照位于 `details.operation`。终态操作可从项目存储中跨会话恢复。进程重启会将已持久化的 `running` 或 `planned` 扫描标记为 `failed`,并附带 `Security scan was interrupted by a process restart`,同时清理 ref-diff 目标工作树。未知的 ID 会抛出 `Unknown security operation: <id>`。

### `cancel`

需要 `operation_id`。正在运行的异步任务会通过任务管理器取消;否则协调器会中止其本地控制器和扫描会话。结果为以下之一:

```text
Cancellation requested for <operation-id>.
No running operation <operation-id>.
```

`details.cancelled` 报告请求是否被接受,当操作存在时会包含 `details.operation`。已处于终态的操作和未知操作返回 `false`。

### `validate`

需要 `scan_id`、`finding_id`、`validation_status`,以及非空的 `validation_summary`。它会更新规范存储的发现,并可选择追加生成的验证证据记录:

```text
Finding <finding-id> validation is now <status>.
```

`details.finding` 包含发现 ID 和验证状态。缺失的扫描/发现或必填字段会失败,而不会创建新发现。

### `cloud_scans`

列出所选 ChatGPT 账号可见的每个分页配置。每一行包含配置 ID、当前步骤、仓库 ID、环境 ID 和仓库 URL。如果不存在,工具会明确说明。结构化的配置在 `details.cloudConfigurations` 中返回。

### `cloud_start`

需要 `repository_id`、`repository_url` 和 `environment_id`。它会创建一个已启用的 Codex Security 云扫描配置,并消耗该账号独立的云扫描配额。`lookback_days` 默认为 `30`。

文本中会标识该配置和仓库。`details.cloudScan` 包含 `{ id, repositoryUrl }`。

### `cloud_status`

需要 `cloud_configuration_id`。它报告当前步骤以及已完成/待处理的提交计数。`details.cloudStats` 还包含失败提交数、按严重性统计的发现数,以及服务所暴露的最后扫描提交/时间戳。

### `cloud_pull`

需要 `cloud_configuration_id`。它会获取配置、状态以及所有归因的发现详情,将其转换为 OMP 的规范 schema,生成报告和 SARIF,并持久化一个已完成的导入扫描。

除非当前项目具有 `origin` 远程、且其规范化的仓库身份与云配置 URL 匹配,否则导入采用失败关闭策略。云覆盖范围被记录为 `unknown`,因为发现 API 未暴露覆盖回执。`details.importedScan` 包含新的扫描 ID 和发现数量。

## 原生发布与持久化

`security_publish` 是一个内部的、严格的、写入级工具,仅在受限的原生扫描会话内可用;它不是常规的调用方操作。协调器要求扫描代理使用以下内容调用一次:

- 去重后的发现,包含规则、标题、摘要、严重性、置信度、类别、至少一个范围内的位置、可选的证据/修复/CWE,以及验证状态;
- 诚实的覆盖完整性、已审查的表面、排除项、已推迟工作和未决问题;
- 最终的 Markdown 报告。

发布会拒绝绝对路径、父目录穿越或超出范围的发现与证据路径。具有相同规范指纹的重复发现会被去重。第二次成功发布的调用会失败。如果扫描会话在没有发布的情况下结束,则该扫描会被持久化为 `partial`;即使后续的指标/输出刷新失败,成功发布仍保持为 `completed`。

规范状态为私有并以项目为键,位于 OMP 安全状态根目录下。已完成的原生输出目录包含:

- `scan.json` — 公共扫描清单,作为提交标记最后写入;
- `findings.json`;
- `report.md`;
- `results.sarif`;
- `provenance.json` — 私有元数据(已脱敏)。

在非 Windows 平台上,目录的权限被加固为模式 `0700`,文件为 `0600`。

## 读取结果

`security://` 命名空间是不可变的,作用域为项目:

| URL | Result |
| --- | --- |
| `security://` | 命名空间索引。 |
| `security://scans` | 已存储的扫描列表。 |
| `security://scans/<scan-id>` | 扫描摘要与子资源索引。 |
| `security://scans/<scan-id>/manifest` | 公共清单 JSON,包括计划。 |
| `security://scans/<scan-id>/findings` | 发现列表。 |
| `security://scans/<scan-id>/findings/<finding-id>` | 渲染的发现、位置、证据和修复建议。 |
| `security://scans/<scan-id>/coverage` | 覆盖范围 JSON。 |
| `security://scans/<scan-id>/report` | Markdown 报告(若存在)。 |
| `security://scans/<scan-id>/sarif` | SARIF JSON(若存在)。 |
| `security://scans/<scan-id>/provenance` | 已脱敏的来源信息 JSON。 |

对状态的变更应使用 `security_scan` 操作或显式的安全命令;URI 读取永远不会验证、导入、取消或以其他方式修改状态。

## 示例

规划并启动一次仓库扫描:

```json
{"action":"preflight","target_kind":"repository","exclude_paths":["vendor","dist"]}
```

```json
{"action":"start","plan_id":"secplan_<id>"}
```

使用外部输出目录规划一次精确的修订差异:

```json
{
  "action": "preflight",
  "target_kind": "ref_diff",
  "base_revision": "origin/main",
  "head_revision": "HEAD",
  "output_root": "/tmp/omp-security-review"
}
```

验证一个发现:

```json
{
  "action": "validate",
  "scan_id": "secscan_<id>",
  "finding_id": "secfinding_<id>",
  "validation_status": "validated",
  "validation_summary": "Reproduced with an untrusted archive entry.",
  "validation_evidence": [
    {"label":"Reproduction","explanation":"The entry writes outside the extraction root."}
  ]
}
```

显式启动并稍后导入一次云扫描:

```json
{
  "action": "cloud_start",
  "repository_id": "repo_<id>",
  "repository_url": "https://github.com/owner/repo",
  "environment_id": "env_<id>",
  "lookback_days": 30,
  "credential_id": 7
}
```

```json
{"action":"cloud_pull","cloud_configuration_id":"scan_<id>","credential_id":7}
```

## 错误与约束

- 每个操作都会首先重新检查 `security.enabled`;在禁用状态下直接执行会抛出 `Security is disabled. Enable security.enabled before using security_scan.`。
- 必需的字符串会被去除首尾空白并拒绝为空值。ArkType 会拒绝无效的枚举值、非正的 credential/lookback ID,以及格式错误的验证证据。
- 原生扫描会拒绝缺失的 Git 上下文、未知的引用、逃逸或不存在的范围路径、无效的知识库文件、不安全的输出目录、未知/过期的计划、不可用的固定模型、OAuth 身份变更,以及不可用的固定凭据。
- 云请求在 HTTP 401 时会强制刷新并重试一次,然后失败。其他非成功响应会报告状态码和端点。
- `cloud_pull` 在导入前会验证仓库身份和配置归属。
- 取消是协作式的。操作只有在后台运行处理中止并持久化其终态包后,才会进入终态 `cancelled`。
