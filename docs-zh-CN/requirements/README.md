# Fork 需求目录

本目录是本项目唯一固定需求目录。开发规则见仓库根 `AGENTS.md`；本目录之外不存在其他需求来源。

| 文档 | 权威范围 | 状态 |
| --- | --- | --- |
| [Fork 定位、功能与默认值](fork.md) | 个人 fork 定位、三种使用场景与零配置目标、上游基线、个人模型与命令、文档检索、交互与默认值、分发、运行诊断日志与简薄验证编排 | 已补充 RPC/Goal、会话删除、team、JchTools、docs/wiki、repo、offline models/bench、WSL 预检关键日志，并脱敏公共 fatal 记录；本轮局部运行存在回归断言问题及既有上游 RPC plan fixture 失败，修正后按用户要求停止测试，未重跑，不能标记完整验收通过。先前 fastcheck 未通过且本轮未运行；fulltest/slowtest、真实 WSL/CI、公司实网和 ZCode GUI 未验收 |
| [三层本地门禁](fork.md#fork-验证体系) | fastcheck/fulltest/slowtest 的覆盖包含关系、非编译预算与计时、缓存、授权、固定提交 WSL、禁止 CI/桌面输入及验证状态 | 沿用原有 fork 改动相关范围；Windows 隔离机制验证 118 通过、3 个 Linux 专属用例未运行，短任务与真实 Bun 失败测试验证首个失败停止调度和终止并行任务。运行状态以对应源码快照的实际门禁输出为准，不代表全仓库通过；Cargo 混合阶段的完整编译排除仍未验证，不能把机制验证当作真实三层门禁验收 |
| [多模型方案讨论](team.md) | `/team` 的行为、集成约束与验收 | 已有综合资格与正文一致性的 64 个测试、API 冒烟及 fastcheck 通过记录；当前参与者作用域、远端能力拒绝和复核材料传递修复未运行测试或真实入口验证，整体验收与公司模型真实全流程待执行 |
| [Goal 自动编排](goal-auto-orchestrate.md) | `/goal-auto-orchestrate` 的命令与模式持久化、上游 Goal 正常历史消息链、首次通知及成功压缩后的完整目标／共享 Orchestrate 重构、构造去重与历史不变性、全过程授权与无人值守、持久化与 WebSocket／严格前缀验收 | 已撤销通用消息过滤扩展与自定义队列协调，首次通知附加于普通 Goal 历史，成功压缩后重构；当前 Goal 压缩／排队回归 75 例通过，真实 CLI 8 个场景通过，覆盖普通 Goal 对照、HTTP 与 Codex WebSocket 十轮严格前缀、两次压缩、无 task、完成／预算／取消。相关修改文件 LSP 无错误；未运行 fulltest/slowtest，完整 TUI／ZCode GUI、真实模型无人值守遵从、缓存命中、任务质量与账单未验证 |
| [代码定位索引](repo-index.md) | `/repo` 面板、`repo` 查询及索引生命周期 | AST 部分写入失败的局部回归与 Windows 真实 native 故障冒烟通过：保留原错误、刷新已改候选并持续 unchecked，完整核对后清除；fastcheck 通过；当前接口真实 TUI E2E 未验收，公司仓库/NFS/Linux 未验证 |
| [ZCode 接入](rpc-ui-protocol.md) | 保留 ZCode 界面框架与风格，经 OMP 使用多会话（每会话独立进程）、普通消息、问答、指定命令与技能（含 plan/loop/goal）、临时切模型和 role 配置；优先复用上游行为 | RPC loop 排队重复/重置取消的局部回归、fastcheck 及真实 rpc-ui CLI 的对话阻塞后 abort/new_session 有限冒烟通过（localhost 模型 stub）；精确排队窗口仅回归覆盖，完整协议/fulltest/ZCode GUI 未整体验收 |

`/jch-workflowzbatch`（契约见 [JCH 命令](fork.md#jch-命令)，RPC 接入见 [ZCode 接入](rpc-ui-protocol.md#必须接入的命令)）：已实现；4 个参数边界回归通过，覆盖正文内 CRLF、代码行尾空格、连续空行、表格空白及字面量保留；真实 rpc-ui 命令入口回归 4 个通过，新增路径覆盖 v3 目录发现、使用补全文本提交、用户消息展开、上述正文保留及非法参数不启动模型或调用 Provider。Windows CLI → localhost HTTP Provider 的 workflowz 通知也已验证。未启动批处理子代理；真实模型遵守限制、200 项/30 并发执行及 TUI/ZCode GUI 未验收。本次未运行全仓检查或门禁。

每条需求只有一个权威维护位置。修改已有功能时更新对应文档；新独立功能域可新增文档并更新本表，不按篇幅机械拆分。跨功能关系通过链接表达，索引不复制具体条款。目录或权威体系缺失时先补齐，再修改实现。

各功能域的验证状态以本表为准；不得将静态检查、文档更新或先前工作树测试视为当前功能验收。只有相应验证实际通过，才可标记验收通过。

其他业务代码审查修复仅完成源码语义核对和限定修改文件的非测试检查；其测试、跨文件运行时行为及真实入口未验证。Goal 自动编排的本次专项验证见上表，不代表其他修复或完整门禁通过。
