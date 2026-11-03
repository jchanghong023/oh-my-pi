# fork-runtime

## Purpose

规定 fork 的安装、运行数据根、代理、诊断日志及 offline 场景行为。安装失败和日志故障应保留真实状态，运行路径和用户配置按显式输入解析。

## Requirements

### Requirement: 运行诊断日志

OMP MUST 按同一 operation_id 记录安全的阶段、结果与时长；offline 默认记录 WARN／ERROR，允许显式调整级别，日志故障不掩盖业务结果。

#### Scenario: 运行诊断日志的详细边界

- **WHEN** 本节所述功能在适用条件下运行
- **THEN** 以下具体约束适用：

- fork 新增边界诊断覆盖写入统一 logger，不建立平行日志系统或新增必填配置。
- 异常、超时、重试、降级与部分提交等分支 MUST 留下可识别的阶段和结果；关键调用 MUST 记录安全的结果摘要及耗时。可能阻塞的调用、网络请求、IPC 和子进程 MUST 有开始与成功/失败/取消终态，不能仅依赖 UI、stdout/stderr、协议回包或会话 JSONL。
- fork 的业务边界诊断补充稳定事件、组件、阶段及 `elapsed_ms`；选择性能数据根时按「可选性能数据根」使用相应日志位置，否则沿用既有路由。
- 一个日志文件 MUST 仅属于一次进程运行；重启／重跑（包括 PID 被复用）MUST 创建新文件，NEVER 追加已有日志。遇到同名旧日志时沿用数字后缀选择未占用文件；除本次双目录调整日志位置外，级别、日期／大小轮转、保留与刷新规则不变。
- fork 新增诊断不得将正常取消、服务缺席或协议预期拒绝冒充故障；必要诊断不得全部藏在可关闭的 DEBUG 中。
- 内网日志例外：`OMP_OFFLINE` 启用时默认记录 WARN／ERROR，保留故障、降级与日志目录回退线索；显式有效的 `OMP_LOG_LEVEL` 优先，可选择 `error`／`warn`／`info`／`debug`，空值或无效值使用 offline 默认级别。超过所选级别的记录在统一 logger 入口直接丢弃，不合并或序列化其上下文、不写本地或控制台日志，也不投递日志接收器。默认不另写正常启动／退出 INFO；显式启用 INFO／DEBUG 时恢复既有阶段与起止诊断。日志目录、轮转与刷新规则不变，WARN／ERROR 立即刷新。此项适用于全部 offline 平台，不改变界面提示、工具结果或协议输出；非 offline 保留原有级别与诊断覆盖。默认级别下正常阶段与成功起止日志仍不保留，空日志不代表没有未记录的问题。
- 同一操作 MUST 通过 `operation_id` 及现有 request/job/goal/session/tool-call 标识关联起止和阶段；异步分支继承关联上下文，内部跨进程调用尽可能透传现有标识，不为日志改变外部协议。
- 对话终态须区分用户取消、本地/宿主超时、abort、断连和失败，独立响应仍继承发起操作的标识；后台面板吞掉的异常、已保存但 reload 降级、Goal 工具激活/恢复失败与无效持久状态不得被完成/协议成功日志遮盖。
- 会话删除须区分主文件删除、备份清理和附件清理，明确已提交、部分清理及未知状态；team 通知发送与后续 UI 更新分别定位，内部终止仅记录安全原因分类；repo 整代读取失败使用文件指纹定位，不记录原路径或源码。
- 离线 models/bench 的 cache-only 日志仅描述目录发现/刷新，不代表模型请求离线；初始化及后续 selector-miss 刷新保留起止关联。WSL helper 预检拒绝记录有界原因码，不复制 helper 输出正文。
- 凭据、Authorization/Cookie、URL 认证与敏感查询参数、用户输入、提示词、源码、文档/响应正文 MUST NOT 直接入日志。仅记录有界、脱敏的类型、代码、状态、计数、长度和必要栈帧；不得无限复制 stdout/stderr 或大对象。
- 日志目录不可写时 MUST 尝试合理的用户级目录回退；仍失败则向 stderr 有界报告日志初始化故障；日志失败不能递归、掩盖业务结果或使业务崩溃。启动/退出须可追踪并刷新关键记录。
- 本契约覆盖已保留的 fork 功能及其公共边界：team、Goal、knowledge、repo/AST 通知、company 与向量请求、门禁和安装/更新；补日志不改变业务控制流、权限、重试次数或超时。验收包含真实入口的成功/失败、适用的网络与 IPC/子进程异常、关联重建及生成日志的敏感信息检查。

#### Scenario: 运行诊断日志的可观察行为

- **WHEN** 关键操作开始、结束或失败
- **THEN** 按同一 operation_id 记录安全的阶段、结果与时长；offline 默认记录 WARN／ERROR，尊重显式日志级别，日志故障不掩盖业务结果

### Requirement: 安装与运行

OMP MUST 按有效持久根、性能目录、网络与安装边界运行；失败保留旧安装或已验证产物并如实报告。

#### Scenario: 安装与运行的详细边界

- **WHEN** 本节所述功能在适用条件下运行
- **THEN** 以下具体约束适用：

- 维护面向公司内网 Linux/tcsh 使用者的简洁[新手快速指南](../../../docs-zh-CN/quick-start-intranet.md)：最前面说明 `OMP_OFFLINE`、`OMP_CONFIG_ROOT`、`OMP_CACHE_DIR` 与 `OMP_SKILLS_DIR`，说明持久和性能数据、Linux offline 的 `/dev/shm/omp-<UID>` 缺省与缓存易失性，随后说明先执行 `ma dmas_ide`、`ide agent` 启动 IDE 和模型代理，再覆盖常用终端命令、内置命令、快捷键及可复制的任务示例（含 `/loop`、`/goal`、`/team`、代码定位索引 `/repo`、`/advisor`，以及可直接携带任务文本的 `/ultrathink`、`/orchestrate`、`/workflowz`）。内容依据当前实现，明确循环/目标的停止方式及内网限制，不扩展为上游文档翻译或站点。
- fork 的日志目录与诊断覆盖遵循上文「运行诊断日志」，数据根遵循下述约定。
- fork 新增 `-P <name>` 作为 `--profile <name>` 的短参数，无需 shell alias。
- offline 模式只由环境变量 `OMP_OFFLINE` 触发（取值 `1`/`true`/`yes`/`on`，忽略大小写；未设置、空串、`0`/`false` 等其余值不触发），不存在 offline 命令行参数：环境变量对所有 omp 进程及其子进程一致生效，这是把触发入口统一到环境变量的原因（多进程数据根与 lane 状态不能因 spawn 透传遗漏而分裂）。
- `OMP_CONFIG_ROOT`（绝对路径，支持 `~` 展开；相对值被忽略）统一调整 OMP 持久数据根：agent 配置与认证、Knowledge／Repo 数据库及索引、会话、用户资源和未列入性能目录的运行状态及 profiles 沿用根下相对布局，项目级 `.omp/` 不受影响。全部既有 Cache、统计、日志和默认 native 按「可选性能数据根」使用所选性能根；未启用分离时维持原路径。未设置有效 `OMP_CONFIG_ROOT` 时复用上游默认目录解析和目录名规则，不硬编码 `.omp`；与 `PI_CONFIG_DIR` 同时设置时由 `OMP_CONFIG_ROOT` 决定持久根位置。
- native addon 加载器与 grammar 安装器 MUST 使用同一有效目录及 profile 解析；默认 native 和 grammar 缓存按「可选性能数据根」选择位置。显式有效 `PI_NATIVES_DIR` 优先于默认 native 目录，其既有语义不变；本规则不改变 `OMP_CONFIG_ROOT` 或 profile 的既有语义。
- **统一持久数据根与独立性能目录**：删除 `OMP_WIKI_DIR` 环境变量的读取、路径优先级和专用透传，不保留兼容别名或专用 Wiki 目录配置项；环境中遗留该变量也不得影响路径。所有平台及 offline／非 offline 模式均通过 `OMP_CONFIG_ROOT` 统一调整持久数据根，`OMP_CACHE_DIR` 只接管规定的性能数据；Knowledge 等持久子目录沿用 profile 内布局，不再单独指定活动目录。
- **Broker native 生命周期**：Linux broker 及其子 worker MUST 复用宿主已解析的 native 缓存目录（包括有效 `PI_NATIVES_DIR`；Linux offline 默认 `/dev/shm/omp-<UID>/natives`，保留 profile 布局），不在 scope runtime 下另建 native 副本，不随单个会话退出删除共享缓存。其他平台的 broker 自有 native 缓存仍位于既有 scope runtime 的 `natives/` 下，不以创建者进程为所有者，core 的显式 `PI_NATIVES_DIR` 不约束 detached broker；验收须实际加载 native、关闭 creator 并立即删除其独占叶（Windows 不出现 EPERM），另一已连接 client 仍能访问 broker，最后 client 关闭后通过 broker 正常退出释放自有缓存。各平台均不通过 `client.close()` 关闭共享 scope；两个独立 worker 同时冷提取／加载完整 native，发布后内容不变且无 staging 残留。

