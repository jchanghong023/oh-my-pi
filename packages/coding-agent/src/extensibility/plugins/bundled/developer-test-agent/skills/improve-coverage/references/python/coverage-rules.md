# Python 覆盖率规则

## 覆盖率数据获取

### 方法1：coverage.py（首选）

覆盖率产物统一输出到临时目录，避免污染项目目录。

`{SKILL_DIR}` 替换为加载 `improve-coverage` 时返回的 baseDir；脚本路径加引号。
`$PYTHON` 为项目解释器：Windows 优先 `.venv/Scripts/python.exe`，Linux/macOS 优先 `.venv/bin/python`。Bash 用 `"$PYTHON"`，PowerShell 用 `& $PYTHON`。

```powershell
# Windows (PowerShell) - 创建临时目录
$COV_DIR = (New-Item -ItemType Directory -Path (Join-Path $env:TEMP ([guid]::NewGuid().ToString())) -ErrorAction Stop).FullName

# 步骤1：运行覆盖率并保存同次 pytest -v 输出
& $PYTHON -m coverage run --rcfile=NUL "--data-file=$COV_DIR\.coverage" --branch -m pytest "<test_file>" -v *> "$COV_DIR\pytest-output.txt"

# 步骤2：生成 JSON 报告到临时目录
& $PYTHON -m coverage json --rcfile=NUL "--data-file=$COV_DIR\.coverage" -o "$COV_DIR\coverage.json"

# 步骤3：生成覆盖率上报缓存 JSON（写入 .codecovcli/cache/python_{className}.json）
# {className} 为被测 Python 源文件名（不含 .py 扩展名，如 user_service）
node "{SKILL_DIR}/scripts/python/extract-python-coverage.js" {className} "$COV_DIR\coverage.json" "$COV_DIR\pytest-output.txt"
```

```bash
# Unix (bash) - 创建临时目录
COV_DIR=$(mktemp -d) || exit 1

# 步骤1：运行覆盖率并保存同次 pytest -v 输出
"$PYTHON" -m coverage run --rcfile=/dev/null --data-file="$COV_DIR/.coverage" --branch -m pytest "<test_file>" -v > "$COV_DIR/pytest-output.txt" 2>&1

# 步骤2：生成 JSON 报告到临时目录
"$PYTHON" -m coverage json --rcfile=/dev/null --data-file="$COV_DIR/.coverage" -o "$COV_DIR/coverage.json"

# 步骤3：生成覆盖率上报缓存 JSON（写入 .codecovcli/cache/python_{className}.json）
# {className} 为被测 Python 源文件名（不含 .py 扩展名，如 user_service）
node "{SKILL_DIR}/scripts/python/extract-python-coverage.js" {className} "$COV_DIR/coverage.json" "$COV_DIR/pytest-output.txt"
```

### 方法2：pytest-cov（回退）

沿用上述临时目录。PowerShell 中仅对此次调用设置 `COVERAGE_FILE` 为 `$COV_DIR/.coverage`，并沿用上方的日志重定向方式。

```bash
COVERAGE_FILE="$COV_DIR/.coverage" "$PYTHON" -m pytest "<test_file>" "--cov=<source_module>" --cov-report=term-missing "--cov-report=json:$COV_DIR/coverage.json" -v > "$COV_DIR/pytest-output.txt" 2>&1
```

如coverage包缺失，尝试 `pip install coverage`。

### 覆盖率上报集成（强制）

> **此步骤为强制要求，不可跳过。** 覆盖率数据必须写入 `.codecovcli/cache/python_{className}.json`，供外部 DTAgent-Plugin 在子代理执行结束后扫描并通过 OTel 上报；OMP 内置运行时不提供此自动上报。在 improve-coverage 的 Step 1（首次获取覆盖率）和 Step 4（校验覆盖率提升结果）中**均需执行**。

#### 转换脚本

通过 `extract-python-coverage.js` 脚本完成从 coverage.py 原生 JSON 报告到上报 JSON 的转换：

```bash
node "{SKILL_DIR}/scripts/python/extract-python-coverage.js" <模块名或源文件路径> <coverage.json路径> [pytest-v输出路径]
```

**参数说明**：

| 参数 | 必填 | 说明 |
|------|------|------|
| 模块名或源文件路径 | 是 | 不含 `.py` 扩展名的模块名（如 `user_service`），或源文件的项目相对路径（如 `src/user_service.py`）或绝对路径 |
| coverage.json路径 | 是 | `coverage json` 生成的 JSON 覆盖率报告文件路径 |
| pytest-v输出路径 | 否 | `pytest -v` 输出文件路径；不指定时测试结果相关字段填 `0` |

根目录下的模块可直接用模块名匹配；若覆盖率报告包含同名文件，脚本不会任选其一。请传入源文件路径来消歧；根目录文件可写为 `./user_service.py`。

**示例**：

```bash
# 仅覆盖率数据（测试结果字段填0）
node "{SKILL_DIR}/scripts/python/extract-python-coverage.js" user_service "$COV_DIR/coverage.json"

# 覆盖率数据 + 测试执行结果
node "{SKILL_DIR}/scripts/python/extract-python-coverage.js" user_service "$COV_DIR/coverage.json" "$COV_DIR/pytest-output.txt"
```

#### 输出文件

