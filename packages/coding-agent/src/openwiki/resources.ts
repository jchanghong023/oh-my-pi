import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { isOpenWikiSourceCheckout } from "./resource-dependencies";

/** Materialize immutable bundled skills under the selected OMP profile. */
export async function materializeOpenWikiSkills(agentDir: string): Promise<string> {
	let embedded = process.env.PI_OPENWIKI_SKILLS;
	if (embedded === undefined) {
		if (isOpenWikiSourceCheckout(path.resolve(import.meta.dir, "../../../../"))) {
			return path.resolve(import.meta.dir, "../../../../vendor/openwiki/skills");
		}
		embedded = await readFile(new URL("../../dist/openwiki-resources/skills.json", import.meta.url), "utf8");
	}
	const files = JSON.parse(embedded) as Record<string, string>;
	const digest = createHash("sha256").update(embedded).digest("hex");
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
		for (const [name, content] of Object.entries(files)) {
			const parts = name.split("/");
			if (parts.some(part => !part || part === "." || part === ".." || part.includes("\\"))) {
				throw new Error(`Invalid embedded OpenWiki skill path: ${name}`);
			}
			const target = path.join(temporary, "skills", ...parts);
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
