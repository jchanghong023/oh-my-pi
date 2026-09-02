import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createReportBundle } from "@oh-my-pi/pi-coding-agent/debug/report-bundle";
import { isolateReportBundleDirs, type ReportBundleTestDirs } from "../helpers/report-bundle-isolation";

let dirs: ReportBundleTestDirs | undefined;

afterEach(async () => {
	if (dirs) {
		await dirs.cleanup();
		dirs = undefined;
	}
});

describe("report bundle logs", () => {
	it("collects every same-day PID log, not only the current process", async () => {
		dirs = await isolateReportBundleDirs();

		const today = new Date().toISOString().slice(0, 10);
		const crashedName = `omp.${today}.4242.log`;
		const rotatedName = `${crashedName}.1`;
		const currentName = `omp.${today}.${process.pid}.log`;
		await Bun.write(path.join(dirs.logsDir, crashedName), '{"pid":4242,"message":"fatal in crashed pid"}\n');
		await fs.utimes(path.join(dirs.logsDir, crashedName), 1, 1);
		await Bun.write(path.join(dirs.logsDir, rotatedName), '{"pid":4242,"message":"earlier rotated crash output"}\n');
		await fs.utimes(path.join(dirs.logsDir, rotatedName), 0, 0);
		await Bun.write(path.join(dirs.logsDir, currentName), '{"pid":0,"message":"later invocation"}\n');
		await fs.utimes(path.join(dirs.logsDir, currentName), 2, 2);

		const result = await createReportBundle({
			sessionFile: undefined,
			reportsDir: dirs.reportsDir,
			logsDir: dirs.logsDir,
		});

		expect(result.files).toContain("logs.txt");
		expect(result.path.startsWith(dirs.reportsDir)).toBe(true);
		const archive = new Bun.Archive(await Bun.file(result.path).bytes());
		const files = await archive.files();
		const logsText = (await files.get("logs.txt")?.text()) ?? "";
		expect(logsText).toContain(crashedName);
		expect(logsText).toContain("fatal in crashed pid");
		expect(logsText).toContain(rotatedName);
		expect(logsText).toContain("earlier rotated crash output");
		expect(logsText).toContain(currentName);
		expect(logsText).toContain("later invocation");
		expect(logsText.indexOf(crashedName)).toBeLessThan(logsText.indexOf(currentName));

		await fs.rm(result.path, { force: true });
	});
});
