import { createReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createInterface } from "node:readline";
import { gunzip } from "node:zlib";
import { promisify } from "node:util";

const decompress = promisify(gunzip);
const pending = "待定位";
type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue => (value && typeof value === "object" ? (value as ObjectValue) : {});
const number = (value: unknown): number | null => {
	if (typeof value !== "number" && typeof value !== "string") return null;
	const result = Number(value);
	return Number.isFinite(result) ? result : null;
};
const invocations = new Map<string, Set<string>>();

export interface BazelInvocationInput {
	label: string;
	argv: string[];
	cwd: string;
	outputBase: string;
	startedNs: bigint;
	finishedNs: bigint;
	serverPidBefore: number | null;
	serverPidAfter: number | null;
	bep: string;
	profile: string;
	execution: string;
	explain: string;
	exitCode: number;
}

/** Registration is reporting identity only; it never affects target selection or caching. */
export function registerBazelInvocation(runId: string, bepPath: string): void {
	let paths = invocations.get(runId);
	if (!paths) invocations.set(runId, (paths = new Set()));
	paths.add(bepPath);
}

// Keep argv/configuration useful without disclosing cookies, headers or environment values.
function redact(value: unknown): unknown {
	if (typeof value === "string")
		return value
			.replace(/((?:--)?[\w-]*(?:env|cookie|token|password|credential|header|secret)[\w-]*=).*/i, "$1<redacted>")
			.replace(/(https?:\/\/)[^/@\s]+:[^/@\s]+@/gi, "$1<redacted>@");
	if (Array.isArray(value)) {
		let hideNext = false;
		return value.map(entry => {
			if (hideNext) {
				hideNext = false;
				return "<redacted>";
			}
			if (
				typeof entry === "string" &&
				/^--[\w-]*(?:env|cookie|token|password|credential|header|secret)[\w-]*$/i.test(entry)
			)
				hideNext = true;
			return redact(entry);
		});
	}
	if (value && typeof value === "object") {
		const fields = Object.entries(value);
		const sensitiveOption = fields.some(
			([key, entry]) =>
				key === "optionName" && /env|cookie|token|password|credential|header|secret/i.test(String(entry)),
		);
		return Object.fromEntries(
			fields.map(([key, entry]) => [
				key,
				/env|cookie|token|password|credential|header|secret/i.test(key) ||
				(sensitiveOption && /optionValue|combinedForm/.test(key))
					? "<redacted>"
					: redact(entry),
			]),
		);
	}
	return value;
}

function union(intervals: Array<[number, number]>): number {
	intervals.sort((a, b) => a[0] - b[0]);
	let total = 0;
	let end = -Infinity;
	for (const [start, finish] of intervals) {
		if (finish > end) total += finish - Math.max(start, end);
		end = Math.max(end, finish);
	}
	return total;
}

