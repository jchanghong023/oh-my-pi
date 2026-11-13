import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { openWikiLicensedPackages } from "../../src/openwiki/resource-dependencies";
import { openWikiResourceFingerprint } from "../../src/openwiki/resource-fingerprint";
import { materializeOpenWikiSkillsFromFiles } from "../../src/openwiki/resources";
import {
	assertOpenWikiArchiveFresh,
	isOpenWikiArchiveStale,
	renderOpenWikiVisualAssets,
} from "../../src/openwiki/visual-assets";

function fileMap(entries: ReadonlyMap<string, string>): Map<string, File> {
	return new Map([...entries].map(([name, content]) => [name, new File([content], name)]));
}

function skillsFixture(skills: Record<string, string>): Map<string, File> {
	return fileMap(new Map(Object.entries(skills).map(([name, content]) => [`skills/${name}`, content])));
}

describe("OpenWiki embedded generation resources", () => {
	it("materializes the real bundled Mermaid skill into an isolated profile and reuses immutable content", async () => {
		using dir = TempDir.createSync("@omp-openwiki-resources-");
		const name = "mermaid-diagrams/SKILL.md";
		const content = await readFile(path.resolve(import.meta.dir, "../../../../vendor/openwiki/skills", name), "utf8");
		const files = skillsFixture({ [name]: content });
		const [first, concurrent] = await Promise.all([
			materializeOpenWikiSkillsFromFiles(dir.join("profile-a"), files),
			materializeOpenWikiSkillsFromFiles(dir.join("profile-a"), files),
		]);
		expect(first).toBe(concurrent);
		expect(first.startsWith(dir.join("profile-a", "openwiki", "resources"))).toBe(true);
		expect(await readFile(path.join(first, name), "utf8")).toBe(content);
		expect(await materializeOpenWikiSkillsFromFiles(dir.join("profile-a"), files)).toBe(first);
		const other = await materializeOpenWikiSkillsFromFiles(dir.join("profile-b"), files);
		expect(other).not.toBe(first);
		expect(await readFile(path.join(other, name), "utf8")).toBe(content);
		expect(
			(await readdir(dir.join("profile-a", "openwiki", "resources"))).some(name => name.startsWith(".skills-")),
		).toBe(false);
	});

	// Reject unsafe package entries atomically, with no partial skills left behind.
	it.each(["../escape.md", "/absolute.md", "mermaid-diagrams/../escape.md", "mermaid-diagrams\\escape.md"])(
		"rejects unsafe embedded path %s without publishing resources",
		async name => {
			using dir = TempDir.createSync("@omp-openwiki-resource-path-");
			const files = skillsFixture({ "mermaid-diagrams/SKILL.md": "valid skill", [name]: "escape" });
			await expect(materializeOpenWikiSkillsFromFiles(dir.path(), files)).rejects.toThrow(
				"Invalid embedded OpenWiki skill path",
			);
			expect(existsSync(dir.join("openwiki", "resources"))).toBe(false);
			expect(await Bun.file(dir.join("escape.md")).exists()).toBe(false);
		},
	);

	it("renders visualizer assets from an archive file map", async () => {
		const files = fileMap(
			new Map([
				["visual/client.js", "client"],
				["visual/client-lib.js", "library"],
				["visual/styles.css", "styles"],
				["visual/force-graph.js", "force"],
				["visual/marked.js", "marked"],
				["visual/purify.js", "purify"],
				["visual/mermaid.js", "mermaid"],
				["visual/licenses/openwiki.txt", "openwiki license"],
				["visual/licenses/zod@1.0.0.txt", "zod license"],
			]),
		);
		const assets = await renderOpenWikiVisualAssets(files);
		expect(assets.clientJs).toBe("client");
		expect(assets.clientLibJs).toBe("library");
		expect(assets.stylesCss).toBe("styles");
		expect(assets.browserAssets).toEqual({
			"force-graph.js": "force",
			"marked.js": "marked",
			"purify.js": "purify",
			"mermaid.js": "mermaid",
		});
		expect(assets.licenseAssets).toEqual({
			"licenses/openwiki.txt": "openwiki license",
			"licenses/zod@1.0.0.txt": "zod license",
		});
	});

	it("rejects stale source fingerprints and accepts unknown or matching ones", () => {
		expect(isOpenWikiArchiveStale("generated", "current")).toBe(true);
		expect(isOpenWikiArchiveStale("generated", "generated")).toBe(false);
		expect(isOpenWikiArchiveStale("generated", undefined)).toBe(false);
		expect(() => assertOpenWikiArchiveFresh("generated", "current")).toThrow("OpenWiki visualizer assets are stale");
		expect(() => assertOpenWikiArchiveFresh("generated", "current")).toThrow("gen:openwiki-resources");
		expect(() => assertOpenWikiArchiveFresh("generated", "generated")).not.toThrow();
	});
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
