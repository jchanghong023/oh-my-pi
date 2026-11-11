/** 独立原型的可复现故障样例；不探测或修改真实目录／网络。 */
export const PROTOTYPE_RECOVERY_SCENARIOS = ["proposal-feedback", "proposal-intake", "sr-delivery", "requirements-review", "proposal-freeze", "parallel-admission", "ir-acceptance", "empty-projects", "empty-releases", "empty-requirements", "missing-requirement", "missing-sr", "missing-directory", "unreadable-directory", "wrong-repository", "missing-material", "material-read-failure", "session-read-failure", "send-failure", "operation-failure"] as const;
export type PrototypeRecoveryScenario = typeof PROTOTYPE_RECOVERY_SCENARIOS[number];
const requested = typeof location !== "undefined" ? new URLSearchParams(location.search).get("demo") : null;
export const prototypeRecoveryScenario = PROTOTYPE_RECOVERY_SCENARIOS.find(item => item === requested);
const defaultWorktree = "/demo/j00808874/aurora-console/.worktrees/sr-auth";
interface DirectoryIssue { message: string }
const directories = new Map<string, DirectoryIssue>();
if (prototypeRecoveryScenario === "missing-directory") directories.set(defaultWorktree, { message: "开发目录不存在（故障样例）。请恢复原 worktree 后重试，不能改用共享目录。" });
if (prototypeRecoveryScenario === "unreadable-directory") directories.set(defaultWorktree, { message: "无法访问开发目录（故障样例）。请恢复原目录的访问条件后重试。" });
if (prototypeRecoveryScenario === "wrong-repository") directories.set(defaultWorktree, { message: "开发目录的仓库与 SR 不匹配（故障样例），已阻止进入。" });
export function prototypeDirectoryIssue(path: string): string | undefined { return [...directories].find(([root]) => path === root || path.startsWith(`${root}/`))?.[1].message; }
export function restorePrototypeDirectorySample(path: string): void { directories.delete(path); }
interface MaterialIssue { message: string; transient: boolean }
const materials = new Map<string, MaterialIssue>();
const defaultPlan = "development/ir-auth/sr-auth/round-1/plan.md";
if (prototypeRecoveryScenario === "missing-material") materials.set(defaultPlan, { message: "材料文件缺失（故障样例）；元数据保留，不能复制、下载或用于阶段批准。", transient: false });
if (prototypeRecoveryScenario === "material-read-failure") materials.set(defaultPlan, { message: "材料读取失败（故障样例）。可重新读取，当前内容不会被其他材料替代。", transient: true });
export function prototypeMaterialIssue(path: string): string | undefined { return materials.get(path)?.message; }
export function retryPrototypeMaterialRead(path: string): boolean {
 if (materials.get(path)?.transient) materials.delete(path);
 return !materials.has(path);
}
export function clearPrototypeMaterialIssue(path: string): void { materials.delete(path); }
let sendFailureRemaining = prototypeRecoveryScenario === "send-failure";
export function consumePrototypeSendFailure(): boolean { const fail = sendFailureRemaining; sendFailureRemaining = false; return fail; }
let operationFailureRemaining = prototypeRecoveryScenario === "operation-failure";
export function consumePrototypeOperationFailure(type: string): boolean {
 if (!operationFailureRemaining || type !== "returnProposal") return false;
 operationFailureRemaining = false; return true;
}

const sessionIssues = new Set<string>(prototypeRecoveryScenario === "session-read-failure" ? ["demo-aurora-ir-auth-sr-auth-planning"] : []);
export function prototypeSessionReadIssue(sessionId: string): boolean { return sessionIssues.has(sessionId); }
export function retryPrototypeSessionRead(sessionId: string): void { sessionIssues.delete(sessionId); }
