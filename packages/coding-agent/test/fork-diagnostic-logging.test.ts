import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getOfflineShmState } from "@oh-my-pi/pi-natives/offline-root";

type RecordLine = {
	timestamp: string;
	level: string;
	pid: number;
	message: string;
	component?: string;
	event?: string;
	operation_id?: string;
	call_id?: string;
	stage?: string;
	result?: string;
	elapsed_ms?: number;
	[key: string]: unknown;
};

const repository = path.resolve(import.meta.dir, "../../..");
const probe = path.join(import.meta.dir, "fixtures/fork-diagnostic-probe.ts");
const profile = "diagnostic-acceptance";

async function sandbox(level = "debug") {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-fork-diagnostic-"));
	const root = path.join(directory, "project");
	const home = path.join(directory, "home");
	const configRoot = path.join(directory, "config");
	const offlineState = getOfflineShmState({ OMP_CONFIG_ROOT: configRoot, OMP_OFFLINE: "1" });
	const profileRoot = path.join(offlineState?.runtimeRoot ?? configRoot, "profiles", profile);
	const agent = path.join(profileRoot, "agent");
	await Promise.all([root, home, agent].map(dir => fs.mkdir(dir, { recursive: true, mode: 0o700 })));
	await fs.writeFile(
		path.join(agent, "config.yml"),
		"marketplace:\n  autoUpdate: off\nstartup:\n  setupWizard: false\n  checkUpdate: false\n",
	);
	// Do not inherit credentials, provider URLs, profiles, package/config overrides,
	// or another test's logger controls. Keep only OS executable-loading necessities.
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (/^(?:path|systemroot|windir|comspec|pathext|systemdrive|lang|lc_all)$/i.test(key) && value !== undefined)
			env[key] = value;
	}
	Object.assign(env, {
		OMP_CONFIG_ROOT: configRoot,
		HOME: home,
		USERPROFILE: home,
		TMPDIR: directory,
		TMP: directory,
		TEMP: directory,
		APPDATA: path.join(home, "AppData", "Roaming"),
		LOCALAPPDATA: path.join(home, "AppData", "Local"),
		XDG_CONFIG_HOME: path.join(home, "xdg-config"),
		XDG_DATA_HOME: path.join(home, "xdg-data"),
		XDG_STATE_HOME: path.join(home, "xdg-state"),
		XDG_CACHE_HOME: path.join(home, "xdg-cache"),
		OMP_PROFILE: profile,
		PI_PROFILE: profile,
		PI_CODING_AGENT_DIR: "",
		OMP_JCHTOOLS_DISCOVERY: "0",
		OMP_OFFLINE: "1",
		OMP_LOG_LEVEL: level,
	});
	const logsDir = path.join(profileRoot, "logs");
	async function logs(): Promise<{ raw: string; records: RecordLine[] }> {
		const files = await fs.readdir(logsDir);
		const records: RecordLine[] = [];
		let raw = "";
		for (const name of files.filter(name => /^omp\.\d{4}-\d{2}-\d{2}\.\d+\.log(?:\.\d+)?$/.test(name))) {
			const text = await fs.readFile(path.join(logsDir, name), "utf8");
			raw += text;
			const filenamePid = Number(/^omp\.\d{4}-\d{2}-\d{2}\.(\d+)\.log/.exec(name)?.[1]);
			for (const line of text.split("\n").filter(Boolean)) {
				const record = JSON.parse(line) as RecordLine;
				expect(record.pid).toBe(filenamePid);
				expect(record.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}(?:Z|[+-]\d{2}:\d{2})$/);
				expect(Number.isFinite(Date.parse(record.timestamp))).toBe(true);
				records.push(record);
			}
		}
		expect(records.length).toBeGreaterThan(0);
		return { raw, records };
	}
	async function run(command: string[]) {
		const child = Bun.spawn([process.execPath, ...command], {
			cwd: repository,
			env,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		let timedOut = false;
		// A watchdog bounds a hung real subprocess; completion is awaited via exited,
		// never a guessed sleep. Parent fake timers cannot drive a separate Bun process.
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill();
		}, 25_000);
		try {
			const [stdout, stderr, code] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			if (timedOut) throw new Error(`Diagnostic child timed out: ${stderr}`);
			return { stdout, stderr, code };
		} finally {
			clearTimeout(timer);
			if (child.exitCode === null) {
				child.kill();
				await child.exited;
			}
		}
	}
	return {
		directory,
		root,
		agent,
		logsDir,
		logs,
		cli: (args: string[]) => run(["run", "dev", "--profile", profile, "--cwd", root, ...args]),
		async probe(mode: string, canary: string) {
			const child = await run([probe, mode, root, canary]);
			if (child.code !== 0) throw new Error(`Diagnostic probe exited ${child.code}: ${child.stderr}`);
			const value = JSON.parse(child.stdout);
			expect(path.resolve(value.logsDir)).toBe(path.resolve(logsDir));
			return value;
		},
		async cleanup() {
			if (offlineState) await fs.rm(path.dirname(offlineState.runtimeRoot), { recursive: true, force: true });
			await fs.rm(directory, { recursive: true, force: true });
		},
	};
}

