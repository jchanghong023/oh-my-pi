import { fetchRecipe } from './references.js';
import { toRootOutput } from './root-selection.js';
/** AVAILABLE = path present AND per-entry status empty. */
export function isAvailableMember(member) {
    return member.path !== undefined && member.status.length === 0;
}
export function assembleWorkingSet(input) {
    const members = [];
    for (const entry of input.referenceEntries) {
        members.push({
            role: 'referenced_store',
            id: entry.store_id,
            ...(entry.root !== undefined ? { path: entry.root } : {}),
            ...(entry.root !== undefined && entry.status.length === 0
                ? { fetch: fetchRecipe(entry.store_id) }
                : {}),
            status: entry.status,
        });
    }
    const status = (input.topLevelStatus ?? []).filter((entry) => entry.code === 'relationship_registry_unreadable');
    return {
        root: { ...toRootOutput(input.root), role: 'openspec_root' },
        members,
        status,
    };
}
/**
 * Pure builder for the `.code-workspace` editor view — one consumer of
 * assembly, not the feature. Available members only.
 */
export function buildCodeWorkspaceJson(workingSet, rootName) {
    const folders = [
        { name: rootName, path: workingSet.root.path },
    ];
    for (const member of workingSet.members) {
        if (!isAvailableMember(member)) {
            continue;
        }
        folders.push({ name: `ref:${member.id}`, path: member.path });
    }
    return JSON.stringify({ folders }, null, 2) + '\n';
}
//# sourceMappingURL=working-set.js.map