import { prompt } from "@oh-my-pi/pi-utils";
import { isJchToolsAgentModel } from "../config/jchtools-provider";
import workflowPrompt from "../prompts/jch-workflow.md" with { type: "text" };
import workflowzBatchPrompt from "../prompts/jch-workflowzbatch.md" with { type: "text" };
import { parseSubcommand, usage } from "../slash-commands/helpers/parse";
import type { SlashCommandSpec } from "../slash-commands/types";
import { defineJchPromptCommand } from "./define";
import { handleQuickGitSummary } from "./git";

const JCH_FUNCTIONAL_REVIEW_FIX_USAGE =
	"用法：/jchfuncreviewfix uncommitted | /jchfuncreviewfix commit <ref> | /jchfuncreviewfix repo";
const JCH_FUNCTIONAL_REVIEW_USAGE =
	"用法：/jchfuncreview uncommitted | /jchfuncreview commit <ref> | /jchfuncreview path <path>";
const JCH_VERIFY_USAGE = "用法：/jchverify uncommitted | /jchverify commit <ref> | /jchverify path <path>";
const JCH_CATCHUP_USAGE = "用法：/jchcatchup | /jchcatchup full [路径、提交范围或关注点]";
const JCH_WORKFLOWZ_BATCH_USAGE = "用法：/jch-workflowzbatch <任务块软目标：正整数> <并发上限：正整数> <任务正文>";

const renderWorkflowPrompt = prompt.compile(workflowPrompt);

function resolveJchScope(args: string, mode: "review-fix" | "read-only"): string | undefined {
	const { verb, rest } = parseSubcommand(args);
	if (verb === "uncommitted" && !rest) {
		return renderWorkflowPrompt({ scopeUncommitted: true });
	}
	if (verb === "commit" && rest && !/\s/.test(rest)) {
		return renderWorkflowPrompt({ scopeCommit: true, ref: JSON.stringify(rest) });
	}
	if (mode === "review-fix" && verb === "repo" && !rest) {
		return renderWorkflowPrompt({ scopeRepo: true });
	}
	if (mode === "read-only" && verb === "path" && rest) {
		return renderWorkflowPrompt({ scopePath: true, path: JSON.stringify(rest) });
	}
	return undefined;
}

function functionalReviewPrompt(scope: string, fix: boolean): string {
	const contract = renderWorkflowPrompt({ renderContract: true, reviewScope: scope });
	const delegation = renderWorkflowPrompt({ renderDelegation: true, contract });
	return renderWorkflowPrompt({ [fix ? "renderReviewFix" : "renderReview"]: true, delegation }).trim();
}

