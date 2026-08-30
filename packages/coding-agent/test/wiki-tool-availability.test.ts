import { describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { lookupBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import { createTools, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

function makeSession(restrictToolNames = false): ToolSession {
	return {
		cwd: process.cwd(),
		hasUI: false,
		restrictToolNames,
		skipPythonPreflight: true,
		settings: Settings.isolated({}),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
	} as unknown as ToolSession;
}

describe("built-in wiki availability", () => {
	it("grants essential wiki to unrestricted sessions without widening restricted allowlists", async () => {
		const defaultTools = await createTools(makeSession());
		const readTools = await createTools(makeSession(), ["read"]);
		const restrictedReadTools = await createTools(makeSession(true), ["read"]);
		const restrictedWikiTools = await createTools(makeSession(true), ["wiki"]);

		expect(defaultTools.map(tool => tool.name)).toContain("wiki");
		expect(defaultTools.find(tool => tool.name === "wiki")?.loadMode).toBe("essential");
		expect(readTools.map(tool => tool.name)).toEqual(expect.arrayContaining(["read", "wiki"]));
		expect(restrictedReadTools.map(tool => tool.name)).toEqual(["read"]);
		expect(restrictedWikiTools.map(tool => tool.name)).toEqual(["wiki"]);
	});

	it("removes the dedicated agent and document research shortcut", async () => {
		const task = await TaskTool.create(makeSession());

		expect(task.description).not.toContain("doc-researcher");
		expect(lookupBuiltinSlashCommand("doc")).toBeUndefined();
		expect(lookupBuiltinSlashCommand("docs")).toBeDefined();
	});
});
