/** Acceptance and closing are execution facts, never additional phases. */
export const SPEC_PHASES = ["idle", "requirements", "solution", "planning", "executing"] as const;
export type SpecDrivenPhase = (typeof SPEC_PHASES)[number];
export const SPEC_STAGES = ["requirements", "solution", "plan", "execution"] as const;
export type SpecStage = (typeof SPEC_STAGES)[number];
export type SpecStageRole = "requirements" | "solution" | "planner" | "executor";
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
	if (phase === "solution") return "solution";
	if (phase === "planning") return "plan";
	if (phase === "executing") return "execution";
	return "requirements";
}
export function stageLabel(stage: SpecStage): string {
	return STAGE_LABELS[stage];
}
export function roleLabel(role: SpecStageRole): string {
	return ROLE_LABELS[role];
}
