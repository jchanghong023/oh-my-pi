import * as path from "node:path";
import { $ } from "bun";

const TYPESCRIPT_PATHS = ["*.ts", "*.tsx", "*.mts", "*.cts"];
const MAX_COMMAND_PATH_CHARS = 7_000;
const OXFMT_PATTERNS = [
	"packages/*/src/**/*.{ts,tsx}",
	"packages/*/{test,bench,examples,scripts}/**/*.ts",
	"packages/*/*.ts",
	"scripts/**/*.ts",
];
const OXFMT_GLOBS = OXFMT_PATTERNS.map(pattern => new Bun.Glob(pattern));
const repoRoot = path.resolve(import.meta.dir, "..");

async function listGitPaths(args: string[]): Promise<string[]> {
	const result = await $`git ${args}`.cwd(repoRoot).quiet().nothrow();
	if (result.exitCode !== 0) {
		throw new Error(result.stderr.toString().trim() || `git ${args.join(" ")} failed`);
	}
	return result
		.text()
		.split("\0")
		.filter(p => p.length > 0);
}

function chunkPaths(paths: readonly string[]): string[][] {
	const chunks: string[][] = [];
	let chunk: string[] = [];
	let chars = 0;
	for (const filePath of paths) {
		const quotedLength = filePath.length + 3;
		if (chunk.length > 0 && chars + quotedLength > MAX_COMMAND_PATH_CHARS) {
			chunks.push(chunk);
			chunk = [];
			chars = 0;
		}
		chunk.push(filePath);
		chars += quotedLength;
	}
	if (chunk.length > 0) chunks.push(chunk);
	return chunks;
}
async function main(): Promise<number> {
	const [trackedPaths, untrackedPaths] = await Promise.all([
		listGitPaths(["diff", "--name-only", "-z", "--diff-filter=ACMRT", "HEAD", "--", ...TYPESCRIPT_PATHS]),
		listGitPaths(["ls-files", "--others", "--exclude-standard", "-z", "--", ...TYPESCRIPT_PATHS]),
	]);
	const allPaths = [...new Set([...trackedPaths, ...untrackedPaths])].sort();

	if (allPaths.length === 0) {
		console.log("fastcheck: no locally modified TypeScript files");
		return 0;
	}

	console.log(`fastcheck: linting ${allPaths.length} locally modified TypeScript file(s):`);
	for (const p of allPaths) console.log(`  ${p}`);
	for (const paths of chunkPaths(allPaths)) {
		const lintResult = await $`oxlint ${paths}`.cwd(repoRoot).nothrow();
		if (lintResult.exitCode !== 0) return lintResult.exitCode;
	}

	const formatPaths = allPaths.filter(filePath => OXFMT_GLOBS.some(glob => glob.match(filePath)));
	for (const p of allPaths) {
		if (!OXFMT_GLOBS.some(glob => glob.match(p))) {
			console.log(`skipping ${p} (outside root oxfmt input patterns)`);
		}
	}
	if (formatPaths.length === 0) {
		console.log("fastcheck: no root-oxfmt-managed files among locally modified TypeScript files");
		return 0;
	}

	console.log(`fastcheck: checking format for ${formatPaths.length} file(s):`);
	for (const p of formatPaths) console.log(`  ${p}`);
	for (const paths of chunkPaths(formatPaths)) {
		const formatResult = await $`oxfmt --check ${paths}`.cwd(repoRoot).nothrow();
		if (formatResult.exitCode !== 0) return formatResult.exitCode;
	}
	return 0;
}

process.exit(await main());
