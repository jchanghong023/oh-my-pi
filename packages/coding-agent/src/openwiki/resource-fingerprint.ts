import { createHash } from "node:crypto";
import { readFileSync, readdirSync, realpathSync } from "node:fs";
import * as path from "node:path";
import { openWikiLicensedPackages, openWikiPackageDirectory } from "./resource-dependencies";

/** Fingerprint the checkout inputs used to generate browser assets and notices. */
export function openWikiResourceFingerprint(repoRoot: string): string {
	const hash = createHash("sha256");
	function add(relative: string): void {
		const entries = readdirSync(path.join(repoRoot, relative), { withFileTypes: true });
		for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
			const name = path.join(relative, entry.name);
			if (entry.isDirectory()) add(name);
			else if (entry.isFile()) file(name);
		}
	}
	function file(name: string): void {
		hash.update(name.replaceAll(path.sep, "/"));
		hash.update("\0");
		hash.update(readFileSync(path.join(repoRoot, name)));
		hash.update("\0");
	}
	add("vendor/openwiki/src");
	add("vendor/openwiki/skills");
	for (const name of [
		"vendor/openwiki/LICENSE",
		"vendor/openwiki/package.json",
		"packages/coding-agent/package.json",
		"packages/coding-agent/scripts/openwiki-resources.ts",
		"packages/coding-agent/src/openwiki/resource-dependencies.ts",
		"packages/coding-agent/src/openwiki/resource-fingerprint.ts",
		"bun.lock",
	])
		file(name);
	const packageDir = path.join(repoRoot, "packages/coding-agent");
	const visited = new Set<string>();
	function dependency(name: string, from: string, optional = false): void {
		let dir: string;
		try {
			dir = realpathSync(openWikiPackageDirectory(name, from));
		} catch (error) {
			if (optional) return;
			throw error;
		}
		if (visited.has(dir)) return;
		visited.add(dir);
		const manifest = path.join(dir, "package.json");
		const content = readFileSync(manifest);
		hash.update(manifest);
		hash.update(content);
		const pkg = JSON.parse(content.toString()) as {
			dependencies?: Record<string, string>;
			optionalDependencies?: Record<string, string>;
		};
		for (const name of readdirSync(dir)
			.filter(name => /^(licen[cs]e|copying|notice)(\..*)?$/i.test(name))
			.sort()) {
			hash.update(name);
			hash.update(readFileSync(path.join(dir, name)));
		}
		for (const name of Object.keys(pkg.dependencies ?? {}).sort()) dependency(name, dir);
		for (const name of Object.keys(pkg.optionalDependencies ?? {}).sort()) dependency(name, dir, true);
	}
	for (const name of openWikiLicensedPackages) dependency(name, packageDir);
	for (const [name, asset] of [
		["force-graph", "dist/force-graph.min.js"],
		["openwiki-marked", "marked.min.js"],
		["dompurify", "dist/purify.min.js"],
		["mermaid", "dist/mermaid.min.js"],
	]) {
		hash.update(readFileSync(path.join(openWikiPackageDirectory(name, packageDir), asset)));
	}
	return hash.digest("hex");
}
