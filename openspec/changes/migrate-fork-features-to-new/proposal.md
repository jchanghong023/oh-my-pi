# Proposal

## Why

`main` 承载日常使用的 fork 功能，但与上游差异过大，持续同步和维护的成本高。现有 `new` 基本等同于 `upstream` 基线，适合作为接替 `main` 的维护分支：保留日常依赖的功能，减少需要长期维护的代码差异。

## What Changes

- 以 [`USER_FEATURES.md`](../../../USER_FEATURES.md) 为唯一功能范围，在现有 `new` 上逐项保留清单规定的入口、默认行为、平台条件和用户可见结果；`new` 已有等价行为时不改。
- 不合并 `main`，不重建 `new`。优先复用上游设置和接口；`main` 的实现能以较小差异接入就直接迁移，过度设计就精简，架构不适合 `new` 就按上游接口重写。只引入清单功能运行和交付必需的实现、配置与资源，不迁清单外功能或无关的构建、发布、CI 改动。
- 不迁移 `main` 的测试和测试基础设施。优先用 `new` 已有的相关检查及实际入口逐项验收；仅当有明确的用户可见回归风险且现有检查无法覆盖时，才新增最小测试并说明理由。Developer Test Agent 是清单中的产品功能，不属于被排除的仓库测试。
- 清单逐项验收通过后，日常使用和维护切到 `new`，`main` 不再作为维护分支。本变更不删除 `main`，也不修改远端默认分支。

## Capabilities

### New Capabilities

- `terminal-interaction`：显示模式、紧凑活动和工具输出／差异、`/tree` 详情、输入框和底栏、轮次用时、界面语言及内网终端默认行为。
- `personal-commands`：工作区写入范围提醒、会话工作树切换、最小改动指令、Linux 中文输入法排查和离线画板。
- `spec-driven-orchestration`：顺序循环提示词、无人值守目标、深度思考、多步统筹和预设工作流程，保留中止、阻塞及独立审批行为。
- `bundled-workflows`：内置 JCH 技能、OpenSpec 命令和技能、Superpowers 技能及其脚本入口、Developer Test Agent。
- `numbered-room-collaboration`：可信隔离内网中的编号房开房、加入、实时协作、离开和关房。
- `openwiki`：内置仓库 Wiki 生成和更新、只读查询、可视化及静态导出。
- `model-providers`：Windows CodeAgent 和 Ascend、内网公司模型及角色默认和限额、未知模型思考探测、会话记忆向量默认与内网回退。
- `fork-runtime`：内网模式和凭据隔离、配置与运行数据目录、启动默认值、后台任务上限、按需 Python 探测、Windows 代理与 OMP 的 HTTPS 策略、运行诊断日志。
- `standalone-distribution`：Windows x64 和 Linux glibc x64 的 CNB 独立安装、更新检查和原位更新、Browser Relay 同步及安装日志。

### Modified Capabilities

无。`new` 目前没有已登记的 OpenSpec 能力；`main` 的规格只作为清单范围内的行为参考，不整体迁移。

## Impact

涉及 `packages/coding-agent` 的 TUI、会话、命令、配置与内置工作流，模型目录与提供者、共享运行环境，以及独立安装和更新所需的脚本及资源。保留上游协议和清单外默认行为；内网凭据不得向公网刷新，安装和更新读取发行元数据时须严格校验证书。
