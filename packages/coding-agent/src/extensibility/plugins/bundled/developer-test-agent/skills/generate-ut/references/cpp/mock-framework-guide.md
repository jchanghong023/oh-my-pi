# Mock框架选择和使用指南

## 框架选择决策流程

按以下决策流程选择Mock框架：

1. **被测函数是否需要Mock外部依赖？**
   - 否 → 使用纯gtest，不引入任何Mock框架
   - 是 → 继续判断

2. **被测代码是C++还是C？**
   - C++ → 优先使用gmock（MOCK_METHOD/EXPECT_CALL）
   - C → 继续判断

3. **项目是否已有Mock框架配置？**
   - 已有binmock → 使用binmock
   - 已有AMock → 使用AMock
   - 已有mockcpp → 使用mockcpp（注意平台兼容性）
   - 无配置 → 优先使用gmock

4. **Windows/MinGW平台特殊处理**
   - mockcpp在Windows/MinGW下可能无法编译（sys/mman.h缺失）
   - 优先使用gmock/binmock替代mockcpp
   - 如果被测函数不需要Mock，使用纯gtest

**关键原则**：被测函数不需要Mock外部依赖时，不引入任何Mock框架。这避免了mockcpp等框架的平台兼容性问题和不必要的编译依赖。

## 框架对比

| 框架 | 适用场景 | Mock方式 | 平台兼容性 |
|------|---------|---------|-----------|
| gtest/gmock | C++虚函数、接口类 | MOCK_METHOD宏，EXPECT_CALL | 全平台 |
| binmock | C函数（扩展gmock） | BINEXPECT_CALL，BINMOCKER | 全平台 |
| AMock | 项目C/C++ | AMOCKER宏，expects/with/will | 全平台 |
| mockcpp | C函数（MOCKER宏） | MOCKER(func).stubs().will(returnValue(...)) | Linux优先，Windows/MinGW可能失败 |

## Mock分层原则

| Mock类型 | 放置位置 | 适用场景 |
|----------|----------|----------|
| **通用Mock** | SetUp() | 所有测试用例都需要的基础Mock，如全局变量初始化 |
| **场景Mock辅助函数** | Fixture类成员函数 | 多个测试用例共享的特定场景Mock |
| **特定Mock** | 测试用例内 | 仅当前用例需要的Mock |

## Mock精细化控制

- **优先使用WillOnce**：精确控制每次调用的返回值和次数
- **仅当次数不确定时使用WillRepeatedly**
- **验证调用次数**：使用.Times(N)或默认计数
- **验证调用参数**：在lambda中检查参数值
- **验证调用顺序**：使用InSequence
- **验证未调用**：使用.Times(0)

## gtest/gmock使用

### 虚函数Mock（直接Mock）

```cpp
class IService {
public:
    virtual int32_t ProcessData(const std::string& data) = 0;
};

class MockService : public IService {
public:
    MOCK_METHOD(int32_t, ProcessData, (const std::string& data), (override));
};
```

### 非虚函数Mock（包装层模式）

当被测代码依赖非虚函数时，创建Mock包装层：

```cpp
// 步骤1：创建虚函数接口类
class MockServiceInterface {
public:
    virtual ~MockServiceInterface() = default;
    virtual int32_t ProcessData(const std::string& data) = 0;
};

// 步骤2：创建Mock类
class MockService : public MockServiceInterface {
public:
    MOCK_METHOD(int32_t, ProcessData, (const std::string& data), (override));
};

// 步骤3：创建适配器
class ServiceAdapter : public OriginalService {
public:
    explicit ServiceAdapter(MockServiceInterface* mock) : mock_(mock) {}
    int32_t ProcessData(const std::string& data) override {
        return mock_->ProcessData(data);
    }
private:
    MockServiceInterface* mock_;
};
```

### EXPECT_CALL使用

```cpp
// 精确控制单次调用
EXPECT_CALL(mockService, ProcessData(_))
    .WillOnce(Return(0));

// 精确控制多次调用不同返回值
EXPECT_CALL(mockService, ProcessData(_))
    .WillOnce(Return(&buffer1))
    .WillOnce(Return(&buffer2))
    .WillOnce(Return(nullptr));

// 验证调用次数
EXPECT_CALL(mockService, ProcessData(_)).Times(1);

// 验证未调用
EXPECT_CALL(mockService, ProcessData(_)).Times(0);

// 验证调用顺序
InSequence s;
EXPECT_CALL(mockA, func(_)).WillOnce(Return(0));
EXPECT_CALL(mockB, func(_)).WillOnce(Return(-1));
```

## binmock使用

### 基础Mock

```cpp
BINEXPECT_CALL((&malloc), (_)).WillOnce(Return(nullptr));
```

### 序列化调用

```cpp
InSequence s;
auto &mocker = BINMOCKER(&ring_create);
EXPECT_CALL(mocker, stub(_, _, _, _)).Times(1).WillOnce(Return(&this->ring));
EXPECT_CALL(mocker, stub(_, _, _, _)).Times(1).WillOnce(Return(nullptr));
```

