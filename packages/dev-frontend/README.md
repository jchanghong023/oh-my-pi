# Dev 阶段性前端原型

这是分阶段开发的**第一阶段 UI/UX 原型**，继续使用本目录已复制的 WebGUI Root、组件、样式和聊天输入框，不是第二套界面或最终产品。当前暂停业务开发与真实后端对接；用户确认前端体验后，再恢复真实 OMP 对接，既有业务目标与最终真实验收要求不取消。

## 独立运行

需要 **Bun >= 1.4.4** 和现代浏览器。在另一台机器拉取仓库后，进入 `packages/dev-frontend` 再执行以下命令；也可以只复制整个 `packages/dev-frontend` 目录到普通可写目录，不需要复制 `node_modules` 或 `build`。

```sh
bun ./standalone.ts install
bun ./standalone.ts start
```

浏览器打开 **http://127.0.0.1:4173/**；按 `Ctrl+C` 停止。默认只监听本机，端口被占用时会明确报错，不自动切换端口。安装需要访问 npm 包源；依赖安装完毕后，原型不需要 OMP 服务、模型/API 密钥、Rust、根仓库安装或 postinstall、原始 vendor 前端以及个人机器配置。

**即使在完整仓库内，也使用上述命令，不要直接运行 `bun install`。** 启动器仅在系统临时目录用本包清单和 `bun.lock` 执行冻结安装，禁用安装脚本，然后把生成依赖复制回本包 `node_modules` 并清理临时目录。源码、样例数据和运行入口始终来自本目录，不复制界面，也不执行祖先 workspace 的安装脚本。重新安装前先停止预览；安装会替换本包 `node_modules`。

等价脚本：`bun run install:standalone`、`bun run start`。可选静态构建：`bun ./standalone.ts build`，输出在本包 `build/dev`；不要直接用 `file://` 打开源码。依赖清单或锁文件变化后重新执行安装命令；不要复制其他机器的 `node_modules`。

## 样例数据与边界

- `preview/main.tsx`：现有复制版组件的独立预览入口。
- `preview/mock-services.ts`：前端内存服务适配，不启动 mock HTTP 服务或真实 OMP 连接。
- `packages/ui/src/dev/mock/`：可纳入 Git 的独立样例；`types.ts`、`workflow.ts`、`materials.ts`、`collaboration.ts`、`chat.ts`、`files.ts`、`settings.ts` 分别保存展示类型和各模块数据。
- 样例包含项目 `demo-aurora`、`demo-mobile`，演示路径 `/demo/aurora-console`、`/demo/mobile-console` 只是界面文字，不要求本机存在这些目录。
- 默认打开技术方案样例，直接展示四阶段、聊天和原输入框；选择左侧 IR 查看冻结需求与 SR 清单，选择草稿体验需求讨论。冻结需求的只读状态也是演示内容，不会冻结真实资料。

## 左侧导航与个人项目清单

- 导航沿用 WebGUI 的列表与菜单组件：顶部同一区域先选项目、再选依赖该项目的 Release，其下“新建需求”菜单提供项目内新建、整理并交接需求及导入需求包；中部独立显示当前开发 SR 入口和平铺 IR，支持搜索、筛选与草稿折叠；底部为 OMP／设置。协作入口位于会话顶部。切换项目同步切换 Release 选项并选中该项目首项；无 Release 时清空旧选择并引导添加。
- 正在查看和正在开发分别表示：切换 Release 不隐藏当前项目的开发 SR；快捷入口显示其 IR、实际阶段及必要的所属 Release，点击返回已有会话。点击 IR 回到需求讨论与 SR 清单，不重复启动 SR。搜索、筛选与折叠仅是当前浏览器的查看偏好。
- “Dev 项目与 Release”分两种保存范围：**Dev 管理哪些项目**的登记清单与模型／个性化一样保存在当前 OMP 个人目录／profile；**每个项目有哪些 Release**则保存在该项目自己的 Git 仓库中并随项目版本管理，不在个人目录另存。正式 IR/SR 材料的 Git 边界不变。接收需求包时选择接收人的项目及该项目的 Release，不复制来源人的个人清单或绝对目录。
- 个人项目登记样例位于 `packages/ui/src/dev/mock/project-settings.ts`，各项目 Git 管理的 Release 样例单独位于 `mock/project-releases.ts`，查看偏好位于 `mock/navigation.ts`，Git 目录样例位于 `mock/project-directories.ts`。所有修改仅为页面内存演示，不读写真实个人目录或 Git 项目，不执行 commit／push；刷新恢复初始样例。

