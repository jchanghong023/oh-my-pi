# 断言规范

## 断言八大规范

1. **禁止无断言**：每个用例必须有断言
2. **禁止仅检查存在性**：必须验证具体业务属性，`ASSERT_NE(ptr, nullptr)` 后必须跟字段校验
3. **禁止永真断言**：`EXPECT_EQ(1, 1)` 无意义
4. **禁止逻辑复杂**：单用例不应包含 ≥5 个逻辑关键字
5. **禁止中途退出**：禁止return/goto提前退出
6. **单用例单场景**：每个用例只验证一个场景
7. **代码行数控制**：用例代码行数建议 3-50 行
8. **禁止硬等待**：禁止sleep等硬编码等待

## void方法断言强制规范

void方法必须验证可观测状态变更（全局变量/类成员/输出参数），禁止仅使用 `EXPECT_NO_THROW`。

```cpp
// ✅ 正确：验证状态变更
engine.setGlobalSettings(10, 100);
EXPECT_EQ(max_tasks, 10);
EXPECT_EQ(time_slice, 100);
```

例外：如果void方法确实不修改任何可观测状态，命名必须使用 `_NoThrow` 后缀并在注释中说明。

## 断言耦合最小化

验证操作结果时使用最直接的可用方法，避免通过其他方法间接验证。

## 字段级校验规则（强制，9种类型）

| 返回类型 | 校验要求 | 正确示例 |
|----------|----------|----------|
| struct/class | **必须**逐字段校验 | `EXPECT_EQ(field, expected)` × N |
| 指针返回 | 非空校验 **+** 字段校验 | `ASSERT_NE(ptr, nullptr)` + `EXPECT_EQ(ptr->field, value)` |
| vector/list | size校验 **+** 元素校验 | `ASSERT_EQ(vec.size(), N)` + 遍历元素 |
| map | size校验 **+** key-value校验 | `ASSERT_EQ(map.size(), N)` + `EXPECT_EQ(map[key], value)` |
| string | 内容校验 | `EXPECT_STREQ(str.c_str(), "expected")` |
| enum | 值校验 | `EXPECT_EQ(enumVal, ExpectedEnum::Value)` |
| bool | 语义校验 | `EXPECT_TRUE(expr)` 或 `EXPECT_FALSE(expr)` |
| int/数值 | 具体值校验 | `EXPECT_EQ(value, expected)` |
| void | 状态变化校验 | `EXPECT_TRUE(checkStateChange())` |

## 断言禁止模式列表（强制）

| 模式 | 禁止写法 | 原因 |
|------|----------|------|
| 空成功 | `SUCCEED()` | 无任何验证 |
| 仅非空容器 | `EXPECT_FALSE(x.empty())` | 仅验证非空 |
| 容器仅下限 | `ASSERT_GE(list.size(), 3)` | 无法检测多余元素 |
| 与if条件重复 | `if (result != X) { ASSERT_TRUE(result != X); }` | 恒为真 |
| SKIP用例 | `GTEST_SKIP` | 用例没有任何有效信息 |

## 特殊场景断言

- **除零场景**：浮点除零优先使用 `std::isnan`/`std::isinf`，不要默认使用 `EXPECT_DEATH`
- **浮点数断言**：精确结果用 `EXPECT_DOUBLE_EQ`，近似结果用 `EXPECT_NEAR`
- **NULL指针测试**：必须显式设置nullptr，命名包含 `WhenXxxIsNull`
- **EXPECT_DEATH**：仅用于确实会产生崩溃的未定义行为

## 测试命名准确性

| 验证方式 | 命名后缀 | 示例 |
|---------|---------|------|
| 验证状态变更 | `_UpdatesState` / `_SetsValue` | `SetConfig_UpdatesGlobalVars` |
| 验证返回值 | `_ReturnsXxx` | `Calculate_ReturnsExpected` |
| 仅验证不崩溃 | `_NoThrow` | `Execute_NoThrow` |
| 验证NULL处理 | `_WhenXxxIsNull` | `GetBalance_WhenPointerIsNull` |
| 验证边界值 | `_AtBoundary` | `Process_AtMaxCapacity` |

## 断言禁止模式完整列表（14种）

| 模式分类 | 禁止写法 | 原因 | 正确写法 |
|----------|----------|------|----------|
| 空用例 | TEST_F{...} 内没有任何EXPECT_/ASSERT_ | 没有任何验证 | 必须添加至少1个断言 |
| 永真断言 | EXPECT_TRUE(true) | 恒成立，无验证价值 | EXPECT_TRUE(expr) 其中expr含变量 |
| 空成功 | SUCCEED() | 无任何验证 | 删除或替换为具体断言 |
| 仅非空指针 | EXPECT_NE(ptr,nullptr) | 仅验证非空，未验证内容 | EXPECT_EQ(ptr->field, expected) |
| 仅非空容器 | EXPECT_FALSE(x.empty()) | 仅验证非空，未验证内容 | EXPECT_EQ(x.size(), N) + 元素校验 |
| 仅不抛异常 | EXPECT_NO_THROW(func()) | 仅验证不抛异常，未验证结果 | EXPECT_EQ(func(), expected) |
| 冗余布尔比较 | EXPECT_EQ(expr, true) | 冗余，可读性差 | EXPECT_TRUE(expr) |
| 冗余布尔比较 | EXPECT_EQ(expr, false) | 冗余，可读性差 | EXPECT_FALSE(expr) |
| 容器无内容校验 | ASSERT_FALSE(list.empty()) | 仅验证非空，未验证元素 | ASSERT_EQ(list.size(), N) + 元素遍历 |
| 容器仅下限 | ASSERT_GE(list.size(), 3) | 无法检测多余元素 | ASSERT_EQ(list.size(), N) |
| 永真表达式 | EXPECT_TRUE(x > 0 || x <= 0) | 恒成立 | 移除或替换为具体条件 |
| 与if条件重复 | if (result != X) { ASSERT_TRUE(result != X); } | 断言与if条件重复，恒为真 | 直接断言期望值：EXPECT_EQ(result, expected) |
| 与if条件重复 | if (ret == SUCCESS) { ASSERT_EQ(ret, SUCCESS); } | 仅验证成功分支 | 分支全覆盖：ASSERT_EQ(ret, SUCCESS) |
| SKIP用例 | GTEST_SKIP | 用例没有任何有效信息 | 保留用例代码，使用宏定义禁用 |
