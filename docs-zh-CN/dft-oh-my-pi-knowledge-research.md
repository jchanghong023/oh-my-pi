# DFT 团队使用 Oh My Pi 访问内部 Markdown 知识的技术调研报告

**报告日期：** 2026-08-30  
**适用环境：** 芯片开发 DFT 内网研发环境  
**资料形态：** 约 100 MB Markdown，来源包含原始文档、图片 OCR、音视频转写  
**工具环境：** 本文面向当前项目 **Oh My Pi（OMP）**。OMP 原生支持上下文文件、Skills、Task 子代理、Rules、Hooks、扩展、Marketplace 和 MCP，可将知识检索与编码工作流组合在同一套 Agent 运行时中。

---

## 1. 执行摘要

当前问题不是“Oh My Pi 能不能读取 Markdown”，而是下面四个问题同时存在：

1. **知识与代码仓库分离。** 各代码项目基本没有项目文档，OMP 只能从代码反推设计意图。
2. **术语高度内部化。** Lander、Sailor、Hibist、`stage/group/tc`、`top_repair`、各种 `define_*` 配置命令及版本组合具有明显的公司内部语义，通用模型不能可靠补全。
3. **知识不是纯自然语言。** 资料中有精确命令、选项、Tcl 示例、流程依赖、版本限制、输入输出件和报错；这些内容不能只按“语义相似度”处理。
4. **资料质量不均。** 同一知识库混有正式手册、需求/设计说明、培训材料、会议材料、OCR 和语音转写。错误地自动纠正命令、信号名或路径，可能比不检索更危险。

因此，不建议把问题简化为“grep 还是 RAG”。更合理的总体架构是：

```text
Oh My Pi
   │
   ├── 技术二：DFT OMP 插件
   │      ├── Agent Skills：何时查、查什么、如何使用证据
   │      ├── DFT 文档研究 Task 子代理：隔离检索上下文
   │      ├── 精简规则：项目类型、版本和风险边界
   │      └── 可选 Hooks：注入当前分支、工具版本、任务类型
   │
   └── 技术一：DFT 文档知识服务（MCP）
          ├── 原始 Markdown，只读保留
          ├── 规范化检索副本和内部术语别名表
          ├── 标题/章节全文索引
          ├── 命令、选项、模式、版本、示例、限制的结构化索引
          ├── 可选向量检索
          └── 后续可加入“文档符号 ↔ 代码符号”映射
```

### 最终推荐的两种技术

| 推荐 | 技术 | 定位 | 主要解决的问题 |
|---|---|---|---|
| 1 | **结构化 DFT 文档知识服务，并通过 MCP 接入 OMP** | 知识后端 | 让 Agent 能按命令、选项、版本、流程和章节进行可靠查询，而不是只做文本相似度搜索 |
| 2 | **Agent Skills + 专用 Task 子代理，并封装成团队 OMP 插件** | Agent 行为和团队分发层 | 让 OMP 知道“什么时候必须查文档、调用哪些工具、如何处理冲突和 OCR 噪声” |

这两项不是互斥方案。第一项提供“可查询的事实”，第二项提供“使用事实的方法”。组合部署最适合本项目。

---

## 2. 项目现状与资料特征

### 2.1 从项目资料确认的知识特点

本项目资料不是普通的软件 API 文档，而是多套内部平台、EDA 工具和业务方法学的组合：

- Lander 从 Sailor、Hibist 和用户配置获取数据，并以 `STAGE`、`GROUP`、`TC` 等维度承载验证方案。
- MBIST、ATPG、IJTAG、3D 场景分别存在不同流程、模式、输入输出件和配置命令。
- 资料中存在大量类似 `define_project_info`、`define_mbist_info`、`define_atpg_info`、`define_test_setup`、`define_sim_info` 的内部命令和选项。
- 工具版本之间存在兼容关系，某些文档明确要求 Lander、Sailor、Hibist 等版本匹配，否则可能出现解析错误。
- IDE/Lander 方案本身强调配置、输入输出、执行结果和版本数据的可追溯性，存在 `IDE.json`、`IDE_detail.json`、按用例生成 JSON，以及 Git/OBS 数据管理设计。

这些特征决定了：

> 对本项目而言，“命令和版本的精确命中”与“自然语言语义检索”同样重要，且前者在修改代码和配置时通常风险更高。

### 2.2 Markdown 数据的主要质量风险

| 风险 | 示例类型 | 对 Agent 的影响 |
|---|---|---|
| OCR 字符混淆 | `0/O`、`1/l/I`、`5/S`、`8/B`、`-/_` | 可能把真实命令、实例名或路径纠错成错误内容 |
| ASR 同音/断句 | 工具名、内部缩写、英文命令被中文化或拆分 | 语义检索召回下降，摘要可能改变原意 |
| 表格转写错位 | 命令、可选值、说明不在同一行 | 错误建立“选项—含义”关系 |
| 重复与版本并存 | 培训材料、需求说明、实现说明、测试说明同时存在 | Agent 可能拿旧版本覆盖新版本，或把需求当已实现事实 |
| 内部拼写本身非标准 | 例如某些接口名可能有历史拼写 | 不能把所有“不像英文”的词都自动修正 |
| 代码块被破坏 | 反斜杠、引号、换行丢失 | 生成不可运行的 Tcl、Shell 或配置片段 |

### 2.3 完成条件

方案必须满足以下要求，才算真正提高编码效率：

1. OMP 在涉及内部 DFT 概念或接口时，能够主动或半主动查询资料。
2. 查询结果必须附带原始文档、章节、版本或日期，便于工程师复核。
3. 精确符号查询不能被 OCR 自动纠错污染。
4. 文档冲突必须显式呈现，不能自动“选一个看起来合理的答案”。
5. 知识服务初期必须只读，不允许文档内容直接触发代码执行或外部写操作。
6. 接入方式要适用于大量无文档代码仓库，不要求每个仓库复制 100 MB 资料。
7. 团队级规则、技能和工具可以统一升级、版本化和回滚。

---

## 3. 技术方案全景

下面将 grep、传统 RAG 作为已知基线，同时列出其他可选技术。需要注意：有些是“知识存储/检索技术”，有些是“Agent 使用知识的技术”，还有些是“接入与分发技术”，不能混为同一层进行比较。

### 3.1 方案对比

