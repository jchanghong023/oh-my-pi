/**
 * Status Command
 *
 * Displays artifact completion status for a change.
 */
import { type ChangeStatus } from '../../core/artifact-graph/index.js';
export interface StatusOptions {
    change?: string;
    all?: boolean;
    schema?: string;
    store?: string;
    storePath?: string;
    json?: boolean;
}
export declare const BATCH_STATUS_FAILURE_PAYLOAD: Record<string, unknown>;
export declare function statusCommand(options: StatusOptions): Promise<void>;
export interface PrintStatusTextOptions {
    /** Selected store id, so the printed command carries `--store`. */
    storeId?: string;
}
export declare function printStatusText(status: ChangeStatus, options?: PrintStatusTextOptions): void;
//# sourceMappingURL=status.d.ts.map