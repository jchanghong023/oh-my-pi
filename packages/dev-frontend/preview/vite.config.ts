import * as fs from "node:fs";
import * as path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import type { Plugin, UserConfig } from "vite";
import { pdfJsCMapsPlugin } from "../packages/ui/vite/pdfJsCMapsPlugin.js";

const root = path.resolve(import.meta.dirname, "..");
const packages = path.join(root, "packages");

function dependencyFile(name: string, relative: string): string {
	const file = path.join(root, "node_modules", name, relative);
	if (!fs.existsSync(file)) throw new Error(`Missing local Dev dependency: ${name}/${relative}. Run bun ./standalone.ts install.`);
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
				const resolved = await this.resolve(copiedPath(path.join(packages, packageName, "src", source.slice(5))), importer, { skipSelf: true });
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
				const resolved = await this.resolve(copiedPath(path.resolve(packageRoot, entry)), importer, { skipSelf: true });
				if (!resolved) throw new Error(`Unresolved copied Dev export: ${source}`);
				return resolved;
			}
			if (source.startsWith(".") || source.startsWith("/") || source.startsWith("\0") ||
				path.isAbsolute(source) || /^[a-z][a-z\d+.-]*:/i.test(source)) return;
			const resolved = await this.resolve(source, importer, { skipSelf: true });
			if (resolved && !resolved.id.startsWith("\0")) {
				const id = resolved.id.split("?")[0]!;
				if (path.isAbsolute(id)) copiedPath(id);
			}
			return resolved;
		},
	};
}

export default function devFrontendConfig(): UserConfig {
	return {
		root: import.meta.dirname,
		base: "./",
		publicDir: path.join(packages, "web/public"),
		plugins: [copiedFrontendPackages(), react(), tailwindcss(), pdfJsCMapsPlugin()],
		resolve: {
			alias: [
				{ find: "@zcode/ui/styles.css", replacement: path.join(packages, "ui/src/styles.css") },
				{ find: "@", replacement: path.join(packages, "ui/src") },
				{ find: /^tailwindcss$/, replacement: dependencyFile("tailwindcss", "index.css") },
				{ find: /^tw-animate-css$/, replacement: dependencyFile("tw-animate-css", "dist/tw-animate.css") },
				{ find: "tailwind-scrollbar-hide/v4", replacement: dependencyFile("tailwind-scrollbar-hide", "src/styles.css") },
				{ find: "shadcn/tailwind.css", replacement: dependencyFile("shadcn", "dist/tailwind.css") },
				{ find: "katex/dist/katex.min.css", replacement: dependencyFile("katex", "dist/katex.min.css") },
				{ find: "@tailwindcss/typography", replacement: dependencyFile("@tailwindcss/typography", "src/index.js") },
			],
			dedupe: ["react", "react-dom"],
		},
		server: {
			host: "127.0.0.1",
			port: 4173,
			strictPort: true,
			fs: { strict: true, allow: [root] },
		},
		preview: { host: "127.0.0.1", port: 4173, strictPort: true },
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
			outDir: path.join(root, "build/dev"),
			emptyOutDir: true,
		},
	};
}
