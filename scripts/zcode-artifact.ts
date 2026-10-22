import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";

export const ZCODE_PROTOCOL_BASELINE = "c7c190724f3a00a2de998a0a5511201d5a2ba1a0";

export interface ArtifactSource {
	readonly repoRoot: string;
	readonly commit: string;
}

export interface ZCodeArtifactInput {
	readonly target: string;
	/** Final executable bytes, including the native addon embedded by compileCodingAgent. */
	readonly executable: string;
}

async function git(repoRoot: string, args: string[]): Promise<string> {
	const proc = Bun.spawn(["git", ...args], { cwd: repoRoot, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (exitCode !== 0) throw new Error(`OMP artifact Git provenance failed: ${stderr.trim()}`);
	return stdout.trim();
}

/** Capture before generation/compilation; never label an edited checkout with its clean HEAD. */
export async function captureArtifactSource(
	repoRoot: string,
	expectedCommits: readonly (string | undefined)[] = [process.env.GITHUB_SHA, process.env.RELEASE_COMMIT],
): Promise<ArtifactSource> {
	const commit = await git(repoRoot, ["rev-parse", "HEAD"]);
	if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("OMP artifact requires a full Git source commit");
	for (const expected of expectedCommits) {
		if (expected !== undefined && expected !== commit) {
			throw new Error(`OMP artifact source commit mismatch: HEAD=${commit}, expected=${expected}`);
		}
	}
	if (await git(repoRoot, ["status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=none"])) {
		throw new Error("OMP artifact requires a clean source checkout; use an explicit development executable override");
	}
	return Object.freeze({ repoRoot: path.resolve(repoRoot), commit });
}

export async function hashArtifactFile(file: string): Promise<string> {
	const hash = createHash("sha256");
	for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
	return hash.digest("hex");
}

async function assertExecutableTarget(file: string, target: string): Promise<void> {
	const match = /^(win32|darwin|linux|linux-musl)-(x64|arm64)$/.exec(target);
	if (!match) throw new Error(`OMP artifact unsupported target: ${target}`);
	if (!(await fsp.lstat(file)).isFile()) throw new Error(`OMP artifact executable is not a regular file: ${file}`);
	const handle = await fsp.open(file, "r");
	try {
		const header = Buffer.alloc(64);
		const { bytesRead } = await handle.read(header, 0, header.length, 0);
		let compatible = false;
		const arm64 = match[2] === "arm64";
		if (bytesRead === header.length && match[1] === "win32" && header.toString("ascii", 0, 2) === "MZ") {
			const pe = Buffer.alloc(6);
			const read = await handle.read(pe, 0, pe.length, header.readUInt32LE(60));
			compatible =
				read.bytesRead === pe.length &&
				pe.readUInt32LE(0) === 0x4550 &&
				pe.readUInt16LE(4) === (arm64 ? 0xaa64 : 0x8664);
		} else if (bytesRead === header.length && match[1]?.startsWith("linux")) {
			compatible =
				header.toString("hex", 0, 4) === "7f454c46" &&
				header[4] === 2 &&
				header[5] === 1 &&
				header.readUInt16LE(18) === (arm64 ? 183 : 62);
		} else if (bytesRead === header.length && match[1] === "darwin") {
			compatible =
				header.readUInt32LE(0) === 0xfeedfacf && header.readUInt32LE(4) === (arm64 ? 0x0100000c : 0x01000007);
		}
		if (!compatible) throw new Error(`OMP artifact executable target mismatch: ${target}`);
	} finally {
		await handle.close();
	}
}

/**
 * Called only by the compile entrypoints after their final signing and generated-source reset.
 * Bun embeds split JS chunks and native addons in this executable, so its runtime closure is one file.
 * The output root must be new: never mix bytes or pins from different build invocations.
 * No platform signature/notarization is asserted by these manifests.
 */
export async function produceZCodeArtifacts(options: {
	readonly source: ArtifactSource;
	readonly version: string;
	readonly outputRoot: string;
	readonly binaries: readonly ZCodeArtifactInput[];
}): Promise<void> {
	const { source, version, binaries } = options;
	if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version))
		throw new Error(`OMP artifact invalid version: ${version}`);
	if (binaries.length === 0 || new Set(binaries.map(binary => binary.target)).size !== binaries.length) {
		throw new Error("OMP artifact requires unique, nonempty targets");
	}
	await captureArtifactSource(source.repoRoot, [source.commit]);
	for (const binary of binaries) await assertExecutableTarget(binary.executable, binary.target);
	const outputRoot = path.resolve(options.outputRoot);
	await fsp.mkdir(path.dirname(outputRoot), { recursive: true });
	await fsp.mkdir(outputRoot);
	try {
		const artifacts: Record<string, string> = {};
		for (const binary of binaries) {
			const targetRoot = path.join(outputRoot, binary.target);
			await fsp.mkdir(targetRoot);
			const executable = binary.target.startsWith("win32-") ? "omp.exe" : "omp";
			const destination = path.join(targetRoot, executable);
			await fsp.copyFile(binary.executable, destination, fs.constants.COPYFILE_EXCL);
			if (!binary.target.startsWith("win32-")) await fsp.chmod(destination, 0o755);
			await assertExecutableTarget(destination, binary.target);
			const digest = await hashArtifactFile(destination);
			if (digest !== (await hashArtifactFile(binary.executable)))
				throw new Error(`OMP artifact executable changed during copy: ${binary.target}`);
			const manifest = {
				schemaVersion: 1,
				version,
				commit: source.commit,
				protocolBaseline: ZCODE_PROTOCOL_BASELINE,
				target: binary.target,
				executable,
				files: { [executable]: digest },
			};
			const manifestPath = path.join(targetRoot, "omp-artifact.json");
			await fsp.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
			artifacts[binary.target] = await hashArtifactFile(manifestPath);
		}
		await captureArtifactSource(source.repoRoot, [source.commit]);
		await fsp.writeFile(
			path.join(outputRoot, "omp-release.json"),
			`${JSON.stringify({ version, commit: source.commit, protocolBaseline: ZCODE_PROTOCOL_BASELINE, artifacts }, null, 2)}\n`,
			{ flag: "wx" },
		);
	} catch (error) {
		// This directory was exclusively created above; never remove an existing user's artifact root.
		await fsp.rm(outputRoot, { recursive: true, force: true });
		throw error;
	}
}
