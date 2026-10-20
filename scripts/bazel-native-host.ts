import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { detectHostAvx2Support, resolveLocalHostAddon } from "./host-detect";
import { runBazelCommands } from "./test-gate-bazel";
import { bazelShell, bazelToolPath } from "./test-gate-bazel-tools";
import { GateCommandError } from "./test-gate-failure-events";
import { runBazelTask } from "./test-gate-runtime";

const root = path.resolve(import.meta.dir, "..");

/** Build raw host products as declared Bazel outputs; installation is never cached. */
export async function buildCachedHostArtifacts(): Promise<{ addon: string; declarations: string; loader: string }> {
	if (process.platform !== "win32") {
		throw new Error("Cached native host artifacts require the declared Windows toolchain inputs");
	}
	const addon = resolveLocalHostAddon({
		platform: process.platform,
		arch: process.arch,
		avx2: detectHostAvx2Support(),
	});
	const label = `compile/Rust native host ${addon.filename}`;
	let artifacts: Record<string, string> | undefined;
	const result = await runBazelTask(
		async gate => {
			const reports = await runBazelCommands(
				gate,
				[
					{
						label,
						argv: ["bun", "packages/natives/scripts/build-bindings.ts"],
						cwd: root,
						env: {
							PATH: bazelToolPath(process.env.PATH ?? process.env.Path ?? ""),
							BAZEL_SH: bazelShell(process.env),
							CARGO_HOME: process.env.CARGO_HOME ?? path.join(os.homedir(), ".cargo"),
							RUSTUP_HOME: process.env.RUSTUP_HOME ?? path.join(os.homedir(), ".rustup"),
							RUSTUP_AUTO_INSTALL: "0",
							OMP_NATIVE_CARGO_PROFILE: process.env.OMP_NATIVE_CARGO_PROFILE?.trim() || "local",
							OMP_NATIVE_FEATURES: process.env.OMP_NATIVE_FEATURES?.trim(),
							PCRE2_SYS_STATIC: process.env.PCRE2_SYS_STATIC ?? "1",
						},
						artifactFiles: ["addon.node", "index.d.ts", "index.js"],
					},
				],
				{ root },
			);
			const report = reports.find(report => report.label === label);
			if (!report || (report.status !== "new" && report.status !== "cached")) {
				throw new Error("Bazel native host compilation did not complete successfully");
			}
			artifacts = report.artifacts;
		},
		{ reportFailure: true },
	);
	if (result.exitCode !== 0) throw new GateCommandError("Bazel native host compilation failed", result.exitCode);
	const required = ["addon.node", "index.d.ts", "index.js"] as const;
	for (const filename of required) {
		const artifact = artifacts?.[filename];
		if (!artifact || !path.isAbsolute(artifact) || !(await fs.stat(artifact)).isFile()) {
			throw new Error(`Bazel native host compilation is missing declared output ${filename}`);
		}
	}
	return {
		addon: artifacts!["addon.node"]!,
		declarations: artifacts!["index.d.ts"]!,
		loader: artifacts!["index.js"]!,
	};
}
