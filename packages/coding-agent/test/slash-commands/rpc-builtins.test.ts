import { describe, expect, test } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	executeAcpBuiltinSlashCommand,
	executeRpcBuiltinSlashCommand,
} from "@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins";
import { buildAvailableSlashCommands } from "@oh-my-pi/pi-coding-agent/slash-commands/available-commands";
import type { RpcSlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";

describe("RPC builtin dispatch", () => {
	test("host modes use their registered RPC adapter while ACP retains its own surface", async () => {
		const calls: Array<{ mode: string; args: string }> = [];
		const runtime: RpcSlashCommandRuntime = {
			session: {} as never,
			sessionManager: {} as never,
			settings: Settings.isolated(),
			cwd: "/project",
			ui: { select: async () => undefined, confirm: async () => false, input: async () => undefined },
			output: () => {},
			refreshCommands: () => {},
			reloadPlugins: async () => {},
			runCommandInBackground: () => {},
			runModeCommand: async (mode, args) => {
				calls.push({ mode, args });
				return { consumed: true };
			},
		};
		for (const text of ["/plan inspect this change", "/loop 3 repeat", "/goal budget 100"]) {
			expect(await executeRpcBuiltinSlashCommand(text, runtime)).toEqual({ consumed: true });
			expect(await executeAcpBuiltinSlashCommand(text, runtime)).toBe(false);
		}
		expect(calls).toEqual([
			{ mode: "plan", args: "inspect this change" },
			{ mode: "loop", args: "3 repeat" },
			{ mode: "goal", args: "budget 100" },
		]);
		expect(await executeRpcBuiltinSlashCommand("/ultrathink inspect", runtime)).toEqual({
			prompt: "ultrathink inspect",
		});
		expect(await executeRpcBuiltinSlashCommand("/missing command", runtime)).toBe(false);
		await expect(executeRpcBuiltinSlashCommand("/git", runtime)).rejects.toThrow("interactive TUI");
		await expect(executeRpcBuiltinSlashCommand("/wiki accidental argument", runtime)).rejects.toThrow(
			"does not accept arguments",
		);
	});

	test("RPC availability includes host adapters without advertising them to ACP", async () => {
		const session = {
			customCommands: [],
			skills: [],
			setSlashCommands: () => {},
			sessionManager: { getCwd: () => "/project" },
		};
		const acp = await buildAvailableSlashCommands(session, async () => []);
		const rpc = await buildAvailableSlashCommands(session, async () => [], { includeRpcBuiltins: true });
		for (const name of ["wiki", "repo", "plan", "loop", "goal"]) {
			expect(acp.some(command => command.name === name)).toBe(false);
			expect(rpc.some(command => command.name === name)).toBe(true);
		}
	});
});
