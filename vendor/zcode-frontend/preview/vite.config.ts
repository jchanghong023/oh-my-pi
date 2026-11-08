import * as fs from "node:fs";
import * as path from "node:path";
import { transformAsync } from "@babel/core";
import transformUnicodePropertyRegex from "@babel/plugin-transform-unicode-property-regex";
import rewritePattern from "regexpu-core";
import postcssPresetEnv from "postcss-preset-env";
import { defineConfig, transformWithOxc, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const root = path.resolve(import.meta.dirname, "..");
const packages = path.join(root, "packages");

function copiedFrontendPackages(): Plugin {
	return {
		name: "copied-frontend-packages",
		enforce: "pre",
		resolveId(source: string, importer: string | undefined) {
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
	};
}

function firefoxUnicodeRegex(): Plugin {
	return {
		name: "firefox68-unicode-regex",
		enforce: "pre",
		async transform(code, id) {
			const file = id.split("?")[0];
			// The diff renderer eagerly constructs this lookbehind even when no diff is open.
			// Its only consumer uses it to split while retaining each trailing newline.
			if (file.replaceAll("\\", "/").endsWith("/@pierre/diffs/dist/constants.js")) {
				return code.replace(
					"/(?<=\\n)/",
					"({ [Symbol.split](text, limit) { return (text.match(/[^\\n]*\\n|[^\\n]+$/g) || [text]).slice(0, limit === undefined ? undefined : limit >>> 0); } })",
				);
			}
			if (file.replaceAll("\\", "/").endsWith("/oniguruma-parser/dist/tokenizer/tokenize.js")) {
				// These two properties also occur in tagged strings used to construct regexes at runtime.
				code = code
					.replaceAll("\\p{AHex}", "[0-9A-Fa-f]")
					.replaceAll("\\p{Alpha}", rewritePattern("\\p{Alphabetic}", "u", { unicodePropertyEscapes: "transform" }));
			}
			if (!/\.[cm]?[jt]sx?$/.test(file)) return;
			if (!code.includes("\\p{")) return { code, map: null };
			const transformed = await transformAsync(code, {
				filename: file,
				babelrc: false,
				configFile: false,
				parserOpts: {
					plugins: [
						...(/\.[cm]?tsx?$/.test(file) ? ["typescript" as const] : []),
						...(/\.[jt]sx$/.test(file) ? ["jsx" as const] : []),
					],
				},
				plugins: [transformUnicodePropertyRegex],
				sourceMaps: true,
			});
			if (transformed?.code) return { code: transformed.code, map: transformed.map };
		},
	};
}

export default defineConfig({
	root: import.meta.dirname,
	base: "./",
	publicDir: path.join(packages, "web/public"),
	plugins: [
		copiedFrontendPackages(),
		firefoxUnicodeRegex(),
		{
			name: "browser-compat-bootstrap",
			async buildStart() {
				// A blocking classic script must finish before any application module evaluates.
				const result = await Bun.build({
					entrypoints: [path.join(import.meta.dirname, "bootstrap.ts")],
					target: "browser",
					format: "iife",
					minify: true,
				});
				if (!result.success) throw new AggregateError(result.logs, "WebGUI compatibility build failed");
				const lowered = await transformWithOxc(await result.outputs[0].text(), "browser-compat.js", { target: "firefox68" });
				this.emitFile({
					type: "asset",
					fileName: "assets/browser-compat.js",
					source: lowered.code,
				});
			},
			transformIndexHtml: {
				order: "post",
				handler: () => [{ tag: "script", attrs: { src: "./assets/browser-compat.js" }, injectTo: "head-prepend" }],
			},
		},
		react(),
		tailwindcss(),
	],
	css: {
		postcss: {
			plugins: [postcssPresetEnv({ browsers: ["Firefox 68", "Chrome >= 109"], stage: 2 })],
		},
	},
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
	worker: { plugins: () => [copiedFrontendPackages(), firefoxUnicodeRegex()] },
	build: {
		target: "firefox68",
		cssTarget: "firefox68",
		outDir: path.join(root, "build/webgui"),
		emptyOutDir: true,
	},
});
