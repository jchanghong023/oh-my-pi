import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { TempDir } from "@oh-my-pi/pi-utils";
import { prepareWebGuiAssetsFromArchive } from "../../src/webgui/static-assets";

interface ResourceManifest {
	version: number;
	fingerprint: string;
	files: Array<{ path: string; size: number; sha256: string; data: string }>;
}

const html =
	'<!doctype html><html><body><div id="root"></div><script type="module" src="/assets/main-12345678.mjs"></script></body></html>';
const moduleSource = 'document.querySelector("#root").textContent = "packaged";';
const cmap = Buffer.from([0, 1, 127, 128, 255]);
const notification = Buffer.from([0x49, 0x44, 0x33, 0, 1, 255]);

function manifest(): ResourceManifest {
	const entries: Array<[string, string | Buffer]> = [
		["index.html", html],
		["assets/main-12345678.mjs", moduleSource],
		["cmaps/Example.bcmap", cmap],
		["private.html", "Not a public HTML entry"],
		["secrets.json", '{"private":true}'],
		["LICENSE", "Not a public extensionless resource"],
		["assets/task-notification-12345678.mp3", notification],
	];
	const files = entries.map(([path, content]) => {
		const bytes = typeof content === "string" ? Buffer.from(content) : content;
		return {
			path,
			size: bytes.length,
			sha256: createHash("sha256").update(bytes).digest("hex"),
			data: bytes.toString("base64"),
		};
	});
	return {
		version: 1,
		fingerprint: createHash("sha256")
			.update(JSON.stringify(files.map(file => [file.path, file.size, file.sha256])))
			.digest("hex"),
		files,
	};
}

async function loadArchive(temp: TempDir, resources: ResourceManifest) {
	const file = temp.join("webgui-resources.json.zst");
	await fs.writeFile(file, Bun.zstdCompressSync(JSON.stringify(resources)));
	return prepareWebGuiAssetsFromArchive(await fs.readFile(file));
}

test("packaged resources serve real GET/HEAD bytes, modules, CMaps and notification audio within the HTTP boundary", async () => {
	using temp = TempDir.createSync("@pi-packaged-assets-");
	const resources = manifest();
	const assets = await loadArchive(temp, resources);
	const request = (path: string, init?: RequestInit) => assets.fetch(new Request(`http://localhost${path}`, init));
	const index = await request("/");
	expect(index.status).toBe(200);
	expect(index.headers.get("content-type")).toBe("text/html; charset=utf-8");
	expect(index.headers.get("cache-control")).toBe("no-cache");
	expect(index.headers.get("x-content-type-options")).toBe("nosniff");
	expect(await index.text()).toBe(html);

	const module = await request("/assets/main-12345678.mjs");
	expect(module.status).toBe(200);
	expect(module.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
	expect(module.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
	expect(module.headers.get("etag")).toBe(`"${resources.files[1]!.sha256}"`);
	expect(await module.text()).toBe(moduleSource);
	const head = await request("/assets/main-12345678.mjs", { method: "HEAD" });
	expect(head.status).toBe(200);
	expect([...head.headers]).toEqual([...module.headers]);
	expect((await head.arrayBuffer()).byteLength).toBe(0);

	const map = await request("/cmaps/Example.bcmap");
	expect(map.status).toBe(200);
	expect(map.headers.get("content-type")).toBe("application/octet-stream");
	expect(map.headers.get("cache-control")).toBe("no-cache");
	expect(Buffer.from(await map.arrayBuffer())).toEqual(cmap);
	const audio = await request("/assets/task-notification-12345678.mp3");
	expect(audio.status).toBe(200);
	expect(audio.headers.get("content-type")).toBe("audio/mpeg");
	expect(Buffer.from(await audio.arrayBuffer())).toEqual(notification);
	const spa = await request("/project/conversation", { headers: { Accept: "text/html" } });
	expect(spa.status).toBe(200);
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
		const response = await request(pathname);
		expect(response.status).toBe(404);
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(await response.text()).toBe("");
	}
	expect((await request("/%E0%A4%A")).status).toBe(400);
	const post = await request("/", { method: "POST" });
	expect(post.status).toBe(405);
	expect(post.headers.get("allow")).toBe("GET, HEAD");
	expect(await post.text()).toBe("");
});

test("packaged loader rejects changed resource bytes and manifest fingerprints before exposing assets", async () => {
	using temp = TempDir.createSync("@pi-packaged-integrity-");
	const changedBytes = manifest();
	const entry = changedBytes.files[0]!;
	const bytes = Buffer.from(entry.data, "base64");
	bytes[0] = bytes[0]! ^ 1;
	entry.data = bytes.toString("base64");
	await expect(loadArchive(temp, changedBytes)).rejects.toThrow("WebGUI resource integrity check failed: index.html");

	const changedFingerprint = manifest();
	changedFingerprint.fingerprint = "0".repeat(64);
	await expect(loadArchive(temp, changedFingerprint)).rejects.toThrow(
		"WebGUI resource fingerprint or production entrypoint is invalid.",
	);
});
