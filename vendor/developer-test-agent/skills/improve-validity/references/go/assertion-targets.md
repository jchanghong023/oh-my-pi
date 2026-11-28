# Go 断言目标与步骤

## 评审3：断言目标与步骤（需结合被测源码）

### I. 断言目标

**值变更维度**：返回值一致性、输出参数变更（指针/引用修改）、结构体字段状态变化

**可观测状态转换**：对象状态机转换、集合内容增删、Mock调用次数和参数

**断言有效性检验**：核心逻辑被破坏时断言是否失败

### II. 必须断言的内容

#### 成功路径测试（必需）— 必须验证非错误输出属性

```go
// ❌ 错误：仅检查 err == nil
if err != nil { t.Fatal(err) }
// ✅ 正确：验证输出正确性
if err != nil { t.Fatal(err) }
if output.Value != "expected" {
    t.Errorf("output.Value = %q, want %q", output.Value, "expected")
}
```

#### 修改输出参数的函数 — 验证修改后的状态

```go
// ❌ 错误：仅检查无错误
err := targetFunc(ctx, &cmd)
if err != nil { t.Fatal(err) }
// ✅ 正确：验证修改后的状态
err := targetFunc(ctx, &cmd)
if err != nil { t.Fatal(err) }
if cmd.Name != "expected" {
    t.Errorf("cmd.Name = %q, want %q", cmd.Name, "expected")
}
```

#### 字段级断言

```go
// ❌ 仅存在性
if result == nil { t.Fatal("nil result") }
// ✅ 字段级断言
if result == nil { t.Fatal("nil result") }
if result.Status != "SUCCESS" {
    t.Errorf("Status = %q, want SUCCESS", result.Status)
}
if result.Amount != 100 {
    t.Errorf("Amount = %d, want 100", result.Amount)
}
```

### III. 错误路径测试（必需）— 必须验证具体错误内容

```go
// ❌ 弱验证
err := targetFunc(invalid)
if err == nil { t.Fatal("expected error") }
// ✅ 验证错误内容
err := targetFunc(invalid)
if err == nil || !strings.Contains(err.Error(), "expected substring") {
    t.Fatalf("expected error containing 'expected substring', got %v", err)
}
// ✅ errors.Is
if !errors.Is(err, context.Canceled) {
    t.Fatalf("expected context.Canceled, got %v", err)
}
```

### IV. 双路径错误测试（必需）

当函数同时有类型错误检查和字符串前缀回退检查时，**必须**覆盖两条路径：

1. **类型错误**通过类型构造器 — 测试类型检查路径
2. **普通字符串错误**通过 `errors.New()` — 测试字符串回退路径

```go
// 类型路径测试
result := targetFunc(typedError)
if !result { t.Error("expected true for typed error") }
// 字符串回退路径测试
result = targetFunc(errors.New("error message"))
if !result { t.Error("expected true for string fallback") }
```

字符串前缀回退分支为向后兼容而存在，**不是默认不可达**——必须独立测试。

### V. 必须避免的内容

- 仅存在性断言（`if result == nil` 无字段验证）
- 仅无错误断言（`if err != nil` 无输出验证）
- 伪断言
- 与状态/业务无关的断言
- 错误路径仅 `err != nil`（弱验证）

### VI. 可观测验证模式与推荐模式

详见 [可观测验证模式](./observable-patterns.md)，包含：4种可观测验证模式（int callCount/捕获字段/接口编译时检查/并发计数器）、推荐模式总结表8行、修改注意事项4条
