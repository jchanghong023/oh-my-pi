import * as fs from "node:fs/promises";
import * as path from "node:path";
import { FileType, glob } from "@oh-my-pi/pi-natives";
import { DEFAULT_MAX_BYTES } from "@oh-my-pi/pi-tui/tools/streaming-output";
import { BINARY_SNIFF_BYTES, isProbablyBinaryHeader, isRecord, pathIsWithin } from "@oh-my-pi/pi-utils";
import type {
	FileEntry,
	FileStat,
	FileTextSlice,
	WorkspaceFileEntry,
} from "../../../../vendor/zcode-frontend/packages/shared/src/protocol";
import {
	filterWorkspaceFileSearchCandidates,
	mapWorkspaceFileEntriesToSearchCandidates,
	WORKSPACE_FILE_SEARCH_DISPLAY_CAP,
} from "../../../../vendor/zcode-frontend/packages/shared/src/workspaceFileSearch";
import { ensureWithinRoot } from "../internal-urls/filesystem-resource";
import { resolveNativeReadPath } from "./native-read-context";
import type { WebGuiMethod, WebGuiServiceContext } from "./rpc-contract";

function params(value: unknown): Record<string, unknown> {
	if (!isRecord(value)) throw new TypeError("File parameters must be an object");
	return value;
}

function string(value: unknown, name: string): string {
	if (typeof value !== "string" || value.length === 0) throw new TypeError(`${name} must be a nonempty string`);
	return value;
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
	const read = await resolveNativeReadPath(context, string(input.path, "path"));
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
			const read = await resolveNativeReadPath(context, string(input.path, "path"));
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
		async stat(value: unknown): Promise<FileStat> {
			const read = await resolveNativeReadPath(context, string(params(value).path, "path"));
			const stat = await fs.stat(read.path);
			read.assertCurrent();
			return { path: read.path, type: entryType(stat), size: stat.size, mtimeMs: stat.mtimeMs };
		},
		async searchWorkspaceFiles(value: unknown): Promise<WorkspaceFileEntry[]> {
			const input = params(value);
			const read = await resolveNativeReadPath(context, string(input.rootPath, "rootPath"));
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
