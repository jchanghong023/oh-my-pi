import * as path from "node:path";
import type { GateRun } from "./test-gate-runtime";

const repoRoot = path.resolve(import.meta.dir, "..");
export interface SourceRevision {
	head: string;
	dirty: boolean;
	status: string;
}
function sourcePath(root: string, relative: string): string {
	if (path.posix.isAbsolute(relative) || relative.split("/").includes("..")) {
		throw new Error(`invalid source path: ${relative}`);
	}
	return path.join(root, ...relative.split("/"));
}

/** Root documentation is not a runtime input; package resources remain eligible. */
function isTestSelectionInput(file: string): boolean {
	return file !== "AGENTS.md" && !file.startsWith("docs/") && !file.startsWith("docs-zh-CN/");
}

/** Conservative boundary for inputs Bun cannot trace through native or dynamic builds. */
export function bunRequiresFullSelection(changed: readonly string[]): boolean {
	const ordinarySource = (file: string) =>
		/^packages\/coding-agent\/src\/(?:tools|repo)\/.+\.[cm]?tsx?$/.test(file) &&
		!/(?:^|\/)(?:generated|generator|generators|fixtures?|native|build|config)(?:\/|[.-])/i.test(file);
	return changed.some(file => isTestSelectionInput(file) && !ordinarySource(file));
}

/** Runtime paths changed against a revision, including both sides of renames and untracked files. */
export async function captureChangedPaths(gate: GateRun, root = repoRoot, baseRevision = "HEAD"): Promise<string[]> {
	return gate.charged(async () => {
		const capture = async (label: string, args: string[]) =>
			(await gate.capture({ label, argv: ["git", ...args], cwd: root })).stdout;
		const tracked = await capture("source/changed", [
			"diff",
			"--name-only",
			"--no-renames",
			"-z",
			baseRevision,
			"--",
		]);
		const staged = await capture("source/staged", [
			"diff",
			"--cached",
			"--name-only",
			"--no-renames",
			"-z",
			baseRevision,
			"--",
		]);
		const untracked = await capture("source/untracked", ["ls-files", "--others", "--exclude-standard", "-z"]);
		const names = [...new Set(`${tracked}\0${staged}\0${untracked}`.split("\0").filter(Boolean))].sort();
		for (const name of names) sourcePath(root, name);
		return names.filter(isTestSelectionInput);
	});
}

/** Record the current Git revision and dirty status without reading source contents. */
export async function captureSourceRevision(gate: GateRun, root = repoRoot): Promise<SourceRevision> {
	return gate.charged(async () => {
		const capture = async (label: string, args: string[]) =>
			(await gate.capture({ label, argv: ["git", ...args], cwd: root })).stdout;
		const head = (await capture("source/HEAD", ["rev-parse", "HEAD"])).trim();
		const status = await capture("source/dirty", [
			"status",
			"--porcelain=v1",
			"--untracked-files=all",
			"--ignore-submodules=none",
		]);
		return { head, status, dirty: status.trim() !== "" };
	});
}
