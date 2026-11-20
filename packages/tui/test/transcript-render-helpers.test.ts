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

	it("shows unrepresented bash and eval statuses, but not task receipts, with visible tool activity", async () => {
		const message = createCustomMessage(
			"async-result",
			"results",
			true,
			{
				jobs: [
					{ jobId: "bash-complete", type: "bash", status: "completed", durationMs: 1000 },
					{ jobId: "bash-failed", type: "bash", status: "failed", label: "compile project" },
					{ jobId: "bash-cancelled", type: "bash", status: "cancelled" },
					{ jobId: "task-failed", type: "task", status: "failed" },
					{ jobId: "task-complete", type: "task", status: "completed" },
					{ jobId: "eval-cancelled", type: "eval", status: "cancelled" },
					{ jobId: "eval-running", type: "eval", status: "running" },
				],
			},
			"2026",
		);
		const original = JSON.stringify(message);
		// Build without original tool cards: task receipts alone never add status rows.
		const block = buildAsyncResultBlock(message);
		harness = await TspHarness.start(tui => tui.addChild(block), { cols: 160, rows: 20 });
		await harness.render();
		for (const output of [Bun.stripANSI(block.render(160).join("\n")), JSON.stringify(harness.doc())]) {
			expect(output).toContain("Background job completed");
			expect(output).toContain("bash-complete");
			expect(output).toContain("Background job failed");
			expect(output).toContain("bash-failed");
			expect(output).toContain("compile project");
			expect(output).toContain("Background job cancelled");
			expect(output).toContain("bash-cancelled");
			expect(output).toContain("eval-cancelled");
			expect(output).not.toContain("task-failed");
			expect(output).not.toContain("task-complete");
			expect(output).not.toContain("eval-running");
		}

		block.setToolActivityVisible(false);
		expect(block.render(160)).toEqual([]);
		await harness.render();
		expect(harness.find(node => node.p?.role === "omp.activity")?.p?.hidden).toBe(true);
		expect(JSON.stringify(message)).toBe(original);
	});

	it("suppresses a standalone task status without an original card", async () => {
		const message = createCustomMessage(
			"async-result",
			"single result",
			true,
			{ jobId: "single-task", type: "task", status: "failed" },
			"2026",
		);
		const block = buildAsyncResultBlock(message);
		expect(block.render(160)).toEqual([]);
		harness = await TspHarness.start(tui => tui.addChild(block), { cols: 160, rows: 20 });
		await harness.render();
		const native = JSON.stringify(harness.doc());
		expect(native).not.toContain("single-task");
		expect(native).not.toContain("Background job failed");
	});

	it("keeps task diagnostics but omits status rows for cancelled tasks", async () => {
		const message = createCustomMessage(
			"async-result",
			"results",
			true,
			{
				jobs: [
					{
						jobId: "diagnostic-task",
						type: "task",
						status: "failed",
						meta: { artifactError: "write" },
						schema: { status: "invalid", error: "invalid output" },
					},
					{ jobId: "cancelled-task", type: "task", status: "cancelled" },
				],
			},
			"2026",
		);
		const original = JSON.stringify(message);
		const block = buildAsyncResultBlock(message);
		harness = await TspHarness.start(tui => tui.addChild(block), { cols: 160, rows: 20 });
		await harness.render();
		for (const output of [Bun.stripANSI(block.render(160).join("\n")), JSON.stringify(harness.doc())]) {
			expect(output).toContain("artifact write failed");
			expect(output).toContain("invalid output");
			expect(output).not.toContain("Background job failed");
			expect(output).not.toContain("Background job cancelled");
			expect(output).not.toContain("cancelled-task");
		}
		expect(JSON.stringify(message)).toBe(original);
	});

	it("keeps process exit details with visible tool activity and hides receipts otherwise", async () => {
		const message = createCustomMessage(
			"launch-completion",
			"processes exited",
			true,
			{
				daemons: [
					{ name: "healthy", state: "exited", exitCode: 0, startedAt: 1000, exitedAt: 2000 },
					{ name: "failed-state", state: "failed", exitCode: 0, startedAt: 1000, exitedAt: 3100 },
					{ name: "nonzero", state: "exited", exitCode: 7, startedAt: 1000, exitedAt: 4200 },
					{ name: "unknown-exit", state: "exited", startedAt: 1000, exitedAt: 4300 },
					{ name: "failed-unknown", state: "failed", startedAt: 1000, exitedAt: 4400 },
				],
			},
			"2026",
		);
		const original = JSON.stringify(message);
		for (const current of [message, JSON.parse(original) as typeof message]) {
			const block = buildLaunchCompletionBlock(current);
			setChatTranscriptDisplayPreferences({ hideToolActivity: false });
			expect(
				block
					.render(200)
					.map(line => Bun.stripANSI(line))
					.join("\n"),
			).toContain("Supervised process completed healthy");
			expect(Bun.stripANSI(block.render(200).join("\n"))).toContain("unknown-exit");
			setChatTranscriptDisplayPreferences({ hideToolActivity: true });
			block.setToolActivityVisible(false);
			expect(block.render(200)).toEqual([]);
		}
		expect(JSON.stringify(message)).toBe(original);
		setChatTranscriptDisplayPreferences({ hideToolActivity: false });
		harness = await TspHarness.start(tui => tui.addChild(buildLaunchCompletionBlock(message)), {
			cols: 200,
			rows: 30,
		});
		await harness.render();
		const native = JSON.stringify(harness.doc());
		expect(native).toContain("failed-state");
		expect(native).toContain("nonzero");
		expect(native).toContain("exit 7");
		expect(native).toContain("healthy");
		expect(native).toContain("unknown-exit");
		expect(native).toContain("failed-unknown");
	});
});
