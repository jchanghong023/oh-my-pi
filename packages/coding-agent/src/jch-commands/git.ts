import type { SlashCommandResult, SlashCommandRuntime, SlashCommandSpec } from "../slash-commands/types";

interface GitStep {
	args: string[];
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
	for (const step of steps) {
		const result = await runGit(cwd, step.args);
		const text = formatGitOutput(result.stdout, result.stderr);
		if (text) output.push(text);
		if (result.exitCode !== 0) {
			const command = `git ${step.args.join(" ")}`;
			output.push(`${command} failed with exit code ${result.exitCode}`);
			return { ok: false, output: output.join("\n") };
		}
	}
	return { ok: true, output: output.join("\n") || "Done." };
}

async function handleGitSequence(runtime: SlashCommandRuntime, steps: readonly GitStep[]): Promise<SlashCommandResult> {
	try {
		const result = await runGitSequence(runtime.cwd, steps);
		await runtime.output(result.output);
	} catch (error) {
		await runtime.output(formatError(error));
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
		description: "JCH Git：刷新、重置到 upstream 并清理全部本地内容",
		handleTui: async (_command, runtime) => {
			runtime.ctx.editor.setText("");
			try {
				const result = await runGitSequence(runtime.ctx.sessionManager.getCwd(), [
					{ args: ["fetch", "--all", "--prune"] },
					{ args: ["reset", "--hard", "@{upstream}"] },
					{ args: ["clean", "-xdf"] },
				]);
				if (result.ok) runtime.ctx.showStatus(result.output);
				else runtime.ctx.showError(result.output);
			} catch (error) {
				runtime.ctx.showError(formatError(error));
			}
			return { consumed: true };
		},
	},
];
