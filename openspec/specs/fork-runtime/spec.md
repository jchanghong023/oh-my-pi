# fork-runtime

## Purpose

规定 fork 的安装、运行数据根、代理、诊断日志及 offline 场景行为。安装失败和日志故障应保留真实状态，运行路径和用户配置按显式输入解析。

## Requirements

### Requirement: 运行诊断日志

OMP MUST 按同一 operation_id 记录安全的阶段、结果与时长；offline 仅记录 ERROR，日志故障不掩盖业务结果。

#### Scenario: 运行诊断日志的详细边界

- **WHEN** 本节所述功能在适用条件下运行
- **THEN** 以下具体约束适用：

- fork 新增边界诊断覆盖写入统一 logger，不建立平行日志系统或新增必填配置。
- 异常、超时、重试、降级与部分提交等分支 MUST 留下可识别的阶段和结果；关键调用 MUST 记录安全的结果摘要及耗时。可能阻塞的调用、网络请求、IPC 和子进程 MUST 有开始与成功/失败/取消终态，不能仅依赖 UI、stdout/stderr、协议回包或会话 JSONL。
- fork 的业务边界诊断补充稳定事件、组件、阶段及 `elapsed_ms`，并随本地新增数据根路由到对应运行目录。
- 一个日志文件 MUST 仅属于一次进程运行；重启／重跑（包括 PID 被复用）MUST 创建新文件，NEVER 追加已有日志。遇到同名旧日志时沿用数字后缀选择未占用文件；目录、级别、日期／大小轮转、保留与刷新规则不变。
- fork 新增诊断不得将正常取消、服务缺席或协议预期拒绝冒充故障；必要诊断不得全部藏在可关闭的 DEBUG 中。
- 内网日志例外：`OMP_OFFLINE` 启用时仅记录 ERROR，优先于 `OMP_LOG_LEVEL`；WARN／INFO／DEBUG 在统一 logger 入口直接丢弃，不合并或序列化其上下文、不写本地日志，也不投递日志接收器。正常启动／退出不另写 INFO，日志回退不插入 WARN；真实 ERROR 仍沿用原目录、轮转与刷新。此项适用于全部 offline 平台，不改变界面提示、工具结果或协议输出；非 offline 保留原有级别与诊断覆盖。内网不再要求上文的正常阶段与成功起止日志，接受相应诊断缺口。
- 同一操作 MUST 通过 `operation_id` 及现有 request/job/goal/session/tool-call 标识关联起止和阶段；异步分支继承关联上下文，内部跨进程调用尽可能透传现有标识，不为日志改变外部协议。
- 对话终态须区分用户取消、本地/宿主超时、abort、断连和失败，独立响应仍继承发起操作的标识；后台面板吞掉的异常、已保存但 reload 降级、Goal 工具激活/恢复失败与无效持久状态不得被完成/协议成功日志遮盖。
- 会话删除须区分主文件删除、备份清理和附件清理，明确已提交、部分清理及未知状态；team 通知发送与后续 UI 更新分别定位，内部终止仅记录安全原因分类；repo 整代读取失败使用文件指纹定位，不记录原路径或源码。
- 离线 models/bench 的 cache-only 日志仅描述目录发现/刷新，不代表模型请求离线；初始化及后续 selector-miss 刷新保留起止关联。WSL helper 预检拒绝记录有界原因码，不复制 helper 输出正文。
- 凭据、Authorization/Cookie、URL 认证与敏感查询参数、用户输入、提示词、源码、文档/响应正文 MUST NOT 直接入日志。仅记录有界、脱敏的类型、代码、状态、计数、长度和必要栈帧；不得无限复制 stdout/stderr 或大对象。
- 日志目录不可写时 MUST 尝试合理的用户级目录回退；适用的 Linux offline shm 模式下，回退仍须限定在运行根内，不得转写原始持久根或其他磁盘目录。仍失败则向 stderr 有界报告日志初始化故障；日志失败不能递归、掩盖业务结果或使业务崩溃。启动/退出须可追踪并刷新关键记录。
- 本契约覆盖已保留的 fork 功能及其公共边界：JchTools、team、Goal、docs/wiki、repo/AST 通知、company 与向量请求、Codex 压缩、JCH Git、门禁和安装/更新；补日志不改变业务控制流、权限、重试次数或超时。验收包含真实入口的成功/失败、适用的网络与 IPC/子进程异常、关联重建及生成日志的敏感信息检查。

