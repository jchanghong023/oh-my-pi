import { watch, type FSWatcher } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { FileType, glob } from "@oh-my-pi/pi-natives";
import { gitInfo } from "@oh-my-pi/pi-natives/vcs";
import { DEFAULT_MAX_BYTES } from "@oh-my-pi/pi-tui/tools/streaming-output";
import {
	BINARY_SNIFF_BYTES,
	isProbablyBinaryHeader,
	isRecord,
	normalizePathForComparison,
	pathIsWithin,
} from "@oh-my-pi/pi-utils";
import type {
	FileEntry,
	FileStat,
	FileTextSlice,
	WorkspaceFileEntry,
} from "../../../../vendor/zcode-frontend/packages/shared/src/protocol";
import { Emitter, type Event } from "../../../../vendor/zcode-frontend/packages/rpc/src/foundation";
import type { FileWatchEvent } from "../../../../vendor/zcode-frontend/packages/shared/src/protocol";
import {
	filterWorkspaceFileSearchCandidates,
	mapWorkspaceFileEntriesToSearchCandidates,
	WORKSPACE_FILE_SEARCH_DISPLAY_CAP,
} from "../../../../vendor/zcode-frontend/packages/shared/src/workspaceFileSearch";
import { ensureWithinRoot } from "../internal-urls/filesystem-resource";
import { nativeReadContext, resolveNativeReadPath } from "./native-read-context";
import type { WebGuiMethod, WebGuiServiceContext } from "./rpc-contract";

function params(value: unknown): Record<string, unknown> {
	if (!isRecord(value)) throw new TypeError("File parameters must be an object");
	return value;
}

function string(value: unknown, name: string): string {
	if (typeof value !== "string" || value.length === 0) throw new TypeError(`${name} must be a nonempty string`);
	return value;
}

function readOptions(input: Record<string, unknown>): { sessionId?: string } {
	return input.sessionId === undefined ? {} : { sessionId: string(input.sessionId, "sessionId") };
}

function integer(value: unknown, name: string, fallback?: number): number {
	if (value === undefined && fallback !== undefined) return fallback;
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
		throw new TypeError(`${name} must be a nonnegative safe integer`);
	return value;
}

function entryType(stat: { isFile(): boolean; isDirectory(): boolean }): "file" | "directory" {
	if (stat.isDirectory()) return "directory";
	if (stat.isFile()) return "file";
	throw new TypeError("Only regular files and directories can be read");
}

async function readSlice(context: WebGuiServiceContext, input: Record<string, unknown>, sniff: boolean) {
	const offset = integer(input.offset, "offset", sniff ? 0 : undefined);
	const requestedLength = integer(input.length, "length", sniff ? DEFAULT_MAX_BYTES : undefined);
	if (!sniff && requestedLength > DEFAULT_MAX_BYTES)
		throw new RangeError(`File ranges cannot exceed the native read limit (${DEFAULT_MAX_BYTES} bytes)`);
	const length = Math.min(requestedLength, DEFAULT_MAX_BYTES);
	const read = await resolveNativeReadPath(context, string(input.path, "path"), readOptions(input));
	const targetStat = await fs.stat(read.path);
	read.assertCurrent();
	if (entryType(targetStat) !== "file") throw new TypeError("Cannot read a directory as a file");
	const handle = await fs.open(read.path, "r");
	try {
		read.assertCurrent();
		const stat = await handle.stat();
		if (entryType(stat) !== "file") throw new TypeError("Cannot read a directory as a file");
		read.assertCurrent();
		const bytes = new Uint8Array(Math.min(length, Math.max(0, stat.size - offset)));
		let bytesRead = 0;
		while (bytesRead < bytes.length) {
			const chunk = await handle.read(bytes, bytesRead, bytes.length - bytesRead, offset + bytesRead);
			read.assertCurrent();
			if (chunk.bytesRead === 0) break;
			bytesRead += chunk.bytesRead;
		}
		let isBinary = false;
		if (sniff) {
			let header = bytes.subarray(0, Math.min(bytesRead, BINARY_SNIFF_BYTES));
			if (offset !== 0 || header.length < Math.min(stat.size, BINARY_SNIFF_BYTES)) {
				const buffer = new Uint8Array(Math.min(stat.size, BINARY_SNIFF_BYTES));
				const prefix = await handle.read(buffer, 0, buffer.length, 0);
				read.assertCurrent();
				header = buffer.subarray(0, prefix.bytesRead);
			}
			isBinary = isProbablyBinaryHeader(header);
		}
		read.assertCurrent();
		return { path: read.path, offset, bytes: bytes.subarray(0, bytesRead), totalBytes: stat.size, isBinary };
	} finally {
		await handle.close();
		read.assertCurrent();
	}
}

