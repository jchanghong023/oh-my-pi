/** Single source for the native /dev phase vocabulary and its user-facing stage projection. */
export const SPEC_PHASES = [
	"idle",
	"requirements",
	"requirements-review",
	"awaiting-answers",
	"awaiting-specification",
	"team",
	"awaiting-choice",
	"planning",
	"plan-review",
	"awaiting-plan",
	"executing",
	"validating",
	"overall-review",
	"awaiting-acceptance",
	"closing",
	"completed",
	"cancelled",
] as const;
export type SpecDrivenPhase = (typeof SPEC_PHASES)[number];

export const SPEC_STAGES = ["requirements", "solution", "plan", "execution", "acceptance", "closure"] as const;
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
	acceptance: "验收",
	closure: "收尾",
};
const ROLE_LABELS: Record<SpecStageRole, string> = {
	requirements: "需求 Agent",
	solution: "方案 Agent",
	planner: "计划 Agent",
	executor: "执行 Agent",
};
const DECISION_PHASES: Partial<Record<SpecDrivenPhase, true>> = {
	"awaiting-answers": true,
	"awaiting-specification": true,
	"awaiting-choice": true,
	"awaiting-plan": true,
	"awaiting-acceptance": true,
};
const EXECUTION_PHASES: Partial<Record<SpecDrivenPhase, true>> = {
	team: true,
	planning: true,
	executing: true,
	validating: true,
	"overall-review": true,
	closing: true,
};

export function stageForPhase(phase: SpecDrivenPhase): SpecStage {
	if (phase === "team" || phase === "awaiting-choice") return "solution";
	if (phase === "planning" || phase === "plan-review" || phase === "awaiting-plan") return "plan";
	if (phase === "executing") return "execution";
	if (phase === "validating" || phase === "overall-review" || phase === "awaiting-acceptance") return "acceptance";
	if (phase === "closing" || phase === "completed" || phase === "cancelled") return "closure";
	return "requirements";
}

export function stageLabel(stage: SpecStage): string {
	return STAGE_LABELS[stage];
}

export function roleLabel(role: SpecStageRole): string {
	return ROLE_LABELS[role];
}

export function isDecisionPhase(phase: SpecDrivenPhase): boolean {
	return DECISION_PHASES[phase] === true;
}

export function isExecutionPhase(phase: SpecDrivenPhase): boolean {
	return EXECUTION_PHASES[phase] === true;
}