export const JCH_WORKFLOW_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
	{
		name: "jch-workflowzbatch",
		description: "JCH：展开独立任务工作流批处理要求，禁止测试和全仓检查",
		allowArgs: true,
		remoteTask: true,
		inlineHint: "<任务块软目标> <并发上限> <任务正文>",
		handle(command, runtime) {
			// The shared parser trims args; use the original suffix to retain task whitespace.
			const args = command.text.slice(command.name.length + 2).trimStart();
			const match = /^([1-9]\d*)\s+([1-9]\d*)(?:\r\n|\s)([\s\S]*)$/.exec(args);
			if (!match) return usage(JCH_WORKFLOWZ_BATCH_USAGE, runtime);
			const targetItems = Number(match[1]);
			const maxConcurrency = Number(match[2]);
			const task = match[3]!;
			if (!Number.isSafeInteger(targetItems) || !Number.isSafeInteger(maxConcurrency) || !task.trim()) {
				return usage(JCH_WORKFLOWZ_BATCH_USAGE, runtime);
			}
			return { prompt: prompt.compile(workflowzBatchPrompt.trimEnd())({ targetItems, maxConcurrency, task }) };
		},
	},
	defineJchPromptCommand({
		name: "jchfix",
		description: "JCH：定位根因、修复问题并验证",
		inlineHint: "<问题、错误或失败现象>",
		requiredArgsUsage: "用法：/jchfix <问题、错误或失败现象>",
		prompt: renderWorkflowPrompt({ renderFix: true }),
	}),
	defineJchPromptCommand({
		name: "jchdiagnose",
		description: "JCH：只读定位问题根因与修复边界",
		inlineHint: "<问题、错误或失败现象>",
		requiredArgsUsage: "用法：/jchdiagnose <问题、错误或失败现象>",
		prompt: renderWorkflowPrompt({ renderDiagnose: true }),
	}),
	{
		name: "jchfuncreview",
		description: "JCH：只读审查高置信、现实可达的功能问题",
		allowArgs: true,
		remoteTask: true,
		inlineHint: "<uncommitted|commit <ref>|path <path>>",
		subcommands: [
			{ name: "uncommitted", description: "只读 Review 当前未提交修改" },
			{ name: "commit", description: "只读 Review 指定 commit", usage: "<ref>" },
			{ name: "path", description: "只读 Review 指定路径", usage: "<path>" },
		],
		async handle(command, runtime) {
			const scope = resolveJchScope(command.args, "read-only");
			if (!scope) return usage(JCH_FUNCTIONAL_REVIEW_USAGE, runtime);
			return { prompt: functionalReviewPrompt(scope, false) };
		},
	},
	{
		name: "jchfuncreviewfix",
		description: "JCH：审查高置信功能问题并在复核后修复",
		allowArgs: true,
		remoteTask: true,
		inlineHint: "<uncommitted|commit <ref>|repo>",
		subcommands: [
			{ name: "uncommitted", description: "Review 并修复当前未提交修改" },
			{ name: "commit", description: "Review 并修复指定 commit", usage: "<ref>" },
			{ name: "repo", description: "Review 并修复整个代码仓库" },
		],
		async handle(command, runtime) {
			const scope = resolveJchScope(command.args, "review-fix");
			if (!scope) return usage(JCH_FUNCTIONAL_REVIEW_FIX_USAGE, runtime);
			return { prompt: functionalReviewPrompt(scope, true) };
		},
	},
	{
		name: "jchverify",
		description: "JCH：独立验证指定修改并报告是否可交付",
		allowArgs: true,
		remoteTask: true,
		inlineHint: "<uncommitted|commit <ref>|path <path>>",
		subcommands: [
			{ name: "uncommitted", description: "验证当前未提交修改" },
			{ name: "commit", description: "验证指定 commit", usage: "<ref>" },
			{ name: "path", description: "验证指定路径", usage: "<path>" },
		],
		async handle(command, runtime) {
			const scope = resolveJchScope(command.args, "read-only");
			if (!scope) return usage(JCH_VERIFY_USAGE, runtime);
			return { prompt: renderWorkflowPrompt({ renderVerify: true, verifyScope: scope }).trim() };
		},
	},
	defineJchPromptCommand({
		name: "jchci",
		description: "JCH：只读检查当前分支与关联 PR 的 GitHub Actions",
		inlineHint: "[workflow 或关注点]",
		prompt: renderWorkflowPrompt({ renderCi: true }),
	}),
	defineJchPromptCommand({
		name: "jchcifix",
		description: "JCH：修复、提交并推送当前分支 CI，最多验证三轮",
		inlineHint: "[workflow=<name> 或关注点]",
		prompt: renderWorkflowPrompt({ renderCiFix: true }),
	}),
	{
		name: "jchcatchup",
		description: "JCH：快速摘要工作现场；full 深度恢复",
		allowArgs: true,
		subcommandOptional: true,
		subcommands: [{ name: "full", description: "通过代理深度恢复工作现场", usage: "[路径、提交范围或关注点]" }],
		async handle(command, runtime) {
			const { verb, rest } = parseSubcommand(command.args);
			if (!verb) return handleQuickGitSummary(runtime);
			if (verb !== "full") return usage(JCH_CATCHUP_USAGE, runtime);
			if (isJchToolsAgentModel(runtime.session.model)) return { prompt: command.text };
			return { prompt: renderWorkflowPrompt({ renderCatchup: true, focus: rest }) };
		},
	},
];
