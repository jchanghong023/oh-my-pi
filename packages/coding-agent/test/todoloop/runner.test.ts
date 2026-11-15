import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { TempDir } from "@oh-my-pi/pi-utils";
import { AsyncJobManager } from "../../src/async/job-manager";
import { Settings } from "../../src/config/settings";
import * as handles from "../../src/eval/handle-bridge";
import { AgentRegistry } from "../../src/registry/agent-registry";
import { AgentLifecycleManager } from "../../src/registry/agent-lifecycle";
import * as discovery from "../../src/task/discovery";
import * as executor from "../../src/task/executor";
import type { ExecutorOptions } from "../../src/task/executor";
import type { SingleResult } from "@oh-my-pi/pi-tui/tools/task";
import type { ToolSession } from "../../src/tools";
import { TodoLoopNative } from "../../src/todoloop/native";
import { readTodoLoop } from "../../src/todoloop/parser";
import { runTodoLoop, type TodoLoopAttemptEvent, type TodoLoopState } from "../../src/todoloop/runner";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "../../src/config/model-registry";
import { AgentSession } from "../../src/session/agent-session";
import { AuthStorage } from "../../src/session/auth-storage";
import { SessionManager } from "../../src/session/session-manager";
import { convertToLlm } from "../../src/session/messages";

interface TaskPackage {
	cwd: string;
	filePath: string;
	group: { id: string; title: string; tasks: { id: string; label: string; raw: string }[] };
	completedTaskIds: string[];
	attempt: number;
	previous?: { text?: string; error?: string; observation: string };
	materials?: { proposal: string; design?: string; deltaSpecs: string[] };
}

/** Local scripted executor consumes the public task package and actual files; no model/credentials. */
function taskPackage(options: ExecutorOptions): TaskPackage {
	const json = options.assignment?.match(/```json\s*([\s\S]*?)```/)?.[1];
	if (!json) throw new Error("Missing task package");
	return JSON.parse(json) as TaskPackage;
}

function result(options: ExecutorOptions, overrides: Partial<SingleResult> = {}): SingleResult {
	return {
		index: options.index,
		id: options.id,
		agent: options.agent.name,
		agentSource: options.agent.source,
		task: options.task,
		assignment: options.assignment,
		description: options.description,
		exitCode: 0,
		output: "done",
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 0,
		requests: 0,
		...overrides,
	};
}

async function check(pkg: TaskPackage, ids = pkg.group.tasks.map(task => task.id)): Promise<void> {
	const content = await Bun.file(pkg.filePath).text();
	const snapshot = await readTodoLoop(pkg.filePath);
	const group = snapshot.groups.find(group => group.id === pkg.group.id);
	const lines = content.split("\n");
	for (const id of ids) {
		const packaged = pkg.group.tasks.find(task => task.id === id);
		const current = group?.tasks.find(task => task.id === id);
		if (!packaged || !current) throw new Error(`Task ${id} absent from assigned group`);
		if (current.done) continue;
		const original = lines
			.slice(current.line - 1, current.line - 1 + packaged.raw.split("\n").length)
			.join("\n")
			.replace(/\r$/, "");
		if (original !== packaged.raw) throw new Error(`Original checkbox changed for ${id}`);
		lines[current.line - 1] = lines[current.line - 1]!.replace("[ ]", "[x]");
	}
	await Bun.write(pkg.filePath, lines.join("\n"));
}

const managers: AsyncJobManager[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const manager of managers.splice(0)) await manager.dispose();
	AgentRegistry.resetGlobalForTests();
});

function harness(cwd: string, filePath = path.join(cwd, "todo.md"), realScout = false) {
	const deliveries: string[] = [];
	const manager = new AsyncJobManager({
		onJobComplete: (_id, text) => {
			deliveries.push(text);
		},
	});
	manager.registerDeliverySink("Main", (_id, text) => {
		deliveries.push(text);
	});
	managers.push(manager);
	const session: ToolSession = {
		cwd,
		hasUI: false,
		settings: Settings.isolated({ "async.enabled": false, "task.isolation.enabled": false }),
		asyncJobManager: manager,
		taskDepth: 0,
		getSessionFile: () => null,
		getArtifactsDir: () => null,
		getSessionSpawns: () => "*",
		getSessionId: () => crypto.randomUUID(),
		getActiveModelString: () => "p/local",
		getModelString: () => "p/local",
	};
	vi.spyOn(discovery, "discoverAgents").mockResolvedValue({
		agents: [
			{
				name: "task",
				description: "Task",
				systemPrompt: "Execute assigned task",
				source: "bundled",
				spawns: "*",
			},
			{
				name: "scout",
				description: "Scout",
				systemPrompt: "Inspect shared background",
				source: "bundled",
				spawns: "*",
			},
		],
		projectAgentsDir: null,
	});
	const states: TodoLoopState[] = [];
	const events: TodoLoopAttemptEvent[] = [];
	const native = new TodoLoopNative(session);
	const scoutJobs = new Set<string>();
	if (!realScout) {
		const start = native.start.bind(native);
		vi.spyOn(native, "start").mockImplementation(async (prompt, label, signal, options) => {
			if (options?.agent !== "scout") return start(prompt, label, signal, options);
			const id = manager.register("task", label, async () => "Shared background prepared", {
				ownerId: "Main",
				suppressDelivery: true,
			});
			scoutJobs.add(id);
			await manager.getJob(id)!.promise;
			return id;
		});
	}
	return {
		manager,
		session,
		native,
		scoutJobs,
		deliveries,
		states,
		events,
		run: (signal?: AbortSignal) =>
			runTodoLoop(
				{ cwd, filePath, signal, onState: state => states.push(state), onAttempt: event => events.push(event) },
				native,
			),
	};
}

