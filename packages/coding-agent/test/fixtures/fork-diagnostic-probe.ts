import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, getLogsDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../../src/config/settings";
import { KnowledgeIndexEngine } from "../../src/knowledge/engine";
import { KnowledgeService } from "../../src/knowledge/service";
import { KnowledgeSearchTool } from "../../src/tools/knowledge-search";

const [mode, root, canary] = process.argv.slice(2);
if (!root || !canary || !process.env.OMP_CONFIG_ROOT) throw new Error("Expected an isolated diagnostic fixture");

async function docsProbe() {
	// The interrupted-build fixture observes raw SQL at an exact FTS commit boundary.
	const service =
		mode === "wiki"
			? new KnowledgeService({ agentDir: getAgentDir(), cwd: root })
			: new KnowledgeIndexEngine({ agentDir: getAgentDir(), cwd: root });
	try {
		if (mode === "wiki") {
			const cleanups: Array<() => void | Promise<void>> = [];
			const tool = new KnowledgeSearchTool({
				cwd: root,
				hasUI: false,
				settings: Settings.isolated(),
				getSessionFile: () => null,
				getSessionSpawns: () => null,
				registerDisposeCallback: callback => {
					cleanups.push(callback);
				},
			});
			try {
				const result = await tool.execute("diagnostic-wiki", { query: `${canary}QUERY` });
				return {
					indexes: await service.list(),
					text: result.content.map(part => (part.type === "text" ? part.text : "")).join("\n"),
				};
			} finally {
				for (const cleanup of cleanups) await cleanup();
				await tool.dispose();
			}
		}
		const documents = path.join(root, "interrupted-documents");
		fs.mkdirSync(documents);
		fs.writeFileSync(path.join(documents, "first.md"), `# Evidence\n${canary}ROLLBACKBODY\n`);
		fs.writeFileSync(path.join(documents, "second.md"), `# Evidence\n${canary}ROLLBACKBODY\n`);
		const before = await service.list();
		const controller = new AbortController();
		let visibleDuringBuild: unknown;
		let failure: string | undefined;
		try {
			await service.init(documents, `${canary}${mode}`, {
				signal: controller.signal,
				onProgress(progress) {
					if (progress.phase !== "fts" || progress.completed !== 1) return;
					visibleDuringBuild = (service as KnowledgeIndexEngine).list();
					if (mode === "cancel") controller.abort();
					else {
						// Remove only the unread file, after one real FTS commit, without relying on scan order.
						for (const name of fs.readdirSync(documents)) {
							if (name !== progress.currentPath) fs.unlinkSync(path.join(documents, name));
						}
					}
				},
			});
		} catch (error) {
			failure = error instanceof Error ? error.name : typeof error;
		}
		const db = new Database(service.databasePath, { strict: true, readonly: true });
		try {
			const hidden = db.query("SELECT COUNT(*) AS count FROM doc_indexes WHERE name GLOB '__building__*'").get();
			return { before, visibleDuringBuild, after: await service.list(), hidden, failure };
		} finally {
			db.close();
		}
	} finally {
		if (service instanceof KnowledgeService) await service.close();
		else service.close();
	}
}

async function boundariesProbe() {
	const service = new KnowledgeService({ agentDir: getAgentDir(), cwd: root });
	let listFailure: string | undefined;
	try {
		await service.list();
		const db = new Database(service.databasePath, { strict: true });
		try {
			db.exec("PRAGMA foreign_keys=ON");
			db.exec("DROP TABLE doc_indexes");
		} finally {
			db.close();
		}
		try {
			await service.list();
		} catch (error) {
			listFailure = error instanceof Error ? error.name : typeof error;
		}
	} finally {
		await service.close();
	}
	return { listFailure };
}

const result = mode === "boundaries" ? await boundariesProbe() : await docsProbe();
process.stdout.write(JSON.stringify({ logsDir: getLogsDir(), pid: process.pid, ...result }));
