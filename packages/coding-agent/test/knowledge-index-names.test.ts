import { expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { KnowledgeSearchEngine } from "@oh-my-pi/pi-natives";

it("publishes deferred indexes under their validated name", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wiki-index-name-"));
	const source = path.join(directory, "source");
	await fs.mkdir(source);
	await Bun.write(path.join(source, "document.md"), "# Evidence\nDeferred index name.\n");
	const database = path.join(directory, "knowledge.db");
	const engine = new KnowledgeSearchEngine(database, database);
	try {
		const imported = await engine.initDeferred(source, "  manual  ");
		expect(imported.index.name).toBe("manual");
		await engine.publishDeferredImport(imported.importToken);
		expect(engine.list().map(index => index.name)).toEqual(["manual"]);
		await expect(engine.initDeferred(source, "manual")).rejects.toThrow(/already exists/i);
		engine.remove("manual");
		expect(engine.list()).toEqual([]);
	} finally {
		engine.close();
		await fs.rm(directory, { recursive: true, force: true });
	}
});
