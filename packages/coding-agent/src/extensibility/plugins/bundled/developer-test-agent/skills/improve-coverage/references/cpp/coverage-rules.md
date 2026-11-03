# C/C++ 覆盖率规则

> **⚠️ 强制门控（BLOCKING）**：本文件包含 3 个步骤，**Step 3（写入缓存 JSON）为强制步骤，即使覆盖率为 100% 也必须执行**。未写入 `.codecovcli/cache/cpp_{className}.json` 视为覆盖率分析未完成。请先完整阅读本文件再执行覆盖率命令。

## 覆盖率数据获取

### 前置检查

1. **检查测试文件**：确认测试文件包含TEST_F或TEST宏（无测试用例则无法进行覆盖率分析，输出提示并结束）

2. **检查gcda文件**：
   ```bash
   find . -name "*.gcda" | grep {TARGET_SOURCE_FILE}
   ```
   - **存在** → 继续执行，将搜索到的gcda路径记为 `TARGET_GCDA_PATH`
   - **不存在** → 说明编译时未添加覆盖率插桩标志，必须**回退重新编译**：
     1. 使用 `-fprofile-arcs -ftest-coverage` 重新编译被测源文件和测试文件，使用 `--coverage -lgcov` 重新链接（构建策略详见 `skill://generate-ut/references/cpp/compile-and-coverage.md`）
     2. 重新运行测试可执行文件，生成 `.gcda` 文件
     3. 重新执行本步骤检查 gcda 是否存在
     4. 仍不存在则说明环境配置问题，输出错误详情并结束
     5. **回退触发后跳过下方覆盖率命令的步骤1**（测试已在回退步骤2中执行并生成 gcda）

### 覆盖率命令

覆盖率产物统一输出到临时目录，避免污染项目目录。

> **重要**：gcov 需要能找到源文件才能生成完整的 `.gcov` 报告。在 Windows 上或测试头文件中的内联函数时，gcov 可能无法找到源文件，导致 `.gcov` 文件仅含元数据头（行号 0），解析出 0 行可执行代码。因此**必须捕获 gcov stdout**（包含覆盖率摘要 `Lines executed:X.XX% of N`），作为覆盖率数据的主要来源。

> **不再依赖 `--gtest_output=xml`**：测试执行结果直接从 gtest stdout 解析（`[==========] Running N tests` / `[  PASSED  ] N tests` / `[  FAILED  ] N tests`），无需生成 gtest XML 文件，避免 Windows 上 `$TEMP` 路径分隔符导致的 gtest 静默失败问题。

#### Windows (PowerShell)

```powershell
# 创建临时目录
$COV_DIR="$env:TEMP\ut-cpp"; New-Item -ItemType Directory -Force -Path $COV_DIR | Out-Null

# 步骤1：运行测试可执行文件，捕获 stdout（用于测试结果统计）
.\{TEST_EXECUTABLE} 2>&1 | Tee-Object -FilePath "$COV_DIR\gtest_stdout.txt"

# 步骤2：在临时目录执行gcov生成覆盖率报告，捕获 stdout
$GCOV_DIR="$COV_DIR\gcov_output"; New-Item -ItemType Directory -Force -Path $GCOV_DIR | Out-Null
cd $GCOV_DIR; gcov {TARGET_GCDA_PATH} > "$COV_DIR\gcov_stdout.txt" 2>&1
cd $PROJECT_ROOT

# 查看未覆盖代码
Select-String "#####:" "$GCOV_DIR\{sourceFile}.gcov"

# → 然后执行 Step 3（见下方"Step 3: 写入覆盖率缓存 JSON"章节）
```

#### Windows (bash / Git Bash / MSYS2)

