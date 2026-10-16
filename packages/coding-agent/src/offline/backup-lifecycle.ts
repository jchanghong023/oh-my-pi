import type { Database as SqliteDatabase } from "bun:sqlite";
import * as path from "node:path";
import { getOfflineShmState } from "@oh-my-pi/pi-utils/dirs";
import type { FileLockHandle } from "@oh-my-pi/pi-utils/file-lock";
import * as logger from "@oh-my-pi/pi-utils/logger";
import * as postmortem from "@oh-my-pi/pi-utils/postmortem";
import { workerHostEntry } from "@oh-my-pi/pi-utils/worker-host";

const OFFLINE_SHM_BACKUP_WORKER_ARG = "__omp_worker_offline_shm_backup";
const BACKUP_PERIOD_MS = 600_000;

type BackupNotice = (message: string) => void;
interface BackupResult {
	status: "started" | "completed" | "busy" | "failed";
	completedAt?: string;
	errorCode?: string;
	lastSuccessfulAt?: string;
}

let active: { stop(): void } | undefined;

/** Start only at a frontend's real ready boundary; the first round is a full period later. */
export function startOfflineShmBackup(notify?: BackupNotice): () => void {
	if (active) return () => {};
	const state = getOfflineShmState();
	if (!state || !Bun.isMainThread) return () => {};

	let stopped = false;
	let acquiring = false;
	let owner: FileLockHandle | null = null;
	let worker: Worker | undefined;
	let lastSuccessfulAt: string | undefined;
	let failureNotified = false;
	const fail = (errorCode: string): void => {
		logger.warn("Offline shm backup failed", {
			component: "offline-shm",
			event: "offline_shm_backup_failed",
			error_code: errorCode,
			last_successful_at: lastSuccessfulAt ?? null,
		});
		if (failureNotified || stopped) return;
		failureNotified = true;
		try {
			notify?.(
				`Offline shm backup failed (${errorCode}). Frontend continues using shm; data since ${lastSuccessfulAt ?? "startup (no successful domain backup recorded)"} may be lost. See diagnostic logs.`,
			);
		} catch {
			// A disconnected frontend must not turn a backup warning into a fatal error.
		}
	};
	const tick = async (): Promise<void> => {
		// Drop triggers while a round or ownership attempt is active: never queue work.
		if (stopped || worker || acquiring) return;
		acquiring = true;
		try {
			if (!owner) {
				// Linux native leases use abstract local sockets, not NFS or PID files.
				// Acquisition is nonwaiting and only happens after the first full period.
				// Static loading would initialize the native module in non-offline frontends.
				const { tryAcquireFileLock } = await import("@oh-my-pi/pi-utils/file-lock");
				if (stopped) return;
				owner = tryAcquireFileLock(path.join(state.runtimeRoot, ".offline-shm-scheduler"));
				if (!owner) return;
			}
			const host = workerHostEntry();
			const current = host
				? new Worker(host, { type: "module", argv: [OFFLINE_SHM_BACKUP_WORKER_ARG] })
				: new Worker(new URL("./backup-worker.ts", import.meta.url).href, { type: "module" });
			worker = current;
			let reported = false;
			current.onmessage = event => {
				if (stopped || worker !== current) return;
				const result = event.data as BackupResult;
				lastSuccessfulAt = result.lastSuccessfulAt ?? lastSuccessfulAt;
				if (result.status === "started") {
					logger.info("Offline shm backup started", {
						component: "offline-shm",
						event: "offline_shm_backup_started",
						last_successful_at: lastSuccessfulAt ?? null,
					});
					return;
				}
				reported = true;
				if (result.status === "completed") {
					lastSuccessfulAt = result.completedAt;
					failureNotified = false;
					logger.info("Offline shm backup completed", {
						component: "offline-shm",
						event: "offline_shm_backup_completed",
						last_successful_at: lastSuccessfulAt ?? null,
					});
				} else if (result.status === "failed") {
					fail(result.errorCode ?? "BACKUP_FAILED");
				}
			};
			current.onerror = event => {
				event.preventDefault();
				if (stopped || worker !== current) return;
				reported = true;
				fail("WORKER_FAILED");
				// A failed module may never close its message port.
				current.terminate();
			};
			current.addEventListener("close", () => {
				if (worker !== current) return;
				worker = undefined;
				if (!stopped && !reported) fail("WORKER_EXITED");
			});
			current.postMessage(state);
			// Neither the round nor its timer keeps a short-lived command alive.
			current.unref();
		} catch {
			fail("BACKUP_START_FAILED");
			if (worker) {
				worker.terminate();
				worker = undefined;
			}
		} finally {
			acquiring = false;
		}
	};
	const timer = setInterval(() => void tick(), BACKUP_PERIOD_MS);
	timer.unref();
	let unregister = (): void => {};
	const stop = (): void => {
		if (stopped) return;
		stopped = true;
		clearInterval(timer);
		// Do not await a worker pinned in NFS IO, or run a final round on exit.
		worker?.terminate();
		worker = undefined;
		owner?.release();
		owner = null;
		unregister();
		process.off("exit", stop);
		if (active?.stop === stop) active = undefined;
	};
	active = { stop };
	process.once("exit", stop);
	unregister = postmortem.register("offline-shm-backup", stop, { exitOnly: true });
	return stop;
}