| 技术 | 基本原理 | 适合本项目程度 | 主要价值 | 主要限制 |
|---|---|---:|---|---|
| 精确检索：grep/BM25/全文索引 | 根据字面词项、倒排索引和相关性排序查找文本 | 高 | 报错、命令、选项、信号、路径命中可靠 | 不理解同义词和隐含问题；无法直接表达版本和关系 |
| 通用 RAG | 将文本切块、向量化，按语义相似度取回片段后放入模型上下文 | 中高 | 适合“为什么”“怎么做”“某场景相关资料”等自然语言问题 | 对短命令、相近命令、数字和版本不够稳定；OCR 会污染向量 |
| **结构化文档编译/符号索引** | 解析 Markdown AST，抽取命令、选项、模式、版本、示例、限制及关系，存入可查询数据库 | **很高** | 精确回答“这个命令有什么选项、在哪个版本、适用于什么 stage/mode” | 初次建设需要定义数据模型和抽取规则；必须保留人工校验机制 |
| **Agent Skills / Topic Packs** | 把某类任务的操作流程、检索策略和判断规则写成按需加载的技能文件 | **很高** | 不必每次加载全部知识；可教会 OMP 何时查文档和如何核验 | 不是事实数据库；技能过多或触发描述不准会误触发/漏触发 |
| 专用 Task 子代理 | 将“查资料、比较版本、输出证据”委托给独立上下文的研究 Agent | 高 | 避免主编码上下文被大量检索片段污染；职责清晰 | 仍需可靠知识工具；多一次 Agent 调用有额外延迟和 token 消耗 |
| Hooks 动态上下文注入 | 在用户提交提示、会话启动、工具调用前后执行脚本，注入分支、版本、路径等上下文 | 中高 | 可以确定性提供“当前项目实际版本/分支”，减少模型猜测 | 不适合注入大量文档；错误 hook 会对每次请求增加噪声 |
| `AGENTS.md` / `RULES.md` / 路径规则 | 在用户或项目的原生 `.omp/` 目录中提供持久上下文、粘性约束和按需规则 | 中高 | 适合放简短项目约束、版本入口和“必须查文档”的规则 | 不是 100 MB 知识库；长文件持续占上下文并降低遵循度 |
| MCP 文档服务 | 把查询、读取章节、查命令等能力作为工具提供给 OMP | 很高 | 将知识库与代码仓解耦；可统一权限、版本和升级 | MCP 只是接入协议，后端检索质量仍要自行建设 |
| 代码静态分析/仓库语义图 | 用 Tree-sitter、ctags、LSP、调用图等解析代码结构，再把文档术语映射到源码符号 | 高，适合作为第二阶段 | 解决“文档知道概念，但不知道代码实现在哪里” | 多语言、动态 Tcl/Python、生成代码会增加解析难度 |
| 自定义 DFT DSL LSP/校验器 | 将配置命令和合法组合做成语法、补全、hover、诊断或 lint 规则 | 高，但建设成本较高 | 把文档变成可执行约束；能直接发现非法选项和版本组合 | 只覆盖结构明确的命令/config，不能替代概念资料和流程说明 |
| 知识图谱/GraphRAG | 将实体和关系构造成图，再结合图遍历或社区摘要回答跨文档问题 | 中，后续可选 | 适合工具—版本—模式—步骤—输入输出的复杂关联分析 | OCR 和关系抽取错误会扩散；图构建和更新成本高；不宜作为首期核心 |
| 案例推理/经验库 | 以历史问题、根因、最小修复和验证结果为案例，根据当前问题找相似案例 | 高，前提是有优质历史案例 | 对 debug、错误定位和回归问题价值高 | 需要整理问题单、日志和最终修复，当前仅 Markdown 文档可能覆盖不足 |
| 自动代码考古与“活文档” | 从源码、测试、提交历史和调用关系生成仓库地图、模块说明和接口卡片 | 中高 | 代码仓无文档时可快速补充局部上下文 | 自动生成内容是推断，不应冒充正式业务规范；需要持续更新 |
| 领域微调/持续预训练 | 用内部语料调整模型参数，使模型熟悉术语、表达和常见任务 | 低到中，不建议首期 | 可提高内部术语理解、分类和生成风格 | 文档更新后模型不会自动更新；难以引用来源；训练、评测和安全成本高；不能保证精确命令正确 |
| 超长上下文/Prompt Cache | 将大量文档直接放进上下文，并通过缓存降低重复输入成本 | 低 | 实现简单，适合少量稳定资料 | 100 MB 远超合理工作集；噪声、冲突、检索位置偏差和成本问题明显 |

### 3.2 除 grep 和 RAG 外，最值得关注的技术

#### 3.2.1 结构化文档编译

它不是“搜索包含某个词的段落”，而是把 Markdown 编译为以下实体：

```text
Command        define_mbist_info
Option         -mode
Value          sub | top | top_repair | ...
AppliesTo      MBIST
Stage          DFT | PR | POST | VECTOR
ToolVersion    Lander x / Sailor y / Hibist z
Example        原始 Tcl 代码块
Constraint     版本兼容、必选/可选、合法组合
Source         文件、标题路径、日期、资料等级
```

OMP 可以直接调用：

```text
lookup_symbol("define_mbist_info")
get_command_schema("define_sim_info")
get_examples(symbol="top_repair", stage="POST")
get_constraints(symbol="define_test_setup", tool_version="...")
report_conflicts(symbol="define_incomming_info")
```

这比单纯向量相似度更适合内部 EDA/DFT DSL。

#### 3.2.2 Agent Skills / Topic Packs

Skill 不是把所有材料再复制一遍，而是为某类任务写一份短小的“专家操作规程”。例如：

- `lander-config`：修改 Lander cfg 前要查哪些命令、版本和示例。
- `mbist-debug`：遇到 `top_repair`、`mrb_trace`、`only_rcr_test` 时的资料查询和验证顺序。
- `atpg-debug`：按 mode、fault type、stage、group、tc 组织检索。
- `ijtag-integration`：先查 ICL/PDL、SIB/TDR 结构和工具版本。
- `dft-doc-evidence`：如何区分正式手册、实现说明、培训、OCR/ASR 转写。

OMP 只在相关任务出现时通过 `skill://<name>` 读取完整 Skill，因此能减少常驻上下文噪声。

#### 3.2.3 文档—代码符号映射

由于代码仓库没有文档，单纯查到“`define_sim_info` 的资料”还不够，Agent 还需要知道：

```text
文档符号 define_sim_info
      │
      ├── 定义位置：parser/config/...
      ├── 参数校验：...
      ├── 调用位置：gen_sim_env/...
      ├── 测试位置：tests/...
      └── 历史实现：...
```

可通过 Tree-sitter、ctags、LSP、静态调用分析和精确字符串引用建立仓库地图。对动态 Python/Tcl 代码，应允许“已确认映射”和“启发式推断”分别标记。

#### 3.2.4 可执行知识：DSL Schema、Linter 和 LSP

若大量开发工作围绕 `define_*` 配置命令，可以把文档中的命令规格转换为 JSON/YAML Schema 或内部 DSL 模型，再开发：

- 参数补全；
- 参数类型、枚举和必选项检查；
- stage/mode/version 合法组合检查；
- hover 显示内部说明和来源；
- 直接跳转到实现或文档章节。

这类工具能够在 OMP 生成配置后立即验证，比“让模型记住所有规则”可靠。但它适合在结构化索引稳定后建设，不建议作为第一步。

#### 3.2.5 知识图谱/GraphRAG

