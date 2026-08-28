import type { SlashCommandSpec } from "../slash-commands/types";
import { defineJchPromptCommand } from "./define";

export const JCH_GIT_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
	defineJchPromptCommand({
		name: "jchgs",
		description: "JCH Git：查看仓库与当前目录状态",
		inlineHint: "[关注点，如 remote、log]",
		prompt: `查看当前目录对应 Git 仓库的状态。严格只读：不修改文件，不 stage、commit、stash、pull、push 或切换分支。运行 git status（包含分支与 upstream 信息、conflicts、staged、unstaged、untracked）和 git remote -v，按需补充 ahead/behind 与最近提交，据此描述当前目录的 Git 状态：当前分支、upstream、未提交改动、未推送提交、远端配置；指出异常（如丢失 upstream、未推送提交、未提交修改）和最小安全的下一步。参数存在时用于缩小关注范围。`,
	}),
	defineJchPromptCommand({
		name: "jchgitpull",
		description: "JCH Git：安全拉取当前分支",
		inlineHint: "[remote/branch 或其他要求]",
		prompt: `安全更新当前 Git 分支。先检查当前分支、upstream 和工作区状态，再按仓库现有配置从对应远端拉取。保留本地工作，不 reset、clean、丢弃修改或擅自 stash；如果本地修改使拉取不安全，说明阻塞和最小安全处理方式。完成后验证分支和工作区状态。`,
	}),
	defineJchPromptCommand({
		name: "jchgitpush",
		description: "JCH Git：安全推送当前分支",
		inlineHint: "[remote/branch 或明确的 force 要求]",
		prompt: `安全推送当前 Git 分支。先检查当前分支、upstream、工作区以及相对远端的 ahead/behind，目标不明确或远端包含未整合提交时停止并说明。默认执行普通 push，不推送无关分支或 tags，不 force-push；只有参数明确要求改写远端历史时才允许使用 --force-with-lease，并在执行前核对远端 tip 未发生意外变化。完成后验证 upstream 和 ahead/behind。`,
	}),
	defineJchPromptCommand({
		name: "jchgitforcesync",
		description: "JCH Git：强制同步到远端并丢弃本地改动",
		inlineHint: "[remote/branch；可明确要求 ignored]",
		prompt: `把当前 Git 分支强制同步到对应远端最新状态。这个 slash 命令本身表示用户已明确授权丢弃当前分支的 tracked 本地修改和 untracked 文件。先确认当前分支、目标 upstream、工作区以及将被删除的内容；目标明确时 fetch 最新远端状态，重置当前分支到对应远端 tip，并清理 untracked 文件。默认绝不删除 ignored 文件，不删除其他分支，不 force-push；只有参数明确要求时才扩大到 ignored。若当前分支没有明确 upstream 或目标远端，则停止而不是猜测。最后验证 HEAD 与远端一致且工作区干净。`,
	}),
	defineJchPromptCommand({
		name: "jchgitcommit",
		description: "JCH Git：检查改动并创建合适的 commit",
		inlineHint: "[commit message 或提交范围]",
		prompt: `创建 Git commit。先检查当前改动和仓库提交约定，只包含本次目标相关文件，避免把无关修改混入；参数给出 commit message 时优先采用其意图。必要时拆分明显无关的修改，而不是做一个混杂提交。不要 push。完成后报告 commit SHA、message 和剩余工作区状态。`,
	}),
];
