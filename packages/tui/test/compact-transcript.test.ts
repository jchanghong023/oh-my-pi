import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ImageContent } from "@oh-my-pi/pi-ai";
import { AssistantMessageComponent } from "../src/chat/assistant-message";
import { ChatTranscriptBuilder } from "../src/chat/chat-transcript-builder";
import { chatTranscriptDisplayPreferences, setChatTranscriptDisplayPreferences } from "../src/chat/display-preferences";
import type { CustomMessage } from "../src/chat/messages";
import { buildAsyncResultBlock } from "../src/chat/transcript-render-helpers";
import { ReadToolGroupComponent } from "../src/chat/read-tool-group";
import { stopSharedSpinnerTicker, ToolExecutionComponent } from "../src/chat/tool-execution";
import { Text } from "../src/components/text";
import { UserMessageComponent } from "../src/chat/user-message";
import { ThinkingPreviewComponent } from "../src/chat/thinking-preview";
import { TranscriptContainer } from "../src/chrome/transcript-container";
import { md } from "../src/native/describe";
import { TspDocument } from "../src/native/apply";
import { Reconciler } from "../src/native/reconcile";
import type { DescribeContext, NativeNode } from "../src/native/node";
import { COMPOSER_DEFAULTS, Composer } from "../src/prompt/composer";
import { initTheme } from "../src/theme";
import { Container } from "../src/tui";
import type { TUI } from "../src/tui";
import { setTerminalImageProtocol, TERMINAL } from "../src/terminal-capabilities";
import type { CoordinationDetails } from "../src/tools/wait";
import type { TodoPhase } from "../src/tools/todo";
import { withoutTerminalMultiplexer } from "./helpers/terminal-multiplexer";
import { VirtualRenderScheduler } from "./virtual-render-scheduler";
import { VirtualTerminal } from "./virtual-terminal";

withoutTerminalMultiplexer();

const toolCx: DescribeContext = {
	cols: 80,
	reduceMotion: false,
	dark: true,
	supports: kind => kind === "tool" || kind === "media",
	feature: () => true,
};
const components: Container[] = [];
const originalImageProtocol = TERMINAL.imageProtocol;
const image: ImageContent = {
	type: "image",
	data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
	mimeType: "image/png",
};

