import { describe, expect, test } from "bun:test";
import type { Subprocess } from "bun";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getOfflineShmState } from "@oh-my-pi/pi-natives/offline-root";
import { isRecord, readJsonl, withTimeout } from "@oh-my-pi/pi-utils";

// All execution goes through the real CLI. Only the model and the passage of
// the ten-minute backup interval are controlled locally; no production bypass.
const cli = path.resolve(import.meta.dir, "../src/cli.ts");
const profile = "public-boundary";
const evidence = "OFFLINE_SHM_PUBLIC_EVIDENCE seven independent cycles";
type Frame = Record<string, unknown>;

async function until<T>(read: () => Promise<T | undefined>, message: string): Promise<T> {
	// Cross-process filesystem publication cannot be advanced by parent fake
	// timers. Poll the actual condition with a bounded watchdog, never a fixed wait.
	const deadline = Date.now() + 30_000;
	for (;;) {
		const result = await read();
		if (result !== undefined) return result;
		if (Date.now() >= deadline) throw new Error(message);
		await Bun.sleep(20);
	}
}

async function fixture(offline = true, withModel = true) {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-shm-public-"));
	const persistentRoot = path.join(directory, "original-data");
	const cwd = path.join(directory, "project");
	const home = path.join(directory, "home");
	const env: Record<string, string | undefined> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (/^(?:path|systemroot|windir|comspec|pathext|systemdrive|lang|lc_all)$/i.test(key)) env[key] = value;
	}
	Object.assign(env, {
		HOME: home,
		USERPROFILE: home,
		OMP_CONFIG_ROOT: persistentRoot,
		OMP_PROFILE: profile,
		PI_PROFILE: profile,
		PI_CONFIG_DIR: ".omp",
		OMP_OFFLINE: offline ? "1" : "0",
		OMP_JCHTOOLS_DISCOVERY: "0",
		PI_NO_TITLE: "1",
		// These abandoned overrides must not redirect active data.
		PI_CODING_AGENT_DIR: path.join(directory, "legacy-agent"),
		OMP_WIKI_DIR: path.join(directory, "legacy-wiki"),
	});
	const state = getOfflineShmState(env);
	const runtimeRoot = state?.runtimeRoot ?? persistentRoot;
	const profileRoot = path.join(runtimeRoot, "profiles", profile);
	const agent = path.join(profileRoot, "agent");
	for (const dir of [cwd, home, agent]) await fs.mkdir(dir, { recursive: true, mode: 0o700 });
	let turn = 0;
	const requests: Frame[] = [];
	const model = withModel
		? Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				async fetch(request) {
					if (!new URL(request.url).pathname.endsWith("/chat/completions"))
						return new Response("not found", { status: 404 });
					const body: unknown = await request.json();
					if (!isRecord(body)) return new Response("invalid", { status: 400 });
					requests.push(body);
					const delta =
						turn++ % 2 === 0
							? {
									role: "assistant",
									tool_calls: [
										{
											index: 0,
											id: `wiki-${turn}`,
											type: "function",
											function: {
												name: "wiki",
												arguments: JSON.stringify({ query: "OFFLINE_SHM_PUBLIC_EVIDENCE" }),
											},
										},
									],
								}
							: { role: "assistant", content: "PUBLIC_QUERY_COMPLETED" };
					const base = { id: `public-${turn}`, object: "chat.completion.chunk", created: 0, model: "local" };
					const chunks = [
						{ ...base, choices: [{ index: 0, delta, finish_reason: null }] },
						{
							...base,
							choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" in delta ? "tool_calls" : "stop" }],
							usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
						},
					];
					return new Response(
						`${chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`,
						{
							headers: { "content-type": "text/event-stream" },
						},
					);
				},
			})
		: undefined;
	const config =
		"modelRoles: {}\nadvisor:\n  enabled: false\nstartup:\n  setupWizard: false\n  checkUpdate: false\nmarketplace:\n  autoUpdate: off\ncompaction:\n  enabled: false\nskills:\n  enableCodexUser: false\n  enableClaudeUser: false\n  enableClaudeProject: false\n  enablePiUser: false\n  enablePiProject: false\n  enableAgentsUser: false\n  enableAgentsProject: false\n";
	// This is explicit fixture preparation in the resolved root, not automatic
	// restoration. Stale persistent config is tested before seeding config.yml.
	if (model) {
		await Bun.write(
			path.join(agent, "models.yml"),
			`providers:\n  shm-local:\n    baseUrl: http://127.0.0.1:${model.port}/v1\n    auth: none\n    api: openai-completions\n    models:\n      - id: local\n        reasoning: false\n        contextWindow: 32768\n        maxTokens: 1024\n`,
		);
	}
	const children = new Set<Subprocess<"pipe", "pipe", "pipe">>();
	function spawn(args: readonly string[], preload?: string) {
		const child = Bun.spawn([process.execPath, ...(preload ? ["--preload", preload] : []), cli, ...args], {
			cwd,
			env,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		children.add(child);
		return child;
	}
	async function run(args: string[]) {
		const start = performance.now();
		const child = spawn(args);
		child.stdin.end();
		let firstOutputMs: number | undefined;
		const stdout = (async () => {
			const chunks: Uint8Array[] = [];
			for await (const chunk of child.stdout as ReadableStream<Uint8Array>) {
				firstOutputMs ??= performance.now() - start;
				chunks.push(chunk);
			}
			return Buffer.concat(chunks).toString("utf8");
		})();
		const stderr = new Response(child.stderr).text();
		const code = await withTimeout(child.exited, 40_000, `CLI did not exit: ${args.join(" ")}`);
		return { code, stdout: await stdout, stderr: await stderr, firstOutputMs };
	}
	async function rpc(preload?: string) {
		const start = performance.now();
		const child = spawn(
			[
				"--mode",
				"rpc-ui",
				"--no-ui",
				"--no-rules",
				"--no-extensions",
				"--tools",
				"wiki",
				"--provider",
				"shm-local",
				"--model",
				"local",
				"--thinking",
				"off",
			],
			preload,
		);
		const stderr = new Response(child.stderr).text();
		const frames: Frame[] = [];
		const queue: Frame[] = [];
		const waiters = new Set<() => void>();
		let done = false;
		let readerError: unknown;
		let firstOutputMs: number | undefined;
		const pump = (async () => {
			try {
				for await (const frame of readJsonl<unknown>(child.stdout as ReadableStream<Uint8Array>)) {
					firstOutputMs ??= performance.now() - start;
					if (!isRecord(frame)) continue;
					frames.push(frame);
					queue.push(frame);
					for (const notify of waiters) notify();
					waiters.clear();
				}
			} catch (error) {
				readerError = error;
			} finally {
				done = true;
				for (const notify of waiters) notify();
				waiters.clear();
			}
		})();
		async function next(predicate: (frame: Frame) => boolean): Promise<Frame> {
			return await withTimeout(
				(async () => {
					for (;;) {
						const index = queue.findIndex(predicate);
						if (index >= 0) return queue.splice(index, 1)[0]!;
						if (done) throw readerError ?? new Error(`RPC exited: ${await stderr}`);
						const changed = Promise.withResolvers<void>();
						waiters.add(changed.resolve);
						try {
							await changed.promise;
						} finally {
							waiters.delete(changed.resolve);
						}
					}
				})(),
				40_000,
				"RPC public entry did not respond",
			);
		}
		let serial = 0;
		async function request(frame: { type: string; [key: string]: unknown }) {
			const id = `public-${++serial}`;
			child.stdin.write(`${JSON.stringify({ ...frame, id })}\n`);
			return await next(response => response.type === "response" && response.id === id);
		}
		await next(frame => frame.type === "ready");
		const readinessMs = performance.now() - start;
		expect(await request({ type: "negotiate_protocol", protocolVersion: 3 })).toMatchObject({ success: true });
		let closed = false;
		return {
			pid: child.pid,
			frames,
			next,
			request,
			readinessMs,
			firstOutputMs,
			async query() {
				const response = await request({ type: "prompt", message: "Search the local imported evidence." });
				expect(response.success).toBe(true);
				expect(await next(frame => frame.type === "prompt_result" && frame.id === response.id)).toMatchObject({
					status: "completed",
				});
				const results = frames.filter(frame => frame.type === "tool_execution_end");
				expect(
					results.some(
						frame =>
							frame.toolName === "wiki" &&
							frame.isError !== true &&
							JSON.stringify(frame.result).includes(evidence),
					),
				).toBe(true);
			},
			async close() {
				if (closed) return;
				closed = true;
				child.stdin.end();
				expect(await withTimeout(child.exited, 10_000, "RPC EOF waited for backup")).toBe(0);
				await pump;
			},
			async [Symbol.asyncDispose]() {
				if (!closed) {
					child.stdin.end();
					try {
						await withTimeout(child.exited, 10_000, "RPC cleanup timeout");
					} finally {
						if (child.exitCode === null) child.kill();
						await child.exited;
						await pump;
					}
				}
			},
		};
	}
	return {
		directory,
		persistentRoot,
		runtimeRoot,
		profileRoot,
		agent,
		cwd,
		state,
		env,
		requests,
		config,
		spawn,
		run,
		rpc,
		async [Symbol.asyncDispose]() {
			for (const child of children) if (child.exitCode === null) child.kill();
			await Promise.all([...children].map(child => child.exited));
			model?.stop(true);
			if (state) await fs.rm(path.dirname(state.runtimeRoot), { recursive: true, force: true });
			await fs.rm(directory, { recursive: true, force: true });
		},
	};
}

function quote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}
function stateData(frame: Frame): Frame {
	expect(frame.success).toBe(true);
	if (!isRecord(frame.data)) throw new Error("Missing public RPC state");
	return frame.data;
}
function within(root: string, filename: unknown): string {
	if (typeof filename !== "string") throw new Error("Missing persisted path");
	const relative = path.relative(root, filename);
	expect(relative).not.toBe("..");
	expect(relative.startsWith(`..${path.sep}`)).toBe(false);
	expect(path.isAbsolute(relative)).toBe(false);
	return filename;
}
interface DocsFixture {
	cwd: string;
	run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }>;
}