- **路径**：`<项目根目录>/.codecovcli/cache/python_{className}.json`
- **写入前清除历史缓存**：脚本在写入前会删除 `.codecovcli/cache/` 目录下的所有历史缓存文件，避免脏数据
- **异常兜底**：当 coverage.json 文件不存在（如 `coverage run` 失败未生成覆盖率文件）、目标文件未在 coverage.json 中找到（className 不匹配）、或覆盖率数据校验失败时，脚本**仍会写入 JSON 文件**（含 `errorDetail` 字段和 0 覆盖率数据），供外部 DTAgent-Plugin 上报测试执行结果（含编译失败场景）。若提供了 `pytest -v` 输出路径，测试结果会正常解析并写入 `metrics` 字段。

#### JSON 格式

生成的 JSON 符合覆盖率上报规范（详见 `coverage-reporting-integration-guide.md`）：

- `scenario`：固定 `"class-level"`（DTAgent-Plugin 仅上报 class-level 场景，其他值会被跳过）
- `metrics`：10 个字段，供外部 DTAgent-Plugin 透传到 OTel attributes
  - `compiled_testcase_num`：`pytest -v` 日志中有 `PASSED`、`FAILED` 或 `ERROR` 结果的用例数，按用例 ID 去重；收集错误不计入
  - `passed_testcase_num`：运行通过的用例数；fixture 初始化或清理报错的用例不计入
  - `covered_line_num`：已覆盖行数
  - `total_compile_error_num`：编译错误总数（pytest 收集错误等价物）
  - `total_line_num`：可执行总行数
  - `accept_testcase_num`：验收通过的测试用例数
  - `generate_testcase_num`：生成的测试用例数
  - `total_testcase_num`：测试用例总数
  - `accept_line_num`、`generate_line_num`：日志只指向一个可读取的测试文件时，填该文件代码行数，否则为 `0`
- `metadata.language`：固定 `"python"`

#### 完整流程

覆盖率数据获取与上报的完整流程：

1. **运行 `coverage run -m pytest ... -v` 或 `pytest --cov ... -v`**：生成覆盖率数据；需要上报测试结果时，保存同次 `pytest -v` 日志。
2. **运行 `coverage json`**：生成 `coverage.json`；`pytest --cov` 已直接生成 JSON 时跳过。
3. **执行 `extract-python-coverage.js`（强制）**：写入 `.codecovcli/cache/python_{className}.json`。

> improve-coverage 的 Step 1 和 Step 4 均须执行转换脚本。不提供 pytest 日志时，测试结果相关字段填 `0`。

### 函数级覆盖率解析

使用 `read` 加载 `skill://bundled-developer-test-agent/generate-ut`，将其返回的 baseDir 作为 `{GENERATE_SKILL_DIR}`，调用：
```bash
"$PYTHON" "{GENERATE_SKILL_DIR}/scripts/python/parse_coverage.py" "$COV_DIR/coverage.json" "<function_name>" "<start_line>" "<end_line>" "<source_file_path>"
```

始终提供 `source_file_path` 防止跨文件污染，并在生成覆盖率报告的项目目录中运行解析脚本。找不到唯一的文件记录或函数范围内没有可执行行时，不视为覆盖率达标。

### 环境清理

覆盖率测量完成后，仅删除本次创建的临时目录；不得修改或删除项目原有的 `.coverage`。

```powershell
# Windows (PowerShell)
Remove-Item -LiteralPath "$COV_DIR" -Recurse -Force
```

```bash
# Unix (bash)
rm -rf -- "$COV_DIR"
```

### 覆盖率目标

行覆盖率 ≥ 90%。

## 未覆盖代码分析

1. 读取parse_coverage.py输出的未覆盖行号
2. 将每行映射到其分支条件
3. 为每个未覆盖分支创建恰好1个针对性测试
4. 尝试替代方案：直接函数调用+patch → PropertyMock → 集成方式 → mock.patch阻塞原语

## 语句分类

- **NULL_CHECK**：空值检查分支（`if x is None`）
- **EXCEPTION_HANDLING**：异常抛出或捕获路径
- **BOUNDARY_CONDITION**：边界条件判断
- **LOOP_CONDITION**：循环边界条件（未进入循环/提前退出）
- **BUSINESS_LOGIC**：业务逻辑分支
- **GUARD_CLAUSE**：提前返回的guard clause
- **COMPOUND_CONDITION**：复合条件（`and`/`or`）的子条件
- **TYPE_DISPATCH**：isinstance链的类型分支
- **DECORATOR_BRANCH**：装饰器可选参数的分支

## 异常覆盖检测

对try/except块执行覆盖检测：
- 验证except块是re-raise还是suppress
- re-raise：用pytest.raises验证
- suppress：验证函数正常返回和副作用
- 多except类型：每种异常类型独立测试

## 不可达代码归因

- 互斥路径：`if x > 0: return` 后的 `if x <= 0:`
- 防御性代码：穷尽switch后的default
- 框架管理代码：无法在单元测试中触发的路径

将不可达代码从覆盖率分母中排除，记录原因。

## 覆盖率提升策略

| 未覆盖类型 | 推荐策略 |
|-----------|---------|
| 缺少分支测试 | 创建针对性测试 |
| Mock拦截 | 用真实对象或调整mock范围 |
| 死代码 | 文档记录为死代码 |
| 框架管理代码 | 尝试集成方式 |
| 阻塞原语未mock | mock Event.wait/Queue.get |
| while-loop未终止 | 用side_effect列表确保终止 |
