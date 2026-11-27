import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { gunzipSync } from "node:zlib";
import { getAgentDir } from "@oh-my-pi/pi-utils";
import type { Skill } from "../skills";
import bundledArchive from "./developer-test-agent-archive";

export const BUNDLED_DEVELOPER_TEST_NAMESPACE = "bundled-developer-test-agent";
const BUNDLED_SKILL_NAMES = new Set(["generate-ut", "fix-ut", "improve-coverage", "improve-validity", "test-report"]);

/** Resolve the real resource root, materializing the build's immutable resources in the active profile if needed. */
export async function getDeveloperTestAgentRoot(agentDir: string = getAgentDir()): Promise<string> {
	if (!bundledArchive) return fs.realpath(path.join(import.meta.dir, "bundled/developer-test-agent"));

	const { digest } = bundledArchive;
	const parent = path.join(agentDir, "developer-test-agent", "resources");
	const destination = path.join(parent, digest, "developer-test-agent");
	try {
		if ((await fs.stat(destination)).isDirectory()) return await fs.realpath(destination);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}

	const archive = await fs.readFile(path.resolve(import.meta.dir, bundledArchive.path));
	const entries = JSON.parse(gunzipSync(archive).toString("utf8")) as Array<
		[string, { data: string; mode: number } | null]
	>;
	await fs.mkdir(parent, { recursive: true });
	const temporary = path.join(parent, `.developer-test-agent-${randomUUID()}`);
	try {
		const root = path.join(temporary, "developer-test-agent");
		await fs.mkdir(root, { recursive: true });
		for (const [name, resource] of entries) {
			const parts = name.split("/");
			if (parts.some(part => !part || part === "." || part === ".." || part.includes("\\") || part.includes(":"))) {
				throw new Error(`Invalid embedded developer-test-agent resource path: ${name}`);
			}
			const target = path.join(root, ...parts);
			if (resource === null) {
				await fs.mkdir(target, { recursive: true });
			} else {
				// Bun.write can fail with ENOENT when a Windows staging path exceeds MAX_PATH.
				await fs.writeFile(target, Buffer.from(resource.data, "base64"));
				await fs.chmod(target, resource.mode);
			}
		}
		try {
			await fs.rename(temporary, path.join(parent, digest));
		} catch (error) {
			// A concurrent process may already have published this exact payload.
			try {
				if (!(await fs.stat(destination)).isDirectory()) throw error;
			} catch {
				throw error;
			}
		}
	} finally {
		await fs.rm(temporary, { recursive: true, force: true });
	}
	return fs.realpath(destination);
}

/** Address the shipped files independently of skill-catalog names and deduplication. */
export async function getBundledDeveloperTestSkill(name: string, agentDir?: string): Promise<Skill | undefined> {
	if (!BUNDLED_SKILL_NAMES.has(name)) return undefined;
	const root = await getDeveloperTestAgentRoot(agentDir);
	const baseDir = path.join(root, "skills", name);
	return {
		name: `${BUNDLED_DEVELOPER_TEST_NAMESPACE}/${name}`,
		description: "",
		filePath: path.join(baseDir, "SKILL.md"),
		baseDir,
		source: BUNDLED_DEVELOPER_TEST_NAMESPACE,
		hide: true,
		containRoot: root,
	};
}
