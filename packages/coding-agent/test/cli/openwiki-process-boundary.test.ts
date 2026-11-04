import { describe, expect, it } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("OMP OpenWiki same-repository process boundary", () => {
	// Both actual commands reach planning concurrently. This checks the absence of
	// a new host mutex, not successful concurrent writes or a cross-process guarantee.
	it("does not serialize distinct OMP processes behind an added repository lock", async () => {
		using dir = TempDir.createSync("@omp-openwiki-process-boundary-");
		const root = dir.join("repo");
		const agent = dir.join("config", "agent");
		await Promise.all([mkdir(root), mkdir(agent, { recursive: true })]);
		const env = {
			PATH: process.env.PATH,
			SystemRoot: process.env.SystemRoot,
			HOME: dir.path(),
			USERPROFILE: dir.path(),
			OMP_CONFIG_ROOT: dir.join("config"),
			OMP_OFFLINE: "1",
			NO_COLOR: "1",
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_CONFIG_GLOBAL: dir.join("empty-gitconfig"),
		};
		const git = Bun.spawn(["git", "init", "--quiet"], { cwd: root, env, stdout: "pipe", stderr: "pipe" });
		const [gitCode, gitError] = await Promise.all([git.exited, new Response(git.stderr).text()]);
		expect(gitCode, gitError).toBe(0);
		await writeFile(path.join(root, "README.md"), "# Shared repository\n");
		const firstPlanning = Promise.withResolvers<void>();
		const secondPlanning = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let planningRequests = 0;
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				if (new URL(request.url).pathname.endsWith("/models"))
					return Response.json({ data: [{ id: "fixture-model" }] });
				const body = (await request.json()) as { tools?: Array<{ function?: { name: string } }> };
				if (body.tools?.some(tool => tool.function?.name === "submit_plan")) {
					planningRequests++;
					if (planningRequests === 1) firstPlanning.resolve();
					if (planningRequests === 2) secondPlanning.resolve();
				}
				await release.promise;
				return new Response("stopped by process-boundary fixture", { status: 500 });
			},
		});
		const children: Bun.Subprocess<"ignore", "pipe", "pipe">[] = [];
		const outputs: Promise<string>[] = [];
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await writeFile(
				path.join(agent, "models.yml"),
				Bun.YAML.stringify({
					providers: {
						deepseek: {
							api: "openai-completions",
							auth: "none",
							baseUrl: `http://127.0.0.1:${server.port}/v1`,
							models: [
								{
									id: "fixture-model",
									name: "Fixture",
									reasoning: false,
									supportsTools: true,
									input: ["text"],
									contextWindow: 100000,
									maxTokens: 4096,
								},
							],
						},
					},
				}),
			);
			await writeFile(
				path.join(agent, "config.yml"),
				"modelRoles:\n  default: deepseek/fixture-model\nstartup:\n  setupWizard: false\n",
			);
			const deadline = new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error("Both OMP processes did not reach planning")), 20_000);
			});
			function launch() {
				const child = Bun.spawn(
					[process.execPath, path.resolve(import.meta.dir, "../../src/cli.ts"), "openwiki", "--init", "--print"],
					{
						cwd: root,
						env,
						stdin: "ignore",
						stdout: "pipe",
						stderr: "pipe",
					},
				);
				children.push(child);
				const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]).then(
					parts => parts.join("\n"),
				);
				outputs.push(output);
				return child.exited.then(async code => {
					throw new Error(`OMP exited before planning barrier (${code}): ${await output}`);
				});
			}
			const firstExited = launch();
			await Promise.race([firstPlanning.promise, firstExited, deadline]);
			const secondExited = launch();
			await Promise.race([secondPlanning.promise, firstExited, secondExited, deadline]);
			expect(planningRequests).toBe(2);
		} finally {
			clearTimeout(timer);
			for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
			release.resolve();
			await Promise.all(children.map(child => child.exited));
			await Promise.all(outputs);
			server.stop(true);
		}
	}, 30_000);
});
