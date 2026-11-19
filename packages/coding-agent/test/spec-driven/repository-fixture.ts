import * as fs from "node:fs/promises";
import * as path from "node:path";

/** Create an ordinary, empty Git repository without invoking a host Git executable. */
export async function initializeRepository(directory: string): Promise<void> {
	const gitDir = path.join(directory, ".git");
	for (const child of ["objects", "refs/heads", "refs/tags"])
		await fs.mkdir(path.join(gitDir, child), { recursive: true });
	await fs.writeFile(path.join(gitDir, "HEAD"), "ref: refs/heads/main\n");
	await fs.writeFile(
		path.join(gitDir, "config"),
		`[core]\nrepositoryformatversion = 0\nbare = false\nautocrlf = false\nhooksPath = ${JSON.stringify(path.join(gitDir, "hooks").replaceAll("\\", "/"))}\n[user]\nname = OMP Acceptance\nemail = omp-acceptance@example.invalid\n[commit]\ngpgsign = false\n`,
	);
}