```bash
# 创建临时目录
COV_DIR="$TEMP/ut-cpp"; mkdir -p "$COV_DIR/gcov_output"

# 步骤1：运行测试可执行文件，捕获 stdout（用于测试结果统计）
./{TEST_EXECUTABLE} 2>&1 | tee "$COV_DIR/gtest_stdout.txt"

# 步骤2：在临时目录执行gcov生成覆盖率报告，捕获 stdout
PROJECT_ROOT="$(pwd)"
cd "$COV_DIR/gcov_output" && gcov {TARGET_GCDA_PATH} > "$COV_DIR/gcov_stdout.txt" 2>&1
cd "$PROJECT_ROOT"

# 查看未覆盖代码
grep "#####:" "$COV_DIR/gcov_output/{sourceFile}.gcov"

# → 然后执行 Step 3（见下方"Step 3: 写入覆盖率缓存 JSON"章节）
```

#### Unix (bash)

```bash
# 创建临时目录
COV_DIR="/tmp/ut-cpp"; mkdir -p "$COV_DIR/gcov_output"

# 步骤1：运行测试可执行文件，捕获 stdout（用于测试结果统计）
./{TEST_EXECUTABLE} 2>&1 | tee "$COV_DIR/gtest_stdout.txt"

# 步骤2：在临时目录执行gcov生成覆盖率报告，捕获 stdout
PROJECT_ROOT="$(pwd)"
cd "$COV_DIR/gcov_output" && gcov {TARGET_GCDA_PATH} > "$COV_DIR/gcov_stdout.txt" 2>&1
cd "$PROJECT_ROOT"

# 查看未覆盖代码
grep "#####:" "$COV_DIR/gcov_output/{sourceFile}.gcov"

# → 然后执行 Step 3（见下方"Step 3: 写入覆盖率缓存 JSON"章节）
```

> **gcov stdout 回退**：当 gcov 无法找到源文件时，`.gcov` 文件仅含元数据头（Source/Graph/Data 等行号 0 的行）。此时从 gcov stdout 摘要行（`Lines executed:X.XX% of N`）提取覆盖率汇总数据，该方法在 Windows 上是主要数据源。

> **gcov 源文件查找技巧**：如果 gcov 报告 `cannot open source file`，可尝试：
> - 在源文件所在目录执行 gcov（`cd {源文件目录} && gcov -o {GCDA路径} {GCDA文件名}`）
> - 使用 gcov `-s` 选项指定源文件搜索路径（`gcov -s {源文件目录} {TARGET_GCDA_PATH}`）

### gcov标记含义

| 标记 | 含义 | 是否关注 |
|------|------|----------|
| `数字:` | 已执行 | 否 |
| `#####:` | 未执行 | **是** |
| `-:` | 不可执行 | 否 |
| `=====` | 特殊标记 | 否 |

## Step 3: 写入覆盖率缓存 JSON（强制执行）

> **⚠️ 本步骤为强制步骤，即使覆盖率为 100%（无未覆盖行）也必须执行。** 缓存 JSON 是外部 DTAgent-Plugin 通过 OTel 上报的数据源，不写入则该插件无法上报本次覆盖率数据。

覆盖率数据需写入 `.codecovcli/cache/cpp_{className}.json`，供外部 DTAgent-Plugin 在子代理执行结束后扫描并通过 OTel 上报；OMP 内置运行时不提供此自动上报。

> **写入前清除历史缓存**：写入前先删除 `.codecovcli/cache/` 目录下的所有历史缓存文件（避免脏数据），再写入新文件。

#### JSON 直接生成（推荐方式）

AI agent 在执行完步骤1（运行测试）和步骤2（gcov）后，已持有 gtest stdout 和 gcov stdout 的全部数据，**直接组装 JSON 并使用 `write` 工具写入**。

#### JSON 格式与字段计算规则

```json
{
  "className": "{被测源文件名，不含扩展名}",
  "testName": "{第一个测试用例名}",
  "scenario": "class-level",
  "timestamp": "{ISO 8601 时间戳}",
  "metrics": {
    "compiled_testcase_num": 10,
    "passed_testcase_num": 10,
    "covered_line_num": 14,
    "total_compile_error_num": 0,
    "total_line_num": 14,
    "accept_testcase_num": 10,
    "generate_testcase_num": 10,
    "total_testcase_num": 10,
    "accept_line_num": 70,
    "generate_line_num": 70
  },
  "metadata": {
    "language": "cpp",
    "projectDir": "{项目根目录绝对路径}",
    "version": "1.0.0"
  }
}
```

