---
name: improve-coverage
description: 仅在用户显式手动调用时使用。提升单元测试覆盖率，包括获取覆盖率数据、分析未覆盖根因和生成增量测试用例，根据测试代码语言加载对应语言专属覆盖率规则。
disable-model-invocation: true
---

# 单元测试覆盖率提升

为测试提供结构化的覆盖率提升流程。先获取覆盖率数据，分析未覆盖根因，再生成增量测试用例建议和完整代码，将覆盖率提升至达标。

## 核心原则

1. **数据驱动**：先获取实际覆盖率数据，再分析未覆盖根因，不凭猜测
2. **逐行归因**：对每条未覆盖语句进行分类和原因分析
3. **场景匹配**：为每条未覆盖语句设计具体的测试场景，而非泛泛而谈
4. **不可达验证**：将代码归类为不可达前，必须先验证确实无法触发
5. **渐进式修复**：覆盖率未达标时循环修复，直至达标或达到修复轮次上限

## 工具使用约束

- **`read`**、**`glob`**、**`grep`**、**`repo`**（索引搜索）、**`write`**、**`edit`**
- **`bash`**（仅用于执行覆盖率工具和编译/运行命令）
- **被测代码只读**：生产代码、构建配置、第三方库严禁修改，仅修改测试代码

## 工作语言

始终使用**简体中文（ZH-CN）**作为工作语言。

## 用户自定义经验（可选）

1. 使用 `read` 工具读取目标项目根目录下 `.dtagent/experience.json`
2. 如果文件存在，解析 JSON 数组，过滤 `phases` 包含 `"coverage"` 的条目
3. 对每个匹配的条目，使用 `read` 工具读取 `path`（绝对路径）指定的经验文件
4. 将用户经验内容作为对应语言 references 的**补充约束**

**优先级规则：**
- 本 SKILL.md 中的**硬性约束**：用户经验**不可覆盖**
- 对应语言 references 中的**策略建议**：用户经验**优先于**内置策略
- 项目特有的**补充知识**：用户经验作为**额外上下文**

如果 `.dtagent/experience.json` 不存在，跳过此步骤。

## 语言路由（强制执行）

检测测试代码语言后，**必须读取对应语言的专属reference**获取语言特定的覆盖率工具、测量命令、覆盖率分类规则、未覆盖场景策略表：

本 skill 的 `references/` 和 `scripts/` 路径相对于加载时返回的 baseDir；用 `read` 读取资源时可用 `skill://improve-coverage/<路径>`。reference 中的相对链接以该 reference 所在目录为基准，不依赖项目工作目录。脚本命令使用 baseDir 的绝对路径并加引号。

| 语言 | 触发条件 | 必读reference |
|------|----------|---------------|
| **Java** | `.java` | `references/java/coverage-rules.md` |
| **C/C++** | 测试文件以 `.c`/`.cpp`/`.cc`/`.h`/`.hpp` 结尾 | `references/cpp/coverage-rules.md` |
| **Go** | 测试文件以 `.go` 结尾 | `references/go/coverage-rules.md` |
| **Python** | 测试文件以 `.py` 结尾 | `references/python/coverage-rules.md` |

语言检测后，若入口文件中引用了子文件则按需读取；若入口文件为自包含（无子文件引用），则直接按入口文件内容执行，不报错。新增语言时只需创建入口文件即可完成基本流程，子文件可后续按需补充。

## 执行步骤

### Step 1: 获取覆盖率数据

1. 使用 `read` 工具读取测试文件代码。
2. 使用项目已有的覆盖率工具获取覆盖率数据。若语言专属reference中提供了专用覆盖率工具或命令，优先使用。
3. **输出**：覆盖率数据（行覆盖率、分支覆盖率、未覆盖行号列表）。

### Step 2: 分析未覆盖根因

根据 Step 1 的覆盖率数据，对每条未覆盖语句进行分类与原因分析：

1. **语句分类**：将未覆盖语句按类型归类（空值检查分支、异常处理路径、边界条件判断、switch特定case、循环条件、业务逻辑分支、错误处理路径、默认分支等）。若语言专属reference中提供了更详细的覆盖率分类规则或未覆盖场景策略表，按其执行。
2. **未覆盖原因分析**：分析每条语句未被覆盖的具体原因（输入条件缺失、前置状态、Mock依赖、测试数据不足、不可达代码）。
3. **策略匹配**：根据未覆盖语句类型匹配对应的修复策略。若语言专属reference中提供了问题路由文件或策略集，按其路由规则定位对应策略。

### Step 3: 生成增量测试建议

