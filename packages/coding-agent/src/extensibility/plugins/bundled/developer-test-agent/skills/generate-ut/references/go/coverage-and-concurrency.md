# 覆盖率测量与并发安全

## 覆盖率测量

### 命令

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

1. 使用空格分隔标志：`go test -coverprofile cov.txt`（空格）而非 `=`
2. 不使用 `.out` 扩展名：用 `.txt` 或 `.cov`
3. `Select-String` 配合 `$` 锚点匹配函数名末尾

### 覆盖率边界规则

>90%目标适用于**目标函数体**——用户prompt中明确命名的函数，不是其下游私有方法。90.0%不够，必须严格超过90%。

### 环境清理

覆盖率测量完成后，删除临时目录：

```powershell
# Windows (PowerShell)
Remove-Item "$env:TEMP\ut-go" -Recurse -Force -ErrorAction SilentlyContinue
```

```bash
# Unix (bash)
rm -rf /tmp/ut-go
```

## 并发安全

### gomonkey闭包线程安全

gomonkey闭包中的共享状态需要atomic/mutex。裸 `callCount++` 在并发gomonkey闭包中是DATA RACE，使用 `atomic.Int32`。

### -race门控

```powershell
go test -gcflags=all=-l -race -run TestFuncName -count=1
```

所有测试必须通过 `-race`。检测到race必须先修复。

### channel消费模式

当目标启动goroutine发送到channel，由被patch的方法消费时，mock应该排空channel（`for range results {}`）确保所有生产者goroutine完成。

## 常见陷阱

- **覆盖率应超过90%**，90.0%在边界上——继续生成测试推高
- **仅在Go确实不可用时才估算覆盖率**，`go version`成功时修复编译/测试错误并测量实际覆盖率
- **源代码只读**，不改变可见性/签名/实现，使用gomonkey/字段注入替代
- **"go.mod缺少gomonkey"不等于"不能mock"**，运行 `go get`
- **并发gomonkey闭包需要atomic/mutex**，裸 `callCount++` 是DATA RACE
- **Windows使用空格分隔标志和.txt扩展名**
- **测试文件命名跟随源文件名**，不跟随目标函数名
- **用mock/fake替代t.Skip**，t.Skip掩盖单元测试中缺失的隔离
- **未导出方法使用ApplyPrivateMethod**，ApplyMethod在未导出方法上会panic
- **构造struct字面量前先验证字段层次**，Go struct嵌入可能使字段路径不明显
