/**
 * `/team` command entry-gate tests: bare command asks for the question, a
 * session without a model reports the configuration error without running
 * stages, and a failed dispatch puts the submission back into the composer.
 */
import { describe, expect, it, spyOn } from "bun:test";
import type { ImageContent, Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { TEAM_SLASH_COMMANDS } from "@oh-my-pi/pi-coding-agent/jch-commands/team";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { SlashCommandRuntime, TuiSlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";
import { compactImageMarkers } from "../../src/modes/view-model/prompt/composer-attachments";
import { createInteractiveModeContext } from "../helpers/interactive-mode-context";

const command = TEAM_SLASH_COMMANDS[0]!;
const MODEL: Model = getBundledModel("ascend", "qwen3.8-flash-next")!;

function stubSession(overrides: Partial<Record<string, unknown>> = {}): AgentSession {
	return {
		model: undefined,
		sessionManager: SessionManager.inMemory(process.cwd()),
		registerSessionChangeCallback: () => () => {},
		...overrides,
	} as unknown as AgentSession;
}

function textRuntime(session: AgentSession): { runtime: SlashCommandRuntime; output: string[] } {
	const output: string[] = [];
	const runtime = {
		session,
		settings: Settings.isolated(),
		cwd: "/tmp/repo",
		output: (text: string) => {
			output.push(text);
		},
	} as unknown as SlashCommandRuntime;
	return { runtime, output };
}

function tuiRuntime(session: AgentSession, settings = Settings.isolated()) {
	const ctx = createInteractiveModeContext({
		session,
		settings,
		sessionManager: { getCwd: () => "/tmp/repo" },
	});
	const runtime: TuiSlashCommandRuntime = { ctx };
	return { runtime, composer: ctx.composer };
}

describe("/team command gates", () => {
	it("asks for the question on bare /team instead of guessing (text mode)", async () => {
		const { runtime, output } = textRuntime(stubSession());
		const result = await command.handle!({ name: "team", args: "", text: "/team" }, runtime);
		expect(result).toEqual({ consumed: true });
		expect(output).toHaveLength(1);
		expect(output[0]).toContain("用法");
		expect(output[0]).toContain("/team");
	});

	it("asks for the question on bare /team in the TUI", async () => {
		const { runtime } = tuiRuntime(stubSession());
		const result = await command.handleTui!({ name: "team", args: "  ", text: "/team" }, runtime);
		expect(result).toEqual({ consumed: true });
		expect(runtime.ctx.showStatus).toHaveBeenCalledWith(expect.stringContaining("用法"));
	});

	it("reports the missing session model without running any stage", async () => {
		const { runtime, output } = textRuntime(stubSession({ model: undefined }));
		await command.handle!({ name: "team", args: "分析 X", text: "/team 分析 X" }, runtime);
		expect(output).toHaveLength(1);
		expect(output[0]).toContain("会话模型");
	});

	it("puts the submission back into the composer when dispatch fails validation", async () => {
		const { runtime, composer } = tuiRuntime(stubSession({ model: undefined }));
		const setText = spyOn(composer, "setText");
		await command.handleTui!({ name: "team", args: "分析 X", text: "/team 分析 X" }, runtime);
		expect(setText).not.toHaveBeenCalledWith("");
		expect(composer.expandedText()).toBe("/team 分析 X");
	});

	it("detaches submitted images before awaiting the dispatch notice so new markers remain valid", async () => {
		const noticeStarted = Promise.withResolvers<void>();
		const noticePersisted = Promise.withResolvers<void>();
		const session = stubSession({
			model: MODEL,
			modelRegistry: { getAvailable: () => [MODEL], authStorage: undefined },
			asyncJobManager: { register: () => "bg_images" },
			appendCustomMessage: async () => {
				noticeStarted.resolve();
				await noticePersisted.promise;
			},
		});
		const { runtime, composer } = tuiRuntime(session);
		const submitted: ImageContent = { type: "image", data: "submitted", mimeType: "image/png" };
		const newer: ImageContent = { type: "image", data: "newer", mimeType: "image/png" };
		composer.pendingImages.push(submitted);
		composer.pendingImageLinks.push("submitted.png");
		runtime.input = { images: [submitted], imageLinks: ["submitted.png"] };
		const dispatch = command.handleTui!(
			{ name: "team", args: "分析 X [Image #1]", text: "/team 分析 X [Image #1]" },
			runtime,
		);
		try {
			await noticeStarted.promise;
			expect(composer.pendingImages).toEqual([]);
			expect(composer.pendingImageLinks).toEqual([]);
			composer.pendingImages.push(newer);
			composer.pendingImageLinks.push("newer.png");
			const index = composer.pendingImages.length;
			composer.setText(`next [Image #${index}] attachment://${index}`);
		} finally {
			noticePersisted.resolve();
			await dispatch;
		}
		expect(composer.pendingImages).toEqual([newer]);
		expect(composer.pendingImageLinks).toEqual(["newer.png"]);
		expect(composer.expandedText()).toBe("next [Image #1] attachment://1");
		expect(compactImageMarkers(composer.expandedText(), composer.pendingImages.length)).toBeNull();
	});

	it("restores detached Enter-path images after a newer draft when validation fails", async () => {
		const { runtime, composer } = tuiRuntime(stubSession());
		const submitted: ImageContent = { type: "image", data: "submitted", mimeType: "image/png" };
		const newer: ImageContent = { type: "image", data: "newer", mimeType: "image/png" };
		composer.pendingImages.push(submitted);
		composer.pendingImageLinks.push("submitted.png");
		runtime.input = { images: [submitted], imageLinks: ["submitted.png"] };
		const dispatch = command.handleTui!(
			{ name: "team", args: "分析 X [Image #1]", text: "/team 分析 X [Image #1] attachment://1" },
			runtime,
		);
		// The handler detaches synchronously, before its lazy controller import.
		composer.pendingImages.push(newer);
		composer.pendingImageLinks.push("newer.png");
		composer.setText("next [Image #1] attachment://1");
		const restoreDraft = spyOn(composer, "setCollapsedText");
		await dispatch;
		expect(composer.pendingImages).toEqual([newer, submitted]);
		expect(composer.pendingImageLinks).toEqual(["newer.png", "submitted.png"]);
		expect(restoreDraft).toHaveBeenCalledWith(
			"/team 分析 X [Image #2] attachment://2\n\nnext [Image #1] attachment://1",
		);
		expect(composer.expandedText()).toBe("/team 分析 X [Image #2]\n\nnext [Image #1]");
		expect(compactImageMarkers(composer.expandedText(), composer.pendingImages.length)).toBeNull();
	});

	it("clears the composer after dispatching with the unconfigured session-default roster", async () => {
		const session = stubSession({
			model: MODEL,
			modelRegistry: { getAvailable: () => [MODEL], authStorage: undefined },
			asyncJobManager: {
				register: () => "bg_1",
				acknowledgeDeliveries: () => {},
			},
			appendCustomMessage: async () => {},
		});
		const { runtime, composer } = tuiRuntime(session);
		composer.setText("/team 分析 X");
		const setText = spyOn(composer, "setText");
		await command.handleTui!({ name: "team", args: "分析 X", text: "/team 分析 X" }, runtime);
		expect(setText.mock.calls).toEqual([[""]]);
		expect(composer.expandedText()).toBe("");
	});
});
