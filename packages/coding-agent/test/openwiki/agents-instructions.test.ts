import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { updateOpenWikiAgentInstructions } from "../../src/openwiki/agents-instructions";

describe("OpenWiki agent instructions", () => {
	it("preserves user instructions and CLAUDE.md while refreshing one managed block", async () => {
		using dir = TempDir.createSync("@omp-openwiki-agents-");
		const agents = path.join(dir.path(), "AGENTS.md");
		const claude = path.join(dir.path(), "CLAUDE.md");
		await Bun.write(agents, "# Project\n\n<!-- OPENWIKI:START -->\nold\n<!-- OPENWIKI:END -->\n\nKeep this.\n");
		await Bun.write(claude, "# Claude instructions\n");
		await updateOpenWikiAgentInstructions(dir.path());
		const first = await Bun.file(agents).text();
		expect(first).toStartWith("# Project\n\n");
		expect(first).toEndWith("\n\nKeep this.\n");
		expect(first).toContain("openwiki_search");
		expect(first).not.toContain("\nold\n");
		await updateOpenWikiAgentInstructions(dir.path());
		expect(await Bun.file(agents).text()).toBe(first);
		expect(await Bun.file(claude).text()).toBe("# Claude instructions\n");
	});

	it("rejects malformed markers without modifying the file", async () => {
		using dir = TempDir.createSync("@omp-openwiki-agents-");
		const agents = path.join(dir.path(), "AGENTS.md");
		const original = "# Project\n<!-- OPENWIKI:START -->\nkeep\n";
		await Bun.write(agents, original);
		await expect(updateOpenWikiAgentInstructions(dir.path())).rejects.toThrow("markers are malformed");
		expect(await Bun.file(agents).text()).toBe(original);
	});
});
