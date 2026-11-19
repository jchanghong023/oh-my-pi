# Proposal：对齐 ZCode 3.18 视觉基础，保留 OMP 功能布局

## Why

WebGUI 复用了 ZCode 控件，但本地面板圆角、样式裁剪和旧主题字阶已产生视觉差异。本变更记录 2026-11-12 授权的 WebGUI 视觉还原范围，保留现有功能布局，不构成合并官方完整 3.18 的许可。

## What Changes

1. 固定保存官方 DESIGN／CONTEXT 原文、版本、提交、许可和哈希，补齐 WebGUI 规范入口。
2. 适配官方深浅主题的前景、表面、边框、输入、选中与阴影。
3. 恢复面板圆角、弱边框与装饰性 inset，保留功能布局。
4. 对齐应用字体字阶、行高和字体平滑。
5. 检查基础控件的调用侧覆盖，已一致的组件不重复替换。
6. 对齐消息、Markdown、代码及 Diff 的视觉层级，保留内容与安全边界。

## Capabilities

### Added Capabilities

- `zcode-visual-baseline`：固定官方视觉来源、OMP 适配、WebGUI 视觉对齐及截图证据范围。

## Impact

- 适用目录：`vendor/zcode-frontend` 的视觉层，以及设计文档／OpenSpec。
- 不改业务、权限、布局、模型策略或依赖；不恢复已裁剪的终端、市场、Highspeed、桌面壳或手机界面。
- 本轮仅静态核对 WebGUI，不启动、不构建、不截图，也不运行测试套件；未实际完成的检查不报告通过。

## Design References

- [官方原文与来源](../../../docs/design/zcode-3.18.0/SOURCE.md)
- [OMP 视觉适配规则](../../../docs/design/omp-zcode-visual-adaptation.md)
- [需求规格](specs/zcode-visual-baseline/spec.md)
