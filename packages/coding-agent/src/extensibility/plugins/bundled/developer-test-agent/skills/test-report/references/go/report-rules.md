# Go 测试报告规则

## 覆盖率数据获取

### 使用go test coverprofile

覆盖率产物统一输出到临时目录，避免污染项目目录。

```powershell
# Windows (PowerShell) - 创建临时目录
$COV_DIR="$env:TEMP\ut-go"; New-Item -ItemType Directory -Force -Path $COV_DIR | Out-Null
go test -gcflags=all=-l -coverprofile "$COV_DIR\cov.txt" -run TestFuncName -count=1
go tool cover "-func=$COV_DIR\cov.txt" | Select-String "FuncName$"
go tool cover "-html=$COV_DIR\cov.txt" -o "$COV_DIR\coverage.html"
```

```bash
# Unix (bash) - 创建临时目录
COV_DIR="/tmp/ut-go"; mkdir -p "$COV_DIR"
go test -gcflags=all=-l -coverprofile="$COV_DIR/cov.txt" -run TestFuncName -count=1
go tool cover -func="$COV_DIR/cov.txt" | grep -E "FuncName$"
```

### Windows注意事项

1. 使用空格分隔标志：`go test -coverprofile cov.txt`
2. 不使用 `.out` 扩展名：用 `.txt` 或 `.cov`
3. `Select-String` 配合 `$` 锚点匹配函数名末尾

### 覆盖率指标

- 行覆盖率（主要指标）
- 目标函数体覆盖率（>90%，严格超过）

**覆盖率边界规则**：>90%目标适用于**目标函数体**，不是下游私有方法。90.0%不够，必须严格超过90%。

### 环境清理

覆盖率数据获取完成后，删除临时目录：

```powershell
# Windows (PowerShell)
Remove-Item "$env:TEMP\ut-go" -Recurse -Force -ErrorAction SilentlyContinue
```

```bash
# Unix (bash)
rm -rf /tmp/ut-go
```

## 测试质量评估与异常覆盖检测

详见 [测试质量评估与异常覆盖检测](./report-checks.md)，包含：
- 结构评估4项（测试文件命名/同包测试/表驱动/t.Helper）
- 命名规范检查5项
- 断言质量检查7项
- 成功路径验证检查（必须验证非错误输出属性）
- 错误路径验证检查（必须验证具体错误内容）
- 异常覆盖检测（Go错误处理6维度 + 逻辑7类 + 检查清单5项）

## 附加检查汇总格式

| 检查项 | 状态 | 发现 | 修复总结 |
|--------|------|------|----------|
| 异常覆盖检测 | ✅/🔧/❌/⚠️ | 错误处理路径覆盖关键发现 | 修复内容或无需修复 |
| 断言有效性检查 | ✅/❌/⚠️ | 伪断言/缺失断言/弱验证关键发现 | 修复内容或待修复 |
| 命名规范检查 | ✅/🔧/❌/⚠️ | 文件命名/函数命名/接口检查关键发现 | 修复内容或无需修复 |

状态说明：
- ✅ 通过：检查项全部合规
- 🔧 已修复：发现问题并已修复
- ❌ 发现问题：发现问题待修复
- ⚠️ 无数据：检查结果不可用

## race检测

报告应包含race检测结果：

```powershell
go test -gcflags=all=-l -race -run TestFuncName -count=1
```

- 通过：所有测试通过 `-race` 检测
- 失败：存在数据竞争，需修复
- 未运行：未执行race检测（标注⚠️）
