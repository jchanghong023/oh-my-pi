/**
 * Check for and install updates.
 */

import chalk from "@oh-my-pi/pi-utils/chalk";
import { Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { offlineFromEnv } from "@oh-my-pi/pi-utils/env";
import { updateHelp as commandHelp } from "../cli/command-help";
import * as pluginCli from "../cli/plugin-cli";
import { CliUsageError } from "../cli/usage-error";
import { initTheme } from "../ui/theme/service";

export default class Update extends Command {
	static description = commandHelp.description;
	static flags = {
		force: Flags.boolean({ char: "f", description: "Force update", default: false }),
		check: Flags.boolean({ char: "c", description: "Check for updates without installing", default: false }),
		plugins: Flags.boolean({ char: "l", description: "Update installed plugins", default: false }),
		canary: Flags.boolean({ description: "Unavailable; use --stable for OMP updates", default: false }),
		stable: Flags.boolean({ description: "Use the stable CNB release", default: false }),
	};

	static examples = ["omp update", "omp update --check", "omp update --plugins --check"];

	async run(): Promise<void> {
		const { flags } = await this.parse(Update);
		initTheme();
		if (flags.canary && flags.stable) throw new CliUsageError("--canary and --stable are mutually exclusive");
		if (flags.plugins) {
			await pluginCli.runPluginCommand({ action: "upgrade", args: [], flags: flags.check ? { dryRun: true } : {} });
		} else {
			if (offlineFromEnv()) throw new CliUsageError("OMP cannot check for or install updates in offline mode.");
			if (flags.canary) throw new CliUsageError("Canary updates are unavailable. Use `omp update --stable`.");
			try {
				const { runUpdateCommand } = await import("../cli/update-cli");
				await runUpdateCommand({
					force: flags.force,
					check: flags.check,
				});
			} catch (err) {
				console.error(chalk.red(err instanceof Error ? err.message : String(err)));
				process.exit(1);
			}
		}
	}
}
