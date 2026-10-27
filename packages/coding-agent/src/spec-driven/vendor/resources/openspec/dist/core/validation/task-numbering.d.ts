export interface TaskNumberingDocument {
    path: string;
    content: string;
}
export interface TaskNumberingIssue {
    path: string;
    line: number;
    message: string;
}
/**
 * Finds ambiguous task references across the task files tracked by a change.
 * Numbering is interpreted only inside `## N.` groups. Unnumbered sections,
 * unnumbered tasks, and files without numbered groups are intentionally ignored.
 */
export declare function findTaskNumberingIssues(documents: readonly TaskNumberingDocument[]): TaskNumberingIssue[];
//# sourceMappingURL=task-numbering.d.ts.map