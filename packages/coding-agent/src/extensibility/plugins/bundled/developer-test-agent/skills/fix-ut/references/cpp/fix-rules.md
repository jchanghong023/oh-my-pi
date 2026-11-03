# C/C++ 测试修复规则

## 错误信息获取

### 构建策略（按优先级）

> **覆盖率标志（强制默认）**：全链路流水线中 `improve-coverage` 为强制门禁阶段，所有构建策略的编译命令**必须默认包含** `-fprofile-arcs -ftest-coverage`，链接命令**必须默认包含** `--coverage -lgcov`。详细构建策略命令示例见 `skill://generate-ut/references/cpp/compile-and-coverage.md`。

- **策略D**（最高）：用户提供的编译命令（未包含覆盖率标志时必须主动补充）
- **策略A**：CMake构建特定目标（`cmake --build build --target gtest gtest_main gmock gmock_main`），配置时通过 `-DCMAKE_C_FLAGS`/`-DCMAKE_CXX_FLAGS`/`-DCMAKE_EXE_LINKER_FLAGS` 传入覆盖率标志
- **策略B**：目标编译（gcc编译.c，g++编译.cpp），编译命令加 `-fprofile-arcs -ftest-coverage`，使用策略A构建的依赖库
- **策略C**：完整手动编译，编译命令加 `-fprofile-arcs -ftest-coverage`

### 编译器选择

- `.c` 文件使用 gcc 编译
- `.cpp` 文件使用 g++ 编译
- g++编译.c会导致C符号name mangling，链接时undefined reference

## 错误分类与修复策略

### 编译错误

| 错误类型 | 症状 | 修复策略 |
|----------|------|----------|
| 头文件缺失 | `fatal error: xxx.h: No such file` | 添加正确的 `-I` include路径 |
| 语法错误 | `error: expected ';'` 等 | 修复语法，检查分号、括号、类型 |
| 类型不匹配 | `error: cannot convert` | 检查参数类型、返回类型、Mock签名 |
| 未声明标识符 | `error: 'xxx' was not declared` | 添加正确的include或extern声明 |
| extern "C"缺失 | `undefined reference to C function` | C头文件用 `extern "C" {}` 包裹 |
| #define private public问题 | segfault或未定义行为 | 立即移除#define，改用公共接口测试 |
| 重复定义 | `multiple definition of` | #include .c文件时不要同时编译链接该.c文件 |
| ERROR枚举冲突 | Windows下 `<windows.h>` 的ERROR宏冲突 | include后添加 `#undef ERROR` |

### 链接错误

| 错误类型 | 症状 | 修复策略 |
|----------|------|----------|
| undefined reference | `undefined reference to 'function'` | 检查链接顺序，添加 `-l` / `-L` |
| g++误编译.c | `undefined reference to C function` | .c文件改用gcc编译 |
| 覆盖率标志不一致 | `undefined reference to __gcov_init` | 编译和链接标志必须一致：编译 `-fprofile-arcs -ftest-coverage`，链接 `--coverage -lgcov` |
| mockcpp链接失败 | mockcpp相关undefined reference | 检查mockcpp库路径和链接顺序 |

### 运行时错误

| 错误类型 | 症状 | 修复策略 |
|----------|------|----------|
| 段错误 | `Segmentation fault` | 检查空指针解引用、非法地址访问 |
| exit code 127 | `exit code 127` / `0xC0000135` | Windows DLL依赖问题，使用 `ldd` 检查，优先 `-static` 重编译 |
| Mock类型不匹配 | gmock类型错误 | 检查MOCK_METHOD签名与实际方法一致 |
| 断言失败 | `Failure in TEST_F` | 检查测试数据、Mock返回值、断言期望值 |
| 无限递归 | Mock了libc核心函数 | 禁止Mock malloc/free/printf，使用替代策略 |
| 测试数据错误 | 断言值不符 | 检查结构体字段赋值、边界值计算 |

### mockcpp特定错误

| 错误类型 | 症状 | 修复策略 |
|----------|------|----------|
| 平台兼容性 | 缺少sys/mman.h等 | 不修改mockcpp源码，记录限制，使用其他Mock方案 |
| MOCKER选择错误 | Mock不生效或崩溃 | 按MOCKER/MOCKER_CPP/MOCKER_CPP_VIRTUAL/MOCK_METHOD选择决策流程选择 |
| 遍历函数Mock | 测试死循环或失败 | 禁止Mock遍历函数，Mock数据提供函数并在输出参数中填充测试数据 |
| 单例Mock错误 | Mock不生效 | 禁止Mock GetInstance等，直接Mock实例方法 |

## 编译失败修复循环（最多10轮）

1. **优先查询mockcpp调试经验**：参考 [mockcpp-debug-experience.md](./mockcpp-debug-experience.md) 中的完整调试案例（MOCKER_CPP需&取地址、模板函数需指定类型、stub首参数为类指针、虚函数只能用MOCKER_CPP_VIRTUAL、返回值类型一致、重载函数需指定签名），匹配当前编译错误对应的场景和解决方案
2. **错误分类与修复策略**：
    - 语法错误/头文件缺失 → 修复include、添加-I路径
    - 链接错误 → 检查链接顺序、添加-l/-L；g++误编译.c则改用gcc
    - mockcpp问题 → 查经验库匹配场景
    - 覆盖率标志不一致 → 确保编译和链接标志一致
3. **修复约束**：仅修复测试代码，不修改生产代码、CMakeLists.txt、第三方库
4. **重新编译**：成功 → 执行测试；失败 → 继续下一轮

**禁止提前退出**：每轮修复必须完整执行（查询经验库→分析→修复→编译），不得直接跳过。

## 执行失败修复循环（最多10轮）

1. **优先查询经验库**：匹配当前执行错误对应的场景和解决方案
2. **分析执行失败原因**：空指针断言、Mock类型不匹配、测试数据错误、逻辑错误等
3. **修复测试代码**：调整测试数据、修改Mock配置、修正断言等，不修改生产代码
4. **重新编译并执行**：成功 → 测试通过；失败 → 继续下一轮

## 达到次数限制后

使用DISABLED_CASE宏禁用无法修复的用例：

```cpp
#ifdef DISABLED_CASE
TEST_F(FixtureName, CaseName) {
    // 此用例因编译/执行问题被禁用
    // 问题原因说明
    用例代码
}
#endif
```

**禁止**：删除用例代码、使用注释方式禁用、修改或删除宏定义禁用代码。必须注明禁用原因。

## Windows/MinGW特殊处理

- 始终使用 `-static` 标志
- exit code 127或0xC0000135 → 使用ldd检查DLL依赖，优先-static重编译
- 同一运行时错误最多尝试3次，超过则改用-static重建
- 包含 `<windows.h>` 时如有ERROR枚举值，在include后添加 `#undef ERROR`

## 构建完成判定

一旦策略B/C成功且测试通过，不再重试CMake全量构建。常见错误模式：策略A失败→策略B成功→尝试回到策略A全量构建→又失败（浪费时间）。
