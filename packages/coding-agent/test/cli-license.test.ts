import { expect, it } from "bun:test";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "../../..");
const packageDir = path.join(repoRoot, "packages/coding-agent");
const cliEntry = path.join(packageDir, "src/cli.ts");
const noticeOwners = ["coding-agent", "natives"];

it("prints the OMP license and third-party notices on the top-level flag", async () => {
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
});
