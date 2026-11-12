import { getEmployeeId } from "../identity.js";
import type { DevBackendView } from "../data-source.js";

// 单个共享 Web 的固定启动者样例；切换访问工号不切换后端、Token 或 profile。
export const PROTOTYPE_BACKEND: DevBackendView = {
  id: "local-j00808874", kind: "team", owner: "j00808874", name: "共享 OMP Web", configDirectory: "/demo/developers/j00808874/.omp/agent", userSkillsDirectory: "/demo/developers/j00808874/.omp/agent/skills",
};
export function prototypeProposalDiscussionAllowed(): boolean { return PROTOTYPE_BACKEND.owner === "j00808874"; }
export function prototypeCodeDevelopmentAllowed(): boolean { return PROTOTYPE_BACKEND.kind === "developer" && getEmployeeId() === PROTOTYPE_BACKEND.owner; }

export function prototypeSettingsWriteAllowed(): boolean { return getEmployeeId() === PROTOTYPE_BACKEND.owner; }
export function requirePrototypeSettingsWrite(): void { if (!prototypeSettingsWriteAllowed()) throw new Error("当前账号只读；外观和 Skill 设计所有人可用，其他设置仅启动此 OMP Web 的人可修改。"); }
