# Spec Delta

## ADDED Requirements

### Requirement: 固定官方设计依据与 OMP 适配入口

仓库 MUST 保存官方 `DESIGN.md`、`CONTEXT.md` 原文及来源记录，版本固定为 ZCode `3.18.0`、提交 `b95ebaffeab641907b38652f45c1502bd762972d`。WebGUI 根目录 MUST 提供设计规范阅读入口，先说明 OMP 适配规则，再引用固定官方原文。官方产品上下文 MUST NOT 覆盖 OMP 的已确认业务、平台或部署边界。

#### Scenario: 修改 WebGUI 界面
- **WHEN** 开发人员调整 WebGUI 的视觉表现
- **THEN** 能从对应目录的 DESIGN／CONTEXT 入口追溯同一官方原文、精确版本、许可与哈希，并遵循 OMP 视觉适配需求
- **AND** 不因复制设计文档恢复原产品的插件市场、收费、桌面控制或其他已裁剪能力

### Requirement: 对齐深浅主题与面板层级

WebGUI MUST 对齐官方 Zai Light／Zai Dark 中适用的前景、弱文字、背景、surface、panel、border、popover、输入、hover、selected 及阴影规则。面板 MUST 按适用浏览器场景采用官方圆角、弱边框与装饰性 inset，不以统一固定零值抹去原生层级。颜色具体数值 MUST 由主题源码提供，文档不维护另一套颜色表。

#### Scenario: 深浅主题显示同一业务页面
- **WHEN** 使用者在深浅主题中查看聊天、侧栏或弹层
- **THEN** 表面层级与文字角色保持清楚，现有主题存储与宿主适配仍有效
- **AND** 不整包引入终端、Highspeed 或桌面专用依赖，不改变栏宽、面板位置、展开状态、拖拽与最小宽度

### Requirement: 应用字体字阶和状态用法

业务界面 MUST 使用官方应用的 `font-sans`、`text-ui-*`、`--ui-font-size`、字重、行高和适用字体平滑规则；MUST NOT 用官网营销页字体或 HTML 根字号缩放替代应用规范。已与官方一致的基础控件 MUST 保留，在调用侧对齐尺寸、边框、圆角、hover、focus、selected、disabled 与弹层表面用法。

#### Scenario: 正文、元数据与控件并存
- **WHEN** 页面同时显示正文、辅助元数据、按钮和状态信息
- **THEN** 各内容按角色呈现可读层级，不将全部文字降为最弱字阶或颜色；选中、焦点、悬停和禁用可区分
- **AND** 事件、权限、数据作用域、接口与存储行为不因样式对齐改变，不重复替换已一致组件

### Requirement: 聊天消息沿用原生内容层级

聊天 MUST 对齐官方 Markdown、列表、引用、代码及 Diff 的字体、边框、圆角和内容层级，同时保留现有安全渲染、会话归属及折叠规则。长文本与代码 MUST 继续在既定容器中换行或滚动。

#### Scenario: 阅读长消息
- **WHEN** 使用者阅读长正文、路径、表格、引用或代码
- **THEN** 内容仍在原面板内可达，不移动操作入口、不增加常驻信息行或替换模型上下文

### Requirement: 截图核对保持功能布局与证据边界

WebGUI MUST 按固定视觉基线保持既有业务布局；允许边框、圆角及少量控件内部留白调整，不改变导航、面板位置、分栏比例或业务动作。截图证据 MUST 记录实际入口、浏览器、窗口、主题及后端来源；未实际检查的入口不得标为通过。

#### Scenario: 深浅主题和窄桌面核对
- **WHEN** 实际运行 WebGUI 并核对视觉
- **THEN** 检查 Zai Light／Zai Dark、普通及较窄桌面窗口，并核对面板、消息、弹层及关键交互状态
- **AND** 构建或 Chromium 截图不能代称 Firefox 128、真实模型／Git、真实 OMP 后端或发行产物验证

本轮 WebGUI 仅做静态核对，未启动、构建、截图或运行测试套件，不将运行视觉验收标为通过。
