# AI 工具 schema 规范化

`@oh-my-pi/pi-ai` 暴露了一个统一的 schema 规范化器，供各 provider 在工具发送上线路之前消费。
所有 walker 都位于 `packages/ai/src/utils/schema/normalize.ts`；运行契约则是
`packages/ai/src/utils/schema/CONSTRAINTS.md`。

现在已不再有独立的 `strict-mode.ts` 模块——OpenAI 严格模式清洗、OpenAI Responses
`oneOf` 重写、Google/Vertex/Gemini-CLI 清洗、Cloud Code Assist Claude 清洗以及
MCP 清洗都共享同一个由选项驱动的遍历流程。

## 入口点

所有导出都位于 `@oh-my-pi/pi-ai/utils/schema` 之下：

- `normalizeSchema(value, options)` — 通用的、由选项驱动的 walker。
- `normalizeSchemaForGoogle(value)` — Gemini / Vertex / Gemini CLI。
- `normalizeSchemaForCCA(value)` — Cloud Code Assist Claude（Antigravity + GCA）。
- `normalizeSchemaForMCP(value)` — 在 MCP `inputSchema` 进入自定义工具注册表之前
  对其进行处理。`tool-bridge.ts` 会把每个 MCP 的 `inputSchema` 都送过这个调度器。
- `sanitizeSchemaForOpenAIResponses(schema)`（别名
  `normalizeSchemaForOpenAIResponses`）— 递归地把 `oneOf` 重写为 `anyOf`，
  为对象 schema 补上空的 `properties`，并移除 Responses API 拒绝的
  正则前后瞻断言。
- `sanitizeSchemaForStrictMode(schema)` 以及
  `enforceStrictSchema(schema)` / `tryEnforceStrictSchema(schema)` — OpenAI
  严格模式流水线（清洗 → 强制）。三者都从 `normalize.ts` 导出。
- 来自 `./adapt` 的 `adaptSchemaForStrict(schema, strict)` — 轻量组合器，
  把 draft-07 输入升级到 2020-12，并为 provider 调用点包装
  `tryEnforceStrictSchema`。`./adapt` 还导出 `NO_STRICT` 全局绕过标志
  （环境变量 `PI_NO_STRICT`），每个发出 `strict: true` 的 provider 都会遵守它。
- `normalizeSchemaForMoonshot(value)` — Moonshot/Kimi 的 MFJS 子集。
- `sanitizeSchemaForOllama(schema)` — 为 Ollama 的 Go schema 解析器重写
  布尔子 schema、类型数组以及布尔型的对象开放性关键字。
- `sanitizeSchemaForGrammar(schema)` — 为带语法约束的 OpenAI 兼容后端放宽
  布尔子 schema，同时保留布尔型的 `additionalProperties` /
  `unevaluatedProperties`。

统一流重构中已移除：

- `strict-mode.ts`（已合并进 `normalize.ts`）。
- `sanitize-google.ts` 与 `normalize-cca.ts`（已被 `normalizeSchemaFor*`
  调度器取代）。
- `StringEnum` 辅助函数 — 请改用 `type.enumerated(...)`；omptype 会输出
  与 provider 兼容的 JSON Schema。
- `sanitizeSchemaFor{Google,CCA,MCP}` / `prepareSchemaForCCA` — 已重命名为
  `normalizeSchemaFor{Google,CCA,MCP}`。

## 调度器映射

