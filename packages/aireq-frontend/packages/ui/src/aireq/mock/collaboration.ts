import type { AIReqPeer } from "../types.js";

/** Phase-one local collaboration samples, never a discovery or presence service. */
export const prototypePeers: AIReqPeer[] = [
  { id: "peer-design", name: "林悦", role: "产品与体验", status: "在线（样例）", projectId: "demo-aurora",
    materials: [
      { title: "登录体验走查", path: "shared/auth-experience.md", content: "# 登录体验走查（共享样例）\n\n这是前端样例，不是真实协作记录。\n\n- 首次进入突出项目与需求上下文。\n- 权限不足时解释原因并保留返回路径。\n- 材料可带入原输入框，但不自动发送。\n\n待确认：默认项目、草稿命名与长列表布局。" },
      { title: "界面反馈清单", path: "shared/ui-feedback.md", content: "# 界面反馈（共享样例）\n\n关注导航层级、状态对比、按钮间距与材料可读性。所有条目仅供阶段性前端原型走查，未做真实验收。" },
    ], logs: [
      { id: "design-1", time: "09:10", text: "样例记录：整理登录与权限体验问题。" },
      { id: "design-2", time: "09:24", text: "样例记录：共享登录体验走查文档，等待前端原型反馈。" },
    ] },
  { id: "peer-frontend", name: "陈明", role: "前端开发", status: "讨论中（样例）", projectId: "demo-aurora",
    materials: [
      { title: "阶段导航约定", path: "shared/stage-navigation.md", content: "# 阶段导航约定（共享样例）\n\n方案、计划、开发与验证、交付 PR 使用原界面阶段控件。当前材料与历史材料只读展示。\n\n此文不代表接口已经对接；真实 OMP 集成在用户确认后实施。" },
    ], logs: [
      { id: "frontend-1", time: "10:05", text: "样例记录：准备提案两阶段与三阶段 SR 开发演示数据，不执行真实任务。" },
      { id: "frontend-2", time: "10:18", text: "样例记录：整理材料复制与未发送草稿的交互说明。" },
    ] },
  { id: "peer-quality", name: "周宁", role: "质量与验证", status: "离线（样例）", projectId: "demo-aurora",
    materials: [{ title: "验证报告版式", path: "shared/validation-layout.md", content: "# 验证报告版式（共享样例）\n\nUT / ST 表格展示用例编号、预期结果与真实运行证据。\n\n本阶段只展示样例，未运行测试、未采集耗时或覆盖率。" }],
    logs: [{ id: "quality-1", time: "昨天", text: "样例记录：提供验证报告布局；不是测试通过记录。" }] },
  { id: "peer-mobile", name: "许安", role: "移动端体验", status: "在线（样例）", projectId: "demo-mobile",
    materials: [{ title: "移动导航草案", path: "shared/mobile-navigation.md", content: "# 移动导航草案（共享样例）\n\n项目切换、通知卡片、个人资料和离线提示使用一致的交互语言。\n\n仅用于阶段性前端原型，不代表移动端实现或真实多人连接。" }],
    logs: [{ id: "mobile-1", time: "11:02", text: "样例记录：整理移动工作台导航与通知资料。" }] },
];
export function getPrototypePeers(projectId?: string): AIReqPeer[] {
  return prototypePeers.filter(peer => peer.projectId === projectId);
}
