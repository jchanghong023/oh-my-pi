import { it } from "bun:test";

type TestBody = () => void | Promise<void>;

/** The updater captures its repository at import time, so run each selected case in a fresh process. */
export function updateRepositoryTests(file: string, repository: string) {
	const inChild = Bun.env.OMP_TEST_UPDATE_REPOSITORY_FILE === file;
	async function runInChild(name: string): Promise<void> {
		// Case names within each updater test file are unique. Match the literal
		// case name at the end of Bun's display name, regardless of its suite.
		const child = Bun.spawn([process.execPath, "test", file, "--test-name-pattern", `${RegExp.escape(name)}$`], {
			env: { ...process.env, PI_UPDATE_REPOSITORY: repository, OMP_TEST_UPDATE_REPOSITORY_FILE: file },
			stdout: "pipe",
			stderr: "pipe",
		});
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
		inChild,
		it: Object.assign(register, {
			skipIf: (skip: boolean) => (name: string, body: TestBody) => register(name, body, skip),
		}),
	};
}