DFT 流程确实存在复杂关系：

```text
Tool → Version → Command → Mode → Stage → Step → Input → Output → Check
```

因此知识图谱有潜力。不过首期不建议直接做 GraphRAG，原因是：

1. OCR/ASR 数据会产生错误实体和错误边；
2. 很多关系可以先用结构化表表达，不必先引入图数据库；
3. 需要先建立可靠术语表、版本元数据和来源可信度；
4. 图谱效果评估比精确符号查询更复杂。

建议把结构化数据库设计为未来可导出成图，而不是首期直接以图为中心。

#### 3.2.6 微调/领域继续预训练

微调能够让模型更熟悉内部术语，但不适合作为文档查询主方案：

- 不能自然给出原始出处；
- 版本更新后容易陈旧；
- 精确命令、枚举和路径仍可能生成错误；
- 训练语料中的 OCR 错误会被学习；
- 需要单独解决内网数据合规、训练基础设施和模型评测。

后续若使用内网本地模型做“查询分类、术语归一、问题改写”，可考虑小规模微调；不建议让微调模型直接替代知识服务。

---

## 4. 评估标准

建议用以下维度评估技术，而不是只看“回答看起来是否聪明”：

| 维度 | 说明 |
|---|---|
| 精确性 | 命令、选项、枚举值、版本、路径和流程步骤是否准确 |
| 召回能力 | 用户不用精确术语时，是否仍能找到正确资料 |
| 可追溯性 | 是否能返回文件、标题路径、日期、版本和原文片段 |
| 冲突处理 | 多版本、多来源冲突时是否并列展示而非自动融合 |
| OCR/ASR 鲁棒性 | 能否通过别名召回，同时保留原始文本不被篡改 |
| 更新成本 | 新增或修改 Markdown 后能否增量更新 |
| 接入成本 | 是否需要修改每个代码仓、每台机器或现有 EDA 环境 |
| 运维能力 | 是否支持统一版本、权限、增量更新、回滚和查询审计 |
| Agent 触发质量 | OMP 是否在该查时查、不该查时不查 |
| 代码闭环 | 检索结果能否指导源码定位、修改、测试和验证 |
| 安全性 | 内部资料是否越权暴露；文档是否可能形成 prompt injection |
| 性能 | 首次查询延迟、并发、索引大小、上下文和 token 开销 |

---

## 5. 推荐技术一：结构化 DFT 文档知识服务 + MCP

### 5.1 原理

将 Markdown 处理为三层数据，而不是只有一个向量库：

```text
A. 原始证据层
   raw_markdown / raw_section / raw_code_block

B. 检索层
   标题路径、全文倒排、别名、可选向量

C. 结构化知识层
   command / option / value / mode / stage / version /
   example / constraint / error / input / output / relation
```

再通过 MCP（Model Context Protocol）向 OMP 暴露只读工具。MCP 是 Agent 与外部工具、数据库和 API 之间的标准接口；它不是检索算法，因此内部可以同时使用精确查询、全文查询、结构化查询和可选向量检索。

#### 5.1.1 推荐工具接口

首期建议只提供少量高价值、只读接口：

```text
search_docs
  输入：query、domain、source_type、tool_version、stage、mode、limit
  输出：候选章节、得分、来源、标题路径、资料等级

lookup_symbol
  输入：精确命令/选项/术语
  输出：定义、别名、所属工具、相关章节、冲突数量

get_command_schema
  输入：command、可选 tool_version
  输出：options、类型、可选值、必选性、约束和证据来源

get_examples
  输入：symbol、stage、mode、source_quality
  输出：保留原文的 Tcl/Shell/JSON 示例及来源

get_constraints
  输入：symbol、tool/version/stage/mode
  输出：版本兼容、限制、前置条件和检查项

read_section
  输入：section_id、view=raw|normalized
  输出：完整章节；默认优先 raw

report_conflicts
  输入：symbol 或 topic
  输出：不同文档、版本或日期间的差异，不自动裁决

find_code_refs（第二阶段）
  输入：symbol、repo_root
  输出：源码定义、引用、测试和置信度
```

#### 5.1.2 为什么适合本项目

1. **内部命令高度结构化。** 资料中已有大量命令表、选项表、示例和合法性说明，适合抽取为符号数据库。
2. **版本敏感。** 可以把版本作为一等字段进行过滤，而不是把版本号当普通文本。
3. **资料混杂。** 可以给来源设置可信等级，使正式手册和实现说明优先于培训转写。
4. **代码仓无文档。** 知识服务集中部署，无需在每个仓库复制整个语料库。
5. **便于扩展。** 后续可以加入代码引用、问题单、测试结果和 LSP，而不改变 OMP 的调用方式。

### 5.2 数据准备

#### 5.2.1 原始文本与规范化文本双轨保存

数据库必须同时保存：

```text
raw_text         原始 Markdown 文本，永不自动覆盖
normalized_text  只用于检索的规范化副本
```

规范化动作只能用于召回，例如：

```text
C0RE1  → 搜索别名 CORE1
PoST   → 搜索别名 POST
```

但结果展示和代码生成必须回到 `raw_text`，并结合可靠来源确认。对于代码块、反引号内容、路径、文件名、信号名和参数，默认禁止自动改写。

#### 5.2.2 按 Markdown 结构切分

不要采用单纯的固定 token 切块。推荐规则：

1. 解析 Markdown AST；
2. 以标题路径为主边界；
3. 表格、代码块、列表和紧邻说明保持完整；
4. 超长章节再按语义段落拆分；
5. 每个子块继承完整标题路径和文档元数据；
6. 相同代码示例与解释建立父子关系。

示例元数据：

```yaml
section_id: Lander交流.md#...#子模块后仿（三）
document: Lander交流.md
heading_path:
  - Lander2023年现场交流会
  - 子模块后仿（三）
source_type: training
source_date: 2023-12-11
domain: MBIST
tool_versions:
  - lander/...
  - sailor/...
content_kinds:
  - explanation
  - tcl_example
ocr_or_asr: false
quality_grade: B
```

#### 5.2.3 建立公司术语表和别名表

建议由领域专家维护以下表：

| 字段 | 示例 |
|---|---|
| canonical_name | `top_repair` |
| aliases | 中文称呼、历史称呼、OCR 变体 |
| entity_type | mode / command / option / tool / file / testcase |
| domain | MBIST / ATPG / IJTAG / Lander |
| valid_versions | 适用版本范围或未知 |
| notes | 不允许自动纠正、易与其他词混淆等 |

别名只影响查询扩展，不修改证据原文。

#### 5.2.4 来源可信度分级

建议至少分为：

| 等级 | 来源 | 使用策略 |
|---|---|---|
| A | 对应版本正式用户手册、正式规格、已发布实现说明 | 可用于命令和约束的主要依据 |
| B | 测试设计、评审通过的技术方案、维护者说明 | 可补充实现和场景信息 |
| C | 培训材料、交流会、经验总结 | 适合解释和案例，命令需与 A/B 级交叉验证 |
| D | OCR、音视频转写、未评审会议记录 | 仅作线索；不得单独作为高风险修改依据 |

