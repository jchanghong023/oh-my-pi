import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

// Repeated producer labels and retry labels may share a run directory, never
// the same report/metadata file. Observe the actual files the public helpers write.
test("repeated producer labels retain separate JUnit and metadata for every attempt", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-report-identity-"));
	try {
		const source = `
import {beginTestRun,recordTestProducer,testReportPath,writeCommandCase} from ${JSON.stringify(pathToFileURL(path.join(import.meta.dir, "test-reporting.ts")).href)};
await beginTestRun("isolated report identities");
const paths = [];
for (const attempt of [1, 2]) {
  const reportPath = testReportPath("same producer / retry");
  paths.push(reportPath);
  await writeCommandCase(reportPath,"fixture", "attempt-"+attempt,0.125,attempt===1?"failed":"passed");
  await recordTestProducer({producer:"same producer",command:["fixture-command"],scope:"fixture",attempt,startedAt:new Date().toISOString(),durationSeconds:0.125,exitCode:attempt===1?23:0,reportPath});
}
process.stdout.write(JSON.stringify(paths));
`;
		const child = Bun.spawn([process.execPath, "-e", source], {
			env: { ...process.env, OMP_TEST_REPORT_DIR: directory, OMP_TEST_RUN_ID: "fixture-report-identity" },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [exitCode, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
		const paths = JSON.parse(stdout) as string[];
		expect(paths).toHaveLength(2);
		expect(new Set(paths).size).toBe(2);
		const files = await fs.readdir(directory);
		const records = await Promise.all(
			files.filter(file => file.endsWith(".producer.json")).map(file => Bun.file(path.join(directory, file)).json()),
		);
		expect(records).toHaveLength(2);
		records.sort((a, b) => a.attempt - b.attempt);
		expect(
			records.map(record => ({
				attempt: record.attempt,
				exitCode: record.exitCode,
				status: record.status,
				report: record.report,
			})),
		).toEqual([
			{ attempt: 1, exitCode: 23, status: "failed", report: "available" },
			{ attempt: 2, exitCode: 0, status: "passed", report: "available" },
		]);
		expect(records.map(record => path.join(directory, record.reportPath))).toEqual(paths);
		const first = await fs.readFile(paths[0]!, "utf8");
		const second = await fs.readFile(paths[1]!, "utf8");
		expect(first).toContain('name="attempt-1"');
		expect(first).toContain("<failure ");
		expect(second).toContain('name="attempt-2"');
		expect(second).not.toContain("<failure ");
	} finally {
		await fs.rm(directory, { recursive: true, force: true });
	}
});
