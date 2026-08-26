import { $ } from "bun";

const TYPESCRIPT_PATHS = ["*.ts", "*.tsx", "*.mts", "*.cts"];

async function listGitPaths(args: string[]): Promise<string[]> {
	const result = await $`git ${args}`.quiet().nothrow();
	if (result.exitCode !== 0) {
		throw new Error(result.stderr.toString().trim() || `git ${args.join(" ")} failed`);
	}
	return result
		.text()
		.split("\0")
		.filter(path => path.length > 0);
}

const [trackedPaths, untrackedPaths] = await Promise.all([
	listGitPaths(["diff", "--name-only", "-z", "--diff-filter=ACMRT", "HEAD", "--", ...TYPESCRIPT_PATHS]),
	listGitPaths(["ls-files", "--others", "--exclude-standard", "-z", "--", ...TYPESCRIPT_PATHS]),
]);
const paths = [...new Set([...trackedPaths, ...untrackedPaths])].sort();

if (paths.length === 0) {
	console.log("fastcheck: no locally modified TypeScript files");
	process.exit(0);
}

console.log(`fastcheck: checking ${paths.length} locally modified TypeScript file(s)`);
for (const path of paths) console.log(`  ${path}`);

const result = await $`biome check --no-errors-on-unmatched ${paths}`.nothrow();
process.exit(result.exitCode);
