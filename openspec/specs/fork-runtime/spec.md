# fork-runtime

## Purpose

fork 运行、路径、诊断、分发、[审批](#requirement-授权模式与默认值)及交互 [Shell／内建](#requirement-非-utf-8-参数保真与派发)兼容与隔离。审批继承[上游基线](../../../docs/approval-mode.md)。

## Requirements

### Requirement: 项目定位与使用场景

个人入口 MUST 使用原生 TUI，无需手填 OMP 配置；零配置不禁止持久化。

#### Scenario: 零配置
- **WHEN** 零配置、服务/认证就绪
- **THEN** 终端收发/用工具；内网无公网可用、复用凭据。

### Requirement: 运行诊断日志

`operation_id` MUST 关联请求、任务、目标、会话和工具调用；异步继承，跨进程尽量透传，不改协议。

#### Scenario: 日志启停
- **WHEN** 启停、重启或执行受观测操作
- **THEN** 按[性能根](#requirement-可选性能数据根)或原路由新建日志，重名顺延，沿用轮转、保留与刷新。统一记录关键阶段、状态与 `elapsed_ms`，区分失败、超时、取消、降级、部分提交和未知；正常取消、缺服务或预期拒绝不记作故障。成功不掩盖 UI、重载或 Goal 恢复异常。
- **AND** 网络、IPC、子进程、offline 目录初始化及 selector-miss 记录适用起止和结局；WSL 预检拒绝只记有界原因。凭据、认证头、敏感 URL 和输入输出正文不落日志；诊断字段和截取大小有界。
- **AND** 写入失败回退用户目录，再回退有界 stderr，不改执行结果。offline 默认即时刷新 WARN／ERROR；有效 `OMP_LOG_LEVEL` 优先，低级别日志在入口滤除，INFO／DEBUG 恢复对应阶段日志。普通模式、UI、工具及协议不变。

### Requirement: offline 环境专用系统提示词

CLI／SDK／task MUST 共用模板，仅 offline 注入。这是提示，不是权限、隔离或路径机制。

#### Scenario: offline 注入
- **WHEN** 创建或恢复会话，或生成最终 Provider 上下文
- **THEN** 保留自定义提示，替换时不绕过，只注入一次。以 CentOS 7／NFS／无公网为工作假设而非探测结果；优先本地资料、依赖、可用技能和已配内网服务，不回退公网或反复联网安装，缺项如实报告。区分 Eval 与业务 Python，不因此改项目语法或依赖。
- **AND** Linux 的持久材料和必要备份写入获准 NFS；可重建内容优先用户 `/dev/shm`，不足再用获准 NFS；不用 `/local`、`/tmp`、`/run/user` 或将唯一副本留在共享内存。csh／tcsh 的可复制命令用对应语法和激活脚本，Bash 工具仍用 Bash；不假定子进程继承别名。
- **AND** 不改变执行器或用户配置，不自动安装、切环境或迁数据。

### Requirement: 安装与运行

OMP MUST 按以下优先级解析运行配置；安装或更新失败时保留旧版或已验产物，并报告实际结果。

#### Scenario: 安装
- **WHEN** 启动、安装或更新
- **THEN** 按下列边界执行，不改用户配置或持久数据布局。

**配置与路径**

| 项目 | 规则 |
|---|---|
| 公司模式 | `OMP_OFFLINE` 去空白后不分大小写接受 `1`／`true`／`yes`／`on`。子进程继承数据根及模型分流；不探测宿主、挂载或网络。红区必设该变量和可写绝对 `OMP_CONFIG_ROOT`；黄区可省略根。 |
| `--offline` | 启动和 `omp find` 仅覆盖本次 `models.offline`，与 `OMP_OFFLINE` 独立，可并用，不是防火墙。 |
| 持久根 | 绝对 `OMP_CONFIG_ROOT`（展开 `~`，忽略相对值）> `PI_CONFIG_DIR` > 上游；保留 profile、项目 `.omp/` 及原数据布局。`-P` 等同 `--profile`。 |
| native／grammar | 安装器和 loader 使用同一路径及 profile；`PI_NATIVES_DIR` 优先于[性能根](#requirement-可选性能数据根)。 |
| daemon | Linux 单用户 daemon／worker 共享宿主 native、offline 分流和 profile；其他 detached daemon 用自己的 runtime `natives/`。单 client 退出不终止共享 daemon，末 client 退出释放；creator 仅清本次独占资源。验证实际加载、双 worker 冷并发和无残留暂存。 |

**offline 运行（仅进程内覆盖）**

| 项目 | 规则 |
|---|---|
| 文件补全 | `@` 重扫间隔 30000ms，显式 `FS_SCAN_CACHE_TTL_MS`（含 0）优先。 |
| Linux TUI | 后台 ≤10 FPS；回显和取消优先，保留终刷、反压和自适应。渐变 250ms，活动计时 1000ms，Git 状态 TTL 60s；HEAD、cwd 或显式失效照旧，不依赖写通知或修改 Git 配置。 |
| 显示 | 流式 100ms，保留边界冲刷、逐增量语音、实时思考及输入调度。设 `tui.autoGraph=off`、`tui.titleState=false`、`title.refreshOnReplan=false`；保留首 scout 标题、手命名及其他显示和工具能力。 |
| 工具与目录 | 设 `web_search.enabled=false`、`browser.enabled=false`（含 `/crawl`）；HTTP 读取仍按 `fetch.enabled` 和审批。保留 AST 编辑，缺包只用显式源、不退 GitHub；内网模型及本地工具照用。启动不读更新日志；offline 禁止手动和自动检查或更新 OMP。`/changelog`、目录及模型／OAuth 请求照旧。`omp openspec version --check` 只使用显式非默认 HTTPS npm 镜像。 |
| 模型 | `company/Qwen3.8-27B` 上下文 262144，其余 company 聊天 204800；KDL 专限和 `maxTokens` 不变。仅在 company 可用时为未配置角色补默认，显式配置（含 `null`）及 CLI 优先，不锁定手动选模或写回配置。 |

角色默认：`default`／`plan`／`slow` 用 `company/GLM-5.3-public`；`smol`／`task`／`vision`／`advisor` 用 `company/Qwen3.8-27B`；`tiny`／`commit` 用 `company/Qwen3.6-35B-A3B`；`memory` 仍自动。保存或切换冲突只排除隐式默认。

Python Eval：显式解释器不可用或不兼容即失败。Linux offline 依次试 `/software/public/python/3.11.4/bin/python3.11`、原候选、PATH 中 `python3.15` 至 `python3.11`、`python3`、`python`，去重并实测 ≥3.11；其余环境沿用候选和 ≥3.8。新增发现仅用于 Eval 子进程，不继承 venv／Conda／PYTHONPATH，不修改主 PATH 或业务 Python，不扫描或安装。

**代理与 TLS**

- Windows 主进程 HTTP(S) `fetch` 逐跳按显式 `proxy`（含 `false`、`PI_PROXY_<PROVIDER>`／`PI_PROXY`）、目标 `HTTPS_PROXY`／`HTTP_PROXY`、`ALL_PROXY`、用户系统代理、直连排序。环境代理仅支持 HTTP(S) 或裸 `host:port`，遵守 `NO_PROXY`。本地服务 worker 不装系统代理，Unix socket 不变。
- 系统代理只读一次 HKCU Internet Settings 的启用状态和静态 HTTP(S) 代理，不用 SOCKS／PAC／WPAD；禁用或失败不接管。系统层独有公司清单及内网硬绕过，并遵守回环和 `NO_PROXY`；不限制显式或环境代理。公司清单包含主机、后缀、通配及 IP 前缀，匹配规则由清单维护。
- 仅 `redirect: "follow"` 跟随；跨源跳转去掉 Authorization、Proxy-Authorization、Cookie 和 Host。运行时不区分普通或 offline，默认不校验证书；agent `.env` 优先。未设置时 Node 使用 `NODE_TLS_REJECT_UNAUTHORIZED=0`，Git 未配校验时默认 `GIT_SSL_NO_VERIFY=true`。设置 `NODE_TLS_REJECT_UNAUTHORIZED=1` 或 Git 严格配置可恢复校验，严格时不向 Git 传 `GIT_SSL_NO_VERIFY=false` 字符串。worker 不另设。

**构建、更新与安装**

| 项目 | 规则 |
|---|---|
| Windows 本地构建 | `bun run local` 只编译和替换 `omp.exe`，占用时让位、不杀，失败恢复；不跑测试、冒烟、worker 或加载探测（`--skip-load-probe`）。CNB 发布版嵌入 fork 版本及 CNB 更新源，本地版只嵌入更新源。报告平台、构建阶段和适用签名，全部成功才报告产物实路径及耗时。 |
| 更新源 | 安装和更新均只用 CNB，默认取 `jchanghong/bin` 的 `omp` 发布，不回退其他平台。认证按 CNB 规则，SHA-256 取发布资产元数据。版本先按 SemVer、再按同基线 `+fork.N` 排序（缺省 0）。 |
| `omp update` | 仅非 offline 可手动执行；offline 明确拒绝，不请求更新源。仅原位替换独立二进制；包管理安装只提示 fork 安装器。TTY 才显示进度；目标和 PATH 实文件不同则预警并提示核对版本。canary 不支持，显式更新提示 stable。 |
| 安装门禁 | 仅安装 CNB 发布的 Linux glibc x64／Windows x64 二进制；联网前拒 macOS、源码安装和目录目标。同版不下载，仍查 PATH。元数据严格 TLS；仅二进制下载可放宽。Windows 支持 PowerShell 5.1 x64，优先 `curl.exe`，失败或不可用时回退 `Invoke-WebRequest`；遵守代理边界。updater 不依赖 PowerShell。 |
| 校验和换入 | 同目录唯一临时文件，先验同名资产 SHA-256、再实跑完整版本号；失败不执行未验产物、不替换旧版。Linux 原子换入，不[结束运行会话](#requirement-posix-安装器对运行中会话的检测)；Windows 先唯一改名让位，失败才[按身份回退](#requirement-windows-安装器强杀回退的身份校验)，换入失败则回滚并保留已验产物。 |
| 恢复与回执 | 只在目标缺失时恢复旧版，重试锁定同一 CNB 发布和目标目录并核对目标和 PATH；下次尽力清旧映像。PATH 失败报部分完成，清理失败不推翻换入结果。只改 PATH，不写用户配置；Windows 失败给阶段、原错、目标、日志及正确引用路径的恢复命令。 |

### Requirement: 宿主 Cargo 单变体发布构建

CNB MUST 使用宿主 Cargo，不跑 Bazel、测试、冒烟、worker、加载探测或试跑；普通 `bun run build:native` 以及 native 安装换入与回滚沿用上游。

#### Scenario: 发布构建
- **WHEN** CNB 构建发布产物
- **THEN** 只构建并嵌入当前 x64 宿主对应的带戳 addon：

| 资产 | 工具链及兼容性 | addon |
|---|---|---|
| `omp-linux-x64` | Cargo + Zig，glibc 2.17／CentOS 7，免 AVX2 | `pi_natives.linux-x64-baseline.node` |
| `omp-windows-x64.exe` | Cargo／MSVC，modern／AVX2 | `pi_natives.win32-x64-modern.node` |

自动选目标；`OMP_RELEASE_NATIVE_DIR` 默认 `packages/natives/native`，可用 `OMP_RELEASE_BINARY_DIR` 指定二进制目录。按仓库固定工具链和 Cargo `local` 构建，仅裁符号；以 Cargo 判断新鲜度，不额外扫描。复用按宿主、工具链及构建设置隔离的 Cargo／Bun 缓存与同字节 zstd 帧，不引入 Docker 或测试缓存。

### Requirement: CNB 精确输入缓存与四附件交付

CNB 发布须明确授权。CNB MUST 验证 Export viewer 精确字节元数据，不以 `tool-views.generated.js` 或全仓哈希判断，不重复预检或发布后复查。

#### Scenario: Git 同步
- **WHEN** 执行 `bun run cnb`
- **THEN** Windows 与 Ubuntu-24.04 WSL2（`/root/oh-my-pi`）均须父仓和 OpenWiki 子模块干净，经 Git 快进并检出固定子模块；确认提交和 Bun 版本相同后再并行。WSL 只经 Git 远端同步，不覆盖或清用户文件。
- **AND** 仅当提交、Bun、固定目标及全部发布输入一致，且同宿主已有完整成功的二进制与 SDK ZIP 时复用；否则重新构建和打包，失败或缺件不登记成功、不上传。SDK 使用同次宿主 addon，解包编译免 Rust；不含 CLI 二进制、已装依赖或个人设置。
- **AND** 两端齐备后并行上传并逐一确认两二进制、`omp-sdk-win32-x64.zip` 和 `omp-sdk-linux-x64.zip`。默认既有 `jchanghong/bin` 的 `omp`，可指定 `--repo`／`--tag`；无交互或 `--overwrite`；只覆盖本次同名资产，不动他件、不另传或推源码。分宿主报告缓存命中及构建、打包和上传耗时；部分上传不算交付。

### Requirement: 默认设置

缺省 MUST 遵循配置/env 优先级；`tools.approvalMode` 见[审批](#requirement-授权模式与默认值)。

#### Scenario: 应用缺省
- **WHEN** 无覆盖
- **THEN** 按表。

|设置|值|
|---|---|
|`recap.enabled`, `statusLine.compactThinkingLevel`, `commit.enabled`, `providers.thinkingProbe`|`false`；默认关闭 `/commit`/eval `commit`、未知模型探测（含内网/自有/自定义）。|
|`composer.shape`, `display.showTurnTime`, `mnemopi.embeddingVariant`|`box` (Rounded Box), `true`, `multilingual`|
|`async.maxJobs`, `startup.setupWizard`, `marketplace.autoUpdate`|`32`, `false`, `off`|
|`composer.predictions`|offline 仍用上游缺省 `true`；显式 `false` 优先。|
|界面|`compact` [契约及验收](../personal-commands/spec.md#requirement-1-三种显示模式)。|
|`terminal.programStatus`|offline 缺省关闭交互式 OSC 7501 探测/报告；显式优先、不落盘。|
|`lsp.enabled`|普通/offline `false`；验收 `--no-lsp` 覆盖已保存值、仅本次关；非 CLI 不变。|
|`stt.language`|`zh-CN`；本地 Whisper/云端转基语言（`zh`）。|

### Requirement: CLI 默认轻量启动参数

交互、print、RPC MUST 默认 `--no-extensions`，含扩展参数重解析；ACP 沿用[原规则](../../../docs/cli-reference.md)。

#### Scenario: 内置命令仍启用
- **WHEN** CLI 禁用自动扩展发现
- **THEN** 内置 TS 命令照常可见、补全和调用，不遍历用户或项目命令。显式扩展、hook、可信来源及 Skills、规则、MCP 不变，不写配置。受限 SDK 禁全部自定义命令；非受限 SDK 保持原发现和冲突规则。

### Requirement: Claude 插件发现默认关闭

Claude 插件发现 MUST 默认关闭，不新增开关。

#### Scenario: Claude 发现关闭
- **WHEN** 未启用来源时启动、创建或恢复会话
- **THEN** 不扫描插件注册表、缓存或 `enabledPlugins`，不加载其资源或为缺失、损坏告警。普通 `.claude`、公司配置及非插件技能不受影响。原生注册表、显式插件目录和可信入口照旧；显式发现或 `enabledProviders` 可恢复，`disabledProviders` 优先。发现范围按会话隔离。

### Requirement: 启动不检查 Python

Eval 注册 MUST 仅依现有后端设置，无新开关。

#### Scenario: 无 Python
- **WHEN** 启动、建/恢复会话（全入口/模式、含子代理）
- **THEN** 不测/预热/等 Python（含首提示/后台），不隐藏 Eval/警告；实际 Eval 才验、按需启内核，不可用报错；保留 `omp setup python --check`。

### Requirement: 后台任务并发上限

每根会话 MUST 共享 `async.maxJobs=32`（含 eval `agent()`），可降不可升，原解析/优先级、不落盘。

#### Scenario: 并发满
- **WHEN** 达有效上限
- **THEN** 按原注册/报错拒绝启动；排队/完成/失败/取消不占运行位，不加队列/改 `task.maxConcurrency`。

### Requirement: 全平台轻量启动

启动 MUST 惰性加载；无新设置，原显式入口。

#### Scenario: 启动
- **WHEN** 启动
- **THEN** 按表。

|功能|条件→行为|
|---|---|
|更新|任何启动模式均不自动检查 OMP 更新，不加载检查器、请求发行源或提示新版；仅非 offline 可显式检查和更新。|
|向导|非强制且（`startup.setupWizard=false` 或 offline）→即使 setupVersion 旧，不加载完整向导/场景/认证/浏览器、不选场景；offline 仅进程内 `false`。动画独立惰性；手动/强制/普通显式版控向导保留。|
|认证|offline 按[公司快照契约](../model-providers/spec.md#requirement-公司内网模型仅-omp_offline)初始化。|

### Requirement: 插件市场更新

offline MUST 只允许手动更新市场。

#### Scenario: 市场刷新
- **WHEN** offline
- **THEN** 无自动刷新/查/升级（含显式 `notify`/`auto`），不落盘；启用来源照载，浏览/列表只读缓存。

普通模式及手动更新沿[市场契约](../../../docs/marketplace.md#updates-removal-and-scope)；添加/刷新仅清遗留临时克隆。

### Requirement: 安装器诊断日志

安装诊断 MUST 脱敏、不阻断。

#### Scenario: 独建日志
- **WHEN** 安装器运行（同 PID 不复用）
- **THEN** `omp.install.<UTC 日期>.<epoch 毫秒>.<PID>.log`（`YYYY-MM-DD`）； `operation_id`, `stage`, `elapsed_ms`, `platform`, `target_version`、级别/事件/有界结果；版本 `v?` + 三段数字 + 可选 `+fork.<数字>`，否则 `redacted`。

性能根 `logs/`（原回退）> 绝对 `OMP_CONFIG_ROOT` 含 profile 或用户根（`PI_CONFIG_DIR`/`.omp`）`logs/`。无显式根且已有 `<XDG_STATE_HOME>/omp` 则用，不可写→`~/.local/state/omp`；Windows 数据根→`%LOCALAPPDATA%\omp`。回退 WARN；仅清同类，留 20 次/5 天，跳活 PID；写败 stderr 一行、不改退出码。

### Requirement: POSIX 安装器对运行中会话的检测

POSIX MUST NOT 结束使用目标的会话。

#### Scenario: POSIX 换入
- **WHEN** 换入前
- **THEN** `/proc/*/exe`（去 ` (deleted)`）与目标实路径（新装字面）匹配→仅报目标/PID/须重启用新版；无 `/proc`/未命中静默。

### Requirement: Windows 安装器强杀回退的身份校验

强杀 MUST 按完整映像路径，非仅进程名。

#### Scenario: 让位失败
- **WHEN** 旧映像无法改名
- **THEN** 同名进程完整路径与目标一致才可结束（忽略大小写）；任一不可读→`unsafe_identity` + PID，不猜。结束/等待限时，仍活→失败+PID；记路径策略/匹配及剩余数，无命令行。

### Requirement: Windows 内嵌 native 缓存的占用替换

Windows 换入失败 MUST NOT 用缺当前 shell trace API 的旧 addon。

#### Scenario: 旧 DLL 占用
- **WHEN** Windows 同版内嵌 addon 大小改变、旧 DLL 仍加载
- **THEN** 原子换 > 同目录唯一让位；不杀旧、不改缓存路径名；旧用已载 addon，新用 `RunTrace`。失败恢复，回滚失败留新旧报路径；清旧失败非换入失败。

验实际 DLL 占用回退、换后字节、新 shell trace、旧进程；普通 native/`local`/`cnb` 验证授权不变。

### Requirement: native 能力缺失时的运行期降级

管道 MUST 可独立于 Bash 降级。

#### Scenario: 无流
- **WHEN** addon 缺管道流类或实例化失败
- **THEN** Bash 照常，不抛错/改交互 PTY；`proc://<id>/streams`/管道组件报无流，job 状态/退出码/读输出不变；其他 native 缺失诊断照旧。

### Requirement: 被中断工具结果的取消标记

取消 MUST 独立于错误持久化。

#### Scenario: 中断
- **WHEN** 中断跳过执行、取消授权等待或信号打断执行
- **THEN** 持久化 `cancelled: true`（与 `isError` 并存），供会话/fork 复制/投影/上层区分；原内容/退出码，迟到不重标，未启的不可中断工具仍执行。

### Requirement: 会话通信回执

`irc` MUST 按身份还原，非按顺序/文本。

#### Scenario: 回执及恢复
- **WHEN** `outcome` 非 `failed` 或恢复通信
- **THEN** 成功存原消息 `id`/`ts`；恢复仅按身份/接收记录去重。缺身份保不完整事实、不推断两条；失败不造身份，参数/路由/唤醒/权限不变。

### Requirement: 可选性能数据根

`OMP_CACHE_DIR` MUST NOT 迁持久数据。

#### Scenario: 选根
- **WHEN** 解析性能根
- **THEN** 分流 Cache/统计及配套/运行安装日志/默认 native；保布局/`profiles/<name>/`，无哈希/持久根/SDK 身份目录；保 `PI_NATIVES_DIR`/显式模型库等覆盖。

|顺序（空/相对不按 cwd 解析）|路径|
|---|---|
|`OMP_CACHE_DIR` trim/展开 `~` 后绝对|Linux `<OMP_CACHE_DIR>/<UID>`（当前数字 UID）；Windows 原路径|
|否则 Linux offline|`/dev/shm/omp-<UID>`，不再加 UID|
|否则|原路由/XDG|

#### Scenario: Linux offline 默认性能根
- **WHEN** 隐式 `/dev/shm`
- **THEN** 无可执行挂载要求/探测；编译版 JS eval `cache/bun-stub`/执行映射 addon 绕性能根（已初始化且适用 XDG cache > 配置根，保 profile），grammar 等照用。WebKit 主程序：显式性能根 > 显式配置根 > 上游共享。

选根包含适用的运行依赖。持久配置/认证/会话/用户及项目数据、日志级别/回退/错误、非内嵌资源缺失/下载不变。清/切仅可丢性能数据；禁迁/并/删旧、预检/测速/新配置/层级/后台/双写/备份恢复；无实测速益承诺。

### Requirement: 公司 offline 内网 Git API 可用

MUST 区分无公网与内网 Git API 不可用。

#### Scenario: 内网 PR/MR
- **WHEN** 内网 PR/MR 查询/创建
- **THEN** 按平台/已配接入判断，不因 offline 要求手工建 MR；能力非授权，不猜产品/API 地址/认证格式/自动合并。

### Requirement: 授权模式与默认值

`tools.approvalMode` 与 `--approval-mode` MUST 均接受新增值 `guarded`，参数非法时的支持值须含 `guarded`；不改上游默认。

#### Scenario: 启动参数覆盖设置项

- **WHEN** 配置 `write`、传入 `--approval-mode guarded`
- **THEN** MUST 仅本进程用 `guarded`，不写配置

### Requirement: 授权模式的放行边界

`guarded` MUST 自动放行未受额外约束的读/写/执行；`always-ask-cached` 的执行调用不得复用文件/目录授权。

#### Scenario: guarded 放行普通调用但危险操作仍确认

- **WHEN** `guarded` 下工具声明本次危险操作覆盖
- **THEN** MUST 逐次确认，禁复用缓存或记住本次授权

### Requirement: 用户策略与受限目录始终有效

`tools.approval` 的 `prompt` MUST 压过工具声明的 `allow`；`guarded` 不豁免逐工具策略及受限目录。

#### Scenario: 受限目录内调用

- **WHEN** `guarded` 调用触及 `tools.restrictedFolders` 目录或子目录
- **THEN** MUST 逐次确认，不复用授权

### Requirement: 非 UTF-8 参数保真与派发
外部 `argv` MUST 用 OS 字符串保留非 UTF-8 参数原字节（禁替换、截断、重编码；含延迟 FIFO 重定向经 `/bin/sh` 转发）。仅参数非 UTF-8：仅声明接受原参的内建可自行处理，其余 MUST 改派外部程序并传原参。

#### Scenario: 原生命令名的派发绕过内建与函数
- **WHEN** 命令名非 UTF-8
- **THEN** MUST 绕过内建、函数，直接按 `PATH`（含 cwd 等相对项）查找执行；禁仅因解码失败报“未找到”或复用 UTF-8 名称解析缓存。

### Requirement: 内建命令无法接受非 UTF-8 参数时的失败契约
内建无法消费非 UTF-8 参数 MUST 明确失败，禁静默丢参续跑。
- `declare`/`local`/`readonly`（stderr、通用非零退出）：显示模式，操作数非 UTF-8 或含 `=` → `<实际命令名>: <操作数>: not found`（函数内 `local -p` 用 `local:`，非 `declare:`）；定义模式，变量名非 UTF-8 → `<命令名>: <操作数>: not a valid variable name`；合法 `name=value` 不因赋值被拒。
- `export` 非 UTF-8 操作数 → stderr `export: <操作数>: invalid variable name`，用法码 `2`。

#### Scenario: 通用内建拒绝非 UTF-8 参数
- **WHEN** 内建的普通字符串参数非 UTF-8
- **THEN** 内部错误 `builtin cannot accept non-UTF-8 argument`；不得以余参续跑并产生副作用。

### Requirement: Windows 内建 rsync 路径
Windows 内建 `rsync` MUST 支持 UNC 及 verbatim 路径。

#### Scenario: UNC 和 verbatim 路径
- **WHEN** 扫描本地目录或访问过滤文件
- **THEN** 支持两种路径；设 `--confine-root` 时，逐目录 merge 的根内过滤生效，不读根外过滤文件、不改变传输根。

### Requirement: `timeout` 的保留状态退出码
`timeout` 超时终止操作数 MUST 返回（`--preserve-status`/默认）：非 Windows 投递 KILL `137`/`137`；POSIX 投递其他信号 `N`：`128 + N`/`124`；Windows 无法投递信号而取消进程内操作数 `128`/`124`。

#### Scenario: 信号致死与取消回退
- **WHEN** Windows 进程内操作数忽略初次取消并达 `-k` 升级期限
- **THEN** 取消回退仍非 KILL。

### Requirement: 进程树信号的快照式投递
每波前 MUST 快照目标，禁同波组投递后重枚举、重投组已覆盖成员；仅组投递失败 MUST 按成员句柄回退。本波 TERM 处理器立即创建的清理子进程不收本波信号。
范围仅限实际启动的外部成员及其进程组；禁向宿主 PID 或其子树发信号，误列宿主为后代须剪除整棵子树。

#### Scenario: 取消作用域与宿主保护
- **WHEN** 取消清理多进程管道或单进程命令
- **THEN** 管道覆盖全部此类成员（含脱离子进程组的输入阶段），单进程仅自身。

### Requirement: 取消后的管道等待宽限
已启动子进程的管道取消时 MUST 保留 TERM 清理宽限，禁提前返回并立即硬杀。

#### Scenario: 取消不缩短清理宽限
- **WHEN** 管道成员成功启动后收到取消信号
- **THEN** MUST 等至成员按 TERM 清理规则结束；轮询回收已停止成员，余者按取消语义等待；禁立即销毁进程句柄。

### Requirement: 逐输入元数据边界

Enqueue MUST support per-input metadata; never send as Provider options or widen restricted sessions' tool list or authorization.

#### Scenario: Metadata
- **WHEN** tool denylist, `sourceCommand.automationId` or attachments (refs/filename/MIME/bytes/etc.) accompany input
- **THEN** runtime queue and journal retain them for turn tool availability and provenance.
