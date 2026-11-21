import { describe, expect, it, vi } from "bun:test";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext, SubmittedUserInput } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { PromptOptions } from "@oh-my-pi/pi-coding-agent/session/agent-session-types";

function createLoopContext(options: {
	isStreaming: boolean;
	isCompacting?: boolean;
	extensionCommand?: string;
	customCommand?: string;
	inlineBody?: string;
	onInputCallback?: (input: SubmittedUserInput) => void;
}) {
	const sessionId = crypto.randomUUID();
	const extensionRunner = options.extensionCommand
		? {
				hasHandlers: () => false,
				getCommand: (name: string) => (name === options.extensionCommand ? {} : undefined),
			}
		: undefined;
	let loopPrompt: string | undefined = "original loop prompt";
	const setLoopPrompt = vi.fn((prompt: string) => {
		loopPrompt = prompt;
	});
	const prompt = vi.fn(async (text: string, optionsForPrompt?: PromptOptions) => {
		optionsForPrompt?.onPromptAdmitted?.();
		return !options.customCommand || text !== `/${options.customCommand}`;
	});
	const pauseLoop = vi.fn(() => {
		loopPrompt = undefined;
	});
	const queueCompactionMessage = vi.fn((_text: string, _mode: "steer" | "followUp") => {});
	const handleBashCommand = vi.fn();
	const showError = vi.fn();
	const editor = {
		pendingImages: [],
		pendingImageLinks: [],
		imageLinks: undefined,
		addToHistory: vi.fn(),
		setText: vi.fn(),
		getText: () => "",
		getExpandedText: () => "",
		clearDraft: vi.fn(),
		setCollapsedText: vi.fn(),
	} as unknown as InteractiveModeContext["editor"];
	const ctx = {
		editor,
		ui: { requestRender: vi.fn() },
		session: {
			isStreaming: options.isStreaming,
			isCompacting: options.isCompacting ?? false,
			isBashRunning: false,
			isEvalRunning: false,
			queuedMessageCount: 0,
			extensionRunner,
			customCommands: options.customCommand ? [{ command: { name: options.customCommand } }] : [],
			promptTemplates: [],
			prompt,
		},
		sessionManager: { getSessionId: () => sessionId, putBlob: vi.fn() },
		handleDevInput: async () => false,
		isDevInputRoute: () => false,
		loopModeEnabled: true,
		get loopPrompt() {
			return loopPrompt;
		},
		handleLoopCommand: async () => options.inlineBody,
		captureLoopPromptOnAdmission(text: string): (() => boolean) | undefined {
			// Local commands may be admitted without starting a model turn.
			const name = text.startsWith("/") ? text.slice(1).split(" ", 1)[0] : undefined;
			if (name && (extensionRunner?.getCommand(name) || name === options.customCommand)) return undefined;
			return () => {
				setLoopPrompt(text);
				return true;
			};
		},
		setLoopPrompt,
		pauseLoop,
		flushPendingBashComponents: vi.fn(),
		startPendingSubmission: vi.fn((input: { text: string }) => ({ ...input, cancelled: false, started: false })),
		withLocalSubmission: async (_text: string, fn: () => unknown) => fn(),
		updatePendingMessagesDisplay: vi.fn(),
		updateEditorBorderColor: vi.fn(),
		showError,
		handleBashCommand,
		queueCompactionMessage,
		onInputCallback: options.onInputCallback,
		skillCommands: new Map(),
		fileSlashCommands: new Set<string>(),
		isBashMode: false,
		isPythonMode: false,
		focusedAgentId: undefined,
		compactionQueuedMessages: [],
		locallySubmittedUserSignatures: new Set<string>(),
	} as unknown as InteractiveModeContext;
	return {
		ctx,
		setLoopPrompt,
		pauseLoop,
		prompt,
		getLoopPrompt: () => loopPrompt,
		queueCompactionMessage,
		handleBashCommand,
		showError,
	};
}

