# Go 测试质量评估与异常覆盖检测

## 测试质量评估维度

### 结构评估

- 测试文件命名：`<source_filename>_test.go`（跟随源文件名，非函数名）
- 同包测试：测试未导出函数时使用 `package X`（非 `X_test`）
- 表驱动测试：错误/验证场景是否使用表驱动
- 辅助函数：`t.Helper()` 用于Mock helper

### 命名规范检查

| 检查项 | 要求 |
|--------|------|
| 测试文件命名 | `<source_filename>_test.go` |
| 测试函数命名 | `Test` + 函数名 + 场景描述 |
| 同包测试 | 测试未导出函数时 `package X` |
| 测试意图注释 | 关键测试有意图说明注释 |
| var _ 接口检查 | 每个接口Mock有 `var _ Interface = &mockStruct{}` |

### 断言质量检查

| 检查项 | 说明 |
|--------|------|
| 缺失断言 | 无 `t.Error`/`t.Fatal` 的用例 |
| 伪断言 | `if true { t.Error() }` 恒为真 |
| 仅无错误 | 成功路径仅 `if err != nil { t.Fatal }` 无输出验证 |
| 仅存在性 | `if result == nil` 无字段验证 |
| 错误内容未验证 | 错误路径仅 `err != nil` 不验证内容 |
| 双路径未覆盖 | 类型错误+字符串回退两条路径未都测试 |
| 提前退出 | 循环内 `t.Fatal` 导致后续迭代未执行 |

### 成功路径验证检查

成功路径测试**必须**验证至少一个非错误输出属性：

```go
// ❌ 仅检查 err == nil
if err != nil { t.Fatal(err) }
// ✅ 验证输出正确性
if err != nil { t.Fatal(err) }
if output.Value != "expected" { t.Errorf("output.Value = %q, want %q", output.Value, "expected") }
```

### 错误路径验证检查

错误路径测试**必须**验证具体错误内容：

```go
// ❌ 弱验证：仅 err != nil
if err == nil { t.Fatal("expected error") }
// ✅ 验证错误内容
if err == nil || !strings.Contains(err.Error(), "expected substring") {
    t.Fatalf("expected error containing 'expected substring', got %v", err)
}
```

## 异常覆盖检测（Go错误处理覆盖）

### 检查维度

| 检查维度 | 说明 |
|----------|------|
| 错误检查分支 | `if err != nil` — 是否Mock触发 |
| 错误类型断言 | `if errors.Is(err, X)` — 是否构造类型化错误测试 |
| 错误字符串匹配 | `if strings.Contains(err.Error(), "msg")` — 是否测试 |
| 错误包装 | `fmt.Errorf("...: %w", err)` — 是否验证错误链 |
| defer recover | `defer func() { if r := recover(); r != nil {...} }` — 是否触发panic验证 |
| 错误聚合 | `multierror.Append()` — 是否构造多个错误验证 |

### 错误处理逻辑覆盖

| 逻辑类型 | 覆盖要点 |
|----------|----------|
| 日志记录 | 验证logger被调用 |
| 错误转换 | 验证新错误类型和消息 |
| fallback返回 | 验证返回默认值 |
| 资源清理 | 验证defer close被调用 |
| 状态重置 | 验证状态被重置 |
| 重试逻辑 | 验证重试次数 |
| 错误聚合 | 验证聚合错误包含所有子错误 |

### 检查清单

- [ ] 被测方法中每个错误处理分支均有对应测试用例触发
- [ ] 错误处理中的处理逻辑（日志、转换、fallback）被验证
- [ ] 错误触发条件通过Mock或构造实现
- [ ] 错误路径测试验证具体错误内容（非仅 `err != nil`）
- [ ] 双路径错误处理器两条路径均被测试