| Provider 传输方式 | 调度器 |
| --- | --- |
| `openai-completions` | `adaptSchemaForStrict`（启用严格模式时清洗 + 强制） |
| `openai-responses`、`openai-codex-responses` | 在严格模式适配之前先经过 `sanitizeSchemaForOpenAIResponses` |
| `azure-openai-responses` | `sanitizeSchemaForOpenAIResponses`；不做适配，直接发出 `strict: false` |
| 使用 MFJS 的 Moonshot/Kimi 原生主机（`toolSchemaFlavor: "moonshot-mfjs"`） | `normalizeSchemaForMoonshot` |
| 语法风格的 OpenAI 兼容主机（`toolSchemaFlavor: "grammar"`） | `sanitizeSchemaForGrammar` |
| `ollama` / `ollama-cloud` 工具参数 | `toolWireSchema` → `sanitizeSchemaForOllama` |
| `google-generative-ai`、`google-vertex`、Gemini CLI | `normalizeSchemaForGoogle` |
| Cloud Code Assist Claude（Antigravity + GCA，`claude-*` 模型 id） | `normalizeSchemaForCCA` |
| MCP `inputSchema` 接入 | `normalizeSchemaForMCP` |
| `anthropic-messages`（原生，非 CCA） | `anthropic.ts` 中针对各 provider 的白名单 |

Gemini CLI / Antigravity CCA 必须运行完整的 `normalizeSchemaForCCA` 流水线
（而不只是第一个关键字剥离步骤），以与共享的 Google Claude 路径保持一致。

## 遍历语义

`normalizeSchema` 把输入升级到 JSON Schema 2020-12，对树做解引用，
然后用由调度器固定的选项集遍历它。对每个节点：

1. 把 `snake_case` 的组合子/属性键重命名为 camelCase（`any_of` → `anyOf`
   等；键冲突时遵循 python-genai 的 `pop(from)`/`set(to)` 语义——
   snake_case 获胜）。
2. 在递归进入子节点之前，先对可空联合应用 `handle_null_fields` 折叠。
3. 剥离目标 provider 不支持的键，并可选地把具有人类可读含义的键
   （`pattern`、`format`、min/max、`default`、`examples` 等）经由溢出
   格式化器（`spill.ts`）并入同级的 `description`。结构/元键
   （`$ref`、`$defs`、`additionalProperties`）不会被溢出。
4. 规范化类型联合（`type: ["T", "null"]` → 在 Google 上变为 `type: "T"`
   加可空标记，在 CCA 上为普通 `type: "T"`）。
5. 折叠仅对象 / 同类型的组合子，可选地对混合类型的组合子做有损折叠
   （仅 CCA），并运行残余组合子不动点。
6. 当设置了 `validateAndFallback` 时（CCA 路径），用内部结构验证器
   （来自 `meta-validator.ts` 的 `isValidJsonSchema`）做验证，并在存在
   残余不兼容时发出每工具兜底的 `{ "type": "object", "properties": {} }`——
   残余不兼容指 `type` 数组、`type: "null"`、`nullable` 键，或任何残留的
   `anyOf`/`oneOf`/`allOf`。

## OpenAI 严格模式流水线

`adaptSchemaForStrict(schema, strict)` 会运行 `tryEnforceStrictSchema`，
后者组合了以下步骤：

1. **清洗**（`sanitizeSchemaForStrictMode`）：剥离非结构性关键字
   （`format`、`pattern`、min/max、`examples`、`default`、
   `if`/`then`/`else`、`not`、`unevaluated*`、`patternProperties`、
   `dependent*`、`content*`、`min/maxProperties`、`$dynamicRef` 等）。
   `default` 值在被丢弃前会以 ` (default: X)` 的形式内联到同级的
   `description` 中，除非 `description` 已经包含 `(default:`，或者
   根本不存在 `description`。
2. **强制**（`enforceStrictSchema`）：每个对象节点都会加上
   `additionalProperties: false`，每个属性都会进入 `required`，
   可选属性则变成可空联合
   （`anyOf: [<original>, { "type": "null" }]`）。元组 `prefixItems`
   会被递归地严格化。

这两个阶段都使用缓存/循环防护，因此 ref、`allOf` 与可空包装都保持
确定性，不会无限递归。`tryEnforceStrictSchema` 是 fail-open 的：
一旦任何环节抛出异常，它就返回 `{ strict: false, schema: upgraded }`，
因此调用方必须只在强制真正成功时才发出 `strict: true`。

