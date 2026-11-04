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

	it.each([
		"<!-- OPENWIKI:START -->\nkeep\n",
		"<!-- OPENWIKI:END -->\n",
		"<!-- OPENWIKI:END -->\n<!-- OPENWIKI:START -->\n",
		"<!-- OPENWIKI:START -->\n<!-- OPENWIKI:START -->\n<!-- OPENWIKI:END -->\n",
		"<!-- OPENWIKI:START -->\n<!-- OPENWIKI:END -->\n<!-- OPENWIKI:END -->\n",
		"<!-- OPENWIKI:START -->\nfirst\n<!-- OPENWIKI:END -->\n<!-- OPENWIKI:START -->\nsecond\n<!-- OPENWIKI:END -->\n",
	])("rejects malformed or duplicate markers without modifying the file: %s", async markers => {
		using dir = TempDir.createSync("@omp-openwiki-agents-");
		const agents = path.join(dir.path(), "AGENTS.md");
		const original = `# Project\n${markers}`;
		await Bun.write(agents, original);
		await expect(updateOpenWikiAgentInstructions(dir.path())).rejects.toThrow("markers are malformed");
		expect(await Bun.file(agents).text()).toBe(original);
	});

	// First generation creates only the managed AGENTS.md instructions.
	it("creates and appends one managed block without installing a standalone chain", async () => {
		using dir = TempDir.createSync("@omp-openwiki-new-agents-");
		const agents = dir.join("AGENTS.md");
		await updateOpenWikiAgentInstructions(dir.path());
		const created = await Bun.file(agents).text();
		expect(created.match(/<!-- OPENWIKI:START -->/g)).toHaveLength(1);
		expect(created.match(/<!-- OPENWIKI:END -->/g)).toHaveLength(1);
		expect(created).toContain("`openwiki/`");
		expect(created).toContain("openwiki_search");
		expect(created).toContain("openwiki_read");
		expect(await Bun.file(dir.join("CLAUDE.md")).exists()).toBe(false);
		expect(await Bun.file(dir.join(".github", "workflows", "openwiki.yml")).exists()).toBe(false);
		await Bun.write(agents, "# User instructions without final newline");
		await updateOpenWikiAgentInstructions(dir.path());
		expect(await Bun.file(agents).text()).toBe(`# User instructions without final newline\n\n${created}`);
	});
});
