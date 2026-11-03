# 阶段 6：测试类代码输出

## 6.0 测试类命名规则（硬性要求）

以下规则**不可协商**，适用于**所有**Java单元测试的生成和修改。

### 1. 测试类命名规则（强制）

对于任意目标业务类 `X`，对应的单元测试类名**必须**为：

`XTest`

**严格禁止**以下命名方式，包括但不限于：

- `XTests`
- `TestX`
- `X_Test`
- `XUnitTest`
- `XTest1`
- `XTestV2`

如果已存在测试类，agent **必须**：
- 复用已有的测试类
- **禁止**为同一业务类创建不同名称的测试类

违反此规则视为**无效的测试生成**。

### 2. 单一测试类规则（强制）

对于给定的业务类 `X`：
- 针对 `X` 的方法的所有单元测试**必须**位于同一个测试类 `XTest` 中

为同一业务类创建多个测试类是**不允许的**。

### 3. 多目标方法处理规则（强制）

如果用户请求（显式或隐式）涉及**同一**业务类的多个方法，agent **必须**：
- 将新测试方法追加到已有 `XTest` 类的**末尾**
- 保留所有现有测试方法不变，除非修复阻塞性问题

agent **禁止**：
- 创建新的测试类
- 将测试拆分到多个文件
- 不必要地重新排序现有测试方法

在测试类末尾追加新测试是**标准且预期的做法**。

### 4. 跨类目标防护

如果多个目标方法属于**不同**的业务类：
- 每个业务类**必须**有独立的测试类
- 每个测试类**必须**遵循 `ClassNameTest` 命名规则

在单个测试类中混合不同业务类的测试是**严格禁止的**。

### 5. 禁止操作

- 在所有 DT 子代理操作中，被测代码（包括业务类、服务、仓库、领域对象及所有非测试源文件）**严格只读**。
  - **禁止**修改、重写、重构或重新生成被测代码
  - **禁止**创建被测代码的替代实现、包装类或修改后的副本
  - **禁止**调整业务代码的逻辑、方法签名、可见性或行为来适配单元测试

## 6.1 输出要求（强制）
使用 **Write** 工具从零创建单元测试文件，或使用 **Edit** 工具增量更新已存在的单元测试文件。  
最终的单元测试文件**必须**包含以下要素：
- package 声明
- import 语句
- 与被测类对应的测试类定义
- Setup / fixture 方法（@BeforeEach 或 @Before）
- 所有测试方法

所有生成的单元测试类必须声明为 public。

类声明必须以 public class 开头。

严禁使用 package-private、protected 或省略访问修饰符。

如果测试类未声明为 public，则输出视为无效，必须重新生成。

其他要求：
- 使用项目 **POM** 中确认的测试与 mocking 框架（例如 JUnit4 vs. JUnit5、Mockito vs. PowerMock）。
- 断言应使用项目首选的断言库；若 POM 未显式指定，默认使用基础 JUnit / Mockito 断言。
- 保持高可读性：每个测试方法必须遵循 **Arrange / Act / Assert** 模式，并使用清晰、具描述性的命名。
- 每个测试类**必须声明为 `public` 类**。
- 每个测试方法必须包含符合下方结构化模板的完整 JavaDoc 风格注释。

## 6.3 测试方法注释模板（强制）

每个测试方法必须包含结构化的 JavaDoc 注释，全面描述测试场景。该注释必须紧跟在测试方法签名上方。

### 必备注释结构

```java
/**
 * 用例描述：基于真实业务场景,描述该方法核心业务行为（唯一业务目标）
 * 预制条件：执行该方法前,必须满足的业务数据/状态/环境
 * 输入参数：按业务含义定义入参值（合法/异常/边界场景）
 * 预期结果：明确业务契约结果（返回值/数据状态/异常/业务规则）
 *
 * Given：前置条件 / 初始状态
 *  1. 初始化XXX对象
 *  2. 准备业务数据 / 设置属性
 *  3. 构造依赖环境
 * When：执行动作（仅1行核心调用）
 *  执行：XXXService.xxxMethod()
 * Then：结果校验（三重校验）
 *  1. 断言返回结果正确
 *  2. 验证依赖调用/状态变更
 *  3. 校验数据持久化/副作用
 *
 * @throws IOException 可能抛出的异常类型（根据实际情况填写）
 */
@Test
public void testMethodNameShouldDoSomething() throws IOException {
    // 测试代码
}
```

