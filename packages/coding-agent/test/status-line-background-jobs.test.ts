import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { AsyncJobType } from "@oh-my-pi/pi-coding-agent/async";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { StatusLineComponent } from "@oh-my-pi/pi-tui/status-line";
import { statusLineHost } from "@oh-my-pi/pi-coding-agent/modes/status-line-host";
import { initTheme, theme } from "@oh-my-pi/pi-tui/theme";
import type { AsyncJobSnapshotItem } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";
import { StatusLineTestComponents } from "./helpers/status-line";

let settingsState: SettingsTestState | undefined;
const statusLines = new StatusLineTestComponents();

beforeEach(async () => {
	settingsState = beginSettingsTest();
	await Settings.init({ inMemory: true });
	await initTheme();
});

afterEach(() => {
	statusLines.dispose();
	restoreSettingsTestState(settingsState);
	settingsState = undefined;
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

function makeComponent(running: AsyncJobSnapshotItem[]): StatusLineComponent {
	const messages: unknown[] = [];
	const model = { id: "test-model", name: "Test Model", contextWindow: 100_000 };
	const session = {
		state: { messages, model },
		messages,
		model,
		contextUsageRevision: 0,
		systemPrompt: [],
		agent: { state: { tools: [] } },
		skills: [],
		isStreaming: false,
		isAutoThinking: false,
		autoResolvedThinkingLevel: () => undefined,
		isFastModeActive: () => false,
		isAdvisorActive: () => false,
		getAdvisorStatusOverview: () => ({ configured: false, advisors: [] }),
		getAsyncJobSnapshot: () => ({ running }),
		settings: { get: () => false },
		modelRegistry: { isUsingOAuth: () => false },
		sessionManager: {
			getSessionName: () => undefined,
			getUsageStatistics: () => ({
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				orchestrationInput: 0,
				orchestrationOutput: 0,
				orchestrationCacheRead: 0,
				premiumRequests: 0,
				cost: 0,
			}),
		},
		getContextUsage: () => undefined,
	} as unknown as ConstructorParameters<typeof StatusLineComponent>[0];
	const component = statusLines.track(new StatusLineComponent(session, statusLineHost));
	component.updateSettings({
		preset: "custom",
		leftSegments: [],
		rightSegments: [],
		separator: "none",
		transparent: true,
	});
	return component;
}

describe("status-line background-job badge", () => {
	it("keeps running subagents in the configured group instead of moving them to the right", () => {
		const component = makeComponent([runningJob("task", 0)]);
		component.updateSettings({
			preset: "custom",
			leftSegments: ["model", "subagents", "context_pct"],
			rightSegments: [],
		});
		component.setRunningSubagents(["task-0"]);

		const content = stripVTControlCharacters(component.getTopBorder(240).content);
		const badge = `${theme.icon.agents} 1`;
		expect(content.split(badge)).toHaveLength(2);
		expect(content.indexOf(badge)).toBeLessThan(content.indexOf("100K"));
		const leftBadge = component.describePreview().c?.find(child => "k" in child && child.key === "subagents");
		expect(leftBadge && "k" in leftBadge ? leftBadge.p : undefined).toMatchObject({ side: "left" });

		component.updateSettings({ preset: "custom", leftSegments: ["model"], rightSegments: ["subagents"] });
		const customContent = stripVTControlCharacters(component.getTopBorder(120).content);
		expect(customContent.split(badge)).toHaveLength(2);
		expect(customContent.indexOf(badge)).toBeGreaterThan(customContent.indexOf("Test Model"));
		const rightBadge = component.describePreview().c?.find(child => "k" in child && child.key === "subagents");
		expect(rightBadge && "k" in rightBadge ? rightBadge.p : undefined).toMatchObject({ side: "right" });
	});

	it("counts non-task jobs without duplicating running task subagents", () => {
		const running = [runningJob("task", 0), runningJob("bash", 1), runningJob("eval", 2)];
		const component = makeComponent(running);
		component.setRunningSubagents(["task-0"]);

		const content = stripVTControlCharacters(component.getTopBorder(120).content);
		expect(content).toContain(`${theme.icon.agents} 1`);
		expect(content).toContain(`${theme.icon.job} 2`);
	});

	it("counts queued task jobs before their subagent is registered", () => {
		const component = makeComponent([runningJob("task", 0)]);
		component.setRunningSubagents([]);
		const content = stripVTControlCharacters(component.getTopBorder(120).content);
		expect(content).toContain(`${theme.icon.job} 1`);
	});
});
