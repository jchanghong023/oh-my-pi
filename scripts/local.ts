#!/usr/bin/env bun

import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");

async function run(command: string[], env: NodeJS.ProcessEnv): Promise<void> {
	const child = Bun.spawn(command, { cwd: repoRoot, env, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
	const code = await child.exited;
	if (code !== 0) throw new Error(`${command[0]} failed with exit code ${code}`);
}

async function checkExistingTarget(target: string): Promise<void> {
	let stat: Stats;
	try {
		stat = await fs.lstat(target);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Refusing to replace a non-regular file: ${target}`);
}

async function main(): Promise<void> {
	if (process.platform !== "win32") throw new Error("Local installation is supported only on Windows.");
	const installDir =
		process.env.PI_INSTALL_DIR || (process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "omp"));
	if (!installDir) throw new Error("Set PI_INSTALL_DIR or LOCALAPPDATA to choose an install directory.");
	const target = path.resolve(installDir, "omp.exe");
	const candidate = path.join(path.dirname(target), `.omp.local.${randomUUID()}.exe`);
	let candidateCreated = false;
	try {
		await checkExistingTarget(target);

		const output = path.join(repoRoot, "packages", "coding-agent", "dist", "omp.exe");
		if (target.toLowerCase() === output.toLowerCase()) {
			throw new Error(`Install target must not be the build output: ${target}`);
		}
		// A junction or hard link can make distinct paths refer to the same file.
		try {
			const [targetReal, outputReal, targetStat, outputStat] = await Promise.all([
				fs.realpath(target),
				fs.realpath(output),
				fs.stat(target),
				fs.stat(output),
			]);
			if (
				targetReal.toLowerCase() === outputReal.toLowerCase() ||
				(targetStat.ino !== 0 && targetStat.dev === outputStat.dev && targetStat.ino === outputStat.ino)
			) {
				throw new Error(`Install target must not be the build output: ${target}`);
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		const buildEnv: NodeJS.ProcessEnv = { ...process.env };
		delete buildEnv.CROSS_TARGET;
		delete buildEnv.BUN_COMPILE_EXECUTABLE_PATH;
		console.log("Building the native addon and local executable...");
		await run(
			[
				process.execPath,
				"scripts/bazel-natives.ts",
				"host",
				"--dest",
				"packages/natives/native",
				"--skip-load-probe",
			],
			buildEnv,
		);
		await run([process.execPath, "packages/coding-agent/scripts/build-binary.ts"], buildEnv);

		await fs.mkdir(path.dirname(target), { recursive: true });
		await fs.copyFile(output, candidate, constants.COPYFILE_EXCL);
		candidateCreated = true;
		await checkExistingTarget(target);
		// Move the running image aside without stopping existing omp processes.
		const previous = path.join(path.dirname(target), `.omp.old.${randomUUID()}.exe`);
		let renamedAside = false;
		try {
			await fs.rename(target, previous);
			renamedAside = true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		try {
			await fs.rename(candidate, target);
		} catch (error) {
			if (renamedAside) {
				try {
					await fs.rename(previous, target);
				} catch (rollbackError) {
					candidateCreated = false;
					throw new Error(
						`Failed to install ${target} and restore the previous executable: ${rollbackError}. Recovery files retained at ${previous} and ${candidate}.`,
						{ cause: error },
					);
				}
			}
			throw error;
		}
		candidateCreated = false;
		if (renamedAside) {
			await fs
				.unlink(previous)
				.catch(error => console.warn(`Could not remove previous executable ${previous}: ${error}`));
		}
		console.log(`Installed omp to ${target}`);
	} finally {
		if (candidateCreated) {
			await fs.unlink(candidate).catch(error => console.warn(`Could not remove candidate ${candidate}: ${error}`));
		}
	}
}

await main();
