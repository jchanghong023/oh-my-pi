import { expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Settings } from "../src/config/settings";
import { DocsService } from "../src/docs/service";
import { WikiTool } from "../src/tools/wiki";

it("returns indented code followed by a rule instead of discarding it as a converter heading", async () => {
	const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "docs-indented-setext-"));
	const root = path.join(temporary, "source");
	const agentDir = path.join(temporary, "agent");
	const source = "# Notes\n\n    Cell\n----\n";
	try {
		await Bun.write(path.join(root, "guide.md"), source);
		const service = new DocsService({ agentDir, cwd: root });
		try {
			await service.init(".", "manual");
		} finally {
			service.close();
		}
		await fs.rm(root, { recursive: true });
		const tool = new WikiTool({
			cwd: root,
			hasUI: false,
			settings: { getAgentDir: () => agentDir } as unknown as Settings,
			getSessionFile: () => null,
			getSessionSpawns: () => null,
		});
		const result = await tool.execute("indented-code", { query: "Cell" });
		const text = result.content.map(item => (item.type === "text" ? item.text : "")).join("\n");
		expect(text).toContain(source);
		expect(text).toContain("guide.md:1-4");
		expect(text).not.toContain("heading only");
	} finally {
		await fs.rm(temporary, { recursive: true, force: true });
	}
});
