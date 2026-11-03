# mockcpp完整使用指南

## 1. 概述

mockcpp 是一个开源的 C/C++ Mock 框架，用于单元测试中隔离外部依赖。它可以实现：
- **改变函数调用行为**：修改返回值，调用桩函数（打桩）
- **对函数入参进行校验**
- **对函数出参进行设定**

### 函数种类支持

| 函数种类 | 支持情况 | 备注 |
|---------|---------|------|
| C语言函数 | 支持 | 不支持可变参数函数 |
| C++静态成员函数 | 支持 | 不支持可变参数函数 |
| C++类成员函数 | 支持 | 不支持变参 |
| C++虚函数 | 支持 | 不支持变参 |
| C++重载函数 | 支持 | 不支持变参 |
| 可变参数函数 | 不支持 | - |

### 平台支持与兼容性

- X86/X64/ARM 平台均支持
- **Windows/MinGW 限制**：mockcpp 依赖 `sys/mman.h`，在 Windows/MinGW 下可能无法编译
- 如果 mockcpp 编译失败，不要修改 mockcpp 源码，记录限制并使用替代方案（gmock/binmock/手动构造）

## 2. 引入方式

```cpp
#include <mockcpp/mockcpp.h>

// 链接对应的库文件
// 32位：libdtcenter.a
// 64位：libdtcenter64.a
```

## 3. Mock对象类型

| 对象类型 | 支持的打桩范围 | 备注 |
|---------|---------------|------|
| `MOCKER` | C语言函数，C++类的静态成员函数 | - |
| `MOCKER_CPP` | 普通类的非重载成员函数、重载成员函数、模板函数、模板类的成员函数 | 类的成员函数只支持公有成员函数 |
| `MOCKER_CPP_VIRTUAL` | C++类的虚函数成员 | 对类的所有对象都能生效 |
| `MOCK_METHOD` | C++类的虚函数成员 | 对类的某个实例的成员函数打桩，仅实例的成员函数生效 |

**使用建议**：对于虚函数的打桩，更推荐使用 `MOCKER_CPP_VIRTUAL`。`MOCK_METHOD` 适用于需要针对特定实例打桩的场景。

## 4. 核心关键字

### 4.1 调用次数约束关键字（`.expects()`）

| 关键字 | 说明 |
|-------|------|
| `once()` | 限定检验次数为一次 |
| `never()` | 限定为不调用 |
| `exactly(n)` | 限定检验次数为n次 |
| `atLeast(n)` | 限定最少调用次数为n次 |
| `atLeastOnce()` | 限定最少调用次数为1次 |
| `atMost(n)` | 限定最多调用次数为n次 |
| `atMostOnce()` | 限定最多调用次数为1次 |

### 4.2 函数行为关键字（`.will()`）

| 关键字 | 说明 |
|-------|------|
| `returnValue(val)` | 返回指定值 |
| `invoke(stubFunc)` | 使用桩函数替换 |
| `ignoreReturnValue()` | 忽略返回值 |
| `throws(ex)` | 抛出异常 |
| `outboundP(val)` / `outbound(val)` | 设置输出参数 |
| `returnObjectList(v1, v2, ...)` | 依次返回多个值 |
| `increase(n)` | 每次调用返回值增加n |
| `repeat(n, val)` | 返回val n次 |
| `then()` | 在expects场景下，第N次调用返回第N个stub的值 |

**常用组合**：
- `.stubs()` + `.will(returnValue(val))` — 修改返回值，不校验次数
- `.stubs()` + `.will(invoke(func))` — 使用桩函数替换
- `.expects(...)` + `.will(returnValue(val))` — 指定行为并校验次数

### 4.3 参数约束关键字（`.with()`）

| 关键字 | 说明 |
|-------|------|
| `eq()` | 相等约束（用于整形、字符型、浮点型、bool、枚举） |
| `neq()` | 不等约束 |
| `gt()` / `lt()` | 大于/小于约束 |
| `any()` | 任意值约束 |
| `mirror()` | 内存内容的严格相等性 |
| `startWith()` | 字符串前缀约束 |
| `endWith()` | 字符串后缀约束 |
| `contains()` | 字符串包含约束 |
| `outbound()` / `outBoundP()` | 设置输出参数 |
| `checkWith()` | 定制化的入参检查 |
| `die()` | 模拟函数调用崩溃 |
| `spy()` | 对象内容监控 |

## 5. 场景化用法

### 5.1 C语言函数打桩

使用 `MOCKER` 关键字：

