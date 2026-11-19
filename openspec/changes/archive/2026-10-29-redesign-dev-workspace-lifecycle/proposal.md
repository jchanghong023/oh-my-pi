# Proposal：独立 OpenSpec 与原生能力边界

## Why

独立 OpenSpec 用于维护需求，需求记录不表示软件已经实施或验收。既有 Markdown 需求权威原位维护，避免产生竞争性主规格。

## What Changes

- 保留内置 OpenSpec、Superpowers 和 JCH 的可追溯来源与原生能力。独立 OpenSpec 默认使用 `mini`，既有变更和显式 schema 不强制转换。
- 用户显式请求同步或归档时使用原生引擎和校验；不得以任务完成或软件验证作为归档门禁，也不得以跳过校验或直接移动目录伪造归档。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `spec-driven-orchestration`：明确独立 OpenSpec 的默认需求产物、同步归档边界和原生能力来源。

## Impact

普通聊天、独立 OpenSpec、Superpowers、Team、Goal 及原生工具保持各自用途。原生需求校验不代表软件验收。
