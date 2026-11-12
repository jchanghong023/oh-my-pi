import { createPrototypeIssues } from "./prototype-issues.js";
import { proposalDeliveryCurrent } from "../packages/ui/src/aireq/domain.js";
import {
	PROTOTYPE_BACKEND,
	prototypeProposalDiscussionAllowed,
	prototypeCodeDevelopmentAllowed,
	prototypeSettingsWriteAllowed,
} from "../packages/ui/src/aireq/mock/backend.js";
import { getEmployeeId } from "../packages/ui/src/aireq/identity.js";
import type { AIReqAction } from "../packages/ui/src/aireq/types.js";
import type { AIReqDataSource } from "../packages/ui/src/aireq/data-source.js";
import {
	DEFAULT_SELECTION,
	getPrototypeWorkflow,
	applyPrototypeAction,
	resolvePrototypeSession,
	prototypeWorkflowChanges,
	notifyPrototypeProjectSettingsChanged,
	pollPrototypeProposalMerges,
	setPrototypeProposalMergeScenario,
} from "../packages/ui/src/aireq/mock/workflow.js";
import {
	createPrototypeFreeChat,
	readPrototypeFreeChat,
	readRecentFreeChats,
	setPrototypeFreeProject,
	subscribePrototypeFreeChats,
} from "../packages/ui/src/aireq/mock/free-chats.js";
import { resolvePrototypeWorkspace } from "../packages/ui/src/aireq/mock/workspace.js";
import {
	retryPrototypeMaterialRead,
	retryPrototypeSessionRead,
	prototypeDirectoryIssue,
	restorePrototypeDirectorySample,
} from "../packages/ui/src/aireq/mock/recovery.js";
import {
	readPrototypeDevelopmentRoot,
	checkPrototypeSharedProjectDirectory,
	savePrototypeRepository,
} from "../packages/ui/src/aireq/mock/project-settings.js";
import {
	prototypeProjectDirectories,
	checkPrototypeProjectDirectory,
	checkPrototypeDevelopmentDirectory,
} from "../packages/ui/src/aireq/mock/project-directories.js";
import {
	PROTOTYPE_AGENT_MODELS,
	readPrototypeAgentModels,
	savePrototypeAgentModels,
	createPrototypeAgentModelSamples,
	prototypeAgentModelConfigurationRevision,
	subscribePrototypeAgentModels,
	prototypeAgentModelBindingChanged,
} from "../packages/ui/src/aireq/mock/agent-models.js";
import {
	readPrototypeAgentPrompts,
	updatePrototypeAgentPromptDrafts,
	savePrototypeAgentPrompts,
} from "../packages/ui/src/aireq/mock/personalization.js";
import {
	prototypeSkillDesignSession,
	prototypeSkillDesignBinding,
	readPrototypeSkillDesign,
	savePrototypeSkillDesignDraft,
	onPrototypeSkillDesignSupplement,
	preparePrototypeSkillDesignPrompt,
	prototypeSkillDesignDirectory,
	readPrototypeSkillDesignPreview,
	savePrototypeSkillDesignPreview,
	PROTOTYPE_SKILL_DESIGN_SAMPLE,
} from "../packages/ui/src/aireq/mock/skill-design.js";
import { readPrototypeSkills } from "../packages/ui/src/aireq/mock/skills.js";
import { getPrototypePeers } from "../packages/ui/src/aireq/mock/collaboration.js";
import { readPrototypeProposalPrHandoff } from "../packages/ui/src/aireq/mock/proposal-pr-handoff.js";
import { createPrototypeServices } from "./mock-services.js";
import {
	withPrototypeProgress,
	assignPrototypeIrOwner,
	updatePrototypeSrProgress,
} from "../packages/ui/src/aireq/mock/progress.js";
import { withPrototypePlanning, updatePrototypeSrPlanning } from "../packages/ui/src/aireq/mock/planning.js";
import { createPrototypeProgressScheduler } from "../packages/ui/src/aireq/mock/progress-scheduler.js";

