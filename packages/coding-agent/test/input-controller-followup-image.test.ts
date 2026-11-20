/**
 * Regression: queuing a follow-up message (Ctrl+Enter / `app.message.followUp`)
 * with a pending clipboard-pasted image must forward the image to
 * `session.prompt`. Previously `handleFollowUp` ignored `pendingImages`, so the
 * queued message reached the model as text only and the image was silently
 * dropped.
 */
import { describe, expect, it, vi } from "bun:test";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { PromptOptions } from "@oh-my-pi/pi-coding-agent/session/agent-session-types";
import { USER_INTERRUPT_LABEL } from "@oh-my-pi/pi-coding-agent/session/messages";

interface StubEditor {
	setText: (text: string) => void;
	getText: () => string;
	getExpandedText: () => string;
	setCollapsedText: (text: string) => void;
	composerChips: () => unknown[];
	addToHistory: (text: string) => void;
	imageLinks?: unknown;
	pendingImages: ImageContent[];
	pendingImageLinks: (string | undefined)[];
	clearDraft: (text?: string) => void;
}

function createContext(opts: {
	isStreaming: boolean;
	pendingImages: ImageContent[];
	pendingImageLinks?: (string | undefined)[];
}) {
	let editorText = "";
	const editor: StubEditor = {
		setText(text) {
			editorText = text;
		},
		getText() {
			return editorText;
		},
		getExpandedText() {
			return editorText;
		},
		setCollapsedText(text) {
			editorText = text;
		},
		composerChips() {
			return [];
		},
		addToHistory: vi.fn(),
		pendingImages: opts.pendingImages,
		pendingImageLinks: opts.pendingImageLinks ? [...opts.pendingImageLinks] : opts.pendingImages.map(() => undefined),
		clearDraft(text?: string) {
			if (text !== undefined) this.addToHistory(text);
			this.setText("");
			this.imageLinks = undefined;
			this.pendingImages = [];
			this.pendingImageLinks = [];
		},
	};
	const prompt = vi.fn(async (_text: string, options?: PromptOptions) => {
		options?.onPromptAdmitted?.();
		return true;
	});
	const updatePendingMessagesDisplay = vi.fn();
	const requestRender = vi.fn();
	const showError = vi.fn();

	const handleGoalModeCommand = vi.fn(async (_prompt?: string, _input?: unknown) => true);
	const handlePlanModeCommand = vi.fn(async (_prompt?: string, _input?: unknown) => true);
	const handleVibeModeCommand = vi.fn(async (_prompt?: string, _input?: unknown) => true);
	const ctx = {
		editor,
		ui: { requestRender },
		sessionManager: { getSessionId: () => "follow-up-session", getLeafId: () => null },
		handleDevInput: async () => false,
		skillCommands: new Map<string, string>(),
		fileSlashCommands: new Set<string>(),
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
	} as unknown as InteractiveModeContext;

	return { ctx, editor, handleGoalModeCommand, handlePlanModeCommand, handleVibeModeCommand, prompt, showError };
}

