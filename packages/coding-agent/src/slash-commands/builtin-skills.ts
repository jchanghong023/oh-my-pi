import { DEFAULT_SKILLS_URL } from "@oh-my-pi/pi-wire/skillshare";
import { cfgSkillsRegistryUrl } from "../extensibility/settings";
import { SkillshareClient } from "../skillshare/client";
import {
	formatInstalledSkills,
	formatScriptApproval,
	formatSkillChanges,
	formatSkillSearch,
	installSkillPackages,
	listInstalledSkills,
	type SkillChange,
	type SkillInstallHooks,
	updateSkillPackages,
} from "../skillshare/installer";
import { clearSubmittedText } from "./helpers/draft";
import { commandConsumed, errorMessage, parseSubcommand } from "./helpers/parse";
import type { SlashCommandSpec } from "./types";

const USAGE = [
	"Skill registry (skills.omp.sh) commands:",
	"  /skills search <query>                        Search the registry",
	"  /skills install <@scope/name[@range]>… [-g]   Install into this project (-g: user-global)",
	"  /skills installed                             List installed registry skills",
	"  /skills update [@scope/name…] [-g]            Update within the ranges in skills.json",
].join("\n");

/** Split `<name…> [--global|-g]`; unknown flags are errors. */
function parseTargets(rest: string): { names: string[]; global: boolean } | { error: string } {
	const names: string[] = [];
	let global = false;
	for (const token of rest.split(/\s+/)) {
		if (!token) continue;
		if (token === "--global" || token === "-g") global = true;
		else if (token.startsWith("-")) return { error: `Unknown option: ${token}\n\n${USAGE}` };
		else names.push(token);
	}
	return { names, global };
}

export const BUILTIN_SKILLS_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
	{
		name: "skills",
		icon: "skill",
		description: "Search, install, and update skills from the skills.omp.sh registry",
		subcommands: [
			{ name: "search", description: "Search the skill registry", usage: "<query>" },
			{ name: "install", description: "Install registry skills", usage: "<@scope/name[@range]>… [--global]" },
			{ name: "installed", description: "List installed registry skills" },
			{
				name: "update",
				description: "Update registry skills within their ranges",
				usage: "[@scope/name…] [--global]",
			},
		],
		allowArgs: true,
		handle: async (command, runtime) => {
			await handleSkillsCommand(command.args, {
				cwd: runtime.cwd,
				registryUrl: cfgSkillsRegistryUrl.get(runtime.settings) || DEFAULT_SKILLS_URL,
				output: text => runtime.output(text),
				error: text => runtime.output(text),
				refresh: async () => {
					await runtime.session.refreshSkills();
					await runtime.refreshCommands();
				},
				hooks: {
					warn: message => runtime.session.emitNotice("warning", message),
					confirmScripts: request => {
						if (!runtime.ui) throw new Error("Installing a skill with scripts requires a confirmation UI.");
						return runtime.ui.confirm(
							"Install skill with scripts?",
							formatScriptApproval(request),
							runtime.signal ? { signal: runtime.signal } : undefined,
						);
					},
				},
			});
			return commandConsumed();
		},
		handleTui: async (command, runtime) => {
			const { ctx } = runtime;
			const session = ctx.session;
			clearSubmittedText(runtime);
			await handleSkillsCommand(command.args, {
				cwd: ctx.sessionManager.getCwd(),
				registryUrl: cfgSkillsRegistryUrl.get(ctx.settings) || DEFAULT_SKILLS_URL,
				output: text => session.emitNotice("info", text),
				error: text => session.emitNotice("error", text),
				refresh: () => ctx.refreshSkillState(),
				hooks: {
					warn: message => session.emitNotice("warning", message),
					confirmScripts: request =>
						ctx.showHookConfirm("Install skill with scripts?", formatScriptApproval(request)),
				},
			});
		},
	},
];

interface SkillCommandContext {
	cwd: string;
	registryUrl: string;
	output(text: string, options?: { dim?: boolean }): Promise<void> | void;
	error(text: string): Promise<void> | void;
	refresh(): Promise<void>;
	hooks: SkillInstallHooks;
}

async function reportSkillChanges(context: SkillCommandContext, changes: SkillChange[]): Promise<void> {
	if (changes.length === 0) {
		await context.output("Registry skills are already up to date.");
		return;
	}
	await context.refresh();
	await context.output(formatSkillChanges(changes));
}

/** The registry operation is identical for terminal and protocol callers. */
async function handleSkillsCommand(args: string, context: SkillCommandContext): Promise<void> {
	const { verb, rest } = parseSubcommand(args);
	const cwd = context.cwd;
	try {
		switch (verb) {
			case "search": {
				if (!rest) {
					await context.error("Usage: /skills search <query>");
					return;
				}
				const response = await withSkillRegistryClient(context.registryUrl, client => client.search(rest));
				await context.output(formatSkillSearch(response));
				return;
			}
			case "install": {
				const targets = parseTargets(rest);
				if ("error" in targets) {
					await context.error(targets.error);
					return;
				}
				if (targets.names.length === 0) {
					await context.error("Usage: /skills install <@scope/name[@range]>… [--global]");
					return;
				}
				await context.output(`Installing ${targets.names.join(", ")}…`, { dim: true });
				const changes = await withSkillRegistryClient(context.registryUrl, client =>
					installSkillPackages(
						client,
						{ specs: targets.names, global: targets.global, yes: false, cwd },
						context.hooks,
					),
				);
				await reportSkillChanges(context, changes);
				return;
			}
			case "installed":
				await context.output(formatInstalledSkills(await listInstalledSkills(cwd)));
				return;
			case "update": {
				const targets = parseTargets(rest);
				if ("error" in targets) {
					await context.error(targets.error);
					return;
				}
				await context.output("Checking the registry for updates…", { dim: true });
				const changes = await withSkillRegistryClient(context.registryUrl, client =>
					updateSkillPackages(client, { names: targets.names, global: targets.global, cwd }, context.hooks),
				);
				await reportSkillChanges(context, changes);
				return;
			}
			case "":
			case "help":
				await context.output(USAGE);
				return;
			default:
				await context.error(`Unknown /skills subcommand: ${verb}\n\n${USAGE}`);
		}
	} catch (error) {
		await context.error(`Skills: ${errorMessage(error)}`);
	}
}

async function withSkillRegistryClient<T>(
	registryUrl: string,
	run: (client: SkillshareClient) => Promise<T>,
): Promise<T> {
	const client = await SkillshareClient.create({ registryUrl });
	try {
		return await run(client);
	} finally {
		client.close();
	}
}
