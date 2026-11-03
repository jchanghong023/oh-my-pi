# 断言规范与可观测验证模式

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
```

### Pattern 2: 捕获字段验证

```go
var capturedCtx context.Context
sf.onUpdate = func(ctx context.Context) {
    capturedCtx = ctx
}
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

## 断言规范

### 错误路径测试（必需）

```go
// ❌ 错误：仅检查 err != nil
if err == nil { t.Fatal("expected error") }

// ✅ 正确：验证错误内容
if err == nil || !strings.Contains(err.Error(), "expected substring") {
    t.Fatalf("expected error containing 'expected substring', got %v", err)
}

// ✅ 正确：类型断言
if !errors.Is(err, context.Canceled) {
    t.Fatalf("expected context.Canceled, got %v", err)
}
```

### 成功路径测试（必需）

```go
// ❌ 错误：仅检查 err == nil
if err != nil { t.Fatal(err) }

// ✅ 正确：验证输出正确性
if err != nil { t.Fatal(err) }
if output.Value != "expected" { t.Errorf("output.Value = %q, want %q", output.Value, "expected") }
```

### 双路径错误测试

当函数同时有类型错误检查和字符串前缀回退检查时，必须覆盖两条路径：
1. 类型错误通过类型构造器 — 测试类型检查路径
2. 普通字符串错误通过 `errors.New()` — 测试字符串回退路径

## 表驱动测试

```go
func TestFunction_InvalidInputs(t *testing.T) {
    tests := []struct {
        name    string
        input   interface{}
        wantErr string
    }{
        {"nil input", nil, "nil"},
        {"wrong type", 42, "wrong type"},
    }
    for _, tt := range tests {
        t.Run(tt.name, func(t *testing.T) {
            err := targetFunc(tt.input)
            if err == nil || !strings.Contains(err.Error(), tt.wantErr) {
                t.Errorf("expected error containing %q, got %v", tt.wantErr, err)
            }
        })
    }
}
```
