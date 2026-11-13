import { expect, it } from "bun:test";
import * as path from "node:path";
import { hasEmbeddedArchive } from "@oh-my-pi/pi-utils/embedded-archive";
import { renderOpenWikiLicenseSections } from "../src/cli/license";
import { openWikiPackageDirectory } from "../src/openwiki/resource-dependencies";

const repoRoot = path.resolve(import.meta.dir, "../../..");
const cliEntry = path.join(repoRoot, "packages/coding-agent/src/cli.ts");
const generatedArchive = path.join(repoRoot, "packages/coding-agent/src/openwiki/openwiki-resources.generated.txt");
const noticeOwners = ["coding-agent", "natives"];

it("prints OMP, OpenWiki and dependency licenses on the top-level flag", async () => {
	const env = { ...process.env };
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
	]);
	const dependencies = await Promise.all(dependencyLicenses);

	expect(exitCode).toBe(0);
	expect(stderr).toBe("");
	for (const section of [license, ...notices]) {
		expect(stdout).toContain(section.trimEnd());
	}
	expect(stdout).toContain(openWikiLicense.trimEnd());
	if (hasEmbeddedArchive(await Bun.file(generatedArchive).text())) {
		for (const dependencyLicense of dependencies) {
			expect(stdout).toContain(dependencyLicense.trimEnd());
		}
	} else {
		expect(stdout).toContain("OpenWiki browser notices are not generated");
	}
});

it("renders embedded license notices in a stable order", () => {
	const sections = renderOpenWikiLicenseSections(
		new Map([
			["licenses/openwiki.txt", "openwiki license"],
			["licenses/zod@1.0.0.txt", "zod notice\n"],
			["licenses/force-graph@1.0.0.txt", "force notice\n"],
		]),
	);
	expect(sections).toEqual(["OpenWiki License\n\nopenwiki license", "force notice\n\nzod notice"]);
});
