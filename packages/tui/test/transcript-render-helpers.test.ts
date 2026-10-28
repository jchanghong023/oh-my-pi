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

	it("filters mixed receipts individually without losing warnings or changing the message", async () => {
		const message = createCustomMessage(
			"async-result",
			"original result",
			true,
			{
				jobs: [
					{ jobId: "ok", type: "bash", status: "completed", durationMs: 1000, meta: { artifactError: "write" } },
					{ jobId: "bad", type: "task", status: "failed", durationMs: 2100 },
					{ jobId: "stopped", type: "bash", status: "cancelled", durationMs: 3200 },
					{
						jobId: "schema-ok",
						type: "task",
						status: "completed",
						durationMs: 4000,
						schema: { source: "caller", mode: "permissive", status: "invalid", error: "invalid payload" },
					},
				],
			},
			"2026",
		);
		const original = JSON.stringify(message);
		const persisted = JSON.parse(original) as typeof message;
		for (const current of [message, persisted]) {
			const block = buildAsyncResultBlock(current);
			setChatTranscriptDisplayPreferences({ compactToolActivity: true });
			const compact = block
				.render(200)
				.map(line => Bun.stripANSI(line))
				.join("\n");
			expect(compact).toMatch(
				/artifact write failed[^]*Background job failed \[task\] bad \(2\.1s\)[^]*Background job cancelled \[bash\] stopped \(3\.2s\)[^]*schema-ok: Structured output invalid: invalid payload/,
			);
			expect(compact).not.toContain("[bash] ok");
			expect(compact).not.toContain("[task] schema-ok");
			setChatTranscriptDisplayPreferences({ compactToolActivity: false });
			const detailed = block
				.render(200)
				.map(line => Bun.stripANSI(line))
				.join("\n");
			expect(detailed).toMatch(
				/Background job completed \[bash\] ok[^]*Background job failed \[task\] bad[^]*Background job cancelled \[bash\] stopped[^]*Background job completed \[task\] schema-ok/,
			);
			expect(detailed).toContain("invalid payload");
			setChatTranscriptDisplayPreferences({ compactToolActivity: true });
			expect(
				block
					.render(200)
					.map(line => Bun.stripANSI(line))
					.join("\n"),
			).toBe(compact);
			block.setToolActivityVisible(false);
			expect(block.render(200)).toEqual([]);
			block.setToolActivityVisible(true);
			expect(
				block
					.render(200)
					.map(line => Bun.stripANSI(line))
					.join("\n"),
			).toBe(compact);
		}
		expect(JSON.stringify(message)).toBe(original);

		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		harness = await TspHarness.start(tui => tui.addChild(buildAsyncResultBlock(message)), { cols: 200, rows: 30 });
		await harness.render();
		const native = JSON.stringify(harness.doc());
		expect(native).toContain("Background job failed");
		expect(native).toContain("bad");
		expect(native).toContain("Background job cancelled");
		expect(native).toContain("stopped");
		expect(native).toContain("artifact write failed");
		expect(native).toContain("invalid payload");
		expect(native).not.toContain("Background job completed");
	});

	it("leaves no rows for ordinary successful receipts and restores them in detailed mode", async () => {
		const job = createCustomMessage(
			"async-result",
			"done",
			true,
			{ jobId: "success-job", type: "eval", status: "completed", durationMs: 1500 },
			"2026",
		);
		const process = createCustomMessage(
			"launch-completion",
			"done",
			true,
			{ daemons: [{ name: "success-process", state: "exited", exitCode: 0, startedAt: 0, exitedAt: 1500 }] },
			"2026",
		);
		const blocks = [buildAsyncResultBlock(job), buildLaunchCompletionBlock(process)];
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		for (const block of blocks) expect(block.render(120)).toEqual([]);
		harness = await TspHarness.start(
			tui => {
				for (const block of blocks) tui.addChild(block);
			},
			{ cols: 120, rows: 20 },
		);
		await harness.render();
		const native = JSON.stringify(harness.doc());
		expect(native).not.toContain("success-job");
		expect(native).not.toContain("success-process");
		setChatTranscriptDisplayPreferences({ compactToolActivity: false });
		expect(
			blocks[0]
				.render(120)
				.map(line => Bun.stripANSI(line))
				.join("\n"),
		).toContain("success-job");
		expect(
			blocks[1]
				.render(120)
				.map(line => Bun.stripANSI(line))
				.join("\n"),
		).toContain("success-process");
		await harness.render();
		const detailedNative = JSON.stringify(harness.doc());
		expect(detailedNative).toContain("success-job");
		expect(detailedNative).toContain("success-process");
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		await harness.render();
		const compactNative = JSON.stringify(harness.doc());
		expect(compactNative).not.toContain("success-job");
		expect(compactNative).not.toContain("success-process");
		setChatTranscriptDisplayPreferences({ compactToolActivity: false });
		for (const block of blocks) {
			block.setToolActivityVisible(false);
			expect(block.render(120)).toEqual([]);
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
