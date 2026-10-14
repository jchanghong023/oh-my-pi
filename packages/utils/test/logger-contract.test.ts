import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const fixtureDir = path.join(import.meta.dir, "fixtures");
const probePath = path.join(fixtureDir, "logger-contract-probe.ts");
const fatalProbePath = path.join(fixtureDir, "logger-fatal-flush-probe.ts");
const preloadPath = path.join(fixtureDir, "logger-fixed-date-preload.ts");
const fixedNow = "2026-01-02T03:04:05.006Z";
const fixedTimestamp = "2026-01-01T22:04:05.006-05:00";
const roots: string[] = [];

interface ScenarioResult {
	readonly pid: number;
	readonly root: string;
	readonly primaryDir: string;
	readonly secondaryDir: string;
	readonly resultPath: string;
	readonly stdout: string;
	readonly stderr: string;
}

afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

async function runScenario(
	scenario: string,
	options: { logLevel?: string; probe?: string; exitCode?: number } = {},
): Promise<ScenarioResult> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-logger-contract-"));
	roots.push(root);
	const primaryDir = path.join(root, "primary");
	const secondaryDir = path.join(root, "secondary");
	const resultPath = path.join(root, "result.json");
	const stdoutPath = path.join(root, "stdout.log");
	await Promise.all([fs.mkdir(primaryDir), fs.mkdir(secondaryDir)]);
	const proc = Bun.spawn(
		[
			process.execPath,
			"--preload",
			preloadPath,
			options.probe ?? probePath,
			scenario,
			primaryDir,
			secondaryDir,
			resultPath,
		],
		{
			cwd: path.resolve(import.meta.dir, "../../.."),
			env: {
				...process.env,
				HOME: primaryDir,
				// os.homedir() on Windows reads USERPROFILE, not HOME: without
				// this the default-file scenario logs into the real profile.
				USERPROFILE: primaryDir,
				LOCALAPPDATA: path.join(root, "local"),
				PI_CONFIG_DIR: ".omp",
				OMP_CONFIG_ROOT: "",
				OMP_PROFILE: "",
				PI_PROFILE: "",
				XDG_DATA_HOME: "",
				XDG_STATE_HOME: "",
				XDG_CACHE_HOME: "",
				// Empty XDG_CACHE_HOME makes Bun's transpiler cache path relative,
				// spewing bun/@t@/*.pile into the repo root (the child's cwd) — disable it.
				BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
				OMP_LOGGER_TEST_NOW: fixedNow,
				OMP_LOG_LEVEL: options.logLevel ?? "",
				TZ: "Etc/GMT+5",
			},
			stdout: Bun.file(stdoutPath),
			stderr: "pipe",
		},
	);
	const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
	expect(exitCode, stderr).toBe(options.exitCode ?? 0);
	const stdout = await fs.readFile(stdoutPath, "utf8");
	return { pid: proc.pid, root, primaryDir, secondaryDir, resultPath, stdout, stderr };
}

async function logFileNames(directory: string): Promise<string[]> {
	return (await fs.readdir(directory))
		.filter(name => /^omp\.\d{4}-\d{2}-\d{2}\.\d+\.log(?:\.\d+)?$/.test(name))
		.sort();
}

async function readSingleLog(directory: string): Promise<{ name: string; text: string }> {
	const names = await logFileNames(directory);
	expect(names).toHaveLength(1);
	const name = names[0];
	if (!name) throw new Error("expected one log file");
	return { name, text: await fs.readFile(path.join(directory, name), "utf8") };
}

interface LogEntry {
	readonly level: string;
	readonly message: string;
}

async function readLogEntries(directory: string): Promise<LogEntry[]> {
	const lines = (await readSingleLog(directory)).text.split(os.EOL).filter(line => line.length > 0);
	return lines.map(line => {
		const entry: LogEntry = JSON.parse(line);
		return entry;
	});
}

function expectedLine(
	pid: number,
	level: "error" | "warn" | "info" | "debug",
	message: string,
	context: Record<string, unknown> = {},
	timestamp = fixedTimestamp,
): string {
	return `${JSON.stringify({ timestamp, level, pid, message, ...context })}${os.EOL}`;
}

