# Spec Delta

## Purpose

让 Linux glibc x64 和 Windows x64 用户无需预装 Bun 即可从 CNB 安装和更新独立版，保留可用的安装产物，并能查明安装阶段及失败原因。

## ADDED Requirements

### Requirement: CNB 独立安装及校验

OMP MUST 提供从公开 CNB 来源安装 Linux glibc x64 或 Windows x64 独立版的入口。默认来源为 `jchanghong/bin` 的 `omp` 发布，允许指定其他公开来源，无需预装 Bun。

#### Scenario: 校验产物和同版本安装
- **WHEN** 用户安装或更新独立版，或目标版本与当前安装相同
- **THEN** 安装或更新校验文件和版本；同版本跳过下载，但仍检查 PATH。

### Requirement: 安装占用与部分失败

安装和更新 MUST 在占用或替换失败时保护可用安装；PATH 设置失败须报告部分完成。

#### Scenario: 旧会话或旧程序仍在运行
- **WHEN** Linux 检测到旧会话运行，或 Windows 遇到目标程序占用
- **THEN** Linux 提示重启；Windows 先尝试移开旧程序，只有核对占用进程的映像路径后才可结束该进程。

#### Scenario: 替换或 PATH 设置失败
- **WHEN** 文件替换或 PATH 设置失败
- **THEN** 替换失败时尽量保留旧版或已校验的新文件；PATH 设置失败时报部分完成，不宣称全部成功。

### Requirement: 手动更新及内网禁用

OMP MUST 不在启动时自动检查更新；普通模式支持手动检查和通过 `omp update` 从 CNB 原位更新独立安装，公司内网模式停用检查和更新。

#### Scenario: 更新后同步已安装的 Browser Relay
- **WHEN** 普通模式成功更新独立安装，且 Browser Relay 已安装
- **THEN** 尝试同步已安装的 Browser Relay；同步成功时使用更新后的资源，同步失败时记录警告，二进制更新仍生效。

### Requirement: 独立安装日志及保留

安装 MUST 提供独立日志，记录阶段、平台、版本、耗时和错误，默认使用调试级别。

#### Scenario: 清理旧安装日志
- **WHEN** 清理历史安装日志
- **THEN** 按最近 20 次和 5 天清理，跳过仍在运行的安装。
