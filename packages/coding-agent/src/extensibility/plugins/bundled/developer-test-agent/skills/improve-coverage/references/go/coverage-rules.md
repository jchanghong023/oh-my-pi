# Go 覆盖率规则

## 覆盖率数据获取

### 覆盖率命令

覆盖率产物统一输出到临时目录，避免污染项目目录。

#### Windows (PowerShell)

> **Windows 路径处理（重要）**：Skill 加载时提供的 "Base directory" 在 Windows 上含反斜杠（如 `C:\Users\...\skills\improve-coverage`）。在 Bash 命令中引用脚本时，**必须将反斜杠替换为正斜杠**（如 `C:/Users/.../skills/improve-coverage/scripts/go/extract-go-coverage.js`），否则反斜杠被 Bash 转义导致 `Cannot find module` 错误。

```powershell
# 创建临时目录
$COV_DIR = Join-Path ([IO.Path]::GetTempPath()) ([IO.Path]::GetRandomFileName())
New-Item -ItemType Directory -Path $COV_DIR -ErrorAction Stop | Out-Null

# 步骤1：测量覆盖率（空格分隔标志，.txt扩展名）
go test -gcflags=all=-l -coverprofile "$COV_DIR\cov.txt" -run TestFuncName -count=1

# 步骤2：生成测试执行结果输出（用于覆盖率上报的测试结果统计）
go test -gcflags=all=-l -v -run TestFuncName -count=1 *> "$COV_DIR\test-output.txt"

# 查看函数级覆盖率
go tool cover "-func=$COV_DIR\cov.txt" | Select-String -CaseSensitive '\sFuncName\s+\d+(?:\.\d+)?%\s*$'

# 查看源码中的覆盖位置
go tool cover "-html=$COV_DIR\cov.txt" -o "$COV_DIR\coverage.html"

# 步骤3：生成覆盖率上报缓存 JSON（写入 .codecovcli/cache/go_{className}.json）
# {target} 为被测文件名（不含 .go），或 profile 中的完整文件路径
# 注意：在 Bash 中运行 node 时，脚本路径必须使用正斜杠
node "{SKILL_DIR}/scripts/go/extract-go-coverage.js" "{target}" "$COV_DIR\cov.txt" "$COV_DIR\test-output.txt"
```

#### Unix (bash)

```bash
# 创建临时目录
COV_DIR=$(mktemp -d "${TMPDIR:-/tmp}/ut-go.XXXXXX") || exit 1

# 步骤1：测量覆盖率
go test -gcflags=all=-l -coverprofile="$COV_DIR/cov.txt" -run TestFuncName -count=1

# 步骤2：生成测试执行结果输出（用于覆盖率上报的测试结果统计）
go test -gcflags=all=-l -v -run TestFuncName -count=1 > "$COV_DIR/test-output.txt" 2>&1

# 查看函数级覆盖率
go tool cover -func="$COV_DIR/cov.txt" | awk 'NF >= 3 && $(NF-1) == "FuncName"'

# 步骤3：生成覆盖率上报缓存 JSON（写入 .codecovcli/cache/go_{className}.json）
# {target} 为被测文件名（不含 .go），或 profile 中的完整文件路径
node "{SKILL_DIR}/scripts/go/extract-go-coverage.js" "{target}" "$COV_DIR/cov.txt" "$COV_DIR/test-output.txt"
```

### Windows注意事项

1. **使用空格分隔标志**：`go test -coverprofile cov.txt`（空格）而非 `go test -coverprofile=cov.out`（=）
2. **不使用 .out 扩展名**：用 `.txt` 或 `.cov`，PowerShell可能将.out解释为包路径
3. **按函数列精确匹配**：覆盖率百分比位于行尾，函数名不是。

### 覆盖率上报集成（强制）

> **此步骤为强制要求，不可跳过。** 覆盖率数据必须写入 `.codecovcli/cache/go_{className}.json`，供外部 DTAgent-Plugin 在子代理执行结束后扫描并通过 OTel 上报；OMP 内置运行时不提供此自动上报。在 improve-coverage 的 Step 1（首次获取覆盖率）和 Step 4（校验覆盖率提升结果）中**均需执行**。

#### 转换脚本

通过 `extract-go-coverage.js` 脚本完成从 Go 原生覆盖率报告到上报 JSON 的转换：

```bash
node "{SKILL_DIR}/scripts/go/extract-go-coverage.js" <目标文件> <coverprofile路径> [go-test-v输出路径]
```

> **Windows 注意**：`{SKILL_DIR}` 替换为 skill 的 "Base directory" 路径，**反斜杠须改为正斜杠**。

