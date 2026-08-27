# 面向用户的包

本页面索引了仅在 README 中说明的、面向用户的包 CLI 和特性，这些内容需要在根级文档中得到覆盖，超出包本地 README/manifest 自身的范围。

## 根级文档策略

- **纳入**：对用户可直接运行或通过 `omp` 运行的包本地 CLI、扩展特性、仪表板和基准测试运行器进行根级文档覆盖。
- **明确排除**：当某个包/crate 仅用于内部实现时不予纳入；此时应指向负责说明它的架构文档。
- 包的 README 和 manifest 仍是包本地设置和参数的权威来源；根级文档使特性可被检索，并链接到确切的源码路径。
- 内部 Rust crate 仍由原生架构文档覆盖，除非被提升为独立的面向用户的命令或 API。面向贡献者的导览位于 [`native-crates.md`](./native-crates.md)；目前每个 `crates/*` 条目都是 `@oh-my-pi/pi-natives` 及其内嵌 shell 的内部实现，因此由 [`natives-architecture.md`](./natives-architecture.md) 及周边原生文档负责说明。

## 包的 CLI 和特性

### `python/robomp` — 自托管的 GitHub 分类与修复服务

来源：[`python/robomp/README.md`](../python/robomp/README.md)、[`python/robomp/pyproject.toml`](../python/robomp/pyproject.toml)、[`python/robomp/.env.example`](../python/robomp/.env.example)、[`python/robomp/docker-compose.yml`](../python/robomp/docker-compose.yml)。

- Python 包：`robomp`（Python 3.11 或更高版本）；可执行文件：`robomp`，带有 `serve`、`triage`、`replay`、`status` 和 `cleanup` 命令。
- 特性：自托管服务，接收白名单仓库的 GitHub webhook，对 issue 进行分类，为每个 issue 恢复一个 `omp --mode rpc` 会话，发表评论或开启修复 PR，并处理后续的 issue 和 PR 对话。
- 仪表板/API：FastAPI 在 `/` 提供运维仪表板，同时提供健康检查、事件、issue 和 replay 端点。打包的 Compose 部署将其发布在 `http://localhost:6543/`；`bun run robomp:web:dev` 在开发模式下运行仪表板前端，`bun run robomp:web:build` 重新构建其静态资源包。
- 输入/存储：配置来自 `python/robomp/.env` 和挂载的 `~/.omp/agent/models.container.yml`；GitHub webhook 事件输入到基于 SQLite 的队列。Compose 部署将数据库、每个 issue 的工作区、会话记录和日志持久化在 `robomp_data` 卷的 `/data` 下。
- 根级命令：`bun run robomp:install` 为宿主开发安装 Python 包；`bun run robomp:serve` 在宿主上运行它；`bun run robomp:build`/`bun run robomp:rebuild`、`bun run robomp:up`、`bun run robomp:down`、`bun run robomp:restart`、`bun run robomp:logs`、`bun run robomp:dev` 和 `bun run robomp:reset` 用于管理容器部署。
- 前置条件：Docker Compose v2、宿主可访问的 LiteLLM 风格模型代理、容器模型配置、GitHub webhook 端点，以及对每个白名单仓库具有写权限的机器人 PAT。默认的双容器部署将 PAT 保存在经 HMAC 认证的 `gh-proxy` sidecar 中，而不是编排器中。

### `packages/stats` — 本地使用情况仪表板

来源：[`packages/stats/README.md`](../packages/stats/README.md)、[`packages/stats/package.json`](../packages/stats/package.json)、[`packages/coding-agent/src/cli/stats-cli.ts`](../packages/coding-agent/src/cli/stats-cli.ts)。

- 包：`@oh-my-pi/omp-stats`；可执行文件：`omp-stats`；主要用户路径：`omp stats`。
- 特性：基于会话 JSONL 日志的 AI 使用统计本地可观测性仪表板。
- CLI 模式：`omp stats` 启动仪表板服务器，打开 `http://localhost:3847` 并保持运行；`omp stats --port <port>` 修改端口；`omp stats --summary` 在控制台打印摘要；`omp stats --json` 打印 JSON 后退出。
- 编程式 API：导出 `syncAllSessions()` 和 `getDashboardStats()` 等辅助函数以便嵌入使用。
- 输入/存储：从 `~/.omp/agent/sessions/` 读取；将聚合数据存储在 `~/.omp/stats.db`。
- 输出：仪表板指标和 API 端点，包括 `/api/stats`、`/api/stats/models`、`/api/stats/folders`、`/api/stats/timeseries` 和 `/api/sync`。
- 副作用/限制：在输出前同步会话文件；长时间运行的仪表板在 `Ctrl+C` 时停止并关闭统计数据库。

