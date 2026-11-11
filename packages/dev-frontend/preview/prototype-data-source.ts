import { proposalDeliveryCurrent } from "../packages/ui/src/dev/domain.js";
import { PROTOTYPE_BACKEND, prototypeProposalDiscussionAllowed, prototypeCodeDevelopmentAllowed, prototypeSettingsWriteAllowed } from "../packages/ui/src/dev/mock/backend.js";
import { getEmployeeId } from "../packages/ui/src/dev/identity.js";
import type { DevAction } from "../packages/ui/src/dev/types.js";
import type { DevDataSource } from "../packages/ui/src/dev/data-source.js";
import { DEFAULT_SELECTION, getPrototypeWorkflow, applyPrototypeAction, resolvePrototypeSession, prototypeWorkflowChanges } from "../packages/ui/src/dev/mock/workflow.js";
import { createPrototypeFreeChat, readPrototypeFreeChat, readRecentFreeChats, setPrototypeFreeProject, subscribePrototypeFreeChats } from "../packages/ui/src/dev/mock/free-chats.js";
import { resolvePrototypeWorkspace } from "../packages/ui/src/dev/mock/workspace.js";
import { retryPrototypeMaterialRead, retryPrototypeSessionRead, prototypeDirectoryIssue, restorePrototypeDirectorySample } from "../packages/ui/src/dev/mock/recovery.js";
import { readPrototypeDevelopmentRoot, checkPrototypeSharedProjectDirectory } from "../packages/ui/src/dev/mock/project-settings.js";
import { prototypeProjectDirectories, checkPrototypeProjectDirectory, checkPrototypeDevelopmentDirectory } from "../packages/ui/src/dev/mock/project-directories.js";
import { PROTOTYPE_AGENT_MODELS, readPrototypeAgentModels, savePrototypeAgentModels, createPrototypeAgentModelSamples, prototypeAgentModelConfigurationRevision, subscribePrototypeAgentModels, prototypeAgentModelBindingChanged } from "../packages/ui/src/dev/mock/agent-models.js";
import { readPrototypeAgentPrompts, updatePrototypeAgentPromptDrafts, savePrototypeAgentPrompts } from "../packages/ui/src/dev/mock/personalization.js";
import { prototypeSkillDesignSession, prototypeSkillDesignBinding, readPrototypeSkillDesign, savePrototypeSkillDesignDraft, onPrototypeSkillDesignSupplement, preparePrototypeSkillDesignPrompt, prototypeSkillDesignDirectory, readPrototypeSkillDesignPreview, savePrototypeSkillDesignPreview, PROTOTYPE_SKILL_DESIGN_SAMPLE } from "../packages/ui/src/dev/mock/skill-design.js";
import { readPrototypeSkills } from "../packages/ui/src/dev/mock/skills.js";
import { getPrototypePeers } from "../packages/ui/src/dev/mock/collaboration.js";
import { readPrototypeProposalPrHandoff } from "../packages/ui/src/dev/mock/proposal-pr-handoff.js";
import { createPrototypeServices } from "./mock-services.js";

