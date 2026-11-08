import * as fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import * as path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { WEBGUI_SESSION_INFO_ORIGIN_ENV, WEBGUI_SESSION_INFO_PATH } from "./session-info.js";

const root = path.resolve(import.meta.dirname, "..");
const packages = path.join(root, "packages");
const sessionInfoOrigin = process.env[WEBGUI_SESSION_INFO_ORIGIN_ENV];
const sessionInfoProxy = sessionInfoOrigin
	? { [`^${WEBGUI_SESSION_INFO_PATH}(?:\\?|$)`]: { target: sessionInfoOrigin } }
	: undefined;

function unboundSessionInfo(req: IncomingMessage, res: ServerResponse, next: () => void) {
	if (req.url?.split("?", 1)[0] !== WEBGUI_SESSION_INFO_PATH) return next();
	res.setHeader("Cache-Control", "no-store");
	res.setHeader("Content-Type", "application/json; charset=utf-8");
	if (req.method !== "GET") {
		res.statusCode = 405;
		res.setHeader("Allow", "GET");
		res.end(JSON.stringify({ error: "Method not allowed" }));
		return;
	}
	res.end(JSON.stringify({ bound: false }));
}

export default defineConfig({
	root: import.meta.dirname,
	publicDir: path.join(packages, "web/public"),
	plugins: [
		{
			name: "omp-session-info",
			configureServer(server) {
				if (!sessionInfoOrigin) server.middlewares.use(unboundSessionInfo);
			},
			configurePreviewServer(server) {
				if (!sessionInfoOrigin) server.middlewares.use(unboundSessionInfo);
			},
		},
		{
			name: "copied-frontend-packages",
			enforce: "pre",
			resolveId(source, importer) {
				if (source.startsWith("#src/") && importer) {
					const packageName = path.relative(packages, importer).split(path.sep)[0];
					return this.resolve(path.join(packages, packageName, "src", source.slice(5)), importer, { skipSelf: true });
				}
				if (!source.startsWith("@zcode/")) return;
				const [packageName, ...segments] = source.slice(7).split("/");
				const manifest = JSON.parse(fs.readFileSync(path.join(packages, packageName, "package.json"), "utf8"));
				const key = segments.length ? `./${segments.join("/")}` : ".";
				let entry = manifest.exports?.[key] ?? (key === "." ? manifest.exports : undefined);
				if (typeof entry === "object") entry = entry.browser ?? entry.import ?? entry.default;
				if (typeof entry !== "string") return;
				return this.resolve(path.join(packages, packageName, entry), importer, { skipSelf: true });
			},
		},
		react(),
		tailwindcss(),
	],
	resolve: {
		alias: {
			"@zcode/ui/styles.css": path.join(packages, "ui/src/styles.css"),
			"@": path.join(packages, "ui/src"),
		},
		dedupe: ["react", "react-dom"],
	},
	define: {
		__ZCODE_VERSION__: JSON.stringify("3.17.2"),
		__ZCODE_ENV__: JSON.stringify("production"),
		__ZCODE_AUTO_UPDATE_ENABLED__: "false",
	},
	server: { host: "0.0.0.0", port: 5177, strictPort: true, fs: { allow: [root] }, proxy: sessionInfoProxy },
	preview: { proxy: sessionInfoProxy },
});
