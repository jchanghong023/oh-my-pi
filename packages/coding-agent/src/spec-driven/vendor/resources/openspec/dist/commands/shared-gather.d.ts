import { type RegistrySnapshot } from '../core/store/registry.js';
import { type ProjectConfig } from '../core/project-config.js';
import { type ReferenceIndexEntry } from '../core/references.js';
import { type OpenSpecRootInspection } from '../core/openspec-root.js';
import type { ResolvedOpenSpecRoot } from '../core/root-selection.js';
export interface RelationshipData {
    registrySnapshot: RegistrySnapshot;
    projectConfig: ProjectConfig | null;
    storeConfigPath: string;
    referenceEntries: ReferenceIndexEntry[];
    rootInspection: OpenSpecRootInspection;
}
export declare function gatherRelationshipData(root: ResolvedOpenSpecRoot): Promise<RelationshipData>;
//# sourceMappingURL=shared-gather.d.ts.map