# Python 单元测试生成规则

本文件汇总 Python 单元测试生成的语言专属规则。

## Python 版本与框架选择

- **兼容范围**：Python 3.6+。以项目声明或用户指定的最低支持版本编写测试；项目须支持 3.6 时，测试及辅助代码也须兼容 3.6，且只用实际 3.6 上的运行结果声明 3.6 验证通过。
- **解释器与 runner**：优先使用用户明确提供的命令、工作目录和解释器，其次沿用项目已有测试入口、解释器及框架。未指定解释器时，优先项目环境（Windows `.venv/Scripts/python.exe`；Linux/macOS `.venv/bin/python`），其次父项目环境或系统 Python，确认版本符合项目要求。`$PYTHON` 是所选解释器的路径，不是含参数的命令。
- **没有明确框架时**：若所选解释器能运行兼容的 pytest，可选 pytest；若未安装或不可用，生成纯标准库 `unittest` 测试，不依赖 pytest、pytest fixture 或插件。验证已有 pytest 专用测试时，不得把只发现部分用例的 unittest 运行作为替代；如项目要求 pytest 但不可用，报告环境阻塞。不要为了找到 pytest 更换已选解释器或自动安装依赖。
- **交接**：记录解释器及版本、工作目录、runner、命令和必要的环境设置。修复、覆盖率提升和报告复用该选择，不因缺少可选工具而换环境或 runner。
- **Mock**：两个 runner 均可用 `unittest.mock`（`patch`、`MagicMock`、`PropertyMock`）。目标含 Python 3.6 时，禁止 `AsyncMock`、`IsolatedAsyncioTestCase`、`asyncio.run()` 等较新 API，以及赋值表达式、`match` 等较新语法。异步依赖用返回实际协程的 `async def` 测试替身（需要时在其中用 Mock 记录调用），用事件循环的 `run_until_complete()` 执行协程并清理循环；不要用同步 Mock 冒充可等待对象。
- **参考示例**：pytest 专用写法只适用于 pytest；unittest 用 `TestCase`、`setUp`/`addCleanup`、`subTest` 和对应的断言（如 `assertRaises`、`assertWarns`、`assertAlmostEqual`），保持等价的场景和断言。

## 项目类型检测与策略

| 项目类型 | 检测信号 | 策略 |
|----------|---------|------|
| Flask/Flask-Security | `flask`/`flask_security`导入 | Patch-based单元测试；Flask test client集成测试 |
| Nameko | `nameko`导入，`@rpc`/`@consume` | Mock container/worker_ctx；禁止真实AMQP连接 |
| Standalone | 无框架导入 | Direct patch-based mocking |

详见 [project-type-strategies.md](./project-type-strategies.md)

## 分支分析与测试规划

### 分支识别（所有函数）
1. 列出所有分支：if/elif/else、循环、try/except、raise、early returns、decorator行为
2. 每个raise一个测试——断言错误类型 AND 完整消息内容
3. 复合条件（`if a and b`）：每个子条件独立测试
4. 复合条件（`if a or b`）：测试(a-only true)、(b-only true)、(both true)、(neither true)
5. 验证异常处理行为：检查except块是re-raise还是suppress

### 方法调用清单（所有函数）
1. 列出函数体中每个方法调用（含logging和stdlib调用）
2. 为每个调用规划`assert_called_once_with()`参数验证
3. 注入依赖的调用必须验证（pool、gt、queue等）
4. self.method()用实例级mock（`obj.method = MagicMock()`），不用`patch.object(ClassName, 'method')`
5. 回调注册调用：从`mock.call_args`捕获回调并调用验证下游副作用
6. 负向断言：识别不应被调用的依赖方法，规划`assert_not_called()`

### 条件模式（仅当函数包含这些模式时）
- 状态变更：验证del/pop/赋值的效果
- 多步变更：每步独立验证覆盖优先级
- 集合变更：验证方法参数AND集合内容
- 顺序guard clause：验证优先顺序
- 3+顺序调用：详见 [sequential-workflow-testing.md](./sequential-workflow-testing.md)
- 属性访问边缘情况：详见 [attribute-and-lifecycle-patterns.md](./attribute-and-lifecycle-patterns.md)
- 装饰器/闭包模式：详见 [decorator-and-closure-patterns.md](./decorator-and-closure-patterns.md)
- isinstance链：每个类型分支规划包含测试和排除测试
- guard clause双路径：正面（副作用被调用）+ 负面（副作用未被调用）
- 分支覆盖矩阵：详见 [branch-coverage-matrix.md](./branch-coverage-matrix.md)

## 断言规范

