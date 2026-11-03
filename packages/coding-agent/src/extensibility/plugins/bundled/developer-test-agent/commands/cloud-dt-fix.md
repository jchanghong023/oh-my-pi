---
description: '获取云端UT问题（MR门禁级/codecov报告/版本级）进行用例修复&覆盖率提升'
---

基于链接自动修复云端 UT 问题。支持三种链接类型：MR 链接、codecov 报告链接和版本testcodecheck检查任务链接。根据链接类型自动路由到对应处理流程。

## 参数
命令输入原文：{{{rawArguments}}}


- `{url}` - 链接（必填），支持以下三种格式：
  - **MR 链接**：如 `https://codehub-g.huawei.com/GDDRDTools/LightIDE/CodeCovService/merge_requests/5`
  - **codecov 报告链接**：如 `https://codecov.rnd.huawei.com/code-cov-web/dtReport/CodeCCP20-157f9fa53c1245e08220657a06cc5d47`
  - **版本testcodecheck检查任务链接（taskUrl）**：如 `https://clouddragon.huawei.com/codecheck/project/project_id/codecheck/task/13e05c8092fa4763834ee1f01a9652c3/detail`

## 调用方式

```
# MR 链接
/cloud-dt-fix https://codehub-g.huawei.com/GDDRDTools/LightIDE/CodeCovService/merge_requests/5

# codecov 报告链接
/cloud-dt-fix https://codecov.rnd.huawei.com/code-cov-web/dtReport/CodeCCP20-157f9fa53c1245e08220657a06cc5d47

# 版本testcodecheck检查任务链接
/cloud-dt-fix https://clouddragon.huawei.com/codecheck/project/project_id/codecheck/task/13e05c8092fa4763834ee1f01a9652c3/detail
```

链接跟随命令直接传入；若命令未传入链接，则通过交互让用户输入。

## 执行流程

### 1. 获取链接

若命令参数中已包含 `{url}`，直接使用。若未传入，**必须使用 `ask` 工具让用户输入链接**：

```json
{
  "questions": [{
    "id": "url",
    "question": "请输入需要修复的链接（MR 链接、codecov 报告链接或版本testcodecheck检查任务链接）：",
    "header": "链接",
    "options": [
      { "label": "手动输入", "description": "在 Other 中输入 MR、codecov 报告或版本testcodecheck任务链接" }
    ]
  }]
}
```
使用返回的自定义输入作为链接。

### 2. 判断链接类型并路由

根据链接特征判断类型：

