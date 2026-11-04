import { afterEach, describe, expect, test, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	executeAcpBuiltinSlashCommand,
	executeRpcBuiltinSlashCommand,
} from "@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins";
import { buildAvailableSlashCommands } from "@oh-my-pi/pi-coding-agent/slash-commands/available-commands";
import type { RpcSlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";
import { BUILTIN_SLASH_COMMANDS_INTERNAL } from "../../src/slash-commands/builtin-registry";

afterEach(() => vi.restoreAllMocks());

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
		expect(await executeRpcBuiltinSlashCommand("/wiki", runtime)).toBe(false);
		await expect(executeRpcBuiltinSlashCommand("/git", runtime)).rejects.toThrow("interactive TUI");
		await expect(executeRpcBuiltinSlashCommand("/knowledge accidental argument", runtime)).rejects.toThrow(
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
		for (const name of ["knowledge", "repo", "plan", "loop", "goal"]) {
			expect(acp.some(command => command.name === name)).toBe(false);
			expect(rpc.some(command => command.name === name)).toBe(true);
		}
		expect(rpc.some(command => command.name === "wiki")).toBe(false);
	});

	test("gates every registered TUI-only name and alias without invoking a handler", async () => {
		const runtime = {} as RpcSlashCommandRuntime;
		const entries = BUILTIN_SLASH_COMMANDS_INTERNAL.filter(command => !command.handle && !command.handleRpc);
		expect(entries.length).toBeGreaterThan(0);
		for (const command of entries) {
			for (const name of [command.name, ...(command.aliases ?? [])]) {
				await expect(executeRpcBuiltinSlashCommand(`/${name}`, runtime)).rejects.toThrow(
					`/${command.name} is only available in the interactive TUI.`,
				);
				expect(await executeAcpBuiltinSlashCommand(`/${name} untouched argument`, runtime)).toBe(false);
			}
		}
	});

	test("refuses arguments for every shared no-argument command before dispatch", async () => {
		const runtime = {} as RpcSlashCommandRuntime;
		const entries = BUILTIN_SLASH_COMMANDS_INTERNAL.filter(
			command => (command.handle || command.handleRpc) && !(command.acpAllowArgs ?? command.allowArgs),
		);
		expect(entries.length).toBeGreaterThan(0);
		for (const command of entries) {
			const handler = command.handle ? vi.spyOn(command, "handle") : undefined;
			const rpcHandler = command.handleRpc ? vi.spyOn(command, "handleRpc") : undefined;
			for (const name of [command.name, ...(command.aliases ?? [])]) {
				expect(await executeAcpBuiltinSlashCommand(`/${name} literal untouched`, runtime)).toBe(false);
				await expect(executeRpcBuiltinSlashCommand(`/${name} literal untouched`, runtime)).rejects.toThrow(
					`/${command.name} does not accept arguments.`,
				);
			}
			if (handler) expect(handler).not.toHaveBeenCalled();
			if (rpcHandler) expect(rpcHandler).not.toHaveBeenCalled();
		}
	});
});
