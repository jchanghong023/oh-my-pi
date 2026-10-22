import { fileURLToPath } from "node:url";
import { isCompiledBinary } from "@oh-my-pi/pi-utils";
import { workerHostEntry } from "@oh-my-pi/pi-utils/worker-host";
import {
	runWorkflowScript as runExtractedWorkflowScript,
	type RunWorkflowOptions,
} from "./vendor/dynamic-workflow-runtime/index.js";

export type { DriverFactory, RunControlBinding, RunWorkflowOptions } from "./vendor/dynamic-workflow-runtime/index.js";

/** Hidden self-exec selector, dispatched before ordinary CLI/profile parsing. */
export const ZCODE_DWF_CHILD_ARG = "__zcode_dwf_child";

/**
 * Keep the original runner/engine authoritative. Only the process entry differs:
 * the same OMP executable hosts its self-contained sandbox file, in source,
 * bundled and compiled distributions. No Node installation or Node CLI flags.
 */
export function runWorkflowScript(options: RunWorkflowOptions) {
	const argsPrefix = isCompiledBinary()
		? [ZCODE_DWF_CHILD_ARG]
		: [workerHostEntry() ?? fileURLToPath(new URL("../../../cli.ts", import.meta.url)), ZCODE_DWF_CHILD_ARG];
	return runExtractedWorkflowScript({
		...options,
		childSpawn: options.childSpawn ?? { argsPrefix },
	});
}
