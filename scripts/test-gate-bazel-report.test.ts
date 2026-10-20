import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { recordBazelInvocation, registerBazelInvocation, reportBazelRun } from "./test-gate-bazel-report";

const ns = (milliseconds: number): bigint => BigInt(milliseconds) * 1_000_000n;

function summary(configuration: string, counts: Record<string, unknown> = { totalRunCount: 1, totalNumCached: 1 }) {
	return {
		id: { testSummary: { label: "//suite:test", configuration: { id: configuration } } },
		testSummary: { overallStatus: "PASSED", ...counts },
	};
}

function completed(configuration: string) {
	return {
		id: { targetCompleted: { label: "//suite:test", configuration: { id: configuration } } },
		completed: { success: true },
	};
}

async function invocation(
	root: string,
	runId: string,
	label: string,
	events: unknown[],
	options: { probe?: boolean; start?: number; finish?: number; traceEvents?: unknown[]; explain?: string } = {},
) {
	const bep = path.join(root, `${label}.bep.jsonl`);
	const profile = path.join(root, `${label}.profile.json`);
	await fs.writeFile(
		bep,
		[{ started: { command: "test", buildToolVersion: "8.4.0" } }, ...events]
			.map(event => JSON.stringify(event))
			.join("\n"),
	);
	await fs.writeFile(profile, JSON.stringify({ traceEvents: options.traceEvents ?? [] }));
	if (options.explain !== undefined) await fs.writeFile(path.join(root, `${label}.explain`), options.explain);
	registerBazelInvocation(runId, bep);
	await recordBazelInvocation({
		label,
		argv: ["bazel", "test", "//suite:test", ...(options.probe ? ["--check_tests_up_to_date"] : [])],
		cwd: root,
		outputBase: path.join(root, "output-base"),
		startedNs: ns(options.start ?? 10),
		finishedNs: ns(options.finish ?? 20),
		serverPidBefore: null,
		serverPidAfter: null,
		bep,
		profile,
		execution: path.join(root, `${label}.compact`),
		explain: path.join(root, `${label}.explain`),
		exitCode: 0,
	});
	return JSON.parse(await fs.readFile(`${bep}.metrics.json`, "utf8"));
}

async function report(root: string, runId: string) {
	await reportBazelRun(runId, ns(0), ns(100));
	return JSON.parse(await fs.readFile(path.join(root, `bazel-run-${runId}.metrics.json`), "utf8"));
}

