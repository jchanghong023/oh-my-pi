import { fileURLToPath } from "node:url";
import { mkdir } from "node:fs/promises";
import * as path from "node:path";
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

test("command registration and version do not load addons or the default profile", async () => {
	using tempDir = TempDir.createSync("@omp-cli-registry-lazy-");
	const home = tempDir.join("home");
	const configRoot = tempDir.join("config");
	await mkdir(path.join(configRoot, "agent"), { recursive: true });
	await mkdir(home, { recursive: true });
	await Bun.write(path.join(configRoot, "agent", ".env"), "OMP_REGISTRY_PROFILE_SENTINEL=default\n");
	const registryUrl = new URL("../src/cli-commands.ts", import.meta.url).href;
	const probePath = tempDir.join("registry-probe.ts");
	await Bun.write(
		probePath,
		[
			`import { commands } from ${JSON.stringify(registryUrl)};`,
			'if (!commands.some(command => command.name === "openwiki")) throw new Error("OpenWiki not registered");',
			'if (process.env.OMP_REGISTRY_PROFILE_SENTINEL) throw new Error("Default profile was loaded");',
		].join("\n"),
	);
	const env = {
		PATH: process.env.PATH,
		SystemRoot: process.env.SystemRoot,
		WINDIR: process.env.WINDIR,
		HOME: home,
		USERPROFILE: home,
		OMP_CONFIG_ROOT: configRoot,
	};
	const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
	for (const args of [[probePath], [cliPath, "--version"]]) {
		const child = Bun.spawn([process.execPath, "--no-addons", ...args], {
			cwd: tempDir.path(),
			env,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [exitCode, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		expect(exitCode, stderr).toBe(0);
		if (args[0] === cliPath) expect(stdout.trim()).toBe(`${APP_NAME}/${VERSION}`);
	}
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
