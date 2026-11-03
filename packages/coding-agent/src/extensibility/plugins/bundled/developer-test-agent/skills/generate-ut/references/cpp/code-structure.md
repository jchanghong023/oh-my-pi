# 代码组织结构

## 代码组织结构

```cpp
/*
 * Description: {被测函数} 单元测试
 * Create: {日期}
 */

// 系统头文件
#include <gtest/gtest.h>

// 项目头文件
#include "module_error.h"

// 被测模块头文件 - C++测C时使用extern "C"包裹
extern "C" {
#include "module_target.h"
}

namespace module::testing {
using namespace ::testing;

class TestModule : public ::testing::Test {
protected:
    void SetUp() override { /* 通用初始化 */ }
    void TearDown() override { /* 通用清理 */ }
    void fill_default_param(param_t *param) { /* 数据构造辅助 */ }
};

/**
 * 场景: 场景描述
 * 预期: 预期行为
 */
TEST_F(TestModule, TestFuncWhenConditionThenResult) {
    // Arrange
    // Act
    // Assert
    // Cleanup
}

} // namespace
```

## extern "C"正确用法

```cpp
// ✅ 正确：包裹C头文件
extern "C" {
#include "module_target.h"
}

// ❌ 错误：include后再声明extern "C"函数
#include "module_target.h"
extern "C" int module_func(param_t *p);
```

## #define private public 使用规则

优先通过公共接口测试。仅当公共接口不足时使用，且必须遵守include顺序：

```cpp
// 1. gtest/gmock头文件（必须在#define之前）
#include <gtest/gtest.h>
// 2. 其他标准库头文件（必须在#define之前）
#include <string>
// 3. #define private public（在被测头文件之前）
#define private public
// 4. 被测头文件
#include "target_class.h"
// 5. 恢复（可选）
#undef private
```

如果使用后出现segfault，立即移除并改用公共接口测试。
