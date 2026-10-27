/**
 * Relationship health composition (slice 3.6).
 *
 * One read-only answer to "are the roots this work relates to available
 * on this machine?" — pure composition over inputs the doctor command
 * gathers. The lock's four categories stay separated: root health,
 * store metadata health, and reference health. Nothing here (or
 * downstream) clones, syncs, or repairs.
 */
import { type StoreDiagnostic } from './store/errors.js';
import { type ReferenceIndexEntry } from './references.js';
import { type ResolvedOpenSpecRoot } from './root-selection.js';
export interface RelationshipHealth {
    root: {
        path: string;
        source: ResolvedOpenSpecRoot['source'];
        store_id?: string;
        healthy: boolean;
        status: StoreDiagnostic[];
    };
    store: {
        id: string;
        metadata: {
            present: boolean;
            valid: boolean;
            remote?: string;
        };
        origin_url?: string;
        drift?: {
            ahead: number;
            behind: number;
        };
        status: StoreDiagnostic[];
    } | null;
    references: ReferenceIndexEntry[];
    status: StoreDiagnostic[];
}
export interface InspectRelationshipsInput {
    root: ResolvedOpenSpecRoot;
    rootHealthy: boolean;
    rootStatus?: StoreDiagnostic[];
    /** Store facts for store-backed roots (explicit or declared). */
    storeFacts?: {
        id: string;
        metadataPresent: boolean;
        metadataValid: boolean;
        canonicalRemote?: string;
        originUrl?: string;
        drift?: {
            ahead: number;
            behind: number;
        };
    };
    referenceEntries: ReferenceIndexEntry[];
    registryUnreadable: boolean;
    /** A real root whose config also declares a store: pointer (3.2). */
    bothShapesPointer?: {
        value: string;
        filePath: string;
    };
    /** A real root whose store: pointer value is malformed (3.2). */
    malformedPointer?: {
        filePath: string;
        reason: 'unparseable' | 'non_string';
    };
    /** Reference declarations in a pointer directory's own config are inert. */
    inertPointerDeclarations?: {
        filePath: string;
        fields: string[];
    };
}
export declare function inspectRelationships(input: InspectRelationshipsInput): RelationshipHealth;
//# sourceMappingURL=relationship-health.d.ts.map