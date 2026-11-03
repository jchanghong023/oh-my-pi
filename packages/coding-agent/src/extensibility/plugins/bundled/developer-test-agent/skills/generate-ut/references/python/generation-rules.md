# Python 单元测试生成规则

本文件汇总 Python 单元测试生成的语言专属规则。

## 测试框架

- **测试框架**：pytest（首选），unittest（兼容）
- **Mock框架**：unittest.mock（patch、MagicMock、PropertyMock）
- **覆盖率工具**：pytest-cov / coverage.py，目标 ≥ 90%
- **执行环境**：优先使用 `.venv/Scripts/python.exe`，回退到父项目.venv或系统python

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
.venv/Scripts/python.exe -c "import ast; ast.parse(open('<test_file>').read()); print('Syntax OK')"

# 执行测试
.venv/Scripts/python.exe -m pytest <test_file> -v --tb=short --timeout=10
```

Windows下bash命令使用正斜杠（/），不使用反斜杠。

## 覆盖率测量与清理

覆盖率产物统一输出到临时目录，避免污染项目目录。

`{SKILL_DIR}` 替换为加载 `generate-ut` 时返回的 baseDir，脚本路径加引号。

```powershell
# Windows (PowerShell) - 创建临时目录
$COV_DIR="$env:TEMP\ut-python"; New-Item -ItemType Directory -Force -Path $COV_DIR | Out-Null

# 运行覆盖率
.venv/Scripts/python.exe -m coverage run --rcfile=NUL --branch -m pytest <test_file> -v --tb=short --timeout=10

# 生成JSON报告到临时目录
.venv/Scripts/python.exe -m coverage json -o "$COV_DIR\coverage.json" --rcfile=NUL

# 解析函数级覆盖率
.venv/Scripts/python.exe "{SKILL_DIR}/scripts/python/parse_coverage.py" "$COV_DIR\coverage.json" <function_name> <start_line> <end_line> <source_file_path>
```

```bash
# Unix (bash) - 创建临时目录
COV_DIR="/tmp/ut-python"; mkdir -p "$COV_DIR"

# 运行覆盖率
.venv/bin/python -m coverage run --rcfile=NUL --branch -m pytest <test_file> -v --tb=short --timeout=10

# 生成JSON报告到临时目录
.venv/bin/python -m coverage json -o "$COV_DIR/coverage.json" --rcfile=NUL

# 解析函数级覆盖率
.venv/bin/python "{SKILL_DIR}/scripts/python/parse_coverage.py" "$COV_DIR/coverage.json" <function_name> <start_line> <end_line> <source_file_path>
```

### 环境清理

覆盖率测量完成后，删除临时目录及项目目录中可能残留的覆盖率中间产物：

```powershell
# Windows (PowerShell) - 删除临时目录
Remove-Item "$env:TEMP\ut-python" -Recurse -Force -ErrorAction SilentlyContinue

# 清理项目目录中可能残留的 .coverage 文件
Remove-Item ".coverage" -Force -ErrorAction SilentlyContinue
```

```bash
# Unix (bash) - 删除临时目录
rm -rf /tmp/ut-python

# 清理项目目录中可能残留的 .coverage 文件
rm -f .coverage
```

**注意**：`coverage run` 会在当前工作目录生成 `.coverage` 二进制数据文件。即使 JSON 报告输出到临时目录，`.coverage` 文件仍会留在项目目录，必须显式清理。唯一保留的覆盖率交付物是通过 `parse_coverage.py` 解析后输出的覆盖率结果。

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
