# C模块特殊模式与测试数据构造

## C模块特殊模式

### 静态状态隔离

1. **直接包含.c文件（推荐）**：`#include "source.c"` 访问static变量。注意：不要同时编译和链接该.c文件
2. **保存恢复全局状态**：当无法包含.c文件时，在SetUp/TearDown中保存恢复
3. **extern声明**：访问非static全局变量

### SetUp零重置模式

对于使用全局状态的C模块，SetUp中必须先保存原始状态，然后显式零重置：

```cpp
void SetUp() override {
    saved_count = process_count;
    process_count = 0;
    memset(process_table, 0, sizeof(process_table));
}
```

优先使用模块的重置函数（如 `init_pcb_table()`）。

## 测试数据构造

### 结构体逐字段赋值

```cpp
param_t param = {};  // 零初始化
param.type = TYPE_NORMAL;
param.value = 100;
```

### 指针初始化规范

- 使用 `nullptr` 而非 `NULL`
- 输出指针参数必须初始化：`result_t result = {};`

### 计算辅助函数（替代硬编码二进制数据）

对于协议解析、CRC校验等场景，优先使用计算辅助函数：

```cpp
uint16_t calculateExpectedCRC(const uint8_t* data, size_t len) {
    uint16_t crc = 0xFFFF;
    // CRC计算逻辑
    return crc;
}
```

### GIVEN阶段约束（增删改查接口）

优先使用增接口构造测试数据再查询验证，而非Mock内部数据结构。
