import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { reportCliUsageError } from "../cli/args";
import { knowledgeHelp as commandHelp } from "../cli/command-help";
import { type KnowledgeAction, runKnowledgeCommand } from "../cli/knowledge-cli";
import { CliUsageError } from "../cli/usage-error";

const ACTIONS: KnowledgeAction[] = ["init", "remove"];

export default class Knowledge extends Command {
	static description = commandHelp.description;
	static args = {
		action: Args.string({ description: "Knowledge action", required: true, options: ACTIONS }),
		target: Args.string({
			description: "Directory for init or index name for remove",
			required: false,
		}),
	};
	static flags = {
		name: Flags.string({ description: "Unique index name (init only)" }),
		json: Flags.boolean({ description: "Output one JSON value", default: false }),
		force: Flags.boolean({ description: "Confirm destructive removal", default: false }),
	};

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Knowledge);
		const action = args.action as KnowledgeAction;
		const target = args.target;
		try {
			if (action === "init") {
				if (!target) throw new CliUsageError("knowledge init requires <dir>");
				if (!flags.name?.trim()) throw new CliUsageError("knowledge init requires --name <name>");
				if (flags.force) throw new CliUsageError("--force is valid only for knowledge remove");
			} else {
				if (!target) throw new CliUsageError("knowledge remove requires <name>");
				if (!flags.force) throw new CliUsageError("knowledge remove requires --force");
				if (flags.name !== undefined) throw new CliUsageError("knowledge remove does not accept --name");
			}
		} catch (error) {
			// This class is `../cli/usage-error`, which the pi-utils framework handler
			// does not recognise, so an unreported throw would print a code frame and a
			// stack instead of the message (same pattern as `launch`/`acp`).
			if (reportCliUsageError(error)) {
				process.exitCode = 2;
				return;
			}
			throw error;
		}
		const controller = new AbortController();
		const onSigint = () => controller.abort();
		process.once("SIGINT", onSigint);
		try {
			process.exitCode = await runKnowledgeCommand({
				action,
				target,
				name: flags.name,
				json: flags.json,
				signal: controller.signal,
			});
		} catch (error) {
			// Service failures (duplicate name, unknown index, empty root, a
			// build already running) are expected user-facing errors: report the
			// message like the usage-error path above instead of letting the
			// framework print a stack. Aborts are already mapped to exit code
			// 130 inside runKnowledgeCommand; anything reaching this catch is a real
			// failure.
			process.stderr.write(
				`${chalk.red(sanitizeText(`Error: ${error instanceof Error ? error.message : String(error)}`.replace(/[\r\n\t]+/g, " ")))}\n`,
			);
			process.exitCode = 1;
		} finally {
			process.off("SIGINT", onSigint);
		}
	}
}
