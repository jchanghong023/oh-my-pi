import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	buildEmbeddedArchive,
	decodeEmbeddedArchive,
	extractEmbeddedArchive,
} from "@oh-my-pi/pi-utils/embedded-archive";
import tailwindcss from "@tailwindcss/vite";
import { build, type Plugin } from "vite";
import {
	captureAIReqWorkbenchWatchFiles,
	aiReqWorkbenchOutputReferences,
	aiReqWorkbenchSourceDigest,
} from "../../scripts/aireq-workbench-resources";
import { aiReqWorkbenchAssetDigest, decodeAIReqWorkbenchArchive } from "../../src/aireq-workbench/assets";

const META_ENTRY = "__omp_meta__.json";
const encoder = new TextEncoder();

interface FixtureFile {
	path: string;
	contentType: string;
	bytes: Uint8Array;
}

function fixtureFiles(): FixtureFile[] {
	return [
		{ path: "/index.html", contentType: "text/html; charset=utf-8", bytes: Buffer.from("<!doctype html>") },
		{ path: "/entry.js", contentType: "text/javascript; charset=utf-8", bytes: Buffer.from("export {};") },
		{ path: "/style.css", contentType: "text/css; charset=utf-8", bytes: Buffer.from("body {}") },
		{ path: "/binary.dat", contentType: "application/octet-stream", bytes: new Uint8Array([0, 255, 128, 13, 10]) },
	];
}

function metaFor(files: readonly FixtureFile[], sourceDigest = Bun.SHA256.hash("isolated archive fixture", "hex")) {
	return { sourceDigest, files: files.map(file => ({ path: file.path, contentType: file.contentType })) };
}

function archiveEntries(
	files: readonly FixtureFile[] = fixtureFiles(),
	meta: unknown = metaFor(files),
): Map<string, Uint8Array> {
	const entries = new Map<string, Uint8Array>();
	for (const file of files) entries.set(file.path.slice(1), file.bytes);
	entries.set(META_ENTRY, encoder.encode(JSON.stringify(meta)));
	return entries;
}

function asFiles(entries: ReadonlyMap<string, Uint8Array>): Map<string, File> {
	return new Map([...entries].map(([name, bytes]) => [name, new File([bytes], name)]));
}

async function throughArchive(entries: ReadonlyMap<string, Uint8Array>) {
	const archive = decodeEmbeddedArchive(await buildEmbeddedArchive(entries));
	if (!archive) throw new Error("Fixture archive was not embedded");
	return decodeAIReqWorkbenchArchive(await extractEmbeddedArchive(archive));
}

test("archive decoding preserves exact bytes, MIME types and the hashed manifest", async () => {
	const files = fixtureFiles();
	const sourceDigest = Bun.SHA256.hash("isolated archive fixture", "hex");
	const { assets, manifest } = await throughArchive(archiveEntries([...files].reverse()));

	expect(manifest.sourceDigest).toBe(sourceDigest);
	expect(manifest.files.map(file => file.path)).toEqual(["/binary.dat", "/entry.js", "/index.html", "/style.css"]);
	expect(manifest.files.map(file => file.contentType)).toEqual([
		"application/octet-stream",
		"text/javascript; charset=utf-8",
		"text/html; charset=utf-8",
		"text/css; charset=utf-8",
	]);
	for (const file of files) {
		const asset = assets.get(file.path)!;
		expect(Array.from(asset.bytes)).toEqual(Array.from(file.bytes));
		expect(asset.contentType).toBe(file.contentType);
		expect(manifest.files.find(entry => entry.path === file.path)!.version).toBe(Bun.SHA256.hash(file.bytes, "hex"));
	}
	expect([...assets.get("/binary.dat")!.bytes]).toEqual([0, 255, 128, 13, 10]);
	expect(aiReqWorkbenchAssetDigest(manifest.files)).toBe(manifest.digest);
	for (const change of [{ path: "/renamed.dat" }, { contentType: "text/plain" }, { version: "0".repeat(64) }]) {
		expect(aiReqWorkbenchAssetDigest([{ ...manifest.files[0]!, ...change }, ...manifest.files.slice(1)])).not.toBe(
			manifest.digest,
		);
	}
});

test("archive decoding rejects missing metadata", async () => {
	const entries = archiveEntries();
	entries.delete(META_ENTRY);
	await expect(decodeAIReqWorkbenchArchive(asFiles(entries))).rejects.toThrow(/metadata/u);
});

test("archive decoding rejects metadata that does not match the archive entries", async () => {
	const extra = archiveEntries();
	extra.set("extra.html", Buffer.from("<html></html>"));
	await expect(decodeAIReqWorkbenchArchive(asFiles(extra))).rejects.toThrow(/do not match/u);

	const missing = archiveEntries();
	missing.delete("style.css");
	await expect(decodeAIReqWorkbenchArchive(asFiles(missing))).rejects.toThrow(/do not match/u);
});