async function nativeBep(file: string): Promise<ObjectValue> {
	const summaries: ObjectValue[] = [];
	const results: ObjectValue[] = [];
	const completed: ObjectValue[] = [];
	const actions: ObjectValue[] = [];
	const clientTiming: ObjectValue = {};
	const commandLines: unknown[] = [];
	const metrics: ObjectValue = {};
	let started: unknown;
	let options: unknown;
	let finished: unknown;
	let parsedLines = 0;
	let malformedLines = 0;
	const stream = createReadStream(file, { encoding: "utf8" });
	const lines = createInterface({ input: stream, crlfDelay: Infinity });
	let inputError: Error | undefined;
	stream.on("error", error => {
		inputError = error;
		lines.close();
	});
	try {
		for await (const line of lines) {
			if (!line.trim()) continue;
			let event: ObjectValue;
			try {
				event = object(JSON.parse(line));
			} catch {
				malformedLines++;
				continue;
			}
			parsedLines++;
			if (event.started) started = event.started;
			if (event.optionsParsed) options = event.optionsParsed;
			if (event.structuredCommandLine) commandLines.push(event.structuredCommandLine);
			if (event.unstructuredCommandLine) {
				for (const arg of Array.isArray(object(event.unstructuredCommandLine).args)
					? (object(event.unstructuredCommandLine).args as unknown[])
					: []) {
					if (typeof arg !== "string") continue;
					const match = /^--(startup_time|command_wait_time)=(\d+)$/.exec(arg);
					if (match) clientTiming[match[1]!] = Number(match[2]);
				}
			}
			if (event.action) actions.push({ id: event.id, ...object(event.action) });
			if (event.buildMetrics) Object.assign(metrics, object(event.buildMetrics));
			if (event.finished) finished = event.finished;
			if (event.completed) completed.push({ id: event.id, ...object(event.completed) });
			if (event.testSummary) summaries.push({ id: event.id, ...object(event.testSummary) });
			if (event.testResult) {
				const result = object(event.testResult);
				results.push({
					id: event.id,
					status: result.status,
					cachedLocally: result.cachedLocally,
					executionInfo: result.executionInfo,
					testAttemptStart: result.testAttemptStart,
					testAttemptDuration: result.testAttemptDuration,
					testActionOutput: result.testActionOutput,
				});
			}
		}
	} finally {
		lines.close();
		stream.destroy();
	}
	if (inputError) throw inputError;
	return {
		source: file,
		parsedLines,
		malformedLines,
		started,
		options,
		commandLines,
		metrics,
		finished,
		clientTiming,
		completedActions: actions,
		testSummaries: summaries,
		testResults: results,
		completedTargets: completed,
	};
}

async function nativeProfile(file: string): Promise<ObjectValue> {
	const raw = await fs.readFile(file);
	const profile = object(JSON.parse((file.endsWith(".gz") ? await decompress(raw) : raw).toString("utf8")));
	const events = Array.isArray(profile.traceEvents) ? profile.traceEvents.map(object) : [];
	const observed: Record<string, Array<[number, number]>> = {};
	const actionTimings: ObjectValue[] = [];
	for (const [index, event] of events.entries()) {
		const start = number(event.ts);
		const duration = number(event.dur);
		if (event.ph !== "X" || start === null || duration === null) continue;
		if (event.cat === "action processing") {
			actionTimings.push({
				description: event.name,
				durationMs: duration / 1000,
				source: `${file}#traceEvents[${index}]`,
			});
		}
		const name = String(event.name ?? "");
		// Exact native labels only. Do not conflate action-resource waits with the server command lock.
		if (
			!/^(?:Launch Blaze|bazel startup|Extracting Bazel installation|Waiting for server lock|waiting for command lock|Client waiting|Launch server|Loading phase|Analysis phase|Execution phase|Launch phase|Initialize command)$/.test(
				name,
			)
		)
			continue;
		(observed[name] ??= []).push([start, start + duration]);
	}
	const phaseMarkers = events
		.filter(event => event.cat === "build phase marker")
		.map(event => ({ name: event.name, ts: event.ts, dur: event.dur, ph: event.ph }));
	return {
		source: file,
		eventCount: events.length,
		otherData: profile.otherData,
		phaseMarkers,
		actionTimings,
		observedIntervalsMs: Object.fromEntries(
			Object.entries(observed).map(([name, spans]) => [name, union(spans) / 1000]),
		),
		timingNote:
			"Native trace ts/dur are microseconds in the profile's own clock domain; otherData.profile_start_ts, when present, is Bazel's raw epoch-ms anchor, not gate-clock alignment. Instant phase markers do not establish separate loading/analysis durations.",
	};
}

async function observe(work: () => Promise<ObjectValue>, source: string): Promise<ObjectValue> {
	try {
		return await work();
	} catch (error) {
		return {
			source,
			status: pending,
			errorCode: (error as NodeJS.ErrnoException).code ?? "UNREADABLE_NATIVE_EVIDENCE",
		};
	}
}

