# 覆盖率问题路由

请根据覆盖率报告中未覆盖代码的特征，按照 **从上到下** 的顺序匹配规则。一旦匹配成功，立即加载 [coverage-strategies.md](coverage-strategies.md) 定位对应章节。

## 无测试用例

- **触发条件**: 测试类中没有任何 `@Test` 注解
- **处理方式**: 无需策略文件，用户需要先生成测试用例

## If分支未覆盖

- **触发关键词**: `if`, `else`, `Objects.equals`, `CollectionUtils.isEmpty`, `isEmpty()`, `>`, `<`, `==`, `!=`
- **其他特征**：
  - 未覆盖的代码行位于 if 语句块内
  - if 条件为 true 的分支未被覆盖
  - if 条件为 false 的分支（else 分支）未被覆盖
  - 多重 if-else if-else 链中的部分分支未被覆盖
  - 嵌套 if 语句的部分分支未被覆盖
- **目标章节**: [coverage-strategies.md §1 If 分支未覆盖](coverage-strategies.md)

## 异常场景

- **触发关键词**: `catch`, `Exception`, `throw`, `throws`, `try`
- **其他特征**：
  - 未覆盖的代码行位于 catch 块中
  - 未覆盖的代码行是 throw 语句
  - 未覆盖的代码行是 try-catch-finally 的异常处理分支
  - 覆盖率报告中显示 Exception 相关的行未被覆盖
- **目标章节**: [coverage-strategies.md §4 异常处理未覆盖](coverage-strategies.md)

## 外部依赖场景

- **触发关键词**: `Redisson`, `RLock`, `S3`, `oss`, `async`, `CompletableFuture`, `@Async`, `Redis`, `HttpClient`, `RestTemplate`, `Feign`
- **其他特征**：
  - 未覆盖的代码行涉及分布式锁操作（Redisson锁）
  - 未覆盖的代码行涉及文件上传/下载（S3、OSS、HDFS）
  - 未覆盖的代码行涉及异步处理（CompletableFuture、消息队列）
  - 未覆盖的代码行涉及远程HTTP/RPC调用
  - 未覆盖的代码行涉及缓存操作（Redis）
- **目标章节**: [coverage-strategies.md §5 外部依赖未覆盖](coverage-strategies.md)

## 静态方法Mock限制

- **触发关键词**: `MockedStatic`, `CannotStubVoidMethodWithReturnValue`, 静态工具类
- **其他特征**：
  - 未覆盖的代码行涉及调用静态辅助类方法
  - 静态方法为 void 类型，无法使用 `when().thenReturn()` stub
  - 测试执行时报错 `CannotStubVoidMethodWithReturnValue`
- **目标章节**: [coverage-strategies.md §3 静态方法 Mock 限制](coverage-strategies.md)

## 私有方法未覆盖

- **触发关键词**: （需要分析覆盖率报告中未覆盖方法的方法名）
- **其他特征**：
  - 未覆盖的代码行位于 private 方法中
  - 该 private 方法未被任何测试用例直接调用
- **目标章节**: [coverage-strategies.md §2 私有方法未覆盖](coverage-strategies.md)
