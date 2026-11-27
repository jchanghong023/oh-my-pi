/**
 * The status line's background-job badge: running jobs beside the running
 * subagents, a task job counted once its subagent is not yet registered.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import type { AsyncJobType } from "@oh-my-pi/pi-coding-agent/async";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { AsyncJobSnapshotItem } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import { statusSegs } from "../src/ui/status/status-line";
import { disposeStatusLines, lineText, statusLine, statusSession } from "./helpers/session-status-line";

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
});

afterAll(() => {
	resetSettingsForTest();
});

afterEach(() => {
	disposeStatusLines();
});

function runningJob(type: AsyncJobType, index: number): AsyncJobSnapshotItem {
	const id = `${type}-${index}`;
	return {
		id,
		type,
		status: "running",
		label: `${type} ${index}`,
		startTime: index,
		agentId: type === "task" ? id : undefined,
	};
}

function makeLine(running: AsyncJobSnapshotItem[]) {
	const model = { id: "test-model", name: "Test Model", contextWindow: 100_000, input: ["text"] };
	return statusLine(statusSession({ model, getAsyncJobSnapshot: () => ({ running }) }), {
		preset: "custom",
		leftSegments: [],
		rightSegments: [],
		separator: "none",
		transparent: true,
	});
}

describe("status-line background-job badge", () => {
	it("keeps running subagents in the configured group instead of moving them to the right", () => {
		const line = makeLine([runningJob("task", 0)]);
		line.previewSettings({
			preset: "custom",
			leftSegments: ["model", "subagents", "context_pct"],
			rightSegments: [],
		});
		line.setRunningSubagents(["task-0"]);
		const badge = `${currentTheme().symbols.icon("agents")} 1`;
		const first = lineText(line, 240);
		expect(first.split(badge)).toHaveLength(2);
		expect(first.indexOf(badge)).toBeLessThan(first.indexOf("100K"));

		line.previewSettings({ preset: "custom", leftSegments: ["model"], rightSegments: ["subagents"] });
		const second = lineText(line, 120);
		expect(second.split(badge)).toHaveLength(2);
		expect(statusSegs(line.settings(), line.facts()).find(segment => segment.key === "subagents")?.side).toBe("right");
	});

	it("counts non-task jobs without duplicating running task subagents", () => {
		const line = makeLine([runningJob("task", 0), runningJob("bash", 1), runningJob("eval", 2)]);
		line.setRunningSubagents(["task-0"]);
		expect(line.facts().subagents).toBe(1);
		expect(line.facts().jobs).toBe(2);
	});

	it("counts queued task jobs before their subagent is registered", () => {
		const line = makeLine([runningJob("task", 0)]);
		line.setRunningSubagents([]);
		expect(line.facts().jobs).toBe(1);
	});

	it("counts every running non-task job", () => {
		const line = makeLine([runningJob("bash", 1), runningJob("eval", 2)]);
		expect(line.facts().jobs).toBe(2);
	});
});
