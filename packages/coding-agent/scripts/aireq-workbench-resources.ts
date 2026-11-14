#!/usr/bin/env bun
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildEmbeddedArchive } from "@oh-my-pi/pi-utils/embedded-archive";
import { parse } from "acorn";
import type { FunctionPluginHooks, OutputBundle } from "rolldown";
import { build, loadConfigFromFile, type Plugin } from "vite";
import { withCompilerActivity } from "../../../scripts/test-gate-events";
import type { AIReqWorkbenchAsset } from "../src/aireq-workbench/assets";

const repoRoot = path.resolve(import.meta.dir, "../../..");
const frontendDir = path.join(repoRoot, "packages/aireq-frontend");
const agentDir = path.join(repoRoot, "packages/coding-agent");
const generatedPath = path.join(agentDir, "src/aireq-workbench/assets.generated.txt");
const archiveMetaEntry = "__omp_meta__.json";
/** Build output shared by the generator, npm bundling and standalone compilation. */
export interface AIReqWorkbenchBuildResult {
	assets: ReadonlyMap<string, AIReqWorkbenchAsset>;
	sourceDigest: string;
}
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function contentType(file: string): string {
	const types: Record<string, string> = {
		".html": "text/html; charset=utf-8",
		".js": "text/javascript; charset=utf-8",
		".mjs": "text/javascript; charset=utf-8",
		".css": "text/css; charset=utf-8",
		".json": "application/json; charset=utf-8",
		".map": "application/json; charset=utf-8",
		".webmanifest": "application/manifest+json; charset=utf-8",
		".svg": "image/svg+xml",
		".png": "image/png",
		".jpg": "image/jpeg",
		".jpeg": "image/jpeg",
		".gif": "image/gif",
		".webp": "image/webp",
		".avif": "image/avif",
		".ico": "image/x-icon",
		".mp3": "audio/mpeg",
		".woff": "font/woff",
		".woff2": "font/woff2",
		".ttf": "font/ttf",
		".otf": "font/otf",
		".wasm": "application/wasm",
		".bcmap": "application/octet-stream",
		".bin": "application/octet-stream",
		".txt": "text/plain; charset=utf-8",
		".xml": "application/xml; charset=utf-8",
		".pdf": "application/pdf",
	};
	const type = types[path.extname(file).toLowerCase()];
	if (!type) throw new Error(`Unsupported AIReq workbench production asset: ${file}`);
	return type;
}

type SyntaxNode = { type: string; [key: string]: unknown };

/** Vite injects this metadata for chunks and assets before output hooks run. */
export function* aiReqWorkbenchOutputReferences(bundle: OutputBundle): IterableIterator<string> {
	for (const output of Object.values(bundle)) {
		if (output.type === "chunk") {
			yield* output.imports;
			yield* output.dynamicImports;
		}
		const metadata = output.viteMetadata;
		if (!metadata || !(metadata.importedAssets instanceof Set) || !(metadata.importedCss instanceof Set))
			throw new Error(`Missing Vite dependency metadata: ${output.fileName}`);
		yield* metadata.importedAssets;
		yield* metadata.importedCss;
	}
}

