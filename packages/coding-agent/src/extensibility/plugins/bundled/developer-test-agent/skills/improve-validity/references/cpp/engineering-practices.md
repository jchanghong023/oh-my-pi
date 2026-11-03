# C/C++ 数据清理与工程规范

## 数据清理规范

### Mock清理

```cpp
TEST_F(Test, test_func) {
    EXPECT_CALL(mockObj, func(_)).WillOnce(Return(0));
    // 执行测试...
    ::testing::Mock::VerifyAndClearExpectations(&mockObj);
}
```

**严禁**在TearDown()中使用全局清理方法。

### Fixture状态跟踪

```cpp
class DeviceManagerTest : public ::testing::Test {
protected:
    std::set<int> added_device_ids;
    void TearDown() override {
        for (int id : added_device_ids) {
            remove_device(id);
        }
        added_device_ids.clear();
    }
    void add_tracked_device(int id) {
        add_device(id);
        added_device_ids.insert(id);
    }
};
```

### SetUp零重置（全局状态C模块）

对于使用全局状态的C模块，SetUp中必须先保存原始状态，然后显式零重置：

```cpp
void SetUp() override {
    saved_count = process_count;
    memcpy(saved_table, process_table, sizeof(process_table));
    process_count = 0;
    memset(process_table, 0, sizeof(process_table));
}
```

优先使用模块的重置函数（如 `init_pcb_table()`）而非手动save/restore。

### #include .c文件的重复符号警告

使用 `#include "source.c"` 直接包含源文件时，不要同时编译和链接该.c文件，否则会产生重复符号错误。

## 期望值批量计算规范

算法函数的期望值使用单次脚本执行批量计算，禁止多次迭代式单查询计算：

```bash
python3 -c "
SI = 1000 * 0.05 * 3
CI = 1000 * (1 + 0.05/4)**(4*3)
print(f'SI={SI}, CI={CI}')
"
```

对于复杂算法（CRC、调度逻辑等），优先使用外部脚本计算期望值，而非手动追踪执行路径。
