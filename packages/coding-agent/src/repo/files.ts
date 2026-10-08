import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readlink, realpath } from "node:fs/promises";
import * as path from "node:path";
import { FileType, glob } from "@oh-my-pi/pi-natives";
import type { RepoCategory, RepoFailure } from "./types";

export const MAX_FILE_BYTES = 2 * 1024 * 1024;
export const REPO_EXCLUSIONS = [
	"gitignore and standard file-search ignores",
	"symlinks",
	`files larger than ${MAX_FILE_BYTES} bytes`,
	"binary files",
];

export function relativePath(root: string, candidate: string): string | null {
	const absolute = path.resolve(root, candidate);
	const rel = path.relative(root, absolute);
	if (!rel || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null;
	return rel.split(path.sep).join("/");
}

export function categoryFor(rel: string): RepoCategory {
	const name = path.posix.basename(rel).toLowerCase();
	const parts = rel.toLowerCase().split("/");
	if (
		parts.some(part => /^(tests?|__tests__|specs?|fixtures)$/.test(part)) ||
		/(?:^test_|_test\.|\.test\.|\.spec\.)/.test(name)
	)
		return "test";
	if (parts.some(part => /^(?:config|configs|configuration|etc|\.github)$/.test(part))) return "config";
	if (
		/^(?:\.[^/]*rc|\.?env(?:\..*)?|dockerfile|makefile|justfile|pyproject\.toml|package\.json|tsconfig(?:\..*)?\.json|.*\.(?:toml|ya?ml|ini|cfg|conf|properties|json|jsonc|xml))$/.test(
			name,
		)
	)
		return "config";
	if (
		/\.(?:py|pyi|js|jsx|ts|tsx|rs|c|cc|cpp|h|hpp|go|java|kt|rb|sh|bash|zsh|php|swift|sql|css|scss|html|vue|svelte)$/.test(
			name,
		)
	)
		return "source";
	return "other";
}

export async function enumerateFiles(root: string, signal?: AbortSignal, databasePath?: string): Promise<string[]> {
	const found = await glob({
		pattern: "**/*",
		path: root,
		fileType: FileType.File,
		gitignore: true,
		hidden: true,
		cache: false,
		strictErrors: true,
		signal,
	});
	const ownDb = databasePath && relativePath(root, databasePath);
	return [...new Set(found.matches.map(match => match.path))]
		.filter(rel => !ownDb || (rel !== ownDb && rel !== `${ownDb}-wal` && rel !== `${ownDb}-shm`))
		.sort();
}

/** Check from the repository root so ancestor .gitignore rules remain effective. */
export async function indexedCandidate(root: string, rel: string, signal?: AbortSignal): Promise<boolean> {
	const matches = await glob({
		// Native patterns alias backslashes to separators. Wildcard a literal
		// Unix backslash, then verify the raw returned path below.
		pattern: rel.replace(/[*?[\]{}\\]/g, char => (char === "\\" ? "?" : `[${char}]`)),
		path: root,
		fileType: FileType.File,
		recursive: false,
		hidden: true,
		gitignore: true,
		cache: false,
		strictErrors: true,
		signal,
	});
	return matches.matches.some(match => match.path === rel);
}

export type FileRead = {
	path: string;
	category: RepoCategory;
	text: string;
	hash: string;
	size: number;
	mtimeMs: number;
};
export type ReadResult = { file?: FileRead; failure?: RepoFailure; missing?: boolean };

/**
 * Bun's realpath aliases `\` to a path separator on Unix: for a name that
 * literally contains a backslash it either fails with ENOENT or — worse —
 * silently resolves to the slashed sibling path when one exists. lstat is
 * unaffected by that aliasing, so lstat every component from the entry up to
 * (but excluding) `root`: when none is a symlink the honest resolution is the
 * path as addressed; only actual symlinks need realpath's resolution, whose
 * resolved target then fails the caller's in-scope comparison.
 */
async function realpathTolerant(root: string, absolute: string): Promise<string> {
	let component = absolute;
	for (;;) {
		if ((await lstat(component)).isSymbolicLink()) return realpath(absolute);
		const parent = path.dirname(component);
		// Stop below `root` (matching the caller's component scan); the
		// self-parent guard ends the walk at the filesystem root should `root`
		// never be reached lexically.
		if (parent === component || parent === root) return absolute;
		component = parent;
	}
}

/**
 * Reject symlink components and verify the opened descriptor refers to a stable in-scope regular file.
 * A literal backslash is a legal POSIX filename character; on Windows it normalizes to "/" so
 * `normalized !== rel` already rejects separator-style input there.
 */
export async function readRepoFile(root: string, rel: string, signal?: AbortSignal): Promise<ReadResult> {
	const normalized = relativePath(root, path.resolve(root, rel));
	if (normalized !== rel)
		return { failure: { path: rel, kind: "symlink", message: "Path escapes the repository scope" } };
	const absolute = path.join(root, rel);
	for (let attempt = 0; attempt < 2; attempt++) {
		signal?.throwIfAborted();
		let opened = false;
		try {
			let component = root;
			for (const part of rel.split("/")) {
				component = path.join(component, part);
				if ((await lstat(component)).isSymbolicLink())
					return { failure: { path: rel, kind: "symlink", message: "Symbolic links are excluded" } };
			}
			if (relativePath(root, await realpathTolerant(root, absolute)) !== rel)
				return { failure: { path: rel, kind: "symlink", message: "Path resolves outside repository" } };
			const handle = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
			opened = true;
			try {
				// Validate the open descriptor before reading, even if an ancestor
				// was replaced between lstat and open.
				if (
					process.platform === "linux" &&
					relativePath(root, await readlink(`/proc/self/fd/${handle.fd}`)) !== rel
				) {
					return { failure: { path: rel, kind: "symlink", message: "Opened file resolves outside repository" } };
				}
				const before = await handle.stat();
				if (!before.isFile()) return { failure: { path: rel, kind: "unreadable", message: "Not a regular file" } };
				if (before.size > MAX_FILE_BYTES)
					return { failure: { path: rel, kind: "oversize", message: `File exceeds ${MAX_FILE_BYTES} bytes` } };
				const bytes = Buffer.allocUnsafe(before.size + 1);
				let length = 0;
				while (length < bytes.length) {
					signal?.throwIfAborted();
					const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);
					if (!bytesRead) break;
					length += bytesRead;
				}
				if (length > MAX_FILE_BYTES)
					return { failure: { path: rel, kind: "oversize", message: `File exceeds ${MAX_FILE_BYTES} bytes` } };
				const current = await lstat(absolute);
				const after = await handle.stat();
				if (
					before.ino !== after.ino ||
					before.dev !== after.dev ||
					before.size !== after.size ||
					before.mtimeMs !== after.mtimeMs ||
					before.ctimeMs !== after.ctimeMs ||
					current.ino !== after.ino ||
					current.dev !== after.dev ||
					current.size !== after.size ||
					current.mtimeMs !== after.mtimeMs ||
					current.ctimeMs !== after.ctimeMs ||
					length !== after.size ||
					relativePath(root, await realpathTolerant(root, absolute)) !== rel
				)
					continue;
				const content = bytes.subarray(0, length);
				if (content.includes(0)) return { failure: { path: rel, kind: "binary", message: "NUL byte in file" } };
				let text: string;
				try {
					text = new TextDecoder("utf-8", { fatal: true }).decode(content);
				} catch {
					return { failure: { path: rel, kind: "binary", message: "Invalid UTF-8" } };
				}
				return {
					file: {
						path: rel,
						category: categoryFor(rel),
						text,
						hash: createHash("sha256").update(content).digest("hex"),
						size: length,
						mtimeMs: after.mtimeMs,
					},
				};
			} finally {
				await handle.close();
			}
		} catch (error) {
			signal?.throwIfAborted();
			if ((error as Error).name === "AbortError") throw error;
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOENT" || code === "ENOTDIR") {
				if (opened) continue;
				return { missing: true };
			}
			return {
				failure: { path: rel, kind: "unreadable", message: error instanceof Error ? error.message : String(error) },
			};
		}
	}
	return { failure: { path: rel, kind: "unstable", message: "File changed while being read" } };
}
