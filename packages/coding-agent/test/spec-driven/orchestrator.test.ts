import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SpecArtifactStore } from "../../src/spec-driven/artifacts";
import { SpecAdmissionError, SpecDrivenOrchestrator, StaleRun } from "../../src/spec-driven/orchestrator";
import type { SpecAgentInput, SpecDrivenPorts, SpecRunContext, SpecStageRole } from "../../src/spec-driven/types";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});
const REQUIREMENTS =
	"# Requirements\n\n## Requirement: Four file stages\nThe workflow SHALL preserve complete upstream documents.\n\n### Scenario: Original user confirmation\n- WHEN a user chooses an option\n- THEN the planner receives that exact reply.\n";
const PROPOSAL =
	"# File workflow\n\n## Why\nPreserve complete requirements and original decisions across four stages.\n\n## What Changes\n- Add file-validated workflow transitions.\n\n## Capabilities\n\n### New Capabilities\n- `workflow`: Four-stage file orchestration.\n\n### Modified Capabilities\nNone.\n\n## Impact\nThe spec-driven orchestrator and its tests.\n";
const DELTA =
	"## ADDED Requirements\n\n### Requirement: Four file stages\nThe workflow SHALL preserve complete upstream documents.\n\n#### Scenario: Original user confirmation\n- **WHEN** a user chooses an option\n- **THEN** the planner receives that exact reply.\n";
const SOLUTION = JSON.stringify({
	candidates: [
		{
			id: "small",
			title: "Simple file flow",
			content: "Retain full documents, including this final detail: Ω.\nNo summary is allowed.",
		},
		{ id: "alternative", title: "Another implementation", content: "A second complete approach." },
	],
});
const PLAN =
	"# Implementation Plan\n\n## Tasks\n1. Implement file-backed transitions in orchestrator.ts.\n2. Add consumer-visible file gate tests.\n\n## Validation\nRun the targeted orchestrator tests and inspect file handoffs.\n";
const REPORT =
	"# 完成报告\n\n## 完成情况\nImplemented the four file stages.\n\n## 验证结果\nCommand: not run. Status: not executed. Result: no software validation claimed. Limitation: this report fixture tests only the workflow.\n\n## 未完成项\n无。\n";
async function fixture() {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "spec-file-core-"));
	roots.push(cwd);
	const requirementsDir = "requirements";
	await fs.mkdir(path.join(cwd, requirementsDir), { recursive: true });
	await fs.writeFile(path.join(cwd, requirementsDir, "workflow.md"), REQUIREMENTS);
	const store = new SpecArtifactStore({ cwd, changeId: "file-workflow", requirementsDir });
	const inputs: SpecAgentInput[] = [];
	const omitted = new Set<SpecStageRole>();
	const contents: Record<SpecStageRole, string> = {
		requirements: REQUIREMENTS,
		solution: SOLUTION,
		planner: PLAN,
		executor: REPORT,
	};
	let beforeRun: ((input: SpecAgentInput, context: SpecRunContext) => Promise<void>) | undefined;
	let closeCalls = 0;
	const ports: SpecDrivenPorts = {
		agents: {
			recipient: role => ({ role, actorId: `actor-${role}`, sessionId: `session-${role}` }),
			async run(input, context) {
				inputs.push(structuredClone(input));
				await beforeRun?.(input, context);
				if (!input.readOnly && !omitted.has(input.role))
					for (const file of input.outputPaths) {
						const target = path.resolve(cwd, file.replace("*", "workflow"));
						await fs.mkdir(path.dirname(target), { recursive: true });
						const content = contents[input.role];
						await fs.writeFile(
							target,
							input.role !== "requirements" || !content
								? content
								: file.endsWith("/proposal.md")
									? PROPOSAL
									: file.endsWith("/spec.md")
										? DELTA
										: content,
						);
					}
				return { text: "请查看文件；此回复不是 JSON，也不是阶段完成凭据。" };
			},
		},
		artifacts: {
			initialize: () => store.initialize(),
			readRequirements: () => store.readRequirements(),
			readSolution: () => store.readSolution(),
			readPlan: () => store.readPlan(),
			readReport: () => store.readReport(),
			async close() {
				closeCalls++;
				return { archivedChangePath: "archive/file-workflow" };
			},
		},
	};
	const orchestrator = new SpecDrivenOrchestrator(ports, { currentModel: "test-model", runId: "test-run" });
	return {
		cwd,
		orchestrator,
		store,
		inputs,
		omitted,
		contents,
		closeCalls: () => closeCalls,
		beforeRun: (callback: typeof beforeRun) => {
			beforeRun = callback;
		},
	};
}
async function reachPlan(f: { orchestrator: SpecDrivenOrchestrator }) {
	await f.orchestrator.start("Implement the file workflow", "file-workflow");
	await f.orchestrator.confirmSpecification("需求原文确认");
	await f.orchestrator.chooseCandidate("small", " 选择 small；保留 Ω 和所有原文，不要总结。\n这是原始第二行。 \n");
}
async function reachAcceptance(f: { orchestrator: SpecDrivenOrchestrator }) {
	await reachPlan(f);
	await f.orchestrator.confirmPlan("按这个完整计划执行");
}

