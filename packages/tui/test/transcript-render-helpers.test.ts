import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { createCustomMessage } from "@oh-my-pi/pi-agent-core/compaction/messages";
import type { Usage } from "@oh-my-pi/pi-ai";
import {
	chatTranscriptDisplayPreferences,
	setChatTranscriptDisplayPreferences,
} from "@oh-my-pi/pi-tui/chat/display-preferences";
import {
	assistantUsageIsBilled,
	buildAsyncResultBlock,
	buildLaunchCompletionBlock,
} from "@oh-my-pi/pi-tui/chat/transcript-render-helpers";
import { setNativeRendering } from "@oh-my-pi/pi-tui/native/state";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { TspHarness } from "./native/tsp-harness";

function usage(overrides: Partial<Usage> = {}): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		...overrides,
	};
}

describe("assistantUsageIsBilled", () => {
	it("suppresses the token badge only for turns that consumed nothing", () => {
		expect(assistantUsageIsBilled(usage())).toBe(false);
	});

	it("preserves cost transparency for empty replies whose prompt still cost input tokens", () => {
		expect(assistantUsageIsBilled(usage({ input: 321 }))).toBe(true);
		expect(assistantUsageIsBilled(usage({ output: 0, cacheRead: 512 }))).toBe(true);
		expect(assistantUsageIsBilled(usage({ cacheWrite: 128 }))).toBe(true);
		expect(assistantUsageIsBilled(usage({ premiumRequests: 1 }))).toBe(true);
	});
});

describe("background receipt projections", () => {
	const previous = { ...chatTranscriptDisplayPreferences };
	let harness: TspHarness | undefined;

	beforeAll(async () => {
		await initTheme(false);
	});
	afterEach(() => {
		harness?.stop();
		harness = undefined;
		setNativeRendering(false);
		setChatTranscriptDisplayPreferences(previous);
	});

	it("keeps failed and cancelled receipts in compact history while hiding successful ones", async () => {
		const message = createCustomMessage(
			"async-result",
			"results",
			true,
			{
				jobs: [
					{ jobId: "ok", type: "bash", status: "completed", durationMs: 1000 },
					{ jobId: "bad", type: "bash", status: "failed", durationMs: 2000 },
					{ jobId: "stopped", type: "bash", status: "cancelled", durationMs: 3000 },
					{ jobId: "warning", type: "bash", status: "completed", meta: { artifactError: "write" } },
				],
			},
			"2026",
		);
		for (const current of [message, JSON.parse(JSON.stringify(message)) as typeof message]) {
			const block = buildAsyncResultBlock(current);
			setChatTranscriptDisplayPreferences({ compactToolActivity: true });
			const compact = Bun.stripANSI(block.render(160).join("\n"));
			expect(compact).toContain("Background job failed [bash] bad");
			expect(compact).toContain("Background job cancelled [bash] stopped");
			expect(compact).not.toContain("[bash] ok");
			expect(compact).not.toContain("[bash] warning");
			expect(compact).toContain("artifact write failed");
			setChatTranscriptDisplayPreferences({ compactToolActivity: false });
			const detailed = Bun.stripANSI(block.render(160).join("\n"));
			expect(detailed).toContain("[bash] ok");
			expect(detailed).toContain("[bash] bad");
			expect(detailed).toContain("[bash] stopped");
		}
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		harness = await TspHarness.start(tui => tui.addChild(buildAsyncResultBlock(message)), { cols: 160, rows: 20 });
		await harness.render();
		const native = JSON.stringify(harness.doc());
		expect(native).toContain("bad");
		expect(native).toContain("stopped");
		expect(native).not.toContain('"ok"');
		expect(native).toContain("artifact write failed");
	});

	it("suppresses associated Bash receipt rows without suppressing independent diagnostics", () => {
		const message = createCustomMessage(
			"async-result",
			"results",
			true,
			{
				jobs: [
					{ jobId: "bad", type: "bash", status: "failed", meta: { artifactError: "write" } },
					{ jobId: "other", type: "bash", status: "failed" },
				],
			},
			"2026",
		);
		for (const compactToolActivity of [false, true]) {
			setChatTranscriptDisplayPreferences({ compactToolActivity });
			const output = Bun.stripANSI(
				buildAsyncResultBlock(message, new Map([["bad", "failed"]]))
					.render(160)
					.join("\n"),
			);
			expect(output).not.toContain("[bash] bad");
			expect(output).toContain("[bash] other");
			expect(output).toContain("artifact write failed");
		}
	});

	it("retains failed process exits and hides successful exits in compact mode", async () => {
		const message = createCustomMessage(
			"launch-completion",
			"processes exited",
			true,
			{
				daemons: [
					{ name: "healthy", state: "exited", exitCode: 0, startedAt: 1000, exitedAt: 2000 },
					{ name: "failed-state", state: "failed", exitCode: 0, startedAt: 1000, exitedAt: 3100 },
					{ name: "nonzero", state: "exited", exitCode: 7, startedAt: 1000, exitedAt: 4200 },
				],
			},
			"2026",
		);
		const original = JSON.stringify(message);
		for (const current of [message, JSON.parse(original) as typeof message]) {
			const block = buildLaunchCompletionBlock(current);
			setChatTranscriptDisplayPreferences({ compactToolActivity: true });
			const compact = block
				.render(200)
				.map(line => Bun.stripANSI(line))
				.join("\n");
			expect(compact).toMatch(
				/Supervised process failed failed-state \(exit 0\) \(2\.1s\)[^]*Supervised process failed nonzero \(exit 7\) \(3\.2s\)/,
			);
			expect(compact).not.toContain("healthy");
			setChatTranscriptDisplayPreferences({ compactToolActivity: false });
			expect(
				block
					.render(200)
					.map(line => Bun.stripANSI(line))
					.join("\n"),
			).toContain("Supervised process completed healthy");
			setChatTranscriptDisplayPreferences({ compactToolActivity: true });
			expect(
				block
					.render(200)
					.map(line => Bun.stripANSI(line))
					.join("\n"),
			).toBe(compact);
			block.setToolActivityVisible(false);
			expect(block.render(200)).toEqual([]);
		}
		expect(JSON.stringify(message)).toBe(original);
		harness = await TspHarness.start(tui => tui.addChild(buildLaunchCompletionBlock(message)), {
			cols: 200,
			rows: 30,
		});
		await harness.render();
		const native = JSON.stringify(harness.doc());
		expect(native).toContain("failed-state");
		expect(native).toContain("nonzero");
		expect(native).toContain("exit 7");
		expect(native).not.toContain("healthy");
	});
});
