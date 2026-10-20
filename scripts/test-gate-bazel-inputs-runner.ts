import * as path from "node:path";
import { discoverGateInputs } from "./test-gate-bazel-inputs";
import type { GateCommand } from "./test-gate-runtime";

interface InputRequest {
	root: string;
	files: string[];
	commands: Pick<GateCommand, "label" | "argv" | "cwd">[];
	output: string;
}

// This process only discovers inputs. Bun's build API is used by discovery for
// its in-memory metafile; no generated bundle or test command is executed.
try {
	const requestFile = process.argv[2]!;
	if (!path.isAbsolute(requestFile)) throw new Error("Bazel input discovery requires an absolute request path");
	const request = JSON.parse(await Bun.file(requestFile).text()) as InputRequest;
	if (!path.isAbsolute(request.root) || !path.isAbsolute(request.output))
		throw new Error("Bazel input discovery requires absolute root and output paths");
	process.chdir(request.root);
	const graph = await discoverGateInputs(request.root, request.commands, request.files);
	await Bun.write(request.output, `${JSON.stringify(graph)}\n`);
} catch (error) {
	console.error(error);
	process.exitCode = 1;
}
