/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { combine, register, type SettingValueOf } from "../config/registry";

/** One bash-interceptor rule: commands matching `pattern` are redirected to `tool`. */
export interface BashInterceptorRule {
	pattern: string;
	flags?: string;
	tool: string;
	message: string;
	allowSubcommands?: string[];
}

const EMPTY_STRING_ARRAY: string[] = [];
export const DEFAULT_BASH_INTERCEPTOR_RULES: BashInterceptorRule[] = [
	{
		pattern: "^\\s*(cat|head|tail|less|more)\\s+",
		tool: "read",
		message: "Use the `read` tool instead of cat/head/tail. It provides better context and handles binary files.",
	},
	{
		pattern: "^\\s*(grep|rg|ripgrep|ag|ack)\\s+",
		tool: "grep",
		message: "Use the `grep` tool instead of grep/rg. It respects .gitignore and provides structured output.",
	},
	{
		pattern: "^\\s*(find|fd|locate)\\s+.*(-name|-iname|-type|--type|-glob)",
		tool: "glob",
		message: "Use the `glob` tool instead of find/fd. It respects .gitignore and is faster for glob patterns.",
	},
	{
		pattern: "^\\s*sed\\s+(-i|--in-place)",
		tool: "edit",
		message: "Use the `edit` tool instead of sed -i. It provides diff preview and fuzzy matching.",
	},
	{
		pattern: "^\\s*perl\\s+.*-[pn]?i",
		tool: "edit",
		message: "Use the `edit` tool instead of perl -i. It provides diff preview and fuzzy matching.",
	},
	{
		pattern: "^\\s*awk\\s+.*-i\\s+inplace",
		tool: "edit",
		message: "Use the `edit` tool instead of awk -i inplace. It provides diff preview and fuzzy matching.",
	},
	{
		// `>` must sit outside quoted regions (so `echo "a -> b"` passes) and be
		// followed by a plausible filename — including `$VAR` targets; `>|`
		// (clobber) counts as a redirect; `>&2`/`2>&1` style fd duplication is
		// not matched. Allowed device sinks are consumed while looking for later
		// real file redirects because the write tool cannot replace shell
		// output/discard targets.
		pattern:
			"^\\s*(echo|printf|cat\\s*<<)\\s+(?:(?:[^\"'>]|\"[^\"]*\"|'[^']*')|(?<!\\|)>{1,2}\\|?\\s*(?:\"/dev/(?:null|tty|stdout|stderr)\"|'/dev/(?:null|tty|stdout|stderr)'|/dev/(?:null|tty|stdout|stderr))(?:[\\s;&|]|$))*(?<!\\|)>{1,2}\\|?\\s*(?!(?:\"/dev/(?:null|tty|stdout|stderr)\"|'/dev/(?:null|tty|stdout|stderr)'|/dev/(?:null|tty|stdout|stderr))(?:[\\s;&|]|$))[$\\w./~\"'-]",
		tool: "write",
		message: "Use the `write` tool instead of echo/cat redirection. It handles encoding and provides confirmation.",
	},
	{
		pattern: "^\\s*nohup\\s+|(?<!&)\\&\\s*$",
		tool: "bash",
		message:
			"Use `bash` with `name` instead of nohup or background shell syntax so the service stays observable and managed.",
	},
	{
		pattern:
			"^\\s*(?:(?:bun|npm|pnpm|yarn)\\s+(?:run\\s+)?(?:dev|start)(?:\\s|$)|(?:vite|next\\s+dev|nuxt\\s+dev|nodemon|lldb|gdb|tail\\s+-f)(?:\\s|$)|docker\\s+compose\\s+up(?!.*(?:\\s-d(?:\\s|$)|--detach))(?:\\s|$))",
		tool: "bash",
		message: "Use `bash` with `name` for services, watchers, and debuggers; inspect with `read proc://<name>`.",
	},
	{
		pattern:
			"^\\s*(?:(?:bun|npm|pnpm|yarn)\\s+(?:run\\s+)?\\S+|cargo\\s+watch|watchexec|pytest|vitest|jest|tsc)(?:.|\\n)*(?:--watch|-w)(?:\\s|$)",
		tool: "bash",
		message: "Use `bash` with `name` for watch mode so its output, input, and lifecycle stay managed.",
	},
];

export const cfgShellPath = register({ id: "shellPath", type: "string", default: undefined });

export const cfgBashEnabled = register({
	id: "bash.enabled",
	type: "boolean",
	default: true,
	ui: {
		tab: "shell",
		group: "Bash",
		label: "Bash",
		description: "启用 bash 工具以执行 Shell 命令",
	},
});

export const cfgBashAllowCompoundCommands = register({
	id: "bash.allowCompoundCommands",
	type: "boolean",
	default: false,
	ui: {
		tab: "shell",
		group: "Bash",
		label: "允许复合命令",
		description: "逐条评估字面量 && 命令链；未匹配的命令使用常规 bash 授权策略和模式",
	},
});

