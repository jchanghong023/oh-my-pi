import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { KnowledgeSearchEngine, type KnowledgeToolPage } from "@oh-my-pi/pi-natives";
import { KnowledgeService } from "../../src/knowledge/service";

// Explicit external acceptance, not a normal .test.ts suite and never a skipped test.
// OMP_KNOWLEDGE_ACCEPTANCE_CONFIG names a real config.yml with an explicitly trusted embedding endpoint.
const config = process.env.OMP_KNOWLEDGE_ACCEPTANCE_CONFIG;
assert(config, "Set OMP_KNOWLEDGE_ACCEPTANCE_CONFIG to the real model config.yml; no model is installed or guessed");
const corpus = {
	"repair.md":
		"# Memory repair\nBuilt-in self-test identifies defective SRAM rows. Redundant spare rows replace failing addresses.\n",
	"checkpoint.md":
		"# Checkpoint recovery\nA crashed worker resumes from the last durable checkpoint rather than repeating completed jobs.\n",
	"invalidation.md":
		"# Cache invalidation\nInvalidate cached records after the authoritative database changes to prevent serving stale values.\n",
	"scan.md":
		"# Digital scan chain\nShift test patterns through scan flip-flops and capture chip responses to detect logic manufacturing faults.\n",
	"thermal.md":
		"# Junction temperature\nA silicon thermal sensor measures die temperature so firmware can throttle the processor before overheating.\n",
	"deadlock.md":
		"# Lock ordering\nAcquire shared mutexes in a consistent order to avoid circular waits between concurrent threads.\n",
	"lunch.md": "# Lunch menu\nRepair the cafeteria menu by replacing a missing lunch entry with a sandwich.\n",
	"scanner.md":
		"# Document scanner\nScan paper pages with an optical scanner and save the resulting images as PDF attachments.\n",
	"layout.md":
		"# Cache layout\nThe processor cache has physically adjacent SRAM banks and a set-associative address layout.\n",
	"cooking.md": "# Cooking temperature\nMeasure the oven temperature and reduce the heat before the bread burns.\n",
	"door.md":
		"# Door locks\nReplace a damaged mechanical door lock and issue a new key to the building administrator.\n",
};
const queries = [
	{
		group: "paraphrase",
		query: "How can a failed worker continue without redoing finished work?",
		relevant: "checkpoint.md",
	},
	{ group: "paraphrase", query: "How do spare memory rows compensate for defective cells?", relevant: "repair.md" },
	{ group: "cross-language", query: "数据库更新以后怎样避免继续提供过期的缓存记录？", relevant: "invalidation.md" },
	{ group: "cross-language", query: "多个线程循环等待互斥锁时，应按什么顺序获取锁？", relevant: "deadlock.md" },
	{
		group: "ambiguous-terminology",
		query: "How does shifting test patterns identify manufacturing faults in digital logic rather than scan paper?",
		relevant: "scan.md",
	},
	{
		group: "ambiguous-terminology",
		query: "How does an on-chip thermal sensor prevent processor overheating rather than control an oven?",
		relevant: "thermal.md",
	},
] as const;
interface QueryMeasurement {
	id: number;
	group: (typeof queries)[number]["group"];
	fulltextRecallAt3: number;
	hybridRecallAt3: number;
	fulltextReciprocalRank: number;
	hybridReciprocalRank: number;
	reranked: boolean;
}

const directory = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-real-quality-"));
const agentDir = path.join(directory, "agent");
const source = path.join(directory, "source");
let service: KnowledgeService | undefined;
let baseline: KnowledgeSearchEngine | undefined;
try {
	await fs.mkdir(agentDir);
	await fs.copyFile(config, path.join(agentDir, "config.yml"));
	for (const [name, text] of Object.entries(corpus)) await Bun.write(path.join(source, name), text);
	service = new KnowledgeService({ agentDir, cwd: directory });
	const started = performance.now();
	const imported = await service.init(source, "evaluation");
	assert.equal(
		imported.vectorStatus,
		"ready",
		"The real configured model and persistent vector index must both be ready",
	);
	const importMs = performance.now() - started;
	await fs.rm(source, { recursive: true });
	baseline = new KnowledgeSearchEngine(service.databasePath, service.databasePath);
	const measurements: QueryMeasurement[] = [];
	for (const [id, entry] of queries.entries()) {
		const fulltext = baseline.searchWindow(entry.query, { limit: 3 }).result;
		const actual: KnowledgeToolPage = await service.searchKnowledge(entry.query);
		assert.match(actual.text, /retrieval:\s*hybrid/i);
		for (const hit of actual.result.sections) {
			const original = corpus[hit.path as keyof typeof corpus];
			assert.equal(hit.text, original);
			assert.equal(hit.index, "evaluation");
			assert.equal(hit.documentHash, new Bun.CryptoHasher("sha256").update(original).digest("hex"));
		}
		const hybridPaths: string[] = [];
		let page: KnowledgeToolPage = actual;
		while (hybridPaths.length < 3) {
			hybridPaths.push(...page.result.sections.map(hit => hit.path));
			if (!page.result.cursor || hybridPaths.length >= 3) break;
			page = await service.searchKnowledge(entry.query, { cursor: page.result.cursor });
		}
		const rank = (paths: string[]) => paths.slice(0, 3).indexOf(entry.relevant) + 1;
		const lexicalRank = rank(fulltext.sections.map(hit => hit.path));
		const hybridRank = rank(hybridPaths);
		measurements.push({
			id,
			group: entry.group,
			fulltextRecallAt3: Number(lexicalRank > 0),
			hybridRecallAt3: Number(hybridRank > 0),
			fulltextReciprocalRank: lexicalRank ? 1 / lexicalRank : 0,
			hybridReciprocalRank: hybridRank ? 1 / hybridRank : 0,
			reranked: /reranked:\s*yes/i.test(actual.text),
		});
	}
	const groups = [...new Set(queries.map(entry => entry.group))].map(group => {
		const rows = measurements.filter(row => row.group === group);
		const mean = (
			field: "fulltextRecallAt3" | "hybridRecallAt3" | "fulltextReciprocalRank" | "hybridReciprocalRank",
		) => rows.reduce((sum, row) => sum + row[field], 0) / rows.length;
		return {
			group,
			queries: rows.length,
			fulltextRecallAt3: mean("fulltextRecallAt3"),
			hybridRecallAt3: mean("hybridRecallAt3"),
			fulltextMRR: mean("fulltextReciprocalRank"),
			hybridMRR: mean("hybridReciprocalRank"),
		};
	});
	console.log(
		JSON.stringify({ corpusDocuments: Object.keys(corpus).length, k: 3, importMs, measurements, groups }, null, 2),
	);
	for (const group of groups)
		assert.equal(group.hybridRecallAt3, 1, `Missing annotated evidence in ${group.group}; retain all failed samples`);
} finally {
	baseline?.close();
	await service?.close();
	await fs.rm(directory, { recursive: true, force: true });
}
