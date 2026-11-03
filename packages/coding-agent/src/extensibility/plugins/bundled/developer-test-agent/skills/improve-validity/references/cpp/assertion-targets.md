# C/C++ 断言目标与步骤

## 评审3：断言目标与步骤（需结合被测源码）

### I. 断言目标

**值变更维度**：
- 返回值与预期一致性
- 输出参数的变更
- 全局变量/类成员的状态变化

**可观测状态转换**：
- 对象状态机的转换
- 集合内容的增删
- 标志位翻转

**断言有效性检验**：核心逻辑被破坏时断言是否失败

### II. 必须断言的内容 — 字段级校验规则（强制，9种类型）

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

### III. void方法断言强制规范

void方法必须验证可观测状态变更，禁止仅使用 `EXPECT_NO_THROW`：

```cpp
// 错误：仅EXPECT_NO_THROW
engine.setGlobalSettings(10, 100);
// 无任何业务断言

// 正确：验证状态变更
engine.setGlobalSettings(10, 100);
EXPECT_EQ(max_tasks, 10);
EXPECT_EQ(time_slice, 100);
```

**例外**：如果void方法确实不修改任何可观测状态，命名必须使用 `_NoThrow` 后缀并在注释中说明。

### IV. 必须避免的内容

- 仅存在性断言（`EXPECT_NE(ptr, nullptr)` 无字段验证）
- 伪断言（`EXPECT_TRUE(true)`）
- 仅NoThrow断言（void方法不验证状态变更）
- 与if条件重复的断言

### V. 特殊场景断言

#### 除零场景

```cpp
// 浮点除零优先使用 isnan/isinf，不使用 EXPECT_DEATH
double result = divide(1.0, 0.0);
EXPECT_TRUE(std::isinf(result));

double result2 = divide(0.0, 0.0);
EXPECT_TRUE(std::isnan(result2));
```

#### 浮点数断言

```cpp
// 精确结果
EXPECT_DOUBLE_EQ(result, 3.14159);

// 近似结果
EXPECT_NEAR(result, expected, 0.001);
```

#### NULL指针显式测试

```cpp
// 必须显式设置NULL，命名反映条件
account_balance = nullptr;  // 显式设置NULL
double balance = get_balance();
EXPECT_DOUBLE_EQ(balance, 1000.0);
```

#### 内存布局验证

```cpp
// 验证内存块内容而非仅检查指针
EXPECT_EQ(memcmp(buffer, expected_data, data_size), 0);
```

### VI. 断言耦合最小化

验证操作结果时使用最直接的可用方法：

```cpp
// 错误：间接验证
auto shapes = processor.getShapesByArea(0, INT_MAX);
EXPECT_EQ(shapes.size(), 1);

// 正确：直接验证
EXPECT_DOUBLE_EQ(processor.calculateTotalArea(), expected_area);
```

### VII. 测试命名准确性

| 验证方式 | 命名后缀 | 示例 |
|---------|---------|------|
| 验证状态变更 | `_UpdatesState` / `_SetsValue` | `SetConfig_UpdatesGlobalVars` |
| 验证返回值 | `_ReturnsXxx` | `Calculate_ReturnsExpected` |
| 仅验证不崩溃 | `_NoThrow` | `Execute_NoThrow` |
| 验证NULL处理 | `_WhenXxxIsNull` | `GetBalance_WhenPointerIsNull` |
| 验证边界值 | `_AtBoundary` | `Process_AtMaxCapacity` |

### VIII. 修改注意事项

- **正确性优先**：不破坏现有通过的测试
- **不可检索时不断言**：如果值不可检索，不强行断言
- **只断言可观测行为**：不断言内部实现细节
- **数据清理**：Mock清理在用例内，禁止在TearDown中全局清理（详见[工程规范](./engineering-practices.md)）
