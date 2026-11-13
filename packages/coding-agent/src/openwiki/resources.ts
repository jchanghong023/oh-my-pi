import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { loadOpenWikiArchive } from "./visual-assets";

const SKILLS_PREFIX = "skills/";

function validateSkillPath(name: string): void {
	const parts = name.split("/");
	if (parts.some(part => !part || part === "." || part === ".." || part.includes("\\"))) {
		throw new Error(`Invalid embedded OpenWiki skill path: ${name}`);
	}
}

async function readEmbeddedSkills(files: ReadonlyMap<string, File>): Promise<Map<string, Uint8Array>> {
	const skills = new Map<string, Uint8Array>();
	for (const [name, file] of files) {
		if (!name.startsWith(SKILLS_PREFIX)) continue;
		const relative = name.slice(SKILLS_PREFIX.length);
		validateSkillPath(relative);
		skills.set(relative, new Uint8Array(await file.arrayBuffer()));
	}
	if (skills.size === 0) {
		throw new Error("OpenWiki skills are missing. Run `bun run gen:openwiki-resources` from the repository root.");
	}
	return skills;
}

/** Content-addressed skills prevent a partial or stale bundle from mixing versions. */
function skillsDigest(skills: ReadonlyMap<string, Uint8Array>): string {
	const hash = createHash("sha256");
	for (const [name, content] of [...skills].sort(([a], [b]) => a.localeCompare(b))) {
		hash.update(name);
		hash.update("\0");
		hash.update(content);
		hash.update("\0");
	}
	return hash.digest("hex");
}

/** Materialize immutable bundled skills under the selected OMP profile. */
export async function materializeOpenWikiSkills(agentDir: string): Promise<string> {
	const { files } = await loadOpenWikiArchive();
	return materializeOpenWikiSkillsFromFiles(agentDir, files);
}

/** Materialize from an injected archive file map so callers and tests share one path. */
export async function materializeOpenWikiSkillsFromFiles(
	agentDir: string,
	files: ReadonlyMap<string, File>,
): Promise<string> {
	const skills = await readEmbeddedSkills(files);
	const digest = skillsDigest(skills);
	const parent = path.join(agentDir, "openwiki", "resources");
	const destination = path.join(parent, digest, "skills");
	try {
		if ((await stat(destination)).isDirectory()) return destination;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	await mkdir(parent, { recursive: true });
	const temporary = path.join(parent, `.skills-${randomUUID()}`);
	try {
		for (const [name, content] of skills) {
			const target = path.join(temporary, "skills", ...name.split("/"));
			await mkdir(path.dirname(target), { recursive: true });
			await writeFile(target, content);
		}
		try {
			await rename(temporary, path.join(parent, digest));
		} catch (error) {
			// Another process may have published the identical content first.
			try {
				if (!(await stat(destination)).isDirectory()) throw error;
			} catch {
				throw error;
			}
		}
	} finally {
		await rm(temporary, { recursive: true, force: true });
	}
	return destination;
}
