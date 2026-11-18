import { expect, it } from "bun:test";
import * as path from "node:path";
import { renderOpenWikiLicenseSections } from "../src/cli/license";
import { openWikiPackageDirectory } from "../src/openwiki/resource-dependencies";
import { openWikiResourceFingerprint } from "../src/openwiki/resource-fingerprint";
import { loadOpenWikiArchive } from "../src/openwiki/visual-assets";

const repoRoot = path.resolve(import.meta.dir, "../../..");
const packageDir = path.join(repoRoot, "packages/coding-agent");
const cliEntry = path.join(packageDir, "src/cli.ts");
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
	const [exitCode, stdout, stderr, license, ...notices] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		Bun.file(path.join(packageDir, "LICENSE")).text(),
		...noticeOwners.map(dir => Bun.file(path.join(repoRoot, "packages", dir, "THIRD-PARTY-NOTICES.txt")).text()),
	]);

	expect(exitCode).toBe(0);
	expect(stderr).toBe("");
	for (const section of [license, ...notices]) {
		expect(stdout).toContain(section.trimEnd());
	}
	const vendorLicense = Bun.file(path.join(repoRoot, "vendor/openwiki/LICENSE"));
	if (!(await vendorLicense.exists())) {
		expect(stdout).toContain(
			"OpenWiki resources are unavailable. Initialize the OpenWiki submodule and run bun run gen:openwiki-resources.",
		);
		return;
	}
	expect(stdout).toContain((await vendorLicense.text()).trimEnd());

	const archive = await loadOpenWikiArchive().catch(() => undefined);
	if (!archive) {
		expect(stdout).toContain("OpenWiki browser notices are not generated");
		return;
	}
	if (archive.sourceFingerprint !== openWikiResourceFingerprint(repoRoot)) {
		expect(stdout).toContain("OpenWiki browser notices are stale");
		return;
	}
	expect(stdout).not.toContain("OpenWiki browser notices are not generated");
	expect(stdout).not.toContain("OpenWiki browser notices are stale");
	const dependencies = await Promise.all(
		["force-graph", "mermaid"].map(name =>
			Bun.file(path.join(openWikiPackageDirectory(name, packageDir), "LICENSE")).text(),
		),
	);
	for (const dependencyLicense of dependencies) {
		expect(stdout).toContain(dependencyLicense.trimEnd());
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