export function createNativeFileMethods(context: WebGuiServiceContext): Readonly<Record<string, WebGuiMethod>> {
	return {
		async readdir(value: unknown): Promise<FileEntry[]> {
			const input = params(value);
			if (input.includeHidden !== undefined && typeof input.includeHidden !== "boolean")
				throw new TypeError("includeHidden must be a boolean");
			if (input.directoriesOnly === true) {
				context.signal.throwIfAborted();
				const requested = string(input.path, "path");
				if (!path.isAbsolute(requested)) throw new TypeError("Directory chooser requires an absolute path");
				const root = await fs.realpath(requested);
				const entries = await fs.readdir(root, { withFileTypes: true });
				const directories: FileEntry[] = [];
				for (const entry of entries) {
					if (!input.includeHidden && entry.name.startsWith(".")) continue;
					if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
					const target = path.join(root, entry.name);
					if (entry.isSymbolicLink() && !(await fs.stat(target)).isDirectory()) continue;
					directories.push({
						name: entry.name,
						path: target,
						type: "directory",
						isSymbolicLink: entry.isSymbolicLink(),
					});
				}
				context.signal.throwIfAborted();
				return directories.sort((a, b) => a.name.localeCompare(b.name));
			}
			if (input.directoriesOnly !== undefined && input.directoriesOnly !== false)
				throw new TypeError("directoriesOnly must be a boolean");
			const read = await resolveNativeReadPath(context, string(input.path, "path"), readOptions(input));
			const entries = await fs.readdir(read.path, { withFileTypes: true });
			read.assertCurrent();
			const result: FileEntry[] = [];
			for (const entry of entries) {
				if (!input.includeHidden && entry.name.startsWith(".")) continue;
				const entryPath = path.join(read.path, entry.name);
				let type: FileEntry["type"];
				if (entry.isSymbolicLink()) {
					const target = await fs.realpath(entryPath);
					read.assertCurrent();
					// External links are not navigable entries in the admitted workspace.
					if (!pathIsWithin(read.root, target)) continue;
					type = entryType(await fs.stat(target));
				} else {
					if (!entry.isFile() && !entry.isDirectory()) continue;
					type = entryType(entry);
				}
				result.push({ name: entry.name, path: entryPath, type, isSymbolicLink: entry.isSymbolicLink() });
			}
			read.assertCurrent();
			return result.sort(
				(a, b) => Number(b.type === "directory") - Number(a.type === "directory") || a.name.localeCompare(b.name),
			);
		},
		async resolvePath(value: unknown): Promise<string> {
			const input = params(value);
			return (await resolveNativeReadPath(context, string(input.path, "path"), readOptions(input))).path;
		},
		async checkFilesExist(value: unknown) {
			const input = params(value);
			if (!Array.isArray(input.paths)) throw new TypeError("paths must be an array");
			return Promise.all(
				input.paths.map(async requested => {
					const target = string(requested, "path");
					const read = await resolveNativeReadPath(context, target, { ...readOptions(input), allowMissing: true });
					try {
						await fs.stat(read.path);
						read.assertCurrent();
						return { path: target, exists: true };
					} catch (error) {
						read.assertCurrent();
						if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path: target, exists: false };
						throw error;
					}
				}),
			);
		},
		async stat(value: unknown): Promise<FileStat> {
			const input = params(value);
			const read = await resolveNativeReadPath(context, string(input.path, "path"), readOptions(input));
			const stat = await fs.stat(read.path);
			read.assertCurrent();
			return { path: read.path, type: entryType(stat), size: stat.size, mtimeMs: stat.mtimeMs };
		},
		async searchWorkspaceFiles(value: unknown): Promise<WorkspaceFileEntry[]> {
			const input = params(value);
			const read = await resolveNativeReadPath(context, string(input.rootPath, "rootPath"), readOptions(input));
			if (typeof input.query !== "string") throw new TypeError("query must be a string");
			const limit = Math.min(
				integer(input.limit, "limit", WORKSPACE_FILE_SEARCH_DISPLAY_CAP),
				WORKSPACE_FILE_SEARCH_DISPLAY_CAP,
			);
			// Unlike fuzzyFind, glob can refuse descendant-link traversal before a scan occurs.
			const result = await glob({
				path: read.path,
				pattern: "**/*",
				hidden: true,
				gitignore: true,
				followLinks: false,
				cache: false,
				strictErrors: true,
				signal: context.signal,
				timeoutMs: 5000,
			});
			read.assertCurrent();
			const entries: WorkspaceFileEntry[] = [];
			for (const match of result.matches) {
				if (match.fileType !== FileType.File && match.fileType !== FileType.Dir) continue;
				if (match.path.split("/").includes(".git")) continue;
				const absolute = path.resolve(read.path, match.path);
				ensureWithinRoot(absolute, read.root, "workspace", match.path);
				entries.push({
					name: path.basename(absolute),
					path: absolute,
					relativePath: match.path,
					type: match.fileType === FileType.Dir ? "directory" : "file",
				});
			}
			const matches = filterWorkspaceFileSearchCandidates(
				mapWorkspaceFileEntriesToSearchCandidates(entries),
				input.query,
				{ limit },
			);
			read.assertCurrent();
			return matches.map(({ name, path, relativePath, type }) => ({ name, path, relativePath, type }));
		},
		async readTextFile(value: unknown): Promise<FileTextSlice> {
			const read = await readSlice(context, params(value), true);
			return {
				path: read.path,
				content: read.isBinary ? "" : new TextDecoder().decode(read.bytes),
				offset: read.offset,
				bytesRead: read.bytes.length,
				totalBytes: read.totalBytes,
				truncated: read.offset + read.bytes.length < read.totalBytes,
				isBinary: read.isBinary,
			};
		},
		async readFileRange(value: unknown): Promise<Uint8Array> {
			return (await readSlice(context, params(value), false)).bytes;
		},
	};
}