**字段计算规则**：

| 字段 | 数据来源 | 计算方法 |
|------|----------|----------|
| `className` | 输入参数 | 被测源文件名（不含扩展名，如 `Ascii`） |
| `testName` | gtest stdout | 第一个 `[ RUN      ]` 行中的测试用例名（如 `TestAscii.ToLower_ReturnsLowercaseWhenUppercase`）；无测试时为空字符串 |
| `scenario` | 固定值 | `"class-level"`（DTAgent-Plugin 仅上报 class-level 场景，其他值会被跳过） |
| `timestamp` | 实时生成 | 当前时间的 ISO 8601 格式（如 `2026-09-10T12:15:55.934Z`） |
| `metrics.compiled_testcase_num` | 计算 | `total_testcase_num - total_compile_error_num`（编译错误数通常为 0） |
| `metrics.passed_testcase_num` | gtest stdout | `[  PASSED  ] N tests.` 中的 **N**；无此行时为 0 |
| `metrics.covered_line_num` | gcov stdout 计算 | `Math.round(N * X.XX / 100)`，N 和 X.XX 来自 `Lines executed:X.XX% of N` |
| `metrics.total_compile_error_num` | gtest stdout | 编译错误数，通常为 0（gtest stdout 无编译错误行时填 0） |
| `metrics.total_line_num` | gcov stdout | 匹配 className 的 `File '{filename}'` 段落中 `Lines executed:X.XX% of N` 的 **N** |
| `metrics.accept_testcase_num` | = passed_testcase_num | |
| `metrics.generate_testcase_num` | gtest stdout | `[==========] Running N tests` 中的 **N** |
| `metrics.total_testcase_num` | = generate_testcase_num | |
| `metrics.accept_line_num` | 测试文件 | 测试文件代码行数（排除空行、注释、预处理指令后的行数） |
| `metrics.generate_line_num` | = accept_line_num | |
| `metadata.projectDir` | 当前工作目录 | 项目根目录绝对路径 |

**gcov stdout 匹配规则**：

gcov stdout 包含多个文件的覆盖率摘要，需匹配被测源文件：
```
File 'Foundation/include/Poco/Ascii.h'
Lines executed:100.00% of 14
```
- 优先匹配源文件（`.cpp`/`.cc`/`.c`），其次匹配头文件（`.h`/`.hpp`）
- 文件名（不含扩展名）等于 className 时匹配成功

**gtest stdout 解析示例**：

```
[==========] Running 10 tests from 1 test suite.
...
[  PASSED  ] 10 tests.
```
→ `totalTests=10, passedTests=10, failedTests=0, skippedTests=0`

若有失败：
```
[==========] Running 10 tests from 1 test suite.
...
[  FAILED  ] 2 tests, listed below:
```
→ `totalTests=10, passedTests=8, failedTests=2, skippedTests=0`

**测试文件代码行数统计规则**：

使用 `read` 工具读取测试文件后，手动统计代码行数。排除以下行：
- 空行
- 单行注释（`//` 开头）
- 多行注释块（`/* ... */` 之间的行，含 `/*` 行和 `*/` 行）
- 预处理指令（`#include`、`#define`、`#ifndef` 等 `#` 开头的行）
- 预处理续行（以 `\` 结尾的预处理指令的后续行）

### 覆盖率目标

行覆盖率 **≥80% 为强制门禁**（DTAgent 全局标准），C++ 推荐目标 **≥90%**。不达标必须回溯补充用例。

### 环境清理

覆盖率分析完成后，删除临时目录：

```bash
# Unix (bash)
rm -rf /tmp/ut-cpp
```

```powershell
# Windows (PowerShell)
Remove-Item "$env:TEMP\ut-cpp" -Recurse -Force -ErrorAction SilentlyContinue
```

## 导航索引

- [未覆盖场景测试策略与异常覆盖检测](./coverage-strategies.md) — 未覆盖场景测试策略11种、不可达代码处理、异常覆盖检测（C++异常3维度+C错误处理3维度+catch块逻辑5类）、覆盖率问题路由4类、覆盖率提升策略报告模板
