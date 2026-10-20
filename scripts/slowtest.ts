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
import { runGate, type GateRun } from "./test-gate-runtime";
import { GateCommandError } from "./test-gate-failure-events";
import { captureSourceIdentity, type SourceIdentity } from "./test-gate-source";
import { beginTestRun, finalizeTestRun } from "./test-reporting";
import { exitGateProcess } from "./test-gate-watchdog";

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
	try {
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
				let result: WslStageResult;
				if (selection.status !== "AVAILABLE") result = selection;
				else {
					if (before.dirty)
						throw new GateCommandError(
							"BLOCKED: commit and push intended source before WSL execution; dirty source cannot be transferred; this gate does not perform Git writes",
							1,
						);
					result = await injected.wsl(gate, { ...wslOptions, selection, identity: before });
				}
				if ("exitCode" in result)
					throw new GateCommandError(
						`${result.status}: ${result.reason}`,
						result.exitCode || 1,
						result.status === "TIMEOUT" ? "TIMEOUT" : result.status === "CANCELLED" ? "INTERRUPTED" : "FAIL",
					);
				if (result.status === "PASS" && result.head !== before.head)
					throw new GateCommandError("UNVERIFIED: WSL result belongs to a different fixed commit", 1);
				const skipped = result.status !== "PASS";
				logger.info("Slowtest Linux leg settled", {
					component: "test-gate-slowtest",
					event: "slowtest_linux_settled",
					stage: "linux-leg",
					result: result.status,
					status: result.status,
					coverage_equals_fulltest: skipped,
					elapsed_ms: performance.now() - linuxStarted,
					exit_code: result.status === "PASS" ? 0 : undefined,
					head: result.status === "PASS" ? result.head : undefined,
				});
				if (result.status !== "PASS")
					console.log(`slowtest: ${result.status} — ${result.reason}; coverage equals fulltest`);
				return result;
			} catch (error) {
				const failure = gate.fail(error);
				const cancelled = failure.status === "INTERRUPTED";
				(cancelled ? logger.info : logger.error)("Slowtest Linux leg failed", {
					component: "test-gate-slowtest",
					event: "slowtest_linux_exception",
					stage: "linux-leg",
					result: cancelled ? "cancelled" : "failed",
					elapsed_ms: performance.now() - linuxStarted,
					...logger.diagnosticError(failure),
				});
				throw failure;
			}
		})();
		const current = gate.childGate("fulltest", async child => {
			try {
				await injected.fulltest(child, { debug: options.debug });
			} catch (error) {
				throw child.fail(error);
			}
		});
		const [, wslResult] = await Promise.all([current, linux]);
		const after = await injected.identity(gate, root);
		if (before.head !== after.head || before.digest !== after.digest)
			throw gate.fail(
				new GateCommandError(
					`UNVERIFIED: current source changed during slowtest (before=${before.head}/${before.digest}, after=${after.head}/${after.digest})`,
					1,
				),
			);
		logger.info("Slowtest source stability resolved", {
			component: "test-gate-slowtest",
			event: "slowtest_source_identity",
			stage: "source-after",
			result: "unchanged",
			head: after.head,
			source_fingerprint: after.digest,
			dirty: after.dirty,
		});
		if (wslResult.status === "PASS") {
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
		}
	} catch (error) {
		throw gate.fail(error);
	}
}
if (import.meta.main) {
	const options = parseSlowtestArgs(process.argv.slice(2));
	const result = await runGate(
		"slowtest",
		async gate => {
			if (!options)
				throw new GateCommandError("Usage: bun run slowtest [--debug] [--limit-seconds=N] (0 < N <= 1500)", 2);
			const run = await gate.charged(() =>
				beginTestRun("slowtest: fork-affected current platform; Linux reports stay in the WSL native workspace"),
			);
			finalizeTestRun(
				gate,
				run,
				"WSL reports remain in the Linux native workspace and are not reconciled in this host run; an unavailable WSL leg is documented only in the gate log",
			);
			await runSlowtest(gate, options);
		},
		{ limitSeconds: options?.limitSeconds, reportFailure: true, exitOnFailure: true },
	);
	exitGateProcess(result.exitCode);
}
