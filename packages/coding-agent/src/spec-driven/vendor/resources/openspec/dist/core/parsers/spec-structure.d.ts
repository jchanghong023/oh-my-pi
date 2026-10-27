export interface MainSpecStructureIssue {
    kind: 'delta-header' | 'requirement-outside-requirements' | 'duplicate-requirement';
    line: number;
    header: string;
    message: string;
}
export declare function findMainSpecStructureIssues(content: string): MainSpecStructureIssue[];
export declare function stripFencedCodeBlocksPreservingLines(content: string): string;
//# sourceMappingURL=spec-structure.d.ts.map