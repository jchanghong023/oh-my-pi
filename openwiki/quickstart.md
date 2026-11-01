---
type: concept
title: 项目导览与开发快速开始
description: 介绍 OMP fork 的终端 TUI 与 ZCode 桌面双入口定位、开发构建和启动命令，并按常见任务指向相关架构、配置、维护与测试文档。说明以上游基线区分 fork 特有差异与继承能力。
tags: [quickstart, development, fork]
verified:
  - by: openwiki/0.0.0-unknown
    at: 2026-11-01T02:46:50.031Z
sources:
  - id: openwiki-source-f25684a83063f46f55355176
    resource: repo://openspec/specs/fork-product-scope/spec.md
  - id: openwiki-source-51fcc758a0998cde444fdc1e
    resource: repo://openspec/specs/fork-upstream-baseline/spec.md
  - id: openwiki-source-5b54a58d1b51cd490b0e7162
    resource: repo://package.json
generated: { by: "openwiki/0.0.0-unknown", at: "2026-11-01T02:46:50.031Z" }
---

# 项目导览与开发快速开始

本仓库是基于 OMP 的 fork。理解代码或提交改动时，先分清**产品入口**与**能力来源**：产品范围规格规定两类使用场景都以本 fork 的 OMP 为 Agent 核心；终端使用 OMP 原生 TUI，桌面则由 ZCode 提供界面并通过 fork 自有的 app-server 接入 OMP。两者共享执行核心，但不是同一个入口或相同的验收边界。产品目标是默认免手工配置，前提仍包括所需模型服务可达及认证就绪；公司内网场景另有 `OMP_OFFLINE=1` 约定。

## 先运行起来

仓库使用 Bun workspaces，并包含 TypeScript 与 Rust 组件。根目录 `package.json` 提供常用入口：

```sh
bun install
bun run setup
bun run dev
```

`bun run dev` 会从 `packages/coding-agent/src/cli.ts` 运行开发 CLI；也可直接使用 `bun --cwd=packages/coding-agent src/cli.ts`。依赖首次准备或原生组件变更时，参考 setup 流程；构建所有声明了 build 脚本的 workspace 使用 `bun run build`，原生包可单独执行 `bun run build:native`。运行时模型和服务条件依使用场景而异，启动参数、配置优先级及离线默认值见[启动与运行配置](operations/configuration.md)。

开发改动后，不要把“命令能启动”当作完整验证：`bun run check` 并行执行 TS 与 Rust 检查；`bun run test` 执行仓库的本地 TS 测试入口，另有 `bun run test:rs`。按改动范围选聚焦测试和跨入口回归，详见[测试与变更验证](testing/verification.md)。

## Fork 与上游：如何判断差异

[上游基线规格](../openspec/specs/fork-upstream-baseline/spec.md)记录唯一集成基线：`can1357/oh-my-pi@main`，版本 `v18.14.2`，提交 `62f4f7cccfd38adde9a2ae203d69b27bc187a84f`。判断一项实现属于 fork 还是继承能力，应以该提交为对比参照，而不是凭功能名称或当前 README 推断。该基线是同步状态元数据，并不表示集成后的行为已经验收；新增或改变的个人默认值、内网模式、ZCode 接入等应对照 fork 规格和对应测试。

两种入口的产品契约见[双入口产品范围规格](../openspec/specs/fork-product-scope/spec.md)。维护上游同步、识别 fork 差异时，继续读[上游同步与 fork 维护](operations/fork-maintenance.md)；运行时组件和入口组装关系见[运行架构](architecture/runtime.md)。

## 按任务查阅

| 你要做什么 | 从这里开始 |
| --- | --- |
| 了解 CLI、TUI、SDK 或桌面入口如何组装 agent、模型和工具 | [运行架构与请求生命周期](architecture/runtime.md) |
| 修改启动默认值、profile、网络或内网模式 | [启动与运行配置](operations/configuration.md)、[模型供应商与离线运行](integrations/models-offline.md) |
| 调整会话、恢复、持久化或上下文生命周期 | [会话、上下文和持久化](concepts/sessions.md) |
| 增加工具、权限控制、MCP 或技能扩展 | [工具、权限与扩展机制](concepts/tools-extensions.md) |
| 开发 ZCode 桌面接入或 app-server 协议 | [ZCode app-server](integrations/zcode.md) |
| 同步上游、确认改动归属或准备发布 | [上游同步与 fork 维护](operations/fork-maintenance.md) |
| 选择 Bun/Rust 测试或验证跨入口行为 | [测试策略与变更验证](testing/verification.md) |
| 搞清楚仓库索引与 OpenWiki 的边界 | [仓库索引与 OpenWiki 工作流](workflows/indexing.md) |
| 追踪目标自动运行、Team 或规格驱动编排 | [目标、Team 与规格驱动编排](workflows/orchestration.md) |

这些主题彼此关联：先从入口/运行时定位责任边界，再沿状态所有者或集成契约追踪实现；修改 fork 默认行为时同时检查配置、维护基线与真实入口测试。
