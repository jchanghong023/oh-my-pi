# Spec Delta

## MODIFIED Requirements

### Requirement: AIReq 浏览器工作台启动入口

OMP MUST 提供会话内 `/aireq` 和命令行 `omp aireq` 两个工作台启动入口，输出完整可复制地址；非 offline 自动打开浏览器，offline 由用户手动打开。两者 MUST 指向目标目录的同一新 AIReq 业务能力；会话内 `/aireq` 进入独占 AIReq，当前 TUI 此后仅接受再次 `/aireq` 结清退出，不恢复旧 AIReq 阶段输入或子操作，不因打开网页自动创建需求或调用模型。

#### Scenario: 从 OMP 会话打开
- **WHEN** 用户启动 OMP 后输入 `/aireq`
- **THEN** 普通模型、工具或任务未结清时拒绝进入并提示先停止或等待，普通 Loop 未退出时提示先退出；不自动终止普通任务或退出 Loop。准入成功才启动或复用目标目录的工作台服务，显示实际完整地址，仅非 offline 自动打开浏览器
- **AND** 进入后当前 TUI 拒绝所有普通命令和输入，仅接受再次 `/aireq` 退出；网页与普通 TUI 不同时操作，普通原会话保留但不继续操作。不显示旧 AIReq 三行固定状态区，也不自动启动需求、Team 或 Goal
- **AND** 普通 Collab 正在共享或处于 `join` 会话时拒绝进入，提示先自行停止共享或离开该会话，不自动停止共享或离开 Collab；成功进入后仍支持 AIReq 网页按既有 Collab 机制共享及 `join`

#### Scenario: 直接从命令行打开
- **WHEN** 用户在自己的目录运行 `omp aireq`，包括先手动 `git pull` 获取新流程记录后运行
- **THEN** 使用当前 OMP 的有效目录、profile、模型和运行环境启动工作台，输出完整地址，仅非 offline 自动打开浏览器，不要求先手动进入 TUI 或另外启动前端开发服务器
- **AND** 读取已有新需求记录不自动拉取仓库、执行 Git 写入、迁移聊天、接管远端会话或启动 Agent

#### Scenario: 再次 dev 结清退出
- **WHEN** 用户已进入 AIReq，在当前 TUI 再次执行 `/aireq`
- **THEN** 通过既有 native stop／settlement 停止并结清 AIReq 自有工作，成功后恢复普通原会话；失败保留 AIReq 锁定及真实原因，不提前恢复普通命令和输入
- **AND** 退出不取消需求、不撤销 Git、不删除材料；不为普通 `/new`／move／dispose 与 AIReq 并存保留会话快照、克隆或额外架构

#### Scenario: 单纯重开网页
- **WHEN** 用户重开同一工作台网页，而非在 TUI 再次执行 `/aireq`
- **THEN** 返回已有实际入口和状态，不重复创建需求、不重放任务或确认；不将重开网页解释为退出 AIReq
- **AND** 多人访问唯一共享 AIReq Web 读取同一业务数据，不启动各自的 AIReq Web，不建立仓库单 IR 或 SR 执行名额；TUI 模式独占与普通 WebGUI 原生项目准入保持各自边界

#### Scenario: 浏览器无法自动打开
- **WHEN** 服务已就绪但宿主没有可用桌面浏览器，或自动打开失败
- **THEN** 仍输出完整实际地址，并明确报告浏览器未自动打开；不能把服务启动失败冒充仅浏览器打开失败，也不能只输出不可用地址

#### Scenario: 页面关闭不停止宿主任务
- **WHEN** 用户从任一入口打开的浏览器页面关闭、刷新或断开
- **THEN** 按 aireq-browser-workbench 的生命周期保留宿主任务和 AIReq 锁定，不恢复普通 TUI 输入；再次 `/aireq` 退出、显式停止或退出 OMP 才按原生规则处理自有资源，页面不是执行 owner

#### Scenario: 新界面与新流程
- **WHEN** 用户进入新 AIReq
- **THEN** 使用 AIReq 自有 WebGUI 风格界面，提案采用需求→四 Agent 评审→方案→入库三栏流程，正式需求采用大表格与同页代码证据报告；开发在平台外完成，不提供计划／执行／IR 验收 Agent、开发名额、冻结锁或最终归档流水线；原 WebGUI 业务与后端保持不变，视觉基础仅按 [zcode-visual-baseline](../zcode-visual-baseline/spec.md) 的已授权范围对齐
