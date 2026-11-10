import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";

function inside(root: string, target: string): boolean {
	const relative = path.relative(root, target);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}
/** Resolve every existing ancestor, including Windows junctions, before creating anything. */
export async function containedSpecPath(root: string, relative: string): Promise<string> {
	if (
		!relative ||
		path.isAbsolute(relative) ||
		relative.includes("\0") ||
		relative.includes(":") ||
		relative.split(/[\\/]/).includes("..")
	)
		throw new Error(`Unsafe specification path: ${relative}`);
	const canonicalRoot = await fs.realpath(root);
	const target = path.resolve(root, relative);
	if (!inside(path.resolve(root), target)) throw new Error(`Specification path escapes root: ${relative}`);
	let ancestor = target;
	const missing: string[] = [];
	for (;;) {
		try {
			ancestor = await fs.realpath(ancestor);
			break;
		} catch (error) {
			if (!isEnoent(error)) throw error;
			missing.unshift(path.basename(ancestor));
			ancestor = path.dirname(ancestor);
		}
	}
	const canonical = path.join(ancestor, ...missing);
	if (!inside(canonicalRoot, canonical)) throw new Error(`Specification link escapes root: ${relative}`);
	return canonical;
}

/** Stage writes cannot follow aliases, even when their targets remain inside the workspace. */
export async function assertSpecWritePath(root: string, relative: string): Promise<void> {
	await containedSpecPath(root, relative);
	const base = path.resolve(root);
	const target = path.resolve(base, relative);
	for (let current = target; current !== base; current = path.dirname(current)) {
		try {
			const entry = await fs.lstat(current);
			if (entry.isSymbolicLink()) throw new Error(`Linked stage document path is not writable: ${relative}`);
			if (current === target && (!entry.isFile() || entry.nlink !== 1))
				throw new Error(`Stage document must be an unlinked regular file: ${relative}`);
		} catch (error) {
			if (!isEnoent(error)) throw error;
		}
	}
}
