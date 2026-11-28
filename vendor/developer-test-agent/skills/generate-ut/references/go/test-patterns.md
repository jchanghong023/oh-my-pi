# 测试生成规则

## Phase 0 — Mock验证

先写1-2个核心路径测试（最简成功 + 最简错误），编译运行。失败则在此修复Mock策略。

## Phase 1 — 覆盖率优先

生成剩余测试达到>90%：
- 分支枚举：列出所有执行路径，每分支至少一个测试
- 通过公共入口调用目标，无真实外部连接
- Mock注入在目标调用之前
- 错误路径测试必须验证错误内容
- 成功路径测试必须验证输出正确性
- 禁用非确定性：设置retry/timeout字段为最小值
- 并发测试：仅当目标使用mutex或修改共享状态时使用sync.WaitGroup
- 表驱动测试用于错误/验证场景
- 调用构造函数前grep验证其是否导出，未导出则直接构造struct

## Coverage Gate

```powershell
# 创建临时目录，覆盖率产物输出到临时目录
$COV_DIR="$env:TEMP\ut-go"; New-Item -ItemType Directory -Force -Path $COV_DIR | Out-Null
go test -gcflags=all=-l -coverprofile "$COV_DIR\cov.txt" -run TestFuncName -count=1
go tool cover "-func=$COV_DIR\cov.txt" | Select-String "FuncName$"
```

```bash
# Unix (bash)
COV_DIR="/tmp/ut-go"; mkdir -p "$COV_DIR"
go test -gcflags=all=-l -coverprofile="$COV_DIR/cov.txt" -run TestFuncName -count=1
go tool cover -func="$COV_DIR/cov.txt" | grep -E "FuncName$"
```

>90% → Phase 2。≤90% → 覆盖率缺口归因。

## Phase 2 — 质量加固

添加延迟项（var _ 检查、t.Helper()、测试意图注释、strings.Contains断言）。删除所有探针测试。加固后重新测量覆盖率。

### 环境清理

测试生成流程结束后，删除覆盖率临时目录：

```powershell
# Windows (PowerShell)
Remove-Item "$env:TEMP\ut-go" -Recurse -Force -ErrorAction SilentlyContinue
```

```bash
# Unix (bash)
rm -rf /tmp/ut-go
```

## 详细规则

| 子文件 | 内容 |
|--------|------|
| [断言规范与可观测验证模式](./assertion-patterns.md) | 断言规范（错误路径/成功路径/双路径错误测试）、可观测验证模式4种Pattern、表驱动测试 |
