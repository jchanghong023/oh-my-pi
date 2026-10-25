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
	it("pins the latest two actual calls below prose with one blank row after the first call", () => {
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
		const second = makeTool("write", { path: "second.ts", content: "PRIVATE_FILE_BODY" });
		expect(viewport().slice(-2).join("\n")).toMatch(/first\.ts[^]*second\.ts/);
		first.updateResult({ content: [{ type: "text", text: "PRIVATE_FAILURE" }], isError: true });
		expect(viewport().slice(-2).join("\n")).toMatch(/first\.ts[^]*second\.ts/);
		const third = makeTool("edit", { path: "third.ts", oldText: "PRIVATE_OLD", newText: "PRIVATE_NEW" });
		third.updateResult({ content: [{ type: "text", text: "PRIVATE_DIFF" }] });
		const view = viewport().join("\n");
		expect(viewport().slice(-2).join("\n")).toMatch(/second\.ts[^]*third\.ts/);
		expect(view).not.toContain("first.ts");
		expect(view).not.toContain("PRIVATE_");
		expect(view).not.toContain("已收起");
		expect(view.indexOf("PROSE_AFTER_CALL")).toBeLessThan(view.indexOf("second.ts"));
		transcript.setCompactTurnActive(true);
		expect(viewport().slice(-2).join("\n")).toMatch(/second\.ts[^]*third\.ts/);
		const short = Bun.stripANSI(transcript.renderViewport(100, 2, { tick: 0, now: 0 }).join("\n"));
		expect(short).toContain("PROSE_AFTER_CALL");
		expect(short).not.toContain("second.ts");
		expect(short).not.toContain("third.ts");
		transcript.setCompactTurnActive(false);
		expect(viewport().join("\n").trimEnd()).toBe("PROSE_AFTER_CALL");
		setChatTranscriptDisplayPreferences({ compactToolActivity: false });
		expect(transcript.render(100).join("\n")).toContain("PRIVATE_FILE_BODY");
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

	it("aggregates standalone deliveries by trusted execution state and retains warning boundaries natively", () => {
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
			expect(view.match(/后台任务已完成 2 项/g)).toHaveLength(1);
			expect(view.match(/后台任务已完成 1 项/g)).toHaveLength(2);
			expect(view).toContain("Background job status unknown");
			expect(view).toContain("untrusted-state");
			expect(view).not.toContain("standalone-a");
			expect(view).not.toContain("standalone-b");
			expect(view.match(/artifact write failed/g)).toHaveLength(1);
			expect(view.indexOf("后台任务已完成 2 项")).toBeLessThan(view.indexOf("untrusted-state"));
			expect(view.indexOf("untrusted-state")).toBeLessThan(view.indexOf("后台任务已完成 1 项"));
			expect(view.indexOf("后台任务已完成 1 项")).toBeLessThan(view.indexOf("artifact write failed"));
			expect(view.lastIndexOf("后台任务已完成 1 项")).toBeGreaterThan(view.indexOf("artifact write failed"));
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
		expect(nativeView().match(/后台任务已完成 2 项/g)).toHaveLength(1);
		expect(JSON.stringify(message)).toBe(original);
	});

	it("updates one background count by execution ID without splitting a continuous tool fold", () => {
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
			expect(view.match(/后台任务已完成 4 项/g)).toHaveLength(1);
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
		expect(Bun.stripANSI(transcript.render(120).join("\n")).match(/后台任务已完成 4 项/g)).toHaveLength(1);
		expect(JSON.stringify(messages)).toBe(originals);
	});

	it("keeps mixed delivery states and independent warnings as visible chronological boundaries", () => {
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
			expect(view.match(/后台任务已完成 2 项/g)).toHaveLength(2);
			expect(view.match(/后台任务已完成 1 项/g)).toHaveLength(3);
			for (const id of ["cancelled-id", "unknown-status", "unknown-type", "running-id"]) {
				expect(view).toContain(id);
			}
			expect(view).toContain("失败 1 项");
			expect(view).not.toContain("failed-id");
			expect(view).toContain("Background job cancelled");
			expect(view.match(/Background job status unknown/g)).toHaveLength(4);
			expect(view).toContain("artifact write failed");
			expect(view).toContain("SCHEMA_DIAGNOSTIC");
			expect(view.indexOf("artifact write failed")).toBeLessThan(view.indexOf("SCHEMA_DIAGNOSTIC"));
			expect(view.lastIndexOf("后台任务已完成 2 项")).toBeLessThan(view.indexOf("ASSISTANT_BOUNDARY"));
			expect(view.lastIndexOf("后台任务已完成 1 项")).toBeGreaterThan(view.indexOf("ASSISTANT_BOUNDARY"));
		}
	});

	it.each(["prose", "artifact warning"] as const)(
		"does not merge background completions across a %s boundary",
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
				expect(view.match(/后台任务已完成 3 项/g)).toHaveLength(2);
				expect(view).not.toContain("已收起");
				expect(view).toContain("VISIBLE_BOUNDARY");
				for (let index = 0; index < 3; index++) expect(view).not.toContain(`segment-0-${index}.ts`);
				expect(view).not.toContain("segment-1-0.ts");
				expect(view).toContain("segment-1-1.ts");
				expect(view).toContain("segment-1-2.ts");
			}
		},
	);

	it("uses intent or executable for shell summaries without exposing the script", () => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		for (const [args, expected] of [
			[{ command: 'bun -e "PRIVATE_SCRIPT"', i: "检查本地输出" }, "检查本地输出"],
			[{ command: 'bun -e "PRIVATE_SCRIPT"' }, "bun"],
		] as const) {
			const component = new ToolExecutionComponent("bash", args, {}, undefined, {
				requestRender() {},
				requestComponentRender() {},
				resetDisplay() {},
			});
			components.push(component);
			component.updateArgs({ command: args.command });
			expect(Bun.stripANSI(component.render(70)[0])).toContain(expected);
			expect(component.render(70)[0]).not.toContain("PRIVATE_SCRIPT");
			expect(JSON.stringify(component.describe(toolCx))).toContain(expected);
			expect(JSON.stringify(component.describe(toolCx))).not.toContain("PRIVATE_SCRIPT");
		}
	});

	it("keeps shell assignment values out of executable summaries before and after execution", () => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		for (const [command, executable] of [
			['ACCESS_TOKEN="PRIVATE value" OTHER=1 bun -e "PRIVATE_SCRIPT"', "bun"],
			['CUDA_VISIBLE_DEVICES=0 "C:/Program Files/Python/python.exe" train.py', "python.exe"],
			["cd /tmp/private-dir && bun test", "bun"],
			['cd "/tmp/quiet && path" && python3 train.py', "python3"],
			["export FOO=1; bun run check", "bun"],
			["true && bun test", "bun"],
			["cd /tmp/private-dir", "cd"],
		]) {
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
					expect(view).toContain(executable!);
					expect(view).not.toContain("PRIVATE");
					expect(view).not.toContain("CUDA_VISIBLE_DEVICES");
					expect(view).not.toContain("ACCESS_TOKEN");
					expect(view).not.toContain("private-dir");
					expect(view).not.toContain("/tmp/quiet");
				}
			}
		}
	});

	it("shows only the running shell output tail in compact mode and drops it when settled", () => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		const component = new ToolExecutionComponent("bash", { command: "bun test", i: "运行测试" }, {}, undefined, {
			requestRender() {},
			requestComponentRender() {},
			resetDisplay() {},
		});
		components.push(component);
		component.updateArgs({ command: "bun test", i: "运行测试" });
		component.setExecutionStarted();
		component.updateResult(
			{
				content: [
					{
						type: "text",
						text: "old line\n\x1b[31mred line\x1b[0m\n\n\tindented line\nnewest line\n",
					},
				],
			},
			true,
		);
		const rows = component.render(40);
		const raw = rows.join("\n");
		expect(rows).toHaveLength(4);
		expect(raw).not.toContain("\x1b[31m");
		const view = Bun.stripANSI(raw);
		expect(view).toContain("red line");
		expect(view).not.toContain("old line");
		expect(rows.at(-1)).toContain("newest line");
		for (const row of rows) expect(Bun.stringWidth(row)).toBeLessThanOrEqual(40);
		const native = JSON.stringify(component.describe(toolCx));
		expect(native).toContain("newest line");
		expect(native).not.toContain("old line");

		// The activity dock keeps the summary head and grows to four rows for the tail.
		const transcript = new TranscriptContainer();
		transcript.setCompactTurnActive(true);
		transcript.addChild(component);
		const dock = transcript.compactToolActivityBlock();
		expect(dock?.render(40)).toHaveLength(4);
		expect(transcript.compactToolActivityRowCount(40)).toBe(4);
		const dockView = Bun.stripANSI((dock?.render(40) ?? []).join("\n"));
		expect(dockView).toContain("Bash");
		expect(dockView).toContain("newest line");

		component.updateResult({ content: [{ type: "text", text: "old line\nnewest line" }] }, false);
		const settledRows = component.render(40);
		expect(settledRows).toHaveLength(1);
		expect(Bun.stripANSI(settledRows[0]!)).not.toContain("newest line");
		expect(JSON.stringify(component.describe(toolCx))).not.toContain("newest line");
		expect(transcript.compactToolActivityRowCount(40)).toBe(2);
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

	it("shows at most three active edit diffs without archiving them and clears all at execution end", () => {
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
		for (const view of [Bun.stripANSI(transcript.render(100).join("\n")), nativeTranscriptView(transcript)]) {
			expect(view).not.toContain("ACTIVE_DIFF_0");
			for (let index = 1; index < 4; index++) expect(view).toContain(`ACTIVE_DIFF_${index}`);
			expect(view).not.toContain("PRIVATE_");
		}
		const history: string[] = [];
		for (let index = 0; index < 8; index++) {
			const batch = transcript.peekFinalizedBatch(100, 3);
			if (!batch) break;
			history.push(...batch.rows);
			transcript.acknowledgeFinalizedBatch(batch.id);
		}
		expect(history.join("\n")).not.toContain("ACTIVE_DIFF_");
		transcript.setCompactTurnActive(false);
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

	it("caps independently displayed file diff sections at three across multi-file edit calls", () => {
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
		for (const view of [Bun.stripANSI(transcript.render(100).join("\n")), nativeTranscriptView(transcript)]) {
			expect(view).not.toContain("FILE_SECTION_0");
			for (let index = 1; index < 4; index++) expect(view).toContain(`FILE_SECTION_${index}`);
		}
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

	it("never sends hidden thinking markdown to native expansion and keeps its ANSI pulse on one row", () => {
		const component = new AssistantMessageComponent(undefined, true);
		components.push(component);
		const message = assistant([{ type: "thinking", thinking: "PRIVATE_THINKING\ncontinued" }]);
		component.updateContent(message, { transient: true });
		component.handleNativeEvent({ type: "toggle", key: "k0", collapsed: false });
		expect(JSON.stringify(component.describe(toolCx))).not.toContain("PRIVATE_THINKING");
		expect(nodes(component.describe(toolCx)).some(node => node.k === "elapsed")).toBe(true);
		const rows = component.render(12).filter(row => Bun.stripANSI(row).trim());
		expect(rows).toHaveLength(1);
		expect(Bun.stripANSI(component.render(80).join("\n"))).toMatch(/Thinking \d+s/);
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

	it("preserves eval intent precedence and executable-only Bash summaries through xd dispatch", () => {
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
		expect(Bun.stripANSI(shell.render(100)[0])).toContain("bun");
		expect(JSON.stringify(shell.describe(toolCx))).not.toContain("PRIVATE");
		expect(shell.render(100).join("\n")).not.toContain("TOKEN");
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