describe("four-stage file workflow", () => {
	it("runs only four actors and gives the planner complete files and the exact user selection", async () => {
		const f = await fixture();
		await reachAcceptance(f);
		expect(f.inputs.map(input => input.role)).toEqual(["requirements", "solution", "planner", "executor"]);
		expect(f.orchestrator.status().phase).toBe("awaiting-acceptance");
		expect(f.closeCalls()).toBe(0);
		const planner = f.inputs[2]!;
		expect(planner.files.map(file => file.content)).toEqual([PROPOSAL, DELTA, REQUIREMENTS, SOLUTION]);
		expect(planner.userReply).toBe(" 选择 small；保留 Ω 和所有原文，不要总结。\n这是原始第二行。 \n");
		expect(planner.candidateId).toBe("small");
		expect(f.inputs[1]!.userReply).toBe("需求原文确认");
		const executor = f.inputs[3]!;
		expect(executor.files.map(file => file.content)).toEqual([PROPOSAL, DELTA, REQUIREMENTS, SOLUTION, PLAN]);
		expect(executor.userReply).toBe("按这个完整计划执行");
		const paths = f.orchestrator.status().paths!;
		expect(path.dirname(paths.solution)).toBe(path.dirname(paths.plan));
		expect(path.dirname(paths.report)).toBe(path.dirname(paths.plan));
		const executionFiles = await fs.readdir(path.dirname(path.resolve(f.cwd, paths.plan)));
		expect(executionFiles.sort()).toEqual(
			[paths.solution, paths.plan, paths.report].map(file => path.basename(file)).sort(),
		);
		const generated = await fs.readdir(f.cwd, { recursive: true });
		expect(generated.some(file => /handoff|confirmation|state\.json/i.test(file))).toBe(false);
		await f.orchestrator.accept("验收通过");
		expect(f.closeCalls()).toBe(1);
		expect(f.orchestrator.status().phase).toBe("completed");
	});

	it("keeps an invalid requirements file at the requirements stage until the user continues", async () => {
		const f = await fixture();
		f.contents.requirements = "";
		await f.orchestrator.start("Request", "file-workflow");
		expect(f.orchestrator.status().phase).toBe("requirements");
		expect(f.orchestrator.status().blockedReason).toBeTruthy();
		await expect(f.orchestrator.confirmSpecification()).rejects.toBeInstanceOf(SpecAdmissionError);
		expect(f.inputs.map(input => input.role)).toEqual(["requirements"]);
		f.contents.requirements = REQUIREMENTS;
		await f.orchestrator.answer("补齐原始权威需求文件");
		expect(f.orchestrator.status().phase).toBe("awaiting-specification");
		expect(f.inputs.map(input => input.role)).toEqual(["requirements", "requirements"]);
	});

	it("does not use fluent agent text as a substitute for a missing output file", async () => {
		const f = await fixture();
		f.omitted.add("solution");
		await f.orchestrator.start("Request", "file-workflow");
		const blocked = await f.orchestrator.confirmSpecification();
		expect(blocked.phase).toBe("solution");
		expect(blocked.blockedReason).toBeTruthy();
		await expect(f.orchestrator.chooseCandidate("small", "选择 small")).rejects.toBeInstanceOf(SpecAdmissionError);
		expect(f.inputs.some(input => input.role === "planner")).toBe(false);
		f.omitted.delete("solution");
		await f.orchestrator.answer("请补齐方案文件");
		expect(f.orchestrator.status().phase).toBe("awaiting-choice");
		expect(f.inputs.map(input => input.role)).toEqual(["requirements", "solution", "solution"]);
	});

	it("rejects malformed candidates and never automatically retries the agent", async () => {
		const f = await fixture();
		f.contents.solution = JSON.stringify({
			candidates: [
				{ id: "same", title: "One", content: "A" },
				{ id: "same", title: "Two", content: "B" },
			],
		});
		await f.orchestrator.start("Request", "file-workflow");
		await f.orchestrator.confirmSpecification();
		expect(f.orchestrator.status().phase).toBe("solution");
		expect(f.orchestrator.status().blockedReason).toBeTruthy();
		expect(f.inputs.length).toBe(2);
		f.contents.solution = SOLUTION;
		await f.orchestrator.resume();
		expect(f.orchestrator.status().phase).toBe("awaiting-choice");
	});

	it("requires real plan and report contents before exposing their decisions", async () => {
		const f = await fixture();
		f.contents.planner = "";
		await reachPlan(f);
		expect(f.orchestrator.status().phase).toBe("planning");
		await expect(f.orchestrator.confirmPlan()).rejects.toBeInstanceOf(SpecAdmissionError);
		f.contents.planner = PLAN;
		await f.orchestrator.answer("写出完整计划");
		f.contents.executor = "# Report\nEverything passed!";
		await f.orchestrator.confirmPlan();
		expect(f.orchestrator.status().phase).toBe("executing");
		await expect(f.orchestrator.accept()).rejects.toBeInstanceOf(SpecAdmissionError);
		expect(f.closeCalls()).toBe(0);
		f.contents.executor = REPORT;
		await f.orchestrator.answer("补齐完成、验证和剩余事项章节");
		expect(f.orchestrator.status().phase).toBe("awaiting-acceptance");
	});

	it("rejects changed upstream bytes and asks for a new confirmation", async () => {
		const f = await fixture();
		await reachPlan(f);
		const state = f.orchestrator.status();
		await fs.writeFile(
			path.resolve(f.cwd, state.solution!.path),
			SOLUTION.replace("Simple file flow", "Changed option"),
		);
		await expect(f.orchestrator.confirmPlan()).rejects.toBeInstanceOf(SpecAdmissionError);
		expect(f.orchestrator.status().phase).toBe("awaiting-choice");
		expect(f.orchestrator.status().selection).toBeUndefined();
		expect(f.orchestrator.status().plan).toBeUndefined();
		expect(f.inputs.some(input => input.role === "executor")).toBe(false);
		await f.orchestrator.chooseCandidate("small", "重新确认修改后的完整方案");
		expect(f.inputs.at(-1)?.userReply).toBe("重新确认修改后的完整方案");
	});

	it("revision and repair reuse their fixed actors without archiving", async () => {
		const f = await fixture();
		await reachPlan(f);
		await f.orchestrator.revisePlan("减少一项实现工作");
		expect(f.inputs.at(-1)?.role).toBe("planner");
		expect(f.inputs.at(-1)?.feedback).toBe("减少一项实现工作");
		await f.orchestrator.confirmPlan("按计划执行", { useGoal: true });
		await f.orchestrator.repair("修复实际使用中的缺陷");
		expect(f.inputs.at(-1)?.role).toBe("executor");
		expect(f.inputs.at(-1)?.readOnly).toBe(false);
		expect(f.orchestrator.status().phase).toBe("awaiting-acceptance");
		expect(f.orchestrator.status().useGoal).toBe(true);
		await f.orchestrator.revisePlan("调整计划后重新选择执行方式");
		expect(f.orchestrator.status().useGoal).toBeUndefined();
		await f.orchestrator.confirmPlan();
		expect(f.orchestrator.status().useGoal).toBe(false);
		expect(f.closeCalls()).toBe(0);
	});

	it("acceptance conversation is read-only and cannot close the change", async () => {
		const f = await fixture();
		await reachAcceptance(f);
		const reply = await f.orchestrator.converse({
			text: "说明报告中的验证",
			messageId: "question-1",
			recipient: f.orchestrator.recipient()!,
			signal: new AbortController().signal,
		});
		expect(reply.text).toContain("不是 JSON");
		expect(f.inputs.at(-1)?.readOnly).toBe(true);
		expect(f.inputs.at(-1)?.files.at(-1)?.content).toBe(REPORT);
		expect(f.closeCalls()).toBe(0);
		expect(f.orchestrator.status().phase).toBe("awaiting-acceptance");
	});

	it("changed completion report needs another explicit acceptance", async () => {
		const f = await fixture();
		await reachAcceptance(f);
		await fs.appendFile(
			path.resolve(f.cwd, f.orchestrator.status().report!.path),
			"\nAdditional remaining work disclosed.\n",
		);
		await expect(f.orchestrator.accept()).rejects.toBeInstanceOf(SpecAdmissionError);
		expect(f.closeCalls()).toBe(0);
		expect(f.orchestrator.status().phase).toBe("awaiting-acceptance");
		await f.orchestrator.accept();
		expect(f.closeCalls()).toBe(1);
	});

	it("cancel waits for native mutation settlement and discards its late reply", async () => {
		const f = await fixture();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		f.beforeRun(async () => {
			entered.resolve();
			await release.promise;
		});
		const running = f.orchestrator.start("Request", "file-workflow");
		const outcome = running.then(
			() => undefined,
			error => error,
		);
		await entered.promise;
		let settled = false;
		const cancelling = f.orchestrator.cancel().then(status => {
			settled = true;
			return status;
		});
		try {
			await Promise.resolve();
			expect(settled).toBe(false);
			await expect(f.orchestrator.resume()).rejects.toBeInstanceOf(SpecAdmissionError);
		} finally {
			release.resolve();
		}
		expect(await outcome).toBeInstanceOf(StaleRun);
		expect((await cancelling).phase).toBe("cancelled");
		expect(f.orchestrator.status().lastReply).toBeUndefined();
		expect(f.closeCalls()).toBe(0);
	});

	it("pause waits for actual agent mutation settlement before resume", async () => {
		const f = await fixture();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		f.beforeRun(async () => {
			entered.resolve();
			await release.promise;
		});
		const running = f.orchestrator.start("Request", "file-workflow");
		const outcome = running.then(
			() => undefined,
			error => error,
		);
		await entered.promise;
		let settled = false;
		const pausing = f.orchestrator.pause().then(status => {
			settled = true;
			return status;
		});
		try {
			await Promise.resolve();
			expect(settled).toBe(false);
			await expect(f.orchestrator.resume()).rejects.toBeInstanceOf(SpecAdmissionError);
		} finally {
			release.resolve();
		}
		expect(await outcome).toBeInstanceOf(StaleRun);
		expect((await pausing).paused).toBe(true);
		expect(f.orchestrator.status().lastReply).toBeUndefined();
		f.beforeRun(undefined);
		await f.orchestrator.resume();
		expect(f.orchestrator.status().phase).toBe("awaiting-specification");
	});

	it("a cancelled conversation rejects even when its provider returns normally", async () => {
		const f = await fixture();
		await reachAcceptance(f);
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		f.beforeRun(async () => {
			entered.resolve();
			await release.promise;
		});
		const abort = new AbortController();
		const pending = f.orchestrator.converse({
			text: "说明验证",
			messageId: "cancelled-message",
			recipient: f.orchestrator.recipient()!,
			signal: abort.signal,
		});
		const outcome = pending.then(
			() => undefined,
			error => error,
		);
		try {
			await entered.promise;
			abort.abort();
		} finally {
			release.resolve();
		}
		expect(await outcome).toBeInstanceOf(StaleRun);
		expect(f.closeCalls()).toBe(0);
		expect(f.orchestrator.status().phase).toBe("awaiting-acceptance");
	});
});
