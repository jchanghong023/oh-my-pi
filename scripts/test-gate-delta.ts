import * as path from "node:path";
import { GateAbortError, GateCommandError } from "./test-gate-failure-events";
import { withRustCompilerEvents } from "./test-gate-native-events";
import type { GateRun } from "./test-gate-runtime";

export interface RustDeltaSelection {
	tool: "cargo-delta";
	mode: "full" | "affected";
	packages: string[];
	baseline?: string;
	reason: string;
}

const FORK_PACKAGES = ["pi-wiki", "pi-natives"];
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;
const PACKAGE = /^[A-Za-z0-9_][A-Za-z0-9_-]*$/;

/** Analyze only against a qualified full-test baseline; never cache test results. */
export async function selectRustPackages(
	gate: GateRun,
	root: string,
	baseline?: string,
	command?: readonly string[],
): Promise<RustDeltaSelection> {
	if (gate.signal.aborted) throw gate.signal.reason;
	const fallback = (reason: string): RustDeltaSelection => ({
		tool: "cargo-delta",
		mode: "full",
		packages: [...FORK_PACKAGES],
		baseline,
		reason,
	});
	if (!baseline || !SHA.test(baseline)) return fallback("No valid clean full-test baseline");
	const cargo = command ?? (Bun.which("cargo") ? ["cargo"] : undefined);
	if (!cargo?.length) return fallback("Cargo is unavailable; cargo-delta cannot run");
	try {
		const version = await gate.capture({
			label: "scope/cargo-delta version",
			argv: [...cargo, "delta", "--version"],
			cwd: root,
			allowFailure: true,
		});
		if (version.exitCode !== 0 || !/^cargo-delta 0\.5\.0\s*$/.test(version.stdout))
			return fallback("cargo-delta 0.5.0 is unavailable or has an unexpected version");
		const result = await withRustCompilerEvents({ ...process.env } as Record<string, string>, env =>
			gate.capture({
				label: "scope/cargo-delta impact",
				argv: [
					...cargo,
					"delta",
					"--config",
					path.join(root, ".config", "cargo-delta.toml"),
					"impact",
					"--base-ref",
					baseline,
					"--affected",
					"--format",
					"json",
				],
				cwd: root,
				env,
				allowFailure: true,
			}),
		);
		if (result.exitCode !== 0) return fallback(`cargo-delta impact failed (exit ${result.exitCode})`);
		// cargo-delta 0.5.0 intentionally emits no JSON for a wholly clean
		// comparison. Its explicit diagnostic distinguishes that branch from
		// truncated or otherwise malformed output.
		if (result.stdout === "" && /^No file has been changed or deleted, quitting\.\r?$/m.test(result.stderr))
			return {
				tool: "cargo-delta",
				mode: "affected",
				packages: [],
				baseline,
				reason: "cargo-delta reported no changed or deleted files",
			};
		let value: unknown;
		try {
			value = JSON.parse(result.stdout);
		} catch {
			return fallback("cargo-delta returned invalid JSON");
		}
		if (!value || typeof value !== "object" || Array.isArray(value))
			return fallback("cargo-delta returned an invalid impact object");
		const record = value as Record<string, unknown>;
		if (
			Object.keys(record).some(key => key !== "Affected") ||
			!Array.isArray(record.Affected) ||
			!record.Affected.every((name: unknown) => typeof name === "string" && PACKAGE.test(name)) ||
			new Set(record.Affected).size !== record.Affected.length
		)
			return fallback("cargo-delta returned an invalid or unknown impact status");
		return {
			tool: "cargo-delta",
			mode: "affected",
			packages: record.Affected,
			baseline,
			reason: "cargo-delta affected workspace packages",
		};
	} catch (error) {
		if (gate.signal.aborted) throw gate.signal.reason;
		if (
			error instanceof GateAbortError ||
			(error instanceof GateCommandError && (error.status === "TIMEOUT" || error.status === "INTERRUPTED"))
		)
			throw error;
		return fallback(
			`cargo-delta could not analyze changes: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}
