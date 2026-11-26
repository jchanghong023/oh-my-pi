/**
 * Regression tests for the wedged shared browser (field incident 2026-09-27,
 * omp 18.3.1): under memory pressure the project-shared broker-owned Chromium
 * stopped answering CDP, so every tab close ended at the bounded
 * `orphan CDP target … (Page.close)` timeout.
 *
 * Two leaks followed that timeout:
 *
 * - `releaseTabInner` dropped the target's durable ownership record even though
 *   the target was never closed, so the surviving page became invisible to
 *   every later reap; and
 * - the shared Chromium is health-checked only while attaching
 *   (`ensureSharedBrowser`), and `acquireBrowser` reuses a cached handle while
 *   `browser.connected` is still true — so nothing re-probed an unreachable
 *   browser while a session lived. The 9.1 GB / 44-process tree survived 19 h
 *   until the last omp client in the project exited.
 *
 * Contract pinned here: a timed-out target close keeps the ownership record and
 * re-checks the shared browser, and that check stops the daemon only when the
 * CDP endpoint no longer answers.
 */

import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getDaemonRuntimeDir, withTimeout } from "@oh-my-pi/pi-utils";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { DaemonClient, DaemonOp, DaemonResult, UnitSnapshot } from "@oh-my-pi/pi-coding-agent/daemon/protocol";
import {
	forgetSharedTarget,
	recordSharedTarget,
	resetOrphanRegistryForTest,
	type SharedTargetScope,
} from "@oh-my-pi/pi-coding-agent/tools/browser/orphan-registry";
import type { BrowserHandle } from "@oh-my-pi/pi-coding-agent/tools/browser/registry";
import * as sharedDaemon from "@oh-my-pi/pi-coding-agent/tools/browser/shared-daemon";
import { stopSharedBrowserIfUnreachable } from "@oh-my-pi/pi-coding-agent/tools/browser/shared-daemon";
import type { WorkerInbound } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-protocol";
import {
	getTabsMapForTest,
	releaseTab,
	releaseTabsForOwner,
	runInTab,
} from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import type { WorkerTabSession } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import { ToolAbortError } from "@oh-my-pi/pi-coding-agent/tools/tool-errors";
import { ToolError } from "@oh-my-pi/pi-coding-agent/tools/tool-errors";
import { rejectionOf } from "../helpers/rejection";

const DAEMON_NAME = "omp.browser.headless";
/** The target id the incident log names for the tab whose close never landed. */
const TARGET_ID = "D6895F960DB1F4D842FD7B0286F3F818";

/** Unique per-test scope so registry dirs never collide across the suite. */
function makeScope(): SharedTargetScope {
	return { projectDir: path.join("/tmp", `omp-wedge-test-${crypto.randomUUID()}`), daemonName: DAEMON_NAME };
}

/** Scopes created since the last sweep; `afterEach` removes them even when a test fails. */
const scopes: SharedTargetScope[] = [];

/** A scope registered for cleanup, so no assertion failure can leave it on disk. */
function trackedScope(): SharedTargetScope {
	const scope = makeScope();
	scopes.push(scope);
	return scope;
}

/** Targets this process still claims ownership of, straight from the durable record. */
async function ownedTargets(scope: SharedTargetScope): Promise<string[]> {
	// Reading straight after `releaseTab` would race the registry's serialized
	// write chain (the supervisor forgets fire-and-forget). A record→forget pair
	// for a throwaway id joins that chain, so when it returns the earlier write
	// has landed and the file below is stable.
	const probe = `chain-probe-${crypto.randomUUID()}`;
	await recordSharedTarget(scope, probe);
	await forgetSharedTarget(scope, probe);
	const file = path.join(getDaemonRuntimeDir(scope.projectDir), `${scope.daemonName}.targets`, `${process.pid}.json`);
	const raw = await Bun.file(file)
		.text()
		.catch(() => null);
	if (raw === null) return [];
	const parsed: unknown = JSON.parse(raw);
	if (typeof parsed !== "object" || parsed === null || !("targets" in parsed)) return [];
	const { targets } = parsed;
	return Array.isArray(targets) ? targets.filter((id): id is string => typeof id === "string") : [];
}

/** How the stub's CDP close behaves: never answers, fails fast, or fails after a gate. */
interface WedgeOptions {
	/** Whether the handle carries the shared-daemon scope (`false` = private launch). */
	shared?: boolean;
	close?: "hang" | "fail" | "gate";
	/** Held by a `gate` close until the test releases it. */
	gate?: Promise<void>;
	/** Fires when a `gate` close starts, so the test can interleave a release. */
	entered?: () => void;
	/** Counts worker terminations instead of the default no-op. */
	onTerminate?: () => void;
}

