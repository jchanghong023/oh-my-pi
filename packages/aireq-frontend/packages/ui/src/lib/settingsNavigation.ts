/* eslint-disable max-lines -- 设置导航意图集中管理 sessionStorage、事件桥接和解析校验，拆分会让一次性意图消费顺序更难保证。 */
import { logger } from "@/logger.js";

export type SettingsSectionId =
  | "general"
  | "appearance"
  | "modelProvider"
  | "personalization"
  | "memory"
  | "skill"
  | "projects"
  | "archives"
  | "commands"
  | "hooks"
  | "workspaceFileSearch"
  | "automations";

export type SettingsPluginTabTarget = "skills" | "commands";

const SETTINGS_SECTION_INTENT_KEY = "zcode-settings-section-intent",
  SETTINGS_PLUGIN_SCOPE_KEY_INTENT_KEY = "zcode-settings-plugin-scope-key-intent";
const SETTINGS_MODEL_PROVIDER_ID_INTENT_KEY = "zcode-settings-model-provider-id-intent";
const SETTINGS_SECTION_INTENT_EVENT = "zcode:settings-section-intent",
  SETTINGS_LAST_SECTION_STORAGE_KEY = "zcode-settings-last-section";
const ENABLED_SETTINGS_SECTIONS = new Set<SettingsSectionId>([
  "general",
  "appearance",
  "modelProvider",
  "personalization",
  "skill",
]);

export interface SettingsSectionIntentEventDetail {
  section: SettingsSectionId;
  pluginScopeKey?: string;
  modelProviderId?: string;
}

export interface SettingsModelProviderTarget {
  providerId: string;
}

function isSettingsSectionId(value: string): value is SettingsSectionId {
  return (
    value === "general" ||
    value === "appearance" ||
    value === "modelProvider" ||
    value === "personalization" ||
    value === "memory" ||
    value === "skill" ||
    value === "projects" ||
    value === "archives" ||
    value === "commands" ||
    value === "hooks" ||
    value === "workspaceFileSearch" ||
    value === "automations"
  );
}

export function isSettingsSectionEnabled(section: SettingsSectionId): boolean {
  return ENABLED_SETTINGS_SECTIONS.has(section);
}

export function resolveSettingsSection(
  section: SettingsSectionId,
  fallbackSection: SettingsSectionId = "general",
): SettingsSectionId {
  if (isSettingsSectionId(section)) {
    return isSettingsSectionEnabled(section) ? section : "general";
  }
  return isSettingsSectionEnabled(fallbackSection) ? fallbackSection : "general";
}

