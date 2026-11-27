import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils";
import { APP_NAME, VERSION } from "@oh-my-pi/pi-utils/dirs";

const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const versionEnv = {
	SystemRoot: process.env.SystemRoot,
	WINDIR: process.env.WINDIR,
	BUN_RUNTIME_TRANSPILER_CACHE_PATH: process.env.BUN_RUNTIME_TRANSPILER_CACHE_PATH,
	PI_BUILD_VERSION: process.env.PI_BUILD_VERSION,
};

test("command registration and version keep addons and the default profile lazy", async () => {
	using tempDir = TempDir.createSync("@omp-cli-registry-lazy-");
	const home = tempDir.path();
	await Bun.write(tempDir.join(".omp", "agent", ".env"), "OMP_REGISTRY_PROFILE_SENTINEL=default\n");
	const registryUrl = new URL("../src/cli-commands.ts", import.meta.url).href;
	const cliUrl = new URL("../src/cli.ts", import.meta.url).href;
	const probePath = tempDir.join("probe.ts");
	await Bun.write(
		probePath,
		[
			`import { commands } from ${JSON.stringify(registryUrl)};`,
			'if (!commands.some(command => command.name === "agents")) throw new Error("Agents command not registered");',
			'if (process.env.OMP_REGISTRY_PROFILE_SENTINEL) throw new Error("Command registration loaded the default profile");',
			`const { runCli } = await import(${JSON.stringify(cliUrl)});`,
			'await runCli(["--version"]);',
			'if (process.env.OMP_REGISTRY_PROFILE_SENTINEL) throw new Error("Version loaded the default profile");',
		].join("\n"),
	);
	// `--no-addons` catches eager desktop worker imports in both CLI entry paths.
	for (const args of [[probePath], [cliPath, "--version"]]) {
		const child = Bun.spawn([process.execPath, "--no-addons", ...args], {
			cwd: home,
			env: { ...versionEnv, HOME: home, USERPROFILE: home },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [exitCode, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		expect(exitCode, stderr).toBe(0);
		expect(stdout.trim()).toBe(`${APP_NAME}/${VERSION}`);
	}
});

test("root help uses the application version", async () => {
	using tempDir = TempDir.createSync("@omp-cli-root-help-");
	const home = tempDir.path();
	const child = Bun.spawn([process.execPath, cliPath, "--help"], {
		cwd: home,
		env: { ...versionEnv, HOME: home, USERPROFILE: home },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	expect(exitCode, stderr).toBe(0);
	expect(stdout).toContain(`${APP_NAME} v${VERSION}`);
});
