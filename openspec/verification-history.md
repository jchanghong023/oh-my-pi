# 历史验证记录

本页保存产品的定向验收和历史运行证据。结果只适用于列明的源码、平台和范围，不代表现行入口或其他平台已通过。[已批准的验证要求](specs/fork-maintenance/spec.md#requirement-使用上游验证入口)列出现行入口与授权。

## Windows 产品缺陷验证（2026-11-21）

- **Chromium 启动夹具隔离：** Chrome 157.0.8103.80 在 `USERPROFILE` 指向临时目录而 AppData 仍继承宿主时，即使传入独立 `--user-data-dir` 也报 `DevTools remote debugging requires a non-default data directory`。同时隔离 `APPDATA`、`LOCALAPPDATA` 和 `USERPROFILE` 后，真实 CDP 握手约 0.42 秒，`test/tools/browser-launch.test.ts` 为 10 通过、4 既有跳过、0 失败。未改 Chrome 启动参数、超时或跳过判定，不归为 OMP 上游缺陷。
- **上游 Python RPC 测试夹具：** 集成基线的 [`test_protocol.py`](https://github.com/can1357/oh-my-pi/blob/21d93e49fbe3d3bd81e9245ddbf085271a53bf4d/sdk/python/omp-rpc/tests/test_protocol.py) 漏填 `cache_warming_end.method`，而同一基线的 [wire decoder](https://github.com/can1357/oh-my-pi/blob/21d93e49fbe3d3bd81e9245ddbf085271a53bf4d/sdk/python/omp-rpc/src/omp_rpc/_wire.py) 已按协议要求该字段。Windows 全量运行复现 `cache_warming_end.method is required`；修正夹具为合法 `replay` 并断言解析值，未放宽 decoder。定向 1 个用例（7 个子用例）通过。纯上游目录未执行；未创建上游 PR。
- **上游状态栏缓存：** 基线 [`#followBrandSpinner`](https://github.com/can1357/oh-my-pi/blob/21d93e49fbe3d3bd81e9245ddbf085271a53bf4d/packages/tui/src/status-line/component.ts) 假定同一秒内只有 spinner 变化，实际 `time_spent` 显示十分之一秒。已有回归观察到增量帧停在 `1.0s`、同一时刻重建显示 `1.1s`；加入活动计时显示区间判断，同一已有用例恢复通过。
- **上游 Windows 测试夹具：** [`embed-native.test.ts`](https://github.com/can1357/oh-my-pi/blob/21d93e49fbe3d3bd81e9245ddbf085271a53bf4d/packages/tui/test/embed-native.test.ts) 固定 POSIX 图像路径，[`embed-target.test.ts`](https://github.com/can1357/oh-my-pi/blob/21d93e49fbe3d3bd81e9245ddbf085271a53bf4d/packages/tui/test/embed-target.test.ts) 创建 Windows 不支持的 `what?.html`，导致整个 fixture 无法建好；改用主机路径及可创建但有 URL 特殊含义的文件名，两组原行为断言通过。上游 [`agent-type.test.ts`](https://github.com/can1357/oh-my-pi/blob/21d93e49fbe3d3bd81e9245ddbf085271a53bf4d/packages/stats/test/agent-type.test.ts) 只创建配置根，未创建当前数据路径下数据库的父目录；修正 fixture 后 4 项通过。以上均未改生产路径解析或迁移逻辑。
- **上游浏览器对照夹具：** [`browser-implicit-roles.test.ts`](https://github.com/can1357/oh-my-pi/blob/21d93e49fbe3d3bd81e9245ddbf085271a53bf4d/packages/coding-agent/test/tools/browser-implicit-roles.test.ts) 把 Chromium AX 的本地化原生按钮名（实测 `提交`、`重置`）直接用于 Tern DOM 查询。两套查询分别验证本引擎的可见结果；保留 Chrome AX 实测和 Tern 固有 `Submit`／`Reset` 边界。Windows 原生观察名精确及子串反查的旧跳过移除，40 项 Chrome 查询通过；对照文件另 5 项通过。未表示 Tern 具备原生 AX 或与 Chromium 相同的本地化能力。
- **上游 Windows 原子替换：** 全量真实 Chromium 多标签测试偶发返回原始下载 GUID 路径而非 `fixture.bin`。独立 Win32 探针证明不共享删除权限的已打开文件可正常 `stat`，但 `rename` 返回 `EBUSY`；上游基线的 [`atomic-file.ts`](https://github.com/can1357/oh-my-pi/blob/21d93e49fbe3d3bd81e9245ddbf085271a53bf4d/packages/coding-agent/src/utils/atomic-file.ts) 未恢复这种共享冲突。对 Windows `EBUSY` 沿用现有 2 秒原子替换重试预算；真实锁释放后同名文件仍以原字节发布，未放宽 GUID、符号链接或目录保护。
- **上游 Rust Windows 夹具：** [`direnv`](https://github.com/can1357/oh-my-pi/blob/21d93e49fbe3d3bd81e9245ddbf085271a53bf4d/crates/builtins/src/direnv/tests.rs) 把 `.env` 以 `/` 拼入 Windows 绝对路径；[`watchexec`](https://github.com/can1357/oh-my-pi/blob/21d93e49fbe3d3bd81e9245ddbf085271a53bf4d/crates/builtins/src/watchexec/tests.rs) 把公共目录固定为 POSIX 拼写；[`urlmap`](https://github.com/can1357/oh-my-pi/blob/21d93e49fbe3d3bd81e9245ddbf085271a53bf4d/crates/shell/src/shell/tests/urlmap.rs) 假定本机根路径无需 shell 引用。Windows Nextest 的三项原始失败见 `runs/test-timing/2026-11-20T17-36-27.384Z-95840-5d66ba78/run.json`。修正 fixture 的本机路径和引用；保留输出、真实 `eval` 回环及卸载后的失败断言。
- **上游 SDK 模型测试夹具：** [`sdk-model-selection.test.ts`](https://github.com/can1357/oh-my-pi/blob/21d93e49fbe3d3bd81e9245ddbf085271a53bf4d/packages/coding-agent/test/sdk-model-selection.test.ts) 释放 session 后立即清理临时目录，未等待真正的 catalog 刷新；fork 在同一生命周期也可排入刷新。全量复现 Windows `EBUSY`，观测剩余 `models.db`；夹具等待自己触发的刷新释放资源，再按原规则清理。与 fork 同会话 reload（旧运行结束时不再重新触发 idle 压缩）的定向合计为 139 项通过。
- **上游 MCP／模型目录测试夹具：** 基线 [`acp-agent.test.ts`](https://github.com/can1357/oh-my-pi/blob/21d93e49fbe3d3bd81e9245ddbf085271a53bf4d/packages/coding-agent/test/acp-agent.test.ts) 的两项慢 MCP 用例未销毁持有真实子进程的 ACP agent；[`mcp-manager-notification-listeners.test.ts`](https://github.com/can1357/oh-my-pi/blob/21d93e49fbe3d3bd81e9245ddbf085271a53bf4d/packages/coding-agent/test/mcp-manager-notification-listeners.test.ts) 则对已逻辑断开但仍在异步回收的进程使用同步删除；[`model-availability-live-settings.test.ts`](https://github.com/can1357/oh-my-pi/blob/21d93e49fbe3d3bd81e9245ddbf085271a53bf4d/packages/coding-agent/test/model-availability-live-settings.test.ts) 的禁用路径未等待真实 catalog 刷新。三个夹具在 Windows 全量运行中出现 `EBUSY`；本地关闭真实所有者或等待异步生命周期，保留原断言和时限。
- **上游 daemon 退出：** [`units.ts`](https://github.com/can1357/oh-my-pi/blob/21d93e49fbe3d3bd81e9245ddbf085271a53bf4d/packages/coding-agent/src/daemon/units.ts) 用 `Bun.sleep` 与模块 `exited` 竞争；模块先退出时留下存活定时器。真实 blob publish／stop／reopen 用例完成业务后，fork 的严格退出验证仍超时。取消已输掉的计时器，保留原等待上限及真实重开断言。上游 [`dsm-prelude.test.ts`](https://github.com/can1357/oh-my-pi/blob/21d93e49fbe3d3bd81e9245ddbf085271a53bf4d/packages/coding-agent/test/eval/dsm-prelude.test.ts) 的 Windows 清理在 JS worker 仍持有目录时执行，改为停止对应 worker 后清理。两文件在门禁 Windows 环境定向共 19 项通过。
- **上游 LSP Windows 夹具：** [`symbol-lookup.test.ts`](https://github.com/can1357/oh-my-pi/blob/21d93e49fbe3d3bd81e9245ddbf085271a53bf4d/packages/coding-agent/test/lsp/symbol-lookup.test.ts) 把多路径结果固定为 POSIX 分隔符，Windows 实际 matcher 返回主机路径。用主机路径断言同一组文件和截断状态，不改诊断匹配器。
- **上游 Windows detached 服务：** 基线 [`launch/spawn-options.ts`](https://github.com/can1357/oh-my-pi/blob/21d93e49fbe3d3bd81e9245ddbf085271a53bf4d/packages/coding-agent/src/launch/spawn-options.ts) 在 Windows 用 `detached: false`；Bun 1.4.4 的 libuv 会把该子进程加入随父进程关闭的 job。fork 的真实回放用例观测到 daemon 重启后原 PID 丢失。独立后台服务改为真正 detach 且不弹窗；原 PID、原 unit ID 与仅原会话接收退出事件的定向用例通过。
- **上游 RPC MCP 退出：** 基线 [`rpc-mode.ts`](https://github.com/can1357/oh-my-pi/blob/21d93e49fbe3d3bd81e9245ddbf085271a53bf4d/packages/coding-agent/src/modes/rpc/rpc-mode.ts) 在私有 MCP host 的异步回收结束前可以退出。退出时先释放会话租约，再等待本进程自己的 host；不关闭共享 daemon。真实 RPC 与 RPC UI 的恢复、拒绝列表、会话切换及 stdin EOF 后 peer OS 退出验证 2 项通过。
- **GitHub／LSP 测试夹具：** 上游 [`gh.test.ts`](https://github.com/can1357/oh-my-pi/blob/21d93e49fbe3d3bd81e9245ddbf085271a53bf4d/packages/coding-agent/test/tools/gh.test.ts) 在真实 `pr_push` 打开 GitHub 缓存后未释放 SQLite 所有者，Windows 清理报 `EBUSY`；隔离并关闭缓存，保留真实 checkout 与 push。LSP rename 的 `didClose` 故障夹具沿用真实打开文件，避免在合并 `290d787845` 的前置协调阶段提前取消；仍验证实际改名、编辑引用和勿重试提示。
- **上游 `/move`／agent revive 夹具：** 基线 [`move-project-scope.test.ts`](https://github.com/can1357/oh-my-pi/blob/21d93e49fbe3d3bd81e9245ddbf085271a53bf4d/packages/coding-agent/test/move-project-scope.test.ts) 在初次 MCP 异步发布前直接断言，重负载下观察到 alpha 工具尚不可用；改为等待真实工具发布，仍验证 alpha→beta→alpha 的替换。基线 [`agent-lifecycle.test.ts`](https://github.com/can1357/oh-my-pi/blob/21d93e49fbe3d3bd81e9245ddbf085271a53bf4d/packages/coding-agent/test/registry/agent-lifecycle.test.ts) 硬编码 `/tmp/Revive-Killed.jsonl`，在 Windows 写 tombstone 时报 `ENOENT`；使用独占临时目录，断言 sidecar 已真实落盘、旧 agent 不能重新附着。全量首次观察到这两项失败；相同 10 文件分块定向复跑 74 项通过。
- **上游 Codex SSE 测试夹具：** 基线 [`openai-codex-stream.test.ts`](https://github.com/can1357/oh-my-pi/blob/21d93e49fbe3d3bd81e9245ddbf085271a53bf4d/packages/ai/test/openai-codex-stream.test.ts) 用真实 10ms 同时约束等 headers 和等 SSE 首事件；重负载下观测到 7 次请求却断言 6 次纯 SSE 尝试。改为在已返回 200、解析器实际读取空 SSE body 后才推进虚拟时钟，保留 6 次请求、首事件超时和可重试错误标志；不改生产时限或两个重试预算。
- **上游 Factory Droid 测试夹具：** 基线 [`factory-droid-anthropic.test.ts`](https://github.com/can1357/oh-my-pi/blob/21d93e49fbe3d3bd81e9245ddbf085271a53bf4d/packages/ai/test/factory-droid-anthropic.test.ts) 以 getter 内的 `Date.now() - 1` 模拟过期，比较左侧先读时钟，两读之间跨毫秒便可能把测试令牌判为有效。改为冻结请求体进入准备阶段时触发确定性过期；仍断言只发送一次重建请求、无旧令牌或旧消息。定向整文件 45 项通过。
- **Fork Windows native cache 夹具：** daemon 首次握手较慢时，竞争启动但未持有单实例锁的进程也可能覆盖夹具的共享 PID 文件。用两条真实连接的 `ping` 核对同一实际 daemon PID，再读取该 PID 对应的 native 路径与退出状态；独立测试 3 项通过，未改生产 daemon。此文件不在上游基线中。
- **Fork OpenWiki 超时夹具：** 并行全量下原生 partial→retry 用例触及既有 45 秒期限。恢复时只补失败页，不重复生成已推进到当前 Git 提交的 quickstart；仍真实运行初始、部分成功、干净源码重试三轮，并验证旧成功检查点及已完成页不被覆盖。定向回归 8.67 秒通过，未改时限或 vendor。
- **Fork OpenWiki 指令夹具：** 变更指令时验证规划失效、提交检查点和覆盖后不再规划，不重复改写未失效的 quickstart。Git fixture 以进程环境提供作者，省掉重复配置命令；真实 Git/规划/提交及四种指令分支均保留。定向整文件 11 项通过，原超时用例 11.58 秒，未改既有 45 秒期限。
- **Fork 长会话 PTY 夹具：** resize 后 40 张真实快照的输入内容、边框及光标已稳定，旧判据却把不停刷新的耗时行当作布局的一部分（35 个不同值，触及 60 秒上限）。改为比较真实输入框宽度、正文及光标，随后仍检查输入、消息、工具效果和压缩持久化。实际原生整文件 4 项通过，108.8 秒；未增加时限或改生产渲染。
- **Read 夹具：** 基线 [`read-supersede-prune.test.ts`](https://github.com/can1357/oh-my-pi/blob/21d93e49fbe3d3bd81e9245ddbf085271a53bf4d/packages/coding-agent/test/read-supersede-prune.test.ts) 的行限用例原依赖默认值；显式设定页长，保留不完整读取不得裁掉前段的断言。远程编号页脚保留真实预算：上游 `f441a32e1a` 预留编号前缀后长页显示 49.2 KB，夹具验证实际连续行及续读，不改变分页器。
- **Fork TTS 本地化回归：** 上游用英文 `British` 标题推断 locale；fork 的中文标题暴露这种耦合，把英式声线误报为 `en_US`。目录保存显式 locale，Shell `say` 继续返回真实声线名称与翻译标题，不从标题推断协议字段。
- **Fork 测试适配：** 中文 Ask 键提示、Composer 真实提交回调参数、状态符号测试 Theme 的必需背景、shell 取消回归的 `StateStore`、当时内置的本地文档索引取消夹具的真实索引准备、截图／MCP 测试显式启用 JS、交接和显示重建的本地显示及会话夹具、废弃设置／模型预检，以及 updater 子进程对 `vi.restoreAllMocks` 的 Bun `done` 回调误判，均不归上游。updater 使用无参回调，保留逐用例子进程和现有期限。
- **OpenSpec 原生 TUI：** 合并重复的技能与目录状态组合后，Windows 独立真实 PTY 用例 3 项通过、1 项既有跳过。
- **Chromium 多标签及长会话 PTY：** 两组真实用例在 Windows 验证通过；验收源码随后提交为 `d20527fbe3cc82f4e7a228be279cd651f947d4a8`。

## 全量测试竞态与上游归属（2026-10-30）

Windows x64、Bun 1.4.4，源码 HEAD `93b18ac087fb71239b7163fcdceca61e8da50730` 加当时未提交改动；有效上游基线为 [`can1357/oh-my-pi@b0756921ed231869ea92feef0056629a429d3fe1`](https://github.com/can1357/oh-my-pi/tree/b0756921ed231869ea92feef0056629a429d3fe1)，版本 v18.13.3。首轮回归有 6 项失败，第二轮原 6 项通过但仍有其他失败。

- **上游继承的测试 fixture 缺陷线索：** 基线的 [focused-subagent-manual-yield 测试](https://github.com/can1357/oh-my-pi/blob/b0756921ed231869ea92feef0056629a429d3fe1/packages/coding-agent/test/task/focused-subagent-manual-yield.test.ts)未提供 `description`，后台 task-label 调用会与测试按序号分配的 mock 竞争；本地 fixture 显式传入 description。基线的 [kitty keyboard overlay 测试](https://github.com/can1357/oh-my-pi/blob/b0756921ed231869ea92feef0056629a429d3fe1/packages/tui/test/kitty-keyboard-da1-ordering.test.ts)以固定 67ms 等待代替绘制完成；本地改为等待 TUI 实际绘制完成事件。相同写法已在基线源码中确认，但未单独运行纯上游基线；这是测试竞态线索，不认定为上游产品功能缺陷或已在纯上游运行复现。
- **fork 新增测试：** interactive-terminal 的长回复 auto-shake 用例为 fork 新增，不归上游；原测试依赖固定帧，本地改为等待实际 shake 通知并保留首行。上述处理仅修改测试 fixture，未提高超时、新增跳过或弱化断言。
- **未确认原因：** 首轮 Git 侧栏和服务就绪超时，定向运行及第二轮未改相关代码即通过；根因未确认，不认定已修复或属于上游 bug。
- **第二轮 relay 失败待定：** `relay tab ownership` 中“opens a default tab in the browser of the tab omp used last, not the first selected one”运行 20.516 秒后报 `Selected tab did not become available before omp could attach`。只读对比基线，browser relay 的 `bridge.ts`、`attach.ts`、`server.ts` 及 `browser-relay-tab-isolation.test.ts` 相同；`tab-supervisor.ts` 的 `buildInitPayload` 和选择路径相同，其差异在 worker 恢复及工具调用清理。失败发生于共享代码，但未在纯上游复现，根因及上游归属未确认，暂未认定修复。

首轮后定向结果：focused 2 通过／3 既有跳过，interactive 17 通过，kitty 10 通过／1 既有跳过，Git 10 通过，服务原 5 文件 57 通过／1 既有跳过；跳过不计通过。这些定向结果不替代完整门禁。

第三轮 Windows 回归中 relay 用例通过，但服务 log readiness 再次超时，另有 `browser-upload-contents.test.ts` 的 contents 路径在夹具导航时出现 `net::ERR_ABORTED`。报告 `runs/test-timing/2026-10-30T02-05-56.245Z-18744-082452f3/run.json`；不能因前次单独通过认定已修复或归为上游 bug。

上传测试的外部 Chromium 夹具在上述上游基线中同样未指定启动 URL；本地按既有连接浏览器测试约定显式传入 `about:blank`，消除对默认启动页的依赖，原导航预算及上传错误断言不变。定向文件 10 项通过／11 项既有跳过；这不证明 `ERR_ABORTED` 的根因，也不等同纯上游复现或完整门禁通过。服务原分组再次定向 57 项通过／1 项既有跳过，临时失败诊断用于下一轮全负载采证，尚未认定修复。

删除临时诊断后的 Windows 回归中，`changelog-static-import.test.ts` 在 `finally` 删除编译产物临时目录时出现 `EBUSY`，资源条目和版本断言已通过。测试与上游基线[同名文件](https://github.com/can1357/oh-my-pi/blob/b0756921ed231869ea92feef0056629a429d3fe1/packages/coding-agent/test/utils/changelog-static-import.test.ts)一致，纯上游未单独运行。本地改用既有 `removeWithRetries`，保留资源断言和原 30 秒时限；真实源码／bundle／编译产物定向 7 项通过。之前的服务、relay、上传用例在该轮通过，间歇性问题的根因仍未确认。

## Windows 回归发现的上游问题与平台边界（2026-10-29）

- **上游浏览器角色查询：** 集成基线 `b0756921ed231869ea92feef0056629a429d3fe1` 的 `packages/coding-agent/src/tools/browser/query-handlers.ts` 对未指定 `value` 的 submit／reset 输入硬编码英文默认名称；Chromium 无障碍树返回的本地化原生名称可能不同，导致 `observe` 返回的名称不能用于精确或子串角色查询。Windows 定向运行 `packages/coding-agent/test/tools/browser-queries.test.ts` 重现精确查询零结果；该测试是 fork 工作树中的覆盖，失败证明当前工作树的问题，不证明其他语言或平台的具体结果。修复尚未完成；Tern 的页面脚本接口不能直接读取 Chromium 无障碍树。
- 用户要求 Windows 问题跳过测试且不改产品代码；原生 submit／reset 名称查询回归现仅在 Windows 跳过，其他平台仍保留。上游名称不一致问题尚未修复，是否同样影响其他平台未核验；跳过不计通过。
- Windows 全量运行中反复出现 PTY 参数用例超时及两项浏览器上传目标未找到；按用户要求仅将这三项在 Windows 跳过，其他平台仍执行。单独运行时上传测试此前通过，失败是否为平台特有及其根因未确认，跳过不等于修复或通过。
- 后续 Windows 回归仍出现 MCP、RPC、服务、子代理、ConPTY、浏览器、Ask、worktree 等用例问题。按当时用户要求只在 Windows 跳过具体失败用例；部分用例独立运行通过，负载与平台归因尚未证实，跳过不计通过。定向结果：native／MCP 7 项通过、7 项跳过；终端与协作 25 项通过、3 项跳过；MCP／服务／PDF 截图五个文件 58 项通过；服务／编辑失败路径 49 项通过、6 项跳过。
- **RoboOMP 平台边界，不归为上游缺陷：** RoboOMP 依赖 POSIX（缓存用 `fcntl`，worker 用 `grp`）。当时在 Windows 原生运行，先遇到导入失败，尝试解除导入阻塞后仍有 33 项失败，涉及 POSIX 身份、权限、路径和子进程；不能用跳过安全逻辑或排除测试冒充等价通过。
- 后续定向修复了 compact 历史回放和入口测试的跨轮次等待；回放测试 50 项通过，真实公开入口两项通过。搜索测试类型收窄修正后，三个文件 32 项通过，coding-agent 类型检查通过；回放改动尚无真实 TUI 交互验收。

## Team 配置实施与定向验收记录（2026-10-19）

`/team configure`、共享 Team 配置服务、Settings／YAML 保存与 CLI 接入已实现，包含严格重复键拒绝、无损原槽位、完整候选、只读草稿预览、版本冲突及双端保存回执；原 RPC 接口已随独立 RPC 场景退役删除。现行行为以 [Team 规格](../openspec/specs/team-discussion/spec.md)为准；offline 用户配置双写仅为历史验证内容，相关规格已删除。本节只集中记录证据，不建立第二份契约。下述 RPC 证据均对应独立 RPC 场景退役前的源码。

* **Windows 最小回归：** 七个相关文件按未变化的有效结果复用、去重计 **60 通过／2 平台跳过**，不是全仓测试或 Linux／NFS／外部 GUI 完整验收。首批五文件 53 通过，报告 `runs/test-timing/2026-10-19T10-26-59.608Z-55156-f6366268/run.json`；native 2 通过／2 跳过，报告 `runs/test-timing/2026-10-19T10-26-17.943Z-24552-83fa6cbe/run.json`。user-settings＋RPC 首次前置回执失败保留；修正后 combined 10 项为 9 通过／1 故障注入失败，报告 `runs/test-timing/2026-10-19T10-29-33.373Z-4332-537f8307/run.json` 保持 partial，其中 RPC 两项及七个 user-settings 项通过。故障注入边界修正后仅按失败 name 精确复验 1 项通过，报告 `runs/test-timing/2026-10-19T10-31-27.113Z-27896-01dec828/run.json`；另补齐未传 revision 的 staged 保存对每个授权字段的双端锁内基线比较，第二个持久字段遭并发修改时首次提交前拒写的真实文件 seam 回归 1 项通过，报告 `runs/test-timing/2026-10-19T10-37-14.670Z-31728-5f82fb05/run.json`。JUnit 按用例复用有效执行结果，过滤行不覆盖既有通过结果；不重复计数、不将初失败报告改称通过。
* **真实 TUI 入口：** 隔离 profile、localhost 候选，经 `bun run dev`＋`tui-test` 打开原失效槽位；会话候选仅 A 时 `selectOnly` 仍可选择 B／A2。替换、添加、复制、上移／下移、删除、有序重复保存、恢复默认草稿与放弃取消、60×18 滚动、主模型保持 A 已有定向证据；真实文件最终顺序 `A,B,B,A2,B`，注释保留。窄屏一次状态文案 expect 超时，原因是文案滚出当前视窗；保存文件及随后保存成功断言通过，不能据此把该次文案可见断言算通过。退出等待通过，但 `get exit-code` 为 `null`，不宣称 TUI CLI exit=0。证据 `node_modules/.cache/team-config-acceptance-1792405232614/tui-evidence.json`，同目录 `tui-saved.png`／`tui-narrow.png`。
* **真实 CLI／RPC 入口：** CLI `config set/get/reset` 验证 `[]`、移除字段与注释保留，exit=0，证据同目录 `cli-evidence.json`。RPC 两项从真实 CLI 验证 v3 能力、完整候选／原槽位、预览、非空跨 provider 重复名单／`[]`／`null`、冲突及 `invalid_config` 结构化回执，并覆盖锁阻塞期间停止／切换／EOF 隔离。配置期间本地探针模型请求为 0，不代表真实模型运行已验收。
* **构建与静态状态：** Windows `bun run build:native` 的 local 构建、绑定生成及宿主加载通过，保留既有 MSVC LNK4217 警告。Team／Settings／picker 的 LSP 无错误，rpc-mode 仅既有 1061 unreachable hint。TS lint／格式／类型和 Rust fmt／Clippy 检查当时通过，仍有 13 项既有非致命 lint 提示。
* **审查修复后验收：** 七项审查缺陷已修复，覆盖保存后迁移、缺失父节点与旧版来源 reset、同值保存同步、保存／刷新竞争、有效高层 Team 预览及原生锁最终清理。验收源码为 `b5cf01796b85` 加当轮工作树；Windows 报告 `runs/test-timing/2026-10-19T11-13-36.231Z-74212-9451014c/run.json` 记录 11399 项实际执行、0 失败。真实 CLI reset/get、Settings 迁移与同值同步、真实 rpc-ui 高层覆盖失效草稿预览的隔离证据见 `node_modules/.cache/review-fixes-20261019/evidence.json`；不代表 Linux／NFS 跨主机锁或恢复验收。
* **未验收及 API 边界：** 当时 Linux／真实公司 NFS 两台主机同旧版本竞争与服务器锁、CentOS 实机 和真实模型均未验收；Windows seam 不替代这些证据。双端保存和跨主机锁能力及其验收要求已退役，不约束当前或未来实现。当前 `ConfigFile`／`ModelsConfigFile` 只有读／迁移，无主动 `models.yml` writer 或 provider 保存 API；不能把 Team 保存接口扩称 provider 接口。任意文本 `edit` 不等同共享程序服务的锁、版本及事务保证。既有 `/team` 讨论域证据仍限原记录场景，未被本节配置证据覆盖或替代。

## 其他专项与历史验证

内网运行期四项减负已实施：仅 offline 将累计流式合并窗口改为 100ms，并在进程内关闭自动图表、窗口标题状态动画及重规划标题刷新；单词补全不变。Windows 四个定向文件 27 通过／0 失败，覆盖合并边界、最终快照冲刷、思考／取消回归，以及普通／offline 对已配置显示选项的不同优先级；报告 `runs/test-timing/2026-10-19T04-52-15.874Z-78116-1ba311a8/run.json` 为 complete。四个修改 TS 文件格式／lint 与 coding-agent 类型检查通过。真实 `bun run dev`＋`tui-test` 使用隔离 localhost 模型验证两模式的实际有效设置、表格及流式完整回复、首次自动标题、输入回显、配置文件字节不变及两次 exit=0；单词补全保持显式 ngram，SVG／Mermaid 设置保持启用。初轮通知就绪断言超时但扩展观察文件已生成，改用实际模型栏就绪断言后两模式通过，失败证据保留。证据 `node_modules/.cache/intranet-runtime-20261019/`；未运行完整门禁、真实模型、Linux／公司实机或实际提速测量。契约见 [内网运行期显示减负](../openspec/specs/fork-runtime/spec.md)。

此前自动标题专项验证对应的 fork 策略已移除，恢复上游默认行为；其历史报告 `runs/test-timing/2026-10-19T05-12-19.163Z-69836-bbd9fa1f/run.json` 不代表当前行为已验收。

内网最小减负已实施：仅 Linux offline 降低后台重绘／装饰刷新与 Git 状态扫描频率，取消共享／自定义技能的同步逐文件存在探测并逐轮去重；全部 offline 平台仅记录 ERROR。Windows 9 个定向回归文件 172 通过／4 跳过／0 失败，包含受控 Linux platform seam 下的模式隔离、输入／取消／强制刷新、Git 失效、技能刷新及真实日志文件／接收器过滤；报告 `runs/test-timing/2026-10-19T04-06-28.042Z-73772-b3145fae/run.json` 为 complete。11 个修改 TS 文件格式化／lint 和 utils、TUI、coding-agent 类型检查通过。真实 `bun run dev`＋`tui-test` 使用隔离配置与 localhost 模型验证共享技能展开、流式完整回复及输入回显，退出等待成功；工具未提供进程退出码，不宣称 exit=0。画面与请求证据在 `node_modules/.cache/offline-minimal-20261019/`。Linux／WSL、公司 CentOS／NFS／企业远程链路及实际提速未验证；未运行 fastcheck／fulltest／slowtest 或真实模型。行为契约见 [Fork 运行规格](../openspec/specs/fork-runtime/spec.md#requirement-安装与运行)。

本轮 Fork 审查的 8 项确认问题及 2 项 Rust 候选已最小修复，Windows 专项验证通过：单点回归去重 47 项通过（初轮 41 通过／6 失败；修正后仅复验受影响部分，9 通过／0 失败，含 3 项重复验收；原失败报告保留），coding-agent／TUI 类型检查、修改文件格式／lint 与 LSP 无错误。当前源码按既有 local profile／target／flags 完成 native 构建及宿主加载探测，保留既有 MSVC LNK4217 链接器警告；未运行 Rust 整套单测。真实 `bun run dev`＋已安装 `tui-test` 使用隔离配置和 localhost 模型验证包装设备单行／展开隔离、安全 Bash 失败原因、真实文件预览、详细／紧凑切换及 80×24 窄屏。证据 `node_modules/.cache/fork958-minfix-acceptance/verification.json`；单点报告 `runs/test-timing/2026-10-18T01-20-04.750Z-49380-af9fb172/run.json` 为 complete。未运行 fulltest／slowtest、Linux／WSL、真实模型；该专项不替代下表各域的完整验收。

上游基线 `af7b2c50aa2d`、验收源码 `0c9aade61cdc` 加当轮工作树的 Windows 证据覆盖 native 构建、真实 `bun run dev` TUI 启动／输入／退出、Team 报告持久化／取消和 Repo 生命周期。报告 `runs/test-timing/2026-10-18T02-10-03.864Z-47660-d75b0bac/run.json` 记录 11075 项实际执行、0 失败；不代表 Linux／WSL、公司实网、真实模型、发布或共享桌面输入验收。

当轮 45 项审查发现及后续修补对应上游基线 `e34a37389c82`、验收源码 `fb166dd89e82`。Windows 与 Ubuntu-24.04 WSL2 的真实 `bun run dev` PTY 验证均覆盖启动、输入、Team 报告持久化／取消和 Repo 生命周期，两端 native 构建也通过。另行指定的扩展 `tui-test` 验收因工具未安装而受阻，未自动安装或自写替代；真实模型、公司实网、共享桌面和其他未声明平台未验收。

| 文档 | 权威范围 | 状态 |
| --- | --- | --- |
| [Fork 定位、功能与默认值](../openspec/specs/fork-runtime/spec.md) | 个人 fork 定位、三种使用场景与零配置目标、上游基线、个人模型与命令、交互与默认值、分发、运行诊断日志 | 上游基线 `d060e142cc5c`、验收源码 `b9acb399c57b` 加当轮工作树的 Windows 证据覆盖 native 构建、真实 dev-TUI 基础、Team 运行／取消和 Repo 链路；报告 `runs/test-timing/2026-10-17T00-35-15.409Z-24228-44e68fa6/run.json`。未验收 Linux／WSL、公司实网、真实模型、独立发布或共享桌面输入 |
| [内网中文输入法恢复](../openspec/specs/personal-commands/spec.md) | `/jchime` 提供完整 IBus 首选步骤与失败后同用户/同 DISPLAY 的自主恢复，核验总线和拼音引擎；不等同实际中文上屏验收 | 已实现；首选恢复块、命令接入及新增自主恢复边界均经两名独立 reviewer 只读审查，已修复 Python 3.6 标准流编码问题，未发现其他确认问题。自主恢复的安全边界由提示词约束，不是程序级隔离。按本次用户要求未执行恢复操作、测试或 CLI/TUI 冒烟；新增隔离与失败边界回归尚未运行，当前 Windows、公司 CentOS/Exceed 实机及内网小模型实际执行均未验收 |
| [LSP 默认关闭](../openspec/specs/fork-runtime/spec.md#requirement-默认设置) | 主会话／task 子代理的 LSP 默认值、自动文件操作总开关及显式配置优先级 | 已实现；Windows 三个定向回归文件 53 项通过，新增 write／edit 关闭态回归修复前失败、修复后通过；报告 `runs/test-timing/2026-10-25T02-20-05.710Z-167804-f43ca4f7/run.json` 为 complete。隔离 localhost 模型的真实源码 CLI 六场景均 exit=0：普通／offline 默认无语言服务器进程、仅主会话开启、offline 双端开启、总开关关闭及 `--no-lsp` 优先；真实 task 子代理完成文件写入／编辑，显式开启时复用 fake-LSP 子进程验证协议往返及文档同步，配置原字节不变。六个修改 TS 文件格式／lint 通过，write／edit 及回归文件 LSP diagnostics 无错误；证据 `node_modules/.cache/lsp-default-smoke/run-1792895065954/evidence.json`。未运行 fulltest／slowtest、TUI、Linux／WSL、真实模型或外部语言服务器验收 |
| JavaScript Eval 默认关闭 | `eval.js=false`、Python 保持开启及显式配置／环境变量覆盖 | 已实现；Windows 18 个相关测试文件按有效结果合计 104 通过／3 跳过，首轮遗漏的 7 个 JS 夹具已显式开启并精确复验通过，原失败报告保留；报告 `runs/test-timing/2026-10-25T02-43-58.734Z-30552-88e715e7/run.json` 与 `2026-10-25T02-45-00.631Z-87780-0c5eda98/run.json`。真实源码 CLI＋localhost 模型四场景均 exit=0：普通／offline 默认只声明 Python、Python 实算 42、JS 调用拒绝；配置开启及 `PI_JS=1` 覆盖显式关闭后 JS 实算 42，用户配置原字节不变。Eval 描述由双后端 1732 字符降为 Python 单后端 1535 字符，仅指该工具描述，不是整个系统提示词。19 个修改 TS 文件格式／lint 通过；证据 `node_modules/.cache/eval-js-default-smoke/run-1792896238700/evidence.json`。未运行 fulltest／slowtest、TUI、Linux／WSL 或真实模型验收 |
| 离线 shm 运行与异步备份（历史验证，规格已删除） | 仅 Linux offline 的 OMP 自有数据使用 `/dev/shm`，周期异步备份回有效 `OMP_CONFIG_ROOT` 或上游默认根；启动无搬运／等待、用户自行恢复；NFS 项目访问与 Repo 数据库共置边界见对应契约 | 七项公司离线修复已实施，Windows 定向验证通过：11 个相关文件按未变化的通过结果合并计 132 通过／15 平台跳过／0 失败；三项受 mock 协议修正影响的提交用例已精确复验，不重复计数。真实 CLI 完成 company compress rewrite／approve、agentic／legacy commit dry-run 与 Git AI 本地模型请求，无公网目录发现；实际 `bun run dev` 经已安装 `tui-test` 验证 company 默认模型、preset 保存／切换无假冲突、真实 read 工具往返及 exit=0。真实 Artifact／Session API 在 Windows junction 与运行域 seam 下验证边界拒绝和健康会话保留，独立 CLI 备份 Worker 往返通过；print 请求挂起且 stdout 为零时已观察到 600000ms 备份计时启动，该项仅为 Windows 生命周期状态注入，不是 Linux 周期验收。28 个改动 TS 文件格式化／oxlint、coding-agent 类型检查和 LSP 无错误，保留既有提示。证据 `node_modules/.cache/intranet-seven-acceptance/verification.json`；原失败报告保留。未运行 fulltest／slowtest、Linux／WSL、真实公司模型、实际 NFS 或单文件符号链接专项。CentOS 专项仍 **BLOCKED**：既有 CentOS 7.9／glibc 2.17／Bun 1.4.0 WSL2 环境缺匹配 Linux native addon，Cargo offline 缺 `ast-grep-core`；其 WSL2 内核不能证明公司 CentOS 7 的 3.10 内核兼容性。真实 Linux shm 路由／周期备份、并发、人工恢复、公司网关及 NFS 故障／多机行为仍未验收，不以本次 Windows／localhost 结果替代 |
| [简体中文用户界面](specs/personal-commands/spec.md#requirement-英文-tui-界面与中文启动提示) | 当时的主要 TUI 操作界面：欢迎与输入、完整设置页、常用选择与授权弹窗 | 既有 307 项定向用例及欢迎、设置分类、中文搜索／无匹配、窄屏、选择弹窗与原生分类验证属于合并 dev 前的证据。Windows 验证也覆盖 native 构建及真实 `bun run dev` ConPTY 的基础、Team 运行／取消与 Repo 链路；Linux／WSL、公司实网及 GUI 不属于本地结论 |
| [会话工作树切换](../openspec/specs/personal-commands/spec.md) | `/wt` 与 `/worktree` 的分支复用、目录位置及源目录改动保留契约 | Windows 真实 Git／native 冒烟及回归验证异地 linked worktree 同级创建的工作树删除并 prune 后仍可发现会话目录，仓库／子目录和 custom session-dir 隔离保持。Ubuntu-24.04 的 4 项真实 Git 回归通过，覆盖两个异地工作树均删除后的项目 picker、removed-worktree 判断、消息保留和迁移恢复；完整恢复回归沿用既有 Windows 平台跳过 |
| [多代理方案讨论](../openspec/specs/team-discussion/spec.md) | `/team` 的行为、集成约束与验收 | `prompts.test.ts` 的 6 项用例覆盖未决阻断 ID、current／previous 引用、当前正文与审查基线相同、累计未复核中间版与逐 ID 材料保留、原历史不变；连同 `orchestrator.test.ts`／`integration.test.ts` 共 111 通过、0 失败。报告 `runs/test-timing/2026-10-18T13-32-34.288Z-75144-555dd83b/run.json`。进程内集成使用桩模型，未运行 CLI／TUI E2E、真实模型或类型检查；本地缺 oxfmt／oxlint，未安装工具。既有 Windows GPT-6 Luna 真实 RPC／dev-TUI 的缓存规划与证据不足诊断、首次交互直接 `/team` 的退出后持久保留，以及相关 34 项回归仅适用于原场景；Linux／WSL、真实模型取消、公司网关及任意实际项目方案质量未整体验收 |
| [Team 模型配置界面与共享保存](../openspec/specs/team-discussion/spec.md#requirement-team-模型配置界面) | `/team configure` TUI 有序编辑、完整 Team 候选、自然语言辅助搜索、共享 Settings／YAML 保存 | Windows 七个相关文件去重 60 通过／2 平台跳过，真实 TUI／CLI 定向证据及失败修复见上方专项记录（原 RPC 接口已随独立 RPC 场景退役删除）。当时 Linux／公司 NFS 跨主机、CentOS 与真实模型未验收；跨主机锁能力已退役 |
| offline 用户配置双写（历史验证，规格已删除） | 当时 Linux offline 用户主动持久化 OMP 配置时，TUI／RPC／配置命令／Agent 代配均须在同次操作保存 shm 与解析后的原始 NFS 目录；跨主机 NFS 锁、双端字段合并／读回及部分／未知结果，不以后台备份代替。该能力及要求已退役，不约束当前或未来实现 | 当时 Settings／Team／CLI 已接入；Windows 定向回归与真实入口证据见上方专项记录，不代表 Linux／公司 NFS 跨主机及 CentOS 已验收。尚无主动 models.yml provider 保存 API；文本 edit 不等同程序事务保证 |
| [Goal 自动编排](specs/spec-driven-orchestration/spec.md#requirement-1-目标与命令) | `/goal-autopilot` 的状态、授权、上游 Goal 生命周期，以及普通 Goal 共用的运行中追加输入 | Windows 执行中／暂停／无 Goal 三项 Ctrl+Q 饥饿定向回归及队列投递文件 42 项通过；coding-agent 类型检查通过。真实 `bun run dev` 的普通 Goal 原始 Ctrl+Q 和无人值守 Goal Win32 按键报告均验证在工具批次后送达、读取更新后的文件并完成目标。证据 `node_modules/.cache/goal-continuous-ctrlq/`。未运行 Linux／WSL、真实模型或 GUI；其他 Ctrl+Q、通知／压缩、JchTools、工具纠偏与 WebSocket 证据限于原记录源码 |
| 循环轮次间隔（历史验证，规格已删除） | 当时的 `/loop` 位置间隔、包含首轮的次数、总时长及 TUI 宿主等待取消 | 限制参数后 `3D` 等非时长正文保持原文；解析边界回归、真实解析冒烟及 LSP diagnostics 通过。两端真实 `cli.ts --mode rpc-ui` 经 localhost 模型服务验证数字前缀正文送达、旧用法、位置间隔的总轮数、慢轮结束后的完整等待与会话删除（对应独立 RPC 场景退役前源码）；相关回归及同提交 fork-affected slowtest 通过。实际 TUI loop 终端交互与真实模型未验证。位置间隔已移除，这些记录不代表当前行为 |
| [界面显示模式](specs/personal-commands/spec.md#requirement-1-三种显示模式)（旧版历史验证） | 当时的经典模式隐藏工具与思考，全量沿用上游；紧凑模式优先显示运行中工具，仅有隐藏调用时显示低强调累计摘要，两行思考，最近三次真实写入的原版卡片（仅最新展开），以及 30 秒后自动刷新的 Bash 日志；失败和待输入立即提示；全部改动只影响显示，不改模型上下文或执行 | 新增回归先红后绿，相关定向测试及 TUI／coding-agent lint、格式、类型检查通过。隔离 localhost 模拟模型＋`bun run dev`＋`tui-test` 验证三档、插话与中途正文、并发工具与摘要阈值、真实 write/edit 折叠、短失败与审批、前后台长 Bash、无输出／静默计时、真实 `/compact soft` 上游压缩卡；日志刷新未新增模型请求。模型上下文及会话记录的三档切换前后 JSON 等值回归通过，证据在 `node_modules/.cache/fork-tui-e2e-v2/`。未运行 fulltest／slowtest、Linux／WSL 或真实 native 终端 E2E。 |
| Clear 已结束待办清理（已移除） | 旧实现曾在 `/clear` 时清理全部已完成／已放弃的当前清单 | 历史验证：Windows 三个定向回归文件共 63 项通过，并曾以隔离 `bun run dev` ConPTY／VT 验证该行为；证据 `node_modules/.cache/clear-todo-smoke-evidence.json`。该需求和实现现已移除，这些历史结果不代表当前行为；`/clear` 保留当前清单。 |

**Goal 历史修复范围：**当时 `/goal` 与 `/goal-autopilot` 原始命令改为直接进入同一原生 Goal 控制器，不要求 fork 强制排队或 dequeue／提升时解析；生成的执行正文仍遵守原生 prompt／steering、调用方流式输入方式、`inputId`／`sourceCommand`、普通 follow-up、Stop held、维护及 owner 边界。该轮还修复了分支状态隔离、当时 active 无人值守 Goal 的 `ask` 超时与取消区分、保留 Stop 后首次通知单次交付、预算耗尽后的恢复限制，以及取消首次入场时恢复实际工具集合。下述验证早于 2026-11-22 实现的无人值守审批、表单超时和结题复核，不能作为这些行为的验收证据；现行要求见 [Goal 验收条件](specs/spec-driven-orchestration/spec.md#requirement-7-验收条件)。

**Goal 验证（2026-11-05）：** Windows x64 的原生 CommandHost 分支恢复、保留 Stop 后通知恰好交付／持久化两项定向运行通过；首轮类型收窄错误及与当时 GLM-5.3 KDL 策略冲突的旧静态能力断言已修正。使用本地模型替身，不证明真实模型任务质量或 Linux／WSL 行为。

历史 Windows 隔离源码 CLI 的独立 OpenSpec 上下文查询返回 proposal／specs、空 tasks 和 ready，不要求 Superpowers 或 OMP 状态；技能正文与固定上游比对仅有命令前缀适配。最终隔离子命令验证不经过模型；临时冒烟脚本因参数顺序错误误入普通对话而收到真实服务 402，未作为验证证据。未重建 exe，也未验证完整门禁、Linux／WSL 或真实模型质量。

当轮定向修补包含 Compact 补全与覆盖告警文案、压缩日志、共享文件会话删除及 Team 提案文字预算和空理由推荐。Windows 9 个相关回归文件 286 项通过、0 失败，报告 `runs/test-timing/2026-10-17T12-38-44.451Z-40008-fd06592d/run.json`；两处类型修正后仅复验两个受影响文件，118 项通过，报告 `runs/test-timing/2026-10-17T12-40-06.731Z-50752-04707678/run.json`。13 个改动 TS 文件格式化／oxlint 通过，LSP 无类型错误，测试文件保留提示。真实回环 HTTP 压缩失败的安全日志／原错误、文件存储删除成功／主文件失败、Team 两处解析拒绝已作定向冒烟。收到停止测试要求后未再运行检查或冒烟；未运行完整门禁、真实 Team 模型、TUI 或跨平台验证。

离线会话默认目录审查补修：当时 Linux 上两个会话路径回归文件 26 项通过，修改文件的 oxlint 与 LSP 类型检查通过。报告 `runs/test-timing/2026-10-17T06-09-56.523Z-311593-672aa5a8/run.json`。收到用户停止测试要求后未再执行测试或冒烟，真实 CLI／TUI 端到端仍未验证。

Repo 按需设备专项（当时也含现已退役的本地文档索引设备）：5 个相关回归文件共 126 项通过，覆盖设备审批不继承 `write` 的拒绝／询问策略、查询工具自身的显式审批、真实 agent-loop 共享查询调度、普通文件写入独占，以及既有挂载／清单／权限边界。隔离的真实 CLI 经 localhost OpenAI 协议服务验证：`write: deny` 下两个 Repo 查询返回真实本地索引证据，含另一设备在内的最大并发查询数为 4；随后普通文件写入被用户策略拒绝，目标文件未创建，配置文件未改写。修改的 6 个 TypeScript 文件格式化与 oxlint 通过，LSP 无类型错误（回归文件仅有既有 await 提示）。先前 4 个相关回归文件 43 项及普通／`OMP_OFFLINE=1` CLI 的说明发现与索引查询证据仍限于此前记录的源码；本次未运行 fulltest／slowtest、Linux／WSL、真实模型或 TUI。

每条需求只有一个权威维护位置。修改已有功能时更新对应文档；新独立功能域可新增文档并更新本表，不按篇幅机械拆分。跨功能关系通过链接表达，索引不复制具体条款。目录或权威体系缺失时先补齐，再修改实现。

各功能域的验证状态以本表为准；不得将静态检查、文档更新或先前工作树测试视为当前功能验收。只有相应验证实际通过，才可标记验收通过。

团队共享技能目录不依赖 `OMP_OFFLINE`；当时 Windows 静态检查通过，不等同 Linux／WSL、公司 NFS 多机并发、真实模型或 GUI 验收。

本轮三项 P1 最小修补（源码 HEAD `b9acb399c57b57ef0bc363650e0e82e71ba503b1` 加本轮未提交改动）均为**已实施，Windows 定向验证通过，但完整验收未完成**；Linux 固定 Python 安装与 CentOS P0 阻塞仍未解决，真实公开入口的已验范围与证据边界见下文。需求细则以 [Fork 运行规格](../openspec/specs/fork-runtime/spec.md) 为准，不以代码改动或静态检查替代功能验收：

- Python Eval：Windows runtime／probe 三个相关文件 26 项通过／24 跳过；真实 `executePython` 使用 Python 3.13.15 计算得到 `42`，父进程 PATH、venv 与 PYTHONPATH 未变；显式指定不存在的解释器时明确拒绝，即使系统 Python 可用也不回退，证据 `node_modules/.cache/p1-p0-acceptance/python-smoke.json` 中 `explicitMissingRejected=true`。WSL CentOS 显式使用 `/usr/bin/python3.6`（实际 3.6.8）运行一项 `unittest`，`sum([1,2,3]) == 6` 通过，仅证明现有业务解释器可启动，本轮未修改它。上述结果不是 Linux 固定 `/software/public/python/3.11.4/bin/python3.11` 的 Eval 分工验收；现成 CentOS 环境没有该安装，仅有 3.11.16／3.6.8，不能用其他版本或路径重定向夹具替代。
- Extensions 共享技能管理：已实施 Shared 裸名优先、namespace 版本保留、禁用项管理、当前宿主会话配置隔离与执行侧扫描前过滤关闭来源。最新 skills／dashboard／ACP／公开 skill read 四文件 171 项通过／1 跳过／0 失败，报告 `runs/test-timing/2026-10-17T01-51-51.189Z-95872-b74da263/run.json` 为 complete；管理仍保留关闭来源及诊断，执行不扫描这些根或返回其警告。当前源码真实 ConPTY 的七个终端帧覆盖 Shared 来源与正文、禁用、重开刷新仍禁用、恢复启用、共享调用、namespace 个人调用及个人管理行；localhost 两次请求的最后用户消息分别包含正确版本正文，技能源文件原字节未改，CLI 正常 exit=0，证据 `node_modules/.cache/p1-p0-acceptance/shared-current-smoke.json` 与 `.ansi`。另一真实 ConPTY 在其他 Settings hold 绑定期间验证父面板与实际调用仍使用父配置、关闭来源仍显示 Disabled，证据 `review-fixes-smoke.json`。两次交互的业务断言均通过，但执行器清理临时目录时报 Windows EBUSY、外层命令 exit=1；进程退出后父级复用既有 `removeWithRetries` 完成清理，见同目录的清理记录，不将执行器退出码改写为成功。这是本地交互与协议证据，不是 NFS／公司实网验收；此前失败报告保持原状态。
- Offline 子命令：Windows 真实 CLI 通过 localhost 服务完成公司 vision 请求，并覆盖公司配置缺失、坏 JSON、显式非 company vision／default 选路、禁止隐式回退、普通读取、纯渲染及 dry-balance／usage 的定向路径；配置原字节保持。最新 `offline-subcommands.test.ts` 8 项通过／0 失败，报告 `runs/test-timing/2026-10-17T01-54-09.139Z-84936-9f0b9c8b/run.json` 为 complete；显式非 company 图片问答的独立真实 CLI 请求返回实际协议答案、exit=0，公司错误仍输出到 stderr，证据 `node_modules/.cache/p1-p0-acceptance/review-fixes-smoke.json`。退出守卫及无 preload／trace 的纯 `render` 沿用此前通过证据 `runs/test-timing/2026-10-17T01-20-02.679Z-41752-13a97a98/run.json` 与 `render-diagnostic.json`，未改写修补前失败。既有 `read-cli-image-question` dead-endpoint 用例的 exit=0 断言失败未修改、未重跑，不能把基线失败或未复验场景记为通过。公司真实网关／凭据、实际 OAuth／X 服务与 Linux 全链路尚未验收。

本轮审查补修的 12 个 TypeScript 文件已复用现有缓存 oxfmt 0.65.0 格式化，oxlint 1.80.0 检查为 0 警告／0 错误；tsgo `7.0.0-dev.20260707.2` 对 coding-agent 执行 `--noEmit`，exit=0，utils 输入未变，复用此前 exit=0 的类型结果。证据为 `node_modules/.cache/p1-p0-acceptance/review-static-results.json`，此前实施范围的结果保留在 `static-results.json`；未安装或链接这些静态工具。TS／JS LSP 不可用，不将静态结果替代运行时验收。

本轮专项未运行 fulltest／slowtest；公司实网、固定 Python 3.11.4、CentOS 3.10 内核及真实 NFS 的缺口均保持未验收，Windows／localhost／WSL2 结果不得相互替代。环境副作用：最初调用 `rustc --version` 触发现有 rustup 自动修复部分安装的 nightly，日志记录九个组件下载；虽非主动安装命令，但实际发生下载，不能声称全过程未安装工具。后续设置 `RUSTUP_AUTO_INSTALL=0` 并使用 Cargo offline；未修改 Python、发行版、挂载或有效缓存。

上游基线 `e7fe31891092`、验收源码 `e948b495d4bd` 加当轮工作树的 Windows 证据覆盖 native 构建、真实 dev-TUI 基础、Team 运行／取消及 Repo 链路。历史报告 `runs/test-timing/2026-10-16T13-39-58.393Z-79028-5f0e9da6/run.json`；未运行 Linux／WSL、真实模型或共享桌面输入，不代表当前基线的功能验收。

上游基线 `c2cb79e4c227`、验收源码 `57b4fffb5720` 加当轮工作树的 Windows 证据覆盖 native 构建、真实 dev-TUI 基础、Team 运行／取消和 Repo 链路。报告 `runs/test-timing/2026-10-15T04-19-29.794Z-70844-ee343a41/run.json`；未运行 Linux／WSL、真实模型或共享桌面输入。

当前审查修复的专项验证还包括：真实 native `rmdir`；跨进程维护锁持有超过 6.2 秒时的公开 repo 查询、pending 保留与释放后刷新；真实 `rpc-ui` 的 loop 耗尽后 Goal 续跑、计划拒绝后 loop 重臂、实际 read／propose 往返及坏 CodeAgent 保留段不阻断本地 Provider；公开命令 API 的 preset 写盘重载和无选择 UI 的 logout 持久状态。Windows Git Bash 下 POSIX 安装器 11 个隔离场景通过，不代表真实 Linux／musl 主机或 Homebrew 验收。证据保留在忽略目录 `node_modules/.cache/audit-*-acceptance*.json`；保留失败尝试，须按最终 `passed`／`pass` 状态区分。

上表较早跨平台验证对应上游基线 `f979f4639777` 与集成提交 `31fe1f9d6e`，不代表当前基线已验收。JchTools 并发刷新使用认证初始化后的可控时钟，欢迎提示使用确定性的实际宽度／占位符展开回归。

补充验证：显式继承 `OMP_CONFIG_ROOT` 的 YAML／native 目录三个回归文件 15 例通过；捕获流两个回归文件 106 例及真实 CLI 的 stdout／stderr 流式捕获和去重冒烟通过。

Windows 安装器专项：Windows PowerShell 5.1 下 14 个用例通过，11 个 POSIX 用例按平台跳过；覆盖系统代理、显式环境代理优先级及下载回退的真实 HTTP 边界，以及校验失败、替换/回滚失败、PATH 部分完成、带单引号路径的可执行恢复/重试命令和运行中映像替换。真实 `install.ps1 -Binary` 入口已验证清空代理环境变量后经本机 Windows 系统代理下载 fork Release 并运行版本命令；实际文件锁故障非零退出、打印恢复指令、保留可运行下载且不损坏旧安装，临时 PATH 项已移除。未运行 fulltest/slowtest；PowerShell 7、另一台机器 未验证。

Windows 运行时代理专项（`installGlobalProxyFetch` 系统代理回退）：`packages/ai` 代理相关 4 个测试文件 60 通过／1 平台跳过，覆盖注册表输出解析、按 URL 注入、环境变量及单请求代理优先级、`NO_PROXY` 和回环绕行。本机读取实际系统代理后，HTTPS 请求使用 `http://127.0.0.1:7890`、`NO_PROXY` 命中不注入、显式 `HTTPS_PROXY` 优先于系统代理。未验证真实 LLM 出网或 Linux／WSL 行为。

零配置 TLS 默认（`applyForkNetworkDefaults`）：单测 3 例通过（未设→默认 `0`／`true`，保留显式 `NODE_TLS_REJECT_UNAUTHORIZED=1` 和 `GIT_SSL_NO_VERIFY=false`）；自签证书真实链路验证默认生效（证书错误→200）、显式 `=1` 恢复严格校验。未验证真实 TUI／RPC 主进程全链路和 Git 子进程继承。

安装器 PowerShell 兼容专项：Windows 定向安装器回归 24 通过；更新下载／替换既有回归 23 通过／1 平台跳过。PowerShell 5.1 与 7.6.7 均在排除 `pwsh.exe` 的 PATH 下，通过自签 HTTPS 的真实元数据请求、curl 下载和 Invoke-WebRequest 下载；5.1 修复前复现相同发送错误，修复后通过。隔离的系统 PowerShell 5.1 真实执行当前 `install.ps1 -Binary`，再由安装的现有 `18.12.2` 二进制执行 `omp update --force`，下载、SHA-256、替换及最终版本核对均成功；当前 `18.12.4` 源码的 fork 更新入口也完成同一替换链路。冒烟使用本地自签 HTTPS 代理夹具与现有二进制，不是公网最新 Release 升级验收；临时安装、配置、代理及本次新增的用户 PATH 项均已清理。证据 `node_modules/.cache/installer-ps51-20261021/evidence.json`。

README CMD 安装命令：根 README 新增的 CMD 等价安装命令（curl 下载脚本 + `powershell -File` 执行）已在真实 cmd.exe 完整验证一次：隔离 `PI_INSTALL_DIR` 下解析最新 Release、自动经本机 Windows 系统代理下载二进制、安装成功 exit 0、`omp --version` 报告 `omp/18.9.2+fork.307`；验证后用户 PATH 已恢复原值、临时安装与配置目录已清理。PowerShell 5.1/7 的原有单行命令行为未变，未重复验证。

CodeAgent 认证专项：当前用户 DPAPI 合成密文经真实 JchTools 独立后台写入隔离原生 `REG_SZ`，真实 OMP CLI 无手工模型／认证配置完成旧 Token 失败、后台轮换、唯一重试、实际 read 工具执行及最终回答；认证比较仅在内存进行，输出和日志无 Token。OMP 认证、压缩、handoff、恢复及普通模型回归 203 通过／4 跳过，修复前已复现空注册表值破坏缓存及摘要／handoff 外层重放。JchTools 原生后台与 GUI TestingBackend 回调验证通过，SQLite 争用期间维持同一实例；共享桌面和真实 CodeAgent 服务尚未验证（本机缺少真实凭据）。

系统代理内网绕行清单：`proxy.test.ts` 61 例通过，覆盖公司域名后缀、单标签主机、IP 前缀及 glob 命中，公网相邻地址和无关公网主机不误伤；验证公网 URL 注入系统代理、内网域名和 IP 不注入。未验证真实内网目标连通性。

输入框路径宽度专项：状态栏溢出与上下文回归 46 例通过；真实 `bun run dev` ConPTY 验证 80 列路径恢复到配置上限、42 列按实际剩余宽度截断、再扩至 80 列恢复，上下文标签靠右且正常退出。使用隔离配置和本地模型定义，未发模型请求；Linux／WSL 未验证。

## team.md — 8. 验证状态

* **真实 GPT-6 Luna 专项：** Windows 使用实际 `openai-codex/gpt-6-luna`，无模型 stub，分别从 `cli.ts --mode rpc-ui` 和 `bun run dev` 原生 ConPTY 的 `/team` 入口完成缓存修复规划与生产证据不足诊断。每场三个独立提案使用相同原始输入并分别查询当时内置的本地文档索引，随后实际执行对齐、三个初审、按需修订／复核与综合，共 10／12 个真实模型子调用；子会话记录的模型均为 Luna，实际调用仅含只读工具及 yield，两个测试项目内容和文件清单未变。缓存场景识别在途合并与成功 `undefined` 缓存两项问题，并给出同键、跨键和失败后重试的判别性验收建议；诊断场景明确生产根因未确认、没有已导入的索引及请求级证据缺口，未把摘录当作生产因果证明。两个全新会话均直接以 `/team` 开始，报告已实际落盘且退出后仍保留，CLI／TUI 均正常退出 0；真实终端已观察到报告、理解差异与只读收尾契约。证据及范围：`node_modules/.cache/team-luna-verification.json`，其中链接完整报告、子会话和终端记录；仅证明这两个受控场景，不代替公司真实项目验收。
* **首次报告持久化回归：** `parallel-review-SessionRuntimeCompact-regression.test.ts` 与 `team/controller.test.ts` 共 34 项通过、0 失败，覆盖没有普通 assistant 轮次时首次自定义报告的持久追加、退出和重开恢复，已观察修复前失败／修复后通过。报告 `runs/test-timing/2026-10-16T20-19-59.649Z-61496-56a555fb/run.json`。
* **Windows 定向回归：** Team、命令、真实图片输入／压缩重放、文件读取、MCP、Repo 生命周期与 Markdown 共 19 文件、640 项通过、0 失败。覆盖会话切换与迟到结果、真实文件／选择器／链接／临时 lease 隔离、否定和条件语义、实体推荐门禁、53 槽位多字母标签与阻断 ID、调查受阻及已完成但无解的不同结算。报告 `runs/test-timing/2026-10-18T00-11-55.512Z-79144-868fd337/run.json`，exit=0。当时 TypeScript LSP 不可用，由 tsgo 类型检查通过。
* **当前源码公开入口：** `bun run dev` + `tui-test` + 隔离 localhost Anthropic stub 实际完成正常五阶段／两轮逐 ID 复核、否定说明、条件说明、HTML 实体拒绝、必需资料缺失提前结束、三槽位普通文件越界拒绝及取消；异步 input hook 中粘贴的新图片在派发前后均为 `#1`，下一条真实模型请求仅携带该新图，持久记录的来源为 `image-b.png`。六条成功或未完成报告退出后均已落盘，取消的运行不追加结论，TUI 正常退出 0。真实 RPC 同时验证子代理列表、转录、ownership 取消与在途会话切换，旧问题与报告未写入切换目标的内存或磁盘会话。证据索引：`node_modules/.cache/team-acceptance-20261018/acceptance.json`（含请求记录、终端操作／截图、持久会话和 RPC 明细）；临时驱动脚本已移除。既有未知／重复 ID 的 TUI 证据仍见 `node_modules/.cache/team-finding-evidence/1792154293774/report.json` 与 `1792154437975/report.json`，不冒称本次重跑。
* **未改动名单规则的既有证据：** `members.ts`、`controller.ts` 的成员选择规则本次未改；未配置／A／AB／ABC／ABCD 的真实 TUI 五场景证据继续限于 `node_modules/.cache/team-roster-evidence/1792152393470/report.json` 所记录源码，不扩展为当前全功能验收。
* **未验证范围：** 本次未运行 fulltest／slowtest、Linux／WSL、真实公司网关或真实模型；压缩队列图片恢复由真实 composer 消费者单测验证，未另跑真实 TUI 压缩交互。GPT-6 Luna 的既有两个受控场景不证明当前公司服务可用性或任意实际项目的方案质量，第 6 节真实公司模型验收仍未完成。

## 迁出规格的实施与验收状态

### team-configuration — Team 配置当前实现状态

**实现状态：TUI 与共享配置服务已接入。原标题为兼容既有章节链接保留，不表示仍未实现。**

### team-configuration — Team 配置当前实现状态

**实现状态：共享服务、Settings／YAML 保存及 TUI／CLI 接入已完成；原 RPC v3 wire 适配已随独立 RPC 场景退役删除；Windows 定向证据不等于当时的真实 Linux／NFS 双端及跨主机验收。原标题仅保留链接锚点。** 当前 `ConfigFile`／`ModelsConfigFile` 只有读取／迁移，没有主动保存 provider 定义的 API；不能把 Team 保存接口描述为 provider 配置接口。历史上的 offline 双端写要求已退役，不约束当前或未来实现；任意文本 `edit` 不具有程序保存服务的锁、版本和事务保证。

### team-configuration — Team 配置旧标题状态说明

**状态说明：原标题仅为保留既有锚点；本节验收已在 Windows 定向范围内部分执行，不再表示全部尚未执行。** 以下保留历史记录；未覆盖的交互、平台及部署条件不构成通过证据，已退役能力不再作为当前验收目标。OMP 原有定向证据见[需求目录](verification-history.md)。

### team-configuration — Team 配置定向验证记录

* **当前状态：** 配置入口与共享服务已实现；Windows 七个相关文件去重 59 通过／2 平台跳过，另有真实 TUI／CLI 入口证据（原 RPC 入口证据对应独立 RPC 退役前源码）。此为特定范围的最小行为回归，不是全仓或本节全部验收通过；当时真实 Linux／公司 NFS 跨主机锁、CentOS 和真实公司模型未整体验收，跨主机锁能力已退役。第 8 节既有讨论证据仍只覆盖原场景；OMP 原有定向证据见[需求目录](verification-history.md)。

### offline-shm — 配置双写定向验收状态

本节保留已退役的 Linux offline 配置双写能力及其验收历史，不再是当前或未来实现的保存要求。彼时 Settings 共享保存、Team TUI 与 CLI 配置入口已接入双端保存机制，Windows 定向回归及真实入口已有证据（原 RPC 入口证据对应独立 RPC 退役前源码）；标题“程序实现待验收”保留，真实 Linux／公司 NFS 跨主机锁及 CentOS 实机当时仍未验收，Windows seam 不能代替。实施与验证状态、失败复验记录见[需求目录](verification-history.md)。


## 其他迁出规格的验证说明

### model-providers

- Windows 定向冒烟通过：隔离真实 CLI 列出六个模型，仅环境变量提供认证，本地 HTTP Anthropic 流式响应成功，核对 Bearer、严格工具字段缺席及 `high` → `xhigh`。未调用真实 Ascend 服务，未运行完整门禁；本地模拟不代表公司网关连通性或真实模型能力验收。

### fork-runtime

实现与新增回归当前未运行验证，不以源码用例替代编译二进制的真实生命周期验收。

