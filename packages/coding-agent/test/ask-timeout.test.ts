import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import type { AgentToolContext, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { TUI } from "@oh-my-pi/pi-tui";
import { Settings } from "../src/config/settings";
import type {
	ExtensionAskDialogResult,
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionUISelectItem,
} from "../src/extensibility/extensions";
import { HookSelectorComponent } from "@oh-my-pi/pi-tui/overlays/hook-selector";
import { AskDialogComponent } from "@oh-my-pi/pi-tui/overlays/ask-dialog";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-tui/theme";
import type { GoalModeState } from "../src/goals/state";
import type { ToolSession } from "../src/tools";
import { AskTool, OTHER_OPTION } from "../src/tools/ask";
import { type AskToolDetails } from "@oh-my-pi/pi-tui/tools/ask";

type AskExecutionResult = AgentToolResult<AskToolDetails>;
type AskSelect = (
	title: string,
	options: ExtensionUISelectItem[],
	dialogOptions?: ExtensionUIDialogOptions,
) => Promise<string | undefined>;

async function drainMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

function createAskTool(overrides: Partial<ToolSession> = {}): AskTool {
	return new AskTool({
		hasUI: true,
		settings: Settings.isolated({ "ask.timeout": 0.01, "ask.notify": "off", "speech.enabled": false }),
		getPlanModeState: () => ({ enabled: false }),
		...overrides,
	} as unknown as ToolSession);
}

function createAutopilotGoal(): GoalModeState {
	return {
		enabled: true,
		mode: "active",
		autoOrchestrate: true,
		goal: {
			id: "ask-live-goal",
			objective: "Finish the current task",
			status: "active",
			tokensUsed: 0,
			timeUsedSeconds: 0,
			createdAt: 0,
			updatedAt: 0,
		},
	};
}

function endAutopilotGoal(state: GoalModeState, change: "pause" | "drop" | "complete"): GoalModeState | undefined {
	if (change === "drop") return undefined;
	return {
		...state,
		enabled: false,
		mode: change === "complete" ? "exiting" : "active",
		...(change === "complete" ? { reason: "completed" as const } : {}),
		goal: { ...state.goal, status: change === "complete" ? "complete" : "paused" },
	};
}

describe("AskTool timeout", () => {
	beforeAll(async () => {
		const loaded = await getThemeByName("dark");
		if (!loaded) throw new Error("theme unavailable");
		setThemeInstance(loaded);
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("selects the recommended answer when the selector does not settle", async () => {
		vi.useFakeTimers();
		const select = vi.fn<AskSelect>(() => Promise.withResolvers<string | undefined>().promise);
		const abort = vi.fn();
		const context = {
			hasUI: true,
			ui: {
				select,
				editor: vi.fn(),
			},
			abort,
		} as unknown as AgentToolContext;
		let result: AskExecutionResult | undefined;
		let rejection: unknown;

		void createAskTool()
			.execute(
				"ask-timeout",
				{
					questions: [
						{
							id: "db",
							question: "Which database?",
							options: [{ label: "SQLite" }, { label: "Postgres" }],
							recommended: 1,
						},
					],
				},
				undefined,
				undefined,
				context,
			)
			.then(
				value => {
					result = value;
				},
				error => {
					rejection = error;
				},
			);

		await drainMicrotasks();
		vi.advanceTimersByTime(10);
		await drainMicrotasks();

		expect(rejection).toBeUndefined();
		expect(result?.details?.selectedOptions).toEqual(["Postgres"]);
		expect(result?.details?.timedOut).toBe(true);
		expect(abort).not.toHaveBeenCalled();
	});

	it("honors selector timeout resets before using the fallback timeout", async () => {
		vi.useFakeTimers();
		let resetTimeout: (() => void) | undefined;
		const select = vi.fn<AskSelect>((_title, _options, dialogOptions) => {
			dialogOptions?.onTimeoutStart?.();
			resetTimeout = dialogOptions?.onTimeoutReset;
			return Promise.withResolvers<string | undefined>().promise;
		});
		const abort = vi.fn();
		const context = {
			hasUI: true,
			ui: {
				select,
				editor: vi.fn(),
			},
			abort,
		} as unknown as AgentToolContext;
		let result: AskExecutionResult | undefined;
		let rejection: unknown;

		void createAskTool()
			.execute(
				"ask-timeout",
				{
					questions: [
						{
							id: "db",
							question: "Which database?",
							options: [{ label: "SQLite" }, { label: "Postgres" }],
							recommended: 1,
						},
					],
				},
				undefined,
				undefined,
				context,
			)
			.then(
				value => {
					result = value;
				},
				error => {
					rejection = error;
				},
			);

		await drainMicrotasks();
		expect(resetTimeout).toBeDefined();

		vi.advanceTimersByTime(9);
		resetTimeout?.();
		vi.advanceTimersByTime(9);
		await drainMicrotasks();

		expect(result).toBeUndefined();

		vi.advanceTimersByTime(1);
		await drainMicrotasks();

		expect(rejection).toBeUndefined();
		expect(result?.details?.selectedOptions).toEqual(["Postgres"]);
		expect(result?.details?.timedOut).toBe(true);
		expect(abort).not.toHaveBeenCalled();
	});

	it("does not run the fallback timeout while the selector is queued", async () => {
		vi.useFakeTimers();
		let startTimeout: (() => void) | undefined;
		const select = vi.fn<AskSelect>((_title, _options, dialogOptions) => {
			startTimeout = dialogOptions?.onTimeoutStart;
			return Promise.withResolvers<string | undefined>().promise;
		});
		const abort = vi.fn();
		const context = {
			hasUI: true,
			ui: {
				timeoutStartsOnPresentation: true,
				select,
				editor: vi.fn(),
			},
			abort,
		} as unknown as AgentToolContext;
		let result: AskExecutionResult | undefined;
		let rejection: unknown;

		void createAskTool()
			.execute(
				"ask-timeout",
				{
					questions: [
						{
							id: "db",
							question: "Which database?",
							options: [{ label: "SQLite" }, { label: "Postgres" }],
							recommended: 1,
						},
					],
				},
				undefined,
				undefined,
				context,
			)
			.then(
				value => {
					result = value;
				},
				error => {
					rejection = error;
				},
			);

		await drainMicrotasks();
		expect(startTimeout).toBeDefined();

		vi.advanceTimersByTime(10);
		await drainMicrotasks();

		expect(result).toBeUndefined();

		startTimeout?.();
		vi.advanceTimersByTime(10);
		await drainMicrotasks();

		expect(rejection).toBeUndefined();
		expect(result?.details?.selectedOptions).toEqual(["Postgres"]);
		expect(result?.details?.timedOut).toBe(true);
		expect(abort).not.toHaveBeenCalled();
	});

	it("auto-selects timed-out questions while preserving later manual answers", async () => {
		vi.useFakeTimers();
		let callCount = 0;
		const select = vi.fn<AskSelect>((_title, _options, dialogOptions) => {
			callCount += 1;
			if (callCount === 1) {
				dialogOptions?.onTimeoutStart?.();
				return Promise.withResolvers<string | undefined>().promise;
			}
			return Promise.resolve("OAuth");
		});
		const abort = vi.fn();
		const context = {
			hasUI: true,
			ui: {
				select,
				editor: vi.fn(),
			},
			abort,
		} as unknown as AgentToolContext;
		let result: AskExecutionResult | undefined;
		let rejection: unknown;

		void createAskTool()
			.execute(
				"ask-timeout",
				{
					questions: [
						{
							id: "db",
							question: "Which database?",
							options: [{ label: "SQLite" }, { label: "Postgres" }],
							recommended: 1,
						},
						{
							id: "auth",
							question: "Which auth?",
							options: [{ label: "JWT" }, { label: "OAuth" }],
							recommended: 0,
						},
					],
				},
				undefined,
				undefined,
				context,
			)
			.then(
				value => {
					result = value;
				},
				error => {
					rejection = error;
				},
			);

		await drainMicrotasks();
		vi.advanceTimersByTime(10);
		await drainMicrotasks();
		await drainMicrotasks();

		expect(rejection).toBeUndefined();
		expect(select).toHaveBeenCalledTimes(2);
		expect(result?.details?.results?.[0]?.selectedOptions).toEqual(["Postgres"]);
		expect(result?.details?.results?.[0]?.timedOut).toBe(true);
		expect(result?.details?.results?.[1]?.selectedOptions).toEqual(["OAuth"]);
		expect(result?.details?.results?.[1]?.timedOut).toBeUndefined();
		expect(abort).not.toHaveBeenCalled();
	});

	for (const revisit of ["right navigation", "cancelled custom input", "manual option", "custom answer"] as const) {
		it(`preserves timeout reply provenance until replacement after ${revisit}`, async () => {
			vi.useFakeTimers();
			const keepsAutomaticReply = revisit === "right navigation" || revisit === "cancelled custom input";
			let callCount = 0;
			const select = vi.fn<AskSelect>((_title, _options, dialogOptions) => {
				callCount += 1;
				if (callCount === 1) {
					return Promise.withResolvers<string | undefined>().promise;
				}
				if (callCount === 2) {
					dialogOptions?.onLeft?.();
					return Promise.resolve(undefined);
				}
				if (callCount === 3) {
					if (revisit === "right navigation") {
						dialogOptions?.onRight?.();
						return Promise.resolve(undefined);
					}
					return Promise.resolve(revisit === "manual option" ? "SQLite" : OTHER_OPTION);
				}
				if (callCount === 4 && revisit === "cancelled custom input") {
					dialogOptions?.onRight?.();
					return Promise.resolve(undefined);
				}
				return Promise.resolve("OAuth");
			});
			const editor = vi.fn(async () => (revisit === "custom answer" ? "Keep current database" : undefined));
			const abort = vi.fn();
			const context = {
				hasUI: true,
				ui: { select, editor },
				abort,
			} as unknown as AgentToolContext;
			const execution = createAskTool({ getGoalModeState: createAutopilotGoal }).execute(
				"ask-timeout-revisit",
				{
					questions: [
						{
							id: "db",
							question: "Which database?",
							options: [{ label: "SQLite" }, { label: "Postgres" }],
							recommended: 1,
						},
						{
							id: "auth",
							question: "Which auth?",
							options: [{ label: "JWT" }, { label: "OAuth" }],
							recommended: 0,
						},
					],
				},
				undefined,
				undefined,
				context,
			);

			await drainMicrotasks();
			expect(select).toHaveBeenCalledTimes(1);
			vi.advanceTimersByTime(10);
			const result = await execution;

			expect(select.mock.calls.map(([title]) => title)).toEqual([
				"Which database? (1/2)",
				"Which auth? (2/2)",
				"Which database? (1/2)",
				...(revisit === "cancelled custom input" ? ["Which database? (1/2)"] : []),
				"Which auth? (2/2)",
			]);
			const answer = result.details?.results?.[0];
			const reply = "按原目标自主决定，全程授权你继续调查、实施、验证和修复，完成后再汇总";
			expect(answer?.timedOut).toBe(keepsAutomaticReply ? true : undefined);
			expect(answer?.selectedOptions).toEqual(revisit === "manual option" ? ["SQLite"] : []);
			expect(answer?.customInput).toBe(
				keepsAutomaticReply ? reply : revisit === "custom answer" ? "Keep current database" : undefined,
			);
			expect(result.details?.results?.[1]?.selectedOptions).toEqual(["OAuth"]);
			expect(result.details?.results?.[1]?.timedOut).toBeUndefined();
			expect(result.content).toEqual([
				{
					type: "text",
					text: keepsAutomaticReply
						? `Answers:\ndb: "${reply}" (automatic reply after timeout)\nauth: OAuth`
						: `User answers:\ndb: ${revisit === "manual option" ? "SQLite" : '"Keep current database"'}\nauth: OAuth`,
				},
			]);
			expect(editor).toHaveBeenCalledTimes(
				revisit === "cancelled custom input" || revisit === "custom answer" ? 1 : 0,
			);
			expect(abort).not.toHaveBeenCalled();
		});
	}

	describe("live Goal timeout eligibility", () => {
		for (const change of ["pause", "drop", "complete"] as const) {
			for (const multi of [false, true]) {
				it(`P2-29: simplified ${multi ? "multi" : "single"}-select uses the upstream answer after Goal ${change}`, async () => {
					vi.useFakeTimers();
					let goalState: GoalModeState | undefined = createAutopilotGoal();
					const select = vi.fn<AskSelect>(() => Promise.withResolvers<string | undefined>().promise);
					const abort = vi.fn();
					const context = {
						hasUI: true,
						ui: { select, editor: vi.fn() },
						abort,
					} as unknown as AgentToolContext;
					const execution = createAskTool({ getGoalModeState: () => goalState }).execute(
						"ask-live-goal",
						{
							questions: [
								{
									id: "db",
									question: "Which database?",
									options: [{ label: "SQLite" }, { label: "Postgres" }],
									recommended: 1,
									multi,
								},
							],
						},
						undefined,
						undefined,
						context,
					);

					await drainMicrotasks();
					expect(select).toHaveBeenCalledTimes(1);
					vi.advanceTimersByTime(9);
					goalState = endAutopilotGoal(goalState!, change);
					vi.advanceTimersByTime(1);
					const result = await execution;

					expect(result.details?.selectedOptions).toEqual(["Postgres"]);
					expect(result.details?.customInput).toBeUndefined();
					expect(result.details?.timedOut).toBe(true);
					expect(abort).not.toHaveBeenCalled();
				});
			}

			for (const fallback of ["recommended", "first", "noted"] as const) {
				it(`P2-29: rich dialog preserves the ${fallback} timeout answer after Goal ${change}`, async () => {
					vi.useFakeTimers();
					let goalState: GoalModeState | undefined = createAutopilotGoal();
					let dialog: AskDialogComponent | undefined;
					const abort = vi.fn();
					const askDialog: NonNullable<ExtensionUIContext["askDialog"]> = async (questions, options) => {
						const answer = Promise.withResolvers<ExtensionAskDialogResult | undefined>();
						dialog = new AskDialogComponent(
							questions,
							{
								onSubmit: answer.resolve,
								onCancel: () => answer.resolve(undefined),
								onPrompt: async () => "Keep the existing local database",
							},
							{ timeout: options?.timeout },
						);
						return answer.promise;
					};
					const context = {
						hasUI: true,
						ui: { askDialog, select: vi.fn(), editor: vi.fn() },
						abort,
					} as unknown as AgentToolContext;
					const execution = createAskTool({ getGoalModeState: () => goalState }).execute(
						"ask-live-goal",
						{
							questions: [
								{
									id: "answered",
									question: "Keep existing work?",
									options: [{ label: "Keep" }, { label: "Discard" }],
								},
								{
									id: "db",
									question: "Which database?",
									options: [{ label: "SQLite" }, { label: "Postgres" }],
									...(fallback === "first" ? {} : { recommended: 1 }),
								},
							],
						},
						undefined,
						undefined,
						context,
					);

					try {
						await drainMicrotasks();
						expect(dialog).toBeDefined();
						dialog!.handleInput("\n");
						if (fallback === "noted") {
							dialog!.handleInput("\x1b[A");
							dialog!.handleInput("n");
							await drainMicrotasks();
						}
						vi.advanceTimersByTime(9);
						goalState = endAutopilotGoal(goalState!, change);
						vi.advanceTimersByTime(1);
						const result = await execution;

						expect(result.details?.results?.[0]).toMatchObject({
							id: "answered",
							selectedOptions: ["Keep"],
						});
						expect(result.details?.results?.[0]?.timedOut).not.toBe(true);
						expect(result.details?.results?.[1]?.selectedOptions).toEqual([
							fallback === "recommended" ? "Postgres" : "SQLite",
						]);
						expect(result.details?.results?.[1]?.customInput).toBeUndefined();
						expect(result.details?.results?.[1]?.timedOut).toBe(true);
						expect(result.details?.results?.[1]?.note).toBe(
							fallback === "noted" ? "Keep the existing local database" : undefined,
						);
						expect(abort).not.toHaveBeenCalled();
					} finally {
						dialog?.dispose();
					}
				});
			}
		}
	});

	it("notifies callers when the selector countdown starts and resets", () => {
		vi.useFakeTimers();
		const onTimeoutStart = vi.fn();
		const onTimeoutReset = vi.fn();
		const selector = new HookSelectorComponent("Pick one", ["SQLite", "Postgres"], vi.fn(), vi.fn(), {
			timeout: 10,
			tui: { requestRender: vi.fn() } as unknown as TUI,
			onTimeoutStart,
			onTimeoutReset,
		});

		selector.handleInput("j");

		expect(onTimeoutStart).toHaveBeenCalledTimes(1);
		expect(onTimeoutReset).toHaveBeenCalledTimes(1);
		selector.dispose();
	});
});
