# C/C++ 断言有效性评审检查清单

## 评审流程概述（3步）

1. **评审1：规范条款** — 6维度检查（缺失断言、伪断言、异常断言、断言可读性、Mock影响、评审关注点）
2. **评审2：静态特征检查** — 3维度检查（缺失断言、伪断言7种模式、提前退出）
3. **评审3：断言目标与步骤** — 需结合被测源码，检查断言目标、字段级校验9种、void方法规范、特殊场景断言

## 子文件导航

| 子文件 | 内容 |
|--------|------|
| [断言目标与步骤](./assertion-targets.md) | 评审3断言目标、字段级校验9种、void方法强制规范、必须避免4项、特殊场景4类、断言耦合最小化、测试命名准确性5种、修改注意事项4条 |
| [工程实践规范](./engineering-practices.md) | Mock清理规范、Fixture状态跟踪(std::set+TearDown)、SetUp零重置(全局状态C模块)、#include .c重复符号警告、期望值批量计算规范 |
| [DT代码编写核心约束](./constraints.md) | 14种断言禁止模式（空用例/永真/仅非空/SKIP等）、9种字段级校验规则、代码变更要求、测试用例编写要求、禁止编码方式 |

## 评审1：规范条款

### I. 缺失断言

- 无EXPECT/ASSERT的测试用例
- 仅执行操作不验证结果
- 使用cout/printf进行人工判断而非断言

**修复**：为每个测试用例添加具体的断言。

### II. 伪断言

- `EXPECT_EQ(1, 1)` / `EXPECT_TRUE(true)` — 恒为真
- `SUCCEED()` — 无任何验证
- 与SUT输出无关的断言

**修复**：移除伪断言，替换为验证具体业务属性的断言。

### III. 异常断言合规

C++中对应的是死亡测试和异常断言：
- `EXPECT_DEATH` / `ASSERT_DEATH` — 验证崩溃行为
- `EXPECT_THROW` / `ASSERT_THROW` — 验证异常类型

**修复**：

```cpp
// ❌ 错误：不验证崩溃行为
scheduler.setTaskCount(0);
scheduler.schedule();  // 期望崩溃但不验证

// ✅ 正确：EXPECT_DEATH验证
scheduler.setTaskCount(0);
EXPECT_DEATH(scheduler.schedule(), ".*");
```

### IV. 断言可读性

- 缺失失败消息

**修复**：

```cpp
// ❌ 缺失消息
EXPECT_EQ(result, 100);

// ✅ 带消息
EXPECT_EQ(result, 100) << "Order total should be 100";
```

### V. Mock对断言有效性的影响

- gmock: `EXPECT_CALL` 既是Mock配置也是断言（验证调用）
- 但仅验证调用不够，还需验证返回值/状态

### VI. 评审关注点

- 是否有断言
- 是否覆盖关键场景
- 能否检测异常逻辑

## 评审2：静态特征检查

### I. 缺失断言检查

检查测试中是否存在以下断言之一：
- `EXPECT_*` / `ASSERT_*` (gtest)
- `EXPECT_CALL` (gmock — 验证Mock调用)

### II. 伪断言检查

| 模式 | 禁止写法 | 修复 |
|------|----------|------|
| 恒为真 | `EXPECT_TRUE(true)` / `EXPECT_EQ(1, 1)` | 替换为具体业务断言 |
| 空成功 | `SUCCEED()` | 替换为具体断言 |
| 仅存在性 | `EXPECT_NE(ptr, nullptr)` 无后续字段验证 | 添加字段级断言 |
| 仅非空容器 | `EXPECT_FALSE(x.empty())` | 验证size和元素 |
| 容器仅下限 | `ASSERT_GE(list.size(), 3)` | 使用 `ASSERT_EQ(list.size(), N)` |
| 与if条件重复 | `if (result != X) { ASSERT_TRUE(result != X); }` | 直接断言期望值 |
| SKIP用例 | `GTEST_SKIP` | 保留代码，使用DISABLED_CASE宏 |

### III. 提前退出检查

- 循环内 `return` 导致后续断言未执行
- if内 `return` / `goto` 导致后续断言未执行

**修复**：移除提前退出，或拆分为独立测试用例。
