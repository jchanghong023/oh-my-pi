#!/usr/bin/env bun
// Current-platform fulltest once plus optional fixed-commit WSL/Linux coverage.
// No commits/pushes, CI, publishing, tool installation, or desktop automation.
import * as path from "node:path";
import { runFulltest } from "./fulltest";
import {
	discoverWsl,
	runWslStage,
	type WslOptions,
	type WslSelection,
	type WslStageResult,
} from "./slowtest-wsl-stage";
import { GateCommandError, runGate, type GateRun } from "./test-gate-runtime";
import { captureSourceIdentity, type SourceIdentity } from "./test-gate-source";

const repoRoot = path.resolve(import.meta.dir, "..");
export interface SlowtestArgs {
	debug: boolean;
	limitSeconds?: number;
}
export function parseSlowtestArgs(args: readonly string[]): SlowtestArgs | null {
	const options: SlowtestArgs = { debug: false };
	for (const arg of args) {
		if (arg === "--debug") options.debug = true;
		else if (arg.startsWith("--limit-seconds=") && options.limitSeconds === undefined) {
			const limit = Number(arg.slice("--limit-seconds=".length));
			if (!Number.isFinite(limit) || limit <= 0 || limit > 1500) return null;
			options.limitSeconds = limit;
		} else return null;
	}
	return options;
}
export interface SlowtestDependencies {
	fulltest(gate: GateRun, options: { debug: boolean }): Promise<void>;
	discover(gate: GateRun, options: WslOptions): Promise<WslSelection>;
	identity(gate: GateRun, root: string): Promise<SourceIdentity>;
	wsl(gate: GateRun, options: WslOptions): Promise<WslStageResult>;
}
const dependencies: SlowtestDependencies = {
	fulltest: runFulltest,
	discover: discoverWsl,
	identity: captureSourceIdentity,
	wsl: runWslStage,
};
export interface SlowtestOptions extends SlowtestArgs {
	root?: string;
	wslNeeded?: boolean;
	platform?: NodeJS.Platform;
	which?: (tool: string) => string | null;
}
export async function runSlowtest(
	gate: GateRun,
	options: SlowtestOptions,
	injected: SlowtestDependencies = dependencies,
): Promise<void> {
	const root = options.root ?? repoRoot;
	const wslOptions: WslOptions = {
		debug: options.debug,
		root,
		needed: options.wslNeeded,
		platform: options.platform,
		which: options.which,
	};
	const before = await injected.identity(gate, root);
	console.log(`slowtest: current source HEAD=${before.head} digest=${before.digest} dirty=${before.dirty}`);
	if (before.dirty) console.log(`slowtest: uncommitted source summary\n${before.status.trimEnd()}`);
	// Discovery/preflight failure is not permission to omit reachable local
	// coverage. Keep the Linux result deferred until fulltest has settled.
	const linux = (async (): Promise<WslStageResult> => {
		try {
			const selection = await injected.discover(gate, wslOptions);
			if (selection.status !== "AVAILABLE") return selection;
			if (before.dirty)
				return {
					status: "BLOCKED",
					reason:
						"commit and push intended source before WSL execution; dirty source cannot be transferred and Git writes are not authorized",
					exitCode: 1,
				};
			return await injected.wsl(gate, { ...wslOptions, selection, identity: before });
		} catch (error) {
			return {
				status: "BLOCKED",
				reason: error instanceof Error ? error.message : String(error),
				exitCode: error instanceof GateCommandError ? error.exitCode : 1,
			};
		}
	})();
	const current = gate.childGate("fulltest", child => injected.fulltest(child, { debug: options.debug }));
	const results = await Promise.allSettled([current, linux]);
	const wslResult = results[1].status === "fulfilled" ? results[1].value : undefined;
	if (wslResult && wslResult.status !== "PASS") {
		const skipped = wslResult.status === "SKIPPED_NOT_APPLICABLE" || wslResult.status === "SKIPPED_WSL_UNAVAILABLE";
		console.log(
			`slowtest: ${wslResult.status} — ${wslResult.reason}${skipped ? "; coverage equals fulltest" : "; Linux extension unverified, slowtest is nonpassing"}`,
		);
	}
	for (const result of results) if (result.status === "rejected") throw result.reason;
	const after = await injected.identity(gate, root);
	if (before.head !== after.head || before.digest !== after.digest) {
		throw new GateCommandError(
			`UNVERIFIED: current source changed during slowtest (before=${before.head}/${before.digest}, after=${after.head}/${after.digest})`,
			1,
		);
	}
	if (!wslResult) throw new GateCommandError("UNVERIFIED: Linux stage returned no result", 1);
	if (wslResult.status === "PASS") {
		if (before.dirty || wslResult.head !== before.head)
			throw new GateCommandError("UNVERIFIED: WSL result belongs to a different fixed commit", 1);
		console.log(`slowtest: both platforms verified fixed commit ${before.head}; local digest=${before.digest}`);
	} else if ("exitCode" in wslResult) {
		throw new GateCommandError(
			`${wslResult.status}: ${wslResult.reason}`,
			wslResult.exitCode,
			wslResult.status === "TIMEOUT" ? "TIMEOUT" : wslResult.status === "CANCELLED" ? "INTERRUPTED" : "FAIL",
		);
	}
}
if (import.meta.main) {
	const options = parseSlowtestArgs(process.argv.slice(2));
	runGate(
		"slowtest",
		async gate => {
			if (!options)
				throw new GateCommandError("Usage: bun run slowtest [--debug] [--limit-seconds=N] (0 < N <= 1500)", 2);
			await runSlowtest(gate, options);
		},
		{ limitSeconds: options?.limitSeconds },
	).then(result => {
		process.exitCode = result.exitCode;
	});
}
