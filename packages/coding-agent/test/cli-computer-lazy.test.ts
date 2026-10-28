import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils";
import { APP_NAME, VERSION } from "@oh-my-pi/pi-utils/dirs";

test("normal CLI startup keeps computer worker modules lazy", async () => {
	using tempDir = TempDir.createSync("@omp-cli-computer-lazy-");
	const cliUrl = new URL("../src/cli.ts", import.meta.url).href;
	const probePath = tempDir.join("probe.ts");
	// Import by file URL inside the child so only that fresh process evaluates the CLI graph.
	await Bun.write(
		probePath,
		[
			`import { runCli } from ${JSON.stringify(cliUrl)};`,
			"process.stdout.write = () => true;",
			'await runCli(["--version"]);',
		].join("\n"),
	);

	// `--no-addons` is a process-local sentinel: evaluating the computer worker graph
	// attempts to load the desktop addon and fails, while prelude registration must not.
	const child = Bun.spawn([process.execPath, "--no-addons", probePath], { stdout: "pipe", stderr: "pipe" });
	const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
	expect(exitCode, stderr).toBe(0);
});

test("version and root help use the application version", async () => {
	const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
	for (const argument of ["--version", "--help"]) {
		const child = Bun.spawn([process.execPath, cliPath, argument], {
			env: { ...process.env, PI_BUILD_TIMESTAMP: "ignored-timestamp" },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [exitCode, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		expect(exitCode, stderr).toBe(0);
		if (argument === "--version") {
			expect(stdout.trim()).toBe(`${APP_NAME}/${VERSION}`);
		} else {
			expect(stdout).toContain(`${APP_NAME} v${VERSION}`);
		}
		expect(stdout).not.toContain("ignored-timestamp");
	}
});
