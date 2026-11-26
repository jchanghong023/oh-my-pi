import { expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils/temp";

const repoRoot = path.join(import.meta.dir, "..");

it("plans the requested fork binaries without changing the output directory", async () => {
	using temp = TempDir.createSync("@omp-release-dry-run-");
	const outputRoot = temp.join("binaries");
	await fs.mkdir(outputRoot);
	const sentinel = path.join(outputRoot, "keep.json");
	await Bun.write(sentinel, '{"userOwned":true}\n');
	const child = Bun.spawn(
		[process.execPath, "scripts/ci-release-build-binaries.ts", "--dry-run", "--targets", "linux-x64,win32-x64"],
		{
			cwd: repoRoot,
			env: { ...process.env, OMP_RELEASE_BINARY_DIR: outputRoot },
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
	expect(
		Array.from(
			stdout.matchAll(/^DRY RUN Bun\.build target=(\S+) outfile=(.+) external=/gm),
			([, target, outfile]) => [target, outfile],
		),
	).toEqual([
		["bun-linux-x64-baseline", path.join(outputRoot, "omp-linux-x64")],
		["bun-windows-x64", path.join(outputRoot, "omp-windows-x64.exe")],
	]);
	expect(await fs.readdir(outputRoot)).toEqual(["keep.json"]);
	expect(await Bun.file(sentinel).text()).toBe('{"userOwned":true}\n');
});
