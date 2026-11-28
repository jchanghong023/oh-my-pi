# Python 测试修复规则

## 错误信息获取

沿用前序阶段记录的解释器、版本、工作目录、runner 和测试命令。单独修复时，优先使用用户提供的命令，再用项目已有入口；未提供时按 `skill://bundled-developer-test-agent/generate-ut/references/python/generation-rules.md` 选择解释器和 runner。不要因缺少依赖换解释器或自动安装。Bash 用 `"$PYTHON"`，PowerShell 用 `& $PYTHON`。

```bash
# 无既有命令时，仅执行所选 runner 对应的一条：
"$PYTHON" -m pytest "<test_file>" -v --tb=short
"$PYTHON" -m unittest discover -s "<test-dir>" -p "<test-filename>" -v
```

`<test-dir>` 是测试文件所在目录，`<test-filename>` 是文件名（含 `.py`）。仅当所选解释器的 `-m pytest --help` 列出 `--timeout` 时才加 `--timeout=10`；其他情况用 shell 工具超时。已有 pytest 专用测试但 pytest 不可用时，报告阻塞，不改用 unittest 假装已验证。

## 错误分类与修复策略

### 编译/语法错误

| 错误类型 | 症状 | 修复策略 |
|----------|------|----------|
| 语法错误 | SyntaxError/IndentationError | 用目标版本的解释器定位报错行，修正语法。最多3次语法修复尝试 |
| 导入错误 | ModuleNotFoundError | 在所选解释器中核对依赖、项目工作目录及 import 路径；真实依赖缺失时报告阻塞 |
| 导入名错误 | ImportError: cannot import name | 重新读取源码验证精确导入路径和名称 |

### Mock配置错误

| 错误类型 | 症状 | 修复策略 |
|----------|------|----------|
| MagicMock无属性 | AttributeError | 移除spec=或用`__new__` + 手动属性赋值 |
| Mock不可调用 | TypeError: 'Mock' object is not callable | 用PropertyMock + new_callable处理属性 |
| 真实对象属性错误 | AttributeError on real object | 用`__new__` + 手动属性赋值绕过`__init__` |
| patch.target拦截self调用 | 测试函数体不执行 | 用实例级赋值`obj.method = MagicMock()`替代`patch.object(ClassName, 'method')` |
| isinstance检查失败 | isinstance返回False | 不patch框架类（Response/Request），用真实对象 |
| side_effect/return_value冲突 | return_value被忽略 | 合并为单个side_effect函数 |
| 异常对象属性访问失败 | AttributeError: 'Exception' has no attribute X | 检查`.args` tuple替代命名属性 |

### 运行时错误

| 错误类型 | 症状 | 修复策略 |
|----------|------|----------|
| 测试超时 | 测试挂起，达到超时上限 | mock所有阻塞原语（Event.wait、Queue.get、sleep） |
| while-loop死循环 | 测试挂起 | 用side_effect列表`[None, Exception()]`确保终止 |
| Fixture冲突 | @patch与fixture顺序冲突 | 用`with patch(...)` context manager替代@patch装饰器 |
| 预期异常未抛出（`pytest.raises` / `assertRaises`） | except块suppress而非re-raise | 按源码契约断言正常返回及可观测副作用 |
| dict.pop断言错误 | MagicMock无pop断言 | 用真实dict时验证状态（key not in dict）而非mock方法 |
| MagicMock(spec=)构造失败 | spec限制属性创建 | 用`ClassName.__new__(ClassName)` + 手动属性赋值 |

### 验证命令

```bash
# 按所选解释器检查语法（不产生 .pyc）
"$PYTHON" -c "import ast, sys; from pathlib import Path; ast.parse(Path(sys.argv[1]).read_bytes(), filename=sys.argv[1])" "<test_file>"
```

修复后复用上面的同一测试命令，确认目标用例确实执行、退出码为零。目标含 Python 3.6 时，修复不得引入 `AsyncMock`、`IsolatedAsyncioTestCase`、`asyncio.run()` 或 3.7+ 的语法/API，异步测试按生成规则使用 `async def` 替身和事件循环。覆盖率采集复用生成规则中的临时目录、项目配置和所选 runner；无兼容工具时只验证测试，不声明覆盖率达标。

## 修复循环限制

Python 采用专属限制：最多3次修复迭代。超过后保留测试、记录剩余失败，不采用通用的禁用回退。

## 失败恢复策略

详见 [failure-recovery-strategies.md](./failure-recovery-strategies.md)，包含：
- 导入错误恢复分支（最多3次）
- Mock设置失败/AttributeError恢复分支（最多3次）
- 测试超时/Fixture冲突恢复分支（最多3次）
- 覆盖率不足恢复分支（最多3次）
- 终端回退策略

## 禁止动作

- 不修改生产代码、构建配置、第三方库
- 不修改.coveragerc/setup.cfg/pyproject.toml
- 不用`@Ignore`/`@Skip`/`pytest.mark.skip`使测试通过
- 不对minor fix做全文件重写（仅>50%内容变更时才重写）
