import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { VERSION } from "@oh-my-pi/pi-utils";
import { parseHTML } from "@oh-my-pi/pi-utils/dom";
import type { BunPlugin } from "bun";
import { getTemplate } from "../src/export/html/index";
import viewerAsset from "../src/export/html/viewer.generated.json" with { type: "json" };

const probePath = path.resolve(import.meta.dir, "fixtures", "html-export-template-probe.ts");
const packageDir = path.resolve(import.meta.dir, "..");
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-html-template-"));
const unrelatedCwd = path.join(tempRoot, "unrelated-cwd");
const bundleDir = path.join(tempRoot, "bundle");
const compiledPath = path.join(
	tempRoot,
	process.platform === "win32" ? "compiled-template-probe.exe" : "compiled-template-probe",
);
const compiledVersion = "19.0.1+fork.1";
let bundlePath: string;
const dependencyStubs: Record<string, string> = {
	"@oh-my-pi/omp-stats/trace":
		'export const buildSessionTraceFromSnapshots = () => { throw new Error("Trace assembly is outside the template probe"); };',
	"@oh-my-pi/pi-utils": `export const APP_NAME = "omp"; export const VERSION = process.env.PI_BUILD_VERSION ?? ${JSON.stringify(VERSION)}; export const isEnoent = err => err?.code === "ENOENT"; export const isCompiledBinary = () => Boolean(process.env.PI_COMPILED);`,
	"../../ui/theme/service":
		"export const getResolvedThemeColors = async () => ({}); export const getThemeExportColors = async () => ({});",
	"../../session/sub-sessions": "export const collectSubSessions = async () => ({});",
	"../../session/session-manager":
		"export class SessionManager { static async open() { return new SessionManager(); } }",
};
const focusedBundlePlugin: BunPlugin = {
	name: "html-template-focused-bundle",
	setup(build) {
		build.onResolve({ filter: /.*/ }, args =>
			dependencyStubs[args.path] === undefined ? undefined : { path: args.path, namespace: "template-probe-stub" },
		);
		build.onLoad({ filter: /.*/, namespace: "template-probe-stub" }, args => ({
			contents: dependencyStubs[args.path]!,
			loader: "js",
		}));
	},
};

