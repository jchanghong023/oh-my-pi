import * as fs from "node:fs";
import * as path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import type { Plugin, UserConfig } from "vite";
import { pdfJsCMapsPlugin } from "./packages/ui/vite/pdfJsCMapsPlugin.js";

const root = import.meta.dirname;
const packages = path.join(root, "packages");

function dependencyFile(name: string, relative: string): string {
	const file = path.join(root, "node_modules", name, relative);
	if (!fs.existsSync(file))
		throw new Error(`Missing local Dev dependency: ${name}/${relative}. Run bun ./standalone.ts install.`);
	return copiedPath(fs.realpathSync(file));
}

function copiedPath(file: string): string {
	const relative = path.relative(root, file);
	if (relative.startsWith("..") || path.isAbsolute(relative))
		throw new Error(`Dev frontend alias escapes its owned copy: ${file}`);
	return file;
}

function copiedFrontendPackages(): Plugin {
	return {
		name: "copied-frontend-packages",
		enforce: "pre",
		async resolveId(source: string, importer: string | undefined) {
			if (source.startsWith("#src/")) {
				if (!importer) throw new Error(`Dev package-local import has no importer: ${source}`);
				const relative = path.relative(packages, importer.split("?")[0]!);
				if (relative.startsWith("..") || path.isAbsolute(relative))
					throw new Error(`Dev package-local import is outside the copy: ${importer}`);
				const packageName = relative.split(path.sep)[0]!;
				const resolved = await this.resolve(
					copiedPath(path.join(packages, packageName, "src", source.slice(5))),
					importer,
					{ skipSelf: true },
				);
				if (!resolved) throw new Error(`Unresolved copied Dev import: ${source}`);
				return resolved;
			}
			if (source.startsWith("@zcode/")) {
				const [packageName, ...segments] = source.slice(7).split("/");
				const packageRoot = copiedPath(path.join(packages, packageName!));
				const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")) as {
					exports?: string | Record<string, unknown>;
				};
				const key = segments.length ? `./${segments.join("/")}` : ".";
				let entry: unknown = typeof manifest.exports === "object" ? manifest.exports[key] : undefined;
				if (entry === undefined && key === ".") entry = manifest.exports;
				if (typeof entry === "object" && entry !== null) {
					const conditions = entry as { browser?: unknown; import?: unknown; default?: unknown };
					entry = conditions.browser ?? conditions.import ?? conditions.default;
				}
				if (typeof entry !== "string") throw new Error(`No copied Dev export: ${source}`);
				const resolved = await this.resolve(copiedPath(path.resolve(packageRoot, entry)), importer, {
					skipSelf: true,
				});
				if (!resolved) throw new Error(`Unresolved copied Dev export: ${source}`);
				return resolved;
			}
			if (
				source.startsWith(".") ||
				source.startsWith("/") ||
				source.startsWith("\0") ||
				path.isAbsolute(source) ||
				/^[a-z][a-z\d+.-]*:/i.test(source)
			)
				return;
			const resolved = await this.resolve(source, importer, { skipSelf: true });
			if (resolved && !resolved.id.startsWith("\0")) {
				const id = resolved.id.split("?")[0]!;
				if (path.isAbsolute(id)) copiedPath(id);
			}
			return resolved;
		},
	};
}

export function createAIReqFrontendConfig(entryRoot: string, outputDirectory: string, defaultBasePath = "/"): UserConfig {
	const basePath = process.env.OMP_AIREQ_BASE_PATH ?? defaultBasePath;
	if (
		basePath !== "./" &&
		(!basePath.startsWith("/") ||
			!basePath.endsWith("/") ||
			basePath.includes("//") ||
			/[?#\\]/u.test(basePath) ||
			basePath.split("/").some(segment => segment === "." || segment === ".."))
	)
		throw new Error("OMP_AIREQ_BASE_PATH must be an absolute directory path ending in /, such as /xxx/xxx/");
	// Runtime assets retain relative URLs for the native host's random capability directory.
	const mountPath = basePath === "./" ? "/" : basePath;
	const host = process.env.OMP_AIREQ_FRONTEND_HOST ?? "0.0.0.0";
	const port = Number(process.env.OMP_AIREQ_FRONTEND_PORT ?? "4173");
	if (!Number.isInteger(port) || port < 1 || port > 65535)
		throw new Error("OMP_AIREQ_FRONTEND_PORT must be between 1 and 65535");
	// Browsers use the page's origin; only this dev/preview server connects to the backend.
	const proxy = {
		[`${mountPath}api/aireq`]: {
			target: process.env.OMP_AIREQ_PROXY_TARGET ?? "http://127.0.0.1:4174",
			ws: true,
			rewrite: (requestPath: string) => requestPath.slice(mountPath.length - 1),
		},
	};
	const redirectDirectory = (request: IncomingMessage, response: ServerResponse, next: () => void) => {
		const url = new URL(request.url ?? "/", "http://aireq.local");
		if (mountPath !== "/" && url.pathname === mountPath.slice(0, -1)) {
			response.writeHead(302, { Location: mountPath + url.search });
			response.end();
			return;
		}
		next();
	};
	const mountedEntry: Plugin = {
		name: "aireq-mounted-entry",
		configureServer(server) {
			server.middlewares.use(redirectDirectory);
		},
		configurePreviewServer(server) {
			server.middlewares.use(redirectDirectory);
		},
	};
	return {
		root: entryRoot,
		base: basePath,
		publicDir: path.join(packages, "web/public"),
		plugins: [mountedEntry, copiedFrontendPackages(), react(), tailwindcss(), pdfJsCMapsPlugin()],
		resolve: {
			alias: [
				{ find: "@zcode/ui/styles.css", replacement: path.join(packages, "ui/src/styles.css") },
				{ find: "@", replacement: path.join(packages, "ui/src") },
				{ find: /^tailwindcss$/, replacement: dependencyFile("tailwindcss", "index.css") },
				{ find: /^tw-animate-css$/, replacement: dependencyFile("tw-animate-css", "dist/tw-animate.css") },
				{
					find: "tailwind-scrollbar-hide/v4",
					replacement: dependencyFile("tailwind-scrollbar-hide", "src/styles.css"),
				},
				{ find: "shadcn/tailwind.css", replacement: dependencyFile("shadcn", "dist/tailwind.css") },
				{ find: "katex/dist/katex.min.css", replacement: dependencyFile("katex", "dist/katex.min.css") },
				{ find: "@tailwindcss/typography", replacement: dependencyFile("@tailwindcss/typography", "src/index.js") },
			],
			dedupe: ["react", "react-dom"],
		},
		optimizeDeps: {
			rolldownOptions: {
				output: {
					// 根图标入口与动态图标共用模块时，默认会拆出约两千个静态请求。
					codeSplitting: { groups: [{ name: "lucide-icons", test: /node_modules[\\/]lucide-react[\\/]/ }] },
				},
			},
		},
		server: {
			host,
			port,
			proxy,
			strictPort: true,
			fs: { strict: true, allow: [root] },
		},
		preview: { host, port, strictPort: true, proxy },
		define: {
			__ZCODE_VERSION__: JSON.stringify("3.17.2"),
			__ZCODE_ENV__: JSON.stringify("production"),
			__ZCODE_AUTO_UPDATE_ENABLED__: "false",
		},
		worker: {
			format: "es",
			plugins: () => [copiedFrontendPackages()],
			rolldownOptions: { treeshake: false },
		},
		build: {
			target: "firefox128",
			cssTarget: "firefox128",
			outDir: path.join(root, outputDirectory),
			emptyOutDir: true,
		},
	};
}
