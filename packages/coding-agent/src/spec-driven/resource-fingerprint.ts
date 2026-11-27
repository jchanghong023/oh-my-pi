import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export const specDrivenOpenSpecInputs = {
	directory: "../../vendor/openspec",
	sourceDirectory: "src",
	packageManifest: "package.json",
	dependencyLock: "pnpm-lock.yaml",
	runtimeEntries: ["bin", "schemas", "skills", "LICENSE"],
} as const;

const packageResources = "src/spec-driven/vendor/resources";
export const specDrivenPassthroughDirectories = {
	superpowers: "../../vendor/superpowers",
	jch: `${packageResources}/jch`,
	"omp-runtime": `${packageResources}/omp-runtime`,
} as const;

/** Hash build inputs, never generated dist files or installed dependency trees. */
export async function specDrivenSourceFingerprint(
	packageRoot: string = path.resolve(import.meta.dir, "../.."),
): Promise<string> {
	const hash = crypto.createHash("sha256");
	async function visit(relative: string): Promise<void> {
		const target = path.join(packageRoot, relative);
		const stat = await fs.lstat(target);
		if (stat.isDirectory()) {
			for (const name of (await fs.readdir(target)).sort()) await visit(`${relative}/${name}`);
		} else if (stat.isFile()) {
			hash.update(relative);
			hash.update("\0");
			hash.update(await Bun.file(target).bytes());
			hash.update("\0");
		} else {
			throw new Error(`Unsupported spec-driven build input: ${relative}`);
		}
	}
	const { directory, sourceDirectory, packageManifest, dependencyLock, runtimeEntries } = specDrivenOpenSpecInputs;
	for (const entry of [sourceDirectory, packageManifest, dependencyLock, ...runtimeEntries]) {
		await visit(`${directory}/${entry}`);
	}
	for (const source of Object.values(specDrivenPassthroughDirectories)) await visit(source);
	for (const entry of [
		"scripts/spec-driven-resources.ts",
		"src/spec-driven/vendor/inventory.json",
		"src/spec-driven/resource-fingerprint.ts",
		"src/spec-driven/resource-inventory.ts",
		"src/spec-driven/resource-archive.ts",
		"src/spec-driven/resource-path.ts",
		"src/spec-driven/resources.ts",
	]) {
		await visit(entry);
	}
	return hash.digest("hex");
}