async function nativeExplain(file: string): Promise<ObjectValue> {
	const text = await fs.readFile(file, "utf8");
	const reasons: ObjectValue[] = [];
	for (const [index, line] of text.split(/\r?\n/).entries()) {
		const match = /^Executing action '(.+)': (.+)\.$/.exec(line);
		if (match) reasons.push({ description: match[1], reason: match[2], source: `${file}:${index + 1}` });
	}
	return { source: file, reasons };
}

function changeImpact(bep: ObjectValue, profile: ObjectValue, explain: ObjectValue, execution: string): ObjectValue {
	const actions = Array.isArray(bep.completedActions) ? bep.completedActions.map(object) : [];
	const reasons = Array.isArray(explain.reasons) ? explain.reasons.map(object) : [];
	const timings = Array.isArray(profile.actionTimings) ? profile.actionTimings.map(object) : [];
	const description = (action: ObjectValue): string | null => {
		const output = object(object(action.id).actionCompleted).primaryOutput;
		return typeof action.type === "string" && typeof output === "string"
			? `${action.type} ${output.split("/").pop()}`
			: null;
	};
	const observations = actions.map(action => {
		const name = description(action);
		// Native prettyPrint uses the output basename for these actions. Never join
		// ambiguous basenames/configurations or approximate profile names.
		const unique = name !== null && actions.filter(candidate => description(candidate) === name).length === 1;
		const matchedReasons = unique ? reasons.filter(reason => reason.description === name) : [];
		const matchedTimings = unique ? timings.filter(timing => timing.description === name) : [];
		return {
			action: object(action.id).actionCompleted ?? pending,
			target: object(object(action.id).actionCompleted).label ?? pending,
			source: `${bep.source}#actionCompleted`,
			changedInputs: pending,
			nativeInvalidation: matchedReasons.length === 1 ? matchedReasons[0] : pending,
			rerunDurationMs: matchedTimings.length === 1 ? matchedTimings[0]!.durationMs : pending,
			durationSource: matchedTimings.length === 1 ? matchedTimings[0]!.source : pending,
		};
	});
	return {
		status: pending,
		changedInputs: pending,
		observations,
		nativeExplain: explain,
		execution: { source: execution || pending, decoded: false },
		note: "Partial native attribution only: unique BEP action type/output basename joins exact explain/profile descriptions. Action-processing duration is not cache-free process CPU or run payload time. Native reasons do not identify changed input files; no source-file causal edge is inferred from changed-file lists, target completion, or action execution. Missing/ambiguous links remain 待定位; compact retained, not decoded.",
	};
}

function countTests(bep: ObjectValue): ObjectValue {
	const unique = new Map<string | ObjectValue, ObjectValue>();
	for (const summary of Array.isArray(bep.testSummaries) ? bep.testSummaries.map(object) : []) {
		const id = object(summary.id).testSummary ?? summary.id;
		// Use the native configured-target identity, matching run-level aggregation.
		// Missing IDs must not collapse unrelated observations into one target.
		unique.set(id === undefined ? summary : JSON.stringify(id), summary);
	}
	const summaries = [...unique.values()];
	if (!summaries.length) return { source: `${bep.source}#testSummary`, status: pending };
	let total = 0;
	let cached = 0;
	let complete = true;
	for (const summary of summaries) {
		const runs = number(summary.totalRunCount);
		const hits = number(summary.totalNumCached);
		// Proto JSON can omit zero defaults. Do not invent a value when this invocation does not expose it.
		if (runs === null || hits === null) {
			complete = false;
			continue;
		}
		total += runs;
		cached += hits;
	}
	return {
		source: `${bep.source}#testSummary`,
		targetCount: summaries.length,
		totalRuns: complete ? total : pending,
		cachedRuns: complete ? cached : pending,
		reexecutedRuns: complete ? total - cached : pending,
		note: "Counts are test actions (runs/shards/attempts), not JUnit cases; cached durations and XML are historical, not new execution.",
	};
}