- `OMP_OFFLINE` 进程中若未设置 `FS_SCAN_CACHE_TTL_MS`，进程内设为 `30000` 毫秒；该变量只影响 `@` 文件补全的目录重扫间隔，非 offline 进程完全不变，用户显式设置的值（含 `0`）优先。
- **内网交互减负**：仅 Linux offline 将普通后台 TUI 重绘合并到最多 10 FPS；输入回显与取消沿用原输入优先调度，强制最终刷新、终端输出反压与自适应限速不变。品牌渐变刷新降为 250ms，活动计时装饰刷新降为 1000ms。Git 状态缓存由普通模式的 10 秒延长到 60 秒，沿用 HEAD／工作目录／显式失效；未显式失效的外部工作树修改可能延后显示，不新增工具修改通知或修改 Git 配置。非 Linux 和非 offline 保持原行为，不要求改变企业远程软件，不预先承诺公司实机提速。
- **内网运行期显示减负**：所有 `OMP_OFFLINE` 进程将现有累计流式更新合并窗口从普通模式的 50ms 调为 100ms，沿用结束／取消等边界事件立即冲刷、逐增量语音及实时思考阶段处理，不改变输入与终端绘制调度；进程内覆盖 `tui.autoGraph=off`、`tui.titleState=false`、`title.refreshOnReplan=false`，优先于已保存设置且不写配置。保留原始表格、首次 scout 自动标题、手动命名及单词／文件／路径／命令补全；SVG／Mermaid／图片、Markdown 缓存、历史裁剪、LSP 与 MCP 不变。非 offline 保留原合并窗口及配置行为。
- `OMP_OFFLINE=1` 以无公网模式启动本次进程：临时把 `web_search.enabled`、`browser.enabled`、`astEdit.enabled`、`fetch.enabled` 关为 `false`，`company/Qwen3.8-27B` 的 `contextWindow` 设为 `262144` tokens（256 × 1024），其他 `company` 聊天模型设为 `204800` tokens（200 × 1024）；模型特定限制由既有 KDL 策略维护（不改 `maxTokens`）。这些启动覆盖优先于已保存配置，不写配置文件，退出即消失，普通启动保持原值。Python Eval 的解释器优先级为显式 `python.interpreter` → Linux offline 固定候选 `/software/public/python/3.11.4/bin/python3.11` → 原有自动候选，并补查 PATH 中的版本化 `python3.15` 至 `python3.11`、`python3` 和 `python`；同一路径不重复探测。Linux offline 复用统一的 `OMP_OFFLINE` 真值判断（`1`、`true`、`yes`、`on`，忽略大小写及首尾空白），所有候选均实际检查 Python ≥3.11，旧业务 Python 3.6 或 3.10 不可成为 Eval 解释器；找不到合适版本时明确失败，不降级。显式解释器不可用或不兼容时不 fallback；固定候选缺失或不适合时继续查找，不因 PATH 中已有旧 `python` 而停止。其他平台或非 offline 进程保留原有候选和 Python 3.8+ 门槛。新发现的系统解释器只用于 OMP Eval 子进程，清除其继承的业务 venv／Conda／PYTHONPATH，不修改主进程 PATH、项目虚拟环境或业务 Python，不扫描软件目录找版本、不安装包。系统提示词仍追加“当前处于 offline 模式，环境无公网。不要尝试访问公网；使用本地资源和公司内部服务。”。公司内部模型 API、bash/eval、本地文件、LSP、本地 Git、Computer Use 等能力仍可用。
- offline 且 company provider 可用时，仅为未配置的 model role 补充当前进程默认值：`default`、`plan`、`slow` → `company/GLM-5.3-public`；`smol`、`task`、`vision`、`advisor` → `company/Qwen3.8-27B`；`tiny`、`commit` → `company/Qwen3.6-35B-A3B`；`memory` 未配置时继续按既有规则自动解析，不新增固定赋值。已有角色配置（包括显式 `null` 清除项）和显式 CLI 模型参数仍优先，不写配置文件，不限制 `/model`、`Ctrl+T` 或角色切换，也不锁定 company。保存、活动匹配与切换冲突比较统一排除这些隐式默认角色，不误报刚保存的 preset 与公司默认值冲突；用户显式配置或 CLI 选择的角色仍按原规则保存和比较，包括显式选择的 company 模型。普通启动不受影响。
- offline 当前进程将 `startup.setupWizard` 覆盖为 `false`，不自动弹出或导入首次启动的全屏配置向导；显式启用的启动动画按需独立加载，手动设置入口保持原有行为。
- offline 启动不读取或展示启动更新日志，也不触发在线模型目录发现——含交互界面就绪后的后台发现，以及会话恢复、默认角色解析、prewalk 目标解析和 `enabledModels`/`--models` scope 预解析里的 discovery fallback（这些路径只用本地缓存，缓存缺失时按既有链路降级，不发目录发现请求）。同进程 task 子代理的新建与恢复也继承该限制；遗漏调用方即使请求 online 目录刷新也须受进程 offline 策略约束。已启用来源的已安装插件、内置和缓存模型照常加载；显式 `--model` 仍可选择模型，手动模型刷新同样只用缓存，实际模型／OAuth 请求及显式更新命令、`/changelog` 的其他行为不变。上述覆盖只在当前进程生效，不写配置文件，非 offline 启动不受影响。OMP 与插件市场的自动更新检查在全部平台、全部启动模式下均取消，见「全平台轻量启动」；Claude 插件来源默认不扫描，见[默认设置](../fork-runtime-defaults/spec.md#requirement-claude-插件发现默认关闭)。

以下是现有个人分发能力，不代表对外发布目标；上游同步不触发构建或发布。

- 个人 Release 版本使用 `+fork.N`，仅从本仓库 `main` 通过手动 CI 生成；手动运行默认只构建可下载的二进制 artifact（`publish_release=false`），明确启用发布后才创建 Release，非 `main` 分支不能发布。CI 仅执行构建、打包及其必要准备，不运行单元、集成、冒烟或安装测试；发布 MUST 等待版本元数据、全部二进制和浏览器扩展构建成功，不依赖测试作业。本地测试入口保留，按用户明确授权单独运行。发布须单独明确授权，`bun run slowtest` 仅做本机及适用 WSL 本地验证，NEVER 自动推送、触发/等待 CI 或创建 Release。`N` 取 `.github/workflows/ci.yml` 工作流的 `run_number`，GitHub 按工作流文件路径维护计数，重命名或删除重建该文件会让 `N` 从 1 重新开始（与历史 tag 撞号、旧安装收不到后续更新），NEVER 这样做。
- 本地开发分发额外提供 `bun run local`（Windows 本机编译并直接替换安装目录中的 `omp.exe`：旧可执行文件先改名，再换入新版，不杀任何已有进程；换入失败恢复旧文件，仍被旧进程占用的映像保留）和 `bun run cnb`（先在 Windows 与 Ubuntu-24.04 WSL2 的 `/root/oh-my-pi` 工作区执行安全的 `git pull --ff-only`，确认两端 Git 提交一致，再并行编译两平台二进制，并行上传到已有 CNB Release；默认目标为 `jchanghong/bin` 仓库的 `omp` 标签，可用 `--repo`、`--tag` 显式覆盖，无需交互输入）；构建复用各平台本地缓存。执行 `bun run cnb` 即直接覆盖 `omp-windows-x64.exe` 和 `omp-linux-x64` 两个同名附件，不另行确认，也不修改其他附件；移除冗余的 `--overwrite` 参数。`bun run cnb` 分发命令只上传这两个二进制，不打包、上传或推送源码。该分发不替代 GitHub 正式 Release，也不改变安装器或 `omp update` 的 GitHub 来源。
- `local` 和 `cnb` 的目标是最快构建交付、便于手动验证：MUST NOT 运行任何测试、冒烟、worker 探测、native 加载探测或构建产物试运行。CNB 不执行全仓源码哈希扫描、重复 WSL 预检、Release 附件竞态检查或发布后重复查询；只保留干净工作区、Git 提交一致性、Bun 版本、构建输出及上传接口所必需的检查和确认。WSL 源码及构建脚本 MUST 只通过 Git 远端同步，不通过 stdin 传脚本，也不复制、移动、打补丁或清理用户文件绕过脏工作区检查。两端 Bun 版本 MUST 一致；保留构建资源所必需的 Export viewer 精确字节元数据校验。Bazel 使用已提交的模块锁且不得在发布构建中改写它，过期锁文件通过生成命令更新后提交同步；遗留 `tool-views.generated.js` 仅作为忽略的生成产物保留。
- 仓库启用 `.github/workflows/ci.yml`（手动构建发布）与 `.github/workflows/sync-cnb.yml`（按用户授权每 5 分钟及手动同步源码，见「CNB 源码同步」）；`nix.yml` 与 `bun-cache-warm.yml` 以 `.disabled` 后缀停用，不参与任何触发。fork 不提供 Nix 发布与独立的 Bun 缓存预热工作流；恢复或新增工作流须显式写明触发条件与授权，不得隐式恢复上游默认触发。
- 构建发布 CI 及 `bun run local`、`bun run cnb` 安装 native 产物时显式跳过宿主 addon 加载探测（`--skip-load-probe`），仍写入构建所需的版本戳；普通 `bun run build:native` 的默认加载探测行为不变。
- 构建发布 CI 使用上游 Bazel cache 配置 action；没有集群远程缓存凭据时仍执行构建，不依赖 fork 专用的 GitHub Bazel 磁盘或依赖缓存。
- 二进制必须携带 fork 版本和更新仓库信息。
- `PI_UPDATE_REPOSITORY` MUST 可覆盖 `omp update` 使用的更新仓库；未设置时固定为本 fork 仓库。该变量 MUST NOT 写入配置文件或构建产物。
- 本地构建脚本 `packages/coding-agent/scripts/build-binary.ts` 同样注入本 fork 更新仓库：本地构建产物的 `omp update` 指向本 fork Release，不会回退官方渠道（版本号不注入，`--version` 无 `+fork.N` 后缀属预期）。
- 本地二进制构建 MUST 向终端输出目标平台、资源生成、编译、适用的签名、生成文件恢复及可选 ZCode 产物阶段；仅在全部步骤成功后输出构建完成、实际可执行文件路径和总耗时，避免把编译阶段的静默成功误判为未执行而重复构建。
- `omp update` 先比较正常 SemVer，再比较同基线的 fork build counter；本地构建未带 `+fork.N` 时按 counter 0 比较，因此可取得同基线的新 fork Release，而不把更高上游基线降级。支持 `%2B` 编码的 `+` 版本 URL；GitHub 元数据和资产统一优先环境令牌，再尝试本机 `gh auth token`，无凭据才匿名请求。
- `omp update` 下载二进制时，在交互终端显示下载百分比、速度与预计剩余时间；非 TTY 输出（如 CI、管道）不显示动态进度。若 `PATH` 中的 `omp` 与更新目标解析为不同文件，更新前警告并提示更新后运行 `omp --version` 核对实际生效的版本；指向同一文件的符号链接不视为冲突。
- `update.channel=canary` 在 fork 二进制上不可用：显式执行 `omp update` 时提示该配置并指向 `omp update --stable`，不在启动时检查或提示更新渠道。
- `-fork.N` 时代（fork build ≤ 35，2026-08-26 及更早）的旧安装内嵌只认 `vX.Y.Z-fork.N` 的校验，会拒绝此后所有 `+fork.N` Release（报 `Invalid fork release tag`）且无法自愈，只能用安装器重装后再交给 `omp update`。
- 发布链路不发布核心或平台 npm 包，也不发布 Homebrew tap；Release notes 由 GitHub 自动生成。CI 只构建 Linux glibc x64 和 Windows x64 二进制，Release 上传的附件仅为 `omp-linux-x64`、`omp-windows-x64.exe` 和 `omp-browser-relay-extension.zip`；GitHub 自动提供的源码归档不属于上传附件。更新器使用 GitHub 资产元数据的 SHA-256。CI 不生成 ZCode 产物，其他平台不再提供新的预编译版本。
- 安装器只安装 fork Release 的预编译二进制；当前 Release 仅提供 Linux glibc x64 和 Windows x64，其他 Linux 架构及 musl 无对应新版本资产。`install.sh` 在 macOS 上于联网前明确拒绝安装。安装目标已是所选 Release 版本时提示已安装并跳过下载，同时仍检查 PATH 配置。
- fork 不提供源码安装：两个安装器都不再有 source 模式，安装验证只覆盖 Release 二进制。上游的源码安装测试 `scripts/install.test.ts` 与 `scripts/install-tests/source.dockerfile` 在 fork 中删除，`run-ci.sh` 不再执行源码安装冒烟；同步时 MUST NOT 恢复这些入口，除非先显式修改本节需求。
- Windows 安装与更新不要求额外安装 PowerShell 7：安装器必须能在系统自带的 Windows PowerShell 5.1 x64 下直接执行；`omp update` 使用自身 HTTP 下载、SHA-256 校验和二进制替换链路，不依赖 `pwsh.exe`，不得要求用户升级 PowerShell 来绕过兼容问题。
- 两个平台的安装器都下载到安装目录中的唯一临时文件，先确认可启动且 `omp --version` 与所选 Release 完全一致，再替换现有安装；验证失败保留旧安装并清理临时文件。可执行目标是目录时联网前拒绝，不移动目录内容；已经是所选版本时跳过下载但仍提示 PATH。Windows 优先 `curl.exe`；未设置目标协议的代理环境变量及 `ALL_PROXY` 时，自动解析当前用户的 Windows 系统代理并传给 curl，不要求额外设置环境变量。显式代理环境变量优先，curl 遵循 `NO_PROXY`；curl 失败或不可用时仍回退兼容 PowerShell 5.1 的 `Invoke-WebRequest -UseBasicParsing`。安装器只维护 PATH，不写废弃的 settings.json 或擅自改用户 shell/config.yml。安装器自身的全部 Web 请求（Release 元数据与二进制下载）默认放宽 TLS 校验，与运行时零配置姿态一致：curl 追加 `--insecure`，Windows 安装器另加 `--ssl-no-revoke`；POSIX 安装器仅在 curl 使用 Schannel 且版本支持时追加 `--ssl-no-revoke`（Schannel 吊销检查在拦截代理后常失败），不向旧版或其他 TLS 后端传入该选项。PowerShell 5.1 启用 TLS 1.2 并挂接放行证书回调，PowerShell 7+ 对 `Invoke-RestMethod`/`Invoke-WebRequest` 传 `-SkipCertificateCheck`；下载完整性仍由装后 `omp --version` 与所选 Release 完全一致的校验兜底。
- 运行时代理与安装器同序：Windows 主进程内所有经全局 `fetch` 的出网请求（含 LLM 流、OAuth/usage 探测、模型发现、更新检查与 web 请求）按「请求自带显式 `proxy`（`PI_PROXY_<PROVIDER>`/`PI_PROXY`）→ 标准代理环境变量（`HTTPS_PROXY`/`HTTP_PROXY`/`ALL_PROXY`，Bun 原生应用）→ 当前用户 Windows 系统代理 → 直连」解析。系统代理仅取 HKCU Internet Settings 的静态 `ProxyEnable`/`ProxyServer`（含 `http=`/`https=` per-protocol 形式，`socks=` 条目与 PAC/WPAD 不支持），每进程读取一次并缓存；未启用或读取失败时行为与无此改动一致。`NO_PROXY` 与回环/内网硬 bypass 同样约束系统代理。仅 win32 生效；worker 子进程入口（本地服务）不经此链路。系统代理层另有 fork 内网绕行清单（`packages/ai` proxy.ts 的 `FORK_SYSTEM_PROXY_BYPASS`，抄自公司代理 override 清单）：公司域名后缀、点名内网主机、CGNAT/RFC1918 式 IP 前缀（`10.`、`100.64.`–`100.126.`、`172.16.`–`172.32.`、`7.` 等）与 `*` 通配条目命中的目标不走系统代理、直连；清单只约束系统代理层，不约束 `PI_PROXY` 与环境变量代理（它们的绕行机制仍是 `NO_PROXY`）。条目语义与来源格式对应：前导 `-` 剥离、数字开头为 IP 前缀、含 `*` 为整机名 glob、首尾皆点为点号标签包含、仅前导点为域名后缀、其余为精确或点后缀。
- 零配置 TLS 默认：主进程网络引导时，未显式设置即默认 `NODE_TLS_REJECT_UNAUTHORIZED=0`（Bun fetch 认可，覆盖全部 fetch 请求的证书验证）与 `GIT_SSL_NO_VERIFY=true`（主进程拉起的 git 子进程继承），使拦截代理/私有网关的自有根证书场景免配置可用。显式设置的值均优先于此默认，不被改写；`NODE_TLS_REJECT_UNAUTHORIZED=1` 与 `GIT_SSL_NO_VERIFY=false` 分别恢复对应的严格校验，显式 `0`／`true` 则仍放宽对应校验。agent 目录 `.env` 同样先于此默认生效；worker 子进程入口不经此默认。这是个人 fork 的安全姿态取舍：采用该放宽默认时，TLS 不再验证端点身份，凭据在可劫持网络下有被截获风险，仅在个人受控环境接受。
- 安装器替换目标二进制时不中断运行中的 omp：Linux 用同目录原子 `mv`；Windows 先把旧 `omp.exe` 重命名到唯一的 `.omp.old.*` 再换入（换入失败自动回滚），仅当重命名失败（如杀软锁定）才回退为按安装路径精确匹配强杀，`.omp.old.*` 残留由下次安装尽力清扫。Windows 的已验证下载在替换失败时保留为 `.omp.tmp.*`，包括旧安装已成功回滚的情况；回滚失败同时保留旧映像供恢复。
- Windows 下载成功后，校验、旧映像重命名/强杀回退、换入、回滚或 PATH 设置失败，MUST 打印失败阶段、原始错误、错误类型/代码、安装目标及可用的诊断日志路径，并输出正确引用路径的可执行 PowerShell 命令：未通过验证的二进制不能引导运行；已验证的保留下载可直接启动；旧映像恢复只在目标不存在时执行；重试固定本次 Release 与安装目录，最后核对目标文件及 PATH 命中的版本。二进制已换入但 PATH 设置失败时明确标为部分完成，不能提前报告安装成功。非致命清理失败须说明具体错误和安全重试命令；仍被旧会话占用的映像可留待会话退出后清理，不影响新版安装结果。详细错误仅向终端展示，落盘日志继续遵循脱敏契约。

#### Scenario: 安装与运行的可观察行为

- **WHEN** 用户在普通或 offline 场景安装、启动或更新
- **THEN** 按有效持久根、性能目录、网络与安装边界运行；失败保留旧安装或已验证产物并如实报告

### Requirement: 全平台轻量启动

OMP MUST 在所有运行平台的普通与 offline 启动中省去自动更新检查及未启用的设置向导初始化，offline 认证读取异步并行；不依赖用户新增配置文件，也不改变显式操作入口。

#### Scenario: 启动不检查更新

- **WHEN** 启动终端交互、print、RPC、ACP 或 ZCode app-server，或创建、恢复会话
- **THEN** 不自动查询 OMP 新版本，不自动刷新、检查或升级插件市场，不创建相应后台任务或展示新版通知。
- **AND** 删除 `startup.checkUpdate`、`marketplace.autoUpdate` 设置与对应 UI；遗留配置值不能重新启用这些行为，不改写用户配置。
- **AND** 普通启动不加载仅供更新命令使用的实现；显式 `omp update`（含检查模式）及插件市场刷新、升级仍沿用原有入口和行为，已启用来源的已安装插件照常加载；Claude 插件来源默认不扫描，具体边界见[默认设置](../fork-runtime-defaults/spec.md#requirement-claude-插件发现默认关闭)。

#### Scenario: 未启用的设置向导不参与启动

- **WHEN** `startup.setupWizard=false` 且未强制运行向导，即使已保存的 setupVersion 落后
- **THEN** 不加载完整设置向导及其场景、认证或浏览器辅助依赖，不执行向导场景选择。
- **AND** 仅启用启动动画时按需加载独立动画，不为动画初始化完整向导；显式强制设置与用户启用的版本化向导仍按原有条件运行。

#### Scenario: offline 认证读取不串行阻塞启动

- **WHEN** offline 启动需要 company 认证配置
- **THEN** 提前发起异步快照读取，与配置加载和插件预加载等无认证依赖的步骤并行推进；依赖公司配置的模型注册与 Worker 启动仍等待快照就绪。
- **AND** 单次读取、终态缓存、错误呈现与凭据继承边界遵循[公司内网模型](../model-providers/spec.md#requirement-公司内网模型仅-omp_offline)，不新增同步读取回退、重试或额外配置。

### Requirement: 插件市场仅手动更新

OMP MUST 关闭 marketplace 自动更新，不提供自动刷新、检查或升级的设置和后台任务；目录是否超过 24 小时不触发刷新。

#### Scenario: 读取过期市场缓存

- **WHEN** 启动、创建或恢复会话，或列出、浏览插件市场，即使目录缓存已超过 24 小时
- **THEN** 使用已有目录缓存和已安装插件，不自动拉取市场源、不改写目录缓存或更新时间，也不自动检查或升级插件。
- **AND** 遗留 `marketplace.autoUpdate` 的 `notify` 或 `auto` 值不能恢复自动更新，用户配置保持原样。

#### Scenario: 显式刷新和升级

- **WHEN** 用户执行 `/marketplace update [name]` 或 `omp plugin marketplace update [name]`
- **THEN** 仅刷新指定或全部市场目录，不自动重装或升级已安装插件；遗留克隆临时目录清理只在显式添加或更新市场时进行。
- **AND** `/marketplace upgrade` 和 `omp plugin upgrade` 继续作为显式插件升级入口，保留原有作用域和状态保留规则。

### Requirement: 发布 CI 的触发、并发与权限

OMP MUST 只允许手动触发发布工作流，并对并发与令牌权限做最小授权。

#### Scenario: 发布 CI 的触发、并发与权限的详细边界

- **WHEN** 本节所述功能在适用条件下运行
- **THEN** 以下具体约束适用：

- 仓库唯一的发布工作流 MUST 只由 `workflow_dispatch` 触发，MUST NOT 配置推送、标签、定时或上游默认触发。
- 并发组 MUST 为 `<工作流名>-<ref>`，MUST NOT 取消进行中的运行；同一 ref 的多次手动运行排队执行，不并发改写同一版本的产出。
- 工作流默认权限 MUST 为 `contents: read`；只有实际创建 Release 的发布 job MAY 提升到 `contents: write`，其他 job（元数据、构建、产物汇总及测试）MUST NOT 获得写权限。
- 工作流只运行版本元数据、构建、打包和发布所需步骤，不运行测试；本地 fulltest 验证独立执行，不以工作流构建成功替代测试结果。构建产物可在未选择发布时下载，发布依赖版本元数据、全部二进制和浏览器扩展构建成功，不增加 Bazel 测试框架或 push／PR 触发。

#### Scenario: 发布 CI 的触发、并发与权限的可观察行为

- **WHEN** 查看工作流定义或以非手动方式尝试触发发布
- **THEN** 只有手动派发会启动，并发组按 `<工作流名>-<ref>` 排队且不取消运行，写权限仅存在于发布 job

### Requirement: CNB 源码同步

仓库 MUST 通过独立的 `.github/workflows/sync-cnb.yml` 将 `jchanghong023/oh-my-pi` 的 Git 分支、标签及 Git LFS 对象单向同步到 `https://cnb.cool/jchanghong/oh-my-pi`。

#### Scenario: 定时和手动触发

- **WHEN** GitHub Actions 调度 `*/5 * * * *`，或用户执行 `workflow_dispatch`
- **THEN** 同步全部 GitHub 分支与标签，以 GitHub 为准强制更新 CNB 同名引用，并先上传所需 Git LFS 对象；不推送 `refs/pull/*`，不删除 CNB 独有分支或标签
- **AND** 使用固定并发组串行执行，不取消进行中的同步；定时触发受 GitHub 调度延迟和停用规则约束，不承诺严格五分钟内完成
- **AND** 该工作流仅在 `jchanghong023/oh-my-pi` 启用，不构建、不测试、不创建 Release，不改变现有发布 CI 的手动触发约束

#### Scenario: 增量同步与进度

- **WHEN** 执行源码同步
- **THEN** 复用 Git 裸仓库与 LFS 对象缓存，增量获取缺少的对象；缓存缺失时恢复为完整历史同步，不裁剪分支、标签或历史 LFS 对象；清理源端已删除的本地缓存引用，但保留 CNB 独有引用
- **AND** 以 CNB 实际引用比较结果确定变化，只处理变化分支和标签的完整 LFS 历史；无变化时跳过 LFS 扫描、传输及正式 Git 推送
- **AND** 仅在镜像变化或存在待同步引用时保存新缓存；LFS 或 Git 推送失败仍可保存已获取对象，后续执行重新比较 CNB 并重试，不因缓存引用已更新而漏同步；缓存不包含令牌值
- **AND** Git fetch/push 启用 `--verbose --progress`，LFS 强制输出传输进度，准备、获取、比较和上传阶段分别标记；不启用可能暴露认证信息的 trace

#### Scenario: 认证和失败

- **WHEN** 访问源仓库及 CNB 目标
- **THEN** GitHub 令牌仅授予 `contents: read`，CNB 使用用户名 `cnb` 与 GitHub 环境 `CNB_TOKEN` 中的同名 Secret；同步 job MUST 显式绑定此环境并遵守其保护规则；令牌须具有目标仓库代码读写权限，不写入仓库、远程 URL 或日志
- **AND** 缺少令牌、LFS 传输失败或 Git 推送失败时工作流失败并保留错误，不将未同步报告为成功；CNB 分支保护仍须允许所需强制更新

### Requirement: 安装器诊断日志

OMP MUST 将安装诊断写入按运行唯一命名的日志文件，字段脱敏且写入失败不阻断安装。

#### Scenario: 安装器诊断日志的详细边界

- **WHEN** 本节所述功能在适用条件下运行
- **THEN** 以下具体约束适用：

- 日志文件名 MUST 为 `omp.install.<UTC 日期>.<epoch 毫秒>.<PID>.log`：日期为 UTC 的 `YYYY-MM-DD`，其余两段使同一进程的不同次安装也各自独立。
- 每条记录 MUST 含 `operation_id`、`stage`、`elapsed_ms`、`platform`、`target_version`，以及级别、事件名与有界的结果字段；`target_version` MUST 只接受可选的 `v` 前缀加 `<数字>.<数字>.<数字>`、可再带 `+fork.<数字>` 的形式，其他输入 MUST 记为 `redacted`。
- 选择性能数据根时，安装器日志使用该根下的 `logs/`，保留原有回退规则。未选择性能数据根时，目录选择 MUST 依次尝试：绝对有效的 `OMP_CONFIG_ROOT`（含 profile 子目录）下的 `logs/`，否则用户数据根（`PI_CONFIG_DIR` 或 `.omp`）的 `logs/`；未显式指定根且 `<XDG_STATE_HOME>/omp` 已存在时改用该目录；仍不可写时回退到 `~/.local/state/omp`。Windows 上首选同一数据根，回退到 `%LOCALAPPDATA%\omp`。回退（而非首选目录）生效时 MUST 留下一条 WARN。
- 保留策略 MUST 只清理本安装器模式的日志：保留最近 20 次尝试、最近 5 天，且 MUST 跳过 PID 仍存活的文件；不得删除应用日志或无关文件。
- 日志写入失败 MUST 只在 stderr 输出一行提示并继续安装，MUST NOT 使安装失败或改变退出码。

#### Scenario: 安装器诊断日志的可观察行为

- **WHEN** 安装器在可写或不可写的数据根下执行
- **THEN** 可写时生成唯一命名的安装日志并按 20 次／5 天保留，不可写时仅打印一行提示且安装继续

### Requirement: ZCode 发布产物的校验与布局

OMP MUST 只为干净且已提交的源码生成 ZCode 产物，并按目标校验可执行文件格式后原子发布。

#### Scenario: ZCode 发布产物的校验与布局的详细边界

- **WHEN** 本节所述功能在适用条件下运行
- **THEN** 以下具体约束适用：

- `ZCODE_ARTIFACT_ROOT` 在 dry-run 下 MUST NOT 生效；启用时 MUST 要求 `RELEASE_VERSION`，缺失即失败。
- 输出根 MUST 不存在且由本次调用新建：已存在时 MUST 失败，MUST NOT 删除或复用用户已有目录；失败后 MUST 递归删除本次自建的输出根，不留半成品。
- 源码 MUST 干净且 HEAD 与调用方给出的期望提交一致；构建前、拷贝后 MUST 各校验一次，拷贝前后同一文件 MUST 字节一致，否则失败。
- 每个 target MUST 校验可执行头与目标匹配（PE 的机器类型、ELF 的类／字节序／机器、Mach-O 的魔数与 CPU 类型），不匹配即失败。
- 产物布局 MUST 为：每个 target 目录下的 `omp`（Windows 为 `omp.exe`）、`omp-artifact.json`（含 `schemaVersion: 1`、`version`、`commit`、`protocolBaseline`、`files` 的 SHA-256）以及输出根下的 `omp-release.json`（版本、提交、协议基线及各 target manifest 的 SHA-256）。
- 版本号 MUST 符合语义化版本形式，target 列表 MUST 非空且不重复。

#### Scenario: ZCode 发布产物的校验与布局的可观察行为

- **WHEN** 带 `ZCODE_ARTIFACT_ROOT` 构建发布二进制
- **THEN** 输出根为新建目录，内含逐 target 的 `omp`／`omp.exe`、`omp-artifact.json` 与根级 `omp-release.json`；不干净、提交不符或可执行格式不符时整体失败并删除自建输出根

### Requirement: POSIX 安装器对运行中会话的检测

OMP MUST 在替换已安装二进制前提示仍在使用它的会话，且不终止这些会话。

#### Scenario: POSIX 安装器对运行中会话的检测的详细边界

- **WHEN** 本节所述功能在适用条件下运行
- **THEN** 以下具体约束适用：

- 替换前 MUST 扫描 `/proc/*/exe`，把解析后（含 ` (deleted)` 后缀归一化）等于安装目标真实路径的进程收集为运行中会话。
- 命中时 MUST 提示安装目标、PID 列表及“它们会继续使用旧版本、需重启才能用新版本”，MUST NOT 发送信号或强制结束。
- 无 `/proc` 时 MUST 降级为无法检测的状态继续安装，MUST NOT 因平台限制失败。
- 安装目标尚不存在（全新安装）时 MUST 以字面路径参与比较，不因解析失败中断安装。

#### Scenario: POSIX 安装器对运行中会话的检测的可观察行为

- **WHEN** 安装目标正被若干会话使用（或反之）
- **THEN** 安装器列出对应 PID 并完成原子替换，未命中或无 `/proc` 时静默继续

### Requirement: Windows 安装器强杀回退的身份校验

OMP MUST 只在能确认进程映像就是安装目标时执行强杀回退。

#### Scenario: Windows 安装器强杀回退的身份校验的详细边界

- **WHEN** 本节所述功能在适用条件下运行
- **THEN** 以下具体约束适用：

- 强杀回退 MUST 只针对可执行映像已重命名让位失败（如被占用）后的恢复路径执行，MUST NOT 用于常规更新。
- 每个同名进程 MUST 读取其可执行路径并与安装目标做大小写不敏感的完整路径比较；只有完全相等者 MAY 被强制结束。
- 任一进程的可执行路径不可读时 MUST 以 `unsafe_identity` 失败并列出这些 PID，MUST NOT 猜测或扩大到其他进程。
- 结束与等待 MUST 有超时；仍有存活目标进程 MUST 报告剩余 PID 并失败。
- 日志 MUST 记录匹配策略为精确可执行路径及匹配／剩余数量，MUST NOT 记录进程命令行。

#### Scenario: Windows 安装器强杀回退的身份校验的可观察行为

- **WHEN** 旧 `omp.exe` 无法重命名且存在同名进程
- **THEN** 仅映像路径完全等于安装目标的进程被结束；路径不可读时安装以 `unsafe_identity` 失败并列出 PID

### Requirement: native 能力缺失时的运行期降级

OMP MUST 在加载到的 native addon 缺少管道流能力时降级相关视图而不影响命令执行。

#### Scenario: native 能力缺失时的运行期降级的详细边界

- **WHEN** 本节所述功能在适用条件下运行
- **THEN** 以下具体约束适用：

- 当 addon 不导出管道流类或其实例化失败时，bash 工具 MUST 仍然执行命令并返回正常结果，MUST NOT 抛错、MUST NOT 因此改用交互式 pty 模式。
- `proc://<id>/streams` 与该 job 的管道组件 MUST 降级为不含流数据的说明性结果（报告该 job 没有可用管道流），MUST NOT 使后台 job 状态、退出码或输出读取失效。
- 该降级 MUST 只影响管道流视图；其余 native 功能缺失仍按各自既有诊断报错。

#### Scenario: native 能力缺失时的运行期降级的可观察行为

- **WHEN** 一个较早版本的 addon 被加载且命令含管道（如 `| tail`）
- **THEN** bash 调用成功返回命令结果，`proc://<id>/streams` 报告无可用管道流

### Requirement: 被中断工具结果的取消标记

OMP MUST 区分“被中断取消”与“执行失败”，并在工具结果中持久化该事实。

#### Scenario: 被中断工具结果的取消标记的详细边界

- **WHEN** 本节所述功能在适用条件下运行
- **THEN** 以下具体约束适用：

- 工具调用因中断在执行前被跳过、在等待用户授权时被取消、或在执行中被信号中断时，持久化的工具结果 MUST 带 `cancelled: true`，并与 `isError` 同时存在。
- 已产生真实结果的工具 MUST 保留原结果，MUST NOT 因随后到达的中断把结果改标为取消；未开始执行的不可中断工具同样 MUST 继续执行。
- 该标记 MUST 写入会话记录（含 fork 复制与投影读取），使用户界面与上层消费者能把取消显示为取消而非错误，且 MUST NOT 改变工具自身的内容或退出码。

#### Scenario: 被中断工具结果的取消标记的可观察行为

- **WHEN** 一批工具调用在中断期间被跳过或中断
- **THEN** 对应工具结果在会话记录中带 `cancelled: true`，已完成调用保留真实结果

### Requirement: Todo 追加参数说明与错误恢复

`todo` MUST 在参数描述、工具说明及缺参错误中明确追加操作的输入约束和恢复方式，避免模型通过重置待办丢失已有进度。

#### Scenario: 追加操作的调用说明

- **WHEN** 模型读取 `todo` 的参数描述及工具说明
- **THEN** 两者 MUST 明确 `op="append"` 必须提供 `phase` 和非空 `items`，使用扁平 `init` 后也不例外
- **AND** 工具说明 MUST 明确使用目标阶段的准确名称，新名称会创建阶段；不知道已有阶段名时先调用 `op="view"`，不得为恢复追加错误重新初始化待办

#### Scenario: 缺参失败后保留进度并重试

- **WHEN** `append` 缺少阶段名，或缺少任务项、任务项为空数组
- **THEN** 工具 MUST 拒绝追加且保留原有阶段、任务及状态，错误信息 MUST 明确本次未添加任务，并说明补齐目标阶段及非空任务项后重试
- **AND** 缺少阶段名的错误 MUST 引导先用 `view` 查找目标阶段，再携带原任务项重试，且不得重新初始化待办
- **WHEN** 模型查询已有阶段并补齐参数重试
- **THEN** 工具 MUST 将任务追加至指定阶段并保留原有进度，不自动猜测目标阶段

### Requirement: 设置写入的版本校验

`omp config set`／`omp config reset` MUST 以 revision 判定快照并做 CAS 写入；无法安全读取当前配置时 MUST 失败而非覆盖。

#### Scenario: 设置写入的详细边界

- **WHEN** 本节所述功能在适用条件下运行
- **THEN** 以下具体约束适用：

- 写入前 MUST 取得当前配置 revision；提交时 revision 已变化 MUST 拒绝写入并报冲突，MUST NOT 静默覆盖他人改动。
- 配置文件不存在、不可解析或 revision 无法确立时 MUST 以非零退出码失败，MUST NOT 退化为整文件覆盖。
- 成功写入 MUST 保留无关键、注释与结构，并返回新 revision。
- 该版本校验 MUST NOT 扩大到普通会话中的运行时设置写入。

#### Scenario: 无法安全读取时拒绝写入

- **WHEN** 配置文件损坏或 revision 无法确立时执行 `omp config set`
- **THEN** 命令以退出码 1 失败，原文件保持不变

### Requirement: 会话通信回执

OMP MUST 在 `irc` 发送成功的回执中保留消息身份，使冷恢复能把发送与接收识别为同一条通信。

#### Scenario: 会话通信回执的详细边界

- **WHEN** 本节所述功能在适用条件下运行
- **THEN** 以下具体约束适用：

- 发送成功（`outcome` 非 `failed`）的回执 MUST 携带原消息的 `id` 与 `ts`，并与写工具结果一起持久化；失败回执保持原样，不伪造身份。
- 冷恢复只按该身份去重，不按到达顺序或文本猜配对；缺失身份时保留原不完整事实，不推断为两次通信。
- 该身份只存在于持久化回执，不改 `irc` 的发送参数、路由、唤醒或权限语义。

#### Scenario: 会话通信回执的可观察行为

- **WHEN** 含 `irc` 发送的会话被重新加载
- **THEN** 已发送消息与对端接收记录按同一 `id`／`ts` 对应，不重复计数

### Requirement: 本地构建的 ZCode 产物版本前置条件

OMP MUST 对本地二进制构建产生的 ZCode 产物执行与已批准产物契约相同的显式版本前置条件。

#### Scenario: 缺少发布版本
- **WHEN** 本地二进制构建设置了 `ZCODE_ARTIFACT_ROOT`，但未提供有效的 `RELEASE_VERSION`
- **THEN** MUST 失败，不得以 package 版本替代发布版本生成 ZCode 产物。

#### Scenario: 显式发布版本
- **WHEN** 设置 `ZCODE_ARTIFACT_ROOT` 且提供有效 `RELEASE_VERSION`
- **THEN** 生成的 ZCode 产物版本 MUST 使用该值，并继续满足源码、目标格式、目录和清理的既有产物契约；未启用产物输出的普通本地构建保持原有版本行为。

### Requirement: Windows 统计端口恢复

OMP MUST 在恢复 Windows 统计端口时保留进程身份保护和安全回退行为。

#### Scenario: 已占用的统计面板端口

- **WHEN** Windows 统计面板的目标端口被无法正常响应的进程占用
- **THEN** 仅在能够确认监听进程属于 OMP Stats 时 MAY 回收并重新使用端口；无法确认身份时 MUST NOT 终止该进程，继续使用安全的端口回退行为。

### Requirement: OpenWiki 随 OMP 合并构建和发行

OMP MUST 在现有 Windows x64 与 Linux glibc x64 二进制中合并提供所纳入的 OpenWiki 代码、实际运行依赖、资源及许可证，并通过 OMP 安装和更新。运行 MUST 在 OMP 进程内完成，不要求独立 OpenWiki 包、CLI、MCP 服务、模型网关服务或用户另装 Node／Bun。本要求不增加发布平台、发布渠道或自动发布权限。

#### Scenario: 正式发行使用固定子模块提交
- **WHEN** 构建包含 OpenWiki 的 OMP 正式发行二进制
- **THEN** 构建显式初始化并使用父仓库 gitlink 指定的 OpenWiki fork 提交，纳入与该提交对应的代码、所需依赖和资源，不从浮动分支或独立 OpenWiki 已发布包替代源码
- **AND** 子模块提交不可取得或所需构建输入缺失时明确失败，不将缺少功能的产物报告为完整发行物

#### Scenario: 本地开发构建使用工作区
- **WHEN** 开发者在本地构建包含 OpenWiki 的 OMP 二进制
- **THEN** 可使用 `vendor/openwiki` 当前工作区，包括未提交修改；构建不得为匹配父仓库 gitlink 而强制重置这些修改
- **AND** 此类本地产物不冒充以固定提交构建的可复现正式发行物

#### Scenario: 干净环境直接使用
- **WHEN** 用户在支持的平台安装 OMP 发行物，环境未安装 OpenWiki、Node、Bun 或其他 JavaScript 包管理器，所选模型及必要 Git 工具已就绪
- **THEN** 用户可从 `omp openwiki` 使用所纳入功能，并由 OMP 内置 AI 工具查询已有 Wiki，无需额外包安装、源码目录或开发机 `node_modules`
- **AND** 不在运行时下载缺失的 OpenWiki 依赖或要求用户安装独立 OpenWiki／JavaScript 运行时来绕过依赖缺失

#### Scenario: 运行进程与辅助工具边界
- **WHEN** 执行 OpenWiki 的生成、查询、链接或可视化
- **THEN** 不启动独立 OpenWiki CLI、Agent、Node 或 MCP 服务进程，也不要求用户先运行一个模型网关服务
- **AND** 允许必要的 Git、浏览器等辅助进程，不把“内置”扩大解释为 OMP 进程树绝无子进程

#### Scenario: 依赖与许可证随包完整
- **WHEN** 从最终 OMP 发行物使用生成、检索、可视化和导出能力，并查看随包许可说明
- **THEN** 实际使用的 Agent、工具调用、SQLite／FTS5、生成 Agent 的内置 Skill／提示及浏览器资源调用面不依赖发行物之外的 OpenWiki 安装、旧 OpenWiki home 或开发源码；许可说明包含 OpenWiki 及实际纳入第三方资源所需的版权和许可证
- **AND** 保留原生 Agent 所需的运行依赖和 Skill 资源是允许的，不以“无需单独安装”为由错误排除生成执行所需代码或资源

#### Scenario: 不改变既有发布授权
- **WHEN** 将 OpenWiki 纳入现有构建与发布链路
- **THEN** 继续遵循现有手动 CI、发布授权、平台和附件范围，不新增独立 OpenWiki 包或发行渠道，不恢复 npm／Nix 发布，不向发布工作流加入测试作业
- **AND** 真实功能和发行物验收在单独授权的验证中进行，构建成功不能替代功能验收

### Requirement: OpenWiki 离线资源与模型服务边界

OMP MUST 随发行提供关系图、Markdown 阅读器、Mermaid 等自身可视化功能所需的浏览器资源，使实时浏览和静态导出不依赖公网 CDN 或运行时下载。OpenWiki MUST 遵循 OMP 已有 offline 和模型访问规则；无公网不等于无需可达的模型服务。

#### Scenario: 无公网实时浏览和静态导出
- **WHEN** 用户在无公网环境使用实时可视化，或通过静态 HTTP 服务访问导出目录
- **THEN** 图、Markdown 阅读器和 Mermaid 显示使用本地完整资源，不访问 jsDelivr、Google Fonts 等外部资源源站，也不因开发机缓存存在而掩盖资源缺失
- **AND** 静态导出携带其自身所需资源，不依赖正在运行的 OMP、OpenWiki Agent 或 MCP 服务

#### Scenario: 内网生成与无模型查询
- **WHEN** `OMP_OFFLINE` 启用且 OMP 已配置的内网模型服务可达
- **THEN** OpenWiki 可按 OMP 现有 offline 模型与认证规则生成，不启动 OpenWiki 专用在线模型发现、认证向导或外部连接器
- **AND** 只读查询和浏览已有 Wiki 不要求模型凭据；生成所需模型服务不可达时如实失败，不以离线可视化能力冒充离线模型推理

#### Scenario: 内置路径禁用独立公网遥测
- **WHEN** 用户在离线或非离线环境通过 OMP 内置路径执行 OpenWiki
- **THEN** 不发送 OpenWiki 自己的公网遥测，不改变 OMP 自身遥测规则或 OpenWiki fork 独立运行的原有行为
- **AND** 用户显式使用 `--telemetry-file` 时，仍按上游遥测禁用语义写出本地状态，记录 `disabled: true` 和 `sent: false`，不因此发送公网事件

### Requirement: OpenWiki 数据根与工作区隔离

OpenWiki 仓库内容 MUST 保持在项目的 `openwiki/` 下；OMP 管理的工作区注册表、缓存及仓库数据以外的用户级运行状态 MUST 在离线与非离线环境均遵循既有有效配置根和 profile 规则，不新增平行活动数据根。无需迁移或接管旧独立 OpenWiki 工作区；读取失败 MUST NOT 被当作空注册表静默覆盖。

#### Scenario: 环境变量与 profile 切换
- **WHEN** 用户设置有效 `OMP_CONFIG_ROOT` 或切换 OMP profile 后使用 OpenWiki，无论是否启用 `OMP_OFFLINE`
- **THEN** OMP 管理的 OpenWiki 用户级状态跟随该有效数据根和 profile；未设置有效 `OMP_CONFIG_ROOT` 时沿用 OMP 既有默认目录解析，`OMP_OFFLINE` 本身不改变数据根
- **AND** OMP 内置路径不使用 OpenWiki 独立安装的默认 home 或 `OPENWIKI_CONFIG_DIR` 作为平行活动数据根；独立运行的 OpenWiki fork 保留自身原有目录规则

#### Scenario: 仓库数据保持项目内布局
- **WHEN** 用户改变 `OMP_CONFIG_ROOT`、profile 或 `OMP_OFFLINE` 后生成、更新或查询仓库 Wiki
- **THEN** 仓库内既有 `openwiki/`、Claims、manifest 和 checkpoint 仍保持项目内布局，不随用户级数据根搬迁，也不影响已有仓库 Wiki 的格式兼容

#### Scenario: 不接管旧独立工作区
- **WHEN** 用户首次使用 OMP 内置 OpenWiki 工作区
- **THEN** 工作区按当前 OMP profile 的状态运行；本次不要求读取、迁移或接管独立 OpenWiki 已有工作区注册表，不修改或删除旧注册表
- **AND** 只读查询不写工作区注册表，也不导入个人知识库、连接器或独立 OpenWiki 凭据

### Requirement: 可选性能数据根

OMP MUST 提供可选的 `OMP_CACHE_DIR`，用于分离既有 Cache、统计、日志和默认 native；配置、会话、Knowledge 向量、Repo 索引及其他持久数据保持原有位置。

#### Scenario: 显式选择性能根
- **WHEN** `OMP_CACHE_DIR` 经首尾空白处理和 `~` 展开后为绝对路径
- **THEN** OMP MUST 在 Linux 下以 `<OMP_CACHE_DIR>/<UID>` 作为性能数据根，`<UID>` 为当前用户的数字 UID；Windows 直接以该路径作为性能数据根；保留既有相对布局及命名 profile 的 `profiles/<name>/` 布局，不额外添加哈希、持久根或 SDK 身份目录
- **AND** 此选择在 offline 和普通模式均生效；已有专用路径覆盖（如 `PI_NATIVES_DIR`）保留原有优先级与行为

#### Scenario: Linux offline 默认性能根
- **WHEN** 没有有效显式 `OMP_CACHE_DIR`，且 Linux 进程按既有 `OMP_OFFLINE` 真值规则启用 offline
- **THEN** OMP MUST 使用 `/dev/shm/omp-<UID>` 作为性能数据根，`<UID>` 为当前用户的数字 UID，不再追加 UID，并保留既有 profile 布局

#### Scenario: 未选择性能根
- **WHEN** 没有有效显式 `OMP_CACHE_DIR`，且不是 Linux offline
- **THEN** OMP MUST 保留原有目录及适用的 XDG 路由，不新增默认目录；空值或相对值不作为显式性能根，也不相对当前工作目录解析

#### Scenario: 性能与持久数据归属
- **WHEN** 选择了性能数据根
- **THEN** 原有 Cache 的全部内容（包括模型与运行依赖）、统计数据库及配套文件、运行和安装日志、默认 native 及其缓存 MUST 使用所选根下既有相对布局
- **AND** 配置、认证、会话、Knowledge 数据库与已生成向量、Repo 数据库及索引、其他未迁移的用户状态和项目数据 MUST 保持原有位置
- **AND** 原有日志级别、错误处理、回退和专用覆盖规则不因目录选择而改变

#### Scenario: 性能数据丢失或切换
- **WHEN** 性能目录被清空或切换
- **THEN** 统计、日志和缓存允许丢失；非内嵌资源的缺失和下载遵循原有规则，持久数据不随之删除或重置
- **AND** 不自动搬迁、合并或删除旧目录，也不新增双写或恢复服务

#### Scenario: 轻量目录选择
- **WHEN** OMP 启动或运行并选择性能目录
- **THEN** 目录选择 MUST NOT 增加预检查、目录测速或后台服务；本功能旨在减少相关 NFS 访问，不承诺未经测量的性能收益
