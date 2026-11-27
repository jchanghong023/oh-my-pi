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

`operation_id` MUST 关联 request/job/goal/session/tool-call，异步/独立响应继承，跨进程尽量透传、不改协议。

#### Scenario: 日志启停
- **WHEN** 启停/重启（含 PID 复用）
- **THEN** [性能根](#requirement-可选性能数据根)或原路由新建日志，重名沿原数字后缀；记启停/刷关键项，原轮转/保留/刷新。

- 共用 logger（Team/Goal/knowledge/AST 通知/company/向量/安装更新），不增系统/必填配置。异常/超时/重试/降级/部分提交：稳定事件/组件/阶段/安全结果/`elapsed_ms`；阻塞风险/网络/IPC/子进程：起止/成败/取消，非仅前台/协议/会话 JSONL。
- 对话终态：用户取消/宿主或本地超时/abort/断连/失败；正常取消/缺服务/预期拒绝非故障。成功不盖面板异常/保存后重载降级/Goal 激活恢复失败或状态无效；不限 DEBUG。删除：主文件/备份/附件 × 已提交/部分清理/未知。Team 通知/UI 更新分记；内部终止仅安全原因类。
- offline models/bench cache-only 限目录发现/刷新；关联 init/selector-miss 起止。WSL helper 预检拒绝仅有界原因码。
- 禁记凭据、Authorization/Cookie、URL 认证/敏感查询、输入/提示/源码/文档/响应正文；仅有界脱敏类型/代码/状态/计数/长度/必要栈帧，stdout/stderr/大对象限量。
- 写败→用户目录→有界 stderr；禁递归/崩溃/掩结果、改流程/权限/重试/超时。验真实成败/适用网络/IPC/子进程异常/关联重建/脱敏。
- offline 默认 WARN/ERROR（含故障/降级/目录回退）即时刷；有效 `OMP_LOG_LEVEL`（`error`/`warn`/`info`/`debug`）覆盖。入口滤低优先级、不聚合/序列化上下文/进 sink；INFO/DEBUG 恢复相应起止/正常阶段。空日志不证无故障；普通级别/UI/工具/协议不变。

### Requirement: offline 环境专用系统提示词

CLI/SDK/task MUST 共用模板/条件渲染，仅 offline 追加。

#### Scenario: offline 注入
- **WHEN** 建/恢复会话或生成最终 provider 上下文
- **THEN** 保自定义；替换不绕过，完整规则不重加，普通模式不变。

|范围|静态提示（非隔离/权限/路径机制）|
|---|---|
|offline|基线 CentOS 7/NFS/`/dev/shm`/无公网，非检测；不硬编码用户/内网地址/版本/历史余量。用本地资料/依赖/团队 Skills/已配内网服务；禁公网/退公网源/反复联网装；报缺项。区分 Eval/检查/业务 Python，不因工具升级项目语法/依赖。|
|另：Linux|持久材料/必要备份→获准可写 NFS；临时/可重建优先用户 `/dev/shm`，不存持久唯一副本；不足退获准 NFS，禁 `/local`、`/tmp`、`/run/user`。复用数据根/共享 Skills，不假定 sudo/计算 GPU/新工具。|
|另：Linux + `SHELL` basename=`csh`/`tcsh`|可复制命令用 `setenv`/`unsetenv`/对应激活脚本；`bash` 工具仍 Bash。必要时确认、显式初始化 csh/tcsh；不假定子进程有 `ma`/`module` alias，不用 Bash source `.cshrc`。|

不改 Shell 执行器/配置，不自动装/切环境/迁数据。

### Requirement: 安装与运行

OMP MUST 按下表路由及换入。

#### Scenario: 安装
- **WHEN** 启动/安装/更新
- **THEN** 按表；失败留旧/已验产物并实报。

|范围|解析|
|---|---|
|公司|`OMP_OFFLINE` ∈ `1`/`true`/`yes`/`on`（trim/casefold）；OMP 子进程继承、同数据根/模型 lane；不探测宿主/挂载/网络，已配可达内网可用。|
|`--offline`（启动/`omp find`）|仅本次 `models.offline` 辅助 provider 限制，非防火墙；与 `OMP_OFFLINE` 独立/可并用。|
|红/黄|红区启动必设 `OMP_OFFLINE`/可写绝对 `OMP_CONFIG_ROOT`；黄区根可选、同回退。|
|持久根|绝对 `OMP_CONFIG_ROOT`（展开 `~`、忽略相对）> `PI_CONFIG_DIR` > 上游；不硬编码 `.omp`，保 agent 配置/认证/会话/用户资源/状态/profile 布局、项目 `.omp/`；`-P <name>` = `--profile <name>`，无需 alias。|
|native/grammar|loader/安装器同 grammar 路径/profile；有效 `PI_NATIVES_DIR` > [性能根](#requirement-可选性能数据根)，持久布局不变。禁 `OMP_WIKI_DIR` 读/排序/专传/别名/专设。|
|daemon|Linux 单用户 daemon/worker 共享宿主 `PI_NATIVES_DIR`/offline 分流/profile，无 runtime 副本/单会话清理；其他 detached daemon 自有 runtime `natives/`，独立于 creator/core `PI_NATIVES_DIR`。单 client 不关共享 daemon。|

验收 daemon 真加载：creator 退出即删独占叶（Windows 无 EPERM），另一 client 照用；末 client 退出停 daemon/释缓存。双 worker 冷并发提取/加载完整 native，发布字节不变、无 staging。

|offline（覆盖不落盘）|生效项|
|---|---|
|`@`|补全重扫 `30000`ms；显式 `FS_SCAN_CACHE_TTL_MS`（含 `0`）优先。|
|Linux 交互|后台 TUI ≤10 FPS、回显/取消优先，终刷/反压/自适应不变。渐变 250ms、活动计时 1000ms；Git 状态 TTL 60s，HEAD/cwd/显式失效不变，外写可滞后。不依赖工具写通知，不改 Git 配置或企业远程软件，不承诺实机提速。|
|显示|流式 100ms，保留边界即时冲刷、逐增量语音、实时思考、输入/绘制调度。强制 `tui.autoGraph=off`、`tui.titleState=false`、`title.refreshOnReplan=false`；保首 scout 自动标题/手命名/表格/补全/富媒体/缓存裁剪/LSP/MCP。|
|CLI|强制 `web_search.enabled=false`、`browser.enabled=false`（含 `/crawl`）；`contextWindow` tokens：`company/Qwen3.8-27B` 262144、其他 company 聊天 204800；KDL 专限及 `maxTokens` 不变。|
|工具|Agent `read`/`omp read` HTTP(S) 按 `fetch.enabled`/审批；保 `astEdit.enabled`，内置/缓存缺包→仅显式源、不退 GitHub。内网模型 API/bash/eval/文件/LSP/Git/Computer Use 保留。|
|更新/目录|启动不读/显示更新日志；`models.offline`、内置/缓存目录、模型/OAuth 请求、更新/`/changelog` 不变。`omp openspec version --check` 仅 `npm_config_registry` 显式非默认 HTTPS 镜像。|

**Python Eval**：显式 `python.interpreter` 不可用/不兼容即失败、不回退。Linux offline： `/software/public/python/3.11.4/bin/python3.11` > 原候选 > PATH `python3.15` 至 `python3.11`、`python3`、`python`；去重、实测 ≥3.11，跳失效/旧版（业务 3.6/3.10），无匹配报错；其余原候选/≥3.8。新发现仅 Eval 子进程用，清 venv/Conda/PYTHONPATH，不改主 PATH/项目 venv/业务 Python，不扫/安装。

**角色**：offline 缺角色且 company 可用才补（显式含 `null`、CLI 优先）：`default`/`plan`/`slow`=`company/GLM-5.3-public`，`smol`/`task`/`vision`/`advisor`=`company/Qwen3.8-27B`，`tiny`/`commit`=`company/Qwen3.6-35B-A3B`；`memory` 仍自动。不限 `/model`/`Ctrl+T`/角色切换，不锁 company；保存/活动匹配/切换冲突仅排隐式。

|主进程|网络|
|---|---|
|Windows 全局 HTTP(S) `fetch`|LLM 流/OAuth/usage/发现/更新检查/web；本地服务 worker 无系统层；Unix socket 不变。逐跳重选；`redirect: "follow"` 才跟随（保 `"manual"`/`"error"`）；跨源剥 `Authorization`、`Proxy-Authorization`、`Cookie`、`Host`。|
|逐跳优先级|显式 `proxy`（含 `false`、`PI_PROXY_<PROVIDER>`/`PI_PROXY`）> 目标 `HTTPS_PROXY`/`HTTP_PROXY` > `ALL_PROXY`（含小写）> 用户系统代理 > 直连；env 仅 HTTP(S)/裸 `host:port` 交 Bun（`NO_PROXY`）；SOCKS 等跳过。|
|系统层|HKCU Internet Settings `ProxyEnable`/`ProxyServer` 每进程读一次：静态 `http=`/`https=`，无 `socks=`/PAC/WPAD；禁用/失败不装层。受 `NO_PROXY`/回环/内网硬 bypass/公司清单；清单不限制显式/env。|
|公司清单|`packages/ai/src/utils/fork-system-proxy-bypass.ts` 的 `FORK_SYSTEM_PROXY_BYPASS`：公司后缀/主机/通配/CGNAT/RFC1918 式前缀（`10.`、`100.64.`–`100.126.`、`172.16.`–`172.32.`、`7.` 等）。去前导 `-` 后：数字开头=IP 前缀，`*`=整机名 glob，首尾点=标签包含，仅首点=域后缀，其余精确/点后缀。|
|跨平台 TLS|agent `.env` 优先；缺 `NODE_TLS_REJECT_UNAUTHORIZED` 用 `0`、Git 未配校验用 `GIT_SSL_NO_VERIFY=true`。`1`/`false` 严、`0`/`true` 松；Git 禁传字符串 `false`（键存在即禁证书/主机名验证）。worker 不另设；松失端点验证，仅受控环境。|

|构建/更新|边界|
|---|---|
|发布|仅个人分发；[发布须独立明示授权](../fork-maintenance/spec.md#scenario-验证授权与证据独立)。|
|Windows `bun run local`|编译换 `omp.exe`：让位、不杀、败则恢复、留占用映像；禁测试/冒烟/启动 worker/native 探测/试跑； `--skip-load-probe`。|
|嵌入/回执|Release 嵌 fork 版本/更新仓库；本地 `packages/coding-agent/scripts/build-binary.ts` 只嵌仓库（`--version` 可无 `+fork.N`）。终端报平台/资源生成/编译/适用签名/还原生成文件；全过才报完成/实路径/总耗时，编译可静默。|
|`omp update` 源|`PI_UPDATE_REPOSITORY` > fork GitHub Release，不退官方、不写配置/产物；CNB 不改源。SemVer > 同基线 fork counter（无 `+fork.N`=0）；URL `%2B`。GitHub 元数据/资产认证 env token > `gh auth token` > 匿名，SHA-256 取资产元数据。|
|执行|仅原位换独立二进制；包管理仅提示 fork 安装器。交互 TTY 才报 %/速度/ETA；PATH 实文件不同→预警、提示事后 `omp --version`。不支持 `update.channel=canary`：显式更新提示配置/`omp update --stable`；启动静默不查。|

|安装顺序|门禁|
|---|---|
|资格|仅 fork Release Linux glibc x64/Windows x64 二进制；`install.sh` 联网前拒 macOS；禁源码安装及其 CI 冒烟。|
|目标/元数据|联网前拒目录目标、不移内容；元数据仅严格 TLS（信企业代理 CA），运行时 TLS/updater 不变。同版报已装、免下载，仍查/提示 PATH。|
|下载|安装目录唯一临时文件；仅二进制资产可放宽：curl `--insecure`；`--ssl-no-revoke` 限 Windows 或支持的 POSIX Schannel。PS5.1 证书放行回调须保 TLS 1.2；7+ 可 `-SkipCertificateCheck`。|
|Windows 客户端|支持系统 Windows PowerShell 5.1 x64；`curl.exe` 优先，缺目标代理 env 及 `ALL_PROXY` 才传用户系统代理；遵守 `NO_PROXY`。失败/不可用→ `Invoke-WebRequest -UseBasicParsing`。`omp update` 自办 HTTP/SHA-256/替换，无需 `pwsh.exe`。|
|验证|已验元数据同名资产 SHA-256（缺/异禁执行）→试启动/`omp --version` 完全匹配 Release→换入；验证败留旧/清临时。|
|换入|Linux 同目录原子 `mv`；Windows 唯一 `.omp.old.*` 让位、换败回滚；让位失败才[校验后强杀](#requirement-windows-安装器强杀回退的身份校验)。下次尽力清 `.omp.old.*`；换败留已验 `.omp.tmp.*`；回滚失败另留旧。|
|恢复|Windows 已验留存可跑、未验禁跑；目标不存在才恢复旧；锁 Release/目录重试，核目标/PATH 版本。换后 PATH 失败=部分完成；清理失败给详情/安全重试，占用可等退出；不改结果。|
|配置/错误|只改 PATH，不写旧 `settings.json`/用户 shell/`config.yml`。Windows 下载后验证/让位或强杀/换入/回滚/PATH 失败：报阶段/原错/类型和代码/目标/可用日志/可执行 PowerShell 命令（正确引用路径）；详情仅终端、日志脱敏。|

### Requirement: 宿主 Cargo 单变体发布构建

CNB/手动 CI MUST 共用宿主 Cargo，禁 Bazel/测试/冒烟/worker/native 探测/试跑；其他平台和 `bun run build:native` 默认探测不变。

#### Scenario: 发布构建
- **WHEN** 构建 Release
- **THEN** 对应 x64 宿主跑 `bun scripts/build-release-native.ts`、`bun scripts/ci-release-build-binaries.ts`；只构建/嵌入对应带戳 addon。

|资产|工具链/目标|唯一 addon / 兼容性|
|---|---|---|
|`omp-linux-x64`|Cargo+Zig；`x86_64-unknown-linux-gnu.2.17`|`pi_natives.linux-x64-baseline.node`；CentOS 7/glibc 2.17 固定、免 AVX2|
|`omp-windows-x64.exe`|Cargo/MSVC|`pi_natives.win32-x64-modern.node`；modern/AVX2|

- 自动选目标；canonical addon/戳读写绝对 `OMP_RELEASE_NATIVE_DIR`（默认 `packages/natives/native`）；可选 `OMP_RELEASE_BINARY_DIR`，名如上。
- Cargo `local`、`CARGO_PROFILE_LOCAL_STRIP=symbols`、thin LTO、16 codegen units、增量；新鲜度由 Cargo 判；无额外指纹/全仓扫。复用 Cargo registry/git/target、Bun 依赖/资源及 `OMP_BUILD_CACHE_DIR` 同字节 zstd 帧；CNB 持久缓存/输出树外，无 Docker/检查测试缓存。
- CI 双宿主按 `rust-toolchain.toml` 安装 Rust；Linux 加 `cargo-zigbuild==0.24.1`、`ziglang==0.14.1`。cache actions 固定；Cargo 缓存分平台/变体/工具链/`local-strip-symbols`，稳定恢复前缀；无 Bazel matrix/cache action、native artifact 汇总。

### Requirement: CNB 精确输入缓存与四附件交付

CNB MUST 验 Export viewer 精确字节元数据；忽略生成物 `tool-views.generated.js`。禁全仓哈希/重复 WSL 预检/附件竞态/发布后复查。

#### Scenario: Git 同步
- **WHEN** `bun run cnb`
- **THEN** Windows 与 Ubuntu-24.04 WSL2 `/root/oh-my-pi`：查父仓/OpenWiki 子模块干净→`git pull --ff-only`/检出父仓固定子模块→复核干净、提交/Bun 版本同→并行建/复用。WSL 源码/脚本仅 Git 远端；禁强盖/stdin 传脚本/复制移动补丁清用户文件绕过。

|阶段|边界|
|---|---|
|命中|同宿主成功且齐全的二进制+SDK ZIP，干净提交/Bun/固定目标/发布环境（含版本/仓库/构建设置）全同→跳 native/打包，报复用。其余共享入口实建实包，成功登记；败/缺不复用/上传；中间缓存独立。|
|SDK ZIP|同次宿主 addon（上表变体），禁残留/重编；含宿主入口/锁/编译输入，无 CLI 二进制/已装依赖/个人设置；解包编译免 Rust，Linux Bun x64 baseline。|
|上传|两端齐才并行覆盖、逐一确认上表两二进制及 `omp-sdk-win32-x64.zip`、`omp-sdk-linux-x64.zip`。默认既有 `jchanghong/bin` `omp`；`--repo`/`--tag`，无交互/`--overwrite`，禁动他件/传独立源包/推源/替代 GitHub Release。|
|计时|持久暖缓存目标约 120s（启动至四次上传接口确认）；分宿主报 native、二进制/SDK 打包、上传耗时及命中；实报未测/未达/上传败，局部非交付。|

### Requirement: 默认设置

缺省 MUST 遵循配置/env 优先级；`tools.approvalMode` 见[审批](#requirement-授权模式与默认值)。

#### Scenario: 应用缺省
- **WHEN** 无覆盖
- **THEN** 按表。

|设置|值|
|---|---|
|`recap.enabled`, `statusLine.compactThinkingLevel`, `commit.enabled`, `providers.thinkingProbe`|`false`；默认关闭 `/commit`/eval `commit`、未知模型探测（含内网/自有/自定义）。|
|`composer.shape`, `display.showTurnTime`, `mnemopi.embeddingVariant`|`box` (Rounded Box), `true`, `multilingual`|
|`async.maxJobs`, `startup.setupWizard`, `startup.checkUpdate`, `marketplace.autoUpdate`|`32`, `false`, `false`, `off`|
|`composer.predictions`|offline 仍用上游缺省 `true`；显式 `false` 优先。|
|界面|`compact` [契约及验收](../personal-commands/spec.md#requirement-1-三种显示模式)。|
|`terminal.programStatus`|offline 缺省关闭交互式 OSC 7501 探测/报告；显式优先、不落盘。|
|`lsp.enabled`|普通/offline `false`；验收 `--no-lsp` 覆盖已保存值、仅本次关；非 CLI 不变。|
|`stt.language`|`zh-CN`；本地 Whisper/云端转基语言（`zh`）。|

### Requirement: CLI 默认轻量启动参数

交互/print/RPC MUST 默认 `--no-extensions`（含扩展参数重解析）；ACP [原规则](../../../docs/cli-reference.md)。

#### Scenario: 内置命令仍启用
- **WHEN** CLI 默认或显式关发现（全平台/模式）
- **THEN** 全 bundled TS commands；实 RPC 来源 `custom`、TUI 补全 `/review`/`/annotate`/`/green`；不探测/遍历/载入用户/项目命令，其他自动扩展关。

显式 `-e <path>`/`--extension`/`--hook`/可信白名单、重解析注册/Skills/规则/上下文/MCP 不变，不落盘。SDK `restrictToolNames === true` 禁全部 custom commands；非限制非 CLI `discover` 缺省/`true`、`discoverCustomTSCommands()` 沿原发现/覆盖/冲突处理。

### Requirement: Claude 插件发现默认关闭

Claude 插件发现 MUST 默认关；无新配置/env/CLI。

#### Scenario: Claude 发现关闭
- **WHEN** 未启来源时启动/建或恢复会话（全模式/平台）
- **THEN** 不探测/读 `plugins/installed_plugins.json`、插件缓存、用户/项目 `enabledPlugins`，非扫描后隐藏。预加载/Skills/MCP/规则/命令/工具/子代理同规；坏/缺/不可读不警告。

`CLAUDE_CONFIG_DIR` 仅路径，不关普通 `.claude`/公司配置。原生注册表/`--plugin-dir <path>` 项目优先/去重，Claude manifest 可用、不顺扫其注册表/缓存；显式扩展/hook/可信来源/非插件 Skills 照用。`enabledProviders`（`claude-plugins`/`claude`/通配）或显式发现恢复启停；`disabledProviders` 优先，显式管理可照旧看禁用来源。授权按会话/发现范围，同目录切换不混缓存。

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
|更新|普通交互 + `startup.checkUpdate=true` + 支持自更新（排除源码/不支持的托管）→后台查发行源/`update.channel`，只提醒新版；无下载/自动安装配置。其余（含 offline/print/RPC/ACP）不加载/查/提醒，保存值/显式更新或检查不变。|
|向导|非强制且（`startup.setupWizard=false` 或 offline）→即使 setupVersion 旧，不加载完整向导/场景/认证/浏览器、不选场景；offline 仅进程内 `false`。动画独立惰性；手动/强制/普通显式版控向导保留。|
|认证|offline 按[公司快照契约](../model-providers/spec.md#requirement-公司内网模型仅-omp_offline)初始化。|

### Requirement: 插件市场更新

offline MUST 只允许手动更新市场。

#### Scenario: 市场刷新
- **WHEN** offline
- **THEN** 无自动刷新/查/升级（含显式 `notify`/`auto`），不落盘；启用来源照载，浏览/列表只读缓存。

普通模式及手动更新沿[市场契约](../../../docs/marketplace.md#updates-removal-and-scope)；添加/刷新仅清遗留临时克隆。

### Requirement: 发布 CI 的触发、并发与权限

发布 CI MUST 仅元数据/构建/打包/发布。

#### Scenario: 手动发布
- **WHEN** GitHub 发布 CI
- **THEN** 仅 `workflow_dispatch`；`<工作流名>-<ref>` 排队不取消；默认 `contents: read`，仅建 Release job `contents: write`。

`publish_release=false` 可下载；仅 `main` 显式开启+ 元数据/全部产物成功才发布。GitHub 说明；仅上表两二进制、`omp-browser-relay-extension.zip`（另有自动源码归档），无 npm/Homebrew/其他平台。`+fork.N` = `.github/workflows/ci.yml` `run_number`；不改名/路径/删建，只启此工作流；`nix.yml`、`bun-cache-warm.yml`、`stale.yml` 原样 `.disabled`，不与 CNB 同步；恢复/新增须明示触发和授权。

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

### Requirement: 原生安装替换与回滚

普通 native 构建 MUST 验宿主加载；分发除外。

#### Scenario: 换入
- **WHEN** 安装 native
- **THEN** 从真实产物写戳；addon/bindings 带戳字节同且目标可写普通文件→留文件/mtime；不看时间/大小/成功标记。

同目录唯一临时文件，POSIX 换前 `0644` 无视旧权限；原子盖 > 占用时让位 `<目标>.old.<PID>`（不杀）> 让位失败可删目标。让位后换入失败恢复，回滚失败留新旧报路径；成功立即尽力清本次让位文件，清不掉不撤销/判失败。

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

### Requirement: 设置写入的版本校验

`omp config set`/`omp config reset` MUST revision CAS；会话写入不变。

#### Scenario: 提交
- **WHEN** set/reset 提交
- **THEN** revision 变更报冲突；无文件/解析失败/无 revision 非零不覆盖（`set` 损坏/无 revision 退出 1）；保留无关键/注释/结构，回执无 revision。

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
|否则|原路由/XDG；`models.db` 仍 agent/XDG data|

#### Scenario: Linux offline 默认性能根
- **WHEN** 隐式 `/dev/shm`
- **THEN** 无可执行挂载要求/探测；编译版 JS eval `cache/bun-stub`/执行映射 addon 绕性能根（已初始化且适用 XDG cache > 配置根，保 profile），grammar 等照用。WebKit 主程序：显式性能根 > 显式配置根 > 上游共享。

选根含 `agent/models.db`/运行依赖。持久配置/认证/会话/用户及项目数据、日志级别/回退/错误、非内嵌资源缺失/下载不变。清/切仅可丢性能数据；禁迁/并/删旧、预检/测速/新配置/层级/后台/双写/备份恢复；无实测速益承诺。

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
