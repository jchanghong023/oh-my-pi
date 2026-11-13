#!/usr/bin/env bun

import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { buildEmbeddedArchive, decodeEmbeddedArchive } from "@oh-my-pi/pi-utils/embedded-archive";
import { withCompilerActivity } from "./test-gate-events";

export interface WebGuiResources {
	readonly archive: Uint8Array;
	readonly text: string;
	readonly fingerprint: string;
}

const META_FILE = "__omp_meta__.json";
const RESOURCES_FILE = "webgui-resources.generated.txt";

const builds = new Map<string, Promise<WebGuiResources>>();

/** Build once per process, including every target in a release matrix. No install or network fallback. */
export function prepareWebGuiResources(repoRoot: string): Promise<WebGuiResources> {
	const root = path.resolve(repoRoot);
	let pending = builds.get(root);
	if (!pending) {
		pending = buildResources(root);
		builds.set(root, pending);
	}
	return pending;
}

/** Fingerprint every relative path, size and digest; the runtime recomputes this from the archive. */
function resourcesFingerprint(entries: ReadonlyArray<readonly [string, number, string]>): string {
	return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

async function buildResources(repoRoot: string): Promise<WebGuiResources> {
	const frontend = path.join(repoRoot, "vendor/zcode-frontend");
	const vite = path.join(frontend, "node_modules/vite/bin/vite.js");
	try {
		await fs.access(vite);
	} catch (error) {
		throw new Error(
			"WebGUI build dependencies are unavailable; prepare the frontend dependencies before building OMP.",
			{
				cause: error,
			},
		);
	}
	await withCompilerActivity(async () => {
		const child = Bun.spawn(
			[process.execPath, "--no-install", vite, "build", "--config", path.join(frontend, "preview/vite.config.ts")],
			{
				cwd: repoRoot,
				stdout: "inherit",
				stderr: "inherit",
			},
		);
		const status = await child.exited;
		if (status !== 0) throw new Error(`WebGUI production build failed with exit code ${status}`);
	});
	const buildDir = path.join(frontend, "build/webgui");
	const files = new Map<string, Uint8Array>();
	const fingerprints: Array<[string, number, string]> = [];
	async function collect(prefix: string): Promise<void> {
		const dirEntries = await fs.readdir(path.join(buildDir, prefix), { withFileTypes: true });
		dirEntries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
		for (const entry of dirEntries) {
			if (entry.name.startsWith(".")) continue;
			const name = path.posix.join(prefix, entry.name);
			if (entry.isDirectory()) {
				await collect(name);
			} else if (entry.isFile()) {
				const bytes = await fs.readFile(path.join(buildDir, name));
				files.set(name, bytes);
				fingerprints.push([name, bytes.length, createHash("sha256").update(bytes).digest("hex")]);
			} else {
				throw new Error(`Unsupported WebGUI build resource: ${name}`);
			}
		}
	}
	await collect("");
	fingerprints.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	const index = files.get("index.html");
	const html = index ? Buffer.from(index).toString("utf8") : "";
	const moduleScripts = [...html.matchAll(/<script\b[^>]*\btype=["']module["'][^>]*\bsrc=["']([^"']+)["']/gi)];
	if (
		!index?.length ||
		!moduleScripts.length ||
		moduleScripts.some(match => {
			const name = match[1]!.replace(/^\.\//, "").replace(/^\//, "");
			const script = files.get(name);
			return !script?.length || !/\.(?:m?js)$/.test(name);
		})
	) {
		throw new Error("WebGUI production build must contain index.html and its nonempty local module scripts.");
	}
	const fingerprint = resourcesFingerprint(fingerprints);
	files.set(META_FILE, Buffer.from(JSON.stringify({ fingerprint })));
	const text = await buildEmbeddedArchive(files);
	const archive = decodeEmbeddedArchive(text);
	if (!archive) throw new Error("Generated WebGUI resources are not a gzip payload.");
	return { archive, text, fingerprint };
}

/** Publish the same verified payload for npm SDK consumers and the bundled CLI. */
export async function writeWebGuiResources(outputDir: string, resources: WebGuiResources): Promise<void> {
	await writeResourcesFile(outputDir, resources.text);
}

/** Restore the checked-in placeholder so source trees never keep a generated payload. */
export async function resetWebGuiResources(outputDir: string): Promise<void> {
	await writeResourcesFile(outputDir, "");
}

async function writeResourcesFile(outputDir: string, text: string): Promise<void> {
	await fs.mkdir(outputDir, { recursive: true });
	const output = path.join(outputDir, RESOURCES_FILE);
	const temporary = `${output}.${randomUUID()}.tmp`;
	try {
		await fs.writeFile(temporary, text, { flag: "wx" });
		await fs.rename(temporary, output);
	} finally {
		await fs.rm(temporary, { force: true });
	}
}

if (import.meta.main) {
	const root = path.resolve(import.meta.dir, "..");
	const resources = await prepareWebGuiResources(root);
	await writeWebGuiResources(path.join(root, "packages/coding-agent/src/webgui"), resources);
	console.log(`Generated WebGUI resources ${resources.fingerprint}`);
}
