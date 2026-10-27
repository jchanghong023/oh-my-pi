import type { RootOutput } from '../core/root-selection.js';
export interface ShowOptions {
    json?: boolean;
    requirements?: boolean;
    scenarios?: boolean;
    requirement?: string;
    noInteractive?: boolean;
    rootOutput?: RootOutput;
}
export declare class SpecCommand {
    private specsDir;
    private rootPath?;
    constructor(rootPath?: string);
    show(specId?: string, options?: ShowOptions): Promise<void>;
}
export declare function specShowCommand(specId: string | undefined, options: ShowOptions & {
    noInteractive?: boolean;
}): Promise<void>;
export declare function specListCommand(options: {
    json?: boolean;
    long?: boolean;
}): Promise<void>;
export declare function specValidateCommand(specId: string | undefined, options: {
    strict?: boolean;
    json?: boolean;
    noInteractive?: boolean;
}): Promise<void>;
//# sourceMappingURL=spec.d.ts.map