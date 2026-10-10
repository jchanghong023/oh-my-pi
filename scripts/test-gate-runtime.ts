import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { appendFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { terminateOwnedSubprocess } from "../packages/utils/src/subprocess";
import type { GateProcessOwner } from "./test-gate-process";
import { ownGateProcess } from "./test-gate-process";
import type { GateEventRelay } from "./test-gate-events";
import { createGateEventRelay } from "./test-gate-events";
import { gateClockNanoseconds } from "./test-gate-clock";

export type GateLevel = "fastcheck" | "fulltest" | "slowtest";
export type GateStatus = "PASS" | "FAIL" | "TIMEOUT" | "INTERRUPTED" | "MISSING_TOOL";
export const GATE_LIMIT_SECONDS: Readonly<Record<GateLevel, number>> = { fastcheck: 60, fulltest: 900, slowtest: 1500 };
export const GATE_EVENT_PREFIX = "OMP_GATE_EVENT ";
type Activity = "charged" | "compile";
export interface GateActivityEvent {
	id: string;
	kind: Activity | "idle";
}
export interface GateCommand {
	label: string;
	argv: readonly string[];
	cwd?: string;
	env?: Record<string, string | undefined>;
	kind?: Activity;
	stdin?: string | Uint8Array;
	eventToken?: string;
	decodeOutput?: (bytes: Uint8Array) => string;
	onAbort?: () => Promise<void>;
	/** Only for read-only optional-environment discovery; required checks must propagate failure. */
	allowFailure?: boolean;
	/** Independent wall guard for read-only discovery only, never a compiler/check stage. */
	wallTimeoutSeconds?: number;
}
export interface GateResult {
	level: GateLevel;
	status: GateStatus;
	exitCode: number;
	totalSeconds: number;
	compileExcludedSeconds: number;
	budgetedSeconds: number;
	limitSeconds: number;
}
export interface GateOptions {
	limitSeconds?: number;
	signal?: AbortSignal;
	print?: (line: string) => void;
	cleanupReserveMs?: number;
}
export interface GateCapture {
	exitCode: number;
	stdout: string;
	stderr: string;
}
export class GateCommandError extends Error {
	constructor(
		message: string,
		readonly exitCode: number,
		readonly status: GateStatus = "FAIL",
	) {
		super(message);
	}
}
interface Scope {
	level: GateLevel;
	parent?: Scope;
	started: number;
	last: number;
	charged: number;
	compile: number;
	limit: number;
	reserve: number;
	compileOnly: boolean;
	timelineAt: number;
	active: Map<object, { kind: Activity; compilerEvents?: boolean }>;
	raw: Map<object, Map<string, Activity>>;
	events: Array<{ at: number; key: object; kind?: Activity; source?: string; compilerEvents?: boolean }>;
	controller: AbortController;
	failure?: GateCommandError;
	closed: boolean;
}
interface Owned {
	child: Bun.Subprocess;
	detached: boolean;
	scope: Scope;
	owner?: GateProcessOwner;
	ownership?: Promise<GateProcessOwner>;
	onAbort?: () => Promise<void>;
	relay?: GateEventRelay;
	cleanup?: Promise<void>;
}
type Work = (gate: GateRun) => Promise<unknown>;
function ancestors(scope: Scope): Scope[] {
	const scopes: Scope[] = [];
	for (let current: Scope | undefined = scope; current; current = current.parent) scopes.push(current);
	return scopes;
}
function accrue(scope: Scope, now = performance.now()): void {
	if (scope.closed) return;
	const elapsed = now - scope.last;
	if (scope.compileOnly) scope.compile += elapsed;
	else scope.charged += elapsed;
	scope.last = now;
}
/** Reconcile observed boundaries once; replay history only for out-of-order delivery. */
function reconcile(scope: Scope, now = performance.now()): void {
	if (scope.closed) return;
	const latest = scope.events.at(-1);
	if (!latest) {
		accrue(scope, now);
		return;
	}
	let first = scope.events.length - 1;
	if (Math.max(scope.started, latest.at) < scope.timelineAt) {
		scope.events.sort((left, right) => left.at - right.at);
		scope.active.clear();
		scope.raw.clear();
		scope.compileOnly = false;
		scope.compile = 0;
		scope.charged = 0;
		scope.last = scope.started;
		first = 0;
	}
	for (let index = first; index < scope.events.length; index++) {
		const event = scope.events[index];
		const at = Math.max(scope.started, Math.min(now, event.at));
		// Undo only the most recent interval when a boundary arrives behind the
		// polling clock, then classify its remainder using the observed phase.
		accrue(scope, at);
		if (event.source) {
			let activities = scope.raw.get(event.key);
			if (!activities) {
				activities = new Map();
				scope.raw.set(event.key, activities);
			}
			if (event.kind) activities.set(event.source, event.kind);
			else activities.delete(event.source);
		} else if (event.kind) {
			scope.active.set(event.key, { kind: event.kind, compilerEvents: event.compilerEvents });
		} else {
			scope.active.delete(event.key);
			scope.raw.delete(event.key);
		}
		scope.compileOnly = scope.active.size > 0;
		for (const [key, value] of scope.active) {
			if (value.kind === "compile") continue;
			const activities = scope.raw.get(key);
			if (!value.compilerEvents || !activities?.size) {
				scope.compileOnly = false;
				break;
			}
			for (const kind of activities.values())
				if (kind !== "compile") {
					scope.compileOnly = false;
					break;
				}
			if (!scope.compileOnly) break;
		}
		scope.timelineAt = at;
	}
	accrue(scope, now);
}
function emitEvent(token: string | undefined, id: string, kind: Activity | "idle"): void {
	if (!token) return;
	const line = `${GATE_EVENT_PREFIX}${token} ${JSON.stringify({ id, kind, at: gateClockNanoseconds().toString(), clock: process.env.OMP_GATE_CLOCK_TOKEN })}\n`;
	if (process.env.OMP_GATE_EVENT_FILE) appendFileSync(process.env.OMP_GATE_EVENT_FILE, line);
	else process.stderr.write(line);
}
/** Mark only a real compiler-only boundary; preparation, downloads, checks and installation stay charged. */
export async function withCompilerActivity<T>(work: () => Promise<T>): Promise<T> {
	const token = process.env.OMP_GATE_EVENT_TOKEN;
	const id = randomUUID();
	emitEvent(token, id, "compile");
	try {
		return await work();
	} finally {
		emitEvent(token, id, "idle");
	}
}
/** Mark actual doctest/test process execution when it overlaps a compiler. */
export async function withChargedActivity<T>(work: () => Promise<T>): Promise<T> {
	const id = randomUUID();
	emitEvent(process.env.OMP_GATE_EVENT_TOKEN, id, "charged");
	try {
		return await work();
	} finally {
		emitEvent(process.env.OMP_GATE_EVENT_TOKEN, id, "idle");
	}
}

let reportedRustAccountingLimitation = false;

/** Chain an existing Rust cache wrapper without changing cargo flags or cache directories. */
export async function withRustCompilerEvents<T>(
	env: Record<string, string>,
	work: (env: Record<string, string>) => Promise<T>,
): Promise<T> {
	if (!env.OMP_GATE_EVENT_TOKEN) return work(env);
	if (!reportedRustAccountingLimitation) {
		console.warn(
			"UNVERIFIED_COMPILATION_ACCOUNTING: observed rustc intervals do not expose concurrent Cargo build-script/native phases",
		);
		reportedRustAccountingLimitation = true;
	}
	const extension = process.platform === "win32" ? ".cmd" : ".sh";
	let launchDirectory = import.meta.dir;
	if (process.platform !== "win32") {
		// Stable launchers outside the source snapshot avoid chmod-ing tracked
		// scripts after a Windows checkout. Their paths never vary per run.
		launchDirectory = path.join(
			os.tmpdir(),
			"omp-gate-wrappers",
			createHash("sha256")
				.update(import.meta.dir)
				.digest("hex")
				.slice(0, 24),
		);
		await fs.mkdir(launchDirectory, { recursive: true });
		await Promise.all(
			["test-gate-rustc", "test-gate-rustdoc", "test-gate-doctest-compile", "test-gate-doctest-run"].map(
				async name => {
					const destination = path.join(launchDirectory, `${name}${extension}`);
					const content = await fs.readFile(path.join(import.meta.dir, `${name}${extension}`));
					let current: Buffer | undefined;
					try {
						current = await fs.readFile(destination);
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
					}
					if (!current?.equals(content)) {
						const temporary = `${destination}.${randomUUID()}.tmp`;
						try {
							await fs.writeFile(temporary, content, { mode: 0o755 });
							await fs.rename(temporary, destination);
						} finally {
							await fs.rm(temporary, { force: true });
						}
					}
					await fs.chmod(destination, 0o755);
				},
			),
		);
	}
	const wrapper = path.join(launchDirectory, `test-gate-rustc${extension}`);
	const rustdoc = path.join(launchDirectory, `test-gate-rustdoc${extension}`);
	return work({
		...env,
		RUSTUP_AUTO_INSTALL: "0",
		OMP_GATE_ORIGINAL_RUSTC_WRAPPER:
			env.RUSTC_WRAPPER === wrapper ? (env.OMP_GATE_ORIGINAL_RUSTC_WRAPPER ?? "") : (env.RUSTC_WRAPPER ?? ""),
		OMP_GATE_ORIGINAL_RUSTDOC:
			env.RUSTDOC === rustdoc ? env.OMP_GATE_ORIGINAL_RUSTDOC || "rustdoc" : env.RUSTDOC || "rustdoc",
		OMP_GATE_BUN_BINARY: process.execPath,
		OMP_GATE_COMPILER_SCRIPT: path.join(import.meta.dir, "test-gate-compiler.ts"),
		OMP_GATE_RUSTDOC_SCRIPT: path.join(import.meta.dir, "test-gate-rustdoc.ts"),
		OMP_GATE_DOCTEST_COMPILER: path.join(launchDirectory, `test-gate-doctest-compile${extension}`),
		OMP_GATE_DOCTEST_RUNNER: path.join(launchDirectory, `test-gate-doctest-run${extension}`),
		RUSTC_WRAPPER: wrapper,
		RUSTDOC: rustdoc,
	});
}

/** Incremental line parser; foreign/malformed events never grant a compilation exemption. */
export class GateEventParser {
	private pending = "";
	private readonly events = new Map<string, Activity>();
	private readonly clockOffset: number;
	constructor(
		private readonly token: string,
		private readonly update: (kind: Activity, at?: number, raw?: GateActivityEvent) => void,
		private readonly clockToken?: string,
	) {
		// Initialize the native reader before sampling performance.now; FFI
		// initialization must not shift compiler boundaries into setup time.
		if (clockToken) {
			const at = gateClockNanoseconds();
			this.clockOffset = performance.now() - Number(at) / 1e6;
		} else this.clockOffset = 0;
	}
	push(text: string): void {
		this.pending += text;
		for (;;) {
			const end = this.pending.indexOf("\n");
			if (end < 0) break;
			const line = this.pending.slice(0, end).replace(/\r$/, "");
			this.pending = this.pending.slice(end + 1);
			const prefix = `${GATE_EVENT_PREFIX}${this.token} `;
			if (!line.startsWith(prefix)) continue;
			try {
				const event: unknown = JSON.parse(line.slice(prefix.length));
				if (!event || typeof event !== "object" || !("id" in event) || !("kind" in event)) continue;
				const { id, kind } = event;
				if (
					typeof id !== "string" ||
					id.length === 0 ||
					(kind !== "compile" && kind !== "charged" && kind !== "idle")
				)
					continue;
				if (kind === "idle") this.events.delete(id);
				else this.events.set(id, kind);
				let at: number | undefined;
				if (
					this.clockToken &&
					"clock" in event &&
					event.clock === this.clockToken &&
					"at" in event &&
					typeof event.at === "string" &&
					/^\d+$/.test(event.at)
				) {
					const parsed = Number(BigInt(event.at)) / 1e6 + this.clockOffset;
					if (Number.isFinite(parsed)) at = Math.min(performance.now(), parsed);
				}
				this.update(
					this.events.size > 0 && [...this.events.values()].every(value => value === "compile")
						? "compile"
						: "charged",
					at,
					{ id, kind },
				);
			} catch {
				/* Ordinary output, not a timing event. */
			}
		}
		// A non-newline progress line cannot accumulate unbounded parser memory.
		if (this.pending.length > 65536) this.pending = this.pending.slice(-65536);
	}
}
class Runtime {
	readonly scopes = new Set<Scope>();
	readonly owned = new Set<Owned>();
	readonly pending = new Map<Promise<unknown>, Scope>();
	private readonly outerToken = process.env.OMP_GATE_EVENT_TOKEN;
	private readonly eventId = randomUUID();
	private lastEvent?: Activity | "idle";
	create(level: GateLevel, options: GateOptions, parent?: Scope): Scope {
		const requested = options.limitSeconds ?? GATE_LIMIT_SECONDS[level];
		if (!Number.isFinite(requested) || requested <= 0)
			throw new GateCommandError("Gate limit must be positive and finite", 1);
		if (
			options.cleanupReserveMs !== undefined &&
			(!Number.isFinite(options.cleanupReserveMs) || options.cleanupReserveMs < 0)
		) {
			throw new GateCommandError("Cleanup reserve must be finite and nonnegative", 1);
		}
		const limit = Math.min(requested, GATE_LIMIT_SECONDS[level]) * 1000;
		const reserve = Math.min(options.cleanupReserveMs ?? Math.min(1000, limit * 0.2), limit * 0.25);
		const now = performance.now();
		const scope: Scope = {
			level,
			parent,
			started: now,
			last: now,
			charged: 0,
			compile: 0,
			limit,
			reserve: Math.max(0, reserve),
			compileOnly: false,
			timelineAt: now,
			active: new Map(),
			raw: new Map(),
			events: [],
			controller: new AbortController(),
			closed: false,
		};
		this.scopes.add(scope);
		return scope;
	}
	activity(
		scope: Scope,
		key: object,
		kind?: Activity,
		options: { at?: number; raw?: GateActivityEvent; compilerEvents?: boolean } = {},
	): void {
		if (scope.closed) return;
		const at = options.at ?? performance.now();
		for (const current of ancestors(scope)) {
			current.events.push({
				at,
				key,
				kind: options.raw ? (options.raw.kind === "idle" ? undefined : options.raw.kind) : kind,
				source: options.raw?.id,
				compilerEvents: options.compilerEvents,
			});
			reconcile(current);
			if (!current.failure && !current.closed && current.charged >= current.limit - current.reserve) {
				this.cancel(current, new GateCommandError(`${current.level} charged budget exhausted`, 124, "TIMEOUT"));
			}
		}
		const root = [...this.scopes].find(current => !current.parent && !current.closed);
		const event = root ? (!root.failure && root.compileOnly ? "compile" : "charged") : "idle";
		if (event !== this.lastEvent) {
			emitEvent(this.outerToken, this.eventId, event);
			this.lastEvent = event;
		}
	}
	cancel(scope: Scope, error: GateCommandError): void {
		scope = ancestors(scope).at(-1) ?? scope;
		if (scope.closed) return;
		for (const current of this.scopes) {
			if (!ancestors(current).includes(scope) || current.closed || current.failure) continue;
			accrue(current);
			current.events.push({ at: current.last, key: current.controller, kind: "charged" });
			reconcile(current);
			current.compileOnly = false;
			current.failure = error;
			current.controller.abort(error);
		}
		if (this.lastEvent !== "charged") {
			emitEvent(this.outerToken, this.eventId, "charged");
			this.lastEvent = "charged";
		}
		for (const owned of this.owned)
			if (ancestors(owned.scope).includes(scope)) void this.cleanup(owned).catch(() => {});
	}
	cleanup(owned: Owned, aborted = true): Promise<void> {
		owned.cleanup ??= (async () => {
			const owner = owned.owner ?? (await owned.ownership?.catch(() => undefined));
			const results = await Promise.allSettled([
				aborted ? Promise.resolve().then(() => owned.onAbort?.()) : Promise.resolve(),
				(async () => {
					try {
						if (owner) await owner.terminate();
						else await terminateOwnedSubprocess(owned.child, { detached: owned.detached });
					} finally {
						owner?.close();
					}
				})(),
			]);
			const failure = results.find(result => result.status === "rejected");
			if (failure?.status === "rejected") throw failure.reason;
		})();
		return owned.cleanup;
	}
	async execute(scope: Scope, work: Work, options: GateOptions): Promise<GateResult> {
		const print = options.print ?? console.log;
		const interrupt = () => this.cancel(scope, new GateCommandError("Gate interrupted", 130, "INTERRUPTED"));
		const external = () =>
			this.cancel(
				scope,
				options.signal?.reason instanceof GateCommandError
					? options.signal.reason
					: new GateCommandError("Gate interrupted", 130, "INTERRUPTED"),
			);
		if (!scope.parent) {
			process.on("SIGINT", interrupt);
			process.on("SIGTERM", interrupt);
		}
		options.signal?.addEventListener("abort", external, { once: true });
		if (options.signal?.aborted) external();
		let checkingBudget = false;
		const timer = setInterval(
			() => {
				if (checkingBudget || scope.closed || scope.failure) return;
				checkingBudget = true;
				void (async () => {
					// Drain already-written compiler boundaries before deciding whether
					// a delayed filesystem notification exhausted the charged budget.
					await Promise.all(
						[...this.owned]
							.filter(owned => ancestors(owned.scope).includes(scope))
							.map(owned => owned.relay?.flush()),
					);
					if (scope.closed || scope.failure) return;
					accrue(scope);
					if (scope.charged >= scope.limit - scope.reserve)
						this.cancel(scope, new GateCommandError(`${scope.level} charged budget exhausted`, 124, "TIMEOUT"));
				})()
					.catch(error => {
						if (!scope.closed && !scope.failure)
							this.cancel(scope, new GateCommandError(`Compiler event relay failed: ${String(error)}`, 1));
					})
					.finally(() => {
						checkingBudget = false;
					});
			},
			Math.max(1, Math.min(20, scope.limit / 100)),
		);
		const gate = new GateRun(this, scope);
		const aborted = Promise.withResolvers<void>();
		if (scope.controller.signal.aborted) aborted.resolve();
		else scope.controller.signal.addEventListener("abort", () => aborted.resolve(), { once: true });
		const task = scope.failure
			? Promise.resolve()
			: Promise.resolve()
					.then(() => work(gate))
					.catch(error => {
						this.cancel(
							scope,
							error instanceof GateCommandError
								? error
								: new GateCommandError(error instanceof Error ? error.message : String(error), 1),
						);
					});
		try {
			await Promise.race([task, aborted.promise]);
		} finally {
			// Never report completion while an owned subprocess or stream pump is still running.
			try {
				const cleanup = await Promise.allSettled(
					[...this.owned]
						.filter(owned => ancestors(owned.scope).includes(scope))
						.map(owned => this.cleanup(owned)),
				);
				await Promise.allSettled(
					[...this.pending].filter(([, owner]) => ancestors(owner).includes(scope)).map(([promise]) => promise),
				);
				// Owned commands/streams above must finish; an untracked blocked
				// work promise cannot prevent an already-cancelled gate summary.
				if (!scope.failure) await task;
				const failedCleanup = cleanup.find(result => result.status === "rejected");
				if (failedCleanup?.status === "rejected") throw failedCleanup.reason;
			} catch (error) {
				const diagnostic = `Process cleanup failed: ${String(error)}`;
				if (scope.failure) print(`${scope.level}: CLEANUP_FAIL ${diagnostic}`);
				else scope.failure = new GateCommandError(diagnostic, 1);
			}
			accrue(scope);
			// Event arrival already reconciled the same compiler union used by
			// the live budget timer; final output never swaps accounting clocks.
			if (!scope.failure && scope.charged >= scope.limit)
				scope.failure = new GateCommandError("Charged budget exhausted", 124, "TIMEOUT");
			scope.closed = true;
			clearInterval(timer);
			options.signal?.removeEventListener("abort", external);
			if (!scope.parent) {
				process.removeListener("SIGINT", interrupt);
				process.removeListener("SIGTERM", interrupt);
				emitEvent(this.outerToken, this.eventId, "idle");
			}
		}
		const result: GateResult = {
			level: scope.level,
			status: scope.failure?.status ?? "PASS",
			exitCode: scope.failure?.exitCode ?? 0,
			totalSeconds: (scope.last - scope.started) / 1000,
			compileExcludedSeconds: scope.compile / 1000,
			budgetedSeconds: scope.charged / 1000,
			limitSeconds: scope.limit / 1000,
		};
		if (scope.failure) print(`${scope.level}: ${scope.failure.message}`);
		print(
			`${scope.level}: ${result.status} total=${result.totalSeconds.toFixed(1)}s compile_excluded=${result.compileExcludedSeconds.toFixed(1)}s budgeted=${result.budgetedSeconds.toFixed(1)}s limit=${result.limitSeconds.toFixed(1)}s exit=${result.exitCode}`,
		);
		return result;
	}
}
export class GateRun {
	constructor(
		private readonly runtime: Runtime,
		private readonly scope: Scope,
	) {}
	get signal(): AbortSignal {
		return this.scope.controller.signal;
	}
	async run(command: GateCommand): Promise<number> {
		const pending = this.spawn(command, false);
		this.runtime.pending.set(pending, this.scope);
		try {
			return (await pending).exitCode;
		} finally {
			this.runtime.pending.delete(pending);
		}
	}
	async capture(command: GateCommand): Promise<GateCapture> {
		const pending = this.spawn(command, true);
		this.runtime.pending.set(pending, this.scope);
		try {
			return await pending;
		} finally {
			this.runtime.pending.delete(pending);
		}
	}
	/** Account filesystem/discovery/cleanup work when it overlaps another compiler stage. */
	async charged<T>(work: () => Promise<T>): Promise<T> {
		const key = {};
		this.runtime.activity(this.scope, key, "charged");
		const pending = Promise.resolve().then(work);
		this.runtime.pending.set(pending, this.scope);
		try {
			return await pending;
		} catch (error) {
			const failure =
				error instanceof GateCommandError
					? error
					: new GateCommandError(error instanceof Error ? error.message : String(error), 1);
			this.runtime.cancel(this.scope, failure);
			throw failure;
		} finally {
			this.runtime.pending.delete(pending);
			this.runtime.activity(this.scope, key);
		}
	}
	async childGate(level: GateLevel, work: Work, options: GateOptions = {}): Promise<GateResult> {
		this.throwIfAborted();
		const result = await this.runtime.execute(this.runtime.create(level, options, this.scope), work, options);
		if (result.exitCode !== 0) {
			const failure = new GateCommandError(`${level} failed`, result.exitCode, result.status);
			this.runtime.cancel(this.scope, failure);
			throw failure;
		}
		return result;
	}
	private throwIfAborted(): void {
		if (this.signal.aborted) throw this.signal.reason;
	}
	private async spawn(command: GateCommand, capture: boolean): Promise<GateCapture> {
		this.throwIfAborted();
		if (
			command.wallTimeoutSeconds !== undefined &&
			(!command.allowFailure ||
				command.kind === "compile" ||
				!Number.isFinite(command.wallTimeoutSeconds) ||
				command.wallTimeoutSeconds <= 0)
		) {
			throw new GateCommandError(
				"Independent wall guards require a positive finite timeout on read-only discovery",
				1,
			);
		}
		const started = performance.now();
		const token = command.eventToken ?? randomUUID();
		const key = {};
		const kind = command.kind ?? "charged";
		this.runtime.activity(this.scope, key, "charged");
		let owned: Owned | undefined;
		let completed = false;
		let wallTimer: Timer | undefined;
		let wallExpired = false;
		let relay: GateEventRelay | undefined;
		const event = (activity: Activity, at?: number, raw?: GateActivityEvent) =>
			this.runtime.activity(this.scope, key, kind === "compile" ? kind : activity, { at, raw });
		const fileParser = new GateEventParser(token, event, token);
		try {
			relay = await createGateEventRelay(text => fileParser.push(text));
			const detached = process.platform !== "win32";
			let child: Bun.Subprocess;
			const ready = Promise.withResolvers<void>();
			const outcome = Promise.withResolvers<{ exitCode: number; error?: string; missing?: boolean }>();
			try {
				child = Bun.spawn([process.execPath, path.join(import.meta.dir, "test-gate-supervisor.ts")], {
					cwd: command.cwd,
					env: {
						...process.env,
						...command.env,
						OMP_GATE_EVENT_TOKEN: token,
						OMP_GATE_CLOCK_TOKEN: token,
						OMP_GATE_EVENT_FILE: relay.path,
						OMP_GATE_SUPERVISED_COMMAND: JSON.stringify(command.argv),
					},
					stdin: command.stdin === undefined ? "inherit" : new Blob([command.stdin]),
					stdout: "pipe",
					stderr: "pipe",
					detached,
					windowsHide: true,
					ipc(message: unknown) {
						if (!message || typeof message !== "object") return;
						if ("ready" in message && message.ready === true) ready.resolve();
						if ("exitCode" in message && typeof message.exitCode === "number") {
							outcome.resolve({
								exitCode: message.exitCode,
								error: "error" in message && typeof message.error === "string" ? message.error : undefined,
								missing: "missing" in message && message.missing === true,
							});
						}
					},
				});
				void child.exited.then(exitCode => {
					ready.resolve();
					outcome.resolve({ exitCode: exitCode || 1 });
				});
			} catch (error) {
				const missing =
					(error as NodeJS.ErrnoException).code === "ENOENT" || /not found|ENOENT/i.test(String(error));
				throw new GateCommandError(
					`${command.label}: ${String(error)}`,
					missing ? 127 : 1,
					missing ? "MISSING_TOOL" : "FAIL",
				);
			}
			owned = { child, detached, scope: this.scope, onAbort: command.onAbort, relay };
			this.runtime.owned.add(owned);
			owned.ownership = ownGateProcess(child, detached);
			owned.owner = await owned.ownership;
			if (command.wallTimeoutSeconds !== undefined) {
				wallTimer = setTimeout(
					() => {
						wallExpired = true;
						ready.resolve();
						outcome.resolve({ exitCode: 124, error: "Read-only discovery wall guard exhausted" });
						if (owned) void this.runtime.cleanup(owned).catch(() => {});
					},
					Math.max(1, command.wallTimeoutSeconds * 1000 - (performance.now() - started)),
				);
			}
			const pump = async (stream: ReadableStream<Uint8Array>, target: NodeJS.WriteStream): Promise<string> => {
				const decoder = new TextDecoder();
				const parser = new GateEventParser(token, event, token);
				let text = "";
				for await (const bytes of stream) {
					const chunk = command.decodeOutput
						? command.decodeOutput(bytes)
						: decoder.decode(bytes, { stream: true });
					parser.push(chunk);
					if (!capture) target.write(chunk);
					if (capture) text += chunk;
				}
				const final = command.decodeOutput ? "" : decoder.decode();
				if (final) {
					parser.push(final);
					if (!capture) target.write(final);
					if (capture) text += final;
				}
				return text;
			};
			const streams = Promise.all([
				pump(child.stdout as ReadableStream<Uint8Array>, process.stdout),
				pump(child.stderr as ReadableStream<Uint8Array>, process.stderr),
			]);
			this.runtime.pending.set(streams, this.scope);
			let stdout: string;
			let stderr: string;
			let result: { exitCode: number; error?: string; missing?: boolean };
			try {
				await ready.promise;
				this.throwIfAborted();
				if (!wallExpired) {
					if (child.exitCode !== null)
						throw new GateCommandError(`${command.label}: supervisor exited before launch`, child.exitCode || 1);
					this.runtime.activity(this.scope, key, kind, { compilerEvents: true });
					this.throwIfAborted();
					child.send("start");
				}
				result = await outcome.promise;
				clearTimeout(wallTimer);
				wallTimer = undefined;
				this.runtime.activity(this.scope, key, "charged");
				await relay.flush();
				await this.runtime.cleanup(owned, false);
				[stdout, stderr] = await streams;
			} finally {
				this.runtime.pending.delete(streams);
			}
			completed = true;
			this.throwIfAborted();
			if (result.exitCode !== 0 && (!command.allowFailure || result.missing))
				throw new GateCommandError(
					`${command.label}: ${result.error ?? `exited ${result.exitCode}`}`,
					result.exitCode,
					result.missing ? "MISSING_TOOL" : "FAIL",
				);
			return { exitCode: result.exitCode, stdout, stderr };
		} catch (error) {
			const failure =
				error instanceof GateCommandError ? error : new GateCommandError(`${command.label}: ${String(error)}`, 1);
			this.runtime.cancel(this.scope, failure);
			throw failure;
		} finally {
			clearTimeout(wallTimer);
			try {
				if (owned) {
					try {
						if (!completed) await this.runtime.cleanup(owned);
					} finally {
						this.runtime.owned.delete(owned);
					}
				}
			} finally {
				try {
					if (relay) await relay.close();
				} finally {
					this.runtime.activity(this.scope, key);
				}
			}
		}
	}
}
export async function runGate(level: GateLevel, work: Work, options: GateOptions = {}): Promise<GateResult> {
	const started = performance.now();
	const runtime = new Runtime();
	try {
		return await runtime.execute(runtime.create(level, options), work, options);
	} catch (error) {
		const elapsed = (performance.now() - started) / 1000;
		const result: GateResult = {
			level,
			status: error instanceof GateCommandError ? error.status : "FAIL",
			exitCode: error instanceof GateCommandError ? error.exitCode : 1,
			totalSeconds: elapsed,
			compileExcludedSeconds: 0,
			budgetedSeconds: elapsed,
			limitSeconds: GATE_LIMIT_SECONDS[level],
		};
		(options.print ?? console.log)(
			`${level}: ${result.status} total=${elapsed.toFixed(1)}s compile_excluded=0.0s budgeted=${elapsed.toFixed(1)}s limit=${result.limitSeconds.toFixed(1)}s exit=${result.exitCode} ${String(error)}`,
		);
		return result;
	}
}