/** Handle for a shared Chromium whose CDP endpoint answers nothing: every call hangs. */
function makeWedgeHandle(scope: SharedTargetScope, options: WedgeOptions = {}): BrowserHandle {
	const { shared = true, close = "hang", gate, entered } = options;
	const connection = {
		send: async (): Promise<never> => {
			if (close === "fail") throw new Error("Protocol error (Target.closeTarget): root connection send failed");
			if (close === "gate") {
				entered?.();
				await gate;
				throw new Error("Protocol error (Target.closeTarget): root connection send failed");
			}
			return await new Promise<never>(() => {});
		},
		on: (): void => undefined,
		off: (): void => undefined,
		createSession: async (): Promise<never> => await new Promise<never>(() => {}),
	};
	const handle: Record<string, unknown> = {
		key: "headless:1::",
		kind: { kind: "headless", headless: true },
		// Another tab still holds the shared browser: closing this one must not
		// dispose the handle (that is what leaves the target behind in Chrome).
		refCount: 2,
		stealth: { browserSession: null, override: null },
		browser: {
			connected: true,
			targets: () => [],
			_connection: connection,
			disconnect: () => undefined,
		},
	};
	if (shared) handle.sharedDaemon = { name: scope.daemonName, projectDir: scope.projectDir };
	return handle as unknown as BrowserHandle;
}

/** Tab whose page-close handshake never completes, so cleanup runs the forced path. */
function makeWedgeTab(scope: SharedTargetScope, options: WedgeOptions = {}): WorkerTabSession {
	return {
		name: "logos-b2b",
		browser: makeWedgeHandle(scope, options),
		targetId: TARGET_ID,
		backend: "worker",
		state: "alive",
		info: {},
		pending: new Map(),
		kindTag: "headless",
		ownsPage: true,
		ownerSessionId: "session-wedge",
		persist: false,
		lastActivityAt: Date.now(),
		frozen: false,
		worker: {
			mode: "worker",
			send: () => undefined,
			onMessage: () => () => undefined,
			onError: () => () => undefined,
			terminate: async () => {
				options.onTerminate?.();
			},
		},
	} as unknown as WorkerTabSession;
}

/** The worker shuts down normally; only its shared browser's CDP cleanup is wedged. */
function makeStrictWedgeTab(
	scope: SharedTargetScope,
	unit: UnitSnapshot,
	options: WedgeOptions = {},
): WorkerTabSession {
	const tab = makeWedgeTab(scope, options);
	Object.assign(tab.browser, { daemonLease: { unit, release: async () => undefined } });
	tab.uploadDir = path.join(getDaemonRuntimeDir(scope.projectDir), "uploads");
	tab.worker.onMessage = handler => {
		handler({ type: "closed" });
		return () => undefined;
	};
	return tab;
}

/** Minimal tool session for the `runInTab` entry point. */
function makeSession(): ToolSession {
	return {
		cwd: "/tmp/omp-wedge-session",
		hasUI: false,
		settings: Settings.isolated(),
		getSessionFile: () => null,
	} as unknown as ToolSession;
}

function makeSnapshot(readyMatch: string | undefined): UnitSnapshot {
	return {
		id: "daemon-wedge",
		generation: crypto.randomUUID(),
		key: DAEMON_NAME,
		kind: "proc",
		scope: { kind: "global" },
		label: DAEMON_NAME,
		state: "running",
		pids: [4242],
		createdAt: 0,
		startedAt: 0,
		readyAt: 1,
		restartCount: 0,
		outputBytes: 0,
		leases: 0,
		policy: { hold: "leases", idleMs: 3_000, onIdle: "stop", restart: "no", survive: "exec" },
		supervised: true,
		readyMatch,
	};
}

function makeBroker(
	opts: {
		snapshot?: UnitSnapshot;
		fail?: boolean;
		stopFails?: boolean;
		stopState?: UnitSnapshot["state"];
		beforeStop?: () => Promise<void>;
	},
	stops: string[],
): DaemonClient {
	return {
		async request<O extends DaemonOp>(operation: O): Promise<DaemonResult<O["op"]>> {
			if (opts.fail) throw new Error("daemon unreachable");
			const unit = opts.snapshot;
			if (!unit) throw new Error("unknown unit");
			if (operation.op === "describe") return { unit } as DaemonResult<O["op"]>;
			if (operation.op === "stop") {
				await opts.beforeStop?.();
				if (operation.generation !== unit.generation) return { unit } as DaemonResult<O["op"]>;
				stops.push(unit.key);
				if (opts.stopFails) throw new Error("daemon rejected the stop");
				return { unit: { ...unit, state: opts.stopState ?? "exited" } } as DaemonResult<O["op"]>;
			}
			throw new Error(`unexpected daemon op ${operation.op}`);
		},
	} as DaemonClient;
}

/** Live endpoint string as the broker stamps it once Chrome's listener is up. */
const READY_MATCH = "DevTools listening on ws://127.0.0.1:63199/devtools/browser/wedged";

