# manage_skill

> 创建、更新或删除一个独立的受管技能。

## 来源
- 入口：`packages/coding-agent/src/tools/manage-skill.ts`
- 面向模型的提示词：`packages/coding-agent/src/prompts/tools/manage-skill.md`
- 受管技能辅助模块：`packages/coding-agent/src/autolearn/managed-skills.ts`
- 技能发现：`packages/coding-agent/src/extensibility/skills.ts`

## 注册 / 可见性
- 工具元数据：`approval = "write"`、`strict = true`、`loadMode = "essential"`。它保持顶层注册，而不是挂载在 `xd://` 下。
- 注册要求 `autolearn.enabled = true`（默认 `false`），但与 `memory.backend` 无关。
- 已启用的顶层会话会在普通的显式工具列表中自动包含它。子代理既不会自动发现，也不会自动接收它，但当其 requested-tools/frontmatter 列表显式包含时可以使用它。
- 执行是单次性的，不会发出进度更新。

## 输入

| 字段 | 类型 | 必填 | 说明 |
|---|---|---:|---|
| `action` | `"create" \| "update" \| "delete"` | 是 | 受管技能的变更操作。 |
| `name` | `string` | 是 | 短横线命名（kebab-case）的受管技能名称。 |
| `description` | `string` | create/update | 用于技能发现的一行描述。 |
| `body` | `string` | create/update | `SKILL.md` 的 Markdown 正文；不要包含 frontmatter。 |

## 输出
- `delete`：`content[0].text = "Deleted managed skill \"<name>\"."`，`details = { action: "delete", name }`
- `create`：`content[0].text = "Created managed skill \"<name>\" (managed-skills/<name>/SKILL.md)."`，`details = { action: "create", name }`
- `update`：`content[0].text = "Updated managed skill \"<name>\" (managed-skills/<name>/SKILL.md)."`，`details = { action: "update", name }`
- 在 create 时若发生已编写技能的遮蔽（shadowing），会返回 `isError: true` 以及 `details = { action: "create", name, shadowed: true }`。

## 流程
1. `ManageSkillTool.createIf(...)` 仅在 `autolearn.enabled` 为 true 时暴露该工具，并捕获会话可选的 `refreshSkills` 回调。
2. 模式校验要求 `create` / `update` 必须同时提供 `description` 和 `body`；`delete` 只需要 `name`。
3. `delete` 调用 `deleteManagedSkill(name)`，随后在回调存在时刷新活跃技能。
4. `create` 会规范化名称，并检查是否已有活跃的已编写技能占用该名称；如果是，则返回错误结果而不写入。
5. `create` / `update` 调用 `writeManagedSkill(...)`，它会规范化/校验名称，对生成的 frontmatter 进行清理，序列化同名写入（进程内），并将 `SKILL.md` 写入受管技能根目录。
6. 在 create/update 成功后，工具会在回调存在时刷新活跃技能，以便交互式会话能够立即发现变更。

## 模式 / 变体
- `create`：以独占创建语义原子地创建 `SKILL.md`；如果已存在则失败。
- `update`：覆盖现有的常规、单链接的受管 `SKILL.md`；如果不存在则失败。
- `delete`：递归删除现有的受管技能目录；如果不存在则失败。
- 对同一规范化名称的变更在进程内按提交顺序串行化；不同名称可以并行进行。跨进程竞争不会被串行化。

## 副作用
- 文件系统：在 `<agent-dir>/managed-skills/<name>/SKILL.md` 写入或删除文件；默认代理目录为 `~/.omp/agent`。
- 网络：无。
- 会话状态：在工具创建期间读取 `autolearn.enabled`，并在变更成功且 `refreshSkills` 可用时刷新活跃技能列表。
- 后台工作：无。

## 限制与上限
- 可用性要求 `autolearn.enabled = true`。
- 名称会先被去除两端空白并转为小写，然后必须匹配 `[a-z0-9][a-z0-9-]{0,63}`。
- 描述会被清理为单行，并去除控制/格式字符、尖括号、反引号以及重复的波浪号。
- 正文会被去除两端空白，且必须保持非空；生成的 frontmatter 仅包含规范化的 `name` 和清理后的 `description`。
- 最终的受管 `SKILL.md` 内容上限为 `64_000` UTF-8 字节，包括 frontmatter 和 description。
- 会检查受管技能根目录、技能目录和文件以防止符号链接逃逸；update 还会拒绝非常规文件或具有多个硬链接的文件。

## 错误
- 名称无效时抛出 `Invalid skill name "<raw>"...`。
- create/update 缺少 `description` 和 `body` 时会被模式校验拒绝；执行时的防御性错误为 `"<action>" requires both "description" and "body".`
- 清理后的描述为空时抛出 `Managed skill "<name>" needs a non-empty description.`
- 去除两端空白后的正文为空时抛出 `Managed skill "<name>" needs a non-empty body.`
- 最终文件超出大小时抛出 `Managed skill is <bytes> bytes; the limit is 64000.`
- 对已存在的受管文件执行 `create`，以及对不存在的目标执行 `update`/`delete`，会抛出操作相关的辅助错误。
- 在 `create` 时发生已编写技能名称遮蔽属于正常的工具结果，伴随 `isError: true` 和 `details.shadowed = true`；不会写入任何文件。
- 不安全的根目录、被符号链接指向的目录/文件、非常规文件，以及具有多个硬链接的 update 文件，都会抛出安全错误。

## 备注
- 受管技能在 `<agent-dir>/managed-skills` 下生成，永远不会修改已编写的技能。
- 不要在 `body` 中包含 YAML frontmatter；`writeManagedSkill(...)` 会生成包含规范化 `name` 和清理后 `description` 的 frontmatter。
- `update` 不会绕过已编写技能的优先级：若某个已编写技能具有相同名称，受管技能在发现中仍会被遮蔽。
