import { $ } from "bun";
import * as path from "node:path";

const TYPESCRIPT_PATHS = ["*.ts", "*.tsx", "*.mts", "*.cts"];
const repoRoot = path.resolve(import.meta.dir, "..");
const BIOME_CONFIG_PATH = path.join(repoRoot, "biome.json");

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

type BiomeIncludeEntry = { raw: string; positive: boolean; pattern: string };

async function loadBiomeIncludes(): Promise<BiomeIncludeEntry[]> {
	let raw: string;
	try {
		raw = await Bun.file(BIOME_CONFIG_PATH).text();
	} catch (err) {
		throw new Error(`fastcheck: cannot read ${BIOME_CONFIG_PATH}: ${(err as Error).message}`);
	}
	let parsed: { files?: { includes?: unknown } };
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		throw new Error(`fastcheck: cannot parse ${BIOME_CONFIG_PATH}: ${(err as Error).message}`);
	}
	const includes = parsed.files?.includes;
	if (!Array.isArray(includes) || includes.length === 0) {
		throw new Error(`fastcheck: ${BIOME_CONFIG_PATH} is missing files.includes entries`);
	}
	const entries: BiomeIncludeEntry[] = [];
	for (const entry of includes) {
		if (typeof entry !== "string") {
			throw new Error(`fastcheck: ${BIOME_CONFIG_PATH} files.includes entries must be strings`);
		}
		const positive = !entry.startsWith("!");
		entries.push({ raw: entry, positive, pattern: positive ? entry : entry.slice(1) });
	}
	if (!entries.some(e => e.positive)) {
		throw new Error(`fastcheck: ${BIOME_CONFIG_PATH} files.includes has no positive patterns`);
	}
	return entries;
}

function compileFilters(entries: BiomeIncludeEntry[]): { positive: Bun.Glob[]; negative: Bun.Glob[] } {
	const positive: Bun.Glob[] = [];
	const negative: Bun.Glob[] = [];
	for (const entry of entries) {
		try {
			if (entry.positive) positive.push(new Bun.Glob(entry.pattern));
			else negative.push(new Bun.Glob(entry.pattern));
		} catch (err) {
			throw new Error(
				`fastcheck: cannot compile glob "${entry.raw}" from ${BIOME_CONFIG_PATH}: ${(err as Error).message}`,
			);
		}
	}
	return { positive, negative };
}

function isBiomeManaged(
	filePath: string,
	positive: readonly Bun.Glob[],
	negative: readonly Bun.Glob[],
): boolean {
	return positive.some(g => g.match(filePath)) && !negative.some(g => g.match(filePath));
}

async function main(): Promise<number> {
	const entries = await loadBiomeIncludes();
	const { positive, negative } = compileFilters(entries);
	const [trackedPaths, untrackedPaths] = await Promise.all([
		listGitPaths(["diff", "--name-only", "-z", "--diff-filter=ACMRT", "HEAD", "--", ...TYPESCRIPT_PATHS]),
		listGitPaths(["ls-files", "--others", "--exclude-standard", "-z", "--", ...TYPESCRIPT_PATHS]),
	]);
	const allPaths = [...new Set([...trackedPaths, ...untrackedPaths])].sort();

	if (allPaths.length === 0) {
		console.log("fastcheck: no locally modified TypeScript files");
		return 0;
	}
	const checking: string[] = [];
	const skipping: string[] = [];
	for (const p of allPaths) (isBiomeManaged(p, positive, negative) ? checking : skipping).push(p);

	for (const p of skipping) console.log(`skipping ${p} (outside biome.json files.includes)`);

	if (checking.length === 0) {
		console.log(
			`fastcheck: no Biome-managed files among ${allPaths.length} locally modified TypeScript file(s); skipping biome`,
		);
		return 0;
	}

	console.log(`fastcheck: checking ${checking.length} Biome-managed file(s):`);
	for (const p of checking) console.log(`  ${p}`);

	const result = await $`biome check --no-errors-on-unmatched ${checking}`.cwd(repoRoot).nothrow();
	return result.exitCode;
}

process.exit(await main());
