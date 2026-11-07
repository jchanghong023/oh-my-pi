import { afterEach, describe, expect, it, vi } from "bun:test";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { PromptOptions } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { CustomEditor } from "@oh-my-pi/pi-tui/prompt/custom-editor";
import { getEditorTheme } from "@oh-my-pi/pi-tui/theme/tui-adapters";
import { createInteractiveModeContext } from "../../helpers/interactive-mode-context";

const FOLLOW_UP = "\x1b[13;5u";
const originalImage: ImageContent = { type: "image", mimeType: "image/png", data: "b3JpZ2luYWw=" };
const newerImage: ImageContent = { type: "image", mimeType: "image/jpeg", data: "bmV3ZXI=" };

function createHarness(isStreaming: boolean, hasPendingDeferredExtensions = false) {
	const editor = new CustomEditor(getEditorTheme());
	const prompt = vi.fn(async (_text: string, _options?: PromptOptions) => true);
	const showError = vi.fn();
	const loadDeferredExtensions = vi.fn(async () => {});
	const ctx = createInteractiveModeContext({
		editor,
		session: {
			isStreaming,
			prompt,
			prewarmModelConnection: vi.fn(),
			hasPendingDeferredExtensions,
			loadDeferredExtensions,
		},
		ui: {
			addInputListener: vi.fn(() => () => {}),
			addStartListener: vi.fn(() => () => {}),
		},
		dictationSpaceHold: vi.fn<InteractiveModeContext["dictationSpaceHold"]>(),
		withLocalSubmission: async <T>(_text: string, submit: () => Promise<T>): Promise<T> => submit(),
		showError,
	});
	// Match the native context even while older shared fixtures retain the retired helper.
	Reflect.deleteProperty(ctx, "handleDevInput");
	const controller = new InputController(ctx);
	controller.setupKeyHandlers();
	const followUp = vi.spyOn(controller, "handleFollowUp");

	function draft(text: string, image: ImageContent, link: string) {
		editor.pendingImages = [image];
		editor.pendingImageLinks = [link];
		editor.imageLinks = editor.pendingImageLinks;
		editor.setText(text);
	}

	function pressFollowUp() {
		const callIndex = followUp.mock.calls.length;
		editor.handleInput(FOLLOW_UP);
		expect(followUp).toHaveBeenCalledTimes(callIndex + 1);
		const pending = followUp.mock.results[callIndex]?.value;
		if (!(pending instanceof Promise)) throw new Error("Ctrl+Enter did not dispatch a follow-up");
		return pending;
	}

	return { ctx, controller, editor, prompt, showError, draft, pressFollowUp, loadDeferredExtensions };
}

