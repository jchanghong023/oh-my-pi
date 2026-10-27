export function summarizePlanningHome(planningHome) {
    if (!planningHome) {
        return undefined;
    }
    return {
        kind: planningHome.kind,
        root: planningHome.root,
        changesDir: planningHome.changesDir,
        defaultSchema: planningHome.defaultSchema,
    };
}
export function buildActionContext(input) {
    const scope = editScope(input);
    // Keys stay in the published contract order.
    return {
        mode: 'repo-local',
        sourceOfTruth: 'repo',
        planningArtifacts: input.artifactIds,
        linkedContext: [],
        allowedEditRoots: scope.allowedEditRoots,
        requiresAffectedAreaSelection: false,
        constraints: scope.constraints,
    };
}
/**
 * A store holds planning artifacts only. The CLI does not route tasks to
 * repos, so it names the declaring project on the current path as the edit
 * root and has the agent ask before going anywhere else (#2013).
 */
function editScope(input) {
    if (!input.store) {
        return {
            allowedEditRoots: [input.projectRoot],
            constraints: ['Repo-local change artifacts and implementation edits are scoped to this project.'],
        };
    }
    const planning = `Change artifacts live in store '${input.store.id}' (${input.projectRoot}).`;
    const { implementationRoot } = input.store;
    if (implementationRoot) {
        return {
            allowedEditRoots: [implementationRoot, input.projectRoot],
            constraints: [
                `${planning} Implementation edits go in ${implementationRoot}, the project on the current path that declares this store; ask the user before editing any other repository.`,
            ],
        };
    }
    return {
        allowedEditRoots: [input.projectRoot],
        constraints: [
            `${planning} OpenSpec could not determine which repository implements this change; ask the user which repository to edit, and make implementation edits there.`,
        ],
    };
}
export function resolveNextStep(input) {
    const readyArtifact = input.artifactStatuses.find((artifact) => artifact.status === 'ready');
    const storeFlag = input.storeId ? ` --store ${input.storeId}` : '';
    if (readyArtifact) {
        const command = `openspec instructions ${readyArtifact.id} --change "${input.changeName}"${storeFlag} --json`;
        return { command, sentence: `Run ${command} before writing that artifact.` };
    }
    if (input.allArtifactsComplete) {
        const command = `openspec instructions apply --change "${input.changeName}"${storeFlag} --json`;
        return {
            command,
            sentence: `All planning artifacts are complete. Run ${command} to inspect implementation progress.`,
        };
    }
    return undefined;
}
export function buildNextSteps(input) {
    const step = resolveNextStep(input);
    return step ? [step.sentence] : [];
}
//# sourceMappingURL=change-status-policy.js.map