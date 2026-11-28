# C/C++ 单元测试生成规则

本文件汇总 C/C++ 单元测试生成的语言专属规则。详细规则已拆分至子文件，通过下方导航索引查阅。

## 测试框架

- **测试框架**：Google Test (gtest)
- **Mock框架**（按需选择）：
  - **gmock**：Google Mock，gtest配套，适合虚函数Mock
  - **binmock**：二进制Mock，适合C函数Mock
  - **AMock**：自动化Mock框架
  - **mockcpp**：C/C++ Mock框架，支持非虚函数Mock
- **纯gtest**：被测函数无外部依赖时，不引入任何Mock框架

## 框架选择决策

详见 [mock-framework-guide.md](./mock-framework-guide.md) 获取完整的框架选择决策流程、框架对比、各框架使用方法、malloc失败替代策略和硬件I/O Mock策略。

## 导航索引

- **依赖分析**：详见 [dependency-analysis.md](./dependency-analysis.md)（含调用链提取工作流、传递依赖递归分析、依赖分类）
- **Mock策略**：详见 [mock-strategy.md](./mock-strategy.md)
- **断言规范**：详见 [assertion-specification.md](./assertion-specification.md)
- **命名规范**：详见 [naming-and-structure.md](./naming-and-structure.md)
- **代码组织结构**：详见 [code-structure.md](./code-structure.md)（含extern "C"、#define private public）
- **C模块特殊模式**：详见 [c-module-patterns.md](./c-module-patterns.md)（含测试数据构造）
- **DISABLED_CASE宏**：详见 [disabled-case.md](./disabled-case.md)（含注释规范）
- **编译与覆盖率分析**：详见 [compile-and-coverage.md](./compile-and-coverage.md)
- **测试设计**：详见 [test-design.md](./test-design.md)
- **反模式禁令**：详见 [anti-patterns.md](./anti-patterns.md)（Mock误用10条+断言误用3条+编码误用4条+代码修改禁令4条+禁止编码方式5种）
- **mockcpp使用指南**：详见 [mockcpp-guide.md](./mockcpp-guide.md)
- **Mock框架选择和使用指南**：详见 [mock-framework-guide.md](./mock-framework-guide.md)（含4框架选择决策、框架对比、gtest/gmock/binmock/AMock/mockcpp使用、malloc失败替代策略、硬件I/O Mock策略、mockcpp特殊场景）
