import { describe, expect, test } from "bun:test";
import { createRoot, isUiNode, type UiNode } from "@oh-my-pi/pi-tui";
import { paintNode } from "@oh-my-pi/pi-tui/term/paint";
import { firstCellDiff } from "@oh-my-pi/pi-tui/testing/cells";
import { corpusEnvironment, describeTree, firstDiff, stageNative } from "@oh-my-pi/pi-tui/testing/corpus";
import { stageTest } from "../deviations";
import "../../../src/ui/styles/tools/task";
import type { AgentProgress, SingleResult, TaskToolDetails } from "../../../src/task/task-details";
import { noteAgentArrival, resetAgentIdentities } from "../../../src/ui/tools/agent-identity";
import { NestedTaskResults, taskPresenter } from "../../../src/ui/tools/task";
import { registerSubprocessToolView } from "../../../src/ui/tools/task/subprocess-views";
import { checkFlowCase, flowCaseFiles, loadFlowCase } from "../transcript/tool-flows";
import { bodyNodes } from "./presenter-corpus";
import { loadScreenCase, screenCaseFiles, type ToolScreen, toolScreenSuite } from "./screens";

/**
 * The fixtures register every agent id they draw, sorted, before any case
 * (subagent colours follow arrival order); `agentColorSlots` records it.
 */
const slots = screenCaseFiles("tools/task")
	.map(
		file =>
			(
				loadScreenCase("tools/task", file).inputs as {
					agentColorSlots?: string[];
				}
			).agentColorSlots,
	)
	.find(Boolean);
// Colour slots are session state: start from the capture's arrivals, not whatever earlier files left.
resetAgentIdentities();
slots?.forEach((id, index) => {
	noteAgentArrival(id, index);
});

/** The capture's child tool: inline `lint N` (dim), final `lint final N`. */
registerSubprocessToolView<{ n: number }>("lint_case", {
	inline: data => [{ s: "dim", t: `lint ${data.n}` }],
	final: all => all.map(data => `lint final ${data.n}`).join("\n"),
});

export const taskScreen: ToolScreen = {
	dir: "tools/task",
	name: "task",
	presenter: taskPresenter,
};

toolScreenSuite(taskScreen);

const NESTED = "tools/task-nested";
const nestedFiles = screenCaseFiles(NESTED);

describe.skipIf(nestedFiles.length === 0)(`${NESTED} corpus`, () => {
	for (const file of nestedFiles) {
		const corpusCase = loadScreenCase(NESTED, file);
		const inputs = corpusCase.inputs as {
			data: TaskToolDetails[];
			expanded: boolean;
		};
		test(file, () => {
			const env = corpusEnvironment(corpusCase.theme);
			createRoot(dispose => {
				const node = NestedTaskResults({
					snapshots: inputs.data,
					expanded: inputs.expanded,
				});
				if (!isUiNode(node)) throw new Error("task-nested: node expected");
				const failures: string[] = [];
				corpusCase.stages.forEach((stage, index) => {
					const native = firstDiff(stageNative(corpusCase, index), describeTree(node as UiNode, env));
					if (native) failures.push(`${stage.label} native: ${native}`);
					for (const width of corpusCase.widths) {
						const diff = firstCellDiff(
							stage.rows[String(width)] ?? [],
							paintNode(env, node as UiNode, width).rows,
						);
						if (diff) failures.push(`${stage.label} @${width}: ${diff}`);
					}
				});
				dispose();
				expect(failures).toEqual([]);
			});
		});
	}
});

/** transcript/tool/task: rows only; the native tree is a listed deviation (the capture described the generic card). */
const flowFiles = flowCaseFiles("task");
describe.skipIf(flowFiles.length === 0)("transcript/tool/task corpus", () => {
	for (const file of flowFiles) {
		const results = checkFlowCase(loadFlowCase("task", file));
		for (const result of results) stageTest("transcript/tool/task", file, result);
	}
});

test("same-named task owners and nested owners keep their own snapshot duration", () => {
	const base = {
		index: 0,
		id: "Shared",
		agent: "task",
		agentSource: "bundled" as const,
		task: "investigate",
		tokens: 0,
		requests: 0,
	};
	const snapshot = (durationMs: number, inflightTaskDetails?: TaskToolDetails): TaskToolDetails => {
		const progress: AgentProgress = {
			...base,
			status: "running",
			durationMs,
			inflightTaskDetails,
			recentTools: [],
			recentOutput: [],
			toolCount: 0,
			cost: 0,
		};
		return { projectAgentsDir: null, results: [], totalDurationMs: 0, progress: [progress] };
	};
	const completed: SingleResult = {
		...base,
		exitCode: 0,
		output: "done",
		stderr: "",
		truncated: false,
		durationMs: 2000,
	};
	const findAgents = (nodes: readonly UiNode[]): UiNode[] =>
		nodes.flatMap(node => [...(node.kind === "agent" ? [node] : []), ...findAgents(node.children())]);
	const stats = (details: TaskToolDetails, elapsedMs: number) =>
		createRoot(dispose => {
			try {
				const view = taskPresenter.result!(
					{ content: [], details },
					{
						expanded: false,
						isPartial: true,
						argsComplete: true,
						executionStarted: true,
						renderContext: { nowMs: elapsedMs },
					},
					{},
				);
				return findAgents(bodyNodes(view?.body)).map(node => (node.props() as { stats?: unknown }).stats);
			} finally {
				dispose();
			}
		});
	const old = snapshot(1000);
	expect(stats(old, 2000)).toMatchObject([{ age: 1000 }]);
	expect(stats(snapshot(2000), 3000)).toMatchObject([{ age: 2000 }]);
	expect(stats({ projectAgentsDir: null, results: [completed], totalDurationMs: 2000 }, 3000)).toMatchObject([
		{ took: 2000 },
	]);
	expect(stats(snapshot(100), 92_000)).toMatchObject([{ age: 100 }]);
	expect(stats(old, 92_100)).toMatchObject([{ age: 1000 }]);
	expect(stats(snapshot(0), 92_200)).toMatchObject([{ age: 0 }]);
	expect(stats(snapshot(1000, snapshot(100)), 92_000)).toMatchObject([{ age: 1000 }, { age: 100 }]);
});
