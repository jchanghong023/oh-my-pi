import { Command } from "@oh-my-pi/pi-utils/cli";
import { webGuiHelp } from "../cli/command-help";
import { runWebGuiCommand } from "../webgui/host";
import { activateNativeWebGuiComposition } from "../webgui/native-composition";

export default class WebGui extends Command {
	static description = webGuiHelp.description;
	static examples = ["omp webgui"];

	async run(): Promise<void> {
		await this.parse(WebGui);
		activateNativeWebGuiComposition();
		await runWebGuiCommand();
	}
}
