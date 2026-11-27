/**
 * Config CLI command handlers.
 *
 * Handles `omp config <command>` subcommands for managing settings.
 * The settings registry (`config/registry.ts`) is the source of truth for available settings.
 */

import { APP_NAME, getAgentDir, isRecord } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { orderedSettings } from "../config/all-settings";
import { type AnySetting, lookup } from "../config/registry";
import { Settings, settings } from "../config/settings";
import type { TeamConfigSaveResult } from "../team/config-types";
import { cfgTeamMembers } from "../team/settings";
import { initXdg } from "./commands/init-xdg";
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";

// =============================================================================
// Types
// =============================================================================

export type ConfigAction = "list" | "get" | "set" | "reset" | "path" | "init-xdg";

/** Layer `list --scope` reads as written: the agent dir's `config.yml`, or the project's settings files. */
export type ConfigScope = "global" | "project";

export interface ConfigCommandArgs {
	action: ConfigAction;
	key?: string;
	value?: string;
	flags: {
		json?: boolean;
		/** `list` shows only the keys this layer sets, with the values as written. */
		scope?: ConfigScope;
	};
}
// =============================================================================
// Setting Filtering
// =============================================================================

type CliSettingDef = {
	setting: AnySetting;
	path: string;
	type: string;
	description: string;
	tab: string;
};

/** Printed instead of a credential value in human output only. */
const REDACTED = "********";

function toSettingDef(setting: AnySetting): CliSettingDef {
	const ui = setting.ui;
	return {
		setting,
		path: setting.id,
		type: setting.type,
		description: ui?.description ?? "",
		tab: ui?.tab ?? "internal",
	};
}

/** Find setting definition by path */
function findSettingDef(path: string): CliSettingDef | undefined {
	const setting = lookup(path);
	return setting ? toSettingDef(setting) : undefined;
}

// =============================================================================
// Value Formatting
// =============================================================================

function formatValue(value: unknown): string {
	if (value === undefined || value === null) {
		return chalk.dim("(not set)");
	}
	if (typeof value === "boolean") {
		return value ? chalk.green("true") : chalk.red("false");
	}
	if (typeof value === "number") {
		return chalk.cyan(String(value));
	}
	if (typeof value === "string") {
		return chalk.yellow(value);
	}
	if (Array.isArray(value) || typeof value === "object") {
		try {
			return chalk.yellow(JSON.stringify(value));
		} catch {
			return chalk.yellow(String(value));
		}
	}
	return chalk.yellow(String(value));
}

function getTypeDisplay(def: CliSettingDef): string {
	const values = def.setting.enumValues;
	if (values && values.length > 0) {
		return `(${values.join("|")})`;
	}
	switch (def.type) {
		case "boolean":
			return "(boolean)";
		case "number":
			return "(number)";
		case "array":
			return "(array)";
		case "record":
			return "(record)";
		default:
			return "(string)";
	}
}

// =============================================================================
// Command Handlers
// =============================================================================

export async function runConfigCommand(cmd: ConfigCommandArgs): Promise<void> {
	if (cmd.flags.scope !== undefined && cmd.action !== "list") {
		console.error(chalk.red("--scope applies to `config list` only"));
		process.exit(1);
	}
	const editing = cmd.action === "set" || cmd.action === "reset";
	try {
		await Settings.init({ existingConfigOnly: editing });
	} catch (error) {
		if (!editing) throw error;
		console.error(chalk.red("User configuration cannot be safely read; nothing was saved."));
		process.exit(1);
	}

	switch (cmd.action) {
		case "list":
			if (cmd.flags.scope === undefined) await handleList(cmd.flags);
			else await handleListLayer(cmd.flags.scope, cmd.flags);
			break;
		case "get":
			handleGet(cmd.key, cmd.flags);
			break;
		case "set":
			await handleSet(cmd.key, cmd.value, cmd.flags);
			break;
		case "reset":
			await handleReset(cmd.key, cmd.flags);
			break;
		case "path":
			handlePath();
			break;
		case "init-xdg":
			await initXdg();
			break;
	}
}

