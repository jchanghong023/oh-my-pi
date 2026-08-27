# AI 工具 schema 规范化

`@oh-my-pi/pi-ai` 暴露了一个统一的 schema 规范化器，供各 provider 在工具通过线路发送前消费。
所有 walker 都位于 `packages/ai/src/utils/schema/normalize.ts`；运行契约位于
`packages/ai/src/utils/schema/CONSTRAINTS.md`。

现在不再有独立的 `strict-mode.ts` 模块——OpenAI 严格模式清洗、OpenAI Responses
`oneOf` 重写、Google/Vertex/Gemini-CLI 清洗、Cloud Code Assist Claude 清洗以及
MCP 清洗都共享同一个由选项驱动的遍历流程。

## 入口点

所有导出都位于 `@oh-my-pi/pi-ai/utils/schema` 之下：

- `normalizeSchema(value, options)` — 通用的、由选项驱动的 walker。
- `normalizeSchemaForGoogle(value)` — Gemini / Vertex / Gemini CLI。
- `normalizeSchemaForCCA(value)` — Cloud Code Assist Claude（Antigravity + GCA）。
- `normalizeSchemaForMCP(value)` — MCP `inputSchema` 在进入自定义工具注册表之前的
  处理。`tool-bridge.ts` 会将每个 MCP 的 `inputSchema` 通过此调度器运行。
- `sanitizeSchemaForOpenAIResponses(schema)`（别名
  `normalizeSchemaForOpenAIResponses`）— 递归地将 `oneOf` 重写为 `anyOf`，
  为对象 schema 添加空的 `properties`，并移除 Responses API 不接受的正则
  前后瞻断言。
- `sanitizeSchemaForStrictMode(schema)` 以及
  `enforceStrictSchema(schema)` / `tryEnforceStrictSchema(schema)` — OpenAI
  严格模式流水线（清洗 → 强制）。这三者都从 `normalize.ts` 导出。
- 来自 `./adapt` 的 `adaptSchemaForStrict(schema, strict)` — 一个轻量的组合器，
  将 draft-07 输入升级到 2020-12，并为 provider 调用点包装
  `tryEnforceStrictSchema`。`./adapt` 还导出 `NO_STRICT` 全局绕过标志
  （环境变量 `PI_NO_STRICT`），被每个发出 `strict: true` 的 provider 所遵守。
- `normalizeSchemaForMoonshot(value)` — Moonshot/Kimi 的 MFJS 子集。
- `sanitizeSchemaForOllama(schema)` — 为 Ollama 的 Go schema 解析器重写
  布尔子 schema、类型数组和布尔型对象开放性关键字。
- `sanitizeSchemaForGrammar(schema)` — 为支持语法约束的 OpenAI 兼容后端
  放宽布尔子 schema，同时保留布尔型的 `additionalProperties` /
  `unevaluatedProperties`。

在统一流重构中已移除：

- `strict-mode.ts`（已合并到 `normalize.ts`）。
- `sanitize-google.ts` 和 `normalize-cca.ts`（已替换为
  `normalizeSchemaFor*` 调度器）。
- `StringEnum` 辅助函数 — 请使用 `type.enumerated(...)`；omptype 会输出
  provider 兼容的 JSON Schema。
- `sanitizeSchemaFor{Google,CCA,MCP}` / `prepareSchemaForCCA` — 已重命名为
  `normalizeSchemaFor{Google,CCA,MCP}`。

## 调度器映射

| Provider 传输方式                                                  | 调度器                                                                          |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| `openai-completions`                                               | `adaptSchemaForStrict`（启用严格模式时进行清洗 + 强制）                          |
| `openai-responses`, `openai-codex-responses`                       | 在严格模式适配之前使用 `sanitizeSchemaForOpenAIResponses`                       |
| `azure-openai-responses`                                           | `sanitizeSchemaForOpenAIResponses`；发出 `strict: false` 而不进行适配            |
| 使用 MFJS 的 Moonshot/Kimi 原生主机                                | `normalizeSchemaForMoonshot`                                                    |
| 语法风格的 OpenAI 兼容主机                                         | `sanitizeSchemaForGrammar`                                                      |
| `ollama`                                                           | `sanitizeSchemaForOllama`                                                       |
| `google-generative-ai`, `google-vertex`, Gemini CLI                | `normalizeSchemaForGoogle`                                                      |
| Cloud Code Assist Claude（Antigravity + GCA，`claude-*` 模型 id）  | `normalizeSchemaForCCA`                                                         |
| MCP `inputSchema` 接入                                             | `normalizeSchemaForMCP`                                                         |
| `anthropic-messages`（原生，非 CCA）                               | `anthropic.ts` 中的 provider 白名单                                              |

Gemini CLI / Antigravity CCA 必须运行完整的 `normalizeSchemaForCCA` 流水线
（不仅仅是首次的关键字剥离步骤），以保持与共享的 Google Claude 路径一致。

## 遍历语义

`normalizeSchema` 将输入升级到 JSON Schema 2020-12，对树进行解引用，
然后使用调度器固定的选项集进行遍历。每个节点：

1. 将 `snake_case` 的组合子/属性键重命名为 camelCase
   （`any_of` → `anyOf` 等；冲突时遵循 python-genai 的
   `pop(from)`/`set(to)` 语义——snake_case 优先）。
2. 在递归进入子节点之前，对可空联合应用 `handle_null_fields` 折叠。
3. 剥离目标 provider 不支持的键，可选地将具有人类可读含义的键
   （`pattern`、`format`、min/max、`default`、`examples` 等）通过溢出格式化器
   （`spill.ts`）提升到同级 `description` 中。结构/元键
   （`$ref`、`$defs`、`additionalProperties`）不会被溢出。
