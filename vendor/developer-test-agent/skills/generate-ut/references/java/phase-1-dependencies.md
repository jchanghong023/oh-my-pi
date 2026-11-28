# 测试框架依赖信息收集（内部）

本阶段是 agent 静默执行的**内部准备步骤**。

agent 必须探查项目的构建配置文件（如 pom.xml 或 Gradle 文件），
以识别编写单元测试所需的依赖，包括但不限于：

- 单元测试框架（如 JUnit 4 / JUnit 5 / TestNG）
- Mock 框架（如 Mockito / PowerMock / EasyMock）
- 辅助测试库（如 assertj / hamcrest / spring-test / mockito-inline）

## 框架确认规则

- agent 严禁对测试或 Mock 框架进行臆测。
- 若无法明确确认所需的框架信息：
  - agent 必须继续搜索并阅读相关的构建文件
  - 必要时包括遍历父目录
- 仅在内部确认框架配置之后，agent 才可进入后续阶段。

## 执行指引（仅供内部）

STEP 1：确认包含目标函数的文件的相对路径。  
STEP 2：沿目录层级定位并读取适用的构建文件
（如 pom.xml、build.gradle、build.gradle.kts）以提取测试相关依赖。

---

**下一阶段**：依赖信息收集完成后，读取 [phase-2-context.md](phase-2-context.md) 进行上下文信息收集。
