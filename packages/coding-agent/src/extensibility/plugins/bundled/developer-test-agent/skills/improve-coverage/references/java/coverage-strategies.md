# Java 覆盖率提升策略集

本文件汇总 6 类未覆盖场景的核心策略，配合 [route.md](route.md) 按"从上到下"顺序匹配场景后查阅。

## 1. If 分支未覆盖

**问题描述**：if 语句的 true / false 分支、else-if 链分支或嵌套 if 部分分支未被覆盖。

**核心思路**：分析 if 分支触发条件，通过构造不同输入、Mock 返回值或设置不同状态，使每个 if 条件都被覆盖。

**关键策略要点**：
- 构造正向和反向输入数据（基于参数属性判断的 if）
- Mock 依赖方法返回不同值触发不同分支（基于依赖返回值判断的 if）
- 设置对象内部状态、枚举值、集合空/非空、布尔标志位的不同组合
- 对多重 if-else 每个分支至少一个测试；对数值比较覆盖边界值；对组合条件用条件矩阵法

## 2. 私有方法未覆盖

**问题描述**：private 方法未被覆盖，或 private 方法内部某些行未被覆盖。

**核心思路**：通过反射调用 private 方法，或通过 public 方法间接触发 private 方法执行。

**关键策略要点**：
- 反射调用：`getDeclaredMethod` + `setAccessible(true)`，静态方法 `invoke` 第一参数传 null
- 反射设置 private 字段：`getDeclaredField` + `setAccessible(true)` + `set`
- 处理反射异常和返回值类型转换
- 优先通过公共方法间接触发；只在必要时反射直接调用

## 3. 静态方法 Mock 限制

**问题描述**：调用静态辅助方法时，`MockedStatic` 不支持用 `when().thenReturn()` stub void 方法，会抛 `CannotStubVoidMethodWithReturnValue`。

**核心思路**：区分 void 和有返回值静态方法——void 用 `verify()`，有返回值按需 stub，并遵循最小 stub 原则。

**关键策略要点**：
- void 静态方法：`mockedStatic.verify(() -> Helper.method(any()), times(1))`
- 有返回值静态方法：`mockedStatic.when(() -> Helper.transform(any())).thenReturn(result)`
- 使用 `eq()` 精确匹配常量参数，避免 `any()` 匹配过宽
- 最小 stub：只 stub 需要控制返回值的方法，其他让真实逻辑执行；MockedStatic 必须用 try-with-resources 确保关闭

## 4. 异常处理未覆盖

**问题描述**：catch 块、throw 语句或 try-catch-finally 的异常处理分支未被覆盖。

**核心思路**：通过 Mock 依赖方法抛出异常，触发被测代码的 catch / finally 执行，从而覆盖异常分支。

**关键策略要点**：
- 使用 `when(dependency.method()).thenThrow(new XxxException())` 模拟不同异常类型（RuntimeException、DataAccessException、TimeoutException 等）
- 使用 `assertThrows(XxxException.class, () -> ...)` 验证自定义异常类型和消息
- 覆盖 finally 块：`verify(mockResource, times(1)).close()`，无论正常或异常路径都执行
- 验证异常类型匹配 catch 块、处理逻辑、资源释放、日志记录

## 5. 外部依赖未覆盖

**问题描述**：涉及 Redisson 分布式锁、S3/OSS 文件服务、CompletableFuture/消息队列、HTTP/RPC、Redis 缓存等外部依赖调用的代码未被覆盖。

**核心思路**：通过 Mock 隔离外部依赖，模拟各种返回值和异常情况，覆盖依赖调用的代码路径。

**关键策略要点**：
- Redisson 锁：Mock `RLock`，预设 `tryLock`、`isHeldByCurrentThread` 返回值
- 文件服务：Mock `S3Client`，预设 `putObject`/`getObject`
- 异步处理：`when(executor.submit(any())).thenReturn(CompletableFuture.completedFuture(result))`
- HTTP/RPC：Mock `HttpClient` 或 `RestTemplate`，预设 `HttpResponse` 返回值
- 缓存和消息队列：Mock `RedisTemplate.opsForValue()`、`KafkaTemplate.send()`

## 6. hdt-java 工具脚本

执行覆盖率命令的工具脚本说明，支持 class-level、package-level、project-level、incremental 四种场景。覆盖率获取优先级为 **codecovcli → JaCoCo**，codecovcli 失败后自动降级到 JaCoCo，无需询问用户。

**参数来源**：sourceClass、testClass、scenario、targetBranch（incremental 必需）。

### 6.1 codecovcli 流程（首选）

- Step 0：检查 `codecovcli --version`；未安装时配置华为 npm 仓库后 `npm install -g @baize/codecovcli@latest`
- Step 1：从加载 `improve-coverage` 时返回的 baseDir 下 `scripts/java/extract-maven-config.js` 输出获取 settingsPath 和 mavenProperties，无输出用默认参数
- Step 2：按 scenario 构建命令；incremental 场景必须加 `--targetbranch "{targetBranch}"`，路径用引号包裹，mavenProperties 不带引号
- Step 3：`bash` 工具执行，timeout: 1200（20 分钟）
- Step 4：解析输出返回行覆盖率、分支覆盖率、被测类列表、测试结果

### 6.2 JaCoCo fallback 流程（备选）

codecovcli 执行失败（未安装、命令报错、超时等）后自动执行以下步骤，无需询问用户：

- Step 1：复用 baseDir 下 `scripts/java/extract-maven-config.js` 提取 Maven 配置（settingsPath + mavenProperties），与 codecovcli 逻辑一致
- Step 2：构建 JaCoCo 命令
  - 有配置：`mvn clean test jacoco:report -pl {module} -Dtest={testClass} -DfailIfNoTests=false -s "{settingsPath}" {mavenProperties}`
  - 无配置：`mvn clean test jacoco:report -pl {module} -Dtest={testClass} -DfailIfNoTests=false`
- Step 3：`bash` 工具执行，timeout: 1200（20 分钟）
- Step 4：执行 `node "{SKILL_DIR}/scripts/java/extract-jacoco-coverage.js" {className} {module}/target/site/jacoco/jacoco.xml` 提取覆盖率数据（`{SKILL_DIR}` 为 `improve-coverage` 加载时返回的 baseDir，Windows 下路径反斜杠须改为正斜杠）
  - 脚本从 `jacoco.xml` 中解析指定类的覆盖率，生成 `.codecovcli/cache/java_{className}.json`
  - 输出格式与 codecovcli 一致，后续分析流程无需区分数据来源

**异常处理建议**：检查 codecovcli 是否安装、settings.xml 路径、类全限定名、目标分支是否存在；JaCoCo fallback 时检查 pom.xml 是否配置 jacoco-plugin、模块路径是否正确。
