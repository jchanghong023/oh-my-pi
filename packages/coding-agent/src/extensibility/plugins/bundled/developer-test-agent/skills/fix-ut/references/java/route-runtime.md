# 编译/运行时错误类型路由

请根据报错日志中的关键词（Case Insensitive）按照 **从上到下** 的顺序匹配规则。一旦匹配成功，立即停止匹配并返回对应的策略文件。

## 优先级 0: 编译时异常
如果代码无法运行，必须先解决编译问题。
- **触发关键词**: `must be caught or declared to be thrown`, `unhandled exception`
- **目标章节**: [fix-strategies-runtime.md §5 编译时异常](fix-strategies-runtime.md#5-编译时异常-exception-compilation)

## 优先级 1: 反射相关错误
- **触发关键词**: `Reflection`, `setAccessible`, `NoSuchField`, `IllegalAccess`, `could not find field`
- **其他特征**：
  - 当遇到因反射API调用时字段名不匹配导致的运行时错误时
  - 涉及ReflectionTestUtils中`setField()`或`getField()`的调用
  - 涉及Java反射API中`Field.set()`或`getDeclaredField()`的调用
  - 错误发生在测试代码中，而不是被测代码
- **目标章节**: [fix-strategies-runtime.md §4 反射 API 字段名不匹配](fix-strategies-runtime.md#4-反射-api-字段名不匹配-failure-reflect)

## 优先级 2: 运行时异常
- **触发关键词**: `throw`, `threw`, `thrown`, `unexpected exception`
- **其他特征**：
  - 遇到运行时异常测试错误
  - 测试执行时断言失败、期望的异常未抛出或抛出了错误类型的异常
  - 涉及`@Test(expected=...)`或`assertThrows()`的使用）
- **目标章节**: [fix-strategies-runtime.md §3 运行时异常](fix-strategies-runtime.md#3-运行时异常-exception-runtime)

## 优先级 3: Mock 框架错误
- **触发关键词**: `Mockito`, `Mock`, `Spy`, `ArgumentMatchers`, `UnfinishedStubbing`
- **其他特征**：
  - 当遇到因Mock配置、测试输入参数与被测方法逻辑不匹配导致的运行时错误时
  - 错误堆栈显示`NullPointerException`在Mock对象调用链中
  - 涉及`when().thenReturn()或when().thenThrow()`的调用
  - 被测方法调用依赖的Mock服务时报错
- **目标章节**: [fix-strategies-runtime.md §2 Mock 配置错误](fix-strategies-runtime.md#2-mock-配置错误-failure-mock)

## 优先级 4: 参数匹配器错误
- **触发关键词**: `anyString`, `any()`, `nullable`, `eq()`, `argument mismatch`
- **堆栈特征**：
  ```
  java.lang.AssertionError
  	at org.junit.Assert.fail(Assert.java:86)
  	at org.junit.Assert.assertTrue(Assert.java:41)
  	at org.junit.Assert.assertNotNull(Assert.java:712)
  	at org.junit.Assert.assertNotNull(Assert.java:722)
  ```
- **其他特征**：
  - 使用了参数匹配器（如`anyString()`、`any()`）但参数不匹配
  - `NullPointerException`发生在Mock对象调用时
  - 参数匹配器与实际参数类型不匹配
- **目标章节**: [fix-strategies-runtime.md §1 参数匹配器失效](fix-strategies-runtime.md#1-参数匹配器失效-argument-matcher-mismatch)
