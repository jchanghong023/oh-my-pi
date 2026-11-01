import { describe, expect, it } from "bun:test";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";

const cli = path.resolve(import.meta.dir, "../../src/cli.ts");

async function git(cwd: string, ...args: string[]): Promise<string> {
	const process = Bun.spawn(["git", ...args], {
		cwd,
		env: {
			...globalThis.process.env,
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_CONFIG_GLOBAL: path.join(cwd, ".no-global-gitconfig"),
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const [code, stdout, stderr] = await Promise.all([
		process.exited,
		new Response(process.stdout).text(),
		new Response(process.stderr).text(),
	]);
	if (code !== 0) throw new Error(`git ${args.join(" ")}: ${stderr}`);
	return stdout.trim();
}

async function snapshot(root: string): Promise<Record<string, string>> {
	const files: Record<string, string> = {};
	async function visit(dir: string, relative: string): Promise<void> {
		for (const entry of await readdir(dir, { withFileTypes: true })) {
			const name = relative ? `${relative}/${entry.name}` : entry.name;
			const file = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				files[name] = "directory";
				await visit(file, name);
			} else if (entry.isFile()) {
				files[name] = String(Bun.hash(await Bun.file(file).arrayBuffer()));
			}
		}
	}
	await visit(root, "");
	return files;
}

describe("omp openwiki dry run", () => {
	it("previews init and update without requests or filesystem changes", async () => {
		using dir = TempDir.createSync("@omp-openwiki-preview-");
		const root = dir.join("repo");
		const home = dir.join("home");
		const config = dir.join("config");
		const agent = path.join(config, "profiles", "fixture", "agent");
		await Promise.all(
			[root, home, agent, path.join(root, "src"), path.join(root, "openwiki")].map(directory =>
				mkdir(directory, { recursive: true }),
			),
		);
		await git(root, "init", "--quiet");
		await git(root, "config", "user.name", "Fixture");
		await git(root, "config", "user.email", "fixture@example.invalid");
		await Promise.all([
			writeFile(path.join(root, "README.md"), "# Fixture\n"),
			writeFile(path.join(root, "src", "app.ts"), "export const version = 1;\n"),
			writeFile(path.join(root, "secret.txt"), "not for planning\n"),
			writeFile(path.join(root, ".openwikiignore"), "secret.txt\n"),
			writeFile(
				path.join(root, "openwiki", "guide.md"),
				"---\ntitle: Guide\ntype: Guide\n---\n# Guide\nExisting wiki.\n",
			),
			writeFile(path.join(agent, "config.yml"), "modelRoles:\n  default: fixture/fixture-model\n"),
		]);
		await git(root, "add", ".");
		await git(root, "commit", "--quiet", "-m", "fixture");
		const baseline = await git(root, "rev-parse", "HEAD");
		await writeFile(
			path.join(root, "openwiki", ".last-update.json"),
			JSON.stringify({
				updatedAt: "2026-01-01T00:00:00Z",
				command: "init",
				model: "fixture/fixture-model",
				status: "complete",
				gitHead: baseline,
			}),
		);
		await writeFile(
			path.join(root, "openwiki", ".page-manifest.json"),
			JSON.stringify({
				schemaVersion: 1,
				pages: { "/openwiki/guide.md": { gitHead: baseline, pageVersion: `sha256:${"0".repeat(64)}` } },
			}),
		);
		await writeFile(path.join(root, "README.md"), "# Fixture\nUpdated.\n");
		await writeFile(path.join(root, "src", "new.ts"), "export const added = true;\n");

		let requests = 0;
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch() {
				requests++;
				return new Response("unexpected request", { status: 500 });
			},
		});
		try {
			await writeFile(
				path.join(agent, "models.yml"),
				Bun.YAML.stringify({
					providers: {
						fixture: {
							baseUrl: `http://127.0.0.1:${server.port}/v1`,
							api: "openai-completions",
							auth: "none",
							models: [
								{
									id: "fixture-model",
									name: "Fixture",
									reasoning: false,
									input: ["text"],
									contextWindow: 100000,
									maxTokens: 4096,
								},
							],
						},
					},
				}),
			);
			const env = {
				PATH: process.env.PATH,
				SystemRoot: process.env.SystemRoot,
				WINDIR: process.env.WINDIR,
				TMP: home,
				TEMP: home,
				TMPDIR: home,
				HOME: home,
				USERPROFILE: home,
				OMP_CONFIG_ROOT: config,
				OMP_OFFLINE: "1",
				NO_COLOR: "1",
				BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
				AWS_EC2_METADATA_DISABLED: "true",
			};
			for (const [args, model, plannerModel = model, planRole] of [
				[["code", "--init", "--dry-run", "--telemetry-file", "nested/telemetry.json"], "fixture/fixture-model"],
				[
					["--update", "--dry-run", "--modelId", "fixture/override"],
					"fixture/override",
					undefined,
					"fixture/role-model",
				],
				[
					["--init", "--dry-run", "--planner-model", "fixture/planner"],
					"fixture/fixture-model",
					"fixture/planner",
					"fixture/role-model",
				],
				[
					["--update", "--dry-run", "--model-id=fixture/page", "--planner-model=fixture/planner"],
					"fixture/page",
					"fixture/planner",
				],
				[["--init", "--dry-run"], "fixture/fixture-model", "@plan", "fixture/planner"],
			] satisfies [string[], string, string?, string?][]) {
				const modelRoles: Record<string, string> = { default: "fixture/fixture-model" };
				if (planRole !== undefined) modelRoles.plan = planRole;
				await writeFile(path.join(agent, "config.yml"), Bun.YAML.stringify({ modelRoles }));
				const before = await snapshot(dir.path());
				const child = Bun.spawn([process.execPath, cli, "--profile", "fixture", "openwiki", ...args], {
					cwd: root,
					env,
					stdin: "ignore",
					stdout: "pipe",
					stderr: "pipe",
				});
				const [code, stdout, stderr] = await Promise.all([
					child.exited,
					new Response(child.stdout).text(),
					new Response(child.stderr).text(),
				]);
				expect(code, stdout + stderr).toBe(0);
				expect(stdout.match(/^Page model selection \([^)]+\): (.*)$/m)?.[1]).toBe(model);
				expect(stdout.match(/^Planner model selection \([^)]+\): (.*)$/m)?.[1]).toBe(plannerModel);
				expect(stdout).toContain("README.md");
				expect(stdout).toContain("src/new.ts");
				expect(stdout).not.toContain("secret.txt");
				expect(stdout).toContain("openwiki");
				if (args.includes("--update")) {
					const changes = stdout
						.split("Changed paths since completed run")[1]
						?.split("Changed paths across page baselines")[0];
					expect(changes).toContain("README.md");
					expect(changes).toContain("src/new.ts");
				}
				expect(await snapshot(dir.path())).toEqual(before);
			}
			const before = await snapshot(dir.path());
			for (const args of [
				["--dry-run", "link"],
				["--init", "--update", "--dry-run"],
				["--init", "--dry-run", "--planner-model"],
				["--init", "--dry-run", "--planner-model="],
			]) {
				const child = Bun.spawn([process.execPath, cli, "--profile", "fixture", "openwiki", ...args], {
					cwd: root,
					env,
					stdin: "ignore",
					stdout: "pipe",
					stderr: "pipe",
				});
				const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
				expect(code, stderr).not.toBe(0);
				expect(await snapshot(dir.path())).toEqual(before);
			}
			expect(requests).toBe(0);
		} finally {
			server.stop(true);
		}
	}, 30_000);
});
