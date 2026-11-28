# 二方件反编译与查询

当需要反编译二方件或查询二方件源码时，使用以下脚本。

## 二方件查询约束

- 二方件源码收集仅在上下文信息收集阶段执行
- 若项目的 .dtagent/deps/index.json 不存在，跳过此子阶段，不中断流程
- 所有流程完成后，若因缺少 index.json 而跳过了二方件查询，向用户提示建议执行二方件反编译功能

## 反编译脚本

**脚本路径**：[decompile.js](../../scripts/java/decompile.js)

```bash
# 使用 node -e 调用 main 函数
node -e "const { main } = require(process.argv[1]); main({packages: ['com.huawei.*'], projectDir: '/path/to/project', m2Params: '-Dpackage.type=vm'}).catch(e => { console.error(e.message); process.exitCode = 1; });" "{SKILL_DIR}/scripts/java/decompile.js"
```

### 参数说明

| 参数 | 说明 | 默认值 | 必填 |
|------|------|--------|------|
| `packages` | 需要反编译的包名数组 | 必填 | 是 |
| `m2Repo` | 显式指定扫描的 Maven 本地仓库 | `-Dmaven.repo.local` → settings.xml 的 `localRepository` → `~/.m2/repository` | 否 |
| `settings` | 自定义 Maven settings.xml 的路径（文件必须存在） | 使用默认设置，即使 `~/.m2/settings.xml` 不存在也可运行 | 否 |
| `projectDir` | 项目目录 | 必填 | 是 |
| `depsDir` | 反编译输出目录 | `{projectDir}/.dtagent/deps` | 否 |
| `m2Params` | Maven CLI 属性（如 `-Dpackage.type=vm`）；参数含空格时用 argv 数组 | 无 | 否 |

### 反编译前参数确认

执行反编译前 MUST 确认可选覆盖项；未指定时使用默认值。缺少必填包名时，由主代理向用户询问后再继续。

- 自定义 Maven settings.xml 路径（仅在需要时提供）
- Maven 本地仓库路径（仅在需要覆盖 Maven 配置时提供）
- Maven CLI 属性（如 `-Dpackage.type=vm`）
- 需要反编译的包名（多个用逗号分隔，如 `com.huawei.*,com.alibaba.*`）

## 查询脚本

**脚本路径**：[binary-detector.js](../../scripts/java/binary-detector.js)

> **Windows 路径处理**：`{SKILL_DIR}` 替换为 skill 加载时提供的 "Base directory" 路径。在 Bash 命令中须将反斜杠替换为正斜杠，否则路径被转义导致 `Cannot find module` 错误。

```bash
# 查找单个类的源码路径
node "{SKILL_DIR}/scripts/java/binary-detector.js" find-binary-source "RestfulResponse"

# 批量查找多个类的源码路径
node "{SKILL_DIR}/scripts/java/binary-detector.js" batch-find-source "RestfulResponse,UserService"

# 列出所有已反编译的类
node "{SKILL_DIR}/scripts/java/binary-detector.js" list-binary-classes "com.huawei" 100
```

### 查询命令说明

- `find-binary-source <className>`：查找单个类
- `batch-find-source <classNames>`：批量查找，类名用逗号分隔
- `list-binary-classes [filter] [limit]`：列出类，可选包名前缀和数量限制
- `--project-dir <path>`：项目根目录路径（可选，若不指定则自动向上查找包含 `.dtagent/deps/index.json` 的目录）

## 注意事项

- 需要先安装 JDK
- 需要先运行反编译生成 `.dtagent/deps/index.json`
- CFR jar 位于 `../../assets/java/cfr-0.152.jar`
