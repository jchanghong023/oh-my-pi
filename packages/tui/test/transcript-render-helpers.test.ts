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

	it("hides all async-result status rows without blank lines in live and restored history", async () => {
		const messages = [
			createCustomMessage(
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
			),
			createCustomMessage(
				"async-result",
				"single result",
				true,
				{ jobId: "single-job", type: "task", status: "failed" },
				"2026",
			),
		];
		for (const message of messages) {
			const original = JSON.stringify(message);
			for (const current of [message, JSON.parse(original) as typeof message]) {
				for (const compactToolActivity of [false, true]) {
					setChatTranscriptDisplayPreferences({ compactToolActivity });
					const block = buildAsyncResultBlock(current);
					expect(block.render(160)).toEqual([]);
					harness = await TspHarness.start(tui => tui.addChild(buildAsyncResultBlock(current)), {
						cols: 160,
						rows: 20,
					});
					await harness.render();
					const native = JSON.stringify(harness.doc());
					expect(native).not.toContain("Background job");
					expect(native).not.toContain("bash-failed");
					expect(native).not.toContain("task-failed");
					expect(native).not.toContain("eval-cancelled");
					expect(native).not.toContain("single-job");
					expect(native).not.toContain("compile project");
					harness.stop();
					harness = undefined;
				}
				expect(JSON.stringify(current)).toBe(original);
			}
			expect(JSON.stringify(message)).toBe(original);
		}
	});

	it("preserves independent artifact and schema diagnostics without status rows", async () => {
		const message = createCustomMessage(
			"async-result",
			"results",
			true,
			{
				jobs: [
					{
						jobId: "bad",
						type: "bash",
						status: "failed",
						label: "hidden command",
						meta: { artifactError: "write" },
						schema: { status: "invalid", error: "invalid output" },
					},
					{ jobId: "other", type: "task", status: "cancelled" },
				],
			},
			"2026",
		);
		const original = JSON.stringify(message);
		for (const current of [message, JSON.parse(original) as typeof message]) {
			for (const compactToolActivity of [false, true]) {
				setChatTranscriptDisplayPreferences({ compactToolActivity });
				const output = Bun.stripANSI(buildAsyncResultBlock(current).render(160).join("\n"));
				expect(output).toContain("artifact write failed");
				expect(output).toContain("invalid output");
				expect(output).not.toContain("Background job");
				expect(output).not.toContain("hidden command");
				expect(output).not.toContain("other");

				harness = await TspHarness.start(tui => tui.addChild(buildAsyncResultBlock(current)), {
					cols: 160,
					rows: 20,
				});
				await harness.render();
				const native = JSON.stringify(harness.doc());
				expect(native).toContain("artifact write failed");
				expect(native).toContain("invalid output");
				expect(native).not.toContain("Background job");
				expect(native).not.toContain("hidden command");
				expect(native).not.toContain("other");
				harness.stop();
				harness = undefined;
			}
			expect(JSON.stringify(current)).toBe(original);
		}
		expect(JSON.stringify(message)).toBe(original);
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
