# Fork 上游集成基线

## Purpose

记录个人 fork 最近一次成功集成的上游 `main` 精确提交与发布版本，供同步过程、发布元数据和本地验证范围读取。这里的基线是状态元数据，不表示集成后的功能已经验收。

## Requirements

### Requirement: 唯一的已集成上游基线

仓库 MUST 以本规格的唯一有效完整 `Upstream commit` 值记录最近成功集成的 `can1357/oh-my-pi@main`，该提交 MUST 是本地 `main` 的祖先；版本取该上游目标的 `packages/coding-agent/package.json`，同步日期使用 UTC。成功集成时在同一提交更新这些值，且本节只保留唯一版本行。

#### Scenario: 成功集成新的上游 main

- **WHEN** 上游 `main` 的目标提交已成功并入本地 `main`
- **THEN** 本节的版本、完整上游提交和 UTC 同步日期与已集成目标一致，且该提交是本地 `main` 的祖先。

## 当前上游基线

- **分支**：`can1357/oh-my-pi@main`
* **版本**：`v18.13.3`
- **Upstream commit**：`e78a34c881c34528c09348420ab2eb0ea879e2d9`
- **同步日期**：2026-10-28
