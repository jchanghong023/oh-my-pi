import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { YAML } from "bun";
import { TempDir } from "@oh-my-pi/pi-utils";

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");
const cliEntry = path.join(repoRoot, "packages", "coding-agent", "src", "cli.ts");

describe("sync-claude", () => {
	let tempDir: TempDir;

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-sync-claude-");
	});

	afterEach(() => {
		tempDir.removeSync();
	});

	it("auto-selects a baseUrl/apiKey-only override of the bundled Anthropic provider", async () => {
		const home = path.join(tempDir.path(), "home");
		const agentDir = path.join(tempDir.path(), "agent");
		await fs.mkdir(path.join(home, ".claude"), { recursive: true });
		await fs.mkdir(agentDir, { recursive: true });
		await fs.writeFile(
			path.join(home, ".claude", "settings.json"),
			JSON.stringify({
				env: {
					ANTHROPIC_BASE_URL: "https://gateway.example.test",
					ANTHROPIC_AUTH_TOKEN: "synced-token",
				},
			}),
		);
		const modelsPath = path.join(agentDir, "models.yml");
		await fs.writeFile(
			modelsPath,
			["providers:", "  anthropic:", '    baseUrl: "https://old.example.test"', '    apiKey: "old-token"', ""].join(
				"\n",
			),
		);

		const env: Record<string, string | undefined> = {
			...process.env,
			HOME: home,
			USERPROFILE: home,
			PI_CODING_AGENT_DIR: agentDir,
		};
		delete env.OMP_PROFILE;
		delete env.PI_PROFILE;
		const child = Bun.spawn([process.execPath, cliEntry, "sync-claude"], {
			cwd: repoRoot,
			env,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [exitCode, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		expect(exitCode, stderr).toBe(0);
		expect(stdout).toContain('provider "anthropic"');

		const updated = YAML.parse(await fs.readFile(modelsPath, "utf8")) as {
			providers: Record<string, { baseUrl: string; apiKey: string }>;
		};
		expect(updated.providers.anthropic).toMatchObject({
			baseUrl: "https://gateway.example.test",
			apiKey: "synced-token",
		});
	});
});
