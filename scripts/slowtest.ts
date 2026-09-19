#!/usr/bin/env bun
// Fork pipeline gate: run `bun run fulltest`, push local `main` to origin,
// trigger the repository's GitHub Actions CI (manual `workflow_dispatch`, no
// release), then poll the triggered run until it completes and report the
// conclusion plus the failure-log entry point. Only run on explicit user
// request — this command pushes and consumes CI (AGENTS.md「验证」).

import * as path from "node:path";

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
): GhRunSummary | undefined {
	const slackMs = 60_000;
	return runs
		.filter(
			run =>
				run.headSha === headSha &&
				Number.isFinite(Date.parse(run.createdAt)) &&
				Date.parse(run.createdAt) >= triggeredAtMs - slackMs,
		)
		.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
}

export function conclusionExitCode(conclusion: string | null): number {
	return conclusion === "success" ? 0 : 1;
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

async function runInherit(argv: readonly string[]): Promise<number> {
	console.log(`$ ${argv.map(shellQuote).join(" ")}`);
	const child = Bun.spawn([...argv], {
		cwd: repoRoot,
		stdin: "ignore",
		stdout: "inherit",
		stderr: "inherit",
	});
	// Await: `child.exited` is a Promise<number>, and returning it unchecked
	// once made every `!== 0` comparison true ("[object Promise]") — slowtest
	// could never get past its first phase.
	return await child.exited;
}

async function main(debug: boolean): Promise<number> {
	const fulltestStartedAt = performance.now();
	const fulltestExit = await runInherit(["bun", "scripts/fulltest.ts", ...(debug ? ["--debug"] : [])]);
	if (fulltestExit !== 0) fail(`fulltest failed with exit code ${fulltestExit}; not pushing or triggering CI`);
	logStageDone("fulltest", fulltestStartedAt);

	const branch = runCapture(["git", "rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim();
	if (branch !== "main") fail(`slowtest pushes local main, but the current branch is '${branch}'`);

	const headSha = runCapture(["git", "rev-parse", "HEAD"]).stdout.trim();
	if (headSha === "") fail("could not resolve HEAD sha");

	const pushStartedAt = performance.now();
	if ((await runInherit(["git", "push", "origin", "main"])) !== 0) {
		fail("git push origin main failed; resolve the remote state before re-running slowtest");
	}
	logStageDone("push", pushStartedAt);

	if (Bun.which("gh") === null) fail("the GitHub CLI ('gh') is required to trigger and monitor the CI run");
	console.log(`\nslowtest: triggering ${WORKFLOW_FILE} (workflow_dispatch, no release) for ${headSha.slice(0, 12)}`);
	const triggeredAtMs = Date.now();
	const triggerStartedAt = performance.now();
	if ((await runInherit(["gh", "workflow", "run", WORKFLOW_FILE])) !== 0) {
		fail(`gh workflow run ${WORKFLOW_FILE} failed (check 'gh auth status')`);
	}

	const run = await waitForTriggeredRun(headSha, triggeredAtMs);
	if (run === undefined) {
		fail(`no ${WORKFLOW_FILE} run for ${headSha.slice(0, 12)} appeared within ${RUN_APPEAR_TIMEOUT_MS / 1000} s`);
	}
	logStageDone("trigger+appear", triggerStartedAt);
	console.log(`slowtest: monitoring run ${run.databaseId} — ${run.url}`);

	return await monitorRun(run);
}

async function waitForTriggeredRun(headSha: string, triggeredAtMs: number): Promise<GhRunSummary | undefined> {
	const deadline = Date.now() + RUN_APPEAR_TIMEOUT_MS;
	while (Date.now() < deadline) {
		const listed = ghJson(
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
				"databaseId,status,conclusion,headSha,createdAt,url",
			],
			"gh run list",
		);
		if (listed !== undefined) {
			const match = pickTriggeredRun(listed as GhRunSummary[], headSha, triggeredAtMs);
			if (match !== undefined) return match;
		}
		await sleep(RUN_APPEAR_POLL_MS);
	}
	return undefined;
}

async function monitorRun(run: GhRunSummary): Promise<number> {
	let consecutiveFailures = 0;
	const monitorStartedAt = performance.now();
	for (;;) {
		const current = ghJson(
			["gh", "run", "view", String(run.databaseId), "--json", "status,conclusion,url"],
			"gh run view",
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
				if (conclusion !== "success") reportFailedJobs(run);
				return conclusionExitCode(conclusion);
			}
			console.log(
				`slowtest: run ${run.databaseId} ${status} (${Math.round((Date.now() - Date.parse(run.createdAt)) / 1000)} s elapsed)`,
			);
		}
		await sleep(RUN_MONITOR_POLL_MS);
	}
}

function reportFailedJobs(run: GhRunSummary): void {
	const detail = ghJson(["gh", "run", "view", String(run.databaseId), "--json", "jobs"], "gh run view jobs");
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

function ghJson(argv: readonly string[], label: string): Record<string, unknown> | undefined {
	const result = Bun.spawnSync([...argv], {
		cwd: repoRoot,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0) {
		const stderr = result.stderr?.toString("utf-8").trim();
		console.warn(`slowtest: ${label} failed (exit ${result.exitCode})${stderr === "" ? "" : `: ${stderr}`}`);
		return undefined;
	}
	try {
		return JSON.parse(result.stdout.toString("utf-8")) as Record<string, unknown>;
	} catch (error) {
		console.warn(
			`slowtest: ${label} returned non-JSON output: ${error instanceof Error ? error.message : String(error)}`,
		);
		return undefined;
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
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
					console.log(`\nslowtest: PASS (fulltest + pushed main + CI green)`);
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
