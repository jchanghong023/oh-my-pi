import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { reportCliUsageError } from "../cli/args";
import { docsHelp as commandHelp } from "../cli/command-help";
import { type DocsAction, runDocsCommand } from "../cli/docs-cli";
import { CliUsageError } from "../cli/usage-error";

const ACTIONS: DocsAction[] = ["init", "remove"];

export default class Docs extends Command {
	static description = commandHelp.description;
	static args = {
		action: Args.string({ description: "Docs action", required: true, options: ACTIONS }),
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
		const { args, flags } = await this.parse(Docs);
		const action = args.action as DocsAction;
		const target = args.target;
		try {
			if (action === "init") {
				if (!target) throw new CliUsageError("docs init requires <dir>");
				if (!flags.name?.trim()) throw new CliUsageError("docs init requires --name <name>");
				if (flags.force) throw new CliUsageError("--force is valid only for docs remove");
			} else {
				if (!target) throw new CliUsageError("docs remove requires <name>");
				if (!flags.force) throw new CliUsageError("docs remove requires --force");
				if (flags.name) throw new CliUsageError("docs remove does not accept --name");
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
			process.exitCode = await runDocsCommand({
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
			// 130 inside runDocsCommand; anything reaching this catch is a real
			// failure.
			process.stderr.write(`${chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}`)}\n`);
			process.exitCode = 1;
		} finally {
			process.off("SIGINT", onSigint);
		}
	}
}