afterEach(async () => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	resetOrphanRegistryForTest();
	// oxlint-disable-next-line unicorn/no-useless-spread -- releasing tabs mutates the map
	for (const name of [...getTabsMapForTest().keys()]) {
		await releaseTab(name, { kill: false }).catch(() => undefined);
	}
	for (const scope of scopes.splice(0)) {
		await fs.rm(getDaemonRuntimeDir(scope.projectDir), { recursive: true, force: true }).catch(() => undefined);
	}
});

describe("browser cleanup — timed-out target close in a shared browser", () => {
	it("keeps the ownership record and re-checks the shared browser", async () => {
		const scope = trackedScope();
		const healthCheck = spyOn(sharedDaemon, "stopSharedBrowserIfUnreachable").mockResolvedValue(false);
		await recordSharedTarget(scope, TARGET_ID);
		expect(await ownedTargets(scope)).toEqual([TARGET_ID]);

		getTabsMapForTest().set("logos-b2b", makeWedgeTab(scope));
		await expect(releaseTab("logos-b2b", { timeoutMs: 60 })).rejects.toThrow(
			`Timed out after 60ms closing headless browser tab "logos-b2b"; pending resource: orphan CDP target ${JSON.stringify(TARGET_ID)} (Page.close)`,
		);

		// The tab still leaves the map (the close is reported as failed)...
		expect(getTabsMapForTest().has("logos-b2b")).toBe(false);
		// ...but the target it never closed stays owned, so a later reap can
		// still find it, and the browser itself is re-checked for reachability.
		expect(await ownedTargets(scope)).toEqual([TARGET_ID]);
		expect(healthCheck).toHaveBeenCalledTimes(1);
		expect(healthCheck.mock.calls[0]?.[0]).toEqual(scope);
	});

	it("forgets the retained target once the browser it belonged to is stopped", async () => {
		const scope = trackedScope();
		// The check proves the whole browser gone: the target that could not be
		// closed died with it, so its record must not linger until this process
		// exits and be rewritten on every later write.
		const healthCheck = spyOn(sharedDaemon, "stopSharedBrowserIfUnreachable").mockResolvedValue(true);
		await recordSharedTarget(scope, TARGET_ID);
		getTabsMapForTest().set("logos-b2b", makeWedgeTab(scope, { close: "fail" }));

		await expect(releaseTab("logos-b2b", { timeoutMs: 60 })).resolves.toBe(true);

		expect(healthCheck).toHaveBeenCalledTimes(1);
		expect(await ownedTargets(scope)).toEqual([]);
	});

	it("still forgets a tab that was already dead when it was released", async () => {
		const scope = trackedScope();
		const healthCheck = spyOn(sharedDaemon, "stopSharedBrowserIfUnreachable").mockResolvedValue(false);
		await recordSharedTarget(scope, TARGET_ID);
		const tab = makeWedgeTab(scope);
		tab.state = "dead";
		getTabsMapForTest().set("logos-b2b", tab);

		await expect(releaseTab("logos-b2b", { timeoutMs: 60 })).resolves.toBe(true);

		expect(await ownedTargets(scope)).toEqual([]);
		expect(healthCheck).not.toHaveBeenCalled();
	});

	it("force-kills a wedged tab without forgetting the target it could not close", async () => {
		const scope = trackedScope();
		const healthCheck = spyOn(sharedDaemon, "stopSharedBrowserIfUnreachable").mockResolvedValue(false);
		await recordSharedTarget(scope, TARGET_ID);
		// `runInTab` reaching its grace period is one of the two real entry points
		// into `forceKillTab` (the other is a failed worker recycle — the
		// incident's "Failed to recycle browser tab worker; killing tab").
		getTabsMapForTest().set("logos-b2b", makeWedgeTab(scope, { close: "fail" }));

		await expect(
			runInTab("logos-b2b", { code: "await wait(60_000);", timeoutMs: 20, session: makeSession() }),
		).rejects.toThrow('hung past its 20ms budget, so omp released tab "logos-b2b"');

		expect(getTabsMapForTest().has("logos-b2b")).toBe(false);
		// The next call names the kill once, without the advice the failed call already gave.
		await expect(runInTab("logos-b2b", { code: "", timeoutMs: 20, session: makeSession() })).rejects.toThrow(
			/Tab "logos-b2b" was killed:.*Reopen/i,
		);
		expect(await ownedTargets(scope)).toEqual([TARGET_ID]);
		expect(healthCheck).toHaveBeenCalledTimes(1);
		expect(healthCheck.mock.calls[0]?.[0]).toEqual(scope);
	});

	it("terminates an unresponsive cancelled run after the abort grace, not its inherited budget", async () => {
		const scope = trackedScope();
		spyOn(sharedDaemon, "stopSharedBrowserIfUnreachable").mockResolvedValue(false);
		const terminated = Promise.withResolvers<void>();
		const sent = Promise.withResolvers<void>();
		const tab = makeWedgeTab(scope, { close: "fail", onTerminate: () => terminated.resolve() });
		tab.worker.send = message => {
			if (message.type === "run") sent.resolve();
		};
		getTabsMapForTest().set(tab.name, tab);
		vi.useFakeTimers();
		const controller = new AbortController();
		const failure = rejectionOf(
			runInTab(tab.name, {
				code: "while (true) {}",
				timeoutMs: 300_000,
				signal: controller.signal,
				session: makeSession(),
			}),
		);
		await sent.promise;
		controller.abort();
		vi.advanceTimersByTime(749);
		expect(getTabsMapForTest().has(tab.name)).toBe(true);
		vi.advanceTimersByTime(1);
		await terminated.promise;
		expect(await failure).toBeInstanceOf(ToolAbortError);
		expect(getTabsMapForTest().has(tab.name)).toBe(false);
	});

	it.each([
		{ expired: true, cancel: false, label: "caps startup after an expired run" },
		{ expired: false, cancel: false, label: "preserves the startup budget of recovery before a run expires" },
		{ expired: false, cancel: true, label: "cancels a stalled replacement and terminates its worker" },
	])("$label", async ({ expired, cancel }) => {
		const scope = trackedScope();
		spyOn(sharedDaemon, "stopSharedBrowserIfUnreachable").mockResolvedValue(false);
		const tab = makeWedgeTab(scope, { close: "fail" });
		const runSent = Promise.withResolvers<string>();
		tab.worker.send = message => {
			if (message.type === "run") runSent.resolve(message.id);
		};
		getTabsMapForTest().set(tab.name, tab);
		const RealWorker = globalThis.Worker;
		const readyWait = Promise.withResolvers<void>();
		const replacementTerminated = Promise.withResolvers<void>();
		const controller = new AbortController();
		let replacement: EventTarget | undefined;
		vi.useFakeTimers();
		let now = 0;
		spyOn(performance, "now").mockImplementation(() => now);
		const setTimer = globalThis.setTimeout;
		let setupSent = false;
		spyOn(globalThis, "setTimeout").mockImplementation(
			Object.assign((...args: Parameters<typeof setTimeout>) => {
				const timer = setTimer(...args);
				if (setupSent && args[1] !== 2_000) readyWait.resolve();
				return timer;
			}, setTimer),
		);
		globalThis.Worker = class extends EventTarget {
			constructor() {
				super();
				replacement = this;
			}
			postMessage(message: WorkerInbound): void {
				if (message.type === "init") {
					setupSent = true;
					this.dispatchEvent(new MessageEvent("message", { data: { type: "setup" } }));
				}
				if (message.type === "close") {
					this.dispatchEvent(new MessageEvent("message", { data: { type: "closed" } }));
				}
			}
			terminate(): void {
				replacementTerminated.resolve();
			}
		} as unknown as typeof Worker;
		try {
			const run = runInTab(tab.name, {
				code: "",
				timeoutMs: cancel ? 300_000 : expired ? 120_000 : 10_000,
				signal: controller.signal,
				session: makeSession(),
			});
			const result = run.catch(error => error);
			const id = await runSent.promise;
			const pending = tab.pending.get(id)!;
			if (expired) pending.reject(new ToolError("Browser code execution timed out after 120000ms"));
			else pending.resolve({ displays: [], screenshots: [], returnValue: true, recoverTab: true });
			await readyWait.promise;
			if (cancel) {
				controller.abort();
				vi.advanceTimersByTime(749);
				expect(getTabsMapForTest().has(tab.name)).toBe(true);
				vi.advanceTimersByTime(1);
			} else {
				now = 6_000;
				vi.advanceTimersByTime(6_000);
			}
			if (!expired && !cancel) {
				replacement!.dispatchEvent(new MessageEvent("message", { data: { type: "ready", info: {} } }));
			}
			const outcome = await result;
			if (cancel) {
				expect(outcome).toBeInstanceOf(ToolAbortError);
				await replacementTerminated.promise;
			} else if (expired) {
				expect(outcome).toBeInstanceOf(ToolError);
				expect(String(outcome)).toContain("released");
				expect(String(outcome)).toContain("tools.maxTimeout");
			} else {
				expect(outcome).toMatchObject({ returnValue: true });
			}
			expect(getTabsMapForTest().has(tab.name)).toBe(!expired && !cancel);
		} finally {
			globalThis.Worker = RealWorker;
		}
	});

	it("lets a release join an in-flight force-kill instead of tearing the tab down twice", async () => {
		const scope = trackedScope();
		const healthCheck = spyOn(sharedDaemon, "stopSharedBrowserIfUnreachable").mockResolvedValue(false);
		await recordSharedTarget(scope, TARGET_ID);
		const gate = Promise.withResolvers<void>();
		const entered = Promise.withResolvers<void>();
		let terminations = 0;
		const tab = makeWedgeTab(scope, {
			close: "gate",
			gate: gate.promise,
			entered: () => entered.resolve(),
			onTerminate: () => terminations++,
		});
		getTabsMapForTest().set("logos-b2b", tab);

		const killed = runInTab("logos-b2b", {
			code: "await wait(60_000);",
			timeoutMs: 20,
			session: makeSession(),
		}).catch((error: Error) => error.message);
		// Force-kill is now parked inside the CDP close: the release that lands
		// here must join it, not release the browser hold a second time or make
		// its own ownership decision.
		await entered.promise;
		expect(tab.state).toBe("dead");
		expect(tab.browser.refCount).toBe(2);
		// The release must join the in-flight force-kill, so it settles only when
		// that teardown does — hence starting it, not awaiting it, before the gate.
		const released = releaseTab("logos-b2b", { timeoutMs: 40 });
		gate.resolve();
		// The join reports the release contract, not the target-close outcome:
		// the tab is gone either way, and a surviving target is kept in the
		// registry (asserted below) rather than reported as an unreleased tab.
		expect(await released).toBe(true);
		await killed;

		expect(terminations).toBe(1);
		expect(tab.browser.refCount).toBe(1);
		expect(await ownedTargets(scope)).toEqual([TARGET_ID]);
		expect(healthCheck).toHaveBeenCalledTimes(1);
	});

	it("bounds the close a joining release waits on when force-kill is stuck on a wedged browser", async () => {
		const scope = trackedScope();
		const healthCheck = spyOn(sharedDaemon, "stopSharedBrowserIfUnreachable").mockResolvedValue(false);
		await recordSharedTarget(scope, TARGET_ID);
		// Never resolves: the CDP close hangs exactly as it does against a wedged
		// Chromium, so only the supervisor's own close budget can end this wait.
		const wedged = Promise.withResolvers<void>();
		const entered = Promise.withResolvers<void>();
		getTabsMapForTest().set(
			"logos-b2b",
			makeWedgeTab(scope, { close: "gate", gate: wedged.promise, entered: () => entered.resolve() }),
		);

		const killed = runInTab("logos-b2b", {
			code: "await wait(60_000);",
			timeoutMs: 20,
			session: makeSession(),
		}).catch((error: Error) => error.message);
		await entered.promise;

		// A release joining the force-kill must not inherit an unbounded CDP wait
		// (Puppeteer's protocol timeout is 60 s); the supervisor's 5 s close
		// budget ends it, and the join still reports the tab as released.
		const joined = await withTimeout(
			releaseTab("logos-b2b", { timeoutMs: 50 }),
			9_000,
			"joined release outlived the force-kill close budget",
		).catch(() => "timed-out" as const);
		expect(joined).toBe(true);

		await killed;
		expect(await ownedTargets(scope)).toEqual([TARGET_ID]);
		expect(healthCheck).toHaveBeenCalledTimes(1);
	}, 20_000);

	it("never checks a browser that is not the shared one", async () => {
		const scope = trackedScope();
		const healthCheck = spyOn(sharedDaemon, "stopSharedBrowserIfUnreachable").mockResolvedValue(false);
		getTabsMapForTest().set("logos-b2b", makeWedgeTab(scope, { shared: false }));

		await expect(releaseTab("logos-b2b", { timeoutMs: 60 })).rejects.toThrow("Timed out after 60ms");

		expect(healthCheck).not.toHaveBeenCalled();
	});

	it("treats an unconfirmed close (failed root-connection send) as unclosed too", async () => {
		const scope = trackedScope();
		const healthCheck = spyOn(sharedDaemon, "stopSharedBrowserIfUnreachable").mockResolvedValue(false);
		await recordSharedTarget(scope, TARGET_ID);
		getTabsMapForTest().set("logos-b2b", makeWedgeTab(scope, { close: "fail" }));

		await expect(releaseTab("logos-b2b", { timeoutMs: 60 })).resolves.toBe(true);

		expect(await ownedTargets(scope)).toEqual([TARGET_ID]);
		expect(healthCheck).toHaveBeenCalledTimes(1);
	});
});

