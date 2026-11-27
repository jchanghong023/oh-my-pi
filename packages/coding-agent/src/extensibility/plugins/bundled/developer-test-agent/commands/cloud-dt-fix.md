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

若命令已传入 `{url}`，直接使用；否则 MUST 用 `ask` 获取链接：

```json
{"html":"<form><label>请输入待修复的 MR、CodeCov 报告或版本 testcodecheck 链接：<input type=\"text\" name=\"url\" required></label></form>"}
```
使用返回的 `url` 字段；取消或未提交链接则终止。

下文 `q(...)` 表示 MUST 将完整值编码为 Bash 单参数：加外层单引号，值中的每个单引号替换为 `'\''`。NEVER 将外部值直接插入双引号或未加引号的命令中。

前置云端查询不得改动项目工作树；CLI 需写入告警数据或缓存时用临时目录。

### 2. 判断链接类型并路由

解析 HTTP(S) URL，无法解析则停止并提示用户。只按路径分类，并在后续步骤沿用该类型：

- 路径以 `/merge_requests/<id>` 结尾（允许末尾 `/`）→ [MR 门禁修复](#3-门禁修复流程mr--codecov-报告)
- 路径为 `/code-cov-web/dtReport/<jobId>`（允许末尾 `/`）→ [CodeCov 门禁修复](#3-门禁修复流程mr--codecov-报告)
- 其他 → [版本 testcodecheck 检查任务](#4-版本testcodecheck检查任务流程)

---

## 3. 门禁修复流程（MR / codecov 报告）

### Step 0: 检查 codecovcli 是否已安装及版本更新

加载安装文档进行检查：使用 `read` 工具读取 `{{pluginRoot}}/skills/fix-ut/references/java/codecovcli-check.md`，按文档检查 codecovcli 安装状态及版本更新。

### Step 1: 获取分析数据

根据链接类型执行不同的 codecovcli 分析命令，获取门禁执行信息。

沿用步骤 2 的链接类型。CodeCov 报告的 `jobId` 为路径中紧接 `dtReport/` 的段，不含查询串或片段。

**MR 链接场景**：

```bash
codecovcli analyze --scenario mr --mrpath q(url)
```

**codecov 报告链接场景**：

```bash
codecovcli analyze --scenario codecovJobId --codecovid q(jobId)
```

从输出中解析以下信息。两种场景的返回结构不同，需分别处理：

#### MR 链接场景输出结构

MUST 遍历 `jobs[]`。逐个判定是否需要修复；对每个待修复 job 独立执行 Step 2–5，保留其分支、阈值、失败列表及覆盖率，不跨 job 合并数据。汇总全部 job 的结果。下表中 `job` 表示当前项：

| 输出字段 | 映射到 | 说明 |
|----------|--------|------|
| `job.serviceName` | service | 服务名称 |
| `job.language` | language | 语言 |
| `job.jobId` | jobId | codecov 任务 ID |
| `job.sourceBranch` | sourceBranch | 源分支 |
| `job.targetBranch` | targetBranch | 目标分支 |
| `codeRepository` | gitPath | 代码仓地址 |
| `job.diffCoverage.coverage` | incrementalCoverage | 增量覆盖率 |
| `job.diffCoverage.total` | totalLines | 增量总行数 |
| `job.diffCoverage.missing` | uncoveredLineCount | 增量未覆盖行数 |
| `job.diffCoverThreshold` | threshold | 覆盖率阈值 |
| `job.failedTests.failures` | failedTests | 用例执行失败数 |
| `job.failedTests.testClasses` | failedTestList | 失败用例列表 |
| `job.testActualValue` | testPassRate | 用例通过率实际值 |
| `job.testThreshold` | testPassThreshold | 用例通过率阈值 |
| `job.diffCoverage.files[]` | uncoveredFiles | 未覆盖文件列表 |

#### codecov 报告链接场景输出结构

返回 JSON 平铺结构：

| 输出字段 | 映射到 | 说明 |
|----------|--------|------|
| `branchInfo.language` | language | 语言 |
| `branchInfo.jobId` | jobId | 任务 ID |
| `branchInfo.codeBranch` | sourceBranch | 代码分支 |
| （无对应字段） | targetBranch | 修复前通过 `ask` 获取该报告实际使用的增量对比目标分支 |
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
- MR 链接场景：从当前 `job.diffCoverThreshold` 获取阈值；缺失时询问用户。
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

当前 job 的覆盖率已达标且无失败用例 → 记录通过，继续检查下一 job；只有全部 job 都不需要修复时才结束，无需调度任务。

若 CodeCov 报告需要修复，进入 Step 3 前必须用 `ask` 获取该报告实际用于增量对比的目标分支名，并保存为 `targetBranch`，后续修复任务及本地检查均使用此值。不得使用空值、远端默认分支或推测值；用户无法提供时终止流程并说明原因。

#### 本地仓库及分支前置检查

在创建、委托修复任务和修改任何项目文件之前，MUST 在当前工作目录获取 `git rev-parse --show-toplevel` 的仓库根目录，并执行：

```bash
node q({{pluginRoot}}/scripts/local-gitbranch.js) q(sourceBranch) q(targetBranch) q(gitPath)
```

在 `bash` 中把 `cwd` 固定为该仓库根目录。只在脚本返回 `ok: true` 时继续；记录 `remoteTracking`。失败按下表处理后重查；无法修正则不得修复该 job。NEVER 自动切换分支或工作树。每次委托（含澄清后重新委托）及 Step 5 验证前在同一工作树重查。

| reason | 提醒用户操作 |
|--------|-------------|
| `BRANCH_MISMATCH` | 切换至 `sourceBranch` |
| `NO_REMOTE` | 为 `gitPath` 配置匹配的远端 |
| `NO_REMOTE_BRANCH` | 按脚本提示抓取目标分支，并确认 fetch refspec 映射 |
| `GIT_ERROR` | 检查当前目录及 Git 仓库状态 |
| `INVALID_ARGS` | 用 `ask` 获取正确仓库或分支参数 |

### Step 3: 创建修复任务队列

根据步骤 2 的问题清单，为每个需要修复的文件创建独立任务。

#### 任务合并规则

以业务类为粒度合并任务：若同一业务类同时存在覆盖率不足和用例失败问题，合并为一个任务。

**任务创建模板**：为当前 job 和修复轮次创建新 `phase`，用 `todo` 的 `op: "append"` 将标题作为 `items` 加入，不覆盖已有待办；若标题重复则加 job、轮次或本次运行后缀。保存实际标题对应的完整内容：

**仅覆盖率不足**：

标题：`补充 {ClassName} 的增量覆盖率`

任务内容：`【门禁修复-覆盖率补充】\n\n链接: {url}\n业务类: {sourceClass}\n测试类: {testClass}\n源分支: {sourceBranch}\n目标分支: {targetBranch}\n当前覆盖率: {currentCoverage}%\n分支覆盖率: {branchCoverage}%\n未覆盖行: {uncoveredLines}\n目标阈值: {threshold}%\n覆盖率模式: incremental\n\n目标：针对未覆盖行 {uncoveredLines} 补充测试用例，使增量覆盖率达到{threshold}%，并且断言有效性检查无问题。`

**仅用例失败**：

标题：`修复 {ClassName} 的失败用例`

任务内容：`【门禁修复-用例修复】\n\n链接: {url}\n业务类: {sourceClass}\n测试类: {testClass}\n失败用例: {failedMethods}\n源分支: {sourceBranch}\n目标分支: {targetBranch}\n覆盖率模式: incremental\n\n目标：修复失败的测试用例，确保所有用例通过，并保持覆盖率达标、断言有效。`

**覆盖率不足 + 用例失败（合并）**：

标题：`修复 {ClassName} 的失败用例并补充增量覆盖率`

任务内容：`【门禁修复-用例修复+覆盖率补充】\n\n链接: {url}\n业务类: {sourceClass}\n测试类: {testClass}\n失败用例: {failedMethods}\n源分支: {sourceBranch}\n目标分支: {targetBranch}\n当前覆盖率: {currentCoverage}%\n分支覆盖率: {branchCoverage}%\n未覆盖行: {uncoveredLines}\n目标阈值: {threshold}%\n覆盖率模式: incremental\n\n目标：先修复失败的测试用例，再针对未覆盖行 {uncoveredLines} 补充测试用例使增量覆盖率达到{threshold}%，确保所有用例通过，并且断言有效性检查无问题。`

**prompt MUST 包含当前文件详情及已验证的仓库根目录，NEVER 混入多个文件的详情。** 将模板中的 `目标分支` 值设为检查返回的 `remoteTracking`，供子代理本地覆盖率分析；父流程保留云端 `targetBranch` 用于检查。子代理 MUST 核对实际目标路径及当前源分支后才修改测试；不一致则返回阻断原因。

> 注意：任务由 Step 4 按创建顺序串行调度，无需设置 blockedBy 依赖链。

### Step 4: 串行执行任务

按任务创建顺序，逐一执行：

1. 重做本地仓库及分支前置检查。仅在 `todo` 的 `view` 没有其他进行中任务时，用 `op: "start"` 和逐字标题 `task` 标记开始；NEVER 改动其他任务状态。
2. 调用一次 `task`，仅传入当前文件完整任务内容：

```json
{
  "context": "按当前文件的门禁问题执行修复",
  "tasks": [{
    "agent": "developer-test-agent",
    "isolated": false,
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

当前 job 的修复任务执行完毕后，在同一工作树重做分支前置检查，再使用返回的 `remoteTracking` 验证增量覆盖率。

#### Step 5.1: 收集测试类列表

从修复任务执行结果中收集所有涉及的全限定测试类名，拼接为逗号分隔的字符串。

#### Step 5.2: 执行增量覆盖率分析

**Maven 配置提取**：
- 执行 `node q({{pluginRoot}}/skills/fix-ut/scripts/java/extract-maven-config.js) q(projectDir)`，解析 `settingsPath`、`mavenProperties`、`vmOptions`。无输出、返回 `{}` 或三项均为空 → 读取目标项目 AGENTS.md/DT_AGENTS.md；均无配置才使用默认命令。
- 仅在字段非空时使用 `--settings` 或 `--param`。把 `mavenProperties` 数组的各个 `-Dkey=value` 参数以空格连接为 `propertyArg`，整个值用 `q(propertyArg)` 编码。若某项含空白且无法确认当前 CodeCov CLI 的无损编码，停止验证并报告；NEVER 拆分或丢弃该参数。
- 有 `vmOptions` 时，在 `codecovcli` 命令前加 `MAVEN_OPTS="${MAVEN_OPTS:+$MAVEN_OPTS }"q(vmOptions)`，让其启动的 Maven 从环境继承 JVM 选项，并保留已有 `MAVEN_OPTS`；否则不设置该变量。

**有 Maven 配置时**：
```bash
codecovcli analyze --tests q(testClasses) --scenario incremental --targetbranch q(remoteTracking) --settings q(settingsPath) --param q(propertyArg)
```

**无 Maven 配置时（默认）**：
```bash
codecovcli analyze --tests q(testClasses) --scenario incremental --targetbranch q(remoteTracking)
```

#### Step 5.3: 判断是否达标

解析增量覆盖率分析结果：
- **覆盖率 ≥ 阈值且无失败用例**：记录当前 job 达标，继续下一 job；全部处理后进入 Step 6
- **覆盖率 < 阈值或有失败用例**：未达标，回到 Step 2 重新分析问题，创建新的修复任务

#### Step 5.4: 循环控制

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

按 jobId 分列汇总；包含通过、无法修复及已修复的任务，覆盖率和阈值不跨 job 合并。

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
codecheck version-defect --taskUrl q(url)
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

创建任务前 MUST 获取当前工作树根目录。逐个核对告警的测试文件路径能在该工作树内对应到唯一实际文件（解析链接后的路径也 MUST 位于根目录内）；若无法确认，跳过该文件并报告原因，NEVER 在其他工作树修改文件。为每个确认的测试类建立独立任务，通过 `todo` 的 `op: "append"` 将标题作为 `items` 加到本次运行的新 `phase`，保留已有待办；重复标题加本次运行后缀，保存实际标题及完整内容。

标题：`修复 {ClassName} 中的无效断言`

任务内容：`仓库根目录: {repoRoot}\n测试文件: {filePath}\n告警数: {alertCount}\n告警详情:\n{alerts}\nMaven配置: {mavenConfig}`。子代理 MUST 在修改前核对路径仍位于给定工作树。

**prompt 中只传入当前测试类的告警详情，不允许传入多个类的告警信息。**

> 注意：任务由步骤 4 按创建顺序串行调度，无需设置 blockedBy 依赖链。

### Step 4: 串行执行任务

按任务创建顺序，逐一执行：

1. 仅在 `todo` 的 `view` 没有其他进行中任务时，用 `op: "start"` 和逐字标题 `task` 标记开始；NEVER 改动其他任务状态。
2. 调用一次 `task`，仅传入当前测试类完整任务内容：

```json
{
  "context": "按当前测试类告警执行修复",
  "tasks": [{
    "agent": "developer-test-agent",
    "isolated": false,
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
8. 门禁修复委托和增量验证前 MUST 通过 `local-gitbranch.js`，且只在已检查的工作树内修改文件
9. Maven 优先使用提取脚本的非空配置，再查 AGENTS.md/DT_AGENTS.md，最后才使用默认命令
10. codecovcli 命令执行超时设为 20 分钟（1200000ms）
11. codecovcli 如果失败禁止使用jacoco执行代码覆盖率，如果codecovcli执行失败了要引导用户去处理
12. 任务必须按队列顺序每次只启动一个 `task` 并等待完成