export const cfgBashAutoBackgroundEnabled = register({
	id: "bash.autoBackground.enabled",
	protocolDefault: ["rpc"],
	type: "boolean",
	default: true,
	ui: {
		tab: "shell",
		group: "Bash",
		label: "Bash 自动转后台",
		description: "自动将长时间运行的 bash 命令转入后台，稍后交付结果",
	},
});

export const cfgBashGitGuard = register({
	id: "bash.gitGuard",
	type: "boolean",
	default: false,
	ui: {
		tab: "shell",
		group: "Bash",
		label: "Git 防护",
		description:
			"在 bash 工具中拒绝丢弃或移动共享工作的 git 命令：stash、reset --hard 或重置到其它提交，以及非合并或变基冲突期间的 checkout/switch/restore",
	},
});

export const cfgBashPatterns = register({
	id: "bash.patterns",
	type: "array",
	default: [],
	ui: {
		tab: "shell",
		group: "Bash",
		label: "Bash 授权匹配规则",
		description: "按顺序匹配的 bash 命令授权规则。每项包含 match 和 approval 字段；仅支持 '*' 通配符。",
	},
});

// Bash interceptor
export const cfgBashInterceptorEnabled = register({
	id: "bashInterceptor.enabled",
	type: "boolean",
	default: false,
	ui: {
		tab: "shell",
		group: "Bash",
		label: "Bash 拦截器",
		description: "拦截已有专用工具的 Shell 命令",
	},
});

export const cfgBashInterceptorPatterns = register({
	id: "bashInterceptor.patterns",
	type: "array",
	default: DEFAULT_BASH_INTERCEPTOR_RULES,
});

export const cfgBashDirenv = register({
	id: "bash.direnv",
	type: "enum",
	values: ["auto", "off"] as const,
	default: "auto",
	ui: {
		tab: "shell",
		group: "Bash",
		label: "自动加载 direnv",
		description:
			"自动将仓库的 direnv/devenv `.envrc` 加载到 bash 会话，无需手动执行 `direnv exec` 即可使用 devenv 工具和环境变量。遵循 direnv 允许列表：未执行过 `direnv allow` 的 `.envrc` 绝不会运行",
	},
});

export const cfgBashDirenvLoadTimeoutMs = register({
	id: "bash.direnvLoadTimeoutMs",
	type: "number",
	default: 30_000,
	ui: {
		tab: "shell",
		group: "Bash",
		label: "direnv 加载超时（毫秒）",
		description:
			"首次 `direnv export` 的最长等待时间（devenv Shell 冷启动可能较慢）；超时后会话将在没有 direnv 环境的情况下运行",
	},
});

// Shell output minimizer
export const cfgShellMinimizerEnabled = register({
	id: "shellMinimizer.enabled",
	type: "boolean",
	default: true,
	ui: {
		tab: "shell",
		group: "Bash",
		label: "Shell 输出精简",
		description: "将冗长的 Shell 输出（git、npm、cargo 等）压缩后再返回给 Agent",
	},
});

export const cfgShellMinimizerSettingsPath = register({
	id: "shellMinimizer.settingsPath",
	type: "string",
	default: undefined,
});

export const cfgShellMinimizerOnly = register({
	id: "shellMinimizer.only",
	type: "array",
	default: EMPTY_STRING_ARRAY,
});

export const cfgShellMinimizerExcept = register({
	id: "shellMinimizer.except",
	type: "array",
	default: EMPTY_STRING_ARRAY,
});

export const cfgShellMinimizerMaxCaptureBytes = register({
	id: "shellMinimizer.maxCaptureBytes",
	type: "number",
	default: 4 * 1024 * 1024,
});

export const cfgShellMinimizerSourceOutlineLevel = register({
	id: "shellMinimizer.sourceOutlineLevel",
	type: "enum",
	values: ["default", "aggressive"] as const,
	default: "default",
	ui: {
		tab: "shell",
		group: "Bash",
		label: "Shell 精简源码提纲",
		description: "cat/read 读取源文件时的提纲模式：default 或 aggressive",
	},
});

export const cfgShellMinimizerLegacyFilters = register({
	id: "shellMinimizer.legacyFilters",
	type: "boolean",
	default: undefined,
});

/** Shell output minimizer configuration (`shellMinimizer.*`). */
export const cfgShellMinimizer = combine({
	enabled: cfgShellMinimizerEnabled,
	settingsPath: cfgShellMinimizerSettingsPath,
	only: cfgShellMinimizerOnly,
	except: cfgShellMinimizerExcept,
	maxCaptureBytes: cfgShellMinimizerMaxCaptureBytes,
	sourceOutlineLevel: cfgShellMinimizerSourceOutlineLevel,
	legacyFilters: cfgShellMinimizerLegacyFilters,
});

/** Shell output minimizer configuration ({@link cfgShellMinimizer}). */
export type ShellMinimizerSettings = SettingValueOf<typeof cfgShellMinimizer>;

export const cfgBashAutoBackgroundThresholdMs = register({
	id: "bash.autoBackground.thresholdMs",
	protocolDefault: ["rpc"],
	type: "number",
	default: 60_000,
});
