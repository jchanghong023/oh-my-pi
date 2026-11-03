---
description: '指定文件列表生成单元测试，串行调度 developer-test-agent 逐文件执行，最终输出执行报告。'
---

指定源码文件列表（支持 Java、C/C++、Go 和 Python），为每个业务类/函数生成单元测试，自动创建 DT 任务队列并串行调度 `developer-test-agent:developer-test-agent` 逐个执行，最终输出执行报告。

## 参数

- `{files}` - 被测文件路径，多个文件通过空格分割（必需）

## 调用方式

```
/developer-test-agent:generate-dt-files src/main/java/com/foo/OrderService.java src/main/java/com/foo/PaymentService.java
/developer-test-agent:generate-dt-files src/core/OrderService.cpp include/core/OrderService.h
/developer-test-agent:generate-dt-files internal/service/OrderService.go internal/service/PaymentService.go
/developer-test-agent:generate-dt-files app/services/order_service.py app/services/payment_service.py
```

文件路径跟随命令直接传入，支持绝对路径和相对路径。系统根据文件扩展名自动检测目标语言（`.java` → Java；`.c`/`.cpp`/`.cc`/`.cxx`/`.h`/`.hpp`/`.hxx` → C/C++；`.go` → Go；`.py` → Python），并应用对应语言的扫描、过滤和生成规则。

## 执行流程

### 1. 获取文件列表

将 `{files}` 参数中空格分割的文件路径解析为文件列表。

**文件列表概览输出**：

```
文件列表加载结果：
- 目标语言: {Java | C/C++ | Go | Python}
- 找到: {N} 个文件
  - FileA.java / FileA.cpp / FileA.go / FileA.py
  - FileB.java / FileB.cpp / FileB.go / FileB.py
  - FileC.java / FileC.cpp / FileC.go / FileC.py
```

若文件列表为空，输出以下提示并**终止执行**：

```
未检测到被测文件。
请检查输入参数是否正确。
```

### 1.1 语言检测

从文件列表中的文件扩展名检测目标语言：

| 扩展名 | 语言 |
|--------|------|
| `.java` | Java |
| `.c` / `.cpp` / `.cc` / `.cxx` / `.h` / `.hpp` / `.hxx` | C/C++ |
| `.go` | Go |
| `.py` | Python |

若文件列表中同时包含 Java、C/C++、Go 和 Python 文件，按文件扩展名逐一检测，每个文件使用其对应语言的过滤规则。

### 2. 验证文件存在性

对文件列表中的每个路径，验证文件是否存在：

```
Glob({ pattern: "{filepath}" })
```

过滤规则：
- Java: 排除 `*Test.java` 和 `*Tests.java` 测试文件
- C/C++: 排除 `*_test.cpp`、`*_test.c`、`*_test.cc`、`*_test.cxx`、`*_unittest.cpp`、`*_unittest.c`、`*_unittest.cc`、`*_unittest.cxx`、`Test*.cpp`、`Test*.c`、`Test*.cc`、`Test*.cxx`、`Test*.h`、`Test*.hpp`、`Test*.hxx`、`*_mock.cpp`、`*_mock.c`、`*_mock.cc`、`*_mock.cxx`、`*_mock.h`、`*_mock.hpp`、`*_mock.hxx`、`*_stub.cpp`、`*_stub.c`、`*_stub.cc`、`*_stub.cxx` 等测试/Mock 文件
- Go: 排除 `*_test.go` 测试文件
- Python: 排除 `test_*.py`、`*_test.py`、`conftest.py` 等测试/夹具文件
- 排除不存在的文件（记录到无效文件列表）

**验证输出**：

```
文件验证结果：
- 有效文件: {N} 个
- 无效文件: {K} 个（文件不存在或为测试文件）
  - InvalidFile.java - 文件不存在
  - SomeTest.java - 测试文件，已排除
  - SomeTest.cpp - 测试文件，已排除
  - SomeTest.go - 测试文件，已排除
  - test_something.py - 测试文件，已排除
```

