import { runTestCommands } from "../ci-test-ts";

export type CiTestDriverArgs = Parameters<typeof runTestCommands>;
export const ciTestDriverPath = import.meta.path;

if (import.meta.main) {
	const args: CiTestDriverArgs = JSON.parse(Bun.argv[2]!);
	process.exitCode = await runTestCommands(...args);
}
