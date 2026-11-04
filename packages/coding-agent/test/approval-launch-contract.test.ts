import { afterEach, describe, expect, it } from "bun:test";
import { parseArgs, reportInvalidFlagValues } from "@oh-my-pi/pi-coding-agent/cli/args";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { clearOmpExtensionCliRoots } from "@oh-my-pi/pi-coding-agent/discovery/omp-extension-roots";
import { runRootCommand } from "@oh-my-pi/pi-coding-agent/main";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import {
	resolveApproval,
	resolveApprovalFromContext,
	type ApprovalMode,
} from "@oh-my-pi/pi-coding-agent/tools/approval";
import { cfgToolsApprovalMode } from "@oh-my-pi/pi-coding-agent/tools/settings";
import { logger, TempDir } from "@oh-my-pi/pi-utils";

const modes: ApprovalMode[] = ["always-ask", "always-ask-cached", "write", "yolo", "guarded"];

afterEach(() => {
	clearOmpExtensionCliRoots();
	logger.endTiming();
});

describe("approval launch contract", () => {
	it.each(modes)("accepts %s consistently in CLI and settings", mode => {
		const parsed = parseArgs(["--approval-mode", mode]);
		expect(parsed.invalidFlagValues).toEqual([]);
		expect(parsed.approvalMode).toBe(mode);
		const configured = resolveApprovalFromContext({ settings: Settings.isolated({ "tools.approvalMode": mode }) });
		expect(configured.approvalMode).toBe(parsed.approvalMode!);
		for (const tier of ["read", "write", "exec"] as const) {
			const tool = { name: "mode_probe", approval: tier };
			expect(resolveApproval(tool, {}, configured.approvalMode)).toEqual(
				resolveApproval(tool, {}, parsed.approvalMode!),
			);
		}
	});

	it("uses guarded for this launch over a saved write policy without persisting the flag", async () => {
		using root = TempDir.createSync("@approval-launch-");
		const config = root.join("config.yml");
		const saved = "tools:\n  approvalMode: write\n";
		await Bun.write(config, saved);
		const settings = await Settings.loadReadOnly({ cwd: root.path(), agentDir: root.path() });
		const authStorage = await AuthStorage.create(":memory:");
		authStorage.keys.setRuntime("openai", "test-key");
		const argv = [
			"--print",
			"--no-session",
			"--no-skills",
			"--no-rules",
			"--approval-mode",
			"guarded",
			"--cwd",
			root.path(),
			"probe",
		];
		const stop = new Error("captured launch settings");
		let observed: ApprovalMode | undefined;
		try {
			await expect(
				runRootCommand(parseArgs(argv), argv, {
					settings,
					discoverAuthStorage: async () => authStorage,
					createAgentSession: async options => {
						observed = resolveApprovalFromContext({ settings: options?.settings }).approvalMode;
						throw stop;
					},
				}),
			).rejects.toBe(stop);
			expect(observed).toBe("guarded");
			expect(cfgToolsApprovalMode.provenance(settings)).toBe("runtime");
			expect(await Bun.file(config).text()).toBe(saved);
			const reloaded = await Settings.loadReadOnly({ cwd: root.path(), agentDir: root.path() });
			expect(resolveApprovalFromContext({ settings: reloaded }).approvalMode).toBe("write");
		} finally {
			authStorage.close();
		}
	});

	it.each(["sometimes", "", "YOLO", "guarded "])(
		"rejects the invalid CLI mode %j and lists all supported values",
		invalid => {
			const parsed = parseArgs([`--approval-mode=${invalid}`]);
			expect(parsed.approvalMode).toBeUndefined();
			let stderr = "";
			expect(
				reportInvalidFlagValues(parsed, text => {
					stderr += text;
				}),
			).toBe(true);
			expect(stderr).toContain(`Invalid --approval-mode value: ${JSON.stringify(invalid)}`);
			for (const mode of modes) expect(stderr).toContain(mode);
		},
	);

	it("falls back from a damaged saved mode to yolo without rewriting the configuration", async () => {
		using root = TempDir.createSync("@approval-invalid-mode-");
		const file = root.join("config.yml");
		const saved = "tools:\n  approvalMode: sometimes\n";
		await Bun.write(file, saved);
		const settings = await Settings.loadReadOnly({ cwd: root.path(), agentDir: root.path() });
		const resolved = resolveApprovalFromContext({ settings });
		expect(resolved.approvalMode).toBe("yolo");
		for (const tier of ["read", "write", "exec"] as const) {
			expect(resolveApproval({ name: "damaged_mode_probe", approval: tier }, {}, resolved.approvalMode).policy).toBe(
				"allow",
			);
		}
		expect(await Bun.file(file).text()).toBe(saved);
	});
});
