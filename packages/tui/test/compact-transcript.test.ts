import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ImageContent } from "@oh-my-pi/pi-ai";
import { AssistantMessageComponent } from "../src/chat/assistant-message";
import { ChatTranscriptBuilder } from "../src/chat/chat-transcript-builder";
import { chatTranscriptDisplayPreferences, setChatTranscriptDisplayPreferences } from "../src/chat/display-preferences";
import { ReadToolGroupComponent } from "../src/chat/read-tool-group";
import { stopSharedSpinnerTicker, ToolExecutionComponent } from "../src/chat/tool-execution";
import { Text } from "../src/components/text";
import { TranscriptContainer } from "../src/chrome/transcript-container";
import { md } from "../src/native/describe";
import type { DescribeContext, NativeNode } from "../src/native/node";
import { COMPOSER_DEFAULTS, Composer } from "../src/prompt/composer";
import { initTheme } from "../src/theme";
import { Container } from "../src/tui";
import type { TUI } from "../src/tui";
import { setTerminalImageProtocol, TERMINAL } from "../src/terminal-capabilities";
import type { CoordinationDetails } from "../src/tools/wait";
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
	it("keeps failure causes and file identities visible in narrow rows on both render paths", () => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		const path = `F:/projects/${"deep/".repeat(30)}missing.ts:2-4`;
		const result = {
			content: [{ type: "text" as const, text: `Path '${path}' not found\nPRIVATE_BODY` }],
			isError: true,
		};
		const component = new ToolExecutionComponent("read", { path }, {}, undefined, {
			requestRender() {},
			requestComponentRender() {},
			resetDisplay() {},
		});
		components.push(component);
		component.updateResult(result);
		const group = new ReadToolGroupComponent({ showContentPreview: true });
		components.push(group);
		group.updateArgs({ path }, "missing");
		group.updateResult(result, false, "missing");
		for (const block of [component, group]) {
			const row = Bun.stripANSI(block.render(70)[0]);
			expect(row).toContain("文件或路径不存在");
			expect(row).toContain("missing.ts:2-4");
			expect(row).not.toContain("deep/");
			const native = JSON.stringify(block.describe(toolCx));
			expect(native).toContain("文件或路径不存在");
			expect(native).toContain("missing.ts:2-4");
			expect(native).not.toContain("PRIVATE_BODY");
		}
	});

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
				}
			}
		}
	});

	it("shows the failing shell exit code without exposing stdout in the compact failure summary", () => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		const component = new ToolExecutionComponent(
			"bash",
			{ command: "echo PRIVATE_STDOUT; exit 7", i: "检查退出状态" },
			{},
			undefined,
			{ requestRender() {}, requestComponentRender() {}, resetDisplay() {} },
		);
		components.push(component);
		component.updateResult({
			content: [{ type: "text", text: "PRIVATE_STDOUT\n\n[Process exited with code 7]" }],
			details: { exitCode: 7 },
			isError: true,
		});
		component.setExpanded(true);
		for (const view of [
			Bun.stripANSI(component.render(100).join("\n")),
			JSON.stringify(component.describe(toolCx)),
			JSON.stringify(component.describe()),
		]) {
			expect(view).toContain("7");
			expect(view).toContain("检查退出状态");
			expect(view).not.toContain("PRIVATE_STDOUT");
		}
		expect(nodes(component.describe(toolCx)).find(node => node.k === "tool")?.p?.status).toBe("error");
	});

	it("retains internal-URL read conflict warnings outside the folded-success budget", () => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		const transcript = new TranscriptContainer();
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
		for (let index = 0; index < 4; index++) {
			const success = new ToolExecutionComponent("grep", { pattern: `success-${index}` }, {}, undefined, {
				requestRender() {},
				requestComponentRender() {},
				resetDisplay() {},
			});
			components.push(success);
			success.updateResult({ content: [{ type: "text", text: "PRIVATE_SUCCESS_BODY" }] });
			transcript.addChild(success);
		}
		const views = [
			Bun.stripANSI(transcript.render(100).join("\n")),
			...([toolCx, { ...toolCx, supports: () => false }] as const).map(cx =>
				transcript
					.nativeBlocks()
					.map(block => JSON.stringify(block.describe?.(cx)))
					.join("\n"),
			),
		];
		for (const view of views) {
			expect(view).toContain("conflicted.ts");
			expect(view).toContain("2 conflicts");
			expect(view).toContain("已收起 2 次成功调用");
			for (let index = 0; index < 2; index++) expect(view).not.toContain(`success-${index}`);
			for (let index = 2; index < 4; index++) expect(view).toContain(`success-${index}`);
			expect(view).not.toContain("PRIVATE_");
		}
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

	it("P2-22 retains conflict read warnings without counting them as folded successes on both render paths", () => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		const transcript = new TranscriptContainer();
		const group = new ReadToolGroupComponent({ showContentPreview: true });
		components.push(group);
		transcript.addChild(group);
		group.updateArgs({ path: "conflicted.ts" }, "conflict");
		group.updateResult(
			{
				content: [{ type: "text", text: "PRIVATE_CONFLICT_BODY" }],
				details: { conflictCount: 2 },
			},
			false,
			"conflict",
		);
		for (let index = 0; index < 4; index++) {
			const id = `success-${index}`;
			group.updateArgs({ path: `${id}.ts` }, id);
			group.updateResult({ content: [{ type: "text", text: "PRIVATE_READ_BODY" }] }, false, id);
		}
		group.finalize();

		const ansi = transcript.render(100).map(row => Bun.stripANSI(row));
		const native = transcript
			.nativeBlocks()
			.map(block => JSON.stringify(block.describe?.(toolCx)))
			.join("\n");
		for (const view of [ansi.join("\n"), native]) {
			expect(view).toContain("conflicted.ts");
			expect(view).toContain("2 conflicts");
			expect(view).toContain("已收起 2 次成功调用");
			for (let index = 0; index < 2; index++) expect(view).not.toContain(`success-${index}.ts`);
			for (let index = 2; index < 4; index++) expect(view).toContain(`success-${index}.ts`);
			expect(view).not.toContain("PRIVATE_");
		}
		expect(ansi).toHaveLength(4);
	});

	it.each(["failure", "warning"] as const)(
		"P2-24 retires overflowing compact %s rows to scrollback without losing call identities",
		kind => {
			setChatTranscriptDisplayPreferences({ compactToolActivity: true });
			const transcript = new TranscriptContainer();
			const targets = Array.from({ length: 8 }, (_, index) => `${kind}-${index}.ts`);
			for (const target of targets) {
				if (kind === "failure") {
					const component = new ToolExecutionComponent("read", { path: target }, {}, undefined, {
						requestRender() {},
						requestComponentRender() {},
						resetDisplay() {},
					});
					components.push(component);
					component.updateResult({
						content: [{ type: "text", text: "Permission denied\nPRIVATE_FAILURE_BODY" }],
						isError: true,
					});
					transcript.addChild(component);
				} else {
					const group = new ReadToolGroupComponent({ showContentPreview: true });
					components.push(group);
					group.updateArgs({ path: `${target}.missing` }, target);
					group.updateResult(
						{
							content: [{ type: "text", text: "PRIVATE_WARNING_BODY" }],
							details: { suffixResolution: { from: `${target}.missing`, to: target } },
						},
						false,
						target,
					);
					group.finalize();
					transcript.addChild(group);
				}
			}
			const frame = { tick: 0, now: 0 };
			transcript.renderViewport(100, 3, frame);
			const history: string[] = [];
			for (let index = 0; index <= targets.length; index++) {
				const batch = transcript.peekFinalizedBatch(100, 3);
				if (!batch) break;
				history.push(...batch.rows);
				transcript.acknowledgeFinalizedBatch(batch.id);
			}
			expect(Bun.stripANSI(history.join("\n"))).toContain(targets[0]!);
			const viewport = transcript.renderViewport(100, 3, { tick: 1, now: 1 });
			expect(viewport.length).toBeLessThanOrEqual(3);
			const visibleHistory = [...history, ...viewport].map(row => Bun.stripANSI(row));
			for (const target of targets) {
				expect(visibleHistory.filter(row => row.includes(target))).toHaveLength(1);
			}
			expect(visibleHistory.join("\n")).not.toContain("PRIVATE_");
		},
	);

	it.each(["failure", "warning", "grouped failure", "grouped warning"] as const)(
		"P2-24 retains a success followed by overflowing %s rows and replays one whole-run success summary",
		kind => {
			setChatTranscriptDisplayPreferences({ compactToolActivity: true });
			const transcript = new TranscriptContainer();
			const grouped = kind.startsWith("grouped");
			const warning = kind.endsWith("warning");
			const group = grouped ? new ReadToolGroupComponent({ showContentPreview: true }) : undefined;
			if (group) {
				components.push(group);
				transcript.addChild(group);
				group.updateArgs({ path: "success-prefix.ts" }, "success-prefix");
				group.updateResult(
					{ content: [{ type: "text", text: "PRIVATE_PREFIX_SUCCESS" }] },
					false,
					"success-prefix",
				);
			}
			const addSuccess = (path: string) => {
				const component = new ToolExecutionComponent("read", { path }, {}, undefined, {
					requestRender() {},
					requestComponentRender() {},
					resetDisplay() {},
				});
				components.push(component);
				component.updateResult({ content: [{ type: "text", text: "PRIVATE_SUCCESS" }] });
				transcript.addChild(component);
			};
			if (!group) addSuccess("success-prefix.ts");
			const targets = Array.from({ length: 8 }, (_, index) => `failure-${index}.ts`);
			for (const target of targets) {
				if (group || warning) {
					const reads = group ?? new ReadToolGroupComponent({ showContentPreview: true });
					if (!group) {
						components.push(reads);
						transcript.addChild(reads);
					}
					reads.updateArgs({ path: target }, target);
					reads.updateResult(
						{
							content: [{ type: "text", text: "Permission denied\nPRIVATE_RETAINED_BODY" }],
							isError: !warning,
							...(warning ? { details: { conflictCount: 2 } } : {}),
						},
						false,
						target,
					);
					if (!group) reads.finalize();
				} else {
					const component = new ToolExecutionComponent("read", { path: target }, {}, undefined, {
						requestRender() {},
						requestComponentRender() {},
						resetDisplay() {},
					});
					components.push(component);
					component.updateResult({
						content: [{ type: "text", text: "Permission denied\nPRIVATE_RETAINED_BODY" }],
						isError: true,
					});
					transcript.addChild(component);
				}
			}
			group?.finalize();
			setChatTranscriptDisplayPreferences({ compactToolActivity: false });
			const originalDetailed = transcript.render(100).join("\n").trimEnd();
			const originalNativeDetailed = transcript
				.nativeBlocks()
				.map(block => JSON.stringify(block.describe?.(toolCx)))
				.join("\n");
			setChatTranscriptDisplayPreferences({ compactToolActivity: true });
			const history: string[] = [];
			const retire = (capacity: number) => {
				for (let index = 0; index < 32; index++) {
					const batch = transcript.peekFinalizedBatch(100, capacity);
					if (!batch) break;
					if (batch.kind === "replay") history.length = 0;
					history.push(...batch.rows);
					transcript.acknowledgeFinalizedBatch(batch.id);
				}
				return Bun.stripANSI(
					[...history, ...transcript.renderViewport(100, capacity, { tick: 0, now: 0 })].join("\n"),
				);
			};
			// The original failure: a single earlier success pinned all eight
			// retained rows, leaving failure-0 through failure-4 unreachable.
			const initial = retire(3);
			expect(history.length).toBeGreaterThan(0);
			for (const target of ["success-prefix.ts", ...targets]) {
				expect(initial.split("\n").filter(row => row.includes(target))).toHaveLength(1);
			}
			for (let index = 0; index < 6; index++) addSuccess(`saved-${index}.ts`);
			for (const [last, folded] of [
				[5, 5],
				[6, 6],
			] as const) {
				if (last === 6) addSuccess("saved-6.ts");
				const ansi = retire(4);
				const native = transcript
					.nativeBlocks()
					.map(block => JSON.stringify(block.describe?.(toolCx)))
					.join("\n");
				for (const view of [ansi, native]) {
					expect(view.match(new RegExp(`已收起 ${folded} 次成功调用`, "g"))).toHaveLength(1);
					if (!warning) expect(view).toContain("失败 8 次（保留）");
					expect(view).not.toContain("success-prefix.ts");
					for (let index = 0; index <= last; index++) {
						if (index <= last - 2) expect(view).not.toContain(`saved-${index}.ts`);
						else expect(view).toContain(`saved-${index}.ts`);
					}
					for (const target of targets) {
						expect(view.split("\n").filter(row => row.includes(target))).toHaveLength(1);
					}
					expect(view).not.toContain("PRIVATE_");
				}
			}
			setChatTranscriptDisplayPreferences({ compactToolActivity: false });
			const detailed = transcript.render(100).join("\n");
			const nativeDetailed = transcript
				.nativeBlocks()
				.map(block => JSON.stringify(block.describe?.(toolCx)))
				.join("\n");
			for (const view of [detailed, nativeDetailed]) {
				for (const target of ["success-prefix.ts", ...targets]) expect(view).toContain(target);
				for (let index = 0; index < 7; index++) expect(view).toContain(`saved-${index}.ts`);
			}
			expect(detailed).toContain(originalDetailed);
			expect(nativeDetailed).toContain(originalNativeDetailed);
		},
	);

	it.each(["first offer", "reoffered", "reoffered without header", "reoffered with unmounted header"] as const)(
		"replaces retired compact history through composer and TUI on %s",
		async mode => {
			setChatTranscriptDisplayPreferences({ compactToolActivity: true });
			const terminal = new VirtualTerminal(100, 4);
			terminal.write(`PREVIOUS_SHELL_HISTORY${"\r\n".repeat(6)}`);
			const scheduler = new VirtualRenderScheduler();
			const composer = new Composer({
				terminal,
				tuiOptions: { renderScheduler: scheduler },
				preferences: { ...COMPOSER_DEFAULTS, quiet: true },
			});
			const hasHeader = mode !== "reoffered without header";
			if (hasHeader) composer.setHeaderExtras([new Text("RETIRED_COMPOSER_HEADER", 0, 0)], []);
			const transcript = new TranscriptContainer();
			const addTool = (path: string, isError = false) => {
				const component = new ToolExecutionComponent("read", { path }, {}, undefined, composer.ui);
				components.push(component);
				component.updateResult({
					content: [{ type: "text", text: isError ? "Permission denied\nPRIVATE_FAILURE" : "PRIVATE_SUCCESS" }],
					isError,
				});
				transcript.addChild(component);
			};
			addTool("success-prefix.ts");
			const failures = Array.from({ length: 8 }, (_, index) => `failure-${index}.ts`);
			for (const path of failures) addTool(path, true);
			composer.setRuntimeChildren([transcript, new Text("EDITOR", 0, 0)]);
			composer.start({ playWelcomeIntro: false });
			try {
				await scheduler.settle(terminal);
				const initial = terminal.getScrollBuffer().join("\n");
				expect(initial).toContain("PREVIOUS_SHELL_HISTORY");
				for (const path of ["success-prefix.ts", ...failures]) {
					expect(initial.split("\n").filter(row => row.includes(path))).toHaveLength(1);
				}
				if (hasHeader) {
					expect(initial.split("\n").filter(row => row.includes("RETIRED_COMPOSER_HEADER"))).toHaveLength(1);
					expect(terminal.getViewport().join("\n")).not.toContain("RETIRED_COMPOSER_HEADER");
				}
				if (mode === "reoffered with unmounted header") composer.setHeaderExtras([], []);
				for (let index = 0; index < 6; index++) addTool(`saved-${index}.ts`);
				for (const [last, folded] of [
					[5, 5],
					[6, 6],
				] as const) {
					if (last === 6) addTool("saved-6.ts");
					if (mode !== "first offer") {
						// Discard an actual composer frame and recompose its outstanding
						// offer at another width before the TUI consumes it at 100 columns.
						const discarded = composer.renderFrame({ columns: 100, rows: 4 });
						expect(discarded.history?.kind).toBe("replay");
						composer.renderFrame({ columns: 96, rows: 4 });
					}
					composer.ui.requestRender();
					await scheduler.settle(terminal);
					const visible = terminal.getScrollBuffer().join("\n");
					// This shell row can only disappear if the real TUI consumes the
					// destructive flag, rather than appending the replacement ledger.
					expect(visible).not.toContain("PREVIOUS_SHELL_HISTORY");
					if (hasHeader) {
						expect(visible.split("\n").filter(row => row.includes("RETIRED_COMPOSER_HEADER"))).toHaveLength(1);
					}
					expect(visible.match(new RegExp(`已收起 ${folded} 次成功调用`, "g"))).toHaveLength(1);
					expect(visible).toContain("失败 8 次（保留）");
					expect(visible).not.toContain("success-prefix.ts");
					for (const path of failures) {
						expect(visible.split("\n").filter(row => row.includes(path))).toHaveLength(1);
					}
					for (let index = 0; index <= last; index++) {
						const matching = visible.split("\n").filter(row => row.includes(`saved-${index}.ts`));
						expect(matching).toHaveLength(index <= last - 2 ? 0 : 1);
					}
					expect(visible).not.toContain("PRIVATE_");
					expect(terminal.getViewport().join("\n")).toContain("EDITOR");
				}
			} finally {
				composer.stop();
			}
		},
	);

	it("keeps a growing success summary mutable after retiring a failed prefix", () => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		const transcript = new TranscriptContainer();
		const add = (path: string, isError = false) => {
			const component = new ToolExecutionComponent("read", { path }, {}, undefined, {
				requestRender() {},
				requestComponentRender() {},
				resetDisplay() {},
			});
			components.push(component);
			component.updateResult({
				content: [{ type: "text", text: isError ? "Permission denied\nPRIVATE_FAILURE" : "PRIVATE_SUCCESS" }],
				isError,
			});
			transcript.addChild(component);
		};
		for (let index = 0; index < 5; index++) add(`failed-${index}.ts`, true);
		for (let index = 0; index < 5; index++) add(`saved-${index}.ts`);
		const history: string[] = [];
		for (let index = 0; index < 8; index++) {
			const batch = transcript.peekFinalizedBatch(100, 3);
			if (!batch) break;
			history.push(...batch.rows);
			transcript.acknowledgeFinalizedBatch(batch.id);
		}
		expect(Bun.stripANSI(history.join("\n"))).not.toContain("已收起");
		for (let index = 0; index < 5; index++) {
			expect(history.filter(row => row.includes(`failed-${index}.ts`))).toHaveLength(1);
		}
		add("saved-5.ts");
		expect(transcript.peekFinalizedBatch(100, 3)).toBeUndefined();
		const viewport = transcript.renderViewport(100, 3, { tick: 0, now: 0 });
		const ansi = Bun.stripANSI(viewport.join("\n"));
		const native = transcript
			.nativeBlocks()
			.map(block => JSON.stringify(block.describe?.(toolCx)))
			.join("\n");
		for (const view of [ansi, native]) {
			expect(view.match(/已收起 4 次成功调用/g)).toHaveLength(1);
			for (let index = 4; index < 6; index++) expect(view).toContain(`saved-${index}.ts`);
			for (let index = 0; index < 4; index++) expect(view).not.toContain(`saved-${index}.ts`);
			expect(view).not.toContain("PRIVATE_");
		}
		setChatTranscriptDisplayPreferences({ compactToolActivity: false });
		const detailed = transcript.render(100).join("\n");
		for (let index = 0; index < 6; index++) expect(detailed).toContain(`saved-${index}.ts`);
		for (let index = 0; index < 5; index++) expect(detailed).toContain(`failed-${index}.ts`);
		expect(detailed).toContain("PRIVATE_FAILURE");
	});

	it.each([
		{ __synthetic: true, source: "interrupt_skipped", executed: false },
		{ __interrupted: true, source: "interrupt_skipped", execution: "started" },
	])("P2-26 keeps the folded success summary visible after a skipped leading wait: %j", details => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		const transcript = new TranscriptContainer();
		const skipped = new ToolExecutionComponent("wait", {}, {}, undefined, {
			requestRender() {},
			requestComponentRender() {},
			resetDisplay() {},
		});
		components.push(skipped);
		skipped.updateResult({
			content: [{ type: "text", text: "Skipped due to pending system advisory." }],
			details,
		});
		transcript.addChild(skipped);
		for (let index = 0; index < 5; index++) {
			const component = new ToolExecutionComponent("read", { path: `written-${index}.ts` }, {}, undefined, {
				requestRender() {},
				requestComponentRender() {},
				resetDisplay() {},
			});
			components.push(component);
			component.updateResult({ content: [{ type: "text", text: "PRIVATE_WRITE_BODY" }] });
			transcript.addChild(component);
		}
		const ansi = transcript.render(100).map(row => Bun.stripANSI(row));
		const native = transcript
			.nativeBlocks()
			.map(block => JSON.stringify(block.describe?.(toolCx)))
			.join("\n");
		for (const view of [ansi.join("\n"), native]) {
			expect(view.match(/已收起 3 次成功调用/g)).toHaveLength(1);
			for (let index = 3; index < 5; index++) expect(view).toContain(`written-${index}.ts`);
			for (let index = 0; index < 3; index++) expect(view).not.toContain(`written-${index}.ts`);
			expect(view).not.toContain("Skipped due");
			expect(view).not.toContain("PRIVATE_");
		}
		expect(ansi).toHaveLength(3);
	});

	it("counts folded successes separately from visible failures and staged proposals", () => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		const transcript = new TranscriptContainer();
		const make = (name: string, details = {}, isError = false) => {
			const component = new ToolExecutionComponent(name, {}, {}, undefined, {
				requestRender() {},
				requestComponentRender() {},
				resetDisplay() {},
			});
			components.push(component);
			component.updateResult({
				content: [{ type: "text", text: isError ? "Permission denied" : "receipt" }],
				details,
				isError,
			});
			transcript.addChild(component);
			return component;
		};
		const proposal = make("ast_edit", { applied: false, totalReplacements: 1 });
		const failure = make("read", {}, true);
		for (let i = 0; i < 5; i++) make("write");
		const rows = transcript.render(100).map(row => Bun.stripANSI(row));
		expect(rows.join("\n")).toContain("已收起 3 次成功调用 · 失败 1 次（保留）");
		expect(rows.some(row => row.includes("待确认") && !row.includes("done"))).toBe(true);
		expect(rows.some(row => row.includes("Permission denied"))).toBe(true);
		expect(failure.getCompactToolFailureCount()).toBe(1);
		const pending = proposal.describe(toolCx);
		expect(JSON.stringify(pending)).toContain("待确认");
		expect(nodes(pending).find(node => node.k === "tool")?.p?.status).toBe("pending");
		const applied = make("write", {
			xdev: { tool: "resolve", inner: { action: "apply", sourceToolName: "ast_edit" } },
		});
		expect(Bun.stripANSI(applied.render(70)[0])).toContain("已应用");
		expect(JSON.stringify(applied.describe(toolCx))).toContain("已应用");
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

	it("bypasses custom output renderers through pending, progress, failure and expansion, then restores detail", () => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		let renders = 0;
		const tool = {
			name: "custom",
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
			"custom",
			{ path: "target.ts\ncontinued", payload: "PRIVATE_ARGUMENTS" },
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
		expect(Bun.stripANSI(component.render(80)[0])).toContain("Permission denied");
		for (const cx of [toolCx, undefined]) {
			const described = component.describe(cx);
			expect(JSON.stringify(described)).not.toContain("PRIVATE_");
			expect(nodes(described).some(node => node.k === "md" || node.k === "image")).toBe(false);
			if (described.k === "tool") {
				expect(described.p?.status).toBe("error");
				expect(described.p?.collapsible).toBe(false);
				expect(described.c ?? []).toHaveLength(0);
				expect(described.p?.took).toBeNumber();
			}
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
			expect(description.c).toHaveLength(2);
			expect(description.c?.map(child => ("k" in child ? child.key : undefined))).toEqual(["first", "second"]);
			expect(JSON.stringify(description)).not.toContain("PRIVATE_");
		}
		const rows = group.render(80).map(row => Bun.stripANSI(row));
		expect(rows).toHaveLength(2);
		expect(rows[0]).toContain("done");
		expect(rows[1]).toContain("error");
		expect(rows[1]).toContain("Denied");
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
						]),
					},
					...(["shell", "read", "mcp"] as const).map(id => ({
						type: "message" as const,
						id,
						parentId: { shell: "calls", read: "shell", mcp: "read" }[id],
						timestamp: "2026-10-18T00:00:00.000Z",
						message: {
							role: "toolResult" as const,
							toolCallId: id,
							toolName: { shell: "bash", read: "read", mcp: "mcp__fixture_probe" }[id],
							content: [{ type: "text" as const, text: `HISTORY_${id}_BODY` }],
							isError: false,
							timestamp: 1,
						},
					})),
				]);
				builder.setExpanded(true);
				const views = [
					Bun.stripANSI(builder.container.render(120).join("\n")),
					builder.container
						.nativeBlocks()
						.map(block => JSON.stringify(block.describe?.(toolCx)))
						.join("\n"),
				];
				for (const view of views) {
					for (const id of ["shell", "read", "mcp"]) expect(view).toContain(`HISTORY_${id}_BODY`);
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
