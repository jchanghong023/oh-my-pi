export type StoreDiagnosticSeverity = 'error' | 'warning' | 'info';
export interface StoreDiagnostic {
    severity: StoreDiagnosticSeverity;
    code: string;
    message: string;
    target?: string;
    fix?: string;
}
export declare class StoreError extends Error {
    readonly diagnostic: StoreDiagnostic;
    constructor(message: string, code: string, options?: {
        target?: string;
        fix?: string;
    });
}
export declare function makeStoreDiagnostic(severity: StoreDiagnosticSeverity, code: string, message: string, options?: {
    target?: string;
    fix?: string;
}): StoreDiagnostic;
//# sourceMappingURL=errors.d.ts.map