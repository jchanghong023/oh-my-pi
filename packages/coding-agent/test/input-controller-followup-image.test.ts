/**
 * Regression: queuing a follow-up message (Ctrl+Enter / `app.message.followUp`)
 * with a pending clipboard-pasted image must forward the image to
 * `session.prompt`. Previously `handleFollowUp` ignored `pendingImages`, so the
 * queued message reached the model as text only and the image was silently
 * dropped.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { PromptOptions } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { USER_INTERRUPT_LABEL } from "@oh-my-pi/pi-coding-agent/session/messages";
import { Composer } from "../src/ui/composer/composer";

function createContext(opts: {
	isStreaming: boolean;
	pendingImages: ImageContent[];
	pendingImageLinks?: (string | undefined)[];
}) {
	const editor = new Composer();
	editor.pendingImages.push(...opts.pendingImages);
	editor.pendingImageLinks.push(...(opts.pendingImageLinks ?? opts.pendingImages.map(() => undefined)));
	const prompt = vi.fn(async (_text: string, options?: PromptOptions) => {
		options?.onPromptAdmitted?.();
		return true;
	});
	const updatePendingMessagesDisplay = vi.fn();
	const showError = vi.fn();

	const handleGoalModeCommand = vi.fn(async (_prompt?: string, _input?: unknown) => true);
	const handlePlanModeCommand = vi.fn(async (_prompt?: string, _input?: unknown) => true);
	const handleVibeModeCommand = vi.fn(async (_prompt?: string, _input?: unknown) => true);
	const ctx = {
		composer: editor,
		skillCommands: new Map<string, string>(),
		fileSlashCommands: new Set<string>(),
		handleDevInput: async () => false,
		isDevInputRoute: () => false,
		session: {
			isStreaming: opts.isStreaming,
			isCompacting: false,
			isBashRunning: false,
			isEvalRunning: false,
			extensionRunner: undefined,
			prompt,
		},
		loopModeEnabled: false,
		compactionQueuedMessages: [],
		locallySubmittedUserSignatures: new Set<string>(),
		updatePendingMessagesDisplay,
		showError,
		planModeEnabled: false,
		planModePaused: false,
		vibeModeEnabled: false,
		goalModeEnabled: false,
		goalModePaused: false,
		handleGoalModeCommand,
		handlePlanModeCommand,
		handleVibeModeCommand,
		withLocalSubmission: async (_text: string, fn: () => unknown) => fn(),
		sessionManager: { getSessionId: () => "session", getLeafId: () => null },
	} as unknown as InteractiveModeContext;

	return { ctx, editor, handleGoalModeCommand, handlePlanModeCommand, handleVibeModeCommand, prompt, showError };
}

describe("InputController.handleFollowUp image forwarding", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("forwards pending images to session.prompt while streaming and clears them", async () => {
		const image: ImageContent = { type: "image", mimeType: "image/png", data: "aGVsbG8=" };
		const { ctx, editor, prompt } = createContext({ isStreaming: true, pendingImages: [image] });

		const controller = new InputController(ctx);
		editor.setText("[Image #1] look at this");
		await controller.handleFollowUp();

		expect(prompt).toHaveBeenCalledTimes(1);
		const call = prompt.mock.calls[0];
		if (!call) throw new Error("expected session.prompt to be called");
		expect(call[0]).toBe("[Image #1] look at this");
		expect(call[1]?.streamingBehavior).toBe("followUp");
		expect(call[1]?.images).toEqual([image]);

		// Pending image state is consumed so the next message does not resend it.
		expect(editor.pendingImages).toEqual([]);
		expect(editor.pendingImageLinks).toEqual([]);
	});

	it.each([false, true])(
		"serializes image follow-up admission and protects a newer draft (reject=%j)",
		async rejects => {
			const image: ImageContent = { type: "image", mimeType: "image/png", data: "aGVsbG8=" };
			const { ctx, editor, prompt, showError } = createContext({
				isStreaming: true,
				pendingImages: [image],
				pendingImageLinks: ["local://draft.png"],
			});
			const preflight = Promise.withResolvers<void>();
			const runFinished = Promise.withResolvers<boolean>();
			const firstStarted = Promise.withResolvers<void>();
			const secondStarted = Promise.withResolvers<void>();
			prompt.mockImplementationOnce(async (_text, options) => {
				firstStarted.resolve();
				await preflight.promise;
				if (rejects) throw new Error("queue rejected");
				options?.onPromptAdmitted?.();
				return runFinished.promise;
			});
			prompt.mockImplementationOnce(async (_text, options) => {
				secondStarted.resolve();
				options?.onPromptAdmitted?.();
				return true;
			});
			const controller = new InputController(ctx);
			editor.setText("[Image #1] look at this");
			const first = controller.handleFollowUp();
			expect(editor.expandedText()).toBe("");
			expect(editor.pendingImages).toEqual([]);
			expect(editor.pendingImageLinks).toEqual([]);
			editor.setText("sent second");
			const second = controller.handleFollowUp();
			editor.setText("unsent draft");
			try {
				await firstStarted.promise;
				await Bun.sleep(0);
				expect(prompt).toHaveBeenCalledTimes(1);
				expect(prompt).toHaveBeenNthCalledWith(
					1,
					"[Image #1] look at this",
					expect.objectContaining({ streamingBehavior: "followUp", images: [image] }),
				);
				preflight.resolve();
				// The second prompt starts even while the first admitted response remains pending.
				await secondStarted.promise;
				expect(prompt).toHaveBeenNthCalledWith(
					2,
					"sent second",
					expect.objectContaining({ streamingBehavior: "followUp" }),
				);
				if (rejects) {
					await first;
					expect(showError).toHaveBeenCalledWith("queue rejected");
					expect(editor.expandedText()).toBe("[Image #1] look at this\n\nunsent draft");
					expect(editor.pendingImages).toEqual([image]);
					expect(editor.pendingImageLinks).toEqual(["local://draft.png"]);
				} else {
					expect(showError).not.toHaveBeenCalled();
					expect(editor.expandedText()).toBe("unsent draft");
				}
			} finally {
				preflight.resolve();
				runFinished.resolve(true);
				await Promise.all([first, second]);
			}
		},
	);

	it("restores admitted follow-up images before interrupting, alongside the newer draft", async () => {
		const image: ImageContent = { type: "image", mimeType: "image/png", data: "aGVsbG8=" };
		const newer: ImageContent = { type: "image", mimeType: "image/png", data: "ZHJhZnQ=" };
		const { ctx, editor, prompt } = createContext({ isStreaming: true, pendingImages: [image] });
		const admitted = Promise.withResolvers<void>();
		const finished = Promise.withResolvers<boolean>();
		const queue: { text: string; images?: ImageContent[] }[] = [];
		prompt.mockImplementationOnce(async (text, options) => {
			if (options?.streamingBehavior === "followUp") queue.push({ text, images: options.images });
			options?.onPromptAdmitted?.();
			admitted.resolve();
			return finished.promise;
		});
		const clearQueue = vi.fn(() => ({ steering: [], followUp: queue.splice(0) }));
		let draftAtAbort: string | undefined;
		const abort = vi.fn(async () => {
			draftAtAbort = editor.expandedText();
			finished.resolve(true);
		});
		Object.assign(ctx.session, { clearQueue, abort });
		const controller = new InputController(ctx);
		editor.setText("[Image #1] queued");
		const submitting = controller.handleFollowUp();
		try {
			await admitted.promise;
			editor.pendingImages.push(newer);
			editor.pendingImageLinks.push("local://newer.png");
			editor.setText("[Image #1] not yet sent");
			expect(controller.restoreQueuedMessagesToEditor({ abort: true })).toBe(1);
			expect(clearQueue).toHaveBeenCalledWith({ forInterrupt: true });
			expect(abort).toHaveBeenCalledWith({ reason: USER_INTERRUPT_LABEL, detachTools: true });
			expect(draftAtAbort).toBe("[Image #2] queued\n\n[Image #1] not yet sent");
			expect(editor.pendingImages).toEqual([newer, image]);
			expect(editor.pendingImageLinks).toEqual(["local://newer.png", undefined]);
		} finally {
			finished.resolve(true);
			await submitting;
		}
	});

	it("queues image-only follow-ups while streaming", async () => {
		const image: ImageContent = { type: "image", mimeType: "image/png", data: "aW1hZ2U=" };
		const { ctx, editor, prompt } = createContext({ isStreaming: true, pendingImages: [image] });

		const controller = new InputController(ctx);
		editor.setText("[Image #1]");
		await controller.handleFollowUp();

		expect(prompt).toHaveBeenCalledTimes(1);
		const call = prompt.mock.calls[0];
		if (!call) throw new Error("expected session.prompt to be called");
		expect(call[0]).toBe("[Image #1]");
		expect(call[1]?.streamingBehavior).toBe("followUp");
		expect(call[1]?.images).toEqual([image]);
		expect(editor.pendingImages).toEqual([]);
	});

	it("forwards pending images when not streaming", async () => {
		const image: ImageContent = { type: "image", mimeType: "image/png", data: "d29ybGQ=" };
		const { ctx, editor, prompt } = createContext({ isStreaming: false, pendingImages: [image] });

		const controller = new InputController(ctx);
		editor.setText("[Image #1] describe it");
		await controller.handleFollowUp();

		expect(prompt).toHaveBeenCalledTimes(1);
		const call = prompt.mock.calls[0];
		if (!call) throw new Error("expected session.prompt to be called");
		expect(call[1]?.images).toEqual([image]);
		expect(call[1]?.streamingBehavior).toBe("followUp");
		expect(editor.pendingImages).toEqual([]);
	});

	it("omits images when none are pending", async () => {
		const { ctx, editor, prompt } = createContext({ isStreaming: true, pendingImages: [] });

		const controller = new InputController(ctx);
		editor.setText("just text");
		await controller.handleFollowUp();

		expect(prompt).toHaveBeenCalledTimes(1);
		const call = prompt.mock.calls[0];
		if (!call) throw new Error("expected session.prompt to be called");
		expect(call[1]?.images).toBeUndefined();
		expect(call[1]?.streamingBehavior).toBe("followUp");
	});

	it("restores text and pending images when streaming follow-up dispatch rejects", async () => {
		const image: ImageContent = { type: "image", mimeType: "image/png", data: "aGVsbG8=" };
		const { ctx, editor, prompt, showError } = createContext({
			isStreaming: true,
			pendingImages: [image],
			pendingImageLinks: ["local://draft.png"],
		});
		prompt.mockImplementationOnce(async () => {
			throw new Error("queue rejected");
		});

		const controller = new InputController(ctx);
		editor.setText("[Image #1] look at this");
		await controller.handleFollowUp();

		expect(showError).toHaveBeenCalledWith("queue rejected");
		expect(editor.expandedText()).toBe("[Image #1] look at this");
		expect(editor.pendingImages).toEqual([image]);
		expect(editor.pendingImageLinks).toEqual(["local://draft.png"]);
	});

	it("restores image-only follow-ups when idle dispatch rejects", async () => {
		const image: ImageContent = { type: "image", mimeType: "image/png", data: "aW1hZ2U=" };
		const { ctx, editor, prompt, showError } = createContext({
			isStreaming: false,
			pendingImages: [image],
		});
		prompt.mockImplementationOnce(async () => {
			throw new Error("model not configured");
		});

		const controller = new InputController(ctx);
		editor.setText("[Image #1]");
		await controller.handleFollowUp();

		expect(showError).toHaveBeenCalledWith("model not configured");
		expect(editor.expandedText()).toBe("[Image #1]");
		expect(editor.pendingImages).toEqual([image]);
		expect(editor.pendingImageLinks).toEqual([undefined]);
	});

	it("forwards follow-up mode attachments before the command clears the draft", async () => {
		const image: ImageContent = { type: "image", mimeType: "image/png", data: "aW1hZ2U=" };
		const { ctx, editor, handleGoalModeCommand } = createContext({
			isStreaming: false,
			pendingImages: [image],
			pendingImageLinks: ["local://draft.png"],
		});

		const controller = new InputController(ctx);
		editor.setText("/goal set Ship the release [Image #1]");
		await controller.handleFollowUp();

		expect(handleGoalModeCommand).toHaveBeenCalledWith(
			"set Ship the release [Image #1]",
			expect.objectContaining({ images: [image], imageLinks: ["local://draft.png"] }),
			expect.objectContaining({ streamingBehavior: "followUp" }),
		);
		expect(editor.pendingImages).toEqual([]);
		expect(editor.pendingImageLinks).toEqual([]);
	});

	it("restores a failed Ctrl+Enter mode command submission alongside a newer draft, reporting the error exactly once", async () => {
		const image: ImageContent = { type: "image", mimeType: "image/png", data: "aW1hZ2U=" };
		const { ctx, editor, handleGoalModeCommand, showError } = createContext({
			isStreaming: false,
			pendingImages: [image],
			pendingImageLinks: ["local://draft.png"],
		});
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		handleGoalModeCommand.mockImplementationOnce(async () => {
			entered.resolve();
			await release.promise;
			throw new Error("goal setup failed");
		});

		const controller = new InputController(ctx);
		editor.setText("/goal set Ship the release [Image #1]");
		const submitting = controller.handleFollowUp();
		await entered.promise;
		// Typed after the draft detached for dispatch but before the mode
		// command settles; a failed submission must merge with this, not
		// replace or discard it.
		editor.setText("later draft");
		release.resolve();
		await submitting;

		expect(handleGoalModeCommand).toHaveBeenCalledTimes(1);
		expect(showError).toHaveBeenCalledTimes(1);
		expect(showError).toHaveBeenCalledWith("goal setup failed");
		expect(editor.expandedText()).toBe("/goal set Ship the release [Image #1]\n\nlater draft");
		expect(editor.pendingImages).toEqual([image]);
		expect(editor.pendingImageLinks).toEqual(["local://draft.png"]);
	});
});
