import { describe, expect, it } from "bun:test";
import { AsyncJobManager } from "../../src/async/job-manager";
import {
	getSpecDrivenController,
	renderSpecDrivenStatus,
	type SpecRuntimeFactory,
} from "../../src/spec-driven/controller";
import { checkSkillInvocation } from "../../src/spec-driven/skill-policy";
import type { SpecDrivenPorts, SpecRequirementsDraft } from "../../src/spec-driven/types";
import {
	BUILTIN_SLASH_COMMANDS_INTERNAL,
	BUILTIN_SLASH_COMMAND_DEFS,
	BUILTIN_SLASH_COMMANDS,
} from "../../src/slash-commands/builtin-registry";
import type { SlashCommandRuntime } from "../../src/slash-commands/types";

function fixture(manager = new AsyncJobManager({}), options: { hold?: Promise<void>; noCandidates?: boolean } = {}) {
	const output: string[] = [];
	const entered = Promise.withResolvers<void>();
	const transcript: string[] = [];
	const requests: string[] = [];
	const calls: string[] = [];
	let disposed = 0;
	let specificationVersion = "";
	const draft: SpecRequirementsDraft = {
		proposal: "用户应能查看结果",
		specs: [{ path: "result/spec.md", content: "### Requirement: 查看结果\n#### Scenario: 成功\n展示真实结果" }],
		requirements: [{ id: "R1", text: "展示结果" }],
		questions: [],
	};
	const unexpected = async (): Promise<never> => {
		throw new Error("Implementation must not be dispatched by a missing or stale approval");
	};
	const ports: SpecDrivenPorts = {
		artifacts: {
			async initialize() {},
			async writeRequirements() {
				specificationVersion = "spec-v1";
				return { version: specificationVersion };
			},
			async readRequirements() {
				return { version: specificationVersion };
			},
			async validateRequirements() {},
			async writePlan() {
				return { version: "plan-file-v1" };
			},
			async readPlan() {
				return { version: "plan-file-v1" };
			},
			close: unexpected,
		},
		models: {
			async requirements(input) {
				requests.push(input.request);
				entered.resolve();
				await options.hold;
				return draft;
			},
			async review() {
				return {
					verdict: "pass",
					summary: "独立审查通过",
					findings: [],
					resolutions: [],
					questions: [],
					evidenceChecks: [],
				};
			},
			async plan() {
				calls.push("plan");
				return {
					content: "# 唯一计划\n写入结果说明并核对入口。",
					tasks: [
						{
							id: "T001",
							title: "说明",
							instructions: "更新结果说明",
							requirementIds: ["R1"],
							dependencies: [],
							conditionIds: [],
							ownedPaths: ["result.txt"],
							implementationPaths: [],
							solutionBinding: "result-contract",
							validation: [{ id: "result", command: "check-result", behavior: "查看结果" }],
							tdd: { mode: "exception", reason: "纯文档", alternativeCommands: ["check-result"] },
						},
					],
					conditions: [],
					finalValidation: [{ id: "entry", command: "public-entry", behavior: "查看结果", realEntry: true }],
					closure: { sync: false, archive: false },
				};
			},
			execute: unexpected,
		},
		team: {
			async run(input) {
				calls.push("team");
				return {
					runId: "discussion-v1",
					inputVersion: input.specification.version,
					status: "completed",
					report: "真实候选的审查报告",
					candidates: options.noCandidates
						? []
						: [
								{
									id: "A",
									label: "候选 A",
									version: "candidate-v1",
									proposal: "使用现有结果入口",
									adoptable: true,
									reviewSucceeded: true,
									recheckSucceeded: true,
									unresolvedBlocking: [],
									conditions: [],
								},
							],
					interpretationDifferences: [],
				};
			},
		},
		git: { preflight: unexpected, commit: unexpected },
		evidence: { read: unexpected },
		validation: { run: unexpected },
	};
	const sessionManager = {};
	const disposers: Array<() => void> = [];
	const session = {
		asyncJobManager: manager,
		sessionGeneration: 0,
		isDisposed: false,
		getAgentId: () => "owner",
		addDisposer: (dispose: () => void) => {
			disposers.push(dispose);
		},
		registerSessionChangeCallback: () => () => {},
		appendCustomMessage: async (message: { content: string }) => {
			transcript.push(message.content);
		},
	};
	const host = {
		session,
		sessionManager,
		settings: {},
		cwd: "/fixture",
		output: (text: string) => {
			output.push(text);
		},
		refreshCommands() {},
		async reloadPlugins() {},
	} as unknown as SlashCommandRuntime;
	const factory: SpecRuntimeFactory = async () => ({
		ports,
		options: { currentModel: "author", members: ["author", "reviewer"] },
		async dispose() {
			disposed++;
		},
		measurement: () => ({
			task: "fixture",
			codeBaseline: "fixture",
			modelConfiguration: "fixture",
			acceptanceCriteria: "fixture",
			mode: "workflow",
			startedAt: 1,
			endedAt: 2,
			requests: [],
			observations: [],
			plannedDecisionWaitMs: null,
			executionWaitMs: null,
			assessmentComplete: false,
		}),
	});
	const controller = getSpecDrivenController(host, { factory });
	const command = BUILTIN_SLASH_COMMANDS_INTERNAL.find(item => item.name === "spec")!;
	const invoke = (args: string) => command.handle!({ name: "spec", args, text: `/spec ${args}` }, host);
	const settle = async () => {
		await Promise.all(manager.getRunningJobs().map(job => job.promise));
	};
	return {
		manager,
		host,
		session,
		controller,
		output,
		transcript,
		requests,
		calls,
		invoke,
		settle,
		entered: entered.promise,
		disposed: () => disposed,
		dispose: async () => {
			for (const disposer of disposers) disposer();
			await controller.dispose();
			await manager.dispose();
		},
	};
}

