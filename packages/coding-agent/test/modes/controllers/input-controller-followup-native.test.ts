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

function createHarness(isStreaming: boolean) {
	const editor = new CustomEditor(getEditorTheme());
	const prompt = vi.fn(async (_text: string, _options?: PromptOptions) => true);
	const showError = vi.fn();
	const ctx = createInteractiveModeContext({
		editor,
		session: {
			isStreaming,
			prompt,
			prewarmModelConnection: vi.fn(),
		},
		ui: {
			addInputListener: vi.fn(() => () => {}),
			addStartListener: vi.fn(() => () => {}),
		},
		dictationSpaceHold: vi.fn<InteractiveModeContext["dictationSpaceHold"]>(),
		withLocalSubmission: async <T>(_text: string, submit: () => Promise<T>): Promise<T> => submit(),
		showError,
	});
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

	return { ctx, editor, prompt, showError, draft, pressFollowUp };
}

describe("native main-session Ctrl+Enter", () => {
	afterEach(() => vi.restoreAllMocks());

	for (const isStreaming of [false, true]) {
		const state = isStreaming ? "streaming" : "idle";

		it(`submits text and attachments to the ${state} native session`, async () => {
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
});
