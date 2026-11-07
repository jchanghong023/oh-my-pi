import type { DevStage } from "./types";

export const DEV_STAGES = [
	"business",
	"requirements",
	"solution",
	"planning",
	"executing",
	"st",
	"pr",
	"testing",
] as const;
export const SPEC_PHASES = ["idle", ...DEV_STAGES] as const;
export type SpecDrivenPhase = "idle" | DevStage;
export const SPEC_STAGES = ["business", "requirements", "solution", "plan", "execution"] as const;
export type SpecStage = (typeof SPEC_STAGES)[number];
export type SpecStageRole = "business" | "requirements" | "solution" | "planner" | "executor";
const STAGE_LABELS: Record<SpecStage, string> = {
	business: "业务",
	requirements: "需求",
	solution: "方案",
	plan: "计划",
	execution: "执行",
};
const ROLE_LABELS: Record<SpecStageRole, string> = {
	business: "业务 Agent",
	requirements: "需求 Agent",
	solution: "方案 Agent",
	planner: "计划 Agent",
	executor: "执行 Agent",
};
export function stageForPhase(phase: SpecDrivenPhase): SpecStage {
	if (phase === "business") return "business";
	if (phase === "solution") return "solution";
	if (phase === "planning") return "plan";
	if (phase === "executing" || phase === "st" || phase === "pr" || phase === "testing") return "execution";
	return "requirements";
}
export function stageLabel(stage: SpecStage): string {
	return STAGE_LABELS[stage];
}
export function roleLabel(role: SpecStageRole): string {
	return ROLE_LABELS[role];
}

const DEV_STAGE_LABELS: Record<DevStage, string> = {
	business: "业务需求",
	requirements: "开发需求",
	solution: "技术方案",
	planning: "开发计划",
	executing: "开发与 UT",
	st: "ST测试",
	pr: "提交与 PR",
	testing: "测试人员测试",
};
export function devStageLabel(stage: DevStage): string {
	return DEV_STAGE_LABELS[stage];
}
export function roleForDevStage(stage: DevStage): SpecStageRole {
	if (stage === "business" || stage === "requirements" || stage === "solution") return stage;
	return stage === "planning" ? "planner" : "executor";
}
export function previousDevStage(stage: DevStage): DevStage | null {
	const index = DEV_STAGES.indexOf(stage);
	return index > 0 ? DEV_STAGES[index - 1] : null;
}
export function nextDevStage(stage: DevStage): DevStage | null {
	const index = DEV_STAGES.indexOf(stage);
	return index < DEV_STAGES.length - 1 ? DEV_STAGES[index + 1] : null;
}