describe("strict shared browser owner cleanup", () => {
	it("awaits confirmed daemon death before releasing ownership and leaves sibling resources tracked", async () => {
		const scope = trackedScope();
		const stopEntered = Promise.withResolvers<void>();
		const stopAllowed = Promise.withResolvers<void>();
		const stops: string[] = [];
		const probes: string[] = [];
		const snapshot = makeSnapshot(READY_MATCH);
		const broker = makeBroker(
			{
				snapshot,
				beforeStop: async () => {
					stopEntered.resolve();
					await stopAllowed.promise;
				},
			},
			stops,
		);
		const check = sharedDaemon.stopSharedBrowserIfUnreachable;
		const healthCheck = spyOn(sharedDaemon, "stopSharedBrowserIfUnreachable").mockImplementation(scope =>
			check(scope, {
				client: broker,
				probe: async endpoint => {
					probes.push(endpoint);
					return false;
				},
			}),
		);
		let terminations = 0;
		let siblingTerminations = 0;
		const tab = makeStrictWedgeTab(scope, snapshot, { onTerminate: () => terminations++ });
		const sibling = makeStrictWedgeTab(scope, snapshot, { onTerminate: () => siblingTerminations++ });
		sibling.name = "sibling-tab";
		sibling.targetId = "sibling-target";
		sibling.ownerSessionId = "sibling-owner";
		sibling.browser = tab.browser;
		getTabsMapForTest().set(tab.name, tab);
		getTabsMapForTest().set(sibling.name, sibling);
		await recordSharedTarget(scope, tab.targetId);
		await recordSharedTarget(scope, sibling.targetId);
		await fs.mkdir(tab.uploadDir, { recursive: true });
		const upload = path.join(tab.uploadDir, "pending-upload");
		await fs.writeFile(upload, "still needed until the page dies");
		let settled = false;
		const cleanup = releaseTabsForOwner("session-wedge", { strict: true, timeoutMs: 60 }).finally(() => {
			settled = true;
		});
		try {
			await Promise.race([stopEntered.promise, cleanup]);
			expect(settled).toBe(false);
			expect(getTabsMapForTest().get(tab.name)).toBe(tab);
			expect(tab.browser.refCount).toBe(2);
			expect(await ownedTargets(scope)).toEqual([TARGET_ID, sibling.targetId]);
			expect(await Bun.file(upload).text()).toBe("still needed until the page dies");
			stopAllowed.resolve();
			expect(await cleanup).toBe(1);
			expect(getTabsMapForTest().has(tab.name)).toBe(false);
			expect(getTabsMapForTest().get(sibling.name)).toBe(sibling);
			expect(tab.browser.refCount).toBe(1);
			expect(terminations).toBe(1);
			expect(siblingTerminations).toBe(0);
			expect(await ownedTargets(scope)).toEqual([sibling.targetId]);
			expect(await Bun.file(upload).exists()).toBe(false);
			expect(probes).toEqual([
				"ws://127.0.0.1:63199/devtools/browser/wedged",
				"ws://127.0.0.1:63199/devtools/browser/wedged",
			]);
			expect(stops).toEqual([DAEMON_NAME]);
			expect(await releaseTabsForOwner("session-wedge", { strict: true, timeoutMs: 60 })).toBe(0);
		} finally {
			stopAllowed.resolve();
			await cleanup.catch(() => undefined);
			healthCheck.mockResolvedValue(true);
			await releaseTabsForOwner("session-wedge", { strict: true, timeoutMs: 60 });
			await releaseTabsForOwner("sibling-owner", { strict: true, timeoutMs: 60 });
		}
	});

	it.each(["rejected", "stopping"] as const)(
		"retains ownership after a %s stop and retries unfinished cleanup",
		async failure => {
			const scope = trackedScope();
			const stops: string[] = [];
			const options: {
				snapshot: UnitSnapshot;
				stopFails: boolean;
				stopState: UnitSnapshot["state"];
			} = {
				snapshot: makeSnapshot(READY_MATCH),
				stopFails: failure === "rejected",
				stopState: "stopping",
			};
			const broker = makeBroker(options, stops);
			const check = sharedDaemon.stopSharedBrowserIfUnreachable;
			const healthCheck = spyOn(sharedDaemon, "stopSharedBrowserIfUnreachable").mockImplementation(scope =>
				check(scope, { client: broker, probe: async () => false }),
			);
			let terminations = 0;
			const tab = makeStrictWedgeTab(scope, options.snapshot, { onTerminate: () => terminations++ });
			getTabsMapForTest().set(tab.name, tab);
			await recordSharedTarget(scope, TARGET_ID);
			try {
				await expect(releaseTabsForOwner("session-wedge", { strict: true, timeoutMs: 60 })).rejects.toThrow(
					"Failed to release browser tabs for owner",
				);
				expect(getTabsMapForTest().get(tab.name)).toBe(tab);
				expect(tab.browser.refCount).toBe(2);
				expect(await ownedTargets(scope)).toEqual([TARGET_ID]);
				expect(terminations).toBe(1);
				expect(stops).toEqual([DAEMON_NAME]);

				options.stopFails = false;
				options.stopState = "exited";
				expect(await releaseTabsForOwner("session-wedge", { strict: true, timeoutMs: 60 })).toBe(1);
				expect(getTabsMapForTest().has(tab.name)).toBe(false);
				expect(tab.browser.refCount).toBe(1);
				expect(await ownedTargets(scope)).toEqual([]);
				expect(terminations).toBe(1);
				expect(stops).toEqual([DAEMON_NAME, DAEMON_NAME]);
			} finally {
				healthCheck.mockResolvedValue(true);
				await releaseTabsForOwner("session-wedge", { strict: true, timeoutMs: 60 });
			}
		},
	);

	it.each(["healthy", "replacement"] as const)(
		"does not stop a %s shared browser after strict page failure",
		async state => {
			const scope = trackedScope();
			const stops: string[] = [];
			const options = { snapshot: makeSnapshot(READY_MATCH) };
			const broker = makeBroker(options, stops);
			const check = sharedDaemon.stopSharedBrowserIfUnreachable;
			const healthCheck = spyOn(sharedDaemon, "stopSharedBrowserIfUnreachable").mockImplementation(scope =>
				check(scope, {
					client: broker,
					probe: async () => {
						if (state === "healthy") return true;
						options.snapshot = makeSnapshot(
							"DevTools listening on ws://127.0.0.1:63199/devtools/browser/replacement",
						);
						return false;
					},
				}),
			);
			const tab = makeStrictWedgeTab(scope, options.snapshot, { close: "fail" });
			getTabsMapForTest().set(tab.name, tab);
			await recordSharedTarget(scope, TARGET_ID);
			try {
				await expect(releaseTabsForOwner("session-wedge", { strict: true, timeoutMs: 60 })).rejects.toThrow(
					"Failed to release browser tabs for owner",
				);
				expect(stops).toEqual([]);
				expect(healthCheck).toHaveBeenCalledTimes(1);
				expect(getTabsMapForTest().get(tab.name)).toBe(tab);
				expect(tab.browser.refCount).toBe(2);
				expect(await ownedTargets(scope)).toEqual([TARGET_ID]);
			} finally {
				healthCheck.mockResolvedValue(true);
				await releaseTabsForOwner("session-wedge", { strict: true, timeoutMs: 60 });
			}
		},
	);

	it("recovers a failed page close when strict owner cleanup joins an ordinary release", async () => {
		const scope = trackedScope();
		const entered = Promise.withResolvers<void>();
		const gate = Promise.withResolvers<void>();
		const healthCheck = spyOn(sharedDaemon, "stopSharedBrowserIfUnreachable").mockResolvedValue(true);
		let terminations = 0;
		const snapshot = makeSnapshot(READY_MATCH);
		const tab = makeStrictWedgeTab(scope, snapshot, {
			close: "gate",
			gate: gate.promise,
			entered: () => entered.resolve(),
			onTerminate: () => terminations++,
		});
		getTabsMapForTest().set(tab.name, tab);
		await recordSharedTarget(scope, TARGET_ID);
		const ordinary = releaseTab(tab.name, { timeoutMs: 60 });
		try {
			await entered.promise;
			const strict = releaseTabsForOwner("session-wedge", { strict: true, timeoutMs: 60 });
			gate.resolve();
			expect(await strict).toBe(1);
			expect(await ordinary).toBe(true);
			expect(healthCheck).toHaveBeenCalledTimes(1);
			expect(getTabsMapForTest().has(tab.name)).toBe(false);
			expect(await ownedTargets(scope)).toEqual([]);
			expect(tab.browser.refCount).toBe(1);
			expect(terminations).toBe(1);
		} finally {
			gate.resolve();
			await ordinary.catch(() => undefined);
			await releaseTabsForOwner("session-wedge", { strict: true, timeoutMs: 60 });
		}
	});
});

