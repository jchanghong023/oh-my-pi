import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { openwikiHelp } from "../cli/command-help";
import { runOpenWikiCommand } from "../cli/openwiki-cli";

export default class OpenWiki extends Command {
	static description = openwikiHelp.description;
	static strict = false;
	static args = {
		command: Args.string({ description: "code, link, workspace, or visualize", required: false }),
	};
	static flags = {
		init: Flags.boolean({ description: "Generate the repository wiki" }),
		update: Flags.boolean({ description: "Incrementally update the repository wiki" }),
		"dry-run": Flags.boolean({ description: "Preview model and candidate files without model calls or Wiki writes" }),
		language: Flags.string({ char: "l", description: "Output language (BCP-47 locale; default: zh-CN)" }),
		modelId: Flags.string({ description: "Shared OMP model selector (also --model-id)" }),
		"planner-model": Flags.string({ description: "Override the planning agent's OMP model" }),
		print: Flags.boolean({ char: "p", description: "Print output instead of interactive display" }),
		debug: Flags.boolean({ description: "Show debug diagnostics" }),
		"telemetry-file": Flags.string({ description: "Write disabled local telemetry status" }),
		port: Flags.integer({ description: "Visualizer port" }),
		"no-open": Flags.boolean({ description: "Do not open a browser" }),
		export: Flags.string({ description: "Export the visualizer to a directory" }),
	};
	static examples = [
		"omp openwiki code --init",
		"omp openwiki code --update --dry-run",
		"omp openwiki --update --modelId provider/model",
		"omp openwiki --init --modelId provider/page-model --planner-model provider/plan-model",
		"omp openwiki link [directory]",
		"omp openwiki workspace use <workspace> | current | clear",
		"omp openwiki visualize [path] [--port <port>] [--no-open]",
		"omp openwiki visualize [path] --export <directory>",
	];

	async run(): Promise<void> {
		process.exitCode = await runOpenWikiCommand(this.argv);
	}
}
