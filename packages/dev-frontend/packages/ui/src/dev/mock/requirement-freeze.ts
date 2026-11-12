import type { DevRequirementGroup } from "../types.js";
import { srDependencyMap } from "../sr-dependencies.js";
export function freezePrototypeRequirement(group: DevRequirementGroup, employeeId: string, at: string): void {
  if (group.freeze) return;
  group.freeze = { frozenAt: at, frozenBy: employeeId, title: group.title, snapshotDigest: group.snapshot!.digest, files: structuredClone(group.files), srIds: [...group.srIds], dependencies: srDependencyMap(group) };
  group.status = "frozen";
  group.developmentStartedAt ??= at;
}