describe("loop mode interjections", () => {
	it("keeps the original loop prompt when steering mid-turn", async () => {
		const { ctx, setLoopPrompt, prompt, getLoopPrompt } = createLoopContext({ isStreaming: true });
		const controller = new InputController(ctx);
		controller.setupEditorSubmitHandler();

		await ctx.editor.onSubmit?.("one-off correction");

		// One-off steer reaches the session but must not replace the loop body.
		expect(prompt).toHaveBeenCalledWith(
			"one-off correction",
			expect.objectContaining({ streamingBehavior: "steer" }),
		);
		expect(setLoopPrompt).not.toHaveBeenCalled();
		expect(getLoopPrompt()).toBe("original loop prompt");
	});

	it("adopts an idle submission as the new loop prompt", async () => {
		const onInputCallback = vi.fn((_input: SubmittedUserInput) => {});
		const { ctx, getLoopPrompt, prompt } = createLoopContext({ isStreaming: false, onInputCallback });
		const controller = new InputController(ctx);
		controller.setupEditorSubmitHandler();

		await ctx.editor.onSubmit?.("new loop body");

		expect(getLoopPrompt()).toBe("new loop body");
		expect(onInputCallback).toHaveBeenCalledWith(expect.objectContaining({ text: "new loop body" }));
		expect(prompt).not.toHaveBeenCalled();
	});

	it("records an inline /loop prompt queued during compaction", async () => {
		const { ctx, getLoopPrompt, queueCompactionMessage } = createLoopContext({
			isStreaming: false,
			isCompacting: true,
			inlineBody: "compact loop body",
		});
		let bodyDuringEnqueue: string | undefined;
		queueCompactionMessage.mockImplementationOnce(() => {
			bodyDuringEnqueue = getLoopPrompt();
		});
		const controller = new InputController(ctx);
		controller.setupEditorSubmitHandler();

		await ctx.editor.onSubmit?.("/loop 3 compact loop body");

		expect(queueCompactionMessage.mock.calls.map(([text, mode]) => [text, mode])).toEqual([
			["compact loop body", "steer"],
		]);
		expect(bodyDuringEnqueue).toBe("original loop prompt");
		expect(getLoopPrompt()).toBe("compact loop body");
	});

	it("does not arm the loop when the inline body is a local command", async () => {
		const { ctx, getLoopPrompt, handleBashCommand, prompt } = createLoopContext({
			isStreaming: false,
			inlineBody: "!echo hi",
		});
		const controller = new InputController(ctx);
		controller.setupEditorSubmitHandler();

		await ctx.editor.onSubmit?.("/loop 3 !echo hi");

		expect(handleBashCommand).toHaveBeenCalledWith("echo hi", false);
		expect(prompt).not.toHaveBeenCalled();
		expect(getLoopPrompt()).toBe("original loop prompt");
	});

	it("does not arm the loop when the compacted body is a local command", async () => {
		const { ctx, getLoopPrompt, queueCompactionMessage } = createLoopContext({
			isStreaming: false,
			isCompacting: true,
			extensionCommand: "ext-cmd",
			inlineBody: "/ext-cmd args",
		});
		const controller = new InputController(ctx);
		controller.setupEditorSubmitHandler();

		await ctx.editor.onSubmit?.("/loop 3 /ext-cmd args");

		expect(queueCompactionMessage.mock.calls.map(([text, mode]) => [text, mode])).toEqual([
			["/ext-cmd args", "steer"],
		]);
		expect(getLoopPrompt()).toBe("original loop prompt");
	});

	it("leaves the loop untouched when a streamed custom command is admitted but consumed locally", async () => {
		const { ctx, prompt, getLoopPrompt } = createLoopContext({
			isStreaming: true,
			customCommand: "void-cmd",
			inlineBody: "/void-cmd",
		});
		const controller = new InputController(ctx);
		controller.setupEditorSubmitHandler();

		await ctx.editor.onSubmit?.("/loop 3 /void-cmd");

		expect(prompt).toHaveBeenCalledWith("/void-cmd", expect.objectContaining({ streamingBehavior: "steer" }));
		expect(getLoopPrompt()).toBe("original loop prompt");
	});

	it("parks the loop when a direct submission is consumed locally", async () => {
		const { ctx, setLoopPrompt, pauseLoop, prompt, getLoopPrompt } = createLoopContext({
			isStreaming: false,
			customCommand: "void-cmd",
		});
		const controller = new InputController(ctx);
		controller.setupEditorSubmitHandler();

		await ctx.editor.onSubmit?.("/void-cmd");

		expect(prompt).toHaveBeenCalledTimes(1);
		expect(setLoopPrompt).toHaveBeenCalledWith("/void-cmd");
		expect(pauseLoop).toHaveBeenCalledTimes(1);
		expect(getLoopPrompt()).toBeUndefined();
	});

	it("arms an idle direct submission before dispatch settles", async () => {
		const { ctx, prompt, getLoopPrompt } = createLoopContext({ isStreaming: false });
		const entered = Promise.withResolvers<void>();
		const finish = Promise.withResolvers<boolean>();
		prompt.mockImplementationOnce(() => {
			entered.resolve();
			return finish.promise;
		});
		const controller = new InputController(ctx);
		controller.setupEditorSubmitHandler();

		const submitted = ctx.editor.onSubmit?.("direct body");
		await entered.promise;
		try {
			expect(getLoopPrompt()).toBe("direct body");
		} finally {
			finish.resolve(true);
			await submitted;
		}
	});

	it("keeps the prior body when a streamed inline body is rejected", async () => {
		const { ctx, setLoopPrompt, pauseLoop, prompt, getLoopPrompt, showError } = createLoopContext({
			isStreaming: true,
			inlineBody: "new body",
		});
		prompt.mockRejectedValueOnce(new Error("attachment too large"));
		const controller = new InputController(ctx);
		controller.setupEditorSubmitHandler();

		await ctx.editor.onSubmit?.("/loop 3 new body");

		expect(setLoopPrompt).not.toHaveBeenCalled();
		expect(pauseLoop).not.toHaveBeenCalled();
		expect(getLoopPrompt()).toBe("original loop prompt");
		expect(showError).toHaveBeenCalledWith("attachment too large");
	});

	it("parks the loop when a direct submission is rejected", async () => {
		const { ctx, setLoopPrompt, pauseLoop, prompt, getLoopPrompt, showError } = createLoopContext({
			isStreaming: false,
		});
		prompt.mockRejectedValueOnce(new Error("attachment too large"));
		const controller = new InputController(ctx);
		controller.setupEditorSubmitHandler();

		await ctx.editor.onSubmit?.("direct body");

		expect(setLoopPrompt).toHaveBeenCalledWith("direct body");
		expect(pauseLoop).toHaveBeenCalledTimes(1);
		expect(getLoopPrompt()).toBeUndefined();
		expect(showError).toHaveBeenCalledWith("attachment too large");
	});
});
