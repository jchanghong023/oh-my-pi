# Python 测试报告规则

## 覆盖率数据获取

### 使用coverage.py

```bash
.venv/Scripts/python.exe -m coverage run --rcfile=NUL -m pytest <test_file> -v
.venv/Scripts/python.exe -m coverage json -o coverage.json --rcfile=NUL
```

### 使用pytest-cov

```bash
.venv/Scripts/python.exe -m pytest <test_file> --cov=<source_module> --cov-report=term-missing -v
```

### 覆盖率指标

- 行覆盖率（主要指标）
- 分支覆盖率（如可用）
- 函数覆盖率

**目标**：行覆盖率 ≥ 90%

## 测试质量评估与异常覆盖检测

### 结构评估（4项）
- 测试文件组织（tests/目录、_unit.py后缀）
- Fixture使用（conftest.py、setup_method）
- 辅助函数（shared mock setup）
- 测试类vs函数选择（<15用函数，≥15用类）

### 命名规范检查（5项）
- 测试函数命名：`test_<action>_<condition>_<expected>`
- snake_case一致性
- 测试文件命名：`test_<module>_unit.py`
- 异常测试命名包含异常类型
- guard clause测试包含positive/negative标识

### 断言质量检查（7项）
- 是否存在缺失断言（无assert/pytest.raises）
- 是否存在伪断言（assert True、仅is not None）
- 是否存在仅存在性断言（dict仅key检查）
- 是否存在trivially-satisfied范围断言
- 是否存在复合or断言
- 方法调用是否有参数验证（assert_called_once_with）
- 异常断言是否验证完整消息内容

### 异常覆盖检测
- try/except块是否被触发和验证
- re-raise vs suppress行为是否验证
- 多except类型是否每种都有测试
- pytest.raises是否验证异常类型和消息

## 附加检查汇总格式

| 检查项 | 状态 | 发现 | 修复总结 |
|--------|------|------|----------|
| 异常覆盖检测 | ✅/🔧/❌/⚠️ | try/except覆盖、异常处理断言关键发现 | 修复内容或无需修复 |
| 断言有效性检查 | ✅/❌/⚠️ | 伪断言/缺失断言/仅存在性关键发现 | 修复内容或待修复 |
| 命名规范检查 | ✅/🔧/❌/⚠️ | 命名/文件命名/fixture使用关键发现 | 修复内容或无需修复 |

状态说明：
- ✅ 通过：检查项全部合规
- 🔧 已修复：发现问题并已修复
- ❌ 发现问题：发现问题待修复
- ⚠️ 无数据：检查结果不可用
