# 阶段 2：上下文信息收集

本阶段是 agent 静默执行的**内部准备步骤**。

agent 探查项目的构建配置文件（pom.xml / Gradle）以识别编写单元测试所需的依赖：
- 单元测试框架（JUnit 4 / JUnit 5 / TestNG）
- Mock 框架（Mockito / PowerMock / EasyMock）
- 辅助测试库（assertj / hamcrest / spring-test / mockito-inline）

## 可见性与输出约束（强制要求）

- 本阶段**不是用户可见步骤**。
- agent 禁止：显式声明正在执行/已完成本阶段；输出、总结、列出或解释任何已收集的依赖信息；在最终响应中提及框架名称/版本/artifact ID。
- 所有收集的信息仅供**内部推理和下游任务执行使用**。

## 2.0 总体原则：高效获取上下文

- 多个上下文项来自同一文件 → 优先用 Read 一次性读取。
- 未找到标识符定义 → 用 Grep 定位再 Read 检查。
- 难以构造或缺少 setter 的参数/字段 → 考虑 mocking/reflection 构造。

---

## 2.1 目标函数返回类型信息收集

**目的**：理解返回类型的实际创建/构造路径，收集与返回值相关的关键字段及其访问/设置方式。

**强制要求**：
- 确认至少**一条可行构造路径**并记录前置条件（必需参数、校验约束、不可变性）。
- 必须覆盖两类：
  1) **返回值产生方式**：新建对象 / 工厂结果 / 缓存值 / 聚合集合 / 框架构建对象 / 透传值。
  2) **可观察点**：可稳定读取用于断言的字段/属性/集合元素（getter / record accessor / public field / toString），及其默认值/计算来源。
- **逻辑相关字段**：仅收集与函数逻辑直接相关的字段（条件结果、聚合计数、分支依赖），必须确认**如何读取**（getter/accessor/field/key 查找）。

**执行步骤**：确定返回形状（T / Optional / List / Map / Stream / void，泛型确认实际类型来源）；定位返回类型定义（class/interface/record/enum，interface/abstract 定位实现来源，第三方定位官方构造入口）；在目标函数 return 语句确认实际创建路径（new/builder/factory 或透传或聚合或条件分支或常量）；收集构造入口覆盖主要可能性（直接构造 / 不可变特殊类型 / 框架序列化 / 难以构造的类型——记录可 mock/fake 替换点不输出解决方案）；收集逻辑相关可观察字段及其访问方式；收集字段赋值和默认规则（构造器参数/builder 参数/setter/计算/默认值，默认值应用位置）。

**避免的错误**：不假设无参构造器或 setter；不假设存在 builder；不假设集合可变（`List.of` 不可变 vs `new ArrayList` 可变）。

---

## 2.2 目标函数输入参数信息收集

**目的**：确保单元测试能构造**可编译、可运行、分支可控**的输入对象。

**强制要求**：
- 每个参数类型确认至少一种可行构造/获取方式及**最小可行形式**（通过编译/校验/非空约束）。
- 必须覆盖维度：
  - **参数来源**：new / factory / 容器注入 / 静态访问 / 反序列化 / 框架注入
  - **构造方式**：实例化、设置字段、满足校验/不变量
  - **关键字段**：可能影响逻辑的字段（条件、循环边界、异常触发、外部调用输入）
  - **约束**：`@NotNull`/`@Size`/`@Min`/`@Max`/enum 范围、前置校验、格式要求（JSON/UUID/日期）
  - **依赖关系**：参数间约束（如字段 A 约束字段 B 的合法范围）

**执行步骤**：列出参数（名/类型/泛型/可空/varargs；interface/abstract 记录实现来源）；定位类型定义（class/interface、注解约束、默认策略）；收集可构造路径（直接构造 / 容器框架路径 / 反序列化 / 集合 Optional / 枚举常量 / 时间值 id / 难以构造的——记录替换点不输出解决方案）；收集关键字段（合法范围/默认值/可空性/字段间约束）；定位字段构造/赋值方式（builder 链、构造器参数映射、withXxx、record 构造，嵌套对象递归一层）；形成最小可行参数构造策略（内部结构化记录，不展示给用户）。

