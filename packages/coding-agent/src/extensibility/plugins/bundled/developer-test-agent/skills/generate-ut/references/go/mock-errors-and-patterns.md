# Mock策略错误诊断与高级模式

## Mock策略错误诊断表（14种症状）

| 症状 | 根因 |
|---------|-----------|
| panic: reflect: Call of zero Value | gomonkey patch target is nil (wrong reflect.TypeOf receiver) |
| panic: reflect.Set: value of type X not assignable to type Y | Mock函数返回类型不匹配 |
| Mock callCount always 0 | Patch applied on wrong type (derived vs embedded) or method name typo |
| 0% coverage despite tests passing | Mock intercepts wrong call path |
| cannot use type as type compile error | Interface mock缺少必需方法 |
| Tests pass but flaky/race detector fails | gomonkey patch + goroutine race window |
| gomonkey.ApplyMethod silently doesn't patch | Method is inlined by compiler |
| Coverage stuck at 60-70% on network function | Error-routing branches dead |
| nil pointer dereference on target call | Struct未完全构造（缺少embedded/base fields） |
| Test compiles but target function not called | Helper function bypasses target |
| retrieve method by name failed panic | Using ApplyMethod on unexported method |
| Type assertion fails in test (ok is false) | Mock struct不满足类型断言 obj.(*ConcreteType) |
| callCount == 0 in concurrent test | Channel未排空；goroutines未完成 |
| unknown field 'X' in struct literal | Incorrect struct field path due to embedding |

### 错误恢复模式

gomonkey不稳定回退：
1. 第一次尝试：修复特定问题（添加atomic/mutex、重排patches、使用t.Cleanup）
2. 第二次尝试：尝试gomonkey.ApplyPrivateMethod替代ApplyMethod
3. 回退：替换为更轻tier（L3字段注入/L1预构造状态/L4 fake server）

渐进修复策略：
1. Round 1：修复编译错误，验证mock注入，检查调用路径
2. Round 2：验证patch targets（正确类型、方法名、receiver）
3. Round 3：应用gomonkey不稳定回退

## Dispatcher补丁模式

当目标函数是dispatcher（switch/case或if/else链路由到私有方法），直接patch那些私有方法——不要patch它们内部调用的更低层方法。

原因：patch dispatched方法更简单、更可靠、产生正确断言。patch更低层方法会导致断言与mock返回值不匹配。

## Type-Assertion分发模式

当目标函数使用类型断言（如 if concreteObj, ok := obj.(*ConcreteType)）分发到不同方法，不要创建实现接口的mock struct来测试ConcreteType路径。

原因：类型断言对mock struct会失败（它不是*ConcreteType），导致测试执行错误分支。

正确做法：使用gomonkey.ApplyMethod on ConcreteType的方法直接，使类型断言成功并执行正确分支。

## 中间参数验证模式

当期望需要验证传递给下游方法的参数（不仅是最终输出），升级到L5拦截该方法——即使L1已达到覆盖率。

原因：L1可以通过让真实下游方法运行达到覆盖率，但无法拦截和验证目标传递给它的参数。L5拦截可以断言中间状态。

## 嵌入类型补丁模式

当方法从嵌入类型继承（F7），patch BASE类型而非Derived类型：

正确：patches := gomonkey.ApplyPrivateMethod(reflect.TypeOf(&BaseType{}), "inheritedMethod", ...)
错误：patches := gomonkey.ApplyPrivateMethod(reflect.TypeOf(&DerivedType{}), "inheritedMethod", ...)

使用 `grep` 工具搜索 `func \(c \*BaseType\) inheritedMethod`，查找方法定义并识别 base 类型。