describe("InputController.handleFollowUp image forwarding", () => {
	it("detaches an image follow-up immediately and admits it before later follow-ups", async () => {
		const image: ImageContent = { type: "image", mimeType: "image/png", data: "aGVsbG8=" };
		const { ctx, editor, prompt } = createContext({ isStreaming: true, pendingImages: [image] });

		const preflight = Promise.withResolvers<void>();
		const runFinished = Promise.withResolvers<boolean>();
		prompt.mockImplementationOnce(async (_text, options) => {
			await preflight.promise;
			options?.onPromptAdmitted?.();
			return runFinished.promise;
		});
		const controller = new InputController(ctx);
		editor.setText("[Image #1] look at this");
		const first = controller.handleFollowUp();
		expect(editor.getText()).toBe("");
		expect(ctx.editor.pendingImages).toEqual([]);
		expect(ctx.editor.pendingImageLinks).toEqual([]);

		editor.setText("sent second");
		const second = controller.handleFollowUp();
		editor.setText("unsent draft");
		try {
			await Bun.sleep(0);
			expect(prompt).toHaveBeenCalledTimes(1);
			expect(prompt).toHaveBeenNthCalledWith(
				1,
				"[Image #1] look at this",
				expect.objectContaining({ streamingBehavior: "followUp", images: [image] }),
			);

			preflight.resolve();
			await Bun.sleep(0);
			// The first prompt is still running, but its admission releases the next draft.
			expect(prompt).toHaveBeenCalledTimes(2);
			expect(prompt).toHaveBeenNthCalledWith(
				2,
				"sent second",
				expect.objectContaining({ streamingBehavior: "followUp" }),
			);
			expect(editor.getText()).toBe("unsent draft");
		} finally {
			preflight.resolve();
			runFinished.resolve(true);
			await Promise.all([first, second]);
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
		expect(ctx.editor.pendingImages).toEqual([]);
	});

	it("forwards pending images when not streaming", async () => {
		const image: ImageContent = { type: "image", mimeType: "image/png", data: "d29ybGQ=" };
		const { ctx, editor, prompt } = createContext({ isStreaming: false, pendingImages: [image] });

		const controller = new InputController(ctx);
		editor.setText("[Image #1] describe it");
		await controller.handleFollowUp();

		expect(prompt).toHaveBeenCalledWith(
			"[Image #1] describe it",
			expect.objectContaining({ streamingBehavior: "followUp", images: [image] }),
		);
		expect(ctx.editor.pendingImages).toEqual([]);
	});

	it("restores an image draft and releases later follow-ups when dispatch rejects before admission", async () => {
		const image: ImageContent = { type: "image", mimeType: "image/png", data: "aGVsbG8=" };
		const { ctx, editor, prompt, showError } = createContext({
			isStreaming: true,
			pendingImages: [image],
			pendingImageLinks: ["local://draft.png"],
		});
		const preflight = Promise.withResolvers<void>();
		prompt.mockImplementationOnce(async () => {
			await preflight.promise;
			throw new Error("queue rejected");
		});

		const controller = new InputController(ctx);
		editor.setText("[Image #1] look at this");
		const first = controller.handleFollowUp();
		editor.setText("sent second");
		const second = controller.handleFollowUp();
		editor.setText("newer draft");
		preflight.resolve();
		await first;
		await Bun.sleep(0);

		expect(prompt).toHaveBeenNthCalledWith(
			2,
			"sent second",
			expect.objectContaining({ streamingBehavior: "followUp" }),
		);
		await second;

		expect(showError).toHaveBeenCalledWith("queue rejected");
		expect(editor.getText()).toBe("[Image #1] look at this\n\nnewer draft");
		expect(ctx.editor.pendingImages).toEqual([image]);
		expect(ctx.editor.pendingImageLinks).toEqual(["local://draft.png"]);
		expect(ctx.editor.imageLinks).toEqual(["local://draft.png"]);
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
		expect(editor.getText()).toBe("[Image #1]");
		expect(ctx.editor.pendingImages).toEqual([image]);
		expect(ctx.editor.pendingImageLinks).toEqual([undefined]);
		expect(ctx.editor.imageLinks).toEqual([undefined]);
	});

	it("restores an admitted follow-up with its image when interrupting the run", async () => {
		const queuedImage: ImageContent = { type: "image", mimeType: "image/png", data: "aGVsbG8=" };
		const draftImage: ImageContent = { type: "image", mimeType: "image/png", data: "ZHJhZnQ=" };
		const { ctx, editor, prompt } = createContext({ isStreaming: true, pendingImages: [queuedImage] });
		const queued: { text: string; images?: ImageContent[] }[] = [];
		const runFinished = Promise.withResolvers<boolean>();
		prompt.mockImplementationOnce(async (text, options) => {
			if (options?.streamingBehavior === "followUp") queued.push({ text, images: options.images });
			options?.onPromptAdmitted?.();
			return runFinished.promise;
		});
		const clearQueue = vi.fn(() => ({ steering: [], followUp: queued.splice(0) }));
		let textAtAbort: string | undefined;
		const abort = vi.fn(async () => {
			textAtAbort = editor.getText();
			runFinished.resolve(true);
		});
		Object.assign(ctx.session, { clearQueue, abort });
		const controller = new InputController(ctx);

		editor.setText("[Image #1] queued");
		const submitted = controller.handleFollowUp();
		try {
			await Bun.sleep(0);
			editor.setText("[Image #1] not yet sent");
			editor.pendingImages.push(draftImage);
			editor.pendingImageLinks.push("local://newer.png");

			expect(controller.restoreQueuedMessagesToEditor({ abort: true })).toBe(1);
			expect(clearQueue).toHaveBeenCalledWith({ forInterrupt: true });
			expect(abort).toHaveBeenCalledWith({ reason: USER_INTERRUPT_LABEL });
			expect(textAtAbort).toBe("[Image #2] queued\n\n[Image #1] not yet sent");
			expect(editor.pendingImages).toEqual([draftImage, queuedImage]);
			expect(editor.pendingImageLinks).toEqual(["local://newer.png", undefined]);
		} finally {
			runFinished.resolve(true);
			await submitted;
		}
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

		expect(handleGoalModeCommand).toHaveBeenCalledWith("set Ship the release [Image #1]", {
			images: [image],
			imageLinks: ["local://draft.png"],
		});
		expect(ctx.editor.pendingImages).toEqual([]);
		expect(ctx.editor.pendingImageLinks).toEqual([]);
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
		expect(editor.getText()).toBe("/goal set Ship the release [Image #1]\n\nlater draft");
		expect(ctx.editor.pendingImages).toEqual([image]);
		expect(ctx.editor.pendingImageLinks).toEqual(["local://draft.png"]);
		expect(ctx.editor.imageLinks).toEqual(["local://draft.png"]);
	});
});
