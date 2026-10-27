/**
 * The one kebab id grammar. Store ids, change ids, and legacy initiative ids
 * all share it.
 */
export declare const KEBAB_ID_REGEX: RegExp;
export declare function isKebabId(value: string): boolean;
/** Human rendering of the grammar, shared so the wording never forks. */
export declare const KEBAB_ID_DESCRIPTION = "must be kebab-case with lowercase letters, numbers, and single hyphen separators";
/** The fix-line twin of KEBAB_ID_DESCRIPTION, shared for the same reason. */
export declare const KEBAB_ID_FIX = "Use kebab-case with lowercase letters, numbers, and single hyphen separators.";
/**
 * The folder-safe-name grammar (store ids layer the kebab grammar on
 * top of it; workset member labels use it alone). Returns a problem
 * description, or null when valid.
 */
export declare function folderStyleNameProblem(value: string, label: string): string | null;
//# sourceMappingURL=id.d.ts.map