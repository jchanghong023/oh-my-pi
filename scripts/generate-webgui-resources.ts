#!/usr/bin/env bun

import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { withCompilerActivity } from "./test-gate-events";

export interface WebGuiResources {
	readonly archive: Uint8Array;
	readonly embedded: string;
	readonly fingerprint: string;
}

interface ResourceFile {
	path: string;
	size: number;
	sha256: string;
	data: string;
}

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
	const files: ResourceFile[] = [];
	async function collect(prefix: string): Promise<void> {
		const entries = await fs.readdir(path.join(buildDir, prefix), { withFileTypes: true });
		entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
		for (const entry of entries) {
			if (entry.name.startsWith(".")) continue;
			const name = path.posix.join(prefix, entry.name);
			if (entry.isDirectory()) {
				await collect(name);
			} else if (entry.isFile()) {
				const bytes = await fs.readFile(path.join(buildDir, name));
				files.push({
					path: name,
					size: bytes.length,
					sha256: createHash("sha256").update(bytes).digest("hex"),
					data: bytes.toString("base64"),
				});
			} else {
				throw new Error(`Unsupported WebGUI build resource: ${name}`);
			}
		}
	}
	await collect("");
	const index = files.find(file => file.path === "index.html");
	const html = index ? Buffer.from(index.data, "base64").toString("utf8") : "";
	const moduleScripts = [...html.matchAll(/<script\b[^>]*\btype=["']module["'][^>]*\bsrc=["']([^"']+)["']/gi)];
	if (
		!index?.size ||
		!moduleScripts.length ||
		moduleScripts.some(match => {
			const name = match[1]!.replace(/^\.\//, "").replace(/^\//, "");
			return !files.some(file => file.path === name && file.size > 0 && /\.(?:m?js)$/.test(file.path));
		})
	) {
		throw new Error("WebGUI production build must contain index.html and its nonempty local module scripts.");
	}
	const fingerprint = createHash("sha256")
		.update(JSON.stringify(files.map(file => [file.path, file.size, file.sha256])))
		.digest("hex");
	// Level 19 shrinks the embedded WebGUI archive by ~20% at build time (no runtime cost);
	// level 22 gains only ~1% more and is noticeably slower to regenerate.
	const archive = await Bun.zstdCompress(JSON.stringify({ version: 1, fingerprint, files }), { level: 19 });
	return { archive, embedded: Buffer.from(archive).toString("base64"), fingerprint };
}

/** Publish the same verified payload for npm SDK consumers and the bundled CLI. */
export async function writeWebGuiResources(outputDir: string, resources: WebGuiResources): Promise<void> {
	await fs.mkdir(outputDir, { recursive: true });
	const output = path.join(outputDir, "webgui-resources.json.zst");
	const temporary = `${output}.${randomUUID()}.tmp`;
	try {
		await fs.writeFile(temporary, resources.archive, { flag: "wx" });
		await fs.rename(temporary, output);
	} finally {
		await fs.rm(temporary, { force: true });
	}
}

if (import.meta.main) {
	const root = path.resolve(import.meta.dir, "..");
	const resources = await prepareWebGuiResources(root);
	await writeWebGuiResources(path.join(root, "packages/coding-agent/dist"), resources);
	console.log(`Generated WebGUI resources ${resources.fingerprint}`);
}
