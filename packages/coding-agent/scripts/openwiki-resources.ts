import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import {
	openWikiLicensedPackages as licensedPackages,
	openWikiPackageDirectory as packageDirectory,
} from "../src/openwiki/resource-dependencies";
import { openWikiResourceFingerprint } from "../src/openwiki/resource-fingerprint";

const repoRoot = path.resolve(import.meta.dir, "../../..");
const vendorRoot = path.join(repoRoot, "vendor/openwiki");
const outputDir = path.join(repoRoot, "packages/coding-agent/dist/openwiki-resources");
const packageDir = path.join(repoRoot, "packages/coding-agent");

async function filesUnder(root: string, prefix = ""): Promise<Record<string, string>> {
	const entries: Record<string, string> = {};
	for (const entry of await readdir(path.join(root, prefix), { withFileTypes: true })) {
		const name = path.posix.join(prefix, entry.name);
		if (entry.isDirectory()) Object.assign(entries, await filesUnder(root, name));
		else if (entry.isFile()) entries[name] = await readFile(path.join(root, name), "utf8");
	}
	return entries;
}

/** Include license and notice files for the embedded dependency closure. */
async function browserLicenses(): Promise<Record<string, string>> {
	const notices: Record<string, string> = {};
	const visited = new Set<string>();
	async function visit(name: string, from: string, optional = false): Promise<void> {
		let dir: string;
		try {
			dir = await realpath(packageDirectory(name, from));
		} catch (error) {
			if (optional) return;
			throw error;
		}
		if (visited.has(dir)) return;
		visited.add(dir);
		const pkg = JSON.parse(await readFile(path.join(dir, "package.json"), "utf8")) as {
			name: string;
			version: string;
			license?: string;
			dependencies?: Record<string, string>;
			optionalDependencies?: Record<string, string>;
		};
		const label = `${pkg.name}@${pkg.version}`;
		const files = (await readdir(dir)).filter(file => /^(licen[cs]e|copying|notice)(\..*)?$/i.test(file));
		let content = `${label}\nLicense: ${pkg.license ?? "see included notices"}\n`;
		for (const file of files.sort())
			content += `\n--- ${file} ---\n${await readFile(path.join(dir, file), "utf8")}\n`;
		notices[`licenses/${label.replaceAll("/", "_")}.txt`] = content;
		for (const dep of Object.keys(pkg.dependencies ?? {}).sort()) await visit(dep, dir);
		for (const dep of Object.keys(pkg.optionalDependencies ?? {}).sort()) await visit(dep, dir, true);
	}
	for (const name of licensedPackages) await visit(name, packageDir);
	return notices;
}

async function browserScript(entry: string): Promise<string> {
	const output = await Bun.build({
		entrypoints: [path.join(vendorRoot, "src/visualize", entry)],
		target: "browser",
		format: "esm",
	});
	if (!output.success)
		throw new Error(`OpenWiki browser bundle failed: ${output.logs.map(log => log.message).join("\n")}`);
	return output.outputs[0]!.text();
}

export interface OpenWikiResources {
	skills: Record<string, string>;
	visual: Record<string, string>;
}

/** Read the checked-out fork; local uncommitted changes are intentionally respected. */
export async function buildOpenWikiResources(): Promise<OpenWikiResources> {
	const fingerprint = openWikiResourceFingerprint(repoRoot);
	const visual: Record<string, string> = {
		"client.js": await browserScript("client.ts"),
		"client-lib.js": await browserScript("client-lib.ts"),
		"styles.css": await readFile(path.join(vendorRoot, "src/visualize/styles.css"), "utf8"),
		"force-graph.js": await readFile(
			path.join(packageDirectory("force-graph", packageDir), "dist/force-graph.min.js"),
			"utf8",
		),
		"marked.js": await readFile(path.join(packageDirectory("openwiki-marked", packageDir), "marked.min.js"), "utf8"),
		"purify.js": await readFile(path.join(packageDirectory("dompurify", packageDir), "dist/purify.min.js"), "utf8"),
		"mermaid.js": await readFile(path.join(packageDirectory("mermaid", packageDir), "dist/mermaid.min.js"), "utf8"),
		"licenses/openwiki.txt": await readFile(path.join(vendorRoot, "LICENSE"), "utf8"),
		...(await browserLicenses()),
		_sourceFingerprint: fingerprint,
	};
	const skills = await filesUnder(path.join(vendorRoot, "skills"));
	if (fingerprint !== openWikiResourceFingerprint(repoRoot)) {
		throw new Error("OpenWiki resource inputs changed during generation; regenerate the resources.");
	}
	return { skills, visual };
}

/** Publish a complete JSON resource in one rename, never a partially written file. */
export async function writeOpenWikiResource(file: string, value: Record<string, string>): Promise<void> {
	await mkdir(path.dirname(file), { recursive: true });
	const temporary = `${file}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporary, JSON.stringify(value), { flag: "wx" });
		await rename(temporary, file);
	} finally {
		await rm(temporary, { force: true });
	}
}

if (import.meta.main) {
	if (!existsSync(path.join(vendorRoot, "package.json")) && process.argv.includes("--if-present")) {
		// A previously generated map must not masquerade as the current checkout.
		await rm(path.join(outputDir, "visual-assets.json"), { force: true });
		console.warn(
			"OpenWiki submodule absent; initialize it and run bun run gen:openwiki-resources before using OpenWiki.",
		);
	} else {
		const resources = await buildOpenWikiResources();
		await writeOpenWikiResource(path.join(outputDir, "visual-assets.json"), resources.visual);
	}
}