```cpp
int GetMax(int a, int b) {
    return a > b ? a : b;
}

TEST_F(TestFunc, TestCase) {
    EXPECT_EQ(3, GetMax(2, 3));
    
    // 修改返回值
    MOCKER(&GetMax).stubs().will(returnValue(0));
    EXPECT_EQ(0, GetMax(2, 3));
    
    // 使用桩函数替换
    MOCKER(&GetMax).stubs().will(invoke(GetMaxStub));
    
    // 校验调用次数
    MOCKER(&GetMax).expects(once()).will(returnValue(0));
    
    GlobalMockObject::verify();
}
```

### 5.2 C++静态成员函数打桩

同样使用 `MOCKER` 关键字：

```cpp
class Calculator {
public:
    static int GetMax(int a, int b) {
        return a > b ? a : b;
    }
};

TEST_F(TestFunc, TestCase) {
    MOCKER(&Calculator::GetMax).stubs().will(returnValue(0));
    EXPECT_EQ(0, Calculator::GetMax(2, 3));
    GlobalMockObject::verify();
}
```

### 5.3 C++普通成员函数打桩

使用 `MOCKER_CPP` 关键字。**桩函数的第一个参数必须为被打桩类的指针**：

```cpp
class Calculator {
public:
    int Add(int a, int b) {
        return a + b;
    }
};

// 桩函数签名: RetType Stub(ClassName* obj, Param1, Param2...)
int AddStub(Calculator* obj, int a, int b) {
    return a + b + 100;
}

TEST_F(TestFunc, TestCase) {
    Calculator calc;
    MOCKER_CPP(&Calculator::Add)
        .stubs()
        .will(invoke(AddStub));
    EXPECT_EQ(103, calc.Add(2, 3));
    GlobalMockObject::verify();
}
```

### 5.4 C++虚函数打桩

#### MOCKER_CPP_VIRTUAL（全局生效）

对类的所有对象都能生效：

```cpp
class CalculatorBase {
public:
    virtual int Multiply(int a, int b) { return a * b; }
    virtual ~CalculatorBase() {}
};

int MultiplyStub(CalculatorBase* obj, int a, int b) {
    return a * b + 100;
}

TEST_F(TestFunc, TestCase) {
    CalculatorBase obj;
    MOCKER_CPP_VIRTUAL(obj, &CalculatorBase::Multiply, int (CalculatorBase::*)(int, int))
        .stubs()
        .will(invoke(MultiplyStub));
    EXPECT_EQ(106, obj.Multiply(2, 3));
}
```

#### MOCK_METHOD（实例级别生效）

仅对特定实例生效：

```cpp
MockObject<CalculatorBase> mocker;
MOCK_METHOD(mocker, Multiply).stubs().will(invoke(MultiplyStub));
EXPECT_EQ(106, mocker->Multiply(2, 3));
mocker.verify();
```

**推荐**：对于虚函数的打桩，更推荐使用 `MOCKER_CPP_VIRTUAL`。

### 5.5 模板函数打桩

使用 `MOCKER_CPP` 并指定模板实例化类型：

```cpp
template<typename T>
T GetMax(T t1, T t2) {
    return t1 > t2 ? t1 : t2;
}

TEST_F(TestFunc, TestCase) {
    // 对 typename 为 int 的模板函数实例进行打桩
    MOCKER_CPP(&GetMax<int>, int (*)(int, int))
        .stubs()
        .will(returnValue(0));
    EXPECT_EQ(0, GetMax(1, 2));
}
```

### 5.6 重载函数打桩

使用 `MOCKER_CPP` 并指定函数签名：

```cpp
class Calculator {
public:
    int Add(int a, int b) { return a + b; }
    int Add(int a, int b, int c) { return a + b + c; }
    double Add(double a, double b) { return a + b; }
};

TEST_F(TestFunc, TestCase) {
    // 必须指定签名，否则Mock不生效
    MOCKER_CPP(&Calculator::Add, int (Calculator::*)(int, int))
        .stubs()
        .will(returnValue(100));
    
    Calculator calc;
    EXPECT_EQ(100, calc.Add(1, 2));
    GlobalMockObject::verify();
}
```

### 5.7 宏内调用函数的Mock

如果宏定义内部调用了其他函数，直接 Mock 那个被调用的函数：

```cpp
#define MAX(a, b) GetMax(a, b)

TEST_F(TestFunc, TestCase) {
    MOCKER(&GetMax).stubs().will(returnValue(0));
    EXPECT_EQ(0, MAX(2, 3));  // 宏展开为 GetMax(2,3)
    GlobalMockObject::verify();
}
```

## 6. 高级用法

### 6.1 校验函数调用次数

