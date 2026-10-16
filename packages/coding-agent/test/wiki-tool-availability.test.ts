import { describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
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
	it("mounts wiki by default without widening explicit or restricted allowlists", async () => {
		const defaultTools = await createTools(makeSession());
		const readTools = await createTools(makeSession(), ["read"]);
		const restrictedReadTools = await createTools(makeSession(true), ["read"]);
		const restrictedWikiTools = await createTools(makeSession(true), ["wiki"]);

		expect(defaultTools.map(tool => tool.name)).not.toContain("wiki");
		const read = defaultTools.find(tool => tool.name === "read");
		if (!read) throw new Error("Expected the read transport");
		const listing = await read.execute("wiki-device-list", { path: "xd://" });
		expect(listing.content.find(entry => entry.type === "text")?.text).toContain("xd://wiki");
		expect(readTools.map(tool => tool.name)).toEqual(expect.arrayContaining(["read", "wiki"]));
		expect(restrictedReadTools.map(tool => tool.name)).toEqual(["read"]);
		expect(restrictedWikiTools.map(tool => tool.name)).toEqual(["wiki"]);
		const nativeTools = await createTools({
			...makeSession(),
			settings: Settings.isolated({ "tools.xdev": false }),
		});
		expect(nativeTools.map(tool => tool.name)).toContain("wiki");
	});
});
