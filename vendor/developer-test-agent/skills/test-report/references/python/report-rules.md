# Python 测试报告规则

## 覆盖率数据获取

沿用前序阶段记录的解释器、版本、工作目录、runner、测试命令和本轮结果（测试日志、退出码及可用的覆盖率报告）。单独报告时，优先使用用户命令，再用项目测试入口；未提供时按 `skill://bundled-developer-test-agent/generate-ut/references/python/generation-rules.md` 选择解释器和 runner。不要为生成报告更换环境、runner 或自动安装依赖。

### 采集（需要新数据时）

按上述生成规则的「覆盖率测量与清理」保留项目 coverage 配置、隔离本轮 `$COV_DIR` 并保存退出码。Bash 用 `"$PYTHON"`，PowerShell 用 `& $PYTHON`。coverage.py 的 `coverage run` 使用已选 runner：pytest 用 `-m pytest "<test_file>" -v`，unittest 用 `-m unittest discover -s "<test-dir>" -p "<test-filename>" -v`。有用户或项目既有命令时保留其参数。pytest-cov 仅用于已选 pytest 且插件可用的情况。

### 目标判定与报告

用 `read` 加载 `skill://bundled-developer-test-agent/generate-ut` 获取 baseDir，不执行其生成流程。回到采集时的工作目录判定目标，不把全项目汇总覆盖率当作本任务的结果：

```bash
"$PYTHON" "{GENERATE_SKILL_DIR}/scripts/python/parse_coverage.py" "$COV_DIR/coverage.json" --source "<source_file_path>" --function "<function_name>" <start_line> <end_line>
```

将 `{GENERATE_SKILL_DIR}` 替换为返回的 baseDir。模块级目标省略 `--function`；增量行目标改用 `--changed-lines '<JSON 行号数组>'`；有显式门槛时传 `--threshold <percent>`，默认 80%。解析器非零时区分有效数据未达标与无有效数据。

分别报告测试结果与覆盖率结果。测试失败时，本轮覆盖率只能作为诊断，不计为验收成功；未运行目标用例也不能宣称通过。无兼容覆盖率工具时，仅验证测试，标记「覆盖率数据不可用 / 门槛未验证」，不要以静态估算或项目总覆盖率代替。

### 覆盖率指标

- 行覆盖率（主要指标）
- 分支覆盖率（如可用）
- 函数覆盖率

**目标**：以显式任务范围和行覆盖率门槛为准。

## 测试质量评估与异常覆盖检测

### 结构评估（4项）
- 测试文件组织（tests/目录、_unit.py后缀）
- 测试准备与清理（pytest 的 `conftest.py` / `setup_method`，或 unittest 的 `setUp` / `addCleanup`）
- 辅助函数（shared mock setup）
- 测试类与函数选择（pytest 简单用函数、复杂用类；unittest 用 `TestCase`）

### 命名规范检查（5项）
- 测试函数命名：`test_<action>_<condition>_<expected>`
- snake_case一致性
- 测试文件命名：`test_<module>_unit.py`
- 异常测试命名包含异常类型
- guard clause测试包含positive/negative标识

### 断言质量检查（7项）
- 是否存在缺失断言（含 pytest 或 `TestCase` 断言）
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
- `pytest.raises` 或 `TestCase.assertRaises` 是否验证异常类型和消息

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
