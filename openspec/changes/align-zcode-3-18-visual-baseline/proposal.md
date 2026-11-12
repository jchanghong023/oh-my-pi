# Proposal：对齐 ZCode 3.18 视觉基础，保留 OMP 功能布局

## Why

WebGUI 和 Dev 复制了 ZCode 控件，但本地面板圆角、样式裁剪、旧主题字阶及 Dev 调用侧组合已产生视觉差异。用户于 2026-11-12 明确要求并行完成八项视觉还原，保留重构后的原型／正式共享前端架构及所有功能布局；本变更记录已授权范围，不构成合并官方完整 3.18 的许可。

## What Changes

1. 固定保存官方 DESIGN／CONTEXT 原文、版本、提交、许可和哈希，补齐两个前端的规范入口。
2. 适配官方深浅主题的前景、表面、边框、输入、选中与阴影。
3. 恢复面板圆角、弱边框与装饰性 inset，保留功能布局。
4. 对齐应用字体字阶、行高和字体平滑。
5. 还原完整表格视觉，保留九列、列宽、固定列及全部业务操作。
6. 检查基础控件的调用侧覆盖，已一致的组件不重复替换。
7. 对齐原生工作流、头像、表情、完成标记及动效，保留四 Agent 和人工判断。
8. 对齐消息、Markdown、只读材料、代码及 Diff 的视觉层级，保留内容与安全边界。

## Capabilities

### Added Capabilities

- `zcode-visual-baseline`：固定官方视觉来源、OMP 适配、八项对齐及实际截图证据范围。

### Modified Capabilities

- `dev-browser-workbench`：明确 WebGUI／Dev 视觉对齐例外，保留共享前端、冻结契约和所有业务边界。
- `personal-commands`：保留原 WebGUI 业务与后端，仅授权视觉基线范围内适配。

## Impact

- 适用目录：`vendor/zcode-frontend` 与 `packages/dev-frontend` 的视觉层，以及设计文档／OpenSpec。
- Dev preview/runtime 共用同一 bootstrap 和网络客户端，mock 仍仅在独立后端；请求、响应、错误、实时事件合同及后端地址机制保持。
- 不改业务、权限、布局、模型策略或依赖；不恢复已裁剪的终端、市场、Highspeed、桌面壳或手机界面。
- 本轮按用户要求不运行测试套件，由父任务统一构建并实际截图核对。只有真实完成的入口、浏览器与主题才可报告通过。

## Design References

- [官方原文与来源](../../../docs/design/zcode-3.18.0/SOURCE.md)
- [OMP 视觉适配规则](../../../docs/design/omp-zcode-visual-adaptation.md)
- [需求规格](specs/zcode-visual-baseline/spec.md)
