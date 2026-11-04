import { Database } from "bun:sqlite";
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

// Unicode White_Space is trimmed before the embedded-control validation.
it("trims Unicode next-line whitespace before publishing the validated name", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-unicode-name-"));
	const source = path.join(directory, "source");
	await Bun.write(path.join(source, "document.md"), "# Evidence\nUnicode name evidence.\n");
	const database = path.join(directory, "knowledge.db");
	const engine = new KnowledgeSearchEngine(database, database);
	try {
		const imported = await engine.initDeferred(source, "\u0085manual\u0085");
		expect(imported.index.name).toBe("manual");
		expect(engine.list()).toEqual([]);
		await engine.publishDeferredImport(imported.importToken);
		expect(engine.list().map(index => index.name)).toEqual(["manual"]);
		expect(engine.searchWindow("Unicode", {}).result.sections[0]).toMatchObject({
			index: "manual",
			path: "document.md",
			text: "# Evidence\nUnicode name evidence.\n",
		});
	} finally {
		engine.close();
		await fs.rm(directory, { recursive: true, force: true });
	}
});

// Invalid names must leave neither published records nor hidden build residue.
it("rejects empty, over-scalar-limit, control and reserved names before creating a build", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-invalid-name-"));
	const source = path.join(directory, "source");
	await Bun.write(path.join(source, "document.md"), "# Evidence\nRetained name evidence.\n");
	const database = path.join(directory, "knowledge.db");
	const engine = new KnowledgeSearchEngine(database, database);
	try {
		for (const [name, reason] of [
			["\u2003\u3000", /must not be empty/i],
			["a".repeat(65), /64 Unicode scalar/i],
			["😀".repeat(65), /64 Unicode scalar/i],
			["a\u0000b", /control/i],
			["a\u007fb", /control/i],
			["a\u0085b", /control/i],
			["a\u009fb", /control/i],
			[" \u3000__building__reserved\u3000 ", /reserved prefix/i],
		] as const) {
			await expect(engine.initDeferred(source, name)).rejects.toThrow(reason);
			expect(engine.list()).toEqual([]);
			const db = new Database(database, { readonly: true });
			try {
				expect(db.query("SELECT count(*) AS count FROM doc_indexes").get()).toEqual({ count: 0 });
			} finally {
				db.close();
			}
		}
		const imported = await engine.initDeferred(source, `\u2003${"😀".repeat(64)}\u3000`);
		expect(imported.index.name).toBe("😀".repeat(64));
		await engine.publishDeferredImport(imported.importToken);
		expect(engine.list().map(index => index.name)).toEqual(["😀".repeat(64)]);
		const db = new Database(database, { readonly: true });
		try {
			expect(db.query("SELECT count(*) AS count FROM doc_indexes").get()).toEqual({ count: 1 });
		} finally {
			db.close();
		}
	} finally {
		engine.close();
		await fs.rm(directory, { recursive: true, force: true });
	}
});
