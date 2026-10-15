import { expect, it } from "bun:test";
import { once } from "node:events";
import { rmdirSync, symlinkSync, unlinkSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Worker } from "node:worker_threads";
import { WikiSearchEngine } from "@oh-my-pi/pi-natives";
import type { Settings } from "../src/config/settings";
import { DocsSearchEngine } from "../src/docs/engine";
import { WikiTool } from "../src/tools/wiki";

it("returns indented code followed by a rule instead of discarding it as a converter heading", async () => {
	const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "docs-indented-setext-"));
	const root = path.join(temporary, "source");
	const agentDir = path.join(temporary, "agent");
	const source = "# Notes\n\n    Cell\n----\n";
	try {
		await Bun.write(path.join(root, "guide.md"), source);
		const service = new DocsSearchEngine({ agentDir, cwd: root });
		try {
			await service.init(".", "manual");
		} finally {
			service.close();
		}
		await fs.rm(root, { recursive: true });
		const tool = new WikiTool({
			cwd: root,
			hasUI: false,
			settings: { getAgentDir: () => agentDir } as unknown as Settings,
			getSessionFile: () => null,
			getSessionSpawns: () => null,
		});
		try {
			const result = await tool.execute("indented-code", { query: "Cell" });
			const text = result.content.map(item => (item.type === "text" ? item.text : "")).join("\n");
			expect(text).toContain(source);
			expect(text).toContain("guide.md:1-4");
			expect(text).not.toContain("heading only");
		} finally {
			await tool.dispose();
		}
	} finally {
		await fs.rm(temporary, { recursive: true, force: true });
	}
});

it("does not recover an active replacement database after the import lease callback retargets a profile", async () => {
	const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "docs-lease-replacement-"));
	const root = path.join(temporary, "source");
	const originalDir = path.join(temporary, "original");
	const replacementDir = path.join(temporary, "replacement");
	const alias = path.join(temporary, "agent");
	const gate = new Int32Array(new SharedArrayBuffer(4));
	let service: WikiSearchEngine | undefined;
	let worker: Worker | undefined;
	try {
		await fs.mkdir(originalDir);
		await fs.mkdir(replacementDir);
		await Bun.write(path.join(root, "a.md"), "# First\nleasefirstbeacon\n");
		await Bun.write(path.join(root, "b.md"), "# Second\nleasesecondbeacon\n");
		const aliasType = process.platform === "win32" ? "junction" : "dir";
		symlinkSync(originalDir, alias, aliasType);
		const databasePath = path.join(alias, "docs.db");
		service = new WikiSearchEngine(databasePath, databasePath);
		const replacementPath = path.join(replacementDir, "docs.db");
		worker = new Worker(
			`
			import { parentPort, workerData } from "node:worker_threads";
			import { WikiSearchEngine } from ${JSON.stringify(import.meta.resolve("@oh-my-pi/pi-natives"))};
			const service = new WikiSearchEngine(workerData.databasePath, workerData.databasePath);
			const gate = new Int32Array(workerData.gate);
			service.init(workerData.root, "active", progress => {
				if (progress.phase !== "fts" || progress.completed !== 1) return;
				parentPort.postMessage("paused");
				if (Atomics.wait(gate, 0, 0, 10000) === "timed-out") throw new Error("Import barrier timed out");
			}).then(
				result => parentPort.postMessage({ processed: result.processed }),
				error => parentPort.postMessage({ error: error.message }),
			).finally(() => service.close());
			`,
			{ eval: true, workerData: { databasePath: replacementPath, root, gate: gate.buffer } },
		);
		const [paused] = await once(worker, "message");
		expect(paused).toBe("paused");
		const finished = once(worker, "message");
		let swapped = false;
		await expect(
			service.init(root, "intruder", undefined, undefined, event => {
				if (event.message !== "docs.init.lock.completed") return;
				if (process.platform === "win32") rmdirSync(alias);
				else unlinkSync(alias);
				symlinkSync(replacementDir, alias, aliasType);
				swapped = true;
			}),
		).rejects.toThrow("Documentation database changed during document indexing");
		expect(swapped).toBe(true);
		Atomics.store(gate, 0, 1);
		Atomics.notify(gate, 0);
		const [result] = await finished;
		expect(result).toEqual({ processed: 2 });
		expect(service.list().map(index => ({ name: index.name, documents: index.documentCount }))).toEqual([
			{ name: "active", documents: 2 },
		]);
		expect(service.searchWindow("leasefirstbeacon", {}).result.sections).toHaveLength(1);
		expect(service.searchWindow("leasesecondbeacon", {}).result.sections).toHaveLength(1);
	} finally {
		Atomics.store(gate, 0, 1);
		Atomics.notify(gate, 0);
		await worker?.terminate();
		service?.close();
		await fs.rm(temporary, { recursive: true, force: true });
	}
});
