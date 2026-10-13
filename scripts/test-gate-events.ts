import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import type { FSWatcher } from "node:fs";
import { appendFileSync, watch } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { gateClockNanoseconds } from "./test-gate-clock";

export const GATE_EVENT_PREFIX = "OMP_GATE_EVENT ";

/** Emit activity without loading workspace packages; standalone build scripts share this protocol. */
export function emitEvent(
	token: string | undefined,
	id: string,
	kind: "charged" | "compile" | "idle",
	env: Record<string, string | undefined> = process.env,
): void {
	if (!token) return;
	const line = `${GATE_EVENT_PREFIX}${token} ${JSON.stringify({ id, kind, at: gateClockNanoseconds().toString(), clock: env.OMP_GATE_CLOCK_TOKEN })}\n`;
	if (env.OMP_GATE_EVENT_FILE) appendFileSync(env.OMP_GATE_EVENT_FILE, line);
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

export interface GateEventRelay {
	path: string;
	flush(): Promise<void>;
	close(): Promise<void>;
}

/** File relay keeps compiler events observable when a harness captures compiler stderr. */
export async function createGateEventRelay(receive: (text: string) => void): Promise<GateEventRelay> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gate-events-"));
	const filename = path.join(directory, "activity.jsonl");
	let file: FileHandle;
	try {
		await fs.writeFile(filename, "");
		file = await fs.open(filename, "r");
	} catch (error) {
		await fs.rm(directory, { recursive: true, force: true });
		throw error;
	}
	let position = 0;
	let requested = false;
	let draining: Promise<void> | undefined;
	let failure: unknown;
	let closed = false;
	const decoder = new TextDecoder();
	const drain = (): Promise<void> => {
		requested = true;
		if (!draining) {
			draining = (async () => {
				do {
					requested = false;
					const size = (await file.stat()).size;
					if (size > position) {
						const bytes = Buffer.allocUnsafe(size - position);
						const result = await file.read(bytes, 0, bytes.length, position);
						position += result.bytesRead;
						if (position < size) requested = true;
						receive(decoder.decode(bytes.subarray(0, result.bytesRead), { stream: true }));
					}
				} while (requested);
			})()
				.catch(error => {
					failure = error;
				})
				.finally(() => {
					draining = undefined;
				});
		}
		return draining;
	};
	let watcher: FSWatcher;
	try {
		watcher = watch(filename, { persistent: false }, () => {
			void drain();
		});
	} catch (error) {
		await file.close();
		await fs.rm(directory, { recursive: true, force: true });
		throw error;
	}
	watcher.on("error", error => {
		failure = error;
	});
	return {
		path: filename,
		async flush() {
			if (closed) return;
			await drain();
			if (failure) throw failure;
		},
		async close() {
			watcher.close();
			try {
				await drain();
				if (failure) throw failure;
			} finally {
				closed = true;
				await file.close();
				await fs.rm(directory, { recursive: true, force: true });
			}
		},
	};
}
