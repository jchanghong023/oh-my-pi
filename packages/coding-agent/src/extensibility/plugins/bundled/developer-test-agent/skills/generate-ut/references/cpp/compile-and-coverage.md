# 编译与覆盖率分析

## 构建策略选择（按优先级）

全链路流水线中 `improve-coverage` 为强制门禁阶段，覆盖率插桩从一开始就是必需的。因此**所有构建策略的编译命令默认包含** `-fprofile-arcs -ftest-coverage`，链接命令默认包含 `--coverage -lgcov`。

**关键约束：禁止CMake全量构建**。`cmake --build` 必须带 `--target` 参数指定特定目标，禁止不带 target 执行全量构建。

### 平台变量

以下命令为跨平台通用形式。Windows/MinGW 环境需追加平台标志：

| 平台 | 可执行文件后缀 | 额外链接标志 | 说明 |
|------|---------------|-------------|------|
| Linux | 无后缀 | 无 | 原生 gcc/g++ |
| Windows/MinGW | `.exe` | `-static` | 避免DLL依赖问题 |

> 以下示例以 Linux 为基准。Windows/MinGW 环境下，链接命令追加 `-static`，输出文件名追加 `.exe`。

### 策略D：用户自定义编译命令（最高优先级）

如果用户在 prompt 中提供了编译命令或脚本，**必须优先使用**用户提供的命令。如果用户提供的命令未包含覆盖率标志，必须主动补充 `-fprofile-arcs -ftest-coverage`（编译）和 `--coverage -lgcov`（链接），因为全链路流水线后续需要覆盖率数据。

### 策略A：CMake构建特定目标

```bash
# 配置CMake（追加覆盖率标志，不覆盖项目原有标志）
cmake -DCMAKE_C_FLAGS="-fprofile-arcs -ftest-coverage" \
      -DCMAKE_CXX_FLAGS="-fprofile-arcs -ftest-coverage" \
      -DCMAKE_EXE_LINKER_FLAGS="--coverage -lgcov" \
      -B build .
# 注意：如项目CMakeLists.txt已有CMAKE_C_FLAGS/CMAKE_CXX_FLAGS设置，
# 上述方式会覆盖而非追加。需改用CMAKE_C_FLAGS_INIT或在CMakeLists.txt中
# 通过add_compile_options追加。若CMake配置失败，回退到策略B。

# 先构建依赖库（指定target，禁止全量构建）
cmake --build build --target gtest gtest_main gmock gmock_main

# 编译被测源文件和测试文件（覆盖率标志为默认）
gcc -std=c11 -fprofile-arcs -ftest-coverage -c -I src \
    src/source_file.c -o build/source_file.o

g++ -std=c++20 -fprofile-arcs -ftest-coverage -c -I src -I libs/googletest/googletest/include \
    tests/test_file.cpp -o build/test_file.o

# 链接
g++ -std=c++20 \
    build/test_file.o build/source_file.o build/lib/libgtest.a build/lib/libgtest_main.a \
    --coverage -lgcov -o build/test_runner
# Windows/MinGW: 追加 -static，输出改为 build/test_runner.exe
```

适用场景：项目有CMakeLists.txt且CMake可用。何时回退到策略B：CMake全量构建因无关源文件错误失败、CMake构建超时、第三方库编译失败、CMake特定目标构建2次尝试均失败。

### 策略B：目标编译

```bash
# 仅编译测试文件和被测源文件（覆盖率标志为默认）
# 注意：.c文件使用gcc，.cpp文件使用g++
gcc -std=c11 -fprofile-arcs -ftest-coverage -c -I src \
    src/source_file.c -o build/source_file.o

g++ -std=c++20 -fprofile-arcs -ftest-coverage -c -I src -I libs/googletest/googletest/include \
    tests/test_file.cpp -o build/test_file.o

# 使用策略A构建的依赖库链接
g++ -std=c++20 \
    build/test_file.o build/source_file.o \
    build/lib/libgtest.a build/lib/libgtest_main.a \
    --coverage -lgcov -o build/test_runner
# Windows/MinGW: 追加 -static，输出改为 build/test_runner.exe
```

适用场景：策略A因无关文件错误失败，但依赖库已通过策略A构建。

### 策略C：完整手动编译

```bash
# 手动编译所有依赖（含覆盖率标志）
g++ -std=c++20 -fprofile-arcs -ftest-coverage -c -I libs/googletest/googletest/include \
    libs/googletest/googletest/src/gtest-all.cc -o build/gtest_all.o

# 编译测试文件和源文件
g++ -std=c++20 -fprofile-arcs -ftest-coverage -c -I src -I libs/googletest/googletest/include \
    tests/test_file.cpp -o build/test_file.o

gcc -std=c11 -fprofile-arcs -ftest-coverage -c -I src \
    src/source_file.c -o build/source_file.o

# 链接
g++ -std=c++20 \
    build/test_file.o build/source_file.o build/gtest_all.o \
    --coverage -lgcov -o build/test_runner
# Windows/MinGW: 追加 -static，输出改为 build/test_runner.exe
```

适用场景：策略A/B均不可用。

## 编译器选择

| 源文件扩展名 | 编译器 | 原因 |
|-------------|--------|------|
| `.c` | `gcc` | 保持C符号名，避免C++ name mangling |
| `.cpp` / `.cc` / `.cxx` | `g++` | C++编译 |

**注意**：链接阶段统一使用g++，因为gtest/gmock是C++库。

## 覆盖率标志（强制默认）

全链路流水线中 `improve-coverage` 为强制门禁阶段，覆盖率插桩是必需的，覆盖率标志不是可选的。

- **编译阶段**：`-fprofile-arcs -ftest-coverage`（生成 `.gcno` + 插桩可执行文件）
- **链接阶段**：`--coverage -lgcov`（运行时生成 `.gcda`）
- **标志一致性**：编译和链接的覆盖率标志必须一致，否则出现 `undefined reference to __gcov_init`

**覆盖率目标**：行覆盖率 ≥ 90%。不达标必须回溯补充用例。

## Windows/MinGW平台适配

- 链接命令追加 `-static` 标志（避免 DLL 依赖问题）
- 可执行文件名追加 `.exe` 后缀
- exit code 127 或 0xC0000135 → 使用 `ldd` 检查DLL依赖，优先 `-static` 重编译
- 包含 `<windows.h>` 时如有ERROR枚举值，在include后添加 `#undef ERROR`
- MinGW bash 中运行可执行文件使用正斜杠路径（`./build/test_runner.exe`）

## 构建完成判定

一旦策略B/C成功且测试通过，不再重试CMake全量构建。常见错误模式：策略A失败→策略B成功→尝试回到策略A全量构建→又失败（浪费时间）。