async function importDocs(box: DocsFixture) {
	const documents = path.join(box.cwd, "documents");
	await fs.mkdir(documents, { mode: 0o700 });
	await Bun.write(path.join(documents, "guide.md"), `# Offline evidence\n${evidence}\n`);
	const imported = await box.run(["docs", "init", documents, "--name", "public-evidence", "--json"]);
	expect(imported.code).toBe(0);
	expect(JSON.parse(imported.stdout).index).toMatchObject({ name: "public-evidence", documentCount: 1 });
	return documents;
}

async function backupTiming(directory: string) {
	const control = path.join(directory, "timing");
	await fs.mkdir(control, { mode: 0o700 });
	const timeline = path.join(control, "events.jsonl");
	const wrapper = path.join(control, "backup-gate.ts");
	const preload = path.join(control, "preload.ts");
	await Bun.write(
		wrapper,
		`import * as fs from 'node:fs';
import { parentPort } from 'node:worker_threads';
const control = ${JSON.stringify(control)};
const round = fs.readFileSync(control + '/tick', 'utf8').trim();
fs.appendFileSync(control + '/events.jsonl', JSON.stringify({event:'worker-started',pid:process.pid,round}) + '\\n');
// Parent fake timers cannot drive another worker; poll the release condition,
// never assert an elapsed sleep. Static imports would bypass this loading gate.
while (!fs.existsSync(control + '/release-' + round)) await Bun.sleep(10);
await import(${JSON.stringify(cli)});
parentPort.postMessage({fixtureReady:true});
`,
	);
	await Bun.write(
		preload,
		`import * as fs from 'node:fs';
const control = ${JSON.stringify(control)};
const emit = value => fs.appendFileSync(control + '/events.jsonl', JSON.stringify({pid:process.pid,...value}) + '\\n');
let ready = false;
const write = process.stdout.write;
process.stdout.write = function(...args) { if (String(args[0]).includes('"type":"ready"')) { ready = true; emit({event:'ready'}); } return write.apply(this,args); };
const interval = globalThis.setInterval;
// Parent fake timers cannot drive separate CLI processes. Poll the control-file
// condition; only the ten-minute schedule is virtualized, never engine behavior.
globalThis.setInterval = function(callback, delay, ...args) {
 if (delay !== 600000) return interval(callback, delay, ...args);
 emit({event:'armed',ready,delay});
 let previous = 0;
 return interval(() => { let current = 0; try { current = Number(fs.readFileSync(control + '/tick','utf8')); } catch {} if (current > previous) { previous = current; emit({event:'period',round:String(current),elapsed:current * delay}); callback(...args); } }, 10);
};
const NativeWorker = globalThis.Worker;
globalThis.Worker = class extends NativeWorker {
 constructor(entry, options) {
  if (options?.argv?.includes('__omp_worker_offline_shm_backup')) {
   const round = fs.readFileSync(control + '/tick','utf8').trim();
   emit({event:'worker-created',ready,round});
   super(${JSON.stringify(wrapper)}, options);
   const send = this.postMessage.bind(this);
   let pending;
   this.postMessage = value => { pending = value; };
   this.addEventListener('message', event => {
    if (event.data?.fixtureReady) {
     event.stopImmediatePropagation();
     this.postMessage = send;
     if (pending !== undefined) send(pending);
     return;
    }
    emit({event:'worker-result',round,...event.data});
   });
   this.addEventListener('close', () => queueMicrotask(() => emit({event:'worker-closed',round})));
   this.addEventListener('error', event => emit({event:'worker-error',round,message:String(event.message)}));
  }
  else super(entry,options);
 }
};
`,
	);
	const events = async (): Promise<Frame[]> => {
		if (!(await Bun.file(timeline).exists())) return [];
		return (await Bun.file(timeline).text())
			.trim()
			.split("\n")
			.filter(Boolean)
			.map(line => JSON.parse(line) as Frame);
	};
	return {
		preload,
		events,
		async tick(round: number) {
			await Bun.write(path.join(control, "tick"), String(round));
		},
		async release(round: number) {
			await Bun.write(path.join(control, `release-${round}`), "release real engine");
		},
		async started(round: number) {
			return await until(
				async () =>
					(await events()).find(event => event.event === "worker-started" && event.round === String(round)),
				`Backup worker did not start in period ${round}`,
			);
		},
		async closed(round: number) {
			try {
				await until(
					async () =>
						(await events()).find(event => event.event === "worker-closed" && event.round === String(round)),
					`Backup worker did not close in period ${round}`,
				);
			} catch (error) {
				throw new Error(`Backup worker period ${round} did not close; events=${JSON.stringify(await events())}`, {
					cause: error,
				});
			}
		},
	};
}

