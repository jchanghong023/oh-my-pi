import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { chatTranscriptDisplayPreferences, setChatTranscriptDisplayPreferences } from "../src/chat/display-preferences";
import { ReadToolGroupComponent } from "../src/chat/read-tool-group";
import { stopSharedSpinnerTicker, ToolExecutionComponent } from "../src/chat/tool-execution";
import { TranscriptContainer } from "../src/chrome/transcript-container";
import { Text } from "../src/components/text";
import { TspDocument } from "../src/native/apply";
import { Reconciler } from "../src/native/reconcile";
import { initTheme } from "../src/theme";

const preferences = { ...chatTranscriptDisplayPreferences };
const components: ToolExecutionComponent[] = [];
function tool(name: string, args: unknown, compactToolActivity?: boolean): ToolExecutionComponent {
	const component = new ToolExecutionComponent(name, args, { compactToolActivity }, undefined, {
		requestRender() {},
		requestComponentRender() {},
		resetDisplay() {},
	});
	components.push(component);
	return component;
}
function output(root: TranscriptContainer): string {
	return Bun.stripANSI(root.render(80).join("\n"));
}
function native(root: TranscriptContainer): string {
	const document = new TspDocument("s:regression");
	const ops = new Reconciler("s:regression").reconcile(
		{ main: root.nativeBlocks(), dock: [], layer: [] },
		{
			cols: 80,
			reduceMotion: false,
			dark: true,
			supports: () => true,
			feature: () => true,
		},
	);
	expect(document.applyFrame({ sf: "s:regression", s: 1, ops })).toEqual([]);
	return JSON.stringify(document.snapshot());
}
beforeAll(async () => {
	await initTheme(false);
});
afterEach(() => {
	for (const component of components.splice(0)) component.dispose();
	stopSharedSpinnerTicker();
	setChatTranscriptDisplayPreferences(preferences);
});

describe("compact tool component integration", () => {
	it("omits synthetic waits without counting them as actual calls", () => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: true, hideToolActivity: false });
		const root = new TranscriptContainer();
		for (const path of ["first.ts", "second.ts"]) {
			const read = tool("read", { path });
			read.updateResult({ content: [{ type: "text", text: "read result" }] });
			root.addChild(read);
		}
		const wait = tool("wait", { jobs: ["bg_1"] });
		wait.updateResult({
			content: [{ type: "text", text: "internal retry guidance" }],
			isError: true,
			details: { source: "interrupt_skipped", __synthetic: true },
		});
		root.addChild(wait);
		expect(output(root)).toMatch(/first\.ts[^]*second\.ts/);
		expect(output(root)).not.toContain("工具调用");
		expect(output(root)).not.toContain("internal retry guidance");
	});

	it("preserves raw structured Bash errors outside the ordinary preview quota", () => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		const root = new TranscriptContainer();
		const bash = tool("bash", { command: "failing-command" });
		const result = {
			content: [{ type: "text" as const, text: '{"error":{"code":"RAW_DIAGNOSTIC","detail":["reason"]}}' }],
			isError: true,
		};
		const original = JSON.stringify(result);
		bash.updateResult(result);
		root.addChild(bash);
		for (const path of ["latest-a.ts", "latest-b.ts"]) {
			const read = tool("read", { path });
			read.updateResult({ content: [] });
			root.addChild(read);
		}
		for (const view of [output(root), native(root)]) {
			expect(view).toContain("RAW_DIAGNOSTIC");
			expect(view).toContain("latest-a.ts");
			expect(view).toContain("latest-b.ts");
			expect(view).toContain("工具调用 3 次 · 失败 1 次");
		}
		expect(JSON.stringify(result)).toBe(original);
	});

	it("retains input-wait feedback immediately when newer calls arrive", () => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		const root = new TranscriptContainer();
		const bash = tool("bash", { command: "needs-input" });
		bash.setCompactNeedsUserInput("INPUT_REQUIRED");
		root.addChild(bash);
		for (const command of ["new-one", "new-two", "new-three"]) root.addChild(tool("bash", { command }));
		expect(output(root)).toContain("needs-input");
		expect(bash.hasCompactCriticalFeedback()).toBe(true);
	});

	it("shares per-entry read selection across groups and preserves identity on provider rename", () => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		const root = new TranscriptContainer();
		const group = new ReadToolGroupComponent();
		for (const id of ["read-a", "read-b", "read-c"]) group.updateArgs({ path: `${id}.ts` }, id);
		const identities = group.getCompactToolCalls().map(call => call.id);
		root.addChild(group);
		expect(output(root)).not.toContain("read-a.ts");
		group.renameEntry("read-c", "corrected-provider-id");
		group.updateArgs({ path: "renamed.ts" }, "corrected-provider-id");
		expect(group.getCompactToolCalls().map(call => call.id)).toEqual(identities);
		for (const view of [output(root), native(root)]) {
			expect(view).toContain("工具调用 3 次");
			expect(view).toContain("read-b.ts");
			expect(view).toContain("renamed.ts");
			expect(view).not.toContain("read-a.ts");
		}
		root.addChild(tool("bash", { command: "last-command" }));
		expect(output(root)).not.toContain("read-b.ts");
		expect(output(root)).toContain("renamed.ts");
		expect(output(root)).toContain("last-command");
	});

	it("keeps original grouped-read error details rather than an extracted failure line", () => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		const root = new TranscriptContainer();
		// Upstream ANSI/fallback read groups show result bodies only with content previews enabled.
		const group = new ReadToolGroupComponent({ showContentPreview: true });
		group.updateArgs({ path: "missing.ts" }, "missing");
		group.updateResult(
			{ content: [{ type: "text", text: "RAW_READ_ERROR: missing source file" }], isError: true },
			false,
			"missing",
		);
		for (const id of ["later-a", "later-b", "later-c"]) group.updateArgs({ path: `${id}.ts` }, id);
		root.addChild(group);
		for (const view of [output(root), native(root)]) {
			expect(view).toContain("RAW_READ_ERROR");
			expect(view).toContain("later-b.ts");
			expect(view).toContain("later-c.ts");
			expect(view).not.toContain("later-a.ts");
		}
		group.setExpanded(true);
		for (const view of [output(root), native(root)]) {
			expect(view).toContain("RAW_READ_ERROR: missing source file");
			expect(view).toContain("later-a.ts");
		}
	});

	it("keeps explicit detailed components outside compact quotas", () => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		const root = new TranscriptContainer();
		const detailed = tool("bash", { command: "explicit-detail" }, false);
		detailed.updateResult({ content: [{ type: "text", text: "FULL_DETAIL" }] });
		root.addChild(detailed);
		root.addChild(new Text("PROSE", 0, 0));
		for (const command of ["old", "one", "two"]) root.addChild(tool("bash", { command }));
		expect(output(root)).toContain("FULL_DETAIL");
	});

	it("retains device-dispatched edit cards without changing their results", () => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		const edit = tool("write", { path: "xd://edit", content: JSON.stringify({ path: "sample.ts" }) });
		const result = {
			content: [{ type: "text" as const, text: "edit complete" }],
			details: {
				xdev: {
					tool: "edit",
					mode: "execute",
					inner: { path: "sample.ts", diff: "@@ -1 +1 @@\n-old_value\n+new_value" },
				},
			},
		};
		const original = JSON.stringify(result);
		edit.updateResult(result);
		const root = new TranscriptContainer();
		root.addChild(edit);
		expect(edit.isCompactActualFileWrite()).toBe(true);
		expect(output(root)).toContain("new_value");
		expect(native(root)).toContain("sample.ts");
		expect(JSON.stringify(result)).toBe(original);
	});
});
