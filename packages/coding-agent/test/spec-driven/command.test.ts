import { describe, expect, it } from "bun:test";
import type { DevDecisionModel, DevDecisionResult } from "@oh-my-pi/pi-tui/overlays/dev-decision-panel";
import { AsyncJobManager } from "../../src/async/job-manager";
import {
	getSpecDrivenController,
	observeSpecDrivenController,
	type SpecRuntimeFactory,
} from "../../src/spec-driven/controller";
import type { SpecAgentInput, SpecDrivenPorts } from "../../src/spec-driven/types";
import { BUILTIN_SPEC_DRIVEN_SLASH_COMMANDS } from "../../src/slash-commands/builtin-spec-driven";
import type { SlashCommandRuntime } from "../../src/slash-commands/types";

function fixture(decision?: (model: DevDecisionModel) => Promise<DevDecisionResult | undefined>) {
	const manager = new AsyncJobManager({});
	const output: string[] = [];
	const inputs: SpecAgentInput[] = [];
	const files = {
		requirements: {
			files: [{ path: "requirements.md", content: "# 原始需求\n保留精确内容", version: "requirements-v1" }],
			version: "requirements-v1",
		},
		solution: {
			path: "docs/superpowers/plans/2026-10-26-change-solutions.json",
			content:
				'{"candidates":[{"id":"existing","title":"复用入口","content":"# 完整方案\\n实现细节与风险"},{"id":"alternate","title":"另一方案","content":"完整备选"}]}',
			version: "solution-v1",
			candidates: [
				{ id: "existing", title: "复用入口", content: "# 完整方案\n实现细节与风险" },
				{ id: "alternate", title: "另一方案", content: "完整备选" },
			],
		},
		plan: {
			path: "docs/superpowers/plans/2026-10-26-change.md",
			content: "# Implementation Plan\n保留 Superpowers 计划正文",
			version: "plan-v1",
		},
		report: {
			path: "docs/superpowers/plans/2026-10-26-change-completion.md",
			content: "# 完成报告\n## 完成情况\n已实现\n## 验证结果\n真实命令和限制\n## 未完成项\n无",
			version: "report-v1",
		},
	};
	let missing = false;
	let run = async (input: SpecAgentInput) => ({ text: `当前 ${input.role} 等待明确决定` });
	let release = async () => {};
	let closed = 0;
	const ports: SpecDrivenPorts = {
		agents: {
			recipient: role => ({ role, actorId: `actor-${role}`, sessionId: `session-${role}` }),
			async run(input) {
				inputs.push(input);
				return run(input);
			},
		},
		artifacts: {
			async initialize() {
				return {
					requirements: ["requirements.md"],
					solution: files.solution.path,
					plan: files.plan.path,
					report: files.report.path,
				};
			},
			async readRequirements() {
				if (missing) throw new Error("requirements.md 缺失");
				return structuredClone(files.requirements);
			},
			async readSolution() {
				return structuredClone(files.solution);
			},
			async readPlan() {
				return structuredClone(files.plan);
			},
			async readReport() {
				return structuredClone(files.report);
			},
			async close() {
				closed++;
				return {};
			},
		},
	};
	const sessionManager = { buildSessionContext: () => ({ mode: "chat" }) };
	const host = {
		sessionManager,
		cwd: "/fixture",
		settings: {},
		session: {
			asyncJobManager: manager,
			sessionManager,
			sessionGeneration: 0,
			isDisposed: false,
			getAgentId: () => "owner",
			addDisposer() {},
			registerSessionChangeCallback: () => () => {},
			appendCustomMessage: async () => {},
			getPlanModeState: () => undefined,
			getGoalModeState: () => undefined,
			getVibeModeState: () => undefined,
		},
		output: (text: string) => {
			output.push(text);
		},
		ui: decision ? { decision, select: async () => undefined, confirm: async () => true } : undefined,
	} as unknown as SlashCommandRuntime;
	const factory: SpecRuntimeFactory = async () => ({
		ports,
		options: { currentModel: "fixture" },
		dispose: () => release(),
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
	const invoke = (args: string) =>
		BUILTIN_SPEC_DRIVEN_SLASH_COMMANDS[0]!.handle!({ name: "dev", args, text: `/dev ${args}` }, host);
	const settle = () => Promise.all(manager.getRunningJobs().map(job => job.promise));
	const transition = async (args: string) => {
		await invoke(args);
		await settle();
	};
	const settleMessage = (id: string) =>
		new Promise<void>(resolve => {
			const stop = observeSpecDrivenController(sessionManager, observation => {
				if (
					observation.interaction.messages.some(
						message => message.id === id && ["completed", "cancelled", "failed"].includes(message.status),
					)
				)
					queueMicrotask(() => {
						stop();
						resolve();
					});
			});
		});
	return {
		controller,
		host,
		files,
		inputs,
		output,
		invoke,
		settle,
		transition,
		settleMessage,
		closed: () => closed,
		missing: (value: boolean) => {
			missing = value;
		},
		run: (value: typeof run) => {
			run = value;
		},
		release: (value: typeof release) => {
			release = value;
		},
		dispose: async () => {
			await controller.dispose();
			await manager.dispose();
		},
	};
}

describe("/dev file-stage commands", () => {
	it("uses current files and sends complete solution plus original choice to planner without version arguments", async () => {
		const f = fixture();
		try {
			await f.transition("start change 原始需求");
			expect(f.controller.status().phase).toBe("awaiting-specification");
			expect(f.inputs.map(input => input.role)).toEqual(["requirements"]);
			expect(f.controller.actions().find(action => action.id === "confirm-spec")?.command).toBe("/dev confirm-spec");
			await f.transition("confirm-spec");
			expect(
				f.controller
					.actions()
					.filter(action => action.id.startsWith("choose:"))
					.map(action => action.command),
			).toEqual(["/dev choose existing", "/dev choose alternate"]);
			const reply = "choose existing  同意该完整方案\n 保留这段原始说明  ";
			await f.transition(reply);
			const planner = f.inputs.find(input => input.role === "planner")!;
			expect(planner.files).toContainEqual(f.files.solution);
			expect(planner.userReply).toBe(`/dev ${reply}`);
			expect(planner.candidateId).toBe("existing");
			expect(f.controller.status().selection?.userReply).toBe(`/dev ${reply}`);
			await f.transition("confirm-plan");
			expect(f.controller.status().phase).toBe("awaiting-acceptance");
			expect(f.closed()).toBe(0);
			expect(f.inputs.map(input => input.role)).toEqual(["requirements", "solution", "planner", "executor"]);
			await f.transition("accept");
			expect(f.closed()).toBe(1);
			expect(f.controller.status().phase).toBe("completed");
		} finally {
			await f.dispose();
		}
	});

	it.each(["需求没问题，请按文件继续，保留  内部空格。\n 原始补充  ", "opaque-version"])(
		"preserves optional confirmation as the original reply without interpreting versions: %s",
		async confirmation => {
			const f = fixture();
			try {
				await f.transition("start change 原始需求");
				const specificationReply = `confirm-spec ${confirmation}`;
				expect(await f.invoke(specificationReply)).toMatchObject({ consumed: true });
				await f.settle();
				expect(f.controller.status().phase).toBe("awaiting-choice");
				expect(f.inputs.find(input => input.role === "solution")?.userReply).toBe(`/dev ${specificationReply}`);
				await f.transition("choose existing");
				const planReply = `confirm-plan ${confirmation}`;
				expect(await f.invoke(planReply)).toMatchObject({ consumed: true });
				await f.settle();
				expect(f.controller.status().phase).toBe("awaiting-acceptance");
				expect(f.inputs.find(input => input.role === "executor")?.userReply).toBe(`/dev ${planReply}`);
			} finally {
				await f.dispose();
			}
		},
	);

	it("keeps missing files at the active stage and exposes ordinary answer, not approval", async () => {
		const f = fixture();
		try {
			f.missing(true);
			await f.transition("start change requirement");
			expect(f.controller.status()).toMatchObject({ phase: "requirements", blockedReason: "requirements.md 缺失" });
			expect(f.controller.actions().some(action => action.id === "confirm-spec")).toBe(false);
			f.missing(false);
			await f.transition("answer 补充所需说明");
			expect(f.controller.status().phase).toBe("awaiting-specification");
			expect(f.inputs.map(input => input.role)).toEqual(["requirements", "requirements"]);
		} finally {
			await f.dispose();
		}
	});

	it("rejects removed review controls and goal mode without dispatching another stage", async () => {
		const f = fixture();
		try {
			await f.transition("start change requirement");
			expect(await f.invoke("extend-review R1 2 2")).toMatchObject({ consumed: true, failed: true });
			expect(f.inputs.map(input => input.role)).toEqual(["requirements"]);
			await f.transition("confirm-spec");
			await f.transition("choose existing");
			expect(f.controller.status().phase).toBe("awaiting-plan");
			expect(await f.invoke("confirm-plan --goal")).toMatchObject({ consumed: true, failed: true });
			expect(f.inputs.map(input => input.role)).toEqual(["requirements", "solution", "planner"]);
		} finally {
			await f.dispose();
		}
	});

	it("retains drafts and ordinary-mode ownership without approving from plain text", async () => {
		const f = fixture();
		try {
			expect(await f.controller.submitText("unsent draft")).toEqual({ kind: "draft", text: "unsent draft" });
			await f.invoke("");
			expect(f.controller.inputMode()).toBe("dev");
			await f.invoke("");
			expect(f.controller.inputMode()).toBe("chat");
			await f.transition("start change requirement");
			const receipt = await f.controller.submitText("同意");
			if (receipt.kind !== "queued") throw new Error("Expected queued message");
			await f.settleMessage(receipt.messageId);
			expect(f.controller.status().phase).toBe("awaiting-specification");
			expect(f.inputs.every(input => input.role === "requirements")).toBe(true);
		} finally {
			await f.dispose();
		}
	});

	it("shows complete materials and preserves optional original panel confirmation", async () => {
		const models: DevDecisionModel[] = [];
		let selected: DevDecisionResult | undefined;
		const f = fixture(async model => {
			models.push(model);
			return selected;
		});
		try {
			await f.transition("start change requirement");
			await f.invoke("help");
			expect(f.inputs).toHaveLength(1);
			expect(models.at(-1)!.actions.find(action => action.id === "inspect:specification")?.detail).toContain(
				f.files.requirements.files[0]!.content,
			);
			await f.transition("confirm-spec");
			await f.invoke("help");
			const choice = models.at(-1)!;
			expect(choice.actions.find(action => action.id === "inspect:solution")?.detail).toContain(
				f.files.solution.content,
			);
			expect(choice.actions.find(action => action.id === "choose:existing")?.detail).toContain(
				f.files.solution.content,
			);
			selected = { actionId: "choose:existing", values: { confirmation: "  用户原始确认\n保留说明  " } };
			await f.invoke("help");
			await f.settle();
			expect(f.controller.status().selection?.userReply).toBe("/dev choose existing   用户原始确认\n保留说明  ");
		} finally {
			await f.dispose();
		}
	});

	it("treats material inspection as non-approving even if returned by a host", async () => {
		const f = fixture(async () => ({ actionId: "inspect:specification" }));
		try {
			await f.transition("start change requirement");
			expect(await f.invoke("help")).toMatchObject({ consumed: true, failed: true });
			expect(f.controller.status().phase).toBe("awaiting-specification");
			expect(f.inputs).toHaveLength(1);
		} finally {
			await f.dispose();
		}
	});

	it("retains the old owner after failed native release and permits an explicit cancellation retry", async () => {
		const f = fixture();
		try {
			await f.transition("start change requirement");
			f.release(async () => {
				throw new Error("native cancellation failed");
			});
			const error = await f.controller.cancel().then(
				() => undefined,
				error => error,
			);
			expect(error).toBeInstanceOf(Error);
			expect(f.controller.observation().released).toBe(false);
			expect(() => getSpecDrivenController(f.host, { restart: true })).toThrow();
			f.release(async () => {});
			await f.controller.cancel();
			expect(f.controller.observation().released).toBe(true);
			expect(f.controller.restartBlock()).toBeUndefined();
		} finally {
			f.release(async () => {});
			await f.dispose();
		}
	});

	it("keeps cancellation and restart blocked until an in-flight message and native release settle", async () => {
		const f = fixture();
		const entered = Promise.withResolvers<void>();
		const response = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		try {
			await f.transition("start change requirement");
			f.run(async () => {
				entered.resolve();
				await response.promise;
				return { text: "旧回复不得复用" };
			});
			f.release(() => release.promise);
			const receipt = await f.controller.submitText("等待取消的消息");
			if (receipt.kind !== "queued") throw new Error("Expected queued message");
			await entered.promise;
			const cancelling = f.controller.cancel();
			expect(f.controller.restartBlock()).toContain("尚未结清");
			expect(() => getSpecDrivenController(f.host, { restart: true })).toThrow();
			response.resolve();
			await f.settleMessage(receipt.messageId);
			expect(f.controller.restartBlock()).toContain("尚未释放");
			release.resolve();
			await cancelling;
			expect(f.controller.restartBlock()).toBeUndefined();
			expect(f.controller.observation().interaction.messages[0]).toMatchObject({ status: "cancelled" });
			expect(f.controller.observation().interaction.messages[0]?.reply).toBeUndefined();
		} finally {
			response.resolve();
			release.resolve();
			await f.dispose();
		}
	});
});
