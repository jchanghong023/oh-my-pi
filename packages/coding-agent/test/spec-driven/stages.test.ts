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

test("maps lifecycle phases onto exactly four shared file stages", () => {
	expect(SPEC_PHASES).toHaveLength(12);
	expect(new Set(SPEC_PHASES).size).toBe(12);
	expect(SPEC_STAGES).toEqual(["requirements", "solution", "plan", "execution"]);
	const stages = new Set<string>(SPEC_STAGES);
	for (const phase of SPEC_PHASES) expect(stages.has(stageForPhase(phase))).toBe(true);
	expect(stageForPhase("requirements")).toBe("requirements");
	expect(stageForPhase("solution")).toBe("solution");
	expect(stageForPhase("planning")).toBe("plan");
	expect(stageForPhase("executing")).toBe("execution");
	expect(stageForPhase("awaiting-acceptance")).toBe("execution");
	expect(stageForPhase("completed")).toBe("execution");
	expect(stageLabel("execution")).toBe("执行");
	expect(roleLabel("planner")).toBe("计划 Agent");
});

test("derives the ZCode protocol enums from the shared phase and stage lists", () => {
	expect(ompSpecPhaseSchema.options).toEqual([...SPEC_PHASES]);
	expect(ompSpecStageSchema.options).toEqual([...SPEC_STAGES]);
});

test("classifies only the declared phases as decision or execution time", () => {
	expect(SPEC_PHASES.filter(isDecisionPhase)).toEqual([
		"awaiting-specification",
		"awaiting-choice",
		"awaiting-plan",
		"awaiting-acceptance",
	]);
	expect(SPEC_PHASES.filter(isExecutionPhase)).toEqual([
		"requirements",
		"solution",
		"planning",
		"executing",
		"closing",
	]);
});