async function writeStdout(text: string): Promise<void> {
	const pending = Promise.withResolvers<void>();
	process.stdout.write(text, error => {
		if (error) {
			pending.reject(error);
			return;
		}
		pending.resolve();
	});
	await pending.promise;
}

async function handleList(flags: { json?: boolean }): Promise<void> {
	const defs = orderedSettings().map(toSettingDef);

	if (flags.json) {
		// A redacted entry omits `value` and says so, rather than substituting a
		// placeholder string: a consumer cannot tell a stand-in from a real value
		// and could write it back as the credential.
		//
		// Redaction is driven by the value, not by classification alone. Marking an
		// unset credential as redacted would report every fresh install as having
		// one configured, which leaks the opposite of what redaction is for. A
		// configured "" renders as unset, like in the settings panel (credentials
		// are all strings).
		const result: Record<string, { value?: unknown; redacted?: true; type: string; description: string }> = {};
		for (const def of defs) {
			const value = def.setting.get(settings);
			result[def.path] =
				def.setting.isCredential && value
					? { redacted: true, type: def.type, description: def.description }
					: { value, type: def.type, description: def.description };
		}
		await writeStdout(`${JSON.stringify(result, null, 2)}\n`);
		return;
	}

	console.log(chalk.bold("Settings:\n"));

	const groups: Record<string, CliSettingDef[]> = {};
	for (const def of defs) {
		if (!groups[def.tab]) {
			groups[def.tab] = [];
		}
		groups[def.tab].push(def);
	}

	const sortedGroups = Object.keys(groups).sort((a, b) => {
		if (a === "config") return -1;
		if (b === "config") return 1;
		return a.localeCompare(b);
	});

	for (const group of sortedGroups) {
		console.log(chalk.bold.blue(`[${group}]`));
		for (const def of groups[group]) {
			// `list` dumps every value without anyone asking for a specific
			// credential, so redact here. `get <path>` stays an explicit
			// single-value request and is left alone. An unset or cleared ("")
			// credential keeps its ordinary rendering: masking it would imply one
			// is configured.
			const value = def.setting.get(settings);
			const valueStr = def.setting.isCredential && value ? REDACTED : formatValue(value);
			const typeStr = getTypeDisplay(def);
			console.log(`  ${chalk.white(def.path)} = ${valueStr} ${chalk.dim(typeStr)}`);
		}
		console.log("");
	}
}

/**
 * The keys the `scope` layer sets, with the values as written: path-scoped arrays
 * (`enabledModels`, `enabledProviders`, `disabledProviders`) keep their `{ path, … }` entries
 * unresolved, so a host can edit the layer's own value without dropping them. Defaults, other
 * layers and the environment are not consulted. Credentials are redacted as in `list`.
 */
async function handleListLayer(scope: ConfigScope, flags: { json?: boolean }): Promise<void> {
	const layer = scope === "project" ? settings.getProjectSettings() : settings.getGlobalSettings();
	const entries: [CliSettingDef, unknown][] = [];
	for (const def of orderedSettings().map(toSettingDef)) {
		let value: unknown = layer;
		for (const segment of def.setting.segments) value = isRecord(value) ? value[segment] : undefined;
		if (value !== undefined) entries.push([def, value]);
	}

	if (flags.json) {
		const result: Record<string, { value?: unknown; redacted?: true; type: string; description: string }> = {};
		for (const [def, value] of entries) {
			result[def.path] =
				def.setting.isCredential && value
					? { redacted: true, type: def.type, description: def.description }
					: { value, type: def.type, description: def.description };
		}
		await writeStdout(`${JSON.stringify(result, null, 2)}\n`);
		return;
	}

	console.log(chalk.bold(`Settings in the ${scope} layer:\n`));
	for (const [def, value] of entries) {
		const valueStr = def.setting.isCredential && value ? REDACTED : formatValue(value);
		console.log(`  ${chalk.white(def.path)} = ${valueStr} ${chalk.dim(getTypeDisplay(def))}`);
	}
}

