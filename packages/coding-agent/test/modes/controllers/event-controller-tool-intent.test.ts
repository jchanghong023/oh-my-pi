// A live tool card renders the model's intent, as a card rebuilt from the transcript does.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Settings, resetSettingsForTest } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { cfgDisplayMode } from "@oh-my-pi/pi-coding-agent/modes/settings";
import { AssistantMessageComponent } from "@oh-my-pi/pi-tui/chat/assistant-message";
import {
	chatTranscriptDisplayPreferences,
	setChatTranscriptDisplayPreferences,
} from "@oh-my-pi/pi-tui/chat/display-preferences";
import type { ToolExecutionComponent } from "@oh-my-pi/pi-tui/chat/tool-execution";
import type { DescribeContext, NativeNode } from "@oh-my-pi/pi-tui/native/node";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { createAssistantMessage } from "../../helpers/agent-session-setup";
import { createInteractiveModeContext } from "../../helpers/interactive-mode-context";

/** The native node a TSP terminal draws for the card. */
function toolNode(component: ToolExecutionComponent): NativeNode {
	const cx: DescribeContext = {
		cols: 100,
		reduceMotion: false,
		dark: true,
		supports: kind => kind === "tool" || kind === "media",
		feature: () => true,
	};
	const node = component.describe(cx);
	if (!node) throw new Error("card described nothing");
	return node;
}

function headTargetText(component: ToolExecutionComponent): string | undefined {
	const target = (toolNode(component).p as Record<string, unknown>).target;
	if (typeof target === "string") return target;
	if (!Array.isArray(target)) return undefined;
	return target.map(part => (typeof part?.t === "string" ? part.t : "")).join("");
}

describe("EventController tool intent", () => {
	let previousDisplayPreferences: typeof chatTranscriptDisplayPreferences;

	beforeEach(async () => {
		previousDisplayPreferences = { ...chatTranscriptDisplayPreferences };
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		await initTheme();
		setChatTranscriptDisplayPreferences({ hideToolActivity: false });
	});

	afterEach(() => {
		resetSettingsForTest();
		setChatTranscriptDisplayPreferences(previousDisplayPreferences);
	});

	function fixture() {
		const pendingTools = new Map<string, ToolExecutionComponent>();
		const ctx = createInteractiveModeContext({
			pendingTools,
			session: { isStreaming: true },
			viewSession: { isStreaming: true, hasBuiltInTool: () => true, getToolByName: () => undefined },
		});
		cfgDisplayMode.override(ctx.settings, "detailed");
		return { controller: new EventController(ctx), pendingTools, ctx };
	}

	const start = (intent: string | undefined) => ({
		type: "tool_execution_start" as const,
		toolCallId: "tc-bash",
		toolName: "bash",
		// The executed args: the harness strips `i` before running the tool.
		args: { command: "ls -la" },
		...(intent === undefined ? {} : { intent }),
	});

	it("shows the intent on a card created by tool_execution_start", async () => {
		const { controller, pendingTools, ctx } = fixture();
		await controller.handleEvent(start("Listing the working tree...: Which files have changed?"));
		const card = pendingTools.get("tc-bash");
		if (!card) throw new Error("no card for the call");
		expect(headTargetText(card)).toBe("Listing the working tree...");
		expect(toolNode(card).p).toMatchObject({ intent: "Listing the working tree..." });
		expect(ctx.setWorkingMessage).toHaveBeenLastCalledWith("Listing the working tree");
	});

	it("keeps the intent when tool_execution_start refreshes a streamed card", async () => {
		const { controller, pendingTools, ctx } = fixture();
		const args = { command: "ls -la", i: "Listing the working tree: Which files have changed?" };
		const message = createAssistantMessage("");
		message.content = [{ type: "toolCall", id: "tc-bash", name: "bash", arguments: args }];
		ctx.streamingComponent = new AssistantMessageComponent();
		await controller.syncAssistantMessage(message);
		const card = pendingTools.get("tc-bash");
		if (!card) throw new Error("no streamed card for the call");
		expect(headTargetText(card)).toBe("Listing the working tree");
		expect(toolNode(card).p).toMatchObject({ intent: "Listing the working tree" });
		expect(ctx.setWorkingMessage).toHaveBeenLastCalledWith("Listing the working tree");
		await controller.handleEvent(start(args.i));
		expect(headTargetText(card)).toBe("Listing the working tree");
		expect(toolNode(card).p).toMatchObject({ intent: "Listing the working tree" });
	});
});
