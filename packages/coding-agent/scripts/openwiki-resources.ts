import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { buildEmbeddedArchive } from "@oh-my-pi/pi-utils/embedded-archive";
import {
	openWikiLicensedPackages as licensedPackages,
	openWikiPackageDirectory as packageDirectory,
} from "../src/openwiki/resource-dependencies";
import { openWikiResourceFingerprint } from "../src/openwiki/resource-fingerprint";

const repoRoot = path.resolve(import.meta.dir, "../../..");
const vendorRoot = path.join(repoRoot, "vendor/openwiki");
const packageDir = path.join(repoRoot, "packages/coding-agent");
const generatedFile = path.join(packageDir, "src/openwiki/openwiki-resources.generated.txt");

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
	files: ReadonlyMap<string, Uint8Array>;
	sourceFingerprint: string;
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
	};
	const skills = await filesUnder(path.join(vendorRoot, "skills"));
	if (fingerprint !== openWikiResourceFingerprint(repoRoot)) {
		throw new Error("OpenWiki resource inputs changed during generation; regenerate the resources.");
	}
	const files = new Map<string, Uint8Array>();
	for (const [name, content] of Object.entries(skills)) files.set(`skills/${name}`, Buffer.from(content));
	for (const [name, content] of Object.entries(visual)) files.set(`visual/${name}`, Buffer.from(content));
	files.set("__omp_meta__.json", Buffer.from(JSON.stringify({ sourceFingerprint: fingerprint })));
	return { files, sourceFingerprint: fingerprint };
}

/** Publish the archive text in one rename, never a partially written file. */
export async function writeOpenWikiResources(resources: OpenWikiResources): Promise<void> {
	const archive = await buildEmbeddedArchive(resources.files);
	await mkdir(path.dirname(generatedFile), { recursive: true });
	const temporary = `${generatedFile}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporary, archive, { flag: "wx" });
		await rename(temporary, generatedFile);
	} finally {
		await rm(temporary, { force: true });
	}
}

/** Restore the checked-in placeholder so stale resources cannot masquerade as current. */
export async function resetOpenWikiResources(): Promise<void> {
	await mkdir(path.dirname(generatedFile), { recursive: true });
	await writeFile(generatedFile, "");
}

if (import.meta.main) {
	if (!existsSync(path.join(vendorRoot, "package.json")) && process.argv.includes("--if-present")) {
		await resetOpenWikiResources();
		console.warn(
			"OpenWiki submodule absent; initialize it and run bun run gen:openwiki-resources before using OpenWiki.",
		);
	} else {
		await writeOpenWikiResources(await buildOpenWikiResources());
	}
}
