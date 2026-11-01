---
type: 指南
title: 快速开始与任务导航
description: 从终端或 ZCode 桌面启动本 fork，核对模型认证、源码开发与离线前提，并按任务进入架构、工作流、索引和验证文档。
tags: [quickstart, navigation, terminal, desktop, development]
verified:
  - by: openwiki/0.0.0-unknown
    at: 2026-11-01T04:03:23.095Z
sources:
  - id: openwiki-source-287fb50917c9960ad8767598
    resource: repo://docs-zh-CN/quick-start-intranet.md
  - id: openwiki-source-f25684a83063f46f55355176
    resource: repo://openspec/specs/fork-product-scope/spec.md
  - id: openwiki-source-ba154f518e7ac4ceb4f38ab1
    resource: repo://openspec/specs/fork-runtime/spec.md
  - id: openwiki-source-2d911f2a107f60ec864716fa
    resource: repo://openspec/specs/zcode-app-server/spec.md
  - id: openwiki-source-5b54a58d1b51cd490b0e7162
    resource: repo://package.json
  - id: openwiki-source-5ad84278e31a922db452b5c3
    resource: repo://packages/coding-agent/src/cli.ts
  - id: openwiki-source-3991e5820212155f6efc5331
    resource: repo://README.zh-CN.md
  - id: openwiki-source-c0f6dfed96d41c7ac92e45a7
    resource: repo://scripts/setup.ts
generated: { by: "openwiki/0.0.0-unknown", at: "2026-11-01T04:03:23.095Z" }
---

# 快速开始与任务导航

本 fork 有两个主要入口：在项目目录运行 `omp` 的原生终端 TUI，以及由 ZCode 宿主启动本 fork 的 `omp app-server --stdio`。两者使用同一个 OMP Agent 核心，但各有宿主、交互和验收边界。**零配置文件不是零依赖**：模型服务必须可达，必要认证必须就绪；它也不意味着不会保存会话、缓存或用户选择。先看[系统分层与运行入口](architecture/system-map.md)。

## 1. 选择运行方式

### 已安装的 fork 二进制：终端使用

取得适合平台的 **fork Release** 二进制并确认 PATH 中的 `omp --version` 是预期版本，再进入目标项目运行：

```sh
cd /path/to/project
omp
```

在输入框发送任务，`/` 补全命令，`@` 选择文件。`omp -c` 可继续当前项目最近会话；`omp -P work` 使用独立 profile，`omp -P work -c` 在该 profile 中继续。配置、聊天记录与 Knowledge／Repo 数据库按 profile 隔离。终端操作见 [TUI 交互与个人默认行为](concepts/tui-and-personal-defaults.md)。

不要把上游 README 中的公共 npm、Homebrew 或安装脚本命令当作本 fork 的发布渠道：本 fork 的安装器面向其自身 Release 二进制，当前新 Release 目标为 Linux glibc x64 和 Windows x64；macOS、musl 和其他 Linux 架构没有对应的新预编译资产。安装方式和更新安全边界见 [Fork 上游同步与资源交付](operations/fork-maintenance.md) 及[运行契约](../openspec/specs/fork-runtime/spec.md)。

### 从本仓源码开发

在仓库根目录准备满足版本要求的 Bun、Rust/Cargo 和构建依赖，然后运行：

```sh
bun run setup
bun run dev
```

`setup` 依次安装依赖、构建 native addon、链接 coding-agent 和 `omp`，中途失败即停止；默认 native 构建使用本地 Cargo/N-API。`dev` 运行本仓 `packages/coding-agent/src/cli.ts`，不是安装的 Release 二进制；它的脚本工作目录是 `packages/coding-agent`，做项目级验收时应核对实际工作目录，也可在目标项目用 setup 链接出的 `omp` 启动。Bun 最低版本由 CLI 在启动时检查。源码依赖和 native 构建可能需要预先准备或访问构建资源，不能把运行时 offline 承诺当作离线构建保证。

### ZCode 桌面：由宿主启动

在兼容的 ZCode 环境中，让宿主能找到本 fork 的 `omp`，并设置 `ZCODE_AGENT_SERVER_COMMAND=omp`；宿主以 stdio 启动 `omp app-server --stdio`。这是 ZCode 专用协议及同进程多会话服务，不是独立 RPC 模式，也不是仅运行 CLI 命令就拥有桌面界面。具体宿主装配、协议和能力协商见 [ZCode 桌面与 app-server 边界](integrations/zcode-app-server.md)。

