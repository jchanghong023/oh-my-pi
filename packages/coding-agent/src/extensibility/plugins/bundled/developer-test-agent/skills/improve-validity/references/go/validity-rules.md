# Go 断言有效性评审检查清单

## 评审流程概述（3步）

1. **评审1：规范条款** — 6维度检查（缺失断言、伪断言、错误断言合规、断言可读性、Mock影响、评审关注点）
2. **评审2：静态特征检查** — 3维度检查（缺失断言、伪断言3种模式、提前退出）
3. **评审3：断言目标与步骤** — 需结合被测源码，检查断言目标3类、必须断言3类（成功路径/输出参数/字段级）、错误路径测试、双路径错误测试、必须避免5项、可观测验证模式4种、推荐模式总结表

## 子文件导航

| 子文件 | 内容 |
|--------|------|
| [断言目标与步骤](./assertion-targets.md) | 评审3断言目标3类、必须断言3类（成功路径/输出参数/字段级）、错误路径测试必需、双路径错误测试必需、必须避免5项 |
| [可观测验证模式](./observable-patterns.md) | 4种可观测验证模式（int callCount/捕获字段/接口编译时检查/并发计数器）、推荐模式总结表8行、修改注意事项4条 |

## 评审1：规范条款

### I. 缺失断言

- 无 `t.Error` / `t.Fatal` / `t.Errorf` / 断言的测试用例
- 仅执行操作不验证结果
- 使用 `fmt.Println` 进行人工判断而非断言

**修复**：为每个测试用例添加具体的断言。

### II. 伪断言

- `if true { t.Error() }` — 恒为真条件
- 与SUT输出无关的断言
- 依赖人工观察的断言

**修复**：移除伪断言，替换为验证具体业务属性的断言。

### III. 错误断言合规

Go使用error值而非异常，对应的"异常断言"为错误验证：

- `err != nil` 但不验证错误内容 — 弱验证
- try-catch等价模式（if err != nil + t.Fatal）中无错误内容验证

**修复**：

```go
// ❌ 错误：仅检查 err != nil（弱验证）
err := service.Process(invalid)
if err == nil { t.Fatal("expected error") }

// ✅ 正确：验证错误内容
err := service.Process(invalid)
if err == nil || !strings.Contains(err.Error(), "expected message") {
    t.Fatalf("expected error containing 'expected message', got %v", err)
}

// ✅ 正确：类型断言
if !errors.Is(err, context.Canceled) {
    t.Fatalf("expected context.Canceled, got %v", err)
}
```

### IV. 断言可读性

- 缺失描述性消息

**修复**：

```go
// ❌ 缺失描述
if result != 100 { t.Error() }
// ✅ 带描述
if result != 100 {
    t.Errorf("result = %d, want 100", result)
}
```

### V. Mock对断言有效性的影响

- Mock使测试通过但未验证真实业务逻辑
- 仅验证Mock被调用（callCount）而不验证返回值

**修复**：确保Mock配置和断言共同验证业务逻辑。

### VI. 评审关注点

- 是否有断言
- 是否覆盖关键场景
- 能否检测异常逻辑（核心逻辑被破坏时断言应失败）

## 评审2：静态特征检查

### I. 缺失断言检查

检查测试中是否存在以下断言之一：
- `t.Error` / `t.Errorf` / `t.Fatal` / `t.Fatalf`
- `if x != y { t.Errorf(...) }`
- callCount/verify 模式（验证Mock调用）

### II. 伪断言检查

| 模式 | 禁止写法 | 修复 |
|------|----------|------|
| 恒为真 | `if true { t.Error() }` | 替换为具体业务断言 |
| 仅存在性 | `if result == nil { t.Error() }` 无后续内容验证 | 添加字段级断言 |
| 仅无错误 | `if err != nil { t.Fatal(err) }` 无输出验证 | 添加输出正确性验证 |

### III. 提前退出检查

- 循环内 `return` 导致后续断言未执行
- `t.Fatal` 在循环内导致后续迭代未执行（应使用 `t.Error` 累积错误）

**修复**：循环内使用 `t.Error` 而非 `t.Fatal`，或拆分为独立测试用例。
