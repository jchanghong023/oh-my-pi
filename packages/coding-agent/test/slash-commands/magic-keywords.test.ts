import { describe, expect, it } from "bun:test";
import { JCH_GIT_SLASH_COMMANDS } from "@oh-my-pi/pi-coding-agent/jch-commands/git";
import { ACP_BUILTIN_SLASH_COMMANDS } from "@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins";
import { BUILTIN_MAGIC_KEYWORD_SLASH_COMMANDS } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-magic-keywords";
import {
	BUILTIN_SLASH_COMMAND_RESERVED_NAMES,
	lookupBuiltinSlashCommand,
} from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import type { SlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";

const MAGIC_KEYWORDS = ["ultrathink", "orchestrate", "workflowz", "fullsend"];

async function expandJchCommand(name: string, args: string): Promise<string> {
	const command = lookupBuiltinSlashCommand(name);
	if (!command?.handle) throw new Error(`Expected /${name} to be registered`);
	const result = await command.handle(
		{ name: command.name, args, text: `/${command.name}${args ? ` ${args}` : ""}` },
		{} as SlashCommandRuntime,
	);
	if (!result || !("prompt" in result)) throw new Error(`Expected /${name} to expand to a prompt`);
	return result.prompt;
}

describe("magic keyword slash commands", () => {
	it.each(MAGIC_KEYWORDS)("advertises and sends /%s with optional task text", async keyword => {
		const command = BUILTIN_MAGIC_KEYWORD_SLASH_COMMANDS.find(candidate => candidate.name === keyword);

		expect(command).toMatchObject({
			name: keyword,
			description: `Send the ${keyword} magic keyword`,
			allowArgs: true,
			inlineHint: "[task]",
			acpInputHint: "[task]",
		});
		expect(command?.handle).toBeDefined();

		const bareResult = await command?.handle?.(
			{ name: keyword, args: "", text: `/${keyword}` },
			{} as SlashCommandRuntime,
		);
		const whitespaceResult = await command?.handle?.(
			{ name: keyword, args: "   ", text: `/${keyword}   ` },
			{} as SlashCommandRuntime,
		);
		const taskResult = await command?.handle?.(
			{ name: keyword, args: "  完成这个任务  ", text: `/${keyword}  完成这个任务  ` },
			{} as SlashCommandRuntime,
		);

		expect(bareResult).toEqual({ prompt: keyword });
		expect(whitespaceResult).toEqual({ prompt: keyword });
		expect(taskResult).toEqual({ prompt: `${keyword} 完成这个任务` });
	});
	it.each(MAGIC_KEYWORDS)("registers /%s in the builtin registry without shadowing", keyword => {
		// The keyword must be reachable through the builtin registry lookup and
		// resolve to its own magic keyword spec — a collision with another
		// command's name or alias would silently overwrite the lookup entry.
		const resolved = lookupBuiltinSlashCommand(keyword);
		expect(resolved).toMatchObject({
			name: keyword,
			allowArgs: true,
			inlineHint: "[task]",
		});
		expect(BUILTIN_SLASH_COMMAND_RESERVED_NAMES.has(keyword)).toBe(true);
	});
});

describe("JCH workflow slash commands", () => {
	it("registers the read-only workflow commands", () => {
		expect(lookupBuiltinSlashCommand("jchdiagnose")).toMatchObject({
			description: "JCH：只读定位问题根因与修复边界",
			inlineHint: "<问题、错误或失败现象>",
		});
		expect(lookupBuiltinSlashCommand("jchfuncreview")).toMatchObject({
			description: "JCH：只读审查高置信、现实可达的功能问题",
			inlineHint: "<uncommitted|commit <ref>|path <path>>",
			subcommands: [
				{ name: "uncommitted", description: "只读 Review 当前未提交修改" },
				{ name: "commit", description: "只读 Review 指定 commit", usage: "<ref>" },
				{ name: "path", description: "只读 Review 指定路径", usage: "<path>" },
			],
		});
		expect(lookupBuiltinSlashCommand("jchverify")).toMatchObject({
			description: "JCH：独立验证指定修改并报告是否可交付",
			inlineHint: "<uncommitted|commit <ref>|path <path>>",
		});
		expect(lookupBuiltinSlashCommand("jchci")).toMatchObject({
			description: "JCH：只读检查当前分支与关联 PR 的 GitHub Actions",
			inlineHint: "[workflow 或关注点]",
		});
	});

	it.each([
		["jchfix", "用法：/jchfix <问题、错误或失败现象>"],
		["jchdiagnose", "用法：/jchdiagnose <问题、错误或失败现象>"],
	])("rejects empty required arguments for /%s without invoking the agent", async (name, expectedUsage) => {
		const command = lookupBuiltinSlashCommand(name);
		if (!command?.handle) throw new Error(`Expected /${name} to be registered`);
		const output: string[] = [];
		const result = await command.handle({ name: command.name, args: "", text: `/${command.name}` }, {
			output: text => {
				output.push(text);
			},
		} as SlashCommandRuntime);

		expect(result).toEqual({ consumed: true });
		expect(output).toEqual([expectedUsage]);
	});

	it.each([
		["uncommitted", "当前工作区的全部未提交修改（包括 staged、unstaged 和 untracked 内容）。"],
		["commit v18.0.11", '指定 commit "v18.0.11" 引入的修改。'],
		["repo", "当前整个代码仓库（以工作区现状为准，包括未提交内容）。"],
	])("expands the explicit functional review-fix scope %s", async (args, scope) => {
		const prompt = await expandJchCommand("jchfuncreviewfix", args);

		expect(prompt).toContain(`Review 范围：${scope}`);
		expect(prompt).not.toContain("{{REVIEW_SCOPE}}");
		expect(prompt.match(/REVIEW_CONTRACT_BEGIN/g)).toHaveLength(1);
		expect(prompt).toContain("项目或目录规则要求的检查 MUST 执行，不受快速验证上限约束");
		expect(prompt).toContain("其他可选验证仅在直接覆盖问题且预计 10 秒内完成时运行");
	});

	it.each([
		["uncommitted", "当前工作区的全部未提交修改（包括 staged、unstaged 和 untracked 内容）。"],
		["commit v18.0.11", '指定 commit "v18.0.11" 引入的修改。'],
		["path src/new feature", '指定路径 "src/new feature" 中的代码'],
	])("expands the explicit read-only functional review scope %s", async (args, scope) => {
		const prompt = await expandJchCommand("jchfuncreview", args);

		expect(prompt).toContain(`Review 范围：${scope}`);
		expect(prompt).toContain("主代理和子代理都 MUST 保持只读");
		expect(prompt).toContain("不修改代码、文件或配置");
	});

	it.each([
		["uncommitted", "当前工作区的全部未提交修改（包括 staged、unstaged 和 untracked 内容）。"],
		["commit v18.0.11", '指定 commit "v18.0.11" 引入的修改。'],
		["path packages/coding-agent", '指定路径 "packages/coding-agent" 中的代码'],
	])("expands the explicit verification scope %s", async (args, scope) => {
		const prompt = await expandJchCommand("jchverify", args);

		expect(prompt).toContain(scope);
		expect(prompt).toContain("不修复问题");
		expect(prompt).toContain("所有项目强制检查");
		expect(prompt).toContain("需要隔离执行时使用临时工作树");
	});

	it.each([
		[
			"jchfuncreviewfix",
			"commit a b",
			"用法：/jchfuncreviewfix uncommitted | /jchfuncreviewfix commit <ref> | /jchfuncreviewfix repo",
		],
		[
			"jchfuncreview",
			"repo",
			"用法：/jchfuncreview uncommitted | /jchfuncreview commit <ref> | /jchfuncreview path <path>",
		],
		["jchverify", "", "用法：/jchverify uncommitted | /jchverify commit <ref> | /jchverify path <path>"],
	])("rejects invalid scope arguments for /%s", async (name, args, expectedUsage) => {
		const command = lookupBuiltinSlashCommand(name);
		if (!command?.handle) throw new Error(`Expected /${name} to be registered`);
		const output: string[] = [];
		const result = await command.handle(
			{ name: command.name, args, text: `/${command.name}${args ? ` ${args}` : ""}` },
			{
				output: text => {
					output.push(text);
				},
			} as SlashCommandRuntime,
		);

		expect(result).toEqual({ consumed: true });
		expect(output).toEqual([expectedUsage]);
	});

	it("targets manual CI dispatch at the pushed upstream branch", async () => {
		const command = lookupBuiltinSlashCommand("jchcifix");
		expect(command).toMatchObject({
			description: "JCH：修复、提交并推送当前分支 CI，最多验证三轮",
			inlineHint: "[workflow=<name> 或关注点]",
		});

		const prompt = await expandJchCommand("jchcifix", "workflow=CI");
		expect(prompt).toContain("MUST 使用 --ref 指向已推送的 upstream branch");
		expect(prompt).toContain("捕获命令返回的 run URL/ID");
		expect(prompt).toContain("push/workflow_dispatch 的 head SHA 等于 pushed HEAD");
		expect(prompt).toContain("workflow=CI");
	});

	it("keeps CI inspection read-only", async () => {
		const prompt = await expandJchCommand("jchci", "CI");

		expect(prompt).toContain("不 rerun、dispatch、cancel、commit 或 push");
		expect(prompt).toContain("pull_request 允许 merge SHA但必须解析 PR head SHA");
		expect(prompt).toContain("CI");
	});

	it("keeps deep catchup behind an explicit full subcommand", async () => {
		expect(lookupBuiltinSlashCommand("jchcatchup")).toMatchObject({
			description: "JCH：快速摘要工作现场；full 深度恢复",
			subcommands: [{ name: "full", description: "通过代理深度恢复工作现场", usage: "[路径、提交范围或关注点]" }],
		});
		const prompt = await expandJchCommand("jchcatchup", "full");

		expect(prompt).toContain("读取与当前工作相关的 untracked 文本源文件");
		expect(prompt).toContain("默认不超过 20 个");
		expect(prompt).not.toContain("约 10–20 个");
	});

	it("removes superseded command names from the clean cutover", () => {
		for (const name of ["jchfastreviewfix", "jchfixactions", "jchgitforcesync"]) {
			expect(lookupBuiltinSlashCommand(name)).toBeUndefined();
			expect(BUILTIN_SLASH_COMMAND_RESERVED_NAMES.has(name)).toBe(false);
			expect(ACP_BUILTIN_SLASH_COMMANDS.some(candidate => candidate.name === name)).toBe(false);
		}
	});
});

describe("JCH git slash commands", () => {
	it("registers direct git handlers without prompt arguments", () => {
		expect(lookupBuiltinSlashCommand("jchgs")).toMatchObject({
			description: "JCH Git：刷新远端引用并显示简短分支状态",
			handle: expect.any(Function),
		});
		expect(lookupBuiltinSlashCommand("jchgitpull")).toMatchObject({
			description: "JCH Git：直接拉取当前分支",
			handle: expect.any(Function),
		});
	});

	it("keeps destructive discard-all interactive-only", () => {
		const command = JCH_GIT_SLASH_COMMANDS.find(candidate => candidate.name === "jchgitdiscardall");
		expect(command).toMatchObject({
			description: "JCH Git：无确认重置到跟踪分支并清理未跟踪内容（默认保留 ignored）",
			allowArgs: true,
			inlineHint: "[--ignored=true|false]",
			handleTui: expect.any(Function),
		});
		expect(command?.handle).toBeUndefined();
		expect(ACP_BUILTIN_SLASH_COMMANDS.some(candidate => candidate.name === "jchgitdiscardall")).toBe(false);
	});
});