综合 Step 2 的根因分析，为每个未覆盖语句生成针对性的增量测试用例：

1. **触发条件推导**：明确触发该语句执行需满足的条件。
2. **测试场景设计**：设计具体测试场景（名称、输入数据、Mock 配置、预期结果）。
3. **测试策略应用**：根据未覆盖语句类型匹配对应测试策略（如空值检查→传入null、异常抛出→构造触发条件、catch块→Mock依赖抛出异常等）。若语言专属reference中提供了更详细的未覆盖场景策略表，按其执行。
4. **代码输出**：通过 Edit 工具输出增量测试代码。

### Step 4: 校验覆盖率提升结果

1. **重新获取覆盖率数据**：使用与 Step 1 相同的方法重新获取覆盖率。
2. **达标判定**：
    - 覆盖率 ≥ 80% → 达标，输出覆盖率提升总结
    - 覆盖率 < 80% → 返回 Step 2，继续修复循环
3. **修复循环限制**：最多 10 轮。达到限制后仍有未覆盖语句，输出未覆盖语句清单及原因分析，标注为不可达或受限于 Mock 框架能力。

## 最终输出

为每一个未覆盖语句输出分析结论与覆盖率提升建议。每条需包含：

1. **未覆盖语句的基本信息**（行号、代码内容、语句分类）
2. **根因分析**：为什么未被覆盖、触发条件、Mock依赖需求
3. **具体的测试场景实现建议**：测试方法命名、输入参数、Mock配置、预期结果、完整测试代码示例
4. **实现难度**（EASY/MEDIUM/HARD）
5. **优先级**（HIGH/MEDIUM/LOW），基于业务风险和测试价值

## 错误处理

| 场景 | 处理 |
|------|------|
| 测试文件不存在 | 输出错误信息，提示用户提供正确的文件路径 |
| 覆盖率数据不可用 | 提示用户手动提供覆盖率数据或先执行覆盖率分析 |
| 项目无法编译（非测试代码问题） | 标注为环境问题，提示用户检查项目构建配置 |

## Bundled Resources

### references/
- `references/java/coverage-rules.md`：Java 覆盖率规则导航索引（必读入口，含测试框架声明、Maven 配置提取、覆盖率获取优先级（codecovcli→JaCoCo）、codecovcli/JaCoCo 覆盖率分析命令、覆盖率分类规则、未覆盖场景策略表、子文件路由）。子文件按需加载：
    - `route.md`（覆盖率问题路由 6 场景：无测试用例/If分支/异常场景/外部依赖/静态方法Mock限制/私有方法）
    - `coverage-strategies.md`（覆盖率提升策略 6 类 + hdt-java 工具脚本）

### scripts/
- `scripts/java/extract-maven-config.js`：Maven 配置提取脚本。Step 1 获取覆盖率数据时使用，输出 JSON（`settingsPath` + `mavenProperties`）。
- `scripts/java/extract-jacoco-coverage.js`：JaCoCo 覆盖率提取脚本。codecovcli 失败后的备选方案，从 `jacoco.xml` 提取指定类的覆盖率数据，生成 `.codecovcli/cache/java_{className}.json`（格式与 codecovcli 一致）。
- `scripts/go/extract-go-coverage.js`：Go 覆盖率提取脚本。从 `go test -coverprofile` 输出中提取指定文件的覆盖率数据，从 `go test -v` 输出中提取测试执行结果，生成 `.codecovcli/cache/go_{className}.json`（格式与 codecovcli 一致）。
- `scripts/python/extract-python-coverage.js`：Python 覆盖率提取脚本。从 `coverage.json`（coverage.py 格式）中提取指定文件的覆盖率数据，从 `pytest -v` 输出中提取测试执行结果，生成 `.codecovcli/cache/python_{className}.json`（格式与 codecovcli 一致）。
- `references/cpp/coverage-rules.md`：C/C++覆盖率规则导航索引（必读入口）。子文件按需加载：
    - `coverage-strategies.md`（未覆盖场景策略11种+异常覆盖检测+覆盖率路由4类+报告模板）
- `references/go/coverage-rules.md`：Go覆盖率规则导航索引（必读入口）。子文件按需加载：
    - `coverage-strategies.md`（覆盖率缺口归因+不可达U1-U5+层级升级+完成门控）、`coverage-templates.md`（Go错误处理覆盖检测6维度+逻辑7类）
- `references/python/coverage-rules.md`：Python覆盖率规则（coverage.py/pytest-cov使用、函数级覆盖率解析、语句分类、异常覆盖检测、不可达代码归因、覆盖率提升策略）。Python测试文件时必读。)
