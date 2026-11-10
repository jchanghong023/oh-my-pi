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

页面上的会话、阶段流转、发布、删除、协作、材料及消息都是**演示数据或本页内存变化**，不代表真实模型回复、任务执行、文件/Git 操作、后端记录或验收通过。刷新页面恢复演示初始状态；原复制版组件的主题等浏览器偏好可能保留，完全重置可清除该本地地址的站点数据。当前原型不读写真实项目，不执行 Git、模型调用或远端业务操作。

## 交付检查

维护者应在干净复制目录实际执行一次安装，再启动并用浏览器检查各 Dev 模块、切换会话和刷新复位，确认无真实网络业务请求且现有界面布局保持不变。阶段性演示不替代后续真实 OMP 对接与最终业务验收。
