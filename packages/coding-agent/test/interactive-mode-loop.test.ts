import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import * as loopCondition from "@oh-my-pi/pi-coding-agent/modes/loop-condition";
import type { LoopConditionVerdict } from "@oh-my-pi/pi-coding-agent/modes/loop-condition";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { SubmittedUserInput } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

import { cfgLoopMode } from "@oh-my-pi/pi-coding-agent/modes/settings";

async function flushMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

describe("InteractiveMode loop auto-submit", () => {
	let authStorage: AuthStorage;
	let mode: InteractiveMode;
	let session: AgentSession;
	let tempDir: TempDir;
	let pendingInput: Promise<SubmittedUserInput> | undefined;

	beforeAll(async () => {
		initTheme();
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-loop-auto-submit-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 test model");

		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		mode = new InteractiveMode(session, "test");
		mode.ui.requestRender = vi.fn();
	});

	beforeEach(() => {
		cfgLoopMode.set(settings, "prompt");
		vi.spyOn(mode, "addMessageToChat").mockReturnValue([]);
		vi.spyOn(mode, "ensureLoadingAnimation").mockImplementation(() => {});
	});

	afterEach(async () => {
		mode.disableLoopMode("Loop mode disabled.");
		mode.cancelPendingSubmission();
		if (mode.onInputCallback) {
			mode.onInputCallback({ text: "", cancelled: true, started: false });
		}
		await pendingInput;
		pendingInput = undefined;
		mode.vibeModeEnabled = false;
		Reflect.deleteProperty(session, "isCompacting");
		Reflect.deleteProperty(session, "isStreaming");
		Reflect.deleteProperty(session, "hasPostPromptWork");
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	afterAll(async () => {
		mode.stop();
		await session.dispose();
		authStorage.close();
		tempDir.removeSync();
		resetSettingsForTest();
	});

	it("requires leaving an armed or paused Loop before entering dev without changing the loop", async () => {
		await mode.handleLoopCommand("3");
		mode.setLoopPrompt("repeat this");
		expect(() => mode.assertCanActivateMode("dev")).toThrow("Loop");
		expect(mode.loopPrompt).toBe("repeat this");
		expect(mode.loopModeEnabled).toBe(true);
		mode.pauseLoop();
		expect(() => mode.assertCanActivateMode("dev")).toThrow("Loop");
		expect(mode.loopModePaused).toBe(true);
		mode.disableLoopMode();
		expect(() => mode.assertCanActivateMode("dev")).not.toThrow();
	});

	it("does not resolve the next loop prompt while compaction is running", async () => {
		vi.useFakeTimers();
		let compacting = true;
		Object.defineProperty(session, "isCompacting", { configurable: true, get: () => compacting });
		Object.defineProperty(session, "isStreaming", { configurable: true, get: () => false });

		mode.loopModeEnabled = true;
		mode.loopPrompt = "repeat this";
		const resolved: SubmittedUserInput[] = [];
		pendingInput = mode.getUserInput();
		void pendingInput.then(input => resolved.push(input));

		vi.advanceTimersByTime(800);
		await flushMicrotasks();
		expect(resolved).toHaveLength(0);

		compacting = false;
		vi.advanceTimersByTime(800);
		await flushMicrotasks();

		expect(resolved).toHaveLength(1);
		expect(resolved[0].text).toBe("repeat this");
	});

	it("does not recompact when a compact loop turn starts another prompt before resubmitting", async () => {
		vi.useFakeTimers();
		cfgLoopMode.set(settings, "compact");
		let streaming = false;
		Object.defineProperty(session, "isCompacting", { configurable: true, get: () => false });
		Object.defineProperty(session, "isStreaming", { configurable: true, get: () => streaming });
		const compact = vi.spyOn(mode, "handleCompactCommand").mockImplementation(async () => {
			streaming = true;
			return "ok";
		});

		mode.loopModeEnabled = true;
		mode.loopPrompt = "repeat after compact";
		const resolved: SubmittedUserInput[] = [];
		pendingInput = mode.getUserInput();
		void pendingInput.then(input => resolved.push(input));

		vi.advanceTimersByTime(800);
		await flushMicrotasks();
		expect(compact).toHaveBeenCalledTimes(1);
		expect(resolved).toHaveLength(0);

		streaming = false;
		vi.advanceTimersByTime(800);
		await flushMicrotasks();

		expect(compact).toHaveBeenCalledTimes(1);
		expect(resolved).toHaveLength(1);
		expect(resolved[0].text).toBe("repeat after compact");
	});

	it("does not resolve the next loop prompt while post-prompt background work is pending", async () => {
		vi.useFakeTimers();
		let hasPendingWork = true;
		Object.defineProperty(session, "isCompacting", { configurable: true, get: () => false });
		Object.defineProperty(session, "isStreaming", { configurable: true, get: () => false });
		Object.defineProperty(session, "hasPostPromptWork", { configurable: true, get: () => hasPendingWork });

		mode.loopModeEnabled = true;
		mode.loopPrompt = "deliver this";
		const resolved: SubmittedUserInput[] = [];
		pendingInput = mode.getUserInput();
		void pendingInput.then(input => resolved.push(input));

		// Loop timer fires while an idle-flush / delivery turn is still pending.
		vi.advanceTimersByTime(800);
		await flushMicrotasks();
		expect(resolved).toHaveLength(0);

		// Background delivery completes; loop may now fire.
		hasPendingWork = false;
		vi.advanceTimersByTime(800);
		await flushMicrotasks();

		expect(resolved).toHaveLength(1);
		expect(resolved[0].text).toBe("deliver this");
	});

	it("disables reset loops when vibe blocks the session transition", async () => {
		vi.useFakeTimers();
		cfgLoopMode.set(settings, "reset");
		mode.vibeModeEnabled = true;
		mode.loopModeEnabled = true;
		mode.loopPrompt = "do not resubmit";
		const showStatus = vi.spyOn(mode, "showStatus");
		const resolved: SubmittedUserInput[] = [];
		pendingInput = mode.getUserInput();
		void pendingInput.then(input => resolved.push(input));

		vi.advanceTimersByTime(800);
		await flushMicrotasks();

		expect(resolved).toHaveLength(0);
		expect(mode.loopModeEnabled).toBe(false);
		expect(mode.loopPrompt).toBeUndefined();
		expect(showStatus).toHaveBeenCalledWith("Exit vibe mode before using reset loops. Loop mode disabled.");
	});

	it("reports waiting, running, paused, resumed, and disabled loop states", async () => {
		const setLoopModeStatus = vi.spyOn(mode.statusLine, "setLoopModeStatus");

		await mode.handleLoopCommand("3");
		expect(setLoopModeStatus).toHaveBeenLastCalledWith({
			state: "waiting",
			limit: { kind: "iterations", initial: 3, remaining: 3 },
		});

		mode.setLoopPrompt("repeat this");
		expect(setLoopModeStatus).toHaveBeenLastCalledWith({
			state: "running",
			limit: { kind: "iterations", initial: 3, remaining: 3 },
		});

		mode.pauseLoop();
		expect(setLoopModeStatus).toHaveBeenLastCalledWith({
			state: "paused",
			limit: { kind: "iterations", initial: 3, remaining: 3 },
		});

		mode.setLoopPrompt("resume this");
		expect(setLoopModeStatus).toHaveBeenLastCalledWith({
			state: "running",
			limit: { kind: "iterations", initial: 3, remaining: 3 },
		});

		mode.disableLoopMode();
		expect(setLoopModeStatus).toHaveBeenLastCalledWith(undefined);
	});

	describe("positional interval", () => {
		let nowMs: number;

		beforeEach(() => {
			vi.useFakeTimers();
			nowMs = 1_000_000;
			vi.spyOn(Date, "now").mockImplementation(() => nowMs);
			Object.defineProperty(session, "isCompacting", { configurable: true, get: () => false });
			Object.defineProperty(session, "isStreaming", { configurable: true, get: () => false });
			Object.defineProperty(session, "hasPostPromptWork", { configurable: true, get: () => false });
		});

		async function advance(ms: number): Promise<void> {
			nowMs += ms;
			vi.advanceTimersByTime(ms);
			await flushMicrotasks();
		}

		function waitForNextInput(): SubmittedUserInput[] {
			const resolved: SubmittedUserInput[] = [];
			pendingInput = mode.getUserInput();
			void pendingInput.then(input => resolved.push(input));
			return resolved;
		}

		it("submits the first turn immediately and waits the full interval after each terminal turn", async () => {
			new InputController(mode).setupEditorSubmitHandler();
			const first = waitForNextInput();
			await mode.editor.onSubmit?.("/loop 3 5s repeat this");
			await flushMicrotasks();
			expect(first).toHaveLength(1);
			expect(first[0].text).toBe("repeat this");
			expect(mode.loopLimit).toEqual({ kind: "iterations", initial: 3, remaining: 2 });
			mode.cancelPendingSubmission();

			// A long first turn does not consume any of the requested idle gap.
			await advance(20_000);
			const second = waitForNextInput();
			await advance(4_999);
			expect(second).toHaveLength(0);
			await advance(1);
			expect(second).toHaveLength(1);
			expect(second[0].text).toBe("repeat this");
			expect(mode.loopLimit).toEqual({ kind: "iterations", initial: 3, remaining: 1 });
			mode.cancelPendingSubmission();

			await advance(2_000);
			const third = waitForNextInput();
			await advance(4_999);
			expect(third).toHaveLength(0);
			await advance(1);
			expect(third).toHaveLength(1);
			expect(mode.loopLimit).toEqual({ kind: "iterations", initial: 3, remaining: 0 });
			mode.cancelPendingSubmission();

			const fourth = waitForNextInput();
			expect(mode.loopModeEnabled).toBe(false);
			await advance(10_000);
			expect(fourth).toHaveLength(0);
		});

		it("counts the first manual prompt when the command has no inline prompt", async () => {
			new InputController(mode).setupEditorSubmitHandler();
			const first = waitForNextInput();
			await mode.editor.onSubmit?.("/loop 1 5s");
			expect(first).toHaveLength(0);
			expect(mode.loopLimit).toEqual({ kind: "iterations", initial: 1, remaining: 0 });

			await mode.editor.onSubmit?.("manual first turn");
			await flushMicrotasks();
			expect(first).toHaveLength(1);
			expect(first[0].text).toBe("manual first turn");
			mode.cancelPendingSubmission();
			const next = waitForNextInput();
			await advance(5_000);
			expect(next).toHaveLength(0);
			expect(mode.loopModeEnabled).toBe(false);
		});

		it("preserves the repeat-count budget and 800ms delay without an interval", async () => {
			expect(await mode.handleLoopCommand("1 repeat this")).toBe("repeat this");
			mode.setLoopPrompt("repeat this");
			expect(mode.loopLimit).toEqual({ kind: "iterations", initial: 1, remaining: 1 });
			const repeat = waitForNextInput();
			await advance(799);
			expect(repeat).toHaveLength(0);
			await advance(1);
			expect(repeat).toHaveLength(1);
			expect(mode.loopLimit).toEqual({ kind: "iterations", initial: 1, remaining: 0 });
		});

		it.each(["pauseLoop", "disableLoopMode"] as const)("cancels the interval timer on %s", async cancel => {
			await mode.handleLoopCommand("3 5s repeat this");
			mode.setLoopPrompt("repeat this");
			const next = waitForNextInput();
			await advance(1_000);
			mode[cancel]();
			await advance(10_000);
			expect(next).toHaveLength(0);
			expect(mode.loopPrompt).toBeUndefined();
			expect(mode.loopModeEnabled).toBe(cancel === "pauseLoop");
		});

		it("cancels a pending interval when a manual prompt supersedes it", async () => {
			await mode.handleLoopCommand("3 5s repeat this");
			mode.setLoopPrompt("repeat this");
			const next = waitForNextInput();
			await advance(1_000);
			mode.setLoopPrompt("replacement");
			await advance(10_000);
			expect(next).toHaveLength(0);

			mode.armLoopAutoSubmit(Promise.resolve());
			await flushMicrotasks();
			await advance(4_999);
			expect(next).toHaveLength(0);
			await advance(1);
			expect(next).toHaveLength(1);
			expect(next[0].text).toBe("replacement");
		});

		it("wakes at the duration deadline even when it is sooner than the interrupt window", async () => {
			await mode.handleLoopCommand("1s 5s repeat this");
			mode.setLoopPrompt("repeat this");
			await advance(700);
			const next = waitForNextInput();
			await advance(299);
			expect(mode.loopModeEnabled).toBe(true);
			await advance(1);
			expect(next).toHaveLength(0);
			expect(mode.loopModeEnabled).toBe(false);
		});

		it("expires at the deadline while post-prompt work blocks maintenance retries", async () => {
			Object.defineProperty(session, "hasPostPromptWork", { configurable: true, get: () => true });
			await mode.handleLoopCommand("2s 1s repeat this");
			mode.setLoopPrompt("repeat this");
			const next = waitForNextInput();
			await advance(1_000);
			expect(next).toHaveLength(0);
			expect(mode.loopModeEnabled).toBe(true);
			await advance(800);
			expect(mode.loopModeEnabled).toBe(true);
			await advance(200);
			expect(next).toHaveLength(0);
			expect(mode.loopModeEnabled).toBe(false);
		});

		it("polls blocked submissions without spending budget or waiting another full interval", async () => {
			let streaming = true;
			Object.defineProperty(session, "isStreaming", { configurable: true, get: () => streaming });
			await mode.handleLoopCommand("3 5s repeat this");
			mode.setLoopPrompt("repeat this");
			const next = waitForNextInput();
			await advance(5_000);
			expect(next).toHaveLength(0);
			expect(mode.loopLimit).toEqual({ kind: "iterations", initial: 3, remaining: 2 });
			streaming = false;
			await advance(799);
			expect(next).toHaveLength(0);
			await advance(1);
			expect(next).toHaveLength(1);
			expect(mode.loopLimit).toEqual({ kind: "iterations", initial: 3, remaining: 1 });
		});

		it("does not recompact or repeat the interval while waiting for compact maintenance to settle", async () => {
			cfgLoopMode.set(settings, "compact");
			let streaming = false;
			Object.defineProperty(session, "isStreaming", { configurable: true, get: () => streaming });
			const compact = vi.spyOn(mode, "handleCompactCommand").mockImplementation(async () => {
				streaming = true;
				return "ok";
			});
			await mode.handleLoopCommand("3 5s repeat this");
			mode.setLoopPrompt("repeat this");
			const next = waitForNextInput();
			await advance(5_000);
			expect(compact).toHaveBeenCalledTimes(1);
			expect(next).toHaveLength(0);
			expect(mode.loopLimit).toEqual({ kind: "iterations", initial: 3, remaining: 1 });
			streaming = false;
			await advance(800);
			expect(compact).toHaveBeenCalledTimes(1);
			expect(next).toHaveLength(1);
			expect(mode.loopLimit).toEqual({ kind: "iterations", initial: 3, remaining: 1 });
		});

		describe("compaction-queued first turn", () => {
			let finishFirstTurn: (() => void) | undefined;

			beforeEach(() => {
				vi.spyOn(mode, "updatePendingMessagesDisplay").mockImplementation(() => {});
			});

			afterEach(async () => {
				mode.pauseLoop();
				finishFirstTurn?.();
				finishFirstTurn = undefined;
				await flushMicrotasks();
				mode.compactionQueuedMessages = [];
				mode.locallySubmittedUserSignatures.delete("queued first turn\u00000");
			});

			async function queueFirstTurn(command = "/loop 3 5s queued first turn") {
				let compacting = true;
				let streaming = false;
				const turn = Promise.withResolvers<boolean>();
				Object.defineProperty(session, "isCompacting", { configurable: true, get: () => compacting });
				Object.defineProperty(session, "isStreaming", { configurable: true, get: () => streaming });
				const prompt = vi.spyOn(session, "prompt").mockImplementation(() => {
					streaming = true;
					return turn.promise;
				});
				finishFirstTurn = () => {
					streaming = false;
					turn.resolve(true);
				};

				new InputController(mode).setupEditorSubmitHandler();
				const resolved = waitForNextInput();
				await mode.editor.onSubmit?.(command);
				await flushMicrotasks();
				expect(mode.compactionQueuedMessages).toEqual([
					{ text: "queued first turn", mode: "steer", images: undefined, draftDetached: true },
				]);
				expect(prompt).not.toHaveBeenCalled();
				expect(resolved).toHaveLength(0);

				compacting = false;
				await mode.flushCompactionQueue({ willRetry: false });
				await flushMicrotasks();
				expect(prompt).toHaveBeenCalledTimes(1);
				expect(prompt).toHaveBeenCalledWith("queued first turn", {
					streamingBehavior: "steer",
					images: undefined,
				});
				expect(mode.compactionQueuedMessages).toEqual([]);
				expect(resolved).toHaveLength(0);

				return {
					prompt,
					resolved,
					finish: async () => {
						finishFirstTurn?.();
						await flushMicrotasks();
					},
				};
			}

			it.each([2_000, 20_000])(
				"waits a complete positional interval after a queued first turn lasting %i ms",
				async durationMs => {
					const first = await queueFirstTurn();
					await advance(durationMs);
					expect(first.resolved).toHaveLength(0);
					expect(first.prompt).toHaveBeenCalledTimes(1);
					expect(mode.loopLimit).toEqual({ kind: "iterations", initial: 3, remaining: 2 });

					await first.finish();
					await advance(4_999);
					expect(first.resolved).toHaveLength(0);
					await advance(1);
					expect(first.resolved).toHaveLength(1);
					expect(first.resolved[0].text).toBe("queued first turn");
					expect(mode.loopLimit).toEqual({ kind: "iterations", initial: 3, remaining: 1 });

					// The original input waiter is consumed only once; no second
					// submission or budget consumption may leak out of retry timers.
					await advance(10_000);
					expect(first.resolved).toHaveLength(1);
					expect(first.prompt).toHaveBeenCalledTimes(1);
					expect(mode.loopLimit).toEqual({ kind: "iterations", initial: 3, remaining: 1 });
				},
			);

			it.each([200, 2_000])(
				"preserves the interrupt window without an interval after a queued first turn lasting %i ms",
				async durationMs => {
					const first = await queueFirstTurn("/loop 3 queued first turn");
					await advance(durationMs);
					expect(first.resolved).toHaveLength(0);
					expect(mode.loopLimit).toEqual({ kind: "iterations", initial: 3, remaining: 3 });
					await first.finish();

					// Legacy loops keep polling on the original interrupt cadence;
					// finishing a queued turn does not start a fresh 800 ms wait.
					const untilNextPoll = 800 - (durationMs % 800);
					await advance(untilNextPoll - 1);
					expect(first.resolved).toHaveLength(0);
					await advance(1);
					expect(first.resolved).toHaveLength(1);
					expect(first.resolved[0].text).toBe("queued first turn");
					expect(first.prompt).toHaveBeenCalledTimes(1);
					expect(mode.loopLimit).toEqual({ kind: "iterations", initial: 3, remaining: 2 });
				},
			);

			it.each(["pauseLoop", "disableLoopMode"] as const)(
				"does not rearm after %s while the queued first turn is still running",
				async cancel => {
					const first = await queueFirstTurn();
					await advance(1_000);
					mode[cancel]();
					await first.finish();
					await advance(20_000);

					expect(first.resolved).toHaveLength(0);
					expect(first.prompt).toHaveBeenCalledTimes(1);
					expect(mode.loopPrompt).toBeUndefined();
					expect(mode.loopModeEnabled).toBe(cancel === "pauseLoop");
				},
			);

			it.each(["queued first turn", "replacement"])(
				"does not rearm a queued turn after its prompt is superseded by %s",
				async replacement => {
					const first = await queueFirstTurn();
					await advance(1_000);
					mode.setLoopPrompt(replacement);
					await first.finish();
					await advance(20_000);

					expect(first.resolved).toHaveLength(0);
					expect(first.prompt).toHaveBeenCalledTimes(1);
					expect(mode.loopPrompt).toBe(replacement);
					expect(mode.loopLimit).toEqual({ kind: "iterations", initial: 3, remaining: 2 });
				},
			);
		});
	});

	describe("continue condition", () => {
		function idleSession(): void {
			Object.defineProperty(session, "isCompacting", { configurable: true, get: () => false });
			Object.defineProperty(session, "isStreaming", { configurable: true, get: () => false });
			Object.defineProperty(session, "hasPostPromptWork", { configurable: true, get: () => false });
		}

		function armLoop(prompt: string): SubmittedUserInput[] {
			const resolved: SubmittedUserInput[] = [];
			mode.loopModeEnabled = true;
			mode.loopPrompt = prompt;
			pendingInput = mode.getUserInput();
			void pendingInput.then(input => resolved.push(input));
			return resolved;
		}

		it("submits the next iteration when the condition says continue", async () => {
			vi.useFakeTimers();
			idleSession();
			const evaluate = vi.spyOn(loopCondition, "evaluateLoopCondition").mockResolvedValue({ kind: "continue" });
			mode.loopCondition = { command: "test -f GO", until: false };

			const resolved = armLoop("keep going");
			vi.advanceTimersByTime(800);
			await flushMicrotasks();

			expect(evaluate).toHaveBeenCalledTimes(1);
			expect(evaluate.mock.calls[0][0]).toEqual({ command: "test -f GO", until: false });
			expect(resolved).toHaveLength(1);
			expect(resolved[0].text).toBe("keep going");
			expect(mode.loopModeEnabled).toBe(true);
		});

		it("disables the loop and submits nothing when the condition says halt", async () => {
			vi.useFakeTimers();
			idleSession();
			vi.spyOn(loopCondition, "evaluateLoopCondition").mockResolvedValue({
				kind: "halt",
				message: "Loop condition `bun test` is now satisfied. Loop mode disabled.",
			});
			const showStatus = vi.spyOn(mode, "showStatus");
			mode.loopCondition = { command: "bun test", until: true };

			const resolved = armLoop("fix the tests");
			vi.advanceTimersByTime(800);
			await flushMicrotasks();

			expect(resolved).toHaveLength(0);
			expect(mode.loopModeEnabled).toBe(false);
			expect(showStatus).toHaveBeenCalledWith("Loop condition `bun test` is now satisfied. Loop mode disabled.");
		});

		// A halted iteration never ran, so it must not spend the user's budget:
		// `/loop 3 --until ...` that stops early should still report 3 remaining.
		it("does not consume the iteration budget when the condition halts", async () => {
			vi.useFakeTimers();
			idleSession();
			vi.spyOn(loopCondition, "evaluateLoopCondition").mockResolvedValue({ kind: "halt", message: "stop" });
			mode.loopCondition = { command: "bun test", until: true };
			const limit = { kind: "iterations", initial: 3, remaining: 3 } as const;
			mode.loopLimit = { ...limit };
			const observed = mode.loopLimit;

			armLoop("fix the tests");
			vi.advanceTimersByTime(800);
			await flushMicrotasks();

			expect(observed).toEqual(limit);
		});

		// Esc between iterations must kill the child process and skip the
		// iteration without tearing down loop mode, and the late verdict that
		// arrives afterwards must not resurrect the cancelled iteration.
		it("aborts an in-flight condition on pause and ignores its late verdict", async () => {
			vi.useFakeTimers();
			idleSession();
			const pending = Promise.withResolvers<LoopConditionVerdict>();
			let captured: AbortSignal | undefined;
			vi.spyOn(loopCondition, "evaluateLoopCondition").mockImplementation(async (_condition, options) => {
				captured = options.signal;
				return await pending.promise;
			});
			mode.loopCondition = { command: "sleep 30", until: false };

			const resolved = armLoop("keep going");
			vi.advanceTimersByTime(800);
			await flushMicrotasks();

			expect(captured?.aborted).toBe(false);

			mode.pauseLoop();
			expect(captured?.aborted).toBe(true);
			expect(mode.loopModeEnabled).toBe(true);
			expect(mode.loopModePaused).toBe(true);

			pending.resolve({ kind: "continue" });
			await flushMicrotasks();

			expect(resolved).toHaveLength(0);
			expect(mode.loopModeEnabled).toBe(true);
		});

		// A manual submit while the gate is still running supersedes it: the
		// stale-verdict guard alone would let a `sleep 30`-style condition (or a
		// mutating command) keep running concurrently with the replacement turn
		// for up to the configured timeout instead of being killed immediately.
		it("aborts an in-flight condition as soon as a manual prompt supersedes it", async () => {
			vi.useFakeTimers();
			idleSession();
			const pending = Promise.withResolvers<LoopConditionVerdict>();
			let captured: AbortSignal | undefined;
			vi.spyOn(loopCondition, "evaluateLoopCondition").mockImplementation(async (_condition, options) => {
				captured = options.signal;
				return await pending.promise;
			});
			mode.loopCondition = { command: "sleep 30", until: false };

			armLoop("keep going");
			vi.advanceTimersByTime(800);
			await flushMicrotasks();

			expect(captured?.aborted).toBe(false);

			mode.setLoopPrompt("a different manual prompt");
			expect(captured?.aborted).toBe(true);
		});

		// A manual submit that happens to repeat the current loop prompt still
		// supersedes the pending gate: an equality check on the prompt text alone
		// would leave a `sleep 30`-style condition running concurrently with the
		// resubmitted turn instead of aborting it immediately.
		it("aborts an in-flight condition when the manual submission repeats the loop prompt", async () => {
			vi.useFakeTimers();
			idleSession();
			const pending = Promise.withResolvers<LoopConditionVerdict>();
			let captured: AbortSignal | undefined;
			vi.spyOn(loopCondition, "evaluateLoopCondition").mockImplementation(async (_condition, options) => {
				captured = options.signal;
				return await pending.promise;
			});
			mode.loopCondition = { command: "sleep 30", until: false };

			armLoop("keep going");
			vi.advanceTimersByTime(800);
			await flushMicrotasks();

			expect(captured?.aborted).toBe(false);

			mode.setLoopPrompt("keep going");
			expect(captured?.aborted).toBe(true);
		});

		// /vibe enabled while the gate is awaiting must kill a reset loop: the
		// pre-gate guard is stale by then, and handleClearCommand would only
		// warn while the iteration still submitted without resetting. Goes
		// through the real /vibe command so the vibeModeEnabled transition is
		// exercised instead of assigned directly.
		it("disables a reset loop when vibe is enabled while the condition is in flight", async () => {
			vi.useFakeTimers();
			cfgLoopMode.set(settings, "reset");
			idleSession();
			const pending = Promise.withResolvers<LoopConditionVerdict>();
			vi.spyOn(loopCondition, "evaluateLoopCondition").mockImplementation(async () => await pending.promise);
			const clear = vi.spyOn(mode, "handleClearCommand");
			const showStatus = vi.spyOn(mode, "showStatus");
			vi.spyOn(session, "activateVibeTools").mockResolvedValue();
			mode.loopCondition = { command: "sleep 30", until: false };

			const resolved = armLoop("reset me");
			vi.advanceTimersByTime(800);
			await flushMicrotasks();

			await mode.handleVibeModeCommand();
			expect(mode.vibeModeEnabled).toBe(true);
			pending.resolve({ kind: "continue" });
			await flushMicrotasks();

			expect(clear).not.toHaveBeenCalled();
			expect(resolved).toHaveLength(0);
			expect(mode.loopModeEnabled).toBe(false);
			expect(mode.loopPrompt).toBeUndefined();
			expect(showStatus).toHaveBeenCalledWith("Exit vibe mode before using reset loops. Loop mode disabled.");
		});

		// The condition can resolve while /vibe tool activation is still in
		// flight: vibeModeEnabled is still false, but the reset must not run
		// concurrently with the toolset switch. The loop must disable on the
		// entering transition, not just the settled flag.
		it("disables a reset loop when the condition resolves during vibe activation", async () => {
			vi.useFakeTimers();
			cfgLoopMode.set(settings, "reset");
			idleSession();
			const pending = Promise.withResolvers<LoopConditionVerdict>();
			vi.spyOn(loopCondition, "evaluateLoopCondition").mockImplementation(async () => await pending.promise);
			const clear = vi.spyOn(mode, "handleClearCommand");
			const showStatus = vi.spyOn(mode, "showStatus");
			const vibeGate = Promise.withResolvers<void>();
			vi.spyOn(session, "activateVibeTools").mockImplementation(() => vibeGate.promise);
			mode.loopCondition = { command: "sleep 30", until: false };

			const resolved = armLoop("reset me");
			vi.advanceTimersByTime(800);
			await flushMicrotasks();

			const vibeEnter = mode.handleVibeModeCommand();
			await flushMicrotasks();
			expect(mode.vibeModeEnabled).toBe(false);

			pending.resolve({ kind: "continue" });
			await flushMicrotasks();

			expect(clear).not.toHaveBeenCalled();
			expect(resolved).toHaveLength(0);
			expect(mode.loopModeEnabled).toBe(false);
			expect(mode.loopPrompt).toBeUndefined();
			expect(showStatus).toHaveBeenCalledWith("Exit vibe mode before using reset loops. Loop mode disabled.");

			vibeGate.resolve();
			await vibeEnter;
			expect(mode.vibeModeEnabled).toBe(true);
		});
	});

	it("resubmits a /skill: prompt dispatched inline by the submit handler", async () => {
		vi.useFakeTimers();
		const skillPath = path.join(tempDir.path(), "recap.md");
		await Bun.write(skillPath, "---\nname: recap\n---\nSummarize recent changes.\n");
		mode.skillCommands.set("skill:recap", {
			name: "recap",
			description: "",
			filePath: skillPath,
			baseDir: tempDir.path(),
			source: "test",
		});
		new InputController(mode).setupEditorSubmitHandler();
		const promptCustomMessage = vi.spyOn(session, "promptCustomMessage").mockResolvedValue(true);
		Object.defineProperty(session, "isStreaming", { configurable: true, get: () => false });
		Object.defineProperty(session, "isCompacting", { configurable: true, get: () => false });

		mode.disableLoopMode();
		mode.loopModeEnabled = true;
		const resolved: SubmittedUserInput[] = [];
		pendingInput = mode.getUserInput();
		void pendingInput.then(input => resolved.push(input));

		await mode.editor.onSubmit?.("/skill:recap go");

		expect(promptCustomMessage).toHaveBeenCalledTimes(1);
		expect(mode.loopPrompt).toBe("/skill:recap go");
		expect(resolved).toHaveLength(0);

		vi.advanceTimersByTime(800);
		await flushMicrotasks();

		expect(resolved).toHaveLength(1);
		expect(resolved[0].text).toBe("/skill:recap go");
		mode.skillCommands.delete("skill:recap");
	});

	it("paints no optimistic user row for a resubmitted /skill: loop prompt", async () => {
		vi.useFakeTimers();
		const skillPath = path.join(tempDir.path(), "recap.md");
		await Bun.write(skillPath, "---\nname: recap\n---\nSummarize recent changes.\n");
		mode.skillCommands.set("skill:recap", {
			name: "recap",
			description: "",
			filePath: skillPath,
			baseDir: tempDir.path(),
			source: "test",
		});
		Object.defineProperty(session, "isCompacting", { configurable: true, get: () => false });
		Object.defineProperty(session, "isStreaming", { configurable: true, get: () => false });

		mode.loopModeEnabled = true;
		mode.loopPrompt = "/skill:recap go";
		const resolved: SubmittedUserInput[] = [];
		pendingInput = mode.getUserInput();
		void pendingInput.then(input => resolved.push(input));

		vi.advanceTimersByTime(800);
		await flushMicrotasks();

		expect(resolved).toHaveLength(1);
		expect(resolved[0].text).toBe("/skill:recap go");
		// A plain loop prompt paints one; the skill row comes from the dispatched
		// custom message instead.
		expect(mode.addMessageToChat).not.toHaveBeenCalled();
		mode.skillCommands.delete("skill:recap");
	});

	it("paints an optimistic user row for a resubmitted plain loop prompt", async () => {
		vi.useFakeTimers();
		Object.defineProperty(session, "isCompacting", { configurable: true, get: () => false });
		Object.defineProperty(session, "isStreaming", { configurable: true, get: () => false });

		mode.loopModeEnabled = true;
		mode.loopPrompt = "repeat this";
		const resolved: SubmittedUserInput[] = [];
		pendingInput = mode.getUserInput();
		void pendingInput.then(input => resolved.push(input));

		vi.advanceTimersByTime(800);
		await flushMicrotasks();

		expect(resolved).toHaveLength(1);
		expect(mode.addMessageToChat).toHaveBeenCalledTimes(1);
	});
});
