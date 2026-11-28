---
description: '基于本地或分支 Git 变更，为 Java/Python 业务源码自动创建并串行执行 DT 任务，汇总覆盖率和执行结果。'
---

基于本地 Git 代码变更，自动创建 DT 任务队列并串行调度 `developer-test-agent` 逐个执行，最终输出执行报告。

## 参数

命令输入：`{{{rawArguments}}}`

- `--base BRANCH` - 从上述命令输入解析基准分支（仅本地分支对比模式需要；未传入时使用 `origin/当前分支名`）

## 执行流程

### 1. 选择分析模式

**必须使用 `ask` 工具询问用户选择分析模式，禁止跳过交互或自行决定模式。**

调用方式：

```json
{"html":"<form><fieldset><legend>请选择增量分析模式</legend><label><input type=\"radio\" name=\"analysis-mode\" value=\"local\" required> 本地变更（未提交，Java 类级 / Python 模块行覆盖率）</label><label><input type=\"radio\" name=\"analysis-mode\" value=\"branch\"> 分支对比（已提交，增量覆盖率）</label></fieldset></form>"}
```

`analysis-mode` 返回 `local`（本地变更）或 `branch`（分支对比）。分支对比使用输入中的 `--base`，未指定则使用 `origin/当前分支名`。未选择有效模式或取消时不执行分析。

用户选择后，确定后续步骤的执行参数：

| 用户选择 | 数据来源 | 覆盖率模式 | diff 命令 |
|---------|---------|----------|----------|
| 1（本地变更） | `git diff HEAD` | Java: class-level；Python: module-level | `git diff HEAD` |
| 2（分支对比） | `git diff {base}...HEAD` | incremental，目标分支: {base} | `git diff {base}...HEAD` |

用 `git rev-parse --show-toplevel` 获取 `repoRoot`，后续 Git 查询都以该根目录为基准。下文的 `q(...)` 表示 MUST 将完整值编码为单个 Bash 参数：外层加单引号，内部单引号替换为 `'\''`。

### 2. 获取变更文件

#### 2.1 本地变更模式

使用 `git diff HEAD` 获取所有未提交变更（含已暂存和未暂存），同时检查未跟踪的新文件：

```bash
# 获取所有未提交的变更文件（含变更类型）
git -C q(repoRoot) diff -M HEAD --diff-filter=ACDMRT --name-status -z -- "*.java" "*.py"

# 获取未跟踪的新 Java/Python 文件（尚未 git add）
git -C q(repoRoot) ls-files -z --others --exclude-standard -- "*.java" "*.py"
```

过滤规则：
- Java：仅保留 `.java`，排除 `*Test.java` 和 `*Tests.java`。
- Python：仅保留项目自有的 `.py` 业务源码。排除路径中含 `.venv`、`site-packages` 的文件、其他已确认的虚拟环境或依赖目录，以及 `test_*.py`、`*_test.py`、`conftest.py`、`test` / `tests` 目录和项目配置指定的测试/夹具。用源码和项目自身的源码布局确认业务归属；不能确认则记录原因，不创建任务。

**变更概览输出**：

```
变更文件概览：
- 未提交变更: {N} 个文件（已暂存 + 未暂存的修改）
  - [A] FileA.java
  - [M] src/payment.py
- 未跟踪新文件: {K} 个文件（尚未 git add）
  - src/new_service.py
  - FileC.java

未提交变更将直接纳入分析。
未跟踪的新文件需先执行 git add 才能纳入分析。
```

若无纳入范围的未提交变更且无符合条件的未跟踪新文件，输出以下提示并**终止执行**：

```
未检测到 Java/Python 业务源码变更。
请先修改文件或使用 git add 添加新文件。
```

若无纳入范围的未提交变更但有符合条件的未跟踪新文件，列出实际文件、提示用户添加后重试，并终止：

```
未检测到已跟踪的 Java/Python 业务源码变更，但有 {K} 个未跟踪的新文件：
- src/new_service.py
请先使用 git add 添加需要分析的新文件。
```

#### 2.2 本地分支对比模式

MUST 先用 `git -C q(repoRoot) status --porcelain --untracked-files=normal` 检查工作树。查询失败或输出非空则停止；请用户先提交或移出未提交工作，NEVER 自动 stash、checkout 或丢弃改动。用 `git -C q(repoRoot) rev-parse --verify --end-of-options q(ref)` 分别解析 `HEAD^{commit}` 和 `{base}^{commit}`，记为 `headCommit` 和 `baseCommit`。任一解析失败则停止；`baseRange` 使用完整的 `{baseCommit}...{headCommit}`。