describe("central logger byte contract", () => {
	test("pins levels, metadata normalization, key order, timestamp, errors, pid, and EOL", async () => {
		const result = await runScenario("matrix");
		expect(result.stdout).toBe("");
		expect(result.stderr).toBe("");
		const log = await readSingleLog(result.primaryDir);
		expect(log.name).toBe(`omp.2026-01-01.${result.pid}.log`);
		const expected = [
			expectedLine(result.pid, "error", "level-error", { ordinal: 1 }),
			expectedLine(result.pid, "warn", "level-warn", { ordinal: 2 }),
			expectedLine(result.pid, "info", "level-info", { ordinal: 3 }),
			expectedLine(result.pid, "debug", "level-debug", { ordinal: 4 }),
			expectedLine(result.pid, "info", "context-matrix", {
				stringValue: "text",
				numberValue: 7,
				booleanValue: false,
				nullValue: null,
				nested: { alpha: "a", values: [1, null, null, null] },
				infinity: null,
				nan: null,
			}),
			expectedLine(result.pid, "warn", "reserved-primary metadata-message", { before: "first", after: "last" }),
			expectedLine(result.pid, "debug", "reserved-falsy", { after: true }),
			expectedLine(result.pid, "error", "error-matrix", {
				error: {
					name: "CustomError",
					message: "upstream",
					stack: "OUTER_STACK",
					code: "E_FIXTURE",
					detail: { retry: false },
					cause: { name: "Error", message: "downstream", stack: "CAUSE_STACK" },
				},
			}),
			expectedLine(result.pid, "error", "tojson-error", {
				wrapped: { err: { name: "Error", message: "wrapped", stack: "WRAPPED_STACK" } },
			}),
		].join("");
		expect(log.text).toBe(expected);
		expect(log.text.endsWith(os.EOL)).toBe(true);
		expect((await fs.readdir(result.primaryDir)).filter(name => name.endsWith("-audit.json"))).toEqual([]);
	});

	test("treats Winston format tokens as a splat branch and omits context", async () => {
		const result = await runScenario("format-tokens");
		expect(result.stdout).toBe("");
		expect(result.stderr).toBe("");
		const tokenMessages = [
			"token-%s",
			"token-%c",
			"token-%d",
			"token-%j",
			"token-%i",
			"token-%f",
			"token-%o",
			"token-%O",
			"token-%%",
		];
		const expected = [
			...tokenMessages.map(message => expectedLine(result.pid, "info", message)),
			expectedLine(result.pid, "info", "non-token-%q", { value: 7 }),
			expectedLine(result.pid, "info", "circular-%s"),
			expectedLine(result.pid, "info", "bigint-%d"),
		].join("");
		expect((await readSingleLog(result.primaryDir)).text).toBe(expected);
	});

	test("drops native JSON failures locally but sends original contexts to sinks", async () => {
		const result = await runScenario("serialization-failures");
		expect(result.stdout).toBe("");
		expect(result.stderr).toBe("");
		// Nothing serialized, so the lazily created file never appears.
		expect(await logFileNames(result.primaryDir)).toEqual([]);
		const payload = JSON.parse(await fs.readFile(result.resultPath, "utf8")) as {
			events: Array<{ level: string; message: string; sameContext: boolean; timestamp: string }>;
		};
		expect(payload.events).toEqual([
			{ level: "info", message: "circular-drop", sameContext: true, timestamp: fixedNow },
			{ level: "error", message: "bigint-drop", sameContext: true, timestamp: fixedNow },
		]);
	});
});

describe("central logger file level and batching", () => {
	test("persists debug records by default", async () => {
		const result = await runScenario("debug-only");
		expect(result.stdout).toBe("");
		expect(result.stderr).toBe("");
		expect((await readSingleLog(result.primaryDir)).text).toBe(
			expectedLine(result.pid, "debug", "debug-only-first", { ordinal: 1 }) +
				expectedLine(result.pid, "debug", "debug-only-second", { ordinal: 2 }),
		);
	});

	test("OMP_LOG_LEVEL=warn gates info and debug while warn and error stay on disk", async () => {
		const result = await runScenario("matrix", { logLevel: "WARN" });
		expect((await readLogEntries(result.primaryDir)).map(entry => entry.message)).toEqual([
			"level-error",
			"level-warn",
			"reserved-primary metadata-message",
			"error-matrix",
			"tojson-error",
		]);
	});

	test("the fatal record lands after the buffered records that preceded it", async () => {
		const result = await runScenario("uncaught", { probe: fatalProbePath, exitCode: 1 });
		expect((await readLogEntries(result.primaryDir)).map(entry => [entry.level, entry.message])).toEqual([
			["info", "before-crash-info"],
			["debug", "before-crash-debug"],
			["error", "Uncaught exception"],
		]);
	});

	test("a hard exit through exitProcess writes the buffered records", async () => {
		const result = await runScenario("exit-process", { probe: fatalProbePath, exitCode: 3 });
		expect((await readLogEntries(result.primaryDir)).map(entry => [entry.level, entry.message])).toEqual([
			["info", "before-exit-info"],
			["debug", "before-exit-debug"],
		]);
	});
});