页面上的会话、阶段流转、发布、删除、协作、材料及消息都是**演示数据或本页内存变化**，不代表真实模型回复、任务执行、文件/Git 操作、后端记录或验收通过。刷新页面恢复演示初始状态；原复制版组件的主题等浏览器偏好可能保留，完全重置可清除该本地地址的站点数据。当前原型不读写真实项目，不执行 Git、模型调用或远端业务操作。

## 个人模型与追加系统提示词

- “模型设置”配置业务需求、需求评审、方案、计划、执行 5 个 Dev Agent 的模型与思考强度，支持跟随工作流默认模型。测试和技术审核复用 OMP 原生子代理及其既有配置，交付材料由执行 Agent 整理。
- “个性化”沿用 WebGUI 的直接编辑器、保存／取消及 Ctrl/Cmd+S 交互，可选择上述每个 Agent 编辑个人追加系统提示词。追加内容补充内置指令，留空仅清除个人追加内容，不替换内置职责或扩大阶段权限。切换 Agent／设置分区保留未保存草稿；保存提交全部有修改的 Agent，取消丢弃全部未保存修改。
- 最终配置归属当前 OMP 的**用户级配置目录／profile**，在该配置范围内所有项目共用，不按项目、Release、IR、SR 或 worktree 保存。默认示例为 `~/.omp/agent`；实际目录须复用 OMP 现有配置目录解析（包括 `OMP_CONFIG_ROOT`、`PI_CONFIG_DIR`、`PI_CODING_AGENT_DIR` 及现有 profile／XDG 规则），不能硬编码默认路径或使用仓库内 `.omp`。
- 模型样例位于 `packages/ui/src/dev/mock/agent-models.ts`，追加提示词样例位于 `packages/ui/src/dev/mock/prompts/*.md`，编辑状态位于 `packages/ui/src/dev/mock/personalization.ts`。当前全部只保存到页面内存；切换项目后共用同一份演示设置，刷新后恢复样例，不读取或写入真实 OMP 个人配置、用户 `AGENTS.md` 或仓库文件。
- 本轮只修改前端原型与需求说明，不实现后端配置接口、真实文件持久化、系统提示词注入或模型调用。目录示例及保存提示不构成实际文件已写入的证明。

“技能”设置入口已恢复，沿用复制的 WebGUI 技能列表、搜索及只读详情组件。技能样例位于 `packages/ui/src/dev/mock/skills.ts` 和 `skills-detail.md`；不读取真实目录、不安装或修改技能，也不代表当前 OMP 已加载这些技能。

## Skill 设计原型

“Skill 设计”是与“技能”并列的独立设置入口，不改造原技能页面的布局或操作。4 项必填为核心任务、适用场景、所需输入、期望输出与成功标准；边界／不适用场景、流程／参考资料、真实例子为选填，提供“填入示例”。目标沿用当前 Dev 项目，示例保存位置为 `<项目根>/.omp/skills/<name>/SKILL.md`，属于项目技能，不混入个人级模型／追加提示词配置。

底部补充讨论直接嵌入现有 `SessionPane`、`V4PaneConversationProvider`、消息流及原输入组件，仅收起窗格标题，不另写简化输入框或聊天执行器。每个项目的技能设计有独立演示会话 ID，与主工作区 IR/SR 会话分开；表单与补充消息共享设计草稿，聊天建议由用户点击后回填。切换其他设置分区后草稿仍可读回；样例回复不表示真实理解、模型调用或工具执行。

“生成预览”仅用静态模板呈现 `SKILL.md` 和 3 个待试用的验证例子。内容或标识修改后旧预览失效，需重新生成；演示保存检查名称和同名冲突，只将项目技能加入本页内存样例；不改变原技能页的作用域、加载方式或操作。刷新恢复初始样例，不写入真实项目文件、不提交 Git、不改变正式 OMP 技能加载状态。生成模板／回复位于 `mock/skill-design*.md`，草稿交互位于 `mock/skill-design.ts`。

## 交付检查

维护者应在干净复制目录实际执行一次安装，再启动并用浏览器检查各 Dev 模块、切换会话和刷新复位，确认无真实网络业务请求且现有界面布局保持不变。阶段性演示不替代后续真实 OMP 对接与最终业务验收。