function handleGet(key: string | undefined, flags: { json?: boolean }): void {
	if (!key) {
		console.error(chalk.red(`Usage: ${APP_NAME} config get <key>`));
		console.error(chalk.dim(`\nRun '${APP_NAME} config list' to see available keys`));
		process.exit(1);
	}

	const def = findSettingDef(key);
	if (!def) {
		console.error(chalk.red(`Unknown setting: ${key}`));
		console.error(chalk.dim(`\nRun '${APP_NAME} config list' to see available keys`));
		process.exit(1);
	}

	const value = def.setting.get(settings);

	if (flags.json) {
		console.log(JSON.stringify({ key: def.path, value, type: def.type, description: def.description }, null, 2));
		return;
	}

	console.log(formatValue(value));
}

async function saveTeamMembers(value: unknown, expectedRevision: string): Promise<TeamConfigSaveResult> {
	const [
		{ ModelRegistry },
		{ initializeOfflineModelCommand, loadCliExtensionProviders },
		{ AuthStorage },
		{ loadEffectiveAuthAccountPolicyConfig },
		{ TeamConfigError, TeamConfigService },
		{ getAgentDbPath },
	] = await Promise.all([
		import("../config/model-registry"),
		import("../sdk"),
		import("../session/auth-storage"),
		import("../session/auth-broker-config"),
		import("../team/config"),
		import("@oh-my-pi/pi-utils/dirs"),
	]);
	const scope = Settings.instance;
	const { accountPolicies, defaultReservePct } = await loadEffectiveAuthAccountPolicyConfig({ settings: scope });
	// Configuration must not contact a broker or refresh a provider. Recover the same local catalog caches as startup.
	const auth = await AuthStorage.create(getAgentDbPath(scope.getAgentDir()), { accountPolicies, defaultReservePct });
	try {
		await auth.credentials.reload();
		await initializeOfflineModelCommand(scope);
		const registry = new ModelRegistry(auth, undefined, { settings: scope });
		// Like default TUI startup, the standalone command must not discover ambient extensions.
		await loadCliExtensionProviders(registry, scope, scope.getCwd(), {
			discoverModels: false,
			disableExtensionDiscovery: true,
		});
		await registry.hydrateCredentialScopedModelCaches();
		await registry.refreshRuntimeProviders("offline");
		const service = new TeamConfigService({ getSettings: () => scope, getModelRegistry: () => registry });
		return await service.saveTeamConfig(value, expectedRevision);
	} catch (error) {
		if (error instanceof TeamConfigError) {
			const data = error.data;
			if (data?.write.status === "saved") console.error("Write committed to the global config.");
			else if (data) console.error(`Team write status: ${data.write.status}.`);
			if (data?.effectiveNote && data.effectiveNote !== error.message) console.error(data.effectiveNote);
			if (error.code === "invalid_params")
				console.error("Team CLI validation uses only local credentials and cached model metadata.");
		}
		throw error;
	} finally {
		auth.close();
	}
}

async function handleSet(key: string | undefined, value: string | undefined, flags: { json?: boolean }): Promise<void> {
	if (!key || value === undefined) {
		console.error(chalk.red(`Usage: ${APP_NAME} config set <key> <value>`));
		console.error(chalk.dim(`\nRun '${APP_NAME} config list' to see available keys`));
		process.exit(1);
	}

	const def = findSettingDef(key);
	if (!def) {
		console.error(chalk.red(`Unknown setting: ${key}`));
		console.error(chalk.dim(`\nRun '${APP_NAME} config list' to see available keys`));
		process.exit(1);
	}

	let teamSave: TeamConfigSaveResult | undefined;
	try {
		const parsed = def.setting.parse(value);
		def.setting.assertWritable(parsed);
		const snapshot = await settings.readUserSetting(def.path);
		if (snapshot.revision === null) throw new Error("User configuration cannot be safely read; nothing was saved.");
		if (def.path === cfgTeamMembers.id) teamSave = await saveTeamMembers(parsed, snapshot.revision);
		else await settings.saveUserSetting(def.path, parsed, snapshot.revision);
	} catch (err) {
		console.error(chalk.red(String(err)));
		process.exit(1);
	}

	// Report the value written to config.yml. When another layer or an environment variable still
	// supplies the effective value, say which instead of echoing its value as if it had been set.
	const saved = teamSave ? teamSave.config.userMembers?.map(slot => slot.rawSelector) : globalValue(def.setting);
	const redacted = def.setting.isCredential && !!saved;
	const shadow = teamSave
		? teamSave.effectiveMatchesRequested
			? undefined
			: (shadowingSource(def.setting, teamSave.config.source ?? undefined) ?? {
					json: { effectiveMatchesRequested: false },
					message: teamSave.effectiveNote,
				})
		: shadowingSource(def.setting);

	if (flags.json) {
		console.log(
			JSON.stringify({
				key: def.path,
				...(redacted ? { redacted: true } : { value: saved }),
				...shadow?.json,
			}),
		);
		return;
	}
	console.log(
		chalk.green(
			`${currentTheme().symbols.symbol("status.success")} Set ${def.path} = ${redacted ? REDACTED : formatValue(saved)}`,
		),
	);
	if (shadow?.message)
		console.log(chalk.yellow(`${currentTheme().symbols.symbol("status.warning")} ${shadow.message}`));
}

