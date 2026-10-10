import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { GateRun } from "./test-gate-runtime";

const repoRoot = path.resolve(import.meta.dir, "..");
export interface SourceFile {
	path: string;
	kind: "file" | "symlink";
	sha256: string;
	executable: boolean;
	link?: string;
}
export interface SourceIdentity {
	head: string;
	digest: string;
	dirty: boolean;
	status: string;
	files: SourceFile[];
}
function hash(bytes: string | Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}
function sourcePath(root: string, relative: string): string {
	if (path.posix.isAbsolute(relative) || relative.split("/").includes("..")) {
		throw new Error(`invalid source path: ${relative}`);
	}
	return path.join(root, ...relative.split("/"));
}
const CACHE_COMPONENTS: Record<string, true | undefined> = {
	node_modules: true,
	target: true,
	".cache": true,
	".venv": true,
	venv: true,
	__pycache__: true,
	coverage: true,
	".pytest_cache": true,
	".ruff_cache": true,
};

/** Local Git reads only. Tracked files and nonignored new source preserve dirty
 * additions/edits/deletions; generated/build caches do not enter the inventory. */
export async function captureSourceIdentity(gate: GateRun, root = repoRoot): Promise<SourceIdentity> {
	return gate.charged(async () => {
		const capture = async (label: string, args: string[]) =>
			(await gate.capture({ label, argv: ["git", ...args], cwd: root })).stdout;
		const head = (await capture("source/HEAD", ["rev-parse", "HEAD"])).trim();
		const status = await capture("source/dirty", ["status", "--porcelain=v1", "--untracked-files=all"]);
		const names = (
			await capture("source/inventory", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"])
		)
			.split("\0")
			.filter(Boolean);
		const stages = await capture("source/modes", ["ls-files", "--stage", "-z"]);
		const executable = new Set(
			stages
				.split("\0")
				.filter(row => row.startsWith("100755 "))
				.map(row => row.slice(row.indexOf("\t") + 1)),
		);
		const files: SourceFile[] = [];
		for (const name of [...new Set(names)]
			.filter(
				name => !name.split("/").some(part => CACHE_COMPONENTS[part]) && !/(?:\.tsbuildinfo|\.pyc)$/.test(name),
			)
			.sort()) {
			gate.signal.throwIfAborted();
			const file = sourcePath(root, name);
			let stat;
			try {
				stat = await fs.lstat(file);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
				throw error;
			}
			if (stat.isSymbolicLink()) {
				const link = await fs.readlink(file);
				const resolved = path.resolve(path.dirname(file), link);
				const relative = path.relative(root, resolved);
				if (relative.startsWith("..") || path.isAbsolute(relative)) {
					throw new Error(`source symlink escapes source tree: ${name}`);
				}
				files.push({ path: name, kind: "symlink", sha256: hash(link), executable: false, link });
			} else if (stat.isFile()) {
				const contents = await fs.readFile(file);
				files.push({
					path: name,
					kind: "file",
					sha256: hash(contents),
					executable: process.platform === "win32" ? executable.has(name) : (stat.mode & 0o111) !== 0,
				});
			} else throw new Error(`unsupported source entry: ${name}`);
		}
		return { head, status, dirty: status.trim() !== "", files, digest: hash(JSON.stringify(files)) };
	});
}
