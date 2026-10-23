import { describe, expect, it } from "bun:test";
import {
	buildAvailableSlashCommands,
	type AvailableCommandsSession,
} from "@oh-my-pi/pi-coding-agent/slash-commands/available-commands";
import { executeAcpBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import type { SlashCommandRuntime, TuiSlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";

function textRuntime() {
	const output: string[] = [];
	return {
		output,
		runtime: {
			session: { model: undefined },
			output: (text: string) => output.push(text),
		} as unknown as SlashCommandRuntime,
	};
}

describe("magic keyword public slash dispatch", () => {
	it.each(["ultrathink", "orchestrate", "workflowz", "fullsend"])(
		"expands /%s in both the public TUI and ACP paths",
		async keyword => {
			const { runtime } = textRuntime();
			expect(await executeAcpBuiltinSlashCommand(`/${keyword}`, runtime)).toEqual({ prompt: keyword });
			expect(await executeAcpBuiltinSlashCommand(`/${keyword}  task-marker-43d  `, runtime)).toEqual({
				prompt: `${keyword} task-marker-43d`,
			});
			let editor = `/${keyword} task-marker-43d`;
			expect(
				await executeBuiltinSlashCommand(editor, {
					ctx: {
						session: { model: undefined },
						editor: {
							setText: (text: string) => {
								editor = text;
							},
						},
						sessionManager: { getCwd: () => "/tmp/commands" },
					},
				} as unknown as TuiSlashCommandRuntime),
			).toBe(`${keyword} task-marker-43d`);
			expect(editor).toBe("");
		},
	);

	it("preserves a read-only collab guest's keyword draft instead of returning a host prompt", async () => {
		const draft = "/fullsend task-marker-43d";
		let editor = draft;
		const statuses: string[] = [];
		const result = await executeBuiltinSlashCommand(draft, {
			ctx: {
				session: { model: undefined },
				collabGuest: { readOnly: true },
				editor: {
					setText: (text: string) => {
						editor = text;
					},
				},
				sessionManager: { getCwd: () => "/tmp/commands" },
				showStatus: (text: string) => statuses.push(text),
			},
		} as unknown as TuiSlashCommandRuntime);

		expect(result).toBe(true);
		expect(editor).toBe(draft);
		expect(statuses).toHaveLength(1);
		expect(statuses[0]).toContain("read-only");
	});

	it("expands and clears a writable collab guest's keyword draft for host forwarding", async () => {
		let editor = "/fullsend task-marker-43d";
		const statuses: string[] = [];
		const result = await executeBuiltinSlashCommand(editor, {
			ctx: {
				session: { model: undefined },
				collabGuest: { readOnly: false },
				editor: {
					setText: (text: string) => {
						editor = text;
					},
				},
				sessionManager: { getCwd: () => "/tmp/commands" },
				showStatus: (text: string) => statuses.push(text),
			},
		} as unknown as TuiSlashCommandRuntime);

		expect(result).toBe("fullsend task-marker-43d");
		expect(editor).toBe("");
		expect(statuses).toEqual([]);
	});
});

describe("JCH scope parsing through the public ACP dispatcher", () => {
	it.each([
		["jchfuncreviewfix", "commit", "audit-ref-$&-43d"],
		["jchfuncreview", "commit", "audit-ref-$&-43d"],
		["jchverify", "commit", "audit-ref-$&-43d"],
		["jchfuncreview", "path", "src/path marker-$&-43d"],
		["jchverify", "path", "src/path marker-$&-43d"],
	])("passes the complete %s %s target without replacement-string expansion", async (name, scope, target) => {
		const { runtime, output } = textRuntime();
		const prompt = await executeAcpBuiltinSlashCommand(`/${name} ${scope} ${target}`, runtime);
		if (!prompt || !("prompt" in prompt)) throw new Error("Expected a residual model prompt");
		expect(prompt.prompt).toContain(JSON.stringify(target));
		expect(output).toEqual([]);
	});

	it.each([
		"/jchfix",
		"/jchdiagnose",
		"/jchfuncreviewfix commit a b",
		"/jchfuncreviewfix path src",
		"/jchfuncreview repo",
		"/jchfuncreview commit",
		"/jchverify",
		"/jchverify uncommitted extra",
		"/jchcatchup unknown",
	])("rejects %s without producing a model prompt", async input => {
		const { runtime } = textRuntime();
		expect(await executeAcpBuiltinSlashCommand(input, runtime)).toEqual({ consumed: true, failed: true });
	});

	it.each([
		["/jchfuncreviewfix repo", "当前整个代码仓库（以工作区现状为准，包括未提交内容）。"],
		["/jchfuncreview uncommitted", "当前工作区的全部未提交修改（包括 staged、unstaged 和 untracked 内容）。"],
		["/jchverify uncommitted", "当前工作区的全部未提交修改（包括 staged、unstaged 和 untracked 内容）。"],
	])("accepts the explicit no-target scope %s", async (input, scopeText) => {
		const { runtime } = textRuntime();
		const result = await executeAcpBuiltinSlashCommand(input, runtime);
		if (!result || !("prompt" in result)) throw new Error("Expected a residual model prompt");
		expect(result.prompt).toContain(scopeText);
	});
});

describe("JCH batch argument parsing", () => {
	it.each([" ", "\n", "\r\n"])("preserves task markup and code whitespace after delimiter %j", async delimiter => {
		const { runtime, output } = textRuntime();
		const task = [
			"    first()",
			"    second()",
			"审查 src/a.ts & src/b.ts",
			"保留 <T>、{{targetItems}} 和 $& 原文",
			"```ts",
			"const s = `a  ",
			"b`;",
			"```",
			"",
			"",
			"| padded | cells |",
			"  \t",
			"",
		].join("\r\n");
		const result = await executeAcpBuiltinSlashCommand(`/jch-workflowzbatch 200\t30${delimiter}${task}`, runtime);
		if (!result || !("prompt" in result)) throw new Error("Expected a residual model prompt");
		expect(result.prompt.startsWith("workflowz\n")).toBe(true);
		expect(result.prompt.split("## 任务正文\n\n")[1]).toBe(task);
		expect(output).toEqual([]);
	});

	it.each([
		["non-positive count", "0 30 审查"],
		["missing task", "200 30"],
		["blank task", "2 1\r\n    \r\n\t"],
		["unsafe task target", "9007199254740992 30 审查"],
		["unsafe count", "200 9007199254740992 审查"],
	])("rejects %s without starting a model turn", async (_boundary, args) => {
		const { runtime } = textRuntime();
		expect(await executeAcpBuiltinSlashCommand(`/jch-workflowzbatch ${args}`, runtime)).toEqual({
			consumed: true,
			failed: true,
		});
	});
});

describe("public command inventory", () => {
	it("does not advertise custom or file names captured by a builtin colon-prefix or alias", async () => {
		const session = {
			customCommands: [
				{ command: { name: "login:company", description: "Unreachable panel shadow" } },
				{ command: { name: "model:company", description: "Unreachable shared shadow" } },
				{ command: { name: "review:company", description: "Reachable custom command" } },
			],
			skills: [],
			sessionManager: { getCwd: () => "/tmp/commands" },
			setSlashCommands: () => {},
		} as unknown as AvailableCommandsSession;
		const commands = await buildAvailableSlashCommands(
			session,
			async () => [
				{ name: "models:company", description: "Unreachable alias shadow", content: "body", source: "test" },
				{ name: "review:file", description: "Reachable file command", content: "body", source: "test" },
			],
			{ includeTuiOnlyBuiltins: true },
		);
		const names = commands.map(command => command.name);
		expect(names).not.toContain("login:company");
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

describe("JCH DFT explanation target handoff", () => {
	it("clears the TUI command only after expanding its complete target", async () => {
		let editorText = "/jchdftexplain DFT-target-marker-43d";
		const prompt = await executeBuiltinSlashCommand(editorText, {
			ctx: {
				session: { model: undefined },
				editor: {
					setText: (text: string) => {
						editorText = text;
					},
				},
				sessionManager: { getCwd: () => process.cwd() },
			},
		} as unknown as TuiSlashCommandRuntime);
		expect(prompt).toContain("DFT-target-marker-43d");
		expect(editorText).toBe("");
	});
});
