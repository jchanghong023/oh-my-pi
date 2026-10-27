/**
 * Update Plan
 *
 * The write seam `update` uses for every file it generates or removes.
 *
 * A real run forwards to the filesystem. A dry run records what the same call
 * would have done and writes nothing, so the preview and the real update come
 * from one code path instead of two descriptions of it.
 */
import type { FileView } from './file-view.js';
export type UpdatePlanAction = 'add' | 'update' | 'delete';
export interface UpdatePlanChange {
    /** Project-relative POSIX path, or an absolute path (home collapsed to `~`) for files outside the project. */
    path: string;
    action: UpdatePlanAction;
    /**
     * Tool the file belongs to, as configured (e.g. `claude`), or `openspec`
     * for OpenSpec's own files: the global config and legacy-artifact cleanup.
     */
    tool: string;
}
/**
 * What the plan cannot settle by itself: a step a terminal user is asked
 * about, which the plan lists as a non-interactive run makes it. Stable
 * identifiers, for a caller that branches on them.
 */
export type UpdatePlanNoteCode = 'legacy-tool-directories' | 'legacy-artifacts';
export interface UpdatePlanNote {
    code: UpdatePlanNoteCode;
    message: string;
}
export interface UpdatePlanFailure {
    tool: string;
    error: string;
}
export interface UpdatePlan {
    changes: UpdatePlanChange[];
    /**
     * Steps a terminal user would be asked about. `changes` lists them as a
     * non-interactive run makes them. Empty for an ordinary refresh.
     */
    notes: UpdatePlanNote[];
    /**
     * Tools the real update would fail on. Reported rather than thrown: one
     * broken tool must not cost the caller the rest of the plan.
     */
    failures: UpdatePlanFailure[];
}
/** Every filesystem mutation `update` makes while generating artifacts. */
export interface UpdateFileOps {
    writeFile(filePath: string, content: string, tool: string): Promise<void>;
    removeFile(filePath: string, tool: string): Promise<void>;
    removeDirectory(dirPath: string, tool: string): Promise<void>;
    /** Removes a directory already known to be empty. */
    removeEmptyDirectory(dirPath: string): Promise<void>;
}
export declare const realFileOps: UpdateFileOps;
export declare class UpdatePlanRecorder implements UpdateFileOps {
    private readonly projectPath;
    private readonly notes;
    private readonly failures;
    /**
     * The tree as the real update would have it so far: absolute path to planned
     * content, a moved directory, or null once planned away (a removed directory
     * takes everything under it). Steps that read what an earlier step left
     * behind read this through `view`.
     */
    private readonly staged;
    /** Every file path the plan has touched, with the tool that touched it last. */
    private readonly touched;
    constructor(projectPath: string);
    writeFile(filePath: string, content: string, tool: string): Promise<void>;
    removeFile(filePath: string, tool: string): Promise<void>;
    removeEmptyDirectory(dirPath: string): Promise<void>;
    removeDirectory(dirPath: string, tool: string): Promise<void>;
    /**
     * A rename, as the legacy-root migration makes it: whatever the entry is
     * moves, a directory with everything in it.
     */
    moveFile(source: string, destination: string, tool: string): Promise<void>;
    /**
     * The tree with every planned write, move and removal applied. A path the
     * plan has not touched answers exactly as the disk does.
     */
    readonly view: FileView;
    addNote(code: UpdatePlanNoteCode, message: string): void;
    addFailure(tool: string, error: string): void;
    /**
     * Each touched path, compared as it is on disk now with how the plan leaves
     * it. A file written and then removed, or rewritten with the bytes it
     * already had, is no change at all.
     */
    getPlan(): UpdatePlan;
    private stage;
    /**
     * What the plan has put at a path: content, a moved directory, null once
     * planned away, or undefined when the plan has not touched it.
     */
    private stagedEntry;
    /** Whether the plan has put any file or directory below `directory`. */
    private hasStagedDescendant;
    /** Files under a directory in the tree as planned: those on disk, and those the plan added. */
    private filesUnder;
    /**
     * What is at a path in the tree as planned, and whether that is what is on
     * disk (so its permissions are real).
     */
    private entryKind;
    /**
     * Fails the way the real write would, without writing: a directory where the
     * file belongs, a file where one of its directories belongs, or no
     * permission. Recording the write instead would plan past the point where
     * the real update stops for this tool, listing files it never writes.
     */
    private probeWrite;
    /** Fails the way unlinking the file would. */
    private probeRemove;
    /**
     * The nearest existing ancestor has to be a directory the update can create
     * entries in; anything it would create below that starts out empty.
     */
    private probeCreatableIn;
    private toDisplayPath;
}
/** Human-readable rendering of a dry-run plan. */
export declare function formatUpdatePlan(plan: UpdatePlan): string;
//# sourceMappingURL=update-plan.d.ts.map