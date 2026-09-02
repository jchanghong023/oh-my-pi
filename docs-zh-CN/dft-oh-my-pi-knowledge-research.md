# Oh My Pi 内置 Markdown 知识索引：技术全景与实现

**重写日期：** 2026-08-31  
**目标场景：** 私有研发资料的 Markdown 知识检索，语料可包含由图片、Office/PDF、音视频转换得到的 OCR/ASR 文本  
**讨论对象：** 本 fork 新增的外部 Markdown 持久索引：`omp docs`、TUI `/docs` 与 Agent 工具 `wiki`；不是 `omp://` 内嵌产品手册

> 隐私说明：本文仅描述公开实现、通用使用方式与匿名化结论，不记录内部项目名、产品名、信号名、原始语料规模、文件数量、索引数量、数据库大小、查询词、逐项性能数据或可用于反推私有语料的信息。

## 1. 结论

1. **现阶段默认使用内置 FTS 索引。** 它以标题章节切分 Markdown，持久化到 SQLite FTS5，使用 BM25 排序；建索引和检索均不调用模型。对命令、信号、版本、报错等高信息量字面词，FTS 适合作为低成本默认检索层。
2. **`wiki` 是查询面，`docs` 是管理面。** 用户通过 `omp docs` 或 `/docs` 创建、重建、查看、删除索引；Agent 通过只读 `wiki` 执行 `status → search → read`，读取索引中保存的原始章节并引用路径与行号。
3. **结构化模式是可选的模型抽取层，不是 FTS 的同义词。** 显式选择 `structured` 后，OMP 才按 schema 抽取实体、断言、关系和证据，开放 `lookup`、`relations`、`conflicts`。它需要模型凭据，成本与失败面远高于 FTS。
4. **保留 grep，按缺口引入外部技术。** 正则、全量枚举、检查工作区最新内容仍用 grep；只有出现可量化的语义召回缺口时再评估向量/混合检索，出现中央服务、细粒度权限、审计或多客户端需求时再评估 MCP。
5. **本 fork 没有专用文档子代理、`/doc` 快捷命令或自然语言路由器。** `wiki` 作为 essential 只读工具进入非受限会话；是否调用仍由 Agent 根据任务与工具说明判断。需要强制查询时，可用简短项目规则或 Skill 补充行为约束，但不复制知识库。

## 2. 相关技术全景

知识系统至少包含五层：**采集 → 切分 → 检索 → 知识表示 → Agent 接入**。grep、RAG、MCP、Skills 解决的问题不同，不能放在同一维度比较。

### 2.1 采集、切分与检索

| 技术 | 核心机制 | 适用价值 | 主要边界 | 内置 `docs` 状态 |
|---|---|---|---|---|
| OCR / ASR / 文档转换 | 图片、PDF、Office、音视频转成文本或 Markdown | 把不可直接检索的资料变成语料 | 可能破坏命令拼写、表格、代码块、说话人和时间信息 | **不内置**；只接收转换后的 `.md` |
| 结构切分 | 按标题、段落或语法块生成检索单元，并保留来源位置 | 命中结果可读、可引用，减少无关上下文 | 固定长度会切断表格/代码；完整 AST 成本更高 | **内置**轻量标题切分，不是完整 Markdown AST |
| grep / 正则 | 每次顺序扫描当前源文件 | 无索引、结果实时、支持正则与全量枚举 | 每次读取全语料；无章节排序和持久快照 | **外部互补工具** |
| 倒排全文检索 | 维护“词项 → 章节”映射 | 字面词查询快，适合命令、信号、版本、报错 | 不理解同义表达；索引需要更新 | **FTS 核心**：SQLite FTS5 |
| BM25 排序 | 综合词频、文档频率、长度与字段权重排序 | 让标题命中、高区分度词优先 | 排名不是事实正确性；宽泛词仍会产生大量命中 | **已内置** |
| 向量检索 | embedding 将查询与文本映射到向量空间，按距离召回 | 适合“换一种说法”的概念查询 | 精确符号、数字和近似命令可能不稳定；需模型与向量库 | **未内置** |
| 混合检索 / 重排 | 合并字面与向量候选，再用规则或 reranker 排序 | 同时兼顾精确词与语义召回 | 系统、评测、成本复杂度上升 | **未内置** |

### 2.2 知识表示、接入与使用