describe("shared browser reachability check", () => {
	it("stops a browser whose endpoint stopped answering twice in a row", async () => {
		const stops: string[] = [];
		const probes: string[] = [];
		const broker = makeBroker({ snapshot: makeSnapshot(READY_MATCH) }, stops);

		const stopped = await stopSharedBrowserIfUnreachable(
			{ projectDir: "/tmp/omp-wedge-a", daemonName: DAEMON_NAME },
			{
				client: broker,
				probe: async wsEndpoint => {
					probes.push(wsEndpoint);
					return false;
				},
			},
		);

		expect(stopped).toBe(true);
		expect(probes).toEqual([
			"ws://127.0.0.1:63199/devtools/browser/wedged",
			"ws://127.0.0.1:63199/devtools/browser/wedged",
		]);
		expect(stops).toEqual([DAEMON_NAME]);
	});

	it("settles and frees its single-flight slot when the CDP connect never opens", async () => {
		// `rawHttpGet` awaits `Bun.connect` before its own timer can settle the
		// call, so a stalled connect used to pin the check (and every later
		// cleanup that joined it) indefinitely.
		const connect = Promise.withResolvers<unknown>();
		const connectSpy = spyOn(Bun, "connect").mockImplementation((() => connect.promise) as never);
		try {
			const scope = trackedScope();
			const stops: string[] = [];
			const broker = makeBroker({ snapshot: makeSnapshot(READY_MATCH) }, stops);

			const capMs = 50;
			const first = stopSharedBrowserIfUnreachable(scope, { client: broker, probeCapMs: capMs });
			const joined = stopSharedBrowserIfUnreachable(scope, { client: broker, probeCapMs: capMs });
			expect(await Promise.all([first, joined])).toEqual([true, true]);
			expect(stops).toEqual([DAEMON_NAME]);

			// Settled slot: the next check describes again instead of joining a
			// promise that never clears.
			const stopsAfter = [...stops];
			expect(await stopSharedBrowserIfUnreachable(scope, { client: broker, probe: async () => true })).toBe(false);
			expect(stops).toEqual(stopsAfter);
		} finally {
			connectSpy.mockRestore();
			connect.resolve(undefined);
		}
	});

	it("does not report a stop the broker never confirmed", async () => {
		// `stopQuietly` absorbs a rejected stop, so the only proof a daemon ended
		// is a terminal snapshot. Reporting success without one would let the
		// caller forget targets that are still open — the leak this exists for.
		for (const opts of [{ stopFails: true }, { stopState: "stopping" as const }]) {
			const stops: string[] = [];
			const broker = makeBroker({ snapshot: makeSnapshot(READY_MATCH), ...opts }, stops);

			const stopped = await stopSharedBrowserIfUnreachable(
				{ projectDir: "/tmp/omp-wedge-unconfirmed", daemonName: DAEMON_NAME },
				{ client: broker, probe: async () => false },
			);

			expect(stopped).toBe(false);
			expect(stops).toEqual([DAEMON_NAME]);
		}
	});

	it("survives a single failed probe, so one slow answer is not a wedge", async () => {
		const stops: string[] = [];
		let probes = 0;
		const broker = makeBroker({ snapshot: makeSnapshot(READY_MATCH) }, stops);

		const stopped = await stopSharedBrowserIfUnreachable(
			{ projectDir: "/tmp/omp-wedge-single", daemonName: DAEMON_NAME },
			{
				client: broker,
				probe: async () => ++probes > 1,
			},
		);

		expect(stopped).toBe(false);
		expect(probes).toBe(2);
		expect(stops).toEqual([]);
	});

	it("treats one timed-out real probe followed by an answer as not a wedge", async () => {
		// The production probe, against an endpoint that misses its 1.5 s budget
		// once — a loaded machine, not a dead browser. Real wall-clock time is
		// the subject here, so the slow answer is held until the probe's own
		// timeout aborts the request rather than a guessed sleep.
		let requests = 0;
		const server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			async fetch(req) {
				requests++;
				if (requests === 1) {
					const aborted = Promise.withResolvers<void>();
					req.signal.addEventListener("abort", () => aborted.resolve(), { once: true });
					await aborted.promise;
					return new Response("too late", { status: 504 });
				}
				return Response.json({ Browser: "Chrome/150.0.7871.24" });
			},
		});
		const stops: string[] = [];
		const broker = makeBroker(
			{ snapshot: makeSnapshot(`DevTools listening on ws://127.0.0.1:${server.port}/`) },
			stops,
		);
		try {
			const stopped = await stopSharedBrowserIfUnreachable(
				{ projectDir: "/tmp/omp-wedge-slow", daemonName: DAEMON_NAME },
				{ client: broker },
			);

			expect(stopped).toBe(false);
			expect(requests).toBe(2);
			expect(stops).toEqual([]);
		} finally {
			await server.stop(true);
		}
	});

	it("leaves a browser that still answers alone, so other sessions keep their tabs", async () => {
		const stops: string[] = [];
		let probes = 0;
		const broker = makeBroker({ snapshot: makeSnapshot(READY_MATCH) }, stops);

		const stopped = await stopSharedBrowserIfUnreachable(
			{ projectDir: "/tmp/omp-wedge-b", daemonName: DAEMON_NAME },
			{
				client: broker,
				probe: async () => {
					probes++;
					return true;
				},
			},
		);

		expect(stopped).toBe(false);
		expect(probes).toBe(1);
		expect(stops).toEqual([]);
	});

	it("leaves a daemon that never became ready to the attach path", async () => {
		const stops: string[] = [];
		const broker = makeBroker({ snapshot: makeSnapshot(undefined) }, stops);

		const stopped = await stopSharedBrowserIfUnreachable(
			{ projectDir: "/tmp/omp-wedge-c", daemonName: DAEMON_NAME },
			{ client: broker, probe: async () => false },
		);

		expect(stopped).toBe(false);
		expect(stops).toEqual([]);
	});

	it("gives up quietly when the broker cannot be reached", async () => {
		const stops: string[] = [];
		const broker = makeBroker({ fail: true }, stops);

		const stopped = await stopSharedBrowserIfUnreachable(
			{ projectDir: "/tmp/omp-wedge-d", daemonName: DAEMON_NAME },
			{ client: broker, probe: async () => false },
		);

		expect(stopped).toBe(false);
		expect(stops).toEqual([]);
	});

	it("absorbs a probe that throws", async () => {
		const stops: string[] = [];
		const broker = makeBroker({ snapshot: makeSnapshot(READY_MATCH) }, stops);

		await expect(
			stopSharedBrowserIfUnreachable(
				{ projectDir: "/tmp/omp-wedge-e", daemonName: DAEMON_NAME },
				{
					client: broker,
					probe: async () => {
						throw new Error("probe exploded");
					},
				},
			),
		).resolves.toBe(false);
		expect(stops).toEqual([]);
	});
});
