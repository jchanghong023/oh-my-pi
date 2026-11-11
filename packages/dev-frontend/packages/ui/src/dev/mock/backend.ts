import { getEmployeeId } from "../identity.js";
import type { DevBackendView } from "../data-source.js";

// 仅切换静态入口样例，不连接真实后端，不读取或切换任何 Token。
const selected = new URLSearchParams(location.search).get("backend");
const owner = selected === "colleague" ? "j00808875" : "j00808874";
export const PROTOTYPE_BACKEND: DevBackendView = selected === "team" ? {
  id: "local-j00808874", kind: "team", owner: "j00808874", name: "A 的 Web · 业务访问样例", configDirectory: "/demo/developers/j00808874/.omp/agent", userSkillsDirectory: "/demo/developers/j00808874/.omp/agent/skills",
} : {
  id: `local-${owner}`, kind: "developer", owner, name: `${owner} 的本地 OMP Dev`, configDirectory: `/demo/developers/${owner}/.omp/agent`, userSkillsDirectory: `/demo/developers/${owner}/.omp/agent/skills`,
};
export function prototypeProposalDiscussionAllowed(): boolean { return PROTOTYPE_BACKEND.owner === "j00808874"; }
export function prototypeCodeDevelopmentAllowed(): boolean { return PROTOTYPE_BACKEND.kind === "developer" && getEmployeeId() === PROTOTYPE_BACKEND.owner; }

export function prototypeSettingsWriteAllowed(): boolean { return getEmployeeId() === PROTOTYPE_BACKEND.owner; }
export function requirePrototypeSettingsWrite(): void { if (!prototypeSettingsWriteAllowed()) throw new Error("当前账号只读，只有当前 Web 的所有者可修改模型、个性化和技能；请启动自己的 OMP Web 修改自己的配置。"); }
