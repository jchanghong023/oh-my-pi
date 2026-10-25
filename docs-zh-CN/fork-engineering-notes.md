# Fork 工程现状线索

本页保存当前仍有本地代码差异的散点修复线索，以及使用、实现定位与验证参考。部分条目的必要性仍待按实际使用场景核对；已被上游吸收的特性与修复不列入本页。

## 上游缺陷散点修复

基础设施修复只在已确认使用场景确实依赖时保留；不因历史上修复过就形成独立维护义务。以下剩余补丁是待核对必要性的现状线索，不代表已确认必须保留，也不能在未核实依赖前直接认定可删除。上游已包含等价修复后，移除重复实现及 fork 额外保留的回归测试，fork 测试聚焦仍有效的本地差异。

- `packages/coding-agent/src/lsp/clients/biome-client.ts`：Windows 上 abort 与 stdout 管道读取 race，脚本包装的孙子进程不再持有管道造成永久等待。
- `packages/utils/src/ptree.ts`：stdout 经包装流跟踪 EOF（attachSignal 等待 stdout/stderr 收尾、stdout 惰性暴露与完成后收口），孙子进程在截止/中止后持有管道不再永久挂起读取；`packages/utils/test/ptree-timeout.test.ts` 覆盖。
- `packages/utils/src/sqlite.ts`：输入历史、会话标题和 recap 的损坏恢复不得遗漏多个坏页之间仍可读取的记录；保留损坏原库和既有恢复上限，不改变健康数据库的读取路径。
- `packages/coding-agent/src/launch/client.ts`、`packages/natives/native/loader-state.js`：独立长寿命 daemon broker 在实际 worker 启动、native 加载前，把 native 缓存所有者切到自身 scope runtime 的 `natives/`，不能继承短寿命 creator core 的独占 `PI_NATIVES_DIR`；正常 core／worker 的显式缓存根语义不变。并发冷启动的 embedded 提取与 Windows 包安装 staging 均先写唯一临时文件再原子发布；Windows 已加载 winner 阻止替换时，仅完整字节一致才可复用，否则保留发布错误，不能截断已发布 DLL。
- `packages/coding-agent/src/tools/read-archive.ts`：Windows 同尺寸快速重写归档并恢复 mtime 时，ctime 也可能不变；该平台不复用仅由文件元数据验证的归档目录缓存，避免返回旧成员名称或读取错误成员。其他平台保留既有有界缓存。
- `crates/pi-builtins/src/rmdir.rs`：Windows 普通路径不得经末尾 `.`／`..` 或分量尾点／空格归一化删除另一目录；显式 verbatim 路径继续按字面处理合法尾点／空格目录，Unix 字面路径语义不变。
- `crates/pi-shell/src/shell.rs`：TERM 宽限等待按平台编译：Unix 继续异步等待清理，Windows 的 TERM 本已强制结束进程，返回立即就绪的 Future；不增加延迟，也不屏蔽 `clippy::unused_async`。
- `crates/pi-natives/src/memory.rs`：非 Linux/glibc 平台的空操作入口使用 `const fn`，满足 Windows 静态门禁；Linux/glibc 继续执行原有工作计数、释放通知与空闲裁剪，不屏蔽 lint。
- `crates/vendor/brush-core/src/interp.rs`：前台子进程已启动后收到取消时，仍通过既有取消感知等待保留 TERM 清理宽限；不能因等待前的取消检查提前丢弃子进程并强制结束，导致清理或输出丢失。取消总时限与进程隔离规则不变。
- `crates/pi-shell/src/process.rs`：取消时每一波信号在发送前冻结自有目标，同一进程／进程组不重复投递 TERM，避免重入清理 trap；跨组后代与 TERM 后新生进程仍由后续 KILL 波回收，保留既有进程身份保护和宽限时限。
- `crates/pi-natives/src/memory.rs`：glibc Linux 保留原有堆修剪计数与释放通知，其他目标的平台空操作使用独立 `const fn` 定义，满足 Windows 严格静态门禁，不屏蔽 `missing_const_for_fn` 或改变运行时行为。
- `python/robomp/src/tasks.py`：GitHub 元数据读取失败须向 delivery 执行器传播，保留重试机会，不能把未执行的 PR 审查、review 或 conversation 当作已成功处理；映射缺失或 branch 缺失时查询 PR 的失败同样不得吞掉。独立 Python 回归不因此纳入 fork 本地门禁。
- `.zcodeignore`：ZCode 客户端忽略清单（上半部从 `.gitignore` 同步，下半部为 ZCode 默认排除规则）；不改变 omp 行为，属开发环境配置。

## 使用与验证参考

以下材料仅供查找实现和验证入口，不构成需求基线，也不表示本次已运行或通过。

### Repo 索引验证入口

现有 UT/集成入口为 `packages/coding-agent/test/repo-index.test.ts`、`repo-lifecycle.test.ts`、`repo-tool.test.ts`、`repo-review-regressions.test.ts`、`lsp/edits.test.ts` 和 `packages/natives/test/python-symbols.test.ts`，涵盖最佳匹配、扫描中取消、外部变化复核、真实强杀后的代次回收、并发读快照、设备执行状态、LSP 部分提交／回滚、删除路径身份及长路径确认；真实 TUI E2E 为 `scripts/repo-ui-smoke.ts`，已由 `scripts/fulltest-ui-smoke.ts` 接入 `bun run fulltest`。`scripts/repo-index-perf.ts` 提供合成语料基准。这些入口的存在不代表本次运行通过，执行仍遵循 `AGENTS.md` 的授权限制。

### Provider 配置保存现状

当前 `ConfigFile`／`ModelsConfigFile` 只承担读取／迁移，没有主动 `models.yml` writer 或 provider 保存 API；这不豁免下述已授权 provider 变更的双端要求，也不表示 Team 接口提供 provider 配置。Agent 获授权新增 provider 时仍须双端最小安全写，不能把任意文本 `edit` 视为具有共享程序服务的锁、版本校验或事务保证。

### TUI 显示验证参考

使用**模拟模型 + tui-test**验证：

- 三种模式、插话不拆轮、历史隐藏、普通工具优先级与数量、长命令折叠、两行思考及颜色。
- 真实写入分类、最近 3 次 write/edit，以及最新展开、其余折叠。
- Bash 的 30 秒边界、短命令成功与失败、等待输入、无输出、前台转后台，以及跨轮次后台任务。
- 日志刷新不新增模型请求或工具调用。

### 中文界面验证参考

- 本次不增加测试；复用既有自动化验证。验收须观察真实源码入口的中文界面及关键交互，并运行当前平台 `bun run fulltest`；不得把静态文案检查或局部渲染冒充真实入口验收，也不得因汉化改写业务断言或放宽门禁。尚未实际执行的验证保持未验证。
