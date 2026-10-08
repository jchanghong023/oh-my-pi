import { afterEach, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { JCH_GIT_SLASH_COMMANDS } from "../../src/jch-commands/git";
import { RepoLifecycle } from "../../src/repo/lifecycle";
import { RepoService } from "../../src/repo/service";
import type { SlashCommandRuntime } from "../../src/slash-commands/types";

const directories: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true });
});

test("reconciling during a JCH pull cannot leave stale repository content reported as checked after Git settles", async () => {
	const command = JCH_GIT_SLASH_COMMANDS.find(candidate => candidate.name === "jchgitpull");
	if (!command?.handle) throw new Error("Missing /jchgitpull handler");
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-jch-settlement-"));
	directories.push(directory);
	const cwd = path.join(directory, "project");
	const agentDir = path.join(directory, "agent");
	await fs.mkdir(cwd);
	const file = path.join(cwd, "engine.py");
	await Bun.write(file, "def before_pull(): return 'OLDONLYTOKEN'\n");
	const service = new RepoService({ cwd, agentDir });
	const lifecycle = new RepoLifecycle({ agentDir, getCwd: () => cwd });
	const started = Promise.withResolvers<void>();
	const exited = Promise.withResolvers<number>();
	let pending: Promise<unknown> | undefined;
	try {
		await service.build();
		vi.spyOn(Bun, "spawn").mockImplementation((() => {
			started.resolve();
			return {
				stdout: new ReadableStream<Uint8Array>({ start: controller => controller.close() }),
				stderr: new ReadableStream<Uint8Array>({ start: controller => controller.close() }),
				exited: exited.promise,
			} as never;
		}) as typeof Bun.spawn);
		const runtime = {
			cwd,
			session: { notifyRepoCommandExecuted: (kind: "git", root: string) => lifecycle.commandExecuted(kind, root) },
			output: () => {},
		} as unknown as SlashCommandRuntime;
		pending = Promise.resolve(command.handle({ name: command.name, args: "", text: "/jchgitpull" }, runtime));
		await started.promise;
		expect((await service.status()).unchecked).toBe(true);
		await service.reconcile();
		expect((await service.status()).unchecked).toBe(false);
		// The final Git writes happen after the user reconciled the old content.
		await Bun.write(file, "def after_pull(): return 'NEWONLYTOKEN'\n");
		exited.resolve(0);
		await pending;
		expect((await service.search("OLDONLYTOKEN")).coverage.unchecked).toBe(true);
		await service.reconcile();
		const updated = await service.search("NEWONLYTOKEN");
		expect(updated.coverage.unchecked).toBe(false);
		expect(updated.hits.map(hit => hit.path)).toEqual(["engine.py"]);
		expect((await service.search("OLDONLYTOKEN")).hits).toEqual([]);
	} finally {
		exited.resolve(0);
		await pending;
		lifecycle.dispose();
		service.close();
	}
});
