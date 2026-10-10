# Fork 需求目录

本目录是本项目唯一固定需求目录。开发规则见仓库根 `AGENTS.md`；本目录之外不存在其他需求来源。

| 文档 | 权威范围 | 状态 |
| --- | --- | --- |
| [Fork 定位、功能与默认值](fork.md) | 个人 fork 定位、三种使用场景与零配置目标、上游基线、个人模型与命令、文档检索、交互与默认值、分发、必要修复与简薄验证编排 | 当前文档导入回归与真实 docs CLI 导入、移走源目录后 wiki 检索冒烟通过，fastcheck 通过；其他功能域按对应文档，未据此整体验收；完整 fulltest、WSL/CI、公司实网未验收 |
| [三层本地门禁](fork.md#fork-验证体系) | fastcheck/fulltest/slowtest 的覆盖包含关系、非编译预算与计时、缓存、授权、固定提交 WSL、禁止 CI/桌面输入及验证状态 | 编排已修正，105 个隔离机制/范围测试通过；真实 fastcheck 因 Python RPC SDK 的 43 条 Ruff 错误失败，slowtest 内本机 fulltest 因缺 zip 失败且 Go 不可用，WSL 因未提交源码 BLOCKED；Cargo build-script/native 与 Vite 混合编译计时仍未完全验证，不声明三层通过 |
| [多模型方案讨论](team.md) | `/team` 的行为、集成约束与验收 | 综合资格与正文一致性修复的 64 个测试、API 冒烟及 fastcheck 通过；整体验收与公司模型真实全流程待执行 |
| [Goal 自动编排](goal-auto-orchestrate.md) | `/goal-auto-orchestrate` 的命令、模式持久化、主代理请求级注入、Orchestrate 复用与去重、无人值守及权限边界、验收 | 已实现；120 个相关测试及 fastcheck 通过；Windows 真实 rpc/rpc-ui CLI 与 `bun run dev` TUI 的本地 HTTP Provider 请求验收通过，含连续工具往返、续跑、两次压缩、重试、会话隔离及辅助请求排除；真实模型夜间任务质量、Linux、完整 fulltest 与 ZCode GUI 未验收 |
| [代码定位索引](repo-index.md) | `/repo` 面板、`repo` 查询及索引生命周期 | AST 部分写入失败的局部回归与 Windows 真实 native 故障冒烟通过：保留原错误、刷新已改候选并持续 unchecked，完整核对后清除；fastcheck 通过；当前接口真实 TUI E2E 未验收，公司仓库/NFS/Linux 未验证 |
| [ZCode 接入](rpc-ui-protocol.md) | 保留 ZCode 界面框架与风格，经 OMP 使用多会话（每会话独立进程）、普通消息、问答、指定命令与技能（含 plan/loop/goal）、临时切模型和 role 配置；优先复用上游行为 | RPC loop 排队重复/重置取消的局部回归、fastcheck 及真实 rpc-ui CLI 的对话阻塞后 abort/new_session 有限冒烟通过（localhost 模型 stub）；精确排队窗口仅回归覆盖，完整协议/fulltest/ZCode GUI 未整体验收 |

每条需求只有一个权威维护位置。修改已有功能时更新对应文档；新独立功能域可新增文档并更新本表，不按篇幅机械拆分。跨功能关系通过链接表达，索引不复制具体条款。目录或权威体系缺失时先补齐，再修改实现。

各功能域的验证状态以本表为准；不得将静态检查、文档更新或先前工作树测试视为当前功能验收。只有相应验证实际通过，才可标记验收通过。
