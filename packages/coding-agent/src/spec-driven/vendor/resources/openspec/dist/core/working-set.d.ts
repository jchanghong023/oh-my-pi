/**
 * Working-set assembly (slice 4.1): the full set a root's declarations
 * describe — the OpenSpec root and its referenced stores — as an
 * agent-consumable brief. A local convenience
 * computed from declared relationships, never a planning system; no
 * clone/sync/launch machinery. Unresolvable members are reported, not
 * guessed.
 */
import type { StoreDiagnostic } from './store/errors.js';
import { type ReferenceIndexEntry } from './references.js';
import { type ResolvedOpenSpecRoot } from './root-selection.js';
export type WorkingSetRole = 'referenced_store';
export interface WorkingSetMember {
    role: WorkingSetRole;
    id: string;
    path?: string;
    remote?: string;
    fetch?: string;
    status: StoreDiagnostic[];
}
export interface WorkingSet {
    root: {
        path: string;
        source: ResolvedOpenSpecRoot['source'];
        store_id?: string;
        role: 'openspec_root';
    };
    members: WorkingSetMember[];
    status: StoreDiagnostic[];
}
export interface AssembleWorkingSetInput {
    root: ResolvedOpenSpecRoot;
    referenceEntries: ReferenceIndexEntry[];
    /** The composition's top-level status; the working set keeps only
     * the registry-unreadable degradation (selected by code, never by
     * position). */
    topLevelStatus?: StoreDiagnostic[];
}
/** AVAILABLE = path present AND per-entry status empty. */
export declare function isAvailableMember(member: WorkingSetMember): boolean;
export declare function assembleWorkingSet(input: AssembleWorkingSetInput): WorkingSet;
/**
 * Pure builder for the `.code-workspace` editor view — one consumer of
 * assembly, not the feature. Available members only.
 */
export declare function buildCodeWorkspaceJson(workingSet: WorkingSet, rootName: string): string;
//# sourceMappingURL=working-set.d.ts.map