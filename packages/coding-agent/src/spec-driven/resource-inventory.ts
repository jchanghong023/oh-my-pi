import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { SpecDrivenResourceManifest, SpecDrivenSkillEntry } from "./resources";
import baseline from "./vendor/inventory.json";

/** Snapshot actual vendored files, not the historical inventory's file hashes. */
export async function collectSpecDrivenResources(root: string): Promise<{
	manifest: SpecDrivenResourceManifest;
	entries: Record<string, Uint8Array>;
}> {
	const canonicalRoot = await fs.realpath(root);
	const entries: Record<string, Uint8Array> = {};
	const files: { path: string; sha256: string; executable: boolean }[] = [];
	const skills: SpecDrivenSkillEntry[] = [];
	async function visit(relative: string, ancestors: Set<string>): Promise<void> {
		const target = await fs.realpath(path.join(root, ...relative.split("/")));
		const contained = path.relative(canonicalRoot, target);
		if (contained === ".." || contained.startsWith(`..${path.sep}`) || path.isAbsolute(contained))
			throw new Error(`Resource escapes vendor directory: ${relative}`);
		const stat = await fs.stat(target);
		if (stat.isDirectory()) {
			if (ancestors.has(target)) throw new Error(`Resource directory cycle: ${relative}`);
			const next = new Set(ancestors).add(target);
			for (const entry of (await fs.readdir(target)).sort()) await visit(`${relative}/${entry}`, next);
			return;
		}
		if (!stat.isFile()) throw new Error(`Unsupported resource file: ${relative}`);
		const bytes = await fs.readFile(target);
		entries[relative] = bytes;
		files.push({
			path: relative,
			sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
			executable: Boolean(stat.mode & 0o111) || (bytes[0] === 0x23 && bytes[1] === 0x21),
		});
		const match = /^(openspec|superpowers|jch)\/skills\/([^/]+)\/SKILL\.md$/.exec(relative);
		if (match) skills.push({ source: match[1] as SpecDrivenSkillEntry["source"], name: match[2]!, path: relative });
	}
	for (const directory of ["openspec", "superpowers", "jch", "omp-runtime"]) await visit(directory, new Set());
	const comparePath = (a: { path: string }, b: { path: string }) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
	files.sort(comparePath);
	skills.sort(comparePath);
	return {
		manifest: { openspec: baseline.openspec, superpowers: baseline.superpowers, jch: baseline.jch, skills, files },
		entries,
	};
}