### Lambda修改返回参数

```cpp
BINEXPECT_CALL((&external_func), (_))
    .Times(1)
    .WillOnce([this](param_t *p) {
        p->value = 100;
        p->status = STATUS_OK;
        return 0;
    });
```

## AMock使用

### 基本结构

```cpp
AMOCKER(函数名)
.expects(调用次数)        // 可选
.with(参数匹配)           // 可选
.will(返回值控制)         // 可选
```

### 调用次数控制

- `expects(exactly(n))` - 精确调用n次
- `expects(atLeast(n))` - 至少调用n次
- `expects(atMost(n))` - 最多调用n次
- `expects(never())` - 不应该被调用

### 参数匹配

- `eq(value)` - 期望入参等于value
- `neq(value)` - 期望入参不等于value
- `any()` - 入参可以为任意值
- `outBoundP(&st, sizeof(st))` - 控制出参
- `follow(checkFunc)` - 使用自定义函数校验入参

### 返回值控制

- `returnValue(value)` - 控制返回值为value
- `returnObjectList(v1, v2, v3)` - 控制多次调用返回值
- `invoke(func)` - 用func替换原函数
- `ignoreReturnValue()` - 忽略返回值

### 注意事项

1. AMock关键字顺序不要颠倒：`AMOCKER -> expects/times -> with -> will -> before/after`
2. 至少使用一个关键字
3. 使用`LLT_GLOBALOBJMOCKER::verify()`验证调用次数
4. outBoundP、mirror、mask的指针参数必须为有效地址

## mockcpp使用

mockcpp 的完整使用指南（对象类型、核心关键字API参考、7种场景化用法、高级用法、决策流程图、最佳实践、快速参考、特殊场景、调试经验）详见 [mockcpp-guide.md](./mockcpp-guide.md)。

### 平台兼容性

- mockcpp依赖sys/mman.h，在Windows/MinGW下可能无法编译
- 如果mockcpp编译失败，不要修改mockcpp源码，记录限制并使用替代方案
- 替代方案：手动构造测试数据、使用gtest/gmock的binmock扩展、直接验证NULL处理逻辑

## malloc失败测试替代策略

**问题**：Windows/MinGW下禁止Mock malloc/free/printf，因为gtest内部也调用它们会导致无限递归。

**替代策略**（按优先级选择）：

### 策略1：Mock被测函数实际调用的分配函数

如果被测函数调用strdup而非直接malloc，Mock strdup：
```cpp
// 被测代码调用strdup
MOCKER(strdup).stubs().will(returnValue((char*)nullptr));
```

### 策略2：手动构造NULL状态验证后续行为

如果无法Mock分配函数，手动设置分配结果为NULL后验证：
```cpp
TEST_F(DeviceTest, test_init_when_device_null_then_handle_correctly) {
    init_devices();  // 正常调用
    // 手动设置某个device为NULL模拟malloc失败
    devices[0] = NULL;
    // 验证后续函数能正确处理NULL
    EXPECT_EQ(check_device_status(0), DEVICE_STATUS_INVALID);
}
```

### 策略3：包含.c文件直接访问static变量

对于使用static全局变量的C模块，直接包含.c文件以访问static变量：
```cpp
// 直接包含.c文件以访问static变量
#include "db_operations.c"  // 注意：不是.h

TEST_F(DbTest, test_add_when_null_entry_then_reject) {
    // 可以直接访问static变量重置状态
    memset(database, 0, sizeof(database));
    record_count = 0;
    // 测试
}
```

### 策略4：记录限制并跳过

如果以上策略均不可行，记录该限制，说明malloc失败路径无法在当前平台测试。

## 硬件I/O Mock策略

### 内存映射方式（推荐）

使用VirtualAlloc（Windows）或mmap（Linux）分配物理内存模拟硬件寄存器：

```cpp
class HardwareIOTest : public ::testing::Test {
protected:
    void* hw_base = nullptr;
    
    void SetUp() override {
#ifdef _WIN32
        hw_base = VirtualAlloc(nullptr, 4096, MEM_COMMIT, PAGE_READWRITE);
#else
        hw_base = mmap(nullptr, 4096, PROT_READ | PROT_WRITE,
                       MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
#endif
        memset(hw_base, 0, 4096);
    }
    
    void TearDown() override {
#ifdef _WIN32
        VirtualFree(hw_base, 0, MEM_RELEASE);
#else
        munmap(hw_base, 4096);
#endif
    }
};
```

### 为什么不用链接桩

链接时替换（ld --wrap或链接桩函数）会复制生产代码逻辑到测试中，维护成本高且容易与生产代码不同步。内存映射方式更可靠。

## mockcpp特殊场景与常见问题

mockcpp 的特殊场景（遍历函数Mock、单例Mock）和常见问题详见 [mockcpp-guide.md](./mockcpp-guide.md) 的第10章和第11章。

遇到 mockcpp 编译/运行问题时，**必须优先**查询 [mockcpp-debug-experience.md](../../../fix-ut/references/cpp/mockcpp-debug-experience.md) 中的解决方案，避免重复解决问题。
