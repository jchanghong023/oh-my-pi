# Go不可用模式工作流

## Go不可用模式工作流

### 触发条件
- go version命令失败（exit code非零）
- go version命令超时（>30s）
- go version显示"downloading goX.Y.Z"未完成

关键：不要尝试go.mod编辑、GOTOOLCHAIN更改、GOPROXY修改或多次重试。立即接受Go不可用并进入估算工作流。

### Go可用性决策门

运行 go version（30s超时）：
- exit code 0 → Go可用 → 必须尝试测试执行 → 使用go tool cover实际覆盖率
- exit code非零或超时 → Go不可用 → 使用估算覆盖率工作流

常见错误：将"tests failed"误读为"Go unavailable"。
- go version exit 0 + tests fail → Go可用 → 修复错误 → 实际覆盖率
- go version exit non-zero → Go不可用 → 估算覆盖率

### 估算工作流

1. 立即写入测试文件骨架
2. 系统化测试生成（无法执行，聚焦正确的mock模式和可观测验证）
3. 覆盖率估算（仅用于流程判断，不写入报告文件）：
   - 计算可执行行数
   - 将每行映射到测试：行号 → 测试名 → 覆盖状态
   - 计算覆盖率百分比（estimated - Go toolchain unavailable）

### gomonkey不可用子模式（Go可用 + gomonkey不可用）

触发条件：go.mod缺少gomonkey且go get失败 / gomonkey编译失败 / gomonkey patches导致持续race

回退策略（按优先级）：
1. L4 Fake Protocol Server（网络客户端首选）
2. L3 Struct field injection via export_test.go
3. L1 Pre-constructed state
4. Lightweight fake implementation
5. Test boundary narrowing

覆盖率：Go可用时使用实际覆盖率测量（不写入报告文件，仅用于流程判断），无estimated声明。
