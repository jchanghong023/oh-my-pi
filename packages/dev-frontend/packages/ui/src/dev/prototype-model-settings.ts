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
    providerOrder: ["prototype-opencode-go"],
    providerTemplates: [{
      templateId: "prototype-opencode-go",
      templateNameMap: { "zh-CN": "OpenCode Go", "en-US": "OpenCode Go" },
      config: structuredClone(prototypeProviderConfig),
    }],
    providers: [{
      providerId: "prototype-opencode-go",
      providerName: "OpenCode Go",
      templateId: "prototype-opencode-go",
      enabled: true,
      executable: false,
      personalConfig: {},
      effectiveConfig: structuredClone(prototypeProviderConfig),
      issues: [],
      models: [{
        kind: "candidate",
        modelId: "Beam Free",
        builtin: true,
        enabled: true,
        executable: false,
        selectable: false,
        effectiveBuiltinConfig: structuredClone(prototypeModelConfig),
        effectiveConfig: structuredClone(prototypeModelConfig),
        issues: [],
      }],
    }],
  };
}
