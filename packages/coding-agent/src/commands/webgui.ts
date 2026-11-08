import { Command } from "@oh-my-pi/pi-utils/cli";
import { webGuiHelp } from "../cli/command-help";
import { runWebGuiCommand } from "../webgui/host";

export default class WebGui extends Command {
	static description = webGuiHelp.description;
	static examples = ["omp webgui"];

	async run(): Promise<void> {
		await this.parse(WebGui);
		await runWebGuiCommand();
	}
}
