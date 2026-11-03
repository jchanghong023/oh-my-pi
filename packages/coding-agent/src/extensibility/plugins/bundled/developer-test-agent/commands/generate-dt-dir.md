---
description: '指定目录全量生成单元测试，串行调度 developer-test-agent 逐文件执行，最终输出执行报告。'
---

指定源码目录（支持 Java、C/C++、Go 和 Python），扫描目录下所有业务类/源文件，全量为每个类/函数生成单元测试，自动创建 DT 任务队列并串行调度 `developer-test-agent:developer-test-agent` 逐个执行，最终输出执行报告。

## 参数

- `{dir}` - 源码目录路径（必填，支持绝对路径和相对路径），如：
  - Java 绝对路径：`D:\workspaceGree\codecov\CodeCovService\src\main\java\com\huawei\codecov\freeresolver\service\reportconfig`
  - Java 相对路径：`src/main/java/com/huawei/codecov/freeresolver/service/reportconfig`
  - C/C++ 绝对路径：`D:\project\zstd\lib\dictBuilder`
  - C/C++ 相对路径：`src/core/service`
  - Go 绝对路径：`D:\project\myapp\internal\service`
  - Go 相对路径：`internal/service`
  - Python 绝对路径：`D:\project\myapp\app\services`
  - Python 相对路径：`app/services`

## 调用方式

```
/developer-test-agent:generate-dt-dir D:\workspaceGree\codecov\CodeCovService\src\main\java\com\huawei\codecov\freeresolver\service\reportconfig
/developer-test-agent:generate-dt-dir src/core/service
/developer-test-agent:generate-dt-dir internal/service
/developer-test-agent:generate-dt-dir app/services
```

目录路径跟随命令直接传入；若命令未传入目录，则通过交互让用户手动输入。系统根据扫描到的文件扩展名自动检测目标语言并应用对应规则。

## 执行流程

### 1. 确定目录路径

若命令参数中已包含 `{dir}`，直接使用。若未传入，**必须使用 AskUserQuestion 工具让用户输入目录路径**：

```
AskUserQuestion({
  questions: [{
    question: "请输入需要生成测试的源码目录路径（支持绝对路径和相对路径，Java、C/C++、Go 或 Python 均可）：",
    header: "目录路径",
    multiSelect: false,
    options: [
      { label: "手动输入", description: "在 Other 中输入目录路径，如 D:\\project\\src\\main\\java\\com\\huawei\\service 或 src/core/service 或 internal/service 或 app/services" }
    ]
  }]
})
```

确定后续步骤的执行参数：

| 参数 | 值 |
|------|---|
| 目录路径 | 命令参数中的 `{dir}` 或用户交互输入 |
| 覆盖率模式 | class-level |

> 本命令为全量生成模式，不依赖 Git 变更，直接扫描指定目录下所有业务类。

### 2. 扫描目录文件

根据用户提供的 `{dir}`，扫描该目录下所有源码文件，同时扫描 Java、C/C++、Go 和 Python 文件，自动检测目标语言：

```
Glob({ pattern: "{dir}/**/*.java" })
Glob({ pattern: "{dir}/**/*.cpp" })
Glob({ pattern: "{dir}/**/*.c" })
Glob({ pattern: "{dir}/**/*.cc" })
Glob({ pattern: "{dir}/**/*.cxx" })
Glob({ pattern: "{dir}/**/*.h" })
Glob({ pattern: "{dir}/**/*.hpp" })
Glob({ pattern: "{dir}/**/*.hxx" })
Glob({ pattern: "{dir}/**/*.go" })
Glob({ pattern: "{dir}/**/*.py" })
```

**语言检测规则**：
- 若扫描到 `.java` 文件 → 目标语言为 Java
- 若扫描到 `.c`/`.cpp`/`.cc`/`.cxx`/`.h`/`.hpp`/`.hxx` 文件 → 目标语言为 C/C++
- 若扫描到 `.go` 文件 → 目标语言为 Go
- 若扫描到 `.py` 文件 → 目标语言为 Python
- 若同时存在多种语言文件，以数量多的语言为准，少数语言文件单独处理（即为少数语言文件创建独立任务，任务 prompt 中标注目标语言，按该语言的过滤和生成规则执行）

