# Proposal：WebGUI 同进程项目宿主 — personal-commands

## Why

明确 WebGUI 同进程服务、项目占用和原生会话归属，避免把项目准入误用为同一项目内的会话执行限制。

## What Changes

- 保留每个进程独立持有的 Web 服务和项目级占用；同一服务可发布多个项目，同一项目 owner 下的原生会话可独立运行。
- 浏览器按页面独立选择项目；继续历史会话前取得其目标项目的实际准入，历史浏览仍按原授权范围。

## Capabilities

### Modified Capabilities

- `personal-commands`：明确同进程 Web 后端与 WebGUI 项目占用的边界。

## Impact

本提案只记录既有 WebGUI 项目宿主边界，不修改正式宿主、后端或运行时。
