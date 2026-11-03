# DT代码编写核心约束

本文件定义C/C++单元测试代码编写的核心约束，包含代码变更要求、测试用例编写要求、断言禁止模式和字段级校验规则。作为用例质量检查的最终门禁标准。

## 代码变更要求

* 保持用例简洁、高效
* 实现代码生成时，应聚焦于**最小必要变更**来解决问题
* 在实施任何更改之前，必须先通过探索**彻底理解代码库结构**
* 理解代码库结构、相关文件和上下文，禁止在不了解上下文时直接编辑
* 如果某个函数或文件中添加了大量代码，应考虑将其拆分为更小的逻辑单元（如辅助函数或子模块），以提升可维护性

## 测试用例编写要求

- **测试用例名称不应该使用中文**，请参考项目中的已有测试用例名称的命名规范
- 测试用例文件头部注释应该参考如下：
  ```cpp
    // Description: {被测函数} 单元测试
    // Create: {当前时间}（格式yyyy-MM-dd）
  ```

- 每个测试用例头部注释应该参考如下：
  ```cpp
    /**
    * 场景: 场景描述
    * 预期: 预期行为
    */
    TEST_F(TestSuitName, TestCaseName)
  ```

- 进行 **最小化、聚焦** 的方式编写代码，不要简单问题复杂化
- 确保每个测试用例代码的语义符合测试设计的描述要求
- 结合待测对象所在业务代码的实现和当前仓库现有测试用例的编写习惯，在测试代码中应用合适的打桩方式
- 在测试代码中用注释标注出每个测试用例的ID信息便于追踪
- 必须要按照路径远近严格参考`测试用例保存路径`下面的测试用例以及该路径附近的测试用例的设计和实现

## 兼容性解决
- 即使待测文件是.c文件，生成的测试文件也必须是.cpp文件（需要使用googletest框架）

## 用例断言核心约束

### 【强制】禁止模式列表

| 模式分类 | 禁止写法 | 原因 | 正确写法 |
|----------|----------|------|----------|
| **空用例** | `TEST_F{...}` 内没有任何EXPECT_/ASSERT_ | 没有任何验证 | **必须**添加至少1个断言 |
| 永真断言 | `EXPECT_TRUE(true)` | 恒成立，无验证价值 | `EXPECT_TRUE(expr)` 其中expr含变量 |
| 空成功 | `SUCCEED()` | 无任何验证 | 删除或替换为具体断言 |
| 仅非空指针 | `EXPECT_NE(ptr,nullptr)` | 仅验证非空，未验证内容 | `EXPECT_EQ(ptr->field, expected)` |
| 仅非空容器 | `EXPECT_FALSE(x.empty())` | 仅验证非空，未验证内容 | `EXPECT_EQ(x.size(), N)` + 元素校验 |
| 仅不抛异常 | `EXPECT_NO_THROW(func())` | 仅验证不抛异常，未验证结果 | `EXPECT_EQ(func(), expected)` |
| 冗余布尔比较 | `EXPECT_EQ(expr, true)` | 冗余，可读性差 | `EXPECT_TRUE(expr)` |
| 冗余布尔比较 | `EXPECT_EQ(expr, false)` | 冗余，可读性差 | `EXPECT_FALSE(expr)` |
| 容器无内容校验 | `ASSERT_FALSE(list.empty())` | 仅验证非空，未验证元素 | `ASSERT_EQ(list.size(), N)` + 元素遍历 |
| 容器仅下限 | `ASSERT_GE(list.size(), 3)` | 无法检测多余元素 | `ASSERT_EQ(list.size(), N)` |
| 永真表达式 | `EXPECT_TRUE(x > 0 || x <= 0)` | 恒成立 | 移除或替换为具体条件 |
| **与if条件重复** | `if (result != X) { ASSERT_TRUE(result != X); }` | 断言与if条件重复，恒为真 | 直接断言期望值：`EXPECT_EQ(result, expected)` |
| **与if条件重复** | `if (ret == SUCCESS) { ASSERT_EQ(ret, SUCCESS); }` | 仅验证成功分支 | 分支全覆盖：`ASSERT_EQ(ret, SUCCESS)` |
| SKIP用例 | `GTEST_SKIP` | 用例没有任何有效信息 | 保留用例代码，使用宏定义禁用 |

### 【强制】字段级校验规则

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

## 用例编码核心约束

### 【强制】禁止使用的编码方式

| 模式分类 | 禁止写法 | 原因 | 正确写法 |
|----------|----------|----------|----------|
| 重写被测类 | 从新写了一个完整的被测试类，将新写的类作为测试对象 | 测试对象不具备真实性，测试结果无效 | 使用真实的业务代码进行测试 |
