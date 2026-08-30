import { describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { lookupBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import type { SlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import { createTools, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

function makeSession(): ToolSession {
	return {
		cwd: process.cwd(),
		hasUI: false,
		skipPythonPreflight: true,
		settings: Settings.isolated({}),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
	} as unknown as ToolSession;
}

describe("manual document researcher routing", () => {
	it("keeps docs out of default tool contexts and allows an explicit docs-only context", async () => {
		const session = makeSession();
		const defaultNames = (await createTools(session)).map(tool => tool.name);
		const explicitNames = (await createTools(session, ["docs"])).map(tool => tool.name);

		expect(defaultNames).not.toContain("docs");
		expect(explicitNames).toContain("docs");
	});

	it("omits doc-researcher from the permanent task tool catalog", async () => {
		const task = await TaskTool.create(makeSession());

		expect(task.description).not.toContain("doc-researcher");
	});

	it("routes only an explicit /doc question to doc-researcher", async () => {
		const command = lookupBuiltinSlashCommand("doc");
		if (!command?.handle) throw new Error("Expected /doc to be registered");
		const output: string[] = [];
		const runtime = { output: (text: string) => output.push(text) } as unknown as SlashCommandRuntime;

		const empty = await command.handle({ name: "doc", args: "", text: "/doc" }, runtime);
		const routed = await command.handle(
			{
				name: "doc",
				args: "  What does the indexed guide require?  ",
				text: "/doc What does the indexed guide require?",
			},
			runtime,
		);

		expect(empty).toEqual({ consumed: true });
		expect(output).toEqual(["Usage: /doc <question>"]);
		expect(routed).toEqual({
			prompt: [
				"Manual document research request.",
				'MUST delegate through `task` with `agent: "doc-researcher"` and wait for its result.',
				"MUST pass the question verbatim as the assignment, then return its evidence-backed answer and citations.",
				"",
				"What does the indexed guide require?",
			].join("\n"),
		});
	});
});
