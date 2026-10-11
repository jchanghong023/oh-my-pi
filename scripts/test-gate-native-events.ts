import { GateCommandError } from "./test-gate-runtime";

/** Consume only nextest's captured libtest-json-plus stdout, never raw test output. */
export async function forwardNextestOutput(
	stream: ReadableStream<Uint8Array>,
	writeOutput: (bytes: Uint8Array) => void | Promise<void>,
	onFailure: (error: GateCommandError) => void,
): Promise<void> {
	const decoder = new TextDecoder();
	let pending = "";
	let reported = false;
	const observe = (line: string) => {
		if (reported || !line.startsWith("{")) return;
		let event: unknown;
		try {
			event = JSON.parse(line);
		} catch {
			return;
		}
		if (typeof event !== "object" || event === null) return;
		const result = event as Record<string, unknown>;
		if (result.type !== "test" || result.event !== "failed" || typeof result.name !== "string") return;
		reported = true;
		// nextest_metadata::NextestExitCode::TEST_RUN_FAILED, not a guessed test-process exit.
		onFailure(new GateCommandError(`Rust test failed: ${result.name}`, 100));
	};
	const reader = stream.getReader();
	try {
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			await writeOutput(value);
			pending += decoder.decode(value, { stream: true });
			let start = 0;
			for (;;) {
				const end = pending.indexOf("\n", start);
				if (end === -1) break;
				observe(pending.slice(start, end));
				start = end + 1;
			}
			pending = pending.slice(start);
		}
		observe(pending + decoder.decode());
	} finally {
		reader.releaseLock();
	}
}
