import { expect, test } from "bun:test";
import { roleLabel, SPEC_PHASES, SPEC_STAGES, stageForPhase, stageLabel } from "../../src/spec-driven/stages";

test("exposes idle and exactly four working phases", () => {
	expect(SPEC_PHASES).toEqual(["idle", "requirements", "solution", "planning", "executing"]);
	expect(SPEC_STAGES).toEqual(["requirements", "solution", "plan", "execution"]);
	expect(stageForPhase("requirements")).toBe("requirements");
	expect(stageForPhase("solution")).toBe("solution");
	expect(stageForPhase("planning")).toBe("plan");
	expect(stageForPhase("executing")).toBe("execution");
});

test("labels working roles and formal artifact stages in Chinese", () => {
	expect(stageLabel("requirements")).toBe("需求");
	expect(stageLabel("solution")).toBe("方案");
	expect(stageLabel("plan")).toBe("计划");
	expect(stageLabel("execution")).toBe("执行");
	expect(roleLabel("requirements")).toBe("需求 Agent");
	expect(roleLabel("solution")).toBe("方案 Agent");
	expect(roleLabel("planner")).toBe("计划 Agent");
	expect(roleLabel("executor")).toBe("执行 Agent");
});