若有效文件数为 0，输出以下提示并**终止执行**：

```
没有可生成测试的有效文件。
```

### 3. 过滤无业务逻辑类

在创建任务之前，对步骤 2 中的所有有效文件进行前置过滤，提前排除无需生成测试的类，减少无效任务创建。

根据文件扩展名自动选择对应语言的过滤规则。

#### Java 过滤规则

1. **数据传输对象类**（DTO/VO/Entity/PO/DO/BO）
   - 命名特征：类名以 DTO、VO、Entity、PO、DO、BO 结尾
   - 内容特征：仅包含 getter/setter、简单字段定义、无业务方法

2. **Mapper接口类**（MyBatis Mapper）
   - 命名特征：类名以 Mapper 结尾，且是 interface
   - 内容特征：仅定义数据库操作方法签名，无实现逻辑

3. **常量类**（Constants/Constant）
   - 命名特征：类名以 Constants、Constant 结尾
   - 内容特征：仅包含 static final 常量定义

4. **枚举类**（Enum）
   - 命名特征：使用 enum 关键字定义
   - 内容特征：仅包含枚举值定义，无复杂逻辑

5. **接口定义类**（纯接口）
   - 内容特征：仅定义方法签名，无默认实现，无业务逻辑

#### C/C++ 过滤规则

1. **纯数据结构体**（POD/Plain Struct）
   - 内容特征：仅包含数据成员定义（int、float、指针等），无成员函数或仅有简单构造/析构函数
   - 命名特征：`struct` 关键字定义，无方法体

2. **纯声明头文件**（Header-only Declarations）
   - 内容特征：仅包含函数声明（无实现体）、`extern` 变量声明、前向声明
   - 文件特征：`.h`/`.hpp` 文件中无函数定义体

3. **常量/宏定义头文件**（Constants/Defines）
   - 内容特征：仅包含 `#define` 宏、`const`/`constexpr` 常量定义，无业务逻辑函数
   - 命名特征：文件名含 `constants`、`config`、`defines` 等

4. **枚举定义文件**（Enum）
   - 内容特征：仅包含 `enum`/`enum class` 定义，无业务逻辑函数

5. **类型别名头文件**（Typedef/Using）
   - 内容特征：仅包含 `typedef`、`using` 别名定义、`#include` 指令，无业务逻辑

6. **纯接口抽象类**（Pure Abstract Class）
   - 内容特征：仅包含纯虚函数声明（`= 0`），无非纯虚成员函数

#### Go 过滤规则

1. **纯数据结构体**（Data-only Struct）
   - 内容特征：仅包含 `type X struct { ... }` 字段定义，无关联方法
   - 命名特征：`struct` 关键字定义，无方法体

2. **常量/变量定义文件**（Constants/Variables）
   - 内容特征：仅包含 `const`/`var` 声明，无函数定义
   - 命名特征：文件名含 `constants`、`config`、`defines` 等

3. **类型别名文件**（Type Aliases）
   - 内容特征：仅包含 `type X = Y` 别名定义，无业务逻辑函数

4. **纯接口定义文件**（Pure Interface）
   - 内容特征：仅包含 `type X interface { ... }` 接口声明，无实现

5. **main 包入口文件**（Main Package Entry）
   - 内容特征：仅包含 `package main` 和 `func main()` 入口，无其他业务函数

#### Python 过滤规则

1. **纯数据类**（Data Class / Dataclass）
   - 内容特征：仅包含 `@dataclass` 类定义或普通类仅含字段声明，无业务方法
   - 命名特征：类名含 `DTO`、`VO`、`Entity`、`Model`、`Schema` 等

2. **常量/变量定义文件**（Constants/Variables）
   - 内容特征：仅包含模块级 `CONSTANT = ...`、`var = ...` 声明，无函数定义
   - 命名特征：文件名含 `constants`、`config`、`settings`、`defines` 等

3. **类型别名文件**（Type Aliases）
   - 内容特征：仅包含 `TypeAlias` 定义（如 `UserId = int`），无业务逻辑函数