```bash
git -C q(repoRoot) diff -M --diff-filter=ACDMRT --name-status -z q(baseRange) -- "*.java" "*.py"
```

过滤规则同上。

若无变更文件，输出以下提示并**终止执行**：

```
本地分支对比（{base}...HEAD）未检测到 Java/Python 业务源码变更。
```

### 3. 分析变更详情

MUST 检查 Git 查询是否成功；命令失败不是空变更。步骤 2 两种输出均按 NUL 解析，保留路径原值，NEVER 按空格或换行拆分。`R<相似度>`（及 `C<相似度>`）含旧路径和新路径；重命名以新路径作为任务文件，保留两条路径用于获取补丁。D 项没有新侧源码。

变更类型处理规则：

| 变更类型 | 标识 | 处理方式 |
|---------|------|---------|
| 新增 | A | 全文件生成测试，无需定位变更函数/方法 |
| 修改 | M | 获取实际补丁和源码，定位变更函数/方法 |
| 重命名 | R | 对比旧、新路径内容；新路径首次属于相应语言的业务源码范围时按 A，否则纯重命名不建任务 |
| 删除 | D | 跳过，不创建任务 |

对 M 使用当前路径，对 R 同时使用旧、新路径，按字面路径从仓库根获取补丁。NEVER 使用 `-w`；空白可能改变 Java 字符串或文本块、Python 缩进或字符串语义。

```bash
# 本地变更模式
git -C q(repoRoot) --literal-pathspecs diff -M HEAD -- q(filename)

# 分支对比模式
git -C q(repoRoot) --literal-pathspecs diff -M q(baseRange) -- q(filename)
```

R 项在上述命令的 `--` 后传入 `q(oldFilename) q(filename)`，不能只传新路径。

**Java**：从 diff 输出定位变更方法；新增标记为 `+methodName`，方法体变更但签名不变标记为 `~methodName`。A 类型标记为「全量」，不解析变更方法。

**Python**：

1. 核对目标是仓库根内的实际 Python 源文件，NEVER 跟随出仓库的链接。分支模式用 `headCommit` 对应的新侧源码（经步骤 6 确认一致的工作树文件）；本地模式用当前工作树源码。
2. M/R 使用上述同一 Git 范围和字面路径重取补丁，在 `diff` 中加入 `--no-ext-diff --no-textconv --unified=0`。解析匹配目标文件的 hunk 头 `@@ -old[,count] +new[,count] @@`；从新侧起点计数，只收集 hunk 内 `+` 内容行对应的 1-based 行号，校验新旧侧行数。`-` 或 `\ No newline at end of file` 不产生新侧行；`+new,0` 不产生任何行。NEVER 使用 `+++` 文件头或整个 hunk 的上下文当作变更行。补丁、源码路径或坐标无法核对时记录原因，不建立该文件任务。
3. 用 Python 语法分析或语言符号范围定位函数、`async def`、方法及嵌套作用域，并用实际新侧源码核对边界。NEVER 用 hunk 标题、缩进猜测或最近的 `def` 代替。定义范围计入装饰器、多行签名及函数体；每条变更行只归属于能确认的最内层函数/方法，保留限定名、定义区间、函数体区间及命中行。NEVER 因嵌套变更扩大到外部函数、整类、同名对象或全模块。纯删除 hunk 仅在新侧间隙和旧侧删除内容均可确认属于同一个在新侧保留的函数/方法时，按该对象精确范围执行；其命中新侧行仍为空，不得把间隙两侧行当变更行。模块/类作用域或其他无法确认归属的变更单列；无可确认的变更函数/方法则不建任务。覆盖率用的新侧行数组保留全部实际新增/替换行，不限于已定位对象。
4. A 标记为「全文件」；以实际新文件的全部物理行 `1..N` 作为新侧行（空文件 `[]`），不解析变更对象。
5. 新侧行 MUST 按升序去重，保存为 JSON 正整数数组；数组不预判可执行性。区分「没有新侧行」和「有新侧行但覆盖率报告中无可执行变更行」。

### 4. 过滤无业务逻辑文件