/** Inspect only automatic module/asset requests, not user-supplied transcript links. */
function assertResourceClosure(assets: ReadonlyMap<string, AIReqWorkbenchAsset>): void {
	const prefix = "/__aireq_resource_prefix__/";
	function check(reference: string, from: string): void {
		const ref = reference.trim();
		if (!ref || ref.startsWith("#") || ref.startsWith("data:")) return;
		const url = new URL(ref, `https://workbench.invalid${prefix}${from.slice(1)}`);
		if (url.origin !== "https://workbench.invalid" || !url.pathname.startsWith(prefix))
			throw new Error(`UI dependency escapes the AIReq capability prefix: ${ref} in ${from}`);
		const assetPath = `/${decodeURIComponent(url.pathname.slice(prefix.length))}`;
		if (!assets.has(assetPath)) throw new Error(`Missing UI asset ${ref} referenced by ${from}`);
	}
	function visit(node: SyntaxNode, from: string): void {
		if (
			node.type === "ImportDeclaration" ||
			node.type === "ExportNamedDeclaration" ||
			node.type === "ExportAllDeclaration" ||
			node.type === "ImportExpression"
		) {
			const source = node.source as SyntaxNode | undefined;
			if (typeof source?.value === "string") check(source.value, from);
		}
		if (node.type === "NewExpression" && (node.callee as SyntaxNode | undefined)?.name === "URL") {
			const args = node.arguments as SyntaxNode[];
			const member = args[1];
			const object = member?.object as SyntaxNode | undefined;
			if (
				typeof args[0]?.value === "string" &&
				member?.type === "MemberExpression" &&
				object?.type === "MetaProperty" &&
				(object.meta as SyntaxNode)?.name === "import" &&
				(member.property as SyntaxNode)?.name === "url"
			)
				check(args[0].value, from);
		}
		for (const value of Object.values(node)) {
			if (Array.isArray(value)) {
				for (const child of value) {
					if (child && typeof child === "object" && typeof child.type === "string") visit(child, from);
				}
			} else if (value && typeof value === "object" && "type" in value && typeof value.type === "string") {
				visit(value as SyntaxNode, from);
			}
		}
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
			for (const match of css.matchAll(/url\(\s*["']?([^\s"')]+)["']?\s*\)|@import\s+["']([^"']+)["']/gi))
				check(match[1] ?? match[2]!, name);
		} else if (asset.contentType.startsWith("text/javascript")) {
			visit(
				parse(new TextDecoder().decode(asset.bytes), {
					ecmaVersion: 2024,
					sourceType: "module",
				}) as unknown as SyntaxNode,
				name,
			);
		}
	}
}

async function walkFiles(directory: string, visit: (file: string) => Promise<void>): Promise<void> {
	for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => compare(a.name, b.name))) {
		const file = path.join(directory, entry.name);
		if (entry.isDirectory()) await walkFiles(file, visit);
		else if (entry.isFile()) await visit(file);
		else throw new Error(`Unexpected symbolic build input/output: ${file}`);
	}
}