describe("/spec shared command surface", () => {
	it("is discovered once, has headless dispatch and provides native subcommand completion", async () => {
		expect(BUILTIN_SLASH_COMMANDS_INTERNAL.filter(item => item.name === "spec")).toHaveLength(1);
		expect(BUILTIN_SLASH_COMMAND_DEFS.find(item => item.name === "spec")?.allowArgs).toBe(true);
		const completion = await BUILTIN_SLASH_COMMANDS.find(item => item.name === "spec")?.getArgumentCompletions?.(
			"confirm-",
		);
		expect(completion?.map(item => item.value)).toContain("confirm-plan ");
		const f = fixture();
		try {
			await f.invoke("status");
			expect(f.output.join("\n")).toContain('"phase":"idle"');
		} finally {
			await f.dispose();
		}
	});

	it("preserves full request, exposes decision material and refuses missing/stale approvals", async () => {
		const f = fixture();
		try {
			await f.invoke("start result-change  保留  空白\n第二行需求");
			await f.settle();
			expect(f.requests).toEqual(["保留  空白\n第二行需求"]);
			expect(f.output.join("\n")).toContain("展示真实结果");
			await f.invoke("pause");
			await f.invoke("resume");
			await f.settle();
			expect(f.controller.status().phase).toBe("awaiting-specification");
			expect(f.requests).toHaveLength(1);
			expect(f.output.join("\n")).toContain("/spec confirm-spec spec-v1");
			await f.invoke("confirm-spec");
			await f.invoke("confirm-spec old");
			await f.settle();
			expect(f.calls).not.toContain("team");
			await f.invoke("confirm-spec spec-v1");
			await f.settle();
			expect(f.controller.status().phase).toBe("awaiting-choice");
			expect(f.output.join("\n")).toContain("使用现有结果入口");
			await f.invoke("choose discussion-v1 A old");
			await f.settle();
			expect(f.calls).not.toContain("plan");
			await f.invoke("choose discussion-v1 A candidate-v1");
			await f.settle();
			const state = f.controller.status();
			expect(state.phase).toBe("awaiting-plan");
			expect(state.plan?.version).not.toBe(state.plan?.artifactVersion);
			expect(f.output.join("\n")).toContain(`/spec confirm-plan ${state.plan!.version}`);
			expect(f.output.join("\n")).toContain("本地 commit");
			await f.invoke("confirm-plan plan-file-v1");
			await f.settle();
			expect(f.controller.status().phase).toBe("awaiting-plan");
			expect(f.transcript.some(text => text.includes("唯一计划"))).toBe(true);
		} finally {
			await f.dispose();
		}
	});

	it("admits stop/status immediately during a provider wait and isolates shared-manager jobs", async () => {
		const gate = Promise.withResolvers<void>();
		const manager = new AsyncJobManager({});
		const first = fixture(manager, { hold: gate.promise });
		const second = fixture(manager);
		try {
			await first.invoke("start waiting request");
			await first.entered;
			await second.invoke("start independent request");
			await first.invoke("pause");
			await first.invoke("status");
			expect(first.controller.status().paused).toBe(true);
			expect(() => checkSkillInvocation({ name: "writing-plans" }, { scope: first.host.sessionManager })).toThrow(
				"not allowed",
			);
			await first.invoke("cancel");
			expect(first.controller.status().phase).toBe("cancelled");
			gate.resolve();
			await first.settle();
			expect(second.controller.status().phase).toBe("awaiting-specification");
			expect(second.controller.status().paused).toBe(false);
			expect(first.output.at(-1)).not.toContain('"phase":"awaiting-specification"');
			expect(first.disposed()).toBe(1);
			await first.invoke("status");
			expect(first.output.at(-1)).toContain('"phase":"cancelled"');
		} finally {
			gate.resolve();
			await first.dispose();
			await second.dispose();
		}
	});

	it("does not authorize a plan from a completed Team run with zero eligible candidates", async () => {
		const f = fixture(undefined, { noCandidates: true });
		try {
			await f.invoke("start zero request");
			await f.settle();
			await f.invoke("confirm-spec spec-v1");
			await f.settle();
			await f.invoke("choose discussion-v1 A candidate-v1");
			await f.settle();
			expect(f.calls).not.toContain("plan");
			expect(f.controller.status().paused).toBe(true);
			expect(f.output.join("\n")).toContain("/spec resume");
		} finally {
			await f.dispose();
		}
	});

	it("renders exact final acceptance identity without claiming unknown quality or costs", () => {
		const text = renderSpecDrivenStatus({
			phase: "awaiting-acceptance",
			paused: false,
			generation: 1,
			acceptanceVersion: "accept-v2",
			questions: [],
			tasks: [],
			reviews: [],
			pendingClosure: [],
		});
		expect(text).toContain('"phase":"awaiting-acceptance"');
		expect(text).toContain("/spec accept accept-v2");
	});
});
