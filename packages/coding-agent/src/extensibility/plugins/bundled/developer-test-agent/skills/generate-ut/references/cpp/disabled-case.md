# DISABLED_CASE宏与用例注释规范

## 用例注释规范

每个测试用例头部必须有注释，格式为场景+预期：

```cpp
/**
 * 场景: 场景描述
 * 预期: 预期行为
 */
TEST_F(TestSuitName, TestCaseName)
```

## DISABLED_CASE宏禁用机制

当用例无法修复时，使用DISABLED_CASE宏禁用，保留完整代码：

```cpp
#ifdef DISABLED_CASE
TEST_F(FixtureName, CaseName) {
    // 此用例因编译/执行问题被禁用
    // 问题原因说明
    用例代码
}
#endif
```

禁止删除用例代码、禁止使用注释方式禁用、必须注明禁用原因。
