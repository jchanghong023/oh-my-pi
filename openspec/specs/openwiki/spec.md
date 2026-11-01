# openwiki Specification

## Purpose
规定 OMP 内置代码仓库 OpenWiki 的命令、模型接入、生成与恢复、AI 只读检索、跨仓库工作区和可视化行为。复用 OpenWiki fork 的原有生成能力，让用户只通过 OMP 使用和更新仓库 Wiki，不再依赖独立安装或 MCP 接入，同时保持既有 Wiki 数据和 OMP 文档／代码索引的边界。

## Requirements

### Requirement: 仓库 Wiki 命令与功能边界

OMP MUST 通过 `omp openwiki` 提供代码仓库 Wiki 的生成、更新、链接、工作区管理、可视化和静态导出入口，保留纳入命令的原有参数与行为；查询入口 MUST 是 OMP 内置 AI 工具，而不是新增 CLI 查询命令。OMP 内置能力 MUST NOT 接入个人知识库、外部知识连接器或其他 Agent 的安装与接入，但 MUST 保留 OpenWiki fork 独立运行时的既有功能。

#### Scenario: 显式生成和更新
- **WHEN** 用户在仓库内执行 `omp openwiki code --init` 或 `omp openwiki code --update`
- **THEN** OMP 对该仓库执行对应的 OpenWiki 初始化或增量更新，并保留原有语言、用户消息、一次性输出及参数互斥语义
- **AND** 原有省略 `code` 的 `--init`／`--update` 仓库用法继续可用，模型选择参数按 OMP 模型要求解释
- **AND** 若 `openwiki/INSTRUCTIONS.md` 不存在，创建空文件；若已存在，保留原有内容

#### Scenario: 只读预览生成和更新
- **WHEN** 用户对 `--init` 或 `--update` 指定 `--dry-run`
- **THEN** OMP 打印仓库、当前配置的默认角色或显式模型选择器、源码快照候选路径、可比较的变更路径及已有 Wiki 页面范围，不调用模型、不写入 Wiki 或 OpenWiki 运行状态，也不写出遥测文件
- **AND** 对需要运行时发现或认证才能确定的模型，预览明确标注选择器未验证；说明最终 Wiki 页面需由模型规划决定，候选路径并非完整的模型读取清单
- **AND** `--dry-run` 未配合 `--init`／`--update` 时不得执行链接、可视化或其他有副作用的操作

#### Scenario: 不进入个人模式或新增查询 CLI
- **WHEN** 用户未指定操作，或请求个人模式、连接器、MCP／其他 Agent 安装接入及 `search`／`read` 查询子命令
- **THEN** 无操作时显示仓库 Wiki 帮助，未纳入操作明确提示不支持，不进入个人知识库或旧 chat Agent，也不隐式生成 Wiki

#### Scenario: 保留管理命令参数
- **WHEN** 用户使用 `link [directory]`、`workspace use <workspace>`、`workspace current`、`workspace clear` 或 `visualize [path] [--port <port>] [--no-open] [--export <dir>]`
- **THEN** OMP 保留对应仓库选择、工作区选择、目录与端口、浏览器开启及导出行为，包括既有参数互斥和需要交互终端的约束

#### Scenario: 保留仓库命令选项
- **WHEN** 用户对纳入范围内的仓库命令使用原有语言、`--print`、`--debug`、`--telemetry-file` 或页面并发设置
- **THEN** OMP 保留这些入口及对应行为；模型选择和认证改用 OMP，诊断遵循 OMP 现有离线与日志规则
- **AND** `--telemetry-file` 显式写出本地遥测状态；OMP 内置路径禁用 OpenWiki 独立遥测，文件反映原有禁用语义，不发送公网事件

### Requirement: 使用 OMP 模型与认证

OpenWiki 生成 MUST 使用 OMP 已有的模型选择、认证和请求策略：未显式指定模型时使用当前 profile 的 `default` role，显式选择优先；规划 Agent 和所有页面 Agent MUST 共用本次选择的同一个模型，不分别选择 `plan`／`task` role。MUST 支持所选工具调用聊天模型的完整模型—工具—模型往返。用户 MUST NOT 被要求配置 OpenWiki 专用 provider、凭据、登录流程或独立模型网关。

