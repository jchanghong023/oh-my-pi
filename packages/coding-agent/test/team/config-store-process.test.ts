import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { TempDir } from "@oh-my-pi/pi-utils";
import { parseDocument } from "yaml";
import { UserSettingsStore } from "../../src/config/user-settings";

// Both real processes carry the same leaf version. Neither process may report
// success after silently discarding the other's committed update.
test("two profile settings processes serialize Team saves and return one precise revision conflict", async () => {
	await using root = await TempDir.create("omp-team-process-cas-");
	const agentDir = root.join("profiles", "work", "agent");
	await fs.mkdir(agentDir, { recursive: true });
	const file = path.join(agentDir, "config.yml");
	await fs.writeFile(file, "# user note\nother: preserve\nteam:\n  members: [provider/original]\n");
	const keys = ["team", "members"];
	const store = new UserSettingsStore({ agentDir });
	const initial = await store.read(keys);
	if (!initial.revision) throw new Error("Expected an initial writable Team version");
	const moduleUrl = pathToFileURL(path.resolve(import.meta.dir, "../../src/config/user-settings.ts")).href;
	const outcomes: Array<{ state: string; code?: string; write?: unknown; members?: string[] }> = [];
	const ready = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
	const children = ["one", "two"].map((name, index) => {
		const members = [`provider/${name}`];
		const code = `
import { UserSettingsStore } from ${JSON.stringify(moduleUrl)};
const store = new UserSettingsStore({ agentDir: ${JSON.stringify(agentDir)} });
process.on("message", async message => {
  if (message !== "save") return;
  try {
    const receipt = await store.save([{segments: ["team", "members"], value: ${JSON.stringify(members)}}], ${JSON.stringify(initial.revision)});
    process.send({ state: "saved", members: ${JSON.stringify(members)}, write: receipt.write });
  } catch (error) {
    process.send({ state: "rejected", code: error.code, write: error.data?.write });
  }
  process.exit(0);
});
process.send({ state: "ready" });
`;
		return Bun.spawn([process.execPath, "--eval", code], {
			cwd: process.cwd(),
			stdout: "ignore",
			stderr: "pipe",
			ipc(message) {
				const event = message as (typeof outcomes)[number];
				if (event.state === "ready") ready[index]!.resolve();
				else outcomes.push(event);
			},
		});
	});
	const diagnostics = children.map(child => new Response(child.stderr).text());
	try {
		await Promise.all(
			children.map((child, index) =>
				Promise.race([
					ready[index]!.promise,
					child.exited.then(code => {
						throw new Error(`Team settings worker exited before ready: ${code}`);
					}),
				]),
			),
		);
		for (const child of children) child.send("save");
		expect(await Promise.all(children.map(child => child.exited))).toEqual([0, 0]);
		expect(await Promise.all(diagnostics)).toEqual(["", ""]);
		expect(outcomes.filter(outcome => outcome.state === "saved")).toHaveLength(1);
		expect(outcomes.filter(outcome => outcome.state === "rejected")).toEqual([
			{ state: "rejected", code: "revision_conflict", write: { status: "not_attempted" } },
		]);
		const winner = outcomes.find(outcome => outcome.state === "saved")!;
		expect(winner.write).toEqual({ status: "saved" });
		expect((await store.read(keys)).value).toEqual(winner.members);
		expect(parseDocument(await fs.readFile(file, "utf8")).toJS().other).toBe("preserve");
		expect(await fs.readFile(file, "utf8")).toContain("# user note");
	} finally {
		for (const child of children) if (child.exitCode === null) child.kill();
		await Promise.allSettled(children.map(child => child.exited));
		await Promise.all(diagnostics);
	}
}, 30_000);
