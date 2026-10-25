# fork-maintenance

## Purpose

规定个人 fork 禁用 Git 钩子的本地维护约束。安装、开发和上游同步均不得重新安装钩子；提交和推送不自动触发检查，验证只按当前任务授权从已有入口显式执行。

## Requirements

### Requirement: Git 钩子

OMP MUST Git 钩子保持禁用，提交和推送不自动运行检查。

#### Scenario: Git 钩子的详细边界

- **WHEN** 本节所述功能在适用条件下运行
- **THEN** 以下具体约束适用：

- 本 fork 不保留或使用任何 Git 钩子，包括提交、推送、签出及外部工具跟踪钩子；安装、开发和上游同步不得恢复钩子或其自动安装步骤。
- 现有 checkout 删除全部钩子文件，并在本仓库设置 `git config --local core.hooksPath /dev/null`；不修改用户全局 Git 配置。
- `git commit` 与 `git push` 不自动运行检查或外部跟踪程序。既有验证命令及通过标准保持不变，仅按任务授权显式执行。

#### Scenario: Git 钩子的可观察行为

- **WHEN** 安装、开发或上游同步后执行提交或推送
- **THEN** Git 钩子保持禁用，提交和推送不自动运行检查
