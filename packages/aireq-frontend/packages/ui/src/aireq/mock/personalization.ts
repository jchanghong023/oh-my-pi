import { requirePrototypeSettingsWrite } from "./backend.js";
// 仅用于编辑器演示的静态文本；不注入任何真实 Agent。
import requirements from "./prompts/requirements.md?raw";
import independentReview from "./prompts/requirements-review-independent.md?raw";
import requirementsReview from "./prompts/requirements-review.md?raw";
import solution from "./prompts/solution.md?raw";
import skillDesign from "./prompts/skill-design.md?raw";
import progressAnalysis from "./prompts/progress-analysis.md?raw";

export interface PrototypeAgentPrompts { [agentId: string]: string }

const samples: PrototypeAgentPrompts = {
	requirements,
	"requirements-review": requirementsReview,
  "requirements-review-a": independentReview,
  "requirements-review-b": independentReview,
  "requirements-review-c": independentReview,
	solution,
	"progress-analysis": progressAnalysis,
  "skill-design": skillDesign,
};

// 与模型设置相同，属于当前开发者后端自己的 OMP profile；不进入共享业务数据库，不随浏览器工号切换。
// 草稿和保存值保存在后端场景内存；刷新保留，服务重启恢复样例，不读写真实 OMP 文件。
let saved = { ...samples };
let draft = { ...samples };
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
