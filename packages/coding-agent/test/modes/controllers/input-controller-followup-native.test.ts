import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type { PromptOptions } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { initTheme } from "../../../src/ui/theme/service";
import { createInteractiveModeContext } from "../../helpers/interactive-mode-context";
import { nativeShell } from "../../helpers/native-shell";

const FOLLOW_UP = "\x1b[13;5u";
const originalImage: ImageContent = { type: "image", mimeType: "image/png", data: "b3JpZ2luYWw=" };
const newerImage: ImageContent = { type: "image", mimeType: "image/jpeg", data: "bmV3ZXI=" };

function createHarness(isStreaming: boolean) {
	const prompt = vi.fn(async (_text: string, _options?: PromptOptions) => true);
	const showError = vi.fn();
	const ctx = createInteractiveModeContext({
		session: {
			isStreaming,
			prompt,
			prewarmModelConnection: vi.fn(),
		},
		withLocalSubmission: async <T>(_text: string, submit: () => Promise<T>): Promise<T> => submit(),
		showError,
	});
	const { composer } = ctx;
	const controller = new InputController(ctx);
	controller.setupKeyHandlers();
	const followUp = vi.spyOn(controller, "handleFollowUp");

	function draft(text: string, image: ImageContent, link: string) {
		composer.clearDraft();
		composer.pendingImages.push(image);
		composer.pendingImageLinks.push(link);
		composer.setCollapsedText(text);
	}

	function pressFollowUp(ui: Awaited<ReturnType<typeof nativeShell>>) {
		const callIndex = followUp.mock.calls.length;
		ui.type(FOLLOW_UP);
		expect(followUp).toHaveBeenCalledTimes(callIndex + 1);
		const pending = followUp.mock.results[callIndex]?.value;
		if (!(pending instanceof Promise)) throw new Error("Ctrl+Enter did not dispatch a follow-up");
		return pending;
	}

	return { ctx, composer, prompt, showError, draft, pressFollowUp };
}

describe("native main-session Ctrl+Enter", () => {
	beforeAll(() => initTheme());
	afterEach(() => vi.restoreAllMocks());

	for (const isStreaming of [false, true]) {
		const state = isStreaming ? "streaming" : "idle";

		it(`submits text and attachments to the ${state} native session`, async () => {
			const { ctx, composer, prompt, showError, draft, pressFollowUp } = createHarness(isStreaming);
			await using ui = await nativeShell(ctx.shell);
			const sessionId = ctx.sessionManager.getSessionId();
			draft("inspect this [Image #1]", originalImage, "local://original.png");

			await pressFollowUp(ui);

			expect(prompt).toHaveBeenCalledTimes(1);
			expect(prompt).toHaveBeenCalledWith(
				"inspect this [Image #1]",
				expect.objectContaining({ images: [originalImage], streamingBehavior: "followUp" }),
			);
			expect(showError).not.toHaveBeenCalled();
			expect(composer.expandedText()).toBe("");
			expect(composer.pendingImages).toEqual([]);
			expect(composer.pendingImageLinks).toEqual([]);
			expect(ctx.sessionManager.getSessionId()).toBe(sessionId);
		});

		it(`restores a rejected ${state} follow-up beside newer text and attachments`, async () => {
			const { ctx, composer, prompt, showError, draft, pressFollowUp } = createHarness(isStreaming);
			await using ui = await nativeShell(ctx.shell);
			draft("inspect this [Image #1]", originalImage, "local://original.png");
			prompt.mockImplementationOnce(async () => {
				// This belongs to the next submission, not the detached Ctrl+Enter draft.
				draft("next question [Image #1]", newerImage, "local://newer.jpg");
				throw new Error("native submission rejected");
			});

			await pressFollowUp(ui);

			expect(prompt).toHaveBeenCalledTimes(1);
			expect(showError).toHaveBeenCalledWith("native submission rejected");
			expect(composer.expandedText()).toBe("inspect this [Image #2]\n\nnext question [Image #1]");
			expect(composer.pendingImages).toEqual([newerImage, originalImage]);
			expect(composer.pendingImageLinks).toEqual(["local://newer.jpg", "local://original.png"]);
			const chips = composer.chips();
			expect(composer.imageLink(chips.find(chip => chip.n === 1)!)).toBe("local://newer.jpg");
			expect(composer.imageLink(chips.find(chip => chip.n === 2)!)).toBe("local://original.png");
		});
	}
});
