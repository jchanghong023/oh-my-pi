# Mock层级选择指南

## Mock层级选择

### Feature Decision Matrix (F1-F13)

| # | 依赖特征 | 检测信号 | 层级 |
|---|----------|----------|------|
| F1 | 内部状态加载 | 状态加载方法调用 + 同包状态结构体 | L1 |
| F2 | 接口类型依赖 | 参数/字段类型为interface | L2 |
| F3 | 结构体有func/interface字段 | func字段或interface字段 | L3 |
| F4 | 路由谓词在目标体内 + 协议解析器错误 | 目标体有错误类型检查 + 解析器错误switch | L4 |
| F5 | 具体类型公共方法，非路由 | reflect.TypeOf + 方法名，无interface | L5 |
| F6 | _(已合并至F5)_ | — | — |
| F7 | 嵌入类型继承方法 | 嵌入*baseType的方法 | L5 |
| F8 | 缺少测试用例 | 分支可达但无测试 | — |
| F9 | 不可达防御代码 | 空值重检/互斥/常量false | — |
| F10 | 连接池回调模式 | 连接获取回调 | L5 |
| F11 | Reader/decoder参数 | r.ReadLine()/r.Decode() | L5 |
| F12 | goroutine/循环中的工厂函数 | go func()/for中的NewXxx() | L5 |
| F13 | 同包未导出方法 | c.privateMethod() | L5 |

### 决策流程

1. **扫描**：对每个依赖，自上而下检查F1→F13，首次匹配胜出
2. **定位**：匹配的层级 = 该依赖的tier
3. **生成**：Mock注入在目标调用之前
4. **验证**：测量覆盖率。>90% → 完成；≤90% → 逐行归因

### 层级定义

- **L1 — 预构造状态**：直接构造正确的内部状态绕过状态加载方法，或对纯逻辑使用真实实现
- **L2 — 接口Mock**：实现满足依赖接口的fake struct
- **L3 — 结构体字段注入**：通过字段赋值注入mock实现（`sf.callback = mockFn`），绕过gomonkey，goroutine安全
- **L4 — Fake协议服务器**：仅用于F4路由谓词场景，启动本地TCP服务器
- **L5 — gomonkey补丁**：用于具体类型方法、嵌入类型方法、工厂函数、未导出方法

### 层级简化规则

层级编号小不等于实现更简单。当L1/L3和L5都能达到相同覆盖率时，选择需要更少测试基础设施且更可靠的方式。

### 层级升级规则

当使用L1-L3后覆盖率≤90%时，在将分支分类为不可达之前，先升级到L5（gomonkey）覆盖未覆盖分支。

## gomonkey使用

### 构建标志

使用gomonkey时，**所有** `go test` 命令必须加 `-gcflags=all=-l`（禁用内联，否则补丁静默失败）。

### API选择

- `gomonkey.ApplyPrivateMethod` — 未导出方法（同包内部首选）
- `gomonkey.ApplyMethod` — 导出方法（具体类型）
- `gomonkey.ApplyFunc` — 包级函数

### Windows特殊说明

无需CGO/MinGW即可完成基本Mock场景。使用 `-gcflags=all=-l` 即可（已验证 gomonkey v2.14.0 + Go 1.24, Windows/amd64）。特定场景（如CGO交互）可能需要 `CGO_ENABLED=1` + gcc，详见 `skill://fix-ut/references/go/gomonkey-errors.md` 的 gomonkey 构建标志兼容性章节。

### 探针测试（仅用于歧义依赖）

```go
func TestProbeDependency(t *testing.T) {
    sf := &TargetStruct{}
    _ = sf.TargetFunc(ctx)
}
```

运行后删除探针测试，不要在磁盘上留下孤立测试文件。
