# edit

> 应用源码编辑。默认的 `hashline` 模式接收一个按行锚定的补丁字符串，并直接编辑已存在的文件。

## Source
- 入口与模式注册：`packages/coding-agent/src/edit/index.ts`
- Hashline 模式参数：`packages/coding-agent/src/edit/hashline/params.ts`
- 面向模型的 hashline 提示词：`packages/hashline/src/prompt.md`
- 规范的约束解码语法：`packages/hashline/src/grammar.lark`
- 解析器与应用：`packages/hashline/src/input.ts`、`packages/hashline/src/parser.ts`、`packages/hashline/src/apply.ts`
- 快照校验与恢复：`packages/hashline/src/snapshots.ts`、`packages/hashline/src/patcher.ts`、`packages/hashline/src/recovery.ts`
- Coding-agent 执行与结果整形：`packages/coding-agent/src/edit/hashline/execute.ts`
- 流式预览策略：`packages/coding-agent/src/edit/streaming.ts`、`packages/coding-agent/src/edit/hashline/diff.ts`

## Mode selection and availability

`edit` 是一个核心内置工具。`resolveEditMode()` 按以下顺序选择当前生效的线协议：

1. 针对特定模型配置的变体；
2. `PI_EDIT_VARIANT`；
3. `edit.mode`；
4. 默认 `hashline`。

支持的模式有 `hashline`、`apply_patch`、`patch` 和 `replace`。除非设置了 `PI_STRICT_EDIT_MODE`，否则一个简短的模型排除列表可能会用 `replace` 替换默认的 hashline 协议。本页面说明的是默认的 hashline 协议；该工具的 schema、提示词、示例、渲染器以及可选的自定义 Lark 格式都会随所选模式切换。在 `apply_patch` custom-tool 模式下，线协议名称为 `apply_patch`；调度最终仍会抵达同一个内部工具。

## Input

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `input` | `string` | Yes | 一个或多个包含 hashline 操作的 `[PATH#TAG]` 段。严格的 custom-tool 语法会用 `*** Begin Patch` / `*** End Patch` 将各段包裹；普通解析器也接受未包裹的负载。 |

每个段编辑一个已存在的文件，并且必须复制最近一次锚定 `read`、`grep` 或成功 `edit` 结果中四个大写十六进制字符组成的快照标签：

```text
[src/example.ts#1A2B]
PUT 4.=4:
+const value = 2;
```

使用 `write` 来创建或完全覆盖一个文件。Hashline 在应用时会拒绝没有标签的锚定编辑。

## Canonical patch language

所有行号都指代带标签的原始快照，而非同一调用中早期 hunk 的行号。

| Form | Effect |
| --- | --- |
| `PUT N.=M:` | 将原文件中包含的第 `N..M` 行替换为接下来的 `+TEXT` 行。 |
| `PUT N*:` | 替换从第 `N` 行开始的多行语法块。 |
| `PUT <N:` / `PUT >N:` | 在第 `N` 行之前 / 之后立即插入 body 行。`PUT <1:` 表示文件首。 |
| `PUT >$:` | 在文件末尾追加 body 行。 |
| `PUT >N*:` | 在从第 `N` 行开始的语法块之后插入。 |
| `CUT N.=M` / `CUT N*` | 删除并捕获一个包含性的行范围或解析后的块。附加 `@name` 以写入具名寄存器。 |
| `PUT <N` / `PUT >N` / `PUT >$` | 将匿名寄存器粘贴到一个空隙中。 |
| `PUT <N @name` / `PUT >N @name` / `PUT >$ @name` | 将具名寄存器粘贴到一个空隙中。 |
| `PUT N.=M @name` / `PUT N* @name` | 用具名寄存器替换一个行范围或块。跨范围/块粘贴必须使用具名寄存器。 |
| `REM` | 删除本段对应的文件。 |
| `MV DEST` | 在同一段内的所有前置编辑之后移动/重命名本段对应的文件。如果目标路径中包含空格，请用引号包裹。 |

寄存器名称只能包含 ASCII 字母、数字、`_` 或 `-`。匿名寄存器是批次本地的，每次调用时初始为空。具名寄存器在会话期间持续存在，并且仅在其写入落地后才会对外可见。操作按从上到下的顺序跨段执行，因此较前段中的 cut 可以为较后段的 paste 提供内容。重复粘贴不会消耗其寄存器。

只有带 body 的 `PUT ...:` 头部才会接收 body 行。每个 body 行都是 `+TEXT`；单独的 `+` 表示插入一个空行。body 是最终内容，永远不是 unified-diff 的 before/after 对。以字面量 `-` 或 `+` 开头的内容需要写成 `+-...` 或 `++...`。`CUT`、由寄存器支持的 `PUT`、`REM` 和 `MV` 不接受 body。

### Block anchors

