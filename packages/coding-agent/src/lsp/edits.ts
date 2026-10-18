import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEexist, isEnoent, logger } from "@oh-my-pi/pi-utils";
import { formatPathRelativeToCwd } from "../tools/path-utils";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import {
	invalidateFsScanAfterRename,
	invalidateFsScanAfterUncertainWrites,
	invalidateFsScanAfterWrite,
	invalidateFsScanAfterWrites,
} from "../tools/fs-cache-invalidation";
import type {
	CreateFile,
	CreateFileOptions,
	DeleteFile,
	DeleteFileOptions,
	Position,
	Range,
	RenameFile,
	RenameFileOptions,
	TextDocumentEdit,
	TextEdit,
	WorkspaceEdit,
} from "./types";
import { readTextFromDisk, uriToFile } from "./utils";

// =============================================================================
// Text Edit Application
// =============================================================================

/**
 * Apply text edits to a string in-memory.
 * Edits are applied in reverse order (bottom-to-top) to preserve line/character indices.
 */
export function applyTextEditsToString(content: string, edits: TextEdit[]): string {
	const lines = content.split("\n");
	const sortedEdits = sortAndValidateTextEdits(edits);

	for (const edit of sortedEdits) {
		const { start, end } = edit.range;

		// Single-line edit: replace substring within same line
		if (start.line === end.line) {
			const line = lines[start.line] || "";
			lines[start.line] = line.slice(0, start.character) + edit.newText + line.slice(end.character);
		} else {
			// Multi-line edit: splice across multiple lines
			const startLine = lines[start.line] || "";
			const endLine = lines[end.line] || "";
			const newContent = startLine.slice(0, start.character) + edit.newText + endLine.slice(end.character);
			lines.splice(start.line, end.line - start.line + 1, ...newContent.split("\n"));
		}
	}

	return lines.join("\n");
}

function comparePosition(a: Position, b: Position): number {
	return a.line === b.line ? a.character - b.character : a.line - b.line;
}
function positionsEqual(a: Position, b: Position): boolean {
	return a.line === b.line && a.character === b.character;
}

function rangesEqual(a: Range, b: Range): boolean {
	return positionsEqual(a.start, b.start) && positionsEqual(a.end, b.end);
}

function isEmptyRange(range: Range): boolean {
	return positionsEqual(range.start, range.end);
}

function formatRange(range: Range): string {
	return `${range.start.line + 1}:${range.start.character + 1}-${range.end.line + 1}:${range.end.character + 1}`;
}

/** True when two ranges overlap (share any position other than a touching boundary). */
export function rangesOverlap(a: Range, b: Range): boolean {
	return comparePosition(a.start, b.end) < 0 && comparePosition(b.start, a.end) < 0;
}

/**
 * Sort edits bottom-to-top for in-place application and reject overlaps.
 * Equal start positions tiebreak by original array index descending so that,
 * applied bottom-up, inserts at the same position land in array order
 * (LSP spec: the order of edits in the array defines the order in the result).
 * Byte-identical non-empty range edits are idempotent, so duplicate server
 * output is collapsed before overlap validation.
 */
function rejectSnippetTextEdits(edits: TextEdit[]): void {
	for (const edit of edits) {
		if ("insertTextFormat" in edit && edit.insertTextFormat === 2) {
			throw new ToolError("snippet-formatted LSP edits are unsupported");
		}
	}
}

export function sortAndValidateTextEdits(edits: TextEdit[]): TextEdit[] {
	rejectSnippetTextEdits(edits);
	const sorted = edits
		.map((edit, index) => ({ edit, index }))
		.sort((a, b) => {
			if (a.edit.range.start.line !== b.edit.range.start.line) {
				return b.edit.range.start.line - a.edit.range.start.line;
			}
			if (a.edit.range.start.character !== b.edit.range.start.character) {
				return b.edit.range.start.character - a.edit.range.start.character;
			}
			return b.index - a.index;
		})
		.map(entry => entry.edit);
	const unique: TextEdit[] = [];
	for (const edit of sorted) {
		const prev = unique[unique.length - 1];
		if (prev && !isEmptyRange(edit.range) && rangesEqual(prev.range, edit.range) && prev.newText === edit.newText) {
			continue;
		}
		unique.push(edit);
	}

	// Detect overlapping ranges: in reverse-sorted order, each edit's start
	// must be >= the next edit's end. If not, the edits would clobber each other
	// once applied bottom-up.
	for (let i = 0; i < unique.length - 1; i++) {
		const later = unique[i].range;
		const earlier = unique[i + 1].range;
		if (comparePosition(earlier.end, later.start) > 0) {
			throw new ToolError(
				`overlapping LSP edits: ${formatRange(earlier)} conflicts with ${formatRange(later)}; LSP produced inconsistent edits`,
			);
		}
	}

	return unique;
}

