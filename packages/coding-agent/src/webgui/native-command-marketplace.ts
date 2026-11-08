import { PluginManager } from "../extensibility/plugins";
import { parseSettingValue, validateSetting } from "../extensibility/plugins/manager";
import { parsePluginId } from "../extensibility/plugins/marketplace";
import type { InstalledPlugin } from "../extensibility/plugins/types";
import { createMarketplaceManager } from "../slash-commands/helpers/marketplace-manager";
import { commandConsumed, errorMessage, parseSubcommand, usage } from "../slash-commands/helpers/parse";
import { parseMarketplaceInstallArgs, parsePluginScopeArgs } from "../slash-commands/marketplace-install-parser";
import type {
	ParsedSlashCommand,
	SlashCommandResult,
	SlashCommandRuntime,
	WebGuiSlashCommandRuntime,
} from "../slash-commands/types";

type MarketplaceCommand = (command: ParsedSlashCommand, runtime: SlashCommandRuntime) => Promise<SlashCommandResult>;

/** Browser presentation only: all mutations still run through the shared native command. */
export async function handleNativeWebGuiMarketplace(
	command: ParsedSlashCommand,
	runtime: WebGuiSlashCommandRuntime,
	execute: MarketplaceCommand,
): Promise<SlashCommandResult> {
	const parsedCommand = parseSubcommand(command.args);
	const verb = parsedCommand.verb || "install";
	let rest = parsedCommand.rest;
	try {
		if ((verb === "install" || verb === "uninstall") && !rest) {
			const manager = await createMarketplaceManager(runtime);
			const installed = await manager.listInstalledPlugins();
			if (verb === "uninstall") {
				if (installed.length === 0) {
					await runtime.output("No marketplace plugins installed");
					return commandConsumed();
				}
				const choices = installed.map(plugin => ({
					label: `${plugin.id} [${plugin.scope}]`,
					description: `${plugin.entries[0]?.version ?? "unknown version"}${plugin.shadowedBy ? " (shadowed)" : ""}`,
				}));
				const selected = await runtime.ui.select("Uninstall marketplace plugin", choices, {
					signal: runtime.signal,
				});
				const index = choices.findIndex(choice => choice.label === selected);
				if (index < 0) return commandConsumed();
				const plugin = installed[index]!;
				rest = `--scope ${plugin.scope} ${plugin.id}`;
			} else {
				const marketplaces = await manager.listMarketplaces();
				if (marketplaces.length === 0) {
					await runtime.output(
						"No marketplaces configured. Try:\n  /marketplace add anthropics/claude-plugins-official",
					);
					return commandConsumed();
				}
				const choices = [];
				for (const marketplace of marketplaces) {
					for (const plugin of await manager.listAvailablePlugins(marketplace.name)) {
						choices.push({
							label: `${plugin.name}@${marketplace.name}`,
							description: [plugin.version, plugin.description].filter(Boolean).join(" — "),
						});
					}
				}
				if (choices.length === 0) {
					await runtime.output("No plugins available in configured marketplaces");
					return commandConsumed();
				}
				const selected = await runtime.ui.select("Install marketplace plugin", choices, { signal: runtime.signal });
				if (!selected || !choices.some(choice => choice.label === selected)) return commandConsumed();
				const scope = await runtime.ui.select("Plugin installation scope", ["user", "project"], {
					signal: runtime.signal,
				});
				if (scope !== "user" && scope !== "project") return commandConsumed();
				const force = installed.some(plugin => plugin.id === selected && plugin.scope === scope);
				rest = `${force ? "--force " : ""}--scope ${scope} ${selected}`;
			}
		}
		if (verb === "install") {
			const parsed = parseMarketplaceInstallArgs(rest);
			if ("error" in parsed) return usage(parsed.error, runtime);
			const at = parsed.installSpec.lastIndexOf("@");
			const manager = await createMarketplaceManager(runtime);
			await manager.validateInstallPlugin(parsed.installSpec.slice(0, at), parsed.installSpec.slice(at + 1), parsed);
			if (
				!(await runtime.ui.confirm(
					parsed.force ? "Reinstall plugin?" : "Install plugin?",
					`${parsed.installSpec} [${parsed.scope}]\nPlugins may provide executable tools, hooks, and MCP servers. Install only trusted plugins.${parsed.force ? "\nThe existing cached plugin will be replaced, including references from another scope." : ""}`,
					{ signal: runtime.signal },
				))
			)
				return commandConsumed();
		} else if (verb === "uninstall") {
			const parsed = parsePluginScopeArgs(
				rest,
				"Usage: /marketplace uninstall [--scope user|project] <name@marketplace>",
			);
			if ("error" in parsed) return usage(parsed.error, runtime);
			if (
				!(await runtime.ui.confirm(
					"Uninstall plugin?",
					`${parsed.pluginId}${parsed.scope ? ` [${parsed.scope}]` : ""}\nRemove this native plugin installation?`,
					{ signal: runtime.signal },
				))
			)
				return commandConsumed();
		}
		runtime.signal?.throwIfAborted();
		return execute({ ...command, args: `${verb}${rest ? ` ${rest}` : ""}` }, runtime);
	} catch (error) {
		return usage(`Marketplace error: ${errorMessage(error)}`, runtime);
	}
}

