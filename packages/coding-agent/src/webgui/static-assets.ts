import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { getPackageDir } from "../config";

const MIME_TYPES: Readonly<Record<string, string>> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
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

/** Only an explicitly prepared production build is public; source checkouts are not a web root. */
export async function prepareWebGuiAssets(): Promise<WebGuiStaticAssets> {
	const packageDir = getPackageDir();
	if (!packageDir) {
		throw new Error(
			"WebGUI assets are not bundled in this executable; use an OMP source checkout with bun run build:webgui",
		);
	}
	const buildDir = path.resolve(packageDir, "../../vendor/zcode-frontend/build/webgui");
	let root: string;
	try {
		root = await fs.realpath(buildDir);
	} catch (error) {
		if (!isEnoent(error)) throw error;
		throw new Error(
			`WebGUI production assets are unavailable at ${buildDir}; run bun run build:webgui in the OMP source checkout`,
		);
	}
	const index = await preparedFile(root, "index.html");
	if (!index) throw new Error(`WebGUI production HTML is unavailable at ${buildDir}; run bun run build:webgui`);
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
			let file = relative ? await preparedFile(root, relative) : index;
			let mime = extension ? MIME_TYPES[extension] : MIME_TYPES[".html"];
			if (!file && !extension && request.headers.get("accept")?.includes("text/html")) {
				file = index;
				mime = MIME_TYPES[".html"];
			}
			if (!file) return new Response(null, { status: 404, headers });
			// Unknown extensionless build files are not public resources.
			if (!extension && file !== index) return new Response(null, { status: 404, headers });
			const immutable = relative.startsWith("assets/") && /[-.][\w-]{8,}\.[a-z0-9]+$/i.test(relative);
			return new Response(request.method === "HEAD" ? null : Bun.file(file), {
				headers: {
					...headers,
					"Content-Type": mime,
					"Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
				},
			});
		},
	};
}
