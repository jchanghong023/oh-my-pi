export class StoreError extends Error {
    diagnostic;
    constructor(message, code, options = {}) {
        super(message);
        this.name = 'StoreError';
        this.diagnostic = {
            severity: 'error',
            code,
            message,
            ...options,
        };
    }
}
export function makeStoreDiagnostic(severity, code, message, options = {}) {
    return {
        severity,
        code,
        message,
        ...options,
    };
}
//# sourceMappingURL=errors.js.map