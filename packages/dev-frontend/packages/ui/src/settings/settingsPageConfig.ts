import {
  Archive,
  Folders,
  Monitor,
  Moon,
  Settings,
  Settings2,
  Package,
  Bot,
  Palette,
  Sun,
  Terminal,
  AlarmClock,
  Anchor,
  Brain,
  WandSparkles,
  Keyboard,
  FileSearch,
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
    id: "memory",
    icon: Brain,
    titleId: "settings.memory",
    groupId: "platformConfiguration",
  },
  {
    id: "subagents",
    icon: Bot,
    titleId: "settings.subagents.title",
    groupId: "platformConfiguration",
  },
  {
    id: "skill",
    icon: WandSparkles,
    titleId: "settings.skills.title",
    groupId: "platformConfiguration",
  },
  {
    id: "progressAnalysis",
    icon: FileSearch,
    titleId: "settings.progressAnalysis.title",
    groupId: "platformConfiguration",
  },
  {
    id: "skillDesign",
    icon: FileSearch,
    titleId: "settings.skillDesign.title",
    groupId: "personalTools",
  },
  {
    id: "commands",
    icon: Terminal,
    titleId: "settings.commands.title",
    groupId: "platformConfiguration",
  },
  {
    id: "automations",
    icon: AlarmClock,
    titleId: "settings.automations.title",
    titleBadgeId: "settings.automations.betaBadge",
    groupId: "platformConfiguration",
  },
  {
    id: "hooks",
    icon: Anchor,
    titleId: "settings.hooks.title",
    groupId: "platformConfiguration",
  },
  {
    id: "shortcuts",
    icon: Keyboard,
    titleId: "settings.shortcuts.title",
    groupId: "platformConfiguration",
  },
  // 工作区搜索范围（.zcodeignore）属于平台配置。
  {
    id: "workspaceFileSearch",
    icon: FileSearch,
    titleId: "settings.workspaceFileSearch.title",
    groupId: "platformConfiguration",
  },
  // 项目管理排在归档管理之前（docs/superpowers/specs/2026-10-24-project-management.md）。
  {
    id: "projects",
    icon: Folders,
    titleId: "projectManagement.nav",
    groupId: "platformConfiguration",
  },
  {
    id: "archives",
    icon: Archive,
    titleId: "archives.nav",
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

