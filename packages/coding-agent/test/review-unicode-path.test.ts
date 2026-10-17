import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { openArchive } from "@oh-my-pi/pi-utils/ar";
import { writeReviewBundle } from "../src/extensibility/custom-commands/bundled/code-review-export/bundle";
import { captureReviewExportSnapshot } from "../src/extensibility/custom-commands/bundled/code-review-export/snapshot";
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
	test.each(["frozen export", "Git octal"] as const)(
		"resolves %s diff paths to the actual manifest source members",
		async encoding => {
			const root = await createRepository();
			const snapshot = await captureReviewExportSnapshot(root, { kind: "uncommitted" });
			try {
				let diff = snapshot.diff;
				if (encoding === "Git octal") {
					const result = Bun.spawnSync(
						[
							"git",
							"-c",
							"core.quotePath=true",
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
					diff = result.stdout.toString();
					// Ensure this branch exercises real Git's UTF-8 byte escapes, not literal Unicode.
					expect(diff).toContain("\\360\\237\\230\\200");
				}
				const result = await writeReviewBundle({ ...snapshot, diff }, { args: [] });
				const archive = await openArchive(result.path);
				const manifest = JSON.parse(Buffer.from((await archive.readFile("manifest.json")).bytes).toString());
				const frozenDiff = Buffer.from((await archive.readFile("diff.patch")).bytes).toString();
				const target = createResolvedReviewTarget("uncommitted", snapshot.mode, frozenDiff, "No changes");
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
				for (const [version, parsedPath, prefix, bytes] of [
					["base", file.oldPath, "before", before],
					["target", file.newPath, "after", after],
				] as const) {
					const member = `changed-files/${prefix}/${parsedPath}`;
					expect(manifest.sources).toContainEqual(expect.objectContaining({ path: parsedPath, version, member }));
					// Resolve through the parsed consumer path, rather than just finding it in raw diff text.
					expect(Buffer.from((await archive.readFile(member)).bytes)).toEqual(bytes);
				}
				const instructions = Buffer.from((await archive.readFile("instructions/review.md")).bytes).toString();
				expect(instructions).not.toContain("\ufffd");
			} finally {
				await snapshot.dispose();
			}
		},
	);
});
