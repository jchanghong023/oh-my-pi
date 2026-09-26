#!/usr/bin/env bun
/** Synthetic benchmark, not company-repository measurements. Run: bun scripts/repo-index-perf.ts [fileCount] [linesPerFile]. */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { grep, GrepOutputMode } from "@oh-my-pi/pi-natives";
import { RepoService } from "../packages/coding-agent/src/repo/service";

const fileCount = Number(process.argv[2] ?? 1_200);
const linesPerFile = Number(process.argv[3] ?? 80);
if (!Number.isSafeInteger(fileCount) || fileCount < 10 || !Number.isSafeInteger(linesPerFile) || linesPerFile < 5) {
	throw new Error("Usage: bun scripts/repo-index-perf.ts [fileCount >= 10] [linesPerFile >= 5]");
}

const temp = await fs.mkdtemp(path.join(os.tmpdir(), "omp-repo-index-perf-"));
const root = path.join(temp, "project");
const agentDir = path.join(temp, "profile");
const sourceDir = path.join(root, "src");
const marker = "uniqueperformancemarker314159";
const miss = "absentperformancemarker271828";
const files = Array.from({ length: fileCount }, (_, index) =>
	path.join(sourceDir, `module_${String(index).padStart(5, "0")}.py`),
);
const targetIndex = Math.floor(fileCount / 2);
const targetPath = `src/${path.basename(files[targetIndex])}`;
const repeats = 5;
const elapsed = async <T>(action: () => Promise<T>): Promise<{ ms: number; result: T }> => {
	const start = performance.now();
	const result = await action();
	return { ms: Number((performance.now() - start).toFixed(3)), result };
};
const directSearch = async (needle: string): Promise<string[]> => {
	const result = await grep({
		pattern: RegExp.escape(needle),
		path: root,
		ignoreCase: true,
		hidden: true,
		gitignore: true,
		mode: GrepOutputMode.FilesWithMatches,
		maxCount: fileCount + 1,
	});
	if (result.limitReached || result.filesSearched !== fileCount)
		throw new Error(`Direct grep did not cover the fixture: ${JSON.stringify(result)}`);
	return result.matches.map(match => match.path.replaceAll("\\", "/"));
};

