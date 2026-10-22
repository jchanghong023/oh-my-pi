import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type { Readable } from "node:stream";
import { getAgentDbPath, getSessionsDirPath } from "@oh-my-pi/pi-utils/dirs";
import { AgentStorage } from "../../session/agent-storage";
import { HistoryStorage } from "../../session/history-storage";
import { closeSessionIndex } from "../../session/session-index";
import { LegacyProtocol } from "./schema";

type WriteFrame = (frame: unknown) => Promise<void>;

/** One attempt reports only observed storage work; model discovery is deliberately separate. */
export class ZCodeStorageStartup {
	readonly attemptId = randomUUID();
	readonly resourcePath = path.resolve(path.dirname(getSessionsDirPath()));
	readonly databaseId = createHash("sha256").update(this.resourcePath).digest("hex");
	#sequence = 0;
	#started = performance.now();
	#failed = false;
	constructor(readonly write: WriteFrame) {}
	async report(phase: "checking" | "ready" | "failed", error?: unknown): Promise<void> {
		if (phase === "failed" && this.#failed) return;
		if (phase === "failed") this.#failed = true;
		const cause = error as { code?: string; kind?: string; errcode?: number } | undefined;
		const errorCode =
			cause?.kind === "transport_closed" || cause?.kind === "startup_status_timeout"
				? cause.kind
				: cause?.code === "ENOSPC"
					? "storage_full"
					: cause?.code === "EACCES" || cause?.code === "EPERM"
						? "permission_denied"
						: cause?.code === "ENOMEM"
							? "out_of_memory"
							: cause?.code === "EIO"
								? "io_error"
								: "open_failed";
		const params = LegacyProtocol.zcodeStorageStartupStateSchema.parse({
			schemaVersion: 1,
			attemptId: this.attemptId,
			sequence: ++this.#sequence,
			databaseId: this.databaseId,
			databaseKind: "session",
			phase,
			elapsedMs: performance.now() - this.#started,
			...(error ? { errorCode } : {}),
		});
		await this.write({ method: "startup/storageState", params });
	}
	async open(signal?: AbortSignal): Promise<void> {
		await this.report("checking");
		try {
			signal?.throwIfAborted();
			await fsp.mkdir(this.resourcePath, { recursive: true });
			await fsp.access(await fsp.realpath(this.resourcePath), fs.constants.R_OK | fs.constants.W_OK);
			await fsp.mkdir(getSessionsDirPath(), { recursive: true });
			await AgentStorage.open(getAgentDbPath());
			HistoryStorage.open();
			signal?.throwIfAborted();
			await this.report("ready");
		} catch (error) {
			await this.report("failed", error).catch(() => {});
			throw error;
		}
	}
	close(): void {
		closeSessionIndex();
		HistoryStorage.close();
		AgentStorage.close();
	}
}

export async function prepareZCodeStorage(input: Readable, write: WriteFrame): Promise<void> {
	const startup = new ZCodeStorageStartup(write);
	let buffer = Buffer.alloc(0);
	let confirmed = false;
	const controller = new AbortController();
	const { promise: acknowledgement, resolve, reject } = Promise.withResolvers<boolean>();
	const fail = (message: string, kind: string) => {
		const error = Object.assign(new Error(message), { kind });
		controller.abort(error);
		reject(error);
	};
	const timer = setTimeout(() => fail("Storage observation handshake timed out", "startup_status_timeout"), 30_000);
	const onData = (chunk: Buffer) => {
		if (confirmed) {
			fail("Unexpected storage preparation input", "transport_closed");
			return;
		}
		if (buffer.length + chunk.length > 1024) {
			fail("Invalid storage acknowledgement", "transport_closed");
			return;
		}
		buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
		const lf = buffer.indexOf(10);
		if (lf < 0) return;
		try {
			const ack = LegacyProtocol.zcodeStoragePathReadySchema.parse(
				JSON.parse(buffer.subarray(0, lf).toString("utf8")),
			);
			if (buffer.subarray(lf + 1).length) throw new Error("Unexpected storage preparation input");
			confirmed = true;
			resolve(ack.reuse ?? false);
		} catch (error) {
			reject(error);
		}
	};
	const onEnd = () => fail("Storage preparation owner closed", "transport_closed");
	input.on("data", onData);
	input.once("end", onEnd);
	input.once("error", reject);
	const cleanup = () => {
		input.off("data", onData);
		input.off("end", onEnd);
		input.off("error", reject);
	};
	void acknowledgement.catch(() => {});
	try {
		await write({ method: "startup/storagePath", params: { path: startup.resourcePath } });
		const reuse = await acknowledgement;
		clearTimeout(timer);
		if (reuse) await fsp.access(startup.resourcePath, fs.constants.R_OK | fs.constants.W_OK);
		else await startup.open(controller.signal);
		startup.close();
		controller.signal.throwIfAborted();
		await write({ method: "startup/storagePrepared", params: {} });
	} catch (error) {
		await startup.report("failed", error).catch(() => {});
		throw error;
	} finally {
		clearTimeout(timer);
		cleanup();
		input.pause();
		startup.close();
	}
}
