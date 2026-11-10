import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { build, type Plugin } from "vite";
import {
	captureDevWorkbenchWatchFiles,
	devWorkbenchOutputReferences,
	devWorkbenchSourceDigest,
} from "../../scripts/dev-workbench-resources";
import {
	decodeDevWorkbenchAssets,
	devWorkbenchAssetDigest,
	type DevAssetPayload,
} from "../../src/dev-workbench/assets";

async function publicFiles(directory: string, prefix = ""): Promise<string[]> {
	const result: string[] = [];
	for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
		const name = `${prefix}${entry.name}`;
		if (entry.isDirectory()) result.push(...(await publicFiles(path.join(directory, entry.name), `${name}/`)));
		else if (entry.isFile()) result.push(name);
	}
	return result.sort();
}

function fixturePayload(
	files: DevAssetPayload["files"] = [
		{
			path: "/index.html",
			contentType: "text/html; charset=utf-8",
			base64: Buffer.from("<!doctype html>").toString("base64"),
		},
		{
			path: "/entry.js",
			contentType: "text/javascript; charset=utf-8",
			base64: Buffer.from("export {};").toString("base64"),
		},
		{
			path: "/style.css",
			contentType: "text/css; charset=utf-8",
			base64: Buffer.from("body {}").toString("base64"),
		},
		{
			path: "/binary.dat",
			contentType: "application/octet-stream",
			base64: Buffer.from([0, 255, 128, 13, 10]).toString("base64"),
		},
	],
): DevAssetPayload {
	const entries = files
		.map(file => ({
			path: file.path,
			contentType: file.contentType,
			version: new Bun.CryptoHasher("sha256").update(Buffer.from(file.base64, "base64")).digest("hex"),
		}))
		.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	return {
		schemaVersion: 1,
		manifest: {
			digest: new Bun.CryptoHasher("sha256").update(JSON.stringify(entries)).digest("hex"),
			sourceDigest: new Bun.CryptoHasher("sha256").update("isolated resource fixture").digest("hex"),
			files: entries,
		},
		files,
	};
}

test("asset decoding preserves exact bytes, MIME types and the independently hashed manifest", () => {
	const payload = fixturePayload();
	const { assets, manifest } = decodeDevWorkbenchAssets({ ...payload, files: [...payload.files].reverse() });
	expect(manifest).toEqual(payload.manifest);
	expect(assets.size).toBe(payload.files.length);
	for (const file of payload.files) {
		const asset = assets.get(file.path)!;
		expect(new Uint8Array(asset.bytes)).toEqual(new Uint8Array(Buffer.from(file.base64, "base64")));
		expect(asset.contentType).toBe(file.contentType);
	}
	expect([...assets.get("/binary.dat")!.bytes]).toEqual([0, 255, 128, 13, 10]);
	expect(devWorkbenchAssetDigest(manifest.files)).toBe(manifest.digest);
	for (const change of [{ path: "/renamed.dat" }, { contentType: "text/plain" }, { version: "0".repeat(64) }]) {
		expect(devWorkbenchAssetDigest([{ ...manifest.files[0]!, ...change }, ...manifest.files.slice(1)])).not.toBe(
			manifest.digest,
		);
	}
});

test("asset decoding rejects missing, extra, duplicate and corrupted payload bytes", () => {
	const payload = fixturePayload();
	for (const file of payload.files) {
		expect(() =>
			decodeDevWorkbenchAssets({ ...payload, files: payload.files.filter(entry => entry.path !== file.path) }),
		).toThrow();
		expect(() =>
			decodeDevWorkbenchAssets({
				...payload,
				files: payload.files.map(entry =>
					entry.path === file.path ? { ...entry, base64: Buffer.from("corrupt").toString("base64") } : entry,
				),
			}),
		).toThrow();
	}
	const first = payload.files[0]!;
	for (const extra of [first, { ...first, path: "/extra.html" }])
		expect(() => decodeDevWorkbenchAssets({ ...payload, files: [...payload.files, extra] })).toThrow();
	for (const path of ["/index.html", "/entry.js"])
		expect(() =>
			decodeDevWorkbenchAssets(fixturePayload(payload.files.filter(file => file.path !== path))),
		).toThrow();
});

test("asset decoding rejects unsafe paths, MIME headers and noncanonical base64", () => {
	const payload = fixturePayload();
	const replaceEntry = (change: Partial<DevAssetPayload["files"][number]>): DevAssetPayload =>
		fixturePayload([{ ...payload.files[0]!, ...change }, ...payload.files.slice(1)]);
	for (const path of [
		"index.html",
		"/",
		"/../outside",
		"/assets/../index.html",
		"/assets\\outside",
		"/index.html?query",
		"/index.html#fragment",
		"/index\0.html",
	]) {
		expect(() => decodeDevWorkbenchAssets(replaceEntry({ path }))).toThrow();
	}
	for (const contentType of ["", "text/html\r\nX-Injected: yes", "text/html; charset=latin1"])
		expect(() => decodeDevWorkbenchAssets(replaceEntry({ contentType }))).toThrow();
	for (const base64 of ["!", "YQ", "YQ==\n", "YR=="])
		expect(() => decodeDevWorkbenchAssets(replaceEntry({ base64 }))).toThrow();
});

test("asset decoding rejects invalid schema, provenance and manifest hashes", () => {
	const payload = fixturePayload();
	for (const value of [
		null,
		{},
		{ ...payload, schemaVersion: 0 },
		{ ...payload, manifest: null },
		{ ...payload, files: null },
		{ ...payload, files: [null] },
		{ ...payload, manifest: { ...payload.manifest, sourceDigest: "bad" } },
		{ ...payload, manifest: { ...payload.manifest, digest: "0".repeat(64) } },
		{ ...payload, manifest: { ...payload.manifest, files: [] } },
		{
			...payload,
			manifest: {
				...payload.manifest,
				files: [{ ...payload.manifest.files[0]!, version: "0".repeat(64) }, ...payload.manifest.files.slice(1)],
			},
		},
	])
		expect(() => decodeDevWorkbenchAssets(value)).toThrow();
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
				captureDevWorkbenchWatchFiles(plugin, id => {
					watched.add(path.resolve(config.root, id));
				});
			}
		},
		generateBundle: {
			order: "post",
			handler(_options, bundle) {
				for (const id of this.getModuleIds()) if (!id.startsWith("\0")) modules.add(id.split("?")[0]!);
				for (const reference of devWorkbenchOutputReferences(bundle)) emittedReferences.add(reference);
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
		const initial = await devWorkbenchSourceDigest(inputs);
		expect(await devWorkbenchSourceDigest(new Map([...inputs].reverse()))).toBe(initial);
		for (const name of ["nested.css", "candidates.html", "worker-leaf.js", "asset.svg"]) {
			const file = await fs.realpath(path.join(root, name));
			const original = inputs.get(file)!;
			await fs.appendFile(file, "\n/* changed build input */");
			inputs.set(file, await fs.readFile(file));
			expect(await devWorkbenchSourceDigest(inputs)).not.toBe(initial);
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
	captureDevWorkbenchWatchFiles(original, id => declarations.push(id));
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
	captureDevWorkbenchWatchFiles(original, () => {
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
			devWorkbenchSourceDigest(new Map([[path.join(path.dirname(input), file.name), new Uint8Array()]])),
		).rejects.toThrow();
	}
});
