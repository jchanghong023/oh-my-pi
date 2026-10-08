/**
 * `/team` command entry-gate tests: bare command asks for the question, a
 * session without a model reports the configuration error without running
 * stages, and a failed dispatch puts the submission back into the TUI editor.
 */
import { describe, expect, it } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { TEAM_SLASH_COMMANDS } from "@oh-my-pi/pi-coding-agent/jch-commands/team";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { SlashCommandRuntime, TuiSlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";

const command = TEAM_SLASH_COMMANDS[0]!;
const MODEL: Model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
const MODEL_PATTERN = `${MODEL.provider}/${MODEL.id}`;

function stubSession(overrides: Partial<Record<string, unknown>> = {}): AgentSession {
	return {
		model: undefined,
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

function tuiRuntime(
	session: AgentSession,
	settings = Settings.isolated(),
): {
	runtime: TuiSlashCommandRuntime;
	status: string[];
	warnings: string[];
	editorClears: { count: number };
	restored: string[];
} {
	const status: string[] = [];
	const warnings: string[] = [];
	// Object counter: a bare number would be snapshotted at return time and the
	// test's destructure would forever see the initial 0.
	const editorClears = { count: 0 };
	const restored: string[] = [];
	const runtime = {
		ctx: {
			session,
			settings,
			sessionManager: { getCwd: () => "/tmp/repo" },
			editor: {
				setText: (text: string) => {
					if (text === "") editorClears.count++;
				},
				getExpandedText: () => "",
				pendingImages: [],
				setCollapsedText: (text: string) => {
					restored.push(text);
				},
			},
			showStatus: (text: string) => {
				status.push(text);
			},
			showWarning: (text: string) => {
				warnings.push(text);
			},
			showError: (text: string) => {
				status.push(text);
			},
			rebuildChatFromMessages: () => {},
			ui: { requestRender: () => {} },
		},
	} as unknown as TuiSlashCommandRuntime;
	return { runtime, status, warnings, editorClears, restored };
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
		const { runtime, status } = tuiRuntime(stubSession());
		const result = await command.handleTui!({ name: "team", args: "  ", text: "/team" }, runtime);
		expect(result).toEqual({ consumed: true });
		expect(status[0]).toContain("用法");
	});

	it("reports the missing session model without running any stage", async () => {
		const { runtime, output } = textRuntime(stubSession({ model: undefined }));
		await command.handle!({ name: "team", args: "分析 X", text: "/team 分析 X" }, runtime);
		expect(output).toHaveLength(1);
		expect(output[0]).toContain("会话模型");
	});

	it("puts the submission back into the TUI editor when dispatch fails validation", async () => {
		const { runtime, editorClears, restored } = tuiRuntime(stubSession({ model: undefined }));
		await command.handleTui!({ name: "team", args: "分析 X", text: "/team 分析 X" }, runtime);
		expect(editorClears.count).toBe(0);
		expect(restored).toEqual(["/team 分析 X"]);
	});

	it("clears the TUI editor only after a successful dispatch", async () => {
		const session = stubSession({
			model: MODEL,
			modelRegistry: { getAvailable: () => [MODEL], authStorage: undefined },
			asyncJobManager: {
				register: () => "bg_1",
				acknowledgeDeliveries: () => {},
			},
			sendCustomMessage: async () => false,
		});
		const settings = Settings.isolated({ "team.members": [MODEL_PATTERN] });
		const { runtime, editorClears, restored } = tuiRuntime(session, settings);
		await command.handleTui!({ name: "team", args: "分析 X", text: "/team 分析 X" }, runtime);
		expect(editorClears.count).toBe(1);
		expect(restored).toHaveLength(0);
	});
});
