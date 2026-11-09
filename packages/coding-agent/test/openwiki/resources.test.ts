import { describe, expect, it } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { openWikiLicensedPackages } from "../../src/openwiki/resource-dependencies";
import { openWikiResourceFingerprint } from "../../src/openwiki/resource-fingerprint";
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

async function fingerprintFixture(root: string): Promise<void> {
	for (const name of [
		"vendor/openwiki/src/visualize/client.ts",
		"vendor/openwiki/skills/mermaid-diagrams/SKILL.md",
		"vendor/openwiki/LICENSE",
		"vendor/openwiki/package.json",
		"packages/coding-agent/package.json",
		"packages/coding-agent/scripts/openwiki-resources.ts",
		"packages/coding-agent/src/openwiki/resource-dependencies.ts",
		"packages/coding-agent/src/openwiki/resource-fingerprint.ts",
		"bun.lock",
	]) {
		await Bun.write(path.join(root, name), name.endsWith("package.json") ? '{"version":"1.0.0"}' : "original");
	}
	for (const name of openWikiLicensedPackages) {
		await Bun.write(
			path.join(root, "node_modules", name, "package.json"),
			JSON.stringify({ name, version: "1.0.0", license: "MIT" }),
		);
	}
	for (const [name, asset] of [
		["force-graph", "dist/force-graph.min.js"],
		["openwiki-marked", "marked.min.js"],
		["dompurify", "dist/purify.min.js"],
		["mermaid", "dist/mermaid.min.js"],
	] as const) {
		await Bun.write(path.join(root, "node_modules", name, asset), "browser asset");
	}
}

describe("OpenWiki resource validity", () => {
	it("keeps generated resources valid after an OMP version bump or unrelated lockfile change", async () => {
		using dir = TempDir.createSync("@omp-openwiki-fingerprint-");
		await fingerprintFixture(dir.path());
		const generated = openWikiResourceFingerprint(dir.path());
		await Bun.write(dir.join("packages/coding-agent/package.json"), '{"version":"2.0.0"}');
		expect(openWikiResourceFingerprint(dir.path())).toBe(generated);
		await Bun.write(dir.join("bun.lock"), "unrelated dependency update");
		expect(openWikiResourceFingerprint(dir.path())).toBe(generated);
	});

	it("keeps identical resources valid when the checkout moves", async () => {
		using first = TempDir.createSync("@omp-openwiki-fingerprint-first-");
		using second = TempDir.createSync("@omp-openwiki-fingerprint-second-");
		await fingerprintFixture(first.path());
		await fingerprintFixture(second.path());
		expect(openWikiResourceFingerprint(second.path())).toBe(openWikiResourceFingerprint(first.path()));
	});

	it.each([
		"vendor/openwiki/src/visualize/client.ts",
		"node_modules/mermaid/package.json",
		"node_modules/mermaid/dist/mermaid.min.js",
	])("invalidates resources when their actual input changes: %s", async name => {
		using dir = TempDir.createSync("@omp-openwiki-fingerprint-input-");
		await fingerprintFixture(dir.path());
		const generated = openWikiResourceFingerprint(dir.path());
		await Bun.write(dir.join(name), name.endsWith("package.json") ? '{"version":"2.0.0"}' : "changed");
		expect(openWikiResourceFingerprint(dir.path())).not.toBe(generated);
	});
});
