import * as fs from "node:fs";
import * as path from "node:path";
import { gunzipSync } from "node:zlib";
import { transformAsync } from "@babel/core";
import transformUnicodePropertyRegex from "@babel/plugin-transform-unicode-property-regex";
import rewritePattern from "regexpu-core";
import postcss from "postcss";
import postcssPresetEnv from "postcss-preset-env";
import { defineConfig, transformWithOxc, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { pdfJsCMapsPlugin } from "../packages/ui/vite/pdfJsCMapsPlugin.js";

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
			if (transformed?.code)
				return { code: transformed.code, map: transformed.map ? JSON.stringify(transformed.map) : null };
		},
	};
}

function diffsCompatibility(): Plugin {
	const helper = JSON.stringify(path.join(import.meta.dirname, "diffs-compat.ts"));
	const dependency = "/@pierre/diffs/dist/";
	return {
		name: "preview-diffs-dom-compat",
		enforce: "pre",
		async transform(code, id) {
			const file = id.split("?")[0].replaceAll("\\", "/");
			if (file.endsWith("/@shikijs/engine-oniguruma/dist/wasm-inlined.mjs")) {
				const compressed = code.match(/Uint8Array\.from\(atob\(("[A-Za-z0-9+/=]+")\), c => c\.charCodeAt\(0\)\)/);
				const loader = /const wasmBinaryPromise = new Response\(\s*new Blob\(\[binary\]\)\.stream\(\)\.pipeThrough\(new DecompressionStream\("gzip"\)\)\s*\)\.bytes\(\);/;
				// Streamdown's older Shiki already embeds raw WebAssembly v1 bytes and
				// instantiates them directly; it needs no decompression compatibility.
				if (compressed && JSON.parse(compressed[1]).startsWith("AGFzbQEAAA") &&
					/const wasmBinary = binary;/.test(code) &&
					/WebAssembly\.instantiate\(wasmBinary, info\)/.test(code) &&
					!/\bDecompressionStream\b|\.stream\(|\.bytes\(/.test(code)) return;
				if (!compressed || !loader.test(code)) throw new Error("Unsupported Shiki compressed WASM loader");
				// This on-demand highlighter module uses three APIs absent in Firefox 68.
				// Emit the actual decompressed binary, rather than polyfilling browser streams.
				const binary = this.emitFile({
					type: "asset",
					name: "diffs-oniguruma-legacy.wasm",
					source: gunzipSync(Buffer.from(JSON.parse(compressed[1]), "base64")),
				});
				return {
					code: `const supportsNativeWasmDecompression = typeof DecompressionStream === "function" && typeof Blob.prototype.stream === "function" && typeof Response.prototype.bytes === "function";\n` +
						code.replace(compressed[0], `supportsNativeWasmDecompression ? ${compressed[0]} : undefined`)
							.replace(loader, (native) =>
								`const wasmBinaryPromise = supportsNativeWasmDecompression
									? ${native.slice("const wasmBinaryPromise = ".length, -1)}
									: fetch(import.meta.ROLLUP_FILE_URL_${binary}).then(response => response.arrayBuffer());`),
					map: null,
				};
			}
			const offset = file.lastIndexOf(dependency);
			if (offset < 0) return;
			const module = file.slice(offset + dependency.length);
			if (module === "style.js") {
				const match = code.match(/var style_default = ("(?:[^"\\]|\\.)*");/);
				if (!match) throw new Error("Unsupported @pierre/diffs embedded stylesheet format");
				const css = JSON.parse(match[1]) as string;
				// Inline CSS strings do not pass through Vite's CSS pipeline. Flatten only
				// this dependency's fallback; keep its original stylesheet for modern engines.
				const legacy = await postcss([
					{
						postcssPlugin: "diffs-inline-layer-order",
						Once(root) {
							root.walkAtRules("layer", (rule) => {
								if (rule.nodes) rule.replaceWith(...rule.nodes);
								else rule.remove();
							});
						},
					},
					postcssPresetEnv({
						browsers: ["Firefox 68"],
						stage: 2,
						preserve: false,
						features: { "nesting-rules": true, "light-dark-function": true },
					}),
				]).process(css.replace(/(-?\d*\.?\d+)lh\b/g, "calc($1 * var(--diffs-line-height,20px))") + `
					:host{
						--diffs-bg-buffer:var(--diffs-bg-buffer-override,light-dark(#f0f0f0,#202020));
						--diffs-bg-context:var(--diffs-bg-context-override,light-dark(#f5f5f5,#202020));
						--diffs-bg-context-gutter:var(--diffs-bg-context-gutter-override,light-dark(#ededed,#282828));
						--diffs-bg-separator:var(--diffs-bg-separator-override,light-dark(#eee,#303030));
						--diffs-fg-number:var(--diffs-fg-number-override,light-dark(#666,#aaa));
						--diffs-selection-number-fg:light-dark(#0068ae,#8acbff);
						--diffs-bg-addition:var(--diffs-bg-addition-override,light-dark(#e2f5e8,#163820));
						--diffs-bg-deletion:var(--diffs-bg-deletion-override,light-dark(#ffe5e7,#401c24));
						--diffs-bg-addition-emphasis:var(--diffs-bg-addition-emphasis-override,rgba(13,190,78,.2));
						--diffs-bg-deletion-emphasis:var(--diffs-bg-deletion-emphasis-override,rgba(255,46,63,.2));
					}
					[data-background] [data-line-type=change-addition]{--diffs-computed-diff-line-bg:var(--diffs-bg-addition)}
					[data-background] [data-line-type=change-deletion]{--diffs-computed-diff-line-bg:var(--diffs-bg-deletion)}
					[data-line][data-selected-line],[data-column-number][data-selected-line],[data-gutter-buffer][data-selected-line],[data-line-annotation][data-selected-line],[data-no-newline][data-selected-line],[data-merge-conflict][data-selected-line],[data-merge-conflict-actions][data-selected-line]{--diffs-computed-selected-line-bg:light-dark(#cce6fa,#244664)}
					[data-line][data-hovered],[data-column-number][data-hovered],[data-gutter-buffer][data-hovered],[data-line-annotation][data-hovered],[data-no-newline][data-hovered],[data-merge-conflict][data-hovered],[data-merge-conflict-actions][data-hovered]{--diffs-computed-hovered-line-bg:var(--diffs-computed-selected-line-bg)}
					[data-code]{overflow-x:auto;overflow-y:hidden}
					@supports not (grid-template-rows:subgrid){
						[data-gutter],[data-content]{display:contents}
						[data-gutter]>*{grid-column:1}
						[data-content]>*{grid-column:2}
						[data-diff-type=split][data-overflow=wrap] [data-additions] [data-gutter]>*{grid-column:3}
						[data-diff-type=split][data-overflow=wrap] [data-additions] [data-content]>*{grid-column:4}
					}
				`, { from: undefined });
				return {
					code: `import { supportsDiffsStyleSheets } from ${helper};\n${code.replace(
						match[0],
						`var style_default = supportsDiffsStyleSheets ? ${match[1]} : ${JSON.stringify(legacy.css)};`,
					)}`,
					map: null,
				};
			}
			if (module === "components/web-components.js") {
				const native = "shadowRoot.adoptedStyleSheets = [sheet];";
				if (!code.includes(native)) throw new Error("Unsupported @pierre/diffs stylesheet adoption");
				code = code.replace("if (sheet == null) {", "if (supportsDiffsStyleSheets) {\nif (sheet == null) {");
				code = code.replace(native, `${native}\n} else { appendDiffsStyle(shadowRoot, style_default); }`);
				return { code: `import { supportsDiffsStyleSheets, appendDiffsStyle } from ${helper};\n${code}`, map: null };
			}
			if (module === "utils/cssWrappers.js") {
				// Theme/unsafe CSS is inserted at runtime, outside the inline CSS build.
				code = code
					.replace("function wrapCoreCSS(mainCSS) {", "function wrapCoreCSS(mainCSS) {\nif (!supportsDiffsStyleSheets) return `${style_default}\\n${mainCSS}`;")
					.replace("function wrapUnsafeCSS(unsafeCSS) {", "function wrapUnsafeCSS(unsafeCSS) {\nif (!supportsDiffsStyleSheets) return unsafeCSS;")
					.replace('function wrapThemeCSS(themeCSS, themeType = "system", scrollbarGutter) {', 'function wrapThemeCSS(themeCSS, themeType = "system", scrollbarGutter) {\nif (!supportsDiffsStyleSheets) return legacyDiffsThemeCSS(themeCSS, themeType, scrollbarGutter);');
				return { code: `import { supportsDiffsStyleSheets, legacyDiffsThemeCSS } from ${helper};\n${code}`, map: null };
			}
			if (["components/File.js", "components/FileDiff.js", "components/CodeView.js", "managers/InteractionManager.js"].includes(module)) {
				const replaced = code.replace(/([\w$]+(?:\.[\w$]+)*)\.replaceChildren\(/g, "replaceDiffsChildren($1, ");
				if (replaced !== code) return { code: `import { replaceDiffsChildren } from ${helper};\n${replaced}`, map: null };
			}
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
		diffsCompatibility(),
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
		pdfJsCMapsPlugin(),
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
	worker: { plugins: () => [copiedFrontendPackages(), firefoxUnicodeRegex(), diffsCompatibility()] },
	build: {
		target: "firefox68",
		cssTarget: "firefox68",
		outDir: path.join(root, "build/webgui"),
		emptyOutDir: true,
	},
});
