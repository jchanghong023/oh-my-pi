import { dlopen, FFIType, ptr } from "bun:ffi";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { appendFileSync } from "node:fs";
import * as path from "node:path";
import { setImmediate } from "node:timers/promises";
import * as logger from "@oh-my-pi/pi-utils/logger";
import { terminateOwnedSubprocess } from "../packages/utils/src/subprocess";
import type { GateProcessOwner } from "./test-gate-process";
import { ownGateProcess } from "./test-gate-process";
import type { GateEventRelay } from "./test-gate-events";
import { createGateEventRelay, emitEvent, GATE_EVENT_PREFIX, withCompilerActivity } from "./test-gate-events";
import { gateClockNanoseconds } from "./test-gate-clock";

export type GateLevel = "fastcheck" | "fulltest" | "slowtest";
export type GateStatus = "PASS" | "FAIL" | "TIMEOUT" | "INTERRUPTED" | "MISSING_TOOL";
export const GATE_LIMIT_SECONDS: Readonly<Record<GateLevel, number>> = { fastcheck: 90, fulltest: 900, slowtest: 1500 };
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
	/** Echo captured output as it arrives; capture remains silent by default. */
	streamOutput?: boolean;
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
	/** Real gate entrypoints relay failures to a supervising gate; expected-failure selftests leave this off. */
	reportFailure?: boolean;
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
function gateFailure(error: unknown): GateCommandError {
	return error instanceof GateCommandError
		? error
		: new GateCommandError(error instanceof Error ? error.message : String(error), 1);
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
	finalizers: Array<(exitCode: number) => Promise<void>>;
	closed: boolean;
	reportFailure: boolean;
	runId: string;
	operationId: string;
	gateId: string;
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
	callId: string;
	stage: string;
}
type Work = (gate: GateRun) => Promise<unknown>;

function diagnosticId(value: unknown): string | undefined {
	return typeof value === "string" && /^[A-Za-z0-9-]{1,80}$/.test(value) ? value : undefined;
}

function diagnosticStage(label: string): string {
	return /^(?:static|build|test|version|scope|wsl)\/[A-Za-z0-9@ /_.+-]{1,90}$/.test(label)
		? label
		: `stage-${createHash("sha256").update(label).digest("hex").slice(0, 12)}`;
}

function logGateResult(result: GateResult, fields: Record<string, unknown> = {}): void {
	const log = result.status === "PASS" || result.status === "INTERRUPTED" ? logger.info : logger.error;
	log("Gate settled", {
		component: "test-gate",
		event: "gate_settled",
		stage: result.level,
		result: result.status,
		gate_level: result.level,
		status: result.status,
		exit_code: result.exitCode,
		elapsed_ms: result.totalSeconds * 1000,
		compile_excluded_ms: result.compileExcludedSeconds * 1000,
		budgeted_ms: result.budgetedSeconds * 1000,
		limit_ms: result.limitSeconds * 1000,
		platform: process.platform,
		arch: process.arch,
		scope: "fork-affected",
		...fields,
	});
}
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
/** Relay the first concrete nested check/compiler failure before waiting for its other work. */
export function reportGateFailure(error: unknown): void {
	const token = process.env.OMP_GATE_EVENT_TOKEN;
	if (!token) return;
	const failure = gateFailure(error);
	const line = `${GATE_EVENT_PREFIX}${token} ${JSON.stringify({
		id: randomUUID(),
		kind: "failure",
		exitCode: failure.exitCode,
		status: failure.status,
		message: failure.message,
	})}\n`;
	if (process.env.OMP_GATE_EVENT_FILE) appendFileSync(process.env.OMP_GATE_EVENT_FILE, line);
	else process.stderr.write(line);
}

let reportedRustAccountingLimitation = false;
let windowsRustLaunchers: Promise<string> | undefined;
// Repository-local identity cannot vary with a child test's HOME/TEMP/TMPDIR.
const rustLauncherDirectory = path.resolve(
	import.meta.dir,
	"..",
	"node_modules",
	".cache",
	"omp-gate-wrappers",
	`${process.platform}-${process.arch}`,
);

