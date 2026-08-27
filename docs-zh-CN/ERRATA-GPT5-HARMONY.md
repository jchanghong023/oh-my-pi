# 勘误 — GPT-5 Harmony 头泄漏

历史研究笔记，并非当前运行时的契约。下面的统计数据来源于指定的本地
统计数据库快照，而非已检入的测试或运行时代码。

## 当前运行时的缓解措施

当前行为实现于
`packages/ai/src/utils/harmony-leak.ts`
和 `packages/agent/src/agent-loop.ts`：

- 发往 Harmony 方言模型的请求在重放之前，会转义不可信文本、工具结果
  以及序列化后的工具参数中保留的 `<|...|>` 拼写。
- 响应泄漏检测对所有 provider 为 `openai-codex` 的模型启用，
  而非针对一个固定的模型 ID 列表。
- 单独的 `to=functions.NAME` 标记并不充分。检测需要伴随的共信号
  （通道相邻、glitch token、脚本错配、级联、伪结果框架，或受信任的
  尾部解析边界）；围栏示例会被忽略。
- agent 循环扫描已完成的可见文本与思考内容。命中后会丢弃部分响应并
  重试最多两次，随后以错误升级上报。审计回调会接收 action/signal
  元数据以及对已移除内容的哈希/脱敏预览。
- 工具参数检测在调用方提供结构合法工具解析结束处的字节偏移之前，
  故意保持非激活状态。主 agent 循环当前并不提供该边界，从而避免
  在讨论协议本身的合法工具数据上误中止。
- 恢复支持适用于有界自由格式的 `eval` 输入以及当前的 hashline `edit`
  DSL（以 `@` 开头的输入）：它会在受污染行处截断并追加 `*** Abort`。
  apply-patch 信封与 JSON-schema edit 输入不适用恢复机制，在存在
  有界检测时改用中止/重试。

下方的语料表描述的是该快照中历史输入的格式；它们并不代表当前 `edit`
工具所接受的语法列表。

## 1. 问题

OpenAI 在 Harmony 聊天协议中将工具调用包装为：

```
<|start|>assistant<|channel|>commentary to=functions.<NAME><|message|>{ARGS}<|call|>
```

`<|channel|>commentary to=functions.NAME` 是 **路由头** —
由运行时消费的用于派发调用的控制 token。在正常操作下，这些 token
永远不会作为内容出现；运行时会将它们剥离。

缺陷在于：gpt-5 系列模型偶尔会 **作为 `{ARGS}` 内部的普通内容**，
发出这些路由 token 的 **纯文本影子** — 同样的字符但没有 `<|…|>`
尖括号 — 并继续产生更多伪路由结构（通道名、消息体标记、多语言
垃圾、伪造的工具结果框架）。污染位于可见的工具参数内部，并如同
本意内容一样被分派给工具执行。

**关键细节。** 真正的 `<|start|>` / `<|channel|>` / `<|message|>` /
`<|call|>` 特殊 token 几乎从不出现在工具参数中。泄漏的是无尖括号的
拼写 — `analysis to=functions.X code …` — 因为 OpenAI 在参数区域内
施加了抑制这些控制 token ID 的 logit 屏蔽。原本会落到这些特殊 token
上的质量被重新分配到模型同样学到的、无尖括号的纯文本表示上。这使
泄漏对路由解析器在结构上不可见，并原样落进工具输入。

在工具参数中的表现（来自真实语料的示例）：

```
~      add_function(iso, ctx, ns, "installSystemChangeObserver",
        os_install_system_change_observer);】【"】【analysis to=functions.edit
        code above เงินไทยฟรีuser to=functions.edit code …
```

前面的代码是真实且符合意图的。从第一个非拉丁 token 起一直到下一个
干净的结构边界为止的内容，均属污染。

---

## 2. 观察到的统计与失败模式

数据源：`~/.omp/stats.db`（`ss_tool_calls`，`ss_assistant_msgs`），
截至 2026-05-10。扫描了 1.05M 次工具调用。

### 2.1 比率

