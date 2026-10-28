import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { createResolvedReviewTarget } from "../src/extensibility/custom-commands/bundled/review/target";

const repositories: string[] = [];
const filePath = "src/😀 demo.ts";
const before = Buffer.from("export const value = 1;\n");
const after = Buffer.from("export const value = 2;\n");

async function createRepository() {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-review-unicode-"));
	repositories.push(root);
	await fs.mkdir(path.join(root, ".git", "objects", "info"), { recursive: true });
	await fs.mkdir(path.join(root, ".git", "refs", "heads"), { recursive: true });
	await fs.writeFile(path.join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
	await fs.writeFile(
		path.join(root, ".git", "config"),
		[
			"[core]",
			"\trepositoryformatversion = 0",
			"\tbare = false",
			"\tautocrlf = false",
			"[user]",
			"\tname = Review Unicode Test",
			"\temail = unicode@example.invalid",
			"[commit]",
			"\tgpgsign = false",
			"",
		].join("\n"),
	);
	await fs.mkdir(path.join(root, "src"));
	await fs.writeFile(path.join(root, filePath), before);
	const repository = vcs.requireGit(root);
	await repository.stageFiles([filePath]);
	await repository.commitCreate("baseline", {});
	await fs.writeFile(path.join(root, filePath), after);
	return root;
}

afterEach(async () => {
	await Promise.all(repositories.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe("P2-15 Unicode review path identity", () => {
	test.each(["literal Unicode", "Git octal"] as const)("resolves %s diff paths", async encoding => {
		const root = await createRepository();
		const result = Bun.spawnSync(
			[
				"git",
				"-c",
				`core.quotePath=${encoding === "Git octal"}`,
				"diff",
				"--no-ext-diff",
				"--no-textconv",
				"--no-color",
				"--src-prefix=a/",
				"--dst-prefix=b/",
				"HEAD",
				"--",
				filePath,
			],
			{ cwd: root, stdout: "pipe", stderr: "pipe" },
		);
		if (result.exitCode !== 0) throw new Error(result.stderr.toString());
		const diff = result.stdout.toString();
		if (encoding === "Git octal") {
			expect(diff).toContain("\\360\\237\\230\\200");
		} else {
			expect(diff).toContain("😀");
		}
		const target = createResolvedReviewTarget("uncommitted", "Reviewing uncommitted changes", diff, "No changes");
		expect(target.snapshot.files).toHaveLength(1);
		const file = target.snapshot.files[0]!;
		expect(file.path).toBe(filePath);
		expect(file.oldPath).toBe(filePath);
		expect(file.newPath).toBe(filePath);
		expect(file.rows.flatMap(row => (row.kind === "removed" ? [row.content] : []))).toEqual([
			"export const value = 1;",
		]);
		expect(file.rows.flatMap(row => (row.kind === "added" ? [row.content] : []))).toEqual([
			"export const value = 2;",
		]);
	});
});