test("archive decoding rejects an archive without an entry point", async () => {
	const files = fixtureFiles().filter(file => file.path !== "/index.html");
	await expect(decodeAIReqWorkbenchArchive(asFiles(archiveEntries(files)))).rejects.toThrow(/incomplete/u);
});

test("archive decoding requires at least one JavaScript asset", async () => {
	const files = fixtureFiles().filter(file => !file.contentType.startsWith("text/javascript"));
	await expect(decodeAIReqWorkbenchArchive(asFiles(archiveEntries(files)))).rejects.toThrow(/incomplete/u);
});

test("archive decoding rejects duplicate metadata paths", async () => {
	const files = fixtureFiles();
	const meta = metaFor(files);
	meta.files.push({ ...meta.files[0]! });
	await expect(decodeAIReqWorkbenchArchive(asFiles(archiveEntries(files, meta)))).rejects.toThrow(/archive entry/u);
});

test("archive decoding rejects invalid metadata paths", async () => {
	const files = fixtureFiles();
	for (const invalid of [
		"index.html",
		"/",
		"/../outside",
		"/assets/../index.html",
		"/assets\\outside",
		"/index.html?query",
		"/index.html#fragment",
		"/index\0.html",
	]) {
		const replaced = [{ ...files[0]!, path: invalid }, ...files.slice(1)];
		await expect(decodeAIReqWorkbenchArchive(asFiles(archiveEntries(replaced)))).rejects.toThrow(/archive entry/u);
	}
});

test("archive decoding rejects invalid metadata content types and provenance", async () => {
	const files = fixtureFiles();
	for (const invalid of [
		{ ...metaFor(files), sourceDigest: "bad" },
		{
			...metaFor(files),
			files: [{ ...metaFor(files).files[0]!, contentType: "" }, ...metaFor(files).files.slice(1)],
		},
		{
			...metaFor(files),
			files: [
				{ ...metaFor(files).files[0]!, contentType: "text/html; charset=latin1" },
				...metaFor(files).files.slice(1),
			],
		},
	]) {
		await expect(decodeAIReqWorkbenchArchive(asFiles(archiveEntries(files, invalid)))).rejects.toThrow(
			/archive metadata|archive entry/u,
		);
	}
});

test("archive decoding rejects corrupt metadata JSON", async () => {
	const entries = archiveEntries();
	entries.set(META_ENTRY, encoder.encode("{not json"));
	await expect(decodeAIReqWorkbenchArchive(asFiles(entries))).rejects.toThrow(/corrupt/u);
});

