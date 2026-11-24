import { expect, test } from "bun:test";
import { createRoot } from "@oh-my-pi/pi-tui";
import { paintNode, staticEnvironment } from "@oh-my-pi/pi-tui/term/paint";
import { describeTree } from "@oh-my-pi/pi-tui/testing/corpus";
import { PLAIN_THEME } from "@oh-my-pi/pi-tui/theme/plain";
import type { ToolResult, ToolViewState } from "../../../src/ui/tools/contract";
import "../../../src/ui/styles/tools/web-search";
import { type WebSearchDetails, webSearchPresenter } from "../../../src/ui/tools/web-search";
import { bodyNodes, toolNode, toolScreenSuite } from "./presenter-corpus";

toolScreenSuite("web_search", "web_search", webSearchPresenter);

test("applies only an explicit CLI row budget and keeps the original answer for native and expanded views", () => {
	const answer = ["First paragraph", "Second paragraph", "Third paragraph", "FINAL_UNIQUE_MARKER"].join("\n\n");
	const result: ToolResult<WebSearchDetails> = {
		content: [{ type: "text", text: answer }],
		details: { response: { provider: "openai", answer, sources: [] } },
	};
	const original = structuredClone(result);
	const env = staticEnvironment(PLAIN_THEME);
	const render = (expanded: boolean, maxAnswerLines?: number) =>
		createRoot(dispose => {
			try {
				const state: ToolViewState = { expanded, isPartial: false, argsComplete: true, executionStarted: true };
				const view = webSearchPresenter.result!(result, state, { query: "test query", maxAnswerLines });
				const node = toolNode("web_search", view, bodyNodes(view?.body), "done", state);
				return {
					terminal: Bun.stripANSI(paintNode(env, node, 120).rows.join("\n")),
					native: JSON.stringify(describeTree(node, env, 120)),
				};
			} finally {
				dispose();
			}
		});
	expect(render(false).terminal).toContain("FINAL_UNIQUE_MARKER");
	const capped = render(false, 3);
	expect(capped.terminal).toContain("First paragraph");
	expect(capped.terminal).toMatch(/\d+ more lines/);
	expect(capped.terminal).not.toContain("FINAL_UNIQUE_MARKER");
	expect(capped.native).toContain("FINAL_UNIQUE_MARKER");
	expect(render(true, 3).terminal).toContain("FINAL_UNIQUE_MARKER");
	expect(result).toEqual(original);
});