#### Scenario: 运行诊断日志的可观察行为

- **WHEN** 关键操作开始、结束或失败
- **THEN** 按同一 operation_id 记录安全的阶段、结果与时长；offline 仅记录 ERROR，日志故障不掩盖业务结果

### Requirement: 安装与运行

OMP MUST 按有效配置根、网络与安装边界运行；失败保留旧安装或已验证产物并如实报告。

#### Scenario: 安装与运行的详细边界

- **WHEN** 本节所述功能在适用条件下运行
- **THEN** 以下具体约束适用：

- 维护面向公司内网 Linux/tcsh 使用者的简洁[新手快速指南](../../../docs-zh-CN/quick-start-intranet.md)：最前面说明 `OMP_OFFLINE`、`OMP_CONFIG_ROOT` 与 `OMP_SKILLS_DIR`，随后说明先执行 `ma dmas_ide`、`ide agent` 启动 IDE 和模型代理，再覆盖常用终端命令、内置命令、快捷键及可复制的任务示例（含 `/loop`、`/goal`、`/team`、代码定位索引 `/repo`、`/advisor`，以及可直接携带任务文本的 `/ultrathink`、`/orchestrate`、`/workflowz`、`/fullsend`）。内容依据当前实现，明确循环/目标的停止方式及内网限制，不扩展为上游文档翻译或站点。
- fork 的日志目录与诊断覆盖遵循上文「运行诊断日志」，数据根遵循下述约定。
- fork 新增 `-P <name>` 作为 `--profile <name>` 的短参数，无需 shell alias。
- offline 模式只由环境变量 `OMP_OFFLINE` 触发（取值 `1`/`true`/`yes`/`on`，忽略大小写；未设置、空串、`0`/`false` 等其余值不触发），不存在 offline 命令行参数：环境变量对所有 omp 进程及其子进程一致生效，这是把触发入口统一到环境变量的原因（多进程数据根与 lane 状态不能因 spawn 透传遗漏而分裂）。
- `OMP_CONFIG_ROOT`（绝对路径，支持 `~` 展开；相对值被忽略）统一调整 OMP 原始数据根：agent 数据、Wiki／Repo 数据库、会话、日志、缓存、运行状态及 profiles 等目录沿用根下相对布局，项目级 `.omp/` 不受影响。未设置有效值时复用上游默认目录解析和目录名规则，不硬编码 `.omp`；与 `PI_CONFIG_DIR` 同时设置时由 `OMP_CONFIG_ROOT` 决定根位置。非 offline 时直接使用该根；适用的 offline shm 模式按下述契约区分运行根与原始持久根。
- **统一数据根**：删除 `OMP_WIKI_DIR` 环境变量的读取、路径优先级和专用透传，不保留兼容别名或专用 Wiki 目录配置项；环境中遗留该变量也不得影响路径。所有平台及 offline／非 offline 模式均只通过 `OMP_CONFIG_ROOT` 统一调整 OMP 数据根，Wiki 等子目录沿用 profile 内布局，不再单独指定活动目录或备份目标。此项是通用目录需求变更，不受下述 shm 功能的启用条件限制。
- **Broker native 生命周期**：broker 自有 native 缓存位于既有 scope runtime 的 `natives/` 下，随现有 profile／config root／项目（含 global service scope）身份隔离和 runtime 回收机制管理，不以创建者进程为所有者。一个 core 的显式 `PI_NATIVES_DIR` 仍用于该 core 及普通子 worker，但不约束可供其他 core 合法共享的 detached broker；不要求宿主永久保留其临时叶，不通过 `client.close()` 关闭共享 scope。Linux offline 继续使用既有 profile shm native 根。验收须实际加载 native、关闭 creator 并立即删除其独占叶（Windows 不出现 EPERM），另一已连接 client 仍能访问 broker，最后 client 关闭后通过 broker 正常退出释放自有缓存；两个独立 worker 同时冷提取／加载完整 DLL，发布后内容不变且无 staging 残留。

