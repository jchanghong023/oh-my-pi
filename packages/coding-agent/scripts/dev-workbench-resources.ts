#!/usr/bin/env bun
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { transformAsync } from "@babel/core";
import { parse } from "acorn";
import { withCompilerActivity } from "../../../scripts/test-gate-events";
import {
	decodeDevWorkbenchAssets,
	devWorkbenchAssetDigest,
	type DevAssetManifest,
	type DevAssetPayload,
	type DevWorkbenchAsset,
} from "../src/dev-workbench/assets";

const repoRoot = path.resolve(import.meta.dir, "../../..");
const collabDir = path.join(repoRoot, "packages/collab-web");
const agentDir = path.join(repoRoot, "packages/coding-agent");
const generatedPath = path.join(agentDir, "src/dev-workbench/assets.generated.json");
const manifests = new WeakMap<ReadonlyMap<string, DevWorkbenchAsset>, DevAssetManifest>();
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function contentType(file: string): string {
	const types: Record<string, string> = {
		".html": "text/html; charset=utf-8",
		".js": "text/javascript; charset=utf-8",
		".css": "text/css; charset=utf-8",
		".json": "application/json; charset=utf-8",
		".webmanifest": "application/manifest+json; charset=utf-8",
		".svg": "image/svg+xml",
		".png": "image/png",
		".jpg": "image/jpeg",
		".jpeg": "image/jpeg",
		".gif": "image/gif",
		".webp": "image/webp",
		".avif": "image/avif",
		".ico": "image/x-icon",
		".woff": "font/woff",
		".woff2": "font/woff2",
		".ttf": "font/ttf",
		".otf": "font/otf",
		".wasm": "application/wasm",
		".txt": "text/plain; charset=utf-8",
	};
	const type = types[path.extname(file).toLowerCase()];
	if (!type) throw new Error(`Unsupported Dev workbench production asset: ${file}`);
	return type;
}

/** Check automatic HTML/CSS requests, not user-supplied transcript links. */
function assertResourceClosure(assets: ReadonlyMap<string, DevWorkbenchAsset>): void {
	function check(reference: string, from: string): void {
		const ref = reference.trim();
		if (!ref || ref.startsWith("#") || ref.startsWith("data:")) return;
		const url = new URL(ref, `https://workbench.invalid${from}`);
		if (url.origin !== "https://workbench.invalid") throw new Error(`Remote UI dependency is forbidden: ${ref}`);
		if (!assets.has(decodeURIComponent(url.pathname)))
			throw new Error(`Missing UI asset ${ref} referenced by ${from}`);
	}
	for (const [name, asset] of assets) {
		if (asset.contentType.startsWith("text/html")) {
			const html = new TextDecoder().decode(asset.bytes);
			for (const tag of html.matchAll(/<(script|link|img|source|video|audio|iframe|object|embed)\b[^>]*>/gi)) {
				for (const attribute of tag[0].matchAll(/\b(?:src|href|poster|data)\s*=\s*["']([^"']+)["']/gi))
					check(attribute[1]!, name);
				for (const attribute of tag[0].matchAll(/\bsrcset\s*=\s*["']([^"']+)["']/gi)) {
					for (const candidate of attribute[1]!.split(",")) check(candidate.trim().split(/\s+/)[0]!, name);
				}
			}
		} else if (asset.contentType.startsWith("text/css")) {
			const css = new TextDecoder().decode(asset.bytes);
			for (const match of css.matchAll(/url\(\s*["']?([^\s"')]+)["']?\s*\)|@import\s+["']([^"']+)["']/gi)) {
				check(match[1] ?? match[2]!, name);
			}
		}
	}
}

/** Include only generation inputs and declarations needed by the browser build. */
async function collectBuildDeclarations(inputs: Map<string, Uint8Array>): Promise<void> {
	for (const file of [
		"package.json",
		"bun.lock",
		"packages/collab-web/package.json",
		"packages/coding-agent/package.json",
		"packages/coding-agent/scripts/dev-workbench-resources.ts",
		"packages/coding-agent/src/dev-workbench/assets.ts",
	]) {
		const absolute = path.join(repoRoot, file);
		inputs.set(absolute, await fs.readFile(absolute));
	}
}

