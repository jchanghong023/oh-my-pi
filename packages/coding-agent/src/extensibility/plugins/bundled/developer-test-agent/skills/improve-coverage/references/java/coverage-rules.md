# Java 单元测试覆盖率规则

本文件是 Java 单元测试覆盖率提升的导航索引。详细规则拆分到以下子文件，按需查阅。

## 测试框架

- **测试框架**：JUnit 5 (`org.junit.jupiter.api.Test`)
- **Mock 框架**：Mockito (`org.mockito.Mock` / `MockedStatic` / `MockitoAnnotations.openMocks`)
- **覆盖率工具**：codecovcli（首选）→ JaCoCo（备选）

## Maven 配置提取

执行脚本提取 Maven 配置：

> **Windows 路径处理（重要）**：`{SKILL_DIR}` 替换为 skill 加载时提供的 "Base directory" 路径。在 Windows 上该路径含反斜杠（如 `C:\Users\...\skills\improve-coverage`）。**在 Bash 命令中必须将反斜杠替换为正斜杠**（如 `C:/Users/.../skills/improve-coverage/scripts/java/extract-maven-config.js`），否则反斜杠被 Bash 转义导致 `Cannot find module` 错误。

```bash
node {SKILL_DIR}/scripts/java/extract-maven-config.js <projectDir>
```

- **有配置时**：`mvn test -q -Dtest={ClassName} -s "{settingsPath}" {mavenProperties}`
- **无配置时**：`mvn test -q -Dtest={ClassName}`
- 脚本无输出时从目标项目的 `AGENTS.md` 或 `DT_AGENTS.md` 读取 Maven 配置段，都没有则使用默认 Maven 命令。

## 覆盖率获取优先级

覆盖率数据获取按以下优先级执行，**codecovcli 失败后自动降级到 JaCoCo，无需询问用户**：

1. **首选 — codecovcli**：执行 `codecovcli analyze` 命令获取覆盖率数据
2. **备选 — JaCoCo**：codecovcli 执行失败（未安装、命令报错、超时等）后，执行 `mvn clean test jacoco:report` 命令，再通过 `extract-jacoco-coverage.js` 脚本提取覆盖率数据

两种方式输出的覆盖率缓存文件格式一致（`.codecovcli/cache/java_{className}.json`），后续未覆盖分析流程无需区分数据来源。

## codecovcli 覆盖率分析命令

- **有配置时**：`codecovcli analyze --class "{sourceClass}" --tests "{testClass}" --scenario class-level --settings "{settingsPath}" --param "{mavenProperties}"`
- **无配置时**：`codecovcli analyze --class "{sourceClass}" --tests "{testClass}" --scenario class-level`

## JaCoCo 覆盖率分析命令（备选）

codecovcli 执行失败后使用。Maven 配置提取逻辑与 codecovcli 一致（复用 `extract-maven-config.js`）。

**Step 1 — 提取 Maven 配置**：

```bash
node {SKILL_DIR}/scripts/java/extract-maven-config.js <projectDir>
```

**Step 2 — 执行 JaCoCo 测试命令**：

- **有配置时**：`mvn clean test jacoco:report -pl {module} -Dtest={testClass} -DfailIfNoTests=false -s "{settingsPath}" {mavenProperties}`
- **无配置时**：`mvn clean test jacoco:report -pl {module} -Dtest={testClass} -DfailIfNoTests=false`

**Step 3 — 提取覆盖率数据**：

```bash
node {SKILL_DIR}/scripts/java/extract-jacoco-coverage.js {className} {module}/target/site/jacoco/jacoco.xml
```

脚本从 `jacoco.xml` 中提取指定类的覆盖率信息，生成 `.codecovcli/cache/java_{className}.json`，格式与 codecovcli 输出一致。

## 覆盖率分类规则

将未覆盖语句归类为以下类型之一：

- **NULL_CHECK**: 空值检查分支
- **EXCEPTION_HANDLING**: 异常抛出或捕获路径
- **BOUNDARY_CONDITION**: 边界条件判断
- **SWITCH_CASE**: switch语句的特定case分支
- **LOOP_CONDITION**: 循环边界条件（未进入循环/提前退出）
- **BUSINESS_LOGIC**: 业务逻辑分支
- **ERROR_HANDLING**: 错误处理路径
- **DEFAULT_BRANCH**: else/default分支

## 未覆盖场景策略表

| 未覆盖类型 | 典型场景 | 推荐测试策略 |
|-----------|---------|-------------|
| **空值检查分支** | `if (obj == null)` | 传入null参数，验证异常或默认行为 |
| **异常抛出语句** | `throw new XxxException()` | 构造触发异常的条件，使用`assertThrows`验证异常类型和消息 |
| **异常捕获块** | `catch (IOException e)` | Mock依赖抛出异常，验证异常处理逻辑 |
| **Switch未覆盖case** | `case ADMIN:` | 为每个枚举值创建独立测试方法，使用`@ParameterizedTest` |
| **Switch default分支** | `default: throw new Exception()` | 传入非法枚举值或使用反射创建未知状态 |
| **循环未进入** | `for (Item item : list)` | 传入空集合`Collections.emptyList()`，验证空集合处理逻辑 |
| **循环提前退出** | `if (condition) break;` | 构造满足break条件的数据，验证提前退出行为 |
| **条件false分支** | `if (flag) {...} else {...}` | 设置flag为false，验证else分支行为 |
| **短路求值未覆盖** | `if (a && b)` | 分别测试：①a为false ②a为true但b为false ③a和b都为true |
| **边界值未覆盖** | `if (age >= 18)` | 测试边界值：17（刚好不满足）、18（刚好满足）、19（安全值） |
| **Optional空值路径** | `optional.orElse(default)` | 传入`Optional.empty()`验证默认值返回 |
| **三元运算符** | `flag ? a : b` | 分别测试flag为true和false两种情况 |
| **finally块** | `finally { cleanup(); }` | 验证正常执行和异常情况下finally都被执行 |
| **嵌套条件内层** | `if (a) { if (b) {...} }` | 构造a为true但b为false的场景 |
| **集合为空返回** | `if (list.isEmpty()) return;` | 传入空集合验证提前返回 |
| **Lambda异常路径** | `list.stream().map(...)` | 在stream操作中Mock抛出异常 |

## 路由说明

覆盖率提升执行时，根据覆盖率报告中未覆盖代码的特征，按以下入口文件路由：

- **问题场景路由** → 读取 [route.md](route.md)（按"从上到下"顺序匹配 6 场景：无测试用例、If分支、异常场景、外部依赖、静态方法Mock限制、私有方法）
- **覆盖率策略集** → 读取 [coverage-strategies.md](coverage-strategies.md)（6 类核心策略 + hdt-java 工具脚本）

## 详细规则索引

| 主题 | 子文件 | 涵盖内容 |
|------|--------|----------|
| 覆盖率问题路由 | [route.md](route.md) | 6 场景路由：无测试用例、If分支未覆盖、异常场景、外部依赖场景、静态方法Mock限制、私有方法未覆盖 |
| 覆盖率提升策略集 | [coverage-strategies.md](coverage-strategies.md) | 6 类核心策略（If分支/私有方法/静态方法Mock限制/异常处理/外部依赖未覆盖）+ hdt-java 工具脚本（codecovcli 四种场景 + JaCoCo fallback 执行） |

## 工作语言

始终使用简体中文作为工作语言。
