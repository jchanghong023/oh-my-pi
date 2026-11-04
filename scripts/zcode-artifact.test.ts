import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	captureArtifactSource,
	hashArtifactFile,
	produceZCodeArtifacts,
	ZCODE_PROTOCOL_BASELINE,
} from "./zcode-artifact";

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function git(repo: string, ...args: string[]): Promise<string> {
	const child = Bun.spawn(["git", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (code !== 0) throw new Error(stderr);
	return stdout.trim();
}

async function fixture() {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-artifact-"));
	roots.push(root);
	const repo = path.join(root, "source");
	await fs.mkdir(repo);
	await git(repo, "init");
	await fs.writeFile(path.join(repo, "source.ts"), "export const value = 1;\n");
	await git(repo, "add", "source.ts");
	await git(
		repo,
		"-c",
		"user.name=Artifact Test",
		"-c",
		"user.email=artifact@example.invalid",
		"-c",
		"core.hooksPath=",
		"-c",
		"commit.gpgsign=false",
		"commit",
		"-m",
		"fixture",
	);
	const source = await captureArtifactSource(repo, []);
	// A minimal PE header is enough to exercise packaging without compiling or executing a fixture.
	const pe = Buffer.alloc(256);
	pe.write("MZ");
	pe.writeUInt32LE(128, 60);
	pe.writeUInt32LE(0x4550, 128);
	pe.writeUInt16LE(0x8664, 132);
	pe.write("final signed-or-unsigned bytes are hashed verbatim", 160);
	const executable = path.join(root, "omp.exe");
	await fs.writeFile(executable, pe);
	return { root, repo, source, executable, outputRoot: path.join(root, "output") };
}

describe("ZCode immutable OMP artifact production", () => {
	it("pins actual source, target and the complete copied final executable bytes", async () => {
		const value = await fixture();
		await produceZCodeArtifacts({
			...value,
			version: "18.12.5+fork.9",
			binaries: [{ target: "win32-x64", executable: value.executable }],
		});
		const targetRoot = path.join(value.outputRoot, "win32-x64");
		const manifestPath = path.join(targetRoot, "omp-artifact.json");
		const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
		const release = JSON.parse(await fs.readFile(path.join(value.outputRoot, "omp-release.json"), "utf8"));
		expect(manifest).toEqual({
			schemaVersion: 1,
			version: "18.12.5+fork.9",
			commit: value.source.commit,
			protocolBaseline: ZCODE_PROTOCOL_BASELINE,
			target: "win32-x64",
			executable: "omp.exe",
			files: { "omp.exe": await hashArtifactFile(value.executable) },
		});
		expect(release).toEqual({
			version: manifest.version,
			commit: manifest.commit,
			protocolBaseline: manifest.protocolBaseline,
			artifacts: { "win32-x64": await hashArtifactFile(manifestPath) },
		});
		expect(await hashArtifactFile(path.join(targetRoot, "omp.exe"))).toBe(manifest.files[manifest.executable]);
		// Consumer pins expose corruption of either final executable or manifest, independently.
		await fs.appendFile(path.join(targetRoot, "omp.exe"), "corruption");
		expect(await hashArtifactFile(path.join(targetRoot, "omp.exe"))).not.toBe(manifest.files[manifest.executable]);
		await fs.appendFile(manifestPath, " ");
		expect(await hashArtifactFile(manifestPath)).not.toBe(release.artifacts["win32-x64"]);
	});

	it("rejects conflicting source environment pins", async () => {
		const value = await fixture();
		await expect(captureArtifactSource(value.repo, ["0".repeat(40)])).rejects.toThrow("source commit mismatch");
		await expect(captureArtifactSource(value.repo, [value.source.commit.slice(0, 12)])).rejects.toThrow(
			"source commit mismatch",
		);
	});

	it("rejects dirty tracked and untracked source instead of claiming HEAD built it", async () => {
		const value = await fixture();
		await fs.writeFile(path.join(value.repo, "source.ts"), "export const value = 2;\n");
		await expect(captureArtifactSource(value.repo, [])).rejects.toThrow("clean source checkout");
		await fs.writeFile(path.join(value.repo, "source.ts"), "export const value = 1;\n");
		await fs.writeFile(path.join(value.repo, "untracked.ts"), "new code");
		await expect(
			produceZCodeArtifacts({
				...value,
				version: "18.12.5",
				binaries: [{ target: "win32-x64", executable: value.executable }],
			}),
		).rejects.toThrow("clean source checkout");
		await expect(fs.stat(value.outputRoot)).rejects.toThrow();
	});

	it("rejects source commit movement between capture and packaging", async () => {
		const value = await fixture();
		await git(
			value.repo,
			"-c",
			"user.name=Artifact Test",
			"-c",
			"user.email=artifact@example.invalid",
			"-c",
			"core.hooksPath=",
			"-c",
			"commit.gpgsign=false",
			"commit",
			"--allow-empty",
			"-m",
			"new source",
		);
		await expect(
			produceZCodeArtifacts({
				...value,
				version: "18.12.5",
				binaries: [{ target: "win32-x64", executable: value.executable }],
			}),
		).rejects.toThrow("source commit mismatch");
	});

	it("rejects another platform, architecture, unsupported target, and missing executable", async () => {
		const value = await fixture();
		for (const target of ["linux-x64", "win32-arm64", "../escape"]) {
			await expect(
				produceZCodeArtifacts({
					...value,
					version: "18.12.5",
					binaries: [{ target, executable: value.executable }],
				}),
			).rejects.toThrow(target === "../escape" ? "unsupported target" : "target mismatch");
		}
		await expect(
			produceZCodeArtifacts({
				...value,
				version: "18.12.5",
				binaries: [{ target: "win32-x64", executable: path.join(value.root, "missing.exe") }],
			}),
		).rejects.toThrow();
	});

	it("rejects malformed version, duplicate targets and preexisting output without overwriting", async () => {
		const value = await fixture();
		const binary = { target: "win32-x64", executable: value.executable };
		await expect(produceZCodeArtifacts({ ...value, version: "not-a-version", binaries: [binary] })).rejects.toThrow(
			"invalid version",
		);
		await expect(produceZCodeArtifacts({ ...value, version: "18.12.5", binaries: [binary, binary] })).rejects.toThrow(
			"unique, nonempty targets",
		);
		await fs.mkdir(value.outputRoot);
		await fs.writeFile(path.join(value.outputRoot, "keep"), "existing artifact");
		await expect(produceZCodeArtifacts({ ...value, version: "18.12.5", binaries: [binary] })).rejects.toThrow();
		expect(await fs.readFile(path.join(value.outputRoot, "keep"), "utf8")).toBe("existing artifact");
	});

	it.each(["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64", "win32-arm64"])(
		"validates the complete %s executable header and publishes matching manifests",
		async target => {
			const value = await fixture();
			const arm64 = target.endsWith("arm64");
			const bytes = Buffer.alloc(256);
			if (target.startsWith("linux")) {
				bytes.write("7f454c46", 0, "hex");
				bytes[4] = 2;
				bytes[5] = 1;
				bytes.writeUInt16LE(arm64 ? 183 : 62, 18);
			} else if (target.startsWith("darwin")) {
				bytes.writeUInt32LE(0xfeedfacf, 0);
				bytes.writeUInt32LE(arm64 ? 0x0100000c : 0x01000007, 4);
			} else {
				bytes.write("MZ");
				bytes.writeUInt32LE(128, 60);
				bytes.writeUInt32LE(0x4550, 128);
				bytes.writeUInt16LE(0xaa64, 132);
			}
			await fs.writeFile(value.executable, bytes);
			await produceZCodeArtifacts({
				...value,
				version: "1.2.3+fork.9",
				binaries: [{ target, executable: value.executable }],
			});
			const executable = target.startsWith("win32") ? "omp.exe" : "omp";
			const artifact = path.join(value.outputRoot, target, executable);
			expect(await fs.readFile(artifact)).toEqual(bytes);
			const manifest = await Bun.file(path.join(value.outputRoot, target, "omp-artifact.json")).json();
			expect(manifest).toMatchObject({
				target,
				executable,
				version: "1.2.3+fork.9",
				files: { [executable]: await hashArtifactFile(artifact) },
			});
			await fs.rm(value.outputRoot, { recursive: true });
			// Correct magic alone is insufficient: class/endian/CPU mismatches fail.
			if (target.startsWith("linux")) bytes[5] = 2;
			else if (target.startsWith("darwin")) bytes.writeUInt32LE(0, 4);
			else bytes.writeUInt16LE(0x8664, 132);
			await fs.writeFile(value.executable, bytes);
			await expect(
				produceZCodeArtifacts({ ...value, version: "1.2.3", binaries: [{ target, executable: value.executable }] }),
			).rejects.toThrow("target mismatch");
			expect(await Bun.file(path.join(value.outputRoot, "omp-release.json")).exists()).toBe(false);
		},
	);

	it.each(["binary-bytes", "source-checkout"] as const)(
		"removes its own output root when %s changes during copying",
		async mutation => {
			const value = await fixture();
			const copyFile = fs.copyFile.bind(fs);
			const copy = spyOn(fs, "copyFile").mockImplementationOnce(async (source, destination, mode) => {
				await copyFile(source, destination, mode);
				if (mutation === "binary-bytes") await fs.appendFile(value.executable, "changed after copy");
				else await fs.writeFile(path.join(value.repo, "source.ts"), "export const value = 3;\n");
			});
			try {
				await expect(
					produceZCodeArtifacts({
						...value,
						version: "1.2.3",
						binaries: [{ target: "win32-x64", executable: value.executable }],
					}),
				).rejects.toThrow(mutation === "binary-bytes" ? "changed during copy" : "clean source checkout");
				expect(copy).toHaveBeenCalledTimes(1);
				await expect(fs.stat(value.outputRoot)).rejects.toMatchObject({ code: "ENOENT" });
			} finally {
				copy.mockRestore();
			}
		},
	);

	it("rejects an empty target list without creating output", async () => {
		const value = await fixture();
		await expect(produceZCodeArtifacts({ ...value, version: "1.2.3", binaries: [] })).rejects.toThrow(
			"unique, nonempty targets",
		);
		await expect(fs.stat(value.outputRoot)).rejects.toMatchObject({ code: "ENOENT" });
	});
});
