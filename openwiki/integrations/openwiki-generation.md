---
type: integration
title: OpenWiki 生成与内置资源集成
description: 说明 omp openwiki 如何将 vendored 仓库生成器接入 OMP 模型与认证，以及技能、可视化资源和生成状态的交付边界。
tags: [openwiki, generation, resources, models, offline]
verified:
  - by: openwiki/0.0.0-unknown
    at: 2026-11-01T04:34:57.379Z
sources:
  - id: openwiki-source-bc6d2633cde154d381c79c1f
    resource: repo://openspec/specs/openwiki/spec.md
  - id: openwiki-source-5b54a58d1b51cd490b0e7162
    resource: repo://package.json
  - id: openwiki-source-4640e41b2f0e00c59e83806c
    resource: repo://packages/coding-agent/scripts/bundle-dist.ts
  - id: openwiki-source-4a3188f34bf4bab770b3cae7
    resource: repo://packages/coding-agent/scripts/compile-binary.ts
  - id: openwiki-source-4f058ad2a60c1cdb4392ac2b
    resource: repo://packages/coding-agent/scripts/openwiki-resources.ts
  - id: openwiki-source-8d4917ff92eb0a6d4411ede9
    resource: repo://packages/coding-agent/src/cli/openwiki-cli.ts
  - id: openwiki-source-e8604ccdc21d467ed68ed91a
    resource: repo://packages/coding-agent/src/commands/openwiki.ts
  - id: openwiki-source-97a406a5d549b3706c4f6997
    resource: repo://packages/coding-agent/src/openwiki/agents-instructions.ts
  - id: openwiki-source-927b41921f02f670a3c86404
    resource: repo://packages/coding-agent/src/openwiki/home.ts
  - id: openwiki-source-c3bfab99c7a0276369fb8b2d
    resource: repo://packages/coding-agent/src/openwiki/model.ts
  - id: openwiki-source-6ea5669665202f51ce2b59df
    resource: repo://packages/coding-agent/src/openwiki/resources.ts
  - id: openwiki-source-f76f80b9ed2ec3e5eba62186
    resource: repo://packages/coding-agent/src/openwiki/vendor-contract.ts
  - id: openwiki-source-b55d7ce9ed0444033cf69def
    resource: repo://packages/coding-agent/src/openwiki/vendor-loader.ts
  - id: openwiki-source-acf50746c2a0f532b10679c5
    resource: repo://packages/coding-agent/src/openwiki/visual-assets.ts
  - id: openwiki-source-849187decfd40c5202f4fe32
    resource: repo://vendor/openwiki/src/agent/repository-runner.ts
  - id: openwiki-source-05e1e777ab7c33390013551a
    resource: repo://vendor/openwiki/src/config/constants.ts
  - id: openwiki-source-ad85d5a563850d91f72908c1
    resource: repo://vendor/openwiki/src/generation/page-manifest.ts
  - id: openwiki-source-a6e6c2f2f5e6765eff534038
    resource: repo://vendor/openwiki/src/generation/repository-preview.ts
  - id: openwiki-source-c786fd51f488fac724933c1d
    resource: repo://vendor/openwiki/src/generation/repository-run.ts
  - id: openwiki-source-119e568a3e6154a9d82c3e5e
    resource: repo://vendor/openwiki/src/generation/run-state.ts
  - id: openwiki-source-2a35f2acd3ac683f377f3464
    resource: repo://vendor/openwiki/test/config/constants.test.ts
  - id: openwiki-source-c4b3d535d00f90ec1bab037f
    resource: repo://vendor/openwiki/test/generation/repository-run.test.ts
generated: { by: "openwiki/0.0.0-unknown", at: "2026-11-01T04:34:57.379Z" }
---

# OpenWiki 生成与内置资源集成

`omp openwiki` 是 OMP 对 `vendor/openwiki` fork 的**进程内仓库 Wiki 适配层**，不是独立 OpenWiki 安装器。本仓库的 `openwiki/` 是针对本仓库生成的知识页及其状态；`vendor/openwiki` 是生成和查询引擎源码；OMP 原有 `knowledge_search` 文档索引则是另一套能力和数据。不要把这些页面或 fork 当成 `knowledge.db`，也不要假设生成 Wiki 会更新既有索引。

## 入口与执行边界

在目标仓库运行：

```sh
omp openwiki code --init --dry-run
omp openwiki code --init
omp openwiki code --update
omp openwiki visualize openwiki --no-open
omp openwiki visualize openwiki --export ./wiki-export
```

`code` 可省略；默认语言为 `zh-CN`，可通过 `--language` 覆盖。init 是重新生成，保留 `openwiki/INSTRUCTIONS.md`，并非无损更新。实际运行会刷新根目录 `AGENTS.md` 的 OpenWiki 管理区块，保留其他内容；标记损坏或重复时报错。缺失的 `INSTRUCTIONS.md` 以空文件创建，已有内容不覆盖。

