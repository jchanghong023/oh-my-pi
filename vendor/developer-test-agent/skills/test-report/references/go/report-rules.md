# Go 测试报告规则

## 覆盖率数据获取

### 使用go test coverprofile

覆盖率产物统一输出到临时目录，避免污染项目目录。

```powershell
# Windows (PowerShell) - 创建临时目录
$COV_DIR = Join-Path ([IO.Path]::GetTempPath()) ([IO.Path]::GetRandomFileName())
New-Item -ItemType Directory -Path $COV_DIR -ErrorAction Stop | Out-Null
go test -gcflags=all=-l -coverprofile "$COV_DIR\cov.txt" -run TestFuncName -count=1
go tool cover "-func=$COV_DIR\cov.txt" | Select-String -CaseSensitive '\sFuncName\s+\d+(?:\.\d+)?%\s*$'
go tool cover "-html=$COV_DIR\cov.txt" -o "$COV_DIR\coverage.html"
```

```bash
# Unix (bash) - 创建临时目录
COV_DIR=$(mktemp -d "${TMPDIR:-/tmp}/ut-go.XXXXXX") || exit 1
go test -gcflags=all=-l -coverprofile="$COV_DIR/cov.txt" -run TestFuncName -count=1
go tool cover -func="$COV_DIR/cov.txt" | awk 'NF >= 3 && $(NF-1) == "FuncName"'
```

### Windows注意事项

1. 使用空格分隔标志：`go test -coverprofile cov.txt`
2. 不使用 `.out` 扩展名：用 `.txt` 或 `.cov`
3. 按函数列精确匹配；覆盖率百分比位于行尾。

### 覆盖率指标

- 语句覆盖率（主要指标）：`go test -coverprofile` 和 `go tool cover -func` 的百分比按语句计算，NEVER 填为行覆盖率。未单独测量行覆盖率时标注无数据。
- 目标函数体语句覆盖率（>90%，严格超过）

**覆盖率边界规则**：>90%目标适用于**目标函数体**，不是下游私有方法。90.0%不够，必须严格超过90%。

### 环境清理

覆盖率数据获取完成后，仅删除本次创建的临时目录。使用保存了 `COV_DIR` 的同一次 shell 调用。

```powershell
# Windows (PowerShell)
if ($COV_DIR) { Remove-Item -LiteralPath $COV_DIR -Recurse -Force }
```

```bash
# Unix (bash)
rm -rf -- "${COV_DIR:?}"
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
go test -gcflags=all=-l -race -v -run '^TestFuncName$' -count=1
```

- 通过：仅当命令成功且选中的测试确有运行时，报告该范围未检测到数据竞争。NEVER 将 `-run` 的结果扩大到未运行的测试。
- 数据竞争：仅当输出含 `WARNING: DATA RACE` 等 race 检测器诊断时报告。
- 其他失败：单独报告断言、构建或环境错误；NEVER 仅凭非零退出码认定有竞争。
- 未运行：命令未执行或没有测试实际运行（标注⚠️）。