function assistant(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function nodes(root: NativeNode): NativeNode[] {
	const result = [root];
	for (const child of root.c ?? []) {
		if ("k" in child) result.push(...nodes(child));
	}
	return result;
}

/** Materialize component boundaries exactly as the native terminal receives them. */
function nativeTranscriptView(transcript: TranscriptContainer): string {
	const surface = "s:compact-transcript";
	const document = new TspDocument(surface);
	const activity = transcript.compactToolActivityBlock();
	const ops = new Reconciler(surface).reconcile(
		{ main: transcript.nativeBlocks(), dock: activity ? [activity] : [], layer: [] },
		toolCx,
	);
	expect(document.applyFrame({ sf: surface, s: 1, ops })).toEqual([]);
	return JSON.stringify(document.snapshot());
}

function asyncMessage(jobs: Record<string, unknown>[]): CustomMessage<{ jobs: Record<string, unknown>[] }> {
	return {
		role: "custom",
		customType: "async-result",
		content: "ORIGINAL_DELIVERY",
		display: true,
		details: { jobs },
		timestamp: 1,
	};
}

beforeAll(async () => {
	await initTheme();
});

afterEach(() => {
	for (const component of components.splice(0)) component.dispose();
	stopSharedSpinnerTicker();
	setChatTranscriptDisplayPreferences({ compactToolActivity: false, hideToolActivity: false });
	setTerminalImageProtocol(originalImageProtocol);
});

describe("compact transcript activity", () => {
	it("shows the muted summary only when total calls exceed visible ordinary call rows", () => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		const transcript = new TranscriptContainer();
		transcript.setCompactTurnActive(true);
		const addRead = (path: string, failed = false) => {
			const read = new ToolExecutionComponent("read", { path }, {}, undefined, {
				requestRender() {},
				requestComponentRender() {},
				resetDisplay() {},
			});
			components.push(read);
			read.updateResult({ content: [], isError: failed });
			transcript.addChild(read);
		};
		const rows = () => transcript.compactToolActivityBlock()?.render(100) ?? [];
		addRead("one.ts");
		expect(Bun.stripANSI(rows().join("\n"))).not.toContain("工具调用");
		addRead("two.ts");
		expect(rows()).toHaveLength(2);
		expect(Bun.stripANSI(rows().join("\n"))).not.toContain("工具调用");
		addRead("three.ts", true);
		expect(rows()).toHaveLength(3);
		expect(Bun.stripANSI(rows()[2]!)).toBe("工具调用 3 次 · 失败 1 次");
		expect(rows()[2]).toContain("\x1b[");
		const native = JSON.stringify(transcript.compactToolActivityBlock()?.describe?.(toolCx));
		expect(native).toContain('"t":"工具调用 3 次 · 失败 1 次","s":"dim"');
		expect(native).not.toContain('"t":"工具调用 3 次 · 失败 1 次","s":"strong"');
	});

	it("hides the summary when three executing calls are all visible", () => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		const transcript = new TranscriptContainer();
		transcript.setCompactTurnActive(true);
		for (let index = 0; index < 3; index++) {
			const bash = new ToolExecutionComponent("bash", { command: `RUNNING_${index}` }, {}, undefined, {
				requestRender() {},
				requestComponentRender() {},
				resetDisplay() {},
			});
			components.push(bash);
			bash.setExecutionStarted();
			transcript.addChild(bash);
		}
		const rows = transcript.compactToolActivityBlock()?.render(100).map(Bun.stripANSI) ?? [];
		expect(rows).toHaveLength(3);
		for (let index = 0; index < 3; index++) expect(rows[index]).toContain(`RUNNING_${index}`);
		expect(rows.join("\n")).not.toContain("工具调用");
	});
	it("keeps two latest calls plus a cumulative call and failure summary until the next task starts", () => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		const transcript = new TranscriptContainer();
		transcript.noteCompactUserTurnStart();
		transcript.setCompactTurnActive(true);
		for (const [index, failed] of [false, true, false].entries()) {
			const tool = new ToolExecutionComponent("read", { path: `task-${index}.ts` }, {}, undefined, {
				requestRender() {},
				requestComponentRender() {},
				resetDisplay() {},
			});
			components.push(tool);
			tool.updateResult({ content: [], isError: failed });
			transcript.addChild(tool);
		}
		const dock = () => transcript.compactToolActivityBlock()?.render(100).map(Bun.stripANSI) ?? [];
		expect(dock()).toHaveLength(3);
		expect(dock().join("\n")).not.toContain("task-0.ts");
		expect(dock().join("\n")).toMatch(/task-1\.ts[^]*task-2\.ts/);
		expect(dock()[2]).toMatch(/3.*1/);
		transcript.setCompactTurnActive(false);
		expect(dock()).toHaveLength(3);
		transcript.noteCompactUserTurnStart();
		transcript.setCompactTurnActive(true);
		expect(dock()).toEqual([]);
	});

	it("counts each grouped read call, including pending and failed calls", () => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		const transcript = new TranscriptContainer();
		transcript.noteCompactUserTurnStart();
		transcript.setCompactTurnActive(true);
		const group = new ReadToolGroupComponent();
		components.push(group);
		transcript.addChild(group);
		group.updateArgs({ path: "first.ts" }, "first");
		group.updateResult({ content: [], isError: true }, false, "first");
		group.updateArgs({ path: "second.ts" }, "second");
		group.updateArgs({ path: "third.ts" }, "third");
		const rows = transcript.compactToolActivityBlock()?.render(100).map(Bun.stripANSI) ?? [];
		expect(rows).toHaveLength(3);
		expect(rows[0]).toContain("second.ts");
		expect(rows[1]).toContain("third.ts");
		expect(rows[2]).toMatch(/3.*1/);
	});

	it("preserves call ownership and totals across compaction without counting replay twice", () => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		const transcript = new TranscriptContainer();
		transcript.noteCompactUserTurnStart();
		transcript.setCompactTurnActive(true);
		const group = new ReadToolGroupComponent();
		components.push(group);
		for (const id of ["one", "two", "three"]) {
			group.updateArgs({ path: `${id}.ts` }, id);
			group.updateResult({ content: [], isError: id === "one" }, false, id);
		}
		transcript.addChild(group);
		transcript.noteCompactUserTurnStart(); // An interjection is still the same activity.
		const state = transcript.snapshotCompactTurn();
		transcript.clear();
		const replay = new ReadToolGroupComponent();
		components.push(replay);
		replay.updateArgs({ path: "three.ts" }, "three");
		replay.updateResult({ content: [] }, false, "three");
		transcript.addChild(replay);
		transcript.restoreCompactTurn(state);
		const next = new ReadToolGroupComponent();
		components.push(next);
		next.updateArgs({ path: "four.ts" }, "four");
		next.updateResult({ content: [] }, false, "four");
		transcript.addChild(next);
		const dock = () => (transcript.compactToolActivityBlock()?.render(100) ?? []).map(Bun.stripANSI).join("\n");
		expect(dock()).toContain("工具调用 4 次 · 失败 1 次");
		transcript.setCompactTurnActive(false);
		transcript.noteCompactUserTurnStart();
		transcript.setCompactTurnActive(true);
		expect(dock()).toBe("");
	});

	it("keeps a late background failure in its original turn after a transcript rebuild", () => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		const transcript = new TranscriptContainer();
		transcript.noteCompactUserTurnStart();
		transcript.setCompactTurnActive(true);
		const bash = new ToolExecutionComponent(
			"bash",
			{ command: "OLD_BACKGROUND" },
			{},
			undefined,
			{
				requestRender() {},
				requestComponentRender() {},
				resetDisplay() {},
			},
			undefined,
			"old-background",
		);
		components.push(bash);
		bash.setExecutionStarted();
		bash.updateResult({ content: [], details: { async: { state: "running" } } }, true);
		bash.parkAsBackground();
		transcript.addChild(bash);
		transcript.setCompactTurnActive(false);
		transcript.noteCompactUserTurnStart();
		transcript.setCompactTurnActive(true);
		const state = transcript.snapshotCompactTurn();
		transcript.clear();
		transcript.addChild(bash);
		transcript.restoreCompactTurn(state);
		const group = new ReadToolGroupComponent();
		components.push(group);
		for (const id of ["new-one", "new-two", "new-three"]) {
			group.updateArgs({ path: `${id}.ts` }, id);
			group.updateResult({ content: [] }, false, id);
		}
		transcript.addChild(group);
		bash.updateResult(
			{ content: [{ type: "text", text: "OLD_FAILURE" }], isError: true, details: { async: { state: "failed" } } },
			false,
		);
		const rows = (transcript.compactToolActivityBlock()?.render(100) ?? []).map(Bun.stripANSI).join("\n");
		expect(rows).toContain("工具调用 3 次 · 失败 0 次");
		expect(rows).not.toContain("OLD_");
		expect(Bun.stripANSI(transcript.render(100).join("\n"))).not.toContain("OLD_FAILURE");
	});

	it("does not show a summary when a grouped read's two calls are both visible", () => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		const transcript = new TranscriptContainer();
		transcript.setCompactTurnActive(true);
		const group = new ReadToolGroupComponent();
		components.push(group);
		transcript.addChild(group);
		group.updateArgs({ path: "group-one.ts" }, "one");
		group.updateResult({ content: [] }, false, "one");
		group.updateArgs({ path: "group-two.ts" }, "two");
		group.updateResult({ content: [] }, false, "two");
		const rows = transcript.compactToolActivityBlock()?.render(100).map(Bun.stripANSI) ?? [];
		expect(rows).toHaveLength(2);
		expect(rows[0]).toContain("group-one.ts");
		expect(rows[1]).toContain("group-two.ts");
		expect(rows.join("\n")).not.toContain("工具调用");
		const native = JSON.stringify(transcript.compactToolActivityBlock()?.describe?.(toolCx));
		expect(native).not.toContain("工具调用");
	});

	it("folds review prompt diffs as user prose without consuming the three actual writes", () => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: true, hideToolActivity: false });
		const transcript = new TranscriptContainer();
		transcript.noteCompactUserTurnStart();
		transcript.setCompactTurnActive(true);
		transcript.addChild(
			new UserMessageComponent(
				"Review the following diff:\n```diff\n" +
					Array.from({ length: 20 }, (_, i) => `+REVIEW_LINE_${i}`).join("\n") +
					"\n```",
			),
		);
		for (let index = 0; index < 3; index++) {
			const edit = new ToolExecutionComponent("edit", { path: `actual-${index}.ts` }, {}, undefined, {
				requestRender() {},
				requestComponentRender() {},
				resetDisplay() {},
			});
			components.push(edit);
			edit.updateResult({ content: [], details: { diff: `@@ -1 +1 @@\n-old\n+ACTUAL_WRITE_${index}` } });
			transcript.addChild(edit);
		}
		for (const active of [true, false]) {
			transcript.setCompactTurnActive(active);
			const rows = Bun.stripANSI(transcript.render(100).join("\n"));
			expect(rows).toContain("已折叠");
			expect(rows).not.toContain("REVIEW_LINE_19");
			for (let index = 0; index < 3; index++) expect(rows).toContain(`actual-${index}.ts`);
		}
		transcript.noteCompactUserTurnStart();
		transcript.setCompactTurnActive(true);
		const history = Bun.stripANSI(transcript.render(100).join("\n"));
		expect(history).toContain("已折叠");
		expect(history).not.toContain("REVIEW_LINE_19");
	});

	it("keeps the original diffs for the latest three actual file-write calls", () => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		const transcript = new TranscriptContainer();
		transcript.noteCompactUserTurnStart();
		transcript.setCompactTurnActive(true);
		for (let index = 0; index < 4; index++) {
			const edit = new ToolExecutionComponent("edit", { path: `write-${index}.ts` }, {}, undefined, {
				requestRender() {},
				requestComponentRender() {},
				resetDisplay() {},
			});
			components.push(edit);
			edit.updateResult({
				content: [],
				details: {
					perFileResults: [0, 1].map(file => ({
						path: `file-${index}-${file}.ts`,
						diff: `-old\n+WRITE_DIFF_${index}_${file}`,
					})),
				},
			});
			transcript.addChild(edit);
		}
		const ignoredDevice = new ToolExecutionComponent(
			"write",
			{ path: "xd://lsp", content: "lookup" },
			{},
			undefined,
			{
				requestRender() {},
				requestComponentRender() {},
				resetDisplay() {},
			},
		);
		components.push(ignoredDevice);
		ignoredDevice.updateResult({ content: [], details: { xdev: { tool: "lsp", mode: "execute" } } });
		transcript.addChild(ignoredDevice);
		const view = Bun.stripANSI(transcript.render(100).join("\n"));
		expect(view).not.toContain("WRITE_DIFF_0_");
		for (let index = 1; index < 3; index++) {
			expect(view).toContain(`file-${index}-0.ts`);
			for (let file = 0; file < 2; file++) expect(view).toContain(`WRITE_DIFF_${index}_${file}`);
		}
		for (let file = 0; file < 2; file++) expect(view).toContain(`WRITE_DIFF_3_${file}`);
	});

	it("does not repeat a successful file write in the ordinary two-call dock", () => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		const transcript = new TranscriptContainer();
		transcript.setCompactTurnActive(true);
		for (const path of ["first-read.ts", "second-read.ts"]) {
			const read = new ToolExecutionComponent("read", { path }, {}, undefined, {
				requestRender() {},
				requestComponentRender() {},
				resetDisplay() {},
			});
			components.push(read);
			read.updateResult({ content: [] });
			transcript.addChild(read);
		}
		const edit = new ToolExecutionComponent("edit", { path: "edited.ts" }, {}, undefined, {
			requestRender() {},
			requestComponentRender() {},
			resetDisplay() {},
		});
		components.push(edit);
		edit.updateResult({ content: [], details: { path: "edited.ts", diff: "-old\n+ACTUAL_EDIT_DIFF" } });
		transcript.addChild(edit);
		const rows = transcript.compactToolActivityBlock()?.render(100).map(Bun.stripANSI) ?? [];
		expect(rows).toHaveLength(3);
		expect(rows[0]).toContain("first-read.ts");
		expect(rows[1]).toContain("second-read.ts");
		expect(rows.slice(0, 2).join("\n")).not.toContain("edited.ts");
		expect(rows[2]).toMatch(/3.*0/);
		expect(Bun.stripANSI(transcript.render(100).join("\n"))).toContain("ACTUAL_EDIT_DIFF");
	});

	it("expands only the newest of three successful edit cards and keeps older diffs available", () => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		const transcript = new TranscriptContainer();
		transcript.setCompactTurnActive(true);
		const edits: ToolExecutionComponent[] = [];
		for (let index = 0; index < 3; index++) {
			const edit = new ToolExecutionComponent("edit", { path: `edited-${index}.ts` }, {}, undefined, {
				requestRender() {},
				requestComponentRender() {},
				resetDisplay() {},
			});
			components.push(edit);
			edit.updateResult({
				content: [],
				details: { path: `edited-${index}.ts`, diff: `-old\n+WRITE_DIFF_${index}` },
			});
			transcript.addChild(edit);
			edits.push(edit);
		}
		const cards = () =>
			transcript
				.nativeBlocks()
				.map(block => block.describe?.(toolCx))
				.filter(node => node?.k === "card");
		expect(cards().map(node => node?.p?.collapsed)).toEqual([true, true, false]);
		const view = () => Bun.stripANSI(transcript.render(100).join("\n"));
		expect(view()).toContain("WRITE_DIFF_0");
		expect(view()).toContain("WRITE_DIFF_1");
		expect(view()).toContain("WRITE_DIFF_2");
		edits[0]!.setExpanded(true);
		expect(cards().map(node => node?.p?.collapsed)).toEqual([false, true, false]);
	});

	it("uses the upstream collapsed edit preview and expand hint for older writes", () => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		const transcript = new TranscriptContainer();
		transcript.setCompactTurnActive(true);
		const first = new ToolExecutionComponent("edit", { path: "older.ts" }, {}, undefined, {
			requestRender() {},
			requestComponentRender() {},
			resetDisplay() {},
		});
		components.push(first);
		first.updateResult({
			content: [],
			details: {
				path: "older.ts",
				diff: Array.from({ length: 50 }, (_, index) => `+PREVIEW_LINE_${index}`).join("\n"),
			},
		});
		transcript.addChild(first);
		const latest = new ToolExecutionComponent("edit", { path: "latest.ts" }, {}, undefined, {
			requestRender() {},
			requestComponentRender() {},
			resetDisplay() {},
		});
		components.push(latest);
		latest.updateResult({ content: [], details: { path: "latest.ts", diff: "-old\n+new" } });
		transcript.addChild(latest);
		const foldedOriginal = first.renderOriginalFileWriteRows(80);
		const projected = transcript.nativeBlocks()[0]!;
		expect(foldedOriginal.length).toBeGreaterThan(1);
		expect(projected.render(80)).toEqual(foldedOriginal);
		first.setExpanded(true);
		const expandedOriginal = first.renderOriginalFileWriteRows(80);
		expect(projected.render(80)).toEqual(expandedOriginal);
	});

	it("keeps an older write collapsed with the upstream six-line preview", () => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		const transcript = new TranscriptContainer();
		transcript.setCompactTurnActive(true);
		const older = new ToolExecutionComponent(
			"write",
			{ path: "older.txt", content: Array.from({ length: 12 }, (_, index) => `WRITE_LINE_${index}`).join("\n") },
			{},
			undefined,
			{ requestRender() {}, requestComponentRender() {}, resetDisplay() {} },
		);
		components.push(older);
		older.updateResult({ content: [] });
		transcript.addChild(older);
		const latest = new ToolExecutionComponent("edit", { path: "latest.txt" }, {}, undefined, {
			requestRender() {},
			requestComponentRender() {},
			resetDisplay() {},
		});
		components.push(latest);
		latest.updateResult({ content: [], details: { path: "latest.txt", diff: "-old\n+new" } });
		transcript.addChild(latest);
		const projected = transcript.nativeBlocks()[0]!;
		expect(projected.render(80)).toEqual(older.renderOriginalFileWriteRows(80));
		const card = projected.describe?.(toolCx);
		if (card?.k !== "card") throw new Error("expected upstream write card");
		expect(card.p?.collapsed).toBe(true);
		const folded = Bun.stripANSI(projected.render(80).join("\n"));
		expect(folded).toContain("WRITE_LINE_5");
		expect(folded).not.toContain("WRITE_LINE_6");
		expect(folded).toContain("Ctrl+O: Expand");
	});

	it("counts an applied patch as a write but excludes failed edits and device previews", () => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		const transcript = new TranscriptContainer();
		transcript.setCompactTurnActive(true);
		const add = (name: string, path: string, result: { content: []; details?: unknown; isError?: boolean }) => {
			const component = new ToolExecutionComponent(name, { path }, {}, undefined, {
				requestRender() {},
				requestComponentRender() {},
				resetDisplay() {},
			});
			components.push(component);
			component.updateResult(result);
			transcript.addChild(component);
			return component;
		};
		add("apply_patch", "applied.ts", { content: [], details: { path: "applied.ts", diff: "-old\n+APPLIED_PATCH" } });
		add("edit", "failed.ts", {
			content: [],
			isError: true,
			details: { path: "failed.ts", diff: "-old\n+FAILED_EDIT" },
		});
		add("write", "xd://edit", { content: [], details: { xdev: { tool: "edit", mode: "help" } } });
		const cards = transcript
			.nativeBlocks()
			.map(block => block.describe?.(toolCx))
			.filter(node => node?.k === "card");
		expect(cards).toHaveLength(1);
		expect(Bun.stripANSI(transcript.render(100).join("\n"))).toContain("APPLIED_PATCH");
		expect(Bun.stripANSI(transcript.render(100).join("\n"))).not.toContain("FAILED_EDIT");
	});

	it("puts executing calls ahead of newer settled calls, showing every call when more than two run", () => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		const transcript = new TranscriptContainer();
		transcript.setCompactTurnActive(true);
		const makeBash = (command: string, running: boolean) => {
			const bash = new ToolExecutionComponent("bash", { command }, {}, undefined, {
				requestRender() {},
				requestComponentRender() {},
				resetDisplay() {},
			});
			components.push(bash);
			if (running) bash.setExecutionStarted();
			else bash.updateResult({ content: [] });
			transcript.addChild(bash);
			return bash;
		};
		makeBash("RUNNING_OLD", true);
		makeBash("DONE_MIDDLE", false);
		makeBash("DONE_LATEST", false);
		const rows = () => transcript.compactToolActivityBlock()?.render(100).map(Bun.stripANSI) ?? [];
		expect(rows().slice(0, -1).join("\n")).toContain("RUNNING_OLD");
		expect(rows().slice(0, -1).join("\n")).toContain("DONE_LATEST");
		expect(rows().slice(0, -1).join("\n")).not.toContain("DONE_MIDDLE");
		makeBash("RUNNING_NEW_1", true);
		makeBash("RUNNING_NEW_2", true);
		const activeRows = rows().slice(0, -1).join("\n");
		for (const command of ["RUNNING_OLD", "RUNNING_NEW_1", "RUNNING_NEW_2"]) expect(activeRows).toContain(command);
		expect(activeRows).not.toContain("DONE_");
		expect(rows().at(-1)).toMatch(/5.*0/);
	});

	it("keeps a previous task's running background Bash visible without counting it in the new task", () => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		const transcript = new TranscriptContainer();
		transcript.setCompactTurnActive(true);
		const background = new ToolExecutionComponent("bash", { command: "BACKGROUND_OLD" }, {}, undefined, {
			requestRender() {},
			requestComponentRender() {},
			resetDisplay() {},
		});
		components.push(background);
		background.setExecutionStarted();
		background.updateResult({ content: [], details: { async: { state: "running" } } }, true);
		background.parkAsBackground();
		transcript.addChild(background);
		transcript.setCompactTurnActive(false);
		transcript.noteCompactUserTurnStart();
		transcript.setCompactTurnActive(true);
		for (const path of ["new-a.ts", "new-b.ts"]) {
			const read = new ToolExecutionComponent("read", { path }, {}, undefined, {
				requestRender() {},
				requestComponentRender() {},
				resetDisplay() {},
			});
			components.push(read);
			read.updateResult({ content: [] });
			transcript.addChild(read);
		}
		const rows = () => transcript.compactToolActivityBlock()?.render(100).map(Bun.stripANSI) ?? [];
		expect(rows().join("\n")).toContain("BACKGROUND_OLD");
		expect(rows().join("\n")).not.toContain("工具调用");
		const failed = new ToolExecutionComponent("read", { path: "new-failed.ts" }, {}, undefined, {
			requestRender() {},
			requestComponentRender() {},
			resetDisplay() {},
		});
		components.push(failed);
		failed.updateResult({ content: [], isError: true });
		transcript.addChild(failed);
		expect(rows().join("\n")).toContain("BACKGROUND_OLD");
		expect(rows().at(-1)).toMatch(/3.*1/);
		background.updateResult({ content: [], details: { async: { state: "completed" } } });
		expect(rows().join("\n")).not.toContain("BACKGROUND_OLD");
	});

	it("prioritizes executing calls inside a grouped read component", () => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		const transcript = new TranscriptContainer();
		transcript.setCompactTurnActive(true);
		const group = new ReadToolGroupComponent();
		components.push(group);
		transcript.addChild(group);
		group.updateArgs({ path: "pending-group.ts" }, "pending");
		group.setExecutionStarted("pending");
		group.updateArgs({ path: "done-group.ts" }, "done");
		group.updateResult({ content: [] }, false, "done");
		for (const path of ["new-a.ts", "new-b.ts"]) {
			const read = new ToolExecutionComponent("read", { path }, {}, undefined, {
				requestRender() {},
				requestComponentRender() {},
				resetDisplay() {},
			});
			components.push(read);
			read.updateResult({ content: [] });
			transcript.addChild(read);
		}
		const rows = transcript.compactToolActivityBlock()?.render(100).map(Bun.stripANSI) ?? [];
		expect(rows.slice(0, -1).join("\n")).toContain("pending-group.ts");
		expect(rows.slice(0, -1).join("\n")).toContain("new-b.ts");
		expect(rows.at(-1)).toMatch(/4.*0/);
	});

	it("reveals the complete Bash command from its folded single-row activity", () => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		const transcript = new TranscriptContainer();
		transcript.setCompactTurnActive(true);
		const command = `bun test ${"argument ".repeat(18)}`;
		const bash = new ToolExecutionComponent("bash", { command }, {}, undefined, {
			requestRender() {},
			requestComponentRender() {},
			resetDisplay() {},
		});
		components.push(bash);
		transcript.addChild(bash);
		expect(Bun.stripANSI(transcript.render(45).join("\n"))).not.toContain(command);
		bash.setExpanded(true);
		expect(Bun.stripANSI(transcript.render(45).join("\n")).replace(/\s+/g, " ")).toContain(command.trim());
	});
	it("preserves native failure colors in the call-and-summary dock", () => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		const transcript = new TranscriptContainer();
		transcript.setCompactTurnActive(true);
		const failed = new ToolExecutionComponent("bash", { command: "false" }, {}, undefined, {
			requestRender() {},
			requestComponentRender() {},
			resetDisplay() {},
		});
		components.push(failed);
		failed.updateResult({ content: [{ type: "text", text: "failure" }], isError: true });
		transcript.addChild(failed);
		const dock = transcript.compactToolActivityBlock();
		expect(dock?.render(80)).toHaveLength(3);
		const snapshot = JSON.stringify(dock?.describe?.(toolCx));
		expect(snapshot).toContain('"s":"error"');
		expect(snapshot).toContain('"s":"dim"');
	});

	it.each([12, 8])("keeps tools and editable input ahead of thinking on a %s-row screen", async height => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		const terminal = new VirtualTerminal(60, height);
		const scheduler = new VirtualRenderScheduler();
		const composer = new Composer({
			terminal,
			tuiOptions: { renderScheduler: scheduler },
			preferences: { ...COMPOSER_DEFAULTS, quiet: true },
		});
		const transcript = new TranscriptContainer();
		transcript.setCompactTurnActive(true);
		transcript.addChild(new Text("ANSWER_1\nANSWER_2\nANSWER_3\nANSWER_4", 0, 0));
		for (const path of ["FIRST_TOOL.ts", "LAST_TOOL.ts"]) {
			const tool = new ToolExecutionComponent("read", { path }, {}, undefined, {
				requestRender() {},
				requestComponentRender() {},
				resetDisplay() {},
			});
			components.push(tool);
			transcript.addChild(tool);
		}
		const thinking = new ThinkingPreviewComponent();
		thinking.setText("THINK_1\nTHINK_2");
		const editor = new Text("INPUT_TOP\nEDITABLE_INPUT\nINPUT_BOTTOM", 0, 0);
		composer.setRuntimeChildren([transcript, thinking, editor], { selfClearingChrome: [thinking] });
		composer.start({ playWelcomeIntro: false });
		try {
			await scheduler.settle(terminal);
			const view = terminal.getViewport().map(Bun.stripANSI).join("\n");
			expect(view).toContain("FIRST_TOOL.ts");
			expect(view).toContain("LAST_TOOL.ts");
			expect(view).toContain("EDITABLE_INPUT");
			expect(view).toContain("ANSWER_4");
			if (height === 8) expect(view).not.toContain("THINK_");
		} finally {
			composer.stop();
		}
	});

	it("shortens the newest long diff from its file header while reserving prose space", () => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		const transcript = new TranscriptContainer();
		transcript.setCompactTurnActive(true);
		transcript.addChild(new Text(Array.from({ length: 12 }, (_, i) => `ANSWER_${i}`).join("\n"), 0, 0));
		const edit = new ToolExecutionComponent("edit", { path: "latest.ts" }, {}, undefined, {
			requestRender() {},
			requestComponentRender() {},
			resetDisplay() {},
		});
		components.push(edit);
		edit.updateResult({
			content: [],
			details: { path: "latest.ts", diff: Array.from({ length: 30 }, (_, i) => `+${i + 1} DIFF_${i}`).join("\n") },
		});
		transcript.addChild(edit);
		const view = transcript.renderViewport(80, 18, { tick: 0, now: 0 }).map(Bun.stripANSI);
		expect(view.filter(line => line.startsWith("ANSWER_")).length).toBeGreaterThanOrEqual(8);
		expect(view.join("\n")).toContain("latest.ts");
		expect(view.join("\n")).toContain("DIFF_0");
		expect(view.join("\n")).toContain("… /display detailed");
		expect(view.join("\n")).not.toContain("DIFF_29");
	});

	it("pins the latest two ordinary calls and summary below prose", () => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		const transcript = new TranscriptContainer();
		transcript.setCompactTurnActive(true);
		const makeTool = (name: string, args: Record<string, unknown>) => {
			const tool = new ToolExecutionComponent(name, args, {}, undefined, {
				requestRender() {},
				requestComponentRender() {},
				resetDisplay() {
					throw new Error("compact activity must not replay shell history");
				},
			});
			components.push(tool);
			transcript.addChild(tool);
			return tool;
		};
		const viewport = () => transcript.renderViewport(100, 12, { tick: 0, now: 0 }).map(Bun.stripANSI);
		const first = makeTool("read", { path: "first.ts" });
		expect(viewport()).toHaveLength(2);
		expect(viewport()[0]).toContain("first.ts");
		expect(viewport()[1]).toBe("");
		transcript.addChild(new Text("PROSE_AFTER_CALL", 0, 0));
		const second = makeTool("read", { path: "second.ts" });
		expect(viewport().slice(-3).join("\n")).toMatch(/first\.ts[^]*second\.ts/);
		first.updateResult({ content: [{ type: "text", text: "PRIVATE_FAILURE" }], isError: true });
		expect(viewport().slice(-3).join("\n")).toMatch(/first\.ts[^]*second\.ts/);
		const third = makeTool("read", { path: "third.ts" });
		third.updateResult({ content: [{ type: "text", text: "PRIVATE_OUTPUT" }] });
		const view = viewport().join("\n");
		expect(viewport().slice(-3).join("\n")).toMatch(/second\.ts[^]*third\.ts/);
		expect(view).not.toContain("first.ts");
		expect(view).not.toContain("PRIVATE_");
		expect(view).toContain("工具调用 3 次 · 失败 1 次");
		expect(view.indexOf("PROSE_AFTER_CALL")).toBeLessThan(view.indexOf("second.ts"));
		transcript.setCompactTurnActive(true);
		expect(viewport().slice(-3).join("\n")).toMatch(/second\.ts[^]*third\.ts/);
		const short = Bun.stripANSI(transcript.renderViewport(100, 2, { tick: 0, now: 0 }).join("\n"));
		expect(short).toContain("PROSE_AFTER_CALL");
		expect(short).not.toContain("second.ts");
		expect(short).not.toContain("third.ts");
		transcript.setCompactTurnActive(false);
		expect(viewport().join("\n")).toContain("third.ts");
		transcript.noteCompactUserTurnStart();
		expect(viewport().join("\n").trimEnd()).toBe("PROSE_AFTER_CALL");
		setChatTranscriptDisplayPreferences({ compactToolActivity: false });
		expect(transcript.render(100).join("\n")).toContain("PRIVATE_OUTPUT");
		expect(second).toBeDefined();
	});

	it("counts grouped pending and failed reads individually and suppresses ended tools after restoration", () => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		const transcript = new TranscriptContainer();
		const group = new ReadToolGroupComponent();
		components.push(group);
		transcript.setCompactTurnActive(true);
		transcript.addChild(group);
		group.updateArgs({ path: "group-first.ts" }, "one");
		expect(transcript.renderViewport(100, 10, { tick: 0, now: 0 })).toHaveLength(2);
		group.updateArgs({ path: "group-second.ts" }, "two");
		group.updateResult({ content: [], isError: true }, false, "two");
		group.updateArgs({ path: "group-third.ts" }, "three");
		const view = Bun.stripANSI(transcript.renderViewport(100, 10, { tick: 0, now: 0 }).join("\n"));
		expect(view).toMatch(/group-second\.ts[^]*group-third\.ts/);
		expect(view).not.toContain("group-first.ts");
		transcript.setCompactTurnActive(false);
		expect(transcript.renderViewport(100, 10, { tick: 0, now: 0 }).join("\n")).toContain("group-third.ts");
		transcript.noteCompactUserTurnStart();
		expect(transcript.renderViewport(100, 10, { tick: 0, now: 0 })).toEqual([]);
		const restored = new TranscriptContainer();
		restored.addChild(group);
		expect(Bun.stripANSI(restored.render(100).join("\n"))).not.toContain("group-");
	});

	it("keeps parked background work live while idle and respects instance-local explicit details", () => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		const transcript = new TranscriptContainer();
		const job = new ToolExecutionComponent("task", { i: "Background analysis" }, {}, undefined, {
			requestRender() {},
			requestComponentRender() {},
			resetDisplay() {},
		});
		components.push(job);
		job.updateResult({ content: [], details: { async: { state: "running" } } });
		job.parkAsBackground();
		transcript.addChild(job);
		expect(Bun.stripANSI(transcript.render(100).join("\n"))).toContain("Background analysis");
		job.updateResult({ content: [], details: { async: { state: "completed" } } });
		expect(transcript.render(100)).toEqual([]);
		const detailed = new ToolExecutionComponent(
			"write",
			{ path: "detail.ts", content: "EXPLICIT_FULL_BODY" },
			{ compactToolActivity: false },
			undefined,
			{ requestRender() {}, requestComponentRender() {}, resetDisplay() {} },
		);
		components.push(detailed);
		transcript.addChild(detailed);
		expect(transcript.render(100).join("\n")).toContain("EXPLICIT_FULL_BODY");
		expect(nativeTranscriptView(transcript)).toContain("EXPLICIT_FULL_BODY");
	});

	it("hides standalone delivery receipts while retaining independent warnings and detailed originals", () => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		const message = asyncMessage([
			{ jobId: "standalone-a", type: "task", status: "completed" },
			{ jobId: "standalone-b", type: "bash", status: "completed" },
			{ jobId: "standalone-a", type: "task", status: "completed" },
			{ jobId: "untrusted-state", type: "task", label: "completed" },
			{ jobId: "standalone-a", type: "task", status: "completed", meta: { artifactError: "write" } },
			{ jobId: "standalone-b", type: "bash", status: "completed" },
		]);
		const original = JSON.stringify(message);
		const block = buildAsyncResultBlock(message);
		const surface = "s:standalone-delivery";
		const document = new TspDocument(surface);
		const reconciler = new Reconciler(surface);
		let sequence = 0;
		const nativeView = () => {
			const ops = reconciler.reconcile({ main: [block], dock: [], layer: [] }, toolCx);
			expect(document.applyFrame({ sf: surface, s: ++sequence, ops })).toEqual([]);
			expect(reconciler.fallbackCount).toBe(0);
			return JSON.stringify(document.snapshot());
		};
		for (const view of [Bun.stripANSI(block.render(160).join("\n")), nativeView()]) {
			expect(view).not.toContain("后台任务已完成");
			expect(view).not.toContain("Background job");
			expect(view).not.toContain("untrusted-state");
			expect(view).not.toContain("standalone-a");
			expect(view).not.toContain("standalone-b");
			expect(view.match(/artifact write failed/g)).toHaveLength(1);
		}
		expect(nativeView()).toContain("omp.status-block");
		setChatTranscriptDisplayPreferences({ compactToolActivity: false });
		for (const view of [Bun.stripANSI(block.render(160).join("\n")), nativeView()]) {
			expect(view.match(/Background job completed/g)).toHaveLength(6);
			expect(view.match(/standalone-a/g)).toHaveLength(3);
			expect(view.match(/standalone-b/g)).toHaveLength(2);
			expect(view).toMatch(/untrusted-state[^]*standalone-a[^]*artifact write failed[^]*standalone-b/);
			expect(view).not.toContain("后台任务已完成");
		}
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		expect(nativeView()).not.toContain("Background job completed");
		expect(JSON.stringify(message)).toBe(original);
	});

	it("keeps background delivery receipts out of the live dock and historical transcript", () => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		const transcript = new TranscriptContainer();
		transcript.setCompactTurnActive(true);
		const messages: CustomMessage<{ jobs: Record<string, unknown>[] }>[] = [];
		for (let index = 0; index < 5; index++) {
			const tool = new ToolExecutionComponent("read", { path: `continuous-${index}.ts` }, {}, undefined, {
				requestRender() {},
				requestComponentRender() {},
				resetDisplay() {},
			});
			components.push(tool);
			tool.updateResult({ content: [{ type: "text", text: "PRIVATE_SUCCESS" }] });
			transcript.addChild(tool);
			const message = asyncMessage([
				{
					jobId: index === 1 ? "execution-0" : `execution-${index}`,
					type: index % 2 ? "bash" : "task",
					status: "completed",
					label: "same name",
				},
			]);
			messages.push(message);
			transcript.addChild(buildAsyncResultBlock(message));
			if (index === 0) transcript.render(120);
		}
		const originals = JSON.stringify(messages);
		for (const view of [Bun.stripANSI(transcript.render(120).join("\n")), nativeTranscriptView(transcript)]) {
			expect(view).not.toContain("后台任务已完成");
			expect(view).not.toContain("已收起");
			expect(view).toContain("continuous-3.ts");
			expect(view).toContain("continuous-4.ts");
			expect(view).not.toContain("continuous-0.ts");
			expect(view).not.toContain("execution-");
		}
		setChatTranscriptDisplayPreferences({ compactToolActivity: false });
		for (const view of [transcript.render(120).join("\n"), nativeTranscriptView(transcript)]) {
			expect(view.match(/Background job completed/g)).toHaveLength(5);
			expect(view).toContain("execution-0");
			expect(view).toContain("continuous-0.ts");
		}
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		expect(Bun.stripANSI(transcript.render(120).join("\n"))).not.toContain("后台任务已完成");
		expect(JSON.stringify(messages)).toBe(originals);
	});

	it("hides all historical tool delivery states while preserving independent diagnostics in order", () => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		const transcript = new TranscriptContainer();
		const first = asyncMessage([
			{ jobId: "before-a", type: "task", status: "completed" },
			{ jobId: "before-b", type: "bash", status: "completed" },
			{ jobId: "failed-id", type: "task", status: "failed" },
			{ jobId: "cancelled-id", type: "bash", status: "cancelled" },
			{ jobId: "unknown-status", type: "task" },
			{ type: "task", status: "completed" },
			{ jobId: "unknown-type", status: "completed" },
			{ jobId: "running-id", type: "task", status: "running" },
			{ jobId: "artifact-id", type: "bash", status: "completed", meta: { artifactError: "write" } },
			{
				jobId: "schema-id",
				type: "task",
				status: "completed",
				schema: { source: "caller", mode: "permissive", status: "invalid", error: "SCHEMA_DIAGNOSTIC" },
			},
			{ jobId: "after-a", type: "task", status: "completed" },
		]);
		transcript.addChild(buildAsyncResultBlock(first));
		transcript.addChild(
			buildAsyncResultBlock(asyncMessage([{ jobId: "after-b", type: "bash", status: "completed" }])),
		);
		transcript.addChild(new Text("ASSISTANT_BOUNDARY", 0, 0));
		transcript.addChild(
			buildAsyncResultBlock(asyncMessage([{ jobId: "after-prose", type: "task", status: "completed" }])),
		);
		for (const view of [Bun.stripANSI(transcript.render(180).join("\n")), nativeTranscriptView(transcript)]) {
			expect(view).not.toContain("后台任务");
			expect(view).not.toContain("Background job");
			for (const id of [
				"cancelled-id",
				"unknown-status",
				"unknown-type",
				"running-id",
				"failed-id",
				"after-prose",
			]) {
				expect(view).not.toContain(id);
			}
			expect(view).toContain("artifact write failed");
			expect(view).toContain("SCHEMA_DIAGNOSTIC");
			expect(view.indexOf("artifact write failed")).toBeLessThan(view.indexOf("SCHEMA_DIAGNOSTIC"));
			expect(view.indexOf("SCHEMA_DIAGNOSTIC")).toBeLessThan(view.indexOf("ASSISTANT_BOUNDARY"));
		}
	});

	it.each(["prose", "artifact warning"] as const)(
		"does not let background receipts replace a %s boundary or the latest actual calls",
		boundary => {
			setChatTranscriptDisplayPreferences({ compactToolActivity: true });
			const transcript = new TranscriptContainer();
			transcript.setCompactTurnActive(true);
			for (let side = 0; side < 2; side++) {
				if (side === 1) {
					if (boundary === "prose") {
						transcript.addChild(new Text("VISIBLE_BOUNDARY", 0, 0));
					} else {
						transcript.addChild(
							buildAsyncResultBlock(
								asyncMessage([
									{
										jobId: "VISIBLE_BOUNDARY",
										type: "eval",
										status: "completed",
										meta: { artifactError: "open" },
									},
								]),
							),
						);
					}
				}
				for (let index = 0; index < 3; index++) {
					const tool = new ToolExecutionComponent("read", { path: `segment-${side}-${index}.ts` }, {}, undefined, {
						requestRender() {},
						requestComponentRender() {},
						resetDisplay() {},
					});
					components.push(tool);
					tool.updateResult({ content: [{ type: "text", text: "PRIVATE_SUCCESS" }] });
					transcript.addChild(tool);
					transcript.addChild(
						buildAsyncResultBlock(
							asyncMessage([
								{
									jobId: `segment-job-${side}-${index}`,
									type: "task",
									status: "completed",
								},
							]),
						),
					);
				}
			}
			for (const view of [Bun.stripANSI(transcript.render(160).join("\n")), nativeTranscriptView(transcript)]) {
				expect(view).not.toContain("后台任务已完成");
				expect(view).not.toContain("已收起");
				expect(view).toContain(boundary === "prose" ? "VISIBLE_BOUNDARY" : "artifact open failed");
				for (let index = 0; index < 3; index++) expect(view).not.toContain(`segment-0-${index}.ts`);
				expect(view).not.toContain("segment-1-0.ts");
				expect(view).toContain("segment-1-1.ts");
				expect(view).toContain("segment-1-2.ts");
			}
		},
	);

	it("prefers the intent over the command text", () => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		const withIntent = new ToolExecutionComponent(
			"bash",
			{ command: 'bun -e "PRIVATE_SCRIPT"', i: "检查本地输出" },
			{},
			undefined,
			{
				requestRender() {},
				requestComponentRender() {},
				resetDisplay() {},
			},
		);
		components.push(withIntent);
		expect(Bun.stripANSI(withIntent.render(70)[0])).toContain("检查本地输出");
		expect(withIntent.render(70)[0]).not.toContain("PRIVATE_SCRIPT");
		expect(JSON.stringify(withIntent.describe(toolCx))).toContain("检查本地输出");
		expect(JSON.stringify(withIntent.describe(toolCx))).not.toContain("PRIVATE_SCRIPT");

		const withoutIntent = new ToolExecutionComponent("bash", { command: 'bun -e "PRIVATE_SCRIPT"' }, {}, undefined, {
			requestRender() {},
			requestComponentRender() {},
			resetDisplay() {},
		});
		components.push(withoutIntent);
		expect(Bun.stripANSI(withoutIntent.render(70)[0])).toContain('bun -e "PRIVATE_SCRIPT"');
	});

	it("skips leading assignments and context builtins in one-line command summaries", () => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		for (const [command, summary, hidden] of [
			['ACCESS_TOKEN="PRIVATE value" OTHER=1 bun test', "bun test", "PRIVATE value"],
			["cd /tmp/private-dir && git diff --stat", "git diff --stat", "private-dir"],
			['cd "/tmp/quiet && path" && python3 train.py', "python3 train.py", "/tmp/quiet"],
			["export FOO=1; bun run check", "bun run check", "FOO=1"],
			["true && bun test", "bun test", undefined],
			["cd /tmp/private-dir", "cd", "private-dir"],
			["git diff --stat", "git diff --stat", undefined],
		] as const) {
			const component = new ToolExecutionComponent("bash", { command }, {}, undefined, {
				requestRender() {},
				requestComponentRender() {},
				resetDisplay() {},
			});
			components.push(component);
			for (const complete of [false, true]) {
				if (complete) component.updateResult({ content: [{ type: "text", text: "PRIVATE_OUTPUT" }] });
				for (const view of [
					Bun.stripANSI(component.render(100).join("\n")),
					JSON.stringify(component.describe(toolCx)),
					JSON.stringify(component.describe()),
				]) {
					expect(view).toContain(summary);
					expect(view).not.toContain("CUDA_VISIBLE_DEVICES");
					expect(view).not.toContain("ACCESS_TOKEN");
					expect(view).not.toContain("private-dir");
					expect(view).not.toContain("/tmp/quiet");
					if (hidden) expect(view).not.toContain(hidden);
				}
			}
		}
	});

	it("shows quoted command arguments in the rendered summary", () => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		for (const [command, rendered, nativeText] of [
			[
				'CUDA_VISIBLE_DEVICES=0 "C:/Program Files/Python/python.exe" train.py',
				'"C:/Program Files/Python/python.exe" train.py',
				"python.exe",
			],
			['git commit -m "update docs"', 'git commit -m "update docs"', "update docs"],
		] as const) {
			const component = new ToolExecutionComponent("bash", { command }, {}, undefined, {
				requestRender() {},
				requestComponentRender() {},
				resetDisplay() {},
			});
			components.push(component);
			expect(Bun.stripANSI(component.render(100).join("\n"))).toContain(rendered);
			const native = JSON.stringify(component.describe(toolCx));
			expect(native).toContain(nativeText);
			expect(native).not.toContain("CUDA_VISIBLE_DEVICES");
		}
	});

	it("truncates an overlong shell command to a single row", () => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		const component = new ToolExecutionComponent("bash", { command: `bun test ${"a".repeat(300)}` }, {}, undefined, {
			requestRender() {},
			requestComponentRender() {},
			resetDisplay() {},
		});
		components.push(component);
		const rows = component.render(60);
		expect(rows).toHaveLength(1);
		expect(Bun.stringWidth(rows[0]!)).toBeLessThanOrEqual(60);
		expect(Bun.stripANSI(rows[0]!)).toContain("bun test");
	});

	it("preserves the latest read warning and its details independently of the call dock lifecycle", () => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		const transcript = new TranscriptContainer();
		transcript.setCompactTurnActive(true);
		const warning = new ToolExecutionComponent("read", { path: "local://conflicted.ts" }, {}, undefined, {
			requestRender() {},
			requestComponentRender() {},
			resetDisplay() {},
		});
		components.push(warning);
		warning.updateResult({
			content: [{ type: "text", text: "PRIVATE_CONFLICT_BODY" }],
			details: { conflictCount: 2 },
		});
		transcript.addChild(warning);
		for (const view of [Bun.stripANSI(transcript.render(100).join("\n")), nativeTranscriptView(transcript)]) {
			expect(view).toContain("conflicted.ts");
			expect(view).toContain("2 conflicts");
			expect(view).not.toContain("PRIVATE_");
		}
		transcript.setCompactTurnActive(false);
		expect(transcript.render(100).join("\n")).toContain("conflicted.ts");
		transcript.noteCompactUserTurnStart();
		expect(transcript.render(100)).toEqual([]);
		setChatTranscriptDisplayPreferences({ compactToolActivity: false });
		expect(transcript.render(100).join("\n")).toContain("PRIVATE_CONFLICT_BODY");
	});

	it("retains each grouped read intent after execution args omit it", () => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		const group = new ReadToolGroupComponent({ showContentPreview: true });
		components.push(group);
		const streamed = { path: "src/settings.ts", i: "检查用户配置" };
		group.updateArgs(streamed, "settings");
		group.updateArgs({ path: "src/settings.ts" }, "settings");
		group.updateArgs({ path: "src/fallback.ts" }, "fallback");
		group.updateResult({ content: [{ type: "text", text: "PRIVATE_READ_BODY" }] }, false, "settings");
		const rows = group.render(70).map(row => Bun.stripANSI(row));
		expect(rows[0]).toContain("检查用户配置");
		expect(rows[1]).toContain("fallback.ts");
		expect(rows[1]).not.toContain("检查用户配置");
		const native = JSON.stringify(group.describe(toolCx));
		expect(native).toContain("检查用户配置");
		expect(native).toContain("fallback.ts");
		expect(native).not.toContain("PRIVATE_READ_BODY");
	});

	it("does not archive transient grouped activity or duplicate it after prose/tool cycles", () => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		const transcript = new TranscriptContainer();
		transcript.setCompactTurnActive(true);
		const group = new ReadToolGroupComponent();
		components.push(group);
		transcript.addChild(group);
		for (let index = 0; index < 8; index++) {
			group.updateArgs({ path: `warning-${index}.ts` }, String(index));
			group.updateResult({ content: [], details: { conflictCount: 2 } }, false, String(index));
		}
		group.finalize();
		transcript.addChild(new Text("PROSE_CYCLE", 0, 0));
		const history: string[] = [];
		for (let index = 0; index < 10; index++) {
			const batch = transcript.peekFinalizedBatch(100, 4);
			if (!batch) break;
			history.push(...batch.rows);
			transcript.acknowledgeFinalizedBatch(batch.id);
		}
		expect(history.join("\n")).not.toContain("warning-");
		const viewport = Bun.stripANSI(transcript.renderViewport(100, 4, { tick: 0, now: 0 }).join("\n"));
		expect(viewport).toMatch(/warning-6\.ts[^]*warning-7\.ts/);
		expect(viewport).not.toContain("warning-5.ts");
	});

	it.each(["individual", "grouped"] as const)(
		"preserves external scrollback when an open compact tool run changes its latest calls: %s",
		async kind => {
			setChatTranscriptDisplayPreferences({ compactToolActivity: true });
			const terminal = new VirtualTerminal(100, 12);
			terminal.write(`PREVIOUS_SHELL_HISTORY${"\r\n".repeat(terminal.rows + 2)}`);
			const scheduler = new VirtualRenderScheduler();
			const composer = new Composer({
				terminal,
				tuiOptions: { renderScheduler: scheduler },
				preferences: { ...COMPOSER_DEFAULTS, quiet: true },
			});
			composer.setHeaderExtras([new Text("RETIRED_COMPOSER_HEADER", 0, 0)], []);
			const transcript = new TranscriptContainer();
			transcript.setCompactTurnActive(true);
			const addTool = (path: string, warning = false) => {
				const component = new ToolExecutionComponent("read", { path }, {}, undefined, composer.ui);
				components.push(component);
				component.updateResult({
					content: [{ type: "text", text: "PRIVATE_OUTPUT" }],
					...(warning ? { details: { conflictCount: 2 } } : {}),
				});
				transcript.addChild(component);
			};
			const retained = Array.from({ length: 8 }, (_, index) => `warning-${index}.ts`);
			if (kind === "grouped") {
				const group = new ReadToolGroupComponent({ showContentPreview: true });
				components.push(group);
				transcript.addChild(group);
				for (const path of ["success-prefix.ts", ...retained]) {
					group.updateArgs({ path }, path);
					group.updateResult(
						{
							content: [{ type: "text", text: "PRIVATE_OUTPUT" }],
							...(path.startsWith("warning-") ? { details: { conflictCount: 2 } } : {}),
						},
						false,
						path,
					);
				}
				group.finalize();
			} else {
				addTool("success-prefix.ts");
				for (const path of retained) addTool(path, true);
			}
			composer.setRuntimeChildren([transcript, new Text("EDITOR", 0, 0)]);
			composer.start({ playWelcomeIntro: false });
			try {
				await scheduler.settle(terminal);
				expect(terminal.getScrollBuffer().join("\n")).toContain("PREVIOUS_SHELL_HISTORY");
				for (let index = 0; index < 7; index++) {
					addTool(`saved-${index}.ts`);
					composer.ui.requestRender();
					await scheduler.settle(terminal);
					expect(terminal.getScrollBuffer().join("\n")).toContain("PREVIOUS_SHELL_HISTORY");
				}
				transcript.addChild(new Text("ASSISTANT_BODY", 0, 0));
				composer.ui.requestRender();
				await scheduler.settle(terminal);
				const visible = terminal.getScrollBuffer().join("\n");
				for (const marker of ["PREVIOUS_SHELL_HISTORY", "RETIRED_COMPOSER_HEADER", "ASSISTANT_BODY"]) {
					expect(visible.split("\n").filter(row => row.includes(marker))).toHaveLength(1);
				}
				for (const marker of ["success-prefix.ts", ...retained]) expect(visible).not.toContain(marker);
				for (let index = 0; index < 7; index++) {
					expect(visible.split("\n").filter(row => row.includes(`saved-${index}.ts`))).toHaveLength(
						index < 5 ? 0 : 1,
					);
				}
				expect(visible).not.toContain("PRIVATE_OUTPUT");
			} finally {
				composer.stop();
			}
		},
	);

	it("keeps approval state and independent execution warnings available after call displacement", () => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		const transcript = new TranscriptContainer();
		transcript.setCompactTurnActive(true);
		const proposal = new ToolExecutionComponent("ast_edit", {}, {}, undefined, {
			requestRender() {},
			requestComponentRender() {},
			resetDisplay() {},
		});
		components.push(proposal);
		proposal.updateResult({ content: [], details: { applied: false, totalReplacements: 1 } });
		transcript.addChild(proposal);
		expect(Bun.stripANSI(transcript.render(100).join("\n"))).toContain("待确认");
		const failure = new ToolExecutionComponent("read", { path: "failed.ts" }, {}, undefined, {
			requestRender() {},
			requestComponentRender() {},
			resetDisplay() {},
		});
		components.push(failure);
		failure.updateResult({ content: [{ type: "text", text: "Permission denied" }], isError: true });
		transcript.addChild(failure);
		transcript.addChild(new Text("INDEPENDENT_EXECUTION_WARNING", 0, 0));
		expect(Bun.stripANSI(transcript.render(100).join("\n"))).toContain("error");
		transcript.setCompactTurnActive(false);
		expect(transcript.render(100).join("\n")).toContain("INDEPENDENT_EXECUTION_WARNING");
		setChatTranscriptDisplayPreferences({ compactToolActivity: false });
		expect(transcript.render(100).join("\n")).toContain("Permission denied");
	});

	it("repaints detailed spinner frames without reshaping the body, including after a compact result update", () => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: false });
		let shapes = 0;
		const tool = {
			name: "animated",
			label: "Animated",
			renderResult(result: { content: Array<{ type: string; text?: string }> }, state: { spinnerFrame?: number }) {
				shapes++;
				const output = result.content.map(block => block.text ?? "").join("");
				return { render: () => [`${output} · frame ${state.spinnerFrame ?? 0}`] };
			},
		};
		const component = new ToolExecutionComponent("animated", {}, {}, tool as unknown as AgentTool, {
			requestRender() {},
			requestComponentRender() {},
			resetDisplay() {},
		});
		components.push(component);
		component.updateResult({ content: [{ type: "text", text: "FIRST_PROGRESS" }] }, true);
		const initialShapes = shapes;
		for (let frame = 1; frame <= 3; frame++) {
			component.tickSpinner(frame);
			expect(component.render(80).join("\n")).toContain(`FIRST_PROGRESS · frame ${frame}`);
		}
		expect(shapes).toBe(initialShapes);
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		component.updateResult({ content: [{ type: "text", text: "NEW_PROGRESS" }] }, true);
		expect(component.render(80).join("\n")).not.toContain("NEW_PROGRESS");
		setChatTranscriptDisplayPreferences({ compactToolActivity: false });
		expect(component.render(80).join("\n")).toContain("NEW_PROGRESS");
		const restoredShapes = shapes;
		component.tickSpinner(4);
		expect(component.render(80).join("\n")).toContain("NEW_PROGRESS · frame 4");
		expect(shapes).toBe(restoredShapes);
	});

	it.each([
		["custom", "target.ts\ncontinued"],
		["write", "xd://eval"],
		["write", "[xd://eval#ABCD]"],
		["write", "proc://bg_1"],
		["write", "[proc://bg_1#ABCD]"],
		["write", "cfg://settings"],
		["write", "[cfg://settings#ABCD]"],
		["write", "agent://helper"],
		["write", "[agent://helper#ABCD]"],
	])(
		"%s %s bypasses custom output renderers through pending, progress, failure and expansion, then restores detail",
		(name, path) => {
			setChatTranscriptDisplayPreferences({ compactToolActivity: true });
			let renders = 0;
			const tool = {
				name,
				label: "Custom\noperation",
				renderCall() {
					renders++;
					return new Text("PRIVATE_ARGUMENTS", 0, 0);
				},
				renderResult() {
					renders++;
					return new Text("PRIVATE_OUTPUT", 0, 0);
				},
				describeCall() {
					renders++;
					return { body: [md("PRIVATE_ARGUMENTS")] };
				},
				describeResult() {
					renders++;
					return { body: [md("PRIVATE_OUTPUT")] };
				},
			};
			const component = new ToolExecutionComponent(
				name,
				{ path, content: "PRIVATE_ARGUMENTS", payload: "PRIVATE_ARGUMENTS" },
				{},
				tool as unknown as AgentTool,
				{ requestRender() {}, requestComponentRender() {}, resetDisplay() {} },
			);
			components.push(component);
			expect(component.render(80)).toHaveLength(1);
			expect(Bun.stripANSI(component.render(80)[0])).toContain("pending");
			component.setExecutionStarted();
			component.updateResult({ content: [{ type: "text", text: "PRIVATE_PROGRESS" }] }, true);
			expect(Bun.stripANSI(component.render(80)[0])).toContain("running");
			component.updateResult({
				content: [{ type: "text", text: "Permission denied\nPRIVATE_OUTPUT" }, image],
				isError: true,
			});
			component.setExpanded(true);
			component.handleNativeEvent({ type: "toggle", key: "", collapsed: false });
			for (const width of [12, 80]) {
				const rows = component.render(width);
				expect(rows).toHaveLength(1);
				expect(rows[0]).not.toContain("\n");
				expect(Bun.stringWidth(rows[0])).toBeLessThanOrEqual(width);
				expect(rows[0]).not.toContain("PRIVATE_");
			}
			expect(Bun.stripANSI(component.render(80)[0])).not.toContain("Permission denied");
			for (const cx of [toolCx, undefined]) {
				const described = component.describe(cx);
				expect(JSON.stringify(described)).not.toContain("PRIVATE_");
				expect(nodes(described).some(node => node.k === "md" || node.k === "image")).toBe(false);
				expect(nodes(described).some(node => node.k === "tool")).toBe(cx !== undefined);
			}
			expect(renders).toBe(0);
			component.setToolActivityVisible(false);
			expect(component.render(80)).toEqual([]);
			expect(component.describe(toolCx).p?.hidden).toBe(true);
			component.setToolActivityVisible(true);
			setChatTranscriptDisplayPreferences({ compactToolActivity: false });
			component.invalidate();
			expect(component.render(80).join("\n")).toContain("PRIVATE_OUTPUT");
			expect(JSON.stringify(component.describe(toolCx))).toContain("PRIVATE_OUTPUT");
		},
	);

	it.each([
		"preview.ts",
		"[preview.ts#ABCD]",
		"local://preview.ts",
		"[local://preview.ts#ABCD]",
		"ssh://host/project/preview.ts",
	])("keeps file bodies private while details restore previews and edit diffs for %s", path => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		for (const name of ["write", "edit"]) {
			const component = new ToolExecutionComponent(
				name,
				{ path, content: "FILE_PREVIEW_LINE\nFILE_PREVIEW_TAIL" },
				{},
				undefined,
				{ requestRender() {}, requestComponentRender() {}, resetDisplay() {} },
			);
			components.push(component);
			component.updateResult({
				content: [{ type: "text", text: "File updated" }],
				details: name === "edit" ? { diff: "-1: OLD_FILE_LINE\n+1: FILE_DIFF_LINE" } : {},
			});
			component.setExpanded(true);
			expect(component.isCompactToolActivity()).toBe(true);
			const expected = name === "write" ? "FILE_PREVIEW_LINE" : "FILE_DIFF_LINE";
			expect(Bun.stripANSI(component.render(100).join("\n"))).not.toContain(expected);
			expect(component.render(100)).toHaveLength(1);
			expect(JSON.stringify(component.describe(toolCx))).not.toContain(expected);
			setChatTranscriptDisplayPreferences({ compactToolActivity: false });
			expect(Bun.stripANSI(component.render(100).join("\n"))).toContain(expected);
			expect(JSON.stringify(component.describe(toolCx))).toContain(expected);
			setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		}
	});

	it("shows the last three real edit calls with only the newest expanded until the next task", () => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		const transcript = new TranscriptContainer();
		transcript.setCompactTurnActive(true);
		for (let index = 0; index < 4; index++) {
			const edit = new ToolExecutionComponent(
				index % 2 ? "apply_patch" : "edit",
				{ path: `current-${index}.ts`, oldText: "PRIVATE_PARAMS" },
				{},
				undefined,
				{
					requestRender() {},
					requestComponentRender() {},
					resetDisplay() {},
				},
			);
			components.push(edit);
			edit.updateResult({
				content: [{ type: "text", text: "PRIVATE_OUTPUT" }],
				details: { diff: `-1 old\n+1 ACTIVE_DIFF_${index}` },
			});
			transcript.addChild(edit);
		}
		transcript.addChild(new Text("MIDTURN_STEERING_AND_PROSE", 0, 0));
		transcript.setCompactTurnActive(true);
		const compact = Bun.stripANSI(transcript.render(100).join("\n"));
		expect(compact).not.toContain("ACTIVE_DIFF_0");
		for (let index = 1; index < 3; index++) {
			expect(compact).toContain(`current-${index}.ts`);
			expect(compact).toContain(`ACTIVE_DIFF_${index}`);
		}
		expect(compact).toContain("ACTIVE_DIFF_3");
		expect(compact).not.toContain("PRIVATE_");
		const history: string[] = [];
		for (let index = 0; index < 8; index++) {
			const batch = transcript.peekFinalizedBatch(100, 3);
			if (!batch) break;
			history.push(...batch.rows);
			transcript.acknowledgeFinalizedBatch(batch.id);
		}
		expect(history.join("\n")).not.toContain("ACTIVE_DIFF_");
		transcript.setCompactTurnActive(false);
		const ended = Bun.stripANSI(transcript.render(100).join("\n"));
		expect(ended).toContain("ACTIVE_DIFF_3");
		expect(ended).toContain("ACTIVE_DIFF_1");
		transcript.noteCompactUserTurnStart();
		for (const view of [Bun.stripANSI(transcript.render(100).join("\n")), nativeTranscriptView(transcript)]) {
			expect(view).not.toContain("ACTIVE_DIFF_");
		}
		setChatTranscriptDisplayPreferences({ compactToolActivity: false });
		const detailed = Bun.stripANSI(transcript.render(100).join("\n"));
		for (let index = 0; index < 4; index++) expect(detailed).toContain(`ACTIVE_DIFF_${index}`);
	});

	it("restores active tools and diffs from the real user boundary rather than a steered bubble", () => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		const transcript = new TranscriptContainer();
		const addEdit = (label: string) => {
			const edit = new ToolExecutionComponent("edit", { path: `${label}.ts` }, {}, undefined, {
				requestRender() {},
				requestComponentRender() {},
				resetDisplay() {},
			});
			components.push(edit);
			edit.updateResult({ content: [], details: { diff: `-1 old\n+1 ${label}_DIFF` } });
			transcript.addChild(edit);
		};
		addEdit("OLD_HISTORY");
		transcript.noteCompactUserTurnStart();
		const user = new UserMessageComponent("REAL_COMMAND");
		components.push(user);
		transcript.addChild(user);
		addEdit("ACTIVE_BEFORE_STEERING");
		const steering = new UserMessageComponent("STEERING", { liveSteered: true });
		components.push(steering);
		transcript.addChild(steering);
		transcript.setCompactTurnActive(true);
		for (const view of [Bun.stripANSI(transcript.render(100).join("\n")), nativeTranscriptView(transcript)]) {
			expect(view).toContain("ACTIVE_BEFORE_STEERING_DIFF");
			expect(view).not.toContain("OLD_HISTORY_DIFF");
		}
	});

	it("retires prose against the same budget as three active diffs across resize and HUD pressure", () => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		const transcript = new TranscriptContainer();
		transcript.setCompactTurnActive(true);
		for (let index = 0; index < 3; index++) {
			const edit = new ToolExecutionComponent("edit", { path: `budget-${index}.ts` }, {}, undefined, {
				requestRender() {},
				requestComponentRender() {},
				resetDisplay() {},
			});
			components.push(edit);
			edit.updateResult({ content: [], details: { diff: `-1 before\n+1 BUDGET_DIFF_${index}` } });
			transcript.addChild(edit);
		}
		const markers = Array.from({ length: 10 }, (_, index) => `PROSE_BUDGET_${index}_END`);
		const prose = new AssistantMessageComponent(
			assistant([
				{
					type: "text",
					text: `| Marker | Value |\n| --- | --- |\n${markers.map(marker => `| ${marker} | stable body |`).join("\n")}`,
				},
			]),
		);
		components.push(prose);
		prose.markTranscriptBlockFinalized();
		transcript.addChild(prose);
		const history: string[] = [];
		for (const [width, height] of [
			[100, 18],
			[65, 10],
			[80, 8],
			[100, 16],
		] as const) {
			for (let index = 0; index < 20; index++) {
				const batch = transcript.peekFinalizedBatch(width, height);
				if (!batch) break;
				history.push(...batch.rows);
				transcript.acknowledgeFinalizedBatch(batch.id);
			}
			const viewport = transcript.renderViewport(width, height, { tick: 0, now: 0 });
			const visible = Bun.stripANSI([...history, ...viewport].join("\n"));
			for (const marker of markers) expect(visible.split(marker)).toHaveLength(2);
			expect(history.join("\n")).not.toContain("BUDGET_DIFF_");
		}
	});

	it.each(["🙂", "!!!"])("never treats a newly revealed %s row as a table border during seam relocation", symbol => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		const transcript = new TranscriptContainer();
		transcript.addChild({
			render: width => (width >= 80 ? ["COMMITTED_HEAD", "LIVE_TAIL"] : [symbol, "COMMITTED_HEAD", "LIVE_TAIL"]),
		});
		const batch = transcript.peekFinalizedBatch(100, 1);
		expect(batch).toBeDefined();
		expect(batch!.rows.join("\n")).toContain("COMMITTED_HEAD");
		transcript.acknowledgeFinalizedBatch(batch!.id);
		expect(transcript.renderViewport(65, 3, { tick: 0, now: 0 }).join("\n")).toContain(symbol);
	});

	it("keeps complete original diff sections in the newest expanded edit call", () => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		const transcript = new TranscriptContainer();
		transcript.setCompactTurnActive(true);
		for (let call = 0; call < 2; call++) {
			const edit = new ToolExecutionComponent("edit", { path: `multi-${call}.ts` }, {}, undefined, {
				requestRender() {},
				requestComponentRender() {},
				resetDisplay() {},
			});
			components.push(edit);
			edit.updateResult({
				content: [],
				details: {
					perFileResults: [0, 1].map(file => ({
						path: `file-${call * 2 + file}.ts`,
						diff: `-1 previous\n+1 FILE_SECTION_${call * 2 + file}`,
					})),
				},
			});
			transcript.addChild(edit);
		}
		const view = Bun.stripANSI(transcript.render(100).join("\n"));
		expect(view).toContain("file-0.ts");
		for (let index = 0; index < 4; index++) expect(view).toContain(`FILE_SECTION_${index}`);
	});

	it("keeps LSP device writes on one line while streaming and settled, restoring references in detailed mode", () => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		const args = { action: "references", file: "target.ts", line: 1, symbol: "targetSymbol" };
		const component = new ToolExecutionComponent("write", {}, {}, undefined, {
			requestRender() {},
			requestComponentRender() {},
			resetDisplay() {},
		});
		components.push(component);
		component.updateArgs({ path: "xd://lsp", content: JSON.stringify(args) });
		expect(component.render(80)).toHaveLength(1);
		expect(Bun.stripANSI(component.render(80)[0])).toContain("references targetSymbol");
		component.setExecutionStarted();
		component.updateResult({ content: [{ type: "text", text: "PRIVATE_PROGRESS" }] }, true);
		expect(component.render(80)).toHaveLength(1);
		expect(Bun.stripANSI(component.render(80)[0])).toContain("running");
		component.updateResult({
			content: [{ type: "text", text: "2 reference(s)\nPRIVATE_REFERENCE.ts:10:2\nPRIVATE_REFERENCE.ts:20:4" }],
			details: { xdev: { tool: "lsp", mode: "execute", args, inner: { action: "references", success: true } } },
		});
		component.setExpanded(true);
		component.handleNativeEvent({ type: "toggle", key: "", collapsed: false });
		for (const width of [12, 80]) {
			const rows = component.render(width);
			expect(rows).toHaveLength(1);
			expect(Bun.stringWidth(rows[0])).toBeLessThanOrEqual(width);
			expect(rows[0]).not.toContain("PRIVATE_");
		}
		expect(Bun.stripANSI(component.render(80)[0])).toContain("done");
		for (const cx of [toolCx, undefined]) {
			const described = component.describe(cx);
			expect(JSON.stringify(described)).not.toContain("PRIVATE_");
			if (described.k === "tool") {
				expect(described.p?.collapsible).toBe(false);
				expect(described.c ?? []).toHaveLength(0);
			}
		}
		setChatTranscriptDisplayPreferences({ compactToolActivity: false });
		expect(Bun.stripANSI(component.render(80).join("\n"))).toContain("PRIVATE_REFERENCE.ts");
		expect(JSON.stringify(component.describe(toolCx))).toContain("PRIVATE_REFERENCE.ts");
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		expect(component.render(80)).toHaveLength(1);
		expect(JSON.stringify(component.describe(toolCx))).not.toContain("PRIVATE_REFERENCE.ts");
	});

	it.each([undefined, "Observe background work"])(
		"P2-25 retains latest wait task identities despite intent %j",
		intent => {
			setChatTranscriptDisplayPreferences({ compactToolActivity: true });
			const component = new ToolExecutionComponent("wait", { i: intent }, {}, undefined, {
				requestRender() {},
				requestComponentRender() {},
				resetDisplay() {},
			});
			components.push(component);
			component.updateArgs({});
			component.setExecutionStarted();
			const job: NonNullable<CoordinationDetails["jobs"]>[number] = {
				id: "bg_11",
				type: "bash",
				status: "running",
				label: "bun run slowtest\nPRIVATE_ARGUMENTS",
				durationMs: 27_200,
				resultText: "PRIVATE_OUTPUT",
			};
			const progress = (jobs: CoordinationDetails["jobs"], isPartial = true) =>
				component.updateResult(
					{
						content: [{ type: "text", text: "PRIVATE_OUTPUT" }],
						details: { op: "wait", jobs } satisfies CoordinationDetails,
					},
					isPartial,
				);
			progress([job]);
			expect(Bun.stripANSI(component.render(100)[0])).toContain("[bash] bg_11 bun run slowtest");
			for (const cx of [toolCx, undefined]) {
				const view = JSON.stringify(component.describe(cx));
				expect(view).toContain("[bash] bg_11 bun run slowtest");
				expect(view).not.toContain("PRIVATE_");
			}
			component.setExpanded(true);
			for (const width of [18, 100]) {
				const rows = component.render(width);
				expect(rows).toHaveLength(1);
				expect(Bun.stringWidth(rows[0])).toBeLessThanOrEqual(width);
				expect(rows[0]).not.toContain("PRIVATE_");
			}
			progress([
				{ ...job, status: "completed" },
				{ ...job, id: "bg_12", label: "bun run check:tools" },
			]);
			const updated = Bun.stripANSI(component.render(100)[0]);
			expect(updated).toContain("[bash] bg_12 bun run check:tools");
			expect(updated).toContain("+1");
			expect(updated).not.toContain("slowtest");
			expect(JSON.stringify(component.describe(toolCx))).toContain("bg_12 bun run check:tools");
			expect(JSON.stringify(component.describe(toolCx))).toContain("+1");
			progress([{ ...job, status: "completed" }], false);
			expect(Bun.stripANSI(component.render(100)[0])).toContain("bg_11 bun run slowtest");
			setChatTranscriptDisplayPreferences({ compactToolActivity: false });
			expect(Bun.stripANSI(component.render(100).join("\n"))).toContain("bg_11");
			setChatTranscriptDisplayPreferences({ compactToolActivity: true });
			expect(Bun.stripANSI(component.render(100)[0])).toContain("bg_11 bun run slowtest");
			expect(JSON.stringify(component.describe(toolCx))).toContain("bg_11 bun run slowtest");
			progress([], false);
			expect(component.render(100).join("\n")).not.toContain("bg_11");
			expect(JSON.stringify(component.describe(toolCx))).not.toContain("bg_11");
		},
	);

	it("retains a single row for long built-in calls, successful output and sealed calls", () => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		const component = new ToolExecutionComponent(
			"bash",
			{ command: `echo ${"long ".repeat(200)}\nPRIVATE_ARGUMENTS` },
			{},
			undefined,
			{ requestRender() {}, requestComponentRender() {}, resetDisplay() {} },
		);
		components.push(component);
		component.setExecutionStarted();
		component.updateResult({ content: [{ type: "text", text: "PRIVATE_OUTPUT\n".repeat(2000) }] });
		for (const width of [8, 80]) {
			const rendered = component.render(width);
			expect(rendered).toHaveLength(1);
			expect(Bun.stringWidth(rendered[0])).toBeLessThanOrEqual(width);
		}
		expect(JSON.stringify(component.describe(toolCx))).not.toContain("PRIVATE_");
		const queued = new ToolExecutionComponent("custom", {}, {}, undefined, {
			requestRender() {},
			requestComponentRender() {},
			resetDisplay() {},
		});
		components.push(queued);
		queued.seal();
		expect(Bun.stripANSI(queued.render(80)[0])).toContain("cancelled");
	});

	it("keeps each grouped read identity through completion, finalization, sealing and mode changes", () => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		const group = new ReadToolGroupComponent({ showContentPreview: true });
		components.push(group);
		for (const id of ["first", "second"]) {
			group.updateArgs({ path: "same.ts:1-3" }, id);
			group.setExecutionStarted(id);
		}
		expect(group.render(40)).toHaveLength(2);
		group.updateResult({ content: [{ type: "text", text: "PRIVATE_PROGRESS" }] }, true, "first");
		expect(group.render(40)).toHaveLength(2);
		expect(JSON.stringify(group.describe(toolCx))).not.toContain("PRIVATE_PROGRESS");
		group.updateResult({ content: [{ type: "text", text: "PRIVATE_READ_BODY" }] }, false, "first");
		group.updateResult(
			{ content: [{ type: "text", text: "Denied\nPRIVATE_READ_ERROR" }], isError: true },
			false,
			"second",
		);
		group.finalize();
		group.setExpanded(true);
		group.handleNativeEvent({ type: "toggle", key: "pfirst", collapsed: false });
		const compactVersion = group.getTranscriptBlockVersion();
		for (const cx of [toolCx, undefined]) {
			const description = group.describe(cx);
			expect(
				nodes(description)
					.filter(node => node.p?.role === "omp.tool.read")
					.map(node => node.key),
			).toEqual(["first", "second"]);
			expect(JSON.stringify(description)).not.toContain("PRIVATE_");
		}
		const rows = group.render(80).map(row => Bun.stripANSI(row));
		expect(rows).toHaveLength(2);
		expect(rows[0]).toContain("done");
		expect(rows[1]).toContain("error");
		expect(rows.join("\n")).not.toContain("Denied");
		group.updateArgs({ path: "unfinished.ts" }, "third");
		group.seal();
		expect(Bun.stripANSI(group.render(80)[2])).toContain("cancelled");
		setChatTranscriptDisplayPreferences({ compactToolActivity: false });
		group.invalidate();
		expect(group.getTranscriptBlockVersion()).not.toBe(compactVersion);
		expect(group.render(80).join("\n")).toContain("PRIVATE_READ_BODY");
		expect(JSON.stringify(group.describe(toolCx))).toContain("PRIVATE_READ_BODY");
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		group.setToolActivityVisible(false);
		expect(group.render(80)).toEqual([]);
		expect(group.describe(toolCx).p?.hidden).toBe(true);
	});

	it("retains upstream thinking expansion and its live pulse in detailed mode", () => {
		const component = new AssistantMessageComponent(undefined, true);
		components.push(component);
		const message = assistant([{ type: "thinking", thinking: "PRIVATE_THINKING\ncontinued" }]);
		component.updateContent(message, { transient: true });
		component.handleNativeEvent({ type: "toggle", key: "k0", collapsed: false });
		expect(JSON.stringify(component.describe(toolCx))).toContain("PRIVATE_THINKING");
		expect(nodes(component.describe(toolCx)).find(node => node.k === "section")?.p?.collapsed).toBe(false);
		expect(nodes(component.describe(toolCx)).some(node => node.k === "elapsed")).toBe(true);
		const rows = component.render(80).filter(row => Bun.stripANSI(row).trim());
		expect(rows).toHaveLength(1);
		expect(Bun.stripANSI(component.render(80).join("\n"))).toContain("Thinking");
		component.setHideThinkingBlock(false);
		component.invalidate();
		expect(component.render(80).join("\n")).toContain("PRIVATE_THINKING");
		expect(JSON.stringify(component.describe(toolCx))).toContain("PRIVATE_THINKING");
		component.setHideThinkingBlock(true);
		component.markTranscriptBlockFinalized();
		component.invalidate();
		expect(component.render(80).join("\n")).not.toContain("PRIVATE_THINKING");
		expect(JSON.stringify(component.describe(toolCx))).not.toContain("PRIVATE_THINKING");
	});

	it("uses the latest wait snapshot through xd dispatch instead of the transport intent", () => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		const component = new ToolExecutionComponent(
			"write",
			{ path: "xd://wait", content: "{}", i: "观察后台任务" },
			{},
			undefined,
			{ requestRender() {}, requestComponentRender() {}, resetDisplay() {} },
		);
		components.push(component);
		const first = {
			id: "bg_11",
			type: "bash",
			status: "running",
			label: "bun first\nPRIVATE_LABEL",
			durationMs: 100,
		};
		component.updateResult(
			{
				content: [{ type: "text", text: "PRIVATE_OUTPUT" }],
				details: { xdev: { tool: "wait", mode: "execute", args: {}, inner: { op: "wait", jobs: [first] } } },
			},
			true,
		);
		expect(Bun.stripANSI(component.render(100)[0])).toContain("[bash] bg_11 bun first");
		component.updateResult({
			content: [{ type: "text", text: "PRIVATE_OUTPUT" }],
			details: {
				xdev: {
					tool: "wait",
					mode: "execute",
					args: {},
					inner: {
						op: "wait",
						jobs: [
							{ ...first, status: "completed" },
							{ ...first, id: "bg_12", label: "bun second" },
						],
					},
				},
			},
		});
		for (const view of [
			Bun.stripANSI(component.render(100).join("\n")),
			JSON.stringify(component.describe(toolCx)),
			JSON.stringify(component.describe()),
		]) {
			expect(view).toContain("[bash] bg_12 bun second");
			expect(view).toContain("+1");
			expect(view).not.toContain("观察后台任务");
			expect(view).not.toContain("PRIVATE_");
		}
	});

	it("preserves eval intent precedence and Bash command summaries through xd dispatch", () => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		for (const [inner, outerIntent, expected] of [
			[{ title: "INNER_TITLE" }, undefined, "INNER_TITLE"],
			[{ title: "INNER_TITLE", i: "INNER_INTENT" }, undefined, "INNER_INTENT"],
			[{ title: "INNER_TITLE", i: "INNER_INTENT" }, "OUTER_INTENT", "OUTER_INTENT"],
		] as const) {
			const args = {
				path: "xd://eval",
				content: JSON.stringify({ ...inner, language: "js", code: "PRIVATE_CODE" }),
			};
			const component = new ToolExecutionComponent("write", { ...args, i: outerIntent }, {}, undefined, {
				requestRender() {},
				requestComponentRender() {},
				resetDisplay() {},
			});
			components.push(component);
			component.updateArgs(args);
			for (const view of [
				Bun.stripANSI(component.render(100).join("\n")),
				JSON.stringify(component.describe(toolCx)),
				JSON.stringify(component.describe()),
			]) {
				expect(view).toContain(expected);
				expect(view).not.toContain("PRIVATE_CODE");
			}
		}
		const shell = new ToolExecutionComponent(
			"write",
			{ path: "xd://bash", content: JSON.stringify({ command: 'TOKEN="PRIVATE value" bun -e "PRIVATE_SCRIPT"' }) },
			{},
			undefined,
			{ requestRender() {}, requestComponentRender() {}, resetDisplay() {} },
		);
		components.push(shell);
		expect(Bun.stripANSI(shell.render(100)[0])).toContain('bun -e "PRIVATE_SCRIPT"');
		expect(JSON.stringify(shell.describe(toolCx))).toContain("PRIVATE_SCRIPT");
		expect(shell.render(100).join("\n")).not.toContain("TOKEN");
		expect(shell.render(100).join("\n")).not.toContain("PRIVATE value");
	});

	it.each([false, true])(
		"keeps explicit history details independent of compact/clean main chat (hidden=%s)",
		hideToolActivity => {
			setChatTranscriptDisplayPreferences({ compactToolActivity: true, hideToolActivity });
			const before = { ...chatTranscriptDisplayPreferences };
			const todoPhases: TodoPhase[] = [
				{
					name: "History",
					tasks: [
						{ content: "history queued", status: "pending" },
						{ content: "history running", status: "in_progress" },
						{ content: "history waiting", status: "blocked", blocker: "external input" },
						{ content: "history finished", status: "completed" },
						{ content: "history cancelled", status: "abandoned" },
					],
				},
			];
			const originalTodos = structuredClone(todoPhases);
			const ui = { requestRender() {}, requestComponentRender() {}, resetDisplay() {} };
			const builder = new ChatTranscriptBuilder({
				// The builder only consumes these render callbacks from the host TUI.
				ui: ui as unknown as TUI,
				cwd: process.cwd(),
				requestRender() {},
				toolActivityDisplay: { hideToolActivity: false, compactToolActivity: false, readToolResultPreview: true },
			});
			try {
				builder.rebuild([
					{
						type: "message",
						id: "calls",
						parentId: null,
						timestamp: "2026-10-18T00:00:00.000Z",
						message: assistant([
							{ type: "toolCall", id: "shell", name: "bash", arguments: { command: "echo shell" } },
							{ type: "toolCall", id: "read", name: "read", arguments: { path: "history.txt" } },
							{ type: "toolCall", id: "mcp", name: "mcp__fixture_probe", arguments: { query: "history" } },
							{ type: "toolCall", id: "todo", name: "todo", arguments: { op: "view" } },
						]),
					},
					...(["shell", "read", "mcp", "todo"] as const).map(id => ({
						type: "message" as const,
						id,
						parentId: { shell: "calls", read: "shell", mcp: "read", todo: "mcp" }[id],
						timestamp: "2026-10-18T00:00:00.000Z",
						message: {
							role: "toolResult" as const,
							toolCallId: id,
							toolName: { shell: "bash", read: "read", mcp: "mcp__fixture_probe", todo: "todo" }[id],
							content: [{ type: "text" as const, text: `HISTORY_${id}_BODY` }],
							...(id === "todo" ? { details: { phases: todoPhases, storage: "session" } } : {}),
							isError: false,
							timestamp: 1,
						},
					})),
				]);
				builder.append(
					["history-job-a", "history-job-b"].map((id, index) => ({
						type: "message" as const,
						id,
						parentId: index === 0 ? "todo" : "history-job-a",
						timestamp: "2026-10-18T00:00:00.000Z",
						message: asyncMessage([{ jobId: id, type: "task", status: "completed" }]),
					})),
				);
				builder.setExpanded(true);
				const views = [
					Bun.stripANSI(builder.container.render(120).join("\n")),
					nativeTranscriptView(builder.container),
				];
				for (const view of views) {
					for (const id of ["shell", "read", "mcp"]) expect(view).toContain(`HISTORY_${id}_BODY`);
					for (const task of todoPhases[0].tasks) expect(view).toContain(task.content);
					for (const token of ["[active]", "[blocked]", "[abandoned]", "muted del"]) {
						expect(view).not.toContain(token);
					}
					expect(view.match(/Background job completed/g)).toHaveLength(2);
					expect(view).toContain("history-job-a");
					expect(view).toContain("history-job-b");
					expect(view).not.toContain("后台任务已完成");
					expect(view).not.toContain("已收起");
				}
				const main = new ToolExecutionComponent("bash", { command: "echo main" }, {}, undefined, ui);
				components.push(main);
				main.updateResult({ content: [{ type: "text", text: "PRIVATE_MAIN_BODY" }] });
				main.setExpanded(true);
				main.setToolActivityVisible(!hideToolActivity);
				expect(main.render(100).join("\n")).not.toContain("PRIVATE_MAIN_BODY");
				expect(JSON.stringify(main.describe(toolCx))).not.toContain("PRIVATE_MAIN_BODY");
				expect(chatTranscriptDisplayPreferences).toEqual(before);
				expect(todoPhases).toEqual(originalTodos);
			} finally {
				builder.dispose();
			}
		},
	);

	it("suppresses tool-result images without suppressing model-authored images, reversibly", () => {
		setTerminalImageProtocol(null);
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		const component = new AssistantMessageComponent(assistant([image]));
		components.push(component);
		component.setToolResultImages("read", [image], "/repo/tool-only.png");
		component.setToolResultImagesVisible(true);
		const compactImages = nodes(component.describe(toolCx)).filter(node => node.k === "image" || node.k === "media");
		expect(compactImages).toHaveLength(1);
		expect(component.render(80).join("\n")).not.toContain("tool-only.png");
		setChatTranscriptDisplayPreferences({ compactToolActivity: false });
		component.invalidate();
		expect(nodes(component.describe(toolCx)).filter(node => node.k === "image" || node.k === "media")).toHaveLength(
			2,
		);
	});
});