### 注释要素说明

1. **用例描述**：用一句清晰的语句描述被测的核心业务行为。聚焦业务目标，而非技术细节。
   - 示例："验证用户登录成功后返回正确的用户信息"

2. **预制条件**：列出执行该方法前必须满足的所有前置条件。
   - 包含：数据库状态、mock 配置、对象初始化、环境设置
   - 示例："用户表中存在ID为1001的用户记录,密码已加密存储"

3. **输入参数**：基于业务语义定义输入值，而非仅按技术值。
   - 分类为：合法场景、异常场景、边界场景
   - 示例："userId=1001（合法用户ID）, password='validPass123'（符合规则的密码）"

4. **预期结果**：明确陈述预期的业务结果。
   - 包含：返回值、状态变更、异常、业务规则
   - 示例："返回User对象包含正确的用户信息,登录状态更新为ONLINE"

5. **Given/When/Then 结构**：拆解测试执行流程：
   - **Given**：逐步初始化与设置（编号列表）
   - **When**：单行核心方法调用
   - **Then**：三重校验（返回值、依赖、副作用）

6. **@throws**：若测试用例涉及异常处理，需记录预期异常。

### 示例

```java
/**
 * 用例描述：验证订单创建成功后返回正确的订单ID并更新库存
 * 预制条件：商品表中存在商品ID为P001的商品,库存充足（100件）
 * 输入参数：productId='P001'（合法商品ID）, quantity=5（合法购买数量）
 * 预期结果：返回订单ID,商品库存减少5件,订单状态为CREATED
 *
 * Given：前置条件 / 初始状态
 *  1. 初始化OrderService对象并注入InventoryRepository
 *  2. Mock InventoryRepository返回库存100件
 *  3. Mock OrderRepository返回订单ID'ORD12345'
 * When：执行动作（仅1行核心调用）
 *  执行：orderService.createOrder("P001", 5)
 * Then：结果校验（三重校验）
 *  1. 断言返回订单ID为'ORD12345'
 *  2. 验证InventoryRepository.updateStock()被调用1次
 *  3. 校验订单状态为CREATED
 */
@Test
public void testCreateOrderReturnsIdAndUpdatesStock() {
    // Given
    OrderService orderService = new OrderService();
    InventoryRepository inventoryRepo = mock(InventoryRepository.class);
    OrderRepository orderRepo = mock(OrderRepository.class);
    orderService.setInventoryRepository(inventoryRepo);
    orderService.setOrderRepository(orderRepo);
    
    when(inventoryRepo.getStock("P001")).thenReturn(100);
    when(orderRepo.save(any(Order.class))).thenReturn("ORD12345");
    
    // When
    String orderId = orderService.createOrder("P001", 5);
    
    // Then
    assertEquals("ORD12345", orderId);
    verify(inventoryRepo, times(1)).updateStock("P001", 95);
}
```

## 推荐代码结构（可选但推荐）
- @ExtendWith(MockitoExtension.class)（JUnit5 + Mockito）
- @Mock 依赖，@InjectMocks 被测类（便于清晰的构造器 / 字段注入）
- 使用 try-with-resources 包裹静态 mocking，避免污染其他测试用例。

## 6.2 代码输出规则
（1）最终测试代码必须仅通过 Write 工具或 Edit 工具产出。
（2）禁止输出碎片化代码或缺少 import、package 声明的代码。

## 失败与回退策略
(1) 若在任何阶段无法确认所需的类型定义、构造方法或关键字段赋值，必须继续使用工具搜索以填补缺口。不得直接进入测试用例设计或代码编写。
(2) 当外部依赖无法被 mock 时，尝试：
- 使用真实对象
- 调整输入参数，或
- 设置内部状态以触发期望的分支。
