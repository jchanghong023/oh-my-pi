---
description: '基于本地 Git 变更（本地变更或分支对比），自动创建 DT 任务队列并串行执行，最终输出执行报告。'
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
{"html":"<form><fieldset><legend>请选择增量分析模式</legend><label><input type=\"radio\" name=\"analysis-mode\" value=\"local\" required> 本地变更（未提交，类级覆盖率）</label><label><input type=\"radio\" name=\"analysis-mode\" value=\"branch\"> 分支对比（已提交，增量覆盖率）</label></fieldset></form>"}
```

`analysis-mode` 返回 `local`（本地变更）或 `branch`（分支对比）。分支对比使用输入中的 `--base`，未指定则使用 `origin/当前分支名`。未选择有效模式或取消时不执行分析。

用户选择后，确定后续步骤的执行参数：

| 用户选择 | 数据来源 | 覆盖率模式 | diff 命令 |
|---------|---------|----------|----------|
| 1（本地变更） | `git diff HEAD` | class-level | `git diff HEAD` |
| 2（分支对比） | `git diff {base}...HEAD` | incremental，目标分支: {base} | `git diff {base}...HEAD` |

用 `git rev-parse --show-toplevel` 获取 `repoRoot`，后续 Git 查询都以该根目录为基准。下文的 `q(...)` 表示 MUST 将完整值编码为单个 Bash 参数：外层加单引号，内部单引号替换为 `'\''`。

### 2. 获取变更文件

#### 2.1 本地变更模式

使用 `git diff HEAD` 获取所有未提交变更（含已暂存和未暂存），同时检查未跟踪的新文件：

```bash
# 获取所有未提交的变更文件（含变更类型）
git -C q(repoRoot) diff -M HEAD --diff-filter=ACDMRT --name-status -z -- "*.java"

# 获取未跟踪的新 Java 文件（尚未 git add）
git -C q(repoRoot) ls-files -z --others --exclude-standard -- "*.java"
```

过滤规则：
- 仅保留 `.java` 后缀文件
- 排除 `*Test.java` 和 `*Tests.java` 测试文件

**变更概览输出**：

```
变更文件概览：
- 未提交变更: {N} 个文件（已暂存 + 未暂存的修改）
  - [A] FileA.java
  - [M] FileB.java
- 未跟踪新文件: {K} 个文件（尚未 git add）
  - FileC.java

未提交变更将直接纳入分析。
未跟踪的新文件需先执行 git add 才能纳入分析。
```

若无未提交变更文件，输出以下提示并**终止执行**：

```
未检测到 Java 变更文件。
请先修改文件或使用 git add 添加新文件。
```

若无未提交变更但有未跟踪新文件，提示用户添加后重试：

```
未检测到已修改的 Java 变更文件，但有 {K} 个未跟踪的新文件：
- FileC.java
请先使用 git add 添加需要分析的新文件。
```

#### 2.2 本地分支对比模式

MUST 先用 `git -C q(repoRoot) status --porcelain --untracked-files=normal` 检查工作树。查询失败或输出非空则停止；请用户先提交或移出未提交工作，NEVER 自动 stash、checkout 或丢弃改动。用 `git -C q(repoRoot) rev-parse --verify --end-of-options q(ref)` 分别解析 `HEAD^{commit}` 和 `{base}^{commit}`，记为 `headCommit` 和 `baseCommit`。任一解析失败则停止；`baseRange` 使用完整的 `{baseCommit}...{headCommit}`。

```bash
git -C q(repoRoot) diff -M --diff-filter=ACDMRT --name-status -z q(baseRange) -- "*.java"
```

过滤规则同上。

若无变更文件，输出以下提示并**终止执行**：

```
本地分支对比（{base}...HEAD）未检测到 Java 变更文件。
```

### 3. 分析变更详情

步骤 2 的文件列表按 NUL 分隔解析。`R<相似度>` 项含旧路径和新路径；以新路径作为任务文件，保留两条路径用于获取重命名补丁。

变更类型处理规则：

| 变更类型 | 标识 | 处理方式 |
|---------|------|---------|
| 新增 | A | 全量生成测试，无需解析变更方法 |
| 修改 | M | 需进一步获取 diff 内容，解析变更方法 |
| 重命名 | R | 解析旧、新路径之间的内容变化；纯重命名不建任务。若新路径首次成为纳入范围的业务 Java 文件，按 A 处理 |
| 删除 | D | 跳过，不创建任务 |

对 M 使用当前路径，对 R 同时使用旧、新路径，按字面路径从仓库根获取补丁。NEVER 使用 `-w`；空白可能改变 Java 字符串或文本块的行为。

```bash
# 本地变更模式
git -C q(repoRoot) --literal-pathspecs diff -M HEAD -- q(filename)

