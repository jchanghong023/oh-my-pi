# Java UT 编译/运行时修复策略

按编译/运行时错误类型分组的修复策略。使用前先按 [route-runtime.md](route-runtime.md) 路由到对应章节。

通用原则和硬性约束见 [fix-rules.md](fix-rules.md) 入口文件。

## 1. 参数匹配器失效 (argument-matcher-mismatch)

**特征**：Mock 未生效，期望的异常未抛出或返回了 null/默认值；NPE 出现在被测方法内部

**根因**：`anyString()` 不支持 null，`any()` / `anyOrNull()` / `nullable()` 支持 null

**修复策略**（自我修复流程）：
1. 用最宽松 `any()` 验证 Mock 本身是否工作（通过则问题在匹配器，失败则 Mock 设置有问题）
2. 逐个参数精确化定位问题参数：`any()` → `anyString()` → 哪个失败说明哪个参数为 null
3. 问题参数可能为 null → 改用 `nullable(X.class)` 或 `any()`
4. 有具体值 → 用 `eq(value)` 精确匹配；不确定参数范围 → 用 `any()`
5. 添加 `verify(mock, times(1)).method(...)` 确认 Mock 被调用
6. 使用 `grep` 工具搜索 `targetMethod`，并在 `*Test.java` 文件中参考同类成功测试

**常见匹配器 null 支持表**：`anyString()` ❌ / `any()` ✅ / `anyOrNull()` ✅ / `nullable(X.class)` ✅ / `eq(value)` 仅精确值

## 2. Mock 配置错误 (failure-mock)

**特征**：NPE 发生在 Mock 调用链；`when()` 条件与实际调用不匹配

**四步修复**：
1. 分析错误堆栈，定位 NPE 的具体行号和为 null 的对象来源（参数传入 / Mock 返回 / 新建对象）
2. 检查 Mock 配置：`when()` 条件是否匹配；`thenReturn()` 是否返回 null
3. 分析被测方法逻辑：null 检查、默认值处理、期望输入
4. 选择修复：修改测试输入参数（最常用） / 调整 Mock 配置（补全链：`when(a.getB().getC()).thenReturn(...)`） / 重构测试设计

## 3. 运行时异常 (exception-runtime)

**特征**：`throw` / `threw` / `unexpected exception`；`@Test(expected=...)` 或 `assertThrows()` 相关

**两步修复**：
1. 检查被测代码是否有异常处理机制（try-catch / `@ExceptionHandler` / 全局处理器）
2. 按实际行为调整测试：
   - 被测代码处理异常 → 验证处理后的响应（`assertEquals(500, result.getCode())`）
   - 被测代码不处理异常 → 验证异常被抛出（JUnit4: `@Test(expected=X.class)`；JUnit5: `assertThrows(X.class, () -> ...) + assertEquals("msg", e.getMessage())`）

## 4. 反射 API 字段名不匹配 (failure-reflect)

**特征**：`NoSuchField` / `could not find field`；涉及 `ReflectionTestUtils.setField()` 或 `getDeclaredField()`

**三步修复**：
1. 从错误堆栈定位反射调用位置，提取测试指定的字段名和目标类
2. 用 `context_retrieve` 获取类定义，检查实际字段列表（注意大小写和拼写）
3. 三种情况：字段名拼写错误 → 修正；字段不存在 → 找功能相似的替代字段（如 "description" → "subTitle"）；继承链字段 → 检查父类

## 5. 编译时异常 (exception-compilation)

**特征**：`must be caught or declared to be thrown` / `unhandled exception`；测试无法运行

**两步修复**：
1. 定位抛出已检查异常的方法调用，查看其 `throws` 子句确定异常类型
2. 按测试意图选择方案：
   - 测试正常场景 → 捕获并处理：`try { method(); } catch (Exception e) { fail("不应抛出异常"); }`
   - 测试正常场景 → 方法声明抛出：`public void testMethod() throws Exception`
   - 测试异常场景 → JUnit4: `@Test(expected=IOException.class)`；JUnit5: `assertThrows(IOException.class, () -> ...)`

## 工具使用建议

- 优先利用错误堆栈信息（异常类型、方法位置、字段名），减少不必要的探索
- 多个字段/参数问题在同一测试中应一并修复，减少轮次
- 修复后检查：语法正确 / `verify()` 确认 Mock 被调用 / 测试仍验证原定业务场景 / 保持测试简洁