describe("TodoLoop native eval file consumers", () => {
	it("executes scoped Superpowers Steps through native dispatch without repeating partial work", async () => {
		await using temp = await TempDir.create("@todoloop-superpowers-");
		const original = [
			"# Implementation Plan",
			"## Chunk 1",
			"### Task 1: Build",
			"- [X] **Step 0: Existing preparation**",
			"#### Execution details",
			"- [ ] **Step 1: Append `first-input.txt` to `first-output.txt`**",
			"  Preserve the prefix and `bold` source format.",
			"- [ ] **Step 2: Append `second-input.txt` to `first-output.txt`**",
			"## Chunk 2",
			"### Task 2: Publish",
			"- [ ] **Step 1: Append `first-output.txt` to `published.txt`**",
			"",
		].join("\r\n");
		await Bun.write(temp.join("todo.md"), original);
		await Bun.write(temp.join("first-input.txt"), "alpha");
		await Bun.write(temp.join("second-input.txt"), "|beta");
		await Bun.write(temp.join("first-output.txt"), "retained:");
		await Bun.write(temp.join("published.txt"), "published:");
		const h = harness(temp.path());
		const packages: TaskPackage[] = [];
		const effects: string[] = [];
		vi.spyOn(executor, "runSubprocess").mockImplementation(async options => {
			const pkg = taskPackage(options);
			packages.push(pkg);
			const selected = pkg.group.id === "1" && pkg.attempt === 1 ? pkg.group.tasks.slice(0, 1) : pkg.group.tasks;
			for (const task of selected) {
				const document = await readTodoLoop(pkg.filePath);
				const actual = document.groups
					.find(group => group.id === pkg.group.id)
					?.tasks.find(candidate => candidate.id === task.id);
				if (!actual || actual.done) throw new Error("Executor selected completed or foreign work");
				const instruction = /Append `([^`]+)` to `([^`]+)`/.exec(task.raw);
				if (!instruction) throw new Error("Missing file operation in original task");
				const input = await Bun.file(path.join(pkg.cwd, instruction[1]!)).text();
				const outputPath = path.join(pkg.cwd, instruction[2]!);
				await Bun.write(outputPath, (await Bun.file(outputPath).text()) + input);
				effects.push(task.id);
				await check(pkg, [task.id]);
				expect((await readTodoLoop(pkg.filePath)).tasks.find(candidate => candidate.id === task.id)?.done).toBe(
					true,
				);
			}
			return result(options, { output: pkg.attempt === 1 && pkg.group.id === "1" ? "partial retained" : "done" });
		});
		expect(await h.run()).toMatchObject({ phase: "completed", completed: 4, completedGroups: 2, totalGroups: 2 });
		expect(packages.map(pkg => [pkg.group.id, pkg.attempt, pkg.group.tasks.map(task => task.id)])).toEqual([
			["1", 1, ["step:1:1", "step:1:2"]],
			["1", 2, ["step:1:2"]],
			["2", 1, ["step:2:1"]],
		]);
		expect(packages[1]?.completedTaskIds).toEqual(["step:1:0", "step:1:1"]);
		expect(packages[1]?.previous).toMatchObject({
			text: "partial retained",
			observation: "Group 1 still has unchecked tasks Step 2 after attempt 1.",
		});
		expect(packages[2]?.previous).toBeUndefined();
		expect(effects).toEqual(["step:1:1", "step:1:2", "step:2:1"]);
		expect(await Bun.file(temp.join("first-output.txt")).text()).toBe("retained:alpha|beta");
		expect(await Bun.file(temp.join("published.txt")).text()).toBe("published:retained:alpha|beta");
		expect(await Bun.file(temp.join("todo.md")).text()).toBe(original.replaceAll("[ ]", "[x]"));
		expect(new Set(h.events.filter(event => event.type === "start" && event.group).map(event => event.id)).size).toBe(
			3,
		);
	});

	it("rejects changing another group's repeated Step 1 through native dispatch", async () => {
		await using temp = await TempDir.create("@todoloop-superpowers-scope-");
		const original = "### Task 1: First\n- [ ] **Step 1: Work**\n### Task 2: Second\n- [ ] **Step 1: Work**\n";
		await Bun.write(temp.join("todo.md"), original);
		const h = harness(temp.path());
		const run = vi.spyOn(executor, "runSubprocess").mockImplementation(async options => {
			const pkg = taskPackage(options);
			expect(pkg.group.tasks.map(task => task.id)).toEqual(["step:1:1"]);
			const offset = original.lastIndexOf("- [ ]");
			await Bun.write(pkg.filePath, original.slice(0, offset) + original.slice(offset).replace("[ ]", "[x]"));
			return result(options);
		});
		expect((await h.run()).phase).toBe("file_error");
		expect(run).toHaveBeenCalledTimes(1);
		expect((await readTodoLoop(temp.join("todo.md"))).tasks.map(task => task.done)).toEqual([false, true]);
	});

	it("executes two tasks in one agent then settles before starting the next group", async () => {
		await using temp = await TempDir.create("@todoloop-native-");
		await Bun.write(
			temp.join("todo.md"),
			"# Work\n## Produce\n- [x] 9 Existing\n- [ ] 2 Produce\n- [ ] 1 Consume\n## Final\n- [ ] 3 Finish\n",
		);
		const h = harness(temp.path());
		const boundaries: string[] = [];
		vi.spyOn(executor, "runSubprocess").mockImplementation(async options => {
			const pkg = taskPackage(options);
			boundaries.push(`start:${pkg.group.id}`);
			if (pkg.group.id === "1") {
				expect(pkg.group.tasks.map(task => task.id)).toEqual(["2", "1"]);
				expect(pkg.completedTaskIds).toEqual(["9"]);
				await Bun.write(temp.join("artifact"), "retained");
			} else expect(await Bun.file(temp.join("artifact")).text()).toBe("retained");
			await check(pkg);
			boundaries.push(`end:${pkg.group.id}`);
			return result(options);
		});
		expect(await h.run()).toMatchObject({ phase: "completed", completed: 4, completedGroups: 2, totalGroups: 2 });
		expect(boundaries).toEqual(["start:1", "end:1", "start:2", "end:2"]);
		const starts = h.events.filter(event => event.type === "start" && event.group);
		expect(new Set(starts.map(event => event.id)).size).toBe(2);
		expect(starts.map(event => event.attempt)).toEqual([1, 1]);
		expect(h.events.findIndex(event => event.type === "end" && event.group)).toBeLessThan(
			h.events.findLastIndex(event => event.type === "start" && event.group),
		);
		expect(h.deliveries).toEqual([]);
	});

	it("retries only remaining tasks and never resets the three-agent limit on partial progress", async () => {
		await using temp = await TempDir.create("@todoloop-partial-");
		await Bun.write(
			temp.join("todo.md"),
			"## Work\n- [ ] 1 One\n- [ ] 2 Two\n- [ ] 3 Three\n- [ ] 4 Four\n## Later\n- [ ] 5 Five\n",
		);
		const h = harness(temp.path());
		const packages: TaskPackage[] = [];
		vi.spyOn(executor, "runSubprocess").mockImplementation(async options => {
			const pkg = taskPackage(options);
			packages.push(pkg);
			expect(pkg.group.id).toBe("1");
			expect(pkg.group.tasks.map(task => task.id)).toEqual(["1", "2", "3", "4"].slice(pkg.attempt - 1));
			expect(pkg.completedTaskIds).toEqual(["1", "2", "3"].slice(0, pkg.attempt - 1));
			if (pkg.attempt > 1) {
				expect(pkg.previous?.text).toBe(`partial ${pkg.attempt - 1}`);
				expect(pkg.previous?.observation).toContain(`after attempt ${pkg.attempt - 1}`);
			}
			await check(pkg, [pkg.group.tasks[0]!.id]);
			return result(options, { output: `partial ${pkg.attempt}` });
		});
		expect(await h.run()).toMatchObject({
			phase: "failed",
			attempt: 3,
			completed: 3,
			completedGroups: 0,
			current: { id: "4" },
		});
		expect(packages.map(pkg => pkg.attempt)).toEqual([1, 2, 3]);
		expect(h.states.at(-1)?.reason).toContain("4");
	});

	it("advances a completed group despite a genuine error and keeps the error on its native card", async () => {
		await using temp = await TempDir.create("@todoloop-error-done-");
		await Bun.write(temp.join("todo.md"), "## First\n- [ ] 1 One\n- [ ] 2 Two\n## Next\n- [ ] 3 Three\n");
		const h = harness(temp.path());
		vi.spyOn(executor, "runSubprocess").mockImplementation(async options => {
			const pkg = taskPackage(options);
			expect(pkg.attempt).toBe(1);
			expect(pkg.previous).toBeUndefined();
			await check(pkg);
			return result(options, pkg.group.id === "1" ? { exitCode: 1, stderr: "actual execution error" } : {});
		});
		expect((await h.run()).phase).toBe("completed");
		expect(h.events.filter(event => event.type === "start" && event.group)).toHaveLength(2);
		expect(h.events.find(event => event.type === "end" && event.group)?.error).toContain("actual execution error");
	});

	it("publishes serialized live checkbox progress before wait and settlement return without dispatching", async () => {
		await using temp = await TempDir.create("@todoloop-live-");
		await Bun.write(temp.join("todo.md"), "## Work\n- [ ] 1 One\n- [ ] 2 Two\n## Next\n- [ ] 3 Three\n");
		const h = harness(temp.path());
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const live = Promise.withResolvers<void>();
		const groupChecked = Promise.withResolvers<void>();
		const liveDone = Promise.withResolvers<void>();
		const finishWorker = Promise.withResolvers<void>();
		const settling = Promise.withResolvers<void>();
		const finishSettlement = Promise.withResolvers<void>();
		let publish: (() => void) | undefined;
		let ended = false;
		vi.spyOn(executor, "runSubprocess").mockImplementation(async options => {
			const pkg = taskPackage(options);
			if (pkg.group.id === "1") {
				await check(pkg, ["1"]);
				entered.resolve();
				await release.promise;
			}
			await check(pkg);
			if (pkg.group.id === "1") {
				groupChecked.resolve();
				await finishWorker.promise;
			}
			return result(options);
		});
		const wait = h.native.wait.bind(h.native);
		vi.spyOn(h.native, "wait").mockImplementation(async (id, signal, onProgress) => {
			if (h.scoutJobs.has(id)) return wait(id, signal, onProgress);
			publish = () => onProgress();
			return wait(id, signal, onProgress);
		});
		const settle = h.native.settle.bind(h.native);
		let first = true;
		vi.spyOn(h.native, "settle").mockImplementation(async id => {
			await settle(id);
			if (first && !h.scoutJobs.has(id)) {
				first = false;
				settling.resolve();
				await finishSettlement.promise;
			}
		});
		const running = runTodoLoop(
			{
				cwd: temp.path(),
				filePath: "todo.md",
				onState: value => {
					h.states.push(value);
					if (value.phase === "running" && value.completed === 1) live.resolve();
					if (value.phase === "running" && value.completed === 2) liveDone.resolve();
				},
				onAttempt: value => h.events.push(value),
			},
			h.native,
		).then(value => {
			ended = true;
			return value;
		});
		try {
			await entered.promise;
			publish?.();
			publish?.();
			await live.promise;
			expect(ended).toBe(false);
			expect(h.states.at(-1)).toMatchObject({
				completed: 1,
				total: 3,
				completedGroups: 0,
				current: { id: "2" },
				attempt: 1,
			});
			expect(h.events.filter(event => event.type === "start" && event.group)).toHaveLength(1);
			release.resolve();
			await groupChecked.promise;
			publish?.();
			await liveDone.promise;
			expect(h.states.at(-1)).toMatchObject({ completed: 2, completedGroups: 1, current: undefined });
			expect(h.events.filter(event => event.type === "start" && event.group)).toHaveLength(1);
			expect(ended).toBe(false);
			finishWorker.resolve();
			await settling.promise;
			expect(ended).toBe(false);
			expect(h.events.filter(event => event.type === "start" && event.group)).toHaveLength(1);
			finishSettlement.resolve();
			expect((await running).phase).toBe("completed");
			const count = h.states.length;
			publish?.();
			await Promise.resolve();
			expect(h.states).toHaveLength(count);
		} finally {
			release.resolve();
			finishWorker.resolve();
			finishSettlement.resolve();
			await running;
		}
	});

	for (const mutation of ["other group", "unreadable"] as const) {
		it(`cancels and truly settles live ${mutation} file errors before reporting file_error`, async () => {
			await using temp = await TempDir.create("@todoloop-live-error-");
			const original = "## Work\n- [ ] 1 One\n## Other\n- [ ] 2 Two\n";
			await Bun.write(temp.join("todo.md"), original);
			const h = harness(temp.path());
			const entered = Promise.withResolvers<void>();
			const aborted = Promise.withResolvers<void>();
			const cleanup = Promise.withResolvers<void>();
			let ended = false;
			vi.spyOn(executor, "runSubprocess").mockImplementation(async options => {
				options.signal?.addEventListener("abort", () => aborted.resolve(), { once: true });
				entered.resolve();
				await cleanup.promise;
				return result(options);
			});
			const wait = h.native.wait.bind(h.native);
			vi.spyOn(h.native, "wait").mockImplementation(async (id, signal, onProgress) => {
				if (h.scoutJobs.has(id)) return wait(id, signal, onProgress);
				await entered.promise;
				if (mutation === "unreadable") await fs.unlink(temp.join("todo.md"));
				else await Bun.write(temp.join("todo.md"), original.replace("[ ] 2", "[x] 2"));
				onProgress();
				return wait(id, signal, onProgress);
			});
			const running = h.run().then(value => {
				ended = true;
				return value;
			});
			try {
				await aborted.promise;
				expect(ended).toBe(false);
				expect(h.states.at(-1)?.phase).toBe("stopping");
				cleanup.resolve();
				expect((await running).phase).toBe("file_error");
				expect(h.manager.getUnsettledJobs()).toHaveLength(0);
				expect(h.events.filter(event => event.type === "start" && event.group)).toHaveLength(1);
			} finally {
				cleanup.resolve();
				await running;
			}
		});
	}

	it("retries unchecked claims three times, retains edits, then resumes solely from a new session's file", async () => {
		await using temp = await TempDir.create("@todoloop-retry-");
		await Bun.write(temp.join("todo.md"), "- [ ] 1 First\n- [ ] 2 Second\n");
		const h = harness(temp.path());
		const attempts: number[] = [];
		const runSubprocess = vi.spyOn(executor, "runSubprocess").mockImplementation(async options => {
			const pkg = taskPackage(options);
			attempts.push(pkg.attempt);
			if (pkg.attempt > 1) expect(await Bun.file(temp.join("partial")).text()).toBe("partial work");
			await Bun.write(temp.join("partial"), "partial work");
			return result(options, { output: "I succeeded" });
		});
		expect((await h.run()).phase).toBe("failed");
		expect(attempts).toEqual([1, 2, 3]);
		runSubprocess.mockImplementation(async options => {
			const pkg = taskPackage(options);
			expect(pkg.attempt).toBe(1);
			await check(pkg);
			return result(options, { exitCode: 1, stderr: "reported failure" });
		});
		const fresh = harness(temp.path());
		expect((await fresh.run()).phase).toBe("completed");
		expect(fresh.events.filter(event => event.type === "start" && event.group)).toHaveLength(1);
	});

	it("runs zero jobs for completed input and stops malformed or unreadable input before dispatch", async () => {
		await using temp = await TempDir.create("@todoloop-input-");
		const spy = vi.spyOn(executor, "runSubprocess");
		await Bun.write(temp.join("todo.md"), "- [X] 1 Done\n");
		const h = harness(temp.path());
		expect((await h.run()).phase).toBe("completed");
		await Bun.write(temp.join("todo.md"), "- [ ] Missing number\n");
		expect((await h.run()).phase).toBe("file_error");
		await fs.unlink(temp.join("todo.md"));
		expect((await h.run()).phase).toBe("file_error");
		expect(spy).not.toHaveBeenCalled();
		expect(h.native.start).not.toHaveBeenCalled();
	});

	for (const mutation of ["rename", "other checkbox", "delete", "unreadable"] as const) {
		it(`immediately stops after ${mutation} without ordinary retries`, async () => {
			await using temp = await TempDir.create("@todoloop-invariant-");
			const original = "## First\n- [ ] 1 First\n## Second\n- [ ] 2 Second\n";
			await Bun.write(temp.join("todo.md"), original);
			const h = harness(temp.path());
			const spy = vi.spyOn(executor, "runSubprocess").mockImplementation(async options => {
				if (mutation === "unreadable") await fs.unlink(temp.join("todo.md"));
				else
					await Bun.write(
						temp.join("todo.md"),
						mutation === "rename"
							? original.replace("1 First", "1 Changed")
							: mutation === "delete"
								? original.replace("- [ ] 1 First\n", "")
								: original.replace("[ ] 2", "[x] 2"),
					);
				return result(options);
			});
			expect((await h.run()).phase).toBe("file_error");
			expect(spy).toHaveBeenCalledTimes(1);
		});
	}

	for (const outcome of ["failed", "empty"] as const) {
		it(`never executes groups after ${outcome} scout preparation`, async () => {
			await using temp = await TempDir.create("@todoloop-preparation-");
			const original = "## First\n- [ ] 1 One\n## Next\n- [ ] 2 Two\n";
			await Bun.write(temp.join("todo.md"), original);
			const h = harness(temp.path(), undefined, true);
			const run = vi.spyOn(executor, "runSubprocess").mockImplementation(async options => {
				expect(options.agent.name).toBe("scout");
				return result(
					options,
					outcome === "failed" ? { exitCode: 1, stderr: "preparation failed" } : { output: " \n\t" },
				);
			});
			expect(await h.run()).toMatchObject({ phase: "failed", completed: 0, attempt: 0 });
			expect(run).toHaveBeenCalledTimes(1);
			const starts = h.events.filter(event => event.type === "start");
			expect(starts).toHaveLength(1);
			expect(starts[0]?.group).toBeUndefined();
			expect(starts[0]?.attempt).toBe(0);
			expect(h.manager.getUnsettledJobs()).toHaveLength(0);
			expect(await Bun.file(temp.join("todo.md")).text()).toBe(original);
		});
	}

	it("cancels preparation without equating cancellation marking with cleanup or disturbing unrelated jobs", async () => {
		await using temp = await TempDir.create("@todoloop-cancel-");
		await Bun.write(temp.join("todo.md"), "- [ ] 1 First\n- [ ] 2 Second\n");
		const h = harness(temp.path(), undefined, true);
		const entered = Promise.withResolvers<void>();
		const cleanup = Promise.withResolvers<void>();
		const aborted = Promise.withResolvers<void>();
		const controller = new AbortController();
		const sibling = Promise.withResolvers<string>();
		h.manager.register("bash", "unrelated", async () => sibling.promise, { id: "sibling", ownerId: "Other" });
		vi.spyOn(executor, "runSubprocess").mockImplementation(async options => {
			expect(options.agent.name).toBe("scout");
			options.signal?.addEventListener("abort", () => aborted.resolve(), { once: true });
			entered.resolve();
			await cleanup.promise;
			return result(options);
		});
		let ended = false;
		const running = h.run(controller.signal).then(value => {
			ended = true;
			return value;
		});
		try {
			await entered.promise;
			controller.abort();
			await aborted.promise;
			expect(ended).toBe(false);
			expect(h.states.at(-1)?.phase).toBe("stopping");
			expect(h.manager.getJob("sibling")?.status).toBe("running");
			cleanup.resolve();
			expect(await running).toMatchObject({ phase: "stopped", completed: 0, total: 2 });
			expect(h.events.filter(event => event.type === "start")).toHaveLength(1);
			expect(h.events[0]?.group).toBeUndefined();
			expect(h.events[0]?.attempt).toBe(0);
		} finally {
			controller.abort();
			cleanup.resolve();
			sibling.resolve("done");
			await running;
			await h.manager.waitForAll();
		}
	});

	it("cancels a timed-out wait, awaits cleanup, then starts a fresh retry", async () => {
		await using temp = await TempDir.create("@todoloop-timeout-");
		await Bun.write(temp.join("todo.md"), "- [ ] 1 First\n");
		const h = harness(temp.path());
		const order: string[] = [];
		vi.spyOn(executor, "runSubprocess").mockImplementation(async options => {
			const pkg = taskPackage(options);
			order.push(`start:${pkg.attempt}`);
			if (pkg.attempt === 1) {
				if (!options.signal?.aborted)
					await new Promise<void>(resolve =>
						options.signal?.addEventListener("abort", () => resolve(), { once: true }),
					);
				await Promise.resolve();
			} else await check(pkg);
			order.push(`clean:${pkg.attempt}`);
			return result(options);
		});
		const wait = handles.runEvalWait;
		let first = true;
		vi.spyOn(handles, "runEvalWait").mockImplementation(async (args, options) => {
			const job = h.manager.getAllJobs().find(job => !h.scoutJobs.has(job.id));
			if (first && job) {
				first = false;
				return { items: [{ kind: "agent", id: job.id, status: "running" }] };
			}
			return wait(args, options);
		});
		expect((await h.run()).phase).toBe("completed");
		expect(order).toEqual(["start:1", "clean:1", "start:2", "clean:2"]);
	});

	it("does not execute groups when preparation descendant settlement cannot be confirmed", async () => {
		await using temp = await TempDir.create("@todoloop-settlement-");
		await Bun.write(temp.join("todo.md"), "- [ ] 1 First\n- [ ] 2 Second\n");
		const h = harness(temp.path(), undefined, true);
		const run = vi.spyOn(executor, "runSubprocess").mockImplementation(async options => {
			expect(options.agent.name).toBe("scout");
			return result(options);
		});
		vi.spyOn(h.manager, "waitForOwnerJobs").mockResolvedValue(false);
		expect((await h.run()).phase).toBe("settlement_failed");
		expect(h.events.filter(event => event.type === "start")).toHaveLength(1);
		expect(run).toHaveBeenCalledTimes(1);
		expect(h.events[0]?.group).toBeUndefined();
		expect(h.events[0]?.attempt).toBe(0);
	});

	for (const design of [false, true]) {
		it(`consumes actual Change materials with design=${design} through native task dispatch`, async () => {
			await using temp = await TempDir.create("@todoloop-materials-");
			const change = temp.join("openspec", "changes", "example");
			await fs.mkdir(path.join(change, "specs", "feature"), { recursive: true });
			await Bun.write(path.join(change, "tasks.md"), "- [ ] 1 Produce required artifact\n");
			await Bun.write(path.join(change, "proposal.md"), "required-prefix");
			await Bun.write(path.join(change, "specs", "feature", "spec.md"), "required-suffix");
			if (design) await Bun.write(path.join(change, "design.md"), "designed");
			const h = harness(temp.path(), path.join(change, "tasks.md"));
			vi.spyOn(executor, "runSubprocess").mockImplementation(async options => {
				const pkg = taskPackage(options);
				await Bun.file(pkg.filePath).text();
				if (!pkg.materials) throw new Error("No Change materials available");
				const proposal = await Bun.file(pkg.materials.proposal).text();
				const specs = await Promise.all(pkg.materials.deltaSpecs.map(file => Bun.file(file).text()));
				const designText = pkg.materials.design ? await Bun.file(pkg.materials.design).text() : "no-design";
				await Bun.write(path.join(pkg.cwd, "artifact"), [proposal, ...specs, designText].join(":"));
				await check(pkg);
				return result(options);
			});
			expect((await h.run()).phase).toBe("completed");
			expect(await Bun.file(temp.join("artifact")).text()).toBe(
				`required-prefix:required-suffix:${design ? "designed" : "no-design"}`,
			);
			expect(await Bun.file(path.join(change, "design.md")).exists()).toBe(design);
		});
	}
});

