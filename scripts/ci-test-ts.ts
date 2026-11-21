#!/usr/bin/env bun

import { createHash, randomUUID } from "node:crypto";
import { type Dirent, lstatSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { windowsTestTempOverride } from "./windows-test-temp";
import { BunTestFailureObserver, GateCommandError, gateFailure, reportGateFailure } from "./test-gate-failure-events";
import { testConcurrencyLimit } from "./test-gate-scheduler";
import { bunRequiresFullSelection, captureChangedPaths } from "./test-gate-source";
import type { GateRun } from "./test-gate-runtime";
import {
	beginTestRun,
	BUN_FORK_SUITE_REVISION,
	bunTestProducerKey,
	endTestRun,
	isActiveBunFulltest,
	isGeneratedTestRunDirectory,
	latestFulltestBunProducers,
	recordTestProducer,
	testReportPath,
} from "./test-reporting";
import type { BunFulltestProducerScope, TestProducerRecord } from "./test-reporting";

export const FULLTEST_HOME_PREFIX = "omp-fulltest-home-";
export const FULLTEST_BUN_CAPACITY_FILE = ".bun-capacity";

type Mode =
	| "all"
	| "local"
	| "local-ts"
	| "workspace"
	| "native"
	| "coding-agent-singleton"
	| "coding-agent-ui"
	| "coding-agent-runtime"
	| "coding-agent-native"
	| "coding-agent-heavy";

type CodingAgentBucket = "singleton" | "ui" | "runtime" | "native";

interface TestCommand {
	label: string;
	cwd: string;
	/** argv without `--parallel`; the runner appends it from `parallel` and the pool's CPU budget. */
	command: string[];
	/** `bun test --parallel` width this chunk wants when it has the machine to itself. */
	parallel?: number;
	/** A fresh command process already isolates a one-file chunk. */
	oneFile?: boolean;
	knowledgeCliSlots?: 1 | 2;
	requireNoSelection?: boolean;
	selection?: BunSelection;
}

type CodingAgentTestPartition = Record<CodingAgentBucket, string[]>;

const repoRoot = path.join(import.meta.dir, "..");
const knowledgeCliTest = "test/knowledge-search-cli.e2e.test.ts";

export interface BunSelection {
	tool: "bun";
	mode: "full" | "affected";
	baseline?: string;
	reason?: string;
	selected?: number;
	group?: "ordinary" | "startup";
	/** Distinguishes the current fork test scope from earlier consumer sets. */
	suiteRevision?: typeof BUN_FORK_SUITE_REVISION;
}

/** A clean full TS baseline lets Bun compare the current worktree against its revision. */
export async function bunTestSelection(
	root: string = repoRoot,
	enabled = process.env.OMP_FULLTEST_AFFECTED === "1",
	hint: string | null | undefined = process.env.OMP_FULLTEST_BASELINE,
	currentRunId: string | undefined = process.env.OMP_TEST_RUN_ID,
): Promise<BunSelection> {
	const fallback = {
		tool: "bun",
		mode: "full",
		reason: "no qualifying clean fork-feature fulltest baseline",
	} as const;
	if (!enabled || hint === "none") return { tool: "bun", mode: "full", reason: "full selected fork feature suites" };
	const version = Bun.version.split(".").map(Number);
	if (version[0]! < 1 || (version[0] === 1 && (version[1]! < 3 || (version[1] === 3 && version[2]! < 13))))
		return { ...fallback, reason: "Bun does not support --changed" };
	let entries: Dirent[];
	try {
		entries = await fs.readdir(path.join(root, "runs", "test-timing"), { withFileTypes: true });
	} catch {
		return fallback;
	}
	// Only runner-owned directories can be candidates or invalidate an earlier
	// result. Manual timing artifacts may share the parent without a run.json.
	const directories = entries
		.filter(entry => entry.isDirectory() && isGeneratedTestRunDirectory(entry.name))
		.sort((a, b) => b.name.localeCompare(a.name));
	const unreadableReport = { ...fallback, reason: "newer test report is unreadable or invalid" };
	for (const entry of directories) {
		try {
			const run = JSON.parse(
				await fs.readFile(path.join(root, "runs", "test-timing", entry.name, "run.json"), "utf8"),
			);
			if (typeof run?.scope !== "string" || !run.scope) return unreadableReport;
			if (run.scope !== "fulltest: fork feature suites") continue;
			if (
				typeof run.platform !== "string" ||
				!run.platform ||
				typeof run.architecture !== "string" ||
				!run.architecture
			)
				return unreadableReport;
			if (run.platform !== process.platform || run.architecture !== process.arch) continue;
			// fulltest creates its running report before it selects tests. Only
			// that exact report is this invocation, not an interrupted prior run.
			if (entry.name === currentRunId && run.runId === currentRunId && run.completion === "running") continue;
			if (run.completion !== "complete" || run.exitCode !== 0)
				return { ...fallback, reason: "most recent fork-feature fulltest failed or is incomplete" };
			const producers = Array.isArray(run.producers)
				? run.producers.filter((producer: TestProducerRecord) => producer.scope === "ci-test-ts:local-ts")
				: [];
			if (
				run.dirtyState !== "clean" ||
				run.runtimeVersions?.bun !== Bun.version ||
				run.reconciliation?.status !== "validated" ||
				run.unreconciledScope != null ||
				run.coverage === "affected-tests-only" ||
				!Array.isArray(run.producers) ||
				!producers.length ||
				!producers.every(
					(producer: TestProducerRecord & { report?: string }) =>
						producer.exitCode === 0 &&
						producer.status === "passed" &&
						producer.report === "available" &&
						producer.selection?.mode === "full" &&
						producer.selection.suiteRevision === BUN_FORK_SUITE_REVISION,
				) ||
				!["ordinary", "startup"].every(group =>
					producers.some(
						(producer: TestProducerRecord) => (producer.selection as BunSelection | undefined)?.group === group,
					),
				) ||
				!["cargo nextest run", "cargo test --doc", "ui-smoke/runner-stage"].every(name =>
					run.producers.some(
						(producer: TestProducerRecord) =>
							producer.producer === name &&
							producer.exitCode === 0 &&
							(producer.status === "passed" || producer.status === "stage") &&
							(name === "ui-smoke/runner-stage" || producer.selection?.mode === "full"),
					),
				) ||
				run.producers.some(
					(producer: TestProducerRecord) =>
						producer.status === "not-selected" || producer.selection?.mode === "affected",
				) ||
				(hint != null && run.sourceRevision !== hint) ||
				!/^[a-f0-9]{40,64}$/i.test(run.sourceRevision ?? "") ||
				!Number.isFinite(Date.parse(run.startedAtUtc))
			)
				continue;
			try {
				const child = Bun.spawn(["git", "merge-base", "--is-ancestor", run.sourceRevision, "HEAD"], {
					cwd: root,
					stdout: "ignore",
					stderr: "ignore",
				});
				if ((await child.exited) === 0) return { tool: "bun", mode: "affected", baseline: run.sourceRevision };
			} catch {
				return { ...fallback, reason: "Git unavailable to validate baseline" };
			}
		} catch {
			// Without a readable report, its scope cannot be ruled out.
			return unreadableReport;
		}
	}
	return fallback;
}

/** Git failure or a dynamic/native input makes automatic Bun selection unsafe. */
async function bunCanTraceChanges(root: string, baseline: string): Promise<boolean> {
	try {
		const gitGate = {
			charged: async <T>(work: () => Promise<T>) => work(),
			capture: async ({ argv }: { argv: string[] }) => {
				const child = Bun.spawn(argv, { cwd: root, stdout: "pipe", stderr: "ignore" });
				const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
				if (exitCode !== 0) throw new Error("Git change capture failed");
				return { stdout };
			},
		} as unknown as GateRun;
		return !bunRequiresFullSelection(await captureChangedPaths(gitGate, root, baseline));
	} catch {
		return false;
	}
}
/** Consolidation is safe only when Git confirms that the baseline is the entire current tree. */
export async function bunCleanBaseline(selection: BunSelection, root = repoRoot): Promise<boolean> {
	if (selection.mode !== "affected" || !selection.baseline) return false;
	try {
		const git = async (...args: string[]) => {
			const child = Bun.spawn(["git", ...args], { cwd: root, stdout: "pipe", stderr: "ignore" });
			const [output, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
			return code === 0 ? output : undefined;
		};
		const [head, status] = await Promise.all([
			git("rev-parse", "HEAD"),
			git("status", "--porcelain=v1", "--untracked-files=all"),
		]);
		return head?.trim() === selection.baseline && status === "";
	} catch {
		return false;
	}
}

export function bunNoTestsSelected(output: string): boolean {
	const plain = output.replaceAll(/\x1b\[[0-9;]*m/g, "");
	return /--changed:\s*(?:no changed files, nothing to run|\d+ changed files?, but no test files are affected)/.test(
		plain,
	);
}
const args = process.argv.slice(2);
const isDryRun = args.includes("--dry-run");
const requestedMode = args.find(arg => !arg.startsWith("--")) ?? "all";
// `--only-failures` is Bun's output filter — it hides passing tests within each
// chunk, keeping the log terse, and is the default here (CI and the root
// `test:ts` aggregate append it). It does NOT skip tests or share any
// cross-process cache, so chunks are safe to run concurrently. The package-level
// `test` script passes `--full` for verbose output (every test line); an explicit
// `--only-failures` still wins.
const onlyFailures = args.includes("--only-failures") || !args.includes("--full");
const onlyFailuresArgs = onlyFailures ? ["--only-failures"] : [];
// Quiet mode (the default) collapses each parallel chunk to a one-line pass/fail
// progress entry and replays full stdout/stderr only for chunks that failed, so
// the failure is never buried under thousands of passing-chunk lines. `--full`
// opts back into inline replay of every chunk. Tied to `onlyFailures` so the
// quiet path is whatever the verbose filter is not.
const quiet = onlyFailures;
// A gate receives failures immediately; independent chunks and the rest of
// each suite still run so one failure cannot hide the remaining results.
const gateReportsFailures = Boolean(process.env.OMP_GATE_EVENT_TOKEN);
const sharedFulltestPool = args.includes("--shared-fulltest-pool");
const fulltestStartupHome = sharedFulltestPool ? Bun.env.OMP_FULLTEST_STARTUP_HOME : undefined;

const validModes: Record<Mode, true> = {
	all: true,
	local: true,
	"local-ts": true,
	workspace: true,
	native: true,
	"coding-agent-singleton": true,
	"coding-agent-ui": true,
	"coding-agent-runtime": true,
	"coding-agent-native": true,
	"coding-agent-heavy": true,
};

// `chunkSize` splits a bucket's file list into that-many-file groups, each run as a
// separate `bun test` child process. A fresh process per chunk resets Bun's
// heap and reaps any dangling spawned children between groups, keeping peak RSS
// under the CI runner's OOM ceiling (a single 170–370-file invocation gets
// SIGKILLed at 137). Singleton/global-state files also run serially within
// bounded fresh processes, avoiding a single long-running bucket.
//
// The UI/TUI bucket uses a smaller chunk (5) than the others: its suites build up
// native ghostty-vt cells, and bun 1.3.14's GC aborts (SIGTRAP/SIGABRT, exit
// 133/134 inside DOMGCOutputConstraint marking) once ~10 such files share a heap,
// even with the GC-marker knobs below. Bisection showed no single file is at
// fault — the crash is cumulative heap volume. Under a 256MB-forced heap, a
// 10-file chunk aborts ~50% of runs while either 5-file half is 0/20; halving the
// chunk keeps each process under the threshold.
// Bun 1.4.0 on Windows also wedges when runtime/collab registry suites share a
// process: the next file can spin past the watchdog. Isolate runtime and native
// files on that platform while retaining larger chunks elsewhere.
const codingAgentBucketPlans: Record<CodingAgentBucket, { label: string; parallel: number; chunkSize?: number }> = {
	singleton: { label: "singleton/global-state bucket", parallel: 1, chunkSize: 10 },
	ui: { label: "UI/TUI bucket", parallel: 1, chunkSize: 5 },
	runtime: { label: "runtime/session bucket", parallel: 1, chunkSize: process.platform === "win32" ? 1 : 10 },
	native: {
		label: "native/tooling/browser/unit bucket",
		parallel: 1,
		chunkSize: process.platform === "win32" ? 1 : 10,
	},
};

// Smaller workspace packages stay separate from native/TUI/integration suites so
// their short TS suites can run together. CI still downloads the Linux x64 native
// addon before this bucket: shared utility barrels may load native-backed modules.
const fastWorkspacePackages = [
	"packages/omptype",
	"packages/utils",
	"packages/catalog",
	"packages/ai",
	"packages/snapcompact",
	"packages/agent",
	"packages/mnemopi",
];

// These suites cover the native package, TUI/browser-ish behavior, local servers,
// or coding-agent-adjacent benchmark paths. Keep them low-concurrency and in jobs
// that have downloaded the Linux x64 native addon artifacts.
const nativeAndIntegrationPackages = [
	"packages/natives",
	"packages/tui",
	"packages/collab-web",
	"packages/typescript-edit-benchmark",
	"packages/stats",
	"packages/metaharness",
	"python/robomp/web",
];

// Discover coding-agent tests at file granularity before chunking. Full mode
// uses Bun's test filename conventions.
const forkCodingAgentDirectories = ["test/spec-driven/", "test/team/", "test/goals/", "test/todoloop/"];
const forkCodingAgentFiles = new Set([
	"test/acp-builtins.test.ts", // /wt consumer
	"test/session/picker-worktrees.test.ts",
	"test/cli-goal-flag.test.ts",
	"test/goal-tool-runtime-enable.test.ts",
	"test/skills.test.ts",
	"test/skill-descriptions-xdg.test.ts",
	"test/skill-protocol-customdirs.test.ts",
	"test/skillful-toggle.test.ts",
	"test/cli/skill-list.test.ts",
	"test/slash-commands/team-command.test.ts",
	"test/slash-commands/guided-goal.test.ts",
	"test/slash-commands/compact.test.ts",
	"test/slash-commands/display.test.ts",
	"test/slash-commands/jch-ime.test.ts",
	"test/slash-commands/tan.test.ts",
	"test/slash-commands/shared-business.test.ts",
	"test/sketch-server.test.ts",
	"test/slash-commands/sketch.test.ts",
	"test/input-controller-image-ownership.test.ts",
	"test/knowledge-index.test.ts",
	"test/knowledge-search-cli.e2e.test.ts",
	"test/knowledge-search-tool.test.ts",
	"test/knowledge-search-tool-availability.test.ts",
	"test/knowledge-models.test.ts",
	"test/knowledge-semantic.test.ts",
	"test/lsp/edits.test.ts",
	"test/models-offline-company.test.ts",
	"test/company-models.test.ts",
	"test/company-provider.test.ts",
	"test/codeagent-provider.test.ts",
	"test/codeagent-thinking-policy.test.ts",
	"test/offline-subcommands.test.ts",
	"test/cli-offline-env.test.ts",
	"test/offline-notice.test.ts",
	"test/sdk-system-prompt-template.test.ts",
	"test/mnemopi-company-embeddings.test.ts",
	"test/profile-cli.test.ts",
	"test/profile-bootstrap.test.ts",
	"test/profile-alias.test.ts",
	"test/sample-profile.test.ts",
	"test/interactive-mode-restart-profile.test.ts",
	"test/session-paths.test.ts",
	"test/config-cli.test.ts",
	"test/config/user-settings.test.ts",
	"test/config/config-file.test.ts",
	"test/config/model-registry.test.ts",
	"test/config/models-config-validation.test.ts",
	"test/settings-manager.test.ts",
	"test/interactive-mode-default-plan-mode.test.ts",
	"test/input-controller-approval-routing.test.ts",
	"test/cfg-approval-timeout.test.ts",
	"test/tools/approval-mode.test.ts",
	"test/tools/approval-cached-mode.test.ts",
	"test/tools/approval-restricted-folders.test.ts",
	"test/agent-session-snapcompact-reader.test.ts",
	"test/session-manager/snapcompact-archive-persistence.test.ts",
	"test/tools/approval.test.ts",
	"test/compact-modes.test.ts",
	"test/compaction.test.ts",
	"test/snapcompact-inline.test.ts",
	"test/event-controller-thinking-preview.test.ts",
	"test/interactive-terminal-e2e.test.ts",
	"test/modes/utils/render-initial-messages.test.ts",
	"test/status-line-usage.test.ts",
	"test/status-line-time-spent.test.ts",
	"test/status-line-transparent.test.ts",
	"test/status-line-segment-padding.test.ts",
	"test/status-line-brand-fade.test.ts",
	"test/agent-session-auto-compaction-progress-guard.test.ts",
	"test/agent-session-compaction.test.ts",
	"test/agent-session-goal-midrun-compaction.test.ts",
	"test/agent-session-magic-keywords.test.ts",
	"test/agent-session-queued-steer-delivery.test.ts",
	"test/agent-session-stats.test.ts",
	"test/approval-launch-contract.test.ts",
	"test/artifacts-integrity.test.ts",
	"test/ask-timeout.test.ts",
	"test/autolearn-managed-skills.test.ts",
	"test/bench-offline-company.test.ts",
	"test/cli-explicit-extension-isolation.test.ts",
	"test/cli/openwiki-ai-query.test.ts",
	"test/cli/openwiki-dry-run.test.ts",
	"test/cli/openwiki-generation.test.ts",
	"test/cli/openwiki-process-boundary.test.ts",
	"test/cli/openwiki-recovery.test.ts",
	"test/cli/openwiki.test.ts",
	"test/commit-conventional.test.ts",
	"test/compact-status-spacing.test.ts",
	"test/compaction-speculation.test.ts",
	"test/composer-prediction-controller.test.ts",
	"test/config-cli-revision-contract.test.ts",
	"test/context-fits-model.test.ts",
	"test/developer-test-agent-resources.test.ts",
	"test/discovery-skill-scanner.test.ts",
	"test/discovery/claude-plugins.test.ts",
	"test/eval/completion-bridge.test.ts",
	"test/extension-dashboard-mcp-parity.test.ts",
	"test/fork-diagnostic-logging.test.ts",
	"test/fork-runtime-defaults.test.ts",
	"test/input-controller-input-events.test.ts",
	"test/input-controller-thinking-visibility.test.ts",
	"test/interactive-mode-activity-line.test.ts",
	"test/interactive-mode-loop-teardown.test.ts",
	"test/interactive-mode-loop.test.ts",
	"test/interactive-mode-working-label.test.ts",
	"test/internal-urls/mcp-protocol.test.ts",
	"test/judgment-chain.test.ts",
	"test/knowledge-cli.test.ts",
	"test/knowledge-hub.test.ts",
	"test/knowledge-index-names.test.ts",
	"test/loop-limit.test.ts",
	"test/model-picker.test.ts",
	"test/model-provider-contract.test.ts",
	"test/model-registry-default-config.test.ts",
	"test/model-registry-runtime-provider.test.ts",
	"test/modes/components/oauth-selector.test.ts",
	"test/modes/components/settings-layout.test.ts",
	"test/modes/controllers/input-controller-tool-expansion.test.ts",
	"test/modes/controllers/jobs-command.test.ts",
	"test/modes/goal-autopilot-websocket.test.ts",
	"test/native-pipe-fallback-contract.test.ts",
	"test/online-tiny-candidates.test.ts",
	"test/openwiki/agents-instructions.test.ts",
	"test/openwiki/host-lifecycle.test.ts",
	"test/openwiki/model-selection.test.ts",
	"test/openwiki/index-isolation.test.ts",
	"test/openwiki/native-pool.test.ts",
	"test/openwiki/query.test.ts",
	"test/openwiki/resources.test.ts",
	"test/openwiki/visualize-browser.test.ts",
	"test/openwiki/visualize.test.ts",
	"test/parallel-review-MagicSkills-regression.test.ts",
	"test/parallel-review-OfflineStartup-regression.test.ts",
	"test/parallel-review-ProviderCatalog-regression.test.ts",
	"test/parallel-review-TeamDiscussion-regression.test.ts",
	"test/personal-tool-arguments.test.ts",
	"test/retry-fallback.test.ts",
	"test/runtime-irc-receipt-contract.test.ts",
	"test/runtime-tool-cancellation-contract.test.ts",
	"test/sdk-async-job-manager-singleton.test.ts",
	"test/sdk-move-cwd.test.ts",
	"test/sdk-request-hooks.test.ts",
	"test/sdk-skills.test.ts",
	"test/settings-gated-tools-live.test.ts",
	"test/setup-wizard.test.ts",
	"test/slash-commands/crawl.test.ts",
	"test/slash-commands/personal-prompt-delivery.test.ts",
	"test/slash-commands/personal-session-isolation.test.ts",
	"test/speculative-live-config.test.ts",
	"test/speculative-read-integration.test.ts",
	"test/startup-composer.test.ts",
	"test/startup-python-diagnostic.test.ts",
	"test/status-line-overflow.test.ts",
	"test/stt-cloud.test.ts",
	"test/stt-preflight.test.ts",
	"test/stt-whisper-language.test.ts",
	"test/title-generator.test.ts",
	"test/task/parked-subagent-session-release.test.ts",
	"test/tools/ask.test.ts",
	"test/tools/jtd-upstream-contract.test.ts",
	"test/tools/todo.test.ts",
	"test/upstream-extension-validation.test.ts",
	"test/vibe/spawn-model-role.test.ts",
	"test/zero-config-terminal.test.ts",
	"test/tools/browser/crawl.test.ts",
	"test/tools/browser/crawl-access.test.ts",
	"test/parallel-review-SessionRuntimeCompact-regression.test.ts",
	"test/developer-test-agent-materialization.test.ts",
	"test/task/structured-subagent.test.ts",
	"test/registry/agent-lifecycle.test.ts",
	"test/agent-hub-activate.test.ts",
	"test/agent-session-dispose-releases-memory.test.ts",
	"test/sharpshooter-extract.test.ts",
]);
const forkPackageFiles: Record<string, string[]> = {
	"packages/agent": ["test/output-budget.test.ts", "test/pause-gate.test.ts"],
	"packages/utils": ["test/dirs-cache.test.ts", "test/logger-contract.test.ts"],
	"packages/ai": ["test/proxy.test.ts"],
	"packages/mnemopi": ["test/offline-storage.test.ts"],
	"packages/stats": ["test/storage-relocation.test.ts"],
	"packages/collab-web": [
		"test/composer.test.tsx",
		"test/transcript.test.tsx",
		"test/tool-view.test.tsx",
		"test/markdown.test.tsx",
	],
	"packages/tui": [
		"test/composer-inline-shrink.test.ts",
		"test/composer-welcome-scrollback.test.ts",
		"test/transcript-container.test.ts",
		"test/transcript-seam-loss.test.ts",
		"test/thinking-preview.test.ts",
		"test/status-line-profile.test.ts",
		"test/editor-ime-eligibility.test.ts",
		"test/emergency-restore-altscreen.test.ts",
		"test/jobs-panel.test.ts",
		"test/oauth-selector.test.ts",
		"test/timeline-picker-native.test.ts",
		"test/transcript-render-helpers.test.ts",
		"test/web-search-render.test.ts",
	],
	"packages/snapcompact": ["test/snapcompact.test.ts"],
};

export function isForkCodingAgentTest(file: string): boolean {
	return forkCodingAgentFiles.has(file) || forkCodingAgentDirectories.some(dir => file.startsWith(dir));
}

const projectToolTestCommand: TestCommand = {
	label: ".omp/tests (project-local TUI debug tool)",
	cwd: ".",
	command: ["bun", "test", ...onlyFailuresArgs, "./.omp/tests/tui.test.ts"],
	parallel: 1,
};

const codingAgentNativePathPatterns = [
	/(^|\/)[^/]*(bash|native|browser|cmux|mnemopi|hindsight|memory)[^/]*\.test\.ts$/i,
	/^test\/[^/]*(ask|gh|irc|task|eval|search|read|write|edit|ast|resolve|sqlite|web-search|fetch|image|ssh|tool)[^/]*\.test\.ts$/,
	/^test\/core\/python-[^/]*\.test\.ts$/,
	/^test\/core\/[^/]*executor[^/]*\.test\.ts$/,
	/^test\/tools\/[^/]*(ask|gh|irc|task|eval|search|read|edit|ast|resolve|sqlite|web-search|fetch|image|ssh)[^/]*\.test\.ts$/,
	/^test\/tools\/web-scrapers\//,
	/^test\/web\//,
	/^test\/ssh\//,
	/^test\/tools\.test\.ts$/,
];

const codingAgentSingletonPathPatterns = [
	/^test\/(settings|config|fast-mode-scope|autocomplete-max-visible)[^/]*\.test\.ts$/,
	/^test\/[^/]*(singleton|global-state|fake-timer)[^/]*\.test\.ts$/,
];

const codingAgentUiPathPatterns = [
	/^test\/modes\//,
	/^test\/(interactive-mode|main-interactive|input-controller|streaming|status-line|keybindings|editor|hook|theme|setup-wizard|job-renderer|tool-args-reveal|tool-execution)[^/]*\.test\.ts$/,
];

const codingAgentRuntimePathPatterns = [
	/^test\/agent-session[^/]*\.test\.ts$/,
	/^test\/(acp|mcp|rpc|sdk)[^/]*\.test\.ts$/,
	/^test\/(session|session-manager|task|collab|internal-urls)\//,
	/^test\/session[^/]*\.test\.ts$/,
	/^test\/session-manager[^/]*\.test\.ts$/,
	/^test\/(extensions?|plugin|autolearn|skills|marketplace|oauth)[^/]*\.test\.ts$/,
	/^test\/[^/]*oauth[^/]*\.test\.ts$/,
	/^test\/(extensibility|discovery|tool-discovery|goals|marketplace)\//,
	/^test\/(model|model-|model-registry|model-resolver|compaction)[^/]*\.test\.ts$/,
];

const codingAgentNativeContentMarkers = [
	"@oh-my-pi/pi-natives",
	"pi-natives",
	"native",
	"readImageMetadata",
	"Bun.spawn",
	"Bun.spawnSync",
	"child_process",
	"Bun.serve",
	"startLocalRelay(",
	"new Worker",
	"Worker(",
	"puppeteer",
	"bun:sqlite",
	"Redis",
	"redis",
	"WebSocket",
];

const codingAgentSingletonContentMarkers = [
	"Settings.init(",
	"Settings.instance",
	"resetSettingsForTest",
	"setAgentDir(",
	"vi.useFakeTimers(",
	"vi.useRealTimers(",
	"vi.stubEnv(",
	"vi.unstubAllEnvs(",
];

const codingAgentSingletonContentPatterns = [
	/(^|[^\w$.])(process\.env|Bun\.env)\.[A-Za-z0-9_]+\s*=/,
	/(^|[^\w$.])(process\.env|Bun\.env)\[[^\]]+\]\s*=/,
	/delete\s+(process\.env|Bun\.env)(\.[A-Za-z0-9_]+|\[[^\]]+\])/,
	/Object\.assign\((process\.env|Bun\.env),/,
];

const codingAgentUiContentMarkers = [
	"@oh-my-pi/pi-tui",
	"InteractiveMode",
	"InputController",
	"StatusLine",
	"ToolExecutionComponent",
	"render(",
	"renderToString",
];

const codingAgentRuntimeContentMarkers = ["AgentSession", "SessionManager", "AuthStorage", "Bun.sleep", "setTimeout("];

const codingAgentTestPartitionPromises = new Map<boolean, Promise<CodingAgentTestPartition>>();

function shellQuote(value: string): string {
	if (/^[A-Za-z0-9_./:=@+-]+$/.test(value)) {
		return value;
	}
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

function workspaceTestCommand(pkg: string, parallel: number, options: { extraArgs?: string[] } = {}): TestCommand {
	const { extraArgs = [] } = options;
	return {
		label: pkg,
		cwd: pkg,
		command: ["bun", "test", ...extraArgs],
		parallel,
	};
}

// Root `bun run test` reports the selected fork Rust suite and applicable
// doctests under the same progress stream and failure report as TypeScript.
function rustTestCommand(): TestCommand {
	return {
		label: "rust (selected fork features and applicable doctests)",
		cwd: ".",
		command: ["bun", "scripts/run-rs-task.ts", "test:rs"],
	};
}

async function collectTestsUnder(root: string, baseDir: string, all = false): Promise<string[]> {
	const entries = await fs.readdir(root, { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
		const filePath = path.join(root, entry.name);
		if (entry.isDirectory()) {
			if (all && (entry.name === "node_modules" || entry.name.startsWith("."))) continue;
			files.push(...(await collectTestsUnder(filePath, baseDir, all)));
			continue;
		}
		const relative = path.relative(baseDir, filePath).split(path.sep).join("/");
		if (
			!entry.isFile() ||
			!(entry.name.endsWith(".test.ts") || (all && /(?:\.|_)(?:test|spec)\.(?:js|jsx|ts|tsx)$/.test(entry.name)))
		) {
			continue;
		}
		files.push(relative);
	}
	return files;
}

function hasAnyMarker(content: string, markers: string[]): boolean {
	return markers.some(marker => content.includes(marker));
}

function matchesAnyPath(testFile: string, patterns: RegExp[]): boolean {
	return patterns.some(pattern => pattern.test(testFile));
}

function matchesAnyContentPattern(content: string, patterns: RegExp[]): boolean {
	return patterns.some(pattern => pattern.test(content));
}
// Native/tooling tests are classified first because they need the lowest
// concurrency; all coding-agent buckets run with the native addon available in CI.
function classifyCodingAgentTest(testFile: string, content: string): CodingAgentBucket {
	if (
		matchesAnyPath(testFile, codingAgentNativePathPatterns) ||
		hasAnyMarker(content, codingAgentNativeContentMarkers)
	) {
		return "native";
	}
	if (matchesAnyPath(testFile, codingAgentUiPathPatterns) || hasAnyMarker(content, codingAgentUiContentMarkers)) {
		return "ui";
	}
	if (
		matchesAnyPath(testFile, codingAgentSingletonPathPatterns) ||
		hasAnyMarker(content, codingAgentSingletonContentMarkers) ||
		matchesAnyContentPattern(content, codingAgentSingletonContentPatterns)
	) {
		return "singleton";
	}
	if (
		matchesAnyPath(testFile, codingAgentRuntimePathPatterns) ||
		hasAnyMarker(content, codingAgentRuntimeContentMarkers)
	) {
		return "runtime";
	}
	return "native";
}

// Resource ownership follows the real launch/probe imports, not an e2e filename
// suffix: new browser acceptance files must not escape into the ordinary lane.
const browserConsumerTests = new Set<string>();

function consumesBrowserProcess(content: string): boolean {
	return (
		/\blaunchHeadlessBrowser\s*\(/.test(content) ||
		(/\b(?:loadPuppeteer|puppeteer-core)\b/.test(content) && /\b\w+\.launch\s*\(/.test(content)) ||
		/from\s+["'][^"']*chromium-probe["']/.test(content)
	);
}

async function getCodingAgentTestPartition(all = false): Promise<CodingAgentTestPartition> {
	let promise = codingAgentTestPartitionPromises.get(all);
	if (!promise) {
		promise = (async () => {
			const codingAgentDir = path.join(repoRoot, "packages/coding-agent");
			const testRoot = all ? codingAgentDir : path.join(codingAgentDir, "test");
			const testFiles = (await collectTestsUnder(testRoot, codingAgentDir, all)).sort();
			const partition: CodingAgentTestPartition = {
				singleton: [],
				ui: [],
				runtime: [],
				native: [],
			};

			for (const testFile of testFiles) {
				const content = await Bun.file(path.join(codingAgentDir, testFile)).text();
				if (consumesBrowserProcess(content)) browserConsumerTests.add(testFile);
				partition[classifyCodingAgentTest(testFile, content)].push(testFile);
			}

			return partition;
		})();
		codingAgentTestPartitionPromises.set(all, promise);
	}
	return promise;
}

// Start explicitly named end-to-end and integration tests early.
// Preserve order within each group.
function isIntegrationTest(testFile: string): boolean {
	return (
		/(?:^|[./_-])(?:e2e|integration)(?:[./_-]|$)/i.test(testFile) ||
		/^(?:\.\/)?test\/openwiki\/visualize-browser\.test\.ts$/.test(testFile) ||
		testFile === "test/goals/goal-sdk-auxiliary-consumers.test.ts" ||
		// Repository snapshots and bundled shell helpers spawn repeated native subprocesses.
		testFile === "test/openwiki/native-pool.test.ts" ||
		testFile === "test/spec-driven/resources.test.ts" ||
		testFile === "test/tools/browser/crawl.test.ts"
	);
}

export function isIntegrationCommand(command: TestCommand): boolean {
	return command.cwd === "packages/coding-agent" && command.command.some(isIntegrationTest);
}

function isStartupTest(file: string): boolean {
	return (
		browserConsumerTests.has(file) ||
		/^test\/spec-driven\/tui-[^/]*\.e2e\.test\.ts$/.test(file) ||
		file === "test/zero-config-terminal.test.ts" ||
		file === "test/startup-composer.test.ts" ||
		file === "test/goals/goal-autopilot-tui.e2e.test.ts" ||
		file === "test/goals/goal-ctrl-enter-tui.e2e.test.ts" ||
		file === "test/goals/goal-autopilot-public-views.test.ts" ||
		file === "test/modes/goal-autopilot-websocket.test.ts"
	);
}

// Startup files are isolated before chunking, including in full mode.
function isStartupCommand(command: TestCommand): boolean {
	return command.cwd === "packages/coding-agent" && command.command.some(isStartupTest);
}

function isBrowserCommand(command: TestCommand): boolean {
	return command.cwd === "packages/coding-agent" && command.command.some(file => browserConsumerTests.has(file));
}

/** Startup chunks run in their own lane; retain the integration cap for other chunks. */
export function isLimitedIntegrationCommand(command: TestCommand): boolean {
	return !isStartupCommand(command) && isIntegrationCommand(command);
}

async function codingAgentTestCommands(
	bucket: CodingAgentBucket,
	forkOnly = false,
	all = false,
	isolateKnowledgeCli = false,
): Promise<TestCommand[]> {
	const partition = await getCodingAgentTestPartition(all);
	const testFiles = partition[bucket].filter(file =>
		forkOnly ? isForkCodingAgentTest(file) : all || file.endsWith(".test.ts"),
	);
	if (testFiles.length === 0) {
		if (forkOnly) return [];
		throw new Error(`No coding-agent ${bucket} tests matched`);
	}
	const plan = codingAgentBucketPlans[bucket];
	const chunkSize = plan.chunkSize ?? testFiles.length;
	const chunks: string[][] = [];
	let pending: string[] = [];
	for (const file of testFiles) {
		if (isStartupTest(file) || (isolateKnowledgeCli && file === knowledgeCliTest)) {
			if (pending.length) chunks.push(pending);
			pending = [];
			chunks.push([file]);
		} else {
			pending.push(file);
			if (pending.length === chunkSize) {
				chunks.push(pending);
				pending = [];
			}
		}
	}
	if (pending.length) chunks.push(pending);
	// The label is also timing identity: adding unrelated files must not rename an
	// unchanged chunk, particularly a one-file Windows or startup chunk.
	const commands: TestCommand[] = [];
	for (const chunk of chunks) {
		const first = chunk[0]!;
		const members =
			chunk.length === 1
				? first
				: `${first} + ${chunk.length - 1} more; ${createHash("sha256").update(JSON.stringify(chunk)).digest("hex").slice(0, 12)}`;
		commands.push({
			label: `packages/coding-agent (${plan.label}; ${members})`,
			cwd: "packages/coding-agent",
			command: [
				"bun",
				"test",
				...onlyFailuresArgs,
				...chunk.map(file => (file.endsWith(".e2e.ts") ? `./${file}` : file)),
			],
			parallel: plan.parallel,
			oneFile: chunk.length === 1,
			...(isolateKnowledgeCli && first === knowledgeCliTest ? { knowledgeCliSlots: 1 as const } : {}),
		});
	}
	return commands;
}

async function commandsForMode(mode: Mode, isolateKnowledgeCli = false): Promise<TestCommand[]> {
	switch (mode) {
		case "workspace":
			return fastWorkspacePackages.map(pkg => workspaceTestCommand(pkg, 8));
		case "native":
			return [...nativeAndIntegrationPackages.map(pkg => workspaceTestCommand(pkg, 4)), projectToolTestCommand];
		case "coding-agent-singleton":
			return await codingAgentTestCommands("singleton");
		case "coding-agent-ui":
			return await codingAgentTestCommands("ui");
		case "coding-agent-runtime":
			return await codingAgentTestCommands("runtime");
		case "coding-agent-native":
			return await codingAgentTestCommands("native");
		case "coding-agent-heavy":
			return [
				...(await codingAgentTestCommands("singleton")),
				...(await codingAgentTestCommands("ui")),
				...(await codingAgentTestCommands("runtime")),
				...(await codingAgentTestCommands("native")),
			];
		case "all":
			return [
				...(await commandsForMode("workspace")),
				...(await commandsForMode("native")),
				...(await codingAgentTestCommands("singleton", false, true, isolateKnowledgeCli)),
				...(await codingAgentTestCommands("ui", false, true, isolateKnowledgeCli)),
				...(await codingAgentTestCommands("runtime", false, true, isolateKnowledgeCli)),
				...(await codingAgentTestCommands("native", false, true, isolateKnowledgeCli)),
			];
		// Select individual fork consumers before applying the usual isolation chunks.
		case "local-ts": {
			const packages: TestCommand[] = [];
			for (const [cwd, candidates] of Object.entries(forkPackageFiles)) {
				const files = (
					await Promise.all(
						candidates.map(async file =>
							(await Bun.file(path.join(repoRoot, cwd, file)).exists()) ? file : undefined,
						),
					)
				).filter((file): file is string => file !== undefined);
				if (files.length)
					packages.push({
						label: `${cwd} (fork feature tests; ${files.length} files)`,
						cwd,
						command: ["bun", "test", ...onlyFailuresArgs, ...files],
						parallel: 1,
					});
			}
			return [
				...packages,
				...(await codingAgentTestCommands("singleton", true, false, isolateKnowledgeCli)),
				...(await codingAgentTestCommands("ui", true, false, isolateKnowledgeCli)),
				...(await codingAgentTestCommands("runtime", true, false, isolateKnowledgeCli)),
				...(await codingAgentTestCommands("native", true, false, isolateKnowledgeCli)),
			];
		}
		// Root `bun run test` adds the Rust fork task to local TypeScript.
		case "local":
			return [...(await commandsForMode("local-ts")), rustTestCommand()];
	}
}

// Self-hosted runners may carry cloud credentials (`AWS_*`) in their
// environment, GitHub Actions injects `GITHUB_TOKEN`,
// and a host may carry provider API keys. Any of these make env-sensitive code
// non-deterministic in tests — e.g. leaked AWS creds make `amazon-bedrock` look
// authenticated and win the provider startup fallback over `anthropic`. Run the
// suites in a hermetic environment with all credential / cloud-config variables
// stripped so resolution depends only on the test's own fixtures.
const SCRUBBED_ENV_PREFIXES = ["AWS_", "GOOGLE_CLOUD_"];
const SCRUBBED_ENV_NAMES = new Set([
	"GITHUB_TOKEN",
	"GH_TOKEN",
	"COPILOT_GITHUB_TOKEN",
	"GOOGLE_APPLICATION_CREDENTIALS",
	"ANTHROPIC_OAUTH_TOKEN",
	"XAI_OAUTH_TOKEN",
]);

function isScrubbedEnvVar(key: string): boolean {
	// Windows environment names are case-insensitive; retain original keys in
	// buildChildEnv so deletion (and fulltest's overlay tombstone) uses that key.
	if (process.platform === "win32") key = key.toUpperCase();
	if (SCRUBBED_ENV_NAMES.has(key)) {
		return true;
	}
	if (SCRUBBED_ENV_PREFIXES.some(prefix => key.startsWith(prefix))) {
		return true;
	}
	// Any provider credential, e.g. ANTHROPIC_API_KEY / XAI_OAUTH_TOKEN / bedrock bearer.
	return /_(API_KEY|OAUTH_TOKEN)$/.test(key) || key.includes("BEARER_TOKEN");
}

const reportShard = args.includes("--unsharded") ? undefined : Bun.env.OMP_TEST_SHARD?.trim();
const reportScope = `ci-test-ts:${requestedMode}${reportShard ? `:shard-${reportShard}` : ""}`;

const reportRunnerId = randomUUID().slice(0, 8);
// Bun's JUnit reporter writes a separate file without replacing console output.
// The Rust wrapper inherits the same run directory and records its own native report.
function reportedCommand(testCommand: TestCommand, attempt: number): { command: string[]; reportPath?: string } {
	if (testCommand.parallel === undefined) return { command: testCommand.command };
	const reportPath = testReportPath(`${testCommand.label}-attempt-${attempt}`);
	return {
		command: [...testCommand.command, "--reporter=junit", `--reporter-outfile=${reportPath}`],
		reportPath,
	};
}

async function recordAttempt(
	testCommand: TestCommand,
	attempt: number,
	command: string[],
	reportPath: string | undefined,
	startedAt: string,
	durationSeconds: number,
	exitCode: number,
	timedOut: boolean,
	output: string,
): Promise<boolean> {
	let missing = false;
	if (reportPath) {
		try {
			const stat = await fs.stat(reportPath);
			missing = !stat.isFile() || stat.size === 0;
		} catch {
			missing = true;
		}
	}
	const notSelected =
		exitCode === 0 && !timedOut && testCommand.selection?.mode === "affected" && bunNoTestsSelected(output);
	if (notSelected) missing = false;
	const partial = missing || timedOut || exitCode >= 128;
	try {
		await recordTestProducer({
			producer: `${reportScope}:${reportRunnerId}:${testCommand.label}:attempt-${attempt}`,
			command,
			scope: reportScope,
			attempt,
			logicalGroup: `${reportScope}:${reportRunnerId}:${testCommand.label}`,
			concurrency: testCommand.parallel,
			startedAt,
			durationSeconds,
			exitCode,
			reportPath: notSelected ? undefined : reportPath,
			status: notSelected
				? "not-selected"
				: reportPath
					? partial
						? "partial"
						: exitCode === 0
							? "passed"
							: "failed"
					: "stage",
			selection: notSelected
				? { ...testCommand.selection!, selected: 0, reason: "Bun reported no affected test files" }
				: testCommand.selection,
			timingBasis: "Bun testcase execution time (seconds); durationSeconds is command wall time",
		});
	} catch (error) {
		// Preserve the test process's exit status when recording fails.
		if (missing) return true;
		if (exitCode === 0) throw error;
		console.error(`Failed to record ${testCommand.label} attempt ${attempt} (exit ${exitCode}):`, error);
	}
	return missing;
}

function testCommandEnv(testCommand: TestCommand, env: Record<string, string | undefined>) {
	const startupHome = testCommand.selection?.group === "startup" ? fulltestStartupHome : undefined;
	if (!startupHome && testCommand.knowledgeCliSlots !== 2) return env;
	return {
		...env,
		...(startupHome && {
			HOME: startupHome,
			USERPROFILE: startupHome,
			...(process.platform === "win32" && {
				APPDATA: path.join(startupHome, "AppData", "Roaming"),
				LOCALAPPDATA: path.join(startupHome, "AppData", "Local"),
			}),
		}),
		...(testCommand.knowledgeCliSlots === 2 && { OMP_TEST_KNOWLEDGE_CLI_SLOTS: "2" }),
	};
}

async function runTestCommand(
	testCommand: TestCommand,
	notifyFailure?: (error: GateCommandError) => void,
): Promise<void> {
	// Windows cross-drive relatives are already absolute; joining would build an invalid cwd.
	const cwd = path.isAbsolute(testCommand.cwd) ? testCommand.cwd : path.join(repoRoot, testCommand.cwd);
	console.log(`\n==> ${testCommand.label}`);
	if (isDryRun) {
		console.log(`$ ${testCommand.command.map(shellQuote).join(" ")}`);
		return;
	}

	const env = testCommandEnv(testCommand, buildChildEnv());
	for (let attempt = 1; ; attempt++) {
		const { command, reportPath } = reportedCommand(testCommand, attempt);
		const renderedCommand = command.map(shellQuote).join(" ");
		console.log(`$ ${renderedCommand}`);
		const startedAt = new Date().toISOString();
		const start = performance.now();
		const proc = Bun.spawn(command, {
			cwd,
			env,
			stdout: "inherit",
			stderr: "pipe",
		});
		const failureObserver = notifyFailure ? new BunTestFailureObserver(notifyFailure) : undefined;
		const stderrReader = proc.stderr.getReader();
		let stderrText = "";
		const decoder = new TextDecoder();
		const stderrDrain = (async () => {
			try {
				for (;;) {
					const { done, value } = await stderrReader.read();
					if (done) break;
					failureObserver?.push(value);
					stderrText += decoder.decode(value, { stream: true });
					process.stderr.write(value);
				}
			} catch {
				// A cancelled or broken pipe must not hide the command's exit status.
			} finally {
				failureObserver?.end();
				stderrReader.releaseLock();
			}
		})();
		// Watchdog, mirroring the parallel path: record that *we* killed the child,
		// otherwise the resulting 137 is indistinguishable from an OOM kill.
		let timedOut = false;
		const killTimer = setTimeout(async () => {
			timedOut = true;
			try {
				process.stdout.write(await describeStuckProcessTree(proc.pid));
			} finally {
				proc.kill("SIGKILL");
			}
		}, chunkTimeoutMs());
		const exitCode = await proc.exited;
		if (notifyFailure && exitCode !== 0)
			notifyFailure(
				new GateCommandError(`${testCommand.label} ${describeChunkFailure(exitCode, timedOut)}`, exitCode),
			);
		clearTimeout(killTimer);
		// Match the parallel path's bounded drain if a grandchild retains stderr.
		const drainTimer = setTimeout(() => void stderrReader.cancel().catch(() => {}), 5000);
		try {
			await stderrDrain;
		} finally {
			clearTimeout(drainTimer);
		}
		const unexpectedSelection =
			testCommand.requireNoSelection &&
			exitCode === 0 &&
			!/--changed:\s*no changed files, nothing to run/.test(stderrText.replaceAll(/\x1b\[[0-9;]*m/g, ""));
		const recordedExitCode = unexpectedSelection ? 1 : exitCode;
		const missing = await recordAttempt(
			testCommand,
			attempt,
			command,
			reportPath,
			startedAt,
			(performance.now() - start) / 1000,
			recordedExitCode,
			timedOut,
			stderrText,
		);
		if (unexpectedSelection) {
			throw new GateCommandError("Bun did not confirm an empty affected selection", 1);
		}
		if (exitCode === 0) {
			if (missing) console.error(`${testCommand.label} missing JUnit report: ${reportPath}`);
			return;
		}
		if (canRetryBunCrash(exitCode, timedOut, attempt)) {
			console.log(
				`==> ${testCommand.label}: bun crashed (exit ${exitCode}); retrying (attempt ${attempt + 1}/${MAX_CHUNK_ATTEMPTS})`,
			);
			continue;
		}
		throw new GateCommandError(
			`${testCommand.label} ${describeChunkFailure(exitCode, timedOut)}: ${renderedCommand}`,
			exitCode,
		);
	}
}

// Child env shared by every spawned test process: the parent env with the
// private test-runtime marker set, all CI credential / cloud-config variables
// scrubbed (see SCRUBBED_ENV_* above), and GITHUB_ACTIONS cleared. Clearing it
// would also clear run-rs-task.ts's "always run in GitHub Actions" rule for the
// Rust child, so under GitHub Actions OMP_FORCE_RUST_TASKS carries it instead.
//
// GC knobs (both needed — they gate different JSC mechanisms):
// - `BUN_JSC_useConcurrentGC=0` stops the collector from marking concurrently
//   with the mutator (868789972, an earlier GC crash under bun test).
// - `BUN_JSC_numberOfGCMarkers=1` removes the ParallelHelperPool marker
//   threads. Bun 1.3.14 segfaults/aborts inside parallel marking
//   (`DOMGCOutputConstraint::executeImplImpl` → `visitOutputConstraints` on a
//   dead cell; also "Pure virtual function called!") on heap-heavy
//   coding-agent chunks (~1.3GB RSS, native ghostty-vt cells). Repro: UI
//   bucket chunk crashed ~25% of runs with `BUN_JSC_forceRAMSize=256MB`,
//   0/10 with markers=1, at zero measured wall-time cost. useConcurrentGC=0
//   alone did not prevent it — the crash predates this knob.
//
// The knobs are necessary but not sufficient: the same GC bug also fires on
// the *mutator* thread (`Heap::collectInMutatorThread` →
// `MarkingConstraintSolver::runExecutionThread` → `DOMGCOutputConstraint` →
// `JSAbortSignal::visitAdditionalChildrenInGCThread` reading a dead `reason`
// cell), where no marker/concurrency knob applies. That residual crash is
// handled by retrying crashed chunks in a fresh process (MAX_CHUNK_ATTEMPTS).
// Bun 1.4.0 on Windows can also spin indefinitely in the controller suite
// under default GC settings. Disabling concurrent GC previously hung relay
// delivery when it shared a process with auth/collab tests; the per-file
// Windows chunks above keep those heaps separate.
export function buildChildEnv(): Record<string, string | undefined> {
	const env: Record<string, string | undefined> = {
		...Bun.env,
		GITHUB_ACTIONS: "",
		...(Bun.env.GITHUB_ACTIONS === "true" ? { OMP_FORCE_RUST_TASKS: "1" } : {}),
		PI_TEST_RUNTIME: "1",
		OMP_TEST_KNOWLEDGE_CLI_SLOTS: undefined,
		OMP_FULLTEST_BUN_MAX_CAPACITY: undefined,
		BUN_JSC_useConcurrentGC: "0",
		BUN_JSC_numberOfGCMarkers: "1",
	};
	// Keep test temp fixtures off the Windows system drive when another
	// writable drive exists (see windows-test-temp.ts).
	Object.assign(env, windowsTestTempOverride());
	for (const key of Object.keys(env)) {
		if (isScrubbedEnvVar(key)) {
			delete env[key];
		}
	}
	return env;
}

// Per-chunk watchdog. A bun child that wedges (e.g. the panic handler
// deadlocking after a GC crash) would otherwise stall the whole run: the
// parallel path awaits the child's stdout/stderr pipes, which stay open as
// long as the wedged process — or any grandchild that inherited them — lives.
// After this many seconds the child is SIGKILLed and reported as a failure.
// Override with OMP_TEST_CHUNK_TIMEOUT (seconds).
function chunkTimeoutMs(): number {
	const raw = Number(Bun.env.OMP_TEST_CHUNK_TIMEOUT?.trim());
	if (Number.isFinite(raw) && raw >= 1) return raw * 1000;
	return 600_000;
}

// What a watchdog-killed chunk was still doing, captured just before the
// SIGKILL: every process left in the chunk's tree (the `bun test` coordinator,
// its `--test-worker`s, anything they spawned) with state, CPU, RSS and kernel
// wait channel, plus the sockets those processes hold (via `ss`, or the raw
// `/proc/<pid>/fd` targets when `ss` is absent, as on the CI runner image). A
// chunk can report every test and still never exit; this is the only evidence
// of which process refused to and what it was blocked on. Linux-only (ps column
// names, /proc); "" elsewhere or without `ps`. Never throws: callers kill the
// chunk right after, and a snapshot failure must not stop that.
async function describeStuckProcessTree(rootPid: number): Promise<string> {
	if (process.platform !== "linux" || !Bun.which("ps")) return "";
	try {
		return await snapshotProcessTree(rootPid);
	} catch (err) {
		return `[watchdog] process tree snapshot failed: ${err instanceof Error ? err.message : String(err)}\n`;
	}
}

async function snapshotProcessTree(rootPid: number): Promise<string> {
	const ps = Bun.spawnSync(["ps", "-eo", "pid=,ppid=,stat=,etimes=,pcpu=,rss=,wchan:24=,args="]);
	if (!ps.success) return "";
	const rows = ps.stdout
		.toString()
		.split("\n")
		.map(line => line.trim().split(/\s+/))
		.filter(cols => cols.length >= 8);
	const tree = new Set([String(rootPid)]);
	for (let grew = true; grew;) {
		grew = false;
		for (const cols of rows) {
			if (tree.has(cols[1]) && !tree.has(cols[0])) {
				tree.add(cols[0]);
				grew = true;
			}
		}
	}
	const lines = ["[watchdog] live process tree (pid ppid stat elapsed_s cpu% rss_kb wchan args):"];
	for (const cols of rows) {
		if (tree.has(cols[0])) lines.push(`  ${cols.slice(0, 7).join(" ")} ${cols.slice(7).join(" ").slice(0, 200)}`);
	}
	const ss = Bun.which("ss") ? Bun.spawnSync(["ss", "-tuanpH"]) : null;
	if (ss?.success) {
		const owned = ss.stdout
			.toString()
			.split("\n")
			.filter(line => [...tree].some(pid => line.includes(`pid=${pid},`)));
		lines.push(`[watchdog] sockets held by that tree (${owned.length}):`, ...owned.map(line => `  ${line.trim()}`));
		return `${lines.join("\n")}\n`;
	}
	// No `ss`: list each process's non-tty fds (sockets, pipes, files). A
	// process gone between `ps` and here just yields nothing.
	lines.push("[watchdog] open fds per process (no ss on PATH):");
	for (const pid of tree) {
		const fdDir = `/proc/${pid}/fd`;
		const targets = await fs.readdir(fdDir).then(
			fds => Promise.all(fds.map(fd => fs.readlink(`${fdDir}/${fd}`).catch(() => ""))),
			() => [],
		);
		const kept = targets.filter(target => target && !target.startsWith("/dev/"));
		if (kept.length > 0) lines.push(`  ${pid}: ${kept.join(" ").slice(0, 400)}`);
	}
	return `${lines.join("\n")}\n`;
}

// Exit codes that mean the bun process itself died to a runtime fault
// (128 + fatal signal) rather than reporting failing tests (which exit 1).
// Bun's panic handler exits via SIGTRAP (133) on macOS; raw SIGILL/SIGBUS/
// SIGABRT/SIGFPE/SIGSEGV surface as 132/135|138/134/136/139. 137 (SIGKILL)
// is deliberately excluded: that's the watchdog or the OOM killer, and
// retrying an OOM-killed chunk just OOMs again.
const BUN_CRASH_EXITS: Record<number, true> = {
	132: true,
	133: true,
	134: true,
	135: true,
	136: true,
	138: true,
	139: true,
};

// Total attempts a chunk gets when bun itself crashes. Bun 1.3.14's residual
// GC crash (JSAbortSignal `reason` visited on a dead cell during marking) is
// heap-timing dependent — a fresh process nearly always passes — while a
// deterministic crash still fails every attempt and is reported normally.
const MAX_CHUNK_ATTEMPTS = 3;

function canRetryBunCrash(exitCode: number, timedOut: boolean, attempt: number): boolean {
	return !gateReportsFailures && !timedOut && attempt < MAX_CHUNK_ATTEMPTS && Boolean(BUN_CRASH_EXITS[exitCode]);
}

// Why a chunk failed, in words. Exit 137 is SIGKILL, which this runner reaches
// two very different ways -- the per-chunk watchdog firing, or the kernel OOM
// killer reaping a chunk that outgrew the runner -- and the bare exit code
// cannot tell them apart. Which one it was is the difference between "raise
// OMP_TEST_CHUNK_TIMEOUT" and "lower this bucket's chunkSize", so say it.
function describeChunkFailure(exitCode: number, timedOut: boolean): string {
	if (timedOut) {
		return `exceeded the ${Math.round(chunkTimeoutMs() / 1000)}s chunk watchdog and was killed (exit ${exitCode}; OMP_TEST_CHUNK_TIMEOUT to change)`;
	}
	if (exitCode === 137) {
		return "was SIGKILLed (exit 137) without reaching the chunk watchdog, which on a CI runner means the OOM killer; lower this bucket's chunkSize";
	}
	return `failed with exit code ${exitCode}`;
}

// The standard `CI` signal is authoritative. In CI each bucket is its own
// memory-capped runner job (a single fat invocation gets OOM-killed at 137), so
// chunks run sequentially within a job and parallelism happens across jobs.
// Locally we trade memory for wall-clock and fan the chunks out across cores.
function isCI(): boolean {
	const value = Bun.env.CI;
	if (!value) return false;
	const normalized = value.trim().toLowerCase();
	return normalized !== "" && normalized !== "0" && normalized !== "false";
}

// Each chunk is a full bun process, so cap the pool by both the number of
// commands and the shared CPU budget, including on Windows.
export function testConcurrency(
	total: number,
	spec: string | undefined,
	cores: number,
	platform: NodeJS.Platform = process.platform,
): number {
	const cap = Math.min(testConcurrencyLimit(cores, platform), total);
	const raw = spec?.trim().toLowerCase();
	if (!raw) return cap;
	if (raw === "all" || raw === "max") return cap;
	const override = Number(raw);
	if (Number.isFinite(override) && override >= 1) {
		return Math.min(Math.floor(override), cap);
	}
	throw new Error(`Invalid OMP_TEST_CONCURRENCY=${JSON.stringify(raw)}; expected a positive integer, all, or max`);
}

// Two independent parallelism knobs stack multiplicatively: the chunk pool runs
// `poolWidth` `bun test` processes at once, and each of those runs its own
// `--parallel=N` test files concurrently, so up to `poolWidth * N` files are in
// flight. Left unbudgeted that oversubscribes the runner by design — the
// workspace bucket asked for 4 x 8 = 32 files on a 4-core box — and because
// bun's per-test timeout is wall-clock, CPU-starved suites blow it and fail at
// random (mnemopi's sqlite/CLI files did, a different set each run). Spend one
// CPU budget instead: each live chunk gets an equal share, never below 1 and
// never above the width it asked for.
export function budgetedParallel(
	requested: number,
	poolWidth: number,
	cores: number = os.availableParallelism(),
): number {
	const budget = testConcurrencyLimit(cores);
	return Math.max(1, Math.min(requested, Math.floor(budget / poolWidth)));
}

// Bun's 5s default per-test timeout is a unit-test default, and this repo's
// suites are not unit tests: mnemopi builds real SQLite schemas per case, the
// coding-agent suites drive sessions and subprocesses. Those cases already run
// 1-4s on a quiet CI runner, so any scheduling hiccup crosses 5s and reports a
// timeout that says nothing about the code. Timing out is still worth catching,
// so keep a ceiling — just one loose enough to only fire on a real hang. The
// per-chunk watchdog (chunkTimeoutMs) remains the backstop for a wedged process.
// Override with OMP_TEST_TIMEOUT (seconds); per-test `it(name, fn, ms)` still wins.
export function testTimeoutMs(override: string | undefined = Bun.env.OMP_TEST_TIMEOUT): number {
	const raw = Number(override?.trim());
	if (Number.isFinite(raw) && raw >= 1) return raw * 1000;
	return 30_000;
}

// Materialize argv from the actual lease, rather than requesting more files or
// concurrent Knowledge scenarios than fit alongside the other live children.
function applyChunkBudget(testCommand: TestCommand, parallel: number, slots: number, inFulltest: boolean): TestCommand {
	if (testCommand.parallel === undefined) return testCommand;
	const knowledgeCliSlots = testCommand.knowledgeCliSlots === undefined ? undefined : slots >= 2 ? 2 : 1;
	return {
		...testCommand,
		command: [
			...testCommand.command,
			...(inFulltest && testCommand.oneFile ? [] : [`--parallel=${parallel}`]),
			`--timeout=${testTimeoutMs()}`,
			...(knowledgeCliSlots === undefined ? [] : [`--max-concurrency=${knowledgeCliSlots}`]),
		],
		knowledgeCliSlots,
		parallel,
	};
}

// ANSI styling for interactive runs only; disabled when stdout is not a TTY or
// NO_COLOR is set, so CI logs and piped/aggregated output stay plain text.
const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const paint = (code: string, value: string): string => (useColor ? `\x1b[${code}m${value}\x1b[0m` : value);
const style = {
	green: (s: string) => paint("32", s),
	red: (s: string) => paint("31", s),
	bold: (s: string) => paint("1", s),
	dim: (s: string) => paint("2", s),
};

// Outcome of one finished chunk. `output` is the chunk's combined stdout+stderr,
// buffered so it can be withheld during a quiet run and replayed only on failure.
// `retries` counts extra attempts spent on bun-crash exits (see BUN_CRASH_EXITS).
interface ChunkOutcome {
	label: string;
	command: string;
	exitCode: number;
	seconds: number;
	output: string;
	retries: number;
}

// Human duration in bun's bracket style: `[264ms]` under a second, `[3.3s]`
// above. Used by the progress line and footer so timings read like `bun test`.
function formatDuration(seconds: number): string {
	return seconds < 1 ? `${Math.round(seconds * 1000)}ms` : `${seconds.toFixed(1)}s`;
}

// One-line live progress entry in `bun test` style: `✓ <label> [time]` for a
// pass, `✗ <label> [time]` for a failure (bold red so the eye lands on it in a
// long scroll). A failure also names the first failing test parsed from the
// captured output — `— file > test (+N more)` — so the exact break is visible
// in the stream without waiting for the end-of-run report. Emitted in completion
// order as each chunk finishes.
function formatProgressLine(outcome: ChunkOutcome): string {
	const time = style.dim(`[${formatDuration(outcome.seconds)}]`);
	const retryNote = outcome.retries > 0 ? ` ${style.dim(`(retried ×${outcome.retries} after bun crash)`)}` : "";
	if (outcome.exitCode === 0) {
		return `${style.green("✓")} ${outcome.label} ${time}${retryNote}`;
	}
	const failing = extractFailingTests(outcome.output);
	const first = failing[0]?.name;
	const more = failing.length > 1 ? style.dim(` (+${failing.length - 1} more)`) : "";
	const detail = first ? ` ${style.dim("—")} ${style.red(first)}${more}` : "";
	return `${style.bold(style.red(`✗ ${outcome.label}`))} ${time}${detail}${retryNote}`;
}

// Closing tally in `bun test` style, but counting test *chunks* (child commands),
// not individual tests — the runner never parses child summaries. A green
// `N chunks passed` line, a `N failed` line (red when non-zero, dim when clean),
// then the total wall time. Printed after the failure report so a run always
// ends on an at-a-glance verdict.
function formatSummaryFooter(passed: number, failed: number, totalSeconds: number): string {
	const failLine = failed > 0 ? style.red(`${failed} failed`) : style.dim("0 failed");
	return [
		"",
		` ${style.green(`${passed} chunks passed`)}`,
		` ${failLine}`,
		style.dim(`Ran ${passed + failed} test command(s) in ${formatDuration(totalSeconds)}.`),
	].join("\n");
}

// A single failing test pulled from a chunk's captured bun output: its
// `file > test` identifier and the verbatim failure block bun printed for it
// (source frame, `error:` line, received/expected) — the detail a developer
// needs to act without re-running.
interface FailingTest {
	name: string;
	detail: string;
}

// Parse the failing tests + their detail blocks out of a chunk's captured bun
// output. Bun emits, per failure, a source code frame and `error:` block
// *followed by* its `(fail) <name> [<time>]` marker, all under the most recent
// `<relative/path>.test.ts:` header. We track the current header, buffer the
// lines since the last marker/header (that's the pending failure's frame), and
// flush them when the `(fail)` line arrives. ANSI is stripped only to classify
// lines; the detail keeps bun's original bytes (incl. color). Returns `[]` when
// the chunk died without per-test markers (e.g. a compile/import crash), so the
// caller can fall back to replaying the raw log.
const ANSI_RE = /\x1b\[[0-9;]*m/g;
const FILE_HEADER_RE = /^(\S.*\.test\.[cm]?[jt]sx?):$/;
const FAIL_MARKER_RE = /^\(fail\)\s+(.*?)(?:\s+\[[\d.]+\s*m?s\])?$/;
function extractFailingTests(output: string): FailingTest[] {
	const failing: FailingTest[] = [];
	let currentFile = "";
	let buffer: string[] = [];
	for (const raw of output.split("\n")) {
		const line = raw.replace(ANSI_RE, "").trim();
		const header = FILE_HEADER_RE.exec(line);
		if (header) {
			currentFile = header[1];
			buffer = [];
			continue;
		}
		const fail = FAIL_MARKER_RE.exec(line);
		if (fail) {
			failing.push({
				name: currentFile ? `${currentFile} > ${fail[1]}` : fail[1],
				detail: buffer.join("\n").trim(),
			});
			buffer = [];
			continue;
		}
		buffer.push(raw);
	}
	return failing;
}

// Final report for the chunks that failed. Each chunk lists its failing tests,
// and under each test name bun's own failure block (source frame + `error:` +
// received/expected) is reproduced verbatim — caret alignment and diffs intact —
// so it reads like a direct `bun test` failure. In quiet mode (`replayOutput`)
// the blocks are shown because the run withheld them; in verbose mode they
// already streamed inline, so only the names are listed. When a chunk crashed
// without per-test markers (no parseable failures) the raw log is replayed as a
// fallback in quiet mode.
function formatChunkFailure(failure: ChunkOutcome, replayOutput: boolean): string {
	const lines: string[] = [];
	lines.push(
		"",
		style.bold(style.red(`✗ ${failure.label} (exit ${failure.exitCode})`)),
		style.dim(`$ ${failure.command}`),
	);
	const failing = extractFailingTests(failure.output);
	// Fully attributed only when every failure carries its own bun block;
	// otherwise (no markers, or a marker with no preceding frame — timeouts,
	// crashes) name what we can and replay the raw log so no error is lost.
	const fullyAttributed = failing.length > 0 && failing.every(test => test.detail.length > 0);
	for (const test of failing) {
		lines.push("", `  ${style.red("✗")} ${style.bold(test.name)}`);
		// Flush-left and verbatim so bun's caret/diff alignment is preserved.
		if (replayOutput && fullyAttributed) {
			lines.push(test.detail);
		}
	}
	if (replayOutput && !fullyAttributed && failure.output.trim().length > 0) {
		lines.push("", failure.output.trimEnd());
	}
	return lines.join("\n");
}

// Refill on every completion, including when one weighted chunk releases
// multiple slots. Skip blocked entries without disturbing runnable order.
interface PoolLease<T> {
	budget: number;
	slots: (item: T) => readonly [minimum: number, preferred: number];
	/** Absolute slot capacity; only the gate-owned shared pool can grow. */
	readBudget?: () => number | undefined;
}

export async function runBoundedPool<T>(
	items: T[],
	concurrency: number,
	isBounded: (item: T) => boolean,
	boundedLimit: number,
	run: (item: T, slots: number) => Promise<void>,
	isExclusive: (item: T) => boolean = () => false,
	lease?: PoolLease<T>,
): Promise<void> {
	let budget = lease?.budget ?? concurrency;
	let width = concurrency;
	const queue = items.map(item => {
		const [minimum, preferred] = lease?.slots(item) ?? [1, 1];
		return { item, bounded: isBounded(item), exclusive: isExclusive(item), minimum, preferred };
	});
	const done = Promise.withResolvers<void>();
	let active = 0;
	let activeSlots = 0;
	let activeBounded = 0;
	let activeExclusive = 0;
	let failed = false;
	async function runEntry(entry: (typeof queue)[number], slots: number): Promise<void> {
		try {
			await run(entry.item, slots);
		} catch (error) {
			failed = true;
			done.reject(error);
		} finally {
			active--;
			activeSlots -= slots;
			if (entry.bounded) activeBounded--;
			if (entry.exclusive) activeExclusive--;
		}
		dispatch();
	}
	function dispatch(): void {
		while (!failed && active < width && queue.length) {
			const available = budget - activeSlots;
			const index = queue.findIndex(
				entry =>
					entry.minimum <= available &&
					(!entry.bounded || activeBounded < boundedLimit) &&
					(!entry.exclusive || activeExclusive === 0),
			);
			if (index === -1) break;
			const [entry] = queue.splice(index, 1);
			const slots = Math.min(available, entry.preferred);
			active++;
			activeSlots += slots;
			if (entry.bounded) activeBounded++;
			if (entry.exclusive) activeExclusive++;
			void runEntry(entry, slots);
		}
		if (!active && !queue.length) done.resolve();
	}
	function refreshBudget(): void {
		if (failed || !queue.length) return;
		const updated = lease?.readBudget?.();
		if (updated !== undefined && updated > budget) {
			budget = updated;
			width = Math.min(items.length, updated);
			dispatch();
		}
	}
	refreshBudget();
	dispatch();
	const timer = lease?.readBudget && queue.length ? setInterval(refreshBudget, 1000).unref() : undefined;
	try {
		await done.promise;
	} finally {
		clearInterval(timer);
	}
}

// Run every command through a bounded worker pool. Each child's stdout and
// stderr are drained concurrently (so a chatty test never deadlocks on a full
// pipe) and buffered. Quiet mode (the default) prints one progress line per
// finished chunk and replays full output only for failures, in a single report
// at the end; `--full` streams every chunk's output inline as it completes.
// Gate-owned runs also stream authenticated failure notifications, but keep
// executing independent work until the shared deadline or cancellation.
async function runTestCommandsInParallel(
	commands: TestCommand[],
	concurrency: number,
	budget?: PoolLease<TestCommand>,
	materialize?: (command: TestCommand, slots: number) => TestCommand,
): Promise<number> {
	const env = buildChildEnv();
	const failures: ChunkOutcome[] = [];
	let completed = 0;
	let firstFailureExitCode: number | undefined;
	let failureReported = false;
	function reportFirstFailure(error: GateCommandError): boolean {
		if (failureReported) return false;
		failureReported = true;
		reportGateFailure(error);
		return true;
	}
	const fileWidths = [...new Set(commands.map(command => command.parallel).filter(width => width !== undefined))];
	if (sharedFulltestPool && (budget?.budget ?? 1) >= 2 && commands.some(hasElasticFulltestFiles)) fileWidths.push(2);
	fileWidths.sort((a, b) => a - b);
	console.log(
		`Running ${commands.length} test command(s), up to ${concurrency} in parallel ` +
			`(OMP_TEST_CONCURRENCY=<n> to lower); ${os.availableParallelism()} cores, ` +
			`--parallel=${fileWidths.join("/") || "n/a"} per chunk${sharedFulltestPool ? " (shared fulltest budget)" : ""}.`,
	);

	// Incremental, cancellable drain into a mutable sink, so a watchdog-killed
	// chunk still reports whatever the child managed to print before it wedged.
	function drainInto(
		stream: ReadableStream<Uint8Array>,
		sink: { text: string },
		failureObserver?: BunTestFailureObserver,
	): { done: Promise<void>; cancel: () => void } {
		const decoder = new TextDecoder();
		const reader = stream.getReader();
		const done = (async () => {
			try {
				for (;;) {
					const { done: ended, value } = await reader.read();
					if (ended) break;
					failureObserver?.push(value);
					const text = decoder.decode(value, { stream: true });
					sink.text += text;
					if (gateReportsFailures) process.stdout.write(text);
				}
			} catch {
				// cancelled or broken pipe — keep what was captured
			}
			failureObserver?.end();
			const final = decoder.decode();
			sink.text += final;
			if (gateReportsFailures && final) process.stdout.write(final);
		})();
		return { done, cancel: () => void reader.cancel().catch(() => {}) };
	}

	// Wait for `promise` at most `ms`; resolves `true` when it settled in time.
	// Never rejects.
	async function settleWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
		const { promise: expired, resolve } = Promise.withResolvers<boolean>();
		const timer = setTimeout(() => resolve(false), ms);
		const settled = await Promise.race([
			promise.then(
				() => true,
				() => true,
			),
			expired,
		]);
		clearTimeout(timer);
		return settled;
	}

	// One spawn of a chunk: pipes drained into buffers, watchdog-killed if it
	// wedges, post-exit drain capped so leaked grandchildren holding the pipes
	// can't keep the runner's event loop alive.
	async function runAttempt(
		testCommand: TestCommand,
		attempt: number,
	): Promise<{ exitCode: number; output: string; timedOut: boolean; missing: boolean; command: string }> {
		const { command, reportPath } = reportedCommand(testCommand, attempt);
		const startedAt = new Date().toISOString();
		const start = performance.now();
		const proc = Bun.spawn(command, {
			cwd: path.join(repoRoot, testCommand.cwd),
			env: testCommandEnv(testCommand, env),
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdout = { text: "" };
		const stderr = { text: "" };
		let firstCaseFailure = false;
		const stdoutDrain = drainInto(proc.stdout as ReadableStream<Uint8Array>, stdout);
		const stderrDrain = drainInto(
			proc.stderr as ReadableStream<Uint8Array>,
			stderr,
			gateReportsFailures
				? new BunTestFailureObserver(error => {
						firstCaseFailure = reportFirstFailure(error);
					})
				: undefined,
		);
		const drains = Promise.all([stdoutDrain.done, stderrDrain.done]);
		// Watchdog: a wedged child (e.g. bun's panic handler deadlocking
		// after a GC crash) would otherwise hang this worker forever.
		let timedOut = false;
		const timeoutMs = chunkTimeoutMs();
		let watchdogOutput = "";
		const killTimer = setTimeout(async () => {
			timedOut = true;
			try {
				const stuckTree = await describeStuckProcessTree(proc.pid);
				watchdogOutput = `\n${stuckTree}[watchdog] chunk exceeded ${Math.round(timeoutMs / 1000)}s; killed with SIGKILL (OMP_TEST_CHUNK_TIMEOUT to change)\n`;
				// This is runner output, not child output, so the gate's pipe drains won't forward it.
				if (gateReportsFailures) process.stdout.write(`\n==> ${testCommand.label}${watchdogOutput}`);
			} finally {
				proc.kill("SIGKILL");
			}
		}, timeoutMs);
		const exitCode = await proc.exited;
		if ((exitCode !== 0 || timedOut) && !canRetryBunCrash(exitCode, timedOut, attempt)) {
			// A gate may already have observed this chunk's failing case before
			// other workers exited. Keep that ordering, but preserve the exit code.
			if (firstCaseFailure) firstFailureExitCode = exitCode || 1;
			else firstFailureExitCode ??= exitCode || 1;
			if (gateReportsFailures && !failureReported)
				reportFirstFailure(
					new GateCommandError(`${testCommand.label} ${describeChunkFailure(exitCode, timedOut)}`, exitCode),
				);
		}
		clearTimeout(killTimer);
		if (!(await settleWithin(drains, 5000))) {
			stdoutDrain.cancel();
			stderrDrain.cancel();
			await drains;
		}
		const missing = await recordAttempt(
			testCommand,
			attempt,
			command,
			reportPath,
			startedAt,
			(performance.now() - start) / 1000,
			exitCode,
			timedOut,
			`${stdout.text}${stderr.text}`,
		);
		if (missing && exitCode === 0) console.error(`${testCommand.label} missing JUnit report: ${reportPath}`);
		return {
			exitCode,
			timedOut,
			missing,
			command: command.map(shellQuote).join(" "),
			output: `${stdout.text}${stderr.text}${watchdogOutput}${missing ? `\nMissing or empty JUnit report: ${reportPath}\n` : ""}`,
		};
	}

	async function runChunk(testCommand: TestCommand): Promise<void> {
		const startedAt = performance.now();
		let attempt = 1;
		let result = await runAttempt(testCommand, attempt);
		// Bun-crash retry: a 128+signal exit means the runtime died (GC
		// segfault/abort), not that tests failed — rerun in a fresh heap.
		while (canRetryBunCrash(result.exitCode, result.timedOut, attempt)) {
			attempt += 1;
			process.stdout.write(
				`${style.dim(`↻ ${testCommand.label} — bun crashed (exit ${result.exitCode}); retrying (attempt ${attempt}/${MAX_CHUNK_ATTEMPTS})`)}\n`,
			);
			result = await runAttempt(testCommand, attempt);
		}
		completed += 1;
		const outcome: ChunkOutcome = {
			label: testCommand.label,
			command: result.command,
			exitCode: result.exitCode,
			seconds: (performance.now() - startedAt) / 1000,
			output: result.output,
			retries: attempt - 1,
		};
		if (quiet) {
			let msg = `${formatProgressLine(outcome)}\n`;
			if (!gateReportsFailures && (outcome.exitCode !== 0 || result.timedOut)) {
				msg += `${formatChunkFailure(outcome, true)}\n`;
			}
			process.stdout.write(msg);
		} else {
			const status = outcome.exitCode === 0 ? "ok" : `FAILED exit ${outcome.exitCode}`;
			process.stdout.write(
				`\n==> [${completed}/${commands.length}] ${testCommand.label} (${status}, ${outcome.seconds.toFixed(1)}s)\n$ ${result.command}\n${gateReportsFailures ? "" : outcome.output}`,
			);
		}
		if (outcome.exitCode !== 0 || result.timedOut) {
			failures.push(outcome);
		}
	}

	const runStartedAt = performance.now();
	// A real Chromium owns several native processes and its own CDP transport.
	// Admit one browser chunk while the other workers continue draining ordinary
	// startup/integration work; do not lower the lane's CPU/file concurrency.
	await runBoundedPool(
		commands,
		concurrency,
		command =>
			sharedFulltestPool
				? isStartupCommand(command) || isIntegrationCommand(command)
				: isLimitedIntegrationCommand(command),
		4,
		(command, slots) => runChunk(materialize?.(command, slots) ?? command),
		isBrowserCommand,
		budget,
	);

	if (quiet) {
		const totalSeconds = (performance.now() - runStartedAt) / 1000;
		process.stdout.write(`${formatSummaryFooter(completed - failures.length, failures.length, totalSeconds)}\n`);
	} else if (failures.length > 0) {
		process.stdout.write(style.bold(style.red(`\n${failures.length} of ${commands.length} test chunk(s) FAILED\n`)));
	}
	return firstFailureExitCode ?? 0;
}

export async function runTestCommands(commands: TestCommand[], poolWidth?: number): Promise<number> {
	if (poolWidth !== undefined && !isDryRun) return runTestCommandsInParallel(commands, poolWidth);
	let firstFailureExitCode: number | undefined;
	for (const command of commands) {
		let failureReported = false;
		const notifyFailure = gateReportsFailures
			? (error: GateCommandError) => {
					if (failureReported) return;
					failureReported = true;
					reportGateFailure(error);
				}
			: undefined;
		try {
			await runTestCommand(command, notifyFailure);
		} catch (error) {
			const failure = gateFailure(error);
			firstFailureExitCode ??= failure.exitCode;
			notifyFailure?.(failure);
			console.error(failure.message);
		}
	}
	return firstFailureExitCode ?? 0;
}

// `OMP_TEST_SHARD=i/n` splits a mode's chunk commands across n CI jobs; job i
// runs every chunk whose index ≡ i-1 (mod n). Round-robin rather than
// contiguous ranges so neighbouring suites spread evenly instead of piling
// into one shard. The command order is deterministic.
// Every chunk lands in exactly one shard; unset/empty runs everything.
function selectShard<T>(commands: T[], spec: string | undefined): T[] {
	const trimmed = spec?.trim();
	if (!trimmed) return commands;
	const match = /^(\d+)\/(\d+)$/.exec(trimmed);
	const index = match ? Number(match[1]) : 0;
	const count = match ? Number(match[2]) : 0;
	if (!match || count < 1 || index < 1 || index > count) {
		throw new Error(`Invalid OMP_TEST_SHARD=${JSON.stringify(trimmed)}; expected i/n with 1 <= i <= n`);
	}
	const selected = commands.filter((_, i) => i % count === index - 1);
	if (selected.length === 0) {
		throw new Error(`OMP_TEST_SHARD=${trimmed} selects no chunks (${commands.length} available)`);
	}
	return selected;
}

// These Knowledge suites have repeatedly dominated cold fulltest timings. Only
// use this fallback when that exact chunk has no usable measurement.
const expensiveFulltestFiles = [
	knowledgeCliTest,
	"test/knowledge-search-tool.test.ts",
	"test/knowledge-semantic.test.ts",
];

// The producer label and exact pre-budget argv together identify an unchanged
// chunk. Never distribute a chunk's wall time among its files or rechunk it.
export function prioritizeBunCommands<T extends TestCommand>(
	commands: T[],
	producers: TestProducerRecord[],
	scope: BunFulltestProducerScope,
): T[] {
	const durations = new Map<string, number>();
	const ambiguous = new Set<string>();
	for (const producer of producers) {
		const key = bunTestProducerKey(producer, scope);
		if (!key) continue;
		if (durations.has(key)) {
			ambiguous.add(key);
			continue;
		}
		durations.set(key, producer.durationSeconds);
	}
	for (const key of ambiguous) durations.delete(key);
	return commands
		.map(command => {
			const duration = durations.get(JSON.stringify([command.label, command.command]));
			const fallback =
				duration === undefined && command.cwd === "packages/coding-agent"
					? expensiveFulltestFiles.findIndex(file => command.command.includes(file))
					: expensiveFulltestFiles.length;
			return { command, duration, fallback: fallback < 0 ? expensiveFulltestFiles.length : fallback };
		})
		.sort((a, b) => (b.duration ?? -1) - (a.duration ?? -1) || a.fallback - b.fallback)
		.map(item => item.command);
}

/** Preserve history order within each group while offering startup work early. */
function interleaveFulltestCommands(commands: TestCommand[], parallel: boolean): TestCommand[] {
	const startup: TestCommand[] = [];
	const ordinary: TestCommand[] = [];
	for (const command of commands) (command.selection?.group === "startup" ? startup : ordinary).push(command);
	if (!parallel) return [...startup, ...ordinary];
	// This is only a queue preference, not a separate startup reservation.
	const scheduled: TestCommand[] = [];
	let cursor = 0;
	for (const command of startup) {
		scheduled.push(command);
		for (let i = 0; i < 3 && cursor < ordinary.length; i++) scheduled.push(ordinary[cursor++]!);
	}
	for (; cursor < ordinary.length; cursor++) scheduled.push(ordinary[cursor]!);
	return scheduled;
}

/** Only this whole-package chunk can use a second file worker in the shared pool. */
function hasElasticFulltestFiles(command: TestCommand): boolean {
	return command.cwd === "packages/ai" && command.parallel !== undefined;
}

/** Revision history only orders chunks; worktree changes never invalidate test execution. */
export async function verifiedFulltestRevision(
	expected: string | undefined,
	root: string = repoRoot,
): Promise<string | undefined> {
	if (!expected || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(expected)) return undefined;
	try {
		const child = Bun.spawn(["git", "rev-parse", "HEAD"], { cwd: root, stdout: "pipe", stderr: "ignore" });
		const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
		return exitCode === 0 && stdout.trim() === expected ? expected : undefined;
	} catch {
		return undefined;
	}
}

/** The gate publishes only a number, at a fixed location in its isolated home. */
function sharedFulltestBudgetReader(initial: number): PoolLease<TestCommand>["readBudget"] {
	const ceiling = Number(Bun.env.OMP_FULLTEST_BUN_MAX_CAPACITY);
	const home = Bun.env.HOME;
	if (
		!Number.isSafeInteger(ceiling) ||
		ceiling <= initial ||
		ceiling !== testConcurrencyLimit(os.availableParallelism(), process.platform, String(ceiling)) ||
		!home ||
		!path.isAbsolute(home) ||
		path.basename(home) !== "typescript"
	)
		return;
	const root = path.dirname(home);
	const name = path.basename(root);
	if (
		!name.startsWith(FULLTEST_HOME_PREFIX) ||
		!/^[A-Za-z0-9]{6}$/.test(name.slice(FULLTEST_HOME_PREFIX.length)) ||
		fulltestStartupHome !== path.join(root, "typescript-startup")
	)
		return;
	const file = path.join(root, FULLTEST_BUN_CAPACITY_FILE);
	return () => {
		try {
			const stat = lstatSync(file);
			if (stat.isFile() && stat.size <= ceiling) return stat.size;
		} catch {
			// Cleanup can remove the file on cancellation; never increase on a failed read.
		}
	};
}

// Fork gates and changelog tests reuse the child environment and timeout helpers.
// Importing them must not validate a CLI mode or start the upstream test plan.
if (import.meta.main) {
	if (!(requestedMode in validModes)) {
		throw new Error(
			`Unknown mode ${shellQuote(requestedMode)}. Expected one of: ${Object.keys(validModes).join(", ")}`,
		);
	}
	const deferStartup = args.includes("--defer-startup");
	const onlyStartup = args.includes("--only-startup");
	if (deferStartup && onlyStartup) throw new Error("--defer-startup and --only-startup are mutually exclusive");
	if ((deferStartup || onlyStartup) && requestedMode !== "local-ts" && requestedMode !== "all")
		throw new Error("--defer-startup and --only-startup require local-ts or all mode");
	if (sharedFulltestPool && (requestedMode !== "all" || deferStartup || onlyStartup))
		throw new Error("--shared-fulltest-pool requires all mode without --defer-startup or --only-startup");
	const changedArgs = args.filter(arg => arg === "--changed" || arg.startsWith("--changed="));
	if (changedArgs.length > 1 || changedArgs.some(arg => arg === "--changed="))
		throw new Error("Expected at most one --changed or --changed=<ref> option");
	const historyScope =
		reportScope === "ci-test-ts:local-ts" || reportScope === "ci-test-ts:all" ? reportScope : undefined;
	const inFulltest = Boolean(
		(sharedFulltestPool || deferStartup || onlyStartup) &&
		historyScope &&
		gateReportsFailures &&
		(await isActiveBunFulltest(historyScope)),
	);
	const commands = await commandsForMode(requestedMode as Mode, sharedFulltestPool || inFulltest);
	// Explicit upstream native mode may require the desktop authorization boundary.
	if (args.includes("--exclude-desktop") && requestedMode !== "local" && requestedMode !== "local-ts") {
		const native = commands.find(command => command.cwd === "packages/natives");
		if (native) {
			const files: string[] = [];
			for (const pattern of ["**/*.{test,spec}.{js,jsx,ts,tsx}", "**/*_{test,spec}.{js,jsx,ts,tsx}"]) {
				for await (const file of new Bun.Glob(pattern).scan({
					cwd: path.join(repoRoot, native.cwd),
					onlyFiles: true,
				})) {
					const normalized = file.replaceAll("\\", "/");
					if (normalized !== "test/desktop.test.ts" && !normalized.split("/").includes("node_modules"))
						files.push(normalized);
				}
			}
			if (!files.length) throw new Error("No native tests remain after excluding desktop input");
			native.command.push(...[...new Set(files)].sort());
		}
	}
	const localMode = requestedMode === "local" || requestedMode === "local-ts";
	let requestedCommands =
		localMode || args.includes("--unsharded") ? commands : selectShard(commands, Bun.env.OMP_TEST_SHARD);
	if (deferStartup || onlyStartup)
		requestedCommands = requestedCommands.filter(command => isStartupCommand(command) === onlyStartup);
	const group = onlyStartup ? "startup" : deferStartup ? "ordinary" : "all";
	if (deferStartup || onlyStartup)
		console.log(`test-command-group=${group} chunks=${requestedCommands.length}; partial ${requestedMode} plan`);
	let selection: BunSelection = changedArgs.length
		? {
				tool: "bun",
				mode: "affected",
				baseline: changedArgs[0]!.slice("--changed=".length) || undefined,
				reason: "explicit affected selection",
			}
		: localMode
			? await bunTestSelection()
			: { tool: "bun", mode: "full", reason: "full selection requested" };
	if (
		!changedArgs.length &&
		selection.mode === "affected" &&
		!(await bunCanTraceChanges(repoRoot, selection.baseline ?? "HEAD"))
	) {
		selection = { tool: "bun", mode: "full", reason: "untraceable native, dynamic, or unknown input" };
	}
	if (deferStartup || onlyStartup) selection.group = onlyStartup ? "startup" : "ordinary";
	if (requestedMode === "local-ts") selection.suiteRevision = BUN_FORK_SUITE_REVISION;
	if (
		requestedCommands.length &&
		requestedMode === "local-ts" &&
		!changedArgs.length &&
		(await bunCleanBaseline(selection))
	) {
		// Ask Bun to confirm the empty selection using one selected fork file.
		const first = requestedCommands.find(command => command.parallel !== undefined)!;
		const file = first.command.find(arg => /\.(?:test|e2e)\.tsx?$/.test(arg))!;
		requestedCommands = [
			{
				label: "Bun native empty affected selection",
				cwd: first.cwd,
				command: ["bun", "test", ...onlyFailuresArgs, file],
				parallel: 1,
				requireNoSelection: true,
			},
		];
	}
	if (localMode) {
		const count = requestedCommands.reduce(
			(sum, command) => sum + command.command.filter(arg => /\.(?:test|e2e)\.tsx?$/.test(arg)).length,
			0,
		);
		console.log(`scope=fork-features selected-files=${count} chunks=${requestedCommands.length}`);
	}
	console.log(
		selection.mode === "affected"
			? `selection=affected-tests-only tool=bun baseline=${selection.baseline ?? "working-tree"}; not full coverage`
			: `selection=${group === "all" ? "full" : `full-${group}-group`} tool=bun reason=${selection.reason}`,
	);
	const groupedSelection = {
		startup: { ...selection, group: "startup" as const },
		ordinary: { ...selection, group: "ordinary" as const },
	};
	for (const command of requestedCommands) {
		if (command.parallel === undefined) continue;
		command.selection = sharedFulltestPool
			? groupedSelection[isStartupCommand(command) ? "startup" : "ordinary"]
			: selection;
		if (selection.mode === "affected") command.command.push(changedArgs[0] ?? `--changed=${selection.baseline}`);
	}
	// Prioritize within the selected shard, without changing shard membership.
	requestedCommands.sort((a, b) => Number(isIntegrationCommand(b)) - Number(isIntegrationCommand(a)));
	const scheduledCommands =
		selection.mode === "full" && inFulltest && historyScope
			? prioritizeBunCommands(
					requestedCommands,
					await latestFulltestBunProducers(
						historyScope,
						await verifiedFulltestRevision(Bun.env.OMP_FULLTEST_SOURCE_REVISION),
					),
					historyScope,
				)
			: requestedCommands;
	const explicitConcurrency = Boolean(Bun.env.OMP_TEST_CONCURRENCY?.trim());
	// CI defaults to one process at a time, but memory-sized workflow buckets
	// explicitly opt into bounded process concurrency. Local runs fan out by
	// default and may use the same override. Resolve before dry-run so it prints
	// the selected test argv with the CPU budget; reporter paths are live-run only.
	const pooled = scheduledCommands.length > 1 && (localMode || !isCI() || explicitConcurrency);
	// The sequential path is a pool of one, so a lone chunk keeps the whole budget.
	const poolWidth = pooled
		? testConcurrency(scheduledCommands.length, Bun.env.OMP_TEST_CONCURRENCY, os.availableParallelism())
		: 1;
	const cpuBudget = testConcurrencyLimit(os.availableParallelism());
	const scheduled = sharedFulltestPool
		? interleaveFulltestCommands(scheduledCommands, poolWidth > 1)
		: scheduledCommands;
	for (const command of scheduled) {
		if (command.parallel !== undefined)
			command.parallel = sharedFulltestPool ? 1 : budgetedParallel(command.parallel, poolWidth, cpuBudget);
	}
	const elasticFiles = (command: TestCommand) => sharedFulltestPool && hasElasticFulltestFiles(command);
	const lease: PoolLease<TestCommand> = {
		budget: cpuBudget,
		readBudget:
			sharedFulltestPool && inFulltest && pooled && !isDryRun && Bun.env.OMP_TEST_CONCURRENCY === "all"
				? sharedFulltestBudgetReader(cpuBudget)
				: undefined,
		slots: command => {
			const files = command.parallel ?? 1;
			const preferred = command.knowledgeCliSlots !== undefined || elasticFiles(command) ? 2 : 1;
			return [files, Math.min(cpuBudget, Math.max(files, preferred))];
		},
	};
	const materialize = (command: TestCommand, slots: number) =>
		applyChunkBudget(command, elasticFiles(command) ? slots : (command.parallel ?? 1), slots, inFulltest);
	const run = isDryRun ? undefined : await beginTestRun(reportScope);
	let failed = false;
	try {
		const exitCode =
			pooled && !isDryRun
				? await runTestCommandsInParallel(scheduled, poolWidth, lease, materialize)
				: await runTestCommands(scheduled.map(command => materialize(command, lease.slots(command)[1])));
		if (exitCode) {
			failed = true;
			process.exitCode = exitCode;
		}
	} catch (error) {
		failed = true;
		throw error;
	} finally {
		if (run) {
			try {
				await endTestRun(run, Number(process.exitCode) || (failed ? 1 : 0));
			} catch (error) {
				if (failed || process.exitCode) console.error("Failed to finalize test report:", error);
				else throw error;
			}
		}
	}
}