function terminal(record: RecordLine) {
	if (/^jchtools_(?:discovery|models|request)_finished$/.test(record.event ?? "")) return true;
	return /^(?:docs\.init\.(?:completed|finished)|docs\.database\.(?:completed|failed)|docs\.cli\.command\.(?:completed|failed|cancelled|rejected)|wiki\.query\.(?:completed|finished)|docs\.storage\.migration\.(?:completed|failed))$/.test(
		record.message,
	);
}

function expectClosedOperations(records: RecordLine[]) {
	const business = records.filter(record =>
		/^(?:docs(?:\.cli|\.storage)?|wiki|jchtools)$/.test(record.component ?? ""),
	);
	for (const record of business.filter(record => record.event && record.stage)) {
		expect(typeof record.operation_id).toBe("string");
		expect(record.operation_id?.length).toBeGreaterThan(0);
	}
	const starts = business.filter(
		record =>
			/^jchtools_(?:discovery|models|request)_started$/.test(record.event ?? "") ||
			/^(?:docs\.init|docs\.database|docs\.cli\.command|wiki\.query|docs\.storage\.migration)\.started$/.test(
				record.message,
			),
	);
	expect(starts.length).toBeGreaterThan(0);
	for (const start of starts) {
		const event = start.event?.replace(/_started$/, "_finished");
		const endings = business.filter(
			record =>
				terminal(record) &&
				record.operation_id === start.operation_id &&
				record.call_id === start.call_id &&
				record.event === event,
		);
		expect(endings.length).toBeGreaterThan(0);
		for (const end of endings) {
			expect(typeof end.result).toBe("string");
			expect(typeof end.stage).toBe("string");
			expect(typeof end.elapsed_ms).toBe("number");
			expect(Number.isFinite(end.elapsed_ms)).toBe(true);
			expect(end.elapsed_ms as number).toBeGreaterThanOrEqual(0);
		}
	}
}

function event(records: RecordLine[], message: string) {
	const found = records.find(record => record.message === message);
	if (!found) throw new Error(`Missing disk diagnostic ${message}`);
	return found;
}

function sameOperation(records: RecordLine[], record: RecordLine) {
	return records.filter(candidate => candidate.operation_id === record.operation_id);
}

