#!/usr/bin/env bun

import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");

async function run(command: string[], env: NodeJS.ProcessEnv): Promise<void> {
	const child = Bun.spawn(command, { cwd: repoRoot, env, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
	const code = await child.exited;
	if (code !== 0) throw new Error(`${command[0]} failed with exit code ${code}`);
}

async function probeVersion(executable: string, env: NodeJS.ProcessEnv): Promise<void> {
	const child = Bun.spawn([executable, "--version"], { cwd: repoRoot, env, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (code !== 0 || !/^omp\/\S+/m.test(stdout)) {
		throw new Error(`Not a working omp executable: ${executable} (exit ${code})${stderr ? `\n${stderr.trim()}` : ""}`);
	}
}

async function checkExistingTarget(target: string, env: NodeJS.ProcessEnv): Promise<void> {
	let stat: Stats;
	try {
		stat = await fs.lstat(target);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Refusing to replace a non-regular file: ${target}`);
	await probeVersion(target, env);
}

async function main(): Promise<void> {
	if (process.platform !== "win32") throw new Error("Local installation is supported only on Windows.");
	const installDir = process.env.PI_INSTALL_DIR || (process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "omp"));
	if (!installDir) throw new Error("Set PI_INSTALL_DIR or LOCALAPPDATA to choose an install directory.");
	const target = path.resolve(installDir, "omp.exe");
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-local-"));
	const runtimeDir = path.join(tempDir, "runtime");
	const candidate = path.join(path.dirname(target), `.omp.local.${randomUUID()}.exe`);
	let candidateCreated = false;
	try {
		await fs.mkdir(runtimeDir, { recursive: true });
		const probeEnv: NodeJS.ProcessEnv = {
			...process.env,
			HOME: runtimeDir,
			USERPROFILE: runtimeDir,
			LOCALAPPDATA: path.join(runtimeDir, "local"),
			APPDATA: path.join(runtimeDir, "roaming"),
			XDG_DATA_HOME: path.join(runtimeDir, "data"),
			XDG_CACHE_HOME: path.join(runtimeDir, "cache"),
			OMP_CONFIG_ROOT: path.join(runtimeDir, "config"),
			OMP_CACHE_DIR: path.join(runtimeDir, "omp-cache"),
			OMP_PROFILE: "",
			PI_PROFILE: "",
			PI_CONFIG_DIR: "",
		};
		await checkExistingTarget(target, probeEnv);

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
		delete buildEnv.ZCODE_ARTIFACT_ROOT;
		console.log("Building the native addon and local executable...");
		await run([process.execPath, "run", "build:native"], buildEnv);
		await run([process.execPath, "packages/coding-agent/scripts/build-binary.ts"], buildEnv);

		await fs.mkdir(path.dirname(target), { recursive: true });
		await fs.copyFile(output, candidate, constants.COPYFILE_EXCL);
		candidateCreated = true;
		console.log("Validating the candidate executable...");
		await probeVersion(candidate, probeEnv);
		await run([candidate, "--smoke-test"], probeEnv);
		await checkExistingTarget(target, probeEnv);
		// On Windows rename replaces the destination in one operation, or fails
		// without first moving the old executable. In-use files may block it.
		await fs.rename(candidate, target);
		candidateCreated = false;
		console.log(`Installed omp to ${target}`);
	} finally {
		if (candidateCreated) {
			await fs.unlink(candidate).catch(error => console.warn(`Could not remove candidate ${candidate}: ${error}`));
		}
		await fs.rm(tempDir, { recursive: true, force: true }).catch(error => {
			console.warn(`Could not remove temporary build directory ${tempDir}: ${error}`);
		});
	}
}

await main();
