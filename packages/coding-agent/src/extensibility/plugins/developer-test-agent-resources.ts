import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { gunzipSync } from "node:zlib";
import { getAgentDir } from "@oh-my-pi/pi-utils";
import bundledArchive from "./developer-test-agent-archive";

/** Resolve the source tree or materialize the build's immutable plugin resources in the active profile. */
export async function getDeveloperTestAgentRoot(agentDir: string = getAgentDir()): Promise<string> {
	if (!bundledArchive) return path.join(import.meta.dir, "bundled/developer-test-agent");

	const { digest } = bundledArchive;
	const parent = path.join(agentDir, "developer-test-agent", "resources");
	const destination = path.join(parent, digest, "developer-test-agent");
	try {
		if ((await fs.stat(destination)).isDirectory()) return destination;
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
				await Bun.write(target, Buffer.from(resource.data, "base64"));
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
	return destination;
}