/**
 * Flatten a WorkspaceEdit's text edits into a Map<uri, TextEdit[]>.
 * Resource operations (create/rename/delete) are ignored — callers handle them separately.
 */
export function flattenWorkspaceTextEdits(edit: WorkspaceEdit): Map<string, TextEdit[]> {
	const out = new Map<string, TextEdit[]>();
	const push = (uri: string, edits: TextEdit[]) => {
		if (edits.length === 0) return;
		const prev = out.get(uri);
		if (prev) prev.push(...edits);
		else out.set(uri, [...edits]);
	};
	if (edit.changes) {
		const changes = edit.changes;
		for (const uri in changes) push(uri, changes[uri]);
	}
	if (edit.documentChanges) {
		for (const change of edit.documentChanges) {
			if ("textDocument" in change && change.textDocument && "edits" in change && change.edits) {
				const tdc = change as TextDocumentEdit;
				const textEdits = tdc.edits.filter((e): e is TextEdit => "range" in e && "newText" in e);
				push(tdc.textDocument.uri, textEdits);
			}
		}
	}
	return out;
}

/** Notify at the write boundary, including a failed write that may have truncated its target. */
async function writeTextAndInvalidate(filePath: string, content: string): Promise<void> {
	try {
		await Bun.write(filePath, content);
	} catch (error) {
		invalidateFsScanAfterUncertainWrites([filePath], "LSP text write failed; target may have been partially written");
		throw error;
	}
	invalidateFsScanAfterWrite(filePath);
}

interface ResourceMutationSnapshot {
	paths: string[];
	complete: boolean;
}

/**
 * Snapshot only the resource subtree before it moves or disappears. Index
 * consumers refresh exact paths, so a directory notification alone is not enough.
 * Symlinks are leaves: never enumerate their targets.
 */
async function resourceMutationPaths(filePath: string, stat?: Stats): Promise<ResourceMutationSnapshot> {
	const paths = [filePath];
	try {
		const rootStat =
			stat ??
			(await fs.lstat(filePath).catch(error => {
				if (isEnoent(error)) return undefined;
				throw error;
			}));
		if (rootStat?.isDirectory() && !rootStat.isSymbolicLink()) {
			const visit = async (directory: string): Promise<void> => {
				for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
					const child = path.join(directory, entry.name);
					if (entry.isDirectory() && !entry.isSymbolicLink()) await visit(child);
					else paths.push(child);
				}
			};
			await visit(filePath);
		}
		return { paths, complete: true };
	} catch {
		// 快照只用于索引通知；枚举失败不能阻止内核允许的移动或删除，也不能把部分路径标为已核对。
		return { paths, complete: false };
	}
}

function invalidateResourceMutation(snapshot: ResourceMutationSnapshot): void {
	if (snapshot.complete) invalidateFsScanAfterWrites(snapshot.paths);
	else
		invalidateFsScanAfterUncertainWrites(
			snapshot.paths,
			"LSP resource snapshot incomplete; affected descendant paths could not be enumerated",
		);
}

function invalidateResourceRename(oldPath: string, newPath: string, snapshot: ResourceMutationSnapshot): void {
	if (snapshot.complete && snapshot.paths.length === 1) {
		invalidateFsScanAfterRename(oldPath, newPath);
		return;
	}
	invalidateResourceMutation({
		paths: [
			...snapshot.paths,
			...snapshot.paths.map(filePath => path.join(newPath, path.relative(oldPath, filePath))),
		],
		complete: snapshot.complete,
	});
}

/**
 * Apply text edits to a file.
 * Edits are applied in reverse order (bottom-to-top) to preserve line/character indices.
 */
