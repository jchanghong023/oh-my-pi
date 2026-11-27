# Fork 上游集成基线

## Purpose

记录 fork 最近成功集成的上游 `main` 提交和版本，供同步、发布元数据和本地验证范围读取；此状态不代表功能验收。

## Requirements

### Requirement: 唯一的已集成上游基线

成功集成时 MUST 同提交更新本节：唯一有效的完整 `Upstream commit` 为本地 `main` 祖先；唯一版本行用 `* **版本**：` 或 `- **版本**：` 加反引号内的 `v数字.数字.数字`，取上游 `packages/coding-agent/package.json`；日期用 UTC。

#### Scenario: 成功集成新的上游 main

- **WHEN** 目标提交成功并入本地 `main`
- **THEN** 下列版本、完整提交和同步日期与本次集成一致。

## 当前上游基线

- **分支**：`can1357/oh-my-pi@main`
* **版本**：`v19.2.1`
- **Upstream commit**：`e95d0ddc776082a0270ba615a99ae70c816e2f25`
- **同步日期**：2026-11-27