/** Include declarations, copied configuration, public bytes and Tailwind-scanned sources. */
async function collectBuildDeclarations(inputs: Map<string, Uint8Array>): Promise<void> {
	for (const file of [
		"package.json",
		"bun.lock",
		"packages/aireq-frontend/package.json",
		"packages/aireq-frontend/bun.lock",
		"packages/aireq-frontend/copy-manifest.json",
		"packages/aireq-frontend/tsconfig.base.json",
		"packages/coding-agent/package.json",
		"packages/aireq-frontend/vite.config.ts",
		"packages/aireq-frontend/backend/contract.ts",
		"packages/coding-agent/scripts/aireq-workbench-resources.ts",
		"packages/coding-agent/src/aireq-workbench/assets.ts",
	]) {
		const absolute = path.join(repoRoot, file);
		inputs.set(absolute, await fs.readFile(absolute));
	}
	for (const directory of ["preview", "shared", "runtime", "app", "client", "packages/web/public", "config"]) {
		await walkFiles(path.join(frontendDir, directory), async file => {
			if (!inputs.has(file)) inputs.set(file, await fs.readFile(file));
		});
	}
	for (const entry of await fs.readdir(path.join(frontendDir, "packages"), { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		for (const name of ["package.json", "tsconfig.json", "src", "vite"]) {
			const file = path.join(frontendDir, "packages", entry.name, name);
			const stat = await fs.stat(file).catch(error => {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
				throw error;
			});
			if (!stat) continue;
			if (stat.isDirectory())
				await walkFiles(file, async input => {
					inputs.set(input, await fs.readFile(input));
				});
			else inputs.set(file, await fs.readFile(file));
		}
	}
}

/**
 * Rolldown exposes getModuleIds/addWatchFile, but not Rollup's getWatchFiles.
 * Observe dependency declarations at their supported registration point, including
 * Vite's CSS imports and Tailwind's compiler/scanner inputs outside the module graph.
 * Hook descriptors (filters/order/sequential) and the original context are preserved.
 * Wrap hooks in place during configResolved: Vite's resolved plugin list is readonly.
 */
export function captureAIReqWorkbenchWatchFiles(plugin: Plugin, watch: (id: string) => void): void {
	const hooks = [
		"buildStart",
		"resolveId",
		"resolveDynamicImport",
		"load",
		"transform",
		"moduleParsed",
		"buildEnd",
		"renderStart",
		"renderChunk",
		"augmentChunkHash",
		"resolveFileUrl",
		"renderError",
		"generateBundle",
		"writeBundle",
		"closeBundle",
		"watchChange",
		"closeWatcher",
	] as const satisfies readonly (keyof FunctionPluginHooks)[];
	for (const name of hooks) {
		const hook = plugin[name];
		if (!hook) continue;
		const handler = typeof hook === "function" ? hook : hook.handler;
		const observed = function (this: object, ...args: unknown[]) {
			const context = this;
			return Reflect.apply(
				handler,
				new Proxy(context, {
					get(target, key) {
						const value = Reflect.get(target, key, target);
						if (key === "addWatchFile")
							return (id: string) => {
								watch(id);
								return Reflect.apply(value, target, [id]);
							};
						return typeof value === "function" ? value.bind(target) : value;
					},
				}),
				args,
			);
		};
		Object.assign(plugin, { [name]: typeof hook === "function" ? observed : { ...hook, handler: observed } });
	}
}

/** Fingerprint installed compiler implementations, not just their entry or version. */
async function collectBuildTools(inputs: Map<string, Uint8Array>): Promise<void> {
	const visited = new Set<string>();
	async function collect(directory: string): Promise<void> {
		directory = await fs.realpath(directory);
		if (visited.has(directory)) return;
		visited.add(directory);
		const manifestPath = path.join(directory, "package.json");
		const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as {
			dependencies?: Record<string, string>;
			optionalDependencies?: Record<string, string>;
		};
		async function walk(directory: string): Promise<void> {
			for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
				if (entry.name === "node_modules") continue;
				const file = path.join(directory, entry.name);
				if (entry.isDirectory()) await walk(file);
				else if (entry.isFile()) inputs.set(file, await fs.readFile(file));
				else throw new Error(`Unexpected symbolic compiler input: ${file}`);
			}
		}
		await walk(directory);
		for (const dependency of new Set([
			...Object.keys(manifest.dependencies ?? {}),
			...Object.keys(manifest.optionalDependencies ?? {}),
		])) {
			const resolved = await packageDirectory(dependency, directory);
			if (resolved) await collect(resolved);
			else if (!(dependency in (manifest.optionalDependencies ?? {})))
				throw new Error(`Missing AIReq build dependency ${dependency} from ${manifestPath}`);
		}
	}
	for (const name of ["vite", "@vitejs/plugin-react", "@tailwindcss/vite"]) {
		const directory = await packageDirectory(name, import.meta.dir);
		if (!directory) throw new Error(`Missing AIReq build tool: ${name}`);
		await collect(directory);
	}
}

async function packageDirectory(name: string, importer: string): Promise<string | undefined> {
	// Locate manifests directly: package exports need not expose package.json or ".".
	for (let directory = importer; ; directory = path.dirname(directory)) {
		const candidate = path.join(directory, "node_modules", name);
		if (await Bun.file(path.join(candidate, "package.json")).exists()) return candidate;
		if (path.dirname(directory) === directory) return undefined;
	}
}

// Browser-input provenance only; this is not backend-worktree provenance.
export async function aiReqWorkbenchSourceDigest(inputs: ReadonlyMap<string, Uint8Array>): Promise<string> {
	const canonicalRoot = await fs.realpath(repoRoot);
	const ordered = new Map<string, Uint8Array>();
	for (const [file, bytes] of inputs) {
		const canonical = await fs.realpath(file);
		const relative = path.relative(canonicalRoot, canonical).replaceAll("\\", "/");
		if (relative.startsWith("../") || path.isAbsolute(relative))
			throw new Error(`Build input escapes repository: ${file}`);
		if (
			(relative.startsWith("vendor/zcode-frontend/") && !relative.includes("/node_modules/")) ||
			relative.startsWith("packages/coding-agent/src/webgui/")
		)
			throw new Error(`AIReq build loaded original frontend input: ${file}`);
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

/** Build the complete copied Vite/React/Tailwind frontend, including module workers. */
export async function buildAIReqWorkbenchAssets(): Promise<AIReqWorkbenchBuildResult> {
	const inputs = new Map<string, Uint8Array>();
	await collectBuildDeclarations(inputs);
	await collectBuildTools(inputs);
	const loadedConfig = await loadConfigFromFile(
		{ command: "build", mode: "production" },
		path.join(frontendDir, "runtime/vite.config.ts"),
		repoRoot,
	);
	if (!loadedConfig) throw new Error("AIReq frontend build configuration is unavailable.");
	const config = loadedConfig.config;
	const viteEntry = fileURLToPath(import.meta.resolve("vite"));
	const packageDirectories = new Set<string>();
	const capture = async (id: string, imported = false): Promise<void> => {
		if (id.startsWith("\0")) return;
		const file = id.startsWith("file:") ? fileURLToPath(id) : id.split("?")[0]!;
		if (!path.isAbsolute(file)) return;
		const relative = path.relative(repoRoot, file).replaceAll("\\", "/");
		if (
			(relative.startsWith("vendor/zcode-frontend/") && !relative.includes("/node_modules/")) ||
			relative.startsWith("packages/coding-agent/src/webgui/")
		)
			throw new Error(`AIReq build attempted to load original frontend input: ${file}`);
		if (
			imported &&
			(relative.startsWith("packages/aireq-frontend/preview/") ||
				relative.startsWith("packages/aireq-frontend/packages/ui/src/aireq/mock/"))
		)
			throw new Error(`OMP AIReq production build loaded prototype data: ${file}`);
		try {
			if (!(await fs.stat(file)).isFile()) return;
			if (!inputs.has(file)) inputs.set(file, await fs.readFile(file));
			let directory = path.dirname(file);
			while (!packageDirectories.has(directory)) {
				packageDirectories.add(directory);
				const manifest = path.join(directory, "package.json");
				if (await Bun.file(manifest).exists()) {
					inputs.set(manifest, await fs.readFile(manifest));
					break;
				}
				if (directory === repoRoot || path.dirname(directory) === directory) break;
				directory = path.dirname(directory);
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	};
	await capture(viteEntry);
	for (const dependency of loadedConfig.dependencies) await capture(dependency);
	const emittedReferences = new Set<string>();
	const watchedInputs = new Map<string, string>();
	const provenancePlugin = (): Plugin => ({
		name: "aireq-workbench-source-inputs",
		enforce: "pre",
		configResolved(resolved) {
			for (const plugin of resolved.plugins) {
				captureAIReqWorkbenchWatchFiles(plugin, id => {
					watchedInputs.set(id, resolved.root);
				});
			}
		},
		async load(id) {
			await capture(id, true);
			return null;
		},
		generateBundle: {
			// Run after Vite removes pure-CSS chunks and transfers their metadata.
			order: "post",
			async handler(_options, bundle) {
				for (const id of this.getModuleIds()) await capture(id, true);
				for (const imported of aiReqWorkbenchOutputReferences(bundle)) emittedReferences.add(imported);
			},
		},
	});
	const workerPlugins = config.worker?.plugins;
	const assets = new Map<string, AIReqWorkbenchAsset>();
	const buildDir = path.join(frontendDir, "build");
	await fs.mkdir(buildDir, { recursive: true });
	const outdir = await fs.mkdtemp(path.join(buildDir, "resources-"));
	try {
		await withCompilerActivity(() =>
			build({
				...config,
				configFile: false,
				mode: "production",
				plugins: [...(config.plugins ?? []), provenancePlugin()],
				worker: {
					...config.worker,
					plugins: () => [...(workerPlugins?.() ?? []), provenancePlugin()],
				},
				build: { ...config.build, outDir: outdir, emptyOutDir: true },
			}),
		);
		// A watch registration may be a Tailwind glob rather than a module ID.
		// Exact missing dependencies are fatal; empty declared globs are valid.
		for (const [id, root] of watchedInputs) {
			const absolute = path.resolve(root, id);
			if (/[*?[\]{}]/u.test(absolute)) {
				for await (const file of new Bun.Glob(absolute.replaceAll("\\", "/")).scan({
					absolute: true,
					onlyFiles: true,
				}))
					await capture(file);
			} else {
				const stat = await fs.stat(absolute);
				if (stat.isDirectory()) await walkFiles(absolute, capture);
				else await capture(absolute);
			}
		}
		await walkFiles(outdir, async file => {
			const relative = path.relative(outdir, file).replaceAll("\\", "/");
			assets.set(`/${relative}`, { bytes: await fs.readFile(file), contentType: contentType(relative) });
		});
	} finally {
		await fs.rm(outdir, { recursive: true, force: true });
	}
	for (const imported of emittedReferences) {
		if (!assets.has(`/${imported}`)) throw new Error(`Unbundled AIReq UI dependency: ${imported}`);
	}
	assertResourceClosure(assets);
	return { assets, sourceDigest: await aiReqWorkbenchSourceDigest(inputs) };
}

/** Archive entry names drop the leading slash; the metadata keeps the served paths. */
function archiveEntries(result: AIReqWorkbenchBuildResult): Map<string, Uint8Array> {
	const entries = new Map<string, Uint8Array>();
	const files = [...result.assets.keys()].sort(compare).map(assetPath => {
		const asset = result.assets.get(assetPath)!;
		entries.set(assetPath.slice(1), asset.bytes);
		return { path: assetPath, contentType: asset.contentType };
	});
	const meta: { sourceDigest: string; files: { path: string; contentType: string }[] } = {
		sourceDigest: result.sourceDigest,
		files,
	};
	entries.set(archiveMetaEntry, new TextEncoder().encode(JSON.stringify(meta)));
	return entries;
}

/** Atomically publish the single embedded archive consumed by every runtime. */
export async function writeAIReqWorkbenchAssets(result: AIReqWorkbenchBuildResult): Promise<void> {
	const text = await buildEmbeddedArchive(archiveEntries(result));
	const temporary = `${generatedPath}.${crypto.randomUUID()}.tmp`;
	await fs.mkdir(path.dirname(generatedPath), { recursive: true });
	try {
		await fs.writeFile(temporary, text, { flag: "wx" });
		await fs.rename(temporary, generatedPath);
	} finally {
		await fs.rm(temporary, { force: true });
	}
}

/** Restore the checked-in placeholder so generated bytes are never committed. */
export async function resetAIReqWorkbenchAssets(): Promise<void> {
	await fs.mkdir(path.dirname(generatedPath), { recursive: true });
	await Bun.write(generatedPath, "");
}

if (import.meta.main) {
	if (process.argv.length !== 3 || process.argv[2] !== "--write")
		throw new Error("Usage: bun packages/coding-agent/scripts/aireq-workbench-resources.ts --write");
	const result = await buildAIReqWorkbenchAssets();
	await writeAIReqWorkbenchAssets(result);
	console.log(`Generated AIReq workbench assets: ${result.sourceDigest} (${result.assets.size} files)`);
}