/** Watchers belong to this connection; they never grant a file-read capability. */
export function createNativeFileWatcherMethods(context: WebGuiServiceContext) {
	const watchers = new Map<string, { watcher: FSWatcher; changes: Emitter<FileWatchEvent>; subscribers: number }>();
	let disposed = false;
	const unwatch = (id: string) => {
		const entry = watchers.get(id);
		if (!entry) return;
		watchers.delete(id);
		entry.watcher.close();
		entry.changes.dispose();
	};
	const disposeAll = () => {
		for (const id of watchers.keys()) unwatch(id);
	};
	const dispose = () => {
		disposed = true;
		disposeAll();
		context.signal.removeEventListener("abort", dispose);
	};
	context.signal.addEventListener("abort", dispose, { once: true });
	const methods: Readonly<Record<string, WebGuiMethod>> = {
		async watch(value: unknown) {
			const input = params(value);
			if (input.recursive !== undefined && typeof input.recursive !== "boolean")
				throw new TypeError("recursive must be a boolean");
			const owner = await nativeReadContext(context, readOptions(input).sessionId);
			const requested = string(input.path, "path");
			const target = await fs.realpath(path.resolve(owner.cwd, requested));
			owner.assertCurrent();
			const metadata = gitInfo(owner.root);
			const isMetadataRoot =
				metadata &&
				[metadata.gitDir, metadata.commonDir].some(
					directory => normalizePathForComparison(directory) === normalizePathForComparison(target),
				);
			const read = pathIsWithin(owner.root, target)
				? await resolveNativeReadPath(context, requested, readOptions(input))
				: isMetadataRoot
					? { ...owner, path: target }
					: undefined;
			if (!read) throw new Error("File watcher path is outside the native workspace and its Git metadata");
			if (disposed) throw new Error("File watcher service is disposed");
			const stat = await fs.stat(read.path);
			read.assertCurrent();
			const id = crypto.randomUUID();
			const changes = new Emitter<FileWatchEvent>();
			const watcher = watch(read.path, { recursive: input.recursive === true }, (_event, filename) => {
				try {
					read.assertCurrent();
				} catch {
					unwatch(id);
					return;
				}
				const changedPath = filename
					? path.resolve(stat.isDirectory() ? read.path : path.dirname(read.path), String(filename))
					: undefined;
				changes.fire({
					dirPath: stat.isDirectory() ? read.path : path.dirname(read.path),
					...(changedPath && pathIsWithin(read.root, changedPath) ? { changedPath } : {}),
				});
			});
			watcher.on("error", () => {
				// Force a real panel re-read (which surfaces deletion/permission errors), then release the failed handle.
				changes.fire({ dirPath: stat.isDirectory() ? read.path : path.dirname(read.path) });
				unwatch(id);
			});
			watchers.set(id, { watcher, changes, subscribers: 0 });
			if (disposed || context.signal.aborted) {
				unwatch(id);
				throw new Error("File watcher connection closed");
			}
			return { id };
		},
		unwatch(value: unknown) {
			unwatch(string(params(value).id, "id"));
		},
		disposeAll,
	};
	return {
		methods,
		dynamicEvents: {
			onDynamicChange: (value: unknown): Event<FileWatchEvent> => {
				const id = string(value, "watcherId");
				const entry = watchers.get(id);
				if (!entry) throw new Error("File watcher does not exist on this connection");
				return listener => {
					if (!watchers.has(id)) throw new Error("File watcher was released");
					entry.subscribers++;
					const subscription = entry.changes.event(listener);
					let released = false;
					return {
						dispose() {
							if (released) return;
							released = true;
							subscription.dispose();
							if (--entry.subscribers === 0) unwatch(id);
						},
					};
				};
			},
		},
		dispose,
	};
}
