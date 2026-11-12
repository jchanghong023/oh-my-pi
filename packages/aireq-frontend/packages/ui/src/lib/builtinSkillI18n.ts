import type { SkillScope } from "@zcode/shared";

interface SkillDisplayCandidate {
  name: string;
  description: string;
  path: string;
  scope: SkillScope;
  pluginName?: string;
}

const OFFICIAL_BUILTIN_PLUGIN_NAMES = new Set([
  "android-emulator",
  "browser",
  "browser-use",
  "document-skills",
  "documents",
  "pdf",
  "presentations",
  "spreadsheets",
  "ios-simulator",
  "restore-legacy-sessions",
  "skill-creator",
  "plugin-creator",
  "superpowers",
  "zcode-guide",
]);

const OFFICIAL_PLUGIN_PATH_MARKERS = [
  "/zcode-plugins-official/",
  "\\zcode-plugins-official\\",
  "/android-emulator-plugin/",
  "/browser-use-plugin/",
  "/document-skills-plugin/",
  "/documents-plugin/",
  "/pdf-plugin/",
  "/presentations-plugin/",
  "/spreadsheets-plugin/",
  "/ios-simulator-plugin/",
  "/restore-legacy-sessions-plugin/",
  "/skill-creator-plugin/",
  "/plugin-creator-plugin/",
  "/superpowers-plugin/",
  "/zcode-guide-plugin/",
];

const BUILTIN_SKILL_DESCRIPTIONS: Record<string, string> = {
  "android-dev": "通过 android-emulator MCP 工具构建、运行、检查并轻量自动化 Android 应用。",
  "brainstorming": "在任何创造性工作前使用：创建功能、构建组件、增加能力或修改行为；先探索用户意图、需求和设计。",
  "control-browser": "控制 ZCode 内置浏览器，用于打开、检查、点击、输入、截图或验证网页和本地开发页面。",
  "dispatching-parallel-agents": "面对 2 个以上彼此独立、无共享状态或顺序依赖的任务时使用。",
  "docx": "完整的 DOCX 文档创建、编辑与分析能力，支持修订、批注、格式保持和文本提取。适用于创建新文档、修改内容、处理修订、添加批注或其它专业 Word 文档任务。",
  "docx-viewer": "在 Word 文档侧栏与用户一起查看和讨论 .docx 文件。适用于打开、阅读、审阅或询问工作区中的 Word 文档，用户提到在查看器中选中或引用的内容，或需要检查刚生成的文档。",
  "executing-plans": "已有书面实现计划，并要在带评审检查点的独立会话中执行时使用。",
  "finishing-a-development-branch": "实现已完成、测试通过、需要决定如何合并、发 PR 或清理分支时使用。",
  "ios-dev": "通过 ios-simulator MCP 工具构建、运行、检查并轻量自动化 iOS 模拟器应用。",
  "pdf": "专业 PDF 工具集，覆盖报告、创意视觉、学术 LaTeX 和现有 PDF 处理四条生产线。可按文档类型自动路由，支持报告、海报、论文、简历、提取、合并、拆分、表单填写和格式转换等任务。",
  "pdf-viewer": "在 PDF 侧栏与用户一起查看和讨论 PDF 文件。适用于打开、阅读、审阅或询问工作区中的 PDF，用户提到在查看器中选中或引用的内容，或需要检查刚生成的 PDF。",
  "pptx": "检查并窄范围更新从 PPTX 预览区选择的元素。通过完整文件指纹和 OOXML 定位校验 shape 文本或表格单元格，冲突时停止而不猜测。",
  "pptx-viewer": "在演示文稿侧栏与用户一起查看和讨论 .pptx 演示文稿。适用于一起打开、审阅或询问工作区中的演示文稿，用户提到在查看器中选中或引用的幻灯片或元素，或需要检查刚生成的演示文稿。",
  "receiving-code-review": "收到代码评审反馈、准备实现建议前使用；尤其当反馈不清楚或技术上可疑时，需要严谨验证而非盲目同意。",
  "requesting-code-review": "完成任务、实现重大功能或合并前，用于请求代码评审以确认满足需求。",
  "restore-legacy-sessions": "检查、规划或执行 ACP 时代 ZCode 旧 session 恢复到新的 ZCode 任务与会话库。",
  "plugin-creator": "创建、校验 ZCode 插件，并指导本地安装与更新。",
  "skill-creator": "创建新技能、编辑现有技能并迭代措辞。适用于从零编写 SKILL.md、改进已有技能、把重复工作流沉淀为可复用技能，或优化技能描述以提升触发可靠性。",
  "subagent-driven-development": "在当前会话中执行包含独立任务的实现计划时使用。",
  "systematic-debugging": "遇到任何 bug、测试失败或异常行为时，在提出修复前使用。",
  "test-driven-development": "实现任何功能或 bugfix 时，在编写实现代码前使用。",
  "using-git-worktrees": "开始需要隔离的功能工作或执行实现计划前使用，确保存在隔离 workspace，优先使用原生工具，否则回退 git worktree。",
  "using-superpowers": "开始任何对话时使用；说明如何查找和使用技能，并要求在任何回复包括澄清问题前调用 Skill 工具。",
  "verification-before-completion": "准备声明工作完成、已修复或测试通过前使用；要求先运行验证命令并确认输出，先有证据再下结论。",
  "web-gui-tester": "使用 ZCode Browser Use 对网页和本地 Web 前端执行纯 GUI 黑盒测试，通过真实用户交互、DOM 语义证据和截图验证功能、交互与响应式布局。",
  "writing-plans": "已有规格或多步骤任务需求，在动代码前用于编写实现计划。",
  "writing-skills": "创建新技能、编辑现有技能或在发布前验证技能是否有效时使用。",
  "xlsx-viewer": "在电子表格侧栏与用户一起查看和讨论 .xlsx 工作簿。适用于一起打开、浏览或询问工作区中的工作簿，用户提到在查看器中选中或引用的单元格，或需要检查刚生成的工作簿。",
};

export function resolveSkillSourceLabel(scope: SkillScope): string {
  if (scope === "workspace") return "工作区";
  if (scope === "plugin") return "插件";
  return "用户";
}

export function resolveSkillDisplayDescription(
  skill: SkillDisplayCandidate,
): string {
  const localized = isOfficialBuiltinSkill(skill)
    ? BUILTIN_SKILL_DESCRIPTIONS[skill.name]
    : undefined;
  return localized ?? skill.description;
}

function isOfficialBuiltinSkill(skill: SkillDisplayCandidate): boolean {
  if (skill.scope !== "plugin") {
    return false;
  }
  const pluginName = skill.pluginName?.trim();
  if (pluginName && OFFICIAL_BUILTIN_PLUGIN_NAMES.has(pluginName)) {
    return true;
  }
  const normalizedPath = skill.path.replaceAll("\\", "/");
  return OFFICIAL_PLUGIN_PATH_MARKERS.some((marker) => normalizedPath.includes(marker));
}