describe("native main-session Ctrl+Enter after Dev entry retirement", () => {
	afterEach(() => vi.restoreAllMocks());

	for (const isStreaming of [false, true]) {
		const state = isStreaming ? "streaming" : "idle";

		it(`submits text and attachments to the ${state} native session without a Dev helper`, async () => {
			const { ctx, editor, prompt, showError, draft, pressFollowUp } = createHarness(isStreaming);
			const sessionId = ctx.sessionManager.getSessionId();
			draft("inspect this [Image #1]", originalImage, "local://original.png");

			await pressFollowUp();

			expect(prompt).toHaveBeenCalledTimes(1);
			expect(prompt).toHaveBeenCalledWith(
				"inspect this [Image #1]",
				isStreaming ? { images: [originalImage], streamingBehavior: "followUp" } : { images: [originalImage] },
			);
			expect(showError).not.toHaveBeenCalled();
			expect(editor.getExpandedText()).toBe("");
			expect(editor.pendingImages).toEqual([]);
			expect(editor.pendingImageLinks).toEqual([]);
			expect(ctx.sessionManager.getSessionId()).toBe(sessionId);
		});

		it(`restores a rejected ${state} follow-up beside newer text and attachments`, async () => {
			const { editor, prompt, showError, draft, pressFollowUp } = createHarness(isStreaming);
			draft("inspect this [Image #1]", originalImage, "local://original.png");
			prompt.mockImplementationOnce(async () => {
				// This belongs to the next submission, not the detached Ctrl+Enter draft.
				draft("next question [Image #1]", newerImage, "local://newer.jpg");
				throw new Error("native submission rejected");
			});

			await pressFollowUp();

			expect(prompt).toHaveBeenCalledTimes(1);
			expect(showError).toHaveBeenCalledWith("native submission rejected");
			expect(editor.getExpandedText()).toBe("inspect this [Image #2]\n\nnext question [Image #1]");
			expect(editor.pendingImages).toEqual([newerImage, originalImage]);
			expect(editor.pendingImageLinks).toEqual(["local://newer.jpg", "local://original.png"]);
			expect(editor.imageLinks).toEqual(["local://newer.jpg", "local://original.png"]);
		});
	}

	it("consumes active-workbench follow-ups before hooks or draft detachment", async () => {
		const { ctx, editor, prompt, draft, pressFollowUp, loadDeferredExtensions } = createHarness(true, true);
		draft("keep this [Image #1]", originalImage, "local://original.png");
		const consume = vi.fn(async (_text: string) => true);
		ctx.isDevWorkbenchModeActive = () => true;
		ctx.handleDevWorkbenchModeSubmit = consume;
		const clearDraft = vi.spyOn(editor, "clearDraft");

		await pressFollowUp();

		expect(consume).toHaveBeenCalledWith("keep this [Image #1]");
		expect(loadDeferredExtensions).not.toHaveBeenCalled();
		expect(prompt).not.toHaveBeenCalled();
		expect(clearDraft).not.toHaveBeenCalled();
		expect(editor.getExpandedText()).toBe("keep this [Image #1]");
		expect(editor.pendingImages).toEqual([originalImage]);
		expect(editor.pendingImageLinks).toEqual(["local://original.png"]);
	});

	it("restores the editor's pre-callback reset before consuming an active-workbench Enter", async () => {
		const { ctx, controller, editor, prompt, draft, loadDeferredExtensions } = createHarness(false, true);
		controller.setupEditorSubmitHandler();
		draft("keep this [Image #1]", originalImage, "local://original.png");
		const consume = vi.fn(async (_text: string) => true);
		ctx.isDevWorkbenchModeActive = () => true;
		ctx.handleDevWorkbenchModeSubmit = consume;
		const onSubmit = editor.onSubmit;
		if (!onSubmit) throw new Error("Expected the native submit handler");
		const submitted = vi.fn(onSubmit);
		editor.onSubmit = submitted;

		// The real editor resets its text before calling the controller.
		editor.submit();
		expect(submitted).toHaveBeenCalledTimes(1);
		await submitted.mock.results[0]?.value;

		expect(consume).toHaveBeenCalledWith("keep this [Image #1]");
		expect(loadDeferredExtensions).not.toHaveBeenCalled();
		expect(prompt).not.toHaveBeenCalled();
		expect(editor.getExpandedText()).toBe("keep this [Image #1]");
		expect(editor.pendingImages).toEqual([originalImage]);
		expect(editor.pendingImageLinks).toEqual(["local://original.png"]);
	});

	it("keeps /dev and its attachments when the workbench exit fails", async () => {
		const { ctx, editor, prompt, showError, draft, pressFollowUp } = createHarness(false);
		draft("/dev", originalImage, "local://original.png");
		ctx.isDevWorkbenchModeActive = () => true;
		ctx.handleDevWorkbenchModeSubmit = vi.fn(async () => {
			throw new Error("host close rejected");
		});

		await pressFollowUp();

		expect(ctx.handleDevWorkbenchModeSubmit).toHaveBeenCalledWith("/dev");
		expect(showError).toHaveBeenCalledWith("host close rejected");
		expect(prompt).not.toHaveBeenCalled();
		expect(editor.getExpandedText()).toBe("/dev");
		expect(editor.pendingImages).toEqual([originalImage]);
		expect(editor.pendingImageLinks).toEqual(["local://original.png"]);
	});

	it("blocks direct hotkey and native actions without changing the workbench-owned draft", async () => {
		const { ctx, controller, editor, prompt, draft } = createHarness(true);
		draft("keep this [Image #1]", originalImage, "local://original.png");
		ctx.isDevWorkbenchModeActive = () => true;
		const shutdown = vi.fn(async () => {});
		ctx.shutdown = shutdown;
		const clearDraft = vi.spyOn(editor, "clearDraft");
		const requestRender = vi.spyOn(ctx.ui, "requestRender");
		requestRender.mockClear();

		editor.onEscape?.();
		editor.onCycleThinkingLevel?.();
		editor.onSelectModel?.();
		editor.onSelectModelTemporary?.();
		editor.onFocusAgent?.("another-agent");
		controller.handleCtrlC();
		controller.handleCtrlD();
		controller.handleCtrlZ();
		controller.handleDequeue();
		await controller.handleRetry();
		await controller.handleQueueCommand("do not queue");
		expect(controller.restoreQueuedMessagesToEditor()).toBe(0);
		await controller.openExternalEditor();
		expect(await controller.handleImagePaste()).toBe(false);
		await controller.handleImagePathPaste("local://ignored.png");
		await controller.handleClipboardTextRawPaste();
		expect(controller.handleLargePaste("ignored", 100)).toBe(true);
		await controller.presentLargePasteMenu("ignored", 100);
		controller.handleCopyCurrentLine();
		controller.handleCopyPrompt();
		await controller.cycleRoleModel();
		await controller.openLocalFilePicker();
		controller.toggleToolOutputExpansion();
		controller.toggleToolActivityVisibility();
		controller.toggleThinkingBlockVisibility();
		controller.setToolsExpanded(true);

		expect(shutdown).not.toHaveBeenCalled();
		expect(clearDraft).not.toHaveBeenCalled();
		expect(prompt).not.toHaveBeenCalled();
		expect(requestRender).not.toHaveBeenCalled();
		expect(editor.getExpandedText()).toBe("keep this [Image #1]");
		expect(editor.pendingImages).toEqual([originalImage]);
		expect(editor.pendingImageLinks).toEqual(["local://original.png"]);
	});
});

