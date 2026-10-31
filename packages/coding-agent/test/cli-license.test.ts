import { expect, it } from "bun:test";
import * as path from "node:path";
import { openWikiPackageDirectory } from "../src/openwiki/resource-dependencies";

const repoRoot = path.resolve(import.meta.dir, "../../..");
const cliEntry = path.join(repoRoot, "packages/coding-agent/src/cli.ts");
const noticeOwners = ["coding-agent", "natives"];

it("prints OMP, OpenWiki and dependency licenses on the top-level flag", async () => {
	const env = { ...process.env };
	delete env.PI_OPENWIKI_VISUAL_ASSETS;
	delete env.PI_COMPILED;
	delete env.PI_BUNDLED;
	const proc = Bun.spawn([process.execPath, cliEntry, "--license"], {
		cwd: repoRoot,
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	const dependencyLicenses = ["force-graph", "mermaid"].map(name =>
		Bun.file(
			path.join(openWikiPackageDirectory(name, path.join(repoRoot, "packages/coding-agent")), "LICENSE"),
		).text(),
	);
	const [exitCode, stdout, stderr, license, openWikiLicense, ...notices] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		Bun.file(path.join(repoRoot, "packages/coding-agent/LICENSE")).text(),
		Bun.file(path.join(repoRoot, "vendor/openwiki/LICENSE")).text(),
		...noticeOwners.map(dir => Bun.file(path.join(repoRoot, "packages", dir, "THIRD-PARTY-NOTICES.txt")).text()),
		...dependencyLicenses,
	]);

	expect(exitCode).toBe(0);
	expect(stderr).toBe("");
	for (const section of [license, openWikiLicense, ...notices]) {
		expect(stdout).toContain(section.trimEnd());
	}
});