describe("TodoLoop native context and cleanup boundaries", () => {
	for (const outcome of ["done", "failed", "cancelled"] as const) {
		it(`keeps the native ${outcome} execution transcript after real session disposal`, async () => {
			await using temp = await TempDir.create("@todoloop-record-");
			const h = harness(temp.path());
			const registry = new AgentRegistry();
			const lifecycle = new AgentLifecycleManager(registry);
			h.session.agentRegistry = registry;
			h.session.agentLifecycle = () => lifecycle;
			const auth = await AuthStorage.create(":memory:");
			const entered = Promise.withResolvers<void>();
			let bodyEnded = false;
			let worker: AgentSession | undefined;
			const revive = vi.fn(async () => {
				throw new Error("Ended workers must not be revived");
			});
			vi.spyOn(executor, "runSubprocess").mockImplementation(async options => {
				const model = createMockModel({ handler: () => ({ content: ["unexpected model call"] }) });
				const transcript = SessionManager.create(temp.path(), temp.join("sessions"));
				worker = new AgentSession({
					agent: new Agent({
						initialState: { model, systemPrompt: ["Test"], tools: [] },
						getApiKey: () => "local-test",
						convertToLlm,
						streamFn: model.stream,
					}),
					sessionManager: transcript,
					settings: h.session.settings,
					modelRegistry: new ModelRegistry(auth, temp.join("models.yml")),
					agentId: options.id,
				});
				const ref = registry.register({
					id: options.id,
					displayName: `TodoLoop ${outcome}`,
					kind: "sub",
					session: worker,
					sessionFile: transcript.getSessionFile() ?? null,
					status: "running",
				});
				transcript.appendMessage({ role: "user", content: "Write execution evidence", timestamp: Date.now() });
				entered.resolve();
				if (outcome === "cancelled" && !options.signal?.aborted) {
					await new Promise<void>(resolve =>
						options.signal?.addEventListener("abort", () => resolve(), { once: true }),
					);
				}
				const evidence = `actual ${outcome} file contents`;
				await Bun.write(temp.join(`${outcome}.txt`), evidence);
				transcript.appendMessage({
					role: "toolResult",
					toolCallId: "write-evidence",
					toolName: "write",
					content: [{ type: "text", text: evidence }],
					isError: outcome !== "done",
					timestamp: Date.now(),
				});
				await transcript.ensureOnDisk();
				await transcript.flush();
				registry.setStatus(ref.id, "idle", ref);
				lifecycle.adopt(ref.id, { idleTtlMs: 0, revive }, ref);
				bodyEnded = true;
				return result(options, { output: evidence, exitCode: outcome === "failed" ? 1 : 0 });
			});
			try {
				const id = await h.native.start("Write execution evidence", `TodoLoop ${outcome}`);
				await entered.promise;
				if (outcome === "cancelled") h.native.cancel(id);
				await h.native.job(id).promise;
				await h.native.settle(id);
				expect(bodyEnded).toBe(true);
				const ref = registry.get(id);
				expect(ref?.status).toBe("parked");
				expect(ref?.session).toBeNull();
				expect(ref?.history?.executionEnded).toBe(true);
				expect(h.manager.getUnsettledJobs()).toHaveLength(0);
				expect(lifecycle.has(id)).toBe(false);
				await expect(lifecycle.ensureLive(id)).rejects.toThrow("read-only execution record");
				expect(revive).not.toHaveBeenCalled();
				if (!ref?.sessionFile) throw new Error("Missing retained native transcript");
				const opened = await SessionManager.open(ref.sessionFile);
				try {
					const messages = opened.getEntries().flatMap(entry => (entry.type === "message" ? [entry.message] : []));
					expect(messages.some(message => message.role === "toolResult" && message.toolName === "write")).toBe(
						true,
					);
					expect(JSON.stringify(messages)).toContain(await Bun.file(temp.join(`${outcome}.txt`)).text());
				} finally {
					await opened.close();
				}
			} finally {
				await worker?.dispose();
				await lifecycle.dispose();
				auth.close();
			}
		});
	}

	it("locks retry when strict native record disposal fails", async () => {
		await using temp = await TempDir.create("@todoloop-record-failure-");
		await Bun.write(temp.join("todo.md"), "- [ ] 1 First\n");
		const h = harness(temp.path());
		const registry = new AgentRegistry();
		const lifecycle = new AgentLifecycleManager(registry);
		h.session.agentRegistry = registry;
		h.session.agentLifecycle = () => lifecycle;
		let fail = true;
		const run = vi.spyOn(executor, "runSubprocess").mockImplementation(async options => {
			const ref = registry.register({
				id: options.id,
				displayName: "failed cleanup",
				kind: "sub",
				session: null,
				status: "parked",
			});
			lifecycle.adopt(
				ref.id,
				{
					idleTtlMs: 0,
					onRelease: async () => {
						if (fail) throw new Error("owned workspace remains active");
					},
				},
				ref,
			);
			return result(options);
		});
		try {
			expect((await h.run()).phase).toBe("settlement_failed");
			expect(run).toHaveBeenCalledTimes(1);
			const ref = registry.list()[0];
			expect(ref).toBeDefined();
			expect(lifecycle.has(ref!.id, ref)).toBe(true);
		} finally {
			fail = false;
			await lifecycle.dispose();
		}
	});

	it("reads explicit ordinary-file references in the session cwd and retains previous-attempt evidence", async () => {
		await using temp = await TempDir.create("@todoloop-reference-");
		await fs.mkdir(temp.join("docs"), { recursive: true });
		await Bun.write(temp.join("docs", "requirements.txt"), "required content");
		await Bun.write(temp.join("docs", "work.md"), "[Requirements](requirements.txt)\n\n- [ ] 1 Produce artifact\n");
		const h = harness(temp.path(), temp.join("docs", "work.md"));
		vi.spyOn(executor, "runSubprocess").mockImplementation(async options => {
			const pkg = taskPackage(options);
			const document = await Bun.file(pkg.filePath).text();
			const reference = document.match(/\]\(([^)]+)\)/)?.[1];
			if (!reference) throw new Error("Missing explicit requirement reference");
			const requirement = await Bun.file(path.resolve(path.dirname(pkg.filePath), reference)).text();
			if (pkg.attempt === 1) {
				await Bun.write(path.join(options.cwd, "partial"), requirement);
				return result(options, { output: "partial work retained" });
			}
			expect(pkg.previous?.text).toBe("partial work retained");
			expect(pkg.previous?.error).toBeUndefined();
			const existing = await Bun.file(path.join(options.cwd, "partial")).text();
			await Bun.write(path.join(pkg.cwd, "artifact"), existing);
			await check(pkg);
			return result(options);
		});
		expect((await h.run()).phase).toBe("completed");
		expect(await Bun.file(temp.join("artifact")).text()).toBe("required content");
		expect(await Bun.file(temp.join("docs", "artifact")).exists()).toBe(false);
	});

	it("settles recursively owned native jobs before retry and leaves a sibling untouched", async () => {
		await using temp = await TempDir.create("@todoloop-descendants-");
		await Bun.write(temp.join("todo.md"), "- [ ] 1 First\n");
		const h = harness(temp.path());
		const cleanupOrder: string[] = [];
		const sibling = Promise.withResolvers<string>();
		h.manager.register("bash", "sibling", async () => sibling.promise, { id: "sibling", ownerId: "Other" });
		vi.spyOn(executor, "runSubprocess").mockImplementation(async options => {
			const pkg = taskPackage(options);
			if (pkg.attempt === 1) {
				h.manager.register(
					"task",
					"owned child",
					async ({ signal }) => {
						if (!signal.aborted)
							await new Promise<void>(resolve =>
								signal.addEventListener("abort", () => resolve(), { once: true }),
							);
						await Promise.resolve();
						cleanupOrder.push("child cleaned");
						return "child stopped";
					},
					{ id: "child", agentId: "child", ownerId: options.id, suppressDelivery: true },
				);
				h.manager.register(
					"bash",
					"owned grandchild",
					async ({ signal }) => {
						if (!signal.aborted)
							await new Promise<void>(resolve =>
								signal.addEventListener("abort", () => resolve(), { once: true }),
							);
						cleanupOrder.push("grandchild cleaned");
						return "grandchild stopped";
					},
					{ id: "grandchild", ownerId: "child", suppressDelivery: true },
				);
			} else {
				expect(cleanupOrder).toContain("child cleaned");
				expect(cleanupOrder).toContain("grandchild cleaned");
				expect(h.manager.getJob("sibling")?.status).toBe("running");
				await check(pkg);
			}
			return result(options);
		});
		try {
			expect((await h.run()).phase).toBe("completed");
		} finally {
			sibling.resolve("finished");
			h.manager.cancelAll();
			await h.manager.waitForAll();
		}
	});

	it("stops environment failure at dispatch rather than spending three attempts", async () => {
		await using temp = await TempDir.create("@todoloop-environment-");
		await Bun.write(temp.join("todo.md"), "- [ ] 1 First\n");
		const h = harness(temp.path(), undefined, true);
		vi.spyOn(discovery, "discoverAgents").mockRejectedValue(new Error("Agent environment unavailable"));
		const spy = vi.spyOn(executor, "runSubprocess");
		expect((await h.run()).phase).toBe("file_error");
		expect(spy).not.toHaveBeenCalled();
	});
});

