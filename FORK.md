> 本 fork 仓库将长期合并上游正式发布版本；所有 fork 改动应尽可能少、模块化且边界清晰，以最大限度减少后续同步上游时的冲突。

# oh-my-pi Fork 维护说明

本文档定义本 fork 的上游同步、Hub 与 Plan 模式提示词定制、发布构建和验证要求，并记录 fork 与上游正式版本之间的同步历史。

## 1. 仓库与上游

- 上游仓库：<https://github.com/can1357/oh-my-pi.git>
- 当前上游正式基线：`v17.4.2`，提交 SHA：`7ab849ade53d905c30ba2d1ae2126d92a47d2db8`。
- 本 fork 不持续同步上游 `main`，也不合并上游尚未发布的开发代码。
- `main` 只跟随上游最新的正式发布 tag，例如 `v17.4.0`、`v17.4.1`、`v17.5.0`。
- 只有上游发布新的正式版本后，才同步对应 tag，并在该发布基线上重新应用和验证本 fork 的少量源码修改。
- fork 与上游的差异应保持少量、明确且易于长期维护。

### 1.1 模型选择界面的 Provider 可见性

> 本 fork 只限制模型选择 UI 的可见 Provider；默认显示 OpenCode Go、OpenCode Zen、OpenAI Codex、DeepSeek，以及所有非 bundled 的自定义 Provider。此行为不改变底层 Provider 可用性。

可见性规则仅应用于 Model Hub 和 Model Picker，并以 upstream 的 bundled model catalog 与 Provider descriptor 表判断内置 Provider；当前未出现在这两处的隐式内置 `llama.cpp` 作为单项例外处理。`models.yml` 中配置的自定义 Provider 与 extension 注册的非内置 Provider 自动显示；其他内置 Provider（包括以后 upstream 新增的内置 Provider）默认隐藏。认证、Provider discovery、SDK、ModelRegistry、Settings、capability 与 task/subagent 等底层逻辑保持 upstream 原样。

## 2. 上游同步流程

每次同步上游正式版本时：

1. 确认目标版本是上游已经发布的正式 tag，而不是上游 `main` 上的版本号或候选代码。
2. 获取并校验目标 tag 及其提交 SHA。
3. 以该 tag 作为新的源码基线，不合并 tag 之后的上游开发提交。
4. 重新应用本 fork 维护的最小源码差异并解决兼容问题。
5. 确认 `packages/coding-agent/package.json`、native package 版本和目标 tag 完全一致。
6. 执行本文档规定的质量检查、Hub 专项测试和发布验证。
7. 在“同步与发布记录”中登记上游 tag、上游 SHA、fork 提交、差异摘要和验证结果。

正式发布必须满足：

```text
当前源码版本 = 上游正式 tag 版本 = 官方 native package 版本
```

例如，源码版本为 `17.4.2` 时，基线必须是上游 `v17.4.2`，native 依赖也必须是 `17.4.2`。

## 3. Hub 设计目标

本 fork 保留官方完整 Hub 业务实现，包括：

- IRC
- `AgentRegistry`
- peer messaging
- `AsyncJobManager`
- 长进程 supervisor
- Hub 原有执行逻辑和权限规则

fork 只根据配置控制大模型上下文中可见的 Hub schema、description、examples 和协作提示。`compact` 与 `full` 必须共用同一套 Hub runtime，不复制异步任务、长进程或 peer messaging 的业务实现。

```text
Hub runtime
├── full
│   └── 官方完整 Hub 表面
└── compact
    ├── 精简 schema
    ├── 独立精简 prompt
    └── 精简 examples
```

## 4. Hub 模式配置

配置项为 `hub.mode`，支持：

- `compact`：默认值
- `full`：官方完整 Hub 模型能力

配置文件可表示为：

```yaml
hub:
  mode: compact
```

命令行切换：

```bash
omp config set hub.mode compact
omp config set hub.mode full
```

模式切换后不得要求重新编译。

## 5. Compact 模式

### 5.1 Agent 和异步任务管理

保留 `task` 创建子 Agent，并允许父 Agent：

- 创建和并行运行子 Agent。
- 使用 `hub jobs` 查看运行状态。
- 使用 `hub wait` 等待任务完成并获取结果。
- 接收任务完成后的自动结果回传。
- 使用 `hub cancel` 取消自己拥有的任务和自己创建的子 Agent。

继续遵循官方权限规则：父 Agent 只能控制自己拥有的任务和子 Agent。

Compact 的默认关系是父 Agent 负责任务分配、状态管理、等待、取消和结果汇总，不依赖父子或子 Agent 之间的实时消息、peer inbox 或 peer roster。

### 5.2 长进程管理

完整保留：

- `hub start`
- `hub ps`
- `hub logs`
- `hub stop`
- `hub restart`
- `hub describe`
- `hub send` + `name`
- `hub wait` + `name`

这些能力必须继续支持 dev server、watcher、debugger、REPL、长时间测试，以及需要后续 stdin、按键或信号的进程。

必须明确区分：

- `send` + `to`：Agent 通信，Compact 隐藏。
- `send` + `name`：长进程输入、按键或信号，Compact 保留。

### 5.3 模型上下文中隐藏的能力

Compact 模式不向模型暴露：

- `list`
- `inbox`
- `send` + `to`
- `to`
- `message`
- `replyTo`
- `await`
- `from`
- `peek`

同时不向模型提供 Agent-to-Agent messaging、IRC 协作、peer messaging examples，以及要求 Agent 通过 `hub send` 相互协调的提示。这些能力的底层实现仍保留。

### 5.4 Hub 可用性

