import { beforeAll, describe, expect, mock, test } from "bun:test";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { CompactionQueuedMessage, InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { UiHelpers } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";
import type { PromptOptions } from "@oh-my-pi/pi-coding-agent/session/agent-session-types";

beforeAll(() => {
	initTheme();
});

function makeCtx(initialQueue: CompactionQueuedMessage[], loopPrompt: string | undefined, promptError?: Error) {
	let currentLoopPrompt = loopPrompt;
	const pauseLoop = mock(() => {
		currentLoopPrompt = undefined;
	});
	// Mirror AgentSession.prompt: a void custom command is consumed locally
	// (false) instead of starting a turn (true).
	const prompt = mock(async (text: string, options?: PromptOptions): Promise<boolean> => {
		if (promptError) throw promptError;
		if (text === "/void-cmd") return false;
		options?.onPromptAdmitted?.();
		return true;
	});
	const armLoopAutoSubmit = mock((admission: Promise<unknown>) => {
		void admission.catch(() => pauseLoop());
	});
	const ctx = {
		session: {
			sessionManager: { getSessionId: () => "s1" },
			isCompacting: false,
			customCommands: [],
			prompt,
			promptCustomMessage: mock(async () => true),
			dropQueuedMessages: () => {},
		},
		editor: { setText: () => {} },
		compactionQueuedMessages: [...initialQueue],
		skillCommands: new Map(),
		fileSlashCommands: new Set<string>(),
		locallySubmittedUserSignatures: new Set<string>(),
		isKnownSlashCommand: (text: string) => text === "/void-cmd",
		recordLocalSubmission: () => () => {},
		withLocalSubmission: async (_text: string, fn: () => Promise<unknown>) => fn(),
		updatePendingMessagesDisplay: mock(() => {}),
		showError: mock((_msg: string) => {}),
		showStatus: mock((_msg: string) => {}),
		loopModeEnabled: loopPrompt !== undefined,
		get loopPrompt() {
			return currentLoopPrompt;
		},
		captureLoopPromptOnAdmission(text: string) {
			if (!ctx.loopModeEnabled) return undefined;
			return () => {
				currentLoopPrompt = text;
				return true;
			};
		},
		armLoopAutoSubmit,
		pauseLoop,
	};
	return {
		ctx: ctx as unknown as InteractiveModeContext,
		prompt,
		pauseLoop,
		armLoopAutoSubmit,
		getLoopPrompt: () => currentLoopPrompt,
	};
}

function makeBuiltinCtx(queue: CompactionQueuedMessage[], promptError?: Error) {
	const fixture = makeCtx(queue, undefined, promptError);
	const { ctx } = fixture;
	const helpers = new UiHelpers(ctx);
	ctx.isKnownSlashCommand = text => helpers.isKnownSlashCommand(text);
	return { ...fixture, helpers };
}

test("queued /new parks the next prompt until the original session returns", async () => {
	const { ctx, helpers } = makeBuiltinCtx([
		{ text: "/new", mode: "followUp" },
		{ text: "work in the original session", mode: "steer" },
	]);
	let sessionId = "previous";
	ctx.session.sessionManager.getSessionId = () => sessionId;
	ctx.handleNewCommand = async () => {
		sessionId = "new";
	};
	const requests: Array<{ sessionId: string; text: string }> = [];
	ctx.session.prompt = mock(async text => {
		requests.push({ sessionId, text });
		return true;
	});

	await helpers.flushCompactionQueue({ willRetry: false });
	expect(sessionId).toBe("new");
	expect(requests).toEqual([]);

	sessionId = "previous";
	await helpers.restoreCompactionQueue(ctx.session);
	expect(requests).toEqual([{ sessionId: "previous", text: "work in the original session" }]);
});

test("a queued builtin without a following prompt runs locally", async () => {
	const { ctx, helpers } = makeBuiltinCtx([{ text: "/new", mode: "followUp" }]);
	let sessionId = "previous";
	ctx.handleNewCommand = async () => {
		sessionId = "new";
	};
	const prompt = mock(async () => true);
	ctx.session.prompt = prompt;

	await helpers.flushCompactionQueue({ willRetry: false });

	expect(sessionId).toBe("new");
	expect(prompt).not.toHaveBeenCalled();
});

test("a queued builtin's inline prompt starts a turn and arms its admitted body", async () => {
	const { ctx, helpers, prompt, armLoopAutoSubmit, getLoopPrompt } = makeBuiltinCtx([
		{ text: "/loop 2 investigate", mode: "followUp" },
	]);
	ctx.handleLoopCommand = async () => {
		ctx.loopModeEnabled = true;
		return "investigate";
	};

	await helpers.flushCompactionQueue({ willRetry: false });

	expect(prompt).toHaveBeenCalledTimes(1);
	expect(prompt.mock.calls[0]?.[0]).toBe("investigate");
	expect(getLoopPrompt()).toBe("investigate");
	expect(armLoopAutoSubmit).toHaveBeenCalledTimes(1);
	await expect(armLoopAutoSubmit.mock.calls[0]?.[0]).resolves.toBeUndefined();
});

test("a queued inline loop body that rejects before admission never becomes the loop prompt", async () => {
	const queued: CompactionQueuedMessage[] = [{ text: "/loop 2 investigate", mode: "followUp" }];
	const { ctx, helpers, prompt, armLoopAutoSubmit, getLoopPrompt } = makeBuiltinCtx(
		queued,
		new Error("attachment too large"),
	);
	ctx.handleLoopCommand = async () => {
		ctx.loopModeEnabled = true;
		return "investigate";
	};

	await helpers.flushCompactionQueue({ willRetry: false });

	expect(prompt).toHaveBeenCalledTimes(1);
	expect(prompt.mock.calls[0]?.[0]).toBe("investigate");
	expect(getLoopPrompt()).toBeUndefined();
	expect(armLoopAutoSubmit).not.toHaveBeenCalled();
	expect(ctx.compactionQueuedMessages).toEqual(queued);
	expect(ctx.showError).toHaveBeenCalledWith("Failed to send queued message: attachment too large");
});

describe("flushCompactionQueue loop parking", () => {
	test("all-slash drain parks the loop when the body is consumed locally", async () => {
		const queued: CompactionQueuedMessage[] = [{ text: "/void-cmd", mode: "steer" }];
		const { ctx, prompt, pauseLoop, getLoopPrompt } = makeCtx(queued, "/void-cmd");

		await new UiHelpers(ctx).flushCompactionQueue({ willRetry: false });

		expect(prompt).toHaveBeenCalledWith("/void-cmd");
		expect(pauseLoop).toHaveBeenCalledTimes(1);
		expect(getLoopPrompt()).toBeUndefined();
	});

	test("pre-command drain parks the loop when the body is consumed locally", async () => {
		const queued: CompactionQueuedMessage[] = [
			{ text: "/void-cmd", mode: "steer" },
			{ text: "plain follow-up", mode: "followUp" },
		];
		const { ctx, pauseLoop, getLoopPrompt } = makeCtx(queued, "/void-cmd");

		await new UiHelpers(ctx).flushCompactionQueue({ willRetry: false });
		await Promise.resolve();
		await Promise.resolve();

		expect(pauseLoop).toHaveBeenCalledTimes(1);
		expect(getLoopPrompt()).toBeUndefined();
	});

	test("drain keeps the loop armed when the body starts a turn", async () => {
		const queued: CompactionQueuedMessage[] = [{ text: "plain body", mode: "steer" }];
		const { ctx, pauseLoop, armLoopAutoSubmit, getLoopPrompt } = makeCtx(queued, "plain body");

		await new UiHelpers(ctx).flushCompactionQueue({ willRetry: false });
		expect(armLoopAutoSubmit).toHaveBeenCalledTimes(1);
		await expect(armLoopAutoSubmit.mock.calls[0]?.[0]).resolves.toBeUndefined();

		expect(pauseLoop).not.toHaveBeenCalled();
		expect(getLoopPrompt()).toBe("plain body");
	});

	test("failed drain restores the queue and parks the matching loop", async () => {
		const queued: CompactionQueuedMessage[] = [{ text: "queued body", mode: "steer" }];
		const { ctx, prompt, pauseLoop, armLoopAutoSubmit, getLoopPrompt } = makeCtx(
			queued,
			"queued body",
			new Error("attachment too large"),
		);

		await new UiHelpers(ctx).flushCompactionQueue({ willRetry: false });
		expect(armLoopAutoSubmit).toHaveBeenCalledTimes(1);
		await expect(armLoopAutoSubmit.mock.calls[0]?.[0]).rejects.toThrow("attachment too large");

		expect(prompt).toHaveBeenCalledTimes(1);
		expect(ctx.compactionQueuedMessages).toEqual(queued);
		expect(pauseLoop).toHaveBeenCalledTimes(1);
		expect(getLoopPrompt()).toBeUndefined();
	});
});

describe("flushCompactionQueue after a queued compaction", () => {
	function heldBehindQueuedCompaction(branch: Array<{ id: string }>) {
		const { ctx, prompt } = makeCtx([{ text: "held behind /compact", mode: "followUp" }], undefined);
		const restoreCompactionQueueToEditor = mock(() => {});
		Object.assign(ctx, {
			yieldCompaction: undefined,
			// Set by the queued pass when it took over from the request.
			compactionQueueOrigin: { sessionId: "s1", leafId: "e1" },
			sessionManager: { getSessionId: () => "s1", getBranch: () => branch },
			restoreCompactionQueueToEditor,
		});
		return { ctx, prompt, restoreCompactionQueueToEditor };
	}

	test("hands the held follow-ups back when /tree moved to another branch during the pass", async () => {
		const { ctx, prompt, restoreCompactionQueueToEditor } = heldBehindQueuedCompaction([{ id: "e9" }]);

		await new UiHelpers(ctx).flushCompactionQueue({ willRetry: false });

		expect(restoreCompactionQueueToEditor).toHaveBeenCalledTimes(1);
		expect(prompt).not.toHaveBeenCalled();
		expect(ctx.compactionQueueOrigin).toBeUndefined();
	});

	test("delivers them when the branch still continues from where they were queued", async () => {
		const { ctx, prompt, restoreCompactionQueueToEditor } = heldBehindQueuedCompaction([{ id: "e1" }, { id: "e2" }]);

		await new UiHelpers(ctx).flushCompactionQueue({ willRetry: false });

		expect(restoreCompactionQueueToEditor).not.toHaveBeenCalled();
		expect(prompt).toHaveBeenCalledTimes(1);
		expect(ctx.compactionQueueOrigin).toBeUndefined();
	});
});
