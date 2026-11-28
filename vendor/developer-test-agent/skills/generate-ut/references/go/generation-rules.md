# Go 单元测试生成规则

本文件为 Go 单元测试生成规则的导航索引。详细规则已拆分到聚焦子文件，按需查阅。

## 测试框架

- **测试框架**：Go内置 testing 包
- **Mock方案**（按层级选择 L1-L5）：
  - **L1**：预构造状态 / 真实纯逻辑
  - **L2**：接口Mock（实现fake struct）
  - **L3**：结构体字段注入
  - **L4**：Fake协议服务器（仅用于路由谓词场景）
  - **L5**：gomonkey补丁

## 硬约束（不可协商）

1. 目标函数体行覆盖率 **>90%**（90.0%不够，必须超过90%），通过 `go test -coverprofile` 测量
2. 仅单元测试范围——不使用真实外部服务
3. 源代码只读——不改变可见性、签名、实现

## 测试文件命名

- 测试文件命名为 `<source_filename>_test.go`（如源文件 `conn.go` → `conn_test.go`）
- **不**按目标函数名命名
- 如已有匹配的 `<source_filename>_test.go` → 追加到该文件
- 如无匹配测试文件 → 创建新文件 `<source_filename>_test.go`
- 测试未导出函数时使用同包（`package X`，非 `package X_test`）

## 详细规则索引

| 主题 | 文件 | 内容概要 |
|------|------|----------|
| Mock层级指南 | [mock-tier-guide.md](./mock-tier-guide.md) | F1-F13 Feature Decision Matrix、决策流程、L1-L5层级定义、层级简化/升级规则、gomonkey使用（构建标志/API/Windows/探针测试） |
| 测试生成 | [test-patterns.md](./test-patterns.md) | Phase 0/1/2生成规则、Coverage Gate |
| 断言规范与验证模式 | [assertion-patterns.md](./assertion-patterns.md) | 断言规范（错误路径/成功路径/双路径）、可观测验证模式4种Pattern、表驱动测试 |
| 覆盖率与并发安全 | [coverage-and-concurrency.md](./coverage-and-concurrency.md) | 覆盖率测量命令、Windows注意事项、覆盖率边界规则、并发安全（gomonkey闭包/-race门控/channel排空）、常见陷阱 |
| Mock错误诊断与高级模式 | [mock-errors-and-patterns.md](./mock-errors-and-patterns.md) | Mock策略错误诊断表14种、错误恢复模式、渐进修复策略、Dispatcher补丁模式、Type-Assertion分发模式、中间参数验证模式、嵌入类型补丁模式 |
| Go不可用模式 | [unavailable-mode.md](./unavailable-mode.md) | Go不可用模式工作流（触发条件/可用性决策门/估算工作流/gomonkey不可用子模式） |
| 反模式禁令 | [anti-patterns.md](./anti-patterns.md) | Mock误用6条+断言误用3条+编码误用2条+代码修改禁令3条 |

## 辅助脚本

以下脚本路径相对于skill根目录：

- `scripts/go/check-test-quality.py`：验证Mock注入、callCount模式、var _检查、WaitGroup使用、错误内容验证、探针测试清理。在Phase 2中作为建议性检查运行（非阻断门控）。
