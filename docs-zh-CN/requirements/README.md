# Fork 需求目录

本目录是本项目唯一固定需求目录。开发规则见仓库根 `AGENTS.md`；本目录之外不存在其他需求来源。

| 文档 | 权威范围 | 状态 |
| --- | --- | --- |
| [Fork 定位、功能与默认值](fork.md) | 个人 fork 定位、三种使用场景与零配置目标、上游基线、个人模型与命令、文档检索、交互与默认值、分发、运行诊断日志与简薄验证编排 | 运行诊断日志已补齐；当前相关测试按最新文件运行去重为 1214 通过、40 平台跳过、4 未通过（RPC plan fixture 1、Luna 认证 mock 3）；Windows 真实源码 CLI/docs/wiki、同机 IPC、localhost HTTP/SSE 重试失败取消、隔离 TUI 启动退出、安装器拒绝及日志脱敏关联冒烟通过。fastcheck 未通过：既有 fork 默认模型类型与两处上游测试调用不匹配，Rust 阶段未完成；未改写测试求绿。fulltest/slowtest、WSL/CI、公司实网和 ZCode GUI 未验收 |
| [三层本地门禁](fork.md#fork-验证体系) | fastcheck/fulltest/slowtest 的覆盖包含关系、非编译预算与计时、缓存、授权、固定提交 WSL、禁止 CI/桌面输入及验证状态 | 按维护者要求沿用原有 fork 改动相关范围；运行状态以对应固定源码快照的实际门禁输出为准，不代表全仓库通过。Cargo 混合阶段的完整编译排除仍未验证，不能把隔离机制测试当作真实编译计时验收 |
| [多模型方案讨论](team.md) | `/team` 的行为、集成约束与验收 | 综合资格与正文一致性修复的 64 个测试、API 冒烟及 fastcheck 通过；整体验收与公司模型真实全流程待执行 |
| [Goal 自动编排](goal-auto-orchestrate.md) | `/goal-auto-orchestrate` 的命令、模式持久化、主代理请求级注入、Orchestrate 复用与去重、无人值守及权限边界、验收 | 已实现；请求预算与压缩预留、Codex 工具续轮、TUI 异步草稿保护及 Code Mode 间接工具相关回归通过，Windows 本地 HTTP Provider 真实 CLI 入口验证通过；静态门禁状态以当前运行输出为准；真实模型夜间任务质量、全项目验证与 ZCode GUI 未验收 |
| [代码定位索引](repo-index.md) | `/repo` 面板、`repo` 查询及索引生命周期 | AST 部分写入失败的局部回归与 Windows 真实 native 故障冒烟通过：保留原错误、刷新已改候选并持续 unchecked，完整核对后清除；fastcheck 通过；当前接口真实 TUI E2E 未验收，公司仓库/NFS/Linux 未验证 |
| [ZCode 接入](rpc-ui-protocol.md) | 保留 ZCode 界面框架与风格，经 OMP 使用多会话（每会话独立进程）、普通消息、问答、指定命令与技能（含 plan/loop/goal）、临时切模型和 role 配置；优先复用上游行为 | RPC loop 排队重复/重置取消的局部回归、fastcheck 及真实 rpc-ui CLI 的对话阻塞后 abort/new_session 有限冒烟通过（localhost 模型 stub）；精确排队窗口仅回归覆盖，完整协议/fulltest/ZCode GUI 未整体验收 |

`/jch-workflowzbatch`（契约见 [JCH 命令](fork.md#jch-命令)）：已实现；4 个参数边界回归通过，覆盖正文内 CRLF、代码行尾空格、连续空行、表格空白及字面量保留；Windows 真实 rpc-ui CLI → localhost HTTP Provider 的目录注册、用户消息展开、原文字面量及上述空白保留、workflowz 通知及非法参数拒绝验证通过。未启动批处理子代理；真实模型遵守限制、200 项/30 并发执行及 TUI/ZCode GUI 未验收。本次未运行全仓检查或门禁。

每条需求只有一个权威维护位置。修改已有功能时更新对应文档；新独立功能域可新增文档并更新本表，不按篇幅机械拆分。跨功能关系通过链接表达，索引不复制具体条款。目录或权威体系缺失时先补齐，再修改实现。

各功能域的验证状态以本表为准；不得将静态检查、文档更新或先前工作树测试视为当前功能验收。只有相应验证实际通过，才可标记验收通过。
