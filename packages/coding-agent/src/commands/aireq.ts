import { CliUsageError, Command } from "@oh-my-pi/pi-utils/cli";
import { type Args, parseArgs } from "../cli/args";
import { aiReqHelp } from "../cli/command-help";
import { runAIReqWorkbenchCommand } from "../aireq-workbench/host";
import { launchHelp } from "./launch-help";

/** Parse only launch configuration: opening a workbench never submits a prompt. */
export function parseAIReqArgs(argv: string[]): Args {
	const parsed = parseArgs(argv);
	if (parsed.messages.length || parsed.fileArgs.length) {
		throw new CliUsageError(
			"omp aireq takes no prompt or subcommands. Open omp aireq and use the browser workbench.",
		);
	}
	if (parsed.invalidFlagValues.length) throw new CliUsageError(parsed.invalidFlagValues.join("\n"));
	if (parsed.unrecognizedFlags.length) {
		throw new CliUsageError(`Unknown AIReq option: ${parsed.unrecognizedFlags.join(", ")}. Run omp aireq --help.`);
	}
	if (
		parsed.mode !== undefined ||
		parsed.print ||
		parsed.goal !== undefined ||
		parsed.planYolo ||
		parsed.continue ||
		parsed.resume ||
		parsed.restore ||
		parsed.fork ||
		parsed.fromClaude ||
		parsed.fromCodex ||
		parsed.export ||
		parsed.alias ||
		parsed.join
	) {
		throw new CliUsageError(
			"omp aireq only opens the browser workbench; prompt, mode, session-resume and export operations are not supported.",
		);
	}
	return parsed;
}

export default class AIReq extends Command {
	static description = aiReqHelp.description;
	static strict = false;
	static flags = {
		cwd: launchHelp.flags.cwd,
		profile: launchHelp.flags.profile,
		"allow-home": launchHelp.flags["allow-home"],
		model: launchHelp.flags.model,
		provider: launchHelp.flags.provider,
		smol: launchHelp.flags.smol,
		slow: launchHelp.flags.slow,
		plan: launchHelp.flags.plan,
		models: launchHelp.flags.models,
		config: launchHelp.flags.config,
		"add-dir": launchHelp.flags["add-dir"],
		"api-key": launchHelp.flags["api-key"],
		"system-prompt": launchHelp.flags["system-prompt"],
		"system-prompt-template": launchHelp.flags["system-prompt-template"],
		"append-system-prompt": launchHelp.flags["append-system-prompt"],
		thinking: launchHelp.flags.thinking,
		"service-tier": launchHelp.flags["service-tier"],
		"session-dir": launchHelp.flags["session-dir"],
		"no-session": launchHelp.flags["no-session"],
		tools: launchHelp.flags.tools,
		"no-tools": launchHelp.flags["no-tools"],
		"no-lsp": launchHelp.flags["no-lsp"],
		"no-pty": launchHelp.flags["no-pty"],
		hook: launchHelp.flags.hook,
		extension: launchHelp.flags.extension,
		"no-extensions": launchHelp.flags["no-extensions"],
		skills: launchHelp.flags.skills,
		"no-skills": launchHelp.flags["no-skills"],
		"no-rules": launchHelp.flags["no-rules"],
		"no-context-files": launchHelp.flags["no-context-files"],
		"no-title": launchHelp.flags["no-title"],
		"approval-mode": launchHelp.flags["approval-mode"],
		"auto-approve": launchHelp.flags["auto-approve"],
		"max-time": launchHelp.flags["max-time"],
		"max-cost": launchHelp.flags["max-cost"],
		"warn-cost": launchHelp.flags["warn-cost"],
	};
	static examples = ["omp aireq", "omp aireq --cwd ./project --profile work --model opus"];

	async run(): Promise<void> {
		await this.parse(AIReq);
		const parsed = parseAIReqArgs(this.argv);
		await runAIReqWorkbenchCommand(parsed, this.argv);
	}
}
