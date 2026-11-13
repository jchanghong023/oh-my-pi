import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { buildEmbeddedArchive, decodeEmbeddedArchive } from "@oh-my-pi/pi-utils/embedded-archive";
import { prepareWebGuiAssetsFromArchive, type WebGuiStaticAssets } from "../../src/webgui/static-assets";

const META_FILE = "__omp_meta__.json";

const html =
	'<!doctype html><html><body><div id="root"></div><script type="module" src="/assets/main-12345678.mjs"></script></body></html>';
const moduleSource = 'document.querySelector("#root").textContent = "packaged";';
const stylesheet = "#root{display:block}";
const cmap = Buffer.from([0, 1, 127, 128, 255]);
const notification = Buffer.from([0x49, 0x44, 0x33, 0, 1, 255]);

type Entry = [path: string, content: string | Uint8Array];

function encode(content: string | Uint8Array): Uint8Array {
	return typeof content === "string" ? new TextEncoder().encode(content) : content;
}

function digest(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function fingerprintOf(files: ReadonlyMap<string, Uint8Array>): string {
	const entries = [...files]
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		.map(([name, bytes]) => [name, bytes.length, digest(bytes)]);
	return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

function entries(): Entry[] {
	return [
		["index.html", html],
		["assets/main-12345678.mjs", moduleSource],
		["assets/main-12345678.css", stylesheet],
		["cmaps/Example.bcmap", cmap],
		["assets/task-notification-12345678.mp3", notification],
		["private.html", "Not a public HTML entry"],
		["secrets.json", '{"private":true}'],
		["LICENSE", "Not a public extensionless resource"],
	];
}

interface ArchiveOptions {
	readonly fingerprint?: string;
	readonly meta?: boolean;
}

/** Mirror the generator: a gzip tar of the relative files plus the fingerprint sidecar. */
async function buildArchive(files: Entry[] = entries(), options: ArchiveOptions = {}): Promise<Uint8Array> {
	const contents = new Map<string, Uint8Array>();
	for (const [name, content] of files) contents.set(name, encode(content));
	if (options.meta !== false) {
		const fingerprint = options.fingerprint ?? fingerprintOf(contents);
		contents.set(META_FILE, encode(JSON.stringify({ fingerprint })));
	}
	const archive = decodeEmbeddedArchive(await buildEmbeddedArchive(contents));
	if (!archive) throw new Error("Fixture archive is not a gzip payload.");
	return archive;
}

function request(assets: WebGuiStaticAssets, path: string, init?: RequestInit) {
	return assets.fetch(new Request(`http://localhost${path}`, init));
}

test("packaged archive serves index, module, stylesheet, CMaps and notification audio within the HTTP boundary", async () => {
	const assets = await prepareWebGuiAssetsFromArchive(await buildArchive());
	const index = await request(assets, "/");
	expect(index.status).toBe(200);
	expect(index.headers.get("content-type")).toBe("text/html; charset=utf-8");
	expect(index.headers.get("cache-control")).toBe("no-cache");
	expect(index.headers.get("x-content-type-options")).toBe("nosniff");
	expect(await index.text()).toBe(html);

	const module = await request(assets, "/assets/main-12345678.mjs");
	expect(module.status).toBe(200);
	expect(module.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
	expect(module.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
	expect(module.headers.get("etag")).toBe(`"${digest(encode(moduleSource))}"`);
	expect(await module.text()).toBe(moduleSource);
	const head = await request(assets, "/assets/main-12345678.mjs", { method: "HEAD" });
	expect(head.status).toBe(200);
	expect([...head.headers]).toEqual([...module.headers]);
	expect((await head.arrayBuffer()).byteLength).toBe(0);

	const css = await request(assets, "/assets/main-12345678.css");
	expect(css.status).toBe(200);
	expect(css.headers.get("content-type")).toBe("text/css; charset=utf-8");
	expect(await css.text()).toBe(stylesheet);

	const map = await request(assets, "/cmaps/Example.bcmap");
	expect(map.status).toBe(200);
	expect(map.headers.get("content-type")).toBe("application/octet-stream");
	expect(map.headers.get("cache-control")).toBe("no-cache");
	expect(Buffer.from(await map.arrayBuffer())).toEqual(cmap);

	const audio = await request(assets, "/assets/task-notification-12345678.mp3");
	expect(audio.status).toBe(200);
	expect(audio.headers.get("content-type")).toBe("audio/mpeg");
	expect(Buffer.from(await audio.arrayBuffer())).toEqual(notification);

	const spa = await request(assets, "/project/conversation", { headers: { Accept: "text/html" } });
	expect(spa.status).toBe(200);
	expect(spa.headers.get("content-type")).toBe("text/html; charset=utf-8");
	expect(await spa.text()).toBe(html);

	for (const pathname of [
		"/project/conversation",
		"/assets/missing.mjs",
		"/private.html",
		"/secrets.json",
		"/LICENSE",
		"/%2eprivate",
		"/assets/%2e%2e%2findex.html",
		"/assets%5cmain-12345678.mjs",
		"/%00index.html",
	]) {
		const response = await request(assets, pathname);
		expect(response.status).toBe(404);
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(await response.text()).toBe("");
	}
	expect((await request(assets, "/%E0%A4%A")).status).toBe(400);
	const post = await request(assets, "/", { method: "POST" });
	expect(post.status).toBe(405);
	expect(post.headers.get("allow")).toBe("GET, HEAD");
	expect(await post.text()).toBe("");
});

test("packaged loader defers archive validation until the first asset fetch", async () => {
	const assets = await prepareWebGuiAssetsFromArchive(new Uint8Array([0x1f, 0x8b, 0x08, 0x00]));
	await expect(request(assets, "/")).rejects.toThrow();
	await expect(request(assets, "/assets/main-12345678.mjs")).rejects.toThrow();
});

test("packaged loader rejects a changed fingerprint before exposing assets", async () => {
	const assets = await prepareWebGuiAssetsFromArchive(await buildArchive(entries(), { fingerprint: "0".repeat(64) }));
	await expect(request(assets, "/")).rejects.toThrow(
		"WebGUI resource fingerprint or production entrypoint is invalid.",
	);
});

test("packaged loader rejects unsafe and missing entries", async () => {
	const missingManifest = await buildArchive(entries(), { meta: false });
	await expect(request(await prepareWebGuiAssetsFromArchive(missingManifest), "/")).rejects.toThrow(
		"WebGUI resource manifest is invalid.",
	);

	const unsafePath = await buildArchive([...entries(), ["../escape.js", "escape"]]);
	await expect(request(await prepareWebGuiAssetsFromArchive(unsafePath), "/")).rejects.toThrow(
		"WebGUI resource entry is invalid: ../escape.js",
	);

	const missingIndex = await buildArchive(entries().filter(([name]) => name !== "index.html"));
	await expect(request(await prepareWebGuiAssetsFromArchive(missingIndex), "/")).rejects.toThrow(
		"WebGUI resource fingerprint or production entrypoint is invalid.",
	);

	const missingModule = await buildArchive(entries().filter(([name]) => name !== "assets/main-12345678.mjs"));
	await expect(request(await prepareWebGuiAssetsFromArchive(missingModule), "/")).rejects.toThrow(
		"WebGUI resource fingerprint or production entrypoint is invalid.",
	);

	const withoutModuleScript = await buildArchive([
		["index.html", '<!doctype html><html><body><div id="root"></div></body></html>'],
		["assets/main-12345678.mjs", moduleSource],
	]);
	await expect(request(await prepareWebGuiAssetsFromArchive(withoutModuleScript), "/")).rejects.toThrow(
		"WebGUI resource fingerprint or production entrypoint is invalid.",
	);
});
