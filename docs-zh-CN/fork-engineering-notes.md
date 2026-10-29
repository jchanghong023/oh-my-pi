# Fork 工程现状线索

本页保存当前仍有本地代码差异的散点修复线索，以及使用、实现定位与验证参考。部分条目的必要性仍待按实际使用场景核对；已被上游吸收的特性与修复不列入本页。

## 上游缺陷散点修复

基础设施修复只在已确认使用场景确实依赖时保留；不因历史上修复过就形成独立维护义务。以下剩余补丁是待核对必要性的现状线索，不代表已确认必须保留，也不能在未核实依赖前直接认定可删除。上游已包含等价修复后，移除重复实现及 fork 额外保留的回归测试，fork 测试聚焦仍有效的本地差异。

- `packages/coding-agent/src/lsp/clients/biome-client.ts`：Windows 上 abort 与 stdout 管道读取 race，脚本包装的孙子进程不再持有管道造成永久等待。
- `packages/utils/src/ptree.ts`：stdout 经包装流跟踪 EOF（attachSignal 等待 stdout/stderr 收尾、stdout 惰性暴露与完成后收口），孙子进程在截止/中止后持有管道不再永久挂起读取；`packages/utils/test/ptree-timeout.test.ts` 覆盖。
- `packages/coding-agent/src/session/agent-session.ts`：用户及自定义 aside 的预处理跨越 `switchSession()` 时，统一等待已有代际结算屏障；切换回滚保留原会话的消息，成功切换仍丢弃旧会话的延迟消息。
- `packages/utils/src/sqlite.ts`：输入历史、会话标题和 recap 的损坏恢复不得遗漏多个坏页之间仍可读取的记录；保留损坏原库和既有恢复上限，不改变健康数据库的读取路径。
- `packages/coding-agent/src/launch/client.ts`、`packages/natives/native/loader-state.js`：独立长寿命 daemon broker 在实际 worker 启动、native 加载前，把 native 缓存所有者切到自身 scope runtime 的 `natives/`，不能继承短寿命 creator core 的独占 `PI_NATIVES_DIR`；正常 core／worker 的显式缓存根语义不变。并发冷启动的 embedded 提取与 Windows 包安装 staging 均先写唯一临时文件再原子发布；Windows 已加载 winner 阻止替换时，仅完整字节一致才可复用，否则保留发布错误，不能截断已发布 DLL。
- `packages/coding-agent/src/tools/read-archive.ts`：Windows 同尺寸快速重写归档并恢复 mtime 时，ctime 也可能不变；该平台不复用仅由文件元数据验证的归档目录缓存，避免返回旧成员名称或读取错误成员。其他平台保留既有有界缓存。
- `crates/pi-builtins/src/rmdir.rs`：Windows 普通路径不得经末尾 `.`／`..` 或分量尾点／空格归一化删除另一目录；显式 verbatim 路径继续按字面处理合法尾点／空格目录，Unix 字面路径语义不变。
- `crates/pi-shell/src/shell.rs`：TERM 宽限等待按平台编译：Unix 继续异步等待清理，Windows 的 TERM 本已强制结束进程，返回立即就绪的 Future；不增加延迟，也不屏蔽 `clippy::unused_async`。
- `crates/pi-natives/src/memory.rs`：非 Linux/glibc 平台的空操作入口使用 `const fn`，满足 Windows 静态门禁；Linux/glibc 继续执行原有工作计数、释放通知与空闲裁剪，不屏蔽 lint。
- `crates/vendor/brush-core/src/interp.rs`：前台子进程已启动后收到取消时，仍通过既有取消感知等待保留 TERM 清理宽限；不能因等待前的取消检查提前丢弃子进程并强制结束，导致清理或输出丢失。取消总时限与进程隔离规则不变。
- `crates/pi-shell/src/process.rs`：取消时每一波信号在发送前冻结自有目标，同一进程／进程组不重复投递 TERM，避免重入清理 trap；跨组后代与 TERM 后新生进程仍由后续 KILL 波回收，保留既有进程身份保护和宽限时限。
- `crates/pi-natives/src/memory.rs`：glibc Linux 保留原有堆修剪计数与释放通知，其他目标的平台空操作使用独立 `const fn` 定义，满足 Windows 严格静态门禁，不屏蔽 `missing_const_for_fn` 或改变运行时行为。
- `python/robomp/src/tasks.py`：GitHub 元数据读取失败须向 delivery 执行器传播，保留重试机会，不能把未执行的 PR 审查、review 或 conversation 当作已成功处理；映射缺失或 branch 缺失时查询 PR 的失败同样不得吞掉。Robomp 普通测试在 Linux 纳入本地门禁，Windows 原生不支持。
- `.zcodeignore`：ZCode 客户端忽略清单（上半部从 `.gitignore` 同步，下半部为 ZCode 默认排除规则）；不改变 omp 行为，属开发环境配置。

## 使用与验证参考

以下材料仅供查找实现和验证入口，不构成需求基线，也不表示本次已运行或通过。

