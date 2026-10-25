import { describe, expect, it, vi } from "bun:test";
import { AsyncJobManager } from "../../src/async/job-manager";
import {
	getSpecDrivenController,
	observeSpecDrivenController,
	type SpecControllerObservation,
	peekSpecDrivenController,
	renderSpecDrivenStatus,
	type SpecRuntimeFactory,
} from "../../src/spec-driven/controller";
import { checkSkillInvocation } from "../../src/spec-driven/skill-policy";
import type { SpecDrivenPorts, SpecRequirementsDraft, SpecToolRecord } from "../../src/spec-driven/types";
import {
	BUILTIN_SLASH_COMMANDS_INTERNAL,
	BUILTIN_SLASH_COMMAND_DEFS,
	BUILTIN_SLASH_COMMANDS,
} from "../../src/slash-commands/builtin-registry";
import type { SlashCommandRuntime } from "../../src/slash-commands/types";

function fixture(
	manager = new AsyncJobManager({}),
	options: {
		hold?: Promise<void>;
		noCandidates?: boolean;
		sessionManager?: object;
		runId?: string;
		initFailures?: number;
		ui?: NonNullable<SlashCommandRuntime["ui"]> & {
			editor?: (
				title: string,
				prefill?: string,
				dialogOptions?: { signal?: AbortSignal },
			) => Promise<string | undefined>;
		};
	} = {},
) {
	const output: string[] = [];
	const entered = Promise.withResolvers<void>();
	const transcript: string[] = [];
	const requests: string[] = [];
	const calls: string[] = [];
	const executionModes: string[] = [];
	let disposed = 0;
	let specificationVersion = "";
	const draft: SpecRequirementsDraft = {
		proposal: "用户应能查看结果",
		specs: [
			{ path: "specs/result/spec.md", content: "### Requirement: 查看结果\n#### Scenario: 成功\n展示真实结果" },
		],
		requirements: [{ id: "R1", text: "展示结果" }],
		questions: [],
	};
	const unexpected = async (): Promise<never> => {
		throw new Error("Implementation must not be dispatched by a missing or stale approval");
	};
	const ports: SpecDrivenPorts = {
		conversation: {
			recipient: role => ({ role, actorId: `fixture-${role}`, sessionId: `fixture-session-${role}` }),
			async respond(input) {
				return { text: `Reply: ${input.text}` };
			},
		},
		async handoff(input, context) {
			calls.push(`handoff:${input.transition}`);
			const role =
				input.transition === "requirements-to-solution"
					? "requirements"
					: input.transition === "solution-to-plan"
						? "solution"
						: "planner";
			const body = `Detached command-fixture native boundary: ${input.transition}`;
			return {
				actorId: `fixture-${role}`,
				sessionId: `fixture-session-${role}`,
				role,
				runId: context.runId,
				generation: context.generation,
				transition: input.transition,
				path: `handoffs/${input.transition}.md`,
				digest: new Bun.CryptoHasher("sha256").update(body).digest("hex"),
				body,
				versions: {
					"proposal.md": input.specification.version,
					...(input.solution ? { "state.json#/solution": input.solution.artifactVersion } : {}),
					...(input.plan ? { "plan.md": input.plan.artifactVersion } : {}),
				},
			};
		},
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
			async writeSolution() {
				return { version: "solution-file-v1" };
			},
			async readSolution() {
				return { version: "solution-file-v1" };
			},
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
					workspace: { executionPath: ".", isolation: "native", integration: "native" },
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
							validation: [
								{ id: "result", command: "check-result", behavior: "查看结果", inputPaths: ["result.txt"] },
							],
							tdd: { mode: "exception", reason: "纯文档", alternativeCommands: ["check-result"] },
						},
					],
					conditions: [],
					finalValidation: [
						{
							id: "entry",
							command: "public-entry",
							behavior: "查看结果",
							inputPaths: ["result.txt"],
							realEntry: true,
						},
					],
					closure: { sync: false, archive: false },
				};
			},
			async execute(input) {
				executionModes.push(input.mode);
				throw new Error("Fixture stops after observing whole-stage execution admission");
			},
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
		git: { async preflight() {}, commit: unexpected },
		evidence: {
			read: unexpected,
			async revalidate() {
				return { taskIds: [], reasons: [], overall: false };
			},
			async flush() {},
		},
		validation: { run: unexpected },
	};
	const sessionManager = options.sessionManager ?? {};
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
		ui: options.ui,
		output: (text: string) => {
			output.push(text);
		},
		refreshCommands() {},
		async reloadPlugins() {},
	} as unknown as SlashCommandRuntime;
	let initFailures = options.initFailures ?? 0;
	const factory: SpecRuntimeFactory = async () => {
		if (initFailures > 0) {
			initFailures--;
			throw new Error("fixture initialization failed");
		}
		return {
			ports,
			options: { currentModel: "author", members: ["author", "reviewer"], runId: options.runId },
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
		};
	};
	const controller = getSpecDrivenController(host, { factory });
	const command = BUILTIN_SLASH_COMMANDS_INTERNAL.find(item => item.name === "dev")!;
	const invoke = (args: string) => command.handle!({ name: "dev", args, text: `/dev ${args}` }, host);
	const settle = async () => {
		await Promise.all(manager.getRunningJobs().map(job => job.promise));
	};
	return {
		manager,
		host,
		session,
		controller,
		factory,
		ports,
		draft,
		settleMessage: (id: string) => {
			const { promise, resolve } = Promise.withResolvers<void>();
			let stop = () => {};
			stop = observeSpecDrivenController(sessionManager, observation => {
				const message = observation.interaction.messages.find(item => item.id === id);
				if (message && ["completed", "cancelled", "failed"].includes(message.status)) {
					queueMicrotask(() => {
						stop();
						resolve();
					});
				}
			});
			return promise;
		},
		output,
		transcript,
		requests,
		calls,
		executionModes,
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

describe("/dev shared command surface", () => {
	it("queues input after repair admission and drains it only after the same executor finishes repair", async () => {
		const f = fixture();
		const records = new Map<string, SpecToolRecord>();
		const scopeEntered = Promise.withResolvers<void>();
		const releaseScope = Promise.withResolvers<void>();
		let executions = 0;
		let replies = 0;
		f.ports.models.execute = async (_input, _context, control) => {
			executions++;
			expect(replies).toBe(0);
			await control.start("T001");
			await control.checkpoint("T001", {
				changedPaths: [],
				recordIds: [],
				redRecordId: null,
				greenRecordId: null,
				implementationStartedAt: null,
				requestedTddException: null,
			});
		};
		f.ports.validation.run = async (input, context) => {
			const state = f.controller.status();
			const id = `validation-${records.size + 1}`;
			const binding = {
				actorId: "fixture-executor",
				taskId: input.purpose === "task" ? "T001" : null,
				workspace: "/fixture",
				specificationVersion: state.specification!.version,
				planVersion: state.plan!.version,
			};
			const inputs = {
				id: `inputs-${id}`,
				runId: context.runId,
				generation: context.generation,
				binding,
				inputPaths: ["result.txt"],
				entries: [
					{
						path: "result.txt",
						canonicalPath: "/fixture/result.txt",
						kind: "file" as const,
						digest: "fixture-result",
					},
				],
				version: "fixture-result",
				complete: true,
			};
			records.set(id, {
				id,
				toolCallId: `call-${id}`,
				runId: context.runId,
				generation: context.generation,
				tool: "spec_verify",
				args: { command: input.command, cwd: "/fixture" },
				startedAt: 1,
				finishedAt: 2,
				binding,
				inputsBefore: inputs,
				inputsAfter: structuredClone(inputs),
				conditions: { platform: process.platform, shell: "fixture", runtime: "fixture", runtimeVersion: "1" },
				obligation: { validationId: input.id, approvedCommand: input.command, reason: null },
				result: {
					status: "completed",
					exitCode: 0,
					stdout: "Approved result verified",
					stderr: "",
					isError: false,
				},
				artifact: { path: `/fixture/evidence/${id}`, version: id },
			});
			return id;
		};
		f.ports.evidence.read = async ids => ids.map(id => structuredClone(records.get(id)!));
		f.ports.conversation!.respond = async input => {
			replies++;
			expect(executions).toBe(2);
			expect(f.controller.status().phase).toBe("awaiting-acceptance");
			expect(f.controller.observation().active).toBe(false);
			return { text: input.text };
		};
		f.ports.conversation!.repairScope = async () => {
			scopeEntered.resolve();
			await releaseScope.promise;
			return ["T001"];
		};
		try {
			await f.invoke("start repair-race request");
			await f.settle();
			await f.invoke("confirm-spec spec-v1");
			await f.settle();
			await f.invoke("choose discussion-v1 A candidate-v1");
			await f.settle();
			await f.invoke(`confirm-plan ${f.controller.status().plan!.version}`);
			await f.settle();
			const old = f.controller.status().acceptanceVersion!;
			expect(old).toBeTruthy();
			f.controller.repair(old, "Repair the approved result");
			const beforeScope = await f.controller.submitText("Question queued immediately after admission");
			if (beforeScope.kind !== "queued") throw new Error("Expected post-admission queued input");
			await scopeEntered.promise;
			expect(f.controller.status().acceptanceVersion).toBeUndefined();
			const duringScope = await f.controller.submitText("Question queued during scope analysis");
			if (duringScope.kind !== "queued") throw new Error("Expected busy-stage queued input");
			const queued = f.controller.observation().interaction.messages;
			expect(queued).toHaveLength(2);
			expect(queued.map(message => message.status)).toEqual(["queued", "queued"]);
			expect(queued.map(message => [message.role, message.actorId, message.sessionId])).toEqual([
				["executor", "fixture-executor", "fixture-session-executor"],
				["executor", "fixture-executor", "fixture-session-executor"],
			]);
			expect(replies).toBe(0);
			expect(executions).toBe(1);
			releaseScope.resolve();
			await f.settle();
			await f.settleMessage(duringScope.messageId);
			const repaired = f.controller.status();
			expect(repaired.phase).toBe("awaiting-acceptance");
			expect(repaired.paused).toBe(false);
			expect(repaired.acceptanceVersion).toBeTruthy();
			expect(repaired.acceptanceVersion).not.toBe(old);
			expect(executions).toBe(2);
			expect(replies).toBe(2);
			expect(f.controller.observation().interaction.messages.map(message => message.status)).toEqual([
				"completed",
				"completed",
			]);
			expect(f.controller.observation().interaction.draft).toBe("");
			expect(f.controller.actions().find(action => action.id === "accept")?.available).toBe(true);
			expect(f.controller.actions().find(action => action.id === "repair")?.available).toBe(true);
			await f.invoke(`accept ${old}`);
			await f.settle();
			expect(f.controller.status().phase).toBe("awaiting-acceptance");
			expect(f.controller.status().finalApproval).toBeUndefined();
			expect(f.controller.status().acceptanceVersion).toBe(repaired.acceptanceVersion);
		} finally {
			releaseScope.resolve();
			await f.dispose();
		}
	});

	it("observes without implicit creation, replays state, isolates listeners and follows replacement runs", async () => {
		const sessionManager = {};
		const seen: SpecControllerObservation[] = [];
		const stop = observeSpecDrivenController(sessionManager, observation => seen.push(observation));
		expect(seen).toEqual([]);
		const hold = Promise.withResolvers<void>();
		const f = fixture(undefined, { sessionManager, hold: hold.promise, runId: "native-run-first" });
		const stopBroken = observeSpecDrivenController(sessionManager, observation => {
			observation.status.phase = "cancelled";
			throw new Error("Observer failure is not a workflow failure");
		});
		let unrelated = 0;
		const stopUnrelated = observeSpecDrivenController({}, () => unrelated++);
		try {
			expect(seen.at(-1)).toMatchObject({ runId: null, active: false, disposed: false });
			expect(f.requests).toEqual([]);
			expect(f.controller.status().phase).toBe("idle");
			await f.invoke("start first-change request");
			await f.entered;
			expect(seen.at(-1)).toMatchObject({
				runId: "native-run-first",
				cwd: "/fixture",
				active: true,
				status: { phase: "requirements" },
			});
			const replay: SpecControllerObservation[] = [];
			const stopReplay = observeSpecDrivenController(sessionManager, observation => replay.push(observation));
			expect(replay).toHaveLength(1);
			expect(replay[0]).toEqual(f.controller.observation());
			stopReplay();
			hold.resolve();
			await f.settle();
			expect(seen.at(-1)).toMatchObject({ active: false, status: { phase: "awaiting-specification" } });
			await f.invoke("confirm-spec spec-v1");
			await f.settle();
			expect(seen.at(-1)?.runId).toBe("native-run-first");
			expect(seen.at(-1)?.status.team?.runId).toBe("discussion-v1");
			await f.invoke("pause");
			expect(seen.at(-1)).toMatchObject({ active: false, status: { paused: true } });
			await f.invoke("cancel");
			expect(seen.at(-1)).toMatchObject({ released: true, disposed: false, status: { phase: "cancelled" } });
			const first = seen.at(-1)!;
			const second = getSpecDrivenController(f.host, {
				restart: true,
				factory: async input => {
					const native = await f.factory(input);
					return { ...native, options: { ...native.options, runId: "native-run-second" } };
				},
			});
			expect(second).not.toBe(f.controller);
			expect(seen.at(-1)).toMatchObject({ runId: null, released: false, disposed: false });
			second.schedule(core => core.start("second request", "second-change"));
			await f.settle();
			expect(seen.at(-1)).toMatchObject({ runId: "native-run-second", active: false });
			expect(first.status.phase).toBe("cancelled");
			expect(first.updatedAt).toBeGreaterThanOrEqual(first.createdAt);
			await second.dispose();
			expect(seen.at(-1)).toMatchObject({ runId: "native-run-second", disposed: true, released: true });
			expect(unrelated).toBe(0);
			stop();
			const count = seen.length;
			getSpecDrivenController(f.host, { restart: true, factory: f.factory });
			expect(seen).toHaveLength(count);
			await getSpecDrivenController(f.host).dispose();
		} finally {
			hold.resolve();
			stop();
			stopBroken();
			stopUnrelated();
			await f.dispose();
		}
	});

	it("refuses independent OpenSpec maintenance while a strict workflow owns approvals, including pause", async () => {
		const f = fixture();
		const skill = { name: "opsx-sync" };
		const context = { scope: f.host.sessionManager };
		try {
			await f.invoke("start result-change 展示结果");
			await f.settle();
			expect(f.controller.status().phase).toBe("awaiting-specification");
			expect(() => checkSkillInvocation(skill, context)).toThrow("not allowed during");
			await f.invoke("pause");
			expect(() => checkSkillInvocation(skill, context)).toThrow("not allowed during");
			expect(f.controller.status().specification?.version).toBe("spec-v1");
			expect(f.controller.status().phase).toBe("awaiting-specification");
			expect(f.calls).not.toContain("plan");
			await f.invoke("cancel");
			expect(() => checkSkillInvocation(skill, context)).not.toThrow();
		} finally {
			await f.dispose();
		}
	});
	it("does not restrict ordinary skills when pausing an idle or released workflow", async () => {
		const f = fixture();
		const skill = { name: "systematic-debugging" };
		const context = { scope: f.host.sessionManager };
		try {
			await f.invoke("pause");
			expect(f.controller.status()).toMatchObject({ phase: "idle", paused: false });
			expect(() => checkSkillInvocation(skill, context)).not.toThrow();
			await f.invoke("start pause-policy request");
			await f.settle();
			await f.invoke("cancel");
			const cancelled = f.controller.status();
			await f.invoke("pause");
			expect(f.controller.status()).toEqual(cancelled);
			expect(() => checkSkillInvocation(skill, context)).not.toThrow();
		} finally {
			await f.dispose();
		}
	});

	it("is discovered once, has headless dispatch and provides native subcommand completion", async () => {
		expect(BUILTIN_SLASH_COMMANDS_INTERNAL.filter(item => item.name === "dev")).toHaveLength(1);
		expect(BUILTIN_SLASH_COMMANDS_INTERNAL.some(item => item.name === "spec")).toBe(false);
		expect(BUILTIN_SLASH_COMMAND_DEFS.find(item => item.name === "dev")?.allowArgs).toBe(true);
		const completion = await BUILTIN_SLASH_COMMANDS.find(item => item.name === "dev")?.getArgumentCompletions?.(
			"confirm-",
		);
		expect(completion?.map(item => item.value)).toContain("confirm-plan ");
		const f = fixture();
		try {
			await f.invoke("status");
			expect(f.controller.status().phase).toBe("idle");
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
			expect(f.controller.observation().status.specification?.specs[0]?.content).toContain("展示真实结果");
			await f.invoke("pause");
			await f.invoke("resume");
			await f.settle();
			expect(f.controller.status().phase).toBe("awaiting-specification");
			expect(f.requests).toHaveLength(1);
			expect(f.controller.actions()).toContainEqual(
				expect.objectContaining({ command: "/dev confirm-spec spec-v1", available: true }),
			);
			await f.invoke("confirm-spec");
			await f.invoke("confirm-spec old");
			await f.settle();
			expect(f.calls).not.toContain("team");
			await f.invoke("confirm-spec spec-v1");
			await f.settle();
			expect(f.controller.status().phase).toBe("awaiting-choice");
			expect(f.controller.observation().status.team?.candidates[0]?.proposal).toBe("使用现有结果入口");
			await f.invoke("choose discussion-v1 A old");
			await f.settle();
			expect(f.calls).not.toContain("plan");
			await f.invoke("choose discussion-v1 A candidate-v1");
			await f.settle();
			const state = f.controller.status();
			expect(state.phase).toBe("awaiting-plan");
			expect(state.plan?.version).not.toBe(state.plan?.artifactVersion);
			expect(f.controller.actions()).toContainEqual(
				expect.objectContaining({ command: `/dev confirm-plan ${state.plan!.version}`, available: true }),
			);
			expect(f.controller.actions()).toContainEqual(
				expect.objectContaining({ command: `/dev confirm-plan ${state.plan!.version} --goal`, available: true }),
			);
			await f.invoke("confirm-plan plan-file-v1");
			await f.settle();
			expect(f.controller.status().phase).toBe("awaiting-plan");
			expect(f.controller.status().handoffs?.map(handoff => handoff.transition)).toEqual([
				"requirements-to-solution",
				"solution-to-plan",
			]);
			expect(state.handoffs?.at(-1)?.path).toBe("handoffs/solution-to-plan.md");
			expect(state.handoffs?.at(-1)?.body).toBe("Detached command-fixture native boundary: solution-to-plan");
		} finally {
			await f.dispose();
		}
	});

	for (const mode of ["normal", "goal"] as const)
		it(`routes exact plan approval into ${mode} stage execution`, async () => {
			const f = fixture();
			try {
				await f.invoke("start execution-mode request");
				await f.settle();
				await f.invoke("confirm-spec spec-v1");
				await f.settle();
				await f.invoke("choose discussion-v1 A candidate-v1");
				await f.settle();
				const version = f.controller.status().plan!.version;
				const approval = await f.invoke(`confirm-plan ${version}${mode === "goal" ? " --goal" : ""}`);
				if (!approval || !("consumed" in approval))
					throw new Error("Expected plan approval to consume the command");
				expect(approval.failed).not.toBe(true);
				await f.settle();
				expect(f.executionModes).toEqual([mode]);
				expect(f.controller.status().executionMode).toBe(mode);
				expect(f.calls).toContain("handoff:plan-to-execution");
				expect(f.controller.status().tasks.every(task => task.status !== "completed")).toBe(true);
			} finally {
				await f.dispose();
			}
		});

	it("rejects unknown, repeated, misplaced and excess plan flags before dispatch", async () => {
		const f = fixture();
		try {
			await f.invoke("start reject-mode request");
			await f.settle();
			await f.invoke("confirm-spec spec-v1");
			await f.settle();
			await f.invoke("choose discussion-v1 A candidate-v1");
			await f.settle();
			const version = f.controller.status().plan!.version;
			for (const args of [
				"",
				`${version} --normal`,
				`${version} --unknown`,
				`--goal ${version}`,
				`${version} --goal --goal`,
				`${version} --goal extra`,
			]) {
				const result = await f.invoke(`confirm-plan ${args}`);
				if (!result || !("consumed" in result))
					throw new Error("Expected rejected plan flags to consume the command");
				expect(result.failed).toBe(true);
				expect(f.controller.status().phase).toBe("awaiting-plan");
				expect(f.controller.status().planApproval).toBeUndefined();
			}
			expect(f.executionModes).toEqual([]);
			expect(f.calls).not.toContain("handoff:plan-to-execution");
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
			expect(first.controller.status().phase).toBe("cancelled");
			expect(first.disposed()).toBe(1);
			await first.invoke("status");
			expect(first.controller.status().phase).toBe("cancelled");
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
			expect(f.controller.actions()).toContainEqual(
				expect.objectContaining({ command: "/dev resume", available: true }),
			);
		} finally {
			await f.dispose();
		}
	});

	it("keeps mode and draft session-local without preparing native actors", async () => {
		const f = fixture();
		const other = fixture();
		try {
			expect(peekSpecDrivenController({})).toBeUndefined();
			f.controller.setInputMode("dev");
			expect(await f.controller.submitText("draft request")).toEqual({ kind: "draft", text: "draft request" });
			expect(f.controller.observation().interaction.draft).toBe("draft request");
			expect(other.controller.inputMode()).toBe("chat");
			expect(other.controller.observation().interaction.draft).toBe("");
			expect(f.requests).toEqual([]);
			expect(f.manager.getRunningJobs()).toHaveLength(0);
			f.controller.setInputMode("chat");
			expect(f.controller.observation().interaction.draft).toBe("draft request");
		} finally {
			await f.dispose();
			await other.dispose();
		}
	});

	it("reports the Chinese stage and role without leaking internal actor ids", async () => {
		const f = fixture();
		try {
			await f.invoke("start label request");
			await f.settle();
			await f.controller.report();
			const text = f.transcript.at(-1)!;
			expect(text).toContain("需求 Agent");
			expect(text).toContain("协同开发模式：需求");
			expect(text).not.toContain("fixture-requirements");
			expect(text).not.toContain("fixture-session-requirements");
			await f.invoke("status");
			expect(f.transcript.at(-1)).toContain("阶段键：awaiting-specification");
		} finally {
			await f.dispose();
		}
	});

	it("publishes a transient heartbeat during a long requirements turn", async () => {
		const hold = Promise.withResolvers<void>();
		const f = fixture(undefined, { hold: hold.promise });
		vi.useFakeTimers();
		try {
			await f.invoke("start heartbeat request");
			await f.entered;
			const history = f.transcript.length;
			vi.advanceTimersByTime(15_000);
			await Promise.resolve();
			await Promise.resolve();
			expect(f.output.join("\n")).toContain("次请求");
			expect(f.transcript.length).toBe(history);
		} finally {
			hold.resolve();
			await f.dispose();
			vi.useRealTimers();
		}
	});

	it("uses the multiline editor for the start request body", async () => {
		const f = fixture(undefined, {
			ui: {
				select: async (_title, labels) =>
					labels.find((label): label is string => typeof label === "string" && label.includes("开始新流程")),
				confirm: async () => true,
				input: async title => (title.includes("change-id") ? "multiline-change" : undefined),
				editor: async () => "第一行需求\n第二行需求",
			},
		});
		try {
			await f.invoke("help");
			await f.settle();
			expect(f.requests.at(-1)).toBe("第一行需求\n第二行需求");
		} finally {
			await f.dispose();
		}
	});

	it("retries initialization after a failed factory instead of reusing the rejection", async () => {
		const f = fixture(undefined, { initFailures: 1 });
		try {
			await f.invoke("start retry-init request");
			await f.settle().catch(() => {});
			expect(f.controller.status().blockedReason).toContain("fixture initialization failed");
			await f.invoke("start retry-init request");
			await f.settle();
			expect(f.controller.status().phase).toBe("awaiting-specification");
		} finally {
			await f.dispose();
		}
	});

	it("keeps a processing message cancelling when the cancellation barrier itself fails", async () => {
		const f = fixture();
		const entered = Promise.withResolvers<void>();
		f.ports.conversation!.respond = async (_input, context) => {
			entered.resolve();
			const aborted = Promise.withResolvers<void>();
			context.signal.addEventListener("abort", () => aborted.resolve(), { once: true });
			await aborted.promise;
			throw new Error("barrier failed");
		};
		try {
			await f.invoke("start unconfirmed-cancel request");
			await f.settle();
			const receipt = await f.controller.submitText("cancel this message");
			if (receipt.kind !== "queued") throw new Error("Expected native queued receipt");
			await entered.promise;
			await f.controller.cancelMessage(receipt.messageId);
			const message = f.controller.observation().interaction.messages[0];
			expect(message?.status).toBe("cancelling");
			expect(message?.error).toContain("取消未确认");
		} finally {
			await f.dispose();
		}
	});

	it("cancels queued messages immediately but processing only after actual settlement, blocking transitions", async () => {
		const f = fixture();
		const entered = Promise.withResolvers<void>();
		const stopped = Promise.withResolvers<void>();
		const received: string[] = [];
		f.ports.conversation!.respond = async (input, context) => {
			received.push(input.messageId);
			entered.resolve();
			await stopped.promise;
			expect(context.signal.aborted).toBe(true);
			return { text: "late reply must not publish" };
		};
		try {
			await f.invoke("start queue-test request");
			await f.settle();
			const first = await f.controller.submitText("first");
			if (first.kind !== "queued") throw new Error("Expected native queued receipt");
			await entered.promise;
			const second = await f.controller.submitText("second");
			if (second.kind !== "queued") throw new Error("Expected queued second message");
			expect(() => f.controller.schedule(core => core.confirmSpecification("spec-v1"))).toThrow();
			await expect(f.controller.cancelMessage("wrong-owner-id")).rejects.toMatchObject({ code: "invalid_params" });
			await f.controller.cancelMessage(second.messageId);
			let cancellationSettled = false;
			const cancellation = f.controller.cancelMessage(first.messageId).then(() => {
				cancellationSettled = true;
			});
			await Promise.resolve();
			expect(cancellationSettled).toBe(false);
			expect(f.controller.observation().interaction.messages[0]?.status).toBe("cancelling");
			expect(f.controller.actions().find(action => action.id === "confirm-spec")?.available).toBe(false);
			expect(() => f.controller.schedule(core => core.confirmSpecification("spec-v1"))).toThrow();
			stopped.resolve();
			await cancellation;
			expect(f.controller.observation().interaction.messages.map(message => message.status)).toEqual([
				"cancelled",
				"cancelled",
			]);
			expect(received).toEqual([first.messageId]);
			expect(f.transcript.join("\n")).not.toContain("late reply must not publish");
			await f.controller.cancelMessage(first.messageId);
			expect(f.controller.actions().find(action => action.id === "confirm-spec")?.available).toBe(true);
		} finally {
			stopped.resolve();
			await f.dispose();
		}
	});

	it("revises current unapproved requirements through native dialogue and rejects old approval", async () => {
		const f = fixture();
		let revision = 1;
		f.ports.artifacts.writeRequirements = async () => ({ version: `spec-v${++revision}` });
		f.ports.artifacts.readRequirements = async () => ({ version: `spec-v${revision}` });
		f.ports.conversation!.respond = async () => ({
			text: "revised",
			requirements: { ...f.draft, proposal: "Updated exact proposal" },
		});
		try {
			await f.invoke("start revise-test request");
			await f.settle();
			const old = f.controller.status().specification!.version;
			const receipt = await f.controller.submitText("revise it");
			if (receipt.kind !== "queued") throw new Error("Expected native dialogue");
			await f.settleMessage(receipt.messageId);
			expect(f.controller.status().phase).toBe("awaiting-specification");
			expect(f.controller.status().specification!.version).not.toBe(old);
			expect(f.calls).not.toContain("team");
			await f.invoke(`confirm-spec ${old}`);
			await f.settle();
			expect(f.controller.status().specificationApproval).toBeUndefined();
			expect(f.calls).not.toContain("team");
		} finally {
			await f.dispose();
		}
	});

	it("resumes after pause with undelivered input retained as failed and processing cancellation settled", async () => {
		const f = fixture();
		const entered = Promise.withResolvers<void>();
		const stopped = Promise.withResolvers<void>();
		const received: string[] = [];
		f.ports.conversation!.respond = async input => {
			received.push(input.text);
			entered.resolve();
			await stopped.promise;
			return { text: "late reply must not publish" };
		};
		try {
			await f.invoke("start paused-queue request");
			await f.settle();
			const first = await f.controller.submitText("processing");
			if (first.kind !== "queued") throw new Error("Expected native message");
			await entered.promise;
			const second = await f.controller.submitText("undelivered");
			if (second.kind !== "queued") throw new Error("Expected queued message");
			f.controller.pause();
			expect(() => f.controller.resume()).toThrow("用户消息尚未结清");
			expect(f.controller.observation().interaction.messages[1]).toMatchObject({
				id: second.messageId,
				text: "undelivered",
				status: "failed",
				error: expect.stringContaining("未投递"),
			});
			const settled = f.settleMessage(first.messageId);
			stopped.resolve();
			await settled;
			await f.controller.submitText("paused draft");
			f.controller.resume();
			await f.settle();
			expect(f.controller.status()).toMatchObject({ phase: "awaiting-specification", paused: false });
			expect(f.controller.observation().interaction.draft).toBe("paused draft");
			expect(received).toEqual(["processing"]);
			expect(f.transcript.join("\n")).not.toContain("late reply must not publish");
			expect(f.controller.actions().find(action => action.id === "confirm-spec")?.available).toBe(true);
		} finally {
			stopped.resolve();
			await f.dispose();
		}
	});
	it("retains paused drafts and never sends them automatically on resume", async () => {
		const f = fixture();
		const received: string[] = [];
		f.ports.conversation!.respond = async input => {
			received.push(input.text);
			return { text: "reply" };
		};
		try {
			await f.invoke("start paused-draft request");
			await f.settle();
			f.controller.pause();
			expect(await f.controller.submitText("paused draft")).toEqual({ kind: "draft", text: "paused draft" });
			f.controller.resume();
			await f.settle();
			expect(f.controller.observation().interaction.draft).toBe("paused draft");
			expect(received).toEqual([]);
			const receipt = await f.controller.submitText("paused draft");
			if (receipt.kind !== "queued") throw new Error("Expected explicit resubmission");
			await f.settleMessage(receipt.messageId);
			expect(received).toEqual(["paused draft"]);
		} finally {
			await f.dispose();
		}
	});
	it("keeps full native materials available while chat reports only state and shared actions", async () => {
		const f = fixture();
		try {
			await f.invoke("start material-projection request");
			await f.settle();
			const state = f.controller.observation().status;
			const full = renderSpecDrivenStatus(state);
			expect(full).toContain(state.specification!.proposal);
			expect(full).toContain(state.specification!.specs[0]!.content.replaceAll("\n", "\\n"));
			await f.controller.report();
			const summary = f.output.at(-1)!;
			expect(summary).not.toContain(state.specification!.proposal);
			expect(summary).not.toContain(state.specification!.specs[0]!.content);
			for (const action of f.controller.actions()) expect(summary).toContain(action.command);
			expect(f.controller.observation().status.specification).toEqual(state.specification);
		} finally {
			await f.dispose();
		}
	});

	it("rejects queued text from an earlier clarification round instead of delivering it to the next round", async () => {
		const f = fixture();
		f.draft.questions = ["1. Scope? Recommendation: approved scope. Reason: retain permission boundary."];
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const received: string[] = [];
		f.ports.conversation!.respond = async input => {
			received.push(input.messageId);
			entered.resolve();
			await release.promise;
			return { text: "new question round", requirements: { ...f.draft } };
		};
		try {
			await f.invoke("start clarification-round request");
			await f.settle();
			const initialRound = f.controller.observation().interaction.clarification!.id;
			const first = await f.controller.submitText("explain question");
			if (first.kind !== "queued") throw new Error("Expected dialogue receipt");
			await entered.promise;
			const second = await f.controller.submitText("accept this round's recommendation");
			if (second.kind !== "queued") throw new Error("Expected queued answer");
			release.resolve();
			await f.settleMessage(second.messageId);
			expect(received).toEqual([first.messageId]);
			const interaction = f.controller.observation().interaction;
			expect(interaction.clarification!.id).not.toBe(initialRound);
			expect(interaction.messages.find(message => message.id === second.messageId)?.status).toBe("failed");
			expect(interaction.messages.find(message => message.id === second.messageId)?.clarificationId).toBe(
				initialRound,
			);
			expect(f.controller.status().specificationApproval).toBeUndefined();
		} finally {
			release.resolve();
			await f.dispose();
		}
	});
});
