import type { DevDataSource } from "../packages/ui/src/dev/data-source.js";
import { DEFAULT_SELECTION, getPrototypeWorkflow, applyPrototypeAction, resolvePrototypeSession, prototypeWorkflowChanges } from "../packages/ui/src/dev/mock/workflow.js";
import { createPrototypeFreeChat, readPrototypeFreeChat, readRecentFreeChats, setPrototypeFreeProject, subscribePrototypeFreeChats } from "../packages/ui/src/dev/mock/free-chats.js";
import { resolvePrototypeWorkspace } from "../packages/ui/src/dev/mock/workspace.js";
import { retryPrototypeMaterialRead, retryPrototypeSessionRead, prototypeDirectoryIssue, restorePrototypeDirectorySample } from "../packages/ui/src/dev/mock/recovery.js";
import { readPrototypeDevelopmentRoot } from "../packages/ui/src/dev/mock/project-settings.js";
import { prototypeProjectDirectories, checkPrototypeProjectDirectory, checkPrototypeDevelopmentDirectory } from "../packages/ui/src/dev/mock/project-directories.js";
import { PROTOTYPE_AGENT_MODELS, readPrototypeAgentModels, savePrototypeAgentModels, createPrototypeAgentModelSamples, prototypeAgentModelConfigurationRevision, subscribePrototypeAgentModels, prototypeAgentModelBindingChanged } from "../packages/ui/src/dev/mock/agent-models.js";
import { readPrototypeAgentPrompts, updatePrototypeAgentPromptDrafts, savePrototypeAgentPrompts } from "../packages/ui/src/dev/mock/personalization.js";
import { prototypeSkillDesignSession, readPrototypeSkillDesign, savePrototypeSkillDesignDraft, onPrototypeSkillDesignSupplement, renderPrototypeSkillDesign, PROTOTYPE_SKILL_DESIGN_SAMPLE } from "../packages/ui/src/dev/mock/skill-design.js";
import { readPrototypeSkills, savePrototypeDesignedSkill } from "../packages/ui/src/dev/mock/skills.js";
import { getPrototypePeers } from "../packages/ui/src/dev/mock/collaboration.js";
import { readPrototypeProposalPrHandoff } from "../packages/ui/src/dev/mock/proposal-pr-handoff.js";
import { createPrototypeServices } from "./mock-services.js";

/** The preview is the sole composition root allowed to instantiate sample business data. */
export function createPrototypeDataSource(): DevDataSource {
  const services = createPrototypeServices();
  const subscriptions = new Set<() => void>();
  return {
    mode: "prototype", clientId: crypto.randomUUID(), initialSelection: { ...DEFAULT_SELECTION },
    capabilities: { workflowCommands: ["registerProject", "createRelease", "setDevelopmentRoot", "createProposal", "deleteRequirement", "submitProposalReview", "acceptProposal", "runRequirementsReview", "generateRequirements", "supplementRequirements", "generateProposalSolution", "returnProposal", "confirmProposal", "publishProposal", "markRequirementsPrSubmitted", "markCodePrSubmitted", "markRequirementsMerged", "beginProposalRevision", "recordRequirementsDecision", "markCodeMerged", "prepareSrDelivery", "publishSrDelivery", "verifySrDelivery", "resolveSrDeliveryConflict", "simulateSrDefaultBranchUpdate", "startSr", "startIrAcceptance", "generateIrAcceptanceReport", "repairIrAcceptance", "prepareIrFinalPr", "restartIrAcceptance", "simulateIrDefaultBranchUpdate", "publishIrFinalPr", "markIrFinalPrSubmitted", "verifyIrFinalMerge", "generateStageMaterials", "approveStage", "backStage", "stop"], prototypeBusiness: true, freeChat: true, nativeChat: true, nativeSurface: false },
    readWorkflow: async selection => getPrototypeWorkflow(selection),
    subscribeWorkflow(listener) {
      const subscription = prototypeWorkflowChanges.event(listener);
      const dispose = () => { subscription.dispose(); subscriptions.delete(dispose); };
      subscriptions.add(dispose); return dispose;
    },
    command: async (action, selection) => applyPrototypeAction(action, selection),
    resolveSession: resolvePrototypeSession,
    retryMaterial: async path => retryPrototypeMaterialRead(path),
    retrySession: async selection => { const session = resolvePrototypeSession(getPrototypeWorkflow(selection), selection); if (session) retryPrototypeSessionRead(session.sessionId); },
    createFreeChat: async projectId => { const meta = createPrototypeFreeChat(projectId); return { projectId, taskId: meta.taskId }; },
    readFreeChat: async taskId => { const item = readPrototypeFreeChat(taskId); return item?.meta.projectId ? { projectId: item.meta.projectId, taskId } : undefined; },
    readRecentFreeChats: async projectId => readRecentFreeChats(projectId),
    selectProject: setPrototypeFreeProject,
    resolveWorkspace: resolvePrototypeWorkspace,
    connectWorkspace: async () => ({ services, dispose() { /* No external workspace resources in the in-memory preview. */ } }),
    dispose() { for (const dispose of subscriptions) dispose(); },
    projects: { readDevelopmentRoot: readPrototypeDevelopmentRoot, listDirectories: prototypeProjectDirectories, checkProjectDirectory: async (path, roots) => checkPrototypeProjectDirectory(path, roots), checkDevelopmentDirectory: async (path, root) => checkPrototypeDevelopmentDirectory(path, root) },
    models: { choices: PROTOTYPE_AGENT_MODELS, read: readPrototypeAgentModels, save: savePrototypeAgentModels, samples: createPrototypeAgentModelSamples, revision: prototypeAgentModelConfigurationRevision, subscribe: subscribePrototypeAgentModels, bindingChanged: prototypeAgentModelBindingChanged },
    prompts: { read: readPrototypeAgentPrompts, updateDraft: updatePrototypeAgentPromptDrafts, save: savePrototypeAgentPrompts },
    skillDesign: { session: prototypeSkillDesignSession, workspaceIdentity: projectId => `dev-ui-prototype:${projectId}`,  read: readPrototypeSkillDesign, saveDraft: savePrototypeSkillDesignDraft, subscribe: onPrototypeSkillDesignSupplement, render: renderPrototypeSkillDesign, listSkills: readPrototypeSkills, saveSkill: savePrototypeDesignedSkill, sample: PROTOTYPE_SKILL_DESIGN_SAMPLE },
    collaboration: { peers: getPrototypePeers }, freeChats: { subscribe: subscribePrototypeFreeChats },
    prototype: { directoryIssue: prototypeDirectoryIssue, restoreDirectory: restorePrototypeDirectorySample, readPrHandoff: readPrototypeProposalPrHandoff },
  };
}
