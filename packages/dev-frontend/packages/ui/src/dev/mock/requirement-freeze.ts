import type { DevRequirementGroup } from "../types.js";
export function freezePrototypeRequirement(group: DevRequirementGroup, employeeId: string, at: string): void {
  if (group.freeze) return;
  group.freeze = { frozenAt: at, frozenBy: employeeId, title: group.title, snapshotDigest: group.snapshot!.digest, files: structuredClone(group.files), srIds: [...group.srIds], dependencies: structuredClone(group.srDependencies ?? {}) };
  group.status = "frozen";
  group.developmentStartedAt ??= at;
}
