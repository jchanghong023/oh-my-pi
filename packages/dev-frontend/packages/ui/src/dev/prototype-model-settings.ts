import { PROTOTYPE_AGENT_MODELS } from "./mock/agent-models.js";
import type { ModelConfigObject, ProviderConfigObject } from "@zcode/provider";
import type { ProviderSettingsView } from "@zcode/services";

// Dev UI presentation only: these values are not Registry, account, or connectivity facts.
const prototypeProviderConfig: ProviderConfigObject = {
  group: "standard-personal",
  api: { type: "openai-chat-completions" },
  access: { type: "api-key" },
};

const prototypeModelConfig: ModelConfigObject = {
  enabled: true,
  properties: {
    requiresMfjsToolSchema: false,
    contextWindow: 128000,
    inputFormat: {
      supportsText: true,
      supportsImage: false,
      supportsVideo: false,
      supportsAudio: false,
      supportsPdf: false,
    },
    outputFormat: { supportsText: true },
    supportsToolCall: true,
    supportsJsonSchemaOutput: true,
    supportsNativeWebSearch: false,
    supportsMidConversationSystem: true,
  },
};

export function createPrototypeModelSettingsView(): ProviderSettingsView {
  return {
    revision: 0,
    providerOrder: [...new Set(PROTOTYPE_AGENT_MODELS.map(model => model.providerId))],
    providerTemplates: [...new Map(PROTOTYPE_AGENT_MODELS.map(model => [model.providerId, model])).values()].map(model => ({
      templateId: model.providerId,
      templateNameMap: { "zh-CN": model.provider, "en-US": model.provider },
      config: structuredClone(prototypeProviderConfig),
    })),
    providers: [...new Map(PROTOTYPE_AGENT_MODELS.map(model => [model.providerId, model])).values()].map(provider => ({
      providerId: provider.providerId,
      providerName: provider.provider,
      templateId: provider.providerId,
      enabled: true,
      executable: false,
      personalConfig: {},
      effectiveConfig: structuredClone(prototypeProviderConfig),
      issues: [],
      models: PROTOTYPE_AGENT_MODELS.filter(model => model.providerId === provider.providerId).map(model => ({
        kind: "candidate" as const,
        modelId: model.name,
        builtin: true,
        enabled: true,
        executable: false,
        selectable: false,
        effectiveBuiltinConfig: structuredClone(prototypeModelConfig),
        effectiveConfig: structuredClone(prototypeModelConfig),
        issues: [],
      })),
    })),
  };
}
