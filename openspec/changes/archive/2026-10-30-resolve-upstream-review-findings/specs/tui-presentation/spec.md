# Spec Delta

## ADDED Requirements

### Requirement: 多行输入的输入法安全布局

OMP MUST 在多行输入时保护输入法预编辑位置，避免非末行预编辑文本挤移右侧边框；安全布局不得依赖应用检测到实际预编辑文字。

#### Scenario: 光标在非末行末尾
- **WHEN** `tui.imeSafeCursor` 已启用、输入框获得焦点并使用硬件光标，光标位于带侧边框的非末行文本末尾，且该行不处于选区渲染
- **THEN** 即使尚未出现预编辑文字，该行 MUST 保留左边框和输入文本，不绘制右边框；不改变消息原文或其他行布局。

#### Scenario: 安全布局条件不满足
- **WHEN** 输入法安全布局关闭，或焦点、硬件光标、侧边框、行末位置、选区条件中任一条件不满足
- **THEN** 非末行 MUST 沿用正常边框布局；末行及其他输入区域的既有安全行为保持不变。

### Requirement: 显示档位不得新增旁路设置

OMP MUST 移除独立暴露的 `display.compactToolActivity` 设置入口，使工具活动及结果图片由 `/display` 三档控制，并保留已批准的图片设置边界。

#### Scenario: 修改显示档位
- **WHEN** 用户通过 `/display` 或原工具可见性快捷键切换显示档位
- **THEN** 工具活动和结果图片 MUST 与 clean、compact、detailed 的批准规则一致，不得再通过独立工具紧凑显示开关旁路改变；现有 `terminal.showImages` 与 `images.*` 仍按原优先级独立生效。

### Requirement: 设置汉化和默认主题文档一致

OMP MUST 将主要设置页面中 worktree scope 的可翻译名称、说明和选项呈现为简体中文，并使设置文档的深色主题默认值与已批准值一致。

#### Scenario: 查看会话工作树范围设置
- **WHEN** 用户打开 `session.worktreeScope` 设置
- **THEN** 该项名称、说明及选项说明 MUST 使用自然简体中文，保留配置键及 `directory`／`repo` 机器值和原有行为。

#### Scenario: 查看主题设置文档
- **WHEN** 用户查看设置文档中的 `theme.dark` 默认值
- **THEN** 文档 MUST 写 `titanium`，与普通及 offline 的已批准默认设置一致，不覆盖用户显式选择。

### Requirement: Spinner 帧间隔恢复上游

OMP MUST 将本次全局 Spinner 的帧间隔恢复为审查基线上游的 80 毫秒，不改变其他已批准的 offline 显示节流规则。

#### Scenario: Spinner 帧推进
- **WHEN** 使用该全局 Spinner 推进动画帧
- **THEN** MUST 按上游 80 毫秒间隔推进，而非 fork 新增的 160 毫秒间隔。