创建任务前，将未纳入的文件和原因记入跳过列表。Python 仅保留步骤 2–3 已确认的业务源码；纯声明、配置、常量或不含业务逻辑的模块不建任务，NEVER 将 Java 的类名规则套用到 Python。下列类规则仅适用 Java。

**跳过规则**：

1. **数据传输对象类**（DTO/VO/Entity/PO/DO/BO）
   - 命名特征：类名以 DTO、VO、Entity、PO、DO、BO 结尾
   - 内容特征：仅包含 getter/setter、简单字段定义、无业务方法

2. **Mapper接口类**（MyBatis Mapper）
   - 命名特征：类名以 Mapper 结尾，且是 interface
   - 内容特征：仅定义数据库操作方法签名，无实现逻辑

3. **常量类**（Constants/Constant）
   - 命名特征：类名以 Constants、Constant 结尾
   - 内容特征：仅包含 static final 常量定义

4. **枚举类**（Enum）
   - 命名特征：使用 enum 关键字定义
   - 内容特征：仅包含枚举值定义，无复杂逻辑

5. **接口定义类**（纯接口）
   - 内容特征：仅定义方法签名，无默认实现，无业务逻辑

**判断流程**：
1. 从文件路径提取类名，检查是否符合跳过规则的命名特征
2. 若符合命名特征，使用 `read` 从 `repoRoot` 下的实际文件路径进一步检查内容特征
3. 若确认无业务逻辑，将该文件从变更列表中移除，记入跳过列表

**过滤输出**：

```
前置过滤结果：
- 需生成测试: {N} 个文件
  - FileA.java (修改: +createOrder)
  - FileB.java (新增: 全量)
  - src/payment.py (修改: Payment.charge，定义及变更行见任务)
- 已跳过: {K} 个文件
  - Constants.java - 常量类，无业务逻辑
  - OrderDTO.java - 数据传输对象，无业务逻辑

覆盖率模式: {Java class-level / Python module-level / incremental}
{目标分支: {base}（仅 incremental 模式）}
```

过滤后的文件列表作为步骤 5 创建任务的输入。跳过的文件仍需在步骤 7 执行报告中体现。

### 5. 创建任务队列

按文件顺序建立本地队列，保存每个文件的变更详情及下方对应模式的完整 prompt。为每个文件生成待办文本 `为 {filename} 生成增量测试`，使用 `todo` 的 `append`、本次运行的新 `phase` 和 `items` 添加队列，保留已有待办；标题重复时加本次运行后缀。列表为空时不创建待办。

```json
{"op":"append","phase":"增量 DT","items":["为 src/OrderService.java 生成增量测试"]}
```

实际调用时将 `items` 替换为全部待办文本，并逐字保留以供后续 `todo` 操作使用。**prompt 中只传入当前变更文件的变更详情，不允许传入多个变更文件的详情信息。**

#### 任务 Prompt 模板

##### Java：本地变更模式

```
【变更测试生成】

业务类: {sourcePath}
变更类型: {changeType}
变更方法: {methods}
覆盖率模式: class-level
覆盖率阈值: 80%

目标：测试设计场景完整，覆盖率达到80%，并且断言有效性检查无问题。

使用 developer-test-agent 完成上面的测试任务。
```

##### Java：本地分支对比模式

```
【变更测试生成】

业务类: {sourcePath}
仓库根目录: {repoRoot}
预期提交: {headCommit}
变更类型: {changeType}
变更方法: {methods}
覆盖率模式: incremental
目标分支: {base}
覆盖率阈值: 80%

目标：测试设计场景完整，覆盖率达到80%，并且断言有效性检查无问题。

使用 developer-test-agent 完成上面的测试任务。
```

##### Python：本地变更模式

```
【变更测试生成】

语言: Python
业务模块: {sourcePath}
仓库根目录: {repoRoot}
变更类型: {changeType}
精确变更对象: {pythonScope}
变更新侧行: {changedLinesJson}
覆盖率模式: module-level
覆盖率阈值: 80%

目标：仅生成指定范围的测试，以该模块的行覆盖率判断门槛，并检查断言有效性。M/R 不得为无关对象新增或补充测试，即使模块未达标。

使用 developer-test-agent 完成上面的测试任务。
```

##### Python：本地分支对比模式