/** Standalone commands become ready only after their first normal stdout write. */
export function armOfflineShmBackupOnOutput(notify?: BackupNotice): () => void {
	if (process.platform !== "linux" || !/^(1|true|yes|on)$/i.test(process.env.OMP_OFFLINE?.trim() ?? ""))
		return () => {};
	const original = process.stdout.write;
	let stopBackup = (): void => {};
	let cancelled = false;
	const write: typeof original = function (this: typeof process.stdout, ...args: unknown[]): boolean {
		process.stdout.write = original;
		// Forward every overload unchanged; Parameters<typeof original> only captures the final one.
		const result: boolean = Reflect.apply(original, this, args);
		// Preserve the output boundary and never put initialization ahead of that write.
		queueMicrotask(() => {
			if (!cancelled) stopBackup = startOfflineShmBackup(notify);
		});
		return result;
	};
	process.stdout.write = write;
	return () => {
		cancelled = true;
		if (process.stdout.write === write) process.stdout.write = original;
		stopBackup();
	};
}

/**
 * Distribution probe: run a real round through the CLI's hidden worker selector
 * when available, then independently reopen its published SQLite/file backup.
 * Explicit smoke tests work on every platform without arming the scheduler.
 */
export async function smokeTestOfflineShmBackupWorker({
	workerEntry = workerHostEntry(),
}: {
	workerEntry?: string | null;
} = {}): Promise<void> {
	// Keep SQLite and fixture dependencies out of ordinary frontend startup.
	const [{ Database }, fs, { createHash, randomUUID }, { TempDir }, { SMOKE_TEST_TIMEOUT_MS }] = await Promise.all([
		import("bun:sqlite"),
		import("node:fs/promises"),
		import("node:crypto"),
		import("@oh-my-pi/pi-utils/temp"),
		import("../subprocess/worker-client"),
	]);
	const directory = await TempDir.create("@omp-offline-shm-worker-smoke-");
	let database: SqliteDatabase | undefined;
	let worker: Worker | undefined;
	let exited = false;
	let timer: NodeJS.Timeout | undefined;
	const closed = Promise.withResolvers<void>();
	try {
		const runtimeRoot = directory.join("runtime");
		const persistentRoot = directory.join("persistent");
		await fs.mkdir(runtimeRoot, { mode: 0o700 });
		await fs.mkdir(persistentRoot, { mode: 0o700 });
		const expected = `offline-shm-worker-smoke-${randomUUID()}`;
		await fs.writeFile(path.join(runtimeRoot, "fixture.txt"), expected, { mode: 0o600 });
		database = new Database(path.join(runtimeRoot, "fixture.db"));
		database.exec("PRAGMA journal_mode = WAL; CREATE TABLE fixture (value TEXT NOT NULL)");
		database.query("INSERT INTO fixture (value) VALUES (?)").run(expected);
		const domainId = randomUUID();
		const state = { runtimeRoot, persistentRoot, domainId };
		const response = Promise.withResolvers<string>();
		let completedAt: string | undefined;
		worker = workerEntry
			? new Worker(workerEntry, { type: "module", argv: [OFFLINE_SHM_BACKUP_WORKER_ARG] })
			: new Worker(new URL("./backup-worker.ts", import.meta.url).href, { type: "module" });
		worker.onmessage = (event: MessageEvent<BackupResult>) => {
			const result = event.data;
			if (result.status === "started") return;
			if (
				result.status !== "completed" ||
				typeof result.completedAt !== "string" ||
				!Number.isFinite(Date.parse(result.completedAt))
			) {
				response.reject(new Error(`offline shm backup worker smoke: ${result.errorCode ?? result.status}`));
				return;
			}
			completedAt = result.completedAt;
		};
		worker.onerror = event => {
			event.preventDefault();
			response.reject(
				event.error instanceof Error ? event.error : new Error(`offline shm backup worker smoke: ${event.message}`),
			);
		};
		worker.onmessageerror = () => response.reject(new Error("offline shm backup worker smoke: invalid message"));
		worker.addEventListener("close", () => {
			exited = true;
			closed.resolve();
			if (completedAt) response.resolve(completedAt);
			else response.reject(new Error("offline shm backup worker smoke: exited without completed response"));
		});
		timer = setTimeout(
			() => response.reject(new Error("offline shm backup worker smoke: backup round timed out")),
			SMOKE_TEST_TIMEOUT_MS,
		);
		// Post immediately, exercising the host's pre-import inbox handoff too.
		worker.postMessage(state);
		const reportedAt = await response.promise;
		clearTimeout(timer);
		timer = undefined;
		// The source stays open in WAL mode until the worker has exited. The
		// recovered database must be standalone, not depend on active sidecars.
		database.close();
		database = undefined;
		const domain = path.join(
			persistentRoot,
			".offline-shm-backups",
			createHash("sha256").update(domainId).digest("hex"),
		);
		const pointer = JSON.parse(await fs.readFile(path.join(domain, "current.json"), "utf8")) as {
			format: number;
			current: string;
			completedAt: string;
		};
		if (
			pointer.format !== 1 ||
			typeof pointer.current !== "string" ||
			!/^\d{13}-[a-f0-9-]{36}$/.test(pointer.current) ||
			pointer.completedAt !== reportedAt
		) {
			throw new Error("offline shm backup worker smoke: invalid published generation");
		}
		const generation = path.join(domain, "generations", pointer.current);
		const manifest = JSON.parse(await fs.readFile(path.join(generation, "manifest.json"), "utf8")) as {
			status: string;
			domainId: string;
			generation: string;
		};
		if (manifest.status !== "complete" || manifest.domainId !== domainId || manifest.generation !== pointer.current) {
			throw new Error("offline shm backup worker smoke: incomplete backup manifest");
		}
		const data = path.join(generation, "data");
		if ((await fs.readFile(path.join(data, "fixture.txt"), "utf8")) !== expected) {
			throw new Error("offline shm backup worker smoke: recovered file mismatch");
		}
		const recovered = new Database(path.join(data, "fixture.db"), { readonly: true });
		try {
			const row = recovered.query<{ value: string }, []>("SELECT value FROM fixture").get();
			const integrity = recovered.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get();
			if (row?.value !== expected || integrity?.integrity_check !== "ok") {
				throw new Error("offline shm backup worker smoke: recovered database mismatch");
			}
		} finally {
			recovered.close();
		}
	} finally {
		clearTimeout(timer);
		try {
			if (worker && !exited) {
				// terminate() is not awaitable on Bun's Web Worker. Observe the
				// real close event before removing any file the worker can use.
				worker.terminate();
				const cleanupTimer = setTimeout(
					() => closed.reject(new Error("offline shm backup worker smoke: worker termination timed out")),
					SMOKE_TEST_TIMEOUT_MS,
				);
				try {
					await closed.promise;
				} finally {
					clearTimeout(cleanupTimer);
				}
			}
		} finally {
			database?.close();
		}
		await directory.remove();
	}
}