let service: RepoService | undefined;
try {
	await fs.mkdir(sourceDir, { recursive: true });
	await fs.mkdir(agentDir);
	let textBytes = 0;
	for (let index = 0; index < files.length; index++) {
		const body = [
			`# Deterministic synthetic module ${index}`,
			`class Module${index}:`,
			`    def calculate_${index}(self, payload):`,
			`        return payload + ${index}`,
			...Array.from(
				{ length: linesPerFile - 5 },
				(_, line) => `# index ${index} line ${line} utility_compute_payload`,
			),
			index === targetIndex ? `# ${marker}` : "# no special marker",
			"",
		].join("\n");
		textBytes += Buffer.byteLength(body);
		await Bun.write(files[index], body);
	}
	service = new RepoService({ cwd: root, agentDir });
	const build = await elapsed(() => service!.build());
	if (build.result.fileCount !== fileCount)
		throw new Error(`Expected ${fileCount} indexed files, got ${build.result.fileCount}`);
	// An unchanged full reconcile measures the cost of a complete content fingerprint pass.
	const fullReconcile = await elapsed(() => service!.reconcile());
	await Bun.write(files[targetIndex], `${await Bun.file(files[targetIndex]).text()}# one-file mutation\n`);
	const incremental = await elapsed(async () => {
		service!.markChanged([files[targetIndex]]);
		return service!.search("one-file mutation");
	});
	if (incremental.result.hits.length !== 1 || incremental.result.hits[0]?.path !== targetPath) {
		throw new Error("Known-path update did not publish the changed file");
	}
	if ((await service.status()).lastFullCheck !== fullReconcile.result.lastFullCheck) {
		throw new Error("Known-path update unexpectedly reported a full-scope reconciliation");
	}
	const directHit: number[] = [];
	const directMiss: number[] = [];
	const indexedHit: number[] = [];
	const indexedMiss: number[] = [];
	let directHitPaths: string[] = [];
	let directMissPaths: string[] = [];
	let indexedHitPaths: string[] = [];
	let indexedMissPaths: string[] = [];
	for (let i = 0; i < repeats; i++) {
		const hitDirect = await elapsed(() => directSearch(marker));
		const hitIndexed = await elapsed(() => service!.search(marker));
		const missDirect = await elapsed(() => directSearch(miss));
		const missIndexed = await elapsed(() => service!.search(miss));
		directHit.push(hitDirect.ms);
		indexedHit.push(hitIndexed.ms);
		directMiss.push(missDirect.ms);
		indexedMiss.push(missIndexed.ms);
		directHitPaths = hitDirect.result;
		directMissPaths = missDirect.result;
		indexedHitPaths = hitIndexed.result.hits.map(hit => hit.path);
		indexedMissPaths = missIndexed.result.hits.map(hit => hit.path);
	}
	const equal = (a: string[], b: string[]) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
	if (!equal(directHitPaths, indexedHitPaths) || !equal(directMissPaths, indexedMissPaths)) {
		throw new Error(
			`Index/direct mismatch: ${JSON.stringify({ directHitPaths, indexedHitPaths, directMissPaths, indexedMissPaths })}`,
		);
	}
	// Query with source tree moved outside the indexed root: a successful stored hit
	// proves this search does not depend on reading/enumerating the source tree.
	const inaccessibleSource = path.join(temp, "temporarily-moved-source");
	let indexedWithoutSource = false;
	await fs.rename(sourceDir, inaccessibleSource);
	try {
		indexedWithoutSource = (await service.search(marker)).hits.some(hit => hit.path === targetPath);
	} finally {
		await fs.rename(inaccessibleSource, sourceDir);
	}
	if (!indexedWithoutSource) throw new Error("Indexed query lost its hit while source files were unavailable");
	const dbFiles = (await fs.readdir(agentDir, { recursive: true, withFileTypes: true }))
		.filter(entry => entry.isFile() && (entry.name.endsWith(".db") || entry.name.endsWith(".db-wal")))
		.map(entry => path.join(entry.parentPath, entry.name));
	if (dbFiles.length === 0) throw new Error("Indexed database file was not written");
	const dbBytes = (await Promise.all(dbFiles.map(async file => (await fs.stat(file)).size))).reduce(
		(a, b) => a + b,
		0,
	);
	console.log(
		JSON.stringify(
			{
				fixture: "deterministic synthetic Python files (not a company repository)",
				directSearchEngine: "production native grep, case-insensitive literal pattern, filesWithMatches",
				environment: {
					platform: process.platform,
					arch: process.arch,
					bun: Bun.version,
					cpus: os.cpus().length,
					cpuModel: os.cpus()[0]?.model,
				},
				fileCount,
				linesPerFile,
				initialTextBytes: textBytes,
				databaseAndWalBytes: dbBytes,
				buildMs: build.ms,
				incrementalKnownPathMs: incremental.ms,
				fullReconcileMs: fullReconcile.ms,
				directHitMs: { first: directHit[0], repeated: directHit.slice(1) },
				indexedHitMs: { first: indexedHit[0], repeated: indexedHit.slice(1) },
				directMissMs: { first: directMiss[0], repeated: directMiss.slice(1) },
				indexedMissMs: { first: indexedMiss[0], repeated: indexedMiss.slice(1) },
				hitPathsEqual: true,
				missPathsEqual: true,
				indexedHitWithoutSourceTree: indexedWithoutSource,
			},
			null,
			2,
		),
	);
} finally {
	service?.close();
	await fs.rm(temp, { recursive: true, force: true });
}