test("compiler watch capture retains transitive CSS, Tailwind candidates and module-worker fingerprints", async () => {
	const root = await fs.mkdtemp(path.join(import.meta.dir, "provenance-test-"));
	const files = {
		"main.js":
			'import "./entry.css"; new Worker(new URL("./module-worker.js", import.meta.url), { type: "module" });',
		"module-worker.js": 'import { value } from "./worker-leaf.js"; postMessage(value);',
		"worker-leaf.js": 'export const value = "worker-value";',
		"entry.css": '@import "tailwindcss" source(none);\n@import "./nested.css";\n@source "./candidates.html";',
		"nested.css": '.nested { color: red; background: url("./asset.svg"); }',
		"candidates.html": '<div class="underline"></div>',
		"asset.svg": '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><path d="M0 0h1v1H0z"/></svg>',
	};
	const watched = new Set<string>();
	const modules = new Set<string>();
	const emittedReferences = new Set<string>();
	const observe = (): Plugin => ({
		name: "observe-actual-compiler-dependencies",
		configResolved(config) {
			for (const plugin of config.plugins) {
				captureAIReqWorkbenchWatchFiles(plugin, id => {
					watched.add(path.resolve(config.root, id));
				});
			}
		},
		generateBundle: {
			order: "post",
			handler(_options, bundle) {
				for (const id of this.getModuleIds()) if (!id.startsWith("\0")) modules.add(id.split("?")[0]!);
				for (const reference of aiReqWorkbenchOutputReferences(bundle)) emittedReferences.add(reference);
			},
		},
	});
	try {
		for (const [name, source] of Object.entries(files)) await fs.writeFile(path.join(root, name), source);
		await build({
			configFile: false,
			root,
			base: "./",
			publicDir: false,
			plugins: [tailwindcss(), observe()],
			worker: { format: "es", plugins: () => [observe()] },
			build: {
				outDir: path.join(root, "out"),
				target: "firefox128",
				assetsInlineLimit: 0,
				rolldownOptions: { input: path.join(root, "main.js") },
			},
		});
		const emitted = new Set(await publicFiles(path.join(root, "out")));
		for (const reference of emittedReferences) expect(emitted.has(reference)).toBe(true);
		expect([...emittedReferences].some(file => file.endsWith(".css"))).toBe(true);
		expect([...emittedReferences].some(file => file.endsWith(".svg"))).toBe(true);
		const canonical = async (paths: Iterable<string>): Promise<Set<string>> =>
			new Set(await Promise.all([...paths].filter(file => !/[*?[\]{}]/u.test(file)).map(file => fs.realpath(file))));
		const watchedFiles = await canonical(watched);
		const moduleFiles = await canonical(modules);
		for (const name of ["nested.css", "candidates.html", "asset.svg"])
			expect(watchedFiles.has(await fs.realpath(path.join(root, name)))).toBe(true);
		for (const name of ["main.js", "module-worker.js", "worker-leaf.js"])
			expect(moduleFiles.has(await fs.realpath(path.join(root, name)))).toBe(true);
		const inputs = new Map<string, Uint8Array>();
		for (const file of new Set([...watchedFiles, ...moduleFiles])) {
			if ((await fs.stat(file)).isFile()) inputs.set(file, await fs.readFile(file));
		}
		const initial = await aiReqWorkbenchSourceDigest(inputs);
		expect(await aiReqWorkbenchSourceDigest(new Map([...inputs].reverse()))).toBe(initial);
		for (const name of ["nested.css", "candidates.html", "worker-leaf.js", "asset.svg"]) {
			const file = await fs.realpath(path.join(root, name));
			const original = inputs.get(file)!;
			await fs.appendFile(file, "\n/* changed build input */");
			inputs.set(file, await fs.readFile(file));
			expect(await aiReqWorkbenchSourceDigest(inputs)).not.toBe(initial);
			inputs.set(file, original);
		}
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}, 120_000);

test("dependency observation preserves hook descriptors, context methods and failures", async () => {
	const declarations: string[] = [];
	const forwarded: string[] = [];
	const original: Plugin = {
		name: "dependency-fixture",
		transform: {
			order: "pre",
			filter: { id: /\.css$/u },
			handler(code) {
				this.addWatchFile("nested.css");
				return `${code}:${this.getModuleInfo("entry")?.id}`;
			},
		},
	};
	const originalHook = original.transform;
	captureAIReqWorkbenchWatchFiles(original, id => declarations.push(id));
	const hook = original.transform;
	if (!hook || typeof hook === "function") throw new Error("Object hook descriptor lost");
	expect(hook.order).toBe("pre");
	if (!originalHook || typeof originalHook === "function") throw new Error("Object hook fixture missing");
	expect(hook.filter).toBe(originalHook.filter);
	expect(hook.handler).not.toBe(originalHook.handler);
	const context = {
		addWatchFile(id: string) {
			expect(this).toBe(context);
			forwarded.push(id);
		},
		getModuleInfo(id: string) {
			expect(this).toBe(context);
			return { id };
		},
	};
	expect(Reflect.apply(hook.handler, context, ["css", "entry.css", { moduleType: "css" }])).toBe("css:entry");
	expect(declarations).toEqual(["nested.css"]);
	expect(forwarded).toEqual(declarations);
	captureAIReqWorkbenchWatchFiles(original, () => {
		throw new Error("untracked dependency");
	});
	const failedHook = original.transform;
	if (!failedHook || typeof failedHook === "function") throw new Error("Object hook descriptor lost");
	expect(() => Reflect.apply(failedHook.handler, context, ["css", "entry.css", { moduleType: "css" }])).toThrow();
});

test("source provenance rejects both original WebGUI trees", async () => {
	const repo = path.resolve(import.meta.dir, "../../../..");
	for (const directory of ["vendor/zcode-frontend", "packages/coding-agent/src/webgui"]) {
		// Provenance must reject the location regardless of the supplied bytes.
		const input = path.join(repo, directory, "package.json");
		const entries = await fs.readdir(path.dirname(input), { withFileTypes: true });
		const file = entries.find(entry => entry.isFile());
		if (!file) throw new Error(`Original WebGUI fixture has no files: ${directory}`);
		await expect(
			aiReqWorkbenchSourceDigest(new Map([[path.join(path.dirname(input), file.name), new Uint8Array()]])),
		).rejects.toThrow();
	}
});

async function publicFiles(directory: string, prefix = ""): Promise<string[]> {
	const result: string[] = [];
	for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
		const name = `${prefix}${entry.name}`;
		if (entry.isDirectory()) result.push(...(await publicFiles(path.join(directory, entry.name), `${name}/`)));
		else if (entry.isFile()) result.push(name);
	}
	return result.sort();
}
