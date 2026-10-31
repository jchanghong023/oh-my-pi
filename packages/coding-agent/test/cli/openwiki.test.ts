import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";

const cli = path.resolve(import.meta.dir, "../../src/cli.ts");

async function run(root: string, args: string[], env: Record<string, string> = {}) {
	const home = path.join(root, "home");
	await mkdir(home, { recursive: true });
	const proc = Bun.spawn([process.execPath, cli, "openwiki", ...args], {
		cwd: root,
		env: {
			PATH: process.env.PATH,
			SystemRoot: process.env.SystemRoot,
			WINDIR: process.env.WINDIR,
			TMP: process.env.TMP,
			TEMP: process.env.TEMP,
			TMPDIR: process.env.TMPDIR,
			HOME: home,
			USERPROFILE: home,
			OMP_CONFIG_ROOT: path.join(home, "config"),
			OPENWIKI_CONFIG_DIR: path.join(home, "standalone"),
			OMP_OFFLINE: "1",
			NO_COLOR: "1",
			AWS_EC2_METADATA_DISABLED: "true",
			...env,
		},
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [code, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	return { code, stdout, stderr, text: stdout + stderr };
}

describe("omp openwiki command boundary", () => {
	it("loads the selected profile before loading the OpenWiki command", async () => {
		using dir = TempDir.createSync("@omp-openwiki-profile-");
		const home = dir.join("home");
		const config = dir.join("config");
		const defaultAgent = path.join(config, "agent");
		const selectedAgent = path.join(config, "profiles", "fixture", "agent");
		await Promise.all([
			mkdir(home, { recursive: true }),
			mkdir(defaultAgent, { recursive: true }),
			mkdir(selectedAgent, { recursive: true }),
		]);
		await Promise.all([
			writeFile(path.join(defaultAgent, ".env"), "OMP_OPENWIKI_PROFILE_SENTINEL=default\n"),
			writeFile(path.join(selectedAgent, ".env"), "OMP_OPENWIKI_PROFILE_SENTINEL=selected\n"),
		]);
		const probe = dir.join("probe.ts");
		await Bun.write(
			probe,
			[
				`import { runCli } from ${JSON.stringify(new URL("../../src/cli.ts", import.meta.url).href)};`,
				"await runCli(process.argv.slice(2));",
				'process.stdout.write("\\nPROFILE_SENTINEL=" + process.env.OMP_OPENWIKI_PROFILE_SENTINEL + "\\n");',
			].join("\n"),
		);
		for (const args of [
			["--profile", "fixture", "openwiki", "--help"],
			["openwiki", "--profile", "fixture", "--help"],
		]) {
			const child = Bun.spawn([process.execPath, probe, ...args], {
				cwd: dir.path(),
				env: {
					PATH: process.env.PATH,
					SystemRoot: process.env.SystemRoot,
					WINDIR: process.env.WINDIR,
					TMP: process.env.TMP,
					TEMP: process.env.TEMP,
					TMPDIR: process.env.TMPDIR,
					HOME: home,
					USERPROFILE: home,
					OMP_CONFIG_ROOT: config,
					OMP_OFFLINE: "1",
					NO_COLOR: "1",
				},
				stdout: "pipe",
				stderr: "pipe",
			});
			const [code, stdout, stderr] = await Promise.all([
				child.exited,
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
			]);
			expect(code, stderr).toBe(0);
			expect(stdout).toContain("PROFILE_SENTINEL=selected");
		}
	}, 30_000);

	it("shows repository help without starting generation or creating a standalone home", async () => {
		using dir = TempDir.createSync("@omp-openwiki-help-");
		const result = await run(dir.path(), []);
		expect(result.code, result.text).toBe(0);
		expect(result.text.toLowerCase()).toContain("openwiki");
		expect(result.text).toContain("visualize");
		expect(existsSync(dir.join("openwiki"))).toBe(false);
		expect(existsSync(dir.join("home", "standalone"))).toBe(false);
	}, 30_000);

	for (const command of ["search", "read", "personal", "ingest", "mcp", "integrations"]) {
		it(`rejects unsupported ${command} without generating a wiki`, async () => {
			using dir = TempDir.createSync("@omp-openwiki-unsupported-");
			const result = await run(dir.path(), [command]);
			expect(result.code, result.text).not.toBe(0);
			expect(result.text).toMatch(/not supported|unsupported/i);
			expect(existsSync(dir.join("openwiki"))).toBe(false);
			expect(existsSync(dir.join("home", "standalone"))).toBe(false);
		}, 30_000);
	}

	it("rejects mutually exclusive export and server options", async () => {
		using dir = TempDir.createSync("@omp-openwiki-flags-");
		const result = await run(dir.path(), ["visualize", "--export", "out", "--no-open"]);
		expect(result.code, result.text).not.toBe(0);
		expect(result.text).toMatch(/cannot be combined|mutually exclusive/i);
		expect(existsSync(dir.join("out"))).toBe(false);
	}, 30_000);

	it("rejects stale source visualizer resources instead of serving them", async () => {
		using dir = TempDir.createSync("@omp-openwiki-stale-");
		await mkdir(dir.join("openwiki"));
		const result = await run(dir.path(), ["visualize", "openwiki", "--export", "site"], {
			PI_OPENWIKI_VISUAL_ASSETS: JSON.stringify({ _sourceFingerprint: "stale" }),
		});
		expect(result.code, result.text).not.toBe(0);
		expect(result.text).toContain("OpenWiki visualizer assets are stale");
		expect(result.text).toContain("gen:openwiki-resources");
	}, 30_000);

	it("exports real wiki graph and local browser assets without model credentials", async () => {
		using dir = TempDir.createSync("@omp-openwiki-export-");
		await mkdir(dir.join("openwiki"));
		await writeFile(
			dir.join("openwiki", "quickstart.md"),
			"---\ntitle: Quickstart\ntype: Guide\n---\n# Quickstart\n\nSee [Overview](overview.md).\n",
		);
		await writeFile(
			dir.join("openwiki", "overview.md"),
			"---\ntitle: Overview\ntype: Guide\n---\n# Overview\n\nOFFLINE_CONTENT_TOKEN\n",
		);
		const result = await run(dir.path(), ["visualize", "openwiki", "--export", "site/wiki"]);
		expect(result.code, result.text).toBe(0);
		const output = dir.join("site", "wiki");
		const graphText = await readFile(path.join(output, "graph.json"), "utf8");
		const graph = JSON.parse(graphText);
		expect(graph.nodes.map((node: { id: string }) => node.id).sort()).toEqual(["overview", "quickstart"]);
		expect(graph.edges).toContainEqual({ source: "quickstart", target: "overview" });
		expect(graphText).toContain("OFFLINE_CONTENT_TOKEN");
		const html = await readFile(path.join(output, "index.html"), "utf8");
		expect(html).toContain('data-static-export="true"');
		expect(html).toContain("./client.js");
		for (const name of ["index.html", "client.js", "client-lib.js", "styles.css"]) {
			const contents = await readFile(path.join(output, name), "utf8");
			expect(contents.length).toBeGreaterThan(0);
			expect(contents).not.toMatch(/(?:cdn\.jsdelivr\.net|fonts\.googleapis\.com|fonts\.gstatic\.com|unpkg\.com)/i);
		}
		// Serve only the exported directory at a nested static-server path. The
		// CLI has exited, so no embedded visualization service can satisfy it.
		const assets = ["force-graph.js", "marked.js", "purify.js", "mermaid.js"];
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request) {
				const url = new URL(request.url);
				if (!url.pathname.startsWith("/docs/wiki/")) return new Response("not found", { status: 404 });
				const name = url.pathname.slice("/docs/wiki/".length);
				if (!["index.html", "graph.json", "client.js", "client-lib.js", "styles.css", ...assets].includes(name))
					return new Response("not found", { status: 404 });
				return new Response(Bun.file(path.join(output, name)));
			},
		});
		try {
			const base = `http://127.0.0.1:${server.port}/docs/wiki/index.html`;
			for (const name of ["graph.json", "client.js", "client-lib.js", "styles.css", ...assets]) {
				if (assets.includes(name)) expect(html).toContain(`./${name}`);
				const fetched = await fetch(new URL(`./${name}`, base));
				expect(fetched.status).toBe(200);
				expect((await fetched.arrayBuffer()).byteLength).toBeGreaterThan(0);
			}
		} finally {
			server.stop(true);
		}
		expect(existsSync(dir.join("home", "standalone"))).toBe(false);
	}, 30_000);
});
