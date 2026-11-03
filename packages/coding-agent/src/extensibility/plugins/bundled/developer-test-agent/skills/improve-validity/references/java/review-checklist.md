# Java 断言有效性评审检查清单

本文件是 Java 断言有效性评审的导航索引。详细规则拆分到以下子文件，按需查阅。

## 评审流程（3 步）

按以下顺序逐步评审，前一步的修改结果作为后一步的输入：

### 评审 1：规范条款评审

依据华为云开发者测试规范条款，从 6 个维度评审测试文件的断言有效性：缺失断言、虚假断言、异常断言合规性、断言可读性、Mock 对断言有效性的影响、门禁与 Committer 关注点。
详见 [huawei-cloud-assertion-validity.md](./huawei-cloud-assertion-validity.md)

### 评审 2：静态特征评审

基于静态特征检查清单，识别测试代码中的断言质量问题：缺少断言（Assert/expect/verify/expected 注解等 8 类识别点）、虚假断言（assertTrue/assertFalse 字面量、assertNotNull 后无内容断言）、中途退出（循环/if 内 return）。
详见 [dt-assertion-validity-checklist.md](./dt-assertion-validity-checklist.md)

### 评审 3：断言目标与步骤评审（需结合被测源码）

读取被测源码，依据"值变化"维度评审断言目标是否充分：非局部变量、参数对象、返回值的字段级/内容级断言；必须避免的断言模式；Flux/Mono 响应式契约完整性；典型经验修复与修改注意事项。
详见 [dt-assertion-steps-and-goals.md](./dt-assertion-steps-and-goals.md)

## 详细规则索引

| 顺序 | 子文件 | 涵盖内容 |
|------|--------|----------|
| 1 | [huawei-cloud-assertion-validity.md](./huawei-cloud-assertion-validity.md) | 规范条款：缺失断言、虚假断言、异常断言、Mock、门禁、Committer 关注点 (7 个维度) |
| 2 | [dt-assertion-validity-checklist.md](./dt-assertion-validity-checklist.md) | 静态特征：缺少断言 8 类识别点、虚假断言 3 类、中途退出 |
| 3 | [dt-assertion-steps-and-goals.md](./dt-assertion-steps-and-goals.md) | 断言目标与步骤：值变化维度、必须断言 3 类（非局部变量/参数对象/返回值）、必须避免 3 类、Flux/Mono 响应式断言、经验与典型修复、修改注意事项 |

## 工作语言

始终使用简体中文作为工作语言。
