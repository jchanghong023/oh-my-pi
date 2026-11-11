import type { DevSkillDesignDraft, DevSkillDesignPreview, DevAgentModelBinding } from "../types.js";
import { readPrototypeAgentModelBinding } from "./agent-models.js";
import promptTemplate from "../skill-design-prompt.md?raw";
import generatedSample from "./skill-design-generated.md?raw";
import checklistSample from "./skill-design-checklist.md?raw";
import { PROTOTYPE_BACKEND, prototypeSettingsWriteAllowed } from "./backend.js";
import { readPrototypeDevelopmentRoot } from "./project-settings.js";
import { savePrototypeDesignedSkill } from "./skills.js";
import chatTemplate from "./skill-design-chat.md?raw";
import discussionTemplate from "./skill-design-discussion.md?raw";
import { createPrototypeEvent } from "./events.js";

const emptyDraft: DevSkillDesignDraft = { goal: "", when: "", inputs: "", outputs: "", boundaries: "", references: "", example: "", notes: [] };
export const PROTOTYPE_SKILL_DESIGN_SAMPLE: DevSkillDesignDraft = {
	goal: "评审接口变更，识别向后兼容性问题",
	when: "用户请求评审 API 变更、接口 PR，或检查向后兼容性时使用。",
	inputs: "当前 Git diff、接口定义、受影响调用方及相关测试。",
	outputs: "按严重程度列出问题，包含文件和行号、影响、依据与修改建议；区分已确认问题和待核实项。",
	boundaries: "只分析，不修改代码。纯文档排版不触发；缺少接口变更时说明不适用。",
	references: "先阅读项目现有接口规范，核对请求、响应、错误码及相关测试，不假定未提供的客户端行为。",
	example: "输入：删除响应中的必填字段。期望：指出受影响调用方，并提出兼容过渡建议；没有证据时列为待核实。",
	notes: [],
};
const modelBindings = new Map<string, DevAgentModelBinding>();
export function prototypeSkillDesignBinding(sessionId: string): DevAgentModelBinding {
  let binding = modelBindings.get(sessionId);
  if (!binding) { binding = readPrototypeAgentModelBinding("skill-design"); modelBindings.set(sessionId, binding); }
  return structuredClone(binding);
}
const drafts = new Map<string, DevSkillDesignDraft>();
const supplements = createPrototypeEvent<string>();
export const onPrototypeSkillDesignSupplement = supplements.event;
export function prototypeSkillDesignSession(projectId: string): string { return `prototype-skill-design:${PROTOTYPE_BACKEND.id}:${projectId}`; }
export function readPrototypeSkillDesign(sessionId: string): DevSkillDesignDraft { return structuredClone(drafts.get(sessionId) ?? emptyDraft); }
export function savePrototypeSkillDesignDraft(sessionId: string, value: DevSkillDesignDraft): void { drafts.set(sessionId, structuredClone(value)); }
const previews = new Map<string, DevSkillDesignPreview>();
export function prototypeSkillDesignDirectory(sessionId: string): string {
  return `/tmp/omp-dev/skill-design/${PROTOTYPE_BACKEND.id}/${encodeURIComponent(sessionId)}`;
}
export function preparePrototypeSkillDesignPrompt(sessionId: string, draft: DevSkillDesignDraft): string {
  const values: Record<string, string> = { ...draft, notes: draft.notes.join("\n\n"), directory: prototypeSkillDesignDirectory(sessionId) };
  return promptTemplate.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => values[key] || "（未填写）");
}
export function readPrototypeSkillDesignPreview(sessionId: string): DevSkillDesignPreview | undefined {
  const preview = previews.get(sessionId);
  return preview ? structuredClone(preview) : undefined;
}
export function prototypeSkillDesignReply(sessionId: string, message: string): string {
  if (!prototypeSettingsWriteAllowed()) throw new Error("当前访问方式不支持 Skill 设计，请使用自己启动的 OMP Web。");
  const draft = readPrototypeSkillDesign(sessionId);
  const directory = prototypeSkillDesignDirectory(sessionId);
  // 完整表单消息已在会话历史中保留，避免再次填入时递归嵌套此前整份提示词。
  if (!message.includes(directory)) draft.notes.push(message);
  savePrototypeSkillDesignDraft(sessionId, draft);
  const previous = previews.get(sessionId);
  if (!message.includes(directory) && !previous) {
    supplements.fire(sessionId);
    return discussionTemplate;
  }
  // 原型固定产物自行提供推荐标识，不从用户填写的字段生成名称。
  const name = generatedSample.match(/^name: (.+)$/m)![1]!.trim();
  previews.set(sessionId, {
    name, directory, revision: (previous?.revision ?? 0) + 1,
    files: [
      { path: "SKILL.md", content: generatedSample.replace("name: review-api-changes", `name: ${name}`) },
      { path: "references/checklist.md", content: checklistSample },
    ],
  });
  supplements.fire(sessionId);
  return chatTemplate.replaceAll("{{directory}}", directory).replaceAll("{{name}}", name);
}
export function savePrototypeSkillDesignPreview(sessionId: string, workspacePath: string, name: string, target: "project" | "user"): string {
  if (!prototypeSettingsWriteAllowed()) throw new Error("当前访问方式不支持保存技能，请使用自己启动的 OMP Web。");
  const preview = previews.get(sessionId);
  if (!preview) throw new Error("请先发送设计需求，并预览生成的临时文件。");
  const prefix = `prototype-skill-design:${PROTOTYPE_BACKEND.id}:`;
  if (!sessionId.startsWith(prefix)) throw new Error("请使用自己的 OMP Dev 技能设计会话。");
  const projectId = sessionId.slice(prefix.length);
  if (target === "project" && (!workspacePath || readPrototypeDevelopmentRoot(projectId, PROTOTYPE_BACKEND.owner) !== workspacePath)) throw new Error("请先配置当前项目的我的开发项目，不能保存到共享目录。");
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64) throw new Error("模型推荐的技能标识无效，请返回对话调整推荐结果。");
  return savePrototypeDesignedSkill(target === "user" ? PROTOTYPE_BACKEND.userSkillsDirectory : workspacePath, name, "聊天生成技能的原型样例", preview.files.find(file => file.path === "SKILL.md")!.content.replace(/^name: .*$/m, `name: ${name}`), preview.files, target === "user" ? "user" : "workspace");
}