| Model         | Leaks in tool args |   Calls | per million |
| ------------- | -----------------: | ------: | ----------: |
| gpt-5.4       |                 37 | 226,957 |         163 |
| gpt-5.3-codex |                 17 | 112,243 |         151 |
| gpt-5.5       |                  2 |  80,750 |          25 |
| gpt-5.2-codex |                  0 |       — |           — |

另有 15 处命中出现在助手可见文本 / 思考块中。

### 2.2 工具分布

| Tool                           |   Hits |
| ------------------------------ | -----: |
| `edit`                         |     38 |
| `eval`                         |     11 |
| `report_tool_issue`            |      3 |
| `grep`/`read`/`search`/`yield` | 1 each |

主要集中在采用自由格式（非 JSON-schema）参数格式的工具上。

### 2.3 泄漏形态（确定性的）

```
LEAK         ::= JUNK_PREFIX MARKER CHANNEL_BODY (LEAK)?
MARKER       ::= "to=functions." TOOL_NAME
CHANNEL_BODY ::= " code " (SPAM | reasoning_prose | fake_tool_output)*
JUNK_PREFIX  ::= (GLITCH_TOKEN | CHANNEL_WORD | NON_LATIN_RUN | "}" | "】【")+
```

**级联是常见的。** 在 71 条受污染记录中出现的 96 个标记里，39 条
包含 ≥2 个标记，7 条包含 ≥3 个 — 模型连续发出多个伪造的
`to=functions.X code …` 块，块之间常常夹有伪 `code_output\nCell N:\n…`
框架。一旦纯文本脚手架进入残差流，前缀现在 _看起来就像_ 一个新的
工具信封起点，于是宏先验对后续延续的投票继续偏向于更多脚手架。
呈自我放大。

### 2.4 Glitch token

`o200k_base` 中的单 token 标识符，由于在后训练中代表性不足，其嵌入
近似接近初始化。紧接标记之前、自然语料中的 ASCII 残留：

| Surface string    | Single-token | Token ID |                  Hits in corpus |
| ----------------- | :----------: | -------: | ------------------------------: |
| `Japgolly`        |      ✅      |  199,745 |                               1 |
| `Jsii`            |      ✅      |  114,318 | (subtoken of `Jsii_commentary`) |
| `Jsii_commentary` |  — (3 toks)  |        — |                               2 |
| `changedFiles`    |  — (2 toks)  |        — |                               8 |
| `RTLU`            |  — (2 toks)  |        — |                               3 |

`Japgolly` 位于词表的最后 0.13% — 与 2023 年 GPT-2 词表中产生
`SolidGoldMagikarp` 的 GitHub 语料残留同属一类
（Rumbelow & Watkins）。`SolidGoldMagikarp` 本身在 `o200k_base`
中分词为 5 个 token — 那一个具体 token 已被废弃，但这一类并未被清理。

对于多 token 条目，语料层面的签名是表面字符串；其下真正的 glitch
触发器是某个子 token（例如 `Jsii_commentary` 中的 `Jsii`）。检测器
列表（`G` 信号）以表面字符串作为键。

在不同会话间保持稳定。被视为高精度的检测器信号。

### 2.5 通道词泄漏

`analysis`（5）、`assistant`（5）、`commentary`（3）、`user`（1）
直接出现在 `to=` 之前。始终是裸词；从不出现 `<|channel|>analysis`
或任何其他带尖括号的形式。与 §1 一致 — 尖括号被屏蔽，词不会被屏蔽。

### 2.6 非拉丁垃圾残留

96 个标记命中，按文字系统分布：CJK 40，西里尔 12，泰卢固/卡纳达/
马拉雅拉姆 18，泰文 8，格鲁吉亚文 7，亚美尼亚文 7，阿拉伯文 1。
反复出现的片段包括中文博彩 SEO（`大发时时彩`、`天天中彩票`）、
格鲁吉亚/阿布哈兹垃圾、以及泰文赌场垃圾 — 均为典型的低质量
抓取残留。