describe("central logger transport lifecycle", () => {
	test("defaults to file-only without touching stdout or stderr", async () => {
		const result = await runScenario("default-file");
		expect(result.stdout).toBe("");
		expect(result.stderr).toBe("");
		const defaultLogsDir = path.join(result.primaryDir, ".omp", "logs");
		const log = await readSingleLog(defaultLogsDir);
		expect(log.text).toBe(expectedLine(result.pid, "info", "mode-default", { mode: "default" }));
	});

	test("emits file-only, console-only, and dual modes exactly once", async () => {
		const fileOnly = await runScenario("file-only");
		const fileLine = expectedLine(fileOnly.pid, "info", "mode-file", { mode: "file" });
		expect(fileOnly.stdout).toBe("");
		expect(fileOnly.stderr).toBe("");
		expect((await readSingleLog(fileOnly.primaryDir)).text).toBe(fileLine);

		const consoleOnly = await runScenario("console-only");
		const consoleLine = expectedLine(consoleOnly.pid, "info", "mode-console", { mode: "console" });
		expect(consoleOnly.stdout).toBe(consoleLine);
		expect(consoleOnly.stderr).toBe("");
		expect(await logFileNames(consoleOnly.primaryDir)).toEqual([]);

		const both = await runScenario("both");
		const bothLine = expectedLine(both.pid, "info", "mode-both", { mode: "both" });
		expect(both.stdout).toBe(bothLine);
		expect(both.stderr).toBe("");
		expect((await readSingleLog(both.primaryDir)).text).toBe(bothLine);
	});

	test("keeps disabled mode silent, sends sinks, preserves void returns, and re-enables", async () => {
		const result = await runScenario("disabled-reenable");
		expect(result.stdout).toBe("");
		expect(result.stderr).toBe("");
		expect((await readSingleLog(result.primaryDir)).text).toBe(
			expectedLine(result.pid, "warn", "mode-reenabled", { mode: "file" }),
		);
		const payload = JSON.parse(await fs.readFile(result.resultPath, "utf8")) as {
			disabledSinkSameContext: boolean;
			sinkCount: number;
			returnsUndefined: boolean;
		};
		expect(payload).toEqual({ disabledSinkSameContext: true, sinkCount: 2, returnsUndefined: true });
	});

	test("closes A before reconfiguring to B and never cross-writes", async () => {
		const result = await runScenario("reconfigure");
		expect(result.stdout).toBe("");
		expect(result.stderr).toBe("");
		expect((await readSingleLog(result.primaryDir)).text).toBe(
			expectedLine(result.pid, "info", "directory-a", { destination: "a" }),
		);
		expect((await readSingleLog(result.secondaryDir)).text).toBe(
			expectedLine(result.pid, "info", "directory-b", { destination: "b" }),
		);
	});

	test("falls back without throwing when a warm replacement destination is broken", async () => {
		const result = await runScenario("reconfigure-failure");
		expect(result.stdout).toBe("");
		expect(result.stderr).toBe("");
		expect((await readSingleLog(result.primaryDir)).text).toBe(
			expectedLine(result.pid, "info", "before-failed-reconfigure"),
		);
		expect(await logFileNames(result.secondaryDir)).toEqual([]);
		const payload = JSON.parse(await fs.readFile(result.resultPath, "utf8")) as {
			reconfigureThrew: boolean;
			sinkCount: number;
			sinkSameContext: boolean;
		};
		expect(payload).toEqual({ reconfigureThrew: false, sinkCount: 1, sinkSameContext: true });
	});

	// Two sequential probe children writing 1000 records each measure ~4.4 s
	// on an unloaded runner — bun's 5 s default test timeout SIGTERMed the
	// probe (exit 143) whenever CI runners shared cores. The contract is
	// order + drain, not latency; give it an explicit budget.
	test("preserves burst order and drains on close and natural child exit", async () => {
		for (const scenario of ["burst-close", "burst-natural"] as const) {
			const result = await runScenario(scenario);
			expect(result.stdout).toBe("");
			expect(result.stderr).toBe("");
			const text = (await readSingleLog(result.primaryDir)).text;
			expect(text.endsWith(os.EOL)).toBe(true);
			const lines = text.split(os.EOL);
			expect(lines.pop()).toBe("");
			expect(lines).toHaveLength(1_000);
			for (const [index, line] of lines.entries()) {
				const entry = JSON.parse(line) as { message: string; index: number };
				expect(entry).toMatchObject({ message: scenario, index });
			}
		}
	}, 30_000);

	test("runs local console output before sinks and isolates throwing or disposed sinks", async () => {
		const result = await runScenario("sink-order");
		const first = expectedLine(result.pid, "info", "sink-first", { identity: "same" });
		const second = expectedLine(result.pid, "info", "sink-disposed");
		expect(result.stdout).toBe(`${first}SINK:true\n${second}`);
		expect(result.stderr).toBe("");
	});
});

