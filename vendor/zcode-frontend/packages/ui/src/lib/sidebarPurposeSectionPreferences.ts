interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface SidebarPurposeSectionPreferences {
  projectsExpanded: boolean;
}

export const SIDEBAR_PURPOSE_SECTION_PREFERENCES_STORAGE_KEY =
  "zcode-sidebar-purpose-section-preferences";

const DEFAULT_SIDEBAR_PURPOSE_SECTION_PREFERENCES: SidebarPurposeSectionPreferences = {
  projectsExpanded: true,
};

function getBrowserStorage(): StorageLike | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function getDefaultPreferences(): SidebarPurposeSectionPreferences {
  return { ...DEFAULT_SIDEBAR_PURPOSE_SECTION_PREFERENCES };
}

export function readSidebarPurposeSectionPreferences(
  storage: StorageLike | null = getBrowserStorage(),
): SidebarPurposeSectionPreferences {
  try {
    const rawValue = storage?.getItem(SIDEBAR_PURPOSE_SECTION_PREFERENCES_STORAGE_KEY);
    if (!rawValue) {
      return getDefaultPreferences();
    }

    const parsed: unknown = JSON.parse(rawValue);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return getDefaultPreferences();
    }

    const value = parsed as Partial<SidebarPurposeSectionPreferences>;
    return {
      projectsExpanded:
        typeof value.projectsExpanded === "boolean"
          ? value.projectsExpanded
          : DEFAULT_SIDEBAR_PURPOSE_SECTION_PREFERENCES.projectsExpanded,
    };
  } catch {
    return getDefaultPreferences();
  }
}

export function persistSidebarPurposeSectionPreferences(
  preferences: SidebarPurposeSectionPreferences,
  storage: StorageLike | null = getBrowserStorage(),
) {
  try {
    storage?.setItem(
      SIDEBAR_PURPOSE_SECTION_PREFERENCES_STORAGE_KEY,
      JSON.stringify({
        projectsExpanded: preferences.projectsExpanded,
      }),
    );
  } catch {
    // 受限 WebView 或隐私模式可能禁止写 localStorage；偏好写入失败不能阻断侧栏交互。
  }
}