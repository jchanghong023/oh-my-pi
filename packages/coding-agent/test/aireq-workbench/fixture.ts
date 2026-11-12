import * as fs from "node:fs/promises";
import * as path from "node:path";
import { normalizePathForComparison } from "@oh-my-pi/pi-utils/dirs";
import type { AIReqProject } from "../../src/aireq-workbench/workflow-types";

/** Independent native process fixtures use a real ordinary Git repository. */
export async function initializeRepository(directory: string, bare = false, branch = "main"): Promise<void> {
	const gitDir = bare ? directory : path.join(directory, ".git");
	for (const child of ["objects", "refs/heads", "refs/tags"])
		await fs.mkdir(path.join(gitDir, child), { recursive: true });
	await fs.writeFile(path.join(gitDir, "HEAD"), `ref: refs/heads/${branch}\n`);
	await fs.writeFile(
		path.join(gitDir, "config"),
		`[core]\nrepositoryformatversion = 0\nbare = ${bare}\nautocrlf = false\nhooksPath = ${JSON.stringify(path.join(gitDir, "hooks").replaceAll("\\", "/"))}\n[user]\nname = OMP Acceptance\nemail = omp-acceptance@example.invalid\n[commit]\ngpgsign = false\n`,
	);
}

export async function registeredFixtureProject(projects: readonly AIReqProject[], cwd: string): Promise<AIReqProject> {
	const root = normalizePathForComparison(await fs.realpath(cwd));
	const matches = projects.filter(project => normalizePathForComparison(project.root) === root);
	if (matches.length !== 1) throw new Error(`Expected one registered fixture root: ${root}; found ${matches.length}`);
	return matches[0]!;
}

export async function eventually<T>(
	read: () => Promise<T>,
	predicate: (value: T) => boolean,
	timeout = 60_000,
): Promise<T> {
	const deadline = Date.now() + timeout;
	for (;;) {
		const value = await read();
		if (predicate(value)) return value;
		if (Date.now() >= deadline) throw new Error(`Public native state did not settle: ${JSON.stringify(value)}`);
		await Bun.sleep(25);
	}
}
