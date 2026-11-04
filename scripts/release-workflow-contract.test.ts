import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { YAML } from "bun";

const root = path.resolve(import.meta.dir, "..");
async function workflow() {
	return YAML.parse(await fs.readFile(path.join(root, ".github/workflows/ci.yml"), "utf8"));
}

// The requirement explicitly names the workflow definition as its observable
// boundary. These are configuration contracts, not simulated GitHub execution.
describe("fork release workflow definition contract", () => {
	it("allows only manual dispatch and serializes each ref without cancellation", async () => {
		const value = await workflow();
		expect(Object.keys(value.on)).toEqual(["workflow_dispatch"]);
		expect(value.on.workflow_dispatch.inputs.publish_release).toMatchObject({ type: "boolean", default: false });
		expect(value.concurrency).toMatchObject({
			group: "${{ github.workflow }}-${{ github.ref }}",
			"cancel-in-progress": false,
		});
		const enabled = (await fs.readdir(path.join(root, ".github/workflows"))).filter(name => /\.ya?ml$/.test(name));
		expect(enabled).toEqual(["ci.yml"]);
	});

	it("grants write access only to the explicitly authorized main release job", async () => {
		const value = await workflow();
		expect(value.permissions).toEqual({ contents: "read" });
		const writers = Object.entries(value.jobs).filter(
			([, job]) => (job as { permissions?: { contents?: string } }).permissions?.contents === "write",
		);
		expect(writers.map(([name]) => name)).toEqual(["release_github"]);
		expect(value.jobs.release_github.if).toContain("inputs.publish_release");
		expect(value.jobs.release_github.if).toContain("refs/heads/main");
		expect(value.jobs.release_github.needs).toEqual(["release_metadata", "release_binary", "browser_relay"]);
		for (const prerequisite of value.jobs.release_github.needs)
			expect(value.jobs.release_github.if).toContain(`needs.${prerequisite}.result == 'success'`);
	});

	it("keeps the two supported binary artifacts and browser extension as the complete upload set", async () => {
		const value = await workflow();
		expect(
			value.jobs.release_binary.strategy.matrix.include.map((entry: { target_id: string }) => entry.target_id),
		).toEqual(["linux-x64", "win32-x64"]);
		const publish = value.jobs.release_github.steps.find((step: { with?: { files?: string } }) => step.with?.files);
		expect(publish.with.files.trim().split(/\r?\n/)).toEqual([
			"packages/coding-agent/binaries/omp-linux-x64",
			"packages/coding-agent/binaries/omp-windows-x64.exe",
			"packages/browser-relay/dist/omp-browser-relay-extension.zip",
		]);
		expect(publish.with.generate_release_notes).toBe(true);
		expect(Object.keys(value.jobs).some(name => /(?:^|_)tests?(?:_|$)|npm|homebrew|nix/.test(name))).toBe(false);
	});
});