1. 每个分支测试必须包含非平凡断言
2. 禁止仅检查函数被调用、仅检查状态码、仅检查`is not None`
3. dict存储：断言key存在 AND value相等
4. 构造函数调用：通过mock或isinstance + 属性检查验证参数
5. 禁止复合`or`断言中一侧为mock调用检查
6. 禁止trivially-satisfied范围断言（`>= 0`），使用精确值
7. 异常对象属性：验证类定义了该属性，否则用`.args[0]`

## Mock规范

1. 使用`with patch(...)` context manager，不用`@patch`装饰器（与fixture组合时）
2. mock需同时tracking和return value时：用side_effect函数返回值
3. 异常对象mock断言：用`isinstance()`和`str()`，不用`is`比较
4. 不patch isinstance检查中使用的框架类（Response、Request）
5. 被测对象用`ClassName.__new__(ClassName)` + 手动属性赋值，不用`MagicMock(spec=ClassName)`
6. 始终mock阻塞原语（Event.wait()、Queue.get()）
7. weakref.proxy对象不用MagicMock(spec=...)，用真实对象
8. `__import__` patching：用`patch("builtins.__import__", ...)`

## 命名规范

- 测试文件：`tests/test_<module>_unit.py`（如已存在则用`_unit.py`后缀）
- 测试函数：`test_<action>_<condition>_<expected>`，snake_case
- pytest：简单函数（<15测试）可用独立函数；复杂函数（≥15测试）用测试类和共享 setup。unittest：使用继承 `unittest.TestCase` 的类及 `test_` 方法。

## 编译与执行

从已选工作目录执行。优先复用用户或项目的测试命令；无既有命令时，用下列与 runner 匹配的一条：

```bash
# 语法检查（使用所选解释器，不产生 .pyc）
"$PYTHON" -c "import ast, sys; from pathlib import Path; ast.parse(Path(sys.argv[1]).read_bytes(), filename=sys.argv[1])" "<test_file>"

# pytest
"$PYTHON" -m pytest "<test_file>" -v --tb=short

# unittest：分别填入目标文件的父目录、文件名（含 .py）
"$PYTHON" -m unittest discover -s "<test-dir>" -p "<test-filename>" -v
```

用 `discover -s … -p …` 按路径定位文件，无须将路径转成点分模块名，也无须为测试目录添加 `__init__.py`。Bash 引用 `"$PYTHON"`（Windows 路径用 `/`），PowerShell 用 `& $PYTHON`；每个路径参数单独加引号。仅当所选解释器的 `-m pytest --help` 列出 `--timeout` 时才加 `--timeout=10`；其余情况用 shell 工具超时。

## 覆盖率测量与清理

- 优先使用项目已配置且与所选 runner 相符的覆盖率工具。coverage.py 可运行 pytest 或 unittest；pytest-cov 只在 pytest runner 且所选解释器有该插件时使用。不要嵌套 coverage.py 与已启用的 pytest-cov。
- 保留 `.coveragerc`、`setup.cfg`、`pyproject.toml` 等项目配置的发现与设置；沿用项目指定的配置文件。不要用 `NUL` 或 `/dev/null` 绕过配置，也不要改写配置。将本轮测试日志、覆盖率数据及报告放在独立临时目录（作用域内设置 `COVERAGE_FILE` 并指定报告路径）；项目启用了并行数据文件时，在同一临时目录隔离设置下执行 `-m coverage combine "$COV_DIR"` 再出报告。
- 使用所选解释器确认已安装的工具及子命令可用（如 `-m coverage --version`、`-m coverage help json`）。不自动安装或升级依赖。没有兼容覆盖率工具时，直接执行同一 runner，用下方同样的重定向和退出码记录方式保存测试结果；报告覆盖率不可用、门槛未验证。不能用静态估算或全项目汇总值代替目标覆盖率。
- **验收**：保存本轮 verbose 测试日志 `test-output.txt`，执行后在同一 shell 立即保存退出码，再生成诊断报告。失败运行可采集数据，但不能算验收成功；必须实际执行目标用例（零用例不算通过）并通过测试，再用有效的目标范围覆盖数据判定门槛。JSON 缺失时仍可从日志和退出码报告真实测试结果，不得宣称覆盖率达标。

### coverage.py

以下示例用 unittest；若选的是 pytest，把 `-m unittest discover … -v` 换成步骤中已选定的 `-m pytest …` 参数。项目已有 runner 参数须保留。

```bash
COV_DIR=$(mktemp -d) || exit 1
if COVERAGE_FILE="$COV_DIR/.coverage" "$PYTHON" -m coverage run -m unittest discover -s "<test-dir>" -p "<test-filename>" -v > "$COV_DIR/test-output.txt" 2>&1; then
    TEST_RC=0
else
    TEST_RC=$?
fi
# 单进程示例：仅在本轮产生数据时出报告；并行数据先合并。
REPORT_RC=not-generated
if [ -f "$COV_DIR/.coverage" ]; then
    if COVERAGE_FILE="$COV_DIR/.coverage" "$PYTHON" -m coverage json -o "$COV_DIR/coverage.json"; then
        REPORT_RC=0
    else
        REPORT_RC=$?
    fi
fi
printf 'test exit=%s; JSON report exit=%s; artifacts=%s\n' "$TEST_RC" "$REPORT_RC" "$COV_DIR"
```