```mermaid
flowchart TD
    CLI["omp openwiki CLI"] --> Loader["宿主 vendor 接口"]
    Loader --> Gen["原生规划与页面工作池"]
    CLI --> Factory["OMP 模型工厂"]
    Factory --> Chat["ChatOpenAI 适配器"]
    Gen --> Chat
    Chat --> Gateway["进程内认证路由"]
    Gateway --> Provider["所选模型服务"]
    Skills["技能资源"] --> Gen
    Gen --> Pages["仓库 openwiki 页面和状态"]
    Assets["预构建视觉资源"] --> Viewer["本地服务或静态导出"]
    Pages --> Viewer
    CLI --> Viewer
```

图：宿主负责模型、凭据与资源注入，fork 负责仓库生成和视觉展示。

宿主通过 `openwiki-vendor-runtime` 动态加载 [vendor 契约](../../packages/coding-agent/src/openwiki/vendor-contract.ts)，调用 `runNativeRepositoryGeneration`，传入根目录、模式、语言、模型、页面并发、技能目录、取消信号和事件回调。原生规划、页面任务、Claims、checkpoint 和最终化仍属于 fork，而不是 OMP 通用 Task 的重写。`OPENWIKI_PAGE_CONCURRENCY` 默认 1，范围 1–8；这不是跨进程仓库互斥保证。

`--dry-run` 只预览模型选择器、源码快照候选、可比较的变更和已有页面，不调用模型、不写 Wiki 或遥测；候选既不是完整读取清单，也不是最终页面列表。模型实际规划页面。真正运行时，部分页面失败返回 1 并提示 update 重试；中断返回 130；全部页面成功但期间源码变化时警告再次更新。恢复和增量判断使用已有页面、Claims 与进度，不能仅凭 Git clean 或 Agent 的文字宣称认定完成。

OMP 只暴露仓库生成、link、workspace 和 visualize 等入口；个人模式、连接器、MCP 安装及 CLI `search`/`read` 不在内置范围。普通对话通过 `openwiki_search`、`openwiki_read`、`openwiki_list_workspaces`、`openwiki_list_wikis` 按需只读查询已有 Wiki，不调用生成器。链接和活动工作区状态位于有效 OMP profile 的 `openwiki` 配置目录，不自动接管旧独立 OpenWiki home。

## 逐页覆盖、更新窗口与恢复

生成引擎维护几种互补的状态，不能把其中任一个当成整个 Wiki 已正确更新的证明：

- `openwiki/.page-manifest.json` 是可提交的事实页面覆盖账本，以规范页面路径记录页面字节的 `pageVersion`、所覆盖的 `gitHead` 和 `sourceFingerprint`，以及可选的完成者和运行 ID。页面 Markdown 和已验证的 Claims sidecar 持久化且版本一致后，才能推进该页；账本按完整内容原子替换。文件不存在时视为空账本，格式或路径无效时则报错，避免丢弃已有覆盖。
- Claims 保存页面中的可核查主张及其证据、验证状态和页面版本；它们与实际 Markdown 的哈希必须一致。账本记录的是页面覆盖的源码检查点，不替代逐条 Claims 的核查。
- `openwiki/.run.json` 是活动运行的计划、页面任务和恢复 checkpoint，不是可提交的逐页正确性账本；`.last-update.json` 记录上次完整成功的运行基线，也不能证明部分运行中的所有页面都已推进。

```mermaid
flowchart TD
    Start["开始或恢复 update"] --> Windows["按页面覆盖基线分组"]
    Windows --> Plan["规划页面任务"]
    Plan --> Work["页面与 Claims 持久化"]
    Work --> Ledger["记录该页覆盖"]
    Ledger --> Checkpoint["更新运行 checkpoint"]
    Checkpoint --> Result{"任务全部完成"}
    Result -->|是| Finish["最终化并更新完整运行基线"]
    Result -->|否| Resume["保留已完成页面并等待重试"]
    Resume --> Start
```

图：页面覆盖可在整个运行完成前独立持久化，运行 checkpoint 和完整基线各有不同职责。

例如，旧基线为 A，源码变更后只完成页面 P，再把页面、Claims 和账本一起提交；在没有原 `.run.json` 的新 checkout 中，下一次 update 是新运行，但仍能从账本看到 P 的较新基线和未完成页面 Q 的 A 基线。规划器按各页 `gitHead` 分组，分别计算到当前工作树的可见变更，再取并集提供整体变更视图；没有基线的组需要完整审查。若从某页基线以来只有生成的 Wiki 文件变化，引擎可在重新验证页面和 Claims 后将该页覆盖快进，而不会因此把其他仍有源码变化的页面一并推进。`--dry-run` 展示各页基线和可比较的变更；历史不可比较时省略变更列表，并不等于没有变化。

旧版本迁移时，只有可验证的页面才从上次完整成功基线补种缺失条目，已有较新条目优先；无法验证的页面保持未覆盖。恢复同一运行时，跳过的任务重新待处理；若源码指纹、Wiki 目标或相关指令变化，原计划失效并重新规划。源码不变时，引擎用账本、页面和 Claims 的一致性及运行 ID 协调 checkpoint：已持久完成但 checkpoint 仍待处理的页面可以恢复为完成，不能验证的状态不会仅凭 checkpoint 获得覆盖。部分失败或中断因此可能留下不同页面的不同基线；应重试并核对结果，而不是将一次运行的退出状态解释为所有页面同步。