**分别从真实入口验收**：服务和认证就绪后，在终端与实际桌面各发送消息，确认真实模型响应与工具执行。源码测试、协议测试或安装成功不能代替外部 ZCode 桌面验收；无可用桌面环境时应明确标记未验收，而非推断通过。

## 2. 公司内网与认证

Linux/tcsh 的公司环境可按[内网新手指南](../docs-zh-CN/quick-start-intranet.md)先设置，再按环境要求启动 IDE 和模型代理：

```tcsh
setenv OMP_OFFLINE 1
setenv OMP_CONFIG_ROOT "$HOME/omp-data"
ma dmas_ide
ide agent
cd /path/to/project
omp
```

`OMP_CONFIG_ROOT` 是可选的可写绝对数据根，不会自动搬迁旧数据；`OMP_SKILLS_DIR` 也是可选的共享技能目录。公司模式复用已有 Claude Code 公司 API 地址与凭据，前提是它们已正确配置；缺少所需 company 配置时应修复错误，不应假设自动切到别的 provider。模型与角色选择参见[配置、认证与模型选择](concepts/configuration-and-models.md)。

`OMP_OFFLINE` 控制当前进程的无公网默认行为和在线目录发现，不等于禁止公司模型 API 请求或所有网络访问；本地工具和公司服务仍可用。运行默认值、可选模型及排障见[公司内网与离线运行](operations/intranet-offline.md)。另外，本 fork 的运行时默认放宽 TLS 证书校验，可能使凭据暴露于可劫持网络；受控环境以外应审查并显式恢复严格校验，详见[运行契约](../openspec/specs/fork-runtime/spec.md)。切勿把真实密钥写入仓库或共享文档。

## 3. 按任务继续

| 想完成的任务 | 从这里开始 |
| --- | --- |
| 理解终端、桌面和核心的责任边界 | [系统分层](architecture/system-map.md) → [会话与持久化恢复](architecture/session-runtime.md)；非交互宿主看 [SDK、RPC、ACP 与扩展](integrations/headless-and-extension-surfaces.md) |
| 规划并实现一个受控开发任务 | [Dev 四阶段、批准与恢复](workflows/dev-lifecycle.md)；多代理只读讨论看 [Team](workflows/team-discussion.md)，持续目标与预算看 [Goal](workflows/goal-autopilot.md)。三者不是同一开关。 |
| 查询公司资料 | 先在 `/knowledge` 导入 Markdown，或在系统终端运行 `omp knowledge init "/path/to/company-markdown" --name "company-docs"`；终端和会话使用相同数据根及 profile。[Knowledge 文档证据索引](concepts/knowledge-document-index.md)解释快照、检索与引用。 |
| 定位当前项目代码 | 在 `/repo` 面板确认根目录并建立索引；它不自动建库。索引命中只是线索，修改前读取当前源码；外部编辑或切分支后应更新索引。详见 [Repo 代码索引](concepts/repo-code-index.md)。 |
| 生成仓库知识页而非导入资料 | 查看 [OpenWiki 生成与内置资源集成](integrations/openwiki-generation.md)；生成的页面与 `/knowledge` 的文档数据库是不同流程。 |
| 使用或修改技能、规范资源 | 查看 [技能发现、OpenSpec 与 Superpowers](integrations/skills-and-spec-resources.md)；扩展宿主或工具还应检查[扩展边界](integrations/headless-and-extension-surfaces.md)。 |
| 安全修改执行、权限或同步上游 | 先看[工具权限、任务与原生执行](architecture/tools-and-execution.md)及 [Fork 维护](operations/fork-maintenance.md)，再按[验证门禁](testing/verification-gates.md)选择 `bun run fastcheck`、`bun run fulltest` 或 `bun run slowtest`，并补充对应真实入口验收。 |

Wiki 基础全文导入和检索无需模型或向量服务；其内容是导入时的快照，源文件变化不会自动刷新。Repo 则索引当前项目，两者不能互相替代。涉及配置根、profile 或 offline 环境时，确认操作发生在预期的同一上下文中。