#### 5.2.5 版本与冲突模型

每条结构化事实至少带：

```text
source_id
source_date
source_type
tool_name
tool_version
valid_from / valid_to（若能确认）
confidence
review_status
```

当同一命令存在不同定义时，不覆盖旧记录，而是返回冲突集合：

```text
事实 A：来源、版本、原文
事实 B：来源、版本、原文
当前项目版本：由仓库配置或 hook 注入
系统判断：可过滤 / 仍需人工确认
```

### 5.3 所需软件

#### 5.3.1 MVP 软件栈

| 组件 | 推荐选项 | 用途 |
|---|---|---|
| 独立运行环境 | 内网 Linux 服务器或隔离容器 | 不污染 CentOS 7 EDA 运行环境 |
| 开发语言 | Python 3.10/3.11；也可用 Go/Rust 单二进制 | Markdown 解析、索引构建、MCP 服务 |
| Markdown 解析 | `markdown-it-py`、`mistune` 等支持 AST 的解析器 | 按标题、表格和代码块切分 |
| 结构化数据库 | SQLite；中央并发较高时可换 PostgreSQL | 保存文档、章节、符号和关系 |
| 全文检索 | SQLite FTS5、Tantivy、OpenSearch/Elasticsearch 中任选其一 | 标题和正文倒排检索 |
| MCP SDK | 官方 Python 或 TypeScript MCP SDK，按部署的 OMP 版本固定兼容版本 | 向 OMP 提供工具 |
| 可选向量层 | 内网 embedding 模型 + FAISS/Qdrant 等 | 补充自然语言语义召回 |
| 可选代码解析 | Tree-sitter、ctags、已有 LSP | 第二阶段建立代码映射 |
| 版本管理 | 内部 Git/GitLab | 管理抽取规则、术语表、插件和索引版本 |

#### 5.3.2 与现有项目环境的隔离

项目现有 Python 3.6.4、Tcl 8.4 和旧版 EDA 工具应保持不变。知识服务应独立部署：

```text
EDA 项目 shell / Python 3.6        不修改
          │
          └── OMP 调用 MCP
                    │
                    └── 独立 Python/Go/Rust 知识服务
```

如果必须在 CentOS 7 本机运行，需要先验证：

- Python/Node/二进制与系统 glibc 的兼容性；
- SQLite 是否编译了 FTS5；
- 当前 OMP 版本支持的 MCP 传输和配置格式；
- 内网代理、证书和权限。

SQLite FTS5 可用性可用以下只读命令检查：

```bash
python - <<'PY'
import sqlite3
conn = sqlite3.connect(':memory:')
print('sqlite:', sqlite3.sqlite_version)
print([row[0] for row in conn.execute('pragma compile_options')
       if 'FTS5' in row[0]])
PY
```

若输出没有 `ENABLE_FTS5`，应使用自带 FTS5 的独立运行环境或改用其他全文检索引擎，不要替换系统 SQLite 影响 EDA 工具。

### 5.4 建设步骤

### 阶段 A：数据审计

1. 生成文档清单：文件、大小、来源、日期、所属领域、是否 OCR/ASR。
2. 识别重复文档和版本关系。
3. 收集高频命令、模式、stage、testcase 和工具版本。
4. 建立首版内部术语表。
5. 准备真实开发问题评测集，例如 50～100 个：
   - 查命令/选项；
   - 查版本限制；
   - 根据报错定位资料；
   - 修改 cfg；
   - 定位实现代码；
   - 比较两个文档冲突。

### 阶段 B：文档编译和精确索引

1. 解析 Markdown AST；
2. 生成章节 ID 和标题路径；
3. 保存 raw/normalized 双文本；
4. 建立全文索引；
5. 用规则抽取 `define_*` 命令、前导 `-option`、代码块和表格；
6. 人工审核高频和高风险符号；
7. 建立来源等级和版本字段。

首期先不做 embedding，也能够提供高价值服务。

### 阶段 C：MCP 只读服务

实现并测试：

```text
search_docs
lookup_symbol
get_command_schema
get_examples
get_constraints
read_section
report_conflicts
```

每个返回结果都必须包含来源和章节，不允许只返回模型生成摘要。

### 阶段 D：可选增强

1. 加入向量检索，只处理自然语言问题；
2. 加入文档—代码符号映射；
3. 加入历史问题单和修复案例；
4. 将结构化规格输出给 DFT cfg linter/LSP；
5. 在使用量和关系复杂度证明有价值后，再评估知识图谱。

### 5.5 接入 Oh My Pi

#### 5.5.1 本机试点：stdio MCP

执行环境：安装了 `omp` 的开发机。可在 OMP TUI 中运行 `/mcp add`，选择用户级作用域并填写 stdio 命令；也可直接创建 `~/.omp/agent/mcp.json`：

```json
{
  "$schema": "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json",
  "mcpServers": {
    "dft-docs": {
      "type": "stdio",
      "command": "/opt/dft-ai/runtime/bin/python",
      "args": [
        "/opt/dft-ai/dft_doc_mcp/server.py",
        "--config",
        "/opt/dft-ai/config.toml"
      ]
    }
  }
}
```

用途：

- 用户级 `~/.omp/agent/mcp.json`：同一 OMP profile 的多个代码仓都可使用；
- 命名 profile：配置位于 `~/.omp/profiles/<name>/agent/mcp.json`，与默认 profile 隔离；
- `stdio`：由 OMP 在本机启动知识服务进程。

保存后在 OMP 中验证：

```text
/mcp reload
/mcp list
/mcp test dft-docs
```

`/mcp list` 应显示服务器来源，`/mcp test dft-docs` 必须成功连接；实际状态文字以部署的 OMP 版本为准。

#### 5.5.2 团队部署：内网 HTTP MCP

中央知识库更适合使用内网 HTTP 服务，避免每台机器重复构建索引。管理员可通过 OMP 插件统一下发，也可在用户级 `mcp.json` 中配置：

```json
{
  "$schema": "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json",
  "mcpServers": {
    "dft-docs": {
      "type": "http",
      "url": "https://<internal-host>/mcp"
    }
  }
}
```

服务端必须实施：

- 用户/团队鉴权；
- 文档域权限；
- 查询审计；
- 只读工具白名单；
- 返回内容长度限制；
- 索引版本和更新时间暴露；
- Prompt injection 防护。

#### 5.5.3 项目级 `.omp/mcp.json`

如希望某个仓库固定接入，可在项目根目录提交 `.omp/mcp.json`：

```json
{
  "$schema": "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json",
  "mcpServers": {
    "dft-docs": {
      "type": "http",
      "url": "${DFT_DOC_MCP_URL}"
    }
  }
}
```

