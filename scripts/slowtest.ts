#!/usr/bin/env bun
// Fork pipeline gate: run `bun run fulltest`, verify the same tree on the
// ubuntu-24.04 WSL2 distro via slowtest-wsl-stage.ts (Windows-only; skipped
// elsewhere), push local `main` to origin, trigger the repository's GitHub
// Actions CI (manual `workflow_dispatch` with `publish_release=true`: a green
// run publishes the fork Release instead of only building artifacts), then
// poll the triggered run until it completes and report the conclusion plus
// the failure-log entry point. Only run on explicit user request — this
// command pushes and consumes CI (AGENTS.md「验证」).

import * as path from "node:path";
import { terminateOwnedSubprocess } from "@oh-my-pi/pi-utils/subprocess";
import { runWslStage } from "./slowtest-wsl-stage";

const repoRoot = path.resolve(import.meta.dir, "..");

const WORKFLOW_FILE = "ci.yml";
const RUN_APPEAR_TIMEOUT_MS = 5 * 60_000;
const RUN_APPEAR_POLL_MS = 10_000;
const RUN_MONITOR_POLL_MS = 30_000;
const MAX_CONSECUTIVE_GH_FAILURES = 10;

export interface GhRunSummary {
	databaseId: number;
	status: string;
	conclusion: string | null;
	headSha: string;
	createdAt: string;
	displayTitle: string;
	url: string;
}

export interface SlowtestArgs {
	debug: boolean;
}

function printUsage(): void {
	console.log("Usage: bun run slowtest [--debug]");
	console.log("  --debug  forward to fulltest (dumps raw TUI output in the UI smoke phase)");
}

export function parseSlowtestArgs(args: readonly string[]): SlowtestArgs | null {
	if (args.length === 0) return { debug: false };
	if (args.every(arg => arg === "--debug")) return { debug: true };
	printUsage();
	return null;
}

/** Pick the run this slowtest invocation triggered: same head sha, created no
 * earlier than the trigger moment (with clock-skew slack), newest first. */
export function pickTriggeredRun(
	runs: readonly GhRunSummary[],
	headSha: string,
	triggeredAtMs: number,
	runId: string,
): GhRunSummary | undefined {
	const slackMs = 60_000;
	return runs
		.filter(
			run =>
				run.headSha === headSha &&
				run.displayTitle === `CI (slowtest ${runId})` &&
				Number.isFinite(Date.parse(run.createdAt)) &&
				Date.parse(run.createdAt) >= triggeredAtMs - slackMs,
		)
		.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
}

export function conclusionExitCode(conclusion: string | null): number {
	return conclusion === "success" ? 0 : 1;
}

/** The CI stage always dispatches the release flavor: a green run creates the
 * fork Release (+fork.N tag) rather than only building download artifacts. */
export function workflowDispatchArgv(runId: string): string[] {
	return [
		"gh",
		"workflow",
		"run",
		WORKFLOW_FILE,
		"--ref",
		"main",
		"-f",
		"publish_release=true",
		"-f",
		`slowtest_run_id=${runId}`,
	];
}

function fail(message: string): never {
	console.error(`slowtest: FAIL — ${message}`);
	process.exit(1);
}