#### Scenario: 使用默认模型
- **WHEN** 用户未显式指定模型并执行 Wiki 生成或更新
- **THEN** 按 OMP 当前 profile 和运行环境解析 `default` role，规划 Agent 与所有页面 Agent 共用该模型；不单独解析 `plan` 或 `task` role
- **AND** 用户无需重复填写 OpenWiki 模型配置，生成期间的工具调用和后续模型响应可以完成

#### Scenario: 显式选择模型
- **WHEN** 用户通过 `--modelId`／`--model-id` 为 Wiki 生成或更新显式选择模型
- **THEN** 该模型由 OMP 解析并优先于 `default` role，供规划 Agent 和所有页面 Agent 共用；该选择仅作用于本次运行，不修改已保存的 role 配置
- **AND** 所选模型不受另一套 OpenWiki 模型列表限制

#### Scenario: 公司模型和免认证模型
- **WHEN** OMP 当前有效配置提供公司内网模型或受支持的免认证模型
- **THEN** OpenWiki 使用与 OMP 相同的凭据或免认证解析、端点与 provider 限制，不因只读取通用凭据存储而拒绝 OMP 已可使用的模型

#### Scenario: 模型不可用或调用被取消
- **WHEN** 所选模型缺少必要认证、不支持所需工具调用、调用失败或用户取消生成
- **THEN** OMP 如实报告对应失败或取消，按已有请求策略处理，不回落到 OpenWiki 自有认证、不静默切换模型，也不将未提交页面报告为完成

### Requirement: 复用原生生成编排与恢复

OMP MUST 复用 OpenWiki 原有的规划 Agent、页面工作池、Claims、增量判断、恢复和最终化行为，允许必要的原有 Agent 及其运行依赖随 OMP 运行；MUST NOT 为接入而改用 OMP 通用 Task 重写页面编排。页面和整轮完成 MUST 以相应持久化完成状态为依据，不能以 Agent 文本声称或退出本身代替。

#### Scenario: 生成 Agent 资源随包可用
- **WHEN** 在没有旧 OpenWiki home、独立安装或开发源码目录的环境中执行生成
- **THEN** 原生规划与页面 Agent 所需的内置 Skill 和提示资源可用，包括仓库 Wiki 所需的 Mermaid 指导，不因绕过独立 OpenWiki 初始化而缺失

#### Scenario: 原有页面并行行为
- **WHEN** 用户通过原有 `OPENWIKI_PAGE_CONCURRENCY` 设置并发值执行生成或更新
- **THEN** 默认并发为 `1`，允许 `1–8`；原生页面工作池按该上限执行，任务在同一次运行内不重复分派，每个页面任务只能写其负责页面，quickstart 在其他页面任务结束后生成
- **AND** 页面提交不得修改其他仍在处理的页面或其 verification 状态；针对已确认的 verification 跨页修改缺陷做必要的定向修复，不重写工作池
- **AND** 保留原有页面失败处理：普通未提交退出最多尝试两次，限流页面不立即重试且后续并发逐步降低至不小于 `1`，致命提交错误停止领取新任务

#### Scenario: 同仓库跨进程边界
- **WHEN** 不同 OMP 进程同时对同一仓库启动生成或更新
- **THEN** 本次不新增跨进程仓库互斥锁，沿用 OpenWiki 原有边界；一次运行内的任务去重不得被表述为跨进程互斥保证

#### Scenario: 增量更新与无变化运行
- **WHEN** 用户在已有 Wiki 上执行更新
- **THEN** OpenWiki 按原有源码变化、Claims 和逐页覆盖状态决定更新范围；仅在原有完整条件满足时报告无需生成，不以 Git clean 单独掩盖未完成或失效证据

#### Scenario: 中断后恢复
- **WHEN** 同一持久检出目录中的生成被中断，用户再次执行对应命令
- **THEN** OpenWiki 从已有 checkpoint 恢复，按原有源变化判断复核或作废旧计划，保留已证实完成的页面进度，不把未提交页面当作成功

#### Scenario: 页面失败与最终化失败
- **WHEN** 存在失败、跳过或未完成页面，或最终化没有成功
- **THEN** OMP 如实区分部分失败与中断；页面失败或跳过时命令返回非零，未覆盖页面不冒充本轮完成，全局成功源基线不因部分完成而推进
- **AND** 已完成页面和足以让下次更新继续处理失败页面的数据按原有恢复行为保留，不另建恢复状态机，也不要求部分失败时必须保留特定 checkpoint 文件

