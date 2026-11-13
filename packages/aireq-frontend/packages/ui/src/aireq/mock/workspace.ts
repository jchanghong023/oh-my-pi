import type { AIReqWorkspace } from "../types.js";
import { prototypeDirectoryIssue } from "./recovery.js";
import type { AIReqSelection, AIReqWorkflowView } from "../types.js";
import { getEmployeeId } from "../identity.js";
import { readPrototypeDevelopmentRoot } from "./project-settings.js";
import { PROTOTYPE_BACKEND, prototypeCodeDevelopmentAllowed } from "./backend.js";
import { FREE_WORKSPACE_PREFIX, readPrototypeFreeChat } from "./free-chats.js";

/** 只解析已记录的工作区，不创建目录、不按当前查看人重绑 SR。 */
function resolveRecordedWorkspace(view: AIReqWorkflowView | undefined, selection: AIReqSelection): AIReqWorkspace {
 const project = view?.projects.find(item => item.id === selection.projectId);
 const identity = `aireq-ui-prototype:${selection.projectId ?? "unselected"}`;
 if (!project) return { kind: "unavailable", identity, error: view?.projects.length ? "所选项目不存在，请重新选择项目。" : "尚未添加项目，请先登记已有 Git 项目。" };
 if (selection.formalView || view?.groups.some(group => group.id === selection.irId)) return { kind: "reference", path: project.root, identity };
 if (!prototypeCodeDevelopmentAllowed() && view?.groups.some(item => item.id === selection.irId)) return { kind: "reference", path: project.root, identity: `${identity}:formal-materials:${getEmployeeId()}` };
 if (selection.freeDraftId) {
  const root = readPrototypeDevelopmentRoot(project.id);
  const key = JSON.stringify([PROTOTYPE_BACKEND.id, getEmployeeId(), project.id, root]);
  return root && selection.freeDraftId === key ? { kind: "free", path: root, identity: `${FREE_WORKSPACE_PREFIX}${project.id}:${getEmployeeId()}:${PROTOTYPE_BACKEND.id}:${root}` } : { kind: "unavailable", identity, error: "自由会话草稿的开发路径已变更，请重新点击新建会话。原草稿保留在原目录。" };
 }
 if (selection.freeSessionId) {
  const free = readPrototypeFreeChat(selection.freeSessionId);
  return free && free.meta.projectId === project.id ? { kind: "free", path: free.meta.workspacePath, identity: free.meta.workspaceIdentity ?? identity } : { kind: "unavailable", identity, error: "自由会话的目录记录不可用。" };
 }
 if (selection.proposalDraftId && !selection.irId) return { kind: "reference", path: project.root, identity };
 const proposal = view?.drafts.find(item => item.id === selection.irId);
 // IR／Agent／轮次只决定会话与相对材料路径，OMP 的项目 dir 和 workspace identity 不变。
 if (proposal) return proposal.proposalLocation?.directory === project.root ? { kind: "proposal", path: project.root, identity } : { kind: "unavailable", identity, error: "提案所属 OMP 项目目录记录缺失或不匹配。" };
 const group = [...(view?.groups ?? []), ...(view?.drafts ?? [])].find(item => item.id === selection.irId && item.projectId === project.id);
 if (selection.irId && !group) return { kind: "unavailable", identity, error: "所选需求已不存在或不属于当前项目。请返回项目选择已有需求。" };
 if (selection.irAcceptance) {
  const acceptance = group?.acceptance;
  return acceptance ? { kind: "development", path: acceptance.worktree.path, identity: `${identity}:ir-acceptance:${group.id}:${acceptance.employeeId}` } : { kind: "reference", path: project.root, identity: `${identity}:ir-acceptance:${group?.id}` };
 }
 // 入库不创建新 Agent 会话，也不改变原项目 dir；保留旧开发夹具的显式目录边界。
 if (!selection.srId && group?.proposalLocation) return { kind: "proposal", path: project.root, identity };
 const sr = view?.srs.find(item => item.id === selection.srId && item.irId === selection.irId);
 if (selection.srId && !sr) return { kind: "unavailable", identity, error: "所选 SR 已不存在或不属于当前需求。不会替换成其他 SR 的会话。" };
 if (sr && sr.status !== "pending") {
  const scopedIdentity = `${identity}:sr:${sr.id}:${sr.developerEmployeeId ?? "unknown"}`;
  if (!sr.worktree?.path || !sr.developmentRoot || !sr.developerEmployeeId || sr.worktree.path === project?.root) return { kind: "unavailable", identity: scopedIdentity, error: "该 SR 的固定开发目录记录不完整，请恢复原绑定；不会使用共享项目或当前查看人的目录。" };
  return { kind: "development", path: sr.worktree.path, identity: scopedIdentity };
 }
 return project ? { kind: "reference", path: project.root, identity } : { kind: "unavailable", identity, error: "请先选择有效项目。" };
}

export function resolvePrototypeWorkspace(view: AIReqWorkflowView | undefined, selection: AIReqSelection): AIReqWorkspace {
 const workspace = resolveRecordedWorkspace(view, selection);
 if (!workspace.path) return workspace;
 const issue = prototypeDirectoryIssue(workspace.path);
 return issue ? { ...workspace, kind: "unavailable", blockedPath: workspace.path, path: undefined, error: issue } : workspace;
}
