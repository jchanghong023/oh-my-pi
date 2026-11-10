import { prototypeRequirementsReviewBlocker } from "./requirements-review.js";
import type { DevFileVersion, DevRequirementGroup } from "./types.js";

function versions(files: DevFileVersion[]): string {
  return JSON.stringify(files.map(({ path, sha256, size }) => ({ path, sha256, size })).sort((a, b) => a.path.localeCompare(b.path)));
}
function dependencies(value: Record<string, string[]>): string {
  return JSON.stringify(Object.keys(value).sort().map(id => [id, [...value[id]!].sort()]));
}
/** 文档确认与开发冻结是两个不同的版本事实；这里只检查内存样例。 */
export function prototypeRequirementConfirmationIssue(group: DevRequirementGroup): string | undefined {
  const reviewBlocker = prototypeRequirementsReviewBlocker(group);
  if (reviewBlocker) return reviewBlocker;
  if (!group.merge || !group.snapshot || !group.confirmation || group.confirmation.snapshotDigest !== group.snapshot.digest || versions(group.files) !== versions(group.merge.files)) return "已入库需求或方案的确认版本已变化，请重新评审、确认并通过提案 PR 合入后再开始。";
}
export function prototypeRequirementFreezeIssue(group: DevRequirementGroup): string | undefined {
  const freeze = group.freeze;
  if (!freeze) return group.status === "frozen" || group.developmentStartedAt ? "开发冻结记录缺失，请恢复原版本；不能重新生成快照覆盖历史。" : undefined;
  if (group.status !== "frozen" || freeze.snapshotDigest !== group.snapshot?.digest || freeze.title !== group.title || versions(freeze.files) !== versions(group.files) || JSON.stringify(freeze.srIds) !== JSON.stringify(group.srIds) || dependencies(freeze.dependencies) !== dependencies(group.srDependencies ?? {})) return "冻结的 IR／SR、需求成员或确认方案已变化，请暂停并重新提案；不能沿用旧冻结版本推进。";
}
export function freezePrototypeRequirement(group: DevRequirementGroup, employeeId: string, at: string): void {
  if (group.freeze) return;
  group.freeze = { frozenAt: at, frozenBy: employeeId, title: group.title, snapshotDigest: group.snapshot!.digest, files: structuredClone(group.files), srIds: [...group.srIds], dependencies: structuredClone(group.srDependencies ?? {}) };
  group.status = "frozen";
  group.developmentStartedAt ??= at;
}
