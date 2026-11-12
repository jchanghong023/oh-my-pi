import { requirePrototypeSettingsWrite } from "./backend.js";
export interface PrototypeAgentPrompts { [agentId: string]: string }

// 与模型设置相同，属于当前开发者后端自己的 OMP profile；不进入共享业务数据库，不随浏览器工号切换。
// 草稿和保存值保存在后端场景内存；刷新保留，服务重启恢复样例，不读写真实 OMP 文件。
// 追加指令初始为空；内置指令不是用户追加内容，不在编辑框预填样例。
let saved: PrototypeAgentPrompts = {};
let draft: PrototypeAgentPrompts = {};
export function readPrototypeAgentPrompts() {
	return { saved: { ...saved }, draft: { ...draft } };
}
export function updatePrototypeAgentPromptDrafts(value: PrototypeAgentPrompts): void {
  requirePrototypeSettingsWrite();
	draft = { ...value };
}
export function savePrototypeAgentPrompts(value: PrototypeAgentPrompts): void {
  requirePrototypeSettingsWrite();
	saved = { ...value };
	draft = { ...value };
}
