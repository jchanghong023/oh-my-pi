import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");
const preload = path.join(import.meta.dir, "fixtures/native-install-fault-preload.ts");
const filename = "pi_natives.win32-x64-baseline.node";

describe("native artifact install recovery through the real CLI", () => {
	for (const mode of ["success", "cleanup-locked", "swap-failed", "rollback-failed"] as const) {
		it(`preserves native replacement invariants when ${mode}`, async () => {
			const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-native-recovery-"));
			try {
				const source = path.join(root, "source");
				const sourceDir = path.join(source, "natives-win32-x64-baseline");
				const dest = path.join(root, "installed");
				const target = path.join(dest, filename);
				const trace = path.join(root, "operations.log");
				await fs.mkdir(sourceDir, { recursive: true });
				await fs.mkdir(dest);
				await fs.writeFile(path.join(sourceDir, filename), "new native artifact");
				await fs.writeFile(target, "previous native artifact");
				const child = Bun.spawn(
					[
						process.execPath,
						"--preload",
						preload,
						"scripts/bazel-natives.ts",
						"win32-x64-baseline",
						"--source",
						source,
						"--dest",
						dest,
						"--skip-load-probe",
					],
					{
						cwd: repoRoot,
						env: {
							...process.env,
							OMP_NATIVE_TEST_TARGET: target,
							OMP_NATIVE_TEST_MODE: mode,
							OMP_NATIVE_TEST_TRACE: trace,
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
				const aside = `${target}.old.${child.pid}`;
				const temporary = `${target}.tmp.${child.pid}`;
				const operations = await fs.readFile(trace, "utf8");
				expect(operations).toContain(`rename ${target} -> ${aside}`);
				if (mode === "success" || mode === "cleanup-locked") {
					expect(code, stderr).toBe(0);
					expect(await fs.readFile(target, "utf8")).toBe("new native artifact");
					expect(operations).toContain(`unlink ${aside}`);
					expect(await Bun.file(aside).exists()).toBe(mode === "cleanup-locked");
					if (mode === "cleanup-locked") expect(await fs.readFile(aside, "utf8")).toBe("previous native artifact");
					expect(await Bun.file(temporary).exists()).toBe(false);
				} else {
					expect(code, stdout).not.toBe(0);
					expect(operations).toContain(`rename ${aside} -> ${target}`);
					if (mode === "swap-failed") {
						expect(await fs.readFile(target, "utf8")).toBe("previous native artifact");
						expect(await Bun.file(aside).exists()).toBe(false);
					} else {
						expect(await Bun.file(target).exists()).toBe(false);
						expect(await fs.readFile(aside, "utf8")).toBe("previous native artifact");
						expect(await fs.readFile(temporary, "utf8")).toBe("new native artifact");
						expect(stderr).toContain(aside);
						expect(stderr).toContain(temporary);
					}
				}
			} finally {
				await fs.rm(root, { recursive: true, force: true });
			}
		});
	}

	it("installs changed bytes even when size and timestamp match the target", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-native-bytes-"));
		try {
			const source = path.join(root, "source");
			const sourceDir = path.join(source, "natives-win32-x64-baseline");
			const dest = path.join(root, "installed");
			await fs.mkdir(sourceDir, { recursive: true });
			await fs.mkdir(dest);
			const candidate = path.join(sourceDir, filename);
			const target = path.join(dest, filename);
			await fs.writeFile(candidate, "new native bytes");
			await fs.writeFile(target, "old native bytes");
			const oldTime = new Date("2000-01-01T00:00:00Z");
			await fs.utimes(candidate, oldTime, oldTime);
			await fs.utimes(target, oldTime, oldTime);
			if (process.platform !== "win32") {
				await fs.chmod(candidate, 0o444);
				await fs.chmod(target, 0o444);
			}
			const child = Bun.spawn(
				[
					process.execPath,
					"scripts/bazel-natives.ts",
					"win32-x64-baseline",
					"--source",
					source,
					"--dest",
					dest,
					"--skip-load-probe",
				],
				{ cwd: repoRoot, stdout: "pipe", stderr: "pipe" },
			);
			const [code, stderr] = await Promise.all([
				child.exited,
				new Response(child.stderr).text(),
				new Response(child.stdout).text(),
			]);
			expect(code, stderr).toBe(0);
			expect(await fs.readFile(target, "utf8")).toBe("new native bytes");
			if (process.platform !== "win32") expect((await fs.stat(target)).mode & 0o777).toBe(0o644);
			expect((await fs.readdir(dest)).filter(name => name.includes(".tmp.") || name.includes(".old."))).toEqual([]);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});