### 严格模式规范化器处理的边界情况

- **本地 `$ref` 内联。** OpenAI 严格模式会拒绝带同级键的
  `{ "$ref": "...", "description": "..." }`。清洗器会先针对根 schema
  预解析本地 `#/...` ref 再合并，合并时**同级键优先**于解析出的
  def——优先级与 `openai-python` 的 `_ensure_strict_json_schema` 相同。
  递归 ref 由每次遍历的 epoch 防护。
- **单元素 `allOf`。** `{ "allOf": [X], ...siblings }` 会折叠为
  `{ ...X, ...siblings }`，且内联条目的键优先于原始同级键
  （与 `openai-python` 的 `_pydantic.py:79-83` 一致）。多元素
  `allOf` 保持原样，由下游验证器按需拒绝。
- **类型数组分支与可空联合。** 当节点具有 `type: ["T", "U"]` 时，
  清洗器会为每个类型生成一个变体 schema，并剪除类型专属的关键字
  （例如 `properties`/`required` 只保留在 `object` 变体上，
  `items` 只保留在 `array` 变体上）。共享的 `description` 会被
  **提升到 `anyOf` 包装器上**，而不是在每个分支上重复——因此严格的
  可空联合会变成 `{ anyOf: [T, { type: "null" }], description: "..." }`，
  而不是 `anyOf: [{ ..., description }, { ..., description }]`。
- **没有 `type` 的 enum/const。** 清洗与强制两条路径都会调用
  `inferStrictPrimitiveTypeFromEnumOrConst`，从 `enum` / `const` 值
  推断基本 `type`。混合基本类型的 enum（`[1, "two", null]`）、
  包含对象/数组的 enum，以及非基本类型的 `const` 值（`{a:1}`、
  `[1,2,3]`）无法用单个 `type` 关键字描述，会触发严格模式的
  fail-open 路径——发出无类型的 schema 只会在线路上被 OpenAI
  直接拒绝。

## 性能：静态指纹缓存

`packages/catalog/src/model-manager.ts` 中的 `resolveProviderModels` 与
`packages/catalog/src/model-cache.ts` 中的
`readModelCache`/`writeModelCache` 通过 `model_cache` SQLite 表上的
`static_fingerprint` 列协同工作（当前缓存 schema 版本为 12）。

- `fingerprintStatic(staticModels, dynamicModelsAuthoritative)` 对静态
  目录切片做哈希（`Bun.hash(JSON.stringify(models))`，以 base36 表示），
  把指纹格式/版本与权威模式作为前缀，并通过给数组打上 symbol 属性来
  记忆化非权威结果。端点迁移的丢弃 ID 也会并入缓存标识。
- 当跳过网络获取、缓存既新鲜又权威、恢复出的 header 完整且静态指纹
  匹配时，`resolveProviderModels` 会直接返回恢复的缓存模型，而
  不重建静态/动态合并。
- `mergeModelSources` 与 `mergeDynamicModels` 会对空源输入做短路，
  避免不必要的 `Map` 构造。

来自所有更旧缓存 schema 版本的行都会被删除。新增的缓存列使用保守
默认值，但只有当行内存储的版本恰好等于当前版本时，该行才会被复用。

## 相关内容

- `docs/models.md` — 注册表、等价性与兼容标志
  （`supportsStrictMode`、`toolStrictMode`、`disableStrictTools`）。
- `docs/provider-streaming-internals.md` — 规范化后的 schema 在
  provider 流循环下游的使用方式。
- `docs/mcp-server-tool-authoring.md` — 通过 `normalizeSchemaForMCP`
  接入 MCP `inputSchema`。
- `packages/ai/src/utils/schema/CONSTRAINTS.md` — 每条规范化规则的
  运行契约。