块形式会从其起始行解析到 tree-sitter 节点的结尾。锚点应放在构造的起始行，而不能是结束分隔符、最后可见行、空行或内部语句。单行节点会被拒绝，并提示使用对应的显式行操作。当没有块能够解析时，`PUT >N*:` 会降级为普通的 `PUT >N:` 并发出警告；而 replace/cut 的块形式在这种情况下会失败，而不是去猜测。

前导的装饰器、属性和文档注释可能是独立的语法节点。当解析器将装饰器与声明归为同一组时，锚点应放在第一个装饰器；否则使用显式行范围。独立的行注释不会被自动纳入块中。在 Markdown 中，标题的块会包含其正文以及更深层级的子节，直到遇到同级或更高级别的下一个标题。

应使用紧凑的行范围，并将不相邻的改动分到不同的操作中。不要仅仅为了重新格式化或调整代码风格而使用 `edit`；请在完成实质性编辑后运行项目自带的格式化工具。

## Examples

给定：

```text
[greet.py#A1B2]
1:@cache
2:def greet(name):
3:    print("Hello, " + name)
4:
5:greet("world")
```

替换带装饰器的函数而不影响其调用方：

```text
*** Begin Patch
[greet.py#A1B2]
PUT 1*:
+@cache
+def greet(name):
+    print(f"Hi, {name}")
*** End Patch
```

使用具名寄存器将其移动到另一个已读取过的文件：

```text
*** Begin Patch
[greet.py#A1B2]
CUT 1* @fn
[lib/greet.py#3C4D]
PUT <1 @fn
*** End Patch
```

在编辑之后进行重命名：

```text
*** Begin Patch
[greet.py#A1B2]
PUT 5.=5:
+greet("team")
MV lib/welcome.py
*** End Patch
```

## Output and side effects

Hashline 在一次工具调用内完成应用；它不使用 `ast_edit` 所采用的分阶段 `xd://resolve` / `xd://reject` 流程。

一个成功的段会返回全新的 `[path#TAG]` 头部、可选的块解析与移动行、可获得的紧凑编辑后预览，以及在恢复或规范化产生警告时的 `Warnings:` 块。`EditToolDetails` 可以包含统一的 `diff`、`firstChangedLine`、诊断/格式化结果、操作（在 hashline 模式下为 `update` 或 `delete`）、路径/移动相关的元数据、快照以及每个文件的结果。多段输入会返回一份聚合的结果。

流式渲染器会解析飞行中负载的已完成片段，并计算只读的 diff。流式预览会跳过瞬时未解析的块、过期标签和空粘贴，而不是把尚未完成的输入当作最终失败呈现。执行阶段仍会按常规重新读取并校验。

对于多段调用，所有段会在任何写入开始之前完成解析和准备，这样语法、锚点和空操作相关的错误会快速失败。然后文件按顺序写入；操作系统的写入失败可能导致此前已落地的前缀部分被应用。具名寄存器的会话状态仅会针对已落地的前缀部分前进。

## Limits and validation

- 快照标签是四个大写十六进制字符，由规范化后的文件内容派生，并记录在会话快照存储中。
- `read`/`grep` 暴露的范围很重要：针对所记录可见范围之外行的编辑会被拒绝。在编辑被省略或未显示的范围之前，请重新读取它们。
- 行范围是包含性的，必须按顺序排列，并且在与目标文件实际边界比较之前，受限于解析器放大上限 100,000 个展开行。
- 重叠的编辑或针对同一原始锚点的多个操作会被拒绝。
- 同路径的段会被合并，以便其原始行锚点可以一起生效。如果交错的同路径段会让寄存器顺序产生歧义，剪贴板操作将被拒绝。
- 过期标签会尝试基于快照进行恢复。恢复仅在已记录的快照链能够证明一个唯一安全的结果时才会应用；否则返回与当前上下文不匹配的错误。
- 字节级完全相同的编辑是错误。连续三次重复相同的空操作负载会通过空操作循环保护进行升级处理。

## Common failures

- 缺失或格式错误的 `[PATH#TAG]`、未知的快照标签，或者文件路径已不存在。
- 锚点位于文件之外、所记录的可见行范围之外、被省略的区域之中，或基于无法安全恢复的过期快照。
- 范围顺序颠倒或相互重叠。
- 带 body 的 `PUT` 缺少 body、在无 body 的操作下出现 body 行、未知的具名寄存器，或在匿名 cut 尚未明确前就执行匿名 paste。
- 块锚点落在不支持/无效的语法树、空行/结束行，或单行节点上。
- 出现 unified-diff 形式的污染（`@@`、apply-patch 哨兵、`-old` 行），而不是 hashline 操作和最终内容的 `+` 行。
- `REM` / `MV` 冲突、无效的移动目标、目标冲突，或文件系统的写入失败。
- 一个能解析并完全应用到现有字节（即没有变化）的补丁。

解析器对常见的模型疏漏（可选的包裹、良性的头部噪声、某些裸行和范围写法）提供有限的恢复能力，并在修复输入时给出警告。调用方应当只输出上文中的规范语法；恢复行为并不构成第二套公开语法。