/** One in-memory composition per backend scenario worker, never per browser. */
export function createPrototypeDataSource(): AIReqDataSource {
	const services = createPrototypeServices();
	const issues = createPrototypeIssues();
	const progressScheduler = createPrototypeProgressScheduler({
		scaleDemo: process.env.OMP_AIREQ_BACKEND_SCENARIO === "analysis-scale",
	});
	const subscriptions = new Set<() => void>();
	const mergeTimer = setInterval(pollPrototypeProposalMerges, 5000);
	const proposalActions = new Set<AIReqAction["type"]>([
		"createProposal",
		"submitProposalReview",
		"acceptProposal",
		"runRequirementsReview",
		"generateRequirements",
		"supplementRequirements",
		"generateProposalSolution",
		"returnProposal",
		"recordRequirementsDecision",
		"confirmProposal",
		"publishProposal",
		"markRequirementsPrSubmitted",
		"markRequirementsMerged",
	]);
	const settingsActions = new Set<AIReqAction["type"]>(["registerProject", "createRelease", "setSharedProjectRoot"]);
	const allowed = (type: AIReqAction["type"]) =>
		(type === "markRequirementsMerged" || type === "markRequirementsPrSubmitted")
			? false
			: settingsActions.has(type)
				? prototypeSettingsWriteAllowed()
				: type === "deleteRequirement"
					? prototypeProposalDiscussionAllowed()
					: type === "beginProposalRevision" || type === "recordRequirementsDecision"
						? false
						: proposalActions.has(type)
							? prototypeProposalDiscussionAllowed()
							: prototypeCodeDevelopmentAllowed();
	return {
		provenance: { kind: "sample", notice: "当前数据为后端内存样例，服务重启后恢复初始状态。" },
		backend: PROTOTYPE_BACKEND,
		clientId: crypto.randomUUID(),
		initialSelection: { ...DEFAULT_SELECTION },
		serviceManifest: Object.fromEntries(Object.entries(services).map(([key, service]) => [key, Object.keys(service ?? {}).filter(name => typeof (service as Record<string, unknown>)[name] === "function")])),
		capabilities: {
			get settingsWrite() {
				return prototypeSettingsWriteAllowed();
			},
			get proposalDiscussion() {
				return prototypeProposalDiscussionAllowed();
			},
			get codeDevelopment() {
				return prototypeCodeDevelopmentAllowed();
			},
			get workflowCommands() {
				return (
					[
						"registerProject",
						"createRelease",
						"setDevelopmentRoot",
						"setSharedProjectRoot",
						"createProposal",
						"deleteRequirement",
						"submitProposalReview",
						"acceptProposal",
						"runRequirementsReview",
						"generateRequirements",
						"supplementRequirements",
						"generateProposalSolution",
						"returnProposal",
						"confirmProposal",
						"publishProposal",
						"markRequirementsPrSubmitted",
						"markCodePrSubmitted",
						"markRequirementsMerged",
						"beginProposalRevision",
						"recordRequirementsDecision",
						"markCodeMerged",
						"prepareSrDelivery",
						"publishSrDelivery",
						"verifySrDelivery",
						"resolveSrDeliveryConflict",
						"simulateSrDefaultBranchUpdate",
						"startSr",
						"startIrAcceptance",
						"generateIrAcceptanceReport",
						"repairIrAcceptance",
						"prepareIrFinalPr",
						"restartIrAcceptance",
						"simulateIrDefaultBranchUpdate",
						"publishIrFinalPr",
						"markIrFinalPrSubmitted",
						"verifyIrFinalMerge",
						"generateStageMaterials",
						"approveStage",
						"backStage",
						"stop",
					] as AIReqAction["type"][]
				).filter(allowed);
			},
			requirementManagement: true,
			freeChat: true,
			nativeChat: true,
			nativeSurface: false,
		},
		readWorkflow: async selection => {
			const view = withPrototypePlanning(withPrototypeProgress(getPrototypeWorkflow(selection)));
			setPrototypeFreeProject(selection.projectId);
			if (selection.projectId && view.projects.some(project => project.id === selection.projectId))
				readRecentFreeChats(selection.projectId);
			return view;
		},
		subscribeWorkflow(listener) {
			const subscription = prototypeWorkflowChanges.event(listener);
			const dispose = () => {
				subscription.dispose();
				subscriptions.delete(dispose);
			};
			subscriptions.add(dispose);
			return dispose;
		},
		command: async (action, selection) => {
			if (!allowed(action.type))
				throw new Error(
					proposalActions.has(action.type)
						? "提案只读：请进入 j00808874 所有的 Web 讨论或修改。"
						: "改项目或执行 Git 须使用自己的 omp aireq_web，并配置自己的 Git 项目路径。",
				);
			const view = getPrototypeWorkflow(selection);
			if (
				!["setSharedProjectRoot", "setDevelopmentRoot", "registerProject", "createRelease"].includes(action.type) &&
				view.drafts.some(
					item => item.id === ("irId" in action ? (action.irId ?? selection.irId) : selection.irId),
				) &&
				!prototypeProposalDiscussionAllowed()
			)
				throw new Error("提案在本 Web 只读，请进入 j00808874 的 Web 讨论、确认或提交推送。");
			return applyPrototypeAction(action, selection);
		},
		resolveSession: (view, selection) => {
			if (selection.formalView || view.groups.some(group => group.id === selection.irId)) return undefined;
			if (selection.proposalStep === "intake") return undefined;
			const proposal = view.drafts.find(item => item.id === selection.irId);
			if (proposal && selection.srId) return undefined;
			if (
				proposal &&
				!selection.proposalStep &&
				!selection.discussionPhase &&
				(proposalDeliveryCurrent(proposal) || proposal.status === "requirements-pr")
			)
				return undefined;
			if (!selection.srId && !selection.irAcceptance && view.groups.some(item => item.id === selection.irId))
				return undefined;
			// 访客只浏览正式需求材料；同一 Web 的 Token 不意味着可读取所有者的开发聊天。
			if (!prototypeCodeDevelopmentAllowed() && view.groups.some(item => item.id === selection.irId))
				return undefined;
			if (view.drafts.some(item => item.id === selection.irId) && !prototypeProposalDiscussionAllowed())
				return undefined;
			return resolvePrototypeSession(view, selection);
		},
		retryMaterial: async path => retryPrototypeMaterialRead(path),
		retrySession: async selection => {
			const view = getPrototypeWorkflow(selection);
			if (!prototypeCodeDevelopmentAllowed() && view.groups.some(item => item.id === selection.irId)) return;
			const group = [...view.groups, ...view.drafts].find(item => item.id === selection.irId);
			const sr = view.srs.find(item => item.id === selection.srId && item.irId === selection.irId);
			const session = resolvePrototypeSession(
				{ ...view, sessions: sr?.sessions ?? group?.sessions ?? [] },
				selection,
			);
			if (session) retryPrototypeSessionRead(session.sessionId);
		},
		createFreeChat: async projectId => {
			if (!prototypeCodeDevelopmentAllowed() || !readPrototypeDevelopmentRoot(projectId, PROTOTYPE_BACKEND.owner))
				throw new Error("请使用自己的 Web 并配置本项目的 Git 开发路径。");
			const meta = createPrototypeFreeChat(projectId);
			return { projectId, taskId: meta.taskId };
		},
		readFreeChat: async taskId => {
			if (!prototypeCodeDevelopmentAllowed()) return undefined;
			const item = readPrototypeFreeChat(taskId);
			return item?.meta.projectId ? { projectId: item.meta.projectId, taskId } : undefined;
		},
		readRecentFreeChats: async projectId => readRecentFreeChats(projectId),
		selectProject: setPrototypeFreeProject,
		resolveWorkspace: resolvePrototypeWorkspace,
		connectWorkspace: async () => ({
			services,
			dispose() {
				/* No external workspace resources in the in-memory preview. */
			},
		}),
		dispose() {
			clearInterval(mergeTimer);
			progressScheduler.dispose();
			issues.dispose();
			for (const dispose of subscriptions) dispose();
		},
		progress: { assignOwner: assignPrototypeIrOwner, updateSr: updatePrototypeSrProgress },
		issues,
		progressScheduler,
		employeeDirectory: {
			kind: "sample",
			entries: [
				{ employeeId: "j00808874", name: "林晨", department: "平台研发部" },
				{ employeeId: "j00808875", name: "陈宁", department: "平台研发部" },
				{ employeeId: "j00808876", name: "陈宁", department: "芯片验证部" },
				{ employeeId: "j00808877", name: "周敏", department: "芯片验证部" },
			],
		},
		planning: { updateSr: updatePrototypeSrPlanning },
		projects: {
			saveRepository: async input => {
				if (!prototypeSettingsWriteAllowed()) throw new Error("仅启动此 OMP Web 的人可修改项目配置。");
				savePrototypeRepository(input);
				notifyPrototypeProjectSettingsChanged();
			},
			readDevelopmentRoot: readPrototypeDevelopmentRoot,
			listDirectories: prototypeProjectDirectories,
			checkProjectDirectory: async (path, roots) => checkPrototypeProjectDirectory(path, roots),
			checkDevelopmentDirectory: async (path, root) => checkPrototypeDevelopmentDirectory(path, root),
			checkSharedProjectDirectory: async (path, projectId) => checkPrototypeSharedProjectDirectory(path, projectId),
		},
		models: {
			choices: PROTOTYPE_AGENT_MODELS,
			read: readPrototypeAgentModels,
			save: savePrototypeAgentModels,
			samples: createPrototypeAgentModelSamples,
			revision: prototypeAgentModelConfigurationRevision,
			subscribe: subscribePrototypeAgentModels,
			bindingChanged: prototypeAgentModelBindingChanged,
		},
		prompts: {
			read: readPrototypeAgentPrompts,
			updateDraft: updatePrototypeAgentPromptDrafts,
			save: savePrototypeAgentPrompts,
		},
		skills: { list: params => services.skillsService.list(params) },
		skillDesign: {
			session: prototypeSkillDesignSession,
			binding: prototypeSkillDesignBinding,
			workspaceIdentity: projectId => `aireq-ui-prototype:${PROTOTYPE_BACKEND.id}:${projectId}`,
			read: readPrototypeSkillDesign,
			saveDraft: savePrototypeSkillDesignDraft,
			subscribe: onPrototypeSkillDesignSupplement,
			prompt: preparePrototypeSkillDesignPrompt,
			temporaryDirectory: prototypeSkillDesignDirectory,
			readPreview: readPrototypeSkillDesignPreview,
			listSkills: readPrototypeSkills,
			savePreview: savePrototypeSkillDesignPreview,
			sample: PROTOTYPE_SKILL_DESIGN_SAMPLE,
		},
		collaboration: { peers: getPrototypePeers },
		freeChats: { subscribe: subscribePrototypeFreeChats },
		readPrHandoff: async group => readPrototypeProposalPrHandoff(group),
		prototype: {
			setProposalMergeScenario: (projectId, irId, scenario) => {
				if (!prototypeProposalDiscussionAllowed()) throw new Error("当前 Web 只读，不能切换提案演示场景。");
				setPrototypeProposalMergeScenario(projectId, irId, scenario);
			},
			directoryIssue: prototypeDirectoryIssue,
			restoreDirectory: restorePrototypeDirectorySample,
			readPrHandoff: readPrototypeProposalPrHandoff,
		},
	};
}