| 技术 | 核心机制 | 适用价值 | 主要边界 | 内置 `docs` 状态 |
|---|---|---|---|---|
| RAG | 检索外部证据，将命中内容放入模型上下文后生成答案 | 知识可更新、可追溯，不必写进模型参数 | 答案质量仍受检索、上下文和模型影响 | `wiki search/read + Agent` 构成**工具式字面 RAG** |
| Schema 结构化抽取 | 将文本抽成实体、字段、关系、条件和证据 | 直接查询“命令—选项—版本—流程” | 抽取昂贵且会错，必须校验证据 | **可选 `structured` 模式** |
| 知识图谱 | 以节点和边表达实体关系 | 适合多跳关系、版本依赖和影响分析 | 图的正确性取决于抽取质量 | 内置关系表只覆盖直接关系，不是完整图平台 |
| GraphRAG | 在知识图上聚类、生成社区摘要并执行局部/全局检索 | 适合跨文档综合与全局主题问题 | 构建与查询成本高，错误边会扩散 | **未内置** |
| MCP | 用标准协议把外部资源、工具、服务接入 Agent host | 中央部署、多客户端、服务端鉴权和审计 | MCP 是接口，不决定检索质量 | 内置索引**不经过 MCP**；MCP 是外部替代/扩展 |
| Rules / Skills / Task / Hooks | 约束何时检索、如何核验，或隔离研究上下文 | 提高触发稳定性，注入少量项目状态 | 不是知识库；规则过长会占上下文 | OMP 通用能力；本 fork **无专用 docs 编排层** |
| LSP / Tree-sitter / ctags | 解析代码符号、定义、引用和语法结构 | 建立“文档概念 → 源码实现”映射 | 多语言、动态脚本、生成代码较难 | 与 `docs` **分离** |
| 超长上下文 / Prompt Cache | 直接发送大量文本，并缓存重复前缀 | 小型稳定资料实现简单 | 大型语料不适合整体注入；冲突和噪声仍在 | **未采用** |
| 微调 / 继续预训练 | 把领域模式写入模型参数 | 改善术语理解、分类或风格 | 难引用来源，更新滞后，不能保证精确命令 | **不属于索引方案** |

关键关系：

- **RAG 不等于向量检索。** FTS、向量、结构化查询都可作为 RAG 的检索器；本 fork 当前以 FTS 为默认检索器。
- **MCP 不等于知识库。** 它标准化连接；后端仍需自行选择 FTS、向量、图或数据库。
- **结构化关系表不等于 GraphRAG。** 内置模式能遍历直接关系、检测部分冲突，但没有社区聚类、社区摘要或全局图检索。
- **Skills / 子代理不等于索引。** 它们只影响 Agent 何时、怎样使用证据。

## 3. 内置 `docs` / `wiki` 的实际技术

### 3.1 架构与数据流

```text
PDF / Office / 图片 / 音视频
            │  外部 OCR、ASR、转换与质量治理
            ▼
      Markdown 目录（只读源）
            │
            │ omp docs init / reinit
            ▼
   隐藏的新一代索引 __building__*
      ├── documents：路径、标题、hash、mtime、大小
      ├── sections：标题路径、行/字节范围、raw Markdown
      ├── sections_fts：路径、标题、正文词项 + BM25
      └── structured 可选层
          ├── entities / aliases / assertions / relations
          └── evidence：原文 quote、行/字节范围、confidence
            │
            │ 全量成功后，同一 SQLite 事务原子提升
            ▼
      当前可见代际（持久快照）
            │
      ┌─────┴──────────────┐
      ▼                    ▼
/docs、omp docs          wiki（只读 Agent 工具）
管理与人工预览            status/search/read/...
```

索引查询不再读取原 Markdown；`wiki read` 返回 SQLite 中保存的索引快照。因此：

- 源文件临时离线或被删除，旧证据仍可读；
- 源文件发生变化，结果不会自动更新，必须 `reinit`；
- 路径与行号对应**建索引时**的版本，而非未重建的工作区现状。

### 3.2 两个管理入口、一个查询入口

#### CLI：`omp docs`

```bash
# 默认 FTS；索引名和路径仅为通用示例
omp docs init "/srv/docs/markdown" --name knowledge --mode fts

omp docs list
omp docs status knowledge
omp docs reinit knowledge

# 结构化模式可使用自定义 JSON schema
omp docs reinit knowledge --mode structured --schema ./schema.json

# 只删除索引，不删除源 Markdown
omp docs remove knowledge --force
```