**参数说明**：

| 参数 | 必填 | 说明 |
|------|------|------|
| 目标文件 | 是 | 被测 Go 源文件名（不含 `.go`，如 `string_utils`）；同名时 MUST 使用 profile 中含 `.go` 的完整路径，如 `example.com/project/pkg/string_utils.go` |
| coverprofile路径 | 是 | `go test -coverprofile` 生成的覆盖率文件路径 |
| go-test-v输出路径 | 否 | `go test -v` 输出文件路径；不指定时测试结果相关字段填 `0` |

**示例**：

```bash
# 仅覆盖率数据（测试结果字段填0）
node "{SKILL_DIR}/scripts/go/extract-go-coverage.js" string_utils "$COV_DIR/cov.txt"

# 覆盖率数据 + 测试执行结果
node "{SKILL_DIR}/scripts/go/extract-go-coverage.js" string_utils "$COV_DIR/cov.txt" "$COV_DIR/test-output.txt"
```

#### 输出文件

- **路径**：`<项目根目录>/.codecovcli/cache/go_{className}.json`
- **写入前清除历史缓存**：脚本在写入前会删除 `.codecovcli/cache/` 目录下的所有历史缓存文件，避免脏数据
- **异常兜底**：profile 不存在、目标文件未命中或有歧义、数据无效时，MUST 写入含 `errorDetail` 和零覆盖率的 JSON；提供测试输出时仍解析测试结果和编译错误。

#### JSON 格式

生成的 JSON 符合覆盖率上报规范：

- `scenario`：固定 `"class-level"`（DTAgent-Plugin 仅上报 class-level 场景，其他值会被跳过）
- `metrics`：10 个字段，供外部 DTAgent-Plugin 透传到 OTel attributes
  - `compiled_testcase_num`：已执行并解析到结果的测试用例数
  - `passed_testcase_num`：运行通过的测试用例数
  - `covered_line_num`：已覆盖语句数（外部上报字段名不变）
  - `total_compile_error_num`：编译错误总数
  - `total_line_num`：可执行语句数（外部上报字段名不变）
  - `accept_testcase_num`：验收通过的测试用例数
  - `generate_testcase_num`：生成的测试用例数
  - `total_testcase_num`：测试用例总数
  - `accept_line_num`：验收覆盖行数（测试文件代码行数）
  - `generate_line_num`：生成覆盖行数（测试文件代码行数）
- `metadata.language`：固定 `"go"`

#### 完整流程

覆盖率数据获取与上报的完整流程：

1. **运行 `go test -coverprofile`**：每次采集或复测 MUST 新建临时目录，再生成 `cov.txt`。
2. **运行 `go test -v`**：生成测试执行结果输出（含 PASS/FAIL 统计、编译错误检测）
3. **执行 `extract-go-coverage.js`（强制）**：解析覆盖率文件和测试输出，生成 `.codecovcli/cache/go_{className}.json`

> **步骤3 为强制步骤**，在 improve-coverage 的 Step 1 和 Step 4 中均需执行，不可跳过。步骤2为可选——不提供 `go test -v` 输出时，脚本仍可生成覆盖率缓存，但测试结果相关字段（`passed_testcase_num`、`total_testcase_num` 等）填 `0`。

### 覆盖率目标

**>90%**（严格超过90%，90.0%不够）。适用于**目标函数体**——用户prompt中明确命名的函数，不是其下游私有方法。

> **与C/C++的差异**：Go规则要求严格超过90%（`>90%`），而C/C++规则为 `≥90%`（含等于）。Go的严格标准源于其测试文化中对覆盖完整性的更高要求。

### 覆盖率边界规则

>90%目标适用于**目标函数体**——用户prompt中明确命名的函数，不是其下游私有方法。`go tool cover -func` 分别报告每个函数，只提取目标函数的行。

**90.0%不够。** 覆盖率必须严格超过90%。如果在90%边界，继续生成测试推高。

### 环境清理

覆盖率分析完成后，仅删除本轮创建的临时目录。使用保存了 `COV_DIR` 的同一次 shell 调用。

```powershell
# Windows (PowerShell)
if ($COV_DIR) { Remove-Item -LiteralPath $COV_DIR -Recurse -Force }
```

```bash
# Unix (bash)
rm -rf -- "${COV_DIR:?}"
```

## 导航索引

- [覆盖率策略](./coverage-strategies.md) — 覆盖率缺口归因、归因→动作映射、不可达行模式U1-U5、不可达升级规则、层级升级规则、完成门控4问
- [异常覆盖检测](./coverage-templates.md) — Go错误处理覆盖检测6维度、错误处理逻辑覆盖7类