- `OMP_OFFLINE` 进程中若未设置 `FS_SCAN_CACHE_TTL_MS`，进程内设为 `30000` 毫秒；该变量只影响 `@` 文件补全的目录重扫间隔，非 offline 进程完全不变，用户显式设置的值（含 `0`）优先。
- **内网交互减负**：仅 Linux offline 将普通后台 TUI 重绘合并到最多 10 FPS；输入回显与取消沿用原输入优先调度，强制最终刷新、终端输出反压与自适应限速不变。品牌渐变刷新降为 250ms，活动计时装饰刷新降为 1000ms。Git 状态缓存由普通模式的 10 秒延长到 60 秒，沿用 HEAD／工作目录／显式失效；未显式失效的外部工作树修改可能延后显示，不新增工具修改通知或修改 Git 配置。非 Linux 和非 offline 保持原行为，不要求改变企业远程软件，不预先承诺公司实机提速。
- **内网运行期显示减负**：所有 `OMP_OFFLINE` 进程将现有累计流式更新合并窗口从普通模式的 50ms 调为 100ms，沿用结束／取消等边界事件立即冲刷、逐增量语音及实时思考阶段处理，不改变输入与终端绘制调度；进程内覆盖 `tui.autoGraph=off`、`tui.titleState=false`、`title.refreshOnReplan=false`，优先于已保存设置且不写配置。保留原始表格、首次 scout 自动标题、手动命名及单词／文件／路径／命令补全；SVG／Mermaid／图片、Markdown 缓存、历史裁剪、LSP 与 MCP 不变。非 offline 保留原合并窗口及配置行为。
- `OMP_OFFLINE=1` 以无公网模式启动本次进程：临时把 `web_search.enabled`、`browser.enabled`、`astEdit.enabled`、`fetch.enabled` 关为 `false`，所有 `company` 聊天模型的 `contextWindow` 设为 `200000`（不改 `maxTokens`）。这些启动覆盖优先于已保存配置，不写配置文件，退出即消失，普通启动保持原值。Python Eval 的解释器优先级为显式 `python.interpreter` → Linux offline 固定候选 `/software/public/python/3.11.4/bin/python3.11` → 原有自动候选，并补查 PATH 中的版本化 `python3.15` 至 `python3.11`、`python3` 和 `python`；同一路径不重复探测。Linux offline 复用统一的 `OMP_OFFLINE` 真值判断（`1`、`true`、`yes`、`on`，忽略大小写及首尾空白），所有候选均实际检查 Python ≥3.11，旧业务 Python 3.6 或 3.10 不可成为 Eval 解释器；找不到合适版本时明确失败，不降级。显式解释器不可用或不兼容时不 fallback；固定候选缺失或不适合时继续查找，不因 PATH 中已有旧 `python` 而停止。其他平台或非 offline 进程保留原有候选和 Python 3.8+ 门槛。新发现的系统解释器只用于 OMP Eval 子进程，清除其继承的业务 venv／Conda／PYTHONPATH，不修改主进程 PATH、项目虚拟环境或业务 Python，不扫描软件目录找版本、不安装包。系统提示词仍追加“当前处于 offline 模式，环境无公网。不要尝试访问公网；使用本地资源和公司内部服务。”。公司内部模型 API、bash/eval、本地文件、LSP、本地 Git、Computer Use 等能力仍可用。
- offline 且 company provider 可用时，仅为未配置的 model role 补充当前进程默认值：`default`、`task`、`vision`、`advisor` → `company/Qwen3.8-27B`；`smol`、`tiny`、`commit` → `company/Qwen3.6-35B-A3B`；`plan`、`slow` → `company/GLM-5.2-public`。已有角色配置（包括显式 `null` 清除项）和显式 CLI 模型参数仍优先，不写配置文件，不限制 `/model`、`Ctrl+T` 或角色切换，也不锁定 company。保存、活动匹配与切换冲突比较统一排除这些隐式默认角色，不误报刚保存的 preset 与公司默认值冲突；用户显式配置或 CLI 选择的角色仍按原规则保存和比较，包括显式选择的 company 模型。普通启动不受影响。
- offline 当前进程将 `startup.setupWizard` 覆盖为 `false`，不自动弹出或导入首次启动的全屏配置向导；显式启用的启动动画按需独立加载，手动设置入口保持原有行为。
- offline 启动不检查 OMP 新版本、不自动检查或更新插件市场、不读取或展示启动更新日志，也不触发在线模型目录发现——含交互界面就绪后的后台发现，以及会话恢复、默认角色解析、prewalk 目标解析和 `enabledModels`/`--models` scope 预解析里的 discovery fallback（这些路径只用本地缓存，缓存缺失时按既有链路降级，不发目录发现请求）。同进程 task 子代理的新建与恢复也继承该限制；遗漏调用方即使请求 online 目录刷新也须受进程 offline 策略约束。已安装插件、内置和缓存模型照常加载；显式 `--model` 仍可选择模型，手动模型刷新同样只用缓存，实际模型／OAuth 请求及显式更新命令、`/changelog` 的其他行为不变。上述覆盖只在当前进程生效，不写配置文件，非 offline 启动不受影响。