#### Scenario: 生成期间源码变化
- **WHEN** 所有页面成功但仓库源码在本轮生成期间发生变化
- **THEN** 按上游完成语义返回零退出码，明确警告 Wiki 尚未覆盖最新源码并提示再次更新；旧的成功源基线不推进

### Requirement: OMP 内置只读查询工具

OMP MUST 内置 `openwiki_search`、`openwiki_read`、`openwiki_list_workspaces`、`openwiki_list_wikis` 四项只读能力，在进程内直接调用 OpenWiki 查询逻辑，不通过 MCP。查询执行 MUST NOT 调用模型、启动生成／更新，或修改仓库 Wiki、Claims 和工作区注册表；OMP 对话的 OpenWiki 工具面 MUST NOT 包含生成生命周期工具。

#### Scenario: AI 搜索后读取章节
- **WHEN** 用户要求 OMP 查询仓库 Wiki，AI 调用搜索并使用返回的 Wiki ID、页面和章节引用继续读取
- **THEN** 内置工具返回已有 Wiki 的搜索结果和对应完整章节，不需要用户安装或启动 OpenWiki MCP 服务
- **AND** 正常零命中保持零命中，无 Wiki 或参数错误如实返回，不通过生成内容填补结果

#### Scenario: 中文与混合标识符查询
- **WHEN** 用户用中文词组、自然语言或中英文标识符检索已有 Wiki
- **THEN** 连续汉字中的相邻词组可以命中；一个双字词不能仅因两个汉字分别出现在不同位置而命中，多词查询允许部分词命中
- **AND** 路径提示优先级相同时，原文连续中文词组的匹配优先于仅由标点分隔的匹配；英文和单字查询继续可用，摘要基于原文且章节读取保留完整 Markdown

#### Scenario: AI 列举工作区和关联 Wiki
- **WHEN** AI 调用工作区列表或关联 Wiki 列表
- **THEN** 返回以当前仓库为上下文的工作区或指定可达工作区成员，沿用当前 OMP profile 中的 ID 和选择语义，不把全局个人知识库加入检索范围

#### Scenario: 查询与内部生成工具隔离
- **WHEN** 检查 OMP 对话实际可调用的 OpenWiki 工具
- **THEN** 只有上述四项只读能力，不包含 begin、计划提交、任务领取、Claims 写入、页面提交或 finish 等生成工具
- **AND** OpenWiki 原生生成 Agent 内部所需的计划／页面提交工具继续属于其生成执行链，不被注册到 OMP 普通对话工具面

#### Scenario: 内置工具的挂载与权限
- **WHEN** OMP 非受限会话启用 `tools.xdev`
- **THEN** 四项只读能力遵循现有可发现设备挂载规则，AI 可按需发现和调用；关闭 `tools.xdev` 时按 OMP 既有规则作为顶层工具提供
- **AND** 设备派发保留只读权限语义，不因通过设备传输被当作文件写入；受限子代理的工具清单不会因此自动扩大

### Requirement: 按需检索与既有索引隔离

OpenWiki MUST 作为独立于现有 Markdown `wiki` 和代码 `repo` 索引的能力，保留它们的名称、命令和数据语义。OMP MUST 仅在用户要求或任务确需相关证据时按需检索 OpenWiki，普通任务开始时 MUST NOT 自动枚举、读取或预加载仓库及关联 Wiki 内容。

#### Scenario: 普通任务不预加载
- **WHEN** 用户开始与 Wiki 无关的普通任务
- **THEN** OMP 不自动调用 OpenWiki 查询、工作区枚举或内容读取，也不启动 Wiki 生成和可视化服务

#### Scenario: 现有 Wiki 与 Repo 保持原行为
- **WHEN** 用户使用 `wiki`、`repo`、`omp docs`、`/wiki` 或 `/repo`
- **THEN** 继续访问其原有能力和数据，OpenWiki 不占用这些名称、不替换数据库、不新增原文档索引的更新命令

### Requirement: 保留跨仓库工作区链接

OMP MUST 保留 OpenWiki 对本机已有代码仓库 Wiki 的命名工作区、活动工作区和跨仓库检索／读取能力。工作区链接 MUST 沿用仓库成员关系语义，不将其扩大为个人知识源或承诺新的跨仓库页面图谱。

