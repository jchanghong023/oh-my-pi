import * as jsc from "bun:jsc";
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { collectMemoryStats } from "@oh-my-pi/pi-coding-agent/debug/profiler";
import { createReportBundle } from "@oh-my-pi/pi-coding-agent/debug/report-bundle";
import { isolateReportBundleDirs, type ReportBundleTestDirs } from "../helpers/report-bundle-isolation";

let dirs: ReportBundleTestDirs | undefined;

afterEach(async () => {
	vi.restoreAllMocks();
	if (dirs) {
		await dirs.cleanup();
		dirs = undefined;
	}
});

async function archiveMembers(archivePath: string): Promise<string[]> {
	const archive = new Bun.Archive(await Bun.file(archivePath).bytes());
	return [...(await archive.files()).keys()].sort();
}

describe("report bundle privacy", () => {
	it("exports numeric memory diagnostics without live credentials or runtime type names", async () => {
		dirs = await isolateReportBundleDirs();
		const credential = `sk-ant-ort01-${crypto.randomUUID()}`;
		const heap = jsc.heapStats();
		vi.spyOn(jsc, "heapStats").mockReturnValue({
			...heap,
			objectTypeCounts: { [credential]: 1 },
			protectedObjectTypeCounts: { [credential]: 1 },
		});

		const result = await createReportBundle({
			sessionFile: undefined,
			memoryStats: collectMemoryStats(),
			reportsDir: dirs.reportsDir,
			logsDir: dirs.logsDir,
		});
		const archive = new Bun.Archive(await Bun.file(result.path).bytes());
		const members = await archive.files();

		expect(members.has("heap.heapsnapshot")).toBe(false);
		const memory = members.get("memory.json");
		if (!memory) throw new Error("Memory report missing numeric diagnostics");
		const stats: { process: Record<string, unknown>; heap: Record<string, unknown> } = await memory.json();
		for (const section of [stats.process, stats.heap]) {
			for (const key in section) {
				const value = section[key];
				expect(typeof value).toBe("number");
				expect(Number.isFinite(value)).toBe(true);
			}
		}
		expect(stats.process.rss).toBeGreaterThan(0);
		expect(stats.heap.heapSize).toBeGreaterThan(0);
		for (const member of members.values()) {
			expect(await member.text()).not.toContain(credential);
		}
	});

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

		const result = await createReportBundle({
			sessionFile,
			reportsDir: dirs.reportsDir,
			logsDir: dirs.logsDir,
		});
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
