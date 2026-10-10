#!/usr/bin/env bun
// Current-platform fulltest once plus optional fixed-commit WSL/Linux coverage.
// No commits/pushes, CI, publishing, tool installation, or desktop automation.
import * as path from "node:path";
import * as logger from "@oh-my-pi/pi-utils/logger";
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
	const started = performance.now();
	logger.info("Slowtest orchestration started", {
		component: "test-gate-slowtest",
		event: "slowtest_started",
		stage: "orchestration",
		result: "started",
		platform: options.platform ?? process.platform,
		scope: "fork-affected",
	});
	try {
		await runSlowtestObserved(gate, options, injected);
		logger.info("Slowtest orchestration completed", {
			component: "test-gate-slowtest",
			event: "slowtest_settled",
			stage: "orchestration",
			result: "completed",
			elapsed_ms: performance.now() - started,
		});
	} catch (error) {
		const cancelled = error instanceof GateCommandError && error.status === "INTERRUPTED";
		(cancelled ? logger.info : logger.error)("Slowtest orchestration failed", {
			component: "test-gate-slowtest",
			event: "slowtest_settled",
			stage: "orchestration",
			result: cancelled ? "cancelled" : "failed",
			status: error instanceof GateCommandError ? error.status : "FAIL",
			elapsed_ms: performance.now() - started,
			...logger.diagnosticError(error),
		});
		throw error;
	}
}
async function runSlowtestObserved(
	gate: GateRun,
	options: SlowtestOptions,
	injected: SlowtestDependencies,
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
	logger.info("Slowtest source identity resolved", {
		component: "test-gate-slowtest",
		event: "slowtest_source_identity",
		stage: "source-before",
		result: "completed",
		head: before.head,
		source_fingerprint: before.digest,
		dirty: before.dirty,
	});
	console.log(`slowtest: current source HEAD=${before.head} digest=${before.digest} dirty=${before.dirty}`);
	if (before.dirty) console.log(`slowtest: uncommitted source summary\n${before.status.trimEnd()}`);
	// Discovery/preflight failure is not permission to omit reachable local
	// coverage. Keep the Linux result deferred until fulltest has settled.
	let linuxElapsed = 0;
	const linux = (async (): Promise<WslStageResult> => {
		const linuxStarted = performance.now();
		logger.info("Slowtest Linux leg started", {
			component: "test-gate-slowtest",
			event: "slowtest_linux_started",
			stage: "linux-leg",
			result: "started",
			expected_head: before.head,
		});
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
			const cancelled = error instanceof GateCommandError && error.status === "INTERRUPTED";
			(cancelled ? logger.info : logger.error)("Slowtest Linux leg exception deferred", {
				component: "test-gate-slowtest",
				event: "slowtest_linux_exception",
				stage: "linux-leg",
				result: cancelled ? "cancelled" : "BLOCKED",
				elapsed_ms: performance.now() - linuxStarted,
				...logger.diagnosticError(error),
			});
			return {
				status: "BLOCKED",
				reason: error instanceof Error ? error.message : String(error),
				exitCode: error instanceof GateCommandError ? error.exitCode : 1,
			};
		} finally {
			linuxElapsed = performance.now() - linuxStarted;
		}
	})();
	const current = gate.childGate("fulltest", child => injected.fulltest(child, { debug: options.debug }));
	const results = await Promise.allSettled([current, linux]);
	const wslResult = results[1].status === "fulfilled" ? results[1].value : undefined;
	if (wslResult) {
		const skipped = wslResult.status === "SKIPPED_NOT_APPLICABLE" || wslResult.status === "SKIPPED_WSL_UNAVAILABLE";
		const cancelled =
			gate.signal.aborted &&
			gate.signal.reason instanceof GateCommandError &&
			gate.signal.reason.status === "INTERRUPTED";
		(wslResult.status === "PASS" || skipped || wslResult.status === "CANCELLED" || cancelled
			? logger.info
			: logger.error)("Slowtest Linux leg settled", {
			component: "test-gate-slowtest",
			event: "slowtest_linux_settled",
			stage: "linux-leg",
			result: cancelled ? "cancelled" : wslResult.status,
			status: wslResult.status,
			coverage_equals_fulltest: skipped,
			elapsed_ms: linuxElapsed,
			exit_code: "exitCode" in wslResult ? wslResult.exitCode : wslResult.status === "PASS" ? 0 : undefined,
			head: wslResult.status === "PASS" ? wslResult.head : undefined,
		});
	}
	if (wslResult && wslResult.status !== "PASS") {
		const skipped = wslResult.status === "SKIPPED_NOT_APPLICABLE" || wslResult.status === "SKIPPED_WSL_UNAVAILABLE";
		console.log(
			`slowtest: ${wslResult.status} — ${wslResult.reason}${skipped ? "; coverage equals fulltest" : "; Linux extension unverified, slowtest is nonpassing"}`,
		);
	}
	for (const result of results) if (result.status === "rejected") throw result.reason;
	const after = await injected.identity(gate, root);
	logger.info("Slowtest source stability resolved", {
		component: "test-gate-slowtest",
		event: "slowtest_source_identity",
		stage: "source-after",
		result: before.head === after.head && before.digest === after.digest ? "unchanged" : "changed",
		head: after.head,
		source_fingerprint: after.digest,
		dirty: after.dirty,
	});
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
		logger.info("Slowtest fixed commit coverage merged", {
			component: "test-gate-slowtest",
			event: "slowtest_platforms_verified",
			stage: "merged-result",
			result: "completed",
			head: before.head,
			source_fingerprint: before.digest,
			platform_count: 2,
			scope: "fork-affected",
		});
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
