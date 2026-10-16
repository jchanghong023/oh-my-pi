import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parentPort } from "node:worker_threads";
import type { OfflineShmState } from "@oh-my-pi/pi-utils/dirs";
import { consumeWorkerInbox } from "@oh-my-pi/pi-utils/worker-host";
import { runOfflineShmBackup } from "./backup";

if (!parentPort) throw new Error("offline-shm-backup: missing parentPort");
const port = parentPort;
const inbox = consumeWorkerInbox();
let running = false;
const readLatestSuccess = async (state: OfflineShmState): Promise<string | undefined> => {
	try {
		const value: unknown = JSON.parse(
			await fs.readFile(path.join(state.runtimeRoot, ".offline-shm-backup-success.json"), "utf8"),
		);
		if (value && typeof value === "object" && "completedAt" in value && typeof value.completedAt === "string") {
			const timestamp = value.completedAt;
			if (timestamp.length <= 64 && Number.isFinite(Date.parse(timestamp))) return timestamp;
		}
	} catch {
		// No successful domain backup has been recorded in shm yet.
	}
	return undefined;
};
const handle = async (message: unknown): Promise<void> => {
	if (running) return;
	running = true;
	const state = message as OfflineShmState;
	try {
		port.postMessage({ status: "started", lastSuccessfulAt: await readLatestSuccess(state) });
		const result = await runOfflineShmBackup(state);
		port.postMessage({ status: result.status, completedAt: result.completedAt });
	} catch (error) {
		// Paths and arbitrary exception messages may contain sensitive user data.
		// Only a bounded OS-style code crosses the frontend notification boundary.
		const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
		const errorCode = typeof code === "string" && /^[A-Z][A-Z0-9_]{0,47}$/.test(code) ? code : "BACKUP_FAILED";
		port.postMessage({ status: "failed", errorCode, lastSuccessfulAt: await readLatestSuccess(state) });
	} finally {
		port.close();
		// Bun only disconnects parentPort on close; exit after queued result messages flush.
		setTimeout(() => process.exit(0), 0);
	}
};
if (inbox) inbox.bind(message => void handle(message));
else port.on("message", message => void handle(message));
