import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { YAML } from "bun";

const cli = path.resolve(import.meta.dir, "../src/cli.ts");
async function invoke(root: string, action: "set" | "reset") {
	const args = ["config", action, "temperature", ...(action === "set" ? ["0.7"] : []), "--json"];
	const child = Bun.spawn([process.execPath, cli, ...args], {
		cwd: root,
		env: {
			...process.env,
			OMP_CONFIG_ROOT: path.join(root, "config"),
			OMP_CACHE_DIR: path.join(root, "cache"),
			PI_CODING_AGENT_DIR: path.join(root, "config", "agent"),
			OMP_PROFILE: "",
			PI_PROFILE: "",
			PI_CONFIG_FILES: "",
			OMP_OFFLINE: "",
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
	return { code, stdout, stderr };
}

describe("explicit config CLI revision-safe persistence", () => {
	for (const action of ["set", "reset"] as const) {
		it.each([undefined, "temperature: [broken\n", "temperature: 0.2\ntemperature: 0.4\n"])(
			`${action} refuses missing or unparseable configuration without creating or overwriting it: %s`,
			async source => {
				const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-config-revision-"));
				try {
					const file = path.join(root, "config", "agent", "config.yml");
					await fs.mkdir(path.dirname(file), { recursive: true });
					if (source !== undefined) await fs.writeFile(file, source);
					const result = await invoke(root, action);
					expect(result.code, result.stdout + result.stderr).toBe(1);
					expect(result.stdout).not.toContain('"revision"');
					if (source === undefined) expect(await Bun.file(file).exists()).toBe(false);
					else expect(await fs.readFile(file, "utf8")).toBe(source);
				} finally {
					await fs.rm(root, { recursive: true, force: true });
				}
			},
		);

		it(`${action} preserves unrelated structure and returns the committed revision`, async () => {
			const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-config-revision-"));
			try {
				const file = path.join(root, "config", "agent", "config.yml");
				await fs.mkdir(path.dirname(file), { recursive: true });
				await fs.writeFile(file, "# owner comment\ntemperature: 0.2\ncustom:\n  retained: [one, two]\n");
				const result = await invoke(root, action);
				expect(result.code, result.stderr).toBe(0);
				const payload = JSON.parse(result.stdout);
				expect(payload.key).toBe("temperature");
				expect(typeof payload.revision).toBe("string");
				expect(payload.revision.length).toBeGreaterThan(0);
				const saved = await fs.readFile(file, "utf8");
				expect(saved).toContain("# owner comment");
				expect(YAML.parse(saved)).toEqual({
					...(action === "set" ? { temperature: 0.7 } : {}),
					custom: { retained: ["one", "two"] },
				});
			} finally {
				await fs.rm(root, { recursive: true, force: true });
			}
		});
	}
});
