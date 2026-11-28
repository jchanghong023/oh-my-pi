# Mock/gomonkey错误、运行时错误与覆盖率标志错误

## Mock/gomonkey错误

| 错误类型 | 症状 | 修复策略 |
|----------|------|----------|
| 补丁静默失败 | Mock不生效，测试使用真实实现 | 所有go test命令加 `-gcflags=all=-l` 禁用内联 |
| ApplyMethod panic | `retrieve method by name failed` | 未导出方法使用 `ApplyPrivateMethod`，检查方法名首字母大小写 |
| 嵌入类型补丁失败 | 补丁不生效 | patch BASE类型而非Derived类型，grep查找方法定义 |
| 类型断言失败 | mock struct不匹配type assertion | 不要创建实现接口的mock struct测试ConcreteType路径，直接ApplyMethod on ConcreteType |
| gomonkey不可用 | `go get` 失败 | 回退：L4网络锚点，L3字段注入，L1预构造状态 |
| 并发race | `DATA RACE` 检测到 | gomonkey闭包中共享状态使用 `atomic.Int32`，非裸 `callCount++` |

## 运行时错误

| 错误类型 | 症状 | 修复策略 |
|----------|------|----------|
| nil pointer | `panic: runtime error: nil pointer` | 检查struct初始化、Mock对象是否为nil |
| goroutine泄漏 | 测试超时 | 使用sync.WaitGroup等待goroutine完成，channel消费模式排空 |
| channel死锁 | `fatal error: all goroutines are asleep` | 检查channel发送/接收是否配对，Mock排空channel |
| 断言失败 | `Error:` / `Fatal:` | 检查测试数据、Mock返回值、期望值 |
| 错误内容不匹配 | `expected error containing X, got Y` | 检查Mock返回的错误消息内容 |
| 覆盖率不足 | `≤90%` | 回溯覆盖率缺口归因，补充测试或升级Mock层级 |

## 覆盖率标志错误

| 错误类型 | 症状 | 修复策略 |
|----------|------|----------|
| PowerShell标志解析 | `unknown flag` 或路径错误 | 使用空格分隔标志 `go test -coverprofile cov.txt`（非 `=`） |
| .out扩展名问题 | PowerShell将.out解释为包路径 | 使用 `.txt` 或 `.cov` 扩展名 |
| 函数名匹配 | Select-String匹配过多 | 使用 `$` 锚点：`Select-String "FuncName$"` |

## gomonkey构建标志兼容性

| 构建标志 | gomonkey兼容性 |
|----------|----------------|
| (默认) | 内联导致补丁静默失败 |
| `-gcflags="all=-l"` | 推荐——仅禁用内联 |
| `-gcflags="all=-N -l"` | -N破坏符号匹配，不要组合使用 |
| `CGO_ENABLED=0` | 纯Go模式，gomonkey完全不可用 |
| `CGO_ENABLED=1` + gcc + `-l` | Windows上完整gomonkey支持 |

## 上下文收集策略

### Step 1：同一文件优先

如果多个上下文信息位于同一个文件中，优先一次性读取该文件。

### Step 2：搜索定位

1. 搜索identifier出现的位置
2. 获取定义

### Step 3：构造困难参数

- 检查构造函数是否导出（grep验证）
- 未导出则直接构造struct，显式初始化字段
- 构造struct字面量前先读取struct定义验证字段层次（Go嵌入可能不明显）