/** The preview is the sole composition root allowed to instantiate sample business data. */
export function createPrototypeDataSource(): DevDataSource {
  const services = createPrototypeServices();
  const subscriptions = new Set<() => void>();
  const proposalActions = new Set<DevAction["type"]>(["createProposal", "submitProposalReview", "acceptProposal", "runRequirementsReview", "generateRequirements", "supplementRequirements", "generateProposalSolution", "returnProposal", "recordRequirementsDecision", "confirmProposal", "publishProposal", "markRequirementsPrSubmitted", "markRequirementsMerged"]);
  const gitProposalActions = new Set<DevAction["type"]>(["confirmProposal", "publishProposal", "markRequirementsPrSubmitted", "markRequirementsMerged"]);
  const allowed = (type: DevAction["type"]) => type === "setSharedProjectRoot" ? getEmployeeId() === "j00808874" : type === "deleteRequirement" ? prototypeProposalDiscussionAllowed() && prototypeCodeDevelopmentAllowed() : (type === "beginProposalRevision" || type === "recordRequirementsDecision") ? false : proposalActions.has(type) ? (gitProposalActions.has(type) ? prototypeCodeDevelopmentAllowed() : prototypeProposalDiscussionAllowed()) : prototypeCodeDevelopmentAllowed();
  return {
    mode: "prototype", backend: PROTOTYPE_BACKEND, clientId: crypto.randomUUID(), initialSelection: { ...DEFAULT_SELECTION },
    capabilities: { get settingsWrite() { return prototypeSettingsWriteAllowed(); }, get proposalDiscussion() { return prototypeProposalDiscussionAllowed(); }, get codeDevelopment() { return prototypeCodeDevelopmentAllowed(); }, get workflowCommands() { return (["registerProject", "createRelease", "setDevelopmentRoot", "setSharedProjectRoot", "createProposal", "deleteRequirement", "submitProposalReview", "acceptProposal", "runRequirementsReview", "generateRequirements", "supplementRequirements", "generateProposalSolution", "returnProposal", "confirmProposal", "publishProposal", "markRequirementsPrSubmitted", "markCodePrSubmitted", "markRequirementsMerged", "beginProposalRevision", "recordRequirementsDecision", "markCodeMerged", "prepareSrDelivery", "publishSrDelivery", "verifySrDelivery", "resolveSrDeliveryConflict", "simulateSrDefaultBranchUpdate", "startSr", "startIrAcceptance", "generateIrAcceptanceReport", "repairIrAcceptance", "prepareIrFinalPr", "restartIrAcceptance", "simulateIrDefaultBranchUpdate", "publishIrFinalPr", "markIrFinalPrSubmitted", "verifyIrFinalMerge", "generateStageMaterials", "approveStage", "backStage", "stop"] as DevAction["type"][]).filter(allowed); }, prototypeBusiness: true, freeChat: true, nativeChat: true, nativeSurface: false },
    readWorkflow: async selection => {
      const view = getPrototypeWorkflow(selection);
      setPrototypeFreeProject(selection.projectId);
      if (selection.projectId && view.projects.some(project => project.id === selection.projectId)) readRecentFreeChats(selection.projectId);
      return view;
    },
    subscribeWorkflow(listener) {
      const subscription = prototypeWorkflowChanges.event(listener);
      const dispose = () => { subscription.dispose(); subscriptions.delete(dispose); };
      subscriptions.add(dispose); return dispose;
    },
    command: async (action, selection) => {
      if (!allowed(action.type)) throw new Error(proposalActions.has(action.type) ? "提案只读：请进入 j00808874 所有的 Web 讨论或修改。" : "改项目或执行 Git 须使用自己的 omp dev_web，并配置自己的 Git 项目路径。");
      const view = getPrototypeWorkflow(selection);
      if (!["setSharedProjectRoot", "setDevelopmentRoot", "registerProject", "createRelease"].includes(action.type) && view.drafts.some(item => item.id === ("irId" in action ? action.irId ?? selection.irId : selection.irId)) && !prototypeProposalDiscussionAllowed() && !gitProposalActions.has(action.type)) throw new Error("提案讨论在本 Web 只读，请进入 j00808874 的 Web；入库须使用自己的 Web 和开发项目。");
      if (gitProposalActions.has(action.type) && !readPrototypeDevelopmentRoot(selection.projectId ?? "", PROTOTYPE_BACKEND.owner)) throw new Error("执行 Git 前请先配置自己的开发项目路径。");
      return applyPrototypeAction(action, selection);
    },
    resolveSession: (view, selection) => {
      if (selection.proposalStep === "intake") return undefined;
      const proposal = view.drafts.find(item => item.id === selection.irId);
      if (proposal && selection.srId) return undefined;
      if (proposal && !selection.proposalStep && !selection.discussionPhase && (proposalDeliveryCurrent(proposal) || proposal.status === "requirements-pr")) return undefined;
      if (!selection.srId && !selection.irAcceptance && view.groups.some(item => item.id === selection.irId)) return undefined;
      // 访客只浏览正式需求材料；同一 Web 的 Token 不意味着可读取所有者的开发聊天。
      if (!prototypeCodeDevelopmentAllowed() && view.groups.some(item => item.id === selection.irId)) return undefined;
      if (view.drafts.some(item => item.id === selection.irId) && !prototypeProposalDiscussionAllowed()) return undefined;
      return resolvePrototypeSession(view, selection);
    },
    retryMaterial: async path => retryPrototypeMaterialRead(path),
    retrySession: async selection => {
      const view = getPrototypeWorkflow(selection);
      if (!prototypeCodeDevelopmentAllowed() && view.groups.some(item => item.id === selection.irId)) return;
      const group = [...view.groups, ...view.drafts].find(item => item.id === selection.irId);
      const sr = view.srs.find(item => item.id === selection.srId && item.irId === selection.irId);
      const session = resolvePrototypeSession({ ...view, sessions: sr?.sessions ?? group?.sessions ?? [] }, selection);
      if (session) retryPrototypeSessionRead(session.sessionId);
    },
    createFreeChat: async projectId => { if (!prototypeCodeDevelopmentAllowed() || !readPrototypeDevelopmentRoot(projectId, PROTOTYPE_BACKEND.owner)) throw new Error("请使用自己的 Web 并配置本项目的 Git 开发路径。"); const meta = createPrototypeFreeChat(projectId); return { projectId, taskId: meta.taskId }; },
    readFreeChat: async taskId => { if (!prototypeCodeDevelopmentAllowed()) return undefined; const item = readPrototypeFreeChat(taskId); return item?.meta.projectId ? { projectId: item.meta.projectId, taskId } : undefined; },
    readRecentFreeChats: async projectId => readRecentFreeChats(projectId),
    selectProject: setPrototypeFreeProject,
    resolveWorkspace: resolvePrototypeWorkspace,
    connectWorkspace: async () => ({ services, dispose() { /* No external workspace resources in the in-memory preview. */ } }),
    dispose() { for (const dispose of subscriptions) dispose(); },
    projects: { readDevelopmentRoot: readPrototypeDevelopmentRoot, listDirectories: prototypeProjectDirectories, checkProjectDirectory: async (path, roots) => checkPrototypeProjectDirectory(path, roots), checkDevelopmentDirectory: async (path, root) => checkPrototypeDevelopmentDirectory(path, root), checkSharedProjectDirectory: async (path, projectId) => checkPrototypeSharedProjectDirectory(path, projectId) },
    models: { choices: PROTOTYPE_AGENT_MODELS, read: readPrototypeAgentModels, save: savePrototypeAgentModels, samples: createPrototypeAgentModelSamples, revision: prototypeAgentModelConfigurationRevision, subscribe: subscribePrototypeAgentModels, bindingChanged: prototypeAgentModelBindingChanged },
    prompts: { read: readPrototypeAgentPrompts, updateDraft: updatePrototypeAgentPromptDrafts, save: savePrototypeAgentPrompts },
    skillDesign: { session: prototypeSkillDesignSession, binding: prototypeSkillDesignBinding, workspaceIdentity: projectId => `dev-ui-prototype:${PROTOTYPE_BACKEND.id}:${projectId}`,  read: readPrototypeSkillDesign, saveDraft: savePrototypeSkillDesignDraft, subscribe: onPrototypeSkillDesignSupplement, prompt: preparePrototypeSkillDesignPrompt, temporaryDirectory: prototypeSkillDesignDirectory, readPreview: readPrototypeSkillDesignPreview, listSkills: readPrototypeSkills, savePreview: savePrototypeSkillDesignPreview, sample: PROTOTYPE_SKILL_DESIGN_SAMPLE },
    collaboration: { peers: getPrototypePeers }, freeChats: { subscribe: subscribePrototypeFreeChats },
    prototype: { directoryIssue: prototypeDirectoryIssue, restoreDirectory: restorePrototypeDirectorySample, readPrHandoff: readPrototypeProposalPrHandoff },
  };
}
