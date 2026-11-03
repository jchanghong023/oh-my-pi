---
name: generate-ut
description: 单元测试生成专家。为代码生成高质量单元测试，涵盖函数分析、依赖识别、Mock策略、测试设计、用例生成全流程。根据被测代码语言自动加载对应语言专属规则。
---

# 单元测试生成器

为代码生成高质量单元测试，强调分析先于编码、反模式防护、按需读取、构建系统弹性回退和代码质量保障。

## 核心原则

1. **分析先于编码**：必须完成函数特性分析、控制流/数据流/边界条件分析后方可生成代码。每个步骤的分析结果必须在TodoWrite中显式记录关键结论，不得仅"内联思考"而不输出
2. **不修改被测代码**：严禁修改生产代码；仅新增测试文件、fixture、stub；如需修改必须先询问用户并获得同意
3. **上下文隔离**：依赖识别完成后，后续步骤禁止直接读取被测源文件，只读取提炼的上下文文档
4. **数据清理强制**：每个用例必须在内部清理Mock、恢复状态、释放资源
5. **断言质量保障**：禁止无断言、永真断言、仅NoThrow断言，必须验证具体业务属性或可观测状态变更
6. **流程严格执行与渐进式修复**：使用TodoWrite跟踪流程，不得跳过步骤；编译/执行失败时持续修复直到成功或遇到无法解决的问题
7. **按需读取**：优先使用grep/语义搜索定位目标函数；参考文件按需读取，不强制全部读取

## 反模式禁令

反模式禁令（Mock误用、断言误用、编码误用、代码修改禁令）详见各语言reference中的反模式禁令章节。

## 用户自定义经验（可选）

1. 使用 Read 工具读取目标项目根目录下 `.dtagent/experience.json`
2. 如果文件存在，解析 JSON 数组，过滤 `phases` 包含 `"generate"` 的条目
3. 对每个匹配的条目，使用 Read 工具读取 `path`（绝对路径）指定的经验文件
4. 将用户经验内容作为对应语言 references 的**补充约束**

**优先级规则：**
- 本 SKILL.md 中的**硬性约束**：用户经验**不可覆盖**
- 对应语言 references 中的**策略建议**：用户经验**优先于**内置策略
- 项目特有的**补充知识**：用户经验作为**额外上下文**

如果 `.dtagent/experience.json` 不存在，跳过此步骤。

## 语言路由（强制执行）

检测被测代码语言后，**必须读取对应语言的专属reference**获取语言特定的生成规则、Mock框架指南、断言规范、命名规范等：

| 语言 | 触发条件 | 必读reference |
|------|----------|---------------|
| **Java** | 被测文件以 `.java` 结尾 | `references/java/generation-rules.md` |
| **C/C++** | 被测文件以 `.c`/`.cpp`/`.cc`/`.cxx`/`.h`/`.hpp`/`.hxx` 结尾 | `references/cpp/generation-rules.md` |
| **Go** | 被测文件以 `.go` 结尾 | `references/go/generation-rules.md` |
| **Python** | 被测文件以 `.py` 结尾 | `references/python/generation-rules.md` |

语言检测后，若入口文件中引用了子文件则按需读取；若入口文件为自包含（无子文件引用），则直接按入口文件内容执行，不报错。新增语言时只需创建入口文件即可完成基本流程，子文件可后续按需补充。

## 工作流程

### 步骤执行规范（强制遵守）

- **禁止无声跳过**：任何步骤如果因前置条件已满足而跳过部分子步骤，必须在TodoWrite中记录跳过了哪些子步骤及原因
- **每个步骤至少一条输出**：即使步骤快速完成，也必须输出该步骤的关键结论
- **跳过声明格式**：在TodoWrite对应步骤条目中追加`[跳过: 子步骤X-Y，原因: xxx]`标记

使用TodoWrite严格按照以下步骤执行：

### 步骤1：被测函数识别

**用户直接指定** — 用户明确提供被测函数代码、名称或文件路径，直接进入步骤2

**搜索策略**：优先使用grep/语义搜索定位目标函数，避免广度枚举。

