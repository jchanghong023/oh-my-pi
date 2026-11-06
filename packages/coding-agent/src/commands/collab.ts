/**
 * Discover local Collab hosts, retrieve links, or run the offline intranet relay.
 */
import { Args, CliUsageError, Command, type FlagDescriptor, Flags } from "@oh-my-pi/pi-utils/cli";
import { runCollabLinkCommand, runCollabListCommand } from "../cli/collab-cli";
import { collabHelp as commandHelp } from "../cli/command-help";
import { intranetCollabEnabled } from "../collab/intranet";
import { CollabLinkError } from "../collab/registry";
import { startIntranetRelay } from "../collab/relay-server";

export default class Collab extends Command {
	static description = intranetCollabEnabled()
		? "List local Collab hosts, retrieve links, or serve the offline intranet relay"
		: commandHelp.description;

	static args = {
		action: Args.string({
			description: intranetCollabEnabled() ? "list (default), link, or serve" : "list (default) or link",
			required: false,
			options: intranetCollabEnabled() ? ["list", "link", "serve"] : ["list", "link"],
		}),
		selector: Args.string({ description: "Host instance ID or PID (link only)", required: false }),
	};

	static flags = {
		view: Flags.boolean({
			description: "Request a view-only link instead of control access (link only)",
			default: false,
		}),
		json: Flags.boolean({ char: "j", description: "Emit deterministic machine-readable JSON", default: false }),
		...(intranetCollabEnabled()
			? {
					host: Flags.string({ description: "Listen hostname (serve only; default 127.0.0.1)" }),
					port: Flags.integer({ description: "Listen port (serve only; default 7466)" }),
				}
			: {}),
	} satisfies Record<string, FlagDescriptor>;

	static examples = [
		"omp collab list",
		"omp collab list --json",
		"omp collab link <instanceId|pid>",
		"omp collab link <pid> --view",
		...(intranetCollabEnabled() ? ["omp collab serve", "omp collab serve --host 0.0.0.0 --port 7466"] : []),
	];

	async run(): Promise<void> {
		const { args, argv, flags } = await this.parse(Collab);
		if (args.action === "serve" && intranetCollabEnabled()) {
			if (argv.length !== 1 || flags.view || flags.json) {
				throw new CliUsageError(
					"collab serve accepts only --host and --port (usage: collab serve [--host host] [--port port])",
				);
			}
			const hostname = typeof flags.host === "string" ? flags.host : undefined;
			const port = typeof flags.port === "number" ? flags.port : undefined;
			if (hostname !== undefined && !hostname.trim()) throw new CliUsageError("Relay hostname must not be empty.");
			if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65_535)) {
				throw new CliUsageError("Relay port must be between 0 and 65535.");
			}
			const relay = startIntranetRelay({ hostname, port });
			const stopped = Promise.withResolvers<void>();
			const shutdown = (): void => {
				relay.stop();
				stopped.resolve();
			};
			process.once("SIGINT", shutdown);
			process.once("SIGTERM", shutdown);
			try {
				process.stdout.write(`Intranet collab relay listening on ${relay.url}\n`);
				await stopped.promise;
			} finally {
				process.off("SIGINT", shutdown);
				process.off("SIGTERM", shutdown);
				relay.stop();
			}
			return;
		}
		if (flags.host !== undefined || flags.port !== undefined) {
			throw new CliUsageError("--host and --port are only supported by collab serve.");
		}
		if ((args.action ?? "list") === "list") {
			if (argv.length > 1 || flags.view) {
				throw new CliUsageError("collab list accepts no selector or --view (usage: collab list [--json])");
			}
			await runCollabListCommand({ json: flags.json === true });
			return;
		}

		if (argv.length !== 2 || !args.selector) {
			throw new CliUsageError(
				"collab link requires exactly one selector (usage: collab link <instanceId|pid> [--view] [--json])",
			);
		}
		try {
			await runCollabLinkCommand({ selector: args.selector, view: flags.view === true, json: flags.json === true });
		} catch (error) {
			if (!(error instanceof CollabLinkError)) throw error;
			process.stderr.write(`error: ${error.message}\n`);
			process.exitCode = 1;
		}
	}
}