describe("TodoLoop AgentSession ownership", () => {
	for (const transition of ["abort", "newSession", "dispose"] as const) {
		it(`revokes dispatch ownership on ${transition} without waking the primary model`, async () => {
			await using temp = await TempDir.create("@todoloop-session-");
			await Bun.write(temp.join("todo.md"), "- [ ] 1 First\n- [ ] 2 Second\n");
			const h = harness(temp.path());
			const model = createMockModel({ handler: () => ({ content: ["unexpected primary delivery"] }) });
			const auth = await AuthStorage.create(":memory:");
			const agent = new Agent({
				initialState: { model, systemPrompt: ["Test"], tools: [] },
				getApiKey: () => "local-test",
				convertToLlm,
				streamFn: model.stream,
			});
			const session = new AgentSession({
				agent,
				sessionManager: SessionManager.inMemory(temp.path()),
				settings: h.session.settings,
				modelRegistry: new ModelRegistry(auth, temp.join("models.yml")),
				agentId: "Main",
				asyncJobManager: h.manager,
				evalToolSession: h.session,
			});
			const entered = Promise.withResolvers<void>();
			const aborted = Promise.withResolvers<void>();
			const cleanup = Promise.withResolvers<void>();
			let exited = false;
			const runSubprocess = vi.spyOn(executor, "runSubprocess").mockImplementation(async options => {
				options.signal?.addEventListener("abort", () => aborted.resolve(), { once: true });
				expect(options.agent.name).toBe("scout");
				entered.resolve();
				await cleanup.promise;
				exited = true;
				return result(options);
			});
			const states: TodoLoopState[] = [];
			const running = session.runTodoLoop({ filePath: "todo.md", onState: state => states.push(state) });
			try {
				await entered.promise;
				const leaving =
					transition === "dispose"
						? session.dispose()
						: transition === "newSession"
							? session.newSession()
							: session.abort();
				await aborted.promise;
				expect(exited).toBe(false);
				const countAtRevocation = states.length;
				cleanup.resolve();
				expect((await running).phase).toBe("stopped");
				await leaving;
				if (transition !== "abort") expect(states).toHaveLength(countAtRevocation);
				expect(model.calls).toHaveLength(0);
				expect(runSubprocess).toHaveBeenCalledTimes(1);
			} finally {
				cleanup.resolve();
				try {
					await session.abort();
					await running;
					await session.dispose();
				} finally {
					auth.close();
				}
			}
		});
	}
});
