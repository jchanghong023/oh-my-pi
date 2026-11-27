import { it } from "bun:test";
import * as os from "node:os";

type TestBody = () => void | Promise<void>;

/** Exercise runtime update state without inheriting user settings or credentials. */
export function isolatedUpdateTests(file: string) {
	const inChild = Bun.env.OMP_TEST_CNB_UPDATE_FILE === file;
	async function runInChild(name: string): Promise<void> {
		// Case names within each updater test file are unique. Match the literal
		// case name at the end of Bun's display name, regardless of its suite.
		const child = Bun.spawn(
			[process.execPath, "--no-env-file", "test", file, "--test-name-pattern", `${RegExp.escape(name)}$`],
			{
				env: {
					OMP_TEST_CNB_UPDATE_FILE: file,
					PATH: process.platform === "win32" ? "" : "/usr/bin:/bin",
					SystemRoot: process.env.SystemRoot,
					WINDIR: process.env.WINDIR,
					TEMP: os.tmpdir(),
					TMP: os.tmpdir(),
				},
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		if (exitCode !== 0 || !/\b1 pass\b/.test(stderr + stdout)) {
			throw new Error(`Expected one passing updater test (${name}):\n${stdout}\n${stderr}`);
		}
	}
	function register(name: string, body: TestBody, skip = false): void {
		it.skipIf(skip)(name, inChild ? body : () => runInChild(name));
	}
	return {
		it: Object.assign(register, {
			skipIf: (skip: boolean) => (name: string, body: TestBody) => register(name, body, skip),
		}),
	};
}