/** Best-effort finally evidence: reporting must never replace the original command failure. */
export async function recordBazelInvocation(input: BazelInvocationInput): Promise<void> {
	try {
		const [bep, profile, explain] = await Promise.all([
			input.bep
				? observe(() => nativeBep(input.bep), input.bep)
				: Promise.resolve<ObjectValue>({ source: "Native query has no BEP", status: pending }),
			observe(() => nativeProfile(input.profile), input.profile),
			input.explain
				? observe(() => nativeExplain(input.explain), input.explain)
				: Promise.resolve<ObjectValue>({ source: "Native query has no explain", status: pending }),
		]);
		const metrics = object(bep.metrics);
		const action = object(metrics.actionSummary);
		const diagnostic = input.argv.some(arg => /^--check_(?:tests_)?up_to_date(?:=true)?$/.test(arg));
		const command = String(
			object(bep.started).command ??
				input.argv.find(arg => /^(?:build|test|run|query|cquery)$/.test(arg)) ??
				pending,
		);
		const report = {
			schemaVersion: 1,
			label: input.label,
			argv: redact(input.argv),
			cwd: input.cwd,
			outputBase: input.outputBase,
			serverPidBefore: input.serverPidBefore ?? pending,
			serverPidAfter: input.serverPidAfter ?? pending,
			exitCode: input.exitCode,
			diagnostic,
			command,
			runPayload:
				command === "run"
					? "With --script_path, this native-client span ends after launcher script generation. The separately supervised always-run payload is included in outer non-Bazel residual, not native BEP/profile execution."
					: undefined,
			runPayloadWallMs: command === "run" ? pending : undefined,
			startedNs: input.startedNs.toString(),
			finishedNs: input.finishedNs.toString(),
			invocationWallMs: Number(input.finishedNs - input.startedNs) / 1e6,
			clock: "gateClockNanoseconds; elapsed invocation envelope, not summed native phases",
			artifacts: {
				bep: input.bep || "Not supported by native query",
				profile: input.profile,
				execution: input.execution || "Not supported by native query",
				explain: input.explain || "Not supported by native query",
			},
			version: object(bep.started).buildToolVersion ?? object(profile.otherData).bazel_version ?? pending,
			startupOptions: redact(object(bep.options).startupOptions ?? pending),
			configuration: redact(bep.commandLines ?? pending),
			nativeBep: redact(bep),
			nativeProfile: redact(profile),
			changeImpact: redact(changeImpact(bep, profile, explain, input.execution)),
			timing: {
				source: input.bep ? `${input.bep}#buildMetrics.timingMetrics` : `${input.profile}#traceEvents`,
				...object(metrics.timingMetrics),
				startupMs: object(bep.clientTiming).startup_time ?? pending,
				serverLockWaitMs: object(bep.clientTiming).command_wait_time ?? pending,
				clientTimingSource: `${input.bep}#unstructuredCommandLine.args (--startup_time/--command_wait_time, native ms)`,
				loadingMs: pending,
				analysisMs: object(metrics.timingMetrics).analysisPhaseTimeInMs ?? pending,
				nativeLaunchBlazeMs: object(profile.observedIntervalsMs)["Launch Blaze"] ?? pending,
				profileSource: `${input.profile}#traceEvents`,
				note: "Launch Blaze is the exact native phase label, not an inferred server-startup duration. See profile observedIntervalsMs and phaseMarkers; absent native durations remain 待定位. Phases may overlap.",
			},
			actions: {
				source: input.bep ? `${input.bep}#buildMetrics.actionSummary` : "Native query has no BEP actionSummary",
				...action,
				actionsExecuted: action.actionsExecuted ?? pending,
				localExecutionCount: pending,
				remoteCacheHits: pending,
				skyframeCacheHits: pending,
				note: "BEP actionsExecuted excludes local action cache hits but includes remote cache hits; it is not a cache-free execution count. Compact log retained, not decoded.",
			},
			tests: countTests(bep),
		};
		await fs.writeFile(`${input.bep || input.profile}.metrics.json`, `${JSON.stringify(report, null, 2)}\n`);
	} catch {
		// Hard cancellation may prevent even this write. Missing evidence is never interpreted as PASS.
	}
}

