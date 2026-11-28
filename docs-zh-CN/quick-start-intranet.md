# OMP Fork 内网快启

## 安装与更新

Fork 仅从公开的 [CNB Releases](https://cnb.cool/jchanghong/bin/-/releases) 分发 Windows x64 和 Linux glibc x64 预编译二进制，不提供 npm 或源码安装。安装和更新均匿名访问 CNB，自定义更新源也须公开。在 [fork 源码](https://cnb.cool/jchanghong/oh-my-pi)目录中运行下列安装器。

Linux（glibc x64）：

```sh
sh scripts/install.sh --binary
```

Windows x64（PowerShell）：

```powershell
.\scripts\install.ps1 -Binary
```

默认使用 CNB 的 `omp` 发布；也可用 Linux `--ref <tag>` 或 Windows `-Ref <tag>` 指定已有版本标签。独立二进制可用 `omp update --check` 检查，再用 `omp update` 更新；设置 `OMP_OFFLINE` 时两者均不可用。包管理器安装需改用 fork 安装器。完成后用 `omp --version` 核对 PATH 实际命中的版本。

安装器和更新器严格校验 CNB 元数据的 TLS 证书，并在替换前比对资产 SHA-256 和完整版本号。缺少版本标记的发布不会安装或更新；需由发布者补齐元数据。企业代理拦截 TLS 时，元数据请求客户端必须信任代理 CA。其余运行时 TLS 边界见[运行规格](../openspec/specs/fork-runtime/spec.md#requirement-安装与运行)。

### 嵌入式 SDK

CNB 的 `omp` 发布提供 `omp-sdk-win32-x64.zip`（需 AVX2）和 `omp-sdk-linux-x64.zip`（glibc 2.17 baseline）。这两包用于编译宿主，不是 CLI 安装包。把宿主入口放在解包目录内，[按上游 SDK 示例导入](../README.md#sdk--embed-in-node)，用 `omp-sdk.json` 指定的 Bun 版本运行 `bun scripts/compile-sdk-host.ts <entry.ts> <output>`；Windows 输出以 `.exe` 结尾，编译使用包内预编译 native addon。

## 红区

在 CentOS 7 上将 `omp-linux-x64` 安装为 `PATH` 上的 `omp`。红区必配 `OMP_OFFLINE` 和 `OMP_CONFIG_ROOT`：下面两行 `setenv` 可放入 `.cshrc`，其余命令在 tcsh 终端执行。代理就绪后再运行 `omp`：

```tcsh
setenv OMP_OFFLINE 1
setenv OMP_CONFIG_ROOT "$HOME/omp-data"
ma dmas_ide
ide agent
cd /path/to/project
omp
```

### 环境变量与数据

- `OMP_CONFIG_ROOT`：持久数据目录，存放配置、凭据和会话。
- 红区 Linux 的性能数据使用 `/dev/shm/omp-<UID>`，包括模型目录缓存 `agent/models.db`、统计和日志。JS eval 的 `bun` 占位脚本和 WebKit 主程序仍使用原有的可执行路径。其他环境沿用原有目录规则。

红区模式会暂时关闭 Web Search 和 Browser（含 `/crawl`）。可以让 Agent 用 `read` 读取可达的内网 HTTP(S) 地址，`fetch.enabled` 默认开启，并遵循你的显式设置。

红区默认关闭终端程序状态通知（OSC 7501），防止不兼容的终端把 `7501…state=working…` 显示成输入。旧版或曾手动开启时，可运行 `omp config set terminal.programStatus false`，然后重启 OMP。

## 黄区

- `OMP_CONFIG_ROOT`：可选，指定持久数据目录。
- `ASCEND_API_KEY`：仅使用 Ascend 时设置。
- Windows 上使用 CodeAgent 时，令牌从当前用户注册表读取。认证失败后 OMP 会重新读取一次，供后续请求使用，不会自动重试当前请求。见 [CodeAgent 认证规格](../openspec/specs/model-providers/spec.md#requirement-codeagent-认证失败后刷新令牌)。

## 常用 fork 入口

- **界面**：按 `Ctrl+Shift+O` 或输入 `/display`，按「详细 → 精简 → 纯聊天 → 紧凑」循环；也可用 `/display detailed` 或 `/display concise` 直达。
  - `/display clean`：专注对话，不显示工具和思考。
  - `/display compact`（默认）：对话区与纯聊天相同，输入框上方显示当前状态和目标、最近工具输出及本轮 Diff。`Ctrl+O` 优先展开本轮 Diff。
  - `Shift+Tab` 切换计划模式。
- **内网协作**：`/collab2 1234` 开房，`/collab2 join 1234` 加入。仅在可信隔离内网使用。`OMP_OFFLINE` 为 `1`、`true`、`yes` 或 `on` 时连接 `10.239.93.104:9333`（忽略首尾空白及大小写），否则连接 `127.0.0.1:9333`。双方须连接同一服务器。
- **画布**：`/sketch` 手绘或贴图标注。红区按提示手动打开本机地址；结果作为 PNG 加入草稿，手动发送，附加前可按 `Esc` 取消。
- **隔离与确认**：`omp -P work` 隔离配置与会话；`omp --approval-mode guarded` 要求确认工具标记的危险操作；`/workspace` 仅提醒写入范围，不是沙箱。
- **需求与知识**：获授权后用 `omp openspec init` 初始化，再用 `/skill:openspec-propose` 起草变更。内置 OpenSpec 工作流遵循上游 schema，并按普通技能发现规则列出。`omp openwiki code --init` 生成仓库 Wiki；要让 Agent 查询已有 Wiki，先运行 `omp config set openwiki.tools.enabled true`。
- **编排**：计划清单用 `/todoloop tasks.md --check` 预检、`/todoloop tasks.md` 执行。[Goal Autopilot](../openspec/specs/spec-driven-orchestration/spec.md#requirement-1-目标与命令) 用于无人值守长任务。

更多见[个人命令规格](../openspec/specs/personal-commands/spec.md)、[已批准需求](../openspec/specs/)与[上游快捷键](../docs/keybindings.md)；fork 绑定以上述差异为准。
