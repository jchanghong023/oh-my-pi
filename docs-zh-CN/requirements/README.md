# Fork 需求目录

本目录是本项目唯一固定需求目录。开发规则见仓库根 `AGENTS.md`；本目录之外不存在其他需求来源。

| 文档 | 权威范围 | 状态 |
| --- | --- | --- |
| [Fork 定位、功能与默认值](fork.md) | 个人 fork 定位、三种使用场景与零配置目标、上游基线、个人模型与命令、文档检索、交互与默认值、分发、运行诊断日志与简薄验证编排 | 已补充 RPC/Goal、会话删除、team、JchTools、docs/wiki、repo、offline models/bench、WSL 预检关键日志，并脱敏公共 fatal 记录；本轮局部运行存在回归断言问题及既有上游 RPC plan fixture 失败，修正后按用户要求停止测试，未重跑，不能标记完整验收通过。先前 fastcheck 未通过且本轮未运行；fulltest/slowtest、真实 WSL/CI、公司实网和 ZCode GUI 未验收 |
| [三层本地门禁](fork.md#fork-验证体系) | fastcheck/fulltest/slowtest 的覆盖包含关系、非编译预算与计时、缓存、授权、固定提交 WSL、禁止 CI/桌面输入及验证状态 | 2026-10-11 当前 Windows fork-affected 源码快照：修复快速同尺寸重写归档后的旧目录缓存，既有 tools 测试 146 通过／1 跳过，独立运行时冒烟确认新目录及成员正文。随后完整 slowtest 内 fastcheck PASS（20.3 秒）、fulltest PASS（262.7 秒），覆盖 238 个 fork TS 测试文件、2992 个 Rust 测试通过（6 个跳过）、脚本测试 265 通过／15 跳过及真实 dev-TUI 冒烟，源码稳定性检查通过。slowtest 仍 FAIL（265.2 秒，exit=1）：未提交源码使 Ubuntu-24.04 WSL 阶段 BLOCKED，门禁不授权 commit/push，Linux 扩展未验证；不代表全仓库、真实模型或独立 CI 验收。Cargo 混合阶段完整编译排除仍未验证，本次 compile_excluded=0.0 秒 |
| [多模型方案讨论](team.md) | `/team` 的行为、集成约束与验收 | 已有综合资格与正文一致性的 64 个测试、API 冒烟及 fastcheck 通过记录；当前参与者作用域、远端能力拒绝和复核材料传递修复未运行测试或真实入口验证，整体验收与公司模型真实全流程待执行 |
| [Goal 自动编排](goal-auto-orchestrate.md) | `/goal-auto-orchestrate` 的命令与模式持久化、上游 Goal 正常历史消息链、首次通知及成功压缩后的完整目标／共享 Orchestrate 重构、构造去重与历史不变性、全过程授权与无人值守、持久化与 WebSocket／严格前缀验收 | 首次通知限定到创建／替换目标对应消息的实际提交，压缩恢复保持原边界；通知／压缩／排队及 JchTools 专项 68 例通过，真实 CLI 20 个场景通过，覆盖普通 Goal 对照、HTTP 与 Codex WebSocket 十轮严格前缀、两次压缩及生命周期。修改文件 lint／格式、coding-agent 类型检查通过，LSP 无错误；扩展 Goal／RPC 检查 66 通过、1 项既有 RPC plan fixture 失败，相关测试与 fixture 相对上游基线无改动，未修。未运行 fulltest/slowtest，完整 TUI／ZCode GUI、真实模型无人值守遵从、缓存命中、任务质量与账单未验证 |
| [代码定位索引](repo-index.md) | `/repo` 面板、`repo` 查询及索引生命周期 | AST 部分写入失败的局部回归与 Windows 真实 native 故障冒烟通过：保留原错误、刷新已改候选并持续 unchecked，完整核对后清除；fastcheck 通过；当前接口真实 TUI E2E 未验收，公司仓库/NFS/Linux 未验证 |
| [ZCode 接入](rpc-ui-protocol.md) | 保留 ZCode 界面框架与风格，经 OMP 使用多会话（每会话独立进程）、普通消息、问答、指定命令与技能（含 plan/loop/goal）、临时切模型和 role 配置；优先复用上游行为 | RPC loop 排队重复/重置取消的局部回归、fastcheck 及真实 rpc-ui CLI 的对话阻塞后 abort/new_session 有限冒烟通过（localhost 模型 stub）；精确排队窗口仅回归覆盖，完整协议/fulltest/ZCode GUI 未整体验收 |

`/jch-workflowzbatch`（契约见 [JCH 命令](fork.md#jch-命令)，RPC 接入见 [ZCode 接入](rpc-ui-protocol.md#必须接入的命令)）：已实现；4 个参数边界回归通过，覆盖正文内 CRLF、代码行尾空格、连续空行、表格空白及字面量保留；真实 rpc-ui 命令入口回归 4 个通过，新增路径覆盖 v3 目录发现、使用补全文本提交、用户消息展开、上述正文保留及非法参数不启动模型或调用 Provider。Windows CLI → localhost HTTP Provider 的 workflowz 通知也已验证。未启动批处理子代理；真实模型遵守限制、200 项/30 并发执行及 TUI/ZCode GUI 未验收。本次未运行全仓检查或门禁。

每条需求只有一个权威维护位置。修改已有功能时更新对应文档；新独立功能域可新增文档并更新本表，不按篇幅机械拆分。跨功能关系通过链接表达，索引不复制具体条款。目录或权威体系缺失时先补齐，再修改实现。

各功能域的验证状态以本表为准；不得将静态检查、文档更新或先前工作树测试视为当前功能验收。只有相应验证实际通过，才可标记验收通过。

其他业务代码审查修复仅完成源码语义核对和限定修改文件的非测试检查；其测试、跨文件运行时行为及真实入口未验证。Goal 自动编排的本次专项验证见上表，不代表其他修复或完整门禁通过。

Windows 安装器专项：Windows PowerShell 5.1 下 14 个用例通过，11 个 POSIX 用例按平台跳过；覆盖系统代理、显式环境代理优先级及下载回退的真实 HTTP 边界，以及校验失败、替换/回滚失败、PATH 部分完成、带单引号路径的可执行恢复/重试命令和运行中映像替换。真实 `install.ps1 -Binary` 入口已验证清空代理环境变量后经本机 Windows 系统代理下载 fork Release 并运行版本命令；实际文件锁故障非零退出、打印恢复指令、保留可运行下载且不损坏旧安装，临时 PATH 项已移除。未运行 fulltest/slowtest；PowerShell 7、另一台机器和 ZCode GUI 未验证。

Windows 运行时代理专项（installGlobalProxyFetch 系统代理回退）：`packages/ai` 代理相关 4 个测试文件 60 通过／1 平台跳过，覆盖 reg 输出解析（bare/per-protocol/ProxyEnable=0/socks-only）、安装与按 URL 注入、环境变量优先、`NO_PROXY` 与回环 bypass、per-request proxy 优先；本机（`ProxyEnable=1`、`ProxyServer=127.0.0.1:7890`、无代理环境变量）经真实读取与包装链路验证 https 请求注入 `http://127.0.0.1:7890`、`NO_PROXY` 命中不注入、显式 `HTTPS_PROXY` 优先于系统代理。fastcheck 通过（54.4 秒）。真实 LLM 出网、fulltest/slowtest 及 Linux/WSL 行为未验证。

零配置 TLS 默认（applyForkNetworkDefaults）：单测 3 例通过（未设→默认 `0`/`true`、显式 `NODE_TLS_REJECT_UNAUTHORIZED=1` 与 `GIT_SSL_NO_VERIFY=false` 保留）；本机自签证书真实链路验证默认生效（证书错误→200）、显式 `=1` 恢复严格校验。fastcheck 通过。CLI 主进程真实入口（TUI/RPC 全链路）、git 子进程继承与 fulltest/slowtest 未验证。

安装器 TLS 放宽专项（install.ps1）：`fork-installer-routing.test.ts` 26 用例中 Windows 侧 15 通过／11 POSIX 跳过，含新增自签证书 HTTPS 真实下载用例（curl `--insecure --ssl-no-revoke` 直接成功、不走 IWR 回退）与 PS 5.1 TLS 1.2/证书回调装接断言；既有代理三路径（system/environment/fallback）与替换/回滚/PATH 用例不回归。fastcheck 通过（25.5 秒）。PowerShell 7 真实 `-SkipCertificateCheck` 路径、真实公网下载与 fulltest/slowtest 未验证。

README CMD 安装命令：根 README 新增的 CMD 等价安装命令（curl 下载脚本 + `powershell -File` 执行）已在真实 cmd.exe 完整验证一次：隔离 `PI_INSTALL_DIR` 下解析最新 Release、自动经本机 Windows 系统代理下载二进制、安装成功 exit 0、`omp --version` 报告 `omp/18.9.2+fork.307`；验证后用户 PATH 已恢复原值、临时安装与配置目录已清理。PowerShell 5.1/7 的原有单行命令行为未变，未重复验证。
