import { expect, it, vi } from "bun:test";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createGateEventRelay, type GateEventRelay } from "./test-gate-events";

it("delivers external BEP completion while its writer remains open and file notifications are absent", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-bep-relay-"));
	const filename = path.join(directory, "events.jsonl");
	await fs.writeFile(filename, "");
	const delivered = Promise.withResolvers<string>();
	// This platform-I/O integration awaits real delivery; the deadline only bounds a missing notification.
	const deadline = setTimeout(() => delivered.reject(new Error("BEP completion was not delivered")), 2_000);
	const realWatch = fsSync.watch;
	const watch = vi.spyOn(fsSync, "watch").mockImplementation(((...args: Parameters<typeof fsSync.watch>) => {
		const watcher = realWatch(...args);
		watcher.close();
		return watcher;
	}) as typeof fsSync.watch);
	let relay: GateEventRelay | undefined;
	const writer = await fs.open(filename, "a");
	try {
		relay = await createGateEventRelay(text => delivered.resolve(text), filename);
		watch.mockRestore();
		const completion = `${JSON.stringify({ id: { targetCompleted: { label: "//:static" } }, completed: { success: true } })}\n`;
		await writer.write(completion);
		expect(await delivered.promise).toBe(completion);
	} finally {
		watch.mockRestore();
		clearTimeout(deadline);
		await writer.close();
		await relay?.close();
		await fs.rm(directory, { recursive: true, force: true });
	}
});
