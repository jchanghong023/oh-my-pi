# Python 单元测试生成规则

本文件汇总 Python 单元测试生成的语言专属规则。

## 测试框架

- **测试框架**：pytest（首选），unittest（兼容）
- **Mock框架**：unittest.mock（patch、MagicMock、PropertyMock）
- **覆盖率工具**：pytest-cov / coverage.py，目标 ≥ 90%
- **执行环境**：`$PYTHON` 为所选解释器；Windows 优先 `.venv/Scripts/python.exe`，Linux/macOS 优先 `.venv/bin/python`，回退到父项目 .venv 或系统 Python。

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
- 简单函数（<15测试）：flat函数；复杂函数（≥15测试）：class-based + shared setup

## 编译与执行

```bash
# 语法检查
"$PYTHON" -c "import ast, sys; from pathlib import Path; ast.parse(Path(sys.argv[1]).read_bytes(), filename=sys.argv[1]); print('Syntax OK')" "<test_file>"

# 执行测试
"$PYTHON" -m pytest "<test_file>" -v --tb=short
```

PowerShell 用 `& $PYTHON`；Windows 下 Bash 路径用 `/`。仅当 `pytest --help` 列出 `--timeout` 时，才传 `--timeout=10`；否则使用 shell 工具的超时。

## 覆盖率测量与清理

覆盖率产物统一输出到临时目录，避免污染项目目录。

`{SKILL_DIR}` 替换为加载 `generate-ut` 时返回的 baseDir，脚本路径加引号。

```powershell
# Windows (PowerShell) - 创建临时目录
$COV_DIR = (New-Item -ItemType Directory -Path (Join-Path $env:TEMP ([guid]::NewGuid().ToString())) -ErrorAction Stop).FullName

# 运行覆盖率
& $PYTHON -m coverage run --rcfile=NUL "--data-file=$COV_DIR\.coverage" --branch -m pytest "<test_file>" -v --tb=short

# 生成JSON报告到临时目录
& $PYTHON -m coverage json --rcfile=NUL "--data-file=$COV_DIR\.coverage" -o "$COV_DIR\coverage.json"

# 解析函数级覆盖率
& $PYTHON "{SKILL_DIR}/scripts/python/parse_coverage.py" "$COV_DIR\coverage.json" "<function_name>" "<start_line>" "<end_line>" "<source_file_path>"
```

```bash
# Unix (bash) - 创建临时目录
COV_DIR=$(mktemp -d) || exit 1

# 运行覆盖率
"$PYTHON" -m coverage run --rcfile=/dev/null --data-file="$COV_DIR/.coverage" --branch -m pytest "<test_file>" -v --tb=short

# 生成JSON报告到临时目录
"$PYTHON" -m coverage json --rcfile=/dev/null --data-file="$COV_DIR/.coverage" -o "$COV_DIR/coverage.json"

# 解析函数级覆盖率
"$PYTHON" "{SKILL_DIR}/scripts/python/parse_coverage.py" "$COV_DIR/coverage.json" "<function_name>" "<start_line>" "<end_line>" "<source_file_path>"
```

### 环境清理

覆盖率测量完成后，仅删除本次创建的临时目录；不得修改或删除项目原有的 `.coverage`。

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
