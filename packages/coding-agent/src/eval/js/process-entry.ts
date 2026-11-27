import * as fs from "node:fs";
import * as path from "node:path";
import { serialize } from "bun:jsc";
import { type RejectionInterceptor, WorkerCore } from "./worker-core";
import {
	JS_EVAL_OUTBOX_ENV,
	type ProcessWorkerOutbound,
	type WorkerInbound,
	type WorkerOutbound,
} from "./worker-protocol";

/** Start the JavaScript evaluator inside a subprocess IPC transport. */
export function startJsEvalProcess(
	transport: {
		send(message: ProcessWorkerOutbound): void;
		onMessage(handler: (message: WorkerInbound) => void): () => void;
	},
	interceptUnhandledRejections: RejectionInterceptor,
): void {
	let outbox = process.env[JS_EVAL_OUTBOX_ENV];
	delete process.env[JS_EVAL_OUTBOX_ENV];
	let sequence = 0;
	new WorkerCore(
		{
			send: (message: WorkerOutbound) => {
				if (!outbox || (message.type !== "text" && message.type !== "display")) {
					transport.send(message);
					return;
				}
				// A killed process can lose its IPC queue. Publish each complete record
				// first, without consulting the eval realm's JSON hooks.
				const id = sequence + 1;
				const filename = path.join(outbox, `${id}.bin`);
				const pending = `${filename}.tmp`;
				try {
					fs.writeFileSync(pending, serialize(message, { binaryType: "nodebuffer" }));
					fs.renameSync(pending, filename);
				} catch {
					// Keep the published prefix recoverable. Send this and all later
					// output over IPC so it can't fail the cell or leave sequence gaps.
					outbox = undefined;
					transport.send(message);
					return;
				}
				sequence = id;
				transport.send({ type: "output-ready", sequence: id });
			},
			onMessage: handler => transport.onMessage(handler),
			// The parent owns process lifetime and kills the subprocess after the
			// WorkerCore `closed` acknowledgement has crossed IPC.
			close: () => {},
		},
		{
			mode: "isolated",
			// The subprocess inherits the agent's cwd (or the package root under
			// the `bun test` fallback of `resolveWorkerSpawnCmd`); mirror the
			// session cwd so cell code using relative paths or spawning children
			// resolves against the session's project. Worker threads cannot pass
			// this — `process.chdir` is unavailable there.
			chdir: cwd => process.chdir(cwd),
			interceptUnhandledRejections,
		},
	);
}