这与受控复现实验（§7.3）中观察到的文字系统分布相同，独立于提示
本身的自然语言。

### 2.7 `edit` 工具的失败模式细分

`edit` 工具在语料中存在两种变体：

| Variant                                            | Calls | Recovery                                                                                                                                             |
| -------------------------------------------------- | ----: | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Patch-DSL (`[PATH#TAG]`/anchor/`SWAP DEL INS` ops) |    27 | **Recoverable** by op-truncation (§3.3)                                                                                                              |
| JSON-schema (`{path,edits:[…]}`)                   |    11 | **Not recoverable** — contamination is escaped _inside_ JSON strings, parser accepts it cleanly, content would be written verbatim into source files |

针对 Patch-DSL 泄漏具体而言：

- 20/27 的情况：污染出现在输入的最后一行；其后无内容。
- 7/27 的情况：污染出现在输入中间；其后内容为下列之一：先前某文件/
  锚点的重复重放、_另一_ 工具调用的本意内容（模型将下一次调用内联
  开始）、或纯粹的幻觉。污染之后的内容永远不可信。

### 2.8 机制（已确认）

**源自 null-embedding glitch token 的先验坍缩，坍缩至一个控制
token 被屏蔽的盆地，其质量被重新分配到 Harmony 协议的纯文本
影子上。**

逐步过程：

1. 模型正处于一次 Harmony 工具调用的 `{ARGS}` 中。运行时施加了
   logit 屏蔽，抑制参数区域内的结构性控制 token（`<|channel|>`、
   `<|message|>`、`<|call|>`、`<|start|>`、`<|end|>`）。没有这个
   屏蔽，正常生成会不断幻觉出信封闭合；有了它，这些 token ID
   在参数内的 logit 即为 `-∞`。
2. 采样到一个 glitch token `g`。按构造，`g` 出现在 BPE 合并语料中
   但在 LM/RL 训练中几乎缺席，因此其 **输入嵌入 `e_g` ≈ 范数很小的
   近初始化噪声**。
3. 在位置 t+1，残差更新 `h_{t+1} ≈ LN(h_t + e_g + Attn + MLP)`
   由前缀派生项主导；刚发射的 token 信号实际上缺席。生成的多样性
   通常来自 `e_x` 将残差引导到不同子区域 — 而此处被剥离。
4. 因此下一 token 分布坍缩到 **关于前缀延续的条件先验，局部
   条件被移除**。在工具调用展开的语境下，该先验尖锐地集中于
   Harmony 脚手架（控制 token + 路由 token） — 正是 RL 训练的内容。
5. 屏蔽将控制 token ID 置零。质量被重新分配到 **次优延续**：
   同一协议的无尖括号表面形式拼写（`analysis`、`commentary`、
   ` to=functions.X`、`code`）。这种拼写未被屏蔽，因为这些字符
   都是普通 token。
6. 一旦少量纯文本脚手架 token 落入残差流，前缀现在类似于一个
   新的信封起点。宏先验继续投票给更多脚手架。级联（§2.3）随之而来。
7. 标记之后的多语言垃圾属于同一种先验坍缩延续，取自 glitch token
   训练邻域（通常是 ESL/自动生成的多语言网络垃圾 — 正是 §2.6 中
   的抓取残留）。

**两条由语料数据提出、却只有实验能解释的推论：**

- **尖括号永远不出现**（§1，§2.5）。正是屏蔽让泄漏以纯文本形式
  落地，而非作为一个真正的信封闭合。
- **反直觉的语法依赖**（§7.4）。在格式上越接近 OpenAI 训练分布
  的情形下，泄漏反而 _更严重_。偏离分布的自定义语法会抑制宏
  先验盆地；官方的 `*** Begin Patch` 格式是最强的坍缩目标。

2023 年的 SolidGoldMagikarp 论文记录了机制 (1)+(2)+(4)。新增的是
(5)：当受限解码屏蔽了自然的坍缩目标时，经由未屏蔽的纯文本影子
被"洗白"的质量会变成一条结构上不可见的外泄通道。