4. 规范化类型联合（`type: ["T", "null"]` → 在 Google 上为 `type: "T"`
   加上可空标记，在 CCA 上为普通的 `type: "T"`）。
5. 折叠仅对象 / 同类型的组合子，可选地有损折叠混合类型的组合子
   （仅 CCA），并运行残余组合子不动点。
6. 当设置 `validateAndFallback` 时（CCA 路径），使用内部结构验证器
   （来自 `meta-validator.ts` 的 `isValidJsonSchema`）进行验证，
   并在残余不兼容时发出每个工具的兜底 `{ "type": "object", "properties": {} }` —
   `type` 数组、`type: "null"`、`nullable` 键，或任何剩余的
   `anyOf`/`oneOf`/`allOf`。

## OpenAI 严格模式流水线

`adaptSchemaForStrict(schema, strict)` 运行 `tryEnforceStrictSchema`，
后者组合了：

1. **清洗**（`sanitizeSchemaForStrictMode`）：剥离非结构性的关键字
   （`format`、`pattern`、min/max、`examples`、`default`、
   `if`/`then`/`else`、`not`、`unevaluated*`、`patternProperties`、
   `dependent*`、`content*`、`min/maxProperties`、`$dynamicRef` 等）。
   `default` 值在丢弃之前会以 ` (default: X)` 的形式内联到同级的
   `description` 中，除非 `description` 已经包含 `(default:` 或者
   不存在 `description`。
2. **强制**（`enforceStrictSchema`）：每个对象节点都会获得
   `additionalProperties: false`，每个属性都会进入 `required`，
   可选属性变成可空联合
   （`anyOf: [<original>, { "type": "null" }]`）。元组 `prefixItems`
   会被递归地严格化。

这两个过程使用缓存/循环保护，因此 ref、`allOf` 和可空包装保持确定性，
不会无限递归。`tryEnforceStrictSchema` 是 fail-open 的：如果抛出任何异常，
它返回 `{ strict: false, schema: upgraded }`，因此调用方仅在强制实际成功时
才必须发出 `strict: true`。

### 严格模式规范化器处理的边界情况

- **本地 `$ref` 内联。** OpenAI 严格模式拒绝带有同级键的
  `{ "$ref": "...", "description": "..." }`。清洗器预先将本地 `#/...`
  ref 针对根进行解析，并合并到已解析的 def 上，**同级键优先**于已解析
  的 def——与 `openai-python` 的 `_ensure_strict_json_schema` 优先级相同。
  递归 ref 由每次遍历的 epoch 进行保护。
- **单元素 `allOf`。** `{ "allOf": [X], ...siblings }` 折叠为
  `{ ...X, ...siblings }`，其中内联条目的键优先于原始同级键
  （与 `openai-python` 的 `_pydantic.py:79-83` 一致）。多元素
  `allOf` 保持原样，由下游验证器根据需要进行拒绝。
- **类型数组分支和可空联合。** 当节点具有 `type: ["T", "U"]` 时，
  清洗器为每个类型发出一个变体 schema，修剪类型特定的关键字
  （例如 `properties`/`required` 仅保留在 `object` 变体上，`items`
  仅保留在 `array` 变体上）。共享的 `description` 被**提升到 `anyOf`
  包装器上**，而不是在每个分支上重复——因此严格的可空联合变为
  `{ anyOf: [T, { type: "null" }], description: "..." }`，而不是
  `anyOf: [{ ..., description }, { ..., description }]`。
- **没有 `type` 的 enum/const。** 清洗和强制路径都会调用
  `inferStrictPrimitiveTypeFromEnumOrConst` 从 `enum` / `const` 值推断
  基本 `type`。混合基本类型的 enum（`[1, "two", null]`）、包含对象/
  数组的 enum，以及非基本类型的 `const` 值（`{a:1}`、`[1,2,3]`）
  无法用单个 `type` 关键字描述，会触发严格模式的 fail-open 路径——
  因为发出无类型的 schema 在 OpenAI 端会被直接拒绝。

## 性能：静态指纹缓存

`packages/catalog/src/model-manager.ts` 中的 `resolveProviderModels` 以及
`packages/catalog/src/model-cache.ts` 中的 `readModelCache`/`writeModelCache`
通过 `model_cache` SQLite 表上的 `static_fingerprint` 列进行协作
（当前缓存 schema 版本为 12）。

- `fingerprintStatic(staticModels, dynamicModelsAuthoritative)` 对静态目录切片
  进行哈希（`Bun.hash(JSON.stringify(models))`，以 base36 表示），为指纹
  格式/版本和权威模式添加前缀，并通过为数组标记 symbol 属性来记忆化
  非权威结果。端点迁移丢弃的 ID 也会被纳入缓存标识。
- 当跳过网络获取时，如果缓存是新鲜的且权威的、恢复的 header 完整，
  并且静态指纹匹配，`resolveProviderModels` 会直接返回恢复的缓存模型，
  而不重建静态/动态合并。
- `mergeModelSources` 和 `mergeDynamicModels` 会对空源输入进行短路，
  避免不必要的 `Map` 构造。

来自所有较旧缓存 schema 版本的行都会被删除。新增的缓存列使用保守的默认值，
但只有当存储的版本恰好是当前版本时，行才会被复用。

## 相关内容

- `docs/models.md` — 注册表、等价性、兼容标志
  （`supportsStrictMode`、`toolStrictMode`、`disableStrictTools`）。
- `docs/provider-streaming-internals.md` — 规范化的 schema 在 provider
  流循环下游的使用方式。
- `docs/mcp-server-tool-authoring.md` — 通过 `normalizeSchemaForMCP`
  接入 MCP `inputSchema`。
- `packages/ai/src/utils/schema/CONSTRAINTS.md` — 每个规范化规则的
  运行契约。