## 页面并发操作

`OPENWIKI_PAGE_CONCURRENCY` 控制单次生成或更新中的页面工作者数量，接受 1–8 的整数，未设置时为 1，非法值报错。页面模型工作可以并发；同一活动运行对象内，对共享 Claims 会话、页面账本和运行 checkpoint 的读改写串行化，任务认领也是进程内的。这不提供跨进程仓库锁，不应同时对同一仓库启动多个生成进程。

在 csh/tcsh 中，`setenv OPENWIKI_PAGE_CONCURRENCY 4` 只设置当前会话及其子进程；在 PowerShell 中，`[Environment]::SetEnvironmentVariable("OPENWIKI_PAGE_CONCURRENCY", "4", "User")` 设置用户级持久变量，需要打开新终端后再运行 `omp openwiki code --update`，不会修改当前进程的环境。

## 模型与认证转接

页面模型使用 `--modelId` / `--model-id`，否则使用 OMP 的 `default` role 或运行时可用模型。规划模型优先级为 `--planner-model`、公共显式模型、已配置的 `plan` role，最后复用页面模型；已配置的规划模型不可用时不静默回退。相同选择器复用实例，不同选择器分别创建并在结束或失败时释放。`--debug` 显示实际模型 ID；预览中的选择器未经运行时发现和认证验证。

[模型工厂](../../packages/coding-agent/src/openwiki/model.ts) 加载当前设置、凭据存储、模型注册表及扩展 provider，按照离线策略刷新注册表；拒绝不支持工具调用或没有可用凭据的选择。它以 LangChain `ChatOpenAI` 适配原生生成器，但 `http://openwiki.internal/v1` 是经自定义 fetch 转发到**进程内** OMP auth gateway 的虚拟地址，不是要求部署的新服务。路由器按所选 provider 解析凭据并保留 assistant 工具调用轮次；推理档位按模型能力转换后传递。取消或 dispose 会中止请求并关闭路由器和存储。

## 资源的构建、定位与交付

资源分两条路径，不能仅因源码可读就断定交付物完整：

- 根目录 `postinstall` 执行 `openwiki-resources.ts --if-present`；它读取当前 checkout 的 fork 技能和视觉源码，构建浏览器脚本，收集 CSS、图形、Markdown、净化和 Mermaid 依赖及许可声明，并把 `skills/`、`visual/` 与 `__omp_meta__.json` 打成确定性的 tar + gzip，以 base64 写入 `src/openwiki/openwiki-resources.generated.txt`。输入生成前后指纹不同则失败。子模块缺失时清空旧 archive 并警告；初始化子模块后运行 `bun run gen:openwiki-resources`。
- 技能与可视化共用同一 archive：技能从 `skills/` 读取，按 SHA-256 内容摘要原子发布到 profile 的 `openwiki/resources/<digest>/skills`，并拒绝路径穿越；可视化从 `visual/` 读取 `client.js`、`client-lib.js`、`styles.css`、浏览器库和许可声明。源码 checkout 下还核对 `__omp_meta__.json` 的 `sourceFingerprint`，缺失、无效或过期时明确报错并要求重新生成。
- 运行时只 sniff archive 前缀，首次使用才解码并解压到内存；bundle 和编译二进制在构建时重新生成同一 archive，构建结束后清空源码占位。交付包另有 `dist/openwiki-resources.generated.txt` 供源码/SDK 消费者回退。

`visualize` 把资源和 Wiki 根目录交给 fork 的嵌入式服务，停止时关闭服务；`--export` 则生成可由静态 HTTP 服务托管的页面和图，不承诺 `file://` 直接打开。离线可视化所需浏览器库随资源提供，但**离线不等于离线生成自动可用**：仍需已交付资源、可用的工具调用模型和对应凭据及可达端点。内置路径的遥测禁用；显式 `--telemetry-file` 只写本地禁用状态。参见[内网与离线](../operations/intranet-offline.md)和 [fork 维护](../operations/fork-maintenance.md)。

## 检索与验证

已有的 [文档索引](../concepts/knowledge-document-index.md) 保留自己的命令和存储语义；OpenWiki 查询不替代它，也不在普通任务开始时预加载全部页面。知识页是可过时的派生材料，排障时应回到源码和测试。

修改集成时，可重点检查 `packages/coding-agent/test/cli/openwiki-generation.test.ts` 的生成与模型路径、`openwiki-dry-run.test.ts` 的只读预览、`openwiki-recovery.test.ts` 的恢复，以及 `test/openwiki/query.test.ts` 和 `agents-instructions.test.ts` 的查询与指令边界；fork 自身的生成测试覆盖原生页面编排。资源或子模块变化后应重新生成并检查指纹，而不是沿用旧视觉产物。
