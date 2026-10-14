import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { GateRun } from "./test-gate-runtime";

const reportRoot = path.join(import.meta.dir, "..", "runs", "test-timing");

export interface TestReportRun {
	id: string;
	dir: string;
	startedAt: string;
	startedMs: number;
	scope: string;
	owner: boolean;
	sourceRevision: string | null;
	dirtyState: string | null;
	dirtyStateIdentity: string | null;
}

export interface TestProducerRecord {
	producer: string;
	command: string[];
	scope: string;
	concurrency?: number | string;
	attempt?: number;
	logicalGroup?: string;
	startedAt: string;
	durationSeconds: number;
	exitCode: number;
	reportPath?: string;
	status?: string;
	timingBasis?: string;
	runnerVersion?: string;
}

/** Command-level cases are only for a single observable CLI probe, never a whole multi-case runner. */
export async function writeCommandCase(
	reportPath: string,
	suite: string,
	name: string,
	durationSeconds: number,
	outcome: "passed" | "failed" | "error",
): Promise<void> {
	if (!Number.isFinite(durationSeconds) || durationSeconds < 0)
		throw new Error(`Invalid command case duration: ${name}`);
	const escapeXml = (text: string) =>
		text
			.replaceAll("&", "&amp;")
			.replaceAll("<", "&lt;")
			.replaceAll(">", "&gt;")
			.replaceAll('"', "&quot;")
			.replaceAll("'", "&apos;");
	const failure =
		outcome === "passed" ? "" : `<${outcome === "failed" ? "failure" : "error"} message="Command ${outcome}"/>`;
	const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="${escapeXml(suite)}" tests="1" failures="${outcome === "failed" ? 1 : 0}" errors="${outcome === "error" ? 1 : 0}"><testcase classname="${escapeXml(suite)}" name="${escapeXml(name)}" time="${durationSeconds.toFixed(6)}">${failure}</testcase></testsuite>\n`;
	await Bun.write(reportPath, xml);
}

function gitResult(...args: string[]): string | null {
	try {
		const result = Bun.spawnSync(["git", ...args], {
			cwd: path.join(import.meta.dir, ".."),
			stdout: "pipe",
			stderr: "ignore",
		});
		return result.exitCode === 0 ? result.stdout.toString().trimEnd() : null;
	} catch {
		return null;
	}
}

export async function beginTestRun(scope: string): Promise<TestReportRun> {
	const owner = !process.env.OMP_TEST_REPORT_DIR;
	const id = owner
		? `${new Date().toISOString().replaceAll(":", "-")}-${process.pid}-${randomUUID().slice(0, 8)}`
		: (process.env.OMP_TEST_RUN_ID ?? path.basename(process.env.OMP_TEST_REPORT_DIR!));
	const dir = owner ? path.join(reportRoot, id) : path.resolve(process.env.OMP_TEST_REPORT_DIR!);
	await fs.mkdir(dir, { recursive: true });
	process.env.OMP_TEST_REPORT_DIR = dir;
	process.env.OMP_TEST_RUN_ID = id;
	const revision = owner ? gitResult("rev-parse", "HEAD") : null;
	const dirty = owner ? gitResult("status", "--porcelain", "--untracked-files=all") : null;
	const diff = owner && dirty ? gitResult("diff", "--no-ext-diff", "--binary", "HEAD") : null;
	const run: TestReportRun = {
		id,
		dir,
		startedAt: new Date().toISOString(),
		startedMs: performance.now(),
		scope,
		owner,
		sourceRevision: revision,
		dirtyState: dirty === null ? null : dirty === "" ? "clean" : "dirty",
		dirtyStateIdentity:
			dirty === null || (dirty && diff === null)
				? null
				: createHash("sha256")
						.update(dirty)
						.update(diff ?? "")
						.digest("hex"),
	};
	if (owner) await writeRun(run, "running", null, []);
	return run;
}

/** The name is a hint for humans; the UUID prevents shard, process and retry collisions. */
export function testReportPath(label: string): string {
	const dir = process.env.OMP_TEST_REPORT_DIR;
	if (!dir) throw new Error("Test report run was not initialized");
	const name = label.replaceAll(/[^A-Za-z0-9_.-]/g, "-").slice(0, 90) || "tests";
	return path.join(dir, `${name}-${randomUUID().slice(0, 12)}.xml`);
}

/** Independent files allow concurrent producers to finish without a shared metadata-write race. */
export async function recordTestProducer(info: TestProducerRecord): Promise<void> {
	const dir = process.env.OMP_TEST_REPORT_DIR;
	if (!dir) throw new Error("Test report run was not initialized");
	let report: "available" | "missing" | "not-supported" = info.reportPath ? "missing" : "not-supported";
	if (info.reportPath) {
		try {
			const stat = await fs.stat(info.reportPath);
			if (stat.size > 0 && stat.isFile()) report = "available";
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	const producer = {
		...info,
		reportPath: info.reportPath ? path.relative(dir, info.reportPath).replaceAll(path.sep, "/") : null,
		report,
		status: report === "missing" ? "partial" : (info.status ?? (info.exitCode === 0 ? "passed" : "failed")),
		timingBasis: info.timingBasis ?? "unavailable",
	};
	await Bun.write(path.join(dir, `${randomUUID()}.producer.json`), `${JSON.stringify(producer, null, 2)}\n`);
	if (report === "missing") {
		console.error(`Missing test timing report for ${info.producer}: ${info.reportPath}`);
	}
}

/** Gate reports settle after owned work, and are republished if finalization itself cancels the gate. */
export function finalizeTestRun(gate: GateRun, run: TestReportRun, unreconciledScope?: string): void {
	if (!run.owner) return;
	let prepared: Promise<ReconciledTestRun> | undefined;
	gate.onFinalize(async exitCode => {
		try {
			prepared ??= reconcileTestRun(run, gate);
			const { producers, reconciliation } = await prepared;
			await writeTestRun(run, exitCode, producers, reconciliation, unreconciledScope);
		} catch (error) {
			// A failed outcome write must not leave an earlier complete/0 report.
			try {
				await fs.unlink(path.join(run.dir, "run.json"));
			} catch (removeError) {
				if ((removeError as NodeJS.ErrnoException).code !== "ENOENT")
					throw new AggregateError([error, removeError], "Could not finalize or invalidate test timing metadata");
			}
			throw error;
		}
	});
}

export async function endTestRun(run: TestReportRun, exitCode: number, unreconciledScope?: string): Promise<void> {
	if (!run.owner) return;
	const { producers, reconciliation } = await reconcileTestRun(run);
	await writeTestRun(run, exitCode, producers, reconciliation, unreconciledScope);
}

type ReportProducer = TestProducerRecord & { report: string; reportPath: string | null };
interface ReportReconciliation {
	status: string;
	cases?: number;
	executed?: number;
	failures?: number;
	python?: string;
	reason?: string;
}
interface ReconciledTestRun {
	producers: ReportProducer[];
	reconciliation: ReportReconciliation;
}

async function reconcileTestRun(run: TestReportRun, gate?: GateRun): Promise<ReconciledTestRun> {
	const files = (await fs.readdir(run.dir)).filter(file => file.endsWith(".producer.json"));
	const producers = await Promise.all(
		files.map(async file => JSON.parse(await Bun.file(path.join(run.dir, file)).text()) as ReportProducer),
	);
	const available = producers.filter(producer => producer.report === "available" && producer.reportPath);
	let reconciliation: ReportReconciliation = {
		status: "unavailable",
		reason: "No XML files to reconcile",
	};
	if (available.length > 0) {
		const verifier = `
import json, math, pathlib, sys, xml.etree.ElementTree as ET
cases = executed = failures = 0
directory = pathlib.Path(sys.argv[1])
for producer in directory.glob("*.producer.json"):
    record = json.loads(producer.read_text(encoding="utf-8"))
    if record.get("report") != "available":
        continue
    path = directory / record["reportPath"]
    root = ET.parse(path).getroot()
    if root.tag.rsplit("}", 1)[-1] not in ("testsuite", "testsuites"):
        raise ValueError("not a JUnit suite: " + str(path))
    for item in root.iter():
        if item.tag.rsplit("}", 1)[-1] != "testcase":
            continue
        if not item.get("name"):
            raise ValueError("case has no name: " + str(path))
        cases += 1
        skipped = any(child.tag.rsplit("}", 1)[-1] == "skipped" for child in item)
        failed = any(child.tag.rsplit("}", 1)[-1] in ("failure", "error") for child in item)
        failures += int(failed)
        if skipped:
            continue
        executed += 1
        raw = item.get("time")
        if raw is None or not math.isfinite(float(raw)) or float(raw) < 0:
            raise ValueError("executed case has invalid time: " + str(path))
print(json.dumps({"status": "validated", "cases": cases, "executed": executed, "failures": failures, "python": sys.version.split()[0]}))
`;
		try {
			const python = process.platform === "win32" ? "python" : "python3";
			if (gate) {
				if (gate.signal.aborted) throw gate.signal.reason;
				// Invalid XML remains a partial report, as for standalone producers.
				// The verifier process itself is owned and cancellable by the gate.
				const guardedVerifier = `import json\ntry:\n exec(${JSON.stringify(verifier)})\nexcept Exception as error:\n print(json.dumps({"status": "invalid", "reason": str(error)[-600:]}))`;
				const result = await gate.capture({
					label: "test/timing XML reconciliation",
					argv: [python, "-c", guardedVerifier, run.dir],
				});
				reconciliation = JSON.parse(result.stdout);
			} else {
				const result = Bun.spawnSync([python, "-c", verifier, run.dir], {
					stdout: "pipe",
					stderr: "pipe",
				});
				reconciliation =
					result.exitCode === 0
						? JSON.parse(result.stdout.toString())
						: {
								status: "invalid",
								reason: result.stderr.toString().trim().slice(-600) || `XML verifier exit ${result.exitCode}`,
							};
			}
		} catch (error) {
			reconciliation = { status: "unavailable", reason: `XML verifier unavailable: ${String(error)}` };
		}
	}
	return { producers, reconciliation };
}

async function writeTestRun(
	run: TestReportRun,
	exitCode: number,
	producers: ReportProducer[],
	reconciliation: ReportReconciliation,
	unreconciledScope?: string,
): Promise<void> {
	const completion =
		!unreconciledScope &&
		exitCode === 0 &&
		reconciliation.status === "validated" &&
		reconciliation.cases! > 0 &&
		reconciliation.failures === 0 &&
		producers.some(producer => producer.report === "available") &&
		producers.every(
			producer =>
				(producer.report === "available" && producer.status !== "partial" && producer.status !== "unsupported") ||
				(producer.report === "not-supported" && producer.status === "stage"),
		)
			? "complete"
			: "partial";
	await writeRun(run, completion, exitCode, producers, reconciliation, unreconciledScope);
	if (reconciliation.status !== "validated")
		console.error(`Test timing XML ${reconciliation.status}: ${reconciliation.reason}`);
	console.log(`Test timing: ${path.join(run.dir, "run.json")} (${completion})`);
}

async function writeRun(
	run: TestReportRun,
	completion: string,
	exitCode: number | null,
	producers: TestProducerRecord[],
	reconciliation: {
		status: string;
		cases?: number;
		executed?: number;
		failures?: number;
		python?: string;
		reason?: string;
	} | null = null,
	unreconciledScope: string | null = null,
): Promise<void> {
	await Bun.write(
		path.join(run.dir, "run.json"),
		`${JSON.stringify(
			{
				runId: run.id,
				startedAtUtc: run.startedAt,
				sourceRevision: run.sourceRevision,
				dirtyState: run.dirtyState,
				dirtyStateIdentity: run.dirtyStateIdentity,
				dirtyStateIdentityBasis: "git status plus tracked diff; untracked file names, not their contents",
				platform: process.platform,
				architecture: process.arch,
				runtimeVersions: {
					bun: Bun.version,
					node: process.versions.node,
					python: reconciliation?.python ?? null,
					rust: null,
				},
				runnerVersions: {
					bun: Bun.version,
					...Object.fromEntries(producers.map(producer => [producer.producer, producer.runnerVersion ?? null])),
				},
				scope: run.scope,
				wallSeconds: completion === "running" ? null : (performance.now() - run.startedMs) / 1000,
				exitCode,
				completion,
				coverage: completion === "complete" ? "selected-producers-only" : "partial-or-unverified",
				unreconciledScope,
				reconciliation,
				producers,
			},
			null,
			2,
		)}\n`,
	);
}