/** Gate-internal snapshot, not the pair wrapper's spawn-to-exit acceptance wall clock. */
export async function reportBazelRun(runId: string, startedNs: bigint, finishedNs: bigint): Promise<void> {
	const paths = [...(invocations.get(runId) ?? [])];
	const records: ObjectValue[] = [];
	const intervals: Array<[number, number]> = [];
	const acceptedTests = new Map<string, ObjectValue>();
	const acceptedTargets = new Map<string, ObjectValue>();
	const diagnosticInvocations: string[] = [];
	let missing = paths.length === 0;
	for (const bep of paths) {
		try {
			const record = object(JSON.parse(await fs.readFile(`${bep}.metrics.json`, "utf8")));
			const start = BigInt(String(record.startedNs));
			const finish = BigInt(String(record.finishedNs));
			const clippedStart = start < startedNs ? startedNs : start;
			const clippedFinish = finish > finishedNs ? finishedNs : finish;
			if (clippedFinish > clippedStart)
				intervals.push([Number(clippedStart - startedNs) / 1e6, Number(clippedFinish - startedNs) / 1e6]);
			records.push({ metrics: `${bep}.metrics.json`, ...record });
			if (!record.diagnostic) {
				const native = object(record.nativeBep);
				const completed = Array.isArray(native.completedTargets) ? native.completedTargets.map(object) : [];
				for (const target of completed) {
					const identity = JSON.stringify(object(target.id).targetCompleted ?? target.id);
					const previous = acceptedTargets.get(identity);
					const sources = Array.isArray(previous?.sources) ? previous.sources : [];
					acceptedTargets.set(identity, { ...target, sources: [...sources, `${bep}#completed`] });
				}
			}
			if (record.diagnostic) diagnosticInvocations.push(`${bep}.metrics.json`);
			else if (record.command === "test") {
				const native = object(record.nativeBep);
				const summaries = Array.isArray(native.testSummaries) ? native.testSummaries.map(object) : [];
				for (const test of summaries) {
					const identity = JSON.stringify(object(test.id).testSummary ?? test.id);
					const previous = acceptedTests.get(identity);
					const sources = Array.isArray(previous?.sources) ? previous.sources : [];
					acceptedTests.set(identity, { ...test, sources: [...sources, `${bep}#testSummary`] });
				}
			}
		} catch {
			missing = true;
			records.push({ metrics: `${bep}.metrics.json`, status: pending });
		}
	}
	const wall = Number(finishedNs - startedNs) / 1e6;
	const occupied = union(intervals);
	const nativeSources = records.map(record => ({ label: record.label, artifacts: record.artifacts }));
	const acceptanceTestCounts = countTests({
		source: "acceptanceTests.targets[].sources",
		testSummaries: [...acceptedTests.values()],
	});
	const metricColumns = [
		{
			column: "总耗时",
			value: pending,
			source:
				"External pair spawn→exit including stdout/stderr drain; supplied by pair evidence, not this gate snapshot.",
			gateScopeSnapshotMs: wall,
		},
		{
			column: "启动",
			value: pending,
			sources: nativeSources,
			observations: records.map(record => ({ label: record.label, timing: record.timing })),
			note: "Native client --startup_time is reported per invocation when present; Launch Blaze is not relabeled as server startup. No sum across overlapping clients.",
		},
		{
			column: "等待锁",
			value: pending,
			sources: nativeSources,
			observations: records.map(record => ({
				label: record.label,
				valueMs: object(record.timing).serverLockWaitMs ?? pending,
				source: object(record.timing).clientTimingSource ?? pending,
			})),
			note: "Native client --command_wait_time when present; missing command-lock duration stays 待定位, never substituted with action-resource waits.",
		},
		{
			column: "加载/分析",
			sources: nativeSources,
			value: records.map(record => ({ label: record.label, timing: record.timing })),
			note: "Native per-invocation timings, not summed overlapping phase spans; absent loading fields remain 待定位.",
		},
		{
			column: "实际执行动作数",
			value: pending,
			sources: nativeSources,
			bepActionObservations: records
				.filter(record => !record.diagnostic)
				.map(record => ({ label: record.label, actions: record.actions })),
			note: "BEP actionsExecuted includes remote-cache hits; compact log retained but not decoded, so no cache-free execution total is fabricated.",
		},
		{
			column: "测试缓存命中/重跑数",
			value: acceptanceTestCounts,
			source: "acceptanceTests.targets[].sources",
			note: "Deduplicated native test actions; diagnostic probe summaries excluded.",
		},
		{
			column: "外层脚本耗时",
			valueMs: missing ? pending : wall - occupied,
			source:
				"Gate scope monotonic snapshot minus union of invocation startedNs/finishedNs; see invocations[].metrics.",
			note: "Gate-internal pre-summary-I/O boundary only; includes separately supervised --script_path payloads. External pair wall also includes summary I/O and process exit.",
		},
	];
	const summary = {
		schemaVersion: 1,
		runId,
		startedNs: startedNs.toString(),
		finishedNs: finishedNs.toString(),
		boundary:
			"Gate scope start through pre-summary-I/O sample; excludes this summary I/O and later gate/process exit. External pair wall is authoritative and includes them.",
		gateScopeSnapshotMs: wall,
		bazelInvocationUnionMs: missing ? pending : occupied,
		outerNonBazelMs: missing ? pending : wall - occupied,
		note: "Union of native-client invocation envelopes, not sum of parallel commands. Non-Bazel time includes separately supervised --script_path run payloads, preparation/reporting/cleanup outside those envelopes; it is not CPU time. Missing or force-killed records leave attribution unresolved.",
		metricColumns,
		acceptanceTests: {
			...acceptanceTestCounts,
			passedTargets: [...acceptedTests.values()].filter(test => test.overallStatus === "PASSED").length,
			targets: [...acceptedTests.values()],
			note: "Deduplicated by native testSummary ID (label/configuration); probe summaries excluded. This evidence report does not decide gate success or required-target completeness.",
		},
		acceptanceTargets: {
			count: acceptedTargets.size,
			targets: [...acceptedTargets.values()],
			note: "Deduplicated native targetCompleted IDs; diagnostic probe targets excluded, required-target completeness remains the driver's responsibility.",
		},
		changeImpact: records
			.filter(record => !record.diagnostic)
			.map(record => ({ label: record.label, metrics: record.metrics, feedback: record.changeImpact ?? pending })),
		diagnosticInvocations,
		invocations: records,
	};
	if (paths.length) {
		const destination = path.join(
			path.dirname(paths[0]!),
			`bazel-run-${runId.replace(/[^a-zA-Z0-9_-]/g, "_")}.metrics.json`,
		);
		await fs.writeFile(destination, `${JSON.stringify(summary, null, 2)}\n`);
		console.log(`bazel evidence: ${destination}`);
	}
	console.log(
		`bazel timing: gate_scope_snapshot_ms=${wall.toFixed(1)} invocation_union_ms=${missing ? pending : occupied.toFixed(1)} outer_non_bazel_ms=${missing ? pending : (wall - occupied).toFixed(1)}; external pair wall includes final report/exit`,
	);
	invocations.delete(runId);
}
