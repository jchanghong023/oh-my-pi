import { describe, expect, it } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { materializeOpenWikiSkills } from "../../src/openwiki/resources";

describe("OpenWiki embedded generation resources", () => {
	// Exercise the packaged branch even when running from a source checkout.
	it("materializes the real bundled Mermaid skill into an isolated profile and reuses immutable content", async () => {
		using dir = TempDir.createSync("@omp-openwiki-resources-");
		const name = "mermaid-diagrams/SKILL.md";
		const content = await readFile(path.resolve(import.meta.dir, "../../../../vendor/openwiki/skills", name), "utf8");
		const previous = process.env.PI_OPENWIKI_SKILLS;
		process.env.PI_OPENWIKI_SKILLS = JSON.stringify({ [name]: content });
		try {
			const [first, concurrent] = await Promise.all([
				materializeOpenWikiSkills(dir.join("profile-a")),
				materializeOpenWikiSkills(dir.join("profile-a")),
			]);
			expect(first).toBe(concurrent);
			expect(first.startsWith(dir.join("profile-a", "openwiki", "resources"))).toBe(true);
			expect(await readFile(path.join(first, name), "utf8")).toBe(content);
			expect(await materializeOpenWikiSkills(dir.join("profile-a"))).toBe(first);
			const other = await materializeOpenWikiSkills(dir.join("profile-b"));
			expect(other).not.toBe(first);
			expect(await readFile(path.join(other, name), "utf8")).toBe(content);
			expect(
				(await readdir(dir.join("profile-a", "openwiki", "resources"))).some(name => name.startsWith(".skills-")),
			).toBe(false);
		} finally {
			if (previous === undefined) delete process.env.PI_OPENWIKI_SKILLS;
			else process.env.PI_OPENWIKI_SKILLS = previous;
		}
	});

	// Reject unsafe package entries atomically, with no partial skills left behind.
	it.each(["../escape.md", "/absolute.md", "mermaid-diagrams/../escape.md", "mermaid-diagrams\\escape.md"])(
		"rejects unsafe embedded path %s without publishing resources",
		async name => {
			using dir = TempDir.createSync("@omp-openwiki-resource-path-");
			const previous = process.env.PI_OPENWIKI_SKILLS;
			process.env.PI_OPENWIKI_SKILLS = JSON.stringify({
				"mermaid-diagrams/SKILL.md": "valid skill",
				[name]: "escape",
			});
			try {
				await expect(materializeOpenWikiSkills(dir.path())).rejects.toThrow("Invalid embedded OpenWiki skill path");
				expect(await readdir(dir.join("openwiki", "resources"))).toEqual([]);
				expect(await Bun.file(dir.join("escape.md")).exists()).toBe(false);
			} finally {
				if (previous === undefined) delete process.env.PI_OPENWIKI_SKILLS;
				else process.env.PI_OPENWIKI_SKILLS = previous;
			}
		},
	);
});