```
【变更测试生成】

语言: Python
业务模块: {sourcePath}
仓库根目录: {repoRoot}
预期提交: {headCommit}
基准提交: {baseCommit}
目标分支: {base}
变更类型: {changeType}
精确变更对象: {pythonScope}
变更新侧行: {changedLinesJson}
覆盖率模式: incremental
覆盖率阈值: 80%

目标：只为指定范围生成或补充测试，并检查断言有效性。增量范围以已验证提交和新侧行数组为准，目标分支名仅供展示。仅取 coverage.json 中该模块的记录：分子 = |executed_lines ∩ 变更新侧行|，分母 = |(executed_lines ∪ missing_lines) ∩ 变更新侧行|。分母为零则报告「无可执行变更行」，无覆盖率百分比，不计为达标；缺少模块记录或报告无效则报告验证失败，不能视为零分母。不得以模块级覆盖率代替该指标。

使用 developer-test-agent 完成上面的测试任务。
```

#### Prompt 变量说明

| 变量 | 来源 | 说明 |
|------|------|------|
| `{sourcePath}` | `repoRoot` 和步骤 3 的文件路径 | 当前业务文件的绝对路径；统计和待办仍使用仓库根相对路径 |
| `{changeType}` | 步骤 3 分析结果 | A（新增）、M（修改）或 R（重命名且存在业务修改） |
| `{methods}` | 步骤 3 的 Java 分析结果 | 变更方法列表，逗号分隔 |
| `{base}` | 步骤 1 确定的基准分支名 | 来自 `--base` 或默认远端分支（仅 incremental 模式） |
| `{headCommit}` / `{baseCommit}` | 步骤 2 验证的完整提交 ID | Python 分支模式以 `baseCommit...headCommit` 绑定输入范围 |
| `{pythonScope}` | 步骤 3 的 Python 分析结果 | A 为「全文件」；M/R 为每个限定名及定义区间、函数体区间和命中新侧行 |
| `{changedLinesJson}` | 步骤 3 的 Python 分析结果 | 当前文件的 1-based 新侧行 JSON 正整数数组，升序去重，空集为 `[]` |

#### changeType 对应的生成策略

| changeType | 生成策略 |
|------------|---------|
| A（新增） | Java：为该类所有 public 方法生成测试；Python：全文件业务逻辑 |
| M（修改）或 R（重命名且存在业务修改） | Java：仅为新增或修改的方法生成或补充测试；Python：仅为精确变更对象生成或补充测试 |

#### Java `methods` 格式

- 新增方法：`+methodName`
- 修改方法：`~methodName`
- 多个方法用逗号分隔：`+createOrder, ~processPayment`

### 6. 串行执行任务

按队列顺序逐个执行，每次只启动一个 `task`；若工具异步返回，等待该子 Agent 完成并接收结果后，才可启动下一个。

分支对比模式下，每次委托（含澄清后重委托）前 MUST 确认仓库的 `HEAD` 仍是 `headCommit`，且 `git -C q(repoRoot) --literal-pathspecs diff --quiet HEAD -- q(filename)` 成功。发现差异或检查错误则停止，不能对不一致的源码生成测试。委托 MUST 使用 `isolated: false`；子代理在读取前复查提交和目标源码，只允许修改测试。Python 本地模式在每次委托前核对目标源码仍与步骤 3 的分析一致；若已变化，重新分析该文件，不得使用旧范围。

先用 `todo` 的 `view` 检查待办；若其他任务正进行，NEVER 用 `start` 改动其状态，直接派发当前任务，结束后仍用实际标题标记 `done`。

对当前文件，将下例中的路径、待办文本和 `task` 内容替换为实际值，`task` 内容使用上面对应模式的完整 prompt：

```json
{"op":"start","task":"为 src/OrderService.java 生成增量测试"}
```

```json
{"context":"按当前文件变更与用户约束串行执行增量单元测试任务，保持原有语言路由和覆盖率规则。","tasks":[{"agent":"developer-test-agent","isolated":false,"task":"<当前文件对应模式的完整 prompt>","solutionSpace":"按指定变更和覆盖率规则生成单元测试"}]}
```

若子 Agent 返回缺失信息和待询问题，主 Agent 必须使用 `ask` 向用户收集答案，再将答案和当前文件任务重新委托给 `developer-test-agent`；不得猜测或将澄清请求视为完成。继续等待该文件处理结束后再执行下一个文件。

