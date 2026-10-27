/**
 * True when the ONLY thing wrong with a rebuilt spec is that it has no
 * requirements. That is the exact failure retiring a capability replaces
 * (#1302); anything else means the spec is broken in a way the author still has
 * to fix, so archive must abort exactly as it always did instead of retiring.
 *
 * Asking the validator - rather than counting requirement blocks a second time -
 * is what makes "this spec could not have been written anyway" true by
 * construction. The two counts genuinely disagree: `MarkdownParser` accepts any
 * `###` heading under `## Requirements` as a requirement, while the delta block
 * parser only indexes canonical `### Requirement:` headers and sweeps the rest
 * into the preamble, which survives into the rebuilt spec.
 */
export declare function isRetirableSpec(specName: string, rebuilt: string): Promise<boolean>;
export interface ArchiveOptions {
    yes?: boolean;
    skipSpecs?: boolean;
    noValidate?: boolean;
    validate?: boolean;
    json?: boolean;
    store?: string;
    storePath?: string;
}
export declare class ArchiveCommand {
    execute(changeName?: string, options?: ArchiveOptions): Promise<void>;
    private printJsonFailure;
    /**
     * Shared archive flow. In human mode (json=false) prompts and prose match
     * the historical behavior and cancellations return null. In JSON mode no
     * prose reaches stdout and every blocked path throws.
     */
    private run;
    private selectChange;
}
//# sourceMappingURL=archive.d.ts.map