test("Bazel evidence excludes probes and deduplicates configured targets without conflating action executions", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-bazel-report-"));
	const runId = path.basename(root);
	try {
		await invocation(
			root,
			runId,
			"probe",
			[summary("probe-only", { totalRunCount: 99, totalNumCached: 99 }), completed("probe-only")],
			{ probe: true },
		);
		const real = await invocation(root, runId, "real", [
			summary("linux"),
			summary("linux"),
			completed("linux"),
			completed("linux"),
			summary("windows", { totalRunCount: 2, totalNumCached: 0 }),
			completed("windows"),
			{ buildMetrics: { actionSummary: { actionsExecuted: 19 } } },
		]);
		await invocation(root, runId, "repeat", [summary("linux"), completed("linux")]);
		expect(real.tests).toMatchObject({ targetCount: 2, totalRuns: 3, cachedRuns: 1, reexecutedRuns: 2 });
		expect(real.actions.actionsExecuted).toBe(19);
		const result = await report(root, runId);
		expect(result.acceptanceTests).toMatchObject({
			targetCount: 2,
			passedTargets: 2,
			totalRuns: 3,
			cachedRuns: 1,
			reexecutedRuns: 2,
		});
		expect(result.acceptanceTargets.count).toBe(2);
		expect(
			result.acceptanceTests.targets
				.map(
					(target: { id: { testSummary: { configuration: { id: string } } } }) =>
						target.id.testSummary.configuration.id,
				)
				.sort(),
		).toEqual(["linux", "windows"]);
		expect(result.diagnosticInvocations).toEqual([path.join(root, "probe.bep.jsonl.metrics.json")]);
		const actions = result.metricColumns.find((column: { column: string }) => column.column === "实际执行动作数");
		expect(actions.value).toBe("待定位");
		expect(actions.bepActionObservations.map((entry: { label: string }) => entry.label)).toEqual(["real", "repeat"]);
		expect(actions.bepActionObservations[0].actions.actionsExecuted).toBe(19);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("Bazel evidence unions nested and parallel spans and clips invocation envelopes to the gate", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-bazel-report-"));
	const runId = path.basename(root);
	try {
		const first = await invocation(root, runId, "first", [], {
			start: -10,
			finish: 50,
			traceEvents: [
				{ name: "Launch Blaze", ph: "X", ts: 0, dur: 50_000 },
				{ name: "Launch Blaze", ph: "X", ts: 10_000, dur: 20_000 },
				{ name: "Launch Blaze", ph: "X", ts: 40_000, dur: 50_000 },
				{ name: "Analysis phase", ph: "X", ts: 20_000, dur: 20_000 },
			],
		});
		await invocation(root, runId, "nested", [], { start: 10, finish: 20 });
		await invocation(root, runId, "parallel", [], { start: 40, finish: 70 });
		await invocation(root, runId, "late", [], { start: 90, finish: 110 });
		expect(first.nativeProfile.observedIntervalsMs).toEqual({ "Launch Blaze": 90, "Analysis phase": 20 });
		expect(first.timing.nativeLaunchBlazeMs).toBe(90);
		const result = await report(root, runId);
		expect(result.gateScopeSnapshotMs).toBe(100);
		expect(result.bazelInvocationUnionMs).toBe(80);
		expect(result.outerNonBazelMs).toBe(20);
		expect(result.metricColumns.find((column: { column: string }) => column.column === "外层脚本耗时").valueMs).toBe(
			20,
		);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("Bazel evidence leaves missing native counts and missing invocation timing unresolved", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-bazel-report-"));
	const runId = path.basename(root);
	try {
		const incomplete = await invocation(root, runId, "incomplete", [summary("linux", { totalRunCount: 1 })]);
		expect(incomplete.tests).toMatchObject({
			targetCount: 1,
			totalRuns: "待定位",
			cachedRuns: "待定位",
			reexecutedRuns: "待定位",
		});
		expect(incomplete.actions.actionsExecuted).toBe("待定位");
		expect(incomplete.timing).toMatchObject({
			analysisMs: "待定位",
			loadingMs: "待定位",
			nativeLaunchBlazeMs: "待定位",
		});
		const empty = await invocation(root, runId, "no-summary", []);
		expect(empty.tests.status).toBe("待定位");
		expect(empty.tests.totalRuns).toBeUndefined();
		registerBazelInvocation(runId, path.join(root, "interrupted.bep.jsonl"));
		const result = await report(root, runId);
		expect(result.acceptanceTests).toMatchObject({
			targetCount: 1,
			totalRuns: "待定位",
			cachedRuns: "待定位",
			reexecutedRuns: "待定位",
		});
		expect(result.bazelInvocationUnionMs).toBe("待定位");
		expect(result.outerNonBazelMs).toBe("待定位");
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("Bazel feedback links only unique native action identities and preserves unresolved input causality", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-bazel-report-"));
	const runId = path.basename(root);
	const action = (label: string, output: string) => ({
		id: { actionCompleted: { label, primaryOutput: output, configuration: { id: "windows" } } },
		action: { type: "GatePrimitive", success: true },
	});
	try {
		const real = await invocation(
			root,
			runId,
			"real",
			[
				{ unstructuredCommandLine: { args: ["test", "--startup_time=108", "--command_wait_time=0"] } },
				action("//:consumer", "bazel-out/bin/consumer.success.json"),
				action("//one:duplicate", "bazel-out/bin/one/duplicate.success.json"),
				action("//two:duplicate", "bazel-out/bin/two/duplicate.success.json"),
				completed("cached"),
			],
			{
				explain: [
					"Build options: --client_env=SECRET=not-for-report",
					"Executing action 'GatePrimitive consumer.success.json': action changed since cached execution.",
					"Executing action 'GatePrimitive duplicate.success.json': no entry in the cache (action is new).",
					"Executing action 'GatePrimitive unrelated.success.json': unconditional execution is requested.",
				].join("\n"),
				traceEvents: [
					{ cat: "action processing", name: "GatePrimitive consumer.success.json", ph: "X", ts: 0, dur: 12500 },
					{ cat: "action processing", name: "GatePrimitive duplicate.success.json", ph: "X", ts: 0, dur: 9000 },
					{ cat: "action processing", name: "GatePrimitive unrelated.success.json", ph: "X", ts: 0, dur: 99000 },
				],
			},
		);
		expect(real.timing).toMatchObject({ startupMs: 108, serverLockWaitMs: 0 });
		expect(real.changeImpact).toMatchObject({
			status: "待定位",
			changedInputs: "待定位",
			execution: { source: path.join(root, "real.compact"), decoded: false },
		});
		expect(real.changeImpact.observations).toHaveLength(3);
		expect(real.changeImpact.observations[0]).toMatchObject({
			target: "//:consumer",
			action: { configuration: { id: "windows" } },
			changedInputs: "待定位",
			nativeInvalidation: {
				reason: "action changed since cached execution",
				source: `${path.join(root, "real.explain")}:2`,
			},
			rerunDurationMs: 12.5,
			durationSource: `${path.join(root, "real.profile.json")}#traceEvents[0]`,
		});
		for (const ambiguous of real.changeImpact.observations.slice(1)) {
			expect(ambiguous.nativeInvalidation).toBe("待定位");
			expect(ambiguous.rerunDurationMs).toBe("待定位");
		}
		expect(JSON.stringify(real)).not.toContain("not-for-report");
		await invocation(root, runId, "probe", [], { probe: true });
		const result = await report(root, runId);
		expect(result.changeImpact.map((entry: { label: string }) => entry.label)).toEqual(["real"]);
		expect(result.metricColumns).toHaveLength(7);
		expect(
			result.metricColumns.find((column: { column: string }) => column.column === "等待锁").observations[0],
		).toMatchObject({ valueMs: 0 });
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("Bazel feedback does not manufacture causal links or timing from incomplete native evidence", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-bazel-report-"));
	const runId = path.basename(root);
	try {
		const result = await invocation(
			root,
			runId,
			"incomplete",
			[
				{
					id: { actionCompleted: { label: "//:consumer", primaryOutput: "bazel-out/bin/result" } },
					action: { type: "GatePrimitive", success: true },
				},
			],
			{
				traceEvents: [{ cat: "action processing", name: "GatePrimitive result extra", ph: "X", ts: 0, dur: 5000 }],
			},
		);
		expect(result.timing).toMatchObject({ startupMs: "待定位", serverLockWaitMs: "待定位" });
		expect(result.changeImpact.nativeExplain).toMatchObject({ status: "待定位", errorCode: "ENOENT" });
		expect(result.changeImpact.observations[0]).toMatchObject({
			target: "//:consumer",
			changedInputs: "待定位",
			nativeInvalidation: "待定位",
			rerunDurationMs: "待定位",
		});
		await report(root, runId);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});
