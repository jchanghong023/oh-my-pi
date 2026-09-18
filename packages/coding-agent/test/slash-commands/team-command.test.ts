/**
 * `/team` command entry-gate tests: bare command asks for the question,
 * Discuss primary agent refuses to dispatch (Shift+F2 notice), and a session
 * without a model reports the configuration error without running stages.
 */
import { describe, expect, it } from "bun:test";
import { TEAM_SLASH_COMMANDS } from "@oh-my-pi/pi-coding-agent/jch-commands/team";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { SlashCommandRuntime, TuiSlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";

const command = TEAM_SLASH_COMMANDS[0]!;

function stubSession(overrides: Partial<Record<string, unknown>> = {}): AgentSession {
	return {
		getPrimaryAgentId: () => "main",
		getPendingPrimaryAgentId: () => undefined,
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

function tuiRuntime(session: AgentSession): { runtime: TuiSlashCommandRuntime; status: string[]; warnings: string[] } {
	const status: string[] = [];
	const warnings: string[] = [];
	const runtime = {
		ctx: {
			session,
			settings: Settings.isolated(),
			sessionManager: { getCwd: () => "/tmp/repo" },
			editor: { setText: () => {} },
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
		},
	} as unknown as TuiSlashCommandRuntime;
	return { runtime, status, warnings };
}

describe("/team command gates", () => {
	it("is registered with args allowed and a usage hint", () => {
		expect(command.name).toBe("team");
		expect(command.allowArgs).toBe(true);
		expect(command.inlineHint).toContain("问题");
	});

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

	it("refuses to dispatch under a Discuss primary agent with the Shift+F2 notice", async () => {
		const discuss = stubSession({ getPrimaryAgentId: () => "discuss" });
		const text = textRuntime(discuss);
		const textResult = await command.handle!({ name: "team", args: "分析 X", text: "/team 分析 X" }, text.runtime);
		expect(textResult).toEqual({ consumed: true });
		expect(text.output[0]).toContain("Shift+F2");
		expect(text.output[0]).toContain("Main");

		const tui = tuiRuntime(discuss);
		const tuiResult = await command.handleTui!({ name: "team", args: "分析 X", text: "/team 分析 X" }, tui.runtime);
		expect(tuiResult).toEqual({ consumed: true });
		expect(tui.warnings[0]).toContain("Shift+F2");

		// A pending (in-flight) Discuss switch gates the same way.
		const pendingDiscuss = stubSession({ getPendingPrimaryAgentId: () => "discuss" });
		const pending = textRuntime(pendingDiscuss);
		await command.handle!({ name: "team", args: "分析 X", text: "/team 分析 X" }, pending.runtime);
		expect(pending.output[0]).toContain("Shift+F2");
	});

	it("reports the missing session model without running any stage", async () => {
		const { runtime, output } = textRuntime(stubSession({ model: undefined }));
		await command.handle!({ name: "team", args: "分析 X", text: "/team 分析 X" }, runtime);
		expect(output).toHaveLength(1);
		expect(output[0]).toContain("会话模型");
	});
});