export async function applyTextEdits(filePath: string, edits: TextEdit[]): Promise<void> {
	const content = await readTextFromDisk(filePath);
	const result = applyTextEditsToString(content, edits);
	await writeTextAndInvalidate(filePath, result);
}

/** A reference file and the text edits a rename computed for it. */
export interface RenameReferenceEdit {
	filePath: string;
	edits: TextEdit[];
}

/**
 * Apply a rename's reference edits and then move `source` → `dest` as one unit.
 *
 * The reference edits (import/usage rewrites in other files) must be written
 * before the move so their positions match the pre-move file contents, but a
 * failed move must not leave those files half-rewritten: each edited file is
 * snapshotted first, and if `mkdir`/`rename` throws, every snapshot is restored
 * before the error propagates. A failed move therefore leaves the source,
 * destination, and every reference file exactly as they were.
 *
 * @throws the original `mkdir`/`rename` error, after rolling back the edits.
 */
export async function applyEditsThenRename(
	references: RenameReferenceEdit[],
	source: string,
	dest: string,
): Promise<void> {
	const backups: Array<{ filePath: string; original: string }> = [];
	for (const { filePath, edits } of references) {
		backups.push({ filePath, original: await readTextFromDisk(filePath) });
		await applyTextEdits(filePath, edits);
	}
	try {
		await fs.mkdir(path.dirname(dest), { recursive: true });
		const sourcePaths = await resourceMutationPaths(source);
		await fs.rename(source, dest);
		invalidateResourceRename(source, dest, sourcePaths);
	} catch (err) {
		await Promise.all(backups.map(({ filePath, original }) => writeTextAndInvalidate(filePath, original)));
		throw err;
	}
}

// =============================================================================
// Workspace Edit Application
// =============================================================================

type WorkspaceEditOp =
	| { kind: "text"; uri: string; edits: TextEdit[] }
	| { kind: "create"; uri: string; options?: CreateFileOptions }
	| { kind: "rename"; oldUri: string; newUri: string; options?: RenameFileOptions }
	| { kind: "delete"; uri: string; options?: DeleteFileOptions };

/**
 * Flatten documentChanges into an ordered op list. Text edits are accumulated
 * per-URI and flushed before any resource op that touches the same URI (or,
 * for folder rename/delete, any descendant URI) so that renames, creates, and
 * deletes always see the correct prior file state.
 */
function planDocumentChanges(documentChanges: NonNullable<WorkspaceEdit["documentChanges"]>): WorkspaceEditOp[] {
	const ops: WorkspaceEditOp[] = [];
	const pending = new Map<string, TextEdit[]>();

	const flushUri = (uri: string) => {
		const edits = pending.get(uri);
		if (!edits) return;
		pending.delete(uri);
		ops.push({ kind: "text", uri, edits });
	};

	// Flush the exact URI plus every pending descendant (for folder-level
	// resource ops where the queued edits target child files of the target).
	const flushSubtree = (uri: string) => {
		const prefix = uri.endsWith("/") ? uri : `${uri}/`;
		const matches: string[] = [];
		for (const candidate of pending.keys()) {
			if (candidate === uri || candidate.startsWith(prefix)) matches.push(candidate);
		}
		for (const target of matches) {
			flushUri(target);
		}
	};

	for (const change of documentChanges) {
		if ("textDocument" in change && change.textDocument && "edits" in change && change.edits) {
			const tdc = change as TextDocumentEdit;
			const uri = tdc.textDocument.uri;
			const textEdits = tdc.edits.filter((e): e is TextEdit => "range" in e && "newText" in e);
			if (textEdits.length > 0) {
				const prev = pending.get(uri);
				if (prev) prev.push(...textEdits);
				else pending.set(uri, [...textEdits]);
			}
		} else if ("kind" in change && change.kind) {
			if (change.kind === "create") {
				const createOp = change as CreateFile;
				flushUri(createOp.uri);
				ops.push({ kind: "create", uri: createOp.uri, options: createOp.options });
			} else if (change.kind === "rename") {
				const renameOp = change as RenameFile;
				// Per LSP §3.16.2 documentChanges are applied in declared order.
				// Flush both the source subtree (so prior edits land before the move)
				// AND the destination subtree (so prior edits land on whatever exists
				// at newUri before the rename overwrites/replaces it — relevant under
				// `options.overwrite` and `options.ignoreIfExists`).
				flushSubtree(renameOp.oldUri);
				flushSubtree(renameOp.newUri);
				ops.push({
					kind: "rename",
					oldUri: renameOp.oldUri,
					newUri: renameOp.newUri,
					options: renameOp.options,
				});
			} else if (change.kind === "delete") {
				const deleteOp = change as DeleteFile;
				flushSubtree(deleteOp.uri);
				ops.push({ kind: "delete", uri: deleteOp.uri, options: deleteOp.options });
			}
		}
	}

	// Flush text edits not followed by a resource op.
	for (const uri of Array.from(pending.keys())) {
		flushUri(uri);
	}

	return ops;
}