4. **纯接口/抽象基类文件**（Pure Interface / ABC）
   - 内容特征：仅包含 `abc.ABC` 子类或 `Protocol` 定义，含抽象方法声明（`@abstractmethod`），无具体实现

5. **`__init__.py` 包初始化文件**（Package Init）
   - 内容特征：仅包含 `import`/`__all__` 声明，无业务逻辑函数

**通用判断流程**：
1. 从文件路径提取类名，检查是否符合跳过规则的命名特征
2. 若符合命名特征，读取文件内容进一步检查内容特征
3. 若确认无业务逻辑，将该文件从列表中移除，记入跳过列表

**过滤输出**：

```
前置过滤结果：
- 需生成测试: {N} 个文件
  - FileA.java / FileA.cpp / FileA.go / FileA.py (全量生成)
  - FileB.java / FileB.cpp / FileB.go / FileB.py (全量生成)
- 已跳过: {K} 个文件
  - Constants.java / constants.h / constants.go / constants.py - 常量类/定义文件，无业务逻辑
  - OrderDTO.java / OrderData.h / OrderData.go / OrderData.py - 数据传输对象/纯数据类，无业务逻辑

覆盖率模式: class-level
覆盖率阈值: 80%
```

过滤后的文件列表作为步骤 4 创建任务的输入。跳过的文件仍需在步骤 6 执行报告中体现。

### 4. 创建任务队列

为步骤 3 过滤后的每个文件创建一个独立任务：

```
TaskCreate({
  subject: "为 {filename} 生成单元测试",
  description: "业务类: {filename}\n生成类型: 全量生成\n覆盖率模式: class-level\n覆盖率阈值: 80%",
  activeForm: "正在为 {filename} 生成单元测试"
})
```

**prompt 中只传入当前文件的详情，不允许传入多个文件的详情信息。**

> 注意：任务由步骤5按创建顺序串行调度，无需设置 blockedBy 依赖链。

#### 任务 Prompt 模板

```
【文件测试生成】

业务类: {filename}
生成类型: 全量生成
覆盖率模式: class-level
覆盖率阈值: 80%

目标：测试设计场景完整，覆盖率达到80%，并且断言有效性检查无问题。

使用developer-test-agent:developer-test-agent完成上面的测试任务
```

#### Prompt 变量说明

| 变量 | 来源 | 说明 |
|------|------|------|
| `{filename}` | 步骤2验证结果 | 被测文件的相对路径 |
| `{ClassName}` | 从 filename 推导 | 去掉路径和后缀的类名/文件名 |

### 5. 串行执行任务

按任务创建顺序，逐一执行：

```
1. TaskUpdate({ taskId: "{id}", status: "in_progress" })

2. Agent({
     subagent_type: "developer-test-agent:developer-test-agent",
     prompt: "<该任务的完整 prompt>"
   })

3. TaskUpdate({ taskId: "{id}", status: "completed" })
```

#### 串行调度伪代码

```
tasks = TaskList()
sorted_tasks = tasks.sortBy(id)

for task in sorted_tasks:
    TaskUpdate({ taskId: task.id, status: "in_progress" })

    result = Agent({
        name: "dt-worker-" + task.id,
        subagent_type: "developer-test-agent:developer-test-agent",
        prompt: task.description
    })

    TaskUpdate({ taskId: task.id, status: "completed" })
```

> 主 Agent 按顺序逐一启动子 Agent，天然串行，无需依赖链控制。

#### 错误处理

| 场景 | 处理方式 |
|------|---------|
| 单个文件测试生成失败 | 标记任务完成，记录失败原因，继续执行下一个任务 |
| Agent 执行超时 | 记录超时，标记任务完成，继续执行下一个任务 |

**核心原则**：单个任务失败不阻塞后续任务执行。

### 6. 输出执行报告

所有任务执行完毕后，汇总输出执行报告：

