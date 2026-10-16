/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { combine, register, type SettingValueOf } from "../config/registry";
import { DEFAULT_SKILLS_URL } from "@oh-my-pi/pi-wire/skillshare";

const EMPTY_STRING_ARRAY: string[] = [];

export const cfgExtensions = register({ id: "extensions", type: "array", default: EMPTY_STRING_ARRAY });

export const cfgDisabledExtensions = register({ id: "disabledExtensions", type: "array", default: EMPTY_STRING_ARRAY });

// Skill registry (omp skill)
export const cfgSkillsRegistryUrl = register({
	id: "skills.registryUrl",
	type: "string",
	default: DEFAULT_SKILLS_URL,
	ui: {
		tab: "interaction",
		group: "Skills",
		label: "Skill 注册中心",
		description: "`omp skill` 安装、搜索和发布 Skills 时使用的 Skillshare 注册中心（https://host[:port]）",
	},
});

// Skills
export const cfgSkillsEnabled = register({ id: "skills.enabled", type: "boolean", default: true });

export const cfgSkillsEnableSkillCommands = register({
	id: "skills.enableSkillCommands",
	type: "boolean",
	default: true,
	ui: {
		tab: "tasks",
		group: "命令与 Skills",
		label: "Skill 命令",
		description: "将 Skills 注册为 /skill:name 命令",
	},
});

export const cfgSkillsEnableCodexUser = register({ id: "skills.enableCodexUser", type: "boolean", default: true });

export const cfgSkillsEnableClaudeUser = register({ id: "skills.enableClaudeUser", type: "boolean", default: false });

export const cfgSkillsEnableClaudeProject = register({
	id: "skills.enableClaudeProject",
	type: "boolean",
	default: true,
});

export const cfgSkillsEnablePiUser = register({ id: "skills.enablePiUser", type: "boolean", default: true });

export const cfgSkillsEnablePiProject = register({ id: "skills.enablePiProject", type: "boolean", default: true });

export const cfgSkillsEnableAgentsUser = register({ id: "skills.enableAgentsUser", type: "boolean", default: true });

export const cfgSkillsEnableAgentsProject = register({
	id: "skills.enableAgentsProject",
	type: "boolean",
	default: true,
});

export const cfgSkillsCustomDirectories = register({
	id: "skills.customDirectories",
	type: "array",
	default: EMPTY_STRING_ARRAY,
});

export const cfgSkillsIgnoredSkills = register({
	id: "skills.ignoredSkills",
	type: "array",
	default: EMPTY_STRING_ARRAY,
});

export const cfgSkillsIncludeSkills = register({
	id: "skills.includeSkills",
	type: "array",
	default: EMPTY_STRING_ARRAY,
});

/** Skill discovery options (`skills.*` except the `omp skill` registry URL). */
export const cfgSkills = combine({
	enabled: cfgSkillsEnabled,
	enableSkillCommands: cfgSkillsEnableSkillCommands,
	enableCodexUser: cfgSkillsEnableCodexUser,
	enableClaudeUser: cfgSkillsEnableClaudeUser,
	enableClaudeProject: cfgSkillsEnableClaudeProject,
	enablePiUser: cfgSkillsEnablePiUser,
	enablePiProject: cfgSkillsEnablePiProject,
	enableAgentsUser: cfgSkillsEnableAgentsUser,
	enableAgentsProject: cfgSkillsEnableAgentsProject,
	customDirectories: cfgSkillsCustomDirectories,
	ignoredSkills: cfgSkillsIgnoredSkills,
	includeSkills: cfgSkillsIncludeSkills,
});

/** Skill discovery options ({@link cfgSkills}); omitted fields fall back to the setting defaults. */
export type SkillsSettings = Partial<SettingValueOf<typeof cfgSkills>>;

// Commands
export const cfgCommandsEnableClaudeUser = register({
	id: "commands.enableClaudeUser",
	type: "boolean",
	default: false,
	ui: {
		tab: "tasks",
		group: "命令与 Skills",
		label: "Claude 用户命令",
		description: "从 ~/.claude/commands/ 加载命令",
	},
});

export const cfgCommandsEnableClaudeProject = register({
	id: "commands.enableClaudeProject",
	type: "boolean",
	default: true,
	ui: {
		tab: "tasks",
		group: "命令与 Skills",
		label: "Claude 项目命令",
		description: "从 .claude/commands/ 加载命令",
	},
});

export const cfgCommandsEnableOpencodeUser = register({
	id: "commands.enableOpencodeUser",
	type: "boolean",
	default: false,
	ui: {
		tab: "tasks",
		group: "命令与 Skills",
		label: "OpenCode 用户命令",
		description: "从 ~/.config/opencode/commands/ 加载命令",
	},
});

export const cfgCommandsEnableOpencodeProject = register({
	id: "commands.enableOpencodeProject",
	type: "boolean",
	default: true,
	ui: {
		tab: "tasks",
		group: "命令与 Skills",
		label: "OpenCode 项目命令",
		description: "从 .opencode/commands/ 加载命令",
	},
});

export const cfgExtensionHandlersToolCallTimeoutMs = register({
	id: "extensionHandlers.toolCallTimeoutMs",
	type: "number",
	default: 30_000,
	ui: {
		tab: "tools",
		group: "扩展",
		label: "工具调用处理器超时（毫秒）",
		description:
			"扩展 tool_call 处理器的有效工作超时，须为正有限值；无效值使用 30000 毫秒，等待 OMP 对话框的时间不计入",
	},
});