describe("DailyRotateFile option and retention contract", () => {
	test("uses local-day names and retains exactly five rotations without an audit file", async () => {
		const result = await runScenario("date-retention");
		expect(result.stdout).toBe("");
		expect(result.stderr).toBe("");
		const expectedNames = [2, 3, 4, 5, 6].map(day => `omp.2026-01-0${day}.${result.pid}.log`);
		expect(await logFileNames(result.primaryDir)).toEqual(expectedNames);
		for (const [offset, name] of expectedNames.entries()) {
			const day = offset + 2;
			const timestamp = `2026-01-0${day}T22:04:05.006-05:00`;
			expect(await fs.readFile(path.join(result.primaryDir, name), "utf8")).toBe(
				expectedLine(result.pid, "info", `date-${day}`, {}, timestamp),
			);
		}
		expect((await fs.readdir(result.primaryDir)).sort()).toEqual(expectedNames);
	});

	test("crosses 10 MiB before rolling the following record to suffix .1", async () => {
		const result = await runScenario("size-rotation");
		expect(result.stdout).toBe("");
		expect(result.stderr).toBe("");
		const baseName = `omp.2026-01-01.${result.pid}.log`;
		const rotatedName = `${baseName}.1`;
		expect(await logFileNames(result.primaryDir)).toEqual([baseName, rotatedName]);
		const basePath = path.join(result.primaryDir, baseName);
		const baseStat = await fs.stat(basePath);
		const recordSize = (message: string, payloadSize: number): number =>
			`{"timestamp":"${fixedTimestamp}","level":"info","pid":${result.pid},"message":"${message}","payload":"`
				.length +
			payloadSize +
			`"}${os.EOL}`.length;
		const expectedBytes =
			recordSize("size-nine-mib", 9 * 1024 * 1024) +
			recordSize("size-half-mib", 512 * 1024) +
			recordSize("size-crosses-ten-mib", 1024 * 1024);
		expect(baseStat.size).toBe(expectedBytes);
		expect(baseStat.size).toBeGreaterThan(10 * 1024 * 1024);
		expect(await fs.readFile(path.join(result.primaryDir, rotatedName), "utf8")).toBe(
			expectedLine(result.pid, "info", "rotation-trigger"),
		);
		expect((await fs.readdir(result.primaryDir)).sort()).toEqual([baseName, rotatedName]);
	});
});