支持的动作：`init | reinit | list | status | remove`。`--json` 输出机器可读结果；`init/reinit` 可选 `--schema <内置预设|JSON路径>` 与 `--mode <fts|structured>`；删除必须显式 `--force`。

#### TUI：`/docs`

`/docs` 打开索引管理 Hub：

- `n`：新建；向导使用默认 schema 与 `mode=fts`；
- `r`：全量重建当前索引；
- `/`：在当前索引搜索并预览章节/实体；
- `i`：查看状态、计数和冲突；
- `v`：查看保存的 schema；
- `d`：确认后删除索引；
- `c`：取消正在构建的隐藏代际。

#### Agent：`wiki`

`wiki` 只查询既有索引，**不会**创建或重建。推荐调用顺序：

```text
status
  → 选择一个索引并固定 index
  → search(query)
  → read(sectionId)             # FTS 与 structured
  → lookup(key)                 # structured only
  → relations(entityId)         # structured only
  → conflicts()                 # structured only
  → read(evidenceId)            # 回到原始证据
```

无索引时，Agent 只能提示用户运行 `omp docs init ... --mode fts`；重建失败时提示 `omp docs reinit <name>`。存在多个索引时，除 `status` 外必须指定准确的 `index`，防止跨语料混查。

本 fork 没有 `/doc`、`doc-researcher` 或自然语言路由快捷层。`/docs` 是管理 UI，不是“替用户完成一轮文档研究”的命令。

### 3.3 Markdown 扫描与章节切分

当前实现是轻量、确定性的 Markdown 结构解析：

1. 递归枚举 `.md`，按路径排序；忽略其他扩展名与符号链接。
2. 打开文件时使用 `O_NOFOLLOW`，并校验解析后的路径仍在索引根目录内。
3. 识别 ATX 标题（`#`～`######`）与 Setext 标题；围栏代码块中的 `#` 不视为标题。
4. 用标题层级构造 `headingPath`；保存每节的原始 Markdown、绝对行范围和 UTF-8 字节范围。
5. 单节超过 24,000 字符时优先在空行处分块；极长单行硬切。超长表格或代码块因此仍可能跨块。
6. 生成仅供 FTS 的 plain text：去除部分 Markdown 标记、保留可检索文字；原始章节不被覆盖。
7. 保存源文件 SHA-256、mtime、大小和标题，但当前更新策略仍是全量重建，不做增量 watcher。

这套切分比固定 token 窗口更保留文档结构，但不是 CommonMark AST，也不会理解表格列关系、代码语法或 frontmatter 中的版本语义。

### 3.4 FTS 模式：SQLite FTS5 + BM25

#### 索引结构

所有索引共用当前 agent 目录下的 `docs.db`。默认目录通常是 `~/.omp/agent/`；具体位置随 profile 的 agent 目录变化。数据库配置包括：

- SQLite WAL；`synchronous=NORMAL`；外键开启；
- 5 秒 busy timeout；
- 数据库文件权限设为 `0600`；
- `sections_fts` 使用 FTS5 contentless-delete 表；原始内容保存在普通 `sections` 表；
- FTS 字段：相对路径、标题路径、正文；章节 ID 与索引 ID 不参与全文索引。

#### 文本与查询归一化

索引文本先做 NFKC；连续空白折叠。`U+3400–U+9FFF` 范围内汉字逐字增加词边界，使常见中文查询不依赖外部分词词典。

查询处理不是直接透传 FTS5 语法，而是：

1. NFKC；
2. 提取单个汉字，或由 Unicode 字母、数字、下划线组成的词元；
3. 每个词元转为精确 phrase；
4. 全部以 `AND` 连接。

因此：

- 多词查询要求同一章节同时包含全部词元；
- 输入中的 `OR` 不会成为布尔操作符；
- 不支持 regex、模糊匹配或隐式前缀搜索；
- 同义词应拆成多次查询，不能依赖 embedding 召回；
- 下划线保留，适合信号、命令和配置名。

#### 排序与返回

章节使用 SQLite `bm25()` 排序，字段权重为：

```text
relative_path = 0.5
heading_path  = 2.0
body          = 1.0
```

标题命中因此比正文命中更重要。`search` 默认最多 10 条、硬上限 50 条；结果按**章节**而不是按文件去重，宽泛词可能由同一文件的多个章节占满 Top-K。每条结果带 `sectionId`、索引名、相对路径、标题路径、行范围、摘要和 rank；`read(sectionId)` 再返回完整的 stored raw Markdown。