```cpp
// 期望只执行一次
MOCKER(&func1).expects(once()).will(returnValue(0));

// 期望执行两次
MOCKER(&func1).expects(exactly(2)).will(returnValue(0));

// 期望从不调用
MOCKER(&func1).expects(never()).will(returnValue(0));

// 期望至少调用两次
MOCKER(&func1).expects(atLeast(2)).will(returnValue(0));
```

### 6.2 顺序调用（`.then()`）

在 `.expects(exactly(n))` 场景下，使用 `.then()` 实现第N次调用返回第N个stub的值：

```cpp
MOCKER(TestFunc)
    .expects(exactly(2))
    .then(returnValue(999))  // 第1次调用返回999
    .then(returnValue(888)); // 第2次调用返回888

EXPECT_EQ(999, TestFunc());  // 第1次调用
EXPECT_EQ(888, TestFunc());  // 第2次调用
```

### 6.3 约束函数入参

```cpp
MOCKER(&func)
    .expects(once())
    .with(eq(1), eq(2))  // 校验入参为 1 和 2
    .will(returnValue(3));

MOCKER(&func)
    .expects(once())
    .with(any(), any())  // 任意参数都匹配
    .will(returnValue(100));
```

### 6.4 设置函数出参

```cpp
void getValue(int* output);

TEST_F(TestFunc, TestCase) {
    int value = 0;
    MOCKER(&getValue)
        .expects(once())
        .will(outboundP(100));  // 设置出参为 100
    getValue(&value);
    EXPECT_EQ(100, value);
    GlobalMockObject::verify();
}
```

### 6.5 桩类型与优先级

| 类型 | 说明 |
|------|------|
| `.stubs()` | 指定函数的行为，不校验次数 |
| `.defaults()` | 定义一个缺省的mock行为规范 |
| `.expects()` | 指定函数行为并校验调用次数 |

**优先级**：`.stubs()` > `.defaults()` > `.expects()`

## 7. 决策流程图

### 第一步：选择Mocker类型

```
是C函数或C++静态成员函数吗？
├── 是 → 使用 MOCKER(&func)
└── 否
    是C++虚函数吗？
    ├── 是
    │   ├── 需要全局生效（所有实例）？→ 使用 MOCKER_CPP_VIRTUAL
    │   └── 只需要特定实例生效？→ 使用 MOCK_METHOD
    └── 否
        是模板函数吗？
        ├── 是 → 使用 MOCKER_CPP + 签名指定模板实例化类型
        └── 否
            是重载函数吗？
            ├── 是 → 使用 MOCKER_CPP + 签名
            └── 否 → 使用 MOCKER_CPP
```

### 第二步：选择Mock行为

```
需要校验调用次数吗？
├── 是 → 使用 .expects(次数约束)
│       ├── 仅期望特定次数 → once() / exactly(n)
│       ├── 至少/至多 → atLeast(n) / atMost(n)
│       └── 需要顺序返回不同值？→ 叠加 .then()
└── 否 → 使用 .stubs()

需要校验入参吗？
├── 是 → 使用 .with(参数约束)
│       ├── 精确匹配 → eq(val)
│       ├── 任意值 → any()
│       └── 字符串约束 → startWith / contains
└── 否 → 省略 .with()

需要改变函数行为吗？
├── 是 → 使用 .will(行为)
│       ├── 返回固定值 → returnValue(val)
│       ├── 使用桩函数替换 → invoke(stubFunc)
│       ├── 设置出参 → outboundP(val)
│       ├── 抛出异常 → throws(ex)
│       └── 依次返回多个值 → returnObjectList 或 .then()
└── 否 → 省略 .will()
```

## 8. 最佳实践

### 8.1 桩复位

每个测试用例结束后，必须调用 `GlobalMockObject::reset()` 或 `GlobalMockObject::verify()` 清除桩行为：

```cpp
GlobalMockObject::reset();   // 清除桩，不做校验
GlobalMockObject::verify();  // 清除桩并校验调用次数
```

### 8.2 选择合适的Mock对象类型

| 场景 | 推荐使用 |
|-----|---------|
| C语言函数 | `MOCKER` |
| C++静态成员函数 | `MOCKER` |
| C++普通成员函数（无虚函数） | `MOCKER_CPP` |
| C++虚函数（全局生效） | `MOCKER_CPP_VIRTUAL` |
| C++虚函数（实例生效） | `MOCK_METHOD` |
| 重载函数 | `MOCKER_CPP` + 签名 |
| 模板函数 | `MOCKER_CPP` + 模板实例化类型 |

### 8.3 桩函数签名

对于类成员函数的桩函数，第一个参数必须是对应类的指针：

```cpp
// 类成员函数桩函数签名
ReturnType StubFunc(ClassName* obj, Param1Type p1, Param2Type p2) {
    // ...
}
```