项目级 MCP 定义对所有 profile 生效，但 OAuth 凭据仍按 profile 隔离。由于 `stdio` 条目可以执行任意命令、远程条目可能使用当前 profile 的凭据，加载前应校验仓库中的 MCP 配置。对于大量仓库，更适合使用用户级配置或插件统一下发，避免逐仓维护。

### 5.6 验证方法

对每个评测问题记录：

1. 是否调用了正确的 MCP 工具；
2. Top-3 是否包含正确章节；
3. 精确命令是否原样返回；
4. 是否按当前工具版本过滤；
5. 是否显示冲突来源；
6. OMP 最终修改是否通过已有测试/静态检查；
7. 是否出现没有资料支持的命令或参数。

建议重点监控“虚构内部命令率”和“引用错误版本率”，它们比回答流畅度更重要。

---

## 6. 推荐技术二：Agent Skills + DFT 专用 Task 子代理 + 团队插件

### 6.1 原理

知识服务能回答问题，但主 Agent 未必会在正确时机调用。第二项技术解决的是“Agent 行为编排”：

```text
用户要求修改代码
      │
      ▼
Skill 判断：是否涉及内部 DFT 概念/命令/版本？
      │ 是
      ▼
通过 task 委托 dft-doc-researcher 子代理
      │
      ├── 读取当前仓库信息、相关代码和版本
      ├── 调用 MCP 查询精确符号、章节和约束
      ├── 比较来源与冲突
      └── 输出紧凑的证据包
      │
      ▼
主 Agent 基于证据修改代码
      │
      ▼
运行项目已有测试、lint 或最小验证
```

OMP 原生支持用户/项目级上下文文件、Skills、Rules、Task 子代理、Hooks、扩展、Marketplace 和 MCP。Skill 的 `name` 与 `description` 以轻量元数据进入系统提示，完整内容由模型通过 `skill://<name>` 按需读取；Task 子代理拥有独立会话上下文，适合把文档研究与编码隔离。插件可统一携带 skills、agents、rules、hooks、tools 和 MCP 配置。

### 6.2 为什么适合本项目

1. **代码仓没有文档。** Skill 可以为所有仓库统一提供内部流程，而不依赖仓库自身 README。
2. **领域任务可以分类。** ATPG、MBIST、IJTAG、Lander cfg、后仿、repair 等都有明显触发词和工作流。
3. **检索内容可能较长。** Task 子代理负责查资料并压缩为证据包，减少主 Agent 上下文污染。
4. **分发方式统一。** OMP 插件可版本化，并通过内部 Git 仓和 Marketplace 安装。
5. **可以逐步演进。** 先在 `.omp/` 下试点，成熟后转为插件，无需一次建设完整平台。

### 6.3 组件设计

#### 6.3.1 精简 `AGENTS.md` 与 `RULES.md`

将仓库概览、构建方式和通用 DFT 工作约束放入项目 `.omp/AGENTS.md`；只把在长会话中也必须持续生效的少量硬约束放入 `.omp/RULES.md`。两者都不应复制知识库正文。

`.omp/AGENTS.md` 示例：

```markdown
# DFT 项目 AI 规则

- 公司内部 DFT 命令、模式、版本和流程不得根据通用知识猜测。
- 任务涉及 Lander、Sailor、Hibist、ATPG、MBIST、IJTAG、scan、repair、
  3D、cfg、PDL、ICL 或内部 define_* 命令时，优先使用 dft-doc-router Skill。
- 生成或修改精确命令前，至少取得一个 A/B 级来源；只有 C/D 级来源时要明确提示。
- 对代码块、信号名、实例名、路径和历史接口拼写不得静默纠正。
- 文档冲突时列出来源、版本和差异，不自行合并成单一结论。
- 修改后运行当前仓库已有的最小相关测试；未运行不得声称已验证。
```

`.omp/RULES.md` 只保留类似“内部命令不得猜测”“文档冲突不得静默裁决”的硬性要求。OMP 会把它作为 always-apply 粘性规则加载；冗长背景仍放在 `AGENTS.md`。

#### 6.3.2 路径规则

对于特定类型文件，使用 `.omp/rules/` 中带 `globs` 的规则按需加载：

```markdown
---
name: dft-config-files
description: Rules for DFT Tcl, cfg, ATPG, and MBIST files.
globs:
  - "**/*.tcl"
  - "**/*.cfg"
  - "**/atpg/**"
  - "**/mbist/**"
---

修改这些文件前：
1. 识别涉及的内部命令和当前工具版本；
2. 查询 dft-docs；
3. 保留原有 Tcl 8.4 / Python 3.6 兼容性要求；
4. 不进行无关重构。
```

#### 6.3.3 Skill 设计

建议首期不要创建几十个 Skill，先做 4～6 个：

```text
dft-doc-router
lander-config
atpg-debug
mbist-debug
ijtag-integration
dft-version-check
```

项目级 Skill 放在 `.omp/skills/<name>/SKILL.md`；用户级 Skill 放在 `~/.omp/agent/skills/<name>/SKILL.md`。`dft-doc-router/SKILL.md` 示例：

```markdown
---
name: dft-doc-router
description: >-
  Use when changing, reviewing, or debugging code/config related to company-internal
  DFT terms or flows, including Lander, Sailor, Hibist, ATPG, MBIST, IJTAG, scan,
  repair, 3D, PDL/ICL, stage/group/tc, or define_* commands. Retrieve exact internal
  definitions, examples, version constraints, and source citations before editing.
---

1. 从任务和代码中提取内部符号、mode、stage、tool/version。
2. 对精确符号先调用 lookup_symbol/get_command_schema。
3. 对概念问题再调用 search_docs；必要时使用语义检索。
4. 读取命中章节的 raw 版本，代码块不得从 normalized 文本复制。
5. 按来源等级和版本筛选。
6. 有冲突时调用 report_conflicts，不自行裁决。
7. 输出一个证据包：结论、来源、适用版本、待确认项、对代码的影响。
8. 主 Agent 修改后运行现有测试或最小静态检查。
```

OMP 的 Skill frontmatter 不承担工具权限控制。MCP 工具由当前会话的工具集合提供；部署后应通过 `/mcp list` 和 `/mcp test dft-docs` 验证服务器，并确认模型可见的实际工具名。工程师也可用 `/skill:dft-doc-router` 显式触发。

#### 6.3.4 DFT 文档研究 Task 子代理

文件示例：`.omp/agents/dft-doc-researcher.md`

```markdown
---
name: dft-doc-researcher
description: >-
  Researches company-internal DFT documentation and returns versioned, cited evidence
  before code or configuration changes.
model: "@review"
tools:
  - read
  - grep
  - glob
autoloadSkills:
  - dft-doc-router
---

你是只读的 DFT 文档研究 Agent。

必须完成：
1. 读取当前任务相关代码，但不修改文件。
2. 确认项目可见的工具版本；无法确认则标记未知。
3. 调用 dft-docs MCP 做精确符号、全文和冲突查询。
4. 优先 A/B 级来源；C/D 级只能作为线索。
5. 输出已确认事实、适用版本/场景、原始来源和章节、文档冲突、
   对实现的直接要求，以及仍需代码或运行结果验证的事项。
6. 不根据行业通用知识补造公司内部接口。
```

