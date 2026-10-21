import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	containsVersionStamp,
	VERSION_STAMP_MAGIC,
	VERSION_STAMP_SIZE,
} from "../packages/natives/native/version-sentinel.js";
import { ADDON_OUTPUTS, hostTargetName } from "./bazel-natives";
import { detectHostAvx2Support, detectHostMusl } from "./host-detect";
import { nativesPackageVersion } from "./stamp-native-version";

const repoRoot = path.resolve(import.meta.dir, "..");

test("build-only artifact install retains stamping while the default rejects an unloadable host addon", async () => {
	const target = hostTargetName({
		platform: process.platform,
		arch: process.arch,
		avx2: detectHostAvx2Support(),
		musl: detectHostMusl(),
	});
	const filename = ADDON_OUTPUTS[target];
	const temp = await fs.mkdtemp(path.join(os.tmpdir(), "omp-native-probe-"));
	try {
		const source = path.join(temp, "source");
		const sourceDir = path.join(source, `natives-${target}`);
		await fs.mkdir(sourceDir, { recursive: true });
		const invalidImage = Buffer.alloc(VERSION_STAMP_SIZE);
		invalidImage.write(VERSION_STAMP_MAGIC, "latin1");
		await Bun.write(path.join(sourceDir, filename), invalidImage);
		const install = async (dest: string, skip: boolean) => {
			const child = Bun.spawn(
				[
					process.execPath,
					"scripts/bazel-natives.ts",
					target,
					"--source",
					source,
					"--dest",
					dest,
					...(skip ? ["--skip-load-probe"] : []),
				],
				{ cwd: repoRoot, stdout: "pipe", stderr: "pipe" },
			);
			const [exitCode, stdout, stderr] = await Promise.all([
				child.exited,
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
			]);
			return { exitCode, stdout, stderr };
		};
		const skippedDest = path.join(temp, "skipped");
		const skipped = await install(skippedDest, true);
		expect(skipped.exitCode).toBe(0);
		const stamped = new Uint8Array(await Bun.file(path.join(skippedDest, filename)).arrayBuffer());
		expect(containsVersionStamp(stamped, await nativesPackageVersion())).toBe(true);
		const installedPath = path.join(skippedDest, filename);
		const preservedTime = new Date("2000-01-01T00:00:00.000Z");
		await fs.utimes(installedPath, preservedTime, preservedTime);
		const unchanged = await install(skippedDest, true);
		expect(unchanged.exitCode).toBe(0);
		expect((await fs.stat(installedPath)).mtimeMs).toBe(preservedTime.getTime());
		await Bun.write(path.join(sourceDir, filename), Buffer.concat([invalidImage, Buffer.from([0x7f])]));
		const changed = await install(skippedDest, true);
		expect(changed.exitCode).toBe(0);
		expect((await fs.readFile(installedPath)).at(-1)).toBe(0x7f);
		const normal = await install(skippedDest, false);
		expect(normal.exitCode).not.toBe(0);
		expect(normal.stderr).toContain("cannot be loaded on this host");
	} finally {
		await fs.rm(temp, { recursive: true, force: true });
	}
});
