# Python 覆盖率规则

## 测量

MUST 沿用 [Python 生成与执行规则](../../../generate-ut/references/python/generation-rules.md) 选定的解释器、runner、项目配置和临时目录。用同一份 `coverage.json`、`test-output.txt` 和测试退出状态判定测试及覆盖率；`unittest` 用 coverage.py，不要求 pytest 或 pytest-cov。没有兼容的覆盖率工具？报告测试结果及覆盖率未验证，NEVER 自动安装。

## 门禁

显式任务阈值优先，否则 90%。MUST 实际运行至少一个用例且测试成功。已声明的变更对象、覆盖率范围和阈值 MUST 在补测与最后报告时保持一致。`{GENERATE_SKILL_DIR}` 是 `skill://bundled-developer-test-agent/generate-ut` 返回的 baseDir。

```bash
# 模块级（默认）：传目标源路径，不读取报告的项目总计
"$PYTHON" "{GENERATE_SKILL_DIR}/scripts/python/parse_coverage.py" "$COV_DIR/coverage.json" --source "<source_file.py>" --threshold "<percent>"
```

- 函数级：追加 `--function "<qualified_name>" <start_line> <end_line>`，范围只包括确认过的函数。
- Python 增量模式：追加 `--changed-lines '[12,17,18]'`（示例；实际使用任务的 `变更新侧行` JSON 数组）。只计变更行与目标模块 `executed_lines`/`missing_lines` 的交集；未提供范围时 MUST 报缺项，NEVER 退回模块级结果。新增文件可传全文件的 1-based 行号。
- 脚本零退出且 `pass: true` 表示覆盖率通过。`success: true, pass: false` 表示有数据但未达标；找不到目标或无可执行行（含仅删除/非代码改动）时不能标为通过。覆盖率通过不覆盖失败、未运行或结果未知的测试状态。

## 缓存

首次测量和最终复测后 MUST 更新目标模块的缓存。用当次测试 `-v` 日志；无日志则省略，NEVER 复用上次日志。`{SKILL_DIR}` 是 `improve-coverage` 的 baseDir。

```bash
node "{SKILL_DIR}/scripts/python/extract-python-coverage.js" "<source_file.py>" "$COV_DIR/coverage.json" "$COV_DIR/test-output.txt"
```

- 用项目根相对或绝对源文件路径（含 `.py`），不是模块 basename。输出 `.codecovcli/cache/python_<源路径指纹>.json`；同名模块分开，仅替换当前路径的记录。缓存是模块级统计，不是增量门禁结果。OMP 不自动上报。
- 报告缺失、目标匹配失败或数据无效时，缓存含 `errorDetail` 和本次可解析的测试结果；即使脚本生成了缓存，NEVER 视为覆盖率证据。
- 测量完成仅删除当前临时目录，不删除或改动项目原有覆盖率文件。

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
- re-raise：pytest 用 `pytest.raises`，unittest 用 `self.assertRaises` / `self.assertRaisesRegex`。
- suppress：验证函数正常返回和副作用
- 多except类型：每种异常类型独立测试

## 不可达代码归因

MUST 验证不可达归因并单独说明；NEVER 手工从实测分母扣减行数或修改覆盖率配置来通过门槛。

## 覆盖率提升策略

| 未覆盖类型 | 推荐策略 |
|-----------|---------|
| 缺少分支测试 | 创建针对性测试 |
| Mock拦截 | 用真实对象或调整mock范围 |
| 死代码 | 文档记录为死代码 |
| 框架管理代码 | 尝试集成方式 |
| 阻塞原语未mock | mock Event.wait/Queue.get |
| while-loop未终止 | 用side_effect列表确保终止 |