---

## 2.3 被测类初始化信息收集

**目的**：明确**被测类如何被正确创建和初始化**——构造策略、依赖注入、生命周期管理、所需上下文。

**必须收集的信息**：
- **框架管理**：Spring Bean 注解（`@Component`/`@Service`/`@Repository`/`@Configuration`）、AOP 代理或生命周期回调（`@PostConstruct`）。
- **实例创建入口**：可用构造器（可见性、参数、重载）、builder / factory / static getInstance。
- **依赖注入策略**：构造器注入（首选/`@Autowired`）、字段注入（`@Autowired`/`@Inject`）、setter 注入、框架自动装配。
- **依赖形式**：repository / client / service / util；interface / abstract / final class。
- **静态或隐式依赖**：静态字段 / 静态方法 / singleton / enum singleton / ThreadLocal / ContextHolder。
- **特殊上下文要求**：配置（`@Value`/properties/yaml）、环境变量/系统属性、时钟/线程池/I/O 资源。

**执行步骤**：定位类定义（包路径、修饰符、继承、接口、框架注解）；确认是否框架管理（作用域、AOP 代理）；分析构造器（参数数量/类型/可见性，@Autowired 构造器，builder/静态工厂）；收集依赖注入信息（来源/类型/可替换性，含父类依赖）；识别静态和隐式依赖（静态 util、singleton 访问点、ThreadLocal，记录入口点和生命周期）；收集初始化和生命周期逻辑（`@PostConstruct`/init 方法/构造器重要逻辑）；收集所需运行时上下文条件（配置来源、环境变量、外部资源依赖——仅记录依赖点）。

**避免的错误**：不假设类可通过无参构造器实例化；不忽略继承或框架注入的隐式依赖；不忽略 static/singleton/ThreadLocal 依赖；本阶段不输出 Mock 策略或测试代码。

---

## 2.4 二方件源码收集

**目的**：识别被测类 import 中的二方件依赖，查询反编译源码以补充上下文，为 Mock 分析和断言设计提供精准依据。

**识别规则**：
- `java.*` / `javax.*` → 标准库，跳过
- 项目内部包名 → 项目代码，跳过
- 知名第三方库（`com.alibaba.*` / `com.fasterxml.*` / `org.springframework.*` / `org.apache.*` / `io.netty.*`）→ 跳过
- 公司内部包名（如 `com.huawei.*`）→ **二方件**，需查询源码

**执行步骤**：读取被测类 import 语句提取全限定名；按识别规则过滤出二方件类名列表；若为空则跳过后续步骤；检查项目目录下 `.dtagent/deps/index.json` 是否存在（不存在则记录提示并跳过，不中断流程）；执行 `node {SKILL_DIR}/scripts/java/binary-detector.js batch-find-source "类名1,类名2,..."` 查询路径；从返回 JSON 中提取每个类的 `absolutePath`；用 Read 读取源码，提取方法签名、返回值类型、参数类型补充到上下文；若 missing 列表非空记录缺失类名（不中断流程）。

**脚本调用示例**（Windows 下路径反斜杠须改为正斜杠）：
```bash
node {SKILL_DIR}/scripts/java/binary-detector.js batch-find-source "com.huawei.xxx.Yyy,com.huawei.aaa.Bbb"
```

**范围限制**：仅收集被测类 import 直接引用的二方件类；不递归查询传递依赖。

**可见性约束**：内部步骤，不向用户输出过程细节；所有流程完成后，若因缺少 `.dtagent/deps/index.json` 跳过二方件查询，向用户提示建议执行二方件反编译功能（见 [binary-detector.md](./binary-detector.md)）。

---

**下一阶段**：上下文信息收集完成后，读取 [phase-3-mocking.md](phase-3-mocking.md) 进行 Mock 对象分析。
