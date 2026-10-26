/** Four file-producing stages; acceptance and closure are execution lifecycle boundaries. */
export const SPEC_PHASES = [
	"idle",
	"requirements",
	"awaiting-specification",
	"solution",
	"awaiting-choice",
	"planning",
	"awaiting-plan",
	"executing",
	"awaiting-acceptance",
	"closing",
	"completed",
	"cancelled",
] as const;
export type SpecDrivenPhase = (typeof SPEC_PHASES)[number];
export const SPEC_STAGES = ["requirements", "solution", "plan", "execution"] as const;
export type SpecStage = (typeof SPEC_STAGES)[number];
export type SpecStageRole = "requirements" | "solution" | "planner" | "executor";
export interface SpecRunTiming {
	plannedDecisionWaitMs: number;
	executionWaitMs: number;
}
const STAGE_LABELS: Record<SpecStage, string> = {
	requirements: "需求",
	solution: "方案",
	plan: "计划",
	execution: "执行",
};
const ROLE_LABELS: Record<SpecStageRole, string> = {
	requirements: "需求 Agent",
	solution: "方案 Agent",
	planner: "计划 Agent",
	executor: "执行 Agent",
};
export function stageForPhase(phase: SpecDrivenPhase): SpecStage {
	if (phase === "solution" || phase === "awaiting-choice") return "solution";
	if (phase === "planning" || phase === "awaiting-plan") return "plan";
	if (["executing", "awaiting-acceptance", "closing", "completed", "cancelled"].includes(phase)) return "execution";
	return "requirements";
}
export function stageLabel(stage: SpecStage): string {
	return STAGE_LABELS[stage];
}
export function roleLabel(role: SpecStageRole): string {
	return ROLE_LABELS[role];
}
export function isDecisionPhase(phase: SpecDrivenPhase): boolean {
	return ["awaiting-specification", "awaiting-choice", "awaiting-plan", "awaiting-acceptance"].includes(phase);
}
export function isExecutionPhase(phase: SpecDrivenPhase): boolean {
	return ["requirements", "solution", "planning", "executing", "closing"].includes(phase);
}
