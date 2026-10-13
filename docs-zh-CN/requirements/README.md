# Fork 需求目录

本目录是本项目唯一固定需求目录。开发规则见仓库根 `AGENTS.md`；本目录之外不存在其他需求来源。

| 文档 | 权威范围 | 状态 |
| --- | --- | --- |
| [Fork 定位、功能与默认值](fork.md) | 个人 fork 定位、三种使用场景与零配置目标、上游基线、个人模型与命令、文档检索、交互与默认值、分发、运行诊断日志与简薄验证编排 | 既有批次审查修复已通过下列 Windows／Ubuntu-24.04 同提交 fork-affected 门禁；相关静态检查、差异测试和真实 dev-TUI 边界已有验证证据。文档索引最新审查修复的验证状态见该域行；公司实网、真实模型、ZCode GUI、独立发布与全仓库覆盖不属于本地通过结论 |
| [会话工作树切换](fork.md#wt-会话工作树) | `/wt` 与 `/worktree` 的分支复用、目录位置及源目录改动保留契约 | 实现与现有回归已按契约更新；11 个受影响 TS 文件的 Bun 语法／转译检查通过。针对性回归与真实 CLI ACP 冒烟在启动时因缺少本地 native addon 受阻，类型检查缺少 `tsgo`，lint／格式检查工具不可用；功能未验收，未运行完整门禁 |
| [Markdown 文档索引](fork.md#markdown-文档索引) | `/wiki` 与 `wiki` 的技术相关性、完整名称证据、DB-only 连续分页与引用、非阻塞／可取消查询与完整排名复用、成功搜索时长下限、正常零命中及错误边界 | 本轮 Windows 专项验证通过：10 个相关测试文件 146 通过／5 跳过，fastcheck 通过（37.1 秒），LSP 无错误。指定 19 份 Markdown／139549 节的数据库验收：直接 MBIST 判据排名 1、泛化清单排名 190；全部 919 个文件名命中经 443 工具页到达，15 个完整名称及 904 个相关章节、正文和全部引用逐项核验，无遗漏／重复，169 个超长首节页与 28 个重复正文指针可达；源目录读取尝试为 0，数据库未改变。452 次成功搜索最短 500.886ms；实际查询期间 220 次心跳、最大间隔 38.5ms，缓存查询数据库工作 7.13ms，下限等待单独记录，等待取消后 1.53ms 内拒绝。真实 dev-TUI 验证昂贵查询中 Esc 取消、输入响应、自然语言首屏、名称翻页、打开存储引用／正文及返回，正常退出且零模型请求；真实 CLI 工具派发通过。当前 fulltest 与编译二进制验收待执行；Linux／WSL、真实模型质量及全项目覆盖未验收 |
| [三层本地门禁](fork.md#fork-验证体系) | fastcheck/fulltest/slowtest 的覆盖包含关系、非编译预算与计时、缓存、授权、固定提交 WSL、禁止 CI/桌面输入及验证状态 | 验收提交 `ef5b8dd1d9`：Windows 与 Ubuntu-24.04 WSL2 同提交 slowtest 通过，两端各 262 个 fork TS 测试文件；Windows Rust 3135 通过／6 跳过、Linux Rust 3474 通过／6 跳过；脚本测试分别 277 通过／15 跳过、274 通过／18 跳过。全部 fastcheck 检查、native 构建与真实 dev-TUI 的基础、team 运行／取消、repo 链路通过；Windows fulltest 341.5 秒、Linux fulltest 304.7 秒，slowtest PASS，344.8 秒，exit=0，固定 SHA 与源码稳定性通过。范围为 fork-affected；混合 Cargo 编译排除未完整观测，保守计费，compile_excluded=0.0 秒 |
| [多模型方案讨论](team.md) | `/team` 的行为、集成约束与验收 | 本批修复已随 fork-affected 测试集合通过；Windows／Linux 真实 dev-TUI 的 localhost 模型 stub 五阶段、持久报告和取消链路通过。公司真实模型的完整讨论、模型遵从与最终方案质量未验收 |
| [Goal 自动编排](goal-auto-orchestrate.md) | `/goal-auto-orchestrate` 的命令与模式持久化、上游 Goal 正常历史消息链、首次通知及成功压缩后的完整目标／共享 Orchestrate 重构、构造去重与历史不变性、全过程授权与无人值守、持久化与 WebSocket／严格前缀验收 | 通知／压缩／排队及 JchTools 专项 68 例、真实 CLI 20 个场景已有通过证据，覆盖普通 Goal 对照、HTTP 与 Codex WebSocket 十轮严格前缀、两次压缩及生命周期。本批 fork-affected 静态检查及 fulltest／slowtest 通过；该范围不代表完整上游测试套件，既有上游原样 RPC plan fixture 的独立失败未复验。完整 Goal TUI／ZCode GUI、真实模型无人值守遵从、缓存命中、任务质量与账单未验证 |
| [代码定位索引](repo-index.md) | `/repo` 面板、`repo` 查询及索引生命周期 | AST 部分写入失败的局部回归与 Windows 真实 native 故障冒烟已有通过证据；本批 Windows／Linux 真实 TUI 的 build／status／reconcile／cancel／delete、native-backed tool 查询和源文件编辑链路通过。公司实际仓库、NFS 和规模性能未验证 |
| [ZCode 接入](rpc-ui-protocol.md) | 保留 ZCode 界面框架与风格，经 OMP 使用多会话（每会话独立进程）、普通消息、问答、指定命令与技能（含 plan/loop/goal）、临时切模型和 role 配置；优先复用上游行为 | RPC loop 排队重复／重置取消回归及真实 rpc-ui CLI 的对话阻塞后 abort／new_session 有限冒烟已有通过证据（localhost 模型 stub）；本批 fork-affected 静态检查及 fulltest／slowtest 通过。精确排队窗口仅回归覆盖，完整协议与 ZCode GUI 未整体验收 |

`/jch-workflowzbatch`（契约见 [JCH 命令](fork.md#jch-命令)，RPC 接入见 [ZCode 接入](rpc-ui-protocol.md#必须接入的命令)）：已实现；4 个参数边界回归通过，覆盖正文内 CRLF、代码行尾空格、连续空行、表格空白及字面量保留；真实 rpc-ui 命令入口回归 4 个通过，新增路径覆盖 v3 目录发现、使用补全文本提交、用户消息展开、上述正文保留及非法参数不启动模型或调用 Provider。Windows CLI → localhost HTTP Provider 的 workflowz 通知也已验证。未启动批处理子代理；真实模型遵守限制、200 项/30 并发执行及 TUI/ZCode GUI 未验收。本次未运行全仓检查或门禁。

每条需求只有一个权威维护位置。修改已有功能时更新对应文档；新独立功能域可新增文档并更新本表，不按篇幅机械拆分。跨功能关系通过链接表达，索引不复制具体条款。目录或权威体系缺失时先补齐，再修改实现。

各功能域的验证状态以本表为准；不得将静态检查、文档更新或先前工作树测试视为当前功能验收。只有相应验证实际通过，才可标记验收通过。

补充验证：显式继承 `OMP_CONFIG_ROOT` 的 YAML／native 目录三个回归文件 15 例通过；捕获流两个回归文件 106 例及真实 CLI 的 stdout／stderr 流式捕获和去重冒烟通过。实际 WSL 输出在执行期间转发，超时／首个失败取消不再丢失已输出诊断；最终判据仍使用完整捕获的固定 SHA、工作树、退出码与活动事件，不把门禁自测中的模拟 WSL PASS 当作 Linux 验收。

Windows 安装器专项：Windows PowerShell 5.1 下 14 个用例通过，11 个 POSIX 用例按平台跳过；覆盖系统代理、显式环境代理优先级及下载回退的真实 HTTP 边界，以及校验失败、替换/回滚失败、PATH 部分完成、带单引号路径的可执行恢复/重试命令和运行中映像替换。真实 `install.ps1 -Binary` 入口已验证清空代理环境变量后经本机 Windows 系统代理下载 fork Release 并运行版本命令；实际文件锁故障非零退出、打印恢复指令、保留可运行下载且不损坏旧安装，临时 PATH 项已移除。未运行 fulltest/slowtest；PowerShell 7、另一台机器和 ZCode GUI 未验证。

Windows 运行时代理专项（installGlobalProxyFetch 系统代理回退）：`packages/ai` 代理相关 4 个测试文件 60 通过／1 平台跳过，覆盖 reg 输出解析（bare/per-protocol/ProxyEnable=0/socks-only）、安装与按 URL 注入、环境变量优先、`NO_PROXY` 与回环 bypass、per-request proxy 优先；本机（`ProxyEnable=1`、`ProxyServer=127.0.0.1:7890`、无代理环境变量）经真实读取与包装链路验证 https 请求注入 `http://127.0.0.1:7890`、`NO_PROXY` 命中不注入、显式 `HTTPS_PROXY` 优先于系统代理。fastcheck 通过（54.4 秒）。真实 LLM 出网、fulltest/slowtest 及 Linux/WSL 行为未验证。

零配置 TLS 默认（applyForkNetworkDefaults）：单测 3 例通过（未设→默认 `0`/`true`、显式 `NODE_TLS_REJECT_UNAUTHORIZED=1` 与 `GIT_SSL_NO_VERIFY=false` 保留）；本机自签证书真实链路验证默认生效（证书错误→200）、显式 `=1` 恢复严格校验。fastcheck 通过。CLI 主进程真实入口（TUI/RPC 全链路）、git 子进程继承与 fulltest/slowtest 未验证。

安装器 TLS 放宽专项（install.ps1）：`fork-installer-routing.test.ts` 26 用例中 Windows 侧 15 通过／11 POSIX 跳过，含新增自签证书 HTTPS 真实下载用例（curl `--insecure --ssl-no-revoke` 直接成功、不走 IWR 回退）与 PS 5.1 TLS 1.2/证书回调装接断言；既有代理三路径（system/environment/fallback）与替换/回滚/PATH 用例不回归。fastcheck 通过（25.5 秒）。PowerShell 7 真实 `-SkipCertificateCheck` 路径、真实公网下载与 fulltest/slowtest 未验证。

README CMD 安装命令：根 README 新增的 CMD 等价安装命令（curl 下载脚本 + `powershell -File` 执行）已在真实 cmd.exe 完整验证一次：隔离 `PI_INSTALL_DIR` 下解析最新 Release、自动经本机 Windows 系统代理下载二进制、安装成功 exit 0、`omp --version` 报告 `omp/18.9.2+fork.307`；验证后用户 PATH 已恢复原值、临时安装与配置目录已清理。PowerShell 5.1/7 的原有单行命令行为未变，未重复验证。

CodeAgent 认证专项：当前用户 DPAPI 合成密文经真实 JchTools 独立后台写入隔离原生 `REG_SZ`，真实 OMP CLI 无手工模型／认证配置完成旧 Token 失败、后台轮换、唯一重试、实际 read 工具执行及最终回答；认证比较仅在内存进行，输出和日志无 Token。OMP 认证、压缩、handoff、恢复及普通模型回归 203 通过／4 跳过，修复前已复现空注册表值破坏缓存及摘要／handoff 外层重放。JchTools 原生后台与 GUI TestingBackend 回调验证通过，SQLite 争用期间维持同一实例；共享桌面和真实 CodeAgent 服务尚未验证（本机缺少真实凭据）。

系统代理内网绕行清单：`proxy.test.ts` 61 例通过（新增匹配器 3 例：公司域名后缀/点名主机/点号标签包含命中、IP 前缀与 glob 命中且公网邻近段不误伤、无关公网主机不命中；安装行为 1 例：公网 URL 注入系统代理、内网域名/IP 目标不注入）；fastcheck 通过。真实内网目标连通性与 fulltest/slowtest 未验证。

输入框路径宽度专项：状态栏溢出与上下文回归 46 例通过；真实 `bun run dev` ConPTY 验证 80 列路径恢复到配置上限、42 列按实际剩余宽度截断、再扩至 80 列恢复，上下文标签靠右且正常退出。使用隔离配置和本地模型定义，未发模型请求；未运行 fulltest/slowtest，Linux/WSL 未验证。

文档检索的当前行为统一以[Markdown 文档索引契约](fork.md#markdown-文档索引)为准，实施与验收状态见上表；隔离验收 profile 为 `wiki-acceptance`、索引为 `acceptance-mds`。原导入数据库保留在本地忽略目录 `node_modules/.cache/wiki-acceptance-20261014/`，本轮完整数据库验收报告为 `node_modules/.cache/wiki-fix-20261014/database-acceptance-report.json`，真实 UI 证据在该目录的 `public-source-*` 子目录；不提交原始验收材料或派生正文。