### `packages/omptype` — 模式校验库

来源：[`packages/omptype/README.md`](../packages/omptype/README.md)、[`packages/omptype/package.json`](../packages/omptype/package.json) 以及仓库中的 [omptype 编写指南](./omptype-guide.md)。

- 包：公开的 `@oh-my-pi/omptype`；使用 `bun add @oh-my-pi/omptype` 安装；需要 Bun 1.3.14 或更高版本。
- 特性：可调用的、兼容 ArkType 的模式，具有低开销的解析启动、热路径的惰性编译、校验错误、默认值和变形（morph），以及 JSON Schema 导出。
- 公共接口：`@oh-my-pi/omptype` 用于原生编写，`/typebox` 和 `/zod` 用于兼容构建器，`/ark` 用于无别名的 ArkType 兼容门面。
- 运行时行为：模式调用返回校验后的值或 `type.errors`；`.assert()` 返回值或在失败时抛出；`.allows()` 执行布尔检查。
- 限制：这是一个有明确范围的兼容接口，并非对 ArkType、TypeBox 或 Zod 每个 API 的完整实现。

### `packages/typescript-edit-benchmark` — TypeScript 编辑夹具引擎

来源：[`packages/typescript-edit-benchmark/package.json`](../packages/typescript-edit-benchmark/package.json)、[`packages/typescript-edit-benchmark/src/generate.ts`](../packages/typescript-edit-benchmark/src/generate.ts)、[`packages/typescript-edit-benchmark/src/tasks.ts`](../packages/typescript-edit-benchmark/src/tasks.ts)、[`packages/typescript-edit-benchmark/src/verify.ts`](../packages/typescript-edit-benchmark/src/verify.ts) 以及 [`packages/metaharness/adapters/edit/cli.ts`](../packages/metaharness/adapters/edit/cli.ts) 中的运行器。

- 包：私有的 `@oh-my-pi/typescript-edit-benchmark`；无独立可执行文件的支撑库。
- 特性：生成、加载、格式化和验证由 metaharness 编辑适配器消费的 TypeScript 变更夹具。
- 夹具生成：在仓库根目录执行 `bun packages/typescript-edit-benchmark/src/generate.ts --typescript-dir <path> [generator options]`。
- 基准测试执行：`bun run --cwd packages/metaharness bench:edit -- --model <provider/model> [options]`，或从 metaharness 仪表板/API 启动一次 `edit` 运行。
- 运行器输入包括 provider/model、思考级别、每个任务的运行次数、超时、并发、任务 ID、夹具目录或 `.tar.gz`、编辑策略、引导模式、重试/轮次限制、输出路径/格式以及夹具校验/列表标志。
- 夹具包含任务元数据、prompt、输入文件和期望文件。运行器将每个夹具复制到一个独立的工作区中，记录可选的对话转储，并写入 Markdown 或 JSON 结果。

### `packages/metaharness` — 统一的基准测试管理器

来源：[`packages/metaharness/README.md`](../packages/metaharness/README.md)、[`packages/metaharness/package.json`](../packages/metaharness/package.json)、[`packages/metaharness/src/server.ts`](../packages/metaharness/src/server.ts)、[`packages/metaharness/src/runner.ts`](../packages/metaharness/src/runner.ts) 以及 [`packages/metaharness/adapters/edit/cli.ts`](../packages/metaharness/adapters/edit/cli.ts)。

- 包：私有的 `@oh-my-pi/pi-metaharness`；可执行文件：`metaharness`。
- 特性：一个仪表板、SQLite 存储、REST/SSE API，以及针对 Harbor 数据集（默认 `terminal-bench@2.0`）、TypeScript edit 和 SnapCompact 基准测试的规范化 experiment → run → trace 模型。
- 仪表板/API：`bun run --cwd packages/metaharness serve -- --port 4700`；启动表单和 `POST /api/runs` 支持全部三种基准测试适配器。
- 直接运行器：`bun packages/metaharness/src/runner.ts --model <provider/model> [Harbor options]` 和 `bun run --cwd packages/metaharness bench:edit -- --model <provider/model> [edit options]`。
- Harbor 源码模式会以 bind mount 方式挂载仓库和缓存的 Linux 依赖树，而 provider 凭据则保留在宿主上的鉴权网关之后。同时也提供本地 tarball、已发布包和预构建二进制安装模式。
- 存储：规范化状态保存在 `<jobs-dir>/_manager/metaharness.sqlite` 下；基准测试自身的产物仍以文件系统为权威来源，历史运行会被自动发现。
- 输出包括 Harbor 试验目录、`_bench/<jobName>/report.md`、每次运行的日志、编辑报告、规范化的 trace、仪表板指标以及 REST/SSE 更新。
- 限制：删除一个 experiment 或 run 也会删除其作业目录，且当目标正在运行时删除操作会被拒绝。Harbor 需要 Docker 或 Apple Container 以及 Harbor CLI；后端特定的网络和挂载限制记录在包 README 中。