#### Scenario: 管理并使用仓库工作区
- **WHEN** 用户通过 `omp openwiki link` 管理已有仓库 Wiki，并选择活动工作区
- **THEN** 后续内置查询按该工作区解析关联仓库，多个工作区仍有歧义时返回既有 `workspace_required` 选择结果，不静默选择无关工作区

#### Scenario: 关联仓库不可访问
- **WHEN** 读取已关联但已移动、缺失或不再可访问的仓库 Wiki
- **THEN** 返回可识别的关联不可用错误，不生成替代 Wiki，也不返回其他仓库内容冒充该关联

### Requirement: 保留已有仓库 Wiki 数据格式

OMP MUST 保留仓库内 `openwiki/`、Claims、页面 manifest 和生成 checkpoint 的格式及身份语义，使已有仓库 Wiki 可继续更新、恢复和查询。格式兼容 MUST NOT 被解释为 init 保留全部旧生成内容；无法读取的数据 MUST 明确报错，不静默清空或重建。旧独立 OpenWiki 工作区无需迁移或接管。

#### Scenario: 接续已有 Wiki 和 Claims
- **WHEN** 用户对现有 OpenWiki 仓库执行更新、恢复或查询
- **THEN** OMP 使用既有页面、Claims 和进度，不要求先重建 Wiki，不以空状态覆盖不兼容或损坏数据

#### Scenario: 显式重新初始化
- **WHEN** 用户对已有 Wiki 明确执行 init
- **THEN** 保留原有重新生成语义，包括保留用户维护的 `openwiki/INSTRUCTIONS.md`，不把 init 误解释为无损增量更新

### Requirement: 原有可视化与静态导出

OMP MUST 保留 OpenWiki 的关系图、Markdown 阅读器、实时刷新和静态导出行为，并管理可视化服务的启动与关闭。默认服务 MUST 保持本机回环边界；静态导出供静态 HTTP 服务承载，不新增直接通过 `file://` 打开的兼容承诺。

#### Scenario: 实时浏览与关闭
- **WHEN** 用户通过 `omp openwiki visualize` 查看 Wiki，随后停止该服务或退出所属 OMP 命令
- **THEN** 图和阅读器显示真实页面，Wiki 变化可触发刷新，停止后释放监听、刷新和文件监视资源
- **AND** 服务启动或刷新失败如实反馈，不由嵌入模块强制结束仍在运行的其他宿主任务

#### Scenario: 静态导出独立访问
- **WHEN** 用户通过 `--export <dir>` 导出并将该目录放在静态 HTTP 服务的子路径下
- **THEN** 导出内容保留页面、图和阅读器，资源按导出路径解析，不需要运行 OpenWiki Agent、MCP 或 OMP 生成服务

### Requirement: 默认接入不安装外部 OpenWiki 链路

OMP 的仓库 Wiki 入口 MUST NOT 隐式创建安装并运行独立 OpenWiki 的 workflow、拉取外部知识连接器或改写 `CLAUDE.md`。执行仓库 `--init`／`--update` 时，OMP MUST 在仓库根目录的 `AGENTS.md` 创建或刷新 OpenWiki 标记区块，告知 Agent Wiki 位置及只读查询方式，保留区块之外的内容；标记损坏或重复时 MUST 报错且不修改文件。此约束不改变显式生成对 `openwiki/` 的预期写入；`--dry-run` 不修改 Agent 指令。

#### Scenario: 新仓库首次生成
- **WHEN** 用户首次通过 OMP 生成仓库 Wiki
- **THEN** 不创建依赖独立 OpenWiki 安装的自动更新 workflow，不执行连接器拉取，不创建或刷新 `CLAUDE.md`；创建或刷新 `AGENTS.md` 的 OpenWiki 管理片段

#### Scenario: 仓库已有独立 OpenWiki 设置
- **WHEN** 仓库已经存在用户维护的 OpenWiki workflow 或 Agent 指令
- **THEN** OMP 不擅自删除、覆盖或运行已有 workflow，不修改 `CLAUDE.md`，只刷新 `AGENTS.md` 中的 OpenWiki 管理片段；这些文件不作为 OMP 内置功能的安装、认证或执行前提

#### Scenario: 保留 fork 独立入口
- **WHEN** OpenWiki fork 通过其独立 CLI、MCP、个人模式或其他既有入口运行
- **THEN** OMP 内置路径的功能排除、初始化和遥测限制不全局禁用或删除这些独立功能；经确认的并行 verification 缺陷可作定向修复
