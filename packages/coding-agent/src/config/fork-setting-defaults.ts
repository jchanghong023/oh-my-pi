type ForkSettingDefault = boolean | number | string;

/** Scalar defaults that differ from upstream, applied when each setting is registered. */
export const FORK_SETTING_DEFAULTS: ReadonlyMap<string, ForkSettingDefault> = new Map<string, ForkSettingDefault>([
	["async.maxJobs", 32],
	["commit.enabled", false],
	["composer.shape", "box"],
	["display.showTurnTime", true],
	["lsp.enabled", false],
	["marketplace.autoUpdate", "off"],
	["mnemopi.embeddingVariant", "multilingual"],
	["recap.enabled", false],
	["skills.enableCodexUser", true],
	["startup.checkUpdate", false],
	["startup.setupWizard", false],
	["statusLine.compactThinkingLevel", false],
	["stt.language", "zh-CN"],
]);