/** Bootstrap-safe version of pi-natives' Windows file-lock object-lifetime lease. */
async function acquireWindowsRustLauncherLease(directory: string): Promise<() => void> {
	// Resolve junctions and case before naming the lease for this actual cache.
	const identity = (await fs.realpath(directory)).toLowerCase();
	const name = `Global\\omp-gate-launchers-${createHash("sha256").update(identity).digest("hex")}`;
	const wideName = Buffer.from(`${name}\0`, "utf16le");
	const kernel = dlopen("kernel32.dll", {
		CreateMutexExW: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.u32], returns: FFIType.u64 },
		SetLastError: { args: [FFIType.u32], returns: FFIType.void },
		GetLastError: { args: [], returns: FFIType.u32 },
		CloseHandle: { args: [FFIType.u64], returns: FFIType.i32 },
	});
	try {
		for (;;) {
			kernel.symbols.SetLastError(0);
			// SYNCHRONIZE only; ownership is the object's existence, not a thread-affine mutex wait.
			const handle = kernel.symbols.CreateMutexExW(null, ptr(wideName), 0, 0x00100000);
			const error = kernel.symbols.GetLastError();
			if (!handle) throw new Error(`Cannot acquire Rust gate launcher lease (Windows error ${error})`);
			if (error !== 183) {
				return () => {
					try {
						if (!kernel.symbols.CloseHandle(handle))
							throw new Error(`Cannot release Rust gate launcher lease (Windows error ${kernel.symbols.GetLastError()})`);
					} finally {
						kernel.close();
					}
				};
			}
			if (!kernel.symbols.CloseHandle(handle))
				throw new Error(`Cannot close Rust gate launcher contender (Windows error ${kernel.symbols.GetLastError()})`);
			await Bun.sleep(50);
		}
	} catch (error) {
		kernel.close();
		throw error;
	}
}

/** Compile once with the installed host rustc, without Cargo or its cache/profile flags. */
function prepareWindowsRustLaunchers(env: Record<string, string>): Promise<string> {
	windowsRustLaunchers ??= (async () => {
		const source = path.join(import.meta.dir, "test-gate-compiler-launcher.rs");
		const content = await fs.readFile(source);
		const compiler = env.RUSTC || "rustc";
		const compilerEnv = { ...process.env, ...env, RUSTUP_AUTO_INSTALL: "0" };
		const versionProcess = Bun.spawn([compiler, "--version"], {
			env: compilerEnv,
			stdout: "pipe",
			stderr: "inherit",
			windowsHide: true,
		});
		const [versionExit, version] = await Promise.all([
			versionProcess.exited,
			new Response(versionProcess.stdout).text(),
		]);
		if (versionExit !== 0)
			throw new GateCommandError("Native Rust gate launcher compiler discovery failed", versionExit);
		const signature = createHash("sha256").update(content).update(version).digest("hex");
		// Compiler/source updates must not change Cargo's wrapper cache identity.
		const directory = rustLauncherDirectory;
		await fs.mkdir(directory, { recursive: true });
		const release = await acquireWindowsRustLauncherLease(directory);
		try {
			const image = path.join(directory, "test-gate-launcher.exe");
			const stamp = path.join(directory, "launcher.sha256");
			let current: string | undefined;
			try {
				current = await fs.readFile(stamp, "utf8");
				await fs.access(image);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				current = undefined;
			}
			// Recheck under the cross-process lease, then hold it through the final stamp.
			// A stamp reread before rename alone still permits two publishers to race.
			const rebuild = current !== signature;
			if (rebuild) {
				const temporary = path.join(directory, `launcher-${randomUUID()}.exe`);
				try {
					const exitCode = await withCompilerActivity(async () => {
						const child = Bun.spawn(
							[
								compiler,
								"--edition=2021",
								"--crate-name",
								"omp_gate_launcher",
								"-C",
								"debuginfo=0",
								"-C",
								"opt-level=s",
								"-o",
								temporary,
								source,
							],
							{ env: compilerEnv, stdin: "inherit", stdout: "inherit", stderr: "inherit", windowsHide: true },
						);
						return await child.exited;
					});
					if (exitCode !== 0) throw new GateCommandError("Native Rust gate launcher compilation failed", exitCode);
					// Real replacement failures (including an older in-use image) still fail.
					await fs.rename(temporary, image);
				} finally {
					await fs.rm(temporary, { force: true });
				}
			}
			await Promise.all(
				["test-gate-rustc", "test-gate-rustdoc", "test-gate-doctest-compile", "test-gate-doctest-run"].map(
					async name => {
						const destination = path.join(directory, `${name}.exe`);
						if (!rebuild) {
							try {
								await fs.link(image, destination);
							} catch (error) {
								if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
							}
							return;
						}
						const temporary = `${destination}.${randomUUID()}.tmp`;
						try {
							await fs.link(image, temporary);
							await fs.rename(temporary, destination);
						} finally {
							await fs.rm(temporary, { force: true });
						}
					},
				),
			);
			if (rebuild) {
				const temporary = `${stamp}.${randomUUID()}.tmp`;
				try {
					await fs.writeFile(temporary, signature);
					await fs.rename(temporary, stamp);
				} finally {
					await fs.rm(temporary, { force: true });
				}
			}
			return directory;
		} finally {
			release();
		}
	})().catch(error => {
		windowsRustLaunchers = undefined;
		throw error;
	});
	return windowsRustLaunchers;
}