describe("native submission dispatch identity", () => {
	afterEach(() => vi.restoreAllMocks());

	it("excludes only the current follow-up, not concurrent or externally observed dispatches", async () => {
		const { controller, editor, loadDeferredExtensions } = createHarness(true, true);
		let markEntered!: () => void;
		let releaseHook!: () => void;
		const entered = new Promise<void>(resolve => {
			markEntered = resolve;
		});
		const blocked = new Promise<void>(resolve => {
			releaseHook = resolve;
		});
		const observed: boolean[] = [];
		loadDeferredExtensions.mockImplementationOnce(async () => {
			observed.push(controller.hasOtherSubmissionDispatches());
			markEntered();
			await blocked;
			observed.push(controller.hasOtherSubmissionDispatches());
		});

		editor.setText("first follow-up");
		const first = controller.handleFollowUp();
		await entered;
		expect(observed).toEqual([false]);
		expect(controller.hasOtherSubmissionDispatches()).toBe(true);
		editor.setText("second follow-up");
		const second = controller.handleFollowUp();
		releaseHook();
		await Promise.all([first, second]);

		expect(observed).toEqual([false, true]);
		expect(controller.hasOtherSubmissionDispatches()).toBe(false);
	});

	it("restores a detached follow-up if mode ownership changes during an awaited hook", async () => {
		const { ctx, editor, prompt, draft, pressFollowUp, loadDeferredExtensions } = createHarness(true, true);
		draft("keep this [Image #1]", originalImage, "local://original.png");
		const consume = vi.fn(async (_text: string) => true);
		ctx.handleDevWorkbenchModeSubmit = consume;
		loadDeferredExtensions.mockImplementationOnce(async () => {
			ctx.isDevWorkbenchModeActive = () => true;
		});

		await pressFollowUp();

		expect(consume).toHaveBeenCalledWith("keep this [Image #1]");
		expect(prompt).not.toHaveBeenCalled();
		expect(editor.getExpandedText()).toBe("keep this [Image #1]");
		expect(editor.pendingImages).toEqual([originalImage]);
		expect(editor.pendingImageLinks).toEqual(["local://original.png"]);
	});
});