/** Native plugin configuration shared by /plugins settings and the browser settings command. */
export async function showNativeWebGuiPluginSettings(
	runtime: SlashCommandRuntime,
	requestedPlugin?: string,
): Promise<SlashCommandResult> {
	const ui = runtime.ui;
	if (!ui?.input) return usage("Plugin settings require an interactive input UI.", runtime);
	try {
		for (;;) {
			runtime.signal?.throwIfAborted();
			const npm = new PluginManager(runtime.cwd);
			const marketplace = await createMarketplaceManager(runtime);
			const [npmPlugins, marketplacePlugins] = await Promise.all([npm.list(), marketplace.listInstalledPlugins()]);
			const choices = [
				...npmPlugins.map(plugin => ({
					label: `${plugin.name} [npm]`,
					description: `${plugin.version}${plugin.enabled ? "" : " (disabled)"}`,
				})),
				...marketplacePlugins.map(plugin => ({
					label: `${plugin.id} [${plugin.scope}]`,
					description: `${plugin.entries[0]?.version ?? "unknown version"}${plugin.shadowedBy ? " (shadowed)" : ""}`,
				})),
			];
			if (choices.length === 0) {
				await runtime.output("No plugins installed");
				return commandConsumed();
			}
			const matches = requestedPlugin
				? choices.filter(
						choice => choice.label === requestedPlugin || choice.label.startsWith(`${requestedPlugin} [`),
					)
				: [];
			if (requestedPlugin && matches.length === 0) return usage(`Plugin not found: ${requestedPlugin}`, runtime);
			const selected =
				matches.length === 1
					? matches[0]!.label
					: await ui.select("Plugin settings", matches.length ? matches : choices, { signal: runtime.signal });
			const index = choices.findIndex(choice => choice.label === selected);
			if (index < 0) return commandConsumed();
			const installedMarketplace =
				index >= npmPlugins.length ? marketplacePlugins[index - npmPlugins.length] : undefined;
			let plugin: InstalledPlugin | undefined = npmPlugins[index];
			if (installedMarketplace) {
				const entry = installedMarketplace.entries[0];
				if (!entry) throw new Error(`Installed plugin has no installation entry: ${installedMarketplace.id}`);
				const name = parsePluginId(installedMarketplace.id)?.name ?? installedMarketplace.id;
				plugin = await npm.getPlugin(name, { path: entry.installPath });
			}
			const enabled = installedMarketplace
				? installedMarketplace.entries.every(entry => entry.enabled !== false)
				: plugin!.enabled;
			const settings = plugin ? await npm.getPluginSettings(plugin.name) : {};
			const settingEntries = Object.entries(plugin?.manifest.settings ?? {});
			const features = installedMarketplace ? [] : Object.entries(plugin?.manifest.features ?? {});
			const actions = [
				{ label: enabled ? "Disable plugin" : "Enable plugin" },
				...features.map(([name, feature]) => ({ label: `Feature: ${name}`, description: feature.description })),
				...settingEntries.map(([key, schema]) => ({
					label: `Setting: ${key}`,
					description: schema.secret
						? "Secret value (hidden)"
						: `${schema.description ?? ""} — ${String(settings[key] ?? schema.default ?? "(not set)")}`,
				})),
			];
			const action = await ui.select(selected!, actions, { signal: runtime.signal });
			if (!action) {
				if (requestedPlugin) return commandConsumed();
				continue;
			}
			if (action === actions[0]!.label) {
				if (installedMarketplace)
					await marketplace.setPluginEnabled(installedMarketplace.id, !enabled, installedMarketplace.scope);
				else await npm.setEnabled(plugin!.name, !enabled);
			} else if (action.startsWith("Feature: ") && plugin) {
				const name = action.slice("Feature: ".length);
				if (!features.some(([key]) => key === name)) throw new Error("Unknown plugin feature");
				const effective = new Set(
					plugin.enabledFeatures ?? features.filter(([, feature]) => feature.default).map(([key]) => key),
				);
				const value = await ui.select(`Feature: ${name}`, ["enabled", "disabled"], {
					signal: runtime.signal,
					initialIndex: effective.has(name) ? 0 : 1,
				});
				if (!value) continue;
				if (value !== "enabled" && value !== "disabled") throw new Error("Invalid plugin feature selection");
				if (value === "enabled") effective.add(name);
				else effective.delete(name);
				await npm.setEnabledFeatures(plugin.name, [...effective]);
			} else if (action.startsWith("Setting: ") && plugin) {
				const key = action.slice("Setting: ".length);
				const schema = plugin.manifest.settings?.[key];
				if (!schema) throw new Error("Unknown plugin setting");
				const input =
					schema.type === "boolean" || schema.type === "enum"
						? await ui.select(`Set ${key}`, schema.type === "enum" ? schema.values : ["true", "false"], {
								signal: runtime.signal,
							})
						: await ui.input(
								`Set ${key}${schema.description ? ` — ${schema.description}` : ""}`,
								schema.secret ? undefined : String(settings[key] ?? schema.default ?? ""),
								{ signal: runtime.signal, secret: schema.secret },
							);
				if (input === undefined) continue;
				const value = parseSettingValue(input, schema);
				const validation = validateSetting(value, schema);
				if (!validation.valid) {
					await runtime.output(`Invalid plugin setting ${key}: ${validation.error}`);
					continue;
				}
				await npm.setPluginSetting(plugin.name, key, value);
			} else throw new Error("Invalid plugin settings selection");
			await runtime.reloadPlugins();
			await runtime.output(`Updated plugin: ${selected}`);
		}
	} catch (error) {
		return usage(`Plugin error: ${errorMessage(error)}`, runtime);
	}
}