```
==========================================
文件 DT 执行报告
==========================================

覆盖率模式: class-level
阈值: 80%

文件统计:
- 输入文件: {Total}
- 无效文件: {Invalid}
- 前置过滤跳过: {K}
- 需生成测试: {N}

无效文件:
┌─────────────────────┬──────────────────────────┐
│ 文件                │ 原因                      │
├─────────────────────┼──────────────────────────┤
│ InvalidFile.java    │ 文件不存在                │
│ SomeTest.java       │ 测试文件，已排除          │
│ SomeTest.cpp        │ 测试文件，已排除          │
│ SomeTest.go        │ 测试文件，已排除          │
│ test_something.py  │ 测试文件，已排除          │
└─────────────────────┴──────────────────────────┘

前置过滤跳过（无业务逻辑类）:
┌─────────────────────┬──────────────────────────┐
│ 文件                │ 跳过原因                  │
├─────────────────────┼──────────────────────────┤
│ Constants.java      │ 常量类，无业务逻辑        │
│ OrderDTO.java       │ 数据传输对象，无业务逻辑   │
│ constants.h         │ 常量/宏定义文件，无业务逻辑│
│ OrderData.h         │ 纯数据结构体，无业务逻辑  │
│ constants.go       │ 常量/变量定义文件，无业务逻辑│
│ OrderData.go       │ 纯数据结构体，无业务逻辑  │
│ constants.py       │ 常量/变量定义文件，无业务逻辑│
│ OrderData.py       │ 纯数据类，无业务逻辑      │
└─────────────────────┴──────────────────────────┘

任务执行结果:
┌──────┬─────────────────────┬──────────┬──────────────────────────┐
│ ID   │ 文件                │ 状态     │ 说明                      │
├──────┼─────────────────────┼──────────┼──────────────────────────┤
│ 1    │ OrderService.java   │ 完成     │ 覆盖率 85%，达标            │
│ 2    │ PaymentService.java │ 完成     │ 覆盖率 92%，达标            │
│ 3    │ OrderService.cpp    │ 完成     │ 覆盖率 81%，达标            │
│ 4    │ OrderService.go    │ 完成     │ 覆盖率 83%，达标            │
│ 5    │ order_service.py   │ 完成     │ 覆盖率 87%，达标            │
└──────┴─────────────────────┴──────────┴──────────────────────────┘

执行汇总:
- 成功: {X}
- 失败: {Z}
- 总任务: {Total}

==========================================
```

---

## 流程对比表

| 测试文件状态 | 覆盖率模式 | 流程 |
|------------|----------|-----|
| 不存在测试 | class-level | generate → fix → coverage → 循环补充 → assertion-review |
| 存在测试 | class-level | coverage（优先）→ 若达标跳过 → 若未达标 generate → fix → coverage → 循环 → assertion-review |

---

## 注意事项

1. 文件列表为空时必须提示用户，不得创建空任务队列
2. 每个任务的 prompt 仅包含当前文件信息，严禁跨文件混入
3. 串行执行中，单个任务失败不阻塞后续任务执行
4. 前置过滤跳过的文件（DTO/Config/Enum 等无业务逻辑类）不创建任务，但仍需在步骤6执行报告中体现
5. 无效文件（不存在或测试文件）不创建任务，但仍需在步骤6执行报告中体现
6. 所有 DT 工作必须通过 Agent 工具委托给 `developer-test-agent:developer-test-agent`，不得由主 Agent 直接操作
7. 覆盖率阈值默认 80%，未达标时 Agent 内部循环补充测试
8. 任务由主 Agent 按创建顺序串行调度，无需设置 blockedBy 依赖链
9. 已存在测试文件时，优先使用 improve-coverage 分析覆盖率，若已达标则跳过测试生成
10. 本命令为全量生成模式，所有文件均为全量生成，覆盖率模式固定为 class-level
11. **禁止使用 Team 模式**：不得使用 `TeamCreate` 创建团队，不得在 Agent 调用中传入 `team_name` 参数，任务执行必须且只能通过 `TaskCreate` 创建独立任务 + `Agent`（无 `team_name`）串行调度
