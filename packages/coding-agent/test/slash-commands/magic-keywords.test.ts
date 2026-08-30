import { describe, expect, it } from "bun:test";
import { JCH_GIT_SLASH_COMMANDS } from "@oh-my-pi/pi-coding-agent/jch-commands/git";
import { JCH_WORKFLOW_SLASH_COMMANDS } from "@oh-my-pi/pi-coding-agent/jch-commands/workflow";
import { ACP_BUILTIN_SLASH_COMMANDS } from "@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins";
import { BUILTIN_MAGIC_KEYWORD_SLASH_COMMANDS } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-magic-keywords";
import {
	BUILTIN_SLASH_COMMAND_RESERVED_NAMES,
	lookupBuiltinSlashCommand,
} from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import type { SlashCommandRuntime, TuiSlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";

const MAGIC_KEYWORDS = ["ultrathink", "orchestrate", "workflowz", "fullsend"];

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
	it("keeps workflow and branch arguments as joint failed-run constraints", async () => {
		const command = JCH_WORKFLOW_SLASH_COMMANDS.find(candidate => candidate.name === "jchfixactions");
		if (!command?.handle) throw new Error("Expected /jchfixactions to be registered");
		const args = "workflow=CI branch=release";
		const result = await command.handle(
			{ name: command.name, args, text: `${command.name} ${args}` },
			{} as SlashCommandRuntime,
		);
		if (!result || !("prompt" in result)) throw new Error("Expected /jchfixactions to expand to a prompt");
		expect(result.prompt).toContain("参数指定 workflow 或 branch 时，仅在同时满足这些条件的范围内选择目标失败 run");
		expect(result.prompt).toContain(args);
	});
	it("registers /jchfastreviewfix with explicit scope completions", () => {
		const command = lookupBuiltinSlashCommand("jchfastreviewfix");

		expect(command).toMatchObject({
			name: "jchfastreviewfix",
			description: "JCH：快速 Review 并自动修复",
			allowArgs: true,
			inlineHint: "<uncommitted|commit <ref>|repo>",
			subcommands: [
				{ name: "uncommitted", description: "Review 当前未提交修改" },
				{ name: "commit", description: "Review 指定 commit", usage: "<ref>" },
				{ name: "repo", description: "Review 整个代码仓库" },
			],
		});
		expect(command?.handle).toBeDefined();
		expect(BUILTIN_SLASH_COMMAND_RESERVED_NAMES.has("jchfastreviewfix")).toBe(true);
	});

	it.each([
		["uncommitted", "当前工作区的全部未提交修改（包括 staged、unstaged 和 untracked 内容）。"],
		["commit v18.0.11", '指定 commit "v18.0.11" 引入的修改。'],
		["repo", "当前整个代码仓库（以工作区现状为准，包括未提交内容）。"],
	])("expands the explicit %s review scope", async (args, scope) => {
		const command = lookupBuiltinSlashCommand("jchfastreviewfix");
		if (!command?.handle) throw new Error("Expected /jchfastreviewfix to be registered");

		const result = await command.handle(
			{ name: command.name, args, text: `/${command.name} ${args}` },
			{} as SlashCommandRuntime,
		);
		if (!result || !("prompt" in result)) throw new Error("Expected /jchfastreviewfix to expand to a prompt");

		expect(result.prompt).toContain(`\`${scope}\``);
		expect(result.prompt).not.toContain("{{REVIEW_SCOPE}}");
		expect(result.prompt).not.toContain("用户在 slash 命令后提供的参数/补充条件如下。");
		expect(result.prompt).toContain("必须把 Review 工作分配给独立 Review 子代理");
		expect(result.prompt).toContain("* 只读，不修改代码；");
		expect(result.prompt).toContain("MUST 将下列每一项逐项写入共享 context 或每个 task");
		expect(result.prompt).toContain("NEVER 概括、合并、省略或假定子代理已经知道");
		expect(result.prompt).toContain("MUST 完全排除安全、隐私、合规");
		expect(result.prompt).toContain("每个问题 MUST 给出文件和位置");
		expect(result.prompt).toContain("MUST 只返回“没有问题”");
		expect(result.prompt).toContain("发起 task 前，主代理 MUST 检查");
		expect(result.prompt).toContain("只有真实用户正常使用项目时可能遇到");
		expect(result.prompt).toContain("完全不要进行安全 Review。");
		expect(result.prompt).toContain("主代理收到每个问题后必须独立复核");
		expect(result.prompt).toContain("对确认的问题直接进行最小充分修复。");
		expect(result.prompt).toContain("**必须设置最多 10 秒的硬超时。**");
		expect(result.prompt).toContain("### 已修复");
		expect(result.prompt).toContain("### 子代理认为应该修，但主代理判定不需要修改");
		expect(result.prompt).toContain("### 总结");
	});

	it.each(["", "unknown", "commit", "commit a b", "uncommitted extra", "repo extra"])(
		"rejects invalid scope arguments %p with fixed usage",
		async args => {
			const command = lookupBuiltinSlashCommand("jchfastreviewfix");
			if (!command?.handle) throw new Error("Expected /jchfastreviewfix to be registered");
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
			expect(output).toEqual([
				"用法：/jchfastreviewfix uncommitted | /jchfastreviewfix commit <ref> | /jchfastreviewfix repo",
			]);
			expect(result).not.toHaveProperty("prompt");
		},
	);
});

describe("JCH git slash commands", () => {
	it("keeps destructive force sync interactive-only", async () => {
		const command = JCH_GIT_SLASH_COMMANDS.find(candidate => candidate.name === "jchgitforcesync");
		if (!command?.handleTui) throw new Error("Expected /jchgitforcesync to be registered for the TUI");

		expect(command.handle).toBeUndefined();
		expect(ACP_BUILTIN_SLASH_COMMANDS.some(candidate => candidate.name === "jchgitforcesync")).toBe(false);

		const args = "执行前报告目标 upstream";
		const result = await command.handleTui(
			{ name: command.name, args, text: `/${command.name} ${args}` },
			{} as TuiSlashCommandRuntime,
		);
		if (!result || !("prompt" in result)) throw new Error("Expected /jchgitforcesync to expand to a prompt");
		expect(result.prompt).toContain("本命令本身即授权删除");
		expect(result.prompt).toContain("不得改变命令的核心动作或读写性质");
		expect(result.prompt).toContain(args);
	});
});