function shellQuote(value: string): string {
	if (/^[A-Za-z0-9_./:=@+-]+$/.test(value)) return value;
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Per-stage wall-clock reporting: the total time alone can't show where a
 * slowtest run spent its minutes (fulltest vs push vs CI wait). */
function logStageDone(label: string, startedAtMs: number): void {
	console.log(`slowtest: stage ${label} done in ${((performance.now() - startedAtMs) / 1000).toFixed(2)}s`);
}

function runCapture(argv: readonly string[]): { exitCode: number; stdout: string } {
	const result = Bun.spawnSync([...argv], {
		cwd: repoRoot,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	return { exitCode: result.exitCode, stdout: result.stdout?.toString("utf-8") ?? "" };
}

/** Pin the committed tree before testing and reject changes between stages. */
export function resolveSlowtestHead(expectedSha?: string, capture: typeof runCapture = runCapture): string {
	const branch = capture(["git", "rev-parse", "--abbrev-ref", "HEAD"]);
	if (branch.exitCode !== 0 || branch.stdout.trim() !== "main") {
		throw new Error("slowtest requires the current branch to be main");
	}
	const status = capture(["git", "status", "--porcelain"]);
	if (status.exitCode !== 0 || status.stdout.trim() !== "") {
		throw new Error("the working tree must be clean; all stages must validate the same committed tree");
	}
	const head = capture(["git", "rev-parse", "HEAD"]);
	const sha = head.stdout.trim();
	if (head.exitCode !== 0 || sha === "") throw new Error("could not resolve HEAD sha");
	if (expectedSha !== undefined && sha !== expectedSha) {
		throw new Error("HEAD changed during slowtest; refusing to publish a commit that was not validated");
	}
	return sha;
}

export async function waitForOwnedChild(
	child: Bun.Subprocess,
	signal: AbortSignal,
	detached: boolean,
): Promise<number> {
	let cleanup: Promise<void> | undefined;
	const { promise: cleanupFailed, reject } = Promise.withResolvers<never>();
	const cancel = () => {
		cleanup ??= terminateOwnedSubprocess(child, { detached });
		void cleanup.catch(reject);
	};
	signal.addEventListener("abort", cancel, { once: true });
	if (signal.aborted) cancel();
	try {
		const exitCode = await Promise.race([child.exited, cleanupFailed]);
		if (cleanup !== undefined) await cleanup;
		signal.throwIfAborted();
		return exitCode;
	} finally {
		signal.removeEventListener("abort", cancel);
	}
}

async function runInherit(argv: readonly string[], signal: AbortSignal): Promise<number> {
	signal.throwIfAborted();
	const detached = process.platform !== "win32";
	console.log(`$ ${argv.map(shellQuote).join(" ")}`);
	const child = Bun.spawn([...argv], {
		cwd: repoRoot,
		stdin: "ignore",
		stdout: "inherit",
		stderr: "inherit",
		detached,
	});
	// Await: `child.exited` is a Promise<number>, and returning it unchecked
	// once made every `!== 0` comparison true ("[object Promise]") — slowtest
	// could never get past its first phase.
	return await waitForOwnedChild(child, signal, detached);
}

async function main(debug: boolean): Promise<number> {
	const controller = new AbortController();
	const cancel = () => controller.abort(new Error("slowtest canceled; not continuing to push or CI"));
	process.on("SIGINT", cancel);
	process.on("SIGTERM", cancel);
	try {
		return await runPipeline(debug, controller.signal);
	} finally {
		process.off("SIGINT", cancel);
		process.off("SIGTERM", cancel);
	}
}

async function runPipeline(debug: boolean, signal: AbortSignal): Promise<number> {
	const headSha = resolveSlowtestHead();
	const fulltestStartedAt = performance.now();
	const fulltestExit = await runInherit(["bun", "run", "fulltest", ...(debug ? ["--debug"] : [])], signal);
	if (fulltestExit !== 0) fail(`fulltest failed with exit code ${fulltestExit}; not pushing or triggering CI`);
	logStageDone("fulltest", fulltestStartedAt);

	resolveSlowtestHead(headSha);
	// The WSL stage pushes the current tree itself and fails the pipeline on
	// any sync or fulltest error — nothing downstream may run after a failure.
	const wslStartedAt = performance.now();
	signal.throwIfAborted();
	const wslExit = await runWslStage();
	signal.throwIfAborted();
	if (wslExit !== 0) fail(`wsl/ubuntu-24.04 stage failed with exit code ${wslExit}; not pushing or triggering CI`);
	logStageDone("wsl/ubuntu-24.04", wslStartedAt);

	resolveSlowtestHead(headSha);

	const pushStartedAt = performance.now();
	if ((await runInherit(["git", "push", "origin", "main"], signal)) !== 0) {
		fail("git push origin main failed; resolve the remote state before re-running slowtest");
	}
	logStageDone("push", pushStartedAt);
	resolveSlowtestHead(headSha);

	if (Bun.which("gh") === null) fail("the GitHub CLI ('gh') is required to trigger and monitor the CI run");
	console.log(
		`\nslowtest: triggering ${WORKFLOW_FILE} (workflow_dispatch, publish_release=true) for ${headSha.slice(0, 12)}`,
	);
	const triggeredAtMs = Date.now();
	const runId = crypto.randomUUID();
	const triggerStartedAt = performance.now();
	if ((await runInherit(workflowDispatchArgv(runId), signal)) !== 0) {
		fail(`gh workflow run ${WORKFLOW_FILE} failed (check 'gh auth status')`);
	}

	const run = await waitForTriggeredRun(headSha, triggeredAtMs, runId, signal);
	if (run === undefined) {
		fail(`no ${WORKFLOW_FILE} run for ${headSha.slice(0, 12)} appeared within ${RUN_APPEAR_TIMEOUT_MS / 1000} s`);
	}
	logStageDone("trigger+appear", triggerStartedAt);
	console.log(`slowtest: monitoring run ${run.databaseId} — ${run.url}`);

	return await monitorRun(run, signal);
}

async function waitForTriggeredRun(
	headSha: string,
	triggeredAtMs: number,
	runId: string,
	signal: AbortSignal,
): Promise<GhRunSummary | undefined> {
	const deadline = Date.now() + RUN_APPEAR_TIMEOUT_MS;
	while (Date.now() < deadline) {
		const listed = await ghJson(
			[
				"gh",
				"run",
				"list",
				"--workflow",
				WORKFLOW_FILE,
				"--branch",
				"main",
				"--limit",
				"10",
				"--json",
				"databaseId,status,conclusion,headSha,createdAt,url,displayTitle",
			],
			"gh run list",
			signal,
		);
		if (listed !== undefined) {
			const match = pickTriggeredRun(listed as GhRunSummary[], headSha, triggeredAtMs, runId);
			if (match !== undefined) return match;
		}
		await sleep(RUN_APPEAR_POLL_MS, signal);
	}
	return undefined;
}

async function monitorRun(run: GhRunSummary, signal: AbortSignal): Promise<number> {
	let consecutiveFailures = 0;
	const monitorStartedAt = performance.now();
	for (;;) {
		const current = await ghJson(
			["gh", "run", "view", String(run.databaseId), "--json", "status,conclusion,url"],
			"gh run view",
			signal,
		);
		if (current === undefined) {
			consecutiveFailures += 1;
			if (consecutiveFailures >= MAX_CONSECUTIVE_GH_FAILURES) {
				fail(
					`gh run view failed ${consecutiveFailures} times in a row; check 'gh auth status' — run URL: ${run.url}`,
				);
			}
		} else {
			consecutiveFailures = 0;
			const status = current["status"] as string;
			const conclusion = (current["conclusion"] as string | null) ?? null;
			if (status === "completed") {
				logStageDone("monitor-ci", monitorStartedAt);
				console.log(`\nslowtest: run ${run.databaseId} completed — conclusion: ${conclusion ?? "unknown"}`);
				console.log(`slowtest: ${run.url}`);
				if (conclusion !== "success") await reportFailedJobs(run, signal);
				return conclusionExitCode(conclusion);
			}
			console.log(
				`slowtest: run ${run.databaseId} ${status} (${Math.round((Date.now() - Date.parse(run.createdAt)) / 1000)} s elapsed)`,
			);
		}
		await sleep(RUN_MONITOR_POLL_MS, signal);
	}
}

async function reportFailedJobs(run: GhRunSummary, signal: AbortSignal): Promise<void> {
	const detail = await ghJson(
		["gh", "run", "view", String(run.databaseId), "--json", "jobs"],
		"gh run view jobs",
		signal,
	);
	if (detail !== undefined && Array.isArray(detail["jobs"])) {
		const failed = (detail["jobs"] as Array<{ name: string; conclusion: string | null }>).filter(
			job => job.conclusion !== null && job.conclusion !== "success" && job.conclusion !== "skipped",
		);
		if (failed.length > 0) {
			console.log("slowtest: failed job(s):");
			for (const job of failed) console.log(`  - ${job.name} (${job.conclusion})`);
		}
	}
	console.log(`slowtest: failure logs: gh run view ${run.databaseId} --log-failed`);
}

async function ghJson(
	argv: readonly string[],
	label: string,
	signal: AbortSignal,
): Promise<Record<string, unknown> | undefined> {
	signal.throwIfAborted();
	const detached = process.platform !== "win32";
	const child = Bun.spawn([...argv], {
		cwd: repoRoot,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		detached,
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		waitForOwnedChild(child, signal, detached),
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	if (exitCode !== 0) {
		console.warn(`slowtest: ${label} failed (exit ${exitCode})${stderr.trim() === "" ? "" : `: ${stderr.trim()}`}`);
		return undefined;
	}
	try {
		return JSON.parse(stdout) as Record<string, unknown>;
	} catch (error) {
		console.warn(
			`slowtest: ${label} returned non-JSON output: ${error instanceof Error ? error.message : String(error)}`,
		);
		return undefined;
	}
}

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
	signal.throwIfAborted();
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	const timer = setTimeout(resolve, ms);
	const cancel = () => reject(signal.reason);
	signal.addEventListener("abort", cancel, { once: true });
	try {
		await promise;
	} finally {
		clearTimeout(timer);
		signal.removeEventListener("abort", cancel);
	}
}

if (import.meta.main) {
	const parsed = parseSlowtestArgs(process.argv.slice(2));
	if (parsed === null) {
		process.exitCode = 2;
	} else {
		const startedAt = performance.now();
		main(parsed.debug)
			.then(exitCode => {
				const elapsed = ((performance.now() - startedAt) / 1000).toFixed(2);
				if (exitCode === 0) {
					console.log(`\nslowtest: PASS (fulltest + wsl/ubuntu-24.04 + pushed main + CI green)`);
					console.log(`slowtest: total time ${elapsed}s`);
				} else {
					console.error(`\nslowtest: FAIL (CI conclusion not success)`);
					console.error(`slowtest: total time ${elapsed}s`);
				}
				process.exitCode = exitCode;
			})
			.catch(error => {
				console.error(`\nslowtest: FAIL — ${error instanceof Error ? error.message : String(error)}`);
				process.exitCode = 1;
			});
	}
}
