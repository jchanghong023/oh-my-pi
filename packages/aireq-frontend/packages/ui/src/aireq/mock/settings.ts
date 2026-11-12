import { prototypeAgentModelSelection } from "./agent-models.js";
import { resolvePrototypeWorkspace } from "./workspace.js";
import type { IServiceAccessor, ModelSelectionView, ProviderSettingsView } from "@zcode/services";
import type { AppSettings, ModelSelection } from "@zcode/shared";
import type { ProviderSettingsProviderView, RegistryModelConfigObject } from "@zcode/provider";
import { createPrototypeModelSettingsView } from "./model-settings.js";
import { createPrototypeEvent } from "./events.js";
import { getPrototypeWorkflow } from "./workflow.js";
import { prototypeSkillDesignBinding } from "./skill-design.js";

export const PROTOTYPE_MODEL_SELECTION: ModelSelection = { providerId: "prototype-opencode-go", modelId: "Beam Free", options: { reasoningLevel: "standard" } };
export const PROTOTYPE_SETTINGS: AppSettings = {
  locale: "zh-CN", localePreference: "zh-CN", recentProjects: ["/demo/aurora-console", "/demo/mobile-console"],
  settingsSyncFirstRunPromptHandled: true, startPlanRecommendationDismissed: true,
  messageStreamShowReasoning: true, messageStreamShowReasoningMigrationInitialized: true,
  messageStreamShowTodos: true, zcodeInteractionBehavior: "queue", memoryEnabled: false,
  taskAutoArchiveEnabled: false, enabledBuiltinAgentCliProviders: ["glm"],
  lastActiveTaskByWorkspace: { "/demo/aurora-console": "demo-requirements" },
};
export const PROTOTYPE_REGISTRY_MODEL: RegistryModelConfigObject = {
  enabled: true,
  properties: { requiresMfjsToolSchema: false, contextWindow: 128000,
    inputFormat: { supportsText: true, supportsImage: false, supportsVideo: false, supportsAudio: false, supportsPdf: false },
    outputFormat: { supportsText: true }, supportsToolCall: true, supportsJsonSchemaOutput: true,
    supportsNativeWebSearch: false, supportsMidConversationSystem: true },
  optionSpecs: { reasoningLevel: { values: ["standard", "low", "medium", "high"], map: "{}" }, maxOutputTokens: { max: 8192, map: "{}" } },
};

