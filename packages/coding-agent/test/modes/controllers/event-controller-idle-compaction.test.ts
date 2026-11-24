import { describe, expect, it, vi } from "bun:test";
import { UiHelpers } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";
import { createInteractiveModeContext } from "../../helpers/interactive-mode-context";
describe("compaction queue session ownership", () => {
	it("parks the remaining input and attachments until the submitting session is visible again", async () => {
		const image = { type: "image" as const, data: "aW1hZ2U=", mimeType: "image/png" };
		const ownerPrompt = vi.fn(async () => true);
		const otherPrompt = vi.fn(async () => true);
		const ctx = createInteractiveModeContext({
			session: { prompt: ownerPrompt },
			compactionQueuedMessages: [
				{ text: "/new", mode: "followUp", draftDetached: true },
				{ text: "keep with owner", mode: "steer", images: [image] },
			],
			recordLocalSubmission: () => () => {},
		});
		const owner = ctx.session;
		const other = createInteractiveModeContext({ session: { prompt: otherPrompt } }).session;
		const helpers = new UiHelpers(ctx);
		ctx.isKnownSlashCommand = text => helpers.isKnownSlashCommand(text);
		ctx.handleNewCommand = async () => {
			ctx.session = other;
		};

		await helpers.flushCompactionQueue();
		expect(ownerPrompt).not.toHaveBeenCalled();
		expect(otherPrompt).not.toHaveBeenCalled();

		ctx.session = owner;
		await helpers.restoreCompactionQueue(owner);
		expect(ownerPrompt).toHaveBeenCalledTimes(1);
		expect(ownerPrompt).toHaveBeenCalledWith("keep with owner", expect.objectContaining({ images: [image] }));
		expect(otherPrompt).not.toHaveBeenCalled();
	});
});
