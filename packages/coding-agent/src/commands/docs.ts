import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
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
		if (action === "init") {
			if (!target) throw new CliUsageError("docs init requires <dir>");
			if (!flags.name?.trim()) throw new CliUsageError("docs init requires --name <name>");
			if (flags.force) throw new CliUsageError("--force is valid only for docs remove");
		} else {
			if (!target) throw new CliUsageError("docs remove requires <name>");
			if (!flags.force) throw new CliUsageError("docs remove requires --force");
			if (flags.name) throw new CliUsageError("docs remove does not accept --name");
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
				force: flags.force,
				signal: controller.signal,
			});
		} finally {
			process.off("SIGINT", onSigint);
		}
	}
}