Compact Hub 不能因为 IRC 未启用而整体隐藏。只要启用了异步任务或长进程管理，Hub 就应保持可用；IRC 是否启用不得决定 Compact Hub 是否注册。

## 6. Full 模式

`hub.mode = full` 时恢复官方完整 Hub 模型能力，包括：

- `list`
- `inbox`
- `send` + `to`
- `to`
- `message`
- `replyTo`
- `await`
- `from`
- `peek`
- 官方完整 Hub messaging prompt 和 examples
- task 中完整的 IRC/peer coordination 指导

目标是使 Full 模式的模型可见表面和行为与官方原生 Hub 等价。

## 7. Prompt 要求

- Full 模式直接使用官方完整 Hub prompt。
- Compact 模式使用独立精简 Hub prompt，只描述异步任务管理、子 Agent 状态管理和长进程管理。
- Compact prompt 不描述 peer messaging、IRC、inbox 或 Agent-to-Agent send。
- task prompt 根据 `hub.mode` 动态决定是否显示 IRC/peer coordination 内容。

### 7.1 Plan 模式的问题还原与澄清

需求：每轮注入的隐藏 `plan-mode-context` developer 提示词必须先还原用户真正要解决的问题。可通过对话上下文或仓库探索确认的信息由 Agent 自行确认；只有仍会影响最终行为、范围或方案的关键歧义才向用户澄清，不得代替用户作关键假设。

最终英文指令为：

> First reconstruct the problem the user actually needs solved. Resolve anything confirmable from conversation context or exploration independently. Ask the user only about remaining critical ambiguities that would change final behavior, scope, or approach; NEVER make a key assumption on the user's behalf.

配套规则：非关键偏好可以采用推荐默认值并记录为 assumption；关键歧义必须澄清。`ask` 工具不可用时，允许提出最少必要的纯文本问题，不得以默认假设替代。该定制仅修改 Plan 模式的隐藏 developer 上下文，不拼接或改写用户消息。

## 8. 发布要求

### 8.1 触发与版本基线

- Fork Release 工作流只能手动触发。
- 只允许从 `main` 构建发布。
- 发布前必须验证当前源码版本对应上游同版本正式 tag。
- 禁止使用上游尚未发布的开发代码生成正式 fork release。

### 8.2 平台与产物

必须构建：

- Linux x64：`omp-linux-x64`
- Linux ARM64：`omp-linux-arm64`
- Windows x64：`omp-windows-x64.exe`
- 三个二进制的 SHA256 清单：`SHA256SUMS.txt`

Linux x64 和 Linux ARM64 尽量沿用官方发布方式和 glibc 2.17 兼容策略，目标支持 CentOS 7。

### 8.3 Native 依赖和 Rust

直接复用与源码版本严格一致的官方 native packages：

- `@oh-my-pi/pi-natives-linux-x64`
- `@oh-my-pi/pi-natives-linux-arm64`
- `@oh-my-pi/pi-natives-win32-x64`

Fork Release 不自行编译 Rust native，继续使用官方正式版本已发布的 native 产物和二进制构建逻辑。

## 9. 测试与验收

修改和上游同步完成后，应通过项目现有的相应质量检查，包括：

- Biome
- TypeScript type check（使用项目规定的 `bun check`，不直接运行 `tsc`）
- workspace tests
- runtime/session tests
- CLI smoke tests
- UI/TUI tests
- native/integration tests
- Nix checks

Hub 模式专项测试至少验证：

- `hub.mode` 默认值为 `compact`。
- Compact 不暴露 `list`、`inbox`、`send + to` 及相关 Agent 通信字段、prompt 和 examples。
- Compact 保留 `jobs`、`wait`、`cancel`、异步结果回传和所有长进程能力。
- Full 恢复官方完整 Hub schema、Agent 通信能力、prompt、examples 和 task 协作指导。
- Compact 与 Full 共用同一套 Hub runtime。
- Compact Hub 的注册不依赖 IRC 可用性。
- 父 Agent 的任务控制权限与官方规则一致。

## 10. Git 与维护要求

> 为流程简单，本仓库直接修改主分支，没有 PR。

功能开发完成后直接提交并推送到 `main`：

1. 实现并验证最终需求。
2. 检查相对对应上游正式 tag 的完整代码差异。
3. 确保全部 CI 通过。
4. 直接提交并推送到 `main`，无需创建 PR。

最终 `main` 应始终保持“上游正式发布版本 + 少量、明确、长期可维护的 fork 修改”。
## 11. 同步与发布记录

每次同步或发布都追加一行；不得覆盖历史记录。上游 SHA 应取自对应正式 tag，fork SHA 应填写合入 `main` 后的提交。

| 日期 | 上游正式 tag | 上游 tag SHA | Fork 版本/Tag | Fork SHA | Fork 差异摘要 | 验证结果 |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-08-21 | `v17.4.0` | `72000acfeb902e21816252699482887f34d1a5a4` | `17.4.0` / `v17.4.0-fork.3` | `7f5a51fff` | 精简 Hub 模型表面；增加 fork 发布流程 | 已核验上游 tag SHA、本地 fork tag 和 package 版本；Hub 双模式改造尚待最终验收 |
| 2026-08-21 | `v17.4.2` | `7ab849ade53d905c30ba2d1ae2126d92a47d2db8` | `17.4.2` / `v17.4.2-fork.1` | `1e814d8` | 合并上游 17.4.2（607 文件，含 image broker、composer attachment chips、cli-reference、archive 扩展等）；保留 fork Hub compact/full 双模式与 Plan 提示词定制；更新 native manifest 与 CI 钉版本至 17.4.2 | 已完成合并与文档/流水线更新，待 CI 验证 |
