import { createHash, randomUUID } from "node:crypto";
import { logger } from "@oh-my-pi/pi-utils";
import type { SlashCommandResult, SlashCommandRuntime, SlashCommandSpec } from "../slash-commands/types";

interface GitStep {
	args: string[];
	cwd?: string;
}

interface GitSequenceResult {
	ok: boolean;
	output: string;
}

function formatGitOutput(stdout: string, stderr: string): string {
	return [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function gitLogContext(cwd: string, args: readonly string[]): Record<string, unknown> {
	const verb = args[0] ?? "";
	return {
		component: "jch_git",
		verb:
			WORKTREE_MUTATING_GIT_VERBS.has(verb) || ["fetch", "status", "log", "rev-parse"].includes(verb)
				? verb
				: "other",
		cwd_hash: createHash("sha256").update(cwd).digest("hex").slice(0, 16),
	};
}

async function runGit(cwd: string, args: readonly string[], onStart?: () => void) {
	return logger.withLogContext(gitLogContext(cwd, args), async () => {
		const started = performance.now();
		let stage = "spawn";
		let childPid: number | undefined;
		logger.info("Git subprocess started", {
			event: "git_subprocess_started",
			stage,
			result: "started",
			executable: "git",
		});
		try {
			const process = Bun.spawn(["git", ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
			childPid = process.pid;
			logger.info("Git subprocess spawned", {
				event: "git_subprocess_spawned",
				stage,
				result: "completed",
				child_pid: childPid,
				elapsed_ms: performance.now() - started,
			});
			stage = "mutation_notification";
			onStart?.();
			stage = "settlement";
			const [exitCode, stdout, stderr] = await Promise.all([
				process.exited,
				new Response(process.stdout).text(),
				new Response(process.stderr).text(),
			]);
			const fields = {
				event: "git_subprocess_settled",
				stage,
				result: exitCode === 0 ? "completed" : "failed",
				child_pid: childPid,
				exit_code: exitCode,
				elapsed_ms: performance.now() - started,
				stdout_bytes: Buffer.byteLength(stdout),
				stderr_bytes: Buffer.byteLength(stderr),
			};
			if (exitCode === 0) logger.info("Git subprocess settled", fields);
			else logger.error("Git subprocess settled", fields);
			return { exitCode, stdout, stderr };
		} catch (error) {
			logger.error("Git subprocess failed", {
				event: "git_subprocess_failed",
				stage,
				result: "failed",
				child_pid: childPid,
				elapsed_ms: performance.now() - started,
				...logger.diagnosticError(error),
			});
			throw error;
		}
	});
}

async function runGitSequence(
	cwd: string,
	steps: readonly GitStep[],
	onMutation?: () => void,
): Promise<GitSequenceResult> {
	return logger.withLogContext(
		{
			component: "jch_git",
			operation_id: logger.getLogContext().operation_id ?? `jch-git-${randomUUID()}`,
			call_id: `git-sequence-${randomUUID()}`,
		},
		async () => {
			const started = performance.now();
			const output: string[] = [];
			let mutationNotified = false;
			let completedSteps = 0;
			let stepIndex = 0;
			let lastCompletedMutationStep: number | undefined;
			let lastCompletedMutationVerb: string | undefined;
			let resultState = "failed";
			let failure: Record<string, unknown> = {};
			logger.info("Git sequence started", {
				event: "git_sequence_started",
				stage: "sequence",
				result: "started",
				step_count: steps.length,
			});
			try {
				for (const step of steps) {
					const result = await logger.withLogContext({ step_index: stepIndex }, () =>
						runGit(step.cwd ?? cwd, step.args, () => {
							if (!WORKTREE_MUTATING_GIT_VERBS.has(step.args[0] ?? "")) return;
							if (mutationNotified) return;
							mutationNotified = true;
							logger.withLogContext({ invalidation_phase: "mutation_started" }, () => onMutation?.());
						}),
					);
					const text = formatGitOutput(result.stdout, result.stderr);
					if (text) output.push(text);
					if (result.exitCode !== 0) {
						failure = { failed_step_index: stepIndex, exit_code: result.exitCode };
						const command = `git ${step.args.join(" ")}`;
						output.push(`${command} failed with exit code ${result.exitCode}`);
						return { ok: false, output: output.join("\n") };
					}
					completedSteps++;
					if (WORKTREE_MUTATING_GIT_VERBS.has(step.args[0] ?? "")) {
						lastCompletedMutationStep = stepIndex;
						lastCompletedMutationVerb = step.args[0];
					}
					stepIndex++;
				}
				resultState = "completed";
				return { ok: true, output: output.join("\n") || "Done." };
			} catch (error) {
				failure = { failed_step_index: stepIndex, ...logger.diagnosticError(error) };
				return { ok: false, output: formatError(error) };
			} finally {
				// A reconcile can finish while Git is still running. Invalidate again
				// after settlement so later writes cannot leave that snapshot checked.
				if (mutationNotified) {
					logger.withLogContext({ invalidation_phase: "sequence_settled" }, () => onMutation?.());
				}
				const fields = {
					event: "git_sequence_settled",
					stage: "sequence",
					result: resultState,
					elapsed_ms: performance.now() - started,
					step_count: steps.length,
					completed_steps: completedSteps,
					mutation_started: mutationNotified,
					last_completed_mutation_step_index: lastCompletedMutationStep,
					last_completed_mutation_verb: lastCompletedMutationVerb,
					...failure,
				};
				if (resultState === "completed") logger.info("Git sequence settled", fields);
				else logger.error("Git sequence settled", fields);
			}
		},
	);
}

/** Git verbs that can change tracked content or the working tree; `fetch`/`status` cannot. */
const WORKTREE_MUTATING_GIT_VERBS = new Set([
	"pull",
	"merge",
	"rebase",
	"reset",
	"clean",
	"checkout",
	"switch",
	"restore",
	"stash",
	"cherry-pick",
	"revert",
	"apply",
	"am",
	"bisect",
	"rm",
	"mv",
]);

// Git mutation notifications are based on process start, not planned commands.

/**
 * The repo index hears about bash/eval tool runs through the session's tool
 * events, but these commands run git directly. Without this report, queries
 * keep serving pre-command content as complete coverage. Best-effort and
 * duck-typed so tests (and hosts without a session) can pass a plain stub.
 */
function notifyRepoWorktreeMutation(session: unknown, cwd: string): void {
	const started = performance.now();
	try {
		const host = session as
			| {
					notifyRepoCommandExecuted?: (kind: "bash" | "eval" | "git", cwd?: string) => void;
			  }
			| undefined;
		const notify = host?.notifyRepoCommandExecuted;
		notify?.call(host, "git", cwd);
		logger.info("Git repo invalidation notification settled", {
			component: "jch_git",
			event: "git_repo_invalidation_settled",
			stage: "repo_invalidation",
			result: notify ? "completed" : "skipped",
			elapsed_ms: performance.now() - started,
		});
	} catch (error) {
		logger.warn("Git repo invalidation notification failed", {
			component: "jch_git",
			event: "git_repo_invalidation_failed",
			stage: "repo_invalidation",
			result: "failed",
			elapsed_ms: performance.now() - started,
			...logger.diagnosticError(error),
		});
		// The index hint must never turn a finished git command into an error.
	}
}

async function handleGitSequence(runtime: SlashCommandRuntime, steps: readonly GitStep[]): Promise<SlashCommandResult> {
	return logger.withLogContext(
		{
			component: "jch_git",
			operation_id: logger.getLogContext().operation_id ?? `jch-git-${randomUUID()}`,
		},
		async () => {
			try {
				const result = await runGitSequence(runtime.cwd, steps, () =>
					notifyRepoWorktreeMutation(runtime.session, runtime.cwd),
				);
				await runtime.output(result.output);
			} catch (error) {
				logger.error("Git command output failed", {
					event: "git_output_failed",
					stage: "output",
					result: "failed",
					...logger.diagnosticError(error),
				});
				await runtime.output(formatError(error));
			}
			return { consumed: true };
		},
	);
}

export function handleQuickGitSummary(runtime: SlashCommandRuntime): Promise<SlashCommandResult> {
	return handleGitSequence(runtime, [
		{ args: ["status", "--short", "--branch"] },
		{ args: ["log", "--oneline", "--decorate", "-10"] },
	]);
}

export const JCH_GIT_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
	{
		name: "jchgs",
		description: "JCH Git：刷新远端引用并显示简短分支状态",
		handle: (_command, runtime) =>
			handleGitSequence(runtime, [{ args: ["fetch", "--all"] }, { args: ["status", "--short", "--branch"] }]),
	},
	{
		name: "jchgitpull",
		description: "JCH Git：直接拉取当前分支",
		handle: (_command, runtime) => handleGitSequence(runtime, [{ args: ["pull"] }]),
	},
	{
		name: "jchgitdiscardall",
		description: "JCH Git：无确认重置到跟踪分支并清理未跟踪内容（默认保留 ignored）",
		allowArgs: true,
		inlineHint: "[--ignored=true|false]",
		handle: async (_command, runtime) => {
			// Destructive imperative text must not fall through to the model on
			// non-TUI channels; point the user at the interactive TUI instead.
			logger.info("Git discard rejected", {
				component: "jch_git",
				event: "git_discard_rejected",
				stage: "channel",
				result: "rejected",
				reason: "interactive_tui_required",
				operation_id: logger.getLogContext().operation_id ?? `jch-git-${randomUUID()}`,
			});
			await runtime.output("/jchgitdiscardall only runs in the interactive TUI.");
			return { consumed: true };
		},
		handleTui: async (command, runtime) =>
			logger.withLogContext(
				{
					component: "jch_git",
					operation_id: logger.getLogContext().operation_id ?? `jch-git-${randomUUID()}`,
					call_id: `git-discard-${randomUUID()}`,
				},
				async () => {
					const args = command.args.trim();
					if (args !== "" && args !== "--ignored=false" && args !== "--ignored=true") {
						logger.info("Git discard rejected", {
							event: "git_discard_rejected",
							stage: "arguments",
							result: "rejected",
							reason: "invalid_arguments",
						});
						runtime.ctx.showError("Usage: /jchgitdiscardall [--ignored=true|false]");
						return { consumed: true };
					}
					runtime.ctx.editor.setText("");
					// Keep discard steps in order; `clean` joins after its repo-wide cwd is resolved.
					const steps: GitStep[] = [
						{ args: ["fetch", "--all", "--prune"] },
						{ args: ["reset", "--hard", "@{upstream}"] },
					];
					const started = performance.now();
					let stage = "preflight";
					let resultState = "failed";
					let failure: Record<string, unknown> = {};
					logger.info("Git discard started", {
						event: "git_discard_started",
						stage,
						result: "started",
						clean_ignored: args === "--ignored=true",
					});
					try {
						const cwd = runtime.ctx.sessionManager.getCwd();
						// `clean` only sweeps below its cwd while the reset is repo-wide;
						// resolve the toplevel so a session opened in a subdirectory still
						// discards untracked files across the whole worktree.
						const toplevel = await logger.withLogContext({ phase: "preflight", step_index: -1 }, () =>
							runGit(cwd, ["rev-parse", "--show-toplevel"]),
						);
						if (toplevel.exitCode !== 0) {
							failure = { exit_code: toplevel.exitCode };
							runtime.ctx.showError(formatGitOutput(toplevel.stdout, toplevel.stderr));
							return { consumed: true };
						}
						steps.push({
							args: ["clean", args === "--ignored=true" ? "-xdf" : "-df"],
							cwd: toplevel.stdout.trim(),
						});
						stage = "sequence";
						const result = await runGitSequence(cwd, steps, () =>
							notifyRepoWorktreeMutation(runtime.ctx.session, cwd),
						);
						resultState = result.ok ? "completed" : "failed";
						stage = "output";
						if (result.ok) runtime.ctx.showStatus(result.output);
						else runtime.ctx.showError(result.output);
					} catch (error) {
						resultState = "failed";
						failure = logger.diagnosticError(error);
						runtime.ctx.showError(formatError(error));
					} finally {
						const fields = {
							event: "git_discard_settled",
							stage,
							result: resultState,
							elapsed_ms: performance.now() - started,
							...failure,
						};
						if (resultState === "completed") logger.info("Git discard settled", fields);
						else logger.error("Git discard settled", fields);
					}
					return { consumed: true };
				},
			),
	},
];