### Fork 门禁与 Dev TUI 分片

- 三层门禁直接运行既有 Bun／Cargo 原语，保留源码快照、预算和失败汇总；slowtest 运行本机 fulltest 及适用的 WSL fulltest。本地 TS、全部仓库脚本、Rust workspace/Nextest/doctest 和本平台适用的 Python 普通 pytest 每轮全量执行，不按 HEAD、upstream 差异、依赖覆盖率或历史 PASS 选测。`CI` 与本地 TS 的 `OMP_TEST_SHARD` 不改变全量范围；TS 的 `--full` 仅控制详细输出。
- `bun run test:py` 不再使用 pytest-testmon；Windows 原生的 `test:py` 和 fulltest 完整运行 Python RPC SDK 普通套件，Robomp 因不支持原生 Windows 明确报告跳过，不记为通过。Linux 保留 Robomp 和 Python RPC SDK 两套普通测试。Robomp integration 仍需单独显式启用，Windows 原生调用报告不支持并非零退出，不记为通过。`bun run test:rs` 保留既有 Cargo workspace 与第三方排除，不再接受 `--affected`、`--experimental-affected` 或 `--full` 选择参数。
- 普通失败继续执行同文件、后续文件及其他独立语言套件，保留首个实际失败退出码；取消、完整性破坏和原有预算到限仍停止本次拥有的工作。每轮生成独立逐用例报告；编译和工具缓存可保留，不缓存测试 PASS 或跳过用例制造第二轮提速。
- fastcheck、fulltest、slowtest 默认隐藏成功用例、成功分块及成功命令输出，仅显示失败用例和错误诊断；最外层最终状态、耗时、退出码和报告路径保留。`--debug` 不恢复成功用例刷屏。静默只影响呈现，本平台纳入门禁的用例仍实际执行并写入完整 JUnit／计时结果，平台跳过明确报告，首错通知、失败继续、取消与预算不变。
- 手动 CI 只执行构建、打包及其必要准备，不执行单元、集成、冒烟或安装测试，发布只依赖版本元数据、二进制和浏览器扩展构建成功。保留的 `ci:test:*` 名称是显式测试工具，不由工作流调用；本地 fulltest／slowtest 仍须用户明确授权。现有上游显式目标 Bazel 工具和产物保留，不恢复 fork 专用 Bazel 图或引入统一框架。
- 测试运行器按可用核心数动态限制并发，任务不足时再缩小；Windows 本机 TS 初始完整轮及无合格计时提示时最多 `min(14, 可用核心数)`。只有前次真实 fulltest 完整执行并成功、报告完整校验通过、在 7 天内且平台、架构及 post-native 完整源码指纹一致时，fulltest 的 TS 短任务池才可提升至最多 `min(20, 可用核心数)`；报告缺失、过期、失败、不完整或任何不一致均回退到 14 的上限。Windows Rust Nextest 始终最多 `min(14, 可用核心数)`，Linux 等其他平台维持 `min(28, 可用核心数)`。Bun 的 chunk 池和文件 worker 共用预算，显式配置仍可降低并发。TS 与 Rust 并行时各自并发可能叠加，静态检查并发、测试覆盖、隔离、超时、时间预算及计费保持不变。
- fulltest 可将合格的既有完整计时报告用于启动排序和资源容量提示；报告缺失、不完整或无对应耗时不妨碍必需测试执行。历史 PASS、缓存或跳过均不能作为本轮通过，所有必需测试每轮完整执行。本地高成本 integration／E2E chunk 同时最多 4 个，仍受 Bun 测试并发上限约束；达到子限制时空余并发继续运行其他可调度工作。原有分片、超时、断言、覆盖及结果合同不变；是否提速和稳定须以实际完整运行验证，尚不能预称通过。
- fulltest 的 TS／Python／隔离 TUI 套件可同时启动；Rust 测试只等待 Rust 静态检查结束，不再等待无关的 TS 静态检查。仓库脚本先运行安全的并行夹具批次，其余脚本仍串行且先于重型套件，保留门禁时钟自测隔离。
- singleton／全局状态桶按最多 10 文件切成独立进程，每个进程仍以 `--parallel=1` 执行；UI 与 Windows runtime／native 的原有分块隔离不变。明确命名的 E2E／integration chunk 在分片选择后优先启动，减少长任务排队，不改变分片归属或全量覆盖；本地入口不因继承 `CI` 而退回串行。
- 功能回归夹具显式启用被测能力：idle maintenance 用例自行开启 recap，仍保留 fork 的默认关闭及显式关闭覆盖；顾问配置验证布局、选择、鼠标操作与工具授权差异，不绑定中英文提示文案。
- Cursor TLS reset 子进程按退出码与结构化错误事件验证传输合同，stderr 保留为失败诊断，合法的运行时警告不当作协议错误。Rust CLI 选择夹具沿用既有用例／门禁时限，不另设提前终止子进程的 10 秒截止。
- 受限目录审批夹具从当前选项解析一次允许／拒绝，未知回答仍拒绝执行；不再返回过时的英文标签。SDK 恢复夹具先关闭原 journal 所有者再重开，以模拟进程退出，不能只 flush 后让两个存活 manager 同时占用日志。
- 首事件禁用回归验证超过 idle 预算后仍可成功收到正文，不再断言整个进程没有其他定时器；透明预览回归验证实际终端单元的显式前景色和透明背景，兼容 256 色及真彩编码，不绑定翻译文本。命令报告以输入／补全完成后的实际呈现边界核对恢复、主屏无污染和历史无重复，不将输入阶段的重排归因于报告。
- Windows sed 文件截断夹具验证 Windows 流式读取与 Unix 打开时快照各自的既有合同，取消手工过滤；Python `export_html` 按 `Path` 比较跨平台结果，而非要求 Windows 路径呈现为 POSIX 字符串。
- TS 全量入口覆盖原先遗漏的 `stats` 及 `metaharness`，后者包含包根目录下的 edit adapter 测试。历史费用回填用例使用独立的分时／分日期价格夹具，不假定实时模型目录中某个型号必然在固定日期换价；仍断言费用、缓存节省及重启后的回填结果。
- Dev TUI 场景分布在 `tui.e2e.test.ts`、`tui-materials.e2e.test.ts`、`tui-materials-later-roles.e2e.test.ts`、`tui-interactions.e2e.test.ts`、`tui-resources.e2e.test.ts` 和 `tui-resource-lifecycle.e2e.test.ts`；`tui-harness.ts` 维持隔离及超时。
- 协同开发公开进程 E2E 的 18 个完整场景按两个测试文件分片；共享进程与 provider fixture 保持每个场景的独立目录、会话和超时。
- OpenSpec 资源授权 E2E 先确认多行草稿及光标已进入真实输入框，再单独发送 Enter；每轮关联独立输入和完成标记后检查原生读取结果，不用旧回复或画面 idle 代替当前工具轮完成。缺失完成报告的 E2E 检查状态区材料提示、`/session` 完整读取诊断及阶段／批准不变，不要求原始 `ENOENT` 直接出现在状态区。
- ZCode 的 35 个真实 stdio 进程用例按会话、执行、投影及目录等职责分成五个文件，共用 `zcode-process-harness.ts`；workflow 的三个用例分成文件／预检和 sandbox 两个目标，共用 `zcode-workflow-process-helpers.ts`。每例仍使用独立目录和 app-server，保留原用例及超时；workflow 两个文件分别注册清理钩子。workflow fixture Host 对未实现的 `subagents/readRuntimeConfig` 及时返回协议错误 `-32601`，不靠等待生产端超时模拟不支持。
- 递归 submodule 隔离用例中的独立只读 Git 查询并行执行；copy／rcopy 两条路径、父工作树不变、对象保留及分支合并断言与原 30 秒用例预算保持不变。
- 验证时按授权运行对应局部测试及门禁，并核对场景、隔离、超时和实际报告；入口存在不代表已通过。

