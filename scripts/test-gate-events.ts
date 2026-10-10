import * as fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import type { FSWatcher } from "node:fs";
import { watch } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

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