上例中的 `tools` 只是基础只读工具。部署时必须把 OMP 实际暴露的 dft-docs MCP 只读工具名加入白名单，否则子代理无法查询知识服务；不得加入 `write`、`edit`、`bash` 等写入或执行工具。`model: "@review"` 可通过 `modelRoles.review` 映射到指定模型。

#### 6.3.5 Hooks 与扩展

Hooks 不用来塞文档，而用于确定性注入小量运行上下文，例如：

- 当前 Git 分支、tag、仓库根目录；
- `project.cshrc` 或工具清单中解析到的 Lander/Sailor/Hibist 版本；
- 当前修改文件所属领域；
- 知识索引版本和更新时间。

OMP 的 Hook 是通过扩展运行时加载的 TS/JS 工厂。可在 `session_start` 做一次只读探测并缓存结果，再在 `before_agent_start` 返回一条自定义消息，或在 `context` 事件中追加短小上下文。Hook 必须遵循 OMP 的事件与返回值契约。

注意：

- hook 脚本只能做只读探测；
- 解析失败时返回“未知”，不能猜版本；
- 不应把整篇 Markdown 注入每次提示；
- 版本探测规则需针对仓库实际配置测试；
- 工具调用拦截器必须 fail-closed，且不得把文档内容当可执行指令。

### 6.4 团队插件结构

建议成熟后封装为 OMP 插件包：

```text
dft-ai-plugin/
├── package.json
├── skills/
│   ├── dft-doc-router/SKILL.md
│   ├── lander-config/SKILL.md
│   ├── atpg-debug/SKILL.md
│   ├── mbist-debug/SKILL.md
│   ├── ijtag-integration/SKILL.md
│   └── dft-version-check/SKILL.md
├── agents/
│   └── dft-doc-researcher.md
├── rules/
│   └── dft-config-files.md
├── hooks/
│   └── detect-dft-context.ts
├── .mcp.json
├── config/
│   └── defaults.json
└── README.md
```

`package.json` 的 `omp.extensions` 声明 Hook 扩展入口；OMP 插件能力发现会扫描同包的 `skills/`、`agents/`、`rules/`、`hooks/` 和 `.mcp.json`。`.mcp.json` 可以指向中央内网服务：

```json
{
  "mcpServers": {
    "dft-docs": {
      "type": "http",
      "url": "${DFT_DOC_MCP_URL}"
    }
  }
}
```

或启动随插件分发的本地二进制：

```json
{
  "mcpServers": {
    "dft-docs": {
      "command": "${OMP_DFT_PLUGIN_ROOT}/bin/dft-doc-mcp",
      "args": ["--config", "${OMP_DFT_PLUGIN_ROOT}/config/defaults.json"]
    }
  }
}
```

这里的 `OMP_DFT_PLUGIN_ROOT` 是团队安装流程显式设置的环境变量，不是 OMP 内置变量。中央服务更适合统一更新和权限控制；本地二进制适合完全离线或试点。

### 6.5 所需软件和准备

| 项目 | 内容 |
|---|---|
| Oh My Pi | 固定部署版本，验证 Skills、Task 子代理、Rules、Hooks、插件、Marketplace 和 MCP 行为 |
| 内部 Git/GitLab | 存储插件、Marketplace catalog、抽取规则和索引版本 |
| 插件仓 | 包含 skills、agents、rules、hooks、MCP 配置和版本元数据 |
| 评测仓 | 保存脱敏后的触发/不触发案例、查询用例和预期证据 |
| 版本探测脚本 | 只读解析每个仓库中可确认的工具配置 |
| 安全配置 | MCP 地址、证书、用户身份、允许工具列表和审计策略 |

### 6.6 接入 Oh My Pi

#### 6.6.1 试点阶段

先在一个试点仓库使用原生 `.omp/` 配置：

```text
repo/
└── .omp/
    ├── AGENTS.md
    ├── RULES.md
    ├── mcp.json
    ├── rules/
    ├── skills/
    └── agents/
```

验证技能触发率、误触发率、Task 子代理输出和 MCP 检索质量后再封装插件。

#### 6.6.2 插件分发

建立内部 OMP Marketplace，catalog 放在内部 GitLab 仓库的 `.omp-plugin/marketplace.json`。安装形式示例：

```text
/marketplace add <internal-marketplace-repository>
/marketplace install --scope user dft-ai@<internal-marketplace-name>
/reload-plugins
```

命令行等价形式：

```bash
omp plugin marketplace add <internal-marketplace-repository>
omp plugin install --scope user dft-ai@<internal-marketplace-name>
```

Marketplace 与插件使用固定 tag/commit。`/reload-plugins` 可刷新 Skills、斜杠命令和 MCP；新安装的 tools、hooks 或扩展模块需要重启会话。

#### 6.6.3 旧 EDA 环境兼容性说明

OMP 是独立的 Agent 运行时，不要求替换团队现有 VS Code。若旧 CentOS 7 EDA 主机无法直接运行 OMP 二进制，可在兼容开发机或隔离容器中运行 OMP，通过内网 HTTP MCP 访问知识服务，并仅同步代码与配置；不得为安装 OMP 替换系统 Python、Node、glibc 或 SQLite。

---

## 7. 两项推荐技术的组合工作流

### 7.1 用户请求示例

```text
“修改 top_repair 的 gen_run_env 逻辑，支持某个新的 testcase，
同时保持旧版本行为不变。”
```

### 7.2 Agent 应执行的流程

1. **识别任务类型**
   - Skill 检出 `top_repair`、`gen_run_env`、testcase，判定为内部 MBIST/Lander 任务。

2. **确认代码和版本上下文**
   - 读取相关源码、测试和项目工具配置；
   - hook 提供当前分支及可确认版本，未知字段保持未知。

3. **委托文档研究**
   - Task 子代理调用：

```text
lookup_symbol("top_repair")
lookup_symbol("gen_run_env")
get_examples(symbol="top_repair")
get_constraints(symbol="gen_run_env", tool_version=<current>)
report_conflicts(topic="top_repair testcase")
```

4. **生成证据包**

```text
已确认：当前模式的流程步骤、输入输出和已有 testcase
来源：文件 + 标题路径 + 日期/版本
冲突：旧培训材料与新实现说明的差异
未知：当前分支是否已包含某特性
实现要求：需要修改哪些代码路径和测试
```

5. **主 Agent 修改代码**
   - 只做与目标相关的最小修改；
   - 不从 OCR 规范化文本直接复制命令。

6. **验证**
   - 运行现有单元测试、静态检查或最小 dry-run；
   - 没有环境时，明确标注“仅完成代码修改，未运行 EDA 流程验证”。

