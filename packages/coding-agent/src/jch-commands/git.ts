import type { SlashCommandResult, SlashCommandRuntime, SlashCommandSpec } from "../slash-commands/types";

interface GitStep {
	args: string[];
	cwd?: string;
}

interface GitSequenceResult {
	ok: boolean;
	output: string;
	/** True once any worktree-mutating step has started, even if it then failed. */
	mutated: boolean;
}

function formatGitOutput(stdout: string, stderr: string): string {
	return [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function runGit(cwd: string, args: readonly string[]) {
	const process = Bun.spawn(["git", ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
	const [exitCode, stdout, stderr] = await Promise.all([
		process.exited,
		new Response(process.stdout).text(),
		new Response(process.stderr).text(),
	]);
	return { exitCode, stdout, stderr };
}

async function runGitSequence(cwd: string, steps: readonly GitStep[]): Promise<GitSequenceResult> {
	const output: string[] = [];
	let mutated = false;
	for (const step of steps) {
		if (WORKTREE_MUTATING_GIT_VERBS.has(step.args[0] ?? "")) mutated = true;
		const result = await runGit(step.cwd ?? cwd, step.args);
		const text = formatGitOutput(result.stdout, result.stderr);
		if (text) output.push(text);
		if (result.exitCode !== 0) {
			const command = `git ${step.args.join(" ")}`;
			output.push(`${command} failed with exit code ${result.exitCode}`);
			return { ok: false, output: output.join("\n"), mutated };
		}
	}
	return { ok: true, output: output.join("\n") || "Done.", mutated };
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

function stepsMayMutateWorktree(steps: readonly GitStep[]): boolean {
	return steps.some(step => WORKTREE_MUTATING_GIT_VERBS.has(step.args[0] ?? ""));
}

/**
 * The repo index hears about bash/eval tool runs through the session's tool
 * events, but these commands run git directly. Without this report, queries
 * keep serving pre-command content as complete coverage. Best-effort and
 * duck-typed so tests (and hosts without a session) can pass a plain stub.
 */
function notifyRepoWorktreeMutation(session: unknown, cwd: string): void {
	try {
		(
			session as { notifyRepoCommandExecuted?: (kind: "bash" | "eval" | "git", cwd?: string) => void } | undefined
		)?.notifyRepoCommandExecuted?.("git", cwd);
	} catch {
		// The index hint must never turn a finished git command into an error.
	}
}

async function handleGitSequence(runtime: SlashCommandRuntime, steps: readonly GitStep[]): Promise<SlashCommandResult> {
	try {
		const result = await runGitSequence(runtime.cwd, steps);
		await runtime.output(result.output);
		// A mutating step may have run even when a later step failed, so both
		// outcomes report the possible mutation.
		if (result.mutated) notifyRepoWorktreeMutation(runtime.session, runtime.cwd);
	} catch (error) {
		await runtime.output(formatError(error));
		// A throw gives no reliable progress report; report conservatively.
		if (stepsMayMutateWorktree(steps)) notifyRepoWorktreeMutation(runtime.session, runtime.cwd);
	}
	return { consumed: true };
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
			await runtime.output("/jchgitdiscardall only runs in the interactive TUI.");
			return { consumed: true };
		},
		handleTui: async (command, runtime) => {
			const args = command.args.trim();
			if (args !== "" && args !== "--ignored=false" && args !== "--ignored=true") {
				runtime.ctx.showError("Usage: /jchgitdiscardall [--ignored=true|false]");
				return { consumed: true };
			}
			runtime.ctx.editor.setText("");
			// Declared before the try so the catch can conservatively report a
			// possible worktree mutation on a throw; `clean` joins once its
			// repo-wide cwd is resolved.
			const steps: GitStep[] = [
				{ args: ["fetch", "--all", "--prune"] },
				{ args: ["reset", "--hard", "@{upstream}"] },
			];
			let cwd: string | undefined;
			try {
				cwd = runtime.ctx.sessionManager.getCwd();
				// `clean` only sweeps below its cwd while the reset is repo-wide;
				// resolve the toplevel so a session opened in a subdirectory still
				// discards untracked files across the whole worktree.
				const toplevel = await runGit(cwd, ["rev-parse", "--show-toplevel"]);
				if (toplevel.exitCode !== 0) {
					runtime.ctx.showError(formatGitOutput(toplevel.stdout, toplevel.stderr));
					return { consumed: true };
				}
				steps.push({ args: ["clean", args === "--ignored=true" ? "-xdf" : "-df"], cwd: toplevel.stdout.trim() });
				const result = await runGitSequence(cwd, steps);
				if (result.ok) runtime.ctx.showStatus(result.output);
				else runtime.ctx.showError(result.output);
				// reset/clean change the worktree; once either has started, even a
				// later failure must invalidate the repo index's pre-command coverage.
				if (result.mutated) notifyRepoWorktreeMutation(runtime.ctx.session, cwd);
			} catch (error) {
				runtime.ctx.showError(formatError(error));
				// A throw gives no reliable progress report; report conservatively.
				if (cwd !== undefined && stepsMayMutateWorktree(steps))
					notifyRepoWorktreeMutation(runtime.ctx.session, cwd);
			}
			return { consumed: true };
		},
	},
];