FTS 建索引与本地搜索都不需要模型。只有 Agent 调用 `wiki` 并把返回章节用于回答时，命中内容才进入当前对话模型的上下文。

### 3.5 结构化模式：schema 约束的模型抽取

FTS 索引也保存 schema ID/hash，但**不执行抽取**，所以实体、断言、关系计数为 0。只有显式 `--mode structured` 才启用下面流程。

| 项目 | `fts` | `structured` |
|---|---|---|
| 默认 | 是 | 否 |
| 构建时模型调用 | 无 | 每个章节至少一次，失败后最多纠正一次 |
| 基础存储 | 文档、章节、FTS | 同左 |
| 额外存储 | 无 | 实体、别名、断言、关系、证据 |
| `wiki` 操作 | `status/search/read` | 六项操作全部可用 |
| 凭据 | 不需要 | 需要可用的 `task` 角色模型和 API 凭据 |
| 主要用途 | 目标式字面检索 | 反复查询命令 schema、版本关系、约束和冲突 |

#### Schema

实现提供内嵌预设，也可传入自定义 JSON schema。预设覆盖命令、选项、模式、阶段、流程、步骤、工具、版本、测试、输入输出、示例、约束、错误、分组等通用实体；关系可描述依赖、冲突、输入输出、版本引入或弃用等语义。

自定义 schema 定义实体种类、字段类型、必填项、身份规则、谓词源/目标类型与一对一/一对多基数；载入时做严格结构校验并保存规范化 JSON 的 SHA-256。

#### 抽取与校验

每个章节独立发送给 `task` 角色模型：temperature 0、reasoning 关闭、输出上限 8192 tokens。模型返回 `entities`、`assertions`、`relations` JSON；第一次无效时把错误反馈给模型纠正一次。

入库前检查：

- JSON shape、字段类型、必填身份和 local ID 唯一性；
- 谓词是否允许对应的源/目标实体类型；
- parent identity 是否能解析，是否存在环；
- evidence 行号是否位于当前章节；
- quote 是否真实存在于声明的原文行范围；
- confidence 是否在 `[0,1]`。

这些检查能拒绝不可定位的“证据”，但不能证明模型对原文语义的解释一定正确。`conflicts` 只检测同一实体、字段、条件下的多个规范化值，以及 schema 标记为 cardinality=`one` 的关系多目标；它不是通用自然语言矛盾检测器。

#### 规模影响

当前实现逐章节调用模型，构建并发受 `task.maxConcurrency` 控制且硬上限为 8。结构化构建的模型请求量随章节数线性增长，失败纠正时更多；任何文档存在抽取/证据错误都会阻止新代际提升。

因此，大型私有语料首先使用 FTS。只有真实问题反复需要实体/关系查询时，才应对**经筛选的小型高质量子库**试点 structured，并单独测量成本、时延、抽取准确率和冲突质量。

### 3.6 `wiki` 操作语义

| `op` | FTS | Structured | 关键输入 | 返回 |
|---|:---:|:---:|---|---|
| `status` | ✓ | ✓ | 可选 `index` | mode、state、schema、文档/章节/实体计数、错误 |
| `search` | ✓ | ✓ | `query`；可选 `limit` | 章节命中；structured 还返回实体前缀/别名命中 |
| `read` | ✓ | ✓ | `sectionId` 或 `evidenceId`，二选一 | stored raw Markdown，或 quote + 完整存储章节 |
| `lookup` | ✗ | ✓ | canonical key、alias、display name 或实体 ID | 实体、别名、字段断言及证据 |
| `relations` | ✗ | ✓ | `entityId`；可选方向、predicate、limit | 入边/出边、条件与证据 |
| `conflicts` | ✗ | ✓ | 可选 `limit` | 可机械判定的多值冲突及各自证据 |

`limit` 默认 10、最大 50。工具层会拒绝在 FTS 索引上调用 `lookup/relations/conflicts`，而不是返回空结果掩盖模式错误。

`wiki` 是 approval=`read`、load mode=`essential` 的内置工具：

- 非受限默认会话获得 `wiki`；
- 非受限显式工具集包含 `read` 时也补入 `wiki`；
- 受限会话严格保持宿主白名单，只有显式列出 `wiki` 才可使用。

工具提示要求：先 `status`，固定一个索引，读取支撑每个实质结论的存储证据，并引用索引、相对路径、精确行范围和原文摘录。

