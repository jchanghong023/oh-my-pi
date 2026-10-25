import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ToolResultMessage, Usage } from "@oh-my-pi/pi-ai";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { bindEffects } from "@oh-my-pi/pi-coding-agent/config/registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import {
	cfgDisplayCompactToolActivity,
	cfgDisplayHideToolActivity,
	cfgStartupQuiet,
} from "@oh-my-pi/pi-coding-agent/modes/settings";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	peekSpecDrivenController,
	type SpecControllerObservation,
} from "@oh-my-pi/pi-coding-agent/spec-driven/controller";
import { TempDir } from "@oh-my-pi/pi-utils";
import { chatTranscriptDisplayPreferences } from "@oh-my-pi/pi-tui/chat/display-preferences";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";

function plainRows(rows: readonly string[]): string[] {
	return rows.map(row => Bun.stripANSI(row).trimEnd());
}

function dump(label: string, rows: readonly string[]): void {
	console.log(`==== ${label} ====`);
	for (const [i, row] of rows.entries()) console.log(String(i).padStart(3), JSON.stringify(row));
}

describe("libkitty end-to-end", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;
	let term: VirtualTerminal;
	let releaseSessionEffects: (() => void) | undefined;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-libkitty-e2e-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		// Keep the welcome header visible for the resize assertions.
		cfgStartupQuiet.set(Settings.instance, false);
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
			// Native /dev requires the root session's real manager; session.dispose owns teardown.
			ownedAsyncJobManager: new AsyncJobManager({}),
		});
		term = new VirtualTerminal(120, 32);
		const composer = new Composer({ terminal: term });
		mode = new InteractiveMode(session, "test", undefined, () => {}, undefined, undefined, undefined, composer);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		mode?.stop();
		// Settle fixture-owned input after assertions so its keepalive is disposed.
		mode?.onInputCallback?.({ text: "", cancelled: true, started: false });
		await Promise.resolve();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		releaseSessionEffects?.();
		releaseSessionEffects = undefined;
		resetSettingsForTest();
	});

	// Keep the real controller registry, observation subscription, slash-command
	// dispatch and terminal dialogs; replace only the workflow's local state.
	async function devHelpFixture() {
		await mode.init({ suppressWelcomeIntro: true });
		void mode.getUserInput();
		await mode.handleDevInput("/dev");
		const controller = peekSpecDrivenController(session.sessionManager);
		if (!controller) throw new Error("Expected native dev controller");
		controller.setInputMode("chat");
		const observation: SpecControllerObservation = {
			...controller.observation(),
			runId: "automatic-help-run",
			status: {
				...controller.status(),
				phase: "awaiting-specification",
				generation: 1,
				specification: {
					version: "spec-v1",
					proposal: "Display the result",
					specs: [],
					requirements: [{ id: "R1", text: "Display the result" }],
					questions: [],
				},
			},
		};
		vi.spyOn(controller, "status").mockImplementation(() => observation.status);
		vi.spyOn(controller, "observation").mockImplementation(() => ({
			...observation,
			interaction: { ...observation.interaction, actions: controller.actions() },
		}));
		const panel = vi.spyOn(mode, "showHookCustom");
		const schedule = vi.spyOn(controller, "schedule").mockReturnValue("automatic-help-job");
		const cancel = vi.spyOn(controller, "cancel");
		const visible = () =>
			mode.ui.hasOverlay() && plainRows(term.getViewport()).some(row => row.includes("Display the result"));
		return { controller, observation, panel, schedule, cancel, visible };
	}

	it("shows an unstarted dev destination without starting a workflow or inventing a requirements stage", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		void mode.getUserInput();
		await mode.handleDevInput("/dev");
		const controller = peekSpecDrivenController(session.sessionManager);
		if (!controller) throw new Error("Expected native dev controller");
		const viewport = () => plainRows(term.getViewport()).join("\n");
		await term.waitForRender(() => viewport().includes("尚未启动"));
		expect(viewport()).toContain("/dev help");
		expect(controller.observation()).toMatchObject({
			runId: null,
			status: { phase: "idle" },
			interaction: { mode: "dev" },
		});
		expect(viewport()).not.toContain("协同开发模式：需求");
		expect(mode.ui.hasOverlay()).toBe(false);
	});

	it("persists one compact TUI report without raw status echo and retains explicit diagnostic facts", async () => {
		const f = await devHelpFixture();
		f.observation.status.questions = ["Which result should be displayed, and where?"];
		const append = vi.spyOn(session, "appendCustomMessage");
		const rawStatus = vi.spyOn(mode, "showStatus");
		await f.controller.report();
		expect(append).toHaveBeenCalledTimes(1);
		const summary = append.mock.calls[0]![0];
		if (typeof summary === "string") throw new Error("Expected structured spec-driven custom message");
		expect(summary).toMatchObject({ customType: "spec-driven", display: true });
		expect(summary.content).toContain("Which result should be displayed, and where?");
		expect(summary.content).not.toContain("spec-v1");
		expect(summary.content).not.toContain("/dev confirm-spec");
		expect(summary.content).not.toContain("实际投入");
		expect(rawStatus).not.toHaveBeenCalled();

		await f.controller.report({ rawPhase: true });
		expect(append).toHaveBeenCalledTimes(2);
		const detailMessage = append.mock.calls[1]![0];
		if (typeof detailMessage === "string") throw new Error("Expected structured spec-driven custom message");
		expect(detailMessage).toMatchObject({ customType: "spec-driven", display: true });
		const details = detailMessage.content;
		expect(details).toContain("awaiting-specification");
		expect(details).toContain("spec-v1");
		expect(details).toContain("Display the result");
		expect(details).toContain("/dev confirm-spec spec-v1");
		expect(rawStatus).not.toHaveBeenCalled();
		expect(f.schedule).not.toHaveBeenCalled();
	});

	it("rebinds report output ownership when switching between custom-message and text hosts", async () => {
		const f = await devHelpFixture();
		const firstHost = vi.fn();
		const textHost = vi.fn();
		f.controller.setOutput(firstHost, true);
		await f.controller.report();
		expect(firstHost).not.toHaveBeenCalled();
		f.controller.setOutput(textHost);
		await f.controller.report();
		expect(textHost).toHaveBeenCalledTimes(1);
		expect(textHost.mock.calls[0]![0]).toContain("/dev confirm-spec spec-v1");
		f.controller.setOutput(firstHost, true);
		await f.controller.report();
		expect(firstHost).not.toHaveBeenCalled();
		expect(textHost).toHaveBeenCalledTimes(1);
	});

	it("automatically opens dev help in background chat while preserving the draft and dismisses each wait only once", async () => {
		const f = await devHelpFixture();
		const draft = "unsent ordinary chat draft";
		mode.editor.setText(draft);
		const image = {
			type: "image" as const,
			data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aE2kAAAAASUVORK5CYII=",
			mimeType: "image/png",
		};
		mode.editor.pendingImages.push(image);
		mode.editor.pendingImageLinks.push(undefined);
		f.controller.publishObservation();
		await term.waitForRender(f.visible);
		expect(f.visible()).toBe(true);
		expect(f.panel).toHaveBeenCalledTimes(1);
		expect(plainRows(term.getViewport()).join("\n")).not.toContain("/dev confirm-spec spec-v1");
		// The initial material inspection must never authorize the transition.
		term.sendInput("\r");
		await term.waitForRender(f.visible);
		expect(f.visible()).toBe(true);
		expect(f.schedule).not.toHaveBeenCalled();
		expect(f.controller.inputMode()).toBe("chat");
		expect(mode.editor.getExpandedText()).toBe(draft);
		expect(mode.editor.pendingImages).toEqual([image]);

		term.sendInput("\x1b");
		await term.waitForRender(() => !f.visible());
		expect(f.visible()).toBe(false);
		expect(f.schedule).not.toHaveBeenCalled();
		expect(f.cancel).not.toHaveBeenCalled();
		f.observation.updatedAt++;
		f.controller.publishObservation();
		f.controller.publishObservation();
		// Let the deferred automatic-help timer elapse before a negative assertion.
		await Bun.sleep(150);
		await term.waitForRender();
		expect(f.panel).toHaveBeenCalledTimes(1);
		expect(mode.editor.getExpandedText()).toBe(draft);
		expect(mode.editor.pendingImages).toEqual([image]);
		expect(mode.editor.pendingImageLinks).toEqual([undefined]);

		// A fresh work round ending at the same decision must notify again.
		f.observation.active = true;
		f.controller.publishObservation();
		f.observation.active = false;
		f.controller.publishObservation();
		await term.waitForRender(f.visible);
		expect(f.visible()).toBe(true);
		expect(f.panel).toHaveBeenCalledTimes(2);
		expect(f.schedule).not.toHaveBeenCalled();
	});

	it("does not automatically open dev help while active or any user message is unsettled", async () => {
		const f = await devHelpFixture();
		f.observation.active = true;
		f.controller.publishObservation();
		await Bun.sleep(150);
		await term.waitForRender();
		expect(f.panel).not.toHaveBeenCalled();
		f.observation.active = false;
		for (const status of ["queued", "processing", "cancelling"] as const) {
			f.observation.interaction.messages = [
				{
					id: "pending-message",
					text: "clarify the result",
					runId: f.observation.runId!,
					generation: 1,
					phase: "awaiting-specification",
					role: "requirements",
					actorId: "requirements-agent",
					sessionId: "requirements-session",
					status,
				},
			];
			f.controller.publishObservation();
			await Bun.sleep(150);
			await term.waitForRender();
			expect(f.panel).not.toHaveBeenCalled();
		}
		f.observation.interaction.messages[0]!.status = "completed";
		f.controller.publishObservation();
		await term.waitForRender(f.visible);
		expect(f.visible()).toBe(true);
		expect(f.panel).toHaveBeenCalledTimes(1);
		expect(f.schedule).not.toHaveBeenCalled();
	});

	it("defers automatic help behind another dialog and does not reopen a manually dismissed help window", async () => {
		const f = await devHelpFixture();
		const otherDialog = mode.showHookInput("Existing question");
		f.controller.publishObservation();
		await Bun.sleep(150);
		expect(f.panel).not.toHaveBeenCalled();
		term.sendInput("\x1b");
		await otherDialog;
		await term.waitForRender(f.visible);
		expect(f.visible()).toBe(true);
		term.sendInput("\x1b");
		await term.waitForRender(() => !f.visible());

		await mode.handleDevInput("/dev status");
		const manualHelp = mode.handleDevInput("/dev help");
		await term.waitForRender(f.visible);
		expect(f.visible()).toBe(true);
		term.sendInput("\x1b");
		await manualHelp;
		await Bun.sleep(150);
		expect(f.panel).toHaveBeenCalledTimes(2);
		expect(f.visible()).toBe(false);
		expect(f.schedule).not.toHaveBeenCalled();
		expect(f.cancel).not.toHaveBeenCalled();
	});

	it("paints the submitted user message before any model reply", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		const pending = mode.getUserInput();
		await term.waitForRender();

		term.sendInput("hi there omp");
		await term.waitForRender();
		term.sendInput("\r");
		const input = await pending;
		expect(input.text).toBe("hi there omp");

		// The optimistic user-message block must be on the physical screen now,
		// before any assistant output exists.
		await term.waitForRender(() => plainRows(term.getViewport()).some(row => row.includes("hi there omp")));
		const viewport = plainRows(term.getViewport());
		const hits = viewport.filter(row => row.includes("hi there omp"));
		if (hits.length !== 1) dump("viewport after submit", viewport);
		expect(hits.length).toBe(1);
	});

	for (const [label, key] of [
		["Enter", "\r"],
		["Ctrl+Enter", "\x1b[13;5u"],
	] as const) {
		it(`${label} retains unstarted dev text without entering the ordinary model or continuation loop`, async () => {
			await mode.init({ suppressWelcomeIntro: true });
			const outerInputs: string[] = [];
			void mode.getUserInput().then(input => outerInputs.push(input.text));
			const prompt = vi.spyOn(session, "prompt").mockResolvedValue(true);
			term.sendInput("/dev");
			term.sendInput("\r");
			await term.waitForRender(() => peekSpecDrivenController(session.sessionManager)?.inputMode() === "dev");
			const controller = peekSpecDrivenController(session.sessionManager);
			expect(controller?.inputMode()).toBe("dev");

			for (const text of ["new requirement", ".", "c", "继续", "可以", "同意"]) {
				mode.editor.setText(text);
				term.sendInput(key);
				await term.waitForRender(() => controller?.observation().interaction.draft === text);
				expect(controller?.observation().interaction.draft).toBe(text);
				expect(controller?.observation().runId).toBeNull();
				expect(controller?.observation().interaction.messages).toEqual([]);
				expect(outerInputs).toEqual([]);
				expect(prompt).not.toHaveBeenCalled();
				expect(session.agent.state.messages).toEqual([]);
			}

			// This is a persistent composer projection, not only the toggle's
			// transcript notice: the destination remains after editing and resize.
			term.resize(110, 30);
			await term.waitForRender();
			const viewport = plainRows(term.getViewport()).join("\n");
			expect(viewport).toContain("协同开发模式 →");
		});

		it(`${label} rejects unknown and skill commands in dev instead of expanding an outer prompt`, async () => {
			await mode.init({ suppressWelcomeIntro: true });
			const outerInputs: string[] = [];
			void mode.getUserInput().then(input => outerInputs.push(input.text));
			const prompt = vi.spyOn(session, "prompt").mockResolvedValue(true);
			const customPrompt = vi.spyOn(session, "promptCustomMessage").mockResolvedValue(true);
			const skillPath = path.join(tempDir.path(), "review-skill.md");
			await Bun.write(skillPath, "Review the implementation request.\n");
			mode.skillCommands.set("skill:review", {
				name: "review",
				description: "Review the implementation request",
				filePath: skillPath,
				baseDir: tempDir.path(),
				source: "test",
			});
			term.sendInput("/dev");
			term.sendInput("\r");
			await term.waitForRender(() => peekSpecDrivenController(session.sessionManager)?.inputMode() === "dev");
			const controller = peekSpecDrivenController(session.sessionManager);
			expect(controller?.inputMode()).toBe("dev");
			const error = vi.spyOn(mode, "showError");
			const warning = vi.spyOn(mode, "showWarning");
			for (const text of ["/not-a-real-dev-command", "/skill:review implement this", "/opsx-explore inspect"]) {
				const notices = error.mock.calls.length + warning.mock.calls.length;
				mode.editor.setText(text);
				term.sendInput(key);
				await term.waitForRender(() => error.mock.calls.length + warning.mock.calls.length > notices);
				expect(error.mock.calls.length + warning.mock.calls.length).toBeGreaterThan(notices);
				expect(controller?.observation().interaction.messages).toEqual([]);
				expect(controller?.observation().interaction.draft).toBe("");
				expect(outerInputs).toEqual([]);
				expect(prompt).not.toHaveBeenCalled();
				expect(customPrompt).not.toHaveBeenCalled();
			}
		});

		it(`${label} dispatches dev controls before the ordinary compaction queue`, async () => {
			await mode.init({ suppressWelcomeIntro: true });
			const outerInputs: string[] = [];
			void mode.getUserInput().then(input => outerInputs.push(input.text));
			term.sendInput("/dev");
			term.sendInput("\r");
			await term.waitForRender(() => peekSpecDrivenController(session.sessionManager)?.inputMode() === "dev");
			expect(peekSpecDrivenController(session.sessionManager)?.inputMode()).toBe("dev");
			const controller = peekSpecDrivenController(session.sessionManager);
			if (!controller) throw new Error("Expected native dev controller");
			let busy = true;
			const busyProperties = ["isCompacting", "isStreaming"] as const;
			const originalDescriptors = busyProperties.map(
				property => [property, Object.getOwnPropertyDescriptor(session, property)] as const,
			);
			try {
				// Bun cannot spy on accessors. Shadow only this session's admission
				// boundary without starting model-backed maintenance or replacing /dev.
				for (const property of busyProperties) {
					Object.defineProperty(session, property, { configurable: true, get: () => busy });
				}
				expect(session.isCompacting).toBe(true);
				expect(session.isStreaming).toBe(true);
				const prompt = vi.spyOn(session, "prompt").mockResolvedValue(true);
				const report = controller.report.bind(controller);
				let reporting: Promise<void> | undefined;
				vi.spyOn(controller, "report").mockImplementation(() => {
					expect(session.isCompacting).toBe(true);
					expect(session.isStreaming).toBe(true);
					// The control reached the native host while busy. Release the synthetic
					// state before transcript persistence waits for the idle outer agent.
					busy = false;
					reporting = report();
					return reporting;
				});
				mode.editor.setText("/dev pause");
				term.sendInput(key);
				await term.waitForRender(() => reporting !== undefined);
				expect(reporting).toBeDefined();
				await reporting;
				mode.editor.setText("/dev");
				term.sendInput(key);
				await term.waitForRender(() => peekSpecDrivenController(session.sessionManager)?.inputMode() === "chat");
				expect(peekSpecDrivenController(session.sessionManager)?.inputMode()).toBe("chat");
				expect(mode.compactionQueuedMessages).toEqual([]);
				expect(outerInputs).toEqual([]);
				expect(prompt).not.toHaveBeenCalled();
			} finally {
				for (const [property, descriptor] of originalDescriptors) {
					if (descriptor) Object.defineProperty(session, property, descriptor);
					else Reflect.deleteProperty(session, property);
				}
			}
		});
	}

	for (const changesSession of [false, true]) {
		it(`a delayed dev submission preserves a newer draft${changesSession ? " across a native session change" : ""}`, async () => {
			await mode.init({ suppressWelcomeIntro: true });
			await mode.handleDevInput("/dev");
			const originalController = peekSpecDrivenController(session.sessionManager);
			expect(originalController?.inputMode()).toBe("dev");
			if (!originalController) throw new Error("Expected native dev controller");
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const submit = originalController.submitText.bind(originalController);
			vi.spyOn(originalController, "submitText").mockImplementation(async text => {
				entered.resolve();
				await release.promise;
				return submit(text);
			});
			mode.editor.setText("submitted draft");
			const submitting = mode.handleDevInput("submitted draft");
			try {
				await Promise.race([
					entered.promise,
					submitting.then(() => {
						throw new Error("Dev submission completed without reaching the submitText interception");
					}),
				]);
				if (changesSession) {
					expect(await session.newSession()).toBe(true);
					await mode.handleDevInput("/dev");
					expect(peekSpecDrivenController(session.sessionManager)).not.toBe(originalController);
				}
				mode.editor.setText("newer unsent draft");
			} finally {
				release.resolve();
				await submitting;
			}

			const current = peekSpecDrivenController(session.sessionManager);
			expect(current?.observation().interaction.draft).toBe(changesSession ? "" : "submitted draft");
			expect(current?.observation().interaction.messages).toEqual([]);
			expect(mode.editor.getExpandedText()).toContain("newer unsent draft");
			expect(session.agent.state.messages).toEqual([]);
		});
	}

	it("keeps the released dev draft destination after cancellation and across chat toggles", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		const outerInputs: string[] = [];
		void mode.getUserInput().then(input => outerInputs.push(input.text));
		const prompt = vi.spyOn(session, "prompt").mockResolvedValue(true);
		term.sendInput("/dev");
		term.sendInput("\r");
		await term.waitForRender(() => peekSpecDrivenController(session.sessionManager)?.inputMode() === "dev");
		const controller = peekSpecDrivenController(session.sessionManager);
		if (!controller) throw new Error("Expected native dev controller");

		await controller.cancel();
		expect(controller.observation()).toMatchObject({
			released: true,
			disposed: false,
			runId: null,
			status: { phase: "cancelled" },
			interaction: { mode: "dev" },
		});
		const viewport = () => plainRows(term.getViewport()).join("\n");
		await term.waitForRender(() => viewport().includes("协同开发模式 →"));
		expect(viewport()).toContain("尚无可接收消息的阶段 Agent");

		mode.editor.setText("next requirement after cancellation");
		term.sendInput("\r");
		await term.waitForRender(
			() => controller.observation().interaction.draft === "next requirement after cancellation",
		);
		expect(controller.observation().interaction.messages).toEqual([]);
		expect(controller.observation().interaction.recipient).toBeUndefined();
		expect(outerInputs).toEqual([]);
		expect(prompt).not.toHaveBeenCalled();
		term.resize(110, 30);
		await term.waitForRender(() => viewport().includes("协同开发模式 →"));
		expect(mode.editor.getExpandedText()).toBe("next requirement after cancellation");

		mode.editor.setText("/dev");
		term.sendInput("\r");
		await term.waitForRender(() => controller.inputMode() === "chat" && !viewport().includes("协同开发模式 →"));
		expect(peekSpecDrivenController(session.sessionManager)).toBe(controller);
		expect(viewport()).not.toContain("后台协同开发：");

		mode.editor.setText("/dev");
		term.sendInput("\r");
		await term.waitForRender(() => controller.inputMode() === "dev" && viewport().includes("协同开发模式 →"));
		expect(peekSpecDrivenController(session.sessionManager)).toBe(controller);
		expect(controller.observation()).toMatchObject({
			released: true,
			runId: null,
			interaction: { draft: "next requirement after cancellation" },
		});
		mode.editor.setText("another released draft");
		term.sendInput("\r");
		await term.waitForRender(() => controller.observation().interaction.draft === "another released draft");
		expect(prompt).not.toHaveBeenCalled();
		expect(outerInputs).toEqual([]);
		expect(viewport()).toContain("协同开发模式 →");

		await controller.dispose();
		await term.waitForRender(() => !viewport().includes("协同开发模式 →"));
	});

	it("keeps dev ownership when ordinary Plan, Goal, and Vibe entrypoints conflict", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		await mode.handleDevInput("/dev");
		const controller = peekSpecDrivenController(session.sessionManager);
		expect(controller?.inputMode()).toBe("dev");
		const prompt = vi.spyOn(session, "prompt").mockResolvedValue(true);

		await expect(mode.handlePlanModeCommand("implement outside dev")).rejects.toThrow();
		await expect(mode.handleGoalModeCommand("implement outside dev")).rejects.toThrow();
		await expect(mode.handleGuidedGoalCommand("implement outside dev")).rejects.toThrow();
		await expect(mode.handleVibeModeCommand("implement outside dev")).rejects.toThrow();

		expect(controller?.inputMode()).toBe("dev");
		expect(mode.planModeEnabled).toBe(false);
		expect(mode.goalModeEnabled).toBe(false);
		expect(mode.vibeModeEnabled).toBe(false);
		expect(prompt).not.toHaveBeenCalled();
		expect(controller?.observation().runId).toBeNull();
	});

	it("keeps the whole buffer clean across non-overflowing width resizes", async () => {
		term.resize(140, 40);
		await mode.init({ suppressWelcomeIntro: true });
		void mode.getUserInput();
		await term.waitForRender();
		term.sendInput("MARKER_DRAFT");
		await term.waitForRender(() => plainRows(term.getViewport()).some(row => row.includes("MARKER_DRAFT")));

		term.resize(120, 40);
		await Bun.sleep(300);
		await term.waitForRender();
		term.resize(110, 40);
		await Bun.sleep(300);
		await term.waitForRender();

		// Content always fit the screen, so the terminal never pushed live rows
		// into scrollback: the entire buffer must hold exactly one copy.
		const buffer = plainRows(term.getScrollBuffer());
		const drafts = buffer.filter(row => row.includes("MARKER_DRAFT"));
		if (drafts.length !== 1) dump("scroll buffer after resizes", buffer);
		expect(drafts.length).toBe(1);
		const welcomes = buffer.filter(row => row.includes("vtest"));
		expect(welcomes.length).toBe(1);
	});

	it("keeps the screen exact through an overflowing shrink", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		void mode.getUserInput();
		await term.waitForRender();
		term.sendInput("MARKER_DRAFT");
		await term.waitForRender(() => plainRows(term.getViewport()).some(row => row.includes("MARKER_DRAFT")));

		// Width+height shrink: the live viewport rewraps taller than the new
		// screen, so the terminal itself pushes stale top rows into scrollback.
		// Those pushed rows are unreachable to an inline app; the contract is an
		// exact screen and no duplicate of the bottom-anchored rows anywhere.
		term.resize(88, 26);
		await Bun.sleep(300);
		await term.waitForRender();

		const viewport = plainRows(term.getViewport());
		const editors = viewport.filter(row => row.includes("MARKER_DRAFT"));
		if (editors.length !== 1) dump("viewport after overflowing shrink", viewport);
		expect(editors.length).toBe(1);
		expect(viewport.filter(row => row.includes("vtest")).length).toBeLessThanOrEqual(1);
		const buffer = plainRows(term.getScrollBuffer());
		expect(buffer.filter(row => row.includes("MARKER_DRAFT")).length).toBe(1);
	});

	it("keeps one editor through a drag storm, shrink, and grow", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		void mode.getUserInput();
		await term.waitForRender();
		term.sendInput("MARKER_DRAFT");
		await term.waitForRender(() => plainRows(term.getViewport()).some(row => row.includes("MARKER_DRAFT")));

		mode.ui.setResizeScrollback("rebuild");
		// Drag storm: several unsettled steps inside one settle window.
		term.resize(112, 30);
		await Bun.sleep(30);
		term.resize(104, 28);
		await Bun.sleep(30);
		term.resize(96, 24);
		await Bun.sleep(300);
		await term.waitForRender();
		// Height-only shrink, then a combined grow back out.
		term.resize(96, 18);
		await Bun.sleep(300);
		await term.waitForRender();

		// Observe only paints after the final resize begins: the initial frame
		// used this same size and must not satisfy the completion condition.
		let rebuiltSize: string | undefined;
		const removePaintListener = mode.ui.addPaintListener(paint => {
			if (paint.reset && !paint.alt) rebuiltSize = `${paint.columns}x${paint.rows}`;
		});
		try {
			term.resize(120, 32);
			await term.waitForRender(() => rebuiltSize === "120x32");
			// The polling helper times out without throwing. Require the actual
			// normal-buffer replay before checking for duplicate transcript rows.
			expect(rebuiltSize).toBe("120x32");

			const buffer = plainRows(term.getScrollBuffer());
			const drafts = buffer.filter(row => row.includes("MARKER_DRAFT"));
			if (drafts.length !== 1) dump("scroll buffer after drag storm", buffer);
			expect(drafts.length).toBe(1);
			const viewport = plainRows(term.getViewport());
			expect(viewport.filter(row => row.includes("vtest")).length).toBeLessThanOrEqual(1);

			// The editor is still live: typing paints into the one surviving editor.
			term.sendInput("X");
			await term.waitForRender(() => plainRows(term.getViewport()).some(row => row.includes("MARKER_DRAFTX")));
			expect(plainRows(term.getViewport()).filter(row => row.includes("MARKER_DRAFTX")).length).toBe(1);
		} finally {
			removePaintListener();
		}
	});

	it("keeps completed thinking out of native scrollback across Alt+P toggles", async () => {
		const usage: Usage = {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		const assistantText = (text: string): AssistantMessage => ({
			role: "assistant",
			content: [{ type: "text", text }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet",
			usage,
			stopReason: "stop",
			timestamp: 1,
		});
		const THINK = "RETIRED_REASONING_MARKER";
		const thinkingMessage: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: THINK },
				{ type: "text", text: "First visible answer." },
			],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet",
			usage,
			stopReason: "stop",
			timestamp: 1,
		};

		// Force finalized answers into immutable terminal history; completed
		// reasoning must never accompany them, even when visibility is toggled.
		term = new VirtualTerminal(120, 10);
		const composer = new Composer({ terminal: term });
		mode = new InteractiveMode(session, "test", undefined, () => {}, undefined, undefined, undefined, composer);
		await mode.init({ suppressWelcomeIntro: true });
		void mode.getUserInput();
		await term.waitForRender();

		// Observed reasoning unlocks Alt+P but completed turns stay history-hidden.
		mode.noteDisplayableThinkingContent(thinkingMessage);
		mode.addMessageToChat(thinkingMessage);
		for (let i = 0; i < 12; i++) {
			mode.addMessageToChat(assistantText(`Filler answer number ${i} occupying a transcript row.`));
		}

		// Drive retirement until the first visible answer reaches native scrollback.
		const committedRows = () => {
			const { baseY } = term.getBufferPosition();
			return plainRows(term.getScrollBuffer()).slice(0, baseY);
		};
		for (let i = 0; i < 20 && !committedRows().some(row => row.includes("First visible answer.")); i++) {
			mode.ui.requestRender(true);
			await term.waitForRender();
		}
		expect(committedRows().some(row => row.includes("First visible answer."))).toBe(true);
		expect(plainRows(term.getScrollBuffer()).some(row => row.includes(THINK))).toBe(false);

		// A live editor draft must survive visibility changes.
		term.sendInput("LIVE_EDITOR_DRAFT");
		await term.waitForRender(() => plainRows(term.getViewport()).some(row => row.includes("LIVE_EDITOR_DRAFT")));

		// Neither hiding nor showing current thinking may replay completed reasoning.
		for (let i = 0; i < 2; i++) {
			term.sendInput("\x1bp");
			await term.waitForRender();
			expect(plainRows(term.getScrollBuffer()).some(row => row.includes(THINK))).toBe(false);
			expect(plainRows(term.getScrollBuffer()).some(row => row.includes("First visible answer."))).toBe(true);
			expect(plainRows(term.getViewport()).some(row => row.includes("LIVE_EDITOR_DRAFT"))).toBe(true);
		}
	});
	it("hides tool activity already retired to native scrollback when the real shortcut toggles", async () => {
		const usage: Usage = {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		const TOOL_MARKER = "RETIRED_TOOL_ACTIVITY_MARKER";
		const callId = "retired-tool-call";
		const toolCall: AssistantMessage = {
			role: "assistant",
			content: [{ type: "toolCall", id: callId, name: "bash", arguments: { command: `printf ${TOOL_MARKER}` } }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet",
			usage,
			stopReason: "toolUse",
			timestamp: 1,
		};
		const toolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: callId,
			toolName: "bash",
			content: [{ type: "text", text: TOOL_MARKER }],
			isError: false,
			timestamp: 2,
		};
		const assistantText = (text: string): AssistantMessage => ({
			role: "assistant",
			content: [{ type: "text", text }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet",
			usage,
			stopReason: "stop",
			timestamp: 3,
		});

		// This shortcut test inspects detailed tool output, not compact summaries.
		cfgDisplayCompactToolActivity.set(session.settings, false);
		cfgDisplayHideToolActivity.set(session.settings, false);
		// Direct AgentSession construction bypasses the SDK's process-wide settings binding.
		releaseSessionEffects = bindEffects(session.settings);
		expect(chatTranscriptDisplayPreferences.compactToolActivity).toBe(false);
		expect(chatTranscriptDisplayPreferences.hideToolActivity).toBe(false);
		term = new VirtualTerminal(120, 10);
		const composer = new Composer({ terminal: term });
		mode = new InteractiveMode(session, "test", undefined, () => {}, undefined, undefined, undefined, composer);
		await mode.init({ suppressWelcomeIntro: true });
		void mode.getUserInput();
		await term.waitForRender();

		// Tool visibility is a global input-controller action; it reads the live keybindings.
		mode.keybindings.setUserBindings({ "app.tools.toggleVisibility": "alt+o" });
		mode.renderSessionContext({
			messages: [
				toolCall,
				toolResult,
				...Array.from({ length: 12 }, (_, i) =>
					assistantText(`Filler answer number ${i} occupying a transcript row.`),
				),
			],
			models: {},
			injectedTtsrRules: [],
			mode: "none",
		});

		const committedRows = () => {
			const { baseY } = term.getBufferPosition();
			return plainRows(term.getScrollBuffer()).slice(0, baseY);
		};
		for (let i = 0; i < 20 && !committedRows().some(row => row.includes(TOOL_MARKER)); i++) {
			mode.ui.requestRender(true);
			await term.waitForRender();
		}
		expect(committedRows().some(row => row.includes(TOOL_MARKER))).toBe(true);

		term.sendInput("LIVE_EDITOR_DRAFT");
		await term.waitForRender(() => plainRows(term.getViewport()).some(row => row.includes("LIVE_EDITOR_DRAFT")));

		// Alt+O is the configured app.tools.toggleVisibility binding from this test's keybinding manager.
		term.sendInput("\x1bo");
		await term.waitForRender(() => !plainRows(term.getScrollBuffer()).some(row => row.includes(TOOL_MARKER)));
		expect(mode.hideToolActivity).toBe(true);
		expect(plainRows(term.getScrollBuffer()).some(row => row.includes(TOOL_MARKER))).toBe(false);
		expect(plainRows(term.getViewport()).some(row => row.includes("LIVE_EDITOR_DRAFT"))).toBe(true);
	});
	it("preserves a retired long reply and Todo HUD when shaking hidden thinking", async () => {
		const usage: Usage = {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		const answer = Array.from({ length: 35 }, (_, index) => `Answer marker ${index + 1}`);
		const message: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "SHAKE_RETIRED_REASONING" },
				{ type: "text", text: answer.join("\n") },
			],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet",
			usage,
			stopReason: "stop",
			timestamp: 1,
		};
		term = new VirtualTerminal(120, 16);
		mode = new InteractiveMode(
			session,
			"test",
			undefined,
			() => {},
			undefined,
			undefined,
			undefined,
			new Composer({ terminal: term }),
		);
		session.sessionManager.appendMessage({ role: "user", content: "Show the answer", timestamp: 0 });
		session.sessionManager.appendMessage(message);
		await mode.init({ suppressWelcomeIntro: true });
		mode.setTodos([{ content: "Review answer", status: "in_progress" }]);
		await mode.renderInitialMessages({ clearTerminalHistory: true });
		await term.waitForRender(() => plainRows(term.getScrollBuffer()).some(row => row.includes("Answer marker 35")));

		const buffer = () => plainRows(term.getScrollBuffer());
		expect(buffer().some(row => row.includes("SHAKE_RETIRED_REASONING"))).toBe(false);
		await mode.handleShakeCommand("thinking");
		await term.waitForRender();

		const rows = buffer();
		expect(rows.some(row => row.includes("SHAKE_RETIRED_REASONING"))).toBe(false);
		expect(rows.filter(row => row.trim() === "Answer marker 1")).toHaveLength(1);
		expect(rows.filter(row => row.trim() === "Answer marker 35")).toHaveLength(1);
		expect(plainRows(term.getViewport()).some(row => row.includes("Review answer"))).toBe(true);

		for (const errorMessage of [undefined, "Auto-shake only partially reclaimed context"]) {
			await mode.eventController.handleEvent({
				type: "auto_compaction_end",
				action: "shake",
				result: undefined,
				aborted: false,
				willRetry: true,
				skipped: false,
				...(errorMessage ? { errorMessage } : {}),
			});
			await term.waitForRender();
			expect(buffer().filter(row => row.trim() === "Answer marker 1")).toHaveLength(1);
			expect(plainRows(term.getViewport()).some(row => row.includes("Review answer"))).toBe(true);
		}
	});
});