/** Isolated consumers exercise real filesystem and async boundaries, never source text. */
async function runDiagnosticConsumer(
	source: string,
	options: { setup?: (root: string) => Promise<void>; exitCode?: number } = {},
): Promise<{ root: string; stdout: string; stderr: string; pid: number }> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-diagnostic-contract-"));
	roots.push(root);
	await fs.mkdir(path.join(root, "home"));
	await options.setup?.(root);
	const moduleUrl = pathToFileURL(path.resolve(import.meta.dir, "../src/logger.ts")).href;
	const child = Bun.spawn(
		[
			process.execPath,
			"--eval",
			`
		import * as logger from ${JSON.stringify(moduleUrl)};
		import { getLogPath } from ${JSON.stringify(new URL("./dirs.ts", moduleUrl).href)};
		import * as fs from "node:fs";
		import * as path from "node:path";
		const root = ${JSON.stringify(root)};
		${source}
	`,
		],
		{
			env: {
				...process.env,
				HOME: path.join(root, "home"),
				USERPROFILE: path.join(root, "home"),
				LOCALAPPDATA: path.join(root, "local"),
				XDG_STATE_HOME: path.join(root, "state"),
				OMP_CONFIG_ROOT: path.join(root, "primary"),
				OMP_PROFILE: "",
				PI_PROFILE: "",
				OMP_LOG_LEVEL: "",
				BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
			},
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	expect(exitCode, stderr).toBe(options.exitCode ?? 0);
	return { root, stdout, stderr, pid: child.pid };
}

function consumerFallbackDir(root: string): string {
	if (process.platform === "win32") return path.join(root, "local", "omp", "Logs");
	if (process.platform === "darwin") return path.join(root, "home", "Library", "Logs", "omp");
	return path.join(root, "state", "omp", "logs");
}

describe("diagnostic consumer contracts", () => {
	test("isolates concurrent contexts, inherits nested fields, and shares merged context with sinks", async () => {
		const result = await runDiagnosticConsumer(`
			const observed = [];
			const dispose = logger.registerLogSink(event => observed.push({ message: event.message, ...event.context }));
			const outside = logger.getLogContext();
			await Promise.all(["a", "b"].map(operation_id => logger.withLogContext({ operation_id, component: "contract" }, async () => {
				logger.info("operation_started");
				await Promise.resolve();
				await logger.withLogContext({ stage: "nested" }, async () => {
					await Promise.resolve();
					logger.info("operation_completed", { stage: "explicit", elapsed_ms: 1 });
				});
				if (logger.getLogContext().stage !== undefined) throw new Error("nested context leaked");
			})));
			dispose();
			fs.writeFileSync(path.join(root, "result.json"), JSON.stringify({ outside, after: logger.getLogContext(), observed }));
			logger.flush();
		`);
		expect(result.stdout).toBe("");
		expect(result.stderr).toBe("");
		const payload = JSON.parse(await fs.readFile(path.join(result.root, "result.json"), "utf8"));
		expect(payload.outside).toEqual({});
		expect(payload.after).toEqual({});
		const entries = await readLogEntries(path.join(result.root, "primary", "logs"));
		expect(
			entries.map(entry => {
				const {
					timestamp: _timestamp,
					level: _level,
					pid: _pid,
					...context
				} = entry as unknown as Record<string, unknown>;
				return context;
			}),
		).toEqual(payload.observed);
		for (const operation_id of ["a", "b"]) {
			expect(
				payload.observed.filter((entry: Record<string, unknown>) => entry.operation_id === operation_id),
			).toEqual([
				{ message: "operation_started", operation_id, component: "contract" },
				{ message: "operation_completed", operation_id, component: "contract", stage: "explicit", elapsed_ms: 1 },
			]);
		}
	});

	test("persists bounded exception locations and HTTP status without sensitive error or URL data", async () => {
		const canary = "private-sensitive-canary-9876";
		const result = await runDiagnosticConsumer(`
			const canary = ${JSON.stringify(canary)};
			const error = new Error(canary);
			error.name = "TransportError";
			error.code = "EACCES";
			error.response = { status: 503, body: canary, headers: { Authorization: canary } };
			error.cause = error;
			error.stack = "TransportError: " + canary + "\\n    at request (/private/project/client.ts:12:3)\\n" +
				"    at fetch (https://user:" + canary + "@example.test/client.ts?token=" + canary + ":2:1)";
			logger.error("request_failed", {
				component: "contract", event: "request_failed", operation_id: "safe-summary", stage: "receive", elapsed_ms: 2,
				...logger.diagnosticError(error),
				...logger.diagnosticUrl("https://user:" + canary + "@example.test/v1/" + canary + "/items?token=" + canary + "#" + canary),
			});
			logger.info("same_destination", logger.diagnosticUrl("https://example.test/v1/" + canary + "/items?token=rotated"));
			logger.info("other_destination", logger.diagnosticUrl("https://example.test/v1/" + canary + "/other"));
			logger.info("invalid_url", logger.diagnosticUrl(canary));
			logger.info("throwing_error_fields", logger.diagnosticError(new Proxy({}, { get() { throw new Error(canary); } })));
			logger.flush();
		`);
		const log = await readSingleLog(path.join(result.root, "primary", "logs"));
		expect(log.text).not.toContain(canary);
		expect(log.text).not.toContain("/private/project");
		expect(log.text).not.toContain("Authorization");
		expect(JSON.parse(log.text.split(os.EOL)[0]!)).toMatchObject({
			error_type: "TransportError",
			error_code: "EACCES",
			status: 503,
			stack_frames: [{ file: "client.ts", line: 12, column: 3 }],
			host: "example.test",
		});
		const entries = log.text
			.trim()
			.split(os.EOL)
			.map(line => JSON.parse(line) as Record<string, unknown>);
		const sameDestination = entries.find(entry => entry.message === "same_destination")!;
		const otherDestination = entries.find(entry => entry.message === "other_destination")!;
		expect(entries[0]!.path_hash).toEqual(sameDestination.path_hash);
		expect(entries[0]!.path_hash).not.toEqual(otherDestination.path_hash);
		expect(result.stdout).toBe("");
		expect(result.stderr).toBe("");
	});

	test("recovers a broken primary directory on timed flush without losing or duplicating records", async () => {
		const result = await runDiagnosticConsumer(
			`
			logger.info("buffered_record", { index: 1 });
			// Platform timer integration: the isolated child must exercise the real unref'd flush.
			await Bun.sleep(1_100);
			logger.warn("urgent_record", { index: 2 });
			logger.flush();
		`,
			{
				setup: async root => {
					await fs.writeFile(path.join(root, "primary"), "not a directory");
				},
			},
		);
		const entries = await readLogEntries(consumerFallbackDir(result.root));
		expect(entries.map(entry => entry.message)).toEqual([
			"log_directory_fallback",
			"buffered_record",
			"urgent_record",
		]);
		expect(result.stdout).toBe("");
		expect(result.stderr).toBe("");
	});

	test("recovers when mkdir works but the actual log cannot be opened", async () => {
		const result = await runDiagnosticConsumer(`
			fs.mkdirSync(getLogPath(), { recursive: true });
			logger.info("open_failure_record");
			logger.flush();
		`);
		expect((await readLogEntries(consumerFallbackDir(result.root))).map(entry => entry.message)).toEqual([
			"log_directory_fallback",
			"open_failure_record",
		]);
		expect(result.stdout).toBe("");
		expect(result.stderr).toBe("");
	});

	test("debug readers and reports resolve the actual fallback after their own flush", async () => {
		const reportUrl = pathToFileURL(
			path.resolve(import.meta.dir, "../../coding-agent/src/debug/report-bundle.ts"),
		).href;
		for (const firstReader of ["text", "view", "report"]) {
			const result = await runDiagnosticConsumer(`
				import { getLogsDir, getReportsDir, getConfigRootDir, localDay, setProfile } from
					${JSON.stringify(pathToFileURL(path.resolve(import.meta.dir, "../src/dirs.ts")).href)};
				import { getLogText, createDebugLogSource, createReportBundle } from ${JSON.stringify(reportUrl)};
				setProfile("debug-readers");
				const configured = { file: getLogPath(), logs: getLogsDir(), reports: getReportsDir(), root: getConfigRootDir() };
				// A directory at the exact file target denies opening even under root or on Windows.
				fs.mkdirSync(configured.file, { recursive: true });
				logger.info("debug_reader_fallback_marker");
				const readBundle = async options => {
					const bundle = await createReportBundle({ sessionFile: undefined, ...options });
					const archive = new Bun.Archive(await Bun.file(bundle.path).bytes());
					const logs = (await (await archive.files()).get("logs.txt")?.text()) ?? "";
					return { path: bundle.path, files: bundle.files, logs };
				};
				const first = ${JSON.stringify(firstReader)} === "text" ? await getLogText()
					: ${JSON.stringify(firstReader)} === "view" ? await (await createDebugLogSource()).getInitialText()
					: (await readBundle()).logs;
				const actual = { file: logger.getCurrentLogPath(), logs: logger.getCurrentLogsDir() };
				const yesterday = new Date();
				yesterday.setDate(yesterday.getDate() - 1);
				fs.writeFileSync(path.join(actual.logs, "omp." + localDay(yesterday) + ".99991.log"), "older_fallback_marker\\n");
				fs.writeFileSync(path.join(actual.logs, "omp." + localDay(new Date()) + ".99992.log"), "other_pid_fallback_marker\\n");
				const source = await createDebugLogSource();
				const initial = await source.getInitialText();
				const hadOlder = source.hasOlderLogs();
				const older = await source.loadOlderLogs(10);
				const bundle = await readBundle();
				const overrideLogs = path.join(root, "override-logs");
				const overrideReports = path.join(root, "override-reports");
				fs.mkdirSync(overrideLogs);
				fs.writeFileSync(path.join(overrideLogs, "omp." + localDay(new Date()) + ".99993.log"), "explicit_logs_marker\\n");
				const override = await readBundle({ logsDir: overrideLogs, reportsDir: overrideReports });
				const after = { file: getLogPath(), logs: getLogsDir(), reports: getReportsDir(), root: getConfigRootDir() };
				logger.setTransports({ file: false });
				fs.writeFileSync(path.join(root, "result.json"), JSON.stringify({
					configured, actual, after, first, initial, hadOlder, older, bundle, override
				}));
			`);
			const payload = JSON.parse(await fs.readFile(path.join(result.root, "result.json"), "utf8"));
			const fallback = consumerFallbackDir(result.root);
			expect(payload.actual.logs).toBe(fallback);
			expect(path.dirname(payload.actual.file)).toBe(fallback);
			expect(payload.actual.file).not.toBe(payload.configured.file);
			expect(payload.after).toEqual(payload.configured);
			expect(payload.configured.root).toBe(path.join(result.root, "primary", "profiles", "debug-readers"));
			expect(payload.first).toContain("debug_reader_fallback_marker");
			expect(payload.initial).toContain("debug_reader_fallback_marker");
			expect(payload.initial).toContain("log_directory_fallback");
			expect(payload.hadOlder).toBe(true);
			expect(payload.older).toContain("older_fallback_marker");
			expect(payload.bundle.files).toContain("logs.txt");
			expect(payload.bundle.logs).toContain("debug_reader_fallback_marker");
			expect(payload.bundle.logs).toContain("other_pid_fallback_marker");
			expect(payload.bundle.logs).not.toContain("older_fallback_marker");
			expect(path.dirname(payload.bundle.path)).toBe(payload.configured.reports);
			expect(path.dirname(payload.override.path)).toBe(path.join(result.root, "override-reports"));
			expect(payload.override.logs).toContain("explicit_logs_marker");
			expect(payload.override.logs).not.toContain("debug_reader_fallback_marker");
			expect(await fs.readFile(payload.actual.file, "utf8")).toContain("debug_reader_fallback_marker");
			expect(result.stdout).toBe("");
			expect(result.stderr).toBe("");
		}
	}, 30_000);

	test("debug reads preserve lazy defaults and console-only mode and follow reconfiguration and rotation", async () => {
		const reportUrl = pathToFileURL(
			path.resolve(import.meta.dir, "../../coding-agent/src/debug/report-bundle.ts"),
		).href;
		const result = await runDiagnosticConsumer(`
			import { getLogsDir } from ${JSON.stringify(pathToFileURL(path.resolve(import.meta.dir, "../src/dirs.ts")).href)};
			import { getLogText, createDebugLogSource, createReportBundle } from ${JSON.stringify(reportUrl)};
			const defaultFile = getLogPath();
			const defaultDir = getLogsDir();
			const lazy = { file: logger.getCurrentLogPath(), logs: logger.getCurrentLogsDir(), exists: fs.existsSync(defaultFile) };
			logger.setTransports({ console: true, file: false });
			logger.info("console_only_reader_marker");
			const consoleText = await getLogText();
			const consoleSource = await createDebugLogSource();
			const consoleInitial = await consoleSource.getInitialText();
			const consoleBundle = await createReportBundle({ sessionFile: undefined });
			const consoleState = {
				file: logger.getCurrentLogPath(), logs: logger.getCurrentLogsDir(), exists: fs.existsSync(defaultFile),
				text: consoleText, initial: consoleInitial, older: consoleSource.hasOlderLogs(), files: consoleBundle.files
			};
			logger.setTransports({ file: true });
			logger.info("default_reader_marker");
			const defaultText = await getLogText();
			const normal = { file: logger.getCurrentLogPath(), logs: logger.getCurrentLogsDir(), text: defaultText };
			const customDir = path.join(root, "custom");
			logger.setTransports({ file: customDir });
			const source = await createDebugLogSource();
			logger.info("fills_custom_file", { padding: "x".repeat(10 * 1024 * 1024 + 1) });
			logger.info("rotated_reader_marker");
			const rotatedText = await source.getInitialText();
			const rotated = { file: logger.getCurrentLogPath(), logs: logger.getCurrentLogsDir(), text: rotatedText };
			logger.setTransports({ file: false });
			fs.writeFileSync(path.join(root, "result.json"), JSON.stringify({ defaultFile, defaultDir, lazy, consoleState, normal, rotated }));
		`);
		const payload = JSON.parse(await fs.readFile(path.join(result.root, "result.json"), "utf8"));
		expect(payload.lazy).toEqual({ file: payload.defaultFile, logs: payload.defaultDir, exists: false });
		expect(payload.consoleState).toMatchObject({
			file: payload.defaultFile,
			logs: payload.defaultDir,
			exists: false,
			text: "",
			initial: "",
			older: false,
		});
		expect(payload.consoleState.files).not.toContain("logs.txt");
		expect(JSON.parse(result.stdout.trim())).toMatchObject({ message: "console_only_reader_marker" });
		expect(payload.normal.file).toBe(payload.defaultFile);
		expect(payload.normal.logs).toBe(payload.defaultDir);
		expect(payload.normal.text).toContain("default_reader_marker");
		expect(payload.rotated.file).toBe(path.join(result.root, "custom", path.basename(payload.defaultFile) + ".1"));
		expect(payload.rotated.logs).toBe(path.join(result.root, "custom"));
		expect(payload.rotated.text).toContain("rotated_reader_marker");
		expect(payload.rotated.text).not.toContain("default_reader_marker");
		expect(payload.rotated.text).not.toContain("fills_custom_file");
		expect(result.stderr).toBe("");
	}, 30_000);

	test("uses a distinct fallback when the selected primary is already the platform log directory", async () => {
		const result = await runDiagnosticConsumer(`
			const standard = process.platform === "win32"
				? path.join(root, "local", "omp", "Logs")
				: process.platform === "darwin"
					? path.join(root, "home", "Library", "Logs", "omp")
					: path.join(root, "state", "omp", "logs");
			fs.mkdirSync(path.join(standard, path.basename(getLogPath())), { recursive: true });
			logger.setTransports({ file: standard });
			logger.info("already_standard_record");
			logger.flush();
		`);
		expect(
			(await readLogEntries(path.join(result.root, "home", ".omp", "fallback-logs"))).map(entry => entry.message),
		).toEqual(["log_directory_fallback", "already_standard_record"]);
		expect(result.stdout).toBe("");
		expect(result.stderr).toBe("");
	});

	test.skipIf(process.platform !== "linux")(
		"recovers an actual write error rather than only mkdir failures",
		async () => {
			const result = await runDiagnosticConsumer(`
			fs.mkdirSync(path.dirname(getLogPath()), { recursive: true });
			fs.symlinkSync("/dev/full", getLogPath());
			logger.info("write_failure_record");
			logger.flush();
		`);
			expect((await readLogEntries(consumerFallbackDir(result.root))).map(entry => entry.message)).toEqual([
				"log_directory_fallback",
				"write_failure_record",
			]);
			expect(result.stdout).toBe("");
			expect(result.stderr).toBe("");
		},
	);

	test("recovers an unavailable rotated file while preserving the final record", async () => {
		const result = await runDiagnosticConsumer(`
			logger.info("fills_first_file", { padding: "x".repeat(10 * 1024 * 1024 + 1) });
			logger.flush();
			fs.mkdirSync(getLogPath() + ".1");
			logger.warn("rotation_failure_record");
		`);
		expect((await readLogEntries(consumerFallbackDir(result.root))).map(entry => entry.message)).toEqual([
			"log_directory_fallback",
			"rotation_failure_record",
		]);
		expect(result.stdout).toBe("");
		expect(result.stderr).toBe("");
	});

	test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
		"uses the user fallback when a real primary directory denies writes",
		async () => {
			const result = await runDiagnosticConsumer(
				`
				logger.info("permission_record");
				logger.flush();
			`,
				{
					setup: async root => {
						const directory = path.join(root, "primary", "logs");
						await fs.mkdir(directory, { recursive: true });
						await fs.chmod(directory, 0o500);
					},
				},
			);
			await fs.chmod(path.join(result.root, "primary", "logs"), 0o700);
			expect((await readLogEntries(consumerFallbackDir(result.root))).map(entry => entry.message)).toEqual([
				"log_directory_fallback",
				"permission_record",
			]);
			expect(result.stderr).toBe("");
		},
	);

	test("opts into lifecycle once with the actual fallback path and flushes before hard exit", async () => {
		const postmortemUrl = pathToFileURL(path.resolve(import.meta.dir, "../src/postmortem.ts")).href;
		const result = await runDiagnosticConsumer(
			`
			logger.initializeDiagnosticLogging("cli");
			logger.initializeDiagnosticLogging("cli");
			logger.info("last_business_record");
			const { exitProcess } = await import(${JSON.stringify(postmortemUrl)});
			exitProcess(7);
		`,
			{
				exitCode: 7,
				setup: async root => {
					await fs.writeFile(path.join(root, "primary"), "not a directory");
				},
			},
		);
		const entries = await readLogEntries(consumerFallbackDir(result.root));
		expect(entries.map(entry => entry.message)).toEqual([
			"log_directory_fallback",
			"application_started",
			"last_business_record",
			"application_stopping",
			"application_stopped",
		]);
		expect(entries[1]).toMatchObject({
			app: "omp",
			pid: result.pid,
			path: path.join(
				consumerFallbackDir(result.root),
				(await readSingleLog(consumerFallbackDir(result.root))).name,
			),
			log_level: "debug",
			mode: "cli",
		});
		expect(entries[3]).toMatchObject({ exitCode: 7 });
		expect(entries[4]).toMatchObject({ exitCode: 7 });
		expect(result.stdout).toBe("");
		expect(result.stderr).toBe("");
	});

	test("flushes a single natural-exit lifecycle and does not copy arbitrary run mode", async () => {
		const result = await runDiagnosticConsumer(`
			logger.initializeDiagnosticLogging("sensitive-mode-canary");
			logger.initializeDiagnosticLogging("cli");
			logger.info("natural_exit_record");
		`);
		const log = await readSingleLog(path.join(result.root, "primary", "logs"));
		expect(log.text).not.toContain("sensitive-mode-canary");
		expect((await readLogEntries(path.join(result.root, "primary", "logs"))).map(entry => entry.message)).toEqual([
			"application_started",
			"natural_exit_record",
			"application_stopping",
			"application_stopped",
		]);
		expect(result.stdout).toBe("");
		expect(result.stderr).toBe("");
	});

	test("respects error-only lifecycle thresholds on natural and hard exits", async () => {
		const postmortemUrl = pathToFileURL(path.resolve(import.meta.dir, "../src/postmortem.ts")).href;
		for (const hardExit of [false, true]) {
			const result = await runDiagnosticConsumer(
				`
				process.env.OMP_LOG_LEVEL = "error";
				logger.initializeDiagnosticLogging("cli");
				logger.info("filtered_business_info");
				logger.warn("filtered_business_warn");
				logger.error("persisted_business_error", { code: "E_CONTRACT" });
				${hardExit ? `const { exitProcess } = await import(${JSON.stringify(postmortemUrl)}); exitProcess(7);` : ""}
			`,
				{ exitCode: hardExit ? 7 : 0 },
			);
			const entries = await readLogEntries(path.join(result.root, "primary", "logs"));
			expect(entries).toHaveLength(1);
			expect(entries[0]).toMatchObject({
				level: "error",
				message: "persisted_business_error",
				code: "E_CONTRACT",
			});
			expect(result.stdout).toBe("");
			expect(result.stderr).toBe("");
		}
	});

	test("emits only one finite stderr warning if both destinations fail", async () => {
		const result = await runDiagnosticConsumer(
			`
			logger.initializeDiagnosticLogging("cli");
			for (let index = 0; index < 10; index++) logger.error("unwritable_record", { index });
			logger.flush();
		`,
			{
				setup: async root => {
					await fs.writeFile(path.join(root, "primary"), "not a directory");
					const fallback = consumerFallbackDir(root);
					await fs.mkdir(path.dirname(fallback), { recursive: true });
					await fs.writeFile(fallback, "not a directory");
				},
			},
		);
		expect(result.stdout).toBe("");
		expect(result.stderr).toBe("[omp] Diagnostic log unavailable: primary and user log destinations failed.\n");
	});
});
