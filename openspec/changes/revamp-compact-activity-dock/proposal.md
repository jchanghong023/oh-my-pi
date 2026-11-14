# Proposal

## Why

compact 固定两行活动区目前以原始工具名起始、整行随状态栏运行标记扫光、活跃思考原文占满两行，工具行带实时耗时。用户要求把该区域改为统一的中文动作状态展示：每行"动作状态 + 两个半角空格 + 灰色详情"，动作区固定四个中文字符宽度，仅进行中的动作词播放既有扫光，思考完成后显示阶段耗时，运行中动作优先占位。

已核实两个底层事件缺口：`tool_execution_end` 不携带取消标志；审批等待没有逐调用状态。经用户确认，本次只改显示层：不改 `packages/agent`、扩展 wrapper/runner、共享 shimmer 助手，不新增事件、配置或设置页。底层无法区分的状态（取消、等待确认）归并为通用文案，不伪造判定。本变更取代 `tui-presentation` 中与新布局、选择策略、配色动画冲突的既有需求条款。

## What Changes

- 每行布局改为固定 8 显示列动作区 + 两个半角空格 + 灰色详情；详情起点固定，不随状态切换移动；终端缩窄优先压缩详情，极窄时动作区也安全裁剪。
- 动作按类别映射中文状态词：思考、读取文件、Bash/Shell 执行、文件修改（write/edit/补丁等）、其余工具回退"正在调用/调用完成"；详情复用既有真实工具摘要，未映射工具不得误标为读取或执行。
- 状态沿用现有生命周期事实：`tool_execution_end.isError` 区分失败；无取消标志时取消归并现有结果态；审批等待保持进行中显示，不新增"等待确认"判定。
- 思考成为单条动作记录：进行中显示当前思考片段最新非空一行；成功结束原位显示"用时 x.x 秒"（一位小数，不足 0.1 秒显示"<0.1"，超过一分钟仍用秒）；每个独立思考阶段按 `thinking_start`/`thinking_end` 单独计时。
- 删除工具行实时耗时、"提交"/"等待"计时前缀；耗时仅保留思考完成态。
- 两行选择改为"运行中 > 最近结束"：串行首个动作放下行，下一动作开始时最近结束项移上行；并行最多显示两个运行项，位置稳定、最早开始者优先补位、不轮播；运行项不因完成提示被隐藏。
- 动画仅作用于进行中动作词，复用现有 shimmer 样式、调色板与共享刷新机制；不修改中心助手，扫光周期沿用现有恒速（4 字词约 0.8 秒一轮，非 1.5 秒）；全部可见动作结束、档位切换或退出 compact 后停止刷新。
- ANSI `render` 与 native `describe` 两条路径同步实现；native 扫光由终端计时，周期不可控。
- 保留只读输出预览、文件型 write/edit 历史原组件、聊天历史与完整输出入口不变。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `tui-presentation`: 固定两行活动区的行格式、动作状态映射、两行选择策略、思考记录与耗时、动画与配色生命周期被取代；全部工具投影覆盖、流式摘要稳定性、紧凑历史回执中引用旧选择规则与行格式的条款同步更新。

## Impact

- 显示层：`packages/coding-agent/src/modes/compact-thinking-preview.ts`（主体）、`packages/coding-agent/src/modes/compact-tool-summary.ts`（详情摘要微调）。
- 复用不改：共享 spinner ticker、`shimmerText`/`describeShimmer`、`visibleWidth`/`truncateToWidth`/`truncateMiddleToWidth`、主题色、会话记忆与清理机制。
- 不改：`packages/agent` 事件契约、扩展 wrapper/runner 审批链、工具执行与并发策略、clean/detailed 行为、普通模式。
- 测试：`interactive-mode-working-label.test.ts` 等旧契约断言需按新行为更新；`compact-status-spacing.test.ts` 的两行加一行留白占用保留。
- 验收边界：ANSI 与 native 分别验证；native 扫光周期、无法区分取消/等待确认的降级文案为明示未验证/降级项。

## 未决问题

- 无。取消与等待确认的归并文案、动画沿用现有节奏均已由用户确认。