**函数存在性验证门**：识别被测函数后，确认函数在源码中实际存在。如果任务描述的函数不存在：
1. 使用grep搜索整个项目确认该函数确实不存在
2. 使用glob搜索相似命名的模块/文件
3. 在输出中标注错配
4. 测试实际存在的最接近函数
5. 在输出总结中包含期望-测试映射表

**必须输出**：被测函数完整签名、信息来源、跳过搜索的原因（如有）

### 步骤2：项目环境与测试框架识别

1. **优先检查用户prompt**：检查用户prompt中是否已指定编译命令、工程根目录、测试框架等信息。如果用户已提供完整信息，直接使用
2. **构建配置获取**：若用户prompt未提供，从项目结构推断构建配置
3. **框架选择决策**：按语言专属reference中的框架选择决策执行：
    - 被测函数不需要Mock外部依赖 → 使用纯测试框架，不引入任何Mock框架
    - 需要Mock → 按决策流程选择合适的Mock框架
4. **检查已有测试模式**：读取项目中已有的测试文件，分析Fixture基类、Mock使用模式、数据构造辅助函数，保持风格一致

**必须输出**：编译命令、测试框架选择、Mock框架选择、信息来源

### 步骤3：依赖识别与上下文获取（强制执行）

#### 3.1 确定测试文件路径

用户提供了则直接使用，否则按语言专属reference中的路径推导规则确定。

#### 3.2 调用链与依赖识别

**核心逻辑**：先搞清楚被测函数调用了谁、哪些是外部依赖，再决定需要获取哪些上下文。

按语言专属reference中的依赖分析方法执行：
- 内部依赖（禁止Mock）：同类成员函数、同模块内部函数
- 外部依赖（必须Mock）：实现不在本类或本文件中的函数
- 严禁将内部依赖误判为外部依赖

#### 3.3 针对性上下文获取

基于依赖分类结果，精准获取写测试所需的上下文：
- 被测函数体
- 外部依赖函数的签名
- 输入/输出参数的类型定义
- 被测函数的头文件/声明

**上下文隔离**：步骤3完成后，后续步骤禁止直接读取被测源文件，只读取提炼后的上下文文档。

**必须输出**：测试文件路径、依赖分类汇总（内部依赖列表 + 外部依赖/Mock目标列表）、上下文文件列表

### 步骤4：函数特性分析与测试设计（强制执行）

**必须完成以下分析后方可生成代码。**

#### 4.1 函数特性分析

1. **函数类型识别**：识别被测函数类型（计算型/状态变更型/协调型/IO型等）
2. **复杂度评估**：圈复杂度、代码行数、参数数量、外部依赖数量
3. **输入输出分析**：参数分类、输出分析、边界条件识别
4. **控制流追踪**：对每个测试场景，追踪函数的精确控制流路径，特别注意早返回和短路退出路径
5. **参数类型定义提取**：对结构体、枚举等类型，必须定位其类型定义并提取逐字段信息

若语言专属reference中提供了更详细的函数分类方法，按其执行。

#### 4.2 系统性测试设计

1. 控制流分析：列出所有独立路径
2. 数据流分析：覆盖定义-使用路径
3. 边界条件分析：对每个输入参数按边界矩阵系统化测试
4. 异常场景分析：识别所有资源申请点和外部调用点，设计失败场景
5. 资源泄漏分析：验证正常/异常路径资源释放
6. 优先级排序：P0（必须覆盖）、P1（应该覆盖）、P2（可以覆盖）

若语言专属reference中提供了更详细的测试设计方法，按其执行。

#### 4.3 Mock策略与校验设计

1. **Mock目标验证门**：确认每个Mock目标是被测函数代码路径中实际调用的函数
2. **Mock策略设计**：
    - 风险适配：高风险依赖深度Mock，中风险选择性Mock，低风险最小化Mock
    - 场景匹配：异常场景不Mock正常响应，边界场景不Mock普通响应
    - 最小化Mock：仅Mock必要的依赖/方法，保留内部业务逻辑的真实实现
    - 契约一致性：Mock的返回值/异常/调用行为必须严格符合依赖的真实业务契约
3. **结果校验策略**：
    - 必选校验：返回值校验、输出参数校验
    - 可选校验：Mock调用次数校验、关键Mock入参校验、状态变更校验

若语言专属reference中提供了更详细的Mock策略，按其执行。