过滤规则：
- Java: 排除 `*Test.java` 和 `*Tests.java` 测试文件
- C/C++: 排除 `*_test.cpp`、`*_test.c`、`*_test.cc`、`*_test.cxx`、`*_unittest.cpp`、`*_unittest.c`、`*_unittest.cc`、`*_unittest.cxx`、`Test*.cpp`、`Test*.c`、`Test*.cc`、`Test*.cxx`、`Test*.h`、`Test*.hpp`、`Test*.hxx`、`*_mock.cpp`、`*_mock.c`、`*_mock.cc`、`*_mock.cxx`、`*_mock.h`、`*_mock.hpp`、`*_mock.hxx`、`*_stub.cpp`、`*_stub.c`、`*_stub.cc`、`*_stub.cxx` 等测试/Mock 文件
- Go: 排除 `*_test.go` 测试文件
- Python: 排除 `test_*.py`、`*_test.py`、`conftest.py` 等测试/夹具文件

**目录扫描概览输出**：

```
目录扫描结果（{dir}）：
- 目标语言: {Java | C/C++ | Go | Python}
- 找到: {N} 个源文件
  - FileA.java / FileA.cpp / FileA.go / FileA.py
  - FileB.java / FileB.cpp / FileB.go / FileB.py
  - FileC.java / FileC.cpp / FileC.go / FileC.py
```

若目录下无源码文件，输出以下提示并**终止执行**：

```
目录 {dir} 下未检测到源码文件。
请检查目录路径是否正确。
```

### 3. 过滤无业务逻辑类

在创建任务之前，对步骤 2 中的所有文件进行前置过滤，提前排除无需生成测试的类，减少无效任务创建。

根据检测到的目标语言选择对应过滤规则。

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
  subject: "为 {filename} 全量生成单元测试",
  description: "目录: {dir}\n业务类: {filename}\n生成类型: 全量生成\n覆盖率模式: class-level\n覆盖率阈值: 80%",
  activeForm: "正在为 {filename} 全量生成单元测试"
})
```

**prompt 中只传入当前文件的详情，不允许传入多个文件的详情信息。**

> 注意：任务由步骤5按创建顺序串行调度，无需设置 blockedBy 依赖链。

#### 任务 Prompt 模板

```
【目录测试生成】

目录: {dir}
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
| `{dir}` | 命令参数 | 源码目录路径（绝对或相对） |
| `{filename}` | 步骤2扫描结果 | 业务类/源文件的相对路径 |
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
全量 DT 执行报告
==========================================

目录: {dir}
覆盖率模式: class-level
阈值: 80%

扫描统计:
- 扫描文件: {Total}
- 前置过滤跳过: {K}
- 需生成测试: {N}

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

1. 目录为空时必须提示用户，不得创建空任务队列
2. 每个任务的 prompt 仅包含当前文件信息，严禁跨文件混入
3. 串行执行中，单个任务失败不阻塞后续任务执行
4. 前置过滤跳过的文件（DTO/Config/Enum 等无业务逻辑类）不创建任务，但仍需在步骤6执行报告中体现
5. 所有 DT 工作必须通过 Agent 工具委托给 `developer-test-agent:developer-test-agent`，不得由主 Agent 直接操作
6. 覆盖率阈值默认 80%，未达标时 Agent 内部循环补充测试
7. 任务由主 Agent 按创建顺序串行调度，无需设置 blockedBy 依赖链
8. 已存在测试文件时，优先使用 improve-coverage 分析覆盖率，若已达标则跳过测试生成
9. 本命令为全量生成模式，所有文件均为全量生成，无需解析变更方法，覆盖率模式固定为 class-level
10. **禁止使用 Team 模式**：不得使用 `TeamCreate` 创建团队，不得在 Agent 调用中传入 `team_name` 参数，任务执行必须且只能通过 `TaskCreate` 创建独立任务 + `Agent`（无 `team_name`）串行调度
