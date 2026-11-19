import { afterEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import { parseImageMetadata, removeWithRetries } from "@oh-my-pi/pi-utils";
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
		expect(await executeAcpBuiltinSlashCommand("/workspace", runtime)).toBe(false);
		expect(await executeAcpBuiltinSlashCommand("/workspace inspect", runtime)).toBe(false);
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
		for (const name of ["knowledge", "plan", "loop", "goal", "workspace"]) {
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

	test("native RPC consumes toggles locally and submits workspace arguments once with attachments", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rpc-workspace-"));
		const client = new RpcClient({
			command: [process.execPath, path.join(import.meta.dir, "..", "fixtures", "input-hook-rpc-agent.ts")],
			cwd: directory,
			env: { PI_CODING_AGENT_DIR: directory, PI_NO_TITLE: "1" },
		});
		try {
			await client.start();
			expect((await client.getAvailableCommands()).some(command => command.name === "workspace")).toBe(true);
			const toggled = await client.promptAndWait("/workspace");
			expect(toggled.some(event => event.type === "agent_start")).toBe(false);
			expect(await client.getMessages()).toEqual([]);
			await client.promptAndWait("/workspace");
			const image = {
				type: "image" as const,
				mimeType: "image/png",
				data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=",
			};
			await client.promptAndWait("/workspace inspect image", [image]);
			await client.promptAndWait("/workspace inspect again");
			const messages = await client.getMessages();
			const users = messages.filter(message => message.role === "user");
			expect(
				users.map(message =>
					typeof message.content === "string"
						? message.content
						: message.content
								.filter(part => part.type === "text")
								.map(part => part.text)
								.join(""),
				),
			).toEqual(["inspect image", "inspect again"]);
			const content = users[0]?.content;
			if (!Array.isArray(content)) throw new Error("Workspace image is missing from native history");
			const images = content.filter(part => part.type === "image");
			expect(images).toHaveLength(1);
			const normalized = images[0]!;
			const metadata = parseImageMetadata(Buffer.from(normalized.data, "base64"));
			expect(metadata?.width).toBeGreaterThan(0);
			expect(metadata?.height).toBeGreaterThan(0);
			expect(metadata?.mimeType).toBe<string>(normalized.mimeType);
			expect(
				messages.some(message => message.role === "custom" && message.customType === "workspace-mode-context"),
			).toBe(true);
			const disabled = await client.promptAndWait("/workspace");
			expect(disabled.some(event => event.type === "agent_start")).toBe(false);
			await client.promptAndWait("ordinary input");
			expect(
				(await client.getMessages()).some(
					message => message.role === "custom" && message.customType === "workspace-mode-context",
				),
			).toBe(false);
		} finally {
			await client.stop();
			await removeWithRetries(directory);
		}
	}, 30_000);
});
