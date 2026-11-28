type ForkSettingDefault = boolean | number | string;

export const FORK_COMPOSER_SHAPE = "box";
export const FORK_DISPLAY_MODE = "compact";
export const FORK_ASYNC_JOB_LIMIT = 32;

/** Scalar defaults that differ from upstream, applied when each setting is registered. */
export const FORK_SETTING_DEFAULTS: ReadonlyMap<string, ForkSettingDefault> = new Map<string, ForkSettingDefault>([
	["async.maxJobs", FORK_ASYNC_JOB_LIMIT],
	["commit.enabled", false],
	["composer.shape", FORK_COMPOSER_SHAPE],
	["display.toolActivity", FORK_DISPLAY_MODE],
	["display.showTurnTime", true],
	["lsp.enabled", false],
	["marketplace.autoUpdate", "off"],
	["mnemopi.embeddingVariant", "multilingual"],
	["recap.enabled", false],
	["startup.setupWizard", false],
	["statusLine.compactThinkingLevel", false],
	["stt.language", "zh-CN"],
]);

/** Intranet-specific fallbacks, not forced overrides. */
export const FORK_OFFLINE_SETTING_DEFAULTS: ReadonlyMap<string, ForkSettingDefault> = new Map([
	["terminal.programStatus", false],
]);
