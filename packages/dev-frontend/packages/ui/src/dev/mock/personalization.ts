// 仅用于编辑器演示的静态文本；不注入任何真实 Agent。
import requirements from "./prompts/requirements.md?raw";
import requirementsReview from "./prompts/requirements-review.md?raw";
import solution from "./prompts/solution.md?raw";
import planning from "./prompts/planning.md?raw";
import execution from "./prompts/execution.md?raw";
import irAcceptance from "./prompts/ir-acceptance.md?raw";

export interface PrototypeAgentPrompts { [agentId: string]: string }

const samples: PrototypeAgentPrompts = {
	requirements,
	"requirements-review": requirementsReview,
	solution,
	planning,
	execution,
	"ir-acceptance": irAcceptance,
};

// 与模型设置相同，按当前 OMP 服务账号／profile 的演示配置保存，不按浏览器工号、项目、IR 或 SR 分区。
// 草稿跨设置分区保留；浏览器刷新会重新载入演示样例，不读写真实 OMP 文件。
let saved = { ...samples };
let draft = { ...samples };
export function readPrototypeAgentPrompts() {
	return { saved: { ...saved }, draft: { ...draft } };
}
export function updatePrototypeAgentPromptDrafts(value: PrototypeAgentPrompts): void {
	draft = { ...value };
}
export function savePrototypeAgentPrompts(value: PrototypeAgentPrompts): void {
	saved = { ...value };
	draft = { ...value };
}