# 分支对比模式
git -C q(repoRoot) --literal-pathspecs diff -M q(baseRange) -- q(filename)
```

R 项在上述命令的 `--` 后传入 `q(oldFilename) q(filename)`，不能只传新路径。

从 diff 输出中解析变更方法：
- `+methodName()` — 新增方法，标记为 `+methodName`
- 方法体变更但签名不变 — 修改方法，标记为 `~methodName`

**A 类型文件标记方法为"全量"，不解析 diff 内容，节省开销。**

### 4. 过滤无业务逻辑类

在创建任务之前，对步骤 3 中的所有非 D 类型变更文件进行前置过滤，提前排除无需生成测试的类，减少无效任务创建。

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
- 已跳过: {K} 个文件
  - Constants.java - 常量类，无业务逻辑
  - OrderDTO.java - 数据传输对象，无业务逻辑

覆盖率模式: {class-level / incremental}
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

##### 本地变更模式（不传 --base）

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

##### 本地分支对比模式（传 --base）

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

#### Prompt 变量说明

| 变量 | 来源 | 说明 |
|------|------|------|
| `{sourcePath}` | `repoRoot` 和步骤 3 的文件路径 | 当前业务文件的绝对路径；统计和待办仍使用仓库根相对路径 |
| `{changeType}` | 步骤 3 分析结果 | A（新增）、M（修改）或 R（重命名且存在业务修改） |
| `{methods}` | 步骤3分析结果 | 变更方法列表，逗号分隔 |
| `{ClassName}` | 从 filename 推导 | 去掉路径和 .java 后缀的类名 |
| `{base}` | 用户传入的 --base 参数 | 基准分支名称（仅 incremental 模式） |

#### changeType 对应的生成策略

| changeType | 生成策略 |
|------------|---------|
| A（新增） | 全量生成测试：为该类所有 public 方法生成测试用例 |
| M（修改）或 R（重命名且存在业务修改） | 增量生成测试：仅为变更方法（新增方法或修改方法）生成或补充测试用例 |

#### methods 格式

- 新增方法：`+methodName`
- 修改方法：`~methodName`
- 多个方法用逗号分隔：`+createOrder, ~processPayment`

### 6. 串行执行任务

按队列顺序逐个执行，每次只启动一个 `task`；若工具异步返回，等待该子 Agent 完成并接收结果后，才可启动下一个。

分支对比模式下，每次委托前 MUST 确认仓库的 `HEAD` 仍是 `headCommit`，且 `git -C q(repoRoot) --literal-pathspecs diff --quiet HEAD -- q(filename)` 成功。发现差异或检查错误则停止，不能对不一致的源码生成测试。委托 MUST 使用 `isolated: false`；子代理在读取前复查提交和目标源码，只允许修改测试。

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

覆盖率模式: class-level / incremental
阈值: 80%

变更统计:
- 新增文件: {N}
- 修改文件: {M}
- 前置过滤跳过: {K}

前置过滤跳过（无业务逻辑类）:
┌─────────────────────┬──────────────────────────┐
│ 文件                │ 跳过原因                  │
├─────────────────────┼──────────────────────────┤
│ Constants.java      │ 常量类，无业务逻辑        │
│ OrderDTO.java       │ 数据传输对象，无业务逻辑   │
└─────────────────────┴──────────────────────────┘

变更详情（需生成测试）:
┌─────────────────────┬──────────┬──────────────────────┐
│ 文件                │ 类型     │ 变更方法              │
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
- 总任务: {Total}

==========================================
```

---

## 流程对比表

| 代码状态 | 测试文件状态 | 覆盖率模式 | 流程 |
|---------|------------|----------|-----|
| 未 commit | 不存在测试 | class-level | generate → fix → coverage → 循环补充 → assertion-review |
| 未 commit | 存在测试 | class-level | coverage（优先）→ 若达标跳过 → 若未达标 generate → fix → coverage → 循环 → assertion-review |
| 已 commit | 不存在测试 | incremental | generate → fix → coverage → 循环补充 → assertion-review |
| 已 commit | 存在测试 | incremental | coverage（优先）→ 若达标跳过 → 若未达标 generate → fix → coverage → 循环 → assertion-review |

---

## 注意事项

1. 无变更文件时必须提示用户，不得创建空任务队列
2. 每个任务的 prompt 仅包含当前变更文件信息，严禁跨文件混入
3. 串行执行中，单个任务失败不阻塞后续任务执行
4. 步骤4前置过滤跳过的文件（DTO/Config/Enum 等无业务逻辑类）不创建任务，但仍需在步骤7执行报告中体现
5. 所有 DT 工作必须通过 `task` 委托给 `developer-test-agent`，不得由主 Agent 直接操作
6. 覆盖率阈值默认 80%，未达标时 Agent 内部循环补充测试
7. 任务由主 Agent 按创建顺序串行调度
8. 已存在测试文件时，优先使用内置 `improve-coverage` 分析覆盖率，若已达标则跳过测试生成
9. 执行时必须询问用户选择分析模式（本地变更 / 本地分支对比），不得跳过交互
10. 本地变更模式下，必须同时检查 `git diff HEAD` 和 `git ls-files --others`，向用户展示未提交变更和未跟踪的新文件，提示添加遗漏的新文件
11. 仅使用 `todo` 跟踪任务，使用 `task` 逐个串行调度