7. **输出结果**
   - 列出变更、验证、引用的内部资料和仍需人工确认的版本问题。

---

## 8. OCR/ASR 专项处理方案

### 8.1 处理原则

```text
原始证据不可改
       │
       ├── 规范化副本：用于召回
       ├── 别名表：用于查询扩展
       ├── 置信度：用于排序和提示
       └── 人工校对：用于高风险结构化事实
```

#### 8.1.1 禁止自动改写的区域

默认禁止对以下内容做自动纠错：

- fenced code block；
- inline code；
- 命令和选项；
- 文件名、路径、URL；
- Verilog/Tcl/Python 标识符；
- instance、pin、port、signal；
- 日志字段和报错原文；
- 版本号和工单号。

#### 8.1.2 可以做查询扩展的区域

自然语言正文和标题可以：

- 全半角和空白规范化；
- 常见 OCR 字符混淆生成别名；
- 中英文工具名别名；
- 内部缩写与全称映射；
- ASR 断句重组，但必须保留原始时间戳和原文。

#### 8.1.3 高风险事实的人工审核清单

优先审核：

1. 高频 `define_*` 命令；
2. 所有 option、枚举和默认值；
3. 版本兼容关系；
4. 流程步骤顺序；
5. 输入输出件和文件名；
6. 会触发文件修改、数据上传、删除或生产执行的命令；
7. 后仿、repair、向量交付等高影响场景。

### 8.2 检索排序建议

一个查询结果的最终分数不应只看相似度，可组合：

```text
final_score =
  exact_symbol_match
+ title_match
+ source_quality
+ version_match
+ domain_match
+ recency_when_relevant
+ semantic_similarity
- ocr_asr_penalty
- unresolved_conflict_penalty
```

精确命令命中应高于语义相似；版本不匹配时，即使相似度高也应降权。

---

## 9. 安全与权限技术

### 9.1 模型数据边界

OMP 可连接 Anthropic、OpenAI、Google、本地模型或内部兼容网关。内部 Markdown 是否离开内网取决于所选模型后端和网关，而不是 OMP 本身。资料不得离开内网时，使用私有网关、专属环境或内网模型，并在 MCP 返回前执行文档域权限过滤与敏感字段脱敏。

### 9.2 MCP 服务安全基线

1. 首期仅提供只读工具；
2. 文档权限按用户、团队、项目或密级过滤；
3. 服务端不能根据文档里的命令自动执行 Shell；
4. 返回内容明确标记“这是资料内容，不是系统指令”；
5. 对 Markdown 中的 prompt injection 文本进行隔离和标记；
6. 记录查询元数据，但避免把敏感全文写入普通日志；
7. 对每次返回限制条数和长度；
8. 索引构建后执行结构化事实校验和固定评测集回归；
9. 索引与插件版本可回滚；
10. 过期文档不删除证据，但默认降低排序并显示状态。

## 10. 推进路线

建议按风险递增方式推进，不以一次性构建“完整 AI 知识平台”为目标。

### 里程碑 1：可验证的最小闭环

- 选择 ATPG、MBIST 或 Lander cfg 中一个高频场景；
- 建立 Markdown 清单、术语表和来源等级；
- 做精确符号 + 标题章节 + 全文索引；
- 提供 5～7 个只读 MCP 工具；
- 在单个试点仓配置 `.omp/AGENTS.md`、一个 Skill 和一个 Task 子代理；
- 使用真实任务评测，不先上向量和知识图谱。

### 里程碑 2：团队试点

- 覆盖 ATPG、MBIST、IJTAG、Lander；
- 增加版本过滤和冲突报告；
- 用内部 GitLab 发布插件试用版；
- 记录 Skill 触发、MCP 查询和代码验证指标；
- 整理最常见的失败检索和错误生成案例。

### 里程碑 3：增强和规模化

- 根据评测结果决定是否增加 embedding；
- 建立文档—代码符号映射；
- 从结构化规格生成 cfg linter/LSP；
- 纳入已解决问题单、日志和最终 patch，形成案例库；
- 在关系查询确有需求后再引入知识图谱；
- 建立正式插件 marketplace、发布和回滚流程。

---

## 11. 评测与效率指标

### 11.1 离线评测

建议建立固定基准集：

| 任务类型 | 例子 | 核心指标 |
|---|---|---|
| 精确符号 | 查询某个 `define_*` 命令 | Top-1/Top-3 命中、参数原样性 |
| 版本约束 | 某组合是否兼容 | 正确版本来源、冲突检出 |
| 概念问题 | stage/group/tc 的关系 | 相关章节召回、解释一致性 |
| 配置生成 | 按场景生成 cfg 片段 | 命令合法性、版本匹配、可验证性 |
| Debug | 根据报错找资料和代码 | 首个有效线索位置、根因准确率 |
| 文档冲突 | 两份材料定义不同 | 是否并列证据、是否避免擅自裁决 |
| OCR 噪声 | 输入含错误字符 | 是否通过别名召回、是否保留原文 |
| 代码定位 | 从术语找到实现 | 正确文件/符号命中率 |

### 11.2 在线效率指标

不建议只统计“使用次数”。应同时记录：

- 查找内部资料的平均人工耗时变化；
- 首次代码修改通过 review 的比例；
- 因内部接口理解错误导致的返工数；
- OMP 虚构命令/选项的次数；
- 引用错误版本的次数；
- Skill 应触发而未触发、误触发的比例；
- MCP 查询延迟和失败率；
- 修改后实际测试通过率；
- 工程师对证据可复核性的评价。

所有目标值应先用现状基线测量后设定，不建议在没有数据时承诺固定百分比提升。

### 11.3 已实现内置索引的实测基线

下表记录内置 `docs` FTS 索引在清理后语料上的实测结果。测试语料共 341 个 Markdown 文件、79,548,098 字节和 42,235 个结构化章节；首次建索引用时 8.64 秒，生成的 SQLite 数据库为 128,548,864 字节。FTS 查询只访问本地索引，不再读取位于网络存储上的原 Markdown。

测试环境中的原文件位于本地 WSL 文件系统，因此下列 grep 时间已经接近有利条件；原文件位于网络存储时，逐次 grep 的实际延迟通常更高。查询时间取热查询中位数：

| 查询 | grep | docs FTS | 加速 |
|---|---:|---:|---:|
| `dft_rst_n` | 27.65 ms | 2.20 ms | 12.6× |
| `SailorV600` | 19.69 ms | 0.39 ms | 50.5× |
| `IJTAG` | 29.00 ms | 4.22 ms | 6.9× |
| `OCC` | 26.98 ms | 5.60 ms | 4.8× |
| `MBIST` | 30.44 ms | 5.79 ms | 5.3× |

准确率以“文件是否包含不区分大小写的原文字面量”为 ground truth。精确率表示 Top-50 章节结果涉及的文件中实际包含该字面量的比例；召回率表示这些结果覆盖了全部相关文件的比例：

