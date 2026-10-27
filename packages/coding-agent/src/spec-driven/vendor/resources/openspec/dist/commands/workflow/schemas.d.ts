/**
 * Schemas Command
 *
 * Lists available workflow schemas with descriptions.
 */
export interface SchemasOptions {
    json?: boolean;
    store?: string;
    storePath?: string;
}
export declare function schemasCommand(options: SchemasOptions): Promise<void>;
//# sourceMappingURL=schemas.d.ts.map