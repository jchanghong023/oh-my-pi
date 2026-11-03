# mockcpp 调试经验

本文件汇总 mockcpp 使用过程中的常见编译报错和运行报错案例及解决方案。遇到 mockcpp 相关问题时**必须优先查询本文件**匹配场景，避免重复排查。

## 编译报错

### 错误1：MOCKER_CPP/MOCKER_CPP_VIRTUAL 报错 invalid use of non-static member function

**错误原因**：MOCKER_CPP/MOCKER_CPP_VIRTUAL在mock类的成员函数时，需要通过&对函数取地址

**解决方案**：修改调用MOCKER_CPP/MOCKER_CPP_VIRTUAL时的参数，给函数加上&符号

**代码示例**：
```cpp
class Calculator {
public:
    int Add(int a, int b);
    int Subtract(int a, int b);
    std::string GetResultAsString(int value);
};

MOCKER_CPP(Calculator::Add) // 错误用法：没有使用&取函数地址
    .stubs()
    .will(returnValue(100));

MOCKER_CPP(&Calculator::Add) // 正确用法：使用&取函数地址
    .stubs()
    .will(returnValue(100));
```

---

### 错误2：MOCK模板函数报错 no matching function for call ... unresolved overloaded function type

**错误原因**：MOCK模板函数时，没有使用<>指定模板的实例化类型，导致模板函数无法被正确解析

**解决方案**：在调用MOCKER/MOCKER_CPP/MOCKER_CPP_VIRTUAL时，通过<>指定要MOCK模板函数的实例化类型

**代码示例**：
```cpp
template<typename T>
T Max(T a, T b)
{
    return a > b ? a : b;
}

MOCKER_CPP(&Max) // 错误写法：没有指定实例化类型
.stubs()
.will(invoke(MaxStub<int>));

MOCKER_CPP(&Max<int>, int (*)(int, int)) // 正确写法：指定实例化类型
    .stubs()
    .will(invoke(MaxStub<int>));
```

---

### 错误3：MOCK类成员模板函数报错 used without template arguments

**错误原因**：MOCK类成员模板函数时，没有使用<>指定模板的实例化类型

**解决方案**：指定需要MOCK类成员模板函数的实例化类型

**代码示例**：
```cpp
template<typename T>
T TemplateCalculator<T>::Compare(T a, T b)
{
    return a > b ? a : b;
}

MOCKER_CPP(&TemplateCalculator::Compare) // 错误写法：没有指定实例化类型
    .stubs()
    .will(returnValue(999));

MOCKER_CPP(&TemplateCalculator<int>::Compare, int (TemplateCalculator<int>::*)(int, int)) // 正确写法：指定实例化类型
    .stubs()
    .will(returnValue(999));
```

---

## 运行报错

### 错误4：运行失败，日志存在 Parameter 1 mismatch, required: [xx] actual: [yy*]

**错误原因**：MOCKER_CPP/MOCKER_CPP_VIRTUAL在mock类的成员函数时，stub函数的第一个参数应该为类的指针

**解决方案**：修改stub函数的参数类型，增加类对象的指针作为第一个参数

**代码示例**：
```cpp
class Calculator {
public:
    int Add(int a, int b);
};

int AddStub(int a, int b) // 错误写法：第一个参数不是类对象的指针
{
    return a + b + 100;
}

int AddStub(Calculator* obj, int a, int b) // 正确写法：第一个参数是类对象的指针
{
    return a + b + 100;
}
```

---

### 错误5：运行时触发段错误崩溃

**错误原因**：对虚函数进行MOCK时，只能使用MOCKER_CPP_VIRTUAL函数进行MOCK，使用MOCKER_CPP会导致段错误

**解决方案**：将MOCKER_CPP更改为MOCKER_CPP_VIRTUAL

**代码示例**：
```cpp
class CalculatorBase {
public:
    virtual int Multiply(int a, int b) = 0;
    virtual int Divide(int a, int b) = 0;
    virtual ~CalculatorBase() {}
};

class CalculatorImpl : public CalculatorBase {
public:
    virtual int Multiply(int a, int b) override;
    virtual int Divide(int a, int b) override;
};

MOCKER_CPP(&CalculatorImpl::Multiply, int (CalculatorImpl::*)(int, int)) // 错误写法：使用MOCKER_CPP对虚函数MOCK
    .expects(once())
    .will(returnValue(999));

MOCKER_CPP_VIRTUAL(calc, &CalculatorImpl::Multiply, int (CalculatorImpl::*)(int, int)) // 正确写法：使用MOCKER_CPP_VIRTUAL
    .expects(once())
    .will(returnValue(999));
```

---

### 错误6：运行失败，日志存在 Returned type does NOT match the method declaration

**错误原因**：STUB函数的返回值和被MOCK函数的返回值类型不一致

**解决方案**：根据被MOCK函数的返回值类型更改STUB函数的返回值类型

**代码示例**：
```cpp
int CalculatorImpl::Multiply(int a, int b)
{
    return a * b;
}

MOCKER_CPP(&CalculatorImpl::Multiply)
    .stubs()
    .will(invoke(MultiplyStub));

bool MultiplyStub(CalculatorImpl* obj, int a, int b) // 错误写法：返回bool，被MOCK函数返回int
{
    return (a * b) + 1000;
}

int MultiplyStub(CalculatorImpl* obj, int a, int b) // 正确写法：返回int，与被MOCK函数一致
{
    return (a * b) + 1000;
}
```

---

## 运行不生效

### 错误7：重载函数MOCK不生效

**错误原因**：重载函数由于有多个函数签名，在MOCK时需要指定要MOCK的是哪个重载，不然MOCK框架不知道要MOCK哪一个，MOCK会失效

**解决方案**：在调用MOCKER/MOCKER_CPP/MOCKER_CPP_VIRTUAL时，指定需要MOCK的重载函数的签名

**代码示例**：
```cpp
class Calculator {
public:
    int Add(int a, int b);
    int Add(int a, int b, int c);
    double Add(double a, double b);
};

MOCKER_CPP(&Calculator::Add) // 错误用法：没有指定签名
    .stubs()
    .will(invoke(AddStub));

MOCKER_CPP(&Calculator::Add, int (Calculator::*)(int, int)) // 正确用法：指定签名
    .stubs()
    .will(invoke(AddStub));
```