function getLocalStorage(): Storage | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    return globalThis.__ompAIReqLocalStorage;
  } catch (error) {
    // 部分 WebView / 移动远控容器可能禁用 localStorage。
    // 设置页分区记忆只是 UI 偏好，存储不可用时回退默认入口，不应阻断打开设置页。
    logger.warn("[settingsNavigation] localStorage 不可用", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export function readLastSettingsSectionPreference(
  fallbackSection: SettingsSectionId = "general",
): SettingsSectionId {
  const resolvedFallback = resolveSettingsSection(fallbackSection);
  const storage = getLocalStorage();
  if (!storage) {
    return resolvedFallback;
  }

  try {
    const raw = storage.getItem(SETTINGS_LAST_SECTION_STORAGE_KEY);
    if (raw === "skills") {
      const resolvedSection = resolveSettingsSection("skill");
      storage.setItem(SETTINGS_LAST_SECTION_STORAGE_KEY, resolvedSection);
      return resolvedSection;
    }
    // 旧版“代码预览”已并入“外观”，保留用户上次停留位置的迁移语义。
    if (raw === "codePreview") {
      storage.setItem(SETTINGS_LAST_SECTION_STORAGE_KEY, "appearance");
      return "appearance";
    }
    if (raw && isSettingsSectionId(raw)) {
      const resolvedSection = resolveSettingsSection(raw, resolvedFallback);
      if (resolvedSection !== raw) {
        storage.setItem(SETTINGS_LAST_SECTION_STORAGE_KEY, resolvedSection);
      }
      return resolvedSection;
    }
    if (raw !== null) {
      storage.removeItem(SETTINGS_LAST_SECTION_STORAGE_KEY);
    }
  } catch (error) {
    logger.warn("[settingsNavigation] 读取上次设置分区失败", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return resolvedFallback;
}

export function writeLastSettingsSectionPreference(section: SettingsSectionId): void {
  const resolvedSection = resolveSettingsSection(section);
  const storage = getLocalStorage();
  if (!storage) {
    return;
  }

  try {
    storage.setItem(SETTINGS_LAST_SECTION_STORAGE_KEY, resolvedSection);
  } catch (error) {
    logger.warn("[settingsNavigation] 写入上次设置分区失败", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function consumeInitialSettingsSection(
  fallbackSection: SettingsSectionId = "general",
): SettingsSectionId {
  const lastSection = readLastSettingsSectionPreference(fallbackSection);
  // 普通打开设置页以前把 consumePendingSettingsSection 的 fallback 写死为
  // modelProvider，导致没有显式跳转意图时也总进“模型供应商”。这里先读上次停留分区，
  // 再让 quickpick / 管理模型这类一次性意图覆盖它，保留显式入口的直达语义。
  return resolveSettingsSection(consumePendingSettingsSection(lastSection), lastSection);
}

export function setPendingSettingsSection(section: SettingsSectionId): void {
  setPendingSettingsSectionIntent(section);
}


export function setPendingSettingsPluginIntent(
  tab: SettingsPluginTabTarget,
  options: {
    scopeKey?: string;
  } = {},
): void {
  const section = tab === "skills" ? "skill" : "commands";
  setPendingSettingsSectionIntent(section, {
    pluginScopeKey: options.scopeKey,
  });
}

export function setPendingSettingsSectionIntent(
  section: SettingsSectionId,
  options: {
    pluginScopeKey?: string;
    modelProviderId?: string;
  } = {},
): void {
  if (typeof window === "undefined") {
    return;
  }
  const resolvedSection = resolveSettingsSection(section);

  try {
    globalThis.__ompAIReqSessionStorage.setItem(SETTINGS_SECTION_INTENT_KEY, resolvedSection);
    const normalizedPluginScopeKey = options.pluginScopeKey?.trim();
    if (normalizedPluginScopeKey) {
      globalThis.__ompAIReqSessionStorage.setItem(SETTINGS_PLUGIN_SCOPE_KEY_INTENT_KEY, normalizedPluginScopeKey);
    } else {
      globalThis.__ompAIReqSessionStorage.removeItem(SETTINGS_PLUGIN_SCOPE_KEY_INTENT_KEY);
    }
    if (options.modelProviderId) {
      globalThis.__ompAIReqSessionStorage.setItem(SETTINGS_MODEL_PROVIDER_ID_INTENT_KEY, options.modelProviderId);
    } else {
      globalThis.__ompAIReqSessionStorage.removeItem(SETTINGS_MODEL_PROVIDER_ID_INTENT_KEY);
    }
  } catch {
    // 忽略浏览器存储异常，不影响主流程。
  }

  // 设置页已经打开时不会重新挂载，单纯写 sessionStorage 没有订阅者会响应。
  // 同窗口补发自定义事件，让已打开的 SettingsPage 也能即时跳到 quickpick 指定分区。
  window.dispatchEvent(
    new CustomEvent<SettingsSectionIntentEventDetail>(SETTINGS_SECTION_INTENT_EVENT, {
      detail: {
        section: resolvedSection,
        pluginScopeKey: options.pluginScopeKey?.trim() || undefined,
        modelProviderId: options.modelProviderId,
      },
    }),
  );
}

function clearPendingSettingsSectionIntent(): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    globalThis.__ompAIReqSessionStorage.removeItem(SETTINGS_SECTION_INTENT_KEY);
    globalThis.__ompAIReqSessionStorage.removeItem(SETTINGS_MODEL_PROVIDER_ID_INTENT_KEY);
    globalThis.__ompAIReqSessionStorage.removeItem(SETTINGS_PLUGIN_SCOPE_KEY_INTENT_KEY);
  } catch {
    // 忽略浏览器存储异常，不影响主流程。
  }
}

export function consumePendingSettingsSection(
  fallbackSection: SettingsSectionId = "general",
): SettingsSectionId {
  const resolvedFallback = resolveSettingsSection(fallbackSection);
  if (typeof window === "undefined") {
    return resolvedFallback;
  }

  try {
    const raw = globalThis.__ompAIReqSessionStorage.getItem(SETTINGS_SECTION_INTENT_KEY);
    if (raw !== null) {
      globalThis.__ompAIReqSessionStorage.removeItem(SETTINGS_SECTION_INTENT_KEY);
    }

    if (raw === "skills") {
      return resolveSettingsSection("skill");
    }
    if (raw && isSettingsSectionId(raw)) {
      return resolveSettingsSection(raw, resolvedFallback);
    }
  } catch {
    // 忽略浏览器存储异常，不影响主流程。
  }

  return resolvedFallback;
}

export function consumePendingSettingsPluginScopeKey(): string | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    const raw = globalThis.__ompAIReqSessionStorage.getItem(SETTINGS_PLUGIN_SCOPE_KEY_INTENT_KEY);
    return raw?.trim() || undefined;
  } catch {
    return undefined;
  }
}

export function clearPendingSettingsPluginScopeKey(): void {
  if (typeof window === "undefined") return;
  try {
    globalThis.__ompAIReqSessionStorage.removeItem(SETTINGS_PLUGIN_SCOPE_KEY_INTENT_KEY);
  } catch {
    // 忽略浏览器存储异常，不影响主流程。
  }
}

export function consumePendingSettingsModelProviderTarget():
  | SettingsModelProviderTarget
  | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }

  try {
    const providerId = globalThis.__ompAIReqSessionStorage.getItem(SETTINGS_MODEL_PROVIDER_ID_INTENT_KEY);
    globalThis.__ompAIReqSessionStorage.removeItem(SETTINGS_MODEL_PROVIDER_ID_INTENT_KEY);
    if (!providerId?.trim()) {
      return undefined;
    }
    return {
      providerId: providerId.trim(),
    };
  } catch {
    // 忽略浏览器存储异常，不影响主流程。
    return undefined;
  }
}

export function addPendingSettingsSectionListener(
  listener: (section: SettingsSectionId, detail?: SettingsSectionIntentEventDetail) => void,
): () => void {
  if (typeof window === "undefined") {
    return () => {};
  }

  const handleIntent = (event: Event) => {
    const detail = (event as CustomEvent<SettingsSectionIntentEventDetail>).detail;
    if (detail?.section) {
      // 设置页已打开时，事件已经承载了这次跳转意图。
      // 这里同步清掉 sessionStorage，避免用户随后切到别的分区并退出后，
      // 下次挂载又被陈旧 pending 意图覆盖“上次停留分区”。
      clearPendingSettingsSectionIntent();
      const resolvedSection = resolveSettingsSection(detail.section);
      listener(resolvedSection, { ...detail, section: resolvedSection });
    }
  };

  window.addEventListener(SETTINGS_SECTION_INTENT_EVENT, handleIntent);
  return () => {
    window.removeEventListener(SETTINGS_SECTION_INTENT_EVENT, handleIntent);
  };
}