```powershell
$COV_DIR = (New-Item -ItemType Directory -Path (Join-Path $env:TEMP ([guid]::NewGuid().ToString())) -ErrorAction Stop).FullName
$PreviousCoverageFile = $env:COVERAGE_FILE
try {
    $env:COVERAGE_FILE = Join-Path $COV_DIR '.coverage'
    & $PYTHON -m coverage run -m unittest discover -s "<test-dir>" -p "<test-filename>" -v *> "$COV_DIR/test-output.txt"
    $TestCode = $LASTEXITCODE
    $ReportCode = 'not-generated'
    if (Test-Path -LiteralPath $env:COVERAGE_FILE) {
        & $PYTHON -m coverage json -o (Join-Path $COV_DIR 'coverage.json')
        $ReportCode = $LASTEXITCODE
    }
} finally {
    $env:COVERAGE_FILE = $PreviousCoverageFile
}
Write-Output "test exit=$TestCode; JSON report exit=$ReportCode; artifacts=$COV_DIR"
```

在同一 shell 调用中输出或交接测试退出码、`test-output.txt` 和报告状态（无报告时标明原因）；不得把后续报告命令的退出码当作测试退出码。`coverage json` 不可用时，仅当项目已有可核实相同目标范围行覆盖率的报告方式才用其替代；否则报告目标覆盖率不可用。

### pytest-cov（仅 pytest）

沿用同一临时目录与退出码记录方式，用 pytest 的原命令加覆盖率参数；不额外指定覆盖率源，除非用户或项目有要求。PowerShell 沿用上方的 `try`/`finally` 和 `& $PYTHON`，用 `*> "$COV_DIR/test-output.txt"` 保存日志并立即保存 `$LASTEXITCODE`。

```bash
if COVERAGE_FILE="$COV_DIR/.coverage" "$PYTHON" -m pytest "<test_file>" -v --tb=short --cov --cov-report=term-missing "--cov-report=json:$COV_DIR/coverage.json" > "$COV_DIR/test-output.txt" 2>&1; then
    TEST_RC=0
else
    TEST_RC=$?
fi
printf 'pytest exit=%s; artifacts=%s\n' "$TEST_RC" "$COV_DIR"
```

### 目标覆盖率

在采集覆盖率的同一工作目录执行。`{SKILL_DIR}` 替换为加载 `generate-ut` 返回的 baseDir；`--source` 指定目标源码文件，默认判定该模块。函数任务传 `--function`，增量行覆盖率任务改用 `--changed-lines '<JSON 行号数组>'`（互斥）。显式门槛传 `--threshold <percent>`，否则默认 90%。解析器非零时，按诊断区分有效数据未达标和无有效数据；都不得宣称通过。

```bash
"$PYTHON" "{SKILL_DIR}/scripts/python/parse_coverage.py" "$COV_DIR/coverage.json" --source "<source_file_path>" --function "<function_name>" <start_line> <end_line>
```

### 环境清理

本轮结果分析和交接完成后，仅删除本次创建的临时目录；不得修改或删除项目原有的 `.coverage`。

```powershell
# Windows (PowerShell) - 删除临时目录
Remove-Item -LiteralPath "$COV_DIR" -Recurse -Force
```

```bash
# Unix (bash) - 删除临时目录
rm -rf -- "$COV_DIR"
```

## 子文件导航

| 子文件 | 内容 |
|--------|------|
| [项目类型策略](./project-type-strategies.md) | Flask/nameko/Standalone框架检测、mocking策略、fixture选择 |
| [分支覆盖矩阵](./branch-coverage-matrix.md) | 分支覆盖矩阵模板、方法调用列、中间状态跟踪 |
| [顺序工作流测试](./sequential-workflow-testing.md) | 顺序调用、状态标志、多异常、递归、嵌套逻辑、guard clause优先级 |
| [属性与生命周期模式](./attribute-and-lifecycle-patterns.md) | 描述符、动态属性、context manager、semaphore、while-loop终止、generator |
| [装饰器与闭包模式](./decorator-and-closure-patterns.md) | 装饰器可选参数、闭包/回调捕获、contextmanager-factory |
| [条件模式索引](./conditional-patterns-index.md) | 状态变更、顺序guard、属性生命周期、装饰器闭包的条件测试规划模式 |
| [Mock Patching规则](./mock-patching-rules.md) | 断言质量、mock patching规则、异常对象mock、属性初始化、递归函数caveat |
| [反模式禁令](./anti-patterns.md) | Mock误用、断言误用、编码误用禁令 |