| 查询 | Top-50 精确率 | 文件召回率 |
|---|---:|---:|
| `dft_rst_n` | 100% | 100% |
| `SailorV600` | 100% | 100% |
| `IJTAG` | 100% | 14.1% |
| `OCC` | 100% | 6.9% |
| `MBIST` | 100% | 9.4% |

结果表明：

1. 对具体、稀有的技术词，FTS 在本基准中同时达到 100% 精确率和文件召回率，并比本地 grep 快 12.6～50.5 倍。
2. 对 `IJTAG`、`OCC`、`MBIST` 等高频宽泛词，Top-50 结果仍全部相关，但章节上限和同一文件的多个高分章节会降低全库文件召回率。此时应缩小查询、增加限定词，或在必须穷举全部出现位置时使用 grep。
3. 该准确率衡量检索结果相对字面量 ground truth 的覆盖，不等同于模型最终回答准确率；文档研究代理仍必须读取命中章节的存储证据并给出路径和行号。
4. 内置索引适合生产中的目标式技术问答和员工知识查询，但不应替代正则搜索、合规审计或全量枚举。默认 FTS 模式不调用模型；只有显式选择结构化模式时才进行模型抽取。

---

## 12. 不推荐作为首期主方案的做法

### 12.1 把 100 MB Markdown 放入 `AGENTS.md`

不合适。`AGENTS.md` 应只放常驻项目背景和工作规则；少量长期硬约束放在 `.omp/RULES.md`。大文件会持续占用上下文并降低规则遵循度，知识正文应通过 MCP 按需检索。

### 12.2 只建一个向量库

不合适。自然语言问题会受益，但精确命令、版本、枚举、路径和相近内部术语容易出错。向量检索应作为混合检索的一层，而不是唯一事实源。

### 12.3 对所有 OCR 文本先自动纠错再入库

风险高。历史接口拼写、路径、信号和代码可能被“纠正”成不存在的名称。必须采用 raw/normalized 双轨和别名扩展。

### 12.4 先做全量知识图谱

投入大、错误传播风险高。应先用结构化表解决 80% 的命令、版本、流程和来源问题，再根据真实查询决定是否图谱化。

### 12.5 先微调模型

不能解决最新文档、来源引用和版本冲突问题，且难以证明精确命令可靠。首期投入产出比低于结构化知识服务和 Skills。

### 12.6 只要求用户手工输入“请查文档”

不能形成团队效率。必须通过 Skill 描述、项目规则和必要的只读 hook，让 Agent 在相关任务中有稳定触发机制，同时保留人工显式调用入口。

---

## 13. 最终建议

### 13.1 技术选择

**第一优先：结构化 DFT 文档知识服务 + MCP。**

- 它解决“事实从哪里来”。
- 首期采用 Markdown AST + 原始/规范化双轨 + SQLite/全文索引 + 命令/选项/版本结构化表。
- 不必先做向量库；自然语言召回不足时再添加。
- 统一部署在内网，向多个代码仓提供只读查询。

**第二优先：Agent Skills + DFT 文档研究 Task 子代理，并封装为 OMP 团队插件。**

- 它解决“什么时候查、怎么查、查完如何用”。
- `.omp/AGENTS.md` 只放常驻项目背景，`.omp/RULES.md` 只放少量粘性硬规则；路径规则按文件加载；Skill 按任务触发；Task 子代理负责资料研究和证据压缩。
- 成熟后通过内部 GitLab OMP Marketplace 统一发布和升级。

### 13.2 推荐落地形态

```text
                         内部 GitLab
                    ┌────────┴────────┐
                    │ DFT AI Plugin   │
                    │ 版本/发布/回滚   │
                    └────────┬────────┘
                             │ 安装
                             ▼
代码仓库 ─────────────── Oh My Pi
  │                          │
  │ 源码/测试/当前配置         ├── Skills / Rules / Hooks
  │                          └── dft-doc-researcher
  │                                      │
  └──────────────────────────────────────┤
                                         ▼
                                  DFT Docs MCP
                                         │
              ┌──────────────────────────┼─────────────────────────┐
              ▼                          ▼                         ▼
        原始 Markdown              结构化符号数据库            全文/可选向量索引
              │                          │                         │
              └────────── 来源、版本、可信度、冲突 ────────────────┘
```

### 13.3 核心判断

本项目真正需要的不是“让模型读过公司文档”，而是：

> 把内部 DFT 文档转化为可追溯、可按版本查询、可被 Agent 主动调用的工程知识工具，并把查询行为固化为团队级 OMP 工作流。

在此基础上，后续的 RAG、代码图谱、LSP、案例库和微调才有可靠的数据基础。

---

## 14. 资料依据与证据边界

### 14.1 项目内部资料

本报告主要依据本项目已提供的 Markdown 集合进行场景分析，包括：

- `IDE.md`：Lander/IDE 管理、版本、Git/OBS、`IDE.json`/`IDE_detail.json` 和交互方案；
- `Lander交流.md`：Lander 平台架构、`STAGE/GROUP/TC`、ATPG/MBIST 验证方法学、配置和版本说明；
- `MBIST.md`：MBIST sub/top/top_repair 流程、工具调用及目录/输入输出；
- `ATPG.md`：ATPG/Lander 概念、命令和选项材料；
- `IJTAG.md`：IJTAG/Boundary Scan/CRG 等专题；
- `3D_MBIST.md`：3D、诊断、测试设计和 JSON/日志类资料；
- `COT.md`、`其他.md`：DFT 流程、培训、工具和音视频转写类内容。

本文没有假定这些文档全部属于同一工具版本，也没有将需求说明中的内容自动视为已经实现。建立索引时必须补充每份文档的版本、日期、来源类型和校验状态。

### 14.2 外部官方资料

OMP 接入方式依据当前项目源码及本仓库文档，包括：

- `context-files.md`：`.omp/AGENTS.md`、`.omp/RULES.md`、上下文发现、粘性规则和优先级；
- `skills.md`：Skill 布局、frontmatter、`skill://` 与 `/skill:<name>`；
- `task-agent-discovery.md`：`.omp/agents/`、工具白名单、`autoloadSkills`、模型角色和 Task 分派；
- `hooks.md`、`extensions.md`、`extension-loading.md`：Hook/扩展工厂、事件和插件加载；
- `mcp-config.md`：`.omp/mcp.json`、用户/profile 配置、stdio/HTTP、`/mcp` 校验命令；
- `marketplace.md`、`plugin-manager-installer-plumbing.md`：OMP Marketplace、插件能力目录和发布命令；
- Model Context Protocol 官方规范/SDK说明，以及 SQLite FTS5、Tree-sitter 等项目官方资料。

OMP 功能和配置格式可能继续变化。部署前应运行 `omp --version`，并在 TUI 中执行 `/mcp list`、`/mcp test dft-docs` 和试点插件验证；不应直接假定其他 Agent 客户端的配置与 OMP 相同。
