import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils/temp";
import { $ } from "bun";
import { resolveCrossBuild } from "../packages/coding-agent/scripts/build-binary";
import { compileCodingAgent } from "../packages/coding-agent/scripts/compile-binary";
import { requireArtifactVersion } from "./zcode-artifact";

const repoRoot = path.join(import.meta.dir, "..");

describe("ZCode artifact release version", () => {
	it("rejects missing and invalid local release versions before starting a build", async () => {
		using temp = TempDir.createSync("@omp-artifact-version-");
		for (const version of [undefined, "", "1.2", "not-a-version", "1.2.3+"]) {
			const outputRoot = temp.join("artifact");
			const env = { ...process.env, ZCODE_ARTIFACT_ROOT: outputRoot };
			if (version === undefined) delete env.RELEASE_VERSION;
			else env.RELEASE_VERSION = version;
			const proc = Bun.spawn([process.execPath, "packages/coding-agent/scripts/build-binary.ts"], {
				cwd: repoRoot,
				env,
				stdout: "pipe",
				stderr: "pipe",
			});
			const [stdout, stderr, exitCode] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
				proc.exited,
			]);
			expect(exitCode).not.toBe(0);
			expect(stderr).toContain(version ? "OMP artifact invalid version" : "requires RELEASE_VERSION");
			expect(stdout).not.toContain("Generating stats client");
			expect(
				await fs.stat(outputRoot).then(
					() => true,
					() => false,
				),
			).toBe(false);
		}
	});

	it("preserves a valid explicit version with build metadata", () => {
		expect(requireArtifactVersion("18.12.5+fork.9")).toBe("18.12.5+fork.9");
	});

	it("ignores ZCODE_ARTIFACT_ROOT and invalid release provenance during a dry run", async () => {
		using temp = TempDir.createSync("@omp-artifact-dry-run-");
		const outputRoot = temp.join("existing-artifacts");
		await fs.mkdir(outputRoot);
		const sentinel = path.join(outputRoot, "keep.json");
		await Bun.write(sentinel, '{"userOwned":true}\n');
		const child = Bun.spawn(
			[process.execPath, "scripts/ci-release-build-binaries.ts", "--dry-run", "--targets", "linux-x64,win32-x64"],
			{
				cwd: repoRoot,
				env: {
					...process.env,
					ZCODE_ARTIFACT_ROOT: outputRoot,
					RELEASE_VERSION: "not-a-version",
					RELEASE_COMMIT: "0".repeat(40),
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
		expect(stdout).toContain("DRY RUN Bun.build target=bun-windows-x64-baseline");
		expect(await fs.readdir(outputRoot)).toEqual(["keep.json"]);
		expect(await Bun.file(sentinel).text()).toBe('{"userOwned":true}\n');
	});
});

describe("Windows release binary target", () => {
	it("builds both Windows architecture release assets with their native runtimes", async () => {
		const result = await $`bun scripts/ci-release-build-binaries.ts --dry-run --targets win32-x64,win32-arm64`
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
		expect(buildPlans).toHaveLength(2);
		expect(buildPlans.map(build => ({ target: build.target, outfile: build.outfile }))).toEqual(
			expect.arrayContaining([
				{
					target: "bun-windows-x64-baseline",
					outfile: "packages/coding-agent/binaries/omp-windows-x64.exe",
				},
				{
					target: "bun-windows-arm64",
					outfile: "packages/coding-agent/binaries/omp-windows-arm64.exe",
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

	it("resolves local Windows cross-build aliases for both architectures", () => {
		expect(resolveCrossBuild("win32-x64")).toEqual({
			id: "win32-x64",
			platform: "win32",
			arch: "x64",
			target: "bun-windows-x64-baseline",
		});
		expect(resolveCrossBuild("windows-x64")).toEqual({
			id: "windows-x64",
			platform: "win32",
			arch: "x64",
			target: "bun-windows-x64-baseline",
		});
		expect(resolveCrossBuild("win32-arm64")).toEqual({
			id: "win32-arm64",
			platform: "win32",
			arch: "arm64",
			target: "bun-windows-arm64",
		});
		expect(resolveCrossBuild("windows-arm64")).toEqual({
			id: "windows-arm64",
			platform: "win32",
			arch: "arm64",
			target: "bun-windows-arm64",
		});
	});
});

it("runs compiled bytecode containing dependency import.meta.resolve calls", async () => {
	using temp = TempDir.createSync("@omp-bytecode-");
	const entrypoint = temp.join("entry.ts");
	const outfile = temp.join(process.platform === "win32" ? "probe.exe" : "probe");
	await Bun.write(entrypoint, 'console.log(import.meta.resolve("node:fs"));\n');
	await compileCodingAgent({
		repoRoot: temp.path(),
		entrypoint,
		outfile,
		native: null,
	});
	const result = await $`${outfile}`.quiet().nothrow();
	expect(result.exitCode).toBe(0);
	expect(result.text().trim()).toBe("node:fs");
}, 30_000);

it("runs code behind a lazy import() from a split chunk of the compiled binary", async () => {
	using temp = TempDir.createSync("@omp-split-chunk-");
	const entrypoint = temp.join("entry.ts");
	const outfile = temp.join(process.platform === "win32" ? "probe.exe" : "probe");
	// The probe's dynamic import() is the chunk boundary under test: with
	// `splitting`, lazy.ts compiles into a separate embedded chunk.
	await Bun.write(temp.join("lazy.ts"), 'export const value = ["lazy", "chunk"].join(" ");\n');
	await Bun.write(entrypoint, 'const { value } = await import("./lazy.ts");\nconsole.log(value);\n');
	await compileCodingAgent({
		repoRoot: temp.path(),
		entrypoint,
		outfile,
		native: null,
	});
	const result = await $`${outfile}`.quiet().nothrow();
	expect(result.exitCode).toBe(0);
	expect(result.text().trim()).toBe("lazy chunk");
}, 30_000);
describe("macOS release binary entitlements", () => {
	it("allows Xcode MCP automation through Apple Events", async () => {
		const entitlements = await Bun.file(path.join(repoRoot, "scripts/macos-entitlements.plist")).text();

		expect(entitlements).toContain("<key>com.apple.security.automation.apple-events</key>\n\t<true/>");
	});
});
