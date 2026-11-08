import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isCompiledBinary, isEnoent } from "@oh-my-pi/pi-utils";
import { getPackageDir } from "../config";

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

/** Validate every byte before exposing a release payload; never fall back to a runtime build. */
function bundledResources(archive: Uint8Array): Map<string, StaticResource> {
	const manifest: unknown = JSON.parse(Bun.zstdDecompressSync(archive).toString("utf8"));
	if (
		!record(manifest) ||
		manifest.version !== 1 ||
		typeof manifest.fingerprint !== "string" ||
		!Array.isArray(manifest.files) ||
		manifest.files.length === 0
	) {
		throw new Error("WebGUI resource manifest is invalid.");
	}
	const resources = new Map<string, StaticResource>();
	const fingerprints: Array<[string, number, string]> = [];
	for (const entry of manifest.files) {
		if (
			!record(entry) ||
			typeof entry.path !== "string" ||
			typeof entry.data !== "string" ||
			typeof entry.sha256 !== "string" ||
			typeof entry.size !== "number" ||
			!Number.isSafeInteger(entry.size) ||
			entry.size < 0 ||
			!/^[a-f0-9]{64}$/.test(entry.sha256) ||
			!entry.path ||
			entry.path.startsWith("/") ||
			entry.path.includes("\\") ||
			entry.path.includes("\0") ||
			entry.path.split("/").some(part => !part || part.startsWith(".")) ||
			resources.has(entry.path)
		) {
			throw new Error("WebGUI resource entry is invalid.");
		}
		const bytes = Buffer.from(entry.data, "base64");
		if (bytes.length !== entry.size || createHash("sha256").update(bytes).digest("hex") !== entry.sha256) {
			throw new Error(`WebGUI resource integrity check failed: ${entry.path}`);
		}
		fingerprints.push([entry.path, entry.size, entry.sha256]);
		resources.set(entry.path, { body: bytes, etag: `"${entry.sha256}"` });
	}
	if (
		createHash("sha256").update(JSON.stringify(fingerprints)).digest("hex") !== manifest.fingerprint ||
		!fingerprints.some(([name, size]) => name === "index.html" && size > 0) ||
		!fingerprints.some(([name, size]) => /\.(?:m?js)$/.test(name) && size > 0)
	) {
		throw new Error("WebGUI resource fingerprint or production entrypoint is invalid.");
	}
	return resources;
}

/** Load the same compressed manifest shipped by standalone and npm releases. */
export async function prepareWebGuiAssetsFromArchive(archive: Uint8Array): Promise<WebGuiStaticAssets> {
	const resources = bundledResources(archive);
	return prepareStaticAssets(relative => resources.get(relative));
}

let embeddedAssets: Promise<WebGuiStaticAssets> | undefined;

/** Checkout builds stay file-backed; standalone and npm builds use only their own packaged resources. */
export async function prepareWebGuiAssets(): Promise<WebGuiStaticAssets> {
	const packageDir = getPackageDir();
	let find: ((relative: string) => StaticResource | undefined | Promise<StaticResource | undefined>) | undefined;
	const embeddedArchive = process.env.PI_WEBGUI_EMBED;
	if (embeddedArchive) {
		return (embeddedAssets ??= prepareWebGuiAssetsFromArchive(Buffer.from(embeddedArchive, "base64")));
	} else if (
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
	if (!find && packageDir && !isCompiledBinary()) {
		const file = path.join(packageDir, "dist/webgui-resources.json.zst");
		let archive: Buffer | undefined;
		try {
			archive = await fs.readFile(file);
		} catch (error) {
			if (!isEnoent(error)) throw error;
		}
		if (archive) return prepareWebGuiAssetsFromArchive(archive);
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
	const index = await resourceFor("index.html");
	if (!index) throw new Error("WebGUI production HTML is unavailable.");
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
			let file = relative ? await resourceFor(relative) : index;
			let mime = extension ? MIME_TYPES[extension] : MIME_TYPES[".html"];
			if (!file && !extension && request.headers.get("accept")?.includes("text/html")) {
				file = index;
				mime = MIME_TYPES[".html"];
			}
			if (!file) return new Response(null, { status: 404, headers });
			// Unknown extensionless build files are not public resources.
			if (!extension && file !== index) return new Response(null, { status: 404, headers });
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