以下是现有个人分发能力，不代表对外发布目标；上游同步不触发构建或发布。

- 个人 Release 版本使用 `+fork.N`，仅从本仓库 `main` 通过手动 CI 生成；手动运行默认只构建可下载的二进制 artifact（`publish_release=false`），明确启用发布后才创建 Release，非 `main` 分支不能发布。CI 永久只承担构建、产物汇总与发布，不运行测试、冒烟、lint、类型检查或独立校验作业；发布只等待版本元数据与全部二进制构建成功，不承担本地验收门禁。发布须单独明确授权，`bun run slowtest` 仅做本机及适用 WSL 本地验证，NEVER 自动推送、触发/等待 CI 或创建 Release。`N` 取 `.github/workflows/ci.yml` 工作流的 `run_number`，GitHub 按工作流文件路径维护计数，重命名或删除重建该文件会让 `N` 从 1 重新开始（与历史 tag 撞号、旧安装收不到后续更新），NEVER 这样做。
- 构建发布 CI 安装 native 产物时显式跳过宿主 addon 的加载探测（`--skip-load-probe`），仍执行构建所需的版本戳写入；该选项不改变本地构建/安装默认执行加载探测的行为。
- 构建发布 CI 使用 GitHub 原生缓存保存 Bazel action cache、依赖下载及 Cargo registry/git；无需自建缓存服务器或额外凭据。各 native target 独立恢复与保存缓存，键包含宿主平台、目标、工具链/构建配置及 native 源码指纹；源码变化时可恢复同配置的旧缓存，由 Bazel 判断哪些 action 可复用。缓存缺失或被 GitHub 淘汰时正常冷编译，不跳过构建。
- 二进制必须携带 fork 版本、构建时间和更新仓库信息。
- 本地构建脚本 `packages/coding-agent/scripts/build-binary.ts` 同样注入本 fork 更新仓库：本地构建产物的 `omp update` 指向本 fork Release，不会回退官方渠道（版本号不注入，`--version` 无 `+fork.N` 后缀属预期）。
- `omp update` 先比较正常 SemVer，再比较同基线的 fork build counter；本地构建未带 `+fork.N` 时按 counter 0 比较，因此可取得同基线的新 fork Release，而不把更高上游基线降级。支持 `%2B` 编码的 `+` 版本 URL；GitHub 元数据和资产统一优先环境令牌，再尝试本机 `gh auth token`，无凭据才匿名请求。
- `omp update` 下载二进制时，在交互终端显示下载百分比、速度与预计剩余时间；非 TTY 输出（如 CI、管道）不显示动态进度。若 `PATH` 中的 `omp` 与更新目标解析为不同文件，更新前警告并提示更新后运行 `omp --version` 核对实际生效的版本；指向同一文件的符号链接不视为冲突。
- `update.channel=canary` 在 fork 二进制上不可用：启动版本检查会提示该配置并指向 `omp update --stable`；其余更新检查失败仍静默。
- `-fork.N` 时代（fork build ≤ 35，2026-08-26 及更早）的旧安装内嵌只认 `vX.Y.Z-fork.N` 的校验，会拒绝此后所有 `+fork.N` Release（报 `Invalid fork release tag`）且无法自愈，只能用安装器重装后再交给 `omp update`。
- 发布链路不发布核心或平台 npm 包，也不发布 Homebrew tap；Release notes 由 GitHub 自动生成。发布物为 Linux x64/arm64（各含 glibc 与 musl）和 Windows x64 二进制、`omp-browser-relay-extension.zip`、`LICENSE`、`THIRD-PARTY-NOTICES.txt`、`SHA256SUMS.txt`；不构建 macOS 或 Windows arm64 二进制。
- 安装器只安装 fork Release 的预编译二进制：Linux x64/arm64、Windows x64；`install.sh` 在 macOS 上于联网前明确拒绝安装。安装目标已是所选 Release 版本时提示已安装并跳过下载，同时仍检查 PATH 配置。
- Windows 安装与更新不要求额外安装 PowerShell 7：安装器必须能在系统自带的 Windows PowerShell 5.1 x64 下直接执行；`omp update` 使用自身 HTTP 下载、SHA-256 校验和二进制替换链路，不依赖 `pwsh.exe`，不得要求用户升级 PowerShell 来绕过兼容问题。
- 两个平台的安装器都下载到安装目录中的唯一临时文件，先确认可启动且 `omp --version` 与所选 Release 完全一致，再替换现有安装；验证失败保留旧安装并清理临时文件。可执行目标是目录时联网前拒绝，不移动目录内容；已经是所选版本时跳过下载但仍提示 PATH。Windows 优先 `curl.exe`；未设置目标协议的代理环境变量及 `ALL_PROXY` 时，自动解析当前用户的 Windows 系统代理并传给 curl，不要求额外设置环境变量。显式代理环境变量优先，curl 遵循 `NO_PROXY`；curl 失败或不可用时仍回退兼容 PowerShell 5.1 的 `Invoke-WebRequest -UseBasicParsing`。安装器只维护 PATH，不写废弃的 settings.json 或擅自改用户 shell/config.yml。安装器自身的全部 Web 请求（Release 元数据与二进制下载）默认放宽 TLS 校验，与运行时零配置姿态一致：curl 追加 `--insecure`，Windows 安装器另加 `--ssl-no-revoke`；POSIX 安装器仅在 curl 使用 Schannel 且版本支持时追加 `--ssl-no-revoke`（Schannel 吊销检查在拦截代理后常失败），不向旧版或其他 TLS 后端传入该选项。PowerShell 5.1 启用 TLS 1.2 并挂接放行证书回调，PowerShell 7+ 对 `Invoke-RestMethod`/`Invoke-WebRequest` 传 `-SkipCertificateCheck`；下载完整性仍由装后 `omp --version` 与所选 Release 完全一致的校验兜底。
- 运行时代理与安装器同序：Windows 主进程内所有经全局 `fetch` 的出网请求（含 LLM 流、OAuth/usage 探测、模型发现、更新检查与 web 请求）按「请求自带显式 `proxy`（`PI_PROXY_<PROVIDER>`/`PI_PROXY`）→ 标准代理环境变量（`HTTPS_PROXY`/`HTTP_PROXY`/`ALL_PROXY`，Bun 原生应用）→ 当前用户 Windows 系统代理 → 直连」解析。系统代理仅取 HKCU Internet Settings 的静态 `ProxyEnable`/`ProxyServer`（含 `http=`/`https=` per-protocol 形式，`socks=` 条目与 PAC/WPAD 不支持），每进程读取一次并缓存；未启用或读取失败时行为与无此改动一致。`NO_PROXY` 与回环/内网硬 bypass 同样约束系统代理。仅 win32 生效；worker 子进程入口（本地服务）不经此链路。系统代理层另有 fork 内网绕行清单（`packages/ai` proxy.ts 的 `FORK_SYSTEM_PROXY_BYPASS`，抄自公司代理 override 清单）：公司域名后缀、点名内网主机、CGNAT/RFC1918 式 IP 前缀（`10.`、`100.64.`–`100.126.`、`172.16.`–`172.32.`、`7.` 等）与 `*` 通配条目命中的目标不走系统代理、直连；清单只约束系统代理层，不约束 `PI_PROXY` 与环境变量代理（它们的绕行机制仍是 `NO_PROXY`）。条目语义与来源格式对应：前导 `-` 剥离、数字开头为 IP 前缀、含 `*` 为整机名 glob、首尾皆点为点号标签包含、仅前导点为域名后缀、其余为精确或点后缀。
- 零配置 TLS 默认：主进程网络引导时，未显式设置即默认 `NODE_TLS_REJECT_UNAUTHORIZED=0`（Bun fetch 认可，覆盖全部 fetch 请求的证书验证）与 `GIT_SSL_NO_VERIFY=true`（主进程拉起的 git 子进程继承），使拦截代理/私有网关的自有根证书场景免配置可用。显式设置的值均优先于此默认，不被改写；`NODE_TLS_REJECT_UNAUTHORIZED=1` 与 `GIT_SSL_NO_VERIFY=false` 分别恢复对应的严格校验，显式 `0`／`true` 则仍放宽对应校验。agent 目录 `.env` 同样先于此默认生效；worker 子进程入口不经此默认。这是个人 fork 的安全姿态取舍：采用该放宽默认时，TLS 不再验证端点身份，凭据在可劫持网络下有被截获风险，仅在个人受控环境接受。
- 安装器替换目标二进制时不中断运行中的 omp：Linux 用同目录原子 `mv`；Windows 先把旧 `omp.exe` 重命名到唯一的 `.omp.old.*` 再换入（换入失败自动回滚），仅当重命名失败（如杀软锁定）才回退为按安装路径精确匹配强杀，`.omp.old.*` 残留由下次安装尽力清扫。Windows 的已验证下载在替换失败时保留为 `.omp.tmp.*`，包括旧安装已成功回滚的情况；回滚失败同时保留旧映像供恢复。
- Windows 下载成功后，校验、旧映像重命名/强杀回退、换入、回滚或 PATH 设置失败，MUST 打印失败阶段、原始错误、错误类型/代码、安装目标及可用的诊断日志路径，并输出正确引用路径的可执行 PowerShell 命令：未通过验证的二进制不能引导运行；已验证的保留下载可直接启动；旧映像恢复只在目标不存在时执行；重试固定本次 Release 与安装目录，最后核对目标文件及 PATH 命中的版本。二进制已换入但 PATH 设置失败时明确标为部分完成，不能提前报告安装成功。非致命清理失败须说明具体错误和安全重试命令；仍被旧会话占用的映像可留待会话退出后清理，不影响新版安装结果。详细错误仅向终端展示，落盘日志继续遵循脱敏契约。


#### Scenario: 安装与运行的可观察行为

- **WHEN** 用户在普通或 offline 场景安装、启动或更新
- **THEN** 按有效配置根、网络与安装边界运行；失败保留旧安装或已验证产物并如实报告