### `packages/browser-relay` — 驱动已有的 Chrome 标签页

来源：[`packages/browser-relay/README.md`](../packages/browser-relay/README.md)、[`packages/browser-relay/package.json`](../packages/browser-relay/package.json)、[`packages/coding-agent/src/tools/browser/relay/`](../packages/coding-agent/src/tools/browser/relay/)。

- 包：私有的 `@oh-my-pi/browser-relay`；用户命令：`omp browser-relay`。
- 设置：运行 `omp browser-relay install`，从 `~/.omp/browser-relay/extension` 加载未打包的扩展，然后通过 `app.relay: true` 在每次调用时启用——或设置 `browser.relay`，使中继在跨项目范围内成为该配置文件的默认（作用域细节见包 README）。
- 行为：中继通过全局守护进程代理自动启动；`app.target` 按 URL/标题子串选择一个标签页，否则采用当前可见标签页。
- 安全/限制：它绑定回环地址；当本地进程不可信时使用 `--token`。Chrome 内部页面、DevTools、Web Store、扩展页面以及 DevTools 已打开的标签页无法附加。

### `packages/collab-web` — 协作会话的浏览器客户端

来源：[`packages/collab-web/README.md`](../packages/collab-web/README.md)、[`packages/collab-web/package.json`](../packages/collab-web/package.json)、[`docs/collab.md`](./collab.md)。

- 包：私有的 `@oh-my-pi/collab-web`；生产客户端：<https://my.omp.sh/>。
- 特性：`/collab` 会话的浏览器访客界面，包括流式会话记录、工具卡片、子代理视图、prompt 和主持人中断功能。
- 本地路径：`bun run dev` 在 3000 端口提供 UI；`bun run mock-host` 运行一个离线中继和脚本化主持人；`bun run build` 在 `dist/` 下输出一个静态 SPA。
- 约束：非本地部署需要 HTTPS 和一个可访问的安全 WebSocket 中继。房间密钥保存在 URL 片段中，不会发送到中继。

### `packages/snapcompact` — 位图上下文压缩 API

来源：[`packages/snapcompact/README.md`](../packages/snapcompact/README.md)、[`packages/snapcompact/package.json`](../packages/snapcompact/package.json)、[`packages/snapcompact/src/index.ts`](../packages/snapcompact/src/index.ts)。

- 包：公开的 `@oh-my-pi/snapcompact`；使用 `bun add @oh-my-pi/snapcompact` 安装；需要 Bun 1.3.14 或更高版本。
- 特性：对被丢弃的对话历史进行确定性的本地序列化与 PNG 渲染，用于视觉模型的上下文压缩；不需要模型调用或 API key。
- 公共入口包括 `compact`、`render`、`renderMany`、`frames`、形状选择、文本归一化/序列化、图像预算以及文件操作辅助函数。
- 运行时约束：栅格化和 PNG 编码需要 `@oh-my-pi/pi-natives`。

### `packages/mnemopi` — 独立的本地记忆 CLI

来源：[`packages/mnemopi/README.md`](../packages/mnemopi/README.md)、[`packages/mnemopi/package.json`](../packages/mnemopi/package.json)、[`packages/mnemopi/src/cli.ts`](../packages/mnemopi/src/cli.ts) 以及 coding-agent 的 [Mnemopi 记忆后端指南](./mnemosyne-memory-backend.md)。

- 包：公开的 `@oh-my-pi/pi-mnemopi`；可执行文件：`mnemopi`；需要 Bun 1.3.14 或更高版本。使用 `bun add --global @oh-my-pi/pi-mnemopi` 进行全局安装，然后运行 `mnemopi <command>`。在源码检出目录中，`bun packages/mnemopi/src/cli.ts <command>` 运行同一入口。
- 存储与搜索：`store`/`remember`、`recall`/`search`、`update`/`edit` 和 `delete`/`forget`。
- 检查与维护：`stats`、`sleep`/`consolidate`、`diagnose`/`doctor`、JSON `export` 和 `import`、带 `read`、`write` 或 `clear` 的 `scratchpad`/`sp`，以及带 `list`、`create` 或 `delete` 的 `bank`。
- 集成：`mcp` 启动该包的 MCP 服务器。该独立 CLI 直接操作 Mnemopi 存储；若要将记忆集成到 OMP 会话中，请按后端指南所述改为选择 `memory.backend: mnemopi`。
- 发现与错误：`mnemopi --help` 列出主要的命令形式。未知命令和无效参数会打印简明的错误并返回非零退出码。
