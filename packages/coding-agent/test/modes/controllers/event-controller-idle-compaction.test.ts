import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { UiHelpers } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";
import type { Component } from "@oh-my-pi/pi-tui";
import { RecapNotice } from "@oh-my-pi/pi-tui/chat/recap-notice";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { createInteractiveModeContext } from "../../helpers/interactive-mode-context";

function recordPresented(_content: Component | readonly Component[]): void {}

describe("EventController idle recap presentation", () => {
	beforeEach(async () => {
		await initTheme();
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
	});

	afterEach(() => {
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	it("presents the delivered recap in the transcript", () => {
		const present = vi.fn(recordPresented);
		const controller = new EventController(createInteractiveModeContext({ present }));
		const reply = "Completed the migration; focused tests are next.";

		controller.presentIdleRecap(reply);

		expect(present).toHaveBeenCalledTimes(1);
		const notice = present.mock.calls[0][0];
		expect(notice).toBeInstanceOf(RecapNotice);
		if (!(notice instanceof RecapNotice)) throw new Error("Expected a recap notice");
		expect(
			notice
				.render(200)
				.map(line => Bun.stripANSI(line))
				.join("\n"),
		).toContain(reply);
		controller.dispose();
	});

	it("does not present an empty recap", () => {
		const present = vi.fn(recordPresented);
		const controller = new EventController(createInteractiveModeContext({ present }));

		controller.presentIdleRecap("  \n  ");

		expect(present).not.toHaveBeenCalled();
		controller.dispose();
	});
});

describe("compaction queue actor ownership", () => {
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
			helpers.noteCompactionBindingChange(false);
			ctx.session = other;
		};

		await helpers.flushCompactionQueue();
		expect(ownerPrompt).not.toHaveBeenCalled();
		expect(otherPrompt).not.toHaveBeenCalled();

		ctx.session = owner;
		helpers.noteCompactionBindingChange(false);
		await helpers.restoreCompactionQueue(owner, false);
		expect(ownerPrompt).toHaveBeenCalledTimes(1);
		expect(ownerPrompt).toHaveBeenCalledWith("keep with owner", expect.objectContaining({ images: [image] }));
		expect(otherPrompt).not.toHaveBeenCalled();
	});

	it("does not send ordinary-session input into an empty Dev view of the same session", async () => {
		const prompt = vi.fn(async () => true);
		const ctx = createInteractiveModeContext({
			session: { prompt },
			compactionQueuedMessages: [
				{ text: "/new", mode: "followUp", draftDetached: true },
				{ text: "ordinary input", mode: "steer" },
			],
			recordLocalSubmission: () => () => {},
		});
		const helpers = new UiHelpers(ctx);
		ctx.isKnownSlashCommand = text => helpers.isKnownSlashCommand(text);
		ctx.handleNewCommand = async () => helpers.noteCompactionBindingChange(true);

		await helpers.flushCompactionQueue();
		expect(prompt).not.toHaveBeenCalled();
		helpers.noteCompactionBindingChange(false);
		await helpers.restoreCompactionQueue(ctx.session, false);
		expect(prompt).toHaveBeenCalledTimes(1);
		expect(prompt).toHaveBeenCalledWith("ordinary input", expect.any(Object));
	});
});
