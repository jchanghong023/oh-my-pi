export type PlanningHomeKind = 'repo';
export interface PlanningHome {
    kind: PlanningHomeKind;
    root: string;
    changesDir: string;
    defaultSchema: string;
}
export interface ResolvePlanningHomeOptions {
    startPath?: string;
    allowImplicitRepoRoot?: boolean;
}
export declare function findRepoPlanningRootSync(startPath?: string): string | null;
export declare function resolveCurrentPlanningHomeSync(options?: ResolvePlanningHomeOptions): PlanningHome;
export declare function getChangeDir(planningHome: PlanningHome, changeName: string): string;
export declare function formatChangeLocation(planningHome: PlanningHome, changeName: string): string;
//# sourceMappingURL=planning-home.d.ts.map