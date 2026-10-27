import * as fs from 'node:fs';
/** @internal File-operation seam for transactional failure tests. */
export declare const schemaInitFileOperations: {
    renameSync: typeof fs.renameSync;
};
export declare function schemaWhichCommand(name?: string, options?: {
    json?: boolean;
    all?: boolean;
}): Promise<void>;
export declare function schemaValidateCommand(name?: string, options?: {
    json?: boolean;
    verbose?: boolean;
}): Promise<void>;
export declare function schemaForkCommand(source: string, name?: string, options?: {
    json?: boolean;
    force?: boolean;
}): Promise<void>;
export declare function schemaInitCommand(name: string, options?: {
    json?: boolean;
    description?: string;
    artifacts?: string;
    default?: boolean;
    force?: boolean;
}): Promise<void>;
//# sourceMappingURL=schema.d.ts.map