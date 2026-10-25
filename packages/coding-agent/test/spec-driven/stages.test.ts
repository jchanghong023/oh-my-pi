import { expect, test } from "bun:test";
import { ompSpecPhaseSchema, ompSpecStageSchema } from "../../src/modes/zcode/schema/omp-spec-extension";
import {
	isDecisionPhase,
	isExecutionPhase,
	roleLabel,
	SPEC_PHASES,
	SPEC_STAGES,
	stageForPhase,
	stageLabel,
} from "../../src/spec-driven/stages";

test("maps all 17 phases onto the shared six-stage vocabulary", () => {
	expect(SPEC_PHASES).toHaveLength(17);
	expect(new Set(SPEC_PHASES).size).toBe(17);
	const stages = new Set<string>(SPEC_STAGES);
	for (const phase of SPEC_PHASES) expect(stages.has(stageForPhase(phase))).toBe(true);
	expect(stageForPhase("awaiting-answers")).toBe("requirements");
	expect(stageForPhase("team")).toBe("solution");
	expect(stageForPhase("plan-review")).toBe("plan");
	expect(stageForPhase("executing")).toBe("execution");
	expect(stageForPhase("awaiting-acceptance")).toBe("acceptance");
	expect(stageForPhase("completed")).toBe("closure");
	expect(stageLabel("execution")).toBe("执行");
	expect(roleLabel("planner")).toBe("计划 Agent");
});

test("derives the ZCode protocol enums from the shared phase and stage lists", () => {
	expect(ompSpecPhaseSchema.options).toEqual([...SPEC_PHASES]);
	expect(ompSpecStageSchema.options).toEqual([...SPEC_STAGES]);
});

test("classifies only the declared phases as decision or execution time", () => {
	expect(SPEC_PHASES.filter(isDecisionPhase)).toEqual([
		"awaiting-answers",
		"awaiting-specification",
		"awaiting-choice",
		"awaiting-plan",
		"awaiting-acceptance",
	]);
	expect(SPEC_PHASES.filter(isExecutionPhase)).toEqual([
		"team",
		"planning",
		"executing",
		"validating",
		"overall-review",
		"closing",
	]);
});