/** Settings live in the backend scenario until server restart; no real provider connections. */
export function createPrototypeSettingsServices(sessionWorkspaces: Map<string, string> = new Map()): Pick<IServiceAccessor, "settingService" | "providerSettingsService" | "modelSelectionService"> {
  let settings = structuredClone(PROTOTYPE_SETTINGS);
  let instructions = "请使用简体中文，先说明需求边界，再展示方案。当前为阶段性前端原型，不执行命令或真实验收。";
  let view = createPrototypeModelSettingsView();
  let selection = structuredClone(PROTOTYPE_MODEL_SELECTION);
  const providerChanged = createPrototypeEvent<ProviderSettingsView>();
  const modelChanged = createPrototypeEvent<ModelSelectionView>();
  const workspaceFor = (sessionId: string): string => {
    const bound = sessionWorkspaces.get(sessionId);
    if (bound) return bound;
    for (const project of getPrototypeWorkflow().projects) {
      const workflow = getPrototypeWorkflow({ projectId: project.id });
      const ref = workflow.sessions.find(session => session.sessionId === sessionId);
      if (ref) return resolvePrototypeWorkspace(workflow, { projectId: ref.projectId, irId: ref.irId, srId: ref.srId }).path ?? project.root;
    }
    return "/demo/aurora-console";
  };
  const bindingFor = (sessionId?: string) => {
    if (!sessionId) return undefined;
    if (sessionId.startsWith("prototype-skill-design:")) return prototypeSkillDesignBinding(sessionId);
    for (const project of getPrototypeWorkflow().projects) {
      const binding = getPrototypeWorkflow({ projectId: project.id }).sessions.find(ref => ref.sessionId === sessionId)?.modelConfig;
      if (binding) return binding;
    }
  };
  const modelView = (sessionId?: string, requested?: ModelSelection): ModelSelectionView => {
    const binding = bindingFor(sessionId);
    const effective = binding ? prototypeAgentModelSelection(binding) : requested ?? selection;
    return {
      revision: view.revision, preferredSelection: effective, effectiveSelection: effective,
      providers: view.providers.filter(provider => provider.enabled).map(provider => ({
        providerId: provider.providerId, providerName: provider.providerName, templateId: provider.templateId,
        config: provider.effectiveConfig,
        models: provider.models.filter(model => model.enabled).map(model => ({ modelId: model.modelId, config: PROTOTYPE_REGISTRY_MODEL })),
      })),
      ...(sessionId ? { nativeSession: {
        sessionId, workspacePath: workspaceFor(sessionId), chatAvailable: true, taskRunsAvailable: true,
        models: view.providers.flatMap(provider => provider.models.filter(model => model.enabled && (!binding || (provider.providerId === effective.providerId && model.modelId === effective.modelId))).map(model => ({
          providerId: provider.providerId, modelId: model.modelId, name: model.modelId,
        }))),
      } } : {}),
    };
  };
  const publish = (): ProviderSettingsView => {
    view = { ...view, revision: view.revision + 1 };
    providerChanged.fire(structuredClone(view)); modelChanged.fire(modelView());
    return structuredClone(view);
  };
  const updateProvider = (id: string, update: (provider: ProviderSettingsProviderView) => ProviderSettingsProviderView) => {
    if (!view.providers.some(provider => provider.providerId === id)) throw new Error("样例供应商不存在");
    view = { ...view, providers: view.providers.map(provider => provider.providerId === id ? update(provider) : provider) };
    return publish();
  };
  const renameModel = (providerId: string, original: string, next: string) => updateProvider(providerId, provider => ({ ...provider, models: provider.models.map(model => model.modelId === original ? { ...model, modelId: next } : model) }));
  return {
    settingService: {
      get: async () => structuredClone(settings),
      update: async patch => { settings = { ...settings, ...structuredClone(patch) }; },
      updateDataBaseDir: async dataBaseDir => { settings = { ...settings, dataBaseDir }; },
      getUserInstructions: async () => ({ content: instructions, filePath: "/demo/user/.zcode/AGENTS.md" }),
      saveUserInstructions: async content => { instructions = content; return { filePath: "/demo/user/.zcode/AGENTS.md" }; },
    },
    modelSelectionService: {
      onDidChange: modelChanged.event,
      getView: async input => modelView(input?.sessionId, input?.selection ?? undefined),
      setSessionModel: async input => { if (bindingFor(input.sessionId)) throw new Error("此 Agent 会话保留创建时模型；请在模型设置修改后用于新会话。"); selection = { providerId: input.providerId, modelId: input.modelId, options: { reasoningLevel: "standard" } }; modelChanged.fire(modelView(input.sessionId)); return modelView(input.sessionId); },
    },
    providerSettingsService: {
      onDidChange: providerChanged.event,
      getView: async () => structuredClone(view),
      refresh: async () => structuredClone(view),
      createPersonalProvider: async input => {
        const id = `prototype-provider-${view.revision + 1}`;
        const template = view.providerTemplates.find(item => item.templateId === input?.templateId) ?? view.providerTemplates[0];
        const config = input?.initialConfig ?? template?.config ?? {};
        view = { ...view, providerOrder: [...view.providerOrder, id], providers: [...view.providers, { providerId: id, providerName: "自定义演示供应商", templateId: input?.templateId, enabled: true, executable: false, effectiveConfig: config, personalConfig: config, issues: [], models: [] }] };
        return { providerId: id, view: publish() };
      },
      resolveModelConfig: async input => {
        const config = view.providers.find(provider => provider.providerId === input.providerId)?.models.find(model => model.modelId === input.modelId)?.effectiveConfig ?? PROTOTYPE_REGISTRY_MODEL;
        return { inheritedConfig: config, effectiveConfig: "personalConfig" in input ? { ...config, ...input.personalConfig } : config, issues: [] };
      },
      savePersonalProviderOverlay: async (id, config, metadata) => updateProvider(id, provider => ({ ...provider, effectiveConfig: { ...provider.effectiveConfig, ...config }, personalConfig: config, enabled: metadata?.enabled ?? provider.enabled, providerName: metadata?.providerName ?? provider.providerName })),
      deletePersonalProvider: async id => { view = { ...view, providers: view.providers.filter(provider => provider.providerId !== id), providerOrder: view.providerOrder.filter(providerId => providerId !== id) }; return publish(); },
      reorderPersonalProviders: async ids => { const rank = new Map(ids.map((id, index) => [id, index])); view = { ...view, providerOrder: [...ids], providers: [...view.providers].sort((a, b) => (rank.get(a.providerId) ?? ids.length) - (rank.get(b.providerId) ?? ids.length)) }; return publish(); },
      reorderPersonalModels: async (id, ids) => updateProvider(id, provider => { const rank = new Map(ids.map((modelId, index) => [modelId, index])); return { ...provider, models: [...provider.models].sort((a, b) => (rank.get(a.modelId) ?? ids.length) - (rank.get(b.modelId) ?? ids.length)) }; }),
      addPersonalModel: async (id, modelId, config) => updateProvider(id, provider => ({ ...provider, models: [...provider.models, { kind: "candidate", modelId, builtin: false, enabled: config.enabled !== false, executable: false, selectable: false, effectiveBuiltinConfig: {}, personalExactConfig: config, effectiveConfig: config, issues: [] }] })),
      renamePersonalModel: async (id, original, next) => renameModel(id, original, next),
      deletePersonalModel: async (id, modelId) => updateProvider(id, provider => ({ ...provider, models: provider.models.filter(model => model.modelId !== modelId) })),
      savePersonalModelDraft: async input => updateProvider(input.providerId, provider => ({ ...provider, models: provider.models.map(model => model.modelId === input.originalModelId ? { ...model, modelId: input.nextModelId, personalExactConfig: input.personalConfig, effectiveConfig: { ...model.effectiveConfig, ...input.personalConfig }, useRecommendedConfig: input.useRecommendedConfig } : model) })),
      setPersonalModelEnabled: async (id, modelId, enabled) => updateProvider(id, provider => ({ ...provider, models: provider.models.map(model => model.modelId === modelId ? { ...model, enabled } : model) })),
      testModelConnectivity: async () => ({ success: false, error: { message: "阶段性前端原型未发送任何模型请求；连通性留待真实后端对接验证。" } }),
    },
  };
}