/** Value `setting` holds in the global config layer — what `config set` wrote. */
function globalValue(setting: AnySetting): unknown {
	let value: unknown = settings.getGlobalSettings();
	for (const segment of setting.segments) value = isRecord(value) ? value[segment] : undefined;
	return value;
}

/** Where the effective value comes from when it is not the global config (or the default), if anywhere. */
function shadowingSource(
	setting: AnySetting,
	provenance = setting.provenance(settings),
): { json: Record<string, string>; message: string } | undefined {
	switch (provenance) {
		case "global":
		case "default":
			return undefined;
		case "env": {
			const name = setting.envName;
			if (!name) return undefined;
			return setting.envFallback
				? {
						json: { fallbackEnv: name },
						message: `$${name} is used as a fallback while the saved value is blank.`,
					}
				: {
						json: { overriddenBy: name },
						message: `$${name} overrides this value; unset it for the saved value to apply.`,
					};
		}
		case "project":
			return {
				json: { overriddenBy: provenance },
				message: "Project settings override this value here; edit or remove it there for the saved value to apply.",
			};
		case "overlay":
			return {
				json: { overriddenBy: provenance },
				message: "A --config / PI_CONFIG_FILES overlay overrides this value for this process.",
			};
		case "runtime":
			return {
				json: { overriddenBy: provenance },
				message: "A runtime override supplies the effective value for this process.",
			};
	}
}

async function handleReset(key: string | undefined, flags: { json?: boolean }): Promise<void> {
	if (!key) {
		console.error(chalk.red(`Usage: ${APP_NAME} config reset <key>`));
		console.error(chalk.dim(`\nRun '${APP_NAME} config list' to see available keys`));
		process.exit(1);
	}

	const def = findSettingDef(key);
	if (!def) {
		console.error(chalk.red(`Unknown setting: ${key}`));
		console.error(chalk.dim(`\nRun '${APP_NAME} config list' to see available keys`));
		process.exit(1);
	}
	try {
		// Explicit CAS persistence cannot silently discard a conflicting edit and report success.
		const snapshot = await settings.readUserSetting(def.path);
		if (snapshot.revision === null) throw new Error("User configuration cannot be safely read; nothing was reset.");
		await settings.saveUserSetting(def.path, undefined, snapshot.revision);
	} catch (err) {
		console.error(chalk.red(String(err)));
		process.exit(1);
	}

	// The effective value may now come from another layer or the environment: never echo a credential.
	const value = def.setting.get(settings);
	const redacted = def.setting.isCredential && !!value;
	if (flags.json) {
		console.log(JSON.stringify(redacted ? { key: def.path, redacted: true } : { key: def.path, value }));
	} else {
		console.log(
			chalk.green(
				`${currentTheme().symbols.symbol("status.success")} Reset ${def.path} to ${redacted ? REDACTED : formatValue(value)}`,
			),
		);
	}
}

function handlePath(): void {
	console.log(getAgentDir());
}