async function runProbe(command: string[]): Promise<string> {
	const proc = Bun.spawn(command, { cwd: unrelatedCwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	expect(exitCode, stderr).toBe(0);
	return stdout;
}

beforeAll(async () => {
	await fs.mkdir(unrelatedCwd);
	const bundle = await Bun.build({
		entrypoints: [probePath],
		outdir: bundleDir,
		target: "bun",
		plugins: [focusedBundlePlugin],
		define: { "process.env.PI_BUNDLED": '"true"' },
	});
	if (!bundle.success) throw new AggregateError(bundle.logs, "Template probe bundle failed");
	const entrypoint = bundle.outputs.find(output => output.kind === "entry-point");
	if (!entrypoint) throw new Error("Template probe emitted no entry point");
	bundlePath = entrypoint.path;
	const compiled = await Bun.build({
		entrypoints: [probePath],
		target: "bun",
		plugins: [focusedBundlePlugin],
		define: {
			"process.env.PI_COMPILED": '"true"',
			"process.env.PI_BUILD_VERSION": JSON.stringify(compiledVersion),
		},
		compile: { outfile: compiledPath },
	});
	if (!compiled.success) throw new AggregateError(compiled.logs, "Compiled template probe failed");
}, 120_000);

afterAll(async () => {
	await fs.rm(tempRoot, { recursive: true, force: true });
});

describe("HTML export template", () => {
	test("source exports inline the viewer but load both shared libraries", async () => {
		const html = getTemplate();
		const { document } = parseHTML(html);
		const scripts = document.querySelectorAll("script[src]");
		expect(scripts).toHaveLength(2);
		expect(scripts[0]!.getAttribute("src")).toStartWith("https://stencil.so/assets/omp/marked.");
		expect(scripts[1]!.getAttribute("src")).toStartWith("https://stencil.so/assets/omp/highlight.");
		expect(html).toBe(await runProbe([process.execPath, probePath]));
	});

	test("source exports explain how to generate a missing development viewer", async () => {
		const checkoutDir = path.join(tempRoot, "checkout", "packages", "coding-agent", "src", "export", "html");
		await Bun.write(path.join(checkoutDir, "shell.html"), "checkout marker");
		const bundle = await Bun.build({
			entrypoints: [probePath],
			outdir: checkoutDir,
			target: "bun",
			plugins: [focusedBundlePlugin],
		});
		if (!bundle.success) throw new AggregateError(bundle.logs, "Development probe bundle failed");
		const entrypoint = bundle.outputs.find(output => output.kind === "entry-point");
		if (!entrypoint) throw new Error("Development probe emitted no entry point");
		const proc = Bun.spawn([process.execPath, entrypoint.path], {
			cwd: unrelatedCwd,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
		expect(exitCode).not.toBe(0);
		// Bun also prints the throwing source line, so read only the reported error.
		const reported = stderr.split("\n").find(line => line.startsWith("error: Development export viewer not found:"));
		const missingViewer = path.join(
			tempRoot,
			"checkout",
			"packages",
			"coding-agent",
			"export-assets",
			viewerAsset.file,
		);
		expect(reported).toContain(missingViewer);
		expect(reported).toContain("Run bun gen:export-viewer");
		expect(reported).toContain("packages/collab-web/scripts/build-export-viewer.ts");
	});

	test("packaged exports load the version-pinned viewer after both integrity-checked shared libraries", async () => {
		const html = await runProbe([process.execPath, bundlePath]);
		const { document } = parseHTML(html);
		const scripts = document.querySelectorAll("script[src]");
		expect(Buffer.byteLength(html)).toBeLessThan(3072);
		expect(scripts).toHaveLength(3);
		for (const [index, name] of ["marked", "highlight"].entries()) {
			const script = scripts[index]!;
			const url = new URL(script.getAttribute("src")!);
			expect(url.origin).toBe("https://stencil.so");
			const match = new RegExp(`^/assets/omp/${name}\\.([a-f0-9]{8})\\.js$`).exec(url.pathname);
			expect(match).not.toBeNull();
			const integrity = script.getAttribute("integrity");
			expect(integrity).toMatch(/^sha256-[A-Za-z0-9+/]{43}=$/);
			expect(Buffer.from(integrity!.slice("sha256-".length), "base64").toHex()).toStartWith(match![1]!);
		}
		const viewer = scripts[2]!;
		const viewerUrl = new URL(viewer.getAttribute("src")!);
		expect(viewerUrl.origin).toBe("https://build.stencil.so");
		expect(viewerUrl.pathname).toMatch(/^\/web\/omp\/\d+\.\d+\.\d+\/export-viewer-[a-f0-9]{64}\.js$/);
		expect(viewer.getAttribute("integrity")).toMatch(/^sha256-[A-Za-z0-9+/]{43}=$/);
		for (const script of scripts) {
			expect(script.getAttribute("crossorigin")).toBe("anonymous");
			expect(script.hasAttribute("defer")).toBe(true);
			expect(script.getAttribute("onerror")).toContain("Could not load the session viewer");
		}
	});

	test("compiled exports use the same hosted viewer as npm exports despite the fork build version", async () => {
		const npmHtml = await runProbe([process.execPath, bundlePath]);
		const compiledHtml = await runProbe([compiledPath]);
		const npmViewer = parseHTML(npmHtml).document.querySelectorAll("script[src]")[2]!;
		const compiledViewer = parseHTML(compiledHtml).document.querySelectorAll("script[src]")[2]!;
		expect(compiledViewer.getAttribute("src")).toBe(npmViewer.getAttribute("src"));
		expect(compiledViewer.getAttribute("integrity")).toBe(npmViewer.getAttribute("integrity"));
		expect(await fs.readdir(bundleDir)).toEqual([path.basename(bundlePath)]);
	});

	test("npm packages keep the tiny loader and metadata but omit hosted viewer source assets", async () => {
		const repoRoot = path.resolve(packageDir, "../..");
		const packWorkspace = path.join(tempRoot, "pack-workspace");
		const packageRel = path.relative(repoRoot, packageDir).split(path.sep).join("/");
		const rootManifest = await Bun.file(path.join(repoRoot, "package.json")).json();
		rootManifest.workspaces = { packages: [packageRel], catalog: rootManifest.workspaces.catalog };
		await Bun.write(path.join(packWorkspace, "package.json"), JSON.stringify(rootManifest));
		await Bun.write(path.join(packWorkspace, "bun.lock"), Bun.file(path.join(repoRoot, "bun.lock")));
		const packDir = path.join(packWorkspace, packageRel);
		await Bun.write(path.join(packDir, "package.json"), Bun.file(path.join(packageDir, "package.json")));
		// Use the focused loader bundle, not a full release build.
		await Bun.write(path.join(packDir, "dist", "cli.js"), Bun.file(bundlePath));
		for (const name of ["template-stale.css", "tool-views.generated.js", "marked.min.js", "highlight.min.js"]) {
			await Bun.write(path.join(packDir, "dist", name), "excluded hosted viewer sidecar");
		}
		const hostedAssets = ["shell.html", "template.css", "template.js", "share-loader.js"];
		for (const name of ["template.html.txt", "viewer.generated.json", ...hostedAssets]) {
			const relative = path.join("src/export/html", name);
			await Bun.write(path.join(packDir, relative), Bun.file(path.join(packageDir, relative)));
		}
		const pack = Bun.spawn([process.execPath, "pm", "pack", "--dry-run", "--ignore-scripts"], {
			cwd: packDir,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		const [packOut, packErr, packExit] = await Promise.all([
			new Response(pack.stdout).text(),
			new Response(pack.stderr).text(),
			pack.exited,
		]);
		expect(packExit, packErr).toBe(0);
		const packed = Array.from(packOut.matchAll(/^packed \S+ (.+)$/gm), match => match[1]);
		expect(packed).toContain("dist/cli.js");
		expect(packed).toContain("src/export/html/template.html.txt");
		expect(packed).toContain("src/export/html/viewer.generated.json");
		for (const name of hostedAssets) {
			expect(packed).not.toContain(`src/export/html/${name}`);
		}
		expect(packed.filter(file => /^dist\/(template-|tool-views\.|marked\.|highlight\.)/.test(file))).toEqual([]);
	}, 60_000);
});
