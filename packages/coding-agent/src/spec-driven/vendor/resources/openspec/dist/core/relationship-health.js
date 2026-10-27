/**
 * Relationship health composition (slice 3.6).
 *
 * One read-only answer to "are the roots this work relates to available
 * on this machine?" — pure composition over inputs the doctor command
 * gathers. The lock's four categories stay separated: root health,
 * store metadata health, and reference health. Nothing here (or
 * downstream) clones, syncs, or repairs.
 */
import { makeStoreDiagnostic } from './store/errors.js';
import { sanitizeInline } from './references.js';
import { storePointerProblem } from './project-config.js';
import { toRootOutput } from './root-selection.js';
function warning(code, message, fix) {
    return makeStoreDiagnostic('warning', code, message, { target: 'relationships', fix });
}
export function inspectRelationships(input) {
    const status = [];
    if (input.registryUnreadable) {
        status.push(warning('relationship_registry_unreadable', 'The store registry is unreadable; reference health cannot be checked.', 'Run: openspec store doctor'));
    }
    if (input.bothShapesPointer) {
        status.push(warning('root_pointer_ignored', `${input.bothShapesPointer.filePath} declares store '${input.bothShapesPointer.value}', but this directory is a real OpenSpec root; the declaration is ignored.`, `Remove the store: line from ${input.bothShapesPointer.filePath}, or move the planning files into the store.`));
    }
    if (input.malformedPointer) {
        status.push(warning('root_pointer_invalid', `${input.malformedPointer.filePath} declares a store: pointer that cannot be used (${storePointerProblem(input.malformedPointer.reason)}).`, `Fix or remove the store: line in ${input.malformedPointer.filePath}.`));
    }
    if (input.inertPointerDeclarations && input.inertPointerDeclarations.fields.length > 0) {
        status.push(warning('pointer_declarations_inert', `${input.inertPointerDeclarations.filePath} declares ${input.inertPointerDeclarations.fields.join(' and ')}, but commands read the resolved store's config — these declarations are inert.`, `Move the ${input.inertPointerDeclarations.fields.join('/')} declarations into the store's openspec/config.yaml.`));
    }
    // Store section: metadata facts + the divergence info note.
    let store = null;
    if (input.storeFacts) {
        const storeStatus = [];
        if (input.storeFacts.canonicalRemote &&
            input.storeFacts.originUrl &&
            input.storeFacts.canonicalRemote !== input.storeFacts.originUrl) {
            storeStatus.push(makeStoreDiagnostic('info', 'store_remote_divergence', `The store.yaml remote (${sanitizeInline(input.storeFacts.canonicalRemote, 200)}) differs from the checkout's origin (${sanitizeInline(input.storeFacts.originUrl, 200)}).`, { target: 'store.metadata' }));
        }
        // Checkout behind its upstream tracking ref: a read-only staleness
        // signal, not a version pin — OpenSpec never syncs stores, so this
        // compares against the local upstream ref, not the live remote.
        // Behind means teammates on newer commits may resolve different specs.
        // Ahead-only is normal (OpenSpec never pushes stores), so it stays quiet.
        const drift = input.storeFacts.drift;
        if (drift && drift.behind > 0) {
            const behindCommits = `${drift.behind} commit${drift.behind === 1 ? '' : 's'}`;
            storeStatus.push(makeStoreDiagnostic('info', 'store_checkout_drift', drift.ahead > 0
                ? `This store checkout has diverged from its upstream tracking branch (${drift.behind} behind, ${drift.ahead} ahead); teammates on newer commits may resolve different specs.`
                : `This store checkout is ${behindCommits} behind its upstream tracking branch; teammates on newer commits may resolve different specs.`, { target: 'store.git' }));
        }
        store = {
            id: input.storeFacts.id,
            metadata: {
                present: input.storeFacts.metadataPresent,
                valid: input.storeFacts.metadataValid,
                ...(input.storeFacts.canonicalRemote
                    ? { remote: input.storeFacts.canonicalRemote }
                    : {}),
            },
            ...(input.storeFacts.originUrl ? { origin_url: input.storeFacts.originUrl } : {}),
            ...(drift ? { drift } : {}),
            status: storeStatus,
        };
    }
    return {
        root: {
            ...toRootOutput(input.root),
            healthy: input.rootHealthy,
            status: input.rootStatus ?? [],
        },
        store,
        references: input.referenceEntries,
        status,
    };
}
//# sourceMappingURL=relationship-health.js.map