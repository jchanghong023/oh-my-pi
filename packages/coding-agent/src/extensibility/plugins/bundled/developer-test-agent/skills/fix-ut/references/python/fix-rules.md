# Python 测试修复规则

## 错误信息获取

```bash
# 运行测试获取错误
.venv/Scripts/python.exe -m pytest <test_file> -v --tb=short --timeout=10
```

优先使用 `.venv/Scripts/python.exe`；如缺少模块，尝试父项目.venv或系统python。最多2次发现尝试。

## 错误分类与修复策略

### 编译/语法错误

| 错误类型 | 症状 | 修复策略 |
|----------|------|----------|
| 语法错误 | SyntaxError/IndentationError | 读取报错行号，定位修复。最多3次语法修复尝试 |
| 导入错误 | ModuleNotFoundError | 验证模块在.venv中，尝试父项目.venv，或在测试文件顶部添加sys.path |
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
| 测试超时 | --timeout=10后超时 | mock所有阻塞原语（Event.wait、Queue.get、sleep） |
| while-loop死循环 | 测试挂起 | 用side_effect列表`[None, Exception()]`确保终止 |
| Fixture冲突 | @patch与fixture顺序冲突 | 用`with patch(...)` context manager替代@patch装饰器 |
| pytest.raises DID NOT RAISE | except块suppress而非re-raise | 验证函数正常返回而非用pytest.raises |
| dict.pop断言错误 | MagicMock无pop断言 | 用真实dict时验证状态（key not in dict）而非mock方法 |
| MagicMock(spec=)构造失败 | spec限制属性创建 | 用`ClassName.__new__(ClassName)` + 手动属性赋值 |

### 验证命令

```bash
# 语法验证
.venv/Scripts/python.exe -c "import ast; ast.parse(open('<test_file>').read()); print('Syntax OK')"

# 测试验证
.venv/Scripts/python.exe -m pytest <test_file> -v --tb=short --timeout=10
```

## 修复循环限制

最多3次修复迭代。超过后接受当前状态，记录剩余失败。

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
