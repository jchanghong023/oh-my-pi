import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { KnowledgeSearchEngine, vectorIndexTopK } from "@oh-my-pi/pi-natives";

// Explicit resource/quality acceptance: bun packages/coding-agent/test/fixtures/knowledge-ann-cost.ts
// Run unchanged in externally constrained low-resource and high-resource environments; this script does not impose limits.
const environment = process.env.OMP_KNOWLEDGE_RESOURCE_LABEL;
assert(environment, "Set OMP_KNOWLEDGE_RESOURCE_LABEL to identify the actual externally constrained environment");
const rows = Number(process.env.OMP_KNOWLEDGE_ANN_ROWS ?? 65536);
const dimensions = Number(process.env.OMP_KNOWLEDGE_ANN_DIMS ?? 128);
assert(Number.isInteger(rows) && rows >= 4096 && rows % 16 === 0, "ANN rows must be a multiple of 16 and >=4096");
assert(Number.isInteger(dimensions) && dimensions >= 8, "ANN dimensions must be >=8");
const k = 64;
const directory = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-ann-cost-"));
const database = path.join(directory, "knowledge.db");
let engine: KnowledgeSearchEngine | undefined;
const start = performance.now();
try {
	engine = new KnowledgeSearchEngine(database, database);
	let state = 0x12345678;
	const vector = () => {
		const output = new Float32Array(dimensions);
		let norm = 0;
		for (let col = 0; col < dimensions; col++) {
			state ^= state << 13;
			state ^= state >>> 17;
			state ^= state << 5;
			output[col] = ((state >>> 0) / 0xffffffff) * 2 - 1;
			norm += output[col]! ** 2;
		}
		for (let col = 0; col < dimensions; col++) output[col] = output[col]! / Math.sqrt(norm);
		return output;
	};
	const buildStarted = performance.now();
	for (const index of ["one", "two"]) {
		const source = path.join(directory, index);
		for (const [file, count] of [
			["selected/evidence.md", rows / 16],
			["outside/decoy.md", (rows * 7) / 16],
		] as const) {
			await Bun.write(
				path.join(source, file),
				Array.from(
					{ length: count },
					(_, ordinal) => `# Evidence ${ordinal}\nANN stored evidence ${ordinal}.\n`,
				).join("\n"),
			);
		}
		const imported = await engine.initDeferred(source, index);
		try {
			await engine.beginVectorImport(imported.importToken, "acceptance-model");
			let after = 0;
			for (;;) {
				const batch = await engine.readVectorImportBatch(imported.importToken, after, 128);
				if (!batch.sections.length) break;
				await engine.writeVectorImportBatch(
					imported.importToken,
					batch.sections.map(section => ({ sectionId: section.sectionId, vector: vector() })),
				);
				if (batch.nextSectionId === undefined) break;
				after = batch.nextSectionId;
			}
			await engine.publishVectorImport(imported.importToken);
			await engine.publishDeferredImport(imported.importToken);
		} catch (error) {
			await engine.rollbackImport(imported.importToken);
			throw error;
		}
		await fs.rm(source, { recursive: true });
	}
	const buildMs = performance.now() - buildStarted;
	engine.close();
	engine = new KnowledgeSearchEngine(database, database);
	const db = new Database(database, { readonly: true });
	const stored = db
		.query(`SELECT v.section_id, v.vector, i.name AS index_name, d.relative_path AS path
		FROM wiki_section_vectors v JOIN sections s ON s.id=v.section_id JOIN documents d ON d.id=s.document_id
		JOIN doc_indexes i ON i.id=s.index_id ORDER BY v.section_id`)
		.all() as Array<{
		section_id: number;
		vector: Uint8Array;
		index_name: string;
		path: string;
	}>;
	db.close();
	assert.equal(stored.length, rows);
	const queries = Array.from({ length: 24 }, vector);
	const quantile = (values: number[], fraction: number) =>
		[...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1]!;
	const groups = [];
	for (const scope of [
		{ name: "unfiltered" },
		{ name: "index", index: "one" },
		{ name: "directory", path: "selected/" },
		{ name: "file", path: "selected/evidence.md" },
	] as const) {
		const index = "index" in scope ? scope.index : undefined;
		const relative = "path" in scope ? scope.path : undefined;
		const selected = stored.filter(
			row =>
				(!index || row.index_name === index) &&
				(!relative || (relative.endsWith("/") ? row.path.startsWith(relative) : row.path === relative)),
		);
		assert(
			selected.length > 256,
			"No quality/performance group may masquerade as ANN via exact small-scope fallback",
		);
		const matrix = new Float32Array(selected.length * dimensions);
		selected.forEach((row, i) => {
			const data = new DataView(row.vector.buffer, row.vector.byteOffset, row.vector.byteLength);
			for (let col = 0; col < dimensions; col++) matrix[i * dimensions + col] = data.getFloat32(col * 4, true);
		});
		const preparing = performance.now();
		const prepared = await engine.prepareHybridSearch(
			"no_lexical_acceptance_match",
			{ index, path: relative },
			"acceptance-model",
		);
		assert("token" in prepared, "A stable corpus must prepare a ranking context");
		assert.deepEqual(prepared.vectorDimensions, [dimensions]);
		const prepareMs = performance.now() - preparing;
		const firstStarted = performance.now();
		await engine.scoreHybridSearch(prepared.token, queries[0]!, k);
		const firstMs = performance.now() - firstStarted;
		const annMs: number[] = [];
		const exactMs: number[] = [];
		const recalls: number[] = [];
		for (const query of queries) {
			const exactStarted = performance.now();
			const exact = vectorIndexTopK(matrix, dimensions, Float64Array.from(query), k);
			exactMs.push(performance.now() - exactStarted);
			const annStarted = performance.now();
			const actual = await engine.scoreHybridSearch(prepared.token, query, k);
			annMs.push(performance.now() - annStarted);
			assert(actual);
			assert.equal(actual.length, Math.min(k, selected.length));
			assert.equal(new Set(actual).size, actual.length);
			const expected = new Set(Array.from(exact.indices, i => selected[i]!.section_id));
			// Frozen random corpus has no intended boundary ties; any exact tie is credited by its measured score.
			const threshold = exact.scores[exact.scores.length - 1]!;
			const allowed = new Set(expected);
			for (const id of actual) {
				const ordinal = selected.findIndex(row => row.section_id === id);
				assert(ordinal >= 0, "Out-of-scope candidates must never consume the result budget");
				if (!expected.has(id)) {
					const score = vectorIndexTopK(
						matrix.subarray(ordinal * dimensions, (ordinal + 1) * dimensions),
						dimensions,
						Float64Array.from(query),
						1,
					).scores[0]!;
					if (Math.abs(score - threshold) <= 1e-7) allowed.add(id);
				}
			}
			recalls.push(actual.filter(id => allowed.has(id)).length / Math.min(k, selected.length));
		}
		groups.push({
			name: scope.name,
			eligible: selected.length,
			prepareMs,
			firstMs,
			recalls,
			meanRecallAtK: recalls.reduce((a, b) => a + b, 0) / recalls.length,
			annP50: quantile(annMs, 0.5),
			annP95: quantile(annMs, 0.95),
			exactP50: quantile(exactMs, 0.5),
			exactP95: quantile(exactMs, 0.95),
		});
	}
	engine.close();
	engine = undefined;
	console.log(
		JSON.stringify(
			{
				environment,
				platform: process.platform,
				arch: process.arch,
				release: os.release(),
				availableParallelism: os.availableParallelism(),
				totalMemory: os.totalmem(),
				rows,
				dimensions,
				k,
				parameters: { connectivity: 32, expansionAdd: 256, expansionSearch: 128, float: "f32" },
				buildMs,
				databaseBytes: (await fs.stat(database)).size,
				peakRssBytes: process.resourceUsage().maxRSS * 1024,
				totalMs: performance.now() - start,
				stage: "native vector retrieval; no model, fulltext, paging, or 500ms floor speed claim",
				groups,
			},
			null,
			2,
		),
	);
	for (const group of groups) {
		assert(group.meanRecallAtK >= 0.99, `${group.name}: mean Recall@${k} below 99%; do not remove failed samples`);
		assert(
			group.annP95 < group.exactP95,
			`${group.name}: hot ANN P95 must beat the same-vector native exact baseline`,
		);
	}
} finally {
	engine?.close();
	await fs.rm(directory, { recursive: true, force: true });
}
