import * as fs from "node:fs";
import * as path from "node:path";
import { defineConfig, type Plugin } from "vite";
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

export default defineConfig({
	root: import.meta.dirname,
	base: "/",
	publicDir: path.join(packages, "web/public"),
	plugins: [
		copiedFrontendPackages(),
		react(),
		tailwindcss(),
		pdfJsCMapsPlugin(),
	],
	resolve: {
		alias: {
			"@zcode/ui/styles.css": path.join(packages, "ui/src/styles.css"),
			"@": path.join(packages, "ui/src"),
		},
		dedupe: ["react", "react-dom"],
	},
	optimizeDeps: {
		rolldownOptions: {
			output: {
				// 合并稳定图标依赖，避免开发模式逐图标发起请求；不预打包业务源码。
				codeSplitting: { groups: [{ name: "lucide-icons", test: /node_modules[\\/]lucide-react[\\/]/ }] },
			},
		},
	},
	define: {
		__ZCODE_VERSION__: JSON.stringify("3.17.2"),
		__ZCODE_ENV__: JSON.stringify("production"),
		__ZCODE_AUTO_UPDATE_ENABLED__: "false",
	},
	worker: { format: "es", plugins: () => [copiedFrontendPackages()] },
	build: {
		target: "firefox128",
		cssTarget: "firefox128",
		outDir: path.join(root, "build/webgui"),
		emptyOutDir: true,
	},
});
