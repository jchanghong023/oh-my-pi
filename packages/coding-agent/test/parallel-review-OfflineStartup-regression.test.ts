import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { resolveCliModel } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { runRootCommand } from "@oh-my-pi/pi-coding-agent/main";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { TempDir } from "@oh-my-pi/pi-utils";

const CHILD_FLAG = "--disabled-company-startup-child";
const STOP = new Error("startup role snapshot captured");
const AVAILABLE_SELECTOR = "anthropic/claude-opus-4-5";

// Startup publishes process-global company/worker state, so isolate the real
// startup path rather than changing the test runner's environment or providers.
if (process.argv.includes(CHILD_FLAG)) {
	const authStorage = await AuthStorage.create(":memory:");
	authStorage.keys.setRuntime("anthropic", "fixture-key");
	const settings = Settings.isolated({
		disabledProviders: ["company"],
		modelRoles: { default: AVAILABLE_SELECTOR },
	});
	const argv = [
		"--print",
		"--no-prewalk",
		"--no-tools",
		"--no-lsp",
		"--no-session",
		"--no-extensions",
		"--no-skills",
		"--no-rules",
		"hi",
	];
	let snapshot: { selector?: string; error?: string } | undefined;
	try {
		await runRootCommand(parseArgs(argv), argv, {
			settings,
			discoverAuthStorage: async () => authStorage,
			createAgentSession: async options => {
				if (!options?.modelRegistry || !options.settings) {
					throw new Error("Startup omitted the model registry or effective settings");
				}
				const selection = resolveCliModel({
					cliModel: "@smol",
					modelRegistry: options.modelRegistry,
					settings: options.settings,
				});
				snapshot = { selector: selection.selector, error: selection.error };
				throw STOP;
			},
		});
	} catch (error) {
		if (error !== STOP) throw error;
	} finally {
		authStorage.close();
	}
	if (snapshot === undefined) throw new Error("Startup did not reach session construction");
	process.stdout.write(JSON.stringify(snapshot));
	process.exit(0);
}

describe("offline startup with a disabled company provider", () => {
	it("does not pin otherwise unconfigured model roles to the disabled lane", async () => {
		using tempDir = TempDir.createSync("@omp-disabled-company-startup-");
		const root = tempDir.path();
		const claudeDir = path.join(root, "claude");
		await Bun.write(
			path.join(claudeDir, "settings.json"),
			JSON.stringify({
				env: {
					ANTHROPIC_BASE_URL: "http://company.invalid",
					ANTHROPIC_AUTH_TOKEN: "fixture-token",
				},
			}),
		);
		const child = Bun.spawn([process.execPath, "run", import.meta.path, CHILD_FLAG], {
			cwd: root,
			env: {
				...process.env,
				HOME: root,
				USERPROFILE: root,
				OMP_CONFIG_ROOT: root,
				PI_CODING_AGENT_DIR: path.join(root, "agent"),
				OMP_PROFILE: undefined,
				PI_PROFILE: undefined,
				OMP_OFFLINE: "1",
				CLAUDE_CONFIG_DIR: claudeDir,
				PI_TIMING: undefined,
				PI_SMOL_MODEL: undefined,
				PI_SLOW_MODEL: undefined,
				PI_PLAN_MODEL: undefined,
			},
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			windowsHide: true,
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect(exitCode, stderr).toBe(0);
		expect(stderr).not.toContain("Company provider unavailable");
		// The unconfigured smol role must inherit the usable configured default,
		// rather than refuse a disabled company selector injected at startup.
		expect(JSON.parse(stdout)).toEqual({ selector: AVAILABLE_SELECTOR });
	}, 30_000);
});
