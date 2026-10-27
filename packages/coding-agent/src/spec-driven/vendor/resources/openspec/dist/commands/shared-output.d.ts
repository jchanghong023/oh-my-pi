/**
 * Shared JSON/failure output plumbing for command groups whose errors
 * carry the StoreDiagnostic envelope. One definition of the failure
 * contract: exit code 1, Error:/Fix: lines in human mode, a status
 * array in JSON mode.
 */
import { type StoreDiagnostic } from '../core/store/errors.js';
export declare function printJson(payload: unknown): void;
export declare function asErrorMessage(error: unknown): string;
/**
 * @inquirer prompts reject with ExitPromptError on Ctrl-C; commands
 * translate that to `Cancelled.` + exit 130 (third caller extracted
 * this here in slice 7.1).
 */
export declare function isPromptCancellationError(error: unknown): boolean;
export declare function asStatus(error: unknown, fallbackCode: string): StoreDiagnostic;
export declare function emitFailure(json: boolean | undefined, payload: Record<string, unknown>, error: unknown, fallbackCode: string): void;
//# sourceMappingURL=shared-output.d.ts.map