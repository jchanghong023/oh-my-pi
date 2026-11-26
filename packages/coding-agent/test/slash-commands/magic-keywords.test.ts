import { describe, expect, it } from "bun:test";
import {
	buildAvailableSlashCommands,
	type AvailableCommandsSession,
} from "@oh-my-pi/pi-coding-agent/slash-commands/available-commands";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import type { TuiSlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";

describe("magic keyword public slash dispatch", () => {
	it.each(["ultrathink", "orchestrate", "workflowz"])("clears the TUI draft when /%s expands", async keyword => {
		let editor = `/${keyword} task-marker-43d`;
		expect(
			await executeBuiltinSlashCommand(editor, {
				ctx: {
					session: { model: undefined },
					composer: {
						setText: (text: string) => {
							editor = text;
						},
					},
					sessionManager: { getCwd: () => "/tmp/commands" },
				},
			} as unknown as TuiSlashCommandRuntime),
		).toBe(`${keyword} task-marker-43d`);
		expect(editor).toBe("");
	});
});

describe("public command inventory", () => {
	it("omits builtin colon-prefix collisions from the shared command inventory", async () => {
		const session = {
			customCommands: [
				{ command: { name: "model:company", description: "Unreachable shared shadow" } },
				{ command: { name: "review:company", description: "Reachable custom command" } },
			],
			skills: [],
			sessionManager: { getCwd: () => "/tmp/commands" },
			setSlashCommands: () => {},
		} as unknown as AvailableCommandsSession;
		const commands = await buildAvailableSlashCommands(session, async () => [
			{ name: "models:company", description: "Unreachable alias shadow", content: "body", source: "test" },
			{ name: "review:file", description: "Reachable file command", content: "body", source: "test" },
		]);
		const names = commands.map(command => command.name);
		expect(names).not.toContain("model:company");
		expect(names).not.toContain("models:company");
		expect(names).toContain("review:company");
		expect(names).toContain("review:file");
	});

	it("does not install an old cwd's file commands after a move while loading", async () => {
		let cwd = "/old";
		const installed: string[] = [];
		const session = {
			customCommands: [],
			skills: [],
			sessionManager: { getCwd: () => cwd },
			setSlashCommands: () => {
				installed.push(cwd);
			},
		} as unknown as AvailableCommandsSession;
		const pending = Promise.withResolvers<[]>();
		const loading = buildAvailableSlashCommands(session, () => pending.promise);
		cwd = "/new";
		pending.resolve([]);
		await loading;
		expect(installed).toEqual([]);
		await buildAvailableSlashCommands(session, async () => []);
		expect(installed).toEqual(["/new"]);
	});
});

describe("JCH input method target handoff", () => {
	it("clears the TUI command only after expanding its complete target", async () => {
		let editorText = "/jchime IME-target-marker-43d";
		const prompt = await executeBuiltinSlashCommand(editorText, {
			ctx: {
				session: { model: undefined },
				composer: {
					setText: (text: string) => {
						editorText = text;
					},
				},
				sessionManager: { getCwd: () => process.cwd() },
			},
		} as unknown as TuiSlashCommandRuntime);
		expect(prompt).toContain("IME-target-marker-43d");
		expect(editorText).toBe("");
	});
});
