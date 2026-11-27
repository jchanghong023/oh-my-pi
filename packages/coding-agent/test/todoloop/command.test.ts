import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { executeAcpBuiltinSlashCommand } from "../../src/slash-commands/acp-builtins";
import { executeBuiltinSlashCommand } from "../../src/slash-commands/builtin-registry";
import type { TodoLoopRunOptions, TodoLoopState } from "../../src/todoloop/runner";
import { initTheme } from "../../src/ui/theme/service";
import { attachTerminal, createInteractiveModeContext, renderTranscript } from "../helpers/interactive-mode-context";

const dirs: string[] = [];
async function harness() {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-todoloop-command-"));
	dirs.push(cwd);
	const runTodoLoop = vi.fn<(options: Omit<TodoLoopRunOptions, "cwd">) => Promise<TodoLoopState>>(async options => ({
		phase: "completed",
		filePath: options.filePath,
		completed: 2,
		total: 2,
		completedGroups: 1,
		totalGroups: 1,
		attempt: 1,
	}));
	const ctx = createInteractiveModeContext({
		sessionManager: { getCwd: () => cwd },
		session: { sessionId: "todo-owner", sessionGeneration: 0, runTodoLoop },
		registerHostShutdown: () => () => {},
	});
	const execute = (args: string) =>
		executeBuiltinSlashCommand(`/todoloop${args ? ` ${args}` : ""}`, { ctx, draftDetached: true });
	return { cwd, ctx, execute, runTodoLoop };
}

