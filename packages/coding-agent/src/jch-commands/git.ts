import type { SlashCommandSpec } from "../slash-commands/types";
import { defineJchPromptCommand } from "./define";

export const JCH_GIT_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
	defineJchPromptCommand({
		name: "jchgs",
		description: "JCH Git：查看仓库与当前目录状态",
		inlineHint: "[关注点，如 remote、log]",
		prompt: `查看当前目录对应 Git 仓库的状态。不修改工作区和分支，但允许并要求先运行 git fetch --all 更新远端引用；不 pull、reset、clean、stash、commit、push 或切换分支。先检查当前分支、upstream 和 remote 配置，再运行 git status 获取 conflicts、staged、unstaged、untracked，并据此确认相对 upstream 的 ahead/behind、未推送提交和远端新增提交。据此描述当前目录的 Git 状态：当前分支、upstream、未提交改动、未推送提交、远端新增提交、远端配置；指出异常（如丢失 upstream、未推送提交、未提交修改）和最小安全的下一步。参数存在时用于缩小关注范围。`,
	}),
	defineJchPromptCommand({
		name: "jchgitpull",
		description: "JCH Git：拉取当前分支",
		inlineHint: "[remote/branch 或其他要求]",
		prompt: `更新当前 Git 分支。固定执行流程：先运行 git fetch --all，再对当前分支执行普通 git pull；使用仓库/Git 已有的 pull 配置，不自行决定 merge 或 rebase 策略。不 reset、clean、stash 或丢弃任何本地修改；pull 失败时直接报告错误和阻塞原因。完成后验证分支、upstream 和工作区状态。参数只作为补充要求，不得改变“当前分支 fetch all + pull”的核心语义。`,
	}),
	defineJchPromptCommand({
		name: "jchgitforcesync",
		description: "JCH Git：强制同步到 upstream 并丢弃全部本地改动",
		inlineHint: "[可选补充要求]",
		tuiOnly: true,
		prompt: `把当前 Git 分支完全同步为其远端 upstream 的当前状态，本地内容全部丢弃。本命令本身即授权删除：staged 修改、unstaged tracked 修改、untracked 文件和目录、ignored 文件和目录，以及当前分支所有未推送/local-only commits。先确认当前分支和 upstream 均明确存在；没有明确 upstream 时停止，不猜测远端。先运行 git fetch --all，再将当前分支 hard reset 到最新 upstream tip，并彻底 clean（包含 untracked 与 ignored 内容）。不删除其他本地分支，不修改远端，不 force-push。最后验证 HEAD 与 upstream 完全一致且工作区干净。`,
	}),
];