无外部依赖时跳过，标注：`[跳过: Mock策略设计，原因: 被测函数无外部依赖]`

#### 4.4 用例数量控制与过滤

1. **无效用例剔除**：纯判空返回、安全函数包装、纯日志记录等
2. **同类分支合并**：将同一个if/else、switch逻辑对应的分支合并
3. **Mock限制过滤**：过滤因Mock框架限制无法实现的场景
4. **数量控制**：P0/P1覆盖后评估是否需要P2用例。合并后单个函数的用例总数不得超过max(10, 圈复杂度)个
5. **最终用例清单**：每个用例包含：用例名称、验证场景、优先级、所需Mock配置、校验方案

**必须输出**：函数类型识别结果、复杂度评估、独立控制流路径列表、外部依赖列表、Mock目标列表及策略、测试用例设计摘要、最终用例清单

### 步骤5：测试用例生成

按语言专属reference中的生成规则执行。核心要点：

#### 5.1 准备阶段

1. 读取步骤3获取的上下文文件、语言专属reference中的知识库
2. 按步骤2确认的Mock框架，读取对应的reference子文档（如需要）
3. 必须按照路径远近参考已有测试文件的设计和实现

#### 5.2 用例生成（按4.4最终清单逐个）

1. **增量验证策略**：先编写1个正常路径测试用例，编译运行通过后，再补充其余用例
2. **用例生成四阶段**：Mock配置 → 执行调用 → 断言校验 → 数据清理
3. **断言规范**：按语言专属reference中的断言规范严格执行
4. **命名与注释规范**：按语言专属reference中的命名规范执行，每个用例头部必须有场景+预期注释

**必须输出**：生成的测试文件路径、测试用例总数及列表、使用的Mock框架及Mock目标列表

#### 任务总结输出

- 被测函数：完整函数签名
- 测试用例数：统计本次生成的用例数量
- 测试函数：列出所有测试用例签名及描述
- 验证范围：覆盖的正常路径、边界条件、异常场景
- 未解决问题（如有）
- 期望-测试映射表（如有任务-代码错配）

#### 流水线后续步骤（不由本 SKILL 决定）

本 skill 执行完成后，后续步骤（fix-ut / improve-coverage / improve-validity / test-report）由 Agent 定义（`agents/developer-test-agent.md`）的路径规则统一决定：

- **路径 1（Skill-First）**：用户显式指定 `generate-ut` 时，Agent 定义的 generate-ut 特殊规则强制执行完整流水线（fix-ut → improve-coverage → improve-validity → test-report），跳过 Gap Analysis 条件判断
- **路径 2（关键词匹配）**：full-generate intent 同样触发完整流水线
- **单阶段声明**：用户显式指定 `fix-ut` / `improve-coverage` 等其他 skill 时，由 Agent 定义的 Gap Analysis 决定是否链式调用

**本 SKILL.md 不做流水线调度决策。** 无论 generate-ut 执行过程中是否已自行完成编译验证或覆盖率测量，均不得作为跳过后续 skill 的理由。

## Bundled Resources

### references/
- `references/java/generation-rules.md`：Java生成规则导航索引（必读入口）。子文件按需加载：
  - `hard-rules.md`（硬性规则：XTest命名/一生产类一测试类/仅修改测试代码/用例方法名≤64字符）、`phase-1-dependencies.md`（依赖信息收集）、`phase-2-context.md`（上下文信息收集：返回类型/输入参数/被测类初始化/二方件源码）、`phase-3-mocking.md`（Mock对象分析：决策原则/禁止限制/编码模式/二方件精准Mock）、`phase-4-test-design.md`（测试场景设计：用例生成规则/数量控制/最小覆盖集）、`phase-5-assertions.md`（断言质量强制：断言目标/推荐断言/非推荐断言/Flux/Mono场景）、`phase-6-output.md`（代码输出：命名规则/输出要求/JavaDoc注释模板/失败回退策略）、`binary-detector.md`（二方件反编译与查询脚本）