- **包含 `merge_request`** → MR 链接，执行 [门禁修复流程（MR/codecov 报告）](#3-门禁修复流程mr--codecov-报告)
- **包含 `dtReport`** → codecov 报告链接，执行 [门禁修复流程（MR/codecov 报告）](#3-门禁修复流程mr--codecov-报告)
- **其他** → 版本testcodecheck检查任务链接（taskUrl），执行 [版本testcodecheck检查任务流程](#4-版本testcodecheck检查任务流程)

---

## 3. 门禁修复流程（MR / codecov 报告）

### Step 0: 检查 codecovcli 是否已安装及版本更新

加载安装文档进行检查：使用 `read` 工具读取 `{{pluginRoot}}/skills/fix-ut/references/java/codecovcli-check.md`，按文档检查 codecovcli 安装状态及版本更新。

### Step 1: 获取分析数据

根据链接类型执行不同的 codecovcli 分析命令，获取门禁执行信息。

#### 链接类型判断

| 判断条件 | 链接类型 | 执行命令 |
|----------|---------|---------|
| URL 包含 `dtReport` | codecov 报告链接 | `codecovcli analyze --scenario codecovJobId --codecovid "{jobId}"` |
| 其他 | MR 链接 | `codecovcli analyze --scenario mr --mrpath "{url}"` |

**codecov 报告链接的 jobid 提取规则**：
- 从 URL 中 `dtReport/` 后截取至 `?` 或字符串末尾
- 示例：`https://codecov.rnd.huawei.com/code-cov-web/dtReport/CodeCCP20-157f9fa53c1245e08220657a06cc5d47?param=xxx` → jobid 为 `CodeCCP20-157f9fa53c1245e08220657a06cc5d47`

**MR 链接场景**：

```bash
codecovcli analyze --scenario mr --mrpath "{url}"
```

**codecov 报告链接场景**：

```bash
codecovcli analyze --scenario codecovJobId --codecovid "{jobId}"
```

从输出中解析以下信息。两种场景的返回结构不同，需分别处理：

#### MR 链接场景输出结构

返回 JSON 包含 `jobs[]` 数组，每个 job 包含：

| 输出字段 | 映射到 | 说明 |
|----------|--------|------|
| `jobs[0].serviceName` | service | 服务名称 |
| `jobs[0].language` | language | 语言 |
| `jobs[0].jobId` | jobId | codecov 任务 ID |
| `jobs[0].sourceBranch` | sourceBranch | 源分支 |
| `jobs[0].targetBranch` | targetBranch | 目标分支 |
| `codeRepository` | gitPath | 代码仓地址 |
| `jobs[0].diffCoverage.coverage` | incrementalCoverage | 增量覆盖率 |
| `jobs[0].diffCoverage.total` | totalLines | 增量总行数 |
| `jobs[0].diffCoverage.missing` | uncoveredLineCount | 增量未覆盖行数 |
| `jobs[0].diffCoverThreshold` | threshold | 覆盖率阈值 |
| `jobs[0].failedTests.failures` | failedTests | 用例执行失败数 |
| `jobs[0].failedTests.testClasses` | failedTestList | 失败用例列表 |
| `jobs[0].testActualValue` | testPassRate | 用例通过率实际值 |
| `jobs[0].testThreshold` | testPassThreshold | 用例通过率阈值 |
| `jobs[0].diffCoverage.files[]` | uncoveredFiles | 未覆盖文件列表 |

#### codecov 报告链接场景输出结构

返回 JSON 平铺结构：

| 输出字段 | 映射到 | 说明 |
|----------|--------|------|
| `branchInfo.language` | language | 语言 |
| `branchInfo.jobId` | jobId | 任务 ID |
| `branchInfo.codeBranch` | sourceBranch | 代码分支 |
| （无对应字段） | targetBranch | 留空 |
| `branchInfo.codeRepository` | gitPath | 代码仓地址 |
| `diffCoverage.coverage` | incrementalCoverage | 增量覆盖率 |
| `diffCoverage.total` | totalLines | 增量总行数 |
| `diffCoverage.missing` | uncoveredLineCount | 增量未覆盖行数 |
| （无对应字段） | threshold | 默认 80% |
| `failedTests.failures` | failedTests | 用例执行失败数 |
| `failedTests.testClasses` | failedTestList | 失败用例列表 |
| `diffCoverage.files[]` | uncoveredFiles | 未覆盖文件列表 |

**uncoveredFiles 结构**：

| 子字段 | 说明 | 示例 |
|--------|------|------|
| `filename` | 文件名 | ReportBaseInfoServiceImpl.java |
| `package` | 包名 | com.huawei.codecov.oldparser.service.job.impl |
| `coverage` | 覆盖率 | 0% |
| `branchCoverage` | 分支覆盖率 | 0% |
| `uncoveredLines` | 未覆盖行号 | [29, 30, 31] 或 [] |

**全限定类名拼接规则**：`{package}.{filename去除.java后缀}`

**阈值处理规则**：
- MR 链接场景：从 `jobs[0].diffCoverThreshold` 获取阈值，若输出中无阈值则询问用户
- codecov 报告链接场景：默认使用 80%

**分析失败处理**：
- 若命令执行失败，输出错误信息并**终止执行**
- 若无法解析输出，提示用户检查链接是否正确

### Step 2: 展示门禁问题

根据步骤 1 的分析结果，展示当前门禁问题。

**MR 链接场景**：

```
==========================================
MR 门禁分析报告
==========================================

MR: {url}
服务: {service}
语言: {language}
Job ID: {jobId}
源分支: {sourceBranch}
目标分支: {targetBranch}
```

**codecov 报告链接场景**：

```
==========================================
CodeCov 报告门禁分析报告
==========================================

CodeCov 报告: {url}
Job ID: {jobId}
语言: {language}
```

门禁状态:
┌──────────────────┬────────────────────────┬──────────────┐
│ 指标             │ 当前值                 │ 阈值         │
├──────────────────┼────────────────────────┼──────────────┤
│ 增量覆盖率       │ {coverage}% ({coveredLines}/{totalLines}) │ {threshold}% │
│ 用例通过率       │ {testPassRate}         │ {testPassThreshold} │
│ 用例失败数       │ {failedCnt}            │ 0            │
└──────────────────┴────────────────────────┴──────────────┘

问题清单:
- [覆盖率不达标] 当前 {coverage}% < 阈值 {threshold}%，差距 {gap}%
- [用例失败] {failedCnt} 个用例执行失败

未覆盖文件详情:
- com.example.Service.java — 覆盖率 45%，未覆盖行: 27,45,67-70

需要修复的文件:
- 覆盖率不足: {N1} 个类
- 用例失败: {N2} 个测试类
==========================================
```

若覆盖率已达标且无失败用例，输出提示并**终止执行**。

### Step 3: 创建修复任务队列

根据步骤 2 的问题清单，为每个需要修复的文件创建独立任务。

#### 任务合并规则

以业务类为粒度合并任务：若同一业务类同时存在覆盖率不足和用例失败问题，合并为一个任务。

**任务创建模板**：保留各任务标题和详情；使用 `todo` 的 `op: "init"` 将所有标题作为 `items` 建立队列，并保存每个标题对应的完整任务内容：

**仅覆盖率不足**：

标题：`补充 {ClassName} 的增量覆盖率`

任务内容：`【门禁修复-覆盖率补充】\n\n链接: {url}\n业务类: {sourceClass}\n测试类: {testClass}\n源分支: {sourceBranch}\n目标分支: {targetBranch}\n当前覆盖率: {currentCoverage}%\n分支覆盖率: {branchCoverage}%\n未覆盖行: {uncoveredLines}\n目标阈值: {threshold}%\n覆盖率模式: incremental\n\n目标：针对未覆盖行 {uncoveredLines} 补充测试用例，使增量覆盖率达到{threshold}%，并且断言有效性检查无问题。`

**仅用例失败**：

标题：`修复 {ClassName} 的失败用例`

任务内容：`【门禁修复-用例修复】\n\n链接: {url}\n业务类: {sourceClass}\n测试类: {testClass}\n失败用例: {failedMethods}\n源分支: {sourceBranch}\n目标分支: {targetBranch}\n覆盖率模式: incremental\n\n目标：修复失败的测试用例，确保所有用例通过，覆盖率达到{threshold}%，并且断言有效性检查无问题。`

**覆盖率不足 + 用例失败（合并）**：

标题：`修复 {ClassName} 的失败用例并补充增量覆盖率`

任务内容：`【门禁修复-用例修复+覆盖率补充】\n\n链接: {url}\n业务类: {sourceClass}\n测试类: {testClass}\n失败用例: {failedMethods}\n源分支: {sourceBranch}\n目标分支: {targetBranch}\n当前覆盖率: {currentCoverage}%\n分支覆盖率: {branchCoverage}%\n未覆盖行: {uncoveredLines}\n目标阈值: {threshold}%\n覆盖率模式: incremental\n\n目标：先修复失败的测试用例，再针对未覆盖行 {uncoveredLines} 补充测试用例使增量覆盖率达到{threshold}%，确保所有用例通过，并且断言有效性检查无问题。`

**prompt 中只传入当前文件的详情，不允许传入多个文件的详情信息。**

> 注意：任务由 Step 4 按创建顺序串行调度，无需设置 blockedBy 依赖链。

### Step 4: 串行执行任务

按任务创建顺序，逐一执行：

1. 用 `todo` 的 `op: "start"` 和逐字标题 `task` 标记开始。
2. 调用一次 `task`，仅传入当前文件完整任务内容：

```json
{
  "context": "按当前文件的门禁问题执行修复",
  "tasks": [{
    "agent": "developer-test-agent",
    "task": "<当前文件完整任务内容>",
    "solutionSpace": "按门禁问题修复测试并满足指定阈值"
  }]
}
```

3. 等待该子代理完成；若返回缺失信息和待询问题，用 `ask` 收集答案并交回或附上任务内容重新委托，不得猜测或声称已完成。
4. 用 `todo` 的 `op: "done"` 和同一逐字标题 `task` 标记完成，再启动下一个任务。

#### 错误处理

| 场景 | 处理方式 |
|------|---------|
| 单个文件修复失败 | 标记任务完成，记录失败原因，继续执行下一个任务 |
| Agent 执行超时 | 记录超时，标记任务完成，继续执行下一个任务 |

**核心原则**：单个任务失败不阻塞后续任务执行。

### Step 5: 增量覆盖率验证

所有修复任务执行完毕后，验证增量覆盖率是否达标。

#### Step 5.1: 前置检查

检查本地分支与源分支是否一致，并获取远端跟踪分支信息。

执行 `node "{{pluginRoot}}/scripts/local-gitbranch.js" "{sourceBranch}" "{targetBranch}" "{gitPath}"`，解析输出中的检查结果：

- 如果输出 `ok: true`，记录 `remoteTracking` 字段用于 Step 5.3 的 `--targetbranch` 参数，继续执行
- 如果输出 `ok: false`，根据 `reason` 使用 `ask` 提醒用户操作，用户处理完后重新执行脚本，循环直到 `ok: true`

| reason | 含义 | 提醒用户操作 |
|--------|------|-------------|
| `BRANCH_MISMATCH` | 当前分支与源分支不一致 | 提示用户执行 `git checkout {sourceBranch}` |
| `NO_REMOTE` | 未找到代码仓对应的远端配置 | 提示用户执行 `git remote add <name> {gitPath}` |
| `NO_REMOTE_BRANCH` | 远端分支不存在 | 提示用户执行 `git fetch {remoteName}` |
| `GIT_ERROR` | 无法获取当前分支 | 提示用户确认当前目录是否为 Git 仓库 |
| `INVALID_ARGS` | 脚本参数错误 | 提示用户检查参数 |

不可跳过分支检查直接执行增量覆盖率分析。

#### Step 5.2: 收集测试类列表

从修复任务执行结果中收集所有涉及的全限定测试类名，拼接为逗号分隔的字符串。

#### Step 5.3: 执行增量覆盖率分析

**Maven 配置提取**：
- 执行 `node "{{pluginRoot}}/skills/fix-ut/scripts/java/extract-maven-config.js" <projectDir>` 获取 Maven 配置
- 脚本无输出时从 AGENTS.md/DT_AGENTS.md 读取，都没有则使用默认配置

**有 Maven 配置时**：
```bash
codecovcli analyze --tests "{testClasses}" --scenario incremental --targetbranch "{remoteTracking}" --settings "{settingsPath}" --param "{mavenProperties}"
```

**无 Maven 配置时（默认）**：
```bash
codecovcli analyze --tests "{testClasses}" --scenario incremental --targetbranch "{remoteTracking}"
```

#### Step 5.4: 判断是否达标

解析增量覆盖率分析结果：
- **覆盖率 ≥ 阈值且无失败用例**：达标，进入 Step 6
- **覆盖率 < 阈值或有失败用例**：未达标，回到 Step 2 重新分析问题，创建新的修复任务

#### Step 5.5: 循环控制

| 参数 | 值 |
|------|---|
| 最大循环次数 | 3 |
| 每次循环的阈值 | 不变 |

**循环终止条件**（满足任一即停止）：
1. 增量覆盖率 ≥ 阈值且无失败用例
2. 已达到最大循环次数（3 次）

**达到最大循环次数仍未达标时**：
- 输出当前覆盖率和差距
- 提示用户可能需要手动补充测试

### Step 6: 输出执行报告

所有修复和验证完成后，汇总输出执行报告。

```
==========================================
MR/CodeCov 门禁修复报告
==========================================

链接: {url}
覆盖率阈值: {threshold}%
代码总行数：{totalLines}
覆盖代码行数：{coveredLines}

门禁状态:
┌──────────────────┬──────────────┬──────────────┐
│ 指标             │ 修复前       │ 修复后       │
├──────────────────┼──────────────┼──────────────┤
│ 增量覆盖率       │ {beforeCov}% │ {afterCov}%  │
│ 用例失败数       │ {beforeFail} │ {afterFail}  │
└──────────────────┴──────────────┴──────────────┘

修复轮次: {rounds}
循环状态: {达标/未达标（已达最大循环次数）}

任务执行结果:
┌──────┬─────────────────────┬──────────┬──────────────────────────┐
│ ID   │ 文件                │ 类型     │ 说明                      │
├──────┼─────────────────────┼──────────┼──────────────────────────┤
│ 1    │ Service.java        │ 覆盖率   │ 覆盖率 85%，达标            │
│ 2    │ ServiceTest.java    │ 用例修复 │ 3 个用例已修复              │
└──────┴─────────────────────┴──────────┴──────────────────────────┘

执行汇总:
- 成功: {X}
- 失败: {Z}
- 总任务: {Total}

==========================================
```

---

## 4. 版本testcodecheck检查任务流程

### Step 1: 检查 codecheck 是否已安装及版本更新

加载安装文档进行检查：使用 `read` 工具读取 `{{pluginRoot}}/skills/fix-ut/references/java/codecheck-check.md`，按文档检查 codecheck 安装状态及版本更新。

### Step 2: 下载告警数据文件，获取告警数据

使用 codecheck 获取告警数据：

```bash
codecheck version-defect --taskUrl {url}
```

执行命令后得到以下结果：
- **文件路径**：测试文件路径
- **方法名**：问题所在测试方法名
- **规则**：问题规则类型（Java是否虚假断言 / Java是否存在断言检查 / Java是否中途退出）
- **问题描述**：问题描述
- **代码片段**：问题代码片段
- **代码行**：问题代码行号

**告警分组概览输出**：

```
告警分组结果：
- 测试类: OrderServiceTest.java (3 个告警)
  - testConvert: Java是否虚假断言
  - testUpdate: Java是否存在断言检查
  - testProcess: Java是否中途退出
- 测试类: PaymentServiceTest.java (2 个告警)
  - testPay: Java是否虚假断言
  - testValidate: Java是否缺少断言

总计: {M} 个测试类, {N} 个告警
```

### Step 3: 按类分组并创建任务队列

为 Step 2 分组后的每个测试类创建一个独立任务：用 `todo` 的 `op: "init"` 将所有标题作为 `items` 建立队列，并保存标题对应的完整任务内容。

标题：`修复 {ClassName} 中的无效断言`

任务内容：`测试文件: {filePath}\n告警数: {alertCount}\n告警详情:\n{alerts}\nMaven配置: {mavenConfig}`

**prompt 中只传入当前测试类的告警详情，不允许传入多个类的告警信息。**

> 注意：任务由步骤 4 按创建顺序串行调度，无需设置 blockedBy 依赖链。

### Step 4: 串行执行任务

按任务创建顺序，逐一执行：

1. 用 `todo` 的 `op: "start"` 和逐字标题 `task` 标记开始。
2. 调用一次 `task`，仅传入当前测试类完整任务内容：

```json
{
  "context": "按当前测试类告警执行修复",
  "tasks": [{
    "agent": "developer-test-agent",
    "task": "<当前测试类完整任务内容>",
    "solutionSpace": "按告警修复测试断言"
  }]
}
```

3. 等待该子代理完成；若返回缺失信息和待询问题，用 `ask` 收集答案并交回或附上任务内容重新委托，不得猜测或声称已完成。
4. 用 `todo` 的 `op: "done"` 和同一逐字标题 `task` 标记完成，再启动下一个任务。

#### 错误处理

| 场景 | 处理方式 |
|------|---------|
| 单个类修复失败 | 标记任务完成，记录失败原因，继续执行下一个任务 |
| Agent 执行超时 | 记录超时，标记任务完成，继续执行下一个任务 |

**核心原则**：单个任务失败不阻塞后续任务执行。

### Step 5: 输出执行报告

所有任务执行完毕后，汇总输出执行报告：

```
==========================================
fix-testcodecheck 修复报告
==========================================

taskUrl: {url}
覆盖率模式: class-level

告警统计:
- 总告警数: {Total}
- 涉及测试类: {ClassCount}

任务执行结果:
┌──────┬─────────────────────┬──────────┬──────────────────────────┐
│ ID   │ 测试类               │ 状态     │ 说明                      │
├──────┼─────────────────────┼──────────┼──────────────────────────┤
│ 1    │ OrderServiceTest    │ 完成     │ 修复 3 个告警              │
│ 2    │ PaymentServiceTest  │ 完成     │ 修复 2 个告警              │
└──────┴─────────────────────┴──────────┴──────────────────────────┘

执行汇总:
- 成功: {X}
- 失败: {Z}
- 总任务: {Total}

==========================================
```

---

## 硬性约束

1. 链接为空时必须提示用户输入，不得跳过交互
2. MR 链接场景覆盖率阈值缺失时必须询问用户；codecov 报告场景无阈值字段时默认使用 80%
3. 每个任务的 prompt 仅包含当前文件信息，严禁跨文件混入
4. 串行执行中，单个任务失败不阻塞后续任务执行
5. 所有 DT 工作必须通过 `task` 委托给 `developer-test-agent`，不得由主 Agent 直接操作
6. 任务由主 Agent 按创建顺序串行调度，无需设置 blockedBy 依赖链
7. 循环验证最多 3 轮，避免无限循环
8. 增量覆盖率验证时，必须通过 `local-gitbranch.js` 脚本检查本地分支状态，循环调用直到 `ok: true`
9. Maven 配置获取优先级：extract-maven-config.js 脚本 → 目标项目 AGENTS.md → 默认命令
10. codecovcli 命令执行超时设为 20 分钟（1200000ms）
11. codecovcli 如果失败禁止使用jacoco执行代码覆盖率，如果codecovcli执行失败了要引导用户去处理
12. **禁止使用 Team 模式**：任务必须按队列顺序每次只启动一个 `task` 并等待完成