记录结果后，用相同的待办文本标记完成（失败也标记完成，失败状态另行记录用于报告）：

```json
{"op":"done","task":"为 src/OrderService.java 生成增量测试"}
```

#### 错误处理

| 场景 | 处理方式 |
|------|---------|
| 单个文件测试生成失败 | 标记任务完成，记录失败原因，继续执行下一个任务 |
| Agent 执行超时 | 记录超时，标记任务完成，继续执行下一个任务 |

**核心原则**：单个任务失败不阻塞后续任务执行。

### 7. 输出执行报告

所有任务执行完毕后，汇总输出执行报告：

```
==========================================
增量 DT 执行报告
==========================================

模式: 本地变更分析（git diff HEAD）
或
模式: 本地分支对比（{base}...HEAD）

覆盖率模式: Java class-level / Python module-level / incremental（按文件）
默认阈值: 80%

变更统计:
- 新增文件: {N}
- 修改文件: {M}
- 前置过滤跳过: {K}

前置过滤跳过:
┌─────────────────────┬──────────────────────────┐
│ 文件                │ 跳过原因                  │
├─────────────────────┼──────────────────────────┤
│ Constants.java      │ 常量类，无业务逻辑        │
│ OrderDTO.java       │ 数据传输对象，无业务逻辑   │
└─────────────────────┴──────────────────────────┘

变更详情（需生成测试）:
┌─────────────────────┬──────────┬──────────────────────┐
│ 文件                │ 类型     │ 变更函数/方法         │
├─────────────────────┼──────────┼──────────────────────┤
│ OrderService.java   │ 修改     │ +createOrder          │
│ PaymentService.java │ 修改     │ ~processPayment       │
└─────────────────────┴──────────┴──────────────────────┘

任务执行结果:
┌──────┬─────────────────────┬──────────┬──────────────────────────┐
│ ID   │ 文件                │ 状态     │ 说明                      │
├──────┼─────────────────────┼──────────┼──────────────────────────┤
│ 1    │ OrderService.java   │ 完成     │ 覆盖率 85%，达标            │
│ 2    │ PaymentService.java │ 完成     │ 覆盖率 92%，达标            │
└──────┴─────────────────────┴──────────┴──────────────────────────┘

执行汇总:
- 成功: {X}
- 失败: {Z}
- 无可执行变更行（不计达标）: {Y}
- 总任务: {Total}

==========================================
```

---

## 流程对比表

| 代码状态 | 测试文件状态 | 覆盖率模式 | 流程 |
|---------|------------|----------|-----|
| 未 commit | 不存在测试 | Java class-level / Python module-level | generate → fix → coverage → 循环补充 → assertion-review |
| 未 commit | 存在测试 | Java class-level / Python module-level | coverage（优先）→ 若达标跳过 → 若未达标 generate → fix → coverage → 循环 → assertion-review |
| 已 commit | 不存在测试 | incremental | generate → fix → coverage → 循环补充 → assertion-review |
| 已 commit | 存在测试 | incremental | coverage（优先）→ 若达标跳过 → 若未达标 generate → fix → coverage → 循环 → assertion-review |

---

## 注意事项

1. 无变更文件时必须提示用户，不得创建空任务队列
2. 每个任务的 prompt 仅包含当前变更文件信息，严禁跨文件混入
3. 串行执行中，单个任务失败不阻塞后续任务执行
4. 步骤4前置过滤跳过的文件（DTO/Config/Enum 等无业务逻辑类）不创建任务，但仍需在步骤7执行报告中体现
5. 所有 DT 工作必须通过 `task` 委托给 `developer-test-agent`，不得由主 Agent 直接操作
6. 覆盖率阈值默认 80%；显式任务阈值优先。未达标时只能在任务范围内补充测试
7. 任务由主 Agent 按创建顺序串行调度
8. 已存在测试文件时，优先使用内置 `improve-coverage` 分析覆盖率，若已达标则跳过测试生成
9. 执行时必须询问用户选择分析模式（本地变更 / 本地分支对比），不得跳过交互
10. 本地变更模式下，必须同时检查 `git diff HEAD` 和 `git ls-files --others`，向用户展示未提交变更和未跟踪的新文件，提示添加遗漏的新文件
11. 仅使用 `todo` 跟踪任务，使用 `task` 逐个串行调度