// Browser-input provenance only. Backend provenance requires fresh-build evidence
// and explicit artifact paths; the CLI version identifies a version, not source bytes.
async function sourceDigest(inputs: ReadonlyMap<string, Uint8Array>): Promise<string> {
	const canonicalRoot = await fs.realpath(repoRoot);
	const ordered = new Map<string, Uint8Array>();
	for (const [file, bytes] of inputs) {
		const canonical = await fs.realpath(file);
		const relative = path.relative(canonicalRoot, canonical).replaceAll("\\", "/");
		if (relative.startsWith("../") || path.isAbsolute(relative))
			throw new Error(`Build input escapes repository: ${file}`);
		ordered.set(relative, bytes);
	}
	const hash = crypto.createHash("sha256");
	for (const name of [...ordered.keys()].sort(compare)) {
		const bytes = ordered.get(name)!;
		hash.update(JSON.stringify([name, bytes.byteLength]));
		hash.update("\n");
		hash.update(bytes);
	}
	return hash.digest("hex");
}

/**
 * Build the one native Firefox 128 Dev entry. Bun bundles TS/JSX and dependencies;
 * Babel lowers only syntax outside that browser's boundary, without API injection.
 * Final filenames and manifest hashes describe the transformed bytes.
 */
export async function buildDevWorkbenchAssets(): Promise<ReadonlyMap<string, DevWorkbenchAsset>> {
	const inputs = new Map<string, Uint8Array>();
	const entry = path.join(collabDir, "dev-workbench.html");
	const htmlBytes = await fs.readFile(entry);
	inputs.set(entry, htmlBytes);
	const html = new TextDecoder().decode(htmlBytes);
	const scripts = [...html.matchAll(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi)];
	const sourceScript = scripts[0]?.[0];
	const sourceReference = sourceScript?.match(/\bsrc\s*=\s*["']([^"']+)["']/i)?.[1];
	if (scripts.length !== 1 || sourceReference !== "./src/dev-workbench/main.tsx")
		throw new Error("Dev workbench HTML must contain only its native application entry");
	const browserEntry = path.resolve(collabDir, sourceReference);
	const outdir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-dev-workbench-"));
	const assets = new Map<string, DevWorkbenchAsset>();
	try {
		const output = await withCompilerActivity(() =>
			Bun.build({
				entrypoints: [browserEntry],
				root: collabDir,
				outdir,
				target: "browser",
				format: "iife",
				splitting: false,
				minify: true,
				publicPath: "./",
				naming: {
					entry: "[name].[ext]",
					asset: "assets/[name]-[hash].[ext]",
				},
				define: { "process.env.NODE_ENV": JSON.stringify("production") },
				plugins: [
					{
						name: "dev-workbench-source-inputs",
						setup(build) {
							build.onLoad({ filter: /.*/, namespace: "file" }, async ({ path: file }) => {
								const source = await fs.readFile(file);
								inputs.set(file, source);
								return undefined;
							});
						},
					},
				],
				throw: false,
			}),
		);
		if (!output.success) throw new AggregateError(output.logs, "Dev workbench production UI build failed");
		let scriptPath: string | undefined;
		let stylesheetPath: string | undefined;
		for (const artifact of output.outputs) {
			const relative = path.relative(outdir, artifact.path).replaceAll("\\", "/");
			if (relative.startsWith("../") || path.isAbsolute(relative))
				throw new Error(`Unexpected workbench output: ${artifact.path}`);
			let bytes = new Uint8Array(await artifact.arrayBuffer());
			let name = `/${relative}`;
			if (relative.endsWith(".js")) {
				if (scriptPath || artifact.kind !== "entry-point")
					throw new Error("Dev workbench must produce exactly one non-splitting classic script");
				const transformed = await withCompilerActivity(() =>
					transformAsync(new TextDecoder().decode(bytes), {
						filename: "dev-workbench.js",
						babelrc: false,
						configFile: false,
						sourceType: "script",
						comments: false,
						minified: true,
						presets: [
							[
								Bun.resolveSync("@babel/preset-env", repoRoot),
								{
									targets: { firefox: "128" },
									modules: false,
									bugfixes: true,
									useBuiltIns: false,
								},
							],
						],
					}),
				);
				if (!transformed?.code) throw new Error("Dev workbench Firefox 128 transformation produced no script");
				// Script mode rejects module chunks; Babel owns browser-specific syntax lowering.
				parse(transformed.code, { ecmaVersion: 2024, sourceType: "script" });
				bytes = new TextEncoder().encode(`${transformed.code}\n`);
				name = `/dev-workbench-${Bun.SHA256.hash(bytes, "hex")}.js`;
				scriptPath = name;
			} else if (relative.endsWith(".css")) {
				if (stylesheetPath) throw new Error("Dev workbench must produce exactly one stylesheet");
				// Retain the directory so bundled relative url() references remain valid.
				name = `${path.posix.dirname(name)}/dev-workbench-${Bun.SHA256.hash(bytes, "hex")}.css`;
				name = name.replace(/^\/\//, "/");
				stylesheetPath = name;
			}
			if (assets.has(name)) throw new Error(`Duplicate workbench output: ${name}`);
			assets.set(name, { bytes, contentType: contentType(relative) });
		}
		if (!scriptPath || !stylesheetPath)
			throw new Error("Dev workbench build must include its classic script and stylesheet");
		const faviconPath = "public/favicon-32x32.png";
		const faviconFile = path.join(collabDir, faviconPath);
		const faviconBytes = await fs.readFile(faviconFile);
		inputs.set(faviconFile, faviconBytes);
		assets.set(`/${faviconPath}`, { bytes: faviconBytes, contentType: contentType(faviconPath) });
		const document = html
			.replace(sourceScript!, `<script src=".${scriptPath}"></script>`)
			.replace(/<\/head\s*>/i, `\t<link rel="stylesheet" href=".${stylesheetPath}" />\n\t</head>`);
		assets.set("/index.html", {
			bytes: new TextEncoder().encode(document),
			contentType: contentType("index.html"),
		});
	} finally {
		await fs.rm(outdir, { recursive: true, force: true });
	}
	assertResourceClosure(assets);
	await collectBuildDeclarations(inputs);
	const files = [...assets]
		.sort(([a], [b]) => compare(a, b))
		.map(([name, asset]) => ({
			path: name,
			contentType: asset.contentType,
			version: Bun.SHA256.hash(asset.bytes, "hex"),
		}));
	const manifest: DevAssetManifest = {
		digest: devWorkbenchAssetDigest(files),
		sourceDigest: await sourceDigest(inputs),
		files,
	};
	manifests.set(assets, manifest);
	decodeDevWorkbenchAssets(payload(assets));
	return assets;
}

function payload(assets: ReadonlyMap<string, DevWorkbenchAsset>): DevAssetPayload {
	const manifest = manifests.get(assets);
	if (!manifest)
		throw new Error("Workbench assets must come from buildDevWorkbenchAssets() to retain build provenance");
	return {
		schemaVersion: 1,
		manifest,
		files: manifest.files.map(file => ({
			path: file.path,
			contentType: file.contentType,
			base64: Buffer.from(assets.get(file.path)!.bytes).toString("base64"),
		})),
	};
}

/** Atomically publish source/SDK resources from the very same generated payload. */
export async function writeDevWorkbenchAssets(assets: ReadonlyMap<string, DevWorkbenchAsset>): Promise<void> {
	const temporary = `${generatedPath}.${crypto.randomUUID()}.tmp`;
	await fs.mkdir(path.dirname(generatedPath), { recursive: true });
	try {
		await fs.writeFile(temporary, `${JSON.stringify(payload(assets))}\n`, { flag: "wx" });
		await fs.rename(temporary, generatedPath);
	} finally {
		await fs.rm(temporary, { force: true });
	}
}

/** Both npm and standalone binaries embed this exact payload, with no file-system fallback. */
export function createDevWorkbenchAssetsPlugin(assets: ReadonlyMap<string, DevWorkbenchAsset>): Bun.BunPlugin {
	const serialized = JSON.stringify(payload(assets));
	return {
		name: "omp-dev-workbench-assets",
		target: "bun",
		setup(build) {
			build.config.define = { ...build.config.define, OMP_DEV_WORKBENCH_ASSETS: JSON.stringify(serialized) };
		},
	};
}

if (import.meta.main) {
	if (process.argv.length !== 3 || process.argv[2] !== "--write")
		throw new Error("Usage: bun packages/coding-agent/scripts/dev-workbench-resources.ts --write");
	const assets = await buildDevWorkbenchAssets();
	await writeDevWorkbenchAssets(assets);
	console.log(`Generated Dev workbench assets: ${manifests.get(assets)!.digest} (${assets.size} files)`);
}
