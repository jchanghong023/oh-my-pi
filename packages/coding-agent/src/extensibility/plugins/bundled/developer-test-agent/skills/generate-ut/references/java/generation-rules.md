# Java 单元测试生成规则

本文件是 Java 单元测试生成的导航索引。详细规则拆分到以下子文件，按需查阅。

## 测试框架

- **测试框架**：JUnit 5 (`org.junit.jupiter.api.Test`)
- **Mock 框架**：Mockito (`org.mockito.Mock` / `@Mock` / `MockitoAnnotations.openMocks`)
- **断言库**：JUnit 5 Assertions (`org.junit.jupiter.api.Assertions`) 或 AssertJ

## 工作流程（5 阶段）

### Phase 1: 依赖信息收集

收集被测类的依赖信息：构造函数注入的依赖、字段注入的依赖、方法参数依赖、依赖方法签名收集。
详见 [phase-1-dependencies.md](./phase-1-dependencies.md)

### Phase 2: 上下文信息收集

收集被测方法的上下文：返回类型信息、输入参数信息、被测类初始化信息、二方件源码收集。
详见 [phase-2-context.md](./phase-2-context.md)

### Phase 3: Mock 对象分析

Mock 决策原则、Mock 禁止与限制、Mock 编码模式、基于二方件源码的精准 Mock。
详见 [phase-3-mocking.md](./phase-3-mocking.md)

### Phase 4: 测试场景设计

用例生成规则（严禁冗余与正交去重、精准采用测试设计技术、合并同类项）、用例数量控制。
详见 [phase-4-test-design.md](./phase-4-test-design.md)

### Phase 5: 断言质量强制

断言目标（非局部变量、参数值、返回值）、推荐断言、非推荐断言、Flux/Mono 场景。
详见 [phase-5-assertions.md](./phase-5-assertions.md)

### Phase 6: 测试类代码输出

测试类命名规则、输出要求、测试方法注释模板、推荐代码结构、失败与回退策略。
详见 [phase-6-output.md](./phase-6-output.md)

## 详细规则索引

| 主题 | 子文件 | 涵盖内容 |
|------|--------|----------|
| 硬性规则 | [hard-rules.md](./hard-rules.md) | 测试类命名（XTest）、一生产类一测试类、仅修改测试代码、用例方法名不超过64字符 |
| 依赖信息收集 | [phase-1-dependencies.md](./phase-1-dependencies.md) | 构建配置文件探查、框架确认规则、执行指引 |
| 上下文信息收集 | [phase-2-context.md](./phase-2-context.md) | 返回类型信息、输入参数信息、被测类初始化、二方件源码收集 |
| Mock 对象分析 | [phase-3-mocking.md](./phase-3-mocking.md) | Mock 决策原则、Mock 禁止与限制、Mock 编码模式（静态/spy/标准/void/链式）、二方件源码精准 Mock |
| 测试场景设计 | [phase-4-test-design.md](./phase-4-test-design.md) | 用例生成规则、等价类划分、边界值分析、用例数量控制、最小覆盖集 |
| 断言质量强制 | [phase-5-assertions.md](./phase-5-assertions.md) | 断言目标（非局部变量/参数值/返回值）、推荐断言、非推荐断言、Flux/Mono 响应式断言策略 |
| 代码输出 | [phase-6-output.md](./phase-6-output.md) | 测试类命名规则（强制）、输出要求、测试方法 JavaDoc 注释模板、推荐代码结构、失败与回退策略 |
| 二方件反编译 | [binary-detector.md](./binary-detector.md) | 反编译脚本、查询脚本、参数说明、注意事项 |

## 工作语言

始终使用简体中文作为工作语言。