/**
 * Preserve Rust cache wrappers and compiler events, but keep mixed Cargo work
 * charged: rustc boundaries cannot prove that unwrapped build scripts, native
 * tools or test executables are idle. Process ownership is not lifecycle tracing.
 */
export async function withRustCompilerEvents<T>(
	env: Record<string, string>,
	work: (env: Record<string, string>) => Promise<T>,
): Promise<T> {
	if (!env.OMP_GATE_EVENT_TOKEN) return work(env);
	if (!reportedRustAccountingLimitation) {
		console.warn(
			"UNVERIFIED_COMPILATION_ACCOUNTING: Cargo build-script/native/test process lifecycles are not observable; mixed Cargo work remains charged",
		);
		reportedRustAccountingLimitation = true;
	}
	const extension = process.platform === "win32" ? ".exe" : ".sh";
	let launchDirectory = import.meta.dir;
	if (process.platform === "win32") {
		// .cmd entries truncate Cargo's long argv at cmd.exe's 8191-character limit.
		launchDirectory = await prepareWindowsRustLaunchers(env);
	} else {
		// Repository-local launchers avoid chmod-ing tracked scripts after a
		// Windows checkout and keep one cache identity across isolated temp dirs.
		launchDirectory = rustLauncherDirectory;
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
	const id = randomUUID();
	emitEvent(env.OMP_GATE_EVENT_TOKEN, id, "charged", env);
	try {
		return await work({
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
	} finally {
		emitEvent(env.OMP_GATE_EVENT_TOKEN, id, "idle", env);
	}
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
		private readonly failed?: (error: GateCommandError) => void,
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
				if (kind === "failure") {
					if (
						"exitCode" in event &&
						typeof event.exitCode === "number" &&
						Number.isSafeInteger(event.exitCode) &&
						event.exitCode !== 0 &&
						"status" in event &&
						(event.status === "FAIL" ||
							event.status === "TIMEOUT" ||
							event.status === "INTERRUPTED" ||
							event.status === "MISSING_TOOL") &&
						"message" in event &&
						typeof event.message === "string"
					) {
						this.failed?.(new GateCommandError(event.message, event.exitCode, event.status));
					}
					continue;
				}
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
	readonly executions = new Map<Scope, Promise<GateResult>>();
	private readonly outerToken = process.env.OMP_GATE_EVENT_TOKEN;
	private readonly eventId = randomUUID();
	private lastEvent?: Activity | "idle";
	readonly runId = diagnosticId(process.env.OMP_GATE_DIAGNOSTIC_RUN_ID) ?? randomUUID();
	readonly operationId =
		diagnosticId(logger.getLogContext().operation_id) ??
		diagnosticId(process.env.OMP_GATE_DIAGNOSTIC_OPERATION_ID) ??
		this.runId;
	create(level: GateLevel, options: GateOptions, parent?: Scope, started = performance.now()): Scope {
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
		const now = started;
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
			finalizers: [],
			reportFailure: options.reportFailure ?? false,
			runId: this.runId,
			operationId: this.operationId,
			gateId: randomUUID(),
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
		const report = !scope.failure && scope.reportFailure;
		error = scope.failure ?? error;
		for (const current of this.scopes) {
			if (!ancestors(current).includes(scope) || current.closed || current.failure) continue;
			(error.status === "INTERRUPTED" ? logger.info : logger.error)("Gate cancellation requested", {
				component: "test-gate",
				event: "gate_cancel_requested",
				stage: current.level,
				result: error.status,
				status: error.status,
				exit_code: error.exitCode,
				run_id: current.runId,
				operation_id: current.operationId,
				gate_id: current.gateId,
				elapsed_ms: performance.now() - current.started,
				budgeted_ms: current.charged,
				limit_ms: current.limit,
			});
			accrue(current);
			current.events.push({ at: current.last, key: current.controller, kind: "charged" });
			reconcile(current);
			current.compileOnly = false;
			current.failure = error;
			current.controller.abort(error);
		}
		try {
			if (report) reportGateFailure(error);
			if (this.lastEvent !== "charged") {
				emitEvent(this.outerToken, this.eventId, "charged");
				this.lastEvent = "charged";
			}
		} finally {
			for (const owned of this.owned)
				if (ancestors(owned.scope).includes(scope)) void this.cleanup(owned).catch(() => {});
		}
	}
	cleanup(owned: Owned, aborted = true): Promise<void> {
		owned.cleanup ??= (async () => {
			const started = performance.now();
			const fields = {
				component: "test-gate",
				run_id: owned.scope.runId,
				operation_id: owned.scope.operationId,
				gate_id: owned.scope.gateId,
				call_id: owned.callId,
				stage: owned.stage,
				peer_pid: owned.child.pid,
				aborted,
			};
			logger.info("Owned process cleanup started", { ...fields, event: "gate_cleanup_started", result: "started" });
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
			if (failure?.status === "rejected") {
				logger.error("Owned process cleanup failed", {
					...fields,
					event: "gate_cleanup_settled",
					result: "failed",
					elapsed_ms: performance.now() - started,
					...logger.diagnosticError(failure.reason),
				});
				throw failure.reason;
			}
			logger.info("Owned process cleanup completed", {
				...fields,
				event: "gate_cleanup_settled",
				result: "completed",
				elapsed_ms: performance.now() - started,
			});
		})();
		return owned.cleanup;
	}
	execute(scope: Scope, work: Work, options: GateOptions): Promise<GateResult> {
		const execution = logger
			.withLogContext(
				{
					run_id: scope.runId,
					operation_id: scope.operationId,
					gate_id: scope.gateId,
					parent_gate_id: scope.parent?.gateId,
					gate_level: scope.level,
				},
				() => this.executeScoped(scope, work, options),
			)
			.finally(() => this.executions.delete(scope));
		this.executions.set(scope, execution);
		return execution;
	}
	private async executeScoped(scope: Scope, work: Work, options: GateOptions): Promise<GateResult> {
		logger.info("Gate started", {
			component: "test-gate",
			event: "gate_started",
			stage: scope.level,
			result: "started",
			platform: process.platform,
			arch: process.arch,
			limit_ms: scope.limit,
			scope: "fork-affected",
		});
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
		accrue(scope);
		if (!scope.failure && scope.charged >= scope.limit - scope.reserve)
			this.cancel(scope, new GateCommandError(`${scope.level} charged budget exhausted`, 124, "TIMEOUT"));
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
						logger.error("Compiler relay failed", {
							component: "test-gate",
							event: "gate_relay_failed",
							stage: "compiler-events",
							result: "failed",
							...logger.diagnosticError(error),
						});
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
					.then(() => {
						if (!scope.controller.signal.aborted) return work(gate);
					})
					.catch(error => {
						if (!(error instanceof GateCommandError))
							logger.error("Gate work failed", {
								component: "test-gate",
								event: "gate_work_failed",
								stage: scope.level,
								result: "failed",
								...logger.diagnosticError(error),
							});
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
				let failedCleanup: PromiseRejectedResult | undefined;
				for (;;) {
					// A tracked promise can disappear before its caller's finally
					// registers cleanup. Cross an event-loop turn to drain the whole
					// Promise-job queue, not an arbitrary number of microtasks.
					await gate.charged(() => setImmediate());
					const owned = [...this.owned].filter(owned => ancestors(owned.scope).includes(scope));
					const pending = [...this.pending]
						.filter(([, owner]) => ancestors(owner).includes(scope))
						.map(([promise]) => promise);
					const executions = [...this.executions]
						.filter(([owner]) => owner !== scope && ancestors(owner).includes(scope))
						.map(([, execution]) => execution);
					if (!owned.length && !pending.length && !executions.length) break;
					const cleanup = await Promise.allSettled([
						...owned.map(owned => this.cleanup(owned)),
						...pending,
						...executions,
					]);
					for (let index = 0; index < owned.length; index++) {
						const settled = cleanup[index];
						if (settled?.status === "rejected") failedCleanup ??= settled;
					}
				}
				// Owned commands/streams above must finish; an untracked blocked
				// work promise cannot prevent an already-cancelled gate summary.
				if (!scope.failure) await task;
				if (failedCleanup) throw failedCleanup.reason;
			} catch (error) {
				logger.error("Gate final cleanup failed", {
					component: "test-gate",
					event: "gate_final_cleanup_failed",
					stage: scope.level,
					result: "failed",
					...logger.diagnosticError(error),
				});
				const diagnostic = `Process cleanup failed: ${String(error)}`;
				if (scope.failure) print(`${scope.level}: CLEANUP_FAIL ${diagnostic}`);
				else this.cancel(scope, new GateCommandError(diagnostic, 1));
			}
			// Final metadata is part of the same charged lifetime, including cancellation.
			// If a successful write crosses the budget or receives an interrupt, publish
			// the preserved first failure before closing the scope.
			let finalizedExitCode: number;
			do {
				finalizedExitCode = scope.failure?.exitCode ?? 0;
				for (const finalizer of scope.finalizers) {
					try {
						await gate.charged(() => finalizer(finalizedExitCode));
					} catch (error) {
						print(`${scope.level}: FINALIZE_FAIL ${String(error)}`);
					}
				}
				accrue(scope);
				// Final output uses the live clock; include the last write before
				// deciding whether reports need the failed outcome published again.
				if (!scope.failure && scope.charged >= scope.limit)
					this.cancel(scope, new GateCommandError("Charged budget exhausted", 124, "TIMEOUT"));
			} while (finalizedExitCode === 0 && scope.failure);
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
		logGateResult(result);
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
	/**
	 * Register charged report cleanup that settles before the gate closes, even after cancellation.
	 * It must permit a second call with the first failure's exit code if finalization began successfully.
	 */
	onFinalize(finalizer: (exitCode: number) => Promise<void>): void {
		if (this.scope.closed) throw this.scope.failure ?? new GateCommandError("Gate already settled", 1);
		this.scope.finalizers.push(finalizer);
	}
	/** Stop every scope and owned process while preserving the first triggering failure. */
	fail(error: unknown): GateCommandError {
		const failure = gateFailure(error);
		this.runtime.cancel(this.scope, failure);
		return this.signal.reason instanceof GateCommandError ? this.signal.reason : failure;
	}
	async run(command: GateCommand): Promise<number> {
		const pending = this.spawn(command, false);
		this.runtime.pending.set(pending, this.scope);
		try {
			return (await pending).exitCode;
		} catch (error) {
			throw this.fail(error);
		} finally {
			this.runtime.pending.delete(pending);
		}
	}
	async capture(command: GateCommand): Promise<GateCapture> {
		const pending = this.spawn(command, true);
		this.runtime.pending.set(pending, this.scope);
		try {
			return await pending;
		} catch (error) {
			throw this.fail(error);
		} finally {
			this.runtime.pending.delete(pending);
		}
	}
	/** Account filesystem/discovery/cleanup work when it overlaps another compiler stage. */
	async charged<T>(work: () => Promise<T>): Promise<T> {
		if (this.scope.closed) throw this.scope.failure ?? new GateCommandError("Gate already settled", 1);
		const key = {};
		this.runtime.activity(this.scope, key, "charged");
		const pending = Promise.resolve().then(work);
		this.runtime.pending.set(pending, this.scope);
		try {
			return await pending;
		} catch (error) {
			if (!(error instanceof GateCommandError))
				logger.error("Charged gate work failed", {
					component: "test-gate",
					event: "gate_charged_work_failed",
					stage: "charged-work",
					result: "failed",
					...logger.diagnosticError(error),
				});
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
		try {
			const result = await this.runtime.execute(this.runtime.create(level, options, this.scope), work, options);
			if (result.exitCode !== 0) throw new GateCommandError(`${level} failed`, result.exitCode, result.status);
			return result;
		} catch (error) {
			throw this.fail(error);
		}
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
		const callId = randomUUID();
		const stage = diagnosticStage(command.label);
		const fields = {
			component: "test-gate",
			run_id: this.scope.runId,
			operation_id: this.scope.operationId,
			gate_id: this.scope.gateId,
			call_id: callId,
			stage,
		};
		const token = command.eventToken ?? randomUUID();
		const key = {};
		const kind = command.kind ?? "charged";
		this.runtime.activity(this.scope, key, "charged");
		logger.info("Gate stage started", {
			...fields,
			event: "gate_stage_started",
			result: "started",
			capture,
			activity: command.kind ?? "charged",
			allow_failure: command.allowFailure ?? false,
			wall_timeout_ms: command.wallTimeoutSeconds === undefined ? undefined : command.wallTimeoutSeconds * 1000,
		});
		let owned: Owned | undefined;
		let completed = false;
		let wallTimer: Timer | undefined;
		let wallExpired = false;
		let relay: GateEventRelay | undefined;
		const event = (activity: Activity, at?: number, raw?: GateActivityEvent) =>
			this.runtime.activity(this.scope, key, kind === "compile" ? kind : activity, { at, raw });
		const failed = (failure: GateCommandError) => {
			this.fail(failure);
		};
		const fileParser = new GateEventParser(token, event, token, failed);
		try {
			this.throwIfAborted();
			relay = await createGateEventRelay(text => fileParser.push(text));
			this.throwIfAborted();
			const detached = process.platform !== "win32";
			let child: Bun.Subprocess;
			const ready = Promise.withResolvers<void>();
			const outcome = Promise.withResolvers<{ exitCode: number; error?: string; missing?: boolean }>();
			let replied = false;
			logger.info("Supervisor spawn started", {
				...fields,
				event: "gate_supervisor_spawn_started",
				result: "started",
			});
			try {
				child = Bun.spawn([process.execPath, path.join(import.meta.dir, "test-gate-supervisor.ts")], {
					cwd: command.cwd,
					env: {
						...process.env,
						...command.env,
						OMP_GATE_DIAGNOSTIC_RUN_ID: this.scope.runId,
						OMP_GATE_DIAGNOSTIC_OPERATION_ID: this.scope.operationId,
						OMP_GATE_DIAGNOSTIC_CALL_ID: callId,
						OMP_GATE_EVENT_TOKEN: token,
						OMP_GATE_CLOCK_TOKEN: token,
						OMP_GATE_EVENT_FILE: relay.path,
						OMP_GATE_SUPERVISED_COMMAND: JSON.stringify(command.argv),
					},
					stdin:
						command.stdin === undefined
							? "inherit"
							: typeof command.stdin === "string"
								? new Blob([command.stdin])
								: command.stdin,
					stdout: "pipe",
					stderr: "pipe",
					detached,
					windowsHide: true,
					ipc(message: unknown) {
						if (!message || typeof message !== "object") return;
						if ("ready" in message && message.ready === true) {
							logger.info("Supervisor IPC ready", {
								...fields,
								event: "gate_supervisor_ipc",
								result: "ready",
								elapsed_ms: performance.now() - started,
							});
							ready.resolve();
						}
						if ("exitCode" in message && typeof message.exitCode === "number") {
							replied = true;
							logger.info("Supervisor IPC result received", {
								...fields,
								event: "gate_supervisor_ipc",
								result: "reply",
								exit_code: message.exitCode,
								missing_tool: "missing" in message && message.missing === true,
								elapsed_ms: performance.now() - started,
							});
							outcome.resolve({
								exitCode: message.exitCode,
								error: "error" in message && typeof message.error === "string" ? message.error : undefined,
								missing: "missing" in message && message.missing === true,
							});
							if (
								message.exitCode !== 0 &&
								(!command.allowFailure || ("missing" in message && message.missing === true))
							)
								failed(
									new GateCommandError(
										`${command.label}: ${"error" in message && typeof message.error === "string" ? message.error : `exited ${message.exitCode}`}`,
										message.exitCode,
										"missing" in message && message.missing === true ? "MISSING_TOOL" : "FAIL",
									),
								);
						}
					},
				});
				void child.exited.then(exitCode => {
					logger.info("Supervisor closed", {
						...fields,
						event: "gate_supervisor_closed",
						result: "closed",
						peer_pid: child.pid,
						exit_code: exitCode,
						elapsed_ms: performance.now() - started,
					});
					ready.resolve();
					outcome.resolve({ exitCode: exitCode || 1 });
					if (!replied && !owned?.cleanup && !wallExpired)
						failed(new GateCommandError(`${command.label}: supervisor exited unexpectedly`, exitCode || 1));
				});
			} catch (error) {
				logger.error("Supervisor spawn failed", {
					...fields,
					event: "gate_supervisor_spawn_settled",
					result: "failed",
					elapsed_ms: performance.now() - started,
					...logger.diagnosticError(error),
				});
				const missing =
					(error as NodeJS.ErrnoException).code === "ENOENT" || /not found|ENOENT/i.test(String(error));
				throw new GateCommandError(
					`${command.label}: ${String(error)}`,
					missing ? 127 : 1,
					missing ? "MISSING_TOOL" : "FAIL",
				);
			}
			logger.info("Supervisor spawned", {
				...fields,
				event: "gate_supervisor_spawn_settled",
				result: "completed",
				peer_pid: child.pid,
				elapsed_ms: performance.now() - started,
			});
			owned = { child, detached, scope: this.scope, onAbort: command.onAbort, relay, callId, stage };
			this.runtime.owned.add(owned);
			owned.ownership = ownGateProcess(child, detached);
			owned.owner = await owned.ownership;
			this.throwIfAborted();
			if (command.wallTimeoutSeconds !== undefined) {
				wallTimer = setTimeout(
					() => {
						wallExpired = true;
						logger.warn("Discovery wall guard expired", {
							...fields,
							event: "gate_stage_wall_timeout",
							result: "timeout",
							peer_pid: child.pid,
							elapsed_ms: performance.now() - started,
						});
						ready.resolve();
						outcome.resolve({ exitCode: 124, error: "Read-only discovery wall guard exhausted" });
						if (owned) void this.runtime.cleanup(owned).catch(() => {});
					},
					Math.max(1, command.wallTimeoutSeconds * 1000 - (performance.now() - started)),
				);
			}
			const pump = async (stream: ReadableStream<Uint8Array>, target: NodeJS.WriteStream): Promise<string> => {
				const decoder = new TextDecoder();
				const parser = new GateEventParser(token, event, token, failed);
				let text = "";
				for await (const bytes of stream) {
					const chunk = command.decodeOutput
						? command.decodeOutput(bytes)
						: decoder.decode(bytes, { stream: true });
					parser.push(chunk);
					if (!capture || command.streamOutput) target.write(chunk);
					if (capture) text += chunk;
				}
				const final = command.decodeOutput ? "" : decoder.decode();
				if (final) {
					parser.push(final);
					if (!capture || command.streamOutput) target.write(final);
					if (capture) text += final;
				}
				return text;
			};
			const pumps = [
				pump(child.stdout as ReadableStream<Uint8Array>, process.stdout),
				pump(child.stderr as ReadableStream<Uint8Array>, process.stderr),
			];
			const streams = Promise.all(pumps);
			void streams.catch(error => this.fail(error));
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
					logger.info("Supervisor IPC start sent", {
						...fields,
						event: "gate_supervisor_ipc",
						result: "start-sent",
						peer_pid: child.pid,
						elapsed_ms: performance.now() - started,
					});
					child.send("start");
				}
				result = await outcome.promise;
				clearTimeout(wallTimer);
				wallTimer = undefined;
				this.runtime.activity(this.scope, key, "charged");
				await relay.flush();
				await this.runtime.cleanup(owned, false);
				[stdout, stderr] = await streams;
			} catch (error) {
				throw this.fail(error);
			} finally {
				await Promise.allSettled(pumps);
				this.runtime.pending.delete(streams);
			}
			completed = true;
			this.throwIfAborted();
			if (result.exitCode !== 0 && (!command.allowFailure || result.missing))
				throw this.fail(
					new GateCommandError(
						`${command.label}: ${result.error ?? `exited ${result.exitCode}`}`,
						result.exitCode,
						result.missing ? "MISSING_TOOL" : "FAIL",
					),
				);
			(result.exitCode === 0 ? logger.info : logger.warn)("Gate stage settled", {
				...fields,
				event: "gate_stage_settled",
				result: result.exitCode === 0 ? "completed" : wallExpired ? "timeout" : "failed",
				status: result.exitCode === 0 ? "PASS" : wallExpired ? "TIMEOUT" : "FAIL",
				exit_code: result.exitCode,
				missing_tool: result.missing ?? false,
				peer_pid: child.pid,
				elapsed_ms: performance.now() - started,
			});
			return { exitCode: result.exitCode, stdout, stderr };
		} catch (error) {
			const failure =
				error instanceof GateCommandError ? error : new GateCommandError(`${command.label}: ${String(error)}`, 1);
			(failure.status === "INTERRUPTED" ? logger.info : logger.error)("Gate stage settled", {
				...fields,
				event: "gate_stage_settled",
				result: failure.status === "INTERRUPTED" ? "cancelled" : "failed",
				status: failure.status,
				exit_code: failure.exitCode,
				missing_tool: failure.status === "MISSING_TOOL",
				peer_pid: owned?.child.pid,
				elapsed_ms: performance.now() - started,
				...logger.diagnosticError(error),
			});
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
				} catch (error) {
					logger.error("Gate stage relay cleanup failed", {
						...fields,
						event: "gate_relay_cleanup_failed",
						result: "failed",
						elapsed_ms: performance.now() - started,
						...logger.diagnosticError(error),
					});
					throw error;
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
	return logger.withLogContext(
		{
			run_id: runtime.runId,
			operation_id: runtime.operationId,
			parent_call_id: diagnosticId(process.env.OMP_GATE_DIAGNOSTIC_CALL_ID),
		},
		async () => {
			logger.info("Gate entry started", {
				component: "test-gate",
				event: "gate_entry_started",
				stage: level,
				result: "started",
				gate_level: level,
				platform: process.platform,
				arch: process.arch,
				scope: "fork-affected",
			});
			try {
				return await runtime.execute(runtime.create(level, options, undefined, started), work, options);
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
				logGateResult(result, { ...logger.diagnosticError(error) });
				(options.print ?? console.log)(
					`${level}: ${result.status} total=${elapsed.toFixed(1)}s compile_excluded=0.0s budgeted=${elapsed.toFixed(1)}s limit=${result.limitSeconds.toFixed(1)}s exit=${result.exitCode} ${String(error)}`,
				);
				return result;
			}
		},
	);
}
