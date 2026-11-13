import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	decodeEmbeddedArchive,
	extractEmbeddedArchive,
	hasEmbeddedArchive,
	isCompiledBinary,
	isEnoent,
} from "@oh-my-pi/pi-utils";
import { getPackageDir } from "../config";
import archiveText from "./webgui-resources.generated.txt";

const MIME_TYPES: Readonly<Record<string, string>> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".avif": "image/avif",
	".ico": "image/x-icon",
	".icns": "image/icns",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".ttf": "font/ttf",
	".otf": "font/otf",
	".webmanifest": "application/manifest+json",
	".wasm": "application/wasm",
	".bcmap": "application/octet-stream",
	".mp3": "audio/mpeg",
};

const META_FILE = "__omp_meta__.json";
const MODULE_SCRIPT_SRC = /<script\b[^>]*\btype=["']module["'][^>]*\bsrc=["']([^"']+)["']/gi;

export interface WebGuiStaticAssets {
	fetch(request: Request): Promise<Response>;
}

function contained(root: string, target: string): boolean {
	const relative = path.relative(root, target);
	return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

async function preparedFile(root: string, relative: string): Promise<string | undefined> {
	const target = path.resolve(root, relative);
	if (!contained(root, target)) return undefined;
	try {
		const resolved = await fs.realpath(target);
		if (!contained(root, resolved) || !(await fs.stat(resolved)).isFile()) return undefined;
		return resolved;
	} catch (error) {
		if (isEnoent(error) || (error instanceof Error && "code" in error && error.code === "ENOTDIR")) return undefined;
		throw error;
	}
}

interface StaticResource {
	readonly body: Blob | Buffer;
	readonly etag?: string;
}

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function resourcesFingerprint(entries: ReadonlyArray<readonly [string, number, string]>): string {
	return sha256(Buffer.from(JSON.stringify(entries)));
}

/** Reject traversal, absolute and hidden entries before any byte becomes reachable. */
function safeResourcePath(name: string): boolean {
	return (
		name.length > 0 &&
		!name.startsWith("/") &&
		!name.includes("\\") &&
		!name.includes("\0") &&
		name.split("/").every(part => part.length > 0 && !part.startsWith("."))
	);
}

function moduleScriptPath(src: string): string {
	return src.replace(/^\.\//, "").replace(/^\//, "");
}

/** Validate every byte before exposing a release payload; never fall back to a runtime build. */
async function archivedResources(archive: Uint8Array): Promise<Map<string, StaticResource>> {
	const extracted = await extractEmbeddedArchive(archive);
	let meta: unknown;
	try {
		meta = JSON.parse((await extracted.get(META_FILE)?.text()) ?? "");
	} catch {
		throw new Error("WebGUI resource manifest is invalid.");
	}
	if (!record(meta) || typeof meta.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(meta.fingerprint)) {
		throw new Error("WebGUI resource manifest is invalid.");
	}
	const resources = new Map<string, StaticResource>();
	const entries: Array<[string, number, string]> = [];
	const sizes = new Map<string, number>();
	let indexHtml: string | undefined;
	for (const [name, file] of [...extracted].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
		if (name === META_FILE) continue;
		if (!safeResourcePath(name) || resources.has(name)) {
			throw new Error(`WebGUI resource entry is invalid: ${name}`);
		}
		const bytes = Buffer.from(await file.arrayBuffer());
		const digest = sha256(bytes);
		entries.push([name, bytes.length, digest]);
		sizes.set(name, bytes.length);
		resources.set(name, { body: bytes, etag: `"${digest}"` });
		if (name === "index.html") indexHtml = bytes.toString("utf8");
	}
	const moduleScripts = indexHtml ? [...indexHtml.matchAll(MODULE_SCRIPT_SRC)] : [];
	if (
		resourcesFingerprint(entries) !== meta.fingerprint ||
		!sizes.get("index.html") ||
		!moduleScripts.length ||
		moduleScripts.some(match => {
			const name = moduleScriptPath(match[1]!);
			return !sizes.get(name) || !/\.(?:m?js)$/.test(name);
		})
	) {
		throw new Error("WebGUI resource fingerprint or production entrypoint is invalid.");
	}
	return resources;
}

/**
 * Serve a packaged archive. Decoding and validation stay deferred until the
 * first fetch so importing the generated text costs only the magic-byte sniff.
 */
export async function prepareWebGuiAssetsFromArchive(archive: Uint8Array): Promise<WebGuiStaticAssets> {
	let pending: Promise<Map<string, StaticResource>> | undefined;
	const resources = () => (pending ??= archivedResources(archive));
	return prepareStaticAssets(async relative => (await resources()).get(relative));
}

let embeddedAssets: Promise<WebGuiStaticAssets> | undefined;

/** Checkout builds stay file-backed; standalone and npm builds use only their own packaged resources. */
export async function prepareWebGuiAssets(): Promise<WebGuiStaticAssets> {
	const packageDir = getPackageDir();
	if (hasEmbeddedArchive(archiveText)) {
		return (embeddedAssets ??= (async () => {
			const archive = decodeEmbeddedArchive(archiveText);
			if (!archive)
				throw new Error("Embedded WebGUI resources are corrupt; rebuild OMP with bundled WebGUI assets.");
			return prepareWebGuiAssetsFromArchive(archive);
		})());
	}
	let find: ((relative: string) => StaticResource | undefined | Promise<StaticResource | undefined>) | undefined;
	if (
		!isCompiledBinary() &&
		!process.env.PI_BUNDLED &&
		packageDir &&
		!packageDir.split(/[\\/]/).includes("node_modules")
	) {
		const buildDir = path.resolve(packageDir, "../../vendor/zcode-frontend/build/webgui");
		let root: string | undefined;
		try {
			root = await fs.realpath(buildDir);
		} catch (error) {
			if (!isEnoent(error)) throw error;
		}
		if (root) {
			const preparedRoot = root;
			const index = await preparedFile(preparedRoot, "index.html");
			if (!index) throw new Error(`WebGUI production HTML is unavailable at ${buildDir}; run bun run build:webgui`);
			const indexResource: StaticResource = { body: Bun.file(index) };
			find = async relative => {
				if (relative === "index.html") return indexResource;
				const file = await preparedFile(preparedRoot, relative);
				return file ? { body: Bun.file(file) } : undefined;
			};
		}
	}
	if (!find) {
		try {
			const packaged = await Bun.file(new URL("../../dist/webgui-resources.generated.txt", import.meta.url)).text();
			const archive = decodeEmbeddedArchive(packaged);
			if (archive) return prepareWebGuiAssetsFromArchive(archive);
		} catch (error) {
			if (!isEnoent(error)) throw error;
		}
	}
	if (!find) {
		throw new Error(
			"WebGUI production resources are unavailable; rebuild/reinstall OMP with bundled WebGUI assets. Source checkouts can run bun run build:webgui.",
		);
	}
	return prepareStaticAssets(find);
}

async function prepareStaticAssets(
	resourceFor: (relative: string) => StaticResource | undefined | Promise<StaticResource | undefined>,
): Promise<WebGuiStaticAssets> {
	let indexPromise: Promise<StaticResource> | undefined;
	const index = () =>
		(indexPromise ??= (async () => {
			const resource = await resourceFor("index.html");
			if (!resource) throw new Error("WebGUI production HTML is unavailable.");
			return resource;
		})());
	return {
		async fetch(request) {
			const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
			if (request.method !== "GET" && request.method !== "HEAD")
				return new Response(null, { status: 405, headers: { ...headers, Allow: "GET, HEAD" } });
			let pathname: string;
			try {
				pathname = decodeURIComponent(new URL(request.url).pathname);
			} catch {
				return new Response(null, { status: 400, headers });
			}
			if (
				pathname.includes("\\") ||
				pathname.includes("\0") ||
				pathname.split("/").some(part => part.startsWith("."))
			)
				return new Response(null, { status: 404, headers });
			const relative = pathname.replace(/^\/+/, "");
			const extension = path.extname(relative).toLowerCase();
			if (
				(extension && !Object.hasOwn(MIME_TYPES, extension)) ||
				(extension === ".html" && relative !== "index.html")
			)
				return new Response(null, { status: 404, headers });
			const indexResource = await index();
			let file = relative ? await resourceFor(relative) : indexResource;
			let mime = extension ? MIME_TYPES[extension] : MIME_TYPES[".html"];
			if (!file && !extension && request.headers.get("accept")?.includes("text/html")) {
				file = indexResource;
				mime = MIME_TYPES[".html"];
			}
			if (!file) return new Response(null, { status: 404, headers });
			// Unknown extensionless build files are not public resources.
			if (!extension && file !== indexResource) return new Response(null, { status: 404, headers });
			const immutable = relative.startsWith("assets/") && /[-.][\w-]{8,}\.[a-z0-9]+$/i.test(relative);
			return new Response(request.method === "HEAD" ? null : file.body, {
				headers: {
					...headers,
					"Content-Type": mime,
					"Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
					...(file.etag ? { ETag: file.etag } : {}),
				},
			});
		},
	};
}