beforeAll(() => {
	initTheme();
});
afterEach(async () => {
	for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

describe("native /todoloop command", () => {
	it("checks a grouped task file read-only in file order", async () => {
		const h = await harness();
		const relative = "plain tasks.md";
		const file = path.join(h.cwd, relative);
		const content = [
			"# Work",
			"## Finished",
			"- [X] 8 already done",
			"## Active",
			"- [ ] 2 next task",
			"### Details",
			"- [ ] 1 last task",
			"## Later",
			"- [ ] 9 final task",
			"",
		].join("\n");
		await Bun.write(file, content);
		expect(await h.execute(`"${relative}" --check`)).toBe(true);
		expect(h.runTodoLoop).not.toHaveBeenCalled();
		expect(await Bun.file(file).text()).toBe(content);
		const rendered = renderTranscript(h.ctx).join("\n");
		expect(rendered).toContain("1/4");
		expect(rendered).toContain("1/3");
		for (const text of ["Finished", "Active", "Later", "[x] 8", "[ ] 2", "[ ] 1", "[ ] 9"])
			expect(rendered).toContain(text);
		expect(rendered.indexOf("Finished")).toBeLessThan(rendered.indexOf("Active"));
		expect(rendered.indexOf("Active")).toBeLessThan(rendered.indexOf("Later"));
		expect(rendered.indexOf("[x] 8")).toBeLessThan(rendered.indexOf("[ ] 2"));
		expect(rendered.indexOf("[ ] 2")).toBeLessThan(rendered.indexOf("[ ] 1"));
		expect(rendered.indexOf("[ ] 1")).toBeLessThan(rendered.indexOf("[ ] 9"));
		const first = rendered.split("\n").at(-1)!;
		expect(first).toMatch(/group.*2/i);
		expect(first).toMatch(/task.*2/i);
		expect(h.ctx.hud.widgets.above()).toHaveLength(0);
	});

	it("reports no remaining group or task when every group is checked", async () => {
		const h = await harness();
		const file = path.join(h.cwd, "complete.md");
		const content = "## First\n- [x] 1 done\n## Second\n- [X] 2 also done\n";
		await Bun.write(file, content);
		await h.execute("complete.md --check");
		expect(h.runTodoLoop).not.toHaveBeenCalled();
		expect(await Bun.file(file).text()).toBe(content);
		const rendered = renderTranscript(h.ctx).join("\n");
		expect(rendered).toContain("2/2 tasks");
		expect(rendered).toContain("2/2 groups");
		expect(rendered.split("\n").at(-1)).toMatch(/group.*none.*task.*none/i);
	});

	it.each(["", "todo.md --unknown", "--unknown", '""'])("rejects invalid arguments: %s", async args => {
		const h = await harness();
		await h.execute(args);
		expect(h.ctx.showError).toHaveBeenCalledWith("Usage: /todoloop <path> [--check]");
		expect(h.runTodoLoop).not.toHaveBeenCalled();
		expect(await fs.readdir(h.cwd)).toEqual([]);
	});

	it.each([undefined, "- [~] invalid state\n"])(
		"shows real read or parser errors without executing",
		async content => {
			const h = await harness();
			if (content !== undefined) await Bun.write(path.join(h.cwd, "bad.md"), content);
			await h.execute("bad.md --check");
			const rendered = renderTranscript(h.ctx).join("\n");
			expect(rendered).toContain("file_error");
			expect(h.runTodoLoop).not.toHaveBeenCalled();
			if (content !== undefined) expect(await Bun.file(path.join(h.cwd, "bad.md")).text()).toBe(content);
		},
	);

	it("delegates absolute paths and releases submission while execution remains live", async () => {
		const h = await harness();
		const finished = Promise.withResolvers<TodoLoopState>();
		h.runTodoLoop.mockImplementation(() => finished.promise);
		h.ctx.composer.setText("new draft");
		const filePath = path.join(h.cwd, "tasks with spaces.md");
		await h.execute(`"${filePath}"`);
		expect(h.runTodoLoop.mock.calls[0]![0].filePath).toBe(filePath);
		expect(h.ctx.composer.text()).toBe("new draft");
		await h.execute(`"${filePath}"`);
		expect(h.runTodoLoop).toHaveBeenCalledTimes(1);
		const options = h.runTodoLoop.mock.calls[0]![0];
		const term = attachTerminal(h.ctx);
		try {
			expect(term.screen().join("\n")).toContain("TodoLoop");
		} finally {
			term.dispose();
		}
		Object.defineProperty(h.ctx.session, "sessionGeneration", { value: 1, configurable: true });
		options.onState?.({
			phase: "running",
			filePath,
			completed: 0,
			total: 9,
			completedGroups: 0,
			totalGroups: 3,
			attempt: 2,
		});
		expect(h.ctx.hud.widgets.above()).toHaveLength(0);
		finished.resolve({
			phase: "stopped",
			filePath,
			completed: 0,
			total: 1,
			completedGroups: 0,
			totalGroups: 1,
			attempt: 1,
		});
		await finished.promise;
	});

	it("host shutdown requests abort and waits for actual completion", async () => {
		const h = await harness();
		const finished = Promise.withResolvers<TodoLoopState>();
		h.runTodoLoop.mockImplementation(() => finished.promise);
		let shutdown: (() => Promise<void>) | undefined;
		const unregister = vi.fn();
		h.ctx.registerHostShutdown = callback => {
			shutdown = callback;
			return unregister;
		};
		const abortEval = vi.fn(async () => {});
		h.ctx.session.abortEval = abortEval;
		await h.execute("tasks.md");
		const options = h.runTodoLoop.mock.calls[0]![0];
		let settled = false;
		const stopping = shutdown!().then(() => {
			settled = true;
		});
		await Promise.resolve();
		expect(options.signal?.aborted).toBe(true);
		expect(abortEval).toHaveBeenCalledTimes(1);
		expect(settled).toBe(false);
		finished.resolve({
			phase: "stopped",
			filePath: options.filePath,
			completed: 0,
			total: 1,
			completedGroups: 0,
			totalGroups: 1,
			attempt: 1,
		});
		await stopping;
		expect(unregister).toHaveBeenCalledTimes(1);
	});

	it("rejects /todoloop in ACP", async () => {
		const { session, sessionManager, settings, showError } = createInteractiveModeContext();
		const result = await executeAcpBuiltinSlashCommand("/todoloop a.md --check", {
			session,
			sessionManager,
			settings,
			cwd: sessionManager.getCwd(),
			output: showError,
			refreshCommands: () => {},
			reloadPlugins: async () => {},
		});
		expect(result).toEqual({ consumed: true, failed: true });
	});
});