### 3.7 重建、故障与一致性

`init/reinit` 不是在当前索引上原地修改：

1. 创建不可见的 `__building__<UUID>`；
2. 全量扫描并构建新代际；
3. 任何失败或取消：删除临时代际，旧代际继续服务；
4. 全量成功：在 SQLite 事务内删除旧代际并把临时代际改成公开名。

这提供查询侧原子切换，避免用户读到一半新、一半旧的数据；代价是重建需要完整的时间和临时磁盘空间。当前保存的 hash/mtime 用于记录，不用于增量跳过。

### 3.8 安全边界

已实现的本地边界：

- 只读扫描 Markdown；跳过 symlink，阻止路径逃逸；
- `wiki` 只有读批准级别，不提供建库、执行命令或写源文件能力；
- SQLite 文件设为 `0600`；
- FTS 失败/取消不破坏当前代际。

未实现或需部署者负责的边界：

- 无文档级 ACL、中央鉴权、查询审计、静态加密或跨用户服务；
- 无 OCR/ASR 纠错、来源可信度、版本过滤、敏感字段脱敏；
- `wiki read` 返回原始 Markdown，未做内容级 prompt-injection 指令剥离；文档必须作为不可信证据而非系统指令处理；
- FTS 建库不调用模型，但命中内容会进入当前 Agent 所用模型；
- structured 会把每个章节发送给配置的 `task` 模型，必须先确认模型后端和数据出境策略。

单机、单 profile 可依赖 OS 权限隔离。需要团队中央服务、细粒度权限、审计、服务端脱敏或统一更新时，才值得把相同索引能力放到内网服务后通过 MCP 暴露。

## 4. 私有研发语料的使用方式

### 4.1 推荐查询流程

1. `wiki status`：确认索引 `ready`、mode 和更新时间。
2. 先搜稀有精确词：完整命令、信号、报错 token、版本等。
3. 宽泛主题加入高信息量限定词；不要把同义词用 `OR` 写在一次查询中。
4. 读取命中章节，不只依赖搜索摘要。
5. 结论引用 `index + relative path + line range + excerpt`；版本冲突必须并列证据。
6. 文档变更后运行 `omp docs reinit <name>`；重建失败时继续使用旧代际并修复错误。
7. 需要所有出现位置、正则、否定条件或确认工作区最新文本时改用 grep。

### 4.2 OCR / ASR 资料治理

内置索引不会修复源文本。入库前至少应：

- 保留原始转换文件和来源标识；
- 标题中写明工具、版本、日期或资料类型，使 FTS 可检索；
- 保持 code fence、inline code、路径、命令、信号和报错原样；
- OCR/ASR 推测值与原文分开记录，不静默覆盖历史拼写；
- 对高风险命令、选项、默认值、版本关系和流程顺序人工复核。

若需要别名、来源等级或版本过滤，FTS 当前没有专用字段过滤器：可先用多次查询和人工证据判断；需求稳定后再试 structured schema 或外部服务。

### 4.3 何时使用其他技术

| 需求 | 首选 | 原因 |
|---|---|---|
| 精确命令、信号、版本、报错；目标式问答 | 内置 FTS + `wiki` | 快、无模型建库、可读原文证据 |
| 正则、全部命中、合规枚举、工作区即时状态 | grep | 无 Top-K、无索引陈旧、支持正则 |
| 固定命令 schema、直接关系、机械冲突查询 | 小型 curated structured 索引 | 能查询实体/断言/关系，但需承担模型成本 |
| 大量自然语言改写导致 FTS 漏召回 | 外部向量或混合检索 | 先用真实问题证明语义缺口，再增加系统复杂度 |
| 中央语料、多客户端、ACL、审计、统一更新 | 内网知识服务 + MCP | 服务端集中治理；MCP 只负责接入 |
| 文档概念必须定位到源码定义/引用 | LSP / Tree-sitter / ctags | 这是代码索引，不是文档索引 |
| Agent 经常忘记查文档 | 短 Rule 或 Skill | 只补触发策略；不复制大型语料 |

## 5. FTS 验证原则

原报告曾包含来自私有语料的精确规模、查询词、构建耗时、数据库大小、查询时延、精确率和召回率。这些数据与内部语料存在关联性，因此本文不再保留逐项数值或原始查询词。

公开文档只保留以下可复现实验方法：

