import { type OpenerDefinition, type OpenerScanOptions } from '../core/openers.js';
import { StoreError } from '../core/store/errors.js';
import { type Workset, type WorksetMember } from '../core/worksets.js';
/** Concurrent stats; the first invalid flag (by flag order) reports. */
export declare function resolveMemberFlags(flags: string[]): Promise<WorksetMember[]>;
/** One spelling of "this tool id must exist in the merged table". */
export declare function assertKnownTool(tool: string, table: OpenerDefinition[]): void;
/** Final assembly shared by both compose paths: one validation rule. */
export declare function finalizeWorkset(name: string, members: WorksetMember[], tool: string | undefined, table: OpenerDefinition[]): Workset;
/** The aligned `<name>  <path>` rows used by list, remove, and the
 * open fallback; callers pick the stream and indent. */
export declare function formatMemberRows(members: WorksetMember[]): string[];
export declare function toolUnknownError(toolId: string, table: OpenerDefinition[]): StoreError;
/** Stops at the first installed alternative instead of scanning all. */
export declare function firstInstalledAlternative(table: OpenerDefinition[], excludeId: string | undefined, scan?: OpenerScanOptions): string | null;
export declare function toolUnavailableError(opener: OpenerDefinition, table: OpenerDefinition[], worksetName: string, scan?: OpenerScanOptions): StoreError;
/** Interactive open with no saved tool and nothing installed at all. */
export declare function noToolInstalledError(table: OpenerDefinition[], worksetName: string): StoreError;
//# sourceMappingURL=workset-input.d.ts.map