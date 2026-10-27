import type { PlanningHome } from './planning-home.js';
export interface PlanningHomeSummary {
    kind: 'repo';
    root: string;
    changesDir: string;
    defaultSchema: string;
}
export interface ActionContext {
    mode: 'repo-local';
    sourceOfTruth: 'repo';
    planningArtifacts: string[];
    linkedContext: Array<{
        name: string;
    }>;
    allowedEditRoots: string[];
    requiresAffectedAreaSelection: boolean;
    constraints: string[];
}
export interface ChangeStatusPolicyArtifact {
    id: string;
    status: 'done' | 'skipped' | 'ready' | 'blocked';
}
export interface ChangeNextStepsInput {
    changeName: string;
    artifactStatuses: ChangeStatusPolicyArtifact[];
    allArtifactsComplete: boolean;
    /** Selected store id; next-step commands must carry it. */
    storeId?: string;
}
export interface ActionContextInput {
    projectRoot: string;
    artifactIds: string[];
    /**
     * Set when the root is a store: the store holds the planning artifacts,
     * and `implementationRoot` is the project that declares it, if any.
     */
    store?: {
        id: string;
        implementationRoot?: string;
    };
}
export declare function summarizePlanningHome(planningHome: PlanningHome | undefined): PlanningHomeSummary | undefined;
export declare function buildActionContext(input: ActionContextInput): ActionContext;
/**
 * The one next action for a change, in both the forms the CLI needs.
 *
 * `sentence` is what the JSON `nextSteps` contract publishes; `command` is the
 * bare command the text surface prints. Both are built here so the two
 * surfaces can never name a different next step.
 */
export interface ChangeNextStep {
    /** Ready-to-run command, including any `--store` flag. */
    command: string;
    /** Sentence form carried by the JSON `nextSteps` array. */
    sentence: string;
}
export declare function resolveNextStep(input: ChangeNextStepsInput): ChangeNextStep | undefined;
export declare function buildNextSteps(input: ChangeNextStepsInput): string[];
//# sourceMappingURL=change-status-policy.d.ts.map