describe("fork diagnostics on the real rotating disk transport", () => {
	it.skipIf(process.platform !== "linux")(
		"P2-40 starts the offline CLI with writable primary logs when fallback-logs is a regular file",
		async () => {
			const box = await sandbox("info");
			const fallback = path.join(path.dirname(box.logsDir), "fallback-logs");
			const documents = path.join(box.directory, "documents");
			try {
				await fs.mkdir(box.logsDir, { recursive: true, mode: 0o700 });
				await fs.writeFile(fallback, "unavailable fallback");
				await fs.mkdir(documents);
				await fs.writeFile(path.join(documents, "guide.md"), "# Evidence\nPrimary logging remains usable.\n");
				const imported = await box.cli(["docs", "init", documents, "--name", "primary-logs", "--json"]);
				expect(imported.code, imported.stderr).toBe(0);
				expect(JSON.parse(imported.stdout).index).toMatchObject({ name: "primary-logs", documentCount: 1 });
				expect(await fs.readFile(fallback, "utf8")).toBe("unavailable fallback");
				const { records } = await box.logs();
				expect(event(records, "docs.init.completed")).toMatchObject({ result: "completed" });
				const started = event(records, "application_started");
				expect(path.dirname(started.path as string)).toBe(box.logsDir);
				for (const message of ["application_stopping", "application_stopped"]) {
					expect(event(records, message)).toMatchObject({
						operation_id: started.operation_id,
						exitCode: 0,
					});
				}
				expect(records.some(record => record.event === "log_directory_fallback")).toBe(false);
			} finally {
				await box.cleanup();
			}
		},
		35_000,
	);

	it("correlates dev CLI docs publication, stored wiki evidence, rejected builds, rollback and cancellation without content leaks", async () => {
		const box = await sandbox();
		const canary = "FORKDIAGNOSTICDOCSPRIVATE";
		const name = `${canary}INDEX`;
		const documents = path.join(box.directory, "documents");
		try {
			await fs.mkdir(documents);
			await fs.writeFile(
				path.join(documents, "guide.md"),
				`# Evidence\n${canary}QUERY requires exactly seven cycles. ${canary}BODY\n`,
			);
			const imported = await box.cli(["docs", "init", documents, "--name", name, "--json"]);
			expect(imported.code).toBe(0);
			expect(JSON.parse(imported.stdout).index).toMatchObject({ name, documentCount: 1 });
			const initial = await box.logs();
			const published = event(initial.records, "docs.init.completed");
			expect(published).toMatchObject({ stage: "publish", result: "completed", file_count: 1, document_count: 1 });
			expect(published.section_count as number).toBeGreaterThan(0);
			const operation = sameOperation(initial.records, published);
			expect(operation.map(record => record.message)).toContain("docs.cli.command.started");
			expect(operation.map(record => record.message)).toContain("docs.init.fts.completed");
			expect(operation.map(record => record.message)).toContain("docs.cli.command.completed");

			const duplicate = await box.cli(["docs", "init", documents, "--name", name, "--json"]);
			expect(duplicate.code).toBe(1);
			expect(duplicate.stderr).toContain("Document index already exists");
			const missing = await box.cli([
				"docs",
				"init",
				path.join(box.directory, "missing"),
				"--name",
				`${canary}MISSING`,
				"--json",
			]);
			expect(missing.code).toBe(1);
			expect(missing.stderr).toContain("Markdown root is not a directory");
			await fs.rename(documents, path.join(box.directory, "documents-unavailable"));
			const wiki = await box.probe("wiki", canary);
			expect(wiki.indexes).toHaveLength(1);
			expect(wiki.indexes[0]).toMatchObject({ name, documentCount: 1 });
			expect(wiki.text).toContain("exactly seven cycles");
			expect(wiki.text).toContain(`index=${name}`);
			expect(wiki.text).toMatch(/sha256=[a-f0-9]{64}/);

			for (const mode of ["rollback", "cancel"]) {
				const result = await box.probe(mode, canary);
				expect(result.failure).toBe(mode === "cancel" ? "AbortError" : "Error");
				expect(result.before).toEqual(wiki.indexes);
				expect(result.visibleDuringBuild).toEqual(result.before);
				expect(result.after).toEqual(result.before);
				expect(result.hidden).toEqual({ count: 0 });
				await fs.rm(path.join(box.root, "interrupted-documents"), { recursive: true, force: true });
			}
			const { raw, records } = await box.logs();
			expect(raw).not.toContain(canary);
			expectClosedOperations(records);
			const rejected = records.find(
				record => record.message === "docs.init.finished" && record.reason === "duplicate_name",
			);
			expect(rejected).toMatchObject({ stage: "validate", result: "rejected", cleanup: "not_needed" });
			const duplicateOperation = sameOperation(records, rejected as RecordLine);
			expect(duplicateOperation.some(record => record.message === "docs.database.completed")).toBe(true);
			expect(duplicateOperation.some(record => record.message === "docs.init.scan.started")).toBe(false);
			const absent = records.find(record => record.message === "docs.init.finished" && record.stage === "scan");
			expect(absent).toMatchObject({
				result: "rejected",
				reason: "source_not_directory",
				document_count: 0,
				cleanup: "not_needed",
			});
			const absentOperation = sameOperation(records, absent as RecordLine);
			expect(absentOperation.some(record => record.message === "docs.init.scan.started")).toBe(true);
			expect(
				absentOperation.some(record => record.message === "docs.init.scan.completed" || record.stage === "publish"),
			).toBe(false);
			const rollback = records.find(
				record =>
					record.message === "docs.init.finished" && record.cleanup === "completed" && record.result === "failed",
			);
			expect(rollback).toMatchObject({ stage: "read", document_count: 1 });
			const rollbackOperation = sameOperation(records, rollback as RecordLine);
			expect(rollbackOperation.some(record => record.message === "docs.init.lock.completed")).toBe(true);
			expect(
				rollbackOperation.some(
					record => record.message === "docs.init.rollback.completed" && record.failed_stage === "read",
				),
			).toBe(true);
			expect(rollbackOperation.some(record => record.stage === "publish")).toBe(false);
			const cancelled = records.find(
				record => record.message === "docs.init.finished" && record.result === "cancelled",
			);
			expect(cancelled).toMatchObject({ cleanup: "completed", document_count: 1 });
			expect(sameOperation(records, cancelled as RecordLine).some(record => record.level === "error")).toBe(false);
			const queried = event(records, "wiki.query.completed");
			expect(queried).toMatchObject({ result: "completed", tool_call_id: "diagnostic-wiki" });
			expect(queried.rendered_section_count as number).toBeGreaterThan(0);
			expect(queried.match_count as number).toBeGreaterThan(0);
			const builds = records.filter(record => record.message === "docs.init.started");
			expect(new Set(builds.map(record => record.operation_id)).size).toBe(builds.length);
		} finally {
			await box.cleanup();
		}
	}, 120_000);

	it("diagnoses isolated same-OS IPC and concurrent localhost model/Agent failures without leaking wire data or changing partial-message semantics", async () => {
		const box = await sandbox("info");
		const canary = "FORKDIAGNOSTICTRANSPORTPRIVATE";
		try {
			const value = await box.probe("transport", canary);
			expect(value.discovery.slice(0, 4)).toEqual([null, null, null, null]);
			expect(value.discovery[4]).toEqual([]);
			expect(value.ipcRequests).toEqual(["Discover", "Discover", "Discover"]);
			const http = value.remote.find((item: { kind: string }) => item.kind === "http503");
			expect(http).toMatchObject({ stopReason: "error", errorStatus: 503, content: [] });
			expect(http.errorMessage).toContain(`${canary}ERRORBODY`);
			for (const kind of ["truncated", "cancel"]) {
				const result = value.remote.find((item: { kind: string }) => item.kind === kind);
				expect(result.stopReason).toBe(kind === "cancel" ? "aborted" : "error");
				expect(result.content).toEqual([{ type: "text", text: `${canary}PARTIAL` }]);
				expect(result.events).toContain("text_delta");
				expect(result.events.at(-1)).toBe("error");
				expect(result.events).not.toContain("done");
			}
			expect(value.remote.find((item: { kind: string }) => item.kind === "url-query")).toMatchObject({
				stopReason: "error",
				content: [],
			});
			expect(value.requests.filter((request: { method: string }) => request.method === "GET")).toHaveLength(1);
			expect(value.requests.filter((request: { method: string }) => request.method === "POST")).toHaveLength(3);
			for (const request of value.requests) {
				expect(request.authorization).toBeNull();
				expect(request.credential).toBeNull();
				expect(request.path).toBe(request.method === "GET" ? "/v1/models" : "/v1/chat/completions");
			}
			const { raw, records } = await box.logs();
			expect(raw).not.toContain(canary);
			expectClosedOperations(records);
			const diagnostics = records.filter(record => record.component === "jchtools");
			const absent = diagnostics.find(
				record => record.event === "jchtools_discovery_finished" && record.result === "pipe-absent",
			);
			expect(absent).toMatchObject({ stage: "ipc_connect" });
			expect(sameOperation(diagnostics, absent as RecordLine).some(record => record.level === "error")).toBe(false);
			expect(
				diagnostics.some(
					record =>
						record.event === "jchtools_discovery_finished" &&
						record.result === "JSON" &&
						record.stage === "decode_json",
				),
			).toBe(true);
			expect(
				diagnostics.some(
					record =>
						record.event === "jchtools_discovery_finished" &&
						record.result === "oversize" &&
						record.stage === "read_header",
				),
			).toBe(true);
			const discoveries = diagnostics.filter(record => record.event === "jchtools_discovery_started");
			expect(new Set(discoveries.map(record => record.operation_id)).size).toBe(value.discovery.length);
			expect(new Set(discoveries.map(record => record.call_id)).size).toBe(value.discovery.length);
			const cancelledDiscovery = diagnostics.find(
				record => record.event === "jchtools_discovery_finished" && record.result === "aborted",
			);
			expect(cancelledDiscovery).toMatchObject({ stage: "resolve_pipe" });
			expect(
				sameOperation(diagnostics, cancelledDiscovery as RecordLine).some(record => record.level === "error"),
			).toBe(false);
			const models = diagnostics.find(record => record.event === "jchtools_models_finished");
			expect(models).toMatchObject({ result: "http-non2xx", status: 503, stage: "http_request" });
			expect(
				sameOperation(diagnostics, models as RecordLine).some(
					record => record.event === "jchtools_discovery_finished" && record.result === "success",
				),
			).toBe(true);
			const remote = diagnostics.filter(record => record.event === "jchtools_request_finished");
			expect(
				remote.some(
					record => record.result === "failed" && record.status === 503 && record.stage === "http_error_body",
				),
			).toBe(true);
			const truncated = remote.find(record => record.result === "failed" && record.status === 200);
			expect(truncated).toMatchObject({
				stage: "decode_sse_json",
				first_event_received: true,
				text_received: true,
				finish_marker_received: false,
				done_marker_received: false,
			});
			expect(
				sameOperation(diagnostics, truncated as RecordLine).some(
					record => record.event === "jchtools_request_first_text",
				),
			).toBe(true);
			const invalidUrl = remote.find(record => record.stage === "construct_request");
			expect(invalidUrl).toMatchObject({ result: "failed" });
			expect(
				sameOperation(diagnostics, invalidUrl as RecordLine).some(
					record => record.event === "jchtools_request_http_started",
				),
			).toBe(false);
			for (const end of remote.filter(record => record.result === "aborted")) {
				expect(sameOperation(diagnostics, end).some(record => record.level === "error")).toBe(false);
			}
			expect(remote.some(record => record.result === "aborted")).toBe(true);
			const requests = diagnostics.filter(record => record.event === "jchtools_request_started");
			expect(new Set(requests.map(record => record.operation_id)).size).toBe(value.remote.length);
			expect(new Set(requests.map(record => record.call_id)).size).toBe(value.remote.length);
			for (const start of requests) {
				const own = diagnostics.filter(record => record.call_id === start.call_id);
				expect(own.every(record => record.operation_id === start.operation_id)).toBe(true);
				expect(own.filter(record => record.event === "jchtools_request_finished")).toHaveLength(1);
			}
			const httpFailure = remote.find(record => record.status === 503);
			const httpStart = requests.find(record => record.operation_id === httpFailure?.operation_id);
			const otherStart = requests.find(record => record.operation_id === truncated?.operation_id);
			expect(httpStart).toBeDefined();
			expect(otherStart).toBeDefined();
			// Both scripted requests must start before the barrier releases either response.
			expect(diagnostics.indexOf(httpStart as RecordLine)).toBeLessThan(
				diagnostics.indexOf(truncated as RecordLine),
			);
			expect(diagnostics.indexOf(otherStart as RecordLine)).toBeLessThan(
				diagnostics.indexOf(httpFailure as RecordLine),
			);
		} finally {
			await box.cleanup();
		}
	}, 35_000);

	it("keeps INFO-level dialog outcomes distinct and closes SQLite list failures without leaking host content", async () => {
		const box = await sandbox("info");
		const canary = "FORKDIAGNOSTICBOUNDARYPRIVATE";
		try {
			const value = await box.probe("boundaries", canary);
			expect(value.listFailure).toBe("SQLiteError");
			expect(
				value.dialogs.map((dialog: { kind: string; value?: string; failure?: string }) => ({
					kind: dialog.kind,
					value: dialog.value,
					failure: dialog.failure,
				})),
			).toEqual([
				{ kind: "responded", value: `${canary}ANSWER`, failure: undefined },
				{ kind: "cancelled", value: undefined, failure: undefined },
				{ kind: "timed_out", value: undefined, failure: undefined },
				{ kind: "aborted", value: undefined, failure: undefined },
				{ kind: "failed", value: undefined, failure: "Error" },
				{ kind: "disconnected", value: undefined, failure: "Error" },
				{ kind: "editor_aborted", value: undefined, failure: undefined },
			]);
			expect(value.dialogs.every((dialog: { pending: number }) => dialog.pending === 0)).toBe(true);
			const { raw, records } = await box.logs();
			expect(raw).not.toContain(canary);
			const starts = records.filter(record => record.event === "rpc_dialog_started");
			const endings = records.filter(record => record.event === "rpc_dialog_terminal");
			expect(starts).toHaveLength(7);
			expect(endings.map(record => record.result)).toEqual([
				"responded",
				"cancelled",
				"timed_out",
				"aborted",
				"failed",
				"disconnected",
				"aborted",
			]);
			for (const start of starts) {
				const own = endings.filter(end => end.dialog_id === start.dialog_id);
				expect(own).toHaveLength(1);
				expect(own[0]?.operation_id).toBe(start.operation_id);
				expect(start.operation_id).toBe("boundary-parent");
				expect(own[0]?.request_id).toBe("dialog-command");
				expect(typeof own[0]?.elapsed_ms).toBe("number");
			}
			for (const end of endings.filter(record => record.result === "cancelled" || record.result === "aborted")) {
				expect(end.level).toBe("info");
			}
			const lists = records.filter(record => record.event === "docs.list");
			const listStarts = lists.filter(record => record.result === "started");
			expect(listStarts).toHaveLength(2);
			for (const start of listStarts) {
				expect(
					lists.filter(record => record.call_id === start.call_id && record.result !== "started"),
				).toHaveLength(1);
			}
			expect(lists.find(record => record.result === "failed")).toMatchObject({
				level: "error",
				stage: "query",
				error_type: "SQLiteError",
			});
		} finally {
			await box.cleanup();
		}
	}, 35_000);

	it("closes offline CLI initialization without leaking rejected configuration paths", async () => {
		const box = await sandbox("info");
		const canary = "FORKDIAGNOSTICCATALOGPRIVATE";
		try {
			const success = await box.cli(["models", "refresh", "--json", "--no-extensions"]);
			expect(success.code).toBe(0);
			const payload = JSON.parse(success.stdout) as { models: unknown[] };
			const rejected = await box.cli(["models", "find", "--json", "--no-extensions"]);
			expect(rejected.code).toBe(1);
			const failed = await box.cli([
				"models",
				"refresh",
				"--json",
				"--no-extensions",
				"--config",
				path.join(box.root, `${canary}.yml`),
			]);
			expect(failed.code).toBe(1);
			const { raw, records } = await box.logs();
			expect(raw).not.toContain(canary);
			const refresh = records.find(
				record =>
					record.event === "offline_model_refresh" &&
					record.stage === "builtin_refresh" &&
					record.result === "completed",
			);
			expect(refresh).toMatchObject({
				strategy: "offline",
				cache_only: true,
				available_model_count: payload.models.length,
			});
			const rejection = records.find(record => record.event === "models_command" && record.result === "rejected");
			expect(rejection).toMatchObject({ level: "info", reason: "missing_search_substring" });
			const initFailed = records.find(record => record.event === "models_init" && record.result === "failed");
			expect(initFailed).toMatchObject({ level: "error", stage: "settings_init", elapsed_ms: expect.any(Number) });
			const initStart = records.find(
				record =>
					record.event === "models_init" && record.result === "started" && record.call_id === initFailed?.call_id,
			);
			expect(initStart?.operation_id).toBe(initFailed?.operation_id);
			expect(initStart?.call_id).toEqual(expect.any(String));
		} finally {
			await box.cleanup();
		}
	}, 120_000);
});
