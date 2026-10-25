import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { chatTranscriptDisplayPreferences, setChatTranscriptDisplayPreferences } from "../src/chat/display-preferences";
import type { CustomMessage } from "../src/chat/messages";
import { stopSharedSpinnerTicker, ToolExecutionComponent } from "../src/chat/tool-execution";
import { buildLaunchCompletionBlock } from "../src/chat/transcript-render-helpers";
import { TranscriptContainer } from "../src/chrome/transcript-container";
import { TspDocument } from "../src/native/apply";
import { Reconciler } from "../src/native/reconcile";
import { initTheme } from "../src/theme";

const originalPreferences = { ...chatTranscriptDisplayPreferences };
const components: ToolExecutionComponent[] = [];

function tool(name: string, args: unknown): ToolExecutionComponent {
	const component = new ToolExecutionComponent(name, args, {}, undefined, {
		requestRender() {},
		requestComponentRender() {},
		resetDisplay() {},
	});
	components.push(component);
	return component;
}

beforeAll(async () => {
	await initTheme(false);
});

afterEach(() => {
	for (const component of components.splice(0)) component.dispose();
	stopSharedSpinnerTicker();
	setChatTranscriptDisplayPreferences(originalPreferences);
});

describe("compact tool projection regressions", () => {
	it("omits an interrupted synthetic wait without displacing the two latest actual calls", () => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: true, hideToolActivity: false });
		const transcript = new TranscriptContainer();
		transcript.setCompactTurnActive(true);
		for (const path of ["first.ts", "second.ts"]) {
			const read = tool("read", { path });
			read.updateResult({ content: [{ type: "text", text: "read result" }] });
			transcript.addChild(read);
		}
		const wait = tool("wait", { jobs: ["bg_1"] });
		wait.updateResult({
			content: [{ type: "text", text: "internal retry guidance" }],
			isError: true,
			details: { source: "interrupt_skipped", __synthetic: true },
		});
		transcript.addChild(wait);
		const rows = transcript.compactToolActivityBlock()?.render(80) ?? [];
		expect(rows).toHaveLength(2);
		expect(Bun.stripANSI(rows.join("\n"))).toMatch(/first\.ts[^]*second\.ts/);
		expect(Bun.stripANSI(rows.join("\n"))).not.toContain("Wait");
		expect(Bun.stripANSI(rows.join("\n"))).not.toContain("工具调用");
	});

	it("keeps running Bash output out of the single-line activity and restores it in detailed mode", () => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		const bash = tool("bash", { command: "bun test", i: "检查测试" });
		bash.setExecutionStarted();
		bash.updateResult({ content: [{ type: "text", text: "OUTPUT_FIRST\nOUTPUT_SECOND\nOUTPUT_THIRD" }] }, true);
		const rows = bash.renderCompactActivityRows(80);
		expect(rows).toHaveLength(1);
		expect(Bun.stripANSI(rows[0]!)).toContain("检查测试");
		expect(Bun.stripANSI(rows.join("\n"))).not.toContain("OUTPUT_");
		expect(JSON.stringify(bash.describe())).not.toContain("OUTPUT_");
		setChatTranscriptDisplayPreferences({ compactToolActivity: false });
		expect(Bun.stripANSI(bash.render(80).join("\n"))).toContain("OUTPUT_THIRD");
	});

	it("projects a single-file edit diff delivered through the write device transport", () => {
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
		const transcript = new TranscriptContainer();
		transcript.setCompactTurnActive(true);
		transcript.addChild(edit);
		expect(Bun.stripANSI(transcript.render(80).join("\n"))).toContain("new_value");
		expect(
			JSON.stringify(
				transcript.nativeBlocks().map(block =>
					block.describe?.({
						cols: 80,
						reduceMotion: false,
						dark: true,
						supports: () => true,
						feature: () => true,
					}),
				),
			),
		).toContain("sample.ts");
		expect(JSON.stringify(result)).toBe(original);
	});

	it("projects per-file apply_patch results through write while excluding device-help receipts", () => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		const patch = tool("write", { path: "xd://apply_patch", content: "{}" });
		const inner = {
			perFileResults: [
				{ path: "first.ts", diff: "@@ -1 +1 @@\n-first_old\n+first_new" },
				{ path: "second.ts", diff: "@@ -1 +1 @@\n-second_old\n+second_new" },
			],
		};
		patch.updateResult({ content: [], details: { xdev: { tool: "apply_patch", mode: "execute", inner } } });
		const transcript = new TranscriptContainer();
		transcript.setCompactTurnActive(true);
		transcript.addChild(patch);
		expect(Bun.stripANSI(transcript.render(80).join("\n"))).toMatch(/first_new[^]*second_new/);
		patch.updateResult({ content: [], details: { xdev: { tool: "apply_patch", mode: "help", inner } } });
		expect(Bun.stripANSI(transcript.render(80).join("\n"))).not.toContain("first_new");
	});

	it("hides historical launch receipts in compact mode while an explicit detailed viewer retains them", () => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		const message: CustomMessage = {
			role: "custom",
			customType: "launch-completion",
			content: "supervised process finished",
			display: true,
			timestamp: 1,
			details: { daemons: [{ name: "build-server", state: "exited", exitCode: 0 }] },
		};
		const compact = buildLaunchCompletionBlock(message);
		const detailed = buildLaunchCompletionBlock(message, false);
		expect(compact.render(80)).toEqual([]);
		expect(Bun.stripANSI(detailed.render(80).join("\n"))).toContain("build-server");
		const surface = "s:detailed-launch";
		const document = new TspDocument(surface);
		const reconciler = new Reconciler(surface);
		const ops = reconciler.reconcile(
			{ main: [detailed], dock: [], layer: [] },
			{ cols: 80, dark: true, reduceMotion: false, supports: () => false, feature: () => false },
		);
		expect(document.applyFrame({ sf: surface, s: 1, ops })).toEqual([]);
		expect(JSON.stringify(document.snapshot())).toContain("build-server");
	});
});