/** One filesystem mutation actually performed by {@link applyWorkspaceEdit}. */
export type ExecutedWorkspaceChange =
	| { kind: "edit"; uri: string }
	| { kind: "create"; uri: string }
	| { kind: "rename"; oldUri: string; newUri: string }
	| { kind: "delete"; uri: string };

/** What {@link applyWorkspaceEdit} did: human-readable summaries plus the ops that really ran. */
export interface WorkspaceEditResult {
	applied: string[];
	/** Ops that mutated the filesystem — skipped `ignoreIfExists`/`ignoreIfNotExists` ops are excluded. */
	executed: ExecutedWorkspaceChange[];
}

/**
 * Apply a workspace edit (collection of file changes).
 * All text-edit batches are overlap-validated before anything is written so a
 * conflict throws without leaving the workspace half-applied.
 *
 * `onExecuted` fires after each filesystem mutation. When a later op throws,
 * the callback has already reported the executed prefix — callers that must
 * reconcile external state (e.g. LSP overlays) rely on this because the
 * returned {@link WorkspaceEditResult} is lost on failure.
 */
export async function applyWorkspaceEdit(
	edit: WorkspaceEdit,
	cwd: string,
	onExecuted?: (change: ExecutedWorkspaceChange) => void,
): Promise<WorkspaceEditResult> {
	const applied: string[] = [];
	const executed: ExecutedWorkspaceChange[] = [];
	const record = (change: ExecutedWorkspaceChange) => {
		executed.push(change);
		onExecuted?.(change);
	};

	if (edit.documentChanges) {
		const ops = planDocumentChanges(edit.documentChanges);
		for (const op of ops) {
			if (op.kind === "text") sortAndValidateTextEdits(op.edits);
		}
		for (const op of ops) {
			if (op.kind === "text") {
				const filePath = uriToFile(op.uri);
				await applyTextEdits(filePath, op.edits);
				applied.push(`Applied ${op.edits.length} edit(s) to ${formatPathRelativeToCwd(filePath, cwd)}`);
				record({ kind: "edit", uri: op.uri });
			} else if (op.kind === "create") {
				const filePath = uriToFile(op.uri);
				await fs.mkdir(path.dirname(filePath), { recursive: true });
				try {
					if (op.options?.overwrite) {
						await writeTextAndInvalidate(filePath, "");
					} else {
						const handle = await fs.open(filePath, "wx");
						invalidateFsScanAfterWrite(filePath);
						await handle.close();
					}
				} catch (error) {
					if (!(op.options?.ignoreIfExists && !op.options.overwrite && isEexist(error))) {
						throw error;
					}
					continue;
				}
				applied.push(`Created ${formatPathRelativeToCwd(filePath, cwd)}`);
				record({ kind: "create", uri: op.uri });
			} else if (op.kind === "rename") {
				const oldPath = uriToFile(op.oldUri);
				const newPath = uriToFile(op.newUri);
				await fs.mkdir(path.dirname(newPath), { recursive: true });
				if (oldPath !== newPath) {
					// Displace an overwritten destination into a kernel-reserved sibling
					// temp dir (same filesystem, so the moves stay atomic) instead of
					// deleting it, so a failed rename (EXDEV, permissions) can restore
					// it and leave the workspace exactly as it was.
					let displaced: { dir: string; file: string; snapshot: ResourceMutationSnapshot } | undefined;
					let sourceStat: Stats | undefined;
					try {
						const targetStat = await fs.lstat(newPath);
						if (!op.options?.overwrite) {
							if (op.options?.ignoreIfExists) continue;
							throw new ToolError(`rename target already exists: ${formatPathRelativeToCwd(newPath, cwd)}`);
						}
						// Only displace the destination when it is a distinct file. On a
						// case-insensitive filesystem a case-only rename resolves both
						// paths to the same inode; moving newPath aside would move the
						// source, so let fs.rename change the case in place instead.
						sourceStat = await fs.lstat(oldPath);
						if (sourceStat.dev !== targetStat.dev || sourceStat.ino !== targetStat.ino) {
							const targetPaths = await resourceMutationPaths(newPath, targetStat);
							const holdDir = await fs.mkdtemp(path.join(path.dirname(newPath), ".omp-displaced-"));
							const holdFile = path.join(holdDir, path.basename(newPath));
							try {
								await fs.rename(newPath, holdFile);
								invalidateResourceMutation(targetPaths);
							} catch (error) {
								await fs.rm(holdDir, { recursive: true, force: true }).catch(() => {});
								throw error;
							}
							displaced = { dir: holdDir, file: holdFile, snapshot: targetPaths };
						}
					} catch (error) {
						if (!isEnoent(error)) throw error;
					}
					try {
						const sourcePaths = await resourceMutationPaths(oldPath, sourceStat);
						await fs.rename(oldPath, newPath);
						invalidateResourceRename(oldPath, newPath, sourcePaths);
					} catch (error) {
						if (displaced) {
							try {
								await fs.rename(displaced.file, newPath);
								invalidateResourceMutation(displaced.snapshot);
							} catch {
								// Restoration failed: the destination really is gone, so
								// report it to reconciliation as an executed delete.
								record({ kind: "delete", uri: op.newUri });
							}
							await fs.rm(displaced.dir, { recursive: true, force: true }).catch(() => {});
						}
						throw error;
					}
					if (displaced) {
						await fs.rm(displaced.dir, { recursive: true, force: true }).catch((error: unknown) => {
							logger.debug("LSP rename: failed to remove displaced overwrite target", {
								displaced: displaced?.dir,
								error: error instanceof Error ? error.message : String(error),
							});
						});
					}
				}
				applied.push(`Renamed ${formatPathRelativeToCwd(oldPath, cwd)} → ${formatPathRelativeToCwd(newPath, cwd)}`);
				record({ kind: "rename", oldUri: op.oldUri, newUri: op.newUri });
			} else {
				const filePath = uriToFile(op.uri);
				try {
					const stat = await fs.lstat(filePath);
					const affectedPaths =
						stat.isDirectory() && op.options?.recursive
							? await resourceMutationPaths(filePath, stat)
							: { paths: [filePath], complete: true };
					if (stat.isDirectory() && !stat.isSymbolicLink() && !op.options?.recursive) {
						await fs.rmdir(filePath);
					} else {
						try {
							await fs.rm(filePath, { recursive: op.options?.recursive ?? false });
						} catch (error) {
							if (stat.isDirectory() && op.options?.recursive) {
								invalidateFsScanAfterUncertainWrites(
									affectedPaths.paths,
									"LSP delete failed; target may have been partially removed",
								);
							}
							throw error;
						}
					}
					invalidateResourceMutation(affectedPaths);
				} catch (error) {
					if (!(op.options?.ignoreIfNotExists && isEnoent(error))) throw error;
					continue;
				}
				applied.push(`Deleted ${formatPathRelativeToCwd(filePath, cwd)}`);
				record({ kind: "delete", uri: op.uri });
			}
		}
	} else if (edit.changes) {
		// Legacy changes-map path: validate every file's edits before writing any.
		const changes = edit.changes;
		for (const uri in changes) {
			sortAndValidateTextEdits(changes[uri]);
		}
		for (const uri in changes) {
			const textEdits = changes[uri];
			if (textEdits.length === 0) continue;
			const filePath = uriToFile(uri);
			await applyTextEdits(filePath, textEdits);
			applied.push(`Applied ${textEdits.length} edit(s) to ${formatPathRelativeToCwd(filePath, cwd)}`);
			record({ kind: "edit", uri });
		}
	}

	return { applied, executed };
}
