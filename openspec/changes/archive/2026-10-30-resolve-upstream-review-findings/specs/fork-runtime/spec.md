# Spec Delta

## ADDED Requirements

### Requirement: 本地构建的 ZCode 产物版本前置条件

OMP MUST 对本地二进制构建产生的 ZCode 产物执行与已批准产物契约相同的显式版本前置条件。

#### Scenario: 缺少发布版本
- **WHEN** 本地二进制构建设置了 `ZCODE_ARTIFACT_ROOT`，但未提供有效的 `RELEASE_VERSION`
- **THEN** MUST 失败，不得以 package 版本替代发布版本生成 ZCode 产物。

#### Scenario: 显式发布版本
- **WHEN** 设置 `ZCODE_ARTIFACT_ROOT` 且提供有效 `RELEASE_VERSION`
- **THEN** 生成的 ZCode 产物版本 MUST 使用该值，并继续满足源码、目标格式、目录和清理的既有产物契约；未启用产物输出的普通本地构建保持原有版本行为。
