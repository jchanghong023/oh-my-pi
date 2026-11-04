import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { buildDeveloperTestAgentResources } from "../scripts/developer-test-agent-resources";

const directories: string[] = [];
const fixture = path.join(import.meta.dir, "fixtures", "developer-test-agent-materialization.ts");
const preload = path.join(import.meta.dir, "fixtures", "developer-test-agent-materialization-preload.ts");
const sourceRoot = path.resolve(import.meta.dir, "../src/extensibility/plugins/bundled/developer-test-agent");
type Entry = [string, { data: string; mode: number } | null];

const file = (name: string, text: string): Entry => [name, { data: Buffer.from(text).toString("base64"), mode: 0o644 }];

afterEach(async () => {
	for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true });
});

async function probe(scenario: string, archive?: Buffer): Promise<void> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-dta-materialization-"));
	directories.push(root);
	const project = path.join(root, "unrelated-project");
	await fs.mkdir(project);
	if (archive) await fs.writeFile(path.join(root, "resources.json.gz"), archive);
	const child = Bun.spawn([process.execPath, "--preload", preload, fixture, scenario, root, sourceRoot], {
		cwd: project,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	try {
		const [exitCode, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
		expect(JSON.parse(stdout)).toEqual({ scenario, assertionsCompleted: true });
	} finally {
		if (child.exitCode === null) {
			child.kill();
			await child.exited;
		}
	}
}

describe("Developer Test Agent archive materialization", () => {
	// Only build-time metadata is injected, with a temporary preload in an isolated child process.
	it("materializes the complete resource tree and serves commands and skill resources outside project cwd", async () => {
		const entries = JSON.parse(gunzipSync(await buildDeveloperTestAgentResources()).toString("utf8")) as Entry[];
		entries.push(["materialization-fixture", null], ["materialization-fixture/empty", null]);
		entries.push(["materialization-fixture/binary", { data: "AAECAID/", mode: 0o640 }]);
		await probe("consumers", gzipSync(JSON.stringify(entries)));
	});

	it("publishes concurrent requests atomically, reuses the cache and isolates profiles", async () => {
		await probe("cache", await buildDeveloperTestAgentResources());
	});

	it("rejects traversal, absolute, Windows and empty path components without publishing or leaking staging files", async () => {
		await probe("invalid-paths");
	});

	it("removes partially written resources after a real file-directory collision", async () => {
		await probe(
			"write-failure",
			gzipSync(JSON.stringify([file("occupied", "first"), file("occupied/child", "second")])),
		);
	});

	it("does not publish or create staging files for corrupt gzip or malformed JSON", async () => {
		await probe("corrupt");
	});

	it("reports a missing archive without creating a profile cache", async () => {
		await probe("missing");
	});
});
