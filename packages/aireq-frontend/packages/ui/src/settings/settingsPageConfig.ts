import {
  Monitor,
  Moon,
  Settings,
  Settings2,
  Package,
  Palette,
  Sun,
  WandSparkles,
  User,
} from "lucide-react";
import {
  isSettingsSectionEnabled,
  resolveSettingsSection,
  type SettingsSectionId,
} from "@/lib/settingsNavigation.js";
import type { Theme } from "@/useTheme.js";

export const THEME_MODES: Array<{
  mode: Theme;
  icon: typeof Sun;
}> = [
  { mode: "system", icon: Monitor },
  { mode: "zai-dark", icon: Moon },
  { mode: "zai-light", icon: Sun },
];

export type SettingsSectionGroupId = "personalTools" | "platformConfiguration";

interface SettingsSectionDefinition {
  id: SettingsSectionId;
  icon: typeof Settings;
  titleId: string;
  contentTitleId?: string;
  titleBadgeId?: string;
  groupId: SettingsSectionGroupId;
}

const BASE_SETTINGS_SECTION_GROUPS: Array<{
  id: SettingsSectionGroupId;
  titleId: string;
}> = [
  { id: "personalTools", titleId: "settings.sidebar.group.personalTools" },
  { id: "platformConfiguration", titleId: "settings.sidebar.group.platformConfiguration" },
];

const BASE_SETTINGS_SECTIONS: SettingsSectionDefinition[] = [
  {
    id: "general",
    icon: Settings2,
    titleId: "settings.systemTitle",
    groupId: "platformConfiguration",
  },
  {
    id: "appearance",
    icon: Palette,
    titleId: "settings.appearanceTitle",
    groupId: "personalTools",
  },
  {
    id: "modelProvider",
    icon: Package,
    titleId: "settings.modelProviderTitle",
    groupId: "platformConfiguration",
  },
  // Dev 个性化编辑各角色的个人追加提示词；沿用原设置导航与编辑器风格。
  {
    id: "personalization",
    icon: User,
    titleId: "settings.personalization.title",
    groupId: "platformConfiguration",
  },
  {
    id: "skill",
    icon: WandSparkles,
    titleId: "settings.skills.title",
    groupId: "platformConfiguration",
  },
];

export const SETTINGS_SECTIONS = BASE_SETTINGS_SECTIONS.filter((section) =>
  isSettingsSectionEnabled(section.id),
);

export function createSettingsPageConfig() {
  const settingsSections = SETTINGS_SECTIONS;
  const settingsSectionGroups = BASE_SETTINGS_SECTION_GROUPS.map((group) => ({
    ...group,
    sections: settingsSections.filter((section) => section.groupId === group.id),
  })).filter((group) => group.sections.length > 0);

  return { settingsSectionGroups, settingsSections };
}

export function resolveSettingsSectionForPlatform(
  section: SettingsSectionId,
  visibleSections: ReadonlyArray<Pick<SettingsSectionDefinition, "id">>,
  fallbackSection: SettingsSectionId = "general",
): SettingsSectionId {
  const resolvedSection = resolveSettingsSection(section);
  if (visibleSections.some((candidate) => candidate.id === resolvedSection)) return resolvedSection;
  const resolvedFallback = resolveSettingsSection(fallbackSection);
  if (visibleSections.some((candidate) => candidate.id === resolvedFallback)) {
    return resolvedFallback;
  }
  return visibleSections.find((candidate) => isSettingsSectionEnabled(candidate.id))?.id ?? "general";
}

export const SETTINGS_SECTION_GROUPS = BASE_SETTINGS_SECTION_GROUPS.map((group) => ({
  ...group,
  sections: SETTINGS_SECTIONS.filter((section) => section.groupId === group.id),
})).filter((group) => group.sections.length > 0);

export type { SettingsSectionId };

