import { describe, expect, it } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { extractProfileFlags } from "@oh-my-pi/pi-coding-agent/cli/profile-bootstrap";

describe("temporary startup file logging", () => {
	it("parses a valueless flag without swallowing the profile or prompt", () => {
		const extracted = extractProfileFlags(["--log-file", "--profile", "work", "hello"]);
		expect(extracted.profile).toBe("work");
		const parsed = parseArgs(extracted.argv);
		expect(parsed.logFile).toBe(true);
		expect(parsed.messages).toEqual(["hello"]);
		expect(parsed.unrecognizedFlags).toEqual([]);
		expect(parseArgs([]).logFile).toBeUndefined();
		expect(parseArgs(["--", "--log-file"]).logFile).toBeUndefined();
	});

	it.each(["default", "enabled", "explicit"])("honors %s transports in an isolated process", async scenario => {
		const root = mkdtempSync(join(tmpdir(), "omp-startup-log-"));
		try {
			const script = `
				import { setProfile, getLogsDir } from "@oh-my-pi/pi-utils/dirs";
				setProfile("work");
				const { logger } = await import("@oh-my-pi/pi-utils");
				const { parseArgs } = await import("@oh-my-pi/pi-coding-agent/cli/args");
				const { configureStartupLogging } = await import("@oh-my-pi/pi-coding-agent/cli/startup-logging");
				if (${JSON.stringify(scenario)} === "explicit") logger.setTransports({ file: ${JSON.stringify(join(root, "explicit"))}, console: false });
				logger.info("before-startup-flag");
				configureStartupLogging(parseArgs(${JSON.stringify(scenario === "enabled" ? ["--log-file"] : [])}));
				logger.info("startup-file-fixture");
				logger.setTransports({ file: false, console: false });
				process.stderr.write(getLogsDir());
			`;
			const child = Bun.spawn([process.execPath, "--eval", script], {
				cwd: resolve(import.meta.dir, "../../.."),
				env: {
					...process.env,
					PI_CONFIG_DIR: relative(homedir(), root),
					OMP_PROFILE: "",
					PI_PROFILE: "",
					XDG_STATE_HOME: "",
				},
				stdout: "pipe",
				stderr: "pipe",
			});
			const [code, stdout, stderr] = await Promise.all([
				child.exited,
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
			]);
			expect(code).toBe(0);
			expect(stdout).toBe("");
			expect(stderr).toBe(join(root, "profiles", "work", "logs"));
			const files = readdirSync(root, { recursive: true, withFileTypes: true }).filter(file => file.isFile());
			if (scenario === "default") {
				expect(files).toEqual([]);
			} else {
				const logs = files.filter(file => file.name.endsWith(".log"));
				expect(logs).toHaveLength(1);
				const log = logs[0]!;
				expect(log.parentPath).toBe(scenario === "enabled" ? stderr : join(root, "explicit"));
				const content = readFileSync(join(log.parentPath, log.name), "utf8");
				expect(content).toContain("startup-file-fixture");
				expect(content.includes("before-startup-flag")).toBe(scenario === "explicit");
			}
			expect(files.some(file => /config\.ya?ml$/.test(file.name))).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
