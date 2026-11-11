import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils/temp";
import { $ } from "bun";

const repoRoot = path.join(import.meta.dir, "..");

describe("release binary dry run", () => {
	it("plans selected targets without changing existing binaries during a dry run", async () => {
		using temp = TempDir.createSync("@omp-release-dry-run-");
		const outputRoot = temp.join("binaries");
		await fs.mkdir(outputRoot);
		const sentinel = path.join(outputRoot, "keep.json");
		await Bun.write(sentinel, '{"userOwned":true}\n');
		const child = Bun.spawn(
			[process.execPath, "scripts/ci-release-build-binaries.ts", "--dry-run", "--targets", "linux-x64,win32-x64"],
			{
				cwd: repoRoot,
				env: {
					...process.env,
					OMP_RELEASE_BINARY_DIR: outputRoot,
				},
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const [code, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		expect(code, stderr).toBe(0);
		expect(stdout).toContain("DRY RUN Bun.build target=bun-linux-x64-baseline");
		expect(stdout).toContain("DRY RUN Bun.build target=bun-windows-x64");
		expect(await fs.readdir(outputRoot)).toEqual(["keep.json"]);
		expect(await Bun.file(sentinel).text()).toBe('{"userOwned":true}\n');
	});
});

describe("Windows release binary target", () => {
	it("builds the supported Windows x64 asset with its native runtime", async () => {
		const result = await $`bun scripts/ci-release-build-binaries.ts --dry-run --targets win32-x64`
			.cwd(repoRoot)
			.quiet()
			.nothrow();
		expect(result.exitCode).toBe(0);
		const output = result.text();
		expect(output).toContain("DRY RUN bun --cwd=packages/collab-web run gen:export-viewer --check");

		const buildPlans = Array.from(output.matchAll(/^DRY RUN Bun\.build (.+)$/gm), match =>
			Object.fromEntries(
				(match[1] ?? "").split(/\s+/).map((field): [string, string] => {
					const [key = "", value = ""] = field.split("=", 2);
					return [key, value];
				}),
			),
		);
		expect(buildPlans).toHaveLength(1);
		expect(buildPlans.map(build => ({ target: build.target, outfile: build.outfile }))).toEqual(
			expect.arrayContaining([
				{
					target: "bun-windows-x64",
					outfile: "packages/coding-agent/binaries/omp-windows-x64.exe",
				},
			]),
		);
		for (const build of buildPlans) {
			const external = new Set((build.external ?? "").split(","));
			expect(external.has("fastembed")).toBe(true);
			expect(external.has("onnxruntime-node")).toBe(true);
		}
		expect(output).not.toContain("bun-windows-x64-modern");
	});
});