1. **构建指标**：记录 Markdown 文件数、总字节数、章节数、首次建索引耗时和数据库大小，但仅在本地测试报告中保存。
2. **查询时延**：同一文件系统、同一热缓存条件下比较 grep 与 FTS，并区分冷查询、热查询和网络文件系统。
3. **字面精确率**：以“原文件是否实际包含查询字面量”为 ground truth，检查 Top-K 命中。
4. **文件召回率**：统计 Top-K 章节覆盖的相关文件数与全部相关文件数之比，避免把章节级 Top-K 当作完整文件枚举。
5. **结果解释**：精确字面词通常更适合 FTS；高频宽泛词会受 Top-K 和同文件多章节占位影响；需要穷举时使用 grep。
6. **边界**：字面命中不等于最终答案正确；Agent 仍需 `read` 原始章节并引用证据。structured、语义问题、并发、p95、峰值磁盘、模型端到端质量等需要独立评测。

## 6. 落地建议

1. **全库先建 FTS。** 使用稳定索引名；把 `reinit` 纳入语料发布流程，而不是依赖工程师记忆。
2. **建立真实问题集。** 至少覆盖精确命令、版本、概念、报错、宽泛主题、OCR 噪声和文档冲突；测试结果保留在受控环境，不写入公开仓库。
3. **保留双路径。** `wiki` 负责目标式证据检索；grep 负责正则、全量与最新工作区检查。
4. **structured 只做小库试点。** 先测每种实体/关系的抽取准确率、证据有效率、冲突误报、模型成本和全量成功率；没有收益数据不扩到全库。
5. **按缺口扩展。** 语义漏召回才加向量/混合检索；中央治理才加 MCP；文档到代码定位才加 LSP/Tree-sitter；触发不稳定才加短 Rule/Skill。
6. **先确定模型数据边界。** FTS 只在本地建库不代表资料不会进入模型；`wiki read` 与 structured extraction 都必须符合内部数据策略。
7. **公开文档必须匿名化。** 不提交可关联真实语料的项目名、产品名、信号名、内部路径、文件清单、样本查询、精确规模或 benchmark 原始数据。

最终判断：

> 对大型私有 Markdown 语料，OMP 内置 FTS 是低复杂度、可追溯的默认方案；结构化抽取和外部知识平台应由真实缺口触发。公开仓库只记录通用方法和实现，不记录能够关联或反推私有语料的原始标识与测量数据。

## 7. 实现依据与延伸阅读

### 7.1 当前 fork 实现

- `packages/coding-agent/src/docs/markdown.ts`：Markdown 枚举、symlink 防护、标题切分、24,000 字符分块、行/字节范围。
- `packages/coding-agent/src/docs/storage.ts`：SQLite schema、FTS5、WAL、`0600`、代际提升。
- `packages/coding-agent/src/docs/service.ts`：FTS query/BM25、全量构建、结构化入库、查询与冲突检测。
- `packages/coding-agent/src/docs/extractor.ts`：模型抽取、一次纠正、schema/evidence 校验。
- `packages/coding-agent/src/docs/schema.ts`：自定义 schema 与内嵌预设的加载逻辑。
- `packages/coding-agent/src/tools/wiki.ts`、`prompts/tools/wiki.md`：Agent 工具参数、模式限制、证据输出与使用约束。
- `packages/coding-agent/src/modes/components/docs-hub.ts`：TUI `/docs` 管理界面。
- `packages/coding-agent/test/docs-index.test.ts`、`wiki-tool.test.ts`、`wiki-tool-availability.test.ts`：代际、FTS、中英文检索、证据、模式与工具可用性契约。

### 7.2 技术资料

- [SQLite FTS5 官方文档](https://www.sqlite.org/fts5.html)：FTS5 virtual table、tokenizer、contentless table、BM25。
- [Retrieval-Augmented Generation 原始论文](https://arxiv.org/abs/2005.11401)：参数化模型与外部非参数记忆结合。
- [Model Context Protocol 最新规范](https://modelcontextprotocol.io/specification/latest)：host/client/server、resources、prompts、tools 与安全边界。
- [Microsoft GraphRAG](https://microsoft.github.io/graphrag/)：实体关系抽取、图社区、局部/全局检索。
- [Language Server Protocol](https://microsoft.github.io/language-server-protocol/)：代码补全、定义、引用等语言服务协议。
- [Tree-sitter](https://tree-sitter.github.io/tree-sitter/)：增量解析与具体语法树。