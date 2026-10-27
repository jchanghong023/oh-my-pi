import * as nodeFs from 'node:fs';
import { StoreError } from './store/errors.js';
/**
 * Shared machine-local state-file mechanics (extracted from the store
 * registry in slice 7.1, its second consumer). Callers own the
 * diagnostic data (code, target, wording); the factory owns the
 * shared mechanics - the fix strings describe the lock's own
 * behavior (stale-steal, creation), so their templates live here.
 */
export type FileLockErrorKind = 'create-failed' | 'timeout';
export interface FileLockErrorInfo {
    lockPath: string;
    /** The original errno error for 'create-failed'. */
    cause?: unknown;
}
export interface FileLockOptions {
    lockPath: string;
    errorFor: (kind: FileLockErrorKind, info: FileLockErrorInfo) => Error;
}
export interface LockErrorData {
    /** Noun phrase for the create-failed message, e.g. "the registry lock file". */
    createSubject: string;
    /** The full timeout message, e.g. "Store registry is busy." */
    busyMessage: string;
    code: string;
    target: string;
}
/** One template for lock diagnostics; callers supply the data. */
export declare function makeLockErrorFactory(data: LockErrorData): (kind: FileLockErrorKind, info: FileLockErrorInfo) => StoreError;
export declare function isNodeErrorCode(error: unknown, code: string): boolean;
export declare function pathIsFile(filePath: string): Promise<boolean>;
export declare function pathIsDirectory(dirPath: string): Promise<boolean>;
export declare function writeFileAtomically(filePath: string, content: string): Promise<void>;
export declare function acquireFileLock(options: FileLockOptions): Promise<nodeFs.promises.FileHandle>;
export declare function releaseFileLock(lock: nodeFs.promises.FileHandle, lockPath: string): Promise<void>;
//# sourceMappingURL=file-state.d.ts.map