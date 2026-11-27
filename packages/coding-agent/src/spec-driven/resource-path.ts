import { realpath } from "node:fs/promises";
import * as path from "node:path";

export function isPathInside(root: string, target: string): boolean {
	const relative = path.relative(root, target);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

/** Also checks canonical containment: junctions/symlinks cannot redirect trusted execution. */
export async function resolveSpecDrivenResourcePath(root: string, relativePath: string): Promise<string> {
	if (
		!relativePath ||
		relativePath.includes("\\") ||
		path.posix.isAbsolute(relativePath) ||
		/^[a-z]:/i.test(relativePath) ||
		relativePath.split("/").some(segment => segment === ".." || segment === "." || segment === "")
	) {
		throw new Error(`Invalid bundled resource path: ${relativePath}`);
	}
	const canonicalRoot = await realpath(root);
	const target = path.resolve(root, relativePath);
	if (!isPathInside(path.resolve(root), target)) throw new Error("Bundled resource escapes root");
	const canonical = await realpath(target);
	if (!isPathInside(canonicalRoot, canonical)) throw new Error("Bundled resource escapes canonical root");
	return canonical;
}
