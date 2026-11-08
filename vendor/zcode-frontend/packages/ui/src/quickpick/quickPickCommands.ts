export type QuickPickCommandIcon =
  | "book"
  | "community"
  | "diff"
  | "folder"
  | "message"
  | "settings"
  | "sidebarClose"
  | "sidebarOpen"
  | "skills"
  | "themeDark"
  | "themeLight";

export type QuickPickCommandSectionId =
  | "suggested"
  | "chat"
  | "navigation"
  | "panels"
  | "configure"
  | "app";

export const QUICK_PICK_SECTION_ORDER: QuickPickCommandSectionId[] = [
  "suggested",
  "chat",
  "navigation",
  "panels",
  "configure",
  "app",
];

export interface QuickPickCommand {
  id: string;
  sectionId: QuickPickCommandSectionId;
  titleId: string;
  icon: QuickPickCommandIcon;
  shortcut?: string;
  keywords: string[];
  disabled?: boolean;
  run: () => void | Promise<void>;
}

interface QuickPickCommandHandlers {
  createTask: () => void;
  openWorkspace: () => void;
  openSettings: () => void;
  openSkillsSettings: () => void;
  switchTheme: () => void;
  openCommunity: () => void | Promise<void>;
  openProductDocs: () => void | Promise<void>;
  toggleSidebar: () => void;
  openReviewTab: () => void;
}

interface CreateQuickPickCommandsOptions {
  allowOpenWorkspace: boolean;
  canOpenCommunity: boolean;
  isSidebarVisible: boolean;
  supportsReview?: boolean;
  themeTarget: "dark" | "light";
  shortcuts: {
    newTask: string;
    openWorkspace: string;
    toggleSidebar: string;
  };
  handlers: QuickPickCommandHandlers;
}

export function createQuickPickCommands({
  allowOpenWorkspace,
  canOpenCommunity,
  isSidebarVisible,
  supportsReview = true,
  themeTarget,
  shortcuts,
  handlers,
}: CreateQuickPickCommandsOptions): QuickPickCommand[] {
  const commands: QuickPickCommand[] = [
    {
      id: "new-task",
      sectionId: "suggested",
      titleId: "quickPick.command.newTask",
      icon: "message",
      shortcut: shortcuts.newTask,
      keywords: ["new", "task", "任务", "新任务", "新建任务"],
      run: handlers.createTask,
    },
    {
      id: "open-workspace",
      sectionId: "suggested",
      titleId: "quickPick.command.openWorkspace",
      icon: "folder",
      shortcut: shortcuts.openWorkspace,
      keywords: ["open", "workspace", "folder", "project", "打开", "文件夹", "项目"],
      disabled: !allowOpenWorkspace,
      run: handlers.openWorkspace,
    },
    {
      id: "suggested-settings",
      sectionId: "suggested",
      titleId: "quickPick.command.settings",
      icon: "settings",
      keywords: ["settings", "preferences", "配置", "设置"],
      run: handlers.openSettings,
    },
    {
      id: "toggle-sidebar",
      sectionId: "panels",
      titleId: "quickPick.command.toggleSidebar",
      icon: isSidebarVisible ? "sidebarClose" : "sidebarOpen",
      shortcut: shortcuts.toggleSidebar,
      keywords: ["sidebar", "left sidebar", "toggle sidebar", "侧栏", "侧边栏", "切换侧栏"],
      run: handlers.toggleSidebar,
    },
    {
      id: "add-review-tab",
      sectionId: "panels",
      titleId: "quickPick.command.addReviewTab",
      icon: "diff",
      keywords: ["add", "review", "diff", "changes", "添加审查", "审查标签", "变更"],
      run: handlers.openReviewTab,
    },
    {
      id: "settings",
      sectionId: "configure",
      titleId: "quickPick.command.settings",
      icon: "settings",
      keywords: ["settings", "preferences", "配置", "设置"],
      run: handlers.openSettings,
    },
    {
      id: "switch-theme",
      sectionId: "configure",
      titleId:
        themeTarget === "dark"
          ? "quickPick.command.switchThemeToDark"
          : "quickPick.command.switchThemeToLight",
      icon: themeTarget === "dark" ? "themeDark" : "themeLight",
      keywords: ["theme", "dark", "light", "主题", "深色", "浅色"],
      run: handlers.switchTheme,
    },
    {
      id: "skills-settings",
      sectionId: "configure",
      titleId: "quickPick.command.skills",
      icon: "skills",
      keywords: ["skills", "skill", "配置", "技能"],
      run: handlers.openSkillsSettings,
    },
  ];

  if (canOpenCommunity) {
    commands.push({
      id: "community",
      sectionId: "app",
      titleId: "quickPick.command.community",
      icon: "community",
      keywords: ["community", "users", "chat", "用户社群", "社群"],
      run: handlers.openCommunity,
    });
  }

  commands.push({
    id: "product-docs",
    sectionId: "app",
    titleId: "quickPick.command.productDocs",
    icon: "book",
    keywords: ["docs", "documentation", "product docs", "文档", "产品文档"],
    run: handlers.openProductDocs,
  });

  return commands.filter((command) => supportsReview || command.id !== "add-review-tab");
}
