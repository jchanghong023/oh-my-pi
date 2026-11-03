# Python 断言有效性评审检查清单

## 评审流程概述（3步）

1. **评审1：规范条款** — 7维度检查（缺失断言、伪断言、异常断言合规、断言可读性、Mock影响、门禁标准、评审关注点）
2. **评审2：静态特征检查** — 3维度检查（缺失断言、伪断言、提前退出）
3. **评审3：断言目标与步骤** — 需结合被测源码，检查断言目标、必须断言内容、必须避免内容

## 评审1：规范条款

### 检查维度

| 维度 | 检查内容 |
|------|---------|
| **缺失断言** | 测试函数执行代码但无assert/pytest.raises；仅print/console.log手动判断 |
| **伪断言** | `assert True`；`assert x is not None`（仅存在性无内容验证）；与SUT输出无关的断言 |
| **异常断言合规** | `pytest.raises`使用；try-except无断言；except块suppress但用pytest.raises |
| **断言可读性** | 缺失失败消息；多断言无描述（Assertion Roulette） |
| **Mock影响** | verify不断言返回值；仅验证调用不验证参数 |
| **门禁标准** | 测试是否验证业务逻辑而非仅验证mock基础设施 |
| **评审关注点** | 是否有断言、覆盖关键场景、能检测异常逻辑 |

### Python特定伪断言模式

| 模式 | 禁止写法 | 原因 |
|------|---------|------|
| 仅存在性断言 | `assert result is not None` | 不验证内容 |
| 恒真断言 | `assert True` | 无验证价值 |
| 仅调用验证 | `mock.called` 不检查参数 | 不验证业务契约 |
| 范围断言 | `assert count >= 0` | trivially-satisfied |
| 复合or断言 | `assert result or mock.called` | 一侧可能短路 |
| dict仅key检查 | `assert key in dict` | 不验证value |

## 评审2：静态特征检查

| 维度 | 检查内容 |
|------|---------|
| **缺失断言** | 测试函数无assert/pytest.raises/verify |
| **伪断言** | 恒为真、仅存在性、仅调用次数 |
| **提前退出** | if内return导致后续断言未执行 |

## 评审3：断言目标与步骤（需结合被测源码）

### 断言目标
- 值变更维度：非局部变量、输入对象、返回值的字段级/内容级断言
- 可观测状态转换：对象属性变更、集合内容变更
- 核心逻辑被破坏时断言是否失败

### 必须断言的内容
- 返回值的具体值（非仅is not None）
- 输出参数的字段级校验
- dict存储的key存在 AND value相等
- 构造函数调用的类型和参数
- 方法调用的参数验证（assert_called_once_with）

### 必须避免的内容
- 仅存在性断言（is not None）
- 恒真断言（assert True）
- trivially-satisfied范围断言
- 复合or断言

### Python特定经验

| 问题 | 推荐修复 |
|------|---------|
| 仅verify不断言返回值 | 添加返回值字段级断言 |
| dict仅检查key | 添加value相等断言 |
| 异常suppress用raises | 改为验证正常返回和副作用 |
| Exception子类属性假设 | 验证类定义了该属性，否则用.args[0] |
| bound method用is比较 | 用__name__比较或assert_called_once_with |
