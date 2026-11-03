# Java UT Codecheck 告警修复策略

按 codecheck 告警类型分组的修复策略。使用前先按 [route-codecheck.md](route-codecheck.md) 路由到对应章节。

通用原则和硬性约束见 [fix-rules.md](fix-rules.md) 入口文件。

## 1. 缺少断言 (missing-assertion)

**特征**：测试方法执行了被测逻辑但没有 `assert*` / `verify*` / `expect` 调用

**修复策略**：
1. 识别被测方法是否有返回值：有返回值 → 补充返回值断言（精确值 `assertEquals` > 布尔 `assertTrue`）
2. 无返回值 → 验证副作用（状态变化 `assertEquals(dao.findById(1).getName())`、Mock 调用 `verify(mockDao).save()`）
3. 异常场景 → 补充异常验证（`@Test(expected=...)` 或 `try-catch + fail()`）
4. 数据构建循环 → 验证构建结果（`assertEquals(10, list.size())`）

**修复优先级**：精确值断言 > 布尔条件断言；内容验证 > 非空验证；具体字段验证 > 整体对象验证

## 2. 虚假断言 (fake-assertion)

**特征**：仅 `assertNotNull` / `assertTrue(true)` / `assertEquals(0, 0)` 等无效断言

**修复策略**：
1. 分析返回值业务语义，从 Mock 设置（`when(...).thenReturn(...)`）、测试 Setup、业务规则推导预期值
2. 删除 `assertNotNull`，按场景替换为精确断言：
   - 返回值可预期 → `assertEquals(expectedPath, pidFile)`
   - 返回对象 → 对属性断言 `assertEquals("test_trace_id", obj.getTraceId())`
   - 异常场景 → `assertTrue(ex instanceof X)` + `assertEquals("msg", ex.getMessage())`
   - 集合 → `assertEquals(3, list.size())` + `assertTrue(list.contains("expectedItem"))`
3. 无法推导预期值时，用 `System.out.println("DEBUG: " + value)` 过渡方案，运行后替换为精确断言

## 3. 中途退出 (early-exit-fix)

**特征**：循环体或条件分支内包含 `return`，导致后续断言未执行

**修复策略**（按场景）：
1. 循环内 return 意图为跳过当前迭代 → 替换为 `continue`
2. 循环内 return 无意义 → 直接移除
3. if/else 分支内 return → 移除 return，补充分支逻辑的断言
4. 不同条件分支代表不同测试场景 → 拆分为独立用例（如 `testProcess_validInput` / `testProcess_invalidInput`）
5. try-catch 内 return → 移除 return，改用 `fail("Should throw exception")`

## 验证方法

修复后重新运行测试，确认：
1. Mock 的方法被正确调用
2. 断言通过
3. 不再出现 NullPointerException 或 `NoSuchField`
4. codecheck 再次检查告警已清零