- `references/cpp/generation-rules.md`：C/C++生成规则导航索引（必读入口）。子文件按需加载：
   - `dependency-analysis.md`（依赖分析）、`mock-strategy.md`（Mock策略）、`assertion-specification.md`（断言规范）、`naming-and-structure.md`（命名导航）、`code-structure.md`（代码组织+extern C+#define private public）、`c-module-patterns.md`（C模块模式+测试数据构造）、`disabled-case.md`（DISABLED_CASE宏+注释规范）、`compile-and-coverage.md`（构建策略+编译器选择+覆盖率标志）、`test-design.md`（测试设计）、`anti-patterns.md`（反模式禁令21条+禁止编码方式5种）、`mockcpp-guide.md`（mockcpp指南）、`mock-framework-guide.md`（Mock框架选择决策+框架对比+gtest/gmock/binmock/AMock/mockcpp使用+malloc失败替代策略+硬件I/O Mock策略）

- `references/go/generation-rules.md`：Go生成规则导航索引（必读入口）。子文件按需加载：
  - `mock-tier-guide.md`（Mock层级F1-F13）、`test-patterns.md`（测试生成Phase 0/1/2）、`assertion-patterns.md`（断言规范+可观测验证模式+表驱动）、`coverage-and-concurrency.md`（覆盖率与并发安全）、`mock-errors-and-patterns.md`（错误诊断14种+高级模式4种）、`unavailable-mode.md`（Go不可用模式）、`anti-patterns.md`（反模式禁令14条）

- `references/python/generation-rules.md`：Python生成规则导航索引（必读入口）。子文件按需加载：
  - `project-type-strategies.md`（Flask/nameko/Standalone框架检测与mocking策略）、`branch-coverage-matrix.md`（分支覆盖矩阵模板）、`sequential-workflow-testing.md`（顺序调用+状态标志+多异常+递归+嵌套逻辑）、`attribute-and-lifecycle-patterns.md`（描述符+动态属性+context manager+semaphore+generator）、`decorator-and-closure-patterns.md`（装饰器可选参数+闭包回调捕获+contextmanager-factory）、`conditional-patterns-index.md`（条件测试规划模式）、`mock-patching-rules.md`（断言质量+mock patching规则+异常对象mock+属性初始化）、`anti-patterns.md`（反模式禁令）

### scripts/

> **Windows 路径处理（重要）**：以下脚本在 Bash 命令中调用时，路径须使用 `{SKILL_DIR}/scripts/...` 格式（`{SKILL_DIR}` 为 skill 加载时的 "Base directory"）。Windows 上该目录含反斜杠，**必须替换为正斜杠**，否则 Bash 转义导致 `Cannot find module` 错误。

- `scripts/java/binary-detector.js`：二方件源码查询脚本。步骤3上下文获取时使用。
- `scripts/java/decompile.js`：二方件反编译脚本。步骤3上下文获取时使用。
- `scripts/cpp/extract-function-callees.py`：基于libclang的C/C++函数调用链提取脚本。步骤3依赖识别时使用。
- `scripts/cpp/ut_code_analysis.js`：C/C++上下文提取脚本。步骤3上下文获取时使用。（打包文件，不要读取分析）
- `scripts/go/check-test-quality.py`：Go测试质量验证脚本（Mock注入、callCount、var _检查等）。Phase 2建议性检查。
- `scripts/python/parse_coverage.py`：Python函数级覆盖率解析脚本。覆盖率检查时使用。

### assets/
- `assets/java/cfr-0.152.jar`：CFR反编译工具jar包。`decompile.js` 依赖此文件。
- `assets/cpp/ut-knowledge.md`：UT基础知识库，提供4种Mock框架（AMOCKER、MOCKER、gtest/gmock、binmock）的详细使用说明、Mock框架选择决策树和对比表。步骤5参考。

### examples/
- `examples/cpp/test_example.cpp`：完整C/C++测试用例示例（基本结构、Mock使用、数据清理、Fixture状态跟踪、void函数状态验证、EXPECT_DEATH、#include .c模式、SetUp零重置、计算辅助函数、#define private public顺序、GIVEN阶段约束、显式NULL指针测试）。步骤5参考。
- `examples/cpp/mock_wrapper_example.h`：虚函数Mock包装层示例（非虚函数Mock的接口类→Mock类→适配器三步法）。步骤5参考。
- `examples/python/test-patterns.md`：Python测试用例示例。步骤5参考。
