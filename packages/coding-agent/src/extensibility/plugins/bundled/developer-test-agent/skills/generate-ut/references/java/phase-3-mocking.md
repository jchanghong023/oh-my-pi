# 阶段 3：Mock 对象分析

## 3.1 Mock 的价值

将难以现实构造或执行的依赖（数据库/网络/Redis/文件系统等）替换为 Mock 桩，从而实现稳定的分支覆盖。

---

## 3.2 Mock 决策原则（必须遵守）

### 1）**Mock 边界依赖**

#### 应当 Mock：

* 数据库访问层（Repository / DAO）
* 外部 API 调用（HTTP Client）
* 文件系统操作
* 消息队列
* 缓存服务
* 时间相关依赖（`Clock`）

#### 不应 Mock：

* 简单工具 / 辅助方法
* 纯计算逻辑
* 值对象（Value Objects）
* **JDK 标准库方法**（如 `java.lang`、`java.util`、`java.time`、`java.math`）

    * 示例包括：

        * `String`、`Objects`、`Optional`
        * `Collections`、`List`、`Map`、`Set`
        * `Math`、`BigDecimal`
        * `LocalDate`、`Instant`、`Duration`
        * `System`
    * 这些方法是确定性的、稳定的且经过充分测试的，Mock 它们
      通常会降低测试的可读性和可靠性，而不会提升覆盖率。

---

### 2）**最小化 Mock 范围**

仅 Mock 经证明必要的方法；无需 Mock 所有内容。

自检原则：

* 逻辑依赖基础设施（数据库/Redis/消息队列/文件系统）
* 处于关键分支入口且返回值构造复杂

---

### 3）**不要 Mock 被测类/方法**

Mock 仅用于分支覆盖和外部依赖隔离；
不要 Mock 被测类或目标方法本身。

```java
// ???Mock ????
@Mock
private UserRepository userRepository;

// ??: ?????? Mock???@InjectMocks???????
@InjectMocks
private UserService userService;

// ????Mock ????????????????????????Mock????????????
@Spy
private UserService userService;  
```

---

## 3.3 Mock 禁止与限制

* **禁止**：Mock 私有方法。
* **禁止**：Mock `final` 方法（除非项目明确支持并启用了 inline mocking，且在 POM 中已确认）。
* **受限**：仅当 POM 中配置了 `mockito-inline` 或 Mockito **3.4+** 时才允许静态 Mock。
* 若因框架限制无法 Mock，必须调整输入或内部状态以触发所需分支。

---

## 3.4 Mock 编码模式（按场景选择）

### 3.4.1 静态方法 Mock（Mockito static）

**仅**在确认已支持静态 Mock 时使用
（如已配置 `mockito-inline` 或 Mockito 3.4+）：

```java
try (MockedStatic<StringUtils> stringUtilsMock = mockStatic(StringUtils.class)) {
        // void ????
        stringUtilsMock.when(() -> StringUtils.setString(Mockito.anyString()))
        .thenAnswer(invocation -> null);

        // ? void ????
        stringUtilsMock.when(() -> StringUtils.getString("api.url"))
        .thenReturn("http://test-api.example.com");
}
```

---

### 3.4.2 Mock 被测类中的其他方法（spy + doReturn）

```java
UserService spyService = Mockito.spy(realService);
doReturn(true).when(spyService).validateUser(anyString());
```

---

### 3.4.3 标准依赖 Mock（when / thenReturn）

```java
when(dep.query(any())).thenReturn(result);
when(dep.query(any())).thenThrow(new RuntimeException("..."));
```

---

### 3.4.4 void 方法（doNothing / doThrow）

重要说明：
`doNothing()` 和 `doThrow()` 只能用于返回类型为 void 的方法。

这些 API 专为桩化 void 方法而设计。
对有返回值的方法使用它们是无效且具有误导性的。

```java
doNothing().when(dep).save(any());
doThrow(new IllegalStateException("...")).when(dep).save(any());
```

---

### 3.4.5 链式调用

```java
// 当需要 Mock 链式调用时
when(httpClient.get(anyString())
        .header(anyString(), anyString())
        .execute())
        .thenReturn(response);

// 或使用 RETURNS_DEEP_STUBS（谨慎使用）
@Mock(answer = Answers.RETURNS_DEEP_STUBS)
private HttpClient httpClient;
```

---

## 3.5 执行步骤

STEP 1：**定位函数调用定义**
在项目中搜索目标函数内的函数调用定义，以了解返回值、参数和逻辑。若 Phase 2.4 已收集二方件源码，优先利用已有信息，避免重复查找。

STEP 2：**分析 Mock 必要性**
根据 **3.2** 和 **3.3** 节的规则判断该调用是否应当被 Mock。

STEP 3：**选择合适的 Mock 方式**
基于 **3.4** 节选择最合适的 Mock 风格。

---

## 3.6 基于二方件源码的精准 Mock（当 Phase 2.4 收集到二方件源码时适用）

若 Phase 2.4 已成功读取二方件源码，Mock 分析应利用源码中的实际签名信息：

1. **方法签名确认**：从源码中确认方法的参数类型、返回值类型，避免猜测
2. **返回值构造**：根据源码中的返回类型定义，使用正确的构造方式创建 Mock 返回值
3. **异常声明**：从源码中确认方法声明的受检异常，确保 Mock 配置覆盖异常路径

注意：
- 仅对 Phase 2.4 中已读取源码的二方件类应用此规则
- 未读取源码的二方件类，仍按常规 Mock 策略处理

---

**下一阶段**：Mock 对象分析完成后，读取 [phase-4-test-design.md](phase-4-test-design.md) 进行测试场景设计。
