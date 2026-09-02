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

async function archiveMembers(archivePath: string): Promise<string[]> {
	const archive = new Bun.Archive(await Bun.file(archivePath).bytes());
	return [...(await archive.files()).keys()].sort();
}

describe("report bundle sessions", () => {
	it("bundles only the current session's subtree, not unrelated co-located sessions", async () => {
		dirs = await isolateReportBundleDirs();

		const sessionsDir = path.join(dirs.rootDir, "sessions");
		await fs.mkdir(sessionsDir, { recursive: true });

		// Current session and its artifacts subtree: a genuine subagent transcript
		// plus a nested sub-subagent transcript one level deeper.
		const sessionFile = path.join(sessionsDir, "2026-08-15T00-00-00_CURRENT.jsonl");
		await Bun.write(sessionFile, '{"type":"session","id":"CURRENT"}\n');
		const artifactsDir = sessionFile.slice(0, -6);
		await fs.mkdir(path.join(artifactsDir, "SubTask"), { recursive: true });
		await Bun.write(path.join(artifactsDir, "SubTask.jsonl"), '{"type":"session","id":"SubTask"}\n');
		await Bun.write(path.join(artifactsDir, "SubTask", "NestedTask.jsonl"), '{"type":"session","id":"NestedTask"}\n');

		// Unrelated top-level sessions co-located in the sessions root.
		await Bun.write(
			path.join(sessionsDir, "2026-08-10T00-00-00_OTHERA.jsonl"),
			'{"type":"session","secret":"private-a"}\n',
		);
		await Bun.write(
			path.join(sessionsDir, "2026-08-12T00-00-00_OTHERB.jsonl"),
			'{"type":"session","secret":"private-b"}\n',
		);

		const result = await createReportBundle({ sessionFile, reportsDir: dirs.reportsDir, logsDir: dirs.logsDir });
		const members = await archiveMembers(result.path);
		await fs.rm(result.path, { force: true });

		expect(result.path.startsWith(dirs.reportsDir)).toBe(true);

		// Genuine subtree is captured recursively.
		expect(members).toContain("artifacts/SubTask.jsonl");
		expect(members).toContain("artifacts/SubTask/NestedTask.jsonl");
		// Unrelated sessions never appear anywhere in the archive.
		expect(members.some(name => name.includes("OTHERA") || name.includes("OTHERB"))).toBe(false);
	});
});