const linux = process.platform === "linux";
describe.skipIf(!linux)("Linux offline shm through the public CLI", () => {
	test.each([
		{ name: "acp", args: ["acp"] },
		{ name: "--mode acp", args: ["--mode", "acp"] },
		{ name: "launch --mode acp", args: ["launch", "--mode", "acp"] },
	])(
		"$name backs up only after a period, reports real failures off stdout and exits during a blocked round",
		async ({ args }) => {
			await using box = await fixture(true, false);
			await Bun.write(path.join(box.agent, "config.yml"), box.config);
			const timing = await backupTiming(box.directory);
			const child = box.spawn(args, timing.preload);
			const stderr = new Response(child.stderr).text();
			const frames = readJsonl<Frame>(child.stdout as ReadableStream<Uint8Array>)[Symbol.asyncIterator]();
			let serial = 0;
			async function initialize() {
				const id = ++serial;
				child.stdin.write(
					`${JSON.stringify({
						jsonrpc: "2.0",
						id,
						method: "initialize",
						params: { protocolVersion: 1, clientCapabilities: {} },
					})}\n`,
				);
				await child.stdin.flush();
				const frame = await withTimeout(frames.next(), 10_000, "ACP blocked behind offline backup");
				expect(frame.done).toBe(false);
				expect(frame.value).toMatchObject({ jsonrpc: "2.0", id, result: { protocolVersion: 1 } });
				expect(frame.value?.error).toBeUndefined();
			}

			// A live reader is ready even before its first client request. Arming
			// must not depend on the generic command's first-stdout-write hook.
			await until(
				async () => (await timing.events()).find(event => event.event === "armed"),
				"ACP transport did not arm its backup interval",
			);
			await initialize();
			expect((await timing.events()).filter(event => event.event === "armed")).toHaveLength(1);
			expect((await timing.events()).some(event => event.event === "worker-created")).toBe(false);
			expect(await Bun.file(box.persistentRoot).exists()).toBe(false);

			// Fail the real engine deterministically, including when run as root.
			// The preload controls time and the worker gate, not its result or notice.
			await fs.writeFile(box.persistentRoot, "not a backup directory", { mode: 0o600 });
			await timing.tick(1);
			await timing.started(1);
			expect((await timing.events()).find(event => event.event === "period")).toMatchObject({ elapsed: 600_000 });
			await initialize();
			await timing.release(1);
			await timing.closed(1);
			expect(
				(await timing.events()).filter(event => event.event === "worker-result" && event.status === "failed"),
			).toHaveLength(1);
			await initialize();

			// A second real round stays blocked at the worker gate. EOF must stop
			// its owner without waiting for NFS, releasing the gate or a final copy.
			await timing.tick(2);
			await timing.started(2);
			await initialize();
			expect((await timing.events()).filter(event => event.event === "armed")).toHaveLength(1);
			expect((await timing.events()).filter(event => event.event === "worker-created")).toHaveLength(2);
			child.stdin.end();
			expect(await withTimeout(child.exited, 10_000, "ACP EOF waited for offline backup")).toBe(0);
			expect(await withTimeout(frames.next(), 5_000, "ACP stdout did not close")).toMatchObject({ done: true });
			const stderrText = await stderr;
			expect(stderrText).toContain("Offline shm backup failed");
			expect(stderrText).toContain("Frontend continues using shm");
			expect(stderrText.split("Offline shm backup failed").length - 1).toBe(1);
			for (const line of stderrText.split("\n")) {
				if (!line.trimStart().startsWith("{")) continue;
				let frame: unknown;
				try {
					frame = JSON.parse(line);
				} catch {
					continue;
				}
				if (isRecord(frame)) expect(frame.jsonrpc).toBeUndefined();
			}
		},
		120_000,
	);

	test("rejects a manually restored Wiki database symlink before opening external data", async () => {
		// Docs uses its public CLI directly, without a model server or network.
		await using box = await fixture(true, false);
		const oldAgent = path.join(box.persistentRoot, "profiles", profile, "agent");
		await fs.mkdir(oldAgent, { recursive: true, mode: 0o700 });
		const oldDatabase = path.join(oldAgent, "docs.db");
		const old = new Database(oldDatabase);
		try {
			old.exec("PRAGMA journal_mode = DELETE; CREATE TABLE old_wiki_sentinel (value TEXT NOT NULL)");
			old.query("INSERT INTO old_wiki_sentinel (value) VALUES (?)").run("old Wiki must remain untouched");
		} finally {
			old.close();
		}
		const before = await fs.readFile(oldDatabase);
		const restoredDatabase = path.join(box.agent, "docs.db");
		await fs.symlink(oldDatabase, restoredDatabase);
		const documents = path.join(box.cwd, "documents");
		await fs.mkdir(documents, { mode: 0o700 });
		await Bun.write(path.join(documents, "guide.md"), `# Offline evidence\n${evidence}\n`);

		const imported = await box.run(["docs", "init", documents, "--name", "public-evidence", "--json"]);
		expect(imported.code).not.toBe(0);
		expect(`${imported.stdout}\n${imported.stderr}`).toContain("Unsafe offline shm path");
		expect(`${imported.stdout}\n${imported.stderr}`).toContain(restoredDatabase);
		expect(await fs.readFile(oldDatabase)).toEqual(before);
		expect((await fs.lstat(restoredDatabase)).isSymbolicLink()).toBe(true);
		for (const database of [oldDatabase, restoredDatabase]) {
			for (const suffix of ["-wal", "-shm", "-journal"]) {
				await expect(fs.lstat(`${database}${suffix}`)).rejects.toMatchObject({ code: "ENOENT" });
			}
		}
	}, 60_000);

	test("ignores abandoned disk config and Wiki override, keeps public config/session/index state in shm and nested roots unchanged", async () => {
		await using box = await fixture();
		const staleConfig = path.join(box.persistentRoot, "profiles", profile, "agent", "config.yml");
		await fs.mkdir(path.dirname(staleConfig), { recursive: true, mode: 0o700 });
		await Bun.write(staleConfig, "compaction:\n  enabled: false\n");
		const fresh = await box.run(["config", "get", "compaction.enabled", "--json"]);
		expect(fresh.code).toBe(0);
		expect(JSON.parse(fresh.stdout).value).toBe(true);
		expect(await Bun.file(staleConfig).text()).toBe("compaction:\n  enabled: false\n");
		await Bun.write(path.join(box.agent, "config.yml"), box.config);
		const documents = await importDocs(box);
		const explicit = await box.run(["read", path.join(documents, "guide.md")]);
		expect(explicit.code).toBe(0);
		expect(explicit.stdout).toContain(evidence);
		await fs.rename(documents, `${documents}-unavailable`);
		await using rpc = await box.rpc();
		await rpc.query();
		const state = stateData(await rpc.request({ type: "get_state" }));
		const sessionFile = within(box.profileRoot, state.sessionFile);
		expect(await rpc.request({ type: "set_session_name", name: "shm-public-session" })).toMatchObject({
			success: true,
		});
		// A genuine nested OMP command is launched by the public RPC bash route.
		// Its config-path output proves the child did not remap shm as a new root.
		const nested = stateData(
			await rpc.request({
				type: "bash",
				command: `printf 'ORIGINAL_ROOT=%s\\n' "$OMP_CONFIG_ROOT"; ${quote(process.execPath)} ${quote(cli)} config path; ${quote(process.execPath)} ${quote(cli)} config set compaction.enabled true --json`,
			}),
		);
		expect(nested.exitCode).toBe(0);
		expect(String(nested.output)).toContain(`ORIGINAL_ROOT=${box.persistentRoot}`);
		expect(String(nested.output)).toContain(box.agent);
		expect(await Bun.file(path.join(box.agent, "config.yml")).text()).toContain("enabled: true");
		await rpc.close();
		expect(await Bun.file(sessionFile).text()).toContain("shm-public-session");
		expect(await Bun.file(path.join(box.agent, "docs.db")).exists()).toBe(true);
		expect(await Bun.file(path.join(box.env.OMP_WIKI_DIR!, "docs.db")).exists()).toBe(false);
		expect(await Bun.file(path.join(box.env.PI_CODING_AGENT_DIR!, "config.yml")).exists()).toBe(false);
		expect(await fs.readdir(box.persistentRoot)).not.toContain(".offline-shm-backups");
		// Closing the owning CLI must preserve its runtime for the next process.
		await using reopened = await box.rpc();
		await reopened.query();
	}, 180_000);

	test("starts a real recoverable backup only after ready plus one virtual period, stays responsive and exits during a blocked round", async () => {
		await using box = await fixture();
		await Bun.write(path.join(box.agent, "config.yml"), box.config);
		await importDocs(box);
		if (!box.state) throw new Error("Linux offline state missing");
		const timing = await backupTiming(box.directory);
		const { events, preload } = timing;
		await using rpc = await box.rpc(preload);
		await until(async () => (await events()).find(event => event.event === "armed"), "Backup interval was not armed");
		expect((await events()).filter(event => event.event === "armed")).toEqual([
			{ event: "armed", pid: rpc.pid, ready: true, delay: 600_000 },
		]);
		expect((await events()).some(event => event.event === "worker-created")).toBe(false);
		await rpc.query();
		expect(await rpc.request({ type: "set_session_name", name: "recoverable-public-session" })).toMatchObject({
			success: true,
		});
		const activeState = stateData(await rpc.request({ type: "get_state" }));
		const activeSession = within(box.runtimeRoot, activeState.sessionFile);
		const relativeSession = path.relative(box.runtimeRoot, activeSession);
		const domain = path.join(
			box.persistentRoot,
			".offline-shm-backups",
			createHash("sha256").update(box.state.domainId).digest("hex"),
		);
		const pointer = path.join(domain, "current.json");
		expect(await Bun.file(pointer).exists()).toBe(false);
		await timing.tick(1);
		await timing.started(1);
		expect((await events()).find(event => event.event === "period")).toMatchObject({ elapsed: 600_000 });
		stateData(await withTimeout(rpc.request({ type: "get_state" }), 5_000, "RPC blocked behind backup"));
		expect(await Bun.file(pointer).exists()).toBe(false);
		await timing.release(1);
		const current = await until(
			async () =>
				(await Bun.file(pointer).exists()) ? ((await Bun.file(pointer).json()) as { current: string }) : undefined,
			"Actual backup did not publish",
		);
		const generation = path.join(domain, "generations", current.current);
		const manifest = await Bun.file(path.join(generation, "manifest.json")).json();
		expect(manifest).toMatchObject({
			status: "complete",
			persistentRoot: box.persistentRoot,
			runtimeRoot: box.runtimeRoot,
		});
		const relativeDb = path.relative(box.runtimeRoot, path.join(box.agent, "docs.db"));
		expect(manifest.entries).toContainEqual(expect.objectContaining({ path: relativeDb, kind: "sqlite" }));
		expect(manifest.entries).toContainEqual(expect.objectContaining({ path: relativeSession, kind: "file" }));
		expect(await Bun.file(path.join(generation, "data", relativeSession)).text()).toBe(
			await Bun.file(activeSession).text(),
		);
		expect(await Bun.file(path.join(generation, "data", relativeSession)).text()).toContain(
			"recoverable-public-session",
		);
		const savedDb = path.join(generation, "data", relativeDb);
		const independent = new Database(savedDb, { readonly: true, create: false });
		try {
			expect(independent.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
			expect(independent.query("SELECT name FROM doc_indexes").all()).toEqual([{ name: "public-evidence" }]);
			expect(
				independent
					.query("SELECT raw_markdown FROM sections")
					.all()
					.some(row => isRecord(row) && String(row.raw_markdown).includes(evidence)),
			).toBe(true);
		} finally {
			independent.close();
		}
		expect(await Bun.file(`${savedDb}-wal`).exists()).toBe(false);
		// A completion log can precede the worker close event; drive the next
		// virtual period only after the owning lifecycle observed that close.
		await timing.closed(1);
		await timing.tick(2);
		await timing.started(2);
		stateData(await withTimeout(rpc.request({ type: "get_state" }), 5_000, "RPC blocked during second round"));
		await rpc.close();
		expect(await Bun.file(pointer).json()).toMatchObject({ current: current.current });
		expect(await Bun.file(path.join(box.agent, "docs.db")).exists()).toBe(true);
		// Explicit manual recovery into another owned, inactive, empty shm root.
		// Move preparation out of the way, then restore the whole completed data/.
		await using recovered = await fixture();
		await fs.rm(recovered.runtimeRoot, { recursive: true, force: true });
		await fs.cp(path.join(generation, "data"), recovered.runtimeRoot, { recursive: true, preserveTimestamps: true });
		expect(await Bun.file(path.join(recovered.runtimeRoot, relativeSession)).text()).toContain(
			"recoverable-public-session",
		);
		// Restored provider URLs point at the still-running local fixture server.
		await using restoredRpc = await recovered.rpc();
		await restoredRpc.query();
	}, 180_000);

	test("bounds real filesystem failure notices, remains responsive, and retries at a later normal period with the latest loss boundary", async () => {
		await using box = await fixture();
		await Bun.write(path.join(box.agent, "config.yml"), box.config);
		await importDocs(box);
		if (!box.state) throw new Error("Linux offline state missing");
		const timing = await backupTiming(box.directory);
		await using rpc = await box.rpc(timing.preload);
		await until(
			async () => (await timing.events()).find(event => event.event === "armed"),
			"Backup interval was not armed",
		);
		const domain = path.join(
			box.persistentRoot,
			".offline-shm-backups",
			createHash("sha256").update(box.state.domainId).digest("hex"),
		);
		const pointer = path.join(domain, "current.json");
		// A file at the target ancestor fails even as root. Do not depend on
		// chmod, replace the engine, or synthesize a warning in the preload.
		await fs.writeFile(box.persistentRoot, "not a backup directory", { mode: 0o600 });
		for (const round of [1, 2]) {
			await timing.tick(round);
			await timing.started(round);
			stateData(await withTimeout(rpc.request({ type: "get_state" }), 5_000, "RPC blocked behind failed backup"));
			await timing.release(round);
			await timing.closed(round);
			stateData(await withTimeout(rpc.request({ type: "get_state" }), 5_000, "RPC stopped after backup failure"));
		}
		const firstNotice = await rpc.next(frame => frame.type === "notice" && frame.source === "offline-shm-backup");
		expect(firstNotice).toMatchObject({ level: "warning", source: "offline-shm-backup" });
		expect(String(firstNotice.message)).toContain("startup (no successful domain backup recorded)");
		expect(String(firstNotice.message)).toContain("Frontend continues using shm");
		expect(String(firstNotice.message)).toContain("may be lost");
		expect(String(firstNotice.message).length).toBeLessThan(512);
		expect(String(firstNotice.message)).not.toContain(box.directory);
		let failures = (await timing.events()).filter(
			event => event.event === "worker-result" && event.status === "failed",
		);
		expect(failures).toHaveLength(2);
		for (const failure of failures) {
			expect(String(failure.errorCode)).toMatch(/^(?:ENOTDIR|EEXIST)$/);
			expect(String(firstNotice.message)).toContain(`(${failure.errorCode})`);
		}
		expect(rpc.frames.filter(frame => frame.type === "notice" && frame.source === "offline-shm-backup")).toHaveLength(
			1,
		);

		await fs.rm(box.persistentRoot);
		await fs.mkdir(box.persistentRoot, { mode: 0o700 });
		// A public request is a protocol barrier, not a guessed delay. Repair
		// alone must not create an immediate/queued retry between normal ticks.
		stateData(await rpc.request({ type: "get_state" }));
		expect((await timing.events()).filter(event => event.event === "worker-created")).toHaveLength(2);
		expect(await Bun.file(pointer).exists()).toBe(false);
		await timing.tick(3);
		await timing.started(3);
		await timing.release(3);
		await timing.closed(3);
		const current = (await Bun.file(pointer).json()) as { current: string; completedAt: string };
		expect(Number.isFinite(Date.parse(current.completedAt))).toBe(true);
		expect(await Bun.file(path.join(domain, "generations", current.current, "manifest.json")).json()).toMatchObject({
			status: "complete",
			completedAt: current.completedAt,
		});
		expect(
			(await timing.events()).filter(event => event.event === "worker-result" && event.status === "completed"),
		).toHaveLength(1);

		// Keep the published generation intact while causing the same genuine
		// ancestor failure again: the new warning must name the successful retry,
		// not startup or a stale previous loss boundary.
		const savedRoot = `${box.persistentRoot}-saved`;
		await fs.rename(box.persistentRoot, savedRoot);
		await fs.writeFile(box.persistentRoot, "target unavailable again", { mode: 0o600 });
		for (const round of [4, 5]) {
			await timing.tick(round);
			await timing.started(round);
			await timing.release(round);
			await timing.closed(round);
			stateData(await withTimeout(rpc.request({ type: "get_state" }), 5_000, "RPC blocked after retry failure"));
		}
		const latestNotice = await rpc.next(frame => frame.type === "notice" && frame.source === "offline-shm-backup");
		expect(latestNotice).toMatchObject({ level: "warning", source: "offline-shm-backup" });
		expect(String(latestNotice.message)).toContain(`data since ${current.completedAt} may be lost`);
		expect(String(latestNotice.message)).not.toContain("startup");
		expect(String(latestNotice.message)).not.toContain(box.directory);
		expect(String(latestNotice.message).length).toBeLessThan(512);
		failures = (await timing.events()).filter(event => event.event === "worker-result" && event.status === "failed");
		expect(failures).toHaveLength(4);
		for (const failure of failures.slice(2)) {
			expect(failure.lastSuccessfulAt).toBe(current.completedAt);
			expect(String(failure.errorCode)).toMatch(/^(?:ENOTDIR|EEXIST)$/);
			expect(String(latestNotice.message)).toContain(`(${failure.errorCode})`);
		}
		expect(rpc.frames.filter(frame => frame.type === "notice" && frame.source === "offline-shm-backup")).toHaveLength(
			2,
		);
		expect(
			(await timing.events()).filter(event => event.event === "worker-created").map(event => event.round),
		).toEqual(["1", "2", "3", "4", "5"]);
		await fs.rm(box.persistentRoot);
		await fs.rename(savedRoot, box.persistentRoot);
		expect(await Bun.file(pointer).json()).toEqual(current);
		await rpc.close();
		expect(box.requests).toHaveLength(0);
	}, 180_000);

	test("shares one scheduler across simultaneous public RPC mains and takes over after the owner exits during a blocked round", async () => {
		await using box = await fixture();
		await Bun.write(path.join(box.agent, "config.yml"), box.config);
		if (!box.state) throw new Error("Linux offline state missing");
		const timing = await backupTiming(box.directory);
		await using first = await box.rpc(timing.preload);
		await using second = await box.rpc(timing.preload);
		expect(first.pid).not.toBe(second.pid);
		await until(async () => {
			const armed = (await timing.events()).filter(event => event.event === "armed");
			return armed.length === 2 ? armed : undefined;
		}, "Both public frontends did not arm their backup interval");
		expect((await timing.events()).filter(event => event.event === "armed")).toEqual(
			expect.arrayContaining([
				{ event: "armed", pid: first.pid, ready: true, delay: 600_000 },
				{ event: "armed", pid: second.pid, ready: true, delay: 600_000 },
			]),
		);
		expect((await timing.events()).filter(event => event.event === "worker-created")).toHaveLength(0);
		const pointer = path.join(
			box.persistentRoot,
			".offline-shm-backups",
			createHash("sha256").update(box.state.domainId).digest("hex"),
			"current.json",
		);
		await timing.tick(1);
		const started = await timing.started(1);
		const owner = started.pid === first.pid ? first : second;
		const survivor = owner === first ? second : first;
		expect(started.pid).toBe(owner.pid);
		for (const round of [1, 2]) {
			if (round === 2) await timing.tick(round);
			await until(async () => {
				const periods = (await timing.events()).filter(
					event => event.event === "period" && event.round === String(round),
				);
				return periods.length === 2 ? periods : undefined;
			}, `Both public schedulers did not observe period ${round}`);
			for (const frontend of [first, second]) {
				stateData(
					await withTimeout(
						frontend.request({ type: "get_state" }),
						5_000,
						"Concurrent RPC blocked behind backup",
					),
				);
			}
			// The owner drops an in-flight period; its peer must not launch a
			// redundant worker just to discover the engine lease is busy.
			expect((await timing.events()).filter(event => event.event === "worker-created")).toHaveLength(1);
		}
		await timing.release(1);
		await timing.closed(1);
		const initial = (await Bun.file(pointer).json()) as { current: string };
		await timing.tick(3);
		expect(await timing.started(3)).toMatchObject({ pid: owner.pid });
		await until(
			async () =>
				(await timing.events()).find(
					event => event.event === "period" && event.round === "3" && event.pid === survivor.pid,
				),
			"Surviving frontend did not observe the owner's next period",
		);
		stateData(await withTimeout(survivor.request({ type: "get_state" }), 5_000, "Non-owner RPC became unresponsive"));
		expect((await timing.events()).filter(event => event.event === "worker-created")).toHaveLength(2);
		// No release-3: EOF must terminate the pinned worker and relinquish the
		// scheduler lease, without waiting for filesystem work or a final backup.
		await owner.close();
		expect(await Bun.file(pointer).json()).toEqual(initial);
		await timing.tick(4);
		expect(await timing.started(4)).toMatchObject({ pid: survivor.pid });
		stateData(await withTimeout(survivor.request({ type: "get_state" }), 5_000, "Takeover blocked public RPC"));
		await timing.release(4);
		await timing.closed(4);
		const next = (await Bun.file(pointer).json()) as { current: string; previous: string };
		expect(next.current).not.toBe(initial.current);
		expect(next.previous).toBe(initial.current);
		const workers = (await timing.events()).filter(event => event.event === "worker-created");
		expect(workers.map(event => ({ pid: event.pid, round: event.round }))).toEqual([
			{ pid: owner.pid, round: "1" },
			{ pid: owner.pid, round: "3" },
			{ pid: survivor.pid, round: "4" },
		]);
		expect(
			(await timing.events()).filter(event => event.event === "worker-result" && event.status === "busy"),
		).toHaveLength(0);
		expect(
			(await timing.events()).filter(event => event.event === "worker-result" && event.status === "completed"),
		).toHaveLength(2);
		expect(
			[...first.frames, ...second.frames].filter(
				frame => frame.type === "notice" && frame.source === "offline-shm-backup",
			),
		).toHaveLength(0);
		await survivor.close();
		expect(box.requests).toHaveLength(0);
	}, 180_000);

	test("reports same-code readiness and first-output measurements without claiming cold-disk speedups", async () => {
		const measurements: Array<{
			offline: boolean;
			cliFirstOutputMs: number | undefined;
			rpcFirstOutputMs: number | undefined;
			readinessMs: number;
		}> = [];
		for (const offline of [false, true]) {
			await using box = await fixture(offline);
			// Nonoffline retains its documented PI_CODING_AGENT_DIR override.
			if (!offline) box.env.PI_CODING_AGENT_DIR = box.agent;
			await Bun.write(path.join(box.agent, "config.yml"), box.config);
			const output = await box.run(["config", "path"]);
			expect(output.code).toBe(0);
			expect(output.firstOutputMs).toBeGreaterThan(0);
			await using rpc = await box.rpc();
			stateData(await rpc.request({ type: "get_state" }));
			expect(rpc.readinessMs).toBeGreaterThan(0);
			measurements.push({
				offline,
				cliFirstOutputMs: output.firstOutputMs,
				rpcFirstOutputMs: rpc.firstOutputMs,
				readinessMs: rpc.readinessMs,
			});
			expect(box.requests).toHaveLength(0);
		}
		console.info(
			JSON.stringify({
				experiment: "offline-shm-public-cli",
				cache: "shared OS cache, fresh data domains; not cold-disk measurements",
				speedGuarantee: false,
				measurements,
			}),
		);
	}, 180_000);
});
