import { describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { TodoTool } from "@oh-my-pi/pi-coding-agent/tools/todo";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";

function fixture() {
	let phases: TodoPhase[] = [];
	const session: ToolSession = {
		cwd: process.cwd(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		getTodoPhases: () => phases,
		setTodoPhases: next => {
			phases = next;
		},
	};
	return { tool: new TodoTool(session), read: () => structuredClone(phases) };
}

describe("todo append preserves progress and offers actionable recovery", () => {
	it.each<Parameters<TodoTool["execute"]>[1]>([
		{ op: "append", items: ["new task"] },
		{ op: "append", phase: "Tasks" },
		{ op: "append", phase: "Tasks", items: [] },
	])("rejects incomplete append %j and retries against the viewed phase without reset", async args => {
		const { tool, read } = fixture();
		await tool.execute("init", { op: "init", items: ["finished task", "active task", "queued task"] });
		await tool.execute("done", { op: "done", task: "finished task" });
		const before = read();
		expect(before[0].tasks.map(task => task.status)).toEqual(["completed", "in_progress", "pending"]);
		const failed = await tool.execute("bad-append", args);
		expect(failed.isError).toBe(true);
		expect(read()).toEqual(before);
		expect(failed.details?.phases).toEqual(before);
		const viewed = await tool.execute("view", { op: "view" });
		expect(viewed.details?.phases).toEqual(before);
		const viewedPhase = viewed.details?.phases[0];
		if (!viewedPhase) throw new Error("Todo view did not return the existing phase");
		const phase = viewedPhase.name;
		const retried = await tool.execute("retry", { op: "append", phase, items: ["new task"] });
		expect(retried.isError).toBeUndefined();
		expect(read()).toEqual([
			{ ...before[0], tasks: [...before[0].tasks, { content: "new task", status: "pending" }] },
		]);
	});
});
