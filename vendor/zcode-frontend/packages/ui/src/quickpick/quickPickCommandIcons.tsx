import {
  BookOpenIcon,
  FileDiffIcon,
  FolderOpenIcon,
  MessageCirclePlus,
  MoonIcon,
  PanelLeftClose,
  PanelLeftOpen,
  ServerIcon,
  SettingsIcon,
  SunIcon,
  UsersIcon,
  WandSparkles,
} from "lucide-react";
import type { QuickPickCommandIcon } from "@/quickpick/quickPickCommands.js";

export const QUICK_PICK_ICON_BY_KIND = {
  book: BookOpenIcon,
  community: UsersIcon,
  diff: FileDiffIcon,
  folder: FolderOpenIcon,
  message: MessageCirclePlus,
  mcp: ServerIcon,
  settings: SettingsIcon,
  sidebarClose: PanelLeftClose,
  sidebarOpen: PanelLeftOpen,
  skills: WandSparkles,
  themeDark: MoonIcon,
  themeLight: SunIcon,
} satisfies Record<QuickPickCommandIcon, typeof MessageCirclePlus>;
