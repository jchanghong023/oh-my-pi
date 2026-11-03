# Go 测试修复规则

## 编译检查

```bash
# 编译测试
go vet ./...
go test -gcflags=all=-l -run NONE -count=1 ./...

# 运行特定测试
go test -gcflags=all=-l -run TestFuncName -count=1 -v
```

## 编译错误

| 错误类型 | 症状 | 修复策略 |
|----------|------|----------|
| 未定义引用 | `undefined: xxx` | 添加正确的import，检查包名 |
| 类型不匹配 | `cannot use xxx as type yyy` | 检查Mock返回类型、struct字段类型 |
| 未导出标识符 | `cannot refer to unexported name` | 使用同包测试（`package X` 非 `X_test`），或通过导出的测试helpers |
| 方法不存在 | `xxx has no field or method yyy` | 检查方法名拼写，验证方法是否导出 |
| import循环 | `import cycle not allowed` | 将测试helpers移到单独包，或使用同包测试 |
| 不够参数 | `not enough arguments` | 检查函数签名是否变更，补充参数 |
| 接口未实现 | `does not implement interface` | 检查mock struct是否实现了所有接口方法 |

## 验证命令

```bash
# 编译门控
go vet ./...
go test -gcflags=all=-l -run NONE -count=1 ./...

# 覆盖率测量（产物输出到临时目录）
COV_DIR="/tmp/ut-go"; mkdir -p "$COV_DIR"
go test -gcflags=all=-l -coverprofile="$COV_DIR/cov.txt" -run TestFuncName -count=1
go tool cover "-func=$COV_DIR/cov.txt" | grep -E "FuncName$"

# Race检测
go test -gcflags=all=-l -race -run TestFuncName -count=1
```

### 环境清理

验证完成后，删除覆盖率临时目录：

```powershell
# Windows (PowerShell)
Remove-Item "$env:TEMP\ut-go" -Recurse -Force -ErrorAction SilentlyContinue
```

```bash
# Unix (bash)
rm -rf /tmp/ut-go
```

## 修复循环限制

最多10轮修复。达到限制后：
- 记录无法修复的问题
- 标注该测试为已知问题
- 不删除测试代码

## 禁止动作

- 禁止修改生产代码（不改变可见性、签名、实现）
- 禁止修改go.mod以外的构建配置（go.mod可添加测试依赖）
- 禁止修改第三方库
- 仅修复测试代码
- 禁止用 `t.Skip` 掩盖问题，应使用mock/fake替代

## 子文件索引

| 子文件 | 内容 |
|--------|------|
| [Mock/gomonkey与运行时错误](./gomonkey-errors.md) | Mock/gomonkey错误6类、运行时错误6类、覆盖率标志错误3类、gomonkey构建标志兼容性表、上下文收集策略 |
