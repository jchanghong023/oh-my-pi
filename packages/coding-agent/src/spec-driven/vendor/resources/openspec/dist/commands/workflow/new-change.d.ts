/**
 * New Change Command
 *
 * Creates a new change directory with optional description and schema in the
 * resolved OpenSpec root. `--store <id>` selects a registered store's
 * root; initiative linking and workspace affected areas are no longer part of
 * this command.
 */
export interface NewChangeOptions {
    description?: string;
    goal?: string;
    schema?: string;
    store?: string;
    storePath?: string;
    initiative?: string;
    areas?: string;
    json?: boolean;
}
export declare function newChangeCommand(name: string | undefined, options: NewChangeOptions): Promise<void>;
//# sourceMappingURL=new-change.d.ts.map