### 8.4 常用行为关键字

掌握 `returnValue()`、`ignoreReturnValue()` 和 `invoke()` 这三个关键字，能搞定90%以上的函数调用行为场景。

## 9. 快速参考

| 函数类型 | 使用方式 | 说明 |
|----------|----------|------|
| C语言函数 | `MOCKER(&func)` | - |
| C++静态成员函数 | `MOCKER(&Class::Func)` | - |
| C++普通成员函数 | `MOCKER_CPP(&Class::Func)` | 桩函数第一个参数是`Class*` |
| C++虚函数（全局生效） | `MOCKER_CPP_VIRTUAL(obj, &Class::Func, sig)` | 对所有实例都生效 |
| C++虚函数（实例级别） | `MOCK_METHOD(mockObj, Func)` | 仅对特定实例生效 |
| 重载函数 | `MOCKER_CPP(&func, sig)` | 必须指定函数签名 |
| 模板函数 | `MOCKER_CPP(&func, sig)` | 指定模板实例化类型 |

**核心语法**：
```
基本模式: MOCKER_XXX(func).expects(...).with(...).will(...)
每个测试用例后必须调用: GlobalMockObject::verify() 或 GlobalMockObject::reset()
```

## 10. 特殊场景

### 场景1：待测函数内部遍历集合/容器/结果集

规则：禁止Mock遍历操作函数（HasNext/FetchNext/GetNext/Next等），应该Mock数据提供函数并在输出参数中填充测试数据。

- 遍历操作（HasNext/FetchNext/GetNext/Next等）：禁止Mock，使用真实实现
- 数据提供操作（ExecQuery/Fetch/GetAll等）：可以Mock，通过输出参数返回测试数据

```cpp
// 错误做法：Mock遍历函数
MOCKER_CPP(&DataSource::FetchNext)
    .stubs()
    .will(returnValue(true));

// 正确做法：Mock数据提供函数，填充输出参数
ErrorCode DataProviderStub(..., DataContainer& outResult) {
    Row row;
    row.push_back(Value(1));
    row.push_back(Value(2));
    outResult.AddRow(row);
    return ErrorCode::SUCCESS;
}
MOCKER_CPP(&DataSource::ExecuteQuery, Sig)
    .stubs()
    .will(invoke(DataProviderStub));
```

关键点：
- 遍历器是"消费者"，数据提供函数是"生产者"
- Mock生产者而非消费者
- 测试数据通过输出参数的容器结构填充（如push_back/AddRow/append等）

### 场景2：待测函数内部通过单例获取函数获取实例，再调用实例方法

规则：禁止Mock单例获取函数（GetInstance/sInstance/GetSingleton等），应该直接Mock实例方法。

- 单例获取函数（GetInstance/sInstance/GetSingleton等）：禁止Mock，使用真实实现
- 实例方法（被测函数内部调用的其他方法）：可以Mock

```cpp
// 错误做法1：Mock单例获取函数
MOCKER_CPP(&SingletonManager::GetInstance)
    .stubs()
    .will(returnValue(&mockObj));

// 错误做法2：随意强转函数指针类型
MOCKER_CPP(&SingletonManager::GetInstance)
    .stubs()
    .will(returnValue(reinterpret_cast<SingletonManager*>(0x1))); // 禁止

// 正确做法：直接Mock调用的实例方法
MOCKER_CPP(&DataService::ProcessData)
    .stubs()
    .will(invoke(DataProcessStub));
```

## 11. 调试经验

遇到 mockcpp 编译/运行问题时，**必须优先查询** [mockcpp-debug-experience.md](../../../fix-ut/references/cpp/mockcpp-debug-experience.md) 中的解决方案。常见问题摘要：

| # | 问题 | 根因 | 解决方案 |
|---|------|------|----------|
| 1 | `invalid use of non-static member function` | MOCKER_CPP未用&取地址 | `MOCKER_CPP(&Class::Func)` |
| 2 | 模板函数 `no matching function` | 未指定模板实例化类型 | `MOCKER_CPP(&Func<int>, int (*)(int, int))` |
| 3 | 类成员模板函数报错 | 未指定实例化类型 | 指定完整签名 |
| 4 | `Parameter mismatch` | stub函数首参数不是类指针 | 首参数改为 `ClassName* obj` |
| 5 | 虚函数段错误 | 虚函数误用MOCKER_CPP | 改用MOCKER_CPP_VIRTUAL |
| 6 | `Returned type does NOT match` | stub返回值类型不一致 | 与被Mock函数返回值类型一致 |
| 7 | 重载函数Mock不生效 | 未指定重载签名 | `MOCKER_CPP(&Func, ReturnType (Class::*)(...))` |
