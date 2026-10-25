import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { chatTranscriptDisplayPreferences, setChatTranscriptDisplayPreferences } from "../src/chat/display-preferences";
import { TranscriptContainer } from "../src/chrome/transcript-container";
import type { CompactToolCall } from "../src/chrome/tool-activity";
import { Text } from "../src/components/text";
import { text } from "../src/native/describe";
import { TspDocument } from "../src/native/apply";
import { Reconciler } from "../src/native/reconcile";
import { initTheme } from "../src/theme";
import type { Component } from "../src/tui";

const preferences = { ...chatTranscriptDisplayPreferences };
beforeAll(async () => { await initTheme(); });
afterEach(() => { setChatTranscriptDisplayPreferences(preferences); });

class Call implements Component {
	visible = true;
	failed = false;
	critical = false;
	actualWrite = false;
	write = false;
	finalized = true;
	constructor(readonly label: string) {}
	setToolActivityVisible(visible: boolean) { this.visible = visible; }
	isCompactToolActivity() { return true; }
	getCompactToolCalls(): readonly CompactToolCall[] { return [{ id: this, failed: this.failed }]; }
	hasCompactCriticalFeedback() { return this.critical || this.failed; }
	isCompactActualFileWrite() { return this.actualWrite; }
	isCompactWriteCall() { return this.write; }
	isTranscriptBlockFinalized() { return this.finalized; }
	render() { return this.visible ? [this.label] : []; }
	describe() { return text(this.label); }
}

function transcript(): TranscriptContainer {
	setChatTranscriptDisplayPreferences({ compactToolActivity: true, hideToolActivity: false });
	return new TranscriptContainer();
}
function add(root: TranscriptContainer, ...labels: string[]): Call[] {
	return labels.map(label => { const call = new Call(label); root.addChild(call); return call; });
}
function view(root: TranscriptContainer): string { return Bun.stripANSI(root.render(80).join("\n")); }
function native(root: TranscriptContainer): string {
	const document = new TspDocument("s:local");
	const ops = new Reconciler("s:local").reconcile({ main: root.nativeBlocks(), dock: [], layer: [] }, {
		cols: 80, reduceMotion: false, dark: true, supports: () => true, feature: () => true,
	});
	expect(document.applyFrame({ sf: "s:local", s: 1, ops })).toEqual([]);
	return JSON.stringify(document.snapshot());
}

