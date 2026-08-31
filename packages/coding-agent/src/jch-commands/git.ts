import type { SlashCommandSpec } from "../slash-commands/types";
import { defineJchPromptCommand } from "./define";

export const JCH_GIT_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
	defineJchPromptCommand({
		name: "jchgs",
		description: "JCH Git：刷新远端引用并查看当前 Git 状态",
		inlineHint: "[关注点，如 remote、log]",
		prompt: `查看当前目录对应 Git 仓库的状态。不修改工作区和分支，但 MUST 先运行 git fetch --all 更新远端引用；不 pull、reset、clean、stash、commit、push 或切换分支。检查当前分支、upstream、remote、conflicts、staged、unstaged、untracked，以及相对 upstream 的 ahead/behind、未推送提交和远端新增提交。报告当前状态、异常和最小安全下一步；参数只缩小关注范围。`,
	}),
	defineJchPromptCommand({
		name: "jchgitpull",
		description: "JCH Git：按既有策略拉取当前分支",
		inlineHint: "[关注点或补充要求]",
		prompt: `更新当前 Git 分支。固定流程：先运行 git fetch --all，再对当前分支执行普通 git pull；使用仓库/Git 已有 pull 配置，NEVER 自行选择 merge 或 rebase 策略。不 reset、clean、stash 或丢弃本地修改；pull 失败时直接报告错误和阻塞原因。完成后验证分支、upstream 和工作区状态。参数只作补充，不得改变“当前分支 fetch all + pull”的核心语义。`,
	}),
	defineJchPromptCommand({
		name: "jchgitdiscardall",
		description: "JCH Git：丢弃全部本地状态并重置到 upstream",
		inlineHint: "[可选补充要求]",
		tuiOnly: true,
		prompt: `把当前 Git 分支完全重置为远端 upstream 的当前状态并丢弃全部本地内容。本命令本身即授权删除 staged、unstaged tracked、untracked、ignored 内容及当前分支全部 local-only commits。先确认当前分支和 upstream 均明确存在；运行 git fetch --all 后重新确认 upstream remote branch 仍存在，已删除或不明确时停止，NEVER 使用陈旧 remote-tracking ref 猜测。随后 hard reset 到最新 upstream tip，并彻底 clean untracked 与 ignored 内容。不删除其他本地分支，不修改远端，不 force-push。最后验证 HEAD 与 upstream 完全一致、工作区干净且无残留 untracked/ignored 内容。`,
	}),
];
