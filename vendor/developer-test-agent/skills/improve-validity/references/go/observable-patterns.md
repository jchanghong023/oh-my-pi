# Go 可观测验证模式与推荐模式

## 可观测验证模式

### Pattern 1: int callCount（优于布尔标志）

```go
type mockDependency struct {
    callCount int  // 并发测试用 atomic.Int32
}
func (m *mockDependency) Method(ctx context.Context) (Result, error) {
    m.callCount++
    return Result{}, nil
}
// 断言
if m.callCount != 1 { t.Errorf("callCount = %d, want 1", m.callCount) }
```

### Pattern 2: 捕获字段验证

```go
var capturedCtx context.Context
sf.onUpdate = func(ctx context.Context) { capturedCtx = ctx }
// 断言
if capturedCtx != expectedCtx { t.Errorf("context mismatch") }
```

### Pattern 3: 接口编译时检查

```go
var _ DependencyInterface = &mockDependency{}
```

### Pattern 4: 并发计数器

```go
var callCount atomic.Int32
before := callCount.Load()
result := targetFunc(ctx)
after := callCount.Load()
if after-before != 1 { t.Errorf("callCount delta = %d, want 1", after-before) }
```

## 推荐模式总结

| 模式 | 适用场景 | 强制级别 |
|---------|------|-------------|
| `int callCount` 优于布尔标志 | 可观测Mock验证 | 推荐 |
| `sync.WaitGroup` 优于 `time.Sleep` | goroutine同步 | 推荐 |
| `strings.Contains(err.Error())` 优于 `err!=nil` | 错误内容验证 | 错误路径测试必需 |
| 验证输出正确性，不仅是 `err==nil` | 成功路径测试 | 必需 |
| 双路径测试（类型 + 字符串回退） | 两条路径都存在的错误处理器 | 必需 |
| `var _ Interface = &mockStruct{}` | 每个接口Mock | 推荐 |
| `atomic.Int32` 用于并发计数器 | 并发gomonkey闭包 | 并发时必需 |
| `t.Helper()` 用于Mock helper | Mock设置函数 | 推荐 |

## 修改注意事项

- **正确性优先**：不破坏现有通过的测试
- **不可检索时不断言**：如果值不可检索，不强行断言
- **只断言可观测行为**：不断言内部实现细节
- **循环内用t.Error**：累积错误而非t.Fatal提前退出