### Repo 索引验证入口

现有 UT/集成入口为 `packages/coding-agent/test/repo-index.test.ts`、`repo-lifecycle.test.ts`、`repo-tool.test.ts`、`repo-review-regressions.test.ts`、`lsp/edits.test.ts` 和 `packages/natives/test/python-symbols.test.ts`，涵盖最佳匹配、扫描中取消、外部变化复核、真实强杀后的代次回收、并发读快照、设备执行状态、LSP 部分提交／回滚、删除路径身份及长路径确认；真实 TUI E2E 为 `scripts/repo-ui-smoke.ts`，已由 `scripts/fulltest-ui-smoke.ts` 接入 `bun run fulltest`。`scripts/repo-index-perf.ts` 提供合成语料基准。这些入口的存在不代表本次运行通过，执行仍遵循 `AGENTS.md` 的授权限制。

### Provider 配置保存现状

当前 `ConfigFile`／`ModelsConfigFile` 只承担读取／迁移，没有主动 `models.yml` writer 或 provider 保存 API；Team 接口不提供 provider 配置。Agent 获授权新增 provider 时，不能把任意文本 `edit` 视为具有共享程序服务的锁、版本校验或事务保证。

### TUI 显示验证参考

使用**模拟模型 + tui-test**验证：

- 三种模式、插话不拆轮、历史隐藏、普通工具优先级与数量、长命令折叠、输入框上方固定单行思考及空闲留白、显隐时布局稳定性。
- 真实写入分类、最近 3 次 write/edit，以及最新展开、其余折叠。
- Bash 的 30 秒边界、短命令成功与失败、等待输入、无输出、前台转后台，以及跨轮次后台任务。
- 日志刷新不新增模型请求或工具调用。

### 中文界面验证参考

- 本次不增加测试；复用既有自动化验证。验收须观察真实源码入口的中文界面及关键交互，并运行当前平台 `bun run fulltest`；不得把静态文案检查或局部渲染冒充真实入口验收，也不得因汉化改写业务断言或放宽门禁。尚未实际执行的验证保持未验证。
