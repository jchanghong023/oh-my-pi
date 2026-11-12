# OMP 前端设计规范入口

本前端以官方 ZCode 3.18.0 为视觉基线。修改 UI 前依次读取：

1. [OMP 视觉适配规则](../../docs/design/omp-zcode-visual-adaptation.md)：确定本项目功能、布局、平台和新架构边界。
2. [官方 DESIGN.md 原文](../../docs/design/zcode-3.18.0/DESIGN.md)：采用颜色、层级、字阶、圆角、控件及状态的设计规则。
3. [OpenSpec 视觉基线](../../openspec/specs/zcode-visual-baseline/spec.md)：读取已批准的需求和验收范围。

官方原文按精确提交保存，见[来源记录](../../docs/design/zcode-3.18.0/SOURCE.md)。本入口不修改官方原文；官方产品功能、桌面系统壳、插件市场等说明不能覆盖 OMP 已确认需求。发生冲突时，先遵守当前用户指令、OMP OpenSpec 与适配规则，不为外观对齐改变业务布局或服务契约。
