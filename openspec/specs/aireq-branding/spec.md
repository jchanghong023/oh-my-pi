# AIReq 名称与命令

## Purpose

AIReq 是 OMP 内的 AI 需求澄清、需求管理和进度跟踪工作台。本次统一产品名称及其专属实现命名，不改变业务流程、权限、隔离边界或合同字段结构。

## Requirements

### Requirement: 产品和公开命令统一命名

产品名称 MUST 使用 `AIReq`；TUI 通过 `/aireq` 进入及退出，独立 CLI 通过 `omp aireq` 启动。命令注册、补全、帮助、启动／退出提示、网页和文档 MUST 同步使用新名称，不保留旧产品命令作为别名。原有独占、取消、退出结清和恢复普通会话的规则保持。

### Requirement: 专属实现命名一致

前端包 MUST 使用 `packages/aireq-frontend`，宿主和夹具使用 `aireq-workbench`，前端业务模块使用 `src/aireq`。类型和组件使用 `AIReq`，camelCase 使用 `aiReq`，命名空间及路径使用 `aireq`，常量与环境变量使用 `AIREQ`。接口统一 `/api/aireq/*`；原有HTTP／WebSocket封装、字段和版本值不因更名改变。启动文档同步使用 `OMP_AIREQ_*`、`VITE_AIREQ_BACKEND_URL`、`build:aireq` 和 `gen:aireq`。

### Requirement: 保留通用开发及第三方术语

通用开发脚本 `bun run dev`、Vite开发服务、`import.meta.env.DEV`、`NODE_ENV=development`、Rust开发配置、浏览器DevTools／Dev通道、设备字段`stat.dev`、`models.dev`及Linux `/dev/null`／`/dev/shm`等不属于产品命名，MUST 保持原义。固定版本的第三方原文和许可证不因本产品更名改写。只改仓库源码、资源声明与引用，不删除或搬动用户现有项目、需求文件或数据库。

### Requirement: OMP 主产品身份保持不变

OMP 的仓库名称、根包名称、coding-agent 包名、`omp` 二进制入口和全局品牌 MUST 保持原样。AIReq 仅是 OMP 中的一个功能模块；全仓库统一指该模块及其消费者的名称和引用，不是将整个 OMP 改名。

### Requirement: 登录页标准文案

AIReq 工号入口的标题 MUST 为“以AI为中心的需求和ISSUE管理平台”，副标题 MUST 为“与团队一起澄清需求、评审方案和跟踪需求和issue进度”。工号格式、登录行为和后台归属不因此改变。

## 本轮验证记录

宿主 `bun run --cwd packages/coding-agent check:types` 检查5903个文件通过；`bun run gen:aireq` 构建并生成4339项内嵌资源，资源读取校验通过。CLI命令表、启动参数路由及斜杠命令表均加载到aireq入口。Chromium151本机HTTP原型完成新登录文案、工号进入、正式需求与Skill设计的浏览器检查，请求使用`/api/aireq/*`且未观察到旧接口请求或pageerror。所有原始20667条仓库路径均能在原处或更名目标找到，用户项目文件和数据库未搬动。未运行测试套件；本机缺少pi_natives原生扩展，因此完整CLI进程启动未通过本机验证，不以命令表或前端原型验证替代。