describe("compact original-position continuous runs", () => {
	it.each([1, 2, 3, 6])("selects the last two of %s calls without running-state priority", count => {
		const root = transcript();
		for (let i = 0; i < count; i++) add(root, `CALL_${i}`)[0]!.finalized = false;
		const output = view(root);
		for (let i = 0; i < count; i++) expect(output.includes(`CALL_${i}`)).toBe(i >= count - 2);
		expect(output.includes("工具调用")).toBe(count > 2);
		if (count > 2) expect(output.indexOf("工具调用")).toBeLessThan(output.indexOf(`CALL_${count - 2}`));
	});

	it("keeps independent segment summaries and previews before their replies on both surfaces", () => {
		const root = transcript();
		add(root, "A_OLD", "A_TWO", "A_LAST");
		root.addChild(new Text("PROSE_BOUNDARY", 0, 0));
		add(root, "B_OLD", "B_TWO", "B_LAST");
		root.addChild(new Text("FINAL_REPLY", 0, 0));
		for (const output of [view(root), native(root), Bun.stripANSI(root.renderViewport(80, 40, { tick: 0, now: 0 }).join("\n"))]) {
			expect(output).not.toContain("A_OLD");
			expect(output).not.toContain("B_OLD");
			expect(output.match(/工具调用 3 次/g)).toHaveLength(2);
			const markers = ["A_TWO", "A_LAST", "PROSE_BOUNDARY", "B_TWO", "B_LAST", "FINAL_REPLY"];
			for (let i = 1; i < markers.length; i++) expect(output.indexOf(markers[i]!)).toBeGreaterThan(output.indexOf(markers[i - 1]!));
		}
	});

	it("ignores invisible blocks but respects visible thinking and user boundaries", () => {
		const root = transcript();
		add(root, "FIRST");
		root.addChild({ render: () => [] });
		add(root, "SECOND", "THIRD");
		root.addChild(new Text("VISIBLE_THINKING", 0, 0));
		add(root, "FOURTH");
		root.addChild(new Text("USER_MESSAGE", 0, 0));
		add(root, "FIFTH");
		const output = view(root);
		expect(output).not.toContain("FIRST");
		expect(output).toMatch(/SECOND[^]*THIRD[^]*VISIBLE_THINKING[^]*FOURTH[^]*USER_MESSAGE[^]*FIFTH/);
		expect(output.match(/工具调用/g)).toHaveLength(1);
	});

	it("keeps critical feedback in original order without consuming preview slots", () => {
		const root = transcript();
		const [failure, approval, input] = add(root, "RAW_FAILURE", "APPROVAL", "INPUT");
		failure!.failed = true;
		approval!.critical = true;
		input!.critical = true;
		add(root, "PREVIEW_ONE", "PREVIEW_TWO");
		for (const output of [view(root), native(root)]) {
			expect(output).toContain("工具调用 5 次 · 失败 1 次");
			expect(output).toMatch(/RAW_FAILURE[^]*APPROVAL[^]*INPUT[^]*PREVIEW_ONE[^]*PREVIEW_TWO/);
		}
	});

	it("retains three original cards per write run and pending writes break ordinary runs", () => {
		const root = transcript();
		add(root, "BEFORE_ONE", "BEFORE_TWO");
		const writes = add(root, "WRITE_OLD", "WRITE_A", "WRITE_B", "WRITE_C");
		for (const call of writes) { call.write = true; call.actualWrite = true; }
		add(root, "MIDDLE");
		const later = add(root, "LATER_A", "LATER_B");
		for (const call of later) { call.write = true; call.actualWrite = true; }
		const pending = add(root, "PENDING_WRITE")[0]!;
		pending.write = true;
		add(root, "AFTER_ONE", "AFTER_TWO");
		const output = view(root);
		expect(output).not.toContain("WRITE_OLD");
		expect(output).not.toContain("工具调用");
		expect(output).toMatch(/BEFORE_ONE[^]*BEFORE_TWO[^]*WRITE_A[^]*WRITE_B[^]*WRITE_C[^]*MIDDLE[^]*LATER_A[^]*LATER_B[^]*PENDING_WRITE[^]*AFTER_ONE[^]*AFTER_TWO/);
	});

	it("archives selected history through upstream retirement without changing older runs", () => {
		const root = transcript();
		add(root, "ARCHIVED_OLD", "ARCHIVED_A", "ARCHIVED_B");
		root.addChild(new Text("REPLY", 0, 0));
		const batch = root.peekFlushBatch(80)!;
		expect(Bun.stripANSI(batch.rows.join("\n"))).toContain("ARCHIVED_A");
		root.acknowledgeFinalizedBatch(batch.id);
		root.addChild(new Text("NEW_USER", 0, 0));
		add(root, "NEW_A", "NEW_B", "NEW_C", "NEW_D");
		const output = view(root);
		expect(output).toMatch(/ARCHIVED_A[^]*ARCHIVED_B[^]*REPLY[^]*NEW_USER[^]*NEW_C[^]*NEW_D/);
		expect(output).not.toContain("ARCHIVED_OLD");
		root.beginReplay();
		expect(Bun.stripANSI(root.peekReplayBatch(80)!.rows.join("\n"))).toContain("ARCHIVED_A");
	});

	it("uses upstream row ownership and bounded narrow viewport allocation", () => {
		const root = transcript();
		const calls = add(root, "OLD", "LAST_A", "LAST_B");
		const rows = root.renderViewport(12, 3, { tick: 0, now: 0 });
		expect(rows.length).toBeLessThanOrEqual(3);
		for (const span of root.getLastViewportSpans()) expect(calls).toContain(span.component as Call);
	});

	it("restores all original calls in detailed mode and hides them in clean mode", () => {
		const root = transcript();
		add(root, "FIRST", "SECOND", "THIRD");
		expect(view(root)).not.toContain("FIRST");
		setChatTranscriptDisplayPreferences({ compactToolActivity: false });
		expect(view(root)).toMatch(/FIRST[^]*SECOND[^]*THIRD/);
		expect(view(root)).not.toContain("工具调用");
		root.setToolActivityVisible(false);
		expect(view(root)).toBe("");
	